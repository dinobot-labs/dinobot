import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { managedCommand, managedPaths, runManaged, type ManagedOptions, type ManagedCommand } from "../src/managed-install.ts";
import { newerManagedVersion } from "../src/managed-version.ts";
const cleanup: string[] = [];
afterEach(async () => { for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture() {
 const dir = await mkdtemp(join(tmpdir(), "managed fixture ")); cleanup.push(dir);
 const paths = managedPaths({ DINOBOT_INSTALL_DIR: join(dir, "managed root") });
 const source = join(dir, "install.mjs"); await writeFile(source, "// durable launcher fixture\n");
 let version = "1.0.0"; let offline = false; let corrupt = false; let failInstall = false; let failSmoke = false;
 const bytes = Buffer.from("authenticated fixture archive"); let installs = 0; const calls: {argv: string[]; mode: string; cwd: string}[] = [];
 const fetcher = (async (input: string | URL | Request) => {
  if (offline) throw new Error("offline");
  if (String(input).endsWith("latest.json")) return Response.json({ name: "dinobot", version, dist: { tarball: "https://releases.dinobot.workers.dev/core/releases/" + version + "/dinobot-" + version + ".tgz", integrity: "sha512-" + createHash("sha512").update(bytes).digest("base64") } });
  return new Response(corrupt ? "bad bytes" : bytes);
 }) as typeof fetch;
 const command: ManagedCommand = async (argv, options) => {
  calls.push({argv, mode: options.mode, cwd: options.cwd});
  if (options.mode === "install") {
   installs++;
   expect(options.cwd.startsWith(tmpdir())).toBe(true);
   expect(options.cwd.startsWith(paths.root)).toBe(false);
   expect(JSON.parse(await readFile(join(options.cwd, "package.json"), "utf8")).private).toBe(true);
   if (failInstall) throw new Error("install failed");
   const pkg = join(options.cwd, "node_modules", "dinobot"); await mkdir(pkg, { recursive: true });
   await writeFile(join(pkg, "package.json"), JSON.stringify({name:"dinobot",version,bin:{dinobot:"main.js"}}));
   await writeFile(join(pkg, "main.js"), 'console.log(process.argv.includes("--version") ? ' + JSON.stringify(version) + ' : "dinobot help");');
   await writeFile(join(pkg, "lazy.js"), 'export default ' + JSON.stringify(version));
   return {code:0, stdout:""};
  }
  if (options.mode === "smoke") return failSmoke ? {code:1,stdout:""} : managedCommand(argv, options);
  return {code:7,stdout:""};
 };
 const options: ManagedOptions = { paths, launcherSource: source, fetch: fetcher, command, log:()=>{} };
 return { dir, paths, source, options, calls, setVersion:(v:string)=>{version=v;}, offline:()=>{offline=true;}, corrupt:()=>{corrupt=true;}, failInstall:()=>{failInstall=true;}, failSmoke:()=>{failSmoke=true;}, installs:()=>installs, pointer:()=>readFile(join(paths.root,"active.json"),"utf8") };
}
test("install publishes immutable slot; automatic update pins new child and preserves old lazy files", async () => {
 const f = await fixture(); await runManaged(["--install"], f.options);
 const old = JSON.parse(await f.pointer()); const oldMain = join(f.paths.root,"versions",old.slot,"node_modules","dinobot","main.js");
 const oldBytes = await readFile(oldMain,"utf8");
 f.setVersion("1.1.0"); expect(await runManaged(["--version"], f.options)).toBe(7);
 const next = JSON.parse(await f.pointer()); expect(next.version).toBe("1.1.0"); expect(next.slot).not.toBe(old.slot);
 expect(await readFile(oldMain,"utf8")).toBe(oldBytes);
 expect((await import(join(f.paths.root,"versions",old.slot,"node_modules","dinobot","lazy.js"))).default).toBe("1.0.0");
 expect(f.calls.at(-1)?.argv[1]).toContain(next.slot);
 expect(await readFile(f.paths.launcher,"utf8")).toBe(await readFile(f.source,"utf8"));
});
test("same version, build metadata and downgrade do not reinstall or rewrite pointer", async () => {
 const f = await fixture(); await runManaged(["--install"], f.options); const before = await f.pointer();
 for (const version of ["1.0.0","1.0.0+build","0.9.9"]) { f.setVersion(version); await runManaged(["update"],f.options); expect(await f.pointer()).toBe(before); }
 expect(f.installs()).toBe(1);
 expect(newerManagedVersion("999999999999999999.0.0","1000000000000000000.0.0")).toBe(true);
});
test("integrity failure precedes package side effects and leaves existing pointer/shim intact", async () => {
 const f = await fixture(); await runManaged(["--install"],f.options); const before = await f.pointer(); const shim = await readFile(f.paths.shim,"utf8");
 f.setVersion("2.0.0"); f.corrupt(); await expect(runManaged(["--install"],f.options)).rejects.toThrow("integrity");
 expect(f.installs()).toBe(1); expect(await f.pointer()).toBe(before); expect(await readFile(f.paths.shim,"utf8")).toBe(shim);
});
test("install and smoke failures preserve last version and shims; normal command fails open", async () => {
 for (const failure of ["install", "smoke"]) {
  const f = await fixture(); await runManaged(["--install"],f.options); const before = await f.pointer(); const shim = await readFile(f.paths.shim,"utf8");
  f.setVersion("2.0.0"); if (failure === "install") f.failInstall(); else f.failSmoke();
  await expect(runManaged(["update"],f.options)).rejects.toThrow();
  expect(await f.pointer()).toBe(before); expect(await readFile(f.paths.shim,"utf8")).toBe(shim);
  expect(await runManaged(["serve"],f.options)).toBe(7);
 }
});
test("offline and hung metadata checks fail open only with existing install", async () => {
 const f = await fixture(); await runManaged(["--install"],f.options); f.offline();
 expect(await runManaged(["tui"],f.options)).toBe(7);
 await expect(runManaged(["update"],f.options)).rejects.toThrow("offline");
 expect(await runManaged(["tui"], {...f.options,checkTimeoutMs:10, fetch:(()=>new Promise(()=>{})) as unknown as typeof fetch})).toBe(7);
 const fresh = await fixture(); fresh.offline(); await expect(runManaged(["--install"],fresh.options)).rejects.toThrow("offline");
});
test("exclusive concurrent installs reread pointer; abandoned lock is not stolen", async () => {
 const f = await fixture(); await Promise.all([runManaged(["--install"],f.options),runManaged(["--install"],f.options)]);
 expect(f.installs()).toBe(1); const before = await f.pointer();
 await mkdir(join(f.paths.root,".install-lock")); f.setVersion("2.0.0");
 await expect(runManaged(["update"],{...f.options,lockTimeoutMs:25})).rejects.toThrow("busy");
 expect(await f.pointer()).toBe(before); expect(await readdir(f.paths.root)).toContain(".install-lock");
});
test("unknown target shim conflicts before download/install and is never replaced", async () => {
 const f = await fixture(); await mkdir(f.paths.bin,{recursive:true}); await writeFile(f.paths.shim,"user owned");
 await expect(runManaged(["--install"],f.options)).rejects.toThrow("unknown launcher");
 expect(f.installs()).toBe(0); expect(await readFile(f.paths.shim,"utf8")).toBe("user owned");
});
test("explicit update never crosses launch boundary or forwards restart flags", async () => {
 const f = await fixture(); const runtime = {busy:true,queue:["queued"],subagents:new Set(["worker"])};
 const seam = f.options.command!;
 f.options.command = async (argv, opts) => { if (opts.mode === "launch") { runtime.busy=false; runtime.queue=[]; runtime.subagents.clear(); throw new Error("restart boundary crossed"); } return seam(argv,opts); };
 await runManaged(["--install"],f.options); f.setVersion("2.0.0"); await runManaged(["update"],f.options);
 expect(runtime).toEqual({busy:true,queue:["queued"],subagents:new Set(["worker"])});
 await expect(runManaged(["--config","x","update"],f.options)).rejects.toThrow("without preceding flags");
 await expect(runManaged(["update","--force"],f.options)).rejects.toThrow("never restart");
});
test("real bun installs verified local archive outside project, then immutable package runs", async () => {
 const f = await fixture(); const pkg = join(f.dir,"package"); await mkdir(pkg);
 await writeFile(join(pkg,"package.json"),JSON.stringify({name:"dinobot",version:"1.0.0",bin:{dinobot:"main.js"}}));
 await writeFile(join(pkg,"main.js"),'console.log(process.argv.includes("--version") ? "1.0.0" : "dinobot help");');
 const archive = join(f.dir,"real.tgz");
 const tar = Bun.spawn(["tar","-czf","real.tgz","package"],{cwd:f.dir,stdout:"pipe",stderr:"pipe"});
 const tarError = await new Response(tar.stderr).text(); expect(await tar.exited,tarError).toBe(0);
 const bytes = await readFile(archive);
 const fetcher = (async (url: string | URL | Request) => String(url).endsWith("latest.json") ? Response.json({name:"dinobot",version:"1.0.0",dist:{tarball:"https://releases.dinobot.workers.dev/core/releases/1.0.0/dinobot-1.0.0.tgz",integrity:"sha512-"+createHash("sha512").update(bytes).digest("base64")}}) : new Response(bytes)) as typeof fetch;
 await runManaged(["--install"],{...f.options,fetch:fetcher,command:managedCommand});
 const pointer = JSON.parse(await f.pointer());
 const result = await managedCommand([process.execPath,join(f.paths.root,"versions",pointer.slot,"node_modules","dinobot","main.js"),"--version"],{cwd:f.dir,env:process.env,mode:"smoke"});
 expect(result.stdout.trim()).toBe("1.0.0");
},20000);
test("relative overrides are rejected",()=>{ expect(()=>managedPaths({DINOBOT_INSTALL_DIR:"relative"})).toThrow("absolute"); });
test("durable shim pins Bun, managed root and spaced argv independently of install environment", async () => {
 const f = await fixture(); const received = join(f.dir,"received.json");
 const moduleUrl = new URL("../src/managed-install.ts",import.meta.url).href;
 await writeFile(f.source, 'import {runManaged} from ' + JSON.stringify(moduleUrl) + '; import {writeFile} from "node:fs/promises"; process.exitCode=await runManaged(process.argv.slice(2),{fetch:async()=>{throw new Error("offline")},command:async(argv)=>{await writeFile('+JSON.stringify(received)+',JSON.stringify(argv));return {code:0,stdout:""}}});');
 await runManaged(["--install"],f.options);
 const env = {...process.env}; delete env.DINOBOT_INSTALL_DIR;
 await writeFile(join(f.dir,"invoke.cmd"), '@echo off\r\ncall "' + f.paths.shim + '" --config "a path with spaces"\r\n');
 const argv = process.platform === "win32" ? ["cmd.exe","/d","/c","invoke.cmd"] : [f.paths.shim,"--config","a path with spaces"];
 const child = Bun.spawn(argv,{cwd:f.dir,env,stdout:"pipe",stderr:"pipe"});
 const error = await new Response(child.stderr).text(); expect(await child.exited,error).toBe(0);
 const receivedArgs = JSON.parse(await readFile(received,"utf8"));
 expect(receivedArgs.slice(2)).toEqual(["--config","a path with spaces"]);
 expect(receivedArgs[1]).toContain(JSON.parse(await f.pointer()).slot);
});
test("already-running runtime sentinel keeps busy queue and child state; old lazy imports still work", async () => {
 const f = await fixture(); await runManaged(["--install"],f.options);
 const old = JSON.parse(await f.pointer());
 const lazy = pathToFileURL(join(f.paths.root,"versions",old.slot,"node_modules","dinobot","lazy.js")).href;
 const sentinel = join(f.dir,"runtime.mjs");
 await writeFile(sentinel,'import {createInterface} from "node:readline"; const state={busy:true,queued:["request"],subagents:["worker"]}; console.log("ready"); for await(const line of createInterface({input:process.stdin})){if(line==="inspect"){console.log(JSON.stringify({...state,version:(await import('+JSON.stringify(lazy)+')).default}));break;}}');
 const child = Bun.spawn([process.execPath,sentinel],{stdin:"pipe",stdout:"pipe",stderr:"pipe"});
 const reader = child.stdout.getReader();
 try {
  expect(new TextDecoder().decode((await reader.read()).value)).toContain("ready");
  f.setVersion("2.0.0"); await runManaged(["update"],f.options);
  expect(child.exitCode).toBeNull(); child.stdin.write("inspect\n"); child.stdin.end();
  const message = new TextDecoder().decode((await reader.read()).value);
  expect(JSON.parse(message)).toEqual({busy:true,queued:["request"],subagents:["worker"],version:"1.0.0"});
  expect(await child.exited).toBe(0);
 } finally { reader.releaseLock(); if(child.exitCode===null){child.stdin.end();await child.exited;} }
});
test("another process owns the exclusive lock; timeout never deletes it",async()=>{
 const f=await fixture(); await runManaged(["--install"],f.options); f.setVersion("2.0.0");
 const path=join(f.paths.root,".install-lock"); const holder=join(f.dir,"holder.mjs");
 await writeFile(holder,'import {mkdir,rm} from "node:fs/promises"; await mkdir('+JSON.stringify(path)+'); console.log("locked"); await new Response(Bun.stdin.stream()).text(); await rm('+JSON.stringify(path)+',{recursive:true});');
 const child=Bun.spawn([process.execPath,holder],{stdin:"pipe",stdout:"pipe",stderr:"pipe"}); const reader=child.stdout.getReader();
 try {
  expect(new TextDecoder().decode((await reader.read()).value)).toContain("locked");
  await expect(runManaged(["update"],{...f.options,lockTimeoutMs:25})).rejects.toThrow("busy");
  expect(await readdir(f.paths.root)).toContain(".install-lock"); expect(child.exitCode).toBeNull();
 } finally {reader.releaseLock();child.stdin.end();await child.exited;}
 expect(await runManaged(["update"],f.options)).toBe(0);
});
test("standalone production entry bundles and rejects force update without running legacy CLI",async()=>{
 const f = await fixture();
 const build = await Bun.build({entrypoints:[fileURLToPath(new URL("../src/managed-install.ts",import.meta.url))],target:"bun",outdir:join(f.dir,"bundle")});
 expect(build.success,build.logs.join("\n")).toBe(true);
 const child = Bun.spawn([process.execPath,build.outputs[0]!.path,"update","--force"],{stdout:"pipe",stderr:"pipe"});
 const error = await new Response(child.stderr).text(); expect(await child.exited).toBe(1); expect(error).toContain("never restart");
});
