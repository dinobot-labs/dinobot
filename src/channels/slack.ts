import { encodeChoice, decodeChoice, choiceLabel, choiceFallbackText } from "./ask-buttons.ts";
import type { AskPrompt } from "./types.ts";
import { renderSlackText, storedSlackText } from "./slack-rich-text.ts";
import { slackProgress } from "./slack-progress.ts";
import { NativeCooldown } from "./native-cooldown.ts";
import { createSlackSocket } from "./slack-socket.ts";
import { slackAttachments, slackMedia, uploadSlackText } from "./slack-media.ts";
import { createHmac, timingSafeEqual } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import { chunks, messagingChannel, messagingProperties, requiredEnv, type MessagingChannel, type Receive } from "./messaging.ts";

const id = (prefix: string) => Type.String({ pattern: "^" + prefix + "[A-Z0-9]{1,63}$" });
const ids = (prefix: string) => Type.Array(id(prefix), { minItems: 1, maxItems: 1000, uniqueItems: true });
const CHANNEL_ID = /^[CDG][A-Z0-9]{1,63}$/;
/** ["*"] alone admits every channel, private channel and DM that Slack delivers to the bot; it never widens allowedUserIds. */
const anyChannel = Type.Tuple([Type.Literal("*")], { description: "[\"*\"] admits every channel and DM the bot receives events from; allowedUserIds still decide who may talk." });
const envName = Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]{0,127}$" });
const timestamp = (value: unknown): value is string => typeof value === "string" && /^[1-9][0-9]{9}\.[0-9]{6}$/.test(value);
export const SlackConfigSchema = Type.Object({
 ...messagingProperties,
 port: Type.Optional(messagingProperties.port),
 transport: Type.Optional(Type.Union([Type.Literal("http"), Type.Literal("socket")])),
 signingSecretEnv: Type.Optional(envName), appTokenEnv: Type.Optional(envName), botTokenEnv: envName,
 deliveryRecovery: Type.Optional(Type.Boolean({ description: "Retry uncertain replies with a visible possible-duplicate marker (default true)." })),
 toolProgress: Type.Optional(Type.Union([Type.Literal("native"), Type.Literal("text"), Type.Literal("off")], { description: "Native plan task cards (default), editable detailed text, or off." })),
 fileReplies: Type.Optional(Type.Boolean({ description: "Send replies over 12000 characters as a UTF-8 text file (default true; files:write required)." })),
 appId: id("A"), teamId: id("T"), botUserId: id("[UW]"),
 allowedUserIds: ids("[UW]"), allowedChannelIds: Type.Union([ids("[CDG]"), anyChannel]),
}, { additionalProperties: false });
export type SlackConfig = Static<typeof SlackConfigSchema>;
/** Explicit injection for local protocol tests; never accepted in manifests. */
export type SlackDependencies = {
 socket?: Parameters<typeof createSlackSocket>[1];
 media?: Parameters<typeof slackMedia>[2];
};
const ASK_PART = "\u0000slack-ask:";
const FILE_PART = "\u0000slack-file:";
const RECOVERED = "♻️ 복구된 응답 — 이전 전송 결과가 불확실하여 중복일 수 있습니다.\n\n";
function markRecovered(part: string): string[] {
 if (part.startsWith(ASK_PART)) return [part];
 if (part.startsWith(FILE_PART)) {
  const text = part.slice(FILE_PART.length);
  const marked = text.startsWith(RECOVERED) ? text : RECOVERED + text;
  return Buffer.byteLength(marked) <= 262144 ? [FILE_PART + marked] : chunks(marked,60000).map(text=>FILE_PART+text);
 }
 const object = storedSlackText(part);
 const text = object.text.startsWith(RECOVERED) ? object.text : RECOVERED + object.text;
 // Plain text deliberately preserves the old rendered payload; never truncate a recovered chunk.
 return chunks(text, 3000).map(text => "\u0000slack:" + JSON.stringify({type:"plain_text",text}));
}

/** HTTP Events API and Socket Mode share validation, durable admission, scope, media and delivery.
 * Native slash commands have no existing thread identity: use @bot /models, /model or /new in a thread. */
