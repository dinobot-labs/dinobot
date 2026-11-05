import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { compile } from "@earendil-works/pi-schema";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { createRegistry, defineDoc, defineExtension, defineTask, defineTool, Harness, MemoryStorage, UsageDoc, type ToolExecutionApi, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { CodingTools, createPowerShellTool } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { checkpointEvery256 } from "../src/core/document-policy.ts";
import { createTaskToolInvocation, workerToolResult } from "../src/core/tool-execution.ts";
import { ToolOutput } from "../src/core/codemode/output.ts";
import { imagesExtension } from "../src/extensions/images.ts";
import { bashCallDurationMs, codemodeExtension } from "../src/extensions/codemode.ts";
import { AsksDoc } from "../src/core/ask.ts";
import { awaitResolution } from "../src/extensions/ask.ts";

const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 } };

test("host native nested calls replay keys, enforce scope, count usage once and fence invocation operations", async () => {
 let executions = 0; let saved: ToolExecutionApi | undefined; let observed: unknown;
 const leaf = defineTool({ name: "leaf", description: "nested", callers: ["tools"], parameters: Type.Object({ n: Type.Integer() }), structuredOutputSchema: Type.Object({ n: Type.Integer() }), execute: async ({ n }) => { executions++; return { output: [{ type: "text", text: "model-only" }], structuredOutput: { n }, usage }; } });
 const forbidden = defineTool({ name: "model_only", description: "not callable", callers: ["model"], parameters: Type.Object({}), execute: async () => { throw new Error("must not execute"); } });
 const driver = defineTask<null, { phase: "run" }, boolean>({ name: "test.host-driver", version: 1, initial: () => ({ phase: "run" }), phases: { run: async (_task, runtime, ctx) => {
  const invocation = await createTaskToolInvocation(runtime, "host-call", { replay: "safe", outputLimits: { maxBytes: 8, retain: "tail" } }, ctx); saved = invocation.api;
  const first = await saved.executeTool("leaf", { n: 7 }, ctx, { key: "stable" });
  const replay = await saved.executeTool("leaf", { n: 7 }, ctx, { key: "stable" });
  let conflict = false; try { await saved.executeTool("leaf", { n: 8 }, ctx, { key: "stable" }); } catch { conflict = true; }
  const blocked = await saved.executeTool("model_only", {}, ctx);
  saved.output("prefix-abcdefgh"); const retained = saved.retainedOutput();
  const clock = saved.now(); const models = saved.models;
  await invocation.close();
  observed = { first, replay, conflict, blocked, retained, clock, hasModels: !!models, outputWindow: saved.outputWindow };
  await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: true } }), ctx);
 } }, abort: async (_task, runtime, ctx) => { await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx); } });
 const registry = createRegistry(); registry.install(defineExtension({ name: "test", tools: [leaf, forbidden], tasks: [driver] }));
 const harness = await Harness.open(new MemoryStorage(), { registry, models: createModels(), now: () => 12345 }, context);
 try {
  const conversation = await harness.root(context);
  const id = await harness.commit(tx => tx.createTask(driver, null, { conversationId: conversation.id, ownership: { kind: "conversation" } }), context);
  expect((await harness.waitForTask(id, context)).state.outcome).toEqual({ status: "completed", result: true });
  expect(observed).toMatchObject({ first: { isError: false, structuredOutput: { n: 7 } }, replay: { isError: false, structuredOutput: { n: 7 } }, conflict: true, blocked: { isError: true }, retained: { text: "abcdefgh", truncated: true }, clock: 12345, hasModels: true, outputWindow: undefined });
  expect(executions).toBe(1);
  expect((await harness.snapshot(UsageDoc, conversation.id, context))?.tools.leaf).toEqual(usage);
  expect(() => saved!.output("late")).toThrow("ended");
  expect(() => saved!.retainedOutput()).toThrow("ended");
  expect(() => saved!.now()).toThrow("ended");
  await expect(saved!.commit(() => 1, context)).rejects.toThrow("ended");
 } finally { await harness.close(context); }
});

test("host worker adapter preserves output, details, usage and diagnostics without changing messages", () => {
 const result: ToolExecutionResult = { output: [{ type: "text", text: "text" }, { type: "image", mimeType: "image/png", data: "AQ==" }], isError: true, details: { id: 1 }, diagnostics: [{ severity: "error", code: "x", message: "failure" }], structuredOutput: { answer: 42 }, usage };
 expect(bashCallDurationMs(createPowerShellTool(), { command: "Get-Date", timeout: 120 })).toBe(120000);
 const converted = workerToolResult(result);
 expect(converted.content).toBe(result.output); expect(converted).not.toHaveProperty("output");
 expect(converted).toMatchObject({ isError: true, details: { id: 1 }, diagnostics: result.diagnostics, structuredOutput: { answer: 42 }, usage });
 expect(result.output?.[0]).toEqual({ type: "text", text: "text" });
});

