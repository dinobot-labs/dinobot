import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage, type Conversation, type ConversationId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openBot, type Bot } from "../src/core/bot.ts";
import { AsksDoc } from "../src/core/ask.ts";
import { EvolutionJobs } from "../src/core/skills/evolution-jobs.ts";
import { closeSkillRetention, SkillDefaultDoc, SkillPinDoc, SkillRetentionDoc } from "../src/core/skills/manifests.ts";
import { WorkDoc } from "../src/core/verification.ts";
import { AgentsDoc } from "../src/extensions/subagents.ts";
import { TodoDoc } from "../src/extensions/todo.ts";
import { SkillStore } from "../src/core/skills/store.ts";
import { conversationForThread } from "../src/core/threads.ts";
import { withDefaultSkills } from "../src/plugins/skills/index.ts";

const bots: Bot[] = [];
const directories: string[] = [];
const legacyHarnesses: Harness[] = [];
afterEach(async () => {
	for (const harness of legacyHarnesses.splice(0)) await harness.close(context);
	for (const bot of bots.splice(0)) await bot.close(context);
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

test("v1 upgrade activates a new bundled skill while legacy conversations remain usable", async () => {
	// Given a previous install without the newly bundled programming skill.
	const directory = await mkdtemp(join(tmpdir(), "skill-legacy-upgrade-"));
	directories.push(directory);
	const path = join(directory, "bot.sqlite");
	const models = createModels();
	const faux = fauxProvider({ provider: "faux", models: [{ id: "one" }] });
	models.setProvider(faux.provider);
	const packages = (await withDefaultSkills([])).flatMap((plugin) => plugin.skillPackages ?? []);
	const old = await Harness.open(await openNodeSqliteStorage(path), { models, registry: createRegistry() }, context);
	legacyHarnesses.push(old);
	await new SkillStore(old).initialize(packages.filter((pkg) => pkg.name !== "programming"), context);
	const legacy = await conversationForThread(old, models, "test:legacy-upgrade", { provider: "faux", modelId: "one" }, context);
	await old.close(context);
	legacyHarnesses.splice(legacyHarnesses.indexOf(old), 1);
	// When the current bot migrates and imports its new bundled sources.
	const bot = await openBot({
		storage: await openNodeSqliteStorage(path), models, defaultModel: { provider: "faux", modelId: "one" },
		toolMode: "direct", plugins: [],
	}, context);
	bots.push(bot);
	// Legacy conversations no longer block activation (ADR 0037): the new source is live at boot.
	expect((await bot.skills.pending(context)).some((item) => item.name === "programming")).toBe(false);
	expect((await bot.skills.list(context)).some((item) => item.name === "programming")).toBe(true);
	faux.setResponses([fauxAssistantMessage("Legacy work can continue.")]);
	const answer = await bot.handle({ channel: "test", threadKey: "legacy-upgrade", messageId: "continue", userId: "u", text: "continue" }, context);
	// Then commands and normal work remain available to perform explicit migration.
	expect(answer.status).toBe("answered");
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("task", { description: "Legacy child", prompt: "Return a short answer." }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Child finished."),
		fauxAssistantMessage("Parent finished."),
	]);
	expect((await bot.handle({ channel: "test", threadKey: "legacy-upgrade", messageId: "child", userId: "u", text: "delegate" }, context)).status).toBe("answered");
	const child = await onlyChild(bot, legacy);
	expect((await bot.harness.snapshot(SkillPinDoc, child.record.id, context))?.pin).toBeNull();
	// The unpinned legacy conversation keeps its pre-pinning live-catalog behavior.
	expect((await bot.skills.executionList(legacy, context)).some((item) => item.name === "programming")).toBe(true);
	await bot.skills.initialize(packages, context);
	const next = await bot.conversation("test", "after-upgrade", context);
	expect((await bot.skills.executionList(next.id, context)).some((item) => item.name === "programming")).toBe(true);
});

for (const damage of ["missing", "corrupt", "closed"] as const) {
	test(`bot prevents provider dispatch when the conversation pin is ${damage}`, async () => {
		// Given a real bot with a created pin and a counted provider boundary.
		const models = createModels();
		const faux = fauxProvider({ provider: "faux", models: [{ id: "one" }] });
		models.setProvider(faux.provider);
		let calls = 0;
		faux.setResponses([() => { calls++; return fauxAssistantMessage("must not run"); }]);
		const bot = await openBot({
			storage: new MemoryStorage(), models, defaultModel: { provider: "faux", modelId: "one" },
			toolMode: "direct", plugins: [],
		}, context);
		bots.push(bot);
		const conversation = await bot.conversation("test", "integrity", context);
		await bot.harness.commit(async (tx) => {
			const pin = await tx.doc(SkillPinDoc, conversation.id);
			switch (damage) {
				case "missing": pin.pin = null; break;
				case "corrupt":
					if (!pin.pin) throw new Error("Fixture has no pin");
					pin.pin = { ...pin.pin, manifestHash: "0".repeat(64) };
					break;
				case "closed": (await tx.doc(SkillRetentionDoc, conversation.id)).closed = true; break;
			}
		}, context);
		// When a normal user input reaches generation, despite section-error recovery.
		const reply = await bot.handle({
			channel: "test", threadKey: "integrity", messageId: damage,
			userId: "tester", text: "continue",
		}, context);
		// Then the hard request boundary prevents any provider call.
		expect(reply).toMatchObject({ status: "unanswered", reason: "faulted" });
		expect(calls).toBe(0);
	});
}

const fixtureSkill = {
	name: "pin-fixture", description: "Pinned fixture", body: "old body",
	files: { "reference.txt": "old reference" }, source: "fixture:pin-fixture",
};
async function setupProduct(path?: string, sessionPinning = true) {
	const directory = path ? undefined : await mkdtemp(join(tmpdir(), "skill-pin-bot-"));
	if (directory) directories.push(directory);
	const database = path ?? join(directory ?? "", "bot.sqlite");
	const faux = fauxProvider({ api: "faux-skill-pin-product", provider: "faux", models: [{ id: "one" }] });
	const models = createModels();
	models.setProvider(faux.provider);
	const bot = await openBot({
		storage: await openNodeSqliteStorage(database), models,
		defaultModel: { provider: "faux", modelId: "one" }, toolMode: "direct", plugins: [],
		workspaceRoot: process.cwd(), settings: { retry: { enabled: false }, compaction: { enabled: false, keepRecentTokens: 1 } },
		// These fixtures drive the research queue by hand on a fixed logical clock; background review (on by default) is off.
		skillEvolution: { sessionPinning, review: false },
	}, context);
	bots.push(bot);
	if (!path) await bot.skills.initialize([fixtureSkill], context);
	return { bot, faux, path: database };
}
async function closeProduct(bot: Bot) {
	await bot.close(context);
	bots.splice(bots.indexOf(bot), 1);
}
async function publishFixture(bot: Bot) {
	const old = await bot.skills.load(fixtureSkill.name, undefined, context);
	const staged = await bot.skills.propose({
		name: old.name, description: "New fixture", body: "new body",
		files: { "reference.txt": "new reference" }, expectedGeneration: old.generation, requestId: "fixture-proposal",
	}, "owner", context);
	return bot.skills.publish({ proposalId: staged.proposalId, requestId: "fixture-publication" }, "owner", context);
}

test("actual compaction and follow-up preserve the original execution manifest", async () => {
	// Given a pinned conversation that loaded the original fixture before publication.
	const { bot, faux } = await setupProduct();
	const conversation = await bot.conversation("test", "compact", context);
	const before = await bot.skills.executionLoad({ conversationId: conversation.id, name: fixtureSkill.name }, context);
	const pin = await bot.harness.snapshot(SkillPinDoc, conversation.id, context);
	faux.setResponses([loadCall(), fauxAssistantMessage("Loaded fixture.")]);
	await bot.handle({ channel: "test", threadKey: "compact", messageId: "before", userId: "u", text: "load fixture" }, context);
	await publishFixture(bot);
	// When real compaction summarizes the transcript, followed by another model tool call.
	faux.setResponses([fauxAssistantMessage("Summary of fixture work.")]);
	const compacted = await bot.harness.waitForTask(await conversation.compact(undefined, context), context);
	expect(compacted.state.outcome.status).toBe("completed");
	if (compacted.state.outcome.status !== "completed") throw new Error("Compaction failed");
	expect(compacted.state.outcome.result.entryId ?? compacted.state.outcome.result.submissionId).toBeDefined();
	let loaded: ToolResultMessage | undefined;
	faux.setResponses([loadCall(), (request) => {
		loaded = request.messages.filter((message): message is ToolResultMessage => message.role === "toolResult").at(-1);
		return fauxAssistantMessage("Follow-up complete.");
	}]);
	await bot.handle({ channel: "test", threadKey: "compact", messageId: "after", userId: "u", text: "load again" }, context);
	// Then the model still receives original bytes and the pin is unchanged.
	expect(resultValue(loaded)).toMatchObject({ version: before.version, body: before.body, generation: before.generation });
	expect(await bot.harness.snapshot(SkillPinDoc, conversation.id, context)).toEqual(pin);
});

test("resumable legacy conversations do not block publication and never get a fabricated pin", async () => {
	// Given an unpinned resumable conversation created with pinning disabled.
	const setup = await setupProduct(undefined, false);
	const legacy = await setup.bot.conversation("test", "legacy", context);
	expect(await setup.bot.skills.legacyConversations(context)).toEqual([legacy.id]);
	const before = await setup.bot.skills.load(fixtureSkill.name, undefined, context);
	expect(before.body).toBe("old body");
	// When a new source arrives and an approved proposal is published while it is still open.
	const newSource = { name: "new-source", description: "New source", body: "Imported", files: {}, source: "fixture:new-source" };
	await setup.bot.skills.initialize([newSource], context);
	await setup.bot.skills.initialize([newSource], context);
	const published = await publishFixture(setup.bot);
	// Then both activate without operator closure (ADR 0037).
	expect((await setup.bot.skills.pending(context)).some((item) => item.name === newSource.name)).toBe(false);
	expect((await setup.bot.skills.list(context)).some((item) => item.name === newSource.name)).toBe(true);
	expect(published.version).not.toBe(before.version);
	// The legacy conversation keeps its unpinned live-catalog behavior and no pin is fabricated.
	expect((await setup.bot.harness.snapshot(SkillPinDoc, legacy.id, context))?.pin).toBeNull();
	expect((await setup.bot.skills.executionLoad({ conversationId: legacy.id, name: fixtureSkill.name }, context)).body).toBe("new body");
	// Explicit closure still ends it.
	await setup.bot.skills.closeLegacy(String(legacy.id), context);
	await expect(setup.bot.skills.executionLoad({ conversationId: legacy.id, name: fixtureSkill.name }, context)).rejects.toThrow("closed");
});
async function toolResults(conversation: Conversation): Promise<ToolResultMessage[]> {
	const page = await conversation.entries({}, 100, undefined, context);
	return page.items.flatMap((entry) => entry.model ?? []).filter((message): message is ToolResultMessage => message.role === "toolResult");
}
function resultValue(result: ToolResultMessage | undefined): unknown {
	if (!result) throw new Error("Missing fixture tool result");
	expect(result.isError).not.toBe(true);
	return JSON.parse(result.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n"));
}
function loadCall() {
	return fauxAssistantMessage(fauxToolCall("skills_load", { name: fixtureSkill.name }, { id: "fixture-load" }), { stopReason: "toolUse", timestamp: 1 });
}
function readCall(version: string) {
	return fauxAssistantMessage(fauxToolCall("skills_read_file", { name: fixtureSkill.name, version, path: "reference.txt" }, { id: "fixture-read" }), { stopReason: "toolUse", timestamp: 1 });
}
function taskCall() {
	return fauxAssistantMessage(fauxToolCall("task", { description: "Pinned child", prompt: "Load the fixture and its reference" }, { id: "fixture-task" }), { stopReason: "toolUse", timestamp: 1 });
}
async function onlyChild(bot: Bot, parentId: ConversationId) {
	const children = await bot.harness.commit(tx => tx.scanConversations({ ownerConversationId: parentId }, 10), context);
	expect(children.items).toHaveLength(1);
	const record = children.items[0];
	if (!record) throw new Error("Actual task did not create a child conversation");
	const conversation = await bot.harness.conversation(record.id, context);
	if (!conversation) throw new Error("Actual child conversation is missing");
	return { record, conversation };
}
function skillCatalog(messages: readonly Message[]): unknown[] {
	const section = messages.flatMap((message) => message.role === "system" ? [message.sections?.skills ?? ""] : []).join("\n");
	const catalog = section.split("<available_skills>\n")[1]?.split("\n</available_skills>")[0];
	if (catalog === undefined) throw new Error("Provider request has no skill catalog");
	return catalog.split("\n").filter(Boolean).map((line): unknown => {
		const match = /^- ([^:]+): (.*)$/.exec(line);
		if (!match) throw new Error(`Unparsable catalog line: ${line}`);
		return { name: match[1], description: match[2] };
	});
}
async function signaled<T>(promise: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => reject(new Error("Expected provider event did not arrive")), 3_000);
		})]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