export function createSlackChannel(config: SlackConfig, dependencies: SlackDependencies = {}): MessagingChannel {
 if (!Value.Check(SlackConfigSchema, config)) throw new Error("Invalid Slack channel configuration");
 const socketMode = config.transport === "socket";
 if (socketMode ? !config.appTokenEnv : !config.signingSecretEnv) throw new Error("Missing Slack transport credential environment variable");
 const secret = !socketMode ? requiredEnv(config.signingSecretEnv!) : undefined;
 const appToken = socketMode ? requiredEnv(config.appTokenEnv!) : undefined;
 const token = requiredEnv(config.botTokenEnv);
 if (secret !== undefined && !/^[a-fA-F0-9]{32}$/.test(secret)) throw new Error("Invalid Slack signing credential");
 if (appToken !== undefined && (appToken.length > 1024 || !/^xapp-[A-Za-z0-9-]+$/.test(appToken))) throw new Error("Invalid Slack app credential");
 if (token.length > 1024 || !/^xoxb-[A-Za-z0-9-]{1,1019}$/.test(token)) throw new Error("Invalid Slack bot credential");
 const { appId, teamId, botUserId } = config;
 const users = new Set(config.allowedUserIds), channels = new Set<string>(config.allowedChannelIds);
 const everyChannel = channels.size === 1 && channels.has("*");
 // The wildcard still requires a canonical Slack conversation ID; it only drops the per-channel list.
 const channelAllowed = (channel: unknown): channel is string => typeof channel === "string" && (everyChannel ? CHANNEL_ID.test(channel) : channels.has(channel));
 const scope = (channel: string, root: string, user: string) => JSON.stringify([appId, teamId, channel, root, user]);
 const cooldown = new NativeCooldown(target => target.channel!);
 function receiveEnvelope(envelope: any): Receive {
  if (!envelope || typeof envelope !== "object") return {status:400};
  if (envelope.type === "url_verification") {
   if ((envelope.api_app_id !== undefined && envelope.api_app_id !== appId) || (envelope.team_id !== undefined && envelope.team_id !== teamId)) return {status:403};
   return typeof envelope.challenge === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(envelope.challenge) ? {status:200,body:{challenge:envelope.challenge}} : {status:400};
  }
  if (envelope.api_app_id !== appId || envelope.team_id !== teamId) return {status:403};
  if (envelope.type !== "event_callback" || typeof envelope.event_id !== "string" || !/^Ev[A-Z0-9]{1,64}$/.test(envelope.event_id)) return {status:400};
  const event = envelope.event;
  if (!event || (event.type !== "app_mention" && event.type !== "message")) return {status:200};
  if ((event.subtype !== undefined && event.subtype !== "file_share") || event.hidden !== undefined || event.bot_id !== undefined || event.bot_profile !== undefined || event.app_id !== undefined || event.user === botUserId) return {status:200};
  if ((event.team !== undefined && event.team !== teamId) || (event.user_team !== undefined && event.user_team !== teamId) || (event.source_team !== undefined && event.source_team !== teamId)) return {status:403};
  if (!users.has(event.user) || !channelAllowed(event.channel)) return {status:403};
  if (!timestamp(event.ts) || (event.thread_ts !== undefined && !timestamp(event.thread_ts))) return {status:400};
  if (event.type === "message" && !(event.channel_type === "im" && event.channel.startsWith("D")) && event.thread_ts === undefined) return {status:200};
  const attachment = slackAttachments(event);
  if (event.text !== undefined && typeof event.text !== "string") return {status:400};
  const source = event.text ?? "";
  if (Buffer.byteLength(source) > 16384) return {status:413};
  const mention = "<@" + botUserId + ">";
  const text = source.startsWith(mention) && (source.length === mention.length || /^\s/.test(source.slice(mention.length))) ? source.slice(mention.length).trimStart() : source;
  if (!text.trim() && !attachment.reference && !attachment.error) return {status:200};
  const root = event.thread_ts ?? event.ts;
  return {status:200,admission:{
   message:{channel:"slack",messageId:JSON.stringify([event.channel,event.ts]),threadKey:scope(event.channel,root,event.user),userId:event.user,text:text || "첨부파일을 확인해 주세요."},
   target:{channel:event.channel,thread_ts:root,recipient_team_id:teamId,recipient_user_id:event.user,...(attachment.reference ? {media:attachment.reference} : {})},
   ...(attachment.error ? {trustedReply:"⚠️ 첨부파일을 처리하지 못했습니다: " + attachment.error} : {}),
  }};
 }
 function receiveInteraction(payload: any): Receive {
  if (!payload || typeof payload !== "object" || payload.type !== "block_actions") return {status:200};
  if (payload.api_app_id !== appId || payload.team?.id !== teamId) return {status:403};
  const user = payload.user?.id, channel = payload.channel?.id;
  if (typeof user !== "string" || !users.has(user) || user === botUserId || !channelAllowed(channel)) return {status:403};
  if (!Array.isArray(payload.actions) || payload.actions.length !== 1 || payload.actions[0]?.type !== "button") return {status:400};
  const action = payload.actions[0], choice = decodeChoice(action.value);
  const root = payload.message?.thread_ts ?? payload.container?.thread_ts;
  if (!choice || !timestamp(action.action_ts) || !timestamp(root)) return {status:400};
  return {status:200,admission:{message:{channel:"slack",messageId:JSON.stringify(["action",channel,action.action_ts,user]),threadKey:scope(channel,root,user),userId:user,text:choiceFallbackText(choice),choice},target:{channel,thread_ts:root,recipient_team_id:teamId,recipient_user_id:user}}};
 }
 const channel = messagingChannel({...config, port:config.port ?? 0, maxAttempts:config.maxAttempts ?? 3}, {
  cooldown,
  name:"slack",admissionTimeoutMs:2500,storageIdentity:JSON.stringify(["slack",appId,teamId,botUserId]),replaySafe:false,
  ...(config.deliveryRecovery !== false ? {recovery:{maxAgeMs:86400000,maxDelayMs:900000,mark:markRecovered}} : {}),
  authorizeStored(message,target) {
   return message.channel === "slack" && message.userId !== botUserId && users.has(message.userId) && channelAllowed(target.channel) && timestamp(target.thread_ts) && (target.recipient_team_id === undefined || target.recipient_team_id === teamId) && (target.recipient_user_id === undefined || target.recipient_user_id === message.userId) && message.threadKey === scope(target.channel!,target.thread_ts,message.userId);
  },
  prepare:slackMedia(token,config.requestTimeoutMs ?? 10000,dependencies.media),
  // ADR 0096: a thread key names its destination (channel, root ts, user); a woken answer is posted to that thread.
  hostRoute(threadKey) {
   let key: unknown;
   try { key = JSON.parse(threadKey); } catch { return undefined; }
   if (!Array.isArray(key) || key.length !== 5 || key[0] !== appId || key[1] !== teamId) return undefined;
   const [, , channel, root, user] = key as unknown[];
   if (typeof user !== "string" || !users.has(user) || user === botUserId || !channelAllowed(channel) || !timestamp(root)) return undefined;
   return { message: { channel: "slack", threadKey, userId: user }, target: { channel, thread_ts: root as string, recipient_team_id: teamId, recipient_user_id: user } };
  },
  retryAfter(body) { try { const n=JSON.parse(body).retry_after; return typeof n === "number" && Number.isFinite(n) && n >= 0 ? String(n) : null; } catch {return null;} },
  receive(request,bytes) {
   // Socket credentials never authenticate the HTTP endpoint.
   if (!secret) return {status:403};
   const time=request.headers.get("x-slack-request-timestamp") ?? "",signature=request.headers.get("x-slack-signature") ?? "";
   if (!/^[1-9][0-9]{9}$/.test(time) || Math.abs(Date.now()-Number(time)*1000)>300000 || !/^v0=[0-9a-f]{64}$/.test(signature)) return {status:401};
   const expected=createHmac("sha256",secret).update("v0:"+time+":").update(bytes).digest();
   if (!timingSafeEqual(expected,Buffer.from(signature.slice(3),"hex"))) return {status:401};
   const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
   if (contentType === "application/x-www-form-urlencoded") {
    const payload = new URLSearchParams(new TextDecoder("utf-8",{fatal:true}).decode(bytes)).get("payload");
    if (payload !== null) return receiveInteraction(JSON.parse(payload));
   }
   if (contentType !== "application/json") return {status:415,body:{error:"Use @bot /models or @bot /model in the desired thread; native slash commands are unsupported."}};
   return receiveEnvelope(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes)));
  },
  progress:(target,stop,track)=>slackProgress(target,token,stop,track,cooldown,config.toolProgress ?? "native"),
  render:(text, asks)=>[...(config.fileReplies !== false && text.length > 12000 ? [FILE_PART+text] : renderSlackText(text)), ...(asks ?? []).map((ask,index,all)=>ASK_PART+JSON.stringify({ask,index,total:all.length}))],
  delivery(target,part) {
   if (part.startsWith(ASK_PART)) {
    const {ask,index,total}: {ask:AskPrompt;index:number;total:number} = JSON.parse(part.slice(ASK_PART.length));
    const question = Array.from(ask.question).slice(0,150).join("");
    // Slack context text is limited to 2000 characters; the stored default may itself be 2000.
    const defaultPoints = Array.from(ask.default);
    const displayedDefault = defaultPoints.slice(0,900).join("") + (defaultPoints.length > 900 ? "…" : "");
    return {idempotent:false,url:"https://slack.com/api/chat.postMessage",init:{method:"POST",headers:{authorization:"Bearer "+token,"content-type":"application/json"},body:JSON.stringify({channel:target.channel,thread_ts:target.thread_ts,text:question+" — 버튼으로 답하거나 이 스레드에 직접 적어 주세요.",blocks:[
     {type:"section",text:{type:"plain_text",text:question,emoji:false}},
     {type:"actions",block_id:"dinobot_ask_"+index,elements:ask.options.map((option,n)=>({type:"button",action_id:"dinobot_ask_"+index+"_"+n,text:{type:"plain_text",text:choiceLabel(ask,n,index,total),emoji:false},value:encodeChoice(ask.id,n),...(option===ask.default?{style:"primary"}:{})}))},
     {type:"context",elements:[{type:"plain_text",text:"응답이 없으면 기본값 「"+displayedDefault+"」로 진행합니다. 직접 답하려면 메시지로 적어 주세요.",emoji:false}]}
    ],mrkdwn:false,link_names:false,parse:"none",unfurl_links:false,unfurl_media:false})}};
   }
   if (part.startsWith(FILE_PART)) return {idempotent:false,url:"https://slack.com/api/files.completeUploadExternal",init:{},execute:(signal:AbortSignal)=>uploadSlackText(token,{channel:target.channel!,thread_ts:target.thread_ts!},part.slice(FILE_PART.length),signal,dependencies.media)};
   const object=storedSlackText(part),text=object.text;
   return {idempotent:false,url:"https://slack.com/api/chat.postMessage",init:{method:"POST",headers:{authorization:"Bearer "+token,"content-type":"application/json"},body:JSON.stringify({channel:target.channel,thread_ts:target.thread_ts,text,blocks:[{type:"section",text:object}],mrkdwn:false,link_names:false,parse:"none",unfurl_links:false,unfurl_media:false})}};
  },
  success(response,body) {try {const result=JSON.parse(body);return response.status===200 && result.ok===true && timestamp(result.ts);} catch {return false;}},
 });
 if (!appToken) return channel;
 const socket=createSlackSocket({appToken,requestTimeoutMs:config.requestTimeoutMs ?? 10000,receive:payload=>channel.admitAuthenticated!(receiveEnvelope(payload)),receiveInteractive:payload=>channel.admitAuthenticated!(receiveInteraction(payload))},dependencies.socket);
 let stopped = true;
 return {...channel,
  health:()=>({...channel.health(),...socket.health()}),
  async start(handler) {
   stopped=false;
   await channel.start(handler);
   if (stopped) {await channel.stop();return;}
   try {await socket.start();} catch(error) {await socket.stop();await channel.stop();throw error;}
  },
  async stop() {stopped=true;await socket.stop();await channel.stop();},
 };
}
