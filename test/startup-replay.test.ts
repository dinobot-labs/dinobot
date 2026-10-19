import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, LiveDoc, type DocumentId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

import { Database } from "bun:sqlite";

test("the authenticated historical replay repair preserves the recorded partial", async () => {
 const dir = await mkdtemp(join(tmpdir(), "dinobot-history-"));
 const path = join(dir, "bot.sqlite");
 const storage = await openNodeSqliteStorage(path);
 await storage.close(context);
 const db = new Database(path);
 const record = {id:3525,kind:"pi.live",scope:{kind:"conversation",conversationId:3524},history:"latest",fork:"initial",createdAt:20788};
 const value = {run:{taskId:21842,inputs:[18955]},generation:{attempt:1,message:{content:[{type:"text",text:""},{type:"toolCall",partialJson:"recorded",arguments:{code:"recorded"}}]}}};
 db.query("INSERT INTO documents VALUES (3525, ?, 0, ?, 'conversation', 3524, 20788, NULL, ?)").run(JSON.stringify("pi.live"), JSON.stringify(""), JSON.stringify(record));
 const insert = db.query("INSERT INTO document_revisions VALUES (3525, ?, ?, 1, ?)");
 insert.run(117979,"base",JSON.stringify(value));
 insert.run(118182,"delta",'[["s",["generation"],{"attempt":1}]]');
 insert.run(118185,"delta",JSON.stringify([["a",["generation","message","content",1,"partialJson"],"-next"],["a",["generation","message","content",1,"arguments","code"],"-next"]]));
 db.close();
 const reopened = await openNodeSqliteStorage(path);
 try {
  const restored = await reopened.document(3525 as DocumentId,"current",context);
  expect(restored?.value).toEqual({...value,generation:{...value.generation,message:{content:[{type:"text",text:""},{type:"toolCall",partialJson:"recorded-next",arguments:{code:"recorded-next"}}]}}});
 } finally { await reopened.close(context); }
 // Any different identity, revision bytes or subsequent path stays fail-closed.
 for (const statement of [
  "UPDATE documents SET record = json_set(record, '$.scope.conversationId', 3523)",
  "UPDATE document_revisions SET content = '[[\"s\",[\"generation\"],{\"attempt\":2}]]' WHERE seq = 118182",
  "UPDATE document_revisions SET seq = 118186 WHERE seq = 118185",
 ]) {
  const altered = new Database(path);
  altered.exec("BEGIN");
  altered.exec("UPDATE documents SET record = json_set(record, '$.scope.conversationId', 3524)");
  altered.query("UPDATE document_revisions SET content = ? WHERE seq = 118182").run('[["s",["generation"],{"attempt":1}]]');
  altered.exec("UPDATE document_revisions SET seq = 118185 WHERE seq = 118186");
  altered.exec(statement);
  altered.exec("COMMIT");
  altered.close();
  const rejected = await openNodeSqliteStorage(path);
  try { await expect(rejected.document(3525 as DocumentId,"current",context)).rejects.toThrow("unresolvable path"); }
  finally { await rejected.close(context); }
 }
});

test("failed corrupt task cleanup is quarantined without starving timers", async () => {
 const dir = await mkdtemp(join(tmpdir(), "dinobot-scheduler-"));
 const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/scheduler-corrupt-replay.ts"), join(dir, "bot.sqlite")], { stdout: "pipe", stderr: "pipe" });
 const timeout = setTimeout(() => child.kill(), 4000);
 try {
  const output = await new Response(child.stdout).text();
  const errors = await new Response(child.stderr).text();
  expect(await child.exited, errors).toBe(0);
  const result = JSON.parse(output);
  expect(result.heartbeat).toBe(true);
  expect(result.reopenedRecovery).toBe(true);
  expect(result.first).toBeGreaterThan(0);
  expect(result.reports).toBe(result.first);
  expect(result.healthy).toBe("unanswered");
  expect(result.stableAfterHealthy).toBe(true);
  expect(result.inspected.tasks.some((task: {state:{reason?:string}}) => task.state.reason === "settlement_failed")).toBe(true);
 } finally { clearTimeout(timeout); child.kill(); }
}, 6000);

test("a stale independent process cannot overwrite a newer SQLite generation", async () => {
 const dir = await mkdtemp(join(tmpdir(),"dinobot-process-writer-"));
 const path = join(dir,"bot.sqlite");
 const harness = await Harness.open(await openNodeSqliteStorage(path),{models:createModels(),registry:createRegistry()},context);
 const conversation = await harness.createConversation({ownership:{kind:"ownerless"}},context);
 const child = Bun.spawn([process.execPath,join(import.meta.dir,"fixtures/stale-sqlite-writer.ts"),path,String(conversation.id)],{stdin:"pipe",stdout:"pipe",stderr:"pipe"});
 const deadline=setTimeout(()=>child.kill(),4000);
 try {
  const reader=child.stdout.getReader();
  const ready=await reader.read();
  expect(new TextDecoder().decode(ready.value)).toContain("ready");
  await harness.commit(async tx=>{(await tx.doc(LiveDoc,conversation.id)).generation={attempt:2};},context);
  child.stdin.write("commit\n"); child.stdin.end();
  const result=await reader.read();
  expect(new TextDecoder().decode(result.value)).toContain("writer is stale");
  expect(await child.exited).toBe(0);
  expect((await harness.snapshot(LiveDoc,conversation.id,context))?.generation?.attempt).toBe(2);
 } finally {clearTimeout(deadline);child.kill();await harness.close(context);}
},6000);

test("a stale SQLite producer cannot commit a partial after another producer replaces generation", async () => {
 const dir = await mkdtemp(join(tmpdir(), "dinobot-replay-"));
 const path = join(dir, "bot.sqlite");
 const open = async () => Harness.open(await openNodeSqliteStorage(path), { models: createModels(), registry: createRegistry() }, context);
 const first = await open();
 let second: Harness | undefined;
 try {
  const conversation = await first.createConversation({ownership:{kind:"ownerless"}}, context);
  await first.commit(async tx => { (await tx.doc(LiveDoc, conversation.id)).generation = {attempt:1, message: {role:"assistant",content:[{type:"text",text:"safe"}],api:"faux",provider:"faux",model:"one",usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:"stop",timestamp:0}}; }, context);
  second = await open();
  await second.commit(async tx => { (await tx.doc(LiveDoc, conversation.id)).generation = {attempt:1}; }, context);
  const before = await second.snapshot(LiveDoc, conversation.id, context);
  await expect(first.commit(async tx => { (await tx.doc(LiveDoc, conversation.id)).generation!.message!.content[0] = {type:"text",text:"safe-next"}; }, context)).rejects.toThrow("writer is stale");
  expect(await second.snapshot(LiveDoc, conversation.id, context)).toEqual(before);
  await second.close(context);
  second = await open();
  expect(await second.snapshot(LiveDoc, conversation.id, context)).toEqual(before);
  await expect(first.commit(async tx => { (await tx.doc(LiveDoc, conversation.id)).generation = {attempt:2}; }, context)).rejects.toThrow("writer is stale");
 } finally {
  await second?.close(context); await first.close(context); await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100}).catch(error => { if (error.code !== "EBUSY") throw error; });
 }
});
