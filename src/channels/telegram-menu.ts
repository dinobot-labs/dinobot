import { notStarted, type ApiPermits, type SyncStart } from "./api-gate.ts";
import { readBounded, telegramRateLimitDelay } from "./messaging.ts";

/** Advisory default-scope menu only. No authorization or credential mutation. */
export function telegramMenu(base: string, timeout: number, models: () => boolean) {
 let registered = 0, failed = 0;
 return {
  health: () => ({ menu_registered: registered, menu_failed: failed }),
  async startup(signal: AbortSignal, permits?: ApiPermits) {
   registered = 0; failed = 0;
   // Unlike required transport validation this best-effort operation bounds BOTH gate wait and network.
   const bounded = AbortSignal.any([signal, AbortSignal.timeout(Math.min(timeout, 10000))]);
   const owned = new Set<Promise<unknown>>();
   const commands = [
    { command: "new", description: "Start a new conversation in this topic" },
    ...(models() ? [
     { command: "models", description: "List available models: /models [provider] [page]" },
     { command: "model", description: "Show or select this topic’s model: /model [provider/modelId]" },
    ] : []),
   ];
   const start: SyncStart<Promise<Response>> = allowed => {
    const init: RequestInit = { method: "POST", redirect: "error", headers: { "content-type": "application/json" },
     body: JSON.stringify({ commands, scope: { type: "default" }, language_code: "" }), signal: bounded };
    if (!allowed() || bounded.aborted) return notStarted();
    const raw = fetch(base + "/setMyCommands", init);
    owned.add(raw);
    void raw.then(() => {}, () => {});
    return { started: true, value: raw };
   };
   try {
    const issued = permits ? await permits.poll(bounded, start) : start(() => true);
    if (!issued.started) throw new Error();
    const response = await issued.value;
    const header = response.headers.get("retry-after");
    try { if (response.status === 429) permits?.rateLimited(telegramRateLimitDelay(header, null)); }
    catch (error) { await response.body?.cancel(); throw error; }
    const data = JSON.parse(await readBounded(response, 16384, bounded));
    if (response.status === 429 || data?.error_code === 429) {
     const hint = data?.parameters?.retry_after;
     permits?.rateLimited(telegramRateLimitDelay(header, typeof hint === "number" || typeof hint === "string" ? String(hint) : null));
    }
    if (!response.ok || data?.ok !== true || data.result !== true) throw new Error();
    registered = 1;
   } catch {
    // Fixed numeric diagnostics: never log exception URLs, tokens or Bot API descriptions. No retries.
    failed = 1;
   } finally { await Promise.allSettled([...owned]); owned.clear(); }
  },
 };
}
