import { copyJson, type Context, type JsonValue } from "@earendil-works/chord";
import { LiveDoc, NestedCallDoc, ToolTask, type CommitOptions, type JsonObject, type NestedToolExecutionResult, type TaskId, type TaskRuntime, type ToolDiagnostic, type ToolExecutionApi, type ToolExecutionResult, type ToolRegistration, type Tx } from "@earendil-works/pi-durable";
import { ToolOutput } from "./codemode/output.ts";

/** The host worker protocol is deliberately not durable's execution-result protocol. */
export type WorkerToolResult = Omit<ToolExecutionResult, "output"> & { content?: ToolExecutionResult["output"] };
export function workerToolResult({ output, ...result }: ToolExecutionResult): WorkerToolResult {
	return { ...result, ...(output === undefined ? {} : { content: output }) };
}

/** Native structural JSON equality: prototypes and the sign of zero are not part of a nested key. */
function sameJson(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
	if (a === b) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => sameJson(value, b[index]));
	const keys = Object.keys(a);
	return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && sameJson(a[key], b[key]));
}

/** Native nested calls beneath a host-owned invocation, including replay, ownership and scoped resolution. */
export async function createTaskToolInvocation<I, S extends { phase: string }, R, H extends object>(
	runtime: TaskRuntime<I, S, R, H>, callId: string, tool: Pick<ToolRegistration, "replay" | "outputLimits">, context: Context,
	onDetails?: (tx: Tx, value: JsonValue) => Promise<void>,
) {
	let ended = false;
	let sequence = 0;
	const admissions: Promise<TaskId>[] = [];
	const output = new ToolOutput(tool.outputLimits);
	const diagnostics: NonNullable<ToolExecutionResult["diagnostics"]>[number][] = [];
	let details: JsonValue | undefined;
	const assertLive = () => {
		if (ended) throw new Error("Tool invocation ended");
		runtime.signal.throwIfAborted();
		context.abortSignal?.throwIfAborted();
	};
	// Fence method admission, including methods saved before close. Do not recursively proxy data or promises:
	// calls already admitted keep their native cancellation/result semantics. Resource release remains available.
	const scoped = <T extends object>(target: T, release?: keyof T): T => new Proxy(target, {
		get(target, property) {
			if (property !== release) assertLive();
			const value: unknown = Reflect.get(target, property, target);
			return typeof value === "function" ? (...args: unknown[]) => {
				if (property !== release) assertLive();
				return Reflect.apply(value, target, args);
			} : value;
		},
		set(target, property, value, receiver) { assertLive(); return Reflect.set(target, property, value, receiver); },
	});
	// Preserve the runtime overloads and its native cancellation checks.
	const reader = scoped(runtime);
	const nativeEnv = await runtime.env(context);
	const env = nativeEnv === undefined ? undefined : scoped(new Proxy(nativeEnv, {
		get(target, property) {
			// These results contain live resources, not plain data. Wrap even a late async acquisition so it
			// cannot admit another read after close, but can always release the acquired native descriptor.
			if (property === "openBinaryReader") return async (...args: Parameters<typeof target.openBinaryReader>) => {
				const result = await target.openBinaryReader(...args);
				return result.ok ? { ...result, value: scoped(result.value, "close") } : result;
			};
			if (property === "openTextLineReader") return async (...args: Parameters<typeof target.openTextLineReader>) => {
				const result = await target.openTextLineReader(...args);
				return result.ok ? { ...result, value: scoped(result.value, "close") } : result;
			};
			if (property === "openDirReader") return async (...args: Parameters<typeof target.openDirReader>) => {
				const result = await target.openDirReader(...args);
				return result.ok ? { ...result, value: scoped(result.value, "close") } : result;
			};
			const value: unknown = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}));
	const api: ToolExecutionApi = {
		taskId: runtime.taskId, conversationId: runtime.conversationId, callId, registry: runtime.registry,
		get models() { assertLive(); return scoped(runtime.models); },
		get env() { assertLive(); return env; },
		agent: reader.agent, now: reader.now, snapshot: reader.snapshot, snapshotAsOf: reader.snapshotAsOf, watchDoc: reader.watchDoc,
		memo: reader.memo, getTask: reader.getTask, waitForTask: reader.waitForTask,
		async conversation(id, ctx) {
			const handle = await reader.conversation(id, ctx);
			return handle === undefined ? undefined : scoped(handle);
		},
		// The host additionally caps output; never allow an environment to skip around that transformation.
		outputWindow: undefined,
		output(chunk, skipped) { assertLive(); output.push(chunk, skipped); },
		retainedOutput() { assertLive(); return output.snapshot(); },
		diagnostic(value) { assertLive(); if (diagnostics.length >= 100) throw new Error("Too many diagnostics"); diagnostics.push(copyJson(value, { omitUndefinedProperties: true }) as ToolDiagnostic); },
		async details(value, ctx) {
			assertLive(); ctx.abortSignal?.throwIfAborted();
			const copied = copyJson(value, { omitUndefinedProperties: true });
			if (onDetails) await runtime.commit(async tx => { await onDetails(tx, copied); return undefined; }, ctx);
			details = copied;
		},
		async commit<T>(change: (tx: Tx) => T | Promise<T>, ctx: Context, options?: CommitOptions): Promise<T> {
			assertLive(); let value!: T;
			await runtime.commit(async tx => { assertLive(); value = await change(tx); return undefined; }, ctx, options);
			return value;
		},
		createTask(task, input, options, ctx) {
			assertLive();
			const child = options.ownership.kind === "task" && tool.replay !== "safe" ? { abandonOnRestart: true, ...options } : options;
			return api.commit(tx => tx.createTask(task, input, child), ctx);
		},
		async executeTool(name, args, ctx, options = {}): Promise<NestedToolExecutionResult> {
			assertLive();
			const key = options.key ?? String(++sequence);
			if (options.key !== undefined && (!key || key.includes("/") || key === "__proto__" || /^[1-9][0-9]*$/.test(key))) throw new Error("Invalid nested tool key");
			const call = { type: "toolCall" as const, id: callId + "/" + key, name, arguments: copyJson(args, { omitUndefinedProperties: true }) as JsonObject };
			const admission = (async () => {
				let id!: TaskId;
				await runtime.commit(async tx => {
					const state = await tx.doc(NestedCallDoc, runtime.taskId, key, null);
					if (state.taskId !== undefined) {
						const input = (await tx.task(state.taskId))?.input;
						if (!input || typeof input !== "object" || Array.isArray(input) || input.kind !== "nested" || !input.call || typeof input.call !== "object" || Array.isArray(input.call) || input.call.name !== name || !sameJson(input.call.arguments, call.arguments)) throw new Error("Nested key reused with different tool or arguments");
						id = state.taskId; return undefined;
					}
					const created = await tx.createTask(ToolTask, { kind: "nested", parent: runtime.taskId, parentCallId: callId, key, call, ...(options.progress === false ? { progress: false } : {}) }, { ownership: { kind: "task", taskId: runtime.taskId }, abandonOnRestart: tool.replay !== "safe" });
					state.taskId = created; id = created;
					const live = await tx.doc(LiveDoc, runtime.conversationId);
					(live.nestedTools ??= []).push({ callId: call.id, parentCallId: callId, parentTaskId: runtime.taskId, name, taskId: created, arguments: call.arguments, status: "pending" });
					return undefined;
				}, ctx);
				return id;
			})();
			admissions.push(admission);
			const id = await admission;
			const settled = await runtime.waitForTask(id, ctx);
			const stored = (await runtime.snapshot(NestedCallDoc, runtime.taskId, key, ctx))?.result;
			return stored ? structuredClone(stored) as NestedToolExecutionResult : { taskId: id, isError: true, diagnostics: [{ severity: "error", code: settled.state.outcome.status, message: "Nested tool ended without a result" }] };
		},
	};
	return { api, output, diagnostics, get details() { return details; },
		async close() {
			ended = true;
			// Admissions already accepted must settle before cleanup discovers the children.
			await Promise.allSettled(admissions);
			output.finish();
			await settleHostNestedCalls(runtime, context);
		},
	};
}

/** Also called from a fresh abort invocation to clean children left by a crash. Usage stays owned by pi.tool. */
export async function settleHostNestedCalls<I, S extends { phase: string }, R, H extends object>(runtime: TaskRuntime<I, S, R, H>, context: Context) {
	const children = (await runtime.ownedTasks(context)).filter(record => record.kind === ToolTask.definition.name && record.input !== null && typeof record.input === "object" && !Array.isArray(record.input) && record.input.kind === "nested");
	await Promise.all(children.map(child => runtime.abortOwned(child.id, context)));
	await runtime.commit(async tx => {
		const live = await tx.doc(LiveDoc, runtime.conversationId);
		const parents = new Set<number>([runtime.taskId]);
		for (const slot of live.nestedTools ?? []) if (parents.has(slot.parentTaskId)) parents.add(slot.taskId);
		if (live.nestedTools) { live.nestedTools = live.nestedTools.filter(slot => !parents.has(slot.parentTaskId)); if (!live.nestedTools.length) delete live.nestedTools; }
		return undefined;
	}, context);
}
