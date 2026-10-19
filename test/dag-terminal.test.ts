import { afterEach, describe, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonObject, ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage, type TaskId } from "@earendil-works/pi-durable";
import { type Bot, openBot } from "../src/core/bot.ts";
import { createRun, RunDoc, type RunState, start } from "../src/core/dag.ts";
import type { Plan, PlanNode } from "../src/core/plan.ts";
import { advanceDag, cancelDag, type DagApi, mutateDag, reconcileDag } from "../src/extensions/dag.ts";
import { ProgressDoc, type SpawnApi, subagentsExtension, type SubagentSpawner, AgentsDoc } from "../src/extensions/subagents.ts";

/**
 * Host-level counterexamples from session tui:20261005010039-3e6c: a cancelled run kept a node `running`
 * forever while its child completed (and a verifier's FAIL verdict was never recorded), and a replanned run
 * never became the active run shown to the TUI and the model prompt.
 */
const context = BACKGROUND_CONTEXT;
const bots: Bot[] = [];
afterEach(async () => { for (const bot of bots.splice(0)) await bot.close(context); });

type Transcript = Parameters<FauxResponseFactory>[0];
const lastUser = (t: Transcript) => t.messages.findLast((m) => m.role === "user")?.content;
const turnResults = (t: Transcript) => t.messages.slice(t.messages.findLastIndex((m) => m.role === "user") + 1).filter((m): m is ToolResultMessage => m.role === "toolResult");
const failVerdict = JSON.stringify({ version: 1, requirements: [{ id: "R", verdict: "fail", evidence: "3 assertions failed" }], summary: "regression failed", repairable: false });

async function setup(router: FauxResponseFactory) {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	faux.setResponses(Array.from({ length: 80 }, () => router));
	const models = createModels();
	models.setProvider(faux.provider);
	const bot = await openBot({ storage: new MemoryStorage(), models, defaultModel: { provider: "faux", modelId: "faux-1" }, toolMode: "direct", plugins: [], settings: { retry: { enabled: false } } }, context);
	bots.push(bot);
	const parent = await bot.conversation("test", "dag-terminal", context);
	return { bot, parent };
}

const plan: Plan = {
	nodes: [{ id: "v", kind: "verify", covers: ["R"] }, { id: "slow", kind: "act", writes: ["y"] }, { id: "vs", kind: "verify", reads: ["y"], covers: ["S"] }],
	edges: [["slow", "vs"]], goal: { requirements: ["R", "S"] },
};
const passVerdict = JSON.stringify({ version: 1, requirements: [{ id: "R", verdict: "pass", evidence: "checked" }], summary: "ok", repairable: false });
/** Children: `v` returns a FAIL verdict at once, `fastpass` a PASS; `slow`/`slowpass` work for a while. */
async function childReply(node: string) {
	if (node === "v") return fauxAssistantMessage(failVerdict);
	if (node === "fastpass") return fauxAssistantMessage(passVerdict);
	await Bun.sleep(node === "slowpass" ? 1500 : 3000);
	return fauxAssistantMessage(node === "slowpass" ? passVerdict : "slow done");
}
const children: FauxResponseFactory = (t) => childReply(/NODE:(\w+)/.exec(String(lastUser(t)))?.[1] ?? "?");
const apiOf = (bot: Bot, conversationId: DagApi["conversationId"]): DagApi => ({ conversationId, commit: bot.harness.commit.bind(bot.harness), snapshot: bot.harness.snapshot.bind(bot.harness) });
/** Polls (instead of sleeping a fixed time) until the child of `node` has delivered its outcome. */
async function delivered(bot: Bot, conversationId: DagApi["conversationId"], node: string) {
	for (let i = 0; i < 1000; i++) {
		const run = (await bot.harness.snapshot(RunDoc, conversationId, context))!.runs.at(-1)!;
		if (run.nodes[node]?.handle && (await reconcileDag(apiOf(bot, conversationId), run, context)).some((o) => o.id === node)) return;
		await Bun.sleep(10);
	}
	throw new Error(`child of ${node} never delivered`);
}

