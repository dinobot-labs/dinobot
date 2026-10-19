import { expect, test } from "bun:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { TodoItem } from "../src/core/ui-contract.ts";
import { createHarness } from "../script/bench/tui-render.ts";
import { ChatState } from "../src/tui/state.ts";
import { TodoPane, todoLine, todoPlaceholder, todoRows } from "../src/tui/panes/todo.ts";
import { ansi, bold, color, glyph, spacing, square, strike } from "../src/tui/theme.ts";

const fill = (text: string, width: number): string => `${text}${" ".repeat(width - visibleWidth(text))}`;
const plain = (line: string | undefined): string => stripTerminalSequences(line ?? "");
const band = ansi.bg("bgHighlight");
const base = ansi.bg("bgStorm");
const gutter = " ".repeat(3);
const banded = (line: string | undefined): boolean => (line ?? "").includes(`${gutter}${band}`);
const margin = " ".repeat(spacing.margin);
/** The focused pane's frame bar sits in the column before the content column and is mirrored on the right. */
const lead = " ".repeat(Math.max(0, spacing.margin - 1));
const frameInner = (width: number): number => Math.max(0, width - lead.length * 2 - 2);
const framedTop = (title: string, width: number): string => `${lead}+${fill(title, frameInner(width))}+${lead}`;
const framedRow = (text: string, width: number): string => `${lead}|${fill(text, frameInner(width))}|${lead}`;
const framedBottom = (width: number): string => `${lead}+${" ".repeat(frameInner(width))}+${lead}`;

const reference: TodoItem[] = [
	{ id: "1", content: "bash로 ls -la와 seq 1 30 실행", status: "completed" },
	{ id: "2", content: "calc.py와 greet.ts 읽기", status: "completed" },
	{ id: "3", content: "grep으로 return 찾기", status: "completed" },
];
const mixed: TodoItem[] = [
	{ id: "1", content: "Read the todo pane spec", status: "completed" },
	{ id: "2", content: "Rewrite src/tui/panes/todo.ts", status: "in_progress" },
	{ id: "3", content: "Write render tests", status: "pending" },
	{ id: "4", content: "Port the queue pane", status: "cancelled" },
];
const finished: TodoItem[] = [
	{ id: "1", content: "Read the todo pane spec", status: "completed" },
	{ id: "2", content: "Port the queue pane", status: "cancelled" },
];
const many = (count: number, active = -1): TodoItem[] =>
	Array.from({ length: count }, (_, index) => ({ id: `${index + 1}`, content: `할 일 ${index + 1}`, status: index === active ? "in_progress" : "pending" }));

function open(todos: TodoItem[], height = 40) {
	let current = todos;
	let version = 1;
	const pane = new TodoPane(() => ({ todos: current, version }), () => height);
	pane.visible = true;
	pane.focused = true;
	return {
		pane,
		set(next: TodoItem[]) {
			current = next;
			version++;
		},
	};
}

test("140 columns: ASCII frame and rows render the Ember todo pane", () => {
	const { pane } = open(reference);
	const lines = pane.render(140);
	expect(lines.map(plain)).toEqual([
		framedTop("TODO 3/3 done · Ctrl+T", 140),
		framedRow(`${gutter}[x] bash로 ls -la와 seq 1 30 실행`, 140),
		framedRow(`${gutter}[x] calc.py와 greet.ts 읽기`, 140),
		framedRow(`${gutter}[x] grep으로 return 찾기`, 140),
		framedBottom(140),
	]);
	for (const line of lines) expect(visibleWidth(line)).toBe(140);
	expect(plain(lines[0])).toBe(framedTop("TODO 3/3 done · Ctrl+T", 140));
	expect(banded(lines[1])).toBe(true);
	expect(lines[1]).toContain(`${base}${" ".repeat(spacing.rightPad)}${color.selectionBorder(square.v)}${lead}`);
});

