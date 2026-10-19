import type { AssistantMessage, JsonObject, Message, ToolResultMessage, Usage, UserMessage } from "@earendil-works/pi-ai";
import type { EntryRecord, MessageChange, SnapshotEvent } from "@earendil-works/pi-durable";
import {
	KILL_TASK_TOOL,
	type ClientEvent,
	type ClientSnapshotEvent,
	type DagView,
	type QueuedInput,
	type WorkflowStatus,
	type SubagentProgress,
	TASK_MESSAGE_TOOL,
	TASK_OUTPUT_TOOL,
	TASK_TOOL,
	type TaskDetails,
	type TaskOutputDetails,
	TODO_TOOL,
	type TodoDetails,
	type TodoItem,
	MEMORY_NOTE_KIND,
	type MemoryNoteData,
	AGREEMENTS_SECTION,
} from "../core/ui-contract.ts";

type BlockBase = { readonly id: string; version: number };
export type UserBlock = BlockBase & { kind: "user"; text: string; at: number; images?: readonly { readonly mimeType: string; readonly data: string }[] };
export type AgentBlock = BlockBase & { kind: "agent"; text: string; at: number; streaming: boolean };
export type ThinkingBlock = BlockBase & { kind: "thinking"; text: string; startedAt: number; endedAt?: number; streaming: boolean };
export type ToolStatus = "pending" | "running" | "done" | "error" | "cancelled";
export type ToolBlock = BlockBase & {
	kind: "tool";
	callId: string;
	name: string;
	args: JsonObject;
	status: ToolStatus;
	output: string;
	result?: string;
	details?: unknown;
	startedAt?: number;
	endedAt?: number;
};
export type SubagentBlock = BlockBase & { kind: "subagent"; callId: string; progress: SubagentProgress };
export type NoticeLevel = "info" | "error" | "turn";
/** Measured throughput and prompt-cache hit ratio; each part is absent when it was not measured. */
export type CallMetrics = { tps?: number; cacheRatio?: number };
/** Sums over the live turn's model calls: output/generation time only for timed calls, cache/prompt for every live call. */
export type TurnMetrics = { outputTokens: number; generationMs: number; cacheRead: number; promptTokens: number };
export type ChatMetrics = {
	/** The latest completed live model call. */
	call?: CallMetrics | undefined;
	turn: TurnMetrics;
	/** First content update of the streaming assistant message; null when the stream began before this client saw it. */
	firstTokenAt?: number | null | undefined;
};
export type NoticeBlock = BlockBase & { kind: "notice"; text: string; level: NoticeLevel; elapsedMs?: number; metrics?: CallMetrics };
export type Block = UserBlock | AgentBlock | ThinkingBlock | ToolBlock | SubagentBlock | NoticeBlock;

export type RunPhase = "waiting_response" | "thinking" | "responding" | "tool" | "waiting_subagents" | "compacting" | "retry";
export type RunState = { startedAt: number; phase: RunPhase; phaseStartedAt: number; tool?: string; retry?: string };
export type UsageTotals = { contextTokens: number; totalTokens: number; cost: number };
export type AgentInfo = { model?: { provider: string; modelId: string }; cwd?: string };

export type ChatData = {
	workflow: WorkflowStatus | null;
	/** Revision of the last change to the workflow's visible content; shares the monotone `revision` clock with `todosVersion`. */
	workflowVersion: number;
	/** The thread's shown DAG run (ADR 0032), null when it has none. */
	dag: DagView | null;
	/** Revision of the last change to `dag`; shares the monotone `revision` clock. */
	dagVersion: number;
	blocks: Block[];
	todos: TodoItem[];
	todosVersion: number;
	subagents: Map<string, SubagentProgress>;
	subagentsVersion: number;
	/** Asks observed in tool details (ADR 0030): id → latest record. Human-targeted open asks also raise a notice. */
	asks: Map<string, AskView>;
	// createChatData spells these out as undefined so a fresh value has every key.
	run?: RunState | undefined;
	lastTurnMs?: number | undefined;
	/** Inputs waiting in the thread's inbox, from the server's queue view (snapshot `queue`, then `queue_status`). */
	queue: QueuedInput[];
	usage: UsageTotals;
	metrics: ChatMetrics;
	agent: AgentInfo;
	revision: number;
	dirty: Set<string>;
	structure: number;
	seenEntries: Set<number>;
	live: number[];
	toolRows: Map<string, number>;
	subagentRows: Map<string, number>;
	subagentRowsByTask: Map<string, number>;
};

