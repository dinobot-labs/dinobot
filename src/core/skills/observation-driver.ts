import type { Context } from "@earendil-works/chord";
import { defineDoc, defineTask, type Cursor, type Harness, type TaskId } from "@earendil-works/pi-durable";
import type { SkillObservationProjector } from "./observation.ts";

export const SkillObservationDriverDoc = defineDoc<{ taskId: TaskId | null; error: string | null }>({
	kind: "dinobot.skill-observation-driver", version: 1, scope: "session",
	initial: () => ({ taskId: null, error: null }),
});

/** Durable host work; observations never run inside the main tool/answer path. */
export function createSkillObservationDriver(getProjector: () => SkillObservationProjector, getHarness: () => Harness) {
	const task = defineTask<null, { phase: "scan"; cursor: Cursor | null } | { phase: "sleep"; until: number }, null>({
		name: "dinobot.skill-observation-projector", version: 1,
		initial: () => ({ phase: "scan", cursor: null }),
		phases: {
			scan: async (record, runtime, context) => {
				const page = await getHarness().commit((tx) => tx.scanConversations({}, 32, record.state.checkpoint.cursor ?? undefined), context);
				for (const conversation of page.items) {
					if (conversation.id === runtime.conversationId) continue;
					const result = await getProjector().catchUp(conversation.id, context);
					if (!result.ok) {
						await runtime.commit(async (tx) => {
							(await tx.doc(SkillObservationDriverDoc)).error = result.error;
							return { status: "terminal", outcome: { status: "completed", result: null } };
						}, context);
						return;
					}
				}
				await runtime.commit(() => ({
					status: "running",
					checkpoint: page.next ? { phase: "scan", cursor: page.next } : { phase: "sleep", until: runtime.now() + 1000 },
				}), context);
			},
			sleep: async (record, runtime, context) => {
				await runtime.sleep(record.state.checkpoint.until, context);
				await runtime.commit(() => ({ status: "running", checkpoint: { phase: "scan", cursor: null } }), context);
			},
		},
		abort: async (_record, runtime, context) => {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
		},
	});
	return {
		task,
		async start(harness: Harness, context: Context) {
			return harness.commit(async (tx) => {
				const doc = await tx.doc(SkillObservationDriverDoc);
				if (doc.taskId) {
					const existing = await tx.task(doc.taskId);
					if (existing && existing.state.status !== "terminal") return doc.taskId;
				}
				const owner = await tx.createConversation({ ownership: { kind: "ownerless" } });
				const id = await tx.createTask(task, null, {
					conversationId: owner.id, ownership: { kind: "conversation" }, background: true,
				});
				doc.taskId = id;
				doc.error = null;
				return id;
			}, context);
		},
	};
}
