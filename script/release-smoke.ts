#!/usr/bin/env bun
/** Offline smoke of the staged dual bundle; does not install or publish. */
import { Worker } from "node:worker_threads";
import { join, resolve } from "node:path";
import { auditReleaseArtifact } from "./release-audit.ts";
import { readFileSync } from "node:fs";
const root=resolve(import.meta.dir,".."), pkg=join(root,"dist/npm/package");
const manifest=JSON.parse(readFileSync(join(pkg,"package.json"),"utf8"));
const archive=manifest.name.replace(/^@/,"").replace("/","-")+"-"+manifest.version+".tgz";
auditReleaseArtifact(join(root,"dist/npm",archive),manifest.version,manifest.name);
const version=Bun.spawnSync([process.execPath,join(pkg,"main.js"),"--version"],{stdout:"pipe",stderr:"pipe",timeout:10000});
if(version.exitCode !== 0 || version.stdout.toString().trim() !== manifest.version) throw new Error("main bundle smoke failed");
const worker=new Worker(new URL("../dist/npm/package/codemode-worker.js",import.meta.url),{workerData:{code:"return 42",names:[]}});
try {
 await new Promise<void>((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error("worker smoke timeout")),10000);
  worker.on("error",error=>{clearTimeout(timer);reject(error);});
  worker.on("message",message=>{if(message.type === "error"){clearTimeout(timer);reject(new Error("worker execution failed"));}if(message.type === "done"){clearTimeout(timer);if(message.value !== "42" || message.error) reject(new Error("worker result mismatch"));else resolve();}});
 });
} finally {await worker.terminate();}
console.log("release smoke: archive audited; main version and worker return42 passed");
