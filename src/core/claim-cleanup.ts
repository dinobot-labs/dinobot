import { defineDoc, type ConversationId, type Cursor, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { ClaimsDoc, NATIVE_QUARANTINE_REASONS, unfence, type Claim } from "./claims.ts";
import { WorkDoc, WorkspaceCoordDoc } from "./verification.ts";
import { type NodeRun } from "./dag.ts";
import { claimHolderTx } from "./threads.ts";
import type { Context } from "@earendil-works/chord";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { isNativeProcessEvent } from "@earendil-works/pi-durable/env/node";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { NativeProcessEvent } from "@earendil-works/pi-durable/env";
/** Uncontained process/adapter calls are unknown even after a successful tool result.
 * This journal uses native task identity and the existing workspace leases, not a process supervisor.
 * No PID, terminal task, elapsed TTL or missing lease is a reconciliation receipt. `reconciled` is an operator
 * receipt backed by OS quiescence evidence (claim-reconcile.ts); it never rewrites the recorded process events. */
export type NativeReconciliation = { at: number; actor: string; note: string; evidence: { nonce: string; evidence: string }[] };
export type NativeAbandonment = { at: number; actor: string; note: string; snapshot: string; acceptance: string; waived: string[] };
export type NativeCall = { taskId: string; kind: string; tokens: Claim[]; acquiredTokens?: Claim[]; processes?: { [K in keyof NativeProcessEvent]: NativeProcessEvent[K] }[]; phase: "unknown" | "settled" | "reconciled" | "abandoned"; reconciled?: NativeReconciliation; abandoned?: NativeAbandonment };
export const NativeProvenanceDoc = defineDoc<{ calls: NativeCall[] }>({ kind: "dinobot.native-provenance", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ calls: [] }) });
type NativeProcessApi = Pick<ToolExecutionApi, "taskId" | "conversationId" | "env" | "commit">;
export async function admitUnknownNativeCall(api: NativeProcessApi, context: Context, kind: string): Promise<void> {
 await api.commit(async tx => {
  const doc = await tx.doc(NativeProvenanceDoc, api.conversationId);
  const taskId = String(api.taskId);
  if (doc.calls.some(c => c.taskId === taskId && c.kind === kind)) return;
  const holder = await claimHolderTx(tx, api.conversationId);
  const claims = await tx.doc(ClaimsDoc);
  const tokens = claims.claims.filter(c => c.holder === holder).map(c => ({ ...c }));
  doc.calls.push({ taskId, kind, tokens, acquiredTokens: tokens.map(t => ({ ...t })), phase: "unknown" });
  // The first quarantine cause wins: a native call must not relabel, say, an unresolved managed effect as merely native.
  for (const claim of claims.claims) if (!claim.quarantined && tokens.some(t => t.key === claim.key && t.holder === claim.holder && t.token === claim.token)) claim.quarantined = "UNKNOWN native " + kind + " provenance";
  const coord = await tx.doc(WorkspaceCoordDoc);
  coord.leases.push({ id: "native:" + taskId + ":" + kind, root: api.env?.cwd ?? "UNKNOWN", environment: api.env?.id ?? "UNKNOWN", conversationId: String(api.conversationId), workId: "", taskId, reason: "native " + kind + " provenance", phase: "blocked-unknown" });
 }, context);
}
/**
 * End the fence of one in-process plugin call (`external:<tool>`) once its promise settled (returned or threw).
 * The host awaited the call, so the call itself is over; that is the same host-observed boundary a native process
 * settlement is, not a claim about work a remote service may continue on its own (ADR 0094). A daemon crash before this
 * commit leaves the call UNKNOWN, so a crash mid-call still fences. Idempotent: only an UNKNOWN call is settled.
 */
