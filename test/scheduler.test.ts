import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineTask, InboxDoc, LiveDoc, type ConversationId, type TaskId, type SubmissionId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openBot, type Bot } from "../src/core/bot.ts";
import { Scheduler, SchedulesDoc, scheduleTime, completedWork } from "../src/core/scheduler.ts";
import { GoalDoc, newGoal } from "../src/core/goal.ts";
import { AsksDoc, LinkDoc } from "../src/core/ask.ts";
import { TodoDoc } from "../src/extensions/todo.ts";
import { AgentsDoc, ProgressDoc, PLUGIN_WAKE_REQUEST_PREFIX } from "../src/extensions/subagents.ts";
import { RunDoc, createRun } from "../src/core/dag.ts";
import { rotateThread } from "../src/core/threads.ts";
import { pendingWork } from "../src/extensions/liveness.ts";
import { schedulerExtension } from "../src/extensions/scheduler.ts";

const clean: (() => Promise<void>)[] = [];
afterEach(async () => { for (const f of clean.splice(0).reverse()) await f(); });
const epoch = Date.parse("2026-10-01T00:00:00Z");
async function setup(mode: "direct" | "codemode-only" = "direct", timers = false) {
 const dir = await mkdtemp(join(tmpdir(), "scheduler-test-"));
 clean.push(() => rm(dir, { recursive: true, force: true }));
 const clock = { now: epoch }; const outputs: string[] = [];
 const open = async () => {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
  faux.setResponses(Array.from({ length: 100 }, () => async (t: Parameters<import("@earendil-works/pi-ai/providers/faux").FauxResponseFactory>[0]) => {
   const user = t.messages.findLast(m => m.role === "user");
   const raw = typeof user?.content === "string" ? user.content : JSON.stringify(user?.content);
   const results = t.messages.slice(t.messages.findLastIndex(m => m.role === "user") + 1).filter(m => m.role === "toolResult");
   if (raw?.includes("register schedule") && !results.length) {
    const args = { key: "tool-create", text: "report scheduled result", at: "2026-10-01T00:00:05Z" };
    return fauxAssistantMessage(mode === "direct" ? fauxToolCall("schedule_create", args) : fauxToolCall("codemode", { code: "text(await tools.schedule_create(" + JSON.stringify(args) + "));" }), { stopReason: "toolUse" });
   }
   if (raw?.includes("update schedule ") && !results.length) return fauxAssistantMessage(fauxToolCall("schedule_update", JSON.parse(raw.slice(raw.indexOf("update schedule ") + 16))), { stopReason: "toolUse" });
   if (raw?.includes("discover schedule") && !results.length) return fauxAssistantMessage(fauxToolCall("tool_search", { query: "schedule_create" }), { stopReason: "toolUse" });
   if (raw?.includes("force error")) return fauxAssistantMessage("interrupted", { stopReason: "error", errorMessage: "test failure" });
   outputs.push(...results.map(r => JSON.stringify(r.content)));
   return fauxAssistantMessage(raw?.startsWith('<from host="plugin:scheduler"/>') ? "SCHEDULED RESULT" : "DONE");
  }));
  const models = createModels(); models.setProvider(faux.provider);
  const bot = await openBot({ storage: await openNodeSqliteStorage(join(dir, "bot.sqlite")), models, defaultModel: { provider: "faux", modelId: "faux-1" }, toolMode: mode, plugins: [], hostChannels: ["tui"], scheduler: { now: () => clock.now, timers }, settings: { retry: { enabled: false } } }, context);
  clean.push(() => bot.close(context)); return bot;
 };
 const bot = await open();
 const owner = await bot.conversation("tui", "owner", context);
 const other = await bot.conversation("tui", "other", context);
 const message = async (b: Bot, thread = "owner", text = "hello") => b.handle({ channel: "tui", threadKey: thread, userId: "local", messageId: String(Math.random()), text }, context);
 return { bot, owner, other, clock, open, message, outputs };
}
async function settle(bot: Bot, owner: ConversationId, id: string) {
 const record = await bot.harness.commit(tx => tx.submissionByRequest(owner, PLUGIN_WAKE_REQUEST_PREFIX + "scheduler:" + id), context);
 expect(record).toBeDefined();
 await (await bot.harness.submission(record!.id, context))!.wait(context);
 await bot.scheduler.tick();
}
async function goal(bot: Bot, id: ConversationId, achieved = false) {
 await bot.harness.commit(async tx => {
  const g = newGoal({ objective: "Finish work", criteria: [{ id: "done", statement: "finished", check: { kind: "binary", observable: "test passes", method: "test" } }] }, 1, epoch);
  if (achieved) { g.status = "achieved"; g.criteria[0]!.status = "met"; g.criteria[0]!.evidence = "passed"; }
  (await tx.doc(GoalDoc, id)).goal = g;
 }, context);
}

