import { describe, test, expect, spyOn } from "bun:test";
import assert from "node:assert/strict";
import type { Context } from "@earendil-works/chord";
import { createTelegramForwarder, runTelegramChannel } from "../src/cli/telegram-run.ts";
import { httpChannel } from "../src/channels/http.ts";
import { withCommands, type Commands } from "../src/commands/index.ts";
import type { InboundMessage } from "../src/channels/types.ts";

const message: InboundMessage = { channel: "ignored", threadKey: "1:-22:3:4", messageId: "987", userId: "4", text: "안녕 😀" };
const args = ["--token-file", "/private/token", "--pairing-file", "/private/pairing", "--database", "/private/jobs", "--core-url", "http://127.0.0.1:8787", "--port", "8791"];

describe("Telegram forwarder", () => {
 test("I7 forwards choices and preserves valid asks, drops only malformed asks", async () => {
  const id = "a".repeat(32), choice = {askId:id,option:1};
  const asks = [{id,question:"DB?",options:["SQLite","Postgres"],default:"SQLite",deadlineAt:123}];
  let invalid = false;
  const server = Bun.serve({hostname:"127.0.0.1",port:0,async fetch(request) {
   expect((await request.json() as {choice: unknown}).choice).toEqual(choice);
   return Response.json({status:"answered",text:"ok",asks:invalid ? [{...asks[0],options:["one"]}] : asks});
  }});
  try {
   const forward = createTelegramForwarder(server.url.origin);
   expect(await forward({...message,choice})).toEqual({status:"answered",text:"ok",asks});
   invalid = true;
   expect(await forward({...message,choice})).toEqual({status:"answered",text:"ok"});
  } finally { await server.stop(true); }
 });
 test("preserves identity, Unicode, and prefixes every message", async () => {
  const received: unknown[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
   expect(new URL(request.url).pathname).toBe("/v1/messages");
   expect(request.method).toBe("POST");
   received.push(await request.json());
   return Response.json({ status: "answered", text: "답변 😀" });
  } });
  try {
   const forward = createTelegramForwarder(server.url.origin);
   for (let i = 0; i < 2; i++) expect(await forward(message)).toEqual({ status: "answered", text: "답변 😀" });
   expect(received).toEqual([0, 1].map(() => ({ ...message, channel: "telegram", text: "Telegram message:\n안녕 😀" })));
  } finally { await server.stop(true); }
 });
 test("real HTTP bridge preserves image bytes and steering without privileged lookup", async () => {
  const seen: InboundMessage[] = [];
  const channel = httpChannel(0);
  await channel.start(async input => { seen.push(input); return {status:"answered",text:"image received"}; });
  try {
   const images = [{mimeType:"image/png",data:"AQID"}];
   const forward = createTelegramForwarder(channel.url().origin);
   expect(await forward({...message,images},undefined,undefined,{whenBusy:"steer"})).toEqual({status:"answered",text:"image received"});
   expect(seen[0]?.images).toEqual(images);
   expect(seen[0]?.threadKey).toBe(message.threadKey);
  } finally { await channel.stop(); }
 });
 test("real HTTP middleware cannot execute prefixed slash commands", async () => {
  let privileged = 0; const seen: InboundMessage[] = [];
  const commands = { find() { privileged++; return undefined; } } as unknown as Commands;
  const channel = httpChannel(0);
  await channel.start(withCommands(commands, async input => { seen.push(input); return { status: "answered", text: "faux model" }; }, {} as Context));
  try {
   // Positive control: the actual middleware does recognize an unprefixed command.
   await fetch(new URL("/v1/messages", channel.url()), { method: "POST", body: JSON.stringify({ ...message, text: "/model secret" }) });
   expect(privileged).toBe(1);
   const forward = createTelegramForwarder(channel.url().origin);
   for (const text of ["/login", "/modelish secret", " \n/logout", "ordinary 😀", "Telegram message:\n/help"]) {
    expect(await forward({ ...message, text })).toEqual({ status: "answered", text: "faux model" });
    expect(seen.at(-1)?.text).toBe("Telegram message:\n" + text);
   }
   expect(privileged).toBe(1);
  } finally { await channel.stop(); }
 });
 test("rejects non-exact loopback origins", () => {
  for (const url of ["https://127.0.0.1", "http://localhost", "http://127.1", "http://2130706433", "http://127.0.0.2", "http://[::1]", "http://user:token@127.0.0.1", "http://127.0.0.1/x", "http://127.0.0.1/..", "http://127.0.0.1?x", "http://127.0.0.1#x", "http://127.0.0.1:65536", "http://127.0.0.1:0"]) {
   expect(() => createTelegramForwarder(url)).toThrow("Invalid Telegram core URL");
  }
 });
 test("validates replies and bounds decoded text and JSON bytes", async () => {
  let body = "";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(body) });
  try {
   const forward = createTelegramForwarder(server.url.origin);
   for (const reply of [{ status: "unanswered", reason: "busy" }, { status: "answered", text: "😀".repeat(32768) }, { status: "answered", text: "\u0000".repeat(65536) }] as const) {
    body = JSON.stringify(reply); expect(await forward(message)).toEqual(reply);
   }
   for (const invalid of ["null", "{}", "{broken", '{"status":"answered","text":7}', JSON.stringify({ status: "answered", text: "x".repeat(65537) }), " ".repeat(65536 * 6 + 1025), JSON.stringify({ status: "unanswered", reason: "x".repeat(65537) })]) {
    body = invalid; await expect(forward(message)).rejects.toThrow("Telegram core request failed");
   }
  } finally { await server.stop(true); }
 });
 test("HTTP errors and redirects are sanitized and never followed", async () => {
  let hits = 0;
  const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { hits++; return Response.json({ status: "answered", text: "unsafe" }); } });
  let status = 302;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("token raw error", { status, headers: { location: target.url.href } }) });
  try {
   for (status of [302, 307, 400, 500]) await expect(createTelegramForwarder(server.url.origin)(message)).rejects.toThrow(/^Telegram core request failed$/);
   expect(hits).toBe(0);
  } finally { await server.stop(true); await target.stop(true); }
 });
 for (const streaming of [false, true]) {
  test(`${streaming ? "NDJSON heartbeats" : "JSON body"} can remain pending for 24 hours without a total deadline`, async () => {
   // Run installed callbacks at their due times, not merely a Date.now jump.
   // A restored one-hour deadline must really abort this pending body.
   let now = 0, nextId = 0;
   type Timer = ReturnType<typeof setTimeout>;
   const timers = new Map<Timer, { at: number; fire: () => void }>();
   const installed: number[] = [];
   const timer = spyOn(globalThis, "setTimeout").mockImplementation(((fn: (...args: any[]) => void, ms = 0, ...values: any[]) => {
    installed.push(ms);
    const id = ++nextId as unknown as Timer;
    timers.set(id, { at: now + ms, fire: () => fn(...values) });
    return id;
   }) as typeof setTimeout);
   const clear = spyOn(globalThis, "clearTimeout").mockImplementation((id) => { timers.delete(id as Timer); });
   const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
     const next = [...timers].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
     if (!next) break;
     now = next[1].at;
     timers.delete(next[0]);
     next[1].fire();
    }
    now = end;
   };
   // Drain stream/promise jobs without installing a timeout in the virtual clock.
   const flush = () => new Promise<void>(resolve => setImmediate(resolve));
   const encoder = new TextEncoder();
   let body!: ReadableStreamDefaultController<Uint8Array>;
   const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { body = controller; } }), { headers: { "content-type": streaming ? "application/x-ndjson" : "application/json" } });
   let transportSignal: AbortSignal | undefined;
   const onAbort = () => body.error(new Error("private transport cancellation"));
   const request = spyOn(globalThis, "fetch").mockImplementation((async (_url, init) => {
    transportSignal = init?.signal ?? undefined;
    transportSignal?.addEventListener("abort", onAbort, { once: true });
    return response;
   }) as typeof fetch);
   const cancellation = new AbortController();
   let heartbeats = 0, settled = false;
   const pending = createTelegramForwarder("http://127.0.0.1:8787")(message, cancellation.signal, event => { if (event.type === "heartbeat") heartbeats++; })
    .then(reply => { settled = true; return { reply }; }, error => { settled = true; return { error }; });
   try {
    if (!streaming) body.enqueue(encoder.encode("{"));
    await flush();
    const duration = 24 * 60 * 60 * 1_000;
    for (let elapsed = 0; elapsed < duration; elapsed += streaming ? 10_000 : duration) {
     advance(streaming ? 10_000 : duration);
     expect(transportSignal?.aborted).toBe(false);
     if (streaming) body.enqueue(encoder.encode('{"type":"heartbeat"}\n'));
     await flush();
    }
    expect(now).toBe(duration);
    expect(settled).toBe(false);
    expect(heartbeats).toBe(streaming ? duration / 10_000 : 0);
    // Only renewable 60s inactivity timers are permitted, never Infinity or a total bound.
    expect(installed).toEqual(streaming ? Array(heartbeats + 1).fill(60_000) : []);
    const reply = { status: "answered", text: "eventual answer after 24 hours" } as const;
    body.enqueue(encoder.encode(streaming ? JSON.stringify({ type: "reply", reply }) + "\n" : JSON.stringify(reply).slice(1)));
    body.close();
    expect(await pending).toEqual({ reply });
    expect(timers.size).toBe(0);
    expect(response.body?.locked).toBe(false);
    cancellation.abort();
    expect(transportSignal?.aborted).toBe(false); // The forwarding listener was removed.
   } finally {
    cancellation.abort();
    await pending;
    transportSignal?.removeEventListener("abort", onAbort);
    request.mockRestore();
    clear.mockRestore();
    timer.mockRestore();
   }
  });
 }
 test("honors pre-aborted and in-flight signals including response body reads", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"status":')); } })) });
  try {
   const forward = createTelegramForwarder(server.url.origin);
   const prior = new AbortController(); prior.abort(new Error("private token"));
   await expect(forward(message, prior.signal)).rejects.toThrow(/^Telegram core request failed$/);
   const active = new AbortController(); const pending = forward(message, active.signal);
   const timer = setTimeout(() => active.abort(), 30);
   try { await expect(pending).rejects.toThrow(/^Telegram core request failed$/); } finally { clearTimeout(timer); }
  } finally { await server.stop(true); }
 });
});

