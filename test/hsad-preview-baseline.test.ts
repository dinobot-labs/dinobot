import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openBot } from "../src/core/bot.ts";
test("T06 current mechanism: session_read is clipped recent preview, full store remains pageable", async () => {
 const faux=fauxProvider({provider:"faux",models:[{id:"m"}]});
 const router: FauxResponseFactory=t=>{
  const user=t.messages.findLast(m=>m.role==="user");
  const content=String(user?.content);
  if(content === "preview") {
   const results=t.messages.slice(t.messages.findLastIndex(m=>m.role==="user")+1).filter(m=>m.role==="toolResult");
   return results.length ? fauxAssistantMessage("preview only") : fauxAssistantMessage(fauxToolCall("session_read",{thread:"test:archive",limit:100}),{stopReason:"toolUse"});
  }
  return fauxAssistantMessage(content);
 };
 faux.setResponses(Array.from({length:110},()=>router));const models=createModels();models.setProvider(faux.provider);
 const bot=await openBot({storage:new MemoryStorage(),models,defaultModel:{provider:"faux",modelId:"m"},plugins:[],toolMode:"direct",settings:{retry:{enabled:false}}},context);
 try {
  const source=await bot.conversation("test","archive",context);
  for(let i=0;i<101;i++) await (await source.submit({type:"input",content:i===0 ? "OLDEST_SOURCE_MARKER" : i===100 ? "LONG_BODY_"+"가".repeat(1700)+"_UNCLIPPED_TAIL" : "source-body-"+i},context)).wait(context);
  const full=(await source.entries({},1000,undefined,context)).items;
  expect(full.length).toBeGreaterThan(100);
  expect(JSON.stringify(full)).toContain("OLDEST_SOURCE_MARKER");expect(JSON.stringify(full)).toContain("_UNCLIPPED_TAIL");
  const reader=await bot.conversation("test","reader",context);
  await (await reader.submit({type:"input",content:"preview"},context)).wait(context);
  const messages=(await reader.context(context)).messages;
  const result=messages.findLast(m=>m.role==="toolResult" && m.toolName==="session_read");
  const text=JSON.stringify(result);
  expect(result).toBeDefined();expect(text).toContain("Recent preview only");expect(text).not.toContain("OLDEST_SOURCE_MARKER");expect(text).not.toContain("_UNCLIPPED_TAIL");expect(text).toContain("...");
  console.log("T06 population",full.length,"stored entries; preview lacks oldest source and full body tail");
 } finally {await bot.close(context);}
},15000);
