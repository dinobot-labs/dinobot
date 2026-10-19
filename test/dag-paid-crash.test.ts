import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
for(const mode of ["direct","codemode-only"])test("T11 actual SQLite native lostACK SIGKILL count1 repeat recovery "+mode,async()=>{
 const dir=await mkdtemp(join(tmpdir(),"paid-crash-"));
 const run=async(stage:string)=>{const child=Bun.spawn([process.execPath,"test/fixtures/dag-paid-crash.ts",dir,mode,stage],{stdout:"pipe",stderr:"pipe"});const output=Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text()]);let timer:ReturnType<typeof setTimeout>|undefined;
 try{timer=setTimeout(()=>child.kill(),20000);const exit=await child.exited;const streams=await output;return {exit,signal:child.signalCode,output:streams.join("\n")};}finally{if(timer)clearTimeout(timer);}};
 try{const crash=await run("crash");console.log(JSON.stringify({mode,stage:"crash",...crash}));expect(crash.output).toContain("FAKE_EFFECT_COMMITTED");expect(crash.exit).not.toBe(0);
 for(let i=0;i<2;i++){const recovery=await run("recover");console.log(JSON.stringify({mode,stage:"recover",i,...recovery}));expect(recovery.exit).toBe(0);expect(recovery.output).toContain('"count":1');expect(recovery.output).toContain("RECOVERED");}
 }finally{Bun.gc(true);await rm(dir,{recursive:true,force:true});}
},60000);
