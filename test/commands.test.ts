import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AuthInteraction, CredentialStore } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { AgentDoc, configure } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { AuthService, LoginProvider } from "../src/auth/types.ts";
import type { InboundMessage } from "../src/channels/types.ts";
import { type CommandRequest, type Commands, createCommands, withCommands } from "../src/commands/index.ts";
import type { CommandEvent } from "../src/commands/types.ts";
import { type Bot, openBot } from "../src/core/bot.ts";
import type { LoadedPlugin } from "../src/plugins/types.ts";

const context = BACKGROUND_CONTEXT;
let dir: string | undefined;
let bot: Bot | undefined;

afterEach(async () => {
	await bot?.close(context);
	if (dir !== undefined) await rm(dir, { recursive: true, force: true });
	dir = bot = undefined;
});

function fakeAuth(initial: Record<string, "oauth" | "api_key"> = {}): AuthService & { logins: string[] } {
	const providers: LoginProvider[] = [
		{ id: "cursor", name: "Cursor", storeAs: "cursor" },
		{ id: "anthropic", name: "Anthropic", storeAs: "anthropic", modelProvider: "anthropic" },
		{ id: "openai-codex", name: "ChatGPT", storeAs: "openai-codex", modelProvider: "openai-codex" },
	];
	const stored = new Map<string, "oauth" | "api_key">(Object.entries(initial));
	const logins: string[] = [];
	return {
		logins,
		credentials: {} as CredentialStore,
		providers: async () => providers,
		async login(id: string, interaction: AuthInteraction) {
			const provider = providers.find((entry) => entry.id === id);
			if (provider === undefined) throw new Error(`unknown provider ${id}`);
			const key = await interaction.prompt({ type: "secret", message: `${provider.name} API key` });
			logins.push(`${id}:${key}`);
			stored.set(provider.storeAs, "api_key");
			return { provider, type: "api_key" as const, identity: "roach@example.com" };
		},
		logout: async (id: string) => stored.delete(id),
		status: async () => [...stored].map(([key, type]) => ({ key, type })),
		accounts: async () => [...stored].map(([key, type]) => ({ key, accounts: [{ id: "1", type, active: true }] })),
		useAccount: async () => {
			throw new Error("no accounts");
		},
	};
}

const plugins: LoadedPlugin[] = [
	{ id: "skills", tools: [], catalog: [{ name: "review", description: "Review a change" }] },
	{
		id: "sample",
		tools: [{ name: "sample_lookup", description: "Now", inputSchema: { type: "object" }, execute: async () => 0 }],
	},
];

async function openTestBot(directory: string) {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", name: "Faux 1" }, { id: "faux-2", name: "Faux 2" }] });
	const models = createModels();
	models.setProvider(faux.provider);
	const opened = await openBot(
		{
			storage: await openNodeSqliteStorage(join(directory, "bot.sqlite")),
			models,
			defaultModel: { provider: "faux", modelId: "faux-1" },
			toolMode: "direct",
			plugins: [],
		},
		context,
	);
	return { faux, models, bot: opened };
}

async function setup(disabled?: readonly string[], auth: AuthService = fakeAuth()) {
	dir = await mkdtemp(join(tmpdir(), "dinobot-commands-"));
	const opened = await openTestBot(dir);
	bot = opened.bot;
	const commands = createCommands({
		bot: opened.bot,
		models: opened.models,
		auth,
		plugins,
		...(disabled ? { disabled } : {}),
	});
	return { ...opened, commands };
}

const request = (surface: "tui" | "channel"): CommandRequest => ({
	surface,
	channel: "tui",
	threadKey: "demo",
	userId: "roach",
	context,
});

async function collect(commands: Commands, name: string, args: string, surface: "tui" | "channel" = "tui") {
	const command = commands.find(name, surface);
	if (command === undefined) throw new Error(`no /${name} on ${surface}`);
	const events: CommandEvent[] = [];
	for await (const event of commands.run(command, args, request(surface)).events) events.push(event);
	return events;
}

function message(text: string): InboundMessage {
	return { channel: "slack", threadKey: "t1", messageId: crypto.randomUUID(), userId: "u1", text };
}

