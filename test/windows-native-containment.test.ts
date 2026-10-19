import { test, expect } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { NodeExecutionEnv, isNativeProcessEvent, observeNativeProcessQuiescence } from "@earendil-works/pi-durable/env/node";
import type { NativeProcessEvent } from "@earendil-works/pi-durable/env";

/**
 * Windows process-tree containment (ADR 0075). Real Windows only: the fixed launcher is held in a fresh evidence-only
 * Job Object before it creates any process, so every descendant is a job member and zero active members after actual
 * close is the canonical proof. These run on the Windows host; elsewhere the POSIX process-group proof applies.
 */
const windows = process.platform === "win32" ? test : test.skip;
const bun = process.execPath.replaceAll("\\", "/");

async function run(command: string, options: { signal?: AbortSignal; onStarted?: (event: NativeProcessEvent) => void | Promise<void> } = {}) {
 const dir = await mkdtemp(join(tmpdir(), "win-contain-"));
 const env = new NodeExecutionEnv({ cwd: dir });
 const events: NativeProcessEvent[] = [];
 let output = "";
 const started = Date.now();
 const result = await env.exec(command, {
  onOutput: text => { output += text; },
  onProcess: async event => { expect(isNativeProcessEvent(event)).toBe(true); events.push(event); if (event.phase === "started") await options.onStarted?.(event); },
 }, options.signal ? { ...context, abortSignal: options.signal } : context);
 return { dir, result, events, output, elapsed: Date.now() - started };
}
function phases(events: NativeProcessEvent[]) {
 const started = events.find(e => e.phase === "started")!;
 const settled = events.find(e => e.phase === "settled")!;
 return { started, settled };
}

windows("fast ordinary command settles canonically with one consistent launcher identity", async () => {
 const { dir, result, events, output } = await run("echo contained; exit 7");
 try {
  expect(result.ok && result.value.exitCode).toBe(7);
  expect(output).toContain("contained");
  expect(events.map(e => e.phase)).toEqual(["admitted", "started", "settled"]);
  const { started, settled } = phases(events);
  expect(started.startTime).toMatch(/^win32-filetime:\d+$/);
  expect(started.boot).toMatch(/^win32-system-created:\d+$/);
  expect(settled.pid).toBe(started.pid);
  expect(settled.startTime).toBe(started.startTime);
  expect(settled.canonical).toBe(true);
 } finally { await rm(dir, { recursive: true, force: true }); }
}, 20000);

windows("three-generation tree that fully exits settles canonically", async () => {
 const grandchild = "await Bun.sleep(300);console.log('grandchild',process.pid)";
 const child = "const p=Bun.spawn([process.execPath,'-e',process.argv[1]],{stdout:'inherit'});await p.exited;console.log('child',process.pid)";
 const { dir, result, events, output } = await run(`"${bun}" -e ${JSON.stringify(child)} ${JSON.stringify(grandchild)}; sleep 0.5`);
 try {
  expect(result.ok && result.value.exitCode).toBe(0);
  expect(output).toContain("grandchild");
  expect(output).toContain("child");
  expect(phases(events).settled.canonical).toBe(true);
 } finally { await rm(dir, { recursive: true, force: true }); }
}, 20000);

windows("a descendant that outlives the shell keeps the call UNKNOWN until the retained job drains", async () => {
 const { dir, result, events } = await run(`"${bun}" -e "await Bun.sleep(2500);await Bun.write('drained','1')" >/dev/null 2>&1 &`);
 try {
  expect(result.ok && result.value.exitCode).toBe(0);
  const { started, settled } = phases(events);
  expect(settled.canonical).toBe(false); // tree not quiescent at close: no receipt from exit 0 or a vanished root
  expect(await observeNativeProcessQuiescence(started)).toMatchObject({ state: "alive" });
  for (let i = 0; i < 600 && !existsSync(join(dir, "drained")); i++) await Bun.sleep(10);
  expect(existsSync(join(dir, "drained"))).toBe(true);
  let observed = await observeNativeProcessQuiescence(started);
  for (let i = 0; i < 100 && observed.state === "alive"; i++) { await Bun.sleep(10); observed = await observeNativeProcessQuiescence(started); }
  expect(observed.state).toBe("quiescent");
  expect((await observeNativeProcessQuiescence(started)).state).toBe("quiescent"); // stable: observing does not consume it
  // Another nonce has no job and no reboot.
  expect((await observeNativeProcessQuiescence({ ...started, nonce: "forged" })).state).toBe("unknown");
 } finally { await rm(dir, { recursive: true, force: true }); }
}, 20000);

windows("a descendant holding stdout does not hang exec and stays UNKNOWN", async () => {
 const { dir, result, events, elapsed } = await run(`"${bun}" -e "await Bun.sleep(4000)" &`);
 try {
  expect(result.ok && result.value.exitCode).toBe(0);
  expect(elapsed).toBeLessThan(3500);
  expect(phases(events).settled.canonical).toBe(false);
 } finally { await Bun.sleep(4200); await rm(dir, { recursive: true, force: true }); }
}, 20000);

