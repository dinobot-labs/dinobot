import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { NodeExecutionEnv, isNativeProcessEvent, observeNativeProcessQuiescence } from "@earendil-works/pi-durable/env/node";
import type { NativeProcessEvent } from "@earendil-works/pi-durable/env";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NativeProvenanceDoc } from "../src/core/claim-cleanup.ts";
import { ClaimsDoc, acquire, release, type Claim } from "../src/core/claims.ts";
import { openBot } from "../src/core/bot.ts";

/**
 * Liveness on every platform (issue #47): an ordinary bash call with real descendants that all exit settles the
 * native-provenance journal and ends the fence on exactly the claims the call held. Linux proves it with the empty
 * process group; Windows with the drained containment job. A fast command must not lose its identity to a race.
 * Settlement ends the fence, never the lease (ADR 0079): the holder keeps mutual exclusion until work_release or TTL.
 */
for (const mode of ["direct", "codemode-only"] as const) for (const [shape, command] of [["fast", "exit 0"], ["descendant", "sleep 0.3 && touch child-ran"]] as const) test(`ordinary ${shape} native call settles and unfences its claim, keeping the lease, on ${process.platform} ${mode}`, async () => {
 const dir = await mkdtemp(join(tmpdir(), "ordinary-settle-"));
 const models = createModels(); const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] }); models.setProvider(faux.provider);
 const call = (name: string, args: Record<string, string>) => fauxAssistantMessage(mode === "direct" ? fauxToolCall(name, args) : fauxToolCall("codemode", { code: "text(await tools." + name + "(" + JSON.stringify(args) + "));" }), { stopReason: "toolUse" });
 faux.setResponses([call("work_claim", { key: "owned:ordinary", intent: "exact" }), call("bash", { command }), fauxAssistantMessage("done")]);
 const storage = await openNodeSqliteStorage(join(dir, "host.sqlite"));
 try {
  const bot = await openBot({ storage, models, defaultModel: { provider: "faux", modelId: "m" }, workspaceRoot: dir, toolMode: mode, plugins: [] }, context);
  try {
   const root = await bot.conversation("test", mode + shape, context);
   const submission = await root.submit({ type: "input", content: "run" }, context);
   expect((await submission.wait(context)).status).toBe("done");
   if (shape === "descendant") expect(existsSync(join(dir, "child-ran"))).toBe(true);
   const journal = (await bot.harness.snapshot(NativeProvenanceDoc, root.id, context))!.calls.find(c => c.kind === "process")!;
   const claim: Claim = journal.acquiredTokens![0]!;
   if (journal.phase !== "settled") console.error("native-settlement-diagnostic", JSON.stringify({ mode, shape, journal }));
   expect(journal.phase).toBe("settled");
   const started = journal.processes!.find(e => e.phase === "started")!;
   const settled = journal.processes!.find(e => e.phase === "settled")!;
   expect(settled.canonical).toBe(true);
   expect(started.startTime).toBeTruthy(); // observed OS identity, not caller JSON
   expect(settled.startTime).toBe(started.startTime);
   expect(settled.pid).toBe(started.pid);
   const after = (await bot.harness.snapshot(ClaimsDoc, context))!.claims;
   const held = after.find(c => c.token === claim.token)!;
   expect(held).toBeDefined();
   expect(held.quarantined).toBeUndefined();
   await bot.harness.commit(async tx => {
    const state = await tx.doc(ClaimsDoc);
    // Mutual exclusion survives the bash call: another holder still conflicts until the holder releases.
    expect(acquire(state, { key: "owned:ordinary", holder: "fixture:other", intent: "during", ttlMs: 60000 }, Date.now()).status).toBe("conflict");
    expect(release(state, claim.holder, claim.key, Date.now()).map(c => c.token)).toEqual([claim.token]);
    expect(acquire(state, { key: "owned:ordinary", holder: "fixture:other", intent: "after", ttlMs: 60000 }, Date.now()).status).toBe("granted");
   }, context);
  } finally { await bot.close(context); }
 } finally { await storage.close(context); Bun.gc(true); await rm(dir, { recursive: true, force: true }); }
}, 30000);

