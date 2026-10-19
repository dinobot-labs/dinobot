import { afterEach, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { type ConversationId, MemoryStorage, watchEvents } from "@earendil-works/pi-durable";
import { type Bot, openBot } from "../src/core/bot.ts";
import { AgentsDoc, collectionLine, ProgressDoc } from "../src/extensions/subagents.ts";
import type { SubagentProgress, TaskDetails, TaskOutputDetails } from "../src/core/ui-contract.ts";

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
		toolMode: "codemode-only", plugins: [], settings: { retry: { enabled: false } },
	}, context);
	bots.push(bot);
	const parent = await bot.conversation("test", "messages", context);
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

function userTexts(transcript: { messages: { role: string; content: unknown }[] }) {
	return transcript.messages.filter((message) => message.role === "user").map((message) => JSON.stringify(message.content ?? ""));
}

function hasToolResult(transcript: { messages: { role: string }[] }, name: string) {
	return transcript.messages.some((message) => (message as { role: string; toolName?: string }).role === "toolResult" && (message as { toolName?: string }).toolName === name);
}

/** Whether the current parent turn (after its latest user message) already has a result of this tool. */
function answeredThisTurn(transcript: { messages: { role: string }[] }, name: string) {
	let last = transcript.messages.length - 1;
	while (last >= 0 && transcript.messages[last]!.role !== "user") last--;
	return hasToolResult({ messages: transcript.messages.slice(last + 1) }, name);
}

/** The only child's runner, from this conversation's AgentsDoc. */
async function onlyChild(bot: Bot, parentId: ConversationId) {
	const ref = (await bot.harness.snapshot(AgentsDoc, parentId, context))?.agents[0];
	if (!ref) throw new Error("no subagent recorded");
	return ref;
}

function toolsOffered(transcript: { messages: { role: string; toolsAdded?: { name: string }[] }[] }) {
	return transcript.messages.flatMap((message) => message.role === "system" ? (message.toolsAdded ?? []).map((tool) => tool.name) : []);
}

type Handle = { taskId: string; conversationId: number };

/** The subagent handle from the spawning `task` tool result, the way clients see it. */
async function spawnHandle(results: () => Promise<ToolResultMessage[]>): Promise<Handle> {
	const spawn = (await results()).find((result) => result.toolName === "task");
	const subagent = (spawn?.details as TaskDetails | undefined)?.subagent;
	if (!subagent) throw new Error("task result details are missing");
	return { taskId: subagent.taskId, conversationId: subagent.conversationId };
}

/** Resolves once the parent's task_message tool has admitted its note (its mid-run details publish). */
async function waitForMessageAdmission(bot: Bot, parentId: ConversationId) {
	const stream = await watchEvents(bot.harness, parentId, context);
	const admitted = Promise.withResolvers<void>();
	await stream.start(async (events) => {
		for (const event of events) {
			if (event.type === "tool_execution_update" && event.toolName === "task_message" && event.details) admitted.resolve();
		}
	});
	return {
		admitted: admitted.promise,
		close: async () => { stream.stop().catch(() => undefined); },
	};
}

/**
 * Spawns a child that holds its first model call open on `release` (so the parent can message it mid-run),
 * lets the parent deliver one orchestrator note, and resolves once both parent turns settle.
 */
