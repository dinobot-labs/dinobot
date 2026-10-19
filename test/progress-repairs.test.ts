import { test, expect } from "bun:test";
import { renderRichText, safeLink } from "../src/channels/rich-text.ts";
import { NativeCooldown } from "../src/channels/native-cooldown.ts";
import { nativeProgress } from "../src/channels/native-progress.ts";
import { renderSlackText, storedSlackText, slackTextObject } from "../src/channels/slack-rich-text.ts";
import { safePreview } from "../src/channels/safe-preview.ts";
import { foldProgress, initialProgress, renderProgress } from "../src/channels/progress.ts";
test("oversized escaped link wrappers obey custom limit", () => {
 for (const platform of ["telegram", "slack"] as const) {
 const parts = renderRichText("[x](https://example.org/" + "&".repeat(490) + ")", platform, 1024);
 for (const p of parts) expect(p.length).toBeLessThanOrEqual(1024);
 }
});
test("Slack pipe targets are never link grammar", () => expect(safeLink("https://example.org/a|b")).toBe(false));
test("credential-shaped paths are suppressed", () => expect(safePreview({path:"/tmp/sk_live_1234567890abcdef"})).toBeUndefined());
test("Slack literal provenance and fallback keep original source", () => {
 const literal="\\*literal\\*";
 expect(slackTextObject(renderRichText(literal,"slack")[0]!, literal)).toEqual({type:"plain_text",text:literal});
 const mixed="**hello** x_y";
 expect(slackTextObject(renderRichText(mixed,"slack")[0]!, mixed)).toEqual({type:"plain_text",text:mixed});
 expect(storedSlackText(renderSlackText("**hello**")[0]!)).toEqual({type:"mrkdwn",text:"*hello*",verbatim:true});
 const long=mixed.repeat(600);const objects=renderSlackText(long).map(storedSlackText);
 expect(objects.map(o=>o.text).join("")).toBe(long);
 for(const o of objects){expect(o.type).toBe("plain_text");expect(o.text.length).toBeLessThanOrEqual(3000);}
 expect(storedSlackText(renderSlackText("`` `a` ``")[0]!).type).toBe("plain_text");
});
for (const platform of ["slack","discord"] as const) test(platform+" Retry-After120 is not capped at60", async () => {
 const fetch0=globalThis.fetch, now0=Date.now; let t=100000, writes=0;
 Date.now=()=>t; globalThis.fetch=(async()=>{writes++;return new Response(null,{status:429,headers:{"Retry-After":"120"}});}) as unknown as typeof fetch;
 const stop=new AbortController(); const r=nativeProgress(platform,{channel:"C1"},"https://example.org","",stop.signal,()=>{});
 try {r.event({type:"tool_start",id:"a",name:"read"});await r.tick();t+=61000;await r.tick();expect(writes).toBe(1);t+=58000;await r.tick();expect(writes).toBe(1);t+=1000;await r.tick();expect(writes).toBe(2);}
 finally {stop.abort();await r.finish({kind:"done"});globalThis.fetch=fetch0;Date.now=now0;}
});
test("todo current is a redacted summary not free text", () => {
 const s=foldProgress(initialProgress(0),{type:"todos",done:0,total:1,current:"deploy sk_live_1234567890abcdef"},0);
 expect(renderProgress(s,0)).not.toContain("sk_live_");
});

