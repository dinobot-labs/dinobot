import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NodeExecutionEnv, isNativeProcessEvent } from "@earendil-works/pi-durable/env/node";
import { NativeProvenanceDoc } from "../src/core/claim-cleanup.ts";
import { ClaimsDoc, acquire, release, type Claim } from "../src/core/claims.ts";
import { openBot } from "../src/core/bot.ts";

for (const mode of ["direct", "codemode-only"] as const) test("canonical native fixed process unfences exact original only (lease kept) " + mode, async () => {
 const dir = await mkdtemp(join(tmpdir(), "native-receipt-"));
 const models = createModels(); const faux = fauxProvider({provider:"faux",models:[{id:"m"}]}); models.setProvider(faux.provider);
 const call = (name:string,args:Record<string,string>) => fauxAssistantMessage(mode === "direct" ? fauxToolCall(name,args) : fauxToolCall("codemode",{code:"text(await tools."+name+"("+JSON.stringify(args)+"));"}),{stopReason:"toolUse"});
 faux.setResponses([call("work_claim",{key:"owned:original",intent:"exact"}),call("work_claim",{key:"owned:replace",intent:"old"}),call("bash",{command:"ignored only by trusted host fixed-process preparation"}),fauxAssistantMessage("done")]);
 const storage = await openNodeSqliteStorage(join(dir,"host.sqlite")); let original:Claim; let oldReplacement:Claim; let replacement:Claim; let foreign:Claim; let pid=0;
 const bot = await openBot({storage,models,defaultModel:{provider:"faux",modelId:"m"},workspaceRoot:dir,toolMode:mode,plugins:[],bashPrepare:async (execution,api) => {
  const env = api.env as NodeExecutionEnv; execution.command = "@native-controlled-wait"; execution.controlledProcess = env.controlledProcess(1600);
  const before=(await api.snapshot(ClaimsDoc,context))!.claims; original=before.find(c=>c.key==="owned:original")!; oldReplacement=before.find(c=>c.key==="owned:replace")!;
  // Replacement and foreign are real new acquisitions, not fabricated token integers. An independent host replacement supersedes only its exact old token.
  await api.commit(async tx=>{const state=await tx.doc(ClaimsDoc); state.claims=state.claims.filter(c=>c.token!==oldReplacement.token); const next=acquire(state,{key:oldReplacement.key,holder:oldReplacement.holder,intent:"replacement",ttlMs:86400000},Date.now()); if(next.status!=="granted")throw Error("replacement not acquired");replacement=next.claim;const f=acquire(state,{key:"foreign:idle",holder:"fixture:foreign",intent:"foreign",ttlMs:86400000},Date.now());if(f.status!=="granted")throw Error("foreign not acquired");foreign=f.claim;},context);
 }},context);
 try {
  const root=await bot.conversation("test",mode+"canonical",context);const submission=await root.submit({type:"input",content:"run"},context);
  let journal;for(let i=0;i<800;i++){journal=await bot.harness.snapshot(NativeProvenanceDoc,root.id,context);const e=journal?.calls.find(c=>c.kind==="process")?.processes?.find(e=>e.phase==="started");if(e){pid=e.pid!;break;}await Bun.sleep(10);}
  if(!pid) console.log("NO IDENTITY",JSON.stringify(journal),JSON.stringify(await root.entries({},100,undefined,context)));
  expect(pid).toBeGreaterThan(0);expect(()=>process.kill(pid,0)).not.toThrow();
  const running=journal!.calls.find(c=>c.kind==="process")!;expect(running.phase).toBe("unknown");expect(running.processes!.find(e=>e.phase==="started")!.startTime).toBeTruthy();expect(running.acquiredTokens!.map(c=>c.token)).toEqual([original!.token,oldReplacement!.token]);
  expect(isNativeProcessEvent({...running.processes![0],phase:"settled",canonical:true})).toBe(false);
  await bot.harness.commit(async tx=>{const state=await tx.doc(ClaimsDoc);expect(release(state,original!.holder,original!.key,Date.now()+10000000).some(c=>c.token===original!.token)).toBe(false);expect(acquire(state,{key:original!.key,holder:"fixture:overlap",intent:"blocked",ttlMs:60000},Date.now()+10000000).status).toBe("conflict");},context);
  expect((await submission.wait(context)).status).toBe("done");
  const settled=(await bot.harness.snapshot(NativeProvenanceDoc,root.id,context))!.calls.find(c=>c.kind==="process")!;expect(settled.phase).toBe("settled");const event=settled.processes!.find(e=>e.phase==="settled")!;expect(event.canonical).toBe(true);expect(event.pid).toBe(pid);expect(event.startTime).toBe(running.processes!.find(e=>e.phase==="started")!.startTime);
  const after=(await bot.harness.snapshot(ClaimsDoc,context))!.claims;expect(after.find(c=>c.token===original!.token)?.quarantined).toBeUndefined();expect(after.find(c=>c.key===original!.key)?.token).toBe(original!.token);expect(after.find(c=>c.key===replacement!.key)?.token).toBe(replacement!.token);expect(after.find(c=>c.key===foreign!.key)?.token).toBe(foreign!.token);
  await bot.close(context); await storage.close(context); Bun.gc(true);
  const nextStorage=await openNodeSqliteStorage(join(dir,"host.sqlite")); const nextBot=await openBot({storage:nextStorage,models,defaultModel:{provider:"faux",modelId:"m"},workspaceRoot:dir,toolMode:mode,plugins:[]},context);
  try { expect((await nextBot.harness.snapshot(ClaimsDoc,context))!.claims).toEqual(after); expect((await nextBot.harness.snapshot(NativeProvenanceDoc,root.id,context))!.calls.find(c=>c.kind==="process")).toEqual(settled); } finally {await nextBot.close(context);await nextStorage.close(context);Bun.gc(true);}
  console.log(JSON.stringify({mode,original:original!,oldReplacement:oldReplacement!,replacement:replacement!,foreign:foreign!,events:settled.processes,exactOriginalUnfenced:true,foreignAndReplacementRetained:true}));
 } finally {await bot.close(context);await storage.close(context);Bun.gc(true);await rm(dir,{recursive:true,force:true});}
},20000);
