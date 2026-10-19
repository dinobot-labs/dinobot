import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {systemClock, type GatePolicy} from "../src/channels/api-gate.ts";
import {FakeClock} from "./fixtures/issuance.ts";
import { INBOX_SCHEMA_VERSION, SCHEDULER_SQL, type MessagingChannel } from "../src/channels/messaging.ts";
import { telegramChannel, type TelegramConfig } from "../src/channels/telegram.ts";
import type { BotReply } from "../src/channels/types.ts";
import { SCALED_GATE_POLICY } from "./fixtures/gate-policy.ts";

// ADR 0048 UNIT2: the shared API gate in the real Telegram adapter — real SQLite, real polling/webhook, local REST.
// Tests marked "production policy" inject nothing: the 40 ms / 1 s / 20-per-60 s constants apply as deployed.
const TOKEN = "731:test_only_api_gate";
process.env.API_GATE_TOKEN = TOKEN;
process.env.API_GATE_SECRET = "api-gate-secret";
const originalFetch=globalThis.fetch;
const dirs: string[] = [], channels: MessagingChannel[] = [], servers: ReturnType<typeof Bun.serve>[] = [], releases: (() => void)[] = [];
afterEach(async () => {
	for (const release of releases.splice(0)) release();
	try { for (const c of channels.splice(0)) await c.stop(); }
	finally { globalThis.fetch=originalFetch; for (const s of servers.splice(0)) await s.stop(true); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); }
});
async function until(fn: () => boolean, label: string, ms = 6000) { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error("timeout: " + label); await Bun.sleep(5); } }
function dbPath() { const dir = mkdtempSync(join(tmpdir(), "api-gate-")); dirs.push(dir); return join(dir, "inbox.sqlite"); }
function cfg(extra: Partial<TelegramConfig> = {}): TelegramConfig {
	return { port: 0, databasePath: dbPath(), allowedUserIds: ["7"], allowedChatIds: ["-9", "-10"], botTokenEnv: "API_GATE_TOKEN", webhookSecretEnv: "API_GATE_SECRET", progress: "off", ...extra };
}
type Call = { method: string; body: any; at: number };
/** Local Telegram REST. `hook` may answer itself; otherwise every method succeeds. getUpdates serves `updates` once. */
function fakeTelegram(hook?: (call: Call) => Response | undefined | Promise<Response | undefined>) {
	const calls: Call[] = [], responses: { method: string; status: number; at: number }[] = [];
	const updates: unknown[] = [];
	let messageId = 0;
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
		const method = new URL(req.url).pathname.split("/").at(-1)!;
		const call: Call = { method, body: await req.json(), at: Date.now() };
		calls.push(call);
		const answer = await hook?.(call) ?? (
			method === "getWebhookInfo" ? Response.json({ ok: true, result: { url: "" } })
			: method === "getUpdates" ? Response.json({ ok: true, result: updates.splice(0).filter((u: any) => u.update_id >= call.body.offset) })
			: Response.json({ ok: true, result: method === "sendMessage" ? { message_id: ++messageId } : true }));
		responses.push({ method, status: answer.status, at: Date.now() });
		return answer;
	} });
	servers.push(server);
 const localCalls:Call[]=[],localResponses:{status:number;at:number}[]=[];const previous=globalThis.fetch;
 globalThis.fetch=Object.assign(((input:Parameters<typeof fetch>[0],init?:Parameters<typeof fetch>[1])=>{
  if(!String(input).startsWith(server.url.origin+"/bot"))return previous(input,init);
  localCalls.push({method:String(input).split("/").at(-1)!,body:JSON.parse(String(init?.body??"{}")),at:performance.now()});
  const raw=previous(input,init);void raw.then(r=>{localResponses.push({status:r.status,at:performance.now()});},()=>{});return raw;
 }) as typeof fetch,{preconnect:previous.preconnect});
	return { base: server.url.origin, calls, responses, updates, localCalls, localResponses };
}
function tg(config: TelegramConfig, base: string, gatePolicy?: GatePolicy) {
	const c = telegramChannel(config, { apiBase: base, ...(gatePolicy ? { gatePolicy } : {}) });
	channels.push(c);
	return c;
}
function event(id: number, topic: number, chat = -9, text = "request-" + id) {
	return { update_id: id, message: { message_id: id, from: { id: 7, is_bot: false }, chat: { id: chat, type: "supergroup" }, message_thread_id: topic, text } };
}
async function post(c: MessagingChannel, body: unknown) {
	const response = await fetch(new URL("/webhook", c.url()), { method: "POST", headers: { "x-telegram-bot-api-secret-token": "api-gate-secret" }, body: JSON.stringify(body), signal: AbortSignal.timeout(4000) });
	await response.arrayBuffer();
	return response.status;
}
const answered = (text: string): BotReply => ({ status: "answered", text });
function inspect<T>(path: string, read: (db: Database) => T): T { const db = new Database(path); try { return read(db); } finally { db.close(); } }
const permits = (path: string) => inspect(path, db => db.query("SELECT at, CASE WHEN kind IN ('final','write') THEN rate_key ELSE NULL END AS key FROM api_permits ORDER BY seq").all() as { at: number; key: string | null }[]);
const writes = (calls: Call[]) => calls.filter(c => c.method === "sendMessage" || c.method === "editMessageText");
function gate(): { promise: Promise<void>; release(): void } { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); releases.push(release); return { promise, release }; }

