import { describe, expect, test } from "bun:test";
import { compilePlan, descendants, nodeKey, type Plan, type PlanNode, readyNodes, satisfies, scopesOverlap } from "../src/core/plan.ts";

function rng(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
}

/** A random DAG whose edges respect a hidden order; closure holds by construction, coverage and verify dominance too. */
function randomPlan(seed: number, size: number): Plan {
	const random = rng(seed);
	const nodes: PlanNode[] = [];
	const edges: [string, string][] = [];
	for (let i = 0; i < size; i++) {
		const id = `n${i}`;
		const scope = `s${i}`;
		nodes.push({ id, kind: "act", writes: [scope], post: [{ kind: "file", path: scope, hash: `h${i}` }] });
		for (let j = 0; j < i; j++) if (random() < 0.3) edges.push([`n${j}`, id]);
	}
	// Preconditions are drawn only from ancestors' posts, so closure holds.
	const order = nodes.map((n) => n.id);
	const anc = new Map<string, Set<string>>(order.map((id) => [id, new Set()]));
	for (const [from, to] of edges) anc.get(to)!.add(from);
	for (const id of order) for (const p of [...anc.get(id)!]) for (const a of anc.get(p)!) anc.get(id)!.add(a);
	for (const node of nodes) {
		const pool = [...anc.get(node.id)!];
		if (pool.length && random() < 0.7) {
			const a = pool[Math.floor(random() * pool.length)]!;
			node.pre = [{ kind: "file", path: `s${a.slice(1)}` }];
		}
	}
	// One verify sink reading every scope certifies every requirement and dominates every writer.
	nodes.push({ id: "verify", kind: "verify", reads: nodes.map((n) => n.writes![0]!), covers: ["R"] });
	for (const node of nodes) if (node.id !== "verify") edges.push([node.id, "verify"]);
	return { nodes, edges, goal: { requirements: ["R"] } };
}

describe("compilePlan properties", () => {
	test("random DAGs compile and the order respects every edge; descendants match brute force", () => {
		for (let seed = 1; seed <= 60; seed++) {
			const plan = randomPlan(seed, 3 + (seed % 9));
			const result = compilePlan(plan);
			if (!result.ok) throw new Error(`seed ${seed}: ${JSON.stringify(result.diagnostics)}`);
			const index = new Map(result.compiled.order.map((id, i) => [id, i]));
			for (const [from, to] of plan.edges) expect(index.get(from)!).toBeLessThan(index.get(to)!);
			expect(result.compiled.criticalPath.at(-1)).toBe("verify");
			expect(result.compiled.criticalCost).toBeLessThanOrEqual(result.compiled.totalCost);
			for (const node of plan.nodes) {
				const reach = new Set<string>();
				const stack = [node.id];
				while (stack.length) {
					const cur = stack.pop()!;
					for (const [from, to] of plan.edges) if (from === cur && !reach.has(to)) { reach.add(to); stack.push(to); }
				}
				expect(new Set(descendants(result.compiled, node.id))).toEqual(reach);
			}
		}
	});

	test("adding one back edge is always reported as a cycle naming the nodes on it", () => {
		for (let seed = 1; seed <= 30; seed++) {
			const plan = randomPlan(seed, 4 + (seed % 6));
			const [from, to] = plan.edges[0]!;
			const result = compilePlan({ ...plan, edges: [...plan.edges, [to, from]] });
			expect(result.ok).toBe(false);
			if (result.ok) continue;
			expect(result.diagnostics.every((d) => d.check === "acyclic")).toBe(true);
			expect(result.diagnostics[0]!.nodes).toEqual(expect.arrayContaining([from, to]));
		}
	});

	test("removing the providing post breaks closure for exactly the dependent node", () => {
		for (let seed = 1; seed <= 40; seed++) {
			const plan = randomPlan(seed, 6);
			const dependent = plan.nodes.find((n) => n.pre?.length);
			if (!dependent) continue;
			const provider = plan.nodes.find((n) => n.post?.some((p) => p.kind === "file" && p.path === (dependent.pre![0] as { path: string }).path))!;
			const broken = { ...plan, nodes: plan.nodes.map((n) => n.id === provider.id ? { ...n, post: [] } : n) };
			const result = compilePlan(broken);
			expect(result.ok).toBe(false);
			if (result.ok) continue;
			const closure = result.diagnostics.filter((d) => d.check === "closure");
			expect(closure.length).toBeGreaterThan(0);
			expect(closure.every((d) => d.nodes[0] !== undefined && broken.nodes.find((n) => n.id === d.nodes[0])!.pre![0]!.kind === "file")).toBe(true);
			expect(closure.some((d) => d.nodes[0] === dependent.id)).toBe(true);
		}
	});

	test("ready nodes are exactly the frontier and the frontier drains the whole order", () => {
		for (let seed = 1; seed <= 30; seed++) {
			const result = compilePlan(randomPlan(seed, 7));
			if (!result.ok) throw new Error("expected ok");
			const done = new Set<string>();
			let steps = 0;
			while (done.size < result.compiled.order.length) {
				const ready = readyNodes(result.compiled, done);
				expect(ready.length).toBeGreaterThan(0);
				for (const id of ready) {
					expect(result.compiled.parents[id]!.every((p) => done.has(p))).toBe(true);
					done.add(id);
				}
				if (++steps > result.compiled.order.length) throw new Error("frontier did not progress");
			}
			expect(readyNodes(result.compiled, done)).toEqual([]);
		}
	});
});

