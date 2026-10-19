import { expect, test } from "bun:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { PlanState, TodoItem, WorkflowStatus, WorkPlan } from "../src/core/ui-contract.ts";
import { createHarness } from "../script/bench/tui-render.ts";
import { ChatState } from "../src/tui/state.ts";
import { planLabel, planLine, planMark, planRows, planStyle, planWord, type ShownWorkflow, shownWorkflow, workflowState, workflowStyle, workflowText } from "../src/tui/panes/plan.ts";
import { chooseTab, type PaneTab, TodoPane } from "../src/tui/panes/todo.ts";
import { color } from "../src/tui/theme.ts";

const plain = (line: string | undefined): string => stripTerminalSequences(line ?? "");
const STATES: PlanState[] = ["met", "pending", "stale", "running", "cancelled", "unknown", "failed"];

const plan = (a: PlanState = "met", b: PlanState = "running", requirement: PlanState = "running"): WorkPlan => ({
	requirements: [
		{ id: "R1", assertion: "TODO와 계획이 TUI에 보인다", checkIds: ["unit", "types"], state: requirement },
		{ id: "R2", assertion: "Workflow status never claims success early", checkIds: ["types"], state: b },
	],
	checks: [
		{ id: "unit", evidence: "behavioral", expected: "bun test test/tui-plan.test.ts passes", state: a },
		{ id: "types", evidence: "typecheck", expected: "tsc --noEmit exits 0", state: b },
	],
});
const workflow = (status: WorkflowStatus["status"], current: WorkPlan | null = plan()): WorkflowStatus => ({
	status, workId: "work-1", sourceIds: ["1"], version: 1, methodEpoch: 0, mutationEpoch: 0, blockers: [],
	unmetCheckIds: current ? current.checks.filter((c) => c.state !== "met").map((c) => c.id) : [], certificate: null,
	costs: null, methods: {}, evidence: [], limitations: [], ...(current ? { plan: current } : {}),
});
const todos: TodoItem[] = [
	{ id: "1", content: "plan.ts 작성", status: "completed" },
	{ id: "2", content: "Screen 연결", status: "in_progress" },
];

test("τ: always a tab with content, the viewer's choice while it has content, otherwise the latest change", () => {
	const tabs: (PaneTab | undefined)[] = ["plan", "todo", undefined];
	let cases = 0;
	for (const hasPlan of [false, true]) for (const hasTodo of [false, true]) for (const chosen of tabs) for (const [planVersion, todoVersion] of [[1, 2], [2, 1]] as const) {
		const tab = chooseTab({ plan: hasPlan, todo: hasTodo, planVersion, todoVersion, chosen });
		const has = (t: PaneTab) => (t === "plan" ? hasPlan : hasTodo);
		if (hasPlan || hasTodo) expect(has(tab)).toBe(true);
		else expect(tab).toBe("todo");
		if (hasPlan !== hasTodo) expect(tab).toBe(hasPlan ? "plan" : "todo");
		if (chosen !== undefined && has(chosen)) expect(tab).toBe(chosen);
		if (hasPlan && hasTodo && chosen === undefined) expect(tab).toBe(planVersion > todoVersion ? "plan" : "todo");
		cases++;
	}
	expect(cases).toBe(24);
});

test("every plan state has its own mark, word and semantic color; color is never the only carrier", () => {
	expect(new Set(STATES.map(planMark)).size).toBe(STATES.length);
	expect(new Set(STATES.map(planWord)).size).toBe(STATES.length);
	expect(planStyle("met")).toBe(color.accentSuccess);
	expect(planStyle("running")).toBe(color.accentRunning);
	expect(planStyle("failed")).toBe(color.accentError);
	for (const state of STATES) for (const width of [8, 20, 40, 120]) {
		for (const row of planRows(plan(state, state, state), false)) expect(visibleWidth(planLine(row, width))).toBeLessThanOrEqual(width);
	}
});

test("λ: only the host status says verified; all checks met without a certificate awaits work_finish", () => {
	expect(planLabel(workflow("implementing"), plan())).toBe("Plan 1/2 checks · implementing");
	expect(planLabel(workflow("implementing", plan("met", "met", "met")), plan("met", "met", "met"))).toBe("Plan 2/2 checks · awaiting work_finish");
	expect(planLabel(workflow("verified", plan("met", "met", "met")), plan("met", "met", "met"))).toBe("Plan 2/2 checks · verified");
	expect(planLabel(workflow("blocked", plan("met", "met", "met")), plan("met", "met", "met"))).toBe("Plan 2/2 checks · blocked");
	for (const status of ["planning", "implementing", "verifying", "blocked", "cancelled"] as const) {
		for (const a of STATES) for (const b of STATES) expect(planLabel(workflow(status, plan(a, b)), plan(a, b))).not.toContain("verified");
	}
});

