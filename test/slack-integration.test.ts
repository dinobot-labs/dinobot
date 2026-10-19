import {test,expect,spyOn} from "bun:test";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHmac} from "node:crypto";
import type {ServerWebSocket} from "bun";
import {Database} from "bun:sqlite";
import {createSlackChannel,type SlackConfig} from "../src/channels/slack.ts";
import type {InboundMessage} from "../src/channels/types.ts";

const secret="0123456789abcdef0123456789abcdef";
process.env.SLACK_INTEGRATION_SECRET=secret;
process.env.SLACK_INTEGRATION_BOT="xoxb-integration-test";
process.env.SLACK_INTEGRATION_APP="xapp-integration-test";
const realFetch=globalThis.fetch;
const answer=async()=>({status:"answered" as const,text:"ok"});
function config(dir:string):SlackConfig{return {databasePath:join(dir,"slack.sqlite"),signingSecretEnv:"SLACK_INTEGRATION_SECRET",botTokenEnv:"SLACK_INTEGRATION_BOT",appId:"A123",teamId:"T123",botUserId:"UBOT",allowedUserIds:["U123"],allowedChannelIds:["C123","D123"],toolProgress:"off"};}
function event(n=1,patch:Record<string,unknown>={}){return {type:"event_callback",api_app_id:"A123",team_id:"T123",event_id:"Ev"+n,event:{type:"message",user:"U123",channel:"D123",channel_type:"im",ts:"1791165000."+String(n).padStart(6,"0"),text:"hello",...patch}};}
async function until(check:()=>boolean){for(let i=0;i<400;i++){if(check())return;await Bun.sleep(5);}throw Error("condition timed out");}
function post(channel:ReturnType<typeof createSlackChannel>,value:unknown){const body=JSON.stringify(value),time=String(Math.floor(Date.now()/1000));return realFetch(new URL("/webhook",channel.url()),{method:"POST",headers:{"content-type":"application/json","x-slack-request-timestamp":time,"x-slack-signature":"v0="+createHmac("sha256",secret).update("v0:"+time+":"+body).digest("hex")},body});}

test("authenticated database admission failures are retryable503, never success ACK",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"slack-db-failure-"));const cfg=config(dir),c=createSlackChannel(cfg);let next:ReturnType<typeof createSlackChannel>|undefined,calls=0;
 try{
  await c.start(answer);await c.stop();
  const db=new Database(cfg.databasePath);try{db.exec("CREATE TRIGGER fail_admission BEFORE INSERT ON jobs BEGIN SELECT RAISE(ABORT,'simulated write failure'); END;");}finally{db.close();}
  next=createSlackChannel(cfg);await next.start(async()=>{calls++;return answer();});
  expect((await post(next,event())).status).toBe(503);expect(calls).toBe(0);expect(next.health().rows).toBe(0);
 }finally{await next?.stop();await c.stop();rmSync(dir,{recursive:true,force:true});}
});

test("Socket Mode uses real WS ingress, shares durable dedup and blocks unsigned local HTTP",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"slack-integration-"));
 const peers=new Set<ServerWebSocket<undefined>>(),acks:string[]=[];
 const server=Bun.serve<undefined>({hostname:"127.0.0.1",port:0,fetch(req,s){
  if(new URL(req.url).pathname==="/ws"){if(s.upgrade(req,{data:undefined}))return;return new Response(null,{status:400});}
  expect(req.headers.get("authorization")).toBe("Bearer xapp-integration-test");
  return Response.json({ok:true,url:s.url.origin.replace("http:","ws:")+"/ws"});
 },websocket:{open(ws){peers.add(ws);ws.send(JSON.stringify({type:"hello"}));},message(_ws,value){acks.push(String(value));},close(ws){peers.delete(ws);}}});
 let sends=0,calls=0;
 const mock=spyOn(globalThis,"fetch").mockImplementation((async(input,init)=>{
  if(String(input)==="https://slack.com/api/chat.postMessage"){sends++;return Response.json({ok:true,ts:"1791165000.000010"});}
  return realFetch(input,init);
 }) as typeof fetch);
 const {signingSecretEnv:_secret,...common}=config(dir);
 const cfg={...common,transport:"socket" as const,appTokenEnv:"SLACK_INTEGRATION_APP"};
 const deps={socket:{apiBase:server.url.origin+"/api",reconnectMs:5}};
 const c=createSlackChannel(cfg,deps);let next:ReturnType<typeof createSlackChannel>|undefined;
 try{
  await c.start(async()=>{calls++;return answer();});
  expect((await post(c,event())).status).toBe(403);
  for(const ws of peers)ws.send(JSON.stringify({type:"events_api",envelope_id:"one",payload:event()}));
  await until(()=>c.health().done===1 && acks.length===1);
  for(const ws of peers)ws.send(JSON.stringify({type:"events_api",envelope_id:"two",payload:event(2,{ts:"1791165000.000001"})}));
  await until(()=>acks.length===2);expect(calls).toBe(1);expect(sends).toBe(1);
  await c.stop();next=createSlackChannel(cfg,deps);await next.start(async()=>{calls++;return answer();});
  for(const ws of peers)ws.send(JSON.stringify({type:"events_api",envelope_id:"three",payload:event()}));
  await until(()=>acks.length===3);expect(calls).toBe(1);expect(next.health().done).toBe(1);
 }finally{await next?.stop();await c.stop();mock.mockRestore();await server.stop(true);rmSync(dir,{recursive:true,force:true});}
});

