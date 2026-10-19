import { afterEach, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { LiveDoc, MemoryStorage } from "@earendil-works/pi-durable";
import { openBot, type Bot } from "../src/core/bot.ts";
import { createRun, DagSeenDoc, RunDoc, runStateKey, type RunStatus } from "../src/core/dag.ts";
import { settleWakes, wakeAware } from "./fixtures/idle-wake.ts";
import { dagAnswerScope, selectAnswerDag } from "../src/core/dag-scope.ts";
import { WorkDoc, validHumanAcceptance } from "../src/core/verification.ts";
import { channelHandler } from "../src/core/channel-handler.ts";
import { createNativeModelHandler } from "../src/core/native-model-commands.ts";
import { forbiddenCommands } from "./fixtures/channel-e2e-child.ts";

test("late reconciliation of a legacy originating input never turns it into later history", async () => {
 const f = await fixture("cancelled", false);
 const sourceId = (await f.bot.harness.snapshot(RunDoc, f.conversation.id, context))!.runs[0]!.sourceIds![0]!;
 await f.bot.harness.commit(async tx => {
  const run = (await tx.doc(RunDoc, f.conversation.id)).runs[0]!;
  delete run.sourceIds;
  const work = await tx.doc(WorkDoc, f.conversation.id);
  delete work.humanInputs; delete work.inputTimes;
  (await tx.doc(LiveDoc, f.conversation.id)).run = { taskId: 1 as any, inputs: [Number(sourceId) as any] };
 }, context);
 await Bun.sleep(5);
 await f.bot.work.reconcileSources(f.conversation.id, [], context);
 await f.bot.harness.commit(async tx => { delete (await tx.doc(LiveDoc, f.conversation.id)).run; }, context);
 const state = await f.bot.work.snapshot(f.conversation.id, context);
 const run = (await f.bot.harness.snapshot(RunDoc, f.conversation.id, context))!.runs[0]!;
 expect(state.humanInputs![0]!.at).toBeGreaterThan(run.updatedAt);
 const reply = await delivered(f);
 expect(reply).toBe(body);
 expect(reply).toContain("Everything completed");
 expect(validHumanAcceptance(state)).toBe(false);
});

test("cached later legacy answer reconstructs display times from persisted host input, not a live run", async () => {
 const f = await fixture("cancelled", true);
 await Bun.sleep(2);
 const message = { ...f.message, messageId: "cached-later", text: "ordinary later question" };
 f.faux.setResponses([fauxAssistantMessage(body)]);
 const first = await f.handler(message); if (first.status !== "answered") throw Error("missing reply");
 expect(first.text).toBe(body);
 await f.bot.harness.commit(async tx => { delete (await tx.doc(WorkDoc, f.conversation.id)).inputTimes; }, context);
 const calls = f.faux.state.callCount;
 const replay = await f.handler(message); if (replay.status !== "answered") throw Error("missing replay");
 expect(replay.text).toBe(body);
 expect(f.faux.state.callCount).toBe(calls);
 expect(validHumanAcceptance(await f.bot.work.snapshot(f.conversation.id, context))).toBe(false);
});

test("display replay rejects foreign and malformed IDs without changing goal or human input authority", async () => {
 const f = await fixture("cancelled", true);
 const foreignMessage = { ...f.message, threadKey: "123456:-100:other:1", messageId: "foreign-input", text: "foreign user input" };
 f.faux.setResponses([fauxAssistantMessage("foreign answer")]);
 await f.handler(foreignMessage);
 const foreign = await f.bot.conversation(foreignMessage.channel, foreignMessage.threadKey, context);
 const foreignSource = (await f.bot.work.snapshot(foreign.id, context)).humanInputs![0]!.sourceId;
 const before = await f.bot.work.snapshot(f.conversation.id, context);
 const ids = [foreignSource, "01", "NaN", "9007199254740992"];
 await f.bot.work.reconcileSources(f.conversation.id, ids, context);
 const after = await f.bot.work.snapshot(f.conversation.id, context);
 for (const id of ids) expect(after.inputTimes?.[id]).toBeUndefined();
 expect(after.goal).toEqual(before.goal);
 expect(after.humanInputs).toEqual(before.humanInputs);
 expect(validHumanAcceptance(after)).toBe(false);
});

test("a current host-bound plan blocked at compilation preserves answer without replacing the historical active ID", async () => {
 const f = await fixture("cancelled", false);
 const before = await f.bot.harness.snapshot(RunDoc, f.conversation.id, context);
 let prompt = "";
 const invalid = { nodes: [{ id: "bad", kind: "verify", covers: ["OTHER"] }], edges: [], goal: { requirements: ["R"] } };
 f.faux.setResponses([fauxAssistantMessage(fauxToolCall("dag_run", { plan: invalid }), { stopReason: "toolUse" }), tr => {
  prompt = tr.messages.filter(m => m.role === "system").map(m => m.role === "system" ? m.sections?.dag_protocol ?? "" : "").at(-1) ?? "";
  return fauxAssistantMessage(body);
 }]);
 const reply = await f.handler({ ...f.message, messageId: "blocked-current", text: "new plan" });
 if (reply.status !== "answered") throw Error("missing blocked reply");
 const after = await f.bot.harness.snapshot(RunDoc, f.conversation.id, context);
 expect(after!.activeId).toBe(before!.activeId);
 expect(after!.runs[0]).toEqual(before!.runs[0]);
 expect(after!.runs.at(-1)!.status).toBe("blocked");
 expect(reply.text).toBe(body);
 expect(reply.text).toContain("Everything completed");
 expect(prompt).toContain(after!.runs.at(-1)!.id);
 expect(prompt).toContain("Current input run (inactive; use explicit run_id):");
 expect(prompt).not.toContain("Active run:");
 expect(validHumanAcceptance(await f.bot.work.snapshot(f.conversation.id, context))).toBe(false);
});

test("selection uses newest exact host match but never bypasses the active research owner or rewrites history", () => {
 const first = createRun("first", plan, 100); first.sourceIds = ["current"];
 const second = createRun("second", plan, 100); second.sourceIds = ["current"];
 const owned = createRun("research", plan, 100); owned.owner = { missionId: "mission" };
 const runs = [first, second, owned];
 const doc = { runs, activeId: first.id };
 expect(selectAnswerDag(doc, ["current"])).toBe(second);
 expect(selectAnswerDag(doc, ["forged"])).toBe(first);
 expect(selectAnswerDag(doc, [])).toBe(first);
 doc.activeId = owned.id;
 const before = JSON.stringify(doc);
 expect(selectAnswerDag(doc, ["current"])).toBe(owned);
 expect(selectAnswerDag({ runs }, ["current"])).toBe(second);
 expect(JSON.stringify(doc)).toBe(before);
});

test("plain cancelled output keeps diagnostics internal and completion unverified", async () => {
 const f = await fixture("cancelled", false);
 await f.bot.harness.commit(async tx => {
  const run = (await tx.doc(RunDoc, f.conversation.id)).runs[0]!;
  run.reason = 'verification rejected: {"version":1,"requirements":[]}';
 }, context);
 const before = await f.bot.harness.snapshot(RunDoc, f.conversation.id, context);
 const reply = await delivered(f);
 expect(reply).toBe(body);
 expect(reply).toContain(body);
 for (const detail of [before!.activeId!, "Φ=", "semantics=", "critical path:", "verification rejected", '"version":', "모델의 주장", "> Everything"]) expect(reply).not.toContain(detail);
 expect(await f.bot.harness.snapshot(RunDoc, f.conversation.id, context)).toEqual(before);
 expect(validHumanAcceptance(await f.bot.work.snapshot(f.conversation.id, context))).toBe(false);
});

for (const status of ["running", "blocked"] as const) test("unrelated scoped " + status + " run does not taint an ordinary answer", async () => {
 const f = await fixture(status, false);
 const before = await f.bot.harness.snapshot(RunDoc, f.conversation.id, context);
 f.faux.setResponses([fauxAssistantMessage(body)]);
 const reply = await f.handler({ ...f.message, messageId: "unrelated", text: "unrelated question" });
 expect(reply.status).toBe("answered");
 if (reply.status === "answered") expect(reply.text).toBe(body);
 expect(await f.bot.harness.snapshot(RunDoc, f.conversation.id, context)).toEqual(before);
});

const bots: Bot[] = [];
afterEach(async () => { for (const bot of bots.splice(0)) await bot.close(context); });
// A real ask frontier keeps the autonomous continuation from consuming the
// next parent response as a verifier response; status projection is under test.
const plan = { nodes: [{ id: "q", kind: "ask" as const }, { id: "v", kind: "verify" as const, covers: ["R"] }], edges: [["q", "v"] as [string, string]], goal: { requirements: ["R"] } };
const body = "Everything completed\n100\nOrdinary answer; no execution receipt claimed by the host.";

for (const legacy of [false, true]) for (const status of ["cancelled", "verified"] as const) for (const timing of ["before", "after"] as const) test(`terminal ${status} joins steering ${timing} terminal in the originating live run (${legacy ? "legacy" : "lineage"}) and cached delivery`, async () => {
 const f = await fixture("running", false);
 const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
 let runId = "";
 f.faux.setResponses([
  fauxAssistantMessage(fauxToolCall("dag_run", { plan }), { stopReason: "toolUse" }),
  async () => {
   await f.bot.harness.commit(async tx => {
    const run = (await tx.doc(RunDoc, f.conversation.id)).runs.at(-1)!;
    runId = run.id;
    if (timing === "after") { run.status = status; run.updatedAt = Date.now(); }
    if (legacy) delete run.sourceIds;
   }, context);
   entered.resolve(); await release.promise;
   if (timing === "before") await f.bot.harness.commit(async tx => {
    const run = (await tx.doc(RunDoc, f.conversation.id)).runs.find(r => r.id === runId)!;
    run.status = status; run.updatedAt = Date.now();
   }, context);
   return fauxAssistantMessage(fauxToolCall("dag_status", { run_id: runId }), { stopReason: "toolUse" });
  }, fauxAssistantMessage(body),
 ]);
 const original = { ...f.message, messageId: "live-origin", text: "start another plan" };
 const flight = f.handler(original);
 await entered.promise;
 await Bun.sleep(5);
 const steering = { ...f.message, messageId: "joined-steer", text: "additional input" };
 const submission = await f.bot.submit(steering, context, "steer");
 release.resolve();
 await flight; await submission.wait(context);
 const reply = await f.handler(steering);
 if (reply.status !== "answered") throw Error("missing joined reply");
 expect(reply.text).toBe(body);
 expect(reply.text).toContain(body.split("\n")[0]!);
 const calls = f.faux.state.callCount;
 await f.bot.harness.commit(async tx => { delete (await tx.doc(WorkDoc, f.conversation.id)).displayInputGroups; }, context);
 const cached = await f.handler(steering);
 expect(cached).toEqual(reply); expect(f.faux.state.callCount).toBe(calls);
 const run = (await f.bot.harness.snapshot(RunDoc, f.conversation.id, context))!.runs.find(r => r.id === runId)!;
 if (legacy) expect(run.sourceIds).toBeUndefined();
 expect(validHumanAcceptance(await f.bot.work.snapshot(f.conversation.id, context))).toBe(false);
});

for (const legacy of [false, true]) test(`successful later replan joins exact host inputs without granting acceptance (${legacy ? "legacy" : "lineage"})`, async () => {
 const f = await fixture("running", false);
 const runId = (await f.bot.harness.snapshot(RunDoc, f.conversation.id, context))!.activeId!;
 await f.bot.harness.commit(async tx => {
  const run = (await tx.doc(RunDoc, f.conversation.id)).runs[0]!;
  for (const node of Object.values(run.nodes)) node.status = "pending";
  if (legacy) delete run.sourceIds;
 }, context);
 f.faux.setResponses([
  fauxAssistantMessage(fauxToolCall("dag_run", { plan, run_id: runId }), { stopReason: "toolUse" }),
  async transcript => {
   expect(JSON.stringify(transcript.messages.filter(m => m.role === "toolResult"))).not.toContain("replan rejected");
   await f.bot.harness.commit(async tx => { (await tx.doc(RunDoc, f.conversation.id)).runs[0]!.status = "cancelled"; }, context);
   return fauxAssistantMessage(body);
  },
 ]);
 const reply = await f.handler({ ...f.message, messageId: "replan-input", text: "extend the plan" });
 if (reply.status !== "answered") throw Error("missing replan reply: " + JSON.stringify(reply));
 expect(reply.text).toBe(body);
 const run = (await f.bot.harness.snapshot(RunDoc, f.conversation.id, context))!.runs[0]!;
 expect(run.revision).toBe(1);
 if (legacy) {
  expect(run.sourceIds).toBeUndefined();
  const origin = await f.handler(f.message);
  if (origin.status !== "answered") throw Error("missing legacy original");
  expect(origin.text).toBe(body);
 }
 expect(validHumanAcceptance(await f.bot.work.snapshot(f.conversation.id, context))).toBe(false);
});

test("rejected later replan does not join terminal history", async () => {
 const f = await fixture("cancelled", false);
 const before = await f.bot.harness.snapshot(RunDoc, f.conversation.id, context);
 f.faux.setResponses([
  fauxAssistantMessage(fauxToolCall("dag_run", { plan, run_id: before!.activeId! }), { stopReason: "toolUse" }),
  fauxAssistantMessage(body),
 ]);
 const reply = await f.handler({ ...f.message, messageId: "rejected-replan", text: "extend the plan" });
 if (reply.status !== "answered") throw Error("missing rejected replan reply");
 expect(reply.text).toBe(body);
 expect(await f.bot.harness.snapshot(RunDoc, f.conversation.id, context)).toEqual(before);
});

async function fixture(status: RunStatus, legacy: boolean) {
 const models = createModels(); const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] }); models.setProvider(faux.provider);
 wakeAware(faux); // ADR 0096: the waiting ask node wakes the idle orchestrator once; that turn is not a scripted reply.
 const bot = await openBot({ storage: new MemoryStorage(), models, plugins: [], toolMode: "direct", defaultModel: { provider: "faux", modelId: "m" }, settings: { retry: { enabled: false } } }, context); bots.push(bot);
 const handler = channelHandler({ commandPolicy: "none" }, bot, forbiddenCommands(), context, createNativeModelHandler(bot, models, context));
 const message = { channel: "telegram", threadKey: "123456:-100:17108:1", messageId: "first", userId: "1", text: "initial submission" };
 faux.setResponses([fauxAssistantMessage(fauxToolCall("dag_run", { plan }), { stopReason: "toolUse" }), fauxAssistantMessage(body)]);
 await handler(message);
 const conversation = await bot.conversation(message.channel, message.threadKey, context);
 // Settle the autonomous ask frontier before taking snapshots or changing fixture status.
 for (let i = 0; i < 200; i++) {
  if ((await bot.harness.snapshot(RunDoc, conversation.id, context))?.runs[0]?.nodes.q?.status === "waiting") break;
  await Bun.sleep(10);
 }
 expect((await bot.harness.snapshot(RunDoc, conversation.id, context))!.runs[0]!.nodes.q!.status).toBe("waiting");
 await settleWakes(bot, conversation.id);
 await bot.harness.commit(async tx => {
  const run = (await tx.doc(RunDoc, conversation.id)).runs[0]!;
  run.status = status;
  // The fabricated terminal state is history the model knows, not a stop to announce (ADR 0096).
  (await tx.doc(DagSeenDoc, conversation.id)).seen[run.id] = runStateKey(run);
  if (legacy) {
   delete run.sourceIds;
   // Missing lineage is the legacy storage shape; the actual host user-entry
   // timestamp remains authoritative even if reconciliation happens later.
  }
 }, context);
 return { bot, faux, handler, message, conversation };
}

