import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { awaitWithContext, BACKGROUND_CONTEXT as context, withAbortSignal } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
	createRegistry, defineDoc, defineExtension, GenerationTask, Harness, hook, MemoryStorage,
	type ConversationId, type DocumentReader, type HarnessOptions, type Storage,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

// This fixture tests the request boundary, not the separately implemented skill resolver.
const Pin = defineDoc<{ integrity: "valid" | "corrupt" | "revoked" }>({
	kind: "test.skill-integrity", version: 1, scope: "conversation", history: "latest", fork: "current",
	initial: () => ({ integrity: "valid" }),
});
class IntegrityError extends Error {
	constructor(readonly reason: "missing" | "corrupt" | "revoked") {
		super(`skill_integrity:${reason}`);
	}
}
const harnesses: Harness[] = [];
const directories: string[] = [];
const bounded = () => withAbortSignal(AbortSignal.timeout(5000), context);

afterEach(async () => {
	for (const harness of harnesses.splice(0)) await harness.close(context);
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function setup(options: Partial<HarnessOptions> = {}, storage: Storage = new MemoryStorage()) {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "one" }], deferred: { pollAfterMs: 0 } });
	faux.setResponses([fauxAssistantMessage("answer"), fauxAssistantMessage("summary")]);
	const models = createModels();
	models.setProvider(faux.provider);
	const checked: ConversationId[] = [];
	const beforeModelRequest = async (target: { conversationId: ConversationId; read: DocumentReader }, callContext: Context) => {
		checked.push(target.conversationId);
		const pin = await target.read.snapshot(Pin, target.conversationId, callContext);
		if (!pin) throw new IntegrityError("missing");
		if (pin.integrity !== "valid") throw new IntegrityError(pin.integrity);
	};
	const harness = await Harness.open(storage, {
		models, registry: createRegistry(), beforeModelRequest,
		settings: { retry: { enabled: false }, compaction: { enabled: false, keepRecentTokens: 1 } },
		...options,
	}, context);
	harnesses.push(harness);
	const conversation = await harness.createConversation({
		ownership: { kind: "ownerless" },
		agent: { model: { provider: "faux", modelId: "one" } },
		init: async (tx, id) => { await tx.doc(Pin, id); },
	}, context);
	return { harness, conversation, faux, checked, beforeModelRequest };
}

test("ordinary section, environment and beforeRequest exceptions do not stop durable generation", async () => {
	// Given the documented unsafe guard locations.
	const registry = createRegistry();
	const reports: unknown[] = [];
	registry.install(defineExtension({
		name: "broken-integrity",
		sections: [{ key: "integrity", render() { throw new IntegrityError("corrupt"); } }],
		hooks: [hook(GenerationTask, { beforeRequest() { throw new IntegrityError("revoked"); } })],
	}));
	const { conversation, faux } = await setup({
		registry, beforeModelRequest() {},
		env() { throw new IntegrityError("missing"); },
		onReport(error) { reports.push(error); },
	});
	// When the actual harness receives input.
	const result = await (await conversation.submit({ type: "input", content: "run" }, context)).wait(bounded());
	// Then these exceptions are reported but the provider still runs.
	expect(result.status).toBe("done");
	expect(faux.state.callCount).toBe(1);
	expect(reports.filter(error => error instanceof IntegrityError)).toHaveLength(3);
});

for (const reason of ["missing", "corrupt", "revoked"] as const) {
	test(`the host request boundary faults ${reason} integrity without a provider call`, async () => {
		// Given a pinned conversation that cannot pass its integrity check.
		const { harness, conversation, faux, checked } = await setup();
		const target = reason === "missing"
			? await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "one" }, extensions: [] } }, context)
			: conversation;
		if (reason !== "missing") await target.commit(async tx => { (await tx.doc(Pin, target.id)).integrity = reason; }, context);
		// When a real generation reaches dispatch, even with no extensions selected.
		const result = await (await target.submit({ type: "input", content: "run" }, context)).wait(bounded());
		// Then the input is explicitly unanswered, not silently sent or retried.
		expect(result).toMatchObject({ status: "unanswered", reason: "faulted", detail: `skill_integrity:${reason}` });
		expect(checked).toEqual([target.id]);
		expect(faux.state.callCount).toBe(0);
	});
}

