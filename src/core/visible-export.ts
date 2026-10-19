import { randomUUID } from "node:crypto";
import type { Context, JsonValue } from "@earendil-works/chord";
import { defineDoc, type ConversationId, type Cursor, type Harness, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { digest, canonical } from "./verification-execution.ts";
import { clone } from "./json.ts";
import { parameterContext, permittedSource } from "./visible-source-policy.ts";

export type TextSpan = { start: number; end: number; replacement: string };
export type Omission = { path: string; reason: string; spans?: TextSpan[] };
// Coordinates refer to UTF-16 source characters; never publish omitted bytes/hashes.
function replaceSpans(value: string, spans: TextSpan[]): string {
 let result="", offset=0;
 for(const span of spans) { result+=value.slice(offset,span.start)+span.replacement; offset=span.end; }
 return result+value.slice(offset);
}
function redactText(value: string, path: string, omissions: Omission[]): string {
 const spans: TextSpan[]=[]; const {colons:annotations,defaults}=parameterContext(value);
 for(const eq of defaults){const tail=value.slice(eq+1);const m=/^\s*("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|[^\s,;)]+)/.exec(tail);if(m)spans.push({start:eq+1+m[0].length-m[1]!.length,end:eq+1+m[0].length,replacement:"[credential omitted]"});}
 const collect=(pattern:RegExp,replacement:string,prefix=false)=>{
  for(const match of value.matchAll(pattern)) {
   const start=match.index!+(prefix?match[1]!.length:0); const end=match.index!+match[0].length;
   if(prefix) { const colon=value.indexOf(":",match.index!); if(colon<start&&colon>=match.index!&&annotations.has(colon))continue; }
   if(!spans.some(s=>start<s.end&&end>s.start))spans.push({start,end,replacement});
  }
 };
 // A colon in a public parameter annotation is not a credential assignment.
 // Colon labels require an explicit quoted value or a Bearer credential.
 collect(/(\b(?:api[_-]?key|password|authorization|secret|access[_-]?token)\s*(?:=\s*|:\s*(?=["']|Bearer\s)))(?:"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|Bearer\s+[^\s,;)\]}]+|[^\s,;)\]}]+)/gi,"[credential omitted]",true);
 // Unquoted colon labels are scoped to standalone lines, not code parameters.
 collect(/^([ \t]*(?:api[_-]?key|password|authorization|secret|access[_-]?token)[ \t]*:[ \t]*)(?!(?:str|string|int|number|bool|boolean|bytes|None|unknown|any)\b)([^\s,;)\]}]+)/gim,"[credential omitted]",true);
 collect(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,"[contact omitted]");
 collect(/\b(?:sk-[a-zA-Z0-9_-]{16,}|gh[pousr]_[a-zA-Z0-9]{20,})\b/g,"[credential omitted]");
 spans.sort((a,b)=>a.start-b.start);
 if(spans.length)omissions.push({path,reason:"contact or credential spans in visible text",spans});
 return replaceSpans(value,spans);
}
/** Additive evidence for retained source events, not a reconstruction of past model input.
 * entryIndex always addresses the FULL frozen legacy entries array, even on cursor pages.
 * Canonical entries reference bodies there; memberships are not additional source events.
 */
