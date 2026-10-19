import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { telegramChannel, type TelegramConfig } from "../src/channels/telegram.ts";
import { TELEGRAM_GATE_POLICY } from "../src/channels/api-gate.ts";
import { discordChannel, type DiscordConfig } from "../src/channels/discord.ts";
import { chunks, retryDelay, type MessagingChannel } from "../src/channels/messaging.ts";
import type { InboundMessage } from "../src/channels/types.ts";

const dirs: string[] = [], channels: MessagingChannel[] = [], servers: ReturnType<typeof Bun.serve>[] = [];
const answer = async () => ({ status: "answered" as const, text: "answer" });
process.env.MESSAGING_TEST_TOKEN = "123:test";
process.env.MESSAGING_TEST_SECRET = "test-secret";
afterEach(async () => { for (const c of channels.splice(0)) await c.stop(); for (const s of servers.splice(0)) await s.stop(true); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function path() { const dir = mkdtempSync(join(tmpdir(), "messaging-test-")); dirs.push(dir); return join(dir, "inbox.sqlite"); }
function tgConfig(extra: Partial<TelegramConfig> = {}): TelegramConfig { return { port: 0, databasePath: path(), allowedUserIds: ["7"], allowedChatIds: ["-9"], botTokenEnv: "MESSAGING_TEST_TOKEN", webhookSecretEnv: "MESSAGING_TEST_SECRET", ...extra }; }
function fake(fetch: (req: Request) => Response | Promise<Response>) { const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: req => new URL(req.url).pathname.endsWith("/setMyCommands") ? Response.json({ ok: true, result: true }) : fetch(req) }); servers.push(server); return server.url.origin; }
function tg(config: TelegramConfig, apiBase = fake(() => Response.json({ ok: true }))) { const c = telegramChannel(config, { apiBase }); channels.push(c); return c; }
function event(id = 1, text = "hello") { return { update_id: id, message: { message_id: id, from: { id: 7, is_bot: false }, chat: { id: -9 }, message_thread_id: 12, text } }; }
function post(c: MessagingChannel, body: unknown, secret = "test-secret") { return fetch(new URL("/webhook", c.url()), { method: "POST", headers: { "x-telegram-bot-api-secret-token": secret }, body: JSON.stringify(body) }); }
async function until(fn: () => boolean, ms = 4000) { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error("condition timeout"); await Bun.sleep(10); } }
function rows(file: string) { const db = new Database(file); try { return db.query("SELECT * FROM jobs ORDER BY seq").all() as Record<string, unknown>[]; } finally { db.close(); } }

test("Telegram fail closed auth, user/chat allowlists, bot and attachment-only filtering", async () => {
 const c = tg(tgConfig()); let invoked = 0; await c.start(async () => { invoked++; return answer(); });
 expect((await post(c, event(), "wrong")).status).toBe(401);
 const wrongUser = event(); wrongUser.message.from.id = 8; expect((await post(c, wrongUser)).status).toBe(403);
 const wrongChat = event(); wrongChat.message.chat.id = -8; expect((await post(c, wrongChat)).status).toBe(403);
 const bot = event(); bot.message.from.is_bot = true; expect((await post(c, bot)).status).toBe(200);
 expect((await post(c, { update_id: 4, message: { photo: [{}] } })).status).toBe(200);
 expect((await post(c, event(5, "x".repeat(70000)))).status).toBe(413);
 await Bun.sleep(150); expect(invoked).toBe(0); expect(c.health().queued).toBe(0);
});

test("ACK is committed, duplicates collapse, queued restart recovers and identities are stable", async () => {
 // ADR 0048 dispatches on admission (no 100 ms poll), so the first owner holds the turn cooperatively to make the
 // restart boundary deterministic; `calls` counts completed turns, and the unfinished one is recovered as queued.
 const config = tgConfig(); const c = tg(config); let calls = 0;
 await c.start((_m, signal) => new Promise((_, reject) => signal!.addEventListener("abort", () => reject(new Error("abort")), { once: true })));
 expect((await post(c, event())).status).toBe(200);
 expect((await post(c, event())).status).toBe(200);
 await until(() => c.health().processing === 1);
 await c.stop(); const stored = rows(config.databasePath); expect(stored).toHaveLength(1);
 const seen: InboundMessage[] = []; const next = tg(config);
 await next.start(async (m) => { seen.push(m); return answer(); }); await until(() => next.health().done === 1);
 expect(calls + seen.length).toBe(1);
 if (seen.length) expect(seen[0]).toMatchObject({ messageId: "1", threadKey: "123:-9:12:7", userId: "7" });
 expect((await post(next, event())).status).toBe(200); await Bun.sleep(150); expect(calls + seen.length).toBe(1);
});

