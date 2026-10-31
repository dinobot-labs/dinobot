import { expect, test } from "bun:test";
import { type Terminal, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import type { CommandArgument, CommandEvent, CommandInfo, ThreadModelState } from "../src/commands/types.ts";
import type { Manifest } from "../src/manifest.ts";
import type { ResearchView } from "../src/core/ui-contract.ts";
import { ChatApp } from "../src/tui/app.ts";
import { PromptBox, promptCaption } from "../src/tui/chrome.ts";
import { type ApiClient, HttpError } from "../src/tui/client.ts";
import { LOCAL_COMMANDS, readResearchReport, renderDropdownPanel, researchDetails, researchPickerOptions, SlashMenu, type SlashSource } from "../src/tui/slash.ts";
import { ansi, bold, color, spacing } from "../src/tui/theme.ts";

const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m|\x1b_pi:c\x07|\x1b\]8;;[^\x1b]*\x1b\\/g, "");
const plain = (lines: readonly string[]): string[] => lines.map((line) => strip(line).trimEnd());
const mission: ResearchView = {
	id: "m-1", revision: 2, question: "Check cache", status: "stopped", judgment: "inconclusive", deadlineAt: 1000,
	attempts: { used: 2, limit: 3 }, rounds: { used: 1, limit: 2 }, candidateBudget: { used: 2, limit: 4 },
	activeAttempts: 0, maxConcurrent: 1, confirmationReserved: 1,
	candidates: [{ id: "child", parentId: "base", operation: "mutate", state: "measured", hypothesis: "cache\x07\ninput", value: 3, unit: "ms", delta: -2, validity: "unknown", verdict: "inconclusive", feedback: "\x1b[31mNeeds confirmation\x00", runId: "run-2", nodeId: "measure" }],
	report: { directory: "/project/reports/m-1", state: "error", writtenRevision: 1, error: "disk full" },
};

test("research picker separates candidate lineage and execution; details expose feedback, delta and stale report path", () => {
	const options = researchPickerOptions(mission);
	expect(options.map((entry) => entry.id)).toEqual(["research:mission", "research:report", "research:candidate:child"]);
	expect(options[2]?.group).toBe("Candidate lineage (not execution edges)");
	expect(options[2]?.description).toContain("base -> child");
	const detail = researchDetails(mission, "research:candidate:child")!;
	expect(detail).toContain("delta -2");
	expect(detail).toContain("Validity: unknown · verdict inconclusive");
	expect(detail).toContain("Feedback: Needs confirmation");
	expect(detail).toContain("Execution: run run-2 · node measure");
	expect(detail).not.toMatch(/[\x00\x07\x1b]/);
	expect(researchDetails(mission, "research:mission")).toContain("/project/reports/m-1 · error (lagging): disk full");
	expect(researchDetails(mission, "research:candidate:missing")).toBeUndefined();
	for (const width of [80, 140]) {
		const rows = options.map((entry) => ({ display: entry.label, description: entry.description, insert: entry.id, indices: [] }));
		const panel = renderDropdownPanel(rows, 2, width);
		for (const line of panel.lines) expect(visibleWidth(line)).toBe(width);
	}
});

test("report navigation uses the thread-scoped contained API and strips terminal controls", async () => {
	const calls: unknown[][] = [];
	const content = await readResearchReport({
		channel: "local", thread: "thread-1",
		client: { researchReport: async (...args) => { calls.push(args); return "# Report\n\x1b[31mnegative\x07\x00"; } },
	}, mission.id);
	expect(calls).toEqual([["local", "thread-1", "m-1", "report.md"]]);
	expect(content).toBe("# Report\nnegative");
	await expect(readResearchReport({ channel: "local", thread: "t", client: {} }, mission.id)).rejects.toThrow("unavailable");
	await expect(readResearchReport({
		channel: "local", thread: "t", client: { researchReport: async () => { throw new Error("report missing"); } },
	}, mission.id)).rejects.toThrow("report missing");
});
const fits = (lines: readonly string[], width: number): void => {
	for (const line of lines) expect(visibleWidth(line), strip(line)).toBe(width);
};

