import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_STEERS, messagingChannel, type MessagingChannel, type MessagingPlatform } from "../src/channels/messaging.ts";
import type { BotReply, HandlerOptions, InboundMessage } from "../src/channels/types.ts";

// ADR 0057 steering, on the generic durable engine with a lane policy that steers same-thread messages. No Telegram
// REST or shared API gate: the worker model (S1–S6) is what is under test. Barriers decide ordering; sleeps only show
// that something did NOT happen within a window.
const dirs: string[] = [], channels: MessagingChannel[] = [], servers: ReturnType<typeof Bun.serve>[] = [];
type Gate = { promise: Promise<void>; release(): void };
const gates: Gate[] = [];
function gate(): Gate { let release!: () => void; const promise = new Promise<void>((r) => { release = r; }); const g = { promise, release }; gates.push(g); return g; }
afterEach(async () => {
 for (const g of gates.splice(0)) g.release();
 for (const c of channels.splice(0)) await c.stop();
 for (const s of servers.splice(0)) await s.stop(true);
 for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
async function until(fn: () => boolean, label: string, ms = 4000) { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error("timeout: " + label); await Bun.sleep(5); } }
function dbPath() { const dir = mkdtempSync(join(tmpdir(), "steering-")); dirs.push(dir); return join(dir, "inbox.sqlite"); }
const rows = (path: string) => { const db = new Database(path); try { return db.query("SELECT seq, id, state, error, answer, parts FROM jobs ORDER BY seq").all() as Record<string, any>[]; } finally { db.close(); } };

type Sent = { text: string; at: number };
function fakeSink() {
 const sent: Sent[] = [];
 const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) { const body = (await req.json()) as { text: string }; sent.push({ text: body.text, at: Date.now() }); return Response.json({ ok: true }); } });
 servers.push(server);
 return { base: server.url.origin, sent };
}
/** Generic platform: webhook JSON `{id, user, text}`; one lane per chat; same-thread messages may steer. */
function platform(base: string): MessagingPlatform {
 return {
  name: "fake", storageIdentity: "fake:1", admissionTimeoutMs: 1000, replaySafe: true,
  scheduling: { policy: "fake-lane-v1", concurrency: 4, lane: () => "lane:1", steer: (message, active) => message.threadKey === active.threadKey },
  authorizeStored: () => true, retryAfter: () => null,
  receive(_request, body) {
   const { id, user, text } = JSON.parse(Buffer.from(body).toString("utf8")) as { id: number; user: string; text: string };
   return { status: 200, admission: { message: { channel: "fake", threadKey: "thread:" + user, messageId: String(id), userId: user, text }, target: { chat: "1" } } };
  },
  render: (text) => [text],
  delivery: (_target, part) => ({ idempotent: true, url: base + "/send", init: { method: "POST", body: JSON.stringify({ text: part }) } }),
  success: (_response, body) => { try { return JSON.parse(body).ok === true; } catch { return false; } },
 };
}
type Call = { message: InboundMessage; options: HandlerOptions | undefined; signal: AbortSignal | undefined; at: number };
/** Resolves with the gate or rejects when the execution is aborted (a cooperative handler). */
const cooperative = (g: Gate, signal: AbortSignal | undefined) => new Promise<void>((resolve, reject) => { g.promise.then(resolve); signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); });
function start(handler: (call: Call) => Promise<BotReply>, databasePath = dbPath()) {
 const sink = fakeSink();
 const c = messagingChannel({ port: 0, databasePath, allowedUserIds: ["1"] }, platform(sink.base));
 channels.push(c);
 const calls: Call[] = [];
 const started = c.start(async (message, signal, _progress, options) => { const call = { message, options, signal, at: Date.now() }; calls.push(call); return handler(call); });
 return { c, sink, calls, started, databasePath };
}
async function post(c: MessagingChannel, id: number, text: string, user = "a") {
 const response = await fetch(new URL("/webhook", c.url()), { method: "POST", body: JSON.stringify({ id, user, text }), signal: AbortSignal.timeout(4000) });
 await response.arrayBuffer();
 return response.status;
}
const answered = (text: string, answer?: number): BotReply => ({ status: "answered", text, ...(answer !== undefined ? { answer } : {}) });
const steerCalls = (calls: Call[]) => calls.filter((call) => call.options?.whenBusy === "steer");