test("processing restart reuses native idempotency key and stop aborts cooperative handler", async () => {
 const config = tgConfig(); const c = tg(config); let first: InboundMessage | undefined;
 await c.start((m, signal) => { first = m; return new Promise((_, reject) => signal!.addEventListener("abort", () => reject(new Error("abort")), { once: true })); });
 await post(c, event()); await until(() => !!first); const start = Date.now(); await c.stop(); expect(Date.now() - start).toBeLessThan(500);
 expect(rows(config.databasePath)[0]!.state).toBe("processing");
 const next = tg(config); let replay: InboundMessage | undefined; await next.start(async (m) => { replay = m; return answer(); });
 await until(() => next.health().done === 1); expect(replay).toEqual(first);
});

test("capacity includes receipts, overload never invokes handler, duplicate still acknowledged", async () => {
 const c = tg(tgConfig({ maxRows: 1 })); let calls = 0; await c.start(async () => { calls++; return answer(); });
 expect((await post(c, event())).status).toBe(200); expect((await post(c, event(2))).status).toBe(503);
 expect((await post(c, event())).status).toBe(200); await until(() => c.health().done === 1); expect(calls).toBe(1);
});

test("Telegram rich Unicode chunks preserve visible text, FIFO and bounded 429 schedule", async () => {
 const sent: { text: string; parse_mode?: string; message_thread_id: number }[] = []; const times: number[] = [];
 let attempt = 0; const base = fake(async (req) => { const body = await req.json() as { text: string; message_thread_id: number }; times.push(Date.now()); if (++attempt === 1) return Response.json({ parameters: { retry_after: 0.2 } }, { status: 429 }); sent.push(body); return Response.json({ ok: true }); });
 const c = tg(tgConfig(), base); const full = "a".repeat(4095) + "😀" + String.fromCharCode(96).repeat(3) + "<tag>_markdown_";
 await c.start(async (m) => ({ status: "answered", text: m.messageId === "1" ? full : "last" }));
 // Missing Retry-After retains the 1 s header fallback despite the 0.2 s body.
 // Retry priority + the next two writes add three production chat spacings: a 4 s
 // protocol minimum, not a 4 s latency SLA. Leave bounded transport/scheduler headroom.
 const firstRetryFloor = 1000 + TELEGRAM_GATE_POLICY.chatSpacingMs;
 const drainFloor = firstRetryFloor + 2 * TELEGRAM_GATE_POLICY.chatSpacingMs;
 await post(c, event()); await post(c, event(2)); await until(() => c.health().done === 2, drainFloor + 1500);
 expect(times).toHaveLength(4); // One rejected request, two Unicode chunks, then the FIFO successor.
 expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(firstRetryFloor); expect(sent.slice(0, -1).map(x => x.text).join("")).toBe(full.replace("<tag>","&lt;tag&gt;").replace("_markdown_","<i>markdown</i>")); expect(sent.at(-1)!.text).toBe("last");
 for (const msg of sent) { expect(msg.text.length).toBeLessThanOrEqual(4096); expect(msg.text).not.toContain("�"); expect(msg.parse_mode).toBe("HTML"); expect(msg.message_thread_id).toBe(12); }
}, 6000);

test("Telegram timeout is ambiguous dead letter, never blindly replayed", async () => {
 let calls = 0; const base = fake(async () => { calls++; await Bun.sleep(300); return Response.json({ ok: true }); });
 const config = tgConfig({ requestTimeoutMs: 50 }); const c = tg(config, base); await c.start(answer); await post(c, event()); await until(() => c.health().dead === 1);
 expect(c.health().unknown).toBe(1); expect(c.health().dead_ambiguous_delivery).toBe(1);
 expect(c.storagePaths).toEqual([config.databasePath, config.databasePath + "-journal"]);
 await c.stop(); expect(rows(config.databasePath)[0]!.error).toBe("ambiguous_delivery"); const next = tg(config, base); await next.start(answer); await Bun.sleep(200); expect(calls).toBe(1);
});

