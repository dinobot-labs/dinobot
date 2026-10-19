import { PROGRESS_FINISH_BUDGET_MS, type ProgressReporter } from "./messaging.ts";
import { foldProgress, initialProgress, type ProgressOutcome, renderProgress, withOutcome } from "./progress.ts";

/** Result of one Bot API call: `status` 0 is a network failure, timeout or abort. `local` marks a call the shared API
 * gate skipped before any request started (status 429 with the gate's retry hint): nothing reached the platform. */
export type TelegramResult =
	| { readonly ok: true; readonly result?: unknown; readonly local?: true }
	| { readonly ok: false; readonly status: number; readonly retryAfterMs?: number; readonly description?: string; readonly local?: true };
/** Abort requests cancellation; the execution still owns raw/body work until actual settlement. */
export type TelegramApi = (method: string, body: Record<string, unknown>, signal?: AbortSignal) => Promise<TelegramResult>;

export type TelegramProgressOptions = {
	readonly call: TelegramApi;
	readonly chat: string;
	/** "0" outside topics. */
	readonly topic: string;
	readonly now?: () => number;
	readonly sleep?: (ms: number) => Promise<void>;
	/** Minimum spacing Δ of status message writes while the turn runs; also sets the window cap K = ⌈60 s/Δ⌉. */
	readonly editIntervalMs?: number;
	/** Typing refresh; Telegram shows a chat action for about 5 s. */
	readonly typingIntervalMs?: number;
	/** A turn with no tool or todo yet gets a status message only after this long, so quick answers stay quiet. */
	readonly bubbleDelayMs?: number;
	/** Minimum gap before the final edit; at most editIntervalMs. */
	readonly finalGapMs?: number;
	/** Longest wait (gap, window or rate-limit backoff) the final edit accepts; editIntervalMs <= this < finishBudgetMs. */
	readonly finalWaitMs?: number;
	/** Wall-clock bound on `finish` (ProgressReporter contract). */
	readonly finishBudgetMs?: number;
	readonly maxBackoffMs?: number;
	/** Detailed card: argument lines, todo text, more recent lines (ADR 0057). */
	readonly detailed?: boolean;
};

export const EDIT_INTERVAL_MS = 3_000;
export const TYPING_INTERVAL_MS = 4_000;
export const BUBBLE_DELAY_MS = 8_000;

/**
 * One status message per turn, edited in place, plus the typing indicator (ADR 0047).
 *
 * - R1: status writes are serialized. While the turn runs they start at least Δ apart; the final edit starts at least
 *   the final gap after the previous write and only when fewer than K = ⌈60 s/Δ⌉ writes started in the 60 s before it.
 *   Hence any 60 s window holds at most K writes (20 for Δ = 3 s). Typing calls start ≥ 4 s apart (≤ 15 per minute).
 * - R2/R3: a write happens only when the view differs from the last view that took effect, and carries the full view,
 *   so a lost or failed edit is repaired by the next one.
 * - R5: 429 pauses every call until `retry_after`; a permanent 4xx disables that kind of write for the turn.
 * - R7: `finish` resolves within the finish budget. At the budget, or when `finish` resolves, every call still in
 *   flight is aborted and no call is issued afterwards.
 */