test("production policy: chunks and status writes to one chat start >= 1 s apart, all starts >= 40 ms apart, and a waiting chunk leaves its slot", async () => {
	const api = fakeTelegram();
	const config = cfg({ concurrency: 1, progress: "status" });
	const c = tg(config, api.base);
	const started: string[] = [];
	await c.start(async (m, _signal, progress) => {
		started.push(m.messageId);
		if (m.messageId === "2") {
			// Long enough for typing and a status bubble; the single slot is this handler's until it returns.
			progress?.({ type: "tool_start", id: "t", name: "bash" });
			await Bun.sleep(2500);
			progress?.({ type: "tool_end", id: "t", ok: true });
		}
		return answered(m.messageId === "1" ? "x".repeat(4096 * 3) : "answer-2");
	});
	expect(await post(c, event(1, 11))).toBe(200);
	await until(() => writes(api.calls).length === 1, "first chunk");
	expect(await post(c, event(2, 12))).toBe(200);
	// C = 1: job 2's handler can start only because chunk 2 of job 1 waits for its chat permit OFF the slot.
	await until(() => started.includes("2"), "handler of another topic starts during the chunk's permit wait", 900);
	expect(writes(api.calls)).toHaveLength(1);
	await until(() => c.health().done === 2, "drain", 14000);
	expect(api.calls.filter(x => x.method === "sendMessage" && x.body.message_thread_id === 11).map(x => x.body.text).join("")).toBe("x".repeat(4096 * 3));
	await c.stop();
	const log = permits(config.databasePath);
	// Exactly one durable permit per API request (menu, finals, typing, status send/edit).
	expect(log).toHaveLength(api.calls.length);
	for (let i = 1; i < log.length; i++) expect(log[i]!.at - log[i - 1]!.at).toBeGreaterThanOrEqual(40);
	const chat = log.filter(p => p.key === "chat:-9").map(p => p.at);
	expect(chat.length).toBe(writes(api.calls).length);
	for (let i = 1; i < chat.length; i++) expect(chat[i]! - chat[i - 1]!).toBeGreaterThanOrEqual(1000);
	// Typing and startup menu are bot-only; status writes share the final chunks' chat budget.
	expect(api.calls.filter(c => c.method === "setMyCommands")).toHaveLength(1);
	expect(log.filter(p => p.key === null).length).toBe(api.calls.filter(c => c.method === "sendChatAction").length + 1);
	expect(api.calls.filter(c => c.method === "sendMessage" && c.body.text === "answer-2")).toHaveLength(1);
	// Every class went through the gate: typing, the status bubble and its final edit, and the final chunks.
	expect(api.calls.some(c => c.method === "sendChatAction")).toBe(true);
	expect(api.calls.some(c => c.method === "sendMessage" && c.body.disable_notification === true)).toBe(true);
	expect(api.calls.some(c => c.method === "editMessageText")).toBe(true);
}, 25000);

