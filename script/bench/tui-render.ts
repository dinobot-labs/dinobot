/**
 * TUI render-speed harness: drives the real Screen (TuiAltScreen + Transcript + panes + chrome) on an in-memory
 * terminal through ChatState with realistic AgentEvents, and times every frame (event batch + the synchronous
 * render pass the app would run for it). Shared by `bun run bench:tui` and test/tui-perf.test.ts.
 */
import type { AssistantMessage, ToolResultMessage, Usage, UserMessage } from "@earendil-works/pi-ai";
import type { AgentEvent, ConversationId, EntryId, EntryRecord } from "@earendil-works/pi-durable";
import type { Terminal } from "@earendil-works/pi-tui";
import type { SubagentProgress, TodoItem } from "../../src/core/ui-contract.ts";
import { Screen } from "../../src/tui/screen.ts";
import { ChatState } from "../../src/tui/state.ts";

export type Stats = { name: string; frames: number; mean: number; p95: number; max: number; over16: number; over33: number };
export type Budget = { mean: number; p95: number };
export type Report = { firstRender: number; scenarios: Stats[] };

export const FIRST_RENDER_BUDGET_MS = 250;
export const BUDGETS: Record<string, Budget> = {
	"stream 200 deltas on 500 entries": { mean: 4, p95: 16 },
	"todo pane 30 status updates": { mean: 4, p95: 16 },
	"8 subagents 300 updates": { mean: 4, p95: 16 },
	"resize 140<->60 x20": { mean: 25, p95: 1000 / 30 },
	"resize unique widths x20": { mean: 100, p95: 100 },
};

/** pi-tui Terminal kept in memory: fixed size, write() appends to a buffer, no tty. */
export class MemoryTerminal implements Terminal {
	buffer = "";
	bytes = 0;
	private resize: (() => void) | undefined;

	constructor(
		private cols: number,
		private height: number,
	) {}

	start(_onInput: (data: string) => void, onResize: () => void): void {
		this.resize = onResize;
	}
	stop(): void {
		this.resize = undefined;
	}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.buffer += data;
		this.bytes += data.length;
	}
	get columns(): number {
		return this.cols;
	}
	get rows(): number {
		return this.height;
	}
	get kittyProtocolActive(): boolean {
		return false;
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}

	setSize(cols: number, rows: number): void {
		this.cols = cols;
		this.height = rows;
		this.resize?.();
	}
}

const usage: Usage = { input: 12_000, output: 800, cacheRead: 4_000, cacheWrite: 0, totalTokens: 16_800, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.02 } };
let entryIds = 0;
const entry = (kind: string, message: UserMessage | AssistantMessage | ToolResultMessage): EntryRecord => ({ id: ++entryIds as EntryId, conversationId: 1 as ConversationId, kind, model: [message] });
const assistant = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage => ({ role: "assistant", content, api: "pi-messages", provider: "faux", model: "faux-1", usage, stopReason, timestamp: 1_700_000_000_000 });
const toolResult = (toolCallId: string, toolName: string, text: string, details?: unknown): ToolResultMessage => ({ role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], ...(details === undefined ? {} : { details: details as never }), isError: false, timestamp: 1 });

const answer = (i: number): string =>
	[
		`## 결과 ${i}: \`src/module${i}.ts\` 분석`,
		"",
		`요청하신 파일을 읽고 정리했습니다. 이 모듈은 **상태 축약기**와 렌더러 사이의 경계를 담당하며, 변경 사항은 아래와 같습니다.`,
		"",
		`- 첫째, \`reduceEvent\`가 블록 버전을 올립니다 (${i}번째 변경).`,
		"- 둘째, 캐시된 행만 다시 그립니다.",
		"  - 중첩 항목: 한국어와 English mixed text that wraps across the terminal width when it is long enough.",
		"",
		"```ts",
		`export function handler${i}(input: string): number {`,
		"\tconst parts = input.split(\",\").map((part) => part.trim());",
		`\treturn parts.length + ${i};`,
		"}",
		"```",
		"",
		`> 참고: 테스트 ${i}개가 통과했습니다.`,
	].join("\n");

function turnEvents(i: number): AgentEvent[] {
	const tools = ["bash", "read", "edit", "grep"] as const;
	const name = tools[i % tools.length] as string;
	const callId = `call-${i}`;
	const args = name === "bash" ? { command: `bun test test/file${i}.test.ts`, description: `Run tests ${i}` } : name === "read" ? { path: `src/file${i}.ts` } : name === "edit" ? { path: `src/file${i}.ts`, oldText: "a", newText: "b" } : { pattern: `handler${i}`, path: "src" };
	const output = Array.from({ length: 24 }, (_, k) => `${k + 1}\tconst value${k} = compute(${i}, ${k}); // 줄 ${k}`).join("\n");
	return [
		{ type: "message_end", entry: entry("pi.user", { role: "user", content: `질문 ${i}: src/module${i}.ts 파일에서 렌더링이 느려지는 원인을 찾아 주세요. Please also check the caching path.`, timestamp: 1_700_000_000_000 }) },
		{ type: "message_end", entry: entry("pi.assistant", assistant([{ type: "thinking", thinking: `파일 ${i}을 먼저 읽고 호출 경로를 확인한다. Then compare with the cached transcript rows.` }, { type: "toolCall", id: callId, name, arguments: args }], "toolUse")) },
		{ type: "entry_appended", entry: entry("pi.tool-result", toolResult(callId, name, output)) },
		{ type: "message_end", entry: entry("pi.assistant", assistant([{ type: "text", text: answer(i) }])) },
	];
}

