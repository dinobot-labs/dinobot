import {systemClock} from "../src/channels/api-gate.ts";
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { telegramChannel, type TelegramConfig } from "../src/channels/telegram.ts";
import { INBOX_SCHEMA_VERSION, messagingChannel, SCHEDULER_SQL, STARTUP_PAGE, type MessagingChannel, type MessagingPlatform } from "../src/channels/messaging.ts";
import type { BotReply, InboundMessage, MessageHandler } from "../src/channels/types.ts";
import { messagingChannel as legacyChannel } from "./fixtures/legacy-messaging-v0.ts";
import { SCALED_GATE_POLICY } from "./fixtures/gate-policy.ts";

// ADR 0048 UNIT1 engine acceptance (A1–A3, A5–A7, A9, A10 engine portion). Real adapter, real SQLite, local HTTP
// for the Telegram REST boundary only. Barriers, not sleeps, decide ordering; sleeps only prove that something
// did NOT happen within a window. Every barrier is released in afterEach before a bounded stop.
const TOKEN = "731:test_only_scheduler_recovery";
process.env.SCHED_RECOVERY_TOKEN = TOKEN;
process.env.SCHED_RECOVERY_SECRET = "sched-recovery-secret";
const dirs: string[] = [], channels: MessagingChannel[] = [], servers: ReturnType<typeof Bun.serve>[] = [], gates: Gate[] = [];
type Gate = { promise: Promise<void>; release(): void };
function gate(): Gate { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); const g = { promise, release }; gates.push(g); return g; }
async function bounded<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
 let timer: ReturnType<typeof setTimeout> | undefined;
 try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label + " exceeded " + ms + "ms")), ms); })]); }
 finally { clearTimeout(timer); }
}
afterEach(async () => {
 for (const g of gates.splice(0)) g.release();
 try { for (const c of channels.splice(0)) await bounded(c.stop(), 5000, "cleanup stop"); }
 finally { for (const s of servers.splice(0)) await s.stop(true); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); }
});
async function until(fn: () => boolean, label: string, ms = 4000) { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error("timeout: " + label); await Bun.sleep(5); } }
function dbPath() { const dir = mkdtempSync(join(tmpdir(), "sched-recovery-")); dirs.push(dir); return join(dir, "inbox.sqlite"); }
function cfg(extra: Partial<TelegramConfig> = {}): TelegramConfig {
 return { port: 0, databasePath: dbPath(), allowedUserIds: ["7", "8"], allowedChatIds: ["-9"], botTokenEnv: "SCHED_RECOVERY_TOKEN", webhookSecretEnv: "SCHED_RECOVERY_SECRET", progress: "off", ...extra };
}
type Sent = { topic: number | undefined; text: string; at: number };
/** Local Telegram REST. `hook` may answer a request itself (429, hang, ...); otherwise sendMessage succeeds. */
function fakeTelegram(hook?: (body: any, method: string) => Response | undefined | Promise<Response | undefined>) {
 const sent: Sent[] = [], attempts: Sent[] = []; let calls = 0;
 const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  calls++;
  const method = new URL(req.url).pathname.split("/").at(-1)!; const body = await req.json() as any;
  if (method === "setMyCommands") return Response.json({ ok: true, result: true });
  if (method === "sendMessage") attempts.push({ topic: body.message_thread_id, text: body.text, at: Date.now() });
  const other = await hook?.(body, method); if (other) return other;
  if (method === "sendMessage") sent.push({ topic: body.message_thread_id, text: body.text, at: Date.now() });
  return Response.json({ ok: true, result: { message_id: calls } });
 } });
 servers.push(server);
 return { base: server.url.origin, sent, attempts, calls: () => calls };
}
// The shared API gate (UNIT2) is active with the explicitly scaled policy (fixtures/gate-policy.ts); engine assertions
// about handler starts, slots and lane order do not depend on its time constants.
function tg(config: TelegramConfig, base: string) { const c = telegramChannel(config, { apiBase: base, gatePolicy: SCALED_GATE_POLICY }); channels.push(c); return c; }
function event(id: number | string, topic: number | undefined, text = "request-" + id, user = 7, chat = -9) {
 return { update_id: Number(id), message: { message_id: Number(id) % 1e6, from: { id: user, is_bot: false }, chat: { id: chat, type: "supergroup" }, ...(topic === undefined ? {} : { message_thread_id: topic }), text } };
}
async function post(c: MessagingChannel | string, body: unknown) {
 const response = await fetch(new URL("/webhook", typeof c === "string" ? c : c.url()), { method: "POST", headers: { "x-telegram-bot-api-secret-token": "sched-recovery-secret" }, body: JSON.stringify(body), signal: AbortSignal.timeout(4000) });
 await response.arrayBuffer(); return response.status;
}
const answered = (text: string): BotReply => ({ status: "answered", text });
function inspect<T>(path: string, read: (db: Database) => T): T { const db = new Database(path); try { return read(db); } finally { db.close(); } }
const rows = (path: string) => inspect(path, db => db.query("SELECT * FROM jobs ORDER BY seq").all() as Record<string, any>[]);
const topicOf = (m: InboundMessage) => m.threadKey.split(":")[2]!;

test("A1 incident: held topic 15523 does not block 15537/15539 in topic mode; explicit global mode still does", async () => {
 for (const schedulerMode of ["topic", "global"] as const) {
  const held = gate(); const started: string[] = [];
  const api = fakeTelegram();
  const c = tg(cfg({ schedulerMode }), api.base);
  await c.start(async m => { started.push(m.messageId); if (m.messageId === "635142131") await held.promise; return answered("answer-" + m.messageId); });
  expect(await post(c, event(635142131, 15523))).toBe(200);
  await until(() => started.length === 1, "incident topic starts");
  expect(await post(c, event(635142133, 15537))).toBe(200);
  expect(await post(c, event(635142135, 15539))).toBe(200);
  if (schedulerMode === "topic") {
   await until(() => c.health().done === 2, "other topics answered while 15523 is held");
   expect(started).toEqual(["635142131", "635142133", "635142135"]);
   expect(api.sent.map(s => s.topic).sort()).toEqual([15537, 15539]);
   expect(c.health()).toMatchObject({ concurrency: 12, active: 1, processing: 1, done: 2 });
  } else {
   await Bun.sleep(300);
   expect(started).toEqual(["635142131"]); expect(api.sent).toEqual([]);
   expect(c.health()).toMatchObject({ concurrency: 1, queued: 2 });
  }
  held.release();
  await until(() => c.health().done === 3, "all three topics served");
  if (schedulerMode === "global") expect(api.sent.map(s => s.topic)).toEqual([15523, 15537, 15539]);
  await c.stop();
 }
});

