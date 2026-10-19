import { describe, expect, test } from "bun:test";
import {
	askNodeKeys, createRun, fail, frontier, readFact, replan, resolveAskNode, reviseFact, type RunState, start, succeed, summarize,
} from "../src/core/dag.ts";
import { clipBytes, dagPrompt } from "../src/core/dag-verification.ts";
import { dagView } from "../src/core/dag-view.ts";
import { compilePlan, type Plan, type PlanNode, scopesOverlap } from "../src/core/plan.ts";
import { clampCellWait } from "../src/extensions/codemode.ts";
import { collectionLine } from "../src/extensions/subagents.ts";
import { askNodeRecord } from "../src/extensions/dag.ts";
import type { AskRecord } from "../src/core/ask.ts";
import type { ConversationId } from "@earendil-works/pi-durable";

/**
 * ADR 0060. Certification is disjunctive (any succeeded verify covering r certifies r) and `verified` stops dispatch,
 * so the compiler must make every effect necessary for certification. Invariant I_eff: verified ⇒ every effect node
 * succeeded and every scope it wrote was read by a succeeded verify node after it.
 */
const verdict = (reqs: readonly string[], value: "pass" | "fail") =>
	JSON.stringify({ version: 1, requirements: reqs.map((id) => ({ id, verdict: value, evidence: `observed ${value}` })), summary: value, repairable: false });
const checks = (plan: Plan) => { const c = compilePlan(plan); return c.ok ? [] : c.diagnostics.map((d) => d.check); };

/** A deployment-shaped plan: review the source, ask for authority, deploy, check the live result. */
const deployment = (): Plan => ({
	nodes: [
		{ id: "implement", kind: "act", writes: ["src"] },
		{ id: "review", kind: "verify", reads: ["src"], covers: ["source-reviewed"] },
		{ id: "approve", kind: "ask" },
		{ id: "deploy", kind: "act", irreversible: true, writes: ["prod"], post: [{ kind: "req", id: "deployed" }] },
		{ id: "live", kind: "verify", reads: ["prod"], covers: ["deployed"] },
	],
	edges: [["implement", "review"], ["review", "approve"], ["approve", "deploy"], ["deploy", "live"]],
	goal: { requirements: ["source-reviewed", "deployed"] },
});

describe("compiler: certification must depend on every effect", () => {
	test("a reviewed deployment with a post-deploy check compiles", () => {
		expect(checks(deployment())).toEqual([]);
	});

	test("a pre-deploy review that also covers the deployment requirement is rejected (deploy could be skipped)", () => {
		const p = deployment();
		p.nodes[1]!.covers = ["deployed"];
		p.goal.requirements = ["deployed"];
		delete p.nodes[3]!.post;
		expect(checks(p)).toEqual(["certifying-dominance", "certifying-dominance"]);
		const c = compilePlan(p);
		expect(c.ok ? "" : c.diagnostics[0]!.message).toContain('irreversible node "deploy" can be skipped');
	});

	test("a verifier of a declared requirement must run after the node that establishes it", () => {
		const p = deployment();
		p.nodes[1]!.covers = ["deployed"];
		p.nodes[4]!.covers = ["healthy"];
		p.goal.requirements = ["deployed", "healthy"];
		expect(checks(p)).toEqual(["producer-order"]);
		// Without the declaration the compiler cannot know the requirement needs the deployment.
		delete p.nodes[3]!.post;
		expect(checks(p)).toEqual([]);
	});

	test("an irreversible node needs a verify node that reads every upstream write before it", () => {
		const p: Plan = {
			nodes: [
				{ id: "implement", kind: "act", writes: ["src"] }, { id: "tests", kind: "delegate", reads: ["src"] },
				{ id: "approve", kind: "ask" }, { id: "deploy", kind: "act", irreversible: true, writes: ["prod"] },
				{ id: "live", kind: "verify", reads: ["src", "prod"], covers: ["deployed"] },
			],
			edges: [["implement", "tests"], ["tests", "approve"], ["approve", "deploy"], ["deploy", "live"]],
			goal: { requirements: ["deployed"] },
		};
		expect(checks(p)).toEqual(["pre-effect-verification"]);
	});

	test("an irreversible verify node that certifies its own requirement compiles", () => {
		const p: Plan = {
			nodes: [{ id: "q", kind: "ask" }, { id: "send", kind: "verify", irreversible: true, covers: ["R"] }],
			edges: [["q", "send"]], goal: { requirements: ["R"] },
		};
		expect(checks(p)).toEqual([]);
	});

	test("a write without any downstream reader reports verify dominance only once", () => {
		const p: Plan = { nodes: [{ id: "a", kind: "act", writes: ["x"] }, { id: "v", kind: "verify", covers: ["R"] }], edges: [["a", "v"]], goal: { requirements: ["R"] } };
		expect(checks(p)).toEqual(["verify-dominance"]);
	});

	test("each defect is reported once: no pre-effect duplicate of verify dominance, no duplicate producer declarations", () => {
		const unread: Plan = {
			nodes: [{ id: "w", kind: "act", writes: ["x"] }, { id: "q", kind: "ask" }, { id: "d", kind: "act", irreversible: true, writes: ["p"] }, { id: "v", kind: "verify", reads: ["p"], covers: ["R"] }],
			edges: [["w", "q"], ["q", "d"], ["d", "v"]], goal: { requirements: ["R"] },
		};
		expect(checks(unread)).toEqual(["verify-dominance"]);
		const twice = deployment();
		twice.nodes[1]!.covers = ["deployed"];
		twice.nodes[4]!.covers = ["healthy"];
		twice.goal.requirements = ["deployed", "healthy"];
		twice.nodes[3]!.post = [{ kind: "req", id: "deployed" }, { kind: "req", id: "deployed" }];
		expect(checks(twice)).toEqual(["producer-order"]);
	});

	test("a parallel alternative verifier of the same requirement cannot certify past an unfinished write", () => {
		const p: Plan = {
			nodes: [{ id: "a", kind: "act", writes: ["x"] }, { id: "shortcut", kind: "verify", covers: ["R"] }, { id: "v", kind: "verify", reads: ["x"], covers: ["R"] }],
			edges: [["a", "v"]], goal: { requirements: ["R"] },
		};
		expect(checks(p)).toEqual(["certifying-dominance"]);
	});
});

