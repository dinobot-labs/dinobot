import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTask, defineTool, Harness, MemoryStorage, UsageDoc, type JsonObject, type TaskRuntime, type ToolRegistration } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createTaskToolInvocation } from "../src/core/tool-execution.ts";

type Runtime = TaskRuntime<null, { phase: "run" }, boolean, object>;
type Invocation = Awaited<ReturnType<typeof createTaskToolInvocation<null, { phase: "run" }, boolean, object>>>;
const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 } };

async function withHost(run: (invocation: Invocation, runtime: Runtime, harness: Harness, dir: string) => Promise<void>, tools: ToolRegistration[] = []) {
 const dir = await mkdtemp(join(tmpdir(), "invocation15-"));
 await writeFile(join(dir, "original.txt"), "original");
 const models = createModels();
 const faux = fauxProvider({ provider: "faux", models: [{ id: "one" }] });
 faux.setResponses([fauxAssistantMessage("probe")]); models.setProvider(faux.provider);
 let harness!: Harness;
 let failure: unknown;
 const driver = defineTask<null, { phase: "run" }, boolean>({ name: "test.invocation-lifecycle", version: 1, initial: () => ({ phase: "run" }), phases: { run: async (_task, runtime, ctx) => {
  const invocation = await createTaskToolInvocation(runtime, "host", { replay: "safe" }, ctx);
  try { await run(invocation, runtime, harness, dir); } catch (error) { failure = error; }
  finally { await invocation.close(); }
  await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: true } }), ctx);
 } }, abort: async (_task, runtime, ctx) => { await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx); } });
 const registry = createRegistry(); registry.install(defineExtension({ name: "invocation-test", tools, tasks: [driver] }));
 harness = await Harness.open(new MemoryStorage(), { registry, models, env: () => new NodeExecutionEnv({ cwd: dir }) }, context);
 try {
  const conversation = await harness.root(context);
  const id = await harness.commit(tx => tx.createTask(driver, null, { conversationId: conversation.id, ownership: { kind: "conversation" } }), context);
  expect((await harness.waitForTask(id, context)).state.outcome).toEqual({ status: "completed", result: true });
  if (failure) throw failure;
 } finally { await harness.close(context); await rm(dir, { recursive: true, force: true, maxRetries: 5 }); }
}

async function rejected(operation: () => unknown | Promise<unknown>): Promise<boolean> {
 try { await operation(); return false; } catch (error) { expect(String(error)).toContain("ended"); return true; }
}

test("saved conversation handle rejects submit after helper close while the same host phase is alive", async () => {
 await withHost(async (invocation, runtime, harness) => {
  const handle = await invocation.api.conversation(runtime.conversationId, context);
  if (!handle) throw new Error("Missing handle");
  const submit = handle.submit.bind(handle);
  const before = await runtime.entries({}, 100, undefined, context);
  await invocation.close();
  expect(runtime.signal.aborted).toBe(false);
  expect((await harness.getTask(runtime.taskId, context))?.state.status).toBe("running");
  const refused = await rejected(() => submit({ type: "write", requestId: "late-handle", entry: { kind: "test.late", data: { late: true } } }, context));
  const after = await runtime.entries({}, 100, undefined, context);
  expect(after).toEqual(before);
  expect(refused).toBe(true);
  const refusedTx = await rejected(() => runtime.commit(async tx => { await handle.submit(tx, { type: "write", entry: { kind: "test.late-tx", data: {} } }); return undefined; }, context));
  expect(refusedTx).toBe(true);
  expect(await runtime.entries({}, 100, undefined, context)).toEqual(before);
 });
});

test("saved environment cannot write after helper close in a live host phase", async () => {
 await withHost(async (invocation, runtime, _harness, dir) => {
  const env = invocation.api.env;
  if (!env) throw new Error("Missing environment");
  const write = env.writeFile.bind(env);
  expect((await write("allowed.txt", "allowed", context)).ok).toBe(true);
  await invocation.close(); expect(runtime.signal.aborted).toBe(false);
  const refused = await rejected(() => write("original.txt", "late", context));
  expect(await readFile(join(dir, "original.txt"), "utf8")).toBe("original");
  expect(refused).toBe(true);
 });
});

