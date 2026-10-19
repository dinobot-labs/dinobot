/** The wire boundary accepts bounded JSON only; never structured-clone arbitrary host objects. */
export const CODEMODE_LIMITS = {
	timeoutMs: 60_000,
	/** Ceiling of one cell when calls to long-running tools (`maxDurationMs`) extend it. */
	maxTimeoutMs: 960_000,
	maxCodeBytes: 128 * 1024,
	maxValueBytes: 512 * 1024,
	maxOutputBytes: 128 * 1024,
	maxOutputItems: 256,
	maxCalls: 256,
	maxConcurrentCalls: 16,
} as const;
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export function encode(value: unknown, limit = CODEMODE_LIMITS.maxValueBytes): string {
	const seen = new Set<object>();
	const visit = (item: unknown, depth: number): void => {
		if (depth > 64) throw new Error("JSON nesting exceeds 64 levels");
		if (item === null || typeof item === "string" || typeof item === "boolean") return;
		if (typeof item === "number" && Number.isFinite(item)) return;
		if (typeof item !== "object" || item === null)
			throw new Error("Only finite JSON values can cross the tool boundary");
		if (seen.has(item)) throw new Error("Cyclic JSON value");
		if (
			!Array.isArray(item) &&
			Object.getPrototypeOf(item) !== Object.prototype &&
			Object.getPrototypeOf(item) !== null
		)
			throw new Error("Only plain JSON objects are supported");
		seen.add(item);
		const keys = Reflect.ownKeys(item);
		if (Array.isArray(item) && (Object.getPrototypeOf(item) !== Array.prototype || keys.length !== item.length + 1))
			throw new Error("Only dense JSON arrays are supported");
		for (const key of keys) {
			if (Array.isArray(item) && key === "length") continue;
			if (typeof key === "symbol") throw new Error("Symbol keys are not JSON");
			if (Array.isArray(item) && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length))
				throw new Error("Only indexed JSON array entries are supported");
			const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
			if (!descriptor.enumerable || !("value" in descriptor))
				throw new Error("Only enumerable JSON data properties are supported");
			visit(descriptor.value, depth + 1);
		}
		seen.delete(item);
	};
	visit(value, 0);
	const json = JSON.stringify(value);
	if (Buffer.byteLength(json) > limit) throw new Error(`JSON exceeds ${limit} bytes`);
	return json;
}
export function errorText(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, 4000);
}
export type WorkerRequest =
	| { type: "call"; id: number; name: string; args: string }
	| { type: "output"; text: string }
	| { type: "done"; value?: string }
	| { type: "error"; error: string };
export type HostReply = { id: number; value?: string; error?: string };