for (const legacy of [false, true]) for (const status of ["cancelled", "verified"] as const) test(`terminal ${status} ${legacy ? "legacy" : "host lineage"} excludes later input from current prompt/delivery but remains queryable`, async () => {
 const f = await fixture(status, legacy);
 await Bun.sleep(5); // Strictly later host entry time; clock ties intentionally remain unknown.
 const before = await f.bot.harness.snapshot(RunDoc, f.conversation.id, context);
 let prompt = "";
 f.faux.setResponses([transcript => {
  prompt = transcript.messages.filter(m => m.role === "system").map(m => m.role === "system" ? m.sections?.dag_protocol ?? "" : "").at(-1) ?? "";
  return fauxAssistantMessage(body);
 }]);
 // Deliberately mentions history: scope must not use keyword matching.
 const later = await f.handler({ ...f.message, messageId: "later", text: "DAG cancelled history is not current status; tell me an ordinary answer" });
 if (later.status !== "answered") throw Error("missing reply");
 expect(later.text).toBe(body);
 expect(prompt).not.toContain("Active run:");
 expect(prompt).toContain("dag_status");
 expect(await f.bot.harness.snapshot(RunDoc, f.conversation.id, context)).toEqual(before);
 expect(validHumanAcceptance(await f.bot.work.snapshot(f.conversation.id, context))).toBe(false);
 const runId = before!.activeId!;
 let historical = "";
 f.faux.setResponses([fauxAssistantMessage(fauxToolCall("dag_status", { run_id: runId }), { stopReason: "toolUse" }), transcript => { historical = JSON.stringify(transcript.messages.filter(m => m.role === "toolResult")); return fauxAssistantMessage("Historical result retrieved"); }]);
 const queried = await f.handler({ ...f.message, messageId: "history-query", text: "Show the old run's status" });
 expect(queried.status).toBe("answered");
 expect(historical).toContain(runId);
 expect(historical).toContain(status);
 expect(await f.bot.harness.snapshot(RunDoc, f.conversation.id, context)).toEqual(before);
});

