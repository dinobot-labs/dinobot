import { createHash } from "node:crypto";

/**
 * Agent-authored plan IR and its compiler (ADR 0030).
 *
 * The compiler is a pure function: no I/O, no clock. Predicates are mechanical; natural language
 * lives only in `description`. Checks are the static guarantees the executor relies on:
 * acyclicity, closure, coverage, race freedom (Bernstein) and verify dominance.
 */

export type Predicate =
	| { kind: "file"; path: string; hash?: string }
	| { kind: "check"; id: string }
	| { kind: "fact"; id: string }
	| { kind: "node"; id: string }
	| { kind: "req"; id: string };

export type NodeKind = "act" | "delegate" | "verify" | "ask" | "expand";

export type PlanNode = {
	id: string;
	kind: NodeKind;
	description?: string;
	pre?: Predicate[];
	post?: Predicate[];
	/** Scopes read and written. A scope is a path; a trailing "/" or a prefix relation denotes containment. */
	reads?: string[];
	writes?: string[];
	/** verify nodes: requirement IDs this node certifies. */
	covers?: string[];
	/** An act whose effect cannot be undone. Requires an `ask` ancestor (authority). */
	irreversible?: boolean;
	/** Relative cost weight for the critical path; default 1. */
	cost?: number;
	route?: string;
	repair?: { predecessorId: string; maxRepairs: number };
};

export type Plan = {
	nodes: PlanNode[];
	/** Directed edges from → to. */
	edges: [string, string][];
	goal: { requirements: string[] };
	/** Facts true before the first node runs. */
	init?: Predicate[];
};

export type CheckName = "shape" | "acyclic" | "closure" | "coverage" | "race" | "verify-dominance" | "authority"
	| "certifying-dominance" | "pre-effect-verification" | "producer-order";

export type Diagnostic = { check: CheckName; message: string; nodes: string[] };

export type CompiledPlan = {
	order: string[];
	parents: Record<string, string[]>;
	children: Record<string, string[]>;
	ancestors: Record<string, string[]>;
	/** Longest weighted path; the lower bound on makespan with unbounded parallelism (Brent). */
	criticalPath: string[];
	criticalCost: number;
	totalCost: number;
};

export type CompileResult = { ok: true; compiled: CompiledPlan } | { ok: false; diagnostics: Diagnostic[] };

export function canonicalPredicate(p: Predicate): string {
	switch (p.kind) {
		case "file": return p.hash === undefined ? `file:${p.path}` : `file:${p.path}#${p.hash}`;
		default: return `${p.kind}:${p.id}`;
	}
}

/** `provided` satisfies `wanted`. A hashed file wants that exact hash; an unhashed file accepts any hash. */
export function satisfies(wanted: Predicate, provided: Predicate): boolean {
	if (wanted.kind !== provided.kind) return false;
	if (wanted.kind === "file" && provided.kind === "file") {
		return wanted.path === provided.path && (wanted.hash === undefined || wanted.hash === provided.hash);
	}
	return canonicalPredicate(wanted) === canonicalPredicate(provided);
}

