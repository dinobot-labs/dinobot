import {expect,test} from "bun:test";
import {mkdtemp,rm,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {fileURLToPath} from "node:url";
import {parseAbandonRequest,parseNativeCallReconcileRequest} from "../src/cli/quarantine-recovery.ts";
import {Database} from "bun:sqlite";

const main=fileURLToPath(new URL("../src/main.ts",import.meta.url));
test("native recovery request names only exact calls and cannot mix abandonment authority",()=>{
 const refs=[{conversationId:101,taskId:"202"}];
 expect(parseNativeCallReconcileRequest({calls:refs,evidence:"quiescent"})).toEqual({calls:refs,actor:"",note:"",snapshot:""});
 for(const extra of [{tokens:[]},{acceptance:"anything"},{actor:1},{note:[]},{snapshot:123}])expect(()=>parseNativeCallReconcileRequest({calls:refs,...extra})).toThrow();
 for(const calls of [[],[{conversationId:101,taskId:"202"},{conversationId:101,taskId:"202"}],[{conversationId:"101",taskId:"202"}]])expect(()=>parseNativeCallReconcileRequest({calls})).toThrow();
 expect(()=>parseAbandonRequest({calls:refs,tokens:[{key:"fixture:claim",holder:"fixture:root",token:1}]})).toThrow("mixed_recovery_modes");
});
test("CLI documents explicit native mode without loading configuration",async()=>{
 const child=Bun.spawn([process.execPath,main,"quarantine-recovery","--help"],{stdout:"pipe",stderr:"pipe"});
 const [out,err,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
 expect(exit).toBe(0);expect(err).toBe("");expect(out).toContain("--reconcile-native");expect(out).toContain("OS quiescence");
});
test.skipIf(process.platform!=="darwin"&&process.platform!=="win32")("real CLI preview reports exact missing calls without creating tasks or claiming success",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"native-recovery-cli-"));const path=join(dir,"synthetic.sqlite"),request=join(dir,"request.json");
 try{
  await writeFile(path,"");await writeFile(request,JSON.stringify({calls:[{conversationId:101,taskId:"202"}]}));
  const child=Bun.spawn([process.execPath,main,"quarantine-recovery","--database",path,"--request",request,"--reconcile-native"],{stdout:"pipe",stderr:"pipe"});
  const [out,err,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  expect(exit).toBe(0);expect(err).toBe("");const plan=JSON.parse(out);
  expect(plan.requiredCalls).toEqual([{conversationId:101,taskId:"202"}]);expect(plan.blockers).toContain("native call 101/202 is missing or ambiguous");expect(plan.calls).toEqual([]);expect(plan.status).not.toBe("reconciled");
  const db=new Database(path,{readonly:true});try{expect(db.query("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({n:0});expect(db.query("SELECT COUNT(*) AS n FROM conversations").get()).toEqual({n:0});}finally{db.close();}
 }finally{await rm(dir,{recursive:true,force:true});}
});
