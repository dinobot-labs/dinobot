import { describe, expect, test } from "bun:test";
import {
	cancel, closeSettledNode, createRun, deadRequirements, fail, frontier, frozenVerifiers, potential, replan, type RunState, start, succeed, waiting,
} from "../src/core/dag.ts";
import type { Plan, PlanNode } from "../src/core/plan.ts";

/**
 * State invariants of ordinary DAG runs, each derived from a counterexample recorded in a real session
 * (tui:20261005010039-3e6c):
 *  I1  terminal closure: a cancelled/verified run converges to no running/waiting node once executors settle;
 *  I3  liveness of replans: an accepted replan leaves no verifier that can never become ready;
 *  B   a never-compiled run's first compile is free, so a compile fix does not spend repair budget.
 */
const verdict = (reqs: string[], value: "pass" | "fail") => JSON.stringify({ version: 1, requirements: reqs.map((id) => ({ id, verdict: value, evidence: `observed ${value}` })), summary: value, repairable: false });
const pass = (run: RunState, id: string, now: number) => {
	const node = run.plan.nodes.find((n) => n.id === id)!;
	succeed(run, id, node.kind === "verify" ? verdict(node.covers!, "pass") : `ok ${id}`, now);
};
const active = (run: RunState) => Object.entries(run.nodes).filter(([, s]) => s.status === "running" || s.status === "waiting").map(([id]) => id);

function rng(seed: number) {
	let s = seed >>> 0;
	return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}
function randomPlan(seed: number, size: number): Plan {
	const random = rng(seed);
	const nodes: PlanNode[] = [];
	const edges: [string, string][] = [];
	for (let i = 0; i < size; i++) {
		nodes.push({ id: `n${i}`, kind: "act", writes: [`s${i}`] });
		for (let j = 0; j < i; j++) if (random() < 0.3) edges.push([`n${j}`, `n${i}`]);
	}
	for (const r of [0, 1]) {
		const owned = nodes.filter((n) => Number(n.id.slice(1)) % 2 === r);
		nodes.push({ id: `v${r}`, kind: "verify", reads: owned.map((n) => n.writes![0]!), covers: [`R${r}`] });
		for (const n of owned) edges.push([n.id, `v${r}`]);
	}
	return { nodes, edges, goal: { requirements: ["R0", "R1"] } };
}

