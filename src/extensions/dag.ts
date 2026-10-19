import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { Type, type Models } from "@earendil-works/pi-ai";
import { type ConversationId, defineExtension, defineTool, LiveDoc, section, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { AUTHORITY_DEFAULT, type AskRecord, AsksDoc, askId, describeAsk, expireAsks, HUMAN_DEADLINE_MS, openAsksFrom, resolveAsk } from "../core/ask.ts";
import {
	askNodeKeys, askNodeRefs, cancel, closeSettledNode, createRun, DagSeenDoc, fail, failUndispatched, frontier, nodeOf, replan, resolveAskNode, resume, retryVerifier, reviseFact, RunDoc,
	type RunState, runStateKey, start, succeed, summarize, waiting, settleRepairs,
} from "../core/dag.ts";
import { dagAnswerScope, dagDisplayInputs, selectAnswerDag, terminalDag } from "../core/dag-scope.ts";
import { dagPrompt } from "../core/dag-verification.ts";
import type { Plan, PlanNode } from "../core/plan.ts";
import { WorkDoc, syncGoalHeadTx, assertGoalAdmissionTx, type WorkService } from "../core/verification.ts";
import { clone } from "../core/json.ts";
import { cleanupOwnerClaimsTx } from "../core/claim-cleanup.ts";
import { AgentsDoc, ProgressDoc, resolveModel, type SubagentSpawner } from "./subagents.ts";

export const DAG_RUN_TOOL = "dag_run";
export const DAG_STEP_TOOL = "dag_step";
export const DAG_STATUS_TOOL = "dag_status";
const text = (value: string, isError = false) => ({ isError, content: [{ type: "text" as const, text: value }] });
const ownedError = "Research-owned run: use research_status or research_cancel; only the mission controller may advance it.";

const predicate = Type.Union([
	Type.Object({ kind: Type.Literal("file"), path: Type.String({ minLength: 1 }), hash: Type.Optional(Type.String()) }, { additionalProperties: false }),
	Type.Object({ kind: Type.Literal("check"), id: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
	Type.Object({ kind: Type.Literal("fact"), id: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
	Type.Object({ kind: Type.Literal("node"), id: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
	Type.Object({ kind: Type.Literal("req"), id: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
]);
const planSchema = Type.Object({
	nodes: Type.Array(Type.Object({
		id: Type.String({ minLength: 1, maxLength: 64 }),
		kind: Type.Union(["act", "delegate", "verify", "ask", "expand"].map((k) => Type.Literal(k))),
		description: Type.Optional(Type.String({ maxLength: 4000 })), pre: Type.Optional(Type.Array(predicate)), post: Type.Optional(Type.Array(predicate)),
		reads: Type.Optional(Type.Array(Type.String({ minLength: 1 }))), writes: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
		covers: Type.Optional(Type.Array(Type.String({ minLength: 1 }))), irreversible: Type.Optional(Type.Boolean()),
		repair: Type.Optional(Type.Object({ predecessorId: Type.String({ minLength: 1 }), maxRepairs: Type.Integer({ minimum: 0, maximum: 2 }) }, { additionalProperties: false })),
		cost: Type.Optional(Type.Number({ minimum: 0 })), route: Type.Optional(Type.String({ description: "Subagent model: provider/modelId, a bare modelId (orchestrator's provider) or inherit; omit to inherit the orchestrator's model at dispatch. Unknown models are rejected; accepted routes are pinned to provider/modelId at admission." })),
	}, { additionalProperties: false }), { maxItems: 256 }),
	edges: Type.Array(Type.Array(Type.String(), { minItems: 2, maxItems: 2 }), { maxItems: 4096 }),
	goal: Type.Object({ requirements: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }) }, { additionalProperties: false }),
	init: Type.Optional(Type.Array(predicate)),
}, { additionalProperties: false });

export type DagApi = Pick<ToolExecutionApi, "commit" | "snapshot" | "conversationId">;

/**
 * Tool APIs the host's own scheduler builds (dag-continuation). A dag_step it runs is not seen by the model, so it must
 * not update {@link DagSeenDoc}; every other caller is a model tool call (direct or codemode).
 */
export const HOST_DRIVEN: WeakSet<object> = new WeakSet();

/** Records the run state a model-visible DAG tool result shows (ADR 0096). Research-owned runs have their own reporting. */
async function markSeen(api: DagApi, run: RunState | undefined, context: Context, asks: readonly string[] = []): Promise<void> {
	if (!run || run.owner || HOST_DRIVEN.has(api)) return;
	const key = runStateKey(run);
	await api.commit(async (tx) => {
		const doc = await tx.doc(DagSeenDoc, api.conversationId);
		if (doc.seen[run.id] !== key) doc.seen[run.id] = key;
		const fresh = asks.filter((id) => !(doc.asks ?? []).includes(id));
		if (fresh.length) doc.asks = [...(doc.asks ?? []), ...fresh].slice(-256);
		return undefined;
	}, context);
}

/**
 * A node's `route` becomes the spawned subagent's `model` at dispatch, resolved against the conversation's CURRENT
 * agent model. Validate it at plan admission with the same resolveModel the spawner uses, so a bad route fails the
 * compile with a clear message instead of surfacing later as the dispatched subagent's `no_model` failure; then pin
 * every accepted route to its qualified `provider/modelId` in the stored plan, so a later /model switch cannot
 * re-resolve a bare route against a different provider at dispatch time.
 */
async function normalizeRoutes(plan: Plan, api: ToolExecutionApi, models: Models, context: Context): Promise<{ problems: string[]; plan: Plan }> {
	const routed = plan.nodes.filter((node) => typeof node.route === "string" && node.route !== "");
	if (routed.length === 0) return { problems: [], plan };
	const parent = (await api.agent(context)).model;
	const problems: string[] = [];
	const pinned = new Map<string, string>();
	for (const node of routed) {
		const route = node.route!;
		let ref;
		try {
			ref = resolveModel(route, parent);
		} catch (error) {
			problems.push(`node "${node.id}": route "${route}": ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		if (ref === undefined) {
			problems.push(`node "${node.id}": route "${route}" inherits the orchestrator model, but none is configured`);
			continue;
		}
		if (!models.getModel(ref.provider, ref.modelId)) {
			problems.push(`node "${node.id}": route "${route}" resolves to ${ref.provider}/${ref.modelId}, which is not a configured model`);
			continue;
		}
		pinned.set(node.id, `${ref.provider}/${ref.modelId}`);
	}
	if (problems.length > 0 || pinned.size === 0) return { problems, plan };
	return { problems, plan: { ...plan, nodes: plan.nodes.map((node) => (pinned.has(node.id) ? { ...node, route: pinned.get(node.id)! } : node)) } };
}
export type DagOutcome = { handle?: string; key?: string | undefined; attempt?: number; id: string; status: "completed" | "failed" | "cancelled"; answer?: string; error?: string };
/** Host callbacks own admission and effects; this function alone owns frontier traversal. */
export type DagAdvanceHooks = {
	/** Required for owned runs; omitted for ordinary tools. Not a public tool parameter. */
	missionId?: string;
	/** Reserve durable budget before dispatch; false leaves this node pending. */
	admit?: (run: RunState, node: PlanNode, context: Context) => Promise<boolean>;
	dispatch: (run: RunState, node: PlanNode, context: Context) => Promise<void>;
	/** Owned outcomes must be validated and settled by the host, never by child prose. */
	settle?: (run: RunState, outcomes: readonly DagOutcome[], context: Context) => Promise<void>;
};

export async function activeDag(api: DagApi, context: Context, runId?: string): Promise<RunState | undefined> {
	const doc = await api.snapshot(RunDoc, api.conversationId, context);
	return doc?.runs.find((run) => run.id === (runId ?? doc.activeId));
}
export async function assertDagGoalTx(tx: import("@earendil-works/pi-durable").Tx, conversationId:ConversationId, run:RunState):Promise<void> {
 await assertGoalAdmissionTx(tx,conversationId);
 const sourceId=run.goalBinding?.conversationId?Number(run.goalBinding.conversationId) as ConversationId:conversationId;const state=await tx.doc(WorkDoc,sourceId);await syncGoalHeadTx(tx,sourceId,state);const goal=state.goal;
 if((goal && !run.goalBinding) || (run.goalBinding && (goal?.epoch!==run.goalBinding.epoch || goal.hash!==run.goalBinding.hash))) throw new Error("stale_goal_admission_epoch");
}
/** Admission is checked in the same transaction as scheduler ownership/settlement. Never adopt a new epoch for legacy history. */
export async function admitDagTx(tx: import("@earendil-works/pi-durable").Tx, conversationId:ConversationId, run:RunState):Promise<boolean> {
 try { await assertDagGoalTx(tx,conversationId,run); return true; }
 catch(error) {
  if(!(error instanceof Error) || error.message!=="stale_goal_admission_epoch") throw error;
  // Terminal history remains terminal. Only live history is quarantined, with nodes and obligations intact.
  if(run.status!=="cancelled" && run.status!=="verified") {
   run.status="blocked";run.reason="stale_goal_admission_epoch; candidate and historical outcomes preserved";run.updatedAt=Date.now();
  }
  return false;
 }
}
export async function mutateDag<T>(api: DagApi, runId: string, context: Context, change: (run: RunState, now: number) => T): Promise<T> {
	return api.commit(async (tx) => {
		const doc = await tx.doc(RunDoc, api.conversationId);
		const run = doc.runs.find((r) => r.id === runId);
		if (!run) throw new Error(`Unknown run ${runId}`);
        await assertDagGoalTx(tx,api.conversationId,run);
		return change(run, Date.now());
	}, context);
}
export async function reconcileDag(api: DagApi, run: RunState, context: Context): Promise<DagOutcome[]> {
	const agents = (await api.snapshot(AgentsDoc, api.conversationId, context))?.agents ?? [];
	const outcomes: DagOutcome[] = [];
	for (const [id, state] of Object.entries(run.nodes)) {
		if ((state.status !== "running" && state.status !== "waiting") || !state.handle?.startsWith("sa-")) continue;
		const ref = agents.find((a) => a.taskId === state.handle);
		if (!ref || state.runnerId && state.runnerId !== String(ref.runnerId)) { outcomes.push({ id, handle: state.handle, key: state.key, attempt: state.attempt, status: "failed", error: "subagent record missing" }); continue; }
		const progress = await api.snapshot(ProgressDoc, api.conversationId, String(ref.runnerId), context);
		const status = progress?.subagent?.status;
		if (status === "completed") outcomes.push({ id, handle: state.handle, key: state.key, attempt: state.attempt, status, answer: progress?.answer ?? "" });
		else if (status === "failed" || status === "cancelled") outcomes.push({ id, handle: state.handle, key: state.key, attempt: state.attempt, status, error: progress?.subagent?.error ?? status });
	}
	return outcomes;
}

type AsksState = Readonly<{ asks: readonly AskRecord[] }> | null | undefined;

/** Binds the resolved asks of node subagents as facts of the asking node (a late answer revises the fact). */
function bindAskFacts(r: RunState, asksDoc: AsksState, now: number): void {
	for (const ask of asksDoc?.asks ?? []) {
		if (ask.state === "open" || !ask.from.taskId) continue;
		const node = Object.entries(r.nodes).find(([, s]) => s.handle === ask.from.taskId)?.[0];
		if (!node) continue;
		const state = r.nodes[node]!;
		const first = !state.facts.includes(ask.id);
		const bound = state.binding?.key === state.key;
		if (first) state.facts.push(ask.id);
		reviseFact(r, ask.id, ask.late?.answer ?? ask.answer ?? ask.default, now);
		// The executing child read its own first answer, not a changed dispatch input. Bind that
		// read once; subsequent revisions and already-stale parent/key bindings remain fenced.
		if (first && !ask.late && bound && state.binding && (state.status === "running" || state.status === "waiting")) state.binding.key = state.key!;
	}
}

const APPROVALS = new Set(["approve", "approved", "allow", "allowed", "yes", "승인", "허용"]);
/** An explicit approval word. Anything else, including qualified prose, is not a grant. */
export function isApproval(answer: string | undefined): boolean {
	return APPROVALS.has((answer ?? "").trim().toLowerCase().replace(/^["'`“‘]+|["'`”’.!。]+$/g, ""));
}

/**
 * The ask record that resolves ask node `id` (ADR 0030: the orchestrator resolves ask nodes). With irreversible
 * descendants it is a human authority ask over exactly those nodes and contracts; otherwise the orchestrator's decision.
 * Reuse is limited to records of this run that are still open or are a human approval of the same contracts, and that
 * saw the same upstream state: explicit node/key/goal bindings captured at creation. Ambiguous and legacy
 * orchestrator records remain unresolved for this gate. Every new record has a unique question per run, revision and dispatch.
 */
export function askNodeRecord(asks: { asks: AskRecord[] }, r: RunState, id: string, main: ConversationId, now: number): NonNullable<RunState["nodes"][string]["ask"]> {
	const refs = askNodeRefs(r, id);
	const keys = askNodeKeys(r, refs);
	if (refs.length) {
		const claimed = new Set(Object.entries(r.nodes).flatMap(([other, s]) => other !== id && s.ask ? [s.ask.id] : []));
		const sameContracts = (a: AskRecord) => refs.every((ref, i) => {
			const at = a.refs.indexOf(ref);
			return at >= 0 && a.keys?.[at] === keys[i];
		});
		const reusable = (a: AskRecord) => a.state === "open" || (a.state === "answered" && a.resolvedBy?.startsWith("human:") === true && isApproval(a.answer));
		// Both native and orchestrator questions need explicit node/key/goal proof. Timestamps cannot upgrade legacy approval.
		const sameUpstream = (a: AskRecord) => a.node === id && a.nodeKey === r.nodes[id]!.key
            && JSON.stringify(a.goalBinding ?? null) === JSON.stringify(r.goalBinding ?? null);
		const linked = asks.asks
			.filter((a) => a.to === "human" && a.kind === "authority" && a.run === r.id && !claimed.has(a.id) && reusable(a) && sameContracts(a) && sameUpstream(a))
			.sort((a, b) => b.createdAt - a.createdAt)[0];
		if (linked) return { id: linked.id, refs, keys };
	}
	const node = nodeOf(r, id);
	const base = node.description?.trim() || (refs.length ? `Approve running ${refs.join(", ")}?` : `Decide plan node ${id}.`);
	const question = `${base}\n(plan node ${id} of run ${r.id}, revision ${r.revision}, dispatch ${r.nodes[id]!.runs})`;
	const kind = refs.length ? "authority" as const : "decision" as const;
	// The id also binds the node's key, and never collides with an existing record (which reuse above did not choose).
	let recordId = askId(main, main, kind, refs.length ? refs : [id], `${question}\n[node key ${r.nodes[id]!.key ?? ""}]`);
	for (let n = 1; asks.asks.some((a) => a.id === recordId); n++) recordId = askId(main, main, kind, refs.length ? refs : [id], `${question}\n[node key ${r.nodes[id]!.key ?? ""}]#${n}`);
	const record: AskRecord = {
		id: recordId,
		from: { conversationId: main }, to: refs.length ? "human" : "main", kind, refs: refs.length ? refs : [id], question,
		...(refs.length ? { options: ["approve", "deny"], keys } : {}),
		default: refs.length ? AUTHORITY_DEFAULT : "no decision",
		createdAt: now, deadlineAt: now + HUMAN_DEADLINE_MS, state: "open", run: r.id, node: id,
		...(r.nodes[id]!.key ? { nodeKey: r.nodes[id]!.key } : {}),
        ...(r.goalBinding ? {goalBinding:clone(r.goalBinding)} : {}),
	};
	asks.asks.push(record);
	return { id: record.id, refs, keys };
}

/**
 * Settles ask nodes whose record is resolved. Authority is granted only by a human answer that is an explicit approval;
 * a refusal, a default (deny) or a withdrawal fails the node without retry. A decision node takes the orchestrator's
 * answer; a decision that only defaulted fails. Returns whether any node settled.
 */
function settleAskNodes(r: RunState, asks: { asks: AskRecord[] }, main: ConversationId, now: number): boolean {
	let settled = false;
	for (const [id, state] of Object.entries(r.nodes)) {
		if (r.status !== "running") break;
		if ((state.status !== "waiting" && state.status !== "running") || nodeOf(r, id).kind !== "ask") continue;
		const link = state.ask ??= askNodeRecord(asks, r, id, main, now);
		const record = asks.asks.find((a) => a.id === link.id);
		if (!record || record.state === "open") continue;
		const authority = link.refs.length > 0;
		const answer = record.answer ?? record.default;
		const by = record.resolvedBy ? ` by ${record.resolvedBy}` : "";
		const granted = record.state === "answered" && (!authority || (record.resolvedBy?.startsWith("human:") === true && isApproval(answer)));
		const result = authority
			? granted ? `authority granted${by} for ${link.refs.join(", ")}: ${answer}` : `authority not granted (${record.state}${by}: ${answer})`
			: granted ? `decision${by}: ${answer}` : `no decision (${record.state}${by}: ${answer})`;
		resolveAskNode(r, id, { granted, result }, now);
		settled = true;
	}
	return settled;
}

/** Open records of ask nodes still waiting for an answer, for the orchestrator's next action. */
function pendingAskNodes(r: RunState, asks: AsksState): { node: string; ask: AskRecord }[] {
	return Object.entries(r.nodes).flatMap(([node, s]) => {
		const ask = s.ask && (s.status === "waiting" || s.status === "running") ? asks?.asks.find((a) => a.id === s.ask!.id && a.state === "open") : undefined;
		return ask ? [{ node, ask: clone(ask) as AskRecord }] : [];
	});
}

/** Settles delivered child outcomes into a running ordinary run. */
function applyOutcomes(r: RunState, outcomes: readonly DagOutcome[], now: number): void {
	for (const o of outcomes) {
		// A verified/cancelled run certifies nothing new; its remaining nodes are closed by closeTerminalDag.
		if (r.status === "cancelled" || r.status === "verified") return;
		const s = r.nodes[o.id];
		if (!s || s.handle !== o.handle || s.key !== o.key || s.attempt !== o.attempt) continue;
		if (s.status !== "running" && s.status !== "waiting") continue;
		const terminal = o.status === "cancelled" || o.error === "subagent record missing";
		if (o.status === "completed" && s.effectRefusal) fail(r, o.id, s.effectRefusal, now);
		else if (o.status === "completed" && s.effect && s.effect.phase !== "receipt") fail(r, o.id, "managed effect ACK unknown; reconcile, never replay", now, true);
		else if (o.status === "completed") succeed(r, o.id, o.answer ?? "", now, true);
		// A verifier whose executor failed before answering delivered no judgment: retry it instead of rejecting the artifact.
		else if (!terminal && !r.owner && nodeOf(r, o.id).kind === "verify") retryVerifier(r, o.id, `verifier executor failed before a verdict: ${o.error ?? o.status}`, now);
		else fail(r, o.id, o.error ?? o.status, now, o.status === "cancelled" || o.error === "subagent record missing");
	}
	settleRepairs(r, now);
}

/**
 * Terminal closure of an ordinary run: every running/waiting node whose executor has settled is closed, so a
 * cancelled or verified run converges to having no running node. Unsettled executors stay visible as running.
 */
export async function closeTerminalDag(api: DagApi, runId: string, context: Context): Promise<RunState> {
	const run = await activeDag(api, context, runId);
	if (!run) throw new Error(`Unknown run ${runId}`);
	if (run.owner || (run.status !== "cancelled" && run.status !== "verified")) return run;
	const outcomes = await reconcileDag(api, run, context);
	// An ask node still waiting when the run ends has nothing to decide any more: close it and withdraw its question.
	const askNodes = Object.entries(run.nodes).filter(([id, s]) => (s.status === "running" || s.status === "waiting") && nodeOf(run, id).kind === "ask").map(([id]) => id);
	// Cleanup is replayed even after all nodes closed; settlement can precede child tool/task quiescence.
	return api.commit(async (tx) => {
		const asks = await tx.doc(AsksDoc, api.conversationId);
		const r = (await tx.doc(RunDoc, api.conversationId)).runs.find((x) => x.id === runId)!;
		const now = Date.now();
		if (r.owner || (r.status !== "cancelled" && r.status !== "verified")) return clone(r) as RunState;
		for (const o of outcomes) {
			const s = r.nodes[o.id];
			if (!s || s.handle !== o.handle || s.attempt !== o.attempt || (s.status !== "running" && s.status !== "waiting")) continue;
			closeSettledNode(r, o.id, o, now);
		}
		for (const id of askNodes) {
			const s = r.nodes[id]!;
			if (s.status !== "running" && s.status !== "waiting") continue;
			if (s.ask) resolveAsk(asks, s.ask.id, { state: "withdrawn", by: `system:dag-${r.status}`, now });
			closeSettledNode(r, id, { status: "completed", answer: `run ${r.status} before this ask was answered` }, now);
		}
		const agents = await tx.doc(AgentsDoc, api.conversationId);
		for (const [id, s] of Object.entries(r.nodes)) {
			const ref = agents.agents.find(a => a.taskId === s.handle && String(a.runnerId) === s.runnerId);
			if (ref && s.status !== "running" && s.status !== "waiting") await cleanupOwnerClaimsTx(tx, ref.conversationId, r.id, id, s);
		}
		return clone(r) as RunState;
	}, context);
}

/** Shared scheduler seam. Owned hooks must recheck mission epoch/deadline in their effect transactions. */
export async function advanceDag(api: DagApi, runId: string, context: Context, hooks: DagAdvanceHooks) {
	let run = await activeDag(api, context, runId);
	if (!run) throw new Error(`Unknown run ${runId}`);
	if(!run.owner) {
        const stale=await api.commit(async tx=>{const r=(await tx.doc(RunDoc,api.conversationId)).runs.find(r=>r.id===runId)!;return !await admitDagTx(tx,api.conversationId,r);},context);
        if(stale) return {run:(await activeDag(api,context,runId))!,asks:[],askNodes:[],dispatched:[] as string[]};
    }
    if (run.owner ? run.owner.missionId !== hooks.missionId || !hooks.admit || !hooks.settle : hooks.missionId !== undefined) throw new Error(ownedError);
	if (run.status === "cancelled" || run.status === "verified") return { run: run.owner ? run : await closeTerminalDag(api, runId, context), asks: [], askNodes: [], dispatched: [] as string[] };
	// Bind answered asks and settle ask nodes BEFORE reading child outcomes: binding changes node keys, so outcomes
	// captured afterwards carry the current keys and one dag_step settles both the answer and the child's result.
	const settleAsks = () => api.commit(async (tx) => {
		const asks = await tx.doc(AsksDoc, api.conversationId);
		const r = (await tx.doc(RunDoc, api.conversationId)).runs.find((x) => x.id === runId)!;
        await assertDagGoalTx(tx,api.conversationId,r);
		const now = Date.now();
		expireAsks(asks, now);
		let settled = false;
		// A late answer may reopen a blocked run, so facts are bound in blocked runs too; ask nodes settle only while running.
		if (r.status === "running" || r.status === "blocked") bindAskFacts(r, asks, now);
		if (r.status === "running") settled = settleAskNodes(r, asks, api.conversationId, now);
		return { run: clone(r) as RunState, settled };
	}, context);
	if (!run.owner) run = (await settleAsks()).run;
	const outcomes = await reconcileDag(api, run, context);
	const asksDoc = await api.snapshot(AsksDoc, api.conversationId, context);
	if (run.owner) {
		await hooks.settle!(run, outcomes, context);
		run = (await activeDag(api, context, runId))!;
	} else {
		run = await mutateDag(api, runId, context, (r, now) => { applyOutcomes(r, outcomes, now); return clone(r); });
	}
	const handles = new Map(Object.entries(run.nodes).filter(([, s]) => s.handle).map(([id, s]) => [s.handle!, id]));
	const agents = (await api.snapshot(AgentsDoc, api.conversationId, context))?.agents ?? [];
	const open = openAsksFrom(asksDoc, new Set(agents.filter((a) => handles.has(a.taskId)).map((a) => a.conversationId)));
	if (!run.owner) run = await mutateDag(api, runId, context, (r, now) => {
		if (open.length) {
			for (const ask of open) { const node = handles.get(ask.from.taskId ?? ""); if (node) waiting(r, node, now); }
		} else for (const [id, s] of Object.entries(r.nodes)) if (s.status === "waiting" && nodeOf(r, id).kind !== "ask") resume(r, id, now);
		return clone(r);
	});
	const dispatched: string[] = [];
	// An ask node can resolve at dispatch (it reuses an answered authority ask), which readies its children: repeat
	// dispatch while ask settlement makes progress. Each round settles at least one node, so this is bounded.
	for (let round = 0; round <= run.plan.nodes.length; round++) {
		for (const id of frontier(run)) {
			run = (await activeDag(api, context, runId))!;
			if (!frontier(run).includes(id)) continue;
			const node = nodeOf(run, id);
			if (hooks.admit && !await hooks.admit(run, node, context)) continue;
			await hooks.dispatch(run, node, context);
			dispatched.push(id);
		}
		run = (await activeDag(api, context, runId))!;
		if (run.owner || run.status !== "running") break;
		const after = await settleAsks();
		run = after.run;
		if (!after.settled) break;
	}
	// A run that became verified with a still-running sibling closes it once that executor has settled.
	if (!run.owner && run.status === "verified") run = await closeTerminalDag(api, runId, context);
	const askNodes = run.owner ? [] : pendingAskNodes(run, await api.snapshot(AsksDoc, api.conversationId, context));
	return { run, asks: open, askNodes, dispatched };
}

/**
 * Ordinary cancellation: record outcomes children already delivered (a verifier's FAIL verdict is evidence),
 * abort children still executing, enter the terminal state, then close every node whose executor has settled.
 */
export async function cancelDag(api: DagApi, runId: string, reason: string, spawner: SubagentSpawner | undefined, context: Context): Promise<{ run: RunState; unstopped: string[] }> {
	let run = await activeDag(api, context, runId);
	if (!run) throw new Error(`Unknown run ${runId}`);
	if (run.owner) throw new Error(ownedError);
    run=await api.commit(async tx=>{
        const r=(await tx.doc(RunDoc,api.conversationId)).runs.find(r=>r.id===runId)!;
        if(await admitDagTx(tx,api.conversationId,r) && r.status==="running") bindAskFacts(r,await tx.doc(AsksDoc,api.conversationId),Date.now());
        return clone(r) as RunState;
    },context);
    const outcomes=await reconcileDag(api,run,context);
    // Commit the fence before awaiting executor cancellation. Controls stay usable for stale candidates,
    // including a handoff between the two settlement transactions. Stale outcomes certify nothing.
    run=await api.commit(async tx=>{
        const asks=await tx.doc(AsksDoc,api.conversationId);const r=(await tx.doc(RunDoc,api.conversationId)).runs.find(r=>r.id===runId)!;const now=Date.now();
        if(await admitDagTx(tx,api.conversationId,r) && r.status==="running") applyOutcomes(r,outcomes,now);
        for(const s of Object.values(r.nodes)) if(s.ask && (s.status==="waiting" || s.status==="running")) resolveAsk(asks,s.ask.id,{state:"withdrawn",by:"system:dag-cancel",now});
        cancel(r,reason,now);
        const refs=(await tx.doc(AgentsDoc,api.conversationId)).agents;
        for(const [id,s] of Object.entries(r.nodes)){const ref=refs.find(a=>a.taskId===s.handle && String(a.runnerId)===s.runnerId);if(ref)await cleanupOwnerClaimsTx(tx,ref.conversationId,r.id,id,s);}
        return clone(r) as RunState;
    },context);
	const agents = (await api.snapshot(AgentsDoc, api.conversationId, context))?.agents ?? [];
	const unstopped: string[] = [];
	// Children are stopped even when delivered outcomes just verified the run: the operator asked to stop work.
	for (const [id, state] of Object.entries(run.nodes)) {
		if ((state.status !== "running" && state.status !== "waiting") || !state.handle?.startsWith("sa-")) continue;
		const ref = agents.find((a) => a.taskId === state.handle);
		if (!ref) continue; // reconciliation records a missing executor as unknown effects
		try {
			if (!spawner) throw new Error("subagent spawner is unavailable");
			await spawner.cancel(ref);
		} catch (error) {
			unstopped.push(`${id} (${state.handle}): ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return { run: await closeTerminalDag(api, runId, context), unstopped };
}

const scored = new Set<string>();
export function dagExtension(work: WorkService, spawner: { current?: SubagentSpawner }, models: Models, onOutcome?: (conversationId: ConversationId, outcome: "verified" | "blocked", context: Context) => Promise<unknown>) {
	return defineExtension({
		name: "dag",
		sections: [section("dag_protocol", async ({ conversationId, read }, context) => {
			const doc = await read.snapshot(RunDoc, conversationId, context);
			let run = doc?.runs.find((r) => r.id === doc.activeId);
            // Sections precede verification.beforeRequest. Materialize the existing
            // host input journal first for legacy scope, through its unchanged
            // acceptance/epoch checks; never infer or rewrite DAG authority.
            if (run && !run.owner && terminalDag(run) && !run.sourceIds?.length) await work.reconcileSources(conversationId, [], context);
            const inputs = ((await read.snapshot(LiveDoc, conversationId, context))?.run?.inputs ?? []).map(String);
            run = selectAnswerDag(doc, dagDisplayInputs(inputs, await read.snapshot(WorkDoc, conversationId, context)));
            const scope = run && terminalDag(run) && !run.owner ? dagAnswerScope(run, inputs, await read.snapshot(WorkDoc, conversationId, context)) : undefined;
            const historical = scope === "history";
			return [
				"DAG orchestration (ADR 0030): use DAG for multi-step work. dag_run compiles a finite plan (acyclic, closure, coverage, Bernstein race freedom, verify dominance, certifying dominance, pre-effect verification, producer order, authority). dag_step settles children and dispatches ready nodes as subagents or registered work checks. Answer open asks then step again. Research-owned runs are controlled only through research_status/research_cancel, never generic DAG mutations.",
				"A requirement is certified by any passing verify node that covers it, so give every effect (writes or irreversible) a requirement that only verify nodes after it cover, put a verify node that reads each upstream write between it and any irreversible node, and declare post req:<id> on the node that establishes a requirement (its verifiers must run after it). An ask node opens an ask record when dispatched: with irreversible descendants it is a human authority ask (relay it, then answer approve or deny with the human's quote); otherwise it is your own decision (answer it yourself). Step again after answering.",
				"For complex or long-running work, decompose as finely as practical into small independently verifiable units, each with explicit scope, dependencies and completion criteria. Separate implementation act/delegate nodes from read-only verify nodes for each meaningful unit; connect implementation -> verification -> dependent work so consumers use verified results. Do not defer all validation to one final mega-step; retain final integration verification as well. Avoid meaningless overfragmentation and obey finite node limits (at most 256 nodes per plan).",
				"Contracts use file/check/fact/node/req predicates; natural language belongs in description. Declare reads/writes scopes. Irreversible actions need an ask ancestor. Replan with dag_run({plan, run_id}) only by extending the goal within the finite budget.",
				"Terminal DAG history is queryable with dag_status({run_id}) and is not the status of a later unrelated input. Do not prepend historical cancellation/completion warnings to an ordinary answer or treat model prose as a completion receipt.",
				...(run && !historical ? [`${run.id === doc?.activeId ? "Active run:" : "Current input run (inactive; use explicit run_id):"}\n${summarize(run)}`] : []),
			].join("\n");
		})],
		tools: [
			defineTool({
				name: DAG_RUN_TOOL,
				description: "Compile a plan and create a run, or replan an existing run (run_id). Replans retain requirements and consume finite budget.",
				parameters: Type.Object({ plan: planSchema, run_id: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })), replan_budget: Type.Optional(Type.Integer({ minimum: 0, maximum: 64 })) }, { additionalProperties: false }),
				replay: "safe", executionMode: "sequential",
				execute: async ({ plan, run_id, replan_budget }, api, context) => {
					await work.reconcileSources(api.conversationId,[],context);
                    await work.assertGoalAdmission(api.conversationId,context);
                    const admission = await normalizeRoutes(plan as unknown as Plan, api, models, context);
                    if (admission.problems.length > 0) return text(`plan rejected: ${admission.problems.join("; ")}`, true);
                    const admittedPlan = admission.plan;
                    // Schema validation guarantees string pairs; Type.Array only infers string[][].
					const result = await api.commit(async (tx) => {
						const doc = await tx.doc(RunDoc, api.conversationId);
						if (doc.runs.some((r) => r.owner && r.status !== "cancelled" && r.status !== "verified" && (r.id === doc.activeId || r.id === run_id))) return { error: ownedError };
						if (run_id) {
							const run = doc.runs.find((r) => r.id === run_id);
							if (!run) return { error: `Unknown run ${run_id}` };
							if (run.owner) return { error: ownedError };
							await assertDagGoalTx(tx,api.conversationId,run);
                            const outcome = replan(run, admittedPlan, Date.now());
							// The run the orchestrator just replanned is the one it works on; a run that was blocked at
							// creation never became active, so this is also where it first does.
							if (outcome.ok) {
                                doc.activeId = run.id;
                                run.displaySourceIds = [...new Set([...(run.displaySourceIds ?? []), ...((await tx.doc(LiveDoc, api.conversationId)).run?.inputs ?? []).map(String)])];
                            }
							return outcome.ok ? { run: clone(run), invalidated: outcome.invalidated } : { error: outcome.reason, diagnostics: outcome.diagnostics, run: clone(run) };
						}
						const id = `dag-${createHash("sha256").update(`${api.conversationId}:${api.callId}`).digest("hex").slice(0, 12)}`;
						const existing = doc.runs.find((r) => r.id === id);
						if (existing) return existing.owner ? { error: ownedError } : { run: clone(existing) };
						const run = createRun(id, admittedPlan, Date.now(), replan_budget);
                        run.sourceIds = ((await tx.doc(LiveDoc, api.conversationId)).run?.inputs ?? []).map(String);
                        const goal=(await tx.doc(WorkDoc,api.conversationId)).goal;
                        if(goal) run.goalBinding={epoch:goal.epoch,hash:goal.hash};
                        else {const parent=(await tx.doc(WorkDoc,api.conversationId)).goalParent;if(parent)run.goalBinding={...parent};}
						doc.runs.push(run);
						if (run.status !== "blocked") doc.activeId = id;
						return { run: clone(run) };
					}, context);
					if (result.error && !result.run) return text(result.error, true);
					const run = result.run!;
					await markSeen(api, run, context);
					const body = [summarize(run), ...(result.error ? [`replan rejected: ${result.error}`, ...(result.diagnostics ?? []).map((d) => `  ✗ ${d.check}: ${d.message}`)] : []), ...(result.invalidated?.length ? [`invalidated: ${result.invalidated.join(", ")}`] : [])].join("\n");
					return { isError: result.error !== undefined || run.status === "blocked", content: [{ type: "text", text: body }], details: { run } };
				},
			}),
			defineTool({
				name: DAG_STEP_TOOL,
				description: "Advance the active run: settle subagents, surface asks, dispatch ready nodes. cancel:true cancels an ordinary run.",
				parameters: Type.Object({ run_id: Type.Optional(Type.String()), cancel: Type.Optional(Type.Boolean()), reason: Type.Optional(Type.String()) }, { additionalProperties: false }),
				replay: "safe", executionMode: "sequential",
				execute: async ({ run_id, cancel: cancelled, reason }, api, context) => {
					let run = await activeDag(api, context, run_id);
					if (!run) return text("No active run. Create one with dag_run.", true);
					if (run.owner) return text(ownedError, true);
					const runId = run.id;
					if (cancelled) {
						const result = await cancelDag(api, runId, reason ?? "cancelled by orchestrator", spawner.current, context);
						run = result.run;
						await markSeen(api, run, context);
						const lines = [summarize(run), ...result.unstopped.map((u) => `  ! child not confirmed stopped: ${u}`)];
						return { content: [{ type: "text", text: lines.join("\n") }], details: { run } };
					}
					const result = await advanceDag(api, runId, context, { dispatch: async (current, node) => {
						const id = node.id;
						if (node.kind === "ask") {
							// The orchestrator resolves ask nodes through an ask record opened (or reused) in the same commit.
							await api.commit(async (tx) => {
								const asks = await tx.doc(AsksDoc, api.conversationId);
								const r = (await tx.doc(RunDoc, api.conversationId)).runs.find((x) => x.id === runId)!;
								await assertDagGoalTx(tx,api.conversationId,r);
                                const now = Date.now();
								start(r, id, "orchestrator", now);
								waiting(r, id, now);
								r.nodes[id]!.ask = askNodeRecord(asks, r, id, api.conversationId, now);
								return undefined;
							}, context);
							return;
						}
						const check = node.kind === "verify" ? (node.post ?? []).find((p) => p.kind === "check") : undefined;
						if (check && check.kind === "check") {
							const workId = (await api.snapshot(WorkDoc, api.conversationId, context))?.activeId;
							if (!workId) { await mutateDag(api, runId, context, (r, now) => { start(r, id, "check", now); fail(r, id, "no active work contract for check", now); }); return; }
							await mutateDag(api, runId, context, (r, now) => start(r, id, `check:${check.id}`, now));
							const before = await work.status(api.conversationId, context);
							const status = await work.run(api, workId, check.id, context);
							const receipt = status.evidence.find(e => e.workId === workId && e.checkId === check.id && e.status === "passed" && e.version === status.version && e.methodEpoch === status.methodEpoch && e.mutationEpoch === status.mutationEpoch && e.before === e.after && e.observation?.quiescent && e.observation?.passed && !before.evidence.some(old => old.id === e.id));
							const covered = (node.covers ?? []).every(req => status.plan?.requirements.some(r => r.id === req && r.checkIds.includes(check.id) && r.checkIds.every(id => !status.unmetCheckIds.includes(id) && receipt && status.evidence.some(e => e.workId === workId && e.checkId === id && e.status === "passed" && e.version === status.version && e.methodEpoch === status.methodEpoch && e.mutationEpoch === status.mutationEpoch && e.before === receipt.after && e.after === receipt.after && e.observation?.quiescent && e.observation?.passed))));
							await mutateDag(api, runId, context, (r, now) => { if (receipt && covered && status.workId === workId && !status.blockers.length && !status.unmetCheckIds.includes(check.id)) succeed(r, id, JSON.stringify({version:1, requirements:(node.covers ?? []).map(id => ({id, verdict:"pass", evidence:`host work receipt ${receipt.id}`})), summary:`check ${check.id} passed`, repairable:false}), now); else fail(r, id, `check ${check.id} lacks a fresh successful receipt or coverage: ${status.blockers.join(", ")}`, now); });
							return;
						}
						let prompt: string;
						try { prompt = dagPrompt(current, node);const sourceId=current.goalBinding?.conversationId?Number(current.goalBinding.conversationId) as ConversationId:api.conversationId;const goal=(await api.snapshot(WorkDoc,sourceId,context))?.goal;if(goal)prompt+="\nOriginal actual-human purpose (independent of local phase IDs):\n"+JSON.stringify(goal); } catch (error) {
							// Deterministic and node-local: fail this node without retry; independent ready nodes keep running.
							await mutateDag(api, runId, context, (r, now) => failUndispatched(r, id, String(error), now));
							return;
						}
						if (!spawner.current) throw new Error("subagent spawner is unavailable");
						await spawner.current.spawn({ description: `${runId}:${id}`, prompt, subagentType: node.kind === "verify" ? "explore" : "general-purpose", background: true, owner: "dag", ...(node.route ? { model: node.route } : {}), key: `${runId}:${id}:${current.nodes[id]!.key}:${current.nodes[id]!.runs + 1}:${current.nodes[id]!.generation ?? 0}:${current.revision}` }, { ...api, commit: (change, c) => api.commit(async tx => {
							const r = (await tx.doc(RunDoc, api.conversationId)).runs.find(x => x.id === runId)!;
							await assertDagGoalTx(tx,api.conversationId,r);
                            if (!frontier(r).includes(id) || r.nodes[id]!.key !== current.nodes[id]!.key) {
								const existing = (await tx.doc(AgentsDoc, api.conversationId)).agents.find(a => a.taskId === r.nodes[id]!.handle);
								if (existing) return clone(existing) as Awaited<ReturnType<typeof change>>;
								throw new Error("stale DAG dispatch admission");
							}
							const ref = await change(tx);
							const binding = ref as unknown as { taskId:string; runnerId:number; conversationId:number };
                            if(r.goalBinding && binding.conversationId) (await tx.doc(WorkDoc,binding.conversationId as ConversationId)).goalParent={...r.goalBinding,conversationId:r.goalBinding.conversationId??String(api.conversationId)};
							start(r, id, binding.taskId, Date.now(), String(binding.runnerId));
                            if(binding.conversationId) (await tx.doc(WorkDoc,binding.conversationId as ConversationId)).dagParent={conversationId:String(api.conversationId),runId:r.id,nodeId:id,runnerId:String(binding.runnerId),attempt:r.nodes[id]!.attempt};
							return ref;
						}, c) }, context);
					} });
					run = result.run;
					// The asks listed below are shown to the model, which relays or answers them in this turn (ADR 0096).
					await markSeen(api, run, context, [...result.asks, ...result.askNodes.map((pending) => pending.ask)].map((ask) => ask.id));
					if ((run.status === "verified" || run.status === "blocked") && onOutcome && !scored.has(`${runId}:${run.revision}:${run.status}`)) {
						scored.add(`${runId}:${run.revision}:${run.status}`);
						await onOutcome(api.conversationId, run.status, context);
					}
					const lines = [summarize(run)];
					if (result.dispatched.length) lines.push(`dispatched: ${result.dispatched.join("; ")}`);
					if (result.asks.length) lines.push(`${result.asks.length} open ask(s) from node subagents; answer them with answer({ask_id, answer}) then call dag_step.`, ...result.asks.map(describeAsk));
					for (const { node, ask } of result.askNodes) {
						lines.push(ask.to === "human"
							? `ask node ${node} needs human authority for ${ask.refs.join(", ")}: relay the question; after the human replies call answer({ask_id: "${ask.id}", answer: "approve" or "deny", quote}) then dag_step. Only an explicit human approval runs them; deny or no answer by the deadline fails the node.`
							: `ask node ${node} needs your decision: call answer({ask_id: "${ask.id}", answer}) then dag_step.`, describeAsk(ask));
					}
					return { content: [{ type: "text", text: lines.join("\n") }], details: { run, asks: [...result.asks, ...result.askNodes.map((p) => p.ask)] }, isError: run.status === "blocked" };
				},
			}),
			defineTool({
				name: DAG_STATUS_TOOL, description: "Read the active run (or run_id) without changing it.",
				parameters: Type.Object({ run_id: Type.Optional(Type.String()) }, { additionalProperties: false }),
				execute: async ({ run_id }, api, context) => {
					const run = await activeDag(api, context, run_id);
					if (!run) return text("No run.", true);
					await markSeen(api, run, context);
					return { content: [{ type: "text", text: summarize(run) }], details: { run } };
				},
			}),
		],
	});
}