const SERVER_COMMANDS: readonly CommandInfo[] = [
	{ name: "help", description: "Show available commands" },
	{ name: "login", description: "Log in to a model provider with oh-my-pi's login flows", usage: "[provider]" },
	{ name: "logout", description: "Remove a stored credential", usage: "[provider]" },
	{ name: "model", description: "Show or switch this thread's model", usage: "[provider/modelId]" },
	{ name: "plugins", description: "List loaded plugins" },
	{ name: "skills", description: "List available skills" },
];
const PROVIDERS: readonly CommandArgument[] = [
	{ value: "anthropic", label: "Anthropic", description: "Claude via OAuth" },
	{ value: "openai", label: "OpenAI", description: "ChatGPT / Codex" },
	{ value: "xai", label: "xAI" },
];

class FakeSource implements SlashSource {
	fetched: string[] = [];
	lastFetch: Promise<readonly CommandArgument[]> = Promise.resolve([]);
	constructor(private readonly all: readonly CommandInfo[]) {}
	commands(): readonly CommandInfo[] {
		return this.all;
	}
	arguments(name: string): Promise<readonly CommandArgument[]> {
		this.fetched.push(name);
		this.lastFetch = Promise.resolve(name === "login" ? PROVIDERS : []);
		return this.lastFetch;
	}
}

const merged = (): CommandInfo[] => [...LOCAL_COMMANDS, ...SERVER_COMMANDS].sort((a, b) => a.name.localeCompare(b.name));

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

const margin = " ".repeat(spacing.margin);
const CAPTION = " anthropic/claude-sonnet-4 - codemode ";
/** The prompt box inside the page margins: `+--+`, `| > text |`, and the bottom border carrying the caption. */
const boxRow = (text: string, width: number): string => `${`${margin}| > ${text}`.padEnd(width - spacing.margin - 1)}|`;
const boxTop = (width: number): string => `${margin}+${"-".repeat(width - spacing.margin * 2 - 2)}+`;
const boxBottom = (width: number): string => `${margin}+${"-".repeat(width - spacing.margin * 2 - 3 - CAPTION.length)}${CAPTION}-+`;
/** The dropdown rules sit inside the page margins; the top one carries the match count before its last `─`. */
const rule = (width: number, count = ""): string => `${margin}${"─".repeat(width - spacing.margin * 2 - (count === "" ? 0 : count.length + 1))}${count}${count === "" ? "" : "─"}`;
/** A dropdown row: the page margin, the two inset columns, then the row text; `thumbRow` pads it to the panel and ends with the scrollbar thumb. */
const panelRow = (text: string): string => `${margin}  ${text}`;
const thumbRow = (text: string, width: number): string => `${panelRow(text).padEnd(width - spacing.margin - 1)}█`;
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const promptAt = (cols: number, rows: number, source: SlashSource): PromptBox => {
	const prompt = new PromptBox(new TuiAltScreen(new StubTerminal(cols, rows), false));
	prompt.caption = promptCaption("anthropic/claude-sonnet-4", "codemode");
	prompt.focused = true;
	prompt.menu = new SlashMenu(source);
	return prompt;
};
const type = (prompt: PromptBox, text: string): void => {
	for (const char of text) prompt.handleInput(char);
};

