import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context as ModelContext, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { type Conversation, defineTask, type JsonObject, MemoryStorage, type Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { LinkDoc } from "../src/core/ask.ts";
import { type Bot, openBot } from "../src/core/bot.ts";
import { GoalDoc } from "../src/core/goal.ts";
import { goalExtension } from "../src/extensions/goal.ts";
import type { ToolMode } from "../src/core/toolmode.ts";

const context = BACKGROUND_CONTEXT;
const bots: { bot: Bot; storage?: Storage }[] = [];
const dirs: string[] = [];
afterEach(async () => {
	for (const { bot, storage } of bots.splice(0)) { await bot.close(context); await storage?.close(context); }
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const goal = {
	objective: "Ship the checkout latency fix",
	criteria: [
		{ id: "p95", statement: "Checkout stays fast", check: { kind: "numeric", metric: "p95_latency", comparator: "<=", target: 250, unit: "ms", method: "bench, 3 runs" } },
		{ id: "tests", statement: "Suite is green", check: { kind: "binary", observable: "bun test exits 0", method: "run bun test" } },
		{ id: "copy", statement: "Error copy reads naturally", check: { kind: "rubric", levels: [{ score: 1, description: "robotic" }, { score: 3, description: "clear" }, { score: 5, description: "native" }], passAt: 3, method: "self-review" } },
	],
	scope: { in: ["server checkout path"], out: ["client caching"] },
	assumptions: ["staging data is representative"],
};

async function open(options: { toolMode?: ToolMode; storage?: Storage } = {}) {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	const models = createModels();
	models.setProvider(faux.provider);
	const bot = await openBot({
		storage: options.storage ?? new MemoryStorage(), models, defaultModel: { provider: "faux", modelId: "faux-1" },
		toolMode: options.toolMode ?? "direct", plugins: [],
	}, context);
	bots.push({ bot, ...(options.storage ? { storage: options.storage } : {}) });
	const conversation = await bot.conversation("test", "goal", context);
	return { bot, faux, conversation };
}

function goalSection(messages: readonly Message[]): string | undefined {
	let section: string | undefined;
	for (const message of messages as (Message & { sections?: Record<string, string | null> })[]) {
		if (message.role !== "system" || !message.sections || !("goal" in message.sections)) continue;
		section = message.sections.goal ?? undefined;
	}
	return section;
}

async function call(target: { faux: ReturnType<typeof fauxProvider>; conversation: Conversation }, name: string, args: JsonObject, mode: ToolMode = "direct"): Promise<ToolResultMessage> {
	const toolCall = mode === "direct" ? fauxToolCall(name, args) : fauxToolCall("codemode", { code: `text(resultText(await tools.${name}(${JSON.stringify(args)})));` });
	// ADR 0096: a turn that leaves an active goal with open criteria and nothing pending is continued once by the host;
	// the continued answer makes no tool call (no progress), so the run then ends.
	target.faux.setResponses([fauxAssistantMessage(toolCall, { stopReason: "toolUse" }), fauxAssistantMessage("done"), fauxAssistantMessage("noted")]);
	expect((await (await target.conversation.submit({ type: "input", content: `call ${name}` }, context)).wait(context)).status).toBe("done");
	const result = (await target.conversation.entries({}, 10, undefined, context)).items.flatMap((entry) => entry.model ?? [])
		.find((message): message is ToolResultMessage => message.role === "toolResult");
	if (!result) throw new Error(`Missing ${name} result`);
	return result;
}

async function nextSection(target: { faux: ReturnType<typeof fauxProvider>; conversation: Conversation }): Promise<string | undefined> {
	let seen: ModelContext | undefined;
	target.faux.setResponses([(request) => { seen = request; return fauxAssistantMessage("ok"); }]);
	await (await target.conversation.submit({ type: "input", content: "continue" }, context)).wait(context);
	return seen ? goalSection(seen.messages) : undefined;
}

const pending = defineTask<Record<string, never>, { phase: "wait" }, string>({
	name: "test.goal-replay", version: 1, initial: () => ({ phase: "wait" }),
	phases: { wait: () => new Promise<void>(() => {}) },
	abort: async (_task, runtime, context) => { await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context); },
});

const textOf = (result: ToolResultMessage) => result.content.map((block) => (block.type === "text" ? block.text : "")).join("");

test("goal_set persists the goal and every later request carries the goal section", async () => {
	const target = await open();
	const result = await call(target, "goal_set", goal as unknown as JsonObject);
	expect(result.isError).toBeFalsy();
	const stored = (await target.bot.harness.snapshot(GoalDoc, target.conversation.id, context))?.goal;
	expect(stored).toMatchObject({ objective: goal.objective, revision: 1, status: "active" });
	expect(stored?.criteria.map((criterion) => criterion.status)).toEqual(["open", "open", "open"]);
	const section = await nextSection(target);
	expect(section).toContain("Objective: Ship the checkout latency fix");
	expect(section).toContain("numeric: p95_latency <= 250 ms via bench, 3 runs");
	expect(section).toContain("binary: bun test exits 0 via run bun test");
	expect(section).toContain("rubric: pass at >=3/5");
});

test("codemode reaches the goal tools through tools.goal_*", async () => {
	const target = await open({ toolMode: "codemode-only" });
	const set = await call(target, "goal_set", goal as unknown as JsonObject, "codemode-only");
	expect(set.isError).toBeFalsy();
	const read = await call(target, "goal_read", {}, "codemode-only");
	expect(textOf(read)).toContain("Ship the checkout latency fix");
	expect((await target.bot.harness.snapshot(GoalDoc, target.conversation.id, context))?.goal?.revision).toBe(1);
});

const invalid: [string, JsonObject[], string][] = [
	["no criteria", [], "criteria: 1-12 criteria"],
	["numeric without a metric", [{ id: "a", statement: "s", check: { kind: "numeric", metric: "", comparator: "<=", target: 3, method: "x" } }], "metric: name the measured quantity"],
	["binary without an observable", [{ id: "a", statement: "s", check: { kind: "binary", observable: " ", method: "x" } }], "observable"],
	["rubric with one level", [{ id: "a", statement: "s", check: { kind: "rubric", levels: [{ score: 1, description: "d" }], passAt: 1, method: "x" } }], "2-5 levels"],
	["rubric with descending scores", [{ id: "a", statement: "s", check: { kind: "rubric", levels: [{ score: 3, description: "d" }, { score: 1, description: "e" }], passAt: 3, method: "x" } }], "strictly ascending"],
	["rubric passAt off the levels", [{ id: "a", statement: "s", check: { kind: "rubric", levels: [{ score: 1, description: "d" }, { score: 3, description: "e" }], passAt: 2, method: "x" } }], "passAt"],
	["duplicate ids", [goal.criteria[1] as unknown as JsonObject, goal.criteria[1] as unknown as JsonObject], "duplicate id"],
	["check without a method", [{ id: "a", statement: "s", check: { kind: "binary", observable: "o", method: "" } }], "method"],
];
test.each(invalid)("goal_set rejects %s and stores nothing", async (_label, criteria, expected) => {
	const target = await open();
	const result = await call(target, "goal_set", { objective: "o", criteria });
	expect(result.isError).toBe(true);
	expect(textOf(result)).toContain(expected);
	expect(textOf(result)).toContain('"kind":"rubric"');
	expect((await target.bot.harness.snapshot(GoalDoc, target.conversation.id, context))?.goal).toBeUndefined();
});

test("goal_set refuses to silently replace an active goal", async () => {
	const target = await open();
	await call(target, "goal_set", goal as unknown as JsonObject);
	const replaced = await call(target, "goal_set", { ...goal, objective: "Something else" } as unknown as JsonObject);
	expect(replaced.isError).toBe(true);
	expect(textOf(replaced)).toContain("expected_revision 1");
	expect((await call(target, "goal_set", { ...goal, objective: "Something else", expected_revision: 1 } as unknown as JsonObject)).isError).toBeFalsy();
	expect((await target.bot.harness.snapshot(GoalDoc, target.conversation.id, context))?.goal).toMatchObject({ objective: "Something else", revision: 2 });
});

test("goal_update enforces revision, evidence and achievement rules", async () => {
	const target = await open();
	await call(target, "goal_set", goal as unknown as JsonObject);
	expect(textOf(await call(target, "goal_update", { expected_revision: 7, add_assumptions: ["x"] }))).toContain("Stale expected_revision 7");
	expect(textOf(await call(target, "goal_update", { expected_revision: 1, criteria: [{ id: "tests", status: "met" }] }))).toContain("needs the observed evidence");
	expect(textOf(await call(target, "goal_update", { expected_revision: 1, status: "achieved" }))).toContain("not met: p95, tests, copy");
	const met = await call(target, "goal_update", {
		expected_revision: 1,
		criteria: [{ id: "tests", status: "met", evidence: "bun test: 12 pass, 0 fail" }],
		add_decisions: [{ text: "Use the staging dataset", askId: "ask-1", quote: "staging is fine" }],
	});
	expect(met.isError).toBeFalsy();
	const stored = (await target.bot.harness.snapshot(GoalDoc, target.conversation.id, context))!;
	expect(stored.goal).toMatchObject({ revision: 2, decisions: [{ text: "Use the staging dataset", askId: "ask-1" }] });
	expect(stored.goal?.criteria.find((criterion) => criterion.id === "tests")).toMatchObject({ status: "met", evidence: "bun test: 12 pass, 0 fail" });
	expect(stored.history.map((entry) => entry.revision)).toEqual([1, 2]);
	expect(await nextSection(target)).toContain("- [met] tests: Suite is green");
});

test("a replayed goal tool task returns its first receipt instead of applying twice", async () => {
	const target = await open();
	await call(target, "goal_set", goal as unknown as JsonObject);
	const taskId = await target.bot.harness.commit((tx) => tx.createTask(pending, {}, { conversationId: target.conversation.id, ownership: { kind: "conversation" }, background: true }), context);
	const tool = goalExtension().tools!.find((item) => item.name === "goal_update")!;
	const api = {
		taskId, conversationId: target.conversation.id,
		commit: target.bot.harness.commit.bind(target.bot.harness),
		snapshot: target.bot.harness.snapshot.bind(target.bot.harness),
	} as unknown as Parameters<typeof tool.execute>[1];
	const args = { expected_revision: 1, add_assumptions: ["only once"] };
	const first = await tool.execute(args as never, api, context);
	const replay = await tool.execute(args as never, api, context);
	expect(replay).toEqual(first);
	const stored = (await target.bot.harness.snapshot(GoalDoc, target.conversation.id, context))?.goal;
	expect(stored?.revision).toBe(2);
	expect(stored?.assumptions).toEqual(["staging data is representative", "only once"]);
});

test("the goal section survives compaction and a storage reopen byte for byte", async () => {
	const dir = await realpath(await mkdtemp(join(tmpdir(), "dinobot-goal-")));
	dirs.push(dir);
	const path = join(dir, "bot.sqlite");
	const first = await open({ storage: await openNodeSqliteStorage(path) });
	await call(first, "goal_set", goal as unknown as JsonObject);
	const before = await nextSection(first);
	expect(before).toContain(goal.objective);
	first.faux.setResponses([fauxAssistantMessage("Summary: the user discussed checkout work.")]);
	const compacted = await first.bot.harness.waitForTask(await first.conversation.compact(undefined, context), context);
	expect(compacted.state.outcome.status).toBe("completed");
	expect(await nextSection(first)).toBe(before);
	const { bot, storage } = bots.pop()!;
	await bot.close(context);
	await storage?.close(context);
	const reopened = await open({ storage: await openNodeSqliteStorage(path) });
	expect(await nextSection(reopened)).toBe(before);
});

test("a subagent conversation sees its orchestrator's goal read-only", async () => {
	const parent = await open();
	await call(parent, "goal_set", goal as unknown as JsonObject);
	const child = await parent.bot.conversation("test", "child", context);
	await parent.bot.harness.commit(async (tx) => { (await tx.doc(LinkDoc, child.id)).parent = parent.conversation.id; }, context);
	const section = await nextSection({ faux: parent.faux, conversation: child });
	expect(section).toContain("Parent goal (read-only; set by the orchestrator):");
	expect(section).toContain(goal.objective);
});

test("goal guidance is always present and an unset goal renders a goal_set reminder", async () => {
	const target = await open();
	let seen: ModelContext | undefined;
	target.faux.setResponses([(request) => { seen = request; return fauxAssistantMessage("ok"); }]);
	await (await target.conversation.submit({ type: "input", content: "hello" }, context)).wait(context);
	const sections = (seen?.messages ?? []).flatMap((message) => (message.role === "system" ? Object.keys((message as { sections?: object }).sections ?? {}) : []));
	expect(sections).toContain("goal_guidance");
	expect(goalSection(seen?.messages ?? [])).toContain("No goal is set for this conversation.");
});
