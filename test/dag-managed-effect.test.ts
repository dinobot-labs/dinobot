import { afterEach, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openBot, type Bot } from "../src/core/bot.ts";
import { RunDoc } from "../src/core/dag.ts";
import { AsksDoc } from "../src/core/ask.ts";
import { ClaimsDoc, acquire } from "../src/core/claims.ts";
import { OwnerClaimsDoc } from "../src/core/claim-cleanup.ts";
import { AgentsDoc } from "../src/extensions/subagents.ts";
import { closeTerminalDag } from "../src/extensions/dag.ts";
import type { LoadedPlugin, PluginToolCall } from "../src/plugins/types.ts";
const bots:Bot[]=[];
afterEach(async()=>{for(const bot of bots.splice(0))await bot.close(context);});
const plan={nodes:[{id:"q",kind:"ask",description:"Allow fake paid1 only?"},{id:"paid",kind:"act",irreversible:true,writes:["fake:paid1"]},{id:"v",kind:"verify",reads:["fake:paid1"],covers:["R"]}],edges:[["q","paid"],["paid","v"]],goal:{requirements:["R"]}};
async function until<T>(read:()=>Promise<T>,ready:(v:T)=>boolean):Promise<T>{for(let i=0;i<400;i++){const v=await read();if(ready(v))return v;await Bun.sleep(10);}throw Error("native fixture barrier not reached");}
for(const mode of ["direct","codemode-only"] as const) for(const lost of [false,true]) test("T10/T11 native one-use paid1 count1, lostACK="+lost+" "+mode,async()=>{
 let effects=0; const receipts=new Map<string,string>();
 const plugin:LoadedPlugin={id:"fake",tools:[{name:"fake_paid1",description:"Isolated fake effect only",inputSchema:{type:"object",properties:{},additionalProperties:false},
  ...{oneUse:{reconcile:async(id:string)=>receipts.has(id)?{receipt:receipts.get(id)!}:undefined}},
  execute:async(_args:unknown,options:PluginToolCall)=>{effects++;const id=(options as PluginToolCall & {effectId?:string}).effectId ?? "unguarded";receipts.set(id,"fake-receipt-"+effects);if(lost)throw Error("lost ACK after fake effect");return {receipt:receipts.get(id)};}}]};
 const faux=fauxProvider({provider:"faux",models:[{id:"m"}]});const models=createModels();models.setProvider(faux.provider);
 const call=(name:string,args:import("@earendil-works/pi-ai").JsonObject)=>fauxAssistantMessage(mode==="direct"?fauxToolCall(name,args):fauxToolCall("codemode",{code:"text(await tools."+name+"("+JSON.stringify(args)+"));"}),{stopReason:"toolUse"});
 let askId="";
 faux.setResponses(Array.from({length:70},()=>t=>{const user=String(t.messages.findLast(m=>m.role==="user")?.content);const node=/plan node "([^"]+)"/.exec(user)?.[1];const results=t.messages.slice(t.messages.findLastIndex(m=>m.role==="user")+1).filter(m=>m.role==="toolResult");
 if(node==="paid"){console.log("PAID RESULTS",JSON.stringify(results));if(results.length===0)return call("work_claim",{key:"fake:paid1",intent:"fixture owns output"});if(results.length<3)return call("fake_paid1",{});return fauxAssistantMessage("fake effect done");}
 if(node==="v")return fauxAssistantMessage(JSON.stringify({version:1,requirements:[{id:"R",verdict:"pass",evidence:"fake receipt checked"}],summary:"fixture",repairable:false}));
 if(results.length)return fauxAssistantMessage("yield");return user==="start"?call("dag_run",{plan}):call("answer",{ask_id:askId,answer:"approve",quote:user});}));
 const bot=await openBot({storage:new MemoryStorage(),models,defaultModel:{provider:"faux",modelId:"m"},toolMode:mode,plugins:[plugin],settings:{retry:{enabled:false}}},context);bots.push(bot);const root=await bot.conversation("test",mode+lost,context);
 await(await root.submit({type:"input",content:"start"},context)).wait(context);
 askId=(await until(()=>bot.harness.snapshot(AsksDoc,root.id,context),d=>!!d?.asks.some(a=>a.state==="open")))!.asks.find(a=>a.state==="open")!.id;
 await(await root.submit({type:"input",content:"approve"},context)).wait(context);
 const run=(await until(()=>bot.harness.snapshot(RunDoc,root.id,context),d=>d?.runs[0]?.status!=="running"))!.runs[0]!;
 console.log("BEFORE ASSERT",JSON.stringify({effects,run,asks:await bot.harness.snapshot(AsksDoc,root.id,context)})); expect(effects).toBe(1);expect(run.status).toBe("verified");
 expect((await bot.harness.snapshot(ClaimsDoc,context))?.claims.filter(c=>c.key==="fake:paid1")).toEqual([]);
 const child=(await bot.harness.snapshot(AgentsDoc,root.id,context))!.agents.find(a=>a.taskId===run.nodes.paid!.handle)!;
 const provenance=(await bot.harness.snapshot(OwnerClaimsDoc,child.conversationId,context))!.claims[0]!;
 await bot.harness.commit(async tx=>{const leases=await tx.doc(ClaimsDoc);acquire(leases,{key:"fake:paid1",holder:provenance.claim.holder,intent:"successor same canonical owner",ttlMs:60000},Date.now());acquire(leases,{key:"foreign:idle",holder:"test:idle-foreign",intent:"must never evict",ttlMs:60000},Date.now());},context);
 const before=await bot.harness.snapshot(ClaimsDoc,context);
 await closeTerminalDag({conversationId:root.id,commit:bot.harness.commit.bind(bot.harness),snapshot:bot.harness.snapshot.bind(bot.harness)},run.id,context);
 expect(await bot.harness.snapshot(ClaimsDoc,context)).toEqual(before);
 expect(before!.claims.find(c=>c.key==="fake:paid1")!.token).not.toBe(provenance.claim.token);
 console.log(JSON.stringify({mode,lost,effects,run,claims:await bot.harness.snapshot(ClaimsDoc,context)}));
},15000);
