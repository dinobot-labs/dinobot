import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { telegramChannel, type TelegramConfig } from "../../src/channels/telegram.ts";
import { INBOX_SCHEMA_VERSION, type MessagingChannel } from "../../src/channels/messaging.ts";
import type { InboundMessage } from "../../src/channels/types.ts";
import { SCALED_GATE_POLICY } from "./gate-policy.ts";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function until(fn: () => boolean) {
 const end = Date.now() + 5000;
 while (!fn()) { if (Date.now() > end) throw new Error("queue did not reach expected state"); await Bun.sleep(5); }
}
function inspect<T>(path: string, fn: (db: Database) => T): T {
 const db = new Database(path, { readonly: true });
 try { return fn(db); } finally { db.close(); }
}
const rows = (path: string) => inspect(path, db => db.query("SELECT * FROM jobs ORDER BY seq").all() as Record<string, any>[]);
function snapshot(path: string) {
 return inspect(path, db => ({
  jobs: db.query("SELECT * FROM jobs ORDER BY seq").all(),
  lanes: db.query("SELECT * FROM lanes ORDER BY lane").all(),
  metadata: db.query("SELECT * FROM metadata").all(),
  version: db.query("PRAGMA user_version").get(),
  settings: db.query("SELECT * FROM settings ORDER BY name").all(),
  permits: db.query("SELECT * FROM api_permits ORDER BY seq").all(),
 }));
}
function fixture() {
 const dir = mkdtempSync(join(tmpdir(), "inbox-file-fence-"));
 cleanup.push(async () => rmSync(dir, { recursive: true, force: true }));
 const sent: string[] = [], downloads: string[] = [];
 const bytes = Buffer.from("opaque file bytes");
 const api = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  const path = new URL(req.url).pathname;
  if (path.includes("/file/")) { downloads.push(path); return new Response(bytes); }
  const body = await req.json() as any;
  if (path.endsWith("/getFile")) return Response.json({ ok: true, result: { file_path: "documents/unknown.bin" } });
  if (path.endsWith("/sendMessage")) sent.push(body.text);
  return Response.json({ ok: true, result: { message_id: sent.length } });
 }});
 cleanup.push(async () => api.stop(true));
 process.env.FILE_FENCE_TOKEN = "731:file_fence_test";
 process.env.FILE_FENCE_SECRET = "file-fence-secret";
 const config: TelegramConfig = { port: 0, databasePath: join(dir, "inbox.sqlite"), botTokenEnv: "FILE_FENCE_TOKEN", webhookSecretEnv: "FILE_FENCE_SECRET", allowedUserIds: ["7", "8"], allowedChatIds: ["-9"], progress: "off", schedulerMode: "global" };
 function channel(factory = telegramChannel) {
  const c = factory(config, { apiBase: api.url.origin, gatePolicy: SCALED_GATE_POLICY });
  cleanup.push(() => c.stop()); return c;
 }
 return { config, channel, sent, downloads, bytes };
}
async function post(c: MessagingChannel, id: number, body: Record<string, unknown>) {
 const response = await fetch(new URL("/webhook", c.url()), { method: "POST", headers: { "x-telegram-bot-api-secret-token": "file-fence-secret" }, body: JSON.stringify({ update_id: id, message: { message_id: id, from: { id: id === 1 ? 7 : 8, is_bot: false }, chat: { id: -9, type: "supergroup" }, message_thread_id: 12, ...body } }), signal: AbortSignal.timeout(5000) });
 await response.arrayBuffer(); expect(response.status).toBe(200);
}
const hold: Parameters<MessagingChannel["start"]>[0] = (_m, signal) => new Promise((_, reject) => {
 if (signal!.aborted) reject(new Error("stopped"));
 else signal!.addEventListener("abort", () => reject(new Error("stopped")), { once: true });
});

