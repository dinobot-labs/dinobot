import { readBoundedBytes } from "../channels/messaging.ts";
import { parseAskPrompts } from "../channels/ask-buttons.ts";
import { TELEGRAM_MESSAGE_PREFIX } from "../channels/telegram-media.ts";
import { parseProgressEvent } from "../channels/progress.ts";
import { telegramChannel } from "../channels/telegram.ts";
import type { BotReply, MessageHandler, ProgressSink } from "../channels/types.ts";

const MAX_TEXT = 65_536;
// Allow worst-case JSON escaping of each UTF-16 unit plus envelope framing.
const MAX_RESPONSE = MAX_TEXT * 6 + 1024;
/** One NDJSON line: a progress event is small; the reply line carries the whole answer. */
const MAX_LINE = MAX_RESPONSE;
/**
 * A streaming core writes a heartbeat every 10 s while the turn is unsettled. Silence this long means the core or the
 * connection is gone, so the turn fails on inactivity rather than total elapsed time (ADR 0047).
 */
export const IDLE_TIMEOUT_MS = 60_000;

function parseReply(value: unknown): BotReply {
 if (!value || typeof value !== "object") throw new Error();
 const record = value as Record<string, unknown>;
 if (record.status === "answered" && typeof record.text === "string" && record.text.length <= MAX_TEXT) {
  // The answer entry id (ADR 0057) is optional: an older core omits it and every reply is then delivered.
  const answer = typeof record.answer === "number" && Number.isSafeInteger(record.answer) && record.answer >= 0 ? { answer: record.answer } : {};
  const asks = record.asks === undefined ? undefined : parseAskPrompts(record.asks);
  return { status: "answered", text: record.text, ...answer, ...(asks ? { asks } : {}) };
 }
 if (record.status === "unanswered" && typeof record.reason === "string" && record.reason.length <= MAX_TEXT) return { status: "unanswered", reason: record.reason };
 throw new Error();
}

type Reader = Pick<ReadableStreamDefaultReader<Uint8Array>, "read" | "cancel" | "releaseLock">;

/** Reads NDJSON lines until the terminal line; progress goes to `progress`, silence beyond the idle bound rejects. */
async function readProgressStream(reader: Reader, progress: ProgressSink | undefined, idleMs: number, onIdle: () => void): Promise<BotReply> {
 const decoder = new TextDecoder("utf-8", { fatal: true });
 let buffered = "";
 let idle: ReturnType<typeof setTimeout> | undefined;
 const arm = () => { clearTimeout(idle); idle = setTimeout(onIdle, idleMs); };
 arm();
 try {
  for (;;) {
   const { done, value } = await reader.read();
   if (done) throw new Error("stream ended without a reply");
   arm();
   buffered += decoder.decode(value, { stream: true });
   if (buffered.length > MAX_LINE && !buffered.includes("\n")) throw new Error("line too long");
   let newline: number;
   while ((newline = buffered.indexOf("\n")) >= 0) {
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    if (line.length > MAX_LINE) throw new Error("line too long");
    if (line.trim() === "") continue;
    const frame = JSON.parse(line) as Record<string, unknown>;
    if (frame?.type === "reply") return parseReply(frame.reply);
    if (frame?.type === "error") throw new Error("core turn failed");
    const event = frame?.type === "heartbeat" ? { type: "heartbeat" as const } : frame?.type === "progress" ? parseProgressEvent(frame.event) : undefined;
    if (event && progress) { try { progress(event); } catch { /* progress never fails the turn */ } }
   }
  }
 } finally { clearTimeout(idle); }
}

function coreEndpoint(coreUrl: string): string {
 // Reject alternate IP spellings and paths before URL normalization.
 if (!/^http:\/\/127\.0\.0\.1(?::[0-9]{1,5})?\/?$/.test(coreUrl)) throw new Error("Invalid Telegram core URL");
 try {
  const url = new URL(coreUrl);
  if (url.port === "0") throw new Error();
  return url.origin + "/v1/messages";
 } catch { throw new Error("Invalid Telegram core URL"); }
}

/** Bridge data and narrow native controls (/model, /models, /new), never local privileged commands. */
export function createTelegramForwarder(coreUrl: string, options: { readonly idleTimeoutMs?: number } = {}): MessageHandler {
 const endpoint = coreEndpoint(coreUrl);
 const idleMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
 return async (message, signal, progress, options) => {
  const native = !message.files?.length && /^\/(?:models|model|new)(?=\s|$)/.test(message.text);
  const abort = new AbortController();
  const cancel = () => abort.abort();
  let idled = false;
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  let reader: Pick<ReadableStreamDefaultReader<Uint8Array>, "read" | "cancel" | "releaseLock"> | undefined;
  try {
   // Old cores silently ignore unknown JSON fields. Negotiate BEFORE submitting, never lose a file as caption-only.
   if (message.files?.length) {
    const capability = await fetch(endpoint.replace("/v1/messages","/v1/capabilities"),{redirect:"error",signal:AbortSignal.any([abort.signal,AbortSignal.timeout(idleMs)])});
    const supported = capability.ok && capability.headers.get("content-type")?.includes("application/json");
    const value = supported ? JSON.parse((await readBoundedBytes(capability,4096,abort.signal)).toString("utf8")) : undefined;
    if (!supported) await capability.body?.cancel();
    if (value?.files?.version !== 1) return {status:"answered",text:"Generic attachments require a Dinobot core upgrade; the file was not submitted."};
   }
   const response = await fetch(native ? endpoint.replace("/v1/messages", "/v1/native/messages") : endpoint, {
    method: "POST", redirect: "error", signal: abort.signal,
    headers: { "content-type": "application/json", accept: native ? "application/json" : "application/x-ndjson, application/json" },
    body: JSON.stringify({ channel: "telegram", threadKey: message.threadKey, messageId: message.messageId, userId: message.userId, text: native ? message.text : TELEGRAM_MESSAGE_PREFIX + message.text, ...(message.choice ? { choice: message.choice } : {}), ...(message.files?.length ? { files: message.files } : {}), ...(message.images?.length ? { images: message.images } : {}), ...(!native && options?.whenBusy === "steer" ? { whenBusy: "steer" } : {}) }),
   });
   if (native && response.status === 404) {
    await response.body?.cancel();
    return { status: "answered", text: "Native model controls require a core upgrade. Upgrade Dinobot core to use /model and /models." };
   }
   // An older core rejects controls it does not know (such as /new) before admission; nothing was run.
   if (native && response.status === 400) {
    await response.body?.cancel();
    return { status: "answered", text: "This control requires a core upgrade. Upgrade Dinobot core to use /new." };
   }
   if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(); }
   reader = response.body.getReader();
   if (!native && (response.headers.get("content-type") ?? "").startsWith("application/x-ndjson")) return await readProgressStream(reader, progress, idleMs, () => { idled = true; cancel(); });
   const parts: Uint8Array[] = []; let size = 0;
   for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE) throw new Error();
    parts.push(value);
   }
   return parseReply(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts))));
  } catch {
   if (idled) throw Object.assign(new Error("Telegram core stopped responding"), { name: "CoreUnresponsive" });
   throw new Error("Telegram core request failed");
  }
  finally {
   signal?.removeEventListener("abort", cancel);
   await reader?.cancel().catch(() => {});
   reader?.releaseLock();
  }
 };
}

