import type { Context } from "@earendil-works/chord";
import { defineDoc, defineExtension, GenerationTask, type Harness, hook, type HookApi, LiveDoc } from "@earendil-works/pi-durable";
import { AsksDoc, LinkDoc } from "../core/ask.ts";
import { SchedulesDoc } from "../core/scheduler.ts";
import { RunDoc } from "../core/dag.ts";
import { type Goal, GoalDoc, type GoalCriterion } from "../core/goal.ts";
import { AgentsDoc, ProgressDoc, scanWake, isHostWakeRequest, wakeReader } from "./subagents.ts";
import type { TodoItem } from "../core/ui-contract.ts";
import { TodoDoc } from "./todo.ts";

/**
 * Liveness at the end of a turn (ADR 0096). A turn may end while work is unfinished; that is safe only if something will
 * re-enter the conversation by itself. For a top-level conversation that is a running owned subagent or DAG run (the idle
 * wake re-enters when it settles), a pending explicitly registered continuation of this goal, an unannounced wake event, or an open question to the human. With none of these and
 * an active goal with non-met criteria or unfinished TODOs, nothing would resume the work until the user asks "did you finish?", so the host
 * continues the run instead of letting it end. Subagents are not continued here: their runner holds their answer until
 * their own DAG runs settle (subagents.ts, ADR 0096), and their parent is woken when they finish.
 *
 * The continuation is bounded per run (one user input or wake, including steers): at most {@link GOAL_CONTINUATION_LIMIT},
 * and none after a continued turn that made no tool call (no progress). A user abort ends the run without onYield, so it is
 * never continued.
 */
export const LivenessDoc = defineDoc<{ run?: string; count: number; progressed: boolean }>({
	kind: "dinobot.liveness", version: 1, scope: "conversation", history: "latest", fork: "initial",
	initial: () => ({ count: 0, progressed: false }),
});
export const GOAL_CONTINUATION_PREFIX = "<from host=\"goal\"/>";
export const GOAL_CONTINUATION_LIMIT = 3;

export type PendingWork = { subagents: string[]; runs: string[]; humanAsks: string[]; schedules: string[]; events: number };

/** What will re-enter conversation `id` by itself, from committed documents. */
export async function pendingWork(reader: Pick<HookApi, "snapshot">, id: HookApi["conversationId"], context: Context): Promise<PendingWork> {
	const subagents: string[] = [];
	for (const ref of (await reader.snapshot(AgentsDoc, id, context))?.agents ?? []) {
		if (!ref.background || ref.owner) continue;
		if ((await reader.snapshot(ProgressDoc, id, String(ref.runnerId), context))?.subagent?.status === "running") subagents.push(ref.taskId);
	}
	// Research-owned runs never re-enter the conversation by themselves, so they do not count (ADR 0096).
	const runs = ((await reader.snapshot(RunDoc, id, context))?.runs ?? []).filter((run) => !run.owner && run.status === "running").map((run) => run.id);
	const humanAsks = ((await reader.snapshot(AsksDoc, id, context))?.asks ?? []).filter((ask) => ask.to === "human" && ask.state === "open").map((ask) => ask.id);
	const events = (await scanWake(wakeReader(reader, id, context))).events.length;
	const goal = (await reader.snapshot(GoalDoc, id, context))?.goal;
	// Only an explicit continuation of this goal, not a reminder or a different goal, can defer its work.
	// Admitted wakes must not suppress liveness inside their own scheduled turn.
	const schedules = goal?.status === "active" ? ((await reader.snapshot(SchedulesDoc, context))?.schedules ?? [])
		.filter(s => s.owner === id && s.state === "pending" && s.continuationGoal?.createdAt === goal.createdAt && s.continuationGoal.objective === goal.objective).map(s => s.id) : [];
	return { subagents, runs, humanAsks, schedules, events };
}

