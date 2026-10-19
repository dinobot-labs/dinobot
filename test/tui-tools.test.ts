import { expect, test } from "bun:test";
import type { RenderContext } from "../src/tui/screen.ts";
import type { ToolBlock } from "../src/tui/state.ts";

process.env.COLORTERM = "truecolor";
process.env.TERM = "xterm-256color";
const { getTerminalColorMode, stripTerminalSequences, visibleWidth } = await import("@earendil-works/pi-tui");
const { groupLabel, isGroupable } = await import("../src/tui/blocks/subagents.ts");
const { bulletStyle, highlightCommandLines, renderTool, toolColors, toolKind, toolSummary, verbFor } = await import("../src/tui/blocks/tools.ts");
const { ansi, bold, brailleSpinner, color, glyph, spinnerFrame } = await import("../src/tui/theme.ts");

const WIDE = 136;
let ids = 0;
function tool(name: string, args: Record<string, unknown>, status: ToolBlock["status"] = "done", result?: string): ToolBlock {
	return { kind: "tool", id: `tool-${++ids}`, version: 1, callId: `call-${ids}`, name, args: args as ToolBlock["args"], status, output: "", ...(result === undefined ? {} : { result }) };
}
const ctx = (over: Partial<RenderContext> = {}): RenderContext => ({ expanded: false, selected: false, tick: 0, now: 0, running: false, ...over });
const plain = (line: string): string => stripTerminalSequences(line).replace(/\s+$/, "");
const widths = (lines: readonly string[]): number[] => lines.map((line) => visibleWidth(line));

const run = () => tool("bash", { command: 'ls -la && echo "---" && seq 1 30', description: "List directory and print 1 to 30" }, "done", ["total 1648", "drwx------   3 roach roach    480 Oct  3 13:57 .", ...Array.from({ length: 30 }, (_, i) => String(i + 1))].join("\n"));
const readGreet = () => tool("read", { path: "greet.ts" }, "done", "export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n");
const search = () =>
	tool("grep", { pattern: "return" }, "done", ["calc.py:2:    return a + b", "calc.py:5:    return a * b", "greet.ts:2:  return `Hello`;", ...Array.from({ length: 6 }, (_, i) => `file${i}.ts:${i + 1}:return`)].join("\n"));

test("tool names map onto Grok kinds and verb-group nouns", () => {
	expect(toolKind("bash")).toBe("execute");
	expect(toolKind("codemode")).toBe("execute");
	expect(toolKind("read_file")).toBe("read");
	expect(toolKind("glob")).toBe("search");
	expect(toolKind("ls")).toBe("list");
	expect(toolKind("sample_lookup")).toBe("other");
	expect(verbFor("read")).toMatchObject({ past: "Read", present: "Reading", noun: "file", plural: "files", groupable: true });
	expect(verbFor("grep")).toMatchObject({ past: "Searched", present: "Searching", noun: "pattern", plural: "patterns", groupable: true });
	expect(verbFor("ls")).toMatchObject({ past: "Listed", present: "Listing", noun: "dir", plural: "dirs", groupable: true });
	expect(verbFor("web_fetch")).toMatchObject({ past: "Fetched", present: "Fetching", noun: "website", plural: "websites", groupable: true });
	expect(verbFor("bash")).toMatchObject({ past: "Ran", present: "Running", noun: "command", plural: "commands", groupable: false, rail: true });
	expect(verbFor("slack_search")).toMatchObject({ past: "Ran", present: "Running", noun: "tool", plural: "tools", groupable: false });
});

test("group labels built by subagents.ts keep working on the new verb table", () => {
	expect(isGroupable(run())).toBe(false);
	expect(isGroupable(readGreet())).toBe(true);
	expect(groupLabel([readGreet(), tool("read", { path: "calc.py" }), search()])).toMatchObject({ text: "Read 2 files, Searched 1 pattern", running: false });
	expect(groupLabel([tool("read", { path: "calc.py" }, "running")])).toMatchObject({ text: "Reading 1 file", running: true });
	expect(groupLabel([tool("ls", { path: "src" }), tool("web_fetch", { url: "https://x.ai" }, "running")])).toMatchObject({ text: "Listing 1 dir, Fetching 1 website", running: true });
	expect(groupLabel([tool("ls", { path: "src" }), tool("web_fetch", { url: "https://x.ai" })])).toMatchObject({ text: "Listed 1 dir, Fetched 1 website", running: false });
});

