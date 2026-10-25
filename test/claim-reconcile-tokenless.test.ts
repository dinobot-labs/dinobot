import {expect,test} from "bun:test";
import {BACKGROUND_CONTEXT as context} from "@earendil-works/chord/context";
import {createModels} from "@earendil-works/pi-ai/models";
import {createRegistry,defineTask,Harness,MemoryStorage,type Storage} from "@earendil-works/pi-durable";
import {openNodeSqliteStorage} from "@earendil-works/pi-durable/storage/sqlite/node";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {NativeProvenanceDoc} from "../src/core/claim-cleanup.ts";
import {ClaimsDoc} from "../src/core/claims.ts";
import {WorkspaceCoordDoc} from "../src/core/verification.ts";
import {ABANDONMENT_ACCEPTANCE,abandonQuarantine,ClaimReconcileAuditDoc,parseNativeCallRefs,planNativeCallReconciliation,planQuarantineAbandonment,reconcileNativeCalls,type ObserveQuiescence} from "../src/core/claim-reconcile.ts";

const quiescent:ObserveQuiescence=async()=>({state:"quiescent",evidence:"synthetic process group is empty"});
const pending=defineTask({name:"fixture.tokenless.pending",version:1,initial:()=>({phase:"wait" as const}),phases:{wait:async()=>{}},abort:async()=>{}});
async function fixture(body:(f:Awaited<ReturnType<typeof setup>>)=>Promise<void>,keepParent=false,keepTask=false){
 const f=await setup(keepParent,keepTask);try{await body(f);}finally{await f.h.close(context);}
}
async function setup(keepParent=false,keepTask=false,storage:Storage=new MemoryStorage()){
 const h=await Harness.open(storage,{registry:createRegistry(),models:createModels()},context);
 const root=await h.root(context);
 const ids=await h.commit(async tx=>{
  const parent=await tx.createTask(pending,{}, {conversationId:root.id,ownership:{kind:"conversation"}});
  const child=await tx.createConversation({ownership:{kind:"task",taskId:parent}});
  const task=await tx.createTask(pending,{}, {conversationId:child.id,ownership:{kind:"conversation"}});
  return {parent,child:child.id,task};
 },context);
 if(!keepTask){await h.abortTask(ids.task,context);await h.waitForTask(ids.task,context);}
 if(!keepParent){await h.abortTask(ids.parent,context);await h.waitForTask(ids.parent,context);}
 const ref={conversationId:Number(ids.child),taskId:String(ids.task)};
 await h.commit(async tx=>{
  (await tx.doc(NativeProvenanceDoc,ids.child)).calls.push({taskId:ref.taskId,kind:"process",phase:"unknown",tokens:[],acquiredTokens:[],processes:[
   {phase:"admitted",nonce:"synthetic-child",pid:null,startTime:null,controlled:false},
   {phase:"started",nonce:"synthetic-child",pid:2000000000,startTime:"synthetic recorded identity",controlled:false},
  ]});
  (await tx.doc(WorkspaceCoordDoc)).leases.push({id:`native:${ref.taskId}:process`,root:"synthetic",environment:"synthetic",conversationId:String(ids.child),taskId:ref.taskId,workId:"",reason:"native process provenance",phase:"blocked-unknown"},
   {id:"synthetic-unrelated",root:"elsewhere",environment:"synthetic",conversationId:String(root.id),taskId:String(ids.parent),workId:"unrelated",reason:"unrelated effect",phase:"blocked-unknown"});
  (await tx.doc(ClaimsDoc)).claims.push({key:"fixture:unrelated",holder:"fixture:other",token:42,intent:"preserve",acquiredAt:1,expiresAt:2,quarantined:"UNKNOWN managed effect intent"});
 },context);
 return {h,root:root.id,...ids,ref};
}
async function request(f:Awaited<ReturnType<typeof setup>>,observe=quiescent){
 const plan=await planNativeCallReconciliation(f.h,[f.ref],context,observe);
 return {calls:[f.ref],actor:"fixture-operator",note:"exact tokenless child",snapshot:plan.snapshot};
}