for (const publicationMoment of ["before-spawn", "before-late-load"] as const) {
	test(`actual task child keeps parent pin when publication occurs ${publicationMoment}`, async () => {
		// Given a real parent pinned before publication and an event barrier before child tool execution.
		const { bot, faux } = await setupProduct();
		const parent = await bot.conversation("test", "parent", context);
		const old = await bot.skills.load(fixtureSkill.name, undefined, context);
		const parentPin = await bot.harness.snapshot(SkillPinDoc, parent.id, context);
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const childRequests: (readonly Message[])[] = [];
		faux.setResponses([
			taskCall(),
			async (request) => {
				childRequests.push(structuredClone(request.messages));
				started.resolve();
				await release.promise;
				return loadCall();
			},
			(request) => { childRequests.push(structuredClone(request.messages)); return readCall(old.version); },
			fauxAssistantMessage("child complete", { timestamp: 1 }),
			fauxAssistantMessage("parent complete", { timestamp: 1 }),
		]);
		if (publicationMoment === "before-spawn") await publishFixture(bot);
		const submission = await parent.submit({ type: "input", content: "Delegate the pinned fixture" }, context);
		try {
			await signaled(started.promise);
			// When publication crosses an actual child's late-load boundary.
			if (publicationMoment === "before-late-load") await publishFixture(bot);
			const child = await onlyChild(bot, parent.id);
			expect(await bot.harness.snapshot(SkillPinDoc, child.record.id, context)).toEqual(parentPin);
			release.resolve();
			expect((await submission.wait(context)).status).toBe("done");
			// Then execution section, load and companion read all use the old complete package.
			const results = await toolResults(child.conversation);
			expect(resultValue(results.find((result) => result.toolName === "skills_load"))).toMatchObject({ name: old.name, version: old.version, body: old.body, generation: old.generation });
			expect(resultValue(results.find((result) => result.toolName === "skills_read_file"))).toMatchObject({ version: old.version, content: "old reference" });
			for (const request of childRequests) {
				// The catalog lists name and description; the pinned version itself is proven by skills_load above.
				expect(skillCatalog(request)).toContainEqual({ name: old.name, description: old.description.replace(/\s*\n\s*/g, " ") });
			}
			const fresh = await bot.conversation("test", "fresh", context);
			expect((await bot.skills.executionLoad({ conversationId: fresh.id, name: old.name }, context)).body).toBe("new body");
			await bot.harness.commit(tx => closeSkillRetention(tx, parent.id), context);
			expect((await bot.skills.executionLoad({ conversationId: child.record.id, name: old.name }, context)).body).toBe(old.body);
			expect((await bot.harness.snapshot(SkillRetentionDoc, child.record.id, context))?.closed).toBe(false);
		} finally {
			release.resolve();
			await parent.waitForIdle(context);
		}
	}, 10_000);
}

