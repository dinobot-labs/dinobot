/**
 * IANA time-zone math with `Intl` only (ADR 0106). Every instant is epoch milliseconds; a "local" value is the wall
 * clock of one zone. Wall times that do not exist (a spring-forward gap) move forward; ambiguous ones (fall back) take
 * the earlier instant.
 */

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export type LocalDate = { readonly year: number; readonly month: number; readonly day: number };
export type LocalParts = LocalDate & { readonly hour: number; readonly minute: number; readonly second: number };

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
	let found = formatters.get(timeZone);
	if (found === undefined) {
		found = new Intl.DateTimeFormat("en-US", {
			timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
		});
		formatters.set(timeZone, found);
	}
	return found;
}

export function isValidTimeZone(timeZone: string): boolean {
	try {
		formatter(timeZone);
		return true;
	} catch {
		return false;
	}
}

/** The process's zone, or UTC when the runtime reports none. */
export function processTimeZone(): string {
	const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
	return zone && isValidTimeZone(zone) ? zone : "UTC";
}

export function localParts(ms: number, timeZone: string): LocalParts {
	const values: Record<string, number> = {};
	for (const part of formatter(timeZone).formatToParts(new Date(ms))) {
		if (part.type !== "literal") values[part.type] = Number(part.value);
	}
	const hour = values.hour ?? 0;
	return {
		year: values.year ?? 1970, month: values.month ?? 1, day: values.day ?? 1,
		hour: hour === 24 ? 0 : hour, minute: values.minute ?? 0, second: values.second ?? 0,
	};
}

/** Offset of the zone from UTC at an instant, in ms (Asia/Seoul: +9 h). */
export function zoneOffsetMs(ms: number, timeZone: string): number {
	const whole = ms - (((ms % 1000) + 1000) % 1000);
	const p = localParts(whole, timeZone);
	return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - whole;
}

/** The instant a wall-clock time of the zone names. */
export function localToUtc(timeZone: string, date: LocalDate, hour = 0, minute = 0, second = 0): number {
	const wall = Date.UTC(date.year, date.month - 1, date.day, hour, minute, second);
	// Every offset in force near this wall time (a zone changes offset at most once within a day either side).
	const offsets = new Set([zoneOffsetMs(wall - DAY, timeZone), zoneOffsetMs(wall, timeZone), zoneOffsetMs(wall + DAY, timeZone)]);
	const candidates = [...offsets].map((offset) => wall - offset);
	// Instants whose own offset names this wall time: one normally, two in a fall-back overlap (take the earlier).
	const valid = candidates.filter((t) => t + zoneOffsetMs(t, timeZone) === wall);
	if (valid.length > 0) return Math.min(...valid);
	// A gap: no instant shows this wall time. Read it with the offset before the change: the later instant (moves forward).
	return Math.max(...candidates);
}