async function running(bot: Bot, parentId: DagApi["conversationId"], runPlan: Plan = plan, first = "v") {
	const holder: { current?: SubagentSpawner } = {};
	subagentsExtension(() => bot.harness, bot.work, [], holder);
	const api: DagApi = { conversationId: parentId, commit: bot.harness.commit.bind(bot.harness), snapshot: bot.harness.snapshot.bind(bot.harness) };
	const parent = (await bot.harness.conversation(parentId, context))!;
	const spawnApi: SpawnApi = { conversationId: parentId, taskId: 20001 as TaskId<string>, agent: parent.agent.bind(parent), commit: bot.harness.commit.bind(bot.harness) };
	await api.commit(async (tx) => { const doc = await tx.doc(RunDoc, parentId); doc.runs.push(createRun("run", runPlan, 0)); doc.activeId = "run"; }, context);
	const dispatch = async (run: RunState, node: PlanNode) => {
		// A mission binding gives the child a durable receipt without a parent tool task; the child itself is ordinary.
		const ref = await holder.current!.spawn({ description: `${run.id}:${node.id}`, prompt: `NODE:${node.id}`, background: true, mission: { missionId: "fixture", attemptId: `${node.id}:${run.nodes[node.id]!.runs + 1}` }, hostProfile: { role: "reviewer", tools: [], instructions: "Answer." } }, spawnApi, context);
		await mutateDag(api, run.id, context, (r, now) => start(r, node.id, ref.taskId, now, String(ref.runnerId)));
	};
	expect((await advanceDag(api, "run", context, { dispatch })).dispatched.sort()).toEqual(runPlan.nodes.filter((n) => !runPlan.edges.some(([, to]) => to === n.id)).map((n) => n.id).sort());
	await delivered(bot, parentId, first);
	return { api, holder, dispatch };
}
const runOf = async (bot: Bot, id: DagApi["conversationId"]) => (await bot.harness.snapshot(RunDoc, id, context))!.runs[0]!;
const activeNodes = (run: RunState) => Object.entries(run.nodes).filter(([, s]) => s.status === "running" || s.status === "waiting").map(([id]) => id);

