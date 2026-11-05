import { expect, test } from "bun:test";
import { Type } from "typebox";
import { ChatState } from "../src/tui/state.ts";
import { copyJson } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context, withCancel } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxToolCall, fauxThinking, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, LiveDoc, MemoryStorage, type Conversation, type EntryId, type TaskId } from "@earendil-works/pi-durable";
import { watchConversation } from "../src/core/conversation-observer.ts";
import { agentProgress, draftTail } from "../src/core/progress-events.ts";
import type { AgentEvent } from "../src/core/ui-contract.ts";
import type { ProgressEvent } from "../src/channels/types.ts";

for (const rootReplacement of [false, true]) test(`real faux streaming and failed tool reconstruct text (${rootReplacement ? "root replacement" : "incremental native payloads"})`, async () => {
 const faux = fauxProvider({ tokensPerSecond: 32000, tokenSize: { min: 32, max: 32 } });
 const models = createModels(); models.setProvider(faux.provider);
 const registry = createRegistry();
 const output = "public-answer-".repeat(700);
 const secret = "private-reasoning-".repeat(20);
 const toolText = "tool-output-".repeat(64);
 let executions = 0;
 const toolPublished = Promise.withResolvers<void>();
 registry.install({ name: "test-tools", tools: [{ name: "probe", description: "test", parameters: Type.Object({}), execute: async (_args, api) => {
  executions++;
  for (let n = 0; n < 8; n++) { api.output(toolText); await Bun.sleep(3); }
  // Hold the producer until the native live publication has actually been observed.
  await toolPublished.promise;
  return { isError: true, output: [{ type: "text", text: "expected tool failure" }] };
 } }] });
 const h = await Harness.open(new MemoryStorage(), { models, registry, settings: { progress: { partialIntervalMs: 1, outputIntervalMs: 1, persistWithinMs: 1 } } }, context);
 try {
  const c = await create(h); await c.configure({ model: { provider: faux.getModel().provider, modelId: faux.getModel().id } }, context);
  faux.setResponses([fauxAssistantMessage([fauxThinking(secret), fauxToolCall("probe", {})], { stopReason: "toolUse" }), fauxAssistantMessage(output)]);
  const native = await c.watch(context);
  const opPaths = new Set<string>();
  native.start(async call => { if (call.kind === "value") for (const op of call.ops) if (op[0] !== "r") opPaths.add(JSON.stringify([op[0], op[1]])); });
  const source = rootReplacement ? {
   conversation: async () => ({ ...c, entries: c.entries.bind(c), watch: async (...args: Parameters<typeof c.watch>) => {
    const watch = await c.watch(...args);
    return { ...watch, get value() { return watch.value; }, closed: watch.closed, stop: () => watch.stop(), start: (listener: Parameters<typeof watch.start>[0]) => watch.start(async (call, ctx) => {
     await listener(call.kind === "value" ? { ...call, ops: [["r", copyJson(call.value)]] } : call, ctx);
    }) };
   } }) as Conversation,
   submission: h.submission.bind(h),
  } : h;
  const stream = await watchConversation(source, c.id, context);
  const events: AgentEvent[] = [], progress: ProgressEvent[] = [];
  const state = new ChatState(); state.apply(stream.snapshot);
  const map = agentProgress(e => progress.push(e));
  let streamedText = "", toolOutput = "";
  stream.start(async batch => {
   events.push(...batch); map(batch);
   for (const e of batch) {
    state.apply(e);
    if (e.type === "message_update") {
     const block = state.data.blocks.findLast(b => b.kind === "agent");
     if (block?.kind === "agent") { streamedText = block.text; expect(output.startsWith(streamedText)).toBe(true); }
    }
    if (e.type === "tool_execution_update" && e.output) {
     toolOutput = "set" in e.output ? e.output.set : toolOutput.slice(e.output.trimStart ?? 0) + (e.output.append ?? "");
     expect(toolText.repeat(8).startsWith(toolOutput)).toBe(true);
     if (toolOutput === toolText.repeat(8)) toolPublished.resolve();
    }
   }
  });
  const input = await c.submit({ type: "input", content: "go" }, context);
  const receipt = await input.wait(context); await c.waitForIdle(context); await stream.stop(); map.flush();
  expect(receipt.status).toBe("done"); expect(executions).toBe(1);
  expect(events.filter(e => e.type === "tool_execution_start")).toHaveLength(1);
  expect(events.filter(e => e.type === "tool_execution_end")).toHaveLength(1);
  expect(progress.some(e => e.type === "tool_end" && !e.ok)).toBe(true);
  expect(JSON.stringify(progress)).not.toContain("private-reasoning");
  expect(progress.filter(e => e.type === "draft").at(-1)?.text).toBe(draftTail(output));
  const updates = events.filter(e => e.type === "message_update");
  const payloadBytes = updates.reduce((n, e) => n + JSON.stringify(e).length, 0);
  await native.stop();
  expect(opPaths.has(JSON.stringify(["a", ["docs", "pi.live", "generation", "message", "content", 0, "text"]]))).toBe(true);
  expect(streamedText.length).toBeGreaterThan(output.length * 0.7);
  expect(state.data.blocks.filter(b => b.kind === "agent").at(-1)?.text).toBe(output);
  expect(toolOutput).toBe(toolText.repeat(8));
  console.log("observer streaming payload", { rootReplacement, answerChars: output.length, updates: updates.length, payloadBytes });
  if (!rootReplacement) {
   expect(updates.some(e => e.changes.some(c => c.type === "text_delta"))).toBe(true);
   expect(payloadBytes).toBeLessThan(output.length * 8);
   expect(events.some(e => e.type === "tool_execution_update" && e.output && "append" in e.output && e.output.append)).toBe(true);
  } else expect(updates.some(e => e.changes.some(c => c.type === "message"))).toBe(true);
 } finally { await h.close(context); }
}, 10000);

