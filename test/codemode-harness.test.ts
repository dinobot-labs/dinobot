import { afterEach, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { type ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage, watchEvents } from "@earendil-works/pi-durable";
import { openBot, type Bot } from "../src/core/bot.ts";
import { TodoDoc } from "../src/extensions/todo.ts";
import type { LoadedPlugin } from "../src/plugins/types.ts";
import { ChatState } from "../src/tui/state.ts";

const bots: Bot[] = [];
afterEach(async () => {
	for (const bot of bots.splice(0)) await bot.close(context);
});
const cell = (code: string) => fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" });
async function setup(plugins: LoadedPlugin[] = [], agents: Parameters<typeof openBot>[0]["agents"] = []) {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "one" }] });
	const models = createModels();
	models.setProvider(faux.provider);
	const bot = await openBot(
		{
			storage: new MemoryStorage(),
			models,
			defaultModel: { provider: "faux", modelId: "one" },
			toolMode: "codemode-only",
			plugins,
			agents,
		},
		context,
	);
	bots.push(bot);
	const conversation = await bot.conversation("test", "nested", context);
	const results = async () =>
		(await conversation.context(context)).messages.filter((m): m is ToolResultMessage => m.role === "toolResult");
	const send = async () =>
		(await conversation.submit({ type: "input", content: "Do the work" }, context)).wait(context);
	return { bot, faux, conversation, results, send };
}

test("empty plugin configuration still offers and executes native tools through codemode", async () => {
	const { bot, faux, conversation, results, send } = await setup();
	let prompt = "";
	faux.setResponses([
		(transcript) => {
			prompt = JSON.stringify(transcript.messages);
			return cell(
				'const r=await tools.todo_write({todos:[{id:"one",content:"verify",status:"in_progress"}]});text(r);text(await tools.session_list({}));',
			);
		},
		fauxAssistantMessage("done"),
		fauxAssistantMessage("remaining TODO is unfinished"),
	]);
	await send();
	expect(prompt).toContain("Batch independent reads");
	expect(prompt).toContain("todo_write");
	expect(prompt).not.toContain("All tools are reachable only");
	expect((await bot.harness.snapshot(TodoDoc, conversation.id, context))?.todos[0]?.status).toBe("in_progress");
	const output = (await results())[0]!;
	expect(output.isError).toBe(false);
	expect(output.details).toHaveProperty("todos");
	expect(output.details).toHaveProperty("codemodeCalls");
	// Inner results are receipts, not orphan model-facing toolResult messages.
	expect((await results()).map((m) => m.toolName)).toEqual(["codemode"]);
});

test("sequential built-ins preserve admission order and task memo isolation", async () => {
	const { bot, faux, conversation, results, send } = await setup();
	faux.setResponses([
		cell(
			'text(await Promise.all([tools.todo_write({todos:[{id:"x",content:"first",status:"in_progress"}]}),tools.todo_write({todos:[{id:"x",status:"completed"}]})]));',
		),
		fauxAssistantMessage("done"),
	]);
	await send();
	expect((await bot.harness.snapshot(TodoDoc, conversation.id, context))?.todos).toEqual([
		{ id: "x", content: "first", status: "completed" },
	]);
	const details = (await results())[0]?.details as { codemodeCalls: { id: number; status: string }[] };
	expect(new Set(details.codemodeCalls.map((c) => c.id)).size).toBe(2);
	expect(details.codemodeCalls.every((c) => c.status === "done")).toBe(true);
});

test("plugin arguments are validated inside codemode before any side effect", async () => {
	let writes = 0;
	const plugin: LoadedPlugin = {
		id: "check",
		tools: [
			{
				name: "check_write",
				description: "write",
				inputSchema: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
				execute: async () => ++writes,
			},
		],
	};
	const { faux, results, send } = await setup([plugin]);
	faux.setResponses([cell('text(await tools.check_write({n:"bad"}));'), fauxAssistantMessage("done")]);
	await send();
	expect(writes).toBe(0);
	expect(JSON.stringify(await results())).toContain("isError");
	expect(JSON.stringify(await results())).toContain("n");
});

test("aborting a cell settles owned internal calls even when the implementation ignores its signal", async () => {
	const entered = Promise.withResolvers<void>();
	const { bot, faux, conversation, send } = await setup([
		{
			id: "hang",
			tools: [
				{
					name: "hang_wait",
					description: "hang",
					readOnly: true,
					inputSchema: { type: "object", properties: {} },
					execute: async () => {
						entered.resolve();
						return new Promise(() => {});
					},
				},
			],
		},
	]);
	faux.setResponses([cell("await tools.hang_wait({})")]);
	const submission = send();
	await entered.promise;
	await conversation.abort(context);
	await submission;
	expect((await bot.harness.inspect(context)).tasks).toEqual([]);
}, 5000);

test("parallel subagents have separate ownership and cannot reach task via their codemode", async () => {
	const { bot, faux, results, send } = await setup();
	const child: FauxResponseFactory = (transcript) => {
		const prompt = JSON.stringify(transcript.messages.filter((m) => m.role === "system"));
		expect(prompt).not.toContain("task: Delegate");
		return cell("text(Object.keys(tools));");
	};
	faux.setResponses([
		cell(
			'text(await Promise.all([tools.task({description:"a",prompt:"a"}),tools.task({description:"b",prompt:"b"})]));',
		),
		child,
		child,
		fauxAssistantMessage("child done"),
		fauxAssistantMessage("child done"),
		fauxAssistantMessage("parent done"),
	]);
	await send();
	expect(JSON.stringify(await results())).toContain("child done");
	expect((await bot.harness.inspect(context)).tasks).toEqual([]);
});