for (const platform of ["slack","discord"] as const) test(platform+" explicit abort owns late fetch and body cancellation settlement", async () => {
 const fetch0=globalThis.fetch;let rawResolve!:(r:Response)=>void, bodyResolve!:()=>void;
 const raw=new Promise<Response>(r=>rawResolve=r), cancelled=new Promise<void>(r=>bodyResolve=r);
 const tracked:Promise<unknown>[]=[];let calls=0, signal:AbortSignal|undefined;
 globalThis.fetch=(async (_url:any,init:any)=>{calls++;signal=init.signal;return raw;}) as typeof fetch;
 const stop=new AbortController(), r=nativeProgress(platform,{channel:"C1"},"https://example.org","",stop.signal,p=>tracked.push(p));
 try {
 r.event({type:"tool_start",id:"x",name:"read"});let tickDone=false;const tick=r.tick().then(()=>tickDone=true);
 await Bun.sleep(5);stop.abort();const finish=r.finish({kind:"failed",reason:"cancelled"});
 expect(signal?.aborted).toBe(true);expect(tickDone).toBe(false);expect(tracked.length).toBe(2);
 rawResolve(new Response(new ReadableStream({cancel(){return cancelled;}})));
 await Bun.sleep(10);expect(tickDone).toBe(false);expect(tracked.length).toBe(3);
 bodyResolve();await tick;await finish;const settled=await Promise.allSettled(tracked);expect(settled.filter(s=>s.status==="rejected")).toHaveLength(1);await r.tick();expect(calls).toBe(1);
 } finally {bodyResolve();rawResolve(new Response(null));stop.abort();globalThis.fetch=fetch0;}
 const pre=new AbortController();pre.abort();const sealed=nativeProgress(platform,{},"https://example.org","",pre.signal,()=>{});sealed.event({type:"tool_start",id:"y",name:"read"});await sealed.tick();await sealed.finish({kind:"done"});
});

test("native finish is bounded even when fetch ignores cancellation; raw ownership survives seal", async () => {
 const fetch0=globalThis.fetch;let resolve!:(r:Response)=>void;const raw=new Promise<Response>(r=>resolve=r);let calls=0;const tracked:Promise<unknown>[]=[];
 globalThis.fetch=(async()=>{calls++;return raw;}) as unknown as typeof fetch;
 const stop=new AbortController(),r=nativeProgress("discord",{},"https://example.org","",stop.signal,p=>tracked.push(p));
 try {r.event({type:"tool_start",id:"x",name:"read"});const ticking=r.tick();await Bun.sleep(5);const start=performance.now();await r.finish({kind:"done"});expect(performance.now()-start).toBeLessThan(6800);expect(calls).toBe(1);await r.tick();expect(calls).toBe(1);resolve(new Response(null));await ticking;await Promise.allSettled(tracked);}
 finally {resolve(new Response(null));stop.abort();globalThis.fetch=fetch0;}
},8000);

test("native cooldown is monotone and per target, not per reporter", () => {
 const now0=Date.now;let t=1000;Date.now=()=>t;
 try {const c=new NativeCooldown(target=>target.channel!);const a={channel:"A"},b={channel:"B"};c.limited(a,120000);c.limited(a,1000);expect(c.remaining(a)).toBe(120000);expect(c.remaining(b)).toBe(0);t+=61000;expect(c.remaining(a)).toBe(59000);t+=59000;expect(c.remaining(a)).toBe(0);}
 finally {Date.now=now0;}
});

import { retryDelay } from "../src/channels/messaging.ts";
test("overflow numeric Retry-After cannot fall back to an early retry", () => { expect(retryDelay("9".repeat(400))).toBe(Number.MAX_SAFE_INTEGER); });
test("grouped delayed receipts preserve maximum actual end", () => {
 let s=initialProgress(1000); for(const id of ["a","b"]) s=foldProgress(s,{type:"tool_start",id,name:"read",at:1000},10000);
 s=foldProgress(s,{type:"tool_end",id:"a",ok:true,at:9000},10000);s=foldProgress(s,{type:"tool_end",id:"b",ok:true,at:2000},10000);
 expect(s.recent[0]!.endedAt).toBe(9000);
});
test("Slack literal fallback preserves a boundary grapheme",()=>{
 const source="_"+"x".repeat(2998)+"e\u0301";const objects=renderSlackText(source).map(storedSlackText);
 expect(objects.map(o=>o.text).join("")).toBe(source); expect(objects[0]!.text.endsWith("e")).toBe(false);expect(objects[1]!.text).toBe("e\u0301");
});

test("grouped running duration continues after a partial end",()=>{
 let s=initialProgress(0);for(const id of ["a","b"])s=foldProgress(s,{type:"tool_start",id,name:"read",at:0},0);
 s=foldProgress(s,{type:"tool_end",id:"a",ok:true,at:1000},1000);expect(renderProgress(s,5000)).toContain("running 5s");
});