test("retry attempts finite, oversized replies dead letter, health contains no secrets", async () => {
 let calls = 0; const c = tg(tgConfig({ maxAttempts: 2 }), fake(() => { calls++; return new Response(null, { status: 429, headers: { "Retry-After": "0" } }); }));
 await c.start(answer); await post(c, event()); await until(() => c.health().dead === 1); expect(calls).toBe(2);
 const health = await (await fetch(new URL("/healthz", c.url()))).text(); expect(health).not.toContain("secret"); expect(health).not.toContain("token");
 const small = tg(tgConfig({ maxResponseBytes: 1 })); await small.start(answer); await post(small, event()); await until(() => small.health().dead === 1);
});

test("persisted delivery progress resumes without repeating Telegram chunks", async () => {
 const config = tgConfig(); const c = tg(config); await c.start(answer); await post(c, event()); await c.stop();
 const db = new Database(config.databasePath); db.query("UPDATE jobs SET state='ready', parts=?, progress=1, due=0").run(JSON.stringify(["sent", "remaining"])); db.close();
 const sent: string[] = []; const next = tg(config, fake(async req => { sent.push((await req.json() as { text: string }).text); return Response.json({ ok: true }); }));
 await next.start(async () => { throw new Error("must not invoke"); }); await until(() => next.health().done === 1); expect(sent).toEqual(["remaining"]);
});

test("Telegram sending on restart is ambiguous, retention expires only terminal receipts", async () => {
 const config = tgConfig({ retentionSeconds: 600 }); const c = tg(config); await c.start(answer); await post(c, event()); await c.stop();
 const db = new Database(config.databasePath); db.exec("UPDATE jobs SET state='sending'"); db.close(); const next = tg(config); await next.start(answer); expect(next.health().dead).toBe(1); await next.stop();
 // ADR 0048: retention runs from terminal_at (when the receipt became terminal); age both clocks past retention.
 const edit = new Database(config.databasePath); edit.query("UPDATE jobs SET created=?, terminal_at=?").run(Date.now() - 601000, Date.now() - 601000); edit.close();
 const last = tg(config); await last.start(answer); expect(last.health().dead).toBe(0); expect((await post(last, event())).status).toBe(200); await until(() => last.health().done === 1);
});

const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
function dcConfig(extra: Partial<DiscordConfig> = {}): DiscordConfig { return { port: 0, databasePath: path(), allowedUserIds: ["7"], allowedChannelIds: ["9"], applicationId: "123", publicKey, ...extra }; }
function dc(config: DiscordConfig, apiBase = fake(() => Response.json({ id: "99" }))) { const c = discordChannel(config, { apiBase }); channels.push(c); return c; }
function interaction(age = 0) { return { id: String(BigInt(Date.now() - age - 1420070400000) << 22n), application_id: "123", type: 2, channel_id: "9", user: { id: "7" }, token: "interaction-token", data: { name: "ask", type: 1, options: [{ name: "prompt", type: 3, value: "hello" }] } }; }
function signed(c: MessagingChannel, event: unknown, age = 0, bad = false) { const body = JSON.stringify(event), stamp = String(Math.floor((Date.now() - age) / 1000)); const signature = sign(null, Buffer.from(stamp + body), keys.privateKey).toString("hex"); return fetch(new URL("/webhook", c.url()), { method: "POST", body, headers: { "x-signature-timestamp": stamp, "x-signature-ed25519": bad ? "0".repeat(128) : signature } }); }

test("Discord signature, timestamp, application, channel/user allowlists and command shape", async () => {
 const c = dc(dcConfig()); let calls = 0; await c.start(async () => { calls++; return answer(); }); const good = interaction();
 expect((await signed(c, good, 0, true)).status).toBe(401); expect((await signed(c, good, 301000)).status).toBe(401);
 expect((await signed(c, { ...good, application_id: "456" })).status).toBe(403);
 expect((await signed(c, { ...good, channel_id: "10" })).status).toBe(403);
 expect((await signed(c, { ...good, user: { id: "8" } })).status).toBe(403);
 expect((await signed(c, { ...good, data: { name: "tool", type: 1, options: [] } })).status).toBe(400);
 expect((await signed(c, interaction(901000))).status).toBe(401);
 expect(await (await signed(c, { type: 1, application_id: "123" })).json()).toEqual({ type: 1 });
 await Bun.sleep(150); expect(calls).toBe(0);
});

