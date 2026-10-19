import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { AgentDoc, InboxDoc, LiveDoc, type ConversationId, type SubmissionId, type TaskId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openBot, type Bot } from "../src/core/bot.ts";
import { FastDoc } from "../src/core/fast.ts";
import { createNativeModelHandler } from "../src/core/native-model-commands.ts";
import { abortConversation, sendQueuedNow, withConversationAdmission } from "../src/core/queue.ts";
import { ArchivedThreadError, listThreads, selectModel, selectReasoning, threadBinding } from "../src/core/threads.ts";
import { AgentsDoc, ProgressDoc } from "../src/extensions/subagents.ts";
import { httpChannel } from "../src/channels/http.ts";
import { createTelegramForwarder } from "../src/cli/telegram-run.ts";
import type { BotReply, InboundMessage } from "../src/channels/types.ts";

const context = BACKGROUND_CONTEXT;
const bots = new Set<Bot>();
const directories: string[] = [];
afterEach(async () => {
 for (const bot of bots) await bot.close(context);
 bots.clear();
 for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

const THREAD = "chat:topic:1";
const KEY = "test:" + THREAD;
let sequence = 0;
const message = (text: string, messageId = "m" + ++sequence, threadKey = THREAD): InboundMessage => ({ channel: "test", threadKey, messageId, userId: "allowed", text });
const output = (reply: BotReply) => reply.status === "answered" ? reply.text : reply.reason;

async function setup() {
 const dir = await mkdtemp(join(tmpdir(), "native-new-")); directories.push(dir);
 const faux = fauxProvider({ provider: "faux", models: [{ id: "reasoner", reasoning: true }, { id: "plain" }] });
 const models = createModels(); models.setProvider(faux.provider);
 const transcripts: string[] = [];
 let calls = 0;
 faux.setResponses(Array.from({ length: 64 }, () => (transcript: { messages: unknown }) => {
  calls++; transcripts.push(JSON.stringify(transcript.messages));
  return fauxAssistantMessage("reply " + calls);
 }));
 const open = async () => {
  const bot = await openBot({ storage: await openNodeSqliteStorage(join(dir, "bot.sqlite")), models, defaultModel: { provider: "faux", modelId: "reasoner" }, toolMode: "direct", plugins: [], curation: { enabled: false } }, context);
  bots.add(bot); return bot;
 };
 const bot = await open();
 return { bot, models, faux, open, transcripts, calls: () => calls, handler: createNativeModelHandler(bot, models, context) };
}
async function bound(bot: Bot, key = KEY): Promise<ConversationId> {
 return (await threadBinding(bot.harness, key, context)).conversationId!;
}
async function entryCount(bot: Bot, id: ConversationId): Promise<number> {
 return (await (await bot.harness.conversation(id, context))!.entries({}, 100, undefined, context)).items.length;
}
async function archiveKeys(bot: Bot, key = KEY): Promise<string[]> {
 return Object.keys(await listThreads(bot.harness, context)).filter(name => name.startsWith(key + "#")).sort();
}

test("rotation binds a fresh conversation, archives the old one readable, and resets model context", async () => {
 const { bot, handler, transcripts } = await setup();
 expect(output(await handler(message("remember SECRET-CONTEXT")))).toBe("reply 1");
 const old = await bound(bot);
 const oldEntries = await entryCount(bot, old);
 expect(oldEntries).toBeGreaterThan(0);
 expect(output(await handler(message("/new")))).toContain("Started a new conversation");
 const fresh = await bound(bot);
 expect(fresh).not.toBe(old);
 const threads = await listThreads(bot.harness, context);
 expect(threads[KEY + "#1"]).toBe(old);
 // Injectivity: no conversation is bound to two keys.
 const ids = Object.values(threads);
 expect(new Set(ids).size).toBe(ids.length);
 expect(await entryCount(bot, old)).toBe(oldEntries);
 expect(await entryCount(bot, fresh)).toBe(0);
 expect(output(await handler(message("what did I say?")))).toBe("reply 2");
 expect(transcripts[1]).not.toContain("SECRET-CONTEXT");
 expect(await entryCount(bot, fresh)).toBeGreaterThan(0);
 expect(await entryCount(bot, old)).toBe(oldEntries);
 const binding = await threadBinding(bot.harness, KEY, context);
 expect(binding.lineage).toEqual([old]);
 expect(binding.archived).toBe(false);
});

test("thread settings carry over; global defaults and other threads are untouched", async () => {
 const { bot, models, handler } = await setup();
 await handler(message("hello"));
 const old = await bound(bot);
 await selectReasoning(bot.harness, models, old, "high", context);
 await bot.harness.commit(async tx => { (await tx.doc(FastDoc, old)).fast = true; }, context);
 await selectModel(bot.harness, models, old, { provider: "faux", modelId: "plain" }, context, undefined, { persistDefault: false });
 const before = (await bot.harness.snapshot(AgentDoc, old, context))!;
 const otherBefore = await bot.conversation("test", "chat:topic:2", context);
 expect(output(await handler(message("/new")))).toContain("Started");
 const fresh = await bound(bot);
 const after = (await bot.harness.snapshot(AgentDoc, fresh, context))!;
 expect(after.model).toEqual(before.model);
 expect(after.thinkingLevel).toBe(before.thinkingLevel);
 expect(after.cwd).toBe(before.cwd);
 expect((await bot.harness.snapshot(FastDoc, fresh, context))?.fast).toBe(true);
 expect((await bot.conversation("test", "chat:topic:2", context)).id).toBe(otherBefore.id);
 expect((await bot.conversation("other", THREAD, context)).id).not.toBe(fresh);
 // A brand-new thread still uses the global default model, not the thread-local selection.
 const brandNew = await bot.conversation("test", "chat:topic:3", context);
 expect((await bot.harness.snapshot(AgentDoc, brandNew.id, context))!.model?.modelId).toBe("reasoner");
});

test("an empty conversation is not rotated; usage, ordinary routing and the disable switch", async () => {
 const { bot, models, handler, calls } = await setup();
 expect(output(await handler(message("/new")))).toContain("already empty");
 expect(output(await handler(message("/new")))).toContain("already empty");
 expect(await archiveKeys(bot)).toEqual([]);
 for (const text of ["/new now", "/new\nplease"]) expect(output(await handler(message(text)))).toBe("Usage: /new");
 expect(output(await handler({ ...message("/new"), images: [{ mimeType: "image/png", data: "AA==" }] } as InboundMessage))).toBe("Usage: /new");
 expect(calls()).toBe(0);
 expect(output(await handler(message("/newer")))).toBe("reply 1");
 const disabled = createNativeModelHandler(bot, models, context, { newConversation: false });
 expect(output(await disabled(message("/new")))).toContain("disabled");
 expect(await archiveKeys(bot)).toEqual([]);
});

test("redelivery of the same /new is idempotent, also after restart; a later /new archives #2", async () => {
 const { bot, open, models, handler } = await setup();
 await handler(message("first"));
 const first = await bound(bot);
 const command = message("/new", "new-1");
 expect(output(await handler(command))).toContain("Started");
 const second = await bound(bot);
 await handler(message("second"));
 expect(output(await handler(command))).toContain("Started");
 expect(await bound(bot)).toBe(second);
 expect(await archiveKeys(bot)).toEqual([KEY + "#1"]);
 await bot.close(context); bots.delete(bot);
 const reopened = await open();
 const again = createNativeModelHandler(reopened, models, context);
 expect(output(await again(command))).toContain("Started");
 expect(await bound(reopened)).toBe(second);
 expect(output(await again(message("/new", "new-2")))).toContain("Started");
 const third = await bound(reopened);
 const threads = await listThreads(reopened.harness, context);
 expect([threads[KEY + "#1"], threads[KEY + "#2"], threads[KEY]]).toEqual([first, second, third]);
 expect((await threadBinding(reopened.harness, KEY, context)).lineage).toEqual([first, second]);
});

test("busy states (run, queue, pending transfer, running subagent) refuse without changing the binding", async () => {
 const { bot, handler } = await setup();
 await handler(message("hello"));
 const conversation = (await bot.harness.conversation(await bound(bot), context))!;
 const id = conversation.id;
 const refuse = async () => {
  expect(output(await handler(message("/new")))).toContain("Cannot start a new conversation");
  expect(await bound(bot)).toBe(id);
  expect(await archiveKeys(bot)).toEqual([]);
 };
 await bot.harness.commit(async tx => { (await tx.doc(LiveDoc, id)).run = { taskId: 999 as TaskId, inputs: [] }; }, context);
 await refuse();
 await bot.harness.commit(async tx => {
  delete (await tx.doc(LiveDoc, id)).run;
  (await tx.doc(InboxDoc, id)).items.push({ id: 999 as SubmissionId, mode: "followUp", content: "queued" });
 }, context);
 await refuse();
 await bot.harness.commit(async tx => { (await tx.doc(InboxDoc, id)).items = []; }, context);
 // Pending send-now transfer alone (inbox already withdrawn).
 await bot.harness.commit(async tx => {
  const record = await tx.createSubmission({ conversationId: id, type: "input", status: "queued" });
  (await tx.doc(InboxDoc, id)).items.push({ id: record.id, mode: "followUp", content: "captured" });
 }, context);
 const submit = conversation.submit.bind(conversation);
 conversation.submit = async () => { throw new Error("injected transfer interruption"); };
 await expect(sendQueuedNow(bot.harness, conversation, context)).rejects.toThrow("injected");
 conversation.submit = submit;
 await refuse();
 await abortConversation(bot.harness, conversation, context);
 // Running background subagent.
 await bot.harness.commit(async tx => {
  (await tx.doc(AgentsDoc, id)).agents.push({ taskId: "sa-1", runnerId: 4242 as TaskId<string>, conversationId: 777 as ConversationId, background: true });
  (await tx.doc(ProgressDoc, id, "4242", null)).subagent = { taskId: "sa-1", description: "d", subagentType: "general-purpose", status: "running", startedAt: 1 } as never;
 }, context);
 await refuse();
 await bot.harness.commit(async tx => { (await tx.doc(AgentsDoc, id)).agents = []; }, context);
 expect(output(await handler(message("/new")))).toContain("Started");
});

test("a real running turn refuses /new; the queued ordinary message stays in the old conversation", async () => {
 const { bot, handler, faux } = await setup();
 await handler(message("hello"));
 const started = Promise.withResolvers<void>();
 faux.setResponses([(_transcript, options) => {
  started.resolve();
  return new Promise(resolve => options?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("", { stopReason: "aborted" })), { once: true }));
 }]);
 const old = await bound(bot);
 const running = await bot.submit(message("long"), context);
 await started.promise;
 expect(output(await handler(message("/new")))).toContain("Cannot start");
 expect(await bound(bot)).toBe(old);
 await abortConversation(bot.harness, (await bot.harness.conversation(old, context))!, context);
 expect((await running.wait(context)).conversationId).toBe(old);
 await bot.harness.waitForIdle(context);
});

