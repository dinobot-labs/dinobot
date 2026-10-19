import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSlackChannel, type SlackConfig } from "../src/channels/slack.ts";
import { storedSlackText } from "../src/channels/slack-rich-text.ts";

const secret = "0123456789abcdef0123456789abcdef";
const nativeFetch = globalThis.fetch;
const marker = "♻️ 복구된 응답 — 이전 전송 결과가 불확실하여 중복일 수 있습니다.\n\n";
const channels: ReturnType<typeof createSlackChannel>[] = [];
const dirs: string[] = [];
let mock: ReturnType<typeof spyOn> | undefined;
let oldSecret: string | undefined, oldToken: string | undefined;
beforeEach(() => {
 oldSecret = process.env.SLACK_RECOVERY_SECRET; oldToken = process.env.SLACK_RECOVERY_TOKEN;
 process.env.SLACK_RECOVERY_SECRET = secret; process.env.SLACK_RECOVERY_TOKEN = "xoxb-recovery-test";
});
afterEach(async () => {
 for (const c of channels.splice(0)) await c.stop();
 mock?.mockRestore(); mock = undefined;
 for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
 if (oldSecret === undefined) delete process.env.SLACK_RECOVERY_SECRET; else process.env.SLACK_RECOVERY_SECRET = oldSecret;
 if (oldToken === undefined) delete process.env.SLACK_RECOVERY_TOKEN; else process.env.SLACK_RECOVERY_TOKEN = oldToken;
});
function config(extra: Partial<SlackConfig> = {}): SlackConfig {
 const dir = mkdtempSync(join(tmpdir(), "slack-recovery-")); dirs.push(dir);
 return { port: 0, databasePath: join(dir, "inbox.db"), signingSecretEnv: "SLACK_RECOVERY_SECRET", botTokenEnv: "SLACK_RECOVERY_TOKEN", appId: "A123", teamId: "T123", botUserId: "UBOT", allowedUserIds: ["U123"], allowedChannelIds: ["C123"], fileReplies: false, ...extra };
}
function channel(cfg: SlackConfig) { const c = createSlackChannel(cfg); channels.push(c); return c; }
function api(reply: (body: any) => Response | Promise<Response>) {
 mock = spyOn(globalThis, "fetch").mockImplementation((async (url: any, init: RequestInit = {}) => {
  if (!["https://slack.com/api/chat.postMessage", "https://slack.com/api/chat.update"].includes(String(url))) throw Error("Unexpected network destination: " + url);
  expect(new Headers(init.headers).get("authorization")).toBe("Bearer xoxb-recovery-test");
  return reply(JSON.parse(String(init.body)));
 }) as typeof fetch);
}
const ok = () => Response.json({ ok: true, ts: "1791165000.000001" });
const answer = async () => ({ status: "answered" as const, text: "stored **answer** 🌍" });
async function post(c: ReturnType<typeof createSlackChannel> | URL, n = 1, valid = true) {
 const body = JSON.stringify({ type: "event_callback", api_app_id: "A123", team_id: "T123", event_id: "Ev" + n, event: { type: "app_mention", user: "U123", channel: "C123", ts: String(1791165000 + n) + ".000001", text: "<@UBOT> hello" } });
 const time = String(Math.floor(Date.now() / 1000));
 const signature = "v0=" + createHmac("sha256", secret).update("v0:" + time + ":" + body).digest("hex");
 return nativeFetch(new URL("/webhook", c instanceof URL ? c : c.url()), { method: "POST", headers: { "content-type": "application/json", "x-slack-request-timestamp": time, "x-slack-signature": valid ? signature : "v0=" + "0".repeat(64) }, body });
}
async function until(predicate: () => boolean) {
 const end = performance.now() + 4000;
 while (!predicate()) { if (performance.now() > end) throw Error("condition timeout"); await Bun.sleep(10); }
}
function rows(cfg: SlackConfig): any[] {
 const db = new Database(cfg.databasePath, { readonly: true });
 try { return db.query("SELECT * FROM jobs ORDER BY seq").all(); } finally { db.close(); }
}
// Fixture mutation ONLY after stop: this skips wall-clock waiting, not a simulated process crash.
function stoppedSQL(cfg: SlackConfig, sql: string, ...args: (string | number)[]) {
 const db = new Database(cfg.databasePath); try { db.query(sql).run(...args); } finally { db.close(); }
}
async function unknown(cfg: SlackConfig) {
 const c = channel(cfg); let handled = 0;
 await c.start(async () => { handled++; return answer(); });
 expect((await post(c, 1, false)).status).toBe(401);
 expect((await post(c)).status).toBe(200);
 await until(() => c.health().ready === 1);
 await c.stop(); expect(handled).toBe(1); const row = rows(cfg)[0]; expect(row.error).toBe("ambiguous_delivery"); return row;
}