test("SQLite restart with pinning off preserves parent child late loads and new task inheritance", async () => {
	// Given a published new default and an actual task child that inherited its parent's older pin.
	const first = await setupProduct();
	const parent = await first.bot.conversation("test", "restart-parent", context);
	const old = await first.bot.skills.load(fixtureSkill.name, undefined, context);
	const parentPin = await first.bot.harness.snapshot(SkillPinDoc, parent.id, context);
	await publishFixture(first.bot);
	first.faux.setResponses([taskCall(), loadCall(), fauxAssistantMessage("child complete", { timestamp: 1 }), fauxAssistantMessage("parent complete", { timestamp: 1 })]);
	expect((await (await parent.submit({ type: "input", content: "Delegate the pinned fixture" }, context)).wait(context)).status).toBe("done");
	const child = await onlyChild(first.bot, parent.id);
	const publication = (await first.bot.harness.snapshot(SkillDefaultDoc, context))?.publication;
	await closeProduct(first.bot);
	// When both conversations resume with new pin acquisition disabled.
	const second = await setupProduct(first.path, false);
	const resumedParent = await second.bot.conversation("test", "restart-parent", context);
	const resumedChild = await second.bot.harness.conversation(child.record.id, context);
	if (!resumedChild) throw new Error("Restart lost the child conversation");
	second.faux.setResponses([loadCall(), readCall(old.version), fauxAssistantMessage("resumed child complete", { timestamp: 1 })]);
	expect((await (await resumedChild.submit({ type: "input", content: "Read the pinned reference after restart" }, context)).wait(context)).status).toBe("done");
	second.faux.setResponses([taskCall(), loadCall(), fauxAssistantMessage("new child complete", { timestamp: 1 }), fauxAssistantMessage("resumed parent complete", { timestamp: 1 })]);
	expect((await (await resumedParent.submit({ type: "input", content: "Delegate after restart" }, context)).wait(context)).status).toBe("done");
	// Then old execution bytes, parent identity and default generation survive, including a child created with the flag off.
	expect(resumedParent.id).toBe(parent.id);
	expect(await second.bot.harness.snapshot(SkillPinDoc, parent.id, context)).toEqual(parentPin);
	expect(await second.bot.harness.snapshot(SkillPinDoc, child.record.id, context)).toEqual(parentPin);
	const results = await toolResults(resumedChild);
	expect(resultValue(results.findLast((result) => result.toolName === "skills_load"))).toMatchObject({ version: old.version, body: old.body, generation: old.generation });
	expect(resultValue(results.findLast((result) => result.toolName === "skills_read_file"))).toMatchObject({ version: old.version, content: "old reference" });
	const descendants = await second.bot.harness.commit(tx => tx.scanConversations({ ownerConversationId: parent.id }, 10), context);
	expect(descendants.items).toHaveLength(2);
	const newest = descendants.items.find((record) => record.id !== child.record.id);
	if (!newest) throw new Error("Flag-off task did not create its own child");
	expect(await second.bot.harness.snapshot(SkillPinDoc, newest.id, context)).toEqual(parentPin);
	expect((await second.bot.harness.snapshot(SkillRetentionDoc, newest.id, context))?.manifestHash).toBe(parentPin?.pin?.manifestHash ?? "");
	const newestConversation = await second.bot.harness.conversation(newest.id, context);
	if (!newestConversation) throw new Error("New child is missing");
	expect(resultValue((await toolResults(newestConversation)).find((result) => result.toolName === "skills_load"))).toMatchObject({ version: old.version, body: old.body });
	expect((await second.bot.harness.snapshot(SkillDefaultDoc, context))?.publication).toEqual(publication);
	const legacy = await second.bot.conversation("test", "flag-off-new", context);
	expect((await second.bot.harness.snapshot(SkillPinDoc, legacy.id, context))?.pin).toBeNull();
	expect((await second.bot.harness.snapshot(SkillDefaultDoc, context))?.legacyCount).toBe(1);
}, 10_000);

