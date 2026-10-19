import {expect,test} from "bun:test";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
async function cli(args:string[]){const home=await mkdtemp(join(tmpdir(),"telegram-cli-"));try{const child=Bun.spawn([process.execPath,"--no-env-file",resolve("src/main.ts"),...args],{cwd:home,env:{HOME:home,DINOBOT_CONFIG:join(home,"absent.yaml")},stdout:"pipe",stderr:"pipe"});const timer=setTimeout(()=>child.kill("SIGKILL"),4000);try{const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);return{out,err,code};}finally{clearTimeout(timer);child.kill();await child.exited;}}finally{await rm(home,{recursive:true,force:true});}}
test("Telegram connect help routes before any deployment manifest",async()=>{const r=await cli(["telegram","connect","--help"]);expect(r.code).toBe(0);expect(r.out).toContain("--token-file");expect(r.out).toContain("--pairing-file");});
test("Telegram command errors never echo credential-like argv",async()=>{const secret="123456:FAKE_SECRET_NEVER_ECHO";const r=await cli(["telegram","connect",secret]);expect(r.code).toBe(1);expect(r.out+r.err).not.toContain(secret);expect(r.err).toContain("Telegram command failed");});
test("root help advertises easy setup and sidecar without configuration",async()=>{const r=await cli(["--help"]);expect(r.code).toBe(0);expect(r.out).toContain("telegram connect");expect(r.out).toContain("telegram run");});
