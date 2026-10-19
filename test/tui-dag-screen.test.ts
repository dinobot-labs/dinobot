import { expect, test } from "bun:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { renderLayoutFrame } from "../node_modules/@earendil-works/pi-tui/dist/layout.js";
import { createHarness, MemoryTerminal } from "../script/bench/tui-render.ts";
import type { ClientEvent, ClientSnapshotEvent, DagNodeView, DagView, ResearchView, SubagentProgress, TodoItem, WorkflowStatus } from "../src/core/ui-contract.ts";
import type { Manifest } from "../src/manifest.ts";
import { ChatApp } from "../src/tui/app.ts";
import type { ApiClient } from "../src/tui/client.ts";
import { Picker } from "../src/tui/picker.ts";
import type { Screen } from "../src/tui/screen.ts";
import { ChatState } from "../src/tui/state.ts";
import { spacing } from "../src/tui/theme.ts";

const NOW = 1_700_000_000_000;
const margin = " ".repeat(spacing.margin);
const lead = " ".repeat(Math.max(0, spacing.margin - 1));
const plain = (line: string | undefined): string => stripTerminalSequences(line ?? "").trimEnd();
/** The prompt box's top border; the work deck (DAG ladder, then the TODO/Plan caption) sits directly above it. */
const promptTop = (lines: string[]): number => lines.findIndex((line) => /^\+-+\+$/.test(line));
const frame = (screen: Screen, width: number, rows = 30): string[] => {
	const root = screen["takeover"]?.root ?? screen["root"];
	renderLayoutFrame(root, width, rows, () => {});
	return renderLayoutFrame(root, width, rows, () => {}).lines.map(plain);
};
const ticking = (screen: Screen): boolean => screen["timer"] !== undefined;

const node = (partial: Partial<DagNodeView> & { id: string }): DagNodeView => ({
	kind: "act", title: `Title of ${partial.id}`, state: "pending", level: 0, parents: [], directParents: partial.parents ?? [],
	attempt: 0, maxAttempts: 3, covers: [], critical: false, ...partial,
});
/** survey (wave 1, done) -> bot (wave 2, running as sa-bot) -> check (wave 3, pending verify). */
const dag = (status: DagView["status"] = "running", botState: DagNodeView["state"] = "running"): DagView => ({
	id: "dag-1", revision: 2, status, replanBudget: 8, requirements: [{ id: "R1", certified: status === "verified" }], levels: 3, updatedAt: NOW,
	nodes: [
		node({ id: "survey", title: "Survey the repo", state: "succeeded", startedAt: NOW - 20_000, endedAt: NOW - 8_000, result: "found 3 modules" }),
		node({ id: "bot", title: "Wire the bot", state: botState, level: 1, parents: ["survey"], handle: "sa-bot", attempt: 1, startedAt: NOW - 5_000 }),
		node({ id: "check", kind: "verify", title: "Run the suite", state: status === "verified" ? "succeeded" : "pending", level: 2, parents: ["bot"], directParents: ["bot", "survey"] }),
	],
});
const progress = (taskId: string, status: SubagentProgress["status"] = "running", conversationId = 21): SubagentProgress => ({
	taskId, description: `dag-1:${taskId}`, subagentType: "general-purpose", background: true, conversationId, status, startedAt: NOW - 5_000, toolCount: 1,
});
const snapshot = (view: DagView | null): ClientSnapshotEvent => ({ type: "snapshot", entries: [], tools: [], compactions: [], inbox: [], agent: {}, usage: { models: {}, tools: {} }, dag: view });
const todos: TodoItem[] = [{ id: "1", content: "wire the pane", status: "in_progress" }];

test("completed execution keeps its independent research outcome visible in the composer", () => {
	const harness = createHarness(new ChatState(), 140, 40);
	try {
		harness.state.apply({
			type: "dag_status",
			dag: {
				...dag("verified", "succeeded"),
				research: {
					id: "mission", revision: 1, question: "Reduce latency", status: "stopped",
					judgment: "not_achieved", deadlineAt: NOW, attempts: { used: 1, limit: 2 },
					rounds: { used: 1, limit: 2 }, candidateBudget: { used: 1, limit: 2 },
					activeAttempts: 0, maxConcurrent: 1, confirmationReserved: 0, candidates: [],
					report: { directory: "/project/research", state: "written", writtenRevision: 1 },
				},
			},
		});
		expect(frame(harness.screen, 140, 40).join("\n")).toContain("outcome not_achieved");
	} finally {
		harness.dispose();
	}
});

