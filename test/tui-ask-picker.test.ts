import { expect, jest, spyOn, test } from "bun:test";
import { userInfo } from "node:os";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { MemoryTerminal } from "../script/bench/tui-render.ts";
import type { Manifest } from "../src/manifest.ts";
import { ChatApp } from "../src/tui/app.ts";
import { ApiClient, HttpError } from "../src/tui/client.ts";
import { modalOverlayOptions } from "../src/tui/modal.ts";
import { Picker } from "../src/tui/picker.ts";
import { asksIn, type AskView } from "../src/tui/state.ts";

class InputTerminal extends MemoryTerminal {
	input: ((data: string) => void) | undefined;
	override start(input: (data: string) => void, resize: () => void): void { this.input = input; super.start(input, resize); }
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const ask = (extra: Partial<AskView> = {}): AskView => ({ id: "a".repeat(32), to: "human", kind: "decision", question: "Which database?", from: "1", state: "open", default: "SQLite", deadlineAt: Date.now() + 60_000, options: ["SQLite", "Postgres"], ...extra });
function setup(error?: Error) {
	const terminal = new InputTerminal(100, 35);
	const sends: unknown[][] = [];
	const commands: string[] = [];
	const client = {
		commands: async () => [{ name: "choose", description: "Server command must be shadowed" }],
		commandArguments: async () => [],
		threadModel: async () => ({ model: "fake/model" }),
		events: (_channel: string, _thread: string, _emit: unknown, signal: AbortSignal) => new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })),
		send: async (...args: unknown[]) => { sends.push(args); if (error) throw error; },
		runCommand: async (_channel: string, _thread: string, name: string) => { commands.push(name); },
	} as unknown as ApiClient;
	const app = new ChatApp(client, { model: { provider: "fake", modelId: "model" }, toolMode: "hybrid" } as Manifest, "main", undefined, undefined, 10000, terminal, { preferences: { load: () => ({ toolsExpanded: false }), save: () => {} } });
	app.start();
	const key = (data: string) => terminal.input?.(data);
	const submit = (text: string) => { app.screen.prompt.setText(text); key("\r"); };
	let entryId = 0;
	const emit = (value: AskView) => app.chat.apply({ type: "tool_execution_end", toolCallId: value.id, toolName: "ask", entry: { id: ++entryId, conversationId: 1, kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: value.id, toolName: "ask", content: [{ type: "text", text: "Question" }], details: { ask: value }, isError: false, timestamp: Date.now() }] } as unknown as EntryRecord });
	return { app, sends, commands, key, submit, emit };
}
const optionRows = (picker: Picker) => picker.entries.flatMap(row => row.kind === "option" ? [row.option] : []);
const notices = (app: ChatApp) => app.chat.data.blocks.flatMap(block => block.kind === "notice" ? [block.text] : []);

test("I7 options projection tolerates malformed choices without dropping the ask", () => {
	for (const options of [null, "wrong", ["A", 2], {}]) {
		const projected = asksIn({ ask: { ...ask(), options } });
		expect(projected).toHaveLength(1);
		expect(projected[0]).not.toHaveProperty("options");
	}
	const original = ask();
	const projected = asksIn({ ask: original })[0]!;
	expect(projected.options).toEqual(original.options);
	expect(projected.options).not.toBe(original.options);
	expect(asksIn({ ask: { ...ask(), options: undefined } })[0]).not.toHaveProperty("options");
});

test("S1 automatic picker waits for turn end and sends structured index, not label", async () => {
	const h = setup();
	try {
		h.app.chat.apply({ type: "run_start", inputs: [] });
		const question = ask({ question: "😀".repeat(90) });
		h.emit(question);
		expect(h.app.screen.modal).toBeUndefined();
		expect(notices(h.app).some(text => text.includes("Choices: 1) SQLite  2) Postgres — /choose to pick, or answer in chat."))).toBe(true);
		h.app.chat.apply({ type: "run_end", inputs: [] });
		const picker = h.app.screen.modal as Picker;
		expect(picker).toBeInstanceOf(Picker);
		expect(picker.title).toBe("Question");
		expect(picker.render(100).join("\n")).toContain("😀".repeat(10));
		expect(optionRows(picker)).toEqual([{ id: "0", label: "SQLite", tag: "default", group: "Choices" }, { id: "1", label: "Postgres", group: "Choices" }, { id: "custom", label: "Write my own answer...", group: "Your answer" }]);
		h.key("\x1b[B"); h.key("\r"); await flush();
		expect(h.sends).toEqual([["tui", "main", `[ask ${question.id}] choice #2`, userInfo().username, undefined, undefined, { askId: question.id, option: 1 }]]);
		expect(h.app.screen.modal).toBeUndefined();
		picker.handleInput("\r");
		expect(h.sends).toHaveLength(1);
	} finally { h.app.stop(); }
});