test("continuation registration pins active goal identity across revisions and restart, not unrelated schedules", async () => {
 const h = await setup();
 const input = { key: "resume", text: "Resume the authorized work", at: "2026-10-01T00:00:05Z", continue_goal: true };
 await expect(h.bot.scheduler.create(h.owner.id, input)).rejects.toThrow("active origin goal");
 await goal(h.bot, h.owner.id);
 await expect(h.bot.scheduler.create(h.owner.id, { ...input, after_thread: "tui:owner" })).rejects.toThrow("own goal");
 const row = await h.bot.scheduler.create(h.owner.id, input);
 expect(row.continuationGoal).toEqual({ createdAt: epoch, objective: "Finish work" });
 expect((await pendingWork(h.bot.harness, h.owner.id, context)).schedules).toEqual([row.id]);
 expect((await pendingWork(h.bot.harness, h.other.id, context)).schedules).toEqual([]);
 await h.bot.harness.commit(async tx => { (await tx.doc(GoalDoc, h.owner.id)).goal!.revision++; }, context);
 await h.bot.scheduler.update(h.owner.id, row.id, { text: "Updated instruction" });
 await h.bot.close(context);
 const second = await h.open();
 expect((await pendingWork(second.harness, h.owner.id, context)).schedules).toEqual([row.id]);
 expect((await second.scheduler.list(h.owner.id))[0]!.continuationGoal).toEqual(row.continuationGoal);
 for (const state of ["cancelled", "failed", "completed", "admitted"] as const) {
  await second.harness.commit(async tx => { (await tx.doc(SchedulesDoc)).schedules[0]!.state = state; }, context);
  expect((await pendingWork(second.harness, h.owner.id, context)).schedules).toEqual([]);
 }
 await second.harness.commit(async tx => { (await tx.doc(SchedulesDoc)).schedules[0]!.state = "pending"; (await tx.doc(GoalDoc, h.owner.id)).goal!.createdAt++; }, context);
 expect((await pendingWork(second.harness, h.owner.id, context)).schedules).toEqual([]);
 // Same key replay cannot silently bind a replacement goal.
 expect((await second.scheduler.create(h.owner.id, input)).continuationGoal).toEqual(row.continuationGoal);
 await second.harness.commit(async tx => { const g = (await tx.doc(GoalDoc, h.owner.id)).goal!; g.createdAt = epoch; g.objective = "Different work"; }, context);
 expect((await pendingWork(second.harness, h.owner.id, context)).schedules).toEqual([]);
 for (const status of ["achieved", "abandoned"] as const) {
  await second.harness.commit(async tx => { const g = (await tx.doc(GoalDoc, h.owner.id)).goal!; g.objective = "Finish work"; g.status = status; }, context);
  expect((await pendingWork(second.harness, h.owner.id, context)).schedules).toEqual([]);
  await expect(second.scheduler.create(h.owner.id, { ...input, key: status })).rejects.toThrow("active origin goal");
 }
}, 20000);

