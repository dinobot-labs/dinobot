import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Session, type Chromium } from "../../src/plugins/browser/host.ts";
import { ACTIONS, type HostConfig } from "../../src/plugins/browser/shared.ts";
import { validateUiInput } from "../../src/plugins/browser/ui.ts";
import { fakeChromium } from "../fixtures/browser-fake-host.ts";

const dirs: string[] = []; const sessions: Session[] = [];
afterEach(async () => { for (const s of sessions.splice(0)) await s.close(); for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
async function dir() { const d = await mkdtemp(join(import.meta.dir, ".host-ui-")); dirs.push(d); return d; }
function fake(log: string[], large = false): Chromium {
 const base = fakeChromium((line) => log.push(line));
 const preparePage = (page: any) => {
  const original = page.evaluate.bind(page);
  page.evaluate = (js: string) => { if (js.includes("innerWidth")) { log.push("dimensions"); return Promise.resolve({ width: 800, height: 600 }); } return original(js); };
  page.mouse.click = async (x: number, y: number, options: unknown) => page.record(`mouse.click ${x} ${y} ${JSON.stringify(options)}`);
  page.screenshot = async (options: unknown) => { page.record(`frame ${JSON.stringify(options)}`); return large ? Buffer.alloc(2 * 1024 * 1024 + 1) : Buffer.from([255, 216, 255, 217]); };
  return page;
 };
 const prepare = (context: any) => { for (const p of context.pages()) preparePage(p); const create = context.newPage.bind(context); context.newPage = async () => preparePage(await create()); return context; };
 return {
  launchPersistentContext: async (...args: Parameters<Chromium["launchPersistentContext"]>) => prepare(await base.launchPersistentContext(...args)),
  connectOverCDP: async (endpoint: string, options?: any) => { const b = await base.connectOverCDP(endpoint, options); for (const c of b.contexts()) prepare(c); return b; },
 } as unknown as Chromium;
}
function session(root: string, log: string[], mode: HostConfig["mode"] = "dedicated", large = false) {
 const s = new Session({ mode, browser: "chrome", profile: join(root, "dedicated"), userDataDir: root, humanize: false }, { chromium: fake(log, large), chromeUserDataDir: root }); sessions.push(s); return s;
}

test("UI commands stay outside the closed agent action enum and passive reads never start Chrome", async () => {
 const root = await dir(); const log: string[] = []; const s = session(root, log);
 for (const cmd of ["ui_state", "ui_frame"]) expect((await s.run(cmd, {})).ui?.state).toMatchObject({ connected: false, current: -1, tabs: [], control: "agent" });
 expect((await s.run("ui_profiles", {})).ui?.profiles).toEqual([]);
 expect(log).toEqual([]); expect(ACTIONS.some((a) => a.startsWith("ui_"))).toBe(false);
});
test("viewport JPEG frame and real mouse/keyboard input share the same agent page", async () => {
 const root = await dir(); const log: string[] = []; const s = session(root, log);
 await s.run("open", { url: "https://example.test" });
 const result = (await s.run("ui_frame", {})).ui!;
 expect(result.state).toMatchObject({ connected: true, current: 0, width: 800, height: 600, url: "https://example.test", frame: "data:image/jpeg;base64,/9j/2Q==" });
 expect(log.some((line) => line.includes('"fullPage":false') && line.includes('"timeout":2000'))).toBe(true);
 await s.run("ui_input", { kind: "click", x: 12, y: 30 });
 await s.run("ui_input", { kind: "text", text: "직접 입력" });
 await s.run("ui_input", { kind: "key", key: "Control+A" });
 await s.run("ui_input", { kind: "wheel", dx: 0, dy: 200 });
 expect(log).toContain('page0: mouse.click 12 30 {"button":"left"}');
 expect(log).toContain('page0: type "직접 입력"'); expect(log).toContain("page0: press Control+A"); expect(log).toContain("page0: wheel 0 200");
 await expect(s.run("ui_input", { kind: "click", x: 800, y: 3 })).rejects.toThrow("outside viewport");
});
test("invalid inputs do not start Chrome and oversized frames are rejected", async () => {
 const root = await dir(); const log: string[] = []; const s = session(root, log, "dedicated", true);
 for (const args of [{ kind: "click", x: NaN, y: 0 }, { kind: "click", x: -1, y: 0 }, { kind: "click", x: 0, y: Infinity }, { kind: "text", text: "x".repeat(20001) }, { kind: "key", key: "" }, { kind: "wheel", dx: 0, dy: 10001 }, { kind: "click", x: 0, y: 0, button: "back" }]) { expect(() => validateUiInput(args)).toThrow("InvalidArguments"); await expect(s.run("ui_input", args)).rejects.toThrow("InvalidArguments"); }
 expect(log).toEqual([]); await s.run("open", { url: "https://example.test" }); await expect(s.run("ui_frame", {})).rejects.toThrow("BrowserFrameTooLarge");
});
test("attached desktop frames and inputs never expose or control existing user tabs", async () => {
 const root = await dir(); await writeFile(join(root, "DevToolsActivePort"), "9222\n/devtools/browser/fake\n");
 const log: string[] = []; const s = session(root, log, "attach");
 await s.run("open", { url: "https://agent.test" });
 expect((await s.run("ui_state", {})).ui?.state?.tabs).toEqual([{ index: 2, owned: true, title: "Fake Page", url: "https://agent.test" }]);
 await s.run("tab", { index: 0 }); log.length = 0;
 const state = (await s.run("ui_frame", {})).ui?.state; expect(state).toMatchObject({ current: -1, url: "", title: "" }); expect(state?.frame).toBeUndefined();
 await expect(s.run("ui_input", { kind: "text", text: "secret" })).rejects.toThrow("NotOwnTab"); expect(log).toEqual([]);
});
test("profile discovery is passive and returns only labels and IDs, not email fields", async () => {
 const root = await dir(); await mkdir(join(root, "Default"));
 await writeFile(join(root, "Local State"), JSON.stringify({ profile: { info_cache: { Default: { name: "회사", user_name: "private@example.test", gaia_name: "private" }, "Profile 1": { name: "private@example.test" }, "../bad": { name: "bad" } } } }));
 const log: string[] = []; const s = session(root, log);
 expect((await s.run("ui_profiles", {})).ui?.profiles).toEqual([{ id: "Default", name: "회사" }, { id: "Profile 1", name: "Profile 1" }]); expect(log).toEqual([]);
 await expect(s.run("ui_import", { profile: "Default" })).rejects.toThrow("ChromeImportBlocked"); expect(log).toEqual([]);
});
