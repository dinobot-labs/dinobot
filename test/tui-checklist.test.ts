import { expect, test } from "bun:test";
import { type Terminal, visibleWidth } from "@earendil-works/pi-tui";
import type { CommandArgument, CommandChecklistOption, CommandEvent, CommandInfo, ThreadModelState } from "../src/commands/types.ts";
import type { Manifest } from "../src/manifest.ts";
import { ChatApp } from "../src/tui/app.ts";
import type { ApiClient } from "../src/tui/client.ts";
import { CHECKLIST_HINTS, Picker } from "../src/tui/picker.ts";
import { color, separator } from "../src/tui/theme.ts";

const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m|\x1b_pi:c\x07|\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
const plain = (lines: readonly string[]): string[] => lines.map((line) => strip(line).trimEnd());
const fits = (lines: readonly string[], width: number): void => {
	for (const line of lines) expect(visibleWidth(line), strip(line)).toBe(width);
};
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
/** The SGR prefix `color.gray` opens with. */
const GRAY = color.gray("§").split("§")[0] ?? "";
const SEP = separator.meta;

const SKILLS: readonly CommandChecklistOption[] = [
	{ id: "debugging", label: "debugging", description: "Evidence-first debugging", group: "Bundled", badge: "default", disabled: true, checked: true },
	{ id: "research", label: "research", description: "Bounded investigation", group: "Bundled", badge: "default", disabled: true, checked: true },
	{ id: "alpha-flow", label: "alpha-flow", description: "Alpha workflow", group: "Agent", badge: "~120 tok", checked: true },
	{ id: "beta-flow", label: "beta-flow", description: "Beta workflow", group: "Agent", badge: "~80 tok", checked: false },
	{ id: "owner-notes", label: "owner-notes", description: "Owner notes", group: "User", checked: true },
];
const TITLE = "Skills · 4/5 enabled · ~435 tok · applies to /new";
const SIZE = () => ({ cols: 140, rows: 40 });
const WIDTH = 86;

type Log = { chosen: string[]; cancels: number };
function checklist(options: readonly CommandChecklistOption[] = SKILLS, size = SIZE): { picker: Picker; log: Log } {
	const log: Log = { chosen: [], cancels: 0 };
	return { picker: new Picker(TITLE, options, { onChoose: (value) => log.chosen.push(value), onCancel: () => log.cancels++ }, size, { checklist: true }), log };
}
const rowOf = (lines: readonly string[], label: string): string => plain(lines).find((line) => line.includes(` ${label} `) || line.endsWith(` ${label}`)) ?? "";
const rawRowOf = (lines: readonly string[], label: string): string => lines.find((line) => strip(line).includes(`] ${label}`)) ?? "";
const mouse = (type: "click" | "move", x: number, y: number) => ({ type, button: "left", x, y, screenX: x, screenY: y, width: WIDTH, height: 15, shift: false, alt: false, ctrl: false }) as const;
const indexOf = (picker: Picker, id: string): number => picker.entries.findIndex((entry) => entry.kind === "option" && entry.option.id === id);

test("checklist renders [x]/[ ] marks, group headers, badges, the live checked/total counter, the checklist hints, and locked rows dim", () => {
	const { picker } = checklist();
	const lines = picker.render(WIDTH);
	fits(lines, WIDTH);
	const text = plain(lines);
	expect(text[1]).toContain(TITLE);
	expect(text.find((line) => line.includes("filter:"))).toContain(`4/5 checked${SEP}5 of 5`);
	expect(text.some((line) => line.includes(" Bundled ─"))).toBe(true);
	expect(text.some((line) => line.includes(" Agent ─"))).toBe(true);
	expect(rowOf(lines, "debugging")).toContain("[x] debugging");
	expect(rowOf(lines, "debugging")).toMatch(/Evidence-first debugging\s+default/);
	expect(rowOf(lines, "alpha-flow")).toContain("[x] alpha-flow");
	expect(rowOf(lines, "alpha-flow")).toMatch(/~120 tok\s+\|$/);
	expect(rowOf(lines, "beta-flow")).toContain("[ ] beta-flow");
	expect(rowOf(lines, "owner-notes")).toContain("[x] owner-notes");
	const hints = text.find((line) => line.includes("space toggle")) ?? "";
	for (const hint of CHECKLIST_HINTS) expect(hints).toContain(hint);
	expect(hints).toContain(CHECKLIST_HINTS.join(SEP));
	expect(hints).not.toContain("enter select");
	// Locked rows: mark and label in gray; the first unlocked row is selected.
	expect(rawRowOf(lines, "debugging")).toContain(`${GRAY}[x] `);
	expect(rawRowOf(lines, "debugging")).toContain(`${GRAY}debugging`);
	expect(rawRowOf(lines, "alpha-flow")).not.toContain(`${GRAY}[x] `);
	expect(picker.selected?.id).toBe("alpha-flow");
	expect(picker.checked).toEqual(["debugging", "research", "alpha-flow", "owner-notes"]);
});

