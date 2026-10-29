import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CalendarEngine, createCalendarPlugin } from "../src/plugins/calendar/index.ts";
import { pluginCatalog } from "../src/plugins/index.ts";
import { type LoadedPlugin, loadPlugin, NO_DEPENDENCIES, type PluginToolCall, type PluginWake, type PluginWakeResult } from "../src/plugins/types.ts";

/**
 * ADR 0106 calendar plugin through loadPlugin: tools on a temp data directory, and the reminder engine driven by a
 * controllable clock and a fake host runtime that records wakes.
 */
const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "calendar-")); dirs.push(dir); return dir; };

const MINUTE = 60_000;
const SEOUL_MONDAY_0900 = Date.parse("2026-05-04T00:00:00Z"); // Mon 2026-05-04 09:00 Asia/Seoul

type Clock = { ms: number };
type FakeRuntime = { calls: PluginWake[]; next: PluginWakeResult | Error; wake(request: PluginWake): Promise<PluginWakeResult> };

function fakeRuntime(): FakeRuntime {
	const runtime: FakeRuntime = {
		calls: [], next: "admitted",
		async wake(request) {
			runtime.calls.push(request);
			if (runtime.next instanceof Error) throw runtime.next;
			return runtime.next;
		},
	};
	return runtime;
}

type Harness = { plugin: LoadedPlugin; engine: CalendarEngine; clock: Clock; dataDir: string; logs: string[] };

async function open(options: { dataDir?: string; clock?: Clock; config?: Record<string, unknown> } = {}): Promise<Harness> {
	const clock = options.clock ?? { ms: SEOUL_MONDAY_0900 };
	const dataDir = options.dataDir ?? temp();
	let engine: CalendarEngine | undefined;
	const logs: string[] = [];
	const definition = createCalendarPlugin({ now: () => clock.ms, timers: false, onEngine: (e) => { engine = e; }, log: (line) => logs.push(line) });
	const plugin = await loadPlugin(definition, { timeZone: "Asia/Seoul", ...options.config }, { ...NO_DEPENDENCIES, dataDir });
	if (Array.isArray(plugin)) throw new Error(plugin.join("\n"));
	if (engine === undefined) throw new Error("no engine");
	return { plugin, engine, clock, dataDir, logs };
}

const CONV: PluginToolCall = { conversationId: "conv-1" };

async function call(h: Harness, name: string, args: unknown, options: PluginToolCall = CONV): Promise<any> {
	const tool = h.plugin.tools.find((t) => t.name === `calendar_${name}`);
	if (!tool) throw new Error(`no tool ${name}`);
	return await tool.execute(args, options);
}

