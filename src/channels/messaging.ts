/** Durable native-channel transport. One database and one owner (event-loop reducer) per adapter.
 * Handler must be idempotent by (channel, threadKey, messageId), including after restart.
 * Databases contain user text and Discord interaction tokens: keep on private local storage.
 *
 * Scheduling (ADR 0048): every job belongs to one lane; only the lane head (minimum live seq) may run, at most
 * `concurrency` quanta (one handler call or one delivery chunk) are unsettled at once, and ready lanes rotate
 * round-robin. Generic platforms use a single global lane with concurrency 1 (strict FIFO, ADR 0042).
 */
import { Database } from "bun:sqlite";
import { chmodSync } from "node:fs";
import { Type } from "@earendil-works/pi-ai";
import type { Static } from "typebox";
import { ApiGate, notStarted, type ApiPermits, type GatePolicy, type GateClock, type SyncStart } from "./api-gate.ts";
import { sqliteGateStore } from "./api-gate-store.ts";
import type { ProgressOutcome } from "./progress.ts";
import { KeyedScheduler, type LaneHead } from "./scheduler.ts";
import type { AskPrompt, BotReply, ChannelAdapter, HostDeliveryResult, InboundMessage, MessageHandler, ProgressSink } from "./types.ts";

/**
 * Live, best-effort view of one turn (ADR 0047). The worker calls `tick` about once a second while the handler runs
 * (never two ticks at once) and awaits `finish` before the reply is stored for delivery. Neither may throw; failures
 * only lose progress, never the reply. Contract (R7): `finish` resolves within PROGRESS_FINISH_BUDGET_MS whatever the
 * platform does; when it resolves, no further platform call is issued and every call issued earlier has settled or
 * been aborted. Resolution of `finish` is a time bound, not raw-operation settlement: an aborted request may still be
 * outstanding, so the slot of the turn is held until `finish`, every tick and every raw platform operation reported
 * through the `track` hook of `MessagingPlatform.progress` have actually settled.
 */
export type ProgressReporter = { readonly event: ProgressSink; tick(): Promise<void>; finish(outcome: ProgressOutcome): Promise<void> };

const TICK_MS = 1000;
/** Budget a reporter's `finish` must meet (ProgressReporter contract). */
export const PROGRESS_FINISH_BUDGET_MS = 6_000;
/** Defensive bound on awaiting `finish` before storing the reply; the slot still waits for the real settlement. */
const FINISH_BOUND_MS = PROGRESS_FINISH_BUDGET_MS + 2_000;
/** Inbox schema written by this build. The owner row doubles as a fence: pre-0048 binaries see a foreign owner.
 * Version 2 adds the durable API gate (permits and cooldown); a version-1 build, which would ignore a persisted
 * cooldown, refuses a version-2 inbox instead of bypassing it. Version 4 adds the `answer` column (ADR 0057): a build
 * without it would deliver one shared answer once per input. Version 5 fences attachment references: older readers
 * would silently submit only their placeholder/caption, without resolving private media targets. */
// Version 6 fences persistent native cooldowns and marked delivery recovery from older readers.
// Version 7 fences generic kind:file references: v6 readers reject them after acknowledging the job.
export const INBOX_SCHEMA_VERSION = 7;
const FENCE = /^inbox-schema:([0-9]{1,9}):([\s\S]*)$/;
/** Rows (or lanes) loaded into memory per startup page; never the whole table. */
export const STARTUP_PAGE = 256;
/** Finite reducer work per event-loop turn; the remainder continues from a zero-delay wake. */
const PUMP_BATCH = 64;
const GC_BATCH = 256;
const GC_INTERVAL_MS = 60_000;
/** Cap for one wake timer; a later due is re-armed when it fires. */
const MAX_WAKE_MS = 60_000;
export const MAX_CONCURRENCY = 16;
/** Steer executions attached to one lane's running handler (ADR 0057 S1). */
export const MAX_STEERS = 4;
/** A lane whose head is a row a steer execution owns is parked this long; the steer's settlement re-derives the head earlier. */
const STEER_PARK_MS = 60_000;

const LIVE = "state NOT IN ('done','dead')";
/** Indexed statements of the hot path (EXPLAIN QUERY PLAN is asserted in tests). */
export const SCHEDULER_SQL = {
 nextHead: `SELECT seq, due, created FROM jobs WHERE lane=? AND ${LIVE} ORDER BY seq LIMIT 1`,
 expire: `DELETE FROM jobs WHERE seq IN (SELECT seq FROM jobs WHERE state IN ('done','dead') AND terminal_at < ? ORDER BY terminal_at, seq LIMIT ?) RETURNING state, error`,
 headsPage: "SELECT l.lane AS lane, l.head AS seq, j.due AS due, j.created AS created FROM lanes l JOIN jobs j ON j.seq=l.head WHERE l.head > ? ORDER BY l.head LIMIT ?",
 unkeyedPage: `SELECT seq, message, target FROM jobs WHERE lane IS NULL AND ${LIVE} AND seq > ? ORDER BY seq LIMIT ?`,
 permitsPage: "SELECT seq, at, rate_key FROM api_permits WHERE seq > ? ORDER BY seq LIMIT ?",
 prunePermits: "DELETE FROM api_permits WHERE at <= ?",
} as const;

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
 /** @deprecated Accepted for legacy manifests only; ignored. Handlers have no lifetime deadline. */
 handlerTimeoutMs: Type.Optional(Type.Integer({ minimum: 50, maximum: 3600000, deprecated: true, description: "Deprecated and ignored: handlers have no application lifetime deadline." })),
 maxAttempts: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
 maxResponseBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 262144 })),
};
const CommonSchema = Type.Object(messagingProperties);
export type MessagingConfig = Static<typeof CommonSchema>;
export type Admission = { message: InboundMessage; target: Record<string, string>; expires?: number; trustedReply?: string; trustedAsks?: readonly AskPrompt[]; /** Durable answer entry the trusted reply carries (ADR 0057 delivery dedupe). */ answer?: number };
export type Receive = { status: number; body?: unknown; admission?: Admission };
export type Delivery = { url: string; init: RequestInit; idempotent: boolean; execute?: (signal: AbortSignal) => Promise<Response> };
/** Shared outbound gate of a platform (ADR 0048 §5): `key` is the write-rate key of a stored target (Telegram: chat). */
export type PlatformGate = { readonly policy: GatePolicy; readonly clock?: GateClock | undefined; readonly afterReserve?: (() => void) | undefined; readonly afterSending?: (() => void) | undefined; key(target: Record<string, string>): string };
/**
 * Execution lanes: the one strategy point that distinguishes global FIFO from per-destination FIFO.
 * `policy` names the lane function; persisted lanes are recomputed at startup when it changes.
 * `lane` returns undefined for a target it cannot route (never guessed from free-form keys).
 */