test("collapsed rows show tool identity and readable status beside muted summaries", () => {
	expect(getTerminalColorMode()).toBe("truecolor");
	const line = renderTool(run(), WIDE, ctx())[0] ?? "";
	expect(plain(line)).toBe("   ✓ done  $ Run List directory and print 1 to 30");
	expect(line).toContain(color.accentSuccess("$"));
	expect(toolColors.successDim).toBe(color.accentSuccess);
	expect(line).toContain(bold(color.gray("Run ")));
	expect(line).toContain(color.gray("List directory and print 1 to 30"));
	expect(plain(renderTool(readGreet(), WIDE, ctx())[0] ?? "")).toBe("   ✓ done  ≡ Read greet.ts");
	expect(renderTool(readGreet(), WIDE, ctx())[0]).toContain(color.gray("greet.ts"));
	const searchLine = renderTool(search(), WIDE, ctx())[0] ?? "";
	expect(plain(searchLine)).toBe('   ✓ done  ? Search "return" (9 matches in 8 files)');
	expect(searchLine).toContain(color.grayDim(" (9 matches in 8 files)"));
	expect(plain(renderTool(tool("sample_lookup", { query: "deploy", limit: 5 }), WIDE, ctx())[0] ?? "")).toBe("   ✓ done  ◇ sample_lookup  query=deploy limit=5");
	expect(plain(renderTool(tool("codemode", { code: "const a = 1;\nreturn a;" }), WIDE, ctx())[0] ?? "")).toBe("   ✓ done  ◇ Tools · no recorded calls");
	expect(toolSummary(run())).toBe("List directory and print 1 to 30");
	expect(toolSummary(tool("sample_lookup", { query: "deploy" }))).toBe("query=deploy");
	const selectedScript = renderTool(tool("codemode", { code: "return 1;" }), WIDE, ctx({ selected: true }))[0] ?? "";
	expect(plain(selectedScript)).toBe("   ✓ done  ◇ Tools · no recorded calls");
	expect(selectedScript).not.toContain("return 1");
});

test("a selected collapsed row swaps the bullet for › and shows full colors", () => {
	const line = renderTool(readGreet(), WIDE, ctx({ selected: true }))[0] ?? "";
	expect(plain(line)).toBe("   ✓ done  > Read greet.ts");
	expect(line).toContain(bold(color.textPrimary("Read ")));
	expect(line).toContain(color.path("greet.ts"));
});

test("status colors are semantic and remain full contrast in both fold modes", () => {
	const running = tool("bash", { command: "bun test" }, "running");
	expect(bulletStyle(running, ctx({ tick: 0 }))).toBe(toolColors.runningDim);
	expect(bulletStyle(running, ctx({ tick: 4 }))).toBe(toolColors.runningLow);
	expect(bulletStyle(running, ctx({ tick: 0, expanded: true }))).toBe(color.accentRunning);
	const failed = tool("bash", { command: "cat missing.txt" }, "error", "cat: missing.txt: No such file or directory");
	expect(bulletStyle(failed, ctx())).toBe(toolColors.errorDim);
	expect(bulletStyle(failed, ctx({ expanded: true }))).toBe(color.accentError);
	expect(bulletStyle(readGreet(), ctx())).toBe(color.accentSuccess);
	expect(bulletStyle(readGreet(), ctx({ expanded: true }))).toBe(color.accentSuccess);
	expect(bulletStyle(tool("sample_lookup", {}), ctx({ expanded: true }))).toBe(color.accentSuccess);
	const lines = renderTool(failed, WIDE, ctx({ expanded: true }));
	expect(lines.map(plain)).toEqual(["|  ! failed  $ Run cat missing.txt", "|", "|  cat: missing.txt: No such file or directory"]);
	expect(lines[0]?.startsWith(color.accentError(glyph.accentBar))).toBe(true);
	expect(lines[2]).toContain(color.accentError("cat: missing.txt: No such file or directory"));
});

