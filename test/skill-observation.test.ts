import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	createRegistry, createSession, defineExtension, hook, Harness, ToolTask,
	type Conversation, type Extension, type JsonObject,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { SkillStore, SkillsDoc } from "../src/core/skills/store.ts";
import { bootstrapSkillManifest, classifyLegacySkillConversations, skillConversationCreated } from "../src/core/skills/manifests.ts";
import {
	SkillObservationDoc, SkillObservationProjector, SkillObservationSourceDoc,
	type SkillObservationLimits,
} from "../src/core/skills/observation.ts";
import { skillsExtension } from "../src/extensions/skills.ts";
import { toolExtensions, type ToolMode } from "../src/core/toolmode.ts";
import { CellDoc } from "../src/core/codemode/calls.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const limits: SkillObservationLimits = { maxObservations: 64, maxBytes: 64 * 1024, pageSize: 2 };
async function directory() {
	const dir = await mkdtemp(join(tmpdir(), "skill-observation-"));
	cleanup.push(() => rm(dir, { recursive: true, force: true }));
	return join(dir, "state.sqlite");
}
async function open(path: string, mode: ToolMode, extra: Extension[] = []) {
	const models = createModels();
	const faux = fauxProvider({ provider: "faux", models: [{ id: "one" }] });
	models.setProvider(faux.provider);
	const registry = createRegistry();
	let store: SkillStore | undefined;
	let current: Harness | undefined;
	const extensions = [
		skillsExtension(() => {
			if (!store) throw new Error("Store not open");
			return store;
		}),
		...toolExtensions(mode, [], () => {
			if (!current) throw new Error("Harness not open");
			return current;
		}), ...extra,
	];
	for (const extension of extensions) registry.install(extension);
	const storage = await openNodeSqliteStorage(path);
	const observationStorage = await openNodeSqliteStorage(`${path}.observations`);
	const observations = createSession(observationStorage);
	let observationsClosed = false;
	const closeObservations = async () => {
		if (!observationsClosed) { observationsClosed = true; await observations.close(context); }
	};
	cleanup.push(closeObservations);
	const harness = await Harness.open(storage, {
		models, registry,
		conversationCreated: (tx, record) => skillConversationCreated(tx, record, true),
		env: () => new NodeExecutionEnv({ cwd: import.meta.dir }),
	}, context);
	current = harness;
	store = new SkillStore(harness, { managedManifests: true });
	let closed = false;
	const close = async () => {
		if (!closed) { closed = true; await harness.close(context); }
		await closeObservations();
	};
	cleanup.push(close);
	async function initialize() {
		await harness.commit(classifyLegacySkillConversations, context);
		await harness.commit(tx => bootstrapSkillManifest(tx, "observation-test"), context);
		await store?.initialize([{
			name: "example", description: "Example", body: "Real skill instructions",
			source: "bundled:example", files: { "guide.txt": "Real companion bytes" },
		}], context);
		return harness.createConversation({
			ownership: { kind: "ownerless" },
			agent: { model: { provider: "faux", modelId: "one" }, extensions },
		}, context);
	}
	function responses(name: string, args: JsonObject, emit = true) {
		let receipt: Extract<Message, { role: "toolResult" }> | undefined;
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall(mode === "direct" ? name : "codemode", mode === "direct" ? args : {
				code: `const result = await tools.${name}(${JSON.stringify(args)}); ${emit ? "for (const block of result.content ?? []) if (block.type === 'text') text(block.text);" : "text('outer result deliberately has no skill bytes');"}`,
			}), { stopReason: "toolUse" }),
			(request) => {
				receipt = request.messages.filter((message) => message.role === "toolResult").at(-1);
				return fauxAssistantMessage("Main answer unchanged");
			},
		]);
		return () => {
			if (!receipt) throw new Error("Missing real tool receipt");
			return receipt;
		};
	}
	async function run(conversation: Conversation, name: string, args: JsonObject, emit = true) {
		const receipt = responses(name, args, emit);
		const submission = await conversation.submit({ type: "input", content: "Use skill" }, context);
		const settled = await submission.wait(context);
		await conversation.waitForIdle(context);
		expect(settled.status).toBe("done");
		return receipt();
	}
	return { harness, observations, observationStorage, closeObservations, initialize, close, run, responses };
}
function projector(runtime: Awaited<ReturnType<typeof open>>, policy = limits) {
	return new SkillObservationProjector({ source: runtime.harness, observations: runtime.observations, limits: policy });
}
function snapshot(runtime: Awaited<ReturnType<typeof open>>, _conversation: Conversation) {
	return runtime.observations.snapshot(SkillObservationDoc, context);
}
async function catchAll(projector: SkillObservationProjector, conversation: Conversation) {
	// Explicit bounded catch-up work, not a wait/poll for external state.
	for (let page = 0; page < 100; page++) {
		const result = await projector.catchUp(conversation.id, context);
		if (!result.ok) throw new Error(result.error);
		if (result.sources.direct.caughtUp && result.sources.codemode.caughtUp) return result;
	}
	throw new Error("Projector did not exhaust the bounded fixture");
}
function json(receipt: Extract<Message, { role: "toolResult" }>): unknown {
	const text = receipt.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
	return JSON.parse(text);
}
function version(value: unknown): string {
	if (typeof value !== "object" || value === null || !("version" in value) || typeof value.version !== "string")
		throw new Error("Missing version");
	return value.version;
}

