import { expect, test } from "bun:test";
import { Type } from "typebox";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Harness, MemoryStorage, createRegistry, defineExtension, defineTool, GenerationTask, hook } from "@earendil-works/pi-durable";

for (const removed of [false, true]) test(`execution authority follows the post-hook request inventory (removed=${removed})`, async () => {
 let effects = 0;
 const faux = fauxProvider({ provider: "authority-faux", models: [{ id: "one" }] });
 const models = createModels(); models.setProvider(faux.provider);
 const registry = createRegistry();
 registry.install(defineExtension({ name: "authority-probe", tools: [defineTool({ name: "effect", description: "observable effect", parameters: Type.Object({}), execute: async () => { effects++; return { output: [{ type: "text", text: "effect executed" }] }; } })], hooks: [hook(GenerationTask, { beforeRequest: ({ messages }) => ({ messages: removed ? messages.map(message => message.role === "system" && message.toolsAdded ? { ...message, toolsAdded: message.toolsAdded.filter(tool => tool.name !== "effect") } : message) : messages }) })] }));
 const harness = await Harness.open(new MemoryStorage(), { models, registry, settings: { compaction: { enabled: false }, retry: { enabled: false } } }, context);
 try {
  const conversation = await harness.root(context, { agent: { model: { provider: "authority-faux", modelId: "one" } } });
  faux.setResponses([request => {
   const offered = request.messages.flatMap(message => message.role === "system" ? (message.toolsAdded ?? []).map(tool => tool.name) : []);
   expect(offered.includes("effect")).toBe(!removed);
   return fauxAssistantMessage(fauxToolCall("effect", {}), { stopReason: "toolUse" });
  }, fauxAssistantMessage("finished")]);
  const settlement = await (await conversation.submit({ type: "input", content: "perform allowed work" }, context)).wait(context);
  expect(settlement.status).toBe("done");
  expect(effects).toBe(removed ? 0 : 1);
  const result = (await conversation.context(context)).messages.find(message => message.role === "toolResult");
  expect(result?.role === "toolResult" && result.isError).toBe(removed);
 } finally { await harness.close(context); }
});