test("signed file-only messages resolve private media before handler; unsupported files skip model",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"slack-files-integration-"));const seen:InboundMessage[]=[];
 let fileCalls=0;const sent:string[]=[];
 const mock=spyOn(globalThis,"fetch").mockImplementation((async(input,init)=>{
  const url=String(input);
  if(url==="https://slack.com/api/chat.postMessage"){sent.push(JSON.parse(String(init?.body)).text);return Response.json({ok:true,ts:"1791165000.000011"});}
  if(url==="https://slack.com/api/files.info"){fileCalls++;return Response.json({ok:true,file:{id:"F123",name:"note.txt",mimetype:"text/plain",size:12,url_private:"https://files.slack.com/files-pri/abc"}});}
  if(url==="https://files.slack.com/files-pri/abc"){expect(new Headers(init?.headers).get("authorization")).toBe("Bearer xoxb-integration-test");return new Response("hello world!");}
  return realFetch(input,init);
 }) as typeof fetch);
 const c=createSlackChannel(config(dir));
 try{
  await c.start(async m=>{seen.push(m);return answer();});
  expect((await post(c,event(1,{subtype:"file_share",text:"",files:[{id:"F123"}]}))).status).toBe(200);
  await until(()=>c.health().done===1);expect(seen).toHaveLength(1);expect(seen[0]!.text).toContain("hello world!");expect(fileCalls).toBe(1);
  await post(c,event(2,{subtype:"file_share",files:[{id:"F456",name:"movie.mp4",mimetype:"video/mp4"}]}));
  await until(()=>c.health().done===2);expect(seen).toHaveLength(1);expect(fileCalls).toBe(1);expect(sent[1]).toContain("첨부파일");
  await post(c,event(3,{user:"U999",subtype:"file_share",files:[{id:"F123"}]}));await Bun.sleep(30);expect(fileCalls).toBe(1);
 }finally{await c.stop();mock.mockRestore();rmSync(dir,{recursive:true,force:true});}
});

