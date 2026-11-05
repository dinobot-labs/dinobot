import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context, awaitWithContext, withAbortSignal } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { createRegistry, Harness, LiveDoc, MemoryStorage, type TaskId } from "@earendil-works/pi-durable";

for (const changed of ["owner", "attempt", "none"] as const) {
 test('a streaming producer does not adopt partials after '+changed+' changes', async () => {
  const stream = new AssistantMessageEventStream();
  const entered = Promise.withResolvers<void>();
  const reported = Promise.withResolvers<void>();
  const reports: unknown[] = [];
  const faux = fauxProvider({provider:"faux",models:[{id:"one"}]});
  const models=createModels();
  models.setProvider({...faux.provider,streamSimple(){entered.resolve();return stream;}});
  const harness=await Harness.open(new MemoryStorage(),{
   models,registry:createRegistry(),settings:{compaction:{enabled:false},retry:{enabled:false},progress:{partialIntervalMs:1}},
   onReport(report){reports.push(report.error);reported.resolve();},
  },context);
  const bounded=withAbortSignal(AbortSignal.timeout(3000),context);
  try {
   const conversation=await harness.createConversation({ownership:{kind:"ownerless"},agent:{model:{provider:"faux",modelId:"one"}}},context);
   await conversation.submit({type:"input",content:"stream"},context);
   await awaitWithContext(entered.promise,bounded);
   await harness.commit(async tx=>{
    const live=await tx.doc(LiveDoc,conversation.id);
    if(!live.run||!live.generation)throw new Error("generation not started");
    if(changed==="owner")live.run.taskId=(Number(live.run.taskId)+1000) as TaskId;
    if(changed==="attempt")live.generation.attempt++;
   },context);
   const before=await harness.snapshot(LiveDoc,conversation.id,context);
   const partial=fauxAssistantMessage("late partial");
   const watch=await harness.watchDoc(LiveDoc,conversation.id,context);
   if(!watch)throw new Error("Missing live watch");
   const observed=Promise.withResolvers<void>();
   const watching=watch.start(async call=>{if(call.kind==="value"&&call.value?.generation?.message)observed.resolve();});
   stream.push({type:"text_delta",contentIndex:0,delta:"late partial",partial});
   if(changed==="none")await awaitWithContext(observed.promise,bounded);
   else await awaitWithContext(reported.promise,bounded);
   const after=await harness.snapshot(LiveDoc,conversation.id,context);
   if(changed==="none"){
    expect(JSON.stringify(after?.generation?.message?.content)).toBe(JSON.stringify(partial.content));
    expect(reports).toHaveLength(0);
   }else{
    expect(after).toEqual(before);
    expect(reports).toHaveLength(1);
    expect(String(reports[0])).toContain("Streaming generation ownership changed");
   }
   watch.stop();await watching;
  }finally{
   // Closing aborts the invocation; release the provider iterator as well, then await every scheduler task.
   stream.end(fauxAssistantMessage("finished"));
   await harness.close(context);
  }
 });
}
