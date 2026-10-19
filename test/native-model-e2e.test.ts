import { expect, spyOn, test } from "bun:test";
import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { AgentDoc } from "@earendil-works/pi-durable";
import { openBot } from "../src/core/bot.ts";
import { createNativeModelHandler } from "../src/core/native-model-commands.ts";
import { channelHandler } from "../src/core/channel-handler.ts";
import { telegramChannel } from "../src/channels/telegram.ts";
import { discordChannel } from "../src/channels/discord.ts";
import { createSlackChannel } from "../src/channels/slack.ts";
import { httpChannel } from "../src/channels/http.ts";
import { createTelegramForwarder } from "../src/cli/telegram-run.ts";
import { context, forbiddenCommands } from "./fixtures/channel-e2e-child.ts";
import type { InboundMessage } from "../src/channels/types.ts";

const realFetch = globalThis.fetch;
const keys = generateKeyPairSync("ed25519");
const secret = "0123456789abcdef0123456789abcdef";
async function until(fn: () => boolean, label: string) {
 const deadline = Date.now() + 10000;
 while (!fn()) { if (Date.now() > deadline) throw new Error("Timeout: " + label); await Bun.sleep(10); }
}
async function open(dir: string) {
 const faux = fauxProvider({ provider: "faux", models: [{ id: "default" }, { id: "selected" }] });
 const models = createModels(); models.setProvider(faux.provider);
 const bot = await openBot({ storage: await openNodeSqliteStorage(join(dir, "bot.sqlite")), models, defaultModel: { provider: "faux", modelId: "default" }, toolMode: "codemode-only", plugins: [], curation: { enabled: false } }, context);
 const calls: { model: string; transcript: string }[] = [];
 faux.setResponses(Array.from({ length: 30 }, () => (transcript, _options, _state, model) => {
  calls.push({ model: model.id, transcript: JSON.stringify(transcript.messages) });
  return fauxAssistantMessage("MODEL_REPLY_" + model.id);
 }));
 return { bot, models, faux, calls, native: createNativeModelHandler(bot, models, context) };
}

// Tests are deliberately sequential: one bounded outbound mock, captured realFetch for
// ingress/loopback. No platform endpoints, credentials, process signals or global commands.
test("direct core flight rejects selection until idle without changing the running model", async () => {
 const dir = await mkdtemp(join(tmpdir(), "native-flight-"));
 const current = await open(dir);
 const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
 let runningModel = "";
 current.faux.setResponses([async (_transcript, _options, _state, model) => {
  runningModel = model.id; entered.resolve(); await release.promise;
  return fauxAssistantMessage("flight finished");
 }]);
 const message: InboundMessage = { channel: "telegram", threadKey: "flight", userId: "1", messageId: "1", text: "RUNNING_INPUT" };
 // Messaging adapters serialize globally; use the actual core turn to exercise the
 // busy policy rather than assuming a second adapter job runs concurrently.
 const flight = current.bot.handle(message, context);
 try {
  await entered.promise;
  const rejected = await current.native({ ...message, messageId: "2", text: "/model faux/selected" });
  expect(rejected.status === "answered" && rejected.text).toContain("busy or queued");
  const conversation = await current.bot.conversation(message.channel, message.threadKey, context);
  expect((await current.bot.harness.snapshot(AgentDoc, conversation.id, context))?.model?.modelId).toBe("default");
  expect(runningModel).toBe("default");
  release.resolve(); await flight;
  const accepted = await current.native({ ...message, messageId: "3", text: "/model faux/selected" });
  expect(accepted.status === "answered" && accepted.text).toContain("selected for this conversation");
  expect(current.faux.state.callCount).toBe(1);
 } finally { release.resolve(); await flight; await current.bot.close(context); await rm(dir, { recursive: true, force: true }); }
}, 15000);

