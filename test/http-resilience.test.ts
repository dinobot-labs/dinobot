import { expect, test } from "bun:test";
import { httpChannel } from "../src/channels/http.ts";

const message = { threadKey: "t", messageId: "m", userId: "u", text: "hello" };
function post(url: URL, body: unknown) { return fetch(new URL("/v1/messages", url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); }

test("HTTP binds loopback, rejects ambiguous channel identity and contains handler errors", async () => {
 const channel = httpChannel(0); let calls = 0;
 await channel.start(async () => { calls++; throw new Error("secret-provider-details"); });
 try {
  expect(channel.url().hostname).toBe("127.0.0.1");
  expect((await post(channel.url(), { ...message, channel: "a:b" })).status).toBe(400);
  expect(calls).toBe(0);
  const response = await post(channel.url(), message);
  expect(response.status).toBe(503); expect(await response.text()).not.toContain("secret-provider-details");
  expect((await fetch(new URL("/healthz", channel.url()))).status).toBe(200);
 } finally { await channel.stop(); }
});

/** Starts a channel whose handler waits for its turn signal; resolves how long after the client went away it aborted. */
async function abortAfterDisconnect(streaming: boolean): Promise<{ aborted: boolean; settledSlots: boolean; channel: ReturnType<typeof httpChannel> }> {
 const channel = httpChannel(0);
 let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
 let aborted!: (value: boolean) => void; const outcome = new Promise<boolean>(resolve => { aborted = resolve; });
 await channel.start(async (_message, signal) => {
  entered();
  const timer = setTimeout(() => aborted(false), 3_000);
  await new Promise<void>(resolve => {
   if (signal?.aborted) return resolve();
   signal?.addEventListener("abort", () => resolve(), { once: true });
   setTimeout(resolve, 3_000);
  });
  clearTimeout(timer);
  aborted(signal?.aborted === true);
  return { status: "answered", text: "late" };
 });
 const client = new AbortController();
 const response = fetch(new URL("/v1/messages", channel.url()), {
  method: "POST", signal: client.signal,
  headers: { "content-type": "application/json", ...(streaming ? { accept: "application/x-ndjson" } : {}) },
  body: JSON.stringify(message),
 });
 await started;
 if (streaming) {
  const reader = (await response).body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain("heartbeat");
 }
 client.abort();
 await response.catch(() => undefined);
 const result = await outcome;
 // The admitted slot is released once the turn settles, so a fresh request is admitted again.
 await Bun.sleep(20);
 const health = await fetch(new URL("/healthz", channel.url()));
 return { aborted: result, settledSlots: health.status === 200, channel };
}

test("HTTP NDJSON client disconnect aborts the running turn instead of leaving it running", async () => {
 const { aborted, settledSlots, channel } = await abortAfterDisconnect(true);
 try { expect(aborted).toBe(true); expect(settledSlots).toBe(true); } finally { await channel.stop(); }
});

test("HTTP JSON client disconnect aborts the running turn", async () => {
 const { aborted, channel } = await abortAfterDisconnect(false);
 try { expect(aborted).toBe(true); } finally { await channel.stop(); }
});

test("HTTP refuses double start and bounds concurrent handlers before admission", async () => {
 const channel = httpChannel(0); let release!: () => void; let count = 0;
 const gate = new Promise<void>(resolve => { release = resolve; });
 await channel.start(async () => { count++; await gate; return { status: "answered", text: "ok" }; });
 const pending: Promise<Response>[] = [];
 try {
  await expect(channel.start(async () => ({ status: "answered", text: "bad" }))).rejects.toThrow("already started");
  for (let i = 0; i < 32; i++) pending.push(post(channel.url(), { ...message, messageId: String(i) }));
  for (let i = 0; count < 32 && i < 200; i++) await Bun.sleep(5);
  expect(count).toBe(32);
  const overload = await post(channel.url(), message);
  expect(overload.status).toBe(503); expect(overload.headers.get("retry-after")).toBe("1");
  expect(count).toBe(32);
 } finally { release(); await Promise.allSettled(pending); await channel.stop(); }
 await channel.stop();
});
