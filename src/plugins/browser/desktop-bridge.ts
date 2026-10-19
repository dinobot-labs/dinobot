import { lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { request as httpRequest } from "node:http";
import { createPrivateFile, readPrivateFile, syncPrivateDirectory } from "../../telegram-private-files/index.ts";
import { isAction, type Action, type HostReply, type HostResult } from "./shared.ts";

export interface DesktopDescriptor { version: 1; port: number; token: string }
export function validateDescriptor(value: unknown): DesktopDescriptor {
 if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("DesktopBridgeInvalid: invalid descriptor");
 const d = value as Record<string, unknown>;
 if (d.version !== 1 || !Number.isInteger(d.port) || (d.port as number) < 1 || (d.port as number) > 65535 || typeof d.token !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(d.token)) throw new Error("DesktopBridgeInvalid: invalid descriptor");
 return { version: 1, port: d.port as number, token: d.token };
}
export function readDesktopDescriptor(path: string): DesktopDescriptor | undefined {
 try { lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new Error("DesktopBridgeInvalid: descriptor unavailable"); }
 try { return validateDescriptor(JSON.parse(readPrivateFile(path, 4096))); }
 catch { throw new Error("DesktopBridgeInvalid: descriptor must be private and valid"); }
}
function refused(error: unknown): boolean {
 const e = error as { code?: string; cause?: unknown };
 return e?.code === "ECONNREFUSED" || (e?.cause !== undefined && refused(e.cause));
}
async function request(d: DesktopDescriptor, cmd: Action, args: Record<string, unknown>, signal?: AbortSignal, timeoutMs = 55_000): Promise<HostResult> {
 const timeout = AbortSignal.timeout(timeoutMs);
 const body = JSON.stringify({ id: 0, cmd, args });
 // node:http connects directly: unlike Bun fetch, it cannot inherit ambient HTTP_PROXY or follow redirects.
 const bytes = await new Promise<Buffer>((resolve, reject) => {
  const req = httpRequest({ hostname: "127.0.0.1", port: d.port, path: "/action", method: "POST", agent: false, maxHeaderSize: 8192,
   headers: { Authorization: `Bearer ${d.token}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
   signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  }, (res) => {
   res.once("error", reject);
   res.once("aborted", () => reject(new Error("DesktopBridgeDisconnected: response interrupted")));
   if (res.statusCode !== 200) { reject(new Error(`DesktopBridgeRejected: HTTP ${res.statusCode}`)); res.destroy(); return; }
   const chunks: Buffer[] = []; let size = 0;
   res.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > 24 * 1024 * 1024) { const error = new Error("DesktopBridgeInvalid: reply too large"); reject(error); req.destroy(error); return; }
    chunks.push(Buffer.from(chunk));
   });
   res.once("end", () => resolve(Buffer.concat(chunks)));
  });
  req.once("error", reject);
  req.end(body);
 });
 let reply: HostReply;
 try { reply = JSON.parse(bytes.toString("utf8")) as HostReply; } catch { throw new Error("DesktopBridgeInvalid: malformed reply"); }
 if (!reply || typeof reply !== "object" || typeof reply.ok !== "boolean") throw new Error("DesktopBridgeInvalid: malformed reply");
 if (!reply.ok) throw new Error(typeof reply.error === "string" ? reply.error.slice(0, 2000) : "DesktopBridgeRejected: action failed");
 if (!reply.result || typeof reply.result.text !== "string" || (reply.result.image !== undefined && (typeof reply.result.image.data !== "string" || !["image/jpeg", "image/png", "image/webp"].includes(reply.result.image.mimeType)))) throw new Error("DesktopBridgeInvalid: malformed result");
 return reply.result;
}

/** Probe only a read-only status. Once an actual action is sent it is NEVER replayed on another browser. */
export async function callDesktop(path: string, cmd: Action, args: Record<string, unknown>, signal?: AbortSignal): Promise<HostResult | undefined> {
 if (!isAction(cmd)) throw new Error("DesktopBridgeRejected: agent UI commands are forbidden");
 signal?.throwIfAborted();
 const d = readDesktopDescriptor(path);
 if (!d) return undefined;
 let status: HostResult;
 try { status = await request(d, "status", {}, signal, 2500); }
 catch (error) { if (!signal?.aborted && refused(error)) return undefined; throw error; }
 if (cmd === "status") return status;
 signal?.throwIfAborted();
 return request(d, cmd, args, signal);
}

/** Child owns descriptor lifetime, but the desktop main process owns the HTTP listener and takeover gate. */
export async function publishDesktopDescriptor(raw: string | undefined): Promise<() => void> {
 if (!raw) return () => {};
 let value: Record<string, unknown>;
 try { value = JSON.parse(raw); } catch { throw new Error("DesktopBridgeInvalid: invalid startup descriptor"); }
 if (!value || typeof value.path !== "string" || !value.path || value.path.length > 4096) throw new Error("DesktopBridgeInvalid: invalid startup path");
 const d = validateDescriptor({ ...value, version: 1 });
 const path = value.path;
 const previous = readDesktopDescriptor(path);
 let stale = false;
 if (previous) {
  try { await request(previous, "status", {}, undefined, 1500); }
  catch (error) {
   if (!refused(error)) throw new Error("DesktopBridgeInUse: existing bridge cannot be safely replaced");
   stale = true;
  }
  if (!stale) throw new Error("DesktopBridgeInUse: another desktop bridge is running");
 }
 mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
 // Serialize the synchronous recheck/remove/exclusive-create across host PROCESSES as well as JS requests.
 // A leftover publication lock is refused, never stolen: its owner may still be publishing.
 const lock = `${path}.publish`;
 try { createPrivateFile(lock, String(process.pid)); }
 catch { throw new Error("DesktopBridgeInUse: descriptor publication is already in progress"); }
 try {
  const current = readDesktopDescriptor(path);
  if (current) {
   if (!stale || !previous || current.port !== previous.port || current.token !== previous.token) throw new Error("DesktopBridgeInUse: descriptor changed");
   unlinkSync(path);
  }
  createPrivateFile(path, JSON.stringify(d));
  syncPrivateDirectory(dirname(path));
 } finally { unlinkSync(lock); syncPrivateDirectory(dirname(path)); }
 return () => {
  try { const current = readDesktopDescriptor(path); if (current?.port === d.port && current.token === d.token) { unlinkSync(path); syncPrivateDirectory(dirname(path)); } } catch { /* Never remove a replaced or unsafe record. */ }
 };
}
