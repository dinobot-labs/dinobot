import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { telegramChannel } from "../src/channels/telegram.ts";
import { httpChannel } from "../src/channels/http.ts";
import { createTelegramForwarder } from "../src/cli/telegram-run.ts";
import { SCALED_GATE_POLICY } from "./fixtures/gate-policy.ts";
import type { InboundMessage } from "../src/channels/types.ts";
const cleanup: (()=>Promise<unknown>)[]=[];
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse()) await fn();});
const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=","base64");
async function fixture(messages: any[], options: {bytes?:Uint8Array; path?:string; getFileStatus?:number; slow?:boolean; timeout?:number; holdMs?:number; spacing?:number}={}) {
 const dir=mkdtempSync(join(tmpdir(),"tg-media-")); cleanup.push(async()=>rmSync(dir,{recursive:true,force:true}));
 const fileIds:string[]=[], sent:any[]=[], methods:string[]=[], seen:InboundMessage[]=[], starts:{method:string;at:number}[]=[]; let offset=0;
 const updates=messages.map((m,i)=>({update_id:i+1,message:{message_id:i+1,from:{id:7,is_bot:false},chat:{id:-9,type:"supergroup"},message_thread_id:12,...m}}));
 const server=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(req){
  // Production startup now registers its advisory menu; not a media request.
  if(new URL(req.url).pathname.endsWith("/setMyCommands")) return Response.json({ok:true,result:true});
  const path=new URL(req.url).pathname;
  if(path.includes("/file/")){methods.push("download"); if(options.slow) await Bun.sleep(500); return new Response(options.bytes??png);}
  const method=path.split("/").at(-1)!; methods.push(method); starts.push({method,at:performance.now()}); const body=await req.json() as any;
  if(method==="getWebhookInfo") return Response.json({ok:true,result:{url:""}});
  if(method==="getUpdates"){offset=body.offset; return Response.json({ok:true,result:updates.filter(e=>e.update_id>=body.offset)});}
  if(method==="getFile") { fileIds.push(body.file_id); return Response.json({ok:!options.getFileStatus,result:{file_path:options.path??"photos/file.jpg"}}, {status:options.getFileStatus??200}); }
  if(method==="sendMessage"){sent.push(body);return Response.json({ok:true,result:{message_id:99}});}
  throw new Error("unexpected method "+method);
 }});cleanup.push(async()=>server.stop(true));process.env.MEDIA_TEST_TOKEN="123:test_only";
 const c=telegramChannel({mode:"polling",botTokenEnv:"MEDIA_TEST_TOKEN",databasePath:join(dir,"queue.db"),allowedUserIds:["7"],allowedChatIds:["-9"],progress:"off",requestTimeoutMs:options.timeout??200},{apiBase:server.url.origin,gatePolicy:{...SCALED_GATE_POLICY,botSpacingMs:options.spacing??1}});
 cleanup.push(()=>c.stop());await c.start(async m=>{seen.push(m);if(options.holdMs)await Bun.sleep(options.holdMs);return {status:"answered",text:"OK"};});
 return {c,sent,methods,seen,starts,fileIds,offset:()=>offset};
}
test("attachment slash caption is data, not a native control",async()=>{
 const f=await fixture([{...photo,caption:"/new"}]);await until(()=>f.sent.length===1);expect(f.seen[0]?.text).toBe("Attached file message:\n/new");expect(f.seen[0]?.images).toHaveLength(1);
});
test("stop aborts outstanding attachment download and sends no late reply",async()=>{
 const f=await fixture([photo],{slow:true});await until(()=>f.methods.includes("download"));await f.c.stop();await Bun.sleep(250);expect(f.seen).toHaveLength(0);expect(f.sent).toHaveLength(0);
});
test("concurrent topic attachments wait for permits instead of dropping valid files",async()=>{
 const f=await fixture([photo,{...photo,message_thread_id:13}],{timeout:2000,spacing:40});await until(()=>f.sent.length===2);expect(f.seen).toHaveLength(2);expect(f.sent.map(x=>x.text)).toEqual(["OK","OK"]);
});
test("delayed primary attachment reaches core before later same-user text steer",async()=>{
 const f=await fixture([photo,{text:"later text"}],{slow:true,timeout:1500,holdMs:300});await until(()=>f.seen.length===2);expect(f.seen.map(x=>x.messageId)).toEqual(["1","2"]);
});
test("queued attachment stays FIFO and later text cannot pass it as steer",async()=>{
 const f=await fixture([{text:"first text"},photo,{text:"third text"}],{slow:true,timeout:1500,holdMs:300});await until(()=>f.seen.length===3);expect(f.seen.map(x=>x.messageId)).toEqual(["1","2","3"]);
});
test("getFile 429 blocks polling and final delivery through shared cooldown",async()=>{
 const f=await fixture([photo],{getFileStatus:429,timeout:2000});await until(()=>f.sent.length===1);const read=f.starts.find(x=>x.method==="getFile")!;expect(read).toBeDefined();expect(f.starts.filter(x=>x.at>read.at).every(x=>x.at-read.at>=990)).toBe(true);expect(f.seen).toHaveLength(0);
});
async function until(fn:()=>boolean){const end=Date.now()+3000;while(!fn()){if(Date.now()>end)throw new Error("condition timeout");await Bun.sleep(10);}}
const photo={photo:[{file_id:"photo_id",file_size:10,width:2,height:2}],caption:"describe"};
const replied={message_id:50,chat:{id:-9},message_thread_id:12,from:{id:99,is_bot:true},...photo,caption:"/ignore-replied-caption"};
for(const media of [photo,{document:{file_id:"image_doc",file_name:"image.png",mime_type:"image/png"}}]) test("reply-only image reaches current actor/topic: "+Object.keys(media)[0],async()=>{
 const f=await fixture([{text:"examine this",reply_to_message:{...replied,photo:undefined,...media}}]);await until(()=>f.sent.length===1);
 expect(f.fileIds).toEqual(["document" in media?"image_doc":"photo_id"]);expect(f.seen).toHaveLength(1);expect(f.seen[0]!.images).toEqual([{mimeType:"image/png",data:Buffer.from(await new Bun.Image(png).png().bytes()).toString("base64")}]);
 expect(f.seen[0]!.text).toBe("examine this");expect(f.seen[0]!.userId).toBe("7");expect(f.seen[0]!.threadKey).toBe("123:-9:12:7");expect(f.sent[0].message_thread_id).toBe(12);
});
test("reply image current slash is data and old caption is never joined",async()=>{
 const f=await fixture([{text:"/new",reply_to_message:replied}]);await until(()=>f.sent.length===1);expect(f.seen[0]!.text).toBe("Attached file message:\n/new");expect(f.fileIds).toEqual(["photo_id"]);
});
test("top-level image wins over replied image without duplicate download",async()=>{
 const f=await fixture([{...photo,photo:[{file_id:"current",width:2,height:2}],reply_to_message:replied}]);await until(()=>f.sent.length===1);expect(f.fileIds).toEqual(["current"]);
});
for(const reply of [{...replied,chat:{id:-10}},{...replied,message_thread_id:13},{...replied,message_thread_id:undefined},{...replied,message_id:"50"},{...replied,photo:[{file_id:"bad/id",width:2,height:2}]},{...replied,photo:undefined,document:{file_id:"txt",file_name:"notes.txt"}},{...replied,photo:undefined,voice:{file_id:"voice"}}]) test("invalid or unsupported replied media is visible without download: "+JSON.stringify(reply),async()=>{
 const f=await fixture([{text:"examine",reply_to_message:reply}]);await until(()=>f.sent.length===1);expect(f.sent[0].text).toContain("⚠️");expect(f.seen).toHaveLength(0);expect(f.fileIds).toHaveLength(0);
});
test("unauthorized reply image never downloads or reaches core",async()=>{
 const f=await fixture([{text:"examine",from:{id:8,is_bot:false},reply_to_message:replied}]);await until(()=>f.offset()===2);expect(f.fileIds).toHaveLength(0);expect(f.seen).toHaveLength(0);expect(f.sent).toHaveLength(0);
});
test("reply image actual forwarder to HTTP preserves image and current text",async()=>{
 const f=await fixture([{text:"examine",reply_to_message:replied}]);await until(()=>f.sent.length===1);
 const core=httpChannel(0),seen:InboundMessage[]=[];await core.start(async m=>{seen.push(m);return {status:"answered",text:"bridge OK"};});cleanup.push(()=>core.stop());
 expect(await createTelegramForwarder(core.url().origin)(f.seen[0]!)).toEqual({status:"answered",text:"bridge OK"});expect(seen).toHaveLength(1);expect(seen[0]!.images).toEqual(f.seen[0]!.images);expect(seen[0]!.text).toBe("Telegram message:\nexamine");
});
test("generic current attachment wins over reply image",async()=>{
 const f=await fixture([{voice:{file_id:"voice"},reply_to_message:replied}]);await until(()=>f.sent.length===1);expect(f.fileIds).toEqual(["voice"]);expect(f.seen[0]?.files).toHaveLength(1);expect(f.seen[0]?.images).toBeUndefined();expect(f.sent[0].text).toBe("OK");
});
test("reply image decode failure preserves original for core",async()=>{
 const f=await fixture([{text:"examine",reply_to_message:replied}],{bytes:Buffer.from("invalid")});await until(()=>f.sent.length===1);expect(f.fileIds).toEqual(["photo_id"]);expect(f.seen[0]?.files?.[0]?.data).toBe(Buffer.from("invalid").toString("base64"));expect(f.seen[0]?.images).toBeUndefined();expect(f.sent[0].text).toBe("OK");
});
test("stop during reply image download owns cleanup and suppresses late reply",async()=>{
 const f=await fixture([{text:"examine",reply_to_message:replied}],{slow:true,timeout:1500});await until(()=>f.methods.includes("download"));await f.c.stop();expect(f.seen).toHaveLength(0);expect(f.sent).toHaveLength(0);
});
test("poller admits caption/photo and preserves authorized topic and image bytes",async()=>{
 const f=await fixture([photo]);await until(()=>f.offset()===2);await until(()=>f.sent.length===1);
 expect(f.seen[0]?.text).toBe("describe");expect(f.seen[0]?.images).toEqual([{mimeType:"image/png",data:Buffer.from(await new Bun.Image(png).png().bytes()).toString("base64")}]);expect(f.seen[0]?.threadKey).toBe("123:-9:12:7");expect(f.sent[0].message_thread_id).toBe(12);expect(f.methods.filter(m=>m==="getFile")).toHaveLength(1);
});
test("unauthorized media never downloads or invokes core",async()=>{
 const f=await fixture([{...photo,from:{id:8,is_bot:false}}]);await until(()=>f.offset()===2);expect(f.methods).not.toContain("getFile");expect(f.seen).toHaveLength(0);expect(f.sent).toHaveLength(0);
});
test("UTF-8 document without caption reaches model as bounded text",async()=>{
 const f=await fixture([{document:{file_id:"doc_id",file_name:"notes.md",mime_type:"text/plain",file_size:12}}],{bytes:Buffer.from("안녕 notes")});await until(()=>f.sent.length===1);expect(f.seen[0]?.text).toContain("안녕 notes");expect(f.seen[0]?.text).toContain("notes.md");
});
for(const attachment of [{voice:{file_id:"voice",file_size:20971521}},{document:{file_id:"binary",file_name:"file.pdf",mime_type:"application/pdf",file_size:20971521}},{photo:[{file_id:"huge",file_size:20971521,width:2,height:2}]}])test("unsupported/oversized attachment gives visible notice, never core or download "+JSON.stringify(attachment),async()=>{
 const f=await fixture([attachment]);await until(()=>f.sent.length===1);expect(f.sent[0].text).toContain("⚠️");expect(f.seen).toHaveLength(0);expect(f.methods).not.toContain("getFile");
});
for(const options of [{path:"../secret"},{getFileStatus:500},{bytes:Buffer.alloc(20971521)},{slow:true}])test("download failure is bounded and visible "+Object.keys(options)[0],async()=>{
 const f=await fixture([photo],options);await until(()=>f.sent.length===1);expect(f.seen).toHaveLength(0);expect(f.sent[0].text).toContain("⚠️");expect(f.sent[0].text).not.toContain("test_only");
});
