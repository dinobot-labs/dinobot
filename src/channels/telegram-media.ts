import { notStarted, type ApiPermits, type SyncStart } from "./api-gate.ts";
import { readBounded, readBoundedBytes, telegramRateLimitDelay } from "./messaging.ts";
import { MESSAGE_IMAGE_LIMITS } from "../core/message-images.ts";
import { IMAGE_LIMITS, imageMime, imagePixelsFit } from "../extensions/images.ts";
import type { BotReply, InboundMessage } from "./types.ts";

import { FILE_BYTES, fileLabel, fileMime } from "../core/message-files.ts";

const IMAGE_BYTES = MESSAGE_IMAGE_LIMITS.maxBytesPerImage;
const TEXT_BYTES = 100 * 1024; // Inline interpretation budget, not receipt limit.
const CAPTION_UNITS = 1024;
const NAME_UNITS = 128;
const ATTACHMENT_PREFIX = "Attached file message:\n";
const DOCUMENT_PREFIX = "\n\n[Attached UTF-8 document: ";
export const TELEGRAM_MESSAGE_PREFIX = "Telegram message:\n";
// UTF-8 document units cannot exceed its byte bound; framing has its own budget.
const DOCUMENT_UNITS = TEXT_BYTES + CAPTION_UNITS + NAME_UNITS + ATTACHMENT_PREFIX.length + DOCUMENT_PREFIX.length + 2;
export const TELEGRAM_INPUT_UNITS = DOCUMENT_UNITS + TELEGRAM_MESSAGE_PREFIX.length;
const validName = (name: unknown): name is string => typeof name === "string" && name.length <= NAME_UNITS && !/[\x00-\x1f\x7f/\\]/.test(name);
const notice = (reason: string): Extract<BotReply,{status:"answered"}> => ({status:"answered",text:"⚠️ 첨부파일을 처리하지 못했습니다: "+reason});
const supported = "파일 종류와 관계없이 20 MiB 이하를 보내 주세요. 원본을 저장하며, 가능한 이미지 미리보기·작은 UTF-8 텍스트만 함께 전달합니다. 파일은 자동 실행하지 않습니다.";
type Reference = { kind: "image" | "text" | "file"; id: string; name: string; mimeType?: string; document?: boolean };
const validId = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{1,512}$/.test(id);
const sizeFits = (size: unknown, limit: number) => size === undefined || (Number.isSafeInteger(size) && (size as number) >= 0 && (size as number) <= limit);
export function telegramAttachment(msg: any): { reference?: string; error?: string } {
 const direct = directAttachment(msg);
 // Never merge attachments or bypass a rejected top-level attachment.
 if (direct.reference || direct.error) return direct;
 const reply = msg.reply_to_message;
 if (!reply || !["photo","document","voice","audio","video","video_note","animation","sticker"].some(key => reply[key] !== undefined)) return {};
 // Reply provenance never authorizes a user or selects the destination. Require the current chat/topic.
 if (!Number.isSafeInteger(reply.message_id) || reply.message_id <= 0 ||
     !Number.isSafeInteger(msg.chat?.id) || reply.chat?.id !== msg.chat.id ||
     (reply.message_thread_id ?? 0) !== (msg.message_thread_id ?? 0)) return {error:supported};
 const selected = directAttachment(reply);
 if (selected.reference && JSON.parse(selected.reference).kind === "image") return selected;
 return {error:supported};
}
function directAttachment(msg: any): { reference?: string; error?: string } {
 if (Array.isArray(msg.photo)) {
  const photos = msg.photo.filter((p: any)=>validId(p?.file_id) && sizeFits(p.file_size,FILE_BYTES));
  const p = photos.sort((a: any,b: any)=>b.width*b.height-a.width*a.height)[0];
  return p ? {reference:JSON.stringify({kind:"image",id:p.file_id,name:"photo"})} : {error:supported};
 }
 if (msg.document) {
  const d = msg.document, name = typeof d.file_name === "string" ? d.file_name : "";
  const image = /\.(png|jpe?g|gif|webp)$/i.test(name);
  const text = /\.(txt|md|csv|json|xml|ya?ml|log|ts|js|py|html|css)$/i.test(name) && (!d.mime_type || /^(text\/|application\/(json|xml|yaml))/.test(d.mime_type));
  if (validName(name) && (image || text)) {
   if (!validId(d.file_id) || !sizeFits(d.file_size,FILE_BYTES)) return {error:supported};
   return {reference:JSON.stringify({kind:image?"image":"text",id:d.file_id,name,mimeType:fileMime(d.mime_type),document:true})};
  }
  return generic(d);
 }
 for (const key of ["voice","audio","video","video_note","animation","sticker"]) if (msg[key]!==undefined) return generic(msg[key]);
 return {};
}

function generic(d: any): { reference?: string; error?: string } {
 if (!d || !validId(d.file_id) || !sizeFits(d.file_size,FILE_BYTES)) return {error:supported};
 return {reference:JSON.stringify({kind:"file",id:d.file_id,name:fileLabel(d.file_name,"attachment"),mimeType:fileMime(d.mime_type)})};
}

