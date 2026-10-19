import {test,expect} from "bun:test";
import {mkdtemp,writeFile,readFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {randomUUID} from "node:crypto";
import {BACKGROUND_CONTEXT as context} from "@earendil-works/chord/context";
import {createModels} from "@earendil-works/pi-ai/models";
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from "@earendil-works/pi-ai/providers/faux";
import {openNodeSqliteStorage} from "@earendil-works/pi-durable/storage/sqlite/node";
import {NativeProvenanceDoc} from "../src/core/claim-cleanup.ts";
import {ClaimsDoc,release} from "../src/core/claims.ts";
import {openBot} from "../src/core/bot.ts";
for(const mode of ["direct","codemode-only"] as const)test("actual active Bash cancellation cannot clear descendant uncertainty "+mode,async()=>{
 const dir=await mkdtemp(join(tmpdir(),"native-cancel-"));const nonce=randomUUID();
 await writeFile(join(dir,"child.ts"),'await Bun.write("ready.json",JSON.stringify({pid:process.pid,nonce:process.argv[2]}));await Bun.sleep(1500);');
 const models=createModels();const faux=fauxProvider({provider:"faux",models:[{id:"m"}]});models.setProvider(faux.provider);
 const call=(name:string,args:Record<string,string>)=>fauxAssistantMessage(mode==="direct"?fauxToolCall(name,args):fauxToolCall("codemode",{code:"text(await tools."+name+"("+JSON.stringify(args)+"));"}),{stopReason:"toolUse"});
 const command='"'+process.execPath.replaceAll("\\","/")+'" child.ts '+nonce+' >/dev/null 2>&1 & sleep 5';
 faux.setResponses([call("work_claim",{key:"owned:cancel",intent:"original"}),call("bash",{command}),fauxAssistantMessage("done")]);
 const storage=await openNodeSqliteStorage(join(dir,"host.sqlite"));const bot=await openBot({storage,models,defaultModel:{provider:"faux",modelId:"m"},workspaceRoot:dir,toolMode:mode,plugins:[]},context);
 try{const root=await bot.conversation("test",mode+"cancel",context);await root.submit({type:"input",content:"start"},context);let child:any;let callState;
 for(let i=0;i<600;i++){try{child=JSON.parse(await readFile(join(dir,"ready.json"),"utf8"));}catch{}callState=(await bot.harness.snapshot(NativeProvenanceDoc,root.id,context))?.calls.find(c=>c.kind==="process");if(child && callState?.processes?.some(e=>e.phase==="started"))break;await Bun.sleep(10);}
 expect(child.nonce).toBe(nonce);expect(()=>process.kill(child.pid,0)).not.toThrow();expect(callState!.phase).toBe("unknown");const original=callState!.acquiredTokens![0]!;
 await root.abort(context);expect((await bot.harness.snapshot(NativeProvenanceDoc,root.id,context))!.calls.find(c=>c.kind==="process")!.phase).toBe("unknown");expect((await bot.harness.snapshot(ClaimsDoc,context))!.claims.find(c=>c.token===original.token)!.quarantined).toContain("UNKNOWN");
 await bot.harness.commit(async tx=>expect(release(await tx.doc(ClaimsDoc),original.holder,original.key,Date.now()+10000000)).toHaveLength(0),context);
 console.log(JSON.stringify({mode,actualAbortCompleted:true,original,child,canonicalSettlement:false}));
 }finally{await bot.close(context);await storage.close(context);Bun.gc(true);await Bun.sleep(1700);await rm(dir,{recursive:true,force:true});}
},20000);
