import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { telegramChannel, type TelegramConfig } from "../src/channels/telegram.ts";
import { chunks, type MessagingChannel } from "../src/channels/messaging.ts";
import { SCALED_GATE_POLICY } from "./fixtures/gate-policy.ts";

const SEED = 0x51a7c0de;
function random(seed = SEED) { return () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; }; }
function shuffled<T>(items: T[]) { const next = random(); for (let i = items.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [items[i], items[j]] = [items[j]!, items[i]!]; } return items; }
const event = (id: number, user = 7) => ({ update_id: id, message: { message_id: id, text: "input " + id, from: { id: user, is_bot: false }, chat: { id: -9 } } });
const answer = (text = "ok") => ({ status: "answered" as const, text });
// Deadlines are hang guards, not throughput/latency assertions.
async function finite<T>(promise: Promise<T>, label: string, ms = 8000): Promise<T> { let timer: ReturnType<typeof setTimeout>; try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label + " deadline")), ms); })]); } finally { clearTimeout(timer!); } }
async function until(check: () => boolean) { for (let i = 0; i < 800; i++) { if (check()) return; await Bun.sleep(10); } throw new Error("finite drain budget exhausted"); }
function total(c: MessagingChannel) { const h = c.health(); return ["queued", "processing", "ready", "sending", "done", "dead"].reduce((n, s) => n + h[s]!, 0); }
async function fixture(extra: Partial<TelegramConfig>, run: (c: MessagingChannel, sent: string[], path: string) => Promise<void>) {
 const dir = mkdtempSync(join(tmpdir(), "messaging-stress-")), path = join(dir, "inbox.sqlite"), sent: string[] = [];
 const tokenKey = "MESSAGING_STRESS_FAKE_TOKEN", secretKey = "MESSAGING_STRESS_FAKE_SECRET";
 const oldToken = process.env[tokenKey], oldSecret = process.env[secretKey];
 process.env[tokenKey] = "987654:fake-local-only"; process.env[secretKey] = "stress-secret";
 const platform = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) { sent.push((await req.json() as { text: string }).text); return Response.json({ ok: true }); } });
 const c = telegramChannel({ port: 0, databasePath: path, allowedUserIds: ["7"], allowedChatIds: ["-9"], botTokenEnv: tokenKey, webhookSecretEnv: secretKey, retentionSeconds: 600, requestTimeoutMs: 3000, steering: "off" /* single-flight dedupe mechanics; ADR 0057 steering has its own suite */, ...extra }, { apiBase: platform.url.origin, gatePolicy: SCALED_GATE_POLICY }); // gate active, time constants scaled (fixtures/gate-policy.ts)
 try { await run(c, sent, path); }
 finally { try { await finite(c.stop(), "cleanup stop"); } finally { await platform.stop(true); rmSync(dir, { recursive: true, force: true }); if (oldToken === undefined) delete process.env[tokenKey]; else process.env[tokenKey] = oldToken; if (oldSecret === undefined) delete process.env[secretKey]; else process.env[secretKey] = oldSecret; } }
}
async function post(c: MessagingChannel, body: unknown, secret = "stress-secret") {
 const r = await fetch(new URL("/webhook", c.url()), { method: "POST", headers: { "x-telegram-bot-api-secret-token": secret }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
 await r.arrayBuffer(); return r;
}
// Retry only explicit non-admission (503), never an ambiguous transport failure.
async function admitted(c: MessagingChannel, body: unknown, expected = 200, secret = "stress-secret") {
 for (let attempt = 0; attempt < 4; attempt++) {
  const r = await post(c, body, secret);
  if (r.status !== 503) { expect(r.status).toBe(expected); return; }
  if (attempt === 3) throw new Error("503 admission retry budget exhausted");
  const delay = Number(r.headers.get("Retry-After") ?? "0.1") * 1000;
  expect(Number.isFinite(delay) && delay >= 0 && delay <= 3000).toBe(true);
  await Bun.sleep(delay);
 }
}
function receipts(path: string) { const db = new Database(path, { readonly: true }); try { return db.query<{ id: string; state: string }, []>("SELECT id,state FROM jobs ORDER BY seq").all(); } finally { db.close(); } }

test("seed 0x51a7c0de: 384 reordered concurrent duplicates retain all 96 accepted events exactly once", async () => {
 await fixture({ maxRows: 96 }, async (c, sent, path) => {
  const calls: string[] = []; let active = 0, peak = 0;
  await c.start(async m => { active++; peak = Math.max(peak, active); calls.push(m.messageId); try { await Bun.sleep(1); return answer(m.messageId); } finally { active--; } });
  const ids = shuffled(Array.from({ length: 384 }, (_, i) => i % 96 + 1));
  await Promise.all(ids.map(id => admitted(c, event(id)).then(() => { expect(total(c)).toBeLessThanOrEqual(96); })));
  await until(() => c.health().done === 96);
  // Repeat after completion, while receipts remain inside their retention period.
  await Promise.all(shuffled(Array.from({ length: 96 }, (_, i) => i + 1)).map(id => admitted(c, event(id))));
  await finite(c.stop(), "stop after drain");
  const expected = Array.from({ length: 96 }, (_, i) => String(i + 1)).sort();
  expect(calls.sort()).toEqual(expected); expect(sent.sort()).toEqual(expected); expect(peak).toBe(1); expect(active).toBe(0);
  const rows = receipts(path); expect(rows.map(r => r.id).sort()).toEqual(expected); expect(rows.every(r => r.state === "done")).toBe(true);
 });
}, 20000);

test("256 unauthorized concurrent requests admit no rows and invoke no handler", async () => {
 await fixture({ maxRows: 4 }, async (c, sent, path) => {
  let calls = 0; await c.start(async () => { calls++; return answer(); });
  await Promise.all(Array.from({ length: 256 }, (_, i) => admitted(c, event(i + 1, i % 2 ? 8 : 7), i % 2 ? 403 : 401, i % 2 ? "stress-secret" : "wrong")));
  expect(total(c)).toBe(0); await finite(c.stop(), "unauthorized stop");
  expect(calls).toBe(0); expect(sent).toEqual([]); expect(receipts(path)).toEqual([]);
 });
}, 20000);

test("maxRows fault: full terminal receipts survive duplicate storm and finite fresh-input retries", async () => {
 await fixture({ maxRows: 4 }, async (c, sent, path) => {
  let calls = 0; await c.start(async m => { calls++; return answer(m.messageId); });
  for (let id = 1; id <= 4; id++) await admitted(c, event(id));
  await until(() => c.health().done === 4);
  for (let attempt = 0; attempt < 3; attempt++) {
   await Promise.all(Array.from({ length: 128 }, (_, i) => admitted(c, event(i % 4 + 1))));
   const r = await post(c, event(5)); expect(r.status).toBe(503); expect(r.headers.get("Retry-After")).toBe("1");
   expect(total(c)).toBe(4); expect(c.health().done).toBe(4);
   if (attempt < 2) await Bun.sleep(1000);
  }
  await finite(c.stop(), "capacity stop"); expect(calls).toBe(4); expect(sent.sort()).toEqual(["1", "2", "3", "4"]);
  expect(receipts(path)).toEqual([1, 2, 3, 4].map(id => ({ id: String(id), state: "done" })));
 });
}, 20000);

test("seed 0x51a7c0de: 512 Unicode properties plus explicit surrogate/fence boundaries", () => {
 const rng = random(), atoms = ["a", "\n", "\r\n", "😀", "𐀀", "𝄞", "한", "e\u0301", "\u200d", "```ts\n", "```", "\0", "<>&"];
 const corpus = ["😀", "```\n```", ...[1, 4094, 4095, 4096, 4097, 8191, 8192].flatMap(n => ["x".repeat(n) + "😀```\n", "😀".repeat(n) + "```", "```" + "x".repeat(n) + "\n```"] )];
 for (let i = 0; i < 512; i++) { const count = 1 + Math.floor(rng() * 9000); let s = ""; for (let j = 0; j < count; j++) s += atoms[Math.floor(rng() * atoms.length)]!; corpus.push(s); }
 expect(corpus).toHaveLength(535);
 for (const original of corpus) {
  const parts = chunks(original, 4096); expect(parts.join("")).toBe(original);
  for (const part of parts) { expect(part.length).toBeGreaterThan(0); expect(part.length).toBeLessThanOrEqual(4096); expect(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(part)).toBe(false); }
 }
 // Empty response is a documented rendering sentinel, not a lossless input case.
 expect(chunks("", 4096)).toEqual(["(empty response)"]);
});

function slowSocket(c: MessagingChannel, resetOnStop = false) {
 const socket = connect({ host: "127.0.0.1", port: Number(c.url().port) });
 let response = "";
 const connected = new Promise<void>((resolve, reject) => { socket.once("connect", () => { socket.write("POST /webhook HTTP/1.1\r\nHost: localhost\r\nx-telegram-bot-api-secret-token: stress-secret\r\nContent-Length: 1000\r\nConnection: close\r\n\r\n{"); resolve(); }); socket.once("error", reject); });
 const ended = new Promise<string>((resolve, reject) => { socket.on("data", data => { response += data.toString(); }); socket.once("close", () => resolve(response)); socket.once("error", (error: NodeJS.ErrnoException) => { if (resetOnStop && error.code === "ECONNRESET") resolve(response); else reject(error); }); });
 // Observe rejection immediately even if the caller is still waiting for connect.
 void ended.catch(() => {});
 return { socket, connected, ended };
}

test("real socket incomplete body expires; malformed payload is rejected; stop closes pending body", async () => {
 await fixture({ maxRows: 4, requestTimeoutMs: 100 }, async (c, sent, path) => {
  let calls = 0; await c.start(async () => { calls++; return answer(); });
  const slow = slowSocket(c);
  try { await finite(slow.connected, "socket connect"); const response = await finite(slow.ended, "incomplete body request"); expect(response).toMatch(/^HTTP\/1\.1 400 /); } finally { slow.socket.destroy(); }
  const malformed = await fetch(new URL("/webhook", c.url()), { method: "POST", headers: { "x-telegram-bot-api-secret-token": "stress-secret" }, body: "{not-json", signal: AbortSignal.timeout(8000) });
  await malformed.arrayBuffer(); expect(malformed.status).toBe(400); expect(total(c)).toBe(0);
  const pending = slowSocket(c, true);
  try { await finite(pending.connected, "pending connect"); await finite(c.stop(), "stop with incomplete body"); await finite(pending.ended, "socket closed by stop"); } finally { pending.socket.destroy(); }
  expect(calls).toBe(0); expect(sent).toEqual([]); expect(receipts(path)).toEqual([]);
 });
}, 20000);
