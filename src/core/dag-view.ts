import { frontier, MAX_NODE_ATTEMPTS, type RunState } from "./dag.ts";
import type { CompiledPlan } from "./plan.ts";
import type { DagNodeState, DagNodeView, DagView } from "./ui-contract.ts";

/**
 * Client projection of a DAG run (ADR 0032). Pure: no I/O, no clock.
 *
 * Layout is longest-path layering. level(v) = 0 for a source, else 1 + max level of its parents, so every edge
 * goes from a lower to a strictly higher level (rows read top to bottom in execution order) and each level is an
 * antichain (a wave that may run in parallel). The number of levels equals the number of nodes on the longest
 * chain, which by Mirsky's theorem is the fewest antichains any partition can use. Shown parents are the
 * transitive reduction: same reachability, fewest edges. Both depend only on the compiled plan.
 */

export type WaveLayout = { level: Record<string, number>; order: string[]; levels: number };

/** Longest-path levels and the display order (level, then compiled Kahn order). */
export function waveLayout(compiled: CompiledPlan): WaveLayout {
	const level: Record<string, number> = {};
	for (const id of compiled.order) {
		const parents = compiled.parents[id] ?? [];
		level[id] = parents.length === 0 ? 0 : 1 + Math.max(...parents.map((p) => level[p]!));
	}
	const kahn = new Map(compiled.order.map((id, index) => [id, index]));
	const order = [...compiled.order].sort((a, b) => level[a]! - level[b]! || kahn.get(a)! - kahn.get(b)!);
	const levels = compiled.order.length === 0 ? 0 : 1 + Math.max(...compiled.order.map((id) => level[id]!));
	return { level, order, levels };
}

/** Parents of `id` not reachable through another parent: the transitive reduction restricted to `id`. */
export function reducedParents(compiled: CompiledPlan, id: string): string[] {
	const parents = compiled.parents[id] ?? [];
	return parents.filter((p) => !parents.some((q) => q !== p && (compiled.ancestors[q] ?? []).includes(p)));
}

const TITLE_CHARS = 120;
const LINE_CHARS = 200;

/** First non-empty line cut to `limit` terminal columns (wide CJK characters count two), with `...` when cut. */
const firstLine = (text: string | undefined, limit: number): string => {
	const line = (text ?? "").split("\n").map((part) => part.trim()).find((part) => part !== "") ?? "";
	if (Bun.stringWidth(line) <= limit) return line;
	let kept = "";
	let used = 0;
	for (const char of line) {
		const width = Bun.stringWidth(char);
		if (used + width > limit - 3) break;
		kept += char;
		used += width;
	}
	return `${kept}...`;
};

function stateOf(run: RunState, id: string, ready: ReadonlySet<string>): DagNodeState {
	const status = run.nodes[id]?.status ?? "pending";
	if (status === "pending" || status === "ready") return ready.has(id) ? "ready" : "pending";
	return status;
}

export function dagView(run: RunState): DagView {
	const base = {
		id: run.id,
		revision: run.revision,
		status: run.status,
		...(!run.owner && run.semantics !== 2 ? { reason: `Legacy historical run; not strict verification proof.${run.reason ? ` ${run.reason}` : ""}` } : run.reason === undefined ? {} : { reason: run.reason }),
		replanBudget: run.replanBudget,
		requirements: run.plan.goal.requirements.map((id) => ({ id, certified: !!(run.owner || run.semantics === 2) && run.certified.includes(id) })),
		...(run.diagnostics?.length ? { diagnostics: run.diagnostics.map((d) => `${d.check}: ${d.message}`) } : {}),
		updatedAt: run.updatedAt,
	};
	const compiled = run.compiled;
	if (!compiled) return { ...base, levels: 0, nodes: [] };
	const layout = waveLayout(compiled);
	const position = new Map(layout.order.map((id, index) => [id, index]));
	const ready = new Set(frontier(run));
	const critical = new Set(compiled.criticalPath);
	const byId = new Map(run.plan.nodes.map((node) => [node.id, node]));
	const inOrder = (ids: readonly string[]) => [...ids].sort((a, b) => position.get(a)! - position.get(b)!);
	const nodes = layout.order.map((id): DagNodeView => {
		const node = byId.get(id)!;
		const state = run.nodes[id];
		const error = firstLine(state?.error, LINE_CHARS);
		const result = firstLine(state?.result, LINE_CHARS);
		return {
			id,
			kind: node.kind,
			title: firstLine(node.description, TITLE_CHARS),
			state: stateOf(run, id, ready),
			level: layout.level[id]!,
			parents: inOrder(reducedParents(compiled, id)),
			directParents: inOrder(compiled.parents[id] ?? []),
			attempt: state?.attempt ?? 0,
			// A failed node gets no further attempt, so its budget is the attempt it failed on (e.g. a rejected verify is 1/1).
			maxAttempts: state?.status === "failed" ? Math.max(1, state.attempt) : MAX_NODE_ATTEMPTS,
			...(state?.handle === undefined ? {} : { handle: state.handle }),
			...(state?.startedAt === undefined ? {} : { startedAt: state.startedAt }),
			...(state?.endedAt === undefined ? {} : { endedAt: state.endedAt }),
			...(error === "" ? {} : { error }),
			...(result === "" ? {} : { result }),
			covers: [...(node.covers ?? [])],
			critical: critical.has(id),
		};
	});
	return { ...base, levels: layout.levels, nodes };
}

/**
 * The shown run: the active one; without one, the latest attempt whose plan never compiled (dag_run stores it but
 * does not activate it), so its diagnostics stay visible. A later failed attempt never replaces an active run.
 */
export function activeDagView(doc: Readonly<{ runs: readonly RunState[]; activeId?: string }> | null | undefined): DagView | null {
	const active = doc?.activeId === undefined ? undefined : doc.runs.find((candidate) => candidate.id === doc.activeId);
	if (active) return dagView(active);
	const uncompiled = (doc?.runs ?? []).filter((run) => !run.compiled).reduce<RunState | undefined>((latest, run) => (latest === undefined || run.createdAt >= latest.createdAt ? run : latest), undefined);
	return uncompiled ? dagView(uncompiled) : null;
}