test("automatic picker safeguards: draft, other modal, already shown, no eligible ask", async () => {
	for (const reason of ["draft", "modal", "shown", "expired", "main", "answered"]) {
		const h = setup();
		try {
			await flush();
			let question = ask();
			const other = new Picker("Other", [], { onChoose: () => {}, onCancel: () => {} }, () => h.app.screen.size());
			if (reason === "draft") h.app.screen.prompt.setText("unfinished draft");
			if (reason === "modal") h.app.screen.openModal(other, { anchor: "center", width: 60 });
			if (reason === "shown") { h.emit(question); h.key("\x1b"); }
			if (reason === "expired") question = ask({ deadlineAt: Date.now() - 1 });
			if (reason === "main") question = ask({ to: "main" });
			if (reason === "answered") question = ask({ state: "answered" });
			h.emit(question); h.app.chat.notice("another update");
			expect(h.app.screen.modal).toBe(reason === "modal" ? other : undefined);
			if (reason === "draft") {
				expect(h.app.screen.prompt.getText()).toBe("unfinished draft");
				h.app.screen.prompt.setText(""); h.app.chat.notice("idle update");
				expect(h.app.screen.modal).toBeInstanceOf(Picker);
			}
		} finally { h.app.stop(); }
	}
});

test("S1 Esc reopens only with local /choose; manual choice steers a running turn", async () => {
	const h = setup();
	try {
		await flush(); h.emit(ask()); h.key("\x1b");
		expect(notices(h.app)).toContain("Use /choose to answer later");
		expect(h.app.screen.modal).toBeUndefined();
		h.app.chat.notice("update"); expect(h.app.screen.modal).toBeUndefined();
		h.app.chat.apply({ type: "run_start", inputs: [] });
		h.submit("/choose"); expect(h.app.screen.modal).toBeInstanceOf(Picker);
		h.key("\r"); await flush();
		expect(h.sends[0]?.[4]).toBe("steer");
		expect(h.commands).toEqual([]);
	} finally { h.app.stop(); }
});

test("/choose opens the first-asked question; no question produces local notice", async () => {
	const h = setup();
	try {
		await flush(); h.submit("/choose");
		expect(notices(h.app)).toContain("No open question");
		h.app.chat.apply({ type: "run_start", inputs: [] });
		h.emit(ask({ id: "b".repeat(32), deadlineAt: Date.now() + 120_000, question: "First asked" }));
		h.emit(ask());
		h.emit(ask({ id: "c".repeat(32), deadlineAt: Date.now() + 180_000, to: "main" }));
		h.submit("/choose");
		const picker = h.app.screen.modal as Picker;
		expect(picker.title).toBe("Question 1 of 2");
		expect(picker.render(100).join("\n")).toContain("First asked");
		expect(h.commands).toEqual([]);
	} finally { h.app.stop(); }
});

test("S5/I6 remote resolution or expired update closes picker; stale handlers cannot send", () => {
	for (const change of [{ state: "answered" }, { state: "defaulted" }, { state: "withdrawn" }, { deadlineAt: Date.now() - 1 }]) {
		const h = setup();
		try {
			const question = ask(); h.emit(question);
			const picker = h.app.screen.modal as Picker;
			h.emit({ ...question, ...change });
			expect(h.app.screen.modal).toBeUndefined();
			picker.handleInput("\r"); expect(h.sends).toEqual([]);
		} finally { h.app.stop(); }
	}
});

