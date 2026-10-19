import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { channelCatalog } from "../src/channels/index.ts";
import { COMMAND_NAMES } from "../src/commands/names.ts";
import { openBot } from "../src/core/bot.ts";
import { TOOL_MODES } from "../src/core/toolmode.ts";
import { ManifestShape } from "../src/manifest.ts";
import { pluginCatalog } from "../src/plugins/index.ts";
import { dinobotSkill } from "../src/plugins/skills/dinobot/index.ts";
import { LOCAL_COMMANDS } from "../src/tui/slash.ts";

const context = BACKGROUND_CONTEXT;
const guide = [dinobotSkill.body, ...Object.values(dinobotSkill.files)].join("\n");

/** Property names declared by a TypeBox object schema, through intersections and unions (top level only). */
function keys(schema: unknown): string[] {
	const node = schema as { properties?: Record<string, unknown>; allOf?: unknown[]; anyOf?: unknown[] };
	const own = node.properties ? Object.keys(node.properties) : [];
	return [...new Set([...own, ...[...(node.allOf ?? []), ...(node.anyOf ?? [])].flatMap(keys)])];
}

/** A configurable name must appear as a code span or YAML key, not merely as a word in prose. */
function documented(name: string): boolean {
	return guide.includes(`\`${name}\``) || guide.includes(`${name}:`) || guide.includes(`.${name}`) || guide.includes(`/${name}`);
}

describe("bundled dinobot skill covers this build's configuration surface", () => {
	const manifest = ManifestShape as unknown as { properties: Record<string, unknown> };
	const surface: [string, string[]][] = [
		["manifest top-level keys", keys(manifest)],
		["manifest bot keys", keys(manifest.properties.bot)],
		["tool modes", [...TOOL_MODES]],
		["plugins", Object.keys(pluginCatalog)],
		["channels", Object.keys(channelCatalog)],
		["daemon slash commands", [...COMMAND_NAMES]],
		["TUI slash commands", LOCAL_COMMANDS.map((command) => command.name)],
		...Object.entries(pluginCatalog).map(([id, plugin]): [string, string[]] => [`plugins.${id} config`, keys(plugin.config)]),
		...Object.entries(channelCatalog).map(([id, channel]): [string, string[]] => [`channels.${id} config`, keys(channel.config)]),
	];
	test.each(surface)("%s are documented", (_label, names) => {
		expect(names.length).toBeGreaterThan(0);
		expect(names.filter((name) => !documented(name))).toEqual([]);
	});

	test("the default-model recipe states the preference precedence", () => {
		const models = dinobotSkill.files["references/models.md"];
		expect(models).toContain("/model");
		expect(models).toContain("bot.model");
		expect(models).toContain("preference.model ?? model");
		expect(dinobotSkill.body).toContain("references/models.md");
	});
});

describe("dinobot skill through the harness", () => {
	let dir: string;
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	test("codemode loads the hub and reads a reference at the pinned version", async () => {
		dir = await mkdtemp(join(tmpdir(), "dinobot-skill-"));
		const faux = fauxProvider({ provider: "faux", models: [{ id: "one" }] });
		const models = createModels();
		models.setProvider(faux.provider);
		const bot = await openBot({
			storage: new MemoryStorage(), models, defaultModel: { provider: "faux", modelId: "one" },
			toolMode: "codemode-only", plugins: [], workspaceRoot: dir,
		}, context);
		const code = [
			"const skill = JSON.parse(resultText(await tools.skills_load({name: \"dinobot\"})));",
			"const file = JSON.parse(resultText(await tools.skills_read_file({name: \"dinobot\", version: skill.version, path: \"references/models.md\"})));",
			"text(JSON.stringify({files: skill.files, hub: skill.body.includes(\"## Ground rules\"), models: file.content.includes(\"## Recipes\")}));",
		].join("\n");
		try {
			faux.setResponses([
				(request) => {
					expect(JSON.stringify(request.messages.filter((message) => message.role === "system"))).toContain("dinobot.yaml settings");
					return fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" });
				},
				(request) => {
					const result = request.messages.filter((message) => message.role === "toolResult").at(-1)!;
					expect(result.isError).not.toBe(true);
					const body = JSON.stringify(result.content);
					expect(body).toContain('\\"hub\\":true');
					expect(body).toContain('\\"models\\":true');
					expect(body).toContain("references/configuration.md");
					return fauxAssistantMessage("done");
				},
			]);
			await bot.handle({ channel: "test", threadKey: "guide", messageId: "m1", userId: "U", text: "how do I change the default model?" }, context);
		} finally {
			await bot.close(context);
		}
	});
});