test("menu: `/` lists the merged set sorted by name, filters fuzzily with highlights, Tab inserts `/name ` for commands with arguments", () => {
	const source = new FakeSource(merged());
	const menu = new SlashMenu(source);
	menu.refresh("/", 1);
	expect(menu.open).toBe(true);
	expect(menu.matches.map((row) => row.display)).toEqual(["/agents", "/choose", "/dag", "/help", "/login", "/logout", "/model", "/new", "/plugins", "/quit", "/sessions", "/skills", "/theme", "/thread"]);
	expect(menu.matches.map((row) => row.insert)).toContain("/login ");
	expect(menu.matches.map((row) => row.insert)).not.toContain("/threads");
	expect(menu.matches.map((row) => row.insert)).toContain("/sessions");
	menu.refresh("/lo", 3);
	expect(menu.matches.map((row) => row.display)).toEqual(["/login", "/logout"]);
	expect(menu.matches[0]?.indices).toEqual([1, 2]);
	expect(menu.accept(false)).toEqual({ text: "/login ", submit: false });
	expect(menu.accept(true)).toEqual({ text: "/login ", submit: false });
	menu.move(1);
	expect(menu.accept(false)).toEqual({ text: "/logout ", submit: false });
	menu.refresh("/log", 4);
	expect(menu.selected).toBe(1);
	menu.refresh("/plug", 5);
	expect(menu.accept(true)).toEqual({ text: "/plugins", submit: true });
	menu.refresh("/zzz", 4);
	expect(menu.open).toBe(false);
	menu.refresh("hello /", 7);
	expect(menu.open).toBe(false);
	menu.refresh("/", -1);
	expect(menu.open).toBe(false);
});

test("menu: after `/name ` the command's arguments are fetched once per open, filtered by the typed prefix, Enter submits the chosen one; Esc closes until the text changes", async () => {
	const source = new FakeSource(merged());
	let changes = 0;
	const menu = new SlashMenu(source, () => changes++);
	menu.refresh("/login ", 7);
	expect(menu.open).toBe(false);
	expect(source.fetched).toEqual(["login"]);
	await source.lastFetch;
	expect(changes).toBe(1);
	expect(menu.matches.map((row) => row.display)).toEqual(["Anthropic", "OpenAI", "xAI"]);
	menu.refresh("/login op", 9);
	expect(menu.matches.map((row) => row.display)).toEqual(["OpenAI", "Anthropic"]);
	expect(menu.accept(true)).toEqual({ text: "/login openai", submit: true });
	expect(menu.accept(false)).toEqual({ text: "/login openai", submit: false });
	menu.refresh("/login xa", 9);
	expect(menu.matches.map((row) => row.display)).toEqual(["xAI"]);
	expect(source.fetched).toEqual(["login"]);
	menu.refresh("/threads ", 9);
	expect(menu.open).toBe(false);
	expect(source.fetched).toEqual(["login"]);
	menu.refresh("/login ", 7);
	expect(source.fetched).toEqual(["login", "login"]);
	await source.lastFetch;
	expect(menu.open).toBe(true);
	menu.dismiss();
	expect(menu.open).toBe(false);
	menu.refresh("/login ", 7);
	expect(menu.open).toBe(false);
	menu.refresh("/login a", 8);
	expect(source.fetched).toEqual(["login", "login", "login"]);
	await source.lastFetch;
	expect(menu.open).toBe(true);
	expect(menu.matches.map((row) => row.display)).toEqual(["Anthropic", "xAI", "OpenAI"]);
	menu.move(-1);
	expect(menu.selected).toBe(2);
	menu.move(1);
	expect(menu.selected).toBe(0);
});

