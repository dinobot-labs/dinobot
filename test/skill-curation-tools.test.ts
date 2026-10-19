import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { ConversationId, JsonObject } from "@earendil-works/pi-durable";
import { openBot, type Bot } from "../src/core/bot.ts";
import type { ToolMode } from "../src/core/toolmode.ts";
import { EvolutionWorkerDoc } from "../src/core/skills/evolution-service.ts";
import { SkillLifecycleDoc } from "../src/core/skills/retention.ts";
import { SKILL_TOOL_NAMES } from "../src/extensions/skills.ts";

const CURATION_TOOLS = ["skills_archive", "skills_unarchive", "skills_curation_status"] as const;
const bots: Bot[] = [];
const dirs: string[] = [];
afterEach(async () => {
	for (const bot of bots.splice(0)) await bot.close(context);
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function setup(toolMode: ToolMode, curation?: { enabled: boolean }) {
	const dir = await mkdtemp(join(tmpdir(), "dinobot-curation-tools-"));
	dirs.push(dir);
	const models = createModels();
	const faux = fauxProvider({ provider: "faux", models: [{ id: "one" }] });
	models.setProvider(faux.provider);
	const bot = await openBot({ storage: await openNodeSqliteStorage(join(dir, "bot.sqlite")), models, defaultModel: { provider: "faux", modelId: "one" }, toolMode, plugins: [], workspaceRoot: dir, ...(curation ? { curation } : {}) }, context);
	bots.push(bot);
	await bot.curation.run({ dryRun: true }, context);
	const conversation = await bot.conversation("test", "curation", context);
	let counter = 0;
	const offered = new Set<string>();
	async function run(name: string, args: JsonObject) {
		let result: Extract<Message, { role: "toolResult" }> | undefined;
		let system = "";
		const direct = toolMode === "direct";
		faux.setResponses([
			(request) => {
				for (const message of request.messages) {
					if (message.role !== "system") continue;
					system += JSON.stringify(message);
					for (const tool of message.toolsAdded ?? []) offered.add(tool.name);
				}
				return fauxAssistantMessage(fauxToolCall(direct ? name : "codemode", direct ? args : { code: `const r = await tools.${name}(${JSON.stringify(args)}); for (const c of r.content ?? []) if(c.type === 'text') text(c.text); if (r.isError) throw new Error("tool error: " + JSON.stringify(r.content));` }), { stopReason: "toolUse" });
			},
			(request) => { result = request.messages.filter((message) => message.role === "toolResult").at(-1); return fauxAssistantMessage("done"); },
		]);
		await bot.handle({ channel: "test", threadKey: "curation", messageId: `run-${++counter}`, userId: "someone", text: "curate skills" }, context);
		if (!result) throw new Error("No tool result");
		const text = result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
		return { result, text, system, json: () => JSON.parse(text) };
	}
	return { bot, conversation, run, offered };
}
async function createAgentSkill(bot: Bot, name: string) {
	const staged = await bot.skills.propose({ name, description: `Agent workflow ${name}`, body: `Follow ${name}.`, files: {}, expectedGeneration: 0, requestId: `propose-${name}` }, "agent:1", context);
	return bot.skills.publish({ proposalId: staged.proposalId, requestId: `publish-${name}` }, "agent:1", context);
}
async function catalog(bot: Bot, id: ConversationId) {
	return (await bot.skills.executionList(id, context)).map((item) => item.name);
}

test("curation tools are registered skill tools", () => {
	for (const name of CURATION_TOOLS) expect(SKILL_TOOL_NAMES).toContain(name);
});

for (const mode of ["direct", "hybrid", "codemode-only"] as const) {
	test(`${mode}: skills_archive, skills_unarchive and skills_curation_status are reversible and guarded`, async () => {
		const { bot, conversation, run, offered } = await setup(mode);
		await createAgentSkill(bot, "agent-flow");
		const old = await bot.conversation("test", `old-${mode}`, context);
		expect(await catalog(bot, old.id)).toContain("agent-flow");
		const status = await run("skills_curation_status", {});
		expect(status.result.isError).not.toBe(true);
		// Hermes-style authoring guidance and the archive statement are in the skills section.
		expect(status.system).toContain("create or patch a skill (skills_propose) and publish it in the same turn");
		expect(status.system).toContain("Prefer patching an existing agent-created skill over near-duplicates");
		expect(status.system).toContain("Unused agent-created skills are archived automatically from usage metrics; skills_unarchive restores them");
		expect(status.system).toContain("call skills_publish on the resulting proposal right away, with no extra confirmation");
		expect(status.json()).toMatchObject({ config: { threshold: 149 }, archived: [] });
		expect(status.json().skills.find((item: { name: string }) => item.name === "agent-flow")).toMatchObject({ provenance: "agent", lifecycle: "active" });

		const archived = await run("skills_archive", { name: "agent-flow", request_id: "archive-1", reason: "superseded by debugging" });
		expect(archived.result.isError).not.toBe(true);
		const generation = archived.json().generation;
		expect((await bot.harness.snapshot(SkillLifecycleDoc, "agent-flow", context))?.status).toBe("inactive");
		// Exact retry replays the receipt without a second transition.
		const replay = await run("skills_archive", { name: "agent-flow", request_id: "archive-1", reason: "superseded by debugging" });
		expect(replay.result.isError).not.toBe(true);
		expect(replay.json().generation).toBe(generation);
		const fresh = await bot.conversation("test", `fresh-${mode}`, context);
		expect(await catalog(bot, fresh.id)).not.toContain("agent-flow");
		// A conversation pinned before the archive keeps its manifest.
		expect(await catalog(bot, old.id)).toContain("agent-flow");
		expect((await run("skills_curation_status", {})).json().archived).toEqual(["agent-flow"]);

		// Bundled and user skills are not model-archivable: bundled ones can never be disabled; user ones point the owner to the TUI.
		const guarded = await run("skills_archive", { name: "debugging", request_id: "archive-protected", reason: "try" });
		expect(guarded.result.isError).toBe(true);
		expect(guarded.text).toContain("guard");
		expect(guarded.text).toContain("bundled skill debugging is not agent-created");
		expect(guarded.text).toContain("Bundled skills cannot be disabled.");
		expect(guarded.text).not.toContain("/skills archive");
		expect(guarded.text).not.toContain("/skills off");
		expect((await bot.harness.snapshot(SkillLifecycleDoc, "debugging", context))?.status ?? "active").toBe("active");
		const owner = await bot.skills.propose({ name: "owner-flow", description: "Owner workflow", body: "Owner body.", files: {}, expectedGeneration: 0, requestId: "propose-owner" }, "local-owner", context);
		await bot.skills.publish({ proposalId: owner.proposalId, requestId: "publish-owner" }, "local-owner", context);
		const user = await run("skills_archive", { name: "owner-flow", request_id: "archive-user", reason: "unused" });
		expect(user.result.isError).toBe(true);
		expect(user.text).toContain("user skill owner-flow is not agent-created");
		expect(user.text).toContain("/skills off owner-flow");
		expect(user.text).toContain("`/skills` checklist");
		expect(user.text).not.toContain("/skills archive");
		expect(user.text).not.toContain("cannot be disabled");
		expect((await bot.harness.snapshot(SkillLifecycleDoc, "owner-flow", context))?.status ?? "active").toBe("active");
		// skills_unarchive may restore any archived skill, including one the owner archived.
		await bot.curation.archive("owner-flow", { actor: "local-owner", requestId: `owner-archive-${mode}`, reason: "owner archive" }, context);
		const ownerRestored = await run("skills_unarchive", { name: "owner-flow", request_id: "restore-owner" });
		expect(ownerRestored.result.isError).not.toBe(true);
		expect((await bot.harness.snapshot(SkillLifecycleDoc, "owner-flow", context))?.status).toBe("active");

		const restored = await run("skills_unarchive", { name: "agent-flow", request_id: "restore-1" });
		expect(restored.result.isError).not.toBe(true);
		expect(restored.json().generation).toBeGreaterThan(generation);
		// Exact retry of the restore replays its receipt.
		const restoreReplay = await run("skills_unarchive", { name: "agent-flow", request_id: "restore-1" });
		expect(restoreReplay.result.isError).not.toBe(true);
		expect(restoreReplay.json()).toEqual(restored.json());
		const after = await bot.conversation("test", `after-${mode}`, context);
		expect(await catalog(bot, after.id)).toContain("agent-flow");

		if (mode === "codemode-only") for (const name of CURATION_TOOLS) expect(offered.has(name)).toBe(false);
		else for (const name of CURATION_TOOLS) expect(offered.has(name)).toBe(true);

		// Research workers get no curation capability, including read-only status.
		await bot.harness.commit(async (tx) => { (await tx.doc(EvolutionWorkerDoc, conversation.id)).research = true; }, context);
		for (const [name, args] of [["skills_archive", { name: "agent-flow", request_id: "worker-archive", reason: "worker" }], ["skills_unarchive", { name: "agent-flow", request_id: "worker-restore" }], ["skills_curation_status", {}]] as const) {
			const refused = await run(name, args);
			expect(refused.result.isError).toBe(true);
			expect(refused.text).toContain("Research workers have no skill curation capability");
		}
		expect((await bot.harness.snapshot(SkillLifecycleDoc, "agent-flow", context))?.status).toBe("active");
	});
}

test("automatic archive guidance appears only when curation is enabled", async () => {
	const enabled = await setup("direct");
	const on = await enabled.run("skills_curation_status", {});
	expect(on.system).toContain("Unused agent-created skills are archived automatically");
	expect(on.system).toContain("skills_curation_status shows the metrics and archived skills");
	const disabled = await setup("direct", { enabled: false });
	const off = await disabled.run("skills_curation_status", {});
	expect(off.result.isError).not.toBe(true);
	expect(off.json().config.enabled).toBe(false);
	expect(off.system).not.toContain("archived automatically");
	// The explicit tools stay documented.
	expect(off.system).toContain("skills_curation_status shows the metrics and archived skills");
});
