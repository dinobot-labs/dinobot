import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openBot } from "../src/core/bot.ts";
import { skillsPlugin, withDefaultSkills } from "../src/plugins/skills/index.ts";
import { type LoadedPlugin, loadPlugin } from "../src/plugins/types.ts";
import { PROOF_SKILLS } from "../src/plugins/skills/proof-skills/note.ts";

const context = BACKGROUND_CONTEXT;
const DESCRIPTION = "Extract text and tables from PDF files.";

let dir: string;
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function writeSkill(root: string, dirName: string, frontmatter: string, body = "Use the guide.") {
	await mkdir(join(root, dirName), { recursive: true });
	await writeFile(join(root, dirName, "SKILL.md"), `---\n${frontmatter}\n---\n${body}\n`);
}

async function pdfSkills(): Promise<LoadedPlugin> {
	dir = await mkdtemp(join(tmpdir(), "dinobot-skills-"));
	const root = join(dir, "skills");
	await writeSkill(root, "pdf-tools", `name: pdf-tools\ndescription: ${DESCRIPTION}`, "# PDF tools\nRead references/guide.md.");
	await mkdir(join(root, "pdf-tools", "references"));
	await writeFile(join(root, "pdf-tools", "references", "guide.md"), "guide text");
	const loaded = await loadPlugin(skillsPlugin, { dirs: [root] });
	if (Array.isArray(loaded)) throw new Error(loaded.join("\n"));
	return loaded;
}

