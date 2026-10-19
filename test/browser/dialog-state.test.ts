import { expect, test } from "bun:test";
import { Session, type Chromium } from "../../src/plugins/browser/host.ts";
import { fakeChromium } from "../fixtures/browser-fake-host.ts";

test("open JS dialogs remain visible to desktop state without evaluating or screenshotting blocked pages", async () => {
 const log: string[] = []; let measurements = 0;
 const base = fakeChromium((line) => log.push(line));
 const chromium = { ...base, launchPersistentContext: async (...args: Parameters<Chromium["launchPersistentContext"]>) => { const c = await base.launchPersistentContext(...args); for (const page of c.pages()) { const evaluate = page.evaluate.bind(page); page.evaluate = ((js: string) => { if (js.includes("innerWidth")) { measurements++; return Promise.resolve({ width: 800, height: 600 }); } return evaluate(js); }) as typeof page.evaluate; } return c; } };
 const s = new Session({ mode: "dedicated", browser: "chrome", profile: "unused-fake", userDataDir: "unused-fake", humanize: false }, { chromium });
 try {
  await s.run("open", { url: "https://example.test" }); await s.run("ui_state", {}); const before = measurements;
  await s.run("eval", { js: "alert" }); log.length = 0;
  const state = (await s.run("ui_frame", {})).ui?.state; expect(state?.dialog).toEqual({ type: "alert", message: "hello" }); expect(state?.frame).toBeUndefined(); expect(state?.width).toBe(800); expect(measurements).toBe(before); expect(log.some((line) => line.includes("screenshot"))).toBe(false);
  await expect(s.run("ui_input", { kind: "text", text: "no" })).rejects.toThrow("DialogOpen");
  await s.run("dialog", { accept: true }); expect((await s.run("ui_state", {})).ui?.state?.dialog).toBeUndefined();
 } finally { await s.close(); }
});
