import { expect, test } from "bun:test";
import type { AssistantMessage, ToolResultMessage, Usage, UserMessage } from "@earendil-works/pi-ai";
import type { ConversationId, EntryId, EntryRecord } from "@earendil-works/pi-durable";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderLayoutFrame } from "../node_modules/@earendil-works/pi-tui/dist/layout.js";
import type { SubagentProgress, WorkflowStatus } from "../src/core/ui-contract.ts";
import { activityLabel, subagentCounts, createTakeoverView, groupLabel, isGroupable, renderGroupHeader, renderRoster, renderSubagentRow, ROSTER_MAX_ROWS, takeoverTitle } from "../src/tui/blocks/subagents.ts";
import { defaultRenderers, type RenderContext, Transcript } from "../src/tui/screen.ts";
import { ChatState, type SubagentBlock, type ToolBlock } from "../src/tui/state.ts";
import { bold, color, dim, dotSpinner, glyph, spacing, spinnerFrame } from "../src/tui/theme.ts";

const NOW = 1_700_000_100_000;
const WIDTHS = [140, 60] as const;
const KOREAN = "서브에이전트 설명이 아주 길어서 좁은 화면에서는 반드시 잘려야 하는 한국어 텍스트입니다";
let ids = 0;

const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m|\x1b\][^\x07]*\x07/g, "");

function progress(taskId: string, status: SubagentProgress["status"], extra: Partial<SubagentProgress> = {}): SubagentProgress {
	return { taskId, description: `Explore ${taskId} summary`, subagentType: "explore", background: false, conversationId: 7, status, startedAt: NOW - 12_000, toolCount: 0, ...extra };
}

function subagent(status: SubagentProgress["status"], extra: Partial<SubagentProgress> = {}): SubagentBlock {
	const id = `subagent-${++ids}`;
	return { kind: "subagent", id, version: 1, callId: `call-${ids}`, progress: progress(id, status, extra) };
}

function tool(name: string, status: ToolBlock["status"]): ToolBlock {
	return { kind: "tool", id: `tool-${++ids}`, version: 1, callId: `call-${ids}`, name, args: {}, status, output: "" };
}

const ctx = (extra: Partial<RenderContext> = {}): RenderContext => ({ expanded: false, selected: false, tick: 0, now: NOW, running: true, ...extra });

test("group header folds running subagents into a pulsing ◈ Running N subagents at 140 and 60 columns", () => {
	const members = [subagent("running"), subagent("running"), subagent("running")];
	for (const width of WIDTHS) {
		const [line] = renderGroupHeader(members, width, ctx());
		expect(strip(line ?? "")).toBe("   + Running 3 subagents");
		expect(line).toContain(color.accentTool(glyph.groupBullet));
		expect(line).toContain(bold(color.grayBright("Running 3 subagents")));
		expect(visibleWidth(line ?? "")).toBeLessThanOrEqual(width);
	}
	expect(renderGroupHeader(members, 140, ctx({ tick: 4 }))[0]).toContain(dim(color.accentTool(glyph.groupBullet)));
});

test("finished subagents fold into a gray ◈ Ran N subagents and a partial run names the running and completed counts", () => {
	const done = [subagent("completed", { endedAt: NOW }), subagent("completed", { endedAt: NOW }), subagent("cancelled", { endedAt: NOW })];
	const [ran] = renderGroupHeader(done, 140, ctx({ running: false }));
	expect(strip(ran ?? "")).toBe("   + Ran 3 subagents");
	expect(ran).toContain(color.gray(glyph.groupBullet));
	expect(groupLabel([subagent("running"), subagent("running"), subagent("completed", { endedAt: NOW })])).toEqual({ text: "Running 2 subagents, 1 completed", running: true, failed: 0 });
});

test("a failed subagent turns the ◈ red and appends the red failed suffix", () => {
	const members = [subagent("failed", { endedAt: NOW, error: "boom" }), subagent("completed", { endedAt: NOW })];
	expect(groupLabel(members)).toEqual({ text: "Ran 2 subagents", running: false, failed: 1 });
	const [line] = renderGroupHeader(members, 140, ctx({ running: false }));
	expect(strip(line ?? "")).toBe("   + Ran 2 subagents - 1 failed");
	expect(line).toContain(color.accentError(glyph.groupBullet));
	expect(line).toContain(color.accentError(" - 1 failed"));
});

