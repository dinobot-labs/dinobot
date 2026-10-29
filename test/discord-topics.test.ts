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
  expect(s.payload.embeds).toBeUndefined(); expect(s.payload.components).toBeUndefined();
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
 for(const p of payloads){expect(p.components).toHaveLength(1);expect(p.components[0].components[0]).toMatchObject({type:2,style:1,label:"Q1 1. SQLite (기본값)",custom_id:"da:"+ask.id+":0"});}
 expect(payloads[0].attachments).toEqual([{id:0,filename:"questions.txt"}]);expect(payloads[1].attachments).toEqual([{id:0,filename:"answer.txt"},{id:1,filename:"questions.txt"}]);
});

for (const text of ["", "answer", "x".repeat(2001)]) test("Discord ask cards retain question and free-text/default guidance with " + (text.length > 2000 ? "attached" : text ? "inline" : "empty") + " answer", async () => {
 const asks = [0, 1, 2].map(n => ({id: String(n).repeat(32), question: "질문 " + n + "?", options: ["예", "아니요"], default: "설명과 함께 보류", deadlineAt: Date.now() + 60000}));
 const sent: {payload: any; attachment: string | null}[] = [];
 const c = channel(config(), async req => {
  const form = await req.formData(); const file = text.length > 2000 ? form.get("files[0]") : null;
  sent.push({payload: JSON.parse(String(form.get("payload_json"))), attachment: file instanceof Blob ? await file.text() : null});
  return Response.json({id: "99"});
 });
 await c.start(async () => ({status: "answered", text, asks}));
 expect(await (await post(c, event())).json()).toEqual({type: 5, data: {flags: 64}});
 await until(() => c.health().done === 1);
 expect(sent).toHaveLength(1); // one PATCH; no second ask message overwrites the answer
 const {payload, attachment} = sent[0]!;
 expect(payload.embeds).toHaveLength(3);
 for (const [n, ask] of asks.entries()) {
  expect(payload.embeds[n].title).toBe("Q" + (n + 1) + " " + ask.question);
  expect(payload.embeds[n].description).toContain("/ask prompt:");
  expect(payload.embeds[n].footer.text).toContain(ask.default);
  expect(payload.components[n].components[0].label).toBe("Q" + (n + 1) + " 1. 예");
  expect(payload.components[n].components[0].custom_id).toBe("da:" + ask.id + ":0");
 }
 expect(payload.allowed_mentions).toEqual({parse: [], users: [], roles: [], replied_user: false});
 expect(payload.content).toBe(text.length > 2000 ? "Response attached as plain text." : text || "(empty response)");
 expect(attachment).toBe(text.length > 2000 ? text : null);
});

test("Discord ask card maximum Unicode inputs fit embed and component payload limits", async () => {
 const asks = [0, 1, 2].map(n => ({id: String(n).repeat(32), question: "😀".repeat(2000), options: ["A", "B", "C", "D"], default: "😀".repeat(1000), deadlineAt: Date.now() + 60000}));
 let payload: any;
 const c = channel(config(), async req => {payload = JSON.parse(String((await req.formData()).get("payload_json"))); return Response.json({id: "99"});});
 await c.start(async () => ({status: "answered", text: "answer", asks}));
 await post(c, event()); await until(() => c.health().done === 1);
 expect(payload.embeds).toHaveLength(3);
 let total = 0;
 for (const embed of payload.embeds) {
  expect(embed.title.length).toBeLessThanOrEqual(256);
  expect(embed.description.length).toBeLessThanOrEqual(4096);
  expect(embed.footer.text.length).toBeLessThanOrEqual(2048);
  expect(embed.title).toEndWith("…"); expect(embed.footer.text).toContain("…");
  expect(embed.title).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  total += embed.title.length + embed.description.length + embed.footer.text.length;
 }
 expect(total).toBeLessThanOrEqual(6000);
 expect(payload.components).toHaveLength(3);
 expect(payload.components.every((row: any) => row.components.length === 4)).toBe(true);
 expect(payload.content).toBe("answer");
});