describe("skills plugin", () => {
	test("proofSkills opts in bundled proof skills with complete licenses and companions", async () => {
		dir = await mkdtemp(join(tmpdir(), "dinobot-skills-"));
		const plugin = await loadPlugin(skillsPlugin, { proofSkills: true });
		if (Array.isArray(plugin)) throw new Error(plugin.join("\n"));
		expect(plugin.catalog?.map((skill) => skill.name).slice(-4)).toEqual([...PROOF_SKILLS]);
		for (const name of PROOF_SKILLS) {
			const proof = plugin.skillPackages!.find((skill) => skill.name === name)!;
			expect(proof.source).toBe(`bundled:${name}`);
			expect(proof.body.startsWith("## Running this skill in dinobot")).toBe(true);
			expect(proof.files.LICENSE).toContain("MIT License");
			expect(proof.files.LICENSE).toContain("Copyright (c) 2026 Opum AI");
			expect(proof.files.LICENSE).toContain("THE SOFTWARE IS PROVIDED \"AS IS\"");
			expect(Object.keys(proof.files).length).toBeGreaterThan(5);
			for (const path of Object.keys(proof.files)) expect(path.endsWith(".txt"), path).toBe(false);
		}
	});

	test("proof skills stay disabled unless explicitly enabled", async () => {
		dir = await mkdtemp(join(tmpdir(), "dinobot-skills-"));
		for (const config of [{}, { proofSkills: false }]) {
			const plugin = await loadPlugin(skillsPlugin, config);
			if (Array.isArray(plugin)) throw new Error(plugin.join("\n"));
			for (const name of PROOF_SKILLS) expect(plugin.catalog?.some((skill) => skill.name === name)).toBe(false);
		}
	});

	test("bundled sources are embedded without filesystem dependencies", async () => {
		dir = await mkdtemp(join(tmpdir(), "dinobot-skills-"));
		const [skills] = await withDefaultSkills([]);
		expect(skills).toBeDefined();
		expect(await withDefaultSkills([skills!])).toEqual([skills!]);
		expect(skills!.catalog?.map((skill) => skill.name)).toEqual(["programming", "optimization", "debugging", "clarification", "research", "herdr", "dinobot", "writing", "frontend-craft", "explanation", "slack-setup"]);
		expect(skills!.tools).toEqual([]);
		for (const source of skills!.skillPackages!) if (source.name !== "dinobot" && source.name !== "writing" && source.name !== "frontend-craft" && source.name !== "explanation" && source.name !== "slack-setup") expect(source.files).toEqual({});
		// The self guide is a hub: every reference it routes to ships as a companion file, and nothing unrouted ships.
		const guide = skills!.skillPackages!.find((skill) => skill.name === "dinobot")!;
		expect(guide.source).toBe("bundled:dinobot");
		const routed = [...new Set([...guide.body.matchAll(/`(references\/[a-z-]+\.md)`/g)].map((match) => match[1]!))].sort();
		expect(Object.keys(guide.files).sort()).toEqual(routed);
		for (const [path, content] of Object.entries(guide.files)) expect(content.trim().length, path).toBeGreaterThan(200);
		// The writing guide is a hub too: every routed reference ships, and nothing unrouted ships.
		const writing = skills!.skillPackages!.find((skill) => skill.name === "writing")!;
		expect(writing.source).toBe("bundled:writing");
		const writingRouted = [...new Set([...writing.body.matchAll(/`(references\/[a-z-]+\.md)`/g)].map((match) => match[1]!))].sort();
		expect(Object.keys(writing.files).sort()).toEqual(writingRouted);
		for (const [path, content] of Object.entries(writing.files)) expect(content.trim().length, path).toBeGreaterThan(200);
		// The explanation workflow is a hub too: it ships both references and routes its prose to writing.
		const explanation = skills!.skillPackages!.find((skill) => skill.name === "explanation")!;
		expect(explanation.source).toBe("bundled:explanation");
		const explanationRouted = Object.keys(explanation.files).sort();
		expect(explanationRouted).toEqual(["references/artifact-delivery.md", "references/review-scenarios.md"]);
		for (const [path, content] of Object.entries(explanation.files)) {
			expect(content.trim().length, path).toBeGreaterThan(200);
			expect(explanation.body, path).toContain(path);
		}
		// Explanation owns media choice, evidence and honesty; the sentences come from the writing skill.
		expect(explanation.body).toContain("skills_load({ name: \"writing\" })");
		expect(explanation.body).toContain("writing skill");
		// The explanation language is bound to the user prompt, never to the skill document.
		expect(explanation.body).toContain("language of the user's current prompt");
		// frontend-craft ships exactly the scripts and templates its body routes to.
		const craft = skills!.skillPackages!.find((skill) => skill.name === "frontend-craft")!;
		expect(craft.source).toBe("bundled:frontend-craft");
		const craftRouted = [...new Set([...craft.body.matchAll(/`((?:scripts|templates)\/[A-Za-z_.-]+)`/g)].map((match) => match[1]!))].sort();
		expect(Object.keys(craft.files).sort()).toEqual(craftRouted);
		for (const [path, content] of Object.entries(craft.files)) expect(content.trim().length, path).toBeGreaterThan(200);
		// slack-setup ships exactly the manifest, scripts and references its body routes to.
		const slack = skills!.skillPackages!.find((skill) => skill.name === "slack-setup")!;
		expect(slack.source).toBe("bundled:slack-setup");
		const slackRouted = [...new Set([...slack.body.matchAll(/`((?:scripts|references)\/[A-Za-z0-9_.-]+|slack-app-manifest\.json)`/g)].map((match) => match[1]!))].sort();
		expect(Object.keys(slack.files).sort()).toEqual(slackRouted);
		for (const [path, content] of Object.entries(slack.files)) expect(content.trim().length, path).toBeGreaterThan(200);
		// The app manifest declares everything the Slack adapter relies on: Socket Mode, DMs, buttons, mentions and thread follow-ups.
		const app = JSON.parse(slack.files["slack-app-manifest.json"]!);
		expect(app.settings.socket_mode_enabled).toBe(true);
		expect(app.settings.interactivity.is_enabled).toBe(true);
		expect(app.settings.token_rotation_enabled).toBe(false);
		expect(app.features.app_home).toMatchObject({ messages_tab_enabled: true, messages_tab_read_only_enabled: false });
		expect([...app.oauth_config.scopes.bot].sort()).toEqual(["app_mentions:read", "channels:history", "chat:write", "files:read", "files:write", "groups:history", "im:history"]);
		expect([...app.settings.event_subscriptions.bot_events].sort()).toEqual(["app_mention", "message.channels", "message.groups", "message.im"]);
		// The guide defaults to the channel wildcard and never asks the user to restart dinobot themselves.
		expect(slack.body).toContain('allowedChannelIds: ["*"]');
		expect(slack.body).toContain("/v1/daemon");
		expect(skills!.skillPackages!.find((skill) => skill.name === "dinobot")!.body).toContain("`slack-setup`");
		for (const name of ["optimization", "debugging"]) {
			const body = skills!.skillPackages!.find((skill) => skill.name === name)!.body;
			expect(body).toContain("## Workflow");
			expect(body).not.toContain("engineering-discipline");
			expect(body).toContain(name === "optimization" ? "test/tui-perf.test.ts" : "temporary storage");
		}
		const programming = skills!.skillPackages!.find((skill) => skill.name === "programming")!.body;
		expect(programming).not.toContain("137dead9137f39aa54b9ed87803a7f26324eedaf");
		// Specialized skills are disclosed by name and loaded on demand, not inlined.
		for (const name of ["debugging", "optimization", "research"]) expect(programming).toContain(`- ${name}:`);
		expect(programming).toContain("skills_load");
		expect(programming).not.toContain("## Workflow");
	});

	test.each(["programming", "optimization", "debugging", "clarification", "research", "herdr", "dinobot", "writing", "frontend-craft", "explanation", "slack-setup"])("rejects external replacement of %s", async (name) => {
		dir = await mkdtemp(join(tmpdir(), "dinobot-skills-"));
		await writeSkill(dir, name, `name: ${name}\ndescription: replacement`);
		const result = await loadPlugin(skillsPlugin, { dirs: [dir] });
		expect(Array.isArray(result)).toBe(true);
		expect(JSON.stringify(result)).toContain("duplicate skill name");
		expect(JSON.stringify(result)).toContain("bundled:");
	});

	test.each(["direct", "hybrid", "codemode-only"] as const)("%s loads bundled skills through the harness with no configured plugin", async (toolMode) => {
		dir = await mkdtemp(join(tmpdir(), "dinobot-skills-"));
		const faux = fauxProvider({ provider: "faux", models: [{ id: "one" }] });
		const models = createModels();
		models.setProvider(faux.provider);
		const bot = await openBot({
			storage: new MemoryStorage(), models, defaultModel: { provider: "faux", modelId: "one" },
			toolMode, plugins: [], workspaceRoot: dir,
		}, context);
		try {
			for (const [name, heading] of [["programming", "## Closed change set"], ["optimization", "## Workflow"], ["debugging", "## Workflow"], ["research", "## Research contract"], ["dinobot", "## Ground rules"]] as const) {
				faux.setResponses([
					(request) => {
						const system = JSON.stringify(request.messages.filter((message) => message.role === "system"));
						expect(system).toContain(name);
						expect(system).not.toContain(heading);
						return fauxAssistantMessage(fauxToolCall(
							toolMode === "direct" ? "skills_load" : "codemode",
							toolMode === "direct" ? { name } : { code: `text(await tools.skills_load({name:${JSON.stringify(name)}}));` },
						), { stopReason: "toolUse" });
					},
					(request) => {
						const result = request.messages.filter((message) => message.role === "toolResult").at(-1)!;
						expect(result.isError).not.toBe(true);
						expect(JSON.stringify(result.content)).toContain(heading);
						return fauxAssistantMessage("loaded");
					},
				]);
				await bot.handle({ channel: "test", threadKey: name, messageId: name, userId: "U", text: "load skill" }, context);
			}
		} finally {
			await bot.close(context);
		}
	});

	test("compiled skill loader works from an empty directory without source assets", async () => {
		dir = await mkdtemp(join(tmpdir(), "dinobot-skills-"));
		const entry = join(dir, "entry.ts");
		const modulePath = join(import.meta.dir, "..", "src", "plugins", "skills", "index.ts");
		await writeFile(entry, `import { withDefaultSkills } from ${JSON.stringify(modulePath)};
const [plugin] = await withDefaultSkills([]);
for (const name of ["programming", "optimization", "debugging", "clarification", "research", "herdr", "dinobot", "writing", "frontend-craft", "explanation", "slack-setup"]) {
 console.log(plugin.skillPackages.find(t => t.name === name).body);
}
console.log(plugin.skillPackages.find(t => t.name === "dinobot").files["references/models.md"]);`);
		const binary = join(dir, "skills");
		const build = Bun.spawn([process.execPath, "build", "--compile", entry, "--outfile", binary], { stdout: "pipe", stderr: "pipe" });
		const output = await new Response(build.stderr).text();
		expect(await build.exited, output).toBe(0);
		await rm(entry);
		const cwd = join(dir, "empty");
		await mkdir(cwd);
		const run = Bun.spawn([binary], { cwd, stdout: "pipe", stderr: "pipe" });
		const text = await new Response(run.stdout).text();
		expect(await run.exited).toBe(0);
		expect(text).toContain("# Programming");
		expect(text).toContain("# Optimization");
		expect(text).toContain("# Debugging");
		expect(text).toContain("# Research");
		expect(text).toContain(".dinobot/research/<slug>-<UUID>");
		expect(text).toContain("# Dinobot");
		expect(text).toContain("# Explanation");
		expect(text).toContain("# Models, reasoning and provider accounts");
	});

	test("advertises skills in the prompt and discloses body and files on demand", async () => {
		const skills = await pdfSkills();
		const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
		const models = createModels();
		models.setProvider(faux.provider);
		const bot = await openBot(
			{
				storage: await openNodeSqliteStorage(join(dir, "bot.sqlite")),
				models,
				defaultModel: { provider: "faux", modelId: "faux-1" },
				toolMode: "direct",
				plugins: [skills],
			},
			context,
		);
		let system = "";
		faux.setResponses([
			(transcript) => {
				system = JSON.stringify(transcript.messages.filter((message) => message.role === "system"));
				return fauxAssistantMessage("ok");
			},
		]);
		try {
			await bot.handle({ channel: "test", threadKey: "T1", messageId: "m1", userId: "U1", text: "hi" }, context);
			const skill = await bot.skills.load("pdf-tools", undefined, context);
			expect(skill.body).toContain("# PDF tools");
			expect(skill.originalSkillMd).toContain("description:");
			expect(Object.keys(skill.files)).toContain("references/guide.md");
			expect(await bot.skills.readFile("pdf-tools", skill.version, "references/guide.md", context)).toBe("guide text");
			// Editing an external source after import cannot change a pinned package.
			await writeFile(join(dir, "skills", "pdf-tools", "references", "guide.md"), "changed outside");
			expect(await bot.skills.readFile("pdf-tools", skill.version, "references/guide.md", context)).toBe("guide text");
			await expect(bot.skills.load("nope", undefined, context)).rejects.toThrow();
			await expect(bot.skills.readFile("pdf-tools", skill.version, "../outside.txt", context)).rejects.toThrow();
			await expect(bot.skills.readFile("pdf-tools", skill.version, "/etc/passwd", context)).rejects.toThrow();
		} finally {
			await bot.close(context);
		}
		expect(system).toContain("pdf-tools");
		expect(system).toContain(DESCRIPTION);
	});

	test("source importer rejects symlink escapes before activating a package", async () => {
		await pdfSkills();
		const outside = join(dir, "skills", "outside.txt");
		await writeFile(outside, "secret");
		await symlink(outside, join(dir, "skills", "pdf-tools", "link.txt"));
		const loaded = await loadPlugin(skillsPlugin, { dirs: [join(dir, "skills")] });
		expect(Array.isArray(loaded)).toBe(true);
		expect(JSON.stringify(loaded)).toContain("symlink");
	});

	test.each([
		["uppercase name", "Bad-Name", "name: Bad-Name\ndescription: x", "lowercase"],
		["name not matching dir", "dir-name", "name: other-name\ndescription: x", "must equal its directory name"],
		["missing description", "no-desc", "name: no-desc", "description is required"],
		["consecutive hyphens", "a--b", "name: a--b\ndescription: x", "consecutive hyphens"],
	])("rejects a skill with %s", async (_case, dirName, frontmatter, rule) => {
		dir = await mkdtemp(join(tmpdir(), "dinobot-skills-"));
		await writeSkill(dir, dirName, frontmatter);
		const result = await loadPlugin(skillsPlugin, { dirs: [dir] });
		expect(Array.isArray(result)).toBe(true);
		expect((result as string[]).join("\n")).toContain(rule);
	});
});
