import { NativeCooldown } from "./native-cooldown.ts";
import { nativeProgress } from "./native-progress.ts";
import { PROGRESS_FINISH_BUDGET_MS, rateLimitDelay, readBounded, type ProgressReporter } from "./messaging.ts";
import { clip } from "./progress.ts";
import { redactSecrets, safeHint } from "./safe-preview.ts";

type Task = { type: "task_update"; id: string; title: string; status: "in_progress" | "complete" | "error" };
const BASE = "https://slack.com/api";
const INTERVAL = 1_500;
const unsupported = new Set(["missing_scope", "unknown_method", "method_not_supported", "not_supported", "unsupported_feature", "feature_not_enabled", "streaming_not_enabled"]);
// No parse/mrkdwn switch on task titles. Neutralize mention/link delimiters and emoji aliases.
const title = (value: string) => clip(redactSecrets(value).replace(/&/g, "＆").replace(/</g, "‹").replace(/>/g, "›").replace(/@/g, "＠").replace(/:/g, "："), 128);

/** Core drafts are sliding snapshots, never append-only answer tokens.
 * Slack has no task-delete chunk: local state/batches are recent-8, but Slack may retain older cards.
 * Ambiguous failures suppress rather than replay a non-idempotent start.
 */
export function slackProgress(target: Record<string, string>, token: string, stop: AbortSignal,
 track: (p: Promise<unknown>) => void, cooldown: NativeCooldown,
 mode: "native" | "text" | "off" = "native"): ProgressReporter | undefined {
 if (mode === "off") return;
 const seal = new AbortController();
 const signal = AbortSignal.any([stop, seal.signal]);
 const text = nativeProgress("slack", target, BASE, token, signal, track, cooldown, true);
 if (mode === "text" || !target.thread_ts || !target.recipient_team_id || !target.recipient_user_id) return text;
 let route: "native" | "text" | "silent" = "native";
 const tasks = new Map<string, Task>();
 // Published unresolved tasks must be terminalized even after leaving the recent window.
 const remoteOpen = new Map<string, Task>();
 let revision = 0, sent = -1, lastCall = -Infinity;
 let ts: string | undefined;
 let busy: Promise<void> | undefined, finished: Promise<void> | undefined;
 let closed = false;

 // The only native transport boundary. Track originals, not just the bounded race.
 async function call(method: string, body: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
  if (signal.aborted || cooldown.remaining(target) > 0) return;
  lastCall = Date.now();
  const request = new AbortController();
  const requestSignal = AbortSignal.any([signal, request.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const cancelled = new Promise<Record<string, unknown>>(resolve => {
   abort = () => resolve({ok:false, error:"transport_error"});
   requestSignal.addEventListener("abort", abort, { once: true });
   timer = setTimeout(() => request.abort(), 10_000);
  });
  const operation = (async () => {
   try {
    const raw = fetch(BASE + "/" + method, {method:"POST", redirect:"error", signal:requestSignal,
     headers:{"content-type":"application/json", authorization:"Bearer " + token}, body:JSON.stringify({channel:target.channel, ...body})});
    track(raw);
    const response = await raw;
    if (response.status === 429) cooldown.limited(target, rateLimitDelay(response.headers.get("retry-after"), null));
    const reading = readBounded(response, 16_384, requestSignal); track(reading);
    let json: Record<string, unknown> = {};
    try { json = JSON.parse(await reading) ?? {}; } catch { /* Header-only throttles still apply. */ }
    if (response.status === 429) {
     cooldown.limited(target, rateLimitDelay(response.headers.get("retry-after"), typeof json.retry_after === "number" ? String(json.retry_after) : null));
     return {ok:false, error:"ratelimited"};
    }
    return response.ok ? json : {ok:false, error:"http_error"};
   } catch { return {ok:false, error:"transport_error"}; }
  })();
  track(operation);
  try { return await Promise.race([operation, cancelled]); }
  finally { clearTimeout(timer); if (abort) requestSignal.removeEventListener("abort", abort); }
 }
 function accept(result: Record<string, unknown> | undefined): boolean {
  if (!result) { if (cooldown.remaining(target) === 0) route = "silent"; return false; }
  if (result.ok === true) return true;
  const error = String(result.error);
  if (error === "ratelimited") return false;
  // Permission/auth declines never take the text escape hatch.
  route = unsupported.has(error) ? "text" : "silent";
  return false;
 }
 function updates(final = false): Task[] {
  const retired = [...remoteOpen.values()].filter(task => final || !tasks.has(task.id))
   .map(task => tasks.get(task.id) ?? task)
   .map(task => ({...task, status:task.status === "in_progress" ? "error" as const : task.status}));
  const ids = new Set(retired.map(task => task.id));
  return [...retired, ...[...tasks.values()].filter(task => !ids.has(task.id)).map(task => ({...task,
   status:final && task.status === "in_progress" ? "error" as const : task.status}))].slice(0, 8);
 }
 function chunks(batch: Task[], final = false) {
  return [{type:"plan_update", title:final ? "Tool activity finished" : "Tool activity"}, ...batch];
 }
 async function flush() {
  if (signal.aborted || route === "silent") return;
  if (route === "text") { await text.tick(); return; }
  if (!tasks.size || revision === sent || Date.now() - lastCall < INTERVAL) return;
  const version = revision, batch = updates();
  const result = await call(ts ? "chat.appendStream" : "chat.startStream", ts ? {ts, chunks:chunks(batch)} : {
   thread_ts:target.thread_ts, recipient_team_id:target.recipient_team_id, recipient_user_id:target.recipient_user_id,
   task_display_mode:"plan", chunks:chunks(batch),
  });
  if (accept(result)) {
   if (!ts) { if (typeof result?.ts !== "string") { route = "silent"; return; } ts = result.ts; }
   for (const task of batch) {
    if (task.status === "in_progress") remoteOpen.set(task.id, task);
    else remoteOpen.delete(task.id);
   }
   sent = [...tasks.keys()].every(id => batch.some(task => task.id === id)) ? version : -1;
  }
  if ((route as string) === "text" && !signal.aborted) {
   // Unsupported append: close the existing stream before entering the one text rail.
   if (ts) { await call("chat.stopStream", {ts, chunks:chunks(updates(true), true)}); ts = undefined; }
   if (!closed && !signal.aborted) await text.tick();
  }
 }
 return {
  event(event) {
   if (closed || signal.aborted) return;
   text.event(event);
   if (event.type === "tool_start" && !tasks.has(event.id)) {
    const detail = event.detail ?? (event.preview ? safeHint(event.preview) : undefined);
    tasks.set(event.id, {type:"task_update", id:event.id, title:title(event.name + (detail ? ": " + detail : "")) || "tool", status:"in_progress"});
    if (tasks.size > 8) tasks.delete(tasks.keys().next().value!);
    revision++;
   } else if (event.type === "tool_end") {
    const task = tasks.get(event.id) ?? remoteOpen.get(event.id);
    if (task && task.status === "in_progress") {
     task.status = event.ok ? "complete" : "error";
     const published = remoteOpen.get(event.id);
     if (published) published.status = task.status;
     revision++;
    }
   }
  },
  tick() {
   if (closed || signal.aborted) return Promise.resolve();
   busy ??= flush().catch(() => { route = "silent"; }).finally(() => { busy = undefined; });
   return busy;
  },
  finish(outcome) {
   if (finished) return finished;
   closed = true;
   let guard: ReturnType<typeof setTimeout> | undefined;
   const expired = new Promise<void>(resolve => { guard = setTimeout(() => { seal.abort(); resolve(); }, PROGRESS_FINISH_BUDGET_MS); });
   const settle = (async () => {
    await busy;
    if (signal.aborted) return;
    if (route === "text") { await text.finish(outcome); return; }
    if (!ts || route === "silent") return;
    // Never violate Retry-After to perform best-effort cleanup.
    while (cooldown.remaining(target) > 0 && !signal.aborted) {
     if (cooldown.remaining(target) >= PROGRESS_FINISH_BUDGET_MS) return;
     await Bun.sleep(Math.min(cooldown.remaining(target), 100));
    }
    if (!signal.aborted) await call("chat.stopStream", {ts, chunks:chunks(updates(true), true)});
   })();
   finished = Promise.race([settle.catch(() => undefined), expired]).finally(() => { clearTimeout(guard); seal.abort(); });
   return finished;
  },
 };
}