test("codemode keeps native read image receipts and rejects invalid images at the 1.5 reader boundary", async () => {
 const dir = await mkdtemp(join(tmpdir(), "dinobot-host15-"));
 const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aW1sAAAAASUVORK5CYII=", "base64");
 await writeFile(join(dir, "pixel.png"), bytes); await writeFile(join(dir, "invalid.png"), "not an image"); await writeFile(join(dir, "text.txt"), "actual file text");
 const faux = fauxProvider({ provider: "faux", models: [{ id: "one" }] }); const models = createModels(); models.setProvider(faux.provider);
 const registry = createRegistry(); registry.install(CodingTools); registry.install(imagesExtension());
 let harness!: Harness; registry.install(codemodeExtension(() => harness, new Set()));
 harness = await Harness.open(new MemoryStorage(), { models, registry, env: () => new NodeExecutionEnv({ cwd: dir }) }, context);
 try {
  const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "one" } } });
  faux.setResponses([fauxAssistantMessage(fauxToolCall("codemode", { code: `const image = await tools.read({path:"pixel.png"}); text(image); text(await tools.read({path:"invalid.png"})); text(await tools.read({path:"text.txt"}));` }), { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
  const receipt = await (await conversation.submit({ type: "input", content: "Read files" }, context)).wait(context);
  expect(receipt.status).toBe("done");
  const result = (await conversation.context(context)).messages.find(message => message.role === "toolResult");
  if (!result || result.role !== "toolResult") throw new Error("No result");
  // The invalid-image child makes the cell erroneous; successful sibling attachments must survive.
  expect(result.isError).toBe(true);
  expect(result.content.filter(block => block.type === "image")).toHaveLength(1);
  const text = result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
  expect(text).toContain("Image attached to model"); expect(text).toContain("Image retained by host"); expect(text).toContain("Invalid image signature"); expect(text).toContain("actual file text"); expect(text).not.toContain(bytes.toString("base64"));
 } finally { await harness.close(context); await rm(dir, { recursive: true, force: true, maxRetries: 5 }); }
});

test("host documents retain a 256-delta bound across actual committed changes", async () => {
 const Counter = defineDoc<{ n: number }>({ kind: "test.host-counter", scope: "session", version: 1, initial: () => ({ n: 0 }), checkpointWhen: checkpointEvery256 });
 class ObservedStorage extends MemoryStorage {
  chain = 0; max = 0; bases = 0;
  override async commit(...args: Parameters<MemoryStorage["commit"]>) {
   const result = await super.commit(...args);
   for (const batch of args[0].slice(0, result.stored)) for (const write of batch) if (write.type === "document.create" || write.type === "document.change") {
    if (write.content.kind === "base") { this.chain = 0; this.bases++; } else { this.chain++; this.max = Math.max(this.max, this.chain); }
   }
   return result;
  }
 }
 const storage = new ObservedStorage(); const harness = await Harness.open(storage, { registry: createRegistry(), models: createModels() }, context);
 try {
  for (let n = 1; n <= 600; n++) await harness.commit(async tx => { (await tx.doc(Counter)).n = n; }, context);
  expect((await harness.snapshot(Counter, context))?.n).toBe(600); expect(storage.max).toBeLessThanOrEqual(256); expect(storage.bases).toBeGreaterThanOrEqual(3);
 } finally { await harness.close(context); }
});

test("TypeBox JSON semantics and native coercion retain extra properties and reject fractional integers", () => {
 const tool = { name: "schema", description: "schema", parameters: Type.Object({ n: Type.Integer(), values: Type.Array(Type.String()) }) };
 const call = { type: "toolCall" as const, id: "schema", name: "schema", arguments: { n: "3", values: "one", extra: true } };
 expect(validateToolArguments(tool, call)).toEqual({ n: 3, values: ["one"], extra: true });
 expect(compile(tool.parameters).check({ n: 3.5, values: [] })).toBe(false);
 expect(validateToolArguments(tool, { ...call, arguments: { n: 3.5, values: [] } })).toEqual({ n: 3, values: [] });
});

test("ask watch fails closed when its durable document retires", async () => {
 const harness = await Harness.open(new MemoryStorage(), { registry: createRegistry(), models: createModels() }, context);
 try {
  const conversation = await harness.root(context);
  const deadline = Date.now() + 1000;
  await harness.commit(async tx => { (await tx.doc(AsksDoc, conversation.id)).asks.push({ id: "missing", from: { conversationId: conversation.id }, to: "main", kind: "clarification", refs: [], question: "test", default: "stop", createdAt: Date.now(), deadlineAt: deadline, state: "open" }); }, context);
  const attached = Promise.withResolvers<void>();
  const api = new Proxy(harness, { get(target, key) { const value: unknown = Reflect.get(target, key, target); if (typeof value !== "function") return value; return async (...args: unknown[]) => { const result: unknown = await Reflect.apply(value, target, args); if (key === "snapshot") attached.resolve(); return result; }; } });
  const waiting = awaitResolution(api, conversation.id, "missing", deadline, context);
  const outcome = waiting.then(value => ({ kind: "resolved" as const, value }), error => ({ kind: "rejected" as const, error }));
  await attached.promise; await harness.commit(tx => tx.retireDoc(AsksDoc, conversation.id), context);
  const settled = await outcome;
  expect(settled.kind).toBe("rejected");
  if (settled.kind !== "rejected") throw new Error("Retired ask watcher resolved");
  expect(String(settled.error)).toContain("retired");
 } finally { await harness.close(context); }
});

test("stream snapshots do not finalize a split UTF-8 codepoint", () => {
 const output = new ToolOutput({ maxBytes: 100, retain: "tail" }); const bytes = new TextEncoder().encode("한글");
 output.push(bytes.slice(0, 2)); expect(output.snapshot().text).toBe(""); output.push(bytes.slice(2)); expect(output.finish()).toEqual({ text: "한글", truncated: false });
});