test("dag_status shows the deck on the prompt box: the ladder, then the TODO caption, directly above the prompt; it persists until a snapshot clears it", () => {
	const harness = createHarness(new ChatState(), 100, 30);
	const { screen, state } = harness;
	try {
		state.apply({ type: "dag_status", dag: dag() });
		let lines = frame(screen, 100);
		let top = promptTop(lines);
		expect(lines[1]).toContain("main /home/user/project");
		expect(top).toBe(24);
		expect(lines[top - 4]).toStartWith(`${margin}DAG`);
		expect(lines[top - 4]).toContain("running");
		expect(lines[top - 4]).toContain("rev 2");
		expect(lines[top - 4]).toEndWith("/dag");
		expect(lines[top - 3]).toContain("survey");
		expect(lines[top - 2]).toContain("bot");
		expect(lines[top - 1]).toContain("check");
		expect(lines[top - 5]).toBe("");

		state.apply({ type: "tool_execution_update", toolCallId: "t", toolName: "todo_write", details: { todos } });
		state.notice("transcript marker");
		lines = frame(screen, 100);
		top = promptTop(lines);
		// AC1: the row after the header belongs to the transcript; ladder and caption sit on the prompt box with no blank row.
		expect(lines[2]).toContain("transcript marker");
		expect(lines[top - 5]).toStartWith(`${margin}DAG`);
		expect(lines[top - 2]).toContain("check");
		expect(lines[top - 1]).toBe(`${margin}TODO 0/1 done · Ctrl+T  [>] wire the pane`);
		for (const line of renderLayoutFrame(screen["root"], 100, 30, () => {}).lines) expect(visibleWidth(line)).toBeLessThanOrEqual(100);

		const version = state.data.dagVersion;
		state.apply({ type: "dag_status", dag: dag() });
		expect(state.data.dagVersion).toBe(version);

		// AC4: every node succeeded, so the pane is its title row alone and the caption moves up under it.
		state.apply({ type: "dag_status", dag: dag("verified", "succeeded") });
		state.apply({ type: "inbox_update", items: [] });
		state.apply({ type: "workflow_status", workflow: null });
		screen.focusTranscript();
		lines = frame(screen, 100);
		top = promptTop(lines);
		expect(screen.dagPane.visible).toBe(true);
		expect(lines[top - 2]).toStartWith(`${margin}DAG`);
		expect(lines[top - 2]).toContain("verified");
		expect(lines[top - 2]).toContain("3/3 done");
		expect(lines.filter((line) => line.includes("survey") || line.includes("Wire the bot"))).toEqual([]);
		expect(lines[top - 1]).toStartWith(`${margin}TODO 0/1 done`);

		state.apply(snapshot(null));
		expect(state.data.dag).toBeNull();
		expect(screen.dagPane.visible).toBe(false);
		expect(frame(screen, 100).some((line) => line.trimStart().startsWith("DAG"))).toBe(false);

		state.apply(snapshot(dag()));
		lines = frame(screen, 100);
		expect(lines[promptTop(lines) - (screen.todoPane.visible ? 5 : 4)]).toStartWith(`${margin}DAG`);
		screen.bind(new ChatState());
		expect(screen.dagPane.visible).toBe(false);
	} finally {
		harness.dispose();
	}
});

test("the ticker runs while a shown node is running with no active turn and stops once the run is terminal", () => {
	const harness = createHarness(new ChatState(), 100, 30);
	const { screen, state } = harness;
	try {
		expect(ticking(screen)).toBe(false);
		state.apply({ type: "dag_status", dag: dag() });
		expect(state.data.run).toBeUndefined();
		expect(state.data.subagents.size).toBe(0);
		expect(ticking(screen)).toBe(true);
		state.apply({ type: "dag_status", dag: dag("cancelled") });
		expect(ticking(screen)).toBe(false);
		state.apply({ type: "dag_status", dag: dag("running", "waiting") });
		expect(ticking(screen)).toBe(false);
	} finally {
		harness.dispose();
	}
});

class InputTerminal extends MemoryTerminal {
	onInput: ((data: string) => void) | undefined;
	override start(onInput: (data: string) => void, onResize: () => void) {
		this.onInput = onInput;
		super.start(onInput, onResize);
	}
}

