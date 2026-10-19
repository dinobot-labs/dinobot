import { afterEach, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { openBot, type Bot } from "../src/core/bot.ts";
import { RunDoc } from "../src/core/dag.ts";
import { advanceDag, reconcileDag, type DagApi } from "../src/extensions/dag.ts";
import type { Plan } from "../src/core/plan.ts";
const context = BACKGROUND_CONTEXT;
const bots: Bot[] = [];
afterEach(async () => { for (const bot of bots.splice(0)) await bot.close(context); });
const verdict = (id: string, pass: boolean) => JSON.stringify({ version: 1, requirements: [{id, verdict: pass ? "pass" : "fail", evidence: pass ? "fixture checked source" : "confirmed broken artifact"}], summary: "fixture", repairable: !pass });
async function setup(plan: Plan, database?: string, manualSettlement = false) {
 const faux = fauxProvider({ provider: "faux", models: [{id: "fixture"}] });
 const router: FauxResponseFactory = t => {
  const input = String(t.messages.findLast(m => m.role === "user")?.content);
  const node = /plan node "([^"]+)"/.exec(input)?.[1];
  if (node) return fauxAssistantMessage(node === "bad" ? verdict("R", false) : node === "peer" ? verdict("S", true) : node === "v" ? verdict("R", true) : "actor output");
  const results = t.messages.slice(t.messages.findLastIndex(m => m.role === "user") + 1).filter(m => m.role === "toolResult");
  if(input === "step") return results.length ? fauxAssistantMessage("stepped") : fauxAssistantMessage(fauxToolCall("dag_step", {}), {stopReason:"toolUse"});
  if (!results.length) return fauxAssistantMessage(fauxToolCall("dag_run", {plan: plan as never}), {stopReason:"toolUse"});
  if (results.length === 1) return fauxAssistantMessage(fauxToolCall("dag_step", {}), {stopReason:"toolUse"});
  return fauxAssistantMessage("dispatched; parent yields");
 };
 faux.setResponses(Array.from({length:80}, () => router));
 const models = createModels(); models.setProvider(faux.provider);
 const bot = await openBot({storage:database ? await openNodeSqliteStorage(database) : new MemoryStorage(), models, defaultModel:{provider:"faux",modelId:"fixture"}, toolMode:"direct", plugins:[], settings:{retry:{enabled:false}}}, context);
 bots.push(bot);
 const parent = await bot.conversation("test", "hsad-red", context);
 // Scheduling barrier for T17: observe both durable deliveries before the real advanceDag call.
 if (manualSettlement) await parent.configure({extensions:{remove:[defineExtension({name:"dag-continuation"})]}},context);
 await (await parent.submit({type:"input",content:"start fixture"}, context)).wait(context);
 const api: DagApi = {conversationId:parent.id,commit:bot.harness.commit.bind(bot.harness),snapshot:bot.harness.snapshot.bind(bot.harness)};
 const state = async () => (await bot.harness.snapshot(RunDoc,parent.id,context))!.runs[0]!;
 async function terminal(...ids: string[]) {
  for(let i=0;i<500;i++) { const r=await state(); const outcomes=await reconcileDag(api,r,context); if(ids.every(id=>outcomes.some(o=>o.id===id) || ["succeeded","failed"].includes(r.nodes[id]!.status))) return; await Bun.sleep(10); }
  throw new Error("fixture children did not reach durable terminal state");
 }
 return {bot,parent,api,state,terminal,models};
}
test("T17: settled parallel shared-writer reviewers retain repair until quiescence", async () => {
 const p: Plan = {nodes:[{id:"actor",kind:"act",writes:["fixture/out"]},{id:"bad",kind:"verify",reads:["fixture/out"],covers:["R"],repair:{predecessorId:"actor",maxRepairs:2}},{id:"peer",kind:"verify",reads:["fixture/out"],covers:["S"]}],edges:[["actor","bad"],["actor","peer"]],goal:{requirements:["R","S"]}};
 const {parent,api,state,terminal} = await setup(p, undefined, true);
 await terminal("actor");
 await (await parent.submit({type:"input",content:"step"},context)).wait(context);
 await terminal("bad","peer");
 const before=await state();
 expect(before.nodes.bad!.status).toBe("running");expect(before.nodes.peer!.status).toBe("running");
 const outcomes=await reconcileDag(api,before,context);
 expect(outcomes.map(o=>o.id).sort()).toEqual(["bad","peer"]);
 const dispatched: string[]=[];
 const result=await advanceDag(api,before.id,context,{dispatch:async(_r,n)=>{dispatched.push(n.id);}});
 console.log("T17 durable observation",JSON.stringify(result.run));
 expect(result.run.repairsUsed).toBe(1);
 expect(result.run.repairHistory?.[0]?.failure).toContain("confirmed broken artifact");
 expect(dispatched).toEqual(["actor"]);
 expect(result.run.nodes.peer!.generation).toBe(1);
},10000);
test("T01: terminal child with zero subsequent human messages advances ordinary DAG", async () => {
 const p: Plan = {nodes:[{id:"actor",kind:"act",writes:["fixture/out"]},{id:"v",kind:"verify",reads:["fixture/out"],covers:["R"]}],edges:[["actor","v"]],goal:{requirements:["R"]}};
 const {bot,state,terminal}=await setup(p);
 await terminal("actor");
 for(let i=0;i<500;i++){if(!(await bot.harness.inspect(context)).tasks.length)break;await Bun.sleep(10);}
 expect((await bot.harness.inspect(context)).tasks).toEqual([]);
 const r=await state();console.log("T01 durable observation",JSON.stringify(r));
 expect(r.nodes.actor!.status).toBe("succeeded");
 expect(r.nodes.v!.runs).toBe(1);
 expect(r.status).toBe("verified");
},10000);

test("T03: reopening after durable terminal commit recovers ordinary advancement without human input", async () => {
 const p: Plan = {nodes:[{id:"actor",kind:"act",writes:["fixture/out"]},{id:"v",kind:"verify",reads:["fixture/out"],covers:["R"]}],edges:[["actor","v"]],goal:{requirements:["R"]}};
 const database=resolve(tmpdir(),"recovery-"+crypto.randomUUID()+".sqlite");
 const {bot,parent,models,terminal}=await setup(p,database);
 await terminal("actor");
 await bot.close(context);bots.splice(bots.indexOf(bot),1);
 const recovered=await openBot({storage:await openNodeSqliteStorage(database),models,defaultModel:{provider:"faux",modelId:"fixture"},toolMode:"direct",plugins:[],settings:{retry:{enabled:false}}},context);
 bots.push(recovered);
 for(let i=0;i<500;i++){if(!(await recovered.harness.inspect(context)).tasks.length)break;await Bun.sleep(10);}
 const r=(await recovered.harness.snapshot(RunDoc,parent.id,context))!.runs[0]!;
 console.log("T03 reopened durable observation",JSON.stringify(r));
 expect(r.nodes.actor!.status).toBe("succeeded");
 expect(r.nodes.v!.runs).toBe(1);
},10000);
