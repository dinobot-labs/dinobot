import {expect,test} from "bun:test";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {telegramChannel} from "../src/channels/telegram.ts";
import {readBounded} from "../src/channels/messaging.ts";
import type {ProgressSink} from "../src/channels/types.ts";
import {systemClock,type GateClock} from "../src/channels/api-gate.ts";
import {FakeClock,flush,rawGate} from "./fixtures/issuance.ts";
import {telegramProgress} from "../src/channels/telegram-progress.ts";
process.env.ISSUANCE_TOKEN="739:test";process.env.ISSUANCE_SECRET="issuance-secret";
function deferred<T=void>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};}
async function until(fn:()=>boolean,ms=10000){const end=performance.now()+ms;while(!fn()){if(performance.now()>end)throw new Error("issuance barrier timeout");await Bun.sleep(5);}}
const event=(id:number,topic:number,chat=-9)=>({update_id:id,message:{message_id:id,from:{id:7,is_bot:false},chat:{id:chat,type:"supergroup"},message_thread_id:topic,text:"test"}});

test("LOCAL FETCH INVOCATION: every Telegram API, slow reserve/TX2, wall jumps and zero ignored cooldown window",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"issuance-local-")),rawFetch=globalThis.fetch,wall=Date.now;
 const model=deferred(),pollRelease=deferred(),calls:{method:string;body:any;at:number;ns:bigint}[]=[],updates:unknown[]=[];
 let reserveSlow=false,sendingSlow=false,limited=false,received=0,firstUpdateDelivered=false,pollHeld=false;
 const trace=()=>JSON.stringify(calls.map(c=>({api:c.method,at:c.at,rawNs:String(c.ns)})));
 const hasMethod=(method:string)=>calls.some(c=>c.method===method);
 let progressSink:ProgressSink|undefined;
 const native=systemClock();
 const clock:GateClock={...native};
 const server=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(req){const method=new URL(req.url).pathname.split("/").at(-1)!;const body=await req.json() as any;
  if(method==="getWebhookInfo")return Response.json({ok:true,result:{url:""}});
  if(method==="getUpdates"){
   // A real long poll, not a stream of immediate empty replies competing with best-effort typing.
   // Its permit is already consumed; hold the response so the next tick has an eligible slot.
   if(firstUpdateDelivered && !updates.length){pollHeld=true;await pollRelease.promise;}
   const result=updates.splice(0);if(result.length)firstUpdateDelivered=true;
   return Response.json({ok:true,result});
  }
  if(method==="sendMessage" && body.text==="final" && !limited){limited=true;return Response.json({ok:false,parameters:{retry_after:.3}},{status:429,headers:{"retry-after":"0.2"}});}
  return Response.json({ok:true,result:method==="sendMessage"?{message_id:1}:true});
 }});
 const pause=()=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2000);
 globalThis.fetch=Object.assign(((input: Parameters<typeof fetch>[0],init?:Parameters<typeof fetch>[1])=>{
  const url=String(input);if(!url.startsWith(server.url.origin+"/bot"))return rawFetch(input,init);
  const method=url.split("/").at(-1)!,body=JSON.parse(String(init?.body??"{}"));
  calls.push({method,body,at:performance.now(),ns:native.observeNs()});
  const raw=rawFetch(input,init);
  void raw.then(response=>{if(response.status===429)received=performance.now();},()=>{});
  return raw;
 }) as typeof fetch,{preconnect:rawFetch.preconnect});
 const c=telegramChannel({mode:"polling",databasePath:join(dir,"inbox.sqlite"),allowedUserIds:["7"],allowedChatIds:["-9","-10"],botTokenEnv:"ISSUANCE_TOKEN",progress:"status",requestTimeoutMs:10000},{apiBase:server.url.origin,gateClock:clock,
  afterGateReserve(){if(!reserveSlow){reserveSlow=true;pause();Date.now=()=>wall()+86400000;}},
  afterSendingCommit(){if(!sendingSlow){sendingSlow=true;pause();Date.now=wall;}},
 });
 try{
  await c.start(async(m,_s,progress)=>{if(m.messageId==="1"){progressSink=progress;progress?.({type:"tool_start",id:"t",name:"bash"});await model.promise;progress?.({type:"tool_end",id:"t",ok:true});}return {status:"answered",text:m.messageId==="1"?"final":"other"};});
  updates.push(event(1,1));
  await until(()=>calls.some(c=>c.method==="sendMessage" && c.body.disable_notification));
  progressSink?.({type:"tool_end",id:"t",ok:true});
  await until(()=>calls.some(c=>c.method==="editMessageText"),15000);
  // An edit is not a typing barrier: lastTyping advances even on a local gate skip.
  // Keep the handler alive through an observed eligible typing opportunity.
  await until(()=>hasMethod("sendChatAction"));
  expect(pollHeld,"typing opportunity must run with an outstanding long poll; trace="+trace()).toBe(true);
  expect(hasMethod("sendChatAction"),"typing before handler completion; trace="+trace()).toBe(true);
  model.resolve();updates.push(event(2,2,-10));pollRelease.resolve();
  await until(()=>c.health().done===2,15000);
  await c.stop();
  for(const method of ["getWebhookInfo","getUpdates","sendChatAction","sendMessage","editMessageText"])expect(hasMethod(method),"missing API "+method+"; trace="+trace()).toBe(true);
  for(let i=1;i<calls.length;i++)expect(calls[i]!.at-calls[i-1]!.at).toBeGreaterThanOrEqual(40);
  const chats=new Map<string,number[]>();const typing=new Map<string,number>();
  for(const call of calls){if(["sendMessage","editMessageText"].includes(call.method)){const a=chats.get(call.body.chat_id)??[];if(a.length)expect(call.at-a.at(-1)!).toBeGreaterThanOrEqual(1000);a.push(call.at);chats.set(call.body.chat_id,a);}if(call.method==="sendChatAction"){const prev=typing.get(call.body.chat_id);if(prev!==undefined)expect(call.at-prev).toBeGreaterThanOrEqual(4000);typing.set(call.body.chat_id,call.at);}}
  expect(received).toBeGreaterThan(0);
  // Measured at local response receipt, not server arrival; starts before receipt excluded, no 100ms grace.
  expect(calls.filter(c=>c.at>=received && c.at<received+300)).toEqual([]);
  expect(reserveSlow && sendingSlow).toBe(true);
  console.log("local-fetch trace",JSON.stringify(calls.map(c=>({api:c.method,at:c.at,rawNs:String(c.ns)}))),"429-receipt",received);
 }catch(error){console.error("local-fetch failure",{pollHeld,received,health:c.health(),trace:trace()});throw error;
 }finally{Date.now=wall;model.resolve();pollRelease.resolve();await c.stop();globalThis.fetch=rawFetch;await server.stop(true);rmSync(dir,{recursive:true,force:true});}
},35000);