/** Deterministic bounded exploration of every accepted random plan: eager dispatch, any completion order, pass/fail. */
describe("property: accepted plans never verify past an unfinished or unchecked effect", () => {
	function lcg(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
	function randomPlan(random: () => number): Plan {
		const n = 3 + Math.floor(random() * 3);
		const kinds = Array.from({ length: n }, () => ["act", "act", "verify", "verify", "verify", "ask", "deploy"][Math.floor(random() * 7)]!);
		const scopes = kinds.map((k, i) => (k === "act" || k === "deploy" ? `s${i}` : null)).filter((s): s is string => s !== null);
		const nodes: PlanNode[] = kinds.map((k, i): PlanNode => k === "act" ? { id: `n${i}`, kind: "act", writes: [`s${i}`] }
			: k === "deploy" ? { id: `n${i}`, kind: "act", irreversible: true, writes: [`s${i}`] }
			: k === "ask" ? { id: `n${i}`, kind: "ask" }
			: { id: `n${i}`, kind: "verify", reads: scopes.filter(() => random() < 0.6), covers: [["R0"], ["R1"], ["R0", "R1"]][Math.floor(random() * 3)]! });
		const edges: [string, string][] = [];
		for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (random() < 0.5) edges.push([`n${i}`, `n${j}`]);
		return { nodes, edges, goal: { requirements: ["R0", "R1"].filter((r) => nodes.some((x) => x.covers?.includes(r))) } };
	}
	function effectSound(run: RunState): boolean {
		const ancestors = run.compiled!.ancestors;
		return run.plan.nodes.every((e) => {
			if (!e.writes?.length && !e.irreversible) return true;
			if (run.nodes[e.id]!.status !== "succeeded") return false;
			return (e.writes ?? []).every((s) => run.plan.nodes.some((v) => v.kind === "verify" && ancestors[v.id]!.includes(e.id)
				&& (v.reads ?? []).some((r) => scopesOverlap(r, s)) && run.nodes[v.id]!.status === "succeeded"));
		});
	}
	test("I_eff and truthful blocked reasons over 3000 random plans", () => {
		const random = lcg(60);
		let accepted = 0, verifiedStates = 0, blockedStates = 0, handle = 0;
		for (let i = 0; i < 3000; i++) {
			const plan = randomPlan(random);
			if (!plan.goal.requirements.length || !compilePlan(plan).ok) continue;
			accepted++;
			const dispatch = (r: RunState) => { for (const id of frontier(r)) start(r, id, `sa-${++handle}`, handle, String(handle)); };
			const first = createRun("p", plan, 0);
			dispatch(first);
			const seen = new Set<string>();
			const stack = [first];
			while (stack.length) {
				const run = stack.pop()!;
				const key = JSON.stringify([run.status, Object.values(run.nodes).map((s) => [s.status, s.attempt])]);
				if (seen.has(key)) continue;
				seen.add(key);
				if (run.status === "verified") { verifiedStates++; expect(effectSound(run)).toBe(true); continue; }
				if (run.status === "blocked") {
					blockedStates++;
					expect(run.reason).not.toContain("after 3 attempts");
					for (const m of (run.reason ?? "").matchAll(/(\w+) \(attempt (\d+): /g)) expect(run.nodes[m[1]!]!.attempt).toBe(Number(m[2]));
					continue;
				}
				for (const [id, s] of Object.entries(run.nodes)) {
					if (s.status !== "running" && s.status !== "waiting") continue;
					const node = plan.nodes.find((x) => x.id === id)!;
					for (const outcome of node.kind === "verify" ? ["pass", "fail"] as const : node.kind === "ask" ? ["grant", "deny"] as const : ["ok"] as const) {
						const next = structuredClone(run);
						if (outcome === "grant" || outcome === "deny") resolveAskNode(next, id, { granted: outcome === "grant", result: outcome }, ++handle);
						else succeed(next, id, outcome === "ok" ? "done" : verdict(node.covers!, outcome), ++handle);
						if (next.status === "running") dispatch(next);
						stack.push(next);
					}
				}
			}
		}
		// Non-vacuous: the sample exercises both terminal outcomes.
		expect(accepted).toBeGreaterThan(200);
		expect(verifiedStates).toBeGreaterThan(200);
		expect(blockedStates).toBeGreaterThan(200);
	});
});

describe("state machine", () => {
	test("a parent key that returns to an earlier value cannot let a child certify past its pending parent", () => {
		const plan: Plan = {
			nodes: [{ id: "g", kind: "act", writes: ["s"] }, { id: "a", kind: "verify", reads: ["s"], covers: ["R1"] }, { id: "b", kind: "verify", reads: ["s"], covers: ["R1", "R2"] }],
			edges: [["g", "a"], ["a", "b"]], goal: { requirements: ["R1", "R2"] },
		};
		const r = createRun("aba", plan, 0);
		start(r, "g", "sa-1", 1, "1"); readFact(r, "g", "f", "v1"); succeed(r, "g", "ok", 2);
		start(r, "a", "sa-2", 3, "2"); succeed(r, "a", verdict(["R1"], "pass"), 4);
		start(r, "b", "sa-3", 5, "3");
		reviseFact(r, "f", "v2", 6);
		start(r, "g", "sa-4", 7, "4");
		reviseFact(r, "f", "v1", 8);
		succeed(r, "b", verdict(["R1", "R2"], "pass"), 9);
		expect(r.status).toBe("running");
		expect(r.certified).toEqual([]);
		// The stale verdict judged nothing current: the verifier is retried and the artifact stays unrejected.
		expect(r.nodes.b!.status).toBe("pending");
		expect(r.rejectedArtifacts ?? []).toEqual([]);
	});

	test("blocked reasons state the real attempt and cause", () => {
		const plan: Plan = { nodes: [{ id: "a", kind: "act", writes: ["x"] }, { id: "v", kind: "verify", reads: ["x"], covers: ["R"] }], edges: [["a", "v"]], goal: { requirements: ["R"] } };
		const rejected = createRun("r", plan, 0);
		start(rejected, "a", "sa-1", 1, "1"); succeed(rejected, "a", "ok", 2);
		start(rejected, "v", "sa-2", 3, "2"); succeed(rejected, "v", verdict(["R"], "fail"), 4);
		expect(rejected.reason).toContain("v (attempt 1: verifier rejected the artifact");
		expect(rejected.reason).toEndWith("; replan or cancel");
		expect(summarize(rejected)).toContain("v <verify> failed #1");
		expect(dagView(rejected).nodes.find((n) => n.id === "v")).toMatchObject({ attempt: 1, maxAttempts: 1 });

		const malformed = createRun("m", plan, 0);
		start(malformed, "a", "sa-1", 1, "1"); succeed(malformed, "a", "ok", 2);
		for (const [t, answer] of [[3, "prose"], [5, "prose"], [7, verdict(["R"], "fail")]] as const) { start(malformed, "v", `sa-${t}`, t, String(t)); succeed(malformed, "v", answer, t + 1); }
		expect(malformed.reason).toContain("v (attempt 3: verifier rejected the artifact");

		const exhausted = createRun("e", plan, 0);
		for (let t = 1; t < 7; t += 2) { start(exhausted, "a", `sa-${t}`, t, String(t)); fail(exhausted, "a", "boom", t + 1); }
		expect(exhausted.reason).toContain("a (attempt 3: retry budget exhausted (3))");
		expect(dagView(exhausted).nodes.find((n) => n.id === "a")).toMatchObject({ attempt: 3, maxAttempts: 3 });
	});

	test("an ask node succeeds on a grant, fails without retry on a refusal, and a replan re-opens a narrower approval", () => {
		const r = createRun("ask", deployment(), 0);
		start(r, "implement", "sa-1", 1, "1"); succeed(r, "implement", "ok", 2);
		start(r, "review", "sa-2", 3, "2"); succeed(r, "review", verdict(["source-reviewed"], "pass"), 4);
		start(r, "approve", "orchestrator", 5);
		r.nodes.approve!.ask = { id: "ask-1", refs: ["deploy"] };
		resolveAskNode(r, "approve", { granted: true, result: "authority granted by human:alice for deploy: approve" }, 6);
		expect(r.nodes.approve!.status).toBe("succeeded");
		expect(frontier(r)).toEqual(["deploy"]);

		// Adding a second irreversible node under the same ask invalidates the approval: the human approved only deploy.
		const wider = deployment();
		wider.nodes.push({ id: "notify", kind: "act", irreversible: true }, { id: "notified", kind: "verify", covers: ["notified"] });
		wider.edges.push(["approve", "notify"], ["notify", "notified"]);
		wider.goal.requirements.push("notified");
		expect(replan(r, wider, 7).ok).toBe(true);
		expect(r.nodes.approve!.status).toBe("pending");
		expect(frontier(r)).toEqual(["approve"]);

		const denied = createRun("deny", deployment(), 0);
		start(denied, "implement", "sa-1", 1, "1"); succeed(denied, "implement", "ok", 2);
		start(denied, "review", "sa-2", 3, "2"); succeed(denied, "review", verdict(["source-reviewed"], "pass"), 4);
		start(denied, "approve", "orchestrator", 5);
		resolveAskNode(denied, "approve", { granted: false, result: "authority not granted (answered by human:alice: deny)" }, 6);
		expect(denied.nodes.approve!.status).toBe("failed");
		expect(denied.status).toBe("blocked");
		expect(denied.reason).toContain("approve (attempt 1: authority not granted");
		expect(denied.nodes.deploy!.runs).toBe(0);
	});
});

describe("ask node lifecycle", () => {
	const chain = (): Plan => ({
		nodes: [
			{ id: "w", kind: "act", writes: ["s"] }, { id: "v", kind: "verify", reads: ["s"], covers: ["R1"] },
			{ id: "q", kind: "ask" }, { id: "d", kind: "act", irreversible: true, writes: ["p"] }, { id: "live", kind: "verify", reads: ["p"], covers: ["R2"] },
		],
		edges: [["w", "v"], ["v", "q"], ["q", "d"], ["d", "live"]], goal: { requirements: ["R1", "R2"] },
	});
	test("a granted ask whose ancestor went stale while it waited is re-dispatched, not failed", () => {
		const r = createRun("stale", chain(), 0);
		start(r, "w", "sa-1", 1, "1"); readFact(r, "w", "f", "vanilla"); succeed(r, "w", "ok", 2);
		start(r, "v", "sa-2", 3, "2"); succeed(r, "v", verdict(["R1"], "pass"), 4);
		start(r, "q", "orchestrator", 5);
		r.nodes.q!.ask = { id: "a1", refs: ["d"], keys: askNodeKeys(r, ["d"]) };
		reviseFact(r, "f", "mint", 6);
		resolveAskNode(r, "q", { granted: true, result: "authority granted by human:alice for d: approve" }, 7);
		expect(r.nodes.q!.status).toBe("pending");
		expect(r.status).toBe("running");
		start(r, "w", "sa-3", 8, "3"); readFact(r, "w", "f", "mint"); succeed(r, "w", "ok", 9);
		start(r, "v", "sa-4", 10, "4"); succeed(r, "v", verdict(["R1"], "pass"), 11);
		start(r, "q", "orchestrator", 12);
		resolveAskNode(r, "q", { granted: true, result: "authority granted by human:alice for d: approve" }, 13);
		expect(frontier(r)).toEqual(["d"]);
	});

	test("an approval binds to contracts: changing an authorized node re-opens the ask and everything below it", () => {
		const r = createRun("contract", deployment(), 0);
		start(r, "implement", "sa-1", 1, "1"); succeed(r, "implement", "ok", 2);
		start(r, "review", "sa-2", 3, "2"); succeed(r, "review", verdict(["source-reviewed"], "pass"), 4);
		start(r, "approve", "orchestrator", 5);
		r.nodes.approve!.ask = { id: "a1", refs: ["deploy"], keys: askNodeKeys(r, ["deploy"]) };
		resolveAskNode(r, "approve", { granted: true, result: "granted" }, 6);
		const same = deployment();
		expect(replan(r, same, 7).ok).toBe(true);
		expect(r.nodes.approve!.status).toBe("succeeded");
		const changed = deployment();
		changed.nodes[3]!.description = "drop the production database";
		expect(replan(r, changed, 8).ok).toBe(true);
		expect(r.nodes.approve!.status).toBe("pending");
		expect(frontier(r)).toEqual(["approve"]);
	});

	test("re-opening an ask also resets its succeeded descendants in a legacy run without generations", () => {
		const plan: Plan = {
			nodes: [{ id: "q", kind: "ask" }, { id: "x", kind: "delegate" }, { id: "d", kind: "act", irreversible: true }, { id: "vd", kind: "verify", covers: ["D"] }],
			edges: [["q", "x"], ["x", "d"], ["d", "vd"]], goal: { requirements: ["D"] },
		};
		const r = createRun("legacy", plan, 0);
		delete r.semantics;
		start(r, "q", "orchestrator", 1);
		r.nodes.q!.ask = { id: "a1", refs: ["d"], keys: askNodeKeys(r, ["d"]) };
		resolveAskNode(r, "q", { granted: true, result: "granted" }, 2);
		start(r, "x", "sa-1", 3, "1"); succeed(r, "x", "ok", 4);
		const wider: Plan = structuredClone(plan);
		wider.nodes.push({ id: "n", kind: "act", irreversible: true }, { id: "vn", kind: "verify", covers: ["N"] });
		wider.edges.push(["x", "n"], ["n", "vn"]);
		wider.goal.requirements.push("N");
		expect(replan(r, wider, 5).ok).toBe(true);
		expect(r.nodes.q!.status).toBe("pending");
		expect(r.nodes.x!.status).toBe("pending");
		expect(frontier(r)).toEqual(["q"]);
	});
});

describe("ask record reuse is bound to the upstream state the human saw", () => {
	const main = 1 as ConversationId;
	const plan = (): Plan => ({
		nodes: [{ id: "w", kind: "act", writes: ["s"] }, { id: "v", kind: "verify", reads: ["s"], covers: ["R1"] }, { id: "q", kind: "ask" }, { id: "d", kind: "act", irreversible: true, writes: ["p"] }, { id: "live", kind: "verify", reads: ["p"], covers: ["R2"] }],
		edges: [["w", "v"], ["v", "q"], ["q", "d"], ["d", "live"]], goal: { requirements: ["R1", "R2"] },
	});
	const ready = () => {
		const r = createRun("reuse", plan(), 0);
		start(r, "w", "sa-1", 10, "1"); succeed(r, "w", "artifact 1", 20);
		start(r, "v", "sa-2", 30, "2"); succeed(r, "v", verdict(["R1"], "pass"), 40);
		return r;
	};
	const approve = (a: AskRecord, at: number) => Object.assign(a, { state: "answered", answer: "approve", resolvedBy: "human:alice", resolvedAt: at });
	test("a node's own approval is reused only under the same key", () => {
		const asks = { asks: [] as AskRecord[] };
		const r = ready();
		start(r, "q", "orchestrator", 50);
		const first = askNodeRecord(asks, r, "q", main, 50);
		approve(asks.asks[0]!, 60);
		expect(askNodeRecord(asks, r, "q", main, 70).id).toBe(first.id);
		// The upstream artifact changes: the same node asks again.
		r.nodes.w!.result = "artifact 2";
		r.nodes.q!.key = "changed-upstream";
		expect(askNodeRecord(asks, r, "q", main, 80).id).not.toBe(first.id);
	});
	test("an orchestrator approval requires explicit current node proof, not an ancestor timestamp guess", () => {
		const r = ready();
		start(r, "q", "orchestrator", 50);
		const keys = askNodeKeys(r, ["d"]);
		const early: AskRecord = { id: "early", from: { conversationId: main }, to: "human", kind: "authority", refs: ["d"], keys, question: "drop?", default: "deny", createdAt: 35, deadlineAt: 1e12, state: "open", run: r.id };
		const late: AskRecord = { ...early, id: "late", createdAt: 45 };
		approve(early, 36);
		expect(askNodeRecord({ asks: [early] }, r, "q", main, 50).id).not.toBe("early");
		approve(late, 46);
		expect(askNodeRecord({ asks: [late] }, r, "q", main, 50).id).not.toBe("late");
        const bound:AskRecord={...late,node:"q",nodeKey:r.nodes.q!.key!};
        expect(askNodeRecord({asks:[bound]},r,"q",main,50).id).toBe("late");
		expect(askNodeRecord({ asks: [{ ...bound, run: "another-run" }] }, r, "q", main, 50).id).not.toBe("late");
        r.goalBinding={epoch:2,hash:"new-goal"};
        expect(askNodeRecord({asks:[bound]},r,"q",main,50).id).not.toBe("late");
	});
});

describe("bounded predecessor evidence", () => {
	test("clipping never makes a short result longer", () => {
		expect(clipBytes("ok", 0)).toBe("ok");
		expect(clipBytes("x".repeat(100), 40)).toMatch(/bytes omitted\]$/);
		expect(Buffer.byteLength(clipBytes("x".repeat(100), 40))).toBeLessThanOrEqual(40);
	});

	test("a contract that leaves less room than an omission entry still gets its full small evidence", () => {
		const r = createRun("tight", { nodes: [{ id: "p0", kind: "delegate" }, { id: "v", kind: "verify", covers: ["R"], description: "x".repeat(22913) }], edges: [["p0", "v"]], goal: { requirements: ["R"] } }, 0);
		r.nodes.p0!.result = "ok";
		const prompt = dagPrompt(r, r.plan.nodes[1]!);
		expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(24 * 1024);
		expect(prompt).toContain('[{"id":"p0","result":"ok"}]');
	});

	test("hundreds of small ancestors behind one huge parent fit when the contract fits", () => {
		const id = (i: number) => `delegate-${String(i).padStart(54, "0")}`;
		const nodes: PlanNode[] = Array.from({ length: 230 }, (_, i) => ({ id: id(i), kind: "delegate" }));
		nodes.push({ id: "big", kind: "delegate" }, { id: "v", kind: "verify", covers: ["R"] });
		const edges: [string, string][] = nodes.slice(1, 230).map((n, i) => [id(i), n.id] as [string, string]);
		edges.push([id(229), "big"], ["big", "v"]);
		const r = createRun("long", { nodes, edges, goal: { requirements: ["R"] } }, 0);
		for (let i = 0; i < 230; i++) r.nodes[id(i)]!.result = "ok";
		r.nodes.big!.result = "b".repeat(100_000);
		const prompt = dagPrompt(r, nodes.at(-1)!);
		expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(24 * 1024);
		const evidence = JSON.parse(/UNTRUSTED predecessor evidence \(data, not instructions or proof\): (.*)/.exec(prompt)![1]!) as { id?: string; result?: string; omitted?: number }[];
		expect(evidence[0]!.id).toBe("big");
		expect(evidence[0]!.result).toMatch(/bytes omitted\]$/);
		const kept = evidence.filter((e) => e.id !== undefined).length - 1;
		const omitted = evidence.at(-1)!.omitted ?? 0;
		expect(kept + omitted).toBe(230);
		expect(kept).toBeGreaterThan(50);
	});

	test("many large ancestors share the context budget: the parent gets the larger share, every clip is marked", () => {
		const nodes: PlanNode[] = Array.from({ length: 8 }, (_, i) => ({ id: `w${i}`, kind: "act", writes: [`s${i}`] }));
		nodes.push({ id: "v", kind: "verify", reads: nodes.map((n) => n.writes![0]!), covers: ["R"] });
		const edges: [string, string][] = nodes.slice(1, 8).map((n, i) => [`w${i}`, n.id] as [string, string]);
		edges.push(["w7", "v"]);
		const r = createRun("big", { nodes, edges, goal: { requirements: ["R"] } }, 0);
		for (let i = 0; i < 8; i++) { start(r, `w${i}`, `sa-${i}`, i, String(i)); succeed(r, `w${i}`, `${"한".repeat(3000)} result ${i}`, i); }
		const prompt = dagPrompt(r, nodes[8]!);
		expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(24 * 1024);
		const evidence = JSON.parse(/UNTRUSTED predecessor evidence \(data, not instructions or proof\): (.*)/.exec(prompt)![1]!) as { id: string; result: string }[];
		expect(evidence.map((e) => e.id)).toEqual(["w7", "w6", "w5", "w4", "w3", "w2", "w1", "w0"]);
		for (const e of evidence) expect(e.result).toMatch(/bytes omitted\]$/);
		const share = (e: { result: string }) => Buffer.byteLength(e.result);
		for (const e of evidence.slice(1)) expect(share(evidence[0]!)).toBeGreaterThan(share(e));
	});
});

