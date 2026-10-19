import { encodeChoice, decodeChoice, choiceLabel, choiceFallbackText } from "./ask-buttons.ts";
import type { AskPrompt } from "./types.ts";
import { renderRichText } from "./rich-text.ts";
import { renameSync, unlinkSync } from "node:fs";
import { createPrivateFile, readPrivateFile, syncPrivateDirectory } from "../telegram-private-files/index.ts";
import { dirname } from "node:path";
import { telegramMenu } from "./telegram-menu.ts";
import { telegramPolling } from "./telegram-polling.ts";
import { telegramAttachment, telegramMedia, telegramMediaNotice } from "./telegram-media.ts";
import { timingSafeEqual } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import { notStarted, type ApiPermits, type SyncStart, TELEGRAM_GATE_POLICY, validGatePolicy } from "./api-gate.ts";
import { GLOBAL_LANES, MAX_CONCURRENCY, messagingChannel, messagingProperties, telegramRateLimitDelay as rateLimitDelay, readBounded, requiredEnv, type LanePolicy, type MessagingChannel, type MessagingDependencies, type Receive } from "./messaging.ts";
import { type TelegramResult, telegramProgress } from "./telegram-progress.ts";
import type { InboundMessage } from "./types.ts";

const ASK_PART = "\u0000tg-ask:";
const escapeHtml = (text: string) => text.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
const envName = Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]*$" });
export const TelegramConfigSchema = Type.Object({
 ...messagingProperties,
 mode: Type.Optional(Type.Union([Type.Literal("webhook"), Type.Literal("polling")])),
 port: Type.Optional(messagingProperties.port),
 allowedUserIds: Type.Optional(messagingProperties.allowedUserIds),
 botTokenEnv: Type.Optional(envName),
 botTokenFile: Type.Optional(Type.String({ minLength: 1 })),
 pairingPath: Type.Optional(Type.String({ minLength: 1 })),
 webhookSecretEnv: Type.Optional(envName),
 allowedChatIds: Type.Optional(Type.Array(Type.String({ pattern: "^-?[0-9]+$" }), { minItems: 1, maxItems: 1000, uniqueItems: true })),
 /** Live status message and typing while a turn runs (ADR 0047); "off" sends only the answer.
  * `detailed` (default, ADR 0057): redacted argument lines, todo text and the answer draft; `status`: fixed safe vocabulary (ADR 0056). */
 progress: Type.Optional(Type.Union([Type.Literal("detailed"), Type.Literal("status"), Type.Literal("off")])),
 /** ADR 0057: "on" (default) lets a user's message during their running turn join it as a steer; "off" keeps strict lane FIFO. */
 steering: Type.Optional(Type.Union([Type.Literal("on"), Type.Literal("off")])),
 /** ADR 0048: "topic" (default) runs distinct bot/chat/topic lanes concurrently, FIFO within each lane; "global" is the
  * pre-0048 single FIFO kept for comparison and rollback, always with concurrency 1. */
 schedulerMode: Type.Optional(Type.Union([Type.Literal("topic"), Type.Literal("global")])),
 /** Unsettled handler/delivery quanta across lanes in topic mode. Default 4. */
 concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_CONCURRENCY })),
}, { additionalProperties: false });
/** Default topic-mode concurrency (ADR 0048). */
export const TELEGRAM_DEFAULT_CONCURRENCY = 12;
export type TelegramConfig = Static<typeof TelegramConfigSchema>;
/** Configure setWebhook externally with secret_token and allowed_updates=["message","callback_query"].
 * Supports human text, photos and bounded UTF-8/image documents. Final replies use escaped HTML.
 */
