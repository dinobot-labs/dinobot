import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Own SQLite files in the parent: Windows can retain mappings until the child process exits. */
export function sqliteTest(file: string, name: string, body: (directory: string) => Promise<void>, timeout = 15_000) {
 test(name, async () => {
  if (process.env.DINOBOT_SQLITE_CASE === name) {
   const directory=process.env.DINOBOT_SQLITE_DIR;
   if(!directory)throw new Error("Missing disposable SQLite directory");
   await body(directory);
   return;
  }
  const directory=await mkdtemp(join(tmpdir(),"dinobot-sqlite-case-"));
  const pattern="^"+[...name].map(c=>".*+?^$()[]{}|\\".includes(c)?"\\"+c:c).join("")+"$";
  const child=Bun.spawn([process.execPath,"test",file,"--test-name-pattern",pattern],{
   env:{...process.env,DINOBOT_SQLITE_CASE:name,DINOBOT_SQLITE_DIR:directory},stdout:"pipe",stderr:"pipe",
  });
  const timer=setTimeout(()=>child.kill(),timeout-1000);
  try{
   const [out,error,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
   expect(code,out+error).toBe(0);
   // A mistyped test filter must not turn the delegated assertions into a false pass.
   expect(out+error).toContain("1 pass");
  }finally{
   clearTimeout(timer);
   child.kill();await child.exited;
   await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
 },timeout);
}
