import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { telegramChannel } from "../src/channels/telegram.ts";
import type { MessagingChannel } from "../src/channels/messaging.ts";
import type { HandlerOptions, InboundMessage, MessageHandler } from "../src/channels/types.ts";
import { SCALED_GATE_POLICY } from "./fixtures/gate-policy.ts";

// Disposable webhook/SQLite and loopback transport only; inspect DB after owner exit.
const scratch = process.env.REPLY_RECOVERY_SCRATCH ?? tmpdir();
const cleanup: (() => Promise<unknown>)[] = [];
const releases: (() => void)[] = [];
afterEach(async () => { for (const release of releases.splice(0)) release(); for (const fn of cleanup.splice(0).reverse()) await fn(); });
function gate() {
 let release!: () => void;
 const promise = new Promise<void>(resolve => { release = resolve; });
 releases.push(release);
 return { promise, release };
}
async function until(fn: () => boolean) {
 const end = Date.now() + 5000;
 while (!fn()) { if (Date.now() > end) throw new Error("reply recovery barrier timeout"); await Bun.sleep(5); }
}
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=", "base64");
const replyImage = { text: "current request", reply_to_message: { message_id: 50, chat: { id: -9 }, message_thread_id: 12, from: { id: 99, is_bot: true }, caption: "old caption must not join", photo: [{ file_id: "reply_photo", width: 1, height: 1 }] } };
async function fixture() {
 mkdirSync(scratch, { recursive: true });
 const dir = mkdtempSync(join(scratch, "reply-"));
 const keys = ["TMP", "TEMP", "TMPDIR", "REPLY_RECOVERY_TOKEN", "REPLY_RECOVERY_SECRET"];
 const previous = keys.map(key => process.env[key]);
 for (const key of keys.slice(0, 3)) process.env[key] = dir;
 process.env.REPLY_RECOVERY_TOKEN = "864:reply_recovery_fake";
 process.env.REPLY_RECOVERY_SECRET = "reply-recovery-fake-secret";
 cleanup.push(async () => { keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; }); rmSync(dir, { recursive: true, force: true }); });
 const path = join(dir, "inbox.sqlite");
 const images = [png, await new Bun.Image(png).resize(2, 2).png().bytes()];
 const normalized = await Promise.all(images.map(async bytes => Buffer.from(await new Bun.Image(bytes).png().bytes()).toString("base64")));
 const methods: string[] = [], sent: any[] = [], fileIds: string[] = [];
 let generation = 0, downloadHold: ReturnType<typeof gate> | undefined;
 const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  // Production startup now registers its advisory menu; not a media request.
  if(new URL(req.url).pathname.endsWith("/setMyCommands")) return Response.json({ok:true,result:true});
  const p = new URL(req.url).pathname;
  if (p.includes("/file/")) { methods.push("download"); await downloadHold?.promise; return new Response(images[generation]!); }
  const method = p.split("/").at(-1)!; methods.push(method);
  const body = await req.json() as any;
  if (method === "getFile") { fileIds.push(body.file_id); return Response.json({ ok: true, result: { file_path: "photos/reply.png" } }); }
  if (method === "sendMessage") { sent.push(body); return Response.json({ ok: true, result: { message_id: 99 } }); }
  throw new Error("unexpected transport " + method);
 } });
 cleanup.push(async () => server.stop(true));
 const config = { port: 0, botTokenEnv: "REPLY_RECOVERY_TOKEN", webhookSecretEnv: "REPLY_RECOVERY_SECRET", databasePath: path, allowedUserIds: ["7"], allowedChatIds: ["-9"], progress: "off" as const, requestTimeoutMs: 3000 };
 async function open(handler: MessageHandler, allowedUserIds = ["7"]) {
  const c = telegramChannel({ ...config, allowedUserIds }, { apiBase: server.url.origin, gatePolicy: SCALED_GATE_POLICY });
  cleanup.push(() => c.stop()); await c.start(handler); return c;
 }
 async function post(c: MessagingChannel | string, id = 1, message: any = replyImage) {
  const response = await fetch(new URL("/webhook", typeof c === "string" ? c : c.url()), { method: "POST", headers: { "x-telegram-bot-api-secret-token": "reply-recovery-fake-secret" }, body: JSON.stringify({ update_id: id, message: { message_id: id + 100, from: { id: 7, is_bot: false }, chat: { id: -9, type: "supergroup" }, message_thread_id: 12, ...message } }), signal: AbortSignal.timeout(3000) });
  await response.arrayBuffer(); return response.status;
 }
 function rows() { const db = new Database(path, { readonly: true }); try { return db.query("SELECT id,state,message,target,error FROM jobs ORDER BY seq").all() as any[]; } finally { db.close(); } }
 return { config, path, open, post, rows, methods, sent, fileIds, normalized, apiBase: server.url.origin, changeBytes: () => { generation = 1; }, holdDownload: (g: ReturnType<typeof gate>) => { downloadHold = g; } };
}
function imageInput(m: InboundMessage, data: string, id = "1") {
 expect(m).toMatchObject({ messageId: id, userId: "7", threadKey: "864:-9:12:7", text: "current request" });
 expect(m.images).toEqual([{ mimeType: "image/png", data }]);
}

