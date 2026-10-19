/**
 * The browser plugin's crash-isolated child: one Patchright session (a dedicated Chrome profile, or the user's own
 * Chrome over CDP) driven by JSON lines on stdio. Requests `{id, cmd, args}` are handled one at a time; each gets one
 * reply line `{id, ok, result|error}`. stdin closing ends the session (dedicated: Chrome closes; attach: disconnect
 * only) and the process. Run as `bun host.ts` with DINOBOT_BROWSER_CONFIG; tests inject a fake `chromium`.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { chromeProfiles, importChromeCookies } from "./chrome-import.ts";
import { publishDesktopDescriptor } from "./desktop-bridge.ts";
import { bounded, validateUiInput, type BrowserViewState } from "./ui.ts";
import type { Browser, BrowserContext, BrowserType, Dialog, Locator, Page } from "patchright";
import {
	type Action,
	brandName,
	clip,
	devToolsEndpoint,
	defaultUserDataDir,
	validateArgs,
	fallbackSuffix,
	type HostConfig,
	type HostReply,
	type HostRequest,
	type HostResult,
	isAction,
	isFallbackError,
	parseDevToolsActivePort,
	permissionPending,
	remoteDebuggingOff,
} from "./shared.ts";

export type Chromium = Pick<BrowserType, "launchPersistentContext" | "connectOverCDP">;

export type HostDeps = {
	readonly chromium: Chromium;
	/** Test seam for passive Chrome discovery; production always uses the OS Chrome default. */
	readonly chromeUserDataDir?: string;
	readonly platform?: string;
	/** Attach: how long the first call waits for connectOverCDP before reporting PermissionPending. Default 4000. */
	readonly pendingAfterMs?: number;
	/** Attach: how long a later call waits on the kept pending connection. Default 20000. */
	readonly pendingWaitMs?: number;
	readonly sleep?: (ms: number) => Promise<void>;
	readonly random?: () => number;
};

const ACTION_TIMEOUT_MS = 15_000;
const NAVIGATION_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 60_000;
const DEFAULT_SNAPSHOT_CHARS = 30_000;
const MAX_TEXT = 20_000;
const MAX_WAIT_MS = 30_000;
/** How long an action may keep running after a JS dialog opened before the dialog is reported. */
const DIALOG_GRACE_MS = 500;

type PendingDialog = { readonly page: Page; readonly dialog: Dialog };

export class Session {
	#context: BrowserContext | undefined;
	#browser: Browser | undefined;
	#current: Page | undefined;
	/** Pages the agent opened (or that its own pages opened); attach mode closes only these. */
	readonly #own = new WeakSet<Page>();
	readonly #watched = new WeakSet<Page>();
	readonly #sizes = new WeakMap<Page, { width: number; height: number }>();
	#connecting: Promise<void> | undefined;
	#dialog: PendingDialog | undefined;
	#dialogWaiters: (() => void)[] = [];
	#notes: string[] = [];
	readonly #sleep: (ms: number) => Promise<void>;
	readonly #random: () => number;

	constructor(private readonly config: HostConfig, private readonly deps: HostDeps) {
		this.#sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
		this.#random = deps.random ?? Math.random;
	}

