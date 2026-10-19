import { expect, test } from "bun:test";
import type { AssistantMessage, ToolResultMessage, Usage, UserMessage } from "@earendil-works/pi-ai";
import type { AgentEvent, ConversationId, EntryId, EntryRecord } from "@earendil-works/pi-durable";
import type { SubagentProgress } from "../src/core/ui-contract.ts";
import { ChatState, createChatData, isHiddenTool, reduceEvent, runningSubagents } from "../src/tui/state.ts";

const usage: Usage = { input: 1000, output: 50, cacheRead: 200, cacheWrite: 0, totalTokens: 1250, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } };
let entryIds = 0;

function entry(kind: string, message: UserMessage | AssistantMessage | ToolResultMessage): EntryRecord {
	return { id: ++entryIds as EntryId, conversationId: 1 as ConversationId, kind, model: [message] };
}

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return { role: "assistant", content, api: "pi-messages", provider: "faux", model: "faux-1", usage, stopReason, timestamp: 1_700_000_000_000 };
}

function toolResult(toolCallId: string, toolName: string, text: string, details?: unknown, isError = false): ToolResultMessage {
	return { role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], ...(details === undefined ? {} : { details: details as never }), isError, timestamp: 1 };
}

function progress(taskId: string, status: SubagentProgress["status"], extra: Partial<SubagentProgress> = {}): SubagentProgress {
	return { taskId, description: "Summarize calc.py", subagentType: "explore", background: false, conversationId: 7, status, startedAt: 1_000, toolCount: 0, ...extra };
}

function feed(events: AgentEvent[], from = 1_000) {
	const data = createChatData();
	let now = from;
	for (const event of events) reduceEvent(data, event, (now += 100));
	return data;
}

test("context uses provider totals including cache and thinking, not a system residual", () => {
 const data = createChatData();
 const message = assistant([{ type: "thinking", thinking: "hidden" }, { type: "text", text: "short" }]);
 message.usage = { ...usage, input: 120000, cacheRead: 150000, cacheWrite: 20000, output: 10000, totalTokens: 300000 };
 reduceEvent(data, { type: "message_end", entry: entry("pi.assistant", message) }, 1000);
 expect(data.usage.contextTokens).toBe(300000);
 expect(Object.keys(data.usage).sort()).toEqual(["contextTokens", "cost", "totalTokens"]);
});

test("text deltas grow one streaming agent block and bump its version on every delta", () => {
	const data = createChatData();
	reduceEvent(data, { type: "run_start", inputs: [] }, 1_000);
	reduceEvent(data, { type: "message_update", usage, changes: [{ type: "text_start", contentIndex: 0, block: { type: "text", text: "" } }] }, 1_100);
	reduceEvent(data, { type: "message_update", usage, changes: [{ type: "text_delta", contentIndex: 0, delta: "Hel" }] }, 1_200);
	const afterFirst = data.blocks[0]?.version;
	reduceEvent(data, { type: "message_update", usage, changes: [{ type: "text_delta", contentIndex: 0, delta: "lo" }] }, 1_300);

	expect(data.blocks).toHaveLength(1);
	const block = data.blocks[0];
	expect(block?.kind).toBe("agent");
	if (block?.kind !== "agent") throw new Error("expected agent block");
	expect(block.text).toBe("Hello");
	expect(block.streaming).toBe(true);
	expect(block.version).toBeGreaterThan(afterFirst ?? Number.NaN);
	expect(data.run?.phase).toBe("responding");
	expect(data.usage.contextTokens).toBe(1250);

	reduceEvent(data, { type: "message_end", entry: entry("pi.assistant", assistant([{ type: "text", text: "Hello" }])) }, 1_400);
	reduceEvent(data, { type: "run_end", inputs: [] }, 13_400);
	expect(data.blocks).toHaveLength(2);
	expect(block.streaming).toBe(false);
	expect(block.at).toBe(1_700_000_000_000);
	expect(data.run).toBeUndefined();
	expect(data.lastTurnMs).toBe(12_400);
	expect(data.blocks[1]).toMatchObject({ kind: "notice", level: "turn", text: "Worked for", elapsedMs: 12_400 });
});

