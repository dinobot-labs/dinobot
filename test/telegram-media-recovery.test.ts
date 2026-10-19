import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { telegramChannel } from "../src/channels/telegram.ts";
import type { MessagingChannel } from "../src/channels/messaging.ts";
import type { InboundMessage, MessageHandler } from "../src/channels/types.ts";
import { SCALED_GATE_POLICY } from "./fixtures/gate-policy.ts";

const cleanup: (()=>Promise<unknown>)[]=[];
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});
async function until(fn:()=>boolean) {const end=Date.now()+5000;while(!fn()){if(Date.now()>end)throw new Error("recovery timeout");await Bun.sleep(5);}}
async function fixture() {
 const dir=mkdtempSync(join(tmpdir(),"media-recovery-"));cleanup.push(async()=>rmSync(dir,{recursive:true,force:true}));
 const path=join(dir,"inbox.db");const methods:string[]=[],sent:any[]=[];let generation=1;
 const server=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(req){
  // Production startup now registers its advisory menu; not a media request.
  if(new URL(req.url).pathname.endsWith("/setMyCommands")) return Response.json({ok:true,result:true});
  const p=new URL(req.url).pathname;if(p.includes("/file/")){methods.push("download");return new Response("generation-"+generation);}
  const method=p.split("/").at(-1)!;methods.push(method);const body=await req.json() as any;
  if(method==="getFile")return Response.json({ok:true,result:{file_path:"documents/notes.txt"}});
  if(method==="sendMessage"){sent.push(body);return Response.json({ok:true,result:{message_id:99}});}
  throw new Error("unexpected "+method);
 }});cleanup.push(async()=>server.stop(true));
 process.env.MEDIA_RECOVERY_TOKEN="753:recovery_test";process.env.MEDIA_RECOVERY_SECRET="media-recovery-secret";
 async function open(handler:MessageHandler,allowedUserIds=["7"]) {
  const c=telegramChannel({port:0,botTokenEnv:"MEDIA_RECOVERY_TOKEN",webhookSecretEnv:"MEDIA_RECOVERY_SECRET",databasePath:path,allowedUserIds,allowedChatIds:["-9"],progress:"off",requestTimeoutMs:2000},{apiBase:server.url.origin,gatePolicy:SCALED_GATE_POLICY});cleanup.push(()=>c.stop());await c.start(handler);return c;
 }
 function rows(){const db=new Database(path,{readonly:true});try{return db.query("SELECT id,state,message,target,error FROM jobs ORDER BY seq").all() as any[];}finally{db.close();}}
 async function post(c:MessagingChannel|string) {const r=await fetch(new URL("/webhook",typeof c === "string" ? c : c.url()),{method:"POST",headers:{"x-telegram-bot-api-secret-token":"media-recovery-secret"},body:JSON.stringify({update_id:1,message:{message_id:5,from:{id:7,is_bot:false},chat:{id:-9,type:"supergroup"},message_thread_id:12,document:{file_id:"doc_id",file_name:"notes.txt",mime_type:"text/plain"}}}),signal:AbortSignal.timeout(2000)});await r.arrayBuffer();return r.status;}
 return {open,rows,post,methods,sent,path,apiBase:server.url.origin,changeBytes:()=>{generation++;}};
}
const answer:MessageHandler=async()=>({status:"answered",text:"OK"});
// Same stop-interruption technique as telegram-scheduler-recovery.test.ts: stop leaves processing durable,
// then a NEW channel/SQLite connection performs startup recovery. This is not an OS process-kill claim.
function interrupted(seen:InboundMessage[]):MessageHandler {return async(m,signal)=>{seen.push(m);await new Promise<void>((resolve)=>{if(signal!.aborted)resolve();else signal!.addEventListener("abort",()=>resolve(),{once:true});});return {status:"answered",text:"late-must-not-send"};};}
test("duplicate attachment update before and after completion/reopen downloads and answers once",async()=>{
 const f=await fixture(),seen:InboundMessage[]=[];const c=await f.open(async m=>{seen.push(m);return {status:"answered",text:"OK"};});
 expect(await f.post(c)).toBe(200);expect(await f.post(c)).toBe(200);await until(()=>c.health().done===1);
 expect(await f.post(c)).toBe(200);await c.stop();const next=await f.open(async m=>{seen.push(m);return {status:"answered",text:"duplicate"};});expect(await f.post(next)).toBe(200);await next.stop();
 expect(f.rows()).toHaveLength(1);expect(seen).toHaveLength(1);expect(f.methods.filter(x=>x==="getFile")).toHaveLength(1);expect(f.methods.filter(x=>x==="download")).toHaveLength(1);expect(f.sent.map(x=>x.text)).toEqual(["OK"]);
});
test("interrupted durable media inbox reopens, reauthorizes and re-downloads reference rather than cached bytes",async()=>{
 const f=await fixture(),first:InboundMessage[]=[],replay:InboundMessage[]=[];const c=await f.open(interrupted(first));expect(await f.post(c)).toBe(200);await until(()=>first.length===1);await c.stop();
 expect(f.rows()[0].state).toBe("processing");expect(f.rows()[0].target).toContain("doc_id");expect(f.rows()[0].message).not.toContain("generation-1");expect(f.sent).toHaveLength(0);
 f.changeBytes();const next=await f.open(async m=>{replay.push(m);return {status:"answered",text:"recovered"};});await until(()=>next.health().done===1);await next.stop();
 expect(first[0]!.text).toContain("generation-1");expect(replay).toHaveLength(1);expect(replay[0]!.text).toContain("generation-2");expect(replay[0]!.text).not.toContain("generation-1");expect(replay[0]!.messageId).toBe("1");expect(replay[0]!.threadKey).toBe("753:-9:12:7");expect(f.methods.filter(x=>x==="getFile")).toHaveLength(2);expect(f.methods.filter(x=>x==="download")).toHaveLength(2);expect(f.sent.map(x=>x.text)).toEqual(["recovered"]);
});
test("authorization revoked between interruption and reopen kills durable media without re-download or core",async()=>{
 const f=await fixture(),seen:InboundMessage[]=[];const c=await f.open(interrupted(seen));expect(await f.post(c)).toBe(200);await until(()=>seen.length===1);await c.stop();expect(f.rows()[0].state).toBe("processing");const before=f.methods.length;
 const next=await f.open(answer,["8"]);await until(()=>next.health().dead===1);await next.stop();expect(f.rows()[0]).toMatchObject({state:"dead",error:"permission_revoked"});expect(f.methods.length).toBe(before);expect(f.sent).toHaveLength(0);expect(seen).toHaveLength(1);
});

