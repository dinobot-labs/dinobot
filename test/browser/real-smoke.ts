/** Opt-in isolated Chrome smoke: bun test/browser/real-smoke.ts. Never opens the user profile. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type BrowserContext } from "patchright";
import { Session, type Chromium } from "../../src/plugins/browser/host.ts";
import { chromeProfiles } from "../../src/plugins/browser/chrome-import.ts";

const root = await mkdtemp(join(import.meta.dir, ".real-smoke-"));
const sourcePath = join(root, "source"); const targetPath = join(root, "target");
let target: BrowserContext | undefined; let source: BrowserContext | undefined;
const driver = {
 launchPersistentContext: async (path: string, options: Parameters<Chromium["launchPersistentContext"]>[1]) => { target = await chromium.launchPersistentContext(path, { ...options, channel: "chrome", headless: true, viewport: { width: 800, height: 600 } }); return target; },
 connectOverCDP: chromium.connectOverCDP.bind(chromium),
} as Chromium;
const s = new Session({ mode: "dedicated", browser: "chrome", profile: targetPath, userDataDir: sourcePath, humanize: false }, { chromium: driver, chromeUserDataDir: sourcePath });
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response('<html><head><title>Isolated browser proof</title></head><body style="margin:0;height:2000px"><input id="name" style="position:absolute;left:0;top:0;width:200px;height:30px"><button style="position:absolute;left:0;top:50px;width:200px;height:40px" onclick="document.title=\'clicked\'">Click</button></body></html>', { headers: { "Content-Type": "text/html" } }) });
try {
 assert.equal((await s.run("ui_state", {})).ui?.state?.connected, false);
 await s.run("open", { url: `http://127.0.0.1:${server.port}/` });
 const frame = (await s.run("ui_frame", {})).ui?.state;
 assert.equal(frame?.width, 800); assert.equal(frame?.height, 600);
 const dataUrl = frame?.frame; assert(dataUrl); assert(dataUrl.startsWith("data:image/jpeg;base64,"));
 const jpeg = Buffer.from(dataUrl.split(",")[1]!, "base64"); assert.equal(jpeg.readUInt16BE(0), 0xffd8);
 await s.run("ui_input", { kind: "click", x: 20, y: 15 }); await s.run("ui_input", { kind: "text", text: "isolated input" });
 assert.equal((await s.run("eval", { js: "document.querySelector(\"#name\").value" })).text, '"isolated input"');
 await s.run("ui_input", { kind: "key", key: "Control+A" }); await s.run("ui_input", { kind: "text", text: "replaced" });
 assert.equal((await s.run("eval", { js: "document.querySelector(\"#name\").value" })).text, '"replaced"');
 await s.run("ui_input", { kind: "click", x: 20, y: 65 }); assert.equal((await s.run("ui_state", {})).ui?.state?.title, "clicked");
 await s.run("ui_input", { kind: "wheel", dx: 0, dy: 100 });
 await s.run("eval", { js: 'alert("isolated dialog")' }); assert.equal((await s.run("ui_state", {})).ui?.state?.dialog?.message, "isolated dialog");
 await s.run("dialog", { accept: true }); assert.equal((await s.run("ui_state", {})).ui?.state?.dialog, undefined);
 source = await chromium.launchPersistentContext(sourcePath, { channel: "chrome", headless: true, args: ["--remote-debugging-port=0"], viewport: { width: 800, height: 600 } });
 await source.addCookies([{ name: "fixture", value: "synthetic-only", domain: "example.test", path: "/", secure: true, httpOnly: true, expires: Math.floor(Date.now() / 1000) + 86400 }]);
 await source.close();
 source = await chromium.launchPersistentContext(sourcePath, { channel: "chrome", headless: true, args: ["--remote-debugging-port=0"], viewport: { width: 800, height: 600 } });
 assert((await chromeProfiles(sourcePath)).some((p) => p.id === "Default"));
 const imported = await s.run("ui_import", { profile: "Default", confirmed: true }); assert.equal(imported.ui?.imported, 1); assert(!JSON.stringify(imported).includes("synthetic-only"));
 assert.equal((await target!.cookies("https://example.test"))[0]?.value, "synthetic-only");
 assert.equal(source.pages().length, 1); // The import helper closed only its chrome://version tab.
 await s.close();
 const reopened = await chromium.launchPersistentContext(targetPath, { channel: "chrome", headless: true });
 try { assert.equal((await reopened.cookies("https://example.test"))[0]?.value, "synthetic-only"); } finally { await reopened.close(); }
 console.log("PASS isolated Chrome: passive state, viewport JPEG, mouse/text/key/wheel, CDP profile proof/import and persistent target cookie");
} finally { await s.close(); await source?.close(); await server.stop(true); await rm(root, { recursive: true, force: true }); }