export function goalContinuation(goal: Goal | undefined, open: readonly GoalCriterion[], count: number, todos: readonly TodoItem[] = []): string {
	return [
		GOAL_CONTINUATION_PREFIX,
		...(goal?.status === "active" ? [
			`Your goal "${goal.objective}" is still active and these criteria are not met:`,
			...open.map((criterion) => `- [${criterion.status}] ${criterion.id}: ${criterion.statement}${criterion.evidence ? ` | evidence: ${criterion.evidence}` : ""}`),
		] : []),
		...(todos.length ? [
			"These TODOs are still unfinished; reconcile them with the actual work using todo_write:",
			...todos.map((todo) => `- [${todo.status}] ${todo.id}: ${todo.content}`),
			"Complete only work actually finished and verified as required; do not infer success from a report, a finished worker or this reminder. Keep unfinished work pending/in_progress; cancel only work genuinely cancelled or superseded. A terminal goal does not complete TODOs, and stale TODOs do not authorize restarting abandoned work.",
		] : []),
		`You ended your turn, but no subagent, DAG run, registered continuation of this goal or question to the human is pending, so nothing would resume this work by itself (host continuation ${count}/${GOAL_CONTINUATION_LIMIT}).`,
		"Continue actionable work now. An unmet criterion is not completion: inspect its evidence and resolve it when possible. If genuinely blocked, record the concrete blocker as evidence and report what is needed without claiming completion or repeating ineffective tools. If only the human can decide or supply a prerequisite, use ask. If done, mark criteria met with evidence and set the goal achieved. Abandon a goal only if the user changed course, never to silence this reminder.",
	].join("\n");
}

export function livenessExtension(getHarness: () => Harness) {
	return defineExtension({
		name: "liveness",
		hooks: [hook(GenerationTask, {
			afterTools: async (_assistant, _results, api, context) => {
				const state = await api.snapshot(LivenessDoc, api.conversationId, context);
				if (!state || state.count === 0 || state.progressed) return; // only a continued run needs the flag
				await getHarness().commit(async (tx) => {
					const doc = await tx.doc(LivenessDoc, api.conversationId);
					if (!doc.progressed) doc.progressed = true;
					return undefined;
				}, context);
			},
			onYield: async (_answer, api, context) => {
				const id = api.conversationId;
				if ((await api.snapshot(LinkDoc, id, context))?.parent !== undefined) return undefined;
				const goal = (await api.snapshot(GoalDoc, id, context))?.goal;
				const open = goal?.status === "active" ? goal.criteria.filter((criterion) => criterion.status !== "met") : [];
				const todos = ((await api.snapshot(TodoDoc, id, context))?.todos ?? []).filter((todo) => todo.status === "pending" || todo.status === "in_progress");
				if (!open.length && !todos.length) return undefined;
				// Something else re-enters this conversation: the idle wake, or the human's answer.
				const pending = await pendingWork(api, id, context);
				if (pending.subagents.length || pending.runs.length || pending.humanAsks.length || pending.schedules.length || pending.events) return undefined;
				// The budget belongs to the latest human input: a run started by a host wake keeps counting against it, so
				// wakes and continuations cannot chain without a human (ADR 0096). A run's first input identifies it.
				const first = (await api.snapshot(LiveDoc, id, context))?.run?.inputs?.[0];
				const record = first === undefined ? undefined : await (await getHarness().submission(first, context))?.status(context);
				const host = isHostWakeRequest(record?.requestId);
				const run = String(first ?? "");
				const count = await getHarness().commit(async (tx) => {
					const doc = await tx.doc(LivenessDoc, id);
					if (doc.run !== run && !host) { doc.run = run; doc.count = 0; doc.progressed = false; }
					if (doc.count >= GOAL_CONTINUATION_LIMIT || (doc.count > 0 && !doc.progressed)) return 0;
					doc.count += 1;
					doc.progressed = false;
					return doc.count;
				}, context);
				return count ? { continue: goalContinuation(goal, open, count, todos) } : undefined;
			},
		})],
	});
}