export function registerFenceTests(oldReader?: () => Promise<typeof telegramChannel>) {
test((oldReader ? "actual v6 inbox" : "synthetic v6 markers on production-created inbox") + " upgrades without losing queued text or attachment and the new reader processes both", async () => {
 const f = fixture(), old = f.channel(oldReader ? await oldReader() : telegramChannel);
 await old.start(hold);
 await post(old, 1, { text: "held head" });
 await until(() => old.health().processing === 1);
 await post(old, 2, { text: "existing queued text" });
 await post(old, 3, { document: { file_id: "old_text", file_name: "notes.txt", mime_type: "text/plain" } });
 await old.stop();
 if (!oldReader) setVersions(f.config.databasePath, 6, 6);
 const before = rows(f.config.databasePath);
 expect(before.map(r => r.state)).toEqual(["processing", "queued", "queued"]);
 expect(snapshot(f.config.databasePath).version).toEqual({ user_version: 6 });
 const upgrading = f.channel(); await upgrading.start(hold); await upgrading.stop();
 // Hold the head during migration, then close the exclusive SQLite owner before inspection.
 expect(rows(f.config.databasePath).slice(1)).toEqual(before.slice(1));
 expect(snapshot(f.config.databasePath).version).toEqual({ user_version: INBOX_SCHEMA_VERSION });
 expect(snapshot(f.config.databasePath).metadata).toEqual([{ name: "inbox-schema:" + INBOX_SCHEMA_VERSION + ":telegram:731" }]);
 const seen: InboundMessage[] = [], next = f.channel();
 await next.start(async m => { seen.push(m); return { status: "answered", text: "processed-" + m.messageId }; });
 await until(() => next.health().done === 3); await next.stop();
 expect(seen.map(m => m.messageId)).toEqual(["1", "2", "3"]);
 expect(seen[1]!.text).toBe("existing queued text");
 expect(seen[2]!.text).toContain(f.bytes.toString());
 expect(f.sent).toEqual(["processed-1", "processed-2", "processed-3"]);
 expect(rows(f.config.databasePath).map(r => [r.seq, r.id])).toEqual(before.map(r => [r.seq, r.id]));
});

for (const fence of oldReader ? ["historical"] : ["metadata", "pragma", "both"]) {
test((oldReader ? "actual e3ac17f reader" : "production reader with future " + fence + " fence") + " refuses a file inbox without consuming acknowledged queued jobs", async () => {
 const factory = oldReader ? await oldReader() : telegramChannel, f = fixture(), current = f.channel();
 await current.start(hold);
 await post(current, 1, { text: "held head" });
 await until(() => current.health().processing === 1);
 await post(current, 2, { document: { file_id: "generic", file_name: "unknown.bin", mime_type: "application/octet-stream" } });
 await current.stop();
 const queued = rows(f.config.databasePath)[1]!;
 expect(queued.state).toBe("queued");
 expect(JSON.parse(JSON.parse(queued.target).media).kind).toBe("file");
 if (!oldReader) setVersions(f.config.databasePath, fence === "pragma" ? 7 : 8, fence === "metadata" ? 7 : 8);
 const before = snapshot(f.config.databasePath), old = f.channel(factory);
 let oldCalls = 0;
 try {
  await expect(old.start(async () => { oldCalls++; return { status: "answered", text: "must not consume" }; })).rejects.toThrow("Unsupported inbox schema version");
 } finally { await old.stop(); }
 expect(oldCalls).toBe(0); expect(f.sent).toEqual([]); expect(f.downloads).toEqual([]);
 expect(snapshot(f.config.databasePath)).toEqual(before);
 expect(rows(f.config.databasePath)[1]).toEqual(queued);
 // Restore only the synthetic future markers; the acknowledged payload must still replay.
 if (!oldReader) setVersions(f.config.databasePath, 7, 7);
 const seen: InboundMessage[] = [], next = f.channel();
 await next.start(async m => { seen.push(m); return { status: "answered", text: "processed-" + m.messageId }; });
 await until(() => next.health().done === 2); await next.stop();
 expect(seen.map(m => m.messageId)).toEqual(["1", "2"]);
 expect(Buffer.from(seen[1]!.files![0]!.data, "base64")).toEqual(f.bytes);
 expect(f.sent).toEqual(["processed-1", "processed-2"]);
 expect(f.downloads).toHaveLength(1);
});
}
}

// Synthetic version markers exercise production migration/refusal, NOT historical reader proof.
function setVersions(path: string, metadata: number, pragma: number) {
 const db = new Database(path);
 try {
  db.transaction(() => {
   db.query("UPDATE metadata SET name=?").run(`inbox-schema:${metadata}:telegram:731`);
   db.exec(`PRAGMA user_version=${pragma}`);
  })();
 } finally { db.close(); }
}
