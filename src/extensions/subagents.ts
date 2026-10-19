import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import { Type, type JsonObject, type Message, type Tool } from "@earendil-works/pi-ai";
import {
	configure, ConversationBusy, type ConversationId, defineDoc, defineDocFamily, defineExtension, defineTask, defineTool, type DocumentReader, GenerationTask, hook,
	type Harness, InboxDoc, LiveDoc, type Tx, type InboxState, type ModelRef, ProviderDoc, type ToolRegistration, type SnapshotEvent, type Submission, type SubmissionRecord, type TaskId, type ToolExecutionApi, watchEvents,
} from "@earendil-works/pi-durable";
import { type AskRecord, AsksDoc, describeAsk, LinkDoc, openAsksFrom } from "../core/ask.ts";
import { DagSeenDoc, RunDoc, runCanProgress, type RunState, runStateKey, unmet } from "../core/dag.ts";
import { conversationArchived } from "../core/threads.ts";
import { FastDoc } from "../core/fast.ts";
import { clone } from "../core/json.ts";
import {
	KILL_TASK_TOOL, TASK_MESSAGE_TOOL, TASK_OUTPUT_TOOL, TASK_TOOL, type SubagentProgress, type TaskDetails, type WorkflowStatus,
} from "../core/ui-contract.ts";
import { withConversationAdmission } from "../core/queue.ts";
import { WorkDoc, type WorkService } from "../core/verification.ts";
import { ANSWER_TOOL } from "./ask.ts";

export type AgentDefinition = {
	readonly name: string;
	readonly description: string;
	readonly tools?: string[];
	readonly model?: string;
	readonly prompt: string;
};

export async function loadAgents(dirs: readonly string[]): Promise<AgentDefinition[]> {
	const files: string[] = [];
	for (const dir of dirs) {
		for await (const file of new Bun.Glob("**/*.md").scan({ cwd: dir, absolute: true, onlyFiles: true })) files.push(file);
	}
	files.sort();

	const problems: string[] = [];
	const loaded: { readonly file: string; readonly agent: AgentDefinition }[] = [];
	for (const file of files) {
		try {
			const agent = parseAgent(file, await Bun.file(file).text());
			if (agent !== undefined) loaded.push({ file, agent });
		} catch (error) {
			problems.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	const byName = new Map<string, string[]>();
	for (const item of loaded) {
		const paths = byName.get(item.agent.name) ?? [];
		paths.push(item.file);
		byName.set(item.agent.name, paths);
	}
	for (const [name, paths] of byName) {
		if (paths.length > 1) problems.push(`duplicate agent name "${name}": ${paths.join(", ")}`);
	}

	if (problems.length > 0) throw new Error(problems.join("\n"));
	return loaded.map((item) => item.agent);
}

/** `owner`: a DAG run or research mission manages this child through its own protocol; `task_message` cannot steer it. */
export type AgentRef = { taskId: string; runnerId: TaskId<string>; conversationId: ConversationId; background: boolean; callId?: string; owner?: "dag" | "research" };
export const AgentsDoc = defineDoc<{ agents: AgentRef[] }>({
	kind: "dinobot.subagents", version: 1, scope: "conversation", history: "latest", fork: "initial",
	initial: () => ({ agents: [] }),
});
const ReceiptDoc = defineDocFamily<{ ref?: AgentRef }, null>({
	kind: "dinobot.subagent.receipt", version: 2, family: true, scope: "task", initial: () => ({}),
});

export type MissionSpawnBinding = { missionId: string; attemptId: string; metadata?: { epoch: number } };
/** INTERNAL host-only profile, intentionally absent from the task tool schema. */
export type SubagentHostProfile = {
	tools: readonly string[];
	cwd?: string;
	instructions: string;
	role: "author" | "reviewer";
	/** Host-selected executable registrations from the parent's authorized capability catalog.
	 * Registry membership alone is NOT authorization. Used when model-facing tools omit reads
	 * (e.g. codemode-only); never accept registrations from model/tool arguments. */
	registrations?: readonly ToolRegistration[];
};
export const MissionSpawnDoc = defineDocFamily<{ ref?: AgentRef; binding?: MissionSpawnBinding }, null>({
	kind: "dinobot.subagent.mission", version: 1, family: true, scope: "conversation",
	history: "latest", fork: "initial", initial: () => ({}),
});
export type SpawnApi = Pick<ToolExecutionApi, "agent" | "commit" | "conversationId" | "taskId"> & { callId?: string };
export type SpawnInput = { description: string; prompt: string; subagentType?: string; background: boolean; model?: string; /** Idempotency key within the calling tool task. */ key?: string; hostProfile?: SubagentHostProfile; mission?: MissionSpawnBinding; /** Set by the DAG dispatcher; mission spawns are research-owned. */ owner?: "dag" };
export type SubagentSpawner = { spawn(input: SpawnInput, api: SpawnApi, context: Context): Promise<AgentRef>; cancel(ref: AgentRef): Promise<void> };
/** `delivered`: the terminal answer was already returned to this conversation by task or task_output. */
export const ProgressDoc = defineDocFamily<{ subagent?: SubagentProgress; answer?: string; delivered?: boolean }, null>({
	kind: "dinobot.subagent.progress", version: 1, family: true,
	scope: "conversation", history: "latest", fork: "initial", initial: () => ({}),
});
/**
 * Upper bound of one blocking task_output wait. A longer wait leaves the user without any report (the main conversation
 * cannot speak while a tool runs); the caller reports progress and waits again instead.
 */
export const TASK_OUTPUT_MAX_TIMEOUT_MS = 5 * 60_000;

/**
 * Idle-orchestrator wake (one durable watcher per conversation): `task` holds the watcher's TaskId while it is live and
 * `notified` the events already announced (`done:<runnerId>`, `ask:<askId>`), so each event wakes the conversation once.
 */
/**
 * `claimed`: the channel hand-over started, so a user's reply no longer takes this answer along (bot.handle, ADR 0096).
 * `mergedInto`: a user's reply (that answer entry) took it along at `mergedAt`; it stays here until the thread is seen to
 * hold that reply, and is handed over by itself if that never happens.
 */
export type WakeDelivery = { requestId: string; since: number; asks: string[]; claimed?: boolean; mergedInto?: number; mergedAt?: number };
export const WakeDoc = defineDoc<{ task?: TaskId<string>; notified: string[]; /** Woken answers not yet handed to the conversation's channel (ADR 0096). */ deliveries?: WakeDelivery[] }>({
	kind: "dinobot.subagent.wake", version: 1, scope: "conversation", history: "latest", fork: "initial",
	initial: () => ({ notified: [] }),
});
const WAKE_NOTIFIED_LIMIT = 256;
/** A woken answer whose channel is not (yet) running is retried this often, for at most this long (ADR 0096). */
const WAKE_DELIVERY_RETRY_MS = 30_000;
const WAKE_DELIVERY_DEADLINE_MS = 24 * 3_600_000;
/** Bound on waiting for a woken turn that has not started yet. */
const WAKE_DELIVERY_POLL_MS = 1_000;
/**
 * Hands the answer of a woken turn to the channel of its conversation (ADR 0096). `pending`: the turn has not settled;
 * `retry`: the channel cannot take it now; `done`: handed over, or there is nothing to hand over.
 */
export type WakeDeliver = (delivery: WakeDelivery & { conversationId: ConversationId }, context: Context) => Promise<"done" | "pending" | "retry">;
export const WAKE_PREFIX = "<from host=\"subagents\"/>";
/** Request id prefix of a wake input: a run it starts was started by the host, not by a person. */
export const WAKE_REQUEST_PREFIX = "subagent-wake:";
const CHILD_EXCLUDED_TOOLS = new Set([TASK_TOOL, TASK_OUTPUT_TOOL, KILL_TASK_TOOL, TASK_MESSAGE_TOOL, ANSWER_TOOL]);
/** Deliberately finite: plugins and arbitrary execution are not reviewer capabilities. */
export const RESEARCH_READ_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "find", "ls"]);

type Wake = { kind: "settled" } | { kind: "timeout" } | { kind: "ask"; asks: AskRecord[] };

/**
 * OR-wait of the orchestrator (ADR 0030): settle on child termination (all listed children, or with `any` the first
 * of them), an open ask from one of these children, or the timeout. Never blocks on a child that is itself blocked on
 * this conversation.
 */
