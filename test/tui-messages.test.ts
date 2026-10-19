import { expect, test } from "bun:test";
import { colorToHex, foregroundAnsi, getTerminalColorMode, mixColors, parseColor, visibleWidth } from "@earendil-works/pi-tui";
import { renderAgent, renderNotice, renderThinking, renderUser } from "../src/tui/blocks/messages.ts";
import type { RenderContext } from "../src/tui/screen.ts";
import type { AgentBlock, NoticeBlock, ThinkingBlock, UserBlock } from "../src/tui/state.ts";
import { color, formatClock, palette } from "../src/tui/theme.ts";

const WIDE = 136;
const NARROW = 60;
const AT = new Date(2026, 9, 3, 13, 46).getTime();
const CLOCK = formatClock(AT);
const KOREAN_PROMPT =
	"먼저 todo_write로 4단계 계획을 세워줘. 그 다음 explore 서브에이전트 3개를 병렬로 띄워서 calc.py, greet.ts, README.md를 각각 요약하게 해. 기다리는 동안 너는 직접 bash로 `ls -la`를 실행하고 grep으로 'def '를 찾고 calc.py를 read 해. 진행하면서 todo를 완료 처리하고, 마지막 답변은 한국어로: 제목, 글머리표 목록, 그리고 python 코드 블록 하나를 포함해줘.";
const ANSWER = "# 워크스페이스 탐색 결과\n\n- 작업 디렉터리에는 `calc.py`, `greet.ts`, `README.md`가 있다.\n- `README.md`는 제목 **tiny**와 한 줄로 작은 데모 저장소를 소개한다.\n\n```python\ndef add(a, b):\n    return a + b\n```\n";
const REASONING = "I have all the results. Now I need to mark todos 1, 3, and 4 as completed.\n\nSecond paragraph.\n\nThird paragraph.\n\nFourth paragraph.";

const plain = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, "");
const widths = (lines: readonly string[]): number[] => lines.map((line) => visibleWidth(line));
const fgOf = (hex: string): string => foregroundAnsi(parseColor(hex), getTerminalColorMode());
const ctx = (over: Partial<RenderContext> = {}): RenderContext => ({ expanded: false, selected: false, tick: 0, now: 0, running: false, ...over });
let ids = 0;
const user = (text: string): UserBlock => ({ kind: "user", id: `u${++ids}`, version: 1, text, at: AT });
const agent = (text: string, streaming = false): AgentBlock => ({ kind: "agent", id: `a${++ids}`, version: 1, text, at: AT, streaming });
const thought = (text: string, elapsedMs: number | null = 2_500): ThinkingBlock => ({ kind: "thinking", id: `t${++ids}`, version: 1, text, startedAt: 1_000, streaming: false, ...(elapsedMs === null ? {} : { endedAt: 1_000 + elapsedMs }) });
const thinking = (text: string): ThinkingBlock => ({ kind: "thinking", id: `t${++ids}`, version: 1, text, startedAt: 1_000, streaming: true });
const notice = (text: string, level: NoticeBlock["level"], elapsedMs?: number, metrics?: { tps?: number; cacheRatio?: number }): NoticeBlock => ({ kind: "notice", id: `n${++ids}`, version: 1, text, level, ...(elapsedMs === undefined ? {} : { elapsedMs }), ...(metrics === undefined ? {} : { metrics }) });

test("a user prompt renders as a full-width band with the arrow, display-width wrapped Korean text and a stamp ending at the content edge", () => {
	const lines = renderUser(user(KOREAN_PROMPT), WIDE, ctx());

	expect(lines).toHaveLength(5);
	expect(widths(lines)).toEqual([WIDE, WIDE, WIDE, WIDE, WIDE]);
	expect(plain(lines[0] ?? "").trim()).toBe("");
	expect(plain(lines[1] ?? "")).toMatch(/^ {3}> 먼저 /);
	expect(plain(lines[2] ?? "")).toMatch(/^ {5}각각 /);
	expect(plain(lines[3] ?? "")).toMatch(/^ {5}서 todo를 /);
	const stamped = plain(lines[1] ?? "").trimEnd();
	expect(stamped.endsWith(CLOCK)).toBe(true);
	expect(visibleWidth(stamped)).toBe(WIDE - 2);
	expect(lines.some((line) => line.includes("…"))).toBe(false);
});

