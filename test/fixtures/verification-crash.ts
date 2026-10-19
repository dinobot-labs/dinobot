import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness, type ConversationId, type TaskId } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createWorkService, EvidenceDoc, WorkDoc, WorkspaceCoordDoc, type AcceptanceContract, type CheckMethod } from "../../src/core/verification.ts";
import { verificationExtension } from "../../src/extensions/verification.ts";

export { context };
export const contract: AcceptanceContract = {
	requirements: [{ id: "r", assertion: "addition", checkIds: ["a"], scenarioIds: ["s"] }],
	scenarios: [{ id: "s", assertion: "1+1=2" }],
	checks: [{ id: "a", requirementIds: ["r"], scenarioIds: ["s"], evidence: "behavioral", expected: "1+1=2" }],
};
export async function openFixture(dir: string, cut = "", mode = "state") {
	const root = resolve(dir, "workspace"); const runtime = resolve(dir, "runtime");
	await mkdir(root, { recursive: true }); await mkdir(runtime, { recursive: true });
	const models = createModels(); const faux = fauxProvider({ provider: "faux", models: [{ id: "one" }] }); models.setProvider(faux.provider);
	const registry = createRegistry(); let harness: Harness; let armed = false; let stopped = false;
	async function barrier() {
		if (stopped) return; stopped = true;
		await writeFile(resolve(dir, "cut"), cut);
		await new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(`Unconsumed crash barrier: ${cut}`)), 20000));
	}
	const service = createWorkService({ enforceVerification: true, gateToolExecution: true, getHarness: () => harness, workspaceRoot: root, hostStorage: { files: [resolve(runtime, "state.sqlite"), resolve(runtime, "state.sqlite-wal"), resolve(runtime, "state.sqlite-shm")], directories: [runtime] }, evidenceDirectory: resolve(runtime, "reports") });
	registry.install(defineExtension({ name: "fixture", tools: [defineTool({
		name: "fixture_write", description: "Write a fixture input through the managed mutation boundary.",
		parameters: Type.Object({ file: Type.String(), value: Type.String() }),
		execute: async (args, api) => { if (!api.env) throw new Error("Fixture requires NodeExecutionEnv"); await writeFile(resolve(api.env.cwd, args.file), args.value); return { content: [{ type: "text", text: "Written" }] }; },
	})] }));
	registry.install(verificationExtension(service, ["fixture_write"]));
	const storage = await openNodeSqliteStorage(resolve(runtime, "state.sqlite"));
	harness = await Harness.open(storage, { registry, models, env: ({ cwd }) => {
		const env = new NodeExecutionEnv({ cwd: resolve(root, cwd ?? ".") });
		const exec = env.exec.bind(env);
		env.exec = async (...args) => {
			// NodeExecutionEnv owns a detached shell group. Record its ID strictly for external test cleanup.
			// Neither the service nor recovery consumes this file or treats group death as quiescence.
			const groups = resolve(dir, "command-groups").replaceAll("'", "'\\''");
			args[0] = `printf '%s\\n' "$$" >> '${groups}'; ${args[0]}`;
			const result = await exec(...args);
			if (armed && cut === "effect-completed" && args[0].includes("--reporter=junit")) await barrier();
			return result;
		};
		return env;
	} }, context);
	let conversationId: ConversationId | undefined;
	// Identify the transition inside its owning transaction, then pause its caller AFTER SQLite commits.
	// Looking at a later snapshot here could pause an unrelated createTask caller while the effect proceeds.
	// No document values or receipts are fabricated.
	const commit = harness.commit.bind(harness);
	harness.commit = (async (...args: Parameters<typeof harness.commit>) => {
		let reached = false;
		const [change, commitContext] = args;
		const result = await commit(async tx => {
			if (!armed || !conversationId || stopped) return change(tx);
			const evidence = await tx.doc(EvidenceDoc, conversationId);
			const works = await tx.doc(WorkDoc, conversationId);
			const previous = evidence.attempts.map(e => `${e.id}:${e.status}`).join(",");
			const epoch = works.works[0]?.methodEpoch; const certificate = works.works[0]?.certificate?.id;
			const value = await change(tx);
			const attempts = evidence.attempts; const work = works.works[0];
			const changed = previous !== attempts.map(e => `${e.id}:${e.status}`).join(",");
			reached = (changed && cut === "admission" && attempts.some(e => e.status === "admitted")) ||
				(changed && cut === "effect-intent" && attempts.some(e => e.status === "running")) ||
				(changed && cut === "receipt" && attempts.some(e => e.status === "passed")) ||
				(cut === "repair" && work?.methodEpoch !== epoch) ||
				(cut === "certificate" && !!work?.certificate && work.certificate.id !== certificate);
			return value;
		}, commitContext);
		if (reached) await barrier();
		return result;
	}) as typeof harness.commit;
	const method: CheckMethod = { command: process.execPath, cwd: root, runner: "bun", args: ["./addition.test.ts"], timeout: 10, adapterVersion: 1, locators: [{ scenarioId: "s", file: "addition.test.ts", name: "adds" }] };
	async function source(cwd = root) {
		const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "one" }, cwd } }, context);
		faux.setResponses([fauxAssistantMessage("Acknowledged.")]);
		const submission = await conversation.submit({ type: "input", content: "Please implement addition." }, context);
		await submission.wait(context);
		await service.reconcileSources(conversation.id, [String(submission.id)], context);
		return { conversation, sourceId: String(submission.id) };
	}
	async function run(id: ConversationId, workId: string) {
		const task = await harness.commit(tx => tx.createTask(service.checkTask, { workId, checkId: "a" }, { conversationId: id, ownership: { kind: "conversation" } }), context);
		await harness.waitForTask(task, context); return task;
	}
	return { root, runtime, harness, service, method, source, run, faux, arm(id: ConversationId) { conversationId = id; armed = mode === "initial"; } };
}