export const HIDDEN_TOOLS: ReadonlySet<string> = new Set([TODO_TOOL, TASK_TOOL, TASK_OUTPUT_TOOL, KILL_TASK_TOOL, TASK_MESSAGE_TOOL]);
export const isHiddenTool = (name: string): boolean => HIDDEN_TOOLS.has(name);

export function createChatData(): ChatData {
	return {
		workflow: null,
		workflowVersion: 0,
		dag: null,
		dagVersion: 0,
		run: undefined,
		lastTurnMs: undefined,
		blocks: [],
		todos: [],
		todosVersion: 0,
		subagents: new Map(),
		subagentsVersion: 0,
		asks: new Map(),
		queue: [],
		usage: { contextTokens: 0, totalTokens: 0, cost: 0 },
		metrics: emptyMetrics(),
		agent: {},
		revision: 0,
		dirty: new Set(),
		structure: 0,
		seenEntries: new Set(),
		live: [],
		toolRows: new Map(),
		subagentRows: new Map(),
		subagentRowsByTask: new Map(),
	};
}

const emptyMetrics = (): ChatMetrics => ({ turn: { outputTokens: 0, generationMs: 0, cacheRead: 0, promptTokens: 0 } });

/** Shortest generation window that yields a tok/s figure; shorter bursts are noise. */
export const MIN_TPS_WINDOW_MS = 250;

const tpsOf = (outputTokens: number, durationMs: number): number | undefined =>
	outputTokens > 0 && durationMs >= MIN_TPS_WINDOW_MS ? outputTokens / (durationMs / 1000) : undefined;
const ratioOf = (cacheRead: number, promptTokens: number): number | undefined => (promptTokens > 0 ? cacheRead / promptTokens : undefined);

/** Metrics of one model call; `durationMs` is first content update to final message, absent when not measured. */
export function callMetrics(usage: Usage, durationMs?: number): CallMetrics {
	const tps = durationMs === undefined ? undefined : tpsOf(usage.output, durationMs);
	const cacheRatio = ratioOf(usage.cacheRead, usage.input + usage.cacheRead + usage.cacheWrite);
	return { ...(tps === undefined ? {} : { tps }), ...(cacheRatio === undefined ? {} : { cacheRatio }) };
}

/** Turn-level metrics from the aggregates: sum output / sum duration, sum cacheRead / sum prompt. */
export function turnMetrics(turn: TurnMetrics): CallMetrics {
	const tps = tpsOf(turn.outputTokens, turn.generationMs);
	const cacheRatio = ratioOf(turn.cacheRead, turn.promptTokens);
	return { ...(tps === undefined ? {} : { tps }), ...(cacheRatio === undefined ? {} : { cacheRatio }) };
}

/** `48 tok/s`, one decimal below 10 (`7.5 tok/s`). */
export const formatTps = (tps: number): string => `${tps < 10 ? tps.toFixed(1) : Math.round(tps)} tok/s`;
/** `cache 92%` for a 0..1 ratio. */
export const formatCacheRatio = (ratio: number): string => `cache ${Math.round(ratio * 100)}%`;

const bump = (data: ChatData): number => ++data.revision;
const touch = (data: ChatData, block: Block): void => {
	block.version = bump(data);
	data.dirty.add(block.id);
};
let nextId = 0;
const newId = (prefix: string): string => `${prefix}-${++nextId}`;

function push(data: ChatData, block: Block): number {
	block.version = bump(data);
	data.dirty.add(block.id);
	data.blocks.push(block);
	return data.blocks.length - 1;
}

function removeAt(data: ChatData, index: number): void {
	data.blocks.splice(index, 1);
	for (const map of [data.toolRows, data.subagentRows, data.subagentRowsByTask]) {
		for (const [key, row] of map) {
			if (row === index) map.delete(key);
			else if (row > index) map.set(key, row - 1);
		}
	}
	data.live = data.live.map((row) => (row === index ? -1 : row > index ? row - 1 : row));
	data.structure++;
	bump(data);
}

function notice(data: ChatData, text: string, level: NoticeLevel, elapsedMs?: number, metrics?: CallMetrics): void {
	push(data, {
		kind: "notice",
		id: newId("notice"),
		version: 0,
		text,
		level,
		...(elapsedMs === undefined ? {} : { elapsedMs }),
		...(metrics === undefined ? {} : { metrics }),
	});
}

function setPhase(data: ChatData, phase: RunPhase, now: number, tool?: string): void {
	if (!data.run) return;
	if (data.run.phase === phase && data.run.tool === tool) return;
	data.run = { ...data.run, phase, phaseStartedAt: now, ...(tool === undefined ? {} : { tool }) };
	if (tool === undefined) delete data.run.tool;
	bump(data);
}