test("a long prompt folds to three rows ending with an ellipsis at 60 columns and unfolds when expanded", () => {
	const block = user(KOREAN_PROMPT);

	const folded = renderUser(block, NARROW, ctx());
	const expanded = renderUser(block, NARROW, ctx({ expanded: true }));

	expect(folded).toHaveLength(5);
	expect(widths(folded).every((width) => width === NARROW)).toBe(true);
	expect(plain(folded[3] ?? "").trimEnd().endsWith("...")).toBe(true);
	expect(expanded.length).toBeGreaterThan(5);
	expect(widths(expanded).every((width) => width === NARROW)).toBe(true);
	expect(expanded.some((line) => line.includes("…"))).toBe(false);
});

test("a four-line prompt keeps its first rows and truncates the third, while a three-line prompt stays whole", () => {
	const four = renderUser(user("one\ntwo\nthree\nfour"), WIDE, ctx()).map(plain);
	const three = renderUser(user("one\ntwo\nthree"), WIDE, ctx()).map(plain);

	expect(four.slice(1, 4).map((line) => line.trimEnd().replace(CLOCK, "").trimEnd())).toEqual(["   > one", "     two", "     three..."]);
	expect(three).toHaveLength(5);
	expect(three[3]?.trimEnd()).toBe("     three");
});

test("an answer renders per-level headings, muted bullets, teal inline code and content-wide code panels at 140", () => {
	const lines = renderAgent(agent(ANSWER), WIDE, ctx());
	const text = lines.map(plain);

	expect(text[0]).toMatch(/^ {3}워크스페이스 탐색 결과 +1:46 PM$/);
	expect(lines[0]).toContain(fgOf(palette.teal));
	expect(lines[0]).toContain("\x1b[1m");
	expect(text[2]).toMatch(/^ {3}- 작업 디렉터리에는 calc\.py, /);
	expect(lines[2]).toContain(fgOf(palette.green1));
	expect(text.some((line) => line.includes("```"))).toBe(false);
	const code = lines.filter((line) => plain(line).startsWith("   def add(a, b):") || plain(line).startsWith("       return a + b"));
	expect(code).toHaveLength(2);
	expect(widths(code)).toEqual([WIDE - 2, WIDE - 2]);
	expect(code[0]).toContain(fgOf(palette.magenta));
	expect(code[0]).toContain(fgOf(palette.yellow));
	expect(lines.some((line) => /[\u0001-\u0012]/.test(line))).toBe(false);
	expect(widths(lines).every((width) => width <= WIDE)).toBe(true);
});

test("second-level headings take the blue heading color and hide their markers", () => {
	const lines = renderAgent(agent("## 작업 결과\n\n### 세부\n\ntext"), WIDE, ctx());
	const text = lines.map(plain);

	expect(text[0]).toMatch(/^ {3}작업 결과 +1:46 PM$/);
	expect(lines[0]).toContain(fgOf(palette.blue));
	expect(text[2]?.trimEnd()).toBe("   세부");
	expect(lines[2]).toContain(fgOf(palette.orange));
	expect(text.some((line) => line.includes("#"))).toBe(false);
});

test("an answer at 60 columns wraps Korean prose without exceeding the width and keeps the stamp on the first row", () => {
	const lines = renderAgent(agent(ANSWER), NARROW, ctx());

	expect(lines.length).toBeGreaterThan(renderAgent(agent(ANSWER), WIDE, ctx()).length);
	expect(widths(lines).every((width) => width <= NARROW)).toBe(true);
	expect(plain(lines[0] ?? "").trimEnd().endsWith(CLOCK)).toBe(true);
});

test("a streaming answer shows its partial text, and an empty one still shows the stamped row", () => {
	const partial = renderAgent(agent("## 작업 결과\n\n- `ls -la`로 파일 목록을", true), WIDE, ctx());
	const empty = renderAgent(agent("", true), WIDE, ctx());

	expect(plain(partial[0] ?? "")).toMatch(/^ {3}작업 결과 +1:46 PM$/);
	expect(plain(partial[2] ?? "")).toMatch(/^ {3}- ls -la로 파일 목록을/);
	expect(empty).toHaveLength(1);
	expect(plain(empty[0] ?? "").trimEnd().endsWith(CLOCK)).toBe(true);
});

