import { expect, test } from "bun:test";
import { Type } from "typebox";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness, MemoryStorage, UsageDoc, type ToolRegistration } from "@earendil-works/pi-durable";
import { CellDoc } from "../src/core/codemode/calls.ts";
import { CODEMODE_LIMITS } from "../src/core/codemode/protocol.ts";
import { codemodeExtension } from "../src/extensions/codemode.ts";

const usage = { input: 2, output: 3, cacheRead: 5, cacheWrite: 7, reasoning: 1, cacheWrite1h: 4, totalTokens: 17, cost: { input: 2, output: 3, cacheRead: 5, cacheWrite: 7, total: 17 } };
const twiceUsage = { input: 4, output: 6, cacheRead: 10, cacheWrite: 14, reasoning: 2, cacheWrite1h: 8, totalTokens: 34, cost: { input: 4, output: 6, cacheRead: 10, cacheWrite: 14, total: 34 } };
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aW1sAAAAASUVORK5CYII=";
const images = (count: number) => Array.from({ length: count }, () => ({ type: "image" as const, mimeType: "image/png", data: png }));

async function withCell(tools: ToolRegistration[], code: string, check: (harness: Harness, conversation: Awaited<ReturnType<Harness["root"]>>) => Promise<void>) {
 const faux = fauxProvider({ provider: "faux", models: [{ id: "one" }] });
 const models = createModels(); models.setProvider(faux.provider);
 const registry = createRegistry(); registry.install(defineExtension({ name: "receipt-probe", tools }));
 let harness!: Harness; registry.install(codemodeExtension(() => harness, new Set()));
 harness = await Harness.open(new MemoryStorage(), { registry, models }, context);
 try {
  const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "one" } } });
  faux.setResponses([fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
  expect((await (await conversation.submit({ type: "input", content: "receipt probe" }, context)).wait(context)).status).toBe("done");
  await check(harness, conversation);
 } finally { await harness.close(context); }
}

async function receipt(harness: Harness, conversation: Awaited<ReturnType<Harness["root"]>>) {
 const results = (await conversation.context(context)).messages.filter(message => message.role === "toolResult");
 expect(results).toHaveLength(1);
 const result = results[0];
 if (!result || result.role !== "toolResult") throw new Error("Missing codemode model result");
 expect(result.toolName).toBe("codemode");
 const details = result.details;
 if (!details || typeof details !== "object" || !("codemodeTaskId" in details) || typeof details.codemodeTaskId !== "number") throw new Error("Missing durable cell ID");
 const journal = await harness.snapshot(CellDoc, conversation.id, String(details.codemodeTaskId), context);
 if (!journal) throw new Error("Missing durable call journal");
 return { result, journal, text: result.content.filter(block => block.type === "text").map(block => block.text).join("\n") };
}

for (const scenario of [
 { name: "five valid images", output: images(5), error: "Codemode image attachment limit exceeded" },
 { name: "overlimit explicit text", output: [{ type: "text" as const, text: "x".repeat(CODEMODE_LIMITS.maxValueBytes + 1) }], error: "Result could not be retained: JSON exceeds 524288 bytes" },
]) test("receipt rejection preserves incurred usage exactly once: " + scenario.name, async () => {
 let executions = 0;
 const tool = defineTool({ name: "charged", description: "charged receipt", parameters: Type.Object({}), execute: async () => { executions++; return { output: scenario.output, usage }; } });
 await withCell([tool], "text(await tools.charged({})); text(await tools.charged({}));", async (harness, conversation) => {
  const { result, journal, text } = await receipt(harness, conversation);
  expect(executions).toBe(2); expect(result.isError).toBe(true);
  expect(result.content.filter(block => block.type === "image")).toEqual([]);
  expect(text).toContain(scenario.error); expect(text).not.toContain(png);
  expect(journal.calls.map(call => call.status)).toEqual(["failed", "failed"]);
  for (const call of journal.calls) {
   expect(call.images).toEqual([]); expect(call.error).toContain(scenario.error);
   expect(JSON.parse(call.result!)).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringContaining(scenario.error) }] });
   expect(Buffer.byteLength(call.result!)).toBeLessThanOrEqual(CODEMODE_LIMITS.maxValueBytes);
  }
  expect((await harness.snapshot(UsageDoc, conversation.id, context))?.tools).toEqual({ charged: twiceUsage });
 });
});

test("four admitted images retain worker markers and charge successful receipts once", async () => {
 const tool = defineTool({ name: "charged", description: "images", parameters: Type.Object({}), execute: async () => ({ output: images(4), usage }) });
 await withCell([tool], "text(await tools.charged({}));", async (harness, conversation) => {
  const { result, journal, text } = await receipt(harness, conversation);
  expect(result.isError).toBe(false); expect(result.content.filter(block => block.type === "image")).toEqual(images(4));
  expect(journal.calls.map(call => call.status)).toEqual(["done"]);
  expect(journal.calls[0]?.images).toEqual(images(4));
  expect(text).toContain("Image attached to model"); expect(text).not.toContain(png);
  expect(JSON.parse(journal.calls[0]!.result!)).toMatchObject({ usage, content: Array.from({ length: 4 }, () => ({ type: "text", text: expect.stringContaining("Image attached to model") })) });
  expect((await harness.snapshot(UsageDoc, conversation.id, context))?.tools).toEqual({ charged: usage });
 });
});

test("parallel image admission keeps the cell limit without losing either charge", async () => {
 let executions = 0;
 const tool = defineTool({ name: "charged", description: "images", parameters: Type.Object({}), execute: async () => { executions++; return { output: images(3), usage }; } });
 await withCell([tool], "text(await Promise.all([tools.charged({}), tools.charged({})]));", async (harness, conversation) => {
  const { result, journal } = await receipt(harness, conversation);
  expect(executions).toBe(2); expect(result.isError).toBe(true);
  expect(result.content.filter(block => block.type === "image")).toEqual(images(3));
  expect(journal.calls.map(call => call.status).sort()).toEqual(["done", "failed"]);
  expect((await harness.snapshot(UsageDoc, conversation.id, context))?.tools).toEqual({ charged: twiceUsage });
 });
});

test("rejected outer receipt does not duplicate native nested ToolTask usage", async () => {
 let executions = 0;
 const leaf = defineTool({ name: "leaf", description: "native child", callers: ["tools"], parameters: Type.Object({}), execute: async () => { executions++; return { output: [{ type: "text", text: "child" }], usage }; } });
 const outer = defineTool({ name: "outer", description: "charged parent", parameters: Type.Object({}), execute: async (_args, api, ctx) => {
  const first = await api.executeTool("leaf", {}, ctx, { key: "stable" });
  const replay = await api.executeTool("leaf", {}, ctx, { key: "stable" });
  if (first.taskId !== replay.taskId || first.isError || replay.isError) throw new Error("Native child replay failed");
  return { output: images(5), usage };
 } });
 await withCell([leaf, outer], "text(await tools.outer({}));", async (harness, conversation) => {
  const { result, journal } = await receipt(harness, conversation);
  expect(executions).toBe(1); expect(result.isError).toBe(true);
  expect(journal.calls.map(call => call.status)).toEqual(["failed"]);
  expect((await harness.snapshot(UsageDoc, conversation.id, context))?.tools).toEqual({ leaf: usage, outer: usage });
 });
});
