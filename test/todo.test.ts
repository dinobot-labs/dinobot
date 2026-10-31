import { afterEach, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage, type Conversation, type JsonObject } from "@earendil-works/pi-durable";
import { type Bot, openBot } from "../src/core/bot.ts";
import { TodoDoc } from "../src/extensions/todo.ts";

const context = BACKGROUND_CONTEXT;
const bots: Bot[] = [];
afterEach(async () => {
	for (const bot of bots.splice(0)) await bot.close(context);
});

async function setup() {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	const models = createModels();
	models.setProvider(faux.provider);
	const bot = await openBot({
		storage: new MemoryStorage(), models, defaultModel: { provider: "faux", modelId: "faux-1" },
		toolMode: "codemode-only", plugins: [],
	}, context);
	bots.push(bot);
	const conversation = await bot.conversation("test", "todo", context);
	async function call(args: JsonObject, target: Conversation = conversation) {
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("todo_write", args), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
			// The yield hook asks to reconcile unfinished TODOs; this tool fixture makes no further changes.
			fauxAssistantMessage("progress recorded; remaining work is unfinished"),
		]);
		const submission = await target.submit({ type: "input", content: "Update progress" }, context);
		expect((await submission.wait(context)).status).toBe("done");
		const result = (await target.entries({}, 10, undefined, context)).items.flatMap((entry) => entry.model ?? [])
			.find((message): message is ToolResultMessage => message.role === "toolResult");
		if (!result) throw new Error("Missing todo result");
		return result;
	}
	return { bot, conversation, call };
}

test("todo_write merges by id, preserves omitted fields and appends new items", async () => {
	const { call } = await setup();
	await call({ todos: [{ id: "read", content: "Read code", status: "in_progress" }, { id: "build", content: "Build tool" }] });
	const result = await call({ todos: [{ id: "read", status: "completed" }, { id: "build", content: "Build revised tool" }, { id: "verify", content: "Run checks", status: "in_progress" }] });
	expect(result.details).toEqual({ todos: [
		{ id: "read", content: "Read code", status: "completed" },
		{ id: "build", content: "Build revised tool", status: "pending" },
		{ id: "verify", content: "Run checks", status: "in_progress" },
	] });
	expect(result.content).toEqual([{ type: "text", text: "- [completed] read: Read code\n- [pending] build: Build revised tool\n- [in_progress] verify: Run checks" }]);
});

test("todo_write replaces the list and accepts an empty replacement", async () => {
	const { call } = await setup();
	await call({ todos: [{ id: "old", content: "Old item" }] });
	expect((await call({ merge: false, todos: [{ id: "new", content: "New item", status: "cancelled" }] })).details)
		.toEqual({ todos: [{ id: "new", content: "New item", status: "cancelled" }] });
	expect((await call({ merge: false, todos: [] })).details).toEqual({ todos: [] });
});

test.each([
	{ todos: [{ id: "new" }] },
	{ todos: [] },
	{ todos: [{ id: "old", status: "invalid" }] },
	{ todos: [{ id: "old", status: "completed" }, { id: "new" }] },
	{ merge: false, todos: [{ id: "new" }] },
	{ todos: [{ id: "same", content: "One" }, { id: "same", content: "Two" }] },
])("todo_write rejects invalid update %p atomically", async (args) => {
	const { bot, conversation, call } = await setup();
	await call({ todos: [{ id: "old", content: "Existing item", status: "in_progress" }] });
	const before = await bot.harness.snapshot(TodoDoc, conversation.id, context);
	const result = await call(JSON.parse(JSON.stringify(args)));
	expect(result.isError).toBe(true);
	expect(result.content.some((block) => block.type === "text" && block.text.length > 0)).toBe(true);
	expect(await bot.harness.snapshot(TodoDoc, conversation.id, context)).toEqual(before);
});

test("todo_write fork inherits the list at the selected entry, not later edits", async () => {
	const { bot, conversation, call } = await setup();
	await call({ todos: [{ id: "one", content: "First item", status: "in_progress" }] });
	const entry = (await conversation.entries({}, 1, undefined, context)).items[0];
	if (!entry) throw new Error("Missing fork point");
	await call({ todos: [{ id: "one", status: "completed" }] });
	const fork = await conversation.fork(entry.id, { ownership: { kind: "ownerless" } }, context);
	expect(await bot.harness.snapshot(TodoDoc, fork.id, context)).toEqual({ todos: [
		{ id: "one", content: "First item", status: "in_progress" },
	] });
	expect((await call({ todos: [{ id: "one", status: "cancelled" }] }, fork)).isError).toBe(false);
	expect(await bot.harness.snapshot(TodoDoc, conversation.id, context)).toEqual({ todos: [
		{ id: "one", content: "First item", status: "completed" },
	] });
});

for (const toolMode of ["direct", "hybrid", "codemode-only"] as const) {
	test(`${toolMode}: the system prompt asks for a visible todo plan on coding work too`, async () => {
		const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
		const models = createModels();
		models.setProvider(faux.provider);
		const bot = await openBot({ storage: new MemoryStorage(), models, defaultModel: { provider: "faux", modelId: "faux-1" }, toolMode, plugins: [] }, context);
		bots.push(bot);
		let prompt = "";
		faux.setResponses([(transcript) => {
			prompt = JSON.stringify(transcript.messages);
			return fauxAssistantMessage("done");
		}]);
		const conversation = await bot.conversation("test", `prompt-${toolMode}`, context);
		await (await conversation.submit({ type: "input", content: "Fix the bug" }, context)).wait(context);
		expect(prompt).toContain("coding work included: write the list before the first edit or command");
		expect(prompt).toContain("todos never certify anything");
	});
}
