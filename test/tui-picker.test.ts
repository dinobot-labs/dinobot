import { expect, test } from "bun:test";
import { type Terminal, visibleWidth } from "@earendil-works/pi-tui";
import type { CommandArgument, CommandEvent, CommandInfo, CommandSelectOption, ThreadModelState } from "../src/commands/types.ts";
import type { Manifest } from "../src/manifest.ts";
import { ChatApp } from "../src/tui/app.ts";
import type { ApiClient } from "../src/tui/client.ts";
import { LoginCard } from "../src/tui/login-card.ts";
import { modalOverlayOptions, modalWindowSize } from "../src/tui/modal.ts";
import { Picker } from "../src/tui/picker.ts";
import { ansi, color, paint } from "../src/tui/theme.ts";

const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m|\x1b_pi:c\x07|\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
const plain = (lines: readonly string[]): string[] => lines.map((line) => strip(line).trimEnd());
const fits = (lines: readonly string[], width: number): void => {
	for (const line of lines) expect(visibleWidth(line), strip(line)).toBe(width);
};
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const BG_VISUAL = color.bgVisual("  ");
const BG_HOVER = ansi.bg("bgHover");
const rule = (count: number): string => "-".repeat(Math.max(0, count));
const sectionRule = (count: number): string => "─".repeat(Math.max(0, count));
const row = (body: string, width: number): string => `|  ${body.padEnd(width - 6)}  |`;
const top = (title: string, width: number): string => `+- ${title} ${rule(width - title.length - 11)} [x] -+`;
const bottom = (width: number): string => `+${rule(width - 2)}+`;
const divider = (width: number): string => `|${rule(width - 2)}|`;
const centered = (text: string, width: number): string => row(" ".repeat(Math.floor((width - 6 - text.length) / 2)) + text, width);
/** The window inside the modal's one-cell blank margin: checks the blank rows above and below and the blank left column, then drops them (the right one is trimmed). */
const framed = (lines: readonly string[]): string[] => {
	const text = plain(lines);
	expect([text[0], text.at(-1)]).toEqual(["", ""]);
	for (const line of text.slice(1, -1)) expect(line[0]).toBe(" ");
	return text.slice(1, -1).map((line) => line.slice(1));
};