if (import.meta.main) {
	const [dir, mode, cut] = process.argv.slice(2) as [string, string, string];
	const f = await openFixture(dir, cut, mode);
	if (mode === "initial") {
		const running = cut === "command-running";
		await writeFile(resolve(f.root, "addition.test.ts"), `import { test, expect } from "bun:test"; import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
 test("adds", async () => {
 appendFileSync(${JSON.stringify(resolve(dir, "effects"))}, "effect\\n");
 ${running ? `const stat = readFileSync("/proc/self/stat", "utf8"); writeFileSync(${JSON.stringify(resolve(dir, "command-group"))}, stat.slice(stat.lastIndexOf(")")+2).split(" ")[2]); writeFileSync(${JSON.stringify(resolve(dir, "cut"))}, "command-running"); await new Promise(()=>{});` : ""}
 expect(1+1).toBe(2);
 });\n`);
		const { conversation, sourceId } = await f.source();
		const plan = { sourceIds: [sourceId], contract, scope: { root: f.root, inputs: [], disposable: [] }, methods: { a: f.method } };
		const work = await f.service.register(conversation.id, plan, "register", context);
		await writeFile(resolve(dir, "handles.json"), JSON.stringify({ conversationId: conversation.id, sourceId, workId: work.workId }));
		f.arm(conversation.id);
		if (cut === "repair") await f.service.repair(conversation.id, work.workId!, "a", 1, { ...f.method, args: ["./addition.test.ts", "--timeout", "4000"] }, "Explicit test timeout, same scenario", [], "repair-once", context);
		else { await f.run(conversation.id, work.workId!); if (cut === "certificate") await f.service.finish(conversation.id, work.workId!, "finish-once", context); }
		throw new Error(`Crash window not reached: ${cut}`);
	} else {
		const handles = JSON.parse(await readFile(resolve(dir, "handles.json"), "utf8")) as { conversationId: ConversationId; workId: string; sourceId: string };
		await f.service.recover(context);
		f.harness.resume();
		await f.harness.waitForIdle(context);
		const evidence = (await f.harness.snapshot(EvidenceDoc, handles.conversationId, context))?.attempts ?? [];
		// Repeat recovery AFTER the actual check task has become terminal; terminal is not OS quiescence.
		await f.service.recover(context);
		const now = Date.now;
		try {
			Date.now = () => now() + 30 * 24 * 60 * 60 * 1000;
			await f.service.recover(context);
		} finally { Date.now = now; }
		const status = await f.service.status(handles.conversationId, context);
		const before = await f.service.snapshot(handles.conversationId, context);
		if (cut === "repair") await f.service.repair(handles.conversationId, handles.workId, "a", 1, { ...f.method, args: ["./addition.test.ts", "--timeout", "4000"] }, "Replay", [], "repair-once", context);
		let finished: unknown;
		try { finished = await f.service.finish(handles.conversationId, handles.workId, "finish-once", context); } catch (e) { finished = String(e); }
		const ambiguous = ["effect-intent", "command-running", "effect-completed"].includes(cut);
		let overlap: unknown; let disjoint: unknown;
		if (ambiguous) {
			const other = await f.source();
			const plan = { sourceIds: [other.sourceId], contract, scope: { root: f.root, inputs: [], disposable: [] }, methods: { a: f.method } };
			const registered = await f.service.register(other.conversation.id, plan, "overlap", context);
			await f.run(other.conversation.id, registered.workId!);
			let finishError = "";
			try { await f.service.finish(other.conversation.id, registered.workId!, "overlap-finish", context); } catch (e) { finishError = String(e); }
			overlap = { status: await f.service.status(other.conversation.id, context), finishError };
			const separate = resolve(dir, "disjoint"); await mkdir(separate);
			await writeFile(resolve(separate, "addition.test.ts"), 'import {test,expect} from "bun:test"; test("adds",()=>expect(1+1).toBe(2));\n');
			const independent = await f.source(separate);
			const own = await f.service.register(independent.conversation.id, { ...plan, sourceIds: [independent.sourceId], scope: { ...plan.scope, root: separate }, methods: { a: { ...f.method, cwd: separate } } }, "disjoint", context);
			await f.run(independent.conversation.id, own.workId!);
			disjoint = await f.service.finish(independent.conversation.id, own.workId!, "disjoint-finish", context);
		}
		const tasks = await Promise.all(evidence.map(e => f.harness.getTask(Number(e.taskId) as TaskId, context)));
		await writeFile(resolve(dir, "recovered.json"), JSON.stringify({ status, before, after: await f.service.snapshot(handles.conversationId, context), evidence, coord: await f.harness.snapshot(WorkspaceCoordDoc, context), tasks, finished, overlap, disjoint }));
		await f.harness.close(context);
	}
}
