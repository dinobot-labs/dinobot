import { createPrivateFile, readPrivateFile } from "../src/telegram-private-files/index.ts";
import { afterEach, describe, expect, test, spyOn } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync, writeFileSync, readFileSync, statSync, existsSync, rmSync, symlinkSync, readdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTelegramSetup, type TelegramSetupDependencies } from "../src/cli/telegram-setup.ts";

const token = "123456:FAKE_credential_for_offline_tests_only";
const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
 const dir = mkdtempSync(join(tmpdir(), "telegram-setup-test-")); directories.push(dir);
 const tokenPath = join(dir, "token"), pairingPath = join(dir, "pairing.json");
 createPrivateFile(tokenPath, token);
 const lines: string[] = [], calls: { method: string; body: Record<string, unknown>; init: RequestInit }[] = [];
 let time = 0, code = "", batch = 0;
 const state = { webhook: "", updates: (_batch: number, _code: string): unknown[] => [], broken: false };
 const deps: TelegramSetupDependencies = { now: () => time, sleep: async ms => { time += ms; }, output: line => { lines.push(line); const match = /[?]start=([A-Za-z0-9_-]+)/.exec(line); if (match) code = match[1]!; },
  fetch: async (url, init) => {
   if (state.broken) throw new Error(url + token);
   const parsed = new URL(url), method = parsed.pathname.split("/").pop()!;
   const body = init.method === "GET" ? Object.fromEntries([...parsed.searchParams].map(([key, value]) => [key, JSON.parse(value)])) : JSON.parse(String(init.body));
   calls.push({ method, body, init });
   const result = method === "getMe" ? { id: 123456, is_bot: true, username: "FauxSetupBot" } : method === "getWebhookInfo" ? { url: state.webhook } : state.updates(batch++, code);
   return Response.json({ ok: true, result });
  },
 };
 const args = ["connect", "--token-file", tokenPath, "--pairing-file", pairingPath, "--timeout-seconds", "1"];
 return { dir, tokenPath, pairingPath, lines, calls, deps, args, state };
}
function update(id: number, text: string, overrides: Record<string, unknown> = {}) { return { update_id: id, message: { from: { id: 42, is_bot: false }, chat: { id: 42, type: "private" }, text, ...overrides } }; }
describe("Telegram setup (offline only)", () => {
 test("correct nonce publishes private pairing and exact secret-free snippet", async () => {
  const f = fixture(); f.state.updates = (_, code) => [update(5, "/start " + code)];
  await runTelegramSetup(f.args, f.deps);
  expect(JSON.parse(readFileSync(f.pairingPath, "utf8"))).toEqual({ botId: "123456", userId: "42", chatIds: ["42"] });
  expect(JSON.parse(readPrivateFile(f.pairingPath, 65536)).userId).toBe("42");
  if (process.platform !== "win32") expect(statSync(f.pairingPath).mode & 0o777).toBe(0o600);
  expect(readdirSync(f.dir).sort()).toEqual(["pairing.json", "token"]);
  expect(f.lines.join("\n")).not.toContain(token);
  expect(f.lines.at(-1)).toBe("channels:\n  telegram:\n    mode: polling\n    botTokenFile: " + JSON.stringify(f.tokenPath) + "\n    pairingPath: " + JSON.stringify(f.pairingPath) + "\n    databasePath: " + JSON.stringify(f.pairingPath + ".sqlite") + "\n    port: 0");
  expect(f.calls.map(c => c.method)).toEqual(["getMe", "getWebhookInfo", "getUpdates", "getUpdates"]);
  expect(f.calls.every(c => c.init.method === (c.method === "getUpdates" ? "GET" : "POST") && c.init.signal && c.init.redirect === "error")).toBe(true);
  expect(f.lines[1]!.split("start=")[1]!.length).toBeGreaterThanOrEqual(22);
 });
 test("malicious first user is ignored; cursor advances only through examined updates", async () => {
  const f = fixture(); f.state.updates = (batch, code) => batch === 0 ? [update(9, "/start stranger"), update(4, "/start")] : [update(8, "/start " + code, { from: { id: 99, is_bot: false }, chat: { id: 99, type: "private" } }), update(10, "/start " + code), update(99, "later")];
  await runTelegramSetup(f.args, f.deps);
  expect(f.calls.filter(c => c.method === "getUpdates").map(c => c.body.offset)).toEqual([0, 10, 11]);
  expect(JSON.parse(readFileSync(f.pairingPath, "utf8")).userId).toBe("42");
  expect(JSON.stringify(f.calls)).not.toContain("drop_pending_updates");
 });
 for (const [name, overrides] of Object.entries({ mismatch: { chat: { id: 43, type: "private" } }, group: { chat: { id: 42, type: "group" } }, bot: { from: { id: 42, is_bot: true } }, forward: { forward_origin: {} }, legacyForward: { forward_date: 1 }, viaBot: { via_bot: {} }, senderChat: { sender_chat: {} } })) {
  test(name + " cannot claim even with correct nonce", async () => {
   const f = fixture(); f.state.updates = (batch, code) => [update(batch, "/start " + code, overrides)];
   await expect(runTelegramSetup(f.args, f.deps)).rejects.toThrow("timed out"); expect(existsSync(f.pairingPath)).toBe(false);
  });
 }
 test("timeout does not persist and each attempt has a fresh nonce", async () => {
  const a = fixture(), b = fixture();
  await expect(runTelegramSetup(a.args, a.deps)).rejects.toThrow("timed out");
  await expect(runTelegramSetup(b.args, b.deps)).rejects.toThrow("timed out");
  expect(a.lines[1]).not.toBe(b.lines[1]); expect(existsSync(a.pairingPath)).toBe(false);
 });
 test("webhook conflict is rejected without deletion or polling", async () => {
  const f = fixture(); f.state.webhook = "https://example.invalid/hook";
  await expect(runTelegramSetup(f.args, f.deps)).rejects.toThrow("webhook is configured");
  expect(f.calls.map(c => c.method)).toEqual(["getMe", "getWebhookInfo"]); expect(f.lines).toEqual([]);
 });
 test("network errors never disclose credential URLs", async () => {
  const f = fixture(); f.state.broken = true;
  await expect(runTelegramSetup(f.args, f.deps)).rejects.toThrow("Telegram API request failed or timed out."); expect(f.lines).toEqual([]);
 });
 test("existing owner is never overwritten", async () => {
  const f = fixture(); writeFileSync(f.pairingPath, "existing owner");
  await expect(runTelegramSetup(f.args, f.deps)).rejects.toThrow("already exists"); expect(f.calls).toEqual([]); expect(readFileSync(f.pairingPath, "utf8")).toBe("existing owner");
 });
 test.skipIf(process.platform === "win32")("symlink owner is never overwritten", async () => {
  const f = fixture(); symlinkSync(join(f.dir, "missing"), f.pairingPath);
  await expect(runTelegramSetup(f.args, f.deps)).rejects.toThrow("already exists");
 });
 test("racing owner wins without overwrite", async () => {
  const f = fixture(); f.state.updates = (_, code) => { writeFileSync(f.pairingPath, "concurrent owner"); return [update(1, "/start " + code)]; };
  await expect(runTelegramSetup(f.args, f.deps)).rejects.toThrow("already exists"); expect(readFileSync(f.pairingPath, "utf8")).toBe("concurrent owner"); expect(readdirSync(f.dir).length).toBe(2);
 });
 test("invalid token, unreadable path, positional token and reset fail safely", async () => {
  const f = fixture(); writeFileSync(f.tokenPath, "not a credential");
  await expect(runTelegramSetup(f.args, f.deps)).rejects.toThrow("invalid credential format"); rmSync(f.tokenPath);
  await expect(runTelegramSetup(f.args, f.deps)).rejects.toThrow("readable");
  for (const args of [["connect", token], [...f.args, "--reset"], [...f.args, "--token", token]]) await expect(runTelegramSetup(args, f.deps)).rejects.toThrow("Usage:");
  expect(f.calls).toEqual([]);
 });
 test("non-ASCII wrong nonce cannot abort pairing", async () => {
  const f = fixture(); f.state.updates = (_, code) => [update(1, "/start " + "é".repeat(code.length)), update(2, "/start " + code)];
  await runTelegramSetup(f.args, f.deps); expect(existsSync(f.pairingPath)).toBe(true);
 });
 test("getMe rejects invalid identity and oversized API responses", async () => {
  for (const result of [{ id: 555, is_bot: true, username: "FauxSetupBot" }, { id: 123456, is_bot: false, username: "FauxSetupBot" }, { id: 123456, is_bot: true, username: "bad/name" }]) {
   const f = fixture(); f.deps.fetch = async () => Response.json({ ok: true, result });
   await expect(runTelegramSetup(f.args, f.deps)).rejects.toThrow("invalid bot identity"); expect(f.lines).toEqual([]);
  }
  const f = fixture(); f.deps.fetch = async () => new Response("x".repeat(262145));
  await expect(runTelegramSetup(f.args, f.deps)).rejects.toThrow("exceeds the setup limit");
 });
 test("hanging HTTP is aborted within the overall deadline", async () => {
  const f = fixture(); delete f.deps.now;
  let aborted = false; f.deps.fetch = async (_url, init) => new Promise((_resolve, reject) => {
   init.signal!.addEventListener("abort", () => { aborted = true; reject(new Error(token)); }, { once: true });
  });
  await expect(runTelegramSetup(f.args, f.deps)).rejects.toThrow("failed or timed out"); expect(aborted).toBe(true); expect(existsSync(f.pairingPath)).toBe(false);
 });
 test.skipIf(process.platform === "win32")("file and parent directory are synced before final confirmation", async () => {
  const f = fixture(), events: string[] = [];
  const sync = fs.fsyncSync;
  const spy = spyOn(fs, "fsyncSync").mockImplementation(fd => { events.push(fs.fstatSync(fd).isDirectory() ? "directory" : "file"); sync(fd); });
  f.state.updates = (batch, code) => { if (batch) events.push("confirm"); return [update(5, "/start " + code)]; };
  try { await runTelegramSetup(f.args, f.deps); expect(events).toEqual(["file", "directory", "confirm"]); }
  finally { spy.mockRestore(); }
 });
 test("final confirmation has a bounded abort and retains published owner", async () => {
  const f = fixture(); f.state.updates = (_, code) => [update(5, "/start " + code)];
  const http = f.deps.fetch!, original = globalThis.setTimeout;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((fn: (...args: any[]) => void, ms?: number, ...values: any[]) => original(fn, ms === 15000 ? 20 : ms, ...values)) as typeof setTimeout);
  let aborted = false;
  f.deps.fetch = async (url, init) => {
   if (new URL(url).searchParams.get("limit") === "1") return new Promise((_resolve, reject) => {
    init.signal!.addEventListener("abort", () => { aborted = true; reject(new Error(token)); }, { once: true });
   });
   return http(url, init);
  };
  try { await runTelegramSetup(f.args, f.deps); expect(aborted).toBe(true); expect(existsSync(f.pairingPath)).toBe(true); expect(f.lines.join("\n")).toContain("Warning:"); }
  finally { timer.mockRestore(); }
 });
 test("confirmation follows publication and never acknowledges tail updates", async () => {
  const f = fixture();
  f.state.updates = (batch, code) => {
   if (batch === 0) return [update(5, "/start " + code), update(50, "tail")];
   expect(JSON.parse(readFileSync(f.pairingPath, "utf8")).userId).toBe("42");
   return [update(50, "tail")];
  };
  await runTelegramSetup(f.args, f.deps);
  expect(f.calls.filter(c => c.method === "getUpdates").map(c => c.body)).toEqual([
   { offset: 0, limit: 100, timeout: 1, allowed_updates: ["message"] },
   { offset: 6, limit: 1, timeout: 0, allowed_updates: ["message"] },
  ]);
 });
 test("failed final acknowledgment retains owner and warns truthfully without secrets or retry", async () => {
  const f = fixture();
  f.state.updates = (batch, code) => { if (batch) throw new Error(token); return [update(5, "/start " + code)]; };
  await runTelegramSetup(f.args, f.deps);
  expect(existsSync(f.pairingPath)).toBe(true);
  expect(f.calls.filter(c => c.method === "getUpdates")).toHaveLength(2);
  expect(f.lines.join("\n")).toContain("Warning:");
  expect(f.lines.join("\n")).not.toContain("no owner was saved");
  expect(f.lines.join("\n")).not.toContain(token);
 });
 test.skipIf(process.platform === "win32")("token group or other permissions are rejected without chmod", async () => {
  for (const mode of [0o640, 0o604, 0o610, 0o601]) {
   const f = fixture(); chmodSync(f.tokenPath, mode);
   await expect(runTelegramSetup(f.args, f.deps)).rejects.toThrow("permissions");
   expect(statSync(f.tokenPath).mode & 0o777).toBe(mode); expect(f.calls).toEqual([]);
  }
 });
 test("connect help supports main dispatch without touching files", async () => {
  const f = fixture(); await runTelegramSetup(["connect", "--help"], f.deps);
  expect(f.lines).toHaveLength(1); expect(f.lines[0]).toContain("Usage:"); expect(f.calls).toEqual([]);
 });
 test("oversized and HTTP error response bodies are canceled", async () => {
  for (const status of [200, 500]) {
   const f = fixture(); let canceled = false;
   f.deps.fetch = async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(262145)); }, cancel() { canceled = true; } }), { status });
   await expect(runTelegramSetup(f.args, f.deps)).rejects.toThrow(); expect(canceled).toBe(true);
  }
 });
 test("expired matching response cannot publish owner", async () => {
  const f = fixture(); let time = 0; f.deps.now = () => time;
  f.state.updates = (_, code) => { time = 1001; return [update(5, "/start " + code)]; };
  await expect(runTelegramSetup(f.args, f.deps)).rejects.toThrow("no owner was saved"); expect(existsSync(f.pairingPath)).toBe(false);
 });
 test("timeout range is enforced", async () => {
  const f = fixture(); for (const value of ["0", "901", "1.5", "NaN"]) await expect(runTelegramSetup([...f.args.slice(0, -1), value], f.deps)).rejects.toThrow("Timeout must");
 });
});
