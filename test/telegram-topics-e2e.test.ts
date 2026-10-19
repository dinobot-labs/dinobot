import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { telegramChannel } from "../src/channels/telegram.ts";
import { httpChannel } from "../src/channels/http.ts";
import { createTelegramForwarder } from "../src/cli/telegram-run.ts";
import { channelHandler } from "../src/core/channel-handler.ts";
import { context, forbiddenCommands, openLocalBot } from "./fixtures/channel-e2e-child.ts";

async function until(predicate: () => boolean, label: string) {
 const end = Date.now() + 10000;
 while (!predicate()) {
  if (Date.now() >= end) throw new Error("Timed out: " + label);
  await Bun.sleep(10);
 }
}
function event(id: number, text: string, chat: number, topic: number | undefined, user = 1) {
 return { update_id: id, message: { message_id: id, from: { id: user, is_bot: false }, chat: { id: chat, type: chat > 0 ? "private" : "supergroup", ...(chat < 0 ? { is_forum: true } : {}) }, ...(topic === undefined ? {} : { message_thread_id: topic, is_topic_message: true }), text } };
}
type Update = ReturnType<typeof event>;
type Delivery = { bot: string; chat_id: string; message_thread_id?: number; text: string };
// Only the remote Telegram REST boundary is fake. Return old updates deliberately,
// even below the requested offset, to exercise durable cursor/redelivery handling.
function fakeTelegram() {
 const updates = new Map<string, Update[]>();
 const deliveries: Delivery[] = [];
 const polls: { bot: string; offset: number }[] = [];
 let rateLimited = false;
 const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const [, credential, method] = new URL(request.url).pathname.split("/");
  const bot = credential!.slice(3).split(":")[0]!;
  const body = await request.json() as Record<string, any>;
  if (method === "setMyCommands") return Response.json({ ok: true, result: true });
  if (method === "getWebhookInfo") return Response.json({ ok: true, result: { url: "" } });
  if (method === "getUpdates") {
   polls.push({ bot, offset: body.offset });
   return Response.json({ ok: true, result: updates.get(bot) ?? [] });
  }
  if (method !== "sendMessage") return new Response("unexpected method", { status: 500 });
  deliveries.push({ bot, chat_id: body.chat_id, message_thread_id: body.message_thread_id, text: body.text });
  return rateLimited
   ? Response.json({ ok: false, parameters: { retry_after: 1 } }, { status: 429 })
   : Response.json({ ok: true, result: { message_id: deliveries.length } });
 } });
 return { deliveries, polls, apiBase: server.url.origin, enqueue(bot: string, update: Update) { updates.set(bot, [...(updates.get(bot) ?? []), update]); }, rateLimit(value: boolean) { rateLimited = value; }, close: () => server.stop(true) };
}
async function pollingChannel(dir: string, bot: string, apiBase: string) {
 const tokenFile = join(dir, bot + ".token");
 await writeFile(tokenFile, bot + ":local_topic_test", { mode: 0o600 });
 return telegramChannel({ mode: "polling", port: 0, botTokenFile: tokenFile, databasePath: join(dir, bot + "-inbox.sqlite"), allowedUserIds: ["1", "2"], allowedChatIds: ["1", "-100"], requestTimeoutMs: 2000 }, { apiBase });
}

