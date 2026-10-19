import type { Context } from "@earendil-works/chord";
import type { ConversationId, Cursor, Harness, ToolExecutionApi, Tx } from "@earendil-works/pi-durable";
import { type AskRecord, AsksDoc } from "./ask.ts";
import { askNodeKeys, RunDoc, type RunState, type NodeRun } from "./dag.ts";
import { assertGoalAdmissionTx, WorkDoc, syncGoalHeadTx } from "./verification.ts";
import { digest } from "./verification-execution.ts";
import { clone } from "./json.ts";
import type { PluginTool, PluginToolCall } from "../plugins/types.ts";
import { OwnerClaimsDoc } from "./claim-cleanup.ts";
import { ClaimsDoc } from "./claims.ts";
import { isApproval } from "../extensions/dag.ts";

/** Host-only protocol. One lifetime slot per irreversible node, not per tool call or retry. */
export type ManagedEffect = {
 id:string; tool:string; inputHash:string; runId:string; nodeId:string; key:string; attempt:number;
 goal:NonNullable<RunState["goalBinding"]>; authority:string[]; phase:"intent"|"unknown"|"receipt";
 receipt?:string; error?:string;
};
async function admitted(tx:Tx, child:ConversationId) {
 await assertGoalAdmissionTx(tx,child);
 const binding=(await tx.doc(WorkDoc,child)).dagParent;
 if(!binding) throw Error("managed_effect_requires_native_dag_child");
 const parent=Number(binding.conversationId) as ConversationId;
 const run=(await tx.doc(RunDoc,parent)).runs.find(r=>r.id===binding.runId);
 const node=run?.nodes[binding.nodeId];
 if(!run || run.owner || !node || !run.plan.nodes.find(n=>n.id===binding.nodeId)?.irreversible || !node.key || node.binding?.key!==node.key) throw Error("managed_effect_requires_current_irreversible_node");
 const source=Number(run.goalBinding?.conversationId ?? parent) as ConversationId;
 const state=await tx.doc(WorkDoc,source);await syncGoalHeadTx(tx,source,state);
 if(!run.goalBinding || state.goal?.epoch!==run.goalBinding.epoch || state.goal.hash!==run.goalBinding.hash) throw Error("stale_goal_admission_epoch");
 const ancestors=new Set<string>();const visit=(id:string)=>{for(const p of run.compiled?.parents[id]??[]){if(!ancestors.has(p)){ancestors.add(p);visit(p);}}};visit(binding.nodeId);
 const asks=await tx.doc(AsksDoc,parent);const authority:string[]=[];
 for(const id of ancestors){const gate:NodeRun|undefined=run.nodes[id];if(!gate?.ask?.refs.includes(binding.nodeId))continue;
  const record:AskRecord|undefined=asks.asks.find(a=>a.id===gate.ask!.id);const index=record?.refs.indexOf(binding.nodeId) ?? -1;
  if(gate.status!=="succeeded" || !record || record.to!=="human" || record.kind!=="authority" || record.state!=="answered" || record.late || !record.resolvedBy?.startsWith("human:") || !isApproval(record.answer) || record.run!==run.id || record.node!==id || record.nodeKey!==gate.key || index<0 || record.keys?.[index]!==askNodeKeys(run,[binding.nodeId])[0] || JSON.stringify(record.goalBinding)!==JSON.stringify(run.goalBinding)) throw Error("managed_effect_authority_not_current");
  authority.push(record.id);
 }
 if(!authority.length) throw Error("managed_effect_missing_human_authority");
 return {run,node,binding,parent,authority};
}
async function acceptReceipt(tx:Tx,parent:ConversationId,effect:ManagedEffect,receipt:string) {
 if(!receipt)throw Error("managed_effect_empty_receipt");
 const run=(await tx.doc(RunDoc,parent)).runs.find(r=>r.id===effect.runId);const node=run?.nodes[effect.nodeId];
 if(node?.effect?.id!==effect.id)throw Error("managed_effect_receipt_binding_mismatch");
 if(node.effect.receipt && node.effect.receipt!==receipt)throw Error("managed_effect_receipt_conflict");
 node.effect.phase="receipt";node.effect.receipt=receipt;delete node.effect.error;
 // Reconciliation only resolves uncertainty; it never succeeds a node, revives a run or grants new authority.
 if (run?.status === "running" && (node.status === "running" || node.status === "waiting") && node.key === effect.key && node.attempt === effect.attempt) delete node.unknownEffects;
}
export async function executeManagedEffect(tool:PluginTool,args:unknown,call:PluginToolCall,api:ToolExecutionApi,context:Context):Promise<unknown> {
 const admission=await api.commit(async tx=>{
  context.abortSignal?.throwIfAborted();const current=await admitted(tx,api.conversationId);
  const {run,node,binding,parent,authority}=current;const inputHash=digest(args);
  if(node.effect){if(node.effect.tool!==tool.name || node.effect.inputHash!==inputHash || node.effect.key!==node.key || node.effect.attempt!==node.attempt || JSON.stringify(node.effect.goal)!==JSON.stringify(run.goalBinding) || JSON.stringify(node.effect.authority)!==JSON.stringify(authority))throw Error("managed_effect_lifetime_slot_consumed");return {parent,effect:clone(node.effect),fresh:false};}
  const effect:ManagedEffect={id:digest({parent,run:run.id,node:binding.nodeId,key:node.key,attempt:node.attempt,goal:run.goalBinding,authority,tool:tool.name,inputHash}),tool:tool.name,inputHash,runId:run.id,nodeId:binding.nodeId,key:node.key!,attempt:node.attempt,goal:clone(run.goalBinding!),authority,phase:"intent"};
  node.effect=effect;node.unknownEffects=true;
  const owned=await tx.doc(OwnerClaimsDoc,api.conversationId);const leases=await tx.doc(ClaimsDoc);
  for(const token of owned.claims){const lease=leases.claims.find(c=>c.key===token.claim.key && c.holder===token.claim.holder && c.token===token.claim.token);if(lease)lease.quarantined="UNKNOWN managed effect intent";}
  return {parent,effect:clone(effect),fresh:true};
 },context).catch(async error => {
  if(String(error).includes("managed_effect_")) await api.commit(async tx=>{
   const binding=(await tx.doc(WorkDoc,api.conversationId)).dagParent; if(!binding)return;
   const run=(await tx.doc(RunDoc,Number(binding.conversationId) as ConversationId)).runs.find(r=>r.id===binding.runId);
   const node=run?.nodes[binding.nodeId];
   if(run?.status==="running" && node?.runnerId===binding.runnerId && node.attempt===binding.attempt)node.effectRefusal=String(error);
  },context);
  throw error;
 });
 if(admission.effect.receipt)return {receipt:admission.effect.receipt,effectId:admission.effect.id,deduplicated:true};
 if(!admission.fresh){
  const known=await tool.oneUse?.reconcile?.(admission.effect.id,call);
  if(!known)throw Error("managed_effect_unknown_ACK_no_replay");
  await api.commit(tx=>acceptReceipt(tx,admission.parent,admission.effect,known.receipt),context);
  return {...known,effectId:admission.effect.id,reconciled:true};
 }
 try {
  // Intent is committed before the only permitted call. Cancellation after intent cannot authorize a retry.
  context.abortSignal?.throwIfAborted();
  await api.commit(tx=>admitted(tx,api.conversationId).then(()=>undefined),context);
  const value=await tool.execute(args,{...call,effectId:admission.effect.id});
  const receipt=(value as {receipt?:unknown}|null)?.receipt;
  if(typeof receipt!=="string" || !receipt)throw Error("managed_effect_missing_definitive_receipt");
  await api.commit(tx=>acceptReceipt(tx,admission.parent,admission.effect,receipt),context);
  return value;
 }catch(error){
  // Intent alone is enough to quarantine after interrupted commits. Never convert missing ACK into a retry grant.
  await api.commit(async tx=>{const node=(await tx.doc(RunDoc,admission.parent)).runs.find(r=>r.id===admission.effect.runId)?.nodes[admission.effect.nodeId];if(node?.effect?.id===admission.effect.id && node.effect.phase!=="receipt"){node.effect.phase="unknown";node.effect.error=String(error);}},context);
  throw error;
 }
}
/** Startup/read-only provider lookup of committed intents, never provider execution. */
export async function reconcileManagedEffects(harness:Harness,tools:readonly PluginTool[],context:Context):Promise<void> {
 let cursor:Cursor|undefined;do {const page=await harness.commit(tx=>tx.scanConversations({},128,cursor),context);
 for(const conversation of page.items){const runs=(await harness.snapshot(RunDoc,conversation.id,context))?.runs??[];for(const run of runs)for(const node of Object.values(run.nodes)){const effect=node.effect;if(!effect || effect.phase==="receipt")continue;const tool=tools.find(t=>t.name===effect.tool && t.oneUse);if(!tool?.oneUse?.reconcile)continue;
  try{const known=await tool.oneUse.reconcile(effect.id,{});if(known)await harness.commit(tx=>acceptReceipt(tx,conversation.id,effect,known.receipt),context);}catch{ /* Unknown remains durable, no release or effect retry. */ }
 }}cursor=page.next;}while(cursor);
}