test("Discord defer persists, duplicate collapses, idempotent PATCH attachment preserves fences and mentions", async () => {
 const requests: { method: string; url: string; payload: any; text: string }[] = []; let calls = 0; const content = ("@everyone " + String.fromCharCode(96).repeat(3) + "ts\n").repeat(300);
 const base = fake(async req => { const form = await req.formData(); requests.push({ method: req.method, url: req.url, payload: JSON.parse(String(form.get("payload_json"))), text: await (form.get("files[0]") as File).text() }); if (requests.length === 1) return new Response(null, { status: 429, headers: { "Retry-After": "0.1" } }); return Response.json({ id: "99" }); });
 const config = dcConfig(); const c = dc(config, base); await c.start(async () => { calls++; return { status: "answered", text: content }; }); const msg = interaction();
 expect(await (await signed(c, msg)).json()).toEqual({ type: 5, data: { flags: 64 } }); expect((await signed(c, msg)).status).toBe(200);
 await until(() => c.health().done === 1); expect(calls).toBe(1); expect(requests).toHaveLength(2);
 for (const req of requests) { expect(req.method).toBe("PATCH"); expect(req.url.endsWith("/messages/@original")).toBe(true); expect(req.payload.allowed_mentions.parse).toEqual([]); expect(req.text).toBe(content); expect(req.payload.attachments).toEqual([{ id: 0, filename: "answer.txt" }]); }
 await c.stop(); expect(rows(config.databasePath)).toHaveLength(1); expect(rows(config.databasePath)[0]!.target).toBe("{}");
});

test("Discord expired queued token is explicit dead letter without handler", async () => {
 const config = dcConfig(); const c = dc(config); await c.start(answer); await signed(c, interaction()); await c.stop();
 const db = new Database(config.databasePath); db.exec("UPDATE jobs SET state='queued', expires=1"); db.close();
 let calls = 0; const next = dc(config); await next.start(async () => { calls++; return answer(); }); await until(() => next.health().dead === 1); expect(calls).toBe(0); await next.stop(); expect(rows(config.databasePath)[0]!.error).toBe("token_expired");
});

test("Discord running handler may outlive token but expiry never falls back to public delivery", async () => {
 const realNow = Date.now;
 let release!: () => void, signal: AbortSignal | undefined, calls = 0;
 const held = new Promise<void>(resolve => { release = resolve; });
 const config = dcConfig({ handlerTimeoutMs: 50 });
 const c = dc(config, fake(() => { calls++; return Response.json({ id: "99" }); }));
 try {
  await c.start(async (_m, s) => { signal = s; await held; return { status: "answered", text: "private late answer" }; });
  expect(await (await signed(c, interaction())).json()).toEqual({ type: 5, data: { flags: 64 } });
  await until(() => !!signal);
  const later = realNow() + 16 * 60 * 1000;
  Date.now = () => later;
  expect(signal!.aborted).toBe(false); expect(c.health().processing).toBe(1);
  release();
  // Drain only promise continuations: expiry is checked when the ready reply is dispatched.
  for (let i = 0; i < 100; i++) await Promise.resolve();
  expect(c.health()).toMatchObject({ running: 1, dead_token_expired: 1, active: 0 });
  expect(calls).toBe(0); expect(signal!.aborted).toBe(false);
  await c.stop();
  expect(rows(config.databasePath)[0]!.error).toBe("token_expired");
 } finally { Date.now = realNow; release(); await c.stop(); }
});