test("a finished thought collapses to one header row and opens into a railed, blended markdown body", () => {
	const block = thought("The user wants me to:\n\n- **할 일 1**: `ls -la`");

	const collapsed = renderThinking(block, WIDE, ctx()).map(plain);
	const expanded = renderThinking(block, WIDE, ctx({ expanded: true }));
	const selected = renderThinking(block, WIDE, ctx({ selected: true })).map(plain);

	expect(collapsed).toEqual(["   ⁂ Thought for 2.5s"]);
	expect(expanded.map((line) => plain(line).trimEnd())).toEqual(["|  ⁂ Thought for 2.5s", "|", "|  The user wants me to:", "|", "|  - 할 일 1: ls -la"]);
	expect(widths(expanded.slice(2))).toEqual([WIDE - 2, WIDE - 2, WIDE - 2]);
	// Thinking body text uses palette.comment color as derived from the current theme palette
	expect(expanded[2]).toContain(fgOf(palette.comment));
	expect(expanded[4]).toContain(fgOf(palette.comment));
	expect(selected).toEqual(["   > Thought for 2.5s"]);
	expect(renderThinking(thought("x", 65_000), WIDE, ctx()).map(plain)).toEqual(["   ⁂ Thought for 1m5s"]);
	expect(renderThinking(thought("x", null), WIDE, ctx()).map(plain)).toEqual(["   ⁂ Thought"]);
});

test("a running thought shows its last three rows behind an ellipsis, everything when expanded, and only the header while empty", () => {
	const block = thinking(REASONING);

	const truncated = renderThinking(block, WIDE, ctx()).map((line) => plain(line).trimEnd());
	const expanded = renderThinking(block, WIDE, ctx({ expanded: true })).map((line) => plain(line).trimEnd());
	const empty = renderThinking(thinking(""), WIDE, ctx()).map(plain);

	expect(truncated.slice(0, 3)).toEqual(["|  ⁂ Thinking...", "|", "|  ..."]);
	expect(truncated).toHaveLength(6);
	expect(truncated[5]).toBe("|  Fourth paragraph.");
	expect(expanded.slice(0, 3)).toEqual(["|  ⁂ Thinking...", "|", "|  I have all the results. Now I need to mark todos 1, 3, and 4 as completed."]);
	expect(expanded.some((line) => line === "|  ...")).toBe(false);
	expect(empty).toEqual(["   ⁂ Thinking..."]);
});

test("thought headers take their mark from the active icon set", async () => {
	const { iconSets, setIconSet } = await import("../src/tui/theme.ts");
	setIconSet("nerd");
	try {
		const mark = iconSets.nerd.thinking;
		expect(renderThinking(thought("nerd x", null), WIDE, ctx()).map(plain)).toEqual([`   ${mark} Thought`]);
		expect(plain(renderThinking(thinking("nerd y"), WIDE, ctx())[0] ?? "")).toStartWith(`|  ${mark} Thinking`);
		expect(renderThinking(thought("nerd z", null), WIDE, ctx({ selected: true })).map(plain)).toEqual(["   > Thought"]);
	} finally {
		setIconSet("unicode");
	}
});

test("thought bodies wrap inside 60 columns with the rail on every row", () => {
	const lines = renderThinking(thought(KOREAN_PROMPT), NARROW, ctx({ expanded: true }));

	expect(lines.length).toBeGreaterThan(3);
	expect(widths(lines).every((width) => width <= NARROW)).toBe(true);
	expect(lines.every((line) => plain(line).startsWith("|"))).toBe(true);
});

test("notices render the turn marker, warning-colored errors with a rail, and muted info lines", () => {
	const turn = renderNotice(notice("Worked for", "turn", 30_000), WIDE, ctx());
	const quick = renderNotice(notice("Worked for", "turn", 4_000), WIDE, ctx());
	const error = renderNotice(notice("Turn failed: upstream exploded", "error"), WIDE, ctx());
	const info = renderNotice(notice("Stopped.", "info"), WIDE, ctx());

	expect(turn.map(plain)).toEqual(["   Worked for 30s"]);
	expect(quick.map(plain)).toEqual(["   Worked for 4.0s"]);
	expect(error.map(plain)).toEqual(["|  Turn failed: upstream exploded"]);
	expect(error[0]).toContain(fgOf(palette.yellow));
	expect(info.map(plain)).toEqual(["   Stopped."]);
	expect(info[0]).toContain(fgOf(palette.comment));
	expect(turn[0]).toContain(fgOf(palette.comment));
});

