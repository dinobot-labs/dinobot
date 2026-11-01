import { describe, expect, test } from "bun:test";
import { Type } from "@earendil-works/pi-ai";
import { channelCatalog } from "../src/channels/index.ts";
import { type Catalogs, type Manifest, ManifestError, parseManifest } from "../src/manifest.ts";
import { definePlugin, loadPlugin } from "../src/plugins/types.ts";
import type { CommandSpec } from "../src/core/research.ts";

const jira = definePlugin({
	id: "jira",
	config: Type.Object({ baseUrl: Type.String({ minLength: 1 }) }),
	load: () => ({
		tools: [{ name: "search", description: "Search issues", inputSchema: { type: "object" }, execute: async () => [] }],
	}),
});
const broken = definePlugin({
	id: "broken",
	config: Type.Object({}),
	load: async () => {
		throw new Error("cannot connect");
	},
});
const catalogs: Catalogs = { channels: channelCatalog, plugins: { jira, broken } };

test("research code profiles require explicit bounded trusted-local command authority", async () => {
	const profile: CommandSpec = {
		executable: "bun", argv: ["evaluate.ts"], cwdPolicy: "candidate", environmentAllowlist: [],
		timeoutMs: 5000, resultSchema: "research-numeric-v1", baseCommit: "a".repeat(40), permittedPaths: ["src/candidate.ts"],
	};
	const research = { codeProfiles: { local: profile } };
	expect((await parseManifest({ ...manifest(), research }, catalogs)).research).toEqual(research);
	for (const invalid of [
		{ ...profile, permittedPaths: ["../outside.ts"] },
		{ ...profile, permittedPaths: ["evaluate.ts"] },
		{ ...profile, timeoutMs: 0 },
		{ ...profile, baseCommit: "HEAD" },
		{ ...profile, resultSchema: "anything" },
		{ ...profile, environmentAllowlist: ["INVALID-NAME"] },
	]) {
		expect((await problems({ ...manifest(), research: { codeProfiles: { local: invalid } } })).length).toBeGreaterThan(0);
	}
	expect((await parseManifest(manifest(), catalogs)).research).toBeUndefined();
});

test("strict numeric-v2 research profiles survive the manifest boundary", async () => {
	const profile: CommandSpec = {
		executable: "bun", argv: ["evaluate.ts"], cwdPolicy: "candidate", environmentAllowlist: [],
		timeoutMs: 5000, resultSchema: "research-numeric-v2", baseCommit: "a".repeat(40), permittedPaths: ["src/candidate.ts"],
	};
	const research = { codeProfiles: { strict: profile } };
	expect((await parseManifest({ ...manifest(), research }, catalogs)).research).toEqual(research);
});

test("research readiness profile preserves both stages and rejects editable evaluators", async () => {
	const profile: CommandSpec = {
		executable: "bun", argv: ["evaluate.ts"], cwdPolicy: "candidate", environmentAllowlist: [],
		timeoutMs: 5000, resultSchema: "research-numeric-v2", baseCommit: "a".repeat(40), permittedPaths: ["src/candidate.ts"],
		readiness: { preflight: { argv: ["preflight.ts"], checkIds: ["payload"] }, canary: { argv: ["canary.ts"], checkIds: ["effects"] } },
	};
	const research = { codeProfiles: { ready: profile } };
	expect((await parseManifest({ ...manifest(), research }, catalogs)).research).toEqual(research);
	for (const readiness of [
		{ ...profile.readiness, preflight: { argv: [], checkIds: ["payload"] } },
		{ ...profile.readiness, preflight: { argv: ["src/candidate.ts"], checkIds: ["payload"] } },
		{ ...profile.readiness, canary: { argv: ["./src/candidate.ts"], checkIds: ["effects"] } },
		{ ...profile.readiness, canary: { argv: ["canary.ts"], checkIds: ["effects", "effects"] } },
		{ preflight: profile.readiness!.preflight },
	]) expect((await problems({ ...manifest(), research: { codeProfiles: { ready: { ...profile, readiness } } } })).length).toBeGreaterThan(0);
});

