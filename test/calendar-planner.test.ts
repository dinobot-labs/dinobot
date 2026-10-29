import { describe, expect, test } from "bun:test";
import { defaultPlan, type PlannableEvent, planReminders, type PlanOptions } from "../src/plugins/calendar/planner.ts";
import { formatInstant, localToUtc, MINUTE, parseTime, relative, zoneOffsetMs } from "../src/plugins/calendar/time.ts";

/** ADR 0106 reminder planning: a pure function of the event, the clock and the user's zone. */

const SEOUL = "Asia/Seoul";
const NY = "America/New_York";
const at = (iso: string) => Date.parse(iso);
const quietOff: PlanOptions = { timeZone: SEOUL, quietHours: false };
const quiet: PlanOptions = { timeZone: SEOUL, quietHours: { start: "22:00", end: "08:00" } };

function event(fields: Partial<PlannableEvent> & { startMs: number }): PlannableEvent {
	return { allDay: false, timeZone: SEOUL, category: "other", importance: "normal", ...fields };
}

const brief = (reminders: ReturnType<typeof planReminders>, zone = SEOUL) => reminders.map((r) => `${r.action}@${formatInstant(r.fireAt, zone)}`);

describe("time", () => {
	test("Asia/Seoul wall times, formats and parsing", () => {
		expect(localToUtc(SEOUL, { year: 2026, month: 5, day: 7 }, 14, 0)).toBe(at("2026-05-07T05:00:00Z"));
		expect(formatInstant(at("2026-05-07T05:00:00Z"), SEOUL)).toBe("2026-05-07T14:00:00+09:00");
		expect(formatInstant(at("2026-05-07T05:00:00Z"), "UTC")).toBe("2026-05-07T05:00:00Z");
		expect(parseTime("2026-05-07T14:00", SEOUL)).toEqual({ ms: at("2026-05-07T05:00:00Z"), allDay: false });
		expect(parseTime("2026-05-07 14:00:30", SEOUL).ms).toBe(at("2026-05-07T05:00:30Z"));
		expect(parseTime("2026-05-07T14:00:00-04:00", SEOUL).ms).toBe(at("2026-05-07T18:00:00Z"));
		expect(parseTime("2026-05-07T05:00Z", SEOUL).ms).toBe(at("2026-05-07T05:00:00Z"));
		expect(parseTime("2026-05-07", SEOUL)).toEqual({ ms: at("2026-05-06T15:00:00Z"), allDay: true, date: { year: 2026, month: 5, day: 7 } });
		for (const bad of ["2026-02-30", "2026-13-01T10:00", "2026-05-07T24:00", "tomorrow 3pm", "2026-05-07T10:00+0900", "1969-12-31"]) {
			expect(() => parseTime(bad, SEOUL)).toThrow();
		}
		expect(relative(at("2026-05-09T08:00:00Z"), at("2026-05-07T05:00:00Z"))).toBe("in 2 days 3 hours");
		expect(relative(at("2026-05-07T05:45:00Z"), at("2026-05-07T05:00:00Z"))).toBe("in 45 minutes");
		expect(relative(at("2026-05-07T04:40:00Z"), at("2026-05-07T05:00:00Z"))).toBe("20 minutes ago");
		expect(relative(at("2026-05-07T05:00:20Z"), at("2026-05-07T05:00:00Z"))).toBe("now");
	});

	test("America/New_York DST week: spring-forward gap moves forward, fall-back takes the earlier instant", () => {
		expect(zoneOffsetMs(at("2026-03-08T06:59:00Z"), NY)).toBe(-5 * 60 * MINUTE);
		expect(zoneOffsetMs(at("2026-03-08T07:00:00Z"), NY)).toBe(-4 * 60 * MINUTE);
		expect(parseTime("2026-03-08T01:30", NY).ms).toBe(at("2026-03-08T06:30:00Z"));
		expect(parseTime("2026-03-08T02:30", NY).ms).toBe(at("2026-03-08T07:30:00Z")); // does not exist: 03:30 EDT
		expect(parseTime("2026-03-08T03:30", NY).ms).toBe(at("2026-03-08T07:30:00Z"));
		expect(parseTime("2026-11-01T01:30", NY).ms).toBe(at("2026-11-01T05:30:00Z")); // ambiguous: EDT
		expect(parseTime("2026-11-01T03:00", NY).ms).toBe(at("2026-11-01T08:00:00Z"));
		expect(formatInstant(at("2026-03-09T14:00:00Z"), NY)).toBe("2026-03-09T10:00:00-04:00");
	});

	test("east of UTC: fall-back wall times take the earlier instant, spring-forward gaps move forward", () => {
		// Europe/Berlin falls back 2026-10-25 03:00 CEST -> 02:00 CET; springs forward 2026-03-29 02:00 CET -> 03:00 CEST
		const BERLIN = "Europe/Berlin";
		expect(parseTime("2026-10-25T02:30", BERLIN).ms).toBe(at("2026-10-25T00:30:00Z")); // ambiguous: CEST (+02:00)
		expect(localToUtc(BERLIN, { year: 2026, month: 10, day: 25 }, 2, 30)).toBe(at("2026-10-25T00:30:00Z"));
		expect(parseTime("2026-10-25T02:00", BERLIN).ms).toBe(at("2026-10-25T00:00:00Z"));
		expect(parseTime("2026-10-25T01:59", BERLIN).ms).toBe(at("2026-10-24T23:59:00Z"));
		expect(parseTime("2026-10-25T03:00", BERLIN).ms).toBe(at("2026-10-25T02:00:00Z"));
		expect(parseTime("2026-03-29T02:30", BERLIN).ms).toBe(at("2026-03-29T01:30:00Z")); // does not exist: 03:30 CEST
		expect(parseTime("2026-03-29T03:30", BERLIN).ms).toBe(at("2026-03-29T01:30:00Z"));
		// Australia/Sydney falls back 2026-04-05 03:00 AEDT -> 02:00 AEST; springs forward 2026-10-04 02:00 AEST -> 03:00 AEDT
		const SYDNEY = "Australia/Sydney";
		expect(parseTime("2026-04-05T02:30", SYDNEY).ms).toBe(at("2026-04-04T15:30:00Z")); // ambiguous: AEDT (+11:00)
		expect(parseTime("2026-04-05T03:00", SYDNEY).ms).toBe(at("2026-04-04T17:00:00Z"));
		expect(parseTime("2026-10-04T02:30", SYDNEY).ms).toBe(at("2026-10-03T16:30:00Z")); // does not exist: 03:30 AEDT
		// west of UTC stays the earlier instant too
		expect(parseTime("2026-11-01T01:30", NY).ms).toBe(at("2026-11-01T05:30:00Z"));
		expect(parseTime("2026-11-01T01:00", NY).ms).toBe(at("2026-11-01T05:00:00Z"));
	});

	test("a plan across the DST change counts real minutes; quiet hours read the user's wall clock", () => {
		const start = parseTime("2026-03-09T10:00", NY).ms; // Monday after spring forward
		const plan = planReminders(event({ startMs: start, timeZone: NY, category: "presentation" }), at("2026-03-01T00:00:00Z"), { timeZone: NY, quietHours: { start: "22:00", end: "08:00" } });
		expect(plan.map((r) => r.fireAt)).toEqual([start - 2880 * MINUTE, start - 1440 * MINUTE, start - 60 * MINUTE, start - 15 * MINUTE]);
		expect(brief(plan, NY)).toEqual(["prepare@2026-03-07T09:00:00-05:00", "prepare@2026-03-08T10:00:00-04:00", "notify@2026-03-09T09:00:00-04:00", "notify@2026-03-09T09:45:00-04:00"]);
	});
});