test("A2 one physical topic serializes distinct users and every chunk; root topic is its own lane; core keys unchanged", async () => {
 const api = fakeTelegram();
 const c = tg(cfg(), api.base);
 const long = (tag: string) => tag + ":" + "x".repeat(5000) + ":" + tag + "-end";
 const trace: string[] = []; const busy = new Map<string, number>(); let violations = 0;
 const keys: string[] = [];
 const first = gate();
 await c.start(async m => {
  const lane = topicOf(m); busy.set(lane, (busy.get(lane) ?? 0) + 1); if (busy.get(lane)! > 1) violations++;
  keys.push(m.threadKey); trace.push("handler:" + m.messageId);
  try { if (m.messageId === "1") await first.promise; return answered(long("m" + m.messageId)); }
  finally { busy.set(lane, busy.get(lane)! - 1); }
 });
 expect(await post(c, event(1, 303, "a", 7))).toBe(200);
 await until(() => trace.length === 1, "first handler");
 expect(await post(c, event(2, 303, "b", 8))).toBe(200);
 expect(await post(c, event(3, undefined, "c", 7))).toBe(200);
 // User 8 again: a same-user message would join the held turn as a steer (ADR 0057); distinct users keep lane FIFO.
 expect(await post(c, event(4, 303, "d", 8))).toBe(200);
 await until(() => trace.includes("handler:3"), "root lane runs while topic 303 is held");
 expect(trace).toEqual(["handler:1", "handler:3"]);
 first.release();
 await until(() => c.health().done === 4, "drain");
 expect(violations).toBe(0);
 const lane303 = api.sent.filter(s => s.topic === 303).map(s => s.text), root = api.sent.filter(s => s.topic === undefined).map(s => s.text);
 // Each reply is two chunks; within the topic, job n+1's first chunk follows job n's final chunk.
 expect(lane303.join("|")).toBe([long("m1"), long("m2"), long("m4")].map(t => [t.slice(0, 4096), t.slice(4096)].join("|")).join("|"));
 expect(root.join("")).toBe(long("m3"));
 const lastChunkOf1 = api.sent.findIndex(s => s.text.endsWith("m1-end"));
 const firstChunkOf2 = api.sent.findIndex(s => s.text.startsWith("m2:"));
 expect(firstChunkOf2).toBeGreaterThan(lastChunkOf1);
 expect(keys.sort()).toEqual(["731:-9:0:7", "731:-9:303:7", "731:-9:303:8", "731:-9:303:8"]);
});

test("ADR 0057 steering: a same-user message joins the held turn, a shared answer is delivered once, another user's waits", async () => {
 const api = fakeTelegram();
 const config = cfg(); const c = tg(config, api.base);
 const hold = gate(); const trace: [string, string | undefined][] = [];
 await c.start(async (m, _signal, _progress, options) => {
  trace.push([m.messageId, options?.whenBusy]);
  if (m.messageId === "1") await hold.promise;
  // The core answers every input of one run with one answer entry; both replies carry its id.
  return { status: "answered", text: "shared-" + (m.messageId === "3" ? "other" : "turn"), answer: m.messageId === "3" ? 3 : 1 } satisfies BotReply;
 });
 expect(await post(c, event(1, 303, "start", 7))).toBe(200);
 await until(() => trace.length === 1, "head running");
 expect(await post(c, event(2, 303, "also this", 7))).toBe(200);
 expect(await post(c, event(3, 303, "someone else", 8))).toBe(200);
 await until(() => trace.length === 2, "the same user's message steers at once");
 expect(trace[1]).toEqual(["2", "steer"]);
 await Bun.sleep(50);
 expect(trace).toHaveLength(2); // user 8 waits in lane FIFO
 expect(api.sent).toHaveLength(0); // the steer's answer is not delivered before the head
 hold.release();
 await until(() => c.health().done === 3, "drain");
 expect(trace.map(t => t[0])).toEqual(["1", "2", "3"]);
 expect(trace[2]![1]).toBeUndefined();
 expect(api.sent.map(s => s.text)).toEqual(["shared-turn", "shared-other"]);
 await c.stop(); channels.splice(channels.indexOf(c), 1);
 // S4: the steer answered first here, so it holds the answer and the held primary became the receipt (either order is one delivery).
 const stored = rows(config.databasePath).map(r => [r.id, r.state, r.error, r.answer]);
 expect(stored[2]).toEqual(["3", "done", null, 3]);
 const receipt = [stored[0]!, stored[1]!].find(r => r[2] === "steered")!, delivered = [stored[0]!, stored[1]!].find(r => r[2] === null)!;
 expect(receipt).toEqual([receipt[0], "done", "steered", null]);
 expect(delivered).toEqual([delivered[0], "done", null, 1]);
 expect([receipt[0], delivered[0]].sort()).toEqual(["1", "2"]);
});