test("scheduler contracts disclose top-level scope, UTF-8 bytes and identical update time constraints", async () => {
 const h = await setup();
 const tools = schedulerExtension(h.bot.scheduler).tools!;
 const create = tools.find(t => t.name === "schedule_create")!;
 const update = tools.find(t => t.name === "schedule_update")!;
 for (const tool of tools) expect(tool.description).toContain("Top-level origin only");
 const createParams = create.parameters as unknown as { properties: { text: { description: string }; at: unknown } };
 const updateParams = update.parameters as unknown as typeof createParams;
 expect(createParams.properties.text.description).toContain("UTF-8 bytes");
 expect(updateParams.properties.text).toEqual(createParams.properties.text);
 expect(updateParams.properties.at).toEqual(createParams.properties.at);
 const row = await h.bot.scheduler.create(h.owner.id, { key: "bytes", text: "한".repeat(4000), at: "2026-10-01T00:00:05Z" });
 await expect(h.bot.scheduler.create(h.owner.id, { key: "too-many-bytes", text: "한".repeat(4001), at: "2026-10-01T00:00:05Z" })).rejects.toThrow("too long");
 await expect(h.bot.scheduler.update(h.owner.id, row.id, { text: "한".repeat(4001) })).rejects.toThrow("too long");
 await expect(h.bot.scheduler.update(h.owner.id, row.id, { at: "2026-10-01T00:00:06" })).rejects.toThrow("explicit offset");
});

test("a scheduled goal wake does not suppress liveness inside its own turn", async () => {
 const h = await setup(); await goal(h.bot, h.owner.id);
 const row = await h.bot.scheduler.create(h.owner.id, { key: "wake", text: "Resume authorized work", at: "2026-10-01T00:00:01Z", continue_goal: true });
 h.clock.now += 2000;
 await h.bot.scheduler.tick(); await settle(h.bot, h.owner.id, row.id);
 const entries = (await h.owner.entries({}, 100, undefined, context)).items;
 expect(entries.flatMap(e => e.model ?? []).some(m => m.role === "user" && JSON.stringify(m.content).includes("registered continuation of this goal"))).toBe(true);
 expect((await h.bot.scheduler.list(h.owner.id))[0]!.state).toBe("completed");
});

test("strict future dates, offsets, invalid dates and timer boundaries", () => {
 expect(scheduleTime("2026-10-01T09:00:01+09:00", epoch, false)).toBe(epoch + 1000);
 expect(scheduleTime(undefined, epoch, true)).toBe(epoch);
 for (const value of [undefined, "2026-10-01T00:00:00Z", "2026-10-01T01:00:00", "2026-11-31T00:00:00Z", "2026-10-01T24:00:00Z", "2028-01-01T00:00:00Z", "garbage"]) expect(() => scheduleTime(value, epoch, false)).toThrow();
});

for (const mode of ["direct", "codemode-only"] as const) test(mode + ": real model tool registration, discoverability, wake and outcome", async () => {
 const h = await setup(mode);
 await h.message(h.bot, "owner", "register schedule");
 const rows = await h.bot.scheduler.list(h.owner.id); expect(rows).toHaveLength(1);
 await h.message(h.bot, "owner", "discover schedule");
 expect(h.outputs.join(" ")).toContain("schedule_create");
 await h.bot.scheduler.tick(); expect((await h.bot.scheduler.list(h.owner.id))[0]!.state).toBe("pending");
 h.clock.now += 5000;
 await Promise.all([h.bot.scheduler.tick(), h.bot.scheduler.tick()]);
 await settle(h.bot, h.owner.id, rows[0]!.id);
 expect((await h.bot.scheduler.list(h.owner.id))[0]).toMatchObject({ state: "completed", result: "SCHEDULED RESULT" });
 expect(await h.bot.scheduler.list(h.other.id)).toEqual([]);
}, 30000);

