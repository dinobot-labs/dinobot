import { afterEach, expect, test } from "bun:test";
import { slackProgress } from "../src/channels/slack-progress.ts";
import { NativeCooldown } from "../src/channels/native-cooldown.ts";

const original = globalThis.fetch;
const now = Date.now;
afterEach(() => { globalThis.fetch = original; Date.now = now; });
const target = {channel:"C1",thread_ts:"1.0",recipient_team_id:"T1",recipient_user_id:"U1"};
type Call = {method:string; body:any; signal:AbortSignal};
function harness(reply: (call:Call) => Response | Promise<Response> = () => Response.json({ok:true,ts:"2.0"})) {
 const calls:Call[] = [], tracked:Promise<unknown>[] = [];
 const stop = new AbortController(), cooldown = new NativeCooldown(t => t.channel!);
 globalThis.fetch = ((url: string | URL | Request, init:RequestInit) => {
  const call = {method:String(url).split("/").at(-1)!,body:JSON.parse(String(init.body)),signal:init.signal as AbortSignal};
  calls.push(call); return Promise.resolve(reply(call));
 }) as typeof fetch;
 const reporter = slackProgress(target,"test",stop.signal,p=>tracked.push(p),cooldown)!;
 return {calls,tracked,stop,cooldown,reporter};
}

test("actual concurrent IDs, done before flush, native API contracts and final cleanup", async () => {
 let clock = now(); Date.now = () => clock;
 const {calls,reporter:r} = harness();
 r.event({type:"draft",text:"private answer snapshot"}); await r.tick(); expect(calls).toHaveLength(0);
 r.event({type:"tool_start",id:"a",name:"read",detail:"file.ts"});
 r.event({type:"tool_start",id:"b",name:"read",detail:"file.ts"});
 r.event({type:"tool_end",id:"a",ok:true});
 await Promise.all([r.tick(),r.tick()]);
 expect(calls).toHaveLength(1);
 expect(calls[0]!.body).toMatchObject({...target,task_display_mode:"plan"});
 expect(calls[0]!.body.chunks.slice(1)).toEqual([
  {type:"task_update",id:"a",title:"read： file.ts",status:"complete"},
  {type:"task_update",id:"b",title:"read： file.ts",status:"in_progress"},
 ]);
 r.event({type:"tool_end",id:"b",ok:false}); await r.tick(); expect(calls).toHaveLength(1);
 clock += 1500; await r.tick();
 expect(calls[1]!.method).toBe("chat.appendStream"); expect(calls[1]!.body.ts).toBe("2.0");
 r.event({type:"tool_start",id:"c",name:"write"});
 await r.finish({kind:"done"});
 expect(calls[2]!.method).toBe("chat.stopStream");
 expect(calls[2]!.body.chunks.at(-1).status).toBe("error");
 expect(JSON.stringify(calls.map(c=>c.body))).not.toContain("private answer");
 for (const c of calls) expect(c.body.chunks.every((v:any)=>["plan_update","task_update"].includes(v.type))).toBe(true);
 r.event({type:"tool_start",id:"late",name:"late"}); await r.tick(); await r.finish({kind:"done"}); expect(calls).toHaveLength(3);
});

test("detailed text fallback splits Slack sections at3000 without losing draft text",async()=>{
 const {calls,reporter:r}=harness(c=>Response.json(c.method==="chat.startStream"?{ok:false,error:"missing_scope"}:{ok:true,ts:"3.0"}));
 for(let i=0;i<8;i++)r.event({type:"tool_start",id:String(i),name:"read",detail:"context detail ".repeat(8)});
 r.event({type:"draft",text:"😀".repeat(2000)});await r.tick();
 const post=calls.find(c=>c.method==="chat.postMessage")!;expect(post).toBeDefined();
 expect(post.body.text.length).toBeGreaterThan(3000);
 for(const block of post.body.blocks)expect(block.text.text.length).toBeLessThanOrEqual(3000);
 expect(post.body.blocks.map((b:any)=>b.text.text).join("")).toBe(post.body.text);
 await r.finish({kind:"done"});
});

test("recent eight bounded titles neutralize mentions, aliases, secrets and preserve emoji", async () => {
 const {calls,reporter:r} = harness();
 for (let i=0;i<12;i++) r.event({type:"tool_start",id:String(i),name:"<@U1> :wave: 😀",detail:"token=secret " + "😀".repeat(300)});
 await r.tick();
 const chunks = calls[0]!.body.chunks;
 expect(chunks).toHaveLength(9); expect(chunks[1].id).toBe("4");
 for (const chunk of chunks.slice(1)) {
  expect(chunk.title.length).toBeLessThanOrEqual(256);
  expect(chunk.title).toContain("😀"); expect(chunk.title).toContain("[redacted]");
  expect(chunk.title).not.toContain("<@"); expect(chunk.title).not.toContain(":wave:"); expect(chunk.title).not.toContain("secret");
 }
 await r.finish({kind:"done"});
});

test("429 header recorded immediately and shared cooldown forbids all early sends", async () => {
 let clock = now(); Date.now = () => clock;
 const {calls,reporter:r,cooldown} = harness(() => new Response("",{status:429,headers:{"retry-after":"60"}}));
 r.event({type:"tool_start",id:"a",name:"read"}); await r.tick();
 expect(cooldown.remaining(target)).toBeGreaterThanOrEqual(60000);
 clock += 1500; await r.tick(); expect(calls).toHaveLength(1);
 await r.finish({kind:"done"}); expect(calls).toHaveLength(1);
});

