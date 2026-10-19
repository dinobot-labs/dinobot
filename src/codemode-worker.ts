import { parentPort, workerData } from "node:worker_threads";
import { CODEMODE_LIMITS, encode, errorText, type HostReply } from "./core/codemode/protocol.ts";

const port = parentPort!;
const { code, names } = workerData as { code: string; names: string[] };
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
let nextId = 0;
let outputBytes = 0;
let outputItems = 0;
let ended = false;
const tools = Object.create(null) as Record<string, (args: unknown) => Promise<unknown>>;
for (const name of names) {
	tools[name] = (args: unknown = {}) => {
		if (ended) return Promise.reject(new Error("Cell has ended"));
		if (nextId >= CODEMODE_LIMITS.maxCalls) throw new Error("Cell tool call limit exceeded");
		if (pending.size >= CODEMODE_LIMITS.maxConcurrentCalls)
			throw new Error("Concurrent tool call limit exceeded; use bounded batches");
		const json = encode(args);
		const id = ++nextId;
		const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
		// Keep an unawaited rejected call from terminating the worker; ending with pending calls still fails.
		void result.catch(() => {});
		port.postMessage({ type: "call", id, name, args: json });
		return result;
	};
}
Object.freeze(tools);
// Models also see direct tools under other casings (Read, Edit, Bash). A case/underscore-insensitive name that
// identifies exactly one allowed tool resolves to it; anything else stays undefined. Host allowlisting is unchanged.
const canonical = (name: string) => name.toLowerCase().replace(/[_-]/g, "");
const aliases = new Map<string, string | null>();
for (const name of names) {
	const key = canonical(name);
	aliases.set(key, aliases.has(key) && aliases.get(key) !== name ? null : name);
}
const toolsView = new Proxy(tools, {
	get(target, key, receiver) {
		if (typeof key !== "string" || key in target) return Reflect.get(target, key, receiver);
		const alias = aliases.get(canonical(key));
		return alias ? target[alias] : undefined;
	},
});
const distance = (a: string, b: string) => {
	const row = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i++) {
		let diagonal = row[0]!;
		row[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const above = row[j]!;
			row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
			diagonal = above;
		}
	}
	return row[b.length]!;
};
/** Add the cell line of a syntax/runtime error and nearest tool names for an unknown tools.X. */
function explain(error: unknown, phase: "compile" | "run"): string {
	const base = errorText(error);
	const lines = code.split("\n");
	const at = (line: number, column?: number) => {
		const source = lines[line - 1];
		if (source === undefined) return "";
		const caret = column && column > 0 ? `\n  ${" ".repeat(Math.min(column - 1, 200))}^` : "";
		return `\nCell line ${line}${column ? `:${column}` : ""}:\n  ${source.slice(0, 240)}${caret}`;
	};
	if (phase === "compile") {
		try {
			new Bun.Transpiler({ loader: "js" }).transformSync(`async function __cell(){\n${code}\n}`);
		} catch (located) {
			const detail = located as { message?: string; position?: { line: number; column: number }; errors?: { message?: string; position?: { line: number; column: number } }[] };
			const first = detail.errors?.[0] ?? detail;
			if (first.position) return `SyntaxError: ${first.message ?? base}${at(first.position.line - 1, first.position.column + 1)}`;
		}
		return base;
	}
	const unknown = /tools\.([A-Za-z_$][\w$]*) is not a function/.exec(base)?.[1];
	if (unknown) {
		const near = names.map((name) => [name, distance(canonical(unknown), canonical(name))] as const)
			.filter(([, d]) => d <= Math.max(2, Math.floor(unknown.length / 3))).sort((a, b) => a[1] - b[1]).slice(0, 3).map(([name]) => `tools.${name}`);
		return `${base}\n${near.length ? `Did you mean ${near.join(", ")}?` : "No tool with a similar name is available in this cell."} Tool names are listed in ALL_TOOLS/tool_search.`;
	}
	// The cell body starts 3 lines into the generated function: header, parameter close, "use strict".
	const frame = /at anonymous \([^)]*:(\d+):(\d+)\)/.exec((error as Error)?.stack ?? "");
	return frame ? `${base}${at(Number(frame[1]) - 3, Number(frame[2]))}` : base;
}
port.on("message", (reply: HostReply) => {
	const waiter = pending.get(reply.id);
	if (!waiter || ended) return;
	pending.delete(reply.id);
	if (reply.error !== undefined) waiter.reject(new Error(reply.error));
	else {
		const value = JSON.parse(reply.value!);
		waiter.resolve(value && Array.isArray(value.content) ? new Proxy(value, {
			get(target, key, receiver) {
				if ((key === "stdout" || key === "stderr") && !(key in target)) throw new Error(`Tool results have content, not ${String(key)}. Use resultText(result) or text(result). The tool already ran; inspect its receipt before retrying effects.`);
				return Reflect.get(target, key, receiver);
			},
		}) : value);
	}
});
const text = (value: unknown) => {
	if (ended) throw new Error("Cell has ended");
	const output = typeof value === "string" ? value : encode(value);
	outputBytes += Buffer.byteLength(output);
	if (outputBytes > CODEMODE_LIMITS.maxOutputBytes || ++outputItems > CODEMODE_LIMITS.maxOutputItems)
		throw new Error("Cell output limit exceeded");
	port.postMessage({ type: "output", text: output });
};
const resultText = (result: { content?: { type: string; text?: string }[]; isError?: boolean; diagnostics?: unknown[] }) => {
	if (!result || !Array.isArray(result.content)) throw new Error("resultText expects a tool result with content");
	const body = result.content.filter(block => block.type === "text").map(block => block.text ?? "").join("\n");
	const diagnostics = result.diagnostics?.length ? "\nDiagnostics: " + encode(result.diagnostics) : "";
	if (result.isError) throw new Error("Tool reported an error: " + body + diagnostics);
	return body + diagnostics;
};
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
let run: ((...args: unknown[]) => Promise<unknown>) | undefined;
try {
	run = new AsyncFunction("tools", "text", "resultText", '"use strict";\n' + code);
} catch (error) {
	ended = true;
	port.postMessage({ type: "error", error: explain(error, "compile") });
}
if (run) try {
	const value: unknown = await run(toolsView, text, resultText);
	if (pending.size)
		throw new Error(
			"Cell returned with unawaited tool calls; await every call (use task run_in_background for durable background work)",
		);
	ended = true;
	port.postMessage({ type: "done", ...(value === undefined ? {} : { value: encode(value) }) });
} catch (error) {
	ended = true;
	port.postMessage({ type: "error", error: explain(error, "run") });
}
