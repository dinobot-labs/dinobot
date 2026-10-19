import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { messagingChannel, type MessagingConfig, type MessagingPlatform, type PollingContext } from "../src/channels/messaging.ts";
import type { BotReply } from "../src/channels/types.ts";

const answer = (text: string): BotReply => ({ status: "answered", text });
async function flush() { for (let i = 0; i < 100; i++) await Promise.resolve(); }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

// Drive scheduled callbacks as well as Date.now(). Infinity/oversized timeouts are errors,
// rather than silently overflowing into short timers. No real multi-hour sleep is needed.
function clock() {
 const realNow = Date.now, realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout;
 let now = realNow(), id = 0;
 const pending = new Map<number, { at: number; fire(): void }>();
 const delays: number[] = [];
 Date.now = () => now;
 globalThis.setTimeout = ((fn: (...args: any[]) => void, ms = 0, ...args: any[]) => {
  delays.push(ms);
  if (!Number.isFinite(ms) || ms > 2_147_483_647) throw new Error("timer overflow");
  const key = ++id; pending.set(key, { at: now + Math.max(0, ms), fire: () => fn(...args) }); return key;
 }) as unknown as typeof setTimeout;
 globalThis.clearTimeout = ((key: number) => { pending.delete(key); }) as unknown as typeof clearTimeout;
 return {
  delays,
  async advance(ms: number) {
   const end = now + ms;
   for (;;) {
    const next = [...pending.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
    if (!next) break;
    now = next[1].at; pending.delete(next[0]); next[1].fire(); await flush();
   }
   now = end; await flush();
  },
  restore() { Date.now = realNow; globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear; },
 };
}

function fixture(extra: Partial<MessagingConfig> = {}) {
 const dir = mkdtempSync(join(tmpdir(), "unlimited-messaging-"));
 const time = clock(), realFetch = globalThis.fetch;
 let context!: PollingContext;
 const sent: string[] = [];
 globalThis.fetch = (async (_url: unknown, init?: RequestInit) => { sent.push(String(init?.body)); return new Response("ok"); }) as typeof fetch;
 const platform: MessagingPlatform = {
  name: "unlimited", storageIdentity: "test", admissionTimeoutMs: 1000, replaySafe: true,
  authorizeStored: () => true, retryAfter: () => null, receive: () => ({ status: 200 }), render: text => [text],
  delivery: (_target, part) => ({ url: "http://test.invalid", init: { method: "POST", body: part }, idempotent: true }), success: response => response.ok,
  scheduling: { policy: "test-lanes", concurrency: 2, lane: message => message.threadKey },
  polling: { check: async () => {}, run: async c => { context = c; await new Promise<void>(resolve => c.signal.addEventListener("abort", () => resolve(), { once: true })); } },
 };
 const config: MessagingConfig = { port: 0, databasePath: join(dir, "inbox.sqlite"), allowedUserIds: ["7"], ...extra };
 const channel = messagingChannel(config, platform);
 return {
  channel, time, sent, config,
  admit: (id: number, lane: string) => context.admit({ status: 200, admission: { message: { channel: platform.name, userId: "7", messageId: String(id), threadKey: lane, text: "request" }, target: {} } }, id + 1),
  async cleanup() { try { await channel.stop(); } finally { globalThis.fetch = realFetch; time.restore(); rmSync(dir, { recursive: true, force: true }); } },
 };
}

for (const handlerTimeoutMs of [undefined, 50, 3_600_000]) test("no lifetime timer, FIFO and slots survive 30h: legacy=" + handlerTimeoutMs, async () => {
 const f = fixture(handlerTimeoutMs === undefined ? {} : { handlerTimeoutMs });
 const c = f.channel, held = deferred<BotReply>();
 const started: string[] = [], signals: AbortSignal[] = [];
 try {
  await c.start((m, signal) => { started.push(m.messageId); signals.push(signal!); return m.messageId === "1" ? held.promise : Promise.resolve(answer("answer-" + m.messageId)); });
  expect(f.admit(1, "a")).toBe(true); await flush();
  expect(c.health()).toMatchObject({ active: 1, processing: 1 });
  // With only one live held handler there must be no handler timer at all.
  expect(f.time.delays).toEqual([]);
  await f.time.advance(30 * 60 * 60 * 1000);
  expect(signals[0]!.aborted).toBe(false);
  expect(c.health()).toMatchObject({ running: 1, active: 1, processing: 1, done: 0, dead: 0 });
  expect(f.admit(2, "a")).toBe(true); expect(f.admit(3, "b")).toBe(true); await flush();
  expect(started).toEqual(["1", "3"]); expect(f.sent).toEqual(["answer-3"]);
  expect(c.health()).toMatchObject({ active: 1, processing: 1, queued: 1, done: 1 });
  held.resolve(answer("long-answer")); await flush();
  expect(started).toEqual(["1", "3", "2"]); expect(f.sent).toEqual(["answer-3", "long-answer", "answer-2"]);
  expect(c.health()).toMatchObject({ active: 0, done: 3 });
  expect(f.time.delays.every(ms => ms <= 60_000)).toBe(true);
 } finally { held.resolve(answer("cleanup")); await f.cleanup(); }
});

for (const rejectLate of [false, true]) test("stop aborts cooperative work, retains noncooperative slot and ignores late " + (rejectLate ? "error" : "answer"), async () => {
 const f = fixture({ handlerTimeoutMs: 50 }), c = f.channel, held = deferred<BotReply>();
 let cooperativeAborted = false, stopped = false;
 const signals: AbortSignal[] = [];
 try {
  await c.start((m, signal) => { signals.push(signal!); return m.messageId === "1" ? held.promise : new Promise((_, reject) => signal!.addEventListener("abort", () => { cooperativeAborted = true; reject(new Error("stopped")); }, { once: true })); });
  expect(f.admit(1, "a")).toBe(true); expect(f.admit(2, "b")).toBe(true);
  await flush(); await f.time.advance(30 * 60 * 60 * 1000);
  expect(c.health()).toMatchObject({ running: 1, active: 2 }); expect(signals.every(s => !s.aborted)).toBe(true);
  const stopping = c.stop().then(() => { stopped = true; }); await flush();
  expect(cooperativeAborted).toBe(true); expect(signals.every(s => s.aborted)).toBe(true);
  expect(c.health()).toMatchObject({ active: 1, stopping: 1 }); expect(stopped).toBe(false);
  expect(f.admit(3, "c")).toBe(false);
  await f.time.advance(30 * 60 * 60 * 1000); expect(stopped).toBe(false); expect(f.sent).toEqual([]);
  if (rejectLate) held.reject(new Error("late failure")); else held.resolve(answer("late answer"));
  await stopping; expect(stopped).toBe(true); await flush(); expect(f.sent).toEqual([]);
  const db = new Database(f.config.databasePath);
  try { expect(db.query("SELECT state, parts, error FROM jobs ORDER BY seq").all()).toEqual([{ state: "processing", parts: null, error: null }, { state: "processing", parts: null, error: null }]); } finally { db.close(); }
 } finally { held.resolve(answer("cleanup")); await f.cleanup(); }
});

for (const synchronous of [false, true]) test("handler errors still deliver a sanitized notice: synchronous=" + synchronous, async () => {
 const f = fixture();
 try {
  await f.channel.start(() => { const error = new Error("secret diagnostic"); if (synchronous) throw error; return Promise.reject(error); });
  expect(f.admit(1, "a")).toBe(true); await flush();
  expect(f.channel.health()).toMatchObject({ done: 1, active: 0, running: 1 });
  expect(f.sent).toHaveLength(1); expect(f.sent[0]).toContain("처리 중 오류"); expect(f.sent[0]).not.toContain("secret");
 } finally { await f.cleanup(); }
});
