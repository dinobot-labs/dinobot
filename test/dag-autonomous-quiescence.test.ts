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
import {DagContinuationDoc} from "../src/extensions/dag-continuation.ts";
const bots:Bot[]=[];afterEach(async()=>{for(const b of bots.splice(0))await b.close(context);});
for(const mode of ["direct","codemode-only"] as const)for(const held of ["peer","bad"])test("T17 autonomous shared-writer quiescence held="+held+" "+mode,async()=>{
 const faux=fauxProvider({provider:"faux",models:[{id:"fixture"}]});let requests=0;const wakes:string[]=[];let actors=0;let repairInput="";
 const plan={nodes:[{id:"actor",kind:"act",writes:["out"]},{id:"bad",kind:"verify",reads:["out"],covers:["R"],repair:{predecessorId:"actor",maxRepairs:2}},{id:"peer",kind:"verify",reads:["out"],covers:["S"]}],edges:[["actor","bad"],["actor","peer"]],goal:{requirements:["R","S"]}};
 const call=(name:string,args:JsonObject)=>fauxAssistantMessage(mode==="direct"?fauxToolCall(name,args):fauxToolCall("codemode",{code:"text(await tools."+name+"("+JSON.stringify(args)+"));"}),{stopReason:"toolUse"});
 faux.setResponses(Array.from({length:60},()=>t=>{
  // ADR 0096: the idle orchestrator is woken once per stopped run or open ask; a woken turn is not polling.
  const user=String(t.messages.findLast(m=>m.role==="user")?.content);if(user.startsWith(WAKE_PREFIX)){wakes.push(user);return fauxAssistantMessage("noted");}requests++;const node=/plan node "([^"]+)"/.exec(user)?.[1];const results=t.messages.slice(t.messages.findLastIndex(m=>m.role==="user")+1).filter(m=>m.role==="toolResult");
  if(node==="actor"){actors++;if(actors===2)repairInput=user;return fauxAssistantMessage(actors===1?"original candidate":"repaired candidate");}
  if(node){if(node===held&&actors===1&&!results.length)return call("ask",{question:"hold impacted reviewer",kind:"decision",default:"wait",deadline_ms:60000});const negative=node==="bad"&&actors===1;return fauxAssistantMessage(JSON.stringify({version:1,requirements:[{id:node==="bad"?"R":"S",verdict:negative?"fail":"pass",evidence:negative?"retained negative artifact finding":"checked candidate"}],summary:"fixture",repairable:negative}));}
  return results.length?fauxAssistantMessage("yield"):call("dag_run",{plan});
 }));
 const models=createModels();models.setProvider(faux.provider);const bot=await openBot({storage:new MemoryStorage(),models,defaultModel:{provider:"faux",modelId:"fixture"},toolMode:mode,plugins:[],settings:{retry:{enabled:false}}},context);bots.push(bot);
 const parent=await bot.conversation("test",mode+held,context);await(await parent.submit({type:"input",content:"start"},context)).wait(context);
 let run,ask;for(let i=0;i<300;i++){run=(await bot.harness.snapshot(RunDoc,parent.id,context))?.runs[0];ask=(await bot.harness.snapshot(AsksDoc,parent.id,context))?.asks.find(a=>a.state==="open");if(ask&&run?.nodes[held]!.status==="waiting"&&(held==="peer"?run.nodes.bad!.pendingRepair:run.nodes.peer!.status==="succeeded"))break;await Bun.sleep(10);}
 expect(ask).toBeDefined();expect(run!.repairsUsed).toBe(0);expect(run!.nodes.actor!.runs).toBe(1);expect(run!.nodes[held]!.status).toBe("waiting");if(held==="peer")expect(run!.nodes.bad!.pendingRepair!.result).toContain("retained negative");else expect(run!.nodes.peer!.proof).toBeDefined();
 const count=requests;await Bun.sleep(100);expect(requests).toBe(count);expect(actors).toBe(1);console.log("pre-quiescence",JSON.stringify({mode,held,run,driver:await bot.harness.snapshot(DagContinuationDoc,parent.id,context)}));
 await bot.harness.commit(async tx=>{resolveAsk(await tx.doc(AsksDoc,parent.id),ask!.id,{state:"answered",answer:"release",by:"agent:"+parent.id,now:Date.now()});},context);
 for(let i=0;i<300;i++){run=(await bot.harness.snapshot(RunDoc,parent.id,context))!.runs[0]!;if(run.status==="verified")break;await Bun.sleep(10);}
 console.log("post-release diagnostic",JSON.stringify({run,repairInput,actors,tasks:await bot.harness.inspect(context)}));
 expect(run!.status).toBe("verified");expect(run!.repairsUsed).toBe(1);expect(run!.nodes.actor!.runs).toBe(2);expect(run!.nodes.bad!.runs).toBe(2);expect(run!.nodes.peer!.runs).toBe(2);expect(run!.repairHistory![0]!.nodes.peer!.status).toBe("succeeded");expect(repairInput).toContain("retained negative artifact finding");expect(repairInput).toContain("original candidate");console.log("post-quiescence",JSON.stringify({mode,held,run,repairInput}));
},10000);
