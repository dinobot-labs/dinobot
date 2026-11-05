import { expect, test } from "bun:test";
import { Type } from "typebox";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTask, defineTool, Harness, hook, MemoryStorage, ToolTask, type Seq, type StorageWrite, type TaskId } from "@earendil-works/pi-durable";
import { CapabilityTask, CellDoc, InternalCallDoc } from "../src/core/codemode/calls.ts";

class RecordedStorage extends MemoryStorage {
	readonly commits: { writes: readonly StorageWrite[]; seq: Seq }[] = [];
	override async commit(...args: Parameters<MemoryStorage["commit"]>) {
		const [batches, receive, ctx] = args;
		return super.commit(batches, (index, seq) => {
			this.commits.push({ writes: structuredClone(batches[index]!), seq });
			receive(index, seq);
		}, ctx);
	}
	frozenCopy() {
		const copy = new MemoryStorage();
		for (const { writes, seq } of this.commits) copy.prepareCommit(writes, seq).apply();
		return copy;
	}
}

// Negative guard: the crash fence belongs to an interrupted unsafe codemode parent, not to every safe capability.
test("standalone safe capability still replays its durable intent after crash", async () => {
	const entered = Promise.withResolvers<TaskId>();
	const release = Promise.withResolvers<void>();
	let executions = 0;
	const tool = defineTool({ name: "safe_probe", description: "safe recovery guard", replay: "safe", parameters: Type.Object({}),
		execute: async (_args, api) => {
			executions++;
			entered.resolve(api.taskId);
			await release.promise;
			return { output: [{ type: "text", text: "safe result" }] };
		},
	});
	const parent = defineTask<null, { phase: "park" }, null>({
		name: "test.safe-capability-parent", version: 1, initial: () => ({ phase: "park" }),
		phases: { park: async (_task, runtime, ctx) => { await runtime.sleepUntil(Date.now() + 3600000, { phase: "park" }, ctx); } },
		abort: async (_task, runtime, ctx) => { await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx); },
	});
	const registry = createRegistry();
	registry.install(defineExtension({ name: "safe-restart", tools: [tool], tasks: [parent, CapabilityTask] }));
	const faux = fauxProvider({ provider: "faux", models: [{ id: "one" }] });
	const models = createModels(); models.setProvider(faux.provider);
	const storage = new RecordedStorage();
	let harness = await Harness.open(storage, { registry, models }, context);
	let stage = "admit";
	try {
		const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "one" } } });
		const id = await harness.commit(async tx => {
			const owner = await tx.createTask(parent, null, { conversationId: conversation.id, ownership: { kind: "conversation" } });
			const id = await tx.createTask(CapabilityTask, { parent: owner, rootCallId: "safe", ordinal: 1, name: "safe_probe", args: "{}" }, { conversationId: conversation.id, ownership: { kind: "conversation" } });
			(await tx.doc(InternalCallDoc, id)).parent = owner;
			(await tx.doc(CellDoc, conversation.id, String(owner), null)).calls.push({ id, ordinal: 1, name: "safe_probe", status: "pending" });
			return id;
		}, context);
		stage = "enter safe tool";
		expect(await Promise.race([entered.promise, harness.waitForTask(id, context).then(record => { throw new Error("Safe tool did not enter: " + JSON.stringify(record)); })])).toBe(id);
		expect((await harness.getTask(id, context))?.state).toMatchObject({ status: "running", checkpoint: { phase: "execute", replay: "safe" } });
		stage = "freeze";
		const frozen = storage.frozenCopy();
		release.resolve();
		await harness.waitForTask(id, context);
		stage = "close original";
		await harness.close(context);
		stage = "reopen";
		harness = await Harness.open(frozen, { registry, models }, context);
		stage = "recover safe tool";
		const recovered = await harness.waitForTask(id, context);
		expect(recovered.state.outcome.status).toBe("completed");
		expect(executions).toBe(2);
		const receipt = recovered.state.outcome.result;
		if (!receipt || typeof receipt !== "object" || !("json" in receipt) || typeof receipt.json !== "string") throw new Error("Missing safe recovery receipt");
		expect(JSON.parse(receipt.json)).toEqual({ content: [{ type: "text", text: "safe result" }], diagnostics: [] });
		stage = "done";
	} catch (error) {
		console.error("Safe recovery fixture stage:", stage, JSON.stringify(await harness.inspect(context)));
		throw error;
	} finally {
		release.resolve();
		await harness.close(context);
	}
}, 5000);

