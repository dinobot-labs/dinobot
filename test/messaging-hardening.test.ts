import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { telegramChannel } from "../src/channels/telegram.ts";
import { retryDelay } from "../src/channels/messaging.ts";

async function until(check: () => boolean) { for (let n = 0; n < 300; n++) { if (check()) return; await Bun.sleep(10); } throw new Error("deadline"); }
const event = { update_id: 1, message: { message_id: 1, text: "hi", from: { id: 7, is_bot: false }, chat: { id: -9 } } };
const post = (url: URL) => fetch(new URL("/webhook", url), { method: "POST", headers: { "x-telegram-bot-api-secret-token": "hardening-secret" }, body: JSON.stringify(event) });
process.env.MESSAGING_HARDENING_TOKEN = "555:test";
process.env.MESSAGING_HARDENING_SECRET = "hardening-secret";

test("Retry-After is a lower bound, never clamped into an earlier retry", () => {
 expect(retryDelay("120")).toBeGreaterThanOrEqual(120000);
 expect(retryDelay(new Date(180000).toUTCString(), 0)).toBeGreaterThanOrEqual(180000);
});

test("different bot accounts cannot reuse a core conversation identity", async () => {
 const dir = await mkdtemp(join(tmpdir(), "messaging-identity-"));
 const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ ok: true }) });
 const keys: string[] = [];
 try {
  for (const id of ["555", "556"]) {
   process.env.MESSAGING_HARDENING_TOKEN = id + ":test";
   const channel = telegramChannel({ port: 0, databasePath: join(dir, id + ".sqlite"), allowedUserIds: ["7"], allowedChatIds: ["-9"], botTokenEnv: "MESSAGING_HARDENING_TOKEN", webhookSecretEnv: "MESSAGING_HARDENING_SECRET" }, { apiBase: server.url.origin });
   try { await channel.start(async message => { keys.push(message.threadKey); return { status: "answered", text: "ok" }; }); await post(channel.url()); await until(() => channel.health().done === 1); } finally { await channel.stop(); }
  }
  expect(keys).toHaveLength(2); expect(keys[0]).not.toBe(keys[1]);
 } finally { process.env.MESSAGING_HARDENING_TOKEN = "555:test"; await server.stop(true); await rm(dir, { recursive: true, force: true }); }
});

test("oversized Retry-After fails explicitly without retrying early", async () => {
 const dir = await mkdtemp(join(tmpdir(), "messaging-hardening-")); let sends = 0;
 const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) { if (new URL(req.url).pathname.endsWith("/setMyCommands")) return Response.json({ ok: true, result: true }); sends++; return Response.json({ parameters: { retry_after: 120 } }, { status: 429 }); } });
 const path = join(dir, "queue.sqlite");
 const channel = telegramChannel({ port: 0, databasePath: path, allowedUserIds: ["7"], allowedChatIds: ["-9"], botTokenEnv: "MESSAGING_HARDENING_TOKEN", webhookSecretEnv: "MESSAGING_HARDENING_SECRET" }, { apiBase: server.url.origin });
 try {
  await channel.start(async () => ({ status: "answered", text: "reply" }));
  expect((await post(channel.url())).status).toBe(200);
  await until(() => channel.health().dead === 1); expect(sends).toBe(1);
  await channel.stop(); const db = new Database(path);
  try { expect(db.query<{ error: string }, []>("SELECT error FROM jobs").get()?.error).toBe("retry_after_exceeds_budget"); } finally { db.close(); }
 } finally { await channel.stop(); await server.stop(true); await rm(dir, { recursive: true, force: true }); }
});
