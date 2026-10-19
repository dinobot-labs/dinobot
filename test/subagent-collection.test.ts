import { afterEach, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { type Bot, openBot } from "../src/core/bot.ts";
import type { TaskDetails, TaskOutputDetails } from "../src/core/ui-contract.ts";
import { WAKE_PREFIX } from "../src/extensions/subagents.ts";

/**
 * ADR 0060 collection semantics of task_output: wake on the first uncollected settlement (not all listed children),
 * return each finished answer once, show a failed child's error.
 */
const context = BACKGROUND_CONTEXT;
const bots: Bot[] = [];
afterEach(async () => { for (const bot of bots.splice(0)) await bot.close(context); });

const LONG = "F".repeat(2000);

async function setup() {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	const release = Promise.withResolvers<void>();
	const ids: Record<string, string> = {};
	let request: Record<string, unknown> = {};
	const router: FauxResponseFactory = async (t) => {
		const user = t.messages.findLast((m) => m.role === "user")?.content;
		// The idle wake (ADR 0091) may start a turn between the test inputs; answer it without collecting anything.
		if (typeof user === "string" && user.startsWith(WAKE_PREFIX)) return fauxAssistantMessage("noted");
		if (user === "fast child") return fauxAssistantMessage(`Fast answer ${LONG}`);
		if (user === "slow child") { await release.promise; return fauxAssistantMessage("Slow answer"); }
		if (user === "broken child") throw new Error("model exploded");
		if (t.messages.at(-1)?.role === "toolResult") return fauxAssistantMessage("ok");
		if (user === "spawn") return fauxAssistantMessage(["fast", "slow", "broken"].map((name) => fauxToolCall("task", { description: name, prompt: `${name} child`, run_in_background: true })), { stopReason: "toolUse" });
		if (user === "collect") return fauxAssistantMessage(fauxToolCall("task_output", request as never), { stopReason: "toolUse" });
		throw new Error(`unexpected ${JSON.stringify(user)}`);
	};
	faux.setResponses(Array.from({ length: 60 }, () => router));
	const models = createModels();
	models.setProvider(faux.provider);
	const bot = await openBot({ storage: new MemoryStorage(), models, defaultModel: { provider: "faux", modelId: "faux-1" }, toolMode: "direct", plugins: [], settings: { retry: { enabled: false } } }, context);
	bots.push(bot);
	const parent = await bot.conversation("test", "collection", context);
	const say = async (content: string) => (await parent.submit({ type: "input", content }, context)).wait(context);
	const latest = async () => (await parent.entries({}, 100, undefined, context)).items.flatMap((e) => e.model ?? [])
		.find((m): m is ToolResultMessage => m.role === "toolResult" && m.toolName === "task_output")!;
	const collect = async (args: Record<string, unknown>) => {
		request = args;
		const t0 = performance.now();
		await say("collect");
		const result = await latest();
		return { ms: performance.now() - t0, text: JSON.stringify(result.content), details: result.details as TaskOutputDetails };
	};
	await say("spawn");
	const spawned = (await parent.entries({}, 100, undefined, context)).items.flatMap((e) => e.model ?? [])
		.filter((m): m is ToolResultMessage => m.role === "toolResult" && m.toolName === "task");
	for (const r of spawned) { const s = (r.details as TaskDetails).subagent; ids[s.description] = s.taskId; }
	return { ids, collect, release };
}

test("task_output wakes on the first new settlement, returns each answer once and shows failures", async () => {
	const { ids, collect, release } = await setup();
	try {
		// fast and broken settle quickly; slow is held. The call returns as soon as an uncollected child finished.
		const first = await collect({ task_ids: [ids.fast!, ids.slow!], timeout_ms: 5_000 });
		expect(first.ms).toBeLessThan(2_500);
		expect(first.text).toContain(LONG);
		expect(first.details.subagents.map((s) => s.status)).toEqual(["completed", "running"]);
		expect(first.text).toMatch(/\[running\] \d+ tool calls?/);

		// fast is collected: this call waits only for slow (the timeout), and does not re-emit fast's answer.
		const second = await collect({ task_ids: [ids.fast!, ids.slow!], timeout_ms: 1_000 });
		expect(second.ms).toBeGreaterThanOrEqual(950);
		expect(second.text).not.toContain(LONG);
		expect(second.text).toContain("already collected (2012 chars)");

		// The answer stays retrievable on request.
		const repeat = await collect({ task_ids: [ids.fast!], include_delivered: true });
		expect(repeat.text).toContain(LONG);

		// A child that failed before answering shows its error instead of an empty body.
		const broken = await collect({ task_ids: [ids.broken!] });
		expect(broken.details.subagents[0]!.status).toBe("failed");
		expect(broken.text).toMatch(/\[failed\]: \S/);
		expect(broken.text).not.toMatch(/\[failed\]: "/);

		release.resolve();
		const last = await collect({ task_ids: [ids.fast!, ids.slow!], timeout_ms: 5_000 });
		expect(last.ms).toBeLessThan(2_500);
		expect(last.text).toContain("Slow answer");
		expect(last.text).not.toContain(LONG);
	} finally {
		release.resolve();
	}
}, 30_000);
