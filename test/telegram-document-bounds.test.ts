import { expect, test } from "bun:test";
import { telegramMedia, telegramAttachment } from "../src/channels/telegram-media.ts";
import { httpChannel } from "../src/channels/http.ts";
import { createTelegramForwarder } from "../src/cli/telegram-run.ts";
import type { InboundMessage } from "../src/channels/types.ts";

const message: InboundMessage = {channel:"telegram",threadKey:"t",messageId:"m",userId:"u",text:""};
const bridge = "Telegram message:\n", slash = "Attached file message:\n", doc = "\n\n[Attached UTF-8 document: ";
const max = 100*1024 + 1024 + 128 + slash.length + doc.length + 2 + bridge.length;
async function prepare(bytes: Uint8Array, caption = "", name = "notes.txt") {
 const api = Bun.serve({hostname:"127.0.0.1",port:0,fetch(req) {
  return new URL(req.url).pathname.includes("/file/") ? new Response(bytes) : Response.json({ok:true,result:{file_path:"documents/file.txt",file_size:1}});
 }});
 try { return await telegramMedia(api.url.origin,"test",2000)({...message,text:caption},{media:JSON.stringify({kind:"text",id:"file",name})},new AbortController().signal); }
 finally { await api.stop(true); }
}
for (const [label, bytes] of [["ASCII",Buffer.alloc(100*1024,97)],["multibyte",Buffer.from("é".repeat(50*1024))]] as const) {
 test("actual media to forwarder to HTTP accepts exact 100 KiB " + label, async () => {
  const caption = "/" + "c".repeat(1023), name = "n".repeat(124)+".txt";
  const prepared = await prepare(bytes,caption,name);
  expect("status" in prepared).toBe(false);
  if ("status" in prepared) throw new Error("valid document rejected");
  const core = httpChannel(0), seen: InboundMessage[] = [];
  await core.start(async m => {seen.push(m);return {status:"answered",text:"OK"};});
  try {
   expect(await createTelegramForwarder(core.url().origin)(prepared)).toEqual({status:"answered",text:"OK"});
   expect(seen.map(m=>m.text)).toEqual([bridge+slash+caption+doc+name+"]\n"+bytes.toString("utf8")]);
   if(label === "ASCII") expect(seen[0]!.text.length).toBe(max);
  } finally { await core.stop(); }
 });
}
for (const [label, bytes] of [
 ["exact 64 KiB leading BOM",Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.alloc(65533,97)])],
 ["leading BOM with Unicode",Buffer.from("\uFEFF한é😀")],
 ["interior BOM with Unicode",Buffer.from("한\uFEFFé😀")],
] as const) test("actual media to forwarder to HTTP preserves bytes: " + label,async()=>{
 const prepared = await prepare(bytes);
 expect("status" in prepared).toBe(false);
 if ("status" in prepared) throw new Error("valid document rejected");
 const core = httpChannel(0), seen: InboundMessage[] = [];
 await core.start(async m=>{seen.push(m);return {status:"answered",text:"OK"};});
 try {
  expect(await createTelegramForwarder(core.url().origin)(prepared)).toEqual({status:"answered",text:"OK"});
  expect(seen).toHaveLength(1);
  const framing = bridge+doc+"notes.txt]\n";
  expect(seen[0]!.text.startsWith(framing)).toBe(true);
  const output = Buffer.from(seen[0]!.text.slice(framing.length),"utf8");
  console.log(JSON.stringify({case:label,inputBytes:bytes.length,outputBytes:output.length,unchanged:output.equals(bytes),inputPrefix:bytes.subarray(0,3).toString("hex"),outputPrefix:output.subarray(0,3).toString("hex")}));
  expect(output.length).toBe(bytes.length);
  expect(output.equals(bytes)).toBe(true);
 } finally {await core.stop();}
});
test("actual media bridge rejects streamed 20 MiB plus one before core",async()=>{
 const prepared = await prepare(Buffer.alloc(20*1024*1024+1,97));
 expect("status" in prepared).toBe(true);
 const core = httpChannel(0); let calls=0;
 await core.start(async()=>{calls++;return {status:"answered",text:"OK"};});
 try { if (!("status" in prepared)) await createTelegramForwarder(core.url().origin)(prepared); expect(calls).toBe(0); } finally {await core.stop();}
});
for(const [label,caption,name] of [["caption","c".repeat(1025),"notes.txt"],["filename","","n".repeat(125)+".txt"],["filename control","","bad\n.txt"],["filename path","","../notes.txt"],["caption slash","/"+"c".repeat(1024),"notes.txt"],["caption forged framing",slash+"/"+"c".repeat(1024),"notes.txt"]] as const) test("unsafe reference rejects but excessive caption only skips inline " + label,async()=>{
 const prepared=await prepare(Buffer.from("safe"),caption,name);expect("status" in prepared).toBe(label.startsWith("filename"));
 if (!("status" in prepared)) {expect(prepared.files).toHaveLength(1);expect(prepared.text).not.toContain("[Attached UTF-8 document:");}
 if("status" in prepared) expect(prepared.status).toBe("answered");
 // Forged stored text references remain rejected; the actual producer now safely selects generic storage.
 if(label.startsWith("filename")) expect(JSON.parse(telegramAttachment({document:{file_id:"file",file_name:name,mime_type:"text/plain"}}).reference!).kind).toBe("file");
});
test("HTTP limits preserve generic/native bounds and bound Telegram framed extension",async()=>{
 const core=httpChannel(0); let calls=0;
 const handler=async()=>{calls++;return {status:"answered" as const,text:"OK"};};
 await core.start(handler,handler);
 const post=async(channel:string,text:string,native=false)=>fetch(new URL(native?"/v1/native/messages":"/v1/messages",core.url()),{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...message,channel,text})});
 try {
  for(const channel of ["http","discord","slack","telegram"]) {
   expect((await post(channel,"x".repeat(65536))).status).toBe(200);
   expect((await post(channel,"x".repeat(65537))).status).toBe(400);
  }
  expect((await post("telegram",bridge+"x".repeat(max-bridge.length))).status).toBe(200);
  expect((await post("telegram",bridge+"x".repeat(max-bridge.length+1))).status).toBe(400);
  expect((await post("http",bridge+"x".repeat(max-bridge.length))).status).toBe(400);
  expect((await post("telegram","/model "+"x".repeat(65536-7),true)).status).toBe(200);
  expect((await post("telegram","/model "+"x".repeat(65537-7),true)).status).toBe(400);
  await expect(createTelegramForwarder(core.url().origin)({...message,text:"x".repeat(max-bridge.length+1)})).rejects.toThrow("Telegram core request failed");
  expect(calls).toBe(6);
 } finally {await core.stop();}
});
