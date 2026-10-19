import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { BASH_BUDGET, checkBashTimeout } from "./bash-budget.ts";
import { defineExtension, defineTool, section, LiveDoc, type Harness, type TaskId, type ToolRegistration, type JsonObject } from "@earendil-works/pi-durable";
import { repairArguments } from "../core/argument-repair.ts";
import { compactSchema } from "../core/schema-compact.ts";
import { CapabilityTask, CellDoc, InternalCallDoc } from "../core/codemode/calls.ts";
import { CODEMODE_LIMITS, encode, errorText } from "../core/codemode/protocol.ts";
import { runCell } from "../core/codemode/worker.ts";
import { TASK_OUTPUT_TOOL } from "../core/ui-contract.ts";

/** Time kept for the result to travel back before the cell limit cuts the worker. */
const WAIT_MARGIN_MS = 3_000;
/** Room a long-running call keeps past its own declared run time: admission commit, result encoding and return. */
export const LONG_CALL_MARGIN_MS = 15_000;
const TASK_OUTPUT_DEFAULT_TIMEOUT_MS = 120_000;

/**
 * A blocking task_output inside a cell waits at most until WAIT_MARGIN_MS before the cell deadline: the worker is cut at
 * the limit and a cut call returns nothing, so a longer wait would lose the collected answers. Other calls are unchanged.
 */
export function clampCellWait(name: string, args: unknown, deadlineAt: number, now: number): unknown {
	if (name !== TASK_OUTPUT_TOOL || args === null || typeof args !== "object" || Array.isArray(args)) return args;
	const wait = args as { block?: unknown; timeout_ms?: unknown };
	if (wait.block === false || wait.block === "false") return args;
	// Read the value the schema coercion will see ("5000" → 5000); leave anything unparsable to argument validation.
	const asked = wait.timeout_ms === undefined ? TASK_OUTPUT_DEFAULT_TIMEOUT_MS : Number(wait.timeout_ms);
	if (!Number.isFinite(asked)) return args;
	const room = Math.max(0, Math.floor(deadlineAt - now - WAIT_MARGIN_MS));
	return asked > room ? { ...args, timeout_ms: room } : args;
}

/** Resolve the bash budget without executing it; invalid calls keep their normal durable validation receipt. */
export function bashCallDurationMs(tool: ToolRegistration, args: unknown): number | undefined {
	if (tool.name !== "bash") return undefined;
	try {
		// Reuse only the pure registry repair, not arbitrary prepareArguments/beforeTool hooks with effects.
		const repaired = repairArguments(tool.parameters as unknown as Record<string, unknown>, args);
		const validated = validateToolArguments(tool, { type: "toolCall", id: "codemode-budget", name: tool.name, arguments: repaired as JsonObject });
		return checkBashTimeout((validated as { timeout?: unknown }).timeout) * 1000;
	} catch {
		return undefined;
	}
}

/** A prompt-sized contract above this is discovered through tool_search even when its plugin asks to inline it. */
export const INLINE_SCHEMA_MAX_BYTES = 4096;
const SUMMARY_MAX_CHARS = 160;

/** First sentence of a tool description, single-line and bounded: a recognition cue, not a contract. */
export function toolSummary(description: string): string {
	const flat = description.replace(/\s+/g, " ").trim();
	const end = flat.search(/[.!?](\s|$)/);
	const sentence = end >= 0 ? flat.slice(0, end + 1) : flat;
	return sentence.length <= SUMMARY_MAX_CHARS ? sentence : `${sentence.slice(0, SUMMARY_MAX_CHARS - 1).trimEnd()}…`;
}

function fullContract(tool: { name: string; description: string; parameters: unknown }): string {
	return `${tool.name}: ${tool.description}\nArguments JSON schema: ${JSON.stringify(compactSchema(tool.parameters as Parameters<typeof compactSchema>[0]))}`;
}

/**
 * Codemode-only tools are hidden from the model's tool list. With tool_search, each gets a one-line summary so the
 * agent can recognize the capability while planning; tools in `inlineSchemaToolNames` (small, planning-relevant
 * capabilities) keep their full contract. Without tool_search every contract is inlined (ADR 0019 allowlist rule).
 */
