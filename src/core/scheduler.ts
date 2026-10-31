import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { defineDoc, InboxDoc, LiveDoc, type ConversationId, type Harness, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { AsksDoc, LinkDoc } from "./ask.ts";
import { RunDoc } from "./dag.ts";
import { GoalDoc } from "./goal.ts";
import { listThreads } from "./threads.ts";
import { AgentsDoc, ProgressDoc, PLUGIN_WAKE_REQUEST_PREFIX } from "../extensions/subagents.ts";
import { TodoDoc } from "../extensions/todo.ts";
import type { PluginWake, PluginWakeResult } from "../plugins/types.ts";

export type ScheduleCondition = { thread: string; conversationId: number; goalCreatedAt: number; objective: string };
export type Schedule = {
 id: string; owner: number; key: string; text: string; at: number; createdAt: number;
 condition?: ScheduleCondition;
 continuationGoal?: { createdAt: number; objective: string };
 state: "pending" | "admitted" | "completed" | "failed" | "cancelled";
 reason?: string; admittedAt?: number; result?: string;
};
export const SchedulesDoc = defineDoc<{ schedules: Schedule[] }>({
 kind: "dinobot.schedules", version: 1, scope: "session", initial: () => ({ schedules: [] }),
});
const UpdateReceipt = defineDoc<{ result?: Schedule }>({ kind: "dinobot.schedule.update", version: 1, scope: "task", initial: () => ({}) });
export type ScheduleInput = { key: string; text: string; at?: string; after_thread?: string; continue_goal?: boolean };
export type ScheduleWake = (request: PluginWake, ready: () => Promise<boolean>) => Promise<PluginWakeResult>;
export type ScheduleResult = (schedule: Schedule) => Promise<{ state: "completed" | "failed"; result: string } | undefined>;
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export const scheduleSubmission = (harness: Harness, schedule: Schedule, context: Context) => harness.commit(tx =>
 tx.submissionByRequest(schedule.owner as ConversationId, PLUGIN_WAKE_REQUEST_PREFIX + "scheduler:" + schedule.id), context);

/** Require an explicit instant: no guessed local zone, rollover dates, past dates or unbounded timers. */
export function scheduleTime(value: string | undefined, now: number, conditional: boolean): number {
 if (value === undefined) { if (conditional) return now; throw new Error("at or after_thread is required"); }
 if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:[.][0-9]{1,3})?(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(value)) throw new Error("at must be RFC3339 with seconds and an explicit offset");
 if (Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) throw new Error("invalid clock time");
 const ms = Date.parse(value);
 const date = value.slice(0, 10);
 const midnight = Date.parse(date + "T00:00:00Z");
 if (!Number.isFinite(ms) || !Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== date || ms <= now || ms > now + 366 * 86400000) throw new Error("at must be a valid future instant within 366 days");
 return ms;
}

/** Explicit completion, not idle. Unknown children and non-success terminal states fail closed. */
export async function completedWork(tx: Tx, condition: ScheduleCondition): Promise<string | undefined> {
 const id = condition.conversationId as ConversationId;
 const goal = (await tx.doc(GoalDoc, id)).goal;
 if (!goal || goal.createdAt !== condition.goalCreatedAt || goal.objective !== condition.objective) return "goal missing or replaced";
 if (goal.status !== "achieved" || goal.criteria.length === 0 || goal.criteria.some(c => c.status !== "met" || !c.evidence)) return "goal not achieved with evidence";
 const visited = new Set<number>();
 const check = async (current: ConversationId): Promise<string | undefined> => {
  if (visited.has(current) || visited.size >= 256) return "invalid or oversized descendant graph";
  visited.add(current);
  if (!await tx.conversation(current)) return "conversation missing";
  const live = await tx.doc(LiveDoc, current);
  if (live.run || live.generation || live.tools?.some(t => t.status !== "done") || live.compactions?.length) return "work running";
  if ((await tx.doc(InboxDoc, current)).items.length) return "queued input";
  if ((await tx.doc(AsksDoc, current)).asks.some(a => a.state === "open")) return "open question";
  if ((await tx.doc(RunDoc, current)).runs.some(r => r.status !== "verified")) return "DAG not verified";
  if ((await tx.doc(TodoDoc, current)).todos.some(t => t.status !== "completed")) return "unfinished or cancelled TODO";
  // An aborted/error final is not a completed turn, even if the goal was marked achieved before the failure.
  const last = (await tx.scanEntries({ conversationId: current }, 1)).items[0];
  if (!last?.model?.some(m => m.role === "assistant" && m.stopReason === "stop")) return "no successful final answer";
  for (const ref of (await tx.doc(AgentsDoc, current)).agents) {
   const progress = (await tx.doc(ProgressDoc, current, String(ref.runnerId), null)).subagent;
   if (progress?.status !== "completed") return "descendant not completed";
   const reason = await check(ref.conversationId);
   if (reason) return reason;
  }
  return undefined;
 };
 return check(id);
}

