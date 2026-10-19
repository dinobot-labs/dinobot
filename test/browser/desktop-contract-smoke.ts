/** Opt-in cross-repository proof. DESKTOP_BROWSER_SOURCE_ROOT points at apps/desktop/src. */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { callDesktop } from "../../src/plugins/browser/desktop-bridge.ts";
import { hostEnvironment } from "../../src/plugins/browser/index.ts";

const source = process.env.DESKTOP_BROWSER_SOURCE_ROOT;
assert(source, "DESKTOP_BROWSER_SOURCE_ROOT must point at the desktop source directory");
const moduleAt = (file: string) => pathToFileURL(join(resolve(source), "features/browser", file)).href;
const { BrowserController } = await import(moduleAt("controller.ts"));
const { JsonlBrowserHost } = await import(moduleAt("process.ts"));
const { startBrowserServer } = await import(moduleAt("server.ts"));
const root = await mkdtemp(join(import.meta.dir, ".desktop-contract-")); const path = join(root, "desktop.json");
const page = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response('<html><head><title>Desktop contract</title></head><body style="margin:0"><input style="height:30px;width:200px" id="name"></body></html>', { headers: { "Content-Type": "text/html" } }) });
let endpoint: { port: number; token: string; close(): Promise<void> };
const transport = new JsonlBrowserHost(async () => ({ file: process.execPath, script: join(import.meta.dir, "headless-host.ts"), env: { ...hostEnvironment(process.env, { mode: "dedicated", browser: "chrome", profile: join(root, "profile"), userDataDir: join(root, "unused-source"), humanize: false }), DINOBOT_BROWSER_DESKTOP: JSON.stringify({ path, port: endpoint.port, token: endpoint.token }) } }));
const controller = new BrowserController(transport);
endpoint = await startBrowserServer(controller);
try {
 const idle = await controller.ui("state", {}); assert.equal(idle.ok, true); assert.equal(idle.state.connected, false); assert(existsSync(path));
 assert((await callDesktop(path, "status", {}))?.text.includes("not started"));
 await callDesktop(path, "open", { url: `http://127.0.0.1:${page.port}/` });
 const frame = await controller.ui("frame", {}); assert.equal(frame.ok, true); assert.equal(frame.state.width, 800); assert(frame.state.frame.startsWith("data:image/jpeg;base64,"));
 const user = await controller.ui("takeover", {}); assert.equal(user.ok, true); assert.equal(user.state.control, "user");
 await assert.rejects(callDesktop(path, "click", { selector: "input" }), /UserControl/);
 assert.equal((await controller.ui("input", { kind: "click", x: 20, y: 15 })).ok, true);
 assert.equal((await controller.ui("input", { kind: "text", text: "desktop user input" })).ok, true);
 assert.equal((await controller.ui("resume", {})).state.control, "agent");
 assert.equal((await callDesktop(path, "eval", { js: 'document.querySelector("#name").value' }))?.text, '"desktop user input"');
 await controller.close(); assert.equal(existsSync(path), false);
 console.log("PASS desktop controller/server + JSONL host + browser_use desktop bridge: authenticated navigation, JPEG frame, exclusive human takeover, direct input, agent resume, private descriptor cleanup");
} finally { await controller.close(); await endpoint.close(); await page.stop(true); await rm(root, { recursive: true, force: true }); }
