import { afterEach, describe, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonObject, ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, MemoryStorage } from "@earendil-works/pi-durable";
import { AsksDoc } from "../src/core/ask.ts";
import { type Bot, openBot } from "../src/core/bot.ts";
import { RunDoc } from "../src/core/dag.ts";
import { AgentsDoc, ProgressDoc } from "../src/extensions/subagents.ts";

/**
 * ADR 0060 through the real tools: dag_step opens an ask record for an ask node, the human (authority) or the
 * orchestrator (decision) answers it with the existing answer tool, and the next dag_step settles the node.
 */
const context = BACKGROUND_CONTEXT;
const bots: Bot[] = [];
afterEach(async () => { for (const bot of bots.splice(0)) await bot.close(context); });

type Transcript = Parameters<FauxResponseFactory>[0];
const lastUser = (t: Transcript) => String(t.messages.findLast((m) => m.role === "user")?.content ?? "");
const turnResults = (t: Transcript) => t.messages.slice(t.messages.findLastIndex((m) => m.role === "user") + 1).filter((m): m is ToolResultMessage => m.role === "toolResult");
const call = (name: string, args: JsonObject) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

type Control = { plan: JsonObject; plan2?: JsonObject; replans?: JsonObject[]; askId?: string; childAsks?: boolean; runId?: string };

/** Node subagents establish their node; verify nodes pass every covered requirement; `b` asks once when told to. */
function child(t: Transcript, ctl: Control): ReturnType<typeof fauxAssistantMessage> {
	const user = lastUser(t);
	const node = /plan node "([^"]+)"/.exec(user)![1]!;
	const contract = JSON.parse(/Goal and node contract: (.*)\n/.exec(user)![1]!) as { node: { kind: string; covers?: string[] } };
	if (node === "b" && ctl.childAsks && turnResults(t).length === 0) return call("ask", { question: "Which flavour for b?", kind: "decision", default: "vanilla" });
	if (contract.node.kind === "verify") {
		return fauxAssistantMessage(JSON.stringify({ version: 1, requirements: contract.node.covers!.map((id) => ({ id, verdict: "pass", evidence: "fixture checked" })), summary: "ok", repairable: false }));
	}
	return fauxAssistantMessage(`established ${node}`);
}