describe("Telegram topics: real polling, channelHandler, SQLite bot and faux model (local REST only)", () => {
 for (const route of ["native", "forwarder"] as const) {
  for (const chat of [1, -100]) {
   test(route + ": " + (chat > 0 ? "private topics" : "forum topics") + " isolate topic/user/bot history and preserve chunk destinations", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-topics-"));
    const remote = fakeTelegram();
    const channels = [await pollingChannel(dir, "101", remote.apiBase), await pollingChannel(dir, "202", remote.apiBase)];
    const { bot, faux } = await openLocalBot(dir);
    const http = httpChannel(0);
    let commandAccess = 0;
    const commands = forbiddenCommands(() => commandAccess++);
    const transcripts: string[] = [];
    const answer = "PRIVATE_REPLY_안녕🌍 " + "🙂".repeat(2200);
    const replies = [answer, "OTHER_TOPIC_REPLY", "OTHER_USER_REPLY", "OTHER_BOT_REPLY", "ROOT_REPLY", "FOLLOWUP_REPLY"];
    faux.setResponses(replies.map(reply => transcript => { transcripts.push(JSON.stringify(transcript.messages)); return fauxAssistantMessage(reply); }));
    try {
     if (route === "forwarder") await http.start(channelHandler(http, bot, commands, context));
     for (const channel of channels) await channel.start(route === "native" ? channelHandler(channel, bot, commands, context) : createTelegramForwarder(http.url().origin));
     const inputs = [
      // /model is now an explicit native control; /login remains privileged-looking ordinary data.
      { bot: "101", id: 1, topic: 10, user: 1, text: "/login FIRST_TOPIC_안녕🌍", done: 1 },
      { bot: "101", id: 2, topic: 20, user: 1, text: "SECOND_TOPIC", done: 2 },
      { bot: "101", id: 3, topic: 10, user: 2, text: "SECOND_USER", done: 3 },
      // Same update ID, chat, topic and user, but a different Telegram bot.
      { bot: "202", id: 1, topic: 10, user: 1, text: "SECOND_BOT", done: 1 },
      { bot: "101", id: 4, topic: undefined, user: 1, text: "ROOT_CONTEXT", done: 4 },
      { bot: "101", id: 5, topic: 10, user: 1, text: "/fast SAME_TOPIC_FOLLOWUP", done: 5 },
     ];
     for (const input of inputs) {
      remote.enqueue(input.bot, event(input.id, input.text, chat, input.topic, input.user));
      await until(() => channels[input.bot === "101" ? 0 : 1]!.health().done === input.done, input.text);
     }
     expect(faux.state.callCount).toBe(6);
     expect(commandAccess).toBe(0);
     expect(transcripts[0]).toContain("/login FIRST_TOPIC_안녕🌍");
     for (let i = 1; i <= 4; i++) {
      expect(transcripts[i]).toContain(inputs[i]!.text);
      for (let j = 0; j < i; j++) {
       expect(transcripts[i]).not.toContain(inputs[j]!.text);
       expect(transcripts[i]).not.toContain(replies[j]!);
      }
     }
     expect(transcripts[5]).toContain("FIRST_TOPIC_안녕🌍");
     expect(transcripts[5]).toContain("PRIVATE_REPLY_안녕🌍");
     expect(transcripts[5]).toContain("SAME_TOPIC_FOLLOWUP");
     for (const marker of ["SECOND_TOPIC", "SECOND_USER", "SECOND_BOT", "ROOT_CONTEXT", "OTHER_TOPIC_REPLY", "OTHER_USER_REPLY", "OTHER_BOT_REPLY", "ROOT_REPLY"]) expect(transcripts[5]).not.toContain(marker);
     if (route === "forwarder") expect(transcripts[0]).toContain("Telegram message:");
     expect(remote.deliveries).toHaveLength(7);
     expect(remote.deliveries.slice(0, 2).map(d => d.text).join("" )).toBe(answer);
     expect(remote.deliveries.map(d => [d.bot, d.chat_id, d.message_thread_id])).toEqual([
      ["101", String(chat), 10], ["101", String(chat), 10], ["101", String(chat), 20],
      ["101", String(chat), 10], ["202", String(chat), 10], ["101", String(chat), undefined], ["101", String(chat), 10],
     ]);
     expect(remote.deliveries.slice(2).map(d => d.text)).toEqual(replies.slice(1));
     for (const delivery of remote.deliveries) expect(delivery.text.length).toBeLessThanOrEqual(4096);
    } finally { for (const channel of channels) await channel.stop(); await http.stop(); await bot.close(context); await remote.close(); await rm(dir, { recursive: true, force: true }); }
   }, 30000);
  }

  test(route + ": restart persists topic history, retries only rendered outbox and ignores update redelivery", async () => {
   const dir = await mkdtemp(join(tmpdir(), "telegram-topic-restart-"));
   const remote = fakeTelegram();
   let channel = await pollingChannel(dir, "101", remote.apiBase);
   let current = await openLocalBot(dir);
   let http = httpChannel(0);
   const transcripts: string[] = [];
   let commandAccess = 0;
   const commands = forbiddenCommands(() => commandAccess++);
   const start = async () => {
    if (route === "forwarder") await http.start(channelHandler(http, current.bot, commands, context));
    await channel.start(route === "native" ? channelHandler(channel, current.bot, commands, context) : createTelegramForwarder(http.url().origin));
   };
   try {
    current.faux.setResponses([fauxAssistantMessage("PERSISTED_OTHER_REPLY"), fauxAssistantMessage("PERSISTED_OWN_REPLY")]);
    await start();
    remote.enqueue("101", event(1, "PERSISTED_OTHER_TOPIC", 1, 20));
    await until(() => channel.health().done === 1, "other topic delivery");
    remote.rateLimit(true);
    remote.enqueue("101", event(2, "PERSISTED_OWN_TOPIC", 1, 10));
    await until(() => channel.health().ready === 1 && remote.deliveries.length === 2, "rendered 429 retry");
    expect(current.faux.state.callCount).toBe(2);
    await channel.stop(); await http.stop(); await current.bot.close(context);
    remote.rateLimit(false);
    channel = await pollingChannel(dir, "101", remote.apiBase);
    current = await openLocalBot(dir); http = httpChannel(0);
    const beforePoll = remote.polls.length;
    await start();
    await until(() => channel.health().done === 2 && remote.polls.length > beforePoll, "persisted outbox replay");
    expect(current.faux.state.callCount).toBe(0);
    expect(remote.polls[beforePoll]).toEqual({ bot: "101", offset: 3 });
    expect(remote.deliveries.map(d => d.text)).toEqual(["PERSISTED_OTHER_REPLY", "PERSISTED_OWN_REPLY", "PERSISTED_OWN_REPLY"]);
    // Old updates are returned again in the same poll as this fresh FIFO barrier.
    current.faux.setResponses([transcript => { transcripts.push(JSON.stringify(transcript.messages)); return fauxAssistantMessage("AFTER_RESTART_REPLY"); }]);
    remote.enqueue("101", event(3, "/login AFTER_RESTART", 1, 10));
    await until(() => channel.health().done === 3, "fresh post-restart followup");
    expect(current.faux.state.callCount).toBe(1);
    expect(commandAccess).toBe(0);
    expect(transcripts[0]).toContain("PERSISTED_OWN_TOPIC");
    expect(transcripts[0]).toContain("PERSISTED_OWN_REPLY");
    expect(transcripts[0]).toContain("/login AFTER_RESTART");
    expect(transcripts[0]).not.toContain("PERSISTED_OTHER_TOPIC");
    expect(transcripts[0]).not.toContain("PERSISTED_OTHER_REPLY");
    expect(remote.deliveries).toHaveLength(4);
    expect(remote.deliveries.at(-1)?.text).toBe("AFTER_RESTART_REPLY");
    expect(remote.deliveries.map(d => d.message_thread_id)).toEqual([20, 10, 10, 10]);
    for (const delivery of remote.deliveries) expect([delivery.bot, delivery.chat_id]).toEqual(["101", "1"]);
   } finally { await channel.stop(); await http.stop(); await current.bot.close(context); await remote.close(); await rm(dir, { recursive: true, force: true }); }
  }, 30000);
 }
});
