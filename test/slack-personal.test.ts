import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, linkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SLACK_USER_SCOPES, SLACK_BOT_SCOPES, verifySlackUserToken, requireSlackAppMatch, buildSlackManifest, type SlackFetch } from "../src/setup/slack.ts";
import { SlackPersonalClient, SlackRateLimit, boundedBytes, slackFileUrl } from "../src/plugins/slack_personal/client.ts";
import { createSlackPersonalPlugin, requireLocalOwner, transferPath } from "../src/plugins/slack_personal/index.ts";
import { SlackMonitor, type Watch } from "../src/plugins/slack_personal/monitor.ts";
import { createPrivateFile } from "../src/telegram-private-files/index.ts";
import { loadPlugin } from "../src/plugins/types.ts";
const dirs: string[] = [];
const temp = () => { const path = mkdtempSync(join(tmpdir(), "slack-personal-")); dirs.push(path); return path; };
afterEach(() => { for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true }); });
const ok = (data: object, scopes?: readonly string[]) => Response.json({ ok: true, ...data }, { headers: scopes ? { "x-oauth-scopes": scopes.join(",") } : {} });
const userFetch = (data: object = {team_id:"T123",user_id:"U123"}, scopes: readonly string[] = SLACK_USER_SCOPES): SlackFetch => async (_, init) => { expect(init.redirect).toBe("error"); return ok(data, scopes); };

describe("personal setup", () => {
 test("manifest is opt-in and user has no write scopes", () => { expect(buildSlackManifest("x").oauth_config.scopes.user).toBeUndefined(); expect(buildSlackManifest("x",true).oauth_config.scopes.user).toEqual(SLACK_USER_SCOPES); expect(SLACK_USER_SCOPES.some(s => s.includes("write"))).toBe(false); });
 test("owner derived from auth; team mismatch, bot user, unknown/write/missing scope denied", async () => {
  expect((await verifySlackUserToken("xoxp-test", "T123", {fetch:userFetch()})).ownerUserId).toBe("U123");
  for (const fetch of [userFetch({team_id:"T999",user_id:"U123"}), userFetch({team_id:"T123",user_id:"U123",bot_id:"B123"}), userFetch(undefined,[...SLACK_USER_SCOPES,"chat:write"]),userFetch(undefined,[])]) await expect(verifySlackUserToken("xoxp-test", "T123", {fetch})).rejects.toThrow();
  await expect(verifySlackUserToken("xoxb-test", "T123", {fetch:userFetch()})).rejects.toThrow();
  await expect(verifySlackUserToken("xoxp-test", "T123", {fetch:async()=>Response.json({ok:false,error:"token_revoked"})})).rejects.toThrow("revoked");
 });
 test("bot/app mismatch and unverified scopes fail closed", () => {
  const bot = {teamId:"T123",teamName:"team",botUserId:"UBOT",botName:"bot",appId:"A123",missingScopes:[]};
  expect(requireSlackAppMatch(bot,{appId:"A123"})).toBe("A123");
  expect(()=>requireSlackAppMatch(bot,{appId:"A999"})).toThrow("app-mismatch");
  expect(()=>requireSlackAppMatch(bot,{})).toThrow("app-mismatch");
  expect(()=>requireSlackAppMatch({...bot,missingScopes:["chat:write"]},{appId:"A123"})).toThrow("missingScope");
 });
 test("network error cannot echo credentials", async () => { await expect(verifySlackUserToken("xoxp-secret", "T123", {fetch:async()=>{throw new Error("xoxp-secret");}})).rejects.toThrow("network"); });
});