/** File references stay adapter-private in the durable target. No disk writes or user-controlled URLs. */
export function telegramMedia(base: string, token: string, timeout: number) {
 return async (message: InboundMessage, target: Record<string,string>, signal: AbortSignal, permits?: ApiPermits): Promise<InboundMessage | BotReply> => {
  if (!target.media) return message;
  const captionUnits = message.text.length;
  // Attachment captions are data, never native slash controls.
  if (message.text.startsWith("/")) message = {...message,text:ATTACHMENT_PREFIX+message.text};
  const bounded = AbortSignal.any([signal,AbortSignal.timeout(timeout)]);
  async function request(url: string, init: RequestInit, limit: number): Promise<Buffer> {
   const owned: Promise<Response>[] = [];
   const start: SyncStart<Promise<Response>> = allowed => {
    if (!allowed() || bounded.aborted) return notStarted();
    const raw = fetch(url,{...init,redirect:"error",signal:bounded});
    owned.push(raw);
    void raw.catch(()=>{});
    return {started:true,value:raw};
   };
   try {
   let issued = permits ? await permits.poll(bounded,start) : start(()=>true);
   // The transport owns a singleton poll waiter. Contention is not a failed attachment: retry admission, never
   // fetch without a permit. The attachment deadline/stop bounds this wait and active engine slots bound waiters.
   while (!issued.started) {
    bounded.throwIfAborted();
    await new Promise<void>(resolve=>{
     const done=()=>{clearTimeout(timer);bounded.removeEventListener("abort",done);resolve();};
     const timer=setTimeout(done,25);bounded.addEventListener("abort",done,{once:true});
     if(bounded.aborted)done();
    });
    bounded.throwIfAborted();
    issued = permits ? await permits.poll(bounded,start) : start(()=>true);
   }
   const response = await issued.value;
   if (!response.ok) {
    if (response.status === 429) {
     permits?.rateLimited(telegramRateLimitDelay(response.headers.get("retry-after"),null));
     let hint: string | null = null;
     const text = await readBounded(response,16384,bounded);
     try { const n=JSON.parse(text).parameters?.retry_after; if(typeof n==="number")hint=String(n); } catch {}
     permits?.rateLimited(telegramRateLimitDelay(response.headers.get("retry-after"),hint));
    } else await response.body?.cancel();
    throw new Error("download");
   }
   return await readBoundedBytes(response,limit,bounded);
   } finally {
    // A gate/store may throw after fetch was started. Retain the raw request until it settles, then cancel its
    // unconsumed body. The engine tracks this whole prepare operation, including this cleanup.
    const settled = await Promise.allSettled(owned);
    for (const result of settled) if (result.status === "fulfilled") await result.value.body?.cancel().catch(()=>{});
   }
  }
  try {
   const ref = JSON.parse(target.media) as Reference;
   if (!validId(ref.id) || !["image","text","file"].includes(ref.kind) || !validName(ref.name)) throw new Error("reference");
   const metadata = JSON.parse((await request(base+"/bot"+token+"/getFile",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({file_id:ref.id})},16384)).toString("utf8"));
   const path = metadata.result?.file_path;
   if (metadata.ok!==true || typeof path!=="string" || path.length>512 || /[\x00-\x1f\x7f\\]/.test(path) || path.split("/").length<2 || path.split("/").some((p:string)=>!p || p==="." || p==="..")) throw new Error("path");
   const limit = FILE_BYTES; // All kinds share the same actual streamed receipt bound.
   if (!sizeFits(metadata.result?.file_size,limit)) throw new Error("size");
   const bytes = await request(base+"/file/bot"+token+"/"+path.split("/").map(encodeURIComponent).join("/"),{},limit);
   bounded.throwIfAborted();
   // Receipt is independent of interpretation. Always hand original bytes to core-owned storage.
   const received: InboundMessage = {...message,files:[{name:ref.name,mimeType:fileMime(ref.mimeType),data:bytes.toString("base64")}]};
   try {
    if (ref.kind==="image") {
     if (!imageMime(bytes)) throw new Error("image");
     const decoder = new Bun.Image(bytes,{maxPixels:IMAGE_LIMITS.maxPixels});
     const dimensions = await decoder.metadata();
     if (!imagePixelsFit(dimensions.width,dimensions.height)) throw new Error("pixels");
     const png = await decoder.png().bytes();
     bounded.throwIfAborted();
     if (png.length>IMAGE_BYTES) throw new Error("decoded_size");
     return {...received,images:[{mimeType:"image/png",data:Buffer.from(png).toString("base64")}]};
    }
    if (ref.kind!=="text" || bytes.length>TEXT_BYTES || captionUnits>CAPTION_UNITS) return received;
    // Expose a leading BOM as U+FEFF so re-encoding preserves every document byte.
    const text = new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(bytes);
    if (!text.trim() || text.includes("\0")) throw new Error("text");
    const combined = message.text+DOCUMENT_PREFIX+ref.name+"]\n"+text;
    if (combined.length > DOCUMENT_UNITS) throw new Error("text_size");
    return {...received,text:combined};
   } catch {
    // Decoder/pixel/output/UTF-8 failures only omit the optional interpretation.
    bounded.throwIfAborted();
    return received;
   }
  } catch {
   signal.throwIfAborted();
   return notice("다운로드 또는 수신 크기 검증에 실패했습니다. "+supported);
  }
 };
}
export const telegramMediaNotice = (reason: string) => notice(reason).text;