/**
 * args are the tail after dinobot telegram run. No daemon or model is started.
 * Scheduler flags (ADR 0048), validated exactly and passed through only when given:
 *   --scheduler-mode topic|global   default topic; global is the single-FIFO rollback mode and implies concurrency 1
 *   --concurrency 1..16             unsettled handler/delivery quanta across topics (default 12; global accepts only 1)
 * ADR 0057 flags, validated exactly and passed through only when given:
 *   --progress detailed|status|off  card mode (default detailed)
 *   --steering on|off               same-user messages join the running turn (default on)
 */
export async function runTelegramChannel(args: string[], factory = telegramChannel): Promise<void> {
 const flags = new Map<string, string>();
 const allowed = new Set(["--token-file", "--pairing-file", "--database", "--core-url", "--port", "--concurrency", "--scheduler-mode", "--progress", "--steering"]);
 for (let i = 0; i < args.length; i += 2) {
  const key = args[i]!, value = args[i + 1];
  if (!allowed.has(key) || flags.has(key) || !value || value.startsWith("--")) throw new Error("Invalid Telegram run arguments");
  flags.set(key, value);
 }
 if (["--token-file", "--pairing-file", "--database"].some(key => !flags.has(key))) throw new Error("Missing Telegram run file arguments");
 const portText = flags.get("--port") ?? "8791";
 if (!/^[0-9]+$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) throw new Error("Invalid Telegram run port");
 const modeText = flags.get("--scheduler-mode"), concurrencyText = flags.get("--concurrency");
 if (modeText !== undefined && modeText !== "topic" && modeText !== "global") throw new Error("Invalid Telegram run scheduler mode");
 // Canonical decimal 1..16 only: no sign, exponent, fraction, padding or leading zero.
 if (concurrencyText !== undefined && !/^(?:[1-9]|1[0-6])$/.test(concurrencyText)) throw new Error("Invalid Telegram run concurrency");
 if (modeText === "global" && concurrencyText !== undefined && concurrencyText !== "1") throw new Error("Invalid Telegram run concurrency");
 const progressText = flags.get("--progress"), steeringText = flags.get("--steering");
 if (progressText !== undefined && progressText !== "detailed" && progressText !== "status" && progressText !== "off") throw new Error("Invalid Telegram run progress mode");
 if (steeringText !== undefined && steeringText !== "on" && steeringText !== "off") throw new Error("Invalid Telegram run steering mode");
 const scheduler = {
  ...(modeText !== undefined ? { schedulerMode: modeText as "topic" | "global" } : {}), ...(concurrencyText !== undefined ? { concurrency: Number(concurrencyText) } : {}),
  ...(progressText !== undefined ? { progress: progressText as "detailed" | "status" | "off" } : {}), ...(steeringText !== undefined ? { steering: steeringText as "on" | "off" } : {}),
 };
 const handler = createTelegramForwarder(flags.get("--core-url") ?? "http://127.0.0.1:8787");
 let channel: ReturnType<typeof telegramChannel>;
 try { channel = factory({ mode: "polling", botTokenFile: flags.get("--token-file")!, pairingPath: flags.get("--pairing-file")!, databasePath: flags.get("--database")!, port: Number(portText), ...scheduler }); }
 catch { throw new Error("Telegram channel initialization failed"); }
 let finish!: () => void;
 const ended = new Promise<void>(resolve => { finish = resolve; });
 let unhealthy = false;
 let timer: ReturnType<typeof setInterval> | undefined;
 process.on("SIGTERM", finish);
 process.on("SIGINT", finish);
 try {
  await channel.start(handler);
  timer = setInterval(() => {
   try { const health = channel.health(); if (!health.polling_failed && health.running !== 0) return; } catch { /* failed health is terminal */ }
   unhealthy = true; finish();
  }, 1000);
  await ended;
  if (unhealthy) throw new Error();
 } catch { throw new Error("Telegram channel unavailable"); }
 finally {
  clearInterval(timer);
  process.off("SIGTERM", finish);
  process.off("SIGINT", finish);
  try { await channel.stop(); } catch { throw new Error("Telegram channel shutdown failed"); }
 }
}