describe("personal client", () => {
 test("bot-only reading and sending never require or use a user credential",async()=>{
  const tokens:string[]=[];const c=new SlackPersonalClient(undefined,"xoxb-bot",async(_,init)=>{tokens.push(new Headers(init.headers).get("authorization")!);return ok({});});
  await c.request("conversations.history");await c.request("chat.postMessage");expect(tokens).toEqual(["Bearer xoxb-bot","Bearer xoxb-bot"]);
  await expect(c.request("search.messages")).rejects.toThrow("optional");expect(tokens).toHaveLength(2);
 });
 test("user reads, bot sends, arbitrary methods forbidden; redirects disabled", async () => {
  const tokens: string[]=[];
  const c = new SlackPersonalClient("xoxp-user","xoxb-bot",async(_,init)=>{ tokens.push(new Headers(init.headers).get("authorization")!); expect(init.redirect).toBe("error"); return ok({}); });
  await c.request("conversations.history"); await c.request("chat.postMessage",{channel:"C123",text:"hi"});
  expect(tokens).toEqual(["Bearer xoxp-user","Bearer xoxb-bot"]);
  await expect(c.request("chat.delete")).rejects.toThrow("not allowed");
 });
 test("bounded pagination exposes continuation, detects loops and missing continuation", async () => {
  let n=0; const c = new SlackPersonalClient("u","b",async()=>ok({messages:[{ts:String(++n)}],response_metadata:{next_cursor:"next"}}));
  expect(await c.pages("conversations.history",{},1)).toMatchObject({complete:false,nextCursor:"next",pages:1});
  await expect(c.pages("conversations.history",{},5)).rejects.toThrow("Repeated");
  const incomplete = new SlackPersonalClient("u","b",async()=>ok({messages:[],has_more:true}));
  expect((await incomplete.pages("conversations.history",{})).complete).toBe(false);
 });
 test("429 persists Retry-After without hammering or retrying a send", async () => {
  let now=1000,n=0; const c = new SlackPersonalClient("u","b",async()=>{n++;return new Response("",{status:429,headers:{"retry-after":"120"}});},()=>now);
  await expect(c.request("chat.postMessage")).rejects.toBeInstanceOf(SlackRateLimit);
  await expect(c.request("conversations.list")).rejects.toBeInstanceOf(SlackRateLimit); expect(n).toBe(1);
  now+=120001; await expect(c.request("conversations.list")).rejects.toBeInstanceOf(SlackRateLimit); expect(n).toBe(2);
 });
 test("file hosts, redirects, stream size and upload credential separation", async () => {
  for(const url of ["http://files.slack.com/a","https://files.slack.com.evil/a","https://user@files.slack.com/a","https://files.slack.com:443/a#x"]) expect(()=>slackFileUrl(url)).toThrow();
  await expect(boundedBytes(new Response("12345"),4)).rejects.toThrow("large");
  const c = new SlackPersonalClient("u","b",async(url,init)=>{ expect(init.redirect).toBe("error"); if(url.endsWith("files.getUploadURLExternal")) return ok({file_id:"F123",upload_url:"https://files.slack.com/upload/v1/test"}); if(url.includes("/upload/")){expect(new Headers(init.headers).has("authorization")).toBe(false);return new Response("ok");}return ok({files:[{id:"F123"}]});});
  expect((await c.upload("a.txt",new Uint8Array([1]),"C123")).ok).toBe(true);
  await expect(c.upload("a",new Uint8Array(0),"C123")).rejects.toThrow();
  const malicious = new SlackPersonalClient("u","b",async()=>ok({file:{size:1,url_private:"https://evil.test/file"}}));
  await expect(malicious.download("F123")).rejects.toThrow("Untrusted");
 });
 test("transfer policy rejects traversal, alternate streams, protected files and hardlinks", () => {
  const root=temp(); const secret=join(root,"secret");writeFileSync(secret,"private");
  for(const name of ["../secret","C:/secret","a:b","NUL.txt","CON","a."])expect(()=>transferPath(root,name,[])).toThrow();
  expect(()=>transferPath(root,"secret",[secret])).toThrow("Protected");
  linkSync(secret,join(root,"linked"));expect(()=>transferPath(root,"linked",[])).toThrow();
 });
});

test("every remote/unknown caller denied before any personal tool execution", async () => {
 for(const channel of ["slack","http","telegram","discord",undefined]) await expect(requireLocalOwner({conversationId:"1",channel:async()=>channel})).rejects.toThrow("local");
 await expect(requireLocalOwner({channel:async()=>"tui"})).rejects.toThrow();
 await requireLocalOwner({conversationId:"1",channel:async()=>"tui"});
 const dir=temp();createPrivateFile(join(dir,"bot"),"xoxb-test");createPrivateFile(join(dir,"user"),"xoxp-test");let calls=0;
 const fetch: SlackFetch=async(url,init)=>{calls++;if(url.endsWith("bots.info"))return ok({bot:{app_id:"A123"}});return new Headers(init.headers).get("authorization")?.includes("xoxp") ? ok({team_id:"T123",user_id:"U123"},SLACK_USER_SCOPES):ok({team_id:"T123",user_id:"UBOT",bot_id:"B123"},SLACK_BOT_SCOPES);};
 const plugin=await loadPlugin(createSlackPersonalPlugin({fetch,timers:false}),{botTokenFile:join(dir,"bot"),userTokenFile:join(dir,"user"),teamId:"T123",ownerUserId:"U123"},{dataDir:dir,resolveDependency:async()=>undefined});
 if(Array.isArray(plugin))throw new Error(plugin.join(";"));
 try { const initial=calls; for(const tool of plugin.tools)await expect(tool.execute({}, {conversationId:"1",channel:async()=>"slack"})).rejects.toThrow("local");expect(calls).toBe(initial); const status=await plugin.tools.find(t=>t.name==="slack_personal_status")!.execute({}, {conversationId:"1",channel:async()=>"tui"}); expect(status).toMatchObject({enabled:false,ownerUserId:"U123"}); } finally {await plugin.close?.();}
});

