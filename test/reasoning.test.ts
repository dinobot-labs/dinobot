import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { CredentialStore, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { clampThinkingLevel, createModels, getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { AgentDoc, configure } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { AuthService } from "../src/auth/types.ts";
import { type CommandRequest, type Commands, createCommands } from "../src/commands/index.ts";
import type { CommandEvent } from "../src/commands/types.ts";
import { type Bot, openBot } from "../src/core/bot.ts";

const context = BACKGROUND_CONTEXT;
const bots: Bot[] = [];
const directories: string[] = [];
const auth: AuthService = {
	credentials: {} as CredentialStore,
	providers: async () => [],
	login: async () => { throw new Error("No login in reasoning tests"); },
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

async function setup(path?: string) {
	if (path === undefined) {
		const directory = await mkdtemp(join(tmpdir(), "dinobot-reasoning-"));
		directories.push(directory);
		path = join(directory, "bot.sqlite");
	}
	const faux = fauxProvider({ provider: "faux", models: [
		{ id: "reasoner", reasoning: true },
		{ id: "plain", reasoning: false },
		{ id: "sparse", reasoning: true },
		{ id: "extended", reasoning: true },
	] });
	faux.getModel("sparse")!.thinkingLevelMap = { off: null, minimal: null, medium: null };
	faux.getModel("extended")!.thinkingLevelMap = { xhigh: "xhigh", max: "max" };
	const models = createModels();
	models.setProvider(faux.provider);
	const bot = await openBot({
		storage: await openNodeSqliteStorage(path), models,
		defaultModel: { provider: "faux", modelId: "reasoner" },
		toolMode: "direct", plugins: [], settings: { retry: { enabled: false } },
	}, context);
	bots.push(bot);
	return { bot, faux, models, path, commands: createCommands({ bot, models, auth, plugins: [] }) };
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

async function agent(bot: Bot, threadKey = "demo") {
	const conversation = await bot.conversation("test", threadKey, context);
	const snapshot = await bot.harness.snapshot(AgentDoc, conversation.id, context);
	if (!snapshot) throw new Error("Missing AgentDoc");
	if (snapshot.thinkingLevel === undefined) throw new Error("Missing configured reasoning level");
	return { ...snapshot, thinkingLevel: snapshot.thinkingLevel };
}

const output = (events: readonly CommandEvent[]) => events.flatMap(event => event.type === "output" ? [event.text] : []).join("\n");
const states = (events: readonly CommandEvent[]) => events.filter(event => event.type === "state");

for (const modelId of ["reasoner", "plain", "sparse", "extended"]) {
	test(`/reasoning picker and channel list respect ${modelId} capabilities`, async () => {
		const { bot, faux, commands } = await setup();
		await collect(commands, "model", `faux/${modelId}`);
		const before = await agent(bot);
		const supported = getSupportedThinkingLevels(faux.getModel(modelId)!);
		const run = commands.run(commands.find("reasoning", "tui")!, "", request());
		let prompts = 0;
		const events: CommandEvent[] = [];
		for await (const event of run.events) {
			events.push(event);
			if (event.type !== "prompt") continue;
			prompts++;
			expect(event.prompt.type).toBe("select");
			if (event.prompt.type !== "select") throw new Error("Expected reasoning selector");
			expect(event.prompt.options.map(option => option.id)).toEqual(supported);
			expect(event.prompt.options.filter(option => option.current).map(option => option.id)).toEqual([before.thinkingLevel]);
			expect(commands.answer(run.runId, event.id, { cancel: true })).toBe(true);
		}
		expect(prompts).toBe(modelId === "plain" ? 0 : 1);
		if (modelId === "plain") expect(output(events)).toMatch(/does not support reasoning/i);
		expect(await agent(bot)).toEqual(before);
		const listed = await collect(commands, "reasoning", "", request("demo", "channel"));
		expect(listed.some(event => event.type === "prompt")).toBe(false);
		for (const level of supported) expect(output(listed)).toContain(level);
		expect(output(listed)).toContain(before.thinkingLevel);
		expect(await agent(bot)).toEqual(before);
	});
}

test("explicit reasoning levels persist and emit effective state", async () => {
	const { bot, faux, commands } = await setup();
	for (const level of ["low", "high", "off"] as const) {
		const events = await collect(commands, "reasoning", level);
		expect(events.at(-1)).toEqual({ type: "done" });
		expect(states(events)).toContainEqual(expect.objectContaining({ thinkingLevel: level, supportedThinkingLevels: getSupportedThinkingLevels(faux.getModel()) }));
		expect((await agent(bot)).thinkingLevel).toBe(level);
	}
});

test("a picker selection and extended reasoning levels update durable state", async () => {
	const { bot, commands } = await setup();
	const run = commands.run(commands.find("reasoning", "tui")!, "", request());
	const events: CommandEvent[] = [];
	for await (const event of run.events) {
		events.push(event);
		if (event.type === "prompt") commands.answer(run.runId, event.id, { value: "high" });
	}
	expect(events.at(-1)?.type).toBe("done");
	expect((await agent(bot)).thinkingLevel).toBe("high");
	await collect(commands, "model", "faux/extended");
	for (const level of ["xhigh", "max"] as const) {
		expect((await collect(commands, "reasoning", level)).at(-1)?.type).toBe("done");
		expect((await agent(bot)).thinkingLevel).toBe(level);
	}
});

test("unsupported, unknown, auto, and toggle arguments fail without durable mutation", async () => {
	const { bot, commands } = await setup();
	await collect(commands, "reasoning", "low");
	for (const value of ["auto", "toggle", "xhigh", "max", "bogus", "high extra"]) {
		const before = await agent(bot);
		const events = await collect(commands, "reasoning", value);
		expect(events.at(-1)?.type).toBe("error");
		expect(states(events)).toEqual([]);
		expect(await agent(bot)).toEqual(before);
	}
	await collect(commands, "model", "faux/plain");
	const before = await agent(bot);
	expect((await collect(commands, "reasoning", "high")).at(-1)?.type).toBe("error");
	expect(await agent(bot)).toEqual(before);
});

test("cycle wraps and skips unsupported sparse levels", async () => {
	const { bot, faux, commands } = await setup();
	await collect(commands, "reasoning", "off");
	const supported = getSupportedThinkingLevels(faux.getModel());
	for (const level of [...supported.slice(1), supported[0]!]) {
		expect((await collect(commands, "reasoning", "cycle")).at(-1)?.type).toBe("done");
		expect((await agent(bot)).thinkingLevel).toBe(level);
	}
	await collect(commands, "model", "faux/sparse");
	await collect(commands, "reasoning", "high");
	await collect(commands, "reasoning", "cycle");
	expect((await agent(bot)).thinkingLevel).toBe("low");
	await collect(commands, "reasoning", "cycle");
	expect((await agent(bot)).thinkingLevel).toBe("high");
	const before = await agent(bot);
	expect((await collect(commands, "reasoning", "off")).at(-1)?.type).toBe("error");
	expect(await agent(bot)).toEqual(before);
});

test("concurrent cycle commands advance once per serialized durable transaction", async () => {
	const { bot, faux, commands } = await setup();
	await collect(commands, "reasoning", "off");
	const supported = getSupportedThinkingLevels(faux.getModel());
	const results = await Promise.all(supported.map(() => collect(commands, "reasoning", "cycle")));
	for (const events of results) expect(events.at(-1)?.type).toBe("done");
	expect(results.flatMap(states).map(event => event.thinkingLevel).sort()).toEqual([...supported].sort());
	expect((await agent(bot)).thinkingLevel).toBe("off");
});

test("cycling an unsupported model does not replace another thread's saved reasoning default", async () => {
	const { bot, commands } = await setup();
	await collect(commands, "model", "faux/plain", request("plain"));
	await collect(commands, "model", "faux/reasoner");
	await collect(commands, "reasoning", "high");
	const before = await agent(bot, "plain");
	expect((await collect(commands, "reasoning", "cycle", request("plain"))).at(-1)?.type).toBe("error");
	expect(await agent(bot, "plain")).toEqual(before);
	expect((await agent(bot, "new")).thinkingLevel).toBe("high");
});

test("reasoning survives restart and new threads inherit the latest selection without changing existing threads", async () => {
	const first = await setup();
	await collect(first.commands, "reasoning", "low", request("old"));
	await collect(first.commands, "reasoning", "high");
	expect((await agent(first.bot, "new-before-restart")).thinkingLevel).toBe("high");
	expect((await agent(first.bot, "old")).thinkingLevel).toBe("low");
	await first.bot.close(context);
	bots.splice(bots.indexOf(first.bot), 1);
	const second = await setup(first.path);
	expect((await agent(second.bot)).thinkingLevel).toBe("high");
	expect((await agent(second.bot, "old")).thinkingLevel).toBe("low");
	expect((await agent(second.bot, "new-after-restart")).thinkingLevel).toBe("high");
});

test("model switches publish the clamped reasoning alongside the model and explain adjustment", async () => {
	const { bot, faux, commands } = await setup();
	await collect(commands, "reasoning", "medium");
	for (const modelId of ["sparse", "plain"]) {
		const before = (await agent(bot)).thinkingLevel;
		const model = faux.getModel(modelId)!;
		const expected = clampThinkingLevel(model, before);
		const events = await collect(commands, "model", `faux/${modelId}`);
		expect(states(events)).toEqual([expect.objectContaining({ model: `faux/${modelId}`, thinkingLevel: expected, supportedThinkingLevels: getSupportedThinkingLevels(model) })]);
		expect(await agent(bot)).toMatchObject({ model: { provider: "faux", modelId }, thinkingLevel: expected });
		expect(output(events)).toMatch(/reasoning|thinking/i);
		expect(output(events)).toContain(expected);
	}
});

test("aborting or cancelling a reasoning picker does not mutate AgentDoc or the saved default", async () => {
	const { bot, commands } = await setup();
	await collect(commands, "reasoning", "low");
	for (const mode of ["cancel", "abort"]) {
		const before = await agent(bot);
		const abort = new AbortController();
		const run = commands.run(commands.find("reasoning", "tui")!, "", { ...request(), signal: abort.signal });
		const events: CommandEvent[] = [];
		for await (const event of run.events) {
			events.push(event);
			if (event.type !== "prompt") continue;
			if (mode === "abort") abort.abort();
			else commands.answer(run.runId, event.id, { cancel: true });
		}
		expect(events.some(event => event.type === "prompt")).toBe(true);
		expect(states(events).every(event => event.thinkingLevel === before.thinkingLevel)).toBe(true);
		expect(await agent(bot)).toEqual(before);
		expect((await agent(bot, `after-${mode}`)).thinkingLevel).toBe("low");
	}
});

test("a picker answer is checked against the model at commit time", async () => {
	const { bot, commands } = await setup();
	await collect(commands, "reasoning", "low");
	const run = commands.run(commands.find("reasoning", "tui")!, "", request());
	const events: CommandEvent[] = [];
	for await (const event of run.events) {
		events.push(event);
		if (event.type !== "prompt") continue;
		await collect(commands, "model", "faux/plain");
		commands.answer(run.runId, event.id, { value: "high" });
	}
	expect(events.some(event => event.type === "prompt")).toBe(true);
	expect(events.at(-1)?.type).toBe("error");
	expect(states(events).every(event => event.thinkingLevel === "low")).toBe(true);
	expect(await agent(bot)).toMatchObject({ model: { provider: "faux", modelId: "plain" }, thinkingLevel: "off" });
});

test("chosen reasoning reaches generation options and a foreground child inherits it", async () => {
	const { bot, faux, commands } = await setup();
	await collect(commands, "reasoning", "high");
	const seen: (ModelThinkingLevel | undefined)[] = [];
	faux.setResponses([
		(_transcript, options) => {
			seen.push(options?.reasoning);
			return fauxAssistantMessage(fauxToolCall("task", { description: "Reasoning child", prompt: "Answer the delegated question" }), { stopReason: "toolUse" });
		},
		(_transcript, options) => { seen.push(options?.reasoning); return fauxAssistantMessage("child answer"); },
		(_transcript, options) => { seen.push(options?.reasoning); return fauxAssistantMessage("parent answer"); },
	]);
	expect(await bot.handle({ channel: "test", threadKey: "demo", userId: "tester", messageId: "generation", text: "Delegate one question" }, context)).toMatchObject({ status: "answered", text: "parent answer" });
	expect(seen).toEqual(["high", "high", "high"]);
	const parent = await bot.conversation("test", "demo", context);
	const children = await bot.harness.commit(tx => tx.scanConversations({ ownerConversationId: parent.id }, 10), context);
	expect(children.items).toHaveLength(1);
	expect((await bot.harness.snapshot(AgentDoc, children.items[0]!.id, context))?.thinkingLevel).toBe("high");
});

test("changing reasoning during generation affects the next request, not the prepared request", async () => {
	const { bot, faux, commands } = await setup();
	await collect(commands, "reasoning", "high");
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const seen: (ModelThinkingLevel | undefined)[] = [];
	faux.setResponses([
		async (_transcript, options) => {
			seen.push(options?.reasoning);
			started.resolve();
			await release.promise;
			return fauxAssistantMessage("first");
		},
		(_transcript, options) => {
			seen.push(options?.reasoning);
			return fauxAssistantMessage("second");
		},
	]);
	const first = bot.handle({ channel: "test", threadKey: "demo", userId: "tester", messageId: "in-flight", text: "First" }, context);
	await started.promise;
	try {
		await collect(commands, "reasoning", "off");
		expect((await agent(bot)).thinkingLevel).toBe("off");
		expect(seen).toEqual(["high"]);
	} finally {
		release.resolve();
	}
	expect(await first).toMatchObject({ status: "answered", text: "first" });
	expect(await bot.handle({ channel: "test", threadKey: "demo", userId: "tester", messageId: "after-flight", text: "Second" }, context)).toMatchObject({ status: "answered", text: "second" });
	expect(seen).toEqual(["high", undefined]);
});

test("a restored thread with an unsupported level is normalized before generation without replacing supported choices", async () => {
	const { bot, faux, commands } = await setup();
	await collect(commands, "reasoning", "high", request("supported"));
	const conversation = await bot.conversation("test", "restored", context);
	await bot.harness.commit(tx => configure(tx, conversation.id, { model: { provider: "faux", modelId: "sparse" }, thinkingLevel: null }), context);
	const seen: (ModelThinkingLevel | undefined)[] = [];
	faux.setResponses([(_transcript, options) => {
		seen.push(options?.reasoning);
		return fauxAssistantMessage("normalized");
	}]);
	expect(await bot.handle({ channel: "test", threadKey: "restored", userId: "tester", messageId: "restore", text: "Answer" }, context)).toMatchObject({ status: "answered", text: "normalized" });
	expect(seen).toEqual(["low"]);
	expect((await agent(bot, "restored")).thinkingLevel).toBe("low");
	expect((await agent(bot, "supported")).thinkingLevel).toBe("high");
	expect((await agent(bot, "new")).thinkingLevel).toBe("high");
});