test("thinking deltas stream into a thinking block that closes when the answer text starts", () => {
	const data = feed([
		{ type: "run_start", inputs: [] },
		{ type: "message_update", usage, changes: [{ type: "thinking_start", contentIndex: 0, block: { type: "thinking", thinking: "" } }] },
		{ type: "message_update", usage, changes: [{ type: "thinking_delta", contentIndex: 0, delta: "plan" }] },
	]);
	expect(data.blocks[0]).toMatchObject({ kind: "thinking", text: "plan", streaming: true });
	expect(data.run?.phase).toBe("thinking");

	reduceEvent(data, { type: "message_update", usage, changes: [{ type: "text_start", contentIndex: 1, block: { type: "text", text: "" } }, { type: "text_delta", contentIndex: 1, delta: "Done" }] }, 5_000);
	expect(data.blocks[0]).toMatchObject({ kind: "thinking", streaming: false, endedAt: 5_000 });
	expect(data.blocks[1]).toMatchObject({ kind: "agent", text: "Done" });
	expect(data.run?.phase).toBe("responding");
});

test("todo_write never shows as a tool block; its successful result becomes the current todo list", () => {
	const todos = [{ id: "a", content: "read files", status: "completed" as const }, { id: "b", content: "write summary", status: "in_progress" as const }];
	const data = feed([
		{ type: "run_start", inputs: [] },
		{ type: "message_update", usage, changes: [{ type: "toolcall_start", contentIndex: 0, block: { type: "toolCall", id: "c1", name: "todo_write", arguments: { todos } } }] },
		{ type: "message_end", entry: entry("pi.assistant", assistant([{ type: "toolCall", id: "c1", name: "todo_write", arguments: { todos } }], "toolUse")) },
		{ type: "tool_execution_start", toolCallId: "c1", toolName: "todo_write", args: { todos } },
		{ type: "tool_execution_end", toolCallId: "c1", toolName: "todo_write", entry: entry("pi.tool-result", toolResult("c1", "todo_write", "ok", { todos })) },
	]);
	expect(data.blocks.filter((block) => block.kind === "tool")).toHaveLength(0);
	expect(data.todos).toEqual(todos);
	const version = data.todosVersion;

	reduceEvent(data, { type: "tool_execution_end", toolCallId: "c2", toolName: "todo_write", entry: entry("pi.tool-result", toolResult("c2", "todo_write", "Duplicate ids", { todos: [] }, true)) }, 9_000);
	expect(data.todos).toEqual(todos);
	expect(data.todosVersion).toBe(version);
});

test("a task call renders as a subagent row that follows the live details and the final result", () => {
	const args = { description: "Summarize calc.py", prompt: "read calc.py", subagent_type: "explore" };
	const data = feed([
		{ type: "run_start", inputs: [] },
		{ type: "message_update", usage, changes: [{ type: "toolcall_start", contentIndex: 0, block: { type: "toolCall", id: "t1", name: "task", arguments: args } }] },
		{ type: "message_end", entry: entry("pi.assistant", assistant([{ type: "toolCall", id: "t1", name: "task", arguments: args }], "toolUse")) },
		{ type: "tool_execution_start", toolCallId: "t1", toolName: "task", args },
	]);
	expect(data.blocks.filter((block) => block.kind === "tool")).toHaveLength(0);
	const row = data.blocks.find((block) => block.kind === "subagent");
	expect(row).toMatchObject({ kind: "subagent", callId: "t1", progress: { description: "Summarize calc.py", subagentType: "explore", status: "running" } });
	expect(data.run?.phase).toBe("waiting_subagents");
	expect(runningSubagents(data)).toHaveLength(0);

	const running = progress("sa-7", "running", { currentTool: "read", toolCount: 1 });
	reduceEvent(data, { type: "tool_execution_update", toolCallId: "t1", toolName: "task", details: { subagent: running } }, 2_000);
	expect(row).toMatchObject({ progress: { taskId: "sa-7", currentTool: "read" } });
	expect(data.subagents.get("sa-7")).toEqual(running);
	expect(runningSubagents(data)).toHaveLength(1);

	const done = progress("sa-7", "completed", { endedAt: 25_000, lastText: "calc.py defines add and mul" });
	reduceEvent(data, { type: "tool_execution_end", toolCallId: "t1", toolName: "task", entry: entry("pi.tool-result", toolResult("t1", "task", "calc.py defines add and mul", { subagent: done })) }, 25_000);
	expect(row).toMatchObject({ progress: { status: "completed", lastText: "calc.py defines add and mul" } });
	expect(runningSubagents(data)).toHaveLength(0);
	expect(data.run?.phase).toBe("waiting_response");
});