/** `key: null` omits the idempotency key (a JS default would replace an explicit undefined). */
async function deliveredFlow(key: string | null = "k1") {
	const { bot, faux, parent, results, input } = await setup();
	const release = Promise.withResolvers<void>();
	const childStarted = Promise.withResolvers<void>();
	const facts = { childSawNote: false, offered: [] as string[] };
	let taskId = "";
	const master: FauxResponseFactory = async (transcript) => {
		const texts = userTexts(transcript);
		const first = texts[0] ?? "";
		const last = texts.at(-1) ?? "";
		if (first.includes("Check the runner")) {
			childStarted.resolve();
			facts.offered.push(...toolsOffered(transcript));
			if (texts.some((text) => text.includes("[from orchestrator]"))) {
				facts.childSawNote = true;
				return fauxAssistantMessage("ack: docker available noted");
			}
			await release.promise;
			return fauxAssistantMessage(fauxToolCall("todo_write", { todos: [{ id: "1", content: "hold the line", status: "in_progress" }] }), { stopReason: "toolUse" });
		}
		if (last.includes("Delegate the runner")) {
			if (hasToolResult(transcript, "task")) return fauxAssistantMessage("delegated");
			return fauxAssistantMessage(fauxToolCall("task", { description: "Runner", prompt: "Check the runner", run_in_background: true }), { stopReason: "toolUse" });
		}
		if (last.includes("Send note") || last.includes("Send again")) {
			if (answeredThisTurn(transcript, "task_message")) return fauxAssistantMessage("noted");
			return fauxAssistantMessage(fauxToolCall("task_message", { task_id: taskId, text: "docker is available", ...(key ? { key } : {}) }), { stopReason: "toolUse" });
		}
		return fauxAssistantMessage("ok");
	};
	faux.setResponses(Array.from({ length: 40 }, () => master));
	await input("Delegate the runner");
	const handle = await spawnHandle(results);
	taskId = handle.taskId;
	await childStarted.promise;
	const watch = await waitForMessageAdmission(bot, parent.id);
	try {
		const settled2 = input("Send note");
		await watch.admitted;
		release.resolve();
		await settled2;
	} finally {
		await watch.close();
	}
	const ref = await onlyChild(bot, parent.id);
	await bot.harness.waitForTask(ref.runnerId, context);
	return { bot, faux, parent, results, input, facts, taskId, childId: handle.conversationId, runnerId: ref.runnerId };
}

test("task_message joins a busy child at the next tool boundary", async () => {
	const { bot, parent, results, facts, runnerId } = await deliveredFlow();
	const messages = (await results()).filter((result) => result.toolName === "task_message");
	expect(messages).toHaveLength(1);
	expect(messages[0]!.isError ?? false).toBe(false);
	expect(JSON.stringify(messages[0]!.content)).toContain("joined its current run");
	expect(facts.childSawNote).toBe(true);
	// The child's final answer stays with the original task, for task_output to collect once.
	expect((await bot.harness.snapshot(ProgressDoc, parent.id, String(runnerId), context))?.answer).toBe("ack: docker available noted");
});

test("task_message rejects a finished task", async () => {
	const { faux, results, input } = await setup();
	let taskId = "";
	const master: FauxResponseFactory = (transcript) => {
		const texts = userTexts(transcript);
		const first = texts[0] ?? "";
		const last = texts.at(-1) ?? "";
		if (first.includes("Check and finish")) return fauxAssistantMessage("all done");
		if (last.includes("Delegate the runner")) {
			if (hasToolResult(transcript, "task")) return fauxAssistantMessage("delegated");
			return fauxAssistantMessage(fauxToolCall("task", { description: "Finisher", prompt: "Check and finish" }), { stopReason: "toolUse" });
		}
		if (last.includes("Send note")) {
			if (hasToolResult(transcript, "task_message")) return fauxAssistantMessage("noted");
			return fauxAssistantMessage(fauxToolCall("task_message", { task_id: taskId, text: "docker is available" }), { stopReason: "toolUse" });
		}
		return fauxAssistantMessage("ok");
	};
	faux.setResponses(Array.from({ length: 40 }, () => master));
	await input("Delegate the runner");
	const handle = await spawnHandle(results);
	taskId = handle.taskId;
	await input("Send note");
	const messages = (await results()).filter((result) => result.toolName === "task_message");
	expect(messages).toHaveLength(1);
	expect(messages[0]!.isError).toBe(true);
	expect(JSON.stringify(messages[0]!.content)).toContain("not running");
});

test("task_message rejects unknown task ids", async () => {
	const { faux, results, input } = await setup();
	const master: FauxResponseFactory = (transcript) => {
		const last = (userTexts(transcript).at(-1)) ?? "";
		if (last.includes("Send note")) {
			if (hasToolResult(transcript, "task_message")) return fauxAssistantMessage("noted");
			return fauxAssistantMessage(fauxToolCall("task_message", { task_id: "sa-424242", text: "hello" }), { stopReason: "toolUse" });
		}
		return fauxAssistantMessage("ok");
	};
	faux.setResponses(Array.from({ length: 10 }, () => master));
	await input("Send note");
	const messages = (await results()).filter((result) => result.toolName === "task_message");
	expect(messages).toHaveLength(1);
	expect(messages[0]!.isError).toBe(true);
	expect(JSON.stringify(messages[0]!.content)).toContain("Unknown subagent");
});

