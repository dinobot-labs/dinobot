import { afterEach, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineTask, Harness, MemoryStorage, type ConversationId, type EntryId, type Tx } from "@earendil-works/pi-durable";
import { auditVisibleSource, captureVisibleExport, exportVisible, validateVisibleExport, VisibleExportsDoc, type VisibleExport } from "../src/core/visible-export.ts";
import { digest } from "../src/core/verification-execution.ts";

const harnesses:Harness[]=[];
afterEach(async()=>{for(const h of harnesses.splice(0))await h.close(context);});
const writer=defineTask<boolean,{phase:"write"},number>({
 name:"fixture.visible-provenance.writer",version:1,initial:()=>({phase:"write"}),
 abort:async(_r,runtime,c)=>{await runtime.commit(()=>({status:"terminal",outcome:{status:"aborted"}}),c);},
 phases:{write:async(record,runtime,c)=>{await runtime.commit(async tx=>{
  const entry=record.input?await tx.appendEntry(runtime.conversationId,{kind:"pi.user",model:[{role:"user",content:"PUBLIC @pytest.fixture 😀 password=hidden-value",timestamp:1}],data:{reasoning:"PRIVATE_REASON",nested:JSON.stringify({code:"PUBLIC_TAIL",password:"PRIVATE_PASSWORD"})}}):undefined;
  return {status:"terminal",outcome:{status:"completed",result:entry?.id ?? 0}};
 },c);}},
});
async function fixture() {
 const registry=createRegistry();registry.install({name:"fixture",tasks:[writer]});
 const h=await Harness.open(new MemoryStorage(),{registry,models:createModels()},context);harnesses.push(h);
 const root=await h.root(context);const source=await h.createConversation({ownership:{kind:"ownerless"}},context);
 const byTaskId=await h.commit(tx=>tx.createTask(writer,true,{conversationId:source.id,ownership:{kind:"conversation"}}),context);
 const done=await h.waitForTask(byTaskId,context);if(done.state.outcome.status!=="completed")throw Error("fixture failed");
 const entryId=done.state.outcome.result as EntryId;
 const ownerTaskId=await h.commit(tx=>tx.createTask(writer,false,{conversationId:root.id,ownership:{kind:"conversation"}}),context);
 const views=await h.commit(async tx=>{
  const a=await tx.forkConversation(source.id,entryId,{ownership:{kind:"task",taskId:ownerTaskId}});
  const b=await tx.forkConversation(source.id,entryId,{ownership:{kind:"task",taskId:ownerTaskId}});
  return [a.id,b.id];
 },context);
 const capture=()=>h.commit(tx=>captureVisibleExport(tx,root.id),context);
 return {h,root,source,entryId,byTaskId,ownerTaskId,views,capture};
}

test("shared ancestor in two views is one canonical source event with honest original ownership",async()=>{
 const f=await fixture();const receipt=await f.capture();const p=receipt.inventory.provenance!;
 expect(receipt.version).toBe(1);expect(receipt.entries).toHaveLength(2);
 expect(receipt.inventory.conversationIds).toEqual([f.root.id,...f.views]);
 expect(receipt.inventory.entryIds).toEqual([f.entryId]);
 expect(p.evidence).toEqual({canonicalEntryCount:1,membershipCount:2,dedupGroupCount:1,duplicateRepresentationCount:1,historicalState:"UNKNOWN"});
 expect(p.canonicalEntries).toEqual([{entryId:f.entryId,sourceConversationId:f.source.id,byTaskId:f.byTaskId,entryIndex:0,memberships:f.views.map((viewConversationId,entryIndex)=>({viewConversationId,entryIndex}))}]);
 expect(p.conversations.find(c=>c.conversationId===f.source.id)).toEqual({conversationId:f.source.id,recordState:"RECORDED",owner:null,parent:null});
 for(const view of f.views)expect(p.conversations.find(c=>c.conversationId===view)).toEqual({conversationId:view,recordState:"RECORDED",owner:{conversationId:f.root.id,taskId:f.ownerTaskId},parent:{conversationId:f.source.id,at:f.entryId}});
 for(let i=0;i<receipt.entries.length;i++)expect(receipt.entries[i]).toMatchObject({id:f.entryId,conversationId:f.views[i]});
 expect(receipt.witness.historicalState).toBe("UNKNOWN");expect(validateVisibleExport(receipt,receipt)).toBe(true);
});