// Serialize only these self-contained, typechecked callbacks. No shared-runner
// signal handlers or imported daemon state enter the child. The deadline kills
// only the owned child, and a timeout/nonzero exit always fails the test.
async function isolatedLifetime(check: (run: typeof runTelegramChannel, args: string[], assert: typeof import("node:assert/strict")) => Promise<void>, childArgs = args) {
 const script = [
  'import assert from "node:assert/strict";',
  'import { runTelegramChannel } from ' + JSON.stringify(new URL("../src/cli/telegram-run.ts", import.meta.url).href) + ';',
  'await (' + check.toString() + ')(runTelegramChannel, ' + JSON.stringify(childArgs) + ', assert);',
  'console.log("lifetime assertions complete");',
 ].join("\n");
 const child = Bun.spawn([process.execPath, "--no-env-file", "--eval", script], {
  env: {}, stdout: "pipe", stderr: "pipe",
 });
 let timedOut = false;
 const safety = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 3500);
 try {
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  assert.equal(timedOut, false, "Lifetime child exceeded deadline\n" + err);
  assert.equal(code, 0, err);
  assert.equal(out.trim(), "lifetime assertions complete");
 } finally {
  clearTimeout(safety);
  if (child.exitCode === null) child.kill("SIGKILL");
  await child.exited;
 }
}