test("Discord network timeout safely retries PATCH finitely and restart sending is replay-safe", async () => {
 let count = 0; const base = fake(async () => { count++; await Bun.sleep(150); return Response.json({ id: "99" }); });
 const config = dcConfig({ requestTimeoutMs: 50, maxAttempts: 2 }); const c = dc(config, base); await c.start(answer); await signed(c, interaction()); await until(() => c.health().dead === 1); expect(count).toBe(2);
 await c.stop(); const db = new Database(config.databasePath); db.query("UPDATE jobs SET state='sending', parts=?, target=?, message=?, attempts=0, expires=?, due=0").run(JSON.stringify(["recovered"]), JSON.stringify({ token: "still-valid" }), JSON.stringify({ channel: "discord", userId: "7", threadKey: "123:9:7", messageId: "1", text: "hello" }), Date.now() + 60000); db.close();
 const next = dc(config); await next.start(async () => { throw new Error("unexpected handler"); }); await until(() => next.health().done === 1);
});

// ADR 0048 §3/A5 replaces the former "stop bounded" expectation: a stop cannot succeed while the original
// non-cooperative handler is still unsettled, and nothing is sent or written after the original finally settles.
test("noncooperative handler keeps its slot, stop stays pending until the original settles, late result never sent", async () => {
 let resolve: ((r: { status: "answered"; text: string }) => void) | undefined; let sends = 0, calls = 0;
 const config = tgConfig({ handlerTimeoutMs: 50 });
 const c = tg(config, fake((req) => { calls++; if (new URL(req.url).pathname.endsWith("/sendMessage")) sends++; return Response.json({ ok: true }); }));
 try {
  await c.start(() => new Promise(r => { resolve = r; }));
  await post(c, event()); await until(() => !!resolve);
  expect(c.health()).toMatchObject({ active: 1, running: 1, processing: 1 });
  let stopped = false; const stopping = c.stop().then(() => { stopped = true; });
  expect(c.health()).toMatchObject({ active: 1, stopping: 1 });
  await Bun.sleep(300); expect(stopped).toBe(false);
  const before = calls; resolve!({ status: "answered", text: "late" }); resolve = undefined;
  await Promise.race([stopping, Bun.sleep(2000)]); expect(stopped).toBe(true);
  await Bun.sleep(100); expect(sends).toBe(0); expect(calls).toBe(before);
  // Stop leaves the processing row for recovery; neither the late answer nor a failure notice is stored.
  const [row] = rows(config.databasePath); expect(row!.state).toBe("processing"); expect(row!.error).toBeNull(); expect(row!.parts).toBeNull();
 } finally { resolve?.({ status: "answered", text: "late" }); }
});

test("schema rejects unknown secrets, empty allowlists and volatile persistence; retry bounds", async () => {
 expect(() => telegramChannel({ ...tgConfig(), allowedUserIds: [] })).toThrow();
 expect(() => telegramChannel({ ...tgConfig(), token: "secret" } as TelegramConfig)).toThrow();
 const c = tg(tgConfig({ databasePath: ":memory:" })); await expect(c.start(answer)).rejects.toThrow();
 expect(retryDelay("99999999")).toBe(99999999000); expect(retryDelay("-1")).toBe(100); expect(retryDelay("bad")).toBe(1000);
 expect(chunks("😀😀", 3)).toEqual(["😀", "😀"]);
});


test("database has exclusive ownership and cannot be reused by another application", async () => {
 const config = tgConfig(); const first = tg(config); await first.start(answer);
 const second = tg(config); await expect(second.start(answer)).rejects.toThrow();
 await first.stop(); const other = dc(dcConfig({ databasePath: config.databasePath })); await expect(other.start(answer)).rejects.toThrow("another channel");
});

test("concurrent Telegram duplicate admissions and handler execution remain single-flight", async () => {
 let calls = 0; let active = 0; let maximum = 0; const c = tg(tgConfig());
 await c.start(async () => { calls++; active++; maximum = Math.max(maximum, active); await Bun.sleep(30); active--; return answer(); });
 const responses = await Promise.all(Array.from({ length: 20 }, () => post(c, event())));
 expect(responses.every(r => r.status === 200)).toBe(true);
 await until(() => c.health().done === 1); // a same-thread message during the turn would steer (ADR 0057), not wait
 await post(c, event(2)); await until(() => c.health().done === 2); expect(calls).toBe(2); expect(maximum).toBe(1);
});


