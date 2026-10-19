import { afterEach, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, Harness, LiveDoc, MemoryStorage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { RunDoc } from "../src/core/dag.ts";
import { createWorkService, EvidenceDoc, type AcceptanceContract, type CheckMethod } from "../src/core/verification.ts";
import { dagExtension } from "../src/extensions/dag.ts";

const context = BACKGROUND_CONTEXT;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function setup(checkIds: string[] = ["a"], passes = true) {
	const root = await mkdtemp(resolve(tmpdir(), "dag-work-receipt-"));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	const reports = resolve(root, "reports");
	await mkdir(reports);
	await writeFile(resolve(root, "addition.test.ts"), `import { test, expect } from "bun:test"; test("adds", () => expect(1+1).toBe(${passes ? 2 : 3}));\n`);
	const models = createModels();
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	models.setProvider(faux.provider);
	const registry = createRegistry();
	let harness: Harness;
	const service = createWorkService({ enforceVerification: true, getHarness: () => harness, workspaceRoot: root, hostStorage: { files: [], directories: [reports] }, evidenceDirectory: reports });
	// Real durable runner; generation coaching is unrelated to DAG receipt settlement.
	registry.install(defineExtension({ name: "work-runner-fixture", tasks: [service.checkTask] }));
	registry.install(dagExtension(service, {}, models));
	harness = await Harness.open(new MemoryStorage(), { registry, models, env: ({ cwd }) => new NodeExecutionEnv({ cwd: resolve(root, cwd ?? ".") }) }, context);
	cleanup.push(() => harness.close(context));
	const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: root } });
	await service.reconcileSources(conversation.id, ["source-a"], context);
	const contract: AcceptanceContract = {
		requirements: [{ id: "r", assertion: "addition works", checkIds, scenarioIds: ["s"] }],
		scenarios: [{ id: "s", assertion: "1+1=2" }],
		checks: checkIds.map(id => ({ id, requirementIds: ["r"], scenarioIds: ["s"], evidence: "behavioral", expected: "1+1=2" })),
	};
	const method: CheckMethod = { command: process.execPath, cwd: root, runner: "bun", args: ["./addition.test.ts"], timeout: 10, adapterVersion: 1, locators: [{ scenarioId: "s", file: "addition.test.ts", name: "adds" }] };
	const registered = await service.register(conversation.id, { sourceIds: ["source-a"], contract, scope: { root, inputs: [], disposable: [] }, methods: Object.fromEntries(checkIds.map(id => [id, method])) }, "register", context);
	const workId = registered.workId!;
	async function dispatch(checkId = "a") {
		faux.setResponses([
			async () => {
				const live = await harness.snapshot(LiveDoc, conversation.id, context);
				const sources = (live?.run?.inputs ?? []).map(String);
				await service.reconcileSources(conversation.id, sources, context);
				await service.classifyInformational(conversation.id, sources, "Orchestration-only request to run the already registered acceptance check", context);
				return fauxAssistantMessage(fauxToolCall("dag_run", { plan: { nodes: [{ id: "v", kind: "verify", post: [{ kind: "check", id: checkId }], covers: ["r"] }], edges: [], goal: { requirements: ["r"] } } }), { stopReason: "toolUse" });
			},
			fauxAssistantMessage(fauxToolCall("dag_step", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("Check dispatch settled."),
		]);
		expect((await (await conversation.submit({ type: "input", content: "Run the registered addition check through the DAG." }, context)).wait(context)).status).toBe("done");
		const doc = (await harness.snapshot(RunDoc, conversation.id, context))!;
		return doc.runs.find(run => run.id === doc.activeId)!;
	}
	async function receipts() { return (await harness.snapshot(EvidenceDoc, conversation.id, context))?.attempts ?? []; }
	return { root, reports, service, conversation, workId, dispatch, receipts };
}

test("dag_step accepts a fresh real Bun receipt and ignores service report writes", async () => {
	const f = await setup();
	expect(await f.receipts()).toEqual([]);
	const run = await f.dispatch();
	const receipts = await f.receipts();
	expect(receipts).toHaveLength(1);
	const receipt = receipts[0]!;
	expect(receipt.status).toBe("passed");
	expect(receipt.observation?.passed).toBe(true);
	expect(receipt.observation?.quiescent).toBe(true);
	expect(receipt.before).toBe(receipt.after);
	const status = await f.service.status(f.conversation.id, context);
	expect(receipt.version).toBe(status.version);
	expect(receipt.methodEpoch).toBe(status.methodEpoch);
	expect(receipt.mutationEpoch).toBe(status.mutationEpoch);
	expect(run.status).toBe("verified");
	expect(run.certified).toEqual(["r"]);
	await writeFile(resolve(f.reports, "runtime.log"), "host bookkeeping");
	expect((await f.service.finish(f.conversation.id, f.workId, "finish", context)).status).toBe("verified");
});

test("dag_step rejects a real failed Bun assertion", async () => {
	const f = await setup(["a"], false);
	const run = await f.dispatch();
	expect(await f.receipts()).toHaveLength(1);
	expect((await f.receipts())[0]!.status).toBe("failed");
	expect(run.status).toBe("blocked");
	expect(run.certified).toEqual([]);
	expect((await f.service.finish(f.conversation.id, f.workId, "finish", context)).status).not.toBe("verified");
});

test("dag_step rejects missing required sibling evidence despite a real passed receipt", async () => {
	const f = await setup(["a", "b"]);
	const run = await f.dispatch();
	expect((await f.receipts()).map(e => [e.checkId, e.status])).toEqual([["a", "passed"]]);
	expect(run.status).toBe("blocked");
	expect(run.certified).toEqual([]);
	expect((await f.service.status(f.conversation.id, context)).unmetCheckIds).toContain("b");
});

test("dag_step rejects stale actual sibling evidence after a workspace edit", async () => {
	const f = await setup(["a", "b"]);
	await f.dispatch("b");
	const old = (await f.receipts())[0]!;
	expect(old.status).toBe("passed");
	await writeFile(resolve(f.root, "implementation.ts"), "export const add = (a: number, b: number) => a + b;\n");
	const run = await f.dispatch("a");
	const receipts = await f.receipts();
	expect(receipts).toHaveLength(2);
	expect(receipts[1]!.status).toBe("passed");
	expect(receipts[1]!.before).not.toBe(old.before);
	expect(run.status).toBe("blocked");
	expect(run.certified).toEqual([]);
	expect((await f.service.status(f.conversation.id, context)).unmetCheckIds).toContain("b");
	// Fresh sibling evidence on the SAME workspace restores progress.
	const repaired = await f.dispatch("b");
	expect(repaired.status).toBe("verified");
	expect(repaired.certified).toEqual(["r"]);
	expect((await f.receipts())[2]!.after).toBe(receipts[1]!.after);
});