// Actual isolated worker death: no channel.stop(), no production process, and no file-script artifact.
for (const revoked of [false,true]) test("process crash/reopen media: " + (revoked ? "changed authorization blocks download" : "authorized reference re-downloads fresh bytes"),async()=>{
 const f=await fixture();
 const config={port:0,botTokenEnv:"MEDIA_RECOVERY_TOKEN",webhookSecretEnv:"MEDIA_RECOVERY_SECRET",databasePath:f.path,allowedUserIds:["7"],allowedChatIds:["-9"],progress:"off",requestTimeoutMs:2000};
 const program='import {telegramChannel} from "./src/channels/telegram.ts"; import {SCALED_GATE_POLICY} from "./test/fixtures/gate-policy.ts"; const c=telegramChannel('+JSON.stringify(config)+',{apiBase:'+JSON.stringify(f.apiBase)+',gatePolicy:SCALED_GATE_POLICY}); await c.start(async m=>{console.log("PREPARED:"+JSON.stringify(m));return await new Promise(()=>{});});console.log("READY:"+c.url());';
 const child=Bun.spawn([process.execPath,"-e",program],{cwd:join(import.meta.dir,".."),env:{...process.env,MEDIA_RECOVERY_TOKEN:"753:recovery_test",MEDIA_RECOVERY_SECRET:"media-recovery-secret"},stdout:"pipe",stderr:"pipe"});
 cleanup.push(async()=>{child.kill();await child.exited;});
 const reader=child.stdout.getReader();let buffered="";
 async function line(){const deadline=Date.now()+5000;while(!buffered.includes("\n")){
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {const result=await Promise.race([reader.read(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("worker stdout timeout")),Math.max(1,deadline-Date.now()));})]);if(result.done)throw new Error("worker exited before barrier: "+await new Response(child.stderr).text());buffered+=new TextDecoder().decode(result.value);}finally{clearTimeout(timer);}
 } const end=buffered.indexOf("\n"),value=buffered.slice(0,end).trim();buffered=buffered.slice(end+1);return value;}
 const ready=await line();expect(ready.startsWith("READY:")).toBe(true);expect(await f.post(ready.slice(6))).toBe(200);
 const prepared=await line();expect(prepared.startsWith("PREPARED:")).toBe(true);expect(prepared).toContain("generation-1");
 child.kill("SIGKILL");await child.exited;await reader.cancel();expect(f.rows()[0].state).toBe("processing");expect(f.sent).toHaveLength(0);expect(f.rows()[0].message).not.toContain("generation-1");f.changeBytes();const before=f.methods.length,seen:InboundMessage[]=[];
 const next=await f.open(async m=>{seen.push(m);return {status:"answered",text:"after-crash"};},revoked?["8"]:["7"]);
 await until(()=>revoked?next.health().dead===1:next.health().done===1);await next.stop();
 if(revoked){expect(seen).toHaveLength(0);expect(f.methods.length).toBe(before);expect(f.sent).toHaveLength(0);expect(f.rows()[0]).toMatchObject({state:"dead",error:"permission_revoked"});}
 else {expect(seen).toHaveLength(1);expect(seen[0]!.text).toContain("generation-2");expect(seen[0]!.messageId).toBe("1");expect(f.methods.filter(x=>x==="getFile")).toHaveLength(2);expect(f.methods.filter(x=>x==="download")).toHaveLength(2);expect(f.sent.map(x=>x.text)).toEqual(["after-crash"]);}
},15000);