const open = () => Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, context);
const create = (h: Harness) => h.createConversation({ ownership: { kind: "ownerless" } }, context);

test("folded rapid tool rounds use immutable results exactly once across multiple native windows", async () => {
 const h = await open();
 try {
  const c = await create(h);
  const stream = await watchConversation(h, c.id, context);
  const events: AgentEvent[] = [], progress: ProgressEvent[] = [];
  const map = agentProgress(e => progress.push(e));
  const blocked = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let held = false;
  stream.start(async batch => {
   events.push(...batch); map(batch);
   if (!held) { held = true; blocked.resolve(); await release.promise; }
  });
  await h.commit(async tx => { await tx.appendEntry(c.id, { kind: "before" }); }, context);
  await blocked.promise;
  // All slots can start and disappear while the listener is held. Entry ID holes come from another conversation.
  const other = await create(h);
  await h.commit(async tx => {
   for (let i = 0; i < 110; i++) {
    await tx.appendEntry(other.id, { kind: "hole" });
    await tx.appendEntry(c.id, { kind: "pi.assistant", model: [fauxAssistantMessage([fauxToolCall("read", { path: String(i) }, { id: `call-${i}` })], { stopReason: "toolUse" })] });
    await tx.appendEntry(c.id, { kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: `call-${i}`, toolName: "read", content: [{ type: "text", text: `result-${i}` }], isError: i === 7, timestamp: 1 }] });
   }
   await tx.appendEntry(c.id, { kind: "pi.assistant", model: [fauxAssistantMessage([{ type: "thinking", thinking: "private-thought" }, { type: "text", text: "final answer" }])] });
  }, context);
  release.resolve();
  expect((await stream.stop()).kind).toBe("stopped");
  map.flush();
  const starts = events.filter(e => e.type === "tool_execution_start");
  const ends = events.filter(e => e.type === "tool_execution_end");
  expect(starts).toHaveLength(110); expect(ends).toHaveLength(110);
  for (let i = 0; i < 110; i++) {
   const start = events.findIndex(e => e.type === "tool_execution_start" && e.toolCallId === `call-${i}`);
   const end = events.findIndex(e => e.type === "tool_execution_end" && e.toolCallId === `call-${i}`);
   expect(end).toBeGreaterThan(start);
  }
  expect(progress.filter(e => e.type === "tool_end")).toHaveLength(110);
  expect(progress.find(e => e.type === "tool_end" && e.id === "call-7")).toEqual({ type: "tool_end", id: "call-7", ok: false });
  expect(progress.filter(e => e.type === "draft").at(-1)).toEqual({ type: "draft", text: "final answer" });
  expect(JSON.stringify(progress)).not.toContain("private-thought");
  expect(events.filter(e => e.type === "message_end")).toHaveLength(221);
  expect(() => stream.snapshot).toThrow("released");
 } finally { await h.close(context); }
});