describe("default plan", () => {
	const minutes = (fields: Parameters<typeof defaultPlan>[0]) => defaultPlan(fields).map((d) => `${d.action}${d.minutes}`).sort();
	test("by category, importance and preparation", () => {
		expect(minutes({ category: "meeting", importance: "normal" })).toEqual(["notify10"]);
		expect(minutes({ category: "meeting", importance: "normal", preparation: "agenda" })).toEqual(["notify10", "prepare60"]);
		expect(minutes({ category: "meeting", importance: "high" })).toEqual(["notify10", "prepare1440", "prepare60"]);
		expect(minutes({ category: "presentation", importance: "normal" })).toEqual(["notify15", "notify60", "prepare1440", "prepare2880"]);
		expect(minutes({ category: "presentation", importance: "high" })).toEqual(["notify15", "notify60", "prepare10080", "prepare1440", "prepare2880"]);
		expect(minutes({ category: "deadline", importance: "low" })).toEqual(["notify1440"]);
		expect(minutes({ category: "deadline", importance: "normal" })).toEqual(["notify120", "prepare1440", "prepare4320"]);
		expect(minutes({ category: "deadline", importance: "high" })).toEqual(["notify120", "prepare10080", "prepare1440", "prepare4320"]);
		expect(minutes({ category: "task", importance: "normal" })).toEqual(["notify0"]);
		expect(minutes({ category: "task", importance: "normal", preparation: "x" })).toEqual(["notify0", "prepare1440"]);
		expect(minutes({ category: "travel", importance: "normal" })).toEqual(["notify180", "prepare1440"]);
		expect(minutes({ category: "personal", importance: "normal" })).toEqual(["notify30"]);
		expect(minutes({ category: "other", importance: "low", preparation: "x" })).toEqual(["notify30", "prepare1440"]);
		// preparation without a prepare in the plan adds prepare 1 day before
		expect(minutes({ category: "deadline", importance: "low", preparation: "report" })).toEqual(["notify1440", "prepare1440"]);
		expect(minutes({ category: "meeting", importance: "normal", preparation: "   " })).toEqual(["notify10"]);
	});

	test("Asia/Seoul meeting with preparation: prepare 1 hour, notify 10 minutes before", () => {
		const start = parseTime("2026-05-07T14:00", SEOUL).ms;
		const plan = planReminders(event({ startMs: start, category: "meeting", preparation: "agenda" }), at("2026-05-01T00:00:00Z"), quiet);
		expect(plan).toEqual([
			{ key: `${start}:60:prepare`, fireAt: start - 60 * MINUTE, minutes: 60, action: "prepare" },
			{ key: `${start}:10:notify`, fireAt: start - 10 * MINUTE, minutes: 10, action: "notify" },
		]);
		// low-preparation deadline: the added prepare and the notify 1 day before merge into one prepare
		const merged = planReminders(event({ startMs: start, category: "deadline", importance: "low", preparation: "report" }), at("2026-05-01T00:00:00Z"), quietOff);
		expect(merged).toEqual([{ key: `${start}:1440:prepare`, fireAt: start - 1440 * MINUTE, minutes: 1440, action: "prepare" }]);
	});
});

