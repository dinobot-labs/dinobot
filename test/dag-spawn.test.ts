import { describe, expect, test } from "bun:test";
import {
	createRun, expansionReceipt, frontier, instancesOf, KAPPA, potential, readFact, replan, reviseFact, type RunState, SPAWN_CREDIT, spawnPotential, start, succeed, summarize,
} from "../src/core/dag.ts";
import { dagPrompt } from "../src/core/dag-verification.ts";
import { compilePlan, type Plan, type PlanNode, SPAWN_MAX_FANOUT } from "../src/core/plan.ts";

/**
 * Hybrid static/dynamic DAG: an expand node with a spawn template is checked statically on its worst-case envelope
 * (T1–T3), then instantiated at run time only within the template (R1–R5), with Φ' = (spawn credit, budget, |unmet|)
 * strictly decreasing and κ-bounded settlement receipts for the orchestrator.
 */
const verdict = (reqs: string[]) => JSON.stringify({ version: 1, requirements: reqs.map((id) => ({ id, verdict: "pass", evidence: "observed pass" })), summary: "pass", repairable: false });
const instances = (...xs: object[]) => JSON.stringify({ instances: xs });

function shardPlan(spawn: Partial<NonNullable<PlanNode["spawn"]>> = {}, extra: Partial<Plan> = {}): Plan {
	return {
		nodes: [
			{ id: "split", kind: "expand", reads: ["src"], spawn: { template: { kind: "act", reads: ["src"], writes: ["out"] }, max: 4, ...spawn } },
			{ id: "check", kind: "verify", reads: ["out"], covers: ["R"] },
			...(extra.nodes ?? []),
		],
		edges: [["split", "check"], ...(extra.edges ?? [])],
		goal: { requirements: ["R"] },
	};
}

function expand(run: RunState, id: string, answer: string, now = 2) {
	start(run, id, `sa-${id}`, now - 1, "1");
	succeed(run, id, answer, now);
}

describe("static template checks (T)", () => {
	test("a spawn template compiles against its envelope without placing nodes", () => {
		const result = compilePlan(shardPlan());
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.compiled.order).toEqual(["split", "check"]);
	});

	const rejected: [string, Plan, RegExp][] = [
		["spawn on a non-expand node", { ...shardPlan(), nodes: [{ id: "split", kind: "act", spawn: { template: { kind: "act", writes: ["out"] }, max: 2 } }, { id: "check", kind: "verify", reads: ["out"], covers: ["R"] }] }, /only expand nodes may spawn/],
		["a writing planner", { ...shardPlan(), nodes: [{ id: "split", kind: "expand", writes: ["out"], spawn: { template: { kind: "act", writes: ["out"] }, max: 2 } }, { id: "check", kind: "verify", reads: ["out"], covers: ["R"] }] }, /plans read-only/],
		["fan-out above the cap", shardPlan({ max: SPAWN_MAX_FANOUT + 1 }), /max must be an integer/],
		["zero fan-out", shardPlan({ max: 0 }), /max must be an integer/],
		["depth above the cap", shardPlan({ depth: 4 }), /depth must be an integer/],
		["verify template", shardPlan({ template: { kind: "verify" as "act", writes: ["out"] } }), /template kind must be act or delegate/],
		["irreversible template", shardPlan({ template: { kind: "act", writes: ["out"], irreversible: true } as never }), /template cannot declare irreversible/],
		["reserved instance id", shardPlan({}, { nodes: [{ id: "split/0", kind: "act" }] }), /reserved for instances spawned by "split"/],
	];
	for (const [name, plan, message] of rejected) test(`rejects ${name}`, () => {
		const result = compilePlan(plan);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.diagnostics.map((d) => `${d.check}: ${d.message}`).join("\n")).toMatch(message);
	});

	test("the envelope must be verified downstream (verify dominance on the worst case)", () => {
		const plan = shardPlan();
		plan.nodes[1] = { id: "check", kind: "verify", reads: ["elsewhere"], covers: ["R"] };
		const result = compilePlan(plan);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.diagnostics).toContainEqual(expect.objectContaining({ check: "verify-dominance", message: expect.stringContaining("(spawn envelope)") }));
	});

	test("the envelope must not race with nodes unordered with the spawner", () => {
		const plan = shardPlan({}, { nodes: [{ id: "other", kind: "act", writes: ["out/x"] }], edges: [["other", "check"]] });
		const result = compilePlan(plan);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.diagnostics).toContainEqual(expect.objectContaining({ check: "race", nodes: ["other", "split/*"] }));
	});
});