function startRun(data: ChatData, now: number): void {
	if (data.run) return;
	data.run = { startedAt: now, phase: "waiting_response", phaseStartedAt: now };
	data.metrics = emptyMetrics();
	bump(data);
}

function endRun(data: ChatData, now: number): void {
	if (!data.run) return;
	data.lastTurnMs = now - data.run.startedAt;
	delete data.run;
	finishStreaming(data, now);
	notice(data, "Worked for", "turn", data.lastTurnMs, turnMetrics(data.metrics.turn));
}

/** A live call finished: only messages that ended inside a run this client watched carry measured usage. */
function recordCall(data: ChatData, usage: Usage, now: number): void {
	const { firstTokenAt } = data.metrics;
	const durationMs = typeof firstTokenAt === "number" ? now - firstTokenAt : undefined;
	const call = callMetrics(usage, durationMs);
	const turn = { ...data.metrics.turn };
	if (call.tps !== undefined && durationMs !== undefined) {
		turn.outputTokens += usage.output;
		turn.generationMs += durationMs;
	}
	if (call.cacheRatio !== undefined) {
		turn.cacheRead += usage.cacheRead;
		turn.promptTokens += usage.input + usage.cacheRead + usage.cacheWrite;
	}
	data.metrics = { call, turn };
	bump(data);
}

function finishStreaming(data: ChatData, now: number): void {
	for (const row of data.live) {
		const block = data.blocks[row];
		if (!block) continue;
		if (block.kind === "agent" && block.streaming) {
			block.streaming = false;
			touch(data, block);
		} else if (block.kind === "thinking" && block.streaming) {
			block.streaming = false;
			block.endedAt = now;
			touch(data, block);
		}
	}
	data.live = [];
}

const userText = (message: UserMessage): string => {
	const raw = typeof message.content === "string" ? message.content : message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
	return raw.replace(/^<from [^>]*\/>\n/, "");
};

const resultText = (message: ToolResultMessage): string =>
	message.content.map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join("\n");

const contextTokensOf = (usage: Usage): number => usage.input + usage.cacheRead + usage.cacheWrite + usage.output;

const isTaskDetails = (details: unknown): details is TaskDetails =>
	typeof details === "object" && details !== null && typeof (details as TaskDetails).subagent === "object" && (details as TaskDetails).subagent !== null;
const isTaskOutputDetails = (details: unknown): details is TaskOutputDetails =>
	typeof details === "object" && details !== null && Array.isArray((details as TaskOutputDetails).subagents);
const isTodoDetails = (details: unknown): details is TodoDetails =>
	typeof details === "object" && details !== null && Array.isArray((details as TodoDetails).todos);

function provisionalProgress(args: JsonObject, now: number): SubagentProgress {
	return {
		taskId: "",
		description: typeof args.description === "string" ? args.description : "",
		subagentType: typeof args.subagent_type === "string" ? args.subagent_type : "general-purpose",
		background: args.run_in_background === true,
		conversationId: 0,
		status: "running",
		startedAt: now,
		toolCount: 0,
	};
}

function subagentRow(data: ChatData, callId: string, args: JsonObject, now: number): SubagentBlock {
	const row = data.subagentRows.get(callId);
	const existing = row === undefined ? undefined : data.blocks[row];
	if (existing?.kind === "subagent") return existing;
	const block: SubagentBlock = { kind: "subagent", id: newId("subagent"), version: 0, callId, progress: provisionalProgress(args, now) };
	data.subagentRows.set(callId, push(data, block));
	return block;
}

function recordProgress(data: ChatData, progress: SubagentProgress, callId?: string): void {
	// Tool slots may replay older running details after the durable runner has settled.
	const previous = data.subagents.get(progress.taskId);
	const current = progress.status === "running" && previous && previous.status !== "running" ? previous : progress;
	data.subagents.set(progress.taskId, current);
	data.subagentsVersion = bump(data);
	let row = data.subagentRowsByTask.get(progress.taskId);
	if (row === undefined && callId !== undefined) row = data.subagentRows.get(callId);
	if (row === undefined) return;
	const block = data.blocks[row];
	if (block?.kind !== "subagent") return;
	block.progress = current;
	touch(data, block);
	data.subagentRowsByTask.set(progress.taskId, row);
}

export type AskView = { id: string; to: "main" | "human"; kind: string; question: string; from: string; state: string; answer?: string; default: string; deadlineAt: number; options?: string[] };