test("polling: a 429 on one topic holds every later API start — other topic, progress and getUpdates — until the larger header/body bound", async () => {
	let limited = true, sentAt = 0;
	const api = fakeTelegram(call => {
		if (call.method === "sendMessage" && call.body.message_thread_id === 21 && limited) {
			limited = false; sentAt = Date.now();
			return Response.json({ ok: false, error_code: 429, parameters: { retry_after: 2 } }, { status: 429, headers: { "Retry-After": "1" } });
		}
		return undefined;
	});
	const c = tg(cfg({ mode: "polling", progress: "status", requestTimeoutMs: 2000 }), api.base, SCALED_GATE_POLICY);
	const second = gate();
	let secondStarted = false;
	await c.start(async (m, _signal, progress) => {
		if (m.messageId === "2") { secondStarted = true; progress?.({ type: "tool_start", id: "t", name: "bash" }); await second.promise; progress?.({ type: "tool_end", id: "t", ok: true }); }
		return answered("answer-" + m.messageId);
	});
	// Topic 22 runs (typing + status bubble) across the whole cooldown; topic 21's reply meets the 429.
	api.updates.push(event(2, 22));
	await until(() => secondStarted && api.calls.some(x => x.method === "sendMessage" && x.body.disable_notification === true), "topic 22 status bubble");
	api.updates.push(event(3, 21)); // update IDs increase: the durable cursor is already past 2
	await until(() => sentAt > 0, "429 answered");
	await Bun.sleep(2600); // the reporter of topic 22 keeps ticking (and asking for permits) through the bound
	await until(() => api.calls.some(x => x.method === "sendMessage" && x.body.text === "answer-3"), "retry after the bound", 4000);
	second.release();
	await until(() => c.health().done === 2, "drain");
	// LOCAL fetch invocations after receipt; no ignored 100ms interval or server-arrival proxy.
 const receipt=api.localResponses.find(r=>r.status===429)!.at;
	expect(api.localCalls.filter(x => x.at >= receipt && x.at < receipt + 2000).map(x => x.method)).toEqual([]);
	const after = api.calls.filter(x => x.at >= sentAt + 2000).map(x => x.method);
	for (const method of ["getUpdates", "sendMessage", "editMessageText"]) expect(after).toContain(method);
	expect(api.calls.filter(x => x.method === "sendMessage" && x.body.message_thread_id === 21).map(x => x.body.text)).toEqual(["answer-3", "answer-3"]);
}, 20000);

test("a lane that keeps meeting 429s cannot win every cooldown end and starve a lane waiting on the shared bound", async () => {
	const api = fakeTelegram(call => call.method === "sendMessage" && call.body.message_thread_id === 91 ? Response.json({ ok: false, parameters: { retry_after: 0.3 } }, { status: 429 }) : undefined);
	const c = tg(cfg({ maxAttempts: 10 }), api.base, SCALED_GATE_POLICY);
	await c.start(async m => answered("r" + m.messageId));
	expect(await post(c, event(1, 91))).toBe(200);
	await until(() => api.calls.some(x => x.body?.message_thread_id === 91), "first 429");
	expect(await post(c, event(2, 92, -10))).toBe(200);
	await until(() => c.health().done === 1, "waiting lane served", 2000);
	const sends = api.calls.filter(x => x.method === "sendMessage").map(x => x.body.message_thread_id);
	// The waiting lane goes at the first cooldown end; the rejected lane retries only after it.
	expect(sends.slice(0, 2)).toEqual([91, 92]);
	expect(c.health().dead).toBe(0);
});

test.each([0.3, 2])("a 429 retry yields after the retained shared bound (body %s seconds)", async retryAfter => {
	const api = fakeTelegram(call => call.method === "sendMessage" ? Response.json({ ok: false, parameters: { retry_after: retryAfter } }, { status: 429 }) : undefined);
	const config = cfg();
	const clock = new FakeClock(0);
	const c = telegramChannel(config, { apiBase: api.base, gatePolicy: SCALED_GATE_POLICY, gateClock: clock });
	channels.push(c);
	await c.start(async () => answered("reply"));
	await clock.advance(SCALED_GATE_POLICY.botSpacingMs); // Startup menu used the bot permit, not the chat budget.
	const before = Date.now();
	expect(await post(c, event(1, 91))).toBe(200);
	await until(() => c.health().ready === 1 && c.health().active === 0 && c.health().api_cooldown_ms! > 0, "429 retry persisted");
	await c.stop(); // Release the inbox's exclusive SQLite lock before inspecting the durable due.
	const retry = inspect(config.databasePath, db => db.query("SELECT due FROM jobs WHERE state='ready' AND error='rate_limited'").get() as { due: number });
	// Headers without Retry-After learn a 1 s fallback before the body. A shorter body cannot retract it.
	const retained = Math.max(1000, retryAfter * 1000);
	expect(c.health().api_cooldown_ms).toBe(retained);
	expect(retry.due).toBeGreaterThanOrEqual(before + retained + SCALED_GATE_POLICY.chatSpacingMs);
});

