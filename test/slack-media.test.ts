import { describe, expect, test } from "bun:test";
import { slackAttachments, slackMedia, uploadSlackText } from "../src/channels/slack-media.ts";
import type { InboundMessage } from "../src/channels/types.ts";
const message: InboundMessage = {channel:"slack",threadKey:"C1:1.2",messageId:"1.2",userId:"U1",text:"/reset"};
const target = {channel:"C1",thread_ts:"1.2"};
const signal = () => new AbortController().signal;
const file = {id:"F123",name:"code.ts",mimetype:"text/plain",url_private:"https://files.slack.com/files-pri/test"};
const media = {media:JSON.stringify([file.id])};
type Call = {url:string;init:RequestInit};
function transport(responses: (Response | ((call:Call)=>Response | Promise<Response>))[]) {
 const calls: Call[] = [];
 const fetcher = (async (url: unknown, init: RequestInit = {}) => {
  const call = {url:String(url),init}; calls.push(call);
  const next = responses.shift();
  if (!next) throw new Error("unexpected call");
  return typeof next === "function" ? await next(call) : next;
 }) as typeof fetch;
 return {calls,fetch:fetcher};
}
const metadata = (overrides = {}) => Response.json({ok:true,file:{...file,...overrides}});
const allocation = (overrides = {}) => Response.json({ok:true,file_id:"F123",upload_url:"https://files.slack.com/upload/v1/abc",...overrides});
const completion = () => Response.json({ok:true,files:[{id:"F123"}]});
const rejected = (result: unknown) => expect(result).toMatchObject({status:"answered",text:expect.stringContaining("could not be processed")});

describe("Slack media", () => {
 test("references contain only IDs, max four and unsupported types visible", () => {
  expect(slackAttachments({files:[{...file,token:"secret",url_private:"https://evil.test"}]})).toEqual({reference:'["F123"]'});
  expect(slackAttachments({files:[{id:"F123"}]}).reference).toBeDefined();
  expect(slackAttachments({files:Array(5).fill(file)}).error).toBeDefined();
  expect(slackAttachments({files:[{...file,mimetype:"application/pdf"}]}).error).toBeDefined();
  expect(slackAttachments({files:[{...file,size:65537}]}).error).toBeDefined();
  expect(slackAttachments({files:[{id:"../../etc/passwd"}]}).error).toBeDefined();
  expect(slackAttachments({})).toEqual({});
 });
 test("fresh metadata, fixed API auth, UTF8 and slash caption escape", async () => {
  const mock = transport([metadata(),new Response("const x = '안녕';")]);
  const result = await slackMedia("secret",1000,mock)(message,media,signal());
  expect(result).toMatchObject({text:"Attached file message:\n/reset\n\n[Attached UTF-8 document: code.ts]\nconst x = '안녕';"});
  expect(mock.calls.map(c=>c.url)).toEqual(["https://slack.com/api/files.info",file.url_private]);
  expect(JSON.parse(mock.calls[0]!.init.body as string)).toEqual({file:"F123"});
  for (const c of mock.calls) { expect(c.init.redirect).toBe("error"); expect(new Headers(c.init.headers).get("authorization")).toBe("Bearer secret"); expect(c.init.signal).toBeInstanceOf(AbortSignal); }
 });
 for (const url of ["https://evil.test/x","https://files.slack.com.evil.test/x","http://files.slack.com/x","https://user@files.slack.com/x","https://files.slack.com:443/x","https://files.slack.com:8443/x","file:///etc/passwd"]) {
  test("reject private URL "+url, async () => {
   const mock = transport([metadata({url_private:url})]);
   rejected(await slackMedia("secret",1000,mock)(message,media,signal())); expect(mock.calls.length).toBe(1);
  });
 }
 test("redirect, size, MIME, malformed UTF8 and metadata failures are notices", async () => {
  for (const responses of [
   [metadata(),new Response(null,{status:302,headers:{location:"https://evil.test"}})],
   [metadata(),new Response("x".repeat(65537))],
   [metadata(),new Response(new Uint8Array([255]))],
   [metadata(),new Response("a\0b")],
   [metadata({size:65537})],
   [metadata({mimetype:"application/pdf"})],
   [metadata({id:"FOTHER"})],
   [metadata({mimetype:"image/png",name:"image.png"}),new Response("not an image")],
   [new Response("x".repeat(65537))],
  ]) {
   const mock = transport(responses);
   rejected(await slackMedia("secret",1000,mock)(message,media,signal()));
   expect(mock.calls.length).toBeLessThanOrEqual(2);
  }
 });
 test("four text files at per-file boundary, fifth rejected before network", async () => {
  const ids = ["F1","F2","F3","F4"];
  const mock = transport(ids.flatMap(id=>[metadata({id}),new Response("x".repeat(65536))]));
  const result = await slackMedia("secret",1000,mock)(message,{media:JSON.stringify(ids)},signal());
  expect("status" in result).toBe(false); expect(mock.calls.length).toBe(8);
  const noCalls = transport([]);
  rejected(await slackMedia("secret",1000,noCalls)(message,{media:JSON.stringify([...ids,"F5"])},signal()));
  expect(noCalls.calls.length).toBe(0);
 });
 test("valid image decoded and normalized; forged and huge pixels rejected", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3XcAAAAASUVORK5CYII=","base64");
  const mock = transport([metadata({mimetype:"image/png",name:"image.png"}),new Response(png)]);
  const result = await slackMedia("secret",1000,mock)(message,media,signal());
  expect(result).toMatchObject({images:[{mimeType:"image/png",data:expect.any(String)}]});
  const huge = Buffer.from(png); huge.writeUInt32BE(100000,16); huge.writeUInt32BE(100000,20);
  for (const bytes of [huge,Buffer.alloc(2097153)]) {
   const bad = transport([metadata({mimetype:"image/png",name:"image.png"}),new Response(bytes)]);
   rejected(await slackMedia("secret",1000,bad)(message,media,signal()));
  }
 });
 test("JPEG GIF and WebP use the shared decoder, not MIME alone", async () => {
  const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7","base64");
  const variants = [
   {mimetype:"image/gif",bytes:gif},
   {mimetype:"image/jpeg",bytes:await new Bun.Image(gif).jpeg().bytes()},
   {mimetype:"image/webp",bytes:await new Bun.Image(gif).webp().bytes()},
  ];
  for (const {mimetype,bytes} of variants) {
   const mock = transport([metadata({mimetype,name:"image"}),new Response(bytes)]);
   expect(await slackMedia("secret",1000,mock)(message,media,signal())).toMatchObject({images:[{mimeType:"image/png",data:expect.any(String)}]});
  }
 });
 test("abort before fetch and during streamed read; timeout cancels reader", async () => {
  const controller = new AbortController(); controller.abort(); const mock = transport([]);
  await expect(slackMedia("secret",1000,mock)(message,media,controller.signal)).rejects.toThrow(); expect(mock.calls.length).toBe(0);
  for (const cancel of [true,false]) {
   const control = new AbortController(); let cancelled = false;
   const pending = transport([metadata(),new Response(new ReadableStream({cancel(){cancelled=true;}}))]);
   const promise = slackMedia("secret",20,pending)(message,media,control.signal);
   if (cancel) { setTimeout(()=>control.abort(),5); await expect(promise).rejects.toThrow(); }
   else rejected(await promise);
   expect(cancelled).toBe(true);
  }
 });
});

