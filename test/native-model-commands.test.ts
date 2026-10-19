import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { AgentDoc, InboxDoc, LiveDoc, type TaskId, type SubmissionId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openBot, type Bot } from "../src/core/bot.ts";
import { createNativeModelHandler } from "../src/core/native-model-commands.ts";
import { selectModel, selectReasoning } from "../src/core/threads.ts";
import { abortConversation, sendQueuedNow, withConversationAdmission } from "../src/core/queue.ts";
import type { BotReply, InboundMessage } from "../src/channels/types.ts";

const context = BACKGROUND_CONTEXT;
const bots = new Set<Bot>();
const directories: string[] = [];
afterEach(async () => {
 for (const bot of bots) await bot.close(context);
 bots.clear();
 for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});
const message = (text: string, threadKey = "chat:topic:1"): InboundMessage => ({ channel: "test", threadKey, messageId: "native-1", userId: "allowed", text });
const output = (reply: BotReply) => reply.status === "answered" ? reply.text : reply.reason;
async function setup() {
 const dir = await mkdtemp(join(tmpdir(), "native-models-")); directories.push(dir);
 const faux = fauxProvider({ provider: "faux", models: [{ id: "reasoner", reasoning: true }, { id: "plain" }, ...Array.from({length: 34}, (_, i) => ({ id: "m" + String(i).padStart(2, "0") }))] });
 const models = createModels(); models.setProvider(faux.provider);
 let calls = 0;
 faux.setResponses([() => { calls++; return fauxAssistantMessage("unexpected"); }]);
 const open = async () => {
  const bot = await openBot({ storage: await openNodeSqliteStorage(join(dir, "bot.sqlite")), models, defaultModel: { provider: "faux", modelId: "reasoner" }, toolMode: "direct", plugins: [], curation: { enabled: false } }, context);
  bots.add(bot); return bot;
 };
 const bot = await open();
 return { bot, models, faux, open, calls: () => calls, handler: createNativeModelHandler(bot, models, context) };
}
async function agent(bot: Bot, key = "chat:topic:1", channel = "test") {
 const conversation = await bot.conversation(channel, key, context);
 return (await bot.harness.snapshot(AgentDoc, conversation.id, context))!;
}

test("native selection is durable, idempotent and isolates topics, channels and both global defaults", async () => {
 const { bot, models, handler, open, calls } = await setup();
 const local = await bot.conversation("test", "local", context);
 await selectModel(bot.harness, models, local.id, { provider: "faux", modelId: "reasoner" }, context);
 await selectReasoning(bot.harness, models, local.id, "high", context);
 await agent(bot, "other");
 expect(output(await handler(message("/model faux/plain")))).toContain("selected");
 expect(output(await handler(message("/model faux/plain")))).toContain("selected");
 expect((await agent(bot)).model?.modelId).toBe("plain");
 for (const key of ["other", "new-topic"]) {
  expect((await agent(bot, key)).model?.modelId).toBe("reasoner");
  expect((await agent(bot, key)).thinkingLevel).toBe("high");
 }
 expect((await agent(bot, "chat:topic:1", "another")).model?.modelId).toBe("reasoner");
 expect(output(await handler(message("/model")))).toContain("Current model: faux/plain");
 expect(calls()).toBe(0);
 await bot.close(context); bots.delete(bot);
 const reopened = await open();
 expect((await agent(reopened)).model?.modelId).toBe("plain");
 expect((await agent(reopened, "after-restart")).thinkingLevel).toBe("high");
 expect((await agent(reopened, "after-restart")).model?.modelId).toBe("reasoner");
});

test("invalid, unavailable, disabled and failed catalog commands fail closed without model calls", async () => {
 const { bot, models, handler, calls } = await setup();
 const before = await agent(bot);
 for (const text of ["/model nonexistent", "/model faux/missing", "/model faux/plain extra", "/model <secret>/x", "/models faux 0", "/models unknown", "/models 2 3", "/models faux 1 extra"]) {
  expect(output(await handler(message(text)))).not.toContain("selected");
 }
 const available = models.getAvailable.bind(models);
 models.getAvailable = async () => [];
 expect(output(await handler(message("/model faux/plain")))).toBe("Model is unavailable.");
 models.getAvailable = async () => { throw new Error("SECRET credentials"); };
 expect(output(await handler(message("/models")))).toBe("Model control unavailable. Try again later.");
 models.getAvailable = available;
 const disabled = createNativeModelHandler(bot, models, context, { enabled: false });
 expect(output(await disabled(message("/model faux/plain")))).toContain("disabled");
 expect(output(await disabled(message("/models")))).toContain("disabled");
 expect((await agent(bot)).model).toEqual(before.model);
 expect(calls()).toBe(0);
});

test("listing has stable 16-entry pages, provider filters and bounded sanitized Unicode rendering", async () => {
 const { models, handler, calls } = await setup();
 const page = output(await handler(message("/models faux 1")));
 expect(page.split("\n").slice(1,-1)).toEqual(Array.from({length:16}, (_, i) => "faux/m" + String(i).padStart(2,"0")));
 expect(output(await handler(message("/models 2")))).toContain("faux/m16");
 expect(output(await handler(message("/models faux 4")))).toBe("Page out of range.");
 const huge = fauxProvider({ provider: "huge", models: Array.from({ length: 16 }, (_, i) => ({ id: String(i) + "😀".repeat(4000) + "<@all>\n" })) });
 models.setProvider(huge.provider);
 const rendered = output(await handler(message("/models huge")));
 expect(Array.from(rendered).length).toBeLessThanOrEqual(3500);
 expect(rendered).not.toContain("<@all>");
 expect(rendered.split("\n")).toHaveLength(18);
 expect(calls()).toBe(0);
});