test("checklist: space toggles the selected row, keeps the selection and filter, and updates the counter; the keys walk onto locked rows but never toggle them", () => {
	const { picker, log } = checklist();
	picker.handleInput(" ");
	expect(picker.checked).toEqual(["debugging", "research", "owner-notes"]);
	expect(picker.selected?.id).toBe("alpha-flow");
	let lines = picker.render(WIDTH);
	expect(rowOf(lines, "alpha-flow")).toContain("[ ] alpha-flow");
	expect(plain(lines).find((line) => line.includes("filter:"))).toContain("3/5 checked");
	picker.handleInput("\x1b[B");
	expect(picker.selected?.id).toBe("beta-flow");
	picker.handleInput(" ");
	expect(picker.checked).toEqual(["debugging", "research", "beta-flow", "owner-notes"]);
	// Up past the first unlocked row lands on the locked rows (skipping group headers); space there changes nothing.
	picker.handleInput("\x1b[A");
	expect(picker.selected?.id).toBe("alpha-flow");
	picker.handleInput("\x1b[A");
	expect(picker.selected?.id).toBe("research");
	picker.handleInput(" ");
	for (let step = 0; step < 5; step++) picker.handleInput("\x1b[A");
	expect(picker.selected?.id).toBe("debugging");
	picker.handleInput(" ");
	picker.handleInput("\x1b[F");
	expect(picker.selected?.id).toBe("owner-notes");
	picker.handleInput("\x1b[H");
	expect(picker.selected?.id).toBe("debugging");
	lines = picker.render(WIDTH);
	expect(rowOf(lines, "beta-flow")).toContain("[x] beta-flow");
	expect(rowOf(lines, "debugging")).toContain("[x] debugging");
	expect(log).toEqual({ chosen: [], cancels: 0 });
});

/** /setup's channel step: one unlocked row among locked ones. ↑↓ must still move, or the window looks frozen. */
const SETUP_CHANNELS: readonly CommandChecklistOption[] = [
	{ id: "tui", label: "Terminal", tag: "always on", checked: true, disabled: true },
	{ id: "telegram", label: "Telegram", description: "Chat with dinobot from your phone", checked: false },
	{ id: "slack", label: "Slack", description: "Configure in dinobot.yaml", checked: false, disabled: true },
	{ id: "discord", label: "Discord", description: "Configure in dinobot.yaml", checked: false, disabled: true },
];

test("checklist with a single unlocked row: ↑↓ and PgUp/PgDn move across every row; only the unlocked row toggles", () => {
	const { picker, log } = checklist(SETUP_CHANNELS);
	expect(picker.selected?.id).toBe("telegram");
	const walk: (string | undefined)[] = [];
	for (const key of ["\x1b[B", "\x1b[B", "\x1b[B", "\x1b[A", "\x1b[A", "\x1b[A", "\x1b[A"]) {
		picker.handleInput(key);
		walk.push(picker.selected?.id);
	}
	expect(walk).toEqual(["slack", "discord", "discord", "slack", "telegram", "tui", "tui"]);
	expect(rowOf(picker.render(WIDTH), "Terminal")).toContain("[x] Terminal");
	picker.handleInput(" ");
	picker.handleInput("\x1b[6~");
	expect(picker.selected?.id).toBe("discord");
	picker.handleInput(" ");
	picker.handleInput("\x1b[5~");
	expect(picker.selected?.id).toBe("tui");
	expect(picker.checked).toEqual(["tui"]);
	picker.handleInput("\x1b[B");
	picker.handleInput(" ");
	expect(picker.checked).toEqual(["tui", "telegram"]);
	picker.handleInput("\r");
	expect(log.chosen).toEqual([JSON.stringify(["tui", "telegram"])]);
});

