import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { telegramChannel, type TelegramConfig } from "../src/channels/telegram.ts";
import type { MessagingChannel } from "../src/channels/messaging.ts";
import { telegramMenu } from "../src/channels/telegram-menu.ts";
import { ApiGate } from "../src/channels/api-gate.ts";
import { createPrivateFile } from "../src/telegram-private-files/index.ts";
import { memoryStore } from "./fixtures/issuance.ts";
import { SCALED_GATE_POLICY } from "./fixtures/gate-policy.ts";

const dirs: string[] = [], channels: MessagingChannel[] = [], servers: ReturnType<typeof Bun.serve>[] = [];
process.env.MENU_TOKEN = "123:fake_menu_token";
process.env.MENU_SECRET = "menu_secret";
afterEach(async () => { for (const c of channels.splice(0)) await c.stop(); for (const s of servers.splice(0)) await s.stop(true); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const answer = async () => ({ status: "answered" as const, text: "reply" });
function config(mode: "webhook" | "polling", timeout = 1000): TelegramConfig {
 const dir = mkdtempSync(join(tmpdir(), "tg-menu-")); dirs.push(dir);
 return { mode, botTokenEnv: "MENU_TOKEN", webhookSecretEnv: "MENU_SECRET", port: 0, requestTimeoutMs: timeout, progress: "off", databasePath: join(dir, "queue.db"), allowedUserIds: ["7"], allowedChatIds: ["7"] };
}
async function until(f: () => boolean) { const end = Date.now() + 3000; while (!f()) { if (Date.now() > end) throw new Error("condition timeout"); await Bun.sleep(5); } }
function platform(menu: () => Response | Promise<Response> = () => Response.json({ ok: true, result: true })) {
 const calls: { method: string; body: any; at: number }[] = [];
 const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  const method = new URL(req.url).pathname.split("/").at(-1)!;
  calls.push({ method, body: await req.json(), at: Date.now() });
  if (method === "setMyCommands") return menu();
  if (method === "getWebhookInfo") return Response.json({ ok: true, result: { url: "" } });
  if (method === "getUpdates") return Response.json({ ok: true, result: [] });
  return Response.json({ ok: true, result: true });
 } }); servers.push(server); return { base: server.url.origin, calls };
}
function channel(cfg: TelegramConfig, base: string) { const c = telegramChannel(cfg, { apiBase: base, gatePolicy: SCALED_GATE_POLICY }); channels.push(c); return c; }
const payload = { commands: [
 { command: "new", description: "Start a new conversation in this topic" },
 { command: "models", description: "List available models: /models [provider] [page]" },
 { command: "model", description: "Show or select this topic’s model: /model [provider/modelId]" },
], scope: { type: "default" }, language_code: "" };

for (const mode of ["polling", "webhook"] as const) test("menu payload, one registration per lifecycle, gate ownership and advisory authorization: " + mode, async () => {
 const p = platform(), cfg = config(mode), c = channel(cfg, p.base); let handled = 0;
 await c.start(async () => { handled++; return answer(); });
 expect(p.calls.filter(x => x.method === "setMyCommands").map(x => x.body)).toEqual([payload]);
 expect(c.health()).toMatchObject({ menu_registered: 1, menu_failed: 0, running: 1 });
 if (mode === "polling") { await until(() => p.calls.some(x => x.method === "getUpdates")); expect(p.calls.slice(0,3).map(x => x.method)).toEqual(["getWebhookInfo", "setMyCommands", "getUpdates"]); }
 else {
  const health = await fetch(new URL("/healthz", c.url())); expect(await health.json()).toMatchObject({ menu_registered: 1 });
  const rejected = await fetch(new URL("/webhook", c.url()), { method: "POST", headers: { "x-telegram-bot-api-secret-token": "menu_secret" }, body: JSON.stringify({ update_id: 1, message: { message_id: 1, from: { id: 8, is_bot: false }, chat: { id: 7 }, text: "/new" } }) });
  expect(rejected.status).toBe(403); expect(handled).toBe(0);
 }
 await expect(c.start(answer)).rejects.toThrow("already started");
 expect(p.calls.filter(x => x.method === "setMyCommands")).toHaveLength(1);
 await c.stop();
 const db = new Database(cfg.databasePath);
 try { const permits = db.query("SELECT kind, rate_key FROM api_permits ORDER BY seq").all(); expect(permits).toHaveLength(p.calls.length); expect(permits.every((x: any) => x.kind === "poll" && x.rate_key === null)).toBe(true); } finally { db.close(); }
 await c.start(answer); expect(p.calls.filter(x => x.method === "setMyCommands")).toHaveLength(2);
});

