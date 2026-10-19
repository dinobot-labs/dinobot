import { expect, test } from "bun:test";
import { type Terminal, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import { formatTokensShort, PromptBox, promptCaption, renderFooter, renderHeader, renderTurnStatus, ShortcutsOverlay, shortcutsOverlayLayout, turnLabel } from "../src/tui/chrome.ts";
import type { RunState } from "../src/tui/state.ts";
import { color, glyph, spacing } from "../src/tui/theme.ts";

const WIDTHS = [60, 140] as const;
const margin = " ".repeat(spacing.margin);
/** The turn-status and workflow rows sit one column inside the page margin. */
const statusInset = `${margin}${" ".repeat(spacing.status)}`;
const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m|\x1b_pi:c\x07/g, "");
const fits = (lines: readonly string[], width: number): void => {
	for (const line of lines) expect(visibleWidth(line), strip(line)).toBeLessThanOrEqual(width);
};

class StubTerminal implements Terminal {
	constructor(
		readonly columns: number,
		readonly rows: number,
	) {}
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(): void {}
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
}

const tui = (cols = 140, rows = 40): TuiAltScreen => new TuiAltScreen(new StubTerminal(cols, rows), false);
const run = (phase: RunState["phase"], tool?: string): RunState => ({ startedAt: 1_000, phase, phaseStartedAt: 10_100, ...(tool === undefined ? {} : { tool }) });

test("header: welcome shows branch glyph + cwd only, a session shows usage │ [thread], both bounded at 60 and 140", () => {
	for (const width of WIDTHS) {
		const welcome = renderHeader({ branch: "master", cwd: "/home/roach/프로젝트/디노봇/아주/긴/경로/이름", used: 0, window: 256_000, thread: "tui:main", welcome: true }, width);
		expect(strip(welcome)).toContain(`${glyph.branch} master`);
		expect(strip(welcome)).not.toContain("256K");
		fits([welcome], width);

		const session = renderHeader({ branch: "master", cwd: "/tmp/grokref.UcWhDv", used: 21_000, window: 256_000, thread: "tui:main", welcome: false }, width);
		const plain = strip(session);
		expect(plain).toContain("master /tmp/grokref.UcWhDv");
		expect(plain).toContain("21K / 256K | [tui:main]");
		expect(plain.startsWith(`${margin}master`)).toBe(true);
		fits([session], width);
	}
	expect(visibleWidth(renderHeader({ cwd: "/x", used: 5, thread: "tui:main", welcome: false }, 140))).toBe(140 - spacing.margin);
});

test("turn status: spinner, label, phase timer and right-aligned turn timer ⇣tokens [stop]; phase timer hidden under 60 columns", () => {
	const info = { run: run("responding"), tick: 0, now: 11_000, contextTokens: 21_500, runningSubagents: 0 };
	const wide = renderTurnStatus(info, 140);
	expect(wide).toHaveLength(1);
	const plain = strip(wide[0] as string);
	expect(plain.startsWith(`${statusInset}✦ Responding... 0.9s`)).toBe(true);
	expect(plain.endsWith("10s =21.5k [stop]")).toBe(true);
	expect(visibleWidth(wide[0] as string)).toBe(140 - spacing.margin);

	const narrow = strip((renderTurnStatus(info, 59)[0] ?? "") as string);
	expect(narrow).toContain("Responding...");
	expect(narrow).not.toContain("0.9s");
	fits(renderTurnStatus(info, 59), 59);

	expect(strip(renderTurnStatus({ ...info, run: run("tool", "bash") }, 140)[0] as string)).toContain("Running bash");
	expect(turnLabel(run("waiting_subagents"), 3)).toBe("Waiting for 3 subagents...");
	expect(renderTurnStatus({ ...info, run: undefined }, 140)).toEqual([]);
	expect(strip(renderTurnStatus({ ...info, tick: 16 }, 140)[0] as string)).toContain("✧");
});

test("turn status: metrics shown when present, absent when not measured", () => {
	const info = { run: run("responding"), tick: 0, now: 11_000, contextTokens: 21_500, runningSubagents: 0 };
	// With both metrics
	const withMetrics = strip(renderTurnStatus({ ...info, metrics: { tps: 48, cacheRatio: 0.92 } }, 140)[0] as string);
	expect(withMetrics).toContain("48 tok/s");
	expect(withMetrics).toContain("cache 92%");
	expect(withMetrics.endsWith("[stop]")).toBe(true);
	// With only tps
	const onlyTps = strip(renderTurnStatus({ ...info, metrics: { tps: 48 } }, 140)[0] as string);
	expect(onlyTps).toContain("48 tok/s");
	expect(onlyTps).not.toContain("cache");
	// With only cacheRatio
	const onlyCacheRatio = strip(renderTurnStatus({ ...info, metrics: { cacheRatio: 0.92 } }, 140)[0] as string);
	expect(onlyCacheRatio).not.toContain("tok/s");
	expect(onlyCacheRatio).toContain("cache 92%");
	// Without metrics
	const noMetrics = strip(renderTurnStatus(info, 140)[0] as string);
	expect(noMetrics).not.toContain("tok/s");
	expect(noMetrics).not.toContain("cache");
	expect(noMetrics.endsWith("10s =21.5k [stop]")).toBe(true);
});

