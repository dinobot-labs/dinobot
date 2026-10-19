import { afterEach, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openBot, type Bot } from "../src/core/bot.ts";
import { validHumanAcceptance } from "../src/core/verification.ts";
const bots:Bot[]=[];afterEach(async()=>{for(const b of bots.splice(0))await b.close(context);});
test("T07 authentic human acceptance binds full inputs; later context revokes overall certification without silently amending purpose",async()=>{
 const models=createModels();const faux=fauxProvider({provider:"faux",models:[{id:"m"}]});models.setProvider(faux.provider);faux.setResponses(Array.from({length:10},()=>fauxAssistantMessage("candidate")));
 const bot=await openBot({storage:new MemoryStorage(),models,defaultModel:{provider:"faux",modelId:"m"},plugins:[],toolMode:"direct",settings:{retry:{enabled:false}}},context);bots.push(bot);const root=await bot.conversation("test","acceptance",context);const send=async(content:string)=>await(await root.submit({type:"input",content},context)).wait(context);
 await send("Full immutable human assertion including ALL scope");const original=(await bot.work.snapshot(root.id,context)).goal!;expect(validHumanAcceptance(await bot.work.snapshot(root.id,context))).toBe(false);
 await send(JSON.stringify({dinobotGoalAcceptance:{epoch:original.epoch,hash:original.hash}}));expect(validHumanAcceptance(await bot.work.snapshot(root.id,context))).toBe(true);
 await send("Additional scope must not be ignored");const state=await bot.work.snapshot(root.id,context);expect(state.goal!.sources).toEqual(original.sources);expect(state.goal!.epoch).toBe(original.epoch);expect(state.humanInputs).toHaveLength(3);expect(validHumanAcceptance(state)).toBe(false);
 await root.reset("host handoff",context);await bot.work.reconcileSources(root.id,[],context);expect(validHumanAcceptance(await bot.work.snapshot(root.id,context))).toBe(false);
});
