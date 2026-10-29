import type { Reminder } from "./planner.ts";
import type { CalendarEvent } from "./store.ts";
import { DAY, duration, formatDate, formatLocal, localDate, MINUTE, relative } from "./time.ts";

/** The host caps a wake at 16 KiB; the event part is trimmed first so the task always survives. */
export const WAKE_MAX_BYTES = 16_000;

const bytes = (text: string) => Buffer.byteLength(text, "utf8");

function trimBytes(text: string, max: number): string {
	if (bytes(text) <= max) return text;
	const marker = "\n…(truncated)";
	let out = text.slice(0, Math.max(0, max - bytes(marker)));
	while (out.length > 0 && bytes(out) + bytes(marker) > max) out = out.slice(0, -1);
	return out + marker;
}

/** `Thu 2026-05-07 14:00 (Asia/Seoul)` or `Thu 2026-05-07 (all day, Asia/Seoul)`. */
export function describeWhen(event: Pick<CalendarEvent, "startMs" | "allDay" | "timeZone">): string {
	if (event.allDay) return `${formatLocal(event.startMs, event.timeZone).slice(0, 14)} (all day, ${event.timeZone})`;
	return `${formatLocal(event.startMs, event.timeZone)} (${event.timeZone})`;
}

function describeEnd(event: CalendarEvent): string | undefined {
	if (event.endMs === undefined) return undefined;
	if (event.allDay) {
		const last = localDate(event.endMs - 1, event.timeZone);
		return event.endMs - event.startMs <= DAY + 2 * 60 * MINUTE ? undefined : `${formatDate(last)} (last day)`;
	}
	return formatLocal(event.endMs, event.timeZone);
}

const TASKS = {
	prepare: [
		"Your task: do the preparation now, on your own, so the user is ready for this event.",
		"- Work out what the event needs. Research it: web search, files in the workspace, and the earlier conversation in this thread.",
		"- Draft the material yourself (agenda, briefing, checklist, document draft) and save it as files in the workspace when useful.",
		"- Then post one concise message: the event and its time, what you prepared (with file paths), and what the user still has to do.",
		"- Mention the person who asked for this event (for example <@USERID> on Slack, taken from their earlier message in this thread).",
		"- Write in the language the user used for this event.",
	],
	notify: [
		"Your task: post a short heads-up (2-4 lines): what, when (relative), where, and the one thing to do now.",
		"- Mention the person who asked for this event (for example <@USERID> on Slack, taken from their earlier message in this thread).",
		"- Write in the language the user used for this event. Do not start long work.",
	],
} as const;

export type WakeInput = {
	readonly event: CalendarEvent;
	readonly reminder: Reminder;
	/** Other pending reminders of the event after this one. */
	readonly upcoming: readonly Reminder[];
	readonly nowMs: number;
};

export function renderWake({ event, reminder, upcoming, nowMs }: WakeInput): string {
	const lines = [
		`Calendar reminder (${reminder.action}) for event ${event.id}: ${JSON.stringify(event.title)}`,
		`When: ${describeWhen(event)}, ${relative(event.startMs, nowMs)}`,
	];
	const end = describeEnd(event);
	if (end !== undefined) lines.push(`End: ${end}`);
	if (event.location) lines.push(`Location: ${event.location}`);
	lines.push(`Category: ${event.category}, importance: ${event.importance}`);
	if (event.description) lines.push(`Description: ${event.description}`);
	if (event.preparation) lines.push(`Preparation: ${event.preparation}`);
	if (reminder.note) lines.push(`Reminder note: ${reminder.note}`);
	if (upcoming.length > 0) {
		lines.push(`Other upcoming reminders: ${upcoming.map((r) => `${r.action} at ${formatLocal(r.fireAt, event.timeZone)} (${duration(r.minutes)} before)`).join("; ")}`);
	}
	const task = TASKS[reminder.action].join("\n");
	const head = trimBytes(lines.join("\n"), WAKE_MAX_BYTES - bytes(task) - 2);
	return `${head}\n\n${task}`;
}