function app(columns = 100, rows = 34, report: () => Promise<string> = async () => "# Report\nnegative") {
	const terminal = new InputTerminal(columns, rows);
	const opened: number[] = [];
	const reports: Array<{ channel: string; thread: string; missionId: string; file: string | undefined }> = [];
	const children = new Map<number, (event: ClientEvent) => void>();
	const client = {
		commands: async () => [], threadModel: async () => ({ model: "fake/fake", thinkingLevel: "off", supportedThinkingLevels: ["off"] }), events: async () => {},
		conversationEvents: async (id: number, receive: (event: ClientEvent) => void) => { opened.push(id); children.set(id, receive); },
		researchReport: async (channel: string, thread: string, missionId: string, file?: string) => {
			reports.push({ channel, thread, missionId, file });
			return report();
		},
	} as unknown as ApiClient;
	const chat = new ChatApp(client, { model: { provider: "fake", modelId: "fake" }, toolMode: "hybrid" } as Manifest, "main", undefined, undefined, 10000, terminal, { preferences: { load: () => ({ toolsExpanded: false }), save() {} } });
	chat.start();
	return { chat, terminal, opened, children, reports };
}

const mission = (status = "running"): ResearchView => ({
	id: "mission-1", revision: 2, question: "Check cache\x07", status, judgment: "undetermined", deadlineAt: Date.now() + 60_000,
	attempts: { used: 2, limit: 4 }, rounds: { used: 1, limit: 2 }, candidateBudget: { used: 2, limit: 3 },
	activeAttempts: 0, maxConcurrent: 1, confirmationReserved: 1,
	candidates: [{ id: "child", parentId: "base", operation: "improve", state: "evaluated", hypothesis: "cache inputs", value: 3, unit: "ms", delta: -2, validity: "unknown", verdict: "inconclusive", feedback: "\x1b[31mConfirm again\x00", runId: "dag-1", nodeId: "check" }],
	report: { directory: "/project/reports/mission-1", state: "current", writtenRevision: 1 },
});
const settleUi = async (): Promise<void> => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
const notices = (chat: ChatApp): string => chat.chat.data.blocks.flatMap(block => block.kind === "notice" ? [block.text] : []).join("\n");

for (const [columns, rows] of [[80, 30], [140, 40]] as const) {
	test(`/dag keyboard mission, lineage and contained report navigation at ${columns}x${rows}`, async () => {
		const { chat, terminal, reports, opened } = app(columns, rows, async () => "# Report\n\x1b[31mnegative\x07\x00");
		const key = (input: string) => terminal.onInput?.(input);
		const open = () => { chat.screen.prompt.setText("/dag"); key("\r"); return chat.screen.tui.modal?.component as Picker; };
		try {
			await settleUi();
			chat.chat.apply({ type: "dag_status", dag: { ...dag("verified", "succeeded"), research: mission("concluded") } });
			let picker = open();
			expect(picker).toBeInstanceOf(Picker);
			expect(picker.selected?.id).toBe("research:mission");
			for (const line of picker.render(columns)) expect(visibleWidth(line)).toBeLessThanOrEqual(columns);
			key("\r");
			expect(chat.screen.tui.modal).toBeUndefined();
			expect(notices(chat)).toContain("Question: Check cache");
			expect(notices(chat)).toContain("Outcome: undetermined");
			expect(notices(chat)).toContain("/project/reports/mission-1");
			expect(notices(chat)).toContain("lagging");

			picker = open();
			key("\x1b[B"); key("\x1b[B");
			expect(picker.selected?.id).toBe("research:candidate:child");
			key("\r");
			expect(notices(chat)).toContain("Lineage: base -> child");
			expect(notices(chat)).toContain("delta -2");
			expect(notices(chat)).toContain("Feedback: Confirm again");
			expect(notices(chat)).toContain("Execution: run dag-1 · node check");

			picker = open();
			key("\x1b[B");
			expect(picker.selected?.id).toBe("research:report");
			key("\r");
			await settleUi();
			expect(reports).toEqual([{ channel: "tui", thread: "main", missionId: "mission-1", file: "report.md" }]);
			expect(chat.chat.data.blocks.at(-1)).toMatchObject({ kind: "notice", text: "# Report\nnegative" });
			expect(notices(chat)).not.toMatch(/[\x00\x07\x1b]/);
			expect(opened).toEqual([]);
			expect(chat.screen.inTakeover).toBe(false);
			const lines = frame(chat.screen, columns, rows);
			expect(lines).toHaveLength(rows);
			expect(lines.join("\n")).toContain("negative");
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(columns);
		} finally {
			chat.screen.tui.modal?.component.cancel();
			chat.screen.stop();
		}
	});
}

