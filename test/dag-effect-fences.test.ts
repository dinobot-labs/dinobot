import { afterEach, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openBot, type Bot } from "../src/core/bot.ts";
import { RunDoc } from "../src/core/dag.ts";
import { WorkDoc } from "../src/core/verification.ts";
import { AsksDoc, resolveAsk } from "../src/core/ask.ts";
import { ClaimsDoc, acquire, release } from "../src/core/claims.ts";
import { OwnerClaimsDoc } from "../src/core/claim-cleanup.ts";
import { AgentsDoc } from "../src/extensions/subagents.ts";
import { cancelDag, closeTerminalDag } from "../src/extensions/dag.ts";
import { abortConversation } from "../src/core/queue.ts";
const bots:Bot[]=[];afterEach(async()=>{for(const bot of bots.splice(0))await bot.close(context);});
async function until<T>(read:()=>Promise<T>,ready:(v:T)=>boolean):Promise<T>{for(let i=0;i<400;i++){const v=await read();if(ready(v))return v;await Bun.sleep(10);}throw Error("native fixture barrier not reached");}
const plan={nodes:[{id:"q",kind:"ask",description:"Fake only one-use paid1?"},{id:"paid",kind:"act",irreversible:true,writes:["fake:paid1"]},{id:"v",kind:"verify",reads:["fake:paid1"],covers:["R"]}],edges:[["q","paid"],["paid","v"]],goal:{requirements:["R"]}};
for(const mode of ["direct","codemode-only"] as const)for(const action of ["deny","cancel","abort","handoff","newgoal","stale-approval","unknown"] as const)test("T10/T12/T14 native effect fence "+action+" "+mode,async()=>{
 let count=0,askId="";const faux=fauxProvider({provider:"faux",models:[{id:"m"}]});const models=createModels();models.setProvider(faux.provider);
 const call=(name:string,args:import("@earendil-works/pi-ai").JsonObject)=>fauxAssistantMessage(mode==="direct"?fauxToolCall(name,args):fauxToolCall("codemode",{code:"text(await tools."+name+"("+JSON.stringify(args)+"));"}),{stopReason:"toolUse"});
 const nativeResults:unknown[]=[];
 faux.setResponses(Array.from({length:100},()=>t=>{const user=String(t.messages.findLast(m=>m.role==="user")?.content);const node=/plan node "([^"]+)"/.exec(user)?.[1];const results=t.messages.slice(t.messages.findLastIndex(m=>m.role==="user")+1).filter(m=>m.role==="toolResult");
 if(node==="paid"){nativeResults.push(results);if(results.length===0)return call("work_claim",{key:"fake:paid1",intent:"native owned lease"});if(results.length===1 && action!=="unknown")return call("ask",{question:"effect fence barrier",kind:"decision",default:"deny",deadline_ms:60000});if(results.length<4)return call("fake_paid1",{});return fauxAssistantMessage("original candidate bytes retained");}
 if(node==="v")return fauxAssistantMessage(JSON.stringify({version:1,requirements:[{id:"R",verdict:"pass",evidence:"fake"}],summary:"fixture",repairable:false}));
 if(results.length)return fauxAssistantMessage("yield");return user==="start"?call("dag_run",{plan}):call("answer",{ask_id:askId,answer:action==="deny"?"deny":"approve",quote:user});}));
 const bot=await openBot({storage:new MemoryStorage(),models,defaultModel:{provider:"faux",modelId:"m"},toolMode:mode,plugins:[{id:"fake",tools:[{name:"fake_paid1",description:"fake only",inputSchema:{type:"object",properties:{},additionalProperties:false},oneUse:{reconcile:async()=>undefined},execute:async()=>{count++;throw Error("unknown ACK with fake effect");}}]}],settings:{retry:{enabled:false}}},context);bots.push(bot);const root=await bot.conversation("test",mode+action,context);
 await(await root.submit({type:"input",content:"start"},context)).wait(context);
 askId=(await until(()=>bot.harness.snapshot(AsksDoc,root.id,context),d=>!!d?.asks.some(a=>a.to==="human" && a.state==="open")))!.asks.find(a=>a.to==="human" && a.state==="open")!.id;
 await(await root.submit({type:"input",content:action==="deny"?"deny":"approve"},context)).wait(context);
 const api={conversationId:root.id,commit:bot.harness.commit.bind(bot.harness),snapshot:bot.harness.snapshot.bind(bot.harness)};
 if(action!=="deny" && action!=="unknown"){
 const asks=await until(()=>bot.harness.snapshot(AsksDoc,root.id,context),d=>!!d?.asks.some(a=>a.question==="effect fence barrier" && a.state==="open"));const barrier=asks!.asks.find(a=>a.question==="effect fence barrier" && a.state==="open")!;
 const run=(await bot.harness.snapshot(RunDoc,root.id,context))!.runs[0]!;const before=JSON.stringify(run.plan);const child=(await bot.harness.snapshot(AgentsDoc,root.id,context))!.agents.find(a=>a.taskId===run.nodes.paid!.handle)!;
 if(action==="cancel")await cancelDag(api,run.id,"STOP operator",{spawn:async()=>{throw Error("unused");},cancel:async()=>{throw Error("fixture intentionally noncooperative");}},context);
 if(action==="abort")await abortConversation(bot.harness,root,context);
 if(action==="handoff")await bot.work.transitionGoalAdmission(root.id,"native tool handoff",context);
 if(action==="newgoal"){const goal=(await bot.work.snapshot(root.id,context)).goal!;await(await root.submit({type:"input",content:JSON.stringify({dinobotGoalAmendment:{epoch:goal.epoch,hash:goal.hash,assertion:"New human goal; preserve old obligations"}})},context)).wait(context);}
 if(action==="stale-approval")await bot.harness.commit(async tx=>{delete (await tx.doc(AsksDoc,root.id)).asks.find(a=>a.id===askId)!.nodeKey;},context);
 await bot.harness.commit(async tx=>{resolveAsk(await tx.doc(AsksDoc,root.id),barrier.id,{state:"answered",answer:"late continue",by:"fixture:main",now:Date.now()});},context);
 await bot.harness.waitForTask(child.runnerId,context);await Bun.sleep(80);
 const after=(await bot.harness.snapshot(RunDoc,root.id,context))!.runs[0]!;expect(JSON.stringify(after.plan)).toBe(before);expect(after.certified).toEqual([]);expect(count).toBe(0);
 if(action==="cancel"){await closeTerminalDag(api,run.id,context);const leases=(await bot.harness.snapshot(ClaimsDoc,context))!.claims;expect(leases.some(c=>c.key==="fake:paid1")).toBe(false);}
 }else{await until(()=>bot.harness.snapshot(RunDoc,root.id,context),d=>d?.runs[0]?.status!=="running");expect(count).toBe(action==="unknown"?1:0);}
 const run=(await bot.harness.snapshot(RunDoc,root.id,context))!.runs[0]!;
 if(action==="unknown"){
 expect(run.status).toBe("blocked");expect(run.nodes.v!.runs).toBe(0);expect(run.nodes.paid!.effect?.phase).toBe("unknown");expect(run.nodes.paid!.unknownEffects).toBe(true);
 await bot.harness.commit(async tx=>{const leases=await tx.doc(ClaimsDoc);expect(leases.claims[0]?.quarantined).toContain("UNKNOWN");const owner=leases.claims[0]!.holder;expect(release(leases,owner,undefined,Date.now()+99999999)).toEqual([]);expect(acquire(leases,{key:"fake:paid1",holder:"foreign-idle",intent:"must not evict",ttlMs:60000},Date.now()+99999999).status).toBe("conflict");},context);
 }
 console.log(JSON.stringify({mode,action,count,run,nativeResults,claims:await bot.harness.snapshot(ClaimsDoc,context)}));
},15000);
