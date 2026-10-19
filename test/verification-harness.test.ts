import { afterEach, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness, MemoryStorage, type ConversationId } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createWorkService, EvidenceDoc, WorkDoc, WorkspaceCoordDoc, type AcceptanceContract, type CheckMethod } from "../src/core/verification.ts";
import { verificationExtension } from "../src/extensions/verification.ts";
const context = BACKGROUND_CONTEXT;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup() {
	const root = await mkdtemp(resolve(tmpdir(), "verification-harness-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
	const reports = resolve(root, "reports"); await mkdir(reports); await writeFile(resolve(root, "addition.test.ts"), 'import { test, expect } from "bun:test"; test("adds", () => expect(1+1).toBe(2));\n');
	const models = createModels(); const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] }); models.setProvider(faux.provider);
	const registry = createRegistry(); let harness: Harness;
	const service = createWorkService({ enforceVerification: true, getHarness: () => harness, workspaceRoot: root, hostStorage: { files: [], directories: [reports] }, evidenceDirectory: reports }); registry.install(verificationExtension(service));
	harness = await Harness.open(new MemoryStorage(), { registry, models, env: ({ cwd }) => new NodeExecutionEnv({ cwd: resolve(root, cwd ?? ".") }) }, context); cleanup.push(() => harness.close(context));
	const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: root } });
	await service.reconcileSources(conversation.id, ["source-a"], context);
	const contract: AcceptanceContract = { requirements: [{ id: "r", assertion: "addition", checkIds: ["a", "b"], scenarioIds: ["s"] }], scenarios: [{ id: "s", assertion: "1+1=2" }], checks: ["a", "b"].map(id => ({ id, requirementIds: ["r"], scenarioIds: ["s"], evidence: "behavioral", expected: "1+1=2" })) };
	const method: CheckMethod = { command: process.execPath, cwd: root, runner: "bun", args: ["./addition.test.ts"], timeout: 10, adapterVersion: 1, locators: [{ scenarioId: "s", file: "addition.test.ts", name: "adds" }] };
	const plan = { sourceIds: ["source-a"], contract, scope: { root, inputs: [], disposable: [] }, methods: { a: method, b: { ...method, args: ["./addition.test.ts", "--timeout", "4000"] } } };
	const status = await service.register(conversation.id, plan, "register", context); const workId = status.workId!;
	async function run(checkId: string, target: ConversationId = conversation.id) { const id = await harness.commit(tx => tx.createTask(service.checkTask, { workId, checkId }, { conversationId: target, ownership: { kind: "conversation" } }), context); await harness.waitForTask(id, context); return service.status(target, context); }
	return { root, harness, registry, service, conversation, workId, method, plan, run, faux };
}
test("actual durable Bun checks have common F with distinct methods and only finish certifies", async () => {
	const { harness, service, conversation, workId, run } = await setup();
	await run("a"); expect((await service.finish(conversation.id, workId, "premature", context)).status).toBe("blocked"); await run("b");
	const receipts = (await harness.snapshot(EvidenceDoc, conversation.id, context))!.attempts;
	expect(receipts).toHaveLength(2); expect(receipts.every(e => e.status === "passed")).toBe(true); expect(receipts[0]!.before).toBe(receipts[1]!.before); expect(receipts[0]!.methodHash).not.toBe(receipts[1]!.methodHash);
	const finished = await service.finish(conversation.id, workId, "finish", context); expect(finished.status).toBe("verified"); expect(finished.certificate!.evidenceIds).toHaveLength(2);
	expect((await service.projectSubmission(conversation.id, "source-a", "done", context)).workflow.status).toBe("verified");
	await service.reconcileSources(conversation.id, ["late-source"], context); expect((await service.projectSubmission(conversation.id, "late-source", "done", context)).workflow.status).not.toBe("verified");
	await service.classifyInformational(conversation.id, ["late-source"], "This follow-up only asks for an explanation", context); expect((await service.projectSubmission(conversation.id, "late-source", "explanation", context)).text).toBe("explanation");
});
test("typo repair requires all fresh receipts, preserves acceptance and allows four meaningful failures", async () => {
	const { service, conversation, workId, method, run } = await setup();
	const original = (await service.snapshot(conversation.id, context)).works[0]!.contract;
	await run("b"); let revision = 1;
	for (let i = 0; i < 4; i++) { await service.repair(conversation.id, workId, "a", revision++, { ...method, args: [`./missing-${i}.test.ts`] }, "Correcting failed executable locator, fixed behavioral expectation", [], `repair-${i}`, context); expect((await run("a")).status).toBe("blocked"); }
	await service.repair(conversation.id, workId, "a", revision, method, "Located the actual test preserving the addition scenario", [], "correct", context); await run("a");
	expect((await service.finish(conversation.id, workId, "stale-b", context)).status).toBe("blocked"); await run("b");
	const result = await service.finish(conversation.id, workId, "complete", context); expect(result.status).toBe("verified"); expect(result.costs!.attempts).toBe(7); expect((await service.snapshot(conversation.id, context)).works[0]!.contract).toEqual(original);
});
test("identical no-progress blocks third command; repair/cancel/recreate do not refund costs", async () => {
	const { service, conversation, workId, method, plan, run } = await setup();
	await service.repair(conversation.id, workId, "a", 1, { ...method, args: ["./missing.test.ts"] }, "Bad path candidate", [], "bad", context);
	await run("a"); await run("a"); const blocked = await run("a"); expect(blocked.blockers.join(" ")).toContain("no_progress"); expect(blocked.costs!.attempts).toBe(2);
	await service.cancel(conversation.id, workId, context);
	await service.register(conversation.id, { ...plan, workId, methods: { ...plan.methods, a: { ...method, args: ["./missing.test.ts"] } } }, "recreate", context);
	expect((await run("a")).costs!.attempts).toBe(2);
	await service.repair(conversation.id, workId, "a", 2, method, "Real locator correction", [], "good", context); expect((await run("a")).costs!.attempts).toBe(3);
});
test("late edits stale certificate and runtime report writes do not", async () => {
	const { root, service, conversation, workId, run } = await setup(); await run("a"); await run("b"); await service.finish(conversation.id, workId, "finish", context);
	await writeFile(resolve(root, "reports", "runtime.log"), "runtime bookkeeping"); expect((await service.status(conversation.id, context)).status).toBe("verified");
	await writeFile(resolve(root, "addition.test.ts"), '// actual project edit\n'); expect((await service.status(conversation.id, context)).status).toBe("blocked");
});
test("crash-unknown lease remains, status usable and overall todo guard rejects", async () => {
	const { harness, service, conversation, workId, root } = await setup();
	await harness.commit(async tx => { (await tx.doc(WorkspaceCoordDoc)).leases.push({ id: "lost-effect", taskId: "lost-task", workId, root, environment: "node:local", conversationId: String(conversation.id), reason: "verification", phase: "effect-may-have-started" }); }, context);
	await service.recover(context); expect((await harness.snapshot(WorkspaceCoordDoc, context))!.leases[0]!.phase).toBe("blocked-unknown");
	expect((await service.status(conversation.id, context)).status).toBe("blocked");
	await expect(harness.commit(tx => service.assertTodoCompletion(tx, conversation.id, workId), context)).rejects.toThrow();
	await expect(service.finish(conversation.id, workId, "blocked-finish", context)).rejects.toThrow("workspace_busy");
	expect((await harness.snapshot(WorkDoc, conversation.id, context))!.works).toHaveLength(1);
});
test("registry exposes four verification tools and excludes orchestration from mutation wrappers", async () => {
	const { registry } = await setup(); const extension = registry.snapshot().extension("verification")!;
	expect(extension.tools!.map(t => t.name)).toEqual(["work_status", "work_plan", "verify_run", "work_finish"]);
	expect(extension.wraps!.flatMap(w => "tool" in w ? [w.tool] : [])).toEqual(["write", "edit", "bash"]);
});