test("research ticker stays live with a static verified DAG and stops at terminal mission status", () => {
	const harness = createHarness(new ChatState(), 80, 30);
	try {
		for (const status of ["running", "cancelling"]) {
			harness.state.apply({ type: "dag_status", dag: { ...dag("verified", "succeeded"), research: mission(status) } });
			expect(harness.state.data.run).toBeUndefined();
			expect(ticking(harness.screen)).toBe(true);
			expect(frame(harness.screen, 80).join("\n")).toContain("left");
		}
		harness.state.apply({ type: "dag_status", dag: { ...dag("verified", "succeeded"), research: mission("concluded") } });
		expect(ticking(harness.screen)).toBe(false);
	} finally { harness.dispose(); }
});

test("report failures become caller notices, and an in-flight report cannot leak after a thread switch", async () => {
	for (const switchThread of [false, true]) {
		let rejectReport!: (error: Error) => void;
		const pending = new Promise<string>((_resolve, reject) => { rejectReport = reject; });
		const { chat, terminal, reports } = app(80, 30, () => pending);
		try {
			await settleUi();
			chat.chat.apply({ type: "dag_status", dag: { ...dag("verified", "succeeded"), research: mission("concluded") } });
			chat.screen.prompt.setText("/dag");
			terminal.onInput?.("\r");
			terminal.onInput?.("\x1b[B");
			terminal.onInput?.("\r");
			expect(reports).toHaveLength(1);
			if (switchThread) chat.screen.prompt.onSubmit?.("/thread other");
			rejectReport(new Error("report unavailable"));
			await settleUi();
			if (switchThread) expect(notices(chat)).not.toContain("report unavailable");
			else expect(chat.chat.data.blocks.at(-1)).toMatchObject({ kind: "notice", level: "error", text: "report unavailable" });
		} finally {
			chat.screen.tui.modal?.component.cancel();
			chat.screen.stop();
		}
	}
});

test("a successful report requested in the old thread is discarded after switching threads", async () => {
	let resolveReport!: (content: string) => void;
	const pending = new Promise<string>(resolve => { resolveReport = resolve; });
	const { chat, terminal, reports } = app(140, 40, () => pending);
	try {
		await settleUi();
		chat.chat.apply({ type: "dag_status", dag: { ...dag("verified", "succeeded"), research: mission("concluded") } });
		chat.screen.prompt.setText("/dag");
		terminal.onInput?.("\r");
		terminal.onInput?.("\x1b[B");
		terminal.onInput?.("\r");
		expect(reports).toEqual([{ channel: "tui", thread: "main", missionId: "mission-1", file: "report.md" }]);
		chat.screen.prompt.onSubmit?.("/thread other");
		resolveReport("private old-thread report");
		await settleUi();
		expect(notices(chat)).not.toContain("private old-thread report");
	} finally {
		chat.screen.tui.modal?.component.cancel();
		chat.screen.stop();
	}
});

const crew = (count: number, status: DagView["status"] = "running"): DagView => ({
	id: "dag-1", revision: 0, status, replanBudget: 8, requirements: [], levels: 1, updatedAt: NOW,
	nodes: Array.from({ length: count }, (_, index) => node({ id: `n${index}`, state: "running", handle: `sa-${index}`, startedAt: NOW - 1_000 })),
});
const dockText = (screen: Screen): string => frame(screen, 100, 34).filter((line) => !line.trimStart().startsWith("DAG")).join("\n");