test("the cooldown is per bot: another bot (its own inbox and gate) keeps sending during it", async () => {
	process.env.API_GATE_OTHER_TOKEN = "732:test_only_api_gate_other";
	let limitedAt = 0;
	const api = fakeTelegram(call => {
		if (call.method === "sendMessage" && call.body.text === "bot731" && !limitedAt) { limitedAt = Date.now(); return Response.json({ ok: false, parameters: { retry_after: 2 } }, { status: 429 }); }
		return undefined;
	});
	const first = tg(cfg(), api.base, SCALED_GATE_POLICY), second = tg(cfg({ botTokenEnv: "API_GATE_OTHER_TOKEN" }), api.base, SCALED_GATE_POLICY);
	await first.start(async () => answered("bot731"));
	await second.start(async () => answered("bot732"));
	expect(await post(first, event(1, 81))).toBe(200);
	await until(() => limitedAt > 0, "bot 731 rate limited");
	expect(await post(second, event(1, 81))).toBe(200);
	await until(() => second.health().done === 1, "bot 732 answers during 731's cooldown", 1500);
	expect(Date.now() - limitedAt).toBeLessThan(2000);
	expect(first.health()).toMatchObject({ done: 0, ready: 1 });
	expect(first.health().api_cooldown_ms).toBeGreaterThan(0);
	expect(second.health().api_cooldown_ms).toBe(0);
	await until(() => first.health().done === 1, "bot 731 after its bound", 4000);
	const retried = api.calls.filter(x => x.method === "sendMessage" && x.body.text === "bot731");
	expect(retried).toHaveLength(2);
	expect(retried[1]!.at - limitedAt).toBeGreaterThanOrEqual(2000);
});

test("real SIGKILL after a 429: the persisted cooldown holds the restarted channel's first request, also in global rollback mode", async () => {
	let child429 = 0;
	const api = fakeTelegram(call => {
		if (call.method === "sendMessage" && !child429) { child429 = Date.now(); return Response.json({ ok: false, parameters: { retry_after: 3 } }, { status: 429 }); }
		return undefined;
	});
	const config = cfg({ mode: "polling", requestTimeoutMs: 2000 });
	api.updates.push(event(1, 31));
	const script = 'import {telegramChannel} from "./src/channels/telegram.ts"; const c=telegramChannel(' + JSON.stringify(config) + ',{apiBase:' + JSON.stringify(api.base) + '}); await c.start(async m=>({status:"answered",text:"reply-"+m.messageId})); console.log("STARTED");';
	const child = Bun.spawn([process.execPath, "-e", script], { cwd: process.cwd(), env: { ...process.env, API_GATE_TOKEN: TOKEN }, stdout: "pipe", stderr: "pipe" });
	try {
		await until(() => child429 > 0, "child receives the 429", 8000);
		await Bun.sleep(300); // the child commits the bound within milliseconds of reading the response
		child.kill("SIGKILL"); await child.exited;
	} finally { child.kill(); }
	const killedAt = Date.now();
	const stored = inspect(config.databasePath, db => JSON.parse((db.query("SELECT value FROM settings WHERE name='api_state_v3'").get() as any).value).server as {b:number;d:number});
 expect(stored.d).toBeGreaterThanOrEqual(3000);
 const remaining=stored.b+Math.ceil(stored.d*1001/1000)-Number(systemClock().observeNs()/1000000n);
 expect(remaining).toBeGreaterThan(1500);
	const before = api.calls.length;
	const c = tg({ ...config, schedulerMode: "global" }, api.base);
	await c.start(async () => answered("unused")); // getWebhookInfo waits for the bound inside start
	await until(() => c.health().done === 1, "retry after the bound", 6000);
	const later = api.calls.slice(before);
	expect(later[0]!.method).toBe("getWebhookInfo");
	for (const call of later) expect(call.at).toBeGreaterThanOrEqual(killedAt+remaining-1);
	expect(c.health().concurrency).toBe(1);
}, 25000);