test("adapter tool stream closes before durable final reply and does not stream draft snapshots as deltas",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"slack-tools-integration-"));const calls:{method:string;body:any}[]=[];
 let release!:()=>void;const started=new Promise<void>(resolve=>release=resolve);
 const mock=spyOn(globalThis,"fetch").mockImplementation((async(input,init)=>{
  const url=String(input);if(url.startsWith("http://127.0.0.1"))return realFetch(input,init);
  const method=url.split("/").at(-1)!;calls.push({method,body:JSON.parse(String(init?.body))});
  if(method==="chat.startStream")release();
  return Response.json({ok:true,ts:"1791165000.000012"});
 }) as typeof fetch);
 const c=createSlackChannel({...config(dir),toolProgress:"native"});
 try{
  await c.start(async(_m,_s,progress)=>{
   progress?.({type:"tool_start",id:"call-A",name:"read",detail:"report.md"});
   progress?.({type:"tool_start",id:"call-B",name:"read",detail:"notes.md"});
   progress?.({type:"draft",text:"snapshot-not-delta"});await started;
   progress?.({type:"tool_end",id:"call-A",ok:true});progress?.({type:"tool_end",id:"call-B",ok:false});return answer();
  });
  await post(c,event());await until(()=>c.health().done===1);
  expect(calls.map(c=>c.method)).toEqual(["chat.startStream","chat.stopStream","chat.postMessage"]);
  expect(calls[0]!.body).toMatchObject({channel:"D123",thread_ts:"1791165000.000001",recipient_team_id:"T123",recipient_user_id:"U123",task_display_mode:"plan"});
  const tasks=calls[1]!.body.chunks.filter((c:any)=>c.type==="task_update");
  expect(tasks.map((t:any)=>[t.id,t.status])).toEqual([["call-A","complete"],["call-B","error"]]);
  expect(JSON.stringify(calls)).not.toContain("snapshot-not-delta");expect(calls[2]!.body.text).toBe("ok");
 }finally{await c.stop();mock.mockRestore();rmSync(dir,{recursive:true,force:true});}
});

test("long final reply goes through three-step upload to exact admitted thread without chat duplication",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"slack-upload-integration-"));const calls:string[]=[];const source="long answer 😀\n".repeat(1200);
 const mock=spyOn(globalThis,"fetch").mockImplementation((async(input,init)=>{
  const url=String(input);if(url.startsWith("http://127.0.0.1"))return realFetch(input,init);
  calls.push(url);
  if(url.endsWith("files.getUploadURLExternal"))return Response.json({ok:true,file_id:"F123",upload_url:"https://files.slack.com/upload/v1/x"});
  if(url==="https://files.slack.com/upload/v1/x"){expect(Buffer.from(init?.body as Uint8Array).toString()).toBe(source);expect(new Headers(init?.headers).has("authorization")).toBe(false);return new Response("OK");}
  if(url.endsWith("files.completeUploadExternal")){expect(JSON.parse(String(init?.body))).toMatchObject({channel_id:"D123",thread_ts:"1791165000.000001"});return Response.json({ok:true,files:[{id:"F123"}]});}
  throw Error("unexpected request");
 }) as typeof fetch);
 const c=createSlackChannel(config(dir));
 try{await c.start(async()=>({status:"answered",text:source}));await post(c,event());await until(()=>c.health().done===1);expect(calls).toHaveLength(3);expect(calls.some(url=>url.endsWith("chat.postMessage"))).toBe(false);}
 finally{await c.stop();mock.mockRestore();rmSync(dir,{recursive:true,force:true});}
});

test("Slack file answer appends separate choice message after upload",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"slack-upload-choice-"));const calls:string[]=[];const ask={id:"0123456789abcdef0123456789abcdef",question:"DB?",options:["SQLite","Postgres"],default:"SQLite",deadlineAt:Date.now()+60000};
 const mock=spyOn(globalThis,"fetch").mockImplementation((async(input,init)=>{const url=String(input);if(url.startsWith("http://127.0.0.1"))return realFetch(input,init);calls.push(url);
 if(url.endsWith("files.getUploadURLExternal"))return Response.json({ok:true,file_id:"F123",upload_url:"https://files.slack.com/upload/v1/x"});
 if(url==="https://files.slack.com/upload/v1/x")return new Response("OK");
 if(url.endsWith("files.completeUploadExternal"))return Response.json({ok:true,files:[{id:"F123"}]});
 if(url.endsWith("chat.postMessage")){const body=JSON.parse(String(init?.body));expect(body.blocks[1].elements[1].value).toBe("da:"+ask.id+":1");expect(body.thread_ts).toBe("1791165000.000001");return Response.json({ok:true,ts:"1791165000.000012"});}throw Error("unexpected request");}) as typeof fetch);
 const c=createSlackChannel(config(dir));try{await c.start(async()=>({status:"answered",text:"x".repeat(12001),asks:[ask]}));await post(c,event());await until(()=>c.health().done===1);expect(calls.map(x=>x.split("/").at(-1))).toEqual(["files.getUploadURLExternal","x","files.completeUploadExternal","chat.postMessage"]);}finally{await c.stop();mock.mockRestore();rmSync(dir,{recursive:true,force:true});}
});
