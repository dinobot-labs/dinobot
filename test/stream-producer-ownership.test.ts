import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { copyJson } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, LiveDoc, MemoryStorage, type TaskId } from "@earendil-works/pi-durable";
import { assignJson } from "../node_modules/@earendil-works/pi-durable/dist/harness/json.js";

// Execute the actual producer function against real Harness transactions without provider traffic.
const source = readFileSync(new URL("../node_modules/@earendil-works/pi-durable/dist/harness/generation.js", import.meta.url), "utf8");
const functionSource = source.slice(source.indexOf("async function streamResponse("), source.indexOf("/** Classify a terminal provider message"));
const streamResponse = new Function("copyJson", "LiveDoc", "assignJson", "PARTIAL_THROTTLE_MS", `${functionSource}; return streamResponse;`)(copyJson, LiveDoc, assignJson, 1);

for (const changed of ["owner", "attempt", "none"] as const) {
 test(`a streaming producer does not adopt partials after ${changed} changes`, async () => {
  const harness = await Harness.open(new MemoryStorage(), {models:createModels(),registry:createRegistry()},context);
  try {
   const conversation = await harness.createConversation({ownership:{kind:"ownerless"}},context);
   const taskId = 900 as TaskId;
   await harness.commit(async tx => {const live=await tx.doc(LiveDoc,conversation.id); live.run={taskId: changed === "owner" ? 901 as TaskId : taskId,inputs:[]}; live.generation={attempt:changed === "attempt" ? 2 : 1};},context);
   const before = await harness.snapshot(LiveDoc,conversation.id,context);
   const message = fauxAssistantMessage("late partial");
   const reports:unknown[]=[];
   const events = {
    async *[Symbol.asyncIterator]() {yield {type:"text_delta",partial:message}; await new Promise(resolve=>setTimeout(resolve,30));},
    result:async()=>message,
   };
   await streamResponse({taskId,conversationId:conversation.id,signal:new AbortController().signal,models:{streamSimple:()=>events},report:(error:unknown)=>reports.push(error),commit:(change:Parameters<Harness["commit"]>[0])=>harness.commit(change,context)}, {}, [], {}, 1, context);
   const after = await harness.snapshot(LiveDoc,conversation.id,context);
   if (changed === "none") { expect(JSON.stringify(after?.generation?.message?.content)).toBe(JSON.stringify(message.content)); expect(reports).toHaveLength(0); }
   else { expect(after).toEqual(before); expect(reports).toHaveLength(1); }
  } finally {await harness.close(context);}
 });
}