test("task_message retries with the same key deliver one message", async () => {
	const { bot, faux, parent, results, input } = await setup();
	const release = Promise.withResolvers<void>();
	const childStarted = Promise.withResolvers<void>();
	let notes = 0;
	let taskId = "";
	const master: FauxResponseFactory = async (transcript) => {
		const texts = userTexts(transcript);
		const first = texts[0] ?? "";
		const last = texts.at(-1) ?? "";
		if (first.includes("Check the runner")) {
			childStarted.resolve();
			const delivered = texts.filter((text) => text.includes("[from orchestrator]")).length;
			notes = Math.max(notes, delivered);
			if (delivered > 0) return fauxAssistantMessage("ack: one note only");
			await release.promise;
			return fauxAssistantMessage(fauxToolCall("todo_write", { todos: [{ id: "1", content: "hold the line", status: "in_progress" }] }), { stopReason: "toolUse" });
		}
		if (last.includes("Delegate the runner")) {
			if (hasToolResult(transcript, "task")) return fauxAssistantMessage("delegated");
			return fauxAssistantMessage(fauxToolCall("task", { description: "Runner", prompt: "Check the runner", run_in_background: true }), { stopReason: "toolUse" });
		}
		if (last.includes("Send twice")) {
			if (hasToolResult(transcript, "task_message")) return fauxAssistantMessage("noted");
			return fauxAssistantMessage([
				fauxToolCall("task_message", { task_id: taskId, text: "note one", key: "dup" }),
				fauxToolCall("task_message", { task_id: taskId, text: "note one", key: "dup" }),
			], { stopReason: "toolUse" });
		}
		return fauxAssistantMessage("ok");
	};
	faux.setResponses(Array.from({ length: 40 }, () => master));
	await input("Delegate the runner");
	const handle = await spawnHandle(results);
	taskId = handle.taskId;
	await childStarted.promise;
	const watch = await waitForMessageAdmission(bot, parent.id);
	try {
		const settled2 = input("Send twice");
		await watch.admitted;
		release.resolve();
		await settled2;
	} finally {
		await watch.close();
	}
	expect(notes).toBe(1);
	const messages = (await results()).filter((result) => result.toolName === "task_message");
	expect(messages).toHaveLength(2);
	for (const result of messages) expect(result.isError ?? false).toBe(false);
	const counted = new Set(messages.map((result) => ((result.details as TaskOutputDetails | undefined)?.subagents[0] as SubagentProgress | undefined)?.messages));
	expect([...counted]).toEqual([1]);
});

test("an aborted task_message call withdraws the queued steer", async () => {
	const { bot, faux, parent, results, input } = await setup();
	const release = Promise.withResolvers<void>();
	const childStarted = Promise.withResolvers<void>();
	let childSawNote = false;
	let taskId = "";
	const master: FauxResponseFactory = async (transcript) => {
		const texts = userTexts(transcript);
		const first = texts[0] ?? "";
		const last = texts.at(-1) ?? "";
		if (first.includes("Check the runner")) {
			childStarted.resolve();
			if (texts.some((text) => text.includes("[from orchestrator]"))) {
				childSawNote = true;
				return fauxAssistantMessage("ack");
			}
			await release.promise;
			return fauxAssistantMessage("clean run");
		}
		if (last.includes("Delegate the runner")) {
			if (hasToolResult(transcript, "task")) return fauxAssistantMessage("delegated");
			return fauxAssistantMessage(fauxToolCall("task", { description: "Runner", prompt: "Check the runner", run_in_background: true }), { stopReason: "toolUse" });
		}
		if (last.includes("Send note")) {
			if (hasToolResult(transcript, "task_message")) return fauxAssistantMessage("noted");
			return fauxAssistantMessage(fauxToolCall("task_message", { task_id: taskId, text: "docker is available" }), { stopReason: "toolUse" });
		}
		if (last.includes("Collect")) return fauxAssistantMessage(fauxToolCall("task_output", { block: false }), { stopReason: "toolUse" });
		return fauxAssistantMessage("ok");
	};
	faux.setResponses(Array.from({ length: 40 }, () => master));
	await input("Delegate the runner");
	const handle = await spawnHandle(results);
	taskId = handle.taskId;
	await childStarted.promise;
	const watch = await waitForMessageAdmission(bot, parent.id);
	let settled2: Promise<unknown> | undefined;
	try {
		settled2 = input("Send note").catch(() => undefined);
		await watch.admitted;
	} finally {
		await watch.close();
	}
	await parent.abort(context);
	release.resolve();
	await parent.waitForIdle(context);
	await settled2;
	await input("Collect");
	const output = (await results()).find((result) => result.toolName === "task_output" && JSON.stringify(result.content).includes("clean run"))
		?? (await results()).filter((result) => result.toolName === "task_output").at(-1);
	const subagent = (output?.details as TaskOutputDetails | undefined)?.subagents[0];
	expect(subagent?.status).toBe("completed");
	expect(subagent?.messages).toBeUndefined();
	expect(childSawNote).toBe(false);
}, 10_000);

