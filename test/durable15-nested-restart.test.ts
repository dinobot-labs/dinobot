import { expect, test } from "bun:test";
import { Type } from "typebox";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTask, defineTool, Harness, LiveDoc, MemoryStorage, UsageDoc, type TaskId, type Seq, type StorageWrite } from "@earendil-works/pi-durable";
import { CapabilityTask, CellDoc, InternalCallDoc } from "../src/core/codemode/calls.ts";
import { codemodeExtension } from "../src/extensions/codemode.ts";

const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 } };
class RecordedStorage extends MemoryStorage {
 readonly commits: { writes: readonly StorageWrite[]; seq: Seq }[] = [];
 override async commit(...args: Parameters<MemoryStorage["commit"]>) {
  const [batches, receive, ctx] = args;
  return super.commit(batches, (index, seq) => {
   this.commits.push({ writes: structuredClone(batches[index]!), seq });
   receive(index, seq);
  }, ctx);
 }
 frozenCopy() {
  const copy = new MemoryStorage();
  for (const { writes, seq } of this.commits) copy.prepareCommit(writes, seq).apply();
  return copy;
 }
}
const parked = defineTask<null, { phase: "park" }, boolean>({ name: "test.receipt-parent", version: 1, initial: () => ({ phase: "park" }), phases: { park: async (_task, runtime, ctx) => { await runtime.sleepUntil(Date.now() + 3600000, { phase: "park" }, ctx); } }, abort: async (_task, runtime, ctx) => { await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx); } });

for (const mode of ["standalone", "full cell"] as const) test("crash replay clears nested progress and settles active ownership: " + mode, async () => {
 const released = Promise.withResolvers<void>();
 const childStarted = Promise.withResolvers<TaskId>();
 const reached = Promise.withResolvers<{ cap: TaskId; done: TaskId; active: TaskId }>();
 let completedExecutions = 0; let activeExecutions = 0; let outerExecutions = 0;
 const leaf = defineTool({ name: "done_leaf", description: "completed child", callers: ["tools"], parameters: Type.Object({}), execute: async () => { completedExecutions++; return { output: [{ type: "text", text: "done" }], usage }; } });
 const active = defineTool({ name: "active_leaf", description: "active child", callers: ["tools"], parameters: Type.Object({}), execute: async (_args, api) => { activeExecutions++; childStarted.resolve(api.taskId); await released.promise; return { output: [{ type: "text", text: "released" }] }; } });
 const outer = defineTool({ name: "outer", description: "unsafe parent", replay: "unsafe", parameters: Type.Object({}), execute: async (_args, api, ctx) => {
  outerExecutions++;
  const done = await api.executeTool("done_leaf", {}, ctx);
  const pending = api.executeTool("active_leaf", {}, ctx);
  const activeId = await childStarted.promise;
  reached.resolve({ cap: api.taskId, done: done.taskId, active: activeId });
  await released.promise;
  await pending;
  return { output: [{ type: "text", text: "outer complete" }] };
 } });
 const faux = fauxProvider({ provider: "faux", models: [{ id: "one" }] });
 const models = createModels(); models.setProvider(faux.provider);
 const registry = createRegistry(); registry.install(defineExtension({ name: "restart-probe", tools: [leaf, active, outer], tasks: [parked] }));
 let harness!: Harness; registry.install(codemodeExtension(() => harness, new Set()));
 const storage = new RecordedStorage();
 harness = await Harness.open(storage, { registry, models }, context);
 let reopened: Harness | undefined;
 let originalDone: Promise<unknown> | undefined;
 try {
  const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "one" } } });
  if (mode === "full cell") {
   faux.setResponses([fauxAssistantMessage(fauxToolCall("codemode", { code: "text(await tools.outer({}));" }), { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
   originalDone = (await conversation.submit({ type: "input", content: "crash probe" }, context)).wait(context);
  } else {
   const id = await harness.commit(async tx => {
    const parent = await tx.createTask(parked, null, { conversationId: conversation.id, ownership: { kind: "conversation" } });
    const id = await tx.createTask(CapabilityTask, { parent, rootCallId: "standalone", ordinal: 1, name: "outer", args: "{}" }, { conversationId: conversation.id, ownership: { kind: "conversation" } });
    (await tx.doc(InternalCallDoc, id)).parent = parent;
    (await tx.doc(CellDoc, conversation.id, String(parent), null)).calls.push({ id, ordinal: 1, name: "outer", status: "pending" });
    return id;
   }, context);
   originalDone = harness.waitForTask(id, context);
  }
  const ids = await reached.promise;
  const before = await harness.snapshot(LiveDoc, conversation.id, context);
  expect(before?.nestedTools?.map(slot => slot.taskId)).toEqual([ids.active]);
  expect((await harness.getTask(ids.done, context))?.state).toMatchObject({ status: "terminal", outcome: { status: "completed" } });
  expect((await harness.getTask(ids.active, context))?.state.status).toBe("running");
  expect((await harness.getTask(ids.cap, context))?.state).toMatchObject({ status: "running", checkpoint: { phase: "execute", replay: "unsafe" } });
  // Freeze only real committed writes at the crash cut. Cleanup of the original cannot reach this copy.
  const frozen = storage.frozenCopy();
  released.resolve(); await originalDone; await harness.close(context);
  faux.setResponses([fauxAssistantMessage("resumed")]);
  harness = await Harness.open(frozen, { registry, models }, context); reopened = harness;
  const cap = await harness.waitForTask(ids.cap, context);
  const child = await harness.waitForTask(ids.active, context);
  if (mode === "full cell") {
   if (!before?.run) throw new Error("Missing generation at crash cut");
   await harness.waitForTask(before.run.taskId, context);
  }
  const outcome = cap.state.outcome;
  // While cleanup awaits its child, the restarting native cell can abort this capability.
  // Both races must retain their exact error receipt; successful replay is never legal.
  if (mode === "standalone") expect(outcome.status).toBe("failed");
  if (outcome.status !== "failed" && outcome.status !== "aborted") throw new Error("Unsafe capability unexpectedly " + outcome.status);
  const retained = outcome.result;
  if (!retained || typeof retained !== "object" || !("json" in retained) || typeof retained.json !== "string") throw new Error("Missing interrupted capability receipt");
  expect(JSON.parse(retained.json)).toEqual({ isError: true, content: [{ type: "text", text: outcome.status === "failed" ? "Interrupted tool may have partially run; it was not retried" : "Tool aborted; effects may have partially completed" }] });
  expect(child.state.outcome.status).toBe("aborted");
  expect(completedExecutions).toBe(1); expect(activeExecutions).toBe(1); expect(outerExecutions).toBe(1);
  expect((await harness.snapshot(UsageDoc, conversation.id, context))?.tools).toEqual({ done_leaf: usage });
  expect((await harness.snapshot(LiveDoc, conversation.id, context))?.nestedTools ?? []).toEqual([]);
 } finally { released.resolve(); try { await originalDone; } finally { await (reopened ?? harness).close(context); } }
}, 5000);