test("controlled local typing skip: edit alone is not a completion barrier",async()=>{
 const clock=new FakeClock(0),gate=rawGate(clock),signal=new AbortController().signal;
 const calls:{method:string;at:number}[]=[];
 const unregister=gate.registerTyping("chat:-9","1");
 const reporter=telegramProgress({chat:"-9",topic:"1",now:clock.now,sleep:async ms=>{await clock.advance(ms);},
  call:async(method,_body,abort)=>{
   const write=method!=="sendChatAction";
   const issued=await gate.progress("chat:-9",write,abort??signal,()=>{calls.push({method,at:clock.now()});return {started:true,value:{ok:true as const,result:{message_id:1}}};},undefined,"1");
   return issued.started?issued.value:write?{ok:false,status:429,retryAfterMs:1000,local:true}:{ok:true,local:true};
  },
 });
 try{
  // Force the initial typing tick inside the real policy's bot gap: no raw typing starts.
  await gate.poll(signal,()=>({started:true,value:undefined}));
  reporter.event({type:"tool_start",id:"t",name:"bash"});
  const first=reporter.tick();await flush();await clock.advance(40);await first;
  reporter.event({type:"tool_end",id:"t",ok:true});await clock.advance(3000);await reporter.tick();
  expect(calls.map(c=>c.method)).toEqual(["sendMessage","editMessageText"]);
  // The denied attempt still moved lastTyping: even a quiet gate is insufficient before 4 s.
  await clock.advance(959);await reporter.tick();
  expect(calls.map(c=>c.method)).toEqual(["sendMessage","editMessageText"]);
  await clock.advance(1);await reporter.tick();
  expect(calls.filter(c=>c.method==="sendChatAction"),"typing before completion; trace="+JSON.stringify(calls)).toEqual([{method:"sendChatAction",at:4000}]);
 }finally{await reporter.finish({kind:"done"});unregister();gate.close();}
});

