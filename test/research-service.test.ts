import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage, type TaskId, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { type Bot, openBot } from "../src/core/bot.ts";
import { type Contract, ResearchDoc } from "../src/core/research.ts";
import { researchExtension, researchToolView } from "../src/extensions/research.ts";
const context = BACKGROUND_CONTEXT;
const bots: Bot[] = [], roots: string[] = [];
afterEach(async () => {
	for (const bot of bots.splice(0)) await bot.close(context);
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
function contract(): Contract {
	return {
		question: "Does K hold?",
		hypotheses: ["K holds"],
		requirements: [{ id: "K", mandatory: true }],
		scope: "fixture",
		exclusions: [],
		mode: "evidence",
		baseline: { definition: "No observations yet", artifactHash: "untrusted-author-hash" },
		evaluator: { profile: "untrusted", revision: "untrusted", environmentFingerprint: "untrusted", inputFingerprint: "untrusted" },
		policy: { kind: "qualitative", maxNoProgressRounds: 1, maxDebugChildren: 1, confirmation: "required-once" },
		reportAuthorityRef: "none",
	};
}
async function setup() {
	const root = await mkdtemp(join(tmpdir(), "research-service-"));
	roots.push(root);
	const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
	faux.setResponses(Array.from({ length: 80 }, () => fauxAssistantMessage("malformed reviewer")));
	const models = createModels();
	models.setProvider(faux.provider);
	const bot = await openBot({
		storage: new MemoryStorage(),
		models,
		defaultModel: { provider: "faux", modelId: "m" },
		workspaceRoot: root,
		toolMode: "direct",
		plugins: [],
		settings: { retry: { enabled: false } },
	}, context);
	bots.push(bot);
	const parent = await bot.conversation("test", "service", context);
	const api = {
		conversationId: parent.id,
		taskId: 10001 as TaskId<string>,
		callId: "call",
		agent: parent.agent.bind(parent),
		env: undefined,
		commit: bot.harness.commit.bind(bot.harness),
	} as unknown as ToolExecutionApi;
	return { bot, parent, api, root };
}
describe("research service boundary", () => {
	test("host binds hashes/root and no-write creates no project directory", async () => {
		const { bot, parent, api, root } = await setup();
		const started = await bot.research.start({ contract: contract() }, api, context);
		const m = started.mission!;
		expect(m.projectRoot).toBe(root);
		expect(m.contract.baseline.artifactHash).not.toBe("untrusted-author-hash");
		expect(m.contract.evaluator.profile).toBe("evidence-review-v1");
		await bot.harness.waitForTask(Number(m.controllerTaskId) as TaskId<string>, context);
		expect(await readdir(root)).not.toContain(".dinobot");
		await expect(bot.research.readReport(parent.id, m.id, "report.md", context)).rejects.toThrow("no project reports");
	});
	test("same calling identity cannot create duplicate missions or change contract", async () => {
		const { bot, parent, api } = await setup();
		const args = { contract: contract() };
		const first = await bot.research.start(args, api, context);
		const second = await bot.research.start(args, api, context);
		expect(first.mission!.id).toBe(second.mission!.id);
		expect((await bot.harness.snapshot(ResearchDoc, parent.id, context))!.missions).toHaveLength(1);
		args.contract.question = "Changed question";
		await expect(bot.research.start(args, api, context)).rejects.toThrow("replay mismatch");
	});
	test("model-only commands and mismatched host profiles reject before state or effects", async () => {
		const { bot, parent, api, root } = await setup();
		const c = contract();
		c.mode = "trusted-local-code";
		c.codeAuthorityRef = "model:please-trust";
		await expect(bot.research.start({ contract: c }, api, context)).rejects.toThrow("host-authorized");
		expect((await bot.harness.snapshot(ResearchDoc, parent.id, context))?.missions ?? []).toEqual([]);
		expect(await readdir(root)).not.toContain(".dinobot");
	});
	test("status is observational and cannot spawn work or revise a mission", async () => {
		const { bot, parent, api } = await setup();
		const started = await bot.research.start({ contract: contract() }, api, context);
		await bot.harness.waitForTask(Number(started.mission!.controllerTaskId) as TaskId<string>, context);
		const before = await bot.harness.snapshot(ResearchDoc, parent.id, context);
		for (let i = 0; i < 5; i++) await bot.research.status(parent.id, context);
		expect(await bot.harness.snapshot(ResearchDoc, parent.id, context)).toEqual(before);
	});
	test("registry exposes lifecycle only, never authoritative evaluation submission", async () => {
		const { bot } = await setup();
		const extension = researchExtension(bot.research);
		expect(extension.tools!.map((t) => t.name).sort()).toEqual(["research_cancel", "research_start", "research_status"]);
		expect(extension.tasks).toHaveLength(1);
	});
	test("successor links a settled predecessor without mutating its frozen contract or budget", async () => {
		const { bot, parent, api } = await setup();
		const first = await bot.research.start({ contract: contract() }, api, context);
		await bot.harness.waitForTask(Number(first.mission!.controllerTaskId) as TaskId<string>, context);
		const before = (await bot.research.status(parent.id, context)).mission!;
		const c = contract();
		c.question = "A genuinely revised research question";
		const second = await bot.research.start({ contract: c, supersedes: before.id }, { ...api, callId: "successor" }, context);
		expect(second.mission!.supersedes).toBe(before.id);
		expect((await bot.research.status(parent.id, context, before.id)).mission).toEqual(before);
		await expect(bot.research.start({ contract: c, supersedes: "foreign-or-missing" }, { ...api, callId: "foreign" }, context)).rejects
			.toThrow();
	});
	test("tool projection explicitly omits raw evidence and pages bounded records", async () => {
		const { bot, api } = await setup();
		const state = await bot.research.start({ contract: contract() }, api, context);
		const m = structuredClone(state.mission!);
		m.candidates.push({ ...m.candidates[0]!, id: "second" }, { ...m.candidates[0]!, id: "third" });
		const page = researchToolView({ mission: m }, 0);
		expect(page).toMatchObject({ projection: "bounded-summary", rawEvidenceOmitted: true, nextCursor: 2, totals: { candidates: 3 } });
		expect(researchToolView({ mission: m }, 2)).toMatchObject({ nextCursor: null });
		expect(() => researchToolView({ mission: m }, -1)).toThrow("cursor");
	});
});