describe("runtime instantiation (R)", () => {
	test("accepted instances sit between the spawner and its children; the run verifies through them", () => {
		const run = createRun("r", shardPlan(), 0);
		expect(spawnPotential(run)).toEqual([SPAWN_CREDIT, 8, 1]);
		expand(run, "split", instances({ description: "a", writes: ["out/a"] }, { description: "b", writes: ["out/b"] }, { description: "c", writes: ["out/c"] }));
		expect(run.nodes.split!.status).toBe("succeeded");
		expect(instancesOf(run.plan, "split")).toEqual(["split/0", "split/1", "split/2"]);
		// Omitted scopes inherit the template's.
		expect(run.plan.nodes.find((n) => n.id === "split/2")).toMatchObject({ kind: "act", origin: "split", reads: ["src"], writes: ["out/c"] });
		expect(run.compiled!.parents.check!.sort()).toEqual(["split", "split/0", "split/1", "split/2"]);
		expect(frontier(run).sort()).toEqual(["split/0", "split/1", "split/2"]);
		expect(run.spawned).toBe(3);
		expect(run.spawnPotential).toEqual([[SPAWN_CREDIT - 3, 8, 1]]);
		// The static potential keeps its shape; the expansion did not spend replan budget.
		expect(potential(run)).toEqual([8, 1]);
		expect(run.revision).toBe(0);
		for (const id of ["split/0", "split/1", "split/2"]) { start(run, id, `sa-${id}`, 3, "1"); succeed(run, id, `ok ${id}`, 4); }
		expect(frontier(run)).toEqual(["check"]);
		start(run, "check", "sa-check", 5, "1");
		succeed(run, "check", verdict(["R"]), 6);
		expect(run.status).toBe("verified");
	});

	const bad: [string, string, RegExp][] = [
		["prose", "I would split it in three", /not one JSON object/],
		["extra keys", JSON.stringify({ instances: [{ description: "a" }], note: 1 }), /nothing else/],
		["too many instances (R1)", instances(...Array.from({ length: 5 }, (_, i) => ({ description: `p${i}`, writes: [`out/${i}`] }))), /R1: 5 instance/],
		["no instances (R1)", instances(), /R1: 0 instance/],
		["scope outside the envelope (R2)", instances({ description: "a", writes: ["src/a"] }), /R2: instance 0 writes src\/a outside/],
		["expansion without depth (R3)", instances({ description: "a", writes: ["out/a"], expand: true }), /R3/],
		["overlapping sibling writes (R5)", instances({ description: "a", writes: ["out/a"] }, { description: "b", writes: ["out/a"] }), /R5: .*race/],
		["an instance inheriting the whole envelope beside a sibling (R5)", instances({ description: "a", writes: ["out/a"] }, { description: "rest" }), /R5: .*race/],
	];
	for (const [name, answer, message] of bad) test(`rejects ${name} and retries the planner with feedback`, () => {
		const run = createRun("r", shardPlan(), 0);
		expand(run, "split", answer);
		const s = run.nodes.split!;
		expect(s.status).toBe("pending");
		expect(s.error).toMatch(message);
		expect(s.spawnFeedback).toMatch(message);
		expect(run.plan.nodes.map((n) => n.id)).toEqual(["split", "check"]);
		expect(run.spawned).toBeUndefined();
		expect(dagPrompt(run, run.plan.nodes[0]!)).toContain("Your previous expansion was rejected by the host");
	});

	test("rejections are bounded by the attempt budget", () => {
		const run = createRun("r", shardPlan(), 0);
		for (let i = 0; i < 3; i++) expand(run, "split", "nope", 2 + i * 2);
		expect(run.nodes.split!.status).toBe("failed");
		expect(run.status).toBe("blocked");
	});

	test("exhausted spawn credit fails at once (R4 is deterministic)", () => {
		const run = createRun("r", shardPlan(), 0);
		run.spawned = SPAWN_CREDIT - 1;
		expand(run, "split", instances({ description: "a", writes: ["out/a"] }, { description: "b", writes: ["out/b"] }));
		expect(run.nodes.split).toMatchObject({ status: "failed", attempt: 1 });
		expect(run.nodes.split!.error).toContain("R4: spawn credit exhausted");
		expect(run.status).toBe("blocked");
	});

	test("recursion: an instance expands within its own narrowed envelope until the depth budget is spent", () => {
		const run = createRun("r", shardPlan({ depth: 2 }), 0);
		expand(run, "split", instances({ description: "big", writes: ["out/big"], expand: true }, { description: "small", writes: ["out/small"] }));
		const big = run.plan.nodes.find((n) => n.id === "split/0")!;
		expect(big).toMatchObject({ kind: "expand", origin: "split", spawn: { max: 4, depth: 1, template: { kind: "act", writes: ["out/big"] } } });
		expect(big.writes).toBeUndefined();
		expect(frontier(run).sort()).toEqual(["split/0", "split/1"]);
		// Depth 1 left: the nested planner cannot expand again, and must stay inside out/big.
		expand(run, "split/0", instances({ description: "x", writes: ["out/big/x"], expand: true }), 4);
		expect(run.nodes["split/0"]!.error).toMatch(/R3/);
		expand(run, "split/0", instances({ description: "x", writes: ["out/small"] }), 6);
		expect(run.nodes["split/0"]!.error).toMatch(/R2/);
		expand(run, "split/0", instances({ description: "x", writes: ["out/big/x"] }, { description: "y", writes: ["out/big/y"] }), 8);
		expect(run.nodes["split/0"]!.status).toBe("succeeded");
		expect(instancesOf(run.plan, "split").sort()).toEqual(["split/0", "split/0/0", "split/0/1", "split/1"]);
		expect(run.compiled!.parents.check!.sort()).toEqual(["split", "split/0", "split/0/0", "split/0/1", "split/1"]);
		expect(run.spawnPotential!.map((p) => p[0])).toEqual([SPAWN_CREDIT - 2, SPAWN_CREDIT - 4]);
		for (const id of ["split/1", "split/0/0", "split/0/1"]) { start(run, id, `sa-${id}`, 9, "1"); succeed(run, id, "ok", 10); }
		start(run, "check", "sa-check", 11, "1");
		succeed(run, "check", verdict(["R"]), 12);
		expect(run.status).toBe("verified");
	});

	test("a re-expansion waits for executing instances, then replaces them", () => {
		const run = createRun("r", shardPlan(), 0);
		start(run, "split", "sa-split", 1, "1");
		readFact(run, "split", "ask-1", "two parts");
		succeed(run, "split", instances({ description: "a", writes: ["out/a"] }, { description: "b", writes: ["out/b"] }), 2);
		start(run, "split/0", "sa-0", 3, "1");
		reviseFact(run, "ask-1", "three parts", 4);
		expect(run.nodes.split!.status).toBe("pending");
		expect(frontier(run)).not.toContain("split");
		succeed(run, "split/0", "late", 5); // stale: its spawner was invalidated
		expect(frontier(run)).toContain("split");
		expand(run, "split", instances({ description: "a", writes: ["out/a"] }, { description: "b", writes: ["out/b"] }, { description: "c", writes: ["out/c"] }), 7);
		expect(instancesOf(run.plan, "split")).toEqual(["split/0", "split/1", "split/2"]);
		expect(run.nodes["split/0"]).toMatchObject({ status: "pending", runs: 0 });
		// Re-expansion is charged again: credit never refunds.
		expect(run.spawned).toBe(5);
	});
});

