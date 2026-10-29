import { readVerdict } from "./dag-verification.ts";
import { createHash } from "node:crypto";
import { defineDoc } from "@earendil-works/pi-durable";
import { type CompiledPlan, compilePlan, type Diagnostic, descendants, MAX_PLAN_NODES, nodeKey, type Plan, type PlanNode, readyNodes, scopeWithin } from "./plan.ts";

/**
 * Durable DAG run state and its pure transition functions (ADR 0030).
 *
 * The run is a labelled transition system on `RunDoc`; transitions validate their preconditions.
 * With fixed facts and a finite plan, bounded retries per node key bound dispatch attempts.
 * Admissible replans decrease the lexicographic potential
 * Φ = (replanBudget, |unmet obligations|), except the single free first compile of a run that was blocked at
 * creation (no nodes, no effects), which is equivalent to creating the run. This is not an unconditional termination proof:
 * external fact revisions can invalidate certificates, reset per-key attempts and reopen runs
 * indefinitely, and running/waiting effects still need executor settlement or cancellation.
 * Research missions impose independent global admission budgets and deadlines in their host
 * controller; ordinary DAG runs do not acquire those bounds merely by using this state machine.
 */

export type NodeStatus = "pending" | "ready" | "running" | "waiting" | "succeeded" | "failed" | "skipped";

export type NodeRun = {
	effect?: import("./managed-effects.ts").ManagedEffect;
	effectRefusal?: string;
	status: NodeStatus;
	generation?: number;
	unknownEffects?: boolean;
	runnerId?: string;
	binding?: { key: string; attempt: number; handle?: string; runnerId?: string; parents: string };
	proof?: { key: string; attempt: number };
	repairFeedback?: string;
	/** Negative judgment retained until every impacted executor settles. */
	pendingRepair?: { key: string; attempt: number; generation: number; result: string };
	/** Why the previous verifier attempt delivered no readable verdict; shown to the next attempt, cleared on success. */
	protocolFeedback?: string;
	/** Why the previous instantiation of this node's spawn template was rejected; shown to the next attempt. */
	spawnFeedback?: string;
	/** Host-accepted receipt, bound to this exact node key and attempt. */
	receipt?: { id: string; key: string; attempt: number };
	/** Content key of the current attempt: contract, parent keys and facts read. */
	key?: string;
	attempt: number;
	/** Facts (ask ids) this attempt read; part of the key. */
	facts: string[];
	/** Total starts across all keys, for audit; `attempt` is per current key. */
	runs: number;
	/** Executor-specific handle, e.g. the subagent task id. */
	handle?: string;
	/**
	 * Ask nodes: the ask record that resolves this attempt and the irreversible descendants it authorizes. A later
	 * replan that adds an irreversible descendant outside `refs` invalidates the approval.
	 */
	ask?: { id: string; refs: string[]; keys?: string[] };
	result?: string;
	error?: string;
	startedAt?: number;
	endedAt?: number;
};

export type RunStatus = "compiling" | "running" | "verified" | "blocked" | "cancelled";

export type RunState = {
    /** Host-captured originating inputs for delivery scope only; never authority. */
    sourceIds?: string[];
    /** Positive host evidence from admitted replans; does not complete legacy lineage. */
    displaySourceIds?: string[];
    goalBinding?: { epoch: number; hash: string; conversationId?: string };
	id: string;
	semantics?: 2;
	/** Run-wide lifetime credit: never reset by replan, rename, or restart. */
	repairsUsed?: number;
	/** Rejected artifacts cannot be reviewer-rerolled through a replan. */
	rejectedArtifacts?: string[];
	repairHistory?: { predecessorId: string; verifier: string; failure: string; nodes: Record<string, NodeRun> }[];
	owner?: { missionId: string };
	revision: number;
	status: RunStatus;
	plan: Plan;
	compiled?: CompiledPlan;
	diagnostics?: Diagnostic[];
	nodes: Record<string, NodeRun>;
	/** Known fact revisions: ask id → answer hash. A node's key binds the revisions it read. */
	facts: Record<string, string>;
	/** Requirement ids certified by a succeeded verify node under the current keys. */
	certified: string[];
	replanBudget: number;
	/** History of Φ = [budget, |unmet|] for auditing the progress proof. */
	potential: [number, number][];
	/** Instances ever spawned in this run; never reset by replan or re-expansion, so spawn credit only decreases. */
	spawned?: number;
	/** History of Φ' = [spawn credit, budget, |unmet|] at each expansion. */
	spawnPotential?: [number, number, number][];
	reason?: string;
	createdAt: number;
	updatedAt: number;
};

export const RunDoc = defineDoc<{ runs: RunState[]; activeId?: string }>({
	kind: "dinobot.dag", version: 1, scope: "conversation", history: "latest", fork: "initial",
	initial: () => ({ runs: [] }),
});

/**
 * The last state of each run the orchestrator's model actually saw in a dag_run/dag_step/dag_status result (ADR 0096).
 * The host's own scheduler (dag-continuation) never writes it. The idle wake announces a stopped run whose current
 * {@link runStateKey} differs from what the model saw, so a run that stopped after the model last looked at it — even
 * while the model was still writing its final answer — is never left unannounced.
 */
export const DagSeenDoc = defineDoc<{ seen: Record<string, string>; /** Asks a dag_step result listed to the model (latest 256). */ asks?: string[] }>({
	kind: "dinobot.dag.seen", version: 1, scope: "conversation", history: "latest", fork: "initial",
	initial: () => ({ seen: {} }),
});

/** Identity of a run's externally meaningful state: a new status, revision (replan) or repair changes it. */
export function runStateKey(run: Pick<RunState, "status" | "revision" | "repairsUsed">): string {
	return `${run.status}:${run.revision}:${run.repairsUsed ?? 0}`;
}

/**
 * Whether a running run can still advance without its orchestrator answering an ask: some node is executing (or waiting
 * for a child's ask, which defaults at its deadline) or ready to dispatch. False when every live node is an ask node
 * waiting for its open record (ADR 0096).
 */
export function runCanProgress(run: RunState): boolean {
	if (run.status !== "running") return false;
	return Object.values(run.nodes).some((state) => (state.status === "running" || state.status === "waiting") && !state.ask) || frontier(run).length > 0;
}

export const DEFAULT_REPLAN_BUDGET = 8;
export const MAX_NODE_ATTEMPTS = 3;

export function factHash(answer: string): string {
	return createHash("sha256").update(answer).digest("hex").slice(0, 16);
}

/** Unmet obligations: requirements not certified by a succeeded verify node. */
export function unmet(run: RunState): string[] {
	return run.plan.goal.requirements.filter((req) => !run.certified.includes(req));
}

export function potential(run: RunState): [number, number] {
	return [run.replanBudget, unmet(run).length];
}

