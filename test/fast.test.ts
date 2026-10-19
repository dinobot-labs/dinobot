import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { CredentialStore, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createModels, type Provider } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ProviderDoc } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { AuthService } from "../src/auth/types.ts";
import { type CommandRequest, type Commands, createCommands } from "../src/commands/index.ts";
import type { CommandEvent } from "../src/commands/types.ts";
import { type Bot, openBot } from "../src/core/bot.ts";
import { ANTHROPIC_FAST_BETA, FastRouter, fastState, fastTier } from "../src/core/fast.ts";
import { currentThreadModel } from "../src/core/reasoning.ts";

const context = BACKGROUND_CONTEXT;
const bots: Bot[] = [];
const directories: string[] = [];
const auth: AuthService = {
	credentials: {} as CredentialStore,
	providers: async () => [],
	login: async () => { throw new Error("No login in fast tests"); },
	logout: async () => false,
	status: async () => [],
	accounts: async () => [],
	useAccount: async () => {
		throw new Error("no accounts");
	},
};

afterEach(async () => {
	for (const bot of bots.splice(0)) await bot.close(context);
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

function catalog() {
	const codex = fauxProvider({ provider: "openai-codex", models: [{ id: "gpt-6-sol" }, { id: "gpt-5.5" }] });
	const anthropic = fauxProvider({ provider: "anthropic", models: [{ id: "claude-opus-5-5" }] });
	const plain = fauxProvider({ provider: "faux", models: [{ id: "plain" }] });
	return { codex, anthropic, plain };
}

async function setup(path?: string, defaultModel = { provider: "openai-codex", modelId: "gpt-5.5" }) {
	if (path === undefined) {
		const directory = await mkdtemp(join(tmpdir(), "dinobot-fast-"));
		directories.push(directory);
		path = join(directory, "bot.sqlite");
	}
	const router = new FastRouter();
	const fauxes = catalog();
	const models = createModels();
	for (const faux of Object.values(fauxes)) models.setProvider(router.wrapProvider(faux.provider));
	const bot = await openBot({
		storage: await openNodeSqliteStorage(path), models, defaultModel, fastRouter: router,
		toolMode: "direct", plugins: [], settings: { retry: { enabled: false } },
	}, context);
	bots.push(bot);
	return { bot, models, router, path, ...fauxes, commands: createCommands({ bot, models, auth, plugins: [] }) };
}

function request(threadKey = "demo", surface: "tui" | "channel" = "tui"): CommandRequest {
	return { surface, channel: "test", threadKey, userId: "tester", context };
}

async function collect(commands: Commands, name: string, args: string, invocation = request()) {
	const command = commands.find(name, invocation.surface);
	if (!command) throw new Error(`Missing /${name}`);
	const events: CommandEvent[] = [];
	for await (const event of commands.run(command, args, invocation).events) events.push(event);
	return events;
}

const output = (events: readonly CommandEvent[]) => events.flatMap(event => event.type === "output" ? [event.text] : event.type === "error" ? [`error: ${event.message}`] : []).join("\n");

test("catalog lists fast models and Codex defaults only for openai-codex gpt-6-sol and gpt-6-luna", () => {
	expect(fastTier("openai", "gpt-5.5")).toEqual({ kind: "openai", default: false });
	expect(fastTier("openai", "gpt-6-sol")).toEqual({ kind: "openai", default: false });
	expect(fastTier("openai-codex", "gpt-6-sol")).toEqual({ kind: "openai", default: true });
	expect(fastTier("openai-codex", "gpt-6-luna")).toEqual({ kind: "openai", default: true });
	expect(fastTier("openai-codex", "gpt-6-astra")).toEqual({ kind: "openai", default: false });
	expect(fastTier("anthropic", "claude-opus-4-8")).toEqual({ kind: "anthropic", default: false });
	expect(fastTier("anthropic", "gpt-5.5")).toBeUndefined();
	expect(fastTier("faux", "plain")).toBeUndefined();
});

test("resolution: explicit choice wins, unset follows the catalog default, unsupported is never fast", () => {
	const models = createModels();
	for (const faux of Object.values(catalog())) models.setProvider(faux.provider);
	const sol = { provider: "openai-codex", modelId: "gpt-6-sol" };
	expect(fastState(models, sol, null)).toEqual({ fast: true, fastSupported: true });
	expect(fastState(models, sol, false)).toEqual({ fast: false, fastSupported: true });
	expect(fastState(models, { provider: "openai-codex", modelId: "gpt-5.5" }, null)).toEqual({ fast: false, fastSupported: true });
	expect(fastState(models, { provider: "openai-codex", modelId: "gpt-5.5" }, true)).toEqual({ fast: true, fastSupported: true });
	expect(fastState(models, { provider: "faux", modelId: "plain" }, true)).toEqual({ fast: false, fastSupported: false });
	expect(fastState(models, { provider: "openai", modelId: "gpt-5.5" }, true)).toEqual({ fast: false, fastSupported: false });
	expect(fastState(models, undefined, true)).toEqual({ fast: false, fastSupported: false });
});

function capturing(id: string) {
	const seen: (SimpleStreamOptions | undefined)[] = [];
	const provider = { id, streamSimple: (_model: unknown, _context: unknown, options?: SimpleStreamOptions) => { seen.push(options); return undefined; } } as unknown as Provider;
	return { seen, provider };
}

async function payloadFor(router: FastRouter, provider: string, modelId: string, payload: unknown, sessionId = "session", onPayload?: SimpleStreamOptions["onPayload"]) {
	const { seen, provider: inner } = capturing(provider);
	router.wrapProvider(inner).streamSimple({ provider, id: modelId } as never, { messages: [] } as never, { sessionId, ...(onPayload ? { onPayload } : {}) });
	const options = seen[0];
	return options?.onPayload ? await options.onPayload(payload, { provider, id: modelId } as never) : undefined;
}

test("wrapped providers rewrite fast sessions' payloads and leave everything else untouched", async () => {
	const router = new FastRouter();
	router.set("session", true);
	expect(await payloadFor(router, "openai", "gpt-5.5", { model: "gpt-5.5", input: [] })).toEqual({ model: "gpt-5.5", input: [], service_tier: "priority" });
	expect(await payloadFor(router, "openai-codex", "gpt-6-sol", { model: "gpt-6-sol" })).toEqual({ model: "gpt-6-sol", service_tier: "priority" });
	expect(await payloadFor(router, "anthropic", "claude-opus-5-5", { model: "claude-opus-5-5", betas: ["oauth-2025-04-20", "interleaved-thinking-2025-05-14"] })).toEqual({
		model: "claude-opus-5-5",
		speed: "fast",
		betas: ["oauth-2025-04-20", "interleaved-thinking-2025-05-14", ANTHROPIC_FAST_BETA],
	});
	expect(await payloadFor(router, "anthropic", "claude-opus-5-5", { betas: [ANTHROPIC_FAST_BETA] })).toEqual({ betas: [ANTHROPIC_FAST_BETA], speed: "fast" });
	expect(await payloadFor(router, "anthropic", "claude-opus-5", {})).toEqual({ speed: "fast", betas: [ANTHROPIC_FAST_BETA] });
	expect(await payloadFor(router, "faux", "plain", { model: "plain" })).toBeUndefined();
	expect(await payloadFor(router, "openai", "gpt-5.5", { model: "gpt-5.5" }, "unknown-session")).toBeUndefined();
	router.set("session", false);
	expect(await payloadFor(router, "openai", "gpt-5.5", { model: "gpt-5.5" })).toBeUndefined();
});

test("the caller's onPayload still runs and its replacement is the base of the fast rewrite", async () => {
	const router = new FastRouter();
	router.set("session", true);
	const calls: unknown[] = [];
	const own = (payload: unknown) => { calls.push(payload); return { ...(payload as object), caller: true }; };
	expect(await payloadFor(router, "openai", "gpt-5.5", { model: "gpt-5.5" }, "session", own)).toEqual({ model: "gpt-5.5", caller: true, service_tier: "priority" });
	expect(calls).toEqual([{ model: "gpt-5.5" }]);
	const { seen, provider } = capturing("openai");
	router.set("session", false);
	router.wrapProvider(provider).streamSimple({ provider: "openai", id: "gpt-5.5" } as never, { messages: [] } as never, { sessionId: "session", onPayload: own });
	expect(seen[0]?.onPayload).toBe(own);
});

test("/fast stores an explicit choice, reports it, and requests carry the fast payload", async () => {
	const { bot, commands, codex, router } = await setup();
	expect(output(await collect(commands, "fast", "", request("demo", "channel")))).toBe("fast: off");
	const on = await collect(commands, "fast", "on");
	expect(output(on)).toBe("fast mode on (next model request)");
	expect(on).toContainEqual({ type: "state", fast: true, fastSupported: true });
	expect(await currentThreadModel(bot, "test", "demo", context)).toMatchObject({ model: "openai-codex/gpt-5.5", fast: true, fastSupported: true });
	const payloads: unknown[] = [];
	codex.setResponses([async (_transcript, options, _state, model) => {
		payloads.push(await options?.onPayload?.({ model: model.id }, model));
		return fauxAssistantMessage("fast answer");
	}]);
	expect(await bot.handle({ channel: "test", threadKey: "demo", userId: "tester", messageId: "m1", text: "Hi" }, context)).toMatchObject({ status: "answered", text: "fast answer" });
	expect(payloads).toEqual([{ model: "gpt-5.5", service_tier: "priority" }]);
	const conversation = await bot.conversation("test", "demo", context);
	const provider = await bot.harness.snapshot(ProviderDoc, conversation.id, context);
	expect(router.isFast(provider?.sessionId)).toBe(true);
	expect(output(await collect(commands, "fast", "toggle"))).toBe("fast mode off (next model request)");
	expect(output(await collect(commands, "fast", "", request("demo", "channel")))).toBe("fast: off");
	expect(output(await collect(commands, "fast", "sideways"))).toBe('error: expected on, off or toggle, got "sideways"');
});

test("/fast rejects unsupported models and the choice survives model switches", async () => {
	const { commands } = await setup(undefined, { provider: "faux", modelId: "plain" });
	expect(output(await collect(commands, "fast", "", request("demo", "channel")))).toBe("Fast mode is unavailable for faux/plain.");
	expect(output(await collect(commands, "fast", "on"))).toBe("error: Fast mode is unavailable for faux/plain.");
	const rows = await commands.find("fast", "tui")!.arguments!(context, { channel: "test", threadKey: "demo" });
	expect(rows.map(row => [row.value, row.disabled ?? false, row.current ?? false])).toEqual([["on", true, false], ["off", true, false]]);
	const switched = await collect(commands, "model", "openai-codex/gpt-6-sol");
	expect(switched).toContainEqual(expect.objectContaining({ type: "state", model: "openai-codex/gpt-6-sol", fast: true, fastSupported: true }));
	expect(output(await collect(commands, "fast", "off"))).toBe("fast mode off (next model request)");
	await collect(commands, "model", "faux/plain");
	const back = await collect(commands, "model", "openai-codex/gpt-6-sol");
	expect(back).toContainEqual(expect.objectContaining({ type: "state", fast: false, fastSupported: true }));
	const current = await commands.find("fast", "tui")!.arguments!(context, { channel: "test", threadKey: "demo" });
	expect(current.filter(row => row.current).map(row => row.value)).toEqual(["off"]);
});

test("the explicit choice persists across reopened storage and seeds new threads", async () => {
	const first = await setup();
	await collect(first.commands, "fast", "on");
	await bots.splice(bots.indexOf(first.bot), 1)[0]!.close(context);
	const reopened = await setup(first.path);
	expect(output(await collect(reopened.commands, "fast", "", request("demo", "channel")))).toBe("fast: on");
	expect(await currentThreadModel(reopened.bot, "test", "fresh", context)).toMatchObject({ fast: true, fastSupported: true });
});

test("subagent children inherit the parent's fast choice", async () => {
	const { bot, commands, codex } = await setup();
	await collect(commands, "fast", "on");
	const payloads: unknown[] = [];
	codex.setResponses([
		() => fauxAssistantMessage(fauxToolCall("task", { description: "Fast child", prompt: "Answer the delegated question" }), { stopReason: "toolUse" }),
		async (_transcript, options, _state, model) => {
			payloads.push(await options?.onPayload?.({ model: model.id }, model));
			return fauxAssistantMessage("child answer");
		},
		() => fauxAssistantMessage("parent answer"),
	]);
	expect(await bot.handle({ channel: "test", threadKey: "demo", userId: "tester", messageId: "delegate", text: "Delegate" }, context)).toMatchObject({ status: "answered", text: "parent answer" });
	expect(payloads).toEqual([{ model: "gpt-5.5", service_tier: "priority" }]);
});