describe("Φ' and replan (C1/C2)", () => {
	test("a replan keeps an unchanged expansion and its results without charging credit", () => {
		const run = createRun("r", shardPlan(), 0);
		expand(run, "split", instances({ description: "a", writes: ["out/a"] }, { description: "b", writes: ["out/b"] }));
		start(run, "split/0", "sa-0", 3, "1"); succeed(run, "split/0", "done a", 4);
		const next = shardPlan({}, { nodes: [{ id: "note", kind: "act", writes: ["notes"] }, { id: "check2", kind: "verify", reads: ["notes"], covers: ["S"] }], edges: [["note", "check2"]] });
		next.goal.requirements.push("S");
		const before = spawnPotential(run);
		expect(replan(run, next, 5)).toEqual({ ok: true, invalidated: [] });
		expect(instancesOf(run.plan, "split")).toEqual(["split/0", "split/1"]);
		expect(run.nodes["split/0"]).toMatchObject({ status: "succeeded", result: "done a" });
		expect(run.nodes.split!.status).toBe("succeeded");
		expect(run.spawned).toBe(2);
		const after = spawnPotential(run);
		expect(after[0]).toBe(before[0]);
		expect(after[1]).toBe(before[1] - 1);
	});

	test("a replan that changes the template drops the expansion and re-plans it; credit is not refunded", () => {
		const run = createRun("r", shardPlan(), 0);
		expand(run, "split", instances({ description: "a", writes: ["out/a"] }));
		expect(replan(run, shardPlan({ max: 8 }), 3).ok).toBe(true);
		expect(instancesOf(run.plan, "split")).toEqual([]);
		expect(run.nodes.split).toMatchObject({ status: "pending", generation: 1 });
		expect(run.nodes["split/0"]).toBeUndefined();
		expect(spawnPotential(run)).toEqual([SPAWN_CREDIT - 1, 7, 1]);
		expect(frontier(run)).toEqual(["split"]);
	});

	test("model plans cannot carry host-owned instances", () => {
		const run = createRun("r", shardPlan(), 0);
		const forged = shardPlan();
		forged.nodes.push({ id: "split/9", kind: "act", origin: "split", writes: ["out/z"] });
		forged.edges.push(["split", "split/9"], ["split/9", "check"]);
		expect(replan(run, forged, 1)).toMatchObject({ ok: false, reason: expect.stringContaining("host-owned") });
	});

	test("Φ' strictly decreases over every expansion and replan", () => {
		const run = createRun("r", shardPlan({ depth: 2 }), 0);
		const seen: number[][] = [spawnPotential(run)];
		const less = (a: number[], b: number[]) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! < b[i]!; return false; };
		expand(run, "split", instances({ description: "a", writes: ["out/a"], expand: true }, { description: "b", writes: ["out/b"] }));
		seen.push(spawnPotential(run));
		expand(run, "split/0", instances({ description: "x", writes: ["out/a/x"] }), 4);
		seen.push(spawnPotential(run));
		expect(replan(run, shardPlan({ depth: 2 }), 5).ok).toBe(true);
		seen.push(spawnPotential(run));
		expect(replan(run, shardPlan({ depth: 1 }), 6).ok).toBe(true);
		seen.push(spawnPotential(run));
		for (let i = 1; i < seen.length; i++) expect(less(seen[i]!, seen[i - 1]!)).toBe(true);
	});
});

