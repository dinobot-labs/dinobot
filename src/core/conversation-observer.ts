import type { Context, WatchEnd } from "@earendil-works/chord";
import type { Op } from "@earendil-works/chord/delta";
import type { AssistantMessage, JsonObject } from "@earendil-works/pi-ai";
import type { ConversationId, ConversationView, Cursor, EntryId, EntryRecord, Harness, InboxState, LiveState } from "@earendil-works/pi-durable";
import type { AgentEvent, SnapshotEvent, MessageChange } from "./ui-contract.ts";

const PAGE = 100;
const liveOf = (view: ConversationView): LiveState => (view.docs["pi.live"] ?? {}) as LiveState;
// Native watch values are immutable and structurally shared. Never serialize growing partials to compare them.
const same = Object.is;
const prefix = (path: readonly (string | number)[], base: readonly (string | number)[]) => base.every((p, i) => path[i] === p);

function messageChanges(before: AssistantMessage, message: AssistantMessage, ops?: readonly Op[]): MessageChange[] {
 const replacement = (): MessageChange[] => [{ type: "message", message }];
 if (!ops) return replacement(); // fresh attachment/tail drain has no operation history
 const base = ["docs", "pi.live", "generation", "message"];
 const whole = new Set<number>();
 const deltas = new Map<number, MessageChange[]>();
 for (const op of ops) {
  if (op[0] === "r") return replacement();
  const path = op[1];
  if (prefix(base, path)) return replacement();
  if (!prefix(path, base)) continue;
  if (path[4] !== "content") continue; // usage has its own field on message_update
  if (path.length === 5) {
   if (op[0] !== "p" || op[3] !== 0 || op[2] < before.content.length) return replacement();
   for (let i = op[2]; i < op[2] + op[4].length; i++) whole.add(i);
   continue;
  }
  const index = path[5];
  if (typeof index !== "number" || !message.content[index]) return replacement();
  const block = message.content[index];
  if (op[0] === "a" && path.length === 7 && (path[6] === "text" || path[6] === "thinking")) {
   const list = deltas.get(index) ?? [];
   list.push({ type: path[6] === "text" ? "text_delta" : "thinking_delta", contentIndex: index, delta: op[2] });
   deltas.set(index, list);
  } else if (op[0] === "a" && path[6] === "arguments" && block.type === "toolCall") {
   const list = deltas.get(index) ?? [];
   list.push({ type: "toolcall_delta", contentIndex: index, path: path.slice(7), delta: op[2] });
   deltas.set(index, list);
  } else whole.add(index);
 }
 const changes: MessageChange[] = [];
 for (const index of [...new Set([...whole, ...deltas.keys()])].sort((a, b) => a - b)) {
  if (whole.has(index)) {
   const block = message.content[index];
   if (!block) return replacement();
   const type = before.content[index] ? "block" : block.type === "text" ? "text_start" : block.type === "thinking" ? "thinking_start" : "toolcall_start";
   changes.push({ type, contentIndex: index, block });
  } else changes.push(...deltas.get(index)!);
 }
 return changes;
}

function outputChange(before: string, output: string, index: number, ops?: readonly Op[]): { set?: string; append?: string; trimStart?: number } {
 const base = ["docs", "pi.live", "tools", index, "output"];
 if (!ops) return { set: output };
 let append = "", trimStart = 0, touched = false;
 for (const op of ops) {
  if (op[0] === "r") return { set: output };
  const path = op[1];
  if (!prefix(base, path)) continue;
  if (path.length !== base.length) return { set: output };
  touched = true;
  if (op[0] === "a") append += op[2];
  else if (op[0] === "t") {
   const remaining = before.length - trimStart;
   trimStart += Math.min(op[2], remaining);
   if (op[2] > remaining) append = append.slice(op[2] - remaining);
  } else return { set: output };
 }
 return touched ? { ...(trimStart ? { trimStart } : {}), ...(append ? { append } : {}) } : { set: output };
}

/** Only the attachment snapshot owns the whole history. Subsequent frames use the native bounded window. */
function snapshotOf(view: ConversationView, entries: readonly EntryRecord[]): SnapshotEvent {
 const live = liveOf(view);
 return { type: "snapshot", entries, ...(live.run ? { run: { inputs: live.run.inputs } } : {}),
  ...(live.generation ? { generation: live.generation as NonNullable<SnapshotEvent["generation"]> } : {}),
  tools: live.tools ?? [], compactions: (live.compactions ?? []).map(({ trigger, ...rest }) => ({ ...rest, reason: trigger })),
  inbox: ((view.docs["pi.inbox"] as InboxState | undefined)?.items ?? []).map(({ id, mode }) => ({ id, mode })),
  agent: (view.docs["pi.agent"] ?? {}) as SnapshotEvent["agent"],
  usage: (view.docs["pi.usage"] ?? { models: {}, tools: {} }) as SnapshotEvent["usage"] };
}