test("submit-only informational yield is finalized before a later coding plan", async () => {
	const { harness, service, root, plan, faux } = await setup();
	const target = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: root } }, context);
	expect((await service.status(target.id, context)).status).toBe("informational");
	expect((await service.status(target.id, context, "unknown-source")).status).toBe("planning");
	faux.setResponses([fauxAssistantMessage("Hello.")]);
	const hello = await target.submit({ type: "input", content: "Hello" }, context);
	expect((await hello.wait(context)).status).toBe("done");
	expect((await service.snapshot(target.id, context)).sources[String(hello.id)]?.kind).toBe("informational");
	expect((await service.status(target.id, context)).status).toBe("informational");
	await service.reconcileSources(target.id, ["coding-source"], context);
	expect((await service.status(target.id, context)).status).toBe("planning");
	const status = await service.register(target.id, { ...plan, sourceIds: ["coding-source"] }, "later-plan", context);
	expect(status.status).toBe("implementing");
	expect(status.blockers).not.toContain("unresolved_source_inputs");
});

test.each([
	{ attempts: 64, seconds: 0 },
	{ attempts: 0, seconds: 1911 },
])("lifetime admission rejects exhausted attempts/time without an extra charge %p", async costs => {
	const { harness, service, conversation, run } = await setup();
	await harness.commit(async tx => { const w = (await tx.doc(WorkDoc, conversation.id)).works[0]!; w.costs.attempts = costs.attempts; w.costs.seconds = costs.seconds; }, context);
	const status = await run("a");
	expect(status.blockers.join(" ")).toContain("lifetime_attempt_or_time_budget");
	expect(status.costs!.attempts).toBe(costs.attempts); expect(status.costs!.seconds).toBe(costs.seconds);
	expect((await harness.snapshot(EvidenceDoc, conversation.id, context))!.attempts).toHaveLength(0);
	expect((await harness.snapshot(WorkspaceCoordDoc, context))!.leases).toHaveLength(0);
	expect((await service.status(conversation.id, context)).status).toBe("blocked");
});

