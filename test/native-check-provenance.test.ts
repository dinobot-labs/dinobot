import {test,expect} from "bun:test";
import {mkdtemp,writeFile,readFile,rm,realpath} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {BACKGROUND_CONTEXT as context} from "@earendil-works/chord/context";
import {createModels} from "@earendil-works/pi-ai/models";
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from "@earendil-works/pi-ai/providers/faux";
import {openNodeSqliteStorage} from "@earendil-works/pi-durable/storage/sqlite/node";
import {openBot} from "../src/core/bot.ts";
import {ClaimsDoc,release,acquire} from "../src/core/claims.ts";
import {NativeProvenanceDoc} from "../src/core/claim-cleanup.ts";
import {EvidenceDoc,WorkspaceCoordDoc} from "../src/core/verification.ts";
for(const mode of ["direct","codemode-only"] as const)test("native verify_run parent exit0 cannot settle descendant "+mode,async()=>{
 const dir=await realpath(await mkdtemp(join(tmpdir(),"check-provenance-")));
 await writeFile(join(dir,"child.ts"),'await Bun.write(process.argv[2]!,String(process.pid));await Bun.sleep(4000);await Bun.write(process.argv[3]!,"settled");');
 const ready=join(dir,"ready"), settled=join(dir,"settled");
 const quote=(s:string)=>"'"+s.replaceAll("\\","/")+"'";
 const command=quote(process.execPath)+" child.ts "+quote(ready)+" "+quote(settled)+" >/dev/null 2>&1 &";
 const models=createModels();const faux=fauxProvider({provider:"faux",models:[{id:"m"}]});models.setProvider(faux.provider);
 const storagePath=join(dir,"host.sqlite");const storage=await openNodeSqliteStorage(storagePath);
 const bot=await openBot({storage,models,defaultModel:{provider:"faux",modelId:"m"},workspaceRoot:dir,toolMode:mode,plugins:[]},context);
 const call=(name:string,args:Record<string,string>)=>fauxAssistantMessage(mode==="direct"?fauxToolCall(name,args):fauxToolCall("codemode",{code:"text(await tools."+name+"("+JSON.stringify(args)+"));"}),{stopReason:"toolUse"});
 try{
 const root=await bot.conversation("test",mode+"check",context);
 faux.setResponses([call("work_claim",{key:"owned:check",intent:"exact original"}),fauxAssistantMessage("claimed")]);await(await root.submit({type:"input",content:"check descendant"},context)).wait(context);
 const original=(await bot.harness.snapshot(ClaimsDoc,context))!.claims[0]!;
 const state=await bot.work.snapshot(root.id,context);
 const plan={sourceIds:Object.keys(state.sources),contract:{requirements:[{id:"r",assertion:"retain descendant ownership",checkIds:["c"],scenarioIds:["s"]}],scenarios:[{id:"s",assertion:"parent exits before child"}],checks:[{id:"c",requirementIds:["r"],scenarioIds:["s"],evidence:"smoke" as const,expected:"exit zero is not settlement"}]},scope:{root:dir,inputs:[],disposable:[]},methods:{c:{command,cwd:dir,runner:"process" as const,args:[],timeout:10,adapterVersion:1 as const,locators:[{scenarioId:"s",file:"child.ts",name:"descendant"}]}}};
 const registered=await bot.work.register(root.id,plan,"register",context);
 faux.setResponses([call("verify_run",{workId:registered.workId!,checkId:"c"}),fauxAssistantMessage("parent done")]);await(await root.submit({type:"input",content:"verify"},context)).wait(context);
 let pid=0;for(let i=0;i<100;i++){try{pid=Number(await readFile(ready,"utf8"));break;}catch{await Bun.sleep(10);}}
 const evidence=(await bot.harness.snapshot(EvidenceDoc,root.id,context))!.attempts[0]!;
 console.log(JSON.stringify({mode,pid,evidence,claims:(await bot.harness.snapshot(ClaimsDoc,context))!.claims,journal:await bot.harness.snapshot(NativeProvenanceDoc,root.id,context)}));
 expect(pid).toBeGreaterThan(0);expect(()=>process.kill(pid,0)).not.toThrow();expect(evidence.observation!.exitCode).toBe(0);expect(evidence.observation!.quiescent).toBe(false);expect(evidence.status).toBe("unknown");
 expect((await bot.harness.snapshot(NativeProvenanceDoc,root.id,context))!.calls.find(c=>c.taskId===evidence.id)!.phase).toBe("unknown");
 await bot.work.cancel(root.id,registered.workId!,context);
 await bot.harness.commit(async tx=>{const d=await tx.doc(ClaimsDoc);expect(release(d,original.holder,original.key,Date.now()+10000000)).toHaveLength(0);expect(acquire(d,{key:original.key,holder:"fixture:overlap",intent:"blocked",ttlMs:60000},Date.now()+10000000).status).toBe("conflict");expect(acquire(d,{key:"disjoint:ordinary",holder:"fixture:normal",intent:"continues",ttlMs:60000},Date.now()).status).toBe("granted");},context);
 const after=(await bot.harness.snapshot(ClaimsDoc,context))!.claims;expect(after.find(c=>c.key===original.key)!.token).toBe(original.token);expect(after.find(c=>c.key===original.key)!.quarantined).toContain("UNKNOWN");
 await bot.close(context);await storage.close(context);Bun.gc(true);
 for(let pass=0;pass<2;pass++){const next=await openNodeSqliteStorage(storagePath);const reopened=await openBot({storage:next,models,defaultModel:{provider:"faux",modelId:"m"},workspaceRoot:dir,toolMode:mode,plugins:[]},context);try{expect((await reopened.harness.snapshot(ClaimsDoc,context))!.claims.find(c=>c.key===original.key)!.token).toBe(original.token);expect((await reopened.harness.snapshot(NativeProvenanceDoc,root.id,context))!.calls.find(c=>c.taskId===evidence.id)!.phase).toBe("unknown");expect((await reopened.harness.snapshot(WorkspaceCoordDoc,context))!.leases.some(l=>l.taskId===evidence.id&&l.phase==="blocked-unknown")).toBe(true);}finally{await reopened.close(context);await next.close(context);Bun.gc(true);}}
 }finally{await bot.close(context);await storage.close(context);Bun.gc(true);for(let i=0;i<600;i++){try{await readFile(settled);break;}catch{await Bun.sleep(10);}}await rm(dir,{recursive:true,force:true});}
},20000);