test("reply image duplicate during prepare and core, completed and reopened: one download/core/reply", async () => {
 const f = await fixture(), download = gate(), core = gate(), seen: InboundMessage[] = [];
 f.holdDownload(download);
 const c = await f.open(async m => { seen.push(m); await core.promise; return { status: "answered", text: "once" }; });
 expect(await f.post(c)).toBe(200); await until(() => f.methods.includes("download"));
 expect(await f.post(c)).toBe(200); await Bun.sleep(80); expect(seen).toHaveLength(0); expect(f.sent).toHaveLength(0);
 download.release(); await until(() => seen.length === 1); imageInput(seen[0]!, f.normalized[0]!);
 expect(await f.post(c)).toBe(200); await Bun.sleep(80); expect(seen).toHaveLength(1); expect(f.sent).toHaveLength(0);
 core.release(); await until(() => c.health().done === 1); expect(await f.post(c)).toBe(200); await c.stop();
 const next = await f.open(async m => { seen.push(m); return { status: "answered", text: "duplicate" }; });
 expect(await f.post(next)).toBe(200); await next.stop();
 expect(f.rows().map(r => [r.id, r.state])).toEqual([["1", "done"]]);
 expect(seen).toHaveLength(1); expect(f.fileIds).toEqual(["reply_photo"]); expect(f.methods.filter(x => x === "download")).toHaveLength(1);
 expect(f.sent.map(x => [x.text, x.chat_id, x.message_thread_id])).toEqual([["once", "-9", 12]]);
});

// Actual disposable child SIGKILL after media preparation, fresh channel/connection on reopen.
for (const revoked of [false, true]) test("reply image SIGKILL/reopen: " + (revoked ? "current actor revocation blocks all transport/core" : "fresh image is downloaded"), async () => {
 const f = await fixture();
 const program = 'import {telegramChannel} from "./src/channels/telegram.ts"; import {SCALED_GATE_POLICY} from "./test/fixtures/gate-policy.ts"; const c=telegramChannel(' + JSON.stringify(f.config) + ',{apiBase:' + JSON.stringify(f.apiBase) + ',gatePolicy:SCALED_GATE_POLICY}); await c.start(async m=>{console.log("PREPARED:"+JSON.stringify(m));return await new Promise(()=>{});});console.log("READY:"+c.url());';
 const child = Bun.spawn([process.execPath, "-e", program], { cwd: join(import.meta.dir, ".."), env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
 cleanup.push(async () => { child.kill(); await child.exited; });
 const reader = child.stdout.getReader(); let buffered = "";
 async function line() {
  const deadline = Date.now() + 5000;
  while (!buffered.includes("\n")) {
   let timer: ReturnType<typeof setTimeout> | undefined;
   try {
    const result = await Promise.race([reader.read(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("child barrier timeout")), Math.max(1, deadline - Date.now())); })]);
    if (result.done) throw new Error("child exited before barrier: " + await new Response(child.stderr).text());
    buffered += new TextDecoder().decode(result.value);
   } finally { clearTimeout(timer); }
  }
  const end = buffered.indexOf("\n"), value = buffered.slice(0, end).trim(); buffered = buffered.slice(end + 1); return value;
 }
 const ready = await line(); expect(ready.startsWith("READY:")).toBe(true); expect(await f.post(ready.slice(6))).toBe(200);
 const prepared = await line(); expect(prepared.startsWith("PREPARED:")).toBe(true); imageInput(JSON.parse(prepared.slice(9)), f.normalized[0]!);
 child.kill("SIGKILL"); await child.exited; await reader.cancel(); expect(child.exitCode).not.toBe(0);
 const stored = f.rows(); expect(stored).toHaveLength(1); expect(stored[0].state).toBe("processing"); expect(stored[0].target).toContain("reply_photo");
 expect(stored[0].message).not.toContain(f.normalized[0]!); expect(stored[0].target).not.toContain(f.normalized[0]!); expect(f.sent).toHaveLength(0);
 expect(f.fileIds).toEqual(["reply_photo"]); expect(f.methods.filter(x => x === "download")).toHaveLength(1);
 f.changeBytes(); expect(f.normalized[1]).not.toBe(f.normalized[0]); const before = f.methods.length, seen: InboundMessage[] = [];
 const next = await f.open(async m => { seen.push(m); return { status: "answered", text: "recovered" }; }, revoked ? ["99"] : ["7"]);
 await until(() => revoked ? next.health().dead === 1 : next.health().done === 1); await next.stop();
 if (revoked) { expect(seen).toHaveLength(0); expect(f.methods.length).toBe(before); expect(f.sent).toHaveLength(0); expect(f.rows()[0]).toMatchObject({ state: "dead", error: "permission_revoked" }); }
 else { expect(seen).toHaveLength(1); imageInput(seen[0]!, f.normalized[1]!); expect(f.fileIds).toEqual(["reply_photo", "reply_photo"]); expect(f.methods.filter(x => x === "download")).toHaveLength(2); expect(f.sent.map(x => x.text)).toEqual(["recovered"]); expect(f.rows()[0].state).toBe("done"); }
}, 15000);