test("bot-only plugin permits owner private DM reads and bot sends, but never remote monitoring",async()=>{
 const dir=temp();createPrivateFile(join(dir,"bot"),"xoxb-test");const requests:string[]=[];
 const fetch:SlackFetch=async(url,init)=>{expect(new Headers(init.headers).get("authorization")).toBe("Bearer xoxb-test");requests.push(url);if(url.endsWith("bots.info"))return ok({bot:{app_id:"A123"}});if(url.endsWith("auth.test"))return ok({team_id:"T123",user_id:"UBOT",bot_id:"B123"},SLACK_BOT_SCOPES);return ok({messages:[{text:"bot accessible"}]});};
 const plugin=await loadPlugin(createSlackPersonalPlugin({fetch,timers:false}),{botTokenFile:join(dir,"bot"),teamId:"T123",ownerUserId:"U123"},{dataDir:dir,resolveDependency:async()=>undefined});if(Array.isArray(plugin))throw new Error(plugin.join(";"));
 const call={conversationId:"1",channel:async()=>"slack",slackPrincipal:async()=>({appId:"A123",teamId:"T123",userId:"U123",channelId:"D123"})};
 const tool=(name:string)=>plugin.tools.find(t=>t.name === "slack_personal_"+name)!;
 try {expect(await tool("status").execute({},call)).toMatchObject({readIdentity:"bot",access:"local-or-owner-private-dm"});expect(await tool("history").execute({channel:"C123"},call)).toMatchObject({complete:true});await tool("send").execute({channel:"C123",text:"explicit request"},call);expect(requests.at(-1)).toEndWith("chat.postMessage");await expect(tool("monitor").execute({enabled:true,channels:["C123"],timeZone:"UTC"},call)).rejects.toThrow("locally");const count=requests.length;await expect(tool("history").execute({channel:"C123"},{...call,slackPrincipal:async()=>({...await call.slackPrincipal(),userId:"UOTHER"})})).rejects.toThrow();expect(requests).toHaveLength(count);}finally{await plugin.close?.();}
});

test("owner private DM authorization rejects other users, app/team mismatch, shared and forged text",async()=>{
 const owner={userId:"U123",teamId:"T123",appId:"A123"};const p={...owner,channelId:"D123"};
 const call={conversationId:"1",channel:async()=>"slack",slackPrincipal:async()=>p};
 await requireLocalOwner(call,owner);
 for(const bad of [{...p,userId:"UOTHER"},{...p,teamId:"T999"},{...p,appId:"A999"},{...p,channelId:"C123"},{...p,channelId:"G123"}])await expect(requireLocalOwner({...call,slackPrincipal:async()=>bad},owner)).rejects.toThrow();
 await expect(requireLocalOwner({conversationId:call.conversationId,channel:call.channel},owner)).rejects.toThrow();
 await expect(requireLocalOwner({...call,channel:async()=>"http"},owner)).rejects.toThrow();
});