test("A7: the dock drops only children with a visible expanded running DAG row; folded and terminal-run children stay, counts stay whole", () => {
	const { chat } = app();
	try {
		chat.chat.apply({ type: "subagent_progress", subagents: [progress("sa-bot"), { ...progress("sa-free", "running", 22), description: "unrelated helper" }] });
		expect(dockText(chat.screen)).toContain("dag-1:sa-bot");
		chat.chat.apply({ type: "dag_status", dag: dag() });
		let dock = dockText(chat.screen);
		expect(dock).not.toContain("dag-1:sa-bot");
		expect(dock).toContain("unrelated helper");
		expect(dock).toContain("Subagents · 2 running");
		chat.screen.prompt.onSubmit?.("/agents");
		const picker = chat.screen.tui.modal?.component as Picker;
		expect(picker).toBeInstanceOf(Picker);
		expect(picker["options"].map((option) => option.id).sort()).toEqual(["sa-bot", "sa-free"]);
		picker.cancel();

		chat.chat.apply({ type: "dag_status", dag: dag("cancelled") });
		expect(dockText(chat.screen)).toContain("dag-1:sa-bot");

		const budget = chat.screen.dagPane.bodyRows();
		expect(budget).toBe(6);
		chat.chat.apply({ type: "subagent_progress", subagents: [progress("sa-bot", "completed"), { ...progress("sa-free", "completed", 22), description: "unrelated helper" }, ...Array.from({ length: 8 }, (_, index) => progress(`sa-${index}`))] });
		chat.chat.apply({ type: "dag_status", dag: crew(8) });
		dock = dockText(chat.screen);
		for (let index = 0; index < 5; index++) expect(dock).not.toContain(`dag-1:sa-${index}`);
		for (let index = 5; index < 8; index++) expect(dock).toContain(`dag-1:sa-${index}`);
		expect(dock).toContain("Subagents · 8 running");
		expect(dock).toContain("2 done");
	} finally {
		chat.screen.tui.modal?.component.cancel();
		chat.screen.stop();
	}
});

const workflow = (): WorkflowStatus => ({
	status: "implementing", workId: "work-1", sourceIds: ["1"], version: 1, methodEpoch: 0, mutationEpoch: 0, blockers: [], unmetCheckIds: ["unit"], certificate: null,
	costs: null, methods: {}, evidence: [], limitations: [],
	plan: { requirements: [{ id: "R1", assertion: "DAG pane fits", checkIds: ["unit"], state: "running" }], checks: [{ id: "unit", evidence: "behavioral", expected: "bun test passes", state: "running" }] },
});

test("AC2: the DAG title and the caption keep their screen rows with no turn, with a running turn and with an unrelated running child in the dock", () => {
	const harness = createHarness(new ChatState(), 140, 40);
	const { screen, state } = harness;
	try {
		state.apply({ type: "dag_status", dag: dag() });
		state.apply({ type: "tool_execution_update", toolCallId: "t", toolName: "todo_write", details: { todos } });
		state.notice("transcript marker");
		const rows = () => {
			const lines = frame(screen, 140, 40);
			return { dag: lines.findIndex((line) => line.startsWith(`${margin}DAG`)), caption: lines.findIndex((line) => line.startsWith(`${margin}TODO 0/1 done`)), top: promptTop(lines) };
		};
		const rest = rows();
		expect(rest).toEqual({ dag: 29, caption: 33, top: 34 });
		state.apply({ type: "run_start" } as ClientEvent);
		expect(rows()).toEqual(rest);
		state.apply({ type: "subagent_progress", subagents: [{ ...progress("sa-free", "running", 22), description: "unrelated helper" }] });
		expect(rows()).toEqual(rest);
		const lines = frame(screen, 140, 40);
		expect(lines.some((line) => line.includes("unrelated helper"))).toBe(true);
		const caption = renderLayoutFrame(screen["root"], 140, 40, () => {}).lines[rest.caption] ?? "";
		expect(visibleWidth(caption)).toBe(140);
		expect(caption).not.toContain("\x1b[0m");
	} finally {
		harness.dispose();
	}
});

