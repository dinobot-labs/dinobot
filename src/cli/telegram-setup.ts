import { randomBytes, timingSafeEqual } from "node:crypto";
import { lstatSync, mkdirSync, linkSync, unlinkSync } from "node:fs";
import { createPrivateFile, readPrivateFile, syncPrivateDirectory } from "../telegram-private-files/index.ts";
import { dirname, resolve } from "node:path";

export interface TelegramSetupDependencies {
 fetch?: (url: string, init: RequestInit) => Promise<Response>;
 now?: () => number;
 sleep?: (ms: number) => Promise<void>;
 output?: (line: string) => void;
}
class SetupError extends Error {}
const usage = "Usage: dinobot telegram connect --token-file PATH --pairing-file PATH [--timeout-seconds 1..900]";
function fail(message: string): never { throw new SetupError(message); }
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const positiveId = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

/** Args begin with connect. No credentials in argv, no implicit owner reset.
 * Only this setup flow creates pairing state; normal transport never learns an owner. */
export async function runTelegramSetup(args: string[], dependencies: TelegramSetupDependencies = {}): Promise<void> {
 try { await connect(args, dependencies); } catch (error) {
  // Never propagate fetch URLs, API descriptions, filesystem paths or credential bytes.
  throw new Error(error instanceof SetupError ? error.message : "Telegram setup failed; check local files and network access.");
 }
}
async function connect(args: string[], dependencies: TelegramSetupDependencies): Promise<void> {
 if ((args.length === 1 && args[0] === "--help") || (args.length === 2 && args[0] === "connect" && args[1] === "--help")) { (dependencies.output ?? console.log)(usage); return; }
 if (args[0] !== "connect") fail(usage);
 const options = new Map<string, string>();
 for (let i = 1; i < args.length; i += 2) {
  const key = args[i]!, value = args[i + 1];
  if (!["--token-file", "--pairing-file", "--timeout-seconds"].includes(key) || options.has(key) || !value || value.startsWith("--")) fail(usage);
  options.set(key, value);
 }
 if (!options.has("--token-file") || !options.has("--pairing-file")) fail(usage);
 const duration = options.get("--timeout-seconds") ?? "300";
 if (!/^[0-9]+$/.test(duration) || Number(duration) < 1 || Number(duration) > 900) fail("Timeout must be an integer from 1 to 900 seconds.");
 const tokenPath = resolve(options.get("--token-file")!), pairingPath = resolve(options.get("--pairing-file")!);
 if (tokenPath === pairingPath) fail("Token and pairing files must be distinct.");
 assertAbsent(pairingPath);
 let token: string;
 try { token = readPrivateFile(tokenPath, 1024).trim(); }
 catch { fail("Token file must be a readable, small regular file owned by the current user with private permissions (POSIX mode 0600 or a private Windows ACL)."); }
 if (!/^[1-9][0-9]{0,19}:[A-Za-z0-9_-]{20,256}$/.test(token!)) fail("Token file has invalid credential format.");
 // Do not echo a credential even if it was also supplied as a path component.
 if (tokenPath.includes(token!) || pairingPath.includes(token!)) fail("Unsafe setup file path.");
 const output = dependencies.output ?? console.log, now = dependencies.now ?? (() => performance.now());
 const sleep = dependencies.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
 const http = dependencies.fetch ?? ((url, init) => fetch(url, init));
 const deadline = now() + Number(duration) * 1000;
 async function api(method: string, parameters: Record<string, unknown> = {}, requestDeadline = deadline): Promise<unknown> {
  const remaining = requestDeadline - now();
  if (remaining <= 0) fail("Telegram pairing timed out; no owner was saved.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(15000, remaining));
  try {
   const url = "https://api.telegram.org/bot" + token! + "/" + method;
   const polling = method === "getUpdates";
   const query = new URLSearchParams(Object.entries(parameters).map(([key, value]): [string, string] => [key, typeof value === "string" ? value : JSON.stringify(value)]));
   const response = await http(polling ? url + "?" + query : url, { method: polling ? "GET" : "POST", redirect: "error", signal: controller.signal, ...(polling ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(parameters) }) });
   if (!response.ok || !response.body) { await response.body?.cancel().catch(() => {}); fail("Telegram API request failed."); }
   const reader = response.body.getReader();
   let size = 0; const chunks: Uint8Array[] = [];
   try {
    while (true) {
     const next = await reader.read(); if (next.done) break;
     size += next.value.length; if (size > 262144) { controller.abort(); fail("Telegram API response exceeds the setup limit."); }
     chunks.push(next.value);
    }
   } finally { try { await reader.cancel().catch(() => {}); } finally { reader.releaseLock(); } }
   const data = record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
   if (data.ok !== true) fail("Telegram API request failed.");
   if (now() >= requestDeadline) fail("Telegram pairing timed out; no owner was saved.");
   return data.result;
  } catch (error) {
   if (error instanceof SetupError) throw error;
   fail("Telegram API request failed or timed out.");
  } finally { clearTimeout(timer); }
 }
 const me = record(await api("getMe"));
 if (!positiveId(me.id) || me.is_bot !== true || typeof me.username !== "string" || !/^[A-Za-z0-9_]{5,32}$/.test(me.username) || String(me.id) !== token!.split(":")[0]) fail("Telegram returned an invalid bot identity.");
 const webhook = record(await api("getWebhookInfo"));
 if (typeof webhook.url !== "string") fail("Telegram returned invalid webhook information.");
 if (webhook.url) fail("Telegram webhook is configured; remove it explicitly before polling setup. No webhook was changed.");
 const code = randomBytes(24).toString("base64url");
 output("Keep this one-time pairing link private. Open it yourself and press Start:");
 output("https://t.me/" + me.username + "?start=" + code);
 output("Or send /start " + code + " in a private chat with this bot.");
 let offset = 0;
 while (now() < deadline) {
  const updates = await api("getUpdates", { offset, limit: 100, timeout: Math.min(10, Math.max(0, Math.floor((deadline - now()) / 1000))), allowed_updates: ["message"] });
  if (!Array.isArray(updates) || updates.length > 100) fail("Telegram returned invalid updates.");
  // Telegram normally returns sorted updates; sort defensively before advancing the cursor.
  const ordered = updates.map(record);
  if (ordered.some(u => !Number.isSafeInteger(u.update_id) || (u.update_id as number) < 0 || (u.update_id as number) >= Number.MAX_SAFE_INTEGER)) fail("Telegram returned invalid updates.");
  ordered.sort((a, b) => (a.update_id as number) - (b.update_id as number));
  for (const update of ordered) {
   const id = update.update_id as number; if (id < offset) continue;
   const message = record(update.message), from = record(message.from), chat = record(message.chat);
   const text = typeof message.text === "string" ? message.text : "";
   const candidate = text.startsWith("/start ") ? text.slice(7) : "";
   const candidateBytes = Buffer.from(candidate), expectedBytes = Buffer.from(code);
   const nonceMatches = candidateBytes.length === expectedBytes.length && timingSafeEqual(candidateBytes, expectedBytes);
   const forwarded = ["forward_origin", "forward_from", "forward_from_chat", "forward_sender_name", "forward_date", "is_automatic_forward"].some(key => key in message);
   offset = id + 1; // Only examined updates are acknowledged on the next request.
   if (!nonceMatches || chat.type !== "private" || from.is_bot !== false || !positiveId(from.id) || chat.id !== from.id || forwarded || "sender_chat" in message || "via_bot" in message) continue;
   if (now() >= deadline) fail("Telegram pairing timed out; no owner was saved.");
   persistPairing(pairingPath, { botId: String(me.id), userId: String(from.id), chatIds: [String(chat.id)] });
   // One bounded confirmation after durable publication. Returned tail updates stay unconfirmed.
   try { await api("getUpdates", { offset: id + 1, limit: 1, timeout: 0, allowed_updates: ["message"] }, now() + 15000); }
   catch { output("Warning: Pairing is saved, but Telegram confirmation failed. Paired state was retained; later updates were not confirmed."); }
   output("Pairing saved. Add this manifest snippet (no manifest was modified):");
   output("channels:\n  telegram:\n    mode: polling\n    botTokenFile: " + JSON.stringify(tokenPath) + "\n    pairingPath: " + JSON.stringify(pairingPath) + "\n    databasePath: " + JSON.stringify(pairingPath + ".sqlite") + "\n    port: 0");
   return;
  }
  await sleep(Math.min(250, Math.max(0, deadline - now())));
 }
 fail("Telegram pairing timed out; no owner was saved.");
}
function assertAbsent(path: string): void {
 try { lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
 fail("Pairing file already exists; refusing to replace an owner. Reset is not supported.");
}
function persistPairing(path: string, pairing: { botId: string; userId: string; chatIds: string[] }): void {
 mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
 const temporary = path + "." + randomBytes(16).toString("hex") + ".tmp";
 try {
  createPrivateFile(temporary, JSON.stringify(pairing) + "\n");
  // Same-directory hard link atomically publishes complete data without clobbering a concurrent owner.
  try { linkSync(temporary, path); } catch (error) {
   if ((error as NodeJS.ErrnoException).code === "EEXIST") fail("Pairing file already exists; refusing to replace an owner.");
   throw error;
  }
 } finally { try { unlinkSync(temporary); } catch {} }
 syncPrivateDirectory(dirname(path));
}
