import {afterEach,expect,test} from "bun:test";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {telegramChannel} from "../src/channels/telegram.ts";
import {SCALED_GATE_POLICY} from "./fixtures/gate-policy.ts";
import type {InboundMessage} from "../src/channels/types.ts";
process.env.TG_CHOICE_TOKEN="123:fake_test_only";process.env.TG_CHOICE_SECRET="test_secret";
const dirs:string[]=[],channels:ReturnType<typeof telegramChannel>[]=[],servers:ReturnType<typeof Bun.serve>[]=[];
afterEach(async()=>{for(const c of channels.splice(0))await c.stop();for(const s of servers.splice(0))await s.stop(true);for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
const ask={id:"0123456789abcdef0123456789abcdef",question:"<script> & DB?",options:["SQLite","Postgres"],default:"SQLite",deadlineAt:Date.now()+60000};
function setup(){const dir=mkdtempSync(join(tmpdir(),"tg-choice-"));dirs.push(dir);const sent:any[]=[];const s=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(req){if(new URL(req.url).pathname.endsWith("/setMyCommands"))return Response.json({ok:true,result:true});sent.push(await req.json());return Response.json({ok:true});}});servers.push(s);const c=telegramChannel({port:0,databasePath:join(dir,"inbox.db"),botTokenEnv:"TG_CHOICE_TOKEN",webhookSecretEnv:"TG_CHOICE_SECRET",allowedUserIds:["7","8"],allowedChatIds:["-9"],progress:"off"},{apiBase:s.url.origin,gatePolicy:SCALED_GATE_POLICY});channels.push(c);return {c,sent};}
function callback(update_id=2,patch:Record<string,unknown>={}){return {update_id,callback_query:{id:"query",from:{id:7,is_bot:false},message:{chat:{id:-9},message_thread_id:12},data:"da:"+ask.id+":1",...patch}};}
function post(c:ReturnType<typeof telegramChannel>,event:unknown,secret="test_secret"){return fetch(new URL("/webhook",c.url()),{method:"POST",headers:{"content-type":"application/json","x-telegram-bot-api-secret-token":secret},body:JSON.stringify(event)});}
async function until(fn:()=>boolean){const end=Date.now()+4000;while(!fn()){if(Date.now()>end)throw Error("timeout");await Bun.sleep(10);}}
test("I3 I4 I5 Telegram callback authorization, topic scope, spinner response and dedupe",async()=>{const {c}=setup(),seen:InboundMessage[]=[];await c.start(async m=>{seen.push(m);return {status:"answered",text:"answer"};});
 expect((await post(c,callback(),"wrong")).status).toBe(401);
 for(const patch of [{from:{id:9,is_bot:false}},{message:{chat:{id:-10}}}])expect((await post(c,callback(2,patch))).status).toBe(403);
 for(const patch of [{data:"bad"},{message:{chat:{id:-9},message_thread_id:0}},{from:{id:1.1,is_bot:false}}])expect((await post(c,callback(2,patch))).status).toBe(400);
 expect((await post(c,callback(2,{from:{id:7,is_bot:true}}))).status).toBe(200);
 expect(await(await post(c,callback())).json()).toEqual({method:"answerCallbackQuery",callback_query_id:"query"});await post(c,callback());await until(()=>c.health().done===1);expect(seen).toHaveLength(1);expect(seen[0]).toMatchObject({threadKey:"123:-9:12:7",messageId:"2",choice:{askId:ask.id,option:1},text:"[ask "+ask.id+"] choice #2"});
 await post(c,callback(3,{from:{id:8,is_bot:false}}));await until(()=>c.health().done===2);expect(seen[1]!.threadKey).toBe("123:-9:12:8");
});
test("Telegram callback clears the pressed inline keyboard before the handler runs",async()=>{const {c,sent}=setup();await c.start(async()=>({status:"answered",text:"answer"}));await post(c,callback(2,{message:{message_id:5,chat:{id:-9},message_thread_id:12}}));await until(()=>c.health().done===1);expect(sent[0]).toEqual({chat_id:"-9",message_id:5,reply_markup:{inline_keyboard:[]}});expect(sent[1].text).toBe("answer");expect(sent.some(b=>b.callback_query_id!==undefined)).toBe(false);});
test("Telegram answer then persisted inline keyboard escapes HTML and keeps topic",async()=>{const {c,sent}=setup();await c.start(async()=>({status:"answered",text:"answer",asks:[ask]}));await post(c,{update_id:1,message:{message_id:1,from:{id:7,is_bot:false},chat:{id:-9},message_thread_id:12,text:"question"}});await until(()=>c.health().done===1);expect(sent).toHaveLength(2);expect(sent[0].text).toBe("answer");expect(sent[1]).toMatchObject({message_thread_id:12,parse_mode:"HTML",reply_markup:{inline_keyboard:[[{text:"SQLite (기본값)",callback_data:"da:"+ask.id+":0"}],[{text:"Postgres",callback_data:"da:"+ask.id+":1"}]]}});expect(sent[1].text).toContain("&lt;script&gt; &amp; DB?");expect(sent[1].text).not.toContain("<script>");for(const row of sent[1].reply_markup.inline_keyboard)expect(Buffer.byteLength(row[0].callback_data)).toBeLessThanOrEqual(64);});