/** a < b in the lexicographic well-order on ℕ². */
export function lessThan(a: readonly [number, number], b: readonly [number, number]): boolean {
	return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
}

/** Instances one run may spawn in its lifetime, across all expansions, re-expansions and replans. */
export const SPAWN_CREDIT = 768;
/** Byte bound of the settlement receipt the orchestrator sees for one expansion, whatever its size. */
export const KAPPA = 512;

/**
 * Φ' = (spawn credit, replan budget, |unmet|) on ℕ³, lexicographic. An expansion lowers the credit by n ≥ 1 and leaves
 * the budget; a replan lowers the budget and leaves the credit (carried instances were already paid for). Both are
 * strict decreases, so a run admits finitely many expansions and replans; with MAX_NODE_ATTEMPTS per key this bounds
 * dispatches for fixed facts, as before.
 */
export function spawnPotential(run: RunState): [number, number, number] {
	return [SPAWN_CREDIT - (run.spawned ?? 0), run.replanBudget, unmet(run).length];
}

function lessThan3(a: readonly number[], b: readonly number[]): boolean {
	for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
	return false;
}

/** Spawned descendants of `id` (its instances and, recursively, theirs). */
export function instancesOf(plan: Plan, id: string): string[] {
	const out: string[] = [];
	const stack = [id];
	while (stack.length) {
		const cur = stack.pop()!;
		for (const n of plan.nodes) if (n.origin === cur) { out.push(n.id); stack.push(n.id); }
	}
	return out;
}

type Instance = { description: string; reads?: string[]; writes?: string[]; expand?: boolean };

/** Parse the planner's answer: exactly one JSON object {"instances":[...]}, optionally in one code fence. */
function readInstances(result: string): Instance[] | string {
	let body = result.trim();
	const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(body);
	if (fence) body = fence[1]!.trim();
	let value: unknown;
	try { value = JSON.parse(body); } catch { return "answer is not one JSON object"; }
	if (!value || typeof value !== "object" || Array.isArray(value)) return "answer is not one JSON object";
	const keys = Object.keys(value);
	if (keys.length !== 1 || keys[0] !== "instances" || !Array.isArray((value as { instances: unknown }).instances)) return "answer must be {\"instances\":[...]} and nothing else";
	const out: Instance[] = [];
	for (const [i, raw] of ((value as { instances: unknown[] }).instances).entries()) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return `instance ${i} is not an object`;
		const o = raw as Record<string, unknown>;
		const extra = Object.keys(o).filter((k) => !["description", "reads", "writes", "expand"].includes(k));
		if (extra.length) return `instance ${i} has unknown field(s) ${extra.join(", ")}`;
		if (typeof o.description !== "string" || !o.description.trim() || o.description.length > 4000) return `instance ${i} needs a nonempty description of at most 4000 characters`;
		const list = (k: "reads" | "writes") => o[k] === undefined || (Array.isArray(o[k]) && (o[k] as unknown[]).every((s) => typeof s === "string" && s.length > 0));
		if (!list("reads") || !list("writes")) return `instance ${i} reads/writes must be arrays of nonempty strings`;
		if (o.expand !== undefined && typeof o.expand !== "boolean") return `instance ${i} expand must be a boolean`;
		out.push({ description: o.description, ...(o.reads ? { reads: o.reads as string[] } : {}), ...(o.writes ? { writes: o.writes as string[] } : {}), ...(o.expand ? { expand: true } : {}) });
	}
	return out;
}

/**
 * The spawn transition of expand node `id` with answer `result` (runtime checks R1–R5). R1 1 ≤ n ≤ max; R2 each
 * instance's scopes lie inside the template envelope; R3 an instance expands again only while depth > 1, with its own
 * narrowed scopes as the envelope; R4 spawn credit and the total node cap; R5 the instantiated plan passes every
 * static check. On success the run's plan holds instances `id/0..n-1` between `id` and its children (any previous
 * expansion of `id` is replaced) and Φ' strictly decreased. Returns the rejection and whether it is deterministic.
 */
function instantiate(run: RunState, id: string, result: string): { error: string; final: boolean } | undefined {
	const node = nodeOf(run, id);
	const spawn = node.spawn!;
	const parsed = readInstances(result);
	if (typeof parsed === "string") return { error: parsed, final: false };
	const n = parsed.length;
	if (n < 1 || n > spawn.max) return { error: `R1: ${n} instance(s); the template allows 1..${spawn.max}`, final: false };
	const t = spawn.template;
	const depth = spawn.depth ?? 1;
	for (const [i, inst] of parsed.entries()) {
		for (const k of ["reads", "writes"] as const) {
			const outside = (inst[k] ?? []).filter((s) => !(t[k] ?? []).some((e) => scopeWithin(s, e)));
			if (outside.length) return { error: `R2: instance ${i} ${k} ${outside.join(", ")} outside the template envelope [${(t[k] ?? []).join(", ")}]`, final: false };
		}
		if (inst.expand && depth <= 1) return { error: `R3: instance ${i} cannot expand again: depth budget exhausted`, final: false };
	}
	const old = new Set(instancesOf(run.plan, id));
	const spent = run.spawned ?? 0;
	if (spent + n > SPAWN_CREDIT) return { error: `R4: spawn credit exhausted (${spent}/${SPAWN_CREDIT} used, ${n} requested)`, final: true };
	if (run.plan.nodes.length - old.size + n > MAX_PLAN_NODES) return { error: `R4: ${n} instance(s) would exceed ${MAX_PLAN_NODES} plan nodes`, final: true };
	const kept = run.plan.nodes.filter((p) => !old.has(p.id));
	const children = run.plan.edges.filter(([a, b]) => a === id && !old.has(b)).map(([, b]) => b);
	const made: PlanNode[] = parsed.map((inst, k) => {
		const reads = inst.reads ?? t.reads;
		const writes = inst.writes ?? t.writes;
		const base = { id: `${id}/${k}`, origin: id, description: inst.description, ...(t.cost !== undefined ? { cost: t.cost } : {}), ...(node.route ? { route: node.route } : {}) };
		return inst.expand
			? { ...base, kind: "expand" as const, ...(reads ? { reads } : {}), spawn: { template: { ...t, ...(reads ? { reads } : {}), ...(writes ? { writes } : {}) }, max: spawn.max, depth: depth - 1 } }
			: { ...base, kind: t.kind, ...(reads ? { reads } : {}), ...(writes ? { writes } : {}) };
	});
	const plan: Plan = {
		...run.plan,
		nodes: [...kept, ...made],
		edges: [...run.plan.edges.filter(([a, b]) => !old.has(a) && !old.has(b)), ...made.flatMap((m) => [[id, m.id] as [string, string], ...children.map((c) => [m.id, c] as [string, string])])],
	};
	const compiled = compilePlan(plan);
	if (!compiled.ok) return { error: `R5: instantiated plan does not compile: ${compiled.diagnostics.map((d) => `${d.check}: ${d.message}`).join("; ").slice(0, 2000)}`, final: false };
	const before = spawnPotential(run);
	run.plan = plan;
	run.compiled = compiled.compiled;
	for (const o of old) delete run.nodes[o];
	for (const m of made) run.nodes[m.id] = { status: "pending", attempt: 0, facts: [], runs: 0 };
	run.spawned = spent + n;
	const after = spawnPotential(run);
	if (!lessThan3(after, before)) throw new Error(`spawn potential did not decrease: ${before} → ${after}`);
	(run.spawnPotential ??= []).push(after);
	return undefined;
}

