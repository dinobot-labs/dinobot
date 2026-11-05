import { Type } from "typebox";
import { expect } from "bun:test";
import { copyFile, mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT as context, withAbortSignal, awaitWithContext } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineExtension, defineTask, Harness, InboxDoc, LiveDoc, type ConversationId, type EntryRecord, type JsonObject, type InboxState, type SubmissionId, type TaskId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { sqliteTest } from "./fixtures/sqlite-test.ts";

type Legacy = {
 mode: "pending" | "running"; conversation: ConversationId; sleep: TaskId; deadline: number;
 tasks: Record<"safe" | "unsafe", TaskId>; submission: SubmissionId; entries: EntryRecord[];
 live: JsonObject; inbox: InboxState; records: {id:TaskId;state:{status:string;checkpoint:{phase:string;until?:number}}}[];
 schema: {singleton:number;version:number}[];
};
function sql(file:string,query:string){const db=new DatabaseSync(file,{readOnly:true});try{return db.prepare(query).all();}finally{db.close();}}

for(const mode of ["pending","running"] as const)sqliteTest(import.meta.path,
 '1.0.2 '+mode+' SQLite migrates history, live, queue, sleep and safe/unsafe tools',async directory=>{
 const legacyDirectory=join(directory,"legacy");await mkdir(legacyDirectory);
 // Ordinary tests use a checked-in SQL export from the real 1.0.2 producer, never a network or sibling install.
 // Explicit regeneration uses only the supplied old installation and writes into this disposable directory.
 let saved: Legacy;
 if(process.env.DINOBOT_DURABLE_102_ROOT){
  const child=Bun.spawn([process.execPath,join(import.meta.dir,"fixtures/durable102-db.mjs"),process.env.DINOBOT_DURABLE_102_ROOT,legacyDirectory,mode],{stdout:"pipe",stderr:"pipe"});
  const timer=setTimeout(()=>child.kill(),10_000);
  try{
   const [out,error,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
   expect(code,out+error).toBe(0);
   saved=JSON.parse(await readFile(join(legacyDirectory,"legacy.json"),"utf8")) as Legacy;
  }finally{clearTimeout(timer);child.kill();await child.exited;}
 }else{
  const exported=await readFile(join(import.meta.dir,"fixtures/durable102",mode+".sql"),"utf8");
  const manifest=exported.split("\n").find(line=>line.startsWith("-- manifest: "));
  if(!manifest)throw new Error("Legacy SQL fixture has no producer manifest");
  saved=JSON.parse(manifest.slice("-- manifest: ".length)) as Legacy;
  const source=new DatabaseSync(join(legacyDirectory,"legacy.sqlite"));
  try{source.exec(exported);}finally{source.close();}
 }
 expect(saved.mode).toBe(mode);
 expect(saved.schema).toEqual([{singleton:1,version:1}]);
 expect(saved.records.map(record=>record.state.status)).toEqual([mode,mode,mode]);
 expect(saved.records.slice(0,2).map(record=>record.state.checkpoint.phase)).toEqual(mode==="running"?["execute","execute"]:["call","call"]);
 const source=join(legacyDirectory,"legacy.sqlite");
 const originalIndices=sql(source,"SELECT name FROM sqlite_master WHERE type='index' ORDER BY name");
 // The producer has exited. Copy the entire quiescent SQLite file set, including any crash WAL; never an active DB.
 for(const name of await readdir(legacyDirectory))if(name.startsWith("legacy.sqlite"))await copyFile(join(legacyDirectory,name),join(directory,name.replace("legacy.sqlite","migrated.sqlite")));
 const file=join(directory,"migrated.sqlite");
 let now=1000;let awoke=0;const advertisedDeadlines:number[]=[];const executed:string[]=[];
 const sleeper=defineTask<{until:number},{phase:"wait";until:number}|{phase:"wake";until:number},number>({
  name:"test.migration-sleep",version:2,initial:input=>({phase:"wait",until:input.until}),
  migrate(input,checkpoint){
   if(!input||typeof input!=="object"||Array.isArray(input)||typeof input.until!=="number"||!checkpoint||typeof checkpoint!=="object"||Array.isArray(checkpoint)||checkpoint.phase!=="wait"||typeof checkpoint.until!=="number")throw new Error("Invalid old sleep checkpoint");
   return {input:{until:input.until},checkpoint:{phase:"wait",until:checkpoint.until}};
  },
  phases:{
   async wait(task,runtime,ctx){await runtime.sleepUntil(task.state.checkpoint.until,{phase:"wake",until:task.state.checkpoint.until},ctx);},
   async wake(_task,runtime,ctx){awoke++;await runtime.commit(()=>({status:"terminal",outcome:{status:"completed",result:runtime.now()}}),ctx);},
  },
  async abort(_task,runtime,ctx){await runtime.commit(()=>({status:"terminal",outcome:{status:"aborted"}}),ctx);},
 });
 const registry=createRegistry();registry.install(defineExtension({name:"migration-fixture",tasks:[sleeper],tools:(["safe","unsafe"] as const).map(replay=>({
  name:replay,description:replay,parameters:Type.Object({value:Type.String()}),replay,
  async execute(){executed.push(replay);return {output:[{type:"text" as const,text:"completed "+replay}]};},
 }))}));
 const open=async()=>Harness.open(await openNodeSqliteStorage(file),{models:createModels(),registry,now:()=>now,onWake(wake){if(wake.at!==undefined)advertisedDeadlines.push(wake.at);}},context);
 let harness=await open();
 const bounded=withAbortSignal(AbortSignal.timeout(5000),context);
 try{
  expect(sql(file,"SELECT version FROM durable_schema")).toEqual([{version:2}]);
  expect(sql(file,"PRAGMA integrity_check")).toEqual([{integrity_check:"ok"}]);
  expect(sql(file,"PRAGMA foreign_key_check")).toEqual([]);
  expect(sql(file,"SELECT name FROM sqlite_master WHERE type='index' ORDER BY name")).toEqual(originalIndices);
  for(const entry of saved.entries)expect(await harness.commit(tx=>tx.entry(entry.id),context)).toEqual(entry);
  expect(await harness.snapshot(InboxDoc,saved.conversation,context)).toEqual(saved.inbox);
  expect(await (await harness.submission(saved.submission,context))!.status(context)).toMatchObject({id:saved.submission,status:"queued",requestId:"legacy-queued"});
  const live=await harness.snapshot(LiveDoc,saved.conversation,context);
  expect(live).toMatchObject({run:{taskId:saved.sleep,turns:0,inputs:[]},generation:{attempt:4,message:{content:[{type:"text",text:"saved partial"}]}},compactions:[{taskId:saved.sleep,trigger:"manual",blocking:false}]});
  expect(live?.compactions?.[0]).not.toHaveProperty("reason");
  // Compare every saved live field too, not only the newly introduced fields.
  const expectedLive=structuredClone(saved.live);
  const oldRun=expectedLive.run;
  if(!oldRun||typeof oldRun!=="object"||Array.isArray(oldRun))throw new Error("Old fixture has no run");
  oldRun.turns=0;
  if(!Array.isArray(expectedLive.compactions))throw new Error("Old fixture has no compactions");
  for(const compaction of expectedLive.compactions){
   if(!compaction||typeof compaction!=="object"||Array.isArray(compaction)||!("reason" in compaction))throw new Error("Invalid old compaction");
   compaction.trigger=compaction.reason;delete compaction.reason;
  }
  expect<unknown>(live).toEqual(expectedLive);
  const sleeping=Promise.withResolvers<void>();
  const observer=harness.observeCommits({advance(publication){for(const change of publication.changes)if(change.type==="task"&&change.value.id===saved.sleep&&change.value.state.status==="sleeping")sleeping.resolve();},end(end){if(end.kind==="failed")sleeping.reject(end.error);}});
  harness.resume();
  const safe=await harness.waitForTask(saved.tasks.safe,bounded);
  const unsafe=await harness.waitForTask(saved.tasks.unsafe,bounded);
  await awaitWithContext(sleeping.promise,bounded);observer.detach();
  expect(safe.state.outcome.status).toBe("completed");
  expect(unsafe.state.outcome.status).toBe(mode==="running"?"failed":"completed");
  expect(executed.toSorted()).toEqual(mode==="running"?["safe"]:["safe","unsafe"]);
  const conversation=await harness.conversation(saved.conversation,context);
  if(!conversation)throw new Error("Migrated conversation missing");
  const messages=(await conversation.context(context)).messages.filter(message=>message.role==="toolResult");
  expect(messages).toHaveLength(2);
  expect(messages.find(message=>message.toolName==="unsafe")?.isError).toBe(mode==="running");
  expect(await harness.getTask(saved.sleep,context)).toMatchObject({id:saved.sleep,version:2,state:{status:"sleeping",until:saved.deadline,checkpoint:{phase:"wake",until:saved.deadline}}});
  expect(awoke).toBe(0);
  await harness.close(context);now=saved.deadline-1;harness=await open();
  expect((await harness.getTask(saved.sleep,context))?.state.status).toBe("sleeping");
  // Recovery reconciliation may itself be active; the sleeping task must retain its absolute deadline.
  harness.resume();await harness.commit(()=>undefined,context);
  expect(harness.wake().at).toBe(saved.deadline);
  expect(advertisedDeadlines).toContain(saved.deadline);
  expect(awoke).toBe(0);
  now=saved.deadline;harness.resume();
  expect((await harness.waitForTask(saved.sleep,bounded)).state.outcome).toEqual({status:"completed",result:saved.deadline});
  expect(awoke).toBe(1);
  await harness.close(context);harness=await open();
  expect((await harness.getTask(saved.sleep,context))?.state.status).toBe("terminal");
  expect(executed.toSorted()).toEqual(mode==="running"?["safe"]:["safe","unsafe"]);
  expect(sql(source,"SELECT version FROM durable_schema")).toEqual([{version:1}]);
 }finally{await harness.close(context);}
},20_000);