for (const platform of ["telegram", "discord", "slack", "telegram-sidecar"] as const) {
 test(platform + ": signed ingress, scoped selection, durable retry/restart and unchanged global defaults", async () => {
  const dir = await mkdtemp(join(tmpdir(), "native-model-e2e-"));
  process.env.NATIVE_E2E_TOKEN = "101:local_only";
  process.env.NATIVE_E2E_SECRET = secret;
  process.env.NATIVE_E2E_SLACK = "xoxb-local-only";
  let current = await open(dir);
  const delivered: string[] = [];
  const seen: InboundMessage[] = [];
  let limited = false, privileged = 0;
  const remote = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
   // Startup menu is not a delivered model-control reply and must never share the send fault hook.
   if (new URL(request.url).pathname.endsWith("/setMyCommands")) return Response.json({ ok: true, result: true });
   let text: string;
   if (platform === "discord") text = JSON.parse(String((await request.formData()).get("payload_json"))).content;
   else text = ((await request.json()) as { text: string }).text;
   delivered.push(text);
   return limited ? Response.json({ retry_after: 1, parameters: { retry_after: 1 } }, { status: 429, headers: { "retry-after": "1" } })
    : Response.json({ ok: true, result: { message_id: 1 }, id: "99", ts: "1791165000.000001" });
  } });
  // Slack has a fixed production URL; redirect only its outbound REST call locally.
  const mock = platform === "slack" ? spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
   const url = input instanceof Request ? input.url : String(input);
   if (url === "https://slack.com/api/chat.postMessage") return realFetch(remote.url, init);
   if (new URL(url).hostname === "127.0.0.1") return realFetch(input, init);
   throw new Error("Unexpected external request: " + url);
  }) as typeof fetch) : undefined;
  const make = () => {
   const common = { port: 0, databasePath: join(dir, "inbox.sqlite"), requestTimeoutMs: 2000 };
   if (platform === "discord") return discordChannel({ ...common, applicationId: "123", publicKey: keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex"), allowedUserIds: ["1", "2"], allowedParentChannelIds: ["9"] }, { apiBase: remote.url.origin });
   if (platform === "slack") return createSlackChannel({ ...common, signingSecretEnv: "NATIVE_E2E_SECRET", botTokenEnv: "NATIVE_E2E_SLACK", appId: "A123", teamId: "T123", botUserId: "UBOT", allowedUserIds: ["U1", "U2"], allowedChannelIds: ["C123"] });
   return telegramChannel({ ...common, botTokenEnv: "NATIVE_E2E_TOKEN", webhookSecretEnv: "NATIVE_E2E_SECRET", allowedUserIds: ["1", "2"], allowedChatIds: ["-100"] }, { apiBase: remote.url.origin });
  };
  let channel = make(), http = httpChannel(0);
  const start = async () => {
   const native = current.native;
   const handler = channelHandler(channel, current.bot, forbiddenCommands(() => privileged++), context, native);
   if (platform === "telegram-sidecar") await http.start(channelHandler(http, current.bot, forbiddenCommands(() => privileged++), context), native);
   const route = platform === "telegram-sidecar" ? createTelegramForwarder(http.url().origin) : handler;
   await channel.start(async (message, signal) => { seen.push(message); return route(message, signal); });
  };
  let sequence = 0;
  const envelope = (text: string, topic = 10, user = 1) => {
   const id = ++sequence;
   if (platform === "discord") {
    const [command, ...args] = text.split(" ");
    const name = command === "/model" ? "model" : command === "/models" ? "models" : "ask";
    const options = name === "ask" ? [{ name: "prompt", type: 3, value: text }] : name === "models" ? [{ name: "provider", type: 3, value: "faux" }, { name: "page", type: 4, value: 1 }] : args.length ? [{ name: "model", type: 3, value: args.join(" ") }] : [];
    return { id: String((BigInt(Date.now() - 1420070400000) << 22n) + BigInt(id)), application_id: "123", type: 2, channel_id: String(topic), channel: { id: String(topic), parent_id: "9", type: 11 }, user: { id: String(user) }, token: "local-token", data: { name, type: 1, options } };
   }
   if (platform === "slack") return { type: "event_callback", api_app_id: "A123", team_id: "T123", event_id: "Ev" + id, event: { type: "app_mention", user: "U" + user, channel: "C123", ts: "1791165000." + String(id).padStart(6, "0"), thread_ts: "1791165000." + String(topic).padStart(6, "0"), text: "<@UBOT> " + text } };
   return { update_id: id, message: { message_id: id, from: { id: user, is_bot: false }, chat: { id: -100, type: "supergroup", is_forum: true }, message_thread_id: topic, is_topic_message: true, text } };
  };
  const post = async (data: unknown) => {
   const body = JSON.stringify(data), timestamp = String(Math.floor(Date.now() / 1000));
   const headers: Record<string, string> = { "content-type": "application/json" };
   if (platform === "discord") { headers["x-signature-timestamp"] = timestamp; headers["x-signature-ed25519"] = sign(null, Buffer.from(timestamp + body), keys.privateKey).toString("hex"); }
   else if (platform === "slack") { headers["x-slack-request-timestamp"] = timestamp; headers["x-slack-signature"] = "v0=" + createHmac("sha256", secret).update("v0:" + timestamp + ":" + body).digest("hex"); }
   else headers["x-telegram-bot-api-secret-token"] = secret;
   return realFetch(new URL("/webhook", channel.url()), { method: "POST", headers, body });
  };
  let done = 0;
  const turn = async (text: string, topic = 10, user = 1) => {
   expect((await post(envelope(text, topic, user))).status).toBe(200);
   done++; await until(() => channel.health().done === done, text);
   return delivered.at(-1)!;
  };
  try {
   await start();
   await turn("EXISTING_OTHER", 20);
   expect(current.calls.at(-1)?.model).toBe("default");
   expect(await turn("/models faux 1")).toContain("faux/selected");
   expect(await turn("/model faux/missing")).toBe("Unknown model.");
   expect((await post(envelope("/model faux/selected", 10, 999))).status).toBe(403);
   expect(await turn("/model")).toContain("Current model: faux/default");
   const command = envelope("/model faux/selected");
   limited = true;
   expect((await post(command)).status).toBe(200);
   await until(() => channel.health().ready === 1 && delivered.at(-1)?.includes("selected for this conversation") === true, "command rendered before 429");
   const rendered = delivered.at(-1)!;
   expect(current.calls).toHaveLength(1);
   expect((await post(command)).status).toBe(200);
   await channel.stop(); await http.stop(); await current.bot.close(context);
   current = await open(dir); channel = make(); http = httpChannel(0); limited = false;
   await start(); done++;
   await until(() => channel.health().done === done, "persisted command outbox");
   expect(delivered.at(-1)).toBe(rendered);
   expect(current.calls).toHaveLength(0);
   expect((await post(command)).status).toBe(200);
   const beforeCurrent = delivered.length;
   const currentReply = await turn("/model");
   expect(currentReply).toBe("Current model: faux/selected\nReasoning: off\nUsage: /model [provider/modelId]; /models [provider] [page]");
   expect(delivered.length).toBe(beforeCurrent + 1);
   const next = envelope("OWN_NEXT");
   const beforeTurn = delivered.length;
   limited = true;
   expect((await post(next)).status).toBe(200);
   await until(() => channel.health().ready === 1 && delivered.length > beforeTurn, "model reply outbox 429");
   expect(current.calls).toHaveLength(1);
   expect((await post(next)).status).toBe(200);
   limited = false; done++;
   await until(() => channel.health().done === done, "model reply retry");
   expect(current.calls).toHaveLength(1);
   expect(delivered.slice(beforeTurn)).toEqual(["MODEL_REPLY_selected", "MODEL_REPLY_selected"]);
   expect(current.calls.at(-1)?.model).toBe("selected");
   if (platform === "telegram-sidecar") expect(current.calls.at(-1)?.transcript).toContain(JSON.stringify("Telegram message:\nOWN_NEXT").slice(1, -1));
   for (const [topic, user] of [[20, 1], [30, 1], [10, 2]]) {
    await turn("DEFAULT_SCOPE_" + topic + "_" + user, topic, user);
    expect(current.calls.at(-1)?.model).toBe("default");
    expect(current.calls.at(-1)?.transcript).not.toContain("OWN_NEXT");
   }
   // Unrelated fresh local conversation detects accidental mutation of global default.
   const fresh = await current.bot.conversation("local", "created-after-selection", context);
   expect((await current.bot.harness.snapshot(AgentDoc, fresh.id, context))?.model?.modelId).toBe("default");
   expect(seen.filter(m => m.text === "/model faux/selected")).toHaveLength(1);
   const own = seen.find(m => m.text === "OWN_NEXT")!;
   expect(own.threadKey).toBe(seen.find(m => m.text === "/model faux/selected")!.threadKey);
   expect(privileged).toBe(0);
  } finally {
   await channel.stop(); await http.stop(); await current.bot.close(context); mock?.mockRestore(); await remote.stop(true); await rm(dir, { recursive: true, force: true });
   delete process.env.NATIVE_E2E_TOKEN; delete process.env.NATIVE_E2E_SECRET; delete process.env.NATIVE_E2E_SLACK;
  }
 }, 30000);
}