test("an expanded Run draws the rail, the highlighted $ command and the output panel", () => {
	const lines = renderTool(run(), WIDE, ctx({ expanded: true }));
	expect(lines.slice(0, 4).map(plain)).toEqual(["|  ✓ done  $ Run List directory and print 1 to 30", '|  $ ls -la && echo "---" && seq 1 30', "|", "|  total 1648"]);
	expect(lines).toHaveLength(3 + 32);
	expect(lines[0]?.startsWith(color.accentSuccess(glyph.accentBar))).toBe(true);
	expect(lines[0]).toContain(color.accentSuccess("$"));
	expect(lines[0]).toContain(bold(color.textPrimary("Run ")));
	expect(lines[1]).toContain(color.grayDim("$"));
	expect(lines[1]).toContain(color.accentUser("ls"));
	expect(lines[1]).toContain(`${toolColors.punctuation("-")}${color.warning("la")}`);
	expect(lines[1]).toContain(color.accentAssistant("&&"));
	expect(lines[1]).toContain(toolColors.builtin("echo"));
	expect(lines[1]).toContain(color.accentSuccess("---"));
	expect(lines[3]).toContain(ansi.bg("bgHighlight"));
	expect(visibleWidth(lines[3] ?? "")).toBe(3 + (WIDE - 3 - 2));
	expect(Math.max(...widths(lines))).toBeLessThanOrEqual(WIDE);
});

test("a running Run keeps a 2 + … + 3 preview of streaming output; a scripted codemode call is the title", () => {
	const running = tool("bash", { command: "bun test" }, "running");
	running.output = Array.from({ length: 12 }, (_, i) => `test ${i + 1} passed`).join("\n");
	const lines = renderTool(running, WIDE, ctx({ expanded: true })).map(plain);
	expect(lines).toEqual([`|  ${spinnerFrame(brailleSpinner, 0)} running  $ Run bun test`, "|", "|  test 1 passed", "|  test 2 passed", "|  ... +7 lines", "|  test 10 passed", "|  test 11 passed", "|  test 12 passed"]);
	const script = tool("codemode", { code: "const now = await tools.sample_lookup({});\nreturn now.timeZone;" }, "done", '"Asia/Seoul"');
	expect(renderTool(script, WIDE, ctx({ expanded: true })).map(plain)).toEqual(["|  ✓ done  {} Run const now = await tools.sample_lookup({});", "|                 return now.timeZone;", "|", '|  "Asia/Seoul"']);
});

test("an expanded Read numbers the file on a panel and keeps 5 + … + 3 lines of long files", () => {
	const lines = renderTool(readGreet(), WIDE, ctx({ expanded: true }));
	expect(lines.map(plain)).toEqual(["   ✓ done  ≡ Read greet.ts", "", "   1  export function greet(name: string): string {", "   2    return `Hello, ${name}!`;", "   3  }"]);
	expect(lines[0]).toContain(color.accentSuccess("≡"));
	expect(lines[0]).toContain(color.path("greet.ts"));
	expect(lines[2]).toContain(color.grayDim("1"));
	expect(lines[2]).toContain(ansi.bg("bgHighlight"));
	const long = tool("read", { path: "long.txt", offset: 10, limit: 12 }, "done", Array.from({ length: 12 }, (_, i) => `line ${i + 10}`).join("\n"));
	const longLines = renderTool(long, WIDE, ctx({ expanded: true })).map(plain);
	expect(longLines[0]).toBe("   ✓ done  ≡ Read long.txt (10-21)");
	expect(longLines.slice(2)).toEqual(["   10  line 10", "   11  line 11", "   12  line 12", "   13  line 13", "   14  line 14", "   ...", "   19  line 19", "   20  line 20", "   21  line 21"]);
});

