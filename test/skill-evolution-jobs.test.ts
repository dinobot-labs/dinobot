import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineExtension, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
	EvolutionCommandDoc, EvolutionJobs, evolutionJobId,
	type EvolutionBudget, type EvolutionJobInput, type EvolutionJobPolicy, type EvolutionLease,
} from "../src/core/skills/evolution-jobs.ts";
import { createEvolutionJobDriver, type EvolutionResearchExecutor, type EvolutionWorkResult } from "../src/core/skills/evolution-jobs-task.ts";

const harnesses = new Set<Harness>();
const directories: string[] = [];
afterEach(async () => {
	for (const harness of harnesses) await harness.close(context);
	harnesses.clear();
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
function units(n: number): EvolutionBudget {
	return { calls: n, tokens: n * 100, costMicros: n * 1_000, timeMs: n * 1_000, candidates: n };
}
function policy(overrides: Partial<EvolutionJobPolicy> = {}): EvolutionJobPolicy {
	return { revision: "p1", maxPending: 2, maxAttempts: 4, leaseMs: 100, cooldownMs: 10, totalBudget: units(40), maxJobBudget: units(4), ...overrides };
}
function input(problem = "repeated-failure", overrides: Partial<EvolutionJobInput> = {}): EvolutionJobInput {
	return { evidenceWindow: "window-1", evidenceCutoff: 900, problem, policyRevision: "p1", snapshot: "sha256:immutable-snapshot", budget: units(4), attemptReservation: units(1), ...overrides };
}
async function database() {
	const directory = await mkdtemp(join(tmpdir(), "evolution-jobs-")); directories.push(directory);
	return join(directory, "jobs.sqlite");
}
async function open(path: string | undefined = undefined, clock = { value: 1_000 }) {
	const storagePath = path ?? await database();
	const registry = createRegistry();
	const harness = await Harness.open(await openNodeSqliteStorage(storagePath), { registry, models: createModels() }, context);
	harnesses.add(harness);
	return { harness, registry, jobs: new EvolutionJobs(harness, () => clock.value), clock, path: storagePath };
}
async function setup(options: Partial<EvolutionJobPolicy> = {}) {
	const fixture = await open();
	await fixture.jobs.execute({ commandId: "initialize", op: "initialize", policy: policy(options) }, context);
	await fixture.jobs.execute({ commandId: "resume", op: "resume" }, context);
	return fixture;
}
async function enqueue(jobs: EvolutionJobs, name = "a", value = input(name)) {
	const receipt = await jobs.execute({ commandId: `enqueue-${name}`, op: "enqueue", input: value, overflow: "defer" }, context);
	if (!receipt.jobId) throw new Error("Missing job ID");
	return receipt.jobId;
}
async function claim(jobs: EvolutionJobs, jobId: string, suffix = "1"): Promise<EvolutionLease> {
	const receipt = await jobs.execute({ commandId: `claim-${suffix}`, op: "claim", jobId, worker: `worker-${suffix}` }, context);
	if (!receipt.lease) throw new Error("Missing lease");
	return receipt.lease;
}
async function ready(jobs: EvolutionJobs, lease: EvolutionLease, suffix = "1") {
	await jobs.execute({ commandId: `evaluate-${suffix}`, op: "stage", lease, stage: "evaluating" }, context);
	await jobs.execute({ commandId: `ready-${suffix}`, op: "stage", lease, stage: "ready" }, context);
}
async function close(harness: Harness) { await harness.close(context); harnesses.delete(harness); }
function signal<T>() {
	let resolve: (value: T) => void = () => { throw new Error("Resolver not initialized"); };
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}
const completed: EvolutionWorkResult = { outcome: "completed", spent: units(1), resultRef: "candidate:exact-hash" };

test("new evidence windows cannot bypass the problem cooldown", async () => {
	// Given one admitted problem window.
	const { jobs, clock } = await setup();
	await enqueue(jobs, "first", input("same-problem"));
	const next = { ...input("same-problem"), evidenceWindow: "window-2" };
	// When a distinct dedupe key arrives inside the same problem cooldown.
	const deferred = await jobs.execute({ commandId: "too-soon", op: "enqueue", input: next, overflow: "defer" }, context);
	// Then it defers until the logical clock reaches the registered boundary.
	expect(deferred.outcome).toBe("deferred");
	clock.value += 10;
	const admitted = await jobs.execute({ commandId: "after-cooldown", op: "enqueue", input: next, overflow: "defer" }, context);
	expect(admitted.outcome).toBe("accepted");
});

test("unconfigured and paused queues do not admit research; policy is immutable", async () => {
	const { jobs } = await open();
	await expect(enqueue(jobs)).rejects.toThrow("not initialized");
	await jobs.execute({ commandId: "init", op: "initialize", policy: policy() }, context);
	const receipt = await jobs.execute({ commandId: "paused", op: "enqueue", input: input(), overflow: "defer" }, context);
	expect(receipt).toMatchObject({ outcome: "deferred", reason: "paused" });
	await expect(jobs.execute({ commandId: "replace", op: "initialize", policy: policy({ revision: "p2" }) }, context)).rejects.toThrow("frozen");
	expect((await jobs.status(context))?.pending).toEqual([]);
});

test("bounded pending index records coalesce defer drop coverage without changing snapshot", async () => {
	const { jobs } = await setup();
	const value = input("a");
	const id = await enqueue(jobs, "a", value);
	await enqueue(jobs, "b");
	const coalesced = await jobs.execute({ commandId: "coalesce", op: "enqueue", input: { ...value, snapshot: "other-snapshot", evidenceCutoff: 950 }, overflow: "defer" }, context);
	expect(coalesced.outcome).toBe("coalesced");
	expect((await jobs.job(id, context))?.input).toEqual(value);
	const deferred = await jobs.execute({ commandId: "overflow", op: "enqueue", input: input("c"), overflow: "defer" }, context);
	expect(deferred).toMatchObject({ outcome: "deferred", reason: "capacity" });
	expect(await jobs.job(evolutionJobId(input("c")), context)).toBeUndefined();
	await jobs.execute({ commandId: "drop", op: "enqueue", input: input("d"), overflow: "drop" }, context);
	expect((await jobs.status(context))?.coverage).toEqual({ accepted: 2, coalesced: 1, deferred: 1, dropped: 1 });
	await jobs.execute({ commandId: "cancel", op: "cancel", jobId: id }, context);
	expect((await jobs.execute({ commandId: "retry-admission", op: "enqueue", input: input("c"), overflow: "defer" }, context)).outcome).toBe("accepted");
	expect((await jobs.status(context))?.pending).toHaveLength(2);
});

test("command fingerprints are operation/input bound; receipts and outbox survive SQLite restart", async () => {
	const first = await setup();
	const command = { commandId: "original", op: "enqueue", input: input(), overflow: "defer" } as const;
	const receipt = await first.jobs.execute(command, context);
	await close(first.harness);
	const second = await open(first.path, first.clock);
	expect(await second.jobs.execute(command, context)).toEqual(receipt);
	expect(await second.jobs.outbox("original", context)).toEqual(receipt);
	await expect(second.jobs.execute({ ...command, input: input("different") }, context)).rejects.toThrow("reused");
	await expect(second.jobs.execute({ commandId: "original", op: "kill" }, context)).rejects.toThrow("reused");
	expect((await second.jobs.status(context))?.coverage.accepted).toBe(1);
	await second.jobs.execute({ commandId: "ack", op: "ack", receiptId: "original" }, context);
	expect(await second.jobs.outbox("original", context)).toBeNull();
	await close(second.harness);
	const third = await open(first.path, first.clock);
	expect(await third.jobs.outbox("original", context)).toBeNull();
	expect(await third.jobs.execute(command, context)).toEqual(receipt);
});

test("transaction failure leaves neither job admission nor receipt/outbox", async () => {
	const { harness, jobs, clock } = await setup();
	const command = { commandId: "rolled-back", op: "enqueue", input: input(), overflow: "defer" } as const;
	await expect(harness.commit(async (tx) => {
		await jobs.apply(tx, command, clock.value);
		throw new Error("commit refused");
	}, context)).rejects.toThrow("commit refused");
	expect((await jobs.status(context))?.pending).toEqual([]);
	expect(await harness.snapshot(EvolutionCommandDoc, "rolled-back", context)).toBeUndefined();
	expect(await jobs.outbox("rolled-back", context)).toBeNull();
	expect((await jobs.execute(command, context)).outcome).toBe("accepted");
});

test("queue reserves global budget before admission and refunds only known unused resources", async () => {
	const { jobs } = await setup({ totalBudget: units(4) });
	const id = await enqueue(jobs);
	expect((await jobs.execute({ commandId: "budget-full", op: "enqueue", input: input("other"), overflow: "defer" }, context))).toMatchObject({ outcome: "deferred", reason: "budget" });
	const lease = await claim(jobs, id);
	await ready(jobs, lease);
	await jobs.execute({ commandId: "settle", op: "settle", lease, ...completed }, context);
	const state = await jobs.status(context);
	expect(state?.spent).toEqual(units(1));
	expect(state?.reserved).toEqual(units(0));
	expect((await jobs.execute({ commandId: "cannot-afford", op: "enqueue", input: input("other"), overflow: "defer" }, context)).reason).toBe("budget");
	expect((await jobs.execute({ commandId: "smaller", op: "enqueue", input: input("small", { budget: units(3) }), overflow: "defer" }, context)).outcome).toBe("accepted");
});

test("safe integer and hard limits reject every invalid budget dimension without effects", async () => {
	const { jobs } = await setup();
	for (const key of ["calls", "tokens", "costMicros", "timeMs", "candidates"] as const) {
		for (const value of [-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
			await expect(jobs.execute({ commandId: `invalid-${key}-${value}`, op: "enqueue", input: input(key, { budget: { ...units(4), [key]: value } }), overflow: "defer" }, context)).rejects.toThrow("safe");
		}
	}
	await expect(enqueue(jobs, "large", input("large", { attemptReservation: units(5) }))).rejects.toThrow("frozen limit");
	await expect(enqueue(jobs, "future", input("future", { evidenceCutoff: 1_001 }))).rejects.toThrow("future");
	const other = await open();
	for (const limits of [policy({ maxPending: 33 }), policy({ maxAttempts: 5 }), policy({ maxJobBudget: { ...units(4), calls: 9 } })]) {
		await expect(other.jobs.execute({ commandId: `bad-${JSON.stringify(limits)}`.slice(0, 500), op: "initialize", policy: limits }, context)).rejects.toThrow();
	}
	expect((await jobs.status(context))?.pending).toEqual([]);
});

test("lease boundary is exclusive; reclaim advances fence and refuses late workers after restart", async () => {
	const first = await setup();
	const id = await enqueue(first.jobs);
	const old = await claim(first.jobs, id);
	first.clock.value = 1_100;
	await expect(first.jobs.execute({ commandId: "late-at-boundary", op: "settle", lease: old, ...completed }, context)).rejects.toThrow("Stale");
	await close(first.harness);
	const second = await open(first.path, first.clock);
	await second.jobs.execute({ commandId: "reap", op: "reap", jobId: id }, context);
	expect((await second.jobs.job(id, context))?.spent).toEqual(units(1));
	await expect(claim(second.jobs, id, "cooldown")).rejects.toThrow("cooldown");
	second.clock.value = 1_110;
	const current = await claim(second.jobs, id, "2");
	expect(current.fence).toBeGreaterThan(old.fence);
	await expect(second.jobs.execute({ commandId: "late-old", op: "stage", lease: old, stage: "evaluating" }, context)).rejects.toThrow("Stale");
	await expect(second.jobs.execute({ commandId: "late-budget", op: "settle", lease: old, outcome: "retry", spent: units(0), resultRef: null }, context)).rejects.toThrow("Stale");
	await expect(second.jobs.execute({ commandId: "old-interrupt", op: "interrupt", lease: old }, context)).rejects.toThrow("Stale");
	expect((await second.jobs.job(id, context))?.worker).toBe(current.worker);
	await ready(second.jobs, current, "2");
	await second.jobs.execute({ commandId: "settle-2", op: "settle", lease: current, ...completed }, context);
	expect((await second.jobs.status(context))?.spent).toEqual(units(2));
});

test("combined concurrency is one even when a lease has expired until explicit reap", async () => {
	const { jobs, clock } = await setup();
	const a = await enqueue(jobs, "a"); const b = await enqueue(jobs, "b");
	await claim(jobs, a);
	await expect(claim(jobs, b, "other")).rejects.toThrow("concurrency");
	clock.value = 1_100;
	await expect(claim(jobs, b, "expired-other")).rejects.toThrow("concurrency");
	await jobs.execute({ commandId: "reap", op: "reap", jobId: a }, context);
	expect((await claim(jobs, b, "next")).jobId).toBe(b);
});

test("attempt cap and frozen reservations prevent retry budget replenishment", async () => {
	const { jobs, clock } = await setup({ maxAttempts: 2 });
	const id = await enqueue(jobs);
	const lease = await claim(jobs, id);
	await expect(jobs.execute({ commandId: "overspend", op: "settle", lease, spent: units(2), outcome: "retry", resultRef: null }, context)).rejects.toThrow("reservation");
	expect((await jobs.job(id, context))?.spent).toEqual(units(0));
	await jobs.execute({ commandId: "retry", op: "settle", lease, spent: units(1), outcome: "retry", resultRef: null }, context);
	await expect(claim(jobs, id, "early")).rejects.toThrow("cooldown");
	clock.value = 1_010;
	const second = await claim(jobs, id, "second");
	await jobs.execute({ commandId: "retry-exhausted", op: "settle", lease: second, spent: units(1), outcome: "retry", resultRef: null }, context);
	expect((await jobs.job(id, context))?.status).toBe("failed");
	expect((await jobs.status(context))?.reserved).toEqual(units(0));
	await expect(claim(jobs, id, "third")).rejects.toThrow("pending");
	const poor = await enqueue(jobs, "poor", input("poor", { budget: units(1) }));
	const poorLease = await claim(jobs, poor, "poor");
	await jobs.execute({ commandId: "no-budget", op: "settle", lease: poorLease, spent: units(1), outcome: "retry", resultRef: null }, context);
	expect((await jobs.job(poor, context))?.status).toBe("failed");
});

test("stage order and completion reference are required; duplicate completion is effect-once", async () => {
	const { jobs } = await setup();
	const id = await enqueue(jobs); const lease = await claim(jobs, id);
	await expect(jobs.execute({ commandId: "skip-stage", op: "stage", lease, stage: "ready" }, context)).rejects.toThrow("transition");
	await expect(jobs.execute({ commandId: "premature", op: "settle", lease, ...completed }, context)).rejects.toThrow("ready");
	await ready(jobs, lease);
	await expect(jobs.execute({ commandId: "no-ref", op: "settle", lease, ...completed, resultRef: null }, context)).rejects.toThrow("reference");
	const command = { commandId: "done", op: "settle", lease, ...completed } as const;
	const receipt = await jobs.execute(command, context);
	expect(await jobs.execute(command, context)).toEqual(receipt);
	expect((await jobs.status(context))?.spent).toEqual(units(1));
	await expect(jobs.execute({ ...command, commandId: "new-done" }, context)).rejects.toThrow("Stale");
});

test("pause kill and cancel charge in-flight reservations and preserve queued jobs", async () => {
	const { jobs, clock } = await setup();
	const active = await enqueue(jobs, "active"); const pending = await enqueue(jobs, "pending");
	const old = await claim(jobs, active);
	await jobs.execute({ commandId: "pause", op: "pause" }, context);
	expect((await jobs.status(context))?.epoch).toBe(old.epoch + 1);
	await expect(jobs.execute({ commandId: "paused-finish", op: "settle", lease: old, ...completed }, context)).rejects.toThrow("Stale");
	expect((await jobs.job(pending, context))?.status).toBe("pending");
	await jobs.execute({ commandId: "resume-2", op: "resume" }, context); clock.value += 10;
	const next = await claim(jobs, active, "next");
	await jobs.execute({ commandId: "kill", op: "kill" }, context);
	expect((await jobs.status(context))?.mode).toBe("killed");
	await expect(jobs.execute({ commandId: "killed-finish", op: "settle", lease: next, ...completed }, context)).rejects.toThrow("Stale");
	await jobs.execute({ commandId: "cancel-pending", op: "cancel", jobId: pending }, context);
	await jobs.execute({ commandId: "cancel-active", op: "cancel", jobId: active }, context);
	expect((await jobs.status(context))?.spent).toEqual(units(2));
	expect((await jobs.status(context))?.reserved).toEqual(units(0));
	expect((await jobs.status(context))?.pending).toEqual([]);
});

test("kill/completion race follows transaction order and never partially commits", async () => {
	for (const killFirst of [true, false]) {
		const { jobs } = await setup();
		const id = await enqueue(jobs); const lease = await claim(jobs, id); await ready(jobs, lease);
		const finish = { commandId: "finish-race", op: "settle", lease, ...completed } as const;
		const kill = { commandId: "kill-race", op: "kill" } as const;
		const results = await Promise.allSettled(killFirst
			? [jobs.execute(kill, context), jobs.execute(finish, context)]
			: [jobs.execute(finish, context), jobs.execute(kill, context)]);
		expect(results[0]?.status).toBe("fulfilled");
		expect(results[1]?.status).toBe(killFirst ? "rejected" : "fulfilled");
		expect((await jobs.job(id, context))?.status).toBe(killFirst ? "retry" : "completed");
		expect(await jobs.outbox("finish-race", context)).toEqual(killFirst ? null : expect.objectContaining({ outcome: "changed" }));
		expect((await jobs.status(context))?.spent).toEqual(units(1));
	}
});

test("host-owned durable task has no parent conversation and commits settlement atomically", async () => {
	const { jobs, harness, registry, clock } = await setup();
	const main = await harness.root(context);
	const id = await enqueue(jobs);
	const executor: EvolutionResearchExecutor = { run: async (order) => {
		expect(order.input.snapshot).toBe("sha256:immutable-snapshot");
		expect(order.reservation).toEqual(units(1));
		return completed;
	} };
	const driver = createEvolutionJobDriver(jobs, executor, () => clock.value);
	registry.install(defineExtension({ name: "evolution-test", tasks: [driver.task] }));
	const taskId = await driver.schedule(harness, "scheduled", id, "host", context);
	expect(await driver.schedule(harness, "scheduled", id, "host", context)).toBe(taskId);
	await expect(driver.schedule(harness, "scheduled", id, "different", context)).rejects.toThrow("reused");
	const record = await harness.getTask(taskId, context);
	expect(record?.conversationId).not.toBe(main.id);
	expect(record?.background).toBe(true);
	expect(record?.owner).toBeUndefined();
	const settled = await harness.waitForTask(taskId, context);
	expect(settled.state.outcome).toMatchObject({ status: "completed", result: { status: "settled" } });
	expect((await jobs.job(id, context))?.status).toBe("completed");
	expect(await jobs.outbox(`task-${taskId}-settle`, context)).toMatchObject({ outcome: "changed" });
});

test("host task late result is fenced after kill with no candidate receipt", async () => {
	const { jobs, harness, registry, clock } = await setup();
	const entered = signal<void>(); const result = signal<EvolutionWorkResult>();
	const driver = createEvolutionJobDriver(jobs, { run: async () => { entered.resolve(); return result.promise; } }, () => clock.value);
	registry.install(defineExtension({ name: "evolution-test", tasks: [driver.task] }));
	const id = await enqueue(jobs);
	const taskId = await driver.schedule(harness, "scheduled", id, "host", context);
	harness.resume();
	await entered.promise;
	await jobs.execute({ commandId: "kill-host", op: "kill" }, context);
	result.resolve(completed);
	expect((await harness.waitForTask(taskId, context)).state.outcome).toMatchObject({ status: "completed", result: { status: "refused" } });
	expect(await jobs.outbox(`task-${taskId}-settle`, context)).toBeNull();
	expect((await jobs.job(id, context))?.resultRef).toBeNull();
	expect((await jobs.status(context))?.spent).toEqual(units(1));
});

test("SQLite task restart does not replay interrupted external research or refund unknown spend", async () => {
	const first = await setup();
	const entered = signal<void>();
	let runs = 0;
	const driver = createEvolutionJobDriver(first.jobs, {
		run: async (_order, abort) => {
			runs++;
			return new Promise<EvolutionWorkResult>((_resolve, reject) => {
				abort.addEventListener("abort", () => reject(abort.reason), { once: true });
				entered.resolve();
			});
		},
	}, () => first.clock.value);
	first.registry.install(defineExtension({ name: "evolution-test", tasks: [driver.task] }));
	const id = await enqueue(first.jobs);
	const taskId = await driver.schedule(first.harness, "scheduled", id, "host", context);
	first.harness.resume();
	await entered.promise;
	await close(first.harness);
	const second = await open(first.path, first.clock);
	const resumed = createEvolutionJobDriver(second.jobs, { run: async () => { runs++; return completed; } }, () => second.clock.value);
	second.registry.install(defineExtension({ name: "evolution-test", tasks: [resumed.task] }));
	expect((await second.harness.waitForTask(taskId, context)).state.outcome).toMatchObject({ status: "completed", result: { status: "interrupted" } });
	expect(runs).toBe(1);
	expect((await second.jobs.job(id, context))?.status).toBe("retry");
	expect((await second.jobs.job(id, context))?.spent).toEqual(units(1));
	expect(await resumed.schedule(second.harness, "scheduled", id, "host", context)).toBe(taskId);
});

test("SQLite restart resumes finalization without repeating research or budget settlement", async () => {
	// Given a durable finalization checkpoint after the budget has already settled.
	const first = await setup();
	const entered = Promise.withResolvers<void>();
	const deadline = setTimeout(() => entered.reject(new Error("Finalization did not start")), 5000);
	let runs = 0;
	const driver = createEvolutionJobDriver(first.jobs, {
		run: async () => { runs++; return completed; },
		finalize: async (_order, _result, callContext) => {
			const abort = callContext.abortSignal;
			if (!abort) throw new Error("Missing task cancellation signal");
			await new Promise<void>((_resolve, reject) => {
				abort.addEventListener("abort", () => reject(abort.reason), { once: true });
				entered.resolve();
			});
		},
	}, () => first.clock.value);
	first.registry.install(defineExtension({ name: "evolution-test", tasks: [driver.task] }));
	const id = await enqueue(first.jobs);
	const taskId = await driver.schedule(first.harness, "scheduled", id, "host", context);
	first.harness.resume();
	try { await entered.promise; } finally { clearTimeout(deadline); }
	// When SQLite is reopened before the final effect completes.
	await close(first.harness);
	const second = await open(first.path, first.clock);
	let finalized = 0;
	const resumed = createEvolutionJobDriver(second.jobs, {
		run: async () => { runs++; return completed; },
		finalize: async () => { finalized++; },
	}, () => second.clock.value);
	second.registry.install(defineExtension({ name: "evolution-test", tasks: [resumed.task] }));
	const result = await second.harness.waitForTask(taskId, context);
	// Then only finalization resumes and accounting is not charged twice.
	expect(result.state.outcome).toMatchObject({ status: "completed", result: { status: "settled" } });
	expect(runs).toBe(1);
	expect(finalized).toBe(1);
	expect((await second.jobs.job(id, context))?.spent).toEqual(units(1));
});


// ─── Rolling budget window (design section 6) ───────────────────────────────

function withinWindow(status: { spent: EvolutionBudget; reserved: EvolutionBudget; policy: EvolutionJobPolicy | null } | undefined): void {
	if (!status?.policy) throw new Error("Missing queue policy");
	for (const key of ["calls", "tokens", "costMicros", "timeMs", "candidates"] as const) {
		expect(status.spent[key] + status.reserved[key]).toBeLessThanOrEqual(status.policy.totalBudget[key]);
	}
}

test("windowed budget: spent resets at the boundary, reservations carry over, spent+reserved <= total per window", async () => {
	const { jobs, clock } = await setup({ windowMs: 1_000, leaseMs: 100_000, maxPending: 8, totalBudget: units(8), maxJobBudget: units(4) });
	expect((await jobs.status(context))?.windowStart).toBe(1_000);
	const a = await enqueue(jobs, "a");
	const b = await enqueue(jobs, "b");
	withinWindow(await jobs.status(context));
	// b's 4 units stay reserved; a spends 1 and releases its remainder.
	const lease = await claim(jobs, a);
	await ready(jobs, lease);
	await jobs.execute({ commandId: "settle-a", op: "settle", lease, spent: units(1), outcome: "completed", resultRef: "draft-a" }, context);
	expect((await jobs.status(context))?.spent).toEqual(units(1));
	expect((await jobs.status(context))?.reserved).toEqual(units(4));
	// Same window: 1 spent + 4 reserved + 4 requested > 8.
	expect((await jobs.execute({ commandId: "c-same-window", op: "enqueue", input: input("c"), overflow: "defer" }, context))).toMatchObject({ outcome: "deferred", reason: "budget" });
	withinWindow(await jobs.status(context));
	// Claim b in this window: its reservation is outstanding across the boundary.
	const leaseB = await claim(jobs, b, "b");
	clock.value = 3_500;
	await ready(jobs, leaseB, "b");
	// Next window: spent resets to zero, b's outstanding reservation still counts; c fits exactly (0 + 4 + 4 = 8).
	expect((await jobs.execute({ commandId: "c-next-window", op: "enqueue", input: input("c"), overflow: "defer" }, context)).outcome).toBe("accepted");
	let status = await jobs.status(context);
	expect(status?.windowStart).toBe(3_000);
	expect(status?.spent).toEqual(units(0));
	expect(status?.reserved).toEqual(units(8));
	withinWindow(status);
	// A fourth job cannot overdraw this window.
	expect((await jobs.execute({ commandId: "d-full", op: "enqueue", input: input("d"), overflow: "drop" }, context))).toMatchObject({ outcome: "dropped", reason: "budget" });
	// b settles in the new window: charge moves reserved -> spent, the sum is unchanged.
	await jobs.execute({ commandId: "settle-b", op: "settle", lease: leaseB, spent: units(1), outcome: "completed", resultRef: "draft-b" }, context);
	status = await jobs.status(context);
	expect(status?.spent).toEqual(units(1));
	expect(status?.reserved).toEqual(units(4));
	withinWindow(status);
	// Several empty windows later the window start stays aligned to the original grid.
	clock.value = 7_250;
	const claimC = await jobs.execute({ commandId: "claim-c", op: "claim", jobId: evolutionJobId(input("c")), worker: "worker-c" }, context);
	expect(claimC.outcome).toBe("claimed");
	status = await jobs.status(context);
	expect(status?.windowStart).toBe(7_000);
	expect(status?.spent).toEqual(units(0));
	withinWindow(status);
});

test("lifetime budget policies (no windowMs) never replenish", async () => {
	const { jobs, clock } = await setup({ totalBudget: units(4), maxJobBudget: units(4) });
	const a = await enqueue(jobs, "a");
	const lease = await claim(jobs, a);
	await ready(jobs, lease);
	await jobs.execute({ commandId: "settle-a", op: "settle", lease, spent: units(1), outcome: "completed", resultRef: "draft-a" }, context);
	clock.value += 365 * 86_400_000;
	expect((await jobs.execute({ commandId: "b-later", op: "enqueue", input: input("b"), overflow: "defer" }, context))).toMatchObject({ outcome: "deferred", reason: "budget" });
	const status = await jobs.status(context);
	expect(status?.windowStart).toBeUndefined();
	expect(status?.spent).toEqual(units(1));
});

test("invalid windowMs is rejected at initialization", async () => {
	const { jobs } = await open();
	await expect(jobs.execute({ commandId: "init", op: "initialize", policy: policy({ windowMs: 0 }) }, context)).rejects.toThrow("windowMs");
});