test("Slack recovery persists marked rendered output and 30s/120s backoff across restart without handler replay", async () => {
 const payloads: any[] = []; let failing = true;
 api(body => { payloads.push(body); if (failing) throw Error("uncertain fake transport"); return ok(); });
 const cfg = config(), before = Date.now(), first = await unknown(cfg);
 expect(first.attempts).toBe(1); expect(first.due).toBeGreaterThanOrEqual(before + 30000);
 expect(first.due).toBeLessThanOrEqual(Date.now() + 30000);
 const parts = JSON.parse(first.parts).map(storedSlackText);
 expect(parts.map((p: any) => p.text).join("")).toBe(marker + payloads[0].text);
 let replay = 0; const restart = channel(cfg); await restart.start(async () => { replay++; return answer(); });
 await Bun.sleep(100); expect(payloads).toHaveLength(1); await restart.stop(); expect(rows(cfg)[0].parts).toBe(first.parts); expect(rows(cfg)[0].due).toBe(first.due);
 stoppedSQL(cfg, "UPDATE jobs SET due=0");
 const secondStart = Date.now(), second = channel(cfg); await second.start(async () => { replay++; return answer(); });
 await until(() => payloads.length === 2 && second.health().ready === 1); await second.stop();
 expect(rows(cfg)[0].due).toBeGreaterThanOrEqual(secondStart + 120000);
 expect(rows(cfg)[0].parts).toBe(first.parts); // marker is idempotent
 failing = false; stoppedSQL(cfg, "UPDATE jobs SET due=0");
 const last = channel(cfg); await last.start(async () => { replay++; return answer(); }); await until(() => last.health().done === 1);
 expect(replay).toBe(0); expect(payloads).toHaveLength(3); expect(payloads[2].text).toBe(marker + payloads[0].text);
});

test("Slack seeded sending fixture resumes only uncertain cursor with bounded Unicode chunks", async () => {
 api(() => { throw Error("uncertain"); }); const cfg = config(); await unknown(cfg);
 const long = "😀".repeat(1999) + "<@U123> tail", tail = "later untouched";
 stoppedSQL(cfg, "UPDATE jobs SET state='sending', parts=?, progress=1, due=0", JSON.stringify(["already delivered", long, tail]));
 const sent: any[] = []; mock!.mockRestore(); api(body => { sent.push(body); return ok(); });
 let handled = 0; const c = channel(cfg); await c.start(async () => { handled++; return answer(); }); await until(() => c.health().done === 1);
 expect(handled).toBe(0); expect(sent.map(p => p.text).join("")).toBe(marker + long + tail);
 for (const p of sent) { expect(p.text.length).toBeLessThanOrEqual(4000); expect(p.text).not.toContain("�"); expect(p.blocks[0].text.type).toBe("plain_text"); }
});

for (const boundary of ["attempts", "age"] as const) test("Slack recovery stops at " + boundary + " boundary without another API call", async () => {
 api(() => { throw Error("uncertain"); }); const cfg = config(); await unknown(cfg);
 if (boundary === "attempts") stoppedSQL(cfg, "UPDATE jobs SET attempts=3, due=0");
 else stoppedSQL(cfg, "UPDATE jobs SET created=?, due=0", Date.now() - 86400000);
 let handled = 0; const c = channel(cfg); await c.start(async () => { handled++; return answer(); }); await until(() => c.health().dead === 1);
 expect(c.health().dead_attempts_exhausted).toBe(1); expect(mock).toHaveBeenCalledTimes(1); expect(handled).toBe(0);
});

test("Slack revoked permission prevents stored recovery send", async () => {
 api(() => { throw Error("uncertain"); }); const cfg = config(); await unknown(cfg); stoppedSQL(cfg, "UPDATE jobs SET state='sending', due=0");
 let handled = 0; const c = channel({ ...cfg, allowedUserIds: ["U456"] }); await c.start(async () => { handled++; return answer(); }); await until(() => c.health().dead === 1);
 expect(c.health().dead_permission_revoked).toBe(1); expect(mock).toHaveBeenCalledTimes(1); expect(handled).toBe(0);
});

for(const reason of ["ambiguous_delivery","rate_limited"])test("switching recovery off quarantines pending marked replies after "+reason,async()=>{
 api(()=>{throw Error("uncertain");});const cfg=config();await unknown(cfg);
 // A later shared cooldown may replace the diagnostic reason, but must not erase recovery identity.
 stoppedSQL(cfg,"UPDATE jobs SET error=?",reason);
 const c=channel({...cfg,deliveryRecovery:false});await c.start(answer);
 expect(c.health().dead).toBe(1);expect(c.health().ready).toBe(0);expect(mock).toHaveBeenCalledTimes(1);
});

