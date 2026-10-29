import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { type Harness, MemoryStorage, type ToolExecutionApi, type ToolRegistration, watchEvents } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { type Bot, openBot } from "../src/core/bot.ts";
import type { TaskDetails, TaskOutputDetails } from "../src/core/ui-contract.ts";

import type { InboundMessage } from "../src/channels/types.ts";
import { loadAgents, ProgressDoc, subagentsExtension } from "../src/extensions/subagents.ts";
import type { WorkService } from "../src/core/verification.ts";
import { parseManifest } from "../src/manifest.ts";

const context = BACKGROUND_CONTEXT;
const bots: Bot[] = [];
const dirs: string[] = [];
afterEach(async () => {
	for (const bot of bots.splice(0)) await bot.close(context);
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function setup(path?: string, bootResponse?: FauxResponseFactory) {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	if (bootResponse) faux.setResponses(Array.from({ length: 10 }, () => bootResponse));
	const models = createModels();
	models.setProvider(faux.provider);
	const bot = await openBot({
		storage: path ? await openNodeSqliteStorage(path) : new MemoryStorage(), models, defaultModel: { provider: "faux", modelId: "faux-1" },
		toolMode: "codemode-only", plugins: [], settings: { retry: { enabled: false } },
	}, context);
	bots.push(bot);
	const parent = await bot.conversation("test", "agents", context);
	async function results() {
		return (await parent.entries({}, 100, undefined, context)).items.flatMap((entry) => entry.model ?? [])
			.filter((message): message is ToolResultMessage => message.role === "toolResult");
	}
	async function input(content: string) {
		const submission = await parent.submit({ type: "input", content }, context);
		return submission.wait(context);
	}
	return { bot, faux, parent, results, input };
}

const tasks = [
	{ description: "First child", prompt: "Solve the first part" },
	{ description: "Second child", prompt: "Solve the second part", subagent_type: "explore" },
];
const parallelCalls = () => fauxAssistantMessage(tasks.map((task) => fauxToolCall("task", task)), { stopReason: "toolUse" });

test("foreground task calls run concurrently with progress and without nested tools", async () => {
	const { bot, faux, parent, results } = await setup();
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const updates = new Map<string, string[]>();
	const offered: string[][] = [];
	const modelIds: string[] = [];
	let count = 0;
	const childResponse: FauxResponseFactory = async (transcript, _options, _state, model) => {
		offered.push(transcript.messages.flatMap((message) =>
			message.role === "system" ? (message.toolsAdded ?? []).map((tool) => tool.name) : [],
		));
		modelIds.push(model.id);
		if (++count === 2) started.resolve();
		await release.promise;
		const prompt = transcript.messages.find((message) => message.role === "user");
		return fauxAssistantMessage(prompt?.content === tasks[0]?.prompt ? "First answer" : "Second answer");
	};
	faux.setResponses([parallelCalls(), childResponse, childResponse, fauxAssistantMessage("Both complete")]);
	const stream = await watchEvents(bot.harness, parent.id, context);
	stream.start(async (events) => {
		for (const event of events) {
			if (event.type === "tool_execution_update" && event.toolName === "task" && event.details) {
				const detail = event.details as TaskDetails;
				const statuses = updates.get(detail.subagent.taskId) ?? [];
				statuses.push(detail.subagent.status);
				updates.set(detail.subagent.taskId, statuses);
			}
		}
	});
	try {
		const submission = await parent.submit({ type: "input", content: "Delegate two parts" }, context);
		await started.promise;
		expect(count).toBe(2);
		release.resolve();
		expect((await submission.wait(context)).status).toBe("done");
		const completed = (await results()).filter((result) => result.toolName === "task");
		expect(completed).toHaveLength(2);
		expect(completed.map((result) => JSON.stringify(result.content)).sort()).toEqual([
			JSON.stringify([{ type: "text", text: "First answer" }]),
			JSON.stringify([{ type: "text", text: "Second answer" }]),
		].sort());
		for (const result of completed) {
			const final = result.details as TaskDetails;
			expect(result.isError).toBe(false);
			expect(final.subagent.status).toBe("completed");
			expect(final.subagent.background).toBe(false);
			expect(final.subagent.lastText).toContain("answer");
			expect(final.subagent.tokens).toBeGreaterThan(0);
			expect(updates.get(final.subagent.taskId)?.[0]).toBe("running");
			expect(updates.get(final.subagent.taskId)?.at(-1)).toBe("completed");
		}
		for (const tools of offered) {
			expect(tools).toContain("todo_write");
			expect(tools).toContain("codemode");
			for (const excluded of ["task", "task_message", "task_output", "kill_task"]) expect(tools).not.toContain(excluded);
		}
		expect(modelIds).toEqual(["faux-1", "faux-1"]);
		const children = await bot.harness.commit((tx) => tx.scanConversations({ ownerConversationId: parent.id }, 10), context);
		expect(children.items).toHaveLength(2);
		const explore = completed.map((result) => (result.details as TaskDetails).subagent).find((child) => child.subagentType === "explore");
		if (!explore) throw new Error("Missing explore child");
		const exploreRecord = children.items.find((child) => child.id === explore.conversationId);
		if (!exploreRecord) throw new Error("Missing explore conversation");
		const child = await bot.harness.conversation(exploreRecord.id, context);
		expect((await child?.agent(context))?.instructions).toBeDefined();
	} finally {
		release.resolve();
		await stream.stop();
	}
}, 10_000);

async function background(options: { cancel?: boolean } = {}) {
	const state = await setup();
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const aborted = Promise.withResolvers<void>();
	let taskId = "";
	const router: FauxResponseFactory = async (transcript, streamOptions) => {
		const user = transcript.messages.findLast((message) => message.role === "user");
		if (user?.content === "Background child prompt") {
			started.resolve();
			if (options.cancel) {
				return new Promise<AssistantMessage>((resolve) => {
					const signal = streamOptions?.signal;
					if (!signal) throw new Error("Missing child abort signal");
					signal.addEventListener("abort", () => {
						aborted.resolve();
						resolve(fauxAssistantMessage("", { stopReason: "aborted" }));
					}, { once: true });
				});
			}
			await release.promise;
			return fauxAssistantMessage("Background answer");
		}
		if (transcript.messages.at(-1)?.role === "toolResult") return fauxAssistantMessage("Parent answer");
		if (user?.content === "Start background") return fauxAssistantMessage(fauxToolCall("task", {
			description: "Background child", prompt: "Background child prompt", run_in_background: true,
		}), { stopReason: "toolUse" });
		if (user?.content === "Kill") return fauxAssistantMessage(fauxToolCall("kill_task", { task_id: taskId }), { stopReason: "toolUse" });
		if (user?.content === "Snapshot") return fauxAssistantMessage(fauxToolCall("task_output", { block: false }), { stopReason: "toolUse" });
		if (user?.content === "Timed snapshot") return fauxAssistantMessage(fauxToolCall("task_output", { timeout_ms: 1 }), { stopReason: "toolUse" });
		return fauxAssistantMessage(fauxToolCall("task_output", { task_ids: [taskId] }), { stopReason: "toolUse" });
	};
	state.faux.setResponses(Array.from({ length: 30 }, () => router));
	expect((await state.input("Start background")).status).toBe("done");
	await started.promise;
	const spawn = (await state.results()).find((result) => result.toolName === "task");
	taskId = (spawn?.details as TaskDetails).subagent.taskId;
	return { ...state, taskId, release, aborted };
}

test("background task survives its spawning call and task_output collects its answer", async () => {
	const { bot, parent, input, results, taskId, release } = await background();
	try {
		expect(taskId).toMatch(/^sa-\d+$/);
		await input("Snapshot");
		const snapshot = (await results()).find((result) => result.toolName === "task_output");
		expect((snapshot?.details as TaskOutputDetails).subagents[0]?.status).toBe("running");
		const live = await bot.harness.inspect(context);
		expect(live.tasks.some((task) => task.record.kind === "dinobot.subagent" && task.record.background)).toBe(true);
		release.resolve();
		expect((await input("Collect")).status).toBe("done");
		const output = (await results()).find((result) => result.toolName === "task_output");
		expect((output?.details as TaskOutputDetails).subagents[0]?.status).toBe("completed");
		expect(JSON.stringify(output?.content)).toContain("Background answer");
		await parent.waitForIdle(context);
	} finally {
		release.resolve();
	}
}, 10_000);

test("task_output timeout does not cancel a running background task", async () => {
	const { input, results, release } = await background();
	try {
		await input("Timed snapshot");
		const output = (await results()).find((result) => result.toolName === "task_output");
		expect((output?.details as TaskOutputDetails).subagents[0]?.status).toBe("running");
		release.resolve();
		await input("Collect");
		expect(((await results()).find((result) => result.toolName === "task_output")?.details as TaskOutputDetails).subagents[0]?.status).toBe("completed");
	} finally {
		release.resolve();
	}
}, 10_000);

test("kill_task cancels a background child after ordinary parent abort leaves it alive", async () => {
	const { bot, parent, input, results, aborted } = await background({ cancel: true });
	await parent.abort(context);
	expect((await bot.harness.inspect(context)).tasks.some((task) => task.record.kind === "dinobot.subagent")).toBe(true);
	await input("Kill");
	await aborted.promise;
	const output = (await results()).find((result) => result.toolName === "kill_task");
	expect((output?.details as TaskOutputDetails).subagents[0]?.status).toBe("cancelled");
	expect((await bot.harness.inspect(context)).tasks).toEqual([]);
}, 10_000);

test("parent abort with background=true stops background children", async () => {
	const { bot, parent, aborted } = await background({ cancel: true });
	await parent.abort(context, { background: true });
	await aborted.promise;
	expect((await bot.harness.inspect(context)).tasks).toEqual([]);
}, 10_000);

test("parent abort cascades to both foreground children", async () => {
	const { bot, faux, parent } = await setup();
	const started = Promise.withResolvers<void>();
	const aborted = Promise.withResolvers<void>();
	let starting = 0;
	let aborting = 0;
	const response: FauxResponseFactory = (_transcript, options) => new Promise<AssistantMessage>((resolve) => {
		const signal = options?.signal;
		if (!signal) throw new Error("Missing child abort signal");
		signal.addEventListener("abort", () => {
			if (++aborting === 2) aborted.resolve();
			resolve(fauxAssistantMessage("", { stopReason: "aborted" }));
		}, { once: true });
		if (++starting === 2) started.resolve();
	});
	faux.setResponses([parallelCalls(), response, response]);
	const submission = await parent.submit({ type: "input", content: "Cancel foreground work" }, context);
	await started.promise;
	await parent.abort(context);
	await aborted.promise;
	expect((await submission.wait(context)).status).toBe("unanswered");
	const children = await bot.harness.commit((tx) => tx.scanConversations({ ownerConversationId: parent.id }, 10), context);
	expect(children.items).toHaveLength(2);
	for (const child of children.items) {
		const childTasks = await bot.harness.commit((tx) => tx.scanTasks({ conversationId: child.id }, 20), context);
		expect(childTasks.items.length).toBeGreaterThan(0);
		expect(childTasks.items.every((task) => task.state.status === "terminal")).toBe(true);
		expect(childTasks.items.some((task) => task.state.status === "terminal" && task.state.outcome.status === "aborted")).toBe(true);
	}
	expect((await bot.harness.inspect(context)).tasks).toEqual([]);
}, 10_000);

// Exercise the exported tool with controlled API boundaries, not scheduler sleeps.
// The real parent-abort integration test above remains unchanged.
test.each(["watch", "read", "publish", "promotion", "promoted-publish"] as const)(
	"foreground ownership cleanup at %s boundary", async (boundary) => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const cancellation = withCancel(context);
		const failure = new Error("controlled foreground abort");
		const ref = { taskId: "sa-child", runnerId: "runner", conversationId: "child", background: false };
		const progress = { taskId: ref.taskId, status: "running", background: false };
		const calls: string[] = [];
		let commits = 0;
		let publications = 0;
		const gate = async () => {
			entered.resolve();
			await release.promise;
			cancellation.context.abortSignal?.throwIfAborted();
		};
		const harness = {
			getTask: async () => ({ state: { status: "running" } }),
			abortTask: async () => { calls.push("abort"); },
			waitForTask: async () => { calls.push("settled"); },
		} as unknown as Harness;
		const api = {
			conversationId: "parent", taskId: "tool",
			agent: async () => ({ tools: [], extensions: [] }),
			commit: async () => {
				if (++commits === 1) return ref;
				if (boundary === "promotion") await gate();
				progress.background = true;
				return { ...progress };
			},
			watchDoc: async (doc: unknown) => {
				if (doc === ProgressDoc && boundary === "watch") await gate();
				return {
					value: { asks: [{ id: "ask", state: "open", from: { conversationId: "child" }, to: "main", question: "Choose?", kind: "decision", refs: [], default: "no", deadlineAt: Date.UTC(2100, 0) }] },
					start: () => {}, stop: async () => {},
				};
			},
			snapshot: async () => {
				if (boundary === "read") await gate();
				return { subagent: progress };
			},
			details: async () => {
				publications++;
				if (boundary === "publish" || (boundary === "promoted-publish" && publications === 2)) await gate();
			},
		} as unknown as ToolExecutionApi;
		const tool: ToolRegistration = subagentsExtension(() => harness, {} as WorkService).tools!.find((tool) => tool.name === "task")!;
		const execution = tool.execute({ description: "controlled", prompt: "child" }, api, cancellation.context)
			.then(() => undefined, (error: unknown) => error);
		try {
			await entered.promise;
			cancellation.cancel(failure);
			release.resolve();
			expect(await execution).toBe(failure);
			expect(calls).toEqual(boundary === "promoted-publish" ? [] : ["abort", "settled"]);
			expect(progress.background).toBe(boundary === "promoted-publish");
		} finally {
			release.resolve();
			cancellation.cancel();
			await execution;
		}
	}, 10_000,
);

test("task returns a failed child status instead of an empty success", async () => {
	const { faux, input, results } = await setup();
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("task", tasks[0] ?? {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("Failure", { stopReason: "error", errorMessage: "Provider failed" }),
		fauxAssistantMessage("Parent summary"),
	]);
	await input("Run failing child");
	const result = (await results()).find((result) => result.toolName === "task");
	expect(result?.isError).toBe(true);
	expect((result?.details as TaskDetails).subagent.status).toBe("failed");
});

test("task reports actual child tool calls and bounded last text", async () => {
	const { faux, input, results } = await setup();
	const answer = "x".repeat(250);
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("task", { description: "Tool user", prompt: "Track one item" }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("todo_write", { todos: [{ id: "child", content: "Child item" }] }), { stopReason: "toolUse" }),
		fauxAssistantMessage(answer),
		fauxAssistantMessage("Parent summary"),
	]);
	await input("Use a child tool");
	const result = (await results()).find((result) => result.toolName === "task");
	const detail = result?.details as TaskDetails;
	expect(detail.subagent.toolCount).toBe(1);
	expect(detail.subagent.lastText).toBe("x".repeat(200));
	expect(detail.subagent.currentTool).toBeUndefined();
	expect(result?.content).toEqual([{ type: "text", text: answer }]);
}, 10_000);