test("a lower bound above 60 s fails closed: job dead, adapter stopped, and restarts are refused without any request until it elapses", async () => {
	const api = fakeTelegram(call => call.method === "sendMessage" ? Response.json({ ok: false, parameters: { retry_after: 61 } }, { status: 429 }) : undefined);
	const config = cfg();
	const c = tg(config, api.base);
	await c.start(async () => answered("never delivered"));
	expect(await post(c, event(1, 41))).toBe(200);
	await until(() => c.health().running === 0, "fail closed");
	expect(c.health()).toMatchObject({ api_blocked: 1, dead_retry_after_exceeds_budget: 1 });
	expect(c.health().api_cooldown_ms).toBeGreaterThan(59_000);
	await c.stop();
	const count = api.calls.length;
	for (const mode of ["webhook", "polling"] as const) {
		const next = tg({ ...config, mode }, api.base);
		await expect(next.start(async () => answered("x"))).rejects.toThrow("blocked");
	}
	expect(api.calls.length).toBe(count);
	// Only the elapsed bound (simulated by moving the persisted instant into the past) lets a restart through.
	inspect(config.databasePath, db => db.exec("UPDATE settings SET value=json_set(value,'$.server.b',0) WHERE name='api_state_v3'"));
	const after = tg(config, api.base);
	await after.start(async () => answered("x"));
	expect(after.health()).toMatchObject({ running: 1, api_blocked: 0, dead_retry_after_exceeds_budget: 1 });
});

test("polling 429 above 60 s also fails closed and is persisted", async () => {
	const api = fakeTelegram(call => call.method === "getUpdates" ? Response.json({ ok: false, error_code: 429, parameters: { retry_after: 120 } }, { status: 429 }) : undefined);
	const config = cfg({ mode: "polling" });
	const c = tg(config, api.base);
	await c.start(async () => answered("x"));
	await until(() => c.health().polling_failed === 1, "polling fails closed");
	expect(c.health()).toMatchObject({ polling_status: 429, running: 0, api_blocked: 1 });
	await c.stop();
	await expect(tg(config, api.base).start(async () => answered("x"))).rejects.toThrow("blocked");
});

test("real SIGKILL with a reserved permit and a hung send: the restart keeps the reservation's chat spacing and never replays the send", async () => {
	const hung: (() => void)[] = [];
	let phase: "child" | "parent" = "child";
	const api = fakeTelegram(async call => {
		if (phase === "child" && call.method === "sendMessage") { await new Promise<void>(r => hung.push(r)); return Response.json({ ok: true, result: { message_id: 1 } }); }
		return undefined;
	});
	const config = cfg();
	const script = 'import {telegramChannel} from "./src/channels/telegram.ts"; const c=telegramChannel(' + JSON.stringify(config) + ',{apiBase:' + JSON.stringify(api.base) + '}); await c.start(async m=>({status:"answered",text:"reply-"+m.messageId})); console.log("URL "+c.url().href);';
	const child = Bun.spawn([process.execPath, "-e", script], { cwd: process.cwd(), env: { ...process.env, API_GATE_TOKEN: TOKEN }, stdout: "pipe", stderr: "pipe" });
	let output = "";
	const reader = child.stdout.getReader();
	const pump = (async () => { for (;;) { const { done, value } = await reader.read(); if (done) return; output += new TextDecoder().decode(value); } })();
	try {
		await until(() => output.includes("URL "), "child ready", 8000);
		const url = /URL (\S+)/.exec(output)![1]!;
		const response = await fetch(new URL("/webhook", url), { method: "POST", headers: { "x-telegram-bot-api-secret-token": "api-gate-secret" }, body: JSON.stringify(event(1, 51)) });
		expect(response.status).toBe(200);
		await until(() => hung.length === 1, "send in flight");
		child.kill("SIGKILL"); await child.exited;
	} finally { child.kill(); await pump.catch(() => undefined); }
	phase = "parent"; for (const r of hung) r();
	const reserved = permits(config.databasePath).filter(p => p.key === "chat:-9");
	expect(reserved).toHaveLength(1);
	const sentAttempts = api.calls.filter(x => x.method === "sendMessage").length;
	expect(reserved[0]!.at).toBeLessThanOrEqual(api.calls.find(x => x.method === "sendMessage")!.at);
	// Production policy: the restart must not write to chat -9 before reservation + 1 s, though it is ready sooner.
	const c = tg(config, api.base);
	await c.start(async m => answered("after-" + m.messageId));
	expect(await post(c, event(2, 52))).toBe(200);
	await until(() => c.health().done === 1, "fresh job delivered");
	const fresh = api.calls.filter(x => x.method === "sendMessage").slice(sentAttempts);
	expect(fresh.map(x => x.body.text)).toEqual(["after-2"]);
	expect(fresh[0]!.at).toBeGreaterThanOrEqual(reserved[0]!.at + 1000);
	expect(c.health()).toMatchObject({ dead_ambiguous_delivery: 1 });
	await c.stop();
	const after = permits(config.databasePath).filter(p => p.key === "chat:-9");
	expect(after[1]!.at - after[0]!.at).toBeGreaterThanOrEqual(1000);
}, 25000);

