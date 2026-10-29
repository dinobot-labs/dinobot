import { clockMinutes, localDate, localParts, localToUtc, addDays, MINUTE } from "./time.ts";

/**
 * Reminder planning (ADR 0106): a pure function of the event, the clock and the user's zone. It decides how far ahead
 * the user hears about an event (days for a presentation or deadline, minutes for a meeting) and whether the agent
 * prepares material (`prepare`) or only gives a heads-up (`notify`). The engine only fires what this planned.
 */

export const CATEGORIES = ["meeting", "presentation", "deadline", "task", "travel", "personal", "other"] as const;
export type Category = (typeof CATEGORIES)[number];
export const IMPORTANCES = ["low", "normal", "high"] as const;
export type Importance = (typeof IMPORTANCES)[number];
export const ACTIONS = ["notify", "prepare"] as const;
export type Action = (typeof ACTIONS)[number];

export type ExplicitReminder = { readonly minutes: number; readonly action: Action; readonly note?: string };

/** What the planner reads of an event. */
export type PlannableEvent = {
	readonly startMs: number;
	readonly allDay: boolean;
	/** Zone the event's dates are written in (all-day reminders fire at 09:00 there). */
	readonly timeZone: string;
	readonly category: Category;
	readonly importance: Importance;
	readonly preparation?: string;
	/** An explicit list replaces the automatic plan; `[]` means no reminders. Undefined: automatic. */
	readonly reminders?: readonly ExplicitReminder[];
};

/**
 * One planned reminder. `key` names it across replans: `${startMs}:${minutes}:${action}`, or
 * `${startMs}:catchup:${action}` for a catch-up, so replanning an unchanged event yields the same keys.
 */
export type Reminder = { readonly key: string; readonly fireAt: number; readonly minutes: number; readonly action: Action; readonly note?: string };

export type QuietHours = { readonly start: string; readonly end: string };

export type PlanOptions = {
	/** The user's zone; quiet hours are read in it. */
	readonly timeZone: string;
	readonly quietHours: QuietHours | false;
	/** Reminders of this event that already fired; a fired prepare counts as done preparation for the catch-up rule. */
	readonly fired?: readonly { readonly key: string; readonly action: Action }[];
};

export const MAX_REMINDERS = 8;
/** Reminders at least this far ahead respect quiet hours; nearer ones are urgent and fire at their time. */
const QUIET_MIN_MINUTES = 180;
const PAST_GRACE_MS = 60_000;
const MERGE_MS = 60_000;

type Draft = { minutes: number; action: Action; note?: string };

const n = (minutes: number): Draft => ({ minutes, action: "notify" });
const p = (minutes: number): Draft => ({ minutes, action: "prepare" });

/** The automatic plan, in minutes before the start. */
export function defaultPlan(event: Pick<PlannableEvent, "category" | "importance" | "preparation">): Draft[] {
	const high = event.importance === "high";
	const prepared = event.preparation !== undefined && event.preparation.trim() !== "";
	const plan: Draft[] = [];
	switch (event.category) {
		case "meeting":
			plan.push(n(10));
			if (prepared || high) plan.push(p(60));
			if (high) plan.push(p(1440));
			break;
		case "presentation":
			plan.push(p(2880), p(1440), n(60), n(15));
			if (high) plan.push(p(10080));
			break;
		case "deadline":
			if (event.importance === "low") plan.push(n(1440));
			else if (high) plan.push(p(10080), p(4320), p(1440), n(120));
			else plan.push(p(4320), p(1440), n(120));
			break;
		case "task":
			plan.push(n(0));
			if (prepared) plan.push(p(1440));
			break;
		case "travel":
			plan.push(p(1440), n(180));
			break;
		case "personal":
		case "other":
			plan.push(n(30));
			if (prepared) plan.push(p(1440));
			break;
	}
	if (prepared && !plan.some((draft) => draft.action === "prepare")) plan.push(p(1440));
	return plan;
}

const stronger = (a: Action, b: Action): Action => (a === "prepare" || b === "prepare" ? "prepare" : "notify");

function joinNotes(a?: string, b?: string): string | undefined {
	if (!a) return b;
	if (!b || a === b) return a;
	return `${a}; ${b}`.slice(0, 500);
}

function withNote<T extends object>(value: T, note: string | undefined): T & { note?: string } {
	return note !== undefined && note !== "" ? { ...value, note } : value;
}