test("status icons carry Grok's colors and text styles", () => {
	const { pane } = open(mixed);
	const lines = pane.render(140);
	expect(lines[1]).toContain(color.accentSuccess(glyph.todoCompleted));
	expect(lines[1]).toContain(color.grayBright("Read the todo pane spec"));
	expect(lines[2]).toContain(color.warning(glyph.todoInProgress));
	expect(lines[2]).toContain(bold(color.textPrimary("Rewrite src/tui/panes/todo.ts")));
	expect(lines[3]).toContain(color.textPrimary(glyph.todoPending));
	expect(lines[4]).toContain(color.accentError(glyph.todoCancelled));
	expect(lines[4]).toContain(strike(color.grayBright("Port the queue pane")));
});

test("only the in-progress row carries the bg_highlight band; unfocused, the frame gives way to the one-row caption with the current and next items", () => {
	const { pane } = open(mixed);
	const framed = pane.render(140);
	expect(framed.filter(banded)).toHaveLength(1);
	expect(banded(framed[2])).toBe(true);
	pane.focused = false;
	const bare = pane.render(140);
	expect(bare.some(banded)).toBe(false);
	expect(bare.map(plain)).toEqual([fill(`${margin}TODO 1/4 done · Ctrl+T  [>] Rewrite src/tui/panes/todo.ts  [ ] Write render tests`, 140)]);
	expect(bare[0]).toContain(color.grayBright("TODO 1/4 done · Ctrl+T"));
	expect(bare[0]).toContain(color.warning(glyph.todoInProgress));
	expect(bare[0]).toContain(bold(color.textPrimary("Rewrite src/tui/panes/todo.ts")));
	expect(bare[0]).toContain(color.textPrimary("Write render tests"));
});

test("caption width: the title never yields, the next item shows whole or not at all, the current item is cut and dropped under 12 columns", () => {
	const two: TodoItem[] = [{ id: "1", content: "twenty columns here!", status: "in_progress" }, { id: "2", content: "and twenty more cols", status: "pending" }];
	const { pane } = open(two);
	pane.focused = false;
	const at = (width: number): string => plain(pane.render(width)[0]).trimEnd();
	expect(at(80)).toBe(`${margin}TODO 0/2 done · Ctrl+T  [>] twenty columns here!  [ ] and twenty more cols`);
	expect(at(73)).toBe(`${margin}TODO 0/2 done · Ctrl+T  [>] twenty columns here!`);
	expect(at(48)).toBe(`${margin}TODO 0/2 done · Ctrl+T  [>] twenty columns here!`);
	expect(at(47)).toBe(`${margin}TODO 0/2 done · Ctrl+T  [>] twenty columns h...`);
	expect(at(36)).toBe(`${margin}TODO 0/2 done · Ctrl+T  [>] twent...`);
	expect(at(35)).toBe(`${margin}TODO 0/2 done · Ctrl+T`);
	for (const width of [40, 60, 100, 140]) {
		const lines = pane.render(width);
		expect(lines).toHaveLength(1);
		expect(visibleWidth(lines[0] ?? "")).toBe(width);
		expect(lines[0]).not.toContain("\x1b[0m");
	}
	const done = open(finished);
	done.pane.focused = false;
	expect(plain(done.pane.render(140)[0]).trimEnd()).toBe(`${margin}TODO 1/2 done · Ctrl+T  1 done. 1 cancelled.`);
	expect(done.pane.render(140)[0]).toContain(color.grayBright("1 done. 1 cancelled."));
	const pending = open(many(3));
	pending.pane.focused = false;
	expect(plain(pending.pane.render(140)[0]).trimEnd()).toBe(`${margin}TODO 0/3 done · Ctrl+T  [ ] 할 일 1  [ ] 할 일 2`);
});

