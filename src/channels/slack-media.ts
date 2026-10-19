import { readBoundedBytes, rateLimitDelay } from "./messaging.ts";
import { MESSAGE_IMAGE_LIMITS } from "../core/message-images.ts";
import { IMAGE_LIMITS, imageMime, imagePixelsFit } from "../extensions/images.ts";
import type { BotReply, InboundMessage, InboundImage } from "./types.ts";

// Injection replaces transport only: tests cannot weaken production destination validation.
type Dependencies = { fetch?: typeof fetch; timeout?: number };
const API = "https://slack.com/api/";
const TEXT_BYTES = 64 * 1024;
const UPLOAD_BYTES = 256 * 1024;
const notice = "⚠️ Attachment could not be processed. Send at most 4 PNG/JPEG/GIF/WebP images (2 MiB each) or UTF-8 text/code files (64 KiB each; 256 KiB total).";
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const fileId = (id: unknown): id is string => typeof id === "string" && /^F[A-Z0-9]{1,63}$/.test(id);
const safeName = (name: unknown): name is string => typeof name === "string" && name.length > 0 && name.length <= 128 && !/[\x00-\x1f\x7f/\\]/.test(name);
const fits = (size: unknown, limit: number) => size === undefined || (Number.isSafeInteger(size) && (size as number) >= 0 && (size as number) <= limit);
const imageTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
function kind(file: Record<string, unknown>): "image" | "text" | undefined {
 const mime = typeof file.mimetype === "string" ? file.mimetype.toLowerCase() : "";
 if (imageTypes.has(mime)) return "image";
 if (safeName(file.name) && /\.(txt|md|csv|json|xml|ya?ml|log|[cm]?[jt]sx?|py|html|css|sh|rs|go|c|h|cpp|sql|toml|ini)$/i.test(file.name) &&
  (/^text\/[a-z0-9.+-]+$/.test(mime) || /^(application\/(json|xml|yaml|x-yaml|javascript|x-javascript))$/.test(mime))) return "text";
}

/** Durable target.media contains only IDs, never event URLs, credentials or file bytes. */
export function slackAttachments(event: unknown): { reference?: string; error?: string } {
 const files = object(event).files;
 if (files === undefined) return {};
 if (!Array.isArray(files) || files.length > 4) return {error:notice};
 if (!files.length) return {};
 const ids: string[] = [];
 for (const value of files) {
  const file = object(value);
  if (!fileId(file.id)) return {error:notice};
  // Some file_share events contain only IDs; fetch authoritative metadata at preparation.
  if (file.mimetype !== undefined && !kind(file)) return {error:notice};
  if (file.size !== undefined && !fits(file.size, kind(file) === "text" ? TEXT_BYTES : MESSAGE_IMAGE_LIMITS.maxBytesPerImage)) return {error:notice};
  ids.push(file.id);
 }
 return {reference:JSON.stringify(ids)};
}

function privateURL(value: unknown): string {
 if (typeof value !== "string" || value.length > 4096 || !value.startsWith("https://files.slack.com/")) throw new Error("url");
 const url = new URL(value);
 if (url.protocol !== "https:" || url.hostname !== "files.slack.com" || url.username || url.password || url.port || url.hash) throw new Error("url");
 return url.href;
}
function lifetime(signal: AbortSignal, timeout: number): AbortSignal {
 return AbortSignal.any([signal, AbortSignal.timeout(Number.isFinite(timeout) && timeout > 0 ? Math.min(Math.floor(timeout), 120000) : 30000)]);
}
class FileRequestError extends Error {
 constructor(readonly status: number, readonly retryAfter?: string) { super("file_request"); }
}
async function request(transport: typeof fetch, url: string, init: RequestInit, limit: number, signal: AbortSignal): Promise<Buffer> {
 signal.throwIfAborted();
 let response: Response;
 try { response = await transport(url,{...init,redirect:"error",signal}); } catch { throw new FileRequestError(503); }
 if (response.status === 429) {
  let hint: string | null = null;
  try { const data=JSON.parse((await readBoundedBytes(response,16384,signal)).toString("utf8")); if (typeof data.retry_after === "number") hint=String(data.retry_after); } catch { /* Header still supplies a lower bound. */ }
  throw new FileRequestError(429,String(rateLimitDelay(response.headers.get("retry-after"),hint)/1000));
 }
 if (!response.ok || response.redirected) { await response.body?.cancel(); throw new FileRequestError(response.status >= 500 ? 503 : 400); }
 try { return await readBoundedBytes(response,limit,signal); } catch { throw new FileRequestError(503); }
}
async function api(transport: typeof fetch, token: string, method: string, body: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
 const bytes = await request(transport,API+method,{method:"POST",headers:{authorization:"Bearer "+token,"content-type":"application/json"},body:JSON.stringify(body)},65536,signal);
 let result: Record<string,unknown>;
 try { result=object(JSON.parse(bytes.toString("utf8"))); } catch { throw new FileRequestError(503); }
 if (result.ok !== true) throw new FileRequestError(result.ok === false ? 400 : 503);
 return result;
}

