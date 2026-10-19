import { expect, test } from "bun:test";
import { sseStream } from "../src/api/sse.ts";
import { ApiClient } from "../src/tui/client.ts";
import { connect } from "node:net";
import type { SseController } from "../src/api/sse.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openBot } from "../src/core/bot.ts";
import { startClientApi } from "../src/api/server.ts";

// Regression: the former strict 8MiB cap errored both initial and reconnect snapshots.
test("real HTTP reconnect reconstructs complete >8MiB snapshots and ordered following frames", async () => {
 const payload = "x".repeat(8 * 1024 * 1024 + 1) + "한😀end";
 let connections = 0; let cleanups = 0;
 const server = Bun.serve({ port: 0, fetch() {
  const version = ++connections; let sent = false;
  return new Response(sseStream({
   start(c) { c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({type:"snapshot", version, payload})}\n\n`)); },
   pull(c) { if (!sent) { sent = true; c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({type:"delta", version})}\n\n`)); c.close(); } },
   cancel() { cleanups++; },
  }), { headers: { "content-type": "text/event-stream" } });
 }});
 const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 8000);
 const seen: string[] = [];
 try {
  await new ApiClient(server.url).conversationEvents(1, (raw) => {
   const event = raw as unknown as {type:string; version:number; payload?:string};
   if (event.type === "snapshot") expect(event.payload).toBe(payload);
   seen.push(`${event.type}:${event.version}`);
   if (seen.length === 4) abort.abort();
  }, abort.signal);
  expect(seen).toEqual(["snapshot:1", "delta:1", "snapshot:2", "delta:2"]);
  expect(connections).toBe(2); expect(cleanups).toBe(2);
 } finally { clearTimeout(timer); abort.abort(); await server.stop(true); }
}, 12000);

// A paused real TCP reader must neither pull another source frame nor prevent cleanup.
test("slow HTTP reader cancellation releases large frame and stops ingress exactly once", async () => {
 let c!: SseController; let pulls = 0; let stops = 0;
 const server = Bun.serve({ port: 0, fetch() {
  return new Response(sseStream({
   start(controller) { c = controller; c.enqueue(new TextEncoder().encode("data: " + JSON.stringify({type:"snapshot", payload:"x".repeat(32 * 1024 * 1024)}) + "\n\n")); },
   pull() { pulls++; }, cancel() { stops++; },
  }), {headers:{"content-type":"text/event-stream"}});
 }});
 const socket = connect({port: server.port!, host:"127.0.0.1"});
 try {
  await new Promise<void>((resolve, reject) => {
   socket.once("error", reject);
   socket.once("connect", () => socket.write("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n"));
   socket.once("data", () => { socket.pause(); resolve(); });
  });
  await Bun.sleep(50);
  expect(pulls).toBe(0); expect(c.desiredSize).toBe(0); expect(stops).toBe(0);
  const drained = c.drained();
  socket.destroy();
  for (let n = 0; n < 200 && !stops; n++) await Bun.sleep(5);
  expect(stops).toBe(1); await drained;
  c.enqueue(new Uint8Array(1)); c.close(); c.error("late");
  expect(stops).toBe(1); expect(pulls).toBe(0);
 } finally { socket.destroy(); await server.stop(true); }
}, 5000);

test("large pending frame rejects subsequent pushes instead of accumulating source data", async () => {
 let c!: SseController; let stops = 0;
 const stream = sseStream({start(controller) {c = controller; c.enqueue(new Uint8Array(129));}, cancel() {stops++;}}, {maxQueuedBytes:64, heartbeatMs:2});
 const waiting = c.drained();
 await Bun.sleep(10); expect(c.desiredSize).toBe(0); expect(stops).toBe(0);
 c.enqueue(new Uint8Array(1));
 await expect(stream.getReader().read()).rejects.toThrow("queue limit");
 await waiting; expect(stops).toBe(1);
});

test("production thread and conversation routes recover full large transcript then deliver new entries", async () => {
 const dir = await mkdtemp(join(tmpdir(), "sse-large-"));
 const bot = await openBot({storage: await openNodeSqliteStorage(join(dir,"bot.sqlite")), models:createModels(), defaultModel:{provider:"unused",modelId:"unused"}, toolMode:"direct", plugins:[]}, context);
 const api = startClientApi(bot, 0, context, {list: () => [], find: () => undefined, answer: () => false, run() {throw new Error("commands unused");}});
 const payload = "x".repeat(8 * 1024 * 1024 + 1) + "한😀";
 try {
  const conversation = await bot.conversation("tui", "large", context);
  const entries = await bot.harness.commit(async tx => [
   await tx.appendEntry(conversation.id, {kind:"test.large",data:payload}),
   await tx.appendEntry(conversation.id, {kind:"test.tail",data:"tail"}),
  ], context);
  const client = new ApiClient(api.url);
  for (const route of ["thread", "conversation"] as const) {
   const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 4000);
   const seen: string[] = []; let commit: Promise<unknown> | undefined;
   try {
    const callback = (event: import("../src/core/ui-contract.ts").ClientEvent) => {
     seen.push(event.type);
     if (event.type === "snapshot") {
      expect(event.entries).toEqual(entries);
      expect(event).toHaveProperty("queue"); expect(event).toHaveProperty("workflow"); expect(event).toHaveProperty("dag");
      commit = bot.harness.commit(async tx => {entries.push(await tx.appendEntry(conversation.id,{kind:"test.delta",data:route}));}, context);
     }
     if (event.type === "entry_appended") {expect(event.entry.data).toBe(route); abort.abort();}
    };
    if (route === "thread") await client.events("tui","large",callback,abort.signal);
    else await client.conversationEvents(conversation.id,callback,abort.signal);
    await commit;
    expect(seen[0]).toBe("snapshot"); expect(seen.at(-1)).toBe("entry_appended");
   } finally { clearTimeout(timer); abort.abort(); }
  }
 } finally {await api.stop(); await bot.close(context); await rm(dir,{recursive:true,force:true});}
}, 10000);