test("durable restart, replay-safe create, crash after admission dedup and cancellation ownership", async () => {
 const h = await setup(); await h.message(h.bot);
 const row = await h.bot.scheduler.create(h.owner.id, { key: "one", text: "later", at: "2026-10-01T00:00:05Z" });
 await expect(h.bot.scheduler.cancel(h.other.id, row.id)).rejects.toThrow("Unknown");
 await h.bot.scheduler.update(h.owner.id, row.id, { text: "changed" });
 await h.bot.close(context);
 const second = await h.open(); h.clock.now += 10000;
 expect((await second.scheduler.list(h.owner.id))[0]!.text).toBe("changed");
 expect((await second.scheduler.create(h.owner.id, { key: "one", text: "duplicate", at: "2020-01-01T00:00:00Z" })).id).toBe(row.id);
 await second.scheduler.tick(); await settle(second, h.owner.id, row.id);
 await expect(second.scheduler.cancel(h.owner.id, row.id)).rejects.toThrow("Already admitted");
 // Model a crash between host durable admission and the schedule acknowledgement.
 await second.harness.commit(async tx => { (await tx.doc(SchedulesDoc)).schedules[0]!.state = "pending"; }, context);
 await second.close(context);
 const third = await h.open();
 await expect(third.scheduler.cancel(h.owner.id, row.id)).rejects.toThrow("Already admitted");
 await third.scheduler.tick(); await third.scheduler.tick();
 const entries = (await (await third.harness.conversation(h.owner.id, context))!.entries({}, 200, undefined, context)).items;
 expect(entries.flatMap(e => e.model ?? []).filter(m => m.role === "user" && JSON.stringify(m.content).includes("Scheduled task"))).toHaveLength(1);
 const cancel = await third.scheduler.create(h.owner.id, { key: "cancel", text: "never", at: "2026-10-01T00:00:20Z" });
 await third.scheduler.cancel(h.owner.id, cancel.id); await third.scheduler.cancel(h.owner.id, cancel.id);
 h.clock.now += 30000; await third.scheduler.tick();
 expect((await third.scheduler.create(h.owner.id, { key: "cancel", text: "replay" })).state).toBe("cancelled");
}, 30000);

test("completion condition: idle is insufficient, explicit achieved goal and settled answer succeeds", async () => {
 const h = await setup(); await h.message(h.bot); await h.message(h.bot, "other");
 await expect(h.bot.scheduler.create(h.owner.id, { key: "bad", text: "later", after_thread: "tui:missing" })).rejects.toThrow();
 await expect(h.bot.scheduler.create(h.owner.id, { key: "bad", text: "later", after_thread: "tui:other" })).rejects.toThrow("goal");
 await goal(h.bot, h.other.id);
 const row = await h.bot.scheduler.create(h.owner.id, { key: "condition", text: "after work", after_thread: "tui:other" });
 await h.bot.scheduler.tick(); expect((await h.bot.scheduler.list(h.owner.id))[0]!.state).toBe("pending");
 await goal(h.bot, h.other.id, true);
 await h.bot.scheduler.tick(); await settle(h.bot, h.owner.id, row.id);
 expect((await h.bot.scheduler.list(h.owner.id))[0]!.state).toBe("completed");
}, 30000);

