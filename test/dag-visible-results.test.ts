import { afterEach, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { LiveDoc, MemoryStorage } from "@earendil-works/pi-durable";
import { openBot, type Bot } from "../src/core/bot.ts";
import { createRun, RunDoc, start, succeed } from "../src/core/dag.ts";
import { WorkDoc, validHumanAcceptance } from "../src/core/verification.ts";
import { channelHandler } from "../src/core/channel-handler.ts";
import { createNativeModelHandler } from "../src/core/native-model-commands.ts";
import { telegramChannel } from "../src/channels/telegram.ts";
import { renderRichText } from "../src/channels/rich-text.ts";
import { telegramProgress } from "../src/channels/telegram-progress.ts";
import type { ProgressEvent } from "../src/channels/types.ts";
import { forbiddenCommands, telegramConfig, secret } from "./fixtures/channel-e2e-child.ts";
import { settleWakes, wakeAware } from "./fixtures/idle-wake.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bots: Bot[] = [];
afterEach(async () => { for (const bot of bots.splice(0)) await bot.close(context); });
const report = "조사 결과\n공식 문서와 실행 근거를 비교했습니다.\n근거: https://example.org/research\n권장: 검증된 항목을 우선 적용하세요.";

for (const kind of ["missing", "stale", "corrupt", "forged", "invalid-acceptance"] as const) test(`verified phase retains result but preserves ${kind} goal provenance internally`, async () => {
 const f = await fixture();
 if (kind === "invalid-acceptance") await accept(f);
 await f.bot.harness.commit(async tx => {
  const work = await tx.doc(WorkDoc, f.conversation.id);
  const run = (await tx.doc(RunDoc, f.conversation.id)).runs[0]!;
  if (kind === "missing") delete work.goal;
  else if (kind === "stale") run.goalBinding!.epoch++;
  else if (kind === "corrupt") work.goal!.sources[0]!.text += "tampered";
  else if (kind === "invalid-acceptance") work.goal!.acceptance!.epoch++;
  else work.goal!.acceptance = { epoch: work.goal!.epoch, hash: work.goal!.hash, sourceId: work.goal!.sources[0]!.sourceId, inputHash: "forged", at: Date.now() };
 }, context);
 const reply = await f.handler(f.message); if (reply.status !== "answered") throw Error("missing reply");
 expect(reply.text).toBe(report);
 expect(validHumanAcceptance(await f.bot.work.snapshot(f.conversation.id, context))).toBe(false);
});

async function accept(f: Awaited<ReturnType<typeof fixture>>) {
 const goal = (await f.bot.work.snapshot(f.conversation.id, context)).goal!;
 f.faux.setResponses([fauxAssistantMessage(report)]);
 const message = { ...f.message, messageId: "2", text: JSON.stringify({ dinobotGoalAcceptance: { epoch: goal.epoch, hash: goal.hash } }) };
 await f.handler(message);
 expect(validHumanAcceptance(await f.bot.work.snapshot(f.conversation.id, context))).toBe(true);
 return message;
}

test("genuine durable human acceptance passes unchanged; a later human input invalidates it", async () => {
 const f = await fixture(); const message = await accept(f);
 const accepted = await f.handler(message); if (accepted.status !== "answered") throw Error("missing reply");
 expect(accepted.text).toBe(report);
 f.faux.setResponses([fauxAssistantMessage(report)]);
 const later = await f.handler({ ...message, messageId: "3", text: "추가 범위도 조사해 줘" });
 if (later.status !== "answered") throw Error("missing reply");
 expect(later.text).toContain(report);
 expect(later.text).toBe(report); // Terminal history is not the scope of the later input.
 expect(validHumanAcceptance(await f.bot.work.snapshot(f.conversation.id, context))).toBe(false);
});

test("cancelled session DAG retains a later parent report as uncertified, without accepting the goal", async () => {
 const body = "Windows E2E 보고\n모델 주장: callback token exchange 200, user 2xx, logout cleanup.\n한계: 실제 실행 영수증은 이 답변에서 확인되지 않았으며 앱 프로세스는 유지됩니다.";
 const f = await fixture(body, 17108);
 await f.bot.harness.commit(async tx => { const doc = await tx.doc(RunDoc, f.conversation.id); doc.runs[0]!.status = "cancelled"; }, context);
 await Bun.sleep(2); // A genuinely later host input, not an ambiguous equal clock tick.
 f.faux.setResponses([fauxAssistantMessage(body)]);
 const reply = await f.handler({ ...f.message, messageId: "later-parent", text: "현재 결과와 한계를 알려 줘" });
 if (reply.status !== "answered") throw Error("missing reply");
 expect(reply.text).toBe(body);
 expect(reply.text).not.toContain("검증 절차가 취소되었습니다.");
 expect(reply.text).toContain("callback token exchange 200");
 expect(reply.text).toContain("앱 프로세스는 유지됩니다");
 expect((await f.bot.harness.snapshot(RunDoc, f.conversation.id, context))!.runs[0]!.status).toBe("cancelled");
 expect(validHumanAcceptance(await f.bot.work.snapshot(f.conversation.id, context))).toBe(false);
});

for (const state of ["running", "blocked", "cancelled", "approval", "child"] as const) test(`unfinished ${state} DAG preserves exact reports without certifying completion`, async () => {
 const f = await fixture("ALL_DONE_CLAIM\nEverything completed\n100\n" + report);
 await f.bot.harness.commit(async tx => { const doc = await tx.doc(RunDoc, f.conversation.id); const run = createRun("unfinished", { nodes: [{ id: "v", kind: "verify", covers: ["R"] }], edges: [], goal: { requirements: ["R"] } }, Date.now()); run.status = state === "approval" || state === "child" ? "running" : state; if (state === "approval" || state === "child") { run.nodes.v!.status = "waiting"; if (state === "approval") run.nodes.v!.ask = { id: "human-approval", refs: [] }; } doc.runs.push(run); doc.activeId = run.id; }, context);
 const beforeRun = await f.bot.harness.snapshot(RunDoc, f.conversation.id, context);
 const beforeWork = await f.bot.work.snapshot(f.conversation.id, context);
 const reply = await f.handler(f.message); if (reply.status !== "answered") throw Error("missing reply");
 expect(await f.bot.harness.snapshot(RunDoc, f.conversation.id, context)).toEqual(beforeRun);
 expect(await f.bot.work.snapshot(f.conversation.id, context)).toEqual(beforeWork);
 expect(reply.text).toBe("ALL_DONE_CLAIM\nEverything completed\n100\n" + report);
 expect(reply.text).not.toMatch(/run unfinished|Φ=|semantics=|critical path:|모델의 주장|^> /m);
 expect(reply.text).toContain("ALL_DONE_CLAIM");
 expect(reply.text).toContain("Everything completed");
 expect(reply.text).toContain("100");
 expect(reply.text).toContain("근거: https://example.org/research");
 expect(reply.text).not.toBe("ALL_DONE_CLAIM");
 expect(validHumanAcceptance(await f.bot.work.snapshot(f.conversation.id, context))).toBe(false);
});
test("host submission lineage distinguishes current unfinished output from a later parent answer", async () => {
 const models = createModels(); const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] }); models.setProvider(faux.provider);
 wakeAware(faux); // ADR 0096: the run blocked by its failing verifier wakes the idle orchestrator; not a scripted reply.
 const bot = await openBot({ storage: new MemoryStorage(), models, plugins: [], toolMode: "direct", defaultModel: { provider: "faux", modelId: "m" }, settings: { retry: { enabled: false } } }, context); bots.push(bot);
 const handler = channelHandler({ commandPolicy: "none" }, bot, forbiddenCommands(), context, createNativeModelHandler(bot, models, context));
 const message = { channel: "telegram", threadKey: "123456:-100:17108:1", messageId: "lineage-first", userId: "1", text: "조사 계획과 부분 결과를 보여 줘" };
 faux.setResponses([fauxAssistantMessage(fauxToolCall("dag_run", { plan: { nodes: [{ id: "v", kind: "verify", covers: ["R"] }], edges: [], goal: { requirements: ["R"] } } }), { stopReason: "toolUse" }), fauxAssistantMessage("부분 근거: A. 한계: 아직 verifier 실행 전.")]);
 const first = await handler(message); if (first.status !== "answered") throw Error("missing reply");
 expect(first.text).toBe("부분 근거: A. 한계: 아직 verifier 실행 전.");
 expect(first.text).toContain("부분 근거: A");
 const conversation = await bot.conversation(message.channel, message.threadKey, context);
 const before = (await bot.harness.snapshot(RunDoc, conversation.id, context))!;
 expect(before.runs[0]!.sourceIds!.length).toBeGreaterThan(0);
 // The verifier child has no scripted reply and fails in the background; let the run stop (and its wake settle) first,
 // so that child cannot take the reply scripted for the later message below (ADR 0096 made this race visible).
 for (let i = 0; i < 300 && (await bot.harness.snapshot(RunDoc, conversation.id, context))!.runs[0]!.status === "running"; i++) await Bun.sleep(10);
 await settleWakes(bot, conversation.id);
 await bot.harness.commit(async tx => { (await tx.doc(RunDoc, conversation.id)).runs[0]!.status = "cancelled"; }, context);
 let laterPrompt = "";
 faux.setResponses([transcript => { laterPrompt = transcript.messages.filter(m => m.role === "system").map(m => m.role === "system" ? m.sections?.dag_protocol ?? "" : "").at(-1) ?? ""; return fauxAssistantMessage("현재 부모 답변: 후속 조사 B. 한계: 완료 미검증."); }]);
 const later = await handler({ ...message, messageId: "lineage-later", text: "다른 현재 결과를 보여 줘" });
 if (later.status !== "answered") throw Error("missing reply");
 expect(later.text).toBe("현재 부모 답변: 후속 조사 B. 한계: 완료 미검증.");
 expect(later.text).not.toContain("검증 절차가 취소되었습니다.");
 expect(laterPrompt).not.toContain("Active run:");
 expect(laterPrompt).toContain("dag_status");
 expect(validHumanAcceptance(await bot.work.snapshot(conversation.id, context))).toBe(false);
});