async function waitForChildrenOrAsk(api: ToolExecutionApi, refs: readonly AgentRef[], context: Context, timeoutMs?: number, any = false): Promise<Wake> {
	const children = new Set(refs.map((ref) => ref.conversationId));
	let watch = await api.watchDoc(AsksDoc, api.conversationId, context);
	if (!watch) {
		await api.commit(async (tx) => { await tx.doc(AsksDoc, api.conversationId); return undefined; }, context);
		watch = await api.watchDoc(AsksDoc, api.conversationId, context);
		if (!watch) throw new Error("Ask record store is missing");
	}
	const initial = openAsksFrom(watch.value, children);
	if (initial.length) { await watch.stop(); return { kind: "ask", asks: initial }; }
	const wake = Promise.withResolvers<Wake>();
	// Observed below; this keeps a rejection after an early return (abort during the re-read) from going unhandled.
	wake.promise.catch(() => {});
	const waiter = withCancel(context);
	const timer = timeoutMs === undefined ? undefined : setTimeout(() => wake.resolve({ kind: "timeout" }), timeoutMs);
	watch.start(async (value) => {
		const asks = openAsksFrom(value, children);
		if (asks.length) wake.resolve({ kind: "ask", asks });
	});
	const waits = refs.map((ref) => api.waitForTask(ref.runnerId, waiter.context));
	(any ? Promise.race(waits) : Promise.all(waits))
		.then(() => wake.resolve({ kind: "settled" }), (error) => { if (!waiter.context.abortSignal?.aborted) wake.reject(error); });
	const onAbort = () => wake.reject(context.abortSignal?.reason ?? new Error("aborted"));
	context.abortSignal?.addEventListener("abort", onAbort, { once: true });
	try {
		// Asks committed between acquisition and start are observed by this re-read.
		const again = openAsksFrom(await api.snapshot(AsksDoc, api.conversationId, context), children);
		if (again.length) wake.resolve({ kind: "ask", asks: again });
		return await wake.promise;
	} finally {
		context.abortSignal?.removeEventListener("abort", onAbort);
		if (timer) clearTimeout(timer);
		waiter.cancel();
		await watch.stop();
	}
}

export type WakeEvent = { key: string; line: string; /** An open human ask the woken answer must show to the human. */ humanAsk?: string; /** A stopped run: the wake text shows this state to the model. */ run?: { id: string; state: string } };
export type WakeScan = { running: TaskId<string>[]; runningRuns: string[]; events: WakeEvent[] };
export type WakeRead = {
	self: ConversationId;
	agents(): Promise<{ agents: AgentRef[] } | null | undefined>;
	progress(ref: AgentRef): Promise<{ subagent?: SubagentProgress; delivered?: boolean } | null | undefined>;
	asks(): Promise<{ asks: AskRecord[] } | null | undefined>;
	notified(): Promise<readonly string[]>;
	runs(): Promise<{ runs: RunState[] } | null | undefined>;
	seen(): Promise<Record<string, string>>;
	/** Asks a dag_step result already listed to the model. */
	seenAsks(): Promise<readonly string[]>;
	/** Top-level orchestrator (no parent link). Only it is woken for DAG runs and ask nodes: a child's answer is final. */
	topLevel(): Promise<boolean>;
};

const clip = (value: string, max: number) => value.length > max ? `${value.slice(0, max)}…` : value;

/** One line per stopped run; the orchestrator must act on it or report it. */
function dagLine(run: RunState): string {
	const reason = run.reason ? `: ${clip(run.reason, 400)}` : "";
	if (run.status === "verified") return `- DAG run ${run.id} finished: verified, every requirement certified. Read the results with dag_status and carry out the next step you promised (for example publish or open the PR).`;
	return `- DAG run ${run.id} stopped: blocked${reason}. Unmet: ${unmet(run).join(", ") || "none"}. It will not continue by itself: inspect it with dag_status, then repair it (replan with dag_run({plan, run_id}) or delegate the fix with task) or tell the user exactly what blocks it.`;
}

/**
 * What the idle orchestrator would have to act on (ADR 0091, extended by ADR 0096): its owned background children that
 * are still running, and the not yet announced events: an uncollected terminal answer, an open ask to main from an owned
 * or DAG node child, an open ask of one of its DAG ask nodes, and an ordinary DAG run that stopped (blocked, verified or
 * cancelled) in a state the model has not seen in a DAG tool result.
 */
export async function scanWake(read: WakeRead): Promise<WakeScan> {
	const all = (await read.agents())?.agents ?? [];
	const refs = all.filter((ref) => ref.background && !ref.owner);
	const notified = new Set(await read.notified());
	const running: TaskId<string>[] = [];
	const events: WakeEvent[] = [];
	for (const ref of refs) {
		const state = await read.progress(ref);
		const s = state?.subagent;
		if (!s) continue;
		if (s.status === "running") { running.push(ref.runnerId); continue; }
		const key = `done:${ref.runnerId}`;
		if (!state.delivered && !notified.has(key)) events.push({ key, line: `- ${s.taskId} (${s.description}) finished: ${s.status}${s.error ? ` (${s.error})` : ""}` });
	}
	const top = await read.topLevel();
	const askers = new Set(refs.map((ref) => ref.conversationId));
	if (top) for (const ref of all) if (ref.owner === "dag") askers.add(ref.conversationId);
	const asks = await read.asks();
	const seenAsks = new Set(top ? await read.seenAsks() : []);
	for (const ask of openAsksFrom(asks, askers)) {
		const key = `ask:${ask.id}`;
		if (!notified.has(key) && !seenAsks.has(ask.id)) events.push({ key, line: `- ${describeAsk(ask)}` });
	}
	const runningRuns: string[] = [];
	if (top) {
		for (const ask of asks?.asks ?? []) {
			if (ask.state !== "open" || ask.run === undefined || ask.node === undefined || ask.from.conversationId !== read.self) continue;
			const key = `ask:${ask.id}`;
			if (notified.has(key) || seenAsks.has(ask.id) || events.some((event) => event.key === key)) continue;
			events.push(ask.to === "human"
				? { key, line: `- DAG ask node ${ask.node} of ${ask.run} needs the human's answer; the question is shown to the human with this answer, tell them what it decides:\n  ${describeAsk(ask)}`, humanAsk: ask.id }
				: { key, line: `- DAG ask node ${ask.node} of ${ask.run} needs your decision (answer it, then dag_step):\n  ${describeAsk(ask)}` });
		}
		const seen = await read.seen();
		for (const run of (await read.runs())?.runs ?? []) {
			if (run.owner) continue; // Research missions have their own controller and reporting.
			if (run.status === "running") { runningRuns.push(run.id); continue; }
			// Every ordinary run is created by dag_run, which records it as seen; a run without an entry predates this
			// mechanism and is history unless armWake adopted it while it was still running (ADR 0096).
			// Only the model cancels an ordinary run (dag_step), so a cancellation is never news to it.
			if ((run.status !== "blocked" && run.status !== "verified") || !(run.id in seen)) continue;
			// A run quarantined because the goal changed (a new goal_set, or the user aborted) is not news to announce.
			if (run.status === "blocked" && run.reason?.startsWith("stale_goal_admission_epoch")) continue;
			const state = runStateKey(run);
			const key = `dag:${run.id}:${state}`;
			if (seen[run.id] === state || notified.has(key)) continue;
			events.push({ key, line: dagLine(run), run: { id: run.id, state } });
		}
	}
	return { running, runningRuns, events };
}

/** The wake scan of conversation `id` from committed documents. */
export function wakeReader(reader: Pick<DocumentReader, "snapshot">, id: ConversationId, context: Context): WakeRead {
	return {
		self: id,
		agents: () => reader.snapshot(AgentsDoc, id, context),
		progress: (ref) => reader.snapshot(ProgressDoc, id, String(ref.runnerId), context),
		asks: () => reader.snapshot(AsksDoc, id, context),
		notified: async () => (await reader.snapshot(WakeDoc, id, context))?.notified ?? [],
		runs: () => reader.snapshot(RunDoc, id, context),
		seen: async () => (await reader.snapshot(DagSeenDoc, id, context))?.seen ?? {},
		seenAsks: async () => (await reader.snapshot(DagSeenDoc, id, context))?.asks ?? [],
		topLevel: async () => (await reader.snapshot(LinkDoc, id, context))?.parent === undefined,
	};
}

export function wakeMessage(events: readonly WakeEvent[], subagent = false): string {
	return [
		WAKE_PREFIX,
		"Background work changed state after your last answer:",
		...events.map((event) => event.line),
		subagent
			? "You are a subagent and your answer is final for your parent: inspect the run with dag_status, answer open asks with answer, step or repair it, and answer with its actual result (or exactly what blocks it)."
			: "Collect finished subagent answers with task_output (block:false), inspect DAG runs with dag_status and resolve open asks with answer; relay a question the user must decide with ask. Then continue the work toward the goal and tell the user briefly what changed and what is still running.",
	].join("\n");
}