test("checklist: enter applies with the JSON array of checked ids in option order, locked checked ids included; esc cancels", () => {
	const { picker, log } = checklist();
	picker.handleInput(" ");
	picker.handleInput("\x1b[B");
	picker.handleInput(" ");
	picker.handleInput("\r");
	expect(log.chosen).toEqual([JSON.stringify(["debugging", "research", "beta-flow", "owner-notes"])]);
	expect(JSON.parse(log.chosen[0] ?? "")).toEqual(["debugging", "research", "beta-flow", "owner-notes"]);
	const other = checklist();
	other.picker.handleInput("\x1b");
	expect(other.log).toEqual({ chosen: [], cancels: 1 });
	// Unchanged state applies the initial checks; everything locked still applies.
	const untouched = checklist();
	untouched.picker.handleInput("\r");
	expect(untouched.log.chosen).toEqual([JSON.stringify(["debugging", "research", "alpha-flow", "owner-notes"])]);
	const locked = checklist(SKILLS.filter((option) => option.disabled === true));
	expect(locked.picker.selected).toBeUndefined();
	locked.picker.handleInput(" ");
	locked.picker.handleInput("\r");
	expect(locked.log.chosen).toEqual([JSON.stringify(["debugging", "research"])]);
});

test("checklist: typing filters, a typed space toggles instead of entering the filter, a paste only filters, and toggles survive filter changes", () => {
	const { picker, log } = checklist();
	for (const char of "beta") picker.handleInput(char);
	expect(picker.filter).toBe("beta");
	expect(picker.selected?.id).toBe("beta-flow");
	expect(plain(picker.render(WIDTH)).find((line) => line.includes("filter:"))).toContain(`4/5 checked${SEP}1 of 5`);
	picker.handleInput(" ");
	expect(picker.filter).toBe("beta");
	expect(picker.checked).toContain("beta-flow");
	expect(picker.selected?.id).toBe("beta-flow");
	expect(rowOf(picker.render(WIDTH), "beta-flow")).toContain("[x] beta-flow");
	// A fast-typed run "w " (one chunk) filters on "w" and toggles the selection, never adding the space.
	picker.handleInput("\x15");
	expect(picker.filter).toBe("");
	picker.handleInput("own ");
	expect(picker.filter).toBe("own");
	expect(picker.checked).not.toContain("owner-notes");
	picker.handleInput("\x15");
	picker.handleInput("\x1b[200~alpha flow\x1b[201~");
	expect(picker.filter).toBe("alphaflow");
	expect(picker.checked).toContain("alpha-flow");
	// Clearing the filter keeps every toggle.
	picker.handleInput("\x15");
	picker.handleInput("\r");
	expect(log.chosen).toEqual([JSON.stringify(["debugging", "research", "alpha-flow", "beta-flow"])]);
});

test("checklist: a mouse click toggles the row under it without applying; clicks on locked rows do nothing; [x] and outside clicks cancel", () => {
	const { picker, log } = checklist();
	picker.render(WIDTH);
	const { listTop } = picker.geometry;
	picker.handleMouse(mouse("click", 10, listTop + indexOf(picker, "beta-flow")));
	expect(picker.checked).toContain("beta-flow");
	expect(picker.selected?.id).toBe("beta-flow");
	expect(rowOf(picker.render(WIDTH), "beta-flow")).toContain("[x] beta-flow");
	picker.handleMouse(mouse("click", 10, listTop + indexOf(picker, "beta-flow")));
	expect(picker.checked).not.toContain("beta-flow");
	picker.handleMouse(mouse("click", 10, listTop + indexOf(picker, "debugging")));
	expect(picker.checked).toContain("debugging");
	expect(picker.selected?.id).toBe("beta-flow");
	expect(log).toEqual({ chosen: [], cancels: 0 });
	const width = picker.geometry.width - 2;
	picker.handleMouse(mouse("click", 1 + width - 5, 1));
	expect(log.cancels).toBe(1);
	picker.handleMouse(mouse("click", 0, 0));
	expect(log.cancels).toBe(2);
	expect(log.chosen).toEqual([]);
});

