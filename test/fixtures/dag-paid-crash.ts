import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openBot, type Bot } from "../../src/core/bot.ts";
import { RunDoc } from "../../src/core/dag.ts";
import { AsksDoc } from "../../src/core/ask.ts";
import { reconcileManagedEffects } from "../../src/core/managed-effects.ts";
import type { LoadedPlugin } from "../../src/plugins/types.ts";
const [dir,modeArg,stage]=process.argv.slice(2);const mode=modeArg as "direct"|"codemode-only";
if(!dir || !["direct","codemode-only"].includes(mode) || !["crash","recover"].includes(stage!))throw Error("bad fixture arguments");
const provider=new DatabaseSync(join(dir,"FAKE-provider.sqlite"));provider.exec("CREATE TABLE IF NOT EXISTS effects (id TEXT PRIMARY KEY, receipt TEXT); CREATE TABLE IF NOT EXISTS calls (id TEXT)");
const count=()=>Number((provider.prepare("SELECT count(*) AS n FROM calls").get() as {n:number}).n);
const plugin:LoadedPlugin={id:"fake",tools:[{name:"fake_paid1",description:"fake only",inputSchema:{type:"object",properties:{},additionalProperties:false},oneUse:{reconcile:async id=>{const row=provider.prepare("SELECT receipt FROM effects WHERE id=?").get(id) as {receipt:string}|undefined;return row;}},execute:async(_args,call)=>{
 if(!call.effectId)throw Error("missing host effectId");provider.prepare("INSERT INTO calls VALUES (?)").run(call.effectId);provider.prepare("INSERT INTO effects VALUES (?,?)").run(call.effectId,"fake-paid1");
 console.log("FAKE_EFFECT_COMMITTED",JSON.stringify({id:call.effectId,count:count()}));
 process.kill(process.pid,"SIGKILL");await Bun.sleep(10000);throw Error("SIGKILL did not cut fixture");}}]};
const plan={nodes:[{id:"q",kind:"ask",description:"Allow fake paid1?"},{id:"paid",kind:"act",irreversible:true,writes:["fake:paid1"]},{id:"v",kind:"verify",reads:["fake:paid1"],covers:["R"]}],edges:[["q","paid"],["paid","v"]],goal:{requirements:["R"]}};
const faux=fauxProvider({provider:"faux",models:[{id:"m"}]});const models=createModels();models.setProvider(faux.provider);let askId="";
const call=(name:string,args:import("@earendil-works/pi-ai").JsonObject)=>fauxAssistantMessage(mode==="direct"?fauxToolCall(name,args):fauxToolCall("codemode",{code:"text(await tools."+name+"("+JSON.stringify(args)+"));"}),{stopReason:"toolUse"});
faux.setResponses(Array.from({length:120},()=>t=>{const user=String(t.messages.findLast(m=>m.role==="user")?.content);const node=/plan node "([^"]+)"/.exec(user)?.[1];const results=t.messages.slice(t.messages.findLastIndex(m=>m.role==="user")+1).filter(m=>m.role==="toolResult");
 if(node==="paid")return results.length?fauxAssistantMessage("effect result retained"):call("fake_paid1",{});
 if(node==="v")return fauxAssistantMessage(JSON.stringify({version:1,requirements:[{id:"R",verdict:"pass",evidence:"fake receipt"}],summary:"fixture",repairable:false}));
 if(results.length)return fauxAssistantMessage("yield");return user==="start"?call("dag_run",{plan}):call("answer",{ask_id:askId,answer:"approve",quote:user});}));
const bot=await openBot({storage:await openNodeSqliteStorage(join(dir,"harness.sqlite")),models,defaultModel:{provider:"faux",modelId:"m"},toolMode:mode,plugins:[plugin],settings:{retry:{enabled:false}}},context);
try{
 const root=await bot.conversation("test","paid-crash",context);
 if(stage==="crash"){
 await(await root.submit({type:"input",content:"start"},context)).wait(context);
 for(let i=0;i<400;i++){askId=(await bot.harness.snapshot(AsksDoc,root.id,context))?.asks.find(a=>a.state==="open")?.id??"";if(askId)break;await Bun.sleep(10);}if(!askId)throw Error("no native authority gate");
 await(await root.submit({type:"input",content:"approve"},context)).wait(context);await Bun.sleep(10000);throw Error("effect crash cut not reached");
 }else{
 await reconcileManagedEffects(bot.harness,plugin.tools,context);await Bun.sleep(200);
 const run=(await bot.harness.snapshot(RunDoc,root.id,context))!.runs[0]!;const effect=run.nodes.paid!.effect;
 if(count()!==1 || effect?.receipt!=="fake-paid1" || effect.phase!=="receipt" || !effect.authority.length)throw Error("lostACK recovery violated count or exact receipt binding");
 console.log("RECOVERED",JSON.stringify({mode,count:count(),effect,runStatus:run.status,certified:run.certified}));
 }
}finally{await bot.close(context);provider.close();Bun.gc(true);}