const watch: Watch={conversationId:"10",channels:["D123"],timeZone:"UTC",quietStart:0,quietEnd:0,summaries:false};
function monitorWorld(path: string) {
 let now=Date.parse("2026-10-01T12:00:00Z");let messages: object[]=[];let replies: object[]=[];const calls:string[]=[];
 const client=new SlackPersonalClient("u","b",async(url)=>{const method=url.split("/").pop()!;calls.push(method);if(method==="conversations.history")return ok({messages});if(method==="conversations.replies")return ok({messages:replies});if(method==="chat.getPermalink")return ok({permalink:"https://example.slack.com/archives/D123/p123"});throw new Error(method);},()=>now);
 return {client,calls,get now(){return now;},set now(v){now=v;},set messages(v:object[]){messages=v;},set replies(v:object[]){replies=v;},make:()=>new SlackMonitor(path,client,"U123",()=>now,false)};
}
describe("durable monitoring",()=>{
 test("old roots discover new threaded mentions with fair durable cursors and no old-message notification",async()=>{
  const path=join(temp(),"state.sqlite");let now=1000000;const calls:URLSearchParams[]=[];const notices:string[]=[];
  const client=new SlackPersonalClient("u","b",async(url,init)=>{
   const a=new URLSearchParams(String(init.body));
   if(url.endsWith("conversations.history"))return ok({messages:[{ts:"100.1",user:"UOTHER",text:"old <@U123>"},{ts:"101.1",user:"UOTHER",text:"old"}]});
   if(url.endsWith("chat.getPermalink"))return ok({permalink:"https://example.slack.com/archives/C123/p123"});
   calls.push(a);return ok({messages:[{ts:a.get("ts") === "100.1" ? "1001.1" : "1002.1",thread_ts:a.get("ts"),user:"UOTHER",text:"new <@U123> reply"}],response_metadata:{next_cursor:a.get("ts") === "100.1" && !a.get("cursor") ? "next" : ""}});
  },()=>now);
  let m=new SlackMonitor(path,client,"U123",()=>now,false);m.configure({...watch,channels:["C123"]});now+=3000;const wake=async(r:{text:string})=>{notices.push(r.text);return "admitted" as const;};
  m.start({wake});await m.tick();await m.tick();await m.close();
  m=new SlackMonitor(path,client,"U123",()=>now,false);m.start({wake});await m.tick();
  try {expect(calls.map(a=>a.get("ts"))).toEqual(["100.1","101.1","100.1"]);expect(calls[2]!.get("cursor")).toBe("next");expect(calls[2]!.get("latest")).toBe(calls[0]!.get("latest"));expect(notices).toHaveLength(2);expect(notices.every(n=>n.includes("new <@U123> reply"))).toBe(true);}finally{await m.close();}
 });
 test("more than 100 tracked roots receive fair service rather than lexicographic starvation",async()=>{
  const path=join(temp(),"state.sqlite");const seen:string[]=[];
  const client=new SlackPersonalClient("u","b",async(url,init)=>{if(url.endsWith("conversations.history"))return ok({messages:[]});seen.push(new URLSearchParams(String(init.body)).get("ts")!);return ok({messages:[]});});
  const m=new SlackMonitor(path,client,"U123",()=>1000000,false);m.configure(watch);
  for(let i=0;i<105;i++)m.db.query("INSERT INTO state VALUES (?,?)").run("thread:D123:"+i,JSON.stringify({channel:"D123",ts:`${i}.1`,oldest:"1000",cursor:"",turn:0}));
  try {m.start({wake:async()=>"admitted"});await m.tick();for(let i=1;i<105;i++)await m.tick();expect(new Set(seen).size).toBe(105);expect(seen).toHaveLength(105);}finally{await m.close();}
 });
 test("due deadlines cannot starve behind 100 future keys and drain more than 100 exactly once",async()=>{
  const w=monitorWorld(join(temp(),"state.sqlite"));const m=w.make();m.configure(watch);const keys:string[]=[];
  for(let i=0;i<100;i++)m.deadline("D123",`1.${String(i).padStart(6,"0")}`,w.now+86400000);
  for(let i=0;i<105;i++)m.deadline("D123",`9.${String(i).padStart(6,"0")}`,w.now+1000);
  w.now+=2000;m.start({wake:async r=>{keys.push(r.key);return "admitted";}});await m.tick();
  expect(keys).toHaveLength(10);
  for(let i=0;i<11;i++)await m.tick();
  expect(keys).toHaveLength(105);expect(new Set(keys).size).toBe(105);
  expect(m.db.query<{n:number},[]>("SELECT count(*) n FROM state WHERE key LIKE 'deadline:%'").get()!.n).toBe(100);
  await m.tick();expect(keys).toHaveLength(105);await m.close();
 });
 test("dedup, restart, quiet hours and host duplicate recovery; never sends",async()=>{
  const w=monitorWorld(join(temp(),"state.sqlite"));let m=w.make();m.configure({...watch,quietStart:12,quietEnd:13});const delivered:string[]=[];const wake=async(r:{key:string})=>{delivered.push(r.key);return "admitted" as const;};
  w.messages=[{ts:String(w.now/1000+1),text:"please review tomorrow",user:"UOTHER"}];w.now+=2000;m.start({wake});await m.tick();expect(delivered).toHaveLength(0);await m.close();
  w.now+=3600_000;m=w.make();m.start({wake});await m.tick();expect(delivered).toHaveLength(2);await m.tick();expect(delivered).toHaveLength(2);expect(w.calls.some(s=>s.includes("postMessage"))).toBe(false);await m.close();
 });
 test("owner answer suppresses unanswered; explicit deadlines and bounded summary cite originals",async()=>{
  const w=monitorWorld(join(temp(),"state.sqlite"));const m=w.make();m.configure({...watch,summaries:true});const texts:string[]=[];
  const ts=String(w.now/1000+1);w.messages=[{ts,text:"request tomorrow?",user:"UOTHER"}];w.now+=2000;m.start({wake:async r=>{texts.push(r.text);return "admitted";}});await m.tick();
  m.deadline("D123",ts,w.now+500);w.now+=3600_000;w.messages=[{ts:String(w.now/1000),text:"done",user:"U123"}];await m.tick();
  expect(texts.some(t=>t.startsWith("Possible unanswered"))).toBe(false);expect(texts.some(t=>t.startsWith("Explicitly registered")&&t.includes("https://example.slack.com"))).toBe(true);expect(texts.some(t=>t.startsWith("Summarize")&&t.includes("permalink"))).toBe(true);await m.close();
 });
 test("incremental cursor window survives restart and advances only after complete page",async()=>{
  const path=join(temp(),"state.sqlite");let now=1000000;const args:URLSearchParams[]=[];
  const client=new SlackPersonalClient("u","b",async(_,init)=>{const a=new URLSearchParams(String(init.body));args.push(a);return ok({messages:[],response_metadata:{next_cursor:a.get("cursor") ? "" : "continue"}});},()=>now);
  let m=new SlackMonitor(path,client,"U123",()=>now,false);m.configure(watch);now+=1000;m.start({wake:async()=>"admitted"});await m.tick();await m.close();
  now+=5000;m=new SlackMonitor(path,client,"U123",()=>now,false);m.start({wake:async()=>"admitted"});await m.tick();
  expect(args[1]!.get("cursor")).toBe("continue");expect(args[1]!.get("latest")).toBe(args[0]!.get("latest"));expect(args[1]!.get("oldest")).toBe(args[0]!.get("oldest"));expect(args[0]!.get("inclusive")).toBe("true");
  await m.tick();expect(args[2]!.get("oldest")).toBe(args[0]!.get("latest"));await m.close();
 });
 test("crash after wake admission reuses host key; unavailable stays pending",async()=>{
  const w=monitorWorld(join(temp(),"state.sqlite"));let m=w.make();m.configure(watch);w.messages=[{ts:String(w.now/1000+1),text:"hi",user:"UOTHER"}];w.now+=2000;
  const keys=new Set<string>();let admitted=0;let unavailable=true;
  const wake=async(r:{key:string})=>{if(unavailable)return "unavailable" as const;if(keys.has(r.key))return "duplicate" as const;keys.add(r.key);admitted++;return "admitted" as const;};
  m.start({wake});await m.tick();expect(admitted).toBe(0);unavailable=false;await m.tick();expect(admitted).toBe(1);
  m.db.exec("UPDATE outbox SET delivered=0");await m.close();m=w.make();m.start({wake});await m.tick();expect(admitted).toBe(1);expect(m.db.query<{n:number},[]>("SELECT count(*) n FROM outbox WHERE delivered=0").get()!.n).toBe(0);await m.close();
 });
 test("quiet-hour unanswered outbox is suppressed when owner answers before delivery",async()=>{
  const w=monitorWorld(join(temp(),"state.sqlite"));const m=w.make();m.configure({...watch,quietStart:12,quietEnd:14});const texts:string[]=[];w.messages=[{ts:String(w.now/1000+1),text:"question",user:"UOTHER"}];w.now+=2000;
  m.start({wake:async r=>{texts.push(r.text);return "admitted";}});await m.tick();w.now+=3600_000;await m.tick();expect(texts).toHaveLength(0);
  w.now+=3600_000;w.messages=[{ts:String(w.now/1000),text:"answered",user:"U123"}];await m.tick();expect(texts.some(t=>t.startsWith("Possible unanswered"))).toBe(false);await m.close();
 });
 test("disable fences a pending poll; account change discards previous private state",async()=>{
  const path=join(temp(),"state.sqlite");let resolve!: (r:Response)=>void;const pending=new Promise<Response>(r=>resolve=r);const client=new SlackPersonalClient("u","b",async()=>pending);let wakes=0;
  const m=new SlackMonitor(path,client,"U123",Date.now,false);m.configure(watch);m.start({wake:async()=>{wakes++;return "admitted";}});const tick=m.tick();m.configure(undefined);resolve(ok({messages:[]}));await tick;expect(wakes).toBe(0);expect(m.status().enabled).toBe(false);await m.close();
  const w=monitorWorld(path);const old=w.make();old.configure(watch);await old.close();const next=new SlackMonitor(path,w.client,"UOTHER",Date.now,false);expect(next.status().enabled).toBe(false);await next.close();
 });
});
