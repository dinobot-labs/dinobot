import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { telegramAttachment, telegramMedia } from "../src/channels/telegram-media.ts";
import { httpChannel } from "../src/channels/http.ts";
import { createTelegramForwarder } from "../src/cli/telegram-run.ts";
import { materializeFiles } from "../src/core/message-files.ts";
import type { InboundMessage } from "../src/channels/types.ts";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=","base64");
async function receive(bytes: Uint8Array, name: string, inline: boolean, preview: boolean) {
 const dir = await mkdtemp(join(tmpdir(),"receive-first-"));
 const api = Bun.serve({hostname:"127.0.0.1",port:0,fetch(req) {
  if (!new URL(req.url).pathname.includes("/file/")) return Response.json({ok:true,result:{file_path:"documents/data",file_size:1}});
  let offset=0; return new Response(new ReadableStream({pull(c){if(offset===bytes.length){c.close();return;}const end=Math.min(offset+8192,bytes.length);c.enqueue(bytes.slice(offset,end));offset=end;}}));
 }});
 const core=httpChannel(0); let saved:InboundMessage|undefined;
 try {
  const selected=telegramAttachment({document:{file_id:"file",file_name:name,file_size:bytes.length}});
  expect(selected.error).toBeUndefined();
  const prepared=await telegramMedia(api.url.origin,"test",10000)({channel:"telegram",threadKey:"123:-9:12:7",messageId:"1",userId:"7",text:"/new"},{media:selected.reference!},new AbortController().signal);
  if ("status" in prepared) throw new Error("receipt rejected: "+JSON.stringify(prepared));
  expect(prepared.files).toHaveLength(1);
  expect(!!prepared.images?.length).toBe(preview);
  expect(prepared.text.includes("[Attached UTF-8 document:")).toBe(inline);
  await core.start(async m=>{saved=await materializeFiles(m,dir);return {status:"answered",text:"OK"};},async()=>{throw new Error("native execution forbidden");});
  expect(await createTelegramForwarder(core.url().origin)(prepared)).toEqual({status:"answered",text:"OK"});
  expect(saved!.threadKey).toBe("123:-9:12:7");expect(saved!.userId).toBe("7");
  expect(saved!.text).toContain("Attached file message:\n/new");
  const metadata=JSON.parse(saved!.text.split("\n").at(-1)!);
  expect(metadata.size).toBe(bytes.length);
  expect(metadata.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  expect(await readFile(metadata.path)).toEqual(Buffer.from(bytes));
 } finally {await core.stop();await api.stop(true);await rm(dir,{recursive:true,force:true});}
}
for(const [name,bytes,inline,preview] of [
 ["notes.txt",Buffer.alloc(65537,97),true,false],
 ["notes.md",Buffer.alloc(100*1024,97),true,false],
 ["large.txt",Buffer.alloc(100*1024+1,97),false,false],
 ["invalid.txt",Buffer.from([0xc3,0x28]),false,false],
 ["nul.txt",Buffer.from("a\0b"),false,false],
 ["broken.png",Buffer.from("not an image"),false,false],
 ["truncated.png",png.subarray(0,24),false,false],
 ["large.png",Buffer.concat([png,Buffer.alloc(2097153-png.length)]),false,true],
 ["small.png",png,false,true],
 ["unknown.bin",Buffer.from([0,255,2]),false,false],
] as const) test("receive -> real bridge -> storage preserves original: "+name,()=>receive(bytes,name,inline,preview));
test("excessive decoded pixels omit preview, not receipt",async()=>{
 const bytes=await new Bun.Image(png).resize(4097,4096).png().bytes();
 await receive(bytes,"pixels.png",false,false);
},20000);
test("conversion overflow preserves original JPEG without invalid preview",async()=>{
 // Deterministic encoded fixture, same xorshift BMP construction as images.test.ts.
 const width=2048,height=2048,bmp=Buffer.alloc(54+width*height*3);
 bmp.write("BM");bmp.writeUInt32LE(bmp.length,2);bmp.writeUInt32LE(54,10);bmp.writeUInt32LE(40,14);
 bmp.writeInt32LE(width,18);bmp.writeInt32LE(height,22);bmp.writeUInt16LE(1,26);bmp.writeUInt16LE(24,28);bmp.writeUInt32LE(width*height*3,34);
 let state=0x12345678;for(let i=54;i<bmp.length;i++){state^=state<<13;state^=state>>>17;state^=state<<5;bmp[i]=state&255;}
 const jpeg=await new Bun.Image(bmp).jpeg({quality:25}).bytes();
 expect(jpeg.length).toBeLessThan(2097152);expect((await new Bun.Image(jpeg).png().bytes()).length).toBeGreaterThan(2097152);
 await receive(jpeg,"compact.jpg",false,false);
},20000);
