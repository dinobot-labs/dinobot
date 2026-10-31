import type { SlackFetch } from "../../setup/slack.ts";

export type Data = Record<string, any>;
export const READ_METHODS = new Set(["conversations.list", "conversations.history", "conversations.replies", "search.messages", "files.info", "chat.getPermalink"]);
const SEND_METHODS = new Set(["chat.postMessage", "files.getUploadURLExternal", "files.completeUploadExternal"]);
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export class SlackRateLimit extends Error {
 constructor(readonly retryAt: number) { super("Slack rate limited; retry after the reported time"); }
}
export function slackFileUrl(raw: unknown): string {
 if (typeof raw !== "string") throw new Error("Missing Slack file URL");
 const u = new URL(raw);
 if (u.protocol !== "https:" || u.hostname !== "files.slack.com" || u.port || u.username || u.password || u.hash) throw new Error("Untrusted Slack file URL");
 return u.href;
}
export async function boundedBytes(response: Response, limit: number): Promise<Uint8Array> {
 if (Number(response.headers.get("content-length")) > limit) throw new Error("Response too large");
 const reader = response.body?.getReader();
 if (!reader) return new Uint8Array();
 const chunks: Uint8Array[] = []; let size = 0;
 try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > limit) throw new Error("Response too large"); chunks.push(value); } }
 finally { await reader.cancel(); }
 const out = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; } return out;
}
/** All credentials stay here; callers choose predeclared methods, never arbitrary URLs. */
export class SlackPersonalClient {
 private retryAt = 0;
 constructor(private readonly user: string | undefined, private readonly bot: string, private readonly fetcher: SlackFetch = (url, init) => fetch(url, init), private readonly now = Date.now) {}
 private signal(signal?: AbortSignal): AbortSignal { return signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000); }
 async request(method: string, args: Data = {}, signal?: AbortSignal): Promise<Data> {
  const read = READ_METHODS.has(method);
  if (!this.user && method === "search.messages") throw new Error("Slack search requires optional read-only user token; bot history/list remain available");
  if (!read && !SEND_METHODS.has(method)) throw new Error("Slack method not allowed");
  if (this.now() < this.retryAt) throw new SlackRateLimit(this.retryAt);
  let response: Response;
  try { response = await this.fetcher("https://slack.com/api/" + method, { method: "POST", redirect: "error", headers: { authorization: "Bearer " + (read ? this.user ?? this.bot : this.bot), "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(Object.entries(args).filter(([,v]) => v !== undefined).map(([k,v]): [string, string] => [k, typeof v === "object" ? JSON.stringify(v) : String(v)])).toString(), signal: this.signal(signal) }); }
  catch { throw new Error("Slack network request failed"); }
  if (response.status === 429) {
   const seconds = Number(response.headers.get("retry-after"));
   this.retryAt = this.now() + (Number.isFinite(seconds) && seconds > 0 ? Math.max(1, seconds) : 60) * 1000;
   throw new SlackRateLimit(this.retryAt);
  }
  if (!response.ok) throw new Error("Slack HTTP " + response.status);
  let data: Data;
  try { data = JSON.parse(new TextDecoder().decode(await boundedBytes(response, 2 * 1024 * 1024))); } catch { throw new Error("Invalid or oversized Slack response"); }
  if (!data || data.ok !== true) {
   const code = ["invalid_auth", "token_revoked", "missing_scope", "channel_not_found", "not_in_channel", "file_not_found", "account_inactive"].includes(data?.error) ? data.error : "api_error";
   throw new Error("Slack " + code);
  }
  return data;
 }
 async pages(method: string, args: Data, maxPages = 1, signal?: AbortSignal): Promise<Data> {
  if (!["conversations.list", "conversations.history", "conversations.replies"].includes(method)) throw new Error("Not a cursor method");
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 5) throw new Error("maxPages must be 1..5");
  const field = method === "conversations.list" ? "channels" : "messages";
  const items: Data[] = []; let cursor = typeof args.cursor === "string" ? args.cursor : ""; const seen = new Set<string>(); let pages = 0;
  for (; pages < maxPages; ) {
   const data = await this.request(method, { ...args, limit: 15, cursor }, signal); pages++;
   if (!Array.isArray(data[field])) throw new Error("Invalid Slack page");
   items.push(...data[field]);
   cursor = typeof data.response_metadata?.next_cursor === "string" ? data.response_metadata.next_cursor.trim() : "";
   if (!cursor) return { [field]: items, nextCursor: "", complete: data.has_more !== true, pages };
   if (seen.has(cursor)) throw new Error("Repeated Slack cursor"); seen.add(cursor);
  }
  return { [field]: items, nextCursor: cursor, complete: false, pages };
 }
 async download(fileId: string, signal?: AbortSignal): Promise<Uint8Array> {
  const file = (await this.request("files.info", { file: fileId }, signal)).file;
  if (!file || Number(file.size) > MAX_FILE_BYTES) throw new Error("File missing or too large");
  const url = slackFileUrl(file.url_private_download ?? file.url_private);
  let response: Response;
  try { response = await this.fetcher(url, { redirect: "error", headers: { authorization: "Bearer " + (this.user ?? this.bot) }, signal: this.signal(signal) }); } catch { throw new Error("Slack file download failed"); }
  if (!response.ok) throw new Error("Slack file HTTP " + response.status);
  return boundedBytes(response, MAX_FILE_BYTES);
 }
 async upload(name: string, bytes: Uint8Array, channel: string, signal?: AbortSignal): Promise<Data> {
  if (!bytes.length || bytes.length > MAX_FILE_BYTES) throw new Error("File must be 1 byte..10 MiB");
  const opened = await this.request("files.getUploadURLExternal", { filename: name, length: bytes.length }, signal);
  const url = slackFileUrl(opened.upload_url);
  if (typeof opened.file_id !== "string") throw new Error("Missing Slack file ID");
  let response: Response;
  // Signed upload URL needs no bearer token; never forward either token here.
  try { response = await this.fetcher(url, { method: "POST", redirect: "error", body: new Blob([new Uint8Array(bytes)]), signal: this.signal(signal) }); } catch { throw new Error("Slack file upload failed"); }
  if (!response.ok) throw new Error("Slack upload HTTP " + response.status);
  return this.request("files.completeUploadExternal", { files: [{ id: opened.file_id, title: name }], channel_id: channel }, signal);
 }
}