export function codemodeOnlyToolGuidance(
	tools: readonly { name: string; description: string; parameters: unknown }[],
	canSearch: boolean,
	inlineSchemaToolNames: ReadonlySet<string> = new Set(),
): string[] {
	if (!canSearch) return tools.map(fullContract);
	const inline = tools.filter((tool) => inlineSchemaToolNames.has(tool.name) && Buffer.byteLength(JSON.stringify(tool.parameters) ?? "") <= INLINE_SCHEMA_MAX_BYTES);
	const summarized = tools.filter((tool) => !inline.includes(tool));
	return [
		"Retrieve unfamiliar contracts with await tools.tool_search({query: \"short English capability keywords or exact tool name\"}); emit the result, inspect the complete schema, then call the tool in a later cell. Interpret Korean requests before searching; do not copy the whole sentence. Search does not activate tools or grant permissions. Known valid calls do not require a search.",
		summarized.length
			? `Additional codemode-only tools (summaries; search the exact name for the schema):\n${summarized.map((tool) => `- ${tool.name}${tool.description.trim() ? `: ${toolSummary(tool.description)}` : ""}`).join("\n")}`
			: "Additional codemode-only tools: (none).",
		...(inline.length ? ["Codemode-only tools with full contracts (no search needed):", ...inline.map(fullContract)] : []),
	];
}

/**
 * Codemode. A call to a tool in `longRunningTools` (name → declared maximum run time in ms) moves the cell deadline to
 * its admission time + that run time + LONG_CALL_MARGIN_MS, so a cell is not cut while such a call may still finish;
 * Bash uses its validated per-call timeout (or default budget) through the same deadline extension contract.
 * `CODEMODE_LIMITS.maxTimeoutMs` bounds the whole cell. Other calls keep the ordinary cell limit.
 */