test("lists commands per surface, sorted, without disabled ones", async () => {
	const { commands } = await setup(["skills"]);
	expect(commands.list("tui").map((info) => info.name)).toEqual(["accounts", "fast", "help", "login", "logout", "model", "plugins", "reasoning", "search", "sessions"]);
	expect(commands.list("channel").map((info) => info.name)).toEqual(["fast", "help", "model", "plugins", "reasoning", "search", "sessions"]);
	expect(commands.find("login", "channel")).toBeUndefined();
	expect(commands.find("skills", "tui")).toBeUndefined();
	expect(commands.list("tui").find((info) => info.name === "model")?.usage).toBe("[provider/modelId]");
});

test("rejects unknown disabled names", async () => {
	await expect(setup(["lgoin"])).rejects.toThrow('unknown command "lgoin"');
});

test("/model switches the thread conversation's model and reports state", async () => {
	const { commands } = await setup();
	const events = await collect(commands, "model", "faux/faux-2");
	expect(events[0]).toEqual({ type: "started", runId: expect.any(String) });
	expect(events).toContainEqual({ type: "state", model: "faux/faux-2", thinkingLevel: "off", supportedThinkingLevels: ["off"], fast: false, fastSupported: false });
	expect(events.at(-1)).toEqual({ type: "done" });

	const conversation = await bot!.conversation("tui", "demo", context);
	expect((await bot!.harness.snapshot(AgentDoc, conversation.id, context))?.model).toEqual({ provider: "faux", modelId: "faux-2" });
});

const scope = { channel: "tui", threadKey: "demo" };
const outputs = (events: readonly CommandEvent[]) => events.flatMap((event) => (event.type === "output" ? [event.text] : []));

test("/model persists the latest default across restarts without rewriting existing threads", async () => {
	let { commands } = await setup();
	const modelOf = async (thread: string) => {
		const conversation = await bot!.conversation("tui", thread, context);
		return (await bot!.harness.snapshot(AgentDoc, conversation.id, context))?.model;
	};
	const first = { provider: "faux", modelId: "faux-1" };
	const second = { provider: "faux", modelId: "faux-2" };
	expect(await modelOf("existing")).toEqual(first);
	await collect(commands, "model", "faux/faux-2");
	expect(await modelOf("new-before-restart")).toEqual(second);
	expect(await modelOf("existing")).toEqual(first);
	const invalid = await collect(commands, "model", "faux/missing");
	expect(invalid.some((event) => event.type === "error")).toBe(true);
	await collect(commands, "model", "", "channel");

	await bot!.close(context);
	bot = undefined;
	let reopened = await openTestBot(dir!);
	bot = reopened.bot;
	expect(await modelOf("new-after-restart")).toEqual(second);
	expect(await modelOf("demo")).toEqual(second);
	expect(await modelOf("existing")).toEqual(first);
	commands = createCommands({ bot, models: reopened.models, auth: fakeAuth(), plugins });
	await collect(commands, "model", "faux/faux-1", "channel");

	await bot.close(context);
	bot = undefined;
	reopened = await openTestBot(dir!);
	bot = reopened.bot;
	expect(await modelOf("new-after-second-restart")).toEqual(first);
	expect(await modelOf("new-after-restart")).toEqual(second);
});

test("/model arguments group by provider with the current model's provider first", async () => {
	const { commands, models } = await setup();
	models.setProvider(fauxProvider({ provider: "alpha", models: [{ id: "a-1", name: "Alpha One" }] }).provider);
	const faux = models.getProvider("faux")!.name || "faux";
	const alpha = models.getProvider("alpha")!.name || "alpha";
	expect(await commands.find("model", "tui")!.arguments!(context, scope)).toEqual([
		{ value: "faux/faux-1", label: "Faux 1", description: "faux/faux-1", group: faux, current: true },
		{ value: "faux/faux-2", label: "Faux 2", description: "faux/faux-2", group: faux },
		{ value: "alpha/a-1", label: "Alpha One", description: "alpha/a-1", group: alpha },
	]);
});