test("owner project aliases survive YAML serialization and reject unsafe mappings at boot", async () => {
	const { resolve } = await import("node:path");
	const projectAliases = [{ path: resolve("moved"), identity: resolve("historical") }];
	const raw = { ...manifest(), memory: { projectAliases } };
	const serialized = Bun.YAML.stringify(raw);
	expect((await parseManifest(Bun.YAML.parse(serialized), catalogs)).memory.projectAliases).toEqual(projectAliases);
	for (const descendants of [true, false]) {
		const aliases = [{ ...projectAliases[0]!, descendants }];
		const yaml = Bun.YAML.stringify({ ...manifest(), memory: { projectAliases: aliases } });
		expect((await parseManifest(Bun.YAML.parse(yaml), catalogs)).memory.projectAliases).toEqual(aliases);
	}
	for (const aliases of [
		[{ ...projectAliases[0]!, descendants: "true" }],
		[{ path: "relative", identity: resolve("historical") }],
		[{ path: resolve("moved"), identity: resolve("moved") }],
		[{ ...projectAliases[0], arbitrary: true }],
	]) expect(await problems({ ...manifest(), memory: { projectAliases: aliases } })).toContainEqual(expect.stringContaining("projectAliases"));
});

test("workspaceRoot is optional and preserves an explicit execution directory", async () => {
	expect((await parseManifest(manifest({ bot: { workspaceRoot: "/work/project" } }), catalogs)).workspaceRoot).toBe("/work/project");
	expect((await parseManifest(manifest(), catalogs)).workspaceRoot).toBeUndefined();
	expect(await problems(manifest({ bot: { workspaceRoot: "" } }))).toContainEqual(expect.stringContaining("workspaceRoot"));
});

test("LSP config preserves argv and rejects malformed or duplicate server definitions", async () => {
	const lsp = { timeoutMs: 1000, servers: [{ name: "custom", command: ["server", "--stdio"], extensions: [".ts"], settings: { enabled: true } }] };
	expect((await parseManifest({ ...manifest(), lsp }, catalogs)).lsp).toEqual(lsp);
	expect((await parseManifest({ ...manifest(), lsp: { servers: [] } }, catalogs)).lsp?.servers).toEqual([]);
	expect(await problems({ ...manifest(), lsp: { servers: [lsp.servers[0], lsp.servers[0]] } }))
		.toContain('lsp.servers: duplicate name "custom"');
	for (const invalid of [
		{ timeoutMs: 0 }, { timeoutMs: 30001 },
		{ servers: [{ ...lsp.servers[0], command: [] }] },
		{ servers: [{ ...lsp.servers[0], extensions: ["ts"] }] },
	]) expect((await problems({ ...manifest(), lsp: invalid })).length).toBeGreaterThan(0);
});

function manifest(overrides: { bot?: object; channels?: object; plugins?: object; commands?: object } = {}) {
	return {
		bot: {
			enabled: true,
			dataDir: ".data",
			model: { provider: "anthropic", modelId: "claude-sonnet-4-6" },
			toolMode: "codemode-only",
			...overrides.bot,
		},
		channels: overrides.channels ?? { http: { port: 8787 } },
		plugins: overrides.plugins ?? { jira: { baseUrl: "https://jira.example" } },
		...(overrides.commands ? { commands: overrides.commands } : {}),
	};
}

async function problems(raw: unknown): Promise<readonly string[]> {
	try {
		await parseManifest(raw, catalogs);
	} catch (error) {
		if (error instanceof ManifestError) return error.problems;
		throw error;
	}
	throw new Error("expected the manifest to be rejected");
}