export interface ConversationEventStream {
 /** Whole fork-aware history, available until start(). Released at start to avoid an unbounded server cache. */
 readonly snapshot: SnapshotEvent;
 start(listener: (events: readonly AgentEvent[], context: Context) => Promise<void>): void;
 /** Drain committed entries/current state before detaching. Never means the run succeeded. */
 stop(): Promise<WatchEnd>;
 readonly closed: Promise<WatchEnd>;
}

/**
 * One native-state adapter for SSE, channels and subagents. Immutable entries are the source of tool completions;
 * slots only provide live progress. A high-water entry ID deduplicates pages (ID gaps are not counts). Reads are
 * fork-aware, and compaction/reset markers are history entries, not destructive transcript replacements.
 */
export async function watchConversation(harness: Pick<Harness, "conversation" | "submission">, id: ConversationId, context: Context): Promise<ConversationEventStream> {
 const conversation = await harness.conversation(id, context);
 if (!conversation) throw new Error("Conversation is missing");
 const native = await conversation.watch(context, { min: 50, max: PAGE });
 let previous = native.value;
 let high = previous.entries.at(-1)?.id;
 let initial: SnapshotEvent | undefined;
 const active = new Map<string, { name: string; args: JsonObject }>();
 // Only current-round IDs are retained, never every tool ID in conversation history.
 const doneSlots = new Set<string>((liveOf(previous).tools ?? []).filter(s => s.status === "done").map(s => s.callId));
 let listener: ((events: readonly AgentEvent[], context: Context) => Promise<void>) | undefined;
 let delivering = Promise.resolve();
 let stopping: Promise<WatchEnd> | undefined;
 let started = false;
 let listenerFailure: Error | undefined;
 const ended = Promise.withResolvers<WatchEnd>();

 async function pages(min: EntryId | undefined, max: EntryId | undefined, consume: (entries: readonly EntryRecord[]) => Promise<void>) {
  if (max === undefined) return;
  let cursor: Cursor | undefined;
  do {
   const page = await conversation!.entries({ order: "ascending", ...(min === undefined ? {} : { minEntryId: min }), maxEntryId: max }, PAGE, cursor, context);
   await consume(page.items);
   cursor = page.next;
  } while (cursor);
 }
 try {
  const entries: EntryRecord[] = [];
  await pages(undefined, high, async page => { entries.push(...page); });
  initial = snapshotOf(previous, entries);
  const slots = liveOf(previous).tools ?? [];
  for (const slot of slots) if (slot.status !== "done") active.set(slot.callId, { name: slot.name, args: {} });
  for (const entry of entries) for (const message of entry.model ?? []) if (message.role === "assistant") {
   for (const block of message.content) if (block.type === "toolCall" && active.has(block.id)) active.set(block.id, { name: block.name, args: block.arguments });
  }
 } catch (error) { await native.stop(); throw error; }

 const send = async (events: readonly AgentEvent[]) => {
  if (!events.length || !listener) return;
  try { await listener(events, context); } catch (error) {
   // Native stop fixes its result immediately, even while this caller-owned listener is still running.
   listenerFailure ??= error instanceof Error ? error : new Error(String(error));
   throw error;
  }
 };
 const startTool = (events: AgentEvent[], callId: string, name: string, args: JsonObject = {}) => {
  if (active.has(callId) || doneSlots.has(callId)) return;
  active.set(callId, { name, args });
  events.push({ type: "tool_execution_start", toolCallId: callId, toolName: name, args });
 };
 const endTool = (events: AgentEvent[], callId: string, name: string, entry?: EntryRecord) => {
  if (doneSlots.has(callId)) return;
  startTool(events, callId, name);
  events.push({ type: "tool_execution_end", toolCallId: callId, toolName: name, ...(entry ? { entry } : {}) });
  active.delete(callId); doneSlots.add(callId);
 };
 async function advance(view: ConversationView, ops?: readonly Op[]) {
  const was = liveOf(previous), live = liveOf(view);
  const begin: AgentEvent[] = [];
  if (!was.run && live.run) begin.push({ type: "run_start", inputs: live.run.inputs });
  await send(begin);
  const max = view.entries.at(-1)?.id;
  // Always scan the immutable interval: a slow listener can miss entire windows, tool rounds and their slots.
  if (max !== undefined && (high === undefined || max > high)) {
   await pages(high, max, async entries => {
    const batch: AgentEvent[] = [];
    let acceptedHigh = high;
    for (const entry of entries) {
     if (high !== undefined && entry.id <= high) continue;
     for (const message of entry.model ?? []) {
      if (message.role === "assistant") {
       for (const block of message.content) if (block.type === "toolCall") startTool(batch, block.id, block.name, block.arguments);
      } else if (message.role === "toolResult") endTool(batch, message.toolCallId, message.toolName, entry);
     }
     const message = entry.model?.[0];
     if (message) {
      if (message.role !== "assistant" || !was.generation?.message) batch.push({ type: "message_start", message });
      batch.push({ type: "message_end", entry });
     } else batch.push({ type: "entry_appended", entry });
     acceptedHigh = entry.id;
    }
    await send(batch);
    high = acceptedHigh;
    // Entries have their own watermark. Retain only slot IDs to avoid a second unbounded history.
    const slots = new Set((live.tools ?? []).map(slot => slot.callId));
    for (const callId of doneSlots) if (!slots.has(callId)) doneSlots.delete(callId);
   });
  }
  const events: AgentEvent[] = [];
  const slots = live.tools ?? [];
  for (const slot of slots) {
   if (slot.status === "pending") continue;
   if (slot.status === "done") {
    // A result already below high was in the initial snapshot or emitted by the entry scan.
    if (slot.entry !== undefined && high !== undefined && slot.entry <= high) { active.delete(slot.callId); doneSlots.add(slot.callId); }
    else endTool(events, slot.callId, slot.name);
   } else {
    startTool(events, slot.callId, slot.name);
    const prior = was.tools?.find(s => s.callId === slot.callId);
    if (slot !== prior) events.push({ type: "tool_execution_update", toolCallId: slot.callId, toolName: slot.name,
     ...(slot.output !== prior?.output ? { output: outputChange(prior?.output ?? "", slot.output ?? "", slots.indexOf(slot), ops) } : {}),
     ...(slot.details !== prior?.details ? { details: slot.details ?? null } : {}),
     ...(slot.diagnostics !== prior?.diagnostics ? { diagnostics: slot.diagnostics ?? [] } : {}) });
   }
  }
  for (const [callId, tool] of active) if (!slots.some(s => s.callId === callId)) endTool(events, callId, tool.name);
  for (const callId of doneSlots) if (!slots.some(s => s.callId === callId)) doneSlots.delete(callId);
  const partial = live.generation?.message as AssistantMessage | undefined;
  if (partial && !same(partial, was.generation?.message)) {
   if (!was.generation?.message || was.run?.taskId !== live.run?.taskId || was.generation.attempt !== live.generation?.attempt) events.push({ type: "message_start", message: partial });
   else events.push({ type: "message_update", usage: partial.usage, changes: messageChanges(was.generation.message as AssistantMessage, partial, ops) });
  }
  if (live.generation?.retry && !same(live.generation.retry, was.generation?.retry)) events.push({ type: "auto_retry_start", attempt: live.generation.attempt, at: live.generation.retry.at, errorMessage: live.generation.retry.error });
  if (was.generation?.retry && !live.generation?.retry) events.push({ type: "auto_retry_end", attempt: was.generation.attempt });
  if (live.generation?.deferred && !same(live.generation.deferred, was.generation?.deferred)) events.push({ type: "deferred_poll", pollAt: live.generation.deferred.pollAt });
  for (const compaction of was.compactions ?? []) if (!live.compactions?.some(c => c.taskId === compaction.taskId)) events.push({ type: "compaction_end", taskId: compaction.taskId, reason: compaction.trigger });
  for (const compaction of live.compactions ?? []) if (!was.compactions?.some(c => c.taskId === compaction.taskId)) events.push({ type: "compaction_start", taskId: compaction.taskId, reason: compaction.trigger, blocking: compaction.blocking });
  if (live.runFailure && !same(live.runFailure, was.runFailure)) events.push({ type: "task_failed", taskId: live.runFailure.taskId, kind: "run", message: live.runFailure.detail ?? live.runFailure.reason });
  if (live.compactionFailure && !same(live.compactionFailure, was.compactionFailure)) events.push({ type: "task_failed", taskId: live.compactionFailure.taskId, kind: "compaction", message: live.compactionFailure.error });
  const snapshot = snapshotOf(view, []);
  if (!same(previous.docs["pi.usage"], view.docs["pi.usage"])) events.push({ type: "usage_changed", usage: snapshot.usage });
  if (!same(previous.docs["pi.agent"], view.docs["pi.agent"])) events.push({ type: "agent_changed", agent: snapshot.agent });
  if (!same(previous.docs["pi.inbox"], view.docs["pi.inbox"])) events.push({ type: "inbox_update", items: snapshot.inbox });
  const oldInputs = new Set(was.run?.inputs ?? []);
  const queuedBefore = (previous.docs["pi.inbox"] as InboxState | undefined)?.items ?? [];
  const ids = new Set([...(live.run?.inputs ?? []).filter(id => !oldInputs.has(id)), ...queuedBefore.filter(item => !snapshot.inbox.some(i => i.id === item.id)).map(item => item.id)]);
  for (const submissionId of ids) {
   const submission = await harness.submission(submissionId, context);
   if (submission) events.push({ type: "submission", record: await submission.status(context) });
  }
  // Idle is only a presentation boundary. Only the submission receipt proves success.
  if (was.run && !live.run) events.push({ type: "run_end", inputs: was.run.inputs });
  await send(events);
  previous = view;
 }
 async function finish(end: WatchEnd): Promise<WatchEnd> {
  await delivering.catch(() => undefined);
  if (listenerFailure) return { kind: "listener_error", error: listenerFailure };
  // Source shutdown drops queued native frames. It cannot prove a terminal receipt was delivered,
  // and the session may already reject reads. Reconnect to durable history instead of inventing an outcome.
  if (end.kind === "ended") return { kind: "failed", error: new Error("Conversation source closed; reconnect to recover undelivered state") };
  if (end.kind === "stopped" && started) {
   const events: AgentEvent[] = [];
   for (const [id, tool] of active) endTool(events, id, tool.name);
   try { await send(events); } catch (error) { return { kind: "listener_error", error: error instanceof Error ? error : new Error(String(error)) }; }
  }
  return end;
 }
 void native.closed.then(async end => {
  if (stopping) return;
  ended.resolve(await finish(end));
 });
 return {
  get snapshot() { if (!initial) throw new Error("Attachment snapshot released after start"); return initial; },
  start(callback) {
   if (started) throw new Error("Conversation stream already started");
   started = true; listener = callback; initial = undefined;
   const initialEvents: AgentEvent[] = [];
   for (const [toolCallId, tool] of active) {
    initialEvents.push({ type: "tool_execution_start", toolCallId, toolName: tool.name, args: tool.args });
    const slot = liveOf(previous).tools?.find(s => s.callId === toolCallId);
    if (slot) initialEvents.push({ type: "tool_execution_update", toolCallId, toolName: tool.name, output: { set: slot.output ?? "" }, details: slot.details ?? null, diagnostics: slot.diagnostics ?? [] });
   }
   const live = liveOf(previous);
   if (live.runFailure) initialEvents.push({ type: "task_failed", taskId: live.runFailure.taskId, kind: "run", message: live.runFailure.detail ?? live.runFailure.reason });
   if (live.compactionFailure) initialEvents.push({ type: "task_failed", taskId: live.compactionFailure.taskId, kind: "compaction", message: live.compactionFailure.error });
   delivering = send(initialEvents).catch(error => {
    void native.stop();
    throw error;
   });
   void delivering.catch(() => undefined);
   native.start(async call => {
    await delivering;
    if (call.kind === "failed") throw call.error;
    if (call.retired) throw new Error("Conversation observation retired");
    delivering = advance(call.value, call.ops);
    await delivering;
   });
  },
  stop() {
   return stopping ??= (async () => {
    // Detach first, then wait for the caller-owned listener. A fresh bounded attachment captures the last commit.
    const end = await native.stop();
    await delivering.catch(() => undefined);
    initial = undefined;
    if (started && !listenerFailure && end.kind === "stopped" && !context.abortSignal?.aborted) {
     try {
      const tail = await conversation.watch(context, { min: 1, max: PAGE });
      try { delivering = advance(tail.value); await delivering; } finally { await tail.stop(); }
     } catch (error) {
      const failed: WatchEnd = listenerFailure ? { kind: "listener_error", error: listenerFailure } : { kind: "failed", error };
      ended.resolve(failed); return failed;
     }
    }
    const final = await finish(end); ended.resolve(final); return final;
   })();
  },
  closed: ended.promise,
 };
}