test("Slack deliveryRecovery:false keeps uncertain output terminal across restart", async () => {
 api(() => { throw Error("uncertain"); }); const cfg = config({ deliveryRecovery: false }), c = channel(cfg); let handled = 0;
 await c.start(async () => { handled++; return answer(); }); await post(c); await until(() => c.health().dead === 1); expect(c.health().unknown).toBe(1); await c.stop();
 const restart = channel(cfg); await restart.start(async () => { handled++; return answer(); }); await Bun.sleep(100);
 expect(mock).toHaveBeenCalledTimes(1); expect(handled).toBe(1); expect(restart.health().unknown).toBe(1);
});

test("Slack deliveryRecovery:false quarantines seeded interrupted sending", async () => {
 api(() => { throw Error("uncertain"); }); const cfg = config(); await unknown(cfg);
 stoppedSQL(cfg, "UPDATE jobs SET state='sending', due=0");
 let handled = 0; const c = channel({ ...cfg, deliveryRecovery: false }); await c.start(async () => { handled++; return answer(); });
 expect(c.health().unknown).toBe(1); expect(c.health().dead).toBe(1); expect(handled).toBe(0); expect(mock).toHaveBeenCalledTimes(1);
});

test("Slack 429 retains 120s due and restores channel cooldown for OTHER queued/new jobs and progress", async () => {
 api(() => new Response(null, { status: 429, headers: { "Retry-After": "120" } }));
 const cfg = config(), c = channel(cfg), before = Date.now(); await c.start(answer); await post(c);
 await until(() => c.health().ready === 1); await c.stop();
 const first = rows(cfg)[0]; expect(first.state).toBe("ready"); expect(first.due).toBeGreaterThanOrEqual(before + 120000);
 // Isolated stopped-DB fixture: clone a different physical message as a queued job with due=0.
 // Keep the original 429 due and persisted native cooldown completely untouched.
 stoppedSQL(cfg, "INSERT INTO jobs(id,message,target,state,created,expires,parts,progress,attempts,due,lane) SELECT 'queued-fixture',replace(message,'1791165001.000001','1791165099.000001'),replace(target,'1791165001.000001','1791165099.000001'),'queued',created,expires,NULL,0,0,0,NULL FROM jobs WHERE seq=1");
 const retained = channel(cfg); await retained.start(answer); await Bun.sleep(50); await retained.stop(); expect(rows(cfg)[0].due).toBe(first.due);
 // Slack is global FIFO. Retire the blocked head in this stopped fixture so OTHER jobs actually reach the cooldown gate.
 stoppedSQL(cfg, "UPDATE jobs SET state='done' WHERE seq=1");
 let handled = 0;
 const handler = async (_m: any, _s: any, progress: any) => { handled++; progress?.({ type: "tool_start", id: "read", name: "read" }); await Bun.sleep(50); return answer(); };
 const queued = channel(cfg); await queued.start(handler); await until(() => handled === 1 && queued.health().ready === 1); await queued.stop();
 expect(mock).toHaveBeenCalledTimes(1); expect(rows(cfg)[1].attempts).toBe(0); expect(rows(cfg)[1].due).toBeGreaterThanOrEqual(first.due - 10);
 stoppedSQL(cfg, "UPDATE jobs SET state='done' WHERE seq=2");
 const fresh = channel(cfg); await fresh.start(handler); await post(fresh, 2); await until(() => handled === 2 && fresh.health().ready === 1); await fresh.stop();
 expect(mock).toHaveBeenCalledTimes(1); expect(rows(cfg)[2].attempts).toBe(0); expect(rows(cfg)[2].due).toBeGreaterThanOrEqual(first.due - 10);
});

test("Slack real Bun SIGKILL at sending boundary recovers output without handler replay", async () => {
 const cfg = config(), messages: any[] = [];
 const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/slack-recovery-child.ts"), JSON.stringify(cfg)], {
  env: { ...process.env }, stdout: "ignore", stderr: "pipe", ipc: message => { messages.push(message); },
 });
 try {
  await until(() => messages.some(m => m.kind === "ready"));
  const url = new URL(messages.find(m => m.kind === "ready").url);
  expect((await post(url)).status).toBe(200);
  await until(() => messages.some(m => m.kind === "sending"));
  child.kill("SIGKILL"); await child.exited;
  expect(child.signalCode).toBe("SIGKILL");
  // Read after process exit releases exclusive SQLite ownership. No fixture rewrite here.
  const saved = rows(cfg)[0]; expect(saved.state).toBe("sending"); expect(saved.attempts).toBe(1);
  expect(messages.filter(m => m.kind === "handled")).toHaveLength(1);
  const sent: any[] = []; api(body => { sent.push(body); return ok(); });
  let replay = 0; const c = channel(cfg); await c.start(async () => { replay++; return answer(); }); await until(() => c.health().done === 1);
  expect(replay).toBe(0); expect(sent).toHaveLength(1);
  expect(sent[0].text).toBe(marker + messages.find(m => m.kind === "sending").body.text);
 } finally {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await child.exited;
  const stderr = await new Response(child.stderr).text();
  if (stderr) throw Error("Slack recovery child stderr: " + stderr);
 }
});