for (const mode of ["direct", "hybrid", "codemode-only"] as const) {
	test(`${mode}: real skill receipts, read_file distinction, bounded restart dedupe`, async () => {
		const path = await directory();
		const first = await open(path, mode);
		const conversation = await first.initialize();
		const loaded = await first.run(conversation, "skills_load", { name: "example" });
		const hash = version(json(loaded));
		await first.run(conversation, "skills_read_file", { name: "example", version: hash, path: "guide.txt" });
		await first.run(conversation, "skills_load", { name: "missing" });
		await first.run(conversation, "skills_read_file", { name: "example", version: hash, path: "missing.txt" });
		await first.run(conversation, "skills_list", {});
		expect(await snapshot(first, conversation)).toBeUndefined();
		const skillsBefore = await first.harness.snapshot(SkillsDoc, context);
		const smallPages = { ...limits, pageSize: 1 };
		const firstProjector = projector(first, smallPages);
		const partial = await firstProjector.catchUp(conversation.id, context);
		expect(partial.ok).toBe(true);
		if (!partial.ok) throw new Error(partial.error);
		expect(partial.sources[mode === "direct" ? "direct" : "codemode"].caughtUp).toBe(false);
		expect(await first.harness.snapshot(SkillsDoc, context)).toEqual(skillsBefore);
		await first.close();

		const second = await open(path, mode);
		const restored = await second.harness.conversation(conversation.id, context);
		if (!restored) throw new Error("Conversation missing after SQLite restart");
		const restarted = projector(second, smallPages);
		const coverage = await catchAll(restarted, restored);
		const store = await snapshot(second, restored);
		const observations = store?.observations ?? [];
		expect(observations.map((observation) => observation.kind)).toEqual([
			"load_attempt", "load_succeeded", "companion_read",
			"load_attempt", "load_failed", "companion_read",
		]);
		expect(observations.filter((observation) => observation.kind === "companion_read").map((observation) => observation.outcome)).toEqual(["succeeded", "failed"]);
		expect(new Set(observations.map((observation) => observation.id)).size).toBe(6);
		expect(new Set(observations.map((observation) => observation.invocationId)).size).toBe(4);
		const source = mode === "direct" ? "direct" : "codemode";
		expect(coverage.sources[source]).toMatchObject({ collected: 6, dropped: 0, unknown: 0 });
		expect(coverage.sources[source === "direct" ? "codemode" : "direct"].collected).toBe(0);
		expect(coverage.catalogRendered).toBe("unknown");
		await catchAll(restarted, restored);
		expect(await snapshot(second, restored)).toEqual(store);
		// Same tool arguments are a fresh invocation, not a retry of the old receipt.
		await second.run(restored, "skills_load", { name: "example" }, false);
		await catchAll(restarted, restored);
		expect((await snapshot(second, restored))?.observations).toHaveLength(8);
	});
}