const MODELS: readonly CommandSelectOption[] = [
	{ id: "faux/faux-1", label: "Faux 1", description: "faux/faux-1", group: "Faux", current: true },
	{ id: "faux/faux-2", label: "Faux 2", description: "faux/faux-2", group: "Faux" },
	{ id: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4", description: "anthropic/claude-sonnet-4", group: "Anthropic" },
	{ id: "anthropic/claude-opus-4", label: "Claude Opus 4", description: "anthropic/claude-opus-4", group: "Anthropic", badge: "logged in" },
];
const CHAT = "Chat providers";
const LOGIN_ONLY = "Login only (no chat transport yet)";
const NO_TRANSPORT = "no model transport in this build";
const PROVIDERS: readonly CommandSelectOption[] = [
	{ id: "opencode-zen", label: "OpenCode Zen", group: CHAT },
	{ id: "anthropic", label: "Anthropic", group: CHAT, badge: "logged in" },
	{ id: "openai", label: "OpenAI", group: CHAT },
	{ id: "github-copilot", label: "GitHub Copilot", group: CHAT },
	{ id: "google", label: "Google", group: CHAT },
	{ id: "xai", label: "xAI", group: CHAT },
	{ id: "mistral", label: "Mistral", group: CHAT },
	{ id: "groq", label: "Groq", group: CHAT },
	...["Vercel", "Supabase", "Netlify", "Linear", "Notion", "Figma", "Sentry", "Render"].map((label) => ({ id: label.toLowerCase(), label, group: LOGIN_ONLY, description: NO_TRANSPORT })),
];
const SIZE = () => ({ cols: 140, rows: 40 });
const NARROW = () => ({ cols: 80, rows: 30 });
const PICKER_HINTS = "↑↓ navigate · enter select · esc close · type to filter";

type Chosen = { chosen: string[]; cancels: number };
function picker(options: readonly CommandSelectOption[], size = SIZE, title = "Choose a model"): { picker: Picker; log: Chosen } {
	const log: Chosen = { chosen: [], cancels: 0 };
	return { picker: new Picker(title, options, { onChoose: (id) => log.chosen.push(id), onCancel: () => log.cancels++ }, size), log };
}
const mouse = (type: "click" | "move" | "wheel", x: number, y: number, wheelDelta?: number) =>
	({ type, button: type === "wheel" ? "none" : "left", x, y, screenX: x, screenY: y, width: 86, height: 15, shift: false, alt: false, ctrl: false, ...(wheelDelta === undefined ? {} : { wheelDelta }) }) as const;

test("picker at 140x40: an 84-column window inside a one-cell blank margin, with the title on the border, filter row with the count, section headers, ● + current tag on the current row, a badge at the right edge and the key hints", () => {
	expect(modalWindowSize({ cols: 140, rows: 40 })).toEqual({ width: 84, height: 32 });
	expect(modalOverlayOptions({ cols: 140, rows: 40 })).toEqual({ anchor: "center", width: 86, maxHeight: 34 });
	const { picker: modal } = picker(MODELS);
	const lines = modal.render(86);
	fits(lines, 86);
	const label = (name: string): string => name.padEnd(15);
	expect(framed(lines)).toEqual([
		top("Choose a model", 84),
		row("", 84),
		row(` filter:  type to filter${" ".repeat(48)}4 of 4`, 84),
		divider(84),
		row(` Faux ${sectionRule(72)}`, 84),
		row(`> ${label("Faux 1")}  faux/faux-1${" ".repeat(41)}current`, 84),
		row(`  ${label("Faux 2")}  faux/faux-2`, 84),
		row(` Anthropic ${sectionRule(67)}`, 84),
		row(`  ${label("Claude Sonnet 4")}  anthropic/claude-sonnet-4`, 84),
		row(`  ${label("Claude Opus 4")}  anthropic/claude-opus-4${" ".repeat(27)}logged in`, 84),
		row("", 84),
		centered(PICKER_HINTS.replaceAll(" · ", " - "), 84),
		bottom(84),
	]);
	expect(lines[0]).toBe(paint("", 86));
	expect(modal.selected?.id).toBe("faux/faux-1");
	expect(lines[6]).toContain(ansi.bg("bgVisual"));
	expect(lines[7]).not.toContain(ansi.bg("bgVisual"));
	expect(lines[6]).toContain(color.currentMark("> "));
	expect(lines[10]).toContain(color.badge("logged in"));
	expect(modal.geometry).toEqual({ width: 86, height: 15, listTop: 5, listHeight: 6, scrollbarX: undefined });
});

test("picker: typing filters on label, then id + group, with the best hit selected and the headers kept; clearing returns to the current row unless the user moved the selection; no match shows a placeholder", () => {
	const { picker: modal } = picker(MODELS);
	for (const char of "opus") modal.handleInput(char);
	expect(modal.filter).toBe("opus");
	expect(modal.entries.map((entry) => (entry.kind === "header" ? `# ${entry.label}` : entry.option.label))).toEqual(["# Anthropic", "Claude Sonnet 4", "Claude Opus 4"]);
	expect(modal.selected?.id).toBe("anthropic/claude-opus-4");
	expect(framed(modal.render(86))[2]).toBe(row(` filter: opus ${" ".repeat(58)}2 of 4`, 84));
	for (let index = 0; index < 4; index++) modal.handleInput("\x7f");
	expect(modal.filter).toBe("");
	expect(modal.selected?.id).toBe("faux/faux-1");
	for (const char of "claude") modal.handleInput(char);
	expect(modal.selected?.id).toBe("anthropic/claude-opus-4");
	modal.handleInput("\x1b[A");
	expect(modal.selected?.id).toBe("anthropic/claude-sonnet-4");
	modal.handleInput("\x15");
	expect(modal.selected?.id).toBe("anthropic/claude-sonnet-4");
	for (const char of "faux") modal.handleInput(char);
	expect(modal.selected?.id).toBe("faux/faux-1");
	modal.handleInput("\x15");
	for (const char of "faux-2") modal.handleInput(char);
	expect(modal.entries.map((entry) => (entry.kind === "header" ? `# ${entry.label}` : entry.option.id))).toEqual(["# Faux", "faux/faux-2"]);
	expect(modal.selected?.id).toBe("faux/faux-2");
	modal.handleInput("\x15");
	expect(modal.filter).toBe("");
	for (const char of "zzz") modal.handleInput(char);
	expect(modal.entries).toEqual([]);
	expect(framed(modal.render(86)).slice(2, 5)).toEqual([row(` filter: zzz ${" ".repeat(59)}0 of 4`, 84), divider(84), row("No matches", 84)]);
	modal.handleInput("\r");
	modal.handleInput("\x1b[200~faux\x1b[201~");
	expect(modal.filter).toBe("zzzfaux");
	modal.handleInput("\x7f\x7f\x7f\x7f\x7f\x7f\x7f");
	expect(modal.filter).toBe("");
	expect(modal.selected?.id).toBe("faux/faux-1");
});

test("picker: Down and Up skip the section headers and stop at the ends, Home/End and PgUp/PgDn jump, Enter chooses the selection, Esc cancels", () => {
	const { picker: modal, log } = picker(MODELS);
	modal.handleInput("\x1b[B");
	expect(modal.selected?.id).toBe("faux/faux-2");
	modal.handleInput("\x1b[B");
	expect(modal.selected?.id).toBe("anthropic/claude-sonnet-4");
	modal.handleInput("\x1b[B");
	modal.handleInput("\x1b[B");
	expect(modal.selected?.id).toBe("anthropic/claude-opus-4");
	modal.handleInput("\x1b[A");
	modal.handleInput("\x1b[A");
	expect(modal.selected?.id).toBe("faux/faux-2");
	modal.handleInput("\x1b[H");
	expect(modal.selected?.id).toBe("faux/faux-1");
	modal.handleInput("\x1b[A");
	expect(modal.selected?.id).toBe("faux/faux-1");
	modal.handleInput("\x1b[F");
	expect(modal.selected?.id).toBe("anthropic/claude-opus-4");
	modal.handleInput("\x1b[5~");
	expect(modal.selected?.id).toBe("faux/faux-1");
	modal.handleInput("\x1b[6~");
	expect(modal.selected?.id).toBe("anthropic/claude-opus-4");
	modal.handleInput("\r");
	expect(log.chosen).toEqual(["anthropic/claude-opus-4"]);
	modal.handleInput("\x1b");
	expect(log.cancels).toBe(1);
});

test("picker: the mouse hovers rows with a hover band, a left click chooses the row under it, a click outside the window (its blank margin included) or on [x] cancels; at 80x30 a 48-column window scrolls 16 providers by wheel and scrollbar", () => {
	const { picker: modal, log } = picker(MODELS);
	modal.render(86);
	expect(modal.handleMouse(mouse("move", 11, 7))).toEqual({ handled: true, render: true });
	expect(modal.hovered?.id).toBe("faux/faux-2");
	expect(modal.render(86)[7]).toContain(BG_HOVER);
	expect(modal.handleMouse(mouse("move", 11, 5))?.render).toBe(true);
	expect(modal.hovered).toBeUndefined();
	modal.handleMouse(mouse("click", 11, 9));
	expect(log.chosen).toEqual(["anthropic/claude-sonnet-4"]);
	modal.handleMouse(mouse("click", 11, 5));
	expect(log.chosen).toHaveLength(1);
	modal.handleMouse(mouse("click", -27, -5));
	expect(log.cancels).toBe(1);
	modal.handleMouse(mouse("click", 1 + 84 - 5, 1));
	expect(log.cancels).toBe(2);
	modal.handleMouse(mouse("click", 0, 7));
	expect(log.cancels).toBe(3);

	const { picker: long, log: longLog } = picker(PROVIDERS, NARROW, "Log in to a provider");
	expect(modalWindowSize({ cols: 80, rows: 30 })).toEqual({ width: 48, height: 22 });
	expect(modalOverlayOptions({ cols: 80, rows: 30 })).toEqual({ anchor: "center", width: 50, maxHeight: 24 });
	const lines = long.render(50);
	fits(lines, 50);
	expect(lines).toHaveLength(24);
	expect(long.geometry).toEqual({ width: 50, height: 24, listTop: 5, listHeight: 15, scrollbarX: 45 });
	const text = framed(lines);
	const listRow = (body: string, thumb: " " | "█"): string => row(`${body.padEnd(40)} ${thumb}`, 48);
	const label = (name: string): string => `  ${name.padEnd(14)}`;
	const described = (name: string): string => `  ${name.padEnd(8)}`;
	expect(text[0]).toBe(top("Log in to a provider", 48));
	expect(text[2]).toBe(row(` filter:  type to filter${" ".repeat(10)}16 of 16`, 48));
	expect(text[4]).toBe(listRow(` ${CHAT} ${sectionRule(24)}`, "█"));
	expect(text[5]).toBe(listRow(label("OpenCode Zen"), "█"));
	expect(text[6]).toBe(listRow(`${label("Anthropic")}${" ".repeat(15)}logged in`, "█"));
	expect(text[13]).toBe(listRow(` ${LOGIN_ONLY} ${sectionRule(4)}`, "█"));
	expect(text[14]).toBe(listRow(`${described("Vercel")}  ${NO_TRANSPORT.slice(0, 25)}...`, "█"));
	expect(text[16]).toBe(listRow(`${described("Netlify")}  ${NO_TRANSPORT.slice(0, 25)}...`, " "));
	expect(text[18]).toBe(listRow(`${described("Notion")}  ${NO_TRANSPORT.slice(0, 25)}...`, " "));
	expect(long.scrollTop).toBe(0);
	long.handleMouse({ ...mouse("wheel", 11, 11, 3), width: 50, height: 24 });
	expect(long.scrollTop).toBe(3);
	expect(framed(long.render(50))[4]).toBe(listRow(label("OpenAI"), " "));
	long.handleMouse({ ...mouse("wheel", 11, 11, -10), width: 50, height: 24 });
	expect(long.scrollTop).toBe(0);
	long.handleMouse({ ...mouse("click", 45, 19), width: 50, height: 24 });
	expect(long.scrollTop).toBe(3);
	long.handleInput("\x1b[F");
	expect(long.scrollTop).toBe(3);
	expect(long.selected?.id).toBe("render");
	long.handleMouse({ ...mouse("click", 11, 5 + 14), width: 50, height: 24 });
	expect(longLog.chosen).toEqual(["render"]);

	const { picker: mixed } = picker(
		[
			{ id: "codex", label: "ChatGPT Plus/Pro (Codex Subscription)", group: CHAT },
			{ id: "lmstudio", label: "LM Studio (Local OpenAI-compatible)", group: LOGIN_ONLY, description: NO_TRANSPORT },
		],
		NARROW,
		"Log in to a provider",
	);
	expect(framed(mixed.render(50)).slice(4, 8)).toEqual([
		row(` ${CHAT} ${sectionRule(26)}`, 48),
		row("  ChatGPT Plus/Pro (Codex Subscription)", 48),
		row(` ${LOGIN_ONLY} ${sectionRule(6)}`, 48),
		row(`  ${"LM Studio (Local OpenAI-compatible)".slice(0, 22)}...  ${NO_TRANSPORT.slice(0, 10)}...`, 48),
	]);
});

test("picker: every overlay width 4..40 at any height renders every line at exactly the overlay width, also after filtering and scrolling", () => {
	for (let cols = 4; cols <= 40; cols++) {
		for (const rows of [4, 6, 8, 12, 30]) {
			const { picker: modal } = picker(PROVIDERS, () => ({ cols, rows }), "Choose a provider to log in");
			fits(modal.render(cols), cols);
			modal.handleInput("\x1b[F");
			fits(modal.render(cols), cols);
			modal.handleInput("open");
			fits(modal.render(cols), cols);
		}
	}
});

test("picker: a disabled row (a thread model that is no longer available) is drawn dim, never selected, and skipped by the keys and the mouse", () => {
	const options: readonly CommandSelectOption[] = [
		{ id: "gone/old-1", label: "old-1", description: "not available; log in to gone first", group: "gone", current: true, disabled: true },
		{ id: "faux/faux-1", label: "Faux 1", description: "faux/faux-1", group: "Faux" },
		{ id: "faux/faux-2", label: "Faux 2", description: "faux/faux-2", group: "Faux" },
	];
	const { picker: modal, log } = picker(options);
	expect(modal.selected?.id).toBe("faux/faux-1");
	const lines = modal.render(86);
	expect(framed(lines)[5]).toBe(row(`> old-1   not available; log in to gone first${" ".repeat(26)}current`, 84));
	expect(lines[6]).toContain(color.gray("old-1"));
	expect(lines[6]).toContain(color.gray("> "));
	expect(lines[6]).not.toContain(BG_VISUAL);
	expect(lines[8]).toContain(ansi.bg("bgVisual"));
	modal.handleInput("\x1b[A");
	expect(modal.selected?.id).toBe("faux/faux-1");
	modal.handleInput("\x1b[F");
	modal.handleInput("\x1b[5~");
	expect(modal.selected?.id).toBe("faux/faux-1");
	modal.handleInput("\x1b[H");
	expect(modal.selected?.id).toBe("faux/faux-1");
	expect(modal.handleMouse(mouse("move", 11, 6))).toEqual({ handled: true, render: false });
	expect(modal.hovered).toBeUndefined();
	modal.handleMouse(mouse("click", 11, 6));
	expect(log.chosen).toEqual([]);
	for (const char of "old") modal.handleInput(char);
	expect(framed(modal.render(86))[2]).toBe(row(` filter: old ${" ".repeat(59)}1 of 3`, 84));
	expect(modal.selected).toBeUndefined();
	modal.handleInput("\r");
	expect(log.chosen).toEqual([]);
});

class StubTerminal implements Terminal {
	onInput: ((data: string) => void) | undefined;
	readonly writes: string[] = [];
	constructor(
		readonly columns: number,
		readonly rows: number,
	) {}
	start(onInput: (data: string) => void): void {
		this.onInput = onInput;
	}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.writes.push(data);
	}
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

const SERVER_COMMANDS: readonly CommandInfo[] = [
	{ name: "login", description: "Log in to a model provider", usage: "[provider]" },
	{ name: "model", description: "Show or switch this thread's model", usage: "[provider/modelId]" },
];
const AUTH_URL = "https://auth.example.com/oauth/authorize?client_id=dinobot&state=abc123";
type Answer = { value: string } | { cancel: true };
type RunContext = { readonly args: string; readonly emit: (event: CommandEvent) => void; readonly signal: AbortSignal; readonly answer: () => Promise<Answer> };

/** Enough of ApiClient for ChatApp: scripted command runs that wait for prompt answers, and a record of what the TUI sent. */
class FakeClient {
	readonly log: string[] = [];
	readonly answers: { runId: string; promptId: string; answer: Answer }[] = [];
	readonly runs: Record<string, (run: RunContext) => Promise<void>> = {};
	finished: Promise<void> = Promise.resolve();
	private pending: ((answer: Answer) => void) | undefined;

	async commands(): Promise<CommandInfo[]> {
		return [...SERVER_COMMANDS];
	}
	async commandArguments(name: string, channel: string, thread: string): Promise<CommandArgument[]> {
		this.log.push(`arguments ${name} ${channel} ${thread}`);
		return name === "login" ? PROVIDERS.map(({ id, ...rest }) => ({ value: id, ...rest })) : [];
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
	runCommand(_channel: string, _thread: string, name: string, args: string, _userId: string, onEvent: (event: CommandEvent) => void, signal: AbortSignal): Promise<void> {
		this.log.push(`run ${name} ${JSON.stringify(args)}`);
		const handler = this.runs[name] as (run: RunContext) => Promise<void>;
		const answer = (): Promise<Answer> =>
			new Promise((resolve) => {
				this.pending = resolve;
				signal.addEventListener("abort", () => resolve({ cancel: true }), { once: true });
			});
		this.finished = new Promise<void>((resolve, reject) => {
			signal.addEventListener("abort", () => resolve(), { once: true });
			void handler({ args, emit: onEvent, signal, answer }).then(resolve, reject);
		});
		return this.finished;
	}
	/** Set to refuse prompt answers the way a failed HTTP request does. */
	failAnswers: Error | undefined = undefined;
	async answerPrompt(runId: string, promptId: string, answer: Answer): Promise<void> {
		this.answers.push({ runId, promptId, answer });
		if (this.failAnswers !== undefined) throw this.failAnswers;
		const pending = this.pending;
		this.pending = undefined;
		pending?.(answer);
	}
}

const manifest = { model: { provider: "faux", modelId: "faux-1" }, toolMode: "direct" } as unknown as Manifest;

function app(client: FakeClient, cols = 140, rows = 40): { app: ChatApp; terminal: StubTerminal; opened: string[]; copied: string[] } {
	const terminal = new StubTerminal(cols, rows);
	const opened: string[] = [];
	const copied: string[] = [];
	const chat = new ChatApp(client as unknown as ApiClient, manifest, "main", undefined, undefined, 200_000, terminal, { open: (url) => opened.push(url), copy: (text) => copied.push(text) });
	chat.start();
	return { app: chat, terminal, opened, copied };
}
const submit = (chat: ChatApp, terminal: StubTerminal, text: string): void => {
	for (const char of text) chat.screen.prompt.handleInput(char);
	terminal.onInput?.("\r");
};
const click = (terminal: StubTerminal, col: number, row: number): void => {
	terminal.onInput?.(`\x1b[<0;${col + 1};${row + 1}M`);
	terminal.onInput?.(`\x1b[<0;${col + 1};${row + 1}m`);
};
const notices = (chat: ChatApp): string[] => chat.chat.data.blocks.map((block) => (block.kind === "notice" ? strip(block.text) : `<${block.kind}>`));

const modelRun = async ({ emit, answer }: RunContext): Promise<void> => {
	emit({ type: "started", runId: "run-m" });
	emit({ type: "prompt", id: "p-m", prompt: { type: "select", message: "Choose a model", options: MODELS } });
	const chosen = await answer();
	if ("cancel" in chosen) return;
	emit({ type: "state", model: chosen.value });
	emit({ type: "output", text: `model switched to ${chosen.value}`, level: "success" });
	emit({ type: "done" });
};

const loginRun = async ({ args, emit, answer }: RunContext): Promise<void> => {
	emit({ type: "started", runId: "run-l" });
	let provider = args;
	if (provider === "") {
		emit({ type: "prompt", id: "p-1", prompt: { type: "select", message: "Log in to a provider", options: PROVIDERS } });
		const chosen = await answer();
		if ("cancel" in chosen) return;
		provider = chosen.value;
	}
	emit({ type: "auth", event: { type: "progress", message: `Starting the ${provider} login` } });
	emit({ type: "auth", event: { type: "auth_url", url: AUTH_URL, instructions: "Sign in, then paste the key below." } });
	emit({ type: "prompt", id: "p-2", prompt: { type: "secret", message: "Paste your OpenCode Zen API key" } });
	const key = await answer();
	if ("cancel" in key) return;
	emit({ type: "output", text: `logged in to OpenCode Zen (api_key, stored as opencode; ${key.value.length} chars)`, level: "success" });
	emit({ type: "done" });
};

test("app: /model opens the picker as a centered overlay with the thread's model selected; a mouse click on a row answers the prompt with that id, the picker closes and the caption follows", async () => {
	const client = new FakeClient();
	client.runs.model = modelRun;
	const { app: chat, terminal } = app(client);
	await flush();
	submit(chat, terminal, "/model");
	await flush();
	const modal = chat.screen.modal;
	expect(modal).toBeInstanceOf(Picker);
	const modelPicker = modal as Picker;
	expect(modelPicker.title).toBe("Choose a model");
	expect(modelPicker.selected?.id).toBe("faux/faux-1");
	expect(chat.screen.tui.getFocusedComponent()).toBe(modelPicker);
	chat.screen.tui.renderNow();
	const bounds = chat.screen.modalBounds();
	expect(bounds).toEqual({ row: 12, col: 27, width: 86, height: 15 });
	const { listTop } = modelPicker.geometry;
	const rowIndex = modelPicker.entries.findIndex((entry) => entry.kind === "option" && entry.option.id === "faux/faux-2");
	click(terminal, (bounds?.col ?? 0) + 10, (bounds?.row ?? 0) + listTop + rowIndex);
	await flush();
	expect(client.answers).toEqual([{ runId: "run-m", promptId: "p-m", answer: { value: "faux/faux-2" } }]);
	await client.finished;
	await flush();
	expect(chat.screen.modal).toBeUndefined();
	expect(chat.screen.tui.getFocusedComponent()).toBe(chat.screen.prompt);
	expect(chat.screen.info.model).toBe("faux/faux-2");
	expect(notices(chat).at(-1)).toBe("model switched to faux/faux-2");
	chat.screen.stop();
});

test("app: /login lists the providers grouped with badges; a click outside the window cancels the run, closes the picker and leaves no command output behind", async () => {
	const client = new FakeClient();
	client.runs.login = loginRun;
	const { app: chat, terminal } = app(client);
	await flush();
	submit(chat, terminal, "/login");
	await flush();
	const modal = chat.screen.modal as Picker;
	expect(modal).toBeInstanceOf(Picker);
	expect(modal.title).toBe("Log in to a provider");
	chat.screen.tui.renderNow();
	const text = framed(modal.render(86));
	const label = (name: string): string => `  ${name.padEnd(14)}`;
	expect(text[4]).toBe(row(` ${CHAT} ${sectionRule(62)}`, 84));
	expect(text[6]).toBe(row(`${label("Anthropic")}${" ".repeat(53)}logged in`, 84));
	expect(text[13]).toBe(row(` ${LOGIN_ONLY} ${sectionRule(42)}`, 84));
	expect(text[14]).toBe(row(`  ${"Vercel".padEnd(8)}  ${NO_TRANSPORT}`, 84));
	click(terminal, 1, 1);
	await flush();
	expect(client.answers).toEqual([{ runId: "run-l", promptId: "p-1", answer: { cancel: true } }]);
	await client.finished;
	expect(chat.screen.modal).toBeUndefined();
	expect(chat.screen.tui.getFocusedComponent()).toBe(chat.screen.prompt);
	expect(notices(chat)).toEqual([]);
	chat.screen.stop();
});

test("app: choosing a provider opens the login card: steps, the auth link with [ Open in browser ] / [ Copy link ] (the browser opens once by itself), a masked secret field, then ✓ + [ Choose a model ] whose click runs /model", async () => {
	const client = new FakeClient();
	client.runs.login = loginRun;
	client.runs.model = modelRun;
	const { app: chat, terminal, opened, copied } = app(client);
	await flush();
	submit(chat, terminal, "/login");
	await flush();
	expect(chat.screen.modal).toBeInstanceOf(Picker);
	terminal.onInput?.("\r");
	await flush();
	expect(client.answers.at(-1)).toEqual({ runId: "run-l", promptId: "p-1", answer: { value: "opencode-zen" } });
	const card = chat.screen.modal as LoginCard;
	expect(card).toBeInstanceOf(LoginCard);
	expect(card.title).toBe("Log in - OpenCode Zen");
	expect(card.phase).toBe("running");
	expect(opened).toEqual([AUTH_URL]);
	expect(card.awaiting?.type).toBe("secret");
	chat.screen.tui.renderNow();
	const lines = card.render(86);
	fits(lines, 86);
	const text = framed(lines);
	expect(text[0]).toBe(top("Log in - OpenCode Zen", 84));
	expect(text[2]).toBe(row("⠋ Starting the opencode-zen login", 84));
	expect(text[4]).toBe(row("Sign in, then paste the key below.", 84));
	expect(text[5]).toBe(row(AUTH_URL, 84));
	expect(lines[6]).toContain(`\x1b]8;;${AUTH_URL}\x1b\\`);
	expect(text[7]).toBe(row("[ Open in browser ]  [ Copy link ]", 84));
	expect(text[9]).toBe(row("Paste your OpenCode Zen API key", 84));
	expect(text[10]).toBe(row(">  paste the key, Enter to submit", 84));
	expect(text[12]).toBe(centered("enter submit - o open - c copy - tab next - esc cancel", 84));
	const bounds = chat.screen.modalBounds();
	expect(bounds).toEqual({ row: 12, col: 27, width: 86, height: 16 });
	const [open, copy] = card.buttons;
	expect(open).toMatchObject({ id: "open", y: 8 });
	click(terminal, (bounds?.col ?? 0) + (open?.x ?? 0) + 3, (bounds?.row ?? 0) + (open?.y ?? 0));
	expect(opened).toEqual([AUTH_URL, AUTH_URL]);
	click(terminal, (bounds?.col ?? 0) + (copy?.x ?? 0) + 3, (bounds?.row ?? 0) + (copy?.y ?? 0));
	expect(copied).toEqual([AUTH_URL]);
	expect(framed(card.render(86))[11]).toBe(row("Link copied to the clipboard", 84));

	for (const char of "sk-zen-top-secret") terminal.onInput?.(char);
	const masked = card.render(86);
	expect(masked.join("\n")).not.toContain("top-secret");
	expect(framed(masked)[10]).toBe(row(`> ${"•".repeat(17)}`, 84));
	terminal.onInput?.("\t");
	terminal.onInput?.("o");
	expect(opened).toHaveLength(3);
	terminal.onInput?.("\x1b[200~-pasted\x1b[201~");
	expect(framed(card.render(86))[10]).toBe(row(`> ${"•".repeat(24)}`, 84));
	for (let index = 0; index < 7; index++) terminal.onInput?.("\x7f");
	terminal.onInput?.("\r");
	await flush();
	expect(client.answers.at(-1)).toEqual({ runId: "run-l", promptId: "p-2", answer: { value: "sk-zen-top-secret" } });
	await client.finished;
	await flush();
	expect(JSON.stringify(chat.chat.data.blocks)).not.toContain("top-secret");
	expect(card.phase).toBe("success");
	expect(chat.screen.modal).toBe(card);
	const done = framed(card.render(86));
	expect(done[2]).toBe(row("x Starting the opencode-zen login", 84));
	expect(done[4]).toBe(row("x logged in to OpenCode Zen (api_key, stored as opencode; 17 chars)", 84));
	expect(done[6]).toBe(row("[ Choose a model ]  [ Done ]", 84));
	expect(done[8]).toBe(centered("m model - d done - esc close", 84));
	expect(notices(chat).at(-1)).toBe("logged in to OpenCode Zen (api_key, stored as opencode; 17 chars)");
	chat.screen.tui.renderNow();
	const after = chat.screen.modalBounds();
	const [choose] = card.buttons;
	expect(choose).toMatchObject({ id: "model", y: 7 });
	click(terminal, (after?.col ?? 0) + (choose?.x ?? 0) + 2, (after?.row ?? 0) + (choose?.y ?? 0));
	await flush();
	await flush();
	expect(client.log.filter((entry) => entry.startsWith("run "))).toEqual(['run login ""', 'run model ""']);
	expect(chat.screen.modal).toBeInstanceOf(Picker);
	expect((chat.screen.modal as Picker).title).toBe("Choose a model");
	chat.screen.stop();
});

test("app: /login <provider> opens the card at once and swaps the id for the display name; Esc aborts the running login and closes the card; Esc closes a finished card", async () => {
	const client = new FakeClient();
	client.runs.login = loginRun;
	const { app: chat, terminal } = app(client, 80, 30);
	await flush();
	submit(chat, terminal, "/login opencode-zen");
	await flush();
	const card = chat.screen.modal as LoginCard;
	expect(card).toBeInstanceOf(LoginCard);
	expect(card.title).toBe("Log in - OpenCode Zen");
	expect(client.log).toContain("arguments login tui main");
	const lines = card.render(50);
	fits(lines, 50);
	expect(framed(lines)[0]).toBe(top("Log in - OpenCode Zen", 48));
	expect(framed(lines)[5]).toBe(row(`${AUTH_URL.slice(0, 39)}...`, 48));
	terminal.onInput?.("\x1b");
	await flush();
	expect(client.answers).toEqual([{ runId: "run-l", promptId: "p-2", answer: { cancel: true } }]);
	await client.finished;
	expect(chat.screen.modal).toBeUndefined();
	expect(notices(chat)).toEqual(["Stopped /login."]);

	submit(chat, terminal, "/login opencode-zen");
	await flush();
	const second = chat.screen.modal as LoginCard;
	terminal.onInput?.("key\r");
	await flush();
	expect(client.answers.at(-1)).toEqual({ runId: "run-l", promptId: "p-2", answer: { value: "key" } });
	await client.finished;
	await flush();
	expect(second.phase).toBe("success");
	expect(chat.screen.modal).toBe(second);
	terminal.onInput?.("\x1b");
	expect(chat.screen.modal).toBeUndefined();
	expect(chat.screen.tui.getFocusedComponent()).toBe(chat.screen.prompt);
	chat.screen.stop();
});

test("app: a broken command stream, a stream cut off before done, or a refused prompt answer ends the login card in its error state instead of leaving it spinning or closing it", async () => {
	const client = new FakeClient();
	client.runs.login = async ({ emit }) => {
		emit({ type: "started", runId: "run-x" });
		emit({ type: "auth", event: { type: "progress", message: "Starting the opencode-zen login" } });
		throw new Error("the daemon closed the stream");
	};
	const { app: chat, terminal } = app(client);
	await flush();
	submit(chat, terminal, "/login opencode-zen");
	await client.finished.catch(() => undefined);
	await flush();
	const broken = chat.screen.modal as LoginCard;
	expect(broken).toBeInstanceOf(LoginCard);
	expect(broken.phase).toBe("error");
	const text = framed(broken.render(86));
	expect(text[2]).toBe(row("x Starting the opencode-zen login", 84));
	expect(text[4]).toBe(row("! the daemon closed the stream", 84));
	expect(text[6]).toBe(row("[ Close ]", 84));
	expect(notices(chat)).toEqual(["the daemon closed the stream"]);
	terminal.onInput?.("\x1b");
	expect(chat.screen.modal).toBeUndefined();

	client.runs.login = async ({ emit }) => {
		emit({ type: "started", runId: "run-y" });
		emit({ type: "auth", event: { type: "progress", message: "Starting the opencode-zen login" } });
	};
	submit(chat, terminal, "/login opencode-zen");
	await client.finished;
	await flush();
	const cut = chat.screen.modal as LoginCard;
	expect(cut.phase).toBe("error");
	expect(framed(cut.render(86))[4]).toBe(row("! the daemon closed /login before it finished", 84));
	terminal.onInput?.("\x1b");
	expect(chat.screen.modal).toBeUndefined();

	client.runs.login = loginRun;
	submit(chat, terminal, "/login opencode-zen");
	await flush();
	const refused = chat.screen.modal as LoginCard;
	expect(refused.awaiting?.type).toBe("secret");
	client.failAnswers = new Error("prompt p-2 is no longer pending");
	terminal.onInput?.("key\r");
	await client.finished;
	await flush();
	expect(refused.phase).toBe("error");
	expect(chat.screen.modal).toBe(refused);
	expect(framed(refused.render(86))).toContain(row("! prompt p-2 is no longer pending", 84));
	expect(notices(chat).at(-1)).toBe("prompt p-2 is no longer pending");
	chat.screen.stop();
});

test("login card: a device code shows in a box with [ Copy code ], an error output turns into ✗ + [ Close ], and a finished card closes on an outside click", () => {
	const copied: string[] = [];
	let closed = 0;
	const card = new LoginCard("GitHub Copilot", { onCancel: () => {}, onClose: () => closed++, onChooseModel: () => {}, open: () => {}, copy: (text) => copied.push(text) }, SIZE, { autoOpen: false });
	card.event({ type: "device_code", userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device" });
	const lines = card.render(86);
	fits(lines, 86);
	expect(framed(lines).slice(2, 10)).toEqual([
		row("Open the link below and enter this code:", 84),
		row(`+${rule(13)}+`, 84),
		row("|  WDJB-MJHT  |", 84),
		row(`+${rule(13)}+`, 84),
		row("https://github.com/login/device", 84),
		row("", 84),
		row("[ Open in browser ]  [ Copy link ]  [ Copy code ]", 84),
		row("", 84),
	]);
	card.handleInput("k");
	expect(copied).toEqual(["WDJB-MJHT"]);
	card.finish("device flow was denied", "error");
	const failed = framed(card.render(86));
	expect(failed[2]).toBe(row("! device flow was denied", 84));
	expect(failed[4]).toBe(row("[ Close ]", 84));
	card.handleMouse({ type: "click", button: "left", x: -3, y: -1, screenX: 0, screenY: 0, width: 86, height: 9, shift: false, alt: false, ctrl: false });
	expect(closed).toBe(1);
	card.handleInput("\r");
	expect(closed).toBe(2);
});
