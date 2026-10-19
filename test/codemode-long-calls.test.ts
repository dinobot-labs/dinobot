import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { createBashTool } from "@earendil-works/pi-durable/tools";
import { bashCallDurationMs, LONG_CALL_MARGIN_MS } from "../src/extensions/codemode.ts";
import { wrapBashWithBudget } from "../src/extensions/bash-budget.ts";
import { runCell } from "../src/core/codemode/worker.ts";
import { CODEMODE_LIMITS } from "../src/core/codemode/protocol.ts";
import { openBot } from "../src/core/bot.ts";
import { definePlugin, loadPlugin } from "../src/plugins/types.ts";

const context = BACKGROUND_CONTEXT;
const dirs: string[] = [];
afterAll(async () => {
	await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

test("bash cell duration uses validated seconds and rejects invalid args without extending", () => {
	const bash = wrapBashWithBudget(createBashTool() as ToolRegistration);
	expect(bashCallDurationMs(bash, { command: "echo ok", timeout: 600 })).toBe(600_000);
	expect(bashCallDurationMs(bash, { command: "echo ok" })).toBe(300_000);
	expect(bashCallDurationMs(bash, "echo ok")).toBe(300_000);
	expect(bashCallDurationMs(bash, JSON.stringify({ command: "echo ok", timeout: 600 }))).toBe(600_000);
	expect(bashCallDurationMs(bash, { command: "echo ok", timeout: 21_600 })).toBe(21_600_000);
	for (const args of [null, [], {}, { timeout: 600 }, ...[0, -1, "bad", 21_601, Infinity, NaN].map(timeout => ({ command: "echo ok", timeout }))]) {
		expect(bashCallDurationMs(bash, args)).toBeUndefined();
	}
	expect(bashCallDurationMs({ ...bash, name: "other" }, { command: "echo ok", timeout: 600 })).toBeUndefined();
});

test("cancellation still aborts an extended bash call promptly", async () => {
	const bash = wrapBashWithBudget(createBashTool() as ToolRegistration);
	const controller = new AbortController();
	let admitted!: () => void;
	const ready = new Promise<void>(resolve => { admitted = resolve; });
	let callSignal: AbortSignal | undefined;
	const result = runCell({
		code: 'return await tools.bash({command: "sleep 600", timeout: 600});',
		names: ["bash"], timeoutMs: 300, signal: controller.signal,
		call: async (_id, _name, args, signal, extend) => {
			callSignal = signal;
			extend(Date.now() + bashCallDurationMs(bash, args)! + LONG_CALL_MARGIN_MS);
			admitted();
			await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
			return "cancelled";
		},
	});
	await ready;
	controller.abort();
	expect((await result).error).toContain("Cell aborted");
	expect(callSignal?.aborted).toBe(true);
}, 5_000);

test("bash explicit and default budgets extend the cell, but the cell hard cap still wins", async () => {
	const limits = CODEMODE_LIMITS as { timeoutMs: number; maxTimeoutMs: number };
	const original = { ...limits };
	limits.timeoutMs = 300;
	try {
		const dir = await mkdtemp(join(tmpdir(), "dinobot-bash-cell-"));
		dirs.push(dir);
		const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
		const models = createModels();
		models.setProvider(faux.provider);
		const storage = await openNodeSqliteStorage(join(dir, "bot.sqlite"));
		const bot = await openBot({ storage, models, defaultModel: { provider: "faux", modelId: "faux-1" }, toolMode: "codemode-only", plugins: [], workspaceRoot: dir }, context);
		try {
			for (const [index, args] of [{ command: "sleep 1; echo bash-done", timeout: 600 }, { command: "sleep 1; echo bash-done" }, { command: "sleep 2; echo bash-done", timeout: 600 }, JSON.stringify({ command: "sleep 1; echo bash-done", timeout: 600 }), "sleep 1; echo bash-done"].entries()) {
				limits.maxTimeoutMs = index === 2 ? 600 : original.maxTimeoutMs;
				let result = "";
				faux.setResponses([
					fauxAssistantMessage(fauxToolCall("codemode", { code: "return await tools.bash(" + JSON.stringify(args) + ");" }), { stopReason: "toolUse" }),
					(transcript) => { result = JSON.stringify(transcript.messages.at(-1)); return fauxAssistantMessage("done"); },
				]);
				await bot.handle({ channel: "test", threadKey: "bash-" + index, messageId: "m1", userId: "U1", text: "go" }, context);
				if (index === 2) {
					expect(result).toContain("Cell timed out");
				} else {
					expect(result).not.toContain("Cell timed out");
					expect(result).toContain("bash-done");
				}
			}
		} finally {
			try { await bot.close(context); } finally { await storage.close(context); }
		}
	} finally { Object.assign(limits, original); }
}, 30_000);

/** Two tools that both sleep past the (shrunken) cell limit; only `slow_long` declares its run time. */
const slow = definePlugin({
	id: "slow",
	config: Type.Object({}),
	load: () => ({
		tools: [
			{ name: "long", description: "sleeps", inputSchema: { type: "object" }, readOnly: true, maxDurationMs: 2_000, execute: async () => (await Bun.sleep(900), "long done") },
			{ name: "plain", description: "sleeps", inputSchema: { type: "object" }, readOnly: true, execute: async () => (await Bun.sleep(900), "plain done") },
		],
	}),
});

test("through the bot, a declared long-running plugin tool extends its codemode cell; an undeclared one is cut", async () => {
	const limits = CODEMODE_LIMITS as { timeoutMs: number };
	const original = limits.timeoutMs;
	// The real limit is 60 s; shrink it so the same sleeps exceed it in a fast test.
	limits.timeoutMs = 300;
	try {
		const dir = await mkdtemp(join(tmpdir(), "dinobot-long-calls-"));
		dirs.push(dir);
		const plugin = await loadPlugin(slow, {});
		if (Array.isArray(plugin)) throw new Error(plugin.join("; "));
		const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
		const models = createModels();
		models.setProvider(faux.provider);
		const storage = await openNodeSqliteStorage(join(dir, "bot.sqlite"));
		const bot = await openBot({ storage, models, defaultModel: { provider: "faux", modelId: "faux-1" }, toolMode: "codemode-only", plugins: [plugin], workspaceRoot: dir }, context);
		try {
			const results: string[] = [];
			let prompt = "";
			faux.setResponses([
				(transcript) => {
					prompt = JSON.stringify(transcript);
					return fauxAssistantMessage(fauxToolCall("codemode", { code: "return await tools.slow_long({});" }), { stopReason: "toolUse" });
				},
				(transcript) => {
					results.push(JSON.stringify(transcript.messages.at(-1)));
					return fauxAssistantMessage(fauxToolCall("codemode", { code: "return await tools.slow_plain({});" }), { stopReason: "toolUse" });
				},
				(transcript) => {
					results.push(JSON.stringify(transcript.messages.at(-1)));
					return fauxAssistantMessage("done");
				},
			]);
			const reply = await bot.handle({ channel: "test", threadKey: "long", messageId: "m1", userId: "U1", text: "go" }, context);
			expect(reply).toMatchObject({ status: "answered", text: "done" });
			expect(results[0]).toContain("long done");
			expect(results[0]).not.toContain("timed out");
			expect(results[1]).toContain("Cell timed out");
			expect(results[1]).not.toContain("plain done");
			expect(prompt).toContain("Bash extends the cell for its validated timeout in seconds (default 300 s when omitted); the whole cell stays under 960 s");
			expect(prompt).toContain("Calls to long-running tools extend the cell to cover their declared run time (slow_long: up to 2 s");
		} finally {
			await bot.close(context);
		}
	} finally {
		limits.timeoutMs = original;
	}
}, 60_000);