test("S1/S2: a same-thread message joins the running turn at once without a slot; another thread waits in FIFO", async () => {
 const held = gate();
 const { c, calls, started } = start(async (call) => { if (call.message.messageId === "1") await held.promise; return answered("answer " + call.message.messageId, Number(call.message.messageId)); });
 await started;
 expect(await post(c, 1, "first")).toBe(200);
 await until(() => calls.length === 1, "primary starts");
 expect(await post(c, 2, "more for the same turn")).toBe(200);
 expect(await post(c, 3, "someone else", "b")).toBe(200);
 await until(() => calls.length === 2, "steer starts while the primary is held");
 expect(calls[1]).toMatchObject({ message: { messageId: "2", threadKey: "thread:a" }, options: { whenBusy: "steer" } });
 await Bun.sleep(100);
 expect(calls).toHaveLength(2); // the other thread is behind the lane head, not steered
 // The steer answered at once (its own answer id) and waits ready behind the head; it took no slot.
 expect(c.health()).toMatchObject({ active: 1, steering: 0, ready: 1, queued: 1, processing: 1 });
 held.release();
 await until(() => c.health().done === 3, "everything settles");
 expect(calls.map((call) => call.message.messageId)).toEqual(["1", "2", "3"]);
 expect(calls[2]!.options?.whenBusy).toBeUndefined();
});

test("S4: one shared answer is delivered exactly once, whichever of primary or steer settles first; the other is a steered receipt", async () => {
 for (const steerFirst of [false, true]) {
  const held = gate(), heldSteer = gate();
  const { c, sink, calls, started, databasePath } = start(async (call) => {
   await (call.message.messageId === "1" ? held.promise : heldSteer.promise);
   return answered("shared answer", 77);
  });
  await started;
  await post(c, 1, "first");
  await until(() => calls.length === 1, "primary starts");
  await post(c, 2, "steer");
  await until(() => calls.length === 2, "steer starts");
  if (steerFirst) { heldSteer.release(); await until(() => c.health().ready === 1, "steer ready behind the head"); expect(sink.sent).toHaveLength(0); held.release(); }
  else { held.release(); await until(() => sink.sent.length === 1, "primary delivered"); heldSteer.release(); }
  await until(() => c.health().done === 2, "both receipts");
  await Bun.sleep(100);
  expect(sink.sent.map((s) => s.text)).toEqual(["shared answer"]);
  await c.stop(); channels.pop();
  const stored = rows(databasePath);
  expect(stored.map((r) => [r.id, r.state, r.error])).toEqual(steerFirst ? [["1", "done", "steered"], ["2", "done", null]] : [["1", "done", null], ["2", "done", "steered"]]);
  expect(stored.map((r) => r.answer)).toEqual([steerFirst ? null : 77, steerFirst ? 77 : null]);
 }
});

test("S3/S6: the primary's delivery is not held by a pending steer; the steer's own answer is delivered after it", async () => {
 const heldSteer = gate();
 const { c, sink, calls, started } = start(async (call) => {
  if (call.message.messageId === "2") { await heldSteer.promise; return answered("own answer", 2); }
  await Bun.sleep(30);
  return answered("primary", 1);
 });
 await started;
 await post(c, 1, "first");
 await until(() => calls.length === 1, "primary starts");
 await post(c, 2, "steer that becomes its own turn");
 await until(() => calls.length === 2, "steer starts");
 // The sink sees request acceptance before the engine observes its response and commits done. Wait for both
 // evidence surfaces; the steer stays held, so this still proves primary settlement does not wait for it.
 await until(() => sink.sent.length === 1 && c.health().done === 1, "primary delivered and committed while the steer is pending");
 expect(c.health()).toMatchObject({ steering: 1, done: 1 });
 await Bun.sleep(80); // the parked lane (head = steer row) neither delivers nor busy-loops
 expect(sink.sent).toHaveLength(1);
 heldSteer.release();
 await until(() => sink.sent.length === 2, "steer delivered afterwards");
 expect(sink.sent.map((s) => s.text)).toEqual(["primary", "own answer"]);
});

