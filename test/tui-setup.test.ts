import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Terminal } from "@earendil-works/pi-tui";
import type { CommandEvent, CommandInfo, ManifestApplyRequest, ThreadModelState } from "../src/commands/types.ts";
import type { DaemonInfo, ShutdownResult } from "../src/core/daemon-info.ts";
import type { Manifest } from "../src/manifest.ts";
import { setupCopy } from "../src/setup/locale.ts";
import { sha256Hex } from "../src/setup/manifest-file.ts";
import { ChatApp, describeApply } from "../src/tui/app.ts";
import type { ApiClient } from "../src/tui/client.ts";
import { LoginCard } from "../src/tui/login-card.ts";
import { Picker } from "../src/tui/picker.ts";

const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m|\x1b_pi:c\x07|\x1b\]8;;[^\x1b]*\x1b\\/g, "");
const flush = async (times = 3): Promise<void> => {
	for (let i = 0; i < times; i++) await new Promise((resolve) => setImmediate(resolve));
};

class StubTerminal implements Terminal {
	onInput: ((data: string) => void) | undefined;
	constructor(readonly columns: number, readonly rows: number) {}
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

type Handler = (args: string, emit: (event: CommandEvent) => void, answers: AsyncGenerator<string, void, unknown>, signal: AbortSignal) => Promise<void>;

/** The daemon as the TUI sees it: commands stream from `handlers`; prompt answers feed the running handler. */
class FakeDaemon {
	readonly log: string[] = [];
	signedIn: boolean | undefined = false;
	commandList: CommandInfo[] = [{ name: "login", description: "" }, { name: "setup", description: "" }];
	readonly handlers: Record<string, Handler> = {};
	info: DaemonInfo | undefined;
	locale = "en_US.UTF-8";
	eventStreams = 0;
	private pending: ((value: string) => void) | undefined;
	finished: Promise<void> = Promise.resolve();