export function codemodeExtension(
	getHarness: () => Harness,
	codemodeOnlyToolNames: ReadonlySet<string>,
	inlineSchemaToolNames: ReadonlySet<string> = new Set(),
	longRunningTools: ReadonlyMap<string, number> = new Map(),
) {
	const longRunning = [...longRunningTools].filter(([, ms]) => Number.isFinite(ms) && ms > 0);
	const longRunningNote = longRunning.length
		? ` Calls to long-running tools extend the cell to cover their declared run time (${longRunning.map(([name, ms]) => `${name}: up to ${Math.round(ms / 1000)} s`).join(", ")}; the whole cell stays under ${CODEMODE_LIMITS.maxTimeoutMs / 1000} s), so await them in the cell instead of moving them to a background task.`
		: "";
	return defineExtension({
		name: "codemode",
		tasks: [CapabilityTask],
		sections: [
			section("codemode_tools", ({ agent }) => {
				const tools = agent.tools.filter((tool) => tool.name !== "codemode" && codemodeOnlyToolNames.has(tool.name));
				const canSearch = agent.tools.some(tool => tool.name === "tool_search");
				return [
					"Bun Worker JavaScript. Use the declared tool names, descriptions and argument schemas with tools.NAME(args); they also apply inside codemode. Never invent names. codemode itself cannot be called recursively.",
					`Cell limits: ${CODEMODE_LIMITS.timeoutMs} ms, ${CODEMODE_LIMITS.maxCalls} calls, at most ${CODEMODE_LIMITS.maxConcurrentCalls} in flight. Use bounded batches; text output is limited to ${CODEMODE_LIMITS.maxOutputBytes} bytes. A blocking task_output inside a cell waits at most until shortly before the cell limit, so it always returns its result. Bash extends the cell for its validated timeout in seconds (default ${BASH_BUDGET.defaultSeconds} s when omitted); the whole cell stays under ${CODEMODE_LIMITS.maxTimeoutMs / 1000} s, even for a longer bash timeout.${longRunningNote}`,
					"Call await tools.NAME(args). Each returns {content, isError?, details?, diagnostics?}, never stdout/stderr. Use text(result) for the full result or text(resultText(result)) for text plus diagnostics; resultText throws on isError. Example: text(resultText(await tools.bash({command: \"pwd\"})));",
					"Images from tool results are attached automatically to the model, in call order, even without text(). The worker receives attachment markers, never image bytes. Each cell retains at most 4 images / 8 MiB decoded attachment bytes; excess calls fail. Use separate cells for more images. Completed attachments survive cell errors; aborted/interrupted cells retain receipts but do not deliver attachments.",
					"Native Bun/Node APIs are available, but durable tracking and cancellation apply to tools calls only. Use tools for managed work; do not detach promises, timers, processes or workers.",
					...codemodeOnlyToolGuidance(tools, canSearch, inlineSchemaToolNames),
				].join("\n\n");
			}),
		],
		tools: [
			defineTool({
				name: "codemode",
				description:
					"Default work surface: execute JavaScript in a fresh Bun Worker, invoking harness tools through tools.NAME(args). Batch independent reads with Promise.allSettled, inspect every failure, sequence dependent calls and mutations. Emit selected text evidence using text(value) or return a JSON value. Read images attach automatically even without text()/return; workers receive markers, not base64. Every tool promise must be awaited. 60-second cell limit (a call to a long-running tool extends it to that tool's declared run time); use task({run_in_background:true}) for durable long work. No variables persist across cells. Interrupted cells are never automatically replayed.",
				parameters: Type.Object({ code: Type.String() }),
				replay: "unsafe",
				executionMode: "sequential",
				execute: async ({ code }, api, context) => {
					await api.commit(async (tx) => {
						await tx.doc(CellDoc, api.conversationId, String(api.taskId), null);
					}, context);
					await api.details({ codemodeTaskId: api.taskId }, context);
					const agent = await api.agent(context);
					const tools = agent.tools.filter((tool) => tool.name !== "codemode");
					// The worker is cut at the cell limit and a cut call returns nothing: clamp waits to the time left.
					// Long-running calls move the deadline later; this copy tracks the deadline runCell enforces.
					let deadlineAt = Date.now() + CODEMODE_LIMITS.timeoutMs;
					const running = new Set<Promise<unknown>>();
					const children = new Set<TaskId>();
					let barrier: Promise<unknown> = Promise.resolve();
					let closing = false;
					const result = await runCell({
						code,
						names: tools.map((tool) => tool.name),
						...(context.abortSignal ? { signal: context.abortSignal } : {}),
						output: (text) => api.output(text + "\n"),
						call(ordinal, name, args, signal, extend) {
							const tool = tools.find((tool) => tool.name === name)!;
							const before = tool.executionMode === "sequential" ? Promise.allSettled([...running]) : barrier;
							const work = (async () => {
								await before;
								signal.throwIfAborted();
								if (closing) throw new Error("Cell is closing");
								// Measured at admission, after any barrier: a long-running call gets its declared run time from now,
								// and a wait must end before the (possibly extended) cell limit.
								const runTime = bashCallDurationMs(tool, args) ?? longRunningTools.get(name);
								if (runTime !== undefined && Number.isFinite(runTime) && runTime > 0) deadlineAt = extend(Date.now() + runTime + LONG_CALL_MARGIN_MS);
								args = clampCellWait(name, args, deadlineAt, Date.now());
								const id = await api.commit(async (tx) => {
									const doc = await tx.doc(CellDoc, api.conversationId, String(api.taskId), null);
									if (doc.calls.some((call) => call.ordinal === ordinal))
										throw new Error("Duplicate internal call ordinal");
									const id = await tx.createTask(
										CapabilityTask,
										{ parent: api.taskId, rootCallId: api.callId, ordinal, name, args: encode(args) },
										{ ownership: { kind: "task", taskId: api.taskId } },
									);
									(await tx.doc(InternalCallDoc, id)).parent = api.taskId;
									doc.calls.push({ id, ordinal, name, status: "pending" });
									return id;
								}, context);
								children.add(id);
								const cancellation = withCancel(context);
								const abort = () => cancellation.cancel(new Error("Cell ended"));
								signal.addEventListener("abort", abort, { once: true });
								if (signal.aborted) abort();
								try {
									const settled = await api.waitForTask(id, cancellation.context);
									if (settled.state.outcome.result) return JSON.parse(settled.state.outcome.result.json);
									throw new Error(`Internal call ${name}: ${settled.state.outcome.status}`);
								} finally {
									signal.removeEventListener("abort", abort);
									cancellation.cancel();
								}
							})();
							running.add(work);
							void work.finally(() => running.delete(work)).catch(() => {});
							if (tool.executionMode === "sequential") barrier = work.catch(() => {});
							return work;
						},
					});
					closing = true;
					// Drain admission first: an abort can race an admission commit. No owned child may escape cleanup.
					await Promise.allSettled([...running]);
					const harness = getHarness();
					const cleanup = await Promise.allSettled(
						[...children].map(async (id) => {
							const task = await harness.getTask(id, BACKGROUND_CONTEXT);
							if (task && task.state.status !== "terminal") {
								await harness.abortTask(id, BACKGROUND_CONTEXT);
								await harness.waitForTask(id, BACKGROUND_CONTEXT);
							}
						}),
					);
					const cleanupError = cleanup.find((item) => item.status === "rejected");
					context.abortSignal?.throwIfAborted();
					// Reconcile any unexpected task fault too, so the displayed journal never remains "running" after settlement.
					await api.commit(async (tx) => {
						const records = await Promise.all([...children].map((id) => tx.task(id)));
						const doc = await tx.doc(CellDoc, api.conversationId, String(api.taskId), null);
						for (const task of records) {
							if (!task || task.state.status !== "terminal") continue;
							const call = doc.calls.find((call) => call.id === task.id);
							if (call && (call.status === "pending" || call.status === "running")) {
								call.status = task.state.outcome.status === "aborted" ? "aborted" : "failed";
								call.endedAt = Date.now();
								call.error = `Internal task ended: ${task.state.outcome.status}`;
							}
						}
						const live = await tx.doc(LiveDoc, api.conversationId);
						const slot = live.tools?.find((slot) => slot.taskId === api.taskId);
						if (slot) {
							const old =
								typeof slot.details === "object" && slot.details !== null && !Array.isArray(slot.details)
									? slot.details
									: {};
							slot.details = {
								...old,
								codemodeCalls: doc.calls.map(({ id, name, status, error, preview, startedAt, endedAt }) => ({
									id,
									name,
									status,
									...(preview ? { preview } : {}),
									...(startedAt !== undefined ? { startedAt } : {}),
									...(endedAt !== undefined ? { endedAt } : {}),
									...(error ? { error } : {}),
								})),
							};
						}
					}, context);
					const journal = await api.snapshot(CellDoc, api.conversationId, String(api.taskId), context);
					const failed =
						journal?.calls.filter((call) => call.error || call.status === "failed" || call.status === "aborted") ?? [];
					const failureSummary = failed.length
						? `${failed.length} internal call(s) reported errors. Inspect before retrying effects:\n${failed
								.slice(0, 16)
								.map((call) => `${call.ordinal}. ${call.name}: ${call.error ?? call.status}`)
								.join("\n")}${failed.length > 16 ? "\nFurther failures are retained in the cell receipt." : ""}`
						: undefined;
					const error =
						result.error ??
						(cleanupError?.status === "rejected" ? `Cleanup failed: ${errorText(cleanupError.reason)}` : undefined);
					return {
						content: [
							...(journal?.calls.slice().sort((a, b) => a.ordinal - b.ordinal).flatMap((call) => call.images ?? []) ?? []),
							...result.output.map((text) => ({ type: "text" as const, text })),
							...(result.value === undefined ? [] : [{ type: "text" as const, text: encode(result.value) }]),
							...(error ? [{ type: "text" as const, text: error }] : []),
							...(failureSummary ? [{ type: "text" as const, text: failureSummary }] : []),
						],
						isError: error !== undefined || failed.length > 0,
						details:
							(await api.snapshot(LiveDoc, api.conversationId, context))?.tools?.find(
								(slot) => slot.taskId === api.taskId,
							)?.details ?? {},
					};
				},
			}),
			defineTool({
				name: "codemode_status",
				description:
					"Inspect a codemode cell receipt after failure/interruption before retrying effects. Use codemodeTaskId from cell details. Scope is this conversation. Results are paginated; task state is authoritative, and interrupted effects may be unknown.",
				replay: "safe",
				parameters: Type.Object({
					task_id: Type.Integer({ minimum: 1 }),
					offset: Type.Optional(Type.Integer({ minimum: 0 })),
					limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 16 })),
				}),
				execute: async ({ task_id, offset = 0, limit = 8 }, api, context) => {
					const id = task_id as TaskId;
					const task = await api.getTask(id, context);
					const doc =
						task?.conversationId === api.conversationId
							? await api.snapshot(CellDoc, api.conversationId, String(id), context)
							: undefined;
					if (!task || !doc)
						return { isError: true, content: [{ type: "text", text: "No codemode receipt in this conversation" }] };
					const calls = await Promise.all(
						doc.calls.slice(offset, offset + limit).map(async (call) => {
							const { images = [], ...metadata } = call;
							const current = await api.getTask(call.id as TaskId, context);
							const result =
								call.result && Buffer.byteLength(call.result) <= 16000 ? JSON.parse(call.result) : undefined;
							return {
								...metadata,
								imageCount: images.length,
								imageBytes: images.reduce((bytes, image) => bytes + Buffer.byteLength(image.data, "base64"), 0),
								result:
									result ??
									(call.result
										? "Result exceeds status output limit; inspect the backing receipt before repeating effects"
										: null),
								taskState: current?.state.status ?? "missing",
								outcome: current?.state.outcome?.status ?? null,
							};
						}),
					);
					return {
						content: [
							...doc.calls.slice(offset, offset + limit).flatMap((call) => call.images ?? []),
							{
								type: "text",
								text: JSON.stringify({
									taskId: task_id,
									state: task.state.status,
									outcome: task.state.outcome?.status ?? null,
									total: doc.calls.length,
									nextOffset: offset + calls.length < doc.calls.length ? offset + calls.length : null,
									calls,
								}),
							},
						],
					};
				},
			}),
		],
	});
}