test("dropdown at 140x40: Grok panel above the box with the count on the top border, ❯ + bg_visual + bold on the selection, aligned descriptions, scrollbar past 8 rows", () => {
	const prompt = promptAt(140, 40, new FakeSource(merged()));
	prompt.handleInput("/");
	const lines = prompt.render(140);
	fits(lines, 140);
	expect(plain(lines)).toEqual([
		rule(140, "14"),
		thumbRow("> /agents    Open a subagent's conversation", 140),
		thumbRow("  /choose    Answer the open question with choices", 140),
		thumbRow("  /dag       Show the DAG run's nodes", 140),
		thumbRow("  /help      Show available commands", 140),
		panelRow("  /login     Log in to a model provider with oh-my-pi's login flows"),
		panelRow("  /logout    Remove a stored credential"),
		panelRow("  /model     Show or switch this thread's model"),
		panelRow("  /new       Start a new thread"),
		rule(140),
		boxTop(140),
		boxRow("/", 140),
		boxBottom(140),
	]);
	expect(lines[1]).toContain(bold(color.textPrimary("> ")));
	expect(lines[1]).toContain(ansi.bg("bgVisual"));
	expect(lines[2]).not.toContain(ansi.bg("bgVisual"));
	expect(lines[2]).toContain(ansi.bg("bgHighlight"));
	for (let index = 0; index < 13; index++) prompt.handleInput("\x1b[B");
	const scrolled = plain(prompt.render(140));
	expect(scrolled[1]).toContain("/model");
	expect(scrolled[8]).toContain("> /thread");
	expect(scrolled[8]).toContain("█");
	expect(scrolled[1]).not.toContain("█");
	prompt.handleInput("\x1b[B");
	expect(plain(prompt.render(140))[1]).toContain("> /agents");
});

test("dropdown at 80x30 and 60 columns: same rows narrower, descriptions truncated with …", () => {
	const prompt = promptAt(80, 30, new FakeSource(merged()));
	prompt.handleInput("/");
	const lines = prompt.render(80);
	fits(lines, 80);
	expect(plain(lines)).toEqual([
		rule(80, "14"),
		thumbRow("> /agents    Open a subagent's conversation", 80),
		thumbRow("  /choose    Answer the open question with choices", 80),
		thumbRow("  /dag       Show the DAG run's nodes", 80),
		thumbRow("  /help      Show available commands", 80),
		panelRow("  /login     Log in to a model provider with oh-my-pi's login flows"),
		panelRow("  /logout    Remove a stored credential"),
		panelRow("  /model     Show or switch this thread's model"),
		panelRow("  /new       Start a new thread"),
		rule(80),
		boxTop(80),
		boxRow("/", 80),
		boxBottom(80),
	]);
	const narrow = plain(prompt.render(60));
	fits(prompt.render(60), 60);
	expect(narrow[5]).toBe(panelRow("  /login     Log in to a model provider with oh-my-pi..."));
	type(prompt, "lo");
	const filtered = plain(prompt.render(80));
	expect(filtered.slice(0, 4)).toEqual([
		rule(80, "2"),
		panelRow("> /login   Log in to a model provider with oh-my-pi's login flows"),
		panelRow("  /logout  Remove a stored credential"),
		rule(80),
	]);
	expect(prompt.render(80)[1]).toContain(bold(color.fuzzyAccent("lo")));
});

test("prompt box: Tab completes `/login `, the provider list follows, Enter on a provider submits `/login openai`; Enter on `/threads` submits at once; Esc closes the menu and the next Tab reaches the app", async () => {
	const source = new FakeSource(merged());
	const prompt = promptAt(140, 40, source);
	const submitted: string[] = [];
	prompt.onSubmit = (text) => submitted.push(text);
	type(prompt, "/lo");
	prompt.handleInput("\t");
	expect(prompt.getText()).toBe("/login ");
	expect(source.fetched).toEqual(["login"]);
	await source.lastFetch;
	expect(prompt.menuOpen).toBe(true);
	const rows = plain(prompt.render(140));
	expect(rows[1]).toBe(panelRow("> Anthropic  Claude via OAuth"));
	expect(rows[2]).toBe(panelRow("  OpenAI     ChatGPT / Codex"));
	expect(rows[3]).toBe(panelRow("  xAI"));
	prompt.handleInput("\x1b[B");
	prompt.handleInput("\r");
	expect(submitted).toEqual(["/login openai"]);
	expect(prompt.getText()).toBe("");
	expect(prompt.menuOpen).toBe(false);

	type(prompt, "/threads");
	expect(prompt.menuOpen).toBe(false); // Hidden alias is still submitted as typed.
	prompt.handleInput("\r");
	expect(submitted).toEqual(["/login openai", "/threads"]);

	type(prompt, "/login");
	prompt.handleInput("\r");
	expect(submitted).toEqual(["/login openai", "/threads", "/login"]);
	type(prompt, "/thread");
	prompt.handleInput("\r");
	expect(submitted).toHaveLength(3);
	expect(prompt.getText()).toBe("/thread ");
	prompt.setText("");

	type(prompt, "/");
	expect(prompt.menuOpen).toBe(true);
	prompt.handleInput("\x1b");
	expect(prompt.menuOpen).toBe(false);
	expect(prompt.getText()).toBe("/");
	expect(prompt.render(140)).toHaveLength(3);
	type(prompt, "m");
	expect(prompt.menuOpen).toBe(true);
	expect(plain(prompt.render(140))[1]).toBe(panelRow("> /model  Show or switch this thread's model"));
	prompt.setText("");
	expect(prompt.menuOpen).toBe(false);
});