test("tool buckets keep first-seen order and take the group-wide tense while a subagent member runs", () => {
	const members = [tool("read", "done"), subagent("running"), tool("grep", "done"), tool("read", "done")];
	expect(groupLabel(members).text).toBe("Reading 2 files, Running 1 subagent, Searching 1 pattern");
	const selected = renderGroupHeader(members, 140, ctx({ selected: true }))[0] ?? "";
	expect(strip(selected)).toBe("   > Reading 2 files, Running 1 subagent, Searching 1 pattern");
});

test("subagent states are readable on the left, fit widths, and stay independently selectable", () => {
	for (const status of ["running", "completed", "failed", "cancelled"] as const) {
		const block = subagent(status, { description: KOREAN, ...(status === "running" ? {} : { endedAt: NOW }) });
		expect(isGroupable(block)).toBe(false);
		for (const width of [40, 60, 80, 140]) {
			for (const expanded of [false, true]) {
				const lines = renderSubagentRow(block, width, ctx({ expanded }));
				expect(strip(lines[0]!)).toMatch(new RegExp(`^   . ${status === "completed" ? "done" : status}  Subagent`));
				for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
		if (status !== "running") expect(renderSubagentRow(block, 80, ctx({ now: NOW + 99999, tick: 100 }))).toEqual(renderSubagentRow(block, 80, ctx()));
	}
	expect(renderSubagentRow(subagent("cancelled", { endedAt: NOW }), 80, ctx())[0]).toContain(color.warning("– cancelled"));
});

test("expanded detail preserves the full assignment, current activity, latest text, error and entry hint", () => {
	const block = subagent("running", { description: KOREAN, currentTool: "bash", lastText: "Inspecting state transitions", toolCount: 12, tokens: 340 });
	const lines = renderSubagentRow(block, 60, ctx({ expanded: true })).map(strip).join("\n");
	expect(lines).toContain("Running: bash");
	expect(lines).toContain("Latest: Inspecting state transitions");
	expect(lines).toContain("12 tools");
	expect(lines).toContain("340 output tokens");
	expect(lines).toContain("Enter: conversation & result");
	expect(lines.replace(/\s/g, "")).toContain(KOREAN.replace(/\s/g, ""));
	const failure = renderSubagentRow(subagent("failed", { endedAt: NOW, error: "Permission denied" }), 80, ctx({ expanded: true })).map(strip).join("\n");
	expect(failure).toContain("Error: Permission denied");
	expect(activityLabel(progress("a", "running", { currentTool: "read", lastText: "ignored" }))).toBe("Running: read");
	expect(activityLabel(progress("a", "running"))).toBe("Waiting for response...");
	expect(activityLabel(progress("a", "completed", { currentTool: "read" }))).toBe("");
});

const workflow = (status: WorkflowStatus["status"], blockers: string[] = []): WorkflowStatus => ({
	status, workId: "work-1", sourceIds: ["source-1"], version: 1, methodEpoch: 0, mutationEpoch: 0,
	blockers, unmetCheckIds: status === "verified" ? [] : ["test"], certificate: null, costs: null, methods: {}, evidence: [], limitations: [],
});

test("coding children: runner badge, then the static workflow state unless it repeats; details and history reuse the grammar", () => {
	const running = subagent("running", { workflow: workflow("implementing") });
	const blocked = subagent("completed", { endedAt: NOW, workflow: workflow("blocked", ["checks missing"]) });
	const verified = subagent("completed", { endedAt: NOW, workflow: workflow("verified") });
	const cancelled = subagent("cancelled", { endedAt: NOW, workflow: workflow("cancelled") });
	for (const tick of [0, 4]) {
		const [row = ""] = renderSubagentRow(running, 100, ctx({ tick }));
		expect(strip(row)).toMatch(/^   . running · ○ implementing  Subagent /);
		expect(row).toContain(color.accentRunning("○ implementing"));
	}
	const [row = "", ...details] = renderSubagentRow(blocked, 100, ctx({ expanded: true }));
	expect(strip(row)).toMatch(/^   ✓ done · ! blocked  Subagent /);
	expect(row).toContain(color.accentSuccess("✓ done"));
	expect(row).toContain(color.accentError("! blocked"));
	expect(details.map(strip)).toContain("     ! blocked - 1 check unmet - checks missing");
	const [once = "", ...shared] = renderSubagentRow(cancelled, 100, ctx({ expanded: true }));
	expect(strip(once)).toMatch(/^   – cancelled  Subagent /);
	expect(shared.map(strip)).toContain("     – cancelled - 1 check unmet");
	const members = [running, blocked, verified, cancelled].map((block) => block.progress);
	const history = renderRoster(members, 100, 0, NOW).at(-1) ?? "";
	expect(strip(history)).toBe(" History: 2 done · 1 cancelled · 2 not verified · 1 verified");
	expect(history).toContain(color.textSecondary("2 not verified"));
	expect(history).toContain(color.accentSuccess("1 verified"));
	expect(strip(renderRoster(members, 40, 0, NOW).at(-1) ?? "")).toBe(" History: 2 done · 1 cancelled...");
	expect(strip(renderRoster([running.progress], 100, 0, NOW).at(-1) ?? "")).toBe(" /agents: details & history");
});

test("all 4^3 state combinations conserve counts and show only active task rows", () => {
	const statuses = ["running", "completed", "failed", "cancelled"] as const;
	for (const a of statuses) for (const b of statuses) for (const c of statuses) {
		const rows = [a, b, c].map((status, i) => progress(`task-${i}`, status, { ...(status === "running" ? {} : { endedAt: NOW }) }));
		const counts = subagentCounts(rows);
		expect(Object.values(counts).reduce((sum, n) => sum + n, 0)).toBe(rows.length);
		const lines = renderRoster(rows, 100, 0, NOW).map(strip).join("\n");
		expect(lines).toContain(`${counts.running} running`);
		for (const row of rows) expect(lines.includes(row.description)).toBe(row.status === "running");
		for (const status of statuses.slice(1)) if (counts[status]) expect(lines).toContain(`${counts[status]} ${status === "completed" ? "done" : status}`);
		expect(lines).toContain("/agents");
	}
});

test("live roster bounds height, names hidden tasks, and fits Korean widths", () => {
	const many = Array.from({ length: ROSTER_MAX_ROWS + 2 }, (_, index) => progress(`t${index}`, "running", { description: KOREAN }));
	for (const width of [40, 60, 80, 140]) {
		const lines = renderRoster(many, width, 0, NOW);
		expect(lines).toHaveLength(ROSTER_MAX_ROWS * 2 + 3);
		expect(lines.map(strip).join("\n")).toContain("+2 running · /agents");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	}
});

test("terminal roster stays static across time, ticks, and subsequent parent turns", () => {
	const rows = [progress("old", "completed", { endedAt: NOW }), progress("failed", "failed", { endedAt: NOW })];
	const first = renderRoster(rows, 80, 0, NOW);
	expect(renderRoster(rows, 80, 200, NOW + 90000)).toBe(first);
	expect(first.map(strip).join("\n")).not.toContain("Explore old summary");
	expect(renderRoster([], 80, 0, NOW)).toEqual([]);
});

test("takeover always names state before Subagent and keeps terminal colors and widths", () => {
	for (const status of ["running", "completed", "failed", "cancelled"] as const) {
		for (const width of [40, 60, 80, 140]) {
			const lines = takeoverTitle(progress("a", status, { description: KOREAN, ...(status === "running" ? {} : { endedAt: NOW }) }), width, { tick: 0, now: NOW });
			expect(strip(lines[1]!)).toContain(`${status === "completed" ? "done" : status} Subagent`);
			for (const line of lines) expect(visibleWidth(line)).toBe(width);
		}
	}
});

const usage: Usage = { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
let entryIds = 0;

function entry(kind: string, message: UserMessage | AssistantMessage | ToolResultMessage): EntryRecord {
	return { id: ++entryIds as EntryId, conversationId: 1 as ConversationId, kind, model: [message] };
}

function childState(): ChatState {
	const state = new ChatState();
	const user: UserMessage = { role: "user", content: "You are a subagent working in /tmp/x.", timestamp: NOW - 24_000 };
	const assistant: AssistantMessage = { role: "assistant", content: [{ type: "thinking", thinking: "plan" }, { type: "text", text: "calc.py defines add and mul." }], api: "pi-messages", provider: "faux", model: "faux-1", usage, stopReason: "stop", timestamp: NOW };
	state.apply({ type: "entry_appended", entry: entry("pi.user", user) }, NOW - 24_000);
	state.apply({ type: "entry_appended", entry: entry("pi.assistant", assistant) }, NOW);
	return state;
}

test("the takeover frames the child's header, transcript and footer between the rails at 80x30", () => {
	const header = { render: () => ["", "  master /tmp/x", ""], invalidate() {} };
	const transcript = new Transcript(childState());
	const done = progress("a", "completed", { description: "Summarize calc.py after sleep", startedAt: NOW - 24_000, endedAt: NOW });
	const view = createTakeoverView({ progress: () => done, header, transcript, footer: () => "q/Esc:back  |  Enter:open", tick: () => 0, now: () => NOW });
	transcript.fillTo = () => view.scroll.viewportHeight - view.headerRows();
	renderLayoutFrame(view.root, 80, 30, () => {});
	const lines = renderLayoutFrame(view.root, 80, 30, () => {}).lines.map(strip);
	expect(lines).toHaveLength(30);
	for (const line of lines) expect(visibleWidth(line)).toBe(80);
	expect(lines[0]).toBe(" ".repeat(80));
	expect(lines[1]).toBe(`  +${"-".repeat(74)}+  `);
	expect(lines[2]).toContain("| ✓ done Subagent Summarize calc.py after sleep");
	expect(lines[3]).toBe(`  +${"-".repeat(74)}+  `);
	expect(lines[5]).toMatch(/^  \|  master \/tmp\/x +\| {2}$/);
	const text = lines.join("\n");
	expect(text).toContain("Task: Summarize calc.py after sleep");
	expect(text).toContain("explore · foreground · 0 tools");
	expect(text).toContain("You are a subagent working in /tmp/x.");
	expect(text).toContain("Thought for 0.0s");
	expect(text).toContain("calc.py defines add and mul.");
	for (const line of lines.slice(4, 28)) expect(line).toMatch(/^  \|.*\| {2}$/);
	expect(lines[26]).toMatch(new RegExp(`^  \\|${" ".repeat(spacing.margin)}q/Esc:back {2}\\| {2}Enter:open +\\| {2}$`));
	expect(lines[28]).toBe(`  +${"-".repeat(74)}+  `);
	expect(lines[29]).toBe(" ".repeat(80));
});


test("failed and cancelled tools remain individually visible in compact groups", () => {
	const block: ToolBlock = { kind: "tool", id: "read-status", callId: "read-status", name: "read", args: { path: "missing.ts" }, status: "done", output: "", version: 1, startedAt: NOW };
	expect(isGroupable(block)).toBe(true);
	expect(isGroupable({ ...block, status: "error" })).toBe(false);
	expect(isGroupable({ ...block, status: "cancelled" })).toBe(false);
});

test("compact codemode scripts remain separate from generic tool groups", () => {
	const state = new ChatState();
	for (const id of ["script-one", "script-two"]) {
		state.apply({ type: "tool_execution_start", toolCallId: id, toolName: "codemode", args: { code: `await tools.read({ path: '${id}.ts' });` } }, NOW);
	}
	for (const block of state.data.blocks) expect(isGroupable(block)).toBe(false);
	const transcript = new Transcript(state, { ...defaultRenderers, tool: (block) => [`visible ${block.callId}`] });
	const output = transcript.render(140).map(strip).join("\n");
	expect(output).toContain("visible script-one");
	expect(output).toContain("visible script-two");
	expect(output).not.toContain("2 operations");
});


test("terminal tasks without an end timestamp do not invent a duration", () => {
	const block = subagent("completed");
	const lines = renderSubagentRow(block, 80, ctx()).map(strip).join("\n");
	expect(lines).toContain("done");
	expect(lines).not.toContain("12s");
	expect(lines).not.toContain("0s");
});
