import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { telegramChannel } from "../src/channels/telegram.ts";
import { discordChannel } from "../src/channels/discord.ts";
import { channelHandler } from "../src/core/channel-handler.ts";
import { context, forbiddenCommands, openLocalBot, secret, telegramConfig, token } from "./fixtures/channel-e2e-child.ts";

type Platform = "telegram" | "discord";
async function until(predicate: () => boolean, label: string, timeout = 10000) {
 const end = Date.now() + timeout;
 while (!predicate()) {
  if (Date.now() >= end) throw new Error("Timed out: " + label);
  await Bun.sleep(10);
 }
}
function telegramEvent(id: number, text: string, user = 1, topic = 10) {
 return { update_id: id, message: { message_id: id, from: { id: user, is_bot: false }, chat: { id: -100 }, message_thread_id: topic, text } };
}
async function postTelegram(url: string | URL, event: unknown) {
 return fetch(new URL("/webhook", url), { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret }, body: JSON.stringify(event) });
}

function platformHarness(kind: Platform, dir: string) {
 const deliveries: { path: string; method: string; text: string; payload: any }[] = [];
 const menus: { path: string; method: string; payload: any }[] = [];
 const assertMenus = (starts: number) => {
  expect(menus).toHaveLength(kind === "telegram" ? starts : 0);
  for (const menu of menus) {
   expect(menu.path).toBe("/bot" + token + "/setMyCommands");
   expect(menu.method).toBe("POST");
   expect(menu.payload).toMatchObject({ scope: { type: "default" }, commands: expect.arrayContaining([expect.objectContaining({ command: "new" })]) });
  }
 };
 let rateLimited = false;
 let hold = false;
 const held: (() => void)[] = [];
 const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  let text: string, payload: any;
  if (kind === "telegram") {
   payload = await request.json();
   const path = new URL(request.url).pathname;
   // Startup configuration is not an outbox delivery and must not consume
   // delivery-only 429/ambiguous-send injection or its synchronization barrier.
   if (path === "/bot" + token + "/setMyCommands") {
    menus.push({ path, method: request.method, payload });
    return Response.json({ ok: true, result: true });
   }
   text = payload.text;
  }
  else {
   const form = await request.formData();
   payload = JSON.parse(String(form.get("payload_json")));
   text = form.get("files[0]") ? await (form.get("files[0]") as File).text() : payload.content;
  }
  deliveries.push({ path: new URL(request.url).pathname, method: request.method, text, payload });
  if (hold) await new Promise<void>(resolve => held.push(resolve));
  return rateLimited ? Response.json({ retry_after: 1, parameters: { retry_after: 1 } }, { status: 429, headers: { "Retry-After": "1" } }) : Response.json({ ok: true });
 } });
 const { privateKey, publicKey } = generateKeyPairSync("ed25519");
 const publicHex = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex");
 const create = () => kind === "telegram" ? telegramChannel(telegramConfig(dir), { apiBase: server.url.origin }) : discordChannel({ port: 0, databasePath: join(dir, "inbox.sqlite"), applicationId: "123", publicKey: publicHex, allowedUserIds: ["1", "2"], allowedChannelIds: ["10", "20"], requestTimeoutMs: 2000 }, { apiBase: server.url.origin });
 // Snowflakes remain stable across duplicate deliveries and close/reopen.
 const epoch = BigInt(Date.now() - 1420070400000) << 22n;
 const event = (id: number, text: string, user = 1, topic = 10) => kind === "telegram" ? telegramEvent(id, text, user, topic) : { id: String(epoch + BigInt(id)), application_id: "123", type: 2, channel_id: String(topic), member: { user: { id: String(user), bot: false } }, token: "local-token-" + id, data: { type: 1, name: "ask", options: [{ name: "prompt", type: 3, value: text }] } };
 const post = async (url: URL, event: unknown) => {
  if (kind === "telegram") return postTelegram(url, event);
  const body = JSON.stringify(event), timestamp = String(Math.floor(Date.now() / 1000));
  return fetch(new URL("/webhook", url), { method: "POST", body, headers: { "content-type": "application/json", "x-signature-timestamp": timestamp, "x-signature-ed25519": sign(null, Buffer.from(timestamp + body), privateKey).toString("hex") } });
 };
 return { deliveries, assertMenus, create, event, post, apiBase: server.url.origin, rateLimit(value: boolean) { rateLimited = value; }, hold() { hold = true; }, async close() { for (const resolve of held) resolve(); await server.stop(true); } };
}

