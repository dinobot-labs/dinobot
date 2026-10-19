import { afterEach, expect, spyOn, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createSlackChannel, type SlackConfig } from "../src/channels/slack.ts";
import type { InboundMessage } from "../src/channels/types.ts";

const secret = "0123456789abcdef0123456789abcdef";
process.env.SLACK_TEST_SECRET = secret; process.env.SLACK_TEST_TOKEN = "xoxb-fake-test-only";
const dirs: string[] = [], channels: ReturnType<typeof createSlackChannel>[] = [];
const nativeFetch = globalThis.fetch;
let fake: ReturnType<typeof spyOn> | undefined;
afterEach(async () => { for (const c of channels.splice(0)) await c.stop(); fake?.mockRestore(); fake = undefined; for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function config(extra: Partial<SlackConfig> = {}): SlackConfig { const dir = mkdtempSync(join(tmpdir(), "slack-test-")); dirs.push(dir); return { port: 0, databasePath: join(dir, "inbox.db"), signingSecretEnv: "SLACK_TEST_SECRET", botTokenEnv: "SLACK_TEST_TOKEN", appId: "A123", teamId: "T123", botUserId: "UBOT", allowedUserIds: ["U123", "U456"], allowedChannelIds: ["C123", "D123"], ...extra }; }
function channel(cfg = config()) { const c = createSlackChannel(cfg); channels.push(c); return c; }
function api(reply: (init: RequestInit) => Response | Promise<Response> = () => Response.json({ ok: true, ts: "1791165000.000001" })) {
 fake = spyOn(globalThis, "fetch").mockImplementation((async (url: any, init: RequestInit = {}) => {
  if (String(url) !== "https://slack.com/api/chat.postMessage") throw new Error("Unexpected network destination");
  expect(new Headers(init.headers).get("authorization")).toBe("Bearer xoxb-fake-test-only"); expect(init.redirect).toBe("error"); return reply(init);
 }) as typeof fetch);
}
const answer = async () => ({ status: "answered" as const, text: "answer" });
function event(n = 1, patch: Record<string, unknown> = {}, outer: Record<string, unknown> = {}) { return { type: "event_callback", api_app_id: "A123", team_id: "T123", event_id: "Ev" + n, event: { type: "app_mention", user: "U123", channel: "C123", ts: String(1791164999 + n) + ".000001", text: "<@UBOT> hello", ...patch }, ...outer }; }
function post(c: ReturnType<typeof channel>, data: unknown, extra: Record<string, string> = {}, time = String(Math.floor(Date.now() / 1000))) {
 const body = typeof data === "string" ? data : JSON.stringify(data);
 const signature = "v0=" + createHmac("sha256", secret).update("v0:" + time + ":" + body).digest("hex");
 return nativeFetch(new URL("/webhook", c.url()), { method: "POST", headers: { "content-type": "application/json", "x-slack-request-timestamp": time, "x-slack-signature": signature, ...extra }, body });
}
async function until(fn: () => boolean) { const end = Date.now() + 4000; while (!fn()) { if (Date.now() > end) throw Error("condition timeout"); await Bun.sleep(10); } }

test("Slack validates bounded credentials, explicit canonical IDs and required allowlists", () => {
 const cfg = config(); expect(() => createSlackChannel(cfg)).not.toThrow();
 for (const patch of [{ allowedUserIds: ["123"] }, { allowedChannelIds: [] }, { appId: "A:123" }, { teamId: "Tlower" }, { signingSecretEnv: "" }, { botTokenEnv: undefined }, { url: "https://evil.test" }]) expect(() => createSlackChannel({ ...cfg, ...patch } as SlackConfig)).toThrow();
 process.env.SLACK_TEST_BAD = "xoxb-" + "a".repeat(1024); expect(() => createSlackChannel({ ...cfg, botTokenEnv: "SLACK_TEST_BAD" })).toThrow("credential");
 process.env.SLACK_TEST_BAD = "bad secret"; expect(() => createSlackChannel({ ...cfg, signingSecretEnv: "SLACK_TEST_BAD" })).toThrow("credential"); delete process.env.SLACK_TEST_BAD;
});

test("Slack signed raw JSON, freshness, duplicate headers and signed bounded challenge", async () => {
 api(); const c = channel(); let invoked = 0; await c.start(async () => { invoked++; return answer(); }); expect(c.url().hostname).toBe("127.0.0.1");
 expect((await post(c, event(), { "x-slack-signature": "v0=" + "0".repeat(64) })).status).toBe(401);
 // ±301s probes race the wall-clock fraction (floor(+301) can verify as <=300.0 skew); the exact
 // five-minute boundary is covered deterministically by the mocked-clock test below.
 for (const t of [String(Math.floor(Date.now()/1000)-900), String(Math.ceil(Date.now()/1000)+900), "01791165000", "1791165000, 1791165000", "1e9"]) expect((await post(c, event(), {}, t)).status).toBe(401);
 expect((await post(c, event(), { "x-slack-signature": "v0=" + "0".repeat(64) + ", v0=" + "0".repeat(64) })).status).toBe(401);
 const response = await post(c, { type: "url_verification", challenge: "signed_challenge" }); expect(await response.json()).toEqual({ challenge: "signed_challenge" });
 expect((await post(c, { type: "url_verification", challenge: "x".repeat(257) })).status).toBe(400);
 expect((await post(c, "command=%2Fmodel", { "content-type": "application/x-www-form-urlencoded" })).status).toBe(415);
 expect((await post(c, "{" )).status).toBe(400);
 expect((await post(c, event(2, { text: "x".repeat(70000) }))).status).toBe(413);
 await Bun.sleep(120); expect(invoked).toBe(0); expect(fake).toHaveBeenCalledTimes(0);
});

test("Slack exact five-minute boundary and raw byte tampering fail closed", async () => {
 api(); const c = channel(); await c.start(answer);
 const clock = spyOn(Date, "now").mockReturnValue(1791165000000);
 try {
  for (const time of ["1791164700", "1791165300"]) expect((await post(c, { type: "url_verification", challenge: "boundary" }, {}, time)).status).toBe(200);
  for (const time of ["1791164699", "1791165301"]) expect((await post(c, event(), {}, time)).status).toBe(401);
  const original = JSON.stringify(event());
  const signature = "v0=" + createHmac("sha256", secret).update("v0:1791165000:" + original).digest("hex");
  expect((await post(c, original + " ", { "x-slack-signature": signature }, "1791165000")).status).toBe(401);
  // A lossy UTF-8 ingress must not accept a signature for the substituted U+FFFD body.
  const malformed = Buffer.concat([Buffer.from(original.slice(0,-1) + ",\"extra\":\""), Buffer.from([0xff]), Buffer.from("\"}")]);
  const substitutedSignature = "v0=" + createHmac("sha256", secret).update("v0:1791165000:" + malformed.toString("utf8")).digest("hex");
  const response = await nativeFetch(new URL("/webhook", c.url()), { method: "POST", headers: { "content-type": "application/json", "x-slack-request-timestamp": "1791165000", "x-slack-signature": substitutedSignature }, body: malformed });
  expect(response.status).toBe(401); expect(fake).toHaveBeenCalledTimes(0);
 } finally { clock.mockRestore(); }
});

test("Slack accepts correctly signed literal replacement characters without normalizing raw authentication", async () => {
 api(); const c = channel(); let seen = "";
 await c.start(async message => { seen = message.text; return answer(); });
 expect((await post(c, event(88, { text: "<@UBOT> literal �" }))).status).toBe(200);
 await until(() => seen !== ""); expect(seen).toBe("literal �");
});

test("Slack filters unauthorized, foreign, bot, hidden and subtype events without invoking provider", async () => {
 api(); const c = channel(); let invoked = 0; await c.start(async () => { invoked++; return answer(); });
 for (const outer of [{ api_app_id: "A999" }, { team_id: "T999" }]) expect((await post(c, event(1, {}, outer))).status).toBe(403);
 for (const patch of [{ user: "U999" }, { channel: "C999" }, { team: "T999" }, { user_team: "T999" }, { source_team: "T999" }]) expect((await post(c, event(1, patch))).status).toBe(403);
 for (const patch of [{ user: "UBOT" }, { bot_id: "B123" }, { bot_profile: {} }, { subtype: "message_changed" }, { subtype: "message_deleted" }, { hidden: true }, { type: "message" }, { type: "reaction_added" }]) expect((await post(c, event(1, patch))).status).toBe(200);
 expect((await post(c, event(1, { thread_ts: "1.2" }))).status).toBe(400);
 expect((await post(c, event(1, { text: "x".repeat(16385) }))).status).toBe(413);
 await Bun.sleep(120); expect(invoked).toBe(0); expect(fake).toHaveBeenCalledTimes(0);
});

test("Slack mention commands and ordinary turns share exact user/thread scope; dedupe survives restart", async () => {
 api(); const cfg = config(), c = channel(cfg), seen: InboundMessage[] = []; await c.start(async m => { seen.push(m); return answer(); });
 const root = "1791165000.000001";
 await post(c, event(1, { text: "<@UBOT> /models" })); await post(c, event(1));
 await post(c, event(2, { type: "message", thread_ts: root, ts: "1791165001.000001", text: "ordinary" }));
 await post(c, event(3, { thread_ts: root, text: "<@UBOT> /model provider/id" }));
 await post(c, event(4, { thread_ts: root, user: "U456" }));
 await post(c, event(5, { thread_ts: "1791165002.000001" }));
 await post(c, event(6, { text: "<@UOTHER> /models" }));
 await post(c, event(7, { type: "message", channel: "D123", channel_type: "im" }));
 await until(() => c.health().done === 7);
 expect(seen.slice(0,3).map(m => m.text)).toEqual(["/models", "ordinary", "/model provider/id"]);
 expect(seen[0]!.threadKey).toBe(JSON.stringify(["A123", "T123", "C123", root, "U123"]));
 expect(seen[1]!.threadKey).toBe(seen[0]!.threadKey); expect(seen[2]!.threadKey).toBe(seen[0]!.threadKey);
 expect(seen[3]!.threadKey).not.toBe(seen[0]!.threadKey); expect(seen[4]!.threadKey).not.toBe(seen[0]!.threadKey); expect(seen[5]!.text).toBe("<@UOTHER> /models");
 await c.stop(); const next = channel(cfg); await next.start(async m => { seen.push(m); return answer(); }); await post(next, event(1)); await Bun.sleep(150); expect(seen).toHaveLength(7);
 await next.stop(); const foreign = channel({ ...cfg, teamId: "T999" }); await expect(foreign.start(answer)).rejects.toThrow("another channel");
});

test("Slack app_mention and message subscriptions deduplicate the same physical thread message", async () => {
 api(); const c = channel(); let calls = 0;
 await c.start(async () => { calls++; return answer(); });
 const patch = { ts: "1791165003.000001", thread_ts: "1791165000.000001", text: "<@UBOT> /model provider/id" };
 expect((await post(c, event(101, patch))).status).toBe(200);
 expect((await post(c, event(102, { ...patch, type: "message" }))).status).toBe(200);
 await until(() => c.health().done! >= 1); await Bun.sleep(150);
 expect(calls).toBe(1); expect(c.health().done).toBe(1);
});

test("Slack equal timestamps in different channels cannot collide in adapter receipt storage", async () => {
 api(); const c = channel(config({ allowedChannelIds: ["C123", "C456"] })); let calls = 0;
 await c.start(async () => { calls++; return answer(); });
 const patch = { ts: "1791165003.000001", thread_ts: "1791165000.000001" };
 expect((await post(c, event(201, patch))).status).toBe(200);
 expect((await post(c, event(202, { ...patch, channel: "C456" }))).status).toBe(200);
 await until(() => calls >= 1); await Bun.sleep(150); expect(calls).toBe(2);
});

test("Slack safe rich Unicode chunks, fixed token header destination and 429 lower bound", async () => {
 const sent: any[] = [], times: number[] = []; api(init => { times.push(Date.now()); if (times.length === 1) return new Response(null, { status: 429, headers: { "Retry-After": "0.2" } }); sent.push(JSON.parse(String(init.body))); return Response.json({ ok: true, ts: "1791165000.000002" }); });
 const c = channel(), full = "a".repeat(3999) + "😀<@U123> <!everyone> _text_"; await c.start(async () => ({ status: "answered", text: full })); await post(c, event()); await until(() => c.health().done === 1);
 expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(200); expect(sent.map(x => x.text).join("")).toBe(full.replace(/</g,"&lt;").replace(/>/g,"&gt;"));
 for (const body of sent) expect(body.blocks[0].text).toMatchObject({type:"mrkdwn",verbatim:true,text:body.text});
 for (const body of sent) { expect(body).toMatchObject({ channel: "C123", thread_ts: "1791165000.000001", mrkdwn: false, link_names: false, parse: "none", unfurl_links: false, unfurl_media: false }); expect(body.text.length).toBeLessThanOrEqual(4000); expect(body.text).not.toContain("�"); }
});

test("Slack ok:false, malformed success and network ambiguity are sanitized terminal failures", async () => {
 let attempt = 0; api(() => { attempt++; if (attempt === 1) return Response.json({ ok: false, error: "xoxb-secret-platform-body" }); if (attempt === 2) return Response.json({ ok: true, ts: "not-ts" }); throw Error("credential network failure"); });
 const cfg = config({deliveryRecovery:false}), c = channel(cfg); await c.start(answer); for (let i=1;i<=3;i++) await post(c,event(i)); await until(() => c.health().dead === 3); expect(c.health().unknown).toBe(1); expect(c.health().dead_platform_rejected).toBe(2); expect(JSON.stringify(c.health())).not.toContain("secret");
 await c.stop(); const next = channel(cfg); await next.start(answer); await Bun.sleep(150); expect(attempt).toBe(3);
});

test("Slack restart rechecks authorization, target scope and quarantines interrupted sends", async () => {
 api(); const cfg = config({deliveryRecovery:false}), c = channel(cfg); await c.start(answer); await post(c,event()); await until(() => c.health().done === 1); await c.stop();
 const message = { channel: "slack", messageId: "Ev1", userId: "U123", threadKey: JSON.stringify(["A123","T123","C123","1791165000.000001","U123"]), text: "hello" };
 const seed = (state: string, target = { channel: "C123", thread_ts: "1791165000.000001" }) => { const db = new Database(cfg.databasePath); db.query("UPDATE jobs SET state=?, message=?, target=?, parts=?, attempts=0").run(state,JSON.stringify(message),JSON.stringify(target),JSON.stringify(["reply"])); db.close(); };
 seed("queued"); let invoked = 0; const revoked = channel({ ...cfg, allowedUserIds: ["U456"] }); await revoked.start(async () => { invoked++; return answer(); }); await until(() => revoked.health().dead === 1); expect(revoked.health().dead_permission_revoked).toBe(1); await revoked.stop();
 seed("ready", { channel: "D123", thread_ts: "1791165000.000001" }); const mismatch = channel(cfg); await mismatch.start(answer); await until(() => mismatch.health().dead === 1); expect(mismatch.health().dead_permission_revoked).toBe(1); await mismatch.stop();
 seed("sending"); const ambiguous = channel(cfg); await ambiguous.start(answer); expect(ambiguous.health().unknown).toBe(1); expect(invoked).toBe(0); expect(fake).toHaveBeenCalledTimes(1);
});

 test("Slack first progress429 shares120s channel cooldown with final post", async () => {
 let writes=0, release!:()=>void; const held=new Promise<void>(r=>release=r);
 api(()=>{writes++;release();return new Response("not json",{status:429,headers:{"Retry-After":"120"}});});
 const c=channel(config({deliveryRecovery:false,toolProgress:"text"}));await c.start(async (_m,_s,progress)=>{progress?.({type:"tool_start",id:"x",name:"read"});await held;return answer();});
 await post(c,event());await until(()=>c.health().dead===1);
 expect(writes).toBe(1);expect(c.health().dead_retry_after_exceeds_budget).toBe(1);
 });
 test("Slack fallback payload preserves original rather than generated markers", async () => {
 const payloads:any[]=[];api(init=>{payloads.push(JSON.parse(String(init.body)));return Response.json({ok:true,ts:"1791165000.000001"});});
 const c=channel();await c.start(async()=>({status:"answered",text:"**hello** x_y"}));
 await post(c,event());await until(()=>c.health().done===1);
 expect(payloads[0].blocks[0].text).toEqual({type:"plain_text",text:"**hello** x_y"});
 });

test("Slack choice context bounds a maximum-sized Unicode default without changing stored options",async()=>{
 const sent:any[]=[];api(init=>{sent.push(JSON.parse(String(init.body)));return Response.json({ok:true,ts:"1791165000.000001"});});
 const c=channel();const longDefault="😀".repeat(1000);
 await c.start(async()=>({status:"answered",text:"answer",asks:[{...choiceAsk,default:longDefault}]}));
 await post(c,event());await until(()=>c.health().done===1);
 const context=sent[1].blocks[2].elements[0].text;expect(context.length).toBeLessThanOrEqual(2000);expect(context).not.toContain("�");expect(context).toContain("…");
 expect(sent[1].blocks[1].elements[0].value).toBe("da:"+choiceAsk.id+":0");
});

const choiceAsk = {id:"0123456789abcdef0123456789abcdef",question:"DB?",options:["SQLite","Postgres"],default:"SQLite",deadlineAt:Date.now()+60000};
function interaction(patch: Record<string,unknown> = {}) {return {type:"block_actions",api_app_id:"A123",team:{id:"T123"},user:{id:"U123"},channel:{id:"C123"},message:{thread_ts:"1791165000.000001"},actions:[{type:"button",value:"da:"+choiceAsk.id+":1",action_ts:"1791165001.000001"}],...patch};}
function click(c:ReturnType<typeof channel>,data:unknown,extra:Record<string,string>={}) {return post(c,new URLSearchParams({payload:JSON.stringify(data)}).toString(),{"content-type":"application/x-www-form-urlencoded",...extra});}
test("I3 I4 I5 Slack signed buttons enforce allowlists, exact scope and dedupe",async()=>{
 api();const c=channel(),seen:InboundMessage[]=[];await c.start(async m=>{seen.push(m);return answer();});
 expect((await click(c,interaction(),{"x-slack-signature":"v0="+"0".repeat(64)})).status).toBe(401);
 for(const patch of [{user:{id:"U999"}},{channel:{id:"C999"}},{team:{id:"T999"}},{api_app_id:"A999"},{user:{id:"UBOT"}}]) expect((await click(c,interaction(patch))).status).toBe(403);
 for(const patch of [{actions:[{type:"button",value:"invalid",action_ts:"1791165001.000001"}]},{actions:[]},{message:{thread_ts:"bad"}}]) expect((await click(c,interaction(patch))).status).toBe(400);
 expect((await click(c,interaction())).status).toBe(200);expect((await click(c,interaction())).status).toBe(200);
 await until(()=>c.health().done===1);expect(seen).toHaveLength(1);expect(seen[0]).toMatchObject({choice:{askId:choiceAsk.id,option:1},threadKey:JSON.stringify(["A123","T123","C123","1791165000.000001","U123"]),text:"[ask "+choiceAsk.id+"] choice #2"});
 expect((await click(c,interaction({user:{id:"U456"}}))).status).toBe(200);await until(()=>c.health().done===2);expect(seen[1]!.threadKey).not.toBe(seen[0]!.threadKey);
});
test("Slack renders separate persisted button part and preserves it on uncertain recovery",async()=>{
 const sent:any[]=[];api(init=>{sent.push(JSON.parse(String(init.body)));return Response.json({ok:true,ts:"1791165000.000001"});});
 const cfg=config(),c=channel(cfg);await c.start(async()=>({status:"answered",text:"answer",asks:[choiceAsk]}));await post(c,event());await until(()=>c.health().done===1);await c.stop();
 expect(sent).toHaveLength(2);const buttons=sent[1];expect(buttons.blocks[1].elements[0]).toMatchObject({style:"primary",value:"da:"+choiceAsk.id+":0"});expect(buttons.blocks[1].elements[1].style).toBeUndefined();expect(buttons.blocks[2].elements[0].text).toContain("직접 답하려면");
 // Completed jobs deliberately erase parts; recreate the uncertain persisted boundary.
 const db=new Database(cfg.databasePath);try {db.query("UPDATE jobs SET state='sending',parts=?,message=?,target=?,progress=0,attempts=0").run(JSON.stringify(["\u0000slack-ask:"+JSON.stringify({ask:choiceAsk,index:0,total:1})]),JSON.stringify({channel:"slack",messageId:"choice-recovery",userId:"U123",threadKey:JSON.stringify(["A123","T123","C123","1791165000.000001","U123"]),text:"question"}),JSON.stringify({channel:"C123",thread_ts:"1791165000.000001",recipient_team_id:"T123",recipient_user_id:"U123"}));} finally {db.close();}
 const restarted=channel(cfg);await restarted.start(answer);await until(()=>restarted.health().done===1);expect(sent.at(-1)).toEqual(buttons);
});
test("Slack [\"*\"] admits any canonical channel or DM, but only for allowed users", async () => {
 const base = config();
 expect(() => createSlackChannel({ ...base, allowedChannelIds: ["*"] })).not.toThrow();
 for (const allowedChannelIds of [["*", "C123"], ["C123", "*"], ["**"], ["*", "*"], ["all"], []]) expect(() => createSlackChannel({ ...base, allowedChannelIds } as SlackConfig)).toThrow("Invalid Slack channel configuration");
 const posted: string[] = [];
 api(init => { posted.push(JSON.parse(String(init.body)).channel); return Response.json({ ok: true, ts: "1791165000.000001" }); });
 const c = channel(config({ allowedChannelIds: ["*"] })), seen: InboundMessage[] = []; await c.start(async m => { seen.push(m); return answer(); });
 for (const patch of [{ user: "U999", channel: "C999" }, { user: "U999", channel: "D999", type: "message", channel_type: "im" }, { channel: "c999" }, { channel: "X999" }, { channel: 123 }, { channel: "*" }, { team: "T999", channel: "C999" }]) expect((await post(c, event(1, patch))).status).toBe(403);
 expect((await post(c, event(1, { channel: "C999" }, { api_app_id: "A999" }))).status).toBe(403);
 expect((await post(c, event(2, { channel: "C999" }))).status).toBe(200);
 expect((await post(c, event(3, { channel: "G777", user: "U456" }))).status).toBe(200);
 expect((await post(c, event(4, { type: "message", channel_type: "im", channel: "D777", text: "hi" }))).status).toBe(200);
 await until(() => c.health().done === 3);
 expect(seen.map(m => JSON.parse(m.threadKey)[2]).sort()).toEqual(["C999", "D777", "G777"]);
 // Replies are delivered, so the stored-job re-authorization accepts wildcard targets too.
 expect(posted.sort()).toEqual(["C999", "D777", "G777"]);
 for (const patch of [{ user: { id: "U999" }, channel: { id: "C999" } }, { channel: { id: "nope" } }]) expect((await click(c, interaction(patch))).status).toBe(403);
 expect((await click(c, interaction({ channel: { id: "C999" } }))).status).toBe(200);
 await until(() => c.health().done === 4);
});