/** Move a non-urgent reminder out of the quiet window (see ADR 0106). */
function quietShift(fireAt: number, baseMs: number, quiet: QuietHours, timeZone: string): number {
	const start = clockMinutes(quiet.start);
	const end = clockMinutes(quiet.end);
	if (start === end) return fireAt;
	const local = localParts(fireAt, timeZone);
	const minute = local.hour * 60 + local.minute;
	const wraps = start > end;
	const inside = wraps ? minute >= start || minute < end : minute >= start && minute < end;
	if (!inside) return fireAt;
	const today = localDate(fireAt, timeZone);
	const endDate = wraps && minute >= start ? addDays(today, 1) : today;
	const quietEnd = localToUtc(timeZone, endDate, Math.floor(end / 60), end % 60);
	if (quietEnd <= baseMs - 60 * MINUTE) return quietEnd;
	const startDate = wraps && minute < end ? addDays(today, -1) : today;
	return localToUtc(timeZone, startDate, Math.floor(start / 60), start % 60) - 30 * MINUTE;
}

/** The instant reminders count back from: the start, or 09:00 local on the first day of an all-day event. */
export function baseTime(event: Pick<PlannableEvent, "startMs" | "allDay" | "timeZone">): number {
	return event.allDay ? localToUtc(event.timeZone, localDate(event.startMs, event.timeZone), 9, 0) : event.startMs;
}

export function planReminders(event: PlannableEvent, nowMs: number, options: PlanOptions): Reminder[] {
	const explicit = event.reminders !== undefined;
	let drafts: Draft[] = explicit ? (event.reminders ?? []).map((r) => withNote({ minutes: r.minutes, action: r.action }, r.note)) : defaultPlan(event);
	const baseMs = baseTime(event);

	if (event.allDay) {
		// Sub-day offsets of an all-day event collapse into one reminder at the base time with the strongest action.
		const subDay = drafts.filter((draft) => draft.minutes < 1440);
		if (subDay.length > 0) {
			const action = subDay.reduce<Action>((acc, draft) => stronger(acc, draft.action), "notify");
			const note = subDay.reduce<string | undefined>((acc, draft) => joinNotes(acc, draft.note), undefined);
			drafts = [...drafts.filter((draft) => draft.minutes >= 1440), withNote({ minutes: 0, action }, note)];
		}
	}

	let planned: Reminder[] = drafts.map((draft) => {
		let fireAt = baseMs - draft.minutes * MINUTE;
		if (options.quietHours !== false && draft.minutes >= QUIET_MIN_MINUTES) fireAt = quietShift(fireAt, baseMs, options.quietHours, options.timeZone);
		return withNote({ key: `${event.startMs}:${draft.minutes}:${draft.action}`, fireAt, minutes: draft.minutes, action: draft.action }, draft.note);
	});

	const droppedPrepare = planned.some((r) => r.action === "prepare" && r.fireAt < nowMs - PAST_GRACE_MS);
	planned = planned.filter((r) => r.fireAt >= nowMs - PAST_GRACE_MS);
	const prefix = `${event.startMs}:`;
	const firedHere = (options.fired ?? []).filter((r) => r.key.startsWith(prefix));
	const untilStart = baseMs - nowMs;
	const hasPrepare = planned.some((r) => r.action === "prepare") || firedHere.some((r) => r.action === "prepare");
	if (droppedPrepare && !hasPrepare && untilStart >= 15 * MINUTE) {
		planned.push({ key: `${prefix}catchup:prepare`, fireAt: nowMs, minutes: Math.floor(untilStart / MINUTE), action: "prepare" });
	}
	if (planned.length === 0 && firedHere.length === 0 && drafts.length > 0 && untilStart >= 2 * MINUTE) {
		planned.push({ key: `${prefix}catchup:notify`, fireAt: nowMs, minutes: Math.floor(untilStart / MINUTE), action: "notify" });
	}

	// Merge reminders within a minute of each other, keeping prepare (and its key).
	planned.sort((a, b) => a.fireAt - b.fireAt || (a.action === b.action ? b.minutes - a.minutes : a.action === "prepare" ? -1 : 1));
	const merged: Reminder[] = [];
	for (const reminder of planned) {
		const last = merged.at(-1);
		if (last !== undefined && reminder.fireAt - last.fireAt <= MERGE_MS) {
			const keep = last.action === "notify" && reminder.action === "prepare" ? reminder : last;
			merged[merged.length - 1] = withNote({ key: keep.key, fireAt: last.fireAt, minutes: keep.minutes, action: keep.action }, joinNotes(last.note, reminder.note));
			continue;
		}
		merged.push(reminder);
	}
	return merged.slice(-MAX_REMINDERS);
}