export function createRun(id: string, plan: Plan, now: number, replanBudget = DEFAULT_REPLAN_BUDGET, owner?: RunState["owner"]): RunState {
	const run: RunState = {
		id, semantics: 2, repairsUsed: 0, revision: 0, status: "compiling", plan, nodes: {}, facts: {}, certified: [], replanBudget, potential: [],
		...(owner ? { owner } : {}),
		createdAt: now, updatedAt: now,
	};
	compileInto(run, now);
	return run;
}

function compileInto(run: RunState, now: number): void {
	const result = compilePlan(run.plan);
	run.updatedAt = now;
	if (!result.ok) {
		run.status = "blocked";
		run.diagnostics = result.diagnostics;
		delete run.compiled;
		run.reason = `plan does not compile: ${result.diagnostics.map((d) => `${d.check}: ${d.message}`).join("; ")}`;
		return;
	}
	run.compiled = result.compiled;
	delete run.diagnostics;
	delete run.reason;
	run.status = "running";
	for (const id of result.compiled.order) run.nodes[id] ??= { status: "pending", attempt: 0, facts: [], runs: 0 };
	for (const id of Object.keys(run.nodes)) if (!run.nodes[id] || !result.compiled.order.includes(id)) delete run.nodes[id];
	rekey(run);
	run.potential.push(potential(run));
}

export function nodeOf(run: RunState, id: string): PlanNode {
	const node = run.plan.nodes.find((n) => n.id === id);
	if (!node) throw new Error(`Unknown plan node ${id}`);
	return node;
}

/**
 * Recompute keys from the leaves of the dependency order. A node whose key changed loses its
 * succeeded status (it must re-run); nodes with unchanged keys keep their results. This is the
 * incremental-rebuild rule: exactly the node and its descendants are invalidated.
 */
export function rekey(run: RunState): string[] {
	const compiled = run.compiled;
	if (!compiled) return [];
	const invalidated: string[] = [];
	for (const id of compiled.order) {
		const state = run.nodes[id]!;
		const parentKeys = compiled.parents[id]!.map((p) => run.nodes[p]!.key ?? "");
		const factIds = state.facts.map((f) => `${f}@${run.facts[f] ?? ""}`);
		const key = nodeKey(nodeOf(run, id), parentKeys, [...factIds, ...(run.semantics === 2 && !run.owner ? [`generation:${state.generation ?? 0}`] : [])]);
		// A running node binds its facts when it completes; its key is not compared mid-flight.
		if (state.status === "running" || state.status === "waiting") { state.key = key; continue; }
		if (state.key !== undefined && state.key !== key && (state.status === "succeeded" || state.status === "failed" || state.status === "skipped")) {
			// Invalid evidence must not turn an already-admitted effect into permission to replay.
			const protectedEffect = !run.owner && (state.unknownEffects || (nodeOf(run, id).irreversible && state.runs > 0));
			state.status = protectedEffect ? "failed" : "pending";
			delete state.result;
			delete state.error;
			delete state.receipt;
			if (!protectedEffect) state.attempt = 0;
			else state.error = "effect already admitted; evidence invalidated, replay forbidden";
			invalidated.push(id);
		}
		state.key = key;
	}
	// Certification is relative to the keys of the verify nodes that produced it.
	run.certified = run.plan.goal.requirements.filter((req) =>
		run.plan.nodes.some((n) => {
			const state = run.nodes[n.id];
			return n.kind === "verify" && (n.covers ?? []).includes(req) && state?.status === "succeeded"
				&& (run.owner ? (state.receipt?.key === state.key && state.receipt?.attempt === state.attempt) : run.semantics === 2 && state.proof?.key === state.key && state.proof?.attempt === state.attempt);
		}),
	);
	return invalidated;
}

function artifactBinding(run: RunState, id: string, covers = nodeOf(run,id).covers ?? []): string {
 const writers = (run.compiled?.ancestors[id] ?? []).filter(p => nodeOf(run,p).writes?.length);
 return JSON.stringify([covers.slice().sort(), writers.map(p => [p, run.nodes[p]!.key, run.nodes[p]!.generation ?? 0, run.nodes[p]!.runs])]);
}
function rejectArtifact(run: RunState, id: string): void {
 if (run.owner || nodeOf(run,id).kind !== "verify") return;
 for (const req of nodeOf(run,id).covers ?? []) {
  const key = artifactBinding(run,id,[req]);
  if (!(run.rejectedArtifacts ??= []).includes(key)) run.rejectedArtifacts.push(key);
 }
}

/**
 * Pending ordinary verify nodes that can never become ready: for some covered requirement the current artifact
 * binding was already rejected and every writer ancestor has succeeded, so neither key, generation nor run count of
 * the bound artifact can change without an external fact revision. A pending writer ancestor still changes the
 * binding when it starts (runs + 1), so such a node is not frozen.
 */
export function frozenVerifiers(run: RunState): { id: string; requirements: string[] }[] {
	if (run.owner || !run.compiled || !run.rejectedArtifacts?.length) return [];
	const out: { id: string; requirements: string[] }[] = [];
	for (const node of run.plan.nodes) {
		const state = run.nodes[node.id];
		if (node.kind !== "verify" || (state?.status !== "pending" && state?.status !== "ready")) continue;
		const writers = (run.compiled.ancestors[node.id] ?? []).filter((p) => nodeOf(run, p).writes?.length);
		if (!writers.every((p) => run.nodes[p]?.status === "succeeded")) continue;
		const requirements = (node.covers ?? []).filter((req) => run.rejectedArtifacts!.includes(artifactBinding(run, node.id, [req])));
		if (requirements.length) out.push({ id: node.id, requirements });
	}
	return out;
}

/**
 * Unmet requirements no execution can certify without an external fact revision: every verifier covering them is
 * stuck. A node is stuck when it is failed or skipped (after a replan only permanently failed verifiers and
 * protected effects remain so), frozen, or has a stuck parent. Certified requirements are never dead, so a frozen
 * verifier of an already certified requirement does not block progress.
 */