describe("collection lines", () => {
	const base = { taskId: "sa-1", description: "d", subagentType: "general-purpose", background: true, conversationId: 1, startedAt: 0, toolCount: 3 };
	test("a failed child shows its error together with the answer it produced", () => {
		expect(collectionLine({ subagent: { ...base, status: "failed", error: "Coding work has no current verification certificate." }, answer: "Work implementing: unmet behavior" }, false))
			.toBe("sa-1 [failed]: Coding work has no current verification certificate.\nWork implementing: unmet behavior");
		expect(collectionLine({ subagent: { ...base, status: "failed", error: "model exploded" }, answer: "" }, false)).toBe("sa-1 [failed]: model exploded");
		expect(collectionLine({ subagent: { ...base, status: "cancelled" }, answer: "" }, false)).toBe("sa-1 [cancelled]: cancelled");
	});
	test("a collected answer is summarized unless repeated; a running child reports progress", () => {
		expect(collectionLine({ subagent: { ...base, status: "completed" }, answer: "done", delivered: true }, false)).toBe("sa-1 [completed]: already collected (4 chars); pass include_delivered:true to repeat it");
		expect(collectionLine({ subagent: { ...base, status: "completed" }, answer: "done", delivered: true }, true)).toBe("sa-1 [completed]: done");
		expect(collectionLine({ subagent: { ...base, status: "running", tokens: 50, currentTool: "bash", lastText: "testing" } }, false)).toBe("sa-1 [running] 3 tool calls, 50 tokens, now bash: testing");
	});
});