for (const legacy of [false, true]) test(`same originating cancelled ${legacy ? "legacy" : "lineage"} answer is still uncertified`, async () => {
 const f = await fixture("cancelled", legacy);
 const reply = await f.handler(f.message);
 if (reply.status !== "answered") throw Error("missing reply");
 expect(reply.text).toBe(body);
 expect(validHumanAcceptance(await f.bot.work.snapshot(f.conversation.id, context))).toBe(false);
});

for (const status of ["running", "blocked"] as const) test(`unsettled ${status} history preserves later answer`, async () => {
 const f = await fixture(status, true); f.faux.setResponses([fauxAssistantMessage(body)]);
 const reply = await f.handler({ ...f.message, messageId: "later", text: "ordinary result" });
 if (reply.status !== "answered") throw Error(`missing reply: ${JSON.stringify(reply)}; calls=${f.faux.state.callCount}`);
 expect(reply.text).toBe(body);
 expect(reply.text).toContain("Everything completed");
 expect(validHumanAcceptance(await f.bot.work.snapshot(f.conversation.id, context))).toBe(false);
});

test("scope unknown/clock ties/mixed inputs never exclude potentially related legacy output", () => {
 const run = createRun("legacy", plan, 100); run.status = "cancelled"; run.updatedAt = 200;
 const work = { works: [], sources: {}, inputTimes: { old: { entryId: 1, at: 90 }, new: { entryId: 2, at: 201 } }, humanInputs: [{ sourceId: "old", entryId: 1, at: 90, text: "x", hash: "invalid", assertion: "x" }, { sourceId: "new", entryId: 2, at: 201, text: "x", hash: "invalid", assertion: "x" }] };
 expect(dagAnswerScope(run, ["old"], work)).toBe("unknown");
 expect(dagAnswerScope(run, ["new"], work)).toBe("history");
 expect(dagAnswerScope(run, ["old", "new"], work)).toBe("unknown");
 expect(dagAnswerScope(run, ["forged"], work)).toBe("unknown");
 expect(dagAnswerScope(run, [], work)).toBe("unknown");
 work.inputTimes.new.at = 200;
 expect(dagAnswerScope(run, ["new"], work)).toBe("unknown");
 run.sourceIds = ["old", "new"];
 expect(dagAnswerScope(run, ["new"], work)).toBe("current");
 expect(dagAnswerScope(run, ["other"], work)).toBe("history");
});

