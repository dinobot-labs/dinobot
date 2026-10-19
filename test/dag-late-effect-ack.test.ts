import { test, expect } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openBot } from "../src/core/bot.ts";
import { RunDoc } from "../src/core/dag.ts";
import { AsksDoc } from "../src/core/ask.ts";
import { ClaimsDoc } from "../src/core/claims.ts";
import { cancelDag, closeTerminalDag } from "../src/extensions/dag.ts";
import { AgentsDoc } from "../src/extensions/subagents.ts";
async function until<T>(read:()=>Promise<T>,ready:(v:T)=>boolean):Promise<T>{for(let i=0;i<400;i++){const v=await read();if(ready(v))return v;await Bun.sleep(10);}throw Error("native fixture barrier not reached");}
for(const mode of ["direct","codemode-only"] as const)test("T10/T12 native late definitive ACK after STOP cannot certify or release uncertainty "+mode,async()=>{
 let count=0,askId="";const ack=Promise.withResolvers<void>();const effect=Promise.withResolvers<void>();
 const faux=fauxProvider({provider:"faux",models:[{id:"m"}]});const models=createModels();models.setProvider(faux.provider);
 const plan={nodes:[{id:"q",kind:"ask"},{id:"paid",kind:"act",irreversible:true,writes:["fake:late"]},{id:"v",kind:"verify",reads:["fake:late"],covers:["R"]}],edges:[["q","paid"],["paid","v"]],goal:{requirements:["R"]}};
 const call=(name:string,args:import("@earendil-works/pi-ai").JsonObject)=>fauxAssistantMessage(mode==="direct"?fauxToolCall(name,args):fauxToolCall("codemode",{code:"text(await tools."+name+"("+JSON.stringify(args)+"));"}),{stopReason:"toolUse"});
 faux.setResponses(Array.from({length:70},()=>t=>{const user=String(t.messages.findLast(m=>m.role==="user")?.content);const node=/plan node "([^"]+)"/.exec(user)?.[1];const results=t.messages.slice(t.messages.findLastIndex(m=>m.role==="user")+1).filter(m=>m.role==="toolResult");if(node==="paid")return results.length===0?call("work_claim",{key:"fake:late",intent:"fake owned"}):results.length===1?call("fake_paid1",{}):fauxAssistantMessage("retained original candidate");if(node==="v")throw Error("late ACK must not dispatch verifier");if(results.length)return fauxAssistantMessage("yield");return user==="start"?call("dag_run",{plan}):call("answer",{ask_id:askId,answer:"approve",quote:user});}));
 const bot=await openBot({storage:new MemoryStorage(),models,defaultModel:{provider:"faux",modelId:"m"},toolMode:mode,plugins:[{id:"fake",tools:[{name:"fake_paid1",description:"fake only",inputSchema:{type:"object",properties:{},additionalProperties:false},oneUse:{},execute:async()=>{count++;effect.resolve();await ack.promise;return {receipt:"definitive-fake-late"};}}]}],settings:{retry:{enabled:false}}},context);
 try{const root=await bot.conversation("test",mode+"lateACK",context);await(await root.submit({type:"input",content:"start"},context)).wait(context);askId=(await until(()=>bot.harness.snapshot(AsksDoc,root.id,context),d=>!!d?.asks.some(a=>a.state==="open")))!.asks.find(a=>a.state==="open")!.id;await(await root.submit({type:"input",content:"approve"},context)).wait(context);await effect.promise;
 const api={conversationId:root.id,commit:bot.harness.commit.bind(bot.harness),snapshot:bot.harness.snapshot.bind(bot.harness)};const run=(await bot.harness.snapshot(RunDoc,root.id,context))!.runs[0]!;const child=(await bot.harness.snapshot(AgentsDoc,root.id,context))!.agents.find(a=>a.taskId===run.nodes.paid!.handle)!;
 await cancelDag(api,run.id,"STOP while fake ACK pending",{spawn:async()=>{throw Error("unused");},cancel:async()=>{throw Error("noncooperative owned fixture");}},context);
 expect((await bot.harness.snapshot(ClaimsDoc,context))!.claims[0]!.quarantined).toContain("UNKNOWN");ack.resolve();await bot.harness.waitForTask(child.runnerId,context);const after=await closeTerminalDag(api,run.id,context);
 expect(count).toBe(1);expect(after.status).toBe("cancelled");expect(after.nodes.v!.runs).toBe(0);expect(after.certified).toEqual([]);expect(after.nodes.paid!.effect?.receipt).toBe("definitive-fake-late");expect(after.nodes.paid!.unknownEffects).toBe(true);expect((await bot.harness.snapshot(ClaimsDoc,context))!.claims[0]!.quarantined).toContain("UNKNOWN");console.log(JSON.stringify({mode,count,after,claims:await bot.harness.snapshot(ClaimsDoc,context)}));
 }finally{ack.resolve();await bot.close(context);}
},15000);
