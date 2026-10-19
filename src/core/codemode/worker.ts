import { CellLifecycle } from "./lifecycle.ts";
import { Worker } from "node:worker_threads";
import { codemodeAssets } from "../../codemode-assets.ts";
import { CODEMODE_LIMITS, encode, errorText, type WorkerRequest } from "./protocol.ts";

export type CellResult = { output: string[]; value?: unknown; error?: string };
/**
 * Move the cell deadline later, to `at` (epoch ms), never earlier and never past the cell's hard ceiling. Returns the
 * deadline in force afterwards. A host call whose tool declares a longer run time uses it so the cell outlives the call.
 */
export type ExtendDeadline = (at: number) => number;
/** One invocation, one worker, one terminal decision. Worker termination is not a host security sandbox. */
export async function runCell(options: {
	code: string;
	names: string[];
	signal?: AbortSignal;
	timeoutMs?: number;
	/** Hard ceiling of the cell's lifetime however far calls extend it. Default: `CODEMODE_LIMITS.maxTimeoutMs`. */
	maxTimeoutMs?: number;
	call(id: number, name: string, args: unknown, signal: AbortSignal, extend: ExtendDeadline): Promise<unknown>;
	output?(text: string): void;
}): Promise<CellResult> {
	if (Buffer.byteLength(options.code) > CODEMODE_LIMITS.maxCodeBytes)
		return { output: [], error: "Cell code limit exceeded" };
	if (options.signal?.aborted) return { output: [], error: "Cell aborted before start" };
	const controller = new AbortController();
	const output: string[] = [];
	const allowed = new Set(options.names);
	let bytes = 0;
	const state = new CellLifecycle(CODEMODE_LIMITS.maxCalls, CODEMODE_LIMITS.maxConcurrentCalls);
	let decide!: (result: CellResult) => void;
	const settled = new Promise<CellResult>((resolve) => {
		decide = resolve;
	});
	const worker = new Worker(codemodeAssets.workerUrl, {
		workerData: { code: options.code, names: options.names },
		stdout: true,
		stderr: true,
	});
	// Native console output is not model output; bound memory by draining instead of buffering it.
	worker.stdout?.resume();
	worker.stderr?.resume();
	const finish = (result: CellResult) => {
		if (!state.finish()) return;
		controller.abort(new Error(result.error ?? "Cell finished"));
		decide(result);
	};
	const abort = () => finish({ output, error: "Cell aborted; in-flight effects may have partially completed" });
	options.signal?.addEventListener("abort", abort, { once: true });
	if (options.signal?.aborted) abort();
	const startedAt = Date.now();
	const ceilingAt = startedAt + Math.max(options.timeoutMs ?? CODEMODE_LIMITS.timeoutMs, options.maxTimeoutMs ?? CODEMODE_LIMITS.maxTimeoutMs);
	let deadlineAt = startedAt + (options.timeoutMs ?? CODEMODE_LIMITS.timeoutMs);
	const expire = () => finish({ output, error: "Cell timed out; in-flight effects may have partially completed" });
	let timer = setTimeout(expire, deadlineAt - startedAt);
	// Invariant: deadlineAt only grows, stays ≤ ceilingAt, and exactly one timer is armed for it until the cell settles.
	const extend: ExtendDeadline = (at) => {
		const next = Math.min(ceilingAt, Math.floor(at));
		if (state.terminal || !(next > deadlineAt)) return deadlineAt;
		deadlineAt = next;
		clearTimeout(timer);
		timer = setTimeout(expire, Math.max(0, deadlineAt - Date.now()));
		return deadlineAt;
	};
	worker.on("message", (message: WorkerRequest) => {
		if (state.terminal) return;
		if (!message || typeof message !== "object") return finish({ output, error: "Invalid worker message" });
		switch (message.type) {
			case "call": {
				if (
					!allowed.has(message.name) ||
					typeof message.args !== "string" ||
					Buffer.byteLength(message.args) > CODEMODE_LIMITS.maxValueBytes
				)
					return finish({ output, error: "Invalid or excessive worker tool call" });
				let args: unknown;
				try {
					args = JSON.parse(message.args);
					encode(args);
				} catch {
					return finish({ output, error: "Invalid tool JSON" });
				}
				if (!state.admit(message.id)) return finish({ output, error: "Invalid or excessive worker tool call" });
				void Promise.resolve()
					.then(() => {
						controller.signal.throwIfAborted();
						return options.call(message.id, message.name, args, controller.signal, extend);
					})
					.then((value) => {
						if (!state.terminal) worker.postMessage({ id: message.id, value: encode(value) });
					})
					.catch((error) => {
						if (!state.terminal) {
							try {
								worker.postMessage({ id: message.id, error: errorText(error) });
							} catch (failure) {
								finish({ output, error: errorText(failure) });
							}
						}
					})
					.finally(() => {
						state.settle(message.id);
					});
				break;
			}
			case "output":
				if (
					typeof message.text !== "string" ||
					output.length >= CODEMODE_LIMITS.maxOutputItems ||
					(bytes += Buffer.byteLength(message.text)) > CODEMODE_LIMITS.maxOutputBytes
				)
					return finish({ output, error: "Cell output limit exceeded" });
				output.push(message.text);
				try {
					options.output?.(message.text);
				} catch (error) {
					finish({ output, error: errorText(error) });
				}
				break;
			case "done":
				if (
					message.value !== undefined &&
					(typeof message.value !== "string" || Buffer.byteLength(message.value) > CODEMODE_LIMITS.maxValueBytes)
				)
					return finish({ output, error: "Invalid or excessive worker result" });
				if (state.active) return finish({ output, error: "Cell ended with pending host calls" });
				try {
					const value = message.value === undefined ? undefined : JSON.parse(message.value);
					if (value !== undefined) encode(value);
					finish({ output, ...(value === undefined ? {} : { value }) });
				} catch (error) {
					finish({ output, error: errorText(error) });
				}
				break;
			case "error":
				finish({ output, error: errorText(message.error) });
				break;
			default:
				finish({ output, error: "Unknown worker message" });
		}
	});
	worker.on("error", (error) => finish({ output, error: errorText(error) }));
	worker.on("exit", (code) => finish({ output, error: `Worker exited (${code}) before settling` }));
	try {
		return await settled;
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", abort);
		await worker.terminate();
	}
}
