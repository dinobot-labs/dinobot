import { afterEach, beforeAll, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage, defineTask, type ConversationId, type TaskId } from "@earendil-works/pi-durable";
import { openBot, type Bot } from "../src/core/bot.ts";
import { startClientApi, type ClientApi } from "../src/api/server.ts";
import { createCommands } from "../src/commands/index.ts";
import { RunDoc } from "../src/core/dag.ts";
import { validHumanAcceptance } from "../src/core/verification.ts";
import { advanceDag } from "../src/extensions/dag.ts";
import { DagContinuationDoc } from "../src/extensions/dag-continuation.ts";
let archive: Bot; let api: ClientApi; let root: ConversationId;
const ids: number[] = []; const conversations: number[] = [];
const expectedBodies = new Map<number, string>();
const long = "@pytest.mark.parametrize(\"x\", [1, 2])\n" + "가😀".repeat(2200) + "\npublic technical_signature(x: int) -> str\nPATCH_TAIL";
const bots: Bot[] = [];
afterEach(async () => { for (const bot of bots.splice(0)) await bot.close(context); });
beforeAll(async () => {
 const models = createModels(); const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] }); models.setProvider(faux.provider);
 archive = await openBot({storage:new MemoryStorage(),models,defaultModel:{provider:"faux",modelId:"m"},plugins:[],toolMode:"direct",settings:{retry:{enabled:false}}}, context);
 root = (await archive.conversation("test","archive2252",context)).id; conversations.push(Number(root));
 // Real persisted ownership edges, not an AgentsDoc ID list or an in-memory export skeleton.
 const creator = defineTask<null, {phase:"finish"}, string>({ name:"fixture.archive.creator",version:1,initial:()=>({phase:"finish"}),abort:async(_r,runtime,c)=>{await runtime.commit(()=>({status:"terminal",outcome:{status:"aborted"}}),c);},phases:{finish:async (_r, runtime, c)=>{await runtime.commit(()=>({status:"terminal",outcome:{status:"completed",result:"fixture ownership creator"}}),c);}} });
 await archive.harness.commit(async tx => {
  const owner = await tx.createTask(creator,null,{conversationId:root,ownership:{kind:"conversation"}});
  for(let n=0;n<28;n++) { const child=await tx.createConversation({ownership:{kind:"task",taskId:owner}}); conversations.push(Number(child.id)); }
  const nestedOwner = await tx.createTask(creator,null,{conversationId:conversations[1] as ConversationId,ownership:{kind:"conversation"}});
  const grandchild = await tx.createConversation({ownership:{kind:"task",taskId:nestedOwner}}); conversations.push(Number(grandchild.id));
  for(let i=0;i<2252;i++) {
   const cid=conversations[i<1800?0:1+(i-1800)%29] as ConversationId;
   const body=i===0?"2026-10-07T12:00:00Z historical: blocked; later success must not erase this":i===2251?long:i===2250?JSON.stringify({patch:"@@ -1 +1 @@\n-old\n+new",nested:{code:"@pytest.fixture\ndef public_signature(password: \"str\"): pass"}}):"visible-body-"+i;
   const e=await tx.appendEntry(cid,{kind:"pi.user",model:[{role:"user",content:body,timestamp:1791374400000+i}],data:{fixtureIndex:i}}); ids.push(Number(e.id)); expectedBodies.set(Number(e.id), body);
  }
 },context);
 const persisted=await archive.harness.commit(async tx=>{ const found:number[]=[]; for(const id of conversations) { let cursor:any; do { const page=await tx.scanEntries({conversationId:id as ConversationId},100,cursor); found.push(...page.items.map(e=>Number(e.id))); cursor=page.next; } while(cursor); } return found; },context);
 expect(conversations.length).toBe(30); expect(persisted.toSorted((a,b)=>a-b)).toEqual(ids.toSorted((a,b)=>a-b));
 console.log("T06 native fixture",JSON.stringify({persistedEntries:persisted.length,recursivelyOwnedChildren:conversations.length-1,longBodyChars:long.length}));
 // Creator tasks supply persisted ownership only; their unregistered execution is not an export obligation.
 const auth = {credentials:{},providers:async()=>[],login:async()=>{throw new Error("unused");},logout:async()=>false,status:async()=>[],accounts:async()=>[],useAccount:async()=>{throw new Error("unused");}};
 api=startClientApi(archive,0,context,createCommands({bot:archive,models,auth:auth as any,plugins:[]}));
},20000);
import { afterAll } from "bun:test";
afterAll(async()=>{await api?.stop(); await archive?.close(context);});
async function full() { const response=await fetch(new URL(`/v1/conversations/${root}/export`,api.url)); expect(response.status).toBe(200); return await response.json() as any; }
test("T06 full persisted export covers exactly 2252 entries and 29 recursively owned children with uncut UTF/code",async()=>{
 const receipt=await full(); expect(receipt.complete).toBe(true);
 expect(receipt.inventory.conversationIds.toSorted((a:number,b:number)=>a-b)).toEqual(conversations.toSorted((a,b)=>a-b));
 expect(receipt.inventory.entryIds.toSorted((a:number,b:number)=>a-b)).toEqual(ids.toSorted((a,b)=>a-b));
 expect(receipt.entries).toHaveLength(2252);
 for (const entry of receipt.entries) {
  expect(entry.model[0].content).toBe(expectedBodies.get(entry.id));
  expect(Buffer.from(entry.model[0].content, "utf8")).toEqual(Buffer.from(expectedBodies.get(entry.id)!, "utf8"));
 }
 expect(receipt.entries.find((e:any)=>e.id===ids[2251]).model[0].content).toBe(long);
});
test("T08 exact IDs without visible bodies cannot establish export completeness",async()=>{
 const receipt=await full(); expect(receipt.inventory.content.length).toBeGreaterThanOrEqual(2252);
 for(const entry of receipt.entries) expect(entry.model?.length).toBeGreaterThan(0);
 expect(receipt.witness.contentHash).toMatch(/^[a-f0-9]{64}$/);
});
test("T15 export snapshot witness retains timestamped historical discrepancy and freezes highwater",async()=>{
 const receipt=await full(); expect(receipt.witness.capturedAt).toBeGreaterThan(0); expect(receipt.witness.highwater).toBeGreaterThan(0);
 expect(JSON.stringify(receipt.entries)).toContain("2026-10-07T12:00:00Z historical: blocked");
 expect(receipt.inventory.omissions).toBeInstanceOf(Array);
});
test("T16 exhaustive allowed-leaf accounting preserves decorators, public signatures and nested serialized patches",async()=>{
 const receipt=await full(); const body=JSON.stringify(receipt.entries);
 expect(body).toContain("@pytest.mark.parametrize"); expect(body).toContain("@pytest.fixture"); expect(body).toContain("public_signature"); expect(body).toContain("@@ -1 +1 @@");
 expect(receipt.inventory.allowedLeafDiffs).toEqual([]);
});
test("T07 original human full-goal completion rejects verified narrow phase and ID-only 100",async()=>{
 const faux=fauxProvider({provider:"faux",models:[{id:"m"}]}); const models=createModels();models.setProvider(faux.provider);
 const plan={nodes:[{id:"v",kind:"verify",covers:["original"]}],edges:[],goal:{requirements:["original"]}};
 faux.setResponses(Array.from({length:12},()=>t=>{
  const input=String(t.messages.findLast(m=>m.role==="user")?.content);
  if(input.includes("plan node")) return fauxAssistantMessage(JSON.stringify({version:1,requirements:[{id:"original",verdict:"pass",evidence:"only inspected ID list; bodies not exported"}],summary:"100",repairable:false}));
  const results=t.messages.slice(t.messages.findLastIndex(m=>m.role==="user")+1).filter(m=>m.role==="toolResult");
  if(!results.length) return fauxAssistantMessage(fauxToolCall("dag_run",{plan}),{stopReason:"toolUse"});
  if(results.length===1) return fauxAssistantMessage(fauxToolCall("dag_step",{}),{stopReason:"toolUse"});
  return fauxAssistantMessage("100");
 }));
 const bot=await openBot({storage:new MemoryStorage(),models,defaultModel:{provider:"faux",modelId:"m"},plugins:[],toolMode:"direct",settings:{retry:{enabled:false}}},context); bots.push(bot);
 const parent=await bot.conversation("test","original-goal",context);
 await (await parent.submit({type:"input",content:"Export ALL persisted visible bodies and all owned child bodies; ID-only skeleton is NOT completion."},context)).wait(context);
 await bot.harness.waitForIdle(context);
 const existing=(await bot.harness.snapshot(RunDoc,parent.id,context))!.runs[0]!;
 // The continuation is a background task, outside waitForIdle's ordinary scope: await its own terminal state.
 const continuation=(await bot.harness.snapshot(DagContinuationDoc,parent.id,context))?.tasks[existing.id];
 if(continuation) await bot.harness.waitForTask(continuation,context);
 await advanceDag({conversationId:parent.id,commit:bot.harness.commit.bind(bot.harness),snapshot:bot.harness.snapshot.bind(bot.harness)},existing.id,context,{dispatch:async()=>{throw new Error("unexpected second dispatch");}});
 const run=(await bot.harness.snapshot(RunDoc,parent.id,context))!.runs[0]!;
 console.log("T07 actual phase",JSON.stringify(run));
 expect(run.status).toBe("verified");
 // Related narrow-phase prose remains uncertified and confers no human acceptance.
  expect(run.nodes.v!.status).toBe("succeeded");
 expect((await bot.work.snapshot(parent.id,context)).goal!.exportAcceptance).toBeUndefined();
 expect(validHumanAcceptance(await bot.work.snapshot(parent.id,context))).toBe(false);
},10000);