test("picker and automatic subscriptions are cleaned up on thread switch and stop", async () => {
	const h = setup();
	try {
		await flush(); h.emit(ask());
		const old = h.app.chat;
		const picker = h.app.screen.modal as Picker;
		// Use the real controller path even though a modal currently owns terminal focus.
		h.app.screen.prompt.onSubmit?.("/thread next"); await flush();
		expect(h.app.screen.modal).toBeUndefined();
		old.notice("late old state"); picker.handleInput("\r");
		expect(h.sends).toEqual([]);
		h.emit(ask({ id: "b".repeat(32) }));
		const next = h.app.screen.modal as Picker; expect(next).toBeInstanceOf(Picker);
		h.app.stop();
		expect(h.app.screen.modal).toBeUndefined();
		h.app.chat.notice("late after stop"); next.handleInput("\r");
		expect(h.app.screen.modal).toBeUndefined(); expect(h.sends).toEqual([]);
	} finally { h.app.stop(); }
});

test("idle deadline closes the picker without a server update", () => {
	const h = setup();
	const now = Date.now();
	jest.useFakeTimers();
	const clock = spyOn(Date, "now").mockReturnValue(now);
	try {
		h.emit(ask({ deadlineAt: now + 50 }));
		const picker = h.app.screen.modal as Picker;
		expect(picker).toBeInstanceOf(Picker);
		clock.mockReturnValue(now + 50);
		jest.advanceTimersByTime(50);
		expect(h.app.screen.modal).toBeUndefined();
		picker.handleInput("\r");
		expect(h.sends).toEqual([]);
	} finally { clock.mockRestore(); jest.useRealTimers(); h.app.stop(); }
});

test("selection after deadline cannot send before the expiry timer runs", () => {
	const h = setup();
	const now = Date.now();
	try {
		h.emit(ask({ deadlineAt: now + 60_000 }));
		const clock = spyOn(Date, "now").mockReturnValue(now + 60_001);
		try {
			h.key("\r");
			expect(h.app.screen.modal).toBeUndefined();
			expect(h.sends).toEqual([]);
		} finally { clock.mockRestore(); }
	} finally { h.app.stop(); }
});

test("I6 rejected choice including HTTP 409 becomes an error notice and remains manually retryable", async () => {
	const h = setup(new HttpError(409, "Question already handled"));
	try {
		h.emit(ask()); h.key("\r"); await flush();
		expect(h.app.screen.modal).toBeUndefined();
		expect(h.app.chat.data.blocks.some(block => block.kind === "notice" && block.level === "error" && block.text === "Question already handled")).toBe(true);
		h.submit("/choose"); expect(h.app.screen.modal).toBeInstanceOf(Picker);
	} finally { h.app.stop(); }
});

test("picker subscriptions detach on selection, cancel, resolution, thread switch and stop", async () => {
	for (const reason of ["select", "cancel", "resolved", "thread", "stop"]) {
		const h = setup();
		const subscribe = h.app.chat.subscribe.bind(h.app.chat);
		let subscriptions = 0;
		const spy = spyOn(h.app.chat, "subscribe").mockImplementation(listener => {
			subscriptions++;
			const unsubscribe = subscribe(listener);
			return () => { subscriptions--; unsubscribe(); };
		});
		try {
			h.emit(ask()); expect(subscriptions).toBe(1);
			if (reason === "select") h.key("\r");
			if (reason === "cancel") h.key("\x1b");
			if (reason === "resolved") h.emit(ask({ state: "answered" }));
			if (reason === "thread") h.app.screen.prompt.onSubmit?.("/thread other");
			if (reason === "stop") h.app.stop();
			await flush();
			expect(subscriptions).toBe(0);
		} finally { h.app.stop(); spy.mockRestore(); }
	}
});

test("I7 ApiClient serializes optional choice without changing plain message bytes", async () => {
	const bodies: string[] = [];
	const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async request => { bodies.push(await request.text()); return new Response(null, { status: 204 }); } });
	try {
		const client = new ApiClient(new URL(`http://127.0.0.1:${server.port}`));
		await client.send("tui", "main", "hello", "alice");
		await client.send("tui", "main", "choice", "alice", "steer", undefined, { askId: "a".repeat(32), option: 1 });
		expect(bodies[0]).toBe(JSON.stringify({ text: "hello", userId: "alice" }));
		expect(JSON.parse(bodies[1]!)).toEqual({ text: "choice", userId: "alice", whenBusy: "steer", choice: { askId: "a".repeat(32), option: 1 } });
	} finally { server.stop(true); }
});