describe("ordinary DAG terminal closure through the host", () => {
	test("dag_step cancel records a delivered FAIL verdict, aborts the still-running child and leaves no running node", async () => {
		const cancelText: string[] = [];
		const self: { bot?: Bot; id?: DagApi["conversationId"] } = {};
		const { bot, parent } = await setup(async (t) => {
			const user = String(lastUser(t));
			if (user.includes("plan node")) return childReply(/plan node "(\w+)"/.exec(user)?.[1] ?? "?");
			const results = turnResults(t);
			const last = results.at(-1);
			if (!last) return fauxAssistantMessage(fauxToolCall("dag_run", { plan: plan as unknown as JsonObject }), { stopReason: "toolUse" });
			if (results.length === 1) return fauxAssistantMessage(fauxToolCall("dag_step", {}), { stopReason: "toolUse" });
			if (results.length === 2) { await delivered(self.bot!, self.id!, "v"); return fauxAssistantMessage(fauxToolCall("dag_step", { cancel: true, reason: "operator" }), { stopReason: "toolUse" }); }
			cancelText.push(JSON.stringify(last.content));
			// A replayed/repeated cancel is idempotent.
			if (results.length === 3) return fauxAssistantMessage(fauxToolCall("dag_step", { cancel: true, reason: "replay" }), { stopReason: "toolUse" });
			return fauxAssistantMessage("done");
		});
		self.bot = bot; self.id = parent.id;
		expect((await (await parent.submit({ type: "input", content: "go" }, context)).wait(context)).status).toBe("done");
		expect(cancelText[0]).toContain("[cancelled]");
		expect(cancelText[0]).not.toContain("not confirmed stopped");
		expect(cancelText[1]).toBe(cancelText[0]);
		const run = await runOf(bot, parent.id);
		expect(run.reason).toBe("operator");
		expect(run.status).toBe("cancelled");
		expect(activeNodes(run)).toEqual([]);
		expect(run.nodes.v!.status).toBe("failed");
		expect(run.nodes.v!.error).toContain("3 assertions failed");
		expect(run.nodes.slow).toMatchObject({ status: "skipped", unknownEffects: true });
		expect(run.nodes.slow!.error).toContain("executor cancelled");
		expect(run.nodes.vs!.status).toBe("pending");
		expect(run.certified).toEqual([]);
		const slowRef = (await bot.harness.snapshot(AgentsDoc, parent.id, context))!.agents.find((a) => a.taskId === run.nodes.slow!.handle)!;
		expect((await bot.harness.snapshot(ProgressDoc, parent.id, String(slowRef.runnerId), context))?.subagent?.status).toBe("cancelled");
	}, 20_000);

	test("an executor that cannot be stopped stays visible, is reported, and is closed with its answer once it settles", async () => {
		const { bot, parent } = await setup(children);
		const { api, holder, dispatch } = await running(bot, parent.id);
		const stubborn: SubagentSpawner = { spawn: holder.current!.spawn, cancel: async () => { throw new Error("abort refused"); } };
		const result = await cancelDag(api, "run", "operator", stubborn, context);
		expect(result.unstopped).toHaveLength(1);
		expect(result.unstopped[0]).toContain("abort refused");
		let run = await runOf(bot, parent.id);
		expect(run.status).toBe("cancelled");
		expect(activeNodes(run)).toEqual(["slow"]);
		for (let i = 0; i < 400 && activeNodes(run).length; i++) {
			await Bun.sleep(10);
			run = (await advanceDag(api, "run", context, { dispatch })).run;
		}
		expect(activeNodes(run)).toEqual([]);
		expect(run.nodes.slow).toMatchObject({ status: "skipped", result: "slow done" });
		expect(run.nodes.slow!.unknownEffects).toBeUndefined();
		expect(run.nodes.vs!.status).toBe("pending");
		expect(run.status).toBe("cancelled");
	}, 20_000);
});

describe("verified runs close running siblings", () => {
	test("a passing verifier cannot complete the run before its mandatory sibling settles", async () => {
		const both: Plan = { nodes: [{ id: "fastpass", kind: "verify", covers: ["R"] }, { id: "slowpass", kind: "verify", covers: ["R"] }], edges: [], goal: { requirements: ["R"] } };
		const { bot, parent } = await setup(children);
		const { api, dispatch } = await running(bot, parent.id, both, "fastpass");
		let run = (await advanceDag(api, "run", context, { dispatch })).run;
		expect(run.status).toBe("running");
		expect(activeNodes(run)).toEqual(["slowpass"]);
		for (let i = 0; i < 400 && activeNodes(run).length; i++) {
			await Bun.sleep(10);
			run = (await advanceDag(api, "run", context, { dispatch })).run;
		}
		expect(activeNodes(run)).toEqual([]);
		expect(run.nodes.slowpass!.status).toBe("succeeded");
		expect(run.nodes.slowpass!.result).toContain("pass");
		expect(run.nodes.fastpass!.status).toBe("succeeded");
		expect(run).toMatchObject({ status: "verified", certified: ["R"] });
	}, 20_000);
});