// Real commits with legacy admission (no abandonOnRestart), frozen while the nested beforeTool hook is active.
test("legacy pre-intent capability is not started when its unsafe codemode parent restarts", async () => {
	const entered = Promise.withResolvers<TaskId>();
	const release = Promise.withResolvers<void>();
	let executions = 0;
	let admissions = 0;
	let recovering = false;
	const parentSettlement = Promise.withResolvers<void>();
	let heldParentSettlements = 0;
	const probe = defineTool({ name: "preintent_probe", description: "safe tool not yet started", replay: "safe", parameters: Type.Object({}),
		execute: async () => { executions++; return { output: [{ type: "text", text: "executed" }] }; },
	});
	const cell = defineTool({ name: "codemode", description: "legacy unsafe cell admission", replay: "unsafe", callers: ["model"], parameters: Type.Object({}),
		execute: async (_args, api, ctx) => {
			admissions++;
			const id = await api.commit(async tx => {
				const id = await tx.createTask(CapabilityTask, { parent: api.taskId, rootCallId: api.callId, ordinal: 1, name: "preintent_probe", args: "{}" }, { ownership: { kind: "task", taskId: api.taskId } });
				(await tx.doc(InternalCallDoc, id)).parent = api.taskId;
				(await tx.doc(CellDoc, api.conversationId, String(api.taskId), null)).calls.push({ id, ordinal: 1, name: "preintent_probe", status: "pending" });
				return id;
			}, ctx);
			await api.waitForTask(id, ctx);
			return { output: [{ type: "text", text: "cell done" }] };
		},
	});
	const registry = createRegistry();
	registry.install(defineExtension({ name: "legacy-preintent", tools: [probe, cell], tasks: [CapabilityTask],
		hooks: [hook(ToolTask, {
			beforeTool: async (call, api) => {
				if (call.name === "preintent_probe") { entered.resolve(api.taskId); await release.promise; }
			},
			afterTool: async (call) => {
				// Hold unsafe-parent settlement until the test observes its child receipt.
				if (recovering && call.name === "codemode") {
					heldParentSettlements++;
					await parentSettlement.promise;
				}
			},
		})],
	}));
	const faux = fauxProvider({ provider: "faux", models: [{ id: "one" }] });
	const models = createModels(); models.setProvider(faux.provider);
	const storage = new RecordedStorage();
	let harness = await Harness.open(storage, { registry, models }, context);
	try {
		const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "one" } } });
		faux.setResponses([fauxAssistantMessage(fauxToolCall("codemode", {}), { stopReason: "toolUse" }), fauxAssistantMessage("original done")]);
		const submission = await conversation.submit({ type: "input", content: "legacy pre-intent" }, context);
		const id = await entered.promise;
		const before = await harness.getTask(id, context);
		expect(before?.state).toMatchObject({ status: "running", checkpoint: { phase: "call" } });
		expect(before?.abandonOnRestart).toBeUndefined();
		expect(executions).toBe(0);
		const frozen = storage.frozenCopy();
		release.resolve();
		await submission.wait(context);
		expect(executions).toBe(1);
		await harness.close(context);
		recovering = true;
		faux.setResponses([fauxAssistantMessage("recovered")]);
		harness = await Harness.open(frozen, { registry, models }, context);
		const recovered = await harness.waitForTask(id, context);
		parentSettlement.resolve();
		await harness.waitForIdle(context);
		expect(heldParentSettlements).toBe(1);
		expect(recovered.state.outcome.status).toBe("failed");
		const receipt = recovered.state.outcome.result;
		if (!receipt || typeof receipt !== "object" || !("json" in receipt) || typeof receipt.json !== "string") throw new Error("Missing pre-intent interruption receipt");
		expect(JSON.parse(receipt.json)).toEqual({ isError: true, content: [{ type: "text", text: "Interrupted cell did not start this tool; it was not retried" }] });
		expect(executions).toBe(1);
		expect(admissions).toBe(1);
		expect((await harness.inspect(context)).tasks).toEqual([]);
	} finally {
		parentSettlement.resolve();
		release.resolve();
		await harness.close(context);
	}
}, 5000);
