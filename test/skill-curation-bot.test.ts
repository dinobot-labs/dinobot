import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openBot, type Bot } from "../src/core/bot.ts";
import { SkillCurationDoc, SkillExposureDoc, SkillUseDoc, type SkillCurationOptions } from "../src/core/skills/curation.ts";
import { EvolutionWorkerDoc } from "../src/core/skills/evolution-service.ts";
import { SkillDefaultDoc } from "../src/core/skills/manifests.ts";
import { SkillLifecycleDoc } from "../src/core/skills/retention.ts";

const DAY = 86_400_000;
const bots: Bot[] = [];
const directories: string[] = [];
afterEach(async () => {
	for (const bot of bots.splice(0)) await bot.close(context);
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function setup(curation: SkillCurationOptions = {}) {
	const directory = await mkdtemp(join(tmpdir(), "skill-curation-bot-"));
	directories.push(directory);
	const faux = fauxProvider({ api: "faux-skill-curation", provider: "faux", models: [{ id: "one" }] });
	const models = createModels();
	models.setProvider(faux.provider);
	const clock = { value: 1_000 * DAY };
	const logs: string[] = [];
	const bot = await openBot({
		storage: await openNodeSqliteStorage(join(directory, "bot.sqlite")), models,
		defaultModel: { provider: "faux", modelId: "one" }, toolMode: "direct", plugins: [],
		workspaceRoot: process.cwd(), settings: { retry: { enabled: false }, compaction: { enabled: false, keepRecentTokens: 1 } },
		curation: { ...curation, now: () => clock.value, log: (message) => logs.push(message) },
	}, context);
	bots.push(bot);
	// Let the startup run settle so later runs observe deterministic state.
	await bot.curation.run({ dryRun: true }, context);
	return { bot, faux, clock, logs };
}
async function createAgentSkill(bot: Bot, name: string) {
	const staged = await bot.skills.propose({
		name, description: `Agent workflow ${name}`, body: `Follow the ${name} workflow.`, files: {},
		expectedGeneration: 0, requestId: `propose-${name}`,
	}, "agent:1", context);
	return bot.skills.publish({ proposalId: staged.proposalId, requestId: `publish-${name}` }, "agent:1", context);
}
/** Cheap root conversations: one transaction, the real conversationCreated hook (pin + exposure). */
async function createRoots(bot: Bot, count: number): Promise<ConversationId[]> {
	return bot.harness.commit(async (tx) => {
		const ids: ConversationId[] = [];
		for (let i = 0; i < count; i++) ids.push((await tx.createConversation({ ownership: { kind: "ownerless" } })).id);
		return ids;
	}, context);
}
async function catalog(bot: Bot, id: ConversationId): Promise<string[]> {
	return (await bot.skills.executionList(id, context)).map(item => item.name);
}
function reported(report: Awaited<ReturnType<Bot["curation"]["run"]>>, name: string) {
	const item = report.skills.find(entry => entry.name === name);
	if (!item) throw new Error(`No report for ${name}`);
	return item;
}

test("curator archives an unused agent skill after L* settled root exposures and restore re-adds it", async () => {
	const { bot, clock, logs } = await setup();
	const published = await createAgentSkill(bot, "unused-flow");
	const record = await bot.harness.snapshot(SkillCurationDoc, "unused-flow", context);
	const generation = (await bot.harness.snapshot(SkillDefaultDoc, context))?.publication?.generation;
	// Activation mark: same tx as the publication.
	expect(record).toMatchObject({ activationGeneration: generation, activatedAt: clock.value, state: "active", head: published.version });
	const old = await bot.conversation("test", "old", context);
	expect(await bot.harness.snapshot(SkillExposureDoc, old.id, context)).toEqual({ createdAt: clock.value, root: true });
	expect(await catalog(bot, old.id)).toContain("unused-flow");
	const threshold = bot.curation.threshold;
	expect(threshold).toBe(149);
	await createRoots(bot, threshold - 2);
	clock.value += 14 * DAY + 3_600_000;
	// L*-1 exposures: stale, not archived, even though idle is long enough.
	const first = await bot.curation.run({}, context);
	expect(reported(first, "unused-flow")).toMatchObject({ action: "none", run: threshold - 1, exposures: threshold - 1, uses: 0, state: "stale" });
	expect(reported(first, "programming")).toMatchObject({ provenance: "bundled", action: "exempt" });
	// One more root that is not yet settled does not count.
	await createRoots(bot, 1);
	expect(reported(await bot.curation.run({}, context), "unused-flow")).toMatchObject({ action: "none", run: threshold - 1 });
	clock.value += 3_600_000;
	const dry = await bot.curation.run({ dryRun: true }, context);
	expect(reported(dry, "unused-flow")).toMatchObject({ action: "archive", run: threshold });
	expect((await bot.harness.snapshot(SkillLifecycleDoc, "unused-flow", context))?.status ?? "active").toBe("active");
	const archived = await bot.curation.run({}, context);
	expect(reported(archived, "unused-flow")).toMatchObject({ action: "archive", state: "archived", run: threshold });
	expect(logs).toEqual([]);
	expect((await bot.harness.snapshot(SkillLifecycleDoc, "unused-flow", context))?.status).toBe("inactive");
	const status = await bot.curation.status(context);
	expect(status.archived).toEqual(["unused-flow"]);
	expect(status.lastReport?.run).toBe(archived.run);
	expect(status.skills.find(item => item.name === "unused-flow")).toMatchObject({ provenance: "agent", state: "archived", lifecycle: "inactive" });
	// Then a NEW conversation no longer sees it, while the old pinned conversation still loads it.
	const fresh = await bot.conversation("test", "fresh", context);
	expect(await catalog(bot, fresh.id)).not.toContain("unused-flow");
	expect(await catalog(bot, old.id)).toContain("unused-flow");
	const loaded = await bot.skills.executionLoad({ conversationId: old.id, name: "unused-flow" }, context);
	expect(loaded.version).toBe(published.version);
	expect((await bot.harness.snapshot(SkillUseDoc, old.id, context))?.uses["unused-flow"]).toMatchObject({ count: 1, lastAt: clock.value, version: published.version });
	// A later run reports it archived and does not try again.
	expect(reported(await bot.curation.run({}, context), "unused-flow")).toMatchObject({ action: "archived", state: "archived" });
	// When restored, it re-enters the default with a fresh activation mark.
	const restored = await bot.curation.restore("unused-flow", { actor: "owner", requestId: "restore-unused-flow" }, context);
	expect(await bot.harness.snapshot(SkillCurationDoc, "unused-flow", context)).toMatchObject({ activationGeneration: restored.generation, state: "active", archivedAt: null });
	const after = await bot.conversation("test", "after-restore", context);
	expect(await catalog(bot, after.id)).toContain("unused-flow");
	// Restore resets R: earlier roots are not exposures of the new activation.
	clock.value += 15 * DAY;
	expect(reported(await bot.curation.run({}, context), "unused-flow")).toMatchObject({ action: "none", run: 1, exposures: 1 });
});

test("child uses, worker exclusion, pins and protected skills on a real bot", async () => {
	// alpha 0.25, pMax 0.5 => L* = 2; no idle/settle bound so exposures alone decide.
	const { bot, faux, clock } = await setup({ alpha: 0.25, pMax: 0.5, minIdleMs: 0, settleMs: 0, includeBundled: true });
	expect(bot.curation.threshold).toBe(2);
	await createAgentSkill(bot, "child-flow");
	await createAgentSkill(bot, "pinned-flow");
	await bot.curation.pin("pinned-flow", true, context);
	// Root A delegates; its child loads the skill through the real skills_load tool.
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("task", { description: "Child", prompt: "Load child-flow." }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("skills_load", { name: "child-flow" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Child finished."),
		fauxAssistantMessage("Parent finished."),
	]);
	expect((await bot.handle({ channel: "test", threadKey: "a", messageId: "a1", userId: "u", text: "delegate" }, context)).status).toBe("answered");
	const parent = await bot.conversation("test", "a", context);
	const children = await bot.harness.commit(tx => tx.scanConversations({ ownerConversationId: parent.id }, 10), context);
	expect(children.items).toHaveLength(1);
	const child = children.items[0]!;
	expect(await bot.harness.snapshot(SkillExposureDoc, child.id, context)).toMatchObject({ root: false });
	expect((await bot.harness.snapshot(SkillUseDoc, child.id, context))?.uses["child-flow"]?.count).toBe(1);
	// One root after A, plus an evolution worker conversation that must not count.
	await createRoots(bot, 1);
	const [worker] = await createRoots(bot, 1);
	await bot.harness.commit(async tx => { await tx.doc(EvolutionWorkerDoc, worker!); }, context);
	const first = await bot.curation.run({}, context);
	// Without attribution of the child's use to root A, R would be 3 and the skill archived.
	expect(reported(first, "child-flow")).toMatchObject({ action: "none", run: 1, uses: 1 });
	expect(reported(first, "pinned-flow")).toMatchObject({ action: "exempt", reason: "pinned" });
	// Protected bundled skills are refused by the retention guard and recorded, not retried in a loop.
	expect(reported(first, "programming")).toMatchObject({ action: "refused" });
	await createRoots(bot, 1);
	const second = await bot.curation.run({}, context);
	expect(reported(second, "child-flow")).toMatchObject({ action: "archive", run: 2, state: "archived" });
	expect(reported(second, "pinned-flow").action).toBe("exempt");
	// Unpin resets the run: earlier roots are no longer exposures.
	clock.value += 1;
	await bot.curation.pin("pinned-flow", false, context);
	expect(reported(await bot.curation.run({ dryRun: true }, context), "pinned-flow")).toMatchObject({ action: "none", run: 0 });
	// An edit (new head) re-marks activation and resets exposures for an active skill.
	const before = await bot.skills.load("pinned-flow", undefined, context);
	clock.value += 1;
	await createRoots(bot, 2);
	expect(reported(await bot.curation.run({ dryRun: true }, context), "pinned-flow")).toMatchObject({ action: "archive", run: 2 });
	const staged = await bot.skills.propose({ name: "pinned-flow", description: "Edited", body: "Edited body", files: {}, expectedGeneration: before.generation, requestId: "edit-pinned" }, "agent:1", context);
	await bot.skills.publish({ proposalId: staged.proposalId, requestId: "publish-edit-pinned" }, "agent:1", context);
	expect(reported(await bot.curation.run({ dryRun: true }, context), "pinned-flow")).toMatchObject({ action: "none", run: 0 });
});

test("use recording is fail-open and curation can be disabled", async () => {
	const { bot } = await setup({ enabled: false });
	await createAgentSkill(bot, "fail-open");
	const conversation = await bot.conversation("test", "fail-open", context);
	// Exceeding the bound or a failing write never fails the load.
	await bot.harness.commit(async tx => {
		const doc = await tx.doc(SkillUseDoc, conversation.id);
		for (let i = 0; i < 256; i++) doc.uses[`name-${i}`] = { count: 1, firstAt: 0, lastAt: 0, version: "x" };
	}, context);
	expect((await bot.skills.executionLoad({ conversationId: conversation.id, name: "fail-open" }, context)).name).toBe("fail-open");
	expect((await bot.harness.snapshot(SkillUseDoc, conversation.id, context))?.uses["fail-open"]).toBeUndefined();
	// A failing usage commit (the one after the resolving commit) is swallowed.
	const harness = bot.harness as unknown as { commit: (...args: unknown[]) => Promise<unknown> };
	const original = harness.commit;
	let calls = 0;
	harness.commit = (...args: unknown[]) => ++calls === 2 ? Promise.reject(new Error("usage store down")) : original.apply(bot.harness, args);
	try {
		expect((await bot.skills.executionLoad({ conversationId: conversation.id, name: "fail-open" }, context)).name).toBe("fail-open");
	} finally {
		harness.commit = original;
	}
	expect(calls).toBe(2);
	expect((await bot.curation.status(context)).config.enabled).toBe(false);
});