test("an expanded Search lists the mode line and per-file hits; other tools show muted output", () => {
	const lines = renderTool(search(), WIDE, ctx({ expanded: true })).map(plain);
	expect(lines.slice(0, 7)).toEqual(['   ✓ done  ? Search "return" (9 matches in 8 files)', "", "     mode: pattern", "", "     calc.py", "          2      return a + b", "          5      return a * b"]);
	expect(lines[7]).toBe("");
	expect(lines[8]).toBe("     greet.ts");
	const other = renderTool(tool("sample_lookup", {}, "done", '{"iso":"2026-10-03T06:12:00.000Z"}'), WIDE, ctx({ expanded: true }));
	expect(other.map(plain)).toEqual(["|  ✓ done  ◇ sample_lookup", "|", '|  {"iso":"2026-10-03T06:12:00.000Z"}']);
	expect(other[0]?.startsWith(color.accentSuccess(glyph.accentBar))).toBe(true);
	expect(other[2]).toContain(color.gray('{"iso":"2026-10-03T06:12:00.000Z"}'));
});

test("Korean text wraps by display width at 60 columns and collapsed headers truncate with …", () => {
	const korean = tool("bash", { command: "echo 안녕", description: "한글 설명이 아주 길어서 줄바꿈이 필요한 경우를 확인하는 명령입니다. 터미널 폭을 넘기면 표시 폭 기준으로 잘라야 합니다" }, "done", "한글 출력도 표시 폭 기준으로 줄바꿈되어야 하며 패널 오른쪽 경계를 넘지 않아야 합니다. ".repeat(3));
	const expanded = renderTool(korean, 60, ctx({ expanded: true }));
	expect(expanded.length).toBeGreaterThan(6);
	for (const line of expanded) expect(visibleWidth(line)).toBeLessThanOrEqual(60);
	expect(plain(expanded[0] ?? "")).toBe("|  ✓ done  $ Run 한글 설명이 아주 길어서 줄바꿈이 필요한");
	expect(plain(expanded[1] ?? "")).toContain("경우를 확인하는");
	const collapsed = renderTool(korean, 60, ctx())[0] ?? "";
	expect(visibleWidth(collapsed)).toBeLessThanOrEqual(60);
	expect(plain(collapsed)).toContain(glyph.ellipsis);
	expect(plain(collapsed).startsWith("   ✓ done  $ Run 한글 설명이")).toBe(true);
	const wideCollapsed = renderTool(korean, WIDE, ctx())[0] ?? "";
	expect(visibleWidth(wideCollapsed)).toBeLessThanOrEqual(WIDE);
	for (const line of renderTool(search(), 60, ctx({ expanded: true }))) expect(visibleWidth(line)).toBeLessThanOrEqual(60);
	for (const line of renderTool(run(), 60, ctx({ expanded: true }))) expect(visibleWidth(line)).toBeLessThanOrEqual(60);
});

test("highlightCommandLines carries the command position across wrapped lines", () => {
	const [first, second] = highlightCommandLines(["ls -la &&", "echo done"]);
	expect(first).toContain(color.accentUser("ls"));
	expect(second).toContain(toolColors.builtin("echo"));
	expect(second).toContain(color.textPrimary("done"));
});

test("renderTool returns the cached array until the block, width, fold, selection or pulse changes", () => {
	const block = run();
	const first = renderTool(block, WIDE, ctx());
	expect(renderTool(block, WIDE, ctx())).toBe(first);
	expect(renderTool(block, WIDE, ctx({ tick: 4, now: 99 }))).toBe(first);
	expect(renderTool(block, 60, ctx())).not.toBe(first);
	const expanded = renderTool(block, WIDE, ctx({ expanded: true }));
	expect(expanded).not.toBe(first);
	expect(renderTool(block, WIDE, ctx({ expanded: true }))).toBe(expanded);
	expect(renderTool(block, WIDE, ctx({ selected: true }))).not.toBe(expanded);
	block.version++;
	const bumped = renderTool(block, WIDE, ctx());
	expect(bumped).not.toBe(first);
	expect(bumped).toEqual(first);
	const running = tool("bash", { command: "bun test" }, "running");
	const phaseA = renderTool(running, WIDE, ctx({ tick: 0 }));
	expect(renderTool(running, WIDE, ctx({ tick: 3 }))).toBe(phaseA);
	expect(renderTool(running, WIDE, ctx({ tick: 4 }))).not.toBe(phaseA);
	expect(renderTool(running, WIDE, ctx({ tick: 8 }))).toBe(renderTool(running, WIDE, ctx({ tick: 8 })));
});