test("A3 capacity C=2 with C+2 lanes: exactly C run, the next starts only after a slot settles; chunks rotate", async () => {
 const api = fakeTelegram();
 const c = tg(cfg({ concurrency: 2 }), api.base);
 const barriers = new Map<string, Gate>(); const started: string[] = []; let active = 0, peak = 0;
 await c.start(async m => {
  started.push(m.messageId); active++; peak = Math.max(peak, active);
  try { await (barriers.get(m.messageId) ?? gate()).promise; return answered("ok-" + m.messageId); } finally { active--; }
 });
 for (let id = 1; id <= 4; id++) { barriers.set(String(id), gate()); expect(await post(c, event(id, 500 + id))).toBe(200); }
 await until(() => started.length === 2, "two slots occupied");
 await Bun.sleep(200);
 expect(started).toEqual(["1", "2"]); expect(c.health()).toMatchObject({ active: 2, ready_lanes: 2, concurrency: 2 });
 barriers.get("2")!.release();
 await until(() => started.length === 3, "third lane after a slot settles");
 expect(started[2]).toBe("3"); expect(peak).toBe(2);
 for (const g of barriers.values()) g.release();
 await until(() => c.health().done === 4, "drain");
 expect(peak).toBe(2);
 await c.stop();

 // C=1, two lanes with three-chunk replies: every chunk is one quantum, so the lanes alternate.
 // Distinct chats: with one shared chat, equal spacing dues tie-break by heap push order, which the
 // engine does not guarantee (hosted run 37321221086 saw one lane take consecutive windows; shared-bound
 // starvation itself is covered by the fixed-clock gate fairness tests). Separate chats make the pure
 // round-robin rotation assertion deterministic.
 const rotation = fakeTelegram();
 const one = tg(cfg({ concurrency: 1, allowedChatIds: ["-9", "-10"] }), rotation.base);
 const hold = gate();
 await one.start(async m => { if (m.messageId === "11") await hold.promise; return answered((m.messageId === "11" ? "A" : "B").repeat(4096 * 3)); });
 expect(await post(one, event(11, 601))).toBe(200);
 expect(await post(one, event(12, 602, "request-12", 7, -10))).toBe(200);
 hold.release();
 await until(() => one.health().done === 2, "rotation drain");
 expect(rotation.sent.map(s => s.topic)).toEqual([601, 602, 601, 602, 601, 602]);
});

test("hot/cold fairness: a cold topic admitted behind 20 hot jobs is served within one rotation", async () => {
 const api = fakeTelegram();
 const c = tg(cfg({ concurrency: 1 }), api.base);
 const hold = gate(); const started: string[] = [];
 await c.start(async m => { started.push(m.messageId); if (m.messageId === "1") await hold.promise; return answered("r" + m.messageId); });
 // Hot jobs after the held head come from another user, so they queue in FIFO order instead of steering (ADR 0057).
 for (let id = 1; id <= 20; id++) expect(await post(c, event(id, 700, undefined, id === 1 ? 7 : 8))).toBe(200);
 expect(await post(c, event(99, 701))).toBe(200);
 hold.release();
 await until(() => c.health().done === 21, "drain");
 expect(started.indexOf("99")).toBe(1);
 // Hot jobs keep their own FIFO order.
 expect(started.filter(id => id !== "99")).toEqual(Array.from({ length: 20 }, (_, i) => String(i + 1)));
});

test("retry due releases the slot: a 429 head waits off-slot while another lane runs; the shared cooldown holds every API start", async () => {
 // UNIT1 asserted that the other lane was *sent* during the wait. ADR 0048 §5 (A4) makes the 429 lower bound shared by
 // the whole bot, so the slot release is now observed through the other lane's handler (C=1: it can only run because
 // the waiting head left its slot), and the delivery assertion becomes: no API start of any topic before the bound.
 let limited = true;
 const api = fakeTelegram(body => body.message_thread_id === 801 && limited ? (limited = false, Response.json({ ok: false, parameters: { retry_after: 1 } }, { status: 429 })) : undefined);
 const c = tg(cfg({ concurrency: 1 }), api.base);
 const started: string[] = [];
 await c.start(async m => { started.push(m.messageId); return answered("r" + m.messageId); });
 expect(await post(c, event(1, 801))).toBe(200);
 await until(() => api.attempts.length === 1, "first attempt rate limited");
 expect(await post(c, event(2, 801))).toBe(200);
 expect(await post(c, event(3, 802))).toBe(200);
 await until(() => started.includes("3") && c.health().ready === 2, "other lane's handler ran and its reply waits for the shared cooldown");
 expect(started).toEqual(["1", "3"]); // job 2 waits behind its lane head
 // Both replies wait without holding the single slot: one on its due, one on the gate's shared cooldown.
 expect(c.health()).toMatchObject({ active: 0, delayed_lanes: 2, sending: 0, api_waiters: 0 });
 expect(c.health().api_cooldown_ms).toBeGreaterThan(0);
 expect(api.attempts).toHaveLength(1);
 await until(() => c.health().done === 3, "drain", 5000);
 const texts = api.sent.map(s => s.text);
 expect([...texts].sort()).toEqual(["r1", "r2", "r3"]);
 expect(texts.indexOf("r1")).toBeLessThan(texts.indexOf("r2")); // lane FIFO
 for (const later of api.attempts.slice(1)) expect(later.at - api.attempts[0]!.at).toBeGreaterThanOrEqual(990);
});

test("A5 stop: siblings aborted, stop pending until the original settles, no later API or DB effects", async () => {
 const api = fakeTelegram();
 const config = cfg({ handlerTimeoutMs: 1000 });
 const c = tg(config, api.base);
 const held = gate(); let siblingAborted = false; const seen: InboundMessage[] = [];
 await c.start((m, signal) => {
  seen.push(m);
  if (m.messageId === "1") return held.promise.then(() => answered("late"));
  return new Promise((_, reject) => signal!.addEventListener("abort", () => { siblingAborted = true; reject(new Error("aborted")); }, { once: true }));
 });
 expect(await post(c, event(1, 901))).toBe(200);
 await until(() => seen.length === 1, "held handler starts");
 expect(await post(c, event(2, 902))).toBe(200);
 await until(() => seen.length === 2, "sibling starts");
 expect(c.health()).toMatchObject({ running: 1, active: 2 });
 let stopped = false; const stopping = c.stop().then(() => { stopped = true; });
 await until(() => siblingAborted && c.health().active === 1, "sibling settles, held handler keeps its slot");
 expect(c.health()).toMatchObject({ stopping: 1 });
 await Bun.sleep(300); expect(stopped).toBe(false);
 const callsBefore = api.calls();
 held.release();
 await bounded(stopping, 2000, "stop after the original settles");
 await Bun.sleep(100);
 expect(api.calls()).toBe(callsBefore); expect(api.sent).toEqual([]);
 const after = rows(config.databasePath);
 expect(after.map(r => [r.id, r.state, r.error])).toEqual([["1", "processing", null], ["2", "processing", null]]);
 expect(String(after[0]!.parts)).not.toContain("late");
 // Restart: both interrupted handlers replay with the same native identities, never the late result.
 const replay: InboundMessage[] = [];
 const next = tg(config, api.base);
 await next.start(async m => { replay.push(m); return answered("again"); });
 await until(() => next.health().done === 2, "restart drains");
 expect(replay).toEqual(seen);
 expect(api.sent.map(s => s.topic).sort()).toEqual([901, 902]);
 expect(api.sent.find(s => s.topic === 901)!.text).toBe("again");
}, 15000);

