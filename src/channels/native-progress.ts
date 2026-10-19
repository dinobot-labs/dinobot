import { NativeCooldown } from "./native-cooldown.ts";
import { chunks, rateLimitDelay, readBounded, type ProgressReporter } from "./messaging.ts";
import { telegramProgress, type TelegramResult } from "./telegram-progress.ts";

/** Reuse the bounded status writer and common reducer, translating only transport/routing. No bot output previews. */
export function nativeProgress(platform: "slack" | "discord", target: Record<string,string>, base: string, token: string, stop: AbortSignal, track: (p: Promise<unknown>) => void, cooldown = new NativeCooldown(() => base), detailed = false): ProgressReporter {
 let message: string | undefined;
 const limited = (delay: number): TelegramResult => { cooldown.limited(target, delay); return {ok:false,status:429,retryAfterMs:delay}; };
 const reporter = telegramProgress({ chat: "", topic: "0", detailed, maxBackoffMs: Infinity, call(method, body, seal) {
  if (method === "sendChatAction") return Promise.resolve({ok:true});
  if (stop.aborted || seal?.aborted) return Promise.resolve({ok:false,status:0});
  const remaining = cooldown.remaining(target);
  if (remaining > 0) return Promise.resolve({ok:false,status:429,local:true,retryAfterMs:remaining});
  const signal = AbortSignal.any([stop, ...(seal ? [seal] : []), AbortSignal.timeout(10000)]);
  const text = String(body.text);
  const operation = (async (): Promise<TelegramResult> => {
   try {
    const slack = platform === "slack";
    const url = slack ? base + (message ? "/chat.update" : "/chat.postMessage") : base;
    const payload = slack ? { channel:target.channel, ...(message ? {ts:message} : {thread_ts:target.thread_ts}), text, blocks:chunks(text,3000).map(text=>({type:"section",text:{type:"plain_text",text}})), mrkdwn:false,parse:"none",link_names:false,unfurl_links:false,unfurl_media:false }
     : {content:text,allowed_mentions:{parse:[],users:[],roles:[],replied_user:false}};
    const raw = fetch(url,{method:slack?"POST":"PATCH",redirect:"error",signal,headers:{"content-type":"application/json",...(slack?{authorization:"Bearer " + token}:{})},body:JSON.stringify(payload)});
    track(raw);
    const response = await raw;
    if (response.status === 429) cooldown.limited(target, rateLimitDelay(response.headers.get("retry-after"),null));
    let json: Record<string,unknown> = {};
    try {
     const reading = readBounded(response,16384,signal);
     track(reading);
     const body = await reading;
     try { json = JSON.parse(body) ?? {}; } catch { /* Header-only 429 still pauses the writer. */ }
    } catch {
     return response.status === 429 ? limited(rateLimitDelay(response.headers.get("retry-after"),null)) : {ok:false,status:0};
    }
    if (response.status === 429) return limited(rateLimitDelay(response.headers.get("retry-after"), typeof json.retry_after === "number" ? String(json.retry_after) : null));
    if (!response.ok || (slack && !json.ok)) return {ok:false,status:response.ok?400:response.status};
    if (slack && !message) { if (typeof json.ts !== "string") return {ok:false,status:400}; message=json.ts; }
    return {ok:true,result:{message_id:1}};
   } catch { return {ok:false,status:0}; }
  })();
  track(operation); return operation;
 }});
 return reporter;
}
