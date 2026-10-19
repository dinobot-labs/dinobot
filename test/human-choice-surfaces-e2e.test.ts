import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import { Database } from "bun:sqlite";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openBot } from "../src/core/bot.ts";
import { AsksDoc } from "../src/core/ask.ts";
import { createSlackChannel } from "../src/channels/slack.ts";
import { telegramChannel } from "../src/channels/telegram.ts";
import { discordChannel } from "../src/channels/discord.ts";
import { httpChannel } from "../src/channels/http.ts";
import { createTelegramForwarder } from "../src/cli/telegram-run.ts";
import type { InboundMessage } from "../src/channels/types.ts";
import { SCALED_GATE_POLICY } from "./fixtures/gate-policy.ts";

const fullOption = "Postgres — " + "데이터 보존과 트랜잭션 😀 ".repeat(8);
const secret = "0123456789abcdef0123456789abcdef";
const realFetch = globalThis.fetch;
async function until(check: () => boolean) {
 const end = Date.now() + 8000;
 while (!check()) { if (Date.now() > end) throw Error("durable delivery timeout"); await Bun.sleep(10); }
}

// Each surface owns a real SQLite inbox. Only external delivery APIs are mocked;
// webhook authentication, admission, rendering, core execution and quote validation are real.
for (const surface of ["slack", "telegram", "discord"] as const) {
 test(surface + " I1 I2 I3 I4 I5 I6 I8: buttons to quoted human answer through durable adapter", async () => {
  const dir = mkdtempSync(join(tmpdir(), "human-choice-"));
  const databasePath = join(dir, "inbox.sqlite");
  const sent: any[] = [], incoming: InboundMessage[] = [], quoted: string[] = [];
  let calls = 0, askId = "", sequence = 0;
  const faux = fauxProvider({ provider: "faux", models: [{ id: "choice-e2e" }] });
  faux.setResponses(Array.from({ length: 30 }, () => (turn) => {
   calls++;
   const at = turn.messages.findLastIndex(m => m.role === "user");
   if (turn.messages.slice(at + 1).some(m => m.role === "toolResult")) return fauxAssistantMessage("done");
   const text = String(turn.messages[at]?.content);
   if (text.includes("choice:")) {
    quoted.push(text);
    const line = "[ask " + askId + "] choice: " + fullOption;
    return fauxAssistantMessage(fauxToolCall("answer", { ask_id: askId, answer: fullOption, quote: line }), { stopReason: "toolUse" });
   }
   return fauxAssistantMessage(fauxToolCall("ask", { to: "human", kind: "decision", question: "Which database?", options: ["SQLite", fullOption], default: "SQLite" }), { stopReason: "toolUse" });
  }));
  const models = createModels(); models.setProvider(faux.provider);
  const bot = await openBot({ storage: new MemoryStorage(), models, defaultModel: { provider: "faux", modelId: "choice-e2e" }, toolMode: "direct", plugins: [], settings: { retry: { enabled: false } } }, ctx);
  const api = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
   sent.push(surface === "discord" ? JSON.parse(String((await req.formData()).get("payload_json"))) : await req.json());
   return Response.json(surface === "discord" ? { id: "99" } : { ok: true, result: { message_id: 99 } });
  } });
  const mock = spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
   const url = String(input);
   if (url === "https://slack.com/api/chat.postMessage") {
    sent.push(JSON.parse(String(init?.body))); return Response.json({ ok: true, ts: "1791165000.000099" });
   }
   if (new URL(url).hostname === "127.0.0.1") return realFetch(input, init);
   throw Error("Unexpected external API: " + url);
  }) as typeof fetch);
  process.env.HUMAN_E2E_SLACK_SECRET = secret;
  process.env.HUMAN_E2E_SLACK_TOKEN = "xoxb-choice-e2e";
  process.env.HUMAN_E2E_TG_TOKEN = "123:choice_e2e";
  process.env.HUMAN_E2E_TG_SECRET = "choice_e2e_secret";
  const keys = generateKeyPairSync("ed25519");
  const c = surface === "slack" ? createSlackChannel({ port: 0, databasePath, signingSecretEnv: "HUMAN_E2E_SLACK_SECRET", botTokenEnv: "HUMAN_E2E_SLACK_TOKEN", appId: "A123", teamId: "T123", botUserId: "UBOT", allowedUserIds: ["U7", "U8"], allowedChannelIds: ["D123"], toolProgress: "off" })
   : surface === "telegram" ? telegramChannel({ port: 0, databasePath, botTokenEnv: "HUMAN_E2E_TG_TOKEN", webhookSecretEnv: "HUMAN_E2E_TG_SECRET", allowedUserIds: ["7", "8"], allowedChatIds: ["-9"], progress: "off" }, { apiBase: api.url.origin, gatePolicy: SCALED_GATE_POLICY })
   : discordChannel({ port: 0, databasePath, applicationId: "123", publicKey: keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex"), allowedUserIds: ["7", "8"], allowedChannelIds: ["91"] }, { apiBase: api.url.origin });
  const bridge = httpChannel(0);
  const handler = async (m: InboundMessage) => { incoming.push(m); return bot.handle(m, ctx); };
  function event(token?: string, user = surface === "slack" ? "U7" : "7"): unknown {
   const n = ++sequence;
   if (surface === "slack") return token ? { type: "block_actions", api_app_id: "A123", team: { id: "T123" }, user: { id: user }, channel: { id: "D123" }, message: { thread_ts: "1791165000.000001" }, actions: [{ type: "button", value: token, text: { text: "FORGED LABEL" }, action_ts: "1791165000." + String(n).padStart(6, "0") }] }
    : { type: "event_callback", api_app_id: "A123", team_id: "T123", event_id: "Ev" + n, event: { type: "message", user, channel: "D123", channel_type: "im", ts: "1791165000.000001", text: "ASK" } };
   if (surface === "telegram") return token ? { update_id: n, callback_query: { id: "query" + n, from: { id: Number(user), is_bot: false }, message: { chat: { id: -9 }, message_thread_id: 12 }, data: token } }
    : { update_id: n, message: { message_id: n, from: { id: Number(user), is_bot: false }, chat: { id: -9 }, message_thread_id: 12, text: "ASK" } };
   return { id: String((BigInt(Date.now() - 1420070400000) << 22n) + BigInt(n)), application_id: "123", type: token ? 3 : 2, channel_id: "91", user: { id: user }, token: "interaction-" + n, data: token ? { component_type: 2, custom_id: token } : { name: "ask", type: 1, options: [{ name: "prompt", type: 3, value: "ASK" }] } };
  }
  function post(value: unknown, bad = false) {
   const interactive = surface === "slack" && (value as any).type === "block_actions";
   const body = interactive ? new URLSearchParams({ payload: JSON.stringify(value) }).toString() : JSON.stringify(value);
   const time = String(Math.floor(Date.now() / 1000));
   const headers: Record<string, string> = { "content-type": interactive ? "application/x-www-form-urlencoded" : "application/json" };
   if (surface === "slack") Object.assign(headers, { "x-slack-request-timestamp": time, "x-slack-signature": bad ? "v0=" + "0".repeat(64) : "v0=" + createHmac("sha256", secret).update("v0:" + time + ":" + body).digest("hex") });
   else if (surface === "telegram") headers["x-telegram-bot-api-secret-token"] = bad ? "wrong" : "choice_e2e_secret";
   else Object.assign(headers, { "x-signature-timestamp": time, "x-signature-ed25519": bad ? "0".repeat(128) : sign(null, Buffer.from(time + body), keys.privateKey).toString("hex") });
   return realFetch(new URL("/webhook", c.url()), { method: "POST", headers, body });
  }
  try {
   if (surface === "telegram") { await bridge.start(handler); await c.start(createTelegramForwarder(bridge.url().origin)); }
   else await c.start(handler);
   expect((await post(event())).status).toBe(200);
   await until(() => c.health().done === 1);
   const original = incoming[0]!;
   const conversation = await bot.conversation(surface, original.threadKey, ctx);
   const record = (await bot.harness.snapshot(AsksDoc, conversation.id, ctx))!.asks[0]!;
   askId = record.id;
   expect(record).toMatchObject({ state: "open", kind: "decision", options: ["SQLite", fullOption] });
   const buttons = surface === "slack" ? sent.find(p => p.blocks?.some((b: any) => b.type === "actions")).blocks.find((b: any) => b.type === "actions").elements
    : surface === "telegram" ? sent.find(p => p.reply_markup).reply_markup.inline_keyboard.flat()
    : sent[0].components[0].components;
   const token = surface === "slack" ? buttons[1].value : surface === "telegram" ? buttons[1].callback_data : buttons[1].custom_id;
   expect(token).toBe("da:" + askId + ":1");
   const label = surface === "slack" ? buttons[1].text.text : surface === "telegram" ? buttons[1].text : buttons[1].label;
   expect(label).toContain("…"); expect(label).not.toBe(fullOption);
   const before = calls;
   expect((await post(event(token), true)).status).toBe(401);
   expect(calls).toBe(before);
   expect((await post(event(token, surface === "slack" ? "U8" : "8"))).status).toBe(200);
   await until(() => c.health().done === 2);
   expect(calls).toBe(before); expect(JSON.stringify(sent.at(-1))).toContain("이 대화의 질문이 아니거나");
   const click = event(token);
   expect((await post(click)).status).toBe(200);
   await until(() => c.health().done === 3);
   expect(calls - before).toBe(2); // answer tool call plus final reply, exactly one model turn
   expect(incoming.at(-1)).toMatchObject({ threadKey: original.threadKey, userId: original.userId, choice: { askId, option: 1 } });
   expect(incoming.at(-1)!.text).not.toContain(fullOption); // token fallback is not the answer
   expect(quoted).toEqual(['<from user="' + original.userId + '" channel="' + surface + '"/>' + String.fromCharCode(10) + '[ask ' + askId + '] choice: ' + fullOption]);
   const answered = (await bot.harness.snapshot(AsksDoc, conversation.id, ctx))!.asks[0]!;
   expect(answered).toMatchObject({ state: "answered", answer: fullOption, resolvedBy: "human:" + original.userId });
   expect(typeof answered.sourceEntry).toBe("number");
   expect(Number.isSafeInteger(answered.sourceEntry)).toBe(true);
   const after = calls, deliveries = sent.length;
   expect((await post(click)).status).toBe(200);
   expect(c.health().rows).toBe(3); expect(calls).toBe(after); expect(sent).toHaveLength(deliveries);
   expect((await post(event(token))).status).toBe(200);
   await until(() => c.health().done === 4);
   expect(JSON.stringify(sent.at(-1))).toContain("이미 처리되었습니다"); expect(calls).toBe(after);
   const expiredId = "e".repeat(32);
   await bot.harness.commit(async tx => { const doc = await tx.doc(AsksDoc, conversation.id); doc.asks.push({ ...record, id: expiredId, deadlineAt: Date.now() - 1 }); }, ctx);
   expect((await post(event("da:" + expiredId + ":1"))).status).toBe(200);
   await until(() => c.health().done === 5);
   expect(JSON.stringify(sent.at(-1))).toContain("마감"); expect(calls).toBe(after);
   expect((await bot.harness.snapshot(AsksDoc, conversation.id, ctx))!.asks.find(a => a.id === expiredId)!.state).toBe("open");
   // Windows inbox uses exclusive locking: release the real engine before inspecting persisted jobs.
   await c.stop();
   const db = new Database(databasePath, { readonly: true });
   try { expect(db.query("SELECT COUNT(*) AS n FROM jobs").get()).toEqual({ n: 5 }); } finally { db.close(); }
  } finally {
   await c.stop(); await bridge.stop(); await bot.close(ctx); await api.stop(true); mock.mockRestore(); rmSync(dir, { recursive: true, force: true });
  }
 }, 20000);
}
