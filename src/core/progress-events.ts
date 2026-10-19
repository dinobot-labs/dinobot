import type { Context } from "@earendil-works/chord";
import { type AgentEvent, type ConversationId, type Harness, type SubmissionId, watchEvents } from "@earendil-works/pi-durable";
import { detailPreview, redactSecrets, safePreview as preview, safeHint } from "../channels/safe-preview.ts";
import type { ProgressEvent, ProgressSink } from "../channels/types.ts";

/** Minimum spacing of `activity` events, so streaming tokens and tool output cannot flood a channel. */
export const ACTIVITY_INTERVAL_MS = 5_000;
/** Minimum spacing of `draft` snapshots (ADR 0057). */
export const DRAFT_INTERVAL_MS = 500;
/** Longest draft tail sent, in UTF-16 units; the card shows a tail anyway. */
export const DRAFT_TAIL_UNITS = 4_000;
const TODO_CHARS = 200;

/** Options of the mapping: the turn's own submission so other placed inputs count as steers. */
export type ProgressMappingOptions = { readonly now?: () => number; readonly own?: SubmissionId };

type Todo = { status?: unknown; content?: unknown };
function todos(details: unknown): ProgressEvent | undefined {
	if (typeof details !== "object" || details === null || !Array.isArray((details as { todos?: unknown }).todos)) return undefined;
	const list = ((details as { todos: unknown[] }).todos as Todo[]).filter((todo) => typeof todo === "object" && todo !== null);
	const active = list.filter((todo) => todo.status !== "cancelled");
	const done = active.filter((todo) => todo.status === "completed").length;
	const current = active.find((todo) => todo.status === "in_progress")?.content;
	const line = typeof current === "string" ? redactSecrets(current.replace(/\s+/g, " ").trim()).slice(0, TODO_CHARS) : "";
	return { type: "todos", done, total: active.length, ...(line !== "" ? { current: line } : {}) };
}

type InnerCall = { id: unknown; name: unknown; status: unknown; preview?: unknown; detail?: unknown; startedAt?: unknown; endedAt?: unknown };

/** Text blocks of a partial assistant message, joined; thinking and tool calls are not answer text. */
function textOf(message: { content?: unknown } | undefined): string {
	if (!message || !Array.isArray(message.content)) return "";
	return (message.content as { type?: unknown; text?: unknown }[]).map((block) => (block?.type === "text" && typeof block.text === "string" ? block.text : "")).join("");
}
/** The last DRAFT_TAIL_UNITS units without splitting a surrogate pair. */
export function draftTail(text: string): string {
	if (text.length <= DRAFT_TAIL_UNITS) return text;
	let start = text.length - DRAFT_TAIL_UNITS;
	const unit = text.charCodeAt(start);
	if (unit >= 0xdc00 && unit <= 0xdfff) start++;
	return text.slice(start);
}
function innerCalls(details: unknown): InnerCall[] {
	if (typeof details !== "object" || details === null) return [];
	const calls = (details as { codemodeCalls?: unknown }).codemodeCalls;
	return Array.isArray(calls) ? calls.filter((call): call is InnerCall => typeof call === "object" && call !== null) : [];
}

/**
 * Maps one conversation's agent events to progress events. Stateful only for what it must remember: codemode inner
 * calls already reported, the last todo summary, and the last `activity` time. Never throws on unexpected shapes.
 *
 * Pairing (J): each inner call id gets at most one `tool_start` and at most one `tool_end`, the end after the start.
 * Once its codemode cell ends, every inner call it started has ended (an unfinished one, e.g. after an abort, ends as
 * failed), and later updates of that cell report nothing new.
 */
