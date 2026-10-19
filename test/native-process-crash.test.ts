import { test,expect } from "bun:test";
import { mkdtemp,readFile,rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider,fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openBot } from "../src/core/bot.ts";
import { NativeProvenanceDoc } from "../src/core/claim-cleanup.ts";
import { ClaimsDoc,acquire,release } from "../src/core/claims.ts";
for(const mode of ["direct","codemode-only"] as const)test("real SIGKILL surviving Bash descendant stays quarantined twice reopen "+mode,async()=>{
 const dir=await mkdtemp(join(tmpdir(),"native-crash-"));const host=Bun.spawn([process.execPath,join(import.meta.dir,"fixtures/native-process-crash.ts"),dir,mode],{stdout:"pipe",stderr:"pipe"});let cut:any;
 try{for(let i=0;i<1000;i++){try{cut=JSON.parse(await readFile(join(dir,"cut.json"),"utf8"));break;}catch{}if(host.exitCode!==null)throw Error(await new Response(host.stderr).text());await Bun.sleep(10);}expect(cut).toBeTruthy();expect(cut.child.nonce).toBe(cut.nonce);expect(()=>process.kill(cut.child.pid,0)).not.toThrow();
 const osIdentity=process.platform==="win32"?spawnSync("powershell.exe",["-NoProfile","-Command","Get-CimInstance Win32_Process -Filter 'ProcessId="+cut.child.pid+"' | Select-Object ProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress"],{encoding:"utf8"}):undefined;if(osIdentity){expect(osIdentity.status).toBe(0);const observed=JSON.parse(osIdentity.stdout);expect(observed.ProcessId).toBe(cut.child.pid);expect(observed.CommandLine).toContain(cut.nonce);expect(observed.CreationDate).toBeTruthy();console.log(JSON.stringify({mode,independentChildIdentity:observed}));}
 host.kill("SIGKILL");await host.exited;expect(host.exitCode).not.toBe(0);expect(()=>process.kill(cut.child.pid,0)).not.toThrow();
 for(let pass=0;pass<2;pass++){const models=createModels();const faux=fauxProvider({provider:"faux",models:[{id:"m"}]});models.setProvider(faux.provider);faux.setResponses(Array.from({length:10},()=>fauxAssistantMessage("recover")));const storage=await openNodeSqliteStorage(join(dir,"host.sqlite"));const bot=await openBot({storage,models,defaultModel:{provider:"faux",modelId:"m"},workspaceRoot:dir,toolMode:mode,plugins:[]},context);try{
 const claims=(await bot.harness.snapshot(ClaimsDoc,context))!.claims;expect(claims.find(c=>c.key===cut.claims.claims[0].key)?.token).toBe(cut.claims.claims[0].token);expect(claims[0]!.quarantined).toContain("UNKNOWN");const journal=(await bot.harness.snapshot(NativeProvenanceDoc,cut.rootId,context))!;expect(journal.calls.find(c=>c.kind==="process")!.phase).toBe("unknown");expect(journal.calls.find(c=>c.kind==="process")!.processes!.some(e=>e.phase==="started"&&e.nonce===cut.journal.calls[0].processes[0].nonce)).toBe(true);expect(()=>process.kill(cut.child.pid,0)).not.toThrow();
 await bot.harness.commit(async tx=>{const d=await tx.doc(ClaimsDoc);expect(release(d,claims[0]!.holder,claims[0]!.key,Date.now()+10000000)).toHaveLength(0);expect(acquire(d,{key:claims[0]!.key,holder:"fixture:foreign",intent:"blocked",ttlMs:60000},Date.now()+10000000).status).toBe("conflict");},context);console.log(JSON.stringify({mode,pass,hostKilled:true,childAliveAcrossReopen:true,claims,journal}));
 }finally{await bot.close(context);await storage.close(context);Bun.gc(true);}}
 }catch(error){console.error("PRIMARY CRASH FIXTURE ERROR",error);throw error;}finally{if(host.exitCode===null){host.kill("SIGKILL");await host.exited;}if(cut) for(let i=0;i<1500;i++){try{expect(await readFile(join(dir,"child-settled"),"utf8")).toBe(cut.nonce);break;}catch{if(i===1499)throw Error("owned child did not naturally settle; fixture evidence retained at "+dir);await Bun.sleep(10);}}await rm(dir,{recursive:true,force:true});}
},30000);