/** Follow-up turns a subagent gets for its own DAG runs before its answer is final regardless (ADR 0096). */
export const SUBAGENT_WAKE_ROUNDS = 8;

/**
 * Waits until the subagent conversation `id` has something to act on for its own ordinary DAG runs — a stopped run it
 * has not seen, an open ask of an ask node or of a node child — and returns those events; returns none once no
 * ordinary run is running. The run itself advances through its driver meanwhile, without model polling.
 */
async function ownDagEvents(reader: Pick<ToolExecutionApi, "snapshot" | "watchDoc">, id: ConversationId, announced: ReadonlySet<string>, context: Context): Promise<WakeEvent[]> {
	// Most subagents never start a DAG run of their own (a run may already have stopped, unseen, since the answer).
	const seenRuns = (await reader.snapshot(DagSeenDoc, id, context))?.seen ?? {};
	if (!((await reader.snapshot(RunDoc, id, context))?.runs ?? []).some((run) => !run.owner && (run.status === "running" || seenRuns[run.id] !== runStateKey(run)))) return [];
	const base = wakeReader(reader, id, context);
	const own = (): WakeRead => ({ ...base, topLevel: async () => true, notified: async () => [...await base.notified(), ...announced] });
	for (;;) {
		// A subagent has no answer tool, so only stopped runs are its events; asks to it default at their deadline.
		const scan = await scanWake(own());
		const stops = scan.events.filter((event) => event.run !== undefined);
		if (stops.length) return stops;
		if (!scan.runningRuns.length) return [];
		// A run that advances only once an ask node is answered would wait out a 24 h deadline: the answer is final now.
		if (!((await reader.snapshot(RunDoc, id, context))?.runs ?? []).some((run) => !run.owner && runCanProgress(run))) return [];
		const changed = Promise.withResolvers<void>();
		const runs = await reader.watchDoc(RunDoc, id, context);
		const asks = await reader.watchDoc(AsksDoc, id, context);
		const runStates = (value: { runs: RunState[] } | null | undefined) => JSON.stringify(value?.runs.map((run) => [run.id, run.status, run.revision]) ?? []);
		const openAsks = (value: { asks: AskRecord[] } | null | undefined) => JSON.stringify(value?.asks.filter((ask) => ask.state === "open").map((ask) => ask.id) ?? []);
		const runsBefore = runStates(runs?.value), asksBefore = openAsks(asks?.value);
		const onAbort = () => changed.reject(context.abortSignal?.reason ?? new Error("aborted"));
		try {
			context.abortSignal?.addEventListener("abort", onAbort, { once: true });
			if (context.abortSignal?.aborted) onAbort();
			runs?.start(async (value) => { if (runStates(value) !== runsBefore) changed.resolve(); });
			asks?.start(async (value) => { if (openAsks(value) !== asksBefore) changed.resolve(); });
			// Changes committed between the scan and the watches are seen by this re-scan.
			const again = await scanWake(own());
			if (again.events.some((event) => event.run !== undefined) || !again.runningRuns.length) changed.resolve();
			await changed.promise;
		} finally {
			context.abortSignal?.removeEventListener("abort", onAbort);
			await runs?.stop();
			await asks?.stop();
		}
	}
}

function askNotice(asks: readonly AskRecord[]): string {
	return [
		`${asks.length === 1 ? "A subagent is waiting for your answer" : `${asks.length} subagents are waiting for your answers`}. Resolve with answer({ask_id, answer}) and collect with task_output.`,
		...asks.map(describeAsk),
	].join("\n");
}

function assistantText(messages: readonly Message[] | undefined): string {
	return (messages ?? []).flatMap((message) =>
		message.role === "assistant" ? message.content.flatMap((block) => block.type === "text" ? [block.text] : []) : [],
	).join("\n");
}

function applySnapshot(progress: SubagentProgress, snapshot: SnapshotEvent) {
	progress.toolCount = snapshot.entries.filter((entry) => entry.model?.some((message) => message.role === "toolResult")).length;
	const tool = snapshot.tools.find((tool) => tool.status === "running");
	if (tool) progress.currentTool = tool.name;
	else delete progress.currentTool;
	const text = assistantText(snapshot.entries.flatMap((entry) => entry.model ?? []));
	if (text) progress.lastText = text.trimEnd().split("\n").at(-1)?.slice(0, 200) ?? "";
	progress.tokens = Object.values(snapshot.usage.models).reduce((sum, usage) => sum + usage.output, 0);
}

/** Parent-owned progress fields the runner never overwrites: background promotion and task_message delivery counts. */
function keepParentFields(progress: SubagentProgress, current: SubagentProgress | undefined): SubagentProgress {
	const next: SubagentProgress = { ...progress, background: current?.background ?? progress.background };
	if (current?.messages !== undefined) next.messages = current.messages;
	if (current?.messageSubmissions !== undefined) next.messageSubmissions = current.messageSubmissions;
	return next;
}

/** Rejects with the abort reason once `context` is cancelled; `dispose` detaches the listener. */
function abortion(context: Context): { promise: Promise<never>; dispose(): void } {
	const signal = context.abortSignal;
	const { promise, reject } = Promise.withResolvers<never>();
	promise.catch(() => undefined);
	const onAbort = () => reject(signal?.reason ?? new Error("aborted"));
	if (signal?.aborted) onAbort();
	else signal?.addEventListener("abort", onAbort, { once: true });
	return { promise, dispose: () => signal?.removeEventListener("abort", onAbort) };
}

/**
 * Wait until a boundary takes `note` out of the child's inbox (placed into a run, or settled), not until that run ends:
 * a placed input settles only with its whole run (pi-durable `endRun`), which would hold the parent for the child's lifetime.
 */
async function waitForPlacement(api: ToolExecutionApi, conversationId: ConversationId, note: Submission, context: Context): Promise<SubmissionRecord> {
	const queued = (inbox: Readonly<InboxState> | null | undefined) => (inbox?.items ?? []).some((item) => Number(item.id) === Number(note.id));
	const watch = await api.watchDoc(InboxDoc, conversationId, context);
	if (watch) {
		const left = Promise.withResolvers<void>();
		const aborted = abortion(context);
		if (!queued(watch.value)) left.resolve();
		watch.start(async (inbox) => { if (!queued(inbox)) left.resolve(); });
		void watch.closed.then(() => left.resolve(), () => left.resolve());
		try { await Promise.race([left.promise, aborted.promise]); }
		finally { aborted.dispose(); await watch.stop(); }
	}
	return note.status(context);
}

async function readProgress(api: ToolExecutionApi, ref: AgentRef, context: Context) {
	const state = await api.snapshot(ProgressDoc, api.conversationId, String(ref.runnerId), context);
	if (!state?.subagent) throw new Error(`Subagent ${ref.taskId} has no progress record`);
	return { ...state, subagent: state.subagent };
}

/** Records that these children's terminal answers reached the conversation, so later collection only summarizes them. */
async function markDelivered(api: ToolExecutionApi, refs: readonly AgentRef[], context: Context) {
	if (!refs.length) return;
	await api.commit(async (tx) => {
		for (const ref of refs) {
			const doc = await tx.doc(ProgressDoc, api.conversationId, String(ref.runnerId), null);
			if (doc.subagent && doc.subagent.status !== "running") doc.delivered = true;
		}
		return undefined;
	}, context);
}

/** One collection line: a terminal answer (with its error) once, then a short summary; running children report progress. */
export function collectionLine(state: { subagent: SubagentProgress; answer?: string; delivered?: boolean }, repeat: boolean): string {
	const s = state.subagent;
	if (s.status === "running") {
		const progress = [`${s.toolCount} tool call${s.toolCount === 1 ? "" : "s"}`, ...(s.messages ? [`${s.messages} message${s.messages === 1 ? "" : "s"}`] : []), ...(s.tokens ? [`${s.tokens} tokens`] : []), ...(s.currentTool ? [`now ${s.currentTool}`] : [])].join(", ");
		return `${s.taskId} [running] ${progress}: ${s.lastText ?? "no text yet"}`;
	}
	// A failed child keeps its answer (e.g. work without a certificate) and shows why it failed; an empty answer shows the error alone.
	const body = s.status === "completed" ? (state.answer || s.lastText || "(empty answer)") : ([s.error, state.answer].filter(Boolean).join("\n") || s.status);
	if (state.delivered && !repeat) return `${s.taskId} [${s.status}]: already collected (${body.length} chars); pass include_delivered:true to repeat it`;
	return `${s.taskId} [${s.status}]: ${body}`;
}