test("secret prompt: the field shows • per character, never the text, Enter answers without submitting, and the text is gone from the editor afterwards", () => {
	const prompt = promptAt(140, 40, new FakeSource(merged()));
	const submitted: string[] = [];
	const answers: string[] = [];
	let cancels = 0;
	prompt.onSubmit = (text) => submitted.push(text);
	prompt.beginAnswer({ type: "secret", message: "Paste your Anthropic API key", placeholder: "sk-ant-..." }, { onAnswer: (value) => answers.push(value), onCancel: () => cancels++ });
	expect(prompt.answer?.type).toBe("secret");
	const empty = prompt.render(140);
	fits(empty, 140);
	expect(plain(empty).slice(0, 3)).toEqual([rule(140), panelRow("Paste your Anthropic API key"), rule(140)]);
	expect(plain(empty)[4]).toBe(boxRow("sk-ant-...", 140));
	type(prompt, "sk-ant-secret-123");
	const masked = prompt.render(140);
	expect(masked.join("\n")).not.toContain("secret");
	expect(plain(masked)[4]).toBe(boxRow("•".repeat(17), 140));
	prompt.handleInput("\x1b[A");
	expect(prompt.getText()).toBe("sk-ant-secret-123");
	prompt.handleInput("\r");
	expect(answers).toEqual(["sk-ant-secret-123"]);
	expect(submitted).toEqual([]);
	prompt.endAnswer();
	expect(prompt.answer).toBeUndefined();
	expect(prompt.getText()).toBe("");
	prompt.beginAnswer({ type: "secret", message: "Paste your API key" }, { onAnswer: () => {}, onCancel: () => {} });
	type(prompt, "sk-killed-secret");
	prompt.handleInput("\x15");
	prompt.endAnswer();
	prompt.handleInput("\x19");
	expect(prompt.getText()).toBe("");
	prompt.handleInput("\x1f");
	expect(prompt.getText()).toBe("");
	prompt.handleInput("\x1b[A");
	expect(prompt.getText()).toBe("");
	prompt.beginAnswer({ type: "text", message: "Name?" }, { onAnswer: (value) => answers.push(value), onCancel: () => cancels++ });
	prompt.handleInput("\x1b");
	expect(cancels).toBe(1);
});

test("text prompt: Enter on an empty field answers \"\" (GitHub's 'blank for github.com')", () => {
	const prompt = new PromptBox(new TuiAltScreen(new StubTerminal(80, 24), false));
	const answers: string[] = [];
	prompt.beginAnswer({ type: "text", message: "GitHub Enterprise URL/domain (blank for github.com)" }, { onAnswer: (value) => answers.push(value), onCancel: () => {} });
	prompt.handleInput("\r");
	expect(answers).toEqual([""]);
});

