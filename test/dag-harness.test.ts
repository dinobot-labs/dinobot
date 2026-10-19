import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonObject, ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage, type TaskId, type ToolRegistration } from "@earendil-works/pi-durable";
import { Value } from "typebox/value";
import { AsksDoc } from "../src/core/ask.ts";
import { type Bot, openBot } from "../src/core/bot.ts";
import { createRun, fail, succeed, RunDoc, type RunState, settleOwnedNode, start } from "../src/core/dag.ts";
import type { Plan } from "../src/core/plan.ts";
import type { ToolMode } from "../src/core/toolmode.ts";
import { advanceDag, mutateDag, type DagApi } from "../src/extensions/dag.ts";
import { AgentsDoc, MissionSpawnDoc, subagentsExtension, type SpawnApi, type SubagentSpawner } from "../src/extensions/subagents.ts";
import { SkillStore } from "../src/core/skills/store.ts";

const context = BACKGROUND_CONTEXT;
const bots: Bot[] = [];
afterEach(async () => { for (const bot of bots.splice(0)) await bot.close(context); });

type Transcript = Parameters<FauxResponseFactory>[0];
const lastUser = (t: Transcript) => t.messages.findLast((m) => m.role === "user")?.content;
const turnResults = (t: Transcript) => t.messages.slice(t.messages.findLastIndex((m) => m.role === "user") + 1).filter((m): m is ToolResultMessage => m.role === "toolResult");
const textOf = (r: ToolResultMessage | undefined) => JSON.stringify(r?.content ?? "");

const plan: JsonObject = {
	nodes: [
		{ id: "a", kind: "act", description: "Produce part A", writes: ["out/a"], post: [{ kind: "file", path: "out/a" }] },
		{ id: "b", kind: "act", description: "Produce part B (ask which flavour)", writes: ["out/b"], post: [{ kind: "file", path: "out/b" }] },
		{ id: "join", kind: "act", description: "Combine A and B", pre: [{ kind: "file", path: "out/a" }, { kind: "file", path: "out/b" }], reads: ["out/a", "out/b"], writes: ["out/final"] },
		{ id: "v", kind: "verify", description: "Verify final output", reads: ["out/"], covers: ["R1"] },
	],
	edges: [["a", "join"], ["b", "join"], ["join", "v"]],
	goal: { requirements: ["R1"] },
};

async function setup(router: FauxResponseFactory, toolMode: ToolMode = "direct") {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	faux.setResponses(Array.from({ length: 80 }, () => router));
	const models = createModels();
	models.setProvider(faux.provider);
	const bot = await openBot({ storage: new MemoryStorage(), models, defaultModel: { provider: "faux", modelId: "faux-1" }, toolMode, plugins: [], settings: { retry: { enabled: false } } }, context);
	bots.push(bot);
	const parent = await bot.conversation("test", "dag", context);
	const run = async (content: string) => (await parent.submit({ type: "input", content }, context)).wait(context);
	const results = async () => (await parent.entries({}, 300, undefined, context)).items.flatMap((e) => e.model ?? []).filter((m): m is ToolResultMessage => m.role === "toolResult");
	return { bot, parent, run, results };
}

/** Node subagents: `b` asks once; everyone else answers immediately with what they established. */
function childTurn(t: Transcript): ReturnType<typeof fauxAssistantMessage> {
	const user = String(lastUser(t));
	const node = /plan node "([^"]+)"/.exec(user)?.[1] ?? "?";
	const results = turnResults(t);
	if (node === "b" && results.length === 0) return fauxAssistantMessage(fauxToolCall("ask", { question: "Which flavour for B?", kind: "decision", options: ["vanilla", "mint"], default: "vanilla" }), { stopReason: "toolUse" });
	if (node === "b") return fauxAssistantMessage(`established out/b with ${textOf(results[0])}`);
	return fauxAssistantMessage(node === "v" ? JSON.stringify({version:1,requirements:[{id:"R1",verdict:"pass",evidence:"fixture checked final output"}],summary:"verified",repairable:false}) : `established ${node}`);
}

