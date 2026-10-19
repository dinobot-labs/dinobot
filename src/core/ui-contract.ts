import type { AgentEvent, SnapshotEvent } from "@earendil-works/pi-durable";
import type { RunStatus } from "./dag.ts";
import type { NodeKind } from "./plan.ts";
import type { WorkflowStatus } from "./verification.ts";
export type { PlanCheck, PlanRequirement, PlanState, WorkPlan, WorkflowStatus } from "./verification.ts";

/**
 * JSON shapes the bot's built-in tools put in tool `details` and the TUI renders (Grok Build style).
 * Producers: src/extensions/todo.ts, src/extensions/subagents.ts. Consumer: src/tui/**.
 */

export const TODO_TOOL = "todo_write";
export const TASK_TOOL = "task";
export const TASK_OUTPUT_TOOL = "task_output";
export const KILL_TASK_TOOL = "kill_task";
export const TASK_MESSAGE_TOOL = "task_message";
export const SESSION_SEARCH_TOOL = "session_search";
export const SESSION_LIST_TOOL = "session_list";
export const SESSION_READ_TOOL = "session_read";
export const SESSION_ANALYZE_TOOL = "session_analyze";
export const WORK_CLAIM_TOOL = "work_claim";
export const WORK_RELEASE_TOOL = "work_release";
/** Entry kind of a recalled project memory note (core/memory/recall.ts); `data.items` lists the recalled keys. */
export const MEMORY_NOTE_KIND = "dinobot.nudge";
export type MemoryNoteData = { schema: 1; items: { key: string; revision: number }[] };
/** Prompt section of the working agreements (core/memory/agreements.ts); each agreement is one `- [id] ...` line. */
export const AGREEMENTS_SECTION = "working_agreements";

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";
export type TodoItem = { id: string; content: string; status: TodoStatus; workId?: string };
/** The whole list after the call; the latest successful `todo_write` result is the current list. */
export type TodoDetails = { todos: TodoItem[] };

export type SubagentStatus = "running" | "completed" | "failed" | "cancelled";
export type SubagentProgress = {
	/** Handle for `task_output` / `kill_task`. */
	taskId: string;
	description: string;
	subagentType: string;
	background: boolean;
	/** Child conversation; stream it with GET /v1/conversations/:id/events. */
	conversationId: number;
	status: SubagentStatus;
	/** Epoch ms. */
	startedAt: number;
	endedAt?: number;
	currentTool?: string;
	toolCount: number;
	/** Last line of the subagent's latest assistant text, at most 200 characters. */
	lastText?: string;
	/** Output tokens used so far. */
	tokens?: number;
	/** Distinct orchestrator messages delivered mid-run through `task_message`. */
	messages?: number;
	/** The submission ids behind `messages`, capped to the last 32, so parallel retries of one key count once. */
	messageSubmissions?: number[];
	error?: string;
	/** Task settlement is separate from this host-validated coding outcome. */
	workflow?: WorkflowStatus;
};
/** `task`: live `details` updates while a foreground subagent runs; the final details at return. */
export type TaskDetails = { subagent: SubagentProgress };
/** `task_output` and `kill_task`: the subagents the call reported on. */
export type TaskOutputDetails = { subagents: SubagentProgress[] };

/** Parent SSE sends durable progress after its snapshot and on changes; callId links admission before tool details. */
export type SubagentProgressEvent = { type: "subagent_progress"; subagents: SubagentProgress[]; callId?: string };
export type WorkflowStatusEvent = { type: "workflow_status"; workflow: WorkflowStatus | null };

/**
 * Client projection of the conversation's active DAG run (ADR 0032). Producer: src/core/dag-view.ts via the
 * parent SSE stream. Consumer: src/tui/panes/dag.ts and the /dag picker. Layout fields (`level`, `parents`, node
 * order) depend only on the compiled plan, never on node states, so rows keep their place while a run progresses.
 */
export type DagNodeState = "pending" | "ready" | "running" | "waiting" | "succeeded" | "failed" | "skipped";
export type DagNodeView = {
	id: string;
	kind: NodeKind;
	/** First non-empty line of the node description, at most 120 columns; empty when there is none. */
	title: string;
	/** `ready` is derived: pending and in the executor frontier (what the next dag_step dispatches). */
	state: DagNodeState;
	/** Longest-path depth from a source, 0-based: every edge goes from a lower to a strictly higher level. */
	level: number;
	/** Transitive reduction of the node's direct parents, in display order: same reachability, fewest edges. */
	parents: string[];
	/** Every compiled direct parent, in display order. Readiness is decided on these, not on `parents`. */
	directParents: string[];
	/** Attempts under the current key and the executor's per-key budget. */
	attempt: number;
	maxAttempts: number;
	/** Executor handle: a subagent task id (`sa-...`), `orchestrator` for ask nodes, `check:<id>` for checks. */
	handle?: string;
	/** Epoch ms of the current or last attempt. */
	startedAt?: number;
	endedAt?: number;
	/** First line of the last error or result, at most 200 columns. */
	error?: string;
	result?: string;
	covers: string[];
	/** On the compiled critical path. */
	critical: boolean;
};
/** UI projection only; candidate lineage is independent of DAG execution edges. */
export type ResearchView = {
	id: string;
	revision: number;
	question: string;
	status: string;
	judgment?: string;
	stopReason?: string;
	deadlineAt: number;
	attempts: { used: number; limit: number };
	rounds: { used: number; limit: number };
	candidateBudget: { used: number; limit: number };
	activeAttempts: number;
	maxConcurrent: number;
	confirmationReserved: number;
	incumbentId?: string;
	selectedId?: string;
	candidates: Array<{
		id: string;
		parentId?: string;
		operation: string;
		state: string;
		hypothesis: string;
		value?: number;
		unit?: string;
		delta?: number;
		validity?: string;
		verdict?: string;
		feedback: string;
		runId?: string;
		nodeId?: string;
	}>;
	report: { directory: string; state: string; writtenRevision?: number; error?: string };
};
export type DagView = {
	id: string;
	revision: number;
	status: RunStatus;
	reason?: string;
	replanBudget: number;
	requirements: { id: string; certified: boolean }[];
	/** Number of waves (distinct levels); 0 when the plan did not compile. */
	levels: number;
	/** Display order: by level, then compiled (Kahn) order. */
	nodes: DagNodeView[];
	diagnostics?: string[];
	updatedAt: number;
	research?: ResearchView;
};
/** Parent SSE sends the active run's view after its snapshot and whenever the view changes; null clears it. */
export type DagStatusEvent = { type: "dag_status"; dag: DagView | null };
/**
 * One input waiting in `pi.inbox` for its boundary, in submission ID order. `text` is the sender's original text without
 * the `<from>` header; `steer` lands after the current tool round, `followUp` after the answer.
 */
export type QueuedInput = { id: number; mode: "steer" | "followUp"; text: string; userId?: string };
/** Parent SSE sends the thread's queued inputs after its snapshot and whenever they change; writes are not listed. */
export type QueueStatusEvent = { type: "queue_status"; items: QueuedInput[] };
export type ClientSnapshotEvent = SnapshotEvent & { workflow?: WorkflowStatus | null; dag?: DagView | null; queue?: QueuedInput[] };
export type ClientEvent = Exclude<AgentEvent, SnapshotEvent> | ClientSnapshotEvent | SubagentProgressEvent | WorkflowStatusEvent | DagStatusEvent | QueueStatusEvent;