export function deadRequirements(run: RunState): { requirement: string; verifiers: { id: string; why: "frozen" | "failed" | "upstream" }[] }[] {
	if (run.owner || !run.compiled) return [];
	const frozen = new Set(frozenVerifiers(run).map((f) => f.id));
	const why = new Map<string, "frozen" | "failed" | "upstream">();
	for (const id of run.compiled.order) {
		const status = run.nodes[id]!.status;
		if (status === "failed" || status === "skipped") why.set(id, "failed");
		else if (frozen.has(id)) why.set(id, "frozen");
		else if (run.compiled.parents[id]!.some((p) => why.has(p))) why.set(id, "upstream");
	}
	return unmet(run).flatMap((requirement) => {
		const verifiers = run.plan.nodes.filter((n) => n.kind === "verify" && (n.covers ?? []).includes(requirement)).map((n) => n.id);
		return verifiers.length && verifiers.every((id) => why.has(id)) ? [{ requirement, verifiers: verifiers.map((id) => ({ id, why: why.get(id)! })) }] : [];
	});
}

function describeDead(dead: ReturnType<typeof deadRequirements>): string {
	return dead.map(({ requirement, verifiers }) => verifiers.map(({ id, why }) =>
		why === "frozen" ? `${id} re-checks the already rejected artifact for ${requirement}`
			: why === "failed" ? `${id} already failed for ${requirement} on an unchanged contract and inputs`
				: `${id} (${requirement}) depends on a node that can no longer run`).join(", ")).join("; ");
}

export function frontier(run: RunState): string[] {
	if (!run.compiled || run.status !== "running") return [];
	if (!run.owner && Object.values(run.nodes).some(s => s.unknownEffects)) return [];
	const succeeded = new Set(Object.entries(run.nodes).filter(([, s]) => s.status === "succeeded").map(([id]) => id));
	const blocked = new Set(Object.entries(run.nodes).filter(([, s]) => s.status === "running" || s.status === "waiting" || s.status === "failed" || s.status === "skipped").map(([id]) => id));
	for (const node of run.plan.nodes) if (!run.owner && node.kind === "verify" && (node.covers ?? []).some(req => run.rejectedArtifacts?.includes(artifactBinding(run,node.id,[req])))) blocked.add(node.id);
	// A re-expansion replaces the previous instances; it waits until none of them is executing.
	const origin = new Map(run.plan.nodes.flatMap((n) => n.origin !== undefined ? [[n.id, n.origin] as const] : []));
	if (origin.size) for (const [id, s] of Object.entries(run.nodes)) {
		if (s.status !== "running" && s.status !== "waiting") continue;
		for (let up = origin.get(id); up !== undefined; up = origin.get(up)) blocked.add(up);
	}
	return readyNodes(run.compiled, succeeded, blocked);
}

export function start(run: RunState, id: string, handle: string | undefined, now: number, runnerId?: string): void {
	const state = run.nodes[id];
	if (!state) throw new Error(`Unknown plan node ${id}`);
	if (state.status === "running") return;
	if (!frontier(run).includes(id)) throw new Error(`Node ${id} is not ready (${state.status})`);
	state.status = "running";
	state.attempt++;
	state.runs++;
	state.startedAt = now;
	delete state.endedAt;
	delete state.error;
	if (handle !== undefined) state.handle = handle;
	if (runnerId !== undefined) state.runnerId = runnerId;
	state.binding = { key: state.key!, attempt: state.attempt, ...(state.handle ? { handle: state.handle } : {}), ...(state.runnerId ? { runnerId: state.runnerId } : {}), parents: parentBinding(run, id) };
	run.updatedAt = now;
}

export function waiting(run: RunState, id: string, now: number): void {
	const state = run.nodes[id];
	if (state?.status === "running") { state.status = "waiting"; run.updatedAt = now; }
}

export function resume(run: RunState, id: string, now: number): void {
	const state = run.nodes[id];
	if (state?.status === "waiting") { state.status = "running"; run.updatedAt = now; }
}

/** Record a fact read by a node. Changes the node's key for future comparison. */
export function readFact(run: RunState, id: string, factId: string, answer: string): void {
	const state = run.nodes[id];
	if (!state) throw new Error(`Unknown plan node ${id}`);
	if (!state.facts.includes(factId)) state.facts.push(factId);
	run.facts[factId] = factHash(answer);
}

/** The key a node binds at completion: its contract, parents' current keys, and the fact revisions it read. */
function currentKey(run: RunState, id: string): string {
	const state = run.nodes[id]!;
	const parentKeys = (run.compiled?.parents[id] ?? []).map((p) => run.nodes[p]!.key ?? "");
	return nodeKey(nodeOf(run, id), parentKeys, [...state.facts.map((f) => `${f}@${run.facts[f] ?? ""}`), ...(run.semantics === 2 && !run.owner ? [`generation:${state.generation ?? 0}`] : [])]);
}

export function succeed(run: RunState, id: string, result: string, now: number, deferRepair = false): void {
	if (run.owner) throw new Error("Research-owned nodes require host-accepted receipt settlement");
	if (run.status === "cancelled") throw new Error("Stale cancelled outcome");
	if (!bindingCurrent(run, id)) {
		// An outcome on superseded inputs judged or decided nothing current. A verifier is retried without rejecting the
		// artifact; an ask node is re-dispatched (a human approval of the same nodes is reused); other nodes fail the attempt.
		const stale = "stale dependency generation or outcome binding";
		const kind = nodeOf(run, id).kind;
		if (!run.owner && kind === "verify") retryVerifier(run, id, stale, now, false);
		else if (!run.owner && kind === "ask") retryStale(run, id, stale, now);
		else fail(run, id, stale, now);
		return;
	}
	if (nodeOf(run, id).kind === "verify") {
		const read = readVerdict(result, nodeOf(run, id).covers ?? []);
		// No readable verdict and no negative marker: a protocol defect, not a judgment of the artifact.
		if (run.semantics === 2 && !run.owner && !read.ok && !read.negative) { retryVerifier(run, id, `malformed verdict: ${read.reason}`, now); return; }
		const verdict = read.ok ? read.verdict : undefined;
		if (run.semantics !== 2 || !verdict || verdict.requirements.some(r => r.verdict !== "pass")) {
			rejectArtifact(run,id);
			const state = run.nodes[id]!;
			if (verdict?.repairable && verdict.requirements.some(r => r.verdict === "fail") && !verdict.requirements.some(r => r.verdict === "unknown") && nodeOf(run, id).repair) {
				state.pendingRepair = { key: state.key!, attempt: state.attempt, generation: state.generation ?? 0, result };
			}
			fail(run, id, `verification rejected: ${result}`, now);
			if (!deferRepair) settleRepairs(run, now); return;
		}
		run.nodes[id]!.proof = { key: currentKey(run, id), attempt: run.nodes[id]!.attempt };
		delete run.nodes[id]!.protocolFeedback;
	}
	if (nodeOf(run, id).spawn) {
		const rejected = instantiate(run, id, result);
		const state = run.nodes[id]!;
		if (rejected) {
			state.spawnFeedback = rejected.error.slice(0, 2000);
			fail(run, id, `spawn rejected: ${rejected.error}`, now);
			// Credit and node cap do not change by retrying the planner.
			if (rejected.final && state.status === "pending") { state.status = "failed"; settle(run, now); }
			if (!deferRepair) settleRepairs(run, now);
			return;
		}
		delete state.spawnFeedback;
	}
	completeNode(run, id, result, now);
	if (!deferRepair) settleRepairs(run, now);
}

