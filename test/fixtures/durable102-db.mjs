import { createHash } from "node:crypto";
// Runs only in a child process against an explicitly supplied, read-only 1.0.2 installation.
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
const [root,directory,mode="pending"]=process.argv.slice(2);
if(!root||!directory)throw new Error("Expected legacy installation root and disposable directory");
const load=(pkg,file)=>import(pathToFileURL(join(root,"node_modules",pkg,file)).href);
const packageJson=JSON.parse(await readFile(join(root,"node_modules/@earendil-works/pi-durable/package.json"),"utf8"));
if(packageJson.version!=="1.0.2")throw new Error("Fixture requires exactly pi-durable 1.0.2, got "+packageJson.version);
const {BACKGROUND_CONTEXT:context}=await load("@earendil-works/chord","dist/context/index.js");
const {createModels}=await load("@earendil-works/pi-ai","dist/models.js");
const {fauxAssistantMessage,fauxToolCall}=await load("@earendil-works/pi-ai","dist/providers/faux.js");
const {Harness,createRegistry,defineExtension,defineTask,ToolTask,LiveDoc,InboxDoc}=await load("@earendil-works/pi-durable","dist/index.js");
const {openNodeSqliteStorage}=await load("@earendil-works/pi-durable","dist/storage/sqlite/node.js");
const entered={safe:Promise.withResolvers(),unsafe:Promise.withResolvers(),sleep:Promise.withResolvers()};
const deadline=10000;
const sleeper=defineTask({name:"test.migration-sleep",version:1,initial:input=>({phase:"wait",until:input.until}),phases:{
 async wait(task,runtime,ctx){entered.sleep.resolve();await runtime.sleep(task.state.checkpoint.until,ctx);await runtime.commit(()=>({status:"terminal",outcome:{status:"completed",result:"awoke"}}),ctx);},
},async abort(_task,runtime,ctx){await runtime.commit(()=>({status:"terminal",outcome:{status:"aborted"}}),ctx);}});
const registry=createRegistry();
registry.install(defineExtension({name:"migration-fixture",tasks:[sleeper],tools:["safe","unsafe"].map(replay=>({
 name:replay,description:replay,parameters:{type:"object",properties:{value:{type:"string"}},required:["value"]},replay,
 async execute(_args,_api,ctx){entered[replay].resolve();await new Promise(resolve=>ctx.abortSignal.addEventListener("abort",resolve,{once:true}));ctx.abortSignal.throwIfAborted();throw new Error("Unreachable");},
}))}));
const file=join(directory,"legacy.sqlite");
const open=async()=>Harness.open(await openNodeSqliteStorage(file),{models:createModels(),registry,now:()=>1000},context);
let harness=await open();
const conversation=await harness.createConversation({ownership:{kind:"ownerless"}},context);
const ids={mode,conversation:conversation.id,tasks:{},entries:[],submission:0,deadline};
async function addTool(replay,label){return harness.commit(async tx=>{
 const message=fauxAssistantMessage(fauxToolCall(replay,{value:label},{id:label}),{stopReason:"toolUse",timestamp:1000});
 const entry=await tx.appendEntry(conversation.id,{kind:"pi.assistant",model:[message]});ids.entries.push(entry);
 const id=await tx.createTask(ToolTask,{assistant:entry.id,callId:label},{ownership:{kind:"conversation"},conversationId:conversation.id});ids.tasks[label]=id;return id;
},context);}
await addTool("safe","safe");await addTool("unsafe","unsafe");
ids.sleep=await harness.commit(tx=>tx.createTask(sleeper,{until:deadline},{ownership:{kind:"conversation"},conversationId:conversation.id}),context);
if(mode==="running"){
 harness.resume();await Promise.all(Object.values(entered).map(x=>x.promise));
}
await harness.commit(async tx=>{
 const live=await tx.doc(LiveDoc,conversation.id);
 live.run={taskId:ids.sleep,inputs:[]};
 live.generation={attempt:4,message:fauxAssistantMessage("saved partial",{timestamp:1000})};
 live.compactions=[{taskId:ids.sleep,reason:"manual",blocking:false}];
 const submission=await tx.createSubmission({conversationId:conversation.id,type:"input",status:"queued",requestId:"legacy-queued"});ids.submission=submission.id;
 (await tx.doc(InboxDoc,conversation.id)).items.push({id:submission.id,mode:"followUp",content:"saved queued input"});
 const entry=await tx.appendEntry(conversation.id,{kind:"test.history",data:{text:"saved history",number:17}});ids.entries.push(entry);
},context);
ids.live=await harness.snapshot(LiveDoc,conversation.id,context);
ids.inbox=await harness.snapshot(InboxDoc,conversation.id,context);
ids.records=await Promise.all([...Object.values(ids.tasks),ids.sleep].map(id=>harness.getTask(id,context)));
if(mode!=="running")await harness.close(context);
const db=new DatabaseSync(file,{readOnly:true});
ids.schema=db.prepare("SELECT * FROM durable_schema").all();
ids.integrity=db.prepare("PRAGMA integrity_check").all();
const digest=createHash("sha256");
async function hashTree(dir,prefix=""){
 for(const item of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
  const relative=prefix+item.name;
  if(item.isDirectory())await hashTree(join(dir,item.name),relative+"/");
  else if(item.name.endsWith(".js")){digest.update(relative);digest.update(await readFile(join(dir,item.name)));}
 }
}
await hashTree(join(root,"node_modules/@earendil-works/pi-durable/dist"));
ids.provenance={durableVersion:packageJson.version,durableJavaScriptSha256:digest.digest("hex"),generatorSha256:createHash("sha256").update(await readFile(import.meta.path)).digest("hex"),sourceCheckout:process.env.DINOBOT_LEGACY_SOURCE_SHA??null,dependencies:{}};
for(const name of ["chord","pi-ai"])ids.provenance.dependencies[name]=JSON.parse(await readFile(join(root,"node_modules/@earendil-works/"+name+"/package.json"),"utf8")).version;
const ident=name=>'"'+name.replaceAll('"','""')+'"';
const quote=value=>db.prepare("SELECT quote(?) AS value").get(value).value;
const schema=db.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END,name").all();
const lines=["-- Immutable synthetic fixture exported by durable102-db.mjs; never a user database.","-- manifest: "+JSON.stringify(ids),"BEGIN;"];
for(const object of schema)if(object.type==="table"){
 lines.push(object.sql+";");
 for(const row of db.prepare("SELECT * FROM "+ident(object.name)).all()) {
  const values=Object.values(row).map(quote).join(",");
  lines.push("INSERT INTO "+ident(object.name)+" VALUES ("+values+");");
 }
}
for(const object of schema)if(object.type!=="table")lines.push(object.sql+";");
lines.push("COMMIT;","");
await writeFile(join(directory,mode+".sql"),lines.join("\n"));
db.close();
await writeFile(join(directory,"legacy.json"),JSON.stringify(ids));
console.log(JSON.stringify({version:packageJson.version,schema:ids.schema,states:ids.records.map(t=>({id:t.id,status:t.state.status,phase:t.state.checkpoint?.phase}))}));

// Intentional crash boundary: all captured commits returned; no live database is copied until this process exits.
process.exit(0);
