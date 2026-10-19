import { encodeChoice, decodeChoice, choiceLabel, choiceFallbackText } from "./ask-buttons.ts";
import type { AskPrompt } from "./types.ts";
import { hasUnsafeLinks } from "./rich-text.ts";
import { NativeCooldown } from "./native-cooldown.ts";
import { nativeProgress } from "./native-progress.ts";
import { createPublicKey, verify } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import { messagingChannel, messagingProperties, type MessagingChannel, type MessagingDependencies } from "./messaging.ts";

const ASK_PART = "\u0000discord-ask:";
const destinationIds = Type.Array(Type.String({ pattern: "^[0-9]+$" }), { minItems: 1, maxItems: 1000, uniqueItems: true });
export const DiscordConfigSchema = Type.Intersect([Type.Object({
 ...messagingProperties,
 applicationId: Type.String({ pattern: "^[0-9]+$" }),
 publicKey: Type.String({ pattern: "^[0-9a-fA-F]{64}$" }),
 allowedChannelIds: Type.Optional(destinationIds),
 allowedParentChannelIds: Type.Optional(destinationIds),
}, { additionalProperties: false }), Type.Union([
 Type.Object({ allowedChannelIds: destinationIds }),
 Type.Object({ allowedParentChannelIds: destinationIds }),
])]);
export type DiscordConfig = Static<typeof DiscordConfigSchema>;

/** Normalize only the native command vocabulary; never grant generic command privileges. */
function commandText(data: unknown): string | undefined {
 if (!data || typeof data !== "object") return;
 const { name, type, options = [] } = data as Record<string, unknown>;
 if (type !== 1 || (name !== "ask" && name !== "model" && name !== "models" && name !== "new") || !Array.isArray(options)) return;
 if (name === "new") return options.length === 0 ? "/new" : undefined;
 const values = new Map<string, string | number>();
 for (const option of options) {
  if (!option || typeof option !== "object" || Array.isArray(option) ||
   Object.keys(option).some(key => !["name", "type", "value"].includes(key))) return;
  const { name: key, type: kind, value } = option;
  const expected = name === "ask" ? key === "prompt" ? 3 : 0
   : name === "model" ? key === "model" ? 3 : 0
   : key === "provider" ? 3 : key === "page" ? 4 : 0;
  if (!expected || kind !== expected || values.has(key)) return;
  if (expected === 3 ? typeof value !== "string" : typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) return;
  values.set(key, value);
 }
 if (name === "ask") {
  const prompt = values.get("prompt");
  return typeof prompt === "string" && prompt.trim() ? prompt : undefined;
 }
 const argument = values.get(name === "model" ? "model" : "provider");
 if (argument !== undefined) {
  if (typeof argument !== "string" || /\s/.test(argument) || argument.length > (name === "model" ? 256 : 128) ||
   (name === "model" && argument.indexOf("/") > 128) ||
   !(name === "model" ? /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:/-]*$/ : /^(?![0-9]+$)[A-Za-z0-9][A-Za-z0-9._-]*$/).test(argument)) return;
 }
 return "/" + name + (argument === undefined ? "" : " " + argument) + (values.has("page") ? " " + values.get("page") : "");
}

/** Register commands externally: /ask with required STRING prompt; /model with optional
 * STRING model (provider/modelId); /models with optional STRING provider and INTEGER page;
 * /new without options starts a fresh conversation for the invoking user in that channel.
 * In an existing thread (including a forum post), invoke /ask prompt:<text> for each turn.
 * Replies are ephemeral to the invoking user; plain-message Gateway ingestion is unsupported.
 * Parent allowlists admit only signed thread channel types 10/11/12, not the parent itself.
 * HTTPS proxy forwards unmodified bytes and signature headers to POST /webhook.
 * Short answers preserve inline Markdown; long answers attach full UTF-8 answer.txt. Mentions are disabled.
 * PATCH @original is idempotent. Tokens expire 15 minutes after interaction creation.
 */
