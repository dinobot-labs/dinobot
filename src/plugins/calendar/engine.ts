import type { PluginRuntime } from "../types.ts";
import { renderWake } from "./render.ts";
import type { CalendarEvent, CalendarStore, StoredReminder } from "./store.ts";
import { MINUTE } from "./time.ts";

/**
 * The reminder loop (ADR 0106). No model call happens here: a tick fires what the planner stored. It runs once at start,
 * then at the next pending reminder or after `intervalMs`, whichever is first, and again after every tool write.
 *
 * Exactly-once delivery: the wake key `${eventId}:${reminderKey}` is the host's idempotency key, so a crash between the
 * wake and the `fired` update, or a second tick racing a restart, cannot start a second turn; the next tick sees
 * `duplicate` and records `fired`.
 */
export type EngineOptions = {
	readonly store: CalendarStore;
	readonly now: () => number;
	readonly intervalMs: number;
	/** Arm real timers (tests drive `tick` by hand). */
	readonly timers: boolean;
	readonly log?: (message: string) => void;
};

/** A minutes-0 reminder (task due, all-day day-of) may still fire this long after the start. */
const START_GRACE_MS = 15 * MINUTE;
const MIN_DELAY_MS = 1000;

export type TickReport = { readonly fired: string[]; readonly skipped: { key: string; reason: string }[]; readonly deferred: string[] };

export class CalendarEngine {
	readonly #options: EngineOptions;
	#runtime: PluginRuntime | undefined;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#inflight: Promise<TickReport> | undefined;
	#closed = false;
	/** Reminders the host could not take, by wake key: retried no sooner than this instant. */
	readonly #retryAt = new Map<string, number>();
	readonly #logged = new Set<string>();

	constructor(options: EngineOptions) {
		this.#options = options;
	}

	start(runtime: PluginRuntime): void {
		if (this.#closed) return;
		this.#runtime = runtime;
		void this.tick();
	}

	/** One pass over due reminders. Single-flight: a call during a tick returns that tick. */
	tick(): Promise<TickReport> {
		if (this.#inflight) return this.#inflight;
		const run = this.#run().catch((error: unknown) => {
			this.#log(`tick:${error instanceof Error ? error.message : String(error)}`, `calendar: tick failed: ${error instanceof Error ? error.message : String(error)}`);
			return { fired: [], skipped: [], deferred: [] } satisfies TickReport;
		}).finally(() => {
			this.#inflight = undefined;
			this.arm();
		});
		this.#inflight = run;
		return run;
	}

	/** Re-schedule the timer for the next due reminder (after a tick and after every tool write). */
	arm(): void {
		if (this.#timer !== undefined) clearTimeout(this.#timer);
		this.#timer = undefined;
		if (this.#closed || this.#runtime === undefined || this.#inflight !== undefined || !this.#options.timers) return;
		const now = this.#options.now();
		let next = now + this.#options.intervalMs;
		for (const row of this.#options.store.nextPending(this.#retryAt.size + 1)) {
			next = Math.min(next, Math.max(row.fireAt, this.#retryAt.get(`${row.eventId}:${row.key}`) ?? 0));
		}
		const delay = Math.min(this.#options.intervalMs, Math.max(MIN_DELAY_MS, next - now));
		const timer = setTimeout(() => void this.tick(), delay);
		timer.unref?.();
		this.#timer = timer;
	}

	async close(): Promise<void> {
		this.#closed = true;
		if (this.#timer !== undefined) clearTimeout(this.#timer);
		this.#timer = undefined;
		await this.#inflight?.catch(() => undefined);
	}

	#log(key: string, message: string): void {
		if (this.#logged.has(key)) return;
		this.#logged.add(key);
		(this.#options.log ?? ((text: string) => console.error(text)))(message);
	}

	async #run(): Promise<TickReport> {
		const report: TickReport = { fired: [], skipped: [], deferred: [] };
		const runtime = this.#runtime;
		if (this.#closed || runtime === undefined) return report;
		const { store } = this.#options;
		const now = this.#options.now();
		// Events with a due row. Each one is read again right before its wake: an earlier wake awaits host admission, and a
		// tool call meanwhile may cancel or move a later event, so a snapshot taken here could fire a reminder that is no
		// longer pending.
		const eventIds = [...new Set(store.due(now).map(({ event }) => event.id))];
		const skip = (event: CalendarEvent, reminder: StoredReminder, reason: string) => {
			if (store.markSkipped(event.id, reminder.key, reason)) report.skipped.push({ key: `${event.id}:${reminder.key}`, reason });
			this.#retryAt.delete(`${event.id}:${reminder.key}`);
		};
		for (const id of eventIds) {
			if (this.#closed) break;
			const event = store.get(id);
			if (event === undefined) continue;
			// Every due row of the event, retry-waiting ones included: an earlier reminder deferred by the host must never
			// fire after a later one of the same event.
			const due = store.reminders(id).filter((r) => r.state === "pending" && r.fireAt <= now);
			due.sort((a, b) => a.fireAt - b.fireAt || (a.action === b.action ? 0 : a.action === "prepare" ? 1 : -1));
			const latest = due.at(-1);
			if (latest === undefined) continue;
			const stale = staleReason(event, latest, now);
			if (stale !== undefined) {
				for (const reminder of due) skip(event, reminder, stale);
				continue;
			}
			for (const reminder of due.slice(0, -1)) skip(event, reminder, "superseded");
			const key = `${event.id}:${latest.key}`;
			const retry = this.#retryAt.get(key);
			if (retry !== undefined && retry > now) continue; // the latest is waiting for its retry: pass over this event
			if (event.origin === undefined) {
				skip(event, latest, "no-conversation");
				continue;
			}
			const upcoming = store.reminders(event.id).filter((r) => r.state === "pending" && r.fireAt > now);
			let result: string;
			try {
				result = await runtime.wake({ conversationId: event.origin, key, text: renderWake({ event, reminder: latest, upcoming, nowMs: now }) });
			} catch (error) {
				result = `error: ${error instanceof Error ? error.message : String(error)}`;
			}
			if (result === "admitted" || result === "duplicate") {
				if (store.markFired(event.id, latest.key, now)) report.fired.push(key);
				this.#retryAt.delete(key);
			} else if (result === "gone") {
				skip(event, latest, "gone");
			} else {
				// unavailable or a failure: stays pending, retried after one interval (logged once, no hot loop).
				this.#retryAt.set(key, now + this.#options.intervalMs);
				report.deferred.push(key);
				this.#log(key, `calendar: reminder ${key} not delivered yet (${result}); retrying later`);
			}
		}
		return report;
	}
}

/** Why a due reminder no longer helps, or undefined when it should still fire. */
export function staleReason(event: CalendarEvent, reminder: Pick<StoredReminder, "minutes">, nowMs: number): string | undefined {
	if (event.status !== "active") return "stale";
	if (event.allDay) {
		const end = event.endMs ?? event.startMs + 24 * 60 * MINUTE;
		return nowMs >= end - MINUTE ? "stale" : undefined;
	}
	if (nowMs < event.startMs) return undefined;
	if (reminder.minutes === 0 && nowMs < event.startMs + START_GRACE_MS) return undefined;
	return "stale";
}