const screenText = (h: ReturnType<typeof setup>) => (h.app.screen.modal as Picker).render(100).join("\n");

test("simultaneous asks share one modal with Q tabs in asked order; answering advances to the next tab", async () => {
	const h = setup();
	try {
		await flush();
		h.app.chat.apply({ type: "run_start", inputs: [] });
		const q1 = ask({ id: "1".repeat(32), question: "Who sends reports?", options: ["Team", "Public"], default: "Team", deadlineAt: Date.now() + 60_000 });
		const q2 = ask({ id: "2".repeat(32), question: "Consent model?", options: ["Opt-in", "Every time"], default: "Opt-in", deadlineAt: Date.now() + 61_000 });
		const q3 = ask({ id: "3".repeat(32), kind: "clarification", question: "What scope?", default: "Full", deadlineAt: Date.now() + 61_000 });
		delete q3.options;
		h.emit(q1); h.emit(q2); h.emit(q3);
		expect(h.app.screen.modal).toBeUndefined();
		h.app.chat.apply({ type: "run_end", inputs: [] });
		let picker = h.app.screen.modal as Picker;
		expect(picker.title).toBe("Question 1 of 3");
		let shown = screenText(h);
		expect(shown).toContain("Q1"); expect(shown).toContain("Q2"); expect(shown).toContain("Q3");
		expect(shown).toContain("Who sends reports?");
		h.key("\x1b[C");
		expect((h.app.screen.modal as Picker).title).toBe("Question 2 of 3");
		expect(screenText(h)).toContain("Consent model?");
		h.key("\x1b[D"); h.key("\x1b[D");
		expect((h.app.screen.modal as Picker).title).toBe("Question 3 of 3");
		h.key("\t");
		expect((h.app.screen.modal as Picker).title).toBe("Question 1 of 3");
		// Answer Q1 with its second option; the modal stays open on the next question.
		h.key("\x1b[B"); h.key("\r"); await flush();
		expect(h.sends).toEqual([["tui", "main", `[ask ${q1.id}] choice #2`, userInfo().username, undefined, undefined, { askId: q1.id, option: 1 }]]);
		picker = h.app.screen.modal as Picker;
		// Numbers stay stable; the answered question stays in the tab row marked sent.
		expect(picker.title).toBe("Question 2 of 3");
		shown = screenText(h);
		expect(shown).toContain("Q1 sent"); expect(shown).toContain("[Q2]");
		expect(shown).toContain("Consent model?");
		// ←/→ skip the sent question.
		h.key("\x1b[C"); expect((h.app.screen.modal as Picker).title).toBe("Question 3 of 3");
		h.key("\x1b[C"); expect((h.app.screen.modal as Picker).title).toBe("Question 2 of 3");
		h.key("\r"); await flush();
		expect(h.sends[1]?.[6]).toEqual({ askId: q2.id, option: 0 });
		// The option-less clarification still opens, with only the free-text row.
		picker = h.app.screen.modal as Picker;
		expect(picker.title).toBe("Question 3 of 3");
		expect(optionRows(picker).map(option => option.id)).toEqual(["custom"]);
		expect(screenText(h)).toContain("What scope?");
		// Daemon resolution of the remaining ask closes the modal.
		h.emit({ ...q3, state: "answered" });
		expect(h.app.screen.modal).toBeUndefined();
	} finally { h.app.stop(); }
});

