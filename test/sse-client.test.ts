import { describe, expect, test } from "bun:test";
import { ApiClient, HttpError } from "../src/tui/client.ts";
import { streamSse, type SseTiming } from "../src/tui/sse.ts";
import { createChatData, reduceEvent } from "../src/tui/state.ts";

const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const sse = (text: string) => new Response(text, { headers: { "content-type": "text/event-stream" } });
const subscriptions = ["events", "conversationEvents", "sessionsEvents"] as const;
function subscribe(client: ApiClient, kind: typeof subscriptions[number], callback: (event: any) => void, signal: AbortSignal) {
  return kind === "events" ? client.events("tui", "main", callback, signal) : kind === "conversationEvents" ? client.conversationEvents(1, callback, signal) : client.sessionsEvents(callback, signal);
}

describe("read-only SSE recovery", () => {
  for (const kind of subscriptions) test(`${kind} reconnects EOF and replaces snapshots without a tight loop`, async () => {
    const times: number[] = [];
    const server = Bun.serve({ port: 0, fetch() { times.push(performance.now()); return sse(frame({ type: "snapshot", messages: [times.length] }) + "data: {partial"); } });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    let state: number[] = [];
    try {
      await subscribe(new ApiClient(server.url), kind, event => { state = event.messages; if (state[0] === 3) controller.abort(); }, controller.signal);
      expect(state).toEqual([3]);
      expect(times).toHaveLength(3);
      expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(220);
      expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(450);
    } finally { clearTimeout(timeout); controller.abort(); await server.stop(true); }
  });

  test("parses comments, split UTF-8, CRLF, and multiline data; callback abort stops buffered frames", async () => {
    const bytes = new TextEncoder().encode(": heartbeat\r\n\r\ndata:{\r\ndata: \"text\":\"한\"}\r\n\r\n" + frame({ text: "late" }));
    const server = Bun.serve({ port: 0, fetch: () => new Response(new ReadableStream({ start(c) { for (const byte of bytes) c.enqueue(new Uint8Array([byte])); c.close(); } })) });
    const controller = new AbortController();
    const seen: unknown[] = [];
    try { await new ApiClient(server.url).conversationEvents(1, e => { seen.push(e); controller.abort(); }, controller.signal); expect(seen).toEqual([{ text: "한" }]); }
    finally { controller.abort(); await server.stop(true); }
  });

  test("transient statuses retry but permanent HTTP and malformed data surface", async () => {
    for (const status of [408, 429, 500, 503]) {
      let calls = 0;
      const server = Bun.serve({ port: 0, fetch: () => ++calls === 1 ? new Response("retry", { status }) : sse(frame({ type: "snapshot" })) });
      const controller = new AbortController();
      try { await new ApiClient(server.url).conversationEvents(1, () => controller.abort(), controller.signal); expect(calls).toBe(2); } finally { controller.abort(); await server.stop(true); }
    }
    for (const response of [new Response("no", { status: 403 }), sse("data: invalid\n\n")]) {
      let calls = 0;
      const server = Bun.serve({ port: 0, fetch: () => { calls++; return response; } });
      try { await expect(new ApiClient(server.url).conversationEvents(1, () => {}, new AbortController().signal)).rejects.toThrow(); expect(calls).toBe(1); } finally { await server.stop(true); }
    }
  });

  test("POST command EOF and failed messages execute once", async () => {
    let calls = 0;
    const server = Bun.serve({ port: 0, fetch: req => { calls++; return req.url.endsWith("/messages") ? new Response("no", { status: 503 }) : sse(frame({ type: "done" })); } });
    try {
      const client = new ApiClient(server.url);
      await client.runCommand("tui", "main", "help", "", "u", () => {}, new AbortController().signal);
      expect(calls).toBe(1);
      await expect(client.send("tui", "main", "hi", "u")).rejects.toBeInstanceOf(HttpError);
      expect(calls).toBe(2);
    } finally { await server.stop(true); }
  });
});