function isAskView(value: unknown): value is Omit<AskView, "options"> & { options?: unknown } {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const v = value as Record<string, unknown>;
	return typeof v.id === "string" && (v.to === "main" || v.to === "human") && typeof v.question === "string" && typeof v.state === "string" && typeof v.default === "string" && typeof v.deadlineAt === "number";
}

/** Asks carried by ask/answer/task/task_output/dag_step details: `ask`, `relayed` or `asks[]`. */
export function asksIn(details: unknown): AskView[] {
	if (typeof details !== "object" || details === null || Array.isArray(details)) return [];
	const d = details as Record<string, unknown>;
	const out: AskView[] = [];
	for (const candidate of [d.ask, d.relayed, ...(Array.isArray(d.asks) ? d.asks : [])]) {
		if (!isAskView(candidate)) continue;
		const from: unknown = (candidate as { from?: unknown }).from;
		const label = typeof from === "object" && from !== null
			? String((from as { taskId?: unknown }).taskId ?? (from as { conversationId?: unknown }).conversationId ?? "")
			: String(from ?? "");
		// Malformed display choices must not hide an otherwise valid question.
		const { options, ...ask } = candidate;
		out.push({ ...ask, from: label, ...(Array.isArray(options) && options.every(option => typeof option === "string") ? { options: [...options] } : {}) });
	}
	return out;
}

/** Idempotent on content; a human ask raises one notice when it opens and one when it resolves. */
function recordAsks(data: ChatData, details: unknown): void {
	for (const ask of asksIn(details)) {
		const previous = data.asks.get(ask.id);
		if (previous && JSON.stringify(previous) === JSON.stringify(ask)) continue;
		data.asks.set(ask.id, ask);
		bump(data);
		if (ask.to !== "human") continue;
		if (ask.state === "open" && previous?.state !== "open") notice(data, `Question for you [${ask.kind}]: ${ask.question}\nAnswer in chat; default "${ask.default}" applies at ${new Date(ask.deadlineAt).toISOString()}.${ask.options ? `\nChoices: ${ask.options.map((option, index) => `${index + 1}) ${option}`).join("  ")} — /choose to pick, or answer in chat.` : ""}`, "info");
		else if (ask.state !== "open" && previous?.state === "open") notice(data, `Question ${ask.state}: ${ask.answer ?? ask.default}`, "info");
	}
}

function applyHiddenDetails(data: ChatData, name: string, details: unknown, isError: boolean, callId?: string): void {
	recordAsks(data, details);
	if (name === "codemode") {
		// Inner tool receipts remain valid even if a later statement in the cell fails.
		if (isTodoDetails(details)) applyHiddenDetails(data, TODO_TOOL, details, false);
		if (isTaskDetails(details)) recordProgress(data, details.subagent, callId);
		if (isTaskOutputDetails(details)) for (const progress of details.subagents) recordProgress(data, progress);
		return;
	}
	if (name === TODO_TOOL) {
		if (!isError && isTodoDetails(details)) {
			data.todos = details.todos.map((todo) => ({ ...todo }));
			data.todosVersion = bump(data);
		}
		return;
	}
	if (name === TASK_TOOL && isTaskDetails(details)) recordProgress(data, details.subagent, callId);
	if ((name === TASK_OUTPUT_TOOL || name === KILL_TASK_TOOL || name === TASK_MESSAGE_TOOL) && isTaskOutputDetails(details)) {
		for (const progress of details.subagents) recordProgress(data, progress);
	}
}

function toolRow(data: ChatData, callId: string, name: string, args: JsonObject): ToolBlock {
	const row = data.toolRows.get(callId);
	const existing = row === undefined ? undefined : data.blocks[row];
	if (existing?.kind === "tool") return existing;
	const block: ToolBlock = { kind: "tool", id: newId("tool"), version: 0, callId, name, args, status: "pending", output: "" };
	data.toolRows.set(callId, push(data, block));
	return block;
}

function placeLive(data: ChatData, contentIndex: number, block: Block): void {
	const row = data.live[contentIndex];
	const current = row === undefined || row < 0 ? undefined : data.blocks[row];
	if (current && current.kind === block.kind) return;
	if (current) {
		removeAt(data, row as number);
	}
	const index = push(data, block);
	while (data.live.length < contentIndex) data.live.push(-1);
	data.live[contentIndex] = index;
}

function liveBlock(data: ChatData, contentIndex: number): Block | undefined {
	const row = data.live[contentIndex];
	return row === undefined || row < 0 ? undefined : data.blocks[row];
}