test("completion fails closed for open asks, TODO cancellation, failed/unknown descendants, replaced goals and failed DAGs", async () => {
 const h = await setup(); await h.message(h.bot); await h.message(h.bot, "other"); await goal(h.bot, h.other.id, true);
 const row = await h.bot.scheduler.create(h.owner.id, { key: "check", text: "after work", after_thread: "tui:other" });
 const check = () => h.bot.harness.commit(tx => completedWork(tx, row.condition!), context);
 expect(await check()).toBeUndefined();
 await h.bot.harness.commit(async tx => { (await tx.doc(AsksDoc, h.other.id)).asks.push({ id: "a", from: { conversationId: h.other.id }, to: "human", kind: "clarification", refs: [], question: "wait", default: "deny", createdAt: epoch, deadlineAt: epoch + 10000, state: "open" }); }, context);
 expect(await check()).toContain("question");
 await h.bot.harness.commit(async tx => { (await tx.doc(AsksDoc, h.other.id)).asks = []; const r = createRun("test-run", { nodes: [], edges: [], goal: { requirements: ["x"] } }, epoch); r.status = "cancelled"; (await tx.doc(RunDoc, h.other.id)).runs.push(r); }, context);
 expect(await check()).toContain("DAG");
 await h.bot.harness.commit(async tx => { (await tx.doc(RunDoc, h.other.id)).runs = []; (await tx.doc(LiveDoc, h.other.id)).run = { taskId: 123 as TaskId, inputs: [] }; }, context);
 expect(await check()).toContain("running");
 await h.bot.harness.commit(async tx => { delete (await tx.doc(LiveDoc, h.other.id)).run; (await tx.doc(InboxDoc, h.other.id)).items.push({ id: 123 as SubmissionId, mode: "followUp", content: "queued" }); }, context);
 expect(await check()).toContain("queued");
 await h.bot.harness.commit(async tx => { (await tx.doc(InboxDoc, h.other.id)).items = []; }, context);
 await h.bot.harness.commit(async tx => { (await tx.doc(TodoDoc, h.other.id)).todos.push({ id: "cancel", content: "cancelled", status: "cancelled" }); }, context);
 expect(await check()).toContain("TODO");
 await h.bot.harness.commit(async tx => { (await tx.doc(TodoDoc, h.other.id)).todos = []; (await tx.doc(AgentsDoc, h.other.id)).agents.push({ taskId: "child", runnerId: 123 as TaskId<string>, conversationId: h.owner.id, background: true }); }, context);
 expect(await check()).toContain("descendant");
 for (const status of ["running", "failed", "cancelled", "completed"] as const) {
  await h.bot.harness.commit(async tx => { (await tx.doc(ProgressDoc, h.other.id, "123", null)).subagent = { taskId: "child", description: "child", subagentType: "general", background: true, conversationId: h.owner.id, status, startedAt: epoch, toolCount: 0 }; }, context);
  if (status === "completed") expect(await check()).toBeUndefined(); else expect(await check()).toContain("descendant");
 }
 await h.bot.harness.commit(async tx => { (await tx.doc(AgentsDoc, h.other.id)).agents = []; (await tx.doc(GoalDoc, h.other.id)).goal!.createdAt++; }, context);
 expect(await check()).toContain("replaced");
 const external = await h.bot.conversation("slack", "foreign", context); await goal(h.bot, external.id, true);
 await expect(h.bot.scheduler.create(h.owner.id, { key: "foreign", text: "no", after_thread: "slack:foreign" })).rejects.toThrow("unauthorized");
 await h.bot.harness.commit(async tx => { (await tx.doc(LinkDoc, h.other.id)).parent = h.owner.id; }, context);
 await expect(h.bot.scheduler.create(h.other.id, { key: "child", text: "no", at: "2026-10-01T00:00:05Z" })).rejects.toThrow("top-level");
}, 30000);

test("update replay receipt cannot overwrite a later update", async () => {
 const h = await setup(); await h.message(h.bot, "owner", "register schedule");
 const row = (await h.bot.scheduler.list(h.owner.id))[0]!;
 await h.message(h.bot, "owner", "update schedule " + JSON.stringify({ id: row.id, text: "first" }));
 expect((await h.bot.scheduler.list(h.owner.id))[0]!.text).toBe("first");
 // A replay occurs while the original task remains live, not after its task-scoped documents expire.
 const pending = defineTask({ name: "test.scheduler-replay", version: 1, initial: () => ({ phase: "wait" as const }), phases: { wait: () => new Promise<void>(() => {}) }, abort: async (_task, runtime, ctx) => { await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx); } });
 const taskId = await h.bot.harness.commit(tx => tx.createTask(pending, {}, { conversationId: h.owner.id, ownership: { kind: "conversation" }, background: true }), context);
 await h.bot.scheduler.update(h.owner.id, row.id, { text: "first" }, taskId);
 await h.bot.scheduler.update(h.owner.id, row.id, { text: "second" });
 const replay = await h.bot.scheduler.update(h.owner.id, row.id, { text: "first" }, taskId);
 expect(replay.text).toBe("first"); expect((await h.bot.scheduler.list(h.owner.id))[0]!.text).toBe("second");
}, 30000);

