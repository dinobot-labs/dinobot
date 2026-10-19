import { readBounded, retryDelay } from "./messaging.ts";

export type SlackSocketOptions = { appToken: string; receive(payload: unknown): number; receiveInteractive?: (payload: unknown) => number; requestTimeoutMs?: number };
/** Test-only injection: never populate from channel configuration. */
export type SlackSocketDependencies = { apiBase?: string; reconnectMs?: number; maxConnectionMs?: number };
const FRAME_LIMIT = 262144;
const ID_LIMIT = 256;

/** One owned loop: opening -> awaiting hello -> connected -> backoff. No HTTP ingress.
 * receive is a synchronous durable-admission boundary; ACK must happen strictly after it returns.
 */
export function createSlackSocket(options: SlackSocketOptions, dependencies: SlackSocketDependencies = {}) {
 const timeout = options.requestTimeoutMs ?? 10000;
 if (!options.appToken.startsWith("xapp-") || !Number.isFinite(timeout) || timeout < 1 || timeout > 30000) throw new Error("Invalid Slack Socket Mode options");
 const api = new URL(dependencies.apiBase ?? "https://slack.com/api");
 const local = dependencies.apiBase !== undefined && api.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(api.hostname);
 if (!local && (api.protocol !== "https:" || api.hostname !== "slack.com" || api.port)) throw new Error("Invalid Slack Socket Mode endpoint");
 if (api.username || api.password || api.search || api.hash) throw new Error("Invalid Slack Socket Mode endpoint");
 const baseDelay = Math.max(1, Math.min(30000, dependencies.reconnectMs ?? 250));
 const lifetime = Math.max(1, Math.min(60000, dependencies.maxConnectionMs ?? 60000));
 let controller: AbortController | undefined, loop: Promise<void> | undefined, starting: Promise<void> | undefined;
 let connected = 0, retryAt = 0;
 const counts = { socket_opens: 0, socket_acks: 0, socket_refused: 0, socket_invalid: 0, socket_failures: 0 };
 const wait = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
  if (signal.aborted) return resolve();
  const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
  const timer = setTimeout(done, Math.min(60000, ms));
  signal.addEventListener("abort", done, { once: true });
 });
 async function open(signal: AbortSignal): Promise<string> {
  const bound = new AbortController();
  const abort = () => bound.abort();
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeout);
  try {
   signal.throwIfAborted();
   const response = await fetch((api.href.endsWith("/") ? api.href.slice(0, -1) : api.href) + "/apps.connections.open", {
    method: "POST", redirect: "error", headers: { authorization: "Bearer " + options.appToken }, signal: bound.signal,
   });
   if (response.status === 429) retryAt = Math.max(retryAt, Date.now() + retryDelay(response.headers.get("retry-after")));
   const body = await readBounded(response, 16384, bound.signal);
   const data = JSON.parse(body);
   if (!response.ok || data?.ok !== true || typeof data.url !== "string" || data.url.length > 8192) throw new Error();
   const url = new URL(data.url);
   const slack = url.protocol === "wss:" && !url.port && (url.hostname === "wss-primary.slack.com" || url.hostname.endsWith(".slack.com"));
   const fixture = local && url.protocol === "ws:" && url.host === api.host;
   if ((!slack && !fixture) || url.username || url.password || url.hash) throw new Error();
   return url.href;
  } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
 }
 function connection(url: string, signal: AbortSignal, ready: () => void): Promise<boolean> {
  return new Promise((resolve, reject) => {
   signal.throwIfAborted();
   const socket = new WebSocket(url);
   socket.binaryType = "arraybuffer";
   let hello = false, ending = false;
   let age: ReturnType<typeof setTimeout> | undefined;
   const handshake = setTimeout(end, timeout);
   // A bounded unconditional rotation also detects half-open/dead peers without relying on
   // browser WebSocket ping support. Slack retries unacknowledged envelopes on the next connection.
   function end() {
    if (ending) return;
    ending = true; connected = 0;
    socket.terminate(); // Bun: hard close, including a stalled handshake; onclose owns settlement.
   }
   function closed() {
    clearTimeout(handshake); clearTimeout(age);
    signal.removeEventListener("abort", end);
    socket.onmessage = socket.onclose = socket.onerror = null;
    connected = 0;
    if (hello || signal.aborted) resolve(hello); else reject(new Error("Slack Socket Mode handshake failed"));
   }
   signal.addEventListener("abort", end, { once: true });
   socket.onclose = closed;
   socket.onerror = end;
   socket.onmessage = event => {
    if (ending || signal.aborted) return;
    if (typeof event.data !== "string" || Buffer.byteLength(event.data) > FRAME_LIMIT) { counts.socket_invalid++; end(); return; }
    let frame: any;
    try { frame = JSON.parse(event.data); } catch { counts.socket_invalid++; end(); return; }
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) { counts.socket_invalid++; end(); return; }
    if (frame.type === "disconnect") { end(); return; }
    if (frame.type === "hello") {
     if (!hello) { hello = true; connected = 1; clearTimeout(handshake); age = setTimeout(end, lifetime); ready(); }
     return;
    }
    if (!hello || typeof frame.envelope_id !== "string" || !frame.envelope_id.length || Buffer.byteLength(frame.envelope_id) > ID_LIMIT || /[\x00-\x1f]/.test(frame.envelope_id)) { counts.socket_invalid++; end(); return; }
    let status = 200;
    if (frame.type === "events_api") {
     try { status = options.receive(frame.payload); } catch { status = 500; }
    }
    if (frame.type === "interactive" && options.receiveInteractive) {
     try { status = options.receiveInteractive(frame.payload); } catch { status = 500; }
    }
    if (!Number.isFinite(status) || status >= 500) { counts.socket_refused++; return; }
    if (signal.aborted || ending) return;
    try {
     // Do not accumulate ACKs against a stalled transport.
     if (socket.bufferedAmount > FRAME_LIMIT) { end(); return; }
     socket.send(JSON.stringify({ envelope_id: frame.envelope_id })); counts.socket_acks++;
    } catch { end(); }
   };
  });
 }
 return {
  start(): Promise<void> {
   if (starting) return starting;
   controller = new AbortController();
   const signal = controller.signal;
   let ready!: () => void;
   const readiness = new Promise<void>(resolve => { ready = resolve; });
   let established = false;
   loop = (async () => {
    let backoff = baseDelay;
    while (!signal.aborted) {
     while (!signal.aborted && Date.now() < retryAt) await wait(retryAt - Date.now(), signal);
     if (signal.aborted) break;
     const began = Date.now();
     try {
      const url = await open(signal);
      counts.socket_opens++;
      await connection(url, signal, () => { established = true; ready(); });
     } catch {
      counts.socket_failures++;
      if (!established) throw new Error("Slack Socket Mode startup failed");
     }
     if (signal.aborted) break;
     if (Date.now() - began >= 30000) backoff = baseDelay;
     await wait(backoff, signal);
     backoff = Math.min(30000, backoff * 2);
    }
    if (!established) throw new Error("Slack Socket Mode startup stopped");
   })();
   const owned = loop;
   // Both race branches are owned by stop; startup failure has already drained resources.
   starting = Promise.race([readiness, owned]).catch(() => {
    if (loop === owned) { loop = undefined; starting = undefined; controller = undefined; }
    throw new Error("Slack Socket Mode startup failed");
   });
   return starting;
  },
  async stop(): Promise<void> {
   const owned = loop;
   controller?.abort();
   await owned?.catch(() => {});
   if (loop === owned) { loop = undefined; starting = undefined; controller = undefined; }
  },
  health(): Record<string, number> { return { ...counts, socket_connected: connected, socket_running: controller && !controller.signal.aborted ? 1 : 0 }; },
 };
}
