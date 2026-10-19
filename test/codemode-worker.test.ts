import { expect, test } from "bun:test";
import { runCell } from "../src/core/codemode/worker.ts";
import { CODEMODE_LIMITS, encode } from "../src/core/codemode/protocol.ts";

const run = (code: string, extra: Partial<Parameters<typeof runCell>[0]> = {}) =>
	runCell({ code, names: [], call: async () => null, ...extra });

test("executes native Bun in a fresh Worker and retains only explicit output", async () => {
	const result = await run(
		'console.log("not model output"); text(Bun.version); globalThis.testCell = 42; return (await import("node:path")).basename("/a/b");',
	);
	expect(result.error).toBeUndefined();
	expect(result.value).toBe("b");
	expect(result.output).toEqual([Bun.version]);
	expect((await run("return typeof globalThis.testCell")).value).toBe("undefined");
});
test("independent calls overlap, can finish out of order and keep their own results", async () => {
	let active = 0,
		peak = 0;
	const result = await run("return await Promise.all([tools.echo({n:1}), tools.echo({n:2})]);", {
		names: ["echo"],
		call: async (_id, _name, args) => {
			active++;
			peak = Math.max(peak, active);
			await Bun.sleep((args as { n: number }).n === 1 ? 20 : 1);
			active--;
			return args;
		},
	});
	expect(peak).toBe(2);
	expect(result.value).toEqual([{ n: 1 }, { n: 2 }]);
});
test("unknown tools, invalid JSON and thrown errors are observable", async () => {
	for (const code of [
		"return tools.missing({})",
		'throw new Error("boom")',
		"return 1n",
		"return NaN",
		"const x={};x.x=x;return x;",
		"return new Date()",
	])
		expect((await run(code)).error).toBeDefined();
	expect(
		(
			await run("return await tools.fail({});", {
				names: ["fail"],
				call: async () => {
					throw new Error("host failed");
				},
			})
		).error,
	).toContain("host failed");
	const result = await run("return await Promise.allSettled([tools.fail({}),tools.fail({})]);", {
		names: ["fail"],
		call: async () => {
			throw new Error("host failed");
		},
	});
	// Error objects cannot silently turn into {} when exported: emit an explicit message instead.
	expect(result.error).toContain("plain JSON");
});
test("CPU loops, unresolved promises and explicit worker exit end within a deadline", async () => {
	for (const code of ["while(true){}", "await new Promise(()=>{})"]) {
		const start = Date.now();
		expect((await run(code, { timeoutMs: 100 })).error).toContain("timed out");
		expect(Date.now() - start).toBeLessThan(2000);
	}
	expect((await run("process.exit(0)")).error).toContain("before settling");
});
test("aborting before start admits no call; abort during a call cancels its signal", async () => {
	const before = new AbortController();
	before.abort();
	let calls = 0;
	expect(
		(
			await run("await tools.wait({})", {
				names: ["wait"],
				signal: before.signal,
				call: async () => {
					calls++;
				},
			})
		).error,
	).toContain("before start");
	expect(calls).toBe(0);
	const controller = new AbortController();
	const started = Promise.withResolvers<void>();
	let signal: AbortSignal | undefined;
	const result = run("await tools.wait({})", {
		names: ["wait"],
		signal: controller.signal,
		call: async (_i, _n, _a, s) => {
			signal = s;
			started.resolve();
			await new Promise(() => {});
		},
	});
	await started.promise;
	controller.abort();
	expect((await result).error).toContain("aborted");
	expect(signal!.aborted).toBe(true);
});
test("unawaited calls and resource floods fail without admitting beyond the bounds", async () => {
	let calls = 0;
	const result = await run('tools.wait({}); return "premature";', {
		names: ["wait"],
		call: async () => {
			calls++;
			await new Promise(() => {});
		},
	});
	expect(result.error).toContain("unawaited");
	expect(calls).toBeLessThanOrEqual(1);
	expect((await run('text("x".repeat(140000))')).error).toContain("output limit");
	expect((await run('return "x".repeat(600000)')).error).toContain("bytes");
	expect((await run(" ".repeat(CODEMODE_LIMITS.maxCodeBytes + 1))).error).toContain("code limit");
	calls = 0;
	const flood = await run("await Promise.all(Array.from({length:20},()=>tools.wait({})))", {
		names: ["wait"],
		call: async () => {
			calls++;
			await new Promise(() => {});
		},
	});
	expect(flood.error).toContain("Concurrent");
	expect(calls).toBeLessThanOrEqual(CODEMODE_LIMITS.maxConcurrentCalls);
});
test("terminal decisions ignore late host completions", async () => {
	const late = Promise.withResolvers<unknown>();
	const result = await run("await tools.wait({})", { names: ["wait"], timeoutMs: 60, call: () => late.promise });
	expect(result.error).toContain("timed out");
	late.resolve({ late: true });
	await Bun.sleep(10);
	expect(result.value).toBeUndefined();
});
test("bounded JSON rejects cyclic and excessive depth before transfer", () => {
	let value: unknown = 1;
	for (let i = 0; i < 66; i++) value = { value };
	expect(() => encode(value)).toThrow("nesting");
	expect(() => encode({ bad: undefined })).toThrow("finite JSON");
});

