import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TELEGRAM_DEFAULT_CONCURRENCY, telegramChannel } from "../src/channels/telegram.ts";
import type { MessagingChannel } from "../src/channels/messaging.ts";
import type { InboundMessage, MessageHandler } from "../src/channels/types.ts";
import { SCALED_GATE_POLICY } from "./fixtures/gate-policy.ts";

const DEADLINE_MS = 1500;
type Send = { chat_id: string; message_thread_id: number; text: string; parse_mode?: string; link_preview_options?: { is_disabled: boolean } };
function gate() {
 let release!: () => void;
 const promise = new Promise<void>(resolve => { release = resolve; });
 return { promise, release };
}
// Short predicate polling observes real channel health, not a guessed completion sleep.
async function observed(predicate: () => boolean, ms = DEADLINE_MS): Promise<boolean> {
 const end = performance.now() + ms;
 while (!predicate()) {
  if (performance.now() >= end) return false;
  await Bun.sleep(5);
 }
 return true;
}
async function until(predicate: () => boolean, description: string, ms = DEADLINE_MS) {
 if (!await observed(predicate, ms)) throw new Error(description + " (" + ms + "ms deadline)");
}
function event(id: number, topic: number, user = 7) {
 return { update_id: id, message: { message_id: id, from: { id: user, is_bot: false }, chat: { id: -9, type: "supergroup" }, message_thread_id: topic, text: "request-" + id } };
}

// Real-adapter/local-HTTP/temp-SQLite boundary from messaging-native and telegram-polling.
// No concurrency knob: these tests specify Telegram's default slot policy (TELEGRAM_DEFAULT_CONCURRENCY = 12). The shared API gate is active with the
// explicitly scaled policy (fixtures/gate-policy.ts): only its time constants shrink, so chunk sends to one chat are
// spaced 25 ms instead of 1 s. Handler starts and slots never wait on the gate, so every barrier assertion is unchanged.
async function withTelegram(
 handler: MessageHandler,
 barriers: ReturnType<typeof gate>[],
 run: (c: MessagingChannel, post: (id: number, topic: number, user?: number) => Promise<void>, sent: Send[]) => Promise<void>,
 onSend?: (body: Send) => Promise<void>,
) {
 const dir = mkdtempSync(join(tmpdir(), "tg-topic-scheduler-"));
 const suffix = crypto.randomUUID().replaceAll("-", "");
 const tokenEnv = "TG_TOPIC_TEST_TOKEN_" + suffix, secretEnv = "TG_TOPIC_TEST_SECRET_" + suffix;
 process.env[tokenEnv] = "731:test_only_topic_scheduler";
 process.env[secretEnv] = "test_only_" + suffix;
 const sent: Send[] = [], methods: string[] = [];
 let c: MessagingChannel | undefined;
 let server: ReturnType<typeof Bun.serve> | undefined;
 try {
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
   const method = new URL(req.url).pathname.split("/").at(-1)!;
   methods.push(method);
   if (method === "setMyCommands") return Response.json({ ok: true, result: true });
   if (method !== "sendMessage") return Response.json({ ok: false }, { status: 400 });
   const body = await req.json() as Send;
   sent.push(body);
   await onSend?.(body);
   return Response.json({ ok: true });
  } });
  c = telegramChannel({ mode: "webhook", port: 0, databasePath: join(dir, "inbox.sqlite"), botTokenEnv: tokenEnv, webhookSecretEnv: secretEnv, allowedUserIds: ["7", "8"], allowedChatIds: ["-9"], progress: "off", steering: "off" /* lane FIFO mechanics under test; steering is ADR 0057's own suite */ }, { apiBase: server.url.origin, gatePolicy: SCALED_GATE_POLICY });
  await c.start(handler);
  const channel = c;
  const post = async (id: number, topic: number, user = 7) => {
   const response = await fetch(new URL("/webhook", channel.url()), { method: "POST", headers: { "x-telegram-bot-api-secret-token": process.env[secretEnv]! }, body: JSON.stringify(event(id, topic, user)), signal: AbortSignal.timeout(DEADLINE_MS) });
   expect(response.status).toBe(200);
   await response.arrayBuffer();
  };
  await run(c, post, sent);
  expect(methods.filter(method => method === "setMyCommands")).toHaveLength(1);
  expect(methods[0]).toBe("setMyCommands");
  expect(methods.slice(1).every(method => method === "sendMessage")).toBe(true);
 } finally {
  // Release every model and HTTP barrier even after a failed pre-release assertion.
  for (const barrier of barriers) barrier.release();
  try { await c?.stop(); }
  finally {
   try { await server?.stop(true); }
   finally { rmSync(dir, { recursive: true, force: true }); delete process.env[tokenEnv]; delete process.env[secretEnv]; }
  }
 }
}

test("default Telegram scheduler completes fast topic B while slow topic A is still blocked", async () => {
 const slow = gate();
 const started: string[] = [], finished: string[] = [];
 await withTelegram(async m => {
  started.push(m.messageId);
  if (m.messageId === "1") await slow.promise;
  finished.push(m.messageId);
  return { status: "answered", text: "answer-" + m.messageId };
 }, [slow], async (c, post, sent) => {
  await post(1, 101);
  await until(() => started.includes("1"), "setup: topic A handler must start");
  await post(2, 202); // ACK proves B is durably admitted after A has occupied a slot.
  const bCompletedBeforeARelease = await observed(() => c.health().done === 1 && sent.some(s => s.message_thread_id === 202));
  expect({ bCompletedBeforeARelease, aStillBlocked: !finished.includes("1"), started }).toEqual({ bCompletedBeforeARelease: true, aStillBlocked: true, started: ["1", "2"] });
  expect(sent.map(s => [s.message_thread_id, s.text])).toEqual([[202, "answer-2"]]);
  slow.release();
  await until(() => c.health().done === 2, "both topics must eventually finish");
  expect(finished).toEqual(["2", "1"]);
  expect(sent.map(s => [s.message_thread_id, s.text])).toEqual([[202, "answer-2"], [101, "answer-1"]]);
  expect(c.health().dead).toBe(0);
 });
});