test("select prompt: options render as the dropdown under the message, typing filters them, Enter answers with the option id", () => {
	const prompt = promptAt(80, 30, new FakeSource(merged()));
	const answers: string[] = [];
	prompt.beginAnswer(
		{ type: "select", message: "Which account?", options: [{ id: "work", label: "Work", description: "team@brain-crew.com" }, { id: "home", label: "Personal" }] },
		{ onAnswer: (value) => answers.push(value), onCancel: () => {} },
	);
	const lines = prompt.render(80);
	fits(lines, 80);
	expect(plain(lines).slice(0, 5)).toEqual([
		rule(80, "2"),
		panelRow("Which account?"),
		panelRow("> Work      team@brain-crew.com"),
		panelRow("  Personal"),
		rule(80),
	]);
	type(prompt, "pers");
	expect(plain(prompt.render(80))[2]).toBe(panelRow("> Personal"));
	prompt.handleInput("\r");
	expect(answers).toEqual(["home"]);
});

type RunHandler = (args: string, onEvent: (event: CommandEvent) => void, signal: AbortSignal) => Promise<void>;

/** Enough of ApiClient for ChatApp: a pending event stream, canned commands, and scripted command runs. */
class FakeClient {
	readonly log: string[] = [];
	readonly answers: { runId: string; promptId: string; answer: { value: string } | { cancel: true } }[] = [];
	private emit: ((event: CommandEvent) => void) | undefined;
	private finish: (() => void) | undefined;
	finished: Promise<void> = Promise.resolve();
	readonly runs: Record<string, RunHandler> = {};

	async commands(): Promise<CommandInfo[]> {
		return [...SERVER_COMMANDS];
	}
	async commandArguments(name: string): Promise<CommandArgument[]> {
		return name === "login" ? [...PROVIDERS] : [];
	}
	async threads(): Promise<{ key: string; conversationId: number }[]> {
		return [
			{ key: "tui:main", conversationId: 1 },
			{ key: "tui:side", conversationId: 2 },
			{ key: "slack:C1:t", conversationId: 3 },
		];
	}
	signedIn: boolean | undefined = undefined;
	async threadModel(): Promise<ThreadModelState> {
		return { model: "fake/model-from-thread", thinkingLevel: "off", supportedThinkingLevels: ["off"], fast: false, fastSupported: false, ...(this.signedIn === undefined ? {} : { signedIn: this.signedIn }) };
	}
	events(_channel: string, _thread: string, _onEvent: unknown, signal: AbortSignal): Promise<void> {
		return new Promise((resolve) => signal.addEventListener("abort", () => resolve()));
	}
	async send(): Promise<void> {}
	async abort(): Promise<void> {}
	runCommand(_channel: string, _thread: string, name: string, args: string, _userId: string, onEvent: (event: CommandEvent) => void, signal: AbortSignal): Promise<void> {
		this.log.push(`run ${name} ${JSON.stringify(args)}`);
		const handler = this.runs[name];
		if (handler === undefined) return Promise.reject(new HttpError(404, `POST /v1/threads/tui/main/commands: HTTP 404 {"error":"unknown command /${name}"}`));
		this.emit = onEvent;
		this.finished = new Promise<void>((resolve) => {
			this.finish = resolve;
			signal.addEventListener("abort", () => resolve());
		});
		void handler(args, onEvent, signal).then(() => this.finish?.());
		return this.finished;
	}
	async answerPrompt(runId: string, promptId: string, answer: { value: string } | { cancel: true }): Promise<void> {
		this.answers.push({ runId, promptId, answer });
		if ("value" in answer) {
			this.emit?.({ type: "output", text: `Logged in as ${answer.value.length} characters`, level: "success" });
			this.emit?.({ type: "done" });
		}
		this.finish?.();
	}
}

const manifest = { model: { provider: "anthropic", modelId: "claude-sonnet-4" }, toolMode: "codemode" } as unknown as Manifest;

