import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

const supported = process.platform === "darwin" && ["arm64", "x64"].includes(process.arch);
async function child(source: string, env = process.env) {
 const p = Bun.spawn([process.execPath, "-e", source], { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" });
 const timeout = setTimeout(() => p.kill("SIGKILL"), 10000);
 try {
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  expect(err).toBe(""); expect(code).toBe(0); return out;
 } finally { clearTimeout(timeout); }
}
test.skipIf(!supported)("Darwin native clock is shared across processes and ignores wall time jumps", async () => {
 const source = 'import {systemClock} from "./src/channels/api-clock.ts"; const c=systemClock(), before=c.observeNs(); Date.now=()=>0; await Bun.sleep(20); const after=c.observeNs(); Date.now=()=>Number.MAX_SAFE_INTEGER; const next=systemClock(); console.log(JSON.stringify({frame:c.frame,next:next.frame,before:String(before),after:String(after),rate:c.rate.map(String)}));';
 const a = JSON.parse(await child(source)), b = JSON.parse(await child(source));
 expect(a.frame).toMatch(/^darwin-uptime-raw-v1:[0-9a-f-]{36}$/);
 expect(a.next).toBe(a.frame); expect(b.frame).toBe(a.frame);
 expect(a.rate).toEqual(["1", "1000"]);
 expect(BigInt(a.after)).toBeGreaterThan(BigInt(a.before));
 expect(BigInt(b.before)).toBeGreaterThanOrEqual(BigInt(a.after));
});

test.skipIf(!supported)("Darwin Telegram polling starts, delivers and reopens its native gate in real subprocesses", async () => {
 const dir = mkdtempSync(join(process.cwd(), ".darwin-channel-test-"));
 let sent = 0;
 const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  const method = new URL(req.url).pathname.split("/").at(-1), body = await req.json() as any;
  if (method === "getWebhookInfo") return Response.json({ ok: true, result: { url: "" } });
  if (method === "getUpdates") return Response.json({ ok: true, result: body.offset > 1 ? [] : [{ update_id: 1, message: { message_id: 1, from: { id: 7, is_bot: false }, chat: { id: 7, type: "private" }, text: "hello" } }] });
  if (method === "sendMessage") sent++;
  return Response.json({ ok: true, result: true });
 } });
 const config = { mode: "polling", botTokenEnv: "DARWIN_TEST_TOKEN", databasePath: join(dir, "inbox.db"), allowedUserIds: ["7"], allowedChatIds: ["7"], progress: "off" };
 const source = 'import {telegramChannel} from "./src/channels/telegram.ts"; const c=telegramChannel(' + JSON.stringify(config) + ',{apiBase:' + JSON.stringify(server.url.origin) + '}); try {await c.start(async()=>({status:"answered",text:"reply"})); const end=Date.now()+5000; while(c.health().done!==1){if(Date.now()>end)throw new Error("delivery timeout");await Bun.sleep(10);} console.log("DELIVERED");}finally{await c.stop();}';
 try {
  for (let i = 0; i < 2; i++) expect(await child(source, { ...process.env, DARWIN_TEST_TOKEN: "123:fake_test_only" })).toContain("DELIVERED");
  expect(sent).toBe(1);
 } finally { await server.stop(true); rmSync(dir, { recursive: true, force: true }); }
}, 15000);
