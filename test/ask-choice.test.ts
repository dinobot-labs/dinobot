import { afterEach, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openBot, type Bot } from "../src/core/bot.ts";
import { AsksDoc, type AskRecord } from "../src/core/ask.ts";
import { humanAskPrompts, prepareChoice, choiceText } from "../src/core/ask-choice.ts";
import { httpChannel } from "../src/channels/http.ts";
import { parseSend, startClientApi } from "../src/api/server.ts";
import type { Commands } from "../src/commands/index.ts";
const bots: Bot[] = [];
afterEach(async () => { for (const b of bots.splice(0)) await b.close(ctx); });
async function setup(router: FauxResponseFactory) {
 const faux = fauxProvider({provider:"faux",models:[{id:"faux-1"}]}); faux.setResponses(Array.from({length:80},()=>router));
 const models=createModels(); models.setProvider(faux.provider);
 const bot=await openBot({storage:new MemoryStorage(),models,defaultModel:{provider:"faux",modelId:"faux-1"},toolMode:"direct",plugins:[],settings:{retry:{enabled:false}}},ctx); bots.push(bot); return bot;
}
const input = (messageId:string, extra:object={}) => ({channel:"test", threadKey:"alice",userId:"alice",messageId,text:"ASK",...extra});
test("I1 I2 I4 I5 I6 I8: choice provenance, idempotent admission and rejection without model", async () => {
 let calls=0, id="", seen="";
 const bot=await setup((t)=>{
  calls++; const user=t.messages.findLast(m=>m.role==="user");
  const turn=t.messages.slice(t.messages.findLastIndex(m=>m.role==="user")+1);
  if(turn.some(m=>m.role==="toolResult")) return fauxAssistantMessage("done");
  const raw=String(user?.content);
  if(raw.includes("choice:")) { seen=raw; return fauxAssistantMessage(fauxToolCall("answer",{ask_id:id,answer:"Postgres",quote:choiceText(id,"Postgres")}),{stopReason:"toolUse"}); }
  return fauxAssistantMessage(fauxToolCall("ask",{to:"human",kind:"decision",question:"DB?",options:["SQLite","Postgres"],default:"SQLite"}),{stopReason:"toolUse"});
 });
 const first=await bot.handle(input("1"),ctx);
 expect(first.status).toBe("answered"); if(first.status!=="answered") throw new Error();
 expect(first.asks?.[0]?.options).toEqual(["SQLite","Postgres"]); id=first.asks![0]!.id;
 const conversation=await bot.conversation("test","alice",ctx);
 const choice={askId:id,option:1};
 const before=calls;
 const foreign=await bot.handle(input("foreign",{threadKey:"bob",userId:"bob",choice}),ctx);
 expect(JSON.stringify(foreign)).toContain("이 대화의 질문이 아니거나"); expect(calls).toBe(before);
 const clicked=input("2",{choice,text:"FORGED"});
 const [a,b]=await Promise.all([bot.handle(clicked,ctx),bot.handle(clicked,ctx)]);
 expect(a.status).toBe("answered"); expect(b.status).toBe("answered"); expect(calls-before).toBe(2);
 expect(seen).toBe(['<from user="alice" channel="test"/>', choiceText(id,"Postgres")].join(String.fromCharCode(10)));
 const record=(await bot.harness.snapshot(AsksDoc,conversation.id,ctx))!.asks[0]!;
 expect(record).toMatchObject({state:"answered",answer:"Postgres",resolvedBy:"human:alice"}); expect(typeof record.sourceEntry).toBe("number");
 const count=calls; expect(JSON.stringify(await bot.handle(input("3",{choice}),ctx))).toContain("이미 처리되었습니다"); expect(calls).toBe(count);
 await bot.harness.commit(async tx=>{const d=await tx.doc(AsksDoc,conversation.id); d.asks.push({...record,id:"a".repeat(32),state:"open",deadlineAt:Date.now()-1});},ctx);
 expect(JSON.stringify(await bot.handle(input("4",{choice:{askId:"a".repeat(32),option:0}}),ctx))).toContain("마감"); expect(calls).toBe(count);
},15000);
test("D7 choice preparation rules and chronological since/three cap", async () => {
 const bot=await setup(()=>fauxAssistantMessage("unused")); const c=await bot.conversation("test","alice",ctx);
 const record=(n:number):AskRecord=>({id:n.toString(16).padStart(32,"0"),from:{conversationId:c.id},to:"human",kind:"decision",refs:[],question:`q${n}`,options:["A","B"],default:"A",createdAt:n,deadlineAt:100,state:"open"});
 await bot.harness.commit(async tx=>{ const d=await tx.doc(AsksDoc,c.id); d.asks.push(record(1),record(5),record(4),record(3),record(2),{...record(6),options:[]},{...record(7),to:"main"},{...record(8),state:"withdrawn"}); },ctx);
 expect((await humanAskPrompts(bot.harness,c.id,2,ctx)).map(a=>a.question)).toEqual(["q2","q3","q4"]);
 const msg=input("x",{choice:{askId:record(2).id,option:1}});
 expect(await prepareChoice(bot.harness,c.id,msg,99,ctx)).toMatchObject({ok:true,message:{text:choiceText(record(2).id,"B")}});
 expect(await prepareChoice(bot.harness,c.id,msg,100,ctx)).toMatchObject({ok:false});
 for(const option of [-1,2,0.5]) expect(await prepareChoice(bot.harness,c.id,{...msg,choice:{askId:record(2).id,option}},99,ctx)).toMatchObject({ok:false,notice:"알 수 없는 선택지입니다."});
 expect(await prepareChoice(bot.harness,c.id,input("x",{choice:{askId:record(6).id,option:0}}),99,ctx)).toMatchObject({ok:false});
});
test("I4 I8 TUI API rejects foreign choice with 409 before admission", async () => {
 let calls = 0; const bot = await setup(() => { calls++; return fauxAssistantMessage("should not run"); });
 const api = startClientApi(bot, 0, ctx, {} as Commands);
 try {
  const response = await fetch(new URL("/v1/threads/test/alice/messages", api.url), {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({text:"fallback",userId:"alice",choice:{askId:"a".repeat(32),option:0}})});
  expect(response.status).toBe(409); expect(await response.json()).toMatchObject({error:expect.stringContaining("이 대화의 질문이 아니거나")}); expect(calls).toBe(0);
 } finally { await api.stop(); }
});
test("I7 HTTP carries choices and prompts, malformed choice is 400", async()=>{
 const id="a".repeat(32), choice={askId:id,option:1}; const asks=[{id,question:"q",options:["A","B"],default:"A",deadlineAt:100}];
 const channel=httpChannel(0); let seen:unknown;
 await channel.start(async m=>{seen=m.choice;return {status:"answered",text:"ok",asks};});
 try { const body={...input("http"),choice}; const send=(v:unknown)=>fetch(new URL("/v1/messages",channel.url()),{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(v)});
 expect(await (await send(body)).json()).toMatchObject({asks}); expect(seen).toEqual(choice);
 expect((await send({...body,choice:{...choice,option:4}})).status).toBe(400);
 expect(parseSend({text:"x",choice})).toMatchObject({choice}); expect(parseSend({text:"x",choice:{...choice,extra:true}})).toBe("choice must be {askId, option}");
 }finally{await channel.stop();}
});