test("aborting workspace initialization settles only that subscription without cancelling shared initialization", async () => {
  let release!: (response: Response) => void;
  const headers = new Promise<Response>(resolve => { release = resolve; });
  let arrived!: () => void;
  const request = new Promise<void>(resolve => { arrived = resolve; });
  let workspaces = 0, events = 0;
  const server = Bun.serve({ port: 0, fetch(req) {
    if (req.url.endsWith("/workspace")) { workspaces++; arrived(); return headers; }
    events++; return sse(frame({ type: "snapshot" }));
  } });
  const cancelled = new AbortController(); const remaining = new AbortController();
  const client = new ApiClient(server.url, "/tmp");
  let settled = false, stale = 0;
  const first = client.events("tui", "main", () => stale++, cancelled.signal).then(() => { settled = true; });
  const second = client.events("tui", "main", () => remaining.abort(), remaining.signal);
  try {
    await request; cancelled.abort(); await wait(40);
    expect(settled).toBe(true);
    release(Response.json({ cwd: "/tmp" })); await second; await first;
    expect(workspaces).toBe(1); expect(events).toBe(1); expect(stale).toBe(0);
  } finally { cancelled.abort(); remaining.abort(); release(Response.json({ cwd: "/tmp" })); await Promise.allSettled([first, second]); await server.stop(true); }
});

test("watchdog failures do not reset backoff even when idle timeout exceeds healthy duration", async () => {
  const times: number[] = [];
  const server = Bun.serve({ port: 0, fetch() {
    times.push(performance.now());
    return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(frame({ attempt: times.length }))); } }));
  } });
  const controller = new AbortController();
  try {
    await streamSse<{ attempt: number }>(server.url, e => { if (e.attempt === 3) controller.abort(); }, controller.signal, undefined, { initialDelay: 70, maxDelay: 280, idleTimeout: 120, healthyDuration: 50 });
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(180);
    expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(250);
  } finally { controller.abort(); await server.stop(true); }
});

const fast: SseTiming = { initialDelay: 20, maxDelay: 80, healthyDuration: 120, idleTimeout: 100 };
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

test("dropped HTTP connection recovers after server restart with a replacement TUI snapshot", async () => {
  const snapshot = (text: string) => ({ type: "snapshot", entries: [{ id: text, kind: "pi.user", model: [{ role: "user", content: text, timestamp: 1 }] }], agent: {}, usage: { models: {} }, tools: [] });
  let release!: () => void;
  const received = new Promise<void>(resolve => { release = resolve; });
  let server = Bun.serve({ port: 0, fetch: () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(frame(snapshot("old")))); } })) });
  const url = new URL(server.url);
  const controller = new AbortController();
  const state = createChatData();
  let count = 0;
  const pending = new ApiClient(url).events("tui", "main", event => { reduceEvent(state, event, Date.now()); count++; release(); if (count === 2) controller.abort(); }, controller.signal);
  try {
    await received;
    await server.stop(true);
    await wait(320); // Includes at least one refused connection before the listener returns.
    server = Bun.serve({ port: Number(url.port), fetch: () => sse(frame(snapshot("new"))) });
    await pending;
    expect(count).toBe(2);
    expect(state.blocks.map(block => "text" in block ? block.text : "")).toEqual(["new"]);
  } finally { controller.abort(); await pending; await server.stop(true); }
});

test("abort during backoff, in-flight body, headers, or before starting never retries or delivers", async () => {
  for (const mode of ["backoff", "body", "headers", "pre"] as const) {
    let calls = 0;
    let received!: () => void;
    const request = new Promise<void>(resolve => { received = resolve; });
    let release!: (r: Response) => void;
    const headers = new Promise<Response>(resolve => { release = resolve; });
    const server = Bun.serve({ port: 0, fetch() { calls++; received(); return mode === "headers" ? headers : mode === "body" ? new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(": heartbeat\n\n")); } })) : sse(""); } });
    const controller = new AbortController();
    if (mode === "pre") controller.abort();
    let delivered = 0;
    const pending = new ApiClient(server.url).conversationEvents(1, () => delivered++, controller.signal);
    try {
      if (mode !== "pre") { await request; await wait(20); controller.abort(); }
      await pending;
      release(sse(frame({ type: "snapshot" })));
      await wait(280);
      expect(calls).toBe(mode === "pre" ? 0 : 1);
      expect(delivered).toBe(0);
    } finally { controller.abort(); release(sse("")); await server.stop(true); }
  }
});

test("callback exceptions including TypeError surface unchanged without retry", async () => {
  let calls = 0;
  const error = new TypeError("consumer failed");
  const server = Bun.serve({ port: 0, fetch: () => { calls++; return sse(frame({ type: "snapshot" })); } });
  try { await expect(new ApiClient(server.url).conversationEvents(1, () => { throw error; }, new AbortController().signal)).rejects.toBe(error); expect(calls).toBe(1); }
  finally { await server.stop(true); }
});

