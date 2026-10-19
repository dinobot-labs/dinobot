import { expect, test } from "bun:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { renderLayoutFrame } from "../node_modules/@earendil-works/pi-tui/dist/layout.js";
import { createHarness, MemoryTerminal } from "../script/bench/tui-render.ts";
import type { SendNowResult, WithdrawResult } from "../src/core/queue.ts";
import type { ClientSnapshotEvent, QueuedInput } from "../src/core/ui-contract.ts";
import type { Manifest } from "../src/manifest.ts";
import { ChatApp } from "../src/tui/app.ts";
import type { ApiClient } from "../src/tui/client.ts";
import { queueItemRows, renderQueue } from "../src/tui/panes/queue.ts";
import type { Screen } from "../src/tui/screen.ts";
import { ChatState, createChatData, reduceEvent } from "../src/tui/state.ts";
import { color, glyph, spacing } from "../src/tui/theme.ts";

const margin = " ".repeat(spacing.margin);
const plain = (line: string | undefined): string => stripTerminalSequences(line ?? "").trimEnd();
const promptTop = (lines: string[]): number => lines.findIndex((line) => new RegExp(`^ {${spacing.margin}}\\+-+\\+$`).test(line));
const frame = (screen: Screen, width: number, rows: number): string[] => {
	renderLayoutFrame(screen["root"], width, rows, () => {});
	return renderLayoutFrame(screen["root"], width, rows, () => {}).lines.map(plain);
};
const item = (id: number, text: string, mode: QueuedInput["mode"] = "steer"): QueuedInput => ({ id, mode, text, userId: "roach" });
const snapshot = (queue: QueuedInput[], run = true): ClientSnapshotEvent =>
	({ type: "snapshot", entries: [], tools: [], compactions: [], inbox: queue.map(({ id, mode }) => ({ id, mode })), agent: {}, usage: { models: {}, tools: {} }, ...(run ? { run: true } : {}), queue }) as unknown as ClientSnapshotEvent;
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
	return { promise, resolve, reject };
}

test("renderQueue: nothing queued draws no rows; the title counts every item and the newest sits last", () => {
	expect(renderQueue([], 100, 40)).toEqual([]);
	const lines = renderQueue([item(3, "first thing", "followUp"), item(5, "second thing")], 100, 40);
	const rows = lines.map(plain);
	expect(rows[0]).toBe(`${margin}Queued 2`);
	expect(rows[1]).toStartWith(`${margin} ${glyph.promptArrow}first thing  `);
	expect(rows[1]).toEndWith("  follow-up");
	expect(rows[2]).toStartWith(`${margin} ${glyph.promptArrow}second thing  `);
	expect(rows[2]).toEndWith("  steer");
	// The mode words end on the right margin, like the TODO/DAG rows.
	for (const row of rows.slice(1)) expect(visibleWidth(row)).toBe(100 - spacing.margin);
	expect(rows).toHaveLength(3);
	// Existing tokens only: the caption title color, a gray arrow (not the delivered prompt's mint), secondary text, gray meta.
	expect(lines[0]).toBe(`${margin}${color.grayBright("Queued 2")}`);
	expect(lines[2]).toContain(color.grayBright(glyph.promptArrow));
	expect(lines[2]).not.toContain(color.accentUser(glyph.promptArrow));
	expect(lines[2]).toContain(color.textSecondary("second thing"));
	expect(lines[2]).toEndWith(color.gray("steer"));
});

test("renderQueue: rows follow the terminal height and the hidden count keeps the on-screen sum equal to N", () => {
	expect([8, 12, 20, 29, 30, 40, 100].map(queueItemRows)).toEqual([1, 1, 2, 2, 3, 3, 3]);
	const items = [1, 2, 3, 4, 5].map((id) => item(id, `message ${id}`));
	const tall = renderQueue(items, 100, 40).map(plain);
	expect(tall[0]).toBe(`${margin}Queued 5  +2 earlier`);
	expect(tall.slice(1).map((line) => line.match(/message \d/)?.[0])).toEqual(["message 3", "message 4", "message 5"]);
	const short = renderQueue(items, 100, 12).map(plain);
	expect(short[0]).toBe(`${margin}Queued 5  +4 earlier`);
	expect(short).toHaveLength(2);
	expect(short[1]).toContain("message 5");
	expect(renderQueue(items.slice(0, 1), 100, 12).map(plain)[0]).toBe(`${margin}Queued 1`);
});