function applyContentBlock(data: ChatData, contentIndex: number, content: AssistantMessage["content"][number], now: number, final: boolean): void {
	closeThinking(data, contentIndex, now);
	switch (content.type) {
		case "text": {
			let block = liveBlock(data, contentIndex);
			if (block?.kind !== "agent") {
				placeLive(data, contentIndex, { kind: "agent", id: newId("agent"), version: 0, text: "", at: now, streaming: true });
				block = liveBlock(data, contentIndex);
			}
			if (block?.kind !== "agent") return;
			if (block.text !== content.text || block.streaming === final) {
				block.text = content.text;
				block.streaming = !final;
				touch(data, block);
			}
			if (!final && content.text.trim() !== "") setPhase(data, "responding", now);
			return;
		}
		case "thinking": {
			let block = liveBlock(data, contentIndex);
			if (block?.kind !== "thinking") {
				placeLive(data, contentIndex, { kind: "thinking", id: newId("thinking"), version: 0, text: "", startedAt: now, streaming: true });
				block = liveBlock(data, contentIndex);
			}
			if (block?.kind !== "thinking") return;
			if (block.text !== content.thinking || block.streaming === final) {
				block.text = content.thinking;
				if (final) {
					block.streaming = false;
					block.endedAt ??= now;
				}
				touch(data, block);
			}
			if (!final) setPhase(data, "thinking", now);
			return;
		}
		case "toolCall": {
			if (isHiddenTool(content.name)) {
				if (content.name === TASK_TOOL) {
					const block = subagentRow(data, content.id, content.arguments, now);
					const row = data.subagentRows.get(content.id);
					if (row !== undefined) {
						while (data.live.length <= contentIndex) data.live.push(-1);
						data.live[contentIndex] = row;
					}
					if (block.progress.description === "" && typeof content.arguments.description === "string") {
						block.progress = { ...block.progress, description: content.arguments.description };
						touch(data, block);
					}
				}
				return;
			}
			const existing = liveBlock(data, contentIndex);
			if (existing?.kind === "tool" && existing.callId === content.id) {
				if (final && JSON.stringify(existing.args) !== JSON.stringify(content.arguments)) {
					existing.args = content.arguments;
					touch(data, existing);
				}
				return;
			}
			const block = toolRow(data, content.id, content.name, content.arguments);
			const row = data.toolRows.get(content.id);
			if (row !== undefined) {
				while (data.live.length <= contentIndex) data.live.push(-1);
				data.live[contentIndex] = row;
			}
			if (block.args !== content.arguments) {
				block.args = content.arguments;
				touch(data, block);
			}
			return;
		}
	}
}

function closeThinking(data: ChatData, contentIndex: number, now: number): void {
	for (let index = 0; index < Math.min(contentIndex, data.live.length); index++) {
		const block = liveBlock(data, index);
		if (block?.kind === "thinking" && block.streaming) {
			block.streaming = false;
			block.endedAt = now;
			touch(data, block);
		}
	}
}

export function applyMessageChanges(data: ChatData, changes: readonly MessageChange[], now: number): void {
	for (const change of changes) {
		switch (change.type) {
			case "message":
				applyAssistantMessage(data, change.message, now, false);
				break;
			case "text_start":
			case "thinking_start":
			case "toolcall_start":
			case "block":
				applyContentBlock(data, change.contentIndex, change.block, now, change.type === "block");
				break;
			case "text_delta": {
				const block = liveBlock(data, change.contentIndex);
				if (block?.kind === "agent") {
					block.text += change.delta;
					touch(data, block);
				} else {
					applyContentBlock(data, change.contentIndex, { type: "text", text: change.delta }, now, false);
				}
				setPhase(data, "responding", now);
				break;
			}
			case "thinking_delta": {
				const block = liveBlock(data, change.contentIndex);
				if (block?.kind === "thinking") {
					block.text += change.delta;
					touch(data, block);
				} else {
					applyContentBlock(data, change.contentIndex, { type: "thinking", thinking: change.delta }, now, false);
				}
				setPhase(data, "thinking", now);
				break;
			}
			case "toolcall_delta":
				break;
		}
	}
}