describe("κ settlement", () => {
	test("the orchestrator sees one bounded receipt per expansion, not one line per instance", () => {
		const run = createRun("r", shardPlan({ max: 16 }), 0);
		expand(run, "split", instances(...Array.from({ length: 16 }, (_, i) => ({ description: `part ${i}`, writes: [`out/${i}`] }))));
		for (let i = 0; i < 16; i++) start(run, `split/${i}`, `sa-${i}-with-a-long-handle-name`, 3, "1");
		const receipt = expansionReceipt(run, "split")!;
		expect(Buffer.byteLength(receipt)).toBeLessThanOrEqual(KAPPA);
		expect(receipt).toContain("16 instance(s) running=16");
		const text = summarize(run);
		expect(text).toContain("Φ'=(752,8,1)");
		expect(text.split("\n").filter((l) => l.startsWith("  split/"))).toEqual([receipt]);
	});

	test("plans without spawn keep their summary unchanged", () => {
		const run = createRun("r", { nodes: [{ id: "a", kind: "act", writes: ["x"] }, { id: "v", kind: "verify", reads: ["x"], covers: ["R"] }], edges: [["a", "v"]], goal: { requirements: ["R"] } }, 0);
		expect(summarize(run)).not.toContain("Φ'");
		expect(summarize(run)).not.toContain("<spawned>");
	});

	test("the planner prompt states the template, bounds and output contract", () => {
		const run = createRun("r", shardPlan({ depth: 2 }), 0);
		const prompt = dagPrompt(run, run.plan.nodes[0]!);
		expect(prompt).toContain("You plan a dynamic expansion");
		expect(prompt).toContain("(1 to 4)");
		expect(prompt).toContain("remaining depth 1");
		expect(prompt).toContain("Plan only: do not modify anything.");
		expect(prompt).toContain("You must not write anything.");
	});
});
