import { readPrivateFile } from "../src/telegram-private-files/index.ts";
import { exposePrivateFixture } from "./telegram-private-files/fixtures.ts";
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { telegramChannel, type TelegramConfig } from "../src/channels/telegram.ts";
import type { MessagingChannel } from "../src/channels/messaging.ts";
import { SCALED_GATE_POLICY } from "./fixtures/gate-policy.ts";

const dirs: string[] = [], channels: MessagingChannel[] = [], servers: ReturnType<typeof Bun.serve>[] = [];
process.env.POLL_TEST_TOKEN = "123:fake_test_only";
afterEach(async () => { for (const c of channels.splice(0)) await c.stop(); for (const s of servers.splice(0)) await s.stop(true); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function config(extra: Partial<TelegramConfig> = {}): TelegramConfig { const dir = mkdtempSync(join(tmpdir(), "tg-poll-")); dirs.push(dir); return { mode: "polling", botTokenEnv: "POLL_TEST_TOKEN", databasePath: join(dir, "queue.db"), allowedUserIds: ["7"], allowedChatIds: ["-9", "7"], ...extra }; }
function event(id: number, topic = 12, text = "hello", user = 7, chat = -9, type = "supergroup") { return { update_id: id, message: { message_id: id, from: { id: user, is_bot: false }, chat: { id: chat, type }, message_thread_id: topic, text } }; }
async function until(fn: () => boolean, ms = 4000) { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error("condition timeout"); await Bun.sleep(10); } }
function platform(updates: unknown[], override?: (method: string, body: any) => Response | Promise<Response> | undefined) {
 const offsets: number[] = [], sent: any[] = [], methods: string[] = [];
 const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  const method = new URL(req.url).pathname.split("/").at(-1)!; const body = await req.json() as any; methods.push(method);
  if (method === "getUpdates") offsets.push(body.offset);
  const other = await override?.(method, body); if (other) return other;
  if (method === "setMyCommands") return Response.json({ ok: true, result: true });
  if (method === "getWebhookInfo") return Response.json({ ok: true, result: { url: "" } });
  if (method === "getUpdates") return Response.json({ ok: true, result: updates.filter((x: any) => x.update_id >= body.offset).slice(0, body.limit) });
  if (method === "sendMessage") { sent.push(body); return Response.json({ ok: true }); }
  throw new Error("unexpected API method");
 } }); servers.push(server); return { base: server.url.origin, offsets, sent, methods };
}
// Shared API gate active with the explicitly scaled policy (fixtures/gate-policy.ts): 100 replies to one chat would
// otherwise take minutes at 20 writes/60 s. Cursor, admission and 429 lower-bound assertions are unchanged.
function channel(c: TelegramConfig, base: string) { const ch = telegramChannel(c, { apiBase: base, gatePolicy: SCALED_GATE_POLICY }); channels.push(ch); return ch; }
function inspect(path: string) { const db = new Database(path); try { return { offset: (db.query("SELECT offset FROM polling_cursor").get() as any).offset, jobs: db.query("SELECT * FROM jobs").all() as any[] }; } finally { db.close(); } }
const answer = async () => ({ status: "answered" as const, text: "reply" });

for (const schedulerMode of ["topic", "global"] as const) test("polling durable cursor, rejects/ignores and multi-topic private Unicode chunks (" + schedulerMode + " scheduler)", async () => {
 const bad = event(3); bad.message.message_thread_id = -1;
 const p = platform([event(1,12,"unauthorized",8), { update_id: 2 }, bad, event(4), event(5,99,"private",7,7,"private")]);
 const cfg = config({ schedulerMode }), c = channel(cfg,p.base); const keys: string[] = []; const full = "a".repeat(4095) + "😀last";
 await c.start(async m => { keys.push(m.threadKey); return { status: "answered", text: full }; });
 expect(() => c.url()).toThrow(); await until(() => c.health().done === 2 && p.offsets.includes(6)); await c.stop();
 expect(inspect(cfg.databasePath).offset).toBe(6); expect(keys).toEqual(["123:-9:12:7","123:7:99:7"]);
 // ADR 0048: distinct destinations are independent lanes, ordered per lane; the explicit global mode keeps one FIFO.
 const lane = (topic: number) => p.sent.filter(x => x.message_thread_id === topic).map(x => x.text);
 expect(p.sent).toHaveLength(4); expect(lane(12).join("")).toBe(full); expect(lane(99).join("")).toBe(full);
 if (schedulerMode === "global") expect(p.sent.map(x => x.message_thread_id)).toEqual([12,12,99,99]);
 const reopened = channel(cfg,p.base); await reopened.start(async () => { throw new Error("duplicate execution"); }); await until(() => p.offsets.filter(x => x === 6).length >= 2); await reopened.stop(); expect(p.sent.length).toBe(4);
});