test("turn status: metrics drop at narrow width while elapsed and [stop] stay", () => {
	const info = { run: run("responding"), tick: 0, now: 11_000, contextTokens: 21_500, runningSubagents: 0, metrics: { tps: 48, cacheRatio: 0.92 } };
	// Wide: metrics shown
	const wide = strip(renderTurnStatus(info, 140)[0] as string);
	expect(wide).toContain("48 tok/s");
	expect(wide).toContain("cache 92%");
	// Narrow: metrics drop but elapsed and [stop] stay
	const narrow = strip(renderTurnStatus(info, 59)[0] as string);
	expect(narrow).not.toContain("48 tok/s");
	expect(narrow).not.toContain("cache");
	expect(narrow).toContain("10s");
	expect(narrow).toContain("[stop]");
	expect(visibleWidth(renderTurnStatus(info, 59)[0] as string)).toBeLessThanOrEqual(59);
});

test("token short format follows Grok's turn row", () => {
	expect(formatTokensShort(999)).toBe("999");
	expect(formatTokensShort(1_234)).toBe("1.23k");
	expect(formatTokensShort(21_500)).toBe("21.5k");
	expect(formatTokensShort(123_456)).toBe("123k");
	expect(formatTokensShort(1_234_567)).toBe("1.23m");
});

test("footer: Key:label pairs joined by  │  inside the page margin, clipped to width", () => {
	const hints = [["Shift+Tab", "mode"], ["Ctrl+c", "cancel"], ["Ctrl+x", "shortcuts"]] as const;
	const wide = renderFooter(hints, 140);
	expect(strip(wide)).toBe(`${margin}Shift+Tab:mode  |  Ctrl+c:cancel  |  Ctrl+x:shortcuts`);
	const narrow = renderFooter([...hints, ["Ctrl+e", "expand thinking"], ["→", "expand"]], 40);
	fits([narrow], 40);
	expect(strip(narrow)).toBe(`${margin}Shift+Tab:mode  |  Ctrl+c:cancel`);
});

test("prompt box: rounded border, ❯ prefix, caption in the bottom border, placeholder only while unfocused and empty", () => {
	for (const width of WIDTHS) {
		const prompt = new PromptBox(tui(width, 40));
		prompt.caption = promptCaption("anthropic/claude-sonnet-4", "codemode");
		const blurred = prompt.render(width);
		const plain = blurred.map(strip);
		expect(plain[0]?.startsWith(`${margin}+`)).toBe(true);
		expect(plain[0]?.trimEnd().endsWith("+")).toBe(true);
		expect(plain[1]).toContain("| > Build anything");
		expect(plain.at(-1)).toContain(" anthropic/claude-sonnet-4 - codemode -+");
		expect(plain.at(-1)?.startsWith(`${margin}+`)).toBe(true);
		expect(visibleWidth(blurred[0] as string)).toBe(width);
		fits(blurred, width);

		prompt.focused = true;
		prompt.setText("한국어로 긴 문장을 입력하면 프롬프트 상자가 표시 너비 기준으로 줄바꿈되어야 하고 어떤 줄도 터미널 폭을 넘지 않아야 합니다");
		const focused = prompt.render(width);
		expect(focused.map(strip).join("\n")).not.toContain("Build anything");
		expect(focused.length).toBe(width === 60 ? 5 : 3);
		fits(focused, width);
	}
});

test("prompt box: a second render with unchanged data returns the cached array", () => {
	const prompt = new PromptBox(tui());
	prompt.caption = promptCaption("model", "mode");
	const first = prompt.render(140);
	expect(prompt.render(140)).toBe(first);
	prompt.setText("hi");
	expect(prompt.render(140)).not.toBe(first);
	expect(prompt.render(120)).not.toBe(first);
});