test("the host guard runs after a swallowed hook failure and sees its committed revocation", async () => {
	// Given a valid pin and a hook that revokes it immediately before dispatch.
	const registry = createRegistry();
	const reports: unknown[] = [];
	let revoke = async () => {};
	registry.install(defineExtension({
		name: "revoke-before-dispatch",
		hooks: [hook(GenerationTask, { async beforeRequest() { await revoke(); throw new IntegrityError("revoked"); } })],
	}));
	const { conversation, faux, checked } = await setup({ registry, onReport: error => { reports.push(error); } });
	revoke = () => conversation.commit(async tx => { (await tx.doc(Pin, conversation.id)).integrity = "revoked"; }, context);
	// When the normal hook exception is swallowed.
	const result = await (await conversation.submit({ type: "input", content: "run" }, context)).wait(bounded());
	// Then the independent host boundary still denies dispatch.
	expect(result.status).toBe("unanswered");
	expect(reports.some(error => error instanceof IntegrityError)).toBe(true);
	expect(checked).toEqual([conversation.id]);
	expect(faux.state.callCount).toBe(0);
});

test("compaction cannot bypass integrity through completeSimple", async () => {
	// Given enough real transcript to compact, followed by a revoked pin.
	const { harness, conversation, faux, checked } = await setup();
	expect((await (await conversation.submit({ type: "input", content: "run" }, context)).wait(bounded())).status).toBe("done");
	await conversation.commit(async tx => { (await tx.doc(Pin, conversation.id)).integrity = "revoked"; }, context);
	// When manual compaction invokes the separate summarization path.
	const result = await harness.waitForTask(await conversation.compact(undefined, context), bounded());
	// Then the original answer is the only provider call.
	expect(result.state.outcome).toMatchObject({ status: "faulted", error: { message: "skill_integrity:revoked" } });
	expect(checked).toEqual([conversation.id, conversation.id]);
	expect(faux.state.callCount).toBe(1);
});

test("deferred polling rechecks integrity without fetching a revoked response", async () => {
	// Given a successful first dispatch that revokes before returning a deferred handle.
	const { conversation, faux, checked } = await setup();
	faux.setResponses([async () => {
		await conversation.commit(async tx => { (await tx.doc(Pin, conversation.id)).integrity = "revoked"; }, context);
		return fauxAssistantMessage("", {
			stopReason: "deferred",
			deferred: { provider: "faux", modelId: "one", api: faux.api, id: "pending", pollAfterMs: 0 },
		});
	}]);
	// When generation moves to its deferred poll phase.
	const result = await (await conversation.submit({ type: "input", content: "run" }, context)).wait(bounded());
	// Then polling cannot bypass the guard.
	expect(result).toMatchObject({ status: "unanswered", reason: "faulted", detail: "skill_integrity:revoked" });
	expect(checked).toEqual([conversation.id, conversation.id]);
	expect(faux.state.callCount).toBe(1);
	expect(faux.state.deferredFetchCount).toBe(0);
});

test("SQLite recovery rechecks a request checkpoint rather than reusing prior approval", async () => {
	// Given a request parked in its ordinary hook, then shut down before dispatch.
	const directory = await mkdtemp(join(tmpdir(), "dinobot-integrity-"));
	directories.push(directory);
	const path = join(directory, "bot.sqlite");
	const entered = Promise.withResolvers<void>();
	const registry = createRegistry();
	registry.install(defineExtension({
		name: "park-before-request",
		hooks: [hook(GenerationTask, {
			async beforeRequest(_request, _api, callContext) {
				const signal = callContext.abortSignal;
				if (!signal) throw new Error("Expected invocation cancellation");
				await new Promise<void>(resolve => {
					signal.addEventListener("abort", () => resolve(), { once: true });
					entered.resolve();
				});
				signal.throwIfAborted();
			},
		})],
	}));
	const first = await setup({ registry }, await openNodeSqliteStorage(path));
	const submission = await first.conversation.submit({ type: "input", content: "run" }, context);
	await awaitWithContext(entered.promise, bounded());
	await first.conversation.commit(async tx => { (await tx.doc(Pin, first.conversation.id)).integrity = "revoked"; }, context);
	await first.harness.close(context);
	harnesses.splice(harnesses.indexOf(first.harness), 1);
	// When the saved request is resumed in a fresh harness.
	const second = await setup({}, await openNodeSqliteStorage(path));
	const resumed = await second.harness.submission(submission.id, context);
	if (!resumed) throw new Error("Missing persisted submission");
	const result = await resumed.wait(bounded());
	// Then recovery faults before any provider call.
	expect(result.status).toBe("unanswered");
	expect(second.checked).toEqual([first.conversation.id]);
	expect(first.faux.state.callCount + second.faux.state.callCount).toBe(0);
});