test("raw progress final edit surviving abort keeps its slot past the finish budget; stop waits for it; no later effects", async () => {
 // Fault injection at the raw fetch boundary: the final editMessageText ignores its abort signal until released.
 const api = fakeTelegram();
 const config = cfg({ progress: "status" });
 const realFetch = globalThis.fetch;
 const held = gate(); let editStarted = false, editAborted = false, editSettled = false, issued = 0;
 const answerText = "final-answer";
 globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith(api.base)) issued++;
  if (url.startsWith(api.base) && url.endsWith("/editMessageText")) {
   editStarted = true;
   init?.signal?.addEventListener("abort", () => { editAborted = true; }, { once: true });
   return held.promise.then(() => { editSettled = true; return Response.json({ ok: true, result: true }); });
  }
  return realFetch(input as any, init);
 }) as typeof fetch;
 try {
  const c = tg(config, api.base);
  await c.start(async (_m, _signal, progress) => {
   progress?.({ type: "tool_start", id: "t1", name: "bash" });
   // The status bubble exists before the turn ends, so finish issues a final edit.
   await until(() => api.attempts.length === 1, "status bubble sent");
   return answered(answerText);
  });
  expect(await post(c, event(1, 77))).toBe(200);
  await until(() => editStarted, "final edit issued", 6000);
  // Beyond the reporter finish budget (6 s) and the engine's defensive bound (8 s): finish has resolved and sealed.
  await Bun.sleep(8500);
  expect(editAborted).toBe(true); expect(editSettled).toBe(false);
  // Slot retained: the raw edit is still outstanding, so the answer's delivery quantum cannot start.
  expect(c.health()).toMatchObject({ active: 1, ready: 1 });
  expect(api.sent.length).toBe(1); // the status bubble only
  expect(api.sent.some(s => s.text === answerText)).toBe(false);
  let stopped = false; const stopping = c.stop().then(() => { stopped = true; });
  await Bun.sleep(300);
  expect(stopped).toBe(false); expect(c.health()).toMatchObject({ active: 1, stopping: 1 });
  const issuedBefore = issued, healthBefore = c.health();
  held.release();
  await bounded(stopping, 2000, "stop after the raw edit settles");
  expect(editSettled).toBe(true);
  await Bun.sleep(100);
  expect(issued).toBe(issuedBefore);
  expect(api.sent.some(s => s.text === answerText)).toBe(false);
  expect(healthBefore).toMatchObject({ ready: 1, sending: 0, done: 0, dead: 0 });
  // The database after stop equals the state committed before the release: reply stored, never attempted.
  const after = rows(config.databasePath);
  expect(after.map(r => [r.id, r.state, r.attempts, r.error])).toEqual([["1", "ready", 0, null]]);
  expect(JSON.parse(after[0]!.parts)).toEqual([answerText]);
 } finally { globalThis.fetch = realFetch; }
}, 20000);

test("handler error fails only its own turn with a notice while another lane proceeds", async () => {
 const api = fakeTelegram();
 const c = tg(cfg({ handlerTimeoutMs: 150 }), api.base);
 const failed = gate();
 await c.start(m => m.messageId === "1"
  ? failed.promise.then(() => { throw new Error("handler failed"); })
  : Promise.resolve(answered("fine")));
 expect(await post(c, event(1, 11))).toBe(200);
 expect(await post(c, event(2, 12))).toBe(200);
 await until(() => api.sent.some(s => s.topic === 12), "other lane not blocked by the slow turn", 1000);
 failed.release();
 await until(() => c.health().done === 2, "error notice delivered");
 expect(c.health().running).toBe(1);
 expect(api.sent.find(s => s.topic === 11)!.text).toContain("처리 중 오류");
});

test("A6 duplicates, capacity with receipts and cancelled tombstones survive restart and redelivery", async () => {
 const api = fakeTelegram();
 const config = cfg({ maxRows: 3 });
 const c = tg(config, api.base);
 const hold = gate(); const calls: string[] = [];
 await c.start(async m => { calls.push(m.messageId); if (m.messageId === "1") await hold.promise; return answered("r" + m.messageId); });
 expect(await post(c, event(1, 21))).toBe(200);
 await until(() => calls.length === 1, "head running");
 expect(await post(c, event(2, 21, undefined, 8))).toBe(200); // another user: queued behind the head, not steered
 expect(await post(c, event(3, 22))).toBe(200);
 await until(() => c.health().done === 1, "other lane done");
 const storm = await Promise.all(Array.from({ length: 60 }, (_, i) => post(c, event(i % 3 + 1, i % 3 === 2 ? 22 : 21))));
 expect(storm.every(s => s === 200)).toBe(true);
 expect(c.health().rows).toBe(3);
 expect(c.cancelQueued!("1")).toBe("not_queued"); // already processing: queued cancellation refuses
 expect(c.cancelQueued!("9")).toBe("unknown");
 expect(c.cancelQueued!("2")).toBe("cancelled");
 expect(c.cancelQueued!("2")).toBe("not_queued");
 expect(c.health()).toMatchObject({ dead_cancelled_queued: 1, rows: 3, receipts: 2 });
 expect(await post(c, event(4, 23))).toBe(503); // cancelled and done receipts count toward maxRows
 expect(await post(c, event(2, 21))).toBe(200); // duplicate of the tombstone is acknowledged, never re-run
 hold.release();
 await until(() => c.health().done === 2, "head completes");
 await c.stop();
 expect(calls.sort()).toEqual(["1", "3"]);
 const tomb = rows(config.databasePath).find(r => r.id === "2")!;
 expect([tomb.state, tomb.error, tomb.message, tomb.target, tomb.parts]).toEqual(["dead", "cancelled_queued", "{}", "{}", null]);
 const next = tg(config, api.base); const later: string[] = [];
 await next.start(async m => { later.push(m.messageId); return answered("x"); });
 expect(await post(next, event(2, 21))).toBe(200);
 await Bun.sleep(150);
 expect(later).toEqual([]); expect(next.health().dead_cancelled_queued).toBe(1);
});