export function agentProgress(sink: ProgressSink, options: ProgressMappingOptions | (() => number) = {}): (events: readonly AgentEvent[]) => void {
	const { now = Date.now, own } = typeof options === "function" ? { now: options } : options;
	let lastActivity = Number.NEGATIVE_INFINITY;
	let lastTodos = "";
	/** Draft state (ADR 0057): text blocks of the in-flight assistant message, the last snapshot sent and its time. */
	let blocks: string[] = [];
	let lastDraft = "";
	let lastDraftAt = Number.NEGATIVE_INFINITY;
	let draftDirty = false;
	const draft = (force: boolean) => {
		const text = draftTail(blocks.join(""));
		if (text === lastDraft) { draftDirty = false; return; }
		if (!force && now() - lastDraftAt < DRAFT_INTERVAL_MS) { draftDirty = true; return; }
		lastDraft = text;
		lastDraftAt = now();
		draftDirty = false;
		if (text !== "") emit({ type: "draft", text });
	};
	const outer = new Map<string, "running" | "ended">();
	/** `${toolCallId}/${innerId}` -> reported state. */
	const inner = new Map<string, "running" | "ended">();
	/** Codemode cell -> its inner ids reported as started and not yet ended. */
	const runningInner = new Map<string, Set<string>>();
	/** Codemode cells whose end has been seen. */
	const endedCells = new Set<string>();
	const emit = (event: ProgressEvent) => {
		if (event.type === "todos") {
			const key = JSON.stringify(event);
			if (key === lastTodos) return;
			lastTodos = key;
		}
		if (event.type === "activity") {
			if (now() - lastActivity < ACTIVITY_INTERVAL_MS) return;
			lastActivity = now();
		}
		try {
			sink(event);
		} catch {
			// A sink must not throw; if it does, progress is dropped, never the turn.
		}
	};
	const endInner = (toolCallId: string, id: string, ok: boolean, at?: number) => {
		inner.set(id, "ended");
		runningInner.get(toolCallId)?.delete(id);
		emit({ type: "tool_end", id, ok, ...(at !== undefined ? { at } : {}) });
	};
	const reportInner = (toolCallId: string, details: unknown) => {
		if (endedCells.has(toolCallId)) return;
		for (const call of innerCalls(details)) {
			if (call.status === "pending" || (call.startedAt === undefined && call.endedAt !== undefined)) continue;
			if (typeof call.name !== "string" || (typeof call.id !== "number" && typeof call.id !== "string")) continue;
			const id = `${toolCallId}/${call.id}`;
			const finished = call.status === "done" || call.status === "failed" || call.status === "aborted";
			if (!inner.has(id)) {
				inner.set(id, "running");
				let running = runningInner.get(toolCallId);
				if (!running) runningInner.set(toolCallId, (running = new Set()));
				running.add(id);
				emit({ type: "tool_start", id, name: call.name, ...(typeof call.preview === "string" && safeHint(call.preview) ? { preview: safeHint(call.preview)! } : {}), ...(typeof call.detail === "string" && call.detail !== "" ? { detail: redactSecrets(call.detail).slice(0, 200) } : {}), ...(typeof call.startedAt === "number" && Number.isSafeInteger(call.startedAt) ? { at: call.startedAt } : {}) });
			}
			if (finished && inner.get(id) === "running") endInner(toolCallId, id, call.status === "done", typeof call.endedAt === "number" && Number.isSafeInteger(call.endedAt) ? call.endedAt : undefined);
		}
	};
	/** The cell ended: close what its final journal left open, then ignore the cell. */
	const endCell = (toolCallId: string) => {
		for (const id of [...(runningInner.get(toolCallId) ?? [])]) endInner(toolCallId, id, false);
		runningInner.delete(toolCallId);
		endedCells.add(toolCallId);
	};
	return (events) => {
		for (const event of events) {
			switch (event.type) {
				case "tool_execution_start":
					if (outer.has(event.toolCallId)) break;
					outer.set(event.toolCallId, "running");
					emit({ type: "tool_start", id: event.toolCallId, name: event.toolName, ...(preview(event.args) ? { preview: preview(event.args)! } : {}), ...(detailPreview(event.args) ? { detail: detailPreview(event.args)! } : {}) });
					if (event.toolName === "todo_write") {
						const listed = todos(event.args);
						if (listed) emit(listed);
					}
					break;
				case "tool_execution_update": {
					const listed = todos(event.details);
					if (listed) emit(listed);
					if (event.toolName === "codemode") reportInner(event.toolCallId, event.details);
					emit({ type: "activity" });
					break;
				}
				case "tool_execution_end": {
					const result = event.entry?.model?.[0] as { isError?: unknown; details?: unknown } | undefined;
					if (event.toolName === "codemode") {
						reportInner(event.toolCallId, result?.details);
						endCell(event.toolCallId);
					}
					const listed = todos(result?.details);
					if (listed) emit(listed);
					if (outer.get(event.toolCallId) === "running") emit({ type: "tool_end", id: event.toolCallId, ok: event.entry !== undefined && result?.isError !== true });
					outer.set(event.toolCallId, "ended");
					break;
				}
				case "message_start": {
					// The first publication of a generation can already carry text; later deltas append to it.
					const content = Array.isArray(event.message.content) ? event.message.content : [];
					blocks = content.map((block) => textOf({ content: [block] }));
					lastDraft = "";
					if (blocks.some((text) => text !== "")) draft(false);
					break;
				}
				case "message_update":
					for (const change of event.changes) {
						if (change.type === "thinking_start") emit({ type: "phase", phase: "thinking" });
						else if (change.type === "text_start") {
							emit({ type: "phase", phase: "writing" });
							blocks[change.contentIndex] = textOf({ content: [change.block] });
						} else if (change.type === "text_delta") blocks[change.contentIndex] = (blocks[change.contentIndex] ?? "") + change.delta;
						else if (change.type === "block" && (change.block as { type?: unknown }).type === "text") blocks[change.contentIndex] = textOf({ content: [change.block] });
						else if (change.type === "message") blocks = [textOf(change.message)];
					}
					draft(false);
					emit({ type: "activity" });
					break;
				case "message_end": {
					const model = (event.entry as { model?: unknown }).model;
					const message = Array.isArray(model) ? (model as { role?: unknown; content?: unknown }[]).find((m) => m?.role === "assistant") : undefined;
					if (message) blocks = [textOf(message)];
					draft(true);
					break;
				}
				case "submission":
					if (event.record.type === "input" && event.record.status === "placed" && event.record.id !== own) emit({ type: "steer" });
					break;
				case "auto_retry_start":
					emit({ type: "retry", attempt: event.attempt });
					break;
				case "snapshot":
					// A coalesced stream: resynchronize the draft from the generation's partial instead of lost deltas.
					if (event.generation?.message) { blocks = [textOf(event.generation.message)]; draft(true); }
					break;
				default:
					emit({ type: "activity" });
			}
		}
		if (draftDirty) draft(false);
	};
}

/**
 * Streams a conversation's progress into `sink` until the returned stop is called. Best effort: a failed attachment
 * returns a no-op stop and the turn proceeds without progress.
 */
export async function watchProgress(harness: Harness, conversationId: ConversationId, sink: ProgressSink, context: Context, own?: SubmissionId): Promise<() => Promise<void>> {
	try {
		const stream = await watchEvents(harness, conversationId, context);
		const map = agentProgress(sink, own === undefined ? {} : { own });
		stream.start(async (events) => map(events));
		return async () => {
			await stream.stop().catch(() => undefined);
		};
	} catch {
		return async () => {};
	}
}
