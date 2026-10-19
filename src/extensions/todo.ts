import { Type } from "@earendil-works/pi-ai";
import { defineDoc, defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { TODO_TOOL, type TodoDetails } from "../core/ui-contract.ts";
import { clone } from "../core/json.ts";
import type { WorkService } from "../core/verification.ts";

export const TodoDoc = defineDoc<TodoDetails>({
	kind: "dinobot.todo",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ todos: [] }),
});

const ReceiptDoc = defineDoc<{ result?: { details: TodoDetails; error?: string } }>({
	kind: "dinobot.todo.receipt",
	version: 1,
	scope: "task",
	initial: () => ({}),
});

export function todoExtension(work: WorkService) {
	return defineExtension({
		name: TODO_TOOL,
		sections: [
			section("todo_guidance", () => "Use todo_write for any task with 3+ steps, coding work included: write the list before the first edit or command, keep exactly one item in_progress, and mark each item completed as soon as it is done. The user sees this list as your plan. If you also register work_plan, keep the todo list as the step-by-step view; todos never certify anything. Skip trivial single-step work. When codemode is available, call these built-in tools through tools.todo_write, tools.task, tools.task_output and tools.kill_task inside it; direct calls are for recovery/control."),
		],
		tools: [
			defineTool({
				name: TODO_TOOL,
				description: "Create and manage a structured progress list. Use for any task with 3+ steps; skip trivial single-step work. Merge partial updates by id; merge=false replaces the list. New ids require content. Optionally set workId to link a coding-work item. When verification is enforced (the default), completing a workId-linked item requires that work's current certificate; with enforcement off it is progress only. Ordinary progress subtasks need no workId. Clearing todos never clears verification obligations.",
				parameters: Type.Object({
					merge: Type.Optional(Type.Boolean()),
					todos: Type.Array(Type.Object({
						id: Type.String({ minLength: 1 }),
						content: Type.Optional(Type.String()),
						workId: Type.Optional(Type.String({ minLength: 1 })),
						status: Type.Optional(Type.Union([
							Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed"), Type.Literal("cancelled"),
						])),
					})),
				}),
				replay: "safe",
				executionMode: "sequential",
				execute: async ({ merge = true, todos }, api, context) => {
					if (todos.some((todo) => todo.status === "completed" || todo.workId !== undefined)) {
						await work.status(api.conversationId, context);
					}
					const result = await api.commit(async (tx) => {
						const receipt = await tx.doc(ReceiptDoc, api.taskId);
						if (receipt.result) return clone(receipt.result);
						const doc = await tx.doc(TodoDoc, api.conversationId);
						const next = merge ? clone(doc.todos) : [];
						let error: string | undefined;
						if (merge && todos.length === 0) error = "merge=true requires at least one todo.";
						else if (new Set(todos.map((todo) => todo.id)).size !== todos.length) error = "Duplicate todo ids are not allowed.";
						else {
							for (const update of todos) {
								const existing = next.find((todo) => todo.id === update.id);
								if (existing) {
									if (existing.workId !== undefined && update.workId !== undefined && existing.workId !== update.workId) {
										error = `Todo "${update.id}" cannot change its linked work.`;
										break;
									}
									if (update.content !== undefined) existing.content = update.content;
									if (update.status !== undefined) existing.status = update.status;
									if (update.workId !== undefined) existing.workId = update.workId;
								} else {
									if (!update.content?.trim()) {
										error = `New todo "${update.id}" requires content.`;
										break;
									}
									next.push({
										id: update.id, content: update.content, status: update.status ?? "pending",
										...(update.workId === undefined ? {} : { workId: update.workId }),
									});
								}
								const changed = next.find((todo) => todo.id === update.id)!;
								if (changed.status === "completed" && changed.workId !== undefined) {
									try {
										await work.assertTodoCompletion(tx, api.conversationId, changed.workId);
									} catch (failure) {
										error = failure instanceof Error ? failure.message : String(failure);
										break;
									}
								}
							}
						}
						if (!error) doc.todos = next;
						receipt.result = { details: { todos: clone(doc.todos) }, ...(error ? { error } : {}) };
						return clone(receipt.result);
					}, context);
					return {
						details: result.details,
						isError: result.error !== undefined,
						content: [{
							type: "text",
							text: result.error ?? (result.details.todos.map((todo) => `- [${todo.status}] ${todo.id}: ${todo.content}`).join("\n") || "No tasks currently tracked."),
						}],
					};
				},
			}),
		],
	});
}