describe("Telegram run lifetime", () => {
 for (const first of ["SIGTERM", "SIGINT"] as const) {
  test(`parses exact args, waits for ${first} and stops once with listeners cleaned`, async () => {
   // Pass the order as data, not a closure captured by the serialized callback.
   await isolatedLifetime(async (runTelegramChannel, args, assert: typeof import("node:assert/strict")) => {
    const first = args.pop() as "SIGTERM" | "SIGINT";
    const before = [process.listeners("SIGTERM"), process.listeners("SIGINT")];
    let stops = 0;
    let configSeen: unknown;
    await runTelegramChannel(args, config => {
     configSeen = config;
     return { name: "telegram", commandPolicy: "none", url: () => new URL("http://127.0.0.1"), health: () => ({ polling_failed: 0 }), async start() {
      // Keep startup pending until both real OS signals have been delivered:
      // otherwise the first can remove handlers before the second arrives.
      for (const signal of [first, first === "SIGTERM" ? "SIGINT" : "SIGTERM"] as const) {
       await new Promise<void>(resolve => {
        process.once(signal, resolve);
        process.kill(process.pid, signal);
       });
       assert.equal(stops, 0);
      }
     }, async stop() { stops++; } };
    });
    assert.deepEqual(configSeen, { mode: "polling", botTokenFile: "/private/token", pairingPath: "/private/pairing", databasePath: "/private/jobs", port: 8791 });
    assert.equal(stops, 1);
    assert.deepEqual([process.listeners("SIGTERM"), process.listeners("SIGINT")], before);
   }, [...args, first]);
  });
 }
 test("unhealthy polling produces finite rejection and one stop", async () => {
  await isolatedLifetime(async (runTelegramChannel, args, assert: typeof import("node:assert/strict")) => {
   const before = [process.listeners("SIGTERM"), process.listeners("SIGINT")];
   let stops = 0;
   const started = Date.now();
   await assert.rejects(runTelegramChannel(args, () => ({ name: "telegram", commandPolicy: "none", url: () => new URL("http://127.0.0.1"), health: () => ({ polling_failed: 1 }), async start() {}, async stop() { stops++; } })), /Telegram channel unavailable/);
   assert.ok(Date.now() - started < 2500);
   assert.equal(stops, 1);
   assert.deepEqual([process.listeners("SIGTERM"), process.listeners("SIGINT")], before);
  });
 });
 test("stopped durable handler health is terminal without polling failure", async () => {
  await isolatedLifetime(async (runTelegramChannel, args, assert: typeof import("node:assert/strict")) => {
   const before = [process.listeners("SIGTERM"), process.listeners("SIGINT")];
   let stops = 0;
   const started = Date.now();
   await assert.rejects(runTelegramChannel(args, () => ({ name: "telegram", commandPolicy: "none", url: () => new URL("http://127.0.0.1"), health: () => ({ running: 0, polling_failed: 0 }), async start() {}, async stop() { stops++; } })), /Telegram channel unavailable/);
   assert.ok(Date.now() - started < 2500);
   assert.equal(stops, 1);
   assert.deepEqual([process.listeners("SIGTERM"), process.listeners("SIGINT")], before);
  });
 });
 test("startup failure is sanitized and cleans up once", async () => {
  await isolatedLifetime(async (runTelegramChannel, args, assert: typeof import("node:assert/strict")) => {
   const before = [process.listeners("SIGTERM"), process.listeners("SIGINT")];
   let stops = 0;
   await assert.rejects(runTelegramChannel(args, () => ({ name: "telegram", commandPolicy: "none", url: () => new URL("http://127.0.0.1"), health: () => ({}), async start() { throw new Error("token URL raw"); }, async stop() { stops++; } })), { message: "Telegram channel unavailable" });
   assert.equal(stops, 1);
   assert.deepEqual([process.listeners("SIGTERM"), process.listeners("SIGINT")], before);
  });
 });
 test("scheduler flags pass exact validated values to the channel config, and only when given", async () => {
  const seen: unknown[] = [];
  const capture = (config: unknown) => { seen.push(config); throw new Error("stop after capture"); };
  for (const extra of [["--concurrency", "1"], ["--concurrency", "16"], ["--scheduler-mode", "topic"], ["--scheduler-mode", "global"], ["--scheduler-mode", "global", "--concurrency", "1"], ["--concurrency", "8", "--scheduler-mode", "topic"], ["--progress", "status", "--steering", "off"], ["--progress", "detailed"], ["--steering", "on"]]) {
   await expect(runTelegramChannel([...args, ...extra], capture as never)).rejects.toThrow("Telegram channel initialization failed");
  }
  const base = { mode: "polling", botTokenFile: "/private/token", pairingPath: "/private/pairing", databasePath: "/private/jobs", port: 8791 };
  expect(seen).toEqual([
   { ...base, concurrency: 1 }, { ...base, concurrency: 16 }, { ...base, schedulerMode: "topic" }, { ...base, schedulerMode: "global" },
   { ...base, schedulerMode: "global", concurrency: 1 }, { ...base, schedulerMode: "topic", concurrency: 8 },
   { ...base, progress: "status", steering: "off" }, { ...base, progress: "detailed" }, { ...base, steering: "on" },
  ]);
 });
 test("rejects malformed scheduler flags before creating channel", async () => {
  const bad = [["--concurrency", "0"], ["--concurrency", "17"], ["--concurrency", "01"], ["--concurrency", "+4"], ["--concurrency", "4.0"], ["--concurrency", "1e1"], ["--concurrency", " 4"], ["--concurrency", "-1"], ["--concurrency", ""],
   ["--scheduler-mode", "lanes"], ["--scheduler-mode", "Topic"], ["--scheduler-mode", "global", "--concurrency", "4"], ["--concurrency", "2", "--scheduler-mode", "global"],
   ["--concurrency", "2", "--concurrency", "2"], ["--scheduler-mode", "topic", "--scheduler-mode", "topic"], ["--concurrency"],
   ["--progress", "verbose"], ["--progress", "Detailed"], ["--steering", "true"], ["--steering", ""], ["--steering"]];
  for (const extra of bad) {
   let called = false;
   await expect(runTelegramChannel([...args, ...extra], () => { called = true; throw new Error(); })).rejects.toThrow(/Invalid Telegram run|Missing Telegram run/);
   expect(called).toBe(false);
  }
 });
 test("rejects malformed CLI before creating channel", async () => {
  for (const bad of [[], [...args, "--unknown", "x"], [...args, "--port", "22"], args.slice(0, -1), [...args.slice(0, -1), "65536"]]) {
   let called = false;
   await expect(runTelegramChannel(bad, () => { called = true; throw new Error(); })).rejects.toThrow();
   expect(called).toBe(false);
  }
 });
});
