import { notStarted, type ApiPermits, type SyncStart } from "./api-gate.ts";
import { telegramRateLimitDelay as rateLimitDelay, readBounded, type MessagingPlatform, type Receive } from "./messaging.ts";

/** Transport only: the queue owns both SQLite and the offset transaction. With a shared API gate every request
 * (getWebhookInfo, getUpdates) first takes a polling permit, and every 429 lower bound is reported to the gate. */
export function telegramPolling(base: string, timeout: number, receive: (event: unknown) => Receive): NonNullable<MessagingPlatform["polling"]> {
 async function request(method: string, body: unknown, signal: AbortSignal, permits: ApiPermits | undefined) {
  // Owner exists before grant; adoption occurs inside start, never in the delayed continuation.
  const owned = new Set<Promise<unknown>>();
  let bounded: AbortSignal = signal;
  const start: SyncStart<Promise<Response>> = allowed => {
   bounded=AbortSignal.any([signal,AbortSignal.timeout(timeout)]);
   const init:RequestInit={method:"POST",redirect:"error",headers:{"content-type":"application/json"},body:JSON.stringify(body),signal:bounded};
   if(!allowed() || signal.aborted)return notStarted();
   const raw=fetch(base + "/" + method,init);
   owned.add(raw);
   void raw.then(()=>{},()=>{});
   return {started:true,value:raw};
  };
  try {
  const issued=permits?await permits.poll(signal,start):start(()=>true);
  if(!issued.started)throw new Error("polling_permit_unavailable");
  const response=await issued.value;
  try { if(response.status===429)permits?.rateLimited(rateLimitDelay(response.headers.get("retry-after"),null)); }
  catch(error) { await response.body?.cancel(); throw error; }
  if (response.status === 401 || response.status === 409) { await response.body?.cancel(); return { response, data: { error_code: response.status } }; }
  const text = await readBounded(response, 262144, bounded);
  let data: any; try { data = JSON.parse(text); } catch { data = {}; }
  return { response, data };
  } finally { await Promise.allSettled([...owned]); owned.clear(); }
 }
 const wait = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
  if (signal.aborted) return resolve();
  const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
  const timer = setTimeout(done, ms); signal.addEventListener("abort", done, { once: true });
 });
 return {
  async check(signal, permits) {
   try {
    const { response, data } = await request("getWebhookInfo", {}, signal, permits);
    if (response.status === 429 || data.error_code === 429) permits?.rateLimited(rateLimitDelay(response.headers.get("retry-after"), bodyHint(data)));
    if (!response.ok || data.ok !== true || typeof data.result?.url !== "string") throw new Error();
    if (data.result.url) throw new Error();
   } catch { throw new Error("Telegram polling startup failed: webhook must be absent and credentials valid"); }
  },
  async run(context) {
   let backoff = 250, limit = 100;
   while (!context.signal.aborted) {
    let delay = backoff;
    try {
     const { response, data } = await request("getUpdates", { offset: context.cursor(), limit, timeout: Math.max(0, Math.min(20, Math.floor(timeout / 1000) - 1)), allowed_updates: ["message", "callback_query"] }, context.signal, context.permits);
     const status = data.error_code ?? response.status;
     if ([401,409].includes(response.status) || [401,409].includes(status)) { context.fail([401,409].includes(response.status) ? response.status : status); return; }
     if (response.status === 429 || status === 429) {
      delay = rateLimitDelay(response.headers.get("retry-after"), bodyHint(data));
      // Never shorten a server's lower bound; fail observably beyond our bounded retry budget. The shared gate holds the
      // same bound for every other API start of this bot (and across a restart).
      if (context.permits && !context.permits.rateLimited(delay)) { context.fail(429); return; }
      if (delay > 60000) { context.fail(429); return; }
     } else if (response.ok && data.ok === true && Array.isArray(data.result) && data.result.length <= 100) {
      let previous = -1;
      for (const event of data.result) {
       if (!Number.isSafeInteger(event?.update_id) || event.update_id < 0 || event.update_id >= Number.MAX_SAFE_INTEGER || event.update_id <= previous) throw new Error("invalid_update_sequence");
       previous = event.update_id;
      }
      for (const event of data.result) {
       if (context.signal.aborted) return;
       if (event.update_id < context.cursor()) continue;
       if (!context.admit(receive(event), event.update_id + 1)) break;
      }
      backoff = 250; delay = 100;
     }
    } catch (error) {
     if (context.signal.aborted) return;
     if (error instanceof Error && error.message === "body_limit") {
      // Retry the same cursor with a smaller batch; never discard an oversized update.
      if (limit === 1) { context.fail(413); return; }
      limit = Math.max(1, Math.floor(limit / 2));
      continue;
     }
    }
    await wait(delay, context.signal); backoff = Math.min(10000, backoff * 2);
   }
  },
 };
}

function bodyHint(data: any): string | null {
 const n = data?.parameters?.retry_after;
 return typeof n === "number" || typeof n === "string" ? String(n) : null;
}