describe("customer manifest", () => {
	test("builds channels and plugins with prefixed tool names", async () => {
		const parsed = await parseManifest(manifest(), catalogs);
		expect(parsed.toolMode).toBe("codemode-only");
		expect(parsed.channels.map((channel) => channel.name)).toEqual(["http"]);
		expect(parsed.plugins.map((plugin) => plugin.tools.map((tool) => tool.name))).toEqual([["jira_search"], []]);
		expect(parsed.plugins[1]!.skillPackages?.map((skill) => skill.name)).toEqual(["programming", "optimization", "debugging", "clarification", "research", "delivery", "herdr", "dinobot", "writing", "frontend-craft", "explanation", "slack-setup"]);
	});

	test("a disabled bot needs no channels", async () => {
		const parsed = await parseManifest(manifest({ bot: { enabled: false }, channels: {}, plugins: {} }), catalogs);
		expect(parsed.enabled).toBe(false);
	});

	test("parses the shipped example manifest", async () => {
		const parsed = await parseManifest(Bun.YAML.parse(await Bun.file("dinobot.example.yaml").text()), {
			channels: channelCatalog,
			plugins: (await import("../src/plugins/index.ts")).pluginCatalog,
		});
		expect(parsed.plugins.map((plugin) => plugin.id)).toEqual(["image_gen", "web", "skills"]);
		expect(parsed.plugins[2]!.catalog?.map((skill) => skill.name)).toEqual(["programming", "optimization", "debugging", "clarification", "research", "delivery", "herdr", "dinobot", "writing", "frontend-craft", "explanation", "slack-setup"]);
	});

	test("reports every problem at once", async () => {
		const found = await problems(manifest({ channels: { teams: {}, http: { port: 0 } }, plugins: { jira: {}, wiki: {} } }));
		expect(found.map((problem) => problem.split(":")[0])).toEqual([
			"channels.teams",
			"channels.http/port",
			"plugins.jira",
			"plugins.wiki",
		]);
	});

	test("rejects an unknown tool mode", async () => {
		expect((await problems(manifest({ bot: { toolMode: "codemode" } }))).length).toBeGreaterThan(0);
	});

	test("an enabled bot needs a channel", async () => {
		expect((await problems(manifest({ channels: {} }))).map((problem) => problem.split(":")[0])).toEqual(["channels"]);
	});

	test("disables known commands and rejects unknown names", async () => {
		expect((await parseManifest(manifest(), catalogs)).commands).toEqual({ disabled: [] });
		expect((await parseManifest(manifest({ commands: { disabled: ["login", "logout", "slack"] } }), catalogs)).commands).toEqual({
			disabled: ["login", "logout", "slack"],
		});
		expect(await problems(manifest({ commands: { disabled: ["login", "lgout"] } }))).toEqual([
			'commands.disabled: unknown command "lgout" (available: accounts, fast, help, login, logout, model, plugins, reasoning, report, search, sessions, setup, skills, slack)',
		]);
	});

	test("a plugin whose load throws becomes a plugins.<id> problem", async () => {
		expect(await problems(manifest({ plugins: { broken: {} } }))).toEqual(["plugins.broken: cannot connect"]);
	});
});