/** One repair owner; delivered negatives stay durable while impacted peers are live. */
export function settleRepairs(run: RunState, now: number): void {
 if (run.owner || run.status === "cancelled") return;
 for (const [id, state] of Object.entries(run.nodes)) {
  const pending = state.pendingRepair;
  if (!pending) continue;
  const node = nodeOf(run, id), repair = node.repair;
  if (!repair || pending.key !== state.key || pending.attempt !== state.attempt || pending.generation !== (state.generation ?? 0)) { delete state.pendingRepair; continue; }
  const affected = impact(run, repair.predecessorId);
  const denied = affected.some(n => {
   const s = run.nodes[n]!;
   const judgment = s.error?.startsWith("verification rejected: ") ? readVerdict(s.error.slice("verification rejected: ".length), nodeOf(run,n).covers ?? []) : undefined;
   return s.unknownEffects || (judgment?.ok && judgment.verdict.requirements.some(r => r.verdict === "unknown")) || (nodeOf(run,n).irreversible && s.runs > 0);
  });
  if (denied || (run.repairsUsed ?? 0) >= Math.min(2, repair.maxRepairs)) { delete state.pendingRepair; continue; }
  if (affected.some(n => ["running", "waiting"].includes(run.nodes[n]!.status))) continue;
  const prior = run.nodes[repair.predecessorId]!.result;
  const negatives = affected.flatMap(n => run.nodes[n]!.error?.startsWith("verification rejected: ") ? [{ verifier:n, failure:run.nodes[n]!.error!.slice("verification rejected: ".length) }] : []);
  run.repairHistory ??= [];
  run.repairHistory.push({ predecessorId:repair.predecessorId, verifier:id, failure:pending.result, nodes:JSON.parse(JSON.stringify(Object.fromEntries(affected.map(n => [n,run.nodes[n]!])))) });
  run.repairsUsed = (run.repairsUsed ?? 0) + 1;
  for (const n of affected) { const old=run.nodes[n]!; run.nodes[n]={status:"pending", attempt:0, runs:old.runs, facts:old.facts, generation:(old.generation ?? 0)+1}; }
  run.nodes[repair.predecessorId]!.repairFeedback=JSON.stringify({failure:pending.result, negatives, priorActorResult:prior, requirements:node.covers});
  run.status="running"; delete run.reason; rekey(run); run.updatedAt=now;
 }
}

function parentBinding(run: RunState, id: string): string {
 return JSON.stringify((run.compiled?.parents[id] ?? []).map(p => [p, run.nodes[p]!.key, run.nodes[p]!.generation ?? 0, run.nodes[p]!.runs]));
}
export function bindingCurrent(run: RunState, id: string): boolean {
 const s = run.nodes[id];
 // Parent keys can return to an earlier value (fact v1 -> v2 -> v1) while a parent is still pending: require the
 // parents to be succeeded too, so "succeeded ⇒ every ancestor succeeded" does not depend on the fact history.
 return !!s && run.status === "running" && !!s.binding && s.binding.attempt === s.attempt && s.binding.handle === s.handle && s.binding.runnerId === s.runnerId && s.binding.parents === parentBinding(run,id) && (run.compiled?.parents[id] ?? []).every((p) => run.nodes[p]?.status === "succeeded") && (nodeOf(run,id).kind !== "verify" || s.binding.key === currentKey(run,id));
}

/** Internal host authority; never expose this shape as a model tool input. */
export type OwnedNodeReceipt = {
	missionId: string;
	nodeId: string;
	receiptId: string;
	key: string;
	attempt: number;
	result: string;
};

export function settleOwnedNode(run: RunState, receipt: OwnedNodeReceipt, now: number): void {
	const state = run.nodes[receipt.nodeId];
	if (!run.owner || run.owner.missionId !== receipt.missionId) throw new Error("Research owner mismatch");
	if (run.status !== "cancelled" && state?.status === "succeeded" && state.receipt?.id === receipt.receiptId
		&& state.receipt.key === receipt.key && state.receipt.attempt === receipt.attempt
		&& currentKey(run, receipt.nodeId) === receipt.key && state.result === receipt.result) return;
	if (run.status !== "running" || !state || !receipt.receiptId || receipt.key !== currentKey(run, receipt.nodeId) || receipt.attempt !== state.attempt) {
		throw new Error("Stale or invalid research receipt");
	}
	if (state.status !== "running" && state.status !== "waiting") throw new Error(`Node ${receipt.nodeId} is not running`);
	state.receipt = { id: receipt.receiptId, key: receipt.key, attempt: receipt.attempt };
	completeNode(run, receipt.nodeId, receipt.result, now);
}

function completeNode(run: RunState, id: string, result: string, now: number): void {
	const state = run.nodes[id];
	if (!state || (state.status !== "running" && state.status !== "waiting")) throw new Error(`Node ${id} is not running`);
	state.key = currentKey(run, id);
	state.status = "succeeded";
	state.result = result;
	state.endedAt = now;
	rekey(run);
	run.updatedAt = now;
	settle(run, now);
}

/**
 * A failed node fails its attempt; descendants are untouched (they were never ready). When the
 * attempt budget is exhausted the node stays failed and the run needs a replan or is blocked.
 */
export function fail(run: RunState, id: string, error: string, now: number, terminal = false): void {
	const state = run.nodes[id];
	if (!state || (state.status !== "running" && state.status !== "waiting")) throw new Error(`Node ${id} is not running`);
	state.key = currentKey(run, id);
	rejectArtifact(run,id);
	if (terminal) state.unknownEffects = true;
	state.error = error;
	state.endedAt = now;
	// Verdicts, refused authority and irreversible effects are not transient: they fail at once.
	const once = !run.owner && (nodeOf(run, id).kind === "verify" || nodeOf(run, id).kind === "ask" || nodeOf(run, id).irreversible);
	state.status = terminal || once ? "failed" : state.attempt < MAX_NODE_ATTEMPTS ? "pending" : "failed";
	run.updatedAt = now;
	settle(run, now);
}

