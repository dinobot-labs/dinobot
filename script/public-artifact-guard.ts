import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
export function violations(path: string, text: string): string[] {
 const out: string[] = [];
 if (/(^|\/)(services|reports|sessions|exports|openwiki|\.dinobot)(\/|$)|(^|\/)\.env(?:\.|$)|\.(sqlite(?:-wal|-shm)?|db|pem|p12|key)$/i.test(path)) out.push("forbidden path");
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