test("atomic child binding invalidates parent evidence and unfinished runner prevents certification", async () => {
	const { harness, service, conversation, workId, root } = await setup();
	const child = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { cwd: root } }, context);
	const before = (await service.snapshot(conversation.id, context)).works[0]!.methodEpoch;
	await harness.commit(async tx => {
		const runner = await tx.createTask(service.checkTask, { workId, checkId: "a" }, { conversationId: conversation.id, ownership: { kind: "conversation" } });
		await service.bindChildTx(tx, conversation.id, workId, child.id, runner);
		await service.bindChildTx(tx, conversation.id, workId, child.id, runner);
	}, context);
	const state = await service.snapshot(conversation.id, context);
	expect(state.works[0]!.children).toHaveLength(1);
	expect(state.works[0]!.methodEpoch).toBe(before + 1);
	expect((await service.snapshot(child.id, context)).parent?.workId).toBe(workId);
	const result = await service.finish(conversation.id, workId, "child-pending", context);
	expect(result.status).toBe("blocked");
	expect(result.blockers.join(" ")).toContain("linked_child_unsettled");
});

test.each(["terminate", "handoff"] as const)("%s tool controls settle without minting verification or clearing obligations", async (kind) => {
	const { registry, service, conversation, workId, harness, faux, plan } = await setup();
	const control = kind === "terminate" ? { terminate: true as const } : { handoff: "Continue with the same unmet acceptance obligations." };
	registry.install(defineExtension({
		name: "fixture-control",
		tools: [defineTool({
			name: "fixture_control", description: "Exercise a native terminal control.", parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "done" }], control }),
		})],
	}));
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("fixture_control", {}), { stopReason: "toolUse" }),
		...Array.from({ length: 4 }, () => fauxAssistantMessage("done")),
	]);
	const source = await conversation.submit({ type: "input", content: "Finish the registered implementation.", requestId: `control:${kind}` }, context);
	await source.wait(context);
	const stored = (await service.snapshot(conversation.id, context)).works.find((work) => work.id === workId)!;
	expect(stored.contract).toEqual(plan.contract);
	expect(stored.certificate).toBeUndefined();
	expect((await harness.snapshot(EvidenceDoc, conversation.id, context))!.attempts).toEqual([]);
	const projected = await service.projectSubmission(conversation.id, String(source.id), "done", context);
	expect(projected.workflow.status).not.toBe("verified");
	expect(projected.text).not.toBe("done");
});