test("real timer wakes and delivers the result to the origin channel without a manual tick", async () => {
 const h = await setup("direct", true); await h.message(h.bot);
 const delivered = Promise.withResolvers<{ thread: string; text: string }>();
 h.bot.attachChannel({ name: "tui", deliverHost(thread, reply) { delivered.resolve({ thread, text: reply.text }); return "admitted"; }, holdsAnswer() { return true; } });
 await h.bot.scheduler.create(h.owner.id, { key: "timer", text: "report", at: "2026-10-01T00:00:01Z" });
 h.clock.now += 2000;
 const deadline = setTimeout(() => delivered.reject(new Error("timer delivery timeout")), 5000);
 try { expect(await delivered.promise).toEqual({ thread: "owner", text: "SCHEDULED RESULT" }); } finally { clearTimeout(deadline); }
}, 10000);

test("AND condition waits for time; dependency and origin rotation never retarget scheduled work", async () => {
 const h = await setup(); await h.message(h.bot); await h.message(h.bot, "other"); await goal(h.bot, h.other.id, true);
 const row = await h.bot.scheduler.create(h.owner.id, { key: "both", text: "after", at: "2026-10-01T00:00:05Z", after_thread: "tui:other" });
 await h.bot.scheduler.tick(); expect((await h.bot.scheduler.list(h.owner.id))[0]!.state).toBe("pending");
 await rotateThread(h.bot.harness, h.bot.models, "tui:other", h.other.id, "rotate-other", context);
 h.clock.now += 6000; await h.bot.scheduler.tick();
 expect((await h.bot.scheduler.list(h.owner.id))[0]!.reason).toContain("rotated");
 await h.bot.scheduler.cancel(h.owner.id, row.id);
 const timed = await h.bot.scheduler.create(h.owner.id, { key: "origin", text: "never transfer", at: "2026-10-01T00:00:10Z" });
 await rotateThread(h.bot.harness, h.bot.models, "tui:owner", h.owner.id, "rotate-owner", context);
 h.clock.now += 5000; await h.bot.scheduler.tick();
 expect((await h.bot.scheduler.list(h.owner.id)).find(s => s.id === timed.id)!.state).toBe("failed");
}, 30000);

test("an error after goal achievement is not completion; scheduled turn errors are reported as failed", async () => {
 const h = await setup(); await h.message(h.bot); await h.message(h.bot, "other"); await goal(h.bot, h.other.id, true);
 const row = await h.bot.scheduler.create(h.owner.id, { key: "error-goal", text: "later", after_thread: "tui:other" });
 await h.message(h.bot, "other", "force error"); await h.bot.scheduler.tick();
 expect((await h.bot.scheduler.list(h.owner.id))[0]!.state).toBe("pending");
 expect(await h.bot.harness.commit(tx => completedWork(tx, row.condition!), context)).toContain("final answer");
 const bad = await h.bot.scheduler.create(h.owner.id, { key: "error-turn", text: "force error", at: "2026-10-01T00:00:01Z" });
 h.clock.now += 2000; await h.bot.scheduler.tick(); await settle(h.bot, h.owner.id, bad.id);
 expect((await h.bot.scheduler.list(h.owner.id)).find(s => s.id === bad.id)!.state).toBe("failed");
}, 30000);

test("fake admission failure retries; cancellation serializes with admission and never falsely succeeds", async () => {
 const h = await setup(); await h.message(h.bot);
 const scheduler = new Scheduler(() => h.bot.harness, context, () => h.clock.now); clean.push(() => scheduler.close());
 const row = await scheduler.create(h.owner.id, { key: "race", text: "later", at: "2026-10-01T00:00:01Z" });
 h.clock.now += 2000;
 let count = 0;
 scheduler.start(async (_request, ready) => { expect(await ready()).toBe(true); count++; if (count === 1) throw new Error("transient"); return "admitted"; }, async () => undefined, false);
 await scheduler.tick(); expect((await scheduler.list(h.owner.id))[0]!.state).toBe("pending");
 const tick = scheduler.tick(); const cancel = scheduler.cancel(h.owner.id, row.id);
 await tick; await expect(cancel).rejects.toThrow("Already admitted");
 expect(count).toBe(2);
}, 30000);