test("a screen cap of 2 leaves the focused frame its title row; a cap of 3 holds one item", () => {
	let cap = 2;
	const pane = new TodoPane(() => ({ todos: mixed, version: 1 }), () => 40, undefined, () => cap);
	pane.visible = true;
	pane.focused = true;
	expect(pane.render(140).map(plain)).toEqual([framedTop("TODO 1/4 done · Ctrl+T", 140)]);
	cap = 3;
	const lines = pane.render(140).map(plain);
	expect(lines).toHaveLength(3);
	expect(lines[0]).toBe(framedTop("TODO 1/4 done · Ctrl+T", 140));
	expect(lines[1]).toContain("[>] Rewrite src/tui/panes/todo.ts");
	expect(lines[2]).toBe(framedBottom(140));
});

test("h hides completed and cancelled rows; the placeholder summarizes them when nothing is left", () => {
	const { pane } = open(mixed);
	pane.handleInput("h");
	expect(pane.hideDone).toBe(true);
	const rows = pane.render(140).map(plain);
	expect(rows).toHaveLength(4);
	expect(rows[1]).toContain("[>] Rewrite src/tui/panes/todo.ts");
	expect(rows[2]).toContain("[ ] Write render tests");
	const done = open(finished);
	done.pane.handleInput("h");
	const lines = done.pane.render(140);
	expect(plain(lines[1])).toBe(framedRow(`${gutter}1 done. 1 cancelled.`, 140));
	expect(lines[1]).toContain(color.grayBright("1 done. 1 cancelled."));
	expect(banded(lines[1])).toBe(false);
});

test("todoPlaceholder mirrors Grok's empty messages", () => {
	expect(todoPlaceholder([])).toBe("No todo items.");
	expect(todoPlaceholder(many(3).map((todo) => ({ ...todo, status: "completed" })))).toBe("All done.");
	expect(todoPlaceholder(many(2).map((todo) => ({ ...todo, status: "cancelled" })))).toBe("2 cancelled.");
	expect(todoPlaceholder(finished)).toBe("1 done. 1 cancelled.");
});

test("60 columns: Hangul rows are truncated with … and never exceed the width", () => {
	const long: TodoItem[] = [
		{ id: "1", content: "서브에이전트 2개 병렬 실행 (calc.py, greet.ts 요약) 그리고 워크스페이스 점검까지 모두 수행", status: "in_progress" },
		{ id: "2", content: "한국어 짧은 최종 답변", status: "pending" },
	];
	const { pane } = open(long);
	const lines = pane.render(60);
	for (const line of lines) expect(visibleWidth(line)).toBe(60);
	expect(plain(lines[1])).toMatch(new RegExp(`^${lead}\\| {3}\\[>\\] 서브에이전트 .*\\.\\.\\. {2}\\|${lead}$`));
	expect(plain(lines[2])).toBe(framedRow(`${gutter}[ ] 한국어 짧은 최종 답변`, 60));
	expect(banded(lines[1])).toBe(true);
	for (const line of lines) expect(line).not.toContain("\x1b[0m");
	for (const line of open(reference).pane.render(60)) expect(visibleWidth(line)).toBe(60);
});

test("long lists scroll: ▼ then ▲ indicators, a scrollbar column and End/Home/arrow keys move the cursor", () => {
	const { pane } = open(many(30), 40);
	let lines = pane.render(140);
	expect(lines).toHaveLength(8);
	expect(plain(lines[6])).toMatch(new RegExp(`\\[ \\] 할 일 6 +v {4}\\|${lead}$`));
	expect(lines[6]).toContain(color.gray(glyph.cutBelow));
	expect(plain(lines[1])).toMatch(new RegExp(`\\[ \\] 할 일 1 +█ {2}\\|${lead}$`));
	expect(lines[1]).toContain(color.scrollbarThumb("█"));
	expect(lines.some((line) => plain(line).includes("^"))).toBe(false);
	pane.handleInput("\x1b[F");
	lines = pane.render(140);
	expect(plain(lines[1])).toContain("^");
	expect(plain(lines[6])).toContain("[ ] 할 일 30");
	expect(banded(lines[6])).toBe(true);
	expect(lines.some((line) => plain(line).includes("v"))).toBe(false);
	pane.handleInput("\x1b[H");
	lines = pane.render(140);
	expect(banded(lines[1])).toBe(true);
	expect(plain(lines[1])).toContain("[ ] 할 일 1");
	pane.handleInput("\x1b[B");
	expect(banded(pane.render(140)[2])).toBe(true);
	for (const line of lines) expect(visibleWidth(line)).toBe(140);
});