test("saved binary reader cannot read after close but can release its file", async () => {
 await withHost(async (invocation, runtime) => {
  const opened = await invocation.api.env!.openBinaryReader("original.txt", undefined, context);
  if (!opened.ok) throw opened.error;
  const reader = opened.value;
  try {
   expect((await reader.read(0, 8, context)).ok).toBe(true);
   const read = reader.read.bind(reader);
   await invocation.close(); expect(runtime.signal.aborted).toBe(false);
   expect(await rejected(() => read(0, 8, context))).toBe(true);
  } finally { await reader.close(context); }
 });
});

test("saved models cannot issue a completion after helper close", async () => {
 await withHost(async (invocation, runtime) => {
  const models = invocation.api.models;
  const model = models.getModel("faux", "one");
  if (!model) throw new Error("Missing faux model");
  const complete = models.completeSimple.bind(models);
  await invocation.close(); expect(runtime.signal.aborted).toBe(false);
  expect(await rejected(() => complete(model, { messages: [{ role: "user", content: "late", timestamp: 0 }] }))).toBe(true);
 });
});

test("saved document reader and memo methods reject in a live phase after helper close", async () => {
 await withHost(async (invocation, runtime) => {
  const snapshot = invocation.api.snapshot;
  const memo = invocation.api.memo;
  await invocation.close(); expect(runtime.signal.aborted).toBe(false);
  expect(await rejected(() => snapshot(UsageDoc, runtime.conversationId, context))).toBe(true);
  expect(await rejected(() => memo("late", true, context))).toBe(true);
  expect(await runtime.memo("late", context)).toBeUndefined();
 });
});

const cases: { name: string; first: JsonObject; second: JsonObject }[] = [
 { name: "positive zero and negative zero", first: { n: 0 }, second: { n: -0 } },
 { name: "null prototype and ordinary object", first: Object.assign(Object.create(null) as JsonObject, { n: 1 }), second: { n: 1 } },
];
for (const boundary of cases) test("keyed replay agrees with official native JSON equality: " + boundary.name, async () => {
 let nativeExecutions = 0; let hostExecutions = 0;
 const nativeLeaf = defineTool({ name: "native_leaf", description: "native oracle", callers: ["tools"], parameters: Type.Object({ n: Type.Number() }), execute: async () => { nativeExecutions++; return { output: [{ type: "text", text: "leaf" }], usage }; } });
 const hostLeaf = defineTool({ name: "host_leaf", description: "host leaf", callers: ["tools"], parameters: Type.Object({ n: Type.Number() }), execute: async () => { hostExecutions++; return { output: [{ type: "text", text: "leaf" }], usage }; } });
 const oracle = defineTool({ name: "native_oracle", description: "actual native keyed execution", callers: ["tools"], parameters: Type.Object({}), execute: async (_args, api, ctx) => {
  const first = await api.executeTool("native_leaf", boundary.first, ctx, { key: "stable" });
  const replay = await api.executeTool("native_leaf", boundary.second, ctx, { key: "stable" });
  expect(replay.taskId).toBe(first.taskId); expect(replay.usage).toEqual(usage);
  await expect(api.executeTool("native_leaf", { n: 9 }, ctx, { key: "stable" })).rejects.toThrow();
  return { output: [{ type: "text", text: "native-reused" }] };
 } });
 await withHost(async (invocation, runtime, harness) => {
  const native = await invocation.api.executeTool("native_oracle", {}, context, { key: "oracle" });
  expect(native.isError).toBe(false); expect(native.structuredOutput).toBe("native-reused"); expect(nativeExecutions).toBe(1);
  const first = await invocation.api.executeTool("host_leaf", boundary.first, context, { key: "stable" });
  const replay = await invocation.api.executeTool("host_leaf", boundary.second, context, { key: "stable" });
  expect(replay.taskId).toBe(first.taskId); expect(replay.usage).toEqual(usage);
  await expect(invocation.api.executeTool("host_leaf", { n: 9 }, context, { key: "stable" })).rejects.toThrow();
  expect(hostExecutions).toBe(1);
  const recorded = await harness.snapshot(UsageDoc, runtime.conversationId, context);
  expect(recorded?.tools.native_leaf).toEqual(usage); expect(recorded?.tools.host_leaf).toEqual(usage);
 }, [nativeLeaf, hostLeaf, oracle]);
});