const shown = (status: WorkflowStatus["status"], current: WorkPlan | null = plan(), blockers: string[] = []): ShownWorkflow => {
	const value = { ...workflow(status, current), blockers };
	if (!shownWorkflow(value)) throw new Error(`${status} draws no workflow state`);
	return value;
};

test("workflow state: a static mark and the lowercase host status in the role color", () => {
	const roles = [
		["planning", "○", color.accentRunning], ["implementing", "○", color.accentRunning], ["verifying", "○", color.accentRunning],
		["verified", "✓", color.accentSuccess], ["blocked", "!", color.accentError], ["cancelled", "–", color.warning],
	] as const;
	for (const [status, mark, role] of roles) {
		expect(workflowStyle(shown(status))).toBe(role);
		expect(workflowState(shown(status))).toBe(role(`${mark} ${status}`));
		expect(workflowText(shown(status)).startsWith(role(`${mark} ${status}`))).toBe(true);
	}
	expect(shownWorkflow(workflow("informational"))).toBe(false);
	expect(shownWorkflow(null)).toBe(false);
});

test("workflow metadata: check progress, then not verified, awaiting work_finish, or the first blocker", () => {
	expect(plain(workflowText(shown("implementing")))).toBe("○ implementing - 1/2 checks met - not verified");
	expect(plain(workflowText(shown("verifying", plan("met", "met", "met"))))).toBe("○ verifying - 2/2 checks met - awaiting work_finish");
	expect(plain(workflowText(shown("verified", plan("met", "met", "met"))))).toBe("✓ verified - 2/2 checks met");
	expect(plain(workflowText(shown("planning", null)))).toBe("○ planning - not verified");
	expect(plain(workflowText(shown("blocked", plan("met", "failed", "failed"), ["\x1b[31mstale tree\x1b[0m\nrerun types", "second"])))).toBe("! blocked - 1/2 checks met - stale tree rerun types");
	expect(workflowText(shown("implementing"))).toContain(color.gray(" - 1/2 checks met"));
	for (const status of ["planning", "implementing", "verifying", "blocked", "cancelled"] as const) {
		for (const a of STATES) for (const b of STATES) expect(plain(workflowText(shown(status, plan(a, b), ["rerun the checks"]))).replaceAll("not verified", "")).not.toContain("verified");
	}
});

test("plan rows: requirement then its checks with state words; h hides met rows", () => {
	const rows = planRows(plan("met", "failed", "failed"), false);
	expect(rows.map((row) => row.key)).toEqual(["r:R1", "c:R1/unit", "c:R1/types", "r:R2", "c:R2/types"]);
	expect(plain(planLine(rows[0]!, 80))).toBe("[!] R1 TODO와 계획이 TUI에 보인다");
	expect(plain(planLine(rows[1]!, 80))).toBe("    [x] unit met  bun test test/tui-plan.test.ts passes");
	expect(plain(planLine(rows[2]!, 80))).toBe("    [!] types failed  tsc --noEmit exits 0");
	expect(planRows(plan("met", "failed", "failed"), true).map((row) => row.key)).toEqual(["r:R1", "c:R1/types", "r:R2", "c:R2/types"]);
	expect(planRows(plan("met", "met", "met"), true)).toEqual([]);
});

function pane(sources: { todos: TodoItem[]; workflow: WorkflowStatus | null }) {
	const versions = { todo: 1, plan: 2 };
	const p = new TodoPane(() => ({ todos: sources.todos, version: versions.todo }), () => 40, () => ({ workflow: sources.workflow, version: versions.plan }));
	return { pane: p, versions };
}

test("narrow combined pane keeps the active tab and opening shortcut discoverable", () => {
	const { pane: p, versions } = pane({ todos, workflow: workflow("implementing") });
	versions.todo = 3;
	for (const width of [40, 60]) {
		p.focused = false;
		const caption = p.render(width).map(plain).join("\n");
		expect(caption).toContain("[TODO 1/2 done]");
		expect(caption).toContain("Ctrl+T");
		p.focused = true;
		expect(plain(p.render(width)[0])).toContain("[TODO 1/2 done]");
		p.handleInput("\x1b[D");
		expect(plain(p.render(width)[0])).toContain("[Plan");
		expect(plain(p.render(width)[0])).toContain("Ctrl+T");
		p.handleInput("\x1b[C");
	}
});