test("the cursor defaults to the first in-progress row and scrolls it into view", () => {
	const { pane } = open(many(30, 20), 40);
	const lines = pane.render(140);
	expect(plain(lines.find(banded))).toContain("[>] 할 일 21");
	expect(plain(lines[1])).toContain("^");
	expect(plain(lines[6])).toContain("v");
});

test("render returns the cached array until the todos, the cursor, the focus or the width change", () => {
	const { pane, set } = open(mixed);
	const first = pane.render(140);
	expect(pane.render(140)).toBe(first);
	pane.handleInput("\x1b[B");
	const moved = pane.render(140);
	expect(moved).not.toBe(first);
	expect(banded(moved[3])).toBe(true);
	expect(banded(moved[2])).toBe(false);
	expect(pane.render(140)).toBe(moved);
	set([...mixed]);
	expect(pane.render(140)).not.toBe(moved);
	expect(pane.render(60)).not.toBe(pane.render(140));
});

test("todoRows caps the pane at 15% of the view, at most 10 and at least 1", () => {
	expect(todoRows(40)).toBe(6);
	expect(todoRows(80)).toBe(10);
	expect(todoRows(30)).toBe(4);
	expect(todoRows(5)).toBe(1);
});

test("todoLine fits icon, space and text into the width", () => {
	const todo: TodoItem = { id: "1", content: "워크스페이스 점검: ls -la, cat calc.py", status: "pending" };
	expect(visibleWidth(todoLine(todo, 12))).toBeLessThanOrEqual(12);
	expect(plain(todoLine(todo, 12))).toBe("[ ] 워크...");
	expect(plain(todoLine({ ...todo, content: "short" }, 12))).toBe("[ ] short");
});

test("Esc and q close the pane through onClose", () => {
	const { pane } = open(mixed);
	let closed = 0;
	pane.onClose = () => closed++;
	pane.handleInput("\x1b");
	pane.handleInput("q");
	expect(closed).toBe(2);
});

for (const toolName of ["todo_write", "codemode"]) {
	test(`${toolName} reveals TODOs in the actual screen without stealing input focus`, () => {
		const harness = createHarness(new ChatState(), 60, 24);
		const { screen, state, terminal } = harness;
		const update = (todos: TodoItem[]) => harness.frame([{
			type: "tool_execution_update", toolCallId: "todo-live", toolName, details: { todos },
		}]);
		try {
			expect(screen.todoPane.visible).toBe(false);
			update(mixed);
			expect(screen.todoPane.visible).toBe(true);
			expect(screen.mode).toBe("prompt");
			expect(screen.todoPane.render(60)).toHaveLength(1);
			expect(plain(terminal.buffer)).toContain("TODO 1/4 done");
			expect(plain(terminal.buffer)).toContain("[>] Rewrite src/tui/panes/todo.ts");
			screen.toggleTodoPane();
			expect(screen.mode).toBe("todo");
			expect(screen.todoPane.visible).toBe(true);
			expect(screen.todoPane.render(60).length).toBeGreaterThan(1);
			// Closing collapses the frame back to the caption instead of hiding the list for the rest of the conversation.
			screen.todoPane.handleInput("q");
			expect(screen.mode).toBe("prompt");
			expect(screen.todoPane.visible).toBe(true);
			expect(screen.todoPane.render(60)).toHaveLength(1);
			update(finished);
			expect(screen.todoPane.visible).toBe(true);
			expect(plain(terminal.buffer)).toContain("1 done. 1 cancelled.");
			// A different conversation must not inherit row filtering or the explicit open.
			const restored = new ChatState();
			restored.apply({
				type: "tool_execution_update", toolCallId: "restore", toolName, details: { todos: mixed },
			});
			screen.bind(restored);
			screen.tui.renderNow();
			expect(screen.todoPane.visible).toBe(true);
			expect(screen.mode).toBe("prompt");
			screen.toggleTodoPane();
			restored.apply({
				type: "tool_execution_update", toolCallId: "clear", toolName, details: { todos: [] },
			});
			// Updates never move focus: the focused pane shows its placeholder until it is closed, then leaves no row.
			expect(screen.mode).toBe("todo");
			expect(screen.todoPane.visible).toBe(true);
			expect(screen.todoPane.render(60).map(plain).join("\n")).toContain("No todo items.");
			screen.toggleTodoPane();
			expect(screen.mode).toBe("prompt");
			expect(screen.todoPane.visible).toBe(false);
			expect(screen.todoPane.render(60)).toEqual([]);
			expect(state.data.todos).toEqual(finished);
		} finally {
			harness.dispose();
		}
	});
}