export function discordChannel(config: DiscordConfig, dependencies: MessagingDependencies = {}): MessagingChannel {
 if (!Value.Check(DiscordConfigSchema, config)) throw new Error("Invalid Discord channel configuration");
 const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(config.publicKey, "hex")]), format: "der", type: "spki" });
 const users = new Set(config.allowedUserIds), channels = new Set(config.allowedChannelIds ?? []);
 const parents = new Set(config.allowedParentChannelIds ?? []);
 const allowedDestination = (channel: unknown, parent: unknown, type: unknown) =>
  typeof channel === "string" && /^[0-9]+$/.test(channel) && (channels.has(channel) ||
   (typeof parent === "string" && parents.has(parent) && (type === "10" || type === "11" || type === "12")));
 const cooldown = new NativeCooldown(target => target.token!);
 return messagingChannel(config, {
  cooldown,
  name: "discord", admissionTimeoutMs: 2000, storageIdentity: "discord:" + config.applicationId, replaySafe: true,
  authorizeStored(message, target) {
   // Legacy rows only stored the token: recover destination from the safe identity, never from a token.
   const identity = typeof message.threadKey === "string" ? /^([0-9]+):([0-9]+):([0-9]+)$/.exec(message.threadKey) : null;
   return message.channel === "discord" && users.has(message.userId) && identity?.[1] === config.applicationId &&
    identity[3] === message.userId && (target.channel === undefined || target.channel === identity[2]) &&
    allowedDestination(identity[2], target.parentChannelId, target.channelType);
  },
  retryAfter(body) { try { const n = JSON.parse(body).retry_after; return typeof n === "number" ? String(n) : null; } catch { return null; } },
  receive(request, bytes) {
   const timestamp = request.headers.get("x-signature-timestamp") ?? "";
   const signature = request.headers.get("x-signature-ed25519") ?? "";
   if (!/^[0-9]{10}$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp) * 1000) > 300000 || !/^[0-9a-fA-F]{128}$/.test(signature) ||
    !verify(null, Buffer.concat([Buffer.from(timestamp), bytes]), key, Buffer.from(signature, "hex"))) return { status: 401 };
   const event = JSON.parse(Buffer.from(bytes).toString("utf8"));
   if (event?.application_id !== config.applicationId) return { status: 403 };
   if (event.type === 1) return { status: 200, body: { type: 1 } };
   const user = event.member?.user ?? event.user;
   if ((event.channel?.id !== undefined && event.channel.id !== event.channel_id) || (user?.bot !== undefined && typeof user.bot !== "boolean")) return { status: 400 };
   // Only authenticated payload metadata can confer parent-based access. Do not coerce a string type.
   const parentChannelId = typeof event.channel?.parent_id === "string" ? event.channel.parent_id : undefined;
   const channelType = typeof event.channel?.type === "number" ? String(event.channel.type) : undefined;
   if (!user || user.bot === true || !users.has(user.id) || !allowedDestination(event.channel_id, parentChannelId, channelType)) return { status: 403 };
   const choice = event.type === 3 && event.data?.component_type === 2 ? decodeChoice(event.data.custom_id) : undefined;
   const prompt = event.type === 2 ? commandText(event.data) : choice ? choiceFallbackText(choice) : undefined;
   if (prompt === undefined) return { status: 400 };
   if (typeof event.id !== "string" || !/^[0-9]{1,20}$/.test(event.id) || typeof event.token !== "string" || !/^[A-Za-z0-9._-]{1,2048}$/.test(event.token)) return { status: 400 };
   const created = Number((BigInt(event.id) >> 22n) + 1420070400000n);
   // Snowflake age cannot be refreshed by replaying an old interaction with a new timestamp.
   if (created > Date.now() + 5000 || created + 900000 <= Date.now()) return { status: 401 };
   if (Buffer.byteLength(prompt) > 16384) return { status: 413 };
   return { status: 200, body: { type: 5, data: { flags: 64 } }, admission: {
    message: { channel: "discord", messageId: event.id, threadKey: config.applicationId + ":" + event.channel_id + ":" + user.id, userId: user.id, text: prompt, ...(choice ? { choice } : {}) },
    target: { token: event.token, channel: event.channel_id,
     ...(parentChannelId === undefined ? {} : { parentChannelId }),
     ...(channelType === undefined ? {} : { channelType }),
    }, expires: created + 900000 - 5000,
   } };
  },
  progress: (target, stop, track) => nativeProgress("discord", target, (dependencies.apiBase ?? "https://discord.com/api/v10") + "/webhooks/" + config.applicationId + "/" + target.token + "/messages/@original", "", stop, track, cooldown),
  render: (text, asks) => asks?.length ? [ASK_PART+JSON.stringify({text,asks})] : [text],
  delivery(target, part) {
   let asks: readonly AskPrompt[] | undefined;
   if (part.startsWith(ASK_PART)) { const decoded = JSON.parse(part.slice(ASK_PART.length)); part = decoded.text; asks = decoded.asks; }
   const components = asks?.map((ask,index)=>({type:1,components:ask.options.map((option,n)=>({type:2,style:option===ask.default?1:2,label:choiceLabel(ask,n,index,asks!.length),custom_id:encodeChoice(ask.id,n)}))}));
   const form = new FormData();
   const inline = part.length <= 2000 && !hasUnsafeLinks(part);
   form.set("payload_json", JSON.stringify({ ...(components ? {components} : {}), content: inline ? part || "(empty response)" : "Response attached as plain text.", allowed_mentions: { parse: [], users: [], roles: [], replied_user: false }, attachments: inline ? [] : [{ id: 0, filename: "answer.txt" }] }));
   if (!inline) form.set("files[0]", new Blob([part], { type: "text/plain; charset=utf-8" }), "answer.txt");
   return { idempotent: true, url: (dependencies.apiBase ?? "https://discord.com/api/v10") + "/webhooks/" + config.applicationId + "/" + target.token + "/messages/@original", init: { method: "PATCH", body: form } };
  },
  success: () => true,
 });
}