async function mainProjection(bot: Bot, parent: Conversation) {
	return {
		entries: (await parent.entries({}, 100, undefined, context)).items,
		tasks: (await bot.harness.commit(tx => tx.scanTasks({ conversationId: parent.id }, 100), context)).items,
		work: await bot.harness.snapshot(WorkDoc, parent.id, context),
		asks: await bot.harness.snapshot(AsksDoc, parent.id, context),
		todo: await bot.harness.snapshot(TodoDoc, parent.id, context),
		children: await bot.harness.snapshot(AgentsDoc, parent.id, context),
		pin: await bot.harness.snapshot(SkillPinDoc, parent.id, context),
	};
}
async function fixedTape(withResearch: boolean) {
	const { bot, faux } = await setupProduct();
	const parent = await bot.conversation("test", "fixed-tape", context);
	const old = await bot.skills.load(fixtureSkill.name, undefined, context);
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const requests: (readonly Message[])[] = [];
	faux.setResponses([
		async (request) => { requests.push(structuredClone(request.messages)); entered.resolve(); await release.promise; return loadCall(); },
		(request) => { requests.push(structuredClone(request.messages)); return readCall(old.version); },
		(request) => { requests.push(structuredClone(request.messages)); return fauxAssistantMessage("fixed answer", { timestamp: 1 }); },
	]);
	const submission = await parent.submit({ type: "input", content: "Load the fixture and its reference" }, context);
	try {
		await signaled(entered.promise);
		const before = await mainProjection(bot, parent);
		if (withResearch) {
			// Real durable research commands and candidate staging have no main-task linkage or provider calls.
			const jobs = new EvolutionJobs(bot.harness, () => 1_000);
			const budget = { calls: 1, tokens: 100, costMicros: 1_000, timeMs: 1_000, candidates: 1 };
			await jobs.execute({ commandId: "research-init", op: "initialize", policy: { revision: "fixture-v1", maxPending: 1, maxAttempts: 1, leaseMs: 100, cooldownMs: 0, totalBudget: budget, maxJobBudget: budget } }, context);
			await jobs.execute({ commandId: "research-resume", op: "resume" }, context);
			const admission = await jobs.execute({
				commandId: "research-enqueue", op: "enqueue", overflow: "defer",
				input: { evidenceWindow: "fixture-window", evidenceCutoff: 900, problem: "fixture-problem", policyRevision: "fixture-v1", snapshot: old.version, budget, attemptReservation: budget },
			}, context);
			if (!admission.jobId) throw new Error("Research fixture was not admitted");
			await jobs.execute({ commandId: "research-claim", op: "claim", jobId: admission.jobId, worker: "independent-fixture-worker" }, context);
			await bot.skills.propose({
				name: old.name, description: "Research candidate", body: "candidate body",
				files: { "reference.txt": "candidate reference" }, expectedGeneration: old.generation, requestId: "research-candidate",
			}, "research-fixture", context);
			await jobs.execute({ commandId: "research-cancel", op: "cancel", jobId: admission.jobId }, context);
			expect((await jobs.job(admission.jobId, context))?.status).toBe("cancelled");
		}
		expect(await mainProjection(bot, parent)).toEqual(before);
		release.resolve();
		const reply = await submission.wait(context);
		expect(reply.status).toBe("done");
		const results = await toolResults(parent);
		// Only transport timestamps differ; every model-visible field and tool byte is compared.
		return {
			requests: requests.map(messages => messages.map(({ timestamp: _timestamp, ...message }) => message)),
			results: results.map(({ timestamp: _timestamp, ...result }) => result),
		};
	} finally {
		release.resolve();
		await parent.waitForIdle(context);
	}
}
test("fixed model tape and main state remain exact when independent research transitions are inserted", async () => {
	// Given the same user input, skill packages and provider response tape in independent real SQLite bots.
	const baseline = await fixedTape(false);
	// When research queue transitions and candidate staging interleave before main's late load.
	const withResearch = await fixedTape(true);
	// Then all model-visible messages and returned tool bytes are equal, with no main task/ask/todo/transcript writes.
	expect(withResearch).toEqual(baseline);
	expect(withResearch.requests).toHaveLength(3);
}, 10_000);