test("A8: at 60x24 the DAG, TODO caption, dock, a host workflow (no status row) and a 3-line prompt leave the prompt, footer and 4 transcript rows; Ctrl+T sizes the pane first", () => {
	const harness = createHarness(new ChatState(), 60, 24);
	const { screen, state } = harness;
	try {
		state.apply({ type: "dag_status", dag: dag() });
		state.apply({ type: "tool_execution_update", toolCallId: "t", toolName: "todo_write", details: { todos: Array.from({ length: 8 }, (_, index) => ({ id: `${index}`, content: `todo item ${index}`, status: "pending" as const })) } });
		state.apply({ type: "subagent_progress", subagents: [{ ...progress("sa-a", "running", 31), description: "helper alpha" }, { ...progress("sa-b", "running", 32), description: "helper beta" }] });
		state.apply({ type: "workflow_status", workflow: workflow() });
		state.notice("transcript marker");
		screen.prompt.setText("line one\nline two\nline three");
		const lines = frame(screen, 60, 24);
		expect(lines).toHaveLength(24);
		const top = promptTop(lines);
		expect(top).toBe(16);
		expect(lines[top - 5]).toStartWith(`${margin}DAG`);
		expect(lines[top - 4]).toContain("survey");
		expect(lines[top - 1]).toBe(`${margin}[Plan 0/1 checks · implementing]  TODO 0/8 done · Ctrl+T`);
		for (const text of ["line one", "line two", "line three"]) expect(lines.some((line) => line.includes(text))).toBe(true);
		const caption = lines.findIndex((line) => line.includes("reasoning unknown"));
		expect(caption).toBeGreaterThan(0);
		expect(lines[caption - 3]).toContain("line one");
		expect(caption).toBe(20);
		expect(lines[22]).toContain("Enter:send");
		expect(lines.some((line) => line.includes("transcript marker"))).toBe(true);
		expect(screen.scroll.viewportHeight).toBeGreaterThanOrEqual(4);
		expect(lines.some((line) => line.includes("Subagents · 2 running"))).toBe(true);
		for (const line of renderLayoutFrame(screen["root"], 60, 24, () => {}).lines) expect(visibleWidth(line)).toBeLessThanOrEqual(60);

		// AC8: the focused pane is sized before the DAG body and borrows the transcript's reserve down to one row.
		screen.toggleTodoPane();
		expect(screen.mode).toBe("todo");
		const focused = frame(screen, 60, 24);
		const frameTop = focused.findIndex((line) => line.startsWith(`${lead}+[Plan 0/1 checks`));
		expect(frameTop).toBeGreaterThan(2);
		expect(focused[frameTop + 1]).toContain("[>] R1 DAG pane fits");
		expect(focused[frameTop + 2]).toContain("unit running");
		expect(focused[frameTop + 3]).toMatch(new RegExp(`^${lead}\\+ +\\+$`));
		expect(frameTop + 4).toBe(promptTop(focused));
		expect(focused[frameTop - 3]).toStartWith(`${margin}DAG`);
		expect(screen.dagPane.bodyRows()).toBe(2);
		expect(focused.findIndex((line) => line.includes("reasoning unknown"))).toBe(20);
		expect(focused[22]).toContain("h:hide done");
		expect(focused.some((line) => line.includes("transcript marker"))).toBe(true);
		expect(screen.scroll.viewportHeight).toBeGreaterThanOrEqual(1);
		screen.toggleTodoPane();
		expect(screen.mode).toBe("prompt");
		expect(screen.todoPane.visible).toBe(true);
		expect(screen.todoPane.render(60)).toHaveLength(1);
		expect(promptTop(frame(screen, 60, 24))).toBe(top);
	} finally {
		harness.dispose();
	}
});

test("A8 crowded: 8 DAG nodes, TODO, two children, an active turn, a host workflow (no status row) and a 4-line prompt still leave 4 transcript rows", () => {
	const harness = createHarness(new ChatState(), 60, 24);
	const { screen, state } = harness;
	try {
		const nodes = Array.from({ length: 8 }, (_, index) => node({ id: `n${index}`, level: index < 4 ? 0 : 1, parents: index < 4 ? [] : [`n${index - 4}`], state: index < 2 ? "running" : "pending" }));
		state.apply({ type: "dag_status", dag: { ...dag(), levels: 2, nodes } });
		state.apply({ type: "tool_execution_update", toolCallId: "t", toolName: "todo_write", details: { todos: Array.from({ length: 8 }, (_, index) => ({ id: `${index}`, content: `todo item ${index}`, status: "pending" as const })) } });
		state.apply({ type: "subagent_progress", subagents: [{ ...progress("sa-a", "running", 31), description: "helper alpha" }, { ...progress("sa-b", "running", 32), description: "helper beta" }] });
		state.apply({ type: "run_start" } as ClientEvent);
		state.apply({ type: "workflow_status", workflow: workflow() });
		state.notice("transcript marker");
		screen.prompt.setText("line one\nline two\nline three\nline four");
		const lines = frame(screen, 60, 24);
		expect(lines).toHaveLength(24);
		const top = promptTop(lines);
		expect(top).toBe(15);
		expect(lines[top - 5]).toStartWith(`${margin}DAG`);
		expect(lines[top - 1]).toContain("[Plan 0/1 checks · implementing]  TODO 0/8 done · Ctrl+T");
		for (const text of ["line one", "line four"]) expect(lines.some((line) => line.includes(text))).toBe(true);
		expect(lines.some((line) => line.includes("Subagents"))).toBe(true);
		expect(lines[22]).not.toBe("");
		expect(screen.scroll.viewportHeight).toBeGreaterThanOrEqual(4);
	} finally {
		harness.dispose();
	}
});

