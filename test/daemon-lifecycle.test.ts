import { expect, test } from "bun:test";
import { DaemonLifecycle } from "../src/core/daemon-lifecycle.ts";

test("startup failure rolls back partial startup in reverse order", async () => {
	const owner = new DaemonLifecycle(100);
	const events: string[] = [];
	owner.own("bot", () => { events.push("bot"); });
	await owner.start({ name: "first", start() {}, stop() { events.push("first"); } });
	await expect(owner.start({ name: "partial", start() { events.push("allocated"); throw new Error("start"); }, stop() { events.push("partial"); } })).rejects.toBeInstanceOf(AggregateError);
	expect(events).toEqual(["allocated", "partial", "first", "bot"]);
	expect((await owner.stop()).errors).toEqual([]);
});

test("all cleanup failures aggregate", async () => {
	const owner = new DaemonLifecycle(100);
	const events: string[] = [];
	for (const name of ["bot", "plugin", "channel", "api"]) owner.own(name, () => { events.push(name); throw new Error(name); });
	const result = await owner.stop();
	expect(events).toEqual(["api", "channel", "plugin", "bot"]);
	expect(result.errors.map(e => e.message)).toEqual(["stop api failed", "stop channel failed", "stop plugin failed", "stop bot failed"]);
	expect(result.timedOut).toBe(false);
});

test("concurrent and repeated stop share cleanup and result without signals", async () => {
	const owner = new DaemonLifecycle(100);
	let calls = 0;
	owner.own("resource", async () => { calls++; await Promise.resolve(); });
	const first = owner.stop();
	expect(owner.stop()).toBe(first);
	const result = await first;
	expect(await owner.stop()).toBe(result);
	expect(calls).toBe(1);
	expect(result.errors).toEqual([]);
	expect(() => owner.own("late", () => {})).toThrow();
	await expect(owner.start({name: "late", start() {}, stop() {}})).rejects.toThrow();
});

test("deadline attempts remaining cleanup without claiming promise cancellation", async () => {
	const owner = new DaemonLifecycle(20);
	const events: string[] = [];
	let reject!: (reason: Error) => void;
	owner.own("bot", () => { events.push("bot"); });
	owner.own("hang", () => new Promise<void>((_, fail) => { events.push("hang"); reject = fail; }));
	const result = await owner.stop();
	expect(result.timedOut).toBe(true);
	expect(events).toEqual(["hang", "bot"]);
	expect(result.errors.some(e => e.message.includes("hang") && e.message.includes("deadline"))).toBe(true);
	reject(new Error("late rejection is observed"));
	await new Promise(resolve => setTimeout(resolve, 0));
	expect(await owner.stop()).toBe(result);
});

test("stop during startup waits for settlement and prevents further starts", async () => {
	const owner = new DaemonLifecycle(100);
	let finish!: () => void;
	const events: string[] = [];
	const starting = owner.start({ name: "partial", start: () => new Promise<void>(resolve => { finish = resolve; }), stop() { events.push("stop"); } });
	await Promise.resolve();
	const stopping = owner.stop();
	expect(events).toEqual([]);
	finish();
	await expect(starting).rejects.toThrow();
	expect((await stopping).errors).toEqual([]);
	expect(events).toEqual(["stop"]);
});

test("hung startup cannot hold shutdown past its deadline", async () => {
	const owner = new DaemonLifecycle(20);
	let calls = 0;
	let finish!: () => void;
	const starting = owner.start({ name: "hung start", start: () => new Promise<void>(resolve => { finish = resolve; }), stop() { calls++; } });
	// Observe eventual rejection before triggering the concurrent stop.
	const observed = starting.catch(error => error);
	await Promise.resolve();
	const result = await owner.stop();
	expect(result.timedOut).toBe(true);
	expect(result.errors[0]?.message).toContain("start hung start exceeded shutdown deadline");
	expect(calls).toBe(1);
	finish();
	expect(await observed).toBeInstanceOf(Error);
	expect(await owner.stop()).toBe(result);
	expect(calls).toBe(1);
});

test("healthy startup stays sequential and shutdown reverses it", async () => {
	const owner = new DaemonLifecycle(100);
	const events: string[] = [];
	for (const name of ["first", "second"]) {
		await owner.start({ name, async start() { await Promise.resolve(); events.push("start " + name); }, async stop() { await Promise.resolve(); events.push("stop " + name); } });
	}
	expect(events).toEqual(["start first", "start second"]);
	expect((await owner.stop()).errors).toEqual([]);
	expect(events).toEqual(["start first", "start second", "stop second", "stop first"]);
});

test("asynchronous cleanup rejection does not skip remaining resources", async () => {
	const owner = new DaemonLifecycle(100);
	let closed = false;
	owner.own("bot", () => { closed = true; });
	owner.own("api", async () => { await Promise.resolve(); throw new Error("async failure"); });
	const result = await owner.stop();
	expect(closed).toBe(true);
	expect(result.errors).toHaveLength(1);
	expect(result.errors[0]?.cause).toEqual(new Error("async failure"));
});

test("failed startup never starts later resources", async () => {
	const owner = new DaemonLifecycle(100);
	let touched = false;
	await expect(owner.start({ name: "failed", async start() { throw new Error("failed"); }, stop() {} })).rejects.toThrow();
	await expect(owner.start({ name: "later", start() { touched = true; }, stop() { touched = true; } })).rejects.toThrow();
	expect(touched).toBe(false);
});

test("invalid deadlines are rejected", () => {
	for (const timeout of [0, -1, NaN, Infinity, 2_147_483_648]) expect(() => new DaemonLifecycle(timeout)).toThrow(RangeError);
});

test("startup error retains cause and rollback diagnostics", async () => {
	const owner = new DaemonLifecycle(100);
	const cause = new Error("start");
	try {
	await owner.start({ name: "broken", start() { throw cause; }, stop() { throw new Error("close"); } });
	throw new Error("expected failure");
	} catch (error) {
	expect(error).toBeInstanceOf(AggregateError);
	const errors = (error as AggregateError).errors;
	expect(errors[0].cause).toBe(cause);
	expect(errors[1].message).toBe("stop broken failed");
	}
});