	async commands(): Promise<CommandInfo[]> {
		return this.commandList;
	}
	async commandArguments(): Promise<[]> {
		return [];
	}
	async threadModel(): Promise<ThreadModelState> {
		return { model: "faux/faux-1", thinkingLevel: "off", supportedThinkingLevels: ["off"], fast: false, fastSupported: false, ...(this.signedIn === undefined ? {} : { signedIn: this.signedIn }) };
	}
	events(_channel: string, _thread: string, _onEvent: unknown, signal: AbortSignal): Promise<void> {
		this.eventStreams++;
		return new Promise((resolve) => signal.addEventListener("abort", () => resolve()));
	}
	async send(): Promise<void> {}
	async abort(): Promise<void> {}
	async daemonInfo(): Promise<DaemonInfo | undefined> {
		return this.info;
	}
	async shutdownDaemon(): Promise<ShutdownResult> {
		this.log.push("shutdown");
		return { status: "refused", error: "busy", busy: [] };
	}
	runCommand(_channel: string, _thread: string, name: string, args: string, _userId: string, onEvent: (event: CommandEvent) => void, signal: AbortSignal): Promise<void> {
		this.log.push(`run ${name} ${JSON.stringify(args)}`);
		const handler = this.handlers[name];
		if (handler === undefined) return new Promise((resolve) => signal.addEventListener("abort", () => resolve()));
		const self = this;
		async function* answers(): AsyncGenerator<string, void, unknown> {
			while (true) yield await new Promise<string>((resolve) => (self.pending = resolve));
		}
		this.finished = handler(args, onEvent, answers(), signal);
		return this.finished;
	}
	async answerPrompt(_runId: string, _promptId: string, answer: { value: string } | { cancel: true }): Promise<void> {
		this.log.push(`answer ${JSON.stringify(answer)}`);
		if ("value" in answer) this.pending?.(answer.value);
	}
}

const manifestFor = (dataDir: string) => ({ model: { provider: "faux", modelId: "faux-1" }, toolMode: "direct", dataDir }) as unknown as Manifest;
const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function open(daemon: FakeDaemon, dataDir = "/nonexistent"): { chat: ChatApp; terminal: StubTerminal } {
	const terminal = new StubTerminal(120, 40);
	const chat = new ChatApp(daemon as unknown as ApiClient, manifestFor(dataDir), "main", undefined, undefined, 200_000, terminal);
	chat.start();
	return { chat, terminal };
}

const notices = (chat: ChatApp) => chat.chat.data.blocks.flatMap((block) => (block.kind === "notice" ? [strip(block.text)] : []));

test("a fresh install opens /setup (not /login) when the daemon has it, without a welcome-login notice", async () => {
	const daemon = new FakeDaemon();
	const { chat } = open(daemon);
	await flush();
	expect(daemon.log).toEqual(['run setup ""']);
	expect(notices(chat)).not.toContain("Welcome! Sign in to a model provider to start.");
	chat.screen.stop();
});

test("a daemon without /setup still gets the login offer; a signed-in TUI with unfinished setup is hinted once", async () => {
	const old = new FakeDaemon();
	old.commandList = [{ name: "login", description: "" }];
	const first = open(old);
	await flush();
	expect(old.log).toEqual(['run login ""']);
	expect(notices(first.chat)).toContain("Welcome! Sign in to a model provider to start.");
	first.chat.screen.stop();

	const resumed = new FakeDaemon();
	resumed.signedIn = true;
	resumed.info = { pid: 1, version: "t", manifestPath: "/m", manifestSha256: "x", owner: "tui", startedAt: "", busy: [], setup: { startedAt: "2026-10-10T00:00:00Z" } };
	const second = open(resumed);
	await flush();
	expect(resumed.log).toEqual([]);
	expect(notices(second.chat)).toContain(setupCopy("en").resumeHint);
	second.chat.screen.stop();
});

test("inside /setup the provider choice opens the login card; once login ends the next step replaces it with a titled picker", async () => {
	const daemon = new FakeDaemon();
	daemon.signedIn = true;
	daemon.handlers.setup = async (_args, emit, answers) => {
		emit({ type: "started", runId: "r1" });
		emit({ type: "prompt", id: "p1", prompt: { type: "select", login: true, message: "Setup 1/2 · Connect a model\nConnect an AI model account to start.", options: [{ id: "faux", label: "Faux" }] } });
		await answers.next();
		emit({ type: "output", text: "logged in to Faux", level: "success" });
		emit({ type: "prompt", id: "p2", prompt: { type: "select", message: "Setup 2/2 · Ready\n✓ faux/faux-1 connected.", options: [{ id: "quick", label: "Start now" }, { id: "full", label: "Set up more" }] } });
		await answers.next();
		emit({ type: "done" });
	};
	const { chat, terminal } = open(daemon);
	await flush();
	chat.openSetup("");
	await flush();
	const first = chat.screen.modal;
	expect(first).toBeInstanceOf(Picker);
	expect((first as Picker).title).toBe("Setup 1/2 · Connect a model");
	expect((first as Picker).render(120).map(strip).join("\n")).toContain("Connect an AI model account to start.");
	terminal.onInput?.("\r");
	await flush();
	expect(chat.screen.modal).toBeInstanceOf(Picker);
	expect((chat.screen.modal as Picker).title).toBe("Setup 2/2 · Ready");
	expect(notices(chat)).toContain("logged in to Faux");
	terminal.onInput?.("\r");
	await daemon.finished;
	await flush();
	expect(chat.screen.modal).toBeUndefined();
	expect(daemon.log).toContain('answer {"value":"faux"}');
	expect(daemon.log).toContain('answer {"value":"quick"}');
	chat.screen.stop();
});

test("a login card stays up between the provider choice and the end of the login flow", async () => {
	const daemon = new FakeDaemon();
	daemon.signedIn = true;
	let release!: () => void;
	daemon.handlers.setup = async (_args, emit, answers) => {
		emit({ type: "started", runId: "r1" });
		emit({ type: "prompt", id: "p1", prompt: { type: "select", login: true, message: "Setup 1/2 · Connect a model", options: [{ id: "faux", label: "Faux" }] } });
		await answers.next();
		emit({ type: "prompt", id: "p2", prompt: { type: "secret", message: "Faux API key" } });
		await new Promise<void>((resolve) => (release = resolve));
		emit({ type: "done" });
	};
	const { chat, terminal } = open(daemon);
	await flush();
	chat.openSetup("");
	await flush();
	terminal.onInput?.("\r");
	await flush();
	expect(chat.screen.modal).toBeInstanceOf(LoginCard);
	release();
	await daemon.finished;
	chat.screen.stop();
});

test("an apply request runs after the command ends; a refusal (busy daemon) changes nothing and reconnects the thread", async () => {
	const dir = await mkdtemp(join(tmpdir(), "tui-setup-"));
	dirs.push(dir);
	const path = join(dir, "dinobot.yaml");
	const base = ["bot:", "  enabled: true", `  dataDir: ${JSON.stringify(dir)}`, "  model:", "    provider: faux", "    modelId: faux-1", "  toolMode: direct", "api:", "  port: 1", "channels: {}", "plugins: {}", ""].join("\n");
	await writeFile(path, base);
	const daemon = new FakeDaemon();
	daemon.signedIn = true;
	daemon.info = { pid: process.pid, version: "t", manifestPath: path, manifestSha256: sha256Hex(base), owner: "tui", startedAt: "", busy: ["slack:C1"], setup: {} };
	const request: ManifestApplyRequest = { manifestPath: path, baseSha256: sha256Hex(base), candidate: base.replace("plugins: {}", "plugins:\n  computer: {}"), changes: ["+ plugins.computer"], summary: ["✓ Model: faux/faux-1"], locale: "en_US.UTF-8" };
	daemon.handlers.setup = async (_args, emit) => {
		emit({ type: "started", runId: "r1" });
		emit({ type: "apply", request });
		emit({ type: "done" });
	};
	const { chat } = open(daemon, dir);
	await flush();
	const streams = daemon.eventStreams;
	chat.openSetup("");
	// No snapshot ever arrives from this fake stream, so the outcome notice lands after the attach fallback wait.
	for (let i = 0; i < 100 && !notices(chat).some((text) => text.includes("still working")); i++) await Bun.sleep(50);
	expect(notices(chat).at(-1)).toBe(setupCopy("en").applyOutcome.busy("slack:C1"));
	expect(await readFile(path, "utf8")).toBe(base);
	expect(daemon.log).not.toContain("shutdown");
	expect(daemon.eventStreams).toBe(streams + 1);
	chat.screen.stop();
});

test("describeApply: success lists the changes and the summary; failures carry their reason", () => {
	const copy = setupCopy("ko");
	const request: ManifestApplyRequest = { manifestPath: "/m.yaml", baseSha256: "", candidate: "", changes: ["+ plugins.computer"], summary: ["✓ 모델: x"], locale: "ko" };
	expect(describeApply({ status: "applied" }, copy, request)).toEqual({ text: `${copy.applied}\n+ plugins.computer\n✓ 모델: x`, level: "success" });
	expect(describeApply({ status: "rolled_back", reason: "boom", log: "tail" }, copy, request).text).toContain("boom");
	expect(describeApply({ status: "saved_external" }, copy, request).level).toBe("info");
	// Saved for an externally managed daemon: the summary, and with it the onboarding's last invitation, is still shown.
	const onboarding = { ...request, summary: ["✓ 모델: x", "", copy.contextTip] };
	expect(describeApply({ status: "saved_external" }, copy, onboarding).text).toBe(`${copy.applyOutcome.external("/m.yaml")}\n+ plugins.computer\n✓ 모델: x\n\n${copy.contextTip}`);
	expect(describeApply({ status: "stuck", pid: 7 }, copy, request).text).toContain("pid 7");
});
