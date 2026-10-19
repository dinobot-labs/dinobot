import { afterEach, expect, test } from "bun:test";
import { slackTextObject } from "../src/channels/slack-rich-text.ts";
import { renderRichText, safeLink, hasUnsafeLinks } from "../src/channels/rich-text.ts";
import { safePreview } from "../src/channels/safe-preview.ts";
import { foldProgress, initialProgress, renderProgress, parseProgressEvent } from "../src/channels/progress.ts";
import { agentProgress } from "../src/core/progress-events.ts";
import { nativeProgress } from "../src/channels/native-progress.ts";
import type { AgentEvent } from "@earendil-works/pi-durable";
import type { ProgressEvent } from "../src/channels/types.ts";

const visible = (s:string) => s.replace(/<\/?(?:b|i|s|code|pre)>/g, "").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&amp;/g,"&");
function balanced(s:string) {
 const stack:string[]=[];
 for (const m of s.matchAll(/<(\/?)(b|i|s|code|pre|a)(?: href="[^"]*")?>/g)) {
  if (m[1]) expect(stack.pop()).toBe(m[2]!); else stack.push(m[2]!);
 }
 expect(stack).toEqual([]);
}

test("rich Telegram headings, nested emphasis, literal HTML and safe links",()=>{
 const out=renderRichText("# Title\n\n**bold _italic_** <script>alert(1)</script> [safe](https://example.org/a?b=1&c=2)","telegram").join("");
 expect(out).toContain("<b>Title</b>"); expect(out).toContain("<b><i>italic</i></b>");
 expect(out).toContain("&lt;script&gt;"); expect(out).not.toContain("<script>");
 expect(out).toContain('<a href="https://example.org/a?b=1&amp;c=2">'); balanced(out);
});

test("Unicode code fences split without lost scalars, entities or formatting",()=>{
 const body="한😀é &<>".repeat(2000);
 for(const platform of ["telegram","slack"] as const){
  const parts=renderRichText("```ts\n"+body+"\n```",platform);
  expect(parts.length).toBeGreaterThan(2);
  for(const part of parts){expect(part.length).toBeLessThanOrEqual(platform==="telegram"?4096:3000);expect(part).not.toContain("�"); if(platform==="telegram")balanced(part);else expect((part.match(/```/g)??[]).length).toBe(2);}
  const text=platform==="telegram"?visible(parts.join("")):visible(parts.join("").replace(/```/g,""));
  expect(text).toBe(body+"\n");
 }
});

test("normal graphemes stay together; oversized graphemes degrade only at scalar boundaries",()=>{
 const source="a".repeat(4094)+"👩‍💻é"+"x".repeat(20);
 const parts=renderRichText(source,"telegram");
 expect(parts.join("")).toBe(source);expect(parts[1]).toStartWith("👩‍💻");
 const pathological="e"+"́".repeat(5000);
 const big=renderRichText(pathological,"telegram");expect(big.join("")).toBe(pathological);for(const p of big)expect(p.length).toBeLessThanOrEqual(4096);
});

test("malformed/unclosed markdown remains bounded and literal, no arbitrary HTML or unsafe links",()=>{
 for(const source of ["**unclosed _hi", "```js\n😀<x>&", "[bad](javascript:alert%281%29)", "<@U123> <!everyone>", "[secret](https://user:pass@example.org)", "~~~\ntext"]){
  for(const platform of ["telegram","slack"] as const){const parts=renderRichText(source,platform);for(const p of parts){expect(p.length).toBeLessThanOrEqual(4096);expect(p).not.toContain("<@U123>");expect(p).not.toContain("<!everyone>");if(platform==="telegram")balanced(p);} expect(parts.join("")).not.toContain('href="javascript:');}
 }
 for(const bad of ["javascript:x","data:text/html,x","https://u:p@example.org","https://example.org/\n", "tg://user?id=123"])expect(safeLink(bad)).toBe(false);
 expect(safeLink("https://example.org")).toBe(true);
 expect(hasUnsafeLinks("[x](javascript:alert%281%29)")).toBe(true);
 expect(hasUnsafeLinks("https://user:pass@example.org")).toBe(true);
 expect(hasUnsafeLinks("**native** [x](https://example.org)")).toBe(false);
 expect(hasUnsafeLinks("`[x](javascript:y)`")).toBe(false);
});

test("Slack unbalanced native delimiters fall back to literal plain text without mentions",()=>{
 expect(slackTextObject("**unclosed _hi &lt;@U123&gt;")).toEqual({type:"plain_text",text:"**unclosed _hi <@U123>"});
 expect(slackTextObject("*bold* and ```a_b``` ")).toMatchObject({type:"mrkdwn",verbatim:true});
});

test("default tool previews exclude commands, credentials, code, output and query strings",()=>{
 for(const args of [{command:"curl -H Authorization:secret https://example.org"},{path:".env"},{file_path:"credentials.json"},{code:"secret"},{url:"https://user:pass@example.org?token=abc"},{query:"sk-secret"},{description:"password=secret"},{pattern:"private-key"}])expect(safePreview(args)).toBeUndefined();
 expect(safePreview({command:"bun test --token=SECRET"})).toBe("bun test");
 expect(safePreview({path:"src/main.ts",content:"SECRET"})).toBe("file (.ts)");
});

test("receipt timing survives delayed observation and wire validation rejects bad times",()=>{
 let s=foldProgress(initialProgress(0),{type:"tool_start",id:"x",name:"read",at:1000},10000);
 s=foldProgress(s,{type:"tool_end",id:"x",ok:true,at:4500},11000);
 expect(renderProgress(s,20000)).toContain("done 3s");
 expect(parseProgressEvent({type:"tool_end",id:"x",ok:true,at:NaN})).toBeUndefined();
 expect(parseProgressEvent({type:"tool_start",id:"x",name:"read",at:-1})).toBeUndefined();
});

test("interleaving same tool after another line closes the correct duration and supports special IDs",()=>{
 let s=initialProgress(0);
 for(const [id,name,t] of [["a","read",0],["b","write",1000],["constructor","read",2000]] as const)s=foldProgress(s,{type:"tool_start",id,name},t);
 s=foldProgress(s,{type:"tool_end",id:"a",ok:false},3000);
 expect(s.recent[0]).toMatchObject({running:0,failed:true,endedAt:3000});expect(s.recent[2]!.running).toBe(1);
 expect(renderProgress(s,5000)).toContain("failed 3s");
 expect(renderProgress(s,5000)).toContain("running 3s");
 const before=s;s=foldProgress(s,{type:"tool_end",id:"unknown",ok:true},9000);expect(s).toBe(before);
 expect(foldProgress(s,{type:"heartbeat"},90000)).toBe(s);expect(renderProgress(s,90000)).toContain("새 활동 없음");
});

test("pending codemode calls are not running; inner hints survive updates; aborted cells pair once",()=>{
 const events:ProgressEvent[]=[];const map=agentProgress(e=>events.push(e),()=>0);
 const ev=(e:unknown)=>e as AgentEvent;
 map([ev({type:"tool_execution_update",toolCallId:"cell",toolName:"codemode",details:{codemodeCalls:[{id:1,name:"read",status:"pending"}]}})]);
 expect(events.filter(e=>e.type==="tool_start")).toEqual([]);
 const update=ev({type:"tool_execution_update",toolCallId:"cell",toolName:"codemode",details:{codemodeCalls:[{id:1,name:"read",status:"running",preview:"src/main.ts"}]}});
 map([update,update,ev({type:"tool_execution_end",toolCallId:"cell",toolName:"codemode"}),update]);
 expect(events.filter(e=>e.type==="tool_start")).toEqual([{type:"tool_start",id:"cell/1",name:"read",preview:"file (.ts)"}]);
 expect(events.filter(e=>e.type==="tool_end"&&e.id==="cell/1")).toEqual([{type:"tool_end",id:"cell/1",ok:false}]);
});

const originalFetch=globalThis.fetch;afterEach(()=>{globalThis.fetch=originalFetch;});
for(const platform of ["slack","discord"] as const)test(platform+" common progress uses stored destination, updates once and seals on stop",async()=>{
 const writes:{url:string,body:any}[]=[];const tracked:Promise<unknown>[]=[];
 globalThis.fetch=(async(url:any,init:any)=>{writes.push({url:String(url),body:JSON.parse(init.body)});return Response.json(platform==="slack"?{ok:true,ts:"1791165000.000002"}:{id:"1"});}) as typeof fetch;
 const stop=new AbortController();const target={channel:"C123",thread_ts:"1791165000.000001"};
 const reporter=nativeProgress(platform,target,"https://example.org/api","TEST_ONLY",stop.signal,p=>tracked.push(p));
 reporter.event({type:"tool_start",id:"1",name:"read",preview:"src/a.ts"});await reporter.tick();
 await Bun.sleep(3100);await reporter.tick();
 expect(writes.length).toBe(2);
 if(platform==="slack"){expect(writes[0]!.body.thread_ts).toBe(target.thread_ts);expect(writes[1]!.body.ts).toBe("1791165000.000002");expect(writes[1]!.url).toEndWith("/chat.update");expect(writes[1]!.body.blocks[0].text.type).toBe("plain_text");}
 else {expect(writes[0]!.url).toBe("https://example.org/api");expect(writes[0]!.body.allowed_mentions.parse).toEqual([]);}
 stop.abort();await reporter.finish({kind:"failed",reason:"cancelled"});await reporter.tick();expect(writes.length).toBe(2);await Promise.all(tracked);
},10000);