test("background recovery reattaches the same child and keeps its taskId", async () => {
	const dir = await mkdtemp(join(tmpdir(), "dinobot-subagent-replay-"));
	dirs.push(dir);
	const path = join(dir, "bot.sqlite");
	const first = await setup(path);
	const started = Promise.withResolvers<void>();
	const pending: FauxResponseFactory = async (transcript, options) => {
		if (transcript.messages.findLast((message) => message.role === "user")?.content === "Replay child") {
			return new Promise<AssistantMessage>((resolve) => {
				const signal = options?.signal;
				if (!signal) throw new Error("Missing recovery abort signal");
				signal.addEventListener("abort", () => resolve(fauxAssistantMessage("", { stopReason: "aborted" })), { once: true });
				started.resolve();
			});
		}
		if (transcript.messages.at(-1)?.role === "toolResult") return fauxAssistantMessage("Spawned");
		return fauxAssistantMessage(fauxToolCall("task", {
			description: "Replay child", prompt: "Replay child", run_in_background: true,
		}), { stopReason: "toolUse" });
	};
	first.faux.setResponses(Array.from({ length: 10 }, () => pending));
	await first.input("Start replay child");
	await started.promise;
	const before = (await first.results()).find((result) => result.toolName === "task")?.details as TaskDetails;
	await first.bot.close(context);
	bots.splice(bots.indexOf(first.bot), 1);
	const recovered: FauxResponseFactory = (transcript) => {
		if (transcript.messages.findLast((message) => message.role === "user")?.content === "Replay child") return fauxAssistantMessage("Recovered answer");
		if (transcript.messages.at(-1)?.role === "toolResult") return fauxAssistantMessage("Collected");
		return fauxAssistantMessage(fauxToolCall("task_output", { task_ids: [before.subagent.taskId] }), { stopReason: "toolUse" });
	};
	const second = await setup(path, recovered);
	await second.input("Collect recovery");
	const output = (await second.results()).find((result) => result.toolName === "task_output");
	const after = (output?.details as TaskOutputDetails).subagents[0];
	expect(after?.taskId).toBe(before.subagent.taskId);
	expect(after?.conversationId).toBe(before.subagent.conversationId);
	expect(after?.status).toBe("completed");
	expect(JSON.stringify(output?.content)).toContain("Recovered answer");
	const children = await second.bot.harness.commit((tx) => tx.scanConversations({ ownerConversationId: second.parent.id }, 10), context);
	expect(children.items).toHaveLength(1);
}, 10_000);