test("stale cancelled binding preserves partial evidence without changing provenance or acceptance", async () => {
 const f = await fixture();
 await f.bot.harness.commit(async tx => { const run = (await tx.doc(RunDoc, f.conversation.id)).runs[0]!; run.status = "cancelled"; run.goalBinding!.epoch++; }, context);
 const work = await f.bot.work.snapshot(f.conversation.id, context);
 const run = await f.bot.harness.snapshot(RunDoc, f.conversation.id, context);
 const reply = await f.handler(f.message); if (reply.status !== "answered") throw Error("missing reply");
 expect(reply.text).toBe(report);
 expect(await f.bot.work.snapshot(f.conversation.id, context)).toEqual(work);
 expect(await f.bot.harness.snapshot(RunDoc, f.conversation.id, context)).toEqual(run);
 expect(validHumanAcceptance(work)).toBe(false);
});

async function fixture(answer = report, topic = 10) {
 const models = createModels();
 const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] }); models.setProvider(faux.provider);
 faux.setResponses([fauxAssistantMessage(answer)]);
 const bot = await openBot({ storage: new MemoryStorage(), models, plugins: [], toolMode: "direct", defaultModel: { provider: "faux", modelId: "m" }, settings: { retry: { enabled: false } } }, context); bots.push(bot);
 const message = { channel: "telegram", threadKey: `123456:-100:${topic}:1`, messageId: "1", userId: "1", text: "근거를 포함해 조사해 줘" };
 const handler = channelHandler({ commandPolicy: "none" }, bot, forbiddenCommands(), context, createNativeModelHandler(bot, models, context));
 const initial = await handler(message); expect(initial.status).toBe("answered");
 const conversation = await bot.conversation(message.channel, message.threadKey, context);
 // A real host DAG state machine with current source provenance; replay the durable input without admitting a new human message.
 await bot.harness.commit(async tx => {
  const goal = (await tx.doc(WorkDoc, conversation.id)).goal!;
  const run = createRun("dag-visible-fixture", { nodes: [{ id: "v", kind: "verify", covers: ["R"] }], edges: [], goal: { requirements: ["R"] } }, Date.now());
  run.goalBinding = { epoch: goal.epoch, hash: goal.hash };
  start(run, "v", undefined, Date.now());
  succeed(run, "v", JSON.stringify({ version: 1, requirements: [{ id: "R", verdict: "pass", evidence: "fixture source comparison" }], summary: "phase checked", repairable: false }), Date.now());
  expect(run.status).toBe("verified");
  const doc = await tx.doc(RunDoc, conversation.id); doc.runs.push(run); doc.activeId = run.id;
 }, context);
 return { bot, models, faux, message, handler, conversation, initial };
}