function applyAssistantMessage(data: ChatData, message: AssistantMessage, now: number, final: boolean): void {
	message.content.forEach((content, index) => applyContentBlock(data, index, content, now, final));
	for (let index = message.content.length; index < data.live.length; index++) {
		const row = data.live[index];
		if (row !== undefined && row >= 0) removeAt(data, row);
	}
	data.live.length = Math.min(data.live.length, message.content.length);
	if (final) {
		for (const row of data.live) {
			const block = data.blocks[row];
			if (block?.kind === "agent") {
				block.at = message.timestamp;
				block.streaming = false;
				touch(data, block);
			} else if (block?.kind === "thinking" && block.streaming) {
				block.streaming = false;
				block.endedAt = now;
				touch(data, block);
			}
		}
		data.live = [];
		const unconfigured = /^Provider is not configured: (.+)$/.exec(message.errorMessage ?? "");
		if (message.stopReason === "error" && unconfigured) notice(data, `Not signed in to ${unconfigured[1]} yet. Run /login to connect it, then send again.`, "info");
		else if (message.stopReason === "error") notice(data, message.errorMessage ?? "model error", "error");
		else if (message.stopReason === "aborted") notice(data, "Stopped.", "info");
		if (data.run) recordCall(data, message.usage, now);
	}
	if (contextTokensOf(message.usage) > 0) setContextTokens(data, message.usage);
}

function setContextTokens(data: ChatData, usage: Usage): void {
	const context = contextTokensOf(usage);
	if (context === data.usage.contextTokens) return;
	data.usage = { ...data.usage, contextTokens: context };
	bump(data);
}

export function ingestEntry(data: ChatData, entry: EntryRecord, now: number): void {
	if (data.seenEntries.has(entry.id)) return;
	data.seenEntries.add(entry.id);
	const message = entry.model?.[0] as Message | undefined;
	switch (entry.kind) {
		case "pi.user":
			if (message?.role === "user") {
				const images = Array.isArray(message.content)
					? message.content.filter((part) => part.type === "image").map((part) => ({ mimeType: part.mimeType, data: part.data }))
					: undefined;
				push(data, { kind: "user", id: newId("user"), version: 0, text: userText(message), at: message.timestamp, ...(images !== undefined && images.length > 0 ? { images } : {}) });
			}
			return;
		case "pi.assistant":
			if (message?.role === "assistant") applyAssistantMessage(data, message, now, true);
			return;
		case "pi.tool-result":
			if (message?.role === "toolResult") ingestToolResult(data, message, now, isAbortedResult(entry));
			return;
		case "pi.reset":
			notice(data, "New context", "info");
			return;
		case "pi.compaction":
			notice(data, "Context compacted", "info");
			return;
		case "pi.system": {
			// The working agreements reach the model as a section patch: show when they changed for this conversation.
			const text = (message as { sections?: Record<string, string | null> } | undefined)?.sections?.[AGREEMENTS_SECTION];
			if (text === undefined) return;
			const count = text === null ? 0 : text.split("\n").filter((row) => row.startsWith("- [")).length;
			notice(data, count === 0 ? "Working agreements: none in effect" : `Working agreements: ${count} in effect`, "info");
			return;
		}
		case MEMORY_NOTE_KIND: {
			const items = (entry.data as MemoryNoteData | undefined)?.items ?? [];
			notice(data, `Recalled ${items.length} project ${items.length === 1 ? "memory" : "memories"}${items.length ? `: ${items.map((item) => item.key).join(", ")}` : ""}`, "info");
			return;
		}
		default:
			return;
	}
}

/** Durable records the terminal reason separately from tool-provided text and child receipts. */
function isAbortedResult(entry: EntryRecord): boolean {
	const data = entry.data;
	return typeof data === "object" && data !== null && !Array.isArray(data) && Array.isArray(data.diagnostics)
		&& data.diagnostics.some(item => typeof item === "object" && item !== null && !Array.isArray(item)
			&& item.code === "aborted" && item.severity === "error");
}

