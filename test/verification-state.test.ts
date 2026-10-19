import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { EvidenceDoc, WorkspaceCoordDoc, type Work, type CheckMethod } from "../src/core/verification.ts";
import { fingerprint } from "../src/core/verification-execution.ts";
import { context, contract, openFixture } from "./fixtures/verification-crash.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const program = 'import {test,expect} from "bun:test"; test("adds",()=>expect(1+1).toBe(2));\n';
async function setup(timeout = 10) {
	const dir = await mkdtemp(resolve(tmpdir(), "verification-state-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	let f = await openFixture(dir);
	cleanups.push(async () => { await f.harness.close(context); if (process.platform === "win32") Bun.gc(true); });
	await writeFile(resolve(f.root, "addition.test.ts"), program);
	const { conversation, sourceId } = await f.source();
	const method = { ...f.method, timeout };
	const plan = { sourceIds: [sourceId], contract, scope: { root: f.root, inputs: [], disposable: [] }, methods: { a: method } };
	const initial = await f.service.register(conversation.id, plan, "initial", context);
	const workId = initial.workId!;
	return {
		get f() { return f; }, dir, conversation, sourceId, plan, workId, method,
		async reopen() { await f.harness.close(context); f = await openFixture(dir); await f.service.recover(context); f.harness.resume(); await f.harness.waitForIdle(context); },
		async work() { return (await f.service.snapshot(conversation.id, context)).works.find(w => w.id === workId)!; },
		async run() { return f.run(conversation.id, workId); },
		async finish(op: string) { return f.service.finish(conversation.id, workId, op, context); },
	};
}
function monotone(before: Work, after: Work) {
	for (const key of ["attempts", "repairs", "seconds", "coaching"] as const) expect(after.costs[key]).toBeGreaterThanOrEqual(before.costs[key]);
	expect(after.costs.attempts).toBeLessThanOrEqual(64); expect(after.costs.repairs).toBeLessThanOrEqual(32);
	expect(after.costs.seconds).toBeLessThanOrEqual(1920); expect(after.costs.coaching).toBeLessThanOrEqual(2);
	expect(after.costs.slots.length).toBeLessThanOrEqual(16);
	for (const slot of before.costs.slots) expect(after.costs.slots).toContain(slot);
	for (const [signature, count] of Object.entries(before.noProgress)) expect(after.noProgress[signature]).toBeGreaterThanOrEqual(count);
	expect(after.contract).toEqual(before.contract);
}

for (const trace of [
	["repair", "check", "finish"], ["repair", "finish", "check"],
	["check", "repair", "finish"], ["check", "finish", "repair"],
	["finish", "repair", "check"], ["finish", "check", "repair"],
]) test(`bounded transition trace: ${trace.join(" → ")}`, async () => {
	const s = await setup(); let previous = await s.work(); let eligible = false; let certified = false;
	for (const [index, action] of trace.entries()) {
		if (action === "repair") {
			await s.f.service.repair(s.conversation.id, s.workId, "a", 1, { ...s.method, args: ["./addition.test.ts", "--timeout", "4000"] }, "Bounded runner timeout, same addition scenario", [], `repair-${index}`, context);
			eligible = false; certified = false;
		} else if (action === "check") { await s.run(); eligible = true; certified = false; }
		else { const status = await s.finish(`finish-${index}`); expect(status.status === "verified").toBe(eligible); certified = eligible; }
		const current = await s.work(); monotone(previous, current);
		expect(Boolean(current.certificate)).toBe(certified);
		const attempts = (await s.f.harness.snapshot(EvidenceDoc, s.conversation.id, context))!.attempts;
		expect(new Set(attempts.map(e => e.taskId)).size).toBe(attempts.length);
		expect(current.costs.attempts).toBe(attempts.length);
		if (certified) expect(attempts.filter(e => current.certificate!.evidenceIds.includes(e.id)).every(e => e.status === "passed" && e.methodEpoch === current.methodEpoch)).toBe(true);
		expect((await s.f.harness.snapshot(WorkspaceCoordDoc, context))!.leases).toHaveLength(0);
		previous = current;
	}
});

test("delete/new inputs, recheck, and runtime collision cannot launder a current certificate", async () => {
	const s = await setup(); await s.run(); expect((await s.finish("first")).status).toBe("verified");
	const original = await s.work();
	await writeFile(resolve(s.f.root, "new-input.ts"), "export const changed = true;\n");
	expect((await s.f.service.status(s.conversation.id, context)).status).toBe("blocked");
	await s.run(); expect((await s.finish("new-file")).status).toBe("verified");
	await rm(resolve(s.f.root, "new-input.ts"));
	expect((await s.f.service.status(s.conversation.id, context)).status).toBe("blocked");
	await s.run(); expect((await s.finish("deleted-file")).status).toBe("verified");
	// Reusing an actual receipt for byte-identical unmanaged ABA is permitted by the observed-content contract.
	// Managed ABA is tested separately against the durable mutation epoch.
	expect((await s.work()).costs.attempts).toBe(2);
	await expect(fingerprint({ ...s.plan.scope, inputs: ["addition.test.ts"] }, { files: [resolve(s.f.root, "addition.test.ts")], directories: [] }, "node:local", context)).rejects.toThrow("runtime_input_collision");
	monotone(original, await s.work());
});

test("managed ABA restore invalidates earlier receipts even when final file bytes match", async () => {
	const s = await setup(); await s.run(); await s.finish("original"); const before = await s.work();
	const snapshot = await readFile(resolve(s.f.root, "addition.test.ts"), "utf8");
	// Real registered tool invocations exercise mutate's durable task receipt and epoch, not seeded work state.
	s.f.faux.setResponses([
		async () => {
			const state = await s.f.service.snapshot(s.conversation.id, context);
			return fauxAssistantMessage(fauxToolCall("work_plan", { op: "register", workId: s.workId, ...s.plan, sourceIds: Object.keys(state.sources) }), { stopReason: "toolUse" });
		},
		fauxAssistantMessage(fauxToolCall("fixture_write", { file: "addition.test.ts", value: snapshot + "// intermediate\n" }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("fixture_write", { file: "addition.test.ts", value: snapshot }), { stopReason: "toolUse" }),
		...Array.from({ length: 3 }, () => fauxAssistantMessage("Edits settled, verification pending.")),
	]);
	const submission = await s.conversation.submit({ type: "input", content: "Exercise a managed edit and exact restore." }, context);
	await submission.wait(context);
	expect(await readFile(resolve(s.f.root, "addition.test.ts"), "utf8")).toBe(snapshot);
	const changed = await s.work(); expect(changed.mutationEpoch).toBe(before.mutationEpoch + 2);
	expect(changed.certificate).toBeUndefined(); expect((await s.finish("aba-stale")).status).toBe("blocked");
	await s.run(); expect((await s.finish("aba-current")).status).toBe("verified");
	expect((await s.work()).costs.attempts).toBe(2); monotone(before, await s.work());
});

test("actual later source cannot inherit earlier source certificate or remove obligations", async () => {
	const s = await setup(); await s.run(); await s.finish("source-a");
	s.f.faux.setResponses([fauxAssistantMessage("A new coding request needs a new binding.")]);
	const input = await s.conversation.submit({ type: "input", content: "Also implement a new coding requirement." }, context);
	await input.wait(context);
	const late = String(input.id);
	expect((await s.f.service.status(s.conversation.id, context, late)).status).not.toBe("verified");
	const expanded = { ...s.plan, workId: s.workId, sourceIds: [s.sourceId, late] };
	await s.f.service.register(s.conversation.id, expanded, "link-new", context);
	expect((await s.finish("new-binding-old-receipts")).status).toBe("blocked");
	await s.run(); const final = await s.finish("new-binding-rerun");
	expect(final.status).toBe("verified"); expect(final.certificate!.sourceIds).toEqual([s.sourceId, late]);
	await expect(s.f.service.register(s.conversation.id, { ...expanded, contract: { ...contract, checks: [] } }, "erase", context)).rejects.toThrow();
	expect((await s.work()).costs.attempts).toBe(2);
});

test("child task settlement is not child certification; parent must rerun after binding", async () => {
	const s = await setup(); const runner = await s.run(); await s.finish("parent-alone");
	const child = await s.f.source();
	await s.f.service.bindChild(s.conversation.id, s.workId, child.conversation.id, runner, context);
	const childPlan = { ...s.plan, sourceIds: [child.sourceId] };
	const childWork = await s.f.service.register(child.conversation.id, childPlan, "child-plan", context);
	expect((await s.finish("child-not-certified")).blockers.join(" ")).toContain("linked_child_uncertified");
	await s.f.service.settle(child.conversation.id, childWork.workId!, "blocked", "Task settled, obligations still open", context);
	expect((await s.finish("settled-is-not-pass")).status).toBe("blocked");
	await s.f.run(child.conversation.id, childWork.workId!);
	expect((await s.f.service.finish(child.conversation.id, childWork.workId!, "child-finish", context)).status).toBe("verified");
	expect((await s.finish("parent-old-receipt")).status).toBe("blocked");
	await s.run(); expect((await s.finish("parent-rerun")).status).toBe("verified");
}, 15_000); // Runs four real checks; on Windows it takes 3.8-5.1 s on main as well, at bun's 5 s default.

test.each([{ timeout: 1, attempts: 64, seconds: 64 }, { timeout: 120, attempts: 16, seconds: 1920 }])("real lifetime admission boundary survives restart/cancel/recreate: %p", async budget => {
	const s = await setup(budget.timeout); let previous = await s.work();
	for (let n = 0; n < budget.attempts; n++) {
		// Genuine input change gives a distinct no-progress signature and prevents receipt reuse.
		await writeFile(resolve(s.f.root, "addition.test.ts"), program + `// input revision ${n}\n`);
		await s.run(); const current = await s.work(); monotone(previous, current);
		expect(current.costs.attempts).toBe(n + 1); expect(current.costs.seconds).toBe((n + 1) * budget.timeout);
		previous = current;
	}
	await s.reopen(); await s.f.service.cancel(s.conversation.id, s.workId, context);
	await expect(s.f.service.register(s.conversation.id, { ...s.plan, workId: "cannot-reset-lineage" }, "recreate-other", context)).rejects.toThrow("source_work_binding_is_immutable");
	await s.f.service.register(s.conversation.id, { ...s.plan, workId: s.workId }, "recreate", context);
	await writeFile(resolve(s.f.root, "addition.test.ts"), program + "// final candidate\n"); await s.run();
	const status = await s.f.service.status(s.conversation.id, context);
	expect(status.workId).toBe(s.workId); expect(status.costs!.attempts).toBe(budget.attempts); expect(status.costs!.seconds).toBe(budget.seconds);
	expect(status.blockers.join(" ")).toContain("lifetime_attempt_or_time_budget");
	expect((await s.f.harness.snapshot(EvidenceDoc, s.conversation.id, context))!.attempts).toHaveLength(budget.attempts);
	monotone(previous, await s.work());
}, 120000);

test("32 repairs and two coaching continuations persist through replay, reopen and recreation", async () => {
	const s = await setup(); let previous = await s.work(); let latest: CheckMethod = s.method;
	for (let n = 1; n <= 32; n++) {
		latest = { ...s.method, args: ["./addition.test.ts", "--timeout", String(1000 + n)] };
		await s.f.service.repair(s.conversation.id, s.workId, "a", n, latest, "Runner timeout repair without changing acceptance", [], `repair-${n}`, context);
		await s.f.service.repair(s.conversation.id, s.workId, "a", n, latest, "Replay rationale", [], `repair-${n}`, context);
		const current = await s.work(); monotone(previous, current); expect(current.costs.repairs).toBe(n); previous = current;
	}
	for (const id of ["coach-1", "coach-1", "coach-2", "coach-3"]) await s.f.service.coach(s.conversation.id, id, context);
	expect((await s.work()).costs.coaching).toBe(2);
	await s.reopen(); await s.f.service.cancel(s.conversation.id, s.workId, context);
	await s.f.service.register(s.conversation.id, { ...s.plan, methods: { a: latest } }, "recreate", context);
	await expect(s.f.service.repair(s.conversation.id, s.workId, "a", 33, s.method, "Budget cannot reset", [], "repair-33", context)).rejects.toThrow("lifetime_repair_budget");
	expect(await s.f.service.coach(s.conversation.id, "coach-after-reopen", context)).toBeUndefined();
	expect((await s.work()).methods.a).toHaveLength(33); expect((await s.work()).costs.coaching).toBe(2);
});

test("16 lifetime slots cannot be reset by strengthening or cancel/recreate", async () => {
	const s = await setup(); let plan = s.plan;
	for (let n = 1; n <= 16; n++) {
		const ids = Array.from({ length: n }, (_, index) => index === 0 ? "a" : `slot-${index}`);
		// Preserve the original requirement byte-for-byte, append new required coverage only.
		const extra = ids.slice(1).map(id => ({ id: `r-${id}`, assertion: "addition", checkIds: [id], scenarioIds: ["s"] }));
		plan = { ...s.plan, contract: { ...contract, requirements: [...contract.requirements, ...extra], checks: [contract.checks[0]!, ...ids.slice(1).map(id => ({ ...contract.checks[0]!, id, requirementIds: [`r-${id}`] }))] }, methods: Object.fromEntries(ids.map(id => [id, s.method])) as typeof s.plan.methods };
		await s.f.service.register(s.conversation.id, plan, `strengthen-${n}`, context);
		expect((await s.work()).costs.slots).toHaveLength(n);
	}
	await s.reopen(); await s.f.service.cancel(s.conversation.id, s.workId, context);
	const overflow = { ...plan, contract: { ...plan.contract, requirements: [...plan.contract.requirements, { id: "overflow-r", assertion: "addition", checkIds: ["overflow"], scenarioIds: ["s"] }], checks: [...plan.contract.checks, { ...contract.checks[0]!, id: "overflow", requirementIds: ["overflow-r"] }] }, methods: { ...plan.methods, overflow: s.method } };
	await expect(s.f.service.register(s.conversation.id, overflow, "recreate-overflow", context)).rejects.toThrow("lifetime_slot_budget");
	expect((await s.work()).costs.slots).toHaveLength(16);
});

test("identical exhausted signature survives restart, cancel/recreate, and method ABA", async () => {
	const s = await setup();
	const missing = { ...s.method, args: ["./missing.test.ts"] };
	await s.f.service.repair(s.conversation.id, s.workId, "a", 1, missing, "Exercise a missing locator without changing acceptance", [], "missing", context);
	await s.run(); await s.run();
	const exhausted = await s.work();
	expect(exhausted.costs.attempts).toBe(2); expect(Object.values(exhausted.noProgress)).toEqual([2]);
	await s.reopen(); await s.f.service.cancel(s.conversation.id, s.workId, context);
	await s.f.service.register(s.conversation.id, { ...s.plan, methods: { a: missing } }, "recreated", context);
	await s.run();
	expect((await s.f.service.status(s.conversation.id, context)).blockers.join(" ")).toContain("no_progress");
	expect((await s.work()).costs.attempts).toBe(2);
	await s.f.service.repair(s.conversation.id, s.workId, "a", 2, s.method, "Actual test located", [], "good", context);
	await s.run(); expect((await s.work()).costs.attempts).toBe(3);
	await s.f.service.repair(s.conversation.id, s.workId, "a", 3, missing, "Returning to an exhausted method is not new progress", [], "aba", context);
	await s.run();
	expect((await s.work()).costs.attempts).toBe(3);
	expect((await s.f.service.status(s.conversation.id, context)).blockers.join(" ")).toContain("no_progress");
	monotone(exhausted, await s.work());
});

test("environment changes stale certificates across reopen without leaking environment values", async () => {
	const s = await setup(); await s.run(); await s.finish("original");
	const key = "DINOBOT_VERIFICATION_STATE_TEST";
	const previous = process.env[key]; const secret = "fixture-environment-value-not-for-status";
	try {
		process.env[key] = secret;
		await s.reopen();
		const status = await s.f.service.status(s.conversation.id, context);
		expect(status.status).toBe("blocked"); expect(status.certificate).toBeNull();
		expect(JSON.stringify(status)).not.toContain(secret);
		expect((await s.finish("changed-environment")).status).toBe("blocked");
	} finally { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; }
});

test("workspace-wide runtime reservation and disposable root/outside paths are rejected", async () => {
	const s = await setup();
	await expect(fingerprint(s.plan.scope, { files: [], directories: [s.f.root] }, "node:local", context)).rejects.toThrow("runtime_input_collision");
	for (const path of [".", "..", resolve(s.f.root, "..")]) {
		await expect(fingerprint({ ...s.plan.scope, disposable: [path] }, { files: [], directories: [] }, "node:local", context)).rejects.toThrow("invalid_disposable_root");
	}
});

test("repair between finish lease commit and certificate CAS defeats concurrent finish", async () => {
	const s = await setup(); await s.run();
	const commit = s.f.harness.commit.bind(s.f.harness); let interposed = false;
	s.f.harness.commit = (async (...args: Parameters<typeof s.f.harness.commit>) => {
		const result = await commit(...args);
		if (!interposed && (await s.f.harness.snapshot(WorkspaceCoordDoc, context))?.leases.some(lease => lease.reason === "finish")) {
			interposed = true;
			await s.f.service.repair(s.conversation.id, s.workId, "a", 1, { ...s.method, args: ["./addition.test.ts", "--timeout", "4500"] }, "Concurrent legitimate runner repair", [], "racing-repair", context);
		}
		return result;
	}) as typeof s.f.harness.commit;
	try {
		const finished = await s.finish("racing-finish");
		expect(interposed).toBe(true); expect(finished.status).toBe("blocked");
		expect(finished.blockers.join(" ")).toContain("finish_revision_conflict");
		expect(finished.certificate).toBeNull(); expect(finished.costs!.attempts).toBe(1); expect(finished.costs!.repairs).toBe(1);
		expect((await s.f.harness.snapshot(WorkspaceCoordDoc, context))!.leases).toHaveLength(0);
	} finally { s.f.harness.commit = commit; }
	await s.run(); expect((await s.finish("fresh-finish")).status).toBe("verified");
});

test("real pre-hash failure charges once, releases no-effect lease, and persists across reopen", async () => {
	const s = await setup();
	await writeFile(resolve(s.dir, "outside.ts"), "outside the declared workspace\n");
	await symlink(resolve(s.dir, "outside.ts"), resolve(s.f.root, "escape.ts"));
	await s.run();
	const failed = await s.work();
	expect(failed.costs.attempts).toBe(1); expect(failed.costs.seconds).toBe(10);
	const evidence = (await s.f.harness.snapshot(EvidenceDoc, s.conversation.id, context))!.attempts;
	expect(evidence).toHaveLength(1); expect(evidence[0]!.status).toBe("failed");
	expect(evidence[0]!.error).toContain("unscoped_symlink");
	expect(evidence[0]!.observation).toBeUndefined();
	expect((await s.f.harness.snapshot(WorkspaceCoordDoc, context))!.leases).toHaveLength(0);
	await s.reopen();
	expect((await s.work()).costs).toEqual(failed.costs);
	expect((await s.f.harness.snapshot(EvidenceDoc, s.conversation.id, context))!.attempts).toEqual(evidence);
	await rm(resolve(s.f.root, "escape.ts"));
	await s.run(); expect((await s.finish("fixed-scope")).status).toBe("verified");
	expect((await s.work()).costs.attempts).toBe(2);
});

test("certificate history remains immutable after invalidation and a fresh certificate", async () => {
	const s = await setup(); await s.run();
	const first = (await s.finish("first-certificate")).certificate!;
	await writeFile(resolve(s.f.root, "addition.test.ts"), program + "// new content\n");
	expect((await s.f.service.status(s.conversation.id, context)).certificate).toBeNull();
	expect((await s.work()).certificates).toContainEqual(first);
	await s.reopen();
	expect((await s.work()).certificates).toContainEqual(first);
	await s.run(); const second = (await s.finish("second-certificate")).certificate!;
	expect(second.id).not.toBe(first.id);
	const history = (await s.work()).certificates!;
	expect(history).toContainEqual(first); expect(history).toContainEqual(second);
	expect(new Set(history.map(certificate => certificate.id)).size).toBe(history.length);
	expect(second.evidenceIds).not.toEqual(first.evidenceIds);
});

test("new logical work cannot borrow identical evidence from an earlier source and work", async () => {
	const s = await setup(); await s.run();
	const first = (await s.finish("first-work")).certificate!;
	s.f.faux.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage("Acknowledged.")));
	const source = await s.conversation.submit({ type: "input", content: "Independently verify the same behavior for this new request." }, context);
	await source.wait(context);
	const next = await s.f.service.register(s.conversation.id, { ...s.plan, sourceIds: [String(source.id)], workId: "independent-next-work" }, "new-logical-work", context);
	expect(next.workId).not.toBe(s.workId);
	const premature = await s.f.service.finish(s.conversation.id, next.workId!, "cannot-borrow", context);
	expect(premature.status).toBe("blocked");
	expect(premature.certificate).toBeNull();
	expect(premature.unmetCheckIds).toEqual(["a"]);
	await s.f.run(s.conversation.id, next.workId!);
	const second = await s.f.service.finish(s.conversation.id, next.workId!, "new-work-finish", context);
	expect(second.status).toBe("verified");
	expect(second.costs!.attempts).toBe(1);
	expect(second.certificate!.sourceIds).toEqual([String(source.id)]);
	expect(second.certificate!.evidenceIds).not.toEqual(first.evidenceIds);
	const attempts = (await s.f.harness.snapshot(EvidenceDoc, s.conversation.id, context))!.attempts;
	expect(second.certificate!.evidenceIds.every((id) => attempts.find((attempt) => attempt.id === id)?.workId === next.workId)).toBe(true);
});