describe("I1 terminal closure", () => {
	test("cancel closes executor-less nodes at once and keeps subagent nodes running until their executor settles", () => {
		const plan: Plan = {
			nodes: [{ id: "q", kind: "ask" }, { id: "a", kind: "act", writes: ["x"] }, { id: "v", kind: "verify", reads: ["x"], covers: ["R"] }],
			edges: [["q", "a"], ["a", "v"]], goal: { requirements: ["R"] },
		};
		const run = createRun("r", plan, 0);
		start(run, "q", "orchestrator", 1); waiting(run, "q", 1);
		cancel(run, "operator", 2);
		expect(run.nodes.q).toMatchObject({ status: "skipped", endedAt: 2 });
		expect(run.nodes.q!.error).toContain("operator");

		const live = createRun("live", plan, 0);
		start(live, "q", "orchestrator", 1); succeed(live, "q", "yes", 2);
		start(live, "a", "sa-1", 3, "100");
		cancel(live, "operator", 4);
		// Run termination alone does not claim the child stopped.
		expect(active(live)).toEqual(["a"]);
		expect(() => closeSettledNode(createRun("x", plan, 0), "q", { status: "completed" }, 5)).toThrow("not terminal");
		expect(() => closeSettledNode(live, "v", { status: "completed" }, 5)).toThrow("not running");
		closeSettledNode(live, "a", { status: "completed", answer: "late artifact" }, 5);
		expect(active(live)).toEqual([]);
		expect(live.nodes.a).toMatchObject({ status: "skipped", result: "late artifact", endedAt: 5 });
		expect(live.nodes.a!.unknownEffects).toBeUndefined();
		expect(live.certified).toEqual([]);
		expect(live.status).toBe("cancelled");
	});

	test("an aborted executor is closed with unknown effects; a late verifier verdict is retained but certifies nothing", () => {
		const plan: Plan = { nodes: [{ id: "a", kind: "act", writes: ["x"] }, { id: "v", kind: "verify", reads: ["x"], covers: ["R"] }], edges: [["a", "v"]], goal: { requirements: ["R"] } };
		const aborted = createRun("aborted", plan, 0);
		start(aborted, "a", "sa-1", 1, "1");
		cancel(aborted, "stop", 2);
		closeSettledNode(aborted, "a", { status: "cancelled", error: "aborted" }, 3);
		expect(aborted.nodes.a).toMatchObject({ status: "skipped", unknownEffects: true });

		const late = createRun("late", plan, 0);
		start(late, "a", "sa-1", 1, "1"); pass(late, "a", 2);
		start(late, "v", "sa-2", 3, "2");
		cancel(late, "stop", 4);
		closeSettledNode(late, "v", { status: "completed", answer: verdict(["R"], "pass") }, 5);
		expect(late.nodes.v!.status).toBe("skipped");
		expect(late.nodes.v!.result).toContain("pass");
		expect(late.certified).toEqual([]);
		expect(late.status).toBe("cancelled");
	});

	test("property: cancelling at any point then settling every executor leaves no running node and no new certification", () => {
		for (let seed = 1; seed <= 150; seed++) {
			const random = rng(seed * 7919);
			const run = createRun(`p${seed}`, randomPlan(seed, 2 + (seed % 7)), 0);
			let t = 1;
			const stopAfter = Math.floor(random() * 6);
			for (let round = 0; round < stopAfter && run.status === "running"; round++) {
				for (const id of frontier(run)) start(run, id, `sa-${t}`, t++, String(t));
				for (const id of active(run)) if (random() < 0.6) pass(run, id, t++);
			}
			for (const id of frontier(run)) start(run, id, `sa-${t}`, t++, String(t));
			const certified = [...run.certified];
			const wasVerified = run.status === "verified";
			cancel(run, "property", t++);
			for (const id of active(run)) closeSettledNode(run, id, random() < 0.5 ? { status: "completed", answer: "late" } : { status: "cancelled" }, t++);
			expect(active(run)).toEqual([]);
			expect(run.status).toBe(wasVerified ? "verified" : "cancelled");
			expect(run.certified).toEqual(certified);
			expect(frontier(run)).toEqual([]);
		}
	});
});