test("task_output and kill_task results update the subagent map without adding transcript rows", () => {
	const data = feed([
		{ type: "run_start", inputs: [] },
		{ type: "tool_execution_start", toolCallId: "o1", toolName: "task_output", args: {} },
	]);
	expect(data.run?.phase).toBe("waiting_subagents");
	const blocksBefore = data.blocks.length;
	reduceEvent(data, { type: "tool_execution_end", toolCallId: "o1", toolName: "task_output", entry: entry("pi.tool-result", toolResult("o1", "task_output", "...", { subagents: [progress("sa-1", "running"), progress("sa-2", "completed")] })) }, 3_000);
	expect(data.blocks).toHaveLength(blocksBefore);
	expect([...data.subagents.keys()]).toEqual(["sa-1", "sa-2"]);
	expect(runningSubagents(data).map((subagent) => subagent.taskId)).toEqual(["sa-1"]);

	reduceEvent(data, { type: "tool_execution_end", toolCallId: "k1", toolName: "kill_task", entry: entry("pi.tool-result", toolResult("k1", "kill_task", "sa-1 [cancelled]", { subagents: [progress("sa-1", "cancelled", { endedAt: 4_000 })] })) }, 4_000);
	expect(data.subagents.get("sa-1")?.status).toBe("cancelled");
	expect(runningSubagents(data)).toHaveLength(0);
});

test("hidden tool names produce no tool block while ordinary tools do", () => {
	for (const name of ["todo_write", "task", "task_output", "kill_task"]) expect(isHiddenTool(name)).toBe(true);
	expect(isHiddenTool("read")).toBe(false);

	const data = feed([
		{ type: "run_start", inputs: [] },
		{ type: "tool_execution_start", toolCallId: "r1", toolName: "read", args: { path: "calc.py" } },
		{ type: "tool_execution_update", toolCallId: "r1", toolName: "read", output: { append: "def add" } },
		{ type: "tool_execution_update", toolCallId: "r1", toolName: "read", output: { trimStart: 4, append: "(a, b)" } },
		{ type: "tool_execution_end", toolCallId: "r1", toolName: "read", entry: entry("pi.tool-result", toolResult("r1", "read", "def add(a, b)")) },
	]);
	const tools = data.blocks.filter((block) => block.kind === "tool");
	expect(tools).toHaveLength(1);
	expect(tools[0]).toMatchObject({ name: "read", status: "done", output: "add(a, b)", result: "def add(a, b)", args: { path: "calc.py" } });
});

test("a snapshot replaces the transcript from its entries, live partial and tool slots", () => {
	const user: UserMessage = { role: "user", content: '<from user="roach" channel="tui"/>\nhello', timestamp: 2_000 };
	const call = { type: "toolCall" as const, id: "r9", name: "read", arguments: { path: "a.ts" } };
	const snapshot: AgentEvent = {
		type: "snapshot",
		entries: [entry("pi.user", user), entry("pi.assistant", assistant([call], "toolUse")), entry("pi.tool-result", toolResult("r9", "read", "export {}"))],
		run: { inputs: [] },
		generation: { attempt: 1, message: assistant([{ type: "text", text: "partial answer" }], "pending") },
		tools: [{ callId: "b1", name: "bash", status: "running", output: "listing" }, { callId: "t2", name: "task", status: "running", details: { subagent: progress("sa-3", "running") } }],
		compactions: [],
		inbox: [],
		agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: "/tmp/demo" },
		usage: { models: { "faux/faux-1": { ...usage, totalTokens: 4_000 } }, tools: {} },
	};
	const data = feed([snapshot, snapshot]);
	expect(data.blocks.map((block) => block.kind)).toEqual(["user", "tool", "agent", "tool", "subagent"]);
	expect(data.blocks[0]).toMatchObject({ kind: "user", text: "hello", at: 2_000 });
	expect(data.blocks[1]).toMatchObject({ kind: "tool", name: "read", status: "done", result: "export {}" });
	expect(data.blocks[2]).toMatchObject({ kind: "agent", text: "partial answer", streaming: true });
	expect(data.blocks[3]).toMatchObject({ kind: "tool", name: "bash", status: "running", output: "listing" });
	expect(data.blocks[4]).toMatchObject({ kind: "subagent", progress: { taskId: "sa-3" } });
	expect(data.run?.phase).toBe("waiting_subagents");
	expect(data.usage.totalTokens).toBe(4_000);
	expect(data.agent).toEqual({ model: { provider: "faux", modelId: "faux-1" }, cwd: "/tmp/demo" });
});

