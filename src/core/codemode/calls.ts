import { checkpointEvery256 } from "../document-policy.ts";
import { copyJson, type Context, type JsonValue } from "@earendil-works/chord";
import { awaitWithContext } from "@earendil-works/chord/context";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import {
	AssistantEntry,
	defineDoc,
	defineDocFamily,
	defineTask,
	LiveDoc,
	ToolTask,
	UsageDoc,
	type JsonObject,
	type ConversationId,
	type EntryId,
	type TaskId,
	type ToolExecutionResult,
	type ToolHooks,
	type ToolRegistration,
	type TaskRuntime,
	type Tx,
} from "@earendil-works/pi-durable";
import { detailPreview, safePreview } from "../../channels/safe-preview.ts";
import { encode, errorText } from "./protocol.ts";
import { createTaskToolInvocation, settleHostNestedCalls, workerToolResult, type WorkerToolResult } from "../tool-execution.ts";
import { checkedToolResult, imageMarkers } from "./result.ts";
import { imageAttachmentsFit } from "../../extensions/images.ts";

export type CallInput = { parent: TaskId; rootCallId: string; ordinal: number; name: string; args: string };
type Phase = { phase: "call" } | { phase: "execute"; args: string; replay: "safe" | "unsafe" };
type Result = { json: string };
type Runtime = TaskRuntime<CallInput, Phase, Result, object>;
/** Explicit JSON shape: upstream ImageContent is an open interface, not a durable JSON type. */
type StoredImage = { type: "image"; mimeType: string; data: string };
export type CallRecord = {
	id: number;
	ordinal: number;
	name: string;
	status: "pending" | "running" | "done" | "failed" | "aborted";
	error?: string;
	preview?: string;
	/** Best-effort redacted argument line for detailed progress cards (ADR 0057). */
	detail?: string;
	startedAt?: number;
	endedAt?: number;
	result?: string;
	images?: StoredImage[];
};
export const CellDoc = defineDocFamily<{ calls: CallRecord[] }, null>({ checkpointWhen: checkpointEvery256,
	kind: "dinobot.codemode.cell",
	version: 1,
	family: true,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ calls: [] }),
});
/** Admission marker distinguishes a durable internal call from a model's direct call. */
export const InternalCallDoc = defineDoc<{ parent?: number }>({ checkpointWhen: checkpointEvery256,
	kind: "dinobot.codemode.internal",
	version: 1,
	scope: "task",
	initial: () => ({}),
});