describe("I3 replans never admit a verifier that can never run", () => {
	// Recorded dag-9189b4118763: the reviewer failed; the parent repaired code outside the DAG; the replan's
	// snapshot act declared no writes, so the new reviewer bound the identical, already rejected artifact.
	const reviewed = () => {
		const run = createRun("r", { nodes: [{ id: "core-review", kind: "verify", covers: ["core"] }], edges: [], goal: { requirements: ["core"] } }, 0);
		start(run, "core-review", "sa-1", 1, "1");
		succeed(run, "core-review", verdict(["core"], "fail"), 2);
		expect(run.status).toBe("blocked");
		return run;
	};
	const repairPlan = (writes: string[]): Plan => ({
		nodes: [{ id: "repaired-snapshot", kind: "act", writes, post: [{ kind: "file", path: "src/core/queue.ts" }] },
			{ id: "core-review-repaired", kind: "verify", reads: writes, pre: [{ kind: "file", path: "src/core/queue.ts" }], covers: ["core"] }],
		edges: [["repaired-snapshot", "core-review-repaired"]], goal: { requirements: ["core"] },
	});

	test("the recorded counterexample is rejected without spending budget or changing the run", () => {
		const run = reviewed();
		const before = JSON.stringify(run);
		const outcome = replan(run, repairPlan([]), 3);
		expect(outcome.ok).toBe(false);
		expect(outcome.ok ? "" : outcome.reason).toContain("core-review-repaired re-checks the already rejected artifact for core");
		expect(JSON.stringify(run)).toBe(before);
	});

	test("declaring the writes of the repaired artifact makes the same plan live and able to certify", () => {
		const run = reviewed();
		expect(replan(run, repairPlan(["src/core"]), 3).ok).toBe(true);
		expect(run.replanBudget).toBe(7);
		expect(frontier(run)).toEqual(["repaired-snapshot"]);
		start(run, "repaired-snapshot", "sa-2", 4, "2"); pass(run, "repaired-snapshot", 5);
		expect(frontier(run)).toEqual(["core-review-repaired"]);
		start(run, "core-review-repaired", "sa-3", 6, "3"); pass(run, "core-review-repaired", 7);
		expect(run.status).toBe("verified");
	});

	test("a verifier frozen during execution names itself in the blocked reason", () => {
		const plan: Plan = {
			nodes: [{ id: "a", kind: "act", writes: ["x"] }, { id: "v1", kind: "verify", reads: ["x"], covers: ["R"] }, { id: "doc", kind: "act" }, { id: "v2", kind: "verify", reads: ["x"], covers: ["R"] }],
			edges: [["a", "v1"], ["a", "doc"], ["doc", "v2"]], goal: { requirements: ["R"] },
		};
		const run = createRun("r", plan, 0);
		start(run, "a", "sa-1", 1, "1"); pass(run, "a", 2);
		start(run, "v1", "sa-2", 3, "2"); start(run, "doc", "sa-3", 3, "3");
		succeed(run, "v1", verdict(["R"], "fail"), 4);
		pass(run, "doc", 5);
		expect(frozenVerifiers(run)).toEqual([{ id: "v2", requirements: ["R"] }]);
		expect(run.status).toBe("blocked");
		expect(run.reason).toContain("v2 (R)");
		expect(run.reason).toContain("a writer ancestor must change the artifact");
	});

	test("property: every accepted replan leaves no frozen verifier and every rejected one leaves the run unchanged", () => {
		let accepted = 0, rejected = 0;
		for (let seed = 1; seed <= 200; seed++) {
			const random = rng(seed * 104729);
			const run = createRun(`q${seed}`, randomPlan(seed, 2 + (seed % 6)), 0);
			let t = 1;
			while (run.status === "running") {
				for (const id of frontier(run)) start(run, id, `sa-${t}`, t++, String(t));
				for (const id of active(run)) {
					const node = run.plan.nodes.find((n) => n.id === id)!;
					if (node.kind === "verify" && random() < 0.4) succeed(run, id, verdict(node.covers!, "fail"), t++);
					else if (random() < 0.1) fail(run, id, "boom", t++);
					else pass(run, id, t++);
				}
			}
			if (run.status !== "blocked") continue;
			const next = structuredClone(run.plan);
			for (const node of next.nodes) if (node.kind === "verify" || random() < 0.3) node.description = `retry ${seed}`;
			if (random() < 0.5) {
				next.nodes.push({ id: "fresh", kind: "act", writes: ["fresh"] });
				for (const node of next.nodes) if (node.kind === "verify") { node.reads = [...(node.reads ?? []), "fresh"]; next.edges.push(["fresh", node.id]); }
			}
			const before = JSON.stringify(run);
			const outcome = replan(run, next, t);
			if (outcome.ok) {
				accepted++;
				expect(deadRequirements(run)).toEqual([]);
				// Independent oracle: an accepted replan must be live, i.e. if every later node passes, the run verifies.
				const probe: RunState = JSON.parse(JSON.stringify(run));
				let u = t + 1;
				for (let guard = 0; probe.status === "running" && guard < 1000; guard++) {
					const ready = frontier(probe);
					if (!ready.length) break;
					for (const id of ready) start(probe, id, `sa-${u}`, u++, String(u));
					for (const id of ready) pass(probe, id, u++);
				}
				expect(probe.status).toBe("verified");
			} else { rejected++; expect(JSON.stringify(run)).toBe(before); }
		}
		expect(accepted).toBeGreaterThan(0);
		expect(rejected).toBeGreaterThan(0);
	});
});

