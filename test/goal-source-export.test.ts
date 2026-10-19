import { afterEach, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openBot, type Bot } from "../src/core/bot.ts";
import { startClientApi, type ClientApi } from "../src/api/server.ts";
import { createCommands } from "../src/commands/index.ts";
import { WorkDoc, goalHash } from "../src/core/verification.ts";
import { RunDoc } from "../src/core/dag.ts";
import { digest } from "../src/core/verification-execution.ts";
import { advanceDag } from "../src/extensions/dag.ts";
const bots:Bot[]=[];const apis:ClientApi[]=[];
afterEach(async()=>{for(const api of apis.splice(0))await api.stop();for(const bot of bots.splice(0))await bot.close(context);});
async function setup(mode:"direct"|"codemode-only"="direct") {
 const models=createModels();const faux=fauxProvider({provider:"faux",models:[{id:"m"}]});models.setProvider(faux.provider);
 faux.setResponses(Array.from({length:30},()=>fauxAssistantMessage("provisional")));
 const bot=await openBot({storage:new MemoryStorage(),models,defaultModel:{provider:"faux",modelId:"m"},plugins:[],toolMode:mode,settings:{retry:{enabled:false}}},context);bots.push(bot);
 const root=await bot.conversation("test","source-export",context);
 const auth={credentials:{},providers:async()=>[],login:async()=>{throw Error("unused");},logout:async()=>false,status:async()=>[],accounts:async()=>[],useAccount:async()=>{throw Error("unused");}};
 const api=startClientApi(bot,0,context,createCommands({bot,models,auth:auth as any,plugins:[]}));apis.push(api);
 const send=async(content:string)=>await(await root.submit({type:"input",content},context)).wait(context);
 const full=async()=>await(await fetch(new URL("/v1/conversations/"+root.id+"/export",api.url))).json() as any;
 const verify=async(receipt:any,epoch:number,hash:string)=>fetch(new URL("/v1/conversations/"+root.id+"/export/verify",api.url),{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({receipt,epoch,goalHash:hash})});
 return {bot,root,faux,api,send,full,verify};
}
test("T08/T09 native API rejects ID-only skeleton, forged hash and stale source epoch; full body succeeds",async()=>{
 const s=await setup();await s.send(JSON.stringify({dinobotGoal:{kind:"full-visible-export",root:s.root.id}}));
 const goal=(await s.bot.work.snapshot(s.root.id,context)).goal!;const receipt=await s.full();
 expect(goal.sources[0]!.assertion).toContain("full-visible-export");expect(goalHash(goal)).toBe(goal.hash);
 const skeleton=structuredClone(receipt);skeleton.entries=skeleton.entries.map((e:any)=>({id:e.id}));
 expect((await s.verify(skeleton,goal.epoch,goal.hash)).status).toBe(409);
 const forged=structuredClone(receipt);forged.witness.contentHash="a".repeat(64);expect((await s.verify(forged,goal.epoch,goal.hash)).status).toBe(409);
 const green=await s.verify(receipt,goal.epoch,goal.hash);expect(green.status).toBe(200);expect((await green.json() as any).goalCertified).toBe(true);
 await s.send(JSON.stringify({dinobotGoalAmendment:{epoch:goal.epoch,hash:goal.hash,assertion:"retain all original bodies AND an additional appendix"}}));
 const changed=(await s.bot.work.snapshot(s.root.id,context)).goal!;expect(changed.epoch).toBe(goal.epoch+1);expect(changed.sources).toEqual(goal.sources);expect(changed.amendments[0]!.assertion).toContain("all original bodies");
 expect((await s.verify(receipt,changed.epoch,changed.hash)).status).toBe(409);
});
test("T07 unsupported additional typed goal assertions cannot be silently weakened into the export predicate",async()=>{
 const s=await setup();await s.send(JSON.stringify({dinobotGoal:{kind:"full-visible-export",root:s.root.id,additionalAssertion:"Also all historical mutable state, not just current retained entries"}}));
 const goal=(await s.bot.work.snapshot(s.root.id,context)).goal!;expect(goal.sources[0]!.predicate).toBeUndefined();
 const result=await s.verify(await s.full(),goal.epoch,goal.hash);expect(result.status).toBe(200);expect((await result.json() as any).goalCertified).toBe(false);
});
test("T15 frozen cursor excludes later entries; provenance UNKNOWN is not historical fabrication",async()=>{
 const s=await setup();await s.send("2026-10-07T12:00:00Z blocked then later changed; keep discrepancy");
 const first=await(await fetch(new URL("/v1/conversations/"+s.root.id+"/export?limit=1",s.api.url))).json() as any;
 expect(first.complete).toBe(false);expect(first.nextCursor).toBeString();
 await s.send("late-entry-not-in-first-snapshot");
 const tail=await(await fetch(new URL("/v1/conversations/"+s.root.id+"/export?cursor="+first.nextCursor,s.api.url))).json() as any;
 expect(tail.snapshotId).toBe(first.snapshotId);expect(tail.witness).toEqual(first.witness);expect(tail.witness.historicalState).toBe("UNKNOWN");expect(JSON.stringify(tail.entries)).not.toContain("late-entry-not-in-first-snapshot");
 expect(tail.complete).toBe(false);expect(tail.nextCursor).toBeNull();
});
test("T16 nested serialized JSON and patches omit privileged leaves while preserving all public code",async()=>{
 const s=await setup();const allowed={code:"@pytest.fixture\ndef public_signature(x: int) -> str: pass",patch:"@@ -1 +1 @@\n-old\n+new",prompt:"public ordinary input"};
 await s.bot.harness.commit(async tx=>{await tx.appendEntry(s.root.id,{kind:"pi.user",model:[{role:"user",content:JSON.stringify({nested:{...allowed,system_prompt:"PRIVATE_PROMPT",reasoning:"PRIVATE_REASON",provider_opaque:"PRIVATE_OPAQUE",credentials:{password:"PRIVATE_PASSWORD"},customer_contacts:["PRIVATE_NAME"],email:"person@example.invalid"}}),timestamp:1}],data:{nested:{...allowed,developerPrompt:"PRIVATE_DEVELOPER"}}});},context);
 const receipt=await s.full();const body=JSON.stringify(receipt.entries);
 for(const secret of ["PRIVATE_PROMPT","PRIVATE_REASON","PRIVATE_OPAQUE","PRIVATE_PASSWORD","PRIVATE_NAME","PRIVATE_DEVELOPER","person@example.invalid"])expect(body).not.toContain(secret);
 for(const v of Object.values(allowed))expect(body).toContain(JSON.stringify(v).slice(1,-1).replaceAll('"','\\"'));
 expect(receipt.inventory.omissions.length).toBeGreaterThanOrEqual(7);expect(receipt.inventory.allowedLeafDiffs).toEqual([]);
});
test("T16 native API compares independently specified permitted mixed bodies, never drops changed leaves",async()=>{
 const s=await setup();
 const publicCode="@pytest.fixture\ndef public_signature(password: \"str\"): pass\ndef multiline_signature(\n    password: CustomType\n): pass\n@@ -1 +1 @@\n-public(password: str)\n+public(password: str)\n가😀";
 const raw=publicCode+"\npassword=actual-secret\npassword: hunter2\nauthorization: Bearer actual-bearer\nsecret: \"quoted secret with spaces\"\ncontact person@example.invalid end\nsk-abcdefghijklmnop1234567890\npassword=\"person@example.invalid\"\nPUBLIC_TAIL";
 // Expected literals are the independently specified policy, not visibleValue(raw).
 const permitted=publicCode+"\npassword=[credential omitted]\npassword: [credential omitted]\nauthorization: [credential omitted]\nsecret: [credential omitted]\ncontact [contact omitted] end\n[credential omitted]\npassword=[credential omitted]\nPUBLIC_TAIL";
 const nestedRaw=JSON.stringify({code:raw,password:"PRIVATE_STRUCTURED",publicTail:"NESTED_TAIL"});
 const nestedPermitted={code:permitted,publicTail:"NESTED_TAIL"};
 await s.bot.harness.commit(async tx=>{await tx.appendEntry(s.root.id,{kind:"pi.user",model:[{role:"user",content:raw,timestamp:1}],data:{serialized:nestedRaw,thinking:{type:"thinking",text:"PRIVATE_THINKING"},opaque:{type:"provider_opaque",text:"PRIVATE_OPAQUE"},contacts:{customerContacts:["PRIVATE_CUSTOMER"]},binary:{type:"image",mimeType:"image/png",data:"PRIVATE_BINARY"}}});},context);
 const receipt=await s.full(); const entry=receipt.entries[0];
 expect(entry.model[0].content).toBe(permitted);
 expect(Buffer.from(entry.model[0].content)).toEqual(Buffer.from(permitted));
 expect(JSON.parse(entry.data.serialized)).toEqual(nestedPermitted);
 expect(entry.data.contacts).toBeUndefined();
 expect(entry.data.thinking).toBeUndefined(); expect(entry.data.opaque).toBeUndefined();
 expect(entry.data.binary).toEqual({type:"image",descriptor:true,hash:expect.stringMatching(/^[a-f0-9]{64}$/),mimeType:"image/png"});
 const path="/entries/0/model/0/content"; const nestedPath="/entries/0/data/serialized/$json/code";
 for(const p of [path,nestedPath]) {
  expect(receipt.inventory.allowedSourceContent.find((x:any)=>x.path===p)).toEqual({path:p,hash:digest(permitted)});
  expect(receipt.inventory.content.find((x:any)=>x.path===p)).toEqual({path:p,hash:digest(permitted)});
  expect(receipt.inventory.omissions.find((x:any)=>x.path===p).spans.length).toBeGreaterThan(0);
 }
 expect(receipt.inventory.allowedLeafDiffs).toEqual([]);
 for(const secret of ["actual-secret","hunter2","actual-bearer","quoted secret with spaces","person@example.invalid","abcdefghijklmnop1234567890","PRIVATE_STRUCTURED","PRIVATE_THINKING","PRIVATE_OPAQUE","PRIVATE_CUSTOMER","PRIVATE_BINARY"])expect(JSON.stringify(receipt)).not.toContain(secret);
 // The independent permitted body must also bind the actual goal certification path.
 await s.send(JSON.stringify({dinobotGoal:{kind:"full-visible-export",root:s.root.id}}));
 const goal=(await s.bot.work.snapshot(s.root.id,context)).goal!; const full=await s.full();
 const lost=structuredClone(full); lost.entries[0].model[0].content=permitted.replace("PUBLIC_TAIL","");
 expect((await s.verify(lost,goal.epoch,goal.hash)).status).toBe(409);
 const laundered=structuredClone(lost);
 laundered.inventory.omissions.push({path,reason:"fabricated credential",spans:[{start:0,end:raw.length,replacement:laundered.entries[0].model[0].content}]});
 laundered.inventory.allowedSourceContent=laundered.inventory.allowedSourceContent.filter((x:any)=>x.path!==path);
 laundered.inventory.allowedSourceContent.push({path,hash:digest(laundered.entries[0].model[0].content)});
 laundered.inventory.allowedLeafDiffs=[];
 laundered.witness.contentHash=digest(laundered.entries);laundered.witness.inventoryHash=digest(laundered.inventory);
 expect((await s.verify(laundered,goal.epoch,goal.hash)).status).toBe(409);
 expect((await s.verify(full,goal.epoch,goal.hash)).status).toBe(200);
});
for(const mode of ["direct","codemode-only"] as const)test("native session_export tool is available through "+mode,async()=>{
 const s=await setup(mode);let called=false;
 s.faux.setResponses([()=>{called=true;return fauxAssistantMessage(fauxToolCall(mode==="direct"?"session_export":"codemode",mode==="direct"?{}:{code:"text(await tools.session_export({}));"}),{stopReason:"toolUse"});},fauxAssistantMessage("done")]);
 await s.send("export explicit snapshot");expect(called).toBe(true);
 const receipt=await s.full();expect(receipt.entries.some((e:any)=>e.model?.some((m:any)=>m.role==="toolResult"))).toBe(true);
});
