import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openBot } from "../src/core/bot.ts";
import type { ToolMode } from "../src/core/toolmode.ts";
import { channelCatalog } from "../src/channels/index.ts";
import { parseManifest } from "../src/manifest.ts";
import { TASK_DISCIPLINE, TASK_PROFILE_DROPPED_SECTIONS, type PromptProfile } from "../src/extensions/task-profile.ts";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function systemSections(promptProfile: PromptProfile | undefined, toolMode: ToolMode = "codemode-only"): Promise<Record<string, string>> {
	const dir = await mkdtemp(join(tmpdir(), "dinobot-task-profile-"));
	dirs.push(dir);
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	const models = createModels();
	models.setProvider(faux.provider);
	const bot = await openBot({
		storage: await openNodeSqliteStorage(join(dir, "bot.sqlite")), models, defaultModel: { provider: "faux", modelId: "faux-1" },
		toolMode, plugins: [], workspaceRoot: dir, ...(promptProfile ? { promptProfile } : {}),
	}, context);
	let sections: Record<string, string> = {};
	try {
		faux.setResponses([(transcript) => {
			for (const message of transcript.messages) {
				if (message.role === "system") sections = Object.fromEntries(Object.entries(message.sections ?? {}).filter(([, value]) => typeof value === "string")) as Record<string, string>;
			}
			return fauxAssistantMessage("done");
		}]);
		await bot.handle({ channel: "http", threadKey: "profile", messageId: "m1", userId: "u", text: "do the task" }, context);
	} finally { await bot.close(context); }
	return sections;
}

test("the default full profile keeps every messaging and workflow section and adds no task checklist", async () => {
	const full = await systemSections(undefined);
	expect(full.preamble).toContain("teammate inside the customer's messaging channels");
	for (const key of ["memory_guidance", "dag_protocol", "goal_guidance", "ask_protocol", "session_awareness", "soul"]) expect(full[key]).toBeString();
	expect(full.task_discipline).toBeUndefined();
});

test("the task profile drops messaging/collaboration sections, replaces the preamble and ends with the checklist", async () => {
	const full = await systemSections("full");
	const task = await systemSections("task");
	for (const key of TASK_PROFILE_DROPPED_SECTIONS) expect(task[key]).toBeUndefined();
	expect(task.preamble).toContain("No human is in the loop");
	expect(task.preamble).not.toContain("<from>");
	expect(task.preamble).not.toContain("dag_run");
	expect(task.task_discipline).toContain(TASK_DISCIPLINE.split("\n")[1]!);
	expect(task.workspace).toContain("File and shell working directory");
	expect(task.codemode_tools).toBe(full.codemode_tools);
	const size = (sections: Record<string, string>) => Object.values(sections).reduce((sum, value) => sum + value.length, 0);
	expect(size(task)).toBeLessThan(size(full) / 2);
	expect(Object.keys(task).at(-1)).toBe("task_discipline");
});

test("the task profile preamble matches the tool mode", async () => {
	expect((await systemSections("task", "direct")).preamble).not.toContain("codemode");
	expect((await systemSections("task", "codemode-only")).preamble).toContain("only callable inside codemode");
});

test("manifest accepts promptProfile, defaults to full and rejects unknown profiles", async () => {
	const catalogs = { channels: channelCatalog, plugins: {} };
	const manifest = (extra: Record<string, unknown> = {}) => ({
		bot: { enabled: true, dataDir: "/tmp/dinobot-profile", model: { provider: "zai", modelId: "glm-5.3" }, toolMode: "codemode-only", ...extra },
		api: { port: 18786 }, channels: {}, plugins: {},
	});
	expect((await parseManifest(manifest(), catalogs)).promptProfile).toBe("full");
	expect((await parseManifest(manifest({ promptProfile: "task" }), catalogs)).promptProfile).toBe("task");
	await expect(parseManifest(manifest({ promptProfile: "tiny" }), catalogs)).rejects.toThrow();
});