describe("all-day events", () => {
	test("count back from 09:00 local on the first day; sub-day offsets collapse into one reminder keeping prepare", () => {
		const start = parseTime("2026-05-20", SEOUL).ms;
		const now = at("2026-05-01T00:00:00Z");
		expect(brief(planReminders(event({ startMs: start, allDay: true, category: "task", preparation: "slides" }), now, quiet))).toEqual([
			"prepare@2026-05-19T09:00:00+09:00", "notify@2026-05-20T09:00:00+09:00",
		]);
		expect(brief(planReminders(event({ startMs: start, allDay: true, category: "deadline" }), now, quiet))).toEqual([
			"prepare@2026-05-17T09:00:00+09:00", "prepare@2026-05-19T09:00:00+09:00", "notify@2026-05-20T09:00:00+09:00",
		]);
		const high = planReminders(event({ startMs: start, allDay: true, category: "meeting", importance: "high" }), now, quiet);
		expect(high.map((r) => r.key)).toEqual([`${start}:1440:prepare`, `${start}:0:prepare`]);
		expect(brief(high)).toEqual(["prepare@2026-05-19T09:00:00+09:00", "prepare@2026-05-20T09:00:00+09:00"]);
		const ny = parseTime("2026-03-08", NY).ms; // the DST day itself
		expect(brief(planReminders(event({ startMs: ny, allDay: true, timeZone: NY }), at("2026-03-01T00:00:00Z"), { timeZone: NY, quietHours: false }), NY)).toEqual(["notify@2026-03-08T09:00:00-04:00"]);
	});
});