describe("native channel E2E — mocked local platform REST, real HTTP + openBot + SQLite (not live)", () => {
 for (const kind of ["telegram", "discord"] as const) {
  test(kind + ": Unicode, concurrent duplicate admission, unauthorized rejection, user/topic isolation and command bypass", async () => {
   const dir = await mkdtemp(join(tmpdir(), "channel-e2e-"));
   const platform = platformHarness(kind, dir);
   const channel = platform.create();
   const { bot, faux } = await openLocalBot(dir);
   let commandAccess = 0;
   const transcripts: string[] = [];
   const answer = "안녕 🌍 é <>& @everyone " + "🙂".repeat(2200);
   faux.setResponses([answer, "user two", "topic two", "same conversation"].map(reply => transcript => {
    transcripts.push(JSON.stringify(transcript.messages));
    return fauxAssistantMessage(reply);
   }));
   try {
    await channel.start(channelHandler(channel, bot, forbiddenCommands(() => commandAccess++), context));
    const first = platform.event(1, "/fast toggle FIRST_PRIVATE_안녕🌍");
    const duplicates = await Promise.all(Array.from({ length: 6 }, () => platform.post(channel.url(), first)));
    expect(duplicates.map(r => r.status)).toEqual(Array(6).fill(200));
    await until(() => channel.health().done === 1, "first delivery");
    expect(faux.state.callCount).toBe(1);
    // Telegram chunks are multiple REST requests, but one logical delivery.
    const wire = platform.deliveries.map(d => d.text).join("");
    const escaped = answer.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    expect(wire).toBe(kind === "telegram" ? escaped : answer);
    if (kind === "telegram") {
     expect(wire).not.toContain("<"); expect(wire).not.toContain(">");
     expect(wire.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&")).toBe(answer);
    }
    platform.assertMenus(1);
    expect(platform.deliveries.length).toBe(kind === "telegram" ? 2 : 1);
    for (const delivery of platform.deliveries) {
     if (kind === "telegram") {
      expect(delivery.path).toBe("/bot" + token + "/sendMessage"); expect(delivery.method).toBe("POST");
      expect(delivery.payload.chat_id).toBe("-100"); expect(delivery.payload.message_thread_id).toBe(10);
      expect(delivery.payload.parse_mode).toBe("HTML");
      expect(delivery.payload.link_preview_options).toEqual({ is_disabled: true });
      expect(delivery.text.length).toBeLessThanOrEqual(4096);
     } else {
      expect(delivery.method).toBe("PATCH"); expect(delivery.path).toBe("/webhooks/123/local-token-1/messages/@original");
      expect(delivery.payload.allowed_mentions.parse).toEqual([]);
     }
    }
    const before = platform.deliveries.length;
    expect((await platform.post(channel.url(), platform.event(2, "UNAUTHORIZED", 99))).status).toBe(403);
    // A subsequent accepted event is a FIFO barrier: unauthorized input cannot be hiding in the queue.
    expect((await platform.post(channel.url(), platform.event(3, "SECOND_USER", 2))).status).toBe(200);
    expect((await platform.post(channel.url(), platform.event(4, "SECOND_TOPIC", 1, 20))).status).toBe(200);
    expect((await platform.post(channel.url(), platform.event(5, "SAME_THREAD", 1, 10))).status).toBe(200);
    await until(() => channel.health().done === 4, "isolated conversations");
    expect(faux.state.callCount).toBe(4);
    expect(platform.deliveries.length).toBe(before + 3);
    expect(transcripts[0]).toContain("FIRST_PRIVATE_안녕🌍");
    expect(transcripts[1]).not.toContain("FIRST_PRIVATE"); expect(transcripts[1]).toContain("SECOND_USER");
    expect(transcripts[2]).not.toContain("FIRST_PRIVATE"); expect(transcripts[2]).not.toContain("SECOND_USER");
    expect(transcripts[3]).toContain("FIRST_PRIVATE"); expect(transcripts[3]).not.toContain("SECOND_TOPIC");
    expect(transcripts.join("")).not.toContain("UNAUTHORIZED"); expect(commandAccess).toBe(0);
   } finally { await channel.stop(); await bot.close(context); await platform.close(); await rm(dir, { recursive: true, force: true }); }
  }, 30000);

  test(kind + ": close/reopen replays rendered outbox without another model call and keeps duplicate receipt", async () => {
   const dir = await mkdtemp(join(tmpdir(), "channel-reopen-"));
   const platform = platformHarness(kind, dir);
   let channel = platform.create();
   let current = await openLocalBot(dir);
   const event = platform.event(6, "persist me");
   platform.rateLimit(true);
   current.faux.setResponses([fauxAssistantMessage("persisted reply 🌍")]);
   try {
    await channel.start(channelHandler(channel, current.bot, forbiddenCommands(), context));
    expect((await platform.post(channel.url(), event)).status).toBe(200);
    await until(() => channel.health().ready === 1 && platform.deliveries.length === 1, "durable rendered retry");
    expect(current.faux.state.callCount).toBe(1);
    await channel.stop(); await current.bot.close(context);
    platform.rateLimit(false);
    channel = platform.create(); current = await openLocalBot(dir);
    await channel.start(channelHandler(channel, current.bot, forbiddenCommands(), context));
    await until(() => channel.health().done === 1, "outbox replay");
    expect(current.faux.state.callCount).toBe(0);
    platform.assertMenus(2);
    expect(platform.deliveries.map(d => d.text)).toEqual(["persisted reply 🌍", "persisted reply 🌍"]);
    expect((await platform.post(channel.url(), event)).status).toBe(200);
    // A fresh message drains behind any mistakenly admitted duplicate.
    current.faux.setResponses([fauxAssistantMessage("barrier")]);
    expect((await platform.post(channel.url(), platform.event(7, "barrier"))).status).toBe(200);
    await until(() => channel.health().done === 2, "post-reopen duplicate barrier");
    expect(current.faux.state.callCount).toBe(1); expect(platform.deliveries.length).toBe(3);
   } finally { await channel.stop(); await current.bot.close(context); await platform.close(); await rm(dir, { recursive: true, force: true }); }
  }, 30000);
 }

 for (const boundary of ["before-completion", "ambiguous-send"] as const) {
  test("telegram: real SIGKILL/restart at " + boundary + " boundary (mocked REST)", async () => {
   const dir = await mkdtemp(join(tmpdir(), "channel-crash-"));
   const platform = platformHarness("telegram", dir);
   if (boundary === "ambiguous-send") platform.hold();
   const messages: { kind: string; url?: string; calls?: number }[] = [];
   const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/channel-e2e-child.ts"), dir, platform.apiBase, boundary], { stdout: "ignore", stderr: "pipe", ipc(message) { messages.push(message); } });
   let channel: ReturnType<typeof telegramChannel> | undefined;
   let current: Awaited<ReturnType<typeof openLocalBot>> | undefined;
   try {
    await until(() => messages.some(m => m.kind === "ready"), "child ready");
    expect((await postTelegram(messages.find(m => m.kind === "ready")!.url!, telegramEvent(8, "crash boundary"))).status).toBe(200);
    await until(() => messages.some(m => m.kind === "handled"), "durable bot completion before handler return");
    expect(messages.find(m => m.kind === "handled")!.calls).toBe(1);
    if (boundary === "ambiguous-send") await until(() => platform.deliveries.length === 1, "platform received unacknowledged send");
    child.kill("SIGKILL"); await child.exited;
    expect(child.signalCode).toBe("SIGKILL");
    const db = new Database(join(dir, "inbox.sqlite"));
    try { expect(db.query<{ state: string }, []>("SELECT state FROM jobs").get()!.state).toBe(boundary === "before-completion" ? "processing" : "sending"); } finally { db.close(); }
    current = await openLocalBot(dir); channel = platform.create();
    await channel.start(channelHandler(channel, current.bot, forbiddenCommands(), context));
    await until(() => boundary === "before-completion" ? channel!.health().done === 1 : channel!.health().dead === 1, "restart recovery");
    expect(current.faux.state.callCount).toBe(0);
    platform.assertMenus(2);
    expect(platform.deliveries.map(d => d.text)).toEqual(["durable child reply 🌍"]);
    await channel.stop(); channel = undefined;
    const recovered = new Database(join(dir, "inbox.sqlite"));
    try {
     const row = recovered.query<{ state: string; error: string | null }, []>("SELECT state,error FROM jobs").get()!;
     expect(row.state).toBe(boundary === "before-completion" ? "done" : "dead");
     if (boundary === "ambiguous-send") expect(row.error).toBe("ambiguous_delivery");
    } finally { recovered.close(); }
   } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await child.exited;
    const stderr = await new Response(child.stderr).text();
    await channel?.stop(); await current?.bot.close(context); await platform.close(); await rm(dir, { recursive: true, force: true });
    if (child.exitCode !== null && child.exitCode !== 0 && child.signalCode !== "SIGKILL") throw new Error("Child failed: " + stderr);
   }
  }, 30000);
 }
});