test("admission linearization: input queued behind /new lands in the new conversation, never the archive", async () => {
 const { bot, handler } = await setup();
 await handler(message("hello"));
 const old = await bound(bot);
 const oldEntries = await entryCount(bot, old);
 const release = Promise.withResolvers<void>();
 const entered = Promise.withResolvers<void>();
 const lock = withConversationAdmission(bot.harness, old, async () => { entered.resolve(); await release.promise; });
 await entered.promise;
 const rotating = handler(message("/new"));
 const concurrentNew = handler(message("/new"));
 const ordinary = bot.submit(message("after new"), context);
 release.resolve(); await lock;
 const replies = await Promise.all([rotating, concurrentNew]);
 expect(replies.map(output).filter(text => text.includes("Started"))).toHaveLength(1);
 expect(replies.map(output).filter(text => text.includes("already empty"))).toHaveLength(1);
 const fresh = await bound(bot);
 expect(fresh).not.toBe(old);
 const settled = await (await ordinary).wait(context);
 expect(settled.conversationId).toBe(fresh);
 expect(await entryCount(bot, old)).toBe(oldEntries);
 expect(await archiveKeys(bot)).toEqual([KEY + "#1"]);
});

test("a redelivered message admitted before /new is deduplicated against the archived lineage", async () => {
 const { bot, handler, calls } = await setup();
 const original = message("do the thing once", "once-1");
 expect(output(await handler(original))).toBe("reply 1");
 const old = await bound(bot);
 await handler(message("/new"));
 const fresh = await bound(bot);
 expect(output(await handler(original))).toBe("reply 1");
 expect(calls()).toBe(1);
 expect(await entryCount(bot, fresh)).toBe(0);
 const settled = await (await bot.submit(original, context)).wait(context);
 expect(settled.conversationId).toBe(old);
 expect(output(await handler(message("new work", "once-2")))).toBe("reply 2");
});

