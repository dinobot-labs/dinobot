import {afterEach,test,expect} from "bun:test";
import {BACKGROUND_CONTEXT as context} from "@earendil-works/chord/context";
import {createModels} from "@earendil-works/pi-ai/models";
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from "@earendil-works/pi-ai/providers/faux";
import {MemoryStorage} from "@earendil-works/pi-durable";
import {openBot,type Bot} from "../src/core/bot.ts";
import {WAKE_PREFIX} from "../src/extensions/subagents.ts";
import {RunDoc} from "../src/core/dag.ts";
import {AsksDoc,resolveAsk} from "../src/core/ask.ts";
import {dagContinuation} from "../src/extensions/dag-continuation.ts";
const bots:Bot[]=[];afterEach(async()=>{for(const b of bots.splice(0))await b.close(context);});
for(const mode of ["direct","codemode-only"] as const)test("T01/T05/T14 "+mode+" ordinary ask wake, no provider polling, duplicate recovery",async()=>{
 const faux=fauxProvider({provider:"faux",models:[{id:"fixture"}]});let requests=0;const wakes:string[]=[];
 const plan={nodes:[{id:"q",kind:"ask"},{id:"actor",kind:"act",writes:["out"]},{id:"v",kind:"verify",reads:["out"],covers:["R"]}],edges:[["q","actor"],["actor","v"]],goal:{requirements:["R"]}};
 faux.setResponses(Array.from({length:40},()=>t=>{
  // ADR 0096: the idle orchestrator is woken once per stopped run or open ask; a woken turn is not polling.
  const user=String(t.messages.findLast(m=>m.role==="user")?.content);if(user.startsWith(WAKE_PREFIX)){wakes.push(user);return fauxAssistantMessage("noted");}requests++;const node=/plan node "([^"]+)"/.exec(user)?.[1];
  if(node)return fauxAssistantMessage(node==="v"?JSON.stringify({version:1,requirements:[{id:"R",verdict:"pass",evidence:"checked fixture"}],summary:"ok",repairable:false}):"actor output");
  const results=t.messages.slice(t.messages.findLastIndex(m=>m.role==="user")+1).filter(m=>m.role==="toolResult");
  return results.length?fauxAssistantMessage("Everything completed"):fauxAssistantMessage(mode==="direct"?fauxToolCall("dag_run",{plan}):fauxToolCall("codemode",{code:"text(await tools.dag_run("+JSON.stringify({plan})+"));"}),{stopReason:"toolUse"});
 }));
 const models=createModels();models.setProvider(faux.provider);
 const bot=await openBot({storage:new MemoryStorage(),models,defaultModel:{provider:"faux",modelId:"fixture"},toolMode:mode,plugins:[],settings:{retry:{enabled:false}}},context);bots.push(bot);
 const parent=await bot.conversation("test",mode,context);await(await parent.submit({type:"input",content:"start"},context)).wait(context);
 let ask;for(let i=0;i<300;i++){ask=(await bot.harness.snapshot(AsksDoc,parent.id,context))?.asks.find(a=>a.state==="open");if(ask)break;await Bun.sleep(10);}expect(ask).toBeDefined();
 for(let i=0;i<300&&!wakes.some(w=>w.includes("needs your decision"));i++)await Bun.sleep(10);expect(wakes.filter(w=>w.includes("needs your decision"))).toHaveLength(1);
 const count=requests;await Bun.sleep(100);expect(requests).toBe(count);
 expect((await bot.harness.snapshot(RunDoc,parent.id,context))!.runs[0]!.nodes.q!.status).toBe("waiting");
 const recovery=dagContinuation(()=>bot.harness);await recovery.recover(context);await recovery.recover(context);
 await bot.harness.commit(async tx=>{resolveAsk(await tx.doc(AsksDoc,parent.id),ask!.id,{state:"answered",answer:"go",by:"agent:"+parent.id,now:Date.now()});},context);
 for(let i=0;i<300;i++){if(!(await bot.harness.inspect(context)).tasks.length)break;await Bun.sleep(10);}
 const d=await bot.harness.snapshot((await import("../src/extensions/dag-continuation.ts")).DagContinuationDoc,parent.id,context);for(const id of Object.values(d?.tasks??{}))console.log("driver",JSON.stringify(await bot.harness.getTask(id,context)));
 const r=(await bot.harness.snapshot(RunDoc,parent.id,context))!.runs[0]!;console.log("run",JSON.stringify(r));expect(r.status).toBe("verified");for(let i=0;i<300&&!wakes.some(w=>w.includes("finished: verified"));i++)await Bun.sleep(10);expect(wakes).toHaveLength(2);expect(wakes[1]).toContain(r.id);expect(r.nodes.actor!.runs).toBe(1);expect(r.nodes.v!.runs).toBe(1);expect(requests-count).toBe(2);
},10000);