describe("codemode waits", () => {
	test("a blocking task_output wait ends before the cell deadline; other calls are untouched", () => {
		expect(clampCellWait("task_output", {}, 60_000, 0)).toEqual({ timeout_ms: 57_000 });
		expect(clampCellWait("task_output", { timeout_ms: 5_000 }, 60_000, 0)).toEqual({ timeout_ms: 5_000 });
		expect(clampCellWait("task_output", { timeout_ms: 90_000, task_ids: ["sa-1"] }, 60_000, 50_000)).toEqual({ timeout_ms: 7_000, task_ids: ["sa-1"] });
		expect(clampCellWait("task_output", { block: false }, 60_000, 59_000)).toEqual({ block: false });
		expect(clampCellWait("task_output", {}, 60_000, 59_500)).toEqual({ timeout_ms: 0 });
		expect(clampCellWait("bash", { command: "sleep 100" }, 60_000, 0)).toEqual({ command: "sleep 100" });
		// Values the schema coerces are read the same way, so a short string timeout is never widened.
		expect(clampCellWait("task_output", { timeout_ms: "5000" }, 60_000, 0)).toEqual({ timeout_ms: "5000" });
		expect(clampCellWait("task_output", { timeout_ms: "90000" }, 60_000, 0)).toEqual({ timeout_ms: 57_000 });
		expect(clampCellWait("task_output", { block: "false" }, 60_000, 59_000)).toEqual({ block: "false" });
	});
});
