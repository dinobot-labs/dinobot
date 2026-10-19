#!/usr/bin/env bun
/** Host-only standalone staging. npm dual bundles are built/audited by release.ts. */
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

export function nativeBuildFiles(platform: string, arch: string): { packageName: string; executable: string; baseline: string } {
 if (!["linux","darwin","win32"].includes(platform) || !["x64","arm64"].includes(arch)) throw new Error("Unsupported build platform");
 const tag=platform+"-"+arch;
 return {packageName:"@oh-my-pi/pi-natives-"+tag, executable:platform === "win32" ? "dinobot.exe" : "dinobot", baseline:"pi_natives."+tag+(arch === "x64" ? "-baseline" : "")+".node"};
}
/** Compile the standalone host binary and stage the exact host native addons into `dist`. */
export function buildHost(dist: string, platform: string = process.platform, arch: string = process.arch): void {
 const root=resolve(import.meta.dir,".."), plan=nativeBuildFiles(platform,arch);
 const native=join(root,"node_modules",plan.packageName), out=resolve(dist);
 if (!existsSync(join(native,plan.baseline))) throw new Error("Host native addon missing: "+plan.packageName);
 const files=readdirSync(native).filter(file=>file.startsWith("pi_natives."+platform+"-"+arch) && file.endsWith(".node"));
 mkdirSync(out,{recursive:true});
 const build=Bun.spawnSync([process.execPath,"build","--compile","src/main.ts","src/codemode-worker.ts","--outfile",join(out,plan.executable)],{cwd:root,stdout:"inherit",stderr:"inherit"});
 if (build.exitCode !== 0) throw new Error("bun build --compile failed (exit "+(build.exitCode ?? "unknown")+")");
 for (const file of files) copyFileSync(join(native,file),join(out,file));
 console.log("build: staged "+plan.executable+" and "+files.length+" host native addon(s)");
}
if (import.meta.main) {
 buildHost(join(resolve(import.meta.dir,".."),"dist"));
}
