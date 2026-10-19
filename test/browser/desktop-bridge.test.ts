import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createPrivateFile, readPrivateFile } from "../../src/telegram-private-files/index.ts";
import { callDesktop, publishDesktopDescriptor, readDesktopDescriptor, validateDescriptor } from "../../src/plugins/browser/desktop-bridge.ts";
import { browserPlugin, hostEnvironment } from "../../src/plugins/browser/index.ts";
import { loadPlugin, type LoadedPlugin } from "../../src/plugins/types.ts";

const dirs: string[] = []; const servers: { stop(closeActiveConnections?: boolean): unknown }[] = []; const plugins: LoadedPlugin[] = [];
const token = "a".repeat(64);
afterEach(async () => { for (const p of plugins.splice(0)) await p.close?.(); for (const s of servers.splice(0)) await s.stop(true); for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
async function dir() { const d = await mkdtemp(join(import.meta.dir, ".bridge-")); dirs.push(d); return d; }
function listen(handler: (request: Request) => Response | Promise<Response>) { const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler }); servers.push(s); return s; }
function descriptor(root: string, port: number) { const path = join(root, "browser", "desktop.json"); mkdirSync(join(root, "browser"), { recursive: true }); createPrivateFile(path, JSON.stringify({ version: 1, port, token })); return path; }
async function plugin(root: string) { const p = await loadPlugin(browserPlugin, { humanize: false, hostCommand: [process.execPath, join(import.meta.dir, "../fixtures/browser-fake-host.ts"), join(root, "host.log")] }, { dataDir: root, resolveDependency: async () => undefined }); if (Array.isArray(p)) throw new Error(p.join("\n")); plugins.push(p); return p; }
async function run(p: LoadedPlugin, action: string, args = {}, signal?: AbortSignal) { return p.tools[0]!.execute({ action, args }, { channel: async () => "tui", ...(signal ? { signal } : {}) }); }
const ok = (text: string) => Response.json({ id: 0, ok: true, result: { text } });