windows("explicit job breakaway is refused, so no descendant can leave the proof", async () => {
 const dir = await mkdtemp(join(tmpdir(), "win-breakaway-"));
 try {
  await writeFile(join(dir, "breakaway.ts"), `
import { dlopen, FFIType, ptr } from "bun:ffi";
const k = dlopen("kernel32.dll", { CreateProcessW: { args: ["ptr","ptr","ptr","ptr","i32","u32","ptr","ptr","ptr","ptr"], returns: "i32" }, GetLastError: { args: [], returns: "u32" } }).symbols;
const command = Buffer.from(process.env.ComSpec + " /c exit 0\\0", "utf16le");
const startup = new Uint8Array(104); new DataView(startup.buffer).setUint32(0, 104, true);
const info = new Uint8Array(24);
const ok = k.CreateProcessW(null, ptr(command), null, null, 0, 0x01000000 | 0x08000000, null, null, ptr(startup), ptr(info));
await Bun.write("breakaway.json", JSON.stringify({ ok, error: ok ? 0 : k.GetLastError() }));
`);
  const env = new NodeExecutionEnv({ cwd: dir });
  const events: NativeProcessEvent[] = [];
  const result = await env.exec(`"${bun}" breakaway.ts`, { onProcess: event => { events.push(event); } }, context);
  expect(result.ok && result.value.exitCode).toBe(0);
  expect(JSON.parse(await readFile(join(dir, "breakaway.json"), "utf8"))).toEqual({ ok: 0, error: 5 }); // ERROR_ACCESS_DENIED
  expect(phases(events).settled.canonical).toBe(true);
 } finally { await rm(dir, { recursive: true, force: true }); }
}, 20000);

windows("a failed identity commit never starts the shell", async () => {
 const dir = await mkdtemp(join(tmpdir(), "win-gate-"));
 try {
  const env = new NodeExecutionEnv({ cwd: dir });
  const result = await env.exec("touch started-anyway", { onProcess: event => { if (event.phase === "started") throw new Error("journal unavailable"); } }, context);
  expect(result.ok).toBe(false);
  expect(!result.ok && result.error.code).toBe("callback_error");
  await Bun.sleep(500);
  expect(existsSync(join(dir, "started-anyway"))).toBe(false);
 } finally { await rm(dir, { recursive: true, force: true }); }
}, 20000);

windows("aborting a contained tree kills it, stays UNKNOWN, and leaves job evidence for the operator", async () => {
 const controller = new AbortController();
 const { dir, result, events } = await run(`"${bun}" -e "await Bun.sleep(8000);await Bun.write('survived','1')" >/dev/null 2>&1 & sleep 8`, { onStarted: () => { setTimeout(() => controller.abort(), 800); } , signal: controller.signal });
 try {
  expect(result.ok).toBe(false);
  expect(!result.ok && result.error.code).toBe("aborted");
  const { started, settled } = phases(events);
  expect(settled.canonical).toBe(false);
  let observed = await observeNativeProcessQuiescence(started);
  for (let i = 0; i < 100 && observed.state === "alive"; i++) { await Bun.sleep(10); observed = await observeNativeProcessQuiescence(started); }
  expect(observed.state).toBe("quiescent");
  await Bun.sleep(300);
  expect(existsSync(join(dir, "survived"))).toBe(false);
 } finally { await rm(dir, { recursive: true, force: true }); }
}, 20000);

windows("only a different boot identity is reboot evidence for an unretained tree", async () => {
 const { dir, events } = await run("exit 0");
 try {
  const { started } = phases(events);
  const unretained = { ...started, nonce: "unretained" };
  expect(await observeNativeProcessQuiescence(unretained)).toMatchObject({ state: "unknown" }); // same boot, no job
  expect(await observeNativeProcessQuiescence({ ...unretained, boot: "win32-system-created:1" })).toMatchObject({ state: "quiescent" });
  const { boot: _boot, ...legacy } = unretained;
  expect(await observeNativeProcessQuiescence(legacy)).toMatchObject({ state: "unknown", evidence: "no retained job and no recorded boot identity" });
 } finally { await rm(dir, { recursive: true, force: true }); }
}, 20000);

windows("a compiled host binary evaluates the launcher through its embedded Bun", async () => {
 const dir = await mkdtemp(join(tmpdir(), "win-compiled-"));
 try {
  const exe = join(dir, "host.exe");
  const build = Bun.spawnSync([process.execPath, "build", "--compile", join(import.meta.dir, "fixtures/compiled-contained-exec.ts"), "--outfile", exe], { stdout: "pipe", stderr: "pipe" });
  expect(build.exitCode).toBe(0);
  const run = Bun.spawnSync([exe], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  expect(run.exitCode).toBe(0);
  const report = JSON.parse(run.stdout.toString().trim().split("\n").at(-1)!);
  expect(report.execPath.toLowerCase()).toBe(exe.toLowerCase());
  expect(report.result).toMatchObject({ exitCode: 3 });
  expect(report.output).toContain("compiled-contained");
  expect(report.events.find((e: NativeProcessEvent) => e.phase === "settled")).toMatchObject({ canonical: true });
 } finally { await rm(dir, { recursive: true, force: true }); }
}, 120000);

windows("a workspace bunfig preload cannot run code in the launcher before containment", async () => {
 const dir = await mkdtemp(join(tmpdir(), "win-preload-"));
 try {
  await writeFile(join(dir, "escape.js"), "require('node:fs').writeFileSync(require('node:path').join(" + JSON.stringify(dir) + ",'preload-ran'),String(process.pid));");
  await writeFile(join(dir, "bunfig.toml"), 'preload = ["./escape.js"]\n');
  const env = new NodeExecutionEnv({ cwd: dir });
  const events: NativeProcessEvent[] = [];
  let output = "";
  const result = await env.exec("pwd -W", { onOutput: text => { output += text; }, onProcess: event => { events.push(event); } }, context);
  expect(result.ok && result.value.exitCode).toBe(0);
  expect(existsSync(join(dir, "preload-ran"))).toBe(false);
  expect(output.trim().toLowerCase().replaceAll("\\", "/")).toBe(dir.toLowerCase().replaceAll("\\", "/")); // the shell still runs in the workspace
  expect(phases(events).settled.canonical).toBe(true);
 } finally { await rm(dir, { recursive: true, force: true }); }
}, 20000);