function app(client: FakeClient, cols = 140, rows = 40): { app: ChatApp; terminal: StubTerminal } {
	const terminal = new StubTerminal(cols, rows);
	const chat = new ChatApp(client as unknown as ApiClient, manifest, "main", undefined, undefined, 200_000, terminal);
	chat.start();
	return { app: chat, terminal };
}

test("app: /login runs on the daemon; auth_url becomes a hyperlink notice, the secret prompt is answered through answerPrompt and never reaches history or the transcript", async () => {
	const client = new FakeClient();
	client.runs.login = async (_args, onEvent, signal) => {
		onEvent({ type: "started", runId: "run-7" });
		onEvent({ type: "auth", event: { type: "auth_url", url: "https://console.anthropic.com/login?x=1", instructions: "Sign in, then paste the key below." } });
		onEvent({ type: "prompt", id: "p-1", prompt: { type: "secret", message: "Paste your API key" } });
		await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
	};
	const { app: chat, terminal } = app(client);
	const prompt = chat.screen.prompt;
	await flush();
	expect(chat.screen.info.model).toBe("fake/model-from-thread");
	expect(chat.screen.prompt.caption).toBe(promptCaption("fake/model-from-thread", "codemode", "reasoning unsupported"));

	type(prompt, "/login");
	terminal.onInput?.("\r");
	expect(client.log).toEqual(['run login ""']);
	expect(prompt.answer?.type).toBe("secret");
	const blocks = () => chat.chat.data.blocks.map((block) => (block.kind === "notice" ? block.text : ""));
	expect(strip(blocks()[0] ?? "")).toBe("Sign in, then paste the key below.\nhttps://console.anthropic.com/login?x=1");
	expect(blocks()[0]).toContain("\x1b]8;;https://console.anthropic.com/login?x=1\x1b\\");

	for (const char of "sk-ant-top-secret") terminal.onInput?.(char);
	const shown = prompt.render(140);
	expect(shown.join("\n")).not.toContain("top-secret");
	expect(plain(shown).some((line) => line.includes("> •••••••••••••••••"))).toBe(true);
	terminal.onInput?.("\r");
	expect(prompt.answer).toBeUndefined();
	await client.finished;
	expect(client.answers).toEqual([{ runId: "run-7", promptId: "p-1", answer: { value: "sk-ant-top-secret" } }]);
	expect(strip(blocks()[1] ?? "")).toBe("Logged in as 17 characters");
	expect(JSON.stringify(chat.chat.data.blocks)).not.toContain("top-secret");
	expect(prompt.getText()).toBe("");
	terminal.onInput?.("\x1b[A");
	expect(prompt.getText()).toBe("/login");
	terminal.onInput?.("\x1b[A");
	expect(prompt.getText()).toBe("/login");
	chat.screen.stop();
});

test("app: a fresh install with nothing signed in opens /login once with a welcome, not an error; signed-in and older daemons do not", async () => {
	for (const [signedIn, runs] of [[false, ['run login ""']], [true, []], [undefined, []]] as const) {
		const client = new FakeClient();
		client.signedIn = signedIn;
		client.runs.login = async (_args, onEvent, signal) => {
			onEvent({ type: "started", runId: "run-w" });
			await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
		};
		const { app: chat } = app(client);
		await flush();
		expect(client.log).toEqual([...runs]);
		const notices = chat.chat.data.blocks.filter((block) => block.kind === "notice");
		expect(notices.some((block) => block.kind === "notice" && block.level === "error")).toBe(false);
		if (signedIn === false) expect(notices.map((block) => block.kind === "notice" ? strip(block.text) : "")).toContain("Welcome! Sign in to a model provider to start.");
		chat.screen.stop();
	}
});

