import { expect, test } from "bun:test";
import { visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { MemoryTerminal } from "../script/bench/tui-render.ts";
import type { SessionsSnapshot, SessionStatus } from "../src/core/sessions.ts";
import type { Manifest } from "../src/manifest.ts";
import { ChatApp } from "../src/tui/app.ts";
import { HttpError, type ApiClient } from "../src/tui/client.ts";
import { SessionsPicker } from "../src/tui/panes/sessions.ts";
import { LOCAL_COMMANDS } from "../src/tui/slash.ts";

const plain = (lines: readonly string[]) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
const session = (thread: string): SessionStatus => ({ thread, conversationId: 1, busy: false, state: "idle", runningTools: [], queued: 0, subagents: [], claims: [], lastText: "Review the implementation", lastActivityAt: 60_000 });
const snapshot = (threads: string[]): SessionsSnapshot => ({ at: 120_000, claims: [], sessions: threads.map(session) });
const mouse = (type: TuiMouseEvent["type"], y: number, wheelDelta = 0): TuiMouseEvent => ({ type, x: 10, y, screenX: 10, screenY: y, width: 100, height: 30, shift: false, alt: false, ctrl: false, button: "left", wheelDelta });
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test("Sessions renders preview/key/state/time; hover selects for Enter and full-list keys/wheel scroll", () => {
	const chosen: string[] = [];
	const picker = new SessionsPicker("tui:0", { onChoose: id => chosen.push(id), onCancel() {} }, () => ({ cols: 120, rows: 24 }));
	picker.update(snapshot(Array.from({ length: 40 }, (_, i) => `tui:${i}`)));
	const lines = picker.render(100);
	expect(plain(lines)).toContain("Review the implementation");
	expect(plain(lines)).toContain("idle · 1m");
	expect(plain(lines)).toContain("tui:0");
	picker.handleMouse(mouse("move", picker.geometry.listTop + 5));
	expect(picker.selected?.id).toBe("tui:2");
	picker.handleInput("\r");
	expect(chosen).toEqual(["tui:2"]);
	picker.handleMouse(mouse("wheel", picker.geometry.listTop, 25));
	expect(picker.selected?.id).toBe("tui:27");
	expect(picker.scrollTop).toBeGreaterThan(12);
	expect(plain(picker.render(100))).toContain("tui:27");
	const scroll = picker.scrollTop;
	picker.update(snapshot(Array.from({ length: 40 }, (_, i) => `tui:${i}`)));
	expect(picker.scrollTop).toBe(scroll);
	expect(picker.selected?.id).toBe("tui:27");
	picker.handleInput("\x1b[B");
	expect(picker.selected?.id).toBe("tui:28");
	picker.handleInput("\x1b[A");
	expect(picker.selected?.id).toBe("tui:27");
	picker.handleInput("\x1b[F");
	expect(picker.selected?.id).toBe("tui:39");
	for (const width of [24, 44, 80, 122]) for (const line of picker.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
});

test("opening focuses the newest session (first row), not an older current one, and keeps it across refreshes", () => {
	const picker = new SessionsPicker("tui:main", { onChoose() {}, onCancel() {} }, () => ({ cols: 120, rows: 30 }));
	picker.update(snapshot(["tui:newest", "tui:middle", "tui:main"]));
	expect(picker.selected?.id).toBe("tui:newest");
	expect(picker.scrollTop).toBe(0);
	picker.update(snapshot(["tui:other", "tui:newest", "tui:middle", "tui:main"]));
	expect(picker.selected?.id).toBe("tui:newest");
});

test("live refresh retains selection/filter and updates preview; removal and external-only lists cannot attach stale keys", () => {
	const chosen: string[] = [];
	const picker = new SessionsPicker("tui:a", { onChoose: id => chosen.push(id), onCancel() {} }, () => ({ cols: 120, rows: 30 }));
	picker.update(snapshot(["tui:a", "tui:b", "slack:a"]));
	picker.handleInput("b");
	const update = snapshot(["slack:a", "tui:b", "tui:a"]);
	update.sessions[1]!.lastText = "Changed preview";
	picker.update(update);
	expect(picker.filter).toBe("b");
	expect(picker.selected?.id).toBe("tui:b");
	expect(plain(picker.render(100))).toContain("Changed preview");
	picker.update(snapshot(["slack:a"]));
	picker.handleInput("\x15");
	picker.render(100);
	picker.handleMouse(mouse("move", picker.geometry.listTop));
	picker.handleMouse(mouse("click", picker.geometry.listTop));
	picker.handleInput("\r");
	expect(chosen).toEqual([]);
	expect(plain(picker.render(100))).toContain("external");
	picker.update(snapshot(Array.from({ length: 40 }, (_, i) => `slack:${i}`)));
	picker.handleInput("\x1b[F");
	expect(picker.selected?.id).toBe("slack:39");
	expect(picker.scrollTop).toBeGreaterThan(12);
	picker.handleInput("\r");
	expect(chosen).toEqual([]);
});

class InputTerminal extends MemoryTerminal {
	onInput: ((data: string) => void) | undefined;
	override start(onInput: (data: string) => void, onResize: () => void) { this.onInput = onInput; super.start(onInput, onResize); }
}
function fixture() {
	const terminal = new InputTerminal(140, 40);
	const streams: { receive: (snapshot: SessionsSnapshot) => void; signal: AbortSignal; reject: (error: unknown) => void; resolve: () => void }[] = [];
	const attached: { channel: string; thread: string; signal: AbortSignal }[] = [];
	const client = {
		commands: async () => [{ name: "help", description: "Help" }, { name: "threads", description: "Old server command" }],
		threadModel: async () => ({ model: "fake/fake", thinkingLevel: "off", supportedThinkingLevels: ["off"] }),
		events: (channel: string, thread: string, _receive: unknown, signal: AbortSignal) => { attached.push({ channel, thread, signal }); return new Promise<void>(resolve => signal.addEventListener("abort", () => resolve())); },
		sessionsEvents: (receive: (snapshot: SessionsSnapshot) => void, signal: AbortSignal) => new Promise<void>((resolve, reject) => { streams.push({ receive, signal, resolve, reject }); }),
	} as unknown as ApiClient;
	const app = new ChatApp(client, { model: { provider: "fake", modelId: "fake" }, toolMode: "hybrid" } as Manifest, "main", undefined, undefined, 10000, terminal, { preferences: { load: () => ({ toolsExpanded: false }), save() {} } });
	app.start();
	const open = (command = "/sessions") => { app.screen.prompt.onSubmit?.(command); return app.screen.modal as SessionsPicker; };
	return { app, terminal, streams, attached, open };
}

test("app routes real mouse hover then Enter, aborts picker stream and attaches exactly the selected TUI key", async () => {
	const { app, terminal, streams, attached, open } = fixture();
	try {
		const picker = open();
		streams[0]!.receive(snapshot(["tui:main", "tui:side:branch", "slack:side:branch"]));
		app.screen.tui.renderNow();
		const bounds = app.screen.modalBounds()!;
		terminal.onInput?.(`\x1b[<35;${bounds.col + 11};${bounds.row + picker.geometry.listTop + 4}M`);
		expect(picker.selected?.id).toBe("tui:side:branch");
		terminal.onInput?.("\r");
		expect(app.screen.modal).toBeUndefined();
		expect(streams[0]!.signal.aborted).toBe(true);
		expect(attached.map(({ channel, thread }) => [channel, thread])).toEqual([["tui", "main"], ["tui", "side:branch"]]);
		expect(attached[0]!.signal.aborted).toBe(true);
	} finally { app.screen.stop(); }
});

test("Esc and alias preserve draft, chat identity/focus; stale streams cannot update a reopened modal", async () => {
	const { app, terminal, streams, attached, open } = fixture();
	try {
		await flush();
		app.chat.notice("Existing conversation");
		app.screen.prompt.setText("unfinished draft");
		app.screen.focusTranscript();
		const focus = app.screen.tui.getFocusedComponent();
		const chat = app.chat;
		const picker = open("/threads");
		expect(picker).toBeInstanceOf(SessionsPicker);
		streams[0]!.receive(snapshot(["tui:main", "tui:other"]));
		terminal.onInput?.("\x1b");
		expect(app.screen.modal).toBeUndefined();
		expect(app.screen.prompt.getText()).toBe("unfinished draft");
		expect(app.screen.tui.getFocusedComponent()).toBe(focus);
		expect(app.chat).toBe(chat);
		expect(attached).toHaveLength(1);
		expect(attached[0]!.signal.aborted).toBe(false);
		expect(streams[0]!.signal.aborted).toBe(true);
		const reopened = open();
		streams[0]!.receive(snapshot(["tui:stale"]));
		streams[0]!.reject(new Error("late error"));
		await flush();
		expect(plain(reopened.render(100))).toContain("Connecting");
		streams[1]!.receive(snapshot(["tui:main"]));
		reopened.handleInput("\r");
		expect(app.chat).toBe(chat); // current selection is not a reattach
		expect(attached).toHaveLength(1);
		expect(streams[1]!.signal.aborted).toBe(true);
		open();
		open();
		expect(streams[2]!.signal.aborted).toBe(true);
		app.screen.stop();
		expect(streams[3]!.signal.aborted).toBe(true);
	} finally { app.screen.stop(); }
});

test("terminal wheel reaches the full list, outside click restores prompt, and stream completion is explicit", async () => {
	const { app, terminal, streams, attached } = fixture();
	try {
		app.screen.prompt.setText("/sessions");
		terminal.onInput?.("\r");
		const picker = app.screen.modal as SessionsPicker;
		expect(picker).toBeInstanceOf(SessionsPicker);
		streams[0]!.receive(snapshot(Array.from({ length: 40 }, (_, i) => `tui:${i}`)));
		app.screen.tui.renderNow();
		const bounds = app.screen.modalBounds()!;
		for (let i = 0; i < 18; i++) terminal.onInput?.(`\x1b[<65;${bounds.col + 11};${bounds.row + picker.geometry.listTop + 1}M`);
		expect(picker.scrollTop).toBeGreaterThan(0);
		expect(Number(picker.selected!.id.slice(4))).toBeGreaterThan(12);
		streams[0]!.resolve();
		await flush();
		expect(plain(picker.render(100))).toContain("disconnected");
		terminal.onInput?.("\x1b[<0;1;1M");
		terminal.onInput?.("\x1b[<0;1;1m");
		expect(app.screen.modal).toBeUndefined();
		expect(app.screen.tui.getFocusedComponent()).toBe(app.screen.prompt);
		terminal.onInput?.("draft continues");
		expect(app.screen.prompt.getText()).toBe("draft continues");
		expect(attached).toHaveLength(1);
		expect(streams[0]!.signal.aborted).toBe(true);
	} finally { app.screen.stop(); }
});

test("loading/empty/error states remain cancellable and help hides threads even from older servers", async () => {
	const { app, streams, open } = fixture();
	try {
		await flush();
		const picker = open();
		expect(picker.selected?.disabled).toBe(true);
		streams[0]!.receive(snapshot([]));
		expect(plain(picker.render(100))).toContain("No sessions yet");
		streams[0]!.reject(new HttpError(404, "missing"));
		await flush();
		expect(plain(picker.render(120))).toContain("restart it");
		picker.handleInput("\r");
		expect(app.screen.modal).toBe(picker);
		picker.handleInput("\x1b");
		app.screen.prompt.onSubmit?.("/help");
		const notices = app.chat.data.blocks.filter(block => block.kind === "notice").map(block => block.text).join("\n");
		expect(notices).toContain("/sessions");
		expect(notices).not.toContain("/threads");
		expect(LOCAL_COMMANDS.some(command => command.name === "threads")).toBe(false);
	} finally { app.screen.stop(); }
});

test("delete key: first press arms the row, second deletes; other keys disarm; current and external rows are refused", () => {
	const deleted: string[] = [];
	const picker = new SessionsPicker("tui:a", { onChoose() {}, onCancel() {}, onDelete: key => deleted.push(key) }, () => ({ cols: 120, rows: 30 }));
	picker.update(snapshot(["tui:b", "tui:a", "slack:c"]));
	expect(plain(picker.render(120))).toContain("del delete");
	expect(picker.selected?.id).toBe("tui:b");
	picker.handleInput("\x1b[3~");
	expect(plain(picker.render(120))).toContain("press del again to delete");
	expect(deleted).toEqual([]);
	picker.handleInput("\x1b[B");
	picker.handleInput("\x1b[A");
	expect(plain(picker.render(120))).not.toContain("press del again");
	picker.handleInput("\x1b[3~");
	picker.update(snapshot(["tui:b", "tui:a", "slack:c"]));
	expect(plain(picker.render(120))).toContain("press del again to delete");
	picker.handleInput("\x1b[3~");
	expect(deleted).toEqual(["tui:b"]);
	expect(plain(picker.render(120))).toContain("Deleting tui:b");
	picker.handleInput("\x1b[B");
	expect(picker.selected?.id).toBe("tui:a");
	picker.handleInput("\x1b[3~");
	picker.handleInput("\x1b[3~");
	expect(plain(picker.render(120))).toContain("switch to another one");
	picker.handleInput("\x1b[B");
	expect(picker.selected?.id).toBe("slack:c");
	picker.handleInput("\x1b[3~");
	picker.handleInput("\x1b[3~");
	expect(plain(picker.render(120))).toContain("Only tui sessions");
	expect(deleted).toEqual(["tui:b"]);
});

test("app deletes the twice-confirmed session through the client and reports refusals in the picker", async () => {
	const { app, streams, open } = fixture();
	const calls: string[] = [];
	const outcomes = [{ status: "busy" }, { status: "deleted", removed: ["tui:old"], releasedClaims: 0 }];
	(app as unknown as { client: { deleteThread: (channel: string, thread: string) => Promise<unknown> } }).client.deleteThread = async (channel, thread) => { calls.push(channel + ":" + thread); return outcomes.shift(); };
	try {
		const picker = open();
		streams[0]!.receive(snapshot(["tui:old", "tui:main"]));
		picker.handleInput("\x1b[3~");
		picker.handleInput("\x1b[3~");
		await flush();
		expect(calls).toEqual(["tui:old"]);
		expect(plain(picker.render(120))).toContain("is working");
		picker.handleInput("\x1b[3~");
		picker.handleInput("\x1b[3~");
		await flush();
		expect(calls).toEqual(["tui:old", "tui:old"]);
		expect(plain(picker.render(120))).toContain("Deleted tui:old");
		expect(app.screen.modal).toBe(picker);
	} finally { app.screen.stop(); }
});