/** Every overlay width from 4 up, with any terminal height, renders every line at exactly the overlay width: below 10 columns the top border drops the [✗] button (and its hit area) instead of overflowing. */
test("checklist: narrow and short terminals render every line at exactly the overlay width for every width 4..40, with a scrollbar when rows overflow", () => {
	const many: CommandChecklistOption[] = Array.from({ length: 30 }, (_, index) => ({ id: `skill-${index}`, label: `skill-${index}`, description: "a long description that will not fit in a narrow window", group: index < 3 ? "Bundled" : "Agent", disabled: index < 3, checked: index % 2 === 0, badge: `~${index * 10} tok` }));
	for (let cols = 4; cols <= 40; cols++) {
		for (const rows of [4, 6, 8, 12, 20]) {
			const { picker } = checklist(many, () => ({ cols, rows }));
			fits(picker.render(cols), cols);
			picker.handleInput(" ");
			picker.handleInput("\x1b[F");
			picker.handleInput(" ");
			picker.handleInput("skill-2");
			fits(picker.render(cols), cols);
		}
	}
	const { picker } = checklist(many, () => ({ cols: 60, rows: 20 }));
	picker.render(60);
	expect(picker.geometry.scrollbarX).toBeDefined();
});

test("checklist: below 10 overlay columns the top border is a plain rule without [x] (clicks on it do nothing); from 10 columns the button is back", () => {
	for (let cols = 4; cols <= 12; cols++) {
		const { picker, log } = checklist(SKILLS, () => ({ cols, rows: 20 }));
		const top = strip(picker.render(cols)[1] ?? "");
		if (cols < 10) {
			expect(top).toBe(` +${"-".repeat(cols - 4)}+ `);
			for (let x = 0; x < cols; x++) picker.handleMouse({ ...mouse("click", x, 1), width: cols, height: 20 });
			expect(log.cancels).toBe(2);
		} else expect(top).toContain("[x]");
	}
});

class StubTerminal implements Terminal {
	onInput: ((data: string) => void) | undefined;
	constructor(
		readonly columns: number,
		readonly rows: number,
	) {}
	start(onInput: (data: string) => void): void {
		this.onInput = onInput;
	}
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

type Answer = { value: string } | { cancel: true };
type RunContext = { readonly emit: (event: CommandEvent) => void; readonly answer: () => Promise<Answer> };

/** Enough of ApiClient for ChatApp: one scripted /skills run that waits for the checklist answer. */
class FakeClient {
	readonly answers: { runId: string; promptId: string; answer: Answer }[] = [];
	finished: Promise<void> = Promise.resolve();
	private pending: ((answer: Answer) => void) | undefined;