test("real bot.handle/native forwarder retains informational research without granting human acceptance", async () => {
 const f = await fixture();
 const before = await f.bot.work.snapshot(f.conversation.id, context);
 const reply = await f.handler(f.message);
 expect(reply.status).toBe("answered"); if (reply.status !== "answered") throw Error("missing reply");
 expect(reply.text).toBe(report);
 expect(reply.text).not.toContain(before.goal!.hash);
 expect(reply.workflow).toBeUndefined();
 expect(await f.bot.work.snapshot(f.conversation.id, context)).toEqual(before);
 expect(validHumanAcceptance(before)).toBe(false);
 expect(f.faux.state.callCount).toBe(1);
});

test("native dag_run/dag_step and actual verifier child reach bot delivery with report intact", async () => {
 const models = createModels(); const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] }); models.setProvider(faux.provider);
 const bot = await openBot({ storage: new MemoryStorage(), models, plugins: [], toolMode: "direct", defaultModel: { provider: "faux", modelId: "m" }, settings: { retry: { enabled: false } } }, context); bots.push(bot);
 const root = await bot.conversation("telegram", "native-dag", context);
 faux.setResponses(Array.from({ length: 20 }, () => async transcript => {
  if (String(transcript.messages.findLast(m => m.role === "user")?.content).includes("plan node")) return fauxAssistantMessage(JSON.stringify({ version: 1, requirements: [{ id: "R", verdict: "pass", evidence: "Compared retained research evidence" }], summary: "checked", repairable: false }));
  const run = (await bot.harness.snapshot(RunDoc, root.id, context))?.runs[0];
  if (run?.status === "verified") return fauxAssistantMessage(report);
  if (run) { await Bun.sleep(30); return fauxAssistantMessage(fauxToolCall("dag_step", {}), { stopReason: "toolUse" }); }
  return fauxAssistantMessage(fauxToolCall("dag_run", { plan: { nodes: [{ id: "v", kind: "verify", covers: ["R"] }], edges: [], goal: { requirements: ["R"] } } }), { stopReason: "toolUse" });
 }));
 const handler = channelHandler({ commandPolicy: "none" }, bot, forbiddenCommands(), context, createNativeModelHandler(bot, models, context));
 const reply = await handler({ channel: "telegram", threadKey: "native-dag", messageId: "native", userId: "1", text: "조사 결과와 근거를 보여 줘" });
 if (reply.status !== "answered") throw Error("missing reply");
 expect((await bot.harness.snapshot(RunDoc, root.id, context))!.runs[0]!.status).toBe("verified");
 expect(reply.text).toBe(report);
 expect(validHumanAcceptance(await bot.work.snapshot(root.id, context))).toBe(false);
});