async function setup(ctl: Control) {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	const router: FauxResponseFactory = async (t) => {
		const user = lastUser(t);
		if (/plan node "/.test(user)) return child(t, ctl);
		if (turnResults(t).length) return fauxAssistantMessage("ok");
		if (user === "PLAN") return call("dag_run", { plan: ctl.plan });
		if (user === "PLAN2") return call("dag_run", { plan: ctl.plan2! });
		if (user === "STEP") return call("dag_step", {});
		if (user.startsWith("STEP:")) return call("dag_step", { run_id: user.slice(5) });
		if (user.startsWith("REPLAN:")) return call("dag_run", { plan: ctl.replans![Number(user.slice(7))]!, run_id: ctl.runId! });
		if (user === "CANCEL") return call("dag_step", { cancel: true, reason: "operator stop" });
		if (user === "REPLAN") return call("dag_run", { plan: ctl.plan, run_id: ctl.runId! });
		if (user === "ASK") return call("ask", { question: "Drop the legacy table?", kind: "authority", default: "deny", to: "human", refs: ["drop"] });
		if (user === "DECIDE") return call("answer", { ask_id: ctl.askId!, answer: "use mint" });
		// Any other input is the human's reply to an authority ask: relay it with its own text as the quote.
		return call("answer", { ask_id: ctl.askId!, answer: user, quote: user });
	};
	faux.setResponses(Array.from({ length: 200 }, () => router));
	const models = createModels();
	models.setProvider(faux.provider);
	const bot = await openBot({ storage: new MemoryStorage(), models, defaultModel: { provider: "faux", modelId: "faux-1" }, toolMode: "direct", plugins: [], settings: { retry: { enabled: false } } }, context);
	bots.push(bot);
	const parent = await bot.conversation("test", "ask-nodes", context);
	// Explicit-step fixtures freeze autonomous scheduling to inspect intermediate admission states.
	await parent.configure({extensions:{remove:[defineExtension({name:"dag-continuation"})]}},context);
	const say = async (content: string) => (await parent.submit({ type: "input", content }, context)).wait(context);
	const run = async (id?: string) => { const runs = (await bot.harness.snapshot(RunDoc, parent.id, context))!.runs; return id ? runs.find((r) => r.id === id)! : runs.at(-1)!; };
	const asks = async () => (await bot.harness.snapshot(AsksDoc, parent.id, context))?.asks ?? [];
	const lastText = async (tool: string) => {
		const results = (await parent.entries({}, 50, undefined, context)).items.flatMap((e) => e.model ?? []).filter((m): m is ToolResultMessage => m.role === "toolResult" && m.toolName === tool);
		return JSON.stringify(results[0]?.content ?? "");
	};
	/** Step until the run leaves `running` (children are faux and finish quickly). */
	const settle = async () => {
		for (let i = 0; i < 60 && (await run()).status === "running"; i++) { await Bun.sleep(20); await say("STEP"); }
		return run();
	};
	return { bot, parent, say, run, asks, lastText, settle };
}

const deletion = (): JsonObject => ({
	nodes: [
		{ id: "q", kind: "ask", description: "Drop the legacy table?" },
		{ id: "drop", kind: "act", irreversible: true, writes: ["db"] },
		{ id: "v", kind: "verify", reads: ["db"], covers: ["R"] },
	],
	edges: [["q", "drop"], ["drop", "v"]],
	goal: { requirements: ["R"] },
});

describe("ask nodes settle through the existing ask/answer protocol", () => {
	test("a human approval runs the irreversible node and the run verifies", async () => {
		const ctl: Control = { plan: deletion() };
		const h = await setup(ctl);
		await h.say("PLAN");
		await h.say("STEP");
		let r = await h.run();
		expect(r.nodes.q!.status).toBe("waiting");
		expect(r.nodes.q!.ask?.refs).toEqual(["drop"]);
		const record = (await h.asks()).find((a) => a.id === r.nodes.q!.ask!.id)!;
		expect(record).toMatchObject({ to: "human", kind: "authority", refs: ["drop"], options: ["approve", "deny"], default: "deny", state: "open" });
		expect(record.question).toContain("Drop the legacy table?");
		expect(await h.lastText("dag_step")).toContain("ask node q needs human authority for drop");
		ctl.askId = record.id;
		await h.say("approve");
		expect((await h.asks()).find((a) => a.id === record.id)).toMatchObject({ state: "answered", answer: "approve" });
		r = await h.settle();
		expect(r.status).toBe("verified");
		expect(r.nodes.q!.result).toContain("authority granted by human:");
		expect(r.nodes.drop!.runs).toBe(1);
	}, 30_000);

	test("a human refusal fails the ask node without retry and never dispatches the irreversible node", async () => {
		const ctl: Control = { plan: deletion() };
		const h = await setup(ctl);
		await h.say("PLAN");
		await h.say("STEP");
		ctl.askId = (await h.run()).nodes.q!.ask!.id;
		await h.say("deny");
		await h.say("STEP");
		const r = await h.run();
		expect(r.nodes.q!.status).toBe("failed");
		expect(r.status).toBe("blocked");
		expect(r.reason).toContain("q (attempt 1: authority not granted");
		expect(r.nodes.drop!.runs).toBe(0);
		expect((await h.bot.harness.snapshot(AgentsDoc, h.parent.id, context))?.agents ?? []).toEqual([]);
		// A replan re-opens the ask node with a fresh question: the refusal is never reused as an answer.
		ctl.runId = r.id;
		await h.say("REPLAN");
		await h.say("STEP");
		const again = await h.run();
		expect(again.nodes.q!.status).toBe("waiting");
		expect(again.nodes.q!.ask!.id).not.toBe(ctl.askId);
		expect((await h.asks()).find((a) => a.id === again.nodes.q!.ask!.id)).toMatchObject({ state: "open", refs: ["drop"] });
	}, 30_000);

	test("an ask node without irreversible descendants is the orchestrator's own decision", async () => {
		const ctl: Control = {
			plan: {
				nodes: [{ id: "q", kind: "ask", description: "Which flavour?" }, { id: "a", kind: "act", writes: ["x"] }, { id: "v", kind: "verify", reads: ["x"], covers: ["R"] }],
				edges: [["q", "a"], ["a", "v"]], goal: { requirements: ["R"] },
			},
		};
		const h = await setup(ctl);
		await h.say("PLAN");
		await h.say("STEP");
		const r0 = await h.run();
		const record = (await h.asks()).find((a) => a.id === r0.nodes.q!.ask!.id)!;
		expect(record).toMatchObject({ to: "main", kind: "decision", refs: ["q"], state: "open" });
		expect(await h.lastText("dag_step")).toContain("ask node q needs your decision");
		ctl.askId = record.id;
		await h.say("DECIDE");
		const r = await h.settle();
		expect(r.status).toBe("verified");
		expect(r.nodes.q!.result).toContain("use mint");
	}, 30_000);

	test("an authority ask the orchestrator already resolved is reused: the node settles and its child runs in one step", async () => {
		const ctl: Control = { plan: deletion() };
		const h = await setup(ctl);
		await h.say("PLAN");
		await h.say("ASK");
		ctl.askId = (await h.asks()).at(-1)!.id;
		await h.say("approve");
		await h.say("STEP");
		const r = await h.run();
		expect(r.nodes.q!.status).toBe("succeeded");
		expect(r.nodes.q!.ask?.id).toBe(ctl.askId);
		expect(r.nodes.drop!.status).toBe("running");
		expect(await h.asks()).toHaveLength(1);
	}, 30_000);

	test("cancelling a run withdraws the open ask of its waiting ask node", async () => {
		const ctl: Control = { plan: deletion() };
		const h = await setup(ctl);
		await h.say("PLAN");
		await h.say("STEP");
		const id = (await h.run()).nodes.q!.ask!.id;
		await h.say("CANCEL");
		expect((await h.run()).status).toBe("cancelled");
		expect((await h.asks()).find((a) => a.id === id)).toMatchObject({ state: "withdrawn", resolvedBy: "system:dag-cancel" });
	}, 30_000);
});

describe("ask records are scoped to one run, node and dispatch", () => {
	test("an approval in one run never authorizes another run's ask node with the same node ids", async () => {
		const production = deletion();
		(production.nodes as JsonObject[])[0] = { id: "q", kind: "ask", description: "Drop the PRODUCTION database?" };
		const ctl: Control = { plan: deletion(), plan2: production };
		const h = await setup(ctl);
		await h.say("PLAN");
		const x = (await h.run()).id;
		await h.say("PLAN2");
		const y = (await h.run()).id;
		expect(y).not.toBe(x);
		await h.say(`STEP:${x}`);
		ctl.askId = (await h.run(x)).nodes.q!.ask!.id;
		await h.say("approve");
		await h.say(`STEP:${y}`);
		const other = await h.run(y);
		expect(other.nodes.q!.status).toBe("waiting");
		expect(other.nodes.q!.ask!.id).not.toBe(ctl.askId);
		expect(other.nodes.drop!.runs).toBe(0);
		expect((await h.asks()).find((a) => a.id === other.nodes.q!.ask!.id)).toMatchObject({ state: "open", run: y, node: "q" });
	}, 30_000);

	test("the same authority question in a later run opens a new record", async () => {
		const ctl: Control = { plan: deletion(), plan2: deletion() };
		const h = await setup(ctl);
		await h.say("PLAN");
		await h.say("ASK");
		const first = (await h.asks()).at(-1)!;
		await h.say("PLAN2");
		await h.say("ASK");
		const second = (await h.asks()).at(-1)!;
		expect(second.id).not.toBe(first.id);
		expect(second.run).not.toBe(first.run);
		expect(second.state).toBe("open");
	}, 30_000);

	test("removing and re-adding an ask node by replan asks again instead of reusing the old refusal", async () => {
		const ctl: Control = {
			plan: deletion(),
			replans: [{ nodes: [{ id: "v", kind: "verify", reads: ["db"], covers: ["R"] }], edges: [], goal: { requirements: ["R"] } }, deletion()],
		};
		const h = await setup(ctl);
		await h.say("PLAN");
		await h.say("STEP");
		const denied = (await h.run()).nodes.q!.ask!.id;
		ctl.askId = denied;
		await h.say("deny");
		await h.say("STEP");
		ctl.runId = (await h.run()).id;
		await h.say("REPLAN:0");
		await h.say("REPLAN:1");
		await h.say("STEP");
		const r = await h.run();
		expect(r.nodes.q!.status).toBe("waiting");
		expect(r.nodes.q!.ask!.id).not.toBe(denied);
		expect((await h.asks()).find((a) => a.id === r.nodes.q!.ask!.id)?.state).toBe("open");
	}, 30_000);

	test("mandatory ask prevents premature completion; cancellation withdraws it", async () => {
		const ctl: Control = { plan: { nodes: [{ id: "q", kind: "ask", description: "Optional preference?" }, { id: "v", kind: "verify", covers: ["R"] }], edges: [], goal: { requirements: ["R"] } } };
		const h = await setup(ctl);
		await h.say("PLAN");
		await h.say("STEP");
		const id = (await h.run()).nodes.q!.ask!.id;
		const r = await h.settle();
		expect(r.status).toBe("running");
		expect(r.nodes.q!.status).toBe("waiting");
		await h.say("CANCEL");
		expect((await h.run()).status).toBe("cancelled");
		expect((await h.asks()).find((a) => a.id === id)).toMatchObject({ state: "withdrawn", resolvedBy: "system:dag-cancel" });
	}, 30_000);
});

describe("dag_step progress", () => {
	test("a node whose contract alone overflows the context fails alone; independent nodes still run", async () => {
		const huge = Array.from({ length: 30 }, (_, i) => `${"r".repeat(1000)}${i}`);
		const ctl: Control = {
			plan: { nodes: [{ id: "big", kind: "verify", reads: huge, covers: ["R1"] }, { id: "small", kind: "verify", covers: ["R2"] }], edges: [], goal: { requirements: ["R1", "R2"] } },
		};
		const h = await setup(ctl);
		await h.say("PLAN");
		await h.say("STEP");
		const r = await h.run();
		expect(r.status).toBe("running");
		expect(r.nodes.big).toMatchObject({ status: "failed" });
		expect(r.nodes.big!.error).toContain("overflow");
		expect(r.nodes.small!.status).toBe("running");
		const done = await h.settle();
		expect(done.status).toBe("blocked");
		expect(done.certified).toEqual(["R2"]);
		expect(done.reason).toContain("big (attempt 1:");
	}, 30_000);

	test("an overflowing verifier judges nothing: a sibling verifier of the same requirement still certifies it", async () => {
		const huge = Array.from({ length: 30 }, (_, i) => `${"r".repeat(1000)}${i}`);
		const ctl: Control = {
			plan: {
				nodes: [{ id: "w", kind: "act", writes: ["x"] }, { id: "big", kind: "verify", reads: ["x", ...huge], covers: ["R1"] }, { id: "small", kind: "verify", reads: ["x"], covers: ["R1"] }],
				edges: [["w", "big"], ["w", "small"]], goal: { requirements: ["R1"] },
			},
		};
		const h = await setup(ctl);
		await h.say("PLAN");
		const r = await h.settle();
		expect(r.status).toBe("blocked");
		expect(r.certified).toEqual(["R1"]);
		expect(r.nodes.big).toMatchObject({ status: "failed", runs: 0 });
		expect(r.nodes.big!.error).toContain("overflow");
		expect(r.rejectedArtifacts ?? []).toEqual([]);
	}, 30_000);

	test("one dag_step settles a child's answered ask and its finished result", async () => {
		const ctl: Control = {
			childAsks: true,
			plan: { nodes: [{ id: "b", kind: "act", writes: ["y"] }, { id: "v", kind: "verify", reads: ["y"], covers: ["R"] }], edges: [["b", "v"]], goal: { requirements: ["R"] } },
		};
		const h = await setup(ctl);
		await h.say("PLAN");
		await h.say("STEP");
		for (let i = 0; i < 100 && !(await h.asks()).some((a) => a.state === "open"); i++) await Bun.sleep(10);
		ctl.askId = (await h.asks()).find((a) => a.state === "open")!.id;
		await h.say("DECIDE");
		const agents = (await h.bot.harness.snapshot(AgentsDoc, h.parent.id, context))!.agents;
		for (let i = 0; i < 200; i++) {
			const progress = await h.bot.harness.snapshot(ProgressDoc, h.parent.id, String(agents[0]!.runnerId), context);
			if (progress?.subagent?.status === "completed") break;
			await Bun.sleep(10);
		}
		await h.say("STEP");
		const r = await h.run();
		expect(r.nodes.b!.status).toBe("succeeded");
		expect(r.nodes.b!.facts).toEqual([ctl.askId]);
		expect(r.nodes.v!.status).toBe("running");
	}, 30_000);
});
