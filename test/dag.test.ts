import { describe, expect, test } from "bun:test";
import {
	cancel, createRun, fail, frontier, lessThan, MAX_NODE_ATTEMPTS, potential, readFact, rekey, replan, reviseFact, type RunState, settleOwnedNode, start, succeed as settleSuccess, unmet, waiting,
} from "../src/core/dag.ts";
import type { Plan, PlanNode } from "../src/core/plan.ts";

function succeed(run: RunState, id: string, result: string, now: number) {
 const node = run.plan.nodes.find(n => n.id === id)!;
 settleSuccess(run,id,node.kind === "verify" ? JSON.stringify({version:1, requirements:node.covers!.map(id=>({id,verdict:"pass",evidence:result})),summary:result,repairable:false}) : result,now);
}

function rng(seed: number) {
	let s = seed >>> 0;
	return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

/** Random layered DAG: acts writing disjoint scopes, one verify per requirement reading its writers. */
function randomPlan(seed: number, size: number, reqs = 2): Plan {
	const random = rng(seed);
	const nodes: PlanNode[] = [];
	const edges: [string, string][] = [];
	for (let i = 0; i < size; i++) {
		nodes.push({ id: `n${i}`, kind: "act", writes: [`s${i}`] });
		for (let j = 0; j < i; j++) if (random() < 0.3) edges.push([`n${j}`, `n${i}`]);
	}
	const requirements = Array.from({ length: reqs }, (_, r) => `R${r}`);
	for (const [r, req] of requirements.entries()) {
		const owned = nodes.filter((n) => n.kind === "act" && Number(n.id.slice(1)) % reqs === r);
		nodes.push({ id: `v${r}`, kind: "verify", reads: owned.map((n) => n.writes![0]!), covers: [req] });
		for (const n of owned) edges.push([n.id, `v${r}`]);
	}
	return { nodes, edges, goal: { requirements } };
}

/** Drive a run to a terminal status with a scripted failure policy. Returns the trace of Φ. */
function drive(run: RunState, random: () => number, failProbability: number): [number, number][] {
	const phis = [potential(run)];
	let t = 1;
	let guard = 0;
	while (run.status === "running") {
		const ready = frontier(run);
		expect(ready.length).toBeGreaterThan(0);
		for (const id of ready) start(run, id, `h${t}`, t++);
		for (const id of ready) {
			if (random() < failProbability) fail(run, id, "boom", t++);
			else succeed(run, id, `ok ${id}`, t++);
		}
		phis.push(potential(run));
		if (++guard > 10_000) throw new Error("run did not settle");
	}
	return phis;
}

describe("dag run state machine", () => {
	test("owned verification requires a host receipt bound to owner, key and attempt, not prose", () => {
		const plan: Plan = { nodes: [{ id: "v", kind: "verify", covers: ["R"] }], edges: [], goal: { requirements: ["R"] } };
		const ordinary = createRun("ordinary", plan, 0);
		start(ordinary, "v", "child", 1);
		settleSuccess(ordinary, "v", "looks good", 2);
		// Prose is no verdict: never certified; the verifier is retried with feedback until attempts run out.
		expect(ordinary.certified).toEqual([]);
		expect(ordinary.nodes.v!.status).toBe("pending");
		expect(ordinary.nodes.v!.protocolFeedback).toContain("malformed verdict");
		for (let t = 3; ordinary.nodes.v!.status === "pending"; t += 2) { start(ordinary, "v", "child", t); settleSuccess(ordinary, "v", "looks good", t + 1); }
		expect(ordinary.nodes.v!.attempt).toBe(3);
		expect(ordinary.status).toBe("blocked");
		expect(ordinary.certified).toEqual([]);
		const run = createRun("owned", plan, 0, 8, { missionId: "m" });
		start(run, "v", "child", 1);
		expect(() => succeed(run, "v", "looks good", 2)).toThrow("host-accepted");
		const receipt = { missionId: "m", nodeId: "v", receiptId: "host-r1", key: run.nodes.v!.key!, attempt: 1, result: "negative finding, valid evaluation" };
		expect(() => settleOwnedNode(run, { ...receipt, missionId: "other" }, 2)).toThrow("owner mismatch");
		expect(() => settleOwnedNode(run, { ...receipt, key: "stale" }, 2)).toThrow("Stale");
		expect(() => settleOwnedNode(run, { ...receipt, attempt: 2 }, 2)).toThrow("Stale");
		expect(run.certified).toEqual([]);
		// Even an untrusted completed status cannot mint a certificate on rekey.
		run.nodes.v!.status = "succeeded";
		rekey(run);
		expect(run.certified).toEqual([]);
		run.nodes.v!.status = "running";
		settleOwnedNode(run, receipt, 3);
		expect(run.status).toBe("verified");
		expect(run.certified).toEqual(["R"]);
		settleOwnedNode(run, receipt, 4);
		expect(run.updatedAt).toBe(3);
	});

	test("cancelled owned runs reject late receipts", () => {
		const run = createRun("owned", { nodes: [{ id: "v", kind: "verify", covers: ["R"] }], edges: [], goal: { requirements: ["R"] } }, 0, 8, { missionId: "m" });
		start(run, "v", "child", 1);
		cancel(run, "cancelled", 2);
		expect(() => settleOwnedNode(run, { missionId: "m", nodeId: "v", receiptId: "r", key: run.nodes.v!.key!, attempt: 1, result: "late" }, 3)).toThrow("Stale");
		expect(run.certified).toEqual([]);
	});

	test("Φ is non-increasing along any run without replans, and verified ⇔ no unmet requirement", () => {
		for (let seed = 1; seed <= 80; seed++) {
			const random = rng(seed * 7);
			const run = createRun(`r${seed}`, randomPlan(seed, 3 + (seed % 7)), 0);
			expect(run.status).toBe("running");
			const phis = drive(run, random, seed % 3 === 0 ? 0.25 : 0);
			for (let i = 1; i < phis.length; i++) expect(lessThan(phis[i - 1]!, phis[i]!)).toBe(false);
			expect(run.status === "verified").toBe(unmet(run).length === 0);
			if (run.status === "blocked") {
				expect(Object.values(run.nodes).filter((s) => s.status === "failed").length).toBeGreaterThan(0);
				expect(frontier(run)).toEqual([]);
			}
		}
	});

	test("a run without failures always verifies and runs every node exactly once", () => {
		for (let seed = 1; seed <= 40; seed++) {
			const run = createRun(`r${seed}`, randomPlan(seed, 2 + (seed % 8)), 0);
			drive(run, rng(seed), 0);
			expect(run.status).toBe("verified");
			for (const state of Object.values(run.nodes)) expect(state.attempt).toBe(1);
		}
	});

	test("a node failing on every attempt blocks after exactly MAX_NODE_ATTEMPTS, leaving the rest untouched", () => {
		const run = createRun("r", randomPlan(5, 6), 0);
		let t = 1;
		const victim = frontier(run)[0]!;
		for (let i = 0; i < MAX_NODE_ATTEMPTS; i++) {
			expect(frontier(run)).toContain(victim);
			start(run, victim, undefined, t++);
			fail(run, victim, "boom", t++);
		}
		expect(run.nodes[victim]!.status).toBe("failed");
		expect(frontier(run)).not.toContain(victim);
		// Other frontier nodes stay runnable; descendants of the victim never become ready.
		while (frontier(run).length) { for (const id of frontier(run)) { start(run, id, undefined, t++); succeed(run, id, "ok", t++); } }
		expect(run.status).toBe("blocked");
		expect(run.reason).toContain(victim);
		for (const [id, state] of Object.entries(run.nodes)) {
			if (id === victim) continue;
			const dependsOnVictim = run.compiled!.ancestors[id]!.includes(victim);
			expect(state.status).toBe(dependsOnVictim ? "pending" : "succeeded");
		}
	});

	test("reviseFact invalidates exactly the reading node and its descendants and nothing else", () => {
		for (let seed = 1; seed <= 40; seed++) {
			const run = createRun(`r${seed}`, randomPlan(seed, 7), 0);
			let t = 1;
			const reader = frontier(run)[0]!;
			// Run everything to verified, with `reader` reading fact f.
			while (frontier(run).length) {
				for (const id of frontier(run)) {
					start(run, id, undefined, t++);
					if (id === reader) readFact(run, id, "f", "v1");
					succeed(run, id, "ok", t++);
				}
			}
			expect(run.status).toBe("verified");
			const keysBefore = Object.fromEntries(Object.entries(run.nodes).map(([id, s]) => [id, s.key]));
			expect(reviseFact(run, "f", "v1", t++)).toEqual([]);
			const invalidated = reviseFact(run, "f", "v2", t++);
			const expected = new Set([reader, ...run.compiled!.order.filter((id) => run.compiled!.ancestors[id]!.includes(reader))]);
			expect(new Set(invalidated)).toEqual(expected);
			for (const [id, s] of Object.entries(run.nodes)) {
				expect(s.status).toBe(expected.has(id) ? "pending" : "succeeded");
				expect(s.key !== keysBefore[id]).toBe(expected.has(id));
			}
			expect(run.status).toBe("running");
			// Re-running only the invalidated set re-verifies.
			while (frontier(run).length) for (const id of frontier(run)) { start(run, id, undefined, t++); succeed(run, id, "ok", t++); }
			expect(run.status).toBe("verified");
			for (const [id, s] of Object.entries(run.nodes)) { expect(s.runs).toBe(expected.has(id) ? 2 : 1); expect(s.attempt).toBe(1); }
		}
	});

	test("replan: Φ strictly decreases, the goal is monotone, budget bounds the number of replans, kept nodes keep results", () => {
		const plan = randomPlan(3, 5);
		const run = createRun("r", plan, 0, 2);
		let t = 1;
		for (const id of frontier(run)) { start(run, id, undefined, t++); succeed(run, id, `ok ${id}`, t++); }
		const done = Object.entries(run.nodes).filter(([, s]) => s.status === "succeeded").map(([id]) => id);
		expect(done.length).toBeGreaterThan(0);
		const shrunk: Plan = { ...plan, goal: { requirements: plan.goal.requirements.slice(1) }, nodes: plan.nodes.filter((n) => n.id !== "v0"), edges: plan.edges.filter(([, to]) => to !== "v0") };
		expect(replan(run, shrunk, t++)).toMatchObject({ ok: false, reason: expect.stringContaining("monotone") });
		const broken: Plan = { ...plan, edges: [...plan.edges, [plan.edges[0]![1], plan.edges[0]![0]]] };
		expect(replan(run, broken, t++)).toMatchObject({ ok: false, reason: "plan does not compile" });
		const before = potential(run);
		const extended: Plan = {
			nodes: [...plan.nodes, { id: "extra", kind: "act", writes: ["extra"] }, { id: "v2", kind: "verify", reads: ["extra"], covers: ["R2"] }],
			edges: [...plan.edges, ["extra", "v2"]],
			goal: { requirements: [...plan.goal.requirements, "R2"] },
		};
		const first = replan(run, extended, t++);
		expect(first.ok).toBe(true);
		expect(lessThan(potential(run), before)).toBe(true);
		for (const id of done) expect(run.nodes[id]!.status).toBe("succeeded");
		expect(run.nodes["extra"]!.status).toBe("pending");
		expect(run.replanBudget).toBe(1);
		expect(replan(run, extended, t++).ok).toBe(true);
		expect(replan(run, extended, t++)).toMatchObject({ ok: false, reason: "replan budget exhausted" });
		for (let i = 1; i < run.potential.length; i++) expect(lessThan(run.potential[i]!, run.potential[i - 1]!)).toBe(true);
		while (frontier(run).length) for (const id of frontier(run)) { start(run, id, undefined, t++); succeed(run, id, "ok", t++); }
		expect(run.status).toBe("verified");
	});

	test("a non-compiling plan is blocked at creation with diagnostics; cancel is terminal except after verified", () => {
		const run = createRun("r", { nodes: [{ id: "a", kind: "act", writes: ["x"] }], edges: [], goal: { requirements: ["R"] } }, 0);
		expect(run.status).toBe("blocked");
		expect(run.diagnostics!.map((d) => d.check).sort()).toEqual(["coverage", "verify-dominance"]);
		expect(frontier(run)).toEqual([]);
		cancel(run, "operator", 1);
		expect(run.status).toBe("cancelled");
		const ok = createRun("r2", randomPlan(1, 3), 0);
		let t = 1;
		while (frontier(ok).length) for (const id of frontier(ok)) { start(ok, id, undefined, t++); succeed(ok, id, "ok", t++); }
		cancel(ok, "late", t);
		expect(ok.status).toBe("verified");
	});

	test("waiting nodes block only their descendants; the rest of the frontier keeps draining", () => {
		const run = createRun("r", randomPlan(9, 8), 0);
		let t = 1;
		const [waiter, ...others] = frontier(run);
		start(run, waiter!, undefined, t++);
		waiting(run, waiter!, t++);
		for (const id of others) { start(run, id, undefined, t++); succeed(run, id, "ok", t++); }
		let drained = 0;
		while (frontier(run).length) { for (const id of frontier(run)) { start(run, id, undefined, t++); succeed(run, id, "ok", t++); drained++; } }
		const blockedByWaiter = run.compiled!.order.filter((id) => run.compiled!.ancestors[id]!.includes(waiter!));
		expect(drained + others.length + 1 + blockedByWaiter.length).toBe(run.compiled!.order.length);
		expect(run.status).toBe("running");
		for (const id of blockedByWaiter) expect(run.nodes[id]!.status).toBe("pending");
		succeed(run, waiter!, "ok", t++);
		while (frontier(run).length) for (const id of frontier(run)) { start(run, id, undefined, t++); succeed(run, id, "ok", t++); }
		expect(run.status).toBe("verified");
	});
});