test("reconnect snapshot retains >100 history, ID holes, reset/compaction markers and fork ancestry", async () => {
 const h = await open();
 try {
  const c = await create(h), other = await create(h);
  const ids: EntryId[] = [];
  await h.commit(async tx => {
   for (let i = 0; i < 215; i++) {
    await tx.appendEntry(other.id, { kind: "hole" });
    ids.push((await tx.appendEntry(c.id, { kind: "history", data: i })).id);
   }
   ids.push((await tx.appendEntry(c.id, { kind: "pi.compaction", head: ids[150]!, data: { summary: "compacted" } })).id);
   ids.push((await tx.appendEntry(c.id, { kind: "pi.reset", head: "self" })).id);
  }, context);
  const stream = await watchConversation(h, c.id, context);
  expect(stream.snapshot.entries.map(e => e.id)).toEqual(ids);
  const events: AgentEvent[] = []; stream.start(async batch => { events.push(...batch); });
  await h.commit(async tx => { await tx.appendEntry(c.id, { kind: "new" }); }, context);
  await stream.stop();
  expect(events.filter(e => e.type === "entry_appended")).toHaveLength(1);
  const reconnected = await watchConversation(h, c.id, context);
  expect(reconnected.snapshot.entries).toHaveLength(218); await reconnected.stop();
  const fork = await c.fork(ids[160]!, { ownership: { kind: "ownerless" } }, context);
  await h.commit(async tx => { await tx.appendEntry(fork.id, { kind: "branch" }); }, context);
  const branch = await watchConversation(h, fork.id, context);
  expect(branch.snapshot.entries.slice(0, -1).map(e => e.id)).toEqual(ids.slice(0, 161));
  expect(branch.snapshot.entries.at(-1)?.kind).toBe("branch"); await branch.stop();
 } finally { await h.close(context); }
});

test("stop waits for an in-flight listener and drains final committed draft without inventing tool outcomes", async () => {
 const h = await open();
 try {
  const c = await create(h);
  await h.commit(async tx => { const live = await tx.doc(LiveDoc, c.id); live.tools = [{ name: "read", callId: "active", status: "running" }]; }, context);
  const stream = await watchConversation(h, c.id, context);
  const progress: ProgressEvent[] = [], map = agentProgress(e => progress.push(e), { now: () => 0 });
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let first = true;
  stream.start(async batch => { map(batch); if (first) { first = false; entered.resolve(); await release.promise; } });
  await entered.promise;
  const draft = fauxAssistantMessage("latest draft");
  await h.commit(async tx => { const live = await tx.doc(LiveDoc, c.id); live.generation = { attempt: 1, message: { role: "assistant", api: draft.api, provider: draft.provider, model: draft.model, usage: draft.usage, stopReason: draft.stopReason, timestamp: draft.timestamp, content: [{ type: "text", text: "latest draft" }] } }; }, context);
  let stopped = false; const stop = stream.stop().then(end => { stopped = true; return end; });
  await Promise.resolve(); expect(stopped).toBe(false);
  release.resolve(); expect((await stop).kind).toBe("stopped"); map.flush();
  expect(progress.filter(e => e.type === "tool_start")).toHaveLength(1);
  // Stopping observation does not cancel the tool or establish its outcome.
  expect(progress.filter(e => e.type === "tool_end")).toEqual([]);
  expect(progress.filter(e => e.type === "draft").at(-1)).toEqual({ type: "draft", text: "latest draft" });
  expect((await stream.closed).kind).toBe("stopped");
 } finally { await h.close(context); }
});

