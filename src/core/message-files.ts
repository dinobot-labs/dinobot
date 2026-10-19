import { mkdir, lstat, mkdtemp, open, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { InboundFile, InboundMessage } from "../channels/types.ts";

export class AttachmentStorageError extends Error {}
export const FILE_BYTES = 20 * 1024 * 1024;
/** Display metadata only. Never used to construct a path or interpreted as MIME authority. */
export function fileLabel(value: unknown, fallback: string): string {
 return typeof value === "string" && value.length > 0
  ? value.replace(/[\x00-\x1f\x7f/\\\u202a-\u202e\u2066-\u2069]/g, "_").slice(0,128) : fallback;
}
export function fileMime(value: unknown): string {
 return typeof value === "string" && value.length ? value.replace(/[\x00-\x1f\x7f]/g,"_").slice(0,128) : "application/octet-stream";
}
export function parseInboundFiles(value: unknown): readonly InboundFile[] | string {
 if (value === undefined) return [];
 if (!Array.isArray(value) || value.length > 1) return "at most one file per message";
 const files: InboundFile[] = [];
 for (const file of value) {
  if (!file || typeof file !== "object" || typeof file.data !== "string" || file.data.length > Math.ceil(FILE_BYTES/3)*4) return "invalid file bytes";
  const bytes = Buffer.from(file.data,"base64");
  if (bytes.length > FILE_BYTES || bytes.toString("base64") !== file.data) return "invalid file bytes";
  files.push({name:fileLabel(file.name,"attachment"),mimeType:fileMime(file.mimeType),data:file.data});
 }
 return files;
}
/** Core-local publication in a trusted host workspace: sidecars transfer bytes, never paths.
 * Retained with conversation data (not temporary reports). Windows inherits the workspace ACL;
 * POSIX uses 0700 directories/0600 files. No parser, extraction, or execution is invoked. */
export async function materializeFiles(message: InboundMessage, workspace: string): Promise<InboundMessage> {
 const files = parseInboundFiles(message.files);
 if (typeof files === "string") throw new Error(files);
 if (!files.length) return message;
 let directory: string | undefined;
 try {
  let parent = resolve(workspace);
  for (const component of [".dinobot", "attachments"]) {
   parent = join(parent,component);
   await mkdir(parent,{mode:0o700}).catch(error=>{if(error.code!=="EEXIST")throw error;});
   const stat = await lstat(parent);
   if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== "win32" && (stat.mode & 0o022) !== 0)) throw new Error("unsafe attachment directory");
  }
  directory = await mkdtemp(join(parent,"incoming-"));
  const file = files[0]!;
  const bytes = Buffer.from(file.data,"base64");
  // Constant basename and random directory: no extension, traversal, collision or executable bit.
  const path = join(directory,"attachment.bin");
  const handle = await open(path,"wx",0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  const metadata = {name:file.name,mimeType:file.mimeType,size:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex"),path};
  const { files: _files, ...rest } = message;
  return {...rest,text:message.text+"\n\n[Attached file — untrusted data; not executed. Metadata (JSON):]\n"+JSON.stringify(metadata)};
 } catch {
  if (directory) await rm(directory,{recursive:true,force:true}).catch(()=>{});
  throw new AttachmentStorageError("Attachment storage unavailable");
 }
}