/** Host-owned durable records, reusing calendar wake admission/dedup/channel delivery (ADR 0106).
 * One service serializes mutation and admission; cancellation wins before admission or reports too late.
 * The persisted record remains pending until wake acknowledges. Retrying after a crash uses the same key.
 */
export class Scheduler {
 readonly #harness: () => Harness;
 readonly #context: Context;
 readonly #now: () => number;
 #wake: ScheduleWake | undefined;
 #result: ScheduleResult | undefined;
 #timer: ReturnType<typeof setTimeout> | undefined;
 #line: Promise<unknown> = Promise.resolve();
 #closed = false;
 constructor(harness: () => Harness, context: Context, now = Date.now) { this.#harness = harness; this.#context = context; this.#now = now; }
 #serial<T>(run: () => Promise<T>): Promise<T> {
  const next = this.#line.then(run); this.#line = next.catch(() => undefined); return next;
 }
 async #owner(owner: ConversationId): Promise<void> {
  if ((await this.#harness().snapshot(LinkDoc, owner, this.#context))?.parent !== undefined) throw new Error("Schedules must be managed by their top-level origin conversation");
  if (!await this.#harness().conversation(owner, this.#context)) throw new Error("Origin conversation missing");
 }
 async #condition(owner: ConversationId, thread: string): Promise<ScheduleCondition> {
  const threads = await listThreads(this.#harness(), this.#context);
  const target = threads[thread];
  // Local TUI threads share the authenticated local operator. Messaging identities are NOT inferred from a
  // channel name or cwd: until a common principal API exists, only the exact origin is authorized there.
  const localOwner = Object.entries(threads).some(([key, id]) => id === owner && key.startsWith("tui:") && !key.includes("#"));
  if (target === undefined || thread.includes("#") || (target !== owner && !(localOwner && thread.startsWith("tui:")))) throw new Error("Unknown or unauthorized dependency thread");
  const goal = (await this.#harness().snapshot(GoalDoc, target, this.#context))?.goal;
  if (!goal || goal.status === "abandoned") throw new Error("Dependency requires an explicit non-abandoned goal");
  return { thread, conversationId: target, goalCreatedAt: goal.createdAt, objective: goal.objective };
 }
 create(owner: ConversationId, input: ScheduleInput): Promise<Schedule> {
  return this.#serial(async () => {
   await this.#owner(owner);
   if (!input.key.trim() || input.key.length > 120 || !input.text.trim() || Buffer.byteLength(input.text) > 12000) throw new Error("key/text empty or too long");
   const id = "sched_" + createHash("sha256").update(JSON.stringify([owner, input.key])).digest("hex").slice(0, 32);
   const existing = (await this.#harness().snapshot(SchedulesDoc, this.#context))?.schedules.find(s => s.id === id);
   if (existing) return copy(existing); // replay never revives or alters a cancelled/admitted schedule
   const at = scheduleTime(input.at, this.#now(), input.after_thread !== undefined);
   const condition = input.after_thread === undefined ? undefined : await this.#condition(owner, input.after_thread);
   return this.#harness().commit(async tx => {
    const doc = await tx.doc(SchedulesDoc);
    if (doc.schedules.filter(s => s.owner === owner).length >= 500) throw new Error("Schedule history limit reached (500 per origin)");
    const goal = input.continue_goal ? (await tx.doc(GoalDoc, owner)).goal : undefined;
    if (input.continue_goal && goal?.status !== "active") throw new Error("continue_goal requires an active origin goal");
    if (input.continue_goal && condition?.conversationId === owner) throw new Error("A goal continuation cannot wait for its own goal to complete");
    const row: Schedule = { id, owner, key: input.key, text: input.text, at, createdAt: this.#now(), state: "pending", ...(condition ? { condition } : {}),
     ...(goal ? { continuationGoal: { createdAt: goal.createdAt, objective: goal.objective } } : {}) };
    doc.schedules.push(row); return copy(row);
   }, this.#context);
  });
 }
 update(owner: ConversationId, id: string, input: { text?: string; at?: string }, taskId?: TaskId): Promise<Schedule> {
  return this.#serial(async () => {
   await this.#owner(owner);
   const receipt = taskId === undefined ? undefined : (await this.#harness().snapshot(UpdateReceipt, taskId, this.#context))?.result;
   if (receipt) return copy(receipt);
   await this.#checkAdmission(owner, id);
   if (input.text !== undefined && (!input.text.trim() || Buffer.byteLength(input.text) > 12000)) throw new Error("text empty or too long");
   const at = input.at === undefined ? undefined : scheduleTime(input.at, this.#now(), false);
   return this.#harness().commit(async tx => {
    const row = (await tx.doc(SchedulesDoc)).schedules.find(s => s.owner === owner && s.id === id);
    if (!row) throw new Error("Unknown schedule in this origin conversation");
    if (row.state !== "pending") throw new Error("Only pending schedules can be updated");
    if (input.text !== undefined) row.text = input.text;
    if (at !== undefined) row.at = at;
    if (taskId !== undefined) (await tx.doc(UpdateReceipt, taskId)).result = copy(row);
    return copy(row);
   }, this.#context);
  });
 }
 async list(owner: ConversationId): Promise<Schedule[]> {
  await this.#owner(owner);
  return copy((await this.#harness().snapshot(SchedulesDoc, this.#context))?.schedules.filter(s => s.owner === owner) ?? []);
 }
 cancel(owner: ConversationId, id: string): Promise<Schedule> {
  return this.#serial(async () => {
   await this.#owner(owner);
   await this.#checkAdmission(owner, id);
   return this.#harness().commit(async tx => {
    const row = (await tx.doc(SchedulesDoc)).schedules.find(s => s.id === id && s.owner === owner);
    if (!row) throw new Error("Unknown schedule in this origin conversation");
    if (row.state === "pending") { row.state = "cancelled"; row.reason = "cancelled before admission"; }
    else if (row.state !== "cancelled") throw new Error("Already admitted; cancellation cannot retract a started turn");
    return copy(row);
   }, this.#context);
  });
 }
 async #checkAdmission(owner: ConversationId, id: string): Promise<void> {
  const row = (await this.#harness().snapshot(SchedulesDoc, this.#context))?.schedules.find(s => s.owner === owner && s.id === id);
  if (row?.state === "pending" && await scheduleSubmission(this.#harness(), row, this.#context)) {
   await this.#change(id, { state: "admitted", reason: "recovered durable wake admission" });
   throw new Error("Already admitted; cancellation/update cannot retract a started turn");
  }
 }
 start(wake: ScheduleWake, result: ScheduleResult, timers = true): void {
  this.#wake = wake; this.#result = result;
  if (timers) {
   const run = () => { void this.tick().catch(e => console.error("scheduler tick failed", e)).finally(() => {
    if (!this.#closed) { this.#timer = setTimeout(run, 1000); this.#timer.unref?.(); }
   }); };
   run();
  }
 }
 tick(): Promise<void> {
  return this.#serial(async () => {
   if (this.#closed || !this.#wake) return;
   const rows = (await this.#harness().snapshot(SchedulesDoc, this.#context))?.schedules ?? [];
   for (const row of rows) {
    if (this.#closed) break;
    if (row.state === "admitted") {
     const result = await this.#result?.(row);
     if (result) await this.#change(row.id, result);
     continue;
    }
    if (row.state !== "pending" || row.at > this.#now()) continue;
    const ready = async () => {
     if (this.#closed) return false;
     if (row.condition && (await listThreads(this.#harness(), this.#context))[row.condition.thread] !== row.condition.conversationId) {
      await this.#change(row.id, { reason: "dependency thread missing or rotated" }); return false;
     }
     return this.#harness().commit(async tx => {
      const current = (await tx.doc(SchedulesDoc)).schedules.find(s => s.id === row.id);
      if (!current || current.state !== "pending" || current.at > this.#now()) return false;
      const reason = current.condition ? await completedWork(tx, current.condition) : undefined;
      if (reason) current.reason = reason; else delete current.reason;
      return reason === undefined;
     }, this.#context);
    };
    try {
     const result = await this.#wake({ conversationId: String(row.owner), key: row.id,
      text: "Scheduled task " + row.id + ". Execute only the authorized request below, then report the actual result in this conversation. A completion condition is host-observed goal/turn settlement, not independent certification.\n" + row.text }, ready);
     if (result === "admitted" || result === "duplicate") await this.#change(row.id, { state: "admitted", admittedAt: this.#now(), reason: "wake admitted; task outcome not yet known" });
     else if (result === "gone") await this.#change(row.id, { state: "failed", reason: "origin conversation gone" });
    } catch (e) { await this.#change(row.id, { reason: "admission deferred: " + (e instanceof Error ? e.message : String(e)).slice(0, 300) }); }
   }
  });
 }
 async #change(id: string, patch: Partial<Schedule>): Promise<void> {
  await this.#harness().commit(async tx => {
   const row = (await tx.doc(SchedulesDoc)).schedules.find(s => s.id === id);
   if (row) Object.assign(row, patch);
  }, this.#context);
 }
 async close(): Promise<void> { this.#closed = true; if (this.#timer) clearTimeout(this.#timer); await this.#line; }
}