test("/model without arguments on tui prompts a select, then switches", async () => {
	const { commands, models } = await setup();
	const run = commands.run(commands.find("model", "tui")!, "", request("tui"));
	const events: CommandEvent[] = [];
	for await (const event of run.events) {
		events.push(event);
		if (event.type === "prompt") commands.answer(run.runId, event.id, { value: "faux/faux-2" });
	}
	const group = models.getProvider("faux")!.name || "faux";
	expect(events.find((event) => event.type === "prompt")).toEqual({
		type: "prompt",
		id: expect.any(String),
		prompt: {
			type: "select",
			message: "Choose a model",
			options: [
				{ id: "faux/faux-1", label: "Faux 1", description: "faux/faux-1", group, current: true },
				{ id: "faux/faux-2", label: "Faux 2", description: "faux/faux-2", group },
			],
		},
	});
	expect(events).toContainEqual({ type: "state", model: "faux/faux-2", thinkingLevel: "off", supportedThinkingLevels: ["off"], fast: false, fastSupported: false });
	expect(events).toContainEqual({ type: "output", level: "success", text: "model switched to faux/faux-2" });
	expect(events.at(-1)).toEqual({ type: "done" });
	const created = await bot!.conversation("tui", "after-picker-selection", context);
	expect((await bot!.harness.snapshot(AgentDoc, created.id, context))?.model).toEqual({ provider: "faux", modelId: "faux-2" });
});

test("/model without arguments on a channel prints the grouped listing", async () => {
	const { commands, models } = await setup();
	const group = models.getProvider("faux")!.name || "faux";
	expect(outputs(await collect(commands, "model", "", "channel"))).toEqual([
		`current model: faux/faux-1\n${group}\n  \u25cf faux/faux-1  Faux 1\n    faux/faux-2  Faux 2`,
	]);
});

test("/model keeps a thread model that is no longer available as a disabled current row, in arguments, the tui select and the channel listing", async () => {
	const { commands, models } = await setup();
	const conversation = await bot!.conversation("tui", "demo", context);
	await bot!.harness.commit((tx) => configure(tx, conversation.id, { model: { provider: "gone", modelId: "old-1" } }), context);
	const faux = models.getProvider("faux")!.name || "faux";
	const stale = { value: "gone/old-1", label: "old-1", description: "not available; log in to gone first", group: "gone", current: true, disabled: true };
	expect(await commands.find("model", "tui")!.arguments!(context, scope)).toEqual([
		stale,
		{ value: "faux/faux-1", label: "Faux 1", description: "faux/faux-1", group: faux },
		{ value: "faux/faux-2", label: "Faux 2", description: "faux/faux-2", group: faux },
	]);

	const run = commands.run(commands.find("model", "tui")!, "", request("tui"));
	const options: unknown[] = [];
	for await (const event of run.events) {
		if (event.type !== "prompt" || event.prompt.type !== "select") continue;
		options.push(...event.prompt.options);
		commands.answer(run.runId, event.id, { cancel: true });
	}
	const { value, ...rest } = stale;
	expect(options[0]).toEqual({ id: value, ...rest });

	expect(outputs(await collect(commands, "model", "", "channel"))).toEqual([
		`current model: gone/old-1\ngone\n  \u25cf gone/old-1  old-1  (not available; log in to gone first)\n${faux}\n    faux/faux-1  Faux 1\n    faux/faux-2  Faux 2`,
	]);
});

test("/login groups chat providers first and badges stored credentials", async () => {
	const { commands } = await setup(undefined, fakeAuth({ anthropic: "oauth" }));
	const chat = "Chat providers";
	const expected = [
		{ value: "anthropic", label: "Anthropic", group: chat, badge: "logged in" },
		{ value: "openai-codex", label: "ChatGPT", group: chat },
		{ value: "cursor", label: "Cursor", group: "Login only (no chat transport yet)", description: "no model transport in this build" },
	];
	expect(await commands.find("login", "tui")!.arguments!(context, scope)).toEqual(expected);

	const run = commands.run(commands.find("login", "tui")!, "", request("tui"));
	const prompts: CommandEvent[] = [];
	for await (const event of run.events) {
		if (event.type !== "prompt") continue;
		prompts.push(event);
		commands.answer(run.runId, event.id, { cancel: true });
	}
	expect(prompts[0]).toEqual({
		type: "prompt",
		id: expect.any(String),
		// `login: true`: the front end follows the chosen provider's flow on its login card (also inside /setup).
		prompt: { type: "select", message: "Log in to a provider", login: true, options: expected.map(({ value, ...rest }) => ({ id: value, ...rest })) },
	});

	const logout = commands.run(commands.find("logout", "tui")!, "", request("tui"));
	for await (const event of logout.events) {
		if (event.type !== "prompt") continue;
		expect(event.prompt).toEqual({
			type: "select",
			message: "Log out of",
			options: [{ id: "anthropic", label: "anthropic", description: "oauth", badge: "oauth" }],
		});
		commands.answer(logout.runId, event.id, { cancel: true });
	}
});