test("shortcuts overlay: Grok modal chrome at 140x40 (80 wide, 32 tall) with sections, keys and footer hints", () => {
	const overlay = new ShortcutsOverlay(() => {}, { size: () => ({ cols: 140, rows: 40 }) });
	expect(shortcutsOverlayLayout({ cols: 140, rows: 40 })).toEqual({ width: 80, height: 32 });
	const lines = overlay.render(140);
	const plain = lines.map(strip);
	expect(lines).toHaveLength(32);
	for (const line of lines) expect(visibleWidth(line)).toBe(80);
	expect(plain[0]).toBe("+- Keyboard Shortcuts --------------------------------------------------- [x] -+");
	expect(plain[1]).toBe(`|${" ".repeat(78)}|`);
	expect(plain[2]).toBe(`|   / to search${" ".repeat(64)}|`);
	expect(plain[3]).toBe(`|${"-".repeat(78)}|`);
	expect(plain[4]).toBe(`|  - Essentials${" ".repeat(64)}|`);
	expect(plain[5]).toBe(`|    - Send${" ".repeat(60)}Enter   |`);
	expect(plain[6]).toBe(`|    - Steer the running turn${" ".repeat(42)}Enter   |`);
	expect(plain.some((line) => line.includes("> Conversation Navigation (8)"))).toBe(true);
	expect(plain.some((line) => line.includes("> Commands (5)"))).toBe(true);
	expect(plain[30]).toContain("↑/↓ nav  |  e/Space/→ expand  |  ← collapse  |  / search  |  Esc close");
	expect(plain[31]).toBe(`+${"-".repeat(78)}+`);
	expect(lines[5]).toContain("\x1b[1m");
	expect(lines[6]).not.toContain("\x1b[1m");
});

test("shortcuts overlay: 80x30 gives a 56x22 box, wraps the footer hints, and scrolls a long list behind a █ thumb", () => {
	const overlay = new ShortcutsOverlay(() => {}, { size: () => ({ cols: 80, rows: 30 }) });
	const lines = overlay.render(80);
	const plain = lines.map(strip);
	expect(lines).toHaveLength(22);
	for (const line of lines) expect(visibleWidth(line)).toBe(56);
	expect(plain[0]).toBe("+- Keyboard Shortcuts --------------------------- [x] -+");
	expect(plain.filter((line) => line.includes("  |  ")).length).toBe(2);
	expect(plain[21]).toBe(`+${"-".repeat(54)}+`);
	fits(overlay.render(60), 60);

	const rows = Array.from({ length: 30 }, (_, index) => [`Action ${index}`, `F${index}`] as const);
	const long = new ShortcutsOverlay(() => {}, { size: () => ({ cols: 80, rows: 30 }), sections: [{ title: "Many", rows }, { title: "More", rows }] });
	const first = long.render(80).map(strip);
	expect(first.filter((line) => line.endsWith("█|")).length).toBeGreaterThan(0);
	expect(first.some((line) => line.includes("Action 0"))).toBe(true);
	expect(first.some((line) => line.includes("> More (30)"))).toBe(false);
	for (let index = 0; index < 40; index++) long.handleInput("\x1b[B");
	const scrolled = long.render(80).map(strip);
	expect(scrolled.some((line) => line.includes("> More (30)"))).toBe(true);
	expect(scrolled.some((line) => line.includes("Action 0 "))).toBe(false);
	for (const line of long.render(80)) expect(visibleWidth(line)).toBe(56);
});

test("shortcuts overlay: cached until input changes the selection, Right expands a folded section, Esc closes", () => {
	let closed = 0;
	const overlay = new ShortcutsOverlay(() => closed++, { size: () => ({ cols: 140, rows: 40 }) });
	const first = overlay.render(140);
	expect(overlay.render(140)).toBe(first);
	overlay.handleInput("\x1b[B");
	const moved = overlay.render(140);
	expect(moved).not.toBe(first);
	expect(overlay.selection).toBe(2);
	for (let index = 0; index < 20; index++) overlay.handleInput("\x1b[B");
	expect(overlay.selection).toBe(12);
	overlay.handleInput("\x1b[C");
	expect(overlay.render(140).map(strip).some((line) => line.includes("- Commands") && !line.includes("(5)"))).toBe(true);
	expect(overlay.render(140).map(strip).some((line) => line.includes("/thread <name>"))).toBe(true);
	overlay.handleInput("\x1b[D");
	expect(overlay.render(140).map(strip).some((line) => line.includes("> Commands (5)"))).toBe(true);
	overlay.handleInput("/");
	overlay.handleInput("todo");
	const searched = overlay.render(140).map(strip);
	expect(searched[2]).toContain(" search: todo");
	expect(searched.some((line) => line.includes("- Todo / plan pane"))).toBe(true);
	expect(searched.some((line) => line.includes("Send"))).toBe(false);
	overlay.handleInput("\x1b");
	expect(overlay.render(140).map(strip)[2]).toContain("/ to search");
	overlay.handleInput("\x1b");
	expect(closed).toBe(1);
	overlay.handleInput("\x18");
	expect(closed).toBe(2);
});

test("shortcuts overlay without a size renders a content-sized box at the given width", () => {
	const overlay = new ShortcutsOverlay(() => {});
	for (const width of WIDTHS) {
		const lines = overlay.render(width);
		for (const line of lines) expect(visibleWidth(line)).toBe(width);
		expect(lines.length).toBeLessThan(25);
		expect(strip(lines[0] as string)).toContain("Keyboard Shortcuts");
	}
});