describe("activeId follows the run the orchestrator works on", () => {
	test("a run blocked at creation becomes active when its replan compiles, without spending budget", async () => {
		const good: JsonObject = { nodes: [{ id: "a", kind: "act", writes: ["x"] }, { id: "v", kind: "verify", reads: ["x"], covers: ["R"] }], edges: [["a", "v"]], goal: { requirements: ["R"] } };
		const bad: JsonObject = { nodes: [{ id: "a", kind: "act", writes: ["x"] }], edges: [], goal: { requirements: ["R"] } };
		const target: { id?: string } = {};
		const calls: Record<string, [string, JsonObject]> = {
			create: ["dag_run", { plan: good }],
			cancel: ["dag_step", { cancel: true, reason: "operator" }],
			bad: ["dag_run", { plan: bad, replan_budget: 2 }],
			status: ["dag_status", {}],
		};
		const results: string[] = [];
		const { bot, parent } = await setup((t) => {
			const last = turnResults(t).at(-1);
			if (last) { results.push(JSON.stringify(last.content)); return fauxAssistantMessage("done"); }
			const user = String(lastUser(t));
			const [name, args] = user === "fix" ? ["dag_run", { plan: good, run_id: target.id! }] as [string, JsonObject] : calls[user]!;
			return fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
		});
		const send = async (content: string) => (await parent.submit({ type: "input", content }, context)).wait(context);
		await send("create");
		const first = (await bot.harness.snapshot(RunDoc, parent.id, context))!;
		expect(first.activeId).toBe(first.runs[0]!.id);
		await send("cancel");
		await send("bad");
		const blocked = (await bot.harness.snapshot(RunDoc, parent.id, context))!;
		expect(blocked.runs[1]!.status).toBe("blocked");
		expect(blocked.activeId).toBe(blocked.runs[0]!.id);
		target.id = blocked.runs[1]!.id;
		await send("fix");
		const fixed = (await bot.harness.snapshot(RunDoc, parent.id, context))!;
		expect(fixed.activeId).toBe(target.id);
		expect(fixed.runs[1]).toMatchObject({ status: "running", revision: 1, replanBudget: 2 });
		await send("status");
		expect(results.at(-1)).toContain(`run ${target.id}`);
		expect(results.at(-1)).toContain("[running]");
	}, 20_000);
});

describe("verifier protocol defects through the host", () => {
	const single: Plan = { nodes: [{ id: "v", kind: "verify", covers: ["R"] }], edges: [], goal: { requirements: ["R"] } };
	test("a prose-only verifier answer re-dispatches the verifier instead of rejecting the artifact; a readable verdict then verifies", async () => {
		let attempts = 0;
		const { bot, parent } = await setup(async (t) => {
			if (!/NODE:v/.test(String(lastUser(t)))) return fauxAssistantMessage("?");
			attempts++;
			return fauxAssistantMessage(attempts === 1 ? "Everything looks good to me." : passVerdict);
		});
		const { api, dispatch } = await running(bot, parent.id, single, "v");
		let step = await advanceDag(api, "run", context, { dispatch });
		expect(step.dispatched).toEqual(["v"]);
		let run = await runOf(bot, parent.id);
		expect(run.rejectedArtifacts ?? []).toEqual([]);
		expect(run.nodes.v!.protocolFeedback).toContain("malformed verdict");
		await delivered(bot, parent.id, "v");
		step = await advanceDag(api, "run", context, { dispatch });
		run = await runOf(bot, parent.id);
		expect(attempts).toBe(2);
		expect(run.status).toBe("verified");
		expect(run.certified).toEqual(["R"]);
		expect(run.nodes.v!.protocolFeedback).toBeUndefined();
	});
	test("a verdict with stray extra keys verifies on the first attempt", async () => {
		const sloppy = JSON.stringify({ version: 1, requirements: [{ id: "R", verdict: "pass", evidence: "checked", repairable: false }], summary: "ok", repairable: false, note: "x" });
		const { bot, parent } = await setup(async (t) => fauxAssistantMessage(/NODE:v/.test(String(lastUser(t))) ? "Final:\n" + sloppy : "?"));
		const { api, dispatch } = await running(bot, parent.id, single, "v");
		await advanceDag(api, "run", context, { dispatch });
		const run = await runOf(bot, parent.id);
		expect(run.status).toBe("verified");
		expect(run.nodes.v!.attempt).toBe(1);
	});
});
