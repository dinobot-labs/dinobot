import { afterEach, describe, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonObject, ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { type AskRecord, AsksDoc, openAsksFrom } from "../src/core/ask.ts";
import { type Bot, openBot } from "../src/core/bot.ts";
import { AgentsDoc, scanWake, wakeReader } from "../src/extensions/subagents.ts";

/**
 * Regressions for two counterexamples found by model checking the ask protocol (TLA+, ADR 0030):
 * F1, a foreground task wait ignored the open ask of another (background) subagent, which then ran into its default;
 * F2, the ask of a killed subagent stayed open and was still reported as waiting for main's answer.
 * Interleavings are forced by the router: the orchestrator's next step is held until the ask record is durably open.
 */
const context = BACKGROUND_CONTEXT;
const bots: Bot[] = [];
afterEach(async () => {
	for (const bot of bots.splice(0)) await bot.close(context).catch(() => undefined);
});

type Transcript = Parameters<FauxResponseFactory>[0];
const str = (c: unknown) => typeof c === "string" ? c : JSON.stringify(c ?? "");
const lastUser = (t: Transcript) => str(t.messages.findLast((m) => m.role === "user")?.content);
const turnResults = (t: Transcript) => t.messages.slice(t.messages.findLastIndex((m) => m.role === "user") + 1)
	.filter((m): m is ToolResultMessage => m.role === "toolResult");
const lastResult = (t: Transcript) => {
	const r = turnResults(t).at(-1);
	return { name: r?.toolName, text: str(r?.content), isError: r?.isError === true };
};
const call = (name: string, args: JsonObject) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

async function setup(router: FauxResponseFactory) {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	faux.setResponses(Array.from({ length: 60 }, () => router));
	const models = createModels();
	models.setProvider(faux.provider);
	const bot = await openBot({ storage: new MemoryStorage(), models, defaultModel: { provider: "faux", modelId: "faux-1" }, toolMode: "direct", plugins: [], settings: { retry: { enabled: false } } }, context);
	bots.push(bot);
	const parent = await bot.conversation("test", "formal-repro", context);
	const run = async (content: string) => (await parent.submit({ type: "input", content }, context)).wait(context);
	const asks = async () => (await bot.harness.snapshot(AsksDoc, parent.id, context))?.asks ?? [];
	return { bot, parent, run, asks };
}

/** Child conversation: ask once, then report what it proceeded with. */
const childTurn = (t: Transcript, ask: JsonObject) => lastResult(t).name === "ask"
	? fauxAssistantMessage(`child proceeded with ${lastResult(t).text}`)
	: call("ask", ask);

async function until<T>(probe: () => Promise<T | undefined>, ms = 5000): Promise<T> {
	const end = Date.now() + ms;
	for (;;) {
		const value = await probe();
		if (value !== undefined) return value;
		if (Date.now() > end) throw new Error("until: timed out");
		await Bun.sleep(10);
	}
}

describe("F1: a foreground task wait returns on another subagent's ask", () => {
	test("SpawnBg(c2) -> ChildAsk(c2) -> SpawnFg(c1): the foreground wait returns with c2's ask and main answers it", async () => {
		const ASK_DEADLINE_MS = 5000;
		let env: { asks: () => Promise<AskRecord[]> } | undefined;
		let fgText = "";
		let fgEnd = 0;
		const router: FauxResponseFactory = async (t) => {
			const user = lastUser(t);
			if (user === "ASKER") return childTurn(t, { question: "Proceed with plan X?", kind: "decision", options: ["yes", "no"], default: "dflt", deadline_ms: ASK_DEADLINE_MS });
			if (user === "SLOW") { await Bun.sleep(300); return fauxAssistantMessage("slow done"); }
			if (user !== "START") return fauxAssistantMessage("ok");
			const r = lastResult(t);
			const tasks = turnResults(t).filter((m) => m.toolName === "task").length;
			if (tasks === 0) return call("task", { description: "c2 asker", prompt: "ASKER", run_in_background: true });
			if (tasks === 1) {
				await until(async () => (await env!.asks()).find((a) => a.state === "open"));
				return call("task", { description: "c1 slow", prompt: "SLOW" });
			}
			if (r.name === "task") {
				fgText = r.text; fgEnd = Date.now();
				const open = (await env!.asks()).find((a) => a.state === "open");
				if (open) return call("answer", { ask_id: open.id, answer: "yes" });
			}
			return fauxAssistantMessage("main done");
		};
		const s = await setup(router);
		env = s;
		expect((await s.run("START")).status).toBe("done");
		const [ask] = await s.asks();
		expect(fgText).toContain("waiting for your answer");
		expect(fgText).toContain(ask!.id);
		expect(fgEnd).toBeLessThan(ask!.deadlineAt);
		expect(ask).toMatchObject({ state: "answered", answer: "yes" });
		// The awaited child keeps running in the background and is collected later.
		const agents = (await s.bot.harness.snapshot(AgentsDoc, s.parent.id, context))!.agents;
		expect(agents.find((a) => a.taskId !== ask!.from.taskId)?.background).toBe(true);
	}, 20_000);
});

describe("F2: a cancelled subagent's ask is not reported as pending", () => {
	test("SpawnBg(c1) -> ChildAsk(c1) -> kill_task(c1): the ask is withdrawn; wake scan and task_output do not list it", async () => {
		let env: { asks: () => Promise<AskRecord[]> } | undefined;
		let collectText = "";
		const router: FauxResponseFactory = async (t) => {
			const user = lastUser(t);
			if (user === "ASKER") return childTurn(t, { question: "Delete the cache?", kind: "decision", options: ["yes", "no"], default: "no", deadline_ms: 60_000 });
			const r = lastResult(t);
			if (user === "START") {
				if (r.name === undefined) return call("task", { description: "c1 asker", prompt: "ASKER", run_in_background: true });
				if (r.name === "task") {
					const taskId = /Started (\S+)\./.exec(r.text)?.[1] ?? "";
					await until(async () => (await env!.asks()).find((a) => a.state === "open"));
					return call("kill_task", { task_id: taskId });
				}
				return fauxAssistantMessage("killed");
			}
			if (user === "COLLECT") {
				if (r.name === undefined) return call("task_output", { block: false });
				collectText = r.text;
				return fauxAssistantMessage("collected");
			}
			return fauxAssistantMessage("ok");
		};
		const s = await setup(router);
		env = s;
		expect((await s.run("START")).status).toBe("done");
		const ask = (await s.asks())[0]!;
		expect(ask).toMatchObject({ state: "withdrawn", resolvedBy: "system:cancelled" });
		const scan = await scanWake(wakeReader(s.bot.harness, s.parent.id, context));
		expect(scan.events.some((e) => e.key === `ask:${ask.id}`)).toBe(false);
		expect((await s.run("COLLECT")).status).toBe("done");
		expect(collectText).not.toContain("waiting for your answer");
		expect(collectText).not.toContain(ask.id);
	}, 20_000);
});

describe("openAsksFrom", () => {
	test("excludes an open record past its deadline: its answer is already the default", () => {
		const base = { kind: "decision", question: "q", default: "d", to: "main", state: "open", createdAt: 0, refs: [] } as unknown as AskRecord;
		const from = { conversationId: "c1" } as unknown as AskRecord["from"];
		const doc = { asks: [{ ...base, id: "late", from, deadlineAt: 100 }, { ...base, id: "live", from, deadlineAt: 300 }] as AskRecord[] };
		expect(openAsksFrom(doc, new Set([from.conversationId]), 200).map((a) => a.id)).toEqual(["live"]);
	});
});