test("full observation storage drops admission durably without changing main results", async () => {
	const path = await directory();
	const first = await open(path, "direct");
	const conversation = await first.initialize();
	const loaded = await first.run(conversation, "skills_load", { name: "example" });
	const before = JSON.stringify(loaded);
	const bounded = { ...limits, maxObservations: 1 };
	const firstProjector = projector(first, bounded);
	const result = await catchAll(firstProjector, conversation);
	expect(result.sources.direct).toMatchObject({ collected: 1, dropped: 1, unknown: 0 });
	expect(JSON.stringify(loaded)).toBe(before);
	await first.close();
	const second = await open(path, "direct");
	const restored = await second.harness.conversation(conversation.id, context);
	if (!restored) throw new Error("Missing conversation");
	await second.run(restored, "skills_load", { name: "example" });
	const final = await catchAll(projector(second, bounded), restored);
	expect(final.sources.direct).toMatchObject({ collected: 1, dropped: 3, unknown: 0 });
	expect((await snapshot(second, restored))?.observations).toHaveLength(1);
});

test("SQLite projector commit failure isolates main and reopens observation watermark", async () => {
	const path = await directory();
	const runtime = await open(path, "direct");
	const conversation = await runtime.initialize();
	const main = await runtime.run(conversation, "skills_load", { name: "example" });
	const original = JSON.stringify(main);
	const failure = spyOn(runtime.observationStorage, "commit").mockImplementationOnce(async () => { throw new Error("SQLITE_FULL observation storage"); });
	const failedProjector = projector(runtime);
	try {
		expect(await failedProjector.catchUp(conversation.id, context)).toEqual({ ok: false, error: "SQLITE_FULL observation storage" });
	} finally { failure.mockRestore(); }
	expect(JSON.stringify(main)).toBe(original);
	// Main keeps executing even though pi-durable poisoned the observation Session.
	const nextMain = await runtime.run(conversation, "skills_load", { name: "example" });
	expect(json(nextMain)).toEqual(json(main));
	await runtime.closeObservations();
	const reopened = createSession(await openNodeSqliteStorage(`${path}.observations`));
	cleanup.push(() => reopened.close(context));
	expect(await reopened.snapshot(SkillObservationDoc, context)).toBeUndefined();
	expect(await reopened.snapshot(SkillObservationSourceDoc, `${conversation.id}:direct`, context)).toBeUndefined();
	const recovered = await catchAll(new SkillObservationProjector({
		source: runtime.harness, observations: reopened, limits,
	}), conversation);
	expect(recovered.sources.direct).toMatchObject({ collected: 4, dropped: 0, unknown: 0 });
});

test("codemode missing or partial internal results stay unknown despite successful outer result", async () => {
	const runtime = await open(await directory(), "codemode-only");
	const conversation = await runtime.initialize();
	await runtime.run(conversation, "skills_load", { name: "example" }, false);
	await runtime.run(conversation, "skills_load", { name: "example" }, false);
	const page = await runtime.harness.commit(tx => tx.scanTasks({ conversationId: conversation.id, kind: ToolTask.definition.name }, 100), context);
	await runtime.harness.commit(async (tx) => {
		for (const [index, task] of page.items.entries()) {
			const cell = await tx.doc(CellDoc, conversation.id, String(task.id), null);
			const call = cell.calls[0];
			if (!call) throw new Error("Missing actual internal receipt");
			if (index === 0) delete call.result;
			else call.result = '{"content":[{"type":"text","text":"truncated';
		}
	}, context);
	const coverage = await catchAll(projector(runtime), conversation);
	expect(coverage.sources.codemode).toMatchObject({ collected: 2, unknown: 2, dropped: 0 });
	expect(coverage.sources.direct.collected).toBe(0);
	expect((await snapshot(runtime, conversation))?.observations.map((item) => item.kind)).toEqual(["load_attempt", "load_attempt"]);
});