test("research owner remains in prompt and generic DAG mutation remains denied", async () => {
 const f = await fixture("cancelled", false);
 await f.bot.harness.commit(async tx => { (await tx.doc(RunDoc, f.conversation.id)).runs[0]!.owner = { missionId: "research-control" }; }, context);
 let prompt = "", result = "";
 f.faux.setResponses([transcript => { prompt = transcript.messages.filter(m => m.role === "system").map(m => m.role === "system" ? m.sections?.dag_protocol ?? "" : "").at(-1) ?? ""; return fauxAssistantMessage(fauxToolCall("dag_step", { cancel: true }), { stopReason: "toolUse" }); }, transcript => { result = JSON.stringify(transcript.messages.filter(m => m.role === "toolResult")); return fauxAssistantMessage(body); }]);
 await f.handler({ ...f.message, messageId: "research-later", text: "cancel with generic tool" });
 expect(prompt).toContain("Active run:");
 expect(result).toContain("Research-owned run");
 expect((await f.bot.harness.snapshot(RunDoc, f.conversation.id, context))!.runs[0]!.owner!.missionId).toBe("research-control");
});

async function delivered(f: Awaited<ReturnType<typeof fixture>>) {
 const reply = await f.handler(f.message);
 if (reply.status !== "answered") throw Error("missing reply");
 return reply.text;
}