export function subagentsExtension(getHarness: () => Harness, work: WorkService, agents: readonly AgentDefinition[] = [], spawner?: { current?: SubagentSpawner }, maxWaitMs = TASK_OUTPUT_MAX_TIMEOUT_MS, wake: { deliver?: WakeDeliver; retryMs?: number; recovery?: { current?: (context: Context) => Promise<void> } } = {}) {
	const { deliver, retryMs = WAKE_DELIVERY_RETRY_MS } = wake;
	const definitions = new Map(agents.map((agent) => [agent.name, agent]));
	/** Foreground cancellation emulation for conversation-owned children. */
	async function cancelChild(ref: AgentRef) {
		const harness = getHarness();
		const task = await harness.getTask(ref.runnerId, BACKGROUND_CONTEXT);
		if (task && task.state.status !== "terminal") {
			await harness.abortTask(ref.runnerId, BACKGROUND_CONTEXT);
			await harness.waitForTask(ref.runnerId, BACKGROUND_CONTEXT);
		}
	}
	const available = [
		"- general-purpose: General-purpose independent task worker.",
		"- explore: Read-only research and investigation.",
		...agents.map((agent) => `- ${agent.name}: ${agent.description}`),
	].join("\n");
	const runner = defineTask<{ prompt: string }, { phase: "run" }, string>({
		name: "dinobot.subagent", version: 1, initial: () => ({ phase: "run" }),
		phases: {
			run: async (task, runtime, context) => {
				const state = await runtime.snapshot(ProgressDoc, runtime.conversationId, String(task.id), context);
				if (!state?.subagent) throw new Error("Subagent progress is missing");
				const progress = clone(state.subagent);
				const refs = await runtime.snapshot(AgentsDoc, runtime.conversationId, context);
				const ref = refs?.agents.find((ref) => ref.runnerId === task.id);
				if (!ref) throw new Error("Subagent linkage is missing");
				const stream = await watchEvents(getHarness(), ref.conversationId, context);
				applySnapshot(progress, stream.snapshot);
				let text = stream.snapshot.generation?.message ? assistantText([stream.snapshot.generation.message]) : "";
				let writing = Promise.resolve();
				stream.start(async (events) => {
					const before = JSON.stringify(progress);
					for (const event of events) {
						switch (event.type) {
							case "snapshot": applySnapshot(progress, event); break;
							case "tool_execution_start": progress.currentTool = event.toolName; break;
							case "tool_execution_end": progress.toolCount++; delete progress.currentTool; break;
							case "message_start": text = assistantText([event.message]); break;
							case "message_update":
								for (const change of event.changes) {
									if (change.type === "text_delta") text += change.delta;
									if (change.type === "message") text = assistantText([change.message]);
								}
								if (text) progress.lastText = text.trimEnd().split("\n").at(-1)?.slice(0, 200) ?? "";
								break;
							case "message_end": {
								const answer = assistantText(event.entry.model);
								if (answer) progress.lastText = answer.trimEnd().split("\n").at(-1)?.slice(0, 200) ?? "";
								break;
							}
							case "usage_changed":
								progress.tokens = Object.values(event.usage.models).reduce((sum, usage) => sum + usage.output, 0);
								break;
						}
					}
					if (JSON.stringify(progress) === before) return;
					writing = runtime.commit(async (tx) => {
						const doc = await tx.doc(ProgressDoc, runtime.conversationId, String(task.id), null);
						// `background` is owned by the parent tool (promotion); the runner never overwrites it.
						doc.subagent = keepParentFields(clone(progress), doc.subagent);
						return undefined;
					}, context);
					await writing;
				});
				let answer = "";
				try {
					const child = await runtime.conversation(ref.conversationId, context);
					if (!child) throw new Error("Subagent conversation is missing");
					let submission = await child.submit({ type: "input", content: task.input.prompt, requestId: `subagent:${task.id}` }, context);
					let settled = await submission.wait(context);
					// ADR 0096: the answer is final for the parent, so the subagent does not end while its own DAG run still runs
					// or waits for it: the run is left to its driver, and every stop or ask is handed back to the subagent as a
					// new turn whose answer replaces this one. Request ids are keyed by the events, so a restart replays them.
					const announced = new Set<string>();
					for (let round = 0; round < SUBAGENT_WAKE_ROUNDS && settled.type === "input" && settled.status === "done"; round++) {
						const events = await ownDagEvents(runtime, ref.conversationId, announced, context);
						if (!events.length) break;
						for (const event of events) announced.add(event.key);
						submission = await child.submit({ type: "input", content: wakeMessage(events, true), requestId: `subagent:${task.id}:wake:${events.map((event) => event.key).join(",")}` }, context);
						settled = await submission.wait(context);
					}
					if (settled.type === "input" && settled.status === "done") {
						await runtime.commit(async (tx) => {
							answer = assistantText((await tx.entry(settled.answer))?.model);
							return undefined;
						}, context);
						const projected = await work.projectSubmission(ref.conversationId, String(submission.id), answer, context);
						answer = projected.text;
						if (projected.workflow.status !== "informational") progress.workflow = projected.workflow;
						progress.status = !work.enforced || projected.workflow.status === "informational" || projected.workflow.status === "verified"
							? "completed" : projected.workflow.status === "cancelled" ? "cancelled" : "failed";
						if (progress.status === "failed") progress.error = "Coding work has no current verification certificate.";
						progress.lastText = answer.trimEnd().split("\n").at(-1)?.slice(0, 200) ?? "";
					} else {
						progress.status = "failed";
						progress.error = settled.status === "unanswered" ? settled.reason : settled.status;
					}
				} catch (error) {
					context.abortSignal?.throwIfAborted();
					progress.status = "failed";
					progress.error = error instanceof Error ? error.message : String(error);
				} finally {
					await stream.stop();
					await writing;
				}
				progress.endedAt = Date.now();
				delete progress.currentTool;
				await runtime.commit(async (tx) => {
					const doc = await tx.doc(ProgressDoc, runtime.conversationId, String(task.id), null);
					doc.subagent = keepParentFields(progress, doc.subagent);
					doc.answer = answer;
					return { status: "terminal", outcome: { status: "completed", result: answer } };
				}, context);
			},
		},
		abort: async (task, runtime, context) => {
			const refs = await runtime.snapshot(AgentsDoc, runtime.conversationId, context);
			const ref = refs?.agents.find((item) => item.runnerId === task.id);
			let workflow: WorkflowStatus | undefined;
			if (ref) {
				const state = await work.snapshot(ref.conversationId, context);
				if (state.activeId) workflow = await work.settle(ref.conversationId, state.activeId, "cancelled", "Subagent task cancelled.", context);
			}
			await runtime.commit(async (tx) => {
				const doc = await tx.doc(ProgressDoc, runtime.conversationId, String(task.id), null);
				if (doc.subagent) {
					doc.subagent.status = "cancelled";
					doc.subagent.endedAt = Date.now();
					delete doc.subagent.currentTool;
					if (workflow) doc.subagent.workflow = workflow;
				}
				return { status: "terminal", outcome: { status: "aborted" } };
			}, context);
		},
	});
	async function spawn(input: SpawnInput, api: SpawnApi, context: Context): Promise<AgentRef> {
		if (input.mission && (!input.mission.missionId || !input.mission.attemptId || !input.hostProfile)) throw new Error("Mission spawn requires an identity and host profile");
		const profile = input.hostProfile;
		if (input.mission && profile && profile.tools.some((name) => profile.role === "author" || !RESEARCH_READ_TOOLS.has(name))) throw new Error("Research child profile exceeds its read-only authority");
		const subagentType = input.subagentType ?? "general-purpose";
		const definition = definitions.get(subagentType);
		if (!definition && subagentType !== "general-purpose" && subagentType !== "explore") {
			throw new Error(`Unknown subagent type "${subagentType}". Available: ${["general-purpose", "explore", ...definitions.keys()].join(", ")}`);
		}
		const agent = await api.agent(context);
		const model = resolveModel(input.model ?? definition?.model ?? "inherit", agent.model);
		const tools = profile?.tools ?? definition?.tools;
		const allowed = tools === undefined ? undefined : new Set(tools);
		if (profile?.registrations) {
			const names = profile.registrations.map((tool) => tool.name);
			if (new Set(names).size !== names.length || profile.registrations.some((tool) =>
				!isToolRegistration(tool) || !profile.tools.includes(tool.name) || !RESEARCH_READ_TOOLS.has(tool.name)
				|| profile.role === "author")) throw new Error("Invalid host-selected research tool registrations");
		}
		const childTools = (profile?.registrations ?? agent.tools).filter((tool): tool is ToolRegistration =>
			isToolRegistration(tool) && !CHILD_EXCLUDED_TOOLS.has(tool.name) && (allowed === undefined || allowed.has(tool.name)));
		if (input.mission && profile) {
			if (new Set(profile.tools).size !== profile.tools.length) throw new Error("Duplicate research tool names");
			const missing = profile.tools.filter((name) => !childTools.some((tool) => tool.name === name));
			if (missing.length) throw new Error(`Research child tools unavailable: ${missing.join(", ")}`);
		}
		return api.commit(async (tx) => {
				const receipt = input.mission
					? await tx.doc(MissionSpawnDoc, api.conversationId, JSON.stringify([input.mission.missionId, input.mission.attemptId]), null)
					: await tx.doc(ReceiptDoc, api.taskId, input.key ?? "child", null);
				if (receipt.ref) return clone(receipt.ref);
				// Conversation-owned even in the foreground: a child that asks must outlive this tool call (ADR 0030).
				// Foreground cancellation is emulated below so a parent abort still cancels the child.
				const runnerId = await tx.createTask(runner, { prompt: input.prompt }, { ownership: { kind: "conversation" }, conversationId: api.conversationId, background: true });
				const child = await tx.createConversation({ ownership: { kind: "task", taskId: runnerId } });
				await tx.doc(AsksDoc, api.conversationId);
				Object.assign(await tx.doc(LinkDoc, child.id), { parent: api.conversationId, runnerId: String(runnerId), taskId: `sa-${child.id}` });
				await configure(tx, child.id, {
					...(model ? { model } : {}), thinkingLevel: agent.thinkingLevel,
					extensions: input.mission
						? agent.extensions.filter(extension => extension.tools?.some(tool => childTools.some(child => child.name === tool.name)))
						: agent.extensions,
					tools: childTools,
					instructions: profile?.instructions ?? definition?.prompt ?? [agent.instructions, ...(subagentType === "explore" ? ["You are a read-only research subagent. Inspect and report findings; do not modify files or external state."] : [])].filter(Boolean).join("\n"),
					...((profile?.cwd ?? agent.cwd) !== undefined ? { cwd: profile?.cwd ?? agent.cwd } : {}),
				});
				await tx.doc(ProviderDoc, child.id);
				(await tx.doc(FastDoc, child.id)).fast = (await tx.doc(FastDoc, api.conversationId)).fast;
				const parentWork = await tx.doc(WorkDoc, api.conversationId);
				if (parentWork.activeId && !input.mission) {
					await work.bindChildTx(tx, api.conversationId, parentWork.activeId, child.id, runnerId);
				}
				const owner = input.mission ? "research" as const : input.owner;
				const ref: AgentRef = { taskId: `sa-${child.id}`, runnerId, conversationId: child.id, background: input.background, ...(api.callId !== undefined ? { callId: api.callId } : {}), ...(owner ? { owner } : {}) };
				(await tx.doc(ProgressDoc, api.conversationId, String(runnerId), null)).subagent = {
					taskId: ref.taskId, description: input.description, subagentType: subagentType, background: input.background,
					conversationId: child.id, status: "running", startedAt: Date.now(), toolCount: 0,
				};
				(await tx.doc(AgentsDoc, api.conversationId)).agents.push(ref);
				receipt.ref = ref;
				if (input.mission) (await tx.doc(MissionSpawnDoc, api.conversationId, JSON.stringify([input.mission.missionId, input.mission.attemptId]), null)).binding = clone(input.mission);
				return ref;
		}, context);
	}
	if (spawner) spawner.current = { spawn, cancel: cancelChild };

	/**
	 * Wakes an idle orchestrator (ADR 0091, ADR 0096). A background child that finishes or asks, an ordinary DAG run that
	 * stops, or a DAG ask node that opens while the parent conversation has already answered would otherwise wait unseen:
	 * an ask defaults at its deadline and a stopped run or an answer is only read when the user writes again. The watcher
	 * submits one host input per new set of events when the conversation is idle; while it is busy it waits for that run to
	 * end, because a busy run may itself be the one that collects the event. The woken turn's answer is handed to the
	 * conversation's channel (`deliver`), because a channel only posts answers to the messages it received. The watcher
	 * ends when no owned background child or ordinary run is running, nothing is left to announce and every woken answer
	 * was handed over.
	 */
	type WakeCheckpoint = { phase: "check" } | { phase: "wait"; on: TaskId<string>[]; retryAt?: number } | { phase: "busy"; run: TaskId<string> };
	const wakeWatcher = defineTask<Record<string, never>, WakeCheckpoint, string>({
		name: "dinobot.subagent.wake", version: 1, initial: () => ({ phase: "check" }),
		phases: {
			check: async (task, runtime, context) => {
				const id = runtime.conversationId;
				// Hand over the answers of earlier wakes whose turn has settled (ADR 0096).
				let retryAt: number | undefined;
				const pending = (await runtime.snapshot(WakeDoc, id, context))?.deliveries ?? [];
				for (const delivery of pending) {
					const outcome = deliver ? await deliver({ conversationId: id, ...delivery }, context) : "done";
					if (outcome === "pending") continue;
					if (outcome === "retry" && Date.now() - delivery.since < WAKE_DELIVERY_DEADLINE_MS) { retryAt = Math.min(retryAt ?? Infinity, Date.now() + retryMs); continue; }
					await runtime.commit(async (tx) => {
						const doc = await tx.doc(WakeDoc, id);
						doc.deliveries = (doc.deliveries ?? []).filter((item) => item.requestId !== delivery.requestId);
						return undefined;
					}, context);
				}
				const scan = await scanWake(wakeReader(runtime, id, context));
				const finish = () => runtime.commit(async (tx) => {
					const doc = await tx.doc(WakeDoc, id);
					// Decided again in the transaction armWake uses: an answer that started new work while this watcher was
					// deciding saw it alive and armed nothing, so the watcher must not end then (ADR 0096).
					const again = await scanTx(tx, id, doc);
					if (again.running.length || again.runningRuns.length || again.events.length || (doc.deliveries ?? []).length) return { status: "running", checkpoint: { phase: "check" } };
					if (doc.task === task.id) delete doc.task;
					return { status: "terminal", outcome: { status: "completed", result: "idle" } };
				}, context);
				if (scan.events.length && await conversationArchived(runtime, id, context)) {
					// After /new the thread belongs to a newer conversation: archived history is never woken (ADR 0096).
					await runtime.commit(async (tx) => {
						const doc = await tx.doc(WakeDoc, id);
						doc.notified = [...doc.notified, ...scan.events.map((event) => event.key)].slice(-WAKE_NOTIFIED_LIMIT);
						return undefined;
					}, context);
				} else if (scan.events.length) {
					const conversation = await runtime.conversation(id, context);
					if (!conversation) return finish();
					const requestId = `${WAKE_REQUEST_PREFIX}${scan.events.map((event) => event.key).join(",")}`;
					const since = Date.now();
					try {
						await conversation.submit({ type: "input", content: wakeMessage(scan.events), requestId, whenBusy: "reject" }, context);
					} catch (error) {
						if (!(error instanceof ConversationBusy)) throw error;
						const run = (await runtime.snapshot(LiveDoc, id, context))?.run?.taskId as TaskId<string> | undefined;
						// Busy without a run (it just ended, or a compaction): look again shortly instead of waiting on unrelated work.
						return runtime.commit(() => ({ status: "running", checkpoint: run === undefined ? { phase: "wait", on: scan.running, retryAt: Date.now() + WAKE_DELIVERY_POLL_MS } : { phase: "busy", run } }), context);
					}
					await runtime.commit(async (tx) => {
						const doc = await tx.doc(WakeDoc, id);
						doc.notified = [...doc.notified, ...scan.events.map((event) => event.key)].slice(-WAKE_NOTIFIED_LIMIT);
						// The wake text shows these run states to the model, as a DAG tool result would.
						const stopped = scan.events.flatMap((event) => event.run ? [event.run] : []);
						if (stopped.length) { const seen = await tx.doc(DagSeenDoc, id); for (const run of stopped) seen.seen[run.id] = run.state; }
						if (deliver && !(doc.deliveries ?? []).some((item) => item.requestId === requestId)) {
							doc.deliveries = [...(doc.deliveries ?? []), { requestId, since, asks: scan.events.flatMap((event) => event.humanAsk ? [event.humanAsk] : []) }];
						}
						return undefined;
					}, context);
				}
				const deliveries = (await runtime.snapshot(WakeDoc, id, context))?.deliveries ?? [];
				if (!scan.running.length && !scan.runningRuns.length && !deliveries.length) return finish();
				// A pending answer settles when the conversation's current run ends; a retry waits for its timer.
				const live = deliveries.length ? (await runtime.snapshot(LiveDoc, id, context))?.run?.taskId as TaskId<string> | undefined : undefined;
				const on = [...scan.running, ...(live === undefined ? [] : [live])];
				const unsettled = deliveries.length > 0 && live === undefined && retryAt === undefined;
				return runtime.commit(() => ({ status: "running", checkpoint: { phase: "wait", on, ...(retryAt !== undefined ? { retryAt } : unsettled ? { retryAt: Date.now() + WAKE_DELIVERY_POLL_MS } : {}) } }), context);
			},
			wait: async (task, runtime, context) => {
				const id = runtime.conversationId;
				const { on, retryAt } = task.state.checkpoint as { on: TaskId<string>[]; retryAt?: number };
				const wake = Promise.withResolvers<void>();
				const waiter = withCancel(context);
				const asks = await runtime.watchDoc(AsksDoc, id, context);
				const runs = await runtime.watchDoc(RunDoc, id, context);
				const openAsks = (value: { asks: AskRecord[] } | null | undefined) => JSON.stringify(value?.asks.filter((ask) => ask.state === "open").map((ask) => ask.id) ?? []);
				const runStates = (value: { runs: RunState[] } | null | undefined) => JSON.stringify(value?.runs.map((run) => [run.id, run.status, run.revision]) ?? []);
				const asksBefore = openAsks(asks?.value), runsBefore = runStates(runs?.value);
				const asksChanged = (value: { asks: AskRecord[] } | null | undefined) => { if (openAsks(value) !== asksBefore) wake.resolve(); };
				const runsChanged = (value: { runs: RunState[] } | null | undefined) => { if (runStates(value) !== runsBefore) wake.resolve(); };
				const onAbort = () => wake.reject(context.abortSignal?.reason ?? new Error("aborted"));
				const timer = retryAt === undefined ? undefined : setTimeout(() => wake.resolve(), Math.max(0, retryAt - Date.now()));
				try {
					context.abortSignal?.addEventListener("abort", onAbort, { once: true });
					if (context.abortSignal?.aborted) onAbort();
					asks?.start(async (value) => asksChanged(value));
					runs?.start(async (value) => runsChanged(value));
					for (const runner of on) runtime.waitForTask(runner, waiter.context).then(() => wake.resolve(), () => {});
					// Asks, runs or settlements committed before the watches started are seen by this re-check.
					asksChanged(await runtime.snapshot(AsksDoc, id, context));
					runsChanged(await runtime.snapshot(RunDoc, id, context));
					// An event committed between the check and these watches is part of their baseline: scan for it.
					if ((await scanWake(wakeReader(runtime, id, context))).events.length) wake.resolve();
					if (!on.length && timer === undefined && !runs?.value?.runs.some((run) => !run.owner && run.status === "running")) wake.resolve();
					await wake.promise;
				} finally {
					if (timer !== undefined) clearTimeout(timer);
					context.abortSignal?.removeEventListener("abort", onAbort);
					waiter.cancel();
					await asks?.stop();
					await runs?.stop();
				}
				await runtime.commit(() => ({ status: "running", checkpoint: { phase: "check" } }), context);
			},
			busy: async (task, runtime, context) => {
				await runtime.waitForTask((task.state.checkpoint as { run: TaskId<string> }).run, context);
				await runtime.commit(() => ({ status: "running", checkpoint: { phase: "check" } }), context);
			},
		},
		abort: async (task, runtime, context) => {
			await runtime.commit(async (tx) => {
				const doc = await tx.doc(WakeDoc, runtime.conversationId);
				if (doc.task === task.id) delete doc.task;
				return { status: "terminal", outcome: { status: "aborted" } };
			}, context);
		},
	});
	/**
	 * Starts the conversation's watcher when an answer leaves something behind that will need the orchestrator — an owned
	 * background child or ordinary DAG run still running, an event not yet announced, or a woken answer not yet handed to
	 * the channel — and none is live.
	 */
	async function armWake(tx: Tx, conversationId: ConversationId) {
		// Most answers leave nothing behind: no owned background child, no ordinary run, no open ask, nothing to hand over.
		// (An open ask the watcher announces always comes from an owned child or a run, so asks need no check here.)
		const agents = await tx.doc(AgentsDoc, conversationId);
		const runs = (await tx.doc(RunDoc, conversationId)).runs.filter((run) => !run.owner);
		const doc = await tx.doc(WakeDoc, conversationId);
		if (!agents.agents.some((ref) => ref.background && !ref.owner) && !runs.length && !(doc.deliveries ?? []).length) return;
		// Adopt runs that predate DagSeenDoc: one still running is announced when it stops, a stopped one is history.
		const seen = await tx.doc(DagSeenDoc, conversationId);
		for (const run of runs) if (!(run.id in seen.seen)) seen.seen[run.id] = run.status === "running" ? "adopted" : runStateKey(run);
		if (doc.task !== undefined && (await tx.task(doc.task))?.state.status !== "terminal") return;
		const scan = await scanTx(tx, conversationId, doc);
		if (!scan.running.length && !scan.runningRuns.length && !scan.events.length && !(doc.deliveries ?? []).length) return;
		doc.task = await tx.createTask(wakeWatcher, {}, { conversationId, ownership: { kind: "conversation" }, background: true });
	}
	/** The wake scan inside a transaction (armWake and the watcher's final decision share it). */
	async function scanTx(tx: Tx, conversationId: ConversationId, doc: { notified: string[] }) {
		const seen = await tx.doc(DagSeenDoc, conversationId);
		return scanWake({
			self: conversationId,
			agents: () => tx.doc(AgentsDoc, conversationId),
			progress: (ref) => tx.doc(ProgressDoc, conversationId, String(ref.runnerId), null),
			asks: () => tx.doc(AsksDoc, conversationId),
			notified: async () => doc.notified,
			runs: () => tx.doc(RunDoc, conversationId),
			seen: async () => seen.seen,
			seenAsks: async () => seen.asks ?? [],
			topLevel: async () => (await tx.doc(LinkDoc, conversationId)).parent === undefined,
		});
	}
	/**
	 * Startup (ADR 0096): a conversation whose ordinary DAG run is running or whose woken answer is not yet handed over
	 * gets its watcher, even if it never answers again — including runs started by an earlier version, which had none.
	 */
	if (wake.recovery) wake.recovery.current = async (context: Context) => {
		const harness = getHarness();
		let page = await harness.commit((tx) => tx.scanConversations({}, 128), context);
		for (;;) {
			for (const conversation of page.items) {
				const running = (await harness.snapshot(RunDoc, conversation.id, context))?.runs.some((run) => !run.owner && run.status === "running");
				const pending = (await harness.snapshot(WakeDoc, conversation.id, context))?.deliveries?.length;
				if (running || pending) await harness.commit((tx) => armWake(tx, conversation.id), context);
			}
			if (!page.next) break;
			page = await harness.commit((tx) => tx.scanConversations({}, 128, page.next!), context);
		}
	};
	return defineExtension({
		name: "subagents",
		tasks: [runner, wakeWatcher],
		hooks: [hook(GenerationTask, {
			onYield: async (_answer, api, context) => {
				await getHarness().commit((tx) => armWake(tx, api.conversationId), context);
				return undefined;
			},
		})],
		tools: [
			defineTool({
				name: TASK_TOOL,
				description: `Delegate one task to an independent subagent. Call task several times in one turn for parallel work. Foreground calls return the final answer; run_in_background=true returns a taskId to collect with task_output. explore receives read-only research instructions.\n\nAvailable subagents:\n${available}`,
				parameters: Type.Object({
					description: Type.String({ minLength: 1 }), prompt: Type.String({ minLength: 1 }),
					subagent_type: Type.Optional(Type.String()),
					run_in_background: Type.Optional(Type.Boolean()),
					model: Type.Optional(Type.String()),
				}),
				replay: "safe", executionMode: "parallel",
				execute: async ({ description, prompt, subagent_type = "general-purpose", run_in_background = false, model: requestedModel }, api, context) => {
					const definition = definitions.get(subagent_type);
					if (!definition && subagent_type !== "general-purpose" && subagent_type !== "explore") {
						return { isError: true, content: [{ type: "text", text: `Unknown subagent type "${subagent_type}". Available: ${["general-purpose", "explore", ...definitions.keys()].join(", ")}` }] };
					}
					const ref = await spawn({ description, prompt, subagentType: subagent_type, background: run_in_background, ...(requestedModel ? { model: requestedModel } : {}) }, api, context);
					if (run_in_background) {
						const state = await readProgress(api, ref, context);
						return { content: [{ type: "text", text: `Started ${ref.taskId}. Use task_output to collect its answer.` }], details: { subagent: state.subagent } };
					}
					// Own the child through setup and waiting, until background promotion commits.
					let background = false;
					try {
						const watch = await api.watchDoc(ProgressDoc, api.conversationId, String(ref.runnerId), context);
						if (!watch) throw new Error("Subagent progress watch is missing");
						let lastPush = 0;
						let timer: ReturnType<typeof setTimeout> | undefined;
						let pending: Promise<void> | undefined;
						try {
							let latest = (await readProgress(api, ref, context)).subagent;
							const publish = () => pending ??= new Promise<void>((resolve, reject) => {
								timer = setTimeout(() => {
									timer = undefined;
									lastPush = Date.now();
									api.details({ subagent: latest } satisfies TaskDetails, context).then(resolve, reject);
								}, Math.max(0, lastPush + 100 - Date.now()));
							}).finally(() => { pending = undefined; });
							await publish();
							watch.start(async (state) => {
								if (state?.subagent) { latest = clone(state.subagent); await publish(); }
							});
							const wake = await waitForChildrenOrAsk(api, [ref], context);
							await watch.stop();
							if (wake.kind === "ask") {
								// Promote: the child keeps running as a background subagent while this conversation answers.
								const promoted = await api.commit(async (tx) => {
									const agents = await tx.doc(AgentsDoc, api.conversationId);
									const entry = agents.agents.find((item) => item.runnerId === ref!.runnerId);
									if (entry) entry.background = true;
									const doc = await tx.doc(ProgressDoc, api.conversationId, String(ref!.runnerId), null);
									if (doc.subagent) doc.subagent.background = true;
									return doc.subagent ? clone(doc.subagent) : undefined;
								}, context);
								background = true;
								if (promoted) latest = promoted;
								if (pending) await pending;
								await publish();
								return { content: [{ type: "text", text: askNotice(wake.asks) }], details: { subagent: latest, asks: wake.asks } };
							}
							const state = await readProgress(api, ref, context);
							latest = state.subagent;
							if (pending) await pending;
							await publish();
							await markDelivered(api, [ref], context);
							return {
								content: [{ type: "text", text: state.answer || `${latest.taskId}: ${latest.status}${latest.error ? ` (${latest.error})` : ""}` }],
								details: { subagent: latest }, isError: latest.status !== "completed",
							};
						} finally {
							await watch.stop();
							if (pending) await pending;
							if (timer) clearTimeout(timer);
						}
					} finally {
						if (!background) await cancelChild(ref);
					}
				},
			}),
			defineTool({
				name: TASK_OUTPUT_TOOL,
				description: "Collect subagent answers and status. Omit task_ids to collect all background subagents in this conversation. With block (default true) it returns as soon as any listed subagent whose answer was not yet collected finishes, a subagent asks, or timeout_ms (default 120000, at most 300000) passes; it does not wait for all of them. Each finished answer is returned once; later calls summarize it unless include_delivered is true. A timeout does not cancel the subagent. You do not need to wait: if you answer the user while subagents run, the host wakes this conversation when one finishes or asks.",
				parameters: Type.Object({
					task_ids: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),
					block: Type.Optional(Type.Boolean()),
					timeout_ms: Type.Optional(Type.Integer({ minimum: 0 })),
					include_delivered: Type.Optional(Type.Boolean()),
				}),
				replay: "safe",
				execute: async ({ task_ids, block = true, timeout_ms = 120_000, include_delivered = false }, api, context) => {
					const known = (await api.snapshot(AgentsDoc, api.conversationId, context))?.agents ?? [];
					const refs = task_ids ? known.filter((ref) => task_ids.includes(ref.taskId)) : known.filter((ref) => ref.background);
					const missing = task_ids?.filter((id) => !known.some((ref) => ref.taskId === id)) ?? [];
					if (missing.length) return { isError: true, content: [{ type: "text", text: `Unknown subagent: ${missing.join(", ")}` }], details: { subagents: [] } };
					const read = () => Promise.all(refs.map((ref) => readProgress(api, ref, context)));
					let states = await read();
					// Wake on the first new event: an uncollected answer already waiting returns at once; otherwise wait for any
					// running child (not all of them), an ask, or the timeout.
					const ready = states.some((state) => state.subagent.status !== "running" && !state.delivered);
					const running = refs.filter((_, i) => states[i]!.subagent.status === "running");
					let wake: Wake | undefined;
					const capped = timeout_ms > maxWaitMs;
					if (block && timeout_ms > 0 && running.length && !ready) {
						wake = await waitForChildrenOrAsk(api, running, context, Math.min(timeout_ms, maxWaitMs), true);
						states = await read();
					}
					const cappedNotice = capped && wake?.kind === "timeout"
						? [`Waited the ${formatWait(maxWaitMs)} maximum (timeout_ms is capped). Tell the user the current progress now instead of waiting again silently; the host wakes this conversation when a subagent finishes or asks.`]
						: [];
					const asks = wake?.kind === "ask" ? wake.asks : openAsksFrom(await api.snapshot(AsksDoc, api.conversationId, context), new Set(refs.map((ref) => ref.conversationId)));
					const lines = states.map((state) => collectionLine(state, include_delivered));
					await markDelivered(api, refs.filter((_, i) => states[i]!.subagent.status !== "running" && !states[i]!.delivered), context);
					return {
						content: [{ type: "text", text: [...(asks.length ? [askNotice(asks)] : []), ...cappedNotice, ...lines].join("\n\n") || "No background subagents." }],
						details: { subagents: states.map((state) => state.subagent), ...(asks.length ? { asks } : {}) },
					};
				},
			}),
			defineTool({
				name: KILL_TASK_TOOL,
				description: "Cancel a subagent belonging to this conversation and wait for it to stop. Already finished subagents stay unchanged.",
				parameters: Type.Object({ task_id: Type.String({ minLength: 1 }) }),
				replay: "safe",
				execute: async ({ task_id }, api, context) => {
					const ref = (await api.snapshot(AgentsDoc, api.conversationId, context))?.agents.find((ref) => ref.taskId === task_id);
					if (!ref) return { isError: true, content: [{ type: "text", text: `Unknown subagent: ${task_id}` }], details: { subagents: [] } };
					// The same admission line as task_message: a note is admitted either before this abort (and withdrawn by it) or after.
					await withConversationAdmission(getHarness(), ref.conversationId, () => getHarness().abortTask(ref.runnerId, context));
					await api.waitForTask(ref.runnerId, context);
					const state = await readProgress(api, ref, context);
					// The caller already knows how this child ended; the idle wake must not announce it again.
					await markDelivered(api, [ref], context);
					return { content: [{ type: "text", text: `${task_id} [${state.subagent.status}]` }], details: { subagents: [state.subagent] } };
				},
			}),
			defineTool({
				name: TASK_MESSAGE_TOOL,
				description: "Send a mid-run note to a running subagent this conversation started with task. The note queues in the child's inbox and joins its current run at the next tool round boundary (steer); a long tool call delays delivery and no tool is interrupted mid-flight. Returns once the note is placed in the child's run, not when the child finishes; collect its answer with task_output as usual. Finished, unknown, DAG-managed and research-managed tasks are rejected; answer open asks with answer instead.",
				parameters: Type.Object({
					task_id: Type.String({ minLength: 1 }),
					text: Type.String({ minLength: 1, maxLength: 4000 }),
					key: Type.Optional(Type.String({ minLength: 1, maxLength: 64, description: "Idempotency key: retries with the same key deliver one note. Defaults to this tool call, so a replay never delivers twice." })),
				}),
				replay: "safe", executionMode: "parallel",
				execute: async ({ task_id, text, key }, api, context) => {
					const reject = (message: string, subagents: SubagentProgress[] = []) => ({ isError: true, content: [{ type: "text" as const, text: message }], details: { subagents } });
					// Ownership: only AgentRefs recorded in this conversation are addressable; other threads' children are invisible here.
					const ref = (await api.snapshot(AgentsDoc, api.conversationId, context))?.agents.find((item) => item.taskId === task_id);
					if (!ref) return reject(`Unknown subagent: ${task_id}`);
					// DAG nodes and research reviewers follow their own protocols (independence, replans); an orchestrator note would bypass them.
					if (ref.owner) return reject(`${task_id} is managed by a ${ref.owner === "dag" ? "DAG run" : "research mission"}; task_message only steers subagents started with task`);
					const harness = getHarness();
					// Default to the durable call id: a replay of this call reuses its submission instead of minting a second note.
					const requestId = `subagent-message:${ref.runnerId}:${key ?? api.callId}`;
					let rejection: string | undefined;
					let note: Submission | undefined;
					let reused = false;
					let withdrawal: Promise<Awaited<ReturnType<Harness["abortSubmission"]>> | "failed"> | undefined;
					const withdraw = () => {
						// The cancelled tool context can no longer run cleanup: withdraw on the bot lifetime (the ADR 0057 steer contract).
						if (note && !withdrawal) withdrawal = harness.abortSubmission(note.id, BACKGROUND_CONTEXT, ref.conversationId).catch(() => "failed" as const);
					};
					// Submit on the child's admission line, which kill_task's abort request also takes.
					await withConversationAdmission(harness, ref.conversationId, async () => {
						// A retry of this key (or a replay of this call) reports the existing note, even after the child finished.
						const existing = await api.commit((tx) => tx.submissionByRequest(ref.conversationId, requestId), context);
						if (existing) {
							note = await harness.submission(existing.id, context);
							reused = true;
							if (!note) rejection = `Message ${requestId} is missing`;
						} else {
							const running = (await api.snapshot(ProgressDoc, api.conversationId, String(ref.runnerId), context))?.subagent?.status === "running";
							if (!running) { rejection = `${task_id} is not running; spawn a new task instead`; return; }
							const child = await api.conversation(ref.conversationId, context);
							if (!child) { rejection = "Subagent conversation is missing"; return; }
							// The original prompt must still own an active run: a settle in between would put this note in a run the collector never reads.
							const original = await api.commit((tx) => tx.submissionByRequest(ref.conversationId, `subagent:${ref.runnerId}`), context);
							if (original === undefined || (original.status !== "queued" && original.status !== "placed")) {
								rejection = `${task_id} has already settled; spawn a new task instead`;
								return;
							}
							note = await child.submit({ type: "input", content: `[from orchestrator] ${text}`, requestId, whenBusy: "steer" }, context);
						}
						// Only this call's own note (first admission or replay) is withdrawn on cancellation, never another caller's keyed note.
						if (note && (!reused || key === undefined)) {
							context.abortSignal?.addEventListener("abort", withdraw, { once: true });
							if (context.abortSignal?.aborted) withdraw();
						}
					});
					if (rejection !== undefined) return reject(rejection);
					const admitted = note;
					if (admitted === undefined) return reject(`Message to ${task_id} was not admitted`);
					try {
						// Publish admission so clients see the queued note while this call waits for the child's boundary.
						await api.details({ subagents: [(await readProgress(api, ref, context)).subagent] }, context);
						const record = await waitForPlacement(api, ref.conversationId, admitted, context);
						if (record.type !== "input") return reject(`Message ${requestId} is not an input`);
						if (record.status === "queued") return reject(`Message to ${task_id} is still queued; the child reads it at its next boundary`);
						if (record.status === "unanswered" && record.entry === undefined) {
							const hint = reused && key !== undefined ? "; pass a new key to send it again" : "";
							return reject(`Message not delivered to ${task_id}: ${record.reason}${hint}`, [(await readProgress(api, ref, context)).subagent]);
						}
						// Placed in a run: count each delivered submission once (parallel retries of one key share it).
						await api.commit(async (tx) => {
							const doc = await tx.doc(ProgressDoc, api.conversationId, String(ref.runnerId), null);
							if (!doc.subagent) return;
							const seen = doc.subagent.messageSubmissions ?? [];
							if (seen.includes(Number(admitted.id))) return;
							doc.subagent.messageSubmissions = [...seen, Number(admitted.id)].slice(-32);
							doc.subagent.messages = (doc.subagent.messages ?? 0) + 1;
						}, context);
						// Joined the original task's run when that run is still active, or both settled together with one answer
						// (endRun settles a run's inputs atomically). Otherwise the original had finished: the note ran as a new turn
						// that no collector reads, so this call returns that turn's answer itself (the residual TOCTOU window).
						const original = await api.commit((tx) => tx.submissionByRequest(ref.conversationId, `subagent:${ref.runnerId}`), context);
						const joined = original?.type === "input" && (original.status === "queued" || original.status === "placed"
							|| (original.status === "done" && record.status === "done" && original.answer === record.answer));
						if (joined) {
							return {
								content: [{ type: "text", text: `Message delivered to ${task_id}: it joined its current run. Collect the child's answer with task_output.` }],
								details: { subagents: [(await readProgress(api, ref, context)).subagent] },
							};
						}
						const settled = await admitted.wait(context);
						const answerEntry = settled.type === "input" && settled.status === "done" ? settled.answer : undefined;
						if (answerEntry === undefined) {
							return reject(`Message reached ${task_id} after its task had finished, and that turn ended ${settled.status === "unanswered" ? settled.reason : settled.status}`, [(await readProgress(api, ref, context)).subagent]);
						}
						const answer = await api.commit(async (tx) => assistantText((await tx.entry(answerEntry))?.model), context);
						return {
							content: [{ type: "text", text: `Message reached ${task_id} after its task had finished; the note ran as a new turn and the child answered: ${answer || "(empty answer)"}` }],
							details: { subagents: [(await readProgress(api, ref, context)).subagent] },
						};
					} catch (error) {
						if (!context.abortSignal?.aborted) throw error;
						const outcome = withdrawal ? await withdrawal : undefined;
						const detail = outcome === "aborted" ? "the queued note was withdrawn"
							: outcome === "already_placed" || outcome === "settled" ? "the note had already reached the child, which still reads it"
							: outcome === "failed" || outcome === "not_found" ? "withdrawing the note failed; the child may still read it"
							: "the note was left as it was";
						return reject(`Message call cancelled; ${detail}.`);
					} finally {
						context.abortSignal?.removeEventListener("abort", withdraw);
					}
				},
			}),
		],
	});
}