test("live invocation attempt resumes without duplicate after completion and SQLite restart", async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const held = defineExtension({
		name: "observation-hold",
		hooks: [hook(ToolTask, { afterTool: async (call) => {
			if (call.name === "skills_load") { entered.resolve(); await release.promise; }
			return undefined;
		} })],
	});
	const path = await directory();
	const first = await open(path, "direct", [held]);
	const conversation = await first.initialize();
	first.responses("skills_load", { name: "example" });
	const submission = await conversation.submit({ type: "input", content: "Use skill" }, context);
	const timer = setTimeout(() => entered.reject(new Error("Tool did not reach exact afterTool event")), 4000);
	try {
		await entered.promise;
		const firstProjector = projector(first);
		const pending = await firstProjector.catchUp(conversation.id, context);
		expect(pending.ok).toBe(true);
		if (!pending.ok) throw new Error(pending.error);
		expect(pending.sources.direct).toMatchObject({ collected: 1, watermark: 0, caughtUp: false });
		expect(pending.sources.direct.pendingInvocation).not.toBeNull();
		await firstProjector.catchUp(conversation.id, context);
		expect((await snapshot(first, conversation))?.observations).toHaveLength(1);
	} finally {
		clearTimeout(timer);
		release.resolve();
	}
	await submission.wait(context);
	await conversation.waitForIdle(context);
	await first.close();
	const second = await open(path, "direct", [held]);
	const restored = await second.harness.conversation(conversation.id, context);
	if (!restored) throw new Error("Conversation missing");
	const final = await catchAll(projector(second), restored);
	expect(final.sources.direct).toMatchObject({ collected: 2, unknown: 0, pendingInvocation: null });
	expect((await snapshot(second, restored))?.observations.map((item) => item.kind)).toEqual(["load_attempt", "load_succeeded"]);
});

test("metadata byte budget is independent from observation count", async () => {
	const runtime = await open(await directory(), "direct");
	const conversation = await runtime.initialize();
	await runtime.run(conversation, "skills_load", { name: "example" });
	const coverage = await catchAll(projector(runtime, { ...limits, maxBytes: 1 }), conversation);
	expect(coverage.sources.direct).toMatchObject({ collected: 0, dropped: 2, unknown: 0 });
	expect((await snapshot(runtime, conversation))?.bytes).toBe(0);
});

test("observation event capacity is global while watermarks remain per conversation", async () => {
	const runtime = await open(await directory(), "direct");
	const first = await runtime.initialize();
	const second = await runtime.initialize();
	await runtime.run(first, "skills_load", { name: "example" });
	await runtime.run(second, "skills_load", { name: "example" });
	const bounded = projector(runtime, { ...limits, maxObservations: 2 });
	expect((await catchAll(bounded, first)).sources.direct).toMatchObject({ collected: 2, dropped: 0 });
	expect((await catchAll(bounded, second)).sources.direct).toMatchObject({ collected: 0, dropped: 2 });
	const firstState = await runtime.observations.snapshot(SkillObservationSourceDoc, `${first.id}:direct`, context);
	const secondState = await runtime.observations.snapshot(SkillObservationSourceDoc, `${second.id}:direct`, context);
	expect(firstState?.watermark).not.toBe(secondState?.watermark);
	expect((await snapshot(runtime, first))?.observations).toHaveLength(2);
});
