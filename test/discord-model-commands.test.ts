import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discordChannel } from "../src/channels/discord.ts";
import type { MessagingChannel } from "../src/channels/messaging.ts";
import type { InboundMessage } from "../src/channels/types.ts";

const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
const dirs: string[] = [], channels: MessagingChannel[] = [], servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => {
 for (const c of channels.splice(0)) await c.stop();
 for (const s of servers.splice(0)) await s.stop(true);
 for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture(applicationId = "123") {
 const dir = mkdtempSync(join(tmpdir(), "discord-models-")); dirs.push(dir);
 const sent: { path: string; method: string; payload: any }[] = [];
 const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const form = await request.formData();
  sent.push({ path: new URL(request.url).pathname, method: request.method, payload: JSON.parse(String(form.get("payload_json"))) });
  return Response.json({ id: "99" });
 } }); servers.push(server);
 const config = { port: 0, databasePath: join(dir, "jobs.sqlite"), applicationId, publicKey, allowedUserIds: ["7", "8"], allowedParentChannelIds: ["9"] };
 const make = () => { const c = discordChannel(config, { apiBase: server.url.origin }); channels.push(c); return c; };
 return { c: make(), make, config, sent };
}
let sequence = 0n;
const option = (name: string, value: unknown, type = 3) => ({ name, type, value });
function event(name = "model", options?: unknown, app = "123", user = "7", child = "91") {
 return { id: String((BigInt(Date.now() - 1420070400000) << 22n) + sequence++), application_id: app, type: 2,
  channel_id: child, channel: { id: child, parent_id: "9", type: 11 }, user: { id: user }, token: "fixture-token",
  data: { name, type: 1, ...(options === undefined ? {} : { options }) } };
}
function post(c: MessagingChannel, e: unknown, bad = false, age = 0) {
 const body = JSON.stringify(e), timestamp = String(Math.floor((Date.now() - age) / 1000));
 return fetch(new URL("/webhook", c.url()), { method: "POST", body, headers: {
  "x-signature-timestamp": timestamp, "x-signature-ed25519": bad ? "0".repeat(128) : sign(null, Buffer.from(timestamp + body), keys.privateKey).toString("hex"),
 } });
}
async function until(predicate: () => boolean) {
 const deadline = Date.now() + 4000;
 while (!predicate()) { if (Date.now() > deadline) throw new Error("condition timeout"); await Bun.sleep(10); }
}
const answer = async () => ({ status: "answered" as const, text: "model reply" });

test("signed model commands normalize through durable HTTP ingress with ask identity and ephemeral outbox", async () => {
 const { c, sent } = fixture(); const seen: InboundMessage[] = [];
 await c.start(async m => { seen.push(m); return answer(); });
 const cases: [string, unknown, string][] = [
  ["ask", [option("prompt", "hello")], "hello"], ["model", undefined, "/model"],
  ["model", [option("model", "provider/model-id")], "/model provider/model-id"],
  ["models", [], "/models"], ["models", [option("provider", "provider")], "/models provider"],
  ["models", [option("page", 2, 4)], "/models 2"],
  ["models", [option("page", 3, 4), option("provider", "provider")], "/models provider 3"],
  // Text in /ask deliberately remains text: the shared native handler may accept these controls.
  ["ask", [option("prompt", "/model provider/model-id")], "/model provider/model-id"],
  ["model", [option("model", "p/" + "a".repeat(254))], "/model p/" + "a".repeat(254)],
  ["models", [option("provider", "a".repeat(128)), option("page", Number.MAX_SAFE_INTEGER, 4)], "/models " + "a".repeat(128) + " " + Number.MAX_SAFE_INTEGER],
  ["new", undefined, "/new"], ["new", [], "/new"],
 ];
 for (const [name, options] of cases) {
  const response = await post(c, event(name, options)); expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ type: 5, data: { flags: 64 } });
 }
 await until(() => c.health().done === cases.length);
 expect(seen.map(m => m.text)).toEqual(cases.map(c => c[2]));
 expect(new Set(seen.map(m => m.threadKey))).toEqual(new Set(["123:91:7"]));
 expect(seen.every(m => m.channel === "discord" && m.userId === "7")).toBe(true);
 expect(sent).toHaveLength(cases.length);
 for (const delivery of sent) {
  expect(delivery.path).toBe("/webhooks/123/fixture-token/messages/@original"); expect(delivery.method).toBe("PATCH");
  expect(delivery.payload.content).toBe("model reply"); expect(delivery.payload.allowed_mentions.parse).toEqual([]);
 }
});