describe("calendar plugin", () => {
	test("registers as an opt-in plugin with host-owned storage, the tool vocabulary and a prompt", async () => {
		expect(pluginCatalog.calendar?.id).toBe("calendar");
		expect(pluginCatalog.calendar?.enabledByDefault).toBeUndefined();
		const h = await open();
		expect(h.plugin.tools.map((t) => `${t.name}${t.readOnly ? ":ro" : ""}`)).toEqual([
			"calendar_create_event", "calendar_list_events:ro", "calendar_get_event:ro", "calendar_update_event", "calendar_delete_event", "calendar_import_events",
		]);
		const db = join(h.dataDir, "calendar.sqlite");
		expect(h.plugin.storagePaths).toEqual([db, `${db}-wal`, `${db}-shm`]);
		expect(h.plugin.prompt).toContain("calendar_import_events");
		expect(h.plugin.prompt).toContain("every 5 minutes");
		expect(h.plugin.prompt).toContain("Asia/Seoul");
		expect(typeof h.plugin.start).toBe("function");
		await h.plugin.close?.();

		const definition = createCalendarPlugin({ timers: false });
		expect(await loadPlugin(definition, {})).toEqual(["plugins.calendar: needs databasePath or a bot data directory"]);
		expect(await loadPlugin(definition, { timeZone: "Mars/Olympus" }, { ...NO_DEPENDENCIES, dataDir: temp() })).toEqual(["plugins.calendar: unknown time zone \"Mars/Olympus\""]);
		expect(Array.isArray(await loadPlugin(definition, { checkIntervalMinutes: 0 }, { ...NO_DEPENDENCIES, dataDir: temp() }))).toBe(true);
		expect(Array.isArray(await loadPlugin(definition, { quietHours: { start: "25:00", end: "08:00" } }, { ...NO_DEPENDENCIES, dataDir: temp() }))).toBe(true);
		expect(Array.isArray(await loadPlugin(definition, { unknown: 1 }, { ...NO_DEPENDENCIES, dataDir: temp() }))).toBe(true);
		const custom = await loadPlugin(definition, { databasePath: join(temp(), "x", "cal.db"), checkIntervalMinutes: 15, quietHours: false });
		if (Array.isArray(custom)) throw new Error(custom.join());
		expect(custom.prompt).toContain("every 15 minutes");
		await custom.close?.();
	});

	test("create, get, list, update and delete; create is idempotent and records the origin conversation", async () => {
		const h = await open();
		const created = await call(h, "create_event", { title: "Design review", start: "2026-05-06T15:00", category: "meeting", preparation: "agenda and open questions", location: "Room 3" });
		expect(created.id).toMatch(/^evt_[0-9a-f]{16}$/);
		expect(created.start).toBe("2026-05-06T15:00:00+09:00");
		expect(created.reminders.map((r: any) => `${r.action}@${r.at}`)).toEqual(["prepare@2026-05-06T14:00:00+09:00", "notify@2026-05-06T14:50:00+09:00"]);
		expect(created.plan).toContain("automatic plan for a normal-importance meeting with preparation");
		expect(created.existing).toBeUndefined();

		const again = await call(h, "create_event", { title: "Design review", start: "2026-05-06T15:00:00+09:00", category: "presentation" });
		expect(again.id).toBe(created.id);
		expect(again.existing).toBe(true);
		expect(again.category).toBe("meeting");
		// another conversation registering the same thing gets its own event
		const other = await call(h, "create_event", { title: "Design review", start: "2026-05-06T15:00" }, { conversationId: "conv-2" });
		expect(other.id).not.toBe(created.id);

		const got = await call(h, "get_event", { id: created.id });
		expect(got.location).toBe("Room 3");
		expect(got.reminders.map((r: any) => r.state)).toEqual(["pending", "pending"]);
		await expect(call(h, "get_event", { id: "evt_0000000000000000" })).rejects.toThrow("unknown event");
		await expect(call(h, "create_event", { title: "x", start: "2026-05-06T15:00", end: "2026-05-06T14:00" })).rejects.toThrow("end is before start");
		await expect(call(h, "create_event", { title: "x", start: "2026-05-06", end: "2026-05-06T14:00" })).rejects.toThrow("both be dates");
		await expect(call(h, "create_event", { title: "x", start: "next friday" })).rejects.toThrow("unrecognized time");
		await expect(call(h, "create_event", { title: "x", start: "2026-05-06T15:00", timeZone: "Nowhere/City" })).rejects.toThrow("unknown time zone");

		const all = await call(h, "list_events", {});
		expect(all.timeZone).toBe("Asia/Seoul");
		expect(all.now).toBe("2026-05-04T09:00:00+09:00");
		expect(all.events.map((e: any) => e.id).sort()).toEqual([created.id, other.id].sort());
		expect((await call(h, "list_events", { query: "DESIGN" })).events).toHaveLength(2);
		expect((await call(h, "list_events", { query: "nothing" })).events).toHaveLength(0);
		expect((await call(h, "list_events", { from: "2026-05-07", to: "2026-05-20" })).events).toHaveLength(0);
		expect((await call(h, "list_events", { from: "2026-05-06", to: "2026-05-06" })).events).toHaveLength(2);

		const renamed = await call(h, "update_event", { id: created.id, title: "Design review v2", location: null });
		expect(renamed.changed).toBe(true);
		expect(renamed.location).toBeUndefined();
		expect(renamed.reminders.map((r: any) => r.at)).toEqual(created.reminders.map((r: any) => r.at));
		expect((await call(h, "update_event", { id: created.id, title: "Design review v2" })).changed).toBe(false);
		const moved = await call(h, "update_event", { id: created.id, start: "2026-05-07T10:00", end: "2026-05-07T11:00" });
		expect(moved.reminders.map((r: any) => r.at)).toEqual(["2026-05-07T09:00:00+09:00", "2026-05-07T09:50:00+09:00"]);
		const later = await call(h, "update_event", { id: created.id, start: "2026-05-07T13:00" });
		expect(later.end).toBe("2026-05-07T14:00:00+09:00"); // duration kept
		const auto = await call(h, "update_event", { id: created.id, reminders: [{ minutes: 30, action: "prepare", note: "print" }] });
		expect(auto.reminders.map((r: any) => `${r.action}:${r.minutesBefore}:${r.note}`)).toEqual(["prepare:30:print"]);
		expect(auto.plan).toContain("explicit reminders");
		expect((await call(h, "update_event", { id: created.id, reminders: null })).automaticReminders).toBe(true);

		const deleted = await call(h, "delete_event", { id: created.id });
		expect(deleted.status).toBe("cancelled");
		expect(deleted.reminders.map((r: any) => `${r.state}:${r.reason}`)).toEqual(["skipped:cancelled", "skipped:cancelled"]);
		expect((await call(h, "delete_event", { id: created.id })).alreadyCancelled).toBe(true);
		expect((await call(h, "list_events", {})).events.map((e: any) => e.id)).toEqual([other.id]);
		expect((await call(h, "list_events", { includeCancelled: true })).events).toHaveLength(2);
		await expect(call(h, "update_event", { id: created.id, title: "z" })).rejects.toThrow("cancelled");

		// creating it again (same title and start in the same conversation as first registered) revives it with the new fields
		const revived = await call(h, "create_event", { title: "Design review", start: "2026-05-06T15:00", category: "meeting", importance: "high" });
		expect(revived.id).toBe(created.id);
		expect(revived.revived).toBe(true);
		expect(revived.status).toBe("active");
		expect(revived.title).toBe("Design review");
		expect(revived.reminders.filter((r: any) => r.state === "pending").map((r: any) => r.at)).toEqual([
			"2026-05-05T15:00:00+09:00", "2026-05-06T14:00:00+09:00", "2026-05-06T14:50:00+09:00",
		]);
		// a reminder skipped by the cancellation comes back when the same plan is revived
		const retro = await call(h, "create_event", { title: "Retro", start: "2026-05-08T17:00", category: "meeting" });
		await call(h, "delete_event", { id: retro.id });
		const retroAgain = await call(h, "create_event", { title: "Retro", start: "2026-05-08T17:00", category: "meeting" });
		expect(retroAgain.reminders.map((r: any) => r.state)).toEqual(["pending"]);

		// all-day: end date inclusive
		const trip = await call(h, "create_event", { title: "Busan trip", start: "2026-05-20", end: "2026-05-22", category: "travel" });
		expect(trip).toMatchObject({ allDay: true, start: "2026-05-20", end: "2026-05-22" });
		expect(trip.reminders.map((r: any) => `${r.action}@${r.at}`)).toEqual(["prepare@2026-05-19T09:00:00+09:00", "notify@2026-05-20T09:00:00+09:00"]);
		expect((await call(h, "list_events", { from: "2026-05-22", to: "2026-05-22" })).events.map((e: any) => e.id)).toEqual([trip.id]);
		await h.plugin.close?.();
	});

	test("import_events upserts a WBS by key, applies defaults and never fails the batch for one bad item", async () => {
		const h = await open();
		const wbs = [
			{ key: "WBS-1.1", title: "Requirements sign-off", start: "2026-05-08", category: "deadline" },
			{ key: "WBS-1.2", title: "Prototype demo", start: "2026-05-15T14:00", category: "presentation", preparation: "demo script" },
			{ key: "WBS-2.1", title: "Beta launch", start: "2026-06-01" },
			{ key: "WBS-2.2", title: "Broken", start: "someday" },
			{ key: "WBS-2.3", start: "2026-06-02" },
		];
		const first = await call(h, "import_events", { items: wbs, defaults: { category: "deadline", importance: "high" } });
		expect([first.created, first.updated, first.unchanged, first.error]).toEqual([3, 0, 0, 2]);
		expect(first.items.map((i: any) => i.status)).toEqual(["created", "created", "created", "error", "error"]);
		expect(first.items[3].error).toContain("unrecognized time");
		expect(first.items[3].title).toBe("Broken");
		expect(first.items[4].error).toContain("invalid item");
		expect(first.items[0].nextReminder).toMatch(/^(prepare|notify) 2026-05-0/);
		const beta = await call(h, "get_event", { id: first.items[2].id });
		expect(beta).toMatchObject({ category: "deadline", importance: "high", key: "WBS-2.1", allDay: true });

		const again = await call(h, "import_events", { items: wbs.slice(0, 3), defaults: { category: "deadline", importance: "high" } });
		expect(again.items.map((i: any) => i.status)).toEqual(["unchanged", "unchanged", "unchanged"]);
		expect(again.items.map((i: any) => i.id)).toEqual(first.items.slice(0, 3).map((i: any) => i.id));

		const shifted = await call(h, "import_events", { items: [{ ...wbs[1], start: "2026-05-16T14:00" }], defaults: { category: "deadline", importance: "high" } });
		expect(shifted.items[0]).toMatchObject({ status: "updated", id: first.items[1].id });
		expect((await call(h, "get_event", { id: first.items[1].id })).start).toBe("2026-05-16T14:00:00+09:00");
		expect((await call(h, "list_events", { to: "2026-06-30" })).events).toHaveLength(3);

		await expect(call(h, "import_events", { items: [] })).rejects.toThrow("invalid arguments");
		await h.plugin.close?.();
	});

	test("a due reminder wakes the origin conversation once; ticks and restarts do not wake it again", async () => {
		const h = await open();
		const runtime = fakeRuntime();
		h.plugin.start?.(runtime);
		const meeting = await call(h, "create_event", { title: "Standup", start: "2026-05-04T10:00", category: "meeting", location: "Zoom" });
		expect((await h.engine.tick()).fired).toEqual([]);
		expect(runtime.calls).toEqual([]);

		h.clock.ms = SEOUL_MONDAY_0900 + 50 * MINUTE;
		const report = await h.engine.tick();
		const startMs = Date.parse("2026-05-04T01:00:00Z");
		const key = `${meeting.id}:${startMs}:10:notify`;
		expect(report.fired).toEqual([key]);
		expect(runtime.calls).toHaveLength(1);
		const wake = runtime.calls[0]!;
		expect(wake.conversationId).toBe("conv-1");
		expect(wake.key).toBe(key);
		expect(wake.key).toMatch(/^[A-Za-z0-9:._-]{1,200}$/);
		expect(wake.text).toContain(`Calendar reminder (notify) for event ${meeting.id}: "Standup"`);
		expect(wake.text).toContain("When: Mon 2026-05-04 10:00 (Asia/Seoul), in 10 minutes");
		expect(wake.text).toContain("Location: Zoom");
		expect(wake.text).toContain("short heads-up");

		await h.engine.tick();
		await h.engine.tick();
		expect(runtime.calls).toHaveLength(1);
		expect((await call(h, "get_event", { id: meeting.id })).reminders[0]).toMatchObject({ state: "fired", firedAt: "2026-05-04T09:50:00+09:00" });
		await h.plugin.close?.();

		// restart on the same data directory: the reminder is fired in the store, nothing wakes again
		const reopened = await open({ dataDir: h.dataDir, clock: h.clock });
		const runtime2 = fakeRuntime();
		reopened.plugin.start?.(runtime2);
		await reopened.engine.tick();
		expect(runtime2.calls).toEqual([]);
		expect((await call(reopened, "get_event", { id: meeting.id })).reminders[0].state).toBe("fired");
		await reopened.plugin.close?.();
	});

	test("unavailable or a throwing host keeps the reminder pending and retries after one interval, logging once", async () => {
		const h = await open();
		const runtime = fakeRuntime();
		runtime.next = "unavailable";
		h.plugin.start?.(runtime);
		const event = await call(h, "create_event", { title: "Call", start: "2026-05-04T09:30", category: "personal" });
		await h.engine.tick(); // notify 30 is due right now (09:00)
		expect(runtime.calls).toHaveLength(1);
		expect((await call(h, "get_event", { id: event.id })).reminders[0].state).toBe("pending");
		await h.engine.tick(); // same instant: not retried yet (no hot loop)
		expect(runtime.calls).toHaveLength(1);
		h.clock.ms += 5 * MINUTE;
		runtime.next = new Error("boom");
		await h.engine.tick();
		expect(runtime.calls).toHaveLength(2);
		expect(h.logs).toHaveLength(1);
		h.clock.ms += 5 * MINUTE;
		runtime.next = "duplicate"; // the host saw the key before: counts as delivered
		expect((await h.engine.tick()).fired).toHaveLength(1);
		expect(runtime.calls).toHaveLength(3);
		expect(new Set(runtime.calls.map((c) => c.key)).size).toBe(1);
		expect((await call(h, "get_event", { id: event.id })).reminders[0].state).toBe("fired");
		await h.plugin.close?.();
	});

	test("a retry-waiting earlier reminder is superseded when a later one of the same event fires; it never fires after it", async () => {
		const h = await open();
		const runtime = fakeRuntime();
		h.plugin.start?.(runtime);
		const event = await call(h, "create_event", { title: "Review", start: "2026-05-04T10:00", reminders: [{ minutes: 60 }, { minutes: 57 }] });
		const startMs = Date.parse("2026-05-04T01:00:00Z");
		const a = `${event.id}:${startMs}:60:notify`;
		const b = `${event.id}:${startMs}:57:notify`;
		const states = async () => (await call(h, "get_event", { id: event.id })).reminders.map((r: any) => `${r.minutesBefore}:${r.state}${r.reason ? `:${r.reason}` : ""}`);

		runtime.next = "unavailable";
		expect((await h.engine.tick()).deferred).toEqual([a]); // 09:00: A due, host unavailable, retry no sooner than 09:05
		h.clock.ms += 3 * MINUTE; // 09:03: B due while A still waits for its retry
		runtime.next = "admitted";
		const report = await h.engine.tick();
		expect(report.fired).toEqual([b]);
		expect(report.skipped).toEqual([{ key: a, reason: "superseded" }]);
		expect(await states()).toEqual(["60:skipped:superseded", "57:fired"]);
		for (const step of [2, 5, 10]) { // past A's retry instant: nothing fires again
			h.clock.ms += step * MINUTE;
			await h.engine.tick();
		}
		expect(runtime.calls.map((c) => c.key)).toEqual([a, b]);
		expect(runtime.calls.filter((c) => c.key.startsWith(`${event.id}:`))).toHaveLength(2);
		await h.plugin.close?.();

		// the latest due reminder still waiting for its retry: earlier ones are superseded, the event is passed over until then
		const g = await open();
		const rt = fakeRuntime();
		g.plugin.start?.(rt);
		const late = await call(g, "create_event", { title: "Sync", start: "2026-05-04T10:00", reminders: [{ minutes: 60 }, { minutes: 57 }] });
		const la = `${late.id}:${startMs}:60:notify`;
		const lb = `${late.id}:${startMs}:57:notify`;
		rt.next = "unavailable";
		await g.engine.tick(); // 09:00: A deferred
		g.clock.ms += 3 * MINUTE;
		const second = await g.engine.tick(); // 09:03: A superseded, B deferred
		expect(second.skipped).toEqual([{ key: la, reason: "superseded" }]);
		expect(second.deferred).toEqual([lb]);
		rt.next = "admitted";
		g.clock.ms += 2 * MINUTE;
		expect(await g.engine.tick()).toEqual({ fired: [], skipped: [], deferred: [] }); // 09:05: B waits until 09:08
		g.clock.ms += 3 * MINUTE;
		expect((await g.engine.tick()).fired).toEqual([lb]);
		expect(rt.calls.map((c) => c.key)).toEqual([la, lb, lb]);
		await g.plugin.close?.();
	});

	test("earlier due reminders are superseded by the latest; stale, gone and no-conversation are skipped", async () => {
		const h = await open();
		const runtime = fakeRuntime();
		h.plugin.start?.(runtime);
		const talk = await call(h, "create_event", { title: "Conference talk", start: "2026-05-08T10:00", category: "presentation", preparation: "slides" });
		const task = await call(h, "create_event", { title: "Submit expenses", start: "2026-05-04T12:00", category: "task" });
		const orphan = await call(h, "create_event", { title: "No home", start: "2026-05-04T18:00", category: "personal" }, {});
		const meeting = await call(h, "create_event", { title: "Lunch", start: "2026-05-04T12:30", category: "meeting" });
		const goneEvent = await call(h, "create_event", { title: "Old thread", start: "2026-05-04T20:00", category: "personal" }, { conversationId: "conv-gone" });

		// jump past several reminders at once (the process was down)
		h.clock.ms = Date.parse("2026-05-07T01:05:00Z"); // Thu 10:05 Seoul
		runtime.calls.length = 0;
		await h.engine.tick();
		const states = async (id: string) => (await call(h, "get_event", { id })).reminders.map((r: any) => `${r.minutesBefore}:${r.state}${r.reason ? `:${r.reason}` : ""}`);
		expect(await states(talk.id)).toEqual(["2880:skipped:superseded", "1440:fired", "60:pending", "15:pending"]);
		expect(await states(task.id)).toEqual(["0:skipped:stale"]);
		expect(await states(orphan.id)).toEqual(["30:skipped:stale"]);
		expect(await states(meeting.id)).toEqual(["10:skipped:stale"]);
		expect(runtime.calls.map((c) => c.key)).toEqual([`${talk.id}:${Date.parse("2026-05-08T01:00:00Z")}:1440:prepare`]);
		const prepare = runtime.calls[0]!.text;
		expect(prepare).toContain("Calendar reminder (prepare)");
		expect(prepare).toContain("Preparation: slides");
		expect(prepare).toContain("do the preparation now");
		expect(prepare).toContain("Other upcoming reminders: notify at Fri 2026-05-08 09:00 (1 hour before); notify at Fri 2026-05-08 09:45 (15 minutes before)");
		expect(await states(goneEvent.id)).toEqual(["30:skipped:stale"]);
		await h.plugin.close?.();

		// fresh store: a minutes-0 reminder may still fire within 15 minutes after the start; gone and no-conversation
		const g = await open();
		const rt = fakeRuntime();
		g.plugin.start?.(rt);
		const due = await call(g, "create_event", { title: "Submit expenses", start: "2026-05-04T12:00", category: "task" });
		const lost = await call(g, "create_event", { title: "No home", start: "2026-05-04T22:00", category: "personal" }, {});
		const gone = await call(g, "create_event", { title: "Old thread", start: "2026-05-04T22:00", category: "personal" }, { conversationId: "conv-gone" });
		g.clock.ms = Date.parse("2026-05-04T03:10:00Z"); // 12:10
		await g.engine.tick();
		expect((await call(g, "get_event", { id: due.id })).reminders[0].state).toBe("fired");
		g.clock.ms = Date.parse("2026-05-04T12:40:00Z"); // 21:40: both 21:30 reminders are due, the events not started
		rt.next = "gone";
		await g.engine.tick();
		expect((await call(g, "get_event", { id: lost.id })).reminders[0]).toMatchObject({ state: "skipped", reason: "no-conversation" });
		expect(rt.calls.map((c) => c.conversationId)).toEqual(["conv-1", "conv-gone"]);
		expect((await call(g, "get_event", { id: gone.id })).reminders[0]).toMatchObject({ state: "skipped", reason: "gone" });
		await g.plugin.close?.();
	});

	test("gone is recorded; update keeps fired history and never refires; delete cancels pending reminders", async () => {
		const h = await open();
		const runtime = fakeRuntime();
		h.plugin.start?.(runtime);
		const old = await call(h, "create_event", { title: "Old thread", start: "2026-05-04T20:00", category: "personal" }, { conversationId: "conv-gone" });
		const meeting = await call(h, "create_event", { title: "Sync", start: "2026-05-04T10:00", category: "meeting" });
		const dropped = await call(h, "create_event", { title: "Dropped", start: "2026-05-04T11:00", category: "meeting" });
		await call(h, "delete_event", { id: dropped.id });

		h.clock.ms = Date.parse("2026-05-04T00:50:00Z"); // 09:50: Sync notify due
		await h.engine.tick();
		expect(runtime.calls.map((c) => c.key)).toEqual([`${meeting.id}:${Date.parse("2026-05-04T01:00:00Z")}:10:notify`]);

		h.clock.ms += MINUTE;
		const updated = await call(h, "update_event", { id: meeting.id, title: "Sync (moved room)", preparation: "status notes" });
		expect(updated.reminders.map((r: any) => `${r.action}:${r.minutesBefore}:${r.state}`)).toEqual(["notify:10:fired"]);
		await h.engine.tick();
		h.clock.ms = Date.parse("2026-05-04T02:10:00Z"); // 11:10, past Dropped's start
		await h.engine.tick();
		expect(runtime.calls).toHaveLength(1);

		h.clock.ms = Date.parse("2026-05-04T10:30:00Z"); // 19:30: Old thread notify due
		runtime.next = "gone";
		await h.engine.tick();
		expect((await call(h, "get_event", { id: old.id })).reminders[0]).toMatchObject({ state: "skipped", reason: "gone" });
		expect((await call(h, "get_event", { id: dropped.id })).reminders[0]).toMatchObject({ state: "skipped", reason: "cancelled" });
		expect(runtime.calls).toHaveLength(2);
		await h.plugin.close?.();
	});

	test("a late registration gets a catch-up prepare now; real timers deliver it without a manual tick", async () => {
		const clock = { ms: Date.now() };
		let engine: CalendarEngine | undefined;
		const definition = createCalendarPlugin({ now: () => clock.ms, onEngine: (e) => { engine = e; } });
		const plugin = await loadPlugin(definition, { timeZone: "Asia/Seoul", quietHours: false }, { ...NO_DEPENDENCIES, dataDir: temp() });
		if (Array.isArray(plugin)) throw new Error(plugin.join());
		const runtime = fakeRuntime();
		plugin.start?.(runtime);
		await engine!.tick();
		const start = new Date(clock.ms + 40 * MINUTE).toISOString();
		const talk = await plugin.tools.find((t) => t.name === "calendar_create_event")!.execute({ title: "Pitch", start, category: "presentation" }, CONV) as any;
		expect(talk.reminders.map((r: any) => `${r.action}:${r.catchUp ?? false}`)).toEqual(["prepare:true", "notify:false"]);
		expect(talk.plan).toContain("catch-up");
		const deadline = Date.now() + 5000;
		while (runtime.calls.length === 0 && Date.now() < deadline) await Bun.sleep(50);
		expect(runtime.calls).toHaveLength(1);
		expect(runtime.calls[0]!.key).toContain(":catchup:prepare");
		await plugin.close?.();
		await plugin.close?.(); // idempotent
	});

	test("a new or moved event that is already over is refused with the current time, so a guessed year is corrected", async () => {
		const h = await open();
		// A real model stored 2025-07-18 for "today 23:40" (ADR 0106): no reminder could ever fire for it.
		await expect(call(h, "create_event", { title: "same-day meeting", start: "2025-07-18T23:40:00+09:00", end: "2025-07-19T00:10:00+09:00", category: "meeting" }))
			.rejects.toThrow("the event is already over: it ends before now (2026-05-04");
		const imported = await call(h, "import_events", { items: [{ title: "done task", start: "2026-05-01", key: "1.1" }, { title: "next task", start: "2026-05-06", key: "1.2" }] });
		expect(imported.items.map((i: any) => i.status)).toEqual(["error", "created"]);
		expect(imported.items[0].error).toContain("already over");
		// Within the tolerance (a meeting that just ended) and later today are fine; an all-day event today is not over.
		expect((await call(h, "create_event", { title: "standup", start: "2026-05-04T08:40", end: "2026-05-04T08:57" })).id).toMatch(/^evt_/);
		expect((await call(h, "create_event", { title: "today", start: "2026-05-04" })).id).toMatch(/^evt_/);
		const later = await call(h, "create_event", { title: "review", start: "2026-05-04T15:00" });
		await expect(call(h, "update_event", { id: later.id, start: "2025-05-04T15:00" })).rejects.toThrow("already over");
		await h.plugin.close?.();
	});

	test("each reminder is read again before its wake: cancelling or moving another event during a blocked wake is honoured", async () => {
		const h = await open();
		const a = await call(h, "create_event", { title: "A", start: "2026-05-04T10:00", category: "meeting" });
		const b = await call(h, "create_event", { title: "B", start: "2026-05-04T10:05", category: "meeting" });
		const c = await call(h, "create_event", { title: "C", start: "2026-05-04T10:06", category: "meeting" });
		const calls: string[] = [];
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => { release = resolve; });
		const runtime = {
			async wake(request: PluginWake): Promise<PluginWakeResult> {
				calls.push(request.key);
				if (calls.length === 1) await blocked;
				return "admitted";
			},
		};
		h.plugin.start?.(runtime);
		await h.engine.tick();
		h.clock.ms = SEOUL_MONDAY_0900 + 57 * MINUTE; // all three notify-10 reminders are due
		const tick = h.engine.tick();
		await Bun.sleep(10);
		expect(calls).toHaveLength(1);
		// While the first wake waits for admission, cancel one of the others and move the remaining one into the future.
		const others = [a, b, c].filter((e) => !calls[0]!.startsWith(e.id));
		await call(h, "delete_event", { id: others[0].id });
		await call(h, "update_event", { id: others[1].id, start: "2026-05-04T12:00" });
		release();
		await tick;
		expect(calls).toHaveLength(1);
		expect((await call(h, "get_event", { id: others[0].id })).reminders[0]).toMatchObject({ state: "skipped", reason: "cancelled" });
		expect((await call(h, "get_event", { id: others[1].id })).reminders.map((r: any) => r.state)).toEqual(["pending"]);
		await h.plugin.close?.();
	});

	test("re-importing a stable key into the past is refused and keeps the event; an unchanged past item re-imports", async () => {
		const h = await open();
		const first = await call(h, "import_events", { items: [{ key: "W-1", title: "Launch", start: "2026-05-20", category: "deadline" }] });
		expect(first.items[0].status).toBe("created");
		const moved = await call(h, "import_events", { items: [{ key: "W-1", title: "Launch", start: "2025-05-20", category: "deadline" }] });
		expect(moved.items[0].status).toBe("error");
		expect(moved.items[0].error).toContain("already over");
		const kept = await call(h, "get_event", { id: first.items[0].id });
		expect(kept.start).toBe("2026-05-20");
		expect(kept.reminders.some((r: any) => r.state === "pending")).toBe(true);
		// The event passes; re-importing the same plan later reports it unchanged instead of failing.
		h.clock.ms = Date.parse("2026-06-01T00:00:00Z");
		const again = await call(h, "import_events", { items: [{ key: "W-1", title: "Launch", start: "2026-05-20", category: "deadline" }] });
		expect(again.items[0].status).toBe("unchanged");
		await h.plugin.close?.();
	});
});
