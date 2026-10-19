import {afterEach,test,expect} from "bun:test";
import {BACKGROUND_CONTEXT as context} from "@earendil-works/chord/context";
import type {JsonObject} from "@earendil-works/pi-ai";
import {createModels} from "@earendil-works/pi-ai/models";
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from "@earendil-works/pi-ai/providers/faux";
import {MemoryStorage} from "@earendil-works/pi-durable";
import {openBot,type Bot} from "../src/core/bot.ts";
import {WAKE_PREFIX} from "../src/extensions/subagents.ts";
import {RunDoc} from "../src/core/dag.ts";
import {AsksDoc,resolveAsk} from "../src/core/ask.ts";
import {DagContinuationDoc,dagContinuation} from "../src/extensions/dag-continuation.ts";
const bots:Bot[]=[];afterEach(async()=>{for(const b of bots.splice(0))await b.close(context);});
for(const mode of ["direct","codemode-only"] as const)for(const action of ["approve","deny","cancel"] as const)test("T04/T05 autonomous authority "+action+" "+mode,async()=>{
 const faux=fauxProvider({provider:"faux",models:[{id:"fixture"}]});let requests=0;const wakes:string[]=[];let askId="";const visits:Record<string,number>={};
 const plan={nodes:[{id:"q",kind:"ask",description:"Fixture-only irreversible effect?"},{id:"effect",kind:"act",writes:["fixture-output"],irreversible:true},{id:"v",kind:"verify",reads:["fixture-output"],covers:["R"]}],edges:[["q","effect"],["effect","v"]],goal:{requirements:["R"]}};
 const call=(name:string,args:JsonObject)=>fauxAssistantMessage(mode==="direct"?fauxToolCall(name,args):fauxToolCall("codemode",{code:"text(await tools."+name+"("+JSON.stringify(args)+"));"}),{stopReason:"toolUse"});
 faux.setResponses(Array.from({length:40},()=>t=>{
  // ADR 0096: the idle orchestrator is woken once per stopped run or open ask; a woken turn is not polling.
  const user=String(t.messages.findLast(m=>m.role==="user")?.content);if(user.startsWith(WAKE_PREFIX)){wakes.push(user);return fauxAssistantMessage("noted");}requests++;const node=/plan node "([^"]+)"/.exec(user)?.[1];
  const results=t.messages.slice(t.messages.findLastIndex(m=>m.role==="user")+1).filter(m=>m.role==="toolResult");
  if(node){visits[node]=(visits[node]??0)+1;return fauxAssistantMessage(node==="v"?JSON.stringify({version:1,requirements:[{id:"R",verdict:"pass",evidence:"checked fixture only"}],summary:"ok",repairable:false}):"fixture effect");}
  if(results.length)return fauxAssistantMessage("yield");
  if(user==="start")return call("dag_run",{plan});
  return action==="cancel"?call("dag_step",{cancel:true,reason:"fixture cancellation"}):call("answer",{ask_id:askId,answer:action,quote:user});
 }));
 const models=createModels();models.setProvider(faux.provider);const bot=await openBot({storage:new MemoryStorage(),models,defaultModel:{provider:"faux",modelId:"fixture"},toolMode:mode,plugins:[],settings:{retry:{enabled:false}}},context);bots.push(bot);
 const parent=await bot.conversation("test",mode+action,context);await(await parent.submit({type:"input",content:"start"},context)).wait(context);
 let ask;for(let i=0;i<200;i++){ask=(await bot.harness.snapshot(AsksDoc,parent.id,context))?.asks.find(a=>a.state==="open");if(ask)break;await Bun.sleep(10);}expect(ask).toMatchObject({kind:"authority",to:"human",default:"deny"});askId=ask!.id;
 for(let i=0;i<300&&!wakes.length;i++)await Bun.sleep(10);expect(wakes).toHaveLength(1);expect(wakes[0]).toContain("needs the human's answer");
 const count=requests;await Bun.sleep(100);expect(requests).toBe(count);expect(visits.effect??0).toBe(0);
 await(await parent.submit({type:"input",content:action},context)).wait(context);
 let run;for(let i=0;i<200;i++){run=(await bot.harness.snapshot(RunDoc,parent.id,context))!.runs[0]!;if(run.status!=="running")break;await Bun.sleep(10);}
 expect(run!.status).toBe(action==="approve"?"verified":action==="deny"?"blocked":"cancelled");
 // ADR 0096: a run that stops by itself wakes the orchestrator once more; the one it cancelled itself does not.
 for(let i=0;i<300&&action!=="cancel"&&wakes.length<2;i++)await Bun.sleep(10);await Bun.sleep(100);expect(wakes).toHaveLength(action==="cancel"?1:2);if(action!=="cancel")expect(wakes[1]).toContain(action==="approve"?"finished: verified":"stopped: blocked");expect(run!.nodes.effect!.runs).toBe(action==="approve"?1:0);expect(visits.effect??0).toBe(action==="approve"?1:0);
 // A late/duplicate authority resolution cannot resurrect or reroll the run.
 const before=JSON.stringify(run);await bot.harness.commit(async tx=>{expect(resolveAsk(await tx.doc(AsksDoc,parent.id),askId,{state:"answered",answer:"approve",by:"human:late",now:Date.now()}).changed).toBe(false);},context);
 await dagContinuation(()=>bot.harness).recover(context);await Bun.sleep(100);expect(JSON.stringify((await bot.harness.snapshot(RunDoc,parent.id,context))!.runs[0])).toBe(before);
 const driver=(await bot.harness.snapshot(DagContinuationDoc,parent.id,context))!.tasks[run!.id]!;expect((await bot.harness.getTask(driver,context))!.state.status).toBe("terminal");
 console.log("autonomous control",JSON.stringify({mode,action,requests,visits,run,driver:await bot.harness.getTask(driver,context),asks:await bot.harness.snapshot(AsksDoc,parent.id,context)}));
},10000);