test("A8 takeover: the child's DAG run shows above the frame, a child without one shows none, and the parent pane returns", () => {
	const { chat, terminal, children } = app();
	try {
		chat.chat.apply({ type: "subagent_progress", subagents: [progress("sa-bot")] });
		chat.chat.apply({ type: "dag_status", dag: dag() });
		chat.screen.prompt.onSubmit?.("/agents sa-bot");
		expect(chat.screen.inTakeover).toBe(true);
		let lines = frame(chat.screen, 100, 34);
		expect(lines.some((line) => line.trimStart().startsWith("DAG"))).toBe(false);
		children.get(21)?.({ type: "dag_status", dag: { ...crew(1, "verified"), id: "child-run", nodes: [node({ id: "inner", state: "succeeded" })] } });
		lines = frame(chat.screen, 100, 34);
		expect(lines[0]).toBe("");
		expect(lines[1]).toStartWith(`${margin}DAG`);
		expect(lines[1]).toContain("verified");
		expect(lines[2]).toContain("inner");
		expect(lines.join("\n")).not.toContain("survey");
		terminal.onInput?.("\x1b");
		expect(chat.screen.inTakeover).toBe(false);
		lines = frame(chat.screen, 100, 34);
		const top = promptTop(lines);
		expect(lines[top - 4]).toStartWith(`${margin}DAG`);
		expect(lines[top - 4]).toContain("running");
		expect(lines[top - 3]).toContain("survey");
	} finally {
		chat.screen.tui.modal?.component.cancel();
		chat.screen.stop();
	}
});

test("/dag lists nodes by wave, follows live updates, opens a bound node's conversation and notices the rest", () => {
	const { chat, terminal, opened } = app();
	try {
		chat.screen.prompt.onSubmit?.("/dag");
		expect(chat.screen.tui.modal).toBeUndefined();
		expect(chat.chat.data.blocks.at(-1)).toMatchObject({ kind: "notice", text: "no DAG run in this thread" });

		chat.chat.apply({ type: "subagent_progress", subagents: [progress("sa-bot")] });
		chat.chat.apply({ type: "dag_status", dag: dag() });
		chat.screen.prompt.onSubmit?.("/dag");
		let picker = chat.screen.tui.modal?.component as Picker;
		expect(picker).toBeInstanceOf(Picker);
		expect(picker.title).toBe("DAG dag-1 · rev 2 · Enter: open node");
		expect(picker["options"].map((option) => [option.group, option.label])).toEqual([
			["Wave 1", "done · survey · Survey the repo"],
			["Wave 2", "running · bot · Wire the bot"],
			["Wave 3", "pending · check · Run the suite"],
		]);
		expect(picker["options"][0]?.description).toBe("act · attempt 0/3 · found 3 modules");
		expect(picker["options"][2]?.description).toBe("verify · attempt 0/3 · <- bot running, survey done");
		const rendered = picker.render(80).map(plain).join("\n");
		expect(rendered).toContain("Wave 1");
		expect(rendered).toContain("Wave 3");

		chat.chat.apply({ type: "subagent_progress", subagents: [{ ...progress("sa-bot"), currentTool: "read" }] });
		expect(picker["options"][1]?.description).toContain("read");

		picker.handleInput("\x1b[B");
		expect(picker.selected?.id).toBe("bot");
		picker.handleInput("\r");
		expect(chat.screen.tui.modal).toBeUndefined();
		expect(chat.screen.inTakeover).toBe(true);
		expect(opened).toEqual([21]);
		terminal.onInput?.("\x1b");
		expect(chat.screen.inTakeover).toBe(false);

		chat.screen.prompt.onSubmit?.("/dag");
		picker = chat.screen.tui.modal?.component as Picker;
		picker.handleInput("\r");
		expect(picker.selected?.id).toBe("survey");
		expect(chat.screen.tui.modal).toBeUndefined();
		expect(chat.screen.inTakeover).toBe(false);
		expect(chat.chat.data.blocks.at(-1)).toMatchObject({ kind: "notice", text: "node survey has no conversation" });
	} finally {
		chat.screen.tui.modal?.component.cancel();
		chat.screen.stop();
	}
});
