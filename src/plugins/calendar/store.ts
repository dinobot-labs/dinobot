import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Action, Category, ExplicitReminder, Importance, Reminder } from "./planner.ts";

/**
 * Durable calendar state (ADR 0106) in one SQLite file under the bot's data directory. Events keep their own fields;
 * reminders are rows keyed by (event, planner key) whose state only moves pending -> fired | skipped, so a reminder
 * that fired is never planned again. `source`/`external_id` hold where an event came from (`local` today; a synced
 * Google or Apple calendar later, see provider.ts).
 */

export type EventStatus = "active" | "cancelled";

export type CalendarEvent = {
	readonly id: string;
	readonly title: string;
	readonly startMs: number;
	/** Exclusive end instant; for an all-day event local midnight after the last day. */
	readonly endMs?: number;
	readonly allDay: boolean;
	readonly timeZone: string;
	readonly location?: string;
	readonly description?: string;
	readonly category: Category;
	readonly importance: Importance;
	readonly preparation?: string;
	readonly reminders?: readonly ExplicitReminder[];
	readonly key?: string;
	/** Conversation the event was registered in; reminders wake it. */
	readonly origin?: string;
	readonly status: EventStatus;
	readonly source: string;
	readonly externalId?: string;
	readonly createdAt: number;
	readonly updatedAt: number;
};

export type ReminderState = "pending" | "fired" | "skipped";

export type StoredReminder = Reminder & {
	readonly eventId: string;
	readonly state: ReminderState;
	readonly reason?: string;
	readonly firedAt?: number;
};

type EventRow = {
	id: string; title: string; start_ms: number; end_ms: number | null; all_day: number; time_zone: string; location: string | null;
	description: string | null; category: string; importance: string; preparation: string | null; reminders: string | null; key: string | null;
	origin: string | null; status: string; source: string; external_id: string | null; created_at: number; updated_at: number;
};