test("ChatState notifies subscribers once per state-changing event", () => {
	const state = new ChatState();
	let calls = 0;
	const unsubscribe = state.subscribe(() => calls++);
	state.apply({ type: "run_start", inputs: [] }, 1);
	state.apply({ type: "run_start", inputs: [] }, 2);
	state.apply({ type: "turn_start" }, 3);
	expect(calls).toBe(1);
	unsubscribe();
	state.apply({ type: "run_end", inputs: [] }, 4);
	expect(calls).toBe(1);
	expect(state.data.lastTurnMs).toBe(3);
});

test("durable aborted diagnostic distinguishes script cancellation from failed child calls", () => {
	const data = createChatData();
	reduceEvent(data, { type: "tool_execution_start", toolCallId: "cancel-script", toolName: "codemode", args: { code: "await tools.bash({});" } }, 1_000);
	const receipts = { codemodeCalls: [{ id: 1, name: "bash", status: "aborted" }] };
	reduceEvent(data, { type: "tool_execution_update", toolCallId: "cancel-script", toolName: "codemode", details: receipts }, 2_000);
	expect(data.blocks[0]).toMatchObject({ kind: "tool", status: "running", details: receipts });
	const cancelled = { ...entry("pi.tool-result", toolResult("cancel-script", "codemode", "partial output", receipts, true)), data: { diagnostics: [{ severity: "error", code: "aborted", message: "Tool codemode was aborted" }] } };
	reduceEvent(data, { type: "tool_execution_end", toolCallId: "cancel-script", toolName: "codemode", entry: cancelled }, 3_000);
	expect(data.blocks[0]).toMatchObject({ status: "cancelled", startedAt: 1_000, endedAt: 3_000, details: receipts, result: "partial output" });
	const history = createChatData();
	reduceEvent(history, { type: "entry_appended", entry: cancelled }, 9_000);
	expect(history.blocks[0]).toMatchObject({ status: "cancelled", details: receipts });
	const failure = entry("pi.tool-result", toolResult("failed-script", "codemode", "Tool codemode was aborted", receipts, true));
	reduceEvent(data, { type: "entry_appended", entry: failure }, 4_000);
	expect(data.blocks[1]).toMatchObject({ status: "error" });
});

test("reconnected codemode snapshots and streaming updates preserve independent receipt outcomes", () => {
	const data = createChatData();
	const details = { codemodeCalls: [{ id: 1, name: "read", status: "done" }, { id: 2, name: "bash", status: "running" }] };
	const call = { type: "toolCall" as const, id: "script", name: "codemode", arguments: { code: "await tools.bash({});" } };
	reduceEvent(data, {
		type: "snapshot", entries: [entry("pi.assistant", assistant([call], "toolUse"))], run: { inputs: [] },
		tools: [{ callId: "script", name: "codemode", status: "running", details }], compactions: [], inbox: [], agent: {}, usage: { models: {}, tools: {} },
	}, 1_000);
	expect(data.blocks[0]).toMatchObject({ kind: "tool", name: "codemode", status: "running", args: call.arguments, details });
	const completed = { codemodeCalls: [{ id: 1, name: "read", status: "done" }, { id: 2, name: "bash", status: "failed", error: "exit 1" }] };
	reduceEvent(data, { type: "tool_execution_update", toolCallId: "script", toolName: "codemode", details: completed }, 2_000);
	expect(data.blocks[0]).toMatchObject({ status: "running", details: completed });
	reduceEvent(data, { type: "tool_execution_end", toolCallId: "script", toolName: "codemode", entry: entry("pi.tool-result", toolResult("script", "codemode", "one child failed", completed, true)) }, 3_000);
	expect(data.blocks[0]).toMatchObject({ status: "error", details: completed });
});