async function update(
	tx: Tx,
	input: CallInput,
	conversationId: ConversationId,
	patch: Partial<CallRecord>,
	details?: JsonValue,
) {
	const doc = await tx.doc(CellDoc, conversationId, String(input.parent), null);
	const call = doc.calls.find((call) => call.ordinal === input.ordinal);
	if (!call) throw new Error("Missing codemode admission");
	Object.assign(call, patch);
	const live = await tx.doc(LiveDoc, conversationId);
	const slot = live.tools?.find((slot) => slot.taskId === input.parent);
	if (slot) {
		const old =
			typeof slot.details === "object" && slot.details !== null && !Array.isArray(slot.details) ? slot.details : {};
		const more =
			typeof details === "object" && details !== null && !Array.isArray(details)
				? input.name === "todo_write" && Array.isArray(details.todos)
					? { todos: details.todos }
					: input.name === "task" && details.subagent
						? { subagent: details.subagent }
						: (input.name === "task_output" || input.name === "kill_task") && Array.isArray(details.subagents)
							? { subagents: details.subagents }
							: {}
				: {};
		// Small progress only. Full results belong in the durable call receipt, not every UI update.
		slot.details = {
			...old,
			...more,
			codemodeCalls: doc.calls.map(({ id, name, status, error, preview, detail, startedAt, endedAt }) => ({
				id,
				name,
				status,
				...(preview ? { preview } : {}),
				...(detail ? { detail } : {}),
				...(startedAt !== undefined ? { startedAt } : {}),
				...(endedAt !== undefined ? { endedAt } : {}),
				...(error ? { error } : {}),
			})),
		};
	}
}
const failedResult = (error: string): ToolExecutionResult => ({
	isError: true,
	output: [{ type: "text", text: error }],
});
const jsonResult = (result: WorkerToolResult): string => encode(copyJson(result, { omitUndefinedProperties: true }));
async function settle(
	runtime: Runtime,
	input: CallInput,
	executionResult: ToolExecutionResult,
	context: Context,
	status: "done" | "failed" | "aborted" = "done",
) {
	let result = workerToolResult(executionResult);
	await runtime.commit(async (tx) => {
		const doc = await tx.doc(CellDoc, runtime.conversationId, String(input.parent), null);
		let images: StoredImage[] = result.content?.filter((block) => block.type === "image")
			.map(({ mimeType, data }) => ({ type: "image", mimeType, data })) ?? [];
		const existing = doc.calls.filter((call) => call.ordinal !== input.ordinal).flatMap((call) => call.images ?? []);
		const all = [...existing, ...images];
		if (!imageAttachmentsFit(all)) {
			result = workerToolResult(failedResult("Codemode image attachment limit exceeded; use a separate cell for more images"));
			images = [];
			status = "failed";
		}
		let json: string;
		try {
			// Binary stays exclusively in the host receipt. Workers get small, printable attachment markers.
			json = jsonResult({
				...result,
				...(result.structuredOutput === undefined ? {} : { structuredOutput: imageMarkers(result.structuredOutput, input.ordinal) }),
				content: (result.content ?? []).map((block, index) => block.type === "image"
					? { type: "text", text: `[Image attached to model: call ${input.ordinal}, block ${index}, ${block.mimeType}]` }
					: block),
			});
		} catch (error) {
			result = workerToolResult(failedResult(`Result could not be retained: ${errorText(error)}. Effects may have completed; inspect before retrying.`));
			json = jsonResult(result);
			images = [];
			status = "failed";
		}
		// Receipt admission may replace presentation, but cannot undo incurred usage.
		// Charge only this execution; nested ToolTask usage remains owned by pi.tool.
		if (executionResult.usage) {
			const totals = (await tx.doc(UsageDoc, runtime.conversationId)).tools;
			const previous = Object.hasOwn(totals, input.name) ? totals[input.name] : undefined;
			const usage = JSON.parse(JSON.stringify(executionResult.usage)) as typeof executionResult.usage;
			if (previous) {
				for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const)
					usage[key] += previous[key];
				for (const key of ["reasoning", "cacheWrite1h"] as const)
					if (usage[key] !== undefined || previous[key] !== undefined)
						usage[key] = (usage[key] ?? 0) + (previous[key] ?? 0);
				for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const)
					usage.cost[key] += previous.cost[key];
			}
			totals[input.name] = usage;
		}
		await update(
			tx,
			input,
			runtime.conversationId,
			{
				status,
				endedAt: Date.now(),
				result: json,
				images,
				...(result.isError
					? {
							error: errorText(
								result.content
									?.filter((b) => b.type === "text")
									.map((b) => b.text)
									.join("\n") || "Tool error",
							),
						}
					: {}),
			},
			result.details,
		);
		if (status === "aborted") return { status: "terminal", outcome: { status: "aborted", result: { json } } };
		if (status === "failed")
			return {
				status: "terminal",
				outcome: { status: "failed", error: { message: "Internal tool failed" }, result: { json } },
			};
		return { status: "terminal", outcome: { status: "completed", result: { json } } };
	}, context);
}
async function toolFor(runtime: Runtime, name: string, context: Context) {
	return (await runtime.agent(context)).callable.find((tool) => tool.name === name && tool.name !== "codemode");
}
async function hooks(runtime: Runtime, context: Context): Promise<Partial<ToolHooks>[]> {
	return (await runtime.agent(context)).extensions.flatMap((ext) =>
		(ext.hooks ?? []).filter((h) => h.task === ToolTask.definition.name).map((h) => h.handlers as Partial<ToolHooks>),
	);
}
async function run(runtime: Runtime, input: CallInput, tool: ToolRegistration, args: unknown, context: Context) {
	const invocation = await createTaskToolInvocation(runtime, `${input.rootCallId}/${input.ordinal}`, tool, context, (tx, details) => update(tx, input, runtime.conversationId, {}, details));
	const { api, output, diagnostics } = invocation;
	const assertLive = () => { runtime.signal.throwIfAborted(); context.abortSignal?.throwIfAborted(); };
	const call = {
		type: "toolCall" as const,
		id: `${input.rootCallId}/${input.ordinal}`,
		name: input.name,
		arguments: args as JsonObject,
	};
	let result: ToolExecutionResult;
	let status: "done" | "failed" = "done";
	try {
		try { result = await awaitWithContext(tool.execute(args, api, context), context); }
		finally { await invocation.close(); }
		const retained = output.finish();
		if (retained.truncated) diagnostics.push({ severity: "info", code: "truncated", message: "Tool output truncated; inspect full_output diagnostics for the complete shell log." });
		result = {
			...result,
			output: result.output ?? (retained.text ? [{ type: "text", text: retained.text }] : []),
			...(result.details === undefined && invocation.details !== undefined ? { details: invocation.details } : {}),
			diagnostics: [...diagnostics, ...(result.diagnostics ?? [])],
		};
		for (const hook of await hooks(runtime, context))
			result =
				(await awaitWithContext(Promise.resolve(hook.afterTool?.(call, result, runtime, context)), context)) ?? result;
		result = checkedToolResult(tool, result);
		if (result.control) throw new Error("Nested tool controls are unsupported; use the direct control tool");
	} catch (error) {
		assertLive();
		const retained = output.finish();
		result = {
			isError: true,
			output: [{ type: "text", text: [retained.text, errorText(error)].filter(Boolean).join("\n") }],
			...(invocation.details === undefined ? {} : { details: invocation.details }),
			diagnostics: [...diagnostics, ...(retained.truncated ? [{ severity: "info" as const, code: "truncated", message: "Tool output truncated" }] : [])],
		};
		status = "failed";
	}
	await settle(runtime, input, result, context, status);
}

