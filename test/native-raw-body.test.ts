import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { messagingChannel } from "../src/channels/messaging.ts";

test("signed native ingress preserves raw bytes before platform authentication", async () => {
 const dir = await mkdtemp(join(tmpdir(), "native-raw-"));
 let seen: Uint8Array | undefined;
 const channel = messagingChannel({ port: 0, databasePath: join(dir, "inbox.sqlite"), allowedUserIds: ["1"] }, {
  name: "raw-test", storageIdentity: "raw-test", admissionTimeoutMs: 1000, replaySafe: false,
  authorizeStored: () => false, retryAfter: () => null,
  receive(_request, bytes) { seen = bytes; return { status: 200 }; },
  render: () => [], delivery() { throw new Error("no delivery"); }, success: () => false,
 });
 try {
  await channel.start(async () => { throw new Error("no admission"); });
  for (const bytes of [new Uint8Array([97, 255, 98]), new Uint8Array([239, 191, 189]), new TextEncoder().encode("한글😀")]) {
   const response = await fetch(new URL("/webhook", channel.url()), { method: "POST", body: bytes });
   expect(response.status).toBe(200); await response.arrayBuffer();
   expect([...seen!]).toEqual([...bytes]);
  }
 } finally { await channel.stop(); await rm(dir, { recursive: true, force: true }); }
});