test("pane: plan alone, then both with a bracketed active tab; ←/→ switches only while both exist", () => {
	const sources = { todos: [] as TodoItem[], workflow: workflow("implementing") };
	const { pane: p, versions } = pane(sources);
	expect(p.visible).toBe(true);
	// At rest the pane is one caption row: the title, then the requirement planFocus picks.
	let lines = p.render(100).map(plain);
	expect(lines).toHaveLength(1);
	expect(lines[0]).toContain("Plan 1/2 checks · implementing · Ctrl+T  [>] R1 TODO와 계획이 TUI에 보인다");
	p.handleInput("\x1b[C");
	expect(p.tab()).toBe("plan");
	sources.todos = todos;
	versions.todo = 3;
	p.invalidate();
	lines = p.render(100).map(plain);
	expect(p.tab()).toBe("todo");
	expect(lines).toHaveLength(1);
	expect(lines[0]).toContain("Plan 1/2 checks · implementing  [TODO 1/2 done] · Ctrl+T  [>] Screen 연결");
	// Focused, the framed list replaces the caption.
	p.focused = true;
	versions.plan = 4;
	p.invalidate();
	expect(p.tab()).toBe("todo");
	lines = p.render(100).map(plain);
	expect(lines[0]).toContain("· ←/→ · Ctrl+T");
	expect(lines[2]).toContain("[>] Screen 연결");
	p.handleInput("\x1b[D");
	expect(p.tab()).toBe("plan");
	lines = p.render(100).map(plain);
	expect(lines[0]).toContain("[Plan 1/2 checks · implementing]  TODO 1/2 done");
	expect(lines[1]).toContain("[>] R1 TODO와 계획이 TUI에 보인다");
	p.focused = false;
	expect(p.tab()).toBe("plan");
	versions.todo = 5;
	expect(p.tab()).toBe("todo");
	for (const width of [30, 60, 100]) for (const line of p.render(width)) expect(visibleWidth(line)).toBe(width);
	for (const line of p.render(30)) expect(line).not.toContain("\x1b[0m");
});

test("informational workflow or an empty plan never shows the plan tab", () => {
	expect(pane({ todos: [], workflow: workflow("informational") }).pane.visible).toBe(false);
	expect(pane({ todos: [], workflow: workflow("implementing", { requirements: [], checks: [] }) }).pane.visible).toBe(false);
	expect(pane({ todos: [], workflow: workflow("implementing", null) }).pane.visible).toBe(false);
});

test("Screen: a workflow_status with a plan reveals the pane without taking focus; a repeated update keeps the todo tab", () => {
	const harness = createHarness(new ChatState(), 100, 30);
	const { screen, state, terminal } = harness;
	const frame = () => {
		terminal.buffer = "";
		screen.tui.renderNow(true);
		return plain(terminal.buffer);
	};
	try {
		state.apply({ type: "workflow_status", workflow: workflow("implementing") });
		expect(screen.todoPane.visible).toBe(true);
		expect(screen.mode).toBe("prompt");
		expect(frame()).toContain("Plan 1/2 checks · implementing");
		const planVersion = state.data.workflowVersion;
		state.apply({ type: "tool_execution_update", toolCallId: "t", toolName: "todo_write", details: { todos } });
		expect(screen.todoPane.tab()).toBe("todo");
		state.apply({ type: "workflow_status", workflow: workflow("implementing") });
		expect(state.data.workflowVersion).toBe(planVersion);
		expect(screen.todoPane.tab()).toBe("todo");
		state.apply({ type: "workflow_status", workflow: workflow("implementing", plan("met", "met", "met")) });
		expect(screen.todoPane.tab()).toBe("plan");
		expect(frame()).toContain("[Plan 2/2 checks · awaiting work_finish]");
		screen.toggleTodoPane();
		expect(screen.mode).toBe("todo");
		expect(frame()).toContain("←/→");
		screen.bind(new ChatState());
		expect(screen.todoPane.visible).toBe(false);
		expect(screen.mode).toBe("prompt");
	} finally {
		harness.dispose();
	}
});