export function slackMedia(token: string, timeout: number, dependencies: Dependencies = {}) {
 return async (message: InboundMessage, target: Record<string,string>, signal: AbortSignal): Promise<InboundMessage | BotReply> => {
  if (!target.media) return message;
  const bounded = lifetime(signal,timeout), transport = dependencies.fetch ?? fetch;
  try {
   if (target.media.length > 4096) throw new Error("reference");
   const ids: unknown = JSON.parse(target.media);
   if (!Array.isArray(ids) || !ids.length || ids.length > 4 || !ids.every(fileId)) throw new Error("reference");
   let text = message.text.startsWith("/") ? "Attached file message:\n"+message.text : message.text;
   const images: InboundImage[] = [...(message.images ?? [])];
   let textBytes = 0;
   for (const id of ids) {
    const metadata = await api(transport,token,"files.info",{file:id},bounded);
    const file = object(metadata.file), type = kind(file);
    if (file.id !== id || !type || !safeName(file.name)) throw new Error("metadata");
    const limit = type === "image" ? MESSAGE_IMAGE_LIMITS.maxBytesPerImage : TEXT_BYTES;
    if (!fits(file.size,limit)) throw new Error("size");
    const url = privateURL(file.url_private_download ?? file.url_private);
    const bytes = await request(transport,url,{headers:{authorization:"Bearer "+token}},limit,bounded);
    bounded.throwIfAborted();
    if (type === "image") {
     if (imageMime(bytes) !== file.mimetype) throw new Error("mime");
     const decoder = new Bun.Image(bytes,{maxPixels:IMAGE_LIMITS.maxPixels});
     const dimensions = await decoder.metadata();
     if (!imagePixelsFit(dimensions.width,dimensions.height)) throw new Error("pixels");
     const png = await decoder.png().bytes();
     bounded.throwIfAborted();
     if (png.length > limit || images.length >= 4) throw new Error("image_size");
     images.push({mimeType:"image/png",data:Buffer.from(png).toString("base64")});
    } else {
     const content = new TextDecoder("utf-8",{fatal:true}).decode(bytes);
     textBytes += bytes.length;
     if (!content.trim() || content.includes("\0") || textBytes > UPLOAD_BYTES) throw new Error("text");
     text += "\n\n[Attached UTF-8 document: "+file.name+"]\n"+content;
    }
   }
   bounded.throwIfAborted();
   return {...message,text,...(images.length ? {images} : {})};
  } catch {
   signal.throwIfAborted();
   return {status:"answered",text:notice};
  }
 };
}

/** Three calls, no internal retry. Preserve uncertainty/rate limits for the owner's explicit marked-recovery policy. */
export async function uploadSlackText(token: string, target: {channel:string;thread_ts:string}, text: string, signal: AbortSignal, dependencies: Dependencies = {}): Promise<Response> {
 const bounded = lifetime(signal,dependencies.timeout ?? 30000), transport = dependencies.fetch ?? fetch;
 // Snapshot destinations before asynchronous work (including caller-owned object mutation).
 const channel = target.channel, thread = target.thread_ts;
 try {
  bounded.throwIfAborted();
  const bytes = Buffer.from(text,"utf8");
  if (!bytes.length || bytes.length > UPLOAD_BYTES || !/^[CDG][A-Z0-9]{1,63}$/.test(channel) || !/^\d{1,20}\.\d{1,20}$/.test(thread)) throw new Error("input");
  const filename = "dinobot-response.txt";
  const allocation = await api(transport,token,"files.getUploadURLExternal",{filename,length:bytes.length},bounded);
  if (!fileId(allocation.file_id)) throw new Error("file_id");
  // Slack currently returns files.slack.com/upload/v1/...; do not trust arbitrary *.slack.com.
  const url = privateURL(allocation.upload_url);
  if (!new URL(url).pathname.startsWith("/upload/")) throw new Error("upload_url");
  await request(transport,url,{method:"POST",headers:{"content-type":"application/octet-stream"},body:bytes},16384,bounded);
  const completion = await api(transport,token,"files.completeUploadExternal",{files:[{id:allocation.file_id,title:filename}],channel_id:channel,thread_ts:thread},bounded);
  if (!Array.isArray(completion.files) || !completion.files.some(file => object(file).id === allocation.file_id)) throw new FileRequestError(503);
  bounded.throwIfAborted();
  return Response.json({ok:true,ts:thread});
 } catch (error) {
  // Preserve an observed rate-limit even if the owner timeout interrupted the error body.
  if (!(error instanceof FileRequestError && error.status === 429)) signal.throwIfAborted();
  // A 5xx result is uncertain; only the owner may retry it with a possible-duplicate marker.
  const status=error instanceof FileRequestError ? error.status : 400;
  const headers=error instanceof FileRequestError && error.retryAfter ? {"retry-after":error.retryAfter} : undefined;
  return Response.json({ok:false,error:"file_upload_failed"},{status,...(headers ? {headers} : {})});
 }
}