test("delayed reply image primary reaches core before following same-user text steer", async () => {
 const f = await fixture(), download = gate(), core = gate(); f.holdDownload(download);
 const calls: { m: InboundMessage; options: HandlerOptions | undefined }[] = [];
 const c = await f.open(async (m, _signal, _progress, options) => { calls.push({ m, options }); if (m.messageId === "1") await core.promise; return { status: "answered", text: "answer " + m.messageId, answer: Number(m.messageId) }; });
 expect(await f.post(c)).toBe(200); await until(() => f.methods.includes("download")); expect(await f.post(c, 2, { text: "following text" })).toBe(200);
 await Bun.sleep(80); expect(calls).toHaveLength(0); expect(c.health().queued).toBe(1);
 download.release(); await until(() => calls.length === 2);
 expect(calls.map(x => [x.m.messageId, x.options?.whenBusy])).toEqual([["1", undefined], ["2", "steer"]]); imageInput(calls[0]!.m, f.normalized[0]!); expect(calls[1]!.m.text).toBe("following text"); expect(calls[1]!.m.images).toBeUndefined(); expect(f.sent).toHaveLength(0);
 core.release(); await until(() => c.health().done === 2); await c.stop(); expect(f.rows().map(r => r.state)).toEqual(["done", "done"]); expect(f.sent.map(x => x.text)).toEqual(["answer 1", "answer 2"]); expect(f.fileIds).toEqual(["reply_photo"]);
});

test("queued replied attachment remains FIFO before following same-user text", async () => {
 const f = await fixture(), first = gate(), download = gate(), second = gate(); f.holdDownload(download);
 const calls: { m: InboundMessage; options: HandlerOptions | undefined }[] = [];
 const c = await f.open(async (m, _signal, _progress, options) => { calls.push({ m, options }); if (m.messageId === "1") await first.promise; if (m.messageId === "2") await second.promise; return { status: "answered", text: "answer " + m.messageId, answer: Number(m.messageId) }; });
 expect(await f.post(c, 1, { text: "first" })).toBe(200); await until(() => calls.length === 1);
 expect(await f.post(c, 2)).toBe(200); expect(await f.post(c, 3, { text: "third" })).toBe(200);
 await Bun.sleep(80); expect(calls.map(x => x.m.messageId)).toEqual(["1"]); expect(c.health().queued).toBe(2); expect(f.fileIds).toHaveLength(0);
 first.release(); await until(() => f.methods.includes("download")); await Bun.sleep(80); expect(calls.map(x => x.m.messageId)).toEqual(["1"]);
 download.release(); await until(() => calls.length === 3); imageInput(calls[1]!.m, f.normalized[0]!, "2");
 expect(calls.map(x => [x.m.messageId, x.options?.whenBusy])).toEqual([["1", undefined], ["2", undefined], ["3", "steer"]]); expect(calls[2]!.m.text).toBe("third");
 second.release(); await until(() => c.health().done === 3); await c.stop(); expect(f.rows().map(r => [r.id, r.state])).toEqual([["1", "done"], ["2", "done"], ["3", "done"]]); expect(f.sent.map(x => x.text)).toEqual(["answer 1", "answer 2", "answer 3"]); expect(f.fileIds).toEqual(["reply_photo"]);
});
