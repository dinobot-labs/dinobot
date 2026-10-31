import { userInfo } from "node:os";
import type { AuthEvent } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { matchesKey, ProcessTerminal, type Terminal, type OverlayOptions, type TuiInputListenerResult, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { CommandArgument, CommandEvent, CommandInfo, CommandPromptSpec, ManifestApplyRequest } from "../commands/types.ts";
import { type ApplyOutcome, applyManifestChange, recoverInterruptedApply } from "../setup/apply.ts";
import { detectLocale, resolveLocale, type SetupCopy, setupCopy } from "../setup/locale.ts";
import type { DagNodeView, SubagentProgress } from "../core/ui-contract.ts";
import type { Manifest } from "../manifest.ts";
import { checkForUpdate, CURRENT_VERSION, type UpdateInfo } from "../update.ts";
import { ApiClient, HttpError } from "./client.ts";
import { ensureDaemon } from "./daemon.ts";
import { applyPorts } from "./setup-apply.ts";
import { mkdir, realpath, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { lastSetupPath } from "../report/diagnostics.ts";
import { LoginCard, openInBrowser, osc52 } from "./login-card.ts";
import { MODAL_MARGIN, modalOverlayOptions, type OverlaySize } from "./modal.ts";
import { activityLabel } from "./blocks/subagents.ts";
import { Picker, PICKER_HINTS } from "./picker.ts";
import { displayState } from "./panes/dag.ts";
import { SessionsPicker } from "./panes/sessions.ts";
import { chooseTheme, FileTuiPreferences, resolveIconSet, type TuiPreferencesStore } from "./preferences.ts";
import { gateKey } from "./key-gate.ts";
import { pastedImageFile, readClipboardImage, readClipboardText, type ClipboardImage } from "./clipboard.ts";
import { ComposerAttachments, IMAGE_EXTENSIONS, imageMarker, imagePathFromPaste, MACOS_IMAGE_EXTENSIONS, type StagedImage } from "./attachments.ts";
import { EnhancedPasteController } from "./enhanced-paste.ts";
import { DEFAULT_CONTEXT_WINDOW, expandContextReferences, listWorkspaceEntries } from "./context-refs.ts";
import type { InboundImage } from "../channels/types.ts";
import { parseInboundImages, type MessageImageMime } from "../core/message-images.ts";
import { Screen } from "./screen.ts";
import { LOCAL_COMMANDS, readResearchReport, researchDetails, researchPickerOptions, researchText, SlashMenu } from "./slash.ts";
import { type AskView, ChatState } from "./state.ts";
import { bold, color, glyph, isThemeName, link, modalSizing, setIconSet, setTheme, THEME_NAMES, type ThemeName, themeName, themes } from "./theme.ts";

const CHANNEL = "tui";
/** The ask modal's free-text row id; never a numeric option index. */
const ASK_CUSTOM = "custom";
/** Question text rows shown above an ask's choices before it is elided. */
const ASK_QUESTION_ROWS = 6;
/** Below this terminal height the ask modal drops section headers and the tab spacer and shows at most two question rows. */
const ASK_ROOMY_ROWS = 30;
const ASK_QUESTION_ROWS_SHORT = 2;
/** Room for a right-aligned `default` tag after a choice label (tag + two-cell gap). */
const ASK_TAG_ROOM = "default".length + 2;

/** `[Q1]  Q2 sent  Q3`: the shown question bracketed in bold primary text, the rest gray-bright; answered ones keep their number. */
export function askTabRow(tabs: readonly { readonly id: string; readonly number: number; readonly sent: boolean }[], current: string, width: number): string {
	const parts = tabs.map(tab => {
		const label = `Q${tab.number}${tab.sent ? " sent" : ""}`;
		return tab.id === current ? bold(color.textPrimary(`[${label}]`)) : tab.sent ? color.gray(label) : color.grayBright(label);
	});
	return truncateToWidth(parts.join("  "), Math.max(0, width), glyph.ellipsis);
}

/**
 * The standard centered modal, widened (up to the standard maximum width) so the longest choice fits on one row: choices are
 * the content a human must read in full to decide. Wider than that, labels fall back to the picker's ellipsis.
 */
export function askOverlayOptions(size: OverlaySize, labels: readonly string[]): OverlayOptions {
	const base = modalOverlayOptions(size);
	const longest = Math.max(0, ...labels.map(label => visibleWidth(label)));
	// + the `default` tag and its gap, which may sit on the longest row.
	// Row mark, scrollbar gutter, both borders, horizontal padding and the blank margin around the frame.
	const needed = longest + ASK_TAG_ROOM + 2 + 2 + 2 + modalSizing.hPad * 2 + MODAL_MARGIN * 2;
	const limit = Math.min(size.cols - 4, modalSizing.maxWidth) + MODAL_MARGIN * 2;
	return typeof base.width === "number" && needed > base.width ? { ...base, width: Math.max(base.width, Math.min(needed, limit)) } : base;
}

/** Coarse time left until an ask's default applies: `45s`, `12m`, `23h`, `3d`. */
export function askCountdown(ms: number): string {
	const seconds = Math.max(0, Math.ceil(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
	if (seconds < 172_800) return `${Math.floor(seconds / 3600)}h`;
	return `${Math.floor(seconds / 86_400)}d`;
}
/** Bracketed paste markers; the composer checks whole-payload image paths between them. */
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** `setup`: open the setup wizard at start (`dinobot setup [section]`); the value is the section, "" for all of it. */
export type TuiOptions = { readonly manifest: Manifest; readonly manifestPath: string; readonly thread?: string; readonly setup?: string };

export async function runTui(options: TuiOptions): Promise<void> {
	const recovered = await recoverSetup(options.manifest, options.manifestPath);
	const daemon = await ensureDaemon(options.manifest, options.manifestPath);
	const app = new ChatApp(daemon.client, options.manifest, options.thread ?? newThreadName(), daemon.startedPid, await gitBranch(), undefined, undefined, { checkUpdate: signal => checkForUpdate({ signal }) });
	// Install process hooks only for the CLI owner, never for embedded/test ChatApps.
	process.once("exit", () => app.stop());
	process.once("SIGINT", () => process.exit(130));
	process.once("SIGTERM", () => process.exit(143));
	process.once("SIGHUP", () => process.exit(129));
	app.start();
	if (recovered) app.chat.notice(setupCopy(resolveLocale(detectLocale())).applyOutcome.recovered, "info");
	if (options.setup !== undefined) app.openSetup(options.setup);
}

/**
 * A TUI that died while applying setup left a journal next to the manifest; bring the file back in line with the running
 * daemon before connecting (src/setup/apply.ts, invariant I4). True when the previous settings were restored.
 */
async function recoverSetup(manifest: Manifest, manifestPath: string): Promise<boolean> {
	if (manifest.api === undefined) return false;
	const path = await realpath(manifestPath).catch(() => undefined);
	if (path === undefined) return false;
	const client = new ApiClient(new URL(`http://127.0.0.1:${manifest.api.port}`));
	return (await recoverInterruptedApply(path, applyPorts(client, manifest.dataDir))) === "recovered";
}

/** A fresh thread name: local-free UTC timestamp plus a short random suffix so two TUIs opened in the same second do not share it. */
export function newThreadName(now = new Date(), random = Math.random): string {
	const suffix = Math.floor(random() * 0x10000).toString(16).padStart(4, "0");
	return `${now.toISOString().slice(0, 19).replace(/[-:T]/g, "")}-${suffix}`;
}

async function gitBranch(): Promise<string | undefined> {
	try {
		const result = await Bun.$`git rev-parse --abbrev-ref HEAD`.quiet().nothrow();
		return result.exitCode === 0 ? result.stdout.toString().trim() : undefined;
	} catch {
		return undefined;
	}
}

function contextWindowOf(manifest: Manifest): number | undefined {
	try {
		return createModels().getModel(manifest.model.provider, manifest.model.modelId)?.contextWindow;
	} catch {
		return undefined;
	}
}

function renderAuthEvent(event: AuthEvent): string {
	switch (event.type) {
		case "info":
			return [event.message, ...(event.links ?? []).map((item) => (item.label === undefined ? link(item.url) : `${item.label}: ${link(item.url)}`))].join("\n");
		case "progress":
			return event.message;
		case "auth_url":
			return `${event.instructions ?? "Open this URL in your browser to continue:"}\n${link(event.url)}`;
		case "device_code":
			return `Open ${link(event.verificationUri)}\nand enter the code ${bold(color.warning(event.userCode))}`;
	}
}

/** How an applied (or refused) setup change reads in the transcript. */
export function describeApply(outcome: ApplyOutcome, copy: SetupCopy, request: ManifestApplyRequest): { text: string; level: "success" | "info" | "error" } {
	const text = copy.applyOutcome;
	switch (outcome.status) {
		case "applied":
			return { text: [copy.applied, ...request.changes, ...request.summary].join("\n"), level: "success" };
		case "saved_external":
			// The summary describes the saved settings and carries the onboarding's closing invitation.
			return { text: [text.external(request.manifestPath), ...request.changes, ...request.summary].join("\n"), level: "info" };
		case "conflict":
			return { text: text.conflict, level: "error" };
		case "invalid":
			return { text: text.invalid(outcome.problems.map((problem) => `- ${problem}`).join("\n")), level: "error" };
		case "unreachable":
			return { text: text.unreachable, level: "error" };
		case "older_daemon":
			return { text: text.olderDaemon, level: "error" };
		case "other_manifest":
			return { text: text.otherManifest(outcome.path), level: "error" };
		case "unsafe_change":
			return { text: text.unsafeChange, level: "error" };
		case "busy":
			return { text: text.busy(outcome.threads.join(", ")), level: "error" };
		case "stuck":
			return { text: text.stuck(outcome.pid), level: "error" };
		case "rolled_back":
			return { text: text.rolledBack(outcome.reason, outcome.log), level: "error" };
		case "failed":
			return { text: text.failed(outcome.reason, outcome.log), level: "error" };
	}
}

/** Write the failed apply where the report collectors look for it (src/report/diagnostics.ts lastSetupPath), mode 0600. */
export async function recordSetupFailure(dataDir: string, outcome: ApplyOutcome, manifestPath: string, now = new Date()): Promise<void> {
	const path = lastSetupPath(dataDir);
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const tmp = `${path}.${process.pid}.tmp`;
	const detail = outcome.status === "failed" || outcome.status === "rolled_back" ? { reason: outcome.reason, log: outcome.log.slice(-64 * 1024) } : outcome.status === "stuck" ? { pid: outcome.pid } : {};
	await writeFile(tmp, JSON.stringify({ at: now.toISOString(), status: outcome.status, manifestPath, ...detail }), { mode: 0o600 });
	await rename(tmp, path);
}

const usageOf = (command: CommandInfo): string => `/${command.name}${command.usage === undefined ? "" : ` ${command.usage}`}`;

type CommandRun = {
	readonly name: string;
	readonly quietSuccess: boolean;
	readonly controller: AbortController;
	runId: string | undefined;
	promptId: string | undefined;
	/** The open select picker for the pending prompt. */
	picker: Picker | undefined;
	/** The login card following this run; it outlives the run until the user dismisses it. */
	card: LoginCard | undefined;
	finished: Promise<void>;
	/** A `done` or `error` event arrived; the daemon ends every run with one, so a stream that closes without it was cut off. */
	ended: boolean;
	/** A manifest change `/setup` handed over; applied once the run ended normally. */
	apply: ManifestApplyRequest | undefined;
};

/** Side effects the login card triggers; tests inject fakes. */
export type ChatAppHooks = {
	/** CLI-owned passive check; embedded apps remain network-free unless explicitly supplied. */
	readonly checkUpdate?: (signal: AbortSignal) => Promise<UpdateInfo | null>;
	readonly open?: (url: string) => void; readonly copy?: (text: string) => void; readonly preferences?: TuiPreferencesStore;
	/** Clipboard access; tests inject fakes so paste flows run without a real clipboard. */
	readonly clipboard?: { readonly readImage: () => Promise<ClipboardImage | null>; readonly readText: () => Promise<string | null>;
		readonly imageFromFile: (path: string) => Promise<{ readonly data: Uint8Array; readonly mimeType: MessageImageMime; readonly preview?: Uint8Array } | undefined> } };

export class ChatApp {
	readonly screen: Screen;
	private state = new ChatState();
	private readonly userId = userInfo().username;
	private readonly defaultModel: string;
	private thread: string;
	private closeSessions: (() => void) | undefined;
	private readonly autoShownAsks = new Set<string>();
	private unsubscribeAsks: (() => void) | undefined;
	private closeAskPicker: (() => void) | undefined;
	private stream: AbortController | undefined;
	private child: { stream: AbortController; state: ChatState; taskId: string } | undefined;
	private serverCommands: readonly CommandInfo[] = [];
	private commandRun: CommandRun | undefined;
	private reasoningQueue: { pending: number } | undefined;
	/** The one in-flight send-now or withdraw request (ADR 0036). */
	private queueRequest: Promise<void> | undefined;
	private readonly attachments = new ComposerAttachments();
	/** Reserve payload capacity until a send settles, so failure can merge with a new draft. */
	private pendingSend: { images: readonly StagedImage[] } | undefined;
	private readonly paste: EnhancedPasteController;
	private readonly clipboard: NonNullable<ChatAppHooks["clipboard"]>;
	private modelRevision = 0;
	private loginOffered = false;
	/** A setup change is being applied: the daemon may be restarting, so nothing is sent until it is back. */
	private applying = false;
	private setupHinted = false;
	private started = false;
	private readonly updateCheck = new AbortController();
	private readonly checkUpdate: ChatAppHooks["checkUpdate"];
	private readonly openUrl: (url: string) => void;
	private readonly copyText: (text: string) => void;
	private readonly preferences: TuiPreferencesStore;

	constructor(
		private readonly client: ApiClient,
		private readonly manifest: Manifest,
		thread: string,
		private readonly startedPid: number | undefined,
		private readonly branch: string | undefined,
		contextWindow: number | undefined = contextWindowOf(manifest),
		terminal: Terminal = new ProcessTerminal(),
		hooks: ChatAppHooks = {},
	) {
		this.checkUpdate = hooks.checkUpdate;
		this.preferences = hooks.preferences ?? new FileTuiPreferences();
		this.clipboard = hooks.clipboard ?? { readImage: readClipboardImage, readText: readClipboardText, imageFromFile: (path) => pastedImageFile(path) };
		this.paste = new EnhancedPasteController({
			write: (data) => this.screen.tui.terminal.write(data),
			pasteText: (text) => this.pasteText(text),
			pasteImage: (image) => void this.stageImage(image),
			showStatus: (message) => this.state.notice(message, "info"),
		});
		this.openUrl = hooks.open ?? openInBrowser;
		this.copyText = hooks.copy ?? ((text) => this.screen.tui.terminal.write(osc52(text)));
		this.thread = thread;
		this.defaultModel = `${manifest.model.provider}/${manifest.model.modelId}`;
		this.screen = new Screen(terminal, this.state, {
			thread: `${CHANNEL}:${thread}`,
			cwd: process.cwd(),
			...(branch === undefined ? {} : { branch }),
			model: this.defaultModel,
			toolMode: manifest.toolMode,
			...(contextWindow === undefined ? {} : { contextWindow }),
			version: CURRENT_VERSION,
		});
		const preferences = this.preferences.load();
		setIconSet(resolveIconSet(preferences));
		setTheme(chooseTheme(preferences).theme);
		this.screen.setToolsExpanded(preferences.toolsExpanded);
		this.screen.prompt.onChange = () => this.syncAttachments();
		this.screen.prompt.menu = new SlashMenu({ commands: () => this.commands(), arguments: (name) => this.argumentsOf(name), files: () => listWorkspaceEntries(process.cwd()) }, () => this.screen.requestRender());
	}

	get chat(): ChatState {
		return this.state;
	}

	/** Active images in prompt-token order, shared by preview and send. */
	get stagedImages(): readonly StagedImage[] {
		return this.attachments.resolve(this.screen.prompt.getExpandedText()).images;
	}

	private syncAttachments(): void {
		this.attachments.observe(this.screen.prompt.getExpandedText());
		this.screen.prompt.setAttachments(this.stagedImages, this.attachments.markers);
		this.screen.requestRender();
	}

	start(): void {
		if (this.started || this.updateCheck.signal.aborted) return;
		this.started = true;
		this.screen.prompt.onSubmit = (text, draft) => void this.submit(draft ?? text);
		this.screen.transcript.onOpen = (progress) => this.openSubagent(progress);
		this.screen.tui.addInputListener((data) => this.onKey(data));
		this.screen.start();
		this.paste.enable();
		this.attach(this.thread);
		void this.loadCommands();
		void this.loadUpdateNotice();
	}

	private async loadUpdateNotice(): Promise<void> {
		try {
			const info = await this.checkUpdate?.(this.updateCheck.signal);
			if (info && !this.updateCheck.signal.aborted) this.screen.setUpdateNotice(info);
		} catch {
			// An optional registry check must never interrupt login, input, or the daemon connection.
		}
	}

	private onKey(data: string): TuiInputListenerResult {
		// kitty OSC 5522 clipboard packets are consumed before anything else can mangle them; a trailing
		// keystroke glued after a packet is handed back rewritten.
		const rest = this.paste.feed(data);
		if (rest === null) return { consume: true };
		if (rest !== data) return rest === "" ? { consume: true } : { data: rest };
		const through = this.maybeImagePathPaste(data);
		if (through !== undefined) return through === "" ? { consume: true } : { data: through };
		// Act once per physical stroke: Kitty release/repeat events would otherwise undo a toggle (see key-gate.ts).
		const gate = gateKey(data);
		if (gate === "pass") return undefined;
		if (gate === "swallow") return { consume: true };
		const { screen } = this;
		const prompt = screen.prompt;
		const answering = screen.mode === "prompt" && prompt.answer !== undefined;
		if (matchesKey(data, "ctrl+c")) {
			if (screen.modal !== undefined) screen.modal.cancel();
			else if (answering) prompt.cancelAnswer();
			else if (screen.mode === "prompt" && prompt.getText() !== "") prompt.setText("");
			else this.quit();
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+d")) {
			this.quit();
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+x")) {
			screen.toggleView("shortcuts");
			return { consume: true };
		}
		if (screen.tui.hasOverlay()) return undefined;
		if (matchesKey(data, "ctrl+t")) {
			screen.toggleTodoPane();
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+o")) {
			screen.toggleView("tools");
			try {
				this.preferences.save({ ...this.preferences.load(), toolsExpanded: screen.toolsExpanded });
			} catch (error) {
				this.state.notice(`Tool display changed for this session, but could not save preferences: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+e")) {
			screen.toggleView("thinking");
			return { consume: true };
		}
		if (answering || (screen.mode === "prompt" && prompt.menuOpen)) return undefined;
		// Ctrl+V reads the system clipboard (image first, text fallback); Ctrl+Alt+V removes the last image token.
		if (matchesKey(data, "ctrl+v") && this.canCompose() && !prompt.getText().trimStart().startsWith("/")) {
			void this.pasteFromClipboard();
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+alt+v") && this.canCompose()) {
			const last = this.stagedImages.at(-1);
			if (last === undefined) return undefined;
			prompt.setText(prompt.getExpandedText().replaceAll(imageMarker(last.id), ""));
			return { consume: true };
		}
		if (matchesKey(data, "down") && screen.queueKeys) {
			this.editLastQueued();
			return { consume: true };
		}
		if (screen.mode === "prompt" && !screen.inTakeover && screen.reasoningUsable && matchesKey(data, "shift+tab")) {
			this.queueReasoningCycle();
			return { consume: true };
		}
		if (matchesKey(data, "tab") && !screen.inTakeover) {
			screen.toggleFocus();
			return { consume: true };
		}
		if (screen.inTakeover && (matchesKey(data, "escape") || matchesKey(data, "q"))) {
			this.closeSubagent();
			return { consume: true };
		}
		if (matchesKey(data, "escape") && screen.mode === "prompt") {
			if (this.commandRun !== undefined) this.cancelCommand(this.commandRun);
			else if (this.state.data.run) void this.client.abort(CHANNEL, this.thread).catch((error) => this.error(error));
			else return undefined;
			return { consume: true };
		}
		return undefined;
	}

	private attach(thread: string): void {
		this.unsubscribeAsks?.();
		this.closeAskPicker?.();
		this.closeSessions?.();
		this.reasoningQueue = undefined;
		this.closeAgentPicker?.();
		this.closeDagPicker?.();
		this.stream?.abort();
		this.closeSubagent();
		if (this.commandRun !== undefined) this.cancelCommand(this.commandRun);
		this.thread = thread;
		this.pendingSend = undefined;
		this.screen.prompt.setText(this.attachments.resolve(this.screen.prompt.getExpandedText()).text);
		this.screen.prompt.clearEditHistory();
		this.attachments.clear();
		this.syncAttachments();
		this.state = new ChatState();
		this.screen.info.thread = `${CHANNEL}:${thread}`;
		this.screen.resetReasoning();
		this.screen.bind(this.state);
		this.unsubscribeAsks = this.state.subscribe(() => {
			if (this.openAsks().some(ask => !this.autoShownAsks.has(ask.id)) && this.screen.modal === undefined
				&& !this.state.data.run && this.screen.prompt.getText().trim() === ""
				&& !this.screen.inTakeover && !this.updateCheck.signal.aborted) this.openAskPicker(true);
		});
		const controller = new AbortController();
		this.stream = controller;
		const revision = ++this.modelRevision;
		const state = this.state;
		this.client
			.events(CHANNEL, thread, (event) => state.apply(event), controller.signal)
			.then(() => {
				if (!controller.signal.aborted) state.notice("disconnected from dinobot daemon; restart the TUI. To report the problem: dinobot report send --trigger daemon-down", "error");
			})
			.catch((error) => {
				if (!controller.signal.aborted) this.error(error);
			});
		this.client.threadModel(CHANNEL, thread).then(
			(model) => {
				if (this.client.initialCwd) void this.client.workspace(CHANNEL, thread).then(cwd => {
					if (!controller.signal.aborted && cwd && cwd !== this.client.initialCwd) state.notice(`Resumed session uses ${cwd}. Start a new session to use ${this.client.initialCwd}.`);
				}).catch(error => { if (!controller.signal.aborted) this.error(error); });
				if (!controller.signal.aborted && this.modelRevision === revision) this.screen.setModelState(model);
				// Fresh install: nothing is signed in yet. That is expected, so open setup (or, on an older daemon, the login)
				// instead of letting the first message fail.
				if (!controller.signal.aborted && model.signedIn === false && !this.loginOffered && this.commandRun === undefined) {
					this.loginOffered = true;
					void this.firstRun(state);
				} else if (!controller.signal.aborted && model.signedIn !== false && !this.setupHinted) {
					this.setupHinted = true;
					void this.hintUnfinishedSetup(state);
				}
			},
			(error: unknown) => {
				if (!controller.signal.aborted && this.modelRevision === revision) this.error(error);
			},
		);
	}

	private async loadCommands(): Promise<void> {
		try {
			this.serverCommands = await this.client.commands();
			this.screen.setReasoningEnabled(this.serverCommands.some((command) => command.name === "reasoning"));
			this.screen.prompt.refreshMenu();
		} catch (error) {
			if (error instanceof HttpError && error.status === 404) {
				this.state.notice("The running dinobot daemon is older than this TUI, so slash commands like /login and /model are unavailable. Restart it: pkill -f 'dinobot serve', then open dinobot again.", "error");
			} else this.error(error);
		}
	}

	/** The dropdown's command set: the TUI's own commands plus what the daemon enables, sorted by name; a local name shadows a server one. */
	private commands(): CommandInfo[] {
		const local = new Set(LOCAL_COMMANDS.map((command) => command.name));
		return [...LOCAL_COMMANDS, ...this.serverCommands.filter((command) => !local.has(command.name) && command.name !== "threads")].sort((a, b) => a.name.localeCompare(b.name));
	}

	private async argumentsOf(name: string): Promise<readonly CommandArgument[]> {
		switch (name) {
			case "thread": {
				const threads = await this.client.threads().catch((error: unknown) => (this.error(error), []));
				return threads
					.filter(({ key }) => key.startsWith(`${CHANNEL}:`))
					.map(({ key }) => {
						const thread = key.slice(CHANNEL.length + 1);
						return { value: thread, label: thread, ...(thread === this.thread ? { description: "current" } : {}) };
					});
			}
			case "theme":
				return THEME_NAMES.map((name) => ({ value: name, label: name, description: `${themes[name].label} · ${themes[name].species}${name === themeName() ? " · current" : ""}` }));
			case "agents":
				return [...this.state.data.subagents.values()].filter((progress) => progress.taskId !== "").map((progress) => ({ value: progress.taskId, label: progress.taskId, description: progress.description }));
			case "dag":
			case "new":
			case "quit":
			case "sessions":
			case "threads":
				return [];
			default:
				try {
					return await this.client.commandArguments(name, CHANNEL, this.thread);
				} catch (error) {
					if (!(error instanceof HttpError && error.status === 404)) this.error(error);
					return [];
				}
		}
	}

	/** True when the main composer can take a paste right now: no overlay, no answer prompt, no takeover. */
	private canCompose(): boolean {
		const { screen } = this;
		return screen.mode === "prompt" && !screen.inTakeover && !screen.tui.hasOverlay() && screen.prompt.answer === undefined && !screen.prompt.menuOpen;
	}

	/** Route a plain clipboard text payload into the editor, or explain why it cannot land there. */
	private pasteText(text: string): void {
		if (text === "") return;
		if (!this.canCompose()) {
			this.state.notice("Text paste is not available in this view", "info");
			return;
		}
		this.screen.prompt.insertTextAtCursor(text);
		this.screen.requestRender();
	}

	/** Stage one image, or surface the bound it violates. */
	private stageImage(image: InboundImage, preview?: Uint8Array): void {
		if (!this.canCompose() || this.screen.prompt.getText().trimStart().startsWith("/")) {
			this.state.notice("Image paste is not available in this view", "info");
			return;
		}
		const staged = this.attachments.add(image, this.screen.prompt.getExpandedText(), this.pendingSend?.images, preview && Buffer.from(preview).toString("base64"));
		if (typeof staged === "string") this.state.notice(`Image not attached: ${staged}`, "error");
		else {
			this.syncAttachments();
			this.screen.prompt.insertTextAtCursor(imageMarker(staged.id));
		}
	}

	/** Ctrl+V: image first, text fallback, honest notice when the clipboard holds neither. */
	private async pasteFromClipboard(): Promise<void> {
		const state = this.state;
		const image = await this.clipboard.readImage();
		if (this.state !== state) return;
		if (image !== null) {
			this.stageImage({ mimeType: image.mimeType, data: Buffer.from(image.data).toString("base64") }, image.preview);
			return;
		}
		const text = await this.clipboard.readText();
		if (this.state !== state) return;
		if (text !== null && text !== "") this.pasteText(text);
		else this.state.notice("Clipboard has no image or text", "info");
	}

	/**
	 * A bracketed paste whose whole payload is one image-file path attaches that file instead of
	 * inserting the path. Returns the bytes still to dispatch (empty when the paste was consumed), or
	 * undefined when the payload is not a path paste and must flow to the editor untouched. Only
	 * complete-in-one-chunk pastes are intercepted; fragmented ones keep the Editor's own handler.
	 */
	private maybeImagePathPaste(data: string): string | undefined {
		if (!this.canCompose() || this.screen.prompt.getText().trimStart().startsWith("/")) return undefined;
		const start = data.indexOf(PASTE_START);
		if (start === -1) return undefined;
		const end = data.indexOf(PASTE_END, start);
		if (end === -1) return undefined;
		const text = data.slice(start + PASTE_START.length, end);
		const path = imagePathFromPaste(text, process.platform === "darwin" ? MACOS_IMAGE_EXTENSIONS : IMAGE_EXTENSIONS);
		if (path === undefined) return undefined;
		const state = this.state;
		void this.clipboard.imageFromFile(path).then((image) => {
			if (this.state !== state) return;
			if (image) this.stageImage({ mimeType: image.mimeType, data: Buffer.from(image.data).toString("base64") }, image.preview);
			else this.state.notice(`${path} is not a readable png/jpeg/gif/webp image`, "error");
		});
		return data.slice(0, start) + data.slice(end + PASTE_END.length);
	}

	private async submit(raw: string): Promise<void> {
		const resolved = this.attachments.resolve(raw);
		const text = resolved.text.trim();
		const staged = resolved.images;
		const prompt = this.screen.prompt;
		if (this.pendingSend !== undefined) {
			prompt.setText(raw);
			this.state.notice("A message is still being sent; draft kept", "info");
			return;
		}
		if (this.applying) {
			prompt.setText(raw);
			this.state.notice(this.setupCopy().applying, "info");
			return;
		}
		if (text.startsWith("/") && staged.length > 0) {
			prompt.setText(raw);
			this.state.notice("Remove image tokens before running a slash command", "info");
			return;
		}
		// Kill/yank or pasted known tokens can combine earlier valid drafts into an over-limit one.
		const validated = parseInboundImages(staged);
		if (typeof validated === "string") {
			prompt.setText(raw);
			this.state.notice(`Message not sent: ${validated}`, "error");
			return;
		}
		if (text === "" && staged.length === 0) {
			prompt.clearEditHistory();
			this.attachments.clear();
			this.syncAttachments();
			// The editor submits an empty draft too; with input queued that Enter means "send it now" (ADR 0036).
			if (this.state.data.queue.length > 0 && !this.screen.inTakeover) this.sendQueuedNow();
			return;
		}
		if (text !== "") this.screen.prompt.addToHistory(text);
		// Opening a local browser must not consume an unrelated draft.
		if (/^\/(sessions|threads)(?:\s|$)/.test(text)) {
			if (this.screen.prompt.getText().trim() === text) this.screen.prompt.setText("");
			return this.command(text);
		}
		this.screen.prompt.setText("");
		this.attachments.clear();
		prompt.clearEditHistory();
		this.syncAttachments();
		if (text.startsWith("/")) return this.command(text);
		const pending = { images: staged };
		this.pendingSend = pending;
		const state = this.state;
		const thread = this.thread;
		try {
			// Hermes-style `@file:`/`@folder:`/`@diff`/`@staged`/`@git:N`: the TUI expands them; channels never do.
			const expansion = await expandContextReferences(text, { cwd: process.cwd(), contextWindow: this.screen.info.contextWindow ?? DEFAULT_CONTEXT_WINDOW, blockedDirs: [this.manifest.dataDir] });
			if (expansion.warnings.length > 0) state.notice(expansion.warnings.join("\n"), expansion.blocked ? "error" : "info");
			const sent = await this.client.send(CHANNEL, thread, expansion.message, this.userId, state.data.run ? "steer" : undefined, staged.length > 0 ? staged.map(({ mimeType, data }) => ({ mimeType, data })) : undefined);
			const auto = sent ? sent.autoReport : undefined;
			if (auto) {
				const id = auto.id.slice(0, 8);
				state.notice(`자동 보고 ${id} 예약됨 (불만 표현 감지) · 약 30초 뒤 전송 · 취소: /report undo ${id} · 끄기: /report auto off`, "info");
			}
		} catch (error) {
			if (this.state === state) {
				const concurrent = prompt.getExpandedText();
				this.attachments.restore(staged);
				this.syncAttachments();
				prompt.setText(raw + (concurrent ? `\n${concurrent}` : ""));
			}
			state.notice(error instanceof Error ? error.message : String(error), "error");
		} finally {
			if (this.pendingSend === pending) this.pendingSend = undefined;
		}
	}

	/** Deliver the whole queue now; one queue request at a time, so a held key cannot stack them. */
	private sendQueuedNow(): void {
		if (this.queueRequest !== undefined) return;
		const thread = this.thread;
		const state = this.state;
		this.queueRequest = this.client.sendQueued(CHANNEL, thread)
			.then((result) => { if (result.sent === 0) state.notice("Nothing left to send: the queued input already reached the agent.", "info"); })
			.catch((error: unknown) => state.notice(error instanceof Error ? error.message : String(error), "error"))
			.finally(() => { this.queueRequest = undefined; });
	}

	/**
	 * ↓ on an empty prompt: withdraw the newest queued input and put its original text back in the prompt. Withdrawn text
	 * is never dropped: a draft typed meanwhile stays below it. An input a boundary already delivered stays delivered.
	 */
	private editLastQueued(): void {
		const last = this.state.data.queue.at(-1);
		if (last === undefined || this.queueRequest !== undefined) return;
		const state = this.state;
		const prompt = this.screen.prompt;
		this.queueRequest = this.client.withdrawQueued(CHANNEL, this.thread, last.id)
			.then((result) => {
				if (result.status === "withdrawn") {
					const draft = prompt.getText();
					prompt.setText(draft === "" ? result.item.text : `${result.item.text}\n${draft}`);
					this.screen.requestRender();
				} else state.notice(result.status === "already_placed" ? "That queued input already reached the agent." : "That input is no longer queued.", "info");
			})
			.catch((error: unknown) => state.notice(error instanceof Error ? error.message : String(error), "error"))
			.finally(() => { this.queueRequest = undefined; });
	}

	private async command(text: string): Promise<void> {
		const [name = "", ...rest] = text.slice(1).split(/\s+/);
		const argument = rest.join("-");
		switch (name) {
			case "new":
				return this.attach(argument || newThreadName());
			case "thread":
				if (argument === "") return this.state.notice("usage: /thread <name>", "error");
				return this.attach(argument);
			case "agents": {
				if (argument === "") return this.chooseSubagent();
				const subagents = [...this.state.data.subagents.values()];
				const target = argument === "" ? subagents.at(-1) : subagents.find((progress) => progress.taskId === argument);
				if (target === undefined) return this.state.notice(subagents.length === 0 ? "no subagents in this thread yet" : `unknown subagent ${argument}; known: ${subagents.map((progress) => progress.taskId).join(", ")}`, "error");
				return this.openSubagent(target);
			}
			case "choose":
				return this.openAskPicker(false);
			case "theme":
				if (argument === "") return this.chooseTheme();
				if (!isThemeName(argument.toLowerCase())) return this.state.notice(`unknown theme ${argument}; choose one of ${THEME_NAMES.join(", ")}`, "error");
				return this.applyTheme(argument.toLowerCase() as ThemeName);
			case "dag":
				return this.chooseDagNode();
			case "threads": // Backward-compatible, intentionally absent from help/completion.
			case "sessions":
				return this.chooseSession();
			case "quit":
			case "exit":
				return this.quit();
			case "help":
				if (!this.commands().some((command) => command.name === "help")) return this.state.notice("unknown command /help", "error");
				return this.help();
			default:
				return this.runCommand(name, text.slice(1 + name.length).trim());
		}
	}

	/** The picker owns one live stream; closing it never alters the underlying chat. */
	private chooseSession(): void {
		this.closeSessions?.();
		const controller = new AbortController();
		const current = `${CHANNEL}:${this.thread}`;
		const picker = new SessionsPicker(current, {
			onChoose: key => {
				// attach/send/model all use CHANNEL; external sessions are display-only.
				if (!key.startsWith(`${CHANNEL}:`) || key.length <= CHANNEL.length + 1) return;
				close();
				if (key !== current) this.attach(key.slice(CHANNEL.length + 1));
			},
			onCancel: () => close(),
			onDelete: key => {
				if (!key.startsWith(`${CHANNEL}:`) || key === current) return;
				this.client.deleteThread(CHANNEL, key.slice(CHANNEL.length + 1)).then(outcome => {
					if (controller.signal.aborted) return;
					const reason = {
						deleted: `Deleted ${key}`,
						not_found: `${key} is already gone`,
						busy: `${key} is working (run, queued input or subagents); stop it before deleting`,
						moved: `${key} changed meanwhile; try again`,
						quarantined: `${key} holds quarantined claims; reconcile them before deleting`,
					}[outcome.status];
					picker.setNote(reason, outcome.status === "deleted" || outcome.status === "not_found" ? "info" : "error");
					this.screen.requestRender();
				}).catch((error: unknown) => {
					if (controller.signal.aborted) return;
					picker.setNote(error instanceof HttpError && error.status === 404 ? "This daemon cannot delete sessions; restart it to update" : String(error), "error");
					this.screen.requestRender();
				});
			},
		}, () => this.screen.size());
		const close = () => {
			controller.abort();
			this.screen.closeModal(picker);
			if (this.closeSessions === close) this.closeSessions = undefined;
		};
		this.closeSessions = close;
		this.screen.openModal(picker, modalOverlayOptions(this.screen.size()));
		this.client.sessionsEvents(snapshot => {
			if (controller.signal.aborted) return;
			picker.update(snapshot);
			this.screen.requestRender();
		}, controller.signal).then(() => {
			if (controller.signal.aborted) return;
			picker.fail("Sessions disconnected; close and reopen to retry");
			this.screen.requestRender();
		}).catch((error: unknown) => {
			if (controller.signal.aborted) return;
			picker.fail(error instanceof HttpError && error.status === 404 ? "This daemon has no live sessions; restart it to update" : String(error));
			this.screen.requestRender();
		});
	}

	private help(): void {
		const commands = this.commands();
		const width = Math.max(0, ...commands.map((command) => usageOf(command).length));
		this.state.notice(commands.map((command) => `${color.textPrimary(usageOf(command).padEnd(width))}  ${command.description}`).join("\n"));
	}

	private queueReasoningCycle(): void {
		if (this.commandRun !== undefined && !(this.reasoningQueue !== undefined && this.commandRun.name === "reasoning" && this.commandRun.quietSuccess)) return;
		if (this.reasoningQueue !== undefined) {
			this.reasoningQueue.pending++;
			return;
		}
		const queue = { pending: 1 };
		this.reasoningQueue = queue;
		void this.drainReasoningCycles(queue);
	}

	private async drainReasoningCycles(queue: { pending: number }): Promise<void> {
		try {
			while (this.reasoningQueue === queue && queue.pending > 0) {
				const screen = this.screen;
				if (this.commandRun !== undefined || screen.mode !== "prompt" || screen.inTakeover || screen.tui.hasOverlay() || screen.prompt.answer !== undefined || screen.prompt.menuOpen || !screen.reasoningUsable) break;
				queue.pending--;
				await this.runCommand("reasoning", "cycle", true);
			}
		} finally {
			if (this.reasoningQueue === queue) this.reasoningQueue = undefined;
		}
	}

	/** Opens `/setup` (the whole wizard for "", else one section); used by `dinobot setup`. */
	openSetup(section: string): void {
		this.loginOffered = true;
		void this.runCommand("setup", section);
	}

	/** First start without a signed-in model: the setup wizard, or `/login` on a daemon that has no `/setup` yet. */
	private async firstRun(state: ChatState): Promise<void> {
		const commands = await this.client.commands().catch(() => [] as CommandInfo[]);
		if (this.state !== state || this.commandRun !== undefined) return;
		if (commands.some((command) => command.name === "setup")) return this.runCommand("setup", "");
		state.notice(this.setupCopy().welcome, "info");
		return this.runCommand("login", "");
	}

	/** Setup was started (a model got connected) but never finished: say once where to continue. */
	private async hintUnfinishedSetup(state: ChatState): Promise<void> {
		let info: Awaited<ReturnType<ApiClient["daemonInfo"]>>;
		try {
			info = await this.client.daemonInfo();
		} catch {
			return; // an older daemon or one that is going away: nothing to hint
		}
		if (info?.setup?.startedAt !== undefined && info.setup.completedAt === undefined && this.state === state) {
			state.notice(this.setupCopy().resumeHint, "info");
		}
	}

	private setupCopy(locale = this.client.locale): SetupCopy {
		return setupCopy(resolveLocale(locale));
	}

	private async runCommand(name: string, args: string, quietSuccess = false): Promise<void> {
		if (this.commandRun !== undefined) return this.state.notice(`/${this.commandRun.name} is still running; press Esc to stop it`, "error");
		if (this.applying) return this.state.notice(this.setupCopy().applying, "info");
		const run: CommandRun = { name, quietSuccess, controller: new AbortController(), runId: undefined, promptId: undefined, picker: undefined, card: undefined, finished: Promise.resolve(), ended: false, apply: undefined };
		this.commandRun = run;
		if (name === "login" && args !== "") this.openLoginCard(run, args, true);
		run.finished = (async () => {
			try {
				await this.client.runCommand(CHANNEL, this.thread, name, args, this.userId, (event) => this.onCommandEvent(run, event), run.controller.signal);
				if (!run.ended && !run.controller.signal.aborted) throw new Error(`the daemon closed /${name} before it finished`);
				if (run.apply !== undefined && !run.controller.signal.aborted && this.commandRun === run) {
					const request = run.apply;
					run.apply = undefined;
					this.commandRun = undefined;
					void this.applySetup(request);
				}
			} catch (error) {
				if (run.controller.signal.aborted || this.commandRun !== run) return;
				if (error instanceof HttpError && error.status === 404) this.state.notice(`unknown command /${name}`, "error");
				else if (!run.controller.signal.aborted) this.failCommand(run, error);
			} finally {
				if (this.commandRun === run) this.commandRun = undefined;
				if (run.promptId !== undefined) {
					run.promptId = undefined;
					this.closePrompt(run);
				}
				if (run.card?.phase === "running") this.closeLoginCard(run);
			}
		})();
		await run.finished;
	}

	private onCommandEvent(run: CommandRun, event: CommandEvent): void {
		if (run.controller.signal.aborted || this.commandRun !== run || run.ended) return;
		switch (event.type) {
			case "started":
				run.runId = event.runId;
				return;
			case "apply":
				run.apply = event.request;
				return;
			case "output":
				if (run.quietSuccess && event.level === "success") return;
				this.closeFinishedLoginCard(run);
				if (run.card !== undefined) {
					if (event.level === "info") return run.card.event({ type: "info", message: event.text });
					run.card.finish(event.text, event.level);
					this.screen.requestRender();
				}
				return this.state.notice(event.level === "success" ? color.accentSuccess(event.text) : event.text, event.level === "error" ? "error" : "info");
			case "auth":
				if (run.card === undefined) return this.state.notice(renderAuthEvent(event.event));
				run.card.event(event.event);
				return this.screen.requestRender();
			case "prompt":
				return this.openPrompt(run, event.id, event.prompt);
			case "state":
				++this.modelRevision;
				this.screen.setModelState(event);
				return;
			case "done":
				run.ended = true;
				return;
			case "error":
				run.ended = true;
				if (run.card !== undefined) {
					run.card.finish(event.message, "error");
					this.screen.requestRender();
				}
				return this.state.notice(event.message, "error");
		}
	}

	/**
	 * A select prompt opens the picker and a checklist prompt the picker in checklist mode (its answer is the JSON array of checked ids);
	 * a text or secret prompt goes to the login card's field when a card is open, else to the prompt box.
	 */
	private openPrompt(run: CommandRun, promptId: string, spec: CommandPromptSpec): void {
		run.promptId = promptId;
		this.closeFinishedLoginCard(run);
		const handlers = { onAnswer: (value: string) => void this.answerPrompt(run, promptId, value), onCancel: () => this.cancelCommand(run) };
		// A multi-line message: the first line titles the window, the rest is wrapped above the choices.
		const [title = "", ...body] = spec.message.split("\n");
		const header = body.length === 0 ? {} : { header: (width: number) => body.flatMap((line) => (line === "" ? [""] : wrapTextWithAnsi(line, width))) };
		if (spec.type === "select") {
			const picker = new Picker(
				title,
				spec.options,
				{
					onChoose: (id) => {
						if ((run.name === "login" || spec.login === true) && run.card === undefined) this.openLoginCard(run, spec.options.find((option) => option.id === id)?.label ?? id, false);
						handlers.onAnswer(id);
					},
					onCancel: () => this.cancelCommand(run, run.card === undefined && run.name !== "setup"),
				},
				() => this.screen.size(),
				header,
			);
			run.picker = picker;
			this.screen.openModal(picker, modalOverlayOptions(this.screen.size()));
			return;
		}
		if (spec.type === "checklist") {
			const picker = new Picker(title, spec.options, { onChoose: handlers.onAnswer, onCancel: () => this.cancelCommand(run, run.card === undefined && run.name !== "setup") }, () => this.screen.size(), { checklist: true, ...header });
			run.picker = picker;
			this.screen.openModal(picker, modalOverlayOptions(this.screen.size()));
			return;
		}
		if (run.card !== undefined) {
			run.card.ask(spec, handlers);
			this.screen.requestRender();
			return;
		}
		this.screen.prompt.beginAnswer(spec, handlers);
	}

	private closePrompt(run: CommandRun): void {
		if (run.picker !== undefined) {
			this.screen.closeModal(run.picker);
			run.picker = undefined;
		}
		run.card?.endPrompt();
		this.screen.prompt.endAnswer();
	}

	private async answerPrompt(run: CommandRun, promptId: string, value: string): Promise<void> {
		if (run.promptId !== promptId || run.runId === undefined) return;
		run.promptId = undefined;
		this.closePrompt(run);
		try {
			await this.client.answerPrompt(run.runId, promptId, { value });
		} catch (error) {
			if (run.controller.signal.aborted) return;
			this.failCommand(run, error);
			run.controller.abort();
		}
	}

	/** A failure the daemon could not report (the stream broke, an answer was refused): an open login card ends in its error state, like a daemon error, and the transcript keeps it. */
	private failCommand(run: CommandRun, error: unknown): void {
		if (run.card?.phase === "running") {
			run.card.finish(error instanceof Error ? error.message : String(error), "error");
			this.screen.requestRender();
		}
		this.error(error);
	}

	/**
	 * Esc: the pending prompt is cancelled and the stream closed, which aborts the run on the daemon; the prompt may already be gone by then, so that answer's failure is expected.
	 * Dismissing a picker before the command did anything is `silent`: it closes like any menu, without a notice.
	 */
	private cancelCommand(run: CommandRun, silent = false): void {
		this.reasoningQueue = undefined;
		const { runId, promptId } = run;
		if (promptId !== undefined) {
			run.promptId = undefined;
			this.closePrompt(run);
			if (runId !== undefined) void this.client.answerPrompt(runId, promptId, { cancel: true }).catch(() => undefined);
		}
		run.controller.abort();
		if (this.commandRun === run) this.commandRun = undefined;
		this.closeLoginCard(run);
		if (!silent) this.state.notice(`Stopped /${run.name}.`);
	}

	/** `/login <id>` opens the card under the id and swaps in the display name when the argument list arrives; the picker already knows the name. */
	private openLoginCard(run: CommandRun, provider: string, resolveName: boolean): void {
		const card = new LoginCard(
			provider,
			{
				onCancel: () => this.cancelCommand(run),
				onClose: () => this.closeLoginCard(run),
				onChooseModel: () => {
					this.closeLoginCard(run);
					void run.finished.then(() => this.runCommand("model", ""));
				},
				open: this.openUrl,
				copy: this.copyText,
			},
			() => this.screen.size(),
		);
		run.card = card;
		this.screen.openModal(card, modalOverlayOptions(this.screen.size()));
		if (resolveName) {
			void this.argumentsOf("login").then((providers) => {
				const match = providers.find((entry) => entry.value === provider);
				if (match !== undefined && run.card === card) {
					card.setProvider(match.label);
					this.screen.requestRender();
				}
			});
		}
	}

	private closeLoginCard(run: CommandRun): void {
		if (run.card === undefined) return;
		this.screen.closeModal(run.card);
		run.card = undefined;
	}

	/**
	 * Inside a longer command (`/setup`), a login card whose flow already ended gives way to the next step; `/login` keeps it
	 * up for the person to dismiss or to choose a model.
	 */
	private closeFinishedLoginCard(run: CommandRun): void {
		if (run.card !== undefined && run.card.phase !== "running" && run.name !== "login") this.closeLoginCard(run);
	}

	/**
	 * Applies a `/setup` manifest change (src/setup/apply.ts): the daemon may restart, so the thread's event stream is closed
	 * first (no "disconnected" notice) and attached again afterwards, then the outcome is reported.
	 */
	private async applySetup(request: ManifestApplyRequest): Promise<void> {
		const copy = this.setupCopy(request.locale || this.client.locale);
		this.applying = true;
		this.state.notice(copy.applying, "info");
		this.stream?.abort();
		let outcome: ApplyOutcome;
		try {
			outcome = await applyManifestChange(request, applyPorts(this.client, this.manifest.dataDir));
		} catch (error) {
			outcome = { status: "failed", reason: error instanceof Error ? error.message : String(error), log: "" };
		} finally {
			this.applying = false;
		}
		if (this.updateCheck.signal.aborted) return;
		this.attach(this.thread);
		const described = describeApply(outcome, copy, request);
		let text = described.text;
		const { level } = described;
		if (outcome.status === "failed" || outcome.status === "rolled_back" || outcome.status === "stuck") {
			// A later /report (daemon) or `dinobot report send` (offline) carries this outcome as context (ADR 0103).
			await recordSetupFailure(this.manifest.dataDir, outcome, request.manifestPath).catch(() => undefined);
			text = `${text}\n${copy.applyOutcome.reportHint(request.manifestPath)}`;
		}
		this.noticeAfterSnapshot(level === "success" ? color.accentSuccess(text) : text, level === "error" ? "error" : "info");
	}

	/**
	 * A notice that must survive a fresh attach: the stream's first snapshot rebuilds the transcript from the daemon and drops
	 * local notices, so this one is added once that snapshot landed (or after a short wait when no stream comes up).
	 */
	private noticeAfterSnapshot(text: string, level: "info" | "error"): void {
		const state = this.state;
		const structure = state.data.structure;
		let done = false;
		const add = () => {
			if (done) return;
			done = true;
			unsubscribe();
			clearTimeout(timer);
			if (this.state === state) state.notice(text, level);
		};
		const unsubscribe = state.subscribe(() => {
			if (state.data.structure !== structure) queueMicrotask(add);
		});
		const timer = setTimeout(add, 3_000);
	}

	/** Open human asks in the order they were first observed (creation order); Q1 is the first one asked. */
	private openAsks(): AskView[] {
		const now = Date.now();
		return [...this.state.data.asks.values()].filter(ask => ask.to === "human" && ask.state === "open" && ask.deadlineAt > now);
	}

	/**
	 * One modal for every open human ask. A tab row numbers the questions in asked order (`[Q1]  Q2  Q3`, the shown one bracketed
	 * so the choice does not rest on color, as in the TODO/Plan pane); numbers stay stable while the modal is open and a question
	 * answered here stays in the row marked `sent`. ←/→ or Tab switch between unanswered questions. Below: the full question in bold,
	 * a gray line with its kind and when the default applies, then the choices and an always-present "Write my own answer…" row.
	 * Choices are display-only: the daemon resolves the index against its own ask record. Choosing one sends it and moves to the next
	 * unanswered question; the free-text row closes the modal and seeds the prompt with `[ask <id>] answer: ` plus any filter text.
	 */
	private openAskPicker(auto: boolean): void {
		const state = this.state;
		const thread = this.thread;
		/** Asks this modal sent an answer for; they stay in the tab row, marked, until the daemon resolves them. */
		const handled = new Set<string>();
		/** Stable tab order: first observed, then any ask that opens while the modal is up. */
		const order: string[] = [];
		const sync = () => {
			for (const ask of this.openAsks()) if (!order.includes(ask.id)) order.push(ask.id);
		};
		const pending = () => {
			const open = new Set(this.openAsks().map(ask => ask.id));
			return order.filter(id => open.has(id) && !handled.has(id)).map(id => state.data.asks.get(id)!);
		};
		sync();
		if (pending().length === 0) {
			if (!auto) state.notice("No open question", "info");
			return;
		}
		this.closeAskPicker?.();
		let closed = false;
		let picker: Picker | undefined;
		let signature = "";
		const initial = pending();
		let currentId = (initial.find(ask => !this.autoShownAsks.has(ask.id)) ?? initial[0]!).id;
		let expiryTimer: ReturnType<typeof setTimeout> | undefined;
		const close = () => {
			if (closed) return;
			closed = true;
			clearTimeout(expiryTimer);
			unsubscribe();
			if (picker) this.screen.closeModal(picker);
			picker = undefined;
			if (this.closeAskPicker === close) this.closeAskPicker = undefined;
		};
		// An idle conversation emits no state updates when a deadline passes.
		const schedule = (list: readonly AskView[]) => {
			clearTimeout(expiryTimer);
			const next = Math.min(...list.map(ask => ask.deadlineAt));
			expiryTimer = setTimeout(() => show(), Math.min(Math.max(0, next - Date.now()), 2_147_483_647));
		};
		const switchTab = (delta: 1 | -1) => {
			const list = pending();
			if (list.length < 2) return;
			const index = list.findIndex(ask => ask.id === currentId);
			currentId = list[(Math.max(0, index) + delta + list.length) % list.length]!.id;
			show(true);
		};
		const show = (force = false) => {
			if (closed) return;
			sync();
			const list = pending();
			if (list.length === 0) return close();
			const ask = list.find(item => item.id === currentId) ?? list[0]!;
			currentId = ask.id;
			// Tabs: every question this modal has shown that is still open or was answered here; resolved-elsewhere ones drop out.
			const open = new Set(this.openAsks().map(item => item.id));
			const tabs = order.flatMap((id, n) => open.has(id) || handled.has(id) ? [{ id, number: n + 1, sent: handled.has(id) }] : []);
			const nextSignature = `${ask.id}|${tabs.map(tab => `${tab.id}:${tab.sent}`).join(",")}|${list.map(item => item.deadlineAt).join(",")}`;
			schedule(list);
			if (!force && picker !== undefined && nextSignature === signature) return;
			signature = nextSignature;
			const position = tabs.findIndex(tab => tab.id === ask.id);
			// Labels own the row (no description column) so long choices are not cut; the default carries a gray right-aligned
			// tag that survives clipping. Section headers are dropped on short terminals so the free-text row stays visible.
			const roomy = this.screen.size().rows >= ASK_ROOMY_ROWS;
			const options = [
				...(ask.options ?? []).map((label, option) => ({ id: String(option), label, ...(label === ask.default ? { tag: "default" } : {}), ...(roomy ? { group: "Choices" } : {}) })),
				{ id: ASK_CUSTOM, label: `Write my own answer${glyph.ellipsis}`, ...(roomy ? { group: "Your answer" } : {}) },
			];
			const header = (width: number): string[] => {
				const rows: string[] = [];
				if (tabs.length > 1) rows.push(askTabRow(tabs, ask.id, width), ...(roomy ? [""] : []));
				const question = wrapTextWithAnsi(researchText(ask.question), Math.max(1, width));
				const room = roomy ? ASK_QUESTION_ROWS : ASK_QUESTION_ROWS_SHORT;
				const shown = question.slice(0, room);
				if (question.length > room) shown[shown.length - 1] = truncateToWidth(`${shown.at(-1)!}${glyph.ellipsis}`, width, glyph.ellipsis);
				rows.push(...shown.map(line => bold(color.textPrimary(line))));
				rows.push(color.gray(`${researchText(ask.kind)} ${glyph.bullet} default applies in ${askCountdown(ask.deadlineAt - Date.now())}`));
				return rows;
			};
			const title = tabs.length > 1 ? `Question ${position + 1} of ${tabs.length}` : "Question";
			const next = new Picker(title, options, {
				onChoose: id => {
					if (closed || picker !== next) return;
					const current = state.data.asks.get(ask.id);
					if (!current || current.state !== "open" || current.deadlineAt <= Date.now()) return show(true);
					handled.add(ask.id);
					this.autoShownAsks.add(ask.id);
					if (id === ASK_CUSTOM) {
						const draft = next.filter;
						close();
						const existing = this.screen.prompt.getText();
						this.screen.prompt.setText(`[ask ${ask.id}] answer: ${draft}${existing.trim() === "" ? "" : ` ${existing}`}`);
						return;
					}
					const option = Number(id);
					void this.client.send(CHANNEL, thread, `[ask ${ask.id}] choice #${option + 1}`, this.userId,
						state.data.run ? "steer" : undefined, undefined, { askId: ask.id, option })
						.catch((error: unknown) => state.notice(error instanceof Error ? error.message : String(error), "error"));
					// Move on to the next unanswered question after this one, wrapping to the first.
					const rest = pending();
					currentId = (rest.find(item => order.indexOf(item.id) > order.indexOf(ask.id)) ?? rest[0])?.id ?? currentId;
					show(true);
				},
				onCancel: () => {
					if (closed || picker !== next) return;
					// Esc must never immediately reopen any question shown here.
					for (const item of pending()) this.autoShownAsks.add(item.id);
					close();
					if (auto) state.notice("Use /choose to answer later", "info");
				},
				onKey: key => {
					if (matchesKey(key, "right") || matchesKey(key, "tab")) { switchTab(1); return true; }
					if (matchesKey(key, "left") || matchesKey(key, "shift+tab")) { switchTab(-1); return true; }
					return false;
				},
			}, () => this.screen.size(), {
				header,
				alwaysShow: new Set([ASK_CUSTOM]),
				hints: list.length > 1 ? ["←/→ question", ...PICKER_HINTS] : PICKER_HINTS,
			});
			const previous = picker;
			picker = next;
			this.screen.openModal(next, askOverlayOptions(this.screen.size(), list.flatMap(item => item.options ?? [])) /* one width for every tab: switching never jumps */);
			if (previous) this.screen.closeModal(previous);
		};
		const unsubscribe = state.subscribe(() => show());
		this.closeAskPicker = close;
		show(true);
	}

	/** /theme: one row per dinosaur theme, the current one marked; Enter applies and saves it. */
	private chooseTheme(): void {
		const current = themeName();
		const picker = new Picker("Theme · Enter: apply", THEME_NAMES.map((name) => ({
			id: name,
			label: `${themes[name].species} · ${themes[name].label}`,
			description: `/theme ${name} · ${themes[name].description}`,
			current: name === current,
		})), {
			onChoose: (id) => {
				this.screen.closeModal(picker);
				if (isThemeName(id)) this.applyTheme(id);
			},
			onCancel: () => this.screen.closeModal(picker),
		}, () => this.screen.size());
		this.screen.openModal(picker, modalOverlayOptions(this.screen.size()));
	}

	/** Recolors the whole screen at once and keeps the choice for the next launch; DINOBOT_THEME still wins at startup. */
	private applyTheme(name: ThemeName): void {
		setTheme(name);
		this.screen.restyle();
		const theme = themes[name];
		const env = chooseTheme({ toolsExpanded: false }).source === "env" ? " (DINOBOT_THEME overrides it at the next launch)" : "";
		try {
			this.preferences.save({ ...this.preferences.load(), theme: name });
			this.state.notice(`Theme: ${theme.species} · ${theme.label}${env}`, "info");
		} catch (error) {
			this.state.notice(`Theme changed for this session, but could not save preferences: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	}

	private closeAgentPicker: (() => void) | undefined;

	private chooseSubagent(): void {
		this.closeAgentPicker?.();
		if (!this.state.data.subagents.size) return this.state.notice("no subagents in this thread yet");
		const options = () => [...this.state.data.subagents.values()]
			.sort((a, b) => Number(a.status !== "running") - Number(b.status !== "running") || b.startedAt - a.startedAt)
			.map(progress => ({
				id: progress.taskId,
				label: `${progress.status === "completed" ? "done" : progress.status} · ${progress.description}`,
				description: `${progress.subagentType} · ${progress.toolCount} tools · ${activityLabel(progress) || progress.error || progress.lastText || progress.taskId}`,
				group: progress.status === "running" ? "Active" : "History",
				disabled: progress.conversationId <= 0,
			}));
		const picker = new Picker("Subagents · Enter: details", options(), {
			onChoose: id => {
				const progress = this.state.data.subagents.get(id);
				this.closeAgentPicker?.();
				if (progress) this.openSubagent(progress);
			},
			onCancel: () => this.closeAgentPicker?.(),
		}, () => this.screen.size());
		let version = this.state.data.subagentsVersion;
		const unsubscribe = this.state.subscribe(() => {
			if (version === this.state.data.subagentsVersion) return;
			version = this.state.data.subagentsVersion;
			picker.updateOptions(options());
			this.screen.tui.requestRender();
		});
		this.closeAgentPicker = () => {
			unsubscribe();
			this.screen.closeModal(picker);
			this.closeAgentPicker = undefined;
		};
		this.screen.openModal(picker, modalOverlayOptions(this.screen.size()));
	}

	private closeDagPicker: (() => void) | undefined;

	/** /dag (design 2.7): every node of the shown run grouped by wave; Enter opens the bound subagent's conversation. */
	private chooseDagNode(): void {
		this.closeDagPicker?.();
		const initial = this.state.data.dag;
		if (initial === null) return this.state.notice("no DAG run in this thread");
		const options = () => {
			const dag = this.state.data.dag;
			if (dag === null) return [];
			const live = { subagents: this.state.data.subagents };
			const byId = new Map(dag.nodes.map((node) => [node.id, node]));
			const wordOf = (node: DagNodeView): string => {
				const state = displayState(dag, node, live);
				return state === "lastseen" ? node.state : state;
			};
			const nodes = dag.nodes.map((node) => {
				const word = wordOf(node);
				const child = node.handle === undefined ? undefined : this.state.data.subagents.get(node.handle);
				const detail = (child === undefined ? "" : activityLabel(child)) || node.error || node.result || "";
				const parts = [node.kind, `attempt ${node.attempt}/${node.maxAttempts}`];
				if (node.directParents.length > 0) parts.push(`<- ${node.directParents.map((id) => { const parent = byId.get(id); return parent === undefined ? id : `${id} ${wordOf(parent)}`; }).join(", ")}`);
				if (detail !== "") parts.push(detail);
				return { id: node.id, label: `${word} · ${node.id} · ${node.title}`, description: parts.join(" · "), group: `Wave ${node.level + 1}` };
			});
			return [...(dag.research ? researchPickerOptions(dag.research) : []), ...nodes];
		};
		const picker = new Picker(`DAG ${initial.id} · rev ${initial.revision} · Enter: open node`, options(), {
			onChoose: (id) => {
				const mission = this.state.data.dag?.research;
				if (mission && id.startsWith("research:")) {
					this.closeDagPicker?.();
					if (id === "research:report") {
						const thread = this.thread;
						void readResearchReport({ channel: CHANNEL, thread, client: this.client }, mission.id)
							.then(content => { if (thread === this.thread) this.state.notice(content); })
							.catch(error => { if (thread === this.thread) this.state.notice(researchText(error instanceof Error ? error.message : String(error)), "error"); });
					} else {
						const detail = researchDetails(mission, id);
						this.state.notice(detail ?? "Research result is no longer available.");
					}
					return;
				}
				const node = this.state.data.dag?.nodes.find((candidate) => candidate.id === id);
				const progress = node?.handle === undefined ? undefined : this.state.data.subagents.get(node.handle);
				this.closeDagPicker?.();
				if (progress !== undefined && progress.conversationId > 0) this.openSubagent(progress);
				else this.state.notice(`node ${id} has no conversation`);
			},
			onCancel: () => this.closeDagPicker?.(),
		}, () => this.screen.size());
		let versions = `${this.state.data.dagVersion}:${this.state.data.subagentsVersion}`;
		const unsubscribe = this.state.subscribe(() => {
			const next = `${this.state.data.dagVersion}:${this.state.data.subagentsVersion}`;
			if (next === versions) return;
			versions = next;
			picker.updateOptions(options());
			this.screen.tui.requestRender();
		});
		this.closeDagPicker = () => {
			unsubscribe();
			this.screen.closeModal(picker);
			this.closeDagPicker = undefined;
		};
		this.screen.openModal(picker, modalOverlayOptions(this.screen.size()));
	}

	private openSubagent(progress: SubagentProgress): void {
		if (progress.conversationId <= 0) return this.state.notice(`subagent ${progress.description} has no conversation yet`, "error");
		this.closeSubagent();
		const controller = new AbortController();
		const childState = new ChatState();
		this.child = { stream: controller, state: childState, taskId: progress.taskId };
		this.client.conversationEvents(progress.conversationId, (event) => childState.apply(event), controller.signal).catch((error) => {
			if (!controller.signal.aborted) childState.notice(error instanceof Error ? error.message : String(error), "error");
		});
		const parent = this.state;
		this.screen.openTakeover({
			state: childState,
			progress: () => parent.data.subagents.get(progress.taskId) ?? progress,
			header: () => ({
				...(this.branch === undefined ? {} : { branch: this.branch }),
				cwd: childState.data.agent.cwd ?? process.cwd(),
				used: childState.data.usage.contextTokens,
				...(this.screen.info.contextWindow === undefined ? {} : { window: this.screen.info.contextWindow }),
				welcome: false,
			}),
		});
	}

	private closeSubagent(): void {
		if (!this.child) return;
		this.child.stream.abort();
		this.child = undefined;
		this.screen.closeTakeover();
	}

	private error(error: unknown): void {
		this.state.notice(error instanceof Error ? error.message : String(error), "error");
	}

	/** Stop owned asynchronous UI work without terminating an embedding process. */
	stop(): void {
		if (this.updateCheck.signal.aborted) return;
		this.updateCheck.abort();
		this.unsubscribeAsks?.();
		this.unsubscribeAsks = undefined;
		this.closeAskPicker?.();
		this.paste.disable();
		this.closeAgentPicker?.();
		this.closeDagPicker?.();
		this.stream?.abort();
		this.closeSessions?.();
		this.child?.stream.abort();
		this.commandRun?.controller.abort();
		this.screen.stop();
	}

	private quit(): void {
		this.stop();
		if (this.startedPid !== undefined) {
			console.log(color.gray(`dinobot daemon keeps running in the background (pid ${this.startedPid}); stop it with: kill ${this.startedPid}`));
		}
		process.exit(0);
	}
}