test("preflight reports independent session failures together without changing acceptance/evidence/leases", async () => {
	const { service, harness, conversation, plan, root } = await setup();
	const before = await service.snapshot(conversation.id, context);
	const evidence = await harness.snapshot(EvidenceDoc, conversation.id, context);
	const leases = await harness.snapshot(WorkspaceCoordDoc, context);
	const invalid: import("../src/core/verification.ts").RegisterPlan = structuredClone(plan);
	invalid.sourceIds = ["invented-thread-label"];
	invalid.scope.disposable = ["/tmp/outside-project"];
	invalid.methods.a!.runner = "process";
	invalid.methods.a!.locators = [{ scenarioId: "wrong", file: "/outside.test.ts", name: "wrong" }];
	delete (invalid.methods as Record<string, unknown>).b;
	const result = await service.preflight(conversation.id, invalid, context);
	expect(result.valid).toBe(false); expect(result.certification).toBe(false);
	for (const code of ["unknown_source", "invalid_disposable_root", "unsupported_required_runner", "method_cannot_change_coverage", "invalid_locator", "missing_method"]) expect(result.issues.some(issue => issue.code === code)).toBe(true);
	expect(result.issues.every(issue => issue.path && issue.hint)).toBe(true);
	await expect(service.register(conversation.id, invalid, "invalid", context)).rejects.toThrow("missing_method");
	expect(await service.snapshot(conversation.id, context)).toEqual(before);
	expect(await harness.snapshot(EvidenceDoc, conversation.id, context)).toEqual(evidence);
	expect(await harness.snapshot(WorkspaceCoordDoc, context)).toEqual(leases);
	const info = await service.describe(conversation.id, context);
	expect(info.root).toBe(root); expect(info.example.methods.typecheck.runner).toBe("process");
});
test("read-only preflight honors cancellation and rejects out-of-workspace scope and symlinks", async () => {
	const { service, conversation, plan, root } = await setup();
	const { symlink } = await import("node:fs/promises");
	const outside=await mkdtemp(resolve(tmpdir(),"verification-outside-"));cleanup.push(()=>rm(outside,{recursive:true,force:true}));
	await symlink(outside, resolve(root, "external"), process.platform==="win32"?"junction":"dir");
	const failed = await service.preflight(conversation.id, plan, context);
	expect(failed.issues.some(issue => issue.code.startsWith("unscoped_symlink:"))).toBe(true);
	const { withCancel } = await import("@earendil-works/chord/context");
	const cancelled = withCancel(context); cancelled.cancel();
	await expect(service.preflight(conversation.id, plan, cancelled.context)).rejects.toThrow();
	const wrong = await service.preflight(conversation.id, { ...plan, scope: { ...plan.scope, root: outside } }, context);
	expect(wrong.issues.some(issue => issue.code === "scope_root_must_equal_host_workspace" && issue.hint.includes(root))).toBe(true);
});
test("existing process checks register and execute directly without wrapper tests, preflight never certifies", async () => {
	const { service, harness, root, method } = await setup();
	const target = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: root } }, context);
	await service.reconcileSources(target.id, ["new-source"], context);
	const contract: AcceptanceContract = { requirements: [{ id: "r", assertion: "Bun runs", checkIds: ["version"], scenarioIds: ["s"] }], scenarios: [{ id: "s", assertion: "Bun version succeeds" }], checks: [{ id: "version", requirementIds: ["r"], scenarioIds: ["s"], evidence: "smoke", expected: "version exits zero" }] };
	const plan = { sourceIds: ["new-source"], contract, scope: { root, inputs: [], disposable: [] }, methods: { version: { ...method, command: `'${process.execPath.replaceAll("\\", "/")}'`, runner: "process" as const, args: ["--version"] } } };
	const before = await service.snapshot(target.id, context);
	expect((await service.preflight(target.id, plan, context)).valid).toBe(true);
	expect(await service.snapshot(target.id, context)).toEqual(before);
	const registered = await service.register(target.id, plan, "register-process", context);
	expect((await service.finish(target.id, registered.workId!, "no-evidence", context)).status).not.toBe("verified");
	const id = await harness.commit(tx => tx.createTask(service.checkTask, { workId: registered.workId!, checkId: "version" }, { conversationId: target.id, ownership: { kind: "conversation" } }), context);
	await harness.waitForTask(id, context);
	expect((await service.finish(target.id, registered.workId!, "actual-evidence", context)).status).toBe("verified");
});
