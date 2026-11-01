import {expect,test} from "bun:test";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {pathToFileURL} from "node:url";
import {buildReleaseModules} from "../script/cloudflare/deploy.ts";
test("production Worker serves the real standalone managed entrypoint",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"dinobot-real-bundle-"));
 try {
  const modules=await buildReleaseModules();
  for(const [name,module] of Object.entries(modules))await writeFile(join(dir,name),module.content);
  const worker=(await import(pathToFileURL(join(dir,"worker.js")).href)).default;
  const response=await worker.fetch(new Request("https://releases.dinobot.workers.dev/install.mjs"),{BUCKET:{get(){throw new Error("unexpected storage")}},CORE_PUBLISH_TOKEN:"fixture"});
  expect(response.status).toBe(200);
  const entry=join(dir,"install.mjs");await writeFile(entry,await response.text());
  const child=Bun.spawn([process.execPath,entry,"update","--force"],{cwd:dir,env:{...process.env,DINOBOT_INSTALL_DIR:join(dir,"isolated")},stdout:"pipe",stderr:"pipe"});
  const error=await new Response(child.stderr).text(); expect(await child.exited).toBe(1); expect(error).toContain("never restart");
 } finally {await rm(dir,{recursive:true,force:true});}
});