test("preloaded TODOs auto-render and empty lists remain manually discoverable", () => {
	const state = new ChatState();
	state.apply({ type: "tool_execution_update", toolCallId: "saved", toolName: "todo_write", details: { todos: finished } });
	const harness = createHarness(state, 80, 30);
	try {
		expect(plain(harness.terminal.buffer)).toContain("TODO 1/2 done");
		expect(harness.screen.mode).toBe("prompt");
		harness.screen.bind(new ChatState());
		expect(harness.screen.todoPane.visible).toBe(false);
		harness.screen.toggleTodoPane();
		expect(harness.screen.todoPane.render(80).map(plain).join("\n")).toContain("No todo items.");
		expect(harness.screen.mode).toBe("todo");
		harness.screen.toggleTodoPane();
		expect(harness.screen.mode).toBe("prompt");
		expect(harness.screen.todoPane.visible).toBe(false);
		expect(harness.screen.todoPane.render(80)).toEqual([]);
	} finally {
		harness.dispose();
	}
});

for (const hidden of [true, false]) {
	test(`Screen rebind discards equal-version conversation todos while pane is ${hidden ? "collapsed" : "open"}`, () => {
		// Given a real Screen with a populated and cached todo pane.
		const a = new ChatState();
		const b = new ChatState();
		const hydrate = (state: ChatState, content: string) => state.apply({
			type: "tool_execution_update", toolCallId: "todos", toolName: "todo_write",
			details: { todos: [{ id: "same-id", content, status: "pending" }] },
		});
		hydrate(a, "THREAD A TODO");
		const harness = createHarness(a, 80, 40);
		try {
			const { screen } = harness;
			screen.toggleTodoPane();
			screen.tui.renderNow();
			expect(screen.todoPane.render(80).map(plain).join("\n")).toContain("THREAD A TODO");
			if (hidden) {
				screen.toggleTodoPane();
				screen.bind(b);
				screen.tui.renderNow(); // An empty collapsed pane must not retain A's cache.
				hydrate(b, "THREAD B TODO");
				screen.toggleTodoPane();
			} else {
				hydrate(b, "THREAD B TODO");
				screen.bind(b);
			}
			// When a different conversation reuses the same numeric version.
			expect(b.data.todosVersion).toBe(a.data.todosVersion);
			screen.tui.renderNow();
			// Then the pane displays B's todos, never A's cached rows.
			const text = screen.todoPane.render(80).map(plain).join("\n");
			expect(text).toContain("THREAD B TODO");
			expect(text).not.toContain("THREAD A TODO");
		} finally {
			harness.dispose();
		}
	});
}