test("unsupported and missing_scope switch to one detailed text rail, never another stream", async () => {
 for (const error of ["unknown_method","missing_scope"]) {
  let clock = now(); Date.now = () => clock;
  const {calls,reporter:r} = harness(c => Response.json(c.method === "chat.startStream" ? {ok:false,error} : {ok:true,ts:"3.0"}));
  r.event({type:"tool_start",id:"a",name:"read",detail:"specific-file.ts"});
  r.event({type:"draft",text:"snapshot one"}); r.event({type:"draft",text:"snapshot two"});
  await r.tick();
  expect(calls.map(c=>c.method)).toEqual(["chat.startStream","chat.postMessage"]);
  expect(calls[1]!.body.text).toContain("specific-file.ts"); expect(calls[1]!.body.text).toContain("snapshot two");
  expect(calls[1]!.body.text).not.toContain("snapshot one");
  clock += 4000; await r.tick(); clock += 1000; await r.finish({kind:"done"});
  expect(calls.filter(c=>c.method === "chat.startStream")).toHaveLength(1);
 }
});

test("authorization declines suppress without fallback", async () => {
 for (const error of ["invalid_auth","not_allowed_token_type","no_permission","access_denied","not_in_channel"]) {
  const {calls,reporter:r} = harness(() => Response.json({ok:false,error}));
  r.event({type:"tool_start",id:"a",name:"read"}); await r.tick(); await r.tick(); await r.finish({kind:"done"});
  expect(calls.map(c=>c.method)).toEqual(["chat.startStream"]);
 }
});

test("off and missing thread anchor use no native stream", async () => {
 const {calls,stop,cooldown} = harness();
 expect(slackProgress(target,"",stop.signal,()=>{},cooldown,"off")).toBeUndefined();
 const r = slackProgress({channel:"C1"},"",stop.signal,()=>{},cooldown)!;
 r.event({type:"tool_start",id:"a",name:"read"}); await r.tick();
 expect(calls[0]!.method).toBe("chat.postMessage"); stop.abort(); await r.finish({kind:"done"});
});

test("abort ends bounded wait but original request remains tracked; no later calls", async () => {
 let release!: (r:Response) => void;
 const raw = new Promise<Response>(resolve => { release=resolve; });
 const {calls,tracked,reporter:r,stop} = harness(() => raw);
 r.event({type:"tool_start",id:"a",name:"read"}); const ticking = r.tick();
 expect(tracked).toContain(raw); stop.abort(); await ticking; await r.finish({kind:"done"});
 expect(calls[0]!.signal.aborted).toBe(true);
 release(Response.json({ok:true,ts:"2.0"})); await Promise.allSettled(tracked); await r.tick(); expect(calls).toHaveLength(1);
});

test("finish bounded at six seconds even if raw final request ignores abort", async () => {
 let release!: (r:Response) => void;
 const raw = new Promise<Response>(resolve => { release=resolve; });
 const {calls,tracked,reporter:r} = harness(c => c.method === "chat.stopStream" ? raw : Response.json({ok:true,ts:"2.0"}));
 r.event({type:"tool_start",id:"a",name:"read"}); await r.tick();
 const started = performance.now(); await r.finish({kind:"done"});
 expect(performance.now()-started).toBeLessThan(6500); expect(tracked).toContain(raw);
 expect(calls.at(-1)!.signal.aborted).toBe(true);
 release(Response.json({ok:true})); await Promise.allSettled(tracked); await r.tick(); expect(calls).toHaveLength(2);
}, 8000);

test("evicted published tasks receive terminal cleanup in bounded batches", async () => {
 let clock = now(); Date.now = () => clock;
 const {calls,reporter:r} = harness();
 for (let i=0;i<8;i++) r.event({type:"tool_start",id:String(i),name:"read"});
 await r.tick();
 for (let i=8;i<16;i++) r.event({type:"tool_start",id:String(i),name:"read"});
 r.event({type:"tool_end",id:"0",ok:true});
 clock += 1500; await r.tick();
 expect(calls[1]!.body.chunks.slice(1).every((t:any)=>t.status !== "in_progress")).toBe(true);
 expect(calls[1]!.body.chunks[1].status).toBe("complete");
 clock += 1500; await r.tick();
 expect(calls[2]!.body.chunks[1].id).toBe("8");
 r.event({type:"tool_end",id:"8",ok:true}); await r.finish({kind:"done"});
 expect(calls[3]!.body.chunks[1]).toMatchObject({id:"8",status:"complete"});
 for (const call of calls) expect(call.body.chunks.length).toBeLessThanOrEqual(9);
});

test("unsupported append closes existing stream before falling back once", async () => {
 let clock = now(); Date.now = () => clock;
 const {calls,reporter:r,stop} = harness(c => Response.json(c.method === "chat.appendStream" ? {ok:false,error:"missing_scope"} : {ok:true,ts:"2.0"}));
 r.event({type:"tool_start",id:"a",name:"read"}); await r.tick();
 r.event({type:"tool_end",id:"a",ok:true}); clock += 1500; await r.tick();
 expect(calls.map(c=>c.method)).toEqual(["chat.startStream","chat.appendStream","chat.stopStream","chat.postMessage"]);
 stop.abort(); await r.finish({kind:"done"});
});

test("shared cooldown acquired by another writer blocks append and stop", async () => {
 let clock = now(); Date.now = () => clock;
 const {calls,reporter:r,cooldown} = harness();
 r.event({type:"tool_start",id:"a",name:"read"}); await r.tick();
 cooldown.limited(target,120000);
 r.event({type:"tool_end",id:"a",ok:true}); clock+=1500; await r.tick(); await r.finish({kind:"done"});
 expect(calls).toHaveLength(1);
});