test("asks in tool details are projected once; a human ask raises a notice when it opens and when it resolves", () => {
	const human = { id: "a1", to: "human", kind: "authority", question: "Delete prod?", from: { conversationId: 7 }, state: "open", default: "deny", deadlineAt: 10_000, refs: ["drop"] };
	const child = { id: "c1", to: "main", kind: "decision", question: "A or B?", from: { conversationId: 9, taskId: "sa-9" }, state: "open", default: "B", deadlineAt: 10_000 };
	const data = feed([
		{ type: "tool_execution_end", toolCallId: "t1", toolName: "task", entry: entry("pi.tool-result", toolResult("t1", "task", "waiting", { subagent: progress("sa-9", "running", { background: true }), asks: [child] })) },
		{ type: "tool_execution_end", toolCallId: "t2", toolName: "ask", entry: entry("pi.tool-result", toolResult("t2", "ask", "relay", { ask: human })) },
		{ type: "tool_execution_end", toolCallId: "t3", toolName: "ask", entry: entry("pi.tool-result", toolResult("t3", "ask", "relay again", { ask: human })) },
		{ type: "tool_execution_end", toolCallId: "t4", toolName: "answer", entry: entry("pi.tool-result", toolResult("t4", "answer", "ok", { ask: { ...human, state: "answered", answer: "allow" } })) },
		{ type: "tool_execution_end", toolCallId: "t5", toolName: "answer", entry: entry("pi.tool-result", toolResult("t5", "answer", "ok", { ask: { ...child, state: "answered", answer: "A" } })) },
	]);
	expect([...data.asks.keys()].sort()).toEqual(["a1", "c1"]);
	expect(data.asks.get("c1")).toMatchObject({ from: "sa-9", state: "answered", answer: "A" });
	expect(data.asks.get("a1")).toMatchObject({ from: "7", state: "answered", answer: "allow" });
	const notices = data.blocks.filter((block) => block.kind === "notice").map((block) => (block as { text: string }).text);
	expect(notices.filter((text) => text.startsWith("Question for you [authority]: Delete prod?"))).toHaveLength(1);
	expect(notices.filter((text) => text === "Question answered: allow")).toHaveLength(1);
	expect(notices.filter((text) => text.includes("A or B?"))).toHaveLength(0);
});

test("a turn sent before any login reads as a /login hint, not an error; other model errors stay errors", async () => {
	const { ingestEntry } = await import("../src/tui/state.ts");
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const entry = (id: number, errorMessage: string) => ({ id, conversationId: 1, kind: "pi.assistant", model: [{ role: "assistant", content: [], api: "anthropic-messages", provider: "anthropic", model: "m", usage, stopReason: "error", errorMessage, timestamp: 1 }] }) as unknown as EntryRecord;
	const data = createChatData();
	ingestEntry(data, entry(1, "Provider is not configured: anthropic"), 1);
	ingestEntry(data, entry(2, "429 rate limited"), 2);
	const notices = data.blocks.flatMap((block) => (block.kind === "notice" ? [[block.level, block.text]] : []));
	expect(notices).toEqual([["info", "Not signed in to anthropic yet. Run /login to connect it, then send again."], ["error", "429 rate limited"]]);
});

test("text already carried by message_start stays on screen while later deltas stream in (report 8912da0e)", () => {
	const data = createChatData();
	reduceEvent(data, { type: "run_start", inputs: [] }, 1_000);
	// The first publication of a generation can already hold content: the TUI must not drop it.
	reduceEvent(data, { type: "message_start", message: assistant([{ type: "text", text: "**기본 서브에" }]) }, 1_100);
	const streaming = () => data.blocks.filter((block) => block.kind === "agent").map((block) => (block.kind === "agent" ? block.text : ""));
	expect(streaming()).toEqual(["**기본 서브에"]);
	reduceEvent(data, { type: "message_update", usage, changes: [{ type: "text_delta", contentIndex: 0, delta: "이전트를 쓰거나" }] }, 1_200);
	expect(streaming()).toEqual(["**기본 서브에이전트를 쓰거나"]);
	reduceEvent(data, { type: "message_end", entry: entry("pi.assistant", assistant([{ type: "text", text: "**기본 서브에이전트를 쓰거나**" }])) }, 1_300);
	expect(streaming()).toEqual(["**기본 서브에이전트를 쓰거나**"]);
});

test("message_start without content opens no block; a thinking block it carries is kept and extended", () => {
	const data = createChatData();
	reduceEvent(data, { type: "run_start", inputs: [] }, 1_000);
	reduceEvent(data, { type: "message_start", message: assistant([]) }, 1_100);
	expect(data.blocks.filter((block) => block.kind === "agent")).toHaveLength(0);
	reduceEvent(data, { type: "message_start", message: assistant([{ type: "thinking", thinking: "plan" }]) }, 1_200);
	reduceEvent(data, { type: "message_update", usage, changes: [{ type: "thinking_delta", contentIndex: 0, delta: "ning" }] }, 1_300);
	expect(data.blocks.filter((block) => block.kind === "thinking").map((block) => (block.kind === "thinking" ? block.text : ""))).toEqual(["planning"]);
});
