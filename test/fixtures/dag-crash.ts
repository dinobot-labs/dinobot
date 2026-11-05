import type { Seq, TaskRecord } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openBot } from "../../src/core/bot.ts";
import { RunDoc } from "../../src/core/dag.ts";
import { readFileSync, writeFileSync } from "node:fs";
const [directory,cut,mode]=process.argv.slice(2);
const storage=await openNodeSqliteStorage(directory+"/store.sqlite");
const commit=storage.commit.bind(storage);
let killed=false;
function runningCheckpoint(task: TaskRecord<JsonValue, JsonValue, JsonValue>) {
 if(task.state.status!=="running")return undefined;
 const value=task.state.checkpoint;
 return value!==null&&typeof value==="object"&&!Array.isArray(value)?value:undefined;
}
if(mode==="crash") storage.commit=async(batches,receive,c)=>{
 let seq: Seq | undefined;
 const result=await commit(batches,(index,committed)=>{seq=committed;receive(index,committed);},c);
 const writes=batches.slice(0,result.stored).flat();
 const tasks=writes.filter(w=>w.type==="task").map(w=>w.value);
 const terminal=tasks.some(t=>t.kind==="dinobot.subagent"&&t.state.status==="terminal"&&t.state.outcome.status==="completed"&&t.state.outcome.result==="actor output");
 const wake=tasks.some(t=>{const checkpoint=runningCheckpoint(t);return t.kind==="dinobot.dag-continuation"&&checkpoint?.phase==="advance"&&typeof checkpoint.epoch==="number"&&checkpoint.epoch>0;});
 const wait=tasks.some(t=>t.kind==="dinobot.dag-continuation"&&runningCheckpoint(t)?.phase==="wait");
 const ack=tasks.some(t=>t.kind==="dinobot.dag-continuation"&&t.state.status==="terminal"&&t.state.outcome.status==="completed"&&typeof t.state.outcome.result==="string"&&t.state.outcome.result.includes("[verified]"));
 if(!killed&&((cut==="terminal"&&terminal)||(cut==="wake"&&wake)||(cut==="wait"&&wait)||(cut==="ack"&&ack))) {
  if(seq===undefined)throw new Error("Missing committed crash sequence");
  killed=true;writeFileSync(directory+"/cut.json",JSON.stringify({cut,signal:"SIGKILL",seq,writes},null,2)); console.log("SIGKILL "+cut+" seq="+seq);process.kill(process.pid,"SIGKILL");
 }
 return result;
};
const faux=fauxProvider({provider:"faux",models:[{id:"fixture"}]});
const plan={nodes:[{id:"actor",kind:"act",writes:["out"]},{id:"v",kind:"verify",reads:["out"],covers:["R"]}],edges:[["actor","v"]],goal:{requirements:["R"]}};
faux.setResponses(Array.from({length:80},()=>t=>{
 const input=String(t.messages.findLast(m=>m.role==="user")?.content);
 const node=/plan node "([^"]+)"/.exec(input)?.[1];
 if(node) return fauxAssistantMessage(node==="actor"?"actor output":JSON.stringify({version:1,requirements:[{id:"R",verdict:"pass",evidence:"fixture artifact checked"}],summary:"ok",repairable:false}));
 const results=t.messages.slice(t.messages.findLastIndex(m=>m.role==="user")+1).filter(m=>m.role==="toolResult");
 return !results.length?fauxAssistantMessage(fauxToolCall("dag_run",{plan}),{stopReason:"toolUse"}):results.length===1?fauxAssistantMessage(fauxToolCall("dag_step",{}),{stopReason:"toolUse"}):fauxAssistantMessage("done");
}));
const models=createModels();models.setProvider(faux.provider);
const bot=await openBot({storage,models,defaultModel:{provider:"faux",modelId:"fixture"},toolMode:"direct",plugins:[],settings:{retry:{enabled:false}}},context);
if(mode==="crash") {
 const parent=await bot.conversation("test","crash",context);writeFileSync(directory+"/parent.json",JSON.stringify(parent.id));
 await (await parent.submit({type:"input",content:"start"},context)).wait(context);
 for(let i=0;i<500;i++){await Bun.sleep(10);if(killed)break;}
 await bot.close(context);throw new Error("cut not reached: "+cut);
} else {
 const parent=JSON.parse(readFileSync(directory+"/parent.json","utf8"));
 for(let i=0;i<500;i++){if(!(await bot.harness.inspect(context)).tasks.length)break;await Bun.sleep(10);}
 const run=(await bot.harness.snapshot(RunDoc,parent,context))!.runs[0]!;
 console.log(JSON.stringify(run));
 if(run.status!=="verified"||run.nodes.actor!.runs!==1||run.nodes.v!.runs!==1)throw new Error("recovery failed or duplicate dispatch");
 await bot.close(context);
}