test("archive keys are read-only history for every ingress path", async () => {
 const { bot, handler, calls } = await setup();
 await handler(message("hello"));
 await handler(message("/new"));
 const archived = message("inject", "x", THREAD + "#1");
 await expect(bot.submit(archived, context)).rejects.toBeInstanceOf(ArchivedThreadError);
 expect(output(await handler({ ...archived, text: "/new" }))).toContain("unavailable");
 expect(output(await handler({ ...archived, text: "/model faux/plain" }))).toContain("unavailable");
 expect((await threadBinding(bot.harness, KEY + "#1", context)).archived).toBe(true);
 expect(await archiveKeys(bot)).toEqual([KEY + "#1"]);
 expect(calls()).toBe(1);
});

test("/model racing a rotation applies to the conversation bound after it", async () => {
 const { bot, handler } = await setup();
 await handler(message("hello"));
 const old = await bound(bot);
 const release = Promise.withResolvers<void>();
 const entered = Promise.withResolvers<void>();
 const lock = withConversationAdmission(bot.harness, old, async () => { entered.resolve(); await release.promise; });
 await entered.promise;
 const rotating = handler(message("/new"));
 const selecting = handler(message("/model faux/plain"));
 release.resolve(); await lock;
 expect(output(await rotating)).toContain("Started");
 expect(output(await selecting)).toContain("selected");
 const fresh = await bound(bot);
 expect((await bot.harness.snapshot(AgentDoc, fresh, context))!.model?.modelId).toBe("plain");
 expect((await bot.harness.snapshot(AgentDoc, old, context))!.model?.modelId).toBe("reasoner");
});