/** Like Claude Code, a file without frontmatter or without `name` is documentation kept beside the agents: skipped. */
function parseAgent(file: string, content: string): AgentDefinition | undefined {
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(content);
	if (match === null) return undefined;
	const frontmatter = Bun.YAML.parse(match[1] ?? "");
	if (!isRecord(frontmatter)) throw new Error("frontmatter must be an object");
	if (frontmatter["name"] === undefined) return undefined;

	const problems: string[] = [];
	const name = frontmatter["name"];
	const description = frontmatter["description"];
	const tools = frontmatter["tools"];
	const model = frontmatter["model"];
	if (typeof name !== "string" || name.length === 0) problems.push("name is required");
	else if (name.startsWith("-") || name.includes(":")) problems.push('name must not start with "-" or contain ":"');
	if (typeof description !== "string" || description.length === 0) problems.push("description is required");
	if (
		tools !== undefined &&
		typeof tools !== "string" &&
		(!Array.isArray(tools) || tools.some((tool) => typeof tool !== "string"))
	) {
		problems.push("tools must be a comma-separated string or string list");
	}
	if (model !== undefined && typeof model !== "string") problems.push("model must be a string");
	if (problems.length > 0) throw new Error(problems.join("; "));

	const parsedTools =
		typeof tools === "string"
			? tools
					.split(",")
					.map((tool) => tool.trim())
					.filter((tool) => tool.length > 0)
			: Array.isArray(tools)
				? tools.filter((tool): tool is string => typeof tool === "string")
				: undefined;
	return {
		name: typeof name === "string" ? name : "",
		description: typeof description === "string" ? description : "",
		...(parsedTools === undefined ? {} : { tools: [...parsedTools] }),
		...(typeof model === "string" ? { model } : {}),
		prompt: match[2]?.trim() ?? "",
	};
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isToolRegistration(tool: Tool): tool is ToolRegistration {
	return "execute" in tool && typeof tool.execute === "function";
}

export function resolveModel(value: string, parent: ModelRef | undefined): ModelRef | undefined {
	if (value === "inherit") return parent;
	const slash = value.indexOf("/");
	if (slash !== -1) return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
	if (parent === undefined) throw new Error(`Cannot inherit a provider for model "${value}"`);
	return { provider: parent.provider, modelId: value };
}

function formatWait(ms: number): string {
	return ms % 60_000 === 0 ? `${ms / 60_000}-minute` : ms % 1000 === 0 ? `${ms / 1000}-second` : `${ms}-millisecond`;
}