describe("quiet hours", () => {
	const now = at("2026-05-01T00:00:00Z");
	test("a non-urgent reminder in the quiet window moves to the quiet end when that is at least 1 hour before the start", () => {
		const start = parseTime("2026-05-10T23:00", SEOUL).ms;
		const plan = planReminders(event({ startMs: start, category: "presentation" }), now, quiet);
		expect(brief(plan)).toEqual(["prepare@2026-05-09T08:00:00+09:00", "prepare@2026-05-10T08:00:00+09:00", "notify@2026-05-10T22:00:00+09:00", "notify@2026-05-10T22:45:00+09:00"]);
		expect(plan[0]?.key).toBe(`${start}:2880:prepare`);
		// urgent (< 3 h) reminders keep their time even inside the window
		expect(brief(planReminders(event({ startMs: start, category: "meeting" }), now, quiet))).toEqual(["notify@2026-05-10T22:50:00+09:00"]);
		expect(brief(planReminders(event({ startMs: start, category: "presentation" }), now, quietOff))[0]).toBe("prepare@2026-05-08T23:00:00+09:00");
	});

	test("otherwise it moves to 30 minutes before that night's quiet start", () => {
		const start = parseTime("2026-05-10T08:30", SEOUL).ms;
		const plan = planReminders(event({ startMs: start, category: "travel" }), now, quiet);
		expect(brief(plan)).toEqual(["prepare@2026-05-09T08:30:00+09:00", "notify@2026-05-09T21:30:00+09:00"]);
		expect(plan[1]?.key).toBe(`${start}:180:notify`);
		// evening side of the window: 23:30 -> quiet end 08:00 is too late for an 08:30 start -> 21:30 the same night
		const morning = parseTime("2026-05-11T08:30", SEOUL).ms;
		const late = planReminders(event({ startMs: morning, reminders: [{ minutes: 540, action: "notify" }] }), now, quiet);
		expect(brief(late)).toEqual(["notify@2026-05-10T21:30:00+09:00"]);
		// a non-wrapping window
		const day = planReminders(event({ startMs: parseTime("2026-05-10T18:00", SEOUL).ms, reminders: [{ minutes: 300, action: "notify" }] }), now, { timeZone: SEOUL, quietHours: { start: "12:00", end: "14:00" } });
		expect(brief(day)).toEqual(["notify@2026-05-10T14:00:00+09:00"]);
	});
});