for (const kind of ['telegram', 'discord'] as const) for (const state of ['queued', 'ready']) for (const revoked of ['actor', 'destination']) {
 test(kind + ' persisted ' + state + ' rejects revoked ' + revoked, async () => {
  const config = kind === 'telegram' ? tgConfig() : dcConfig();
  const first = kind === 'telegram' ? tg(config as TelegramConfig) : dc(config as DiscordConfig);
  await first.start(answer);
  if (kind === 'telegram') await post(first, event()); else await signed(first, interaction());
  await first.stop();
  const db = new Database(config.databasePath);
  db.query("UPDATE jobs SET state=?, parts=?, due=0").run(state, JSON.stringify(['saved'])); db.close();
  let calls = 0, sends = 0;
  const base = fake(() => { sends++; return Response.json({ ok: true }); });
  const changed = { ...config, ...(revoked === 'actor' ? { allowedUserIds: ['8'] } : kind === 'telegram' ? { allowedChatIds: ['-8'] } : { allowedChannelIds: ['8'] }) };
  const next = kind === 'telegram' ? tg(changed as TelegramConfig, base) : dc(changed as DiscordConfig, base);
  await next.start(async () => { calls++; return answer(); });
  await until(() => next.health().dead === 1 || next.health().done === 1);
  expect(calls).toBe(0); expect(sends).toBe(0); expect(next.health().dead_permission_revoked).toBe(1);
  await next.stop(); expect(rows(config.databasePath)[0]!.error).toBe('permission_revoked');
 });
}

test('start then immediate stop never invokes deferred queued handler with aborted signal', async () => {
 // The first owner holds the job in a cooperative handler so it is still unfinished at stop (ADR 0048 dispatches on
 // admission instead of the former 100 ms poll, so an instant answer would already be in flight); restart re-queues it.
 const config = tgConfig(); const first = tg(config); let held = false;
 await first.start((_m, signal) => { held = true; return new Promise((_, reject) => signal!.addEventListener("abort", () => reject(new Error("abort")), { once: true })); });
 await post(first, event()); await until(() => held); await first.stop(); expect(rows(config.databasePath)[0]!.state).toBe("processing");
 let calls = 0; const next = tg(config); const starting = next.start(async () => { calls++; return answer(); }); const stopping = next.stop();
 await expect(starting).rejects.toThrow("Channel stopped during start"); await stopping; expect(calls).toBe(0);
 const final = tg(config); await final.start(async () => { calls++; return answer(); }); await until(() => final.health().done === 1); expect(calls).toBe(1);
});

for (const header of ['0.1', 'malformed']) test('429 honors body lower bound despite header ' + header, async () => {
 const times: number[] = []; const c = tg(tgConfig(), fake(() => { times.push(Date.now()); return times.length === 1 ? Response.json({ parameters: { retry_after: 1.2 } }, { status: 429, headers: { 'Retry-After': header } }) : Response.json({ ok: true }); }));
 await c.start(answer); await post(c, event()); await until(() => c.health().done === 1);
 expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(1200);
});

for (const length of [2000, 2001]) test('Discord inline UTF16 boundary ' + length + ' preserves Markdown and disables mentions', async () => {
 const prefix = '@everyone <@7> ' + String.fromCharCode(96).repeat(3) + 'ts\n😀\n' + String.fromCharCode(96).repeat(3); const content = prefix + 'x'.repeat(length - prefix.length);
 let payload: any, file: File | null = null;
 const c = dc(dcConfig(), fake(async req => { const form = await req.formData(); payload = JSON.parse(String(form.get('payload_json'))); file = form.get('files[0]') as File | null; return Response.json({ id: '99' }); }));
 await c.start(async () => ({ status: 'answered', text: content })); await signed(c, interaction()); await until(() => c.health().done === 1);
 expect(payload.allowed_mentions).toEqual({ parse: [], users: [], roles: [], replied_user: false });
 if (length === 2000) { expect(payload.content).toBe(content); expect(file).toBeNull(); expect(payload.attachments).toEqual([]); }
 else { expect(file!.name).toBe('answer.txt'); expect(await file!.text()).toBe(content); }
});