test("same public body from a different source entry is not deduplicated",async()=>{
 const f=await fixture();
 await f.h.commit(async tx=>{await tx.appendEntry(f.views[0]!,{kind:"pi.user",model:[{role:"user",content:"PUBLIC @pytest.fixture 😀 password=hidden-value",timestamp:1}],data:{reasoning:"PRIVATE_REASON",nested:JSON.stringify({code:"PUBLIC_TAIL",password:"PRIVATE_PASSWORD"})}});},context);
 const receipt=await f.capture();expect(receipt.inventory.provenance!.evidence).toMatchObject({canonicalEntryCount:2,membershipCount:3,dedupGroupCount:1,duplicateRepresentationCount:1});
 expect(receipt.inventory.provenance!.canonicalEntries.find(e=>e.sourceConversationId===f.views[0])!.byTaskId).toBe("UNKNOWN");
});

// Fault injection is confined to the synthetic in-memory transaction. No live database.
function override(tx:Tx, changes:Partial<Tx>):Tx {
 return {conversation:tx.conversation.bind(tx),scanEntries:tx.scanEntries.bind(tx),scanConversations:tx.scanConversations.bind(tx),scanTasks:tx.scanTasks.bind(tx),...changes} as Tx;
}
test("missing parent/source record remains UNKNOWN without claiming fork ownership",async()=>{
 const f=await fixture();
 const receipt=await f.h.commit(tx=>captureVisibleExport(override(tx,{conversation:async id=>id===f.source.id?undefined:tx.conversation(id)}),f.root.id),context);
 const p=receipt.inventory.provenance!;
 expect(p.conversations.find(c=>c.conversationId===f.source.id)).toEqual({conversationId:f.source.id,recordState:"UNKNOWN",owner:"UNKNOWN",parent:"UNKNOWN"});
 expect(p.canonicalEntries[0]!.sourceConversationId).toBe(f.source.id);
 expect(p.canonicalEntries[0]!.byTaskId).toBe(f.byTaskId);
 expect(p.evidence.historicalState).toBe("UNKNOWN");expect(receipt.inventory.allowedLeafDiffs).toEqual([]);
});

test("metadata is filtered, independently source-audited and witnessed alongside private bodies",async()=>{
 const f=await fixture();
 // Deliberately malformed upstream metadata checks the privacy boundary, not upstream typing.
 const receipt=await f.h.commit(tx=>captureVisibleExport(override(tx,{scanEntries:async(...args)=>{
  const page=await tx.scanEntries(...args);return {...page,items:page.items.map(e=>({...e,byTaskId:"person@example.invalid" as never}))};
 }}),f.root.id),context);
 const p=receipt.inventory.provenance!;expect(p.canonicalEntries[0]!.byTaskId as unknown).toBe("[contact omitted]");
 expect(receipt.inventory.omissions.some(o=>o.path==="/inventory/provenance/canonicalEntries/0/byTaskId")).toBe(true);
 const path="/inventory/provenance/canonicalEntries/0/byTaskId";
 for(const leaves of [receipt.inventory.content,receipt.inventory.allowedSourceContent])expect(leaves.find(l=>l.path===path)).toEqual({path,hash:digest("[contact omitted]")});
 expect(receipt.inventory.allowedLeafDiffs).toEqual([]);expect(receipt.witness.provenanceHash).toBe(digest(p));
 for(const secret of ["hidden-value","PRIVATE_REASON","PRIVATE_PASSWORD","person@example.invalid"])expect(JSON.stringify(receipt)).not.toContain(secret);
 const lost=structuredClone(p);lost.canonicalEntries[0]!.memberships.pop();
 expect(auditVisibleSource(p,lost,"/inventory/provenance",[{path:"/inventory/provenance",reason:"fabricated"}]).allowedLeafDiffs.length).toBeGreaterThan(0);
});