export type Harness = { state: ChatState; screen: Screen; terminal: MemoryTerminal; now: () => number; frame: (events: AgentEvent[]) => number; dispose: () => void };

/** Builds the real Screen on a MemoryTerminal; `frame` applies one event batch and flushes the render synchronously. */
export function createHarness(state = new ChatState(), cols = 140, rows = 45): Harness {
	const terminal = new MemoryTerminal(cols, rows);
	const screen = new Screen(terminal, state, { thread: "tui:bench", cwd: "/home/user/project", branch: "main", model: "faux/faux-1", toolMode: "codemode", contextWindow: 200_000, version: "0.1.0" });
	screen.start();
	screen.tui.renderNow();
	let clock = 1_700_000_000_000;
	const now = (): number => (clock += 50);
	const frame = (events: AgentEvent[]): number => {
		terminal.buffer = "";
		const start = performance.now();
		for (const event of events) state.apply(event, now());
		screen.tui.renderNow();
		return performance.now() - start;
	};
	return { state, screen, terminal, now, frame, dispose: () => screen.stop() };
}

export function summarize(name: string, samples: number[]): Stats {
	const sorted = [...samples].sort((a, b) => a - b);
	const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
	const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? Number.NaN;
	return { name, frames: samples.length, mean, p95, max: sorted.at(-1) ?? Number.NaN, over16: samples.filter((ms) => ms > 1000 / 60).length, over33: samples.filter((ms) => ms > 1000 / 30).length };
}

export function seedTranscript(state: ChatState, entries = 500): void {
	let now = 1_600_000_000_000;
	for (let i = 0; i < entries / 4; i++) for (const event of turnEvents(i)) state.apply(event, (now += 10));
}

/** First full render of a 500-entry transcript: the renderNow() right after start on a pre-filled state. */
export function measureFirstRender(): number {
	const state = new ChatState();
	seedTranscript(state, 500);
	const terminal = new MemoryTerminal(140, 45);
	const screen = new Screen(terminal, state, { thread: "tui:bench", cwd: "/home/user/project", branch: "main", model: "faux/faux-1", toolMode: "codemode", contextWindow: 200_000, version: "0.1.0" });
	screen.start();
	const start = performance.now();
	screen.tui.renderNow();
	const elapsed = performance.now() - start;
	screen.stop();
	return elapsed;
}

export function scenarioStreaming(): number[] {
	const state = new ChatState();
	seedTranscript(state, 500);
	const h = createHarness(state);
	h.frame([{ type: "message_end", entry: entry("pi.user", { role: "user", content: "마지막 질문: 전체 요약을 스트리밍으로 보여 주세요.", timestamp: 1_700_000_000_000 }) }, { type: "run_start", inputs: [] }]);
	h.frame([{ type: "message_update", usage, changes: [{ type: "text_start", contentIndex: 0, block: { type: "text", text: "" } }] }]);
	const samples: number[] = [];
	for (let d = 0; d < 200; d++) {
		const delta = d % 25 === 0 ? `\n\n### 섹션 ${d / 25}\n\n` : d % 40 === 7 ? "\n```ts\nconst x = 1;\n```\n" : d % 3 === 0 ? "토큰을 " : "stream ";
		samples.push(h.frame([{ type: "message_update", usage, changes: [{ type: "text_delta", contentIndex: 0, delta }] }]));
	}
	h.dispose();
	return samples;
}

export function scenarioTodos(): number[] {
	const state = new ChatState();
	seedTranscript(state, 40);
	const h = createHarness(state);
	h.frame([{ type: "run_start", inputs: [] }]);
	const todos: TodoItem[] = Array.from({ length: 30 }, (_, k) => ({ id: `t${k}`, content: `할 일 ${k}: update src/tui/module${k}.ts and verify the rendering path`, status: "pending" }));
	const write = (k: number): AgentEvent => ({ type: "entry_appended", entry: entry("pi.tool-result", toolResult(`todo-${k}`, "todo_write", "ok", { todos: todos.map((todo) => ({ ...todo })) })) });
	h.frame([write(-1)]);
	h.screen.toggleTodoPane();
	h.screen.tui.renderNow();
	const samples: number[] = [];
	for (let k = 0; k < 30; k++) {
		const current = todos[k] as TodoItem;
		current.status = "completed";
		const next = todos[k + 1];
		if (next) next.status = "in_progress";
		samples.push(h.frame([write(k)]));
	}
	h.dispose();
	return samples;
}

