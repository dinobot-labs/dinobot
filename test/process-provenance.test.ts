import {test,expect} from "bun:test";
import {mkdtemp,writeFile,readFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {BACKGROUND_CONTEXT as context} from "@earendil-works/chord/context";
import {createModels} from "@earendil-works/pi-ai/models";
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from "@earendil-works/pi-ai/providers/faux";
import {openNodeSqliteStorage} from "@earendil-works/pi-durable/storage/sqlite/node";
import {NativeProvenanceDoc} from "../src/core/claim-cleanup.ts";
import {WorkspaceCoordDoc} from "../src/core/verification.ts";
import {openBot} from "../src/core/bot.ts";
import {ClaimsDoc,release,acquire} from "../src/core/claims.ts";
for(const mode of ["direct","codemode-only"] as const)for(const kind of ["bash"] as ("external"|"bash")[])test("unknown native provenance survives success release TTL "+mode+" "+kind,async()=>{
 const dir=await mkdtemp(join(tmpdir(),"provenance-"));let calls=0;
 const faux=fauxProvider({provider:"faux",models:[{id:"m"}]});const models=createModels();models.setProvider(faux.provider);
 const call=(name:string,args:Record<string,any>)=>fauxAssistantMessage(mode==="direct"?fauxToolCall(name,args):fauxToolCall("codemode",{code:"text(await tools."+name+"("+JSON.stringify(args)+"));"}),{stopReason:"toolUse"});
 await writeFile(join(dir,"child.ts"),"await Bun.write('ready.txt', String(process.pid)); await Bun.sleep(1200); await Bun.write(process.argv[2]!, String(process.pid));");
 const command="bun child.ts settled.txt >/dev/null 2>&1 &";
 faux.setResponses([call("work_claim",{key:"fake:provenance",intent:"owned"}),call(kind==="bash"?"bash":"fake_unknown",kind==="bash"?{command}:{}),fauxAssistantMessage("settled tool, not process")]);
 const storagePath=join(dir,"host.sqlite");
 const storage=await openNodeSqliteStorage(storagePath);
 const bot=await openBot({storage,models,defaultModel:{provider:"faux",modelId:"m"},workspaceRoot:dir,toolMode:mode,plugins:[{id:"fake",tools:[{name:"fake_unknown",description:"arbitrary unmanaged effect",inputSchema:{type:"object",properties:{}},execute:async()=>{calls++;return {ok:true};}}]}],settings:{retry:{enabled:false}}},context);
 try{const root=await bot.conversation("test",mode+kind,context);await(await root.submit({type:"input",content:"start"},context)).wait(context);
 const before=(await bot.harness.snapshot(ClaimsDoc,context))!.claims[0]!;
 if(kind==="bash"){let pid=0;for(let i=0;i<100;i++){try{pid=Number(await readFile(join(dir,"ready.txt"),"utf8"));break;}catch{await Bun.sleep(10);}}expect(pid).toBeGreaterThan(0);expect(()=>process.kill(pid,0)).not.toThrow();console.log(JSON.stringify({mode,pid,liveAfterShellReturned:true,ownership:"fixture path receipt only; not canonical Env settlement"}));let present=false;try{await readFile(join(dir,"settled.txt"));present=true;}catch{}expect(present).toBe(false);}
 expect(before.quarantined).toContain("UNKNOWN");
 await bot.harness.commit(async tx=>{const d=await tx.doc(ClaimsDoc);expect(release(d,before.holder,undefined,Date.now()+10000000)).toHaveLength(0);expect(acquire(d,{key:before.key,holder:"foreign",intent:"must conflict",ttlMs:60000},Date.now()+10000000).status).toBe("conflict");},context);
 expect((await bot.harness.snapshot(ClaimsDoc,context))!.claims[0]!.token).toBe(before.token);if(kind==="external")expect(calls).toBe(1);
 const journal=await bot.harness.snapshot(NativeProvenanceDoc,root.id,context);expect(journal!.calls[0]!.tokens[0]!.token).toBe(before.token);
 await bot.close(context);await storage.close(context);Bun.gc(true);
 const nextStorage=await openNodeSqliteStorage(storagePath);
 const reopened=await openBot({storage:nextStorage,plugins:[],models,defaultModel:{provider:"faux",modelId:"m"},workspaceRoot:dir,toolMode:mode,settings:{retry:{enabled:false}}},context);
 try{expect((await reopened.harness.snapshot(ClaimsDoc,context))!.claims[0]!.token).toBe(before.token);expect((await reopened.harness.snapshot(NativeProvenanceDoc,root.id,context))!.calls).toEqual(journal!.calls);expect((await reopened.harness.snapshot(WorkspaceCoordDoc,context))!.leases.some(l=>l.phase==="blocked-unknown")).toBe(true);}finally{await reopened.close(context);await nextStorage.close(context);Bun.gc(true);}
 }catch(error){console.error("PRIMARY FIXTURE ERROR",error);throw error;}finally{if(kind==="bash"){for(let i=0;i<500;i++){try{await readFile(join(dir,"settled.txt"));break;}catch{await Bun.sleep(10);}}}await bot.close(context);await storage.close(context);Bun.gc(true);await rm(dir,{recursive:true,force:true});}
},20000);

// ADR 0094: a returned plugin call is settled by the host; its fence ends, the lease stays until release, and nothing survives a reopen.
for(const mode of ["direct","codemode-only"] as const)test("a returned external plugin call settles: fence ends and release frees the key "+mode,async()=>{
 const dir=await mkdtemp(join(tmpdir(),"provenance-ext-"));let calls=0;
 const faux=fauxProvider({provider:"faux",models:[{id:"m"}]});const models=createModels();models.setProvider(faux.provider);
 const call=(name:string,args:Record<string,any>)=>fauxAssistantMessage(mode==="direct"?fauxToolCall(name,args):fauxToolCall("codemode",{code:"text(await tools."+name+"("+JSON.stringify(args)+"));"}),{stopReason:"toolUse"});
 faux.setResponses([call("work_claim",{key:"fake:provenance",intent:"owned"}),call("fake_unknown",{}),fauxAssistantMessage("settled")]);
 const storagePath=join(dir,"host.sqlite");const storage=await openNodeSqliteStorage(storagePath);
 const bot=await openBot({storage,models,defaultModel:{provider:"faux",modelId:"m"},workspaceRoot:dir,toolMode:mode,plugins:[{id:"fake",tools:[{name:"fake_unknown",description:"arbitrary unmanaged effect",inputSchema:{type:"object",properties:{}},execute:async()=>{calls++;return {ok:true};}}]}],settings:{retry:{enabled:false}}},context);
 try{const root=await bot.conversation("test",mode+"ext",context);await(await root.submit({type:"input",content:"start"},context)).wait(context);
  expect(calls).toBe(1);
  const before=(await bot.harness.snapshot(ClaimsDoc,context))!.claims[0]!;expect(before.quarantined).toBeUndefined();
  const journal=(await bot.harness.snapshot(NativeProvenanceDoc,root.id,context))!;expect(journal.calls.map(c=>[c.kind,c.phase])).toEqual([["external:fake_unknown","settled"]]);
  expect((await bot.harness.snapshot(WorkspaceCoordDoc,context))!.leases.some(l=>l.phase==="blocked-unknown")).toBe(false);
  await bot.harness.commit(async tx=>{const d=await tx.doc(ClaimsDoc);expect(acquire(d,{key:before.key,holder:"foreign",intent:"lease still held",ttlMs:60000},Date.now()).status).toBe("conflict");expect(release(d,before.holder,undefined,Date.now())).toHaveLength(1);expect(acquire(d,{key:before.key,holder:"foreign",intent:"free now",ttlMs:60000},Date.now()).status).toBe("granted");},context);
 }finally{await bot.close(context);await storage.close(context);Bun.gc(true);await rm(dir,{recursive:true,force:true});}
},20000);