test("metadata and canonical counters cannot be tampered with or stripped to pass validation",async()=>{
 const f=await fixture();const retained=await f.capture();
 const mutations:((r:VisibleExport)=>void)[]=[
  r=>{r.inventory.provenance!.canonicalEntries[0]!.sourceConversationId=f.root.id;},
  r=>{r.inventory.provenance!.canonicalEntries[0]!.byTaskId=f.ownerTaskId;},
  r=>{r.inventory.provenance!.canonicalEntries[0]!.memberships.pop();},
  r=>{r.inventory.provenance!.conversations.find(c=>c.conversationId===f.source.id)!.owner={conversationId:f.root.id,taskId:f.ownerTaskId};},
  r=>{r.inventory.provenance!.evidence.canonicalEntryCount++;},
  r=>{delete r.inventory.provenance;delete r.witness.provenanceHash;},
 ];
 for(const mutate of mutations){
  const receipt=structuredClone(retained);mutate(receipt);
  expect(validateVisibleExport(receipt,retained)).toBe(false);
  receipt.witness.inventoryHash=digest(receipt.inventory);
  if(receipt.inventory.provenance)receipt.witness.provenanceHash=digest(receipt.inventory.provenance);
  expect(validateVisibleExport(receipt,retained)).toBe(false);
 }
 const stale=structuredClone(retained);stale.witness.provenanceHash="0".repeat(64);expect(validateVisibleExport(stale,stale)).toBe(false);
 const unaudited=structuredClone(retained);unaudited.inventory.allowedLeafDiffs.push("/inventory/provenance");unaudited.witness.inventoryHash=digest(unaudited.inventory);expect(validateVisibleExport(unaudited,unaudited)).toBe(false);
});

test("canonical evidence and absolute memberships survive frozen cursor pagination",async()=>{
 const f=await fixture();const first=await exportVisible(f.h,f.root.id,context,undefined,1);
 const retained=(await f.h.snapshot(VisibleExportsDoc,f.root.id,context))!.snapshots.find(s=>s.snapshotId===first.snapshotId)!;
 expect(first.complete).toBe(false);expect(first.nextCursor).not.toBeNull();
 await f.h.commit(async tx=>{await tx.appendEntry(f.views[0]!,{kind:"pi.user",model:[{role:"user",content:"LATE",timestamp:2}]});},context);
 const tail=await exportVisible(f.h,f.root.id,context,first.nextCursor!);
 expect(tail.snapshotId).toBe(first.snapshotId);expect(tail.inventory).toEqual(first.inventory);expect(tail.witness).toEqual(first.witness);
 expect([...first.entries,...tail.entries]).toEqual(retained.entries);
 expect(tail.inventory.provenance!.canonicalEntries[0]!.memberships).toHaveLength(2);
 expect(tail.complete).toBe(false);expect(tail.nextCursor).toBeNull();expect(validateVisibleExport(tail,retained)).toBe(false);
 expect(JSON.stringify(tail)).not.toContain("LATE");
 const fresh=await exportVisible(f.h,f.root.id,context);expect(fresh.inventory.provenance!.evidence.canonicalEntryCount).toBe(2);
 expect(retained.inventory.provenance!.evidence.canonicalEntryCount).toBe(1);
});

test("legacy v1 snapshots validate and page without provenance migration",async()=>{
 const f=await fixture();const legacy=await f.capture();delete legacy.inventory.provenance;delete legacy.witness.provenanceHash;
 legacy.inventory.content=legacy.inventory.content.filter(l=>!l.path.startsWith("/inventory/provenance"));
 legacy.inventory.allowedSourceContent=legacy.inventory.allowedSourceContent.filter(l=>!l.path.startsWith("/inventory/provenance"));
 legacy.witness.inventoryHash=digest(legacy.inventory);
 expect(validateVisibleExport(legacy,legacy)).toBe(true);
 await f.h.commit(async tx=>{(await tx.doc(VisibleExportsDoc,f.root.id)).snapshots.push(legacy);},context);
 const cursor=Buffer.from(JSON.stringify({snapshot:legacy.snapshotId,offset:1})).toString("base64url");
 const tail=await exportVisible(f.h,f.root.id,context,cursor);
 expect(tail.entries).toEqual(legacy.entries.slice(1));expect(tail.inventory.provenance).toBeUndefined();expect(tail.witness).toEqual(legacy.witness);
 expect((await f.h.snapshot(VisibleExportsDoc,f.root.id,context))!.snapshots[0]).toEqual(legacy);
});