test("children are not offered task_message", async () => {
	const { faux, results, input } = await setup();
	const offered: string[] = [];
	const master: FauxResponseFactory = (transcript) => {
		const texts = userTexts(transcript);
		const first = texts[0] ?? "";
		const last = texts.at(-1) ?? "";
		if (first.includes("Check quickly")) {
			offered.push(...toolsOffered(transcript));
			return fauxAssistantMessage("done quickly");
		}
		if (last.includes("Delegate the runner")) {
			if (hasToolResult(transcript, "task")) return fauxAssistantMessage("delegated");
			return fauxAssistantMessage(fauxToolCall("task", { description: "Quick", prompt: "Check quickly", run_in_background: true }), { stopReason: "toolUse" });
		}
		if (last.includes("Collect")) return fauxAssistantMessage(fauxToolCall("task_output", { block: false }), { stopReason: "toolUse" });
		return fauxAssistantMessage("ok");
	};
	faux.setResponses(Array.from({ length: 20 }, () => master));
	await input("Delegate the runner");
	await input("Collect");
	const output = (await results()).filter((result) => result.toolName === "task_output").at(-1);
	expect(((output?.details as TaskOutputDetails | undefined)?.subagents[0])?.status).toBe("completed");
	expect(offered.length).toBeGreaterThan(0);
	expect(offered).not.toContain("task_message");
	expect(offered).not.toContain("task");
	expect(offered).not.toContain("kill_task");
});

test("the delivered message count survives the runner's final progress commit", async () => {
	const { bot, parent, facts, runnerId } = await deliveredFlow();
	expect(facts.childSawNote).toBe(true);
	const state = await bot.harness.snapshot(ProgressDoc, parent.id, String(runnerId), context);
	expect(state?.subagent?.status).toBe("completed");
	expect(state?.subagent?.messages).toBe(1);
	expect(state?.subagent?.messageSubmissions).toHaveLength(1);
});

test("task_message returns once the note is placed, before the child's run ends", async () => {
	const { bot, faux, parent, results, input } = await setup();
	const release = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	const childStarted = Promise.withResolvers<void>();
	let taskId = "";
	const master: FauxResponseFactory = async (transcript) => {
		const texts = userTexts(transcript);
		const first = texts[0] ?? "";
		const last = texts.at(-1) ?? "";
		if (first.includes("Check the runner")) {
			childStarted.resolve();
			if (texts.some((text) => text.includes("[from orchestrator]"))) {
				const rounds = transcript.messages.filter((message) => message.role === "toolResult").length;
				if (rounds < 2) return fauxAssistantMessage(fauxToolCall("todo_write", { todos: [{ id: "2", content: "more work", status: "in_progress" }] }), { stopReason: "toolUse" });
				await finish.promise;
				return fauxAssistantMessage("final child answer");
			}
			await release.promise;
			return fauxAssistantMessage(fauxToolCall("todo_write", { todos: [{ id: "1", content: "hold", status: "in_progress" }] }), { stopReason: "toolUse" });
		}
		if (last.includes("Delegate the runner")) {
			if (hasToolResult(transcript, "task")) return fauxAssistantMessage("delegated");
			return fauxAssistantMessage(fauxToolCall("task", { description: "Runner", prompt: "Check the runner", run_in_background: true }), { stopReason: "toolUse" });
		}
		if (last.includes("Send note")) {
			if (hasToolResult(transcript, "task_message")) return fauxAssistantMessage("noted");
			return fauxAssistantMessage(fauxToolCall("task_message", { task_id: taskId, text: "docker is available" }), { stopReason: "toolUse" });
		}
		return fauxAssistantMessage("ok");
	};
	faux.setResponses(Array.from({ length: 40 }, () => master));
	await input("Delegate the runner");
	taskId = (await spawnHandle(results)).taskId;
	await childStarted.promise;
	const watch = await waitForMessageAdmission(bot, parent.id);
	let outcome: string;
	try {
		const settled2 = input("Send note");
		await watch.admitted;
		release.resolve();
		outcome = await Promise.race([settled2.then(() => "returned"), Bun.sleep(5_000).then(() => "blocked")]);
	} finally {
		await watch.close();
	}
	try {
		expect(outcome).toBe("returned");
		const message = (await results()).find((result) => result.toolName === "task_message");
		expect(message?.isError ?? false).toBe(false);
		expect(JSON.stringify(message?.content)).not.toContain("final child answer");
		// Still running, and the delivered note is visible in the persisted progress and the real collection line.
		const ref = await onlyChild(bot, parent.id);
		const state = await bot.harness.snapshot(ProgressDoc, parent.id, String(ref.runnerId), context);
		expect(state?.subagent?.status).toBe("running");
		expect(state?.subagent?.messages).toBe(1);
		expect(collectionLine({ subagent: state!.subagent! }, false)).toContain("1 message");
	} finally {
		finish.resolve();
	}
	const ref = await onlyChild(bot, parent.id);
	await bot.harness.waitForTask(ref.runnerId, context);
	expect((await bot.harness.snapshot(ProgressDoc, parent.id, String(ref.runnerId), context))?.answer).toBe("final child answer");
}, 15_000);