describe("dag executor through the harness", () => {
 test.each(["direct", "codemode-only"] as const)("%s failed verdict repairs actual artifact then fresh verifies before continuation", async mode => {
  const dir = await mkdtemp(join(tmpdir(), "dag-repair-")); const file = join(dir,"artifact.txt");
  const prompts: string[] = []; let reviews=0; let continuations=0;
  const p = {nodes:[{id:"actor",kind:"act",writes:[file]},{id:"review",kind:"verify",reads:[file],covers:["R"],repair:{predecessorId:"actor",maxRepairs:2}},{id:"continue",kind:"act"},{id:"final",kind:"verify",covers:["done"]}],edges:[["actor","review"],["review","continue"],["continue","final"]],goal:{requirements:["R","done"]}};
  const call = (name:string,args:JsonObject) => fauxAssistantMessage(mode === "direct" ? fauxToolCall(name,args) : fauxToolCall("codemode",{code:`text(await tools.${name}(${JSON.stringify(args)}));`}),{stopReason:"toolUse"});
  try {
   const {bot,parent,run} = await setup(async t => {
    const user=String(lastUser(t)); const node=/plan node "([^"]+)"/.exec(user)?.[1];
    if(node){
     if(node === "actor") { if(!turnResults(t).length){prompts.push(user);return call("write",{path:file,content:user.includes("wrong artifact") ? "fixed" : "broken"});} return fauxAssistantMessage("artifact written"); }
     if(node === "continue"){continuations++;expect(await readFile(file,"utf8")).toBe("fixed");return fauxAssistantMessage("continued");}
     const pass=node === "final" || await readFile(file,"utf8") === "fixed"; if(node === "review") { reviews++; expect(user).toContain("Set repairable=true only for a concrete, evidenced artifact defect"); expect(user).toContain("exact next check plus evidence needed to establish every covered requirement"); }
     return fauxAssistantMessage(JSON.stringify({version:1,requirements:[{id:node === "final" ? "done" : "R",verdict:pass?"pass":"fail",evidence:pass?"artifact equals fixed":"wrong artifact: expected fixed, got broken"}],summary:pass?"accepted":"repair artifact",repairable:!pass}));
    }
    const last=turnResults(t).at(-1);if(!last)return call("dag_run",{plan:p});if(/\[verified\]|\[blocked\]/.test(textOf(last)))return fauxAssistantMessage("settled");await Bun.sleep(30);return call("dag_step",{});
   },mode);
   expect((await run("GO")).status).toBe("done");const r=(await bot.harness.snapshot(RunDoc,parent.id,context))!.runs[0]!;
   expect(r.status).toBe("verified");expect(r.repairsUsed).toBe(1);expect(reviews).toBe(2);expect(continuations).toBe(1);expect(prompts).toHaveLength(2);expect(prompts[1]).toContain("wrong artifact");expect(r.nodes.review!.generation).toBe(1);
  } finally {await rm(dir,{recursive:true,force:true});}
 });
 test.each(["direct", "codemode-only"] as const)("%s replan counterexamples admit no fresh subagents through real tools", async mode => {
  for (const scenario of ["coverage", "unknown", "irreversible"]) {
   const p: Plan = {nodes:[{id:"a",kind:"act",writes:["out"],...(scenario === "irreversible" ? {irreversible:true} : {})},{id:"v",kind:"verify",reads:["out"],covers:["R"]}],edges:[["a","v"]],goal:{requirements:["R"]}};
   if(scenario === "irreversible") {p.nodes.push({id:"ask",kind:"ask"});p.edges.push(["ask","a"]);}
   const state=createRun("counterexample",p,0);
   if(scenario === "irreversible") {start(state,"ask","authority",1);succeed(state,"ask","authorized",2);}
   start(state,"a","actor",3);
   if(scenario === "unknown") fail(state,"a","lost executor",4,true);
   else {succeed(state,"a","artifact",4);start(state,"v","reviewer",5);succeed(state,"v",JSON.stringify({version:1,requirements:[{id:"R",verdict:"fail",evidence:"artifact fails check"}],summary:"failed",repairable:false}),6);}
   const replacement=structuredClone(p);
   if(scenario === "coverage") {replacement.goal.requirements.push("S");replacement.nodes[1]!.covers!.push("S");}
   else replacement.nodes[0]!.description="attempt again";
   const {bot,parent,run,results}=await setup(t=> {
    if(turnResults(t).length) return fauxAssistantMessage("done");
    const name=lastUser(t)==="replan" ? "dag_run" : "dag_step";
    const args: JsonObject=name==="dag_run" ? {run_id:state.id,plan:replacement as unknown as JsonObject} : {run_id:state.id};
    return fauxAssistantMessage(mode === "direct" ? fauxToolCall(name,args) : fauxToolCall("codemode",{code:"text(await tools."+name+"("+JSON.stringify(args)+"));"}),{stopReason:"toolUse"});
   },mode);
   // Admit this synthetic history to an actual current source so the original effects/replan guard, not legacy fencing, is exercised.
   await run("fixture original source");
   const goal=(await bot.work.snapshot(parent.id,context)).goal!;state.goalBinding={epoch:goal.epoch,hash:goal.hash};
   await bot.harness.commit(async tx=>{const doc=await tx.doc(RunDoc,parent.id);doc.runs.push(state);doc.activeId=state.id;},context);
   await run("replan"); await run("step");
   const after=(await bot.harness.snapshot(RunDoc,parent.id,context))!.runs[0]!;
   expect(after.status).toBe("blocked");expect(after.certified).toEqual([]);expect(after.nodes.a!.runs).toBe(1);
   expect((await bot.harness.snapshot(AgentsDoc,parent.id,context))?.agents ?? []).toEqual([]);
   if(scenario !== "coverage") expect(JSON.stringify(await results())).toContain("effects forbid replan");
  }
 });
	test("registered dag_run edges use provider-compatible homogeneous string pairs", async () => {
		const { parent } = await setup(() => fauxAssistantMessage("done"));
		const tool = (await parent.agent(context)).tools.find((tool) => tool.name === "dag_run")!;
		expect(tool).toBeDefined();
		const schema = tool.parameters;
		const edges = JSON.parse(JSON.stringify(schema)).properties.plan.properties.edges;
		// Z.AI rejects tuple-form items:[string,string] with HTTP 400/code 1210.
		expect(edges.maxItems).toBe(4096);
		expect(edges.items.type).toBe("array");
		expect(edges.items.minItems).toBe(2);
		expect(edges.items.maxItems).toBe(2);
		expect(edges.items.items).toEqual({ type: "string" });
		expect(edges.items).not.toHaveProperty("additionalItems");
		expect(Value.Check(schema, { plan })).toBe(true);
		expect(Value.Check(schema, { plan: { ...plan, edges: [["a", "join"]] } })).toBe(true);
		expect(Value.Check(schema, { plan: { ...plan, edges: [] } })).toBe(true);
		for (const edge of [[], ["a"], ["a", "join", "v"], [1, "join"], ["a", 1], [null, "join"], ["a", false], [{}, "join"]]) {
			expect(Value.Check(schema, { plan: { ...plan, edges: [edge] } })).toBe(false);
		}
	});

	test.each(["direct", "codemode-only"] as const)("%s dag_run retains compiler acceptance and cycle diagnostics", async (mode) => {
		const { bot, parent, run, results } = await setup((t) => {
			if (turnResults(t).length) return fauxAssistantMessage("done");
			const input = { plan: lastUser(t) === "valid" ? plan : { ...plan, edges: [...(plan["edges"] as [string, string][]), ["v", "a"]] } };
			return fauxAssistantMessage(mode === "direct" ? fauxToolCall("dag_run", input) : fauxToolCall("codemode", { code: `text(await tools.dag_run(${JSON.stringify(input)}));` }), { stopReason: "toolUse" });
		}, mode);
		expect((await run("valid")).status).toBe("done");
		const valid = (await bot.harness.snapshot(RunDoc, parent.id, context))!.runs[0]!;
		expect(valid.status).toBe("running");
		expect(valid.plan.edges).toEqual(plan["edges"] as [string, string][]);
		expect((await run("cycle")).status).toBe("done");
		const states = (await bot.harness.snapshot(RunDoc, parent.id, context))!;
		expect(states.runs).toHaveLength(2);
		expect(states.runs[1]!.status).toBe("blocked");
		expect(states.activeId).toBe(valid.id);
		expect((await results()).some((result) => textOf(result).includes("acyclic: cycle through"))).toBe(true);
	});

	test("generic creation, replan, step and cancellation reject mission ownership", async () => {
		const { bot, parent, run, results } = await setup((t) => {
			if (turnResults(t).length) return fauxAssistantMessage("done");
			const command = String(lastUser(t));
			return fauxAssistantMessage(fauxToolCall(command === "create" || command === "replan" ? "dag_run" : "dag_step",
				command === "create" ? { plan } : command === "replan" ? { plan, run_id: "owned" } : { run_id: "owned", cancel: command === "cancel" }), { stopReason: "toolUse" });
		});
		await bot.harness.commit(async (tx) => {
			const doc = await tx.doc(RunDoc, parent.id);
			doc.runs.push(createRun("owned", plan as unknown as Plan, 0, 8, { missionId: "m" }));
			doc.activeId = "owned";
		}, context);
		const before = await bot.harness.snapshot(RunDoc, parent.id, context);
		for (const command of ["create", "replan", "step", "cancel"]) await run(command);
		expect((await results()).filter((r) => r.isError)).toHaveLength(4);
		expect(await bot.harness.snapshot(RunDoc, parent.id, context)).toEqual(before);
		expect((await bot.harness.snapshot(AgentsDoc, parent.id, context))?.agents ?? []).toEqual([]);
	});

	test("shared advancement admits finite nodes and settles only host receipts with a narrow API", async () => {
		const { bot, parent } = await setup(() => fauxAssistantMessage("done"));
		const api: DagApi = { conversationId: parent.id, commit: bot.harness.commit.bind(bot.harness), snapshot: bot.harness.snapshot.bind(bot.harness) };
		await api.commit(async (tx) => {
			(await tx.doc(RunDoc, parent.id)).runs.push(createRun("owned", { nodes: [{ id: "v", kind: "verify", covers: ["R"] }], edges: [], goal: { requirements: ["R"] } }, 0, 8, { missionId: "m" }));
		}, context);
		await expect(advanceDag(api, "owned", context, { dispatch: async () => {} })).rejects.toThrow("Research-owned");
		let admitted = false;
		let dispatches = 0;
		const hooks = {
			missionId: "m",
			admit: async () => admitted,
			dispatch: async () => { dispatches++; await mutateDag(api, "owned", context, (r, now) => start(r, "v", "host", now)); },
			settle: async (run: RunState) => {
				if (run.nodes.v!.status !== "running") return;
				await mutateDag(api, "owned", context, (r, now) => settleOwnedNode(r, { missionId: "m", nodeId: "v", receiptId: "r1", key: r.nodes.v!.key!, attempt: r.nodes.v!.attempt, result: "accepted" }, now));
			},
		};
		expect((await advanceDag(api, "owned", context, hooks)).dispatched).toEqual([]);
		admitted = true;
		expect((await advanceDag(api, "owned", context, hooks)).dispatched).toEqual(["v"]);
		expect((await advanceDag(api, "owned", context, hooks)).run.status).toBe("verified");
		expect(dispatches).toBe(1);
	});

	test("mission spawn reuses one atomic child across distinct callers and constrains profiles", async () => {
		const { bot, parent } = await setup(() => fauxAssistantMessage("child prose"));
		const holder: { current?: SubagentSpawner } = {};
		subagentsExtension(() => bot.harness, bot.work, [], holder);
		const api: SpawnApi = { conversationId: parent.id, taskId: 10001 as TaskId<string>, agent: parent.agent.bind(parent), commit: bot.harness.commit.bind(bot.harness) };
		const input = { description: "mission author", prompt: "propose", background: true, mission: { missionId: "m", attemptId: "a", metadata: { epoch: 2 } }, hostProfile: { role: "author" as const, tools: [], instructions: "Propose only." } };
		const [first, second] = await Promise.all([
			holder.current!.spawn(input, api, context),
			holder.current!.spawn(input, { ...api, taskId: 10002 as TaskId<string> }, context),
		]);
		expect(second).toEqual(first);
		expect(first.owner).toBe("research");
		expect((await bot.harness.snapshot(AgentsDoc, parent.id, context))!.agents).toHaveLength(1);
		expect(await bot.harness.snapshot(MissionSpawnDoc, parent.id, JSON.stringify(["m", "a"]), context)).toEqual({ ref: first, binding: input.mission });
		const child = (await bot.harness.conversation(first.conversationId, context))!;
		expect((await child.agent(context)).tools).toEqual([]);
		expect((await child.agent(context)).extensions).toEqual([]);
		for (const tool of ["task", "dag_step", "research_start", "codemode", "bash"]) {
			await expect(holder.current!.spawn({ ...input, mission: { missionId: "m", attemptId: tool }, hostProfile: { role: "reviewer", tools: [tool], instructions: "review" } }, api, context)).rejects.toThrow("authority");
		}
		const review = await holder.current!.spawn({ ...input, mission: { missionId: "m", attemptId: "review" }, hostProfile: { role: "reviewer", tools: ["read"], instructions: "Read only." } }, api, context);
		const reviewer = (await bot.harness.conversation(review.conversationId, context))!;
		expect((await reviewer.agent(context)).tools.map((tool) => tool.name)).toEqual(["read"]);
		// A model-visible surface may omit executable reads. The host must select them
		// from the already-authorized capability catalog rather than grant the registry.
		const effective = await parent.agent(context);
		const read = effective.tools.find((tool): tool is ToolRegistration => tool.name === "read" && "execute" in tool)!;
		expect(read).toBeDefined();
		const restrictedApi: SpawnApi = { ...api, agent: async () => ({ ...effective, tools: effective.tools.filter((tool) => tool.name === "codemode") }) };
		const profile = { role: "reviewer" as const, tools: ["read"], instructions: "Read only." };
		const selected = { ...input, mission: { missionId: "m", attemptId: "catalog-read" }, hostProfile: profile };
		await expect(holder.current!.spawn(selected, restrictedApi, context)).rejects.toThrow("tools unavailable: read");
		for (const registrations of [[], [read, read]]) {
			await expect(holder.current!.spawn({ ...selected, hostProfile: { ...profile, registrations } }, restrictedApi, context)).rejects.toThrow();
		}
		await expect(holder.current!.spawn({ ...selected, hostProfile: { ...profile, tools: [], registrations: [read] } }, restrictedApi, context)).rejects.toThrow("Invalid host-selected");
		await expect(holder.current!.spawn({ ...selected, hostProfile: { ...profile, role: "author", tools: [], registrations: [read] } }, restrictedApi, context)).rejects.toThrow("Invalid host-selected");
		const catalogRef = await holder.current!.spawn({ ...selected, hostProfile: { ...profile, registrations: [read] } }, restrictedApi, context);
		const catalogChild = (await bot.harness.conversation(catalogRef.conversationId, context))!;
		expect((await catalogChild.agent(context)).tools.map((tool) => tool.name)).toEqual(["read"]);
		await holder.current!.cancel(catalogRef);
		await holder.current!.cancel(first);
		await holder.current!.cancel(review);
	});

	test("dag_run compiles, dag_step dispatches parallel nodes, an ask is relayed and answered, and the run verifies", async () => {
		const orchestratorSteps: string[] = [];
		const router: FauxResponseFactory = async (t) => {
			const user = lastUser(t);
			if (typeof user === "string" && user.includes("plan node")) return childTurn(t);
			const results = turnResults(t);
			const last = results.at(-1);
			if (user === "GO") {
				if (!last) return fauxAssistantMessage(fauxToolCall("dag_run", { plan }), { stopReason: "toolUse" });
				orchestratorSteps.push(last.toolName);
				const text = textOf(last);
				if (/\[verified\]/.test(text)) return fauxAssistantMessage("run verified");
				if (/\[blocked\]|\[cancelled\]/.test(text)) return fauxAssistantMessage(`run ended: ${text}`);
				const askId = /ask ([0-9a-f]{32}) from/.exec(text)?.[1];
				if (askId && last.toolName !== "answer") return fauxAssistantMessage(fauxToolCall("answer", { ask_id: askId, answer: "mint" }), { stopReason: "toolUse" });
				// Give subagents time to finish between steps, then step again.
				await Bun.sleep(60);
				return fauxAssistantMessage(fauxToolCall("dag_step", {}), { stopReason: "toolUse" });
			}
			return fauxAssistantMessage("?");
		};
		const { bot, parent, run } = await setup(router);
		const settled = await run("GO");
		expect(settled.status).toBe("done");
		const doc = await bot.harness.snapshot(RunDoc, parent.id, context);
		const state = doc!.runs[0]!;
		expect(state.status).toBe("verified");
		expect(orchestratorSteps[0]).toBe("dag_run");
		expect(orchestratorSteps).toContain("answer");
		expect(orchestratorSteps.filter((s) => s === "dag_step").length).toBeGreaterThanOrEqual(3);
		// Every node ran exactly once; a and b were dispatched in the same step (parallel frontier).
		for (const node of Object.values(state.nodes)) { expect(node.status).toBe("succeeded"); expect(node.runs).toBe(1); }
		// Same step means the two runs overlapped; an absolute start-gap bound flakes on a loaded CI runner.
		expect(state.nodes["b"]!.startedAt!).toBeLessThan(state.nodes["a"]!.endedAt!);
		expect(state.nodes["a"]!.startedAt!).toBeLessThan(state.nodes["b"]!.endedAt!);
		expect(state.nodes["join"]!.startedAt!).toBeGreaterThanOrEqual(Math.max(state.nodes["a"]!.endedAt!, state.nodes["b"]!.endedAt!));
		// b's answer became a fact bound into b's key; descendants depend on it transitively.
		const asks = (await bot.harness.snapshot(AsksDoc, parent.id, context))!.asks;
		expect(asks).toHaveLength(1);
		expect(asks[0]).toMatchObject({ state: "answered", answer: "mint", from: { taskId: state.nodes["b"]!.handle } });
		expect(state.nodes["b"]!.facts).toEqual([asks[0]!.id]);
		expect(state.nodes["b"]!.result).toContain("answered: mint");
		expect(state.potential).toEqual([[8, 1]]);
		// Four subagents, all terminal, no live tasks.
		const agents = (await bot.harness.snapshot(AgentsDoc, parent.id, context))!.agents;
		expect(agents).toHaveLength(4);
		for (const agent of agents) expect(agent.owner).toBe("dag");
		expect((await bot.harness.inspect(context)).tasks).toEqual([]);
		// Cited evidence is checked against durable records, but evidence is optional (ADR 0037).
		const agent = `agent:${parent.id}`;
		const store = new SkillStore(bot.harness, { evidenceChecked: (actor) => actor.startsWith("agent:") });
		const proposal = await store.propose({ name: "dag-lessons", description: "Learned from run", body: "Always declare write scopes.", files: {}, expectedGeneration: 0, requestId: "p1" }, agent, context);
		await expect(store.publish({ proposalId: proposal.proposalId, requestId: "pub-bad", evidence: { kind: "receipts", conversationId: String(parent.id), ids: ["dag-nope"] } }, agent, context)).rejects.toThrow("unknown receipt dag-nope");
		expect(await store.checkEvidence({ kind: "receipts", conversationId: String(parent.id), ids: [state.id] }, "dag-lessons", context)).toBeUndefined();
		const published = await store.publish({ proposalId: proposal.proposalId, requestId: "pub-none" }, agent, context);
		expect(published.generation).toBe(1);
		expect((await store.history("dag-lessons", context))[0]).toMatchObject({ actor: agent });
		expect((await store.history("dag-lessons", context))[0]!.evidence).toBeUndefined();
		// A verified run receipt is accepted and recorded as provenance.
		const p2 = await store.propose({ name: "dag-lessons", description: "Agent edit", body: "Agent text", files: {}, expectedGeneration: 1, requestId: "p2" }, agent, context);
		expect((await store.publish({ proposalId: p2.proposalId, requestId: "pub-ok", evidence: { kind: "receipts", conversationId: String(parent.id), ids: [state.id] } }, agent, context)).generation).toBe(2);
		expect((await store.history("dag-lessons", context)).at(-1)!.evidence).toMatchObject({ kind: "receipts", ids: [state.id] });
		// An owner (not an agent) is not checked.
		const p3 = await store.propose({ name: "dag-lessons", description: "Owner edit", body: "Owner text", files: {}, expectedGeneration: 2, requestId: "p3" }, "owner", context);
		expect((await store.publish({ proposalId: p3.proposalId, requestId: "pub-owner" }, "owner", context)).generation).toBe(3);
	}, 30_000);

	test("a non-compiling plan is rejected with diagnostics and creates no subagent", async () => {
		const router: FauxResponseFactory = (t) => {
			const last = turnResults(t).at(-1);
			if (!last) return fauxAssistantMessage(fauxToolCall("dag_run", { plan: { ...plan, edges: [...(plan["edges"] as [string, string][]), ["v", "a"]] } }), { stopReason: "toolUse" });
			return fauxAssistantMessage(`r: ${textOf(last)}`);
		};
		const { bot, parent, run, results } = await setup(router);
		expect((await run("GO")).status).toBe("done");
		const result = (await results())[0]!;
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("acyclic: cycle through");
		expect((await bot.harness.snapshot(RunDoc, parent.id, context))?.activeId).toBeUndefined();
		expect((await bot.harness.snapshot(AgentsDoc, parent.id, context))?.agents ?? []).toHaveLength(0);
	}, 15_000);

	test("a node that fails three times blocks the run; a monotone replan around it re-verifies", async () => {
		let replanned = false;
		const router: FauxResponseFactory = async (t) => {
			const user = lastUser(t);
			if (typeof user === "string" && user.includes("plan node")) {
				const node = /plan node "([^"]+)"/.exec(user)?.[1];
				if (node === "b") return fauxAssistantMessage("", { stopReason: "error", errorMessage: "injected provider failure" } as never);
				return fauxAssistantMessage(node === "v" ? JSON.stringify({version:1,requirements:[{id:"R1",verdict:"pass",evidence:"fixture checked final output"}],summary:"verified",repairable:false}) : `established ${node}`);
			}
			const last = turnResults(t).at(-1);
			if (!last) return fauxAssistantMessage(fauxToolCall("dag_run", { plan }), { stopReason: "toolUse" });
			const text = textOf(last);
			if (/\[verified\]/.test(text)) return fauxAssistantMessage("verified");
			if (/\[blocked\]/.test(text) && !replanned) {
				replanned = true;
				const runId = /run (dag-[a-z0-9]+)/.exec(text)![1]!;
				// Replace b with b2 (a different contract) keeping the goal.
				const nodes = (plan["nodes"] as JsonObject[]).map((n) => n["id"] === "b" ? { ...n, id: "b2", description: "Produce part B without asking" } : n);
				const edges = (plan["edges"] as [string, string][]).map(([f, to]) => [f === "b" ? "b2" : f, to === "b" ? "b2" : to]);
				return fauxAssistantMessage(fauxToolCall("dag_run", { plan: { ...plan, nodes, edges }, run_id: runId }), { stopReason: "toolUse" });
			}
			if (/\[blocked\]/.test(text)) return fauxAssistantMessage(`blocked: ${text}`);
			await Bun.sleep(60);
			return fauxAssistantMessage(fauxToolCall("dag_step", {}), { stopReason: "toolUse" });
		};
		const { bot, parent, run } = await setup(router);
		expect((await run("GO")).status).toBe("done");
		const state: RunState = (await bot.harness.snapshot(RunDoc, parent.id, context))!.runs[0]!;
		expect(replanned).toBe(true);
		expect(state.revision).toBe(1);
		expect(state.replanBudget).toBe(7);
		expect(state.potential).toEqual([[8, 1], [7, 1]]);
		expect(state.nodes["b"]).toBeUndefined();
		expect(state.nodes["a"]!.runs).toBe(1); // kept across the replan
		expect(state.nodes["b2"]!.status).toBe("succeeded");
		expect(state.status).toBe("verified");
	}, 40_000);

	test("a blocked run is not receipt evidence", async () => {
		const router: FauxResponseFactory = (t) => {
			const last = turnResults(t).at(-1);
			if (!last) return fauxAssistantMessage(fauxToolCall("dag_run", { plan: { nodes: [{ id: "a", kind: "act", writes: ["x"] }], edges: [], goal: { requirements: ["R"] } } }), { stopReason: "toolUse" });
			return fauxAssistantMessage("done");
		};
		const { bot, parent, run } = await setup(router);
		expect((await run("GO")).status).toBe("done");
		const state = (await bot.harness.snapshot(RunDoc, parent.id, context))!.runs[0]!;
		expect(state.status).toBe("blocked");
		const store = new SkillStore(bot.harness, { evidenceChecked: () => true });
		const proposal = await store.propose({ name: "x", description: "d", body: "b", files: {}, expectedGeneration: 0, requestId: "p" }, "agent:1", context);
		await expect(store.publish({ proposalId: proposal.proposalId, requestId: "pub", evidence: { kind: "receipts", conversationId: String(parent.id), ids: [state.id] } }, "agent:1", context)).rejects.toThrow("is blocked, not verified");
	}, 15_000);
});