	async run(cmd: string, args: Record<string, unknown>): Promise<HostResult> {
		if (cmd.startsWith("ui_")) return this.#ui(cmd, args);
		if (!isAction(cmd)) throw new Error(`InvalidArguments: unknown action ${JSON.stringify(cmd)}`);
		args = validateArgs(cmd, args);
		if (cmd === "status") return { text: this.#status() };
		if (cmd === "close") {
			await this.close();
			return { text: this.config.mode === "attach" ? "Disconnected from the user's browser (its tabs stay open)." : "Closed the dedicated browser." };
		}
		const pending = await this.#ensure();
		if (pending) return pending;
		const notes: string[] = [];
		if (cmd === "dialog") return this.#handleDialog(args);
		if (this.#dialog) notes.push(await this.#dismissDialog());
		let result: HostResult;
		try {
			result = await this.#withDialogWatch(() => this.#act(cmd, args));
		} catch (error) {
			throw new Error(await this.#describeError(error, notes));
		}
		notes.push(...this.#takeNotes());
		if (this.#dialog) notes.push(this.#dialogReport(this.#dialog));
		return notes.length === 0 ? result : { ...result, text: [...notes.filter((note) => note !== ""), result.text].join("\n") };
	}

	/** Passive UI reads never call #ensure or select somebody else's attached tab. */
	#uiPage(): Page | undefined {
		const page = this.#current;
		return page && !page.isClosed() && (this.config.mode === "dedicated" || this.#own.has(page)) ? page : undefined;
	}

	async #dimensions(page: Page): Promise<{ width: number; height: number }> {
		if (this.#dialog?.page === page) return this.#sizes.get(page) ?? { width: 1280, height: 720 };
		const value = await bounded(page.evaluate("({width:innerWidth,height:innerHeight})"), 1500, "BrowserFrameTimeout: viewport unavailable") as { width?: unknown; height?: unknown };
		const { width, height } = value ?? {};
		if (typeof width !== "number" || typeof height !== "number" || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > 16_777_216) throw new Error("BrowserFrameTooLarge: unsupported viewport size");
		this.#sizes.set(page, { width, height });
		return { width, height };
	}

	async #uiState(): Promise<BrowserViewState> {
		const pages = this.#context?.pages() ?? [];
		const page = this.#uiPage();
		const tabs = await Promise.all(pages.map((p, index) => ({ p, index })).filter(({ p }) => this.config.mode === "dedicated" || this.#own.has(p)).slice(0, 100).map(async ({ p, index }) => ({ index, title: (await bounded(p.title(), 1000, "BrowserStateTimeout").catch(() => "")).slice(0, 1000), url: p.url().slice(0, 8192), owned: true })));
		const size = page ? await this.#dimensions(page) : { width: 1280, height: 720 };
		return { connected: !!this.#context, mode: this.config.mode, control: "agent", tabs, current: page ? pages.indexOf(page) : -1, url: page?.url().slice(0, 8192) ?? "", title: tabs.find((tab) => tab.index === pages.indexOf(page!))?.title ?? "", ...size, ...(this.#dialog && this.#dialog.page === page ? { dialog: { type: this.#dialog.dialog.type(), message: this.#dialog.dialog.message().slice(0, 2000) } } : {}) };
	}

	async #ui(cmd: string, args: Record<string, unknown>): Promise<HostResult> {
		if (cmd === "ui_state" || cmd === "ui_frame") {
			const state = await this.#uiState();
			const page = this.#uiPage();
			if (cmd === "ui_frame" && page && this.#dialog?.page !== page) {
				const bytes = await bounded(page.screenshot({ type: "jpeg", quality: 65, fullPage: false, scale: "css", timeout: 2000 }), 2500, "BrowserFrameTimeout: screenshot unavailable");
				if (bytes.length > 2 * 1024 * 1024) throw new Error("BrowserFrameTooLarge: screenshot exceeds 2 MiB");
				state.frame = `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`;
			}
			return { text: "", ui: { ok: true, state } };
		}
		const root = this.deps.chromeUserDataDir ?? defaultUserDataDir("chrome", this.deps.platform ?? process.platform, process.env, homedir());
		if (cmd === "ui_profiles") return { text: "", ui: { ok: true, profiles: await chromeProfiles(root) } };
		if (cmd === "ui_import") {
			if (this.config.mode !== "dedicated") throw new Error("ChromeImportBlocked: 로그인 정보는 전용 브라우저 프로필로만 가져올 수 있습니다.");
			const ui = await importChromeCookies(root, args, this.deps.chromium, async () => {
				const pending = await this.#ensure();
				if (pending || !this.#context) throw new Error("ChromeImportBlocked: 전용 브라우저를 시작할 수 없습니다.");
				return this.#context;
			});
			return { text: "", ui };
		}
		if (cmd !== "ui_input") throw new Error("InvalidArguments: unknown desktop browser command");
		const input = validateUiInput(args);
		const pending = await this.#ensure();
		if (pending) return { ...pending, ui: { ok: false, error: pending.text } };
		if (this.#current && !this.#current.isClosed() && !this.#uiPage()) throw new Error("NotOwnTab: desktop input cannot control the user's existing tab");
		if (!this.#current || this.#current.isClosed()) this.#current = await this.#newPage();
		const page = this.#uiPage()!;
		if (this.#dialog) throw new Error("DialogOpen: 먼저 브라우저 대화상자에 응답해 주세요.");
		await this.#withDialogWatch(async () => {
			switch (input.kind) {
				case "click": { const size = await this.#dimensions(page); if (input.x >= size.width || input.y >= size.height) throw new Error("InvalidArguments: click outside viewport"); await page.mouse.click(input.x, input.y, { button: input.button }); break; }
				case "text": await page.keyboard.type(input.text); break;
				case "key": await page.keyboard.press(input.key); break;
				case "wheel": await page.mouse.wheel(input.dx, input.dy); break;
			}
			return { text: "" };
		});
		return { text: "", ui: { ok: true, state: await this.#uiState() } };
	}

	async close(): Promise<void> {
		const context = this.#context;
		const browser = this.#browser;
		const connecting = this.#connecting;
		this.#reset();
		if (this.config.mode === "attach") {
			// Disconnect only: Browser.close() on a CDP-attached browser drops the connection, the user's tabs stay.
			await browser?.close().catch(() => {});
			if (connecting) void connecting.catch(() => {});
		} else {
			await context?.close().catch(() => {});
		}
	}

	#reset(): void {
		this.#context = undefined;
		this.#browser = undefined;
		this.#current = undefined;
		this.#connecting = undefined;
		this.#dialog = undefined;
	}

	#status(): string {
		const state = this.#context ? "connected" : this.#connecting ? "waiting for the user to allow remote debugging" : "not started";
		const lines = [`mode: ${this.config.mode}`, `browser: ${brandName(this.config.browser)}`, `state: ${state}`];
		if (this.#context) {
			lines.push(`tabs: ${this.#context.pages().length}`);
			if (this.#current) lines.push(`current: ${this.#current.url()}`);
		}
		return lines.join("\n");
	}

	/** Start or reuse the browser. Returns a PermissionPending result while the user's Chrome shows its allow dialog. */
	async #ensure(): Promise<HostResult | undefined> {
		if (this.#context) return undefined;
		if (this.config.mode === "dedicated") {
			const context = await this.deps.chromium.launchPersistentContext(this.config.profile, {
				...(this.config.browser !== "chromium" ? { channel: this.config.browser } : {}),
				...(this.config.executablePath ? { executablePath: this.config.executablePath } : {}),
				headless: false,
				viewport: null,
				chromiumSandbox: true,
				args: ["--hide-crash-restore-bubble"],
			});
			this.#adopt(context);
			for (const page of context.pages()) this.#own.add(page);
			this.#current = context.pages()[0] ?? (await this.#newPage());
			return undefined;
		}
		let wait = this.deps.pendingWaitMs ?? 20_000;
		if (!this.#connecting) {
			wait = this.deps.pendingAfterMs ?? 4_000;
			const file = await readFile(join(this.config.userDataDir, "DevToolsActivePort"), "utf8").catch(() => undefined);
			const active = file === undefined ? undefined : parseDevToolsActivePort(file);
			if (!active) throw new Error(remoteDebuggingOff(this.config.userDataDir, this.config.browser, this.deps.platform ?? process.platform, file === undefined ? undefined : "DevToolsActivePort is malformed"));
			const attempt: Promise<void> = this.deps.chromium.connectOverCDP(devToolsEndpoint(active), { timeout: CONNECT_TIMEOUT_MS }).then((browser) => {
				if (this.#connecting !== attempt) {
					void browser.close().catch(() => {});
					return;
				}
				this.#browser = browser;
				browser.on("disconnected", () => {
					if (this.#browser === browser) this.#reset();
				});
				const context = browser.contexts()[0];
				if (!context) throw new Error("the connected browser has no default context");
				this.#adopt(context);
			});
			this.#connecting = attempt;
			attempt.catch(() => {
				if (this.#connecting === attempt) this.#connecting = undefined;
			});
		}
		const attempt = this.#connecting;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const done = await Promise.race([
			attempt.then(() => true),
			new Promise<false>((resolve) => {
				timer = setTimeout(() => resolve(false), wait);
			}),
		])
			.catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				if (/ECONNREFUSED|connect ECONN|socket hang up|404/i.test(message)) {
					throw new Error(remoteDebuggingOff(this.config.userDataDir, this.config.browser, this.deps.platform ?? process.platform, "DevToolsActivePort is stale; the connection was refused"));
				}
				throw new Error(`cannot connect to the user's ${brandName(this.config.browser)}: ${firstLines(message)}`);
			})
			.finally(() => clearTimeout(timer));
		if (!done) return { text: permissionPending(this.config.browser) };
		if (this.#connecting === attempt) this.#connecting = undefined;
		return undefined;
	}

	#adopt(context: BrowserContext): void {
		this.#context = context;
		context.setDefaultTimeout(ACTION_TIMEOUT_MS);
		context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
		context.on("close", () => {
			if (this.#context === context) this.#reset();
		});
		context.on("page", (page) => {
			this.#watch(page);
			void page
				.opener()
				.then((opener) => {
					if (opener && this.#own.has(opener)) {
						this.#own.add(page);
						this.#notes.push(`New tab opened by the page: [${context.pages().indexOf(page)}] ${page.url()} — switch with tab {index}.`);
					}
				})
				.catch(() => {});
		});
		for (const page of context.pages()) this.#watch(page);
	}

	#watch(page: Page): void {
		if (this.#watched.has(page)) return;
		this.#watched.add(page);
		page.on("dialog", (dialog) => {
			if (this.#dialog) void this.#dialog.dialog.dismiss().catch(() => {});
			this.#dialog = { page, dialog };
			for (const wake of this.#dialogWaiters.splice(0)) wake();
		});
		page.on("close", () => {
			if (this.#current === page) this.#current = undefined;
			if (this.#dialog?.page === page) this.#dialog = undefined;
		});
	}

	async #newPage(): Promise<Page> {
		const page = await this.#context!.newPage();
		this.#own.add(page);
		this.#watch(page);
		return page;
	}

	#takeNotes(): string[] {
		return this.#notes.splice(0);
	}

	/** Run an action; if a JS dialog opens and the action is still blocked on it, report instead of hanging. */
	async #withDialogWatch(action: () => Promise<HostResult>): Promise<HostResult> {
		const running = action();
		let wake: () => void = () => {};
		const opened = new Promise<"dialog">((resolve) => {
			wake = () => resolve("dialog");
			this.#dialogWaiters.push(wake);
		});
		try {
			const first = await Promise.race([running, opened]);
			if (first !== "dialog") return first;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const late = await Promise.race([running, new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), DIALOG_GRACE_MS)))]).finally(() => clearTimeout(timer));
			if (late) return late;
			running.catch(() => {});
			return { text: "The action is waiting on the open dialog." };
		} finally {
			this.#dialogWaiters = this.#dialogWaiters.filter((waiter) => waiter !== wake);
		}
	}

	#dialogReport({ dialog }: PendingDialog): string {
		const prompt = dialog.type() === "prompt" ? ` (default ${JSON.stringify(dialog.defaultValue())})` : "";
		return `Dialog open: ${dialog.type()} ${JSON.stringify(dialog.message())}${prompt} — answer with dialog {accept: true|false${dialog.type() === "prompt" ? ", promptText" : ""}}; any other action dismisses it.`;
	}

	async #dismissDialog(): Promise<string> {
		const pending = this.#dialog!;
		this.#dialog = undefined;
		await pending.dialog.dismiss().catch(() => {});
		return `Dismissed the unanswered ${pending.dialog.type()} dialog ${JSON.stringify(pending.dialog.message())}.`;
	}

	async #handleDialog(args: Record<string, unknown>): Promise<HostResult> {
		const pending = this.#dialog;
		if (!pending) return { text: "No dialog is open." };
		this.#dialog = undefined;
		if (args.accept === true) await pending.dialog.accept(typeof args.promptText === "string" ? args.promptText : undefined);
		else await pending.dialog.dismiss();
		return { text: `${args.accept === true ? "Accepted" : "Dismissed"} the ${pending.dialog.type()} dialog ${JSON.stringify(pending.dialog.message())}.` };
	}

	async #describeError(error: unknown, notes: string[]): Promise<string> {
		const message = firstLines(error instanceof Error ? error.message : String(error));
		const prefix = notes.length > 0 ? `${notes.join("\n")}\n` : "";
		if (!isFallbackError(message) || !this.#current) return prefix + message;
		const title = await this.#current.title().catch(() => "");
		return `${prefix}${message}\n${fallbackSuffix(title || this.#current.url(), this.config.browser)}`;
	}

	async #page(): Promise<Page> {
		if (this.#current && !this.#current.isClosed()) return this.#current;
		if (this.config.mode === "dedicated") {
			const page = this.#context!.pages().find((candidate) => !candidate.isClosed()) ?? (await this.#newPage());
			this.#current = page;
			return page;
		}
		throw new Error("NoPage: attach mode works in its own tab; call open {url} first (or tabs, then tab {index} to work in one of the user's tabs).");
	}

	/** A snapshot ref that is no longer on the page fails at once (StaleRef) instead of waiting out the action timeout. */
	async #target(page: Page, args: Record<string, unknown>): Promise<Locator> {
		if (typeof args.ref !== "string") return page.locator(args.selector as string);
		const locator = page.locator(`aria-ref=${args.ref}`);
		const count = await locator.count().catch(() => 0);
		if (count === 0) throw new Error(`StaleRef: ref ${args.ref} is not on the page (refs change after navigation or updates); take a new snapshot and use its refs.`);
		return locator;
	}

	async #pause(min: number, max: number): Promise<void> {
		if (this.config.humanize) await this.#sleep(Math.round(min + this.#random() * (max - min)));
	}

	async #typeText(page: Page, text: string): Promise<void> {
		if (!this.config.humanize) {
			await page.keyboard.type(text);
			return;
		}
		for (const char of text) {
			await page.keyboard.type(char);
			await this.#pause(25, 70);
		}
	}