test("explicit tokenless reconciliation preserves claims, task records, events and unrelated leases; audits exact calls",()=>fixture(async f=>{
 const claims=await f.h.snapshot(ClaimsDoc,context);const task=await f.h.getTask(f.task,context);const parent=await f.h.getTask(f.parent,context);
 const journal=await f.h.snapshot(NativeProvenanceDoc,f.child,context);
 const req=await request(f);expect((await planNativeCallReconciliation(f.h,[f.ref],context,quiescent)).blockers).toEqual([]);
 expect((await f.h.snapshot(NativeProvenanceDoc,f.child,context))?.calls[0]?.phase).toBe("unknown");
 expect(await reconcileNativeCalls(f.h,req,context,quiescent,()=>123)).toMatchObject({status:"reconciled",released:[],unfenced:[],retained:[]});
 expect(await f.h.snapshot(ClaimsDoc,context)).toEqual(claims);expect(await f.h.getTask(f.task,context)).toEqual(task);expect(await f.h.getTask(f.parent,context)).toEqual(parent);
 const after=(await f.h.snapshot(NativeProvenanceDoc,f.child,context))!.calls[0]!;expect(after.phase).toBe("reconciled");expect(after.processes).toEqual(journal!.calls[0]!.processes);
 expect((await f.h.snapshot(WorkspaceCoordDoc,context))!.leases.map(l=>l.id)).toEqual(["synthetic-unrelated"]);
 expect((await f.h.snapshot(ClaimReconcileAuditDoc,context))!.entries).toMatchObject([{snapshot:req.snapshot,at:123,actor:req.actor,released:[],retained:[],calls:[{conversationId:f.ref.conversationId,taskId:f.ref.taskId}]}]);
 expect((await reconcileNativeCalls(f.h,req,context,quiescent)).status).toBe("refused");
}));

test("tokenless child reconciliation unblocks explicit abandonment without relabeling historical external effects",()=>fixture(async f=>{
 const external={key:"fixture:historical-external",holder:"fixture:root",token:43,intent:"synthetic historical uncertainty",acquiredAt:1,expiresAt:2,quarantined:"UNKNOWN native external:image_gen_generate provenance"};
 await f.h.commit(async tx=>{
  (await tx.doc(ClaimsDoc)).claims.push(external);
  (await tx.doc(NativeProvenanceDoc,f.root)).calls.push({taskId:String(f.parent),kind:"external:image_gen_generate",tokens:[external],phase:"unknown"});
  const coord=await tx.doc(WorkspaceCoordDoc);coord.leases=coord.leases.filter(l=>l.id!=="synthetic-unrelated");
  coord.leases.push({id:`native:${f.parent}:external:image_gen_generate`,root:"synthetic",environment:"synthetic",conversationId:String(f.root),taskId:String(f.parent),workId:"",reason:"native external:image_gen_generate provenance",phase:"blocked-unknown"});
 },context);
 const blocked=await planQuarantineAbandonment(f.h,[external],context,quiescent);
 expect(blocked.blockers).toContain(`unresolved unrelated lease native:${f.task}:process`);
 expect((await reconcileNativeCalls(f.h,await request(f),context,quiescent)).status).toBe("reconciled");
 expect((await f.h.snapshot(NativeProvenanceDoc,f.root,context))!.calls[0]!.phase).toBe("unknown");
 expect((await f.h.snapshot(ClaimsDoc,context))!.claims).toContainEqual(external);
 const ready=await planQuarantineAbandonment(f.h,[external],context,quiescent);expect(ready.blockers).toEqual([]);
 expect(await abandonQuarantine(f.h,{tokens:[external],snapshot:ready.snapshot,actor:"fixture-operator",note:"explicit synthetic risk acceptance",acceptance:ABANDONMENT_ACCEPTANCE},context,quiescent)).toMatchObject({status:"abandoned",canonicalQuiescence:false});
 expect((await f.h.snapshot(ClaimsDoc,context))!.claims.map(c=>c.token)).toEqual([42]);
}));