/**
 * An ordinary verifier attempt that delivered no verdict (malformed final message, or its executor failed before
 * answering) judged nothing, so the artifact is not rejected. The verifier is re-dispatched with the reason while
 * per-key attempts remain (MAX_NODE_ATTEMPTS bounds retries); after that it fails without rejecting the artifact, so
 * a replan may still verify it with a replacement verifier. A delivered fail/unknown verdict never comes here.
 */
export function retryVerifier(run: RunState, id: string, error: string, now: number, protocol = true): void {
	if (run.owner || nodeOf(run, id).kind !== "verify") throw new Error(`Node ${id} is not an ordinary verifier`);
	const state = run.nodes[id];
	// Protocol feedback tells the next reviewer its format was unreadable; a stale outcome was not a format problem.
	if (state && protocol) state.protocolFeedback = error.slice(0, 2000);
	else if (state) delete state.protocolFeedback;
	retryStale(run, id, error, now);
}

/** Re-dispatch an attempt that judged nothing current, within the per-key attempt budget; nothing is rejected. */
function retryStale(run: RunState, id: string, error: string, now: number): void {
	const state = run.nodes[id];
	if (!state || (state.status !== "running" && state.status !== "waiting")) throw new Error(`Node ${id} is not running`);
	state.key = currentKey(run, id);
	state.error = error;
	state.endedAt = now;
	state.status = state.attempt < MAX_NODE_ATTEMPTS ? "pending" : "failed";
	run.updatedAt = now;
	settle(run, now);
}

/**
 * A ready node that could not be dispatched at all (its contract does not fit the context budget): it fails without
 * retry, but no executor ran, so it neither counts as an admitted effect (`runs`) nor rejects an artifact.
 */
export function failUndispatched(run: RunState, id: string, error: string, now: number): void {
	const state = run.nodes[id];
	if (!state) throw new Error(`Unknown plan node ${id}`);
	if (!frontier(run).includes(id)) throw new Error(`Node ${id} is not ready (${state.status})`);
	state.attempt++;
	state.status = "failed";
	state.error = error;
	state.startedAt = now;
	state.endedAt = now;
	run.updatedAt = now;
	settle(run, now);
}

/** Irreversible descendants of an ask node: what a human authority answer for it must cover. */
export function askNodeRefs(run: RunState, id: string): string[] {
	if (!run.compiled) return [];
	return descendants(run.compiled, id).filter((d) => nodeOf(run, d).irreversible).sort();
}

/** Contract keys of the irreversible nodes an authority answer covers: an approval binds to contracts, not ids. */
export function askNodeKeys(run: RunState, refs: readonly string[]): string[] {
	return refs.map((ref) => nodeKey(nodeOf(run, ref), []));
}

/** Whether a recorded authorization still covers every current irreversible descendant with an unchanged contract. */
export function askAuthorizes(run: RunState, id: string, ask: NodeRun["ask"]): boolean {
	const refs = askNodeRefs(run, id);
	if (!refs.length) return true;
	if (!ask) return false;
	const keys = new Map(ask.refs.map((ref, i) => [ref, ask.keys?.[i]]));
	return refs.every((ref) => keys.has(ref) && (keys.get(ref) === undefined || keys.get(ref) === nodeKey(nodeOf(run, ref), [])));
}

export type AskNodeOutcome = { granted: boolean; result: string };

/**
 * Settle an ordinary ask node from its resolved ask record (ADR 0030: the orchestrator resolves ask nodes). A granted
 * ask succeeds with the decision as its result; a refused or defaulted authority fails the node without retry.
 */
export function resolveAskNode(run: RunState, id: string, outcome: AskNodeOutcome, now: number): void {
	if (run.owner) throw new Error("Research-owned runs have no orchestrator ask nodes");
	const state = run.nodes[id];
	if (nodeOf(run, id).kind !== "ask") throw new Error(`Node ${id} is not an ask node`);
	if (!state || (state.status !== "running" && state.status !== "waiting")) throw new Error(`Node ${id} is not running`);
	if (outcome.granted) succeed(run, id, outcome.result, now);
	else fail(run, id, outcome.result, now);
}

/**
 * A late or changed fact: nodes that read it (and their descendants, through parent keys) are
 * invalidated and re-run. Nothing else changes. Returns the invalidated ids.
 */
export function reviseFact(run: RunState, factId: string, answer: string, now: number): string[] {
	const hash = factHash(answer);
	if (run.facts[factId] === hash) return [];
	run.facts[factId] = hash;
	const invalidated = rekey(run);
	run.updatedAt = now;
	if (run.status === "verified" && invalidated.length) run.status = "running";
	settle(run, now);
	return invalidated;
}

export type ReplanResult = { ok: true; invalidated: string[] } | { ok: false; reason: string; diagnostics?: Diagnostic[] };

/**
 * Replace the plan. Admissible only if the goal is monotone (no requirement removed), the
 * budget is positive, the new plan compiles and it leaves no frozen verifier. Succeeded nodes with
 * identical contracts and parent keys keep their results; Φ strictly decreases (budget − 1, |unmet|
 * non-increasing by key reuse). A rejected replan leaves the run unchanged.
 *
 * A run that never compiled (blocked at creation) has no nodes, effects or progress. Its first
 * successful compile is equivalent to creation and costs no budget; it can happen at most once
 * because a compiled run never loses its compiled plan, so Φ remains well-founded.
 */
export function replan(run: RunState, plan: Plan, now: number): ReplanResult {
	if (run.status === "verified" || run.status === "cancelled") return { ok: false, reason: `run is ${run.status}` };
	if (!run.owner && Object.values(run.nodes).some(s => s.status === "running" || s.status === "waiting")) return { ok: false, reason: "settle running effects before replan" };
	// Freeze the plan once effects cannot safely be replayed. Comparing new IDs or prose
	// cannot prove that a renamed/replacement actor is a distinct external operation.
	if (!run.owner && Object.values(run.nodes).some(s => s.unknownEffects)) return { ok: false, reason: "unresolved effects forbid replan" };
	if (!run.owner && run.plan.nodes.some(n => n.irreversible && (run.nodes[n.id]?.runs ?? 0) > 0)) return { ok: false, reason: "admitted irreversible effects forbid replan" };
	const firstCompile = !run.compiled;
	if (!firstCompile && run.replanBudget <= 0) return { ok: false, reason: "replan budget exhausted" };
	const removed = run.plan.goal.requirements.filter((req) => !plan.goal.requirements.includes(req));
	if (removed.length) return { ok: false, reason: `goal is not monotone; removed requirements: ${removed.join(", ")}` };
	if (plan.nodes.some((n) => n.origin !== undefined)) return { ok: false, reason: "spawned instances are host-owned; submit the plan without them" };
	const carried = firstCompile ? { plan, reset: [] } : carryExpansions(run, plan);
	plan = carried.plan;
	const compiled = compilePlan(plan);
	if (!compiled.ok) return { ok: false, reason: "plan does not compile", diagnostics: compiled.diagnostics };
	const draft: RunState = JSON.parse(JSON.stringify(run));
	const invalidated = firstCompile ? compileFirst(draft, plan, now) : applyReplan(draft, plan, compiled.compiled, now, carried.reset);
	const dead = deadRequirements(draft);
	if (dead.length) {
		return { ok: false, reason: `replan leaves requirement(s) no verifier can ever certify: ${describeDead(dead)}. Add or re-run an ancestor that declares writes and changes the artifact, or replace the failed verification` };
	}
	for (const key of Object.keys(run)) if (!(key in draft)) delete (run as Record<string, unknown>)[key];
	Object.assign(run, draft);
	return { ok: true, invalidated };
}