export function telegramChannel(config: TelegramConfig, dependencies: MessagingDependencies = {}): MessagingChannel {
 if (!Value.Check(TelegramConfigSchema, config)) throw new Error("Invalid Telegram channel configuration");
 if (config.schedulerMode === "global" && config.concurrency !== undefined && config.concurrency !== 1) throw new Error("Invalid Telegram channel configuration");
 // ADR 0048 §5: one shared gate for every API start of this bot. Only an explicit test dependency may scale it.
 const gatePolicy = dependencies.gatePolicy ?? TELEGRAM_GATE_POLICY;
 if (!validGatePolicy(gatePolicy)) throw new Error("Invalid Telegram channel configuration");
 if (!!config.botTokenEnv === !!config.botTokenFile || (config.mode !== "polling" && (config.port === undefined || !config.webhookSecretEnv)) || (!config.pairingPath && (!config.allowedUserIds || !config.allowedChatIds))) throw new Error("Invalid Telegram channel configuration");
 let token: string;
 try { token = config.botTokenEnv ? requiredEnv(config.botTokenEnv) : readBotToken(config.botTokenFile!); } catch { throw new Error("Unable to read Telegram bot credential"); }
 const secret = config.mode === "polling" ? "" : requiredEnv(config.webhookSecretEnv!);
 if (config.mode !== "polling" && !/^[A-Za-z0-9_-]{1,256}$/.test(secret)) throw new Error("Invalid Telegram webhook secret");
 if (Buffer.byteLength(token) > 1024 || !/^[0-9]+:[A-Za-z0-9_-]+$/.test(token)) throw new Error("Invalid Telegram bot credential");
 const botId = token.split(":")[0]!;
 let pairing = config.pairingPath ? readPairing(config.pairingPath, botId) : undefined;
 const authorization = () => {
  if (config.pairingPath) pairing = readPairing(config.pairingPath, botId);
  return { users: new Set([...(config.allowedUserIds ?? []), ...(pairing ? [pairing.userId] : [])]), chats: new Set([...(config.allowedChatIds ?? []), ...(pairing?.chatIds ?? [])]) };
 };
 const receiveCallback = (event: any): Receive => {
  if (!Number.isSafeInteger(event.update_id) || event.update_id < 0) return {status:400};
  const cq = event.callback_query;
  if (cq?.from?.is_bot === true) return {status:200};
  if (typeof cq?.id !== "string" || cq.from?.is_bot !== false || !Number.isSafeInteger(cq.from.id) || !Number.isSafeInteger(cq.message?.chat?.id)) return {status:400};
  const msg = cq.message;
  if (msg.message_thread_id !== undefined && (!Number.isSafeInteger(msg.message_thread_id) || msg.message_thread_id <= 0)) return {status:400};
  const choice = decodeChoice(cq.data);
  if (!choice) return {status:400};
  const user = String(cq.from.id), chat = String(msg.chat.id), topic = String(msg.message_thread_id ?? 0);
  const {users,chats} = authorization();
  if (!users.has(user) || !chats.has(chat)) return {status:403};
  // The webhook reply answers the query for free; polling discards the body, so the answer is issued from prepare there.
  // The keyboard message is remembered so prepare can clear its buttons once the choice is stored.
  const ack = {...(config.mode === "polling" ? {callback: cq.id} : {}), ...(Number.isSafeInteger(msg.message_id) ? {keyboard: String(msg.message_id)} : {})};
  return {status:200,body:{method:"answerCallbackQuery",callback_query_id:cq.id},admission:{message:{channel:"telegram",messageId:String(event.update_id),threadKey:botId+":"+chat+":"+topic+":"+user,userId:user,text:choiceFallbackText(choice),choice},target:{chat,topic,...ack}}};
 };
 const receiveEvent = (event: any): Receive => {
   const { users, chats } = authorization();
   if (event?.callback_query !== undefined) return receiveCallback(event);
   const msg = event?.message;
   if (!Number.isSafeInteger(event?.update_id) || event.update_id < 0) return { status: 400 };
   if (!msg || msg.from?.is_bot !== false || msg.sender_chat) return { status: 200 };
   const attachment = telegramAttachment(msg);
   const text = typeof msg.text === "string" ? msg.text : typeof msg.caption === "string" ? msg.caption : "";
   if (!text.trim() && !attachment.reference && !attachment.error) return { status: 200 };
   if (!Number.isSafeInteger(msg.from.id) || !Number.isSafeInteger(msg.chat?.id) || !Number.isSafeInteger(msg.message_id)) return { status: 400 };
   const user = String(msg.from.id), chat = String(msg.chat.id);
   if (Buffer.byteLength(text) > 16384) return { status: 413 };
   if (msg.message_thread_id !== undefined && (!Number.isSafeInteger(msg.message_thread_id) || msg.message_thread_id <= 0)) return { status: 400 };
   const topic = String(msg.message_thread_id ?? 0);
   const enable = !!pairing && msg.text === "/enable" && (msg.chat.type === "group" || msg.chat.type === "supergroup");
   if (enable) {
    // Enrollment must be an original owner command, never relayed provenance.
    if (Object.keys(msg).some(key => key.startsWith("forward_")) || msg.is_automatic_forward !== undefined || msg.via_bot !== undefined || msg.sender_chat !== undefined) return { status: 403 };
    if (user !== pairing!.userId) return { status: 403 };
    if (!pairing!.chatIds.includes(chat)) {
     if (pairing!.chatIds.length >= 1000) return { status: 403 };
     const next = { ...pairing!, chatIds: [...pairing!.chatIds, chat] };
     persistPairing(config.pairingPath!, next); pairing = next;
    }
   } else if (!users.has(user) || !chats.has(chat)) return { status: 403 };
   const start = !!pairing && user === pairing.userId && msg.chat.type === "private" && /^\/start(?:\s|$)/.test(msg.text);
   return { status: 200, admission: {
    message: { channel: "telegram", messageId: String(event.update_id), threadKey: botId + ":" + chat + ":" + topic + ":" + user, userId: user, text: text || "Please examine the attached file." },
    target: { chat, topic, ...(attachment.reference ? { media: attachment.reference } : {}) }, ...(attachment.error ? { trustedReply: telegramMediaNotice(attachment.error) } : enable ? { trustedReply: "This group is enabled." } : start ? { trustedReply: "You are already paired. Send a message here, or send /enable in a group to enable it." } : {}),
   } };
 };
 // Physical lane: the trusted bot identity and the validated stored destination, never the user and never a parsed threadKey.
 const scheduling: LanePolicy = config.schedulerMode === "global" ? GLOBAL_LANES : {
  policy: "telegram-topic-v1", concurrency: config.concurrency ?? TELEGRAM_DEFAULT_CONCURRENCY,
  lane: (_message, target) => typeof target.chat === "string" && /^-?[0-9]+$/.test(target.chat) && typeof target.topic === "string" && /^[0-9]+$/.test(target.topic)
   ? JSON.stringify(["telegram", botId, target.chat, target.topic]) : undefined,
  // ADR 0057: a message of the same bot/chat/topic/user as the running turn joins it; another user's waits in FIFO order.
  ...(config.steering === "off" ? {} : { steer: (message: InboundMessage, active: InboundMessage) => message.channel === "telegram" && message.threadKey === active.threadKey && message.userId === active.userId }),
 };
 const apiBase = (dependencies.apiBase ?? "https://api.telegram.org") + "/bot" + token;
 /** Progress calls only: bounded, never throwing, and never exposing the token or platform bodies beyond a short description.
  * With the shared gate, a call first waits (bounded) for a permit and is skipped locally without one; a 429 lower bound
  * (the larger of header and body) is reported to the gate before the result returns. */
 const api = async (method: string, body: Record<string, unknown>, signal: AbortSignal, waitSignal: AbortSignal, chat: string, topic: string, track: (p: Promise<unknown>) => void, permits: ApiPermits | undefined, maxWait: number): Promise<TelegramResult> => {
  try {
   // answerCallbackQuery is not a chat write, but it must not be dropped locally like a typing tick: take a write permit.
   const write = method === "sendMessage" || method === "editMessageText" || method === "editMessageReplyMarkup" || method === "answerCallbackQuery";
   let bound: AbortSignal = signal;
   const start: SyncStart<Promise<Response>> = allowed => {
    bound = AbortSignal.any([AbortSignal.timeout(config.requestTimeoutMs ?? 10000), signal]);
    const init: RequestInit = {method:"POST",redirect:"error",headers:{"content-type":"application/json"},body:JSON.stringify(body),signal:bound};
    if (!allowed() || signal.aborted || waitSignal.aborted) return notStarted();
    const raw = fetch(apiBase + "/" + method, init);
    track(raw);
    return {started:true,value:raw};
   };
   const issued = permits ? await permits.progress(chat,write,waitSignal,start,maxWait,topic) : start(()=>true);
   if (!issued.started) return write ? {ok:false,status:429,retryAfterMs:1000,local:true} : {ok:true,local:true};
   const response = await issued.value;
   const header = response.headers.get("retry-after");
   try { if (response.status === 429) permits?.rateLimited(rateLimitDelay(header, null)); }
   catch(error) { await response.body?.cancel(); throw error; }
   let text: string;
   try { text = await readBounded(response, 16384, bound); }
   catch (error) { if (response.status === 429) permits?.rateLimited(rateLimitDelay(header, null)); throw error; }
   let json: { ok?: unknown; result?: unknown; description?: unknown; parameters?: { retry_after?: unknown } } | undefined;
   try { json = JSON.parse(text); } catch { json = undefined; }
   if (response.ok && json?.ok === true) return { ok: true, result: json.result };
   const retry = json?.parameters?.retry_after;
   const hint = typeof retry === "number" ? String(retry) : null;
   const delay = response.status === 429 ? rateLimitDelay(header, hint) : undefined;
   if (delay !== undefined) permits?.rateLimited(delay);
   return { ok: false, status: response.status, ...(delay !== undefined ? { retryAfterMs: delay } : typeof retry === "number" ? { retryAfterMs: retry * 1000 } : {}), ...(typeof json?.description === "string" ? { description: json.description.slice(0, 200) } : {}) };
  } catch { return { ok: false, status: 0 }; }
 };
 let modelControls = true; // Sidecar has no core policy information; the core still authorizes every command.
 const menu = telegramMenu(apiBase, config.requestTimeoutMs ?? 10000, () => modelControls);
 const channel = messagingChannel({ ...config, port: config.port ?? 0, allowedUserIds: config.allowedUserIds ?? [] }, {
  ...(config.mode === "polling" ? { polling: telegramPolling((dependencies.apiBase ?? "https://api.telegram.org") + "/bot" + token, config.requestTimeoutMs ?? 30000, receiveEvent) } : {}),
  startup: menu.startup, health: menu.health,
  name: "telegram", admissionTimeoutMs: 30000, storageIdentity: "telegram:" + botId, replaySafe: false, scheduling,
  // Chat is the write-rate key: every topic of a chat shares its send/edit budget.
  gate: { policy: gatePolicy, clock:dependencies.gateClock, afterReserve:dependencies.afterGateReserve, afterSending:dependencies.afterSendingCommit, key: target => "chat:" + (target.chat ?? "") },
  authorizeStored(message, target) { try { const { users, chats } = authorization(); return message.channel === "telegram" && users.has(message.userId) && chats.has(target.chat!); } catch { return false; } },
  // ADR 0096: the thread key is bot:chat:topic:user, so a woken answer goes back to that chat topic.
  hostRoute(threadKey) {
   const match = /^([^:]+):(-?[0-9]+):([0-9]+):([0-9]+)$/.exec(threadKey);
   if (!match || match[1] !== botId) return undefined;
   return { message: { channel: "telegram", threadKey, userId: match[4]! }, target: { chat: match[2]!, topic: match[3]! } };
  },
  prepare: (() => {
   const media = telegramMedia(dependencies.apiBase ?? "https://api.telegram.org", token, config.requestTimeoutMs ?? 10000);
   return async (message, target, signal, permits) => {
    // A stored button choice: stop the client spinner and drop the inline keyboard so the question cannot be answered
    // twice. Both calls are bounded, gated and best-effort; the execution awaits them, so nothing needs tracking.
    if (message.choice && (target.callback || target.keyboard)) {
     const chat = target.chat!, topic = target.topic ?? "0", wait = gatePolicy.progressWaitMs;
     if (target.callback) await api("answerCallbackQuery", {callback_query_id: target.callback}, signal, signal, "chat:" + chat, topic, () => {}, permits, wait);
     if (target.keyboard) await api("editMessageReplyMarkup", {chat_id: chat, message_id: Number(target.keyboard), reply_markup: {inline_keyboard: []}}, signal, signal, "chat:" + chat, topic, () => {}, permits, wait);
    }
    return media(message, target, signal, permits);
   };
  })(),
  retryAfter(body) { try { const n = JSON.parse(body).parameters?.retry_after; return typeof n === "number" ? String(n) : null; } catch { return null; } },
  receive(request, bytes) {
   const supplied = Buffer.from(request.headers.get("x-telegram-bot-api-secret-token") ?? "");
   const expected = Buffer.from(secret);
   if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return { status: 401 };
   return receiveEvent(JSON.parse(Buffer.from(bytes).toString("utf8")));
  },
  render: (text, asks) => [...renderRichText(text, "telegram"), ...(asks ?? []).map((ask,index,all)=>ASK_PART+JSON.stringify({ask,index,total:all.length}))],
  delivery(target, part) {
   if (part.startsWith(ASK_PART)) {
    const {ask,index,total}: {ask:AskPrompt;index:number;total:number} = JSON.parse(part.slice(ASK_PART.length));
    return {idempotent:false,url:apiBase+"/sendMessage",init:{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:target.chat,parse_mode:"HTML",link_preview_options:{is_disabled:true},text:escapeHtml(Array.from(ask.question).slice(0,150).join(""))+"\n\n"+escapeHtml("버튼으로 답하거나 직접 메시지로 적어 주세요. 응답이 없으면 기본값 「"+ask.default+"」로 진행합니다."),reply_markup:{inline_keyboard:ask.options.map((_,n)=>[{text:choiceLabel(ask,n,index,total),callback_data:encodeChoice(ask.id,n)}])},...(target.topic!=="0"?{message_thread_id:Number(target.topic)}:{})})}};
   }
   return { idempotent: false, url: (dependencies.apiBase ?? "https://api.telegram.org") + "/bot" + token + "/sendMessage", init: {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: target.chat, text: part, parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...(target.topic !== "0" ? { message_thread_id: Number(target.topic) } : {}) }),
   } };
  },
  success(_response, body) { try { return JSON.parse(body).ok === true; } catch { return false; } },
  progress(target, stop, track, permits) {
   if (config.progress === "off" || typeof target.chat !== "string" || !/^-?[0-9]+$/.test(target.chat) || !/^[0-9]+$/.test(target.topic ?? "0")) return undefined;
   // Channel stop aborts every progress call, so a stopped channel issues no late status writes. Each raw request is
   // owned by the execution: its slot is held until the request itself settles, not merely until finish's budget.
   // The permit wait is part of the same tracked operation and ends at the seal/stop abort (finish budget preserved).
   // The final edit also waits (bounded) for the gate: its physical margins exceed the reporter's nominal final gap,
   // so a zero wait would silently drop the final status edit.
   const key = "chat:" + target.chat;
   const topic=target.topic ?? "0";
   const unregister=permits?.registerTyping(key,topic) ?? (()=>{});
   const waiting=new AbortController();
   let finishing=false, sealed=false, busy=false;
   const seal=()=>{sealed=true;waiting.abort();unregister();};
   stop.addEventListener("abort",seal,{once:true});
   if(stop.aborted)seal();
   const reporter=telegramProgress({call:(method,body,signal)=>{
    if(sealed || busy) return Promise.resolve({ok:false,status:0});
    busy=true;
    const network=signal?AbortSignal.any([signal,stop]):stop;
    const wait=finishing?network:AbortSignal.any([network,waiting.signal]);
    const operation=api(method,body,network,wait,key,topic,track,permits,gatePolicy.progressWaitMs).finally(()=>{busy=false;});
    track(operation);
    return operation;
   },chat:target.chat,topic,detailed:config.progress!=="status"});
   return {...reporter,finish(outcome){
    finishing=true;waiting.abort();unregister();
    return reporter.finish(outcome).finally(()=>{seal();stop.removeEventListener("abort",seal);});
   }};
  },
 });
 return { ...channel, async start(handler, _nativeHandler, controls) { authorization(); modelControls = controls?.modelControls !== false; await channel.start(handler); }, storagePaths: Object.freeze([...channel.storagePaths!, ...(config.botTokenFile ? [config.botTokenFile] : []), ...(config.pairingPath ? [config.pairingPath] : [])]) };
}

function readBotToken(path: string): string { return readPrivateFile(path, 1024).trim(); }

type Pairing = { botId: string; userId: string; chatIds: string[] };
function readPairing(path: string, botId: string): Pairing {
 try {
  const value = JSON.parse(readPrivateFile(path, 65536));
  if (value?.botId !== botId || typeof value.userId !== "string" || !/^[0-9]+$/.test(value.userId) || !Array.isArray(value.chatIds) || value.chatIds.length > 1000 || !value.chatIds.every((id: unknown) => typeof id === "string" && /^-?[0-9]+$/.test(id))) throw new Error();
  return { botId, userId: value.userId, chatIds: value.chatIds };
 } catch { throw new Error("Invalid or unavailable Telegram pairing file"); }
}
function persistPairing(path: string, pairing: Pairing): void {
 const temporary = path + "." + crypto.randomUUID() + ".tmp";
 try {
  createPrivateFile(temporary, JSON.stringify(pairing) + "\n");
  renameSync(temporary, path);
  syncPrivateDirectory(dirname(path));
 } catch { throw new Error("Unable to persist Telegram pairing"); }
 finally { try { unlinkSync(temporary); } catch {} }
}