let dir: string | undefined;
const open = bots;
afterEach(async () => {
	if (dir !== undefined) await rm(dir, { recursive: true, force: true });
	dir = undefined;
});

async function reviewerAgents(model = "faux/faux-2") {
	dir ??= await mkdtemp(join(tmpdir(), "dinobot-subagents-"));
	await writeFile(
		join(dir, "reviewer.md"),
		`---
name: reviewer
description: Review work
model: ${model}
---
You are the reviewer.
`,
	);
	return loadAgents([dir]);
}

async function startBot(options: { model?: string; tools?: string[] } = {}) {
	const agents = (await reviewerAgents(options.model)).map((agent) => ({
		...agent, ...(options.tools === undefined ? {} : { tools: options.tools }),
	}));
	const root = dir;
	if (root === undefined) throw new Error("test directory is missing");
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "faux-1" }, { id: "faux-2" }, { id: "faux-3" }],
	});
	const models = createModels();
	models.setProvider(faux.provider);
	const bot = await openBot(
		{
			storage: await openNodeSqliteStorage(join(root, "bot.sqlite")),
			models,
			defaultModel: { provider: "faux", modelId: "faux-1" },
			toolMode: "direct",
			plugins: [],
			agents,
		},
		context,
	);
	open.push(bot);
	return { bot, faux };
}