test("live draft and terminal delivery both retain the report, while Telegram clears the provisional card", async () => {
 const f = await fixture();
 const events: ProgressEvent[] = [];
 const writes: Record<string, unknown>[] = [];
 const reporter = telegramProgress({ chat: "-100", topic: "10", detailed: true, editIntervalMs: 10, finalGapMs: 0, finalWaitMs: 10, bubbleDelayMs: 0, call: async (_method, body) => { writes.push(body); return { ok: true, result: { message_id: 10 } }; } });
 f.faux.setResponses([async () => {
   await f.bot.harness.commit(async tx => { (await tx.doc(RunDoc, f.conversation.id)).runs[0]!.sourceIds = (await tx.doc(LiveDoc, f.conversation.id)).run!.inputs.map(String); }, context);
   await Bun.sleep(50); return fauxAssistantMessage(report);
  }]);
  const reply = await f.handler({ ...f.message, messageId: "live", text: "조사 결과를 보여 줘" }, undefined, event => { events.push(event); reporter.event(event); });
 if (reply.status !== "answered") throw Error("missing reply");
 expect(events.some(e => e.type === "draft" && e.text === report)).toBe(true);
 expect(reply.text).toBe(report);
 await reporter.tick();
 await reporter.finish({ kind: "done" });
 const cards = writes.filter(w => typeof w.text === "string");
 expect(cards.length).toBeGreaterThan(0);
 expect(String(cards.at(-1)!.text)).not.toContain(report);
 expect(String(cards.at(-1)!.text)).not.toContain("인증 완료");
 expect(validHumanAcceptance(await f.bot.work.snapshot(f.conversation.id, context))).toBe(false);
});

test("unfinished completion draft remains provisional and terminal delivery preserves it exactly", async () => {
 const claim = "Everything completed\n100\n부분 근거만 있음; 실제 사용자 수락 없음.";
 const f = await fixture(claim);
 await f.bot.harness.commit(async tx => { const doc = await tx.doc(RunDoc, f.conversation.id); const run = createRun("draft-unfinished", { nodes: [{ id: "v", kind: "verify", covers: ["R"] }], edges: [], goal: { requirements: ["R"] } }, Date.now()); run.goalBinding = { epoch: (await tx.doc(WorkDoc, f.conversation.id)).goal!.epoch, hash: (await tx.doc(WorkDoc, f.conversation.id)).goal!.hash }; run.nodes.v!.status = "waiting"; doc.runs.push(run); doc.activeId = run.id; }, context);
 const events: ProgressEvent[] = [];
 f.faux.setResponses([async () => { await Bun.sleep(50); return fauxAssistantMessage(claim); }]);
 const reply = await f.handler({ ...f.message, messageId: "unfinished-draft", text: "현재 부분 결과" }, undefined, event => events.push(event));
 if (reply.status !== "answered") throw Error("missing reply");
 expect(events.some(e => e.type === "draft" && e.text === claim)).toBe(true);
 expect(reply.text).toBe(claim);
 expect(reply.text).toContain("부분 근거만 있음; 실제 사용자 수락 없음.");
 expect((await f.bot.harness.snapshot(RunDoc, f.conversation.id, context))!.runs.at(-1)!.status).toBe("running");
 expect(validHumanAcceptance(await f.bot.work.snapshot(f.conversation.id, context))).toBe(false);
});

