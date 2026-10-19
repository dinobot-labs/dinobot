import { afterEach, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openBot, type Bot } from "../src/core/bot.ts";
import { RunDoc } from "../src/core/dag.ts";
import { WorkDoc, validHumanAcceptance } from "../src/core/verification.ts";
import { AsksDoc, resolveAsk } from "../src/core/ask.ts";
import { AgentsDoc } from "../src/extensions/subagents.ts";
import { advanceDag } from "../src/extensions/dag.ts";
const bots:Bot[]=[];const dirs:string[]=[];
afterEach(async()=>{for(const b of bots.splice(0))await b.close(context);for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
async function setup(router:any) {const models=createModels();const faux=fauxProvider({provider:"faux",models:[{id:"m"}]});models.setProvider(faux.provider);faux.setResponses(Array.from({length:40},()=>router));const bot=await openBot({storage:new MemoryStorage(),models,defaultModel:{provider:"faux",modelId:"m"},plugins:[],toolMode:"direct",settings:{retry:{enabled:false}}},context);bots.push(bot);const root=await bot.conversation("test","admission",context);const send=async(text:string)=>await(await root.submit({type:"input",content:text},context)).wait(context);return {bot,root,send,faux};}
async function until<T>(read:()=>Promise<T>,ready:(v:T)=>boolean):Promise<T> {for(let i=0;i<200;i++){const v=await read();if(ready(v))return v;await Bun.sleep(10);}throw Error("fixture never reached expected native state");}
test("T07 initial and same-ID semantic weakening cannot certify original full source across phase DAGs",async()=>{
 let runId:string|undefined;let narrowed=false;
 const s=await setup((t:any)=>{const user=String(t.messages.findLast((m:any)=>m.role==="user")?.content);if(user.includes("plan node"))return fauxAssistantMessage(JSON.stringify({version:1,requirements:[{id:"original",verdict:"pass",evidence:"ID skeleton only"}],summary:"100",repairable:false}));const results=t.messages.slice(t.messages.findLastIndex((m:any)=>m.role==="user")+1).filter((m:any)=>m.role==="toolResult");if(results.length)return fauxAssistantMessage("100");return fauxAssistantMessage(fauxToolCall("dag_run",{plan:{nodes:[{id:"v",kind:"verify",description:narrowed?"only IDs no bodies":"full body",covers:["original"]}],edges:[],goal:{requirements:["original"]}},...(runId?{run_id:runId}:{})}),{stopReason:"toolUse"});});
 await s.send("ALL original full visible bodies, not ID skeletons, including owned recursive children");
 let run=await until(()=>s.bot.harness.snapshot(RunDoc,s.root.id,context),d=>d?.runs[0]?.status==="verified");runId=run!.runs[0]!.id;
 const original=(await s.bot.work.snapshot(s.root.id,context)).goal!;
 expect((await s.bot.work.snapshot(s.root.id,context)).goal!.sources).toEqual(original.sources);expect(validHumanAcceptance(await s.bot.work.snapshot(s.root.id,context))).toBe(false);
 narrowed=true;await s.send("continue phase");
 expect((await s.bot.harness.snapshot(RunDoc,s.root.id,context))!.runs[0]!.revision).toBe(0); // terminal replan rejected natively
 runId=undefined;await s.send("new local phase with same requirement ID");
 run=await until(()=>s.bot.harness.snapshot(RunDoc,s.root.id,context),d=>d?.runs.length===2&&d.runs[1]?.status==="verified");
 expect(run!.runs[1]!.plan.nodes[0]!.description).toBe("only IDs no bodies");expect((await s.bot.work.snapshot(s.root.id,context)).goal!.sources).toEqual(original.sources);
 expect((await s.bot.work.snapshot(s.root.id,context)).goal!.sources).toEqual(original.sources);expect(validHumanAcceptance(await s.bot.work.snapshot(s.root.id,context))).toBe(false);
 // A forged acceptance-shaped document is not actual-human evidence.
 await s.bot.harness.commit(async tx=>{const g=(await tx.doc(WorkDoc,s.root.id)).goal!;g.acceptance={epoch:g.epoch,hash:g.hash,sourceId:g.sources[0]!.sourceId,inputHash:"forged",at:Date.now()};},context);
 expect((await s.bot.work.snapshot(s.root.id,context)).goal!.sources).toEqual(original.sources);expect(validHumanAcceptance(await s.bot.work.snapshot(s.root.id,context))).toBe(false);
});
test("T12 actual-human epoch amendment rejects old child write/wake/ACK, preserving candidate and source",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"goal-epoch-"));dirs.push(dir);const path=join(dir,"stale.txt");
 const s=await setup((t:any)=>{const user=String(t.messages.findLast((m:any)=>m.role==="user")?.content);const results=t.messages.slice(t.messages.findLastIndex((m:any)=>m.role==="user")+1).filter((m:any)=>m.role==="toolResult");if(user.includes('plan node "a"')) {if(!results.length)return fauxAssistantMessage(fauxToolCall("ask",{question:"pause old epoch child",kind:"clarification",default:"deny",deadline_ms:60000}),{stopReason:"toolUse"});if(results.length===1)return fauxAssistantMessage(fauxToolCall("write",{path,content:"OLD_STALE_EFFECT"}),{stopReason:"toolUse"});return fauxAssistantMessage("old candidate");}if(user.startsWith("{"))return fauxAssistantMessage("amendment recorded");if(results.length)return fauxAssistantMessage("yield");return fauxAssistantMessage(fauxToolCall("dag_run",{plan:{nodes:[{id:"a",kind:"act",writes:["scratch"]},{id:"v",kind:"verify",reads:["scratch"],covers:["R"]}],edges:[["a","v"]],goal:{requirements:["R"]}}}),{stopReason:"toolUse"});});
 await s.send("Original full purpose");
 const asks=await until(()=>s.bot.harness.snapshot(AsksDoc,s.root.id,context),d=>!!d?.asks.some(a=>a.state==="open"));const ask=asks!.asks.find(a=>a.state==="open")!;
 const original=(await s.bot.work.snapshot(s.root.id,context)).goal!;const before=(await s.bot.harness.snapshot(RunDoc,s.root.id,context))!.runs[0]!;
 await s.send(JSON.stringify({dinobotGoalAmendment:{epoch:original.epoch,hash:original.hash,assertion:"Additional actual-human requirement; retain original full purpose"}}));
 await s.bot.harness.commit(async tx=>{resolveAsk(await tx.doc(AsksDoc,s.root.id),ask.id,{state:"answered",answer:"continue",by:"fixture:main",now:Date.now()});},context);
 const agents=(await s.bot.harness.snapshot(AgentsDoc,s.root.id,context))!.agents;const child=agents.find(a=>a.taskId===before.nodes.a!.handle)!;
 await s.bot.harness.waitForTask(child.runnerId,context);
 expect(await readFile(path,"utf8").catch(()=>undefined)).toBeUndefined();
 const result=await advanceDag({conversationId:s.root.id,commit:s.bot.harness.commit.bind(s.bot.harness),snapshot:s.bot.harness.snapshot.bind(s.bot.harness)},before.id,context,{dispatch:async()=>{throw Error("stale dispatch admitted");}});
 expect(result.run.status).toBe("blocked");expect(result.run.reason).toContain("stale_goal_admission_epoch");expect(result.run.nodes.v!.runs).toBe(0);expect(result.run.nodes.a!.handle).toBe(before.nodes.a!.handle);
 expect((await s.bot.work.snapshot(s.root.id,context)).goal!.sources).toEqual(original.sources);
});
test("T12 native handoff/reset advances admission epoch but retains full source assertions",async()=>{
 const s=await setup(()=>fauxAssistantMessage("provisional"));await s.send("Original immutable full purpose");const original=(await s.bot.work.snapshot(s.root.id,context)).goal!;
 await s.root.reset("handoff context only; not a human amendment",context);await s.bot.work.reconcileSources(s.root.id,[],context);
 const after=(await s.bot.work.snapshot(s.root.id,context)).goal!;expect(after.epoch).toBe(original.epoch+1);expect(after.sources).toEqual(original.sources);expect(after.hash).toBe(original.hash);
});