	async commands(): Promise<CommandInfo[]> {
		return [{ name: "skills", description: "Enable or disable skills", usage: "[list|on|off] [name]" }];
	}
	async commandArguments(): Promise<CommandArgument[]> {
		return [];
	}
	async threads(): Promise<{ key: string; conversationId: number }[]> {
		return [{ key: "tui:main", conversationId: 1 }];
	}
	async threadModel(): Promise<ThreadModelState> {
		return { model: "faux/faux-1", thinkingLevel: "off", supportedThinkingLevels: ["off"], fast: false, fastSupported: false };
	}
	events(_channel: string, _thread: string, _onEvent: unknown, signal: AbortSignal): Promise<void> {
		return new Promise((resolve) => signal.addEventListener("abort", () => resolve()));
	}
	async send(): Promise<void> {}
	async abort(): Promise<void> {}
	runCommand(_channel: string, _thread: string, _name: string, _args: string, _userId: string, onEvent: (event: CommandEvent) => void, signal: AbortSignal): Promise<void> {
		const answer = (): Promise<Answer> =>
			new Promise((resolve) => {
				this.pending = resolve;
				signal.addEventListener("abort", () => resolve({ cancel: true }), { once: true });
			});
		this.finished = new Promise<void>((resolve, reject) => {
			signal.addEventListener("abort", () => resolve(), { once: true });
			void skillsRun({ emit: onEvent, answer }).then(resolve, reject);
		});
		return this.finished;
	}
	async answerPrompt(runId: string, promptId: string, answer: Answer): Promise<void> {
		this.answers.push({ runId, promptId, answer });
		const pending = this.pending;
		this.pending = undefined;
		pending?.(answer);
	}
}

const skillsRun = async ({ emit, answer }: RunContext): Promise<void> => {
	emit({ type: "started", runId: "run-s" });
	emit({ type: "prompt", id: "p-s", prompt: { type: "checklist", message: TITLE, options: SKILLS } });
	const chosen = await answer();
	if ("cancel" in chosen) return;
	emit({ type: "output", text: `applied ${chosen.value}`, level: "success" });
	emit({ type: "done" });
};

const manifest = { model: { provider: "faux", modelId: "faux-1" }, toolMode: "direct" } as unknown as Manifest;

function start(): { chat: ChatApp; terminal: StubTerminal; client: FakeClient } {
	const client = new FakeClient();
	const terminal = new StubTerminal(140, 40);
	const chat = new ChatApp(client as unknown as ApiClient, manifest, "main", undefined, undefined, 200_000, terminal, { open: () => undefined, copy: () => undefined });
	chat.start();
	return { chat, terminal, client };
}
const submit = (chat: ChatApp, terminal: StubTerminal, text: string): void => {
	for (const char of text) chat.screen.prompt.handleInput(char);
	terminal.onInput?.("\r");
};
const click = (terminal: StubTerminal, col: number, row: number): void => {
	terminal.onInput?.(`\x1b[<0;${col + 1};${row + 1}M`);
	terminal.onInput?.(`\x1b[<0;${col + 1};${row + 1}m`);
};

test("app: a checklist prompt opens the picker modal (never the prompt box); space, a mouse click and enter answer with the JSON array of checked ids", async () => {
	const { chat, terminal, client } = start();
	await flush();
	submit(chat, terminal, "/skills");
	await flush();
	const modal = chat.screen.modal as Picker;
	expect(modal).toBeInstanceOf(Picker);
	expect(modal.title).toBe(TITLE);
	expect(chat.screen.prompt.answer).toBeUndefined();
	expect(chat.screen.tui.getFocusedComponent()).toBe(modal);
	chat.screen.tui.renderNow();
	terminal.onInput?.(" ");
	expect(modal.checked).not.toContain("alpha-flow");
	const bounds = chat.screen.modalBounds();
	click(terminal, (bounds?.col ?? 0) + 10, (bounds?.row ?? 0) + modal.geometry.listTop + indexOf(modal, "beta-flow"));
	await flush();
	expect(modal.checked).toContain("beta-flow");
	expect(client.answers).toEqual([]);
	terminal.onInput?.("\r");
	await flush();
	expect(client.answers).toEqual([{ runId: "run-s", promptId: "p-s", answer: { value: JSON.stringify(["debugging", "research", "beta-flow", "owner-notes"]) } }]);
	await client.finished;
	await flush();
	expect(chat.screen.modal).toBeUndefined();
	expect(chat.screen.tui.getFocusedComponent()).toBe(chat.screen.prompt);
	const notices = chat.chat.data.blocks.flatMap((block) => (block.kind === "notice" ? [strip(block.text)] : []));
	expect(notices.at(-1)).toBe(`applied ${JSON.stringify(["debugging", "research", "beta-flow", "owner-notes"])}`);
	chat.screen.stop();
});

test("app: ↑↓ typed into the terminal move the checklist selection, locked rows included", async () => {
	const { chat, terminal, client } = start();
	await flush();
	submit(chat, terminal, "/skills");
	await flush();
	const modal = chat.screen.modal as Picker;
	expect(modal).toBeInstanceOf(Picker);
	chat.screen.tui.renderNow();
	expect(modal.selected?.id).toBe("alpha-flow");
	terminal.onInput?.("\x1b[B");
	expect(modal.selected?.id).toBe("beta-flow");
	terminal.onInput?.("\x1b[A");
	terminal.onInput?.("\x1b[A");
	expect(modal.selected?.id).toBe("research");
	terminal.onInput?.(" ");
	expect(modal.checked).toEqual(["debugging", "research", "alpha-flow", "owner-notes"]);
	terminal.onInput?.("\x1b");
	await new Promise((resolve) => setTimeout(resolve, 80));
	await flush();
	expect(client.answers).toEqual([{ runId: "run-s", promptId: "p-s", answer: { cancel: true } }]);
	chat.screen.stop();
});

test("app: esc on the checklist cancels the prompt, closes the modal and sends no value", async () => {
	const { chat, terminal, client } = start();
	await flush();
	submit(chat, terminal, "/skills");
	await flush();
	expect(chat.screen.modal).toBeInstanceOf(Picker);
	chat.screen.tui.renderNow();
	terminal.onInput?.(" ");
	terminal.onInput?.("\x1b");
	await new Promise((resolve) => setTimeout(resolve, 80));
	await flush();
	expect(client.answers).toEqual([{ runId: "run-s", promptId: "p-s", answer: { cancel: true } }]);
	await client.finished;
	expect(chat.screen.modal).toBeUndefined();
	expect(chat.screen.tui.getFocusedComponent()).toBe(chat.screen.prompt);
	chat.screen.stop();
});