test("codemode receipts preserve independent outcomes, errors, and bounded history", () => {
	const script = tool("codemode", { code: "await Promise.all([tools.read({}), tools.bash({})]);" }, "error", "Partial effects may have completed");
	script.details = { codemodeCalls: [
		{ id: 12, name: "read", status: "done" },
		{ id: 13, name: "bash", status: "failed", error: "exit 1" },
		{ id: 14, name: "web_fetch", status: "aborted" },
		{ id: 15, name: "lsp", status: "running" },
		{ id: 16, name: "future", status: "new-status" },
	] };
	const lines = renderTool(script, 80, ctx({ expanded: true }));
	const text = lines.map(plain).join("\n");
	expect(text).toContain("5 calls · 1 done, 1 failed, 1 cancelled, 1 running, 1 unknown");
	expect(text).toContain("✓ done  #12 ≡ read");
	expect(text).toContain("! failed  #13 $ bash");
	expect(text).toContain("– cancelled  #14 ↗ web_fetch");
	expect(text).toContain("○ unknown  #16 ◇ future");
	expect(lines.join("\n")).toContain(color.accentSuccess("✓ done"));
	expect(lines.join("\n")).toContain(color.warning("– cancelled"));
	expect(lines.join("\n")).toContain(color.accentError("exit 1"));
	expect(text).toContain("Partial effects may have completed");
	expect(lines[0]).toContain(color.accentError("! failed"));
	const many = tool("codemode", { code: "return 1" });
	many.details = { codemodeCalls: Array.from({ length: 20 }, (_, i) => ({ id: i, name: "read", status: "done" })) };
	const bounded = renderTool(many, 80, ctx({ expanded: true })).map(plain).join("\n");
	expect(bounded).toContain("20 calls · 20 done");
	expect(bounded).toContain("4 earlier calls retained in receipt");
	expect(bounded).not.toContain("#0 ≡ read");
	expect(bounded).toContain("#19 ≡ read");
});

test("elapsed time invalidates running caches once per displayed second and freezes on completion", () => {
	const running = tool("read", { path: "large.txt" }, "running");
	running.startedAt = 1_000;
	const first = renderTool(running, 80, ctx({ now: 2_010 }));
	expect(first.map(plain).join("\n")).toContain("running 1s");
	expect(renderTool(running, 80, ctx({ now: 2_999 }))).toBe(first);
	expect(renderTool(running, 80, ctx({ now: 3_000 }))).not.toBe(first);
	running.status = "done";
	running.endedAt = 3_500;
	running.version++;
	const done = renderTool(running, 80, ctx({ now: 4_000 }));
	expect(done.map(plain).join("\n")).toContain("✓ done 2s");
	expect(renderTool(running, 80, ctx({ tick: 50, now: 99_000 }))).toBe(done);
});