test("strict private descriptor validation and absent-only fallback", async () => {
 const root = await dir(); expect(await callDesktop(join(root, "absent"), "status", {})).toBeUndefined();
 for (const value of [null, {}, { version: 1, port: 0, token }, { version: 2, port: 9, token }, { version: 1, port: 9.2, token }, { version: 1, port: 9, token: "short" }]) expect(() => validateDescriptor(value)).toThrow("DesktopBridgeInvalid");
 const path = join(root, "unsafe"); mkdirSync(path); await expect(callDesktop(path, "open", { url: "https://example.test" })).rejects.toThrow("DesktopBridgeInvalid");
 const malformed = join(root, "malformed"); createPrivateFile(malformed, "{bad"); expect(() => readDesktopDescriptor(malformed)).toThrow("DesktopBridgeInvalid");
});
test("browser_use prefers authenticated desktop even for status without starting own host", async () => {
 const root = await dir(); const commands: string[] = [];
 const s = listen(async (r) => { expect(r.headers.get("Authorization")).toBe(`Bearer ${token}`); const body = await r.json() as { cmd: string }; commands.push(body.cmd); return ok(`desktop ${body.cmd}`); });
 descriptor(root, s.port!); const p = await plugin(root);
 expect(p.prompt).toContain("never bypass takeover");
 expect(await run(p, "status")).toBe("desktop status"); expect(await run(p, "open", { url: "https://example.test" })).toBe("desktop open"); expect(commands).toEqual(["status", "status", "open"]); expect(existsSync(join(root, "host.log"))).toBe(false);
 await expect(run(p, "ui_import", { confirmed: true })).rejects.toThrow("unknown action"); expect(commands).toHaveLength(3);
});
test("loopback credentials bypass ambient proxies and never follow redirects", async () => {
 const root = await dir(); let proxyRequests = 0;
 const proxy = listen(() => { proxyRequests++; return ok("proxy must not see credentials"); });
 const endpoint = listen(() => ok("direct")); const path = descriptor(root, endpoint.port!);
 const names = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"];
 const previous = names.map((name) => process.env[name]);
 try {
  for (const name of names) process.env[name] = name.toLowerCase() === "no_proxy" ? "" : `http://127.0.0.1:${proxy.port}`;
  expect((await callDesktop(path, "open", { url: "https://example.test" }))?.text).toBe("direct"); expect(proxyRequests).toBe(0);
  const redirectRoot = await dir(); const redirect = listen(() => new Response(null, { status: 307, headers: { Location: `http://127.0.0.1:${proxy.port}/steal` } }));
  await expect(callDesktop(descriptor(redirectRoot, redirect.port!), "open", { url: "https://example.test" })).rejects.toThrow(); expect(proxyRequests).toBe(0);
 } finally { names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; }); }
});
test("refused safe status probe falls back to isolated host", async () => {
 const root = await dir(); const s = listen(() => ok("unused")); const port = s.port!; await s.stop(true); servers.splice(servers.indexOf(s), 1);
 descriptor(root, port); const p = await plugin(root); expect(String(await run(p, "open", { url: "https://fallback.test" }))).toContain("https://fallback.test"); expect(existsSync(join(root, "host.log"))).toBe(true);
});
test("auth rejection and human takeover errors never fall back to another browser", async () => {
 for (const mode of ["auth", "human"]) {
  const root = await dir(); const s = listen(() => mode === "auth" ? new Response("no", { status: 401 }) : Response.json({ id: 0, ok: false, error: "HumanControlActive: 사용자가 직접 조작 중입니다." }));
  descriptor(root, s.port!); const p = await plugin(root); await expect(run(p, "open", { url: "https://example.test" })).rejects.toThrow(mode === "auth" ? "HTTP 401" : "HumanControlActive"); expect(existsSync(join(root, "host.log"))).toBe(false);
 }
});
test("malformed reply after a dispatched side effect is terminal, not replayed", async () => {
 const root = await dir(); let effects = 0;
 const s = listen(async (r) => { const { cmd } = await r.json() as { cmd: string }; if (cmd === "status") return ok("ready"); effects++; return new Response("not JSON"); }); descriptor(root, s.port!);
 const p = await plugin(root); await expect(run(p, "click", { ref: "e1" })).rejects.toThrow("malformed reply"); expect(effects).toBe(1); expect(existsSync(join(root, "host.log"))).toBe(false);
});
test("cancellation propagates through desktop fetch without a local-host retry", async () => {
 const root = await dir(); let sent!: () => void; const arrived = new Promise<void>((r) => { sent = r; }); let release!: () => void; const wait = new Promise<void>((r) => { release = r; });
 const s = listen(async (r) => { const { cmd } = await r.json() as { cmd: string }; if (cmd === "status") return ok("ready"); sent(); await wait; return ok("done"); }); descriptor(root, s.port!);
 const p = await plugin(root); const controller = new AbortController(); const result = run(p, "click", { ref: "e1" }, controller.signal).then(() => "resolved", () => "aborted"); await arrived; controller.abort(); expect(await result).toBe("aborted"); release(); expect(existsSync(join(root, "host.log"))).toBe(false);
});
test("exclusive descriptor publication rejects a live owner and cleanup only deletes its own token", async () => {
 const root = await dir(); const path = join(root, "desktop.json"); const s = listen(() => ok("ready"));
 const cleanup = await publishDesktopDescriptor(JSON.stringify({ path, port: s.port!, token })); expect(JSON.parse(readPrivateFile(path, 4096))).toEqual({ version: 1, port: s.port!, token });
 await expect(publishDesktopDescriptor(JSON.stringify({ path, port: s.port!, token: "b".repeat(64) }))).rejects.toThrow("DesktopBridgeInUse"); expect(readDesktopDescriptor(path)?.token).toBe(token); cleanup(); expect(existsSync(path)).toBe(false);
 const cleanup2 = await publishDesktopDescriptor(JSON.stringify({ path, port: s.port!, token })); await rm(path); createPrivateFile(path, JSON.stringify({ version: 1, port: s.port!, token: "c".repeat(64) })); cleanup2(); expect(readDesktopDescriptor(path)?.token).toBe("c".repeat(64));
});
test("publication reclaims only a refused stale descriptor and refuses an active publication lock", async () => {
 const root = await dir(); const old = listen(() => ok("unused")); const port = old.port!; await old.stop(true); servers.splice(servers.indexOf(old), 1);
 const path = descriptor(root, port); const next = listen(() => ok("ready"));
 createPrivateFile(`${path}.publish`, "another publisher");
 await expect(publishDesktopDescriptor(JSON.stringify({ path, port: next.port!, token: "e".repeat(64) }))).rejects.toThrow("DesktopBridgeInUse");
 expect(readDesktopDescriptor(path)?.token).toBe(token); await rm(`${path}.publish`);
 const cleanup = await publishDesktopDescriptor(JSON.stringify({ path, port: next.port!, token: "e".repeat(64) })); expect(readDesktopDescriptor(path)?.token).toBe("e".repeat(64)); expect(existsSync(`${path}.publish`)).toBe(false); cleanup();
});
test("the JSONL child publishes on startup and removes its descriptor when stdin ends", async () => {
 const root = await dir(); const path = join(root, "desktop.json"); const s = listen(() => ok("ready"));
 const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../fixtures/browser-fake-host.ts"), join(root, "host.log")], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...hostEnvironment(process.env, { mode: "dedicated", browser: "chrome", profile: join(root, "profile"), userDataDir: root, humanize: false }), DINOBOT_BROWSER_DESKTOP: JSON.stringify({ path, port: s.port!, token }) } });
 try {
  proc.stdin.write(JSON.stringify({ id: 1, cmd: "status", args: {} }) + "\n"); proc.stdin.flush(); const reader = proc.stdout.getReader(); const reply = await reader.read(); reader.releaseLock(); expect(new TextDecoder().decode(reply.value)).toContain('"ok":true'); expect(readDesktopDescriptor(path)?.token).toBe(token); proc.stdin.end(); expect(await proc.exited).toBe(0); expect(existsSync(path)).toBe(false);
 } finally { proc.kill(); }
});
