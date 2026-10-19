import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext } from "patchright";
import { chromeProfiles, importChromeCookies, profileMatches } from "../../src/plugins/browser/chrome-import.ts";
import { Session, type Chromium } from "../../src/plugins/browser/host.ts";
import { fakeChromium } from "../fixtures/browser-fake-host.ts";

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
async function root(active = true) { const d = await mkdtemp(join(import.meta.dir, ".chrome-import-")); dirs.push(d); await writeFile(join(d, "Local State"), JSON.stringify({ profile: { info_cache: { Default: { name: "개인" }, "Profile 1": { name: "회사" } } } })); if (active) await writeFile(join(d, "DevToolsActivePort"), "9222\n/devtools/browser/fake\n"); return d; }
const cookie = { name: "sid", value: "synthetic-sensitive-value", domain: ".example.test", path: "/", expires: -1, session: true, secure: true, httpOnly: true, sameSite: "Lax" };
function fakeSource(actual: string, cookies: unknown[] = [cookie], fail?: "read" | "connect") {
 const log: string[] = [];
 const page = { goto: async (url: string) => { log.push(url); }, locator: (selector: string) => { log.push(selector); return { innerText: async () => actual }; }, close: async () => { log.push("temporary.close"); } };
 const context = { newPage: async () => { log.push("temporary.new"); return page; }, newCDPSession: async () => ({ send: async (method: string) => { log.push(method); if (fail === "read") throw new Error("ChromeImportBlocked: " + cookie.value); return { cookies }; }, detach: async () => { log.push("cdp.detach"); } }) };
 const chromium = { connectOverCDP: async (endpoint: string) => { log.push(endpoint); if (fail === "connect") throw new Error(cookie.value); return { contexts: () => [context], close: async () => { log.push("disconnect"); } }; } } as unknown as Chromium;
 return { chromium, log };
}
function target(received: unknown[]) { return async () => ({ addCookies: async (cookies: unknown[]) => { received.push(...cookies); } }) as unknown as BrowserContext; }

test("explicit consent and selected known profile are mandatory before any connection", async () => {
 const d = await root(); const { chromium, log } = fakeSource(join(d, "Default"));
 for (const args of [{ profile: "Default" }, { profile: "Default", confirmed: false }, { profile: "../Default", confirmed: true }, { profile: "Unknown", confirmed: true }]) await expect(importChromeCookies(d, args, chromium, target([]))).rejects.toThrow("ChromeImportBlocked");
 expect(log).toEqual([]); expect(await chromeProfiles(d)).toEqual([{ id: "Default", name: "개인" }, { id: "Profile 1", name: "회사" }]);
});
test("profile mismatch refuses cookie reads, always closes only the temporary tab and disconnects", async () => {
 const d = await root(); const { chromium, log } = fakeSource(join(d, "Profile 1")); const received: unknown[] = [];
 await expect(importChromeCookies(d, { profile: "Default", confirmed: true }, chromium, target(received))).rejects.toThrow("ChromeProfileMismatch"); expect(log).toContain("chrome://version"); expect(log).toContain("#profile_path"); expect(log).not.toContain("Storage.getCookies"); expect(log.slice(-2)).toEqual(["temporary.close", "disconnect"]); expect(received).toEqual([]);
});
test("supported decrypted CDP cookies stay in dedicated context; replies contain counts, not cookie values", async () => {
 const d = await root(); const { chromium, log } = fakeSource(join(d, "Default"), [cookie, { ...cookie, partitionKey: { topLevelSite: "https://other.test" } }, { ...cookie, expires: 1, session: false }]); const received: unknown[] = [];
 const result = await importChromeCookies(d, { profile: "Default", confirmed: true }, chromium, target(received));
 expect(result).toMatchObject({ ok: true, imported: 1, skipped: 2 }); expect(JSON.stringify(result)).not.toContain(cookie.value); expect(received).toEqual([{ name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path, expires: -1, httpOnly: true, secure: true, sameSite: "Lax" }]); expect(log).toContain("Storage.getCookies"); expect(log.slice(-3)).toEqual(["cdp.detach", "temporary.close", "disconnect"]);
});
test("disabled or blocked Chrome has no encrypted-database fallback and does not start a target", async () => {
 const d = await root(false); await writeFile(join(d, "Cookies"), "encrypted-placeholder"); const { chromium, log } = fakeSource(join(d, "Default")); let targets = 0;
 await expect(importChromeCookies(d, { profile: "Default", confirmed: true }, chromium, async () => { targets++; throw new Error("must not start"); })).rejects.toThrow("ChromeImportBlocked"); expect(log).toEqual([]); expect(targets).toBe(0);
 const active = await root(); for (const fail of ["connect", "read"] as const) { const source = fakeSource(join(active, "Default"), [cookie], fail); const message = await importChromeCookies(active, { profile: "Default", confirmed: true }, source.chromium, target([])).then(() => "unexpected", (e: Error) => e.message); expect(message).toContain("ChromeImportBlocked"); expect(message).not.toContain(cookie.value); }
});
test("target failures never echo decrypted cookies or raw browser errors", async () => {
 const d = await root(); const { chromium, log } = fakeSource(join(d, "Default"));
 const message = await importChromeCookies(d, { profile: "Default", confirmed: true }, chromium, async () => ({ addCookies: async () => { throw new Error(cookie.value); } }) as unknown as BrowserContext).then(() => "unexpected", (e: Error) => e.message); expect(message).toContain("ChromeImportBlocked"); expect(message).not.toContain(cookie.value); expect(log).toContain("disconnect");
});
test("host import lazily launches its own persistent profile and refuses import into attach mode", async () => {
 const d = await root(); const source = fakeSource(join(d, "Default")); const received: unknown[] = []; const launched: string[] = []; const base = fakeChromium((line) => launched.push(line));
 const chromium: Chromium = { ...source.chromium, launchPersistentContext: async (...args) => { const c = await base.launchPersistentContext(...args); c.addCookies = async (cookies) => { received.push(...cookies); }; return c; } };
 const config = { mode: "dedicated" as const, browser: "chrome" as const, profile: join(d, "dedicated"), userDataDir: d, humanize: false };
 const s = new Session(config, { chromium, chromeUserDataDir: d });
 try { expect((await s.run("ui_state", {})).ui?.state?.connected).toBe(false); expect(launched).toEqual([]); const reply = await s.run("ui_import", { profile: "Default", confirmed: true }); expect(reply.ui?.imported).toBe(1); expect(JSON.stringify(reply)).not.toContain(cookie.value); expect(launched.some((line) => line.startsWith(`launch ${join(d, "dedicated")}`))).toBe(true); expect(received).toHaveLength(1); } finally { await s.close(); }
 const attached = new Session({ ...config, mode: "attach" }, { chromium, chromeUserDataDir: d }); await expect(attached.run("ui_import", { profile: "Default", confirmed: true })).rejects.toThrow("ChromeImportBlocked"); await attached.close();
});
test("profile identity uses full normalized paths, not substring matches", () => {
 const d = join(import.meta.dir, "profile-root"); expect(profileMatches(join(d, "Default"), d, "Default")).toBe(true); expect(profileMatches(join(d, "Default-bad"), d, "Default")).toBe(false); expect(profileMatches(join(d, "Default"), d, "../Default")).toBe(false); expect(profileMatches(join(d, "DEFAULT"), d, "Default", "win32")).toBe(true);
});
