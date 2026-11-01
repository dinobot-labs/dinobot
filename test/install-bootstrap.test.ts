import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createReleaseWorker, type Env } from "../script/cloudflare/worker.ts";
import { buildReleaseModules } from "../script/cloudflare/deploy.ts";

const root = resolve(import.meta.dir, "..");
const script = (name: string) => Bun.file(join(root, "script/install", name)).text();
const sh = Bun.which("sh");
const powershell = Bun.which("powershell") ?? Bun.which("pwsh");
function posix(path: string): string {
 if (process.platform !== "win32") return path;
 const result = Bun.spawnSync(["cygpath", "-u", path]);
 if (result.exitCode !== 0) throw new Error("cygpath failed");
 return result.stdout.toString().trim();
}
const env = { BUCKET: { get() { throw new Error("R2 must not be touched"); }, put() { throw new Error("R2 must not be touched"); } }, CORE_PUBLISH_TOKEN: "unused" } as unknown as Env;

test("bundled text modules serve GET/HEAD and reject HTTP/methods without R2", async () => {
 const dir = await mkdtemp(join(tmpdir(), "dinobot-bootstrap-build-"));
 try {
  const fixture = join(dir, "fixture.ts");
  await writeFile(fixture, "console.log(JSON.stringify(process.argv.slice(2)));\n");
  const modules = await buildReleaseModules(fixture);
  const assets = {"/install.sh": modules["install.sh.txt"]!.content,"/install.ps1": modules["install.ps1.txt"]!.content,"/install.mjs": modules["install.mjs.txt"]!.content};
  for (const [name, module] of Object.entries(modules)) await writeFile(join(dir,name),module.content);
  const worker = (await import(pathToFileURL(join(dir,"worker.js")).href)).default;
  for (const [path, body] of Object.entries(assets)) {
   const response = await worker.fetch(new Request("https://releases.dinobot.workers.dev" + path), env);
   expect(response.status).toBe(200); expect(await response.text()).toBe(body);
   expect(response.headers.get("cache-control")).toBe("no-store");
   expect(response.headers.get("x-content-type-options")).toBe("nosniff");
   expect(await (await worker.fetch(new Request("https://releases.dinobot.workers.dev" + path, {method:"HEAD"}),env)).text()).toBe("");
   expect((await worker.fetch(new Request("http://releases.dinobot.workers.dev" + path),env)).status).toBe(400);
   expect((await worker.fetch(new Request("https://releases.dinobot.workers.dev" + path,{method:"POST"}),env)).status).toBe(405);
  }
  await writeFile(join(dir,"install.mjs"), assets["/install.mjs"]);
  const run = Bun.spawnSync([process.execPath, join(dir,"install.mjs"),"--install"]);
  expect(run.exitCode).toBe(0); expect(JSON.parse(run.stdout.toString())).toEqual(["--install"]);
  expect((await createReleaseWorker().fetch(new Request("https://releases.dinobot.workers.dev/install.sh"),env)).status).toBe(503);
 } finally { await rm(dir,{recursive:true,force:true}); }
});

test.skipIf(!sh)("sh prerequisite failure does not create temporary files", async () => {
 const dir = await mkdtemp(join(tmpdir(),"dinobot-bootstrap-missing-"));
 try {
  const run = Bun.spawnSync([sh!,"-s"],{stdin:Buffer.from(await script("install.sh")),env:{...process.env,PATH:posix(dir),TMPDIR:posix(dir)}});
  expect(run.exitCode).toBe(1); expect(run.stderr.toString()).toContain("https://bun.sh");
  expect(await readdir(dir)).toEqual([]);
 } finally { await rm(dir,{recursive:true,force:true}); }
});

for (const status of [200,302,500]) test.skipIf(!sh)("sh download HTTP " + status + " and cleanup", async () => {
 const dir = await mkdtemp(join(tmpdir(),"dinobot-bootstrap-sh-"));
 try {
  const bin = join(dir,"bin"); const temp = join(dir,"temp"); await mkdir(bin); await mkdir(temp);
  await writeFile(join(bin,"bun"), "#!/bin/sh\n[ -f \"$1\" ] && [ \"$2\" = --install ] || exit 99\necho fixture-executed\nexit 17\n", {mode:0o755});
  await writeFile(join(bin,"curl"), "#!/bin/sh\nwhile [ $# -gt 0 ]; do\n case \"$1\" in --output) shift; out=$1;; esac\n shift\ndone\nprintf fixture > \"$out\"\nprintf %s \"$FIXTURE_HTTP\"\n", {mode:0o755});
  const run = Bun.spawnSync([sh!,"-s"],{stdin:Buffer.from(await script("install.sh")),env:{...process.env,PATH:posix(bin)+":/usr/bin:/bin",TMPDIR:posix(temp),FIXTURE_HTTP:String(status)}});
  expect(run.exitCode).toBe(status === 200 ? 17 : 1);
  expect(run.stdout.toString().includes("fixture-executed")).toBe(status === 200);
  expect(await readdir(temp)).toEqual([]);
 } finally { await rm(dir,{recursive:true,force:true}); }
});

for (const mode of ["missing","success","failure","redirect"]) test.skipIf(!powershell)("PowerShell fixture " + mode, async () => {
 const dir = await mkdtemp(join(tmpdir(),"dinobot-bootstrap-ps-"));
 try {
  const temp = join(dir,"temp"); await mkdir(temp);
  const quote = (s: string) => "'" + s.replaceAll("'","''") + "'";
  const prelude = "function Get-Command { param($Name,$CommandType,$ErrorAction) " + (mode === "missing" ? "return $null" : "return [pscustomobject]@{Source=" + quote(process.execPath) + "}") + " }\n"
   + "function Invoke-WebRequest { param($Uri,$MaximumRedirection,$TimeoutSec,[switch]$UseBasicParsing,$OutFile,[switch]$PassThru) if ($Uri -ne 'https://releases.dinobot.workers.dev/install.mjs' -or $MaximumRedirection -ne 0) { throw 'unsafe request' }; "
   + (mode === "redirect" ? "throw 'redirect rejected'" : "[IO.File]::WriteAllText($OutFile, 'console.log(JSON.stringify(process.argv.slice(2))); process.exit(" + (mode === "failure" ? "17" : "0") + ");'); return [pscustomobject]@{StatusCode=200}") + " }\n";
  const file = join(dir,"fixture.ps1");
  await writeFile(file,"\uFEFF" + prelude + await script("install.ps1") + "\nWrite-Output caller-still-running\n");
  const run = Bun.spawnSync([powershell!,"-NoProfile","-NonInteractive","-File",file],{env:{...process.env,TEMP:temp,TMP:temp}});
  expect(run.exitCode).toBe(mode === "success" ? 0 : 1);
  if (mode === "failure") expect(run.stderr.toString()).toContain("Bun exit 17");
  if (mode === "success") expect(run.stdout.toString()).toContain("caller-still-running");
  if (mode === "missing") expect(run.stderr.toString()).toContain("https://bun.sh");
  if (mode === "success") expect(run.stdout.toString()).toContain('["--install"]');
  expect(await readdir(temp)).toEqual([]);
 } finally { await rm(dir,{recursive:true,force:true}); }
});
