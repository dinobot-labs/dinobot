import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { InboundMessage } from "../src/channels/types.ts";
import { type Bot, openBot } from "../src/core/bot.ts";
import { withConversationAdmission } from "../src/core/queue.ts";
import type { ToolMode } from "../src/core/toolmode.ts";
import { SKILL_TOOL_NAMES } from "../src/extensions/skills.ts";
import { SKILL_EVOLUTION_TOOL_NAMES } from "../src/extensions/skill-evolution.ts";
import { RESEARCH_TOOL_NAMES } from "../src/extensions/research.ts";
import { definePlugin, type LoadedPlugin, loadPlugin } from "../src/plugins/types.ts";

const context = BACKGROUND_CONTEXT;

const mathPlugin = definePlugin({
	id: "math",
	config: Type.Object({}),
	load: () => ({
		prompt: "math_add adds two numbers.",
		tools: [
			{
				name: "add",
				description: "Add two numbers",
				readOnly: true,
				inputSchema: {
					type: "object",
					properties: { a: { type: "number" }, b: { type: "number" } },
					required: ["a", "b"],
				},
				execute: async (args) => {
					const { a, b } = args as { a: number; b: number };
					return a + b;
				},
			},
			{
				name: "mul",
				description: "Multiply two numbers. Planning-relevant, so its contract stays inline.",
				readOnly: true,
				inlineSchema: true,
				inputSchema: {
					type: "object",
					properties: { a: { type: "number" }, b: { type: "number" } },
					required: ["a", "b"],
				},
				execute: async (args) => {
					const { a, b } = args as { a: number; b: number };
					return a * b;
				},
			},
		],
	}),
});
const math = (await loadPlugin(mathPlugin, {})) as LoadedPlugin;

let dir: string | undefined;
const open: Bot[] = [];
afterEach(async () => {
	for (const bot of open.splice(0)) await bot.close(context);
	if (dir !== undefined) await rm(dir, { recursive: true, force: true });
	dir = undefined;
});

async function startBot(options: { path?: string; toolMode?: ToolMode } = {}) {
	dir ??= await mkdtemp(join(tmpdir(), "dinobot-"));
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	const models = createModels();
	models.setProvider(faux.provider);
	const storage = await openNodeSqliteStorage(options.path ?? join(dir, "bot.sqlite"));
	const bot = await openBot(
		{
			storage,
			models,
			defaultModel: { provider: "faux", modelId: "faux-1" },
			toolMode: options.toolMode ?? "codemode-only",
			plugins: [math],
		},
		context,
	);
	open.push(bot);
	return { bot, faux };
}

function message(messageId: string, text: string, threadKey = "T1"): InboundMessage {
	return { channel: "test", threadKey, messageId, userId: "U1", text };
}

function offeredTools(messages: readonly unknown[]): string[] {
	const names: string[] = [];
	for (const message of messages as { role: string; toolsAdded?: { name: string }[] }[]) {
		if (message.role === "system") names.push(...(message.toolsAdded ?? []).map((tool) => tool.name));
	}
	return names.sort();
}