export function scenarioSubagents(): number[] {
	const state = new ChatState();
	seedTranscript(state, 40);
	const h = createHarness(state);
	h.frame([{ type: "run_start", inputs: [] }]);
	const startedAt = 1_700_000_000_000;
	const agents: SubagentProgress[] = Array.from({ length: 8 }, (_, k) => ({ taskId: `sa-${k}`, description: `Explore module ${k} 탐색`, subagentType: k % 2 ? "explore" : "general-purpose", background: false, conversationId: k + 2, status: "running", startedAt, toolCount: 0 }));
	h.frame(agents.map((agent, k): AgentEvent => ({ type: "tool_execution_start", toolCallId: `task-${k}`, toolName: "task", args: { description: agent.description, subagent_type: agent.subagentType } })));
	h.frame(agents.map((agent, k): AgentEvent => ({ type: "tool_execution_update", toolCallId: `task-${k}`, toolName: "task", details: { subagent: agent } })));
	const samples: number[] = [];
	for (let u = 0; u < 300; u++) {
		const k = u % agents.length;
		const previous = agents[k] as SubagentProgress;
		const next: SubagentProgress = { ...previous, toolCount: previous.toolCount + 1, currentTool: ["read", "grep", "bash"][u % 3] as string, lastText: `파일 ${u}을 읽는 중입니다 reading src/file${u}.ts`, tokens: 1_000 + u * 37 };
		agents[k] = next;
		samples.push(h.frame([{ type: "tool_execution_update", toolCallId: `task-${k}`, toolName: "task", details: { subagent: next } }]));
	}
	h.dispose();
	return samples;
}

export function scenarioResize(sweep = false): number[] {
	const state = new ChatState();
	seedTranscript(state, 500);
	const h = createHarness(state);
	const samples: number[] = [];
	for (let r = 0; r < 20; r++) {
		const cols = sweep ? 60 + r * 4 : r % 2 === 0 ? 60 : 140;
		const start = performance.now();
		h.terminal.setSize(cols, 45);
		h.screen.tui.renderNow();
		samples.push(performance.now() - start);
	}
	h.dispose();
	return samples;
}

export const SCENARIOS: [string, () => number[]][] = [
	["stream 200 deltas on 500 entries", scenarioStreaming],
	["todo pane 30 status updates", scenarioTodos],
	["8 subagents 300 updates", scenarioSubagents],
	["resize 140<->60 x20", scenarioResize],
	["resize unique widths x20", () => scenarioResize(true)],
];

/** Warm up (one unmeasured pass of everything), then measure each scenario after a forced GC. */
export function runAll(): Report {
	measureFirstRender();
	for (const [, run] of SCENARIOS) run();
	Bun.gc(true);
	const firstRender = measureFirstRender();
	const scenarios = SCENARIOS.map(([name, run]) => {
		Bun.gc(true);
		return summarize(name, run());
	});
	return { firstRender, scenarios };
}

export function violations(report: Report): string[] {
	const out: string[] = [];
	if (report.firstRender > FIRST_RENDER_BUDGET_MS) out.push(`first render ${report.firstRender.toFixed(2)}ms > ${FIRST_RENDER_BUDGET_MS}ms`);
	for (const stats of report.scenarios) {
		const budget = BUDGETS[stats.name];
		if (!budget) continue;
		if (stats.mean > budget.mean) out.push(`${stats.name}: mean ${stats.mean.toFixed(3)}ms > ${budget.mean}ms`);
		if (stats.p95 > budget.p95) out.push(`${stats.name}: p95 ${stats.p95.toFixed(3)}ms > ${budget.p95}ms`);
	}
	return out;
}

export function formatReport(report: Report): string {
	const rows = report.scenarios.map((s) => {
		const b = BUDGETS[s.name];
		return `${s.name.padEnd(34)} ${String(s.frames).padStart(6)} ${s.mean.toFixed(3).padStart(9)} ${s.p95.toFixed(3).padStart(9)} ${s.max.toFixed(3).padStart(9)}   ${b ? `mean<=${b.mean} p95<=${b.p95}` : "-"}   >16.7ms=${s.over16}/${s.frames} >33.3ms=${s.over33}/${s.frames}`;
	});
	return [
		`${"scenario".padEnd(34)} ${"frames".padStart(6)} ${"mean ms".padStart(9)} ${"p95 ms".padStart(9)} ${"max ms".padStart(9)}   budget`,
		...rows,
		`${"first full render (500 entries)".padEnd(34)} ${"1".padStart(6)} ${report.firstRender.toFixed(3).padStart(9)} ${"".padStart(9)} ${"".padStart(9)}   <=${FIRST_RENDER_BUDGET_MS}`,
	].join("\n");
}

if (import.meta.main) {
	const report = runAll();
	console.log(formatReport(report));
	const failed = violations(report);
	if (failed.length > 0) {
		console.error(`\nBUDGET EXCEEDED:\n${failed.map((line) => `  - ${line}`).join("\n")}`);
		process.exit(1);
	}
	console.log("\nall budgets met");
	process.exit(0);
}