describe("review counterexamples", () => {
	test("a frozen verifier of an already certified requirement does not block an unrelated replan", () => {
		const plan: Plan = {
			nodes: [
				{ id: "a", kind: "act", writes: ["x"] }, { id: "v1", kind: "verify", reads: ["x"], covers: ["R"] },
				// v2 alone certifies Z, so b's write z cannot be left unchecked (certifying dominance).
				{ id: "b", kind: "act", writes: ["z"] }, { id: "v2", kind: "verify", reads: ["x", "z"], covers: ["R", "Z"] },
				{ id: "doc", kind: "act" }, { id: "v3", kind: "verify", reads: ["x"], covers: ["R"] },
				{ id: "s", kind: "act", writes: ["y"] }, { id: "vs", kind: "verify", reads: ["y"], covers: ["S"] },
			],
			edges: [["a", "v1"], ["a", "b"], ["b", "v2"], ["a", "doc"], ["doc", "v3"], ["v1", "doc"], ["s", "vs"]],
			goal: { requirements: ["R", "S", "Z"] },
		};
		const run = createRun("r", plan, 0);
		start(run, "a", "sa-1", 1, "1"); pass(run, "a", 2);
		start(run, "s", "sa-2", 2, "2"); fail(run, "s", "boom", 3);
		start(run, "s", "sa-3", 3, "3"); fail(run, "s", "boom", 4);
		start(run, "s", "sa-4", 4, "4"); fail(run, "s", "boom", 5);
		start(run, "v1", "sa-5", 5, "5"); start(run, "b", "sa-6", 5, "6");
		succeed(run, "v1", verdict(["R"], "fail"), 6); pass(run, "b", 7);
		start(run, "v2", "sa-7", 8, "7"); pass(run, "v2", 9);
		expect(run.certified).toEqual(["R", "Z"]);
		expect(run.status).toBe("blocked");
		expect(frozenVerifiers(run).map((f) => f.id)).toContain("v3");
		expect(deadRequirements(run)).toEqual([{ requirement: "S", verifiers: [{ id: "vs", why: "upstream" }] }]);
		expect(run.reason).not.toContain("v3");
		const next = structuredClone(run.plan);
		next.nodes.find((n) => n.id === "s")!.description = "fixed actor";
		const outcome = replan(run, next, 10);
		expect(outcome).toEqual({ ok: true, invalidated: [] });
		expect(frontier(run)).toEqual(["s"]);
	});

	test("an identical replan of a run whose only verifier failed is rejected without spending budget", () => {
		const plan: Plan = { nodes: [{ id: "a", kind: "act", writes: ["x"] }, { id: "v", kind: "verify", reads: ["x"], covers: ["R"] }], edges: [["a", "v"]], goal: { requirements: ["R"] } };
		const run = createRun("r", plan, 0);
		start(run, "a", "sa-1", 1, "1"); pass(run, "a", 2);
		start(run, "v", "sa-2", 3, "2"); succeed(run, "v", verdict(["R"], "fail"), 4);
		const before = JSON.stringify(run);
		const outcome = replan(run, structuredClone(plan), 5);
		expect(outcome.ok ? "" : outcome.reason).toContain("v already failed for R");
		expect(JSON.stringify(run)).toBe(before);
		const changed = structuredClone(plan);
		changed.nodes[0]!.description = "repaired actor";
		expect(replan(run, changed, 6).ok).toBe(true);
		expect(frontier(run)).toEqual(["a"]);
	});

	test("cancel closes interrupted synchronous checks, is idempotent, and leaves research-owned nodes to their host", () => {
		const plan: Plan = { nodes: [{ id: "a", kind: "act", writes: ["x"] }, { id: "v", kind: "verify", reads: ["x"], covers: ["R"] }], edges: [["a", "v"]], goal: { requirements: ["R"] } };
		const run = createRun("r", plan, 0);
		start(run, "a", "sa-1", 1, "1"); pass(run, "a", 2);
		start(run, "v", "check:unit", 3);
		cancel(run, "first", 4);
		expect(run.nodes.v).toMatchObject({ status: "skipped", endedAt: 4 });
		const once = JSON.stringify(run);
		cancel(run, "second", 5);
		expect(JSON.stringify(run)).toBe(once);
		expect(run.reason).toBe("first");
		const owned = createRun("o", plan, 0, 8, { missionId: "m" });
		start(owned, "a", "host", 1);
		cancel(owned, "mission", 2);
		expect(owned.nodes.a!.status).toBe("running");
		expect(() => closeSettledNode(owned, "a", { status: "completed" }, 3)).toThrow("Research-owned");
	});
});