const posix = process.platform === "linux" || process.platform === "darwin" ? test : test.skip;
const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";

for (const unavailable of ["null", "pending"] as const) posix(`POSIX ${unavailable} OS identity observation fails closed and cleans the gate`, async () => {
 // Isolated module mutation at the OS-observation boundary, not a forged receipt or relaxed assertion.
 // All spawn/gating/cancellation code below runs unchanged; no shared module/installed file is modified.
 const original = await readFile(new URL(import.meta.resolve("@earendil-works/pi-durable/env/node")), "utf8");
 const marker = "async function nativeStartTime(pid) {";
 expect(original.split(marker).length).toBe(2);
 const source = original.replace(marker, marker + (unavailable === "null" ? " return null;" : " return await new Promise(() => {});"))
  .replace('from "./index.js"', "from " + JSON.stringify(import.meta.resolve("@earendil-works/pi-durable/env")));
 const isolated = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64")) as { NodeExecutionEnv: typeof NodeExecutionEnv };
 const dir = await mkdtemp(join(tmpdir(), "posix-no-identity-")); const events: NativeProcessEvent[] = [];
 try {
  const result = await new isolated.NodeExecutionEnv({ cwd: dir }).exec("touch must-not-run", { timeout: 0.2, onProcess: event => { events.push(event); } }, context);
  expect(result.ok).toBe(false);
  expect(!result.ok && result.error.code).toBe(unavailable === "null" ? "callback_error" : "timeout");
  expect(events.some(e => e.phase === "started")).toBe(false);
  expect(events.some(e => e.canonical === true)).toBe(false);
  expect(existsSync(join(dir, "must-not-run"))).toBe(false);
  const pid = events.find(e => e.phase === "settled")?.pid;
  expect(pid).toBeGreaterThan(0);
  expect(() => process.kill(-pid!, 0)).toThrow();
 } finally { await rm(dir, { recursive: true, force: true }); }
}, 10000);

posix("POSIX fast commands retain the same real identity through canonical close repeatedly", async () => {
 const dir = await mkdtemp(join(tmpdir(), "posix-fast-"));
 try {
  const env = new NodeExecutionEnv({ cwd: dir });
  for (let i = 0; i < 64; i++) {
   const events: NativeProcessEvent[] = [];
   const result = await env.exec("exit 0", { onProcess: async event => {
    expect(isNativeProcessEvent(event)).toBe(true); events.push(event);
    if (event.phase === "started") {
     const observed = process.platform === "linux"
      ? (await readFile(`/proc/${event.pid}/stat`, "utf8")).split(/\) /).at(-1)!.split(" ")[19]!
      : Bun.spawnSync(["/bin/ps", "-o", "lstart=", "-p", String(event.pid)], { stdout: "pipe" }).stdout.toString().trim();
     expect(event.startTime).toBe(observed); // independently read the real still-blocked OS process, no synthetic identity
    }
   } }, context);
   expect(result.ok && result.value.exitCode).toBe(0);
   expect(events.map(e => e.phase)).toEqual(["admitted", "started", "settled"]);
   const started = events[1]!; const settled = events[2]!;
   expect(started.startTime).toBeTruthy(); expect(started.pid).toBeGreaterThan(0);
   expect(settled).toMatchObject({ nonce: started.nonce, pid: started.pid, startTime: started.startTime, canonical: true });
  }
 } finally { await rm(dir, { recursive: true, force: true }); }
}, 30000);