/**
 * C1: a replan keeps an expansion only when its spawner keeps the same template and the same children, so every carried
 * instance still sits where its checks put it; carried instances are not charged again. Any other expansion is dropped
 * and a succeeded spawner is reset to plan again (C2: dropping never refunds spawn credit).
 */
function carryExpansions(run: RunState, plan: Plan): { plan: Plan; reset: string[] } {
	const spawners = run.plan.nodes.filter((n) => n.spawn && n.origin === undefined && instancesOf(run.plan, n.id).length);
	if (!spawners.length) return { plan, reset: [] };
	const nodes = [...plan.nodes];
	const edges = [...plan.edges];
	const reset: string[] = [];
	const childSet = (p: Plan, id: string) => JSON.stringify(p.edges.filter(([a, b]) => a === id && p.nodes.find((x) => x.id === b)?.origin === undefined).map(([, b]) => b).sort());
	for (const old of spawners) {
		const next = plan.nodes.find((n) => n.id === old.id);
		if (!next) continue;
		if (JSON.stringify(next.spawn ?? null) !== JSON.stringify(old.spawn) || next.kind !== old.kind || childSet(plan, old.id) !== childSet(run.plan, old.id)) { reset.push(old.id); continue; }
		const ids = new Set(instancesOf(run.plan, old.id));
		nodes.push(...run.plan.nodes.filter((n) => ids.has(n.id)));
		edges.push(...run.plan.edges.filter(([a, b]) => ids.has(a) || ids.has(b)));
	}
	return { plan: { ...plan, nodes, edges }, reset };
}

function compileFirst(run: RunState, plan: Plan, now: number): string[] {
	run.plan = plan;
	run.revision++;
	compileInto(run, now);
	settle(run, now);
	return [];
}

function applyReplan(run: RunState, plan: Plan, compiled: CompiledPlan, now: number, reset: readonly string[] = []): string[] {
	const before = potential(run);
	run.plan = plan;
	run.replanBudget--;
	run.revision++;
	// Nodes that disappeared are dropped; new nodes start pending; kept nodes are re-keyed below.
	for (const id of Object.keys(run.nodes)) if (!plan.nodes.some((n) => n.id === id)) delete run.nodes[id];
	for (const node of plan.nodes) {
		const state = run.nodes[node.id];
		if (!state) run.nodes[node.id] = { status: "pending", attempt: 0, facts: [], runs: 0 };
		else if ((state.status === "failed" || state.status === "skipped") && (run.owner || node.kind !== "verify")) { state.status = "pending"; state.attempt = 0; delete state.error; }
	}
	// A spawner whose expansion was dropped plans again; the new generation changes its key and so its descendants'.
	for (const id of reset) {
		const s = run.nodes[id];
		if (!s || s.status !== "succeeded") continue;
		Object.assign(s, { status: "pending", attempt: 0, generation: (s.generation ?? 0) + 1 });
		delete s.result; delete s.error; delete s.receipt; delete s.proof;
	}
	run.compiled = compiled;
	// An approval covers exactly the irreversible contracts it was asked for. A replan that adds an irreversible
	// descendant or changes one of their contracts re-opens the ask, and nothing below it keeps a result.
	if (!run.owner) for (const node of plan.nodes) {
		const state = run.nodes[node.id]!;
		if (node.kind !== "ask" || state.status !== "succeeded") continue;
		if (askAuthorizes(run, node.id, state.ask)) continue;
		for (const id of [node.id, ...descendants(compiled, node.id)]) {
			const s = run.nodes[id]!;
			if (s.status !== "succeeded" && s.status !== "failed" && s.status !== "skipped") continue;
			Object.assign(s, { status: "pending", attempt: 0, generation: (s.generation ?? 0) + 1 });
			delete s.result; delete s.error; delete s.receipt; delete s.proof; if (id === node.id) delete s.ask;
		}
	}
	delete run.diagnostics;
	delete run.reason;
	run.status = "running";
	const invalidated = rekey(run);
	run.updatedAt = now;
	const after = potential(run);
	if (!lessThan(after, before)) throw new Error(`potential did not decrease: ${before} → ${after}`);
	run.potential.push(after);
	settle(run, now);
	return invalidated;
}

const SUBAGENT_HANDLE = /^sa-/;

/**
 * Terminal transition. Ordinary nodes without a subagent executor (asks waiting on the orchestrator, synchronous
 * checks interrupted mid-flight) are closed at once. Subagent nodes stay running until the host observes their
 * executor settle and calls closeSettledNode: run termination alone never claims child termination.
 */
export function cancel(run: RunState, reason: string, now: number): void {
	// Idempotent: a repeated or replayed cancel keeps the first reason and time.
	if (run.status === "verified" || run.status === "cancelled") return;
	run.status = "cancelled";
	run.reason = reason;
	run.updatedAt = now;
	if (run.owner) return;
	for (const state of Object.values(run.nodes)) {
		if ((state.status !== "running" && state.status !== "waiting") || SUBAGENT_HANDLE.test(state.handle ?? "")) continue;
		state.status = "skipped";
		state.error = `run cancelled before this node settled: ${reason}`;
		state.endedAt = now;
	}
}

/**
 * Closes a running/waiting node of a terminal ordinary run once its executor has settled. The node becomes
 * `skipped` (never `succeeded`: a terminal run certifies nothing new); the executor's answer is retained as audit
 * evidence. An aborted or lost executor leaves unknown effects.
 */
