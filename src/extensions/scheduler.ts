import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import type { Scheduler } from "../core/scheduler.ts";

const atParameter = () => Type.String({ description: "RFC3339 with seconds and explicit offset, strictly future, at most 366 days" });
const textParameter = () => Type.String({ minLength: 1, maxLength: 12000, description: "Authorized instruction, at most 12000 UTF-8 bytes (not characters)" });
const output = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
export function schedulerExtension(scheduler: Scheduler) {
 return defineExtension({
  name: "scheduler",
  sections: [section("scheduling", () => "Only the top-level origin may manage schedules. Use schedule_create for a human-authorized one-shot future task, never self-recurring polling or a way to evade continuation. Set continue_goal:true only when the user explicitly deferred this active goal; unrelated reminders must leave it false. Report the actual receipt id, time/condition and state, not an assumed success. Records survive restarts, but never promise execution while the daemon/PC is offline. at requires an RFC3339 offset; after_thread pins an explicit achieved goal with evidence and settled successful work (not idle); together they mean AND. Only local TUI peers or the exact origin are allowed. Inspect schedule_list for outcome; cancellation stops only pre-admission work. Scheduling grants no new permissions.")],
  tools: [
   defineTool({ name: "schedule_create", description: "Top-level origin only: persist a human-authorized one-shot task that wakes this origin at a future time and/or after a named thread completes its current explicit goal. Same origin/key returns the existing record, including cancelled ones. Daemon must be running to execute; overdue schedules catch up on restart. No arbitrary target conversation.",
    parameters: Type.Object({ key: Type.String({ minLength: 1, maxLength: 120 }), text: textParameter(), at: Type.Optional(atParameter()), continue_goal: Type.Optional(Type.Boolean({ description: "Explicitly register the user-deferred current active goal for continuation; pins goal identity, not revision. Default false for reminders. Cannot wait on its own after_thread. Not a generic liveness bypass." })), after_thread: Type.Optional(Type.String({ minLength: 1, maxLength: 500, description: "Exact thread key. Pins current goal identity; missing/abandoned/replaced goals fail closed." })) }, { additionalProperties: false }),
    replay: "safe", executionMode: "sequential",
    execute: async (args, api) => output(await scheduler.create(api.conversationId, args)),
   }),
   defineTool({ name: "schedule_list", description: "Top-level origin only: list this conversation's durable schedules, cancellation/admission state, blocking reason and completed turn result. completed means a final answer, not independent task success certification.", parameters: Type.Object({}, { additionalProperties: false }), replay: "safe",
    execute: async (_args, api) => output({ now: new Date().toISOString(), schedules: await scheduler.list(api.conversationId) }),
   }),
   defineTool({ name: "schedule_update", description: "Top-level origin only: change the instruction or future time of a pending schedule in this origin. Completion dependency and continuation goal stay pinned; cancel and create a new key to replace it.", parameters: Type.Object({ id: Type.String({ pattern: "^sched_[a-f0-9]{32}$" }), text: Type.Optional(textParameter()), at: Type.Optional(atParameter()) }, { additionalProperties: false }), replay: "safe", executionMode: "sequential",
    execute: async ({ id, ...args }, api) => output(await scheduler.update(api.conversationId, id, args, api.taskId)),
   }),
   defineTool({ name: "schedule_cancel", description: "Top-level origin only: cancel a pending schedule in this origin. Repeated cancellation is safe. Already admitted wakes cannot be retracted; reports an error rather than pretending to cancel.", parameters: Type.Object({ id: Type.String({ pattern: "^sched_[a-f0-9]{32}$" }) }, { additionalProperties: false }), replay: "safe", executionMode: "sequential",
    execute: async ({ id }, api) => output(await scheduler.cancel(api.conversationId, id)),
   }),
  ],
 });
}
