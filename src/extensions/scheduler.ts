import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import type { Scheduler } from "../core/scheduler.ts";

const output = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
export function schedulerExtension(scheduler: Scheduler) {
 return defineExtension({
  name: "scheduler",
  sections: [section("scheduling", () => "Use schedule_create only for an explicitly requested future task. It persists across daemon restarts and wakes this origin conversation; do not promise execution while the daemon is offline. Use an RFC3339 instant with offset, or after_thread for a pinned explicit goal achieved with evidence and settled successful work (not idle). Local TUI peers are allowed; messaging peers are not. Both conditions means AND. Inspect schedule_list for outcome. Cancellation is possible only before wake admission. Scheduling grants no new permissions for the future task.")],
  tools: [
   defineTool({ name: "schedule_create", description: "Persist a one-shot task that wakes this origin at a future time and/or after a named thread completes its current explicit goal. Same origin/key returns the existing record, including cancelled ones. Daemon must be running to execute; overdue schedules catch up on restart. No arbitrary target conversation.",
    parameters: Type.Object({ key: Type.String({ minLength: 1, maxLength: 120 }), text: Type.String({ minLength: 1, maxLength: 12000 }), at: Type.Optional(Type.String({ description: "RFC3339 with seconds and explicit offset, strictly future, at most 366 days" })), after_thread: Type.Optional(Type.String({ minLength: 1, maxLength: 500, description: "Exact thread key. Pins current goal identity; missing/abandoned/replaced goals fail closed." })) }, { additionalProperties: false }),
    replay: "safe", executionMode: "sequential",
    execute: async (args, api) => output(await scheduler.create(api.conversationId, args)),
   }),
   defineTool({ name: "schedule_list", description: "List this origin conversation's durable schedules, cancellation/admission state, blocking reason and completed turn result. completed means a final answer, not independent task success certification.", parameters: Type.Object({}, { additionalProperties: false }), replay: "safe",
    execute: async (_args, api) => output({ now: new Date().toISOString(), schedules: await scheduler.list(api.conversationId) }),
   }),
   defineTool({ name: "schedule_update", description: "Change the instruction or future time of a pending schedule in this origin. Completion dependency stays pinned; cancel and create a new key to replace it.", parameters: Type.Object({ id: Type.String({ pattern: "^sched_[a-f0-9]{32}$" }), text: Type.Optional(Type.String({ minLength: 1, maxLength: 12000 })), at: Type.Optional(Type.String()) }, { additionalProperties: false }), replay: "safe", executionMode: "sequential",
    execute: async ({ id, ...args }, api) => output(await scheduler.update(api.conversationId, id, args, api.taskId)),
   }),
   defineTool({ name: "schedule_cancel", description: "Cancel a pending schedule in this origin. Repeated cancellation is safe. Already admitted wakes cannot be retracted; reports an error rather than pretending to cancel.", parameters: Type.Object({ id: Type.String({ pattern: "^sched_[a-f0-9]{32}$" }) }, { additionalProperties: false }), replay: "safe", executionMode: "sequential",
    execute: async ({ id }, api) => output(await scheduler.cancel(api.conversationId, id)),
   }),
  ],
 });
}