test("full capacity and database error never advance offset past unadmitted update", async () => {
 const cfg = config({ maxRows: 1 }), p = platform([event(1),event(2)]), c = channel(cfg,p.base);
 await c.start(answer); await until(() => p.offsets.includes(2)); await c.stop(); expect(inspect(cfg.databasePath).offset).toBe(2); expect(inspect(cfg.databasePath).jobs.length).toBe(1);
 const db = new Database(cfg.databasePath); db.exec("DELETE FROM jobs; CREATE TRIGGER fail_insert BEFORE INSERT ON jobs BEGIN SELECT RAISE(ABORT, 'simulated database failure'); END"); db.close();
 const next = channel(cfg,p.base); const count = p.offsets.length; await next.start(answer); await until(() => p.offsets.length >= count + 2); await next.stop(); expect(inspect(cfg.databasePath).offset).toBe(2); expect(inspect(cfg.databasePath).jobs.length).toBe(0);
 const repair = new Database(cfg.databasePath); repair.exec("DROP TRIGGER fail_insert"); repair.close();
 const last = channel(cfg,p.base); await last.start(answer); await until(() => last.health().done === 1); await last.stop(); expect(inspect(cfg.databasePath).offset).toBe(3);
});

test("SIGKILL after admission reopens cursor and processing job without refetch loss", async () => {
 const cfg = config(), p = platform([event(10)]);
 const script = 'import {telegramChannel} from "./src/channels/telegram.ts"; const c=telegramChannel('+JSON.stringify(cfg)+',{apiBase:'+JSON.stringify(p.base)+',gatePolicy:'+JSON.stringify(SCALED_GATE_POLICY)+'}); await c.start(async()=>{console.log("PROCESSING");return new Promise(()=>{});});';
 const child = Bun.spawn([process.execPath,"-e",script], { cwd: process.cwd(), env: { ...process.env, POLL_TEST_TOKEN: "123:fake_test_only" }, stdout: "pipe", stderr: "pipe" });
 try { const reader = child.stdout.getReader(); const first = await reader.read(); if (first.done) throw new Error(await new Response(child.stderr).text()); expect(new TextDecoder().decode(first.value)).toContain("PROCESSING"); reader.releaseLock(); child.kill("SIGKILL"); await child.exited; }
 finally { child.kill(); }
 const state = inspect(cfg.databasePath); expect(state.offset).toBe(11); expect(state.jobs[0].state).toBe("processing");
 const offsetsBefore = p.offsets.length; const c = channel(cfg,p.base); let calls = 0; await c.start(async () => { calls++; return answer(); }); await until(() => c.health().done === 1); expect(calls).toBe(1); expect(p.offsets.slice(offsetsBefore).every(x => x === 11)).toBe(true);
});