export function telegramProgress(options: TelegramProgressOptions): ProgressReporter {
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
	const editInterval = options.editIntervalMs ?? EDIT_INTERVAL_MS;
	const typingInterval = options.typingIntervalMs ?? TYPING_INTERVAL_MS;
	const bubbleDelay = options.bubbleDelayMs ?? BUBBLE_DELAY_MS;
	const finishBudget = options.finishBudgetMs ?? PROGRESS_FINISH_BUDGET_MS;
	const finalGap = options.finalGapMs ?? 1_000;
	const finalWait = options.finalWaitMs ?? editInterval;
	const windowCap = Math.ceil(60_000 / editInterval);
	const maxBackoff = options.maxBackoffMs ?? 60_000;
	// Without spacing room the final edit would be skipped after every recent write; without call room it could not finish.
	// finalGap <= Δ <= finalWait keeps the final edit's wait within finalWait (see settle); finalWait < budget leaves call time.
	if (!(finalGap <= editInterval && editInterval <= finalWait && finalWait < finishBudget))
		throw new RangeError("telegramProgress needs finalGapMs <= editIntervalMs <= finalWaitMs < finishBudgetMs");
	const thread = options.topic !== "0" ? { message_thread_id: Number(options.topic) } : {};
	const chat = options.chat;

	let state = initialProgress(now(), { detailed: options.detailed === true });
	let busy: Promise<void> | undefined;
	let finished: Promise<void> | undefined;
	/** Set by `finish`: no new step starts. */
	let closed = false;
	/** Set at the budget or when `finish` resolves: no call is issued, and the seal aborts every call in flight. */
	let sealed = false;
	const seal = new AbortController();
	let bubble: number | undefined;
	let bubbleDisabled = false;
	let typingDisabled = false;
	/** Start times of the last K status writes, ascending; the only record of write timing. */
	const writes: number[] = [];
	const lastWrite = () => writes.at(-1) ?? Number.NEGATIVE_INFINITY;
	let lastTyping = Number.NEGATIVE_INFINITY;
	let lastSent: string | undefined;
	/** A send that failed may still have been delivered (timeout), so a retry could duplicate the message: retry once. */
	let sendAttempts = 0;
	const MAX_SEND_ATTEMPTS = 2;
	let backoffUntil = Number.NEGATIVE_INFINITY;

	/** The only place a platform call is issued. */
	const call = (method: string, body: Record<string, unknown>): Promise<TelegramResult> =>
		sealed ? Promise.resolve({ ok: false, status: 0 }) : options.call(method, body, seal.signal);

	/** True when the call took effect. */
	const accept = (result: TelegramResult, kind: "typing" | "send" | "edit"): boolean => {
		if (result.ok) return true;
		if (result.status === 429) {
			// A local gate skip carries the gate's own hint; a server 429 keeps the 1 s floor and the backoff cap.
			const wait = result.local ? Math.max(1, result.retryAfterMs ?? 1_000) : Math.max(1_000, result.retryAfterMs ?? 1_000);
			backoffUntil = now() + Math.min(maxBackoff, wait);
			return false;
		}
		if (kind === "edit" && result.status === 400 && /not modified/i.test(result.description ?? "")) return true;
		if (result.status === 0 || result.status >= 500) return false;
		if (kind === "typing") typingDisabled = true;
		else bubbleDisabled = true;
		return false;
	};

	const write = async (text: string, kind: "send" | "edit") => {
		if (sealed) return;
		writes.push(now());
		if (writes.length > windowCap) writes.shift();
		const result =
			kind === "send"
				? await call("sendMessage", { chat_id: chat, text, disable_notification: true, ...thread })
				: await call("editMessageText", { chat_id: chat, message_id: bubble, text });
		// A send the gate skipped was never issued, so it cannot have been delivered: it does not use up a send attempt.
		// The recorded write time stays (conservative for R1).
		if (!result.ok && result.local && kind === "send") sendAttempts--;
		if (!accept(result, kind)) return;
		if (kind === "send") {
			const id = (result as { result?: { message_id?: unknown } }).result?.message_id;
			if (typeof id !== "number" || !Number.isSafeInteger(id)) {
				bubbleDisabled = true;
				return;
			}
			bubble = id;
		}
		lastSent = text;
	};

	const step = async () => {
		const t = now();
		if (t < backoffUntil) return;
		if (!typingDisabled && t - lastTyping >= typingInterval) {
			lastTyping = t;
			accept(await call("sendChatAction", { chat_id: chat, action: "typing", ...thread }), "typing");
			if (closed || now() < backoffUntil) return;
		}
		if (bubbleDisabled || now() - lastWrite() < editInterval) return;
		const view = renderProgress(state, now());
		if (bubble === undefined) {
			if (state.tools === 0 && state.todos === undefined && now() - state.startedAt < bubbleDelay) return;
			if (sendAttempts >= MAX_SEND_ATTEMPTS) {
				bubbleDisabled = true;
				return;
			}
			sendAttempts++;
			await write(view, "send");
		} else if (view !== lastSent) await write(view, "edit");
	};

	/**
	 * The final edit: after any step in flight, never past the budget. due ≥ lastWrite + finalGap, and once K writes are
	 * recorded, due ≥ (K-th latest write) + 60 s, so at most K-1 writes precede it within 60 s. The wait never exceeds Δ
	 * absent backoff: the K-th latest write is ≥ (K-1)·Δ before the latest one and (K-1)·Δ ≥ 60 s − Δ.
	 */
	const settle = async (outcome: ProgressOutcome, deadline: number) => {
		await busy;
		state = withOutcome(state, outcome, now());
		if (bubble === undefined || bubbleDisabled) return;
		const view = renderProgress(state, now());
		if (view === lastSent) return;
		const window = writes.length >= windowCap ? writes[writes.length - windowCap]! + 60_000 : Number.NEGATIVE_INFINITY;
		const due = Math.max(lastWrite() + finalGap, window, backoffUntil);
		if (due - now() > finalWait) return;
		// Re-check after every sleep: a timer may fire early, and R1 must hold for the final edit too.
		for (let t = now(); t < due && !sealed; t = now()) await sleep(due - t);
		if (sealed || now() >= deadline) return;
		await write(view, "edit");
	};

	return {
		event(event) {
			if (!closed) state = foldProgress(state, event, now());
		},
		tick() {
			if (closed) return Promise.resolve();
			busy ??= step()
				.catch(() => undefined)
				.finally(() => {
					busy = undefined;
				});
			return busy;
		},
		finish(outcome: ProgressOutcome) {
			if (finished) return finished;
			closed = true;
			const deadline = now() + finishBudget;
			let guard: ReturnType<typeof setTimeout> | undefined;
			const sealNow = () => {
				sealed = true;
				seal.abort();
			};
			// Wall-clock guard: whatever the platform does, the seal falls at the budget and finish resolves.
			const expired = new Promise<void>((resolve) => {
				guard = setTimeout(() => {
					sealNow();
					resolve();
				}, finishBudget);
			});
			finished = Promise.race([settle(outcome, deadline).catch(() => undefined), expired]).finally(() => {
				clearTimeout(guard);
				sealNow();
			});
			return finished;
		},
	};
}