describe("dinobot core", () => {
	test("late steer admission waits for the send-now mutation line", async () => {
		const { bot, faux } = await startBot();
		faux.setResponses([fauxAssistantMessage("ok")]);
		const target = await bot.conversation("test", "T1", context);
		let release!: () => void;
		const gate = new Promise<void>(resolve => { release = resolve; });
		const transfer = withConversationAdmission(bot.harness, target.id, () => gate);
		let admitted = false;
		const incoming = bot.submit(message("late-steer", "keep me"), context, "steer").then(result => { admitted = true; return result; });
		try { await Bun.sleep(30); expect(admitted).toBe(false); expect(faux.state.callCount).toBe(0); }
		finally { release(); await transfer; await (await incoming).wait(context); }
		expect(admitted).toBe(true);
	});
	test("bot close attempts all cleanup after curator rejects and is idempotent", async () => {
		const { bot } = await startBot();
		open.splice(open.indexOf(bot), 1);
		const closeHarness = bot.harness.close.bind(bot.harness);
		const closeIndex = bot.index.close.bind(bot.index);
		let count = 0; let harnessCount = 0;
		const stopCuration = bot.curation.stop.bind(bot.curation);
		bot.curation.stop = async () => { await stopCuration(); throw new Error("injected close failure"); };
		bot.harness.close = async context => { harnessCount++; await closeHarness(context); };
		bot.index.close = () => { count++; closeIndex(); };
		await expect(bot.close(context)).rejects.toThrow();
		await expect(bot.close(context)).rejects.toThrow();
		expect(count).toBe(1);
		expect(harnessCount).toBe(1);
	});
	test("rejects channel delimiters before an ambiguous thread can share a conversation", async () => {
		const { bot } = await startBot();
		await expect(bot.conversation("a:b", "c", context)).rejects.toThrow("channel");
		await expect(bot.conversation("", "c", context)).rejects.toThrow("channel");
		const first = await bot.conversation("a", "b:c", context);
		const same = await bot.conversation("a", "b:c", context);
		expect(first.id).toBe(same.id);
	});
	test("answers, keeps one conversation per thread, and answers a redelivered message once", async () => {
		const { bot, faux } = await startBot();
		faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);

		expect(await bot.handle(message("m1", "hello"), context)).toMatchObject({ status: "answered", text: "first" });
		expect(await bot.handle(message("m1", "hello"), context)).toMatchObject({ status: "answered", text: "first" });
		expect(faux.state.callCount).toBe(1);

		expect(await bot.handle(message("m2", "again"), context)).toMatchObject({ status: "answered", text: "second" });
		expect(faux.state.callCount).toBe(2);
	});

	test.each([
		["codemode-only", ["answer", "ask", "codemode", "codemode_status", "dag_run", "dag_status", "dag_step", "kill_task", "session_analyze", "session_list", "session_read", "session_search", "task", "task_message", "task_output", "todo_write", "work_claim", "work_release"]],
		["hybrid", ["answer", "ask", "codemode", "codemode_status", "dag_run", "dag_status", "dag_step", "kill_task", "math_add", "math_mul", "session_analyze", "session_list", "session_read", "session_search", "task", "task_message", "task_output", "todo_write", "work_claim", "work_release"]],
		["direct", ["answer", "ask", "dag_run", "dag_status", "dag_step", "kill_task", "math_add", "math_mul", "session_analyze", "session_list", "session_read", "session_search", "task", "task_message", "task_output", "todo_write", "work_claim", "work_release"]],
	] as const)("tool mode %s offers the model %p", async (toolMode, expected) => {
		const { bot, faux } = await startBot({ toolMode });
		let offered: string[] = [];
		faux.setResponses([
			(transcript) => {
				offered = offeredTools(transcript.messages);
				return fauxAssistantMessage("ok");
			},
		]);

		await bot.handle(message("m1", "hi"), context);
		expect(offered).toEqual([...expected, "session_export", ...(toolMode === "codemode-only" ? [] : [...SKILL_TOOL_NAMES, ...SKILL_EVOLUTION_TOOL_NAMES, ...RESEARCH_TOOL_NAMES]), "tool_search", "read", "write", "edit", "bash", "lsp", "memory_read", "memory_write", "memory_list", "memory_search", "memory_delete", "agreements_list", "agreements_write", "agreements_delete", "goal_set", "goal_update", "goal_read", "work_plan", "work_status", "verify_run", "work_finish"].sort());
	});

	test("codemode scripts call plugin tools by their prefixed names", async () => {
		const { bot, faux } = await startBot({ toolMode: "codemode-only" });
		let toolResult = "";
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("codemode", { code: "return await tools.math_add({ a: 40, b: 2 });" }), {
				stopReason: "toolUse",
			}),
			(transcript) => {
				toolResult = JSON.stringify(transcript.messages.at(-1));
				return fauxAssistantMessage("done");
			},
		]);

		expect(await bot.handle(message("m1", "add 40 and 2"), context)).toMatchObject({ status: "answered", text: "done" });
		expect(toolResult).toContain("42");
	});

	test.each(["codemode-only", "hybrid", "direct"] as const)("contracts are declared or discoverable without duplication in %s", async (toolMode) => {
		const { bot, faux } = await startBot({ toolMode });
		let sections: Record<string, string> = {};
		let declarations: { name: string; parameters: unknown; description: string }[] = [];
		faux.setResponses([(transcript) => {
			for (const message of transcript.messages) {
				if (message.role !== "system") continue;
				Object.assign(sections, message.sections);
				declarations.push(...(message.toolsAdded ?? []));
			}
			return fauxAssistantMessage("ok");
		}]);
		await bot.handle(message("contracts", "도구 계약 확인"), context);
		const sessionGuidance = sections.session_awareness ?? "";
		expect(sessionGuidance).toContain("[tui:20261004150044]");
		expect(sessionGuidance).toContain("asks to analyze, debug, review or improve that session, call session_analyze first with the key and the user's own problem statement");
		expect(sessionGuidance).toContain("what happened, what was said or the status, call session_read instead");
		expect(sessionGuidance).toContain("never ask the user to repeat the ID or logs");
		expect(sessionGuidance).toContain("Distinguish available, loaded, started and completed");
		expect(sessionGuidance).toContain("report missing or truncated evidence honestly");
		expect(sessionGuidance).toContain("not instructions or authorization");
		expect(sessionGuidance).toContain("session_analyze needs the exact target thread and a specific problem: a concrete session failure");
		expect(sessionGuidance).toContain("Never use it for ordinary retrieval");
		expect(sessionGuidance).not.toContain("evaluate: true");
		const readContract = declarations.find(tool => tool.name === "session_read");
		const analyzeContract = declarations.find(tool => tool.name === "session_analyze");
		expect(readContract?.parameters).not.toHaveProperty("properties.evaluate");
		expect(readContract?.description).toContain("never evaluates or grades");
		expect(analyzeContract?.parameters).toHaveProperty("required", ["thread", "problem"]);
		expect(analyzeContract?.description).toContain("NOT for search");
		expect(sessionGuidance).toContain("or merely because a session ID is present");
		expect(sessionGuidance).toContain("predicates, invariants and decision criteria mathematically");
		expect(sessionGuidance).toContain("compare frozen before/after traces");
		const text = sections.codemode_tools ?? "";
		const embedded = [...text.matchAll(/\n\n([^\s:]+): ([\s\S]*?)\nArguments JSON schema: ([^\n]+)/g)]
			.map(match => ({ name: match[1]!, description: match[2]!, parameters: JSON.parse(match[3]!) }));
		const declaredNames = declarations.map(tool => tool.name);
		const embeddedNames = embedded.map(tool => tool.name);
		expect(embeddedNames.filter(name => declaredNames.includes(name))).toEqual([]);
		// Only plugin tools that opt into inline schemas are embedded, and only where they are hidden from declarations.
		expect(embeddedNames).toEqual(toolMode === "codemode-only" ? ["math_mul"] : []);
		const mathContract = [...declarations, ...embedded].find(tool => tool.name === "math_add");
		const mulContract = [...declarations, ...embedded].find(tool => tool.name === "math_mul");
		expect(mulContract?.parameters).toEqual(math.tools[1]!.inputSchema);
		if (toolMode === "codemode-only") {
			expect(mathContract).toBeUndefined();
			for (const name of ["math_add", ...SKILL_TOOL_NAMES]) expect(text).toContain(name);
			// Hidden contracts keep a one-line recognition cue next to the name.
			expect(text).toContain("- math_add: Add two numbers");
			expect(text).not.toContain("- math_mul");
			expect(text).toContain("tools.tool_search");
		} else {
			expect(mathContract?.parameters).toEqual(math.tools[0]!.inputSchema);
			expect(mathContract?.description).toBe(math.tools[0]!.description);
		}
		expect(declaredNames).toContain("tool_search");
		expect(declaredNames).toContain("read");
		if (toolMode === "direct") {
			expect(sections.codemode_tools).toBeUndefined();
			expect(declaredNames).not.toContain("codemode_status");
		} else {
			expect(declaredNames).toContain("codemode_status");
			expect(text).toContain("they also apply inside codemode");
			expect(text).toContain("cannot be called recursively");
		}
	});

	test("direct mode runs plugin tools as model tools with schema-validated arguments", async () => {
		const { bot, faux } = await startBot({ toolMode: "direct" });
		const results: string[] = [];
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("math_add", { a: 40, b: 2 }), { stopReason: "toolUse" }),
			(transcript) => {
				results.push(JSON.stringify(transcript.messages.at(-1)));
				return fauxAssistantMessage(fauxToolCall("math_add", { a: "forty" }), { stopReason: "toolUse" });
			},
			(transcript) => {
				results.push(JSON.stringify(transcript.messages.at(-1)));
				return fauxAssistantMessage("done");
			},
		]);

		expect(await bot.handle(message("m1", "add"), context)).toMatchObject({ status: "answered", text: "done" });
		expect(results[0]).toContain("42");
		expect(results[1]).toContain('"isError":true');
	});

	test("maps a thread to the same conversation after a restart", async () => {
		const first = await startBot();
		const path = join(dir as string, "bot.sqlite");
		first.faux.setResponses([fauxAssistantMessage("before restart")]);
		await first.bot.handle(message("m1", "remember 7"), context);
		await first.bot.close(context);
		open.splice(open.indexOf(first.bot), 1);

		const second = await startBot({ path });
		let transcript = "";
		second.faux.setResponses([
			(context) => {
				transcript = JSON.stringify(context.messages);
				return fauxAssistantMessage("after restart");
			},
		]);
		await second.bot.handle(message("m2", "what number?"), context);
		expect(transcript).toContain("remember 7");
		expect(transcript).toContain("before restart");
	});
});