test("HTTP native route admits /new and the Telegram forwarder routes it, with an old-core fallback", async () => {
 const { bot, handler } = await setup();
 const channel = httpChannel(0);
 let ordinary = 0;
 await channel.start(async () => { ordinary++; return { status: "answered", text: "ordinary" }; }, handler);
 try {
  const forward = createTelegramForwarder(channel.url().origin);
  const telegram: InboundMessage = { channel: "ignored", threadKey: "1:2:0:3", messageId: "u1", userId: "3", text: "/new" };
  expect(await forward(telegram)).toEqual({ status: "answered", text: "This conversation is already empty; nothing to reset." });
  expect(await forward({ ...telegram, messageId: "u2", text: "/newer" })).toEqual({ status: "answered", text: "ordinary" });
  expect(ordinary).toBe(1);
  const raw = await fetch(new URL("/v1/native/messages", channel.url()), { method: "POST", body: JSON.stringify({ channel: "http", threadKey: "t", messageId: "1", userId: "u", text: "/new" }) });
  expect(raw.status).toBe(400);
 } finally { await channel.stop(); }
 const old = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ error: "unsupported native control message" }, { status: 400 }) });
 try {
  const forward = createTelegramForwarder(old.url.origin);
  expect(output(await forward({ channel: "telegram", threadKey: "1:2:0:3", messageId: "u3", userId: "3", text: "/new" }))).toContain("requires a core upgrade");
 } finally { await old.stop(true); }
 expect(Object.keys(await listThreads(bot.harness, context)).some(key => key.includes("#"))).toBe(false);
});