function message(messageId: string): InboundMessage {
	return { channel: "test", threadKey: "T1", messageId, userId: "U1", text: "delegate" };
}

function offeredTools(messages: readonly unknown[]): string[] {
	const names: string[] = [];
	for (const item of messages as { role: string; toolsAdded?: { name: string }[] }[]) {
		if (item.role === "system") names.push(...(item.toolsAdded ?? []).map((tool) => tool.name));
	}
	return names;
}

describe("subagents", () => {
	test("runs a configured child model and returns its answer to the parent", async () => {
		const { bot, faux } = await startBot();
		let childModel = "";
		let childSystem = "";
		let childTools: string[] = [];
		let parentToolResult = "";
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("task", { description: "Review work", subagent_type: "reviewer", prompt: "review this" }), {
				stopReason: "toolUse",
			}),
			(transcript, _options, _state, model) => {
				childModel = model.id;
				childSystem = JSON.stringify(
					transcript.messages.filter((item) => item.role === "system").map((item) => item.sections),
				);
				childTools = offeredTools(transcript.messages);
				return fauxAssistantMessage("child verdict");
			},
			(transcript) => {
				parentToolResult = JSON.stringify(transcript.messages.at(-1));
				return fauxAssistantMessage("done");
			},
		]);

		expect(await bot.handle(message("m1"), context)).toMatchObject({ status: "answered", text: "done" });
		expect(childModel).toBe("faux-2");
		expect(childSystem).toContain("You are the reviewer.");
		expect(childTools).not.toContain("agent");
		for (const excluded of ["task", "task_message", "task_output", "kill_task"]) expect(childTools).not.toContain(excluded);
		expect(childTools).toContain("todo_write");
		expect(parentToolResult).toContain("child verdict");
	});

	test("an invocation model overrides the agent frontmatter model", async () => {
		const { bot, faux } = await startBot();
		let childModel = "";
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("task", { description: "Review work",
					subagent_type: "reviewer",
					prompt: "review this",
					model: "faux/faux-3",
				}),
				{ stopReason: "toolUse" },
			),
			(_transcript, _options, _state, model) => {
				childModel = model.id;
				return fauxAssistantMessage("child verdict");
			},
			fauxAssistantMessage("done"),
		]);

		expect(await bot.handle(message("m1"), context)).toMatchObject({ status: "answered", text: "done" });
		expect(childModel).toBe("faux-3");
	});

	test("an unknown subagent returns an error listing available names", async () => {
		const { bot, faux } = await startBot();
		let toolResult = "";
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("task", { description: "Review work", subagent_type: "missing", prompt: "review this" }), {
				stopReason: "toolUse",
			}),
			(transcript) => {
				toolResult = JSON.stringify(transcript.messages.at(-1));
				return fauxAssistantMessage("done");
			},
		]);

		expect(await bot.handle(message("m1"), context)).toMatchObject({ status: "answered", text: "done" });
		expect(toolResult).toContain('"isError":true');
		expect(toolResult).toContain("missing");
		expect(toolResult).toContain("reviewer");
		expect(toolResult).toContain("general-purpose");
		expect(toolResult).toContain("explore");
	});

	test("definition allowlists narrow child tools and cannot enable nesting", async () => {
		const { bot, faux } = await startBot({ tools: ["task", "task_output", "kill_task"] });
		let childTools: string[] = [];
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("task", {
				description: "Review work", subagent_type: "reviewer", prompt: "review this",
			}), { stopReason: "toolUse" }),
			(transcript) => {
				childTools = offeredTools(transcript.messages);
				return fauxAssistantMessage("child verdict");
			},
			fauxAssistantMessage("done"),
		]);
		expect(await bot.handle(message("m1"), context)).toMatchObject({ status: "answered", text: "done" });
		expect(childTools).toEqual([]);
	});

	test.each([
		["inherit", undefined, "faux-1"],
		["faux-2", undefined, "faux-2"],
		["faux/faux-2", "inherit", "faux-1"],
	] as const)("definition model %s with invocation %s resolves to %s", async (model, invocation, expected) => {
		const { bot, faux } = await startBot({ model });
		let childModel = "";
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("task", {
				description: "Review work", subagent_type: "reviewer", prompt: "review this",
				...(invocation === undefined ? {} : { model: invocation }),
			}), { stopReason: "toolUse" }),
			(_transcript, _options, _state, model) => {
				childModel = model.id;
				return fauxAssistantMessage("child verdict");
			},
			fauxAssistantMessage("done"),
		]);
		expect(await bot.handle(message("m1"), context)).toMatchObject({ status: "answered", text: "done" });
		expect(childModel).toBe(expected);
	});

	test("loads valid manifests and reports every invalid agent file", async () => {
		dir = await mkdtemp(join(tmpdir(), "dinobot-subagents-"));
		const invalid = join(dir, "invalid");
		const valid = join(dir, "valid");
		await mkdir(invalid);
		await mkdir(valid);
		await writeFile(
			join(invalid, "missing-description.md"),
			`---
name: missing
---
Prompt
`,
		);
		await writeFile(
			join(invalid, "invalid-name.md"),
			`---
name: "bad:name"
description: Bad name
---
Prompt
`,
		);
		await writeFile(
			join(valid, "reviewer.md"),
			`---
name: reviewer
description: Review work
tools: read, bash
---
You are the reviewer.
`,
		);
		await writeFile(join(valid, "README.md"), "# Agents\n\nNotes for humans.\n");
		await writeFile(join(valid, "notes.md"), "---\ntitle: Notes\n---\nNo name: documentation.\n");

		const rejected = loadAgents([invalid]);
		await expect(rejected).rejects.toThrow("missing-description.md");
		await expect(rejected).rejects.toThrow("invalid-name.md");
		const parsed = await parseManifest(
			{
				bot: {
					enabled: false,
					dataDir: ".data",
					model: { provider: "faux", modelId: "faux-1" },
					toolMode: "direct",
				},
				agents: { dirs: [valid] },
				channels: {},
				plugins: {},
			},
			{ channels: {}, plugins: {} },
		);
		expect(parsed.agents).toEqual([
			{
				name: "reviewer",
				description: "Review work",
				tools: ["read", "bash"],
				prompt: "You are the reviewer.",
			},
		]);
	});
});
