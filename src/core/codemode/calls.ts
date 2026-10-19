import { copyJson, type Context, type JsonValue } from "@earendil-works/chord";
import { awaitWithContext } from "@earendil-works/chord/context";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import {
	defineDoc,
	defineDocFamily,
	defineTask,
	LiveDoc,
	ToolTask,
	UsageDoc,
	type JsonObject,
	type ConversationId,
	type TaskId,
	type ToolExecutionApi,
	type ToolExecutionResult,
	type ToolHooks,
	type ToolRegistration,
	type TaskRuntime,
	type Tx,
} from "@earendil-works/pi-durable";
import { detailPreview, safePreview } from "../../channels/safe-preview.ts";
import { encode, errorText } from "./protocol.ts";
import { ToolOutput } from "./output.ts";
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
export const CellDoc = defineDocFamily<{ calls: CallRecord[] }, null>({
	kind: "dinobot.codemode.cell",
	version: 1,
	family: true,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ calls: [] }),
});
/** Admission marker distinguishes a durable internal call from a model's direct call. */
export const InternalCallDoc = defineDoc<{ parent?: number }>({
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
	content: [{ type: "text", text: error }],
});
const jsonResult = (result: ToolExecutionResult): string => encode(copyJson(result, { omitUndefinedProperties: true }));
async function settle(
	runtime: Runtime,
	input: CallInput,
	result: ToolExecutionResult,
	context: Context,
	status: "done" | "failed" | "aborted" = "done",
) {
	await runtime.commit(async (tx) => {
		const doc = await tx.doc(CellDoc, runtime.conversationId, String(input.parent), null);
		let images: StoredImage[] = result.content?.filter((block) => block.type === "image")
			.map(({ mimeType, data }) => ({ type: "image", mimeType, data })) ?? [];
		const existing = doc.calls.filter((call) => call.ordinal !== input.ordinal).flatMap((call) => call.images ?? []);
		const all = [...existing, ...images];
		if (!imageAttachmentsFit(all)) {
			result = failedResult("Codemode image attachment limit exceeded; use a separate cell for more images");
			images = [];
			status = "failed";
		}
		let json: string;
		try {
			// Binary stays exclusively in the host receipt. Workers get small, printable attachment markers.
			json = jsonResult({
				...result,
				content: (result.content ?? []).map((block, index) => block.type === "image"
					? { type: "text", text: `[Image attached to model: call ${input.ordinal}, block ${index}, ${block.mimeType}]` }
					: block),
			});
		} catch (error) {
			result = failedResult(`Result could not be retained: ${errorText(error)}. Effects may have completed; inspect before retrying.`);
			json = jsonResult(result);
			images = [];
			status = "failed";
		}
		if (result.usage) {
			const totals = (await tx.doc(UsageDoc, runtime.conversationId)).tools;
			const previous = Object.hasOwn(totals, input.name) ? totals[input.name] : undefined;
			const usage = JSON.parse(JSON.stringify(result.usage)) as typeof result.usage;
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
	return (await runtime.agent(context)).tools.find((tool) => tool.name === name && tool.name !== "codemode");
}
async function hooks(runtime: Runtime, context: Context): Promise<Partial<ToolHooks>[]> {
	return (await runtime.agent(context)).extensions.flatMap((ext) =>
		(ext.hooks ?? []).filter((h) => h.task === ToolTask.definition.name).map((h) => h.handlers as Partial<ToolHooks>),
	);
}
async function run(runtime: Runtime, input: CallInput, tool: ToolRegistration, args: unknown, context: Context) {
	const output = new ToolOutput(tool.outputLimits);
	let details: JsonValue | undefined;
	const diagnostics: NonNullable<ToolExecutionResult["diagnostics"]>[number][] = [];
	const assertLive = () => {
		runtime.signal.throwIfAborted();
		context.abortSignal?.throwIfAborted();
	};
	const api: ToolExecutionApi = {
		taskId: runtime.taskId,
		conversationId: runtime.conversationId,
		callId: input.rootCallId,
		registry: runtime.registry,
		agent: runtime.agent,
		env: await runtime.env(context),
		snapshot: runtime.snapshot,
		snapshotAsOf: runtime.snapshotAsOf,
		watchDoc: runtime.watchDoc,
		memo: runtime.memo,
		getTask: runtime.getTask,
		waitForTask: runtime.waitForTask,
		conversation: runtime.conversation,
		output(chunk) {
			assertLive();
			output.push(chunk);
		},
		diagnostic(value) {
			assertLive();
			if (diagnostics.length >= 100) throw new Error("Too many diagnostics");
			diagnostics.push(value);
		},
		async details(value, ctx) {
			assertLive();
			const copy = JSON.parse(encode(value)) as JsonValue;
			await runtime.commit(async (tx) => {
				await update(tx, input, runtime.conversationId, {}, copy);
				return undefined;
			}, ctx);
			details = copy;
		},
		async commit(change, ctx) {
			let value: unknown;
			await runtime.commit(async (tx) => {
				value = await change(tx);
				return undefined;
			}, ctx);
			return value as never;
		},
		async createTask(task, value, options, ctx) {
			let id: TaskId | undefined;
			await runtime.commit(async (tx) => {
				id = await tx.createTask(task, value, options);
				return undefined;
			}, ctx);
			return id! as never;
		},
	};
	const call = {
		type: "toolCall" as const,
		id: `${input.rootCallId}/${input.ordinal}`,
		name: input.name,
		arguments: args as JsonObject,
	};
	let result: ToolExecutionResult;
	let status: "done" | "failed" = "done";
	try {
		result = await awaitWithContext(tool.execute(args, api, context), context);
		const retained = output.finish();
		if (retained.truncated) diagnostics.push({ severity: "info", code: "truncated", message: "Tool output truncated; inspect full_output diagnostics for the complete shell log." });
		result = {
			...result,
			content: result.content ?? (retained.text ? [{ type: "text", text: retained.text }] : []),
			...(result.details === undefined && details !== undefined ? { details } : {}),
			diagnostics: [...diagnostics, ...(result.diagnostics ?? [])],
		};
		for (const hook of await hooks(runtime, context))
			result =
				(await awaitWithContext(Promise.resolve(hook.afterTool?.(call, result, runtime, context)), context)) ?? result;
		if (result.control) throw new Error("Nested tool controls are unsupported; use the direct control tool");
	} catch (error) {
		assertLive();
		const retained = output.finish();
		result = {
			isError: true,
			content: [{ type: "text", text: [retained.text, errorText(error)].filter(Boolean).join("\n") }],
			...(details === undefined ? {} : { details }),
			diagnostics: [...diagnostics, ...(retained.truncated ? [{ severity: "info" as const, code: "truncated", message: "Tool output truncated" }] : [])],
		};
		status = "failed";
	}
	await settle(runtime, input, result, context, status);
}

/** Each nested call gets its own durable intent, memo namespace and ownership subtree. */
export const CapabilityTask = defineTask<CallInput, Phase, Result>({
	name: "dinobot.codemode.call",
	version: 1,
	initial: () => ({ phase: "call" }),
	phases: {
		call: async (task, runtime, context) => {
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
			if (task.state.checkpoint.replay === "safe" && tool?.replay === "safe")
				return run(runtime, task.input, tool, JSON.parse(task.state.checkpoint.args), context);
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
		await settle(
			runtime,
			task.input,
			failedResult("Tool aborted; effects may have partially completed"),
			context,
			"aborted",
		);
	},
});