test("integration model controls disabled keeps only new and clears old model entries", async () => {
 const p = platform(), c = channel(config("webhook"), p.base);
 await c.start(answer, undefined, { modelControls: false });
 expect(p.calls[0]!.body).toEqual({ ...payload, commands: [payload.commands[0]] });
});

for (const mode of ["webhook", "polling"] as const) for (const error of ["http", "body-false", "result-false", "invalid-json", "oversized", "timeout", "stalled-body"] as const) test("best-effort menu " + error + " remains usable and redacted: " + mode, async () => {
 const p = platform(() => {
  if (error === "http") return new Response("123:fake_menu_token", { status: 503 });
  if (error === "body-false") return Response.json({ ok: false, description: "123:fake_menu_token" });
  if (error === "result-false") return Response.json({ ok: true, result: false });
  if (error === "invalid-json") return new Response("not json");
  if (error === "oversized") return new Response("x".repeat(16385));
  if (error === "stalled-body") return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("{")); }, cancel() {} }));
  return new Promise(resolve => setTimeout(() => resolve(Response.json({ ok: true, result: true })), 200));
 });
 const c = channel(config(mode, 50), p.base); const start = Date.now();
 await c.start(answer); expect(Date.now() - start).toBeLessThan(1000);
 expect(c.health()).toMatchObject({ menu_registered: 0, menu_failed: 1, running: 1 });
 expect(JSON.stringify(c.health())).not.toContain("fake_menu_token");
 if (mode === "polling") await until(() => p.calls.some(x => x.method === "getUpdates"));
 else expect((await fetch(new URL("/healthz", c.url()))).status).toBe(200);
 await Bun.sleep(60); expect(p.calls.filter(x => x.method === "setMyCommands")).toHaveLength(1);
});

for (const phase of ["network", "permit"] as const) test("stop during menu " + phase + " cancels and drains startup without late requests", async () => {
 const p = platform(() => new Promise(resolve => setTimeout(() => resolve(Response.json({ ok: true, result: true })), 500)));
 const c = channel(config("webhook", 1000), p.base);
 if (phase === "permit") {
  // Seed a durable shared 429 cooldown before reopening the channel.
  const seed = platform(() => Response.json({ ok: false, error_code: 429, parameters: { retry_after: 1 } }));
  const cfg = config("webhook", 1000), first = channel(cfg, seed.base); await first.start(answer); await first.stop();
  const waiting = channel(cfg, p.base), starting = waiting.start(answer); await Bun.sleep(20);
  const stopped = waiting.stop(); await expect(starting).rejects.toThrow("stopped"); await stopped;
  expect(p.calls).toEqual([]); await Bun.sleep(60); expect(p.calls).toEqual([]); return;
 }
 const starting = c.start(answer); await until(() => p.calls.length === 1);
 const before = Date.now(), stopped = c.stop(); await expect(starting).rejects.toThrow("stopped"); await stopped;
 expect(Date.now() - before).toBeLessThan(250); expect(c.health().running).toBe(0);
 await Bun.sleep(60); expect(p.calls).toHaveLength(1);
});

for (const bodyOnly of [false, true]) test("menu 429 header/body cooldown reaches shared gate, no retry: " + bodyOnly, async () => {
 const p = platform(() => Response.json({ ok: false, error_code: 429, parameters: { retry_after: 0.15 } }, { status: bodyOnly ? 200 : 429, headers: { "retry-after": "0.05" } }));
 const c = channel(config("polling"), p.base); await c.start(answer); await until(() => p.calls.some(x => x.method === "getUpdates"));
 const menu = p.calls.find(x => x.method === "setMyCommands")!, poll = p.calls.find(x => x.method === "getUpdates")!;
 expect(poll.at - menu.at).toBeGreaterThanOrEqual(140); expect(c.health().menu_failed).toBe(1); expect(p.calls.filter(x => x.method === "setMyCommands")).toHaveLength(1);
});