describe("B a never-compiled run compiles once for free", () => {
	const good: Plan = { nodes: [{ id: "a", kind: "act", writes: ["x"] }, { id: "v", kind: "verify", reads: ["x"], covers: ["R"] }], edges: [["a", "v"]], goal: { requirements: ["R"] } };
	const bad: Plan = { nodes: [{ id: "a", kind: "act", writes: ["x"] }], edges: [], goal: { requirements: ["R"] } };

	test("compile repair keeps the budget; a failing repair changes nothing; later replans are charged", () => {
		const run = createRun("r", bad, 0, 2);
		expect(run.status).toBe("blocked");
		expect(run.potential).toEqual([]);
		const before = JSON.stringify(run);
		expect(replan(run, bad, 1).ok).toBe(false);
		expect(JSON.stringify(run)).toBe(before);
		expect(replan(run, good, 2)).toEqual({ ok: true, invalidated: [] });
		expect(run).toMatchObject({ status: "running", revision: 1, replanBudget: 2 });
		expect(run.potential).toEqual([[2, 1]]);
		expect(frontier(run)).toEqual(["a"]);
		const second = structuredClone(good);
		second.nodes[0]!.description = "changed";
		expect(replan(run, second, 3).ok).toBe(true);
		expect(run.replanBudget).toBe(1);
		expect(run.potential).toEqual([[2, 1], [1, 1]]);
	});

	test("a never-compiled run with zero budget can still be fixed exactly once", () => {
		const run = createRun("r", bad, 0, 0);
		expect(replan(run, good, 1).ok).toBe(true);
		expect(potential(run)).toEqual([0, 1]);
		expect(replan(run, good, 2)).toEqual({ ok: false, reason: "replan budget exhausted" });
	});

	test("recorded dag-7390e651a56e budget 2: a compile fix no longer exhausts the repair for the real failure", () => {
		const plan: Plan = {
			nodes: [{ id: "freeze", kind: "act", writes: ["inputs"] }, { id: "acceptance", kind: "verify", reads: ["inputs"], covers: ["independent"] }],
			edges: [["freeze", "acceptance"]], goal: { requirements: ["independent"] },
		};
		const run = createRun("r", { ...plan, edges: [] }, 0, 2);
		expect(run.status).toBe("blocked");
		expect(replan(run, plan, 1).ok).toBe(true);
		start(run, "freeze", "sa-1", 2, "1"); pass(run, "freeze", 3);
		start(run, "acceptance", "sa-2", 4, "2"); succeed(run, "acceptance", verdict(["independent"], "fail"), 5);
		const split: Plan = {
			nodes: [plan.nodes[0]!, { id: "acceptance-run", kind: "act", writes: ["receipts"] }, { id: "acceptance-audit", kind: "verify", reads: ["inputs", "receipts"], covers: ["independent"] }],
			edges: [["freeze", "acceptance-run"], ["acceptance-run", "acceptance-audit"]], goal: { requirements: ["independent"] },
		};
		expect(replan(run, split, 6).ok).toBe(true);
		expect(run.replanBudget).toBe(1);
		expect(run.potential).toEqual([[2, 1], [1, 1]]);
	});
});