test("free-text row survives any filter and seeds the prompt with the ask id and typed text", async () => {
	const h = setup();
	try {
		await flush();
		const q1 = ask({ id: "1".repeat(32) });
		const q2 = ask({ id: "2".repeat(32), question: "Second" });
		h.emit(q1); h.emit(q2);
		for (const char of "only what is safe") h.key(char);
		const picker = h.app.screen.modal as Picker;
		expect(optionRows(picker).map(option => option.id)).toEqual(["custom"]);
		h.key("\r"); await flush();
		expect(h.sends).toEqual([]);
		expect(h.app.screen.modal).toBeUndefined();
		expect(h.app.screen.prompt.getText()).toBe(`[ask ${q1.id}] answer: only what is safe`);
		// While the human writes, the other question does not pop over the draft.
		h.app.chat.notice("update");
		expect(h.app.screen.modal).toBeUndefined();
		h.app.screen.prompt.setText(""); h.app.chat.notice("idle");
		const next = h.app.screen.modal as Picker;
		expect(next).toBeInstanceOf(Picker);
		expect(next.render(100).join("\n")).toContain("Second");
		// The unsent free-text question stays reachable as Q1, but focus starts on the unseen one.
		expect(next.title).toBe("Question 2 of 2");
	} finally { h.app.stop(); }
});

test("Esc on a tabbed modal suppresses auto-reopen for every shown question", async () => {
	const h = setup();
	try {
		await flush();
		h.emit(ask({ id: "1".repeat(32) })); h.emit(ask({ id: "2".repeat(32) }));
		h.key("\x1b");
		h.app.chat.notice("update");
		expect(h.app.screen.modal).toBeUndefined();
		h.submit("/choose");
		expect((h.app.screen.modal as Picker).title).toBe("Question 1 of 2");
	} finally { h.app.stop(); }
});

test("ask modal layout helpers: tab row, countdown, width that fits the longest choice", async () => {
	const { askTabRow, askCountdown, askOverlayOptions } = await import("../src/tui/app.ts");
	const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
	expect(plain(askTabRow([{ id: "a", number: 1, sent: true }, { id: "b", number: 2, sent: false }, { id: "c", number: 3, sent: false }], "b", 80))).toBe("Q1 sent  [Q2]  Q3");
	expect(plain(askTabRow([{ id: "a", number: 1, sent: false }, { id: "b", number: 2, sent: false }], "a", 5))).toHaveLength(5);
	expect([askCountdown(-5), askCountdown(45_000), askCountdown(12 * 60_000), askCountdown(23 * 3_600_000), askCountdown(3 * 86_400_000)]).toEqual(["0s", "45s", "12m", "23h", "3d"]);
	const size = { cols: 100, rows: 35 };
	const base = askOverlayOptions(size, ["short"]);
	expect(base.width).toBe(62);
	const wide = askOverlayOptions(size, ["설정에서 한 번 opt-in하면 감지 시 묻지 않고 전송 (전송 후 알림 + 취소/삭제 가능)"]);
	expect(wide.width).toBe(98);
	expect(askOverlayOptions({ cols: 60, rows: 24 }, ["x".repeat(200)]).width).toBeLessThanOrEqual(58);
});

test("short terminals drop section headers so the free-text row stays visible", async () => {
	const terminal = new InputTerminal(60, 24);
	const client = { commands: async () => [], commandArguments: async () => [], threadModel: async () => ({ model: "fake/model" }), events: (_c: string, _t: string, _e: unknown, signal: AbortSignal) => new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })), send: async () => {}, runCommand: async () => {} } as unknown as ApiClient;
	const app = new ChatApp(client, { model: { provider: "fake", modelId: "model" }, toolMode: "hybrid" } as Manifest, "main", undefined, undefined, 10000, terminal, { preferences: { load: () => ({ toolsExpanded: false }), save: () => {} } });
	app.start();
	try {
		await flush();
		const value = ask({ options: ["A", "B", "C", "D"], default: "A" });
		app.chat.apply({ type: "tool_execution_end", toolCallId: value.id, toolName: "ask", entry: { id: 1, conversationId: 1, kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: value.id, toolName: "ask", content: [{ type: "text", text: "Q" }], details: { ask: value }, isError: false, timestamp: Date.now() }] } as unknown as EntryRecord });
		const picker = app.screen.modal as Picker;
		expect(picker.entries.every(row => row.kind === "option")).toBe(true);
		expect(picker.render(Number(modalOverlayOptions(app.screen.size()).width)).join("\n")).toContain("Write my own answer");
	} finally { app.stop(); }
});