for(const variant of ["missing call","held tokens","acquired tokens","wrong lease owner","missing lease","wrong work lease","unknown evidence","alive evidence","missing identity","missing admission","canonical receipt without identity","duplicate journal call","non-process call","missing task","wrong task conversation"] as const){
 test("tokenless reconcile refuses "+variant,()=>fixture(async f=>{
  let observe=quiescent;
  await f.h.commit(async tx=>{
   const call=(await tx.doc(NativeProvenanceDoc,f.child)).calls[0]!;const coord=await tx.doc(WorkspaceCoordDoc);
   if(variant==="missing call")call.taskId="999999";
   if(variant==="held tokens")call.tokens.push((await tx.doc(ClaimsDoc)).claims[0]!);
   if(variant==="acquired tokens")call.acquiredTokens=[(await tx.doc(ClaimsDoc)).claims[0]!];
   if(variant==="wrong lease owner")coord.leases[0]!.conversationId=String(f.root);
   if(variant==="missing lease")coord.leases.shift();
   if(variant==="wrong work lease")coord.leases[0]!.workId="managed-work";
   if(variant==="missing identity")call.processes=call.processes!.filter(e=>e.phase!=="started");
   if(variant==="missing admission")call.processes=call.processes!.filter(e=>e.phase!=="admitted");
   if(variant==="canonical receipt without identity")call.processes=[{phase:"admitted",nonce:"synthetic-child",pid:null,startTime:null,controlled:false},{phase:"settled",nonce:"synthetic-child",pid:null,startTime:null,controlled:false,canonical:true}];
   if(variant==="duplicate journal call")(await tx.doc(NativeProvenanceDoc,f.child)).calls.push(JSON.parse(JSON.stringify(call)));
   if(variant==="non-process call")call.kind="external:computer_use";
   if(variant==="missing task"||variant==="wrong task conversation"){
    f.ref.taskId=variant==="missing task"?"999999":String(f.parent);call.taskId=f.ref.taskId;
    coord.leases[0]!.id=`native:${f.ref.taskId}:process`;coord.leases[0]!.taskId=f.ref.taskId;
   }
  },context);
  if(variant==="unknown evidence")observe=async()=>({state:"unknown",evidence:"no identity"});
  if(variant==="alive evidence")observe=async()=>({state:"alive",evidence:"descendant remains"});
  const before=JSON.stringify(await f.h.snapshot(NativeProvenanceDoc,f.child,context));const leases=await f.h.snapshot(WorkspaceCoordDoc,context);
  const req=await request(f,observe);const plan=await planNativeCallReconciliation(f.h,[f.ref],context,observe);expect(plan.blockers.length).toBeGreaterThan(0);
  if(variant==="missing task"||variant==="wrong task conversation")expect(plan.blockers.join(" ")).toContain("missing, nonterminal or belongs to another conversation");
  expect((await reconcileNativeCalls(f.h,req,context,observe)).status).toBe("refused");expect(JSON.stringify(await f.h.snapshot(NativeProvenanceDoc,f.child,context))).toBe(before);expect(await f.h.snapshot(WorkspaceCoordDoc,context)).toEqual(leases);
  expect((await f.h.snapshot(ClaimReconcileAuditDoc,context))?.entries??[]).toHaveLength(0);
 }));
}
test("running parent refuses even with positive process evidence",()=>fixture(async f=>{
 expect((await planNativeCallReconciliation(f.h,[f.ref],context,quiescent)).blockers.join(" ")).toContain("owner task");
 expect((await reconcileNativeCalls(f.h,await request(f),context,quiescent)).status).toBe("refused");
},true));
test("a nonterminal call task refuses independently of positive OS evidence",()=>fixture(async f=>{
 expect((await planNativeCallReconciliation(f.h,[f.ref],context,quiescent)).blockers.join(" ")).toContain(`native task ${f.task} is missing, nonterminal`);
 expect((await reconcileNativeCalls(f.h,await request(f),context,quiescent)).status).toBe("refused");
},true,true));
test("stale snapshot and state changes during observation refuse before mutation",()=>fixture(async f=>{
 const stale=await request(f);await f.h.commit(async tx=>{(await tx.doc(WorkspaceCoordDoc)).leases[0]!.reason="changed";},context);
 expect(await reconcileNativeCalls(f.h,stale,context,quiescent)).toMatchObject({status:"refused",error:"snapshot_mismatch"});
 const fresh=await request(f);let changed=false;
 const racing:ObserveQuiescence=async()=>{if(!changed){changed=true;await f.h.commit(async tx=>{(await tx.doc(WorkspaceCoordDoc)).leases[0]!.reason="changed again";},context);}return {state:"quiescent",evidence:"synthetic"};};
 expect(await reconcileNativeCalls(f.h,fresh,context,racing)).toMatchObject({status:"refused",error:"changed_during_reconcile"});
 expect((await f.h.snapshot(NativeProvenanceDoc,f.child,context))!.calls[0]!.phase).toBe("unknown");
}));
test("invalid and duplicate call references cannot name a broader scope",()=>{
 for(const refs of [[],[{conversationId:0,taskId:"1"}],[{conversationId:1,taskId:"01"}],[{conversationId:1,taskId:"1e2"}],[{conversationId:1,taskId:"9007199254740992"}],[{conversationId:1,taskId:"2"},{conversationId:1,taskId:"2"}]])expect(()=>parseNativeCallRefs(refs)).toThrow();
});
test("actor, note and a valid snapshot are required before mutation",()=>fixture(async f=>{
 const req=await request(f);
 for(const change of [{actor:" "},{note:" "},{actor:"x".repeat(201)},{note:"x".repeat(2001)},{snapshot:""}])expect((await reconcileNativeCalls(f.h,{...req,...change},context,quiescent)).status).toBe("refused");
 expect((await f.h.snapshot(NativeProvenanceDoc,f.child,context))!.calls[0]!.phase).toBe("unknown");
}));
test("failed authoritative readback reports an ambiguous committed result instead of success",()=>fixture(async f=>{
 const req=await request(f);
 const withheld=new Proxy(f.h,{get(target,key){if(key==="snapshot")return async(...args:unknown[])=>args[0]===ClaimReconcileAuditDoc?undefined:Reflect.apply(target.snapshot,target,args);const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;}});
 expect(await reconcileNativeCalls(withheld,req,context,quiescent)).toMatchObject({status:"refused",error:"reconciliation_readback_failed"});
 expect((await f.h.snapshot(NativeProvenanceDoc,f.child,context))!.calls[0]!.phase).toBe("reconciled");
}));
test("SQLite reconciliation and audit survive close/reopen while preserving unrelated records",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"tokenless-native-storage-")),path=join(dir,"synthetic.sqlite");
 let first:Awaited<ReturnType<typeof setup>>|undefined,reopened:Harness|undefined;
 try{
  first=await setup(false,false,await openNodeSqliteStorage(path));
  const {ref,child,task}=first,taskBefore=await first.h.getTask(task,context),claimsBefore=await first.h.snapshot(ClaimsDoc,context);
  const req=await request(first);expect((await reconcileNativeCalls(first.h,req,context,quiescent)).status).toBe("reconciled");
  await first.h.close(context);first=undefined;Bun.gc(true);
  reopened=await Harness.open(await openNodeSqliteStorage(path),{registry:createRegistry(),models:createModels()},context);
  expect((await reopened.snapshot(NativeProvenanceDoc,child,context))!.calls[0]!.phase).toBe("reconciled");
  expect((await reopened.snapshot(ClaimReconcileAuditDoc,context))!.entries[0]!.snapshot).toBe(req.snapshot);
  expect(await reopened.getTask(task,context)).toEqual(taskBefore);expect(await reopened.snapshot(ClaimsDoc,context)).toEqual(claimsBefore);
  expect((await reopened.snapshot(WorkspaceCoordDoc,context))!.leases.map(l=>l.id)).toEqual(["synthetic-unrelated"]);
  expect((await reconcileNativeCalls(reopened,{...req,calls:[ref]},context,quiescent)).status).toBe("refused");
 }finally{if(first)await first.h.close(context);if(reopened)await reopened.close(context);Bun.gc(true);await Bun.sleep(100);await rm(dir,{recursive:true,force:true});}
});
