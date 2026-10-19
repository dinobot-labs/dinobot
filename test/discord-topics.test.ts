import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discordChannel, type DiscordConfig } from "../src/channels/discord.ts";
import type { MessagingChannel } from "../src/channels/messaging.ts";

const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
const dirs: string[] = [], channels: MessagingChannel[] = [], servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => {
 for (const c of channels.splice(0)) await c.stop();
 for (const s of servers.splice(0)) await s.stop(true);
 for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function config(extra: Partial<DiscordConfig> = {}): DiscordConfig {
 const dir = mkdtempSync(join(tmpdir(), "discord-topics-")); dirs.push(dir);
 return { port: 0, databasePath: join(dir, "jobs.sqlite"), applicationId: "123", publicKey, allowedUserIds: ["7"], allowedParentChannelIds: ["9"], ...extra };
}
function channel(cfg: DiscordConfig, receive: (r: Request) => Response | Promise<Response> = () => Response.json({ id: "99" })) {
 const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: receive }); servers.push(server);
 const c = discordChannel(cfg, { apiBase: server.url.origin }); channels.push(c); return c;
}
let sequence = 0n;
function event(child = "91", type: unknown = 11, parent: unknown = "9") {
 return { id: String((BigInt(Date.now() - 1420070400000) << 22n) + sequence++), application_id: "123", type: 2,
  channel_id: child, channel: { id: child, parent_id: parent, type }, user: { id: "7" }, token: "token-" + child,
  data: { name: "ask", type: 1, options: [{ name: "prompt", type: 3, value: "hello" }] } };
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
const answer = async () => ({ status: "answered" as const, text: "@everyone answer" });

test("Discord destination schema requires channel or parent list; supplied lists must be nonempty", () => {
 const { allowedParentChannelIds: _parents, ...base } = config();
 for (const extra of [{}, { allowedParentChannelIds: [] }, { allowedChannelIds: [], allowedParentChannelIds: ["9"] }]) {
  expect(() => discordChannel({ ...base, ...extra } as DiscordConfig)).toThrow("Invalid Discord");
 }
 expect(() => discordChannel({ ...base, allowedChannelIds: ["91"] })).not.toThrow();
});

test("signed thread types 10/11/12 admit parent-only configuration and keep topic identities and original delivery", async () => {
 const seen: string[] = [], sent: { path: string; method: string; payload: any }[] = [];
 const c = channel(config(), async req => {
  const form = await req.formData(); sent.push({ path: new URL(req.url).pathname, method: req.method, payload: JSON.parse(String(form.get("payload_json"))) });
  return Response.json({ id: "99" });
 });
 await c.start(async m => { seen.push(m.threadKey); return answer(); });
 for (const [child, type] of [["91", 10], ["92", 11], ["91", 12]] as const) {
  expect(await (await post(c, event(child, type))).json()).toEqual({ type: 5, data: { flags: 64 } });
 }
 await until(() => c.health().done === 3);
 expect(seen).toEqual(["123:91:7", "123:92:7", "123:91:7"]);
 expect(sent.map(s => s.path)).toEqual(["91", "92", "91"].map(id => "/webhooks/123/token-" + id + "/messages/@original"));
 for (const s of sent) {
  expect(s.method).toBe("PATCH"); expect(s.payload.content).toBe("@everyone answer");
  expect(s.payload.allowed_mentions).toEqual({ parse: [], users: [], roles: [], replied_user: false });
 }
});

test("parent access rejects wrong parent/user/type and invalid or stale signatures without execution", async () => {
 let calls = 0; const c = channel(config()); await c.start(async () => { calls++; return answer(); });
 for (const type of [0, 1, 2, 4, 5, 13, 15, "11", null]) expect((await post(c, event("91", type))).status).toBe(403);
 for (const parent of ["8", null, 9]) expect((await post(c, event("91", 11, parent))).status).toBe(403);
 expect((await post(c, { ...event(), channel: { parent_id: "9" } })).status).toBe(403);
 expect((await post(c, { ...event(), channel: undefined })).status).toBe(403);
 expect((await post(c, { ...event(), user: { id: "8" } })).status).toBe(403);
 expect((await post(c, event(), true)).status).toBe(401);
 expect((await post(c, event(), false, 301000)).status).toBe(401);
 await Bun.sleep(120); expect(calls).toBe(0); expect(c.health().queued).toBe(0);
});

test("explicit channel IDs remain an independent alternative to parent authorization", async () => {
 const c = channel(config({ allowedChannelIds: ["8"] })); await c.start(answer);
 expect((await post(c, event("8", 0, "1234"))).status).toBe(200);
 expect((await post(c, event("91", 11))).status).toBe(200);
 expect((await post(c, event("9", 0))).status).toBe(403);
 await until(() => c.health().done === 2);
});

for (const state of ["queued", "ready"] as const) for (const change of ["none", "parent", "user", "type", "missingType"] as const) {
 test("persisted thread " + state + " reauthorizes " + change, async () => {
  const cfg = config(); const first = channel(cfg); let entered = false;
  await first.start((_m, signal) => { entered = true; return new Promise((_, reject) => signal!.addEventListener("abort", () => reject(new Error("stop")), { once: true })); });
  expect((await post(first, event())).status).toBe(200); await until(() => entered); await first.stop();
  const db = new Database(cfg.databasePath);
  const row = db.query<{ target: string }, []>("SELECT target FROM jobs").get()!;
  const target = JSON.parse(row.target);
  expect(target).toMatchObject({ channel: "91", parentChannelId: "9", channelType: "11" });
  if (change === "type") target.channelType = "0";
  if (change === "missingType") delete target.channelType;
  db.query("UPDATE jobs SET state=?, target=?, parts=?, due=0").run(state, JSON.stringify(target), JSON.stringify(["saved"])); db.close();
  let calls = 0, sends = 0;
  const next = channel({ ...cfg, ...(change === "parent" ? { allowedParentChannelIds: ["8"] } : {}), ...(change === "user" ? { allowedUserIds: ["8"] } : {}) }, () => { sends++; return Response.json({ id: "99" }); });
  await next.start(async () => { calls++; return answer(); });
  await until(() => next.health().done === 1 || next.health().dead === 1);
  expect(calls).toBe(change === "none" && state === "queued" ? 1 : 0);
  expect(sends).toBe(change === "none" ? 1 : 0);
  if (change !== "none") expect(next.health().dead_permission_revoked).toBe(1);
 });
}

test('signed malformed channel identity and bot flags never execute',async()=>{
 let calls=0; const c=channel(config({allowedChannelIds:['91']})); await c.start(async()=>{calls++;return answer();});
 const e=event(); e.channel.id='999'; expect((await post(c,e)).status).toBe(400);
 for(const bot of ['false',0,null,{}]) expect((await post(c,{...event(),user:{id:'7',bot}})).status).toBe(400);
 await Bun.sleep(120); expect(calls).toBe(0); expect(c.health().queued).toBe(0);
 expect((await post(c,{...event(),user:{id:'7',bot:false}})).status).toBe(200);
});

test("I3 I5 I7 Discord buttons use signed component admission and one PATCH including attachments",async()=>{
 const ask={id:"0123456789abcdef0123456789abcdef",question:"DB?",options:["SQLite","Postgres"],default:"SQLite",deadlineAt:Date.now()+60000};
 const payloads:any[]=[],seen:any[]=[];const c=channel(config(),async req=>{const form=await req.formData();payloads.push(JSON.parse(String(form.get("payload_json"))));return Response.json({id:"99"});});
 await c.start(async m=>{seen.push(m);return {status:"answered",text:seen.length===1?"answer":"x".repeat(2001),asks:[ask]};});
 const click={...event(),type:3,data:{component_type:2,custom_id:"da:"+ask.id+":1"}};
 expect((await post(c,{...click,user:{id:"8"}})).status).toBe(403);expect((await post(c,{...click,data:{component_type:2,custom_id:"bad"}})).status).toBe(400);expect((await post(c,click,true)).status).toBe(401);
 expect(await(await post(c,click)).json()).toEqual({type:5,data:{flags:64}});await post(c,click);await until(()=>c.health().done===1);expect(seen).toHaveLength(1);expect(seen[0]).toMatchObject({threadKey:"123:91:7",choice:{askId:ask.id,option:1}});
 await post(c,{...event(),type:3,data:click.data});await until(()=>c.health().done===2);expect(payloads).toHaveLength(2);
 for(const p of payloads){expect(p.components).toHaveLength(1);expect(p.components[0].components[0]).toMatchObject({type:2,style:1,label:"SQLite (기본값)",custom_id:"da:"+ask.id+":0"});}
 expect(payloads[0].attachments).toEqual([]);expect(payloads[1].attachments).toEqual([{id:0,filename:"answer.txt"}]);
});