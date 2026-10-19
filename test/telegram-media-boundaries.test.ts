import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { telegramChannel } from "../src/channels/telegram.ts";
import type { InboundMessage } from "../src/channels/types.ts";
import { SCALED_GATE_POLICY } from "./fixtures/gate-policy.ts";

// Real loopback HTTP, real disposable inbox, no global fetch mocks or live bot.
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=", "base64");
async function until(fn: () => boolean) { const end = Date.now()+5000; while (!fn()) { if (Date.now()>end) throw new Error("boundary timeout"); await Bun.sleep(5); } }
async function fixture(bytes: Uint8Array, options: { image?: boolean; advertised?: number; redirect?: boolean; limited?: "getFile" | "download" } = {}) {
 const dir = mkdtempSync(join(tmpdir(), "media-boundary-")); cleanup.push(async () => rmSync(dir,{recursive:true,force:true}));
 const sent: any[] = [], seen: InboundMessage[] = [], starts: {method:string;at:number}[] = []; let redirected = 0, limitedAt = 0, offset = 0;
 const attachment = options.image ? {document:{file_id:"file_id",file_name:"pixel.png",file_size:options.advertised ?? 1}} : {document:{file_id:"file_id",file_name:"notes.txt",mime_type:"text/plain",file_size:options.advertised ?? 1}};
 const update = {update_id:1,message:{message_id:1,from:{id:7,is_bot:false},chat:{id:-9,type:"supergroup"},message_thread_id:12,...attachment}};
 const server = Bun.serve({hostname:"127.0.0.1",port:0,async fetch(req) {
  // Production startup now registers its advisory menu; not a media request.
  if(new URL(req.url).pathname.endsWith("/setMyCommands")) return Response.json({ok:true,result:true});
  const path = new URL(req.url).pathname;
  if(path==="/redirect-target") { redirected++; return new Response(bytes); }
  const method = path.includes("/file/") ? "download" : path.split("/").at(-1)!;
  starts.push({method,at:performance.now()});
  if(method===options.limited) { limitedAt=performance.now(); return Response.json({ok:false,parameters:{retry_after:2}},{status:429,headers:{"retry-after":"1"}}); }
  if(method==="download") {
   if(options.redirect) return new Response(null,{status:302,headers:{location:"/redirect-target"}});
   // No Content-Length: deliberately lie in both Telegram size declarations and stream real bytes.
   let position=0; return new Response(new ReadableStream<Uint8Array>({pull(controller) { if(position===bytes.length) {controller.close();return;} const end=Math.min(position+8192,bytes.length);controller.enqueue(bytes.slice(position,end));position=end; }}));
  }
  const body=await req.json() as any;
  if(method==="getWebhookInfo") return Response.json({ok:true,result:{url:""}});
  if(method==="getUpdates") { offset=body.offset; return Response.json({ok:true,result:body.offset<=1?[update]:[]}); }
  if(method==="getFile") return Response.json({ok:true,result:{file_path:"documents/file.dat",file_size:1}});
  if(method==="sendMessage") {sent.push(body);return Response.json({ok:true,result:{message_id:99}});}
  throw new Error("unexpected "+method);
 }}); cleanup.push(async()=>server.stop(true));
 process.env.MEDIA_BOUNDARY_TOKEN="752:boundary_test";
 const c=telegramChannel({mode:"polling",botTokenEnv:"MEDIA_BOUNDARY_TOKEN",databasePath:join(dir,"inbox.db"),allowedUserIds:["7"],allowedChatIds:["-9"],progress:"off",requestTimeoutMs:4000},{apiBase:server.url.origin,gatePolicy:SCALED_GATE_POLICY});
 cleanup.push(()=>c.stop()); await c.start(async m=>{seen.push(m);return {status:"answered",text:"OK"};});
 await until(()=>sent.length===1 && offset===2); await c.stop();
 return {sent,seen,starts,redirected,limitedAt};
}
const unicodeExact=Buffer.from("é".repeat(32768));
for(const [name,bytes,image] of [
 ["text exact 64 KiB multibyte",unicodeExact,false],
 ["image exact 2 MiB",Buffer.concat([png,Buffer.alloc(2097152-png.length)]),true],
] as const) test(name+" reaches core",async()=>{const f=await fixture(bytes,{image});expect(f.seen).toHaveLength(1);expect(f.sent[0].text).toBe("OK");if(image)expect(f.seen[0]!.images).toHaveLength(1);else expect(f.seen[0]!.text).toContain(unicodeExact.toString());});
// RED must remain: a valid ASCII document at the advertised byte limit must not fail solely on wrapper length.
test("text exact 64 KiB ASCII reaches core",async()=>{const f=await fixture(Buffer.alloc(65536,97));expect(f.seen).toHaveLength(1);expect(f.seen[0]!.text).toContain("a".repeat(65536));});
for(const [name,bytes,image] of [
 ["text actual stream 64 KiB + 1",Buffer.concat([unicodeExact,Buffer.from("a")]),false],
 ["image actual stream 2 MiB + 1",Buffer.concat([png,Buffer.alloc(2097153-png.length)]),true],
 ["malformed UTF-8",Buffer.from([0x61,0xc3,0x28]),false],
 ["NUL in valid UTF-8",Buffer.from("safe\0unsafe"),false],
] as const) test(name+" preserves received bytes",async()=>{const f=await fixture(bytes,{image});expect(f.starts.filter(x=>x.method==="download")).toHaveLength(1);expect(f.seen).toHaveLength(1);expect(f.seen[0]!.files?.[0]?.data).toBe(bytes.toString("base64"));expect(f.sent[0].text).toBe("OK");});
test("download redirect is refused without contacting destination",async()=>{const f=await fixture(Buffer.from("safe"),{redirect:true});expect(f.redirected).toBe(0);expect(f.seen).toHaveLength(0);expect(f.sent[0].text).toContain("⚠️");});
for(const limited of ["getFile","download"] as const)test(limited+" 429 body bound holds polling and delivery across the shared gate",async()=>{
 const f=await fixture(Buffer.from("safe"),{limited});expect(f.limitedAt).toBeGreaterThan(0);const later=f.starts.filter(x=>x.at>f.limitedAt);expect(later.some(x=>x.method==="getUpdates")).toBe(true);expect(later.some(x=>x.method==="sendMessage")).toBe(true);for(const x of later)expect(x.at-f.limitedAt).toBeGreaterThanOrEqual(1990);expect(f.seen).toHaveLength(0);expect(f.sent[0].text).toContain("⚠️");
});
