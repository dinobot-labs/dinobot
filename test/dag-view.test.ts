import { describe, expect, test } from "bun:test";
import { createRun, fail, frontier, replan, type RunState, start, succeed, waiting } from "../src/core/dag.ts";
import { activeDagView, dagView } from "../src/core/dag-view.ts";
import type { Plan, PlanNode } from "../src/core/plan.ts";
import type { DagView } from "../src/core/ui-contract.ts";

function rng(seed: number) {
	let s = seed >>> 0;
	return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

/** Random DAG over n0..n(size-1) (edges only from lower to higher index) plus one verify per requirement. */
function randomPlan(seed: number, size: number, density: number): Plan {
	const random = rng(seed);
	const nodes: PlanNode[] = [];
	const edges: [string, string][] = [];
	for (let i = 0; i < size; i++) {
		nodes.push({ id: `n${i}`, kind: "act", writes: [`s${i}`], description: `node ${i}\nsecond line` });
		for (let j = 0; j < i; j++) if (random() < density) edges.push([`n${j}`, `n${i}`]);
	}
	nodes.push({ id: "v", kind: "verify", reads: nodes.map((n) => n.writes![0]!), covers: ["R"] });
	for (let i = 0; i < size; i++) edges.push([`n${i}`, "v"]);
	return { nodes, edges, goal: { requirements: ["R"] } };
}

const cases = (): { seed: number; run: RunState }[] =>
	Array.from({ length: 240 }, (_, k) => {
		const seed = k + 1;
		return { seed, run: createRun(`r${seed}`, randomPlan(seed, 1 + (seed % 19), [0.1, 0.3, 0.6][seed % 3]!), 0) };
	});

/** Ancestor sets from a parent function, by memoised DFS (independent of the compiler's own ancestors). */
function closure(ids: readonly string[], parents: (id: string) => readonly string[]): Map<string, Set<string>> {
	const memo = new Map<string, Set<string>>();
	const visit = (id: string): Set<string> => {
		const known = memo.get(id);
		if (known) return known;
		const set = new Set<string>();
		for (const p of parents(id)) { set.add(p); for (const a of visit(p)) set.add(a); }
		memo.set(id, set);
		return set;
	};
	for (const id of ids) visit(id);
	return memo;
}

const layoutOf = (view: DagView) => view.nodes.map((n) => ({ id: n.id, level: n.level, parents: n.parents }));

describe("dag view layout (ADR 0032)", () => {
	test("P1 every edge points down: strictly higher level and later row; P2 waves are antichains", () => {
		for (const { run } of cases()) {
			const view = dagView(run);
			const row = new Map(view.nodes.map((n, index) => [n.id, index]));
			const level = new Map(view.nodes.map((n) => [n.id, n.level]));
			for (const [u, v] of run.plan.edges) {
				expect(level.get(u)!).toBeLessThan(level.get(v)!);
				expect(row.get(u)!).toBeLessThan(row.get(v)!);
			}
			for (let i = 1; i < view.nodes.length; i++) expect(view.nodes[i]!.level).toBeGreaterThanOrEqual(view.nodes[i - 1]!.level);
		}
	});

	test("P3 the number of waves equals the longest chain (Mirsky minimum) and every wave is non-empty", () => {
		for (const { run } of cases()) {
			const view = dagView(run);
			const children = new Map<string, string[]>();
			for (const [u, v] of run.plan.edges) children.set(u, [...(children.get(u) ?? []), v]);
			const memo = new Map<string, number>();
			const chain = (id: string): number => {
				const known = memo.get(id);
				if (known !== undefined) return known;
				const value = 1 + Math.max(0, ...(children.get(id) ?? []).map(chain));
				memo.set(id, value);
				return value;
			};
			const longest = Math.max(...run.plan.nodes.map((n) => chain(n.id)));
			expect(view.levels).toBe(longest);
			expect(new Set(view.nodes.map((n) => n.level))).toEqual(new Set(Array.from({ length: longest }, (_, k) => k)));
		}
	});

	test("P4 shown parents are the transitive reduction: same reachability, and no shown edge is redundant", () => {
		for (const { run } of cases()) {
			const view = dagView(run);
			const ids = view.nodes.map((n) => n.id);
			const raw = new Map(ids.map((id) => [id, run.plan.edges.filter(([, v]) => v === id).map(([u]) => u)]));
			const shown = new Map(view.nodes.map((n) => [n.id, n.parents]));
			const full = closure(ids, (id) => raw.get(id)!);
			const reduced = closure(ids, (id) => shown.get(id)!);
			for (const id of ids) expect(reduced.get(id)).toEqual(full.get(id));
			for (const node of view.nodes) {
				for (const p of node.parents) {
					expect(raw.get(node.id)).toContain(p);
					const without = closure(ids, (id) => (id === node.id ? shown.get(id)!.filter((q) => q !== p) : shown.get(id)!));
					expect(without.get(node.id)!.has(p)).toBe(false);
				}
			}
		}
	});

	test("P5 layout never depends on node states; ready is exactly the executor frontier", () => {
		for (const { seed, run } of cases()) {
			const random = rng(seed * 31);
			const before = layoutOf(dagView(run));
			let t = 1;
			for (let guard = 0; run.status === "running" && guard < 200; guard++) {
				const ready = frontier(run);
				const view = dagView(run);
				expect(view.nodes.filter((n) => n.state === "ready").map((n) => n.id).sort()).toEqual([...ready].sort());
				expect(layoutOf(view)).toEqual(before);
				for (const id of ready) start(run, id, `h${t}`, t++);
				const mid = dagView(run);
				expect(mid.nodes.filter((n) => n.state === "ready")).toEqual([]);
				expect(layoutOf(mid)).toEqual(before);
				for (const id of ready) {
					if (random() < 0.2) fail(run, id, "boom\ndetail", t++);
					else succeed(run, id, `ok ${id}\nmore`, t++);
				}
			}
			expect(layoutOf(dagView(run))).toEqual(before);
		}
	});

	test("projection fields: first-line title/error/result, attempts, handles, certification", () => {
		const plan: Plan = {
			nodes: [
				{ id: "a", kind: "act", writes: ["x"], description: `\n  ${"t".repeat(150)}\nrest` },
				{ id: "q", kind: "ask" },
				{ id: "v", kind: "verify", reads: ["x"], covers: ["R"] },
			],
			edges: [["a", "v"], ["q", "v"]],
			goal: { requirements: ["R"] },
		};
		const run = createRun("r", plan, 0);
		start(run, "a", "sa-1", 1);
		fail(run, "a", `${"e".repeat(250)}\nstack`, 2);
		start(run, "q", "orchestrator", 3);
		waiting(run, "q", 4);
		const view = dagView(run);
		const a = view.nodes.find((n) => n.id === "a")!;
		expect(a.title).toBe(`${"t".repeat(117)}...`);
		const wide = dagView(createRun("w", { nodes: [{ id: "k", kind: "verify", covers: ["R"], description: "가".repeat(100) }], edges: [], goal: { requirements: ["R"] } }, 0)).nodes[0]!;
		expect(Bun.stringWidth(wide.title)).toBeLessThanOrEqual(120);
		expect(wide.title).toBe(`${"가".repeat(58)}...`);
		expect(a.error).toBe(`${"e".repeat(197)}...`);
		expect(a).toMatchObject({ state: "ready", attempt: 1, maxAttempts: 3, handle: "sa-1", startedAt: 1, endedAt: 2, level: 0, critical: expect.any(Boolean) });
		expect(view.nodes.find((n) => n.id === "q")).toMatchObject({ state: "waiting", handle: "orchestrator", title: "" });
		expect(view.nodes.find((n) => n.id === "v")).toMatchObject({ state: "pending", parents: ["a", "q"], covers: ["R"], level: 1 });
		expect(view.requirements).toEqual([{ id: "R", certified: false }]);
		expect(view.levels).toBe(2);
	});

	test("directParents keep every compiled parent; a reverted direct parent still blocks a node whose reduced parents succeeded", () => {
		for (const { run } of cases().slice(0, 60)) {
			for (const node of dagView(run).nodes) expect([...node.directParents].sort()).toEqual([...run.compiled!.parents[node.id]!].sort());
		}
		const plan: Plan = {
			nodes: [{ id: "a", kind: "act" }, { id: "b", kind: "act" }, { id: "v", kind: "verify", covers: ["R"] }],
			edges: [["a", "b"], ["b", "v"], ["a", "v"]],
			goal: { requirements: ["R"] },
		};
		const run = createRun("r", plan, 0);
		start(run, "a", "sa-a", 1);
		succeed(run, "a", "ok", 2);
		start(run, "b", "sa-b", 3);
		const changed: Plan = { ...plan, nodes: plan.nodes.map((n) => (n.id === "a" ? { ...n, reads: ["docs"] } : n)) };
		expect(replan(run, changed, 4).ok).toBe(false);
		succeed(run, "b", "settled before replan", 4);
		expect(replan(run, changed, 5).ok).toBe(true);

		const view = dagView(run);
		const state = Object.fromEntries(view.nodes.map((n) => [n.id, n.state]));
		expect(state).toEqual({ a: "ready", b: "pending", v: "pending" });
		expect(view.nodes.find((n) => n.id === "v")).toMatchObject({ parents: ["b"], directParents: ["a", "b"] });
	});

	test("shown run: the active one, else the latest attempt that never compiled; a failed attempt never replaces an active run", () => {
		const cyclic: Plan = { nodes: [{ id: "a", kind: "act" }, { id: "b", kind: "act" }, { id: "v", kind: "verify", covers: ["R"] }], edges: [["a", "b"], ["b", "a"]], goal: { requirements: ["R"] } };
		const first = createRun("bad-1", cyclic, 1);
		const second = createRun("bad-2", cyclic, 2);
		const view = dagView(second);
		expect(view).toMatchObject({ status: "blocked", levels: 0, nodes: [] });
		expect(view.diagnostics?.[0]).toContain("acyclic");
		expect(activeDagView({ runs: [first, second] })?.id).toBe("bad-2");
		expect(activeDagView({ runs: [second, first] })?.id).toBe("bad-2");
		expect(activeDagView({ runs: [] })).toBeNull();
		expect(activeDagView(undefined)).toBeNull();
		expect(activeDagView(null)).toBeNull();
		const good = createRun("good", randomPlan(3, 4, 0.3), 0);
		expect(activeDagView({ runs: [good, first, second], activeId: "good" })?.id).toBe("good");
	});
});
