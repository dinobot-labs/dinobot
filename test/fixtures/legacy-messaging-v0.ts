// Frozen copy of src/channels/messaging.ts at commit 93851c2 (schema v0, global FIFO), used only by tests
// to create genuine legacy inbox databases and to prove that a pre-ADR0048 binary refuses a migrated database.
// Do not edit: it stands in for the old deployed binary.
/** Durable native-channel transport. One database and one worker per adapter.
 * Handler must be idempotent by (channel, threadKey, messageId), including after restart.
 * Databases contain user text and Discord interaction tokens: keep on private local storage.
 */
import { Database } from "bun:sqlite";
import { chmodSync } from "node:fs";
import { Type } from "@earendil-works/pi-ai";
import type { Static } from "typebox";
import { minutes, type ProgressOutcome } from "../../src/channels/progress.ts";
import type { BotReply, ChannelAdapter, InboundMessage, MessageHandler, ProgressSink } from "../../src/channels/types.ts";

/**
 * Live, best-effort view of one turn (ADR 0047). The worker calls `tick` about once a second while the handler runs
 * and awaits `finish` before the reply is stored for delivery. Neither may throw; failures only lose progress, never
 * the reply. Contract (R7): `finish` resolves within PROGRESS_FINISH_BUDGET_MS whatever the platform does; when it
 * resolves, no further platform call is issued and every call issued earlier has settled or been aborted.
 */
export type ProgressReporter = { readonly event: ProgressSink; tick(): Promise<void>; finish(outcome: ProgressOutcome): Promise<void> };

const TICK_MS = 1000;
/** After the deadline aborts a handler, it gets this long to settle before the channel fails closed. */
const ABORT_GRACE_MS = 2_000;
/** Budget a reporter's `finish` must meet (ProgressReporter contract). */
export const PROGRESS_FINISH_BUDGET_MS = 6_000;
/** Defensive bound on awaiting `finish`; it exceeds the budget, so a conforming reporter always settles first. */
const FINISH_BOUND_MS = PROGRESS_FINISH_BUDGET_MS + 2_000;

/** Delivered instead of silence when a turn fails, so the user knows it stopped and can resend. */
export function failureNotice(reason: string): string {
 return `⚠️ 작업을 끝내지 못했습니다: ${reason}\n다시 보내 주세요. 같은 대화에서 이어서 처리합니다.`;
}

export const messagingProperties = {
 port: Type.Integer({ minimum: 0, maximum: 65535 }),
 databasePath: Type.String({ minLength: 1 }),
 allowedUserIds: Type.Array(Type.String({ pattern: "^[0-9]+$" }), { minItems: 1, maxItems: 1000, uniqueItems: true }),
 maxRows: Type.Optional(Type.Integer({ minimum: 1, maximum: 100000 })),
 retentionSeconds: Type.Optional(Type.Integer({ minimum: 600, maximum: 2592000 })),
 requestTimeoutMs: Type.Optional(Type.Integer({ minimum: 50, maximum: 30000 })),
 handlerTimeoutMs: Type.Optional(Type.Integer({ minimum: 50, maximum: 3600000 })),
 maxAttempts: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
 maxResponseBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 262144 })),
};
const CommonSchema = Type.Object(messagingProperties);
export type MessagingConfig = Static<typeof CommonSchema>;
export type Admission = { message: InboundMessage; target: Record<string, string>; expires?: number; trustedReply?: string };
export type Receive = { status: number; body?: unknown; admission?: Admission };
export type Delivery = { url: string; init: RequestInit; idempotent: boolean };
export type MessagingPlatform = {
 name: string;
 polling?: { check(signal: AbortSignal): Promise<void>; run(context: PollingContext): Promise<void> };
 storageIdentity: string;
 admissionTimeoutMs: number;
 replaySafe: boolean;
 authorizeStored(message: InboundMessage, target: Record<string, string>): boolean;
 retryAfter(body: string): string | null;
 receive(request: Request, body: Uint8Array): Receive;
 render(text: string): string[];
 delivery(target: Record<string, string>, part: string): Delivery;
 success(response: Response, body: string): boolean;
 /** Optional live progress for one stored target; absent platforms show nothing until the reply. */
 progress?(target: Record<string, string>): ProgressReporter | undefined;
};
type Row = { id: string; message: string; target: string; state: string; created: number; expires: number; parts: string | null; progress: number; attempts: number; due: number; error: string | null };
export type MessagingChannel = ChannelAdapter & { readonly commandPolicy: "none"; url(): URL; health(): Record<string, number> };
export type PollingContext = { signal: AbortSignal; cursor(): number; admit(result: Receive, nextOffset: number): boolean; fail(status: number): void };
export type MessagingDependencies = { /** Test-only injection, not accepted in YAML. */ apiBase?: string };
export function requiredEnv(name: string): string {
 const value = process.env[name];
 if (!value) throw new Error("Missing native channel credential environment variable");
 return value;
}
export function chunks(text: string, limit: number): string[] {
 const result: string[] = []; let chunk = "";
 for (const point of text) { if (chunk.length + point.length > limit) { result.push(chunk); chunk = ""; } chunk += point; }
 if (chunk) result.push(chunk);
 return result.length ? result : ["(empty response)"];
}
export function retryDelay(header: string | null, now = Date.now()): number {
 const n = header === null ? 1 : Number(header);
 const ms = Number.isFinite(n) ? n * 1000 : Date.parse(header!) - now;
 // Retry-After is a lower bound. An oversized delay is rejected by admission to
 // the retry budget, never shortened into an early request.
 return Math.max(100, ms === Infinity ? Number.MAX_SAFE_INTEGER : Number.isFinite(ms) ? ms : 1000);
}