test("same-key selection serializes under admission and cancellation while waiting cannot commit", async () => {
 const { bot, handler, calls } = await setup();
 const conversation = await bot.conversation("test", "chat:topic:1", context);
 const release = Promise.withResolvers<void>();
 const entered = Promise.withResolvers<void>();
 const lock = withConversationAdmission(bot.harness, conversation.id, async () => { entered.resolve(); await release.promise; });
 await entered.promise;
 const controller = new AbortController();
 const pending = handler(message("/model faux/plain"), controller.signal);
 controller.abort(); release.resolve(); await lock;
 await expect(pending).rejects.toThrow();
 expect((await agent(bot)).model?.modelId).toBe("reasoner");
 const results = await Promise.all([handler(message("/model faux/plain")), handler(message("/model faux/m00"))]);
 expect(results.every(result => output(result).includes("selected"))).toBe(true);
 expect((await agent(bot)).model?.modelId).toBe("m00");
 expect(calls()).toBe(0);
});

test("running and queued states reject changes without admitting a control input", async () => {
 const { bot, handler } = await setup();
 const conversation = await bot.conversation("test", "chat:topic:1", context);
 await bot.harness.commit(async tx => { (await tx.doc(LiveDoc, conversation.id)).run = { taskId: 999 as TaskId, inputs: [] }; }, context);
 expect(output(await handler(message("/model faux/plain")))).toContain("busy or queued");
 await bot.harness.commit(async tx => {
  delete (await tx.doc(LiveDoc, conversation.id)).run;
  (await tx.doc(InboxDoc, conversation.id)).items.push({ id: 999 as SubmissionId, mode: "followUp", content: "queued" });
 }, context);
 expect(output(await handler(message("/model faux/plain")))).toContain("busy or queued");
 expect((await agent(bot)).model?.modelId).toBe("reasoner");
 await bot.harness.commit(async tx => { (await tx.doc(InboxDoc, conversation.id)).items = []; }, context);
});

test("unknown command names only use bot.handle with signal; controls never use that path", async () => {
 const { bot, models, calls } = await setup();
 const seen: string[] = [];
 const controller = new AbortController();
 const facade = Object.create(bot) as Bot;
 facade.handle = async (input, ctx) => { seen.push(input.text); expect(ctx.abortSignal).toBe(controller.signal); return { status: "answered", text: "ordinary" }; };
 const handler = createNativeModelHandler(facade, models, context);
 for (const text of ["/login", "/logout", "/cwd /", "/modelx", "/models@bot", "hello", " /model"]) {
  expect(output(await handler(message(text), controller.signal))).toBe("ordinary");
 }
 expect(seen).toHaveLength(7);
 await handler(message("/models"), controller.signal);
 await handler(message("/model"), controller.signal);
 expect(seen).toHaveLength(7); expect(calls()).toBe(0);
});


test("pending transfer alone rejects selection after inbox withdrawal", async () => {
 const { bot, handler, calls } = await setup();
 const conversation = await bot.conversation("test", "chat:topic:1", context);
 await bot.harness.commit(async tx => {
  const record = await tx.createSubmission({ conversationId: conversation.id, type: "input", status: "queued" });
  (await tx.doc(InboxDoc, conversation.id)).items.push({ id: record.id, mode: "followUp", content: "captured" });
 }, context);
 const submit = conversation.submit.bind(conversation);
 conversation.submit = async () => { throw new Error("injected transfer interruption"); };
 await expect(sendQueuedNow(bot.harness, conversation, context)).rejects.toThrow("injected");
 conversation.submit = submit;
 expect((await bot.harness.snapshot(InboxDoc, conversation.id, context))?.items).toHaveLength(0);
 expect(output(await handler(message("/model faux/plain")))).toContain("busy or queued");
 expect((await agent(bot)).model?.modelId).toBe("reasoner");
 await abortConversation(bot.harness, conversation, context);
 expect(calls()).toBe(0);
});

test("real running turn and queued follow-up reject native selection without extra LLM calls", async () => {
 const { bot, handler, faux } = await setup();
 const started = Promise.withResolvers<void>();
 let calls = 0;
 faux.setResponses([(_transcript, options) => {
  calls++; started.resolve();
  return new Promise(resolve => options?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("", { stopReason: "aborted" })), { once: true }));
 }]);
 const conversation = await bot.conversation("test", "chat:topic:1", context);
 await bot.submit({ ...message("run"), messageId: "running" }, context);
 await started.promise;
 expect(output(await handler(message("/model faux/plain")))).toContain("busy or queued");
 await bot.submit({ ...message("follow-up"), messageId: "queued" }, context);
 expect(output(await handler(message("/model faux/plain")))).toContain("busy or queued");
 expect((await agent(bot)).model?.modelId).toBe("reasoner");
 await abortConversation(bot.harness, conversation, context);
 await bot.harness.waitForIdle(context);
 expect(calls).toBe(1);
});