test("unknown extra duplicate nested and malformed options never invoke handler or admit", async () => {
 const { c } = fixture(); let calls = 0; await c.start(async () => { calls++; return answer(); });
 const invalid: [string, unknown][] = [
  ["shell", []], ["model", null], ["model", {}], ["model", [null]], ["model", [option("prompt", "p/m")]],
  ["model", [option("model", "p/m"), option("model", "p/n")]],
  ["model", [{ ...option("model", "p/m"), options: [] }]], ["model", [{ ...option("model", "p/m"), focused: false }]],
  ["model", [option("model", "p/m", 1)]], ["model", [option("model", 1)]],
  ["models", [option("page", "1", 4)]], ["models", [option("page", 1)]],
  ["models", [option("provider", "p"), option("extra", "x")]], ["models", [option("page", 1, 4), option("page", 2, 4)]],
  ["ask", [option("prompt", "hello"), option("extra", "x")]],
  ["new", null], ["new", {}], ["new", [option("prompt", "x")]], ["new", [option("model", "p/m")]],
 ];
 for (const ref of ["", "p", "/model", " p/m", "p/m ", "p/m\n", "a".repeat(129) + "/m", "p/m\n/model p/n", "p/m\tbad", "p/", "p/" + "a".repeat(255), "p/m\u0000"])
  invalid.push(["model", [option("model", ref)]]);
 for (const provider of ["", " p", "p q", "/model", "p\n/model", "a".repeat(129), "123"])
  invalid.push(["models", [option("provider", provider)]]);
 for (const page of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null, true]) invalid.push(["models", [option("page", page, 4)]]);
 for (const [name, options] of invalid) expect((await post(c, event(name, options))).status).toBe(400);
 await Bun.sleep(120); expect(calls).toBe(0); expect(c.health().queued).toBe(0); expect(c.health().done).toBe(0);
});

test("model commands retain signed app user and thread guards and namespaces", async () => {
 const seen: string[] = [];
 for (const app of ["123", "456"]) {
  const { c } = fixture(app); await c.start(async m => { seen.push(m.threadKey); return answer(); });
  for (const user of ["7", "8"]) for (const child of ["91", "92"]) expect((await post(c, event("models", [], app, user, child))).status).toBe(200);
  const good = event("model", [], app);
  expect((await post(c, good, true)).status).toBe(401);
  expect((await post(c, good, false, 301000)).status).toBe(401);
  for (const change of [{ application_id: "999" }, { user: { id: "99" } }, { user: { id: "7", bot: true } },
   { channel: { id: "91", parent_id: "8", type: 11 } }, { channel: { id: "91", parent_id: "9", type: 0 } }])
   expect((await post(c, { ...good, ...change })).status).toBe(403);
  expect((await post(c, { ...good, channel: { ...good.channel, id: "92" } })).status).toBe(400);
  await until(() => c.health().done === 4);
 }
 expect(new Set(seen).size).toBe(8);
 expect(seen).toContain("123:91:7"); expect(seen).toContain("456:92:8");
});

test("normalized command survives durable restart and replay deduplicates", async () => {
 const { c, make, config, sent } = fixture(); let entered = false;
 await c.start((_m, signal) => { entered = true; return new Promise((_, reject) => signal!.addEventListener("abort", () => reject(new Error("stop")), { once: true })); });
 const e = event("model", [option("model", "p/m")]); expect((await post(c, e)).status).toBe(200);
 await until(() => entered); await c.stop();
 const db = new Database(config.databasePath);
 const row = db.query<{ message: string; target: string }, []>("SELECT message,target FROM jobs").get()!;
 expect(JSON.parse(row.message)).toMatchObject({ text: "/model p/m", threadKey: "123:91:7" });
 expect(JSON.parse(row.target)).toMatchObject({ channel: "91", parentChannelId: "9", channelType: "11" }); db.close();
 const next = make(); let calls = 0; await next.start(async () => { calls++; return answer(); });
 await until(() => next.health().done === 1);
 expect((await post(next, e)).status).toBe(200); await Bun.sleep(120);
 expect(calls).toBe(1); expect(sent).toHaveLength(1);
});