test("renderQueue: untrusted text becomes one inert line, is cut with the ellipsis, and the mode word drops first when narrow", () => {
	const hostile = item(1, "evil\x1b[31mred\x1b]8;;http://x\x07link\nsecond line\tend");
	const lines = renderQueue([hostile], 100, 40);
	expect(lines[1]).not.toContain("\x1b[31m");
	expect(lines[1]).not.toContain("\x1b]8;;");
	expect(plain(lines[1])).toContain("evilredlink second line end");
	const long = item(2, "x".repeat(300));
	for (let width = 8; width <= 140; width++) {
		for (const line of renderQueue([hostile, long], width, 40)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	}
	// 20 columns leave 11 for text + word; "steer" would squeeze the text under 12, so it drops.
	const narrow = renderQueue([long], 20, 40).map(plain);
	expect(narrow[1]).toEndWith(glyph.ellipsis);
	expect(narrow[1]).not.toContain("steer");
	const wide = renderQueue([long], 60, 40).map(plain);
	expect(wide[1]).toEndWith(`${glyph.ellipsis}  steer`);
	expect(visibleWidth(wide[1]!)).toBe(60 - spacing.margin);
});

test("the queue comes from the server's queue view only: snapshot queue, then queue_status; inbox_update counts are ignored", () => {
	const data = createChatData();
	reduceEvent(data, snapshot([item(1, "a")]), 1);
	expect(data.queue).toEqual([item(1, "a")]);
	reduceEvent(data, { type: "queue_status", items: [item(1, "a"), item(2, "b")] }, 2);
	expect(data.queue.map((entry) => entry.id)).toEqual([1, 2]);
	reduceEvent(data, { type: "inbox_update", items: [] } as never, 3);
	expect(data.queue).toHaveLength(2);
	reduceEvent(data, { type: "queue_status", items: [] }, 4);
	expect(data.queue).toEqual([]);
	reduceEvent(data, { ...snapshot([]), queue: undefined } as never, 5);
	expect(data.queue).toEqual([]);
});

test("the screen puts the queue directly on the prompt box, under the TODO caption, and the turn status no longer counts it", () => {
	const harness = createHarness(new ChatState(), 100, 30);
	try {
		harness.state.apply(snapshot([item(1, "first queued"), item(2, "second queued")]));
		harness.state.apply({ type: "tool_execution_update", toolCallId: "t", toolName: "todo_write", details: { todos: [{ id: "1", content: "wire it", status: "in_progress" }] } } as never);
		const lines = frame(harness.screen, 100, 30);
		const top = promptTop(lines);
		expect(lines[top - 1]).toContain("second queued");
		expect(lines[top - 2]).toContain("first queued");
		expect(lines[top - 3]).toBe(`${margin}Queued 2`);
		expect(lines[top - 4]).toStartWith(`${margin}TODO 0/1 done`);
		expect(lines.some((line) => /queued, Enter/.test(line))).toBe(false);
		for (const line of renderLayoutFrame(harness.screen["root"], 100, 30, () => {}).lines) expect(visibleWidth(line)).toBeLessThanOrEqual(100);

		harness.state.apply({ type: "queue_status", items: [] });
		const cleared = frame(harness.screen, 100, 30);
		expect(cleared.some((line) => line.includes("Queued"))).toBe(false);
		expect(cleared[promptTop(cleared) - 1]).toStartWith(`${margin}TODO 0/1 done`);
	} finally { harness.dispose(); }
});

test("a short terminal keeps the transcript minimum: queue rows count against the work deck, not the transcript", () => {
	const harness = createHarness(new ChatState(), 80, 16);
	try {
		harness.state.apply(snapshot([item(1, "a"), item(2, "b"), item(3, "c")]));
		harness.state.notice("transcript marker");
		const lines = frame(harness.screen, 80, 16);
		const top = promptTop(lines);
		expect(lines[top - 2]).toBe(`${margin}Queued 3  +2 earlier`);
		expect(lines[top - 1]).toContain(" c");
		expect(lines.some((line) => line.includes("transcript marker"))).toBe(true);
	} finally { harness.dispose(); }
});

class InputTerminal extends MemoryTerminal {
	onInput: ((data: string) => void) | undefined;
	override start(onInput: (data: string) => void, onResize: () => void): void {
		this.onInput = onInput;
		super.start(onInput, onResize);
	}
}

function setup() {
	const calls: { send: string[]; withdraw: { thread: string; id: number }[]; messages: { text: string; whenBusy?: string }[] } = { send: [], withdraw: [], messages: [] };
	const sends: ReturnType<typeof deferred<SendNowResult>>[] = [];
	const withdraws: ReturnType<typeof deferred<WithdrawResult>>[] = [];
	const terminal = new InputTerminal(120, 40);
	const client = {
		commands: async () => [],
		threadModel: async () => ({ model: "fake/model", thinkingLevel: "off", supportedThinkingLevels: ["off"] }),
		events: async () => {},
		send: async (_channel: string, _thread: string, text: string, _user: string, whenBusy?: string) => { calls.messages.push({ text, ...(whenBusy ? { whenBusy } : {}) }); },
		sendQueued: (_channel: string, thread: string) => { calls.send.push(thread); const next = deferred<SendNowResult>(); sends.push(next); return next.promise; },
		withdrawQueued: (_channel: string, thread: string, id: number) => { calls.withdraw.push({ thread, id }); const next = deferred<WithdrawResult>(); withdraws.push(next); return next.promise; },
	} as unknown as ApiClient;
	const manifest = { model: { provider: "fake", modelId: "model" }, toolMode: "hybrid" } as Manifest;
	const app = new ChatApp(client, manifest, "a", undefined, undefined, 10000, terminal, { preferences: { load: () => ({ toolsExpanded: false }), save: () => {} } });
	app.start();
	const key = (data: string) => terminal.onInput?.(data);
	const notices = () => app.chat.data.blocks.flatMap((block) => (block.kind === "notice" ? [block.text] : []));
	const footer = () => frame(app.screen, 120, 40).filter((line) => line.includes("Ctrl+x")).join("\n");
	return { app, calls, sends, withdraws, key, notices, footer, stop: () => app.screen.stop() };
}

const DOWN = "\x1b[B";
const ENTER = "\r";

test("↓ on an empty prompt withdraws the newest queued input into the prompt, once per stroke in flight", async () => {
	const h = setup();
	try {
		await flush();
		h.app.chat.apply(snapshot([item(4, "older"), item(7, "fix the README\nand the docs")]));
		expect(h.footer()).toContain("Enter:send now");
		expect(h.footer()).toContain("↓:edit queued");
		h.key(DOWN);
		h.key(DOWN);
		expect(h.calls.withdraw).toEqual([{ thread: "a", id: 7 }]);
		h.withdraws[0]!.resolve({ status: "withdrawn", item: item(7, "fix the README\nand the docs") });
		await flush();
		expect(h.app.screen.prompt.getText()).toBe("fix the README\nand the docs");
		// The prompt holds text now, so ↓ is the editor's again and Enter steers the edited text.
		expect(h.footer()).not.toContain("send now");
		h.app.chat.apply({ type: "queue_status", items: [item(4, "older")] });
		h.key(DOWN);
		expect(h.calls.withdraw).toHaveLength(1);
	} finally { h.stop(); }
});

test("↓ keeps a draft typed while the withdraw was in flight and reports an input that was already delivered", async () => {
	const h = setup();
	try {
		await flush();
		h.app.chat.apply(snapshot([item(9, "queued text")]));
		h.key(DOWN);
		h.app.screen.prompt.setText("typed meanwhile");
		h.withdraws[0]!.resolve({ status: "withdrawn", item: item(9, "queued text") });
		await flush();
		expect(h.app.screen.prompt.getText()).toBe("queued text\ntyped meanwhile");

		h.app.screen.prompt.setText("");
		h.app.chat.apply({ type: "queue_status", items: [item(10, "raced")] });
		h.key(DOWN);
		h.withdraws[1]!.resolve({ status: "already_placed" });
		await flush();
		expect(h.app.screen.prompt.getText()).toBe("");
		expect(h.notices()).toContain("That queued input already reached the agent.");
	} finally { h.stop(); }
});

test("Enter on an empty prompt sends the queue now, once per request; without a queue it does nothing", async () => {
	const h = setup();
	try {
		await flush();
		h.key(ENTER);
		h.key(DOWN);
		expect(h.calls.send).toEqual([]);
		expect(h.calls.withdraw).toEqual([]);
		expect(h.footer()).not.toContain("send now");

		h.app.chat.apply(snapshot([item(1, "one"), item(2, "two")]));
		h.key(ENTER);
		h.key(ENTER);
		h.key(DOWN);
		expect(h.calls.send).toEqual(["a"]);
		expect(h.calls.withdraw).toEqual([]);
		expect(h.calls.messages).toEqual([]);
		h.sends[0]!.resolve({ sent: 2, submissionId: 3 });
		await flush();
		expect(h.notices()).toEqual([]);

		h.key(ENTER);
		expect(h.calls.send).toEqual(["a", "a"]);
		h.sends[1]!.resolve({ sent: 0 });
		await flush();
		expect(h.notices()).toContain("Nothing left to send: the queued input already reached the agent.");
	} finally { h.stop(); }
});

test("typed text still steers with Enter while input is queued, and a failed queue request is an error notice", async () => {
	const h = setup();
	try {
		await flush();
		h.app.chat.apply(snapshot([item(1, "one")]));
		h.app.screen.prompt.setText("new direction");
		h.key(ENTER);
		await flush();
		expect(h.calls.messages).toEqual([{ text: "new direction", whenBusy: "steer" }]);
		expect(h.calls.send).toEqual([]);

		h.key(ENTER);
		h.sends[0]!.reject(new Error("POST /v1/threads/tui/a/queue/send: HTTP 500 boom"));
		await flush();
		expect(h.notices()).toContain("POST /v1/threads/tui/a/queue/send: HTTP 500 boom");
		h.key(ENTER);
		expect(h.calls.send).toHaveLength(2);
	} finally { h.stop(); }
});

test("queue keys stay off while the transcript has focus", async () => {
	const h = setup();
	try {
		await flush();
		h.app.chat.apply(snapshot([item(1, "one")]));
		h.app.screen.focusTranscript();
		h.key(DOWN);
		expect(h.calls.withdraw).toEqual([]);
		h.app.screen.focusPrompt();
		h.key(DOWN);
		expect(h.calls.withdraw).toEqual([{ thread: "a", id: 1 }]);
	} finally { h.stop(); }
});