test("bounded permit wait skips menu without issuing and drains its waiter", async () => {
 const p = platform(), gate = new ApiGate(SCALED_GATE_POLICY, memoryStore().store, { records: [], lastSeq: 0 }); gate.rateLimited(1000);
 const menu = telegramMenu(p.base, 25, () => true);
 try { await menu.startup(new AbortController().signal, gate); expect(menu.health()).toEqual({ menu_registered: 0, menu_failed: 1 }); expect(p.calls).toEqual([]); } finally { gate.close(); }
});

test("CLI sidecar real channel registers menu once through the shared startup hook", async () => {
 const p = platform(), cfg = config("polling"), dir = dirs.at(-1)!;
 const token = join(dir, "token"), pair = join(dir, "pair");
 createPrivateFile(token, "123:fake_menu_token"); createPrivateFile(pair, JSON.stringify({ botId: "123", userId: "7", chatIds: ["7"] }));
 const args = ["--token-file", token, "--pairing-file", pair, "--database", cfg.databasePath];
 const script = [
  "import { runTelegramChannel } from " + JSON.stringify(new URL("../src/cli/telegram-run.ts", import.meta.url).href) + ";",
  "import { telegramChannel } from " + JSON.stringify(new URL("../src/channels/telegram.ts", import.meta.url).href) + ";",
  "await runTelegramChannel(" + JSON.stringify(args) + ", config => { const c = telegramChannel(config, { apiBase: " + JSON.stringify(p.base) + ", gatePolicy: " + JSON.stringify(SCALED_GATE_POLICY) + " }); return { ...c, async start(handler) { await c.start(handler); process.emit('SIGTERM'); } }; });",
 ].join(String.fromCharCode(10));
 const child = Bun.spawn([process.execPath, "--no-env-file", "--eval", script], { stdout: "pipe", stderr: "pipe" });
 const safety = setTimeout(() => child.kill("SIGKILL"), 4000);
 try { const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]); expect(err).toBe(""); expect(code).toBe(0); expect(p.calls.filter(x => x.method === "setMyCommands").map(x => x.body)).toEqual([payload]); }
 finally { clearTimeout(safety); if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; }
});


test("menu cancellation owns noncooperative raw fetch and body cancellation until settlement", async () => {
 const rawFetch = globalThis.fetch, abort = new AbortController();
 let releaseRaw!: (r: Response) => void, releaseBody!: () => void, cancellations = 0, finished = false;
 const raw = new Promise<Response>(r => { releaseRaw = r; });
 const cancelled = new Promise<void>(r => { releaseBody = r; });
 globalThis.fetch = Object.assign(() => raw, { preconnect: rawFetch.preconnect });
 const menu = telegramMenu("http://menu.invalid", 1000, () => true);
 const running = menu.startup(abort.signal).then(() => { finished = true; });
 try {
  abort.abort(); await Bun.sleep(10); expect(finished).toBe(false);
  releaseRaw(new Response(new ReadableStream({ cancel() { cancellations++; return cancelled; } })));
  await until(() => cancellations === 1); expect(finished).toBe(false);
  releaseBody(); await running; expect(menu.health().menu_failed).toBe(1);
 } finally { releaseRaw(Response.json({ ok: true, result: true })); releaseBody(); await running; globalThis.fetch = rawFetch; }
});

test("network exception and pre-aborted menu never leak errors or issue late requests", async () => {
 const rawFetch = globalThis.fetch; let calls = 0;
 globalThis.fetch = Object.assign((() => { calls++; throw new Error("https://api.telegram.org/bot123:fake_menu_token/private"); }), { preconnect: rawFetch.preconnect });
 try {
  const menu = telegramMenu("http://menu.invalid", 100, () => true); await expect(menu.startup(new AbortController().signal)).resolves.toBeUndefined();
  const abort = new AbortController(); abort.abort(); await menu.startup(abort.signal);
  expect(calls).toBe(1); expect(menu.health()).toEqual({ menu_registered: 0, menu_failed: 1 });
 } finally { globalThis.fetch = rawFetch; }
});