describe("default plugins (ADR 0058)", () => {
	const seen: unknown[] = [];
	const search = definePlugin({
		id: "search",
		enabledByDefault: true,
		config: Type.Object({ engine: Type.Optional(Type.String()) }, { additionalProperties: false }),
		load: (config) => {
			seen.push(config);
			return {
				tools: [{ name: "query", description: "Query the web", inputSchema: { type: "object" }, execute: async () => [] }],
				prompt: "search prompt",
			};
		},
	});
	const defaults: Catalogs = { channels: channelCatalog, plugins: { jira, search } };
	const jiraConfig = { baseUrl: "https://jira.example" };
	const ids = (parsed: Manifest) => parsed.plugins.map((plugin) => plugin.id);
	async function parse(plugins: object, given: Catalogs = defaults): Promise<Manifest> {
		seen.length = 0;
		return await parseManifest(manifest({ plugins }), given);
	}
	async function rejected(plugins: object, given: Catalogs = defaults): Promise<readonly string[]> {
		try {
			await parseManifest(manifest({ plugins }), given);
		} catch (error) {
			if (error instanceof ManifestError) return error.problems;
			throw error;
		}
		throw new Error("expected the manifest to be rejected");
	}

	test("a default plugin the manifest omits loads once with an empty config, after the listed plugins", async () => {
		const parsed = await parse({ jira: jiraConfig });
		expect(ids(parsed)).toEqual(["jira", "search", "skills"]);
		expect(seen).toEqual([{}]);
		expect(parsed.plugins[1]!.tools.map((tool) => tool.name)).toEqual(["search_query"]);
		expect(parsed.plugins[1]!.prompt).toBe("search prompt");
		expect(ids(await parse({}))).toEqual(["search", "skills"]);
		expect(seen).toEqual([{}]);
	});

	test("an explicit block configures the default plugin in its manifest position; null means its defaults", async () => {
		expect(ids(await parse({ search: { engine: "ddg" }, jira: jiraConfig }))).toEqual(["search", "jira", "skills"]);
		expect(seen).toEqual([{ engine: "ddg" }]);
		expect(ids(await parse({ search: null }))).toEqual(["search", "skills"]);
		expect(seen).toEqual([{}]);
	});

	test("false turns a default plugin off without loading it", async () => {
		const parsed = await parse({ search: false, jira: jiraConfig });
		expect(ids(parsed)).toEqual(["jira", "skills"]);
		expect(seen).toEqual([]);
		expect(parsed.plugins.flatMap((plugin) => plugin.tools.map((tool) => tool.name))).toEqual(["jira_search"]);
		expect(parsed.plugins.some((plugin) => plugin.prompt === "search prompt")).toBe(false);
	});

	test("only false is a switch, and only for default plugins; everything else is still validated", async () => {
		const jiraOff = await rejected({ jira: false });
		expect(jiraOff.length).toBeGreaterThan(0);
		expect(jiraOff.every((problem) => problem.startsWith("plugins.jira:"))).toBe(true);
		const searchOn = await rejected({ search: true });
		expect(searchOn.length).toBeGreaterThan(0);
		expect(searchOn.every((problem) => problem.startsWith("plugins.search:"))).toBe(true);
		expect((await rejected({ search: { engine: 1 } }))[0]).toStartWith("plugins.search/engine:");
		expect(await rejected({ serach: false })).toEqual(["plugins.serach: unknown plugin (available: jira, search)"]);
		expect(await rejected({ toString: {} })).toEqual(["plugins.toString: unknown plugin (available: jira, search)"]);
	});

	test("problems keep manifest order, and a default plugin's own problems come after them", async () => {
		const strict = definePlugin({
			id: "strict",
			enabledByDefault: true,
			config: Type.Object({ key: Type.String() }),
			load: () => ({ tools: [] }),
		});
		const found = await rejected({ jira: {}, wiki: {} }, { channels: channelCatalog, plugins: { jira, strict } });
		expect(found.map((problem) => problem.split(":")[0])).toEqual(["plugins.jira", "plugins.wiki", "plugins.strict"]);
	});

	test("the shipped catalog turns on web search and login-backed image generation, and false turns each off", async () => {
		const { pluginCatalog } = await import("../src/plugins/index.ts");
		// Presence is checked by catalog key and tools are prefixed by plugin id: they must agree, or a default could load twice.
		expect(Object.entries(pluginCatalog).every(([key, plugin]) => key === plugin.id)).toBe(true);
		const on = Object.entries(pluginCatalog).filter(([, plugin]) => plugin.enabledByDefault);
		expect(on.map(([id]) => id)).toEqual(["image_gen", "web"]);
		// The admission rule (ADR 0058, widened by ADR 0088), checked for every default plugin: `{}` is valid, load does
		// no I/O, and its tools are read-only unless the plugin brings no secret and only borrows declared provider logins.
		const realFetch = globalThis.fetch;
		let requests = 0;
		globalThis.fetch = (async () => {
			requests++;
			throw new Error("network during load");
		}) as unknown as typeof fetch;
		try {
			for (const [id, plugin] of on) {
				const loaded = await loadPlugin(plugin, {});
				if (Array.isArray(loaded)) throw new Error(`${id}: ${loaded.join("; ")}`);
				expect(loaded.tools.length).toBeGreaterThan(0);
				expect(loaded.tools.every((tool) => tool.readOnly === true) || (plugin.providerLogins?.length ?? 0) > 0).toBe(true);
			}
		} finally {
			globalThis.fetch = realFetch;
		}
		expect(requests).toBe(0);

		const shipped: Catalogs = { channels: channelCatalog, plugins: pluginCatalog };
		const parsed = await parse({}, shipped);
		expect(ids(parsed)).toEqual(["image_gen", "web", "skills"]);
		expect(parsed.plugins.flatMap((plugin) => plugin.tools.map((tool) => tool.name))).toEqual(["image_gen_generate", "web_search"]);
		expect(ids(await parse({ web: false }, shipped))).toEqual(["image_gen", "skills"]);
		expect(ids(await parse({ image_gen: false }, shipped))).toEqual(["web", "skills"]);
		expect(ids(await parse({ image_gen: false, web: false }, shipped))).toEqual(["skills"]);
		expect(ids(await parse({ web: { engines: ["duckduckgo"] } }, shipped))).toEqual(["web", "image_gen", "skills"]);
		// The always-on skills plugin is not a default plugin: false cannot turn it off.
		expect((await rejected({ skills: false }, shipped)).every((problem) => problem.startsWith("plugins.skills"))).toBe(true);
	});
});