test.each([2, 4])("a busy topic cannot starve a cold topic of their shared chat budget; other chats are independent (admission after %s chunks)", async hotChunks => {
	const api = fakeTelegram();
	const clock = new FakeClock(0);
	const c = telegramChannel(cfg(), { apiBase: api.base, gatePolicy: SCALED_GATE_POLICY, gateClock: clock });
	channels.push(c);
	// Yield to real HTTP/SQLite and the scheduler's wall wake hints, without advancing gate eligibility.
	async function observe(fn: () => boolean, label: string) {
		const end = Date.now() + 6000;
		while (!fn()) {
			if (Date.now() > end) throw new Error("timeout: " + label + " " + JSON.stringify(c.health()));
			await new Promise<void>(resolve => setImmediate(resolve));
		}
	}
	const parked = () => c.health().active === 0 && c.health().delayed_lanes === c.health().ready;
	async function nextWrite() {
		const before = writes(api.localCalls).length;
		await clock.advance(SCALED_GATE_POLICY.chatSpacingMs);
		await observe(() => writes(api.localCalls).length > before && parked(), "next write settled and live lanes parked");
	}
	await c.start(async m => answered(m.messageId === "1" ? "h".repeat(4096 * 15) : "cold-" + m.messageId));
	await clock.advance(SCALED_GATE_POLICY.botSpacingMs); // Preserve frozen-time fairness after the startup permit.
	expect(await post(c, event(1, 61))).toBe(200);
	await observe(() => writes(api.localCalls).length === 1 && parked(), "first hot write settled");
	for (let n = 1; n < hotChunks; n++) await nextWrite();
	expect(writes(api.localCalls)).toHaveLength(hotChunks);
	// Four chunks models work between observing the second chunk and asynchronous cold admission.
	const hotAtAdmission = writes(api.localCalls).filter(x => x.body.message_thread_id === 61).length;
	expect(await post(c, event(2, 62))).toBe(200);
	expect(await post(c, event(3, 63, -10))).toBe(200);
	await observe(() => c.health().ready === 3 && c.health().api_demands === 3 && parked(), "cold admissions waiting at the real gate");
	// Frozen gate time forbids hot starts throughout asynchronous admission, including handler/render completion.
	expect(writes(api.localCalls)).toHaveLength(hotChunks);
	for (let n = 0; n < 17 && c.health().done !== 3; n++) await nextWrite();
	expect(c.health().done).toBe(3);
	const sends = writes(api.localCalls); // Raw invocation order, rather than REST server arrival order.
	const cold = sends.findIndex(x => x.body.text === "cold-2");
	expect(cold).toBeGreaterThanOrEqual(0);
	const hotBefore = sends.slice(0, cold).filter(x => x.body.message_thread_id === 61).length;
	// Same chat: the cold reply waits for at most two more hot chunks (rotation + the chunk already waiting).
	expect(hotBefore - hotAtAdmission).toBeLessThanOrEqual(2);
	expect(sends.filter(x => x.body.message_thread_id === 61).map(x => x.body.text).join("")).toBe("h".repeat(4096 * 15));
	// Another chat has its own write budget: sent long before the hot reply finishes.
	expect(sends.findIndex(x => x.body.chat_id === "-10")).toBeLessThan(sends.length - 8);
}, 20000);

