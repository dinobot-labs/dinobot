import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const landingFiles = new Set([".gitignore", "bunfig.toml", "bun.lock", "package.json", "tsconfig.json", "vite.config.ts", "cloudflare.config.ts"]);
const landingDirectories = new Set(["src", "public", "vite", "test", "docs"]);

export function violations(path: string, text: string): string[] {
 const out: string[] = [];
 const normalized = path.replaceAll("\\", "/");
 // Only this public package may live under services. Strip exactly its prefix;
 // nested services and operational directories still pass through the deny rules.
 const landing = normalized.startsWith("services/landing/");
 const inspected = landing ? normalized.slice("services/landing/".length) : normalized;
 const segments = inspected.split("/");
 const invalidLanding = landing && inspected !== "" && !(landingDirectories.has(segments[0]!) || (segments.length === 1 && landingFiles.has(inspected)));
 const forbidden = /(^|\/)(services|reports|sessions|exports|openwiki|\.dinobot|\.git|\.cloudflare|\.wrangler|qa|lab|secrets|credentials|node_modules|dist|coverage|\.cache)(\/|$)|(^|\/)\.(?:env|dev\.vars)(?:\.|$)|\.((?:sqlite|db)(?:-wal|-shm|-journal)?|pem|p12|pfx|key)$/i;
 // services/ is a traversal container, not a blanket publication exception.
 if (invalidLanding || (normalized !== "services/" && forbidden.test(inspected))) out.push("forbidden path");
 if (/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,}|xox[baprs]-[0-9A-Za-z-]{30,}|AKIA[A-Z0-9]{16})\b/.test(text)) out.push("credential pattern");
 if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\s+[A-Za-z0-9+/=]{64}/.test(text)) out.push("private key");
 return out;
}
export function scan(root: string): string[] {
 const errors: string[] = [];
 const walk=(dir:string)=> { for(const e of readdirSync(dir,{withFileTypes:true})) {
  const file=join(dir,e.name),p=relative(root,file).replaceAll("\\","/");
  if(p===".git" || p==="node_modules" || p==="dist") continue; // local tooling, never source publication inputs
  if(e.isSymbolicLink()){errors.push(p+": symbolic link");continue;}
  if(e.isDirectory()){if(violations(p+"/","").length)errors.push(p+": forbidden directory");else walk(file);continue;}
  for(const why of violations(p,readFileSync(file,"utf8"))) errors.push(p+": "+why);
 }}; walk(root); return errors;
}
if(import.meta.main){const errors=scan(resolve(import.meta.dir,".."));for(const e of errors)console.error(e);console.log("public artifact guard: "+errors.length+" violation(s)");process.exitCode=errors.length?1:0;}
