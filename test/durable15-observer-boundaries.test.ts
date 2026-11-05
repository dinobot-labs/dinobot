import { expect, test } from "bun:test";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, LiveDoc, MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { watchConversation } from "../src/core/conversation-observer.ts";
import { agentProgress } from "../src/core/progress-events.ts";
import type { AgentEvent } from "../src/core/ui-contract.ts";
import type { ProgressEvent } from "../src/channels/types.ts";
import { sqliteTest } from "./fixtures/sqlite-test.ts";

const options = () => ({ models: createModels(), registry: createRegistry() });
const partial = (content: string | { type: "text"; text: string }[]) => {
 const message = fauxAssistantMessage(content);
 return { role: message.role, api: message.api, provider: message.provider, model: message.model, usage: message.usage, stopReason: message.stopReason, timestamp: message.timestamp, content: typeof content === "string" ? [{ type: "text" as const, text: content }] : content };
};

for (const delivery of ["entry", "partial"] as const) test(`stop preserves a late ${delivery} listener rejection`, async () => {
 const h = await Harness.open(new MemoryStorage(), options(), context);
 const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
 try {
  const c = await h.createConversation({ ownership: { kind: "ownerless" } }, context);
  const stream = await watchConversation(h, c.id, context);
  const failure = new Error("blocked delivery rejected");
  let callbacks = 0;
  stream.start(async batch => {
   callbacks++;
   expect(batch.some(event => delivery === "entry" ? event.type === "entry_appended" : event.type === "message_start")).toBe(true);
   entered.resolve(); await release.promise; throw failure;
  });
  await h.commit(async tx => {
   if (delivery === "entry") await tx.appendEntry(c.id, { kind: "unaccepted" });
   else { const live = await tx.doc(LiveDoc, c.id); live.generation = { attempt: 1, message: partial("unaccepted") }; }
  }, context);
  await entered.promise;
  let settled = false;
  const stop = stream.stop().then(end => { settled = true; return end; });
  await Promise.resolve();
  expect(settled).toBe(false);
  release.resolve();
  const [stopped, closed] = await Promise.all([stop, stream.closed]);
  expect(stopped).toEqual({ kind: "listener_error", error: failure });
  expect(closed).toEqual(stopped);
  expect(await stream.stop()).toEqual(stopped);
  expect(callbacks).toBe(1);
  const reconnect = await watchConversation(h, c.id, context);
  if (delivery === "entry") expect(reconnect.snapshot.entries.at(-1)?.kind).toBe("unaccepted");
  else expect(reconnect.snapshot.generation?.message?.content).toEqual([{ type: "text", text: "unaccepted" }]);
  await reconnect.stop();
 } finally { release.resolve(); await h.close(context); }
});

for (const suffix of ["keep", ""]) for (const replacement of ["thinking", "toolCall"] as const) test(`native text-to-${replacement} replacement removes the old public draft block (${suffix || "empty"})`, async () => {
 const h = await Harness.open(new MemoryStorage(), options(), context);
 try {
  const c = await h.createConversation({ ownership: { kind: "ownerless" } }, context);
  await h.commit(async tx => {
   const live = await tx.doc(LiveDoc, c.id);
   live.generation = { attempt: 1, message: partial([{ type: "text", text: "old" }, { type: "text", text: suffix }]) };
  }, context);
  const stream = await watchConversation(h, c.id, context);
  const progress: ProgressEvent[] = [], events: AgentEvent[] = [];
  const map = agentProgress(event => progress.push(event), { now: () => 0 });
  map([stream.snapshot]);
  expect(progress.filter(event => event.type === "draft").at(-1)?.text).toBe("old" + suffix);
  const delivered = Promise.withResolvers<void>();
  stream.start(async batch => { events.push(...batch); map(batch); if (batch.some(event => event.type === "message_update")) delivered.resolve(); });
  await h.commit(async tx => {
   const live = await tx.doc(LiveDoc, c.id);
   if (!live.generation?.message) throw new Error("missing partial");
   live.generation.message.content[0] = replacement === "thinking" ? { type: "thinking", thinking: "private thought" } : { type: "toolCall", id: "replacement", name: "read", arguments: { path: "private argument" } };
  }, context);
  await delivered.promise;
  // Inspect the native incremental delivery before stop can mask it with a fresh root tail.
  map.flush();
  expect(events.some(event => event.type === "message_update" && event.changes.some(change => change.type === "block" && change.contentIndex === 0 && change.block.type === replacement))).toBe(true);
  expect(progress.filter(event => event.type === "draft" || event.type === "draft_clear").at(-1)).toEqual(suffix ? { type: "draft", text: suffix } : { type: "draft_clear" });
  expect(JSON.stringify(progress)).not.toContain("private");
  expect((await stream.stop()).kind).toBe("stopped");
 } finally { await h.close(context); }
});

for (const isError of [false, true]) sqliteTest(import.meta.path, `session close with folded ${isError ? "failed" : "successful"} result requires reconnect, not an invented outcome`, async directory => {
 const file = join(directory, "observer.sqlite");
 const open = async () => Harness.open(await openNodeSqliteStorage(file), options(), context);
 const h = await open();
 const release = Promise.withResolvers<void>();
 try {
  const c = await h.createConversation({ ownership: { kind: "ownerless" } }, context);
  const stream = await watchConversation(h, c.id, context);
  const native = await c.watch(context);
  const nativeEntered = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  const nativeResults: number[] = [];
  native.start(async call => { if (call.kind === "value") { nativeResults.push(...call.value.entries.filter(entry => entry.kind === "pi.tool-result").map(entry => entry.id)); nativeEntered.resolve(); await release.promise; } });
  const events: AgentEvent[] = [], progress: ProgressEvent[] = [];
  const map = agentProgress(event => progress.push(event));
  stream.start(async batch => {
   events.push(...batch); map(batch);
   if (batch.some(event => event.type === "tool_execution_update")) { entered.resolve(); await release.promise; }
  });
  await h.commit(async tx => { const live = await tx.doc(LiveDoc, c.id); live.tools = [{ name: "read", callId: "folded", status: "running", output: "working" }]; }, context);
  await Promise.all([entered.promise, nativeEntered.promise]);
  const result = await h.commit(async tx => {
   const entry = await tx.appendEntry(c.id, { kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "folded", toolName: "read", content: [{ type: "text", text: "committed result" }], isError, timestamp: 1 }] });
   const live = await tx.doc(LiveDoc, c.id); live.tools = [];
   return entry;
  }, context);
  expect((await c.entries({ order: "ascending" }, 10, undefined, context)).items.at(-1)?.id).toBe(result.id);
  await h.close(context);
  // Upstream closes immediately and discards pending frames; it does not drain listeners.
  expect((await native.closed).kind).toBe("ended");
  expect(nativeResults).toEqual([]);
  release.resolve();
  const end = await stream.closed;
  expect(progress.filter(event => event.type === "tool_end")).toEqual([]);
  expect(events.filter(event => event.type === "tool_execution_end")).toEqual([]);
  expect(end.kind).toBe("failed");
  if (end.kind === "failed") expect(String(end.error)).toMatch(/reconnect/i);
  expect(await stream.stop()).toEqual(end);
  const reopened = await open();
  try {
   const reconnect = await watchConversation(reopened, c.id, context);
   const recovered = reconnect.snapshot.entries.find(entry => entry.id === result.id);
   expect(recovered?.model?.[0]).toEqual(result.model?.[0]);
   await reconnect.stop();
  } finally { await reopened.close(context); }
 } finally { release.resolve(); await h.close(context); }
});