test("UNIT1 (v1) inbox migrates in place to v3 with full recovery hold; permit statements are indexed", async () => {
	const api = fakeTelegram();
	const config = cfg();
	const c = tg(config, api.base, SCALED_GATE_POLICY);
	await c.start(async () => answered("ok"));
	expect(await post(c, event(1, 71))).toBe(200);
	await until(() => c.health().done === 1, "receipt");
	await c.stop();
	inspect(config.databasePath, db => db.exec("DROP TABLE api_permits; DELETE FROM settings WHERE name LIKE 'api_%'; UPDATE metadata SET name='inbox-schema:1:telegram:731'; PRAGMA user_version=1"));
 const clock=new FakeClock(0);
	// Bound the advisory menu wait below the test budget while the migration holds ALL API starts.
	const next = telegramChannel({...config,requestTimeoutMs:100},{apiBase:api.base,gatePolicy:SCALED_GATE_POLICY,gateClock:clock});channels.push(next);
	await next.start(async () => answered("again"));
	expect(next.health()).toMatchObject({ done: 1, rows: 1 });
	expect(await post(next, event(2, 71))).toBe(200);
 expect(next.health().done).toBe(1);
 expect(api.localCalls.map(c => c.method)).toEqual(["setMyCommands", "sendMessage"]);
 expect(next.health()).toMatchObject({menu_registered:0,menu_failed:1,api_waiters:0});
 clock.t=60000; // known used ungated legacy receives the full old production horizon
 // The wall scheduler hint is only a wake hint; restart in the SAME clock frame preserves rather than resets it.
 await next.stop();
 const reopened=telegramChannel(config,{apiBase:api.base,gatePolicy:SCALED_GATE_POLICY,gateClock:clock});channels.push(reopened);await reopened.start(async()=>answered("again"));
 await clock.advance(SCALED_GATE_POLICY.botSpacingMs); // Reopened menu starts at the recovery boundary.
 expect(reopened.health().menu_registered).toBe(1);
	await until(() => reopened.health().done === 2, "gated after migration");
 await reopened.stop();
	await next.stop();
	inspect(config.databasePath, db => {
		expect(db.query("SELECT name FROM metadata").all()).toEqual([{ name: "inbox-schema:" + INBOX_SCHEMA_VERSION + ":telegram:731" }]);
		expect((db.query("PRAGMA user_version").get() as any).user_version).toBe(INBOX_SCHEMA_VERSION);
		expect((db.query("SELECT count(*) AS n FROM api_permits").get() as any).n).toBe(2); // Reopened menu + final; no permit during recovery hold.
		expect((db.query("SELECT count(*) AS n FROM api_permits WHERE kind='poll'").get() as any).n).toBe(1);
		const plan = (sql: string, ...params: unknown[]) => (db.query("EXPLAIN QUERY PLAN " + sql).all(...(params as [])) as { detail: string }[]).map(r => r.detail).join(" | ");
		expect(plan(SCHEDULER_SQL.prunePermits, 0)).toContain("INDEX api_permits_at (at<?)");
		expect(plan(SCHEDULER_SQL.permitsPage, 0, 10)).toContain("INTEGER PRIMARY KEY (rowid>?)");
	});
	expect(INBOX_SCHEMA_VERSION).toBe(7); // Native cooldown/recovery (v6) plus generic file reference fencing (v7)
});

test("gate policy injection is explicit and validated; apiBase alone never changes the policy", () => {
	expect(() => telegramChannel(cfg(), { apiBase: "http://127.0.0.1:1", gatePolicy: { ...SCALED_GATE_POLICY, chatWindowLimit: 0 } })).toThrow("Invalid Telegram channel configuration");
	expect(() => telegramChannel(cfg(), { apiBase: "http://127.0.0.1:1", gatePolicy: { ...SCALED_GATE_POLICY, maxCooldownMs: 120_000 } })).toThrow("Invalid Telegram channel configuration");
	expect(() => telegramChannel(cfg(), { apiBase: "http://127.0.0.1:1" })).not.toThrow();
});
