import {afterEach,test,expect} from "bun:test";
import {BACKGROUND_CONTEXT as context} from "@earendil-works/chord/context";
import {createModels} from "@earendil-works/pi-ai/models";
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from "@earendil-works/pi-ai/providers/faux";
import {MemoryStorage} from "@earendil-works/pi-durable";
import {openBot,type Bot} from "../src/core/bot.ts";
import {WAKE_PREFIX} from "../src/extensions/subagents.ts";
import {RunDoc} from "../src/core/dag.ts";
import {AsksDoc,resolveAsk} from "../src/core/ask.ts";
import {DagContinuationDoc,dagContinuation} from "../src/extensions/dag-continuation.ts";
const bots:Bot[]=[];afterEach(async()=>{for(const b of bots.splice(0))await b.close(context);});
for(const mode of ["direct","codemode-only"] as const)for(const newGoal of [false,true])test((newGoal?"T12 old candidate preserved across active-run switch ":"T01 independent frontier before live peer release ")+mode,async()=>{
 const faux=fauxProvider({provider:"faux",models:[{id:"fixture"}]});let requests=0;const wakes:string[]=[];const visits:Record<string,number>={};
 const plan={nodes:[{id:"A",kind:"act",writes:["a"]},{id:"B",kind:"act",writes:["b"]},{id:"V",kind:"verify",reads:["a"],covers:["R"]},{id:"W",kind:"verify",reads:["b"],covers:["S"]}],edges:[["A","V"],["B","W"]],goal:{requirements:["R","S"]}};
 const call=(name:string,args:Record<string,any>)=>mode==="direct"?fauxToolCall(name,args):fauxToolCall("codemode",{code:"text(await tools."+name+"("+JSON.stringify(args)+"));"});
 faux.setResponses(Array.from({length:40},()=>t=>{
  // ADR 0096: the idle orchestrator is woken once per stopped run or open ask; a woken turn is not polling.
  const user=String(t.messages.findLast(m=>m.role==="user")?.content);if(user.startsWith(WAKE_PREFIX)){wakes.push(user);return fauxAssistantMessage("noted");}requests++;const node=/plan node "([^"]+)"/.exec(user)?.[1];
  const results=t.messages.slice(t.messages.findLastIndex(m=>m.role==="user")+1).filter(m=>m.role==="toolResult");
  if(node){visits[node]=(visits[node]??0)+1;if(node==="B"&&!results.length)return fauxAssistantMessage(call("ask",{question:"hold B until fixture releases",kind:"clarification",default:"deny",deadline_ms:60000}),{stopReason:"toolUse"});
   return fauxAssistantMessage(node==="V"||node==="W"||node==="Z"?JSON.stringify({version:1,requirements:[{id:node==="V"?"R":node==="W"?"S":"N",verdict:"pass",evidence:"checked independent output"}],summary:"ok",repairable:false}):"actor output");}
  if(!results.length&&user==="new independent goal")return fauxAssistantMessage(call("dag_run",{plan:{nodes:[{id:"Z",kind:"verify",covers:["N"]}],edges:[],goal:{requirements:["N"]}}}),{stopReason:"toolUse"});
  return results.length?fauxAssistantMessage("yield"):fauxAssistantMessage(call("dag_run",{plan}),{stopReason:"toolUse"});
 }));
 const models=createModels();models.setProvider(faux.provider);const bot=await openBot({storage:new MemoryStorage(),models,defaultModel:{provider:"faux",modelId:"fixture"},toolMode:mode,plugins:[],settings:{retry:{enabled:false}}},context);bots.push(bot);
 const parent=await bot.conversation("test","independent-"+mode,context);await(await parent.submit({type:"input",content:"start independent branches"},context)).wait(context);
 let ask;for(let i=0;i<200;i++){ask=(await bot.harness.snapshot(AsksDoc,parent.id,context))?.asks.find(a=>a.state==="open");if(ask)break;await Bun.sleep(10);}expect(ask).toBeDefined();
 const recovery=dagContinuation(()=>bot.harness);await recovery.recover(context);await recovery.recover(context);
 let run;for(let i=0;i<200;i++){run=(await bot.harness.snapshot(RunDoc,parent.id,context))!.runs[0]!;if(run.nodes.V!.status==="succeeded")break;await Bun.sleep(10);}
 console.log("before peer release",JSON.stringify({mode,requests,visits,run,driver:await bot.harness.snapshot(DagContinuationDoc,parent.id,context),ask}));
 expect(run!.nodes.A!.status).toBe("succeeded");expect(run!.nodes.V!.status).toBe("succeeded");expect(run!.nodes.V!.runs).toBe(1);expect(visits.V).toBe(1);expect(run!.nodes.B!.status).toBe("waiting");expect(run!.status).toBe("running");
 if(newGoal){
  const old=run!;const candidate=JSON.stringify(old.nodes.A);const proof=JSON.stringify(old.nodes.V);
  await(await parent.submit({type:"input",content:"new independent goal"},context)).wait(context);
  let doc;for(let i=0;i<200;i++){doc=(await bot.harness.snapshot(RunDoc,parent.id,context))!;if(doc.runs[1]?.status==="verified")break;await Bun.sleep(10);}
  expect(doc!.runs).toHaveLength(2);expect(doc!.activeId).toBe(doc!.runs[1]!.id);expect(doc!.runs[1]!.id).not.toBe(old.id);
  expect(doc!.runs[0]!.plan.goal).toEqual(old.plan.goal);
  expect(JSON.stringify(doc!.runs[0]!.nodes.A)).toBe(candidate);expect(JSON.stringify(doc!.runs[0]!.nodes.V)).toBe(proof);expect(visits.Z).toBe(1);
  console.log("old candidate preserved",JSON.stringify(doc));
 }
 const driverId=(await bot.harness.snapshot(DagContinuationDoc,parent.id,context))!.tasks[run!.id]!;
 let driver;for(let i=0;i<200;i++){driver=await bot.harness.getTask(driverId,context);if(driver?.state.status==="running"&&(driver.state.checkpoint as any).phase==="wait"&&(driver.state.checkpoint as any).on.length===1)break;await Bun.sleep(10);}
 expect(driver!.state.status).toBe("running");expect((driver!.state as any).checkpoint.phase).toBe("wait");
 console.log("durable peer wait checkpoint",JSON.stringify(driver));
 const checkpoint=JSON.stringify(driver!.state);const count=requests;await Bun.sleep(100);expect(requests).toBe(count);expect(JSON.stringify((await bot.harness.getTask(driverId,context))!.state)).toBe(checkpoint);expect((await bot.harness.snapshot(AsksDoc,parent.id,context))!.asks.find(a=>a.id===ask!.id)!.state).toBe("open");
 await bot.harness.commit(async tx=>{resolveAsk(await tx.doc(AsksDoc,parent.id),ask!.id,{state:"answered",answer:"release",by:"agent:"+parent.id,now:Date.now()});},context);
 for(let i=0;i<200;i++){run=(await bot.harness.snapshot(RunDoc,parent.id,context))!.runs[0]!;if(run.status==="verified")break;await Bun.sleep(10);}
 expect(run!.status).toBe("verified");expect(run!.nodes.V!.runs).toBe(1);expect(visits.V).toBe(1);console.log("after release",JSON.stringify({mode,requests,visits,run}));
},10000);