test("app: Esc during a prompt cancels it and aborts the run; unknown commands say so; /help lists the merged set; state{model} updates the caption", async () => {
	const client = new FakeClient();
	client.runs.login = async (_args, onEvent, signal) => {
		onEvent({ type: "started", runId: "run-8" });
		onEvent({ type: "prompt", id: "p-2", prompt: { type: "text", message: "Code?" } });
		await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
	};
	client.runs.model = async (args, onEvent) => {
		onEvent({ type: "started", runId: "run-9" });
		onEvent({ type: "state", model: args });
		onEvent({ type: "output", text: `model set to ${args}`, level: "info" });
		onEvent({ type: "done" });
	};
	const { app: chat, terminal } = app(client, 80, 30);
	const prompt = chat.screen.prompt;
	const notices = () => chat.chat.data.blocks.map((block) => (block.kind === "notice" ? strip(block.text) : "?"));

	type(prompt, "/login");
	terminal.onInput?.("\r");
	expect(prompt.answer?.type).toBe("text");
	terminal.onInput?.("\x1b");
	expect(prompt.answer).toBeUndefined();
	await client.finished;
	expect(client.answers).toEqual([{ runId: "run-8", promptId: "p-2", answer: { cancel: true } }]);
	expect(notices().at(-1)).toBe("Stopped /login.");

	type(prompt, "/nope now");
	terminal.onInput?.("\r");
	await flush();
	expect(client.log.at(-1)).toBe('run nope "now"');
	expect(notices().at(-1)).toBe("unknown command /nope");

	type(prompt, "/model openai/gpt-5");
	terminal.onInput?.("\r");
	await client.finished;
	expect(chat.screen.info.model).toBe("openai/gpt-5");
	expect(prompt.caption).toBe(promptCaption("openai/gpt-5", "codemode", "reasoning unknown"));
	expect(notices().at(-1)).toBe("model set to openai/gpt-5");

	await flush();
	type(prompt, "/help");
	terminal.onInput?.("\r");
	expect(notices().at(-1)?.split("\n")).toEqual([
		"/agents [id]               Open a subagent's conversation",
		"/choose                    Answer the open question with choices",
		"/dag                       Show the DAG run's nodes",
		"/help                      Show available commands",
		"/login [provider]          Log in to a model provider with oh-my-pi's login flows",
		"/logout [provider]         Remove a stored credential",
		"/model [provider/modelId]  Show or switch this thread's model",
		"/new [name]                Start a new thread",
		"/plugins                   List loaded plugins",
		"/quit                      Quit dinobot",
		"/sessions                  Browse live sessions and attach a conversation",
		"/skills                    List available skills",
		"/theme [name]              Pick a theme (dinosaur or DOS blue/black)",
		"/thread <name>             Switch to a thread",
	]);

	type(prompt, "/thread ");
	await flush();
	expect(plain(prompt.render(80)).slice(1, 3)).toEqual([panelRow("> main  current"), panelRow("  side")]);
	chat.screen.stop();
});

test("app: /help disabled on the daemon is unknown in the TUI too", async () => {
	const client = new FakeClient();
	client.commands = async () => SERVER_COMMANDS.filter((command) => command.name !== "help");
	const { app: chat, terminal } = app(client, 80, 30);
	await flush();
	type(chat.screen.prompt, "/help");
	terminal.onInput?.("\r");
	await flush();
	const last = chat.chat.data.blocks.at(-1);
	expect(last?.kind === "notice" ? strip(last.text) : "?").toBe("unknown command /help");
	chat.screen.stop();
});

test("app: an older daemon without /v1/commands gets a restart hint instead of a bare 404", async () => {
	const client = new FakeClient();
	client.commands = async () => {
		throw new HttpError(404, "GET /v1/commands: HTTP 404");
	};
	const { app: chat } = app(client, 80, 30);
	await flush();
	const last = chat.chat.data.blocks.at(-1);
	expect(last?.kind === "notice" ? strip(last.text) : "?").toContain("older than this TUI");
	chat.screen.stop();
});
