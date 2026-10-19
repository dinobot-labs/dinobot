import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { telegramAttachment, telegramMedia } from "../src/channels/telegram-media.ts";
import { telegramChannel } from "../src/channels/telegram.ts";
import { httpChannel } from "../src/channels/http.ts";
import { createTelegramForwarder } from "../src/cli/telegram-run.ts";
import { FILE_BYTES, materializeFiles, parseInboundFiles } from "../src/core/message-files.ts";
import { channelHandler } from "../src/core/channel-handler.ts";
import { createNativeModelHandler } from "../src/core/native-model-commands.ts";
import type { Commands } from "../src/commands/index.ts";
import { openBot } from "../src/core/bot.ts";
import type { InboundMessage } from "../src/channels/types.ts";
import { SCALED_GATE_POLICY } from "./fixtures/gate-policy.ts";
const cleanup: (()=>Promise<unknown>)[]=[];
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});
const noCommands: Commands={list:()=>[],find:()=>{throw new Error("attachment triggered command lookup");},run:()=>{throw new Error("attachment triggered command");},answer:()=>false};
const message: InboundMessage={channel:"telegram",threadKey:"123:-9:12:7",messageId:"1",userId:"7",text:""};
const document = {file_id:"generic",file_name:"unknown.weird",mime_type:"application/x-unknown"};
async function directory() { const dir=await mkdtemp(join(tmpdir(),"generic-file-"));cleanup.push(()=>rm(dir,{recursive:true,force:true}));return dir; }
async function prepare(bytes: Uint8Array, metadata: any=document, options:{status?:number;advertised?:number;path?:string}={}) {
 let downloads=0;
 const api=Bun.serve({hostname:"127.0.0.1",port:0,fetch(req) {
  if(new URL(req.url).pathname.includes("/file/")) {
   downloads++;
   let offset=0;
   return new Response(new ReadableStream({pull(c){if(offset===bytes.length){c.close();return;}const end=Math.min(offset+8192,bytes.length);c.enqueue(bytes.slice(offset,end));offset=end;}}),{status:options.status??200});
  }
  return Response.json({ok:true,result:{file_path:options.path??"documents/generic.bin",file_size:options.advertised??1}});
 }});cleanup.push(async()=>api.stop(true));
 const selected=telegramAttachment({document:metadata});
 const result=selected.error?{status:"answered" as const,text:selected.error}:await telegramMedia(api.url.origin,"test",4000)(message,{media:selected.reference!},new AbortController().signal);
 return {result,downloads};
}
test("unknown and missing names including empty files",async()=>{
 for(const file_name of [undefined,"","unknown.weird","../../evil.exe","bad\n.txt","x".repeat(300)]) {
  const selected=telegramAttachment({document:{file_id:"generic",file_name,file_size:0,mime_type:"application/x-unknown"}});
  expect(selected.error).toBeUndefined();expect(JSON.parse(selected.reference!).kind).toBe("file");
  const {result}=await prepare(Buffer.alloc(0),{file_id:"generic",file_name,file_size:0});
  expect("status" in result).toBe(false);
  if (!("status" in result)) { expect(result.files?.[0]?.data).toBe("");expect(result.files?.[0]?.name.length).toBeLessThanOrEqual(128); }
 }
});
for(const key of ["voice","audio","video","video_note","animation","sticker"]) test(key+" is opaque file data",()=>{
 expect(JSON.parse(telegramAttachment({[key]:{file_id:"generic"}}).reference!).kind).toBe("file");
});
for (const file_name of ["data.bin","notes.txt","image.png"]) test("actual stream accepts 20 MiB and rejects +1 despite advertised 1 byte: "+file_name,async()=>{
 const accepted=await prepare(Buffer.alloc(FILE_BYTES,42),{file_id:"file",file_name});expect("status" in accepted.result).toBe(false);
 if (!("status" in accepted.result)) expect(Buffer.from(accepted.result.files![0]!.data,"base64").length).toBe(FILE_BYTES);
 const rejected=await prepare(Buffer.alloc(FILE_BYTES+1),{file_id:"file",file_name});expect("status" in rejected.result).toBe(true);expect(rejected.downloads).toBe(1);
});
test("advertised oversize, failed download and traversal metadata never yield input",async()=>{
 for(const options of [{advertised:FILE_BYTES+1},{status:500},{path:"../escape"}]) {
  const f=await prepare(Buffer.from("secret"),document,options);expect("status" in f.result).toBe(true);
  if("status" in f.result && f.result.status==="answered")expect(f.result.text).not.toContain("secret");
  if(options.advertised || options.path)expect(f.downloads).toBe(0);
 }
 expect(telegramAttachment({document:{...document,file_size:FILE_BYTES+1}}).error).toBeDefined();
});
test("unknown remote extension is URL encoded, not a type rejection",async()=>{
 const f=await prepare(Buffer.from("bytes"),document,{path:"documents/file.한+?#%"});expect("status" in f.result).toBe(false);expect(f.downloads).toBe(1);
});
test("wire validates canonical base64 and finite count before storage",()=>{
 for(const value of [[{data:"a"}],[{data:"YQ==junk"}],[{data:"YR=="}],[{data:""},{data:""}],[{data:"A".repeat(Math.ceil(FILE_BYTES/3)*4+4)}]])expect(typeof parseInboundFiles(value)).toBe("string");
 expect(parseInboundFiles([{data:""}])).toEqual([{name:"attachment",mimeType:"application/octet-stream",data:""}]);
});
test("core local storage sanitizes display metadata and cannot overwrite supplied path",async()=>{
 const dir=await directory();const bytes=Buffer.from([0,255,1,13]);
 const stored=await materializeFiles({...message,files:[{name:"../../evil.exe\n",mimeType:"",data:bytes.toString("base64")}]},dir);
 const metadata=JSON.parse(stored.text.split("\n").at(-1)!);
 expect(isAbsolute(metadata.path)).toBe(true);expect(metadata.path.startsWith(join(dir,".dinobot","attachments"))).toBe(true);
 expect(metadata.name).toBe(".._.._evil.exe_");expect(metadata.mimeType).toBe("application/octet-stream");expect(metadata.size).toBe(4);expect(metadata.sha256).toHaveLength(64);
 expect(await readFile(metadata.path)).toEqual(bytes);expect(stored.files).toBeUndefined();
 if(process.platform!=="win32")expect((await stat(metadata.path)).mode&0o777).toBe(0o600);
 const second=await materializeFiles({...message,files:[{name:"same",mimeType:"",data:""}]},dir);expect(JSON.parse(second.text.split("\n").at(-1)!).path).not.toBe(metadata.path);
});
test("symlink or junction attachment directory is refused without writing outside",async()=>{
 const dir=await directory(),outside=await directory();await mkdir(join(dir,".dinobot"));
 await symlink(outside,join(dir,".dinobot","attachments"),process.platform==="win32"?"junction":"dir");
 await expect(materializeFiles({...message,files:[{name:"x",mimeType:"",data:"YQ=="}]},dir)).rejects.toThrow("Attachment storage unavailable");
 expect(await readdir(outside)).toEqual([]);
});
test("actual 20 MiB wire reaches HTTP and is stored on receiver; native endpoint refuses files",async()=>{
 const dir=await directory();const prepared=await prepare(Buffer.alloc(FILE_BYTES,42));
 if("status" in prepared.result)throw new Error("unexpected download rejection");
 let saved:InboundMessage|undefined;const core=httpChannel(0);
 await core.start(async m=>{saved=await materializeFiles(m,dir);return {status:"answered",text:"OK"};},async()=>{throw new Error("must not invoke native handler");});cleanup.push(()=>core.stop());
 expect(await createTelegramForwarder(core.url().origin)(prepared.result)).toEqual({status:"answered",text:"OK"});
 const metadata=JSON.parse(saved!.text.split("\n").at(-1)!);expect((await stat(metadata.path)).size).toBe(FILE_BYTES);
 const response=await fetch(new URL("/v1/native/messages",core.url()),{method:"POST",body:JSON.stringify({...message,text:"/new",files:[{name:"x",mimeType:"",data:""}]})});
 expect(response.status).toBe(400);await response.arrayBuffer();
});
test("old core gets no caption-only POST when file capability is absent",async()=>{
 let posts=0;const old=Bun.serve({hostname:"127.0.0.1",port:0,fetch(req){if(req.method==="POST")posts++;return new Response("Not found",{status:404});}});cleanup.push(async()=>old.stop(true));
 const result=await createTelegramForwarder(old.url.origin)({...message,files:[{name:"x",mimeType:"",data:""}]});
 expect(result.status).toBe("answered");if(result.status==="answered")expect(result.text).toContain("upgrade");expect(posts).toBe(0);
});
async function botFixture() {
 const dir=await directory();const faux=fauxProvider({provider:"faux",models:[{id:"test"}]});const models=createModels();models.setProvider(faux.provider);
 const options={models,defaultModel:{provider:"faux",modelId:"test"},toolMode:"direct" as const,plugins:[],workspaceRoot:dir,curation:{enabled:false}};
 const open=async()=>{const bot=await openBot({...options,storage:await openNodeSqliteStorage(join(dir,"core.db"))},context);cleanup.push(()=>bot.close(context));return bot;};
 return {dir,faux,models,open};
}
test("poller -> getFile -> sidecar -> HTTP -> durable core -> actual read tool; duplicate and reopen keep path",async()=>{
 const f=await botFixture();const bot=await f.open();const seen:string[]=[];let metadata:any;
 f.faux.setResponses([ctx=>{
  const user=ctx.messages.filter(m=>m.role==="user").at(-1)!;
  const text=typeof user.content==="string"?user.content:JSON.stringify(user.content);
  seen.push(text);
  // User content is text blocks in the actual model interface.
  const plain=typeof user.content==="string"?user.content:(user.content as any[]).filter(b=>b.type==="text").map(b=>b.text).join("\n");
  metadata=JSON.parse(plain.split("\n").at(-1)!);
  return fauxAssistantMessage(fauxToolCall("read",{path:metadata.path}),{stopReason:"toolUse"});
 },ctx=>{expect(JSON.stringify(ctx.messages)).toContain("opaque-readable-payload");return fauxAssistantMessage("received file");}]);
 const core=httpChannel(0);const native=createNativeModelHandler(bot,f.models,context);await core.start(channelHandler(core,bot,noCommands,context,native),native);cleanup.push(()=>core.stop());
 const sent:any[]=[];let downloaded=0;
 const update={update_id:1,message:{message_id:1,from:{id:7,is_bot:false},chat:{id:-9,type:"supergroup"},message_thread_id:12,caption:"/new",document:{...document,file_name:"../../payload.unknown"}}};
 const api=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(req){
  // Production startup now registers its advisory menu; not a media request.
  if(new URL(req.url).pathname.endsWith("/setMyCommands")) return Response.json({ok:true,result:true});
  const path=new URL(req.url).pathname;
  if(path.includes("/file/")){downloaded++;return new Response("opaque-readable-payload");}
  const method=path.split("/").at(-1),body=await req.json() as any;
  if(method==="getWebhookInfo")return Response.json({ok:true,result:{url:""}});
  if(method==="getUpdates")return Response.json({ok:true,result:body.offset<=1?[update]:[]});
  if(method==="getFile")return Response.json({ok:true,result:{file_path:"documents/data.bin"}});
  if(method==="sendMessage"){sent.push(body);return Response.json({ok:true,result:{message_id:99}});}
  throw new Error("unexpected "+method);
 }});cleanup.push(async()=>api.stop(true));
 process.env.GENERIC_TOKEN="123:generic_test";
 const channel=telegramChannel({mode:"polling",botTokenEnv:"GENERIC_TOKEN",databasePath:join(f.dir,"sidecar.db"),allowedUserIds:["7"],allowedChatIds:["-9"],progress:"off",requestTimeoutMs:4000},{apiBase:api.url.origin,gatePolicy:SCALED_GATE_POLICY});cleanup.push(()=>channel.stop());
 await channel.start(createTelegramForwarder(core.url().origin));
 const end=Date.now()+10000;while(!sent.length){if(Date.now()>end)throw new Error("delivery timeout");await Bun.sleep(10);}
 await channel.stop();await core.stop();
 expect(downloaded).toBe(1);expect(sent[0].message_thread_id).toBe(12);expect(sent[0].text).toBe("received file");
 expect(seen[0]).toContain("Attached file message:");expect(seen[0]).not.toContain(Buffer.from("opaque-readable-payload").toString("base64"));
 expect(await readFile(metadata.path,"utf8")).toBe("opaque-readable-payload");
 const before=await readdir(join(f.dir,".dinobot","attachments"));
 await bot.close(context);const reopened=await f.open();
 const duplicate=await reopened.handle({...message,files:[{name:"changed",mimeType:"",data:""}]},context);
 expect(duplicate.status).toBe("answered");expect(f.faux.state.callCount).toBe(2);expect(await readdir(join(f.dir,".dinobot","attachments"))).toEqual(before);
 expect(await readFile(metadata.path,"utf8")).toBe("opaque-readable-payload");
},20000);
test("storage failure is a visible core reply with no model call or partial admission",async()=>{
 const f=await botFixture();const bot=await f.open();await writeFile(join(f.dir,".dinobot"),"block directory");
 const core=httpChannel(0);await core.start(m=>bot.handle(m,context));cleanup.push(()=>core.stop());
 const prepared=await prepare(Buffer.from([0xc3,0x28]),{file_id:"file",file_name:"invalid.txt"});
 if ("status" in prepared.result) throw new Error("receipt rejected");
 const reply=await createTelegramForwarder(core.url().origin)(prepared.result);
 expect(reply.status).toBe("answered");if(reply.status==="answered")expect(reply.text).toContain("storage unavailable");expect(f.faux.state.callCount).toBe(0);
});