test("JSON boundary rejects accessors and sparse arrays without silently coercing values", () => {
	let invoked = false;
	const accessor = {
		get x() {
			invoked = true;
			return 1;
		},
	};
	expect(() => encode(accessor)).toThrow("data properties");
	expect(invoked).toBe(false);
	expect(() => encode(Array(2))).toThrow("dense");
	const sparse = Array(1) as unknown[] & { x?: number };
	sparse.x = 1;
	expect(() => encode(sparse)).toThrow("indexed");
});

test("zero-byte output cannot bypass the item budget", async () => {
	const result = await run('for(let i=0;i<1000;i++)text("");');
	expect(result.error).toContain("output limit");
	expect(result.output.length).toBe(CODEMODE_LIMITS.maxOutputItems);
});

test("resultText preserves all text and diagnostics; failed results cannot masquerade as success", async () => {
	const call = async () => ({ content: [{ type: "text", text: "first" }, { type: "text", text: "second" }], diagnostics: [{ code: "truncated", message: "read full log" }] });
	const result = await run('text(resultText(await tools.bash({})))', { names: ["bash"], call });
	expect(result.error).toBeUndefined();
	expect(result.output[0]).toContain("first\nsecond");
	expect(result.output[0]).toContain("truncated");
	const failed = await run('text(resultText(await tools.bash({})))', { names: ["bash"], call: async () => ({ ...await call(), isError: true }) });
	expect(failed.error).toContain("Tool reported an error: first\nsecond");
	expect(failed.error).toContain("read full log");
});
test("stdout/stderr misuse fails with the actual contract after exactly one effect; full JSON remains usable", async () => {
	for (const field of ["stdout", "stderr"]) {
		let calls = 0;
		const result = await run(`const r=await tools.bash({});text(r.${field} ?? "");`, { names: ["bash"], call: async () => { calls++; return { content: [{ type: "text", text: "executed" }] }; } });
		expect(calls).toBe(1); expect(result.error).toContain("Use resultText(result)"); expect(result.error).toContain("already ran");
	}
	const raw = { content: [{ type: "text", text: "ok" }], details: { stdout: "legitimate nested property" } };
	expect((await run('return await tools.bash({});', { names: ["bash"], call: async () => raw })).value).toEqual(raw);
});
test("a call can extend the cell deadline, never shorten it, and never past the ceiling", async () => {
	// Extended: the call outlives the 100 ms base limit because it moved the deadline first.
	const extended = await run("return await tools.slow({})", {
		names: ["slow"],
		timeoutMs: 100,
		call: async (_id, _name, _args, _signal, extend) => {
			extend(Date.now() + 1_000);
			await Bun.sleep(300);
			return "finished";
		},
	});
	expect(extended).toEqual({ output: [], value: "finished" });
	// Control: the same call without extending is cut at the base limit.
	const cut = await run("return await tools.slow({})", { names: ["slow"], timeoutMs: 100, call: async () => (await Bun.sleep(300), "finished") });
	expect(cut.error).toContain("timed out");
	// An earlier deadline is ignored; a later one is clamped to the ceiling, which still cuts the cell.
	const seen: number[] = [];
	const started = Date.now();
	const capped = await run("return await tools.slow({})", {
		names: ["slow"],
		timeoutMs: 100,
		maxTimeoutMs: 250,
		call: async (_id, _name, _args, _signal, extend) => {
			const base = extend(0);
			seen.push(base - started, extend(Date.now() + 60_000) - started, extend(Date.now() + 1) - started);
			await Bun.sleep(1_000);
			return "late";
		},
	});
	expect(capped.error).toContain("timed out");
	expect(Date.now() - started).toBeLessThan(900);
	expect(seen[0]!).toBeGreaterThanOrEqual(95);
	expect(seen[0]!).toBeLessThanOrEqual(130);
	expect(seen[1]!).toBeGreaterThanOrEqual(245);
	expect(seen[1]!).toBeLessThanOrEqual(280);
	expect(seen[2]).toBe(seen[1]);
});