/** Genuine pre-0048 inbox: the frozen legacy engine creates the schema and owner row; rows are then written in v0 form. */
async function legacyInbox(path: string, identity = "telegram:731") {
 const platform = { name: "telegram", storageIdentity: identity, admissionTimeoutMs: 1000, replaySafe: false, authorizeStored: () => true, retryAfter: () => null, receive: () => ({ status: 200 }), render: (t: string) => [t], delivery: () => { throw new Error("no delivery"); }, success: () => true };
 const legacy = legacyChannel({ port: 0, databasePath: path, allowedUserIds: ["7"] }, platform);
 await legacy.start(async () => answered("unused")); await legacy.stop();
}
// Advance the modeled shared native frame through the required legacy horizon, retaining every job/cursor assertion.
async function recoveredLegacy(config:TelegramConfig,base:string,handler:Parameters<MessagingChannel["start"]>[0]) {
 const native=systemClock();let elapsed=0n;const clock={...native,observeNs:()=>native.observeNs()+elapsed};
 // The advisory startup menu must time out without issuing through the legacy recovery hold.
 const first=telegramChannel({...config,requestTimeoutMs:100},{apiBase:base,gatePolicy:SCALED_GATE_POLICY,gateClock:clock});channels.push(first);
 await first.start(handler);await Bun.sleep(5);expect(first.health().sending).toBe(0);expect(first.health()).toMatchObject({menu_registered:0,menu_failed:1,api_waiters:0});await first.stop();
 elapsed=61000000000n;
 const next=telegramChannel(config,{apiBase:base,gatePolicy:SCALED_GATE_POLICY,gateClock:clock});channels.push(next);await next.start(handler);return next;
}
function legacyRow(db: Database, id: string, state: string, extra: { topic?: string; parts?: string[]; progress?: number; due?: number; attempts?: number; error?: string; created?: number; target?: string } = {}) {
 const user = "7", topic = extra.topic ?? "10";
 const message = state === "done" || state === "dead" ? "{}" : JSON.stringify({ channel: "telegram", messageId: id, threadKey: "731:-9:" + topic + ":" + user, userId: user, text: "legacy " + id });
 const target = extra.target ?? (state === "done" || state === "dead" ? "{}" : JSON.stringify({ chat: "-9", topic }));
 db.query("INSERT INTO jobs(id,message,target,state,created,expires,parts,progress,attempts,due,error) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(id, message, target, state, extra.created ?? Date.now(), 0, extra.parts ? JSON.stringify(extra.parts) : null, extra.progress ?? 0, extra.attempts ?? 0, extra.due ?? 0, extra.error ?? null);
}

test("A7 legacy v0 inbox migrates in place: seq/keys/cursor/parts/due/receipts preserved, sending ambiguous, bad target explicit", async () => {
 const config = cfg();
 await legacyInbox(config.databasePath);
 const due = Date.now() + 400;
 inspect(config.databasePath, db => {
  legacyRow(db, "100", "done"); legacyRow(db, "101", "dead", { error: "operator_cancelled" });
  legacyRow(db, "102", "processing", { topic: "10" });
  legacyRow(db, "103", "ready", { topic: "20", parts: ["saved-1", "saved-2"], progress: 1, due, attempts: 1 });
  legacyRow(db, "104", "sending", { topic: "30", parts: ["in-flight"] });
  legacyRow(db, "105", "queued", { topic: "10" });
  legacyRow(db, "106", "queued", { target: "{}" });
  db.exec("CREATE TABLE polling_cursor (id INTEGER PRIMARY KEY CHECK(id=1), offset INTEGER NOT NULL); INSERT INTO polling_cursor VALUES (1, 777)");
 });
 const before = rows(config.databasePath);
 const api = fakeTelegram(); const calls: InboundMessage[] = []; const migrationStart = Date.now();
 const c = await recoveredLegacy(config,api.base,async m => { calls.push(m); return answered("fresh-" + m.messageId); });
 await until(() => c.health().done === 4 && c.health().dead === 3, "migrated queue drains", 4000);
 await c.stop();
 expect(calls.map(m => [m.messageId, m.threadKey])).toEqual([["102", "731:-9:10:7"], ["105", "731:-9:10:7"]]);
 expect(api.sent.map(s => [s.topic, s.text]).sort()).toEqual([[10, "fresh-102"], [10, "fresh-105"], [20, "saved-2"]].sort());
 expect(api.sent.find(s => s.topic === 20)!.at).toBeGreaterThanOrEqual(due - 5);
 expect(api.attempts.some(s => s.topic === 30)).toBe(false); // ambiguous send is never replayed
 const after = rows(config.databasePath);
 expect(after.map(r => [r.seq, r.id])).toEqual(before.map(r => [r.seq, r.id]));
 expect(Object.fromEntries(after.map(r => [r.id, [r.state, r.error]]))).toEqual({
  "100": ["done", null], "101": ["dead", "operator_cancelled"], "102": ["done", null], "103": ["done", null],
  "104": ["dead", "ambiguous_delivery"], "105": ["done", null], "106": ["dead", "migration_invalid_target"],
 });
 for (const r of after.filter(r => r.id === "100" || r.id === "101")) expect(r.terminal_at).toBeGreaterThanOrEqual(migrationStart);
 expect(after.find(r => r.id === "105")!.lane).toBe(JSON.stringify(["telegram", "731", "-9", "10"]));
 inspect(config.databasePath, db => {
  expect((db.query("SELECT offset FROM polling_cursor").get() as any).offset).toBe(777);
  expect((db.query("PRAGMA user_version").get() as any).user_version).toBe(INBOX_SCHEMA_VERSION);
  expect(db.query("SELECT name FROM metadata").all()).toEqual([{ name: "inbox-schema:" + INBOX_SCHEMA_VERSION + ":telegram:731" }]);
  expect(db.query("SELECT * FROM lanes").all()).toEqual([]);
 });
});

test("migration is one transaction: an injected failure at the fence leaves the legacy inbox untouched; retry succeeds", async () => {
 const config = cfg();
 await legacyInbox(config.databasePath);
 inspect(config.databasePath, db => { legacyRow(db, "1", "processing"); legacyRow(db, "2", "sending"); db.exec("CREATE TRIGGER inject BEFORE UPDATE ON metadata BEGIN SELECT RAISE(ABORT, 'injected migration failure'); END"); });
 const before = rows(config.databasePath);
 const api = fakeTelegram(); const calls: string[] = [];
 const failing = tg(config, api.base);
 await expect(failing.start(async () => answered("no"))).rejects.toThrow("injected");
 inspect(config.databasePath, db => {
  expect((db.query("PRAGMA user_version").get() as any).user_version).toBe(0);
  expect((db.query("PRAGMA table_info(jobs)").all() as any[]).map(c => c.name)).not.toContain("lane");
  expect(db.query("SELECT name FROM sqlite_master WHERE name IN ('lanes','settings','jobs_live_lane_seq')").all()).toEqual([]);
  expect(db.query("SELECT name FROM metadata").all()).toEqual([{ name: "telegram:731" }]);
  expect(db.query("SELECT * FROM jobs ORDER BY seq").all()).toEqual(before);
  db.exec("DROP TRIGGER inject");
 });
 const c = await recoveredLegacy(config,api.base,async m => { calls.push(m.messageId); return answered("ok"); });
 await until(() => c.health().done === 1 && c.health().dead === 1, "recovered after retry");
 expect(calls).toEqual(["1"]); expect(api.attempts.length).toBe(1);
});

test("fence: a pre-0048 binary refuses a migrated inbox; future schema and foreign owners fail closed without writes", async () => {
 const config = cfg(); const api = fakeTelegram();
 const c = tg(config, api.base); await c.start(async () => answered("ok"));
 expect(await post(c, event(1, 5))).toBe(200); await until(() => c.health().done === 1, "one receipt"); await c.stop();
 const snapshot = () => inspect(config.databasePath, db => JSON.stringify([db.query("SELECT * FROM jobs").all(), db.query("SELECT * FROM metadata").all(), db.query("PRAGMA user_version").get(), db.query("SELECT * FROM lanes").all()]));
 const migrated = snapshot();
 const legacyPlatform = { name: "telegram", storageIdentity: "telegram:731", admissionTimeoutMs: 1000, replaySafe: false, authorizeStored: () => true, retryAfter: () => null, receive: () => ({ status: 200 }), render: (t: string) => [t], delivery: () => { throw new Error("x"); }, success: () => true };
 const old = legacyChannel({ port: 0, databasePath: config.databasePath, allowedUserIds: ["7"] }, legacyPlatform);
 await expect(old.start(async () => answered("old"))).rejects.toThrow("another channel");
 expect(snapshot()).toBe(migrated);
 inspect(config.databasePath, db => db.exec("UPDATE metadata SET name='inbox-schema:" + (INBOX_SCHEMA_VERSION + 1) + ":telegram:731'"));
 const future = snapshot();
 await expect(tg(config, api.base).start(async () => answered("x"))).rejects.toThrow("Unsupported inbox schema version");
 expect(snapshot()).toBe(future);
 inspect(config.databasePath, db => db.exec("UPDATE metadata SET name='inbox-schema:" + INBOX_SCHEMA_VERSION + ":telegram:731'; PRAGMA user_version=" + (INBOX_SCHEMA_VERSION + 1)));
 await expect(tg(config, api.base).start(async () => answered("x"))).rejects.toThrow("Unsupported inbox schema version");
 inspect(config.databasePath, db => db.exec("PRAGMA user_version=" + INBOX_SCHEMA_VERSION));
 process.env.SCHED_RECOVERY_OTHER = "732:other_bot";
 await expect(tg({ ...config, botTokenEnv: "SCHED_RECOVERY_OTHER" }, api.base).start(async () => answered("x"))).rejects.toThrow("another channel");
 expect(snapshot()).toBe(migrated);
});

test("scheduler mode change re-keys live lanes at startup in both directions", async () => {
 const config = cfg({ schedulerMode: "global" }); const api = fakeTelegram();
 const c = tg(config, api.base); const seen: string[] = [];
 await c.start((m, signal) => { seen.push(m.messageId); return new Promise((_, reject) => signal!.addEventListener("abort", () => reject(new Error("stop")), { once: true })); });
 for (const [id, topic] of [[1, 31], [2, 32], [3, 33]] as const) expect(await post(c, event(id, topic))).toBe(200);
 await until(() => seen.length === 1, "global head"); await Bun.sleep(100); expect(seen).toEqual(["1"]);
 await c.stop();
 expect(rows(config.databasePath).map(r => r.lane)).toEqual(["global", "global", "global"]);
 const topic = tg({ ...config, schedulerMode: "topic" }, api.base); const held: string[] = [];
 await topic.start((m, signal) => { held.push(m.messageId); return new Promise((_, reject) => signal!.addEventListener("abort", () => reject(new Error("stop")), { once: true })); });
 await until(() => held.length === 3, "all topics concurrently after re-key");
 expect(topic.health()).toMatchObject({ lanes: 3, active: 3 });
 await topic.stop();
 expect(rows(config.databasePath).map(r => JSON.parse(r.lane)[3])).toEqual(["31", "32", "33"]);
 const back = tg(config, api.base); await back.start(async () => answered("done"));
 await until(() => back.health().done === 3, "global drain after rollback"); await back.stop();
 expect(api.sent.map(s => s.topic)).toEqual([31, 32, 33]);
});

test("receipt retention runs from completion: a turn admitted long ago keeps its receipt after finishing now", async () => {
 const config = cfg({ retentionSeconds: 600 }); const api = fakeTelegram();
 const c = tg(config, api.base);
 await c.start((_m, signal) => new Promise((_, reject) => signal!.addEventListener("abort", () => reject(new Error("stop")), { once: true })));
 expect(await post(c, event(1, 41))).toBe(200); await until(() => c.health().processing === 1, "running"); await c.stop();
 inspect(config.databasePath, db => db.query("UPDATE jobs SET created=?").run(Date.now() - 3_600_000));
 const calls: string[] = [];
 const next = tg(config, api.base); await next.start(async m => { calls.push(m.messageId); return answered("late but done"); });
 await until(() => next.health().done === 1, "completes now"); await next.stop();
 const last = tg(config, api.base); await last.start(async m => { calls.push(m.messageId); return answered("dup"); });
 expect(last.health()).toMatchObject({ done: 1, rows: 1 });
 expect(await post(last, event(1, 41))).toBe(200); await Bun.sleep(150);
 expect(calls).toEqual(["1"]);
});

test("crash/restart: SIGKILL with lanes mid-handler, mid-retry-wait and mid-send recovers each boundary", async () => {
 const config = cfg(); let phase: "child" | "parent" = "child"; const hung: (() => void)[] = [];
 const api = fakeTelegram(async body => {
  if (phase !== "child") return undefined;
  if (body.message_thread_id === 2) return Response.json({ ok: false, parameters: { retry_after: 2 } }, { status: 429 });
  if (body.message_thread_id === 3) { await new Promise<void>(r => hung.push(r)); return Response.json({ ok: true }); }
  return undefined;
 });
 const script = 'import {telegramChannel} from "./src/channels/telegram.ts"; const c=telegramChannel(' + JSON.stringify(config) + ',{apiBase:' + JSON.stringify(api.base) + ',gatePolicy:' + JSON.stringify(SCALED_GATE_POLICY) + '}); await c.start(async m=>{ if(m.text==="hold"){console.log("HELD");return new Promise(()=>{});} return {status:"answered",text:"reply-"+m.messageId}; }); console.log("URL "+c.url().href);';
 const child = Bun.spawn([process.execPath, "-e", script], { cwd: process.cwd(), env: { ...process.env, SCHED_RECOVERY_TOKEN: TOKEN }, stdout: "pipe", stderr: "pipe" });
 let output = "";
 const reader = child.stdout.getReader();
 const pumpOut = (async () => { for (;;) { const { done, value } = await reader.read(); if (done) return; output += new TextDecoder().decode(value); } })();
 try {
  await until(() => output.includes("URL "), "child ready", 8000);
  const url = /URL (\S+)/.exec(output)![1]!;
  expect(await post(url, event(1, 1, "hold"))).toBe(200);
  expect(await post(url, event(2, 2))).toBe(200);
  expect(await post(url, event(3, 3))).toBe(200);
  await until(() => output.includes("HELD") && api.attempts.some(a => a.topic === 2) && hung.length === 1, "three boundaries reached");
  child.kill("SIGKILL"); await child.exited;
 } finally { child.kill(); await pumpOut.catch(() => undefined); }
 phase = "parent"; for (const r of hung) r();
 const crashed = Object.fromEntries(rows(config.databasePath).map(r => [r.id, r]));
 expect([crashed["1"]!.state, crashed["2"]!.state, crashed["3"]!.state]).toEqual(["processing", "ready", "sending"]);
 // Compare against the failed attempt's own timestamp: the retry due must be later than the 429 that set it.
 // (Asserting against Date.now() here races the restart/DB-read latency on slow runners.)
 const attempt2 = api.attempts.find(a => a.topic === 2)!;
 expect(crashed["2"]!.due).toBeGreaterThan(attempt2.at); expect(crashed["2"]!.attempts).toBe(1);
 const replay: InboundMessage[] = []; const sentBefore = api.attempts.length;
 const c = tg(config, api.base);
 await c.start(async m => { replay.push(m); return answered("after-restart-" + m.messageId); });
 await until(() => c.health().done === 2 && c.health().dead === 1, "restart recovery", 6000);
 expect(replay.map(m => [m.messageId, m.threadKey])).toEqual([["1", "731:-9:1:7"]]);
 expect(api.attempts.slice(sentBefore).map(a => [a.topic, a.text]).sort()).toEqual([[1, "after-restart-1"], [2, "reply-2"]]);
 expect(api.attempts.filter(a => a.topic === 3)).toHaveLength(1);
 expect(c.health().dead_ambiguous_delivery).toBe(1);
}, 20000);

test("A9 hot-path statements use the lane/expiry indexes, and startup reads bounded pages over 100k receipts", async () => {
 const config = cfg(); const api = fakeTelegram();
 const c = tg(config, api.base); await c.start(async () => answered("x")); await c.stop();
 inspect(config.databasePath, db => {
  const plan = (sql: string, ...params: unknown[]) => (db.query("EXPLAIN QUERY PLAN " + sql).all(...(params as [])) as { detail: string }[]).map(r => r.detail).join(" | ");
  const nextHead = plan(SCHEDULER_SQL.nextHead, "lane");
  expect(nextHead).toMatch(/SEARCH jobs USING (COVERING )?INDEX jobs_live_lane_seq \(lane=\?\)/);
  const expire = plan(SCHEDULER_SQL.expire, 0, 10);
  expect(expire).toContain("INDEX jobs_terminal_expiry (terminal_at<?)");
  const heads = plan(SCHEDULER_SQL.headsPage, 0, 10);
  expect(heads).toMatch(/SEARCH l USING (COVERING )?INDEX \S+ \(head>\?\)/);
  expect(heads).toContain("SEARCH j USING INTEGER PRIMARY KEY (rowid=?)");
  const unkeyed = plan(SCHEDULER_SQL.unkeyedPage, 0, 10);
  expect(unkeyed).toContain("INDEX jobs_live_lane_seq (lane=? AND seq>?)");
  for (const detail of [nextHead, expire, heads, unkeyed]) { expect(detail).not.toMatch(/SCAN (jobs|j|l)\b/); expect(detail).not.toContain("TEMP B-TREE"); }
 });
 inspect(config.databasePath, db => {
  const insert = db.query("INSERT INTO jobs(id,message,target,state,created,expires,parts,lane,terminal_at) VALUES (?,?,?,?,?,?,?,?,?)");
  const now = Date.now();
  db.transaction(() => {
   for (let i = 0; i < 100_000; i++) insert.run("r" + i, "{}", "{}", "done", now, 0, null, null, now);
   for (let t = 1; t <= 300; t++) insert.run(String(t), JSON.stringify({ channel: "telegram", messageId: String(t), threadKey: "731:-9:" + t + ":7", userId: "7", text: "live" }), JSON.stringify({ chat: "-9", topic: String(t) }), "queued", now, 0, null, JSON.stringify(["telegram", "731", "-9", String(t)]), null);
  })();
 });
 // Instrument every statement result materialized in JS during startup.
 const original = Database.prototype.query; const materialized: { sql: string; rows: number }[] = []; const wrapped = new WeakSet<object>();
 Database.prototype.query = function (this: Database, sql: string) {
  const statement = original.call(this, sql);
  if (wrapped.has(statement)) return statement; // bun caches prepared statements: wrap each once
  wrapped.add(statement); const all = statement.all.bind(statement);
  statement.all = (...params: any[]) => { const result = all(...params); materialized.push({ sql, rows: result.length }); return result; };
  return statement;
 } as typeof original;
 const hold = gate(); let started = 0;
 const big = tg(config, api.base);
 try { await big.start(async () => { started++; await hold.promise; return answered("x"); }); }
 finally { Database.prototype.query = original; }
 const pages = materialized.filter(m => !m.sql.includes("GROUP BY state, error"));
 expect(Math.max(...pages.map(m => m.rows))).toBeLessThanOrEqual(STARTUP_PAGE);
 expect(materialized.filter(m => m.sql === SCHEDULER_SQL.headsPage).map(m => m.rows)).toEqual([256, 44]);
 await until(() => started === 12, "default twelve lanes start");
 expect(big.health()).toMatchObject({ rows: 100_300, receipts: 100_000, lanes: 300, active: 12, ready_lanes: 288, live: 300, max_rows: 10000 });
 expect(await post(big, event(100_001, 9))).toBe(503); // maxRows counts receipts
 expect(await post(big, event(1, 1))).toBe(200); // a retained duplicate is still acknowledged
}, 30000);

test("A10 configuration: Telegram default 12, 1..16 accepted, invalid values and global>1 rejected; generic stays global C=1", async () => {
 const api = fakeTelegram();
 const health = async (extra: Partial<TelegramConfig>) => { const c = tg(cfg(extra), api.base); await c.start(async () => answered("x")); const h = c.health(); await c.stop(); return h.concurrency; };
 expect(await health({})).toBe(12);
 expect(await health({ concurrency: 1 })).toBe(1);
 expect(await health({ concurrency: 16 })).toBe(16);
 expect(await health({ schedulerMode: "global" })).toBe(1);
 expect(await health({ schedulerMode: "global", concurrency: 1 })).toBe(1);
 for (const bad of [0, 17, 1.5, "4", -1]) expect(() => telegramChannel(cfg({ concurrency: bad as number }), { apiBase: api.base })).toThrow("Invalid Telegram channel configuration");
 expect(() => telegramChannel(cfg({ schedulerMode: "global", concurrency: 4 }), { apiBase: api.base })).toThrow("Invalid Telegram channel configuration");
 expect(() => telegramChannel(cfg({ schedulerMode: "lanes" as "topic" }), { apiBase: api.base })).toThrow("Invalid Telegram channel configuration");
 const platform: MessagingPlatform = { name: "generic", storageIdentity: "generic", admissionTimeoutMs: 1000, replaySafe: false, authorizeStored: () => true, retryAfter: () => null, receive: () => ({ status: 200 }), render: t => [t], delivery: () => { throw new Error("x"); }, success: () => true };
 const generic = messagingChannel({ port: 0, databasePath: dbPath(), allowedUserIds: ["1"] }, platform); channels.push(generic);
 await generic.start(async () => answered("x")); expect(generic.health().concurrency).toBe(1); await generic.stop();
 expect(() => messagingChannel({ port: 0, databasePath: dbPath(), allowedUserIds: ["1"] }, { ...platform, scheduling: { policy: "p", concurrency: 17, lane: () => "x" } })).toThrow(RangeError);
});

test("global generic lane keeps strict FIFO including retry waits (ADR 0042 compatibility)", async () => {
 const handler: MessageHandler = async m => answered("r" + m.messageId);
 let first = true; const times: number[] = []; const order: string[] = [];
 const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) { const body = await req.json() as any; times.push(Date.now()); if (first) { first = false; return new Response(null, { status: 429, headers: { "Retry-After": "0.3" } }); } order.push(body.text); return Response.json({ ok: true }); } });
 servers.push(server);
 const platform: MessagingPlatform = { name: "generic", storageIdentity: "generic-fifo", admissionTimeoutMs: 1000, replaySafe: false, authorizeStored: () => true, retryAfter: () => null,
  receive: (_r, bytes) => { const body = JSON.parse(Buffer.from(bytes).toString()); return { status: 200, admission: { message: { channel: "generic", messageId: body.id, threadKey: "t" + body.topic, userId: "1", text: "x" }, target: { topic: body.topic } } }; },
  render: t => [t], delivery: (_t, part) => ({ idempotent: false, url: server.url.origin, init: { method: "POST", body: JSON.stringify({ text: part }) } }), success: () => true };
 const c = messagingChannel({ port: 0, databasePath: dbPath(), allowedUserIds: ["1"] }, platform); channels.push(c);
 await c.start(handler);
 for (const [id, topic] of [["1", "a"], ["2", "b"], ["3", "c"]]) await fetch(new URL("/webhook", c.url()), { method: "POST", body: JSON.stringify({ id, topic }) }).then(r => r.arrayBuffer());
 await until(() => c.health().done === 3, "generic drain");
 expect(order).toEqual(["r1", "r2", "r3"]); expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(290);
});