posix("POSIX command cannot execute before the real identity commit, even with hostile cwd/env/quoted command", async () => {
 const dir = await mkdtemp(join(tmpdir(), "posix gate ' space-"));
 try {
  await writeFile(join(dir, "preload.js"), "require('node:fs').writeFileSync('preload-ran','unsafe')");
  await writeFile(join(dir, "bunfig.toml"), 'preload = ["./preload.js"]\n');
  const value = "a 'quote' \"double\" $(touch injected) `touch injected2` ;\nsecond line";
  const command = `if IFS= read -r unexpected; then exit 92; fi; printf 'argv:%s\\nenv:%s\\n' ${quote(value)} "$HOSTILE_VALUE"; printf 'stderr-exact' >&2; touch command-ran; exit 7`;
  const env = new NodeExecutionEnv({ cwd: dir }); let output = "";
  const events: NativeProcessEvent[] = [];
  const result = await env.exec(command, { env: { HOSTILE_VALUE: value, BUN_OPTIONS: "--preload ./preload.js" }, onOutput: text => { output += text; }, onProcess: async event => {
   events.push(event);
   if (event.phase === "started") {
    expect((await observeNativeProcessQuiescence(event)).state).toBe("alive");
    await Bun.sleep(100);
    expect(existsSync(join(dir, "command-ran"))).toBe(false);
    expect(existsSync(join(dir, "preload-ran"))).toBe(false);
   }
  } }, context);
  expect(result.ok && result.value.exitCode).toBe(7);
  expect(output).toContain("argv:" + value); expect(output).toContain("env:" + value); expect(output).toContain("stderr-exact");
  expect(existsSync(join(dir, "command-ran"))).toBe(true);
  expect(existsSync(join(dir, "injected"))).toBe(false); expect(existsSync(join(dir, "injected2"))).toBe(false);
  expect(events.at(-1)).toMatchObject({ canonical: true, startTime: events[1]!.startTime });
 } finally { await rm(dir, { recursive: true, force: true }); }
}, 15000);

for (const failure of ["throw", "cancel", "deadline"] as const) posix(`POSIX ${failure} during identity commit aborts the blocked gate without starting user code`, async () => {
 const dir = await mkdtemp(join(tmpdir(), "posix-abort-")); const controller = new AbortController();
 let identity: NativeProcessEvent | undefined;
 try {
  const env = new NodeExecutionEnv({ cwd: dir });
  const result = await env.exec("touch must-not-run", { timeout: failure === "deadline" ? 0.2 : 5, onProcess: async event => {
   if (event.phase !== "started") return;
   identity = event;
   if (failure === "throw") throw Error("journal failed");
   if (failure === "cancel") setTimeout(() => controller.abort(), 50);
   await new Promise<void>(() => {}); // deliberately uncooperative commit; abort must not await it forever
  } }, { ...context, abortSignal: controller.signal });
  expect(result.ok).toBe(false);
  expect(!result.ok && result.error.code).toBe(failure === "throw" ? "callback_error" : failure === "cancel" ? "aborted" : "timeout");
  expect(identity?.startTime).toBeTruthy();
  expect((await observeNativeProcessQuiescence(identity)).state).toBe("quiescent");
  expect(existsSync(join(dir, "must-not-run"))).toBe(false);
 } finally { controller.abort(); await rm(dir, { recursive: true, force: true }); }
}, 10000);

posix("POSIX successful shell exit does not canonically release a live descendant group", async () => {
 const dir = await mkdtemp(join(tmpdir(), "posix-live-")); const events: NativeProcessEvent[] = [];
 try {
  const result = await new NodeExecutionEnv({ cwd: dir }).exec("sleep 10 >/dev/null 2>&1 &", { onProcess: event => { events.push(event); } }, context);
  expect(result.ok && result.value.exitCode).toBe(0);
  expect(events[1]?.startTime).toBeTruthy();
  expect(events.at(-1)).toMatchObject({ phase: "settled", canonical: false });
  expect((await observeNativeProcessQuiescence(events[1])).state).toBe("alive");
 } finally {
  const pid = events[1]?.pid; if (pid) { try { process.kill(-pid, "SIGKILL"); } catch {} }
  await rm(dir, { recursive: true, force: true });
 }
}, 15000);