test("idle without a model is an unanswered receipt and an explicit failure, never success", async () => {
 const h = await open();
 try {
  const c = await create(h), stream = await watchConversation(h, c.id, context);
  const events: AgentEvent[] = []; stream.start(async batch => { events.push(...batch); });
  const receipt = await (await c.submit({ type: "input", content: "hello" }, context)).wait(context);
  await c.waitForIdle(context); await stream.stop();
  expect(receipt.status).toBe("unanswered");
  expect(events.filter(e => e.type === "task_failed").map(e => e.kind)).toContain("run");
 } finally { await h.close(context); }
});

test("initial active-tool listener rejection closes explicitly without a later commit", async () => {
 const h = await open();
 try {
  const c = await create(h);
  await h.commit(async tx => {
   const live = await tx.doc(LiveDoc, c.id);
   live.tools = [{ callId: "active", name: "probe", status: "running" }];
  }, context);
  const stream = await watchConversation(h, c.id, context);
  stream.start(async () => { throw new Error("initial listener failed"); });
  const end = await stream.closed;
  expect(end.kind).toBe("listener_error");
  expect((await stream.stop()).kind).toBe("listener_error");
 } finally { await h.close(context); }
});

test("listener error and abort settle explicitly and no callbacks follow stop", async () => {
 const h = await open();
 try {
  const c = await create(h), stream = await watchConversation(h, c.id, context);
  stream.start(async () => { throw new Error("sink failed"); });
  await h.commit(async tx => { await tx.appendEntry(c.id, { kind: "trigger" }); }, context);
  expect((await stream.closed).kind).toBe("listener_error");
  const cancelled = withCancel(context);
  const watch = await watchConversation(h, c.id, cancelled.context);
  let callbacks = 0; watch.start(async () => { callbacks++; });
  cancelled.cancel(); expect((await watch.closed).kind).toBe("aborted");
  const before = callbacks; await watch.stop();
  await h.commit(async tx => { await tx.appendEntry(c.id, { kind: "after-stop" }); }, context);
  expect(callbacks).toBe(before);
 } finally { await h.close(context); }
});

for (const kind of ["failed", "retired"] as const) test(`native ${kind} call is not treated as a value`, async () => {
 const h = await open();
 try {
  const c = await create(h);
  const wrapped = { conversation: async () => ({ ...c, entries: c.entries.bind(c), watch: async () => {
   const watch = await c.watch(context);
   return { ...watch, get value() { return watch.value; }, closed: watch.closed, stop: () => watch.stop(), start: (listener: Parameters<typeof watch.start>[0]) => watch.start(async call => {
    if (kind === "failed") await listener({ kind: "failed", error: new Error("source unavailable") }, context);
    else if (call.kind === "value") await listener({ ...call, retired: true }, context);
   }) };
  } } as Conversation), submission: h.submission.bind(h) };
  const stream = await watchConversation(wrapped, c.id, context); stream.start(async () => {});
  await h.commit(async tx => { await tx.appendEntry(c.id, { kind: "trigger" }); }, context);
  const end = await stream.closed; expect(end.kind).toBe("listener_error");
  if ("error" in end) expect(String(end.error)).toContain(kind === "failed" ? "source unavailable" : "retired");
 } finally { await h.close(context); }
});