test("command POST transport/status failures are never retried", async () => {
  for (const status of [429, 503]) {
    let calls = 0;
    const server = Bun.serve({ port: 0, fetch: () => { calls++; return new Response("retry", { status }); } });
    try { await expect(new ApiClient(server.url).runCommand("tui", "main", "x", "", "u", () => {}, new AbortController().signal)).rejects.toBeInstanceOf(HttpError); expect(calls).toBe(1); }
    finally { await server.stop(true); }
  }
});

test("watchdog bounds header and byte-idle stalls, with a single active connection", async () => {
  for (const mode of ["headers", "body"] as const) {
    let calls = 0, active = 0, peak = 0;
    const releases: Array<() => void> = [];
    const server = Bun.serve({ port: 0, fetch(req) {
      calls++; active++; peak = Math.max(peak, active);
      let done = false;
      const finish = () => { if (!done) { done = true; active--; } };
      req.signal.addEventListener("abort", finish, { once: true });
      if (calls === 2) { finish(); return sse(frame({ ok: true })); }
      if (mode === "headers") return new Promise<Response>(resolve => { releases.push(() => resolve(sse(""))); });
      return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(": ready\n\n")); }, cancel: finish }));
    } });
    const controller = new AbortController();
    const start = performance.now();
    try {
      await streamSse(server.url, () => controller.abort(), controller.signal, undefined, fast);
      expect(calls).toBe(2);
      expect(peak).toBe(1);
      expect(performance.now() - start).toBeGreaterThanOrEqual(100);
      await wait(150);
      expect(calls).toBe(2);
    } finally { controller.abort(); for (const release of releases) release(); await server.stop(true); }
  }
});

test("heartbeat bytes keep the watchdog alive; backoff caps and resets only after a healthy stream", async () => {
  const times: number[] = [];
  let interval: ReturnType<typeof setInterval> | undefined;
  let close: ReturnType<typeof setTimeout> | undefined;
  const server = Bun.serve({ port: 0, fetch() {
    times.push(performance.now());
    if (times.length !== 5) return sse(frame({ attempt: times.length }));
    return new Response(new ReadableStream({ start(c) {
      c.enqueue(new TextEncoder().encode(": heartbeat\n\n"));
      interval = setInterval(() => c.enqueue(new TextEncoder().encode(": heartbeat\n\n")), 25);
      close = setTimeout(() => { clearInterval(interval); c.close(); }, 180);
    }, cancel() { clearInterval(interval); clearTimeout(close); } }));
  } });
  const controller = new AbortController();
  try {
    await streamSse<{ attempt: number }>(server.url, event => { if (event.attempt === 7) controller.abort(); }, controller.signal, undefined, fast);
    const gaps = times.slice(1).map((time, i) => time - times[i]!);
    expect(times).toHaveLength(7);
    expect(gaps[0]!).toBeGreaterThanOrEqual(18);
    expect(gaps[1]!).toBeGreaterThanOrEqual(38);
    expect(gaps[2]!).toBeGreaterThanOrEqual(78);
    expect(gaps[3]!).toBeGreaterThanOrEqual(78);
    expect(gaps[3]!).toBeLessThan(150);
    expect(gaps[4]!).toBeGreaterThanOrEqual(195); // healthy 180ms + reset 20ms
    expect(gaps[4]!).toBeLessThan(250);
    expect(gaps[5]!).toBeGreaterThanOrEqual(38);
    expect(gaps[5]!).toBeLessThan(100);
  } finally { controller.abort(); clearInterval(interval); clearTimeout(close); await server.stop(true); }
});


test("dropped POST command stream and message connection are attempted once", async () => {
  for (const mode of ["command", "message"] as const) {
    let calls = 0;
    let received!: () => void;
    const request = new Promise<void>(resolve => { received = resolve; });
    let release!: (response: Response) => void;
    const headers = new Promise<Response>(resolve => { release = resolve; });
    const server = Bun.serve({ port: 0, fetch() {
      calls++;
      if (mode === "message") { received(); return headers; }
      return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(frame({ type: "text", text: "started" }))); } }));
    } });
    const controller = new AbortController();
    const client = new ApiClient(server.url);
    const pending = (mode === "command" ? client.runCommand("tui", "main", "x", "", "u", received, controller.signal) : client.send("tui", "main", "x", "u")).then(() => null, error => error);
    try {
      await request;
      await server.stop(true);
      expect(await pending).toBeInstanceOf(Error);
      expect(calls).toBe(1);
    } finally { controller.abort(); release(new Response(null, { status: 204 })); await server.stop(true); }
  }
});