/** Older cells admitted children without abandonOnRestart. Their unsafe waiter must not restart a safe tool body. */
async function interruptedCell(runtime: Runtime, input: CallInput, restarted: boolean, context: Context): Promise<boolean> {
	const parent = await runtime.getTask(input.parent, context);
	if (parent?.kind !== ToolTask.definition.name) return false;
	const checkpoint = parent.state.checkpoint;
	const ended = parent.state.status === "completing" || parent.state.status === "terminal";
	if (!ended && (!(restarted || (parent.restarts ?? 0) > 0) || !checkpoint || typeof checkpoint !== "object"
		|| Array.isArray(checkpoint) || checkpoint.phase !== "execute" || checkpoint.replay !== "unsafe")) return false;
	const call = parent.input;
	if (!call || typeof call !== "object" || Array.isArray(call) || (call.kind !== undefined && call.kind !== "model")
		|| typeof call.assistant !== "number" || typeof call.callId !== "string") return false;
	const message = (await runtime.entry(AssistantEntry, call.assistant as EntryId, context))?.model?.[0];
	return message?.role === "assistant" && message.content.some(part =>
		part.type === "toolCall" && part.id === call.callId && part.name === "codemode");
}

/** Each nested call gets its own durable intent, memo namespace and ownership subtree. */
export const CapabilityTask = defineTask<CallInput, Phase, Result>({
	name: "dinobot.codemode.call",
	version: 1,
	initial: () => ({ phase: "call" }),
	phases: {
		call: async (task, runtime, context) => {
			if (await interruptedCell(runtime, task.input, (task.restarts ?? 0) > 0, context)) {
				await settleHostNestedCalls(runtime, context);
				return settle(runtime, task.input, failedResult("Interrupted cell did not start this tool; it was not retried"), context, "failed");
			}
			const tool = await toolFor(runtime, task.input.name, context);
			if (!tool)
				return settle(
					runtime,
					task.input,
					failedResult("Tool is not available in this conversation"),
					context,
					"failed",
				);
			let args: unknown;
			try {
				args = JSON.parse(task.input.args);
				if (tool.prepareArguments) args = tool.prepareArguments(args);
				const call = {
					type: "toolCall" as const,
					id: `${task.input.rootCallId}/${task.input.ordinal}`,
					name: tool.name,
					arguments: args as JsonObject,
				};
				args = validateToolArguments(tool, call);
				for (const hook of await hooks(runtime, context)) {
					const decision = await awaitWithContext(
						Promise.resolve(hook.beforeTool?.({ ...call, arguments: args as JsonObject }, runtime, context)),
						context,
					);
					if (decision?.block !== undefined) throw new Error(`Tool call blocked: ${decision.block}`);
					if (decision?.arguments !== undefined) args = decision.arguments;
				}
				args = validateToolArguments(tool, { ...call, arguments: args as JsonObject });
			} catch (error) {
				runtime.signal.throwIfAborted();
				return settle(runtime, task.input, failedResult(`${errorText(error)}\nInspect tool_search({query: ${JSON.stringify(task.input.name)}}) for this conversation’s exact contract before retrying. No tool body was executed by this attempt.`), context, "failed");
			}
			const json = encode(args);
			await runtime.commit(async (tx) => {
				await update(tx, task.input, runtime.conversationId, { status: "running", startedAt: Date.now(), ...(safePreview(args) ? { preview: safePreview(args)! } : {}), ...(detailPreview(args) ? { detail: detailPreview(args)! } : {}) });
				return { status: "running", checkpoint: { phase: "execute", args: json, replay: tool.replay ?? "unsafe" } };
			}, context);
			await run(runtime, task.input, tool, args, context);
		},
		execute: async (task, runtime, context) => {
			const tool = await toolFor(runtime, task.input.name, context);
			if (task.state.checkpoint.replay === "safe" && tool?.replay === "safe"
				&& !await interruptedCell(runtime, task.input, (task.restarts ?? 0) > 0, context))
				return run(runtime, task.input, tool, JSON.parse(task.state.checkpoint.args), context);
			await settleHostNestedCalls(runtime, context);
			await settle(
				runtime,
				task.input,
				failedResult("Interrupted tool may have partially run; it was not retried"),
				context,
				"failed",
			);
		},
	},
	abort: async (task, runtime, context) => {
		await settleHostNestedCalls(runtime, context);
		await settle(
			runtime,
			task.input,
			failedResult("Tool aborted; effects may have partially completed"),
			context,
			"aborted",
		);
	},
});