export async function settleExternalCall(api: NativeProcessApi, kind: string): Promise<void> {
 await api.commit(async tx => {
  const doc = await tx.doc(NativeProvenanceDoc, api.conversationId);
  const call = doc.calls.find(c => c.taskId === String(api.taskId) && c.kind === kind);
  if (!call || call.phase !== "unknown") return;
  call.phase = "settled";
  const holder = await claimHolderTx(tx, api.conversationId);
  await unfenceSettledTx(tx, [...call.tokens, ...(call.acquiredTokens ?? [])].filter(t => t.holder === holder), Date.now(), { conversationId: api.conversationId, taskId: call.taskId, kind: call.kind });
  const coord = await tx.doc(WorkspaceCoordDoc);
  coord.leases = coord.leases.filter(l => l.id !== "native:" + api.taskId + ":" + kind);
 }, BACKGROUND_CONTEXT);
}
/** Native Env observer, shared by direct and codemode Bash through WorkService. Not a second supervisor. */
export function nativeProcessApi<T extends NativeProcessApi>(api: T): T {
 if (!api.env) return api;
 const env = new Proxy(api.env, { get(target, property) {
  if (property === "exec") return async (...args: Parameters<typeof target.exec>) => {
   const [command, options, context] = args;
   return target.exec(command, { ...options, onProcess: async event => {
    await recordNativeProcessEvent(api, event);
    await options?.onProcess?.(event);
   } }, context);
  };
  const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
 } });
 return { ...api, env };
}
async function recordNativeProcessEvent(api: NativeProcessApi, event: unknown): Promise<void> {
 if (!isNativeProcessEvent(event)) throw Error("forged_native_process_receipt");
 await api.commit(async tx => {
  const doc = await tx.doc(NativeProvenanceDoc, api.conversationId);
  const call = doc.calls.find(c => c.taskId === String(api.taskId) && c.kind === "process");
  if (!call) throw Error("native_process_not_admitted");
  if (!call.processes) call.processes = [];
  const events = call.processes;
  if (event.phase !== "admitted" && !events.some(e => e.nonce === event.nonce && e.phase === "admitted")) throw Error("native_nonce_not_admitted");
  if (event.phase === "settled" && event.canonical && !events.some(e => e.nonce === event.nonce && e.phase === "started" && e.pid === event.pid && e.startTime === event.startTime)) throw Error("native_identity_mismatch");
  events.push({ ...event });
  if (event.phase === "admitted") call.phase = "unknown";
  const admissions = events.filter(e => e.phase === "admitted");
  // Only the fixed host process can establish this. Shell/tool success, vanished PID and caller JSON cannot.
  if (event.phase !== "settled" || !event.canonical || !admissions.every(a => events.some(e => e.nonce === a.nonce && e.phase === "settled" && e.canonical))) return;
  call.phase = "settled";
  const holder = await claimHolderTx(tx, api.conversationId);
  // Settlement ends this call's fence, not the holder's lease: the claim stays held until work_release or TTL.
  await unfenceSettledTx(tx, [...call.tokens, ...(call.acquiredTokens ?? [])].filter(t => t.holder === holder), Date.now(), { conversationId: api.conversationId, taskId: call.taskId, kind: call.kind });
  const coord = await tx.doc(WorkspaceCoordDoc);
  coord.leases = coord.leases.filter(l => l.id !== "native:" + api.taskId + ":process");
 }, BACKGROUND_CONTEXT);
}
const sameToken = (a: Pick<Claim, "key" | "holder" | "token">, b: Pick<Claim, "key" | "holder" | "token">) => a.key === b.key && a.holder === b.holder && a.token === b.token;
/**
 * Clear the native fence of each candidate token whose every recorded native call is resolved. A token stays fenced when
 * any UNKNOWN call (in any conversation, except the call being settled now) still references it, when its current cause
 * is not native, or when any recorded snapshot shows an earlier non-native cause. Parallel calls of one holder therefore
 * end the fence exactly when the last of them settles, whichever order they admit or settle in.
 */
export async function unfenceSettledTx(tx: Tx, candidates: readonly Claim[], now: number, settling?: { conversationId: ConversationId; taskId: string; kind: string }): Promise<void> {
 const unresolved: Claim[] = []; const snapshots: Claim[] = [];
 let cursor: Cursor | undefined;
 do { const page = await tx.scanConversations({}, 128, cursor);
  for (const conversation of page.items) for (const prior of (await tx.doc(NativeProvenanceDoc, conversation.id)).calls) {
   snapshots.push(...prior.tokens, ...(prior.acquiredTokens ?? []));
   const self = settling !== undefined && conversation.id === settling.conversationId && prior.taskId === settling.taskId && prior.kind === settling.kind;
   if (prior.phase === "unknown" && !self) unresolved.push(...prior.tokens);
  }
  cursor = page.next;
 } while (cursor);
 const claims = await tx.doc(ClaimsDoc);
 // The settling call's own cause ("UNKNOWN native <kind> provenance") is clearable too; for a process it is already native.
 const clearable = settling ? [...NATIVE_QUARANTINE_REASONS, "UNKNOWN native " + settling.kind + " provenance"] : NATIVE_QUARANTINE_REASONS;
 for (const token of candidates) {
  if (unresolved.some(t => sameToken(t, token))) continue;
  const current = claims.claims.find(c => sameToken(c, token));
  if (!current || current.quarantined === undefined || !clearable.includes(current.quarantined)) continue;
  if (snapshots.some(s => sameToken(s, token) && s.quarantined !== undefined && !clearable.includes(s.quarantined))) continue;
  unfence(claims, token, now);
 }
}
/** Acquisition provenance, not a snapshot of whichever lease happens to exist at cleanup time. */
export const OwnerClaimsDoc=defineDoc<{claims:{claim:Claim; runId:string; nodeId:string; runnerId:string; attempt:number}[]; cleanup?:string}>({kind:"dinobot.owner-claims",version:1,scope:"conversation",history:"latest",fork:"initial",initial:()=>({claims:[]})});
export async function trackOwnerClaimsTx(tx:Tx,id:ConversationId,claims:readonly Claim[]) {
 const binding=(await tx.doc(WorkDoc,id)).dagParent;
 const provenance=await tx.doc(NativeProvenanceDoc,id);
 if(!binding && !provenance.calls?.length)return; // ordinary acquisition without effects needs no DAG owner binding
 const holder=await claimHolderTx(tx,id);if(claims.some(c=>c.holder!==holder))throw Error("claim_owner_identity_unknown");
 if(provenance.calls.some(c=>c.phase==="unknown")){
  const state=await tx.doc(ClaimsDoc);
  for(const claim of state.claims)if(claim.holder===holder && claims.some(c=>c.token===claim.token)){
   if(!claim.quarantined)claim.quarantined="UNKNOWN prior native provenance";
   for(const call of provenance.calls)if(!call.tokens.some(t=>t.token===claim.token))call.tokens.push({...claim});
  }
 }
 if(!binding)return;
 const doc=await tx.doc(OwnerClaimsDoc,id);
 for(const claim of claims)if(!doc.claims.some(c=>c.claim.token===claim.token))doc.claims.push({claim:{...claim},runId:binding.runId,nodeId:binding.nodeId,runnerId:binding.runnerId,attempt:binding.attempt});
}
/** Terminal task state alone cannot establish external-process quiescence. Durable unknown effects/leases win.
 * Reconcile supplies its exact CAS scope; DAG lifecycle cleanup may consider every owned acquisition. */