for (const topic of [0, 15520, 17108]) test(`Telegram adapter preserves report paging and actual ingress topic ${topic}`, async () => {
 const long = report + "\n" + "가😀 근거\n".repeat(800) + "REPORT_TAIL";
 const f = await fixture(long, topic);
 if (topic === 17108) await f.bot.harness.commit(async tx => { (await tx.doc(RunDoc, f.conversation.id)).runs[0]!.status = "cancelled"; }, context);
 const dir = await mkdtemp(join(tmpdir(), "dag-visible-telegram-"));
 const deliveries: { text: string; message_thread_id?: number }[] = [];
 const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) { const body = await req.json() as any; if (new URL(req.url).pathname.endsWith("/sendMessage")) deliveries.push(body); else expect(new URL(req.url).pathname).toEndWith("/setMyCommands"); return Response.json({ ok: true }); } });
 const channel = telegramChannel({ ...telegramConfig(dir), progress: "off" }, { apiBase: server.url.origin });
 try {
  await channel.start(channelHandler(channel, f.bot, forbiddenCommands(), context, createNativeModelHandler(f.bot, f.models, context)));
  const event = { update_id: 1, message: { message_id: 1, from: { id: 1, is_bot: false }, chat: { id: -100 }, ...(topic ? { message_thread_id: topic } : {}), text: f.message.text } };
  expect((await fetch(new URL("/webhook", channel.url()), { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret }, body: JSON.stringify(event) })).status).toBe(200);
  const end = Date.now() + 15000;
  while (channel.health().done !== 1 && Date.now() < end) await Bun.sleep(10);
  expect(channel.health().done).toBe(1);
  const text = deliveries.map(d => d.text).join("");
  // Telegram rich rendering expands bare links; compare every wire chunk to the production renderer, and independently retain the complete Unicode body/tail.
  const reply = await f.handler(f.message); if (reply.status !== "answered") throw Error("missing reply");
  expect(deliveries.map(d => d.text)).toEqual(renderRichText(reply.text, "telegram"));
  expect(text).toContain("REPORT_TAIL");
  expect(text.split("가😀 근거").length - 1).toBe(800);
  expect(reply.text).toBe(long);
  expect(text).toContain("가😀 근거\n".repeat(800) + "REPORT_TAIL");
  expect(deliveries.map(d => d.text)).toEqual(renderRichText(long, "telegram"));
  expect(deliveries.length).toBeGreaterThan(1);
  for (const d of deliveries) { expect(d.text.length).toBeLessThanOrEqual(4096); expect(d.message_thread_id).toBe(topic || undefined); }
  expect(f.faux.state.callCount).toBe(1);
  const oldRun = await f.bot.harness.snapshot(RunDoc, f.conversation.id, context);
  const deliveredBefore = deliveries.length;
  const ordinary = "ORDINARY_LATER_ANSWER: DAG history remains queryable; this is not a receipt.";
  f.faux.setResponses([fauxAssistantMessage(ordinary)]);
  // update_id, not nested message_id, is the durable Telegram ingress identity.
  const laterEvent = { ...event, update_id: 2, message: { ...event.message, message_id: 2, text: "다른 일반 질문에 답해 줘 (DAG 기록은 유지)" } };
  expect((await fetch(new URL("/webhook", channel.url()), { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret }, body: JSON.stringify(laterEvent) })).status).toBe(200);
  const laterEnd = Date.now() + 15000;
  while (channel.health().done !== 2 && Date.now() < laterEnd) await Bun.sleep(10);
  expect(channel.health().done).toBe(2);
  expect(deliveries.slice(deliveredBefore).map(d => d.text)).toEqual(renderRichText(ordinary, "telegram"));
  expect(await f.bot.harness.snapshot(RunDoc, f.conversation.id, context)).toEqual(oldRun);
  expect(validHumanAcceptance(await f.bot.work.snapshot(f.conversation.id, context))).toBe(false);
 } finally { await channel.stop(); await server.stop(true); await rm(dir, { recursive: true, force: true }); }
}, 20000);