test("live and replayed TUI todo state survives a later script failure", async () => {
	const { bot, faux, conversation, send, results } = await setup();
	const state = new ChatState();
	const stream = await watchEvents(bot.harness, conversation.id, context);
	state.apply(stream.snapshot, Date.now());
	stream.start(async (events) => {
		for (const event of events) state.apply(event, Date.now());
	});
	faux.setResponses([
		cell(
			'await tools.todo_write({todos:[{id:"x",content:"persisted",status:"completed"}]});throw new Error("after mutation");',
		),
		fauxAssistantMessage("done"),
	]);
	try {
		await send();
		await Bun.sleep(25);
		expect(state.data.todos).toEqual([{ id: "x", content: "persisted", status: "completed" }]);
		const final = (await results())[0]!;
		expect(final.isError).toBe(true);
		const replay = new ChatState();
		const snapshot = await watchEvents(bot.harness, conversation.id, context);
		try {
			replay.apply(snapshot.snapshot, Date.now());
			expect(replay.data.todos).toEqual(state.data.todos);
		} finally {
			await snapshot.stop();
		}
	} finally {
		await stream.stop();
	}
});

test("status receipts remain queryable after a cell, and another conversation cannot read them", async () => {
	const { bot, faux, conversation, send, results } = await setup();
	faux.setResponses([cell('await tools.todo_write({todos:[{id:"x",content:"done"}]});'), fauxAssistantMessage("done"), fauxAssistantMessage("remaining TODO is unfinished")]);
	await send();
	const id = ((await results())[0]!.details as { codemodeTaskId: number }).codemodeTaskId;
	expect(id).toBeGreaterThan(0);
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("codemode_status", { task_id: id }), { stopReason: "toolUse" }),
		fauxAssistantMessage("checked"),
		fauxAssistantMessage("remaining TODO is unfinished"),
	]);
	await send();
	expect((await results()).at(-1)?.content).toEqual(
		expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('"outcome":"completed"') })]),
	);
	const other = await bot.conversation("test", "other", context);
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("codemode_status", { task_id: id }), { stopReason: "toolUse" }),
		fauxAssistantMessage("checked"),
	]);
	await (await other.submit({ type: "input", content: "check" }, context)).wait(context);
	expect(JSON.stringify((await other.context(context)).messages)).toContain("No codemode receipt in this conversation");
});

test("a custom subagent's allowlist also narrows the worker bridge and prompt catalog", async () => {
	let forbidden = 0;
	const { faux, send } = await setup(
		[
			{
				id: "secret",
				tools: [
					{
						name: "secret_read",
						description: "forbidden capability",
						inputSchema: { type: "object" },
						execute: async () => ++forbidden,
					},
				],
			},
		],
		[
			{
				name: "restricted",
				description: "restricted",
				tools: ["codemode", "session_list"],
				prompt: "Only inspect sessions",
			},
		],
	);
	faux.setResponses([
		cell('text(await tools.task({description:"scoped",prompt:"inspect",subagent_type:"restricted"}));'),
		(transcript) => {
			expect(JSON.stringify(transcript.messages)).not.toContain("forbidden capability");
			return cell("text(Object.keys(tools));text(await tools.secret_read({}));");
		},
		fauxAssistantMessage("child done"),
		fauxAssistantMessage("parent done"),
	]);
	await send();
	expect(forbidden).toBe(0);
});

test("background task spawned inside a failed cell survives; timeout observes it and kill joins it", async () => {
	const { bot, faux, conversation, results } = await setup();
	const started = Promise.withResolvers<void>();
	const stopped = Promise.withResolvers<void>();
	let taskId = "";
	const router: FauxResponseFactory = async (transcript, options) => {
		const user = transcript.messages.findLast((message) => message.role === "user");
		if (user?.content === "long background") {
			started.resolve();
			return new Promise((resolve) =>
				options?.signal?.addEventListener(
					"abort",
					() => {
						stopped.resolve();
						resolve(fauxAssistantMessage("", { stopReason: "aborted" }));
					},
					{ once: true },
				),
			);
		}
		if (transcript.messages.at(-1)?.role === "toolResult") return fauxAssistantMessage("parent done");
		if (user?.content === "spawn")
			return cell(
				'text(await tools.task({description:"background",prompt:"long background",run_in_background:true}));throw new Error("after spawn");',
			);
		if (user?.content === "observe") return cell("text(await tools.task_output({timeout_ms:1}));");
		return cell(`text(await tools.kill_task({task_id:${JSON.stringify(taskId)}}));`);
	};
	faux.setResponses(Array.from({ length: 20 }, () => router));
	const send = async (content: string) =>
		(await conversation.submit({ type: "input", content }, context)).wait(context);
	try {
		await send("spawn");
		await started.promise;
		const result = (await results())[0]!;
		taskId = (result.details as { subagent: { taskId: string } }).subagent.taskId;
		expect(result.isError).toBe(true);
		expect(taskId).toMatch(/^sa-/);
		await send("observe");
		expect(
			(await bot.harness.inspect(context)).tasks.some(
				(task) => task.record.background && task.record.kind === "dinobot.subagent",
			),
		).toBe(true);
		await conversation.abort(context);
		await send("kill");
		await stopped.promise;
		expect((await bot.harness.inspect(context)).tasks).toEqual([]);
	} finally {
		await conversation.abort(context, { background: true });
	}
}, 5000);