for (const distinctUsers of [false, true]) test(
 "Telegram physical topic stays FIFO through every reply chunk for " + (distinctUsers ? "distinct users" : "one user"),
 async () => {
  const model = gate(), firstChunk = gate(), lastChunk = gate();
  const started: InboundMessage[] = [], trace: string[] = [];
  const full = "a".repeat(4095) + "😀" + "b".repeat(4094) + "tail";
  let chunk = 0;
  await withTelegram(async m => {
   started.push(m); trace.push("handler:" + m.messageId);
   if (m.messageId === "1") await model.promise;
   return { status: "answered", text: m.messageId === "1" ? full : "answer-" + m.messageId };
  }, [model, firstChunk, lastChunk], async (c, post, sent) => {
   await post(1, 303);
   await until(() => started.length === 1, "first same-topic handler must start");
   await post(2, 303, distinctUsers ? 8 : 7);
   await post(3, 303);
   expect(started.map(m => m.messageId)).toEqual(["1"]);
   expect(sent).toEqual([]);
   model.release();
   await until(() => chunk >= 1, "first reply chunk must reach fake Telegram");
   expect(started.map(m => m.messageId)).toEqual(["1"]);
   expect(sent).toHaveLength(1);
   firstChunk.release();
   await until(() => chunk >= 3, "final reply chunk must reach fake Telegram");
   // Handler completion alone must not unlock the physical topic, even for user 8.
   expect(started.map(m => m.messageId)).toEqual(["1"]);
   expect(sent).toHaveLength(3);
   expect(sent.map(s => s.text).join("")).toBe(full);
   lastChunk.release();
   await until(() => c.health().done === 3, "same-topic queue must drain");
   expect(started.map(m => m.messageId)).toEqual(["1", "2", "3"]);
   expect(started.map(m => m.threadKey)).toEqual(["731:-9:303:7", "731:-9:303:" + (distinctUsers ? "8" : "7"), "731:-9:303:7"]);
   expect(trace).toEqual(["handler:1", "send:1", "ack:1", "send:2", "ack:2", "send:3", "ack:3", "handler:2", "send:4", "ack:4", "handler:3", "send:5", "ack:5"]);
   expect(sent.slice(3).map(s => s.text)).toEqual(["answer-2", "answer-3"]);
   for (const body of sent) {
    expect(body.chat_id).toBe("-9"); expect(body.message_thread_id).toBe(303);
    expect(body.text.length).toBeLessThanOrEqual(4096); expect(body.text).not.toContain("�"); expect(body.parse_mode).toBe("HTML");
    expect(body.link_preview_options).toEqual({ is_disabled: true });
   }
   expect(c.health().dead).toBe(0);
  }, async () => {
   const index = ++chunk; trace.push("send:" + index);
   if (index === 1) await firstChunk.promise;
   if (index === 3) await lastChunk.promise;
   trace.push("ack:" + index);
  });
 },
);

test("default Telegram scheduler caps active handlers at twelve and eventually serves three waves of topics", async () => {
 const C = TELEGRAM_DEFAULT_CONCURRENCY, N = 3 * C;
 expect(C).toBe(12);
 const barriers = Array.from({ length: N }, () => gate());
 const started: number[] = [], completed: number[] = [];
 let active = 0, maximum = 0;
 await withTelegram(async m => {
  const id = Number(m.messageId);
  started.push(id); active++; maximum = Math.max(maximum, active);
  try { await barriers[id - 1]!.promise; completed.push(id); return { status: "answered", text: "answer-" + id }; }
  finally { active--; }
 }, barriers, async (c, post, sent) => {
  // Sequential ACKs establish deterministic durable admission, not Promise.all races.
  for (let id = 1; id <= N; id++) await post(id, 400 + id);
  for (let wave = 0; wave < 3; wave++) {
   await until(() => started.length >= (wave + 1) * C, C + " independent topics must occupy the default slots in wave " + wave);
   // The next wave must not start before a slot settles.
   expect(await observed(() => started.length > (wave + 1) * C, 100)).toBe(false);
   expect(active).toBe(C);
   expect(maximum).toBeLessThanOrEqual(C);
   expect(started).toHaveLength((wave + 1) * C);
   // Completion order deliberately differs from admission; no topic may starve.
   for (const id of started.slice(wave * C).reverse()) barriers[id - 1]!.release();
  }
  // N replies to one chat pass the scaled gate (20 writes per 1.5 s): a longer drain deadline only.
  await until(() => c.health().done === N, "all admitted topics must be served", 15000);
  expect(maximum).toBe(C); expect(active).toBe(0);
  expect([...started].sort((a, b) => a - b)).toEqual(Array.from({ length: N }, (_, i) => i + 1));
  expect([...completed].sort((a, b) => a - b)).toEqual(Array.from({ length: N }, (_, i) => i + 1));
  expect(sent).toHaveLength(N);
  expect(sent.map(s => s.message_thread_id).sort((a, b) => a - b)).toEqual(Array.from({ length: N }, (_, i) => 401 + i));
  for (const body of sent) expect(body.text).toBe("answer-" + (body.message_thread_id - 400));
  expect(c.health().dead).toBe(0);
 });
});