describe("compilePlan checks", () => {
	const verify = (reads: string[], covers = ["R"]): PlanNode => ({ id: "v", kind: "verify", reads, covers });

	test("race: unordered writers of overlapping scopes are diagnosed; an edge resolves it", () => {
		const plan: Plan = {
			nodes: [
				{ id: "a", kind: "act", writes: ["src/x/"] },
				{ id: "b", kind: "act", writes: ["src/x/y.ts"] },
				verify(["src/"]),
			],
			edges: [["a", "v"], ["b", "v"]],
			goal: { requirements: ["R"] },
		};
		const raced = compilePlan(plan);
		expect(raced.ok).toBe(false);
		if (!raced.ok) expect(raced.diagnostics).toEqual([{ check: "race", message: expect.stringContaining("overlapping"), nodes: ["a", "b"] }]);
		expect(compilePlan({ ...plan, edges: [...plan.edges, ["a", "b"]] }).ok).toBe(true);
	});

	test("read/write across unordered nodes is a race; read/read is not", () => {
		const base = (bKind: "reads" | "writes"): Plan => ({
			nodes: [{ id: "a", kind: "act", reads: ["cfg"] }, { id: "b", kind: "act", [bKind]: ["cfg"] }, verify(["cfg"])],
			edges: [["a", "v"], ["b", "v"]],
			goal: { requirements: ["R"] },
		});
		expect(compilePlan(base("writes")).ok).toBe(false);
		expect(compilePlan(base("reads")).ok).toBe(true);
	});

	test("coverage: a requirement without a verify node fails; unknown covers fail at shape", () => {
		const plan: Plan = { nodes: [{ id: "a", kind: "act" }], edges: [], goal: { requirements: ["R"] } };
		const result = compilePlan(plan);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.diagnostics.map((d) => d.check)).toEqual(["coverage"]);
		const unknown = compilePlan({ ...plan, nodes: [{ id: "v", kind: "verify", covers: ["Z"] }] });
		expect(unknown.ok).toBe(false);
		if (!unknown.ok) expect(unknown.diagnostics[0]!.check).toBe("shape");
	});

	test("verify dominance: a write after the last verify of its scope is rejected", () => {
		const plan: Plan = {
			nodes: [
				{ id: "w1", kind: "act", writes: ["lib"] },
				verify(["lib"]),
				{ id: "w2", kind: "act", writes: ["lib"] },
			],
			edges: [["w1", "v"], ["v", "w2"]],
			goal: { requirements: ["R"] },
		};
		const result = compilePlan(plan);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.diagnostics).toEqual([{ check: "verify-dominance", message: expect.stringContaining("w2"), nodes: ["w2"] }]);
	});

	test("authority: an irreversible node needs an ask ancestor", () => {
		const nodes: PlanNode[] = [
			{ id: "q", kind: "ask", post: [{ kind: "fact", id: "ok" }] },
			{ id: "drop", kind: "act", irreversible: true, pre: [{ kind: "fact", id: "ok" }], writes: ["db"] },
			verify(["db"]),
		];
		expect(compilePlan({ nodes, edges: [["q", "drop"], ["drop", "v"]], goal: { requirements: ["R"] } }).ok).toBe(true);
		const noAsk = compilePlan({ nodes: nodes.slice(1), edges: [["drop", "v"]], goal: { requirements: ["R"] }, init: [{ kind: "fact", id: "ok" }] });
		expect(noAsk.ok).toBe(false);
		if (!noAsk.ok) expect(noAsk.diagnostics.map((d) => d.check)).toEqual(["authority"]);
	});

	test("closure accepts Init and implicit node() facts, and hashed files demand the exact hash", () => {
		expect(satisfies({ kind: "file", path: "a" }, { kind: "file", path: "a", hash: "1" })).toBe(true);
		expect(satisfies({ kind: "file", path: "a", hash: "2" }, { kind: "file", path: "a", hash: "1" })).toBe(false);
		const plan: Plan = {
			nodes: [
				{ id: "a", kind: "act", pre: [{ kind: "fact", id: "f" }], writes: ["x"] },
				{ id: "b", kind: "act", pre: [{ kind: "node", id: "a" }] },
				verify(["x"]),
			],
			edges: [["a", "b"], ["b", "v"], ["a", "v"]],
			goal: { requirements: ["R"] },
			init: [{ kind: "fact", id: "f" }],
		};
		expect(compilePlan(plan).ok).toBe(true);
		const missing = compilePlan({ ...plan, init: [] });
		expect(missing.ok).toBe(false);
		if (!missing.ok) expect(missing.diagnostics).toEqual([{ check: "closure", message: expect.stringContaining("fact:f"), nodes: ["a"] }]);
	});

	test("critical path is the longest weighted chain", () => {
		const result = compilePlan({
			nodes: [
				{ id: "a", kind: "act", cost: 1 }, { id: "b", kind: "act", cost: 5 }, { id: "c", kind: "act", cost: 1 },
				{ id: "v", kind: "verify", covers: ["R"], cost: 1 },
			],
			edges: [["a", "v"], ["b", "c"], ["c", "v"]],
			goal: { requirements: ["R"] },
		});
		if (!result.ok) throw new Error("expected ok");
		expect(result.compiled.criticalPath).toEqual(["b", "c", "v"]);
		expect(result.compiled.criticalCost).toBe(7);
		expect(result.compiled.totalCost).toBe(8);
	});

	test("scope overlap is containment, not prefix of names", () => {
		expect(scopesOverlap("src/a", "src/ab")).toBe(false);
		expect(scopesOverlap("src/a/", "src/a/b.ts")).toBe(true);
		expect(scopesOverlap("./src", "src/")).toBe(true);
		expect(scopesOverlap(".", "anything")).toBe(true);
	});

	test("node keys change for the node and its descendants only when an input fact changes", () => {
		const a: PlanNode = { id: "a", kind: "act" };
		const b: PlanNode = { id: "b", kind: "act" };
		const c: PlanNode = { id: "c", kind: "act" };
		const run = (fact: string) => {
			const ka = nodeKey(a, [], [fact]);
			const kb = nodeKey(b, [ka]);
			const kc = nodeKey(c, []);
			return { ka, kb, kc };
		};
		const first = run("f@1");
		const second = run("f@2");
		expect(first.ka).not.toBe(second.ka);
		expect(first.kb).not.toBe(second.kb);
		expect(first.kc).toBe(second.kc);
		expect(nodeKey(a, [], ["x", "y"])).toBe(nodeKey(a, [], ["y", "x"]));
	});
});
