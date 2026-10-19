import { afterEach, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openBot, type Bot } from "../src/core/bot.ts";
import { RunDoc, createRun } from "../src/core/dag.ts";
import { WorkDoc } from "../src/core/verification.ts";
import { AsksDoc, resolveAsk } from "../src/core/ask.ts";
import { cancelDag } from "../src/extensions/dag.ts";
import { AgentsDoc } from "../src/extensions/subagents.ts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const bots: Bot[]=[]; const dirs: string[]=[];
afterEach(async()=>{for(const b of bots.splice(0))await b.close(context);for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
const plan={nodes:[{id:"a",kind:"act" as const,writes:["scratch"]},{id:"v",kind:"verify" as const,reads:["scratch"],covers:["R"]}],edges:[["a","v"]] as [string,string][],goal:{requirements:["R"]}};
async function until<T>(read:()=>Promise<T>,ready:(v:T)=>boolean):Promise<T>{for(let i=0;i<300;i++){const v=await read();if(ready(v))return v;await Bun.sleep(10);}throw Error("fixture did not reach durable barrier");}
async function setup(path:string){
 const models=createModels();const faux=fauxProvider({provider:"faux",models:[{id:"m"}]});models.setProvider(faux.provider);
 faux.setResponses(Array.from({length:60},()=>t=>{const input=String(t.messages.findLast(m=>m.role==="user")?.content);const results=t.messages.slice(t.messages.findLastIndex(m=>m.role==="user")+1).filter(m=>m.role==="toolResult");
 if(input.includes("plan node \"a\"")){if(!results.length)return fauxAssistantMessage(fauxToolCall("ask",{question:"native cancel barrier",kind:"decision",default:"deny",deadline_ms:60000}),{stopReason:"toolUse"});if(results.length===1)return fauxAssistantMessage(fauxToolCall("write",{path,content:"FORBIDDEN_AFTER_CANCEL"}),{stopReason:"toolUse"});return fauxAssistantMessage("old candidate");}
 return results.length?fauxAssistantMessage("yield"):fauxAssistantMessage(fauxToolCall("dag_run",{plan}),{stopReason:"toolUse"});}));
 const bot=await openBot({storage:new MemoryStorage(),models,defaultModel:{provider:"faux",modelId:"m"},toolMode:"direct",plugins:[],settings:{retry:{enabled:false}}},context);bots.push(bot);const root=await bot.conversation("test","cancel-fence",context);return {bot,root};
}
test("T12 cancel remains available after a human handoff without accepting stale outcomes",async()=>{
 const s=await setup("unused");const run=createRun("legacy",plan,Date.now());
 await s.bot.harness.commit(async tx=>{const goal=(await tx.doc(WorkDoc,s.root.id));goal.goal={epoch:2,hash:"current",sources:[],amendments:[]};run.goalBinding={epoch:1,hash:"old"};(await tx.doc(RunDoc,s.root.id)).runs.push(run);},context);
 const result=await cancelDag({conversationId:s.root.id,commit:s.bot.harness.commit.bind(s.bot.harness),snapshot:s.bot.harness.snapshot.bind(s.bot.harness)},run.id,"stop stale candidate",undefined,context);
 expect(result.run.status).toBe("cancelled");expect(result.run.nodes.v!.runs).toBe(0);expect(result.run.certified).toEqual([]);
});
for(const legacy of [false,true]) test("T10/T12 cancel fences new managed writes even if executor cannot be stopped; legacy="+legacy,async()=>{
 const dir=await mkdtemp(join(tmpdir(),"cancel-fence-"));dirs.push(dir);const path=join(dir,"out.txt");const {bot,root}=await setup(path);
 await(await root.submit({type:"input",content:"Original full purpose"},context)).wait(context);
 const asks=await until(()=>bot.harness.snapshot(AsksDoc,root.id,context),d=>!!d?.asks.some(a=>a.state==="open"));const ask=asks!.asks.find(a=>a.state==="open")!;
 const before=(await bot.harness.snapshot(RunDoc,root.id,context))!.runs[0]!;const child=(await bot.harness.snapshot(AgentsDoc,root.id,context))!.agents.find(a=>a.taskId===before.nodes.a!.handle)!;
 if(legacy) await bot.harness.commit(async tx=>{delete (await tx.doc(WorkDoc,child.conversationId)).dagParent;},context);
 let statusBeforeStop:string|undefined;
 const result=await cancelDag({conversationId:root.id,commit:bot.harness.commit.bind(bot.harness),snapshot:bot.harness.snapshot.bind(bot.harness)},before.id,"operator cancellation",{spawn:async()=>{throw Error("unused");},cancel:async()=>{statusBeforeStop=(await bot.harness.snapshot(RunDoc,root.id,context))!.runs[0]!.status;throw Error("executor not stopped");}},context);
 expect(statusBeforeStop).toBe("cancelled");expect(result.unstopped).toHaveLength(1);expect(result.run.nodes.a!.handle).toBe(before.nodes.a!.handle);
 await bot.harness.commit(async tx=>{resolveAsk(await tx.doc(AsksDoc,root.id),ask.id,{state:"answered",answer:"late continue",by:"fixture:main",now:Date.now()});},context);
 await bot.harness.waitForTask(child.runnerId,context);
 expect(await readFile(path,"utf8").catch(()=>undefined)).toBeUndefined();
 expect((await bot.harness.snapshot(RunDoc,root.id,context))!.runs[0]!.certified).toEqual([]);
},15000);