test("notices render metrics when present, absent when not measured", () => {
	// Turn notice with metrics
	const turnWithMetrics = renderNotice(notice("Worked for", "turn", 30_000, { tps: 48, cacheRatio: 0.92 }), WIDE, ctx());
	const withMetricsText = plain(turnWithMetrics[0] ?? "");
	expect(withMetricsText.trim()).toBe("Worked for 30s - 48 tok/s - cache 92%");
	// Turn notice with only tps
	const turnWithTps = renderNotice(notice("Worked for", "turn", 30_000, { tps: 48 }), WIDE, ctx());
	const withTpsText = plain(turnWithTps[0] ?? "");
	expect(withTpsText).toContain("48 tok/s");
	expect(withTpsText).not.toContain("cache");
	// Turn notice without metrics
	const turnNoMetrics = renderNotice(notice("Worked for", "turn", 30_000), WIDE, ctx());
	const noMetricsText = plain(turnNoMetrics[0] ?? "");
	expect(noMetricsText).toContain("Worked for 30s");
	expect(noMetricsText).not.toContain("tok/s");
	expect(noMetricsText).not.toContain("cache");
});

test("a long error wraps within 60 columns and keeps the rail on each row", () => {
	const lines = renderNotice(notice("Turn failed: API error (status 500 Internal Server Error): upstream exploded while streaming the response", "error"), NARROW, ctx());

	expect(lines.length).toBeGreaterThan(1);
	expect(widths(lines).every((width) => width <= NARROW)).toBe(true);
	expect(lines.every((line) => plain(line).startsWith("|  "))).toBe(true);
});

test("a block renders once per version, width and fold state, and a streaming thought re-renders per tick", () => {
	const answer = agent(ANSWER);
	const finished = thought("plan");
	const running = thinking(REASONING);

	const first = renderAgent(answer, WIDE, ctx());
	expect(renderAgent(answer, WIDE, ctx({ tick: 8, now: 99 }))).toBe(first);
	expect(renderAgent(answer, NARROW, ctx())).not.toBe(first);
	answer.text = "# 다른 제목";
	answer.version++;
	const changed = renderAgent(answer, WIDE, ctx());
	expect(changed).not.toBe(first);
	expect(plain(changed[0] ?? "")).toMatch(/^ {3}다른 제목 +1:46 PM$/);

	const prompt = user(KOREAN_PROMPT);
	expect(renderUser(prompt, WIDE, ctx())).toBe(renderUser(prompt, WIDE, ctx()));
	expect(renderUser(prompt, WIDE, ctx({ expanded: true }))).not.toBe(renderUser(prompt, WIDE, ctx()));

	const collapsed = renderThinking(finished, WIDE, ctx());
	expect(renderThinking(finished, WIDE, ctx({ tick: 4 }))).toBe(collapsed);
	expect(renderThinking(finished, WIDE, ctx({ expanded: true }))).not.toBe(collapsed);
	expect(renderThinking(finished, WIDE, ctx({ selected: true }))).not.toBe(collapsed);

	const frame = renderThinking(running, WIDE, ctx({ tick: 0 }));
	expect(renderThinking(running, WIDE, ctx({ tick: 0 }))).toBe(frame);
	expect(renderThinking(running, WIDE, ctx({ tick: 4 }))).not.toBe(frame);

	const marker = notice("Worked for", "turn", 1_000);
	expect(renderNotice(marker, WIDE, ctx())).toBe(renderNotice(marker, WIDE, ctx()));
});


test("two-width message cache preserves layout and invalidates both widths after streaming edits", () => {
	const block = agent("First answer 한글", true);
	const wide = renderAgent(block, WIDE, ctx());
	const narrow = renderAgent(block, NARROW, ctx());
	expect(renderAgent(block, WIDE, ctx())).toBe(wide);
	expect(renderAgent(block, NARROW, ctx())).toBe(narrow);
	block.text = "Updated answer 새 내용";
	block.version++;
	for (const width of [WIDE, NARROW]) {
		const lines = renderAgent(block, width, ctx());
		expect(lines.join("\n")).toContain("Updated answer");
		expect(lines.join("\n")).not.toContain("First answer");
		expect(widths(lines).every((n) => n <= width)).toBe(true);
	}
});