for (const kind of ['telegram', 'discord'] as const) test(kind + ' slow committed INSERT returns 503 but duplicate ACK preserves exactly one queued execution', async () => {
 const c = kind === 'telegram' ? tg(tgConfig({ requestTimeoutMs: 50 })) : dc(dcConfig({ requestTimeoutMs: 50 })); let calls = 0;
 const payload = kind === 'telegram' ? event() : interaction();
 const submit = () => kind === 'telegram' ? post(c, payload) : signed(c, payload);
 await c.start(async () => { calls++; return answer(); });
 const original = Database.prototype.query;
 Database.prototype.query = function(this: Database, sql: string) {
  const statement = original.call(this, sql);
  if (sql.startsWith('INSERT INTO jobs(')) {
   const run = statement.run.bind(statement);
   statement.run = (...params: any[]) => { const result = run(...params); const end = Date.now() + 80; while (Date.now() < end) {} return result; };
  }
  return statement;
 } as typeof original;
 try { expect((await submit()).status).toBe(503); } finally { Database.prototype.query = original; }
 expect((await submit()).status).toBe(200);
 await until(() => c.health().done === 1 || c.health().dead === 1); expect(c.health().done).toBe(1); expect(calls).toBe(1);
});


for (const kind of ['telegram', 'discord'] as const) for (const header of ['0.1', 'invalid']) test(kind + ' oversized body retry bound beats ' + header + ' header', async () => {
 let sends = 0; const base = fake(() => { sends++; return Response.json({ retry_after: 61, parameters: { retry_after: 61 } }, { status: 429, headers: { 'Retry-After': header } }); });
 const c = kind === 'telegram' ? tg(tgConfig(), base) : dc(dcConfig(), base); await c.start(answer);
 if (kind === 'telegram') await post(c, event()); else await signed(c, interaction());
 await until(() => c.health().dead === 1); expect(sends).toBe(1); expect(c.health().dead_retry_after_exceeds_budget).toBe(1);
});

for (const identity of ['123:9:7', 'unsafe-token-identity']) test('Discord legacy token-only target authorizes safe identity: ' + identity, async () => {
 const config = dcConfig(); const first = dc(config); await first.start(answer); await signed(first, interaction()); await first.stop();
 const db = new Database(config.databasePath);
 db.query("UPDATE jobs SET state='ready', target=?, message=?, parts=?").run(JSON.stringify({ token: 'private-token' }), JSON.stringify({ channel: 'discord', userId: '7', threadKey: identity, messageId: '1', text: 'private' }), JSON.stringify(['saved'])); db.close();
 let sends = 0; const next = dc(config, fake(() => { sends++; return Response.json({ id: '99' }); })); await next.start(async () => { throw new Error('no handler'); });
 await until(() => next.health().done === 1 || next.health().dead === 1);
 expect(sends).toBe(identity === '123:9:7' ? 1 : 0);
 if (!sends) expect(next.health().dead_permission_revoked).toBe(1);
 expect(JSON.stringify(next.health())).not.toContain('private');
});

 test("Discord first progress429 shares120s cooldown with final; final terminates instead of early PATCH", async () => {
 let writes=0, release!:()=>void; const held=new Promise<void>(r=>release=r);
 const c=dc(dcConfig(),fake(()=>{writes++;release();return new Response(null,{status:429,headers:{"Retry-After":"120"}});}));
 await c.start(async (_m,_s,progress)=>{progress?.({type:"tool_start",id:"x",name:"read"});await held;return answer();});
 await signed(c,interaction());await until(()=>c.health().dead===1);
 expect(writes).toBe(1);expect(c.health().dead_retry_after_exceeds_budget).toBe(1);
 });
 test("Discord terminal progress settles before final overwrite", async () => {
 const writes:string[]=[];let release!:()=>void;const held=new Promise<void>(r=>release=r);
 const c=dc(dcConfig(),fake(async req=>{const body= req.headers.get("content-type")?.includes("application/json") ? await req.json() : JSON.parse(String((await req.formData()).get("payload_json")));writes.push(body.content);if(writes.length===1)release();return Response.json({id:"1"});}));
 await c.start(async (_m,_s,progress)=>{progress?.({type:"tool_start",id:"x",name:"read"});await held;return answer();});
 await signed(c,interaction());await until(()=>c.health().done===1);
 expect(writes).toHaveLength(3);expect(writes[0]).toStartWith("⏳");expect(writes[1]).toStartWith("✅");expect(writes[2]).toBe("answer");
 });