export type VisibleExportProvenance = {
 version: 1;
 canonicalEntries: {
  entryId: number;
  sourceConversationId: number;
  byTaskId: number | "UNKNOWN";
  entryIndex: number;
  memberships: { viewConversationId: number; entryIndex: number }[];
 }[];
 conversations: {
  conversationId: number;
  recordState: "RECORDED" | "UNKNOWN";
  // null means a retained record has no edge; UNKNOWN means the record is unavailable.
  owner: { conversationId: number; taskId: number } | null | "UNKNOWN";
  parent: { conversationId: number; at: number } | null | "UNKNOWN";
 }[];
 evidence: {
  canonicalEntryCount: number;
  membershipCount: number;
  dedupGroupCount: number;
  duplicateRepresentationCount: number;
  historicalState: "UNKNOWN";
 };
};
export type VisibleExport = { version: 1; snapshotId: string; root: number; goalBinding?: {epoch:number;hash:string}; complete: boolean; entries: JsonValue[]; inventory: { conversationIds: number[]; entryIds: number[]; content: { path: string; hash: string }[]; allowedSourceContent: { path: string; hash: string }[]; omissions: Omission[]; allowedLeafDiffs: string[]; provenance?: VisibleExportProvenance }; witness: { capturedAt: number; highwater: number; contentHash: string; inventoryHash: string; provenanceHash?: string; provenance: string; historicalState: "UNKNOWN" }; nextCursor: string | null };
export const VisibleExportsDoc = defineDoc<{ snapshots: VisibleExport[] }>({ kind: "dinobot.visible-exports", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ snapshots: [] }) });
const VisibleExportCallDoc=defineDoc<{snapshotId?:string;argsHash?:string}>({kind:"dinobot.visible-export-call",version:1,scope:"task",initial:()=>({})});
const privileged = /^(system|systemPrompt|developerPrompt|privilegedPrompt|reasoning|thinking|thinkingSignature|providerSignature|providerOpaque|providerMetadata|encryptedContent|apiKey|accessToken|refreshToken|token|password|secret|authorization|credentials|customerContact|customerContacts|customerEmail|customerPhone|contactEmail|contactPhone|contacts)$/i;
/** No blanket @ regex: decorators and diff hunk markers are code. */
export function visibleValue(value: JsonValue, path: string, omissions: Omission[]): JsonValue | undefined {
 if (Array.isArray(value)) return value.map((v,i) => visibleValue(v,path+"/"+i,omissions) ?? null);
 if (value && typeof value === "object") {
  if (value.role === "system" || value.role === "developer" || value.type === "thinking" || value.type === "reasoning" || value.type === "redacted_thinking" || value.type === "opaque" || value.type === "provider_opaque") { omissions.push({path,reason:"privileged prompt or reasoning"}); return undefined; }
  if (value.type === "image" || value.type === "audio" || value.type === "file") { omissions.push({path,reason:"binary payload; descriptor only"}); return { type:value.type, descriptor:true, hash:digest(value), mimeType:typeof value.mimeType === "string"?value.mimeType:"unknown" }; }
  const out: Record<string,JsonValue>={};
  for (const [key,v] of Object.entries(value)) { const p=path+"/"+key.replaceAll("~","~0").replaceAll("/","~1"); if (privileged.test(key.replace(/[-_]/g,""))) { omissions.push({path:p,reason:"privileged or private field"}); continue; } const x=visibleValue(v,p,omissions); if(x!==undefined) out[key]=x; }
  return out;
 }
 if(typeof value === "string") {
  if (/^\s*[\[{]/.test(value)) {
   let parsed:JsonValue|undefined;try { parsed=JSON.parse(value); } catch(error) { if(!(error instanceof SyntaxError))throw error; }
   if(parsed!==undefined){const clean=visibleValue(parsed,path+"/$json",omissions); if(canonical(parsed)!==canonical(clean)) return clean===undefined?undefined:JSON.stringify(clean);}
  }
  return redactText(value,path,omissions);
 }
 return value;
}
function leaves(value: JsonValue, path: string, out: {path:string;hash:string}[]) {
 if(typeof value==="string" && /^\s*[\[{]/.test(value)){
  let parsed:JsonValue|undefined;try{parsed=JSON.parse(value);}catch(error){if(!(error instanceof SyntaxError))throw error;}
  if(parsed!==undefined){leaves(parsed,path+"/$json",out);return;}
 }
 if(value&&typeof value==="object"&&Object.keys(value).length) for(const [k,v] of Object.entries(value)) leaves(v,path+"/"+k.replaceAll("~","~0").replaceAll("/","~1"),out); else out.push({path,hash:digest(value)});
}
export function auditVisibleSource(raw: JsonValue, actual: JsonValue, path: string, omissions: Omission[]) {
 // Omission metadata is diagnostic only and cannot authorize public loss.
 void omissions;
 const allowedSourceContent:{path:string;hash:string}[]=[], allowedActual:{path:string;hash:string}[]=[];
 const expected=permittedSource(raw); if(expected!==undefined)leaves(expected,path,allowedSourceContent);
 leaves(actual,path,allowedActual);
 const a=new Map(allowedActual.map(e=>[e.path,e.hash])), b=new Map(allowedSourceContent.map(e=>[e.path,e.hash]));
 const allowedLeafDiffs=[...allowedSourceContent.filter(e=>a.get(e.path)!==e.hash),...allowedActual.filter(e=>b.get(e.path)!==e.hash)].map(e=>e.path);
 // Leaves alone cannot distinguish array/object shape or serialized-JSON byte loss.
 if(canonical(expected)!==canonical(actual))allowedLeafDiffs.push(path+"/$structure");
 return {allowedSourceContent,allowedLeafDiffs};
}
async function pages<T>(scan:(cursor?:Cursor)=>Promise<{items:readonly T[];next?:Cursor}>):Promise<T[]> { const out:T[]=[];let cursor:Cursor|undefined; do {const p=await scan(cursor);out.push(...p.items);cursor=p.next;}while(cursor);return out; }
export async function captureVisibleExport(tx: Tx, root: ConversationId): Promise<VisibleExport> {
 if(!await tx.conversation(root)) throw new Error("unknown_conversation");
 const conversationIds:number[]=[];const entryIds:number[]=[];const entries:JsonValue[]=[];const omissions:Omission[]=[]; const content:{path:string;hash:string}[]=[];const sourceEntries:JsonValue[]=[];
 const canonicalEntries:VisibleExportProvenance["canonicalEntries"]=[];
 const groups=new Map<string,{index:number;source:JsonValue}>();
 const pending:ConversationId[]=[root]; const seen=new Set<number>();
 while(pending.length) { const id=pending.shift()!;if(seen.has(id))continue;seen.add(id);conversationIds.push(id);
  for(const c of await pages(cursor=>tx.scanConversations({ownerConversationId:id},128,cursor))) pending.push(c.id);
  for(const task of await pages(cursor=>tx.scanTasks({conversationId:id},128,cursor))) for(const c of await pages(cursor=>tx.scanConversations({ownerTaskId:task.id},128,cursor))) pending.push(c.id);
  for(const entry of await pages(cursor=>tx.scanEntries({conversationId:id},128,cursor))) {
   // pi-durable EntryRecord.conversationId is physical identity; the query id is a view.
   // Keep the legacy body/view representation byte-for-byte compatible.
   const entryIndex=entries.length; entryIds.push(entry.id);const path="/entries/"+entryIndex;
   const raw={id:entry.id,conversationId:id,kind:entry.kind,model:entry.model ?? [],...(entry.data===undefined?{}:{data:entry.data})} as unknown as JsonValue;
   const clean=visibleValue(raw,path,omissions)!;sourceEntries.push(raw); entries.push(clean); leaves(clean,path,content);
   const source={...raw as Record<string,JsonValue>,conversationId:entry.conversationId,byTaskId:entry.byTaskId ?? "UNKNOWN"};
   const key=entry.conversationId+":"+entry.id;const group=groups.get(key);
   if(group) {
    // Never silently merge inconsistent source representations, even if redaction masks them.
    if(canonical(group.source)!==canonical(source))throw new Error("inconsistent_source_entry");
    canonicalEntries[group.index]!.memberships.push({viewConversationId:id,entryIndex});
   } else {
    groups.set(key,{index:canonicalEntries.length,source});
    canonicalEntries.push({entryId:entry.id,sourceConversationId:entry.conversationId,byTaskId:entry.byTaskId ?? "UNKNOWN",entryIndex,memberships:[{viewConversationId:id,entryIndex}]});
   }
  }
 }
 // Resolve only recorded structural metadata. Ancestor/owner records are evidence, not
 // additional export views: do not scan their entries or infer ownership from membership.
 const conversations:VisibleExportProvenance["conversations"]=[];
 const metadataIds=[...conversationIds,...canonicalEntries.map(e=>e.sourceConversationId)];const metadataSeen=new Set<number>();
 for(let i=0;i<metadataIds.length;i++) {
  const id=metadataIds[i]!;if(metadataSeen.has(id))continue;metadataSeen.add(id);
  const record=await tx.conversation(id as ConversationId);
  if(!record) {conversations.push({conversationId:id,recordState:"UNKNOWN",owner:"UNKNOWN",parent:"UNKNOWN"});continue;}
  const owner=record.owner?{conversationId:record.owner.conversationId,taskId:record.owner.taskId}:null;
  const parent=record.parent?{conversationId:record.parent.conversationId,at:record.parent.at}:null;
  conversations.push({conversationId:id,recordState:"RECORDED",owner,parent});
  if(owner)metadataIds.push(owner.conversationId);if(parent)metadataIds.push(parent.conversationId);
 }
 const rawProvenance:VisibleExportProvenance={version:1,canonicalEntries,conversations,evidence:{canonicalEntryCount:canonicalEntries.length,membershipCount:entries.length,dedupGroupCount:canonicalEntries.filter(e=>e.memberships.length>1).length,duplicateRepresentationCount:entries.length-canonicalEntries.length,historicalState:"UNKNOWN"}};
 const provenance=visibleValue(rawProvenance,"/inventory/provenance",omissions) as VisibleExportProvenance;
 leaves(provenance,"/inventory/provenance",content);
 const transported=JSON.parse(JSON.stringify(entries)) as JsonValue[];
 const {allowedSourceContent,allowedLeafDiffs}=auditVisibleSource(sourceEntries,transported,"/entries",omissions);
 const metadataAudit=auditVisibleSource(rawProvenance,JSON.parse(JSON.stringify(provenance)),"/inventory/provenance",omissions);
 allowedSourceContent.push(...metadataAudit.allowedSourceContent);allowedLeafDiffs.push(...metadataAudit.allowedLeafDiffs);
 const inventory={conversationIds,entryIds:[...new Set(entryIds)],content,allowedSourceContent,omissions,allowedLeafDiffs,provenance};
 return {version:1,snapshotId:randomUUID(),root,complete:true,entries,inventory,witness:{capturedAt:Date.now(),highwater:entryIds.reduce((max,id)=>Math.max(max,id),0),contentHash:digest(entries),inventoryHash:digest(inventory),provenanceHash:digest(provenance),provenance:"host transaction: currently retained fork-visible entries and recursive storage ownership; recorded source identity and view memberships",historicalState:"UNKNOWN"},nextCursor:null};
}
export function validateVisibleExport(receipt: VisibleExport, retained: VisibleExport): boolean {
 // Legacy version-1 snapshots remain valid without migration. New evidence must be
 // present on both sides, audited with the bodies, and covered by both witnesses.
 const provenance=receipt.inventory.provenance;
 const provenanceValid=provenance===undefined?receipt.witness.provenanceHash===undefined:receipt.witness.provenanceHash===digest(provenance);
 return provenanceValid && receipt.complete === true && retained.complete === true && receipt.inventory.allowedLeafDiffs.length===0 && canonical(receipt) === canonical(retained) && digest(receipt.entries) === receipt.witness.contentHash && digest(receipt.inventory) === receipt.witness.inventoryHash;
}
export async function exportVisible(harness: Harness, root: ConversationId, context: Context, cursor?:string, limit?:number, taskId?:TaskId):Promise<VisibleExport> {
 return harness.commit(async tx=>{
  const doc=await tx.doc(VisibleExportsDoc,root); let receipt:VisibleExport;let offset=0;
  const call=taskId?await tx.doc(VisibleExportCallDoc,taskId):undefined;const argsHash=digest({root,cursor:cursor??null,limit:limit??null});if(call?.argsHash && call.argsHash!==argsHash)throw new Error("export_call_argument_conflict");
  if(!cursor && call?.snapshotId) {receipt=doc.snapshots.find(s=>s.snapshotId===call.snapshotId)!;if(!receipt)throw new Error("missing_host_export_snapshot");}
  else if(cursor) { const parsed=JSON.parse(Buffer.from(cursor,"base64url").toString()) as {snapshot:string;offset:number}; receipt=doc.snapshots.find(s=>s.snapshotId===parsed.snapshot)!;offset=parsed.offset;if(!receipt||!Number.isSafeInteger(offset)||offset<0||offset>receipt.entries.length)throw new Error("invalid_export_cursor"); }
  else { receipt=await captureVisibleExport(tx,root); const {WorkDoc,syncGoalHeadTx}=await import("./verification.ts");const state=await tx.doc(WorkDoc,root);await syncGoalHeadTx(tx,root,state);const goal=state.goal;if(goal)receipt.goalBinding={epoch:goal.epoch,hash:goal.hash};doc.snapshots.push(receipt); }
  if(call){call.argsHash=argsHash;call.snapshotId=receipt.snapshotId;}
  if(limit===undefined && !cursor) return clone(receipt);
  limit ??= Math.max(1,receipt.entries.length-offset);
  if(!Number.isSafeInteger(limit)||limit<1||(limit>10000 && !cursor))throw new Error("invalid_export_limit");
  const end=Math.min(offset+limit,receipt.entries.length); return {...clone(receipt),complete:offset===0&&end===receipt.entries.length,entries:clone(receipt.entries.slice(offset,end)),nextCursor:end<receipt.entries.length?Buffer.from(JSON.stringify({snapshot:receipt.snapshotId,offset:end})).toString("base64url"):null};
 },context);
}