function ingestToolResult(data: ChatData, message: ToolResultMessage, now: number, cancelled = false): void {
	if (message.toolName === "codemode") applyHiddenDetails(data, message.toolName, message.details, message.isError, message.toolCallId);
	if (isHiddenTool(message.toolName)) {
		let details = message.details;
		if (message.toolName === TASK_TOOL && message.isError && isTaskDetails(details) && details.subagent.status === "running") {
			const authoritative = data.subagents.get(details.subagent.taskId);
			details = { subagent: authoritative && authoritative.status !== "running" ? authoritative : {
				...details.subagent, status: "failed", endedAt: now, error: resultText(message),
			} };
		}
		applyHiddenDetails(data, message.toolName, details, message.isError, message.toolCallId);
		if (message.isError) {
			const text = resultText(message).replace(/<\/?harness>/g, "").trim();
			const aborted = cancelled || /^\[error\] Tool task was aborted$/.test(text);
			if (message.toolName === TASK_TOOL) {
				const row = data.subagentRows.get(message.toolCallId);
				const block = row === undefined ? undefined : data.blocks[row];
				if (block?.kind === "subagent" && block.progress.status === "running") {
					block.progress = aborted
						? { ...block.progress, status: "cancelled", endedAt: now }
						: { ...block.progress, status: "failed", endedAt: now, error: text };
					if (block.progress.taskId) recordProgress(data, block.progress, message.toolCallId);
					else touch(data, block);
				}
			}
			if (!aborted) notice(data, text, "error");
		}
		if (data.run && (message.toolName === TASK_TOOL || message.toolName === TASK_OUTPUT_TOOL)) setPhase(data, "waiting_response", now);
		return;
	}
	const block = toolRow(data, message.toolCallId, message.toolName, {});
	block.status = cancelled ? "cancelled" : message.isError ? "error" : "done";
	block.result = resultText(message);
	if (message.details !== undefined) { block.details = message.details; recordAsks(data, message.details); }
	block.endedAt ??= now;
	touch(data, block);
	if (data.run?.tool === message.toolName) setPhase(data, "waiting_response", now);
}

/** Equal content keeps its version, so a repeated host update never steals the pane's tab from a newer todo change. */
function setWorkflow(data: ChatData, workflow: WorkflowStatus | null): void {
	if (JSON.stringify(workflow) === JSON.stringify(data.workflow)) return;
	data.workflow = workflow;
	data.workflowVersion = bump(data);
}

/** Same dedupe as `setWorkflow`: a republished equal view keeps its version. */
function setDag(data: ChatData, dag: DagView | null): void {
	if (JSON.stringify(dag) === JSON.stringify(data.dag)) return;
	data.dag = dag;
	data.dagVersion = bump(data);
}

function reduceSnapshot(data: ChatData, event: ClientSnapshotEvent, now: number): void {
	const fresh = createChatData();
	fresh.revision = data.revision;
	fresh.structure = data.structure + 1;
	Object.assign(data, fresh);
	setWorkflow(data, event.workflow ?? null);
	setDag(data, event.dag ?? null);
	for (const entry of event.entries) ingestEntry(data, entry, now);
	data.agent = { ...(event.agent.model ? { model: event.agent.model } : {}), ...(event.agent.cwd !== undefined ? { cwd: event.agent.cwd } : {}) };
	applyUsageLedger(data, event.usage);
	if (event.run) {
		data.run = { startedAt: now, phase: "waiting_response", phaseStartedAt: now };
		if (event.generation?.message) {
			// The stream started before this client attached, so its timing is unknown.
			data.metrics.firstTokenAt = null;
			applyAssistantMessage(data, event.generation.message, now, false);
		}
		for (const slot of event.tools) {
			if (slot.status === "done") continue;
			if (isHiddenTool(slot.name)) {
				if (slot.name === TASK_TOOL) {
					subagentRow(data, slot.callId, {}, now);
					if (isTaskDetails(slot.details)) recordProgress(data, slot.details.subagent, slot.callId);
				}
				if (slot.status === "running") setPhase(data, "waiting_subagents", now, slot.name);
				continue;
			}
			if (slot.name === "codemode") applyHiddenDetails(data, slot.name, slot.details, false, slot.callId);
			const block = toolRow(data, slot.callId, slot.name, {});
			block.status = slot.status;
			block.output = slot.output ?? "";
			if (slot.details !== undefined) block.details = slot.details;
			touch(data, block);
			if (slot.status === "running") setPhase(data, "tool", now, slot.name);
		}
		if (event.generation?.retry) setPhase(data, "retry", now);
	}
	data.queue = event.queue ?? [];
	bump(data);
}

function applyUsageLedger(data: ChatData, usage: SnapshotEvent["usage"]): void {
	let total = 0;
	let cost = 0;
	for (const entry of Object.values(usage.models)) {
		total += entry.totalTokens;
		cost += entry.cost.total;
	}
	data.usage = { ...data.usage, totalTokens: total, cost };
	bump(data);
}