for (const answer of ["", "inline", "x".repeat(2001)]) test("full ask attachment preserves maximum inputs and numbered choices: " + answer.length, async () => {
 const asks = [0, 1, 2].map(n => ({id: String(n).repeat(32), question: "q".repeat(3999) + n, default: "d".repeat(1999) + n, options: ["😀".repeat(249) + "AA", "😀".repeat(249) + "BB"], deadlineAt: Date.now() + 60000}));
 let form: Awaited<ReturnType<Request["formData"]>> | undefined; let sends = 0;
 const c = channel(config(), async req => {sends++; expect(req.method).toBe("PATCH"); form = await req.formData(); return Response.json({id:"99"});});
 await c.start(async () => ({status:"answered", text:answer, asks}));
 await post(c,event()); await until(() => c.health().done === 1);
 expect(sends).toBe(1);
 const payload = JSON.parse(String(form!.get("payload_json")));
 const entry = payload.attachments.find((a: any) => a.filename === "questions.txt");
 expect(entry).toBeDefined();
 const file = form!.get("files[" + entry.id + "]") as File;
 expect(file.name).toBe("questions.txt"); const full = await file.text();
 for (const [i, ask] of asks.entries()) {
  expect(full).toContain("Q" + (i + 1)); expect(full).toContain(ask.question); expect(full).toContain(ask.default);
  for (const [j, option] of ask.options.entries()) expect(full).toContain((j + 1) + ". " + option);
  expect(payload.embeds[i].description).toContain("Q" + (i + 1));
  expect(payload.embeds[i].description).toContain("같은 사용자");
  expect(payload.embeds[i].description).toContain("채널/스레드");
 }
 expect(payload.attachments).toHaveLength(answer.length > 2000 ? 2 : 1);
 for (const a of payload.attachments) expect((form!.get("files[" + a.id + "]") as File).name).toBe(a.filename);
 if (answer.length > 2000) expect(await (form!.get("files[0]") as File).text()).toBe(answer);
});

test("Discord numbered emoji button labels fit 80 UTF16 units with default and Q prefixes", async () => {
 const options = ["😀".repeat(249) + "AA", "😀".repeat(249) + "BB"];
 const asks = [0,1,2].map(n => ({id:String(n).repeat(32), question:"choose", options, default:options[0]!, deadlineAt:Date.now()+60000}));
 let payload:any;
 const c=channel(config(),async req=>{payload=JSON.parse(String((await req.formData()).get("payload_json")));return Response.json({id:"99"});});
 await c.start(async()=>({status:"answered",text:"",asks}));await post(c,event());await until(()=>c.health().done===1);
 for (const [i,row] of payload.components.entries()) {
  expect(new Set(row.components.map((b:any)=>b.label)).size).toBe(2);
  for (const [j,b] of row.components.entries()) {
   expect(b.label.length).toBeLessThanOrEqual(80); expect(b.label).toStartWith("Q"+(i+1)+" "+(j+1)+". ");
   expect(b.label.isWellFormed()).toBe(true);
   if(j===0) expect(b.label).toContain("기본값");
  }
 }
});

test("Discord unsafe question Markdown uses plain-text fallback instead of embed link", async () => {
 const question="[click](javascript:alert)";
 let form: Awaited<ReturnType<Request["formData"]>> | undefined;
 const c=channel(config(),async req=>{form=await req.formData();return Response.json({id:"99"});});
 await c.start(async()=>({status:"answered",text:"",asks:[{id:"0".repeat(32),question,options:["yes","no"],default:"no",deadlineAt:Date.now()+60000}]}));
 await post(c,event());await until(()=>c.health().done===1);
 const payload=JSON.parse(String(form!.get("payload_json")));
 expect(payload.embeds[0].title).not.toContain(question);
 expect(payload.embeds[0].url).toBeUndefined();
 const a=payload.attachments.find((a:any)=>a.filename==="questions.txt");
 expect(await (form!.get("files["+a.id+"]") as File).text()).toContain(question);
});