export type LanePolicy = {
 readonly policy: string; readonly concurrency: number; lane(message: InboundMessage, target: Record<string, string>): string | undefined;
 /** ADR 0057: whether `message`, queued behind the running handler of `active` in the same lane, may join its turn as a
  * steer. Absent: no steering. Telegram: the same thread key, i.e. the same core conversation. */
 steer?(message: InboundMessage, active: InboundMessage): boolean;
};
export const GLOBAL_LANES: LanePolicy = Object.freeze({ policy: "global", concurrency: 1, lane: () => "global" });
export type MessagingPlatform = {
 /** Native adapter-local rate target shared by progress and final sends. */
 cooldown?: import("./native-cooldown.ts").NativeCooldown;
 name: string;
 /** Awaited once per start, after transport validation and before ingress. stop owns cancellation and drain. */
 startup?(signal: AbortSignal, permits?: ApiPermits): Promise<void>;
 /** Adapter-local sanitized numeric diagnostics. */
 health?(): Record<string, number>;
 /** `permits` is the shared API gate when the platform declares one; every polling request needs a permit. */
 polling?: { check(signal: AbortSignal, permits?: ApiPermits): Promise<void>; run(context: PollingContext): Promise<void> };
 storageIdentity: string;
 admissionTimeoutMs: number;
 replaySafe: boolean;
 /** Explicit at-least-once reply policy. Never replays the handler; uncertain chunks carry a visible marker. */
 recovery?: { maxAgeMs: number; maxDelayMs: number; mark(part: string): string[] };
 /** Absent: GLOBAL_LANES. */
 scheduling?: LanePolicy;
 /** Absent: no shared API gate (Discord, Slack, generic). Present: final chunks, progress and polling all need permits;
  * a delayed final permit leaves the engine slot and the lane retries at the permit time. */
 gate?: PlatformGate;
 authorizeStored(message: InboundMessage, target: Record<string, string>): boolean;
 /** Resolve adapter-private attachment references only after stored authorization. The execution owns and awaits
  * the entire operation; failures may return a visible reply without invoking the model. */
 prepare?(message: InboundMessage, target: Record<string, string>, signal: AbortSignal, permits?: ApiPermits): Promise<InboundMessage | BotReply>;
 retryAfter(body: string): string | null;
 receive(request: Request, body: Uint8Array): Receive;
 render(text: string, asks?: readonly import("./types.ts").AskPrompt[]): string[];
 /** ADR 0096: the stored destination of a thread key, for answers the user did not request by a message (a woken
  * orchestrator turn). Absent, or undefined for a key it cannot route (Discord interaction tokens expire): such an
  * answer stays in the conversation. The route must pass `authorizeStored` like an admitted message. */
 hostRoute?(threadKey: string): { message: Pick<InboundMessage, "channel" | "threadKey" | "userId">; target: Record<string, string> } | undefined;
 delivery(target: Record<string, string>, part: string): Delivery;
 success(response: Response, body: string): boolean;
 /** Optional live progress for one stored target; `stop` aborts every platform call when the channel stops.
  * Every raw platform operation the reporter issues must be passed to `track` when issued: the execution keeps its
  * slot (and stop() stays pending) until each such original promise settles, even after abort.
  * `permits` is the shared API gate when the platform declares one: every progress call needs a permit first. */
 progress?(target: Record<string, string>, stop: AbortSignal, track: (operation: Promise<unknown>) => void, permits?: ApiPermits): ProgressReporter | undefined;
};
type State = "queued" | "processing" | "ready" | "sending" | "done" | "dead";
type Row = { seq: number; id: string; message: string; target: string; state: State; created: number; expires: number; parts: string | null; progress: number; attempts: number; due: number; error: string | null; lane: string | null; terminal_at: number | null; answer: number | null };
export type CancelResult = "cancelled" | "not_queued" | "unknown" | "unavailable";
export type MessagingChannel = ChannelAdapter & {
 readonly commandPolicy: "none"; url(): URL; health(): Record<string, number>;
 /** Internal authenticated transport boundary, never exposed by HTTP. ACK only after this commits. */
 admitAuthenticated?(result: Receive): number;
 /** Owner-serialized queued cancellation: a dead/cancelled_queued tombstone that keeps the receipt (ADR 0048 §7).
  * Optional so that test doubles and non-durable adapters need not implement it. */
 cancelQueued?(messageId: string): CancelResult;
};
export type PollingContext = { signal: AbortSignal; cursor(): number; admit(result: Receive, nextOffset: number): boolean; fail(status: number): void; permits?: ApiPermits };
export type MessagingDependencies = {
 /** Test-only injection, not accepted in YAML. */ apiBase?: string;
 /** Test-only, not accepted in YAML: an explicitly scaled gate policy so fixtures can check the same inequalities
  * quickly. Never inferred from apiBase; absent means the production policy. */
 gatePolicy?: GatePolicy;
 /** Test-only issuance boundaries; never read from channel configuration. */
 gateClock?: GateClock;
 afterGateReserve?: () => void;
 afterSendingCommit?: () => void;
};
export function requiredEnv(name: string): string {
 const value = process.env[name];
 if (!value) throw new Error("Missing native channel credential environment variable");
 return value;
}
export function chunks(text: string, limit: number): string[] {
 const result: string[] = []; let chunk = "";
 const segments = new Intl.Segmenter(undefined, {granularity:"grapheme"}).segment(text);
 for (const {segment} of segments) {
  const units = segment.length <= limit ? [segment] : [...segment];
  for (const point of units) { if (chunk.length + point.length > limit) { if (chunk) result.push(chunk); chunk = ""; } chunk += point; }
 }
 if (chunk) result.push(chunk);
 return result.length ? result : ["(empty response)"];
}
export function retryDelay(header: string | null, now = Date.now()): number {
 const n = header === null ? 1 : Number(header);
 if (n === Infinity && header !== null && /^\+?\d+(?:\.\d*)?(?:e[+-]?\d+)?$/i.test(header.trim())) return Number.MAX_SAFE_INTEGER;
 const ms = Number.isFinite(n) ? n * 1000 : Date.parse(header!) - now;
 // Retry-After is a lower bound. An oversized delay is rejected by admission to
 // the retry budget, never shortened into an early request.
 return Math.max(100, ms === Infinity ? Number.MAX_SAFE_INTEGER : Number.isFinite(ms) ? ms : 1000);
}
/** A 429 lower bound from the Retry-After header and the body hint: the larger valid one wins (never shortened). */
export function rateLimitDelay(header: string | null, hint: string | null, now = Date.now()): number {
 return Math.max(retryDelay(header ?? hint, now), retryDelay(hint ?? header, now));
}

