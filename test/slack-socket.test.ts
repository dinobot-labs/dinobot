import { describe, expect, test } from "bun:test";
import { createSlackSocket } from "../src/channels/slack-socket.ts";
import type { ServerWebSocket } from "bun";

async function until(check: () => boolean, ms = 2000) {
 const end = Date.now() + ms;
 while (!check()) { if (Date.now() >= end) throw new Error("condition timed out"); await Bun.sleep(5); }
}
function fixture(config: { hello?: boolean; api?: (request: Request, base: string) => Response | Promise<Response> } = {}) {
 const peers = new Set<ServerWebSocket<undefined>>();
 const acks: string[] = [], auth: string[] = [];
 let opens = 0;
 const server = Bun.serve<undefined>({ hostname: "127.0.0.1", port: 0,
  async fetch(request, server) {
   if (new URL(request.url).pathname === "/ws") {
    if (server.upgrade(request, { data: undefined })) return;
    return new Response(null, { status: 400 });
   }
   opens++; auth.push(request.headers.get("authorization") ?? "");
   expect(request.method).toBe("POST");
   expect(new URL(request.url).pathname).toBe("/api/apps.connections.open");
   return config.api ? config.api(request, server.url.origin) : Response.json({ ok: true, url: server.url.origin.replace("http:", "ws:") + "/ws" });
  },
  websocket: {
   open(ws) { peers.add(ws); if (config.hello !== false) ws.send(JSON.stringify({ type: "hello" })); },
   message(_ws, value) { acks.push(String(value)); },
   close(ws) { peers.delete(ws); },
  },
 });
 return { server, peers, acks, auth, get opens() { return opens; },
  send(value: unknown) { for (const ws of peers) ws.send(JSON.stringify(value)); },
  raw(value: string) { for (const ws of peers) ws.send(value); },
  socket(receive: (payload: unknown) => number = () => 200, extra = {}) { return createSlackSocket({ appToken: "xapp-test", receive, requestTimeoutMs: 100 }, { apiBase: server.url.origin + "/api", reconnectMs: 10, ...extra }); },
  async close() { await server.stop(true); },
 };
}
const envelope = (id: string, payload: unknown = {}) => ({ type: "events_api", envelope_id: id, payload });