describe("Slack external text upload", () => {
 test("allocation then raw unauthenticated upload then completion at fixed destination", async () => {
  const mutable = {...target};
  const mock = transport([() => {mutable.channel="COTHER";mutable.thread_ts="9.9";return allocation();},new Response("OK"),completion()]);
  const response = await uploadSlackText("secret",mutable,"안녕",signal(),mock);
  expect(await response.json()).toEqual({ok:true,ts:"1.2"});
  expect(mock.calls.map(c=>c.url)).toEqual(["https://slack.com/api/files.getUploadURLExternal","https://files.slack.com/upload/v1/abc","https://slack.com/api/files.completeUploadExternal"]);
  expect(JSON.parse(mock.calls[0]!.init.body as string)).toEqual({filename:"dinobot-response.txt",length:6});
  expect(Buffer.from(mock.calls[1]!.init.body as Uint8Array).toString()).toBe("안녕");
  expect(new Headers(mock.calls[1]!.init.headers).has("authorization")).toBe(false);
  expect(JSON.parse(mock.calls[2]!.init.body as string)).toEqual({files:[{id:"F123",title:"dinobot-response.txt"}],channel_id:"C1",thread_ts:"1.2"});
  for (const [i,c] of mock.calls.entries()) {expect(c.init.redirect).toBe("error"); expect(c.init.signal).toBeInstanceOf(AbortSignal); if(i!==1)expect(new Headers(c.init.headers).get("authorization")).toBe("Bearer secret");}
 });
 test("upload rejects attacker URL and invalid IDs before bytes leave", async () => {
  for (const override of [{upload_url:"https://evil.test/upload/x"},{upload_url:"https://files.slack.com:443/upload/x"},{upload_url:"https://u@files.slack.com/upload/x"},{upload_url:"https://files.slack.com/not-upload"},{file_id:"../x"}]) {
   const mock = transport([allocation(override)]);
   expect(await (await uploadSlackText("secret",target,"x",signal(),mock)).json()).toEqual({ok:false,error:"file_upload_failed"}); expect(mock.calls.length).toBe(1);
  }
 });
 test("size boundary uses bytes and does not allocate oversized output", async () => {
  const mock = transport([]);
  expect(await (await uploadSlackText("secret",target,"é".repeat(131073),signal(),mock)).json()).toMatchObject({ok:false}); expect(mock.calls.length).toBe(0);
  const exact = transport([allocation(),new Response("OK"),completion()]);
  expect(await (await uploadSlackText("secret",target,"x".repeat(262144),signal(),exact)).json()).toMatchObject({ok:true});
 });
 test("no retry, fallback or duplicate completion on stage failures", async () => {
  for (const responses of [[new Response("bad")],[allocation(),new Response(null,{status:302})],[allocation(),new Response("x".repeat(16385))],[allocation(),new Response("OK"),Response.json({ok:false,error:"bad"})],[allocation(),new Response("OK"),Response.json({ok:true})],[allocation(),new Response("OK"),()=>{throw new Error("ambiguous completion");}]]) {
   const mock = transport(responses);
   expect(await (await uploadSlackText("secret",target,"x",signal(),mock)).json()).toMatchObject({ok:false});
   expect(mock.calls.filter(c=>c.url.endsWith("completeUploadExternal")).length).toBeLessThanOrEqual(1);
  }
 });
 test("pre-abort and bounded upload response timeout", async () => {
  const controller = new AbortController(); controller.abort(); const none = transport([]);
  await expect(uploadSlackText("secret",target,"x",controller.signal,none)).rejects.toThrow(); expect(none.calls.length).toBe(0);
  let cancelled = false;
  const mock = transport([allocation(),new Response(new ReadableStream({cancel(){cancelled=true;}}))]);
  expect(await (await uploadSlackText("secret",target,"x",signal(),{...mock,timeout:20})).json()).toMatchObject({ok:false});
  expect(cancelled).toBe(true); expect(mock.calls.length).toBe(2);
 });
 test("stalled429 body preserves header lower bound even when owner deadline aborts",async()=>{
  const controller=new AbortController();let cancelled=false;
  const mock=transport([new Response(new ReadableStream({cancel(){cancelled=true;}}),{status:429,headers:{"retry-after":"120"}})]);
  const timer=setTimeout(()=>controller.abort(),10);
  try{const response=await uploadSlackText("secret",target,"x",controller.signal,mock);expect(response.status).toBe(429);expect(Number(response.headers.get("retry-after"))).toBeGreaterThanOrEqual(120);expect(cancelled).toBe(true);}
  finally{clearTimeout(timer);}
 });
 test("unverifiable completion is uncertain while explicit rejection is definitive",async()=>{
  for(const result of [new Response("{broken"),Response.json({ok:true}),Response.json({ok:true,files:[]})]){
   const mock=transport([allocation(),new Response("OK"),result]);
   expect((await uploadSlackText("secret",target,"x",signal(),mock)).status).toBe(503);
  }
  const denied=transport([allocation(),new Response("OK"),Response.json({ok:false,error:"not_in_channel"})]);
  expect((await uploadSlackText("secret",target,"x",signal(),denied)).status).toBe(400);
 });
 test("upload preserves429 lower bounds and network uncertainty for marked owner recovery", async () => {
  for (const stage of [0,1,2]) {
   const responses: Parameters<typeof transport>[0] = [allocation(),new Response("OK"),completion()];
   responses[stage] = Response.json({retry_after:120},{status:429,headers:{"retry-after":"60"}});
   const mock = transport(responses);
   const response = await uploadSlackText("secret",target,"x",signal(),mock);
   expect(response.status).toBe(429);expect(Number(response.headers.get("retry-after"))).toBeGreaterThanOrEqual(120);
   expect(mock.calls.length).toBe(stage+1);
  }
  const mock = transport([allocation(),new Response("OK"),()=>{throw Error("network response lost");}]);
  const response=await uploadSlackText("secret",target,"x",signal(),mock);
  expect(response.status).toBe(503);expect(await response.json()).toEqual({ok:false,error:"file_upload_failed"});
  expect(mock.calls.length).toBe(3);
 });
 test("cancellation at every stage stops subsequent calls", async () => {
  for (const stage of [0,1,2]) {
   const controller = new AbortController();
   const responses: Parameters<typeof transport>[0] = [allocation(),new Response("OK"),completion()];
   responses[stage] = ({init}) => { expect(init.signal).toBeInstanceOf(AbortSignal); controller.abort(); throw new DOMException("aborted","AbortError"); };
   const mock = transport(responses);
   await expect(uploadSlackText("secret",target,"x",controller.signal,mock)).rejects.toThrow(); expect(mock.calls.length).toBe(stage+1);
  }
 });
});