export function addDays(date: LocalDate, days: number): LocalDate {
	const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
	return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

export function localDate(ms: number, timeZone: string): LocalDate {
	const p = localParts(ms, timeZone);
	return { year: p.year, month: p.month, day: p.day };
}

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

export function formatDate(date: LocalDate): string {
	return `${pad(date.year, 4)}-${pad(date.month)}-${pad(date.day)}`;
}

function formatOffset(offsetMs: number): string {
	if (offsetMs === 0) return "Z";
	const minutes = Math.round(Math.abs(offsetMs) / MINUTE);
	return `${offsetMs < 0 ? "-" : "+"}${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/** RFC 3339 with the zone's offset at that instant, e.g. `2026-05-07T14:00:00+09:00`. */
export function formatInstant(ms: number, timeZone: string): string {
	const p = localParts(ms, timeZone);
	return `${formatDate(p)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${formatOffset(zoneOffsetMs(ms, timeZone))}`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export function weekday(date: LocalDate): string {
	return WEEKDAYS[new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()] ?? "";
}

/** Human wall clock: `Thu 2026-05-07 14:00`. */
export function formatLocal(ms: number, timeZone: string): string {
	const p = localParts(ms, timeZone);
	return `${weekday(p)} ${formatDate(p)} ${pad(p.hour)}:${pad(p.minute)}`;
}

const plural = (value: number, unit: string) => `${value} ${unit}${value === 1 ? "" : "s"}`;

/** `in 2 days 3 hours`, `in 45 minutes`, `now`, `20 minutes ago` (two largest units). */
export function relative(targetMs: number, nowMs: number): string {
	const diff = targetMs - nowMs;
	const total = Math.floor(Math.abs(diff) / MINUTE);
	if (total < 1) return "now";
	const days = Math.floor(total / 1440);
	const hours = Math.floor((total % 1440) / 60);
	const minutes = total % 60;
	const units = [days ? plural(days, "day") : "", hours ? plural(hours, "hour") : "", minutes ? plural(minutes, "minute") : ""].filter(Boolean);
	const text = units.slice(0, 2).join(" ");
	return diff >= 0 ? `in ${text}` : `${text} ago`;
}

/** `2 days`, `1 hour 30 minutes`, `0 minutes` for an offset in minutes. */
export function duration(minutes: number): string {
	if (minutes <= 0) return "0 minutes";
	const days = Math.floor(minutes / 1440);
	const hours = Math.floor((minutes % 1440) / 60);
	const rest = minutes % 60;
	return [days ? plural(days, "day") : "", hours ? plural(hours, "hour") : "", rest ? plural(rest, "minute") : ""].filter(Boolean).join(" ");
}

export type ParsedTime = { readonly ms: number; readonly allDay: boolean; readonly date?: LocalDate };

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?([Zz]|[+-]\d{2}:\d{2})$/;
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2}))?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function checkDate(year: number, month: number, day: number, input: string): LocalDate {
	const probe = new Date(Date.UTC(year, month - 1, day));
	if (year < 1970 || year > 9999 || probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
		throw new Error(`invalid date ${JSON.stringify(input)}`);
	}
	return { year, month, day };
}

function checkClock(hour: number, minute: number, second: number, input: string): void {
	if (hour > 23 || minute > 59 || second > 59) throw new Error(`invalid time ${JSON.stringify(input)}`);
}

/**
 * Parse an event time: RFC 3339 with an offset, a local `YYYY-MM-DDTHH:mm[:ss]` read in `timeZone`, or a date
 * `YYYY-MM-DD` (all-day; `ms` is local midnight).
 */
export function parseTime(input: string, timeZone: string): ParsedTime {
	const text = input.trim();
	let match = DATE.exec(text);
	if (match) {
		const date = checkDate(Number(match[1]), Number(match[2]), Number(match[3]), input);
		return { ms: localToUtc(timeZone, date), allDay: true, date };
	}
	match = RFC3339.exec(text);
	if (match) {
		checkDate(Number(match[1]), Number(match[2]), Number(match[3]), input);
		checkClock(Number(match[4]), Number(match[5]), Number(match[6] ?? 0), input);
		const ms = Date.parse(text.replace(" ", "T"));
		if (!Number.isFinite(ms)) throw new Error(`invalid time ${JSON.stringify(input)}`);
		return { ms, allDay: false };
	}
	match = LOCAL.exec(text);
	if (match) {
		const date = checkDate(Number(match[1]), Number(match[2]), Number(match[3]), input);
		const hour = Number(match[4]);
		const minute = Number(match[5]);
		const second = Number(match[6] ?? 0);
		checkClock(hour, minute, second, input);
		return { ms: localToUtc(timeZone, date, hour, minute, second), allDay: false };
	}
	throw new Error(`unrecognized time ${JSON.stringify(input)}: use RFC 3339 (2026-05-07T14:00:00+09:00), local 2026-05-07T14:00, or a date 2026-05-07`);
}

/** Minutes since local midnight of an `HH:MM` string. */
export function clockMinutes(text: string): number {
	const [hour, minute] = text.split(":").map(Number);
	return (hour ?? 0) * 60 + (minute ?? 0);
}