test("pairing owner-only exact enrollment persists before trusted ACK and merges lists", async () => {
 const cfg = config(); const path = join(dirs.at(-1)!,"pairing.json"); writeFileSync(path, JSON.stringify({ botId:"123",userId:"7",chatIds:["7"] }), { mode:0o600 }); cfg.pairingPath = path;
 const p = platform([event(1,1,"/enable",8,-30), event(2,2,"/enable@bot",7,-30), event(3,77,"/enable",7,-30), event(4,78,"ordinary",7,-30), event(5,12,"configured",7,-9)], (method) => { if(method === "sendMessage") expect(JSON.parse(readFileSync(path,"utf8")).chatIds).toContain("-30"); });
 const c = channel(cfg,p.base); const model: string[] = []; await c.start(async m => { model.push(m.text); return answer(); }); await until(() => c.health().done === 3); await c.stop();
 expect(model).toEqual(["ordinary","configured"]);
 // ADR 0048: the ACK (topic 77) and the ordinary reply (topic 78) are independent lanes; order only within a lane.
 const ack = p.sent.filter(x => x.message_thread_id === 77); expect(ack.map(x => x.text)).toEqual(["This group is enabled."]); expect(JSON.parse(readPrivateFile(path,65536)).chatIds).toContain("-30"); if(process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
 const pairOnly = { ...cfg }; delete pairOnly.allowedUserIds; delete pairOnly.allowedChatIds; expect(() => telegramChannel(pairOnly)).not.toThrow();
 writeFileSync(path,"broken"); expect(() => telegramChannel(pairOnly)).toThrow("pairing"); rmSync(path); expect(() => telegramChannel(pairOnly)).toThrow("pairing");
});

test("credential XOR, file source, missing pairing and public pairing fail closed", async () => {
 const cfg = config(), token = join(dirs.at(-1)!,"token"); writeFileSync(token,"123:fake_test_only\n",{mode:0o600});
 const noToken = {...cfg}; delete noToken.botTokenEnv; const noUsers = {...cfg}; delete noUsers.allowedUserIds;
 expect(() => telegramChannel({...cfg,botTokenFile:token})).toThrow(); expect(() => telegramChannel(noToken)).toThrow();
 expect(() => telegramChannel({...noToken,botTokenFile:token})).not.toThrow();
 expect(() => telegramChannel(noUsers)).toThrow();
 const pair = join(dirs.at(-1)!,"pair"); writeFileSync(pair,JSON.stringify({botId:"123",userId:"7",chatIds:[]})); exposePrivateFixture(pair); expect(() => telegramChannel({...cfg,pairingPath:pair})).toThrow();
});

test("configured webhook fails startup without deleting webhook or dropping updates", async () => {
 const p = platform([], method => method === "getWebhookInfo" ? Response.json({ok:true,result:{url:"https://existing.invalid"}}) : undefined);
 const c = channel(config(),p.base); await expect(c.start(answer)).rejects.toThrow("startup"); expect(p.methods).toEqual(["getWebhookInfo"]);
});

for (const status of [401,409]) test("polling fatal " + status + " is observable and sanitized", async () => {
 const p = platform([],method => method === "getUpdates" ? Response.json({ok:false,error_code:status,description:"123:fake_test_only"},{status}) : undefined);
 const c = channel(config(),p.base); await c.start(answer); await until(() => c.health().polling_failed === 1); expect(c.health().polling_status).toBe(status); expect(c.health().running).toBe(0); expect(JSON.stringify(c.health())).not.toContain("fake_test_only");
});

test("Retry-After lower bound, transient retry, and abortable stop", async () => {
 const times: number[] = [];
 const p = platform([],method => { if(method !== "getUpdates") return; times.push(Date.now()); if(times.length===1) return Response.json({ok:false,parameters:{retry_after:0.3}},{status:429,headers:{"Retry-After":"0.1"}}); if(times.length===2) return new Response(null,{status:503}); return Response.json({ok:false,parameters:{retry_after:60}},{status:429}); });
 const c = channel(config(),p.base); await c.start(answer); await until(() => times.length === 3); expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(290); expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(490);
 const start = Date.now(); await c.stop(); expect(Date.now()-start).toBeLessThan(200); await Bun.sleep(150); expect(times.length).toBe(3);
});

test("oversized and stalled getUpdates bodies are bounded; stop cancels request", async () => {
 let calls=0; const p = platform([],method => { if(method!=="getUpdates") return; calls++; return new Response("x".repeat(262145)); }); const cfg=config({requestTimeoutMs:100}); const c=channel(cfg,p.base); await c.start(answer); await until(()=>calls>=2); await c.stop(); expect(inspect(cfg.databasePath).offset).toBe(0);
 const slow=platform([],method => method === "getUpdates" ? new Promise<Response>(resolve=>setTimeout(()=>resolve(Response.json({ok:true,result:[]})),1000)) : undefined); const next=channel(config(),slow.base); await next.start(answer); await until(()=>slow.offsets.length===1); const start=Date.now(); await next.stop(); expect(Date.now()-start).toBeLessThan(250);
});

for (const provenance of [{forward_origin:{type:'user'}},{forward_from:{id:7}},{forward_date:1},{is_automatic_forward:true},{via_bot:{id:8}},{sender_chat:{id:-9}}]) test('enrollment denies provenance '+Object.keys(provenance)[0], async () => {
 const cfg=config(), path=join(dirs.at(-1)!,'pair'); cfg.pairingPath=path;
 const original=JSON.stringify({botId:'123',userId:'7',chatIds:['7']}); writeFileSync(path,original,{mode:0o600});
 const e=event(1,1,'/enable',7,-30); Object.assign(e.message,provenance);
 const p=platform([e,event(2,1,'ordinary',7,-30)]), c=channel(cfg,p.base); let calls=0;
 await c.start(async()=>{calls++;return answer();}); await until(()=>p.offsets.includes(3)); await c.stop();
 expect(readFileSync(path,'utf8')).toBe(original); expect(calls).toBe(0); expect(p.sent).toEqual([]);
});

test('paired private start and replayed payload are trusted help only without grants', async()=>{
 const cfg=config(), path=join(dirs.at(-1)!,'pair'); cfg.pairingPath=path;
 const original=JSON.stringify({botId:'123',userId:'7',chatIds:['7']}); writeFileSync(path,original,{mode:0o600});
 const p=platform([event(1,1,'/start',7,7,'private'),event(2,1,'/start replay_nonce',7,7,'private'),event(3,1,'/start payload',8,8,'private')]), c=channel(cfg,p.base); let calls=0;
 await c.start(async()=>{calls++;return answer();}); await until(()=>c.health().done===2); await c.stop();
 expect(calls).toBe(0); expect(p.sent.length).toBe(2); expect(p.sent[0].text).toContain('/enable'); expect(p.sent[1].text).toBe(p.sent[0].text); expect(readFileSync(path,'utf8')).toBe(original);
});

for(const kind of ['public','oversize','symlink','directory','fifo','env'] as const) test.skipIf(process.platform === 'win32' && (kind === 'symlink' || kind === 'fifo'))('credential rejects '+kind+' with sanitized errors',()=>{
 const cfg=config(), path=join(dirs.at(-1)!,'token'); delete cfg.botTokenEnv; cfg.botTokenFile=path;
 writeFileSync(path,'123:fake_test_only',{mode:0o600});
 if(kind==='public') exposePrivateFixture(path);
 if(kind==='oversize') writeFileSync(path,'123:'+ 'x'.repeat(1048576));
 if(kind==='symlink') {cfg.botTokenFile=path+'-link'; symlinkSync(path,cfg.botTokenFile);}
 if(kind==='directory') cfg.botTokenFile=dirs.at(-1)!;
 if(kind==='fifo') {rmSync(path); const result=Bun.spawnSync(['mkfifo',path]); expect(result.exitCode).toBe(0);}
 if(kind==='env') {delete cfg.botTokenFile; cfg.botTokenEnv='POLL_LARGE_TOKEN'; process.env.POLL_LARGE_TOKEN='123:'+'x'.repeat(1021);}
 expect(()=>telegramChannel(cfg)).toThrow(/Telegram bot credential/);
 delete process.env.POLL_LARGE_TOKEN;
});

test('polling halves oversized batches without changing cursor and delivers all updates',async()=>{
 const limits:number[]=[], offsets:number[]=[];
 const updates=Array.from({length:100},(_,i)=>event(i+1,1,'x'.repeat(4096)));
 const p=platform(updates,(method,body)=>{if(method==='getUpdates'){limits.push(body.limit);offsets.push(body.offset);}});
 const cfg=config(), c=channel(cfg,p.base); let calls=0;
 // 100 replies to one chat under the scaled gate (20 writes per 1.5 s) need ~7.5 s: a longer drain deadline only.
 await c.start(async()=>{calls++;return answer();}); await until(()=>c.health().done===100, 20000); await c.stop();
 expect(limits.slice(0,2)).toEqual([100,50]); expect(offsets.slice(0,2)).toEqual([0,0]); expect(calls).toBe(100); expect(inspect(cfg.databasePath).offset).toBe(101);
}, 30000);

test('single oversized update fails observably with 413 and unchanged cursor',async()=>{
 const limits:number[]=[]; const p=platform([event(1,1,'x'.repeat(262145))],(method,body)=>{if(method==='getUpdates') limits.push(body.limit);});
 const cfg=config(),c=channel(cfg,p.base); await c.start(answer); await until(()=>c.health().polling_failed===1); await c.stop();
 expect(limits).toEqual([100,50,25,12,6,3,1]); expect(c.health().polling_status).toBe(413); expect(inspect(cfg.databasePath).offset).toBe(0); expect(inspect(cfg.databasePath).jobs).toEqual([]);
});

test('credential byte boundary accepts 1024 and rejects 1025 for file and env',()=>{
 const cfg=config(), path=join(dirs.at(-1)!,'token'); delete cfg.botTokenEnv; cfg.botTokenFile=path;
 for(const size of [1024,1025]) {
  const token='123:'+'x'.repeat(size-4); writeFileSync(path,token,{mode:0o600});
  process.env.POLL_BOUNDARY_TOKEN=token;
  const env={...cfg,botTokenEnv:'POLL_BOUNDARY_TOKEN'}; delete env.botTokenFile;
  if(size===1024) {expect(()=>telegramChannel(cfg)).not.toThrow();expect(()=>telegramChannel(env)).not.toThrow();}
  else {expect(()=>telegramChannel(cfg)).toThrow('Telegram bot credential');expect(()=>telegramChannel(env)).toThrow('Telegram bot credential');}
 }
 delete process.env.POLL_BOUNDARY_TOKEN;
});

test("I5 polling subscribes to callbacks and durable cursor prevents replay",async()=>{
 const cb={update_id:1,callback_query:{id:"query",from:{id:7,is_bot:false},message:{message_id:5,chat:{id:-9},message_thread_id:12},data:"da:0123456789abcdef0123456789abcdef:1"}};
 let subscribed=false;const acks:any[]=[];const p=platform([cb],(method,body)=>{if(method==="getUpdates"){expect(body.allowed_updates).toEqual(["message","callback_query"]);subscribed=true;}if(method==="answerCallbackQuery"||method==="editMessageReplyMarkup"){acks.push({method,body});return Response.json({ok:true});}return undefined;});
 const cfg=config({progress:"off"}),c=channel(cfg,p.base);const seen:any[]=[];await c.start(async m=>{seen.push(m);return answer();});await until(()=>c.health().done===1&&p.offsets.includes(2));await c.stop();expect(subscribed).toBe(true);expect(seen[0]).toMatchObject({threadKey:"123:-9:12:7",choice:{askId:"0123456789abcdef0123456789abcdef",option:1}});
 // Polling has no webhook reply, so the spinner is answered and the keyboard cleared explicitly, before the reply is sent.
 expect(acks).toEqual([{method:"answerCallbackQuery",body:{callback_query_id:"query"}},{method:"editMessageReplyMarkup",body:{chat_id:"-9",message_id:5,reply_markup:{inline_keyboard:[]}}}]);expect(p.methods.indexOf("editMessageReplyMarkup")).toBeLessThan(p.methods.indexOf("sendMessage"));
 const next=channel(cfg,p.base);await next.start(async()=>{throw Error("duplicate");});await until(()=>p.offsets.filter(x=>x===2).length>=2);await next.stop();expect(seen).toHaveLength(1);
});