test("tool rows fit tiny and Korean widths, keeping full status visible at practical widths", () => {
	const script = tool("codemode", { code: "const 한글 = await tools.read({path: '매우 긴 파일 이름.txt'});" }, "running");
	script.details = { codemodeCalls: [{ name: "read", status: "failed", error: "긴 오류 문장 ".repeat(10) }] };
	for (const width of [0, 1, 5, 12, 20, 40, 60]) {
		for (const expanded of [false, true]) {
			for (const line of renderTool(script, width, ctx({ expanded }))) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	}
	expect(renderTool(script, 40, ctx()).map(plain).join("\n")).toContain("failed");
});

test("cancelled scripts use a distinct terminal badge without a running spinner", () => {
	const script = tool("codemode", { code: "await tools.bash({command: 'sleep 100'});" }, "cancelled");
	const lines = renderTool(script, 80, ctx({ expanded: true }));
	expect(lines[0]).toContain(color.warning("– cancelled"));
	expect(renderTool(script, 80, ctx({ expanded: true, tick: 50, now: 99_000 }))).toBe(lines);
});

test("terminal scripts freeze unfinished receipt statuses as last observed rather than inventing outcomes", () => {
	const script = tool("codemode", { code: "await tools.read({});" }, "cancelled");
	script.details = { codemodeCalls: [{ name: "read", status: "running" }] };
	const lines = renderTool(script, 80, ctx({ expanded: true }));
	expect(lines.map(plain).join("\n")).toContain("○ last seen running  ≡ read");
	expect(renderTool(script, 80, ctx({ expanded: true, tick: 80, now: 99_000 }))).toBe(lines);
});

test("two layout sizes are cached without retaining output across a version change", () => {
	const block = readGreet();
	const wide = renderTool(block, 140, ctx({ expanded: true }));
	const narrow = renderTool(block, 60, ctx({ expanded: true }));
	expect(renderTool(block, 140, ctx({ expanded: true }))).toBe(wide);
	expect(renderTool(block, 60, ctx({ expanded: true }))).toBe(narrow);
	block.result = "changed output";
	block.version++;
	const changed = renderTool(block, 140, ctx({ expanded: true }));
	expect(changed).not.toBe(wide);
	expect(changed.map(plain).join("\n")).toContain("changed output");
});

test("compact codemode shows executed tools and their states, never script source or payloads", () => {
	const script = tool("codemode", { code: "const secretSource = await tools.read({path: 'private.ts'});", description: "implementation detail" }, "running", '{"rawPayload":"do not show"}');
	script.details = { codemodeCalls: [
		{ id: 12, name: "read", status: "done" },
		{ id: 13, name: "bash", status: "running" },
		{ id: 14, name: "web_fetch", status: "pending" },
	] };
	const lines = renderTool(script, 80, ctx());
	expect(lines.map(plain)).toEqual([
		"   ✓ done  ≡ read", `   ${spinnerFrame(brailleSpinner, 0)} running  $ bash`, "   ○ waiting  ↗ web_fetch",
	]);
	expect(lines[0]).toContain(color.accentSuccess("✓ done"));
	expect(lines[1]).toContain(color.accentRunning(`${spinnerFrame(brailleSpinner, 0)} running`));
	expect(lines[1]).toContain(bold(color.accentRunning("bash")));
	const compact = lines.map(plain).join("\n");
	for (const hidden of ["secretSource", "private.ts", "rawPayload", "implementation detail", "#12"]) expect(compact).not.toContain(hidden);
	const expanded = renderTool(script, 80, ctx({ expanded: true })).map(plain).join("\n");
	expect(expanded).toContain("secretSource");
	expect(expanded).toContain("rawPayload");
});

test("compact codemode does not hide a script failure after successful tools", () => {
	const script = tool("codemode", { code: "await tools.read({}); throw Error('private detail');" }, "error", "private detail");
	script.details = { codemodeCalls: [{ name: "read", status: "done" }] };
	expect(renderTool(script, 80, ctx()).map(plain)).toEqual(["   ✓ done  ≡ read", "   ! Script failed  Ctrl+O details"]);
	script.status = "cancelled";
	script.version++;
	expect(renderTool(script, 80, ctx()).map(plain)).toEqual(["   ✓ done  ≡ read", "   – Script cancelled  Ctrl+O details"]);
});

test("compact codemode updates live receipts and keeps every executed tool visible", () => {
	const script = tool("codemode", { code: "source hidden" }, "running");
	const initial = renderTool(script, 80, ctx());
	expect(initial.map(plain).join("\n")).toContain("Tools · no calls yet");
	expect(initial.map(plain).join("\n")).toContain("running");
	script.details = { codemodeCalls: Array.from({ length: 20 }, (_, index) => ({ name: `tool_${index}`, status: index === 19 ? "running" : "done" })) };
	script.version++;
	const live = renderTool(script, 80, ctx());
	expect(live).not.toBe(initial);
	expect(live).toHaveLength(20);
	expect(plain(live[0] ?? "")).toContain("✓ done  ◇ tool_0");
	expect(plain(live[19] ?? "")).toContain("tool_19");
	expect(plain(live[19] ?? "")).toContain("running");
});

test("compact terminal script displays unfinished receipts as last seen without animation", () => {
	const script = tool("codemode", { code: "hidden" }, "cancelled");
	script.details = { codemodeCalls: [{ name: "read", status: "running" }] };
	const lines = renderTool(script, 80, ctx());
	expect(lines.map(plain)).toEqual(["   ○ last seen running  ≡ read", "   – Script cancelled  Ctrl+O details"]);
	expect(renderTool(script, 80, ctx({ tick: 70 }))).toBe(lines);
});

test("compact running calls rotate, while repeated same-name calls retain their own states", () => {
	const script = tool("codemode", { code: "hidden" }, "running");
	script.details = { codemodeCalls: [{ id: 1, name: "read", status: "done" }, { id: 2, name: "read", status: "running" }] };
	const first = renderTool(script, 80, ctx());
	let tick = 1;
	while (tick < 100 && spinnerFrame(brailleSpinner, tick) === spinnerFrame(brailleSpinner, 0)) tick++;
	const rotated = renderTool(script, 80, ctx({ tick }));
	expect(rotated).toHaveLength(2);
	expect(rotated).not.toBe(first);
	expect(plain(rotated[0] ?? "")).toBe("   ✓ done  ≡ read");
	expect(plain(rotated[1] ?? "")).toContain(`${spinnerFrame(brailleSpinner, tick)} running`);
	expect(plain(rotated[1] ?? "")).not.toBe(plain(first[1] ?? ""));
});

test("icon kinds name what a call does, separately from its verb group", async () => {
	const { iconKind, toolIcon } = await import("../src/tui/blocks/tools.ts");
	const cases: Record<string, string> = {
		bash: "shell", codemode: "codemode", read: "read", grep: "search", ls: "list", edit: "edit", write: "write",
		web_fetch: "web_fetch", web_search: "web_search", todo_write: "todo", work_plan: "todo", task: "subagent",
		skills_load: "skill", memory_search: "memory", lsp: "lsp", session_read: "session", github_pr_diff: "github", slack_search: "other",
	};
	for (const [name, kind] of Object.entries(cases)) expect(`${name}:${iconKind(name)}`).toBe(`${name}:${kind}`);
	expect(toolKind("todo_write")).toBe("other");
	expect(toolIcon("bash")).toBe("$");
});

test("every icon in every set is one terminal glyph so tool rows keep their columns", async () => {
	const { iconSets } = await import("../src/tui/theme.ts");
	for (const [name, set] of Object.entries(iconSets)) {
		const tools = Object.entries(set.tools).filter(([kind]) => !(name === "unicode" && kind === "codemode"));
		for (const [kind, glyphText] of [...tools, ...Object.entries(set.status)]) expect(`${name}.${kind}:${visibleWidth(glyphText)}`).toBe(`${name}.${kind}:1`);
		// Terminal states differ by mark, not only by color.
		expect(new Set([set.status.pending, set.status.done, set.status.failed, set.status.cancelled]).size).toBe(4);
	}
	for (const glyphText of [...Object.values(iconSets.nerd.tools), iconSets.nerd.thinking]) expect(glyphText.codePointAt(0)! >= 0xe000 && glyphText.codePointAt(0)! <= 0xf8ff).toBe(true);
	for (const [name, set] of Object.entries(iconSets)) expect(`${name}.thinking:${visibleWidth(set.thinking)}`).toBe(`${name}.thinking:1`);
});

test("the nerd set swaps glyphs but keeps status words, colors and layout", async () => {
	const { setIconSet, iconSets } = await import("../src/tui/theme.ts");
	setIconSet("nerd");
	try {
		const nerd = iconSets.nerd;
		expect(plain(renderTool(tool("bash", { command: "pwd" }), WIDE, ctx())[0] ?? "")).toBe(`   ${nerd.status.done} done  ${nerd.tools.shell} Run pwd`);
		expect(plain(renderTool(tool("todo_write", { todos: [] }, "error"), WIDE, ctx())[0] ?? "")).toStartWith(`   ${nerd.status.failed} failed  ${nerd.tools.todo} todo_write`);
		expect(plain(renderTool(tool("github_pr_diff", {}, "pending"), WIDE, ctx())[0] ?? "")).toStartWith(`   ${nerd.status.pending} waiting  ${nerd.tools.github} github_pr_diff`);
		const running = renderTool(tool("task", { description: "map the repo" }, "running"), WIDE, ctx())[0] ?? "";
		expect(plain(running)).toStartWith(`   ${spinnerFrame(brailleSpinner, 0)} running  ${nerd.tools.subagent} task`);
		expect(running).toContain(ansi.fg("orange"));
	} finally {
		setIconSet("unicode");
	}
});
