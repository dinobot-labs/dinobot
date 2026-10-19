import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { defineDoc, defineExtension, defineTask, GenerationTask, hook, type ConversationId, type Harness, type TaskId, type ToolExecutionApi, type Tx, type DocumentWatch } from "@earendil-works/pi-durable";
import { RunDoc, frontier, summarize } from "../core/dag.ts";
import { activeDag, admitDagTx, closeTerminalDag, HOST_DRIVEN } from "./dag.ts";
import { awaitResolution } from "./ask.ts";
import { AsksDoc } from "../core/ask.ts";

/** Durable scheduler ownership. RunDoc remains the sole owner of semantic node transitions. */
export const DagContinuationDoc = defineDoc<{ tasks: Record<string, TaskId<string>> }>({kind:"dinobot.dag-continuation",version:1,scope:"conversation",history:"latest",fork:"initial",initial:()=>({tasks:{}})});
const digest=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)??"null").digest("hex");
export function dagContinuation(getHarness: () => Harness) {
 const task = defineTask<{runId:string; parent?:TaskId}, {phase:"advance"; epoch:number} | {phase:"wait"; on:TaskId[]; epoch:number; asksKey:string; runKey:string} | {phase:"ask"; id:string; deadlineAt:number}, string>({
  name:"dinobot.dag-continuation",version:1,initial:()=>({phase:"advance",epoch:0}),
  phases:{advance:async(record,runtime,context)=>{
   if(record.input.parent) await runtime.waitForTask(record.input.parent,context);
   const api: ToolExecutionApi = {
    ...runtime, env:await runtime.env(context), callId:record.input.runId,
    output:()=>{}, diagnostic:()=>{}, details:async()=>{},
    commit:async(change,c)=>{let value:Awaited<ReturnType<typeof change>>; await runtime.commit(async tx=>{value=await change(tx); return undefined;},c); return value!;},
    createTask:async(def,input,options,c)=>{let id:TaskId<any>; await runtime.commit(async tx=>{id=await tx.createTask(def,input,{...options,conversationId:runtime.conversationId});return undefined;},c); return id!;},
   };
   HOST_DRIVEN.add(api); // Its dag_step results are not shown to the model (ADR 0096).
   let run=await activeDag(api,context,record.input.runId);
   if(!run || run.owner) { await runtime.commit(()=>({status:"terminal",outcome:{status:"completed",result:"not ordinary"}}),context);return; }
   const step=runtime.registry.tools().find(x=>x.tool.name==="dag_step")!.tool;
   const asksKey=digest(await runtime.snapshot(AsksDoc,runtime.conversationId,context));
   await step.execute({run_id:run.id},api,context);
   run=(await activeDag(api,context,run.id))!;
   if(run.status==="running") {
    const on=Object.values(run.nodes).flatMap(s=>(s.status==="running"||s.status==="waiting")&&s.runnerId?[Number(s.runnerId) as TaskId]:[]);
    if(on.length) { await runtime.commit(()=>({status:"running",checkpoint:{phase:"wait",on,epoch:record.state.checkpoint.epoch,asksKey,runKey:digest(run)}}),context);return; }
    const asks=(await getHarness().snapshot((await import("../core/ask.ts")).AsksDoc,runtime.conversationId,context))?.asks ?? [];
    const ask=asks.find(a=>a.state==="open" && a.run===run!.id);
    if(ask) { await runtime.commit(()=>({status:"running",checkpoint:{phase:"ask",id:ask.id,deadlineAt:ask.deadlineAt}}),context);return; }
    if(frontier(run).length) { await runtime.commit(()=>({status:"running",checkpoint:{phase:"advance",epoch:record.state.checkpoint.epoch+1}}),context);return; }
   }
   // ACK only after advanceDag committed semantic settlement and dispatch binding.
   await runtime.commit(()=>({status:"terminal",outcome:{status:"completed",result:summarize(run!)}}),context);
  }, wait:async(record,runtime,context)=>{
   // A persisted watch phase, not a join: any settled child can ready an independent frontier.
   // Reopening this phase after a crash rechecks durable state before subscribing.
   const graph=await getHarness().watchTaskGraph(context);
   const asks=await runtime.watchDoc(AsksDoc,runtime.conversationId,context);
   const runs=await runtime.watchDoc(RunDoc,runtime.conversationId,context);
   const wake=Promise.withResolvers<void>();
   const initialAsks=record.state.checkpoint.asksKey;
   const initialRun=record.state.checkpoint.runKey;
   const settled=(value:typeof graph.value)=>{if(record.state.checkpoint.on.some(id=>!value.tasks[String(id)])) wake.resolve();};
   const changedAsks=(value:unknown)=>{if(digest(value)!==initialAsks) wake.resolve();};
   const changedRun=(value:DocumentWatch<{runs: import("../core/dag.ts").RunState[]; activeId?:string}>["value"]|undefined)=>{if(digest(value?.runs.find(r=>r.id===record.input.runId))!==initialRun) wake.resolve();};
   const abort=()=>wake.reject(context.abortSignal?.reason??new Error("aborted"));
   let timer:ReturnType<typeof setTimeout>|undefined;
   try {
    context.abortSignal?.addEventListener("abort",abort,{once:true});
    if(context.abortSignal?.aborted) abort();
    graph.start(async value=>{settled(value);});asks?.start(async value=>{changedAsks(value);});runs?.start(async value=>{changedRun(value);});
    settled(graph.value);
    if(runs?.value?.runs.find(r=>r.id===record.input.runId)?.status!=="running") wake.resolve();
    // Snapshot after start closes acquisition/subscription races for document changes.
    changedAsks(await runtime.snapshot(AsksDoc,runtime.conversationId,context));
    changedRun(await runtime.snapshot(RunDoc,runtime.conversationId,context)??null);
    const deadline=asks?.value?.asks.filter(a=>a.state==="open"&&a.run===record.input.runId).reduce((at,a)=>Math.min(at,a.deadlineAt),Infinity);
    if(deadline!==undefined&&Number.isFinite(deadline)) timer=setTimeout(()=>wake.resolve(),Math.max(0,deadline-Date.now()));
    await wake.promise;
   } finally {
    if(timer!==undefined) clearTimeout(timer);
    context.abortSignal?.removeEventListener("abort",abort);
    await graph.stop();await asks?.stop();await runs?.stop();
   }
   await runtime.commit(()=>({status:"running",checkpoint:{phase:"advance",epoch:record.state.checkpoint.epoch+1}}),context);
  }, ask:async(record,runtime,context)=>{
   await awaitResolution({...runtime,commit:async(change,c)=>{let value:Awaited<ReturnType<typeof change>>;await runtime.commit(async tx=>{value=await change(tx);return undefined;},c);return value!;}},runtime.conversationId,record.state.checkpoint.id,record.state.checkpoint.deadlineAt,context);
   await runtime.commit(()=>({status:"running",checkpoint:{phase:"advance",epoch:0}}),context);
  }},
  abort:async(_record,runtime,context)=>{await runtime.commit(()=>({status:"terminal",outcome:{status:"aborted"}}),context);},
 });
 async function enqueue(tx:Tx, conversationId:ConversationId, runId:string, parent?:TaskId) {
  const run=(await tx.doc(RunDoc,conversationId)).runs.find(r=>r.id===runId);
  if(!run || run.owner || run.status!=="running" || !await admitDagTx(tx,conversationId,run)) return;
  const doc=await tx.doc(DagContinuationDoc,conversationId);
  const old=doc.tasks[runId];
  if(old && (await tx.task(old))?.state.status!=="terminal") return;
  doc.tasks[runId]=await tx.createTask(task,{runId,...(parent?{parent}:{})},{conversationId,ownership:{kind:"conversation"},background:true});
 }
 return {
  extension:defineExtension({name:"dag-continuation",tasks:[task],hooks:[hook(GenerationTask,{onYield:async(_answer,api,context)=>{
   // Every running ordinary run, not only the active one: a run that is still running always has a driver (ADR 0096).
   // One transaction per run: admission reads tables, which a transaction may not do after creating a task.
   const running=((await getHarness().snapshot(RunDoc,api.conversationId,context))?.runs??[]).filter(run=>!run.owner&&run.status==="running").map(run=>run.id);
   for(const runId of running) await getHarness().commit(tx=>enqueue(tx,api.conversationId,runId,api.taskId),context);
   return undefined; // Never reroll a provider while children or authority are pending.
  }})]}),
  recover:async(context:Context)=>{
   const h=getHarness(); let page=await h.commit(tx=>tx.scanConversations({},128),context);
   for (;;) {
    for(const conversation of page.items) { const doc=await h.snapshot(RunDoc,conversation.id,context);for(const run of doc?.runs??[]) { if(!run.owner&&run.status==="running") await h.commit(tx=>enqueue(tx,conversation.id,run.id),context); else if(!run.owner&&(run.status==="cancelled"||run.status==="verified")) await closeTerminalDag({conversationId:conversation.id,commit:h.commit.bind(h),snapshot:h.snapshot.bind(h)},run.id,context); } }
    if(!page.next) break;
    page=await h.commit(tx=>tx.scanConversations({},128,page.next!),context);
   }
  },
 };
}