/** Two scopes overlap when equal or one contains the other. */
export function scopesOverlap(a: string, b: string): boolean {
	const x = normalizeScope(a);
	const y = normalizeScope(b);
	if (x === y) return true;
	if (x === "") return true;
	if (y === "") return true;
	return x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

function normalizeScope(scope: string): string {
	let s = scope.trim().replaceAll("\\", "/");
	while (s.startsWith("./")) s = s.slice(2);
	while (s.endsWith("/")) s = s.slice(0, -1);
	return s === "." ? "" : s;
}

export function compilePlan(plan: Plan): CompileResult {
	const diagnostics: Diagnostic[] = [];
	const byId = new Map<string, PlanNode>();
	for (const node of plan.nodes) {
		if (!node.id) diagnostics.push({ check: "shape", message: "node id must be non-empty", nodes: [] });
		else if (byId.has(node.id)) diagnostics.push({ check: "shape", message: `duplicate node id "${node.id}"`, nodes: [node.id] });
		else byId.set(node.id, node);
		if (node.kind === "verify" && (node.covers ?? []).length === 0) {
			diagnostics.push({ check: "shape", message: `verify node "${node.id}" covers no requirement`, nodes: [node.id] });
		}
		for (const req of node.covers ?? []) {
			if (!plan.goal.requirements.includes(req)) {
				diagnostics.push({ check: "shape", message: `node "${node.id}" covers unknown requirement "${req}"`, nodes: [node.id] });
			}
		}
		if (node.cost !== undefined && !(node.cost >= 0 && Number.isFinite(node.cost))) {
			diagnostics.push({ check: "shape", message: `node "${node.id}" has an invalid cost`, nodes: [node.id] });
		}
	}
	const edges: [string, string][] = [];
	const seenEdges = new Set<string>();
	for (const [from, to] of plan.edges) {
		if (!byId.has(from) || !byId.has(to)) {
			diagnostics.push({ check: "shape", message: `edge ${from} → ${to} references an unknown node`, nodes: [from, to].filter((id) => byId.has(id)) });
			continue;
		}
		if (from === to) {
			diagnostics.push({ check: "acyclic", message: `self edge on "${from}"`, nodes: [from] });
			continue;
		}
		const key = `${from}\u0000${to}`;
		if (seenEdges.has(key)) continue;
		seenEdges.add(key);
		edges.push([from, to]);
	}
	if (diagnostics.length) return { ok: false, diagnostics };

	const ids = [...byId.keys()];
	const parents: Record<string, string[]> = Object.fromEntries(ids.map((id) => [id, []]));
	const children: Record<string, string[]> = Object.fromEntries(ids.map((id) => [id, []]));
	for (const [from, to] of edges) {
		parents[to]!.push(from);
		children[from]!.push(to);
	}

	// Kahn: a complete order exists iff the graph is acyclic.
	const indegree = new Map(ids.map((id) => [id, parents[id]!.length]));
	const queue = ids.filter((id) => indegree.get(id) === 0);
	const order: string[] = [];
	while (queue.length) {
		const id = queue.shift()!;
		order.push(id);
		for (const child of children[id]!) {
			const left = indegree.get(child)! - 1;
			indegree.set(child, left);
			if (left === 0) queue.push(child);
		}
	}
	if (order.length !== ids.length) {
		const cyclic = ids.filter((id) => indegree.get(id)! > 0);
		return { ok: false, diagnostics: [{ check: "acyclic", message: `cycle through ${cyclic.join(", ")}`, nodes: cyclic }] };
	}

	const ancestors: Record<string, Set<string>> = Object.fromEntries(ids.map((id) => [id, new Set<string>()]));
	for (const id of order) {
		for (const parent of parents[id]!) {
			ancestors[id]!.add(parent);
			for (const a of ancestors[parent]!) ancestors[id]!.add(a);
		}
	}
	for (const node of plan.nodes) {
		if (!node.repair) continue;
		const target = byId.get(node.repair.predecessorId);
		if (node.kind !== "verify" || !Number.isInteger(node.repair.maxRepairs) || node.repair.maxRepairs < 0 || node.repair.maxRepairs > 2 || !target || !["act", "delegate"].includes(target.kind) || target.irreversible || !target.writes?.length || !ancestors[node.id]!.has(target.id)) diagnostics.push({ check: "shape", message: `invalid repair contract on ${node.id}`, nodes: [node.id] });
	}
	const ordered = (u: string, v: string) => ancestors[v]!.has(u) || ancestors[u]!.has(v);

	// Closure: every precondition is provided by Init or an ancestor's postcondition.
	for (const id of order) {
		const node = byId.get(id)!;
		const provided: Predicate[] = [...(plan.init ?? [])];
		for (const a of ancestors[id]!) {
			provided.push({ kind: "node", id: a }, ...(byId.get(a)!.post ?? []));
		}
		for (const wanted of node.pre ?? []) {
			if (!provided.some((p) => satisfies(wanted, p))) {
				diagnostics.push({ check: "closure", message: `node "${id}" requires ${canonicalPredicate(wanted)} which no ancestor or Init provides`, nodes: [id] });
			}
		}
	}

	// Coverage: every goal requirement has a verify node.
	for (const req of plan.goal.requirements) {
		if (!plan.nodes.some((node) => node.kind === "verify" && (node.covers ?? []).includes(req))) {
			diagnostics.push({ check: "coverage", message: `requirement "${req}" has no verify node`, nodes: [] });
		}
	}

	// Race freedom: unordered nodes must not write what the other reads or writes.
	for (let i = 0; i < ids.length; i++) {
		for (let j = i + 1; j < ids.length; j++) {
			const u = byId.get(ids[i]!)!;
			const v = byId.get(ids[j]!)!;
			if (ordered(u.id, v.id)) continue;
			const conflict = (w: PlanNode, r: PlanNode) =>
				(w.writes ?? []).some((s) => [...(r.writes ?? []), ...(r.reads ?? [])].some((t) => scopesOverlap(s, t)));
			if (conflict(u, v) || conflict(v, u)) {
				diagnostics.push({ check: "race", message: `unordered nodes "${u.id}" and "${v.id}" touch overlapping scopes`, nodes: [u.id, v.id] });
			}
		}
	}

	// Verify dominance: every writer of a scope has a descendant verify that reads that scope.
	for (const node of plan.nodes) {
		for (const scope of node.writes ?? []) {
			const verified = plan.nodes.some((v) =>
				v.kind === "verify" && ancestors[v.id]!.has(node.id) && (v.reads ?? []).some((r) => scopesOverlap(r, scope)),
			);
			if (!verified) {
				diagnostics.push({ check: "verify-dominance", message: `node "${node.id}" writes "${scope}" without a downstream verify reading it`, nodes: [node.id] });
			}
		}
	}

	// Authority: an irreversible node is preceded by an ask.
	for (const node of plan.nodes) {
		if (node.irreversible && ![...ancestors[node.id]!].some((a) => byId.get(a)!.kind === "ask")) {
			diagnostics.push({ check: "authority", message: `irreversible node "${node.id}" has no ask ancestor`, nodes: [node.id] });
		}
	}

	// Certifying dominance. A requirement is certified by ANY succeeded verify node covering it, so verify
	// dominance (some downstream verifier exists) does not make that verifier necessary. With V(r) the verifiers of r
	// and C(e,s) the verifiers after e that read s: every irreversible e needs some r with V(r) ⊆ {e} ∪ desc(e), and every
	// write (e,s) needs some r whose every verifier is in C(e,s) or descends from one. Then verified ⇒ each effect
	// succeeded and each written scope was checked after its write; otherwise an execution certifies the goal first.
	const verifiersOf = (req: string) => plan.nodes.filter((n) => n.kind === "verify" && (n.covers ?? []).includes(req)).map((n) => n.id);
	const requirements = plan.goal.requirements;
	for (const effect of plan.nodes) {
		if (effect.irreversible && !requirements.some((req) => verifiersOf(req).every((v) => v === effect.id || ancestors[v]!.has(effect.id)))) {
			diagnostics.push({ check: "certifying-dominance", message: `irreversible node "${effect.id}" can be skipped: every requirement can also be certified by a verify node that does not run after it`, nodes: [effect.id] });
		}
		for (const scope of effect.writes ?? []) {
			const checks = new Set(plan.nodes.filter((v) => v.kind === "verify" && ancestors[v.id]!.has(effect.id) && (v.reads ?? []).some((r) => scopesOverlap(r, scope))).map((v) => v.id));
			if (checks.size === 0) continue; // already a verify-dominance diagnostic
			if (!requirements.some((req) => verifiersOf(req).every((v) => checks.has(v) || [...ancestors[v]!].some((a) => checks.has(a))))) {
				diagnostics.push({ check: "certifying-dominance", message: `node "${effect.id}" writes "${scope}" but every requirement can be certified without a verify that runs after it and reads "${scope}"`, nodes: [effect.id] });
			}
		}
	}

	// Pre-effect verification: an irreversible node runs only after every upstream write was read by a verify node
	// between the writer and the effect (a delegate's "succeeded" carries no verdict and gates nothing).
	for (const effect of plan.nodes) {
		if (!effect.irreversible) continue;
		for (const writer of [...ancestors[effect.id]!].sort()) {
			for (const scope of byId.get(writer)!.writes ?? []) {
				const readers = plan.nodes.filter((v) => v.kind === "verify" && ancestors[v.id]!.has(writer) && (v.reads ?? []).some((r) => scopesOverlap(r, scope)));
				if (!readers.length) continue; // already a verify-dominance diagnostic
				if (!readers.some((v) => ancestors[effect.id]!.has(v.id))) diagnostics.push({ check: "pre-effect-verification", message: `irreversible node "${effect.id}" can run before any verify reads "${scope}" written by "${writer}"`, nodes: [effect.id, writer] });
			}
		}
	}

	// Producer order: a non-verify node whose post declares req:r establishes r; every verifier of r must run after it.
	for (const producer of plan.nodes) {
		if (producer.kind === "verify") continue;
		for (const req of new Set((producer.post ?? []).flatMap((post) => post.kind === "req" ? [post.id] : []))) {
			for (const v of verifiersOf(req)) {
				if (!ancestors[v]!.has(producer.id)) diagnostics.push({ check: "producer-order", message: `verify node "${v}" certifies "${req}" but does not run after its producer "${producer.id}"`, nodes: [v, producer.id] });
			}
		}
	}

	if (diagnostics.length) return { ok: false, diagnostics };

	// Critical path by weighted longest path over the topological order.
	const cost = (id: string) => byId.get(id)!.cost ?? 1;
	const best = new Map<string, { cost: number; via?: string }>();
	for (const id of order) {
		let via: string | undefined;
		let incoming = 0;
		for (const parent of parents[id]!) {
			const c = best.get(parent)!.cost;
			if (c > incoming || via === undefined) { incoming = c; via = parent; }
		}
		best.set(id, { cost: incoming + cost(id), ...(via === undefined ? {} : { via }) });
	}
	let end = order[0];
	for (const id of order) if (end === undefined || best.get(id)!.cost > best.get(end)!.cost) end = id;
	const criticalPath: string[] = [];
	for (let cursor = end; cursor !== undefined; cursor = best.get(cursor)!.via) criticalPath.unshift(cursor);
	return {
		ok: true,
		compiled: {
			order, parents, children,
			ancestors: Object.fromEntries(ids.map((id) => [id, [...ancestors[id]!].sort()])),
			criticalPath,
			criticalCost: end === undefined ? 0 : best.get(end)!.cost,
			totalCost: ids.reduce((sum, id) => sum + cost(id), 0),
		},
	};
}

/** Nodes that are not terminal, not blocked, and whose parents all succeeded. */
export function readyNodes(compiled: CompiledPlan, succeeded: ReadonlySet<string>, blocked: ReadonlySet<string> = new Set()): string[] {
	return compiled.order.filter((id) =>
		!succeeded.has(id) && !blocked.has(id) && compiled.parents[id]!.every((p) => succeeded.has(p)),
	);
}

/** Transitive descendants, excluding the node itself. */
export function descendants(compiled: CompiledPlan, id: string): string[] {
	return compiled.order.filter((other) => other !== id && compiled.ancestors[other]!.includes(id));
}

/**
 * Content key of a node run: contract, parent keys and the facts it read. A changed answer or parent
 * result changes the key of exactly the node and its descendants.
 */
export function nodeKey(node: PlanNode, parentKeys: readonly string[], factIds: readonly string[] = []): string {
	const contract = {
		kind: node.kind,
		description: node.description ?? null,
		repair: node.repair ?? null,
		pre: (node.pre ?? []).map(canonicalPredicate).sort(),
		post: (node.post ?? []).map(canonicalPredicate).sort(),
		reads: [...(node.reads ?? [])].sort(),
		writes: [...(node.writes ?? [])].sort(),
		covers: [...(node.covers ?? [])].sort(),
		irreversible: node.irreversible ?? false,
		route: node.route ?? null,
	};
	return createHash("sha256")
		.update(JSON.stringify([node.id, contract, [...parentKeys].sort(), [...factIds].sort()]))
		.digest("hex");
}