test("S5: a steer without an answer runs again as an ordinary turn from the lane head, and is never steered twice", async () => {
 const held = gate();
 const { c, sink, calls, started, databasePath } = start(async (call) => {
  if (call.message.messageId === "1") { await held.promise; return answered("primary", 1); }
  if (call.options?.whenBusy === "steer") return { status: "unanswered", reason: "aborted" };
  return answered("second as its own turn", 2);
 });
 await started;
 await post(c, 1, "first");
 await until(() => calls.length === 1, "primary starts");
 await post(c, 2, "second");
 await until(() => calls.length === 2 && c.health().queued === 1 && c.health().steering === 0, "steer failed and requeued");
 await Bun.sleep(80);
 expect(steerCalls(calls)).toHaveLength(1);
 held.release();
 await until(() => c.health().done === 2, "both delivered in order");
 expect(sink.sent.map((s) => s.text)).toEqual(["primary", "second as its own turn"]);
 expect(calls.map((call) => [call.message.messageId, call.options?.whenBusy])).toEqual([["1", undefined], ["2", "steer"], ["2", undefined]]);
 await c.stop(); channels.pop();
 expect(rows(databasePath).map((r) => [r.id, r.state, r.error])).toEqual([["1", "done", null], ["2", "done", null]]);
});

test("S1 bound: at most MAX_STEERS steers attach; the rest wait queued and attach as room frees", async () => {
 const held = gate(), heldSteers = gate();
 const { c, calls, started } = start(async (call) => {
  if (call.message.messageId === "1") { await held.promise; return answered("primary", 1); }
  await heldSteers.promise;
  return answered("steer " + call.message.messageId, Number(call.message.messageId));
 });
 await started;
 await post(c, 1, "first");
 await until(() => calls.length === 1, "primary starts");
 for (let id = 2; id <= MAX_STEERS + 3; id++) await post(c, id, "m" + id);
 await until(() => steerCalls(calls).length === MAX_STEERS, "steers attached up to the bound");
 await Bun.sleep(80);
 expect(c.health()).toMatchObject({ steering: MAX_STEERS, queued: 2, active: 1 });
 heldSteers.release();
 await until(() => steerCalls(calls).length === MAX_STEERS + 2, "the remaining two attach as room frees");
 held.release();
 await until(() => c.health().done === MAX_STEERS + 3, "all settle");
});

test("restart keeps S4: a steer recovered as queued whose redelivery returns the delivered answer becomes a receipt", async () => {
 const databasePath = dbPath();
 const held = gate(), heldSteer = gate();
 const first = start(async (call) => { await cooperative(call.options?.whenBusy === "steer" ? heldSteer : held, call.signal); return answered("the answer", 9); }, databasePath);
 await first.started;
 await post(first.c, 1, "first");
 await until(() => first.calls.length === 1, "primary starts");
 await post(first.c, 2, "steer");
 await until(() => first.calls.length === 2, "steer starts");
 held.release();
 await until(() => first.sink.sent.length === 1, "primary delivered while the steer is still pending");
 expect(first.c.health()).toMatchObject({ steering: 1, processing: 1, done: 1 });
 await first.c.stop(); channels.splice(channels.indexOf(first.c), 1);
 expect(rows(databasePath)[1]!.state).toBe("processing");
 const second = start(async () => answered("the answer", 9), databasePath);
 await second.started;
 await until(() => second.c.health().done === 2, "recovered row settles");
 expect(second.calls).toHaveLength(1);
 expect(second.calls[0]!.options?.whenBusy).toBeUndefined();
 expect(second.sink.sent).toHaveLength(0);
 await second.c.stop(); channels.splice(channels.indexOf(second.c), 1);
 expect(rows(databasePath).map((r) => [r.id, r.state, r.error, r.answer])).toEqual([["1", "done", null, 9], ["2", "done", "steered", null]]);
});

test("stop drains a non-cooperative steer and no steer starts afterwards", async () => {
 const held = gate();
 let release!: () => void;
 const settled = new Promise<void>((r) => { release = r; });
 const { c, calls, started } = start(async (call) => {
  if (call.message.messageId === "1") { await held.promise; return answered("primary", 1); }
  await settled; // ignores its signal
  return answered("steer", 1);
 });
 await started;
 await post(c, 1, "first");
 await until(() => calls.length === 1, "primary starts");
 await post(c, 2, "steer");
 await until(() => calls.length === 2, "steer starts");
 let stopped = false;
 const stopping = c.stop().then(() => { stopped = true; });
 channels.splice(channels.indexOf(c), 1);
 await Bun.sleep(100);
 expect(stopped).toBe(false);
 expect(c.health()).toMatchObject({ stopping: 1 });
 release(); held.release();
 await stopping;
 expect(stopped).toBe(true);
});