type ReminderRow = {
	event_id: string; key: string; fire_at: number; minutes: number; action: string; note: string | null; state: string; reason: string | null; fired_at: number | null;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
	id TEXT PRIMARY KEY, title TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER, all_day INTEGER NOT NULL,
	time_zone TEXT NOT NULL, location TEXT, description TEXT, category TEXT NOT NULL, importance TEXT NOT NULL,
	preparation TEXT, reminders TEXT, key TEXT, origin TEXT, status TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'local',
	external_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS events_start ON events(start_ms);
CREATE UNIQUE INDEX IF NOT EXISTS events_external ON events(source, external_id) WHERE external_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS reminders (
	event_id TEXT NOT NULL, key TEXT NOT NULL, fire_at INTEGER NOT NULL, minutes INTEGER NOT NULL, action TEXT NOT NULL,
	note TEXT, state TEXT NOT NULL, reason TEXT, fired_at INTEGER, PRIMARY KEY (event_id, key)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS reminders_due ON reminders(state, fire_at);
PRAGMA user_version=1;
`;

const opt = <K extends string, V>(key: K, value: V | null | undefined): { [P in K]?: V } =>
	(value === null || value === undefined ? {} : { [key]: value }) as { [P in K]?: V };

function toEvent(row: EventRow): CalendarEvent {
	return {
		id: row.id, title: row.title, startMs: row.start_ms, allDay: row.all_day === 1, timeZone: row.time_zone,
		category: row.category as Category, importance: row.importance as Importance, status: row.status as EventStatus, source: row.source,
		createdAt: row.created_at, updatedAt: row.updated_at,
		...opt("endMs", row.end_ms), ...opt("location", row.location), ...opt("description", row.description),
		...opt("preparation", row.preparation), ...opt("key", row.key), ...opt("origin", row.origin), ...opt("externalId", row.external_id),
		...(row.reminders !== null ? { reminders: JSON.parse(row.reminders) as ExplicitReminder[] } : {}),
	};
}

function toReminder(row: ReminderRow): StoredReminder {
	return {
		eventId: row.event_id, key: row.key, fireAt: row.fire_at, minutes: row.minutes, action: row.action as Action, state: row.state as ReminderState,
		...opt("note", row.note), ...opt("reason", row.reason), ...opt("firedAt", row.fired_at),
	};
}

export type ListQuery = { readonly fromMs: number; readonly toMs: number; readonly query?: string; readonly includeCancelled?: boolean; readonly limit: number };

export class CalendarStore {
	readonly #db: Database;

	constructor(readonly path: string) {
		mkdirSync(dirname(path), { recursive: true });
		this.#db = new Database(path, { create: true, strict: true });
		this.#db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
		this.#db.exec(SCHEMA);
	}

	get(id: string): CalendarEvent | undefined {
		const row = this.#db.query<EventRow, [string]>("SELECT * FROM events WHERE id = ?").get(id);
		return row ? toEvent(row) : undefined;
	}

	/** Events overlapping [fromMs, toMs], sorted by start; `truncated` when more than `limit` match. */
	list(query: ListQuery): { events: CalendarEvent[]; truncated: boolean } {
		const needle = query.query?.trim().toLowerCase() ?? "";
		const rows = this.#db.query<EventRow, [number, number, number, string, string, string, number]>(
			`SELECT * FROM events WHERE start_ms <= ? AND COALESCE(end_ms, start_ms) >= ? AND (? = 1 OR status = 'active')
			 AND (? = '' OR instr(lower(title), ?) > 0 OR instr(lower(COALESCE(description, '')), ?) > 0)
			 ORDER BY start_ms, id LIMIT ?`,
		).all(query.toMs, query.fromMs, query.includeCancelled ? 1 : 0, needle, needle, needle, query.limit + 1);
		return { events: rows.slice(0, query.limit).map(toEvent), truncated: rows.length > query.limit };
	}

	reminders(eventId: string): StoredReminder[] {
		return this.#db.query<ReminderRow, [string]>("SELECT * FROM reminders WHERE event_id = ? ORDER BY fire_at, key").all(eventId).map(toReminder);
	}

	/**
	 * Write the event and merge the new plan in one transaction: a planned key with no row is added; a pending row is
	 * moved to its new time; a row skipped because the event was cancelled comes back when the event is active again;
	 * fired and otherwise skipped rows stay as history (nothing fires twice); pending rows the plan dropped are removed.
	 */
	save(event: CalendarEvent, plan: readonly Reminder[]): void {
		const db = this.#db;
		db.transaction(() => {
			db.query(
				`INSERT INTO events (id, title, start_ms, end_ms, all_day, time_zone, location, description, category, importance, preparation,
				 reminders, key, origin, status, source, external_id, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET title = excluded.title, start_ms = excluded.start_ms, end_ms = excluded.end_ms,
				 all_day = excluded.all_day, time_zone = excluded.time_zone, location = excluded.location, description = excluded.description,
				 category = excluded.category, importance = excluded.importance, preparation = excluded.preparation, reminders = excluded.reminders,
				 key = excluded.key, origin = excluded.origin, status = excluded.status, source = excluded.source, external_id = excluded.external_id,
				 updated_at = excluded.updated_at`,
			).run(
				event.id, event.title, event.startMs, event.endMs ?? null, event.allDay ? 1 : 0, event.timeZone, event.location ?? null,
				event.description ?? null, event.category, event.importance, event.preparation ?? null,
				event.reminders !== undefined ? JSON.stringify(event.reminders) : null, event.key ?? null, event.origin ?? null, event.status,
				event.source, event.externalId ?? null, event.createdAt, event.updatedAt,
			);
			const existing = new Map(this.reminders(event.id).map((row) => [row.key, row]));
			const keys = new Set<string>();
			for (const reminder of plan) {
				keys.add(reminder.key);
				const row = existing.get(reminder.key);
				const revive = row?.state === "skipped" && row.reason === "cancelled" && event.status === "active";
				if (row === undefined) {
					db.query("INSERT INTO reminders (event_id, key, fire_at, minutes, action, note, state) VALUES (?, ?, ?, ?, ?, ?, 'pending')")
						.run(event.id, reminder.key, reminder.fireAt, reminder.minutes, reminder.action, reminder.note ?? null);
				} else if (row.state === "pending" || revive) {
					db.query("UPDATE reminders SET fire_at = ?, minutes = ?, action = ?, note = ?, state = 'pending', reason = NULL WHERE event_id = ? AND key = ?")
						.run(reminder.fireAt, reminder.minutes, reminder.action, reminder.note ?? null, event.id, reminder.key);
				}
			}
			for (const row of existing.values()) {
				if (row.state === "pending" && !keys.has(row.key)) db.query("DELETE FROM reminders WHERE event_id = ? AND key = ?").run(event.id, row.key);
			}
		})();
	}

	/** Cancel an event: pending reminders become skipped "cancelled". */
	cancel(id: string, at: number): void {
		const db = this.#db;
		db.transaction(() => {
			db.query("UPDATE events SET status = 'cancelled', updated_at = ? WHERE id = ?").run(at, id);
			db.query("UPDATE reminders SET state = 'skipped', reason = 'cancelled' WHERE event_id = ? AND state = 'pending'").run(id);
		})();
	}

	/** Pending reminders due at `nowMs`, with their events. */
	due(nowMs: number): { event: CalendarEvent; reminder: StoredReminder }[] {
		const rows = this.#db.query<ReminderRow, [number]>("SELECT * FROM reminders WHERE state = 'pending' AND fire_at <= ? ORDER BY event_id, fire_at, key").all(nowMs);
		const events = new Map<string, CalendarEvent | undefined>();
		const out: { event: CalendarEvent; reminder: StoredReminder }[] = [];
		for (const row of rows) {
			if (!events.has(row.event_id)) events.set(row.event_id, this.get(row.event_id));
			const event = events.get(row.event_id);
			if (event !== undefined) out.push({ event, reminder: toReminder(row) });
		}
		return out;
	}

	/** The earliest pending reminders by fire time. */
	nextPending(limit: number): { eventId: string; key: string; fireAt: number }[] {
		return this.#db.query<{ event_id: string; key: string; fire_at: number }, [number]>(
			"SELECT event_id, key, fire_at FROM reminders WHERE state = 'pending' ORDER BY fire_at LIMIT ?",
		).all(limit).map((row) => ({ eventId: row.event_id, key: row.key, fireAt: row.fire_at }));
	}

	/** pending -> fired; false when the row is no longer pending. */
	markFired(eventId: string, key: string, at: number): boolean {
		return this.#db.query("UPDATE reminders SET state = 'fired', fired_at = ? WHERE event_id = ? AND key = ? AND state = 'pending'").run(at, eventId, key).changes === 1;
	}

	/** pending -> skipped with a reason; false when the row is no longer pending. */
	markSkipped(eventId: string, key: string, reason: string): boolean {
		return this.#db.query("UPDATE reminders SET state = 'skipped', reason = ? WHERE event_id = ? AND key = ? AND state = 'pending'").run(reason, eventId, key).changes === 1;
	}

	close(): void {
		this.#db.close();
	}
}