describe("past and catch-up", () => {
	const start = parseTime("2026-05-07T14:00", SEOUL).ms;
	const presentation = event({ startMs: start, category: "presentation" });
	test("a dropped prepare with none left adds a catch-up prepare now when 15+ minutes remain", () => {
		const now = start - 30 * MINUTE;
		expect(planReminders(presentation, now, quiet)).toEqual([
			{ key: `${start}:catchup:prepare`, fireAt: now, minutes: 30, action: "prepare" },
			{ key: `${start}:15:notify`, fireAt: start - 15 * MINUTE, minutes: 15, action: "notify" },
		]);
		// within 60 s of a planned time it still counts as not past; the catch-up merges into it and keeps prepare
		expect(planReminders(presentation, start - 60 * MINUTE + 59_000, quiet)).toEqual([
			{ key: `${start}:catchup:prepare`, fireAt: start - 60 * MINUTE, minutes: 59, action: "prepare" },
			{ key: `${start}:15:notify`, fireAt: start - 15 * MINUTE, minutes: 15, action: "notify" },
		]);
	});

	test("nothing left adds a catch-up notify when 2+ minutes remain; too late adds nothing", () => {
		const now = start - 10 * MINUTE;
		expect(planReminders(presentation, now, quiet)).toEqual([{ key: `${start}:catchup:notify`, fireAt: now, minutes: 10, action: "notify" }]);
		expect(planReminders(presentation, start - 90_000, quiet)).toEqual([]);
		expect(planReminders(presentation, start + MINUTE, quiet)).toEqual([]);
	});

	test("explicit [] plans nothing; a fired prepare or reminder suppresses the catch-ups", () => {
		expect(planReminders(event({ startMs: start, reminders: [] }), start - 3 * 60 * MINUTE, quiet)).toEqual([]);
		const now = start - 30 * MINUTE;
		expect(planReminders(presentation, now, { ...quiet, fired: [{ key: `${start}:1440:prepare`, action: "prepare" }] }).map((r) => r.key)).toEqual([`${start}:15:notify`]);
		// a fired prepare of an earlier start does not count after the event moved
		expect(planReminders(presentation, now, { ...quiet, fired: [{ key: `${start - 1}:1440:prepare`, action: "prepare" }] })[0]?.key).toBe(`${start}:catchup:prepare`);
		expect(planReminders(presentation, start - 10 * MINUTE, { ...quiet, fired: [{ key: `${start}:60:notify`, action: "notify" }] })).toEqual([]);
	});
});

describe("explicit reminders, merge, cap and key stability", () => {
	const start = parseTime("2026-05-07T14:00", SEOUL).ms;
	const now = at("2026-04-01T00:00:00Z");
	test("explicit reminders replace the plan; reminders within a minute merge keeping prepare and both notes", () => {
		const plan = planReminders(event({ startMs: start, category: "presentation", preparation: "slides", reminders: [
			{ minutes: 60, action: "notify", note: "leave" }, { minutes: 61, action: "prepare", note: "print" }, { minutes: 5, action: "notify" },
		] }), now, quiet);
		expect(plan).toEqual([
			{ key: `${start}:61:prepare`, fireAt: start - 61 * MINUTE, minutes: 61, action: "prepare", note: "print; leave" },
			{ key: `${start}:5:notify`, fireAt: start - 5 * MINUTE, minutes: 5, action: "notify" },
		]);
		expect(planReminders(event({ startMs: start, reminders: [{ minutes: 30, action: "notify" }, { minutes: 30, action: "notify" }] }), now, quiet)).toHaveLength(1);
	});

	test("at most 8 reminders, keeping the latest", () => {
		const reminders = Array.from({ length: 12 }, (_, i) => ({ minutes: (i + 1) * 10, action: "notify" as const }));
		const plan = planReminders(event({ startMs: start, reminders }), now, quietOff);
		expect(plan).toHaveLength(8);
		expect(plan.map((r) => r.minutes)).toEqual([80, 70, 60, 50, 40, 30, 20, 10]);
	});

	test("replanning an unchanged event yields the same keys; passing time only removes keys", () => {
		const high = event({ startMs: start, category: "deadline", importance: "high" });
		const early = planReminders(high, now, quiet);
		expect(planReminders(high, now + 3 * 24 * 60 * MINUTE, quiet)).toEqual(early);
		const later = planReminders(high, start - 2 * 24 * 60 * MINUTE, quiet);
		expect(later.map((r) => r.key)).toEqual(early.slice(-2).map((r) => r.key));
		expect(new Set(later.map((r) => r.key)).size).toBe(later.length);
	});
});
