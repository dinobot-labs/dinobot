import { afterEach, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { AsksDoc } from "../src/core/ask.ts";
import { type Bot, openBot } from "../src/core/bot.ts";
import { WAKE_PREFIX } from "../src/extensions/subagents.ts";

/**
 * ADR 0091: an orchestrator that already answered is woken once per new background event (a finished child, an open
 * ask to main), never while it is busy, never for an event it already collected; and one blocking task_output wait is capped.
 */
const context = BACKGROUND_CONTEXT;
const bots: Bot[] = [];
afterEach(async () => { for (const bot of bots.splice(0)) await bot.close(context); });

const text = (content: unknown) => typeof content === "string" ? content : JSON.stringify(content);

async function setup(options: { maxWaitMs?: number } = {}) {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	const release = Promise.withResolvers<void>();
	const wakes: string[] = [];
	let collectArgs: Record<string, unknown> = {};
	const router: FauxResponseFactory = async (t) => {
		const user = text(t.messages.findLast((m) => m.role === "user")?.content);
		const last = t.messages.at(-1);
		// Children.
		if (user === "slow child") { await release.promise; return fauxAssistantMessage("Slow answer"); }
		if (user === "asking child") {
			if (last?.role === "toolResult") return fauxAssistantMessage(`child got ${text(last.content)}`);
			return fauxAssistantMessage(fauxToolCall("ask", { question: "Which colour?", kind: "decision", options: ["red", "blue"], default: "red" }), { stopReason: "toolUse" });
		}
		// Parent.
		if (user.startsWith(WAKE_PREFIX)) {
			if (last?.role === "user") {
				wakes.push(user);
				const ask = /ask (\S+) from/.exec(user)?.[1];
				if (ask) return fauxAssistantMessage(fauxToolCall("answer", { ask_id: ask, answer: "blue" }), { stopReason: "toolUse" });
				return fauxAssistantMessage(fauxToolCall("task_output", { block: false }), { stopReason: "toolUse" });
			}
			return fauxAssistantMessage("reported to the user");
		}
		if (last?.role === "toolResult") return fauxAssistantMessage("started; I will report back");
		if (user === "spawn slow") return fauxAssistantMessage(fauxToolCall("task", { description: "slow", prompt: "slow child", run_in_background: true }), { stopReason: "toolUse" });
		if (user === "spawn asking") return fauxAssistantMessage(fauxToolCall("task", { description: "asking", prompt: "asking child", run_in_background: true }), { stopReason: "toolUse" });
		if (user === "collect") return fauxAssistantMessage(fauxToolCall("task_output", collectArgs as never), { stopReason: "toolUse" });
		throw new Error(`unexpected ${user}`);
	};
	faux.setResponses(Array.from({ length: 80 }, () => router));
	const models = createModels();
	models.setProvider(faux.provider);
	const bot = await openBot({
		storage: new MemoryStorage(), models, defaultModel: { provider: "faux", modelId: "faux-1" }, toolMode: "direct", plugins: [],
		settings: { retry: { enabled: false } }, ...(options.maxWaitMs ? { taskOutputMaxWaitMs: options.maxWaitMs } : {}),
	}, context);
	bots.push(bot);
	const parent = await bot.conversation("test", "wake", context);
	const say = async (content: string) => (await parent.submit({ type: "input", content }, context)).wait(context);
	const messages = async () => (await parent.entries({}, 200, undefined, context)).items.flatMap((e) => e.model ?? []) as Message[];
	const toolResults = async (name: string) => (await messages()).filter((m): m is ToolResultMessage => m.role === "toolResult" && m.toolName === name);
	const until = async (what: string, ok: () => Promise<boolean>, ms = 10_000) => {
		const end = Date.now() + ms;
		while (!(await ok())) {
			if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
			await Bun.sleep(20);
		}
	};
	const watcherLive = async () => (await bot.harness.inspect(context)).tasks.some((task) => task.record.kind === "dinobot.subagent.wake");
	return { bot, parent, say, release, wakes, toolResults, until, watcherLive, setCollect: (args: Record<string, unknown>) => { collectArgs = args; } };
}

test("a child that finishes after the parent answered wakes it once, and the woken turn collects the answer", async () => {
	const { say, release, wakes, toolResults, until, watcherLive } = await setup();
	await say("spawn slow");
	expect(wakes).toEqual([]);
	expect(await watcherLive()).toBe(true);
	release.resolve();
	await until("the woken turn's collection", async () => (await toolResults("task_output")).some((r) => text(r.content).includes("Slow answer")));
	await until("the watcher to end", async () => !(await watcherLive()));
	expect(wakes).toHaveLength(1);
	expect(wakes[0]).toContain("finished: completed");
	// Nothing new happened: no second wake.
	await Bun.sleep(300);
	expect(wakes).toHaveLength(1);
}, 20_000);

test("a child's ask to an idle parent wakes it before the deadline, and the parent's answer reaches the child", async () => {
	const { bot, parent, say, wakes, toolResults, until, watcherLive } = await setup();
	await say("spawn asking");
	await until("the ask wake", async () => wakes.some((w) => w.includes("Which colour?")));
	await until("the child's completion wake to be collected", async () => (await toolResults("task_output")).some((r) => text(r.content).includes("child got") && text(r.content).includes("answered: blue")));
	await until("the watcher to end", async () => !(await watcherLive()));
	const asks = (await bot.harness.snapshot(AsksDoc, parent.id, context))?.asks ?? [];
	expect(asks.map((a) => [a.state, a.answer])).toEqual([["answered", "blue"]]);
	expect(wakes).toHaveLength(2);
}, 20_000);

test("an event the busy parent collects itself never causes a wake", async () => {
	const { say, release, wakes, toolResults, until, watcherLive, setCollect } = await setup();
	await say("spawn slow");
	setCollect({ timeout_ms: 10_000 });
	const collecting = say("collect");
	await Bun.sleep(200);
	release.resolve();
	await collecting;
	expect((await toolResults("task_output")).some((r) => text(r.content).includes("Slow answer"))).toBe(true);
	await until("the watcher to end", async () => !(await watcherLive()));
	await Bun.sleep(300);
	expect(wakes).toEqual([]);
}, 20_000);

test("one blocking task_output wait is capped and tells the model to report progress", async () => {
	const { say, release, toolResults, setCollect } = await setup({ maxWaitMs: 400 });
	try {
		await say("spawn slow");
		setCollect({ timeout_ms: 3_600_000 });
		const t0 = performance.now();
		await say("collect");
		expect(performance.now() - t0).toBeLessThan(5_000);
		const result = (await toolResults("task_output")).at(-1)!;
		expect(text(result.content)).toContain("Waited the 400-millisecond maximum");
	} finally {
		release.resolve();
	}
}, 20_000);