for(const kind of ["final","typing","poll"] as const)test("post-start clock failure keeps "+kind+" raw and hung body owned through engine stop",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"issuance-owner-")),rawFetch=globalThis.fetch,clock=new FakeClock(0),raw=deferred<Response>(),body=deferred(),model=deferred();
 let invoked=false,stopped=false,startFailed=false,calls=0;
 const c=telegramChannel({...(kind==="poll"?{mode:"polling" as const}:{port:0,webhookSecretEnv:"ISSUANCE_SECRET"}),databasePath:join(dir,"inbox.sqlite"),allowedUserIds:["7"],allowedChatIds:["-9"],botTokenEnv:"ISSUANCE_TOKEN",progress:kind==="typing"?"status":"off"},{apiBase:"http://issuance.invalid",gateClock:clock});
 globalThis.fetch=Object.assign(((input:Parameters<typeof fetch>[0],init?:Parameters<typeof fetch>[1])=>{
  if(!String(input).startsWith("http://issuance.invalid"))return rawFetch(input,init);
  if(String(input).endsWith("/setMyCommands")) return Promise.resolve(Response.json({ok:true,result:true}));
  calls++;invoked=true;clock.hook=()=>{throw new Error("post-start native failure");};return raw.promise;
 }) as typeof fetch,{preconnect:rawFetch.preconnect});
 let stopping:Promise<void>|undefined;
 try{
  const starting=c.start(async()=>{if(kind==="typing")await model.promise;return {status:"answered",text:"answer"};}).catch(()=>{startFailed=true;});
  if(kind!=="poll"){
   await starting;await clock.advance(40);const r=await rawFetch(new URL("/webhook",c.url()),{method:"POST",headers:{"x-telegram-bot-api-secret-token":"issuance-secret"},body:JSON.stringify(event(1,1))});expect(r.status).toBe(200);await r.text();
  }
  await until(()=>invoked);stopping=c.stop().then(()=>{stopped=true;});await flush();await Bun.sleep(20);expect(stopped).toBe(false);expect(calls).toBe(1);
  const stream=new ReadableStream<Uint8Array>({start(controller){void body.promise.then(()=>{try{controller.close();}catch{}});controller.enqueue(new TextEncoder().encode(kind==="poll"?'{"ok":true,"result":{"url":""}}':'{"ok":true,"result":true}'));},cancel(){return body.promise;}});
  raw.resolve(new Response(stream));await flush();await Bun.sleep(20);expect(stopped).toBe(false);expect(calls).toBe(1);
  body.resolve();model.resolve();await stopping;await starting;expect(stopped).toBe(true);expect(c.health().active).toBe(0);expect(c.health().api_typing_members).toBe(0);if(kind==="poll")expect(startFailed).toBe(true);
 }finally{raw.resolve(Response.json({ok:true,result:{url:""}}));body.resolve();model.resolve();await c.stop();globalThis.fetch=rawFetch;rmSync(dir,{recursive:true,force:true});}
},7000);


test("original response cancellation promise remains owned after abort during a pending body read",async()=>{
 const held=deferred(),control=new AbortController();let cancellations=0,settled=false;
 const body=new ReadableStream<Uint8Array>({cancel(){cancellations++;return held.promise;}});
 const operation=readBounded(new Response(body),100,control.signal).catch(()=>{}).then(()=>{settled=true;});
 await flush();control.abort();await flush();expect(cancellations).toBe(1);expect(settled).toBe(false);held.resolve();await operation;expect(settled).toBe(true);
});

test("P12 actual startup poll waits through foreign hold without consuming its network timeout",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"issuance-hold-")),clock=new FakeClock(0),rawFetch=globalThis.fetch;
 let calls=0;const config={port:0,webhookSecretEnv:"ISSUANCE_SECRET",databasePath:join(dir,"inbox.sqlite"),allowedUserIds:["7"],allowedChatIds:["-9"],botTokenEnv:"ISSUANCE_TOKEN",progress:"off" as const,requestTimeoutMs:50};
 const first=telegramChannel(config,{apiBase:"http://issuance.invalid",gateClock:clock});
 await first.start(async()=>({status:"answered",text:"unused"}));await first.stop();clock.frame="reboot";
 globalThis.fetch=Object.assign(((input:Parameters<typeof fetch>[0],init?:Parameters<typeof fetch>[1])=>{if(!String(input).startsWith("http://issuance.invalid"))return rawFetch(input,init);calls++;expect(init?.signal?.aborted).toBe(false);return Promise.resolve(Response.json({ok:true,result:String(input).endsWith("getWebhookInfo")?{url:""}:[]}));}) as typeof fetch,{preconnect:rawFetch.preconnect});
 const next=telegramChannel({...config,mode:"polling"},{apiBase:"http://issuance.invalid",gateClock:clock});
 try{const starting=next.start(async()=>({status:"answered",text:"unused"}));await Bun.sleep(100);expect(calls).toBe(0);await clock.advance(59999);expect(calls).toBe(0);await clock.advance(1);await starting;expect(calls).toBe(1);await next.stop();}finally{await next.stop();globalThis.fetch=rawFetch;rmSync(dir,{recursive:true,force:true});}
});