export async function cleanupOwnerClaimsTx(tx:Tx,id:ConversationId,runId:string,nodeId:string,node:NodeRun,candidates?:readonly Pick<Claim,"key"|"holder"|"token">[]):Promise<void> {
 const doc=await tx.doc(OwnerClaimsDoc,id);if(!doc.claims.length){doc.cleanup="UNKNOWN no acquisition provenance; no lease removed";return;}
 // Replan can reset the scheduling attempt to zero without replacing the admitted execution.
 // Only its retained binding can authorize that old acquisition; never borrow a replacement runner.
 // Legacy unchanged attempts retain their existing authority; a reset without a binding fails closed.
 const execution=node.binding ?? node;
 const parent=(await tx.doc(WorkDoc,id)).dagParent;
 if(!parent || parent.runId!==runId || parent.nodeId!==nodeId || parent.runnerId!==node.runnerId || execution.runnerId!==node.runnerId || parent.attempt!==execution.attempt){doc.cleanup="UNKNOWN owner binding";return;}
 const owned=doc.claims.filter(c=>c.runId===runId && c.nodeId===nodeId && c.runnerId===execution.runnerId && c.attempt===execution.attempt && (!candidates || candidates.some(t=>sameToken(t,c.claim))));
 if(!owned.length){doc.cleanup="UNKNOWN owner binding";return;}
 const holder=await claimHolderTx(tx,id);
 if(owned.some(c=>c.claim.holder!==holder)){doc.cleanup="UNKNOWN canonical owner";return;}
 let reason=node.unknownEffects || node.effect && node.effect.phase!=="receipt" ? "UNKNOWN effects" : "";
 const runner=node.runnerId ? await tx.task(Number(node.runnerId) as TaskId) : undefined;
 if(!runner || runner.state.status!=="terminal")reason="UNKNOWN owner runner quiescence";
 const pending=[id];const seen=new Set<ConversationId>();
 while(pending.length){const child=pending.pop()!;if(seen.has(child))continue;seen.add(child);if((await tx.doc(NativeProvenanceDoc,child)).calls.some(c=>c.phase==="unknown"))reason="UNKNOWN native process/effect provenance";let cursor:Cursor|undefined;
 do{const page=await tx.scanTasks({conversationId:child},128,cursor);for(const task of page.items){if(task.state.status!=="terminal")reason="UNKNOWN tracked task quiescence";
 let children:Cursor|undefined;do{const page=await tx.scanConversations({ownerTaskId:task.id},128,children);for(const c of page.items)pending.push(c.id);children=page.next;}while(children);
 }cursor=page.next;}while(cursor);
 }
 const coordination=await tx.doc(WorkspaceCoordDoc);if(coordination.leases.some(l=>seen.has(Number(l.conversationId) as ConversationId) && l.phase!=="quiescent"))reason="UNKNOWN managed process lease";
 const claims=await tx.doc(ClaimsDoc);
 for(const token of owned){const current=claims.claims.find(c=>c.key===token.claim.key && c.holder===token.claim.holder && c.token===token.claim.token);
 if(!current)continue; // never remove a successor's token, even if the holder name is unchanged
 if(reason)current.quarantined=reason;
 else claims.claims=claims.claims.filter(c=>c!==current);
 }
 doc.cleanup=reason || "released exact owned tokens after tracked quiescence";
}
