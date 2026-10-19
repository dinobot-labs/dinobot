import { expect, test } from "bun:test";
import { httpChannel } from "../src/channels/http.ts";
import { createTelegramForwarder } from "../src/cli/telegram-run.ts";
import type { InboundMessage, MessageHandler } from "../src/channels/types.ts";
const message: InboundMessage = { channel: "telegram", threadKey: "1:-22:3:4", messageId: "987", userId: "4", text: "/models" };
const ok = { status: "answered", text: "native" } as const;
function post(url: URL, body: unknown, path = "/v1/native/messages") {
 return fetch(new URL(path, url), { method: "POST", body: JSON.stringify(body) });
}
test("native HTTP is opt-in and legacy 404 gives upgrade answer without fallback", async () => {
 const channel = httpChannel(0); let calls = 0;
 await channel.start(async () => { calls++; return ok; });
 try {
  expect((await post(channel.url(), message)).status).toBe(404);
  for (const text of ["/model", "/models", "/model provider/id"]) {
   const reply = await createTelegramForwarder(channel.url().origin)({ ...message, text });
   expect(reply.status).toBe("answered"); expect("text" in reply && reply.text).toMatch(/upgrade/i);
  }
  expect(calls).toBe(0);
 } finally { await channel.stop(); }
});
test("native HTTP admits only native channels and exact model command boundaries", async () => {
 const channel = httpChannel(0); const seen: InboundMessage[] = []; let generic = 0;
 await channel.start(async () => { generic++; return ok; }, async (input, signal) => {
  expect(signal).toBeInstanceOf(AbortSignal); seen.push(input); return ok;
 });
 try {
  expect(channel.url().hostname).toBe("127.0.0.1");
  for (const channelName of ["telegram", "discord", "slack"]) for (const text of ["/model", "/models", "/model provider/id", "/models\tprovider 2"]) {
   const input = { ...message, channel: channelName, text };
   expect((await post(channel.url(), input)).status).toBe(200); expect(seen.at(-1)).toEqual(input);
  }
  const count = seen.length;
  for (const text of ["/login", "/logout", "/modelx", "/modelsx", "/model/foo", " /model", "hello"]) expect((await post(channel.url(), { ...message, text })).status).toBe(400);
  for (const channelName of ["http", "teams", "", "a:b"]) expect((await post(channel.url(), { ...message, channel: channelName })).status).toBe(400);
  for (const input of [null, {}, { ...message, text: "/model " + "x".repeat(65536) }, { ...message, images: [{}] }]) expect((await post(channel.url(), input)).status).toBe(400);
  expect(seen.length).toBe(count); expect(generic).toBe(0);
  const forward = createTelegramForwarder(channel.url().origin);
  expect(await forward(message)).toEqual(ok); expect(seen.at(-1)).toEqual(message);
  await forward({ ...message, text: "/login" }); expect(generic).toBe(1);
 } finally { await channel.stop(); }
});
test("fake core sees narrow path, raw model text and preserved identity", async () => {
 const seen: { path: string; body: unknown }[] = [];
 const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  seen.push({ path: new URL(request.url).pathname, body: await request.json() }); return Response.json(ok);
 } });
 try {
  const forward = createTelegramForwarder(server.url.origin);
  for (const text of ["/models", "/model p/id", "/login", "/modelsExtra", "/model@bot"]) {
   await forward({ ...message, text });
   const native = text === "/models" || text === "/model p/id";
   expect(seen.at(-1)).toEqual({ path: native ? "/v1/native/messages" : "/v1/messages", body: { ...message, text: native ? text : "Telegram message:\n" + text } });
  }
 } finally { await server.stop(true); }
});
test("native and ordinary HTTP share the 32 active admission budget", async () => {
 const channel = httpChannel(0); let calls = 0; let release!: () => void;
 const gate = new Promise<void>(resolve => { release = resolve; });
 const handler: MessageHandler = async () => { calls++; await gate; return ok; };
 await channel.start(handler, handler);
 const pending: Promise<Response>[] = [];
 try {
  for (let i = 0; i < 32; i++) pending.push(post(channel.url(), message, i % 2 ? "/v1/messages" : "/v1/native/messages"));
  for (let i = 0; calls < 32 && i < 200; i++) await Bun.sleep(5);
  expect(calls).toBe(32);
  for (const path of ["/v1/messages", "/v1/native/messages"]) {
   const response = await post(channel.url(), message, path); expect(response.status).toBe(503); expect(response.headers.get("retry-after")).toBe("1");
  }
 } finally { release(); await Promise.allSettled(pending); await channel.stop(); }
});
test("native replies have bounded JSON reads and cancel stalled bodies", async () => {
 let body = "{}"; let stalled = false;
 const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => stalled
  ? new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("{")); } }))
  : new Response(body) });
 try {
  const forward = createTelegramForwarder(server.url.origin);
  for (const invalid of ["null", "{broken", JSON.stringify({ status: "answered", text: "x".repeat(65537) }), " ".repeat(65536 * 6 + 1025)]) {
   body = invalid; await expect(forward(message)).rejects.toThrow(/^Telegram core request failed$/);
  }
  body = JSON.stringify({ status: "answered", text: "x".repeat(65536) });
  expect(await forward(message)).toEqual({ status: "answered", text: "x".repeat(65536) });
  const prior = new AbortController(); prior.abort();
  await expect(forward(message, prior.signal)).rejects.toThrow(/^Telegram core request failed$/);
  stalled = true;
  const active = new AbortController(); const pending = forward(message, active.signal);
  const timer = setTimeout(() => active.abort(), 30);
  try { await expect(pending).rejects.toThrow(/^Telegram core request failed$/); } finally { clearTimeout(timer); }
 } finally { await server.stop(true); }
});
test("native handler errors are sanitized and do not invoke generic handler", async () => {
 const channel = httpChannel(0); let generic = 0;
 await channel.start(async () => { generic++; return ok; }, async () => { throw new Error("private-token"); });
 try {
  const response = await post(channel.url(), message); expect(response.status).toBe(503); expect(await response.text()).not.toContain("private-token");
  await expect(createTelegramForwarder(channel.url().origin)(message)).rejects.toThrow(/^Telegram core request failed$/);
  expect(generic).toBe(0);
 } finally { await channel.stop(); }
});