test("conflicting repeated source representations fail closed rather than collapse evidence",async()=>{
 const f=await fixture();
 await expect(f.h.commit(tx=>captureVisibleExport(override(tx,{scanEntries:async(...args)=>{
  const page=await tx.scanEntries(...args);return args[0].conversationId===f.views[1]?{...page,items:page.items.map(e=>({...e,data:{secret:"different private source"}}))}:page;
 }}),f.root.id),context)).rejects.toThrow("inconsistent_source_entry");
});

test("empty export has zero canonical events and retains recorded root metadata",async()=>{
 const h=await Harness.open(new MemoryStorage(),{registry:createRegistry(),models:createModels()},context);harnesses.push(h);const root=await h.root(context);
 const receipt=await h.commit(tx=>captureVisibleExport(tx,root.id as ConversationId),context);
 expect(receipt.inventory.provenance!.evidence).toEqual({canonicalEntryCount:0,membershipCount:0,dedupGroupCount:0,duplicateRepresentationCount:0,historicalState:"UNKNOWN"});
 expect(receipt.inventory.allowedLeafDiffs).toEqual([]);expect(validateVisibleExport(receipt,receipt)).toBe(true);
});


test("physical source keeps its recorded external task owner rather than the fork creator",async()=>{
 const registry=createRegistry();registry.install({name:"fixture",tasks:[writer]});
 const h=await Harness.open(new MemoryStorage(),{registry,models:createModels()},context);harnesses.push(h);
 const root=await h.root(context);const external=await h.createConversation({ownership:{kind:"ownerless"}},context);
 const originalOwner=await h.commit(tx=>tx.createTask(writer,false,{conversationId:external.id,ownership:{kind:"conversation"}}),context);
 const forkOwner=await h.commit(tx=>tx.createTask(writer,false,{conversationId:root.id,ownership:{kind:"conversation"}}),context);
 const source=await h.createConversation({ownership:{kind:"task",taskId:originalOwner}},context);
 const entry=await h.commit(tx=>tx.appendEntry(source.id,{kind:"pi.user",model:[{role:"user",content:"ORIGINAL",timestamp:1}]}),context);
 const fork=await h.commit(tx=>tx.forkConversation(source.id,entry.id,{ownership:{kind:"task",taskId:forkOwner}}),context);
 const receipt=await h.commit(tx=>captureVisibleExport(tx,root.id),context);const p=receipt.inventory.provenance!;
 expect(receipt.inventory.conversationIds).toEqual([root.id,fork.id]);
 expect(p.conversations.find(c=>c.conversationId===source.id)!.owner).toEqual({conversationId:external.id,taskId:originalOwner});
 expect(p.conversations.find(c=>c.conversationId===fork.id)!.owner).toEqual({conversationId:root.id,taskId:forkOwner});
 expect(p.canonicalEntries[0]).toMatchObject({sourceConversationId:source.id,byTaskId:"UNKNOWN"});
 expect(p.evidence.canonicalEntryCount).toBe(1);
});

test("source scan pagination retains every body and absolute membership across 128-row boundary",async()=>{
 const f=await fixture();const ids:EntryId[]=[];
 await f.h.commit(async tx=>{for(let i=0;i<130;i++)ids.push((await tx.appendEntry(f.views[0]!,{kind:"pi.user",model:[{role:"user",content:"PAGE_BODY_"+i,timestamp:i+2}]})).id);},context);
 const receipt=await f.capture();const p=receipt.inventory.provenance!;
 expect(p.evidence).toMatchObject({canonicalEntryCount:131,membershipCount:132,dedupGroupCount:1,duplicateRepresentationCount:1});
 expect(receipt.inventory.entryIds.toSorted((a,b)=>a-b)).toEqual([f.entryId,...ids].toSorted((a,b)=>a-b));
 for(const group of p.canonicalEntries)for(const edge of group.memberships)expect(receipt.entries[edge.entryIndex]).toMatchObject({id:group.entryId,conversationId:edge.viewConversationId});
 for(let i=0;i<130;i++)expect(JSON.stringify(receipt.entries)).toContain('"PAGE_BODY_'+i+'"');
 expect(receipt.inventory.allowedLeafDiffs).toEqual([]);expect(validateVisibleExport(receipt,receipt)).toBe(true);
});