export function closeSettledNode(run: RunState, id: string, outcome: { status: "completed" | "failed" | "cancelled"; answer?: string; error?: string }, now: number): void {
	if (run.owner) throw new Error("Research-owned nodes require host-accepted receipt settlement");
	if (run.status !== "cancelled" && run.status !== "verified") throw new Error(`Run ${run.id} is ${run.status}, not terminal`);
	const state = run.nodes[id];
	if (!state || (state.status !== "running" && state.status !== "waiting")) throw new Error(`Node ${id} is not running`);
	state.status = "skipped";
	state.endedAt = now;
	state.error = `run ${run.status} before this node settled; executor ${outcome.status}${outcome.error ? `: ${outcome.error}` : ""}`;
	if (outcome.answer !== undefined) state.result = outcome.answer;
	if (outcome.status === "cancelled" || outcome.error === "subagent record missing") state.unknownEffects = true;
	run.updatedAt = now;
}

/** Derive the terminal status. verified ⇔ every requirement certified; blocked ⇔ no progress possible. */
export function settle(run: RunState, now: number): void {
	if (run.status === "cancelled" || !run.compiled) return;
	if (unmet(run).length === 0 && (run.owner || Object.values(run.nodes).every(s => s.status === "succeeded"))) { run.status = "verified"; delete run.reason; run.updatedAt = now; return; }
	const active = Object.values(run.nodes).some((s) => s.status === "running" || s.status === "waiting");
	if (active || frontier(run).length > 0) { run.status = "running"; return; }
	const failed = Object.entries(run.nodes).filter(([, s]) => s.status === "failed").map(([id]) => id);
	const open = new Set(unmet(run));
	const frozen = frozenVerifiers(run).filter((f) => (nodeOf(run, f.id).covers ?? []).some((req) => open.has(req)));
	run.status = "blocked";
	const why = (id: string) => {
		const s = run.nodes[id]!;
		const node = nodeOf(run, id);
		// Classify by the recorded failure first: a rejection on the third attempt is still a rejection.
		const cause = s.unknownEffects ? "unknown effects, not retried"
			: (s.error ?? "").startsWith("verification rejected") ? "verifier rejected the artifact; a fail/unknown verdict is not retried"
			: s.attempt >= MAX_NODE_ATTEMPTS ? `retry budget exhausted (${MAX_NODE_ATTEMPTS})`
			: !run.owner && node.kind === "verify" ? `verify node failed: ${(s.error ?? "").slice(0, 120)}; not retried`
			: !run.owner && node.kind === "ask" ? `${(s.error ?? "ask resolved negatively").slice(0, 160)}; not retried`
			: !run.owner && node.irreversible ? "irreversible, not retried" : `failed: ${(s.error ?? "").slice(0, 120)}`;
		return `${id} (attempt ${s.attempt}: ${cause})`;
	};
	run.reason = [
		...(failed.length ? [`nodes failed: ${failed.map(why).join(", ")}`] : []),
		...(frozen.length ? [`verifier(s) re-check an already rejected artifact and cannot run: ${frozen.map((f) => `${f.id} (${f.requirements.join(", ")})`).join(", ")}; a writer ancestor must change the artifact`] : []),
	].join("; ") || "no ready node and unmet requirements remain";
	// Mirror replan()'s guards so the advice is actionable: admitted irreversible or unknown effects freeze the plan.
	const frozenPlan = !run.owner && (Object.values(run.nodes).some((s) => s.unknownEffects) || run.plan.nodes.some((n) => n.irreversible && (run.nodes[n.id]?.runs ?? 0) > 0));
	if (failed.length || frozen.length) run.reason += frozenPlan ? "; replan is refused after admitted irreversible or unknown effects; cancel" : run.replanBudget > 0 ? "; replan or cancel" : "; replan budget exhausted";
	run.updatedAt = now;
}

/** Nodes whose results would be discarded if `id` were re-run. */
export function impact(run: RunState, id: string): string[] {
	return run.compiled ? [id, ...descendants(run.compiled, id)] : [id];
}

/**
 * κ settlement: the orchestrator sees one receipt of at most KAPPA bytes per expansion (counts by status plus the first
 * failing or live instances), not one line per instance, so its context grows with the static plan only. Full instance
 * state stays in the run (dag_status details) and flows to consumers through the bounded node prompt.
 */
export function expansionReceipt(run: RunState, id: string): string | undefined {
	const ids = instancesOf(run.plan, id);
	if (!ids.length) return undefined;
	const counts: Record<string, number> = {};
	for (const i of ids) { const st = run.nodes[i]?.status ?? "pending"; counts[st] = (counts[st] ?? 0) + 1; }
	const digest = createHash("sha256").update(JSON.stringify(ids.map((i) => [i, run.nodes[i]?.key ?? "", run.nodes[i]?.status ?? ""]))).digest("hex").slice(0, 12);
	let line = `  ${id}/* <spawned> ${ids.length} instance(s) ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" ")} receipt=${digest}`;
	for (const i of ids) {
		const s = run.nodes[i]!;
		if (s.status !== "failed" && s.status !== "running" && s.status !== "waiting") continue;
		const item = `; ${i} ${s.status}${s.error ? ` ! ${s.error.slice(0, 80)}` : ""}`;
		if (Buffer.byteLength(line + item) > KAPPA - 16) { line += "; …"; break; }
		line += item;
	}
	return line;
}

export function summarize(run: RunState): string {
	const spawning = run.spawned !== undefined || run.plan.nodes.some((n) => n.spawn);
	const lines = [`run ${run.id} semantics=${run.owner ? "research-receipts" : run.semantics === 2 ? "strict-v2" : "legacy (historical, not strict proof)"} repairs=${run.repairsUsed ?? 0}/2 rev ${run.revision} [${run.status}] Φ=(${potential(run).join(",")})${spawning ? ` Φ'=(${spawnPotential(run).join(",")})` : ""} unmet=${unmet(run).join(",") || "∅"} budget=${run.replanBudget}${run.reason ? ` — ${run.reason}` : ""}`];
	if (run.compiled) {
		for (const id of run.compiled.order) {
			const s = run.nodes[id]!;
			const node = nodeOf(run, id);
			if (node.origin !== undefined) continue;
			lines.push(`  ${id} <${node.kind}> ${s.status}${s.attempt ? ` #${s.attempt}` : ""}${s.handle ? ` ${s.handle}` : ""}${s.ask ? ` ask ${s.ask.id}` : ""}${s.error ? ` ! ${s.error.slice(0, 120)}` : ""}`);
			const receipt = node.spawn ? expansionReceipt(run, id) : undefined;
			if (receipt) lines.push(receipt);
		}
		lines.push(`  critical path: ${run.compiled.criticalPath.join(" → ")} (${run.compiled.criticalCost}/${run.compiled.totalCost})`);
	}
	if (run.diagnostics) for (const d of run.diagnostics) lines.push(`  ✗ ${d.check}: ${d.message}`);
	return lines.join("\n");
}