export function messagingChannel(config: MessagingConfig, platform: MessagingPlatform): MessagingChannel {
 let db: Database | undefined; let server: ReturnType<typeof Bun.serve> | undefined;
 let stopped = true; let worker: Promise<void> | undefined; let abort: AbortController;
 let receivers = 0; let activeHandler = false; let poller: Promise<void> | undefined; let pollingStatus = 0;
 const maxRows = config.maxRows ?? 10000, retention = (config.retentionSeconds ?? 604800) * 1000;
 const maxAttempts = config.maxAttempts ?? 5, timeout = config.requestTimeoutMs ?? 10000;
 const maxResponse = config.maxResponseBytes ?? 65536;
 let wake: (() => void) | undefined;
 const execute = (sql: string, ...params: (string | number | null)[]) => db!.query(sql).run(...params);
 const dead = (id: string, reason: string) => execute("UPDATE jobs SET state='dead', error=?, target='{}', parts=NULL, message='{}' WHERE id=?", reason, id);
 const retry = (row: Row, reason: string, delay: number) => {
  if (delay > 60000) dead(row.id, "retry_after_exceeds_budget");
  else if (row.attempts >= maxAttempts) dead(row.id, reason);
  else execute("UPDATE jobs SET state='ready', error=?, due=? WHERE id=?", reason, Date.now() + delay, row.id);
 };
 const pause = () => new Promise<void>((resolve) => {
  const timer = setTimeout(done, 100); function done() { clearTimeout(timer); wake = undefined; resolve(); } wake = done;
 });
 const handlerTimeout = config.handlerTimeoutMs ?? 3_600_000;
 /** Runs one turn under the handler deadline. The deadline aborts the turn and waits a bounded grace for it to settle. */
 async function boundedReply(message: InboundMessage, handler: MessageHandler, progress?: ProgressSink): Promise<BotReply> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: () => void = () => {};
  const job = new AbortController();
  const deadline = new Promise<never>((_, reject) => {
   onAbort = () => { job.abort(); reject(new Error("stopped")); };
   abort.signal.addEventListener("abort", onAbort, { once: true });
   timer = setTimeout(() => { job.abort(); reject(new Error("handler_timeout")); }, handlerTimeout);
  });
  activeHandler = true;
  const task = Promise.resolve().then(() => {
   if (stopped || abort.signal.aborted) throw new Error("stopped");
   return handler(message, job.signal, progress);
  }).finally(() => { activeHandler = false; });
  try { return await Promise.race([task, deadline]); }
  catch (error) {
   // A cooperative handler settles soon after the abort; only a non-cooperative one keeps the slot.
   if (activeHandler && !abort.signal.aborted) {
    let grace: ReturnType<typeof setTimeout> | undefined; let wake = () => {};
    const waited = new Promise<void>((resolve) => { wake = resolve; grace = setTimeout(resolve, ABORT_GRACE_MS); });
    abort.signal.addEventListener("abort", wake, { once: true });
    await Promise.race([task.catch(() => undefined), waited]);
    clearTimeout(grace); abort.signal.removeEventListener("abort", wake);
   }
   throw error;
  }
  finally { clearTimeout(timer); abort.signal.removeEventListener("abort", onAbort); }
 }
 const failureReason = (error: unknown) =>
  error instanceof Error && error.message === "handler_timeout" ? `제한 시간(${minutes(handlerTimeout)}) 초과`
  : error instanceof Error && error.name === "CoreUnresponsive" ? "core 응답 없음"
  : "처리 중 오류";
 async function settleProgress(reporter: ProgressReporter | undefined, outcome: ProgressOutcome) {
  if (!reporter) return;
  let bound: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([reporter.finish(outcome).catch(() => undefined), new Promise<void>((resolve) => { bound = setTimeout(resolve, FINISH_BOUND_MS); })]);
  clearTimeout(bound);
 }
 async function run(handler: MessageHandler) {
  while (!stopped) {
   // Terminal rows retain only the dedupe receipt until the bounded retention expires.
   execute("DELETE FROM jobs WHERE state IN ('done','dead') AND created < ?", Date.now() - retention);
   // Strict FIFO (including retry waits) keeps chunks and native messages ordered.
   const row = db!.query<Row, []>("SELECT * FROM jobs WHERE state NOT IN ('done','dead') ORDER BY seq LIMIT 1").get();
   if (!row || row.due > Date.now()) { await pause(); continue; }
   if (row.expires && row.expires <= Date.now()) { dead(row.id, "token_expired"); continue; }
   if (!platform.authorizeStored(JSON.parse(row.message), JSON.parse(row.target))) { dead(row.id, "permission_revoked"); continue; }
   if (row.state === "queued") {
    execute("UPDATE jobs SET state='processing' WHERE id=?", row.id);
    let reporter: ProgressReporter | undefined;
    try { reporter = platform.progress?.(JSON.parse(row.target)); } catch { reporter = undefined; }
    const ticker = reporter ? setInterval(() => { void reporter!.tick().catch(() => undefined); }, TICK_MS) : undefined;
    try {
     const reply = await boundedReply(JSON.parse(row.message), handler, reporter?.event);
     clearInterval(ticker);
     if (stopped) break;
     const text = reply.status === "answered" ? reply.text : reply.reason;
     if (typeof text !== "string" || Buffer.byteLength(text) > maxResponse) { await settleProgress(reporter, { kind: "failed", reason: "응답이 너무 김" }); dead(row.id, "response_limit"); continue; }
     await settleProgress(reporter, reply.status === "answered" ? { kind: "done" } : { kind: "failed", reason: "답변 없음" });
     execute("UPDATE jobs SET state='ready', parts=? WHERE id=?", JSON.stringify(platform.render(text)), row.id);
    } catch (error) {
     clearInterval(ticker);
     // A non-cooperative handler must not cause unbounded orphan concurrency.
     const orphaned = activeHandler;
     if (!stopped) {
      const reason = failureReason(error);
      await settleProgress(reporter, { kind: "failed", reason });
      // The user hears that the turn stopped instead of waiting on silence; the receipt keeps the dedupe key.
      execute("UPDATE jobs SET state='ready', parts=?, error='handler_failed_or_timeout' WHERE id=?", JSON.stringify(platform.render(failureNotice(reason))), row.id);
     }
     if (orphaned) { stopped = true; abort.abort(); }
    }
    continue;
   }
   if (row.attempts >= maxAttempts) { dead(row.id, "attempts_exhausted"); continue; }
   const parts = JSON.parse(row.parts!) as string[];
   const delivery = platform.delivery(JSON.parse(row.target), parts[row.progress]!);
   row.attempts++;
   execute("UPDATE jobs SET state='sending', attempts=? WHERE id=?", row.attempts, row.id);
   try {
    const response = await fetch(delivery.url, { ...delivery.init, redirect: "error", signal: AbortSignal.any([abort.signal, AbortSignal.timeout(timeout)]) });
    // Do not load unbounded platform error bodies into memory or expose them in health.
    const body = await readBounded(response, 16384);
    if (stopped) break;
    if (response.status === 429) {
     const header = response.headers.get("retry-after"), hint = platform.retryAfter(body);
     retry(row, "rate_limited", Math.max(retryDelay(header ?? hint), retryDelay(hint ?? header)));
     continue;
    }
    if (response.ok && platform.success(response, body)) {
     if (row.progress + 1 === parts.length) execute("UPDATE jobs SET state='done', target='{}', parts=NULL, message='{}', error=NULL WHERE id=?", row.id);
     else execute("UPDATE jobs SET state='ready', progress=progress+1, attempts=0, due=0 WHERE id=?", row.id);
    } else if (response.status >= 500 && delivery.idempotent) retry(row, "platform_unavailable", 1000);
    else dead(row.id, response.status >= 500 ? "ambiguous_delivery" : "platform_rejected");
   } catch {
    if (stopped) break;
    if (delivery.idempotent) retry(row, "network_failure", 1000);
    else dead(row.id, "ambiguous_delivery");
   }
  }
 }
 // The same durable admission boundary serves webhook and polling. Cursor and job
 // commit together; overload and database exceptions leave the cursor unchanged.
 const admit = (result: Receive, nextOffset?: number): boolean => {
  if (stopped || result.status >= 500) return false;
  return db!.transaction(() => {
   const admission = result.admission;
   if (admission && !db!.query("SELECT id FROM jobs WHERE id=?").get(admission.message.messageId)) {
    if (db!.query<{ count: number }, []>("SELECT count(*) AS count FROM jobs").get()!.count >= maxRows) return false;
    execute("INSERT INTO jobs(id,message,target,state,created,expires,parts) VALUES (?,?,?,?,?,?,?)", admission.message.messageId, JSON.stringify(admission.message), JSON.stringify(admission.target), admission.trustedReply === undefined ? "queued" : "ready", Date.now(), admission.expires ?? 0, admission.trustedReply === undefined ? null : JSON.stringify(platform.render(admission.trustedReply)));
   }
   if (nextOffset !== undefined) execute("UPDATE polling_cursor SET offset=MAX(offset,?) WHERE id=1", nextOffset);
   return true;
  })();
 };
 const health = (): Record<string, number> => {
  const counts: Record<string, number> = { queued: 0, processing: 0, ready: 0, sending: 0, done: 0, dead: 0, unknown: 0 };
  counts.running = stopped ? 0 : 1;
  if (platform.polling) { counts.polling_failed = pollingStatus ? 1 : 0; counts.polling_status = pollingStatus; }
  if (db) for (const row of db.query<{ error: string; count: number }, []>("SELECT error, count(*) AS count FROM jobs WHERE state='dead' GROUP BY error").all()) {
   // Only locally-generated reason codes, never platform bodies or credentials.
   if (row.error === "ambiguous_delivery") counts.unknown = row.count;
   if (["permission_revoked", "retry_after_exceeds_budget", "ack_deadline", "token_expired", "response_limit", "handler_failed_or_timeout", "attempts_exhausted", "ambiguous_delivery", "platform_rejected", "rate_limited", "network_failure", "platform_unavailable"].includes(row.error)) counts["dead_" + row.error] = row.count;
  }
  if (db) for (const row of db.query<{ state: string; count: number }, []>("SELECT state, count(*) AS count FROM jobs GROUP BY state").all()) if (["queued", "processing", "ready", "sending", "done", "dead"].includes(row.state)) counts[row.state] = row.count;
  return counts;
 };
 return {
  name: platform.name, commandPolicy: "none", health,
  storagePaths: Object.freeze([config.databasePath, config.databasePath + "-journal"]),
  url() { if (!server) throw new Error("Channel not started"); return server.url; },
  async start(handler) {
   if (db || activeHandler) throw new Error("Channel already started or handler still active");
   if (config.databasePath === ":memory:") throw new Error("Native channels require persistent storage");
   db = new Database(config.databasePath, { create: true });
   try {
    chmodSync(config.databasePath, 0o600);
    // Exclusive connection ownership prevents two workers sending from the same inbox.
    db.exec("PRAGMA journal_mode=DELETE; PRAGMA locking_mode=EXCLUSIVE; PRAGMA synchronous=FULL; BEGIN EXCLUSIVE; COMMIT;");
    db.exec("CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS jobs (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, message TEXT NOT NULL, target TEXT NOT NULL, state TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL, parts TEXT, progress INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL DEFAULT 0, error TEXT);");
    const owner = db.query<{ name: string }, []>("SELECT name FROM metadata").get();
    if (owner && owner.name !== platform.storageIdentity) throw new Error("Database belongs to another channel");
    if (!owner) execute("INSERT INTO metadata VALUES (?)", platform.storageIdentity);
    execute("UPDATE jobs SET state='queued' WHERE state='processing'");
    if (!platform.replaySafe) execute("UPDATE jobs SET state='dead', error='ambiguous_delivery', target='{}', parts=NULL, message='{}' WHERE state='sending'");
    else execute("UPDATE jobs SET state='ready' WHERE state='sending'");
    abort = new AbortController(); stopped = false; pollingStatus = 0;
    if (platform.polling) {
     db.exec("CREATE TABLE IF NOT EXISTS polling_cursor (id INTEGER PRIMARY KEY CHECK(id=1), offset INTEGER NOT NULL); INSERT OR IGNORE INTO polling_cursor VALUES (1,0)");
     await platform.polling.check(abort.signal);
     poller = platform.polling.run({ signal: abort.signal, cursor: () => db!.query<{ offset: number }, []>("SELECT offset FROM polling_cursor WHERE id=1").get()!.offset, admit,
      fail(status) { pollingStatus = status; stopped = true; abort.abort(); wake?.(); },
     }).catch(() => { pollingStatus = pollingStatus || 500; stopped = true; abort.abort(); wake?.(); });
    } else server = Bun.serve({ hostname: "127.0.0.1", port: config.port, maxRequestBodySize: 65536, idleTimeout: 10,
     async fetch(request) {
      if (new URL(request.url).pathname === "/healthz" && request.method === "GET") return Response.json(health(), { status: stopped ? 503 : 200 });
      if (stopped) return new Response(null, { status: 503 });
      if (new URL(request.url).pathname !== "/webhook" || request.method !== "POST") return new Response(null, { status: 404 });
      if (receivers >= 32) return new Response(null, { status: 503 });
      receivers++;
      const deadline = Date.now() + Math.min(timeout, platform.admissionTimeoutMs);
      try {
       const body = await readBoundedBytes(request, 65536, AbortSignal.any([abort.signal, AbortSignal.timeout(Math.min(timeout, platform.admissionTimeoutMs))]));
       if (stopped) return new Response(null, { status: 503 });
       const result = platform.receive(request, body);
       if (Date.now() >= deadline) return new Response(null, { status: 503 });
       if (!admit(result) || Date.now() >= deadline) return new Response(null, { status: 503, headers: { "Retry-After": "1" } });
       // SQLite FULL synchronous commit above is complete before acknowledging admission.
       return result.body === undefined ? new Response(null, { status: result.status }) : Response.json(result.body, { status: result.status });
      } catch { return new Response(null, { status: 400 }); }
      finally { receivers--; }
     },
    });
    worker = run(handler).catch(() => { stopped = true; abort.abort(); wake?.(); });
   } catch (error) { stopped = true; abort?.abort(); db.close(); db = undefined; throw error; }
  },
  async stop() {
   stopped = true; abort?.abort(); wake?.();
   await server?.stop(true); await poller; await worker;
   poller = undefined;
   server = undefined; worker = undefined; db?.close(); db = undefined;
  },
 };
}
export async function readBounded(source: Request | Response, limit: number, signal?: AbortSignal): Promise<string> {
 return (await readBoundedBytes(source, limit, signal)).toString("utf8");
}

/** Authentication consumes original bytes, never decoded and re-encoded replacement text. */
async function readBoundedBytes(source: Request | Response, limit: number, signal?: AbortSignal): Promise<Buffer> {
 signal?.throwIfAborted();
 const reader = source.body?.getReader(); if (!reader) return Buffer.alloc(0);
 const chunks: Uint8Array[] = []; let size = 0;
 const cancel = () => { void reader.cancel().catch(() => {}); };
 signal?.addEventListener("abort", cancel, { once: true });
 try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > limit) throw new Error("body_limit"); chunks.push(value); } }
 finally { signal?.removeEventListener("abort", cancel); await reader.cancel().catch(() => {}); reader.releaseLock(); }
 if (signal?.aborted) throw new Error("body_timeout");
 return Buffer.concat(chunks);
}
