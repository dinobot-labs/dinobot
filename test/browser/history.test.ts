import { expect, test } from "bun:test";
import { Session, type Chromium } from "../../src/plugins/browser/host.ts";
import { fakeChromium } from "../fixtures/browser-fake-host.ts";

test("history traversal waits for commit and actual DOM readiness, including BFCache restores", async () => {
 const calls: string[] = []; const base = fakeChromium(() => {});
 const driver = { ...base, launchPersistentContext: async (...args: Parameters<Chromium["launchPersistentContext"]>) => {
  const context = await base.launchPersistentContext(...args);
  const page = context.pages()[0] as any;
  for (const action of ["goBack", "goForward"]) page[action] = async (options: unknown) => { expect(options).toEqual({waitUntil:"commit"}); calls.push(action); return null; };
  page.waitForFunction = async (expression: string, _arg: unknown, options: {timeout:number}) => { expect(expression).toContain("document.readyState"); expect(options.timeout).toBe(30000); calls.push("ready"); return {dispose:async()=>{calls.push("dispose");}}; };
  return context;
 }} as Chromium;
 const session = new Session({mode:"dedicated",browser:"chrome",profile:"unused-fake",userDataDir:"unused-fake",humanize:false},{chromium:driver});
 try { await session.run("open",{url:"https://example.test"}); await session.run("back",{}); await session.run("forward",{}); expect(calls).toEqual(["goBack","ready","dispose","goForward","ready","dispose"]); } finally { await session.close(); }
});