/** RFC 9110 IMF-fixdate only: Date.parse alone accepts junk such as "1,5" and would turn it into a blocking bound. */
const HTTP_DATE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;
/** Telegram shared physical waits: exact upward decimal conversion; dates without a trusted server duration block. */
export function telegramRateLimitDelay(header: string | null, hint: string | null): number {
 const parse=(s: string | null): number | undefined=>{
  if(s===null)return undefined;
  const m=/^\+?(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(s.trim());
  // Malformed hints are ignored (a valid companion lower bound still applies);
  // an HTTP date has no trusted server-relative duration and blocks conservatively.
  if(!m) return HTTP_DATE.test(s.trim()) && Number.isFinite(Date.parse(s))?Infinity:undefined;
  const exp=Number(m[3]??0)-(m[2]?.length??0)+3;
  if(!Number.isSafeInteger(exp) || exp>1000 || s.length>4096)return Infinity;
  if(exp< -4096)return 1;
  const coefficient=BigInt(m[1]!+(m[2]??""));
  const n=exp>=0?coefficient*10n**BigInt(exp):(coefficient+10n**BigInt(-exp)-1n)/(10n**BigInt(-exp));
  return n>BigInt(Number.MAX_SAFE_INTEGER)?Infinity:Number(n);
 };
 const a=parse(header),b=parse(hint);
 return Math.max(100,a??b??1000,b??a??1000);
}

/** Locally generated dead-letter reasons exposed in health (never platform bodies or credentials). */
const DEAD_REASONS = new Set(["permission_revoked", "retry_after_exceeds_budget", "ack_deadline", "token_expired", "response_limit", "handler_failed", "handler_failed_or_timeout", "attempts_exhausted", "ambiguous_delivery", "platform_rejected", "rate_limited", "network_failure", "platform_unavailable", "cancelled_queued", "operator_cancelled", "migration_invalid_target"]);
const STATES: readonly State[] = ["queued", "processing", "ready", "sending", "done", "dead"];
const terminalState = (state: string) => state === "done" || state === "dead";

/** Exact row/state counts owned by the single writer: computed once at startup, changed only after commits. */
class Counters {
 rows = 0;
 readonly states = new Map<string, number>();
 readonly dead = new Map<string, number>();
 reset() { this.rows = 0; this.states.clear(); this.dead.clear(); }
 add(state: string, error: string | null, delta: number) {
  this.states.set(state, (this.states.get(state) ?? 0) + delta);
  if (state === "dead") this.dead.set(error ?? "", (this.dead.get(error ?? "") ?? 0) + delta);
 }
 move(from: State, to: State, error: string | null = null) { this.add(from, null, -1); this.add(to, error, 1); }
 state(state: string) { return this.states.get(state) ?? 0; }
}

/** Active execution record: owns one slot from reservation until every original promise it started has settled.
 * `phase`/`message` are set while a handler runs so steers (ADR 0057) can attach; a steer execution owns no slot. */
type Execution = { readonly lane: string; readonly seq: number; readonly controller: AbortController; readonly tracked: Set<Promise<void>>; done?: Promise<void>; phase?: "prepare" | "handler" | "send" | "steer"; message?: InboundMessage };
type Settled<T> = { kind: "value"; value: T } | { kind: "error"; error: unknown } | { kind: "timeout" } | { kind: "stopped" };

export function messagingChannel(config: MessagingConfig, platform: MessagingPlatform): MessagingChannel {
 const scheduling = platform.scheduling ?? GLOBAL_LANES;
 if (!Number.isSafeInteger(scheduling.concurrency) || scheduling.concurrency < 1 || scheduling.concurrency > MAX_CONCURRENCY) throw new RangeError("Invalid scheduler concurrency");
 let db: Database | undefined; let server: ReturnType<typeof Bun.serve> | undefined;
 let stopped = true; let abort = new AbortController(); let starting: Promise<void> | undefined;
 let receivers = 0; let poller: Promise<void> | undefined; let pollingStatus = 0;
 const maxRows = config.maxRows ?? 10000, retention = (config.retentionSeconds ?? 604800) * 1000;
 const maxAttempts = config.maxAttempts ?? 5, timeout = config.requestTimeoutMs ?? 10000;
 const maxResponse = config.maxResponseBytes ?? 65536;
 const counters = new Counters();
 let scheduler = new KeyedScheduler(scheduling.concurrency);
 const executions = new Map<string, Execution>();
 /** Steer executions by row seq (ADR 0057 S2): slot-less, drained by stop() like slot executions. */
 const steers = new Map<number, Execution>();
 let wakeTimer: ReturnType<typeof setTimeout> | undefined; let wakeAt = Infinity;
 let pumping = false; let nextGc = 0;
 // Gate eligibility instant -> scheduler due. Lanes denied on the same gate instant (e.g. topics of one chat waiting on
 // its spacing) must wake in the order they were parked: translating each denial separately mixes two clock samples and
 // a 1 ms jitter could reorder them. Entries expire at their due; pruning is amortized O(1) (size <= parked lanes).
 const gateDues = new Map<number, number>(); let gateDuesLimit = 1024;
 function gateDue(at: number, now: number): number {
  if (!gate) return now + 1;
  const known = gateDues.get(at), due = now + gate.delay(at);
  // Reuse only within clock-sampling jitter: a wall clock stepped backwards must not keep a stale, later due.
  if (known !== undefined && known > now && known <= due + 5) return known;
  if (Number.isFinite(at)) {
   gateDues.set(at, due);
   if (gateDues.size > gateDuesLimit) { for (const [k, d] of gateDues) if (d <= now) gateDues.delete(k); gateDuesLimit = Math.max(1024, 2 * gateDues.size); }
  }
  return due;
 }
 let handler: MessageHandler | undefined;
 /** Shared API gate of this start (platform.gate); kept after stop for health. */
 let gate: ApiGate | undefined;

 const execute = (sql: string, ...params: (string | number | null)[]) => db!.query(sql).run(...params);
 const one = <T>(sql: string, ...params: (string | number | null)[]) => db!.query<T, (string | number | null)[]>(sql).get(...params);

 // ---- durable transitions: the only writers of jobs/lanes state ------------------------------------------------
 /** Re-derive the lane head from the live index inside the caller's transaction and persist it. */
 function advanceHead(lane: string): LaneHead | undefined {
  const next = one<LaneHead>(SCHEDULER_SQL.nextHead, lane);
  if (next) execute("INSERT INTO lanes(lane, head) VALUES (?, ?) ON CONFLICT(lane) DO UPDATE SET head=excluded.head", lane, next.seq);
  else execute("DELETE FROM lanes WHERE lane=?", lane);
  return next ? { seq: next.seq, due: next.due, created: next.created } : undefined;
 }
 /** Terminal transition and head advance in one transaction; payload is erased, the receipt (id/seq/lane) kept. */
 function terminal(row: Pick<Row, "seq" | "lane" | "state">, to: "done" | "dead", error: string | null) {
  const now = Date.now();
  // A steer row's receipt must not drop the demand of the lane's slot execution (its primary may be awaiting a permit).
  if (row.lane && !steers.has(row.seq)) gate?.releaseDemand(row.lane);
  const head = db!.transaction(() => {
   execute("UPDATE jobs SET state=?, error=?, target='{}', parts=NULL, message='{}', terminal_at=? WHERE seq=?", to, error, now, row.seq);
   return advanceHead(row.lane!);
  })();
  counters.move(row.state, to, error);
  scheduler.setHead(row.lane!, head, now);
 }
 /** Non-terminal update of the head row; the head seq is unchanged, only its due may move. */
 function update(row: Row, to: State, sql: string, ...params: (string | number | null)[]) {
  execute(sql, ...params);
  const current = one<{ due: number }>("SELECT due FROM jobs WHERE seq=?", row.seq)!;
  counters.move(row.state, to);
  row.state = to;
  scheduler.setHead(row.lane!, { seq: row.seq, due: current.due, created: row.created }, Date.now());
 }
 /** Non-terminal update of a row that need not be the head (a steer row, ADR 0057 S3): the lane head is re-derived
  * from the live index in the same transaction, so the cache never runs ahead of the database. */
 function updateAside(row: Row, to: State, sql: string, ...params: (string | number | null)[]) {
  const head = db!.transaction(() => { execute(sql, ...params); return advanceHead(row.lane!); })();
  counters.move(row.state, to);
  row.state = to;
  scheduler.setHead(row.lane!, head, Date.now());
 }
 /** `yieldMs` lengthens only the wait (never the budget check): a lower bound may always be exceeded. */
 const retry = (row: Row, reason: string, delay: number, yieldMs = 0) => {
  if (delay > (platform.recovery?.maxDelayMs ?? 60000)) terminal(row, "dead", "retry_after_exceeds_budget");
  else if (platform.recovery && Date.now() + delay - row.created >= platform.recovery.maxAgeMs) terminal(row, "dead", "attempts_exhausted");
  else if (row.attempts >= maxAttempts) terminal(row, "dead", reason);
  else update(row, "ready", "UPDATE jobs SET state='ready', error=?, due=? WHERE seq=?", reason, Date.now() + delay + yieldMs, row.seq);
 };
 function markedParts(row: Row): string {
  const parts = JSON.parse(row.parts!) as string[];
  parts.splice(row.progress, 1, ...platform.recovery!.mark(parts[row.progress]!));
  return JSON.stringify(parts);
 }
 function recoverDelivery(row: Row) {
  if (!platform.recovery) { terminal(row, "dead", "ambiguous_delivery"); return; }
  // Keep the rendered reply and cursor; only delivery is retried, never model/tool work.
  execute("UPDATE jobs SET parts=?, recovery=1 WHERE seq=?", markedParts(row), row.seq);
  retry(row, "ambiguous_delivery", row.attempts <= 1 ? 30000 : 120000);
 }
 function collectGarbage(now: number) {
  nextGc = now + GC_INTERVAL_MS;
  const removed = db!.query<{ state: string; error: string | null }, [number, number]>(SCHEDULER_SQL.expire).all(now - retention, GC_BATCH);
  for (const row of removed) { counters.add(row.state, row.error, -1); counters.rows--; }
  return removed.length;
 }

 // ---- owner reducer --------------------------------------------------------------------------------------------
 /** Fail closed: no admission, dispatch or new platform call; tracked work still drains through stop(). */
 function fatal() { stopped = true; abort.abort(); gate?.close(); clearWake(); }
 function clearWake() { if (wakeTimer) clearTimeout(wakeTimer); wakeTimer = undefined; wakeAt = Infinity; }
 function arm(at: number) {
  if (at >= wakeAt) return;
  clearWake(); wakeAt = at;
  wakeTimer = setTimeout(() => { wakeTimer = undefined; wakeAt = Infinity; pump(); }, Math.max(0, Math.min(MAX_WAKE_MS, at - Date.now())));
 }
 function pump() {
  if (pumping || stopped || !db) return;
  pumping = true;
  try {
   clearWake();
   if (Date.now() >= nextGc) collectGarbage(Date.now());
   for (let budget = PUMP_BATCH; ; budget--) {
    if (stopped) return;
    if (budget <= 0) { arm(Date.now()); return; }
    const lane = scheduler.acquire(Date.now());
    if (lane === undefined) break;
    dispatch(lane);
   }
   const due = scheduler.nextDue();
   arm(Math.min(due ?? Infinity, counters.state("done") + counters.state("dead") > 0 ? nextGc : Infinity));
  } catch { fatal(); }
  finally { pumping = false; }
 }
 /** Settle a lane whose slot never started asynchronous work. */
 const releaseNow = (lane: string) => scheduler.release(lane, Date.now());
 /** The slot for `lane` is reserved; commit the next phase before any I/O or leave the lane. */
 function dispatch(lane: string) {
  const head = scheduler.head(lane)!;
  const row = one<Row>("SELECT * FROM jobs WHERE seq=?", head.seq);
  const now = Date.now();
  if (!row || terminalState(row.state) || row.lane !== lane) {
   // Cache disagreed with the database: re-derive from the index (never run a row that is not the head).
   const fresh = db!.transaction(() => advanceHead(lane))();
   scheduler.setHead(lane, fresh, now); releaseNow(lane); return;
  }
  if (row.due > now) { scheduler.setHead(lane, { seq: row.seq, due: row.due, created: row.created }, now); releaseNow(lane); return; }
  if (row.expires && row.expires <= now) { terminal(row, "dead", "token_expired"); releaseNow(lane); return; }
  if (!platform.authorizeStored(JSON.parse(row.message), JSON.parse(row.target))) { terminal(row, "dead", "permission_revoked"); releaseNow(lane); return; }
  if (row.state === "queued") {
   update(row, "processing", "UPDATE jobs SET state='processing' WHERE seq=?", row.seq);
   begin(lane, row, execution => handlerPhase(execution, row));
   return;
  }
  // The head is a row a steer execution still owns (ADR 0057 S3): park the lane; the steer's settlement re-derives the head.
  if (row.state === "processing" && steers.has(row.seq)) { scheduler.setHead(lane, { seq: row.seq, due: now + STEER_PARK_MS, created: row.created }, now); releaseNow(lane); return; }
  if (row.state !== "ready") throw new Error("unowned in-flight job");
  if (row.attempts >= maxAttempts || (platform.recovery && now - row.created >= platform.recovery.maxAgeMs)) { terminal(row, "dead", "attempts_exhausted"); releaseNow(lane); return; }
  const target = JSON.parse(row.target) as Record<string, string>;
  const remaining = platform.cooldown?.remaining(target) ?? 0;
  if (remaining > 0) { retry(row, "rate_limited", remaining); releaseNow(lane); return; }
  const parts = JSON.parse(row.parts!) as string[];
  const delivery = platform.delivery(target, parts[row.progress]!);
  let installed = false;
  const launch: SyncStart<void> = allowed => {
   row.attempts++;
   update(row, "sending", "UPDATE jobs SET state='sending', attempts=? WHERE seq=?", row.attempts, row.seq);
   platform.gate?.afterSending?.();
   if (stopped || !allowed()) return notStarted();
   let invoked = false;
   installed = true;
   begin(lane, row, execution => {
    const init = {...delivery.init, redirect: "error" as const, signal: AbortSignal.any([execution.controller.signal, AbortSignal.timeout(timeout)])};
    if (stopped || !allowed() || execution.controller.signal.aborted) return Promise.resolve();
    const request = delivery.execute ? delivery.execute(init.signal) : fetch(delivery.url, init);
    track(execution, request); // immediate adoption, before post-start clock/store/continuation
    invoked = true;
    return sendPhase(execution, row, parts, delivery, request);
   });
   return invoked ? {started:true,value:undefined} : notStarted();
  };
  const issued = gate ? gate.final(platform.gate!.key(target), launch, lane) : launch(()=>!stopped);
  if (!issued.started && !installed) {
   if (!stopped && row.state === "ready") { const now = Date.now(); scheduler.setHead(lane, {seq:row.seq,due:Math.max(row.due,gateDue(issued.at, now)),created:row.created},now); }
   releaseNow(lane);
  }
 }

 function track(execution: Execution, promise: Promise<unknown>) {
  const settled = promise.then(() => undefined, () => undefined);
  execution.tracked.add(settled);
  void settled.then(() => execution.tracked.delete(settled));
 }
 function begin(lane: string, row: Row, phase: (execution: Execution) => Promise<void>) {
  const controller = new AbortController();
  const onStop = () => controller.abort();
  abort.signal.addEventListener("abort", onStop, { once: true });
  const execution: Execution = { lane, seq: row.seq, controller, tracked: new Set() };
  executions.set(lane, execution);
  execution.done = (async () => {
   try { await phase(execution); }
   catch { fatal(); }
   finally {
    // The slot is released exactly once, after every original promise of this quantum settled.
    while (execution.tracked.size) await Promise.all([...execution.tracked]);
    abort.signal.removeEventListener("abort", onStop);
    executions.delete(lane);
    if (db) { scheduler.release(lane, Date.now()); pump(); }
   }
  })();
 }
 // ---- steering (ADR 0057) --------------------------------------------------------------------------------------
 /** Queued rows of `lane` behind its running handler that may join that turn start now, oldest first, within MAX_STEERS. */
 function promoteSteers(lane: string) {
  const active = executions.get(lane);
  if (stopped || !db || !scheduling.steer || !active || active.phase !== "handler" || !active.message) return;
  let room = MAX_STEERS;
  for (const execution of steers.values()) if (execution.lane === lane) room--;
  if (room <= 0) return;
  const rows = db.query<Row, [string, number, number]>("SELECT * FROM jobs WHERE lane=? AND state='queued' AND seq>? ORDER BY seq LIMIT ?").all(lane, active.seq, MAX_STEERS);
  const now = Date.now();
  for (const row of rows) {
   if (room <= 0) return;
   if (row.error === "steer_failed" || (row.expires && row.expires <= now)) continue;
   let message: InboundMessage, target: Record<string, string>;
   try { message = JSON.parse(row.message); target = JSON.parse(row.target); } catch { continue; }
   let eligible = false;
   try { eligible = scheduling.steer(message, active.message) && platform.authorizeStored(message, target); } catch { eligible = false; }
   if (!eligible) continue;
   // Media preparation is asynchronous: keep attachment steers FIFO, and do not let a later text pass them.
   if (target.media) break;
   room--;
   updateAside(row, "processing", "UPDATE jobs SET state='processing' WHERE seq=?", row.seq);
   beginSteer(row, message);
  }
 }
 function beginSteer(row: Row, message: InboundMessage) {
  const controller = new AbortController();
  const onStop = () => controller.abort();
  abort.signal.addEventListener("abort", onStop, { once: true });
  const execution: Execution = { lane: row.lane!, seq: row.seq, controller, tracked: new Set(), phase: "steer", message };
  steers.set(row.seq, execution);
  execution.done = (async () => {
   try { await steerPhase(execution, row, message); }
   catch { fatal(); }
   finally {
    while (execution.tracked.size) await Promise.all([...execution.tracked]);
    abort.signal.removeEventListener("abort", onStop);
    steers.delete(row.seq);
    if (db && !stopped) { promoteSteers(row.lane!); pump(); }
   }
  })();
 }
 async function steerPhase(execution: Execution, row: Row, message: InboundMessage) {
  const original = Promise.resolve().then(() => {
   if (stopped || execution.controller.signal.aborted) throw new Error("stopped");
   return invokeHandler(message, row, execution.controller.signal, undefined, { whenBusy: "steer" });
  });
  track(execution, original);
  const outcome = await settle(original);
  if (stopped) return;
  if (outcome.kind === "value" && outcome.value.status === "answered") {
   if (storeAnswer(row, outcome.value, updateAside) === "too_long") terminal(row, "dead", "response_limit");
   return;
  }
  // No answer of its own (handler failure, unanswered): the input runs as an ordinary turn from the lane head (S5).
  updateAside(row, "queued", "UPDATE jobs SET state='queued', error='steer_failed' WHERE seq=?", row.seq);
 }
 /** One answer is delivered once (S4): a reply whose answer entry another row of the lane already holds becomes a
  * `steered` receipt; otherwise the row records the answer and becomes ready. Applies to primaries and steers alike. */
 function storeAnswer(row: Row, reply: Extract<BotReply, { status: "answered" }>, write: typeof update): "steered" | "ready" | "too_long" {
  if (reply.answer !== undefined && one("SELECT 1 FROM jobs WHERE lane=? AND answer=? AND seq<>?", row.lane, reply.answer, row.seq)) { terminal(row, "done", "steered"); return "steered"; }
  if (Buffer.byteLength(reply.text) > maxResponse) return "too_long";
  write(row, "ready", "UPDATE jobs SET state='ready', parts=?, answer=?, error=NULL WHERE seq=?", JSON.stringify(platform.render(reply.text, reply.asks)), reply.answer ?? null, row.seq);
  return "ready";
 }
 // Only bounded cleanup uses a timer. Handler settlement waits indefinitely, or until stop.
 function settle<T>(promise: Promise<T>, ms?: number): Promise<Settled<T>> {
  return new Promise(resolve => {
   if (abort.signal.aborted) return resolve({ kind: "stopped" });
   const timer = ms === undefined ? undefined : setTimeout(() => finish({ kind: "timeout" }), ms);
   const onStop = () => finish({ kind: "stopped" });
   abort.signal.addEventListener("abort", onStop, { once: true });
   function finish(result: Settled<T>) { clearTimeout(timer); abort.signal.removeEventListener("abort", onStop); resolve(result); }
   promise.then(value => finish({ kind: "value", value }), error => finish({ kind: "error", error }));
  });
 }
 const failureReason = (error: unknown) =>
  error instanceof Error && error.name === "CoreUnresponsive" ? "core 응답 없음"
  : "처리 중 오류";
 async function settleProgress(execution: Execution, reporter: ProgressReporter | undefined, outcome: ProgressOutcome) {
  if (!reporter) return;
  const finishing = reporter.finish(outcome).catch(() => undefined);
  track(execution, finishing);
  await settle(finishing, FINISH_BOUND_MS);
 }
 async function invokeHandler(message: InboundMessage, row: Row, signal: AbortSignal, progress?: ProgressSink, options?: import("./types.ts").HandlerOptions): Promise<BotReply> {
  const prepared = platform.prepare ? await platform.prepare(message, JSON.parse(row.target), signal, gate) : message;
  signal.throwIfAborted();
  if ("status" in prepared) return prepared;
  if (!platform.authorizeStored(message, JSON.parse(row.target))) throw new Error("permission_revoked");
  const result = handler!(prepared, signal, progress, options);
  if (!options?.whenBusy) {
   const execution=executions.get(row.lane!);
   if(execution && execution.seq===row.seq){execution.phase="handler";promoteSteers(row.lane!);}
  }
  return result;
 }
 async function handlerPhase(execution: Execution, row: Row) {
  const message = JSON.parse(row.message) as InboundMessage;
  let reporter: ProgressReporter | undefined;
  try { reporter = platform.progress?.(JSON.parse(row.target), AbortSignal.any([abort.signal, execution.controller.signal]), operation => track(execution, operation), gate); } catch { reporter = undefined; }
  // Ticks are coalesced and tracked: never two at once, never an untracked platform call.
  let ticking: Promise<void> | undefined;
  const ticker = reporter ? setInterval(() => {
   if (ticking || stopped) return;
   ticking = reporter!.tick().catch(() => undefined).then(() => { ticking = undefined; });
   track(execution, ticking);
  }, TICK_MS) : undefined;
  execution.phase = "prepare"; execution.message = message;
  const original = Promise.resolve().then(() => {
   if (stopped || execution.controller.signal.aborted) throw new Error("stopped");
   return invokeHandler(message, row, execution.controller.signal, reporter?.event);
  });
  track(execution, original);
  const outcome = await settle(original);
  execution.phase = "send";
  clearInterval(ticker);
  if (stopped) return;
  if (outcome.kind === "value") {
   const reply = outcome.value;
   const text = reply.status === "answered" ? reply.text : reply.reason;
   if (typeof text !== "string" || Buffer.byteLength(text) > maxResponse) {
    await settleProgress(execution, reporter, { kind: "failed", reason: "응답이 너무 김" });
    if (!stopped) terminal(row, "dead", "response_limit");
    return;
   }
   await settleProgress(execution, reporter, reply.status === "answered" ? { kind: "done" } : { kind: "failed", reason: "답변 없음" });
   if (stopped) return;
   if (reply.status === "answered") storeAnswer(row, reply, update);
   else update(row, "ready", "UPDATE jobs SET state='ready', parts=? WHERE seq=?", JSON.stringify(platform.render(text)), row.seq);
   return;
  }
  const reason = failureReason(outcome.kind === "error" ? outcome.error : undefined);
  await settleProgress(execution, reporter, { kind: "failed", reason });
  // The user hears that the turn stopped instead of waiting on silence; the receipt keeps the dedupe key.
  if (!stopped) update(row, "ready", "UPDATE jobs SET state='ready', parts=?, error='handler_failed' WHERE seq=?", JSON.stringify(platform.render(failureNotice(reason))), row.seq);
 }
 async function sendPhase(execution: Execution, row: Row, parts: string[], delivery: Delivery, request: Promise<Response>) {
  let response: Response, body: string;
  try {
   response = await request;
   try { if (response.status === 429) {
    gate?.rateLimited(telegramRateLimitDelay(response.headers.get("retry-after"), null));
    platform.cooldown?.limited(JSON.parse(row.target), rateLimitDelay(response.headers.get("retry-after"), null));
   } }
   catch(error) { await response.body?.cancel(); throw error; }
   // Do not load unbounded platform error bodies into memory or expose them in health.
   const reading = readBounded(response, 16384);
   track(execution, reading);
   body = await reading;
  } catch {
   if (stopped) return;
   if (delivery.idempotent) retry(row, "network_failure", 1000);
   else recoverDelivery(row);
   return;
  }
  // The bound is shared by every later API start of this bot (other topics, progress, polling) and is recorded even
  // while stopping, so a restart cannot start earlier. Beyond the policy bound the gate fails the adapter closed.
  const delay = response.status === 429 ? (gate ? telegramRateLimitDelay : rateLimitDelay)(response.headers.get("retry-after"), platform.retryAfter(body)) : 0;
  if (response.status === 429) platform.cooldown?.limited(JSON.parse(row.target), delay);
  const withinBound = response.status === 429 && gate ? gate.rateLimited(delay) : true;
  if (stopped && withinBound) return;
  if (response.status === 429) {
   // This job ends instead of retrying early (its lower bound exceeds the budget).
   if (!withinBound) terminal(row, "dead", "retry_after_exceeds_budget");
   // Fairness: lanes already waiting on the shared cooldown start first (one chat spacing of priority); the rejected
   // lane, the likeliest to be rejected again, cannot win every cooldown end and starve them.
   // The gate may retain a larger header-time fallback or an earlier bound. Yield AFTER that bound,
   // not inside it; otherwise an early retry joins the cooldown wakeup race with the waiting lanes.
   else retry(row, "rate_limited", delay, gate ? Math.max(0, gate.cooldownRemainingMs() - delay) + gate.policy.chatSpacingMs : 0);
  } else if (response.ok && platform.success(response, body)) {
   if (row.progress + 1 === parts.length) terminal(row, "done", null);
   else { row.progress++; row.attempts = 0; update(row, "ready", "UPDATE jobs SET state='ready', progress=progress+1, attempts=0, due=0 WHERE seq=?", row.seq); }
  } else if (response.status >= 500 && delivery.idempotent) retry(row, "platform_unavailable", 1000);
  else if (response.status >= 500) recoverDelivery(row);
  else terminal(row, "dead", "platform_rejected");
 }

 // ---- admission and cancellation ----------------------------------------------------------------------------
 // The same durable admission boundary serves webhook and polling. Cursor and job
 // commit together; overload and database exceptions leave the cursor unchanged.
 const admit = (result: Receive, nextOffset?: number): boolean => {
  if (stopped || result.status >= 500 || !db) return false;
  const admission = result.admission;
  if (admission && counters.rows >= maxRows) collectGarbage(Date.now());
  const now = Date.now();
  let inserted: { seq: number; lane: string; state: State; fresh: boolean } | undefined;
  const ok = db.transaction(() => {
   if (admission && !one("SELECT id FROM jobs WHERE id=?", admission.message.messageId)) {
    if (counters.rows >= maxRows) return false;
    let lane: string | undefined;
    try { lane = scheduling.lane(admission.message, admission.target); } catch { lane = undefined; }
    if (lane === undefined) return false;
    const state: State = admission.trustedReply === undefined ? "queued" : "ready";
    const seq = Number(execute("INSERT INTO jobs(id,message,target,state,created,expires,parts,lane,answer) VALUES (?,?,?,?,?,?,?,?,?)", admission.message.messageId, JSON.stringify(admission.message), JSON.stringify(admission.target), state, now, admission.expires ?? 0, admission.trustedReply === undefined ? null : JSON.stringify(platform.render(admission.trustedReply, admission.trustedAsks)), lane, admission.answer ?? null).lastInsertRowid);
    // A job behind an existing lane head leaves the head unchanged.
    const fresh = execute("INSERT INTO lanes(lane, head) VALUES (?, ?) ON CONFLICT(lane) DO NOTHING", lane, seq).changes === 1;
    inserted = { seq, lane, state, fresh };
   }
   if (nextOffset !== undefined) execute("UPDATE polling_cursor SET offset=MAX(offset,?) WHERE id=1", nextOffset);
   return true;
  })();
  if (ok && inserted) {
   counters.rows++; counters.add(inserted.state, null, 1);
   if (inserted.fresh) scheduler.setHead(inserted.lane, { seq: inserted.seq, due: 0, created: now }, now);
   else if (inserted.state === "queued") promoteSteers(inserted.lane);
   pump();
  }
  return ok;
 };
 const cancelQueued = (messageId: string): CancelResult => {
  if (stopped || !db) return "unavailable";
  // Re-checked inside the owner's transaction: the winner of a dispatch/cancel race is the first commit.
  const row = one<Row>("SELECT seq, lane, state FROM jobs WHERE id=?", messageId);
  if (!row) return "unknown";
  if (row.state !== "queued") return "not_queued";
  terminal(row, "dead", "cancelled_queued");
  pump();
  return "cancelled";
 };

 const health = (): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const state of STATES) counts[state] = counters.state(state);
  counts.unknown = counters.dead.get("ambiguous_delivery") ?? 0;
  counts.running = stopped ? 0 : 1;
  if (platform.polling) { counts.polling_failed = pollingStatus ? 1 : 0; counts.polling_status = pollingStatus; }
  for (const [error, count] of counters.dead) if (count > 0 && DEAD_REASONS.has(error)) counts["dead_" + error] = count;
  const oldest = scheduler.oldestCreated();
  Object.assign(counts, {
   concurrency: scheduling.concurrency, active: executions.size, steering: steers.size,
   stopping: stopped && executions.size + steers.size > 0 ? 1 : 0, lanes: scheduler.lanes, ready_lanes: scheduler.ready, delayed_lanes: scheduler.delayed,
   rows: counters.rows, max_rows: maxRows, live: counters.state("queued") + counters.state("processing") + counters.state("ready") + counters.state("sending"),
   receipts: counters.state("done") + counters.state("dead"), oldest_live_age_ms: oldest === undefined ? 0 : Math.max(0, Date.now() - oldest),
  });
  if (gate) Object.assign(counts, gate.health());
  if (platform.health) Object.assign(counts, platform.health());
  return counts;
 };

 // ---- startup: version fence, migration and recovery in one transaction --------------------------------------
 function openSchema(database: Database) {
  database.exec("CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS jobs (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, message TEXT NOT NULL, target TEXT NOT NULL, state TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL, parts TEXT, progress INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL DEFAULT 0, error TEXT);");
  const owners = database.query<{ name: string }, []>("SELECT name FROM metadata").all();
  if (owners.length > 1) throw new Error("Inbox ownership metadata is corrupt");
  const fenced = owners[0] ? FENCE.exec(owners[0].name) : null;
  const identity = fenced ? fenced[2] : owners[0]?.name;
  if (identity !== undefined && identity !== platform.storageIdentity) throw new Error("Database belongs to another channel");
  const version = fenced ? Number(fenced[1]) : 0;
  const userVersion = database.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
  if (version > INBOX_SCHEMA_VERSION || userVersion > INBOX_SCHEMA_VERSION) throw new Error("Unsupported inbox schema version");
  const now = Date.now();
  database.transaction(() => {
   const columns = new Set(database.query<{ name: string }, []>("PRAGMA table_info(jobs)").all().map(c => c.name));
   if (!columns.has("lane")) database.exec("ALTER TABLE jobs ADD COLUMN lane TEXT");
   if (!columns.has("terminal_at")) database.exec("ALTER TABLE jobs ADD COLUMN terminal_at INTEGER");
   if (!columns.has("answer")) database.exec("ALTER TABLE jobs ADD COLUMN answer INTEGER");
   if (!columns.has("recovery")) database.exec("ALTER TABLE jobs ADD COLUMN recovery INTEGER NOT NULL DEFAULT 0");
   database.exec(`CREATE TABLE IF NOT EXISTS lanes (lane TEXT PRIMARY KEY, head INTEGER NOT NULL UNIQUE) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS api_permits (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, rate_key TEXT);
    CREATE INDEX IF NOT EXISTS api_permits_at ON api_permits(at);
    CREATE INDEX IF NOT EXISTS jobs_live_lane_seq ON jobs(lane, seq) WHERE ${LIVE};
    CREATE INDEX IF NOT EXISTS jobs_terminal_expiry ON jobs(terminal_at, seq) WHERE state IN ('done','dead');
    CREATE INDEX IF NOT EXISTS jobs_lane_answer ON jobs(lane, answer) WHERE answer IS NOT NULL;`);
   if (platform.gate && version < 3) {
    const used = owners.length > 0 || !!database.query("SELECT 1 FROM jobs LIMIT 1").get();
    database.query("INSERT OR IGNORE INTO settings(name,value) VALUES ('api_legacy_used',?)").run(used ? "true" : "false");
   }
   // Legacy receipts have no terminal time: start their retention now, never shorter than before.
   database.query("UPDATE jobs SET terminal_at=? WHERE state IN ('done','dead') AND terminal_at IS NULL").run(now);
   database.exec("UPDATE jobs SET state='queued' WHERE state='processing'");
   if (platform.recovery) {
    for (let after = 0; ;) {
     const page = database.query<Row, [number, number]>("SELECT * FROM jobs WHERE state='sending' AND seq>? ORDER BY seq LIMIT ?").all(after, STARTUP_PAGE);
     for (const row of page) {
      if (row.attempts >= maxAttempts || now - row.created >= platform.recovery.maxAgeMs || !row.parts)
       database.query("UPDATE jobs SET state='dead', error='ambiguous_delivery', target='{}', parts=NULL, message='{}', terminal_at=? WHERE seq=?").run(now, row.seq);
      else database.query("UPDATE jobs SET state='ready', error='ambiguous_delivery', recovery=1, parts=?, due=MAX(due,?) WHERE seq=?").run(markedParts(row), now, row.seq);
      after = row.seq;
     }
     if (page.length < STARTUP_PAGE) break;
    }
   } else if (!platform.replaySafe) database.query("UPDATE jobs SET state='dead', error='ambiguous_delivery', target='{}', parts=NULL, message='{}', terminal_at=? WHERE state='sending' OR (state='ready' AND (recovery=1 OR error='ambiguous_delivery'))").run(now);
   else database.exec("UPDATE jobs SET state='ready' WHERE state='sending'");
   const stored = database.query<{ value: string }, []>("SELECT value FROM settings WHERE name='lane_policy'").get()?.value;
   if (stored !== scheduling.policy) database.exec(`UPDATE jobs SET lane=NULL WHERE ${LIVE}`);
   // Bounded pages: assign lanes from validated stored targets; unroutable live rows become explicit receipts.
   for (let after = 0; ;) {
    const page = database.query<Pick<Row, "seq" | "message" | "target">, [number, number]>(SCHEDULER_SQL.unkeyedPage).all(after, STARTUP_PAGE);
    for (const row of page) {
     let lane: string | undefined;
     try { lane = scheduling.lane(JSON.parse(row.message), JSON.parse(row.target)); } catch { lane = undefined; }
     if (lane === undefined) database.query("UPDATE jobs SET state='dead', error='migration_invalid_target', target='{}', parts=NULL, message='{}', terminal_at=? WHERE seq=?").run(now, row.seq);
     else database.query("UPDATE jobs SET lane=? WHERE seq=?").run(lane, row.seq);
     after = row.seq;
    }
    if (page.length < STARTUP_PAGE) break;
   }
   database.query("DELETE FROM jobs WHERE state IN ('done','dead') AND terminal_at < ?").run(now - retention);
   // Startup is the explicit recovery path for the materialized heads: rebuild them from the live index.
   database.exec(`DELETE FROM lanes; INSERT INTO lanes(lane, head) SELECT lane, MIN(seq) FROM jobs WHERE ${LIVE} AND lane IS NOT NULL GROUP BY lane;`);
   database.query("INSERT INTO settings(name, value) VALUES ('lane_policy', ?) ON CONFLICT(name) DO UPDATE SET value=excluded.value").run(scheduling.policy);
   database.exec(`PRAGMA user_version=${INBOX_SCHEMA_VERSION}`);
   // Last: the fence. A pre-0048 binary reads this owner row as a foreign channel and refuses the database.
   const fence = "inbox-schema:" + INBOX_SCHEMA_VERSION + ":" + platform.storageIdentity;
   if (owners[0]) { if (owners[0].name !== fence) database.query("UPDATE metadata SET name=? WHERE name=?").run(fence, owners[0].name); }
   else database.query("INSERT INTO metadata VALUES (?)").run(fence);
  })();
  counters.reset();
  for (const row of database.query<{ state: string; error: string | null; count: number }, []>("SELECT state, error, count(*) AS count FROM jobs GROUP BY state, error").all()) { counters.add(row.state, row.error, row.count); counters.rows += row.count; }
  scheduler = new KeyedScheduler(scheduling.concurrency);
  // Oldest heads first, one bounded page at a time.
  for (let after = 0; ;) {
   const page = database.query<LaneHead & { lane: string }, [number, number]>(SCHEDULER_SQL.headsPage).all(after, STARTUP_PAGE);
   for (const head of page) { scheduler.setHead(head.lane, { seq: head.seq, due: head.due, created: head.created }, now); after = head.seq; }
   if (page.length < STARTUP_PAGE) break;
  }
  nextGc = now + GC_INTERVAL_MS;
 }

 /** Shared-clock restoration commits before exposing any producer. */
 function openGate(database: Database): ApiGate | undefined {
  if (!platform.gate) return undefined;
  const {store,snapshot}=sqliteGateStore(database);
  const reserve=store.reserve;
  store.reserve=(...args)=>{reserve(...args);platform.gate?.afterReserve?.();};
  return new ApiGate(platform.gate.policy,store,snapshot,{clock:platform.gate.clock,onFailClosed:fatal,canRunFinal:()=>executions.size<scheduling.concurrency});
 }

 async function startChannel(next: MessageHandler) {
  if (db || executions.size) throw new Error("Channel already started or handler still active");
  if (config.databasePath === ":memory:") throw new Error("Native channels require persistent storage");
  const database = new Database(config.databasePath, { create: true });
  db = database; abort = new AbortController(); handler = next; gate = undefined; gateDues.clear(); gateDuesLimit = 1024;
  try {
   chmodSync(config.databasePath, 0o600);
   // Exclusive connection ownership prevents two workers sending from the same inbox.
   database.exec("PRAGMA journal_mode=DELETE; PRAGMA locking_mode=EXCLUSIVE; PRAGMA synchronous=FULL; BEGIN EXCLUSIVE; COMMIT;");
   openSchema(database);
   if (platform.cooldown) {
    database.exec("CREATE TABLE IF NOT EXISTS native_cooldowns (rate_key TEXT PRIMARY KEY, until INTEGER NOT NULL) WITHOUT ROWID");
    platform.cooldown.bind({
     get: key => database.query<{ until: number }, [string]>("SELECT until FROM native_cooldowns WHERE rate_key=?").get(key)?.until,
     set: (key, until) => { database.query("INSERT INTO native_cooldowns VALUES (?,?) ON CONFLICT(rate_key) DO UPDATE SET until=MAX(until,excluded.until)").run(key,until); },
     prune: now => { database.query("DELETE FROM native_cooldowns WHERE until<=?").run(now); },
    });
   }
   gate = openGate(database);
   stopped = false; pollingStatus = 0;
   if (platform.polling) {
    database.exec("CREATE TABLE IF NOT EXISTS polling_cursor (id INTEGER PRIMARY KEY CHECK(id=1), offset INTEGER NOT NULL); INSERT OR IGNORE INTO polling_cursor VALUES (1,0)");
    await platform.polling.check(abort.signal, gate);
    if (stopped) throw new Error("Channel stopped during start");
   }
   if (platform.startup) {
    await platform.startup(abort.signal, gate);
    if (stopped) throw new Error("Channel stopped during start");
   }
   if (platform.polling) {
    poller = platform.polling.run({ signal: abort.signal, cursor: () => one<{ offset: number }>("SELECT offset FROM polling_cursor WHERE id=1")!.offset, admit,
     fail(status) { pollingStatus = status; fatal(); }, ...(gate ? { permits: gate } : {}),
    }).catch(() => { pollingStatus = pollingStatus || 500; fatal(); });
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
      let admitted: boolean;
      try { admitted = admit(result); } catch { return new Response(null, {status:503,headers:{"Retry-After":"1"}}); }
      if (!admitted || Date.now() >= deadline) return new Response(null, { status: 503, headers: { "Retry-After": "1" } });
      // SQLite FULL synchronous commit above is complete before acknowledging admission.
      return result.body === undefined ? new Response(null, { status: result.status }) : Response.json(result.body, { status: result.status });
     } catch { return new Response(null, { status: 400 }); }
     finally { receivers--; }
    },
   });
   pump();
  } catch (error) {
   stopped = true; abort.abort(); clearWake();
   await server?.stop(true); server = undefined;
   while (executions.size || steers.size) await Promise.allSettled([...executions.values(), ...steers.values()].map(e => e.done));
   gate?.close();
   platform.cooldown?.bind(undefined);
   database.close(); if (db === database) db = undefined;
   throw error;
  }
 }

 /** ADR 0096: an answer of a host-initiated turn becomes a ready (delivery-only) job of the thread's lane, through the same
  * durable admission, ordering, retry and dedupe as an answered message. Idempotent by `id`; an answer another row of
  * the lane already holds (a steered message answered by the same turn) is not delivered again. */
 const deliverHost = (threadKey: string, reply: Extract<BotReply, { status: "answered" }>, id: string): HostDeliveryResult => {
  if (stopped || !db) return "unavailable";
  let route: ReturnType<NonNullable<MessagingPlatform["hostRoute"]>>;
  try { route = platform.hostRoute?.(threadKey); } catch { route = undefined; }
  if (!route) return "unroutable";
  const message: InboundMessage = { ...route.message, messageId: id, text: "" };
  let lane: string | undefined;
  try { lane = scheduling.lane(message, route.target); } catch { lane = undefined; }
  if (lane === undefined || !platform.authorizeStored(message, route.target)) return "unroutable";
  if (one("SELECT 1 FROM jobs WHERE id=?", id)) return "admitted";
  if (reply.answer !== undefined && one("SELECT 1 FROM jobs WHERE lane=? AND answer=?", lane, reply.answer)) return "duplicate";
  // Never more than maxResponse bytes, whatever its configured size (the marker only when it fits).
  const marker = "\n…(생략)", room = maxResponse - Buffer.byteLength(marker);
  const cut = (bytes: number) => Buffer.from(reply.text).subarray(0, Math.max(0, bytes)).toString("utf8").replace(/\uFFFD+$/, "");
  const text = Buffer.byteLength(reply.text) <= maxResponse ? reply.text : room > 0 ? cut(room) + marker : cut(maxResponse);
  try {
   return admit({ status: 200, admission: { message, target: route.target, trustedReply: text, ...(reply.asks?.length ? { trustedAsks: reply.asks } : {}), ...(reply.answer !== undefined ? { answer: reply.answer } : {}) } }) ? "admitted" : "unavailable";
  } catch { return "unavailable"; }
 };

 /** ADR 0096: whether the thread's lane holds (queued or delivered) the reply with this answer entry. */
 const holdsAnswer = (threadKey: string, answer: number): boolean | undefined => {
  if (stopped || !db) return undefined;
  let route: ReturnType<NonNullable<MessagingPlatform["hostRoute"]>>;
  try { route = platform.hostRoute?.(threadKey); } catch { route = undefined; }
  if (!route) return undefined;
  let lane: string | undefined;
  try { lane = scheduling.lane({ ...route.message, messageId: "", text: "" }, route.target); } catch { lane = undefined; }
  if (lane === undefined) return undefined;
  return Boolean(one("SELECT 1 FROM jobs WHERE lane=? AND answer=?", lane, answer));
 };

 return {
  name: platform.name, commandPolicy: "none", health, cancelQueued, deliverHost, holdsAnswer,
  admitAuthenticated(result) { try { return admit(result) ? result.status : 503; } catch { return 503; } },
  storagePaths: Object.freeze([config.databasePath, config.databasePath + "-journal"]),
  url() { if (!server) throw new Error("Channel not started"); return server.url; },
  start(next) {
   const started = startChannel(next);
   starting = started;
   void started.then(() => { if (starting === started) starting = undefined; }, () => { if (starting === started) starting = undefined; });
   return started;
  },
  /** Resolves only after the poller, the webhook server and every tracked execution (including a
   * non-cooperative handler) have settled; until then the database stays open but no new effect is issued. */
  async stop() {
   stopped = true; abort.abort(); gate?.close(); clearWake();
   await starting?.catch(() => undefined);
   await server?.stop(true); await poller;
   while (executions.size || steers.size) await Promise.allSettled([...executions.values(), ...steers.values()].map(e => e.done));
   poller = undefined; server = undefined;
   gate?.close();
   platform.cooldown?.bind(undefined);
   db?.close(); db = undefined;
  },
 };
}
export async function readBounded(source: Request | Response, limit: number, signal?: AbortSignal): Promise<string> {
 return (await readBoundedBytes(source, limit, signal)).toString("utf8");
}

/** Authentication consumes original bytes, never decoded and re-encoded replacement text. */
export async function readBoundedBytes(source: Request | Response, limit: number, signal?: AbortSignal): Promise<Buffer> {
 if(signal?.aborted) { await source.body?.cancel().catch(()=>{}); signal.throwIfAborted(); }
 const reader = source.body?.getReader(); if (!reader) return Buffer.alloc(0);
 const chunks: Uint8Array[] = []; let size = 0;
 let cancelling: Promise<void> | undefined;
 const cancel = () => { cancelling ??= reader.cancel().catch(() => {}); };
 signal?.addEventListener("abort", cancel, { once: true });
 try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > limit) throw new Error("body_limit"); chunks.push(value); } }
 finally { signal?.removeEventListener("abort", cancel); cancel(); await cancelling; reader.releaseLock(); }
 if (signal?.aborted) throw new Error("body_timeout");
 return Buffer.concat(chunks);
}