export function reduceEvent(data: ChatData, event: ClientEvent, now: number): void {
	switch (event.type) {
		case "workflow_status":
			setWorkflow(data, event.workflow);
			bump(data);
			return;
		case "dag_status":
			setDag(data, event.dag);
			return;
		case "subagent_progress":
			for (const progress of event.subagents) recordProgress(data, progress, event.callId);
			return;
		case "snapshot":
			reduceSnapshot(data, event, now);
			return;
		case "run_start":
			startRun(data, now);
			return;
		case "run_end":
			endRun(data, now);
			return;
		case "message_start":
			if (event.message.role === "assistant") {
				finishStreaming(data, now);
				delete data.metrics.firstTokenAt;
				setPhase(data, "waiting_response", now);
				// The first publication of a generation can already carry content; later deltas append to it.
				if (event.message.content.length > 0) {
					data.metrics.firstTokenAt = now;
					applyAssistantMessage(data, event.message, now, false);
				}
			}
			return;
		case "message_update":
			if (data.metrics.firstTokenAt === undefined && event.changes.length > 0) data.metrics.firstTokenAt = now;
			applyMessageChanges(data, event.changes, now);
			setContextTokens(data, event.usage);
			return;
		case "message_end":
		case "entry_appended":
			ingestEntry(data, event.entry, now);
			return;
		case "tool_execution_start": {
			if (isHiddenTool(event.toolName)) {
				if (event.toolName === TASK_TOOL) subagentRow(data, event.toolCallId, event.args, now);
				setPhase(data, event.toolName === TODO_TOOL ? "tool" : "waiting_subagents", now, event.toolName);
				return;
			}
			const block = toolRow(data, event.toolCallId, event.toolName, event.args);
			block.status = "running";
			block.startedAt = now;
			block.args = event.args;
			touch(data, block);
			setPhase(data, "tool", now, event.toolName);
			return;
		}
		case "tool_execution_update": {
			if (event.toolName === "codemode") applyHiddenDetails(data, event.toolName, event.details, false, event.toolCallId);
			if (isHiddenTool(event.toolName)) {
				if (event.details !== undefined) applyHiddenDetails(data, event.toolName, event.details, false, event.toolCallId);
				return;
			}
			const row = data.toolRows.get(event.toolCallId);
			const block = row === undefined ? undefined : data.blocks[row];
			if (block?.kind !== "tool") return;
			if (event.output) {
				if ("set" in event.output) block.output = event.output.set;
				else {
					if (event.output.trimStart) block.output = block.output.slice(event.output.trimStart);
					if (event.output.append) block.output += event.output.append;
				}
			}
			if (event.details !== undefined) block.details = event.details;
			touch(data, block);
			return;
		}
		case "tool_execution_end": {
			if (event.entry) ingestEntry(data, event.entry, now);
			else if (!isHiddenTool(event.toolName)) {
				const block = toolRow(data, event.toolCallId, event.toolName, {});
				block.status = "error";
				block.result ??= "tool task faulted";
				block.endedAt ??= now;
				touch(data, block);
			}
			if (data.run?.tool === event.toolName) setPhase(data, "waiting_response", now);
			return;
		}
		case "queue_status":
			data.queue = event.items;
			bump(data);
			return;
		case "auto_retry_start":
			if (data.run) {
				data.run = { ...data.run, phase: "retry", phaseStartedAt: now, retry: `attempt ${event.attempt}: ${event.errorMessage}` };
				bump(data);
			}
			return;
		case "auto_retry_end":
			setPhase(data, "waiting_response", now);
			return;
		case "usage_changed":
			applyUsageLedger(data, event.usage);
			return;
		case "agent_changed":
			data.agent = { ...(event.agent.model ? { model: event.agent.model } : {}), ...(event.agent.cwd !== undefined ? { cwd: event.agent.cwd } : {}) };
			bump(data);
			return;
		case "task_failed":
			notice(data, `${event.kind} failed: ${event.message}`, "error");
			return;
		case "compaction_start":
			if (event.blocking) setPhase(data, "compacting", now);
			return;
		case "compaction_end":
			if (data.run?.phase === "compacting") setPhase(data, "waiting_response", now);
			return;
		default:
			return;
	}
}

export const runningSubagents = (data: ChatData): SubagentProgress[] =>
	[...data.subagents.values()].filter((progress) => progress.status === "running");

export type ChatListener = (data: ChatData) => void;

export class ChatState {
	readonly data: ChatData = createChatData();
	private readonly listeners = new Set<ChatListener>();

	apply(event: ClientEvent, now: number = Date.now()): void {
		const before = this.data.revision;
		reduceEvent(this.data, event, now);
		if (this.data.revision !== before) this.notify();
	}

	subscribe(listener: ChatListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	notice(text: string, level: NoticeLevel = "info"): void {
		notice(this.data, text, level);
		this.notify();
	}

	private notify(): void {
		for (const listener of this.listeners) listener(this.data);
	}
}
