import { test, expect } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
for(const cut of ["terminal","wait","wake","ack"]) test("T03/T04 SIGKILL after committed "+cut+" recovers exactly once",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"dag-sigkill-"));
 try {
  const start=Bun.spawn([process.execPath,join(import.meta.dir,"fixtures/dag-crash.ts"),dir,cut,"crash"],{stdout:"pipe",stderr:"pipe"});
  const [stdout,stderr,exit]=await Promise.all([new Response(start.stdout).text(),new Response(start.stderr).text(),start.exited]);
  console.log(JSON.stringify({cut,command:[process.execPath,"test/fixtures/dag-crash.ts",dir,cut,"crash"],stdout,stderr,exit,signal:start.signalCode}));
  // Windows reports TerminateProcess as exit 1 with no signalCode; require the pre-kill committed witness and signal call instead.
  if(process.platform!=="win32") expect(start.signalCode).toBe("SIGKILL");
  expect(stdout).toContain("SIGKILL "+cut);expect(stderr).toBe("");expect(exit).not.toBe(0);
  const witness=JSON.parse(await readFile(join(dir,"cut.json"),"utf8"));expect(witness.cut).toBe(cut);expect(witness.signal).toBe("SIGKILL");expect(witness.seq).toBeGreaterThan(0);console.log("committed crash witness",JSON.stringify(witness));
  const recover=Bun.spawn([process.execPath,join(import.meta.dir,"fixtures/dag-crash.ts"),dir,cut,"recover"],{stdout:"pipe",stderr:"pipe"});
  const result=await Promise.all([new Response(recover.stdout).text(),new Response(recover.stderr).text(),recover.exited]);console.log(JSON.stringify({cut,recovery:result}));expect(result[2]).toBe(0);
 } finally {await rm(dir,{recursive:true,force:true});}
},15000);