describe("Slack Socket Mode transport", () => {
 test("opens authenticated; hello readiness; admission commits before ACK, rejection/throw never ACK", async () => {
  const f = fixture(); let calls = 0;
  const socket = f.socket(payload => {
   expect(f.acks).toHaveLength(0); calls++;
   if (payload === "fail") throw new Error("private");
   return payload === "overload" ? 503 : 200;
  });
  try {
   await socket.start(); expect(socket.health().socket_connected).toBe(1);
   expect(f.auth).toEqual(["Bearer xapp-test"]);
   f.send(envelope("busy", "overload")); f.send(envelope("failed", "fail")); f.send(envelope("committed"));
   await until(() => f.acks.length === 1);
   expect(calls).toBe(3); expect(JSON.parse(f.acks[0]!)).toEqual({ envelope_id: "committed" });
   f.send({ type: "interactive", envelope_id: "ignored" });
   await until(() => f.acks.length === 2); expect(calls).toBe(3);
   expect(socket.health().socket_refused).toBe(2);
  } finally { await socket.stop(); await f.close(); }
 });
 test("disconnect and remote close reconnect; stop drains and prevents new opens", async () => {
  const f = fixture(), socket = f.socket();
  try {
   await socket.start(); f.send({ type: "disconnect" });
   await until(() => f.opens >= 2 && socket.health().socket_connected === 1);
   for (const peer of f.peers) peer.close();
   await until(() => f.opens >= 3 && socket.health().socket_connected === 1);
   await socket.stop(); await until(() => f.peers.size === 0);
   const before = f.opens; await Bun.sleep(80); expect(f.opens).toBe(before);
   expect(socket.health().socket_running).toBe(0);
  } finally { await socket.stop(); await f.close(); }
 });
 test("malformed, oversized and unbounded IDs close without delivery or ACK", async () => {
  const f = fixture(); let received = 0; const socket = f.socket(() => { received++; return 200; });
  try {
   await socket.start();
   for (const raw of ["{", JSON.stringify(envelope("x".repeat(257))), "x".repeat(262145)]) {
    const before = f.opens; f.raw(raw);
    await until(() => f.opens > before && socket.health().socket_connected === 1);
   }
   expect(received).toBe(0); expect(f.acks).toHaveLength(0); expect(socket.health().socket_invalid).toBe(3);
  } finally { await socket.stop(); await f.close(); }
 });
 test("bounded hello failure cleans resources and restart works", async () => {
  const f = fixture({ hello: false }), socket = f.socket();
  try {
   await expect(socket.start()).rejects.toThrow("startup failed");
   await until(() => f.peers.size === 0); expect(socket.health().socket_running).toBe(0);
   const starting = socket.start(); await until(() => f.peers.size === 1);
   f.send({ type: "hello" }); await starting;
  } finally { await socket.stop(); await f.close(); }
 });
 test("safe periodic rotation detects silent connections", async () => {
  const f = fixture(), socket = f.socket(undefined, { maxConnectionMs: 30 });
  try { await socket.start(); await until(() => f.opens >= 2); }
  finally { await socket.stop(); await f.close(); }
 });
 test("429 Retry-After lower bound survives failed startup and cancellation interrupts wait", async () => {
  const f = fixture({ api: () => new Response("{}", { status: 429, headers: { "Retry-After": "1" } }) });
  const socket = f.socket();
  try {
   await expect(socket.start()).rejects.toThrow();
   const restarted = socket.start().catch(() => {});
   await Bun.sleep(60); expect(f.opens).toBe(1);
   await socket.stop(); await restarted;
   await Bun.sleep(60); expect(f.opens).toBe(1);
  } finally { await socket.stop(); await f.close(); }
 });
 test("reconnect honors API 429 before issuing the next open", async () => {
  let requests = 0, limitedAt = 0, resumedAt = 0;
  const f = fixture({ api: (_request, base) => {
   requests++;
   if (requests === 2) { limitedAt = Date.now(); return new Response("{}", { status: 429, headers: { "retry-after": "1" } }); }
   if (requests === 3) resumedAt = Date.now();
   return Response.json({ ok: true, url: base.replace("http:", "ws:") + "/ws" });
  } });
  const socket = f.socket();
  try {
   await socket.start(); f.send({ type: "disconnect" });
   await until(() => requests >= 3); expect(resumedAt - limitedAt).toBeGreaterThanOrEqual(1000);
  } finally { await socket.stop(); await f.close(); }
 });
 test("stop during hello handshake settles startup and socket", async () => {
  const f = fixture({ hello: false }), socket = f.socket();
  try {
   const started = socket.start().catch(() => {}); await until(() => f.peers.size === 1);
   await socket.stop(); await started; await until(() => f.peers.size === 0);
   expect(socket.health().socket_running).toBe(0);
  } finally { await socket.stop(); await f.close(); }
 });
 test("stop cancels in-flight API and reconnect backoff", async () => {
  const f = fixture({ api: () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"ok":')); } })) });
  const socket = f.socket();
  try {
   const starting = socket.start().catch(() => {}); await until(() => f.opens === 1);
   await socket.stop(); await starting; expect(socket.health().socket_running).toBe(0);
  } finally { await socket.stop(); await f.close(); }
  const g = fixture(), other = g.socket(undefined, { reconnectMs: 200 });
  try {
   await other.start(); g.send({ type: "disconnect" }); await until(() => other.health().socket_connected === 0);
   await other.stop(); await Bun.sleep(250); expect(g.opens).toBe(1);
  } finally { await other.stop(); await g.close(); }
 });
 test("rejects unsafe socket URLs and bounded API responses", async () => {
  for (const body of [JSON.stringify({ ok: true, url: "ws://example.com/secret" }), JSON.stringify({ ok: true, url: "wss://slack.com.attacker.test/" }), "x".repeat(16385)]) {
   const f = fixture({ api: () => new Response(body) }), socket = f.socket();
   try { await expect(socket.start()).rejects.toThrow("startup failed"); expect(f.peers.size).toBe(0); }
   finally { await socket.stop(); await f.close(); }
  }
 });
});

test("I5 Socket interactive routes admission before ACK and retries failures",async()=>{
 const f=fixture();let calls=0;
 const socket=createSlackSocket({appToken:"xapp-test",receive:()=>{throw Error("wrong route");},receiveInteractive:payload=>{calls++;return payload==="fail"?500:200;},requestTimeoutMs:100},{apiBase:f.server.url.origin+"/api",reconnectMs:10});
 try{await socket.start();f.send({type:"interactive",envelope_id:"fail",payload:"fail"});f.send({type:"interactive",envelope_id:"ok",payload:{}});await until(()=>f.acks.length===1);expect(calls).toBe(2);expect(JSON.parse(f.acks[0]!)).toEqual({envelope_id:"ok"});expect(socket.health().socket_refused).toBe(1);}finally{await socket.stop();await f.close();}
});