test("/model rejects unknown models without switching", async () => {
	const { commands } = await setup();
	const events = await collect(commands, "model", "faux/nope");
	expect(events.at(-1)).toEqual({ type: "error", message: "unknown model faux/nope" });
});

test("/plugins and /skills list what is loaded", async () => {
	const { commands } = await setup();
	const text = async (name: string, args = "") =>
		(await collect(commands, name, args)).flatMap((event) => (event.type === "output" ? [event.text] : [])).join("\n");
	expect(await text("plugins")).toBe("plugins:\nskills: (no tools)\nsample: sample_lookup");
	// Bare /skills opens the checklist on the interactive TUI; the text list is /skills list.
	const skills = await text("skills", "list");
	expect(skills).toContain("programming");
	expect(skills).toContain("debugging");
	expect(skills).toContain("optimization");
	expect(skills).not.toContain("Review a change");
});

test("/login prompts on tui and answers by run and prompt id", async () => {
	const { commands } = await setup();
	const command = commands.find("login", "tui")!;
	const run = commands.run(command, "", request("tui"));
	const events: CommandEvent[] = [];
	for await (const event of run.events) {
		events.push(event);
		if (event.type !== "prompt") continue;
		const value = event.prompt.type === "select" ? "cursor" : "sk-test";
		expect(commands.answer(run.runId, event.id, { value })).toBe(true);
		expect(commands.answer(run.runId, event.id, { value })).toBe(false);
	}
	expect(events.filter((event) => event.type === "prompt").map((event) => event.type === "prompt" && event.prompt.type)).toEqual([
		"select",
		"secret",
	]);
	expect(events).toContainEqual({
		type: "output",
		level: "success",
		text: "Cursor as roach@example.com: logged in; no model transport in this build (api_key, stored as cursor)",
	});
	expect(events.at(-1)).toEqual({ type: "done" });
});

test("aborting a run rejects its pending prompt", async () => {
	const { commands } = await setup();
	const abort = new AbortController();
	const run = commands.run(commands.find("login", "tui")!, "anthropic", { ...request("tui"), signal: abort.signal });
	const events: CommandEvent[] = [];
	for await (const event of run.events) {
		events.push(event);
		if (event.type === "prompt") abort.abort();
	}
	expect(events.at(-1)).toEqual({ type: "error", message: "aborted" });
});

test("channel wrapper answers /help without a model call", async () => {
	const { commands } = await setup();
	const forwarded: string[] = [];
	const handle = withCommands(
		commands,
		async (inbound) => {
			forwarded.push(inbound.text);
			return { status: "answered", text: "model" };
		},
		context,
	);
	const help = await handle(message(" /help "));
	expect(help.status).toBe("answered");
	if (help.status !== "answered") throw new Error("Help did not answer");
	expect(help.text.split("\n").map((line) => line.split(" ")[0])).toEqual([
		"/fast", "/help", "/model", "/plugins", "/reasoning", "/search", "/sessions", "/skills",
	]);
	expect(await handle(message("hello"))).toEqual({ status: "answered", text: "model" });
	expect(forwarded).toEqual(["hello"]);
});

test("channel wrapper treats tui-only and disabled commands as unknown", async () => {
	const { commands } = await setup(["plugins"]);
	const handle = withCommands(commands, async () => ({ status: "answered", text: "model" }), context);
	expect(await handle(message("/login anthropic"))).toEqual({ status: "answered", text: "unknown command /login; try /help" });
	expect(await handle(message("/plugins"))).toEqual({ status: "answered", text: "unknown command /plugins; try /help" });
	expect(await handle(message("/model faux/faux-2"))).toEqual({ status: "answered", text: "model switched to faux/faux-2" });
});