test("without a key the request id derives from the durable tool call id", async () => {
	const { bot, results, childId, runnerId } = await deliveredFlow(null);
	const message = (await results()).find((result) => result.toolName === "task_message");
	expect(message).toBeDefined();
	const record = await bot.harness.commit((tx) => tx.submissionByRequest(childId as ConversationId, `subagent-message:${runnerId}:${message!.toolCallId}`), context);
	expect(record?.status).toBe("done");
});

test("a retry with the same key after the child finished reports the earlier delivery", async () => {
	const { bot, parent, results, input, runnerId } = await deliveredFlow();
	await input("Send again");
	const messages = (await results()).filter((result) => result.toolName === "task_message");
	// Entry pages are not in call order: every result, the retry included, reports the one delivery.
	expect(messages).toHaveLength(2);
	for (const message of messages) {
		expect(message.isError ?? false).toBe(false);
		expect(JSON.stringify(message.content)).toContain("joined its current run");
	}
	expect((await bot.harness.snapshot(ProgressDoc, parent.id, String(runnerId), context))?.subagent?.messages).toBe(1);
});

test("DAG- and research-owned children cannot be steered", async () => {
	const { bot, faux, parent, results, input } = await setup();
	const release = Promise.withResolvers<void>();
	let taskId = "";
	let steered = false;
	const master: FauxResponseFactory = async (transcript) => {
		const texts = userTexts(transcript);
		const first = texts[0] ?? "";
		const last = texts.at(-1) ?? "";
		if (first.includes("Check the runner")) {
			if (texts.some((text) => text.includes("[from orchestrator]"))) steered = true;
			await release.promise;
			return fauxAssistantMessage("done");
		}
		if (last.includes("Delegate the runner")) {
			if (hasToolResult(transcript, "task")) return fauxAssistantMessage("delegated");
			return fauxAssistantMessage(fauxToolCall("task", { description: "Runner", prompt: "Check the runner", run_in_background: true }), { stopReason: "toolUse" });
		}
		if (last.includes("Send note")) {
			if (answeredThisTurn(transcript, "task_message")) return fauxAssistantMessage("noted");
			return fauxAssistantMessage(fauxToolCall("task_message", { task_id: taskId, text: "say valid" }), { stopReason: "toolUse" });
		}
		return fauxAssistantMessage("ok");
	};
	faux.setResponses(Array.from({ length: 40 }, () => master));
	try {
		await input("Delegate the runner");
		taskId = (await spawnHandle(results)).taskId;
		for (const owner of ["dag", "research"] as const) {
			await bot.harness.commit(async (tx) => {
				const doc = await tx.doc(AgentsDoc, parent.id);
				(doc.agents[0] as { owner?: string }).owner = owner;
			}, context);
			await input("Send note");
		}
		const messages = (await results()).filter((result) => result.toolName === "task_message");
		expect(messages).toHaveLength(2);
		for (const message of messages) expect(message.isError).toBe(true);
		const texts = messages.map((message) => JSON.stringify(message.content)).join("\n");
		expect(texts).toContain("DAG run");
		expect(texts).toContain("research mission");
	} finally {
		release.resolve();
	}
	await bot.harness.waitForTask((await onlyChild(bot, parent.id)).runnerId, context);
	expect(steered).toBe(false);
});