	async #summary(page: Page): Promise<string> {
		return `${await page.title().catch(() => "")}\n${page.url()}`;
	}

	async #act(cmd: Exclude<Action, "status" | "close" | "dialog">, args: Record<string, unknown>): Promise<HostResult> {
		const context = this.#context!;
		switch (cmd) {
			case "open": {
				const raw = (args.url as string).trim();
				const url = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
				const current = this.#current && !this.#current.isClosed() ? this.#current : undefined;
				// Attach mode reuses only a tab the agent opened unless told newTab:false; dedicated reuses the current tab.
				const reusable = current && (this.config.mode === "dedicated" || this.#own.has(current) || args.newTab === false) ? current : undefined;
				const page = args.newTab === true || !reusable ? await this.#newPage() : reusable;
				this.#current = page;
				await page.goto(url, { waitUntil: "domcontentloaded" });
				return { text: `Opened ${await this.#summary(page)}` };
			}
			case "snapshot": {
				const page = await this.#page();
				const max = typeof args.maxChars === "number" ? Math.floor(args.maxChars) : DEFAULT_SNAPSHOT_CHARS;
				const tree = await page.ariaSnapshot({ mode: "ai" });
				return { text: `# ${await page.title().catch(() => "")}\nURL: ${page.url()}\n\n${clip(tree, max)}` };
			}
			case "click": {
				const page = await this.#page();
				const target = await this.#target(page, args);
				await this.#pause(150, 600);
				const button = (args.button as "left" | "right" | "middle" | undefined) ?? "left";
				if (args.double === true) await target.dblclick({ button });
				else await target.click({ button });
				return { text: `Clicked ${describeTarget(args)}. Now at ${await this.#summary(page)}` };
			}
			case "fill": {
				const page = await this.#page();
				const target = await this.#target(page, args);
				await this.#pause(150, 600);
				await target.fill(args.text as string);
				return { text: `Filled ${describeTarget(args)}.` };
			}
			case "type": {
				const page = await this.#page();
				if (args.ref !== undefined || args.selector !== undefined) {
					await this.#pause(150, 600);
					await (await this.#target(page, args)).click();
				}
				await this.#typeText(page, args.text as string);
				if (args.submit === true) await page.keyboard.press("Enter");
				return { text: `Typed ${(args.text as string).length} characters${args.submit === true ? " and pressed Enter" : ""}.` };
			}
			case "press": {
				const page = await this.#page();
				await page.keyboard.press(args.key as string);
				return { text: `Pressed ${args.key as string}.` };
			}
			case "select": {
				const page = await this.#page();
				await this.#pause(150, 600);
				const selected = await (await this.#target(page, args)).selectOption(args.values as string[]);
				return { text: `Selected ${JSON.stringify(selected)} in ${describeTarget(args)}.` };
			}
			case "hover": {
				const page = await this.#page();
				await (await this.#target(page, args)).hover();
				return { text: `Hovering ${describeTarget(args)}.` };
			}
			case "scroll": {
				const page = await this.#page();
				if (args.ref !== undefined || args.selector !== undefined) {
					await (await this.#target(page, args)).scrollIntoViewIfNeeded();
					return { text: `Scrolled ${describeTarget(args)} into view.` };
				}
				const dx = typeof args.dx === "number" ? args.dx : 0;
				const dy = typeof args.dy === "number" ? args.dy : dx === 0 ? 600 : 0;
				await page.mouse.wheel(dx, dy);
				return { text: `Scrolled by dx=${dx} dy=${dy}.` };
			}
			case "upload": {
				const page = await this.#page();
				const target = await this.#target(page, args);
				const paths = args.paths as string[];
				const isFileInput = await target
					.evaluate((element) => {
						const input = element as unknown as { tagName?: string; type?: string };
						return input.tagName === "INPUT" && input.type === "file";
					})
					.catch(() => false);
				if (isFileInput) await target.setInputFiles(paths);
				else {
					const [chooser] = await Promise.all([page.waitForEvent("filechooser"), target.click()]);
					await chooser.setFiles(paths);
				}
				return { text: `Attached ${paths.length} file(s) to ${describeTarget(args)}.` };
			}
			case "screenshot": {
				const page = await this.#page();
				const data = await page.screenshot({ type: "jpeg", quality: 80, fullPage: args.fullPage === true });
				return { text: `Screenshot of ${await this.#summary(page)}`, image: { mimeType: "image/jpeg", data: Buffer.from(data).toString("base64") } };
			}
			case "tabs": {
				const pages = context.pages();
				const lines = await Promise.all(
					pages.map(async (page, index) => {
						const marks = [page === this.#current ? "current" : "", this.config.mode === "attach" && this.#own.has(page) ? "opened by agent" : ""].filter(Boolean);
						return `[${index}] ${JSON.stringify(await page.title().catch(() => ""))} ${page.url()}${marks.length > 0 ? ` (${marks.join(", ")})` : ""}`;
					}),
				);
				return { text: lines.length > 0 ? lines.join("\n") : "No tabs." };
			}
			case "tab": {
				const page = context.pages()[args.index as number];
				if (!page) throw new Error(`InvalidArguments: no tab ${args.index as number}; ${context.pages().length} tab(s) are open`);
				this.#current = page;
				await page.bringToFront();
				return { text: `Switched to tab ${args.index as number}: ${await this.#summary(page)}` };
			}
			case "close_tab": {
				const pages = context.pages();
				const page = args.index === undefined ? this.#current : pages[args.index as number];
				if (!page) throw new Error(args.index === undefined ? "NoPage: there is no current tab" : `InvalidArguments: no tab ${args.index as number}`);
				if (this.config.mode === "attach" && !this.#own.has(page)) throw new Error("NotOwnTab: attach mode closes only tabs the agent opened; this tab belongs to the user.");
				const summary = await this.#summary(page);
				await page.close();
				if (this.#current === page) this.#current = undefined;
				return { text: `Closed tab ${summary.replace("\n", " ")}` };
			}
			case "back":
			case "forward":
			case "reload": {
				const page = await this.#page();
				if (cmd === "back") await page.goBack({ waitUntil: "commit" });
				else if (cmd === "forward") await page.goForward({ waitUntil: "commit" });
				else await page.reload({ waitUntil: "domcontentloaded" });
				if (cmd !== "reload") {
					// BFCache restores do not emit DOMContentLoaded again. Wait for commit, then inspect the actual document.
					const ready = await page.waitForFunction("document.readyState !== 'loading'", undefined, { timeout: NAVIGATION_TIMEOUT_MS });
					await ready.dispose();
				}
				return { text: `Now at ${await this.#summary(page)}` };
			}
			case "wait": {
				const page = await this.#page();
				if (typeof args.ms === "number") {
					const ms = Math.min(Math.max(0, args.ms), MAX_WAIT_MS);
					await page.waitForTimeout(ms);
					return { text: `Waited ${ms} ms.` };
				}
				if (typeof args.text === "string") {
					await page.getByText(args.text).first().waitFor({ state: "visible" });
					return { text: `Text ${JSON.stringify(args.text)} is visible.` };
				}
				const part = args.url as string;
				await page.waitForURL((url) => url.href.includes(part));
				return { text: `Now at ${await this.#summary(page)}` };
			}
			case "text": {
				const page = await this.#page();
				const text = args.ref !== undefined || args.selector !== undefined ? await (await this.#target(page, args)).innerText() : await page.locator("body").innerText();
				return { text: clip(text, MAX_TEXT) };
			}
			case "eval": {
				const page = await this.#page();
				const value: unknown = await page.evaluate(args.js as string);
				const json = value === undefined ? "undefined" : (JSON.stringify(value) ?? String(value));
				return { text: clip(json, MAX_TEXT) };
			}
			case "window": {
				const page = this.#current && !this.#current.isClosed() ? this.#current : undefined;
				const brand = brandName(this.config.browser);
				const title = page ? await page.title().catch(() => "") : "";
				const full = this.config.browser === "chrome" ? "Google Chrome" : this.config.browser === "msedge" ? "Microsoft Edge" : "Chromium";
				return {
					text: JSON.stringify({
						mode: this.config.mode,
						browser: brand,
						pageTitle: title,
						url: page?.url() ?? null,
						expectedWindowTitle: title ? `${title} - ${full}` : null,
						computerUseWindow: title || brand,
						note: `For computer_use, target window "${title || brand}" (${brand}); the OS window title is usually "<page title> - ${full}".`,
					}),
				};
			}
		}
	}
}

function describeTarget(args: Record<string, unknown>): string {
	return typeof args.ref === "string" ? `ref ${args.ref}` : `selector ${JSON.stringify(args.selector)}`;
}

/** Patchright messages carry a long call log; keep the head. */
function firstLines(message: string): string {
	const head = message.split(/\nCall log:|\n=+ logs =+/)[0]!.trim();
	return clip(head, 1200);
}

/** Serve JSON-line requests one at a time until `input` ends, then close the session. */
export async function serve(session: Session, input: AsyncIterable<string>, write: (line: string) => void): Promise<void> {
	for await (const line of input) {
		if (line.trim() === "") continue;
		let request: HostRequest;
		try {
			request = JSON.parse(line) as HostRequest;
		} catch {
			continue;
		}
		let reply: HostReply;
		try {
			reply = { id: request.id, ok: true, result: await session.run(request.cmd, request.args ?? {}) };
		} catch (error) {
			reply = { id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) };
		}
		write(`${JSON.stringify(reply)}\n`);
	}
	await session.close();
}

/** Entry for a host process: stdin lines in, stdout lines out; the process exits when stdin closes. */
export async function serveStdio(session: Session): Promise<void> {
	// Background work (an action left waiting on a dialog) must not crash the host.
	process.on("unhandledRejection", (reason) => process.stderr.write(`unhandled: ${String(reason)}\n`));
	const cleanup = await publishDesktopDescriptor(process.env.DINOBOT_BROWSER_DESKTOP);
	try { await serve(session, console, (line) => process.stdout.write(line)); }
	finally { cleanup(); }
	process.exit(0);
}

export function hostConfigFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): HostConfig {
	const raw = env.DINOBOT_BROWSER_CONFIG;
	if (!raw) throw new Error("DINOBOT_BROWSER_CONFIG is not set");
	return JSON.parse(raw) as HostConfig;
}

if (import.meta.main) {
	const { chromium } = await import("patchright");
	await serveStdio(new Session(hostConfigFromEnv(), { chromium }));
}
