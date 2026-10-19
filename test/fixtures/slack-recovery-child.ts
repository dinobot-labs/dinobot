import { createSlackChannel, type SlackConfig } from "../../src/channels/slack.ts";
// Owned by slack-recovery.test.ts. No real Slack request leaves this subprocess.
const cfg = JSON.parse(process.argv[2]!) as SlackConfig;
globalThis.fetch = (async (url: any, init: RequestInit) => {
 if (String(url) !== "https://slack.com/api/chat.postMessage") throw Error("Unexpected network destination");
 process.send?.({ kind: "sending", body: JSON.parse(String(init.body)) });
 // The adapter has committed sending before invoking fetch. Parent observes IPC, SIGKILLs, then verifies SQLite after exit.
 return new Promise<Response>(() => {});
}) as typeof fetch;
const c = createSlackChannel(cfg);
await c.start(async () => { process.send?.({ kind: "handled" }); return { status: "answered", text: "child durable output 🌍" }; });
process.send?.({ kind: "ready", url: c.url().href });
