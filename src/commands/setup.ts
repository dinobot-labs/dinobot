import { existsSync, renameSync, unlinkSync } from "node:fs";
import { createPrivateFile, syncPrivateDirectory } from "../telegram-private-files/index.ts";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Models } from "@earendil-works/pi-ai";
import type { AuthService } from "../auth/types.ts";
import { runTelegramSetup, type TelegramSetupDependencies } from "../cli/telegram-setup.ts";
import type { Bot } from "../core/bot.ts";
import { dependenciesRoot, installDependency, platformKey } from "../deps/index.ts";
import type { Plugin } from "../plugins/types.ts";
import type { ReportService } from "../report/service.ts";
import { resolveLocale, type SetupCopy, setupCopy } from "../setup/locale.ts";
import { editManifestEntry, ManifestEditError, type ManifestSection } from "../setup/manifest-edit.ts";
import { type ManifestSnapshot, readManifestSnapshot } from "../setup/manifest-file.ts";
import { readSetupState, writeSetupState } from "../setup/state.ts";
import { currentModel, runLogin, switchModel } from "./builtin.ts";
import { setupTui } from "./report.ts";
import type { CommandInvocation, CommandIO, SlashCommand } from "./types.ts";

/** `/setup <section>` runs one step; plain `/setup` is the whole wizard. */
export const SETUP_SECTIONS = ["model", "channels", "plugins", "report"] as const;
type Section = (typeof SETUP_SECTIONS)[number];

/** Seconds a Telegram pairing link stays valid. */
const TELEGRAM_PAIRING_SECONDS = 300;
/** Bound on the one-message connection check after a login. */
const MODEL_CHECK_MS = 60_000;

export type SetupCore = { readonly bot: Bot; readonly models: Models; readonly auth: AuthService; readonly report?: ReportService };

export type SetupDeps = {
	/** Absolute path of the manifest this daemon booted from; the only file setup edits. */
	readonly manifestPath: string;
	readonly dataDir: string;
	/** The build's plugin catalog: dependencies to install when a plugin is turned on. */
	readonly pluginCatalog: Readonly<Record<string, Plugin>>;
	/** Test seams for the Telegram pairing flow (network, clock). */
	readonly telegram?: Pick<TelegramSetupDependencies, "fetch" | "now" | "sleep">;
	/** Test seam: install a plugin's external programs; resolves false when the plugin must stay off. */
	readonly install?: (pluginId: string, io: CommandIO, copy: SetupCopy) => Promise<boolean>;
	/** Test seam: prove `provider/modelId` answers; rejects with the reason otherwise. */
	readonly verifyModel?: (ref: string, signal: AbortSignal) => Promise<void>;
	readonly now?: () => Date;
};

/**
 * The first-run wizard (`/setup`, TUI only). Required: a model that answers. Optional, skippable: Telegram, computer use,
 * the browser, Google Workspace, problem reports. Manifest changes are never written here: they leave as one `apply` request (base hash + candidate
 * text) that the TUI applies with a safe restart, so a cancelled or failed setup leaves dinobot.yaml untouched.
 */
export function setupCommand(core: SetupCore, deps: SetupDeps): SlashCommand {
	return {
		name: "setup",
		description: "Set up dinobot: model, chat channels, features, problem reports",
		usage: "[model|channels|plugins|report]",
		surfaces: ["tui"],
		arguments: async () => SETUP_SECTIONS.map((section) => ({ value: section, label: section })),
		run: async (args, invocation) => {
			const copy = setupCopy(resolveLocale(invocation.locale));
			if (!invocation.io.interactive) {
				invocation.io.print(copy.needsTui);
				return;
			}
			const section = args.trim().toLowerCase();
			if (section !== "" && !(SETUP_SECTIONS as readonly string[]).includes(section)) throw new Error(copy.unknownSection(section, SETUP_SECTIONS.join(", ")));
			const session = new SetupSession(core, deps, invocation, copy, await readManifestSnapshot(deps.manifestPath));
			try {
				await session.run(section as Section | "");
			} finally {
				await session.cleanup();
			}
		},
	};
}

type Edit = { readonly section: ManifestSection; readonly key: string; readonly value: unknown };
type ManifestView = { readonly channels: Record<string, unknown>; readonly plugins: Record<string, unknown> };

class SetupSession {
	private readonly io: CommandIO;
	/** Pending manifest changes keyed `section.key`; insertion order is the order they are applied and listed. */
	private readonly edits = new Map<string, Edit>();
	/** Private files this run created; removed again unless a manifest change that uses them was handed off. */
	private readonly created = new Set<string>();
	private handedOff = false;
	/** The whole wizard (plain `/setup`), not one section: its last words point at feeding the agent context. */
	private onboarding = false;

	constructor(
		private readonly core: SetupCore,
		private readonly deps: SetupDeps,
		private readonly invocation: CommandInvocation,
		private readonly copy: SetupCopy,
		private readonly base: ManifestSnapshot,
	) {
		this.io = invocation.io;
	}

	async run(section: Section | ""): Promise<void> {
		const { copy } = this;
		switch (section) {
			case "model":
				await this.modelStep(copy.titles.model, true);
				return this.finish(copy.titles.apply);
			case "channels":
				await this.channelsStep(copy.titles.channels);
				return this.finish(copy.titles.apply);
			case "plugins":
				await this.pluginsStep(copy.titles.plugins);
				return this.finish(copy.titles.apply);
			case "report":
				await this.reportStep(copy.titles.report);
				return this.finish(copy.titles.apply);
		}
		this.onboarding = true;
		const state = await readSetupState(this.deps.dataDir);
		if (state.startedAt === undefined) await writeSetupState(this.deps.dataDir, { ...state, startedAt: this.now() });
		const model = await this.modelStep(copy.step(1, 2, copy.titles.model), false);
		const path = await this.select(`${copy.step(2, 2, copy.titles.next)}\n${copy.nextMessage(model)}`, [
			{ id: "quick", label: copy.quick, tag: copy.quickHint },
			{ id: "full", label: copy.full, description: copy.fullHint },
		]);
		if (path === "full") {
			const total = this.core.report ? 6 : 5;
			await this.channelsStep(copy.step(3, total, copy.titles.channels));
			await this.pluginsStep(copy.step(4, total, copy.titles.plugins));
			if (this.core.report) await this.reportStep(copy.step(5, total, copy.titles.report));
			await this.finish(copy.step(total, total, copy.titles.apply));
		} else {
			await this.finish(copy.titles.apply);
		}
		await writeSetupState(this.deps.dataDir, { ...(await readSetupState(this.deps.dataDir)), completedAt: this.now() });
	}

	/** Removes files this run created for a change that never left (cancel, failure, nothing applied). */
	async cleanup(): Promise<void> {
		if (this.handedOff) return;
		for (const path of this.created) await rm(path, { force: true }).catch(() => undefined);
	}

	// ── ① model ────────────────────────────────────────────────────────────────────────────────

	/**
	 * Ensures the thread's model is signed in and answers. Already working: kept without a prompt unless `choose`. Otherwise
	 * provider login (repeatable on failure), then a model choice when the default needs another provider, then a one-message
	 * check; a failed check offers another model or continuing anyway.
	 */
	private async modelStep(label: string, choose: boolean): Promise<string> {
		const { copy, io } = this;
		let ref = await this.currentModel();
		if (ref !== undefined && (await this.available(ref)) && !choose) {
			io.print(copy.modelKept(ref), "success");
			return ref;
		}
		if (choose && ref !== undefined && (await this.available(ref))) {
			ref = (await switchModel(this.core.bot, this.core.models, this.invocation, "", `${label}\n${copy.chooseModel}`)) ?? ref;
		}
		while (ref === undefined || !(await this.available(ref))) {
			try {
				const result = await runLogin(this.core.auth, io, "", `${label}\n${copy.loginIntro}`);
				if (!result.provider.modelProvider) {
					io.print(copy.loginOnly, "error");
					continue;
				}
			} catch (error) {
				if (cancelled(error, io)) throw error;
				io.print(copy.loginFailed(message(error)), "error");
				continue;
			}
			ref = await this.currentModel();
			if (ref === undefined || !(await this.available(ref))) {
				ref = (await switchModel(this.core.bot, this.core.models, this.invocation, "", `${label}\n${copy.chooseModel}`)) ?? ref;
			}
		}
		while (true) {
			io.print(copy.checkingModel(ref));
			try {
				await this.verifyModel(ref);
				io.print(copy.modelOk(ref), "success");
				return ref;
			} catch (error) {
				if (cancelled(error, io)) throw error;
				const next = await this.select(`${label}\n${copy.modelFailed(ref, message(error))}`, [
					{ id: "other", label: copy.modelRetry },
					{ id: "continue", label: copy.modelContinue },
				]);
				if (next === "continue") return ref;
				ref = (await switchModel(this.core.bot, this.core.models, this.invocation, "", `${label}\n${copy.chooseModel}`)) ?? ref;
			}
		}
	}

	private async currentModel(): Promise<string | undefined> {
		const { bot } = this.core;
		return currentModel(bot, this.invocation.channel, this.invocation.threadKey, this.invocation.context);
	}

	/** The model exists in this build and its provider has a credential. */
	private async available(ref: string): Promise<boolean> {
		const slash = ref.indexOf("/");
		const model = this.core.models.getModel(ref.slice(0, slash), ref.slice(slash + 1));
		if (model === undefined) return false;
		try {
			return (await this.core.models.getAuth(model)) !== undefined;
		} catch {
			return false;
		}
	}

	private async verifyModel(ref: string): Promise<void> {
		if (this.deps.verifyModel) return this.deps.verifyModel(ref, this.io.signal);
		const slash = ref.indexOf("/");
		const model = this.core.models.getModel(ref.slice(0, slash), ref.slice(slash + 1));
		if (model === undefined) throw new Error(`unknown model ${ref}`);
		const response = await this.core.models.completeSimple(
			model,
			{ messages: [{ role: "user", content: "Reply with the single word OK.", timestamp: Date.now() }] },
			{ maxTokens: 32, signal: AbortSignal.any([this.io.signal, AbortSignal.timeout(MODEL_CHECK_MS)]) },
		);
		if (response.stopReason === "error" || response.stopReason === "aborted") throw new Error(response.errorMessage || response.stopReason);
	}

	// ── ③ channels ─────────────────────────────────────────────────────────────────────────────

	private async channelsStep(label: string): Promise<void> {
		const { copy } = this;
		const view = this.view();
		const has = (name: string) => Object.hasOwn(view.channels, name);
		const checked = await this.checklist(`${label}\n${copy.channelsMessage}`, [
			{ id: "tui", label: copy.terminal, tag: copy.always, checked: true, disabled: true },
			{ id: "telegram", label: copy.telegram, description: copy.telegramHint, checked: has("telegram") },
			// Not managed by setup yet: shown with their real state, never toggled here.
			{ id: "slack", label: copy.slack, description: has("slack") ? copy.configuredElsewhere : copy.slackHint, checked: has("slack"), disabled: true },
			{ id: "discord", label: copy.discord, description: has("discord") ? copy.configuredElsewhere : copy.discordHint, checked: has("discord"), disabled: true },
		]);
		const wantTelegram = checked.includes("telegram");
		if (wantTelegram && !has("telegram")) {
			const block = await this.telegram();
			if (block !== undefined) this.stage({ section: "channels", key: "telegram", value: block });
		} else if (!wantTelegram && has("telegram")) {
			this.stage({ section: "channels", key: "telegram", value: undefined });
		}
	}

	/**
	 * Pairs a Telegram bot through `dinobot telegram connect`'s own flow (token check, private one-time link, owner
	 * pairing) and returns the polling channel block. Token and pairing live next to the manifest, mode 0600.
	 */
	private async telegram(): Promise<Record<string, unknown> | undefined> {
		const { copy, io } = this;
		const dir = join(dirname(this.deps.manifestPath), "telegram");
		const tokenPath = join(dir, "bot.token");
		const pairingPath = join(dir, "pairing.json");
		const block = { mode: "polling", botTokenFile: tokenPath, pairingPath, databasePath: join(this.deps.dataDir, "telegram-inbox.sqlite"), port: 0 };
		if (existsSync(pairingPath)) {
			if (existsSync(tokenPath)) {
				io.print(copy.telegramReuse);
				return block;
			}
			io.print(copy.telegramPairingWithoutToken(pairingPath), "error");
			return undefined;
		}
		while (true) {
			const token = (await io.prompt({ type: "secret", message: copy.telegramToken, placeholder: copy.telegramTokenPlaceholder })).trim();
			await writePrivateFile(tokenPath, `${token}\n`);
			this.created.add(tokenPath);
			let bot = "";
			try {
				await runTelegramSetup(["connect", "--token-file", tokenPath, "--pairing-file", pairingPath, "--timeout-seconds", String(TELEGRAM_PAIRING_SECONDS)], {
					...this.abortableTelegram(),
					output: (line) => {
						const link = /^https:\/\/t\.me\/([A-Za-z0-9_]+)\?start=/.exec(line);
						if (line.startsWith("Keep this one-time pairing link private")) io.print(copy.telegramOpen);
						else if (link) {
							bot = `@${link[1]}`;
							io.print(line);
						} else if (line.startsWith("Or send ")) {
							const command = /\/start \S+/.exec(line)?.[0];
							if (command) io.print(copy.telegramOr(command));
							io.print(copy.telegramWaiting);
						} else if (line.startsWith("Warning:")) io.print(line);
						// The closing manifest snippet is setup's own job here.
					},
				});
			} catch (error) {
				if (cancelled(error, io)) throw error;
				io.print(copy.telegramFailed(message(error)), "error");
				const next = await this.select(copy.telegramFailed(message(error)), [
					{ id: "retry", label: copy.telegramRetry },
					{ id: "skip", label: copy.telegramSkip },
				]);
				if (next === "skip") {
					await rm(tokenPath, { force: true });
					this.created.delete(tokenPath);
					return undefined;
				}
				continue;
			}
			this.created.add(pairingPath);
			io.print(copy.telegramPaired(bot), "success");
			return block;
		}
	}

	/** Telegram network and clock bound to this run: Esc aborts the pairing wait at once. */
	private abortableTelegram(): Pick<TelegramSetupDependencies, "fetch" | "now" | "sleep"> {
		const signal = this.io.signal;
		const seams = this.deps.telegram ?? {};
		const baseFetch = seams.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
		const baseSleep = seams.sleep;
		return {
			...(seams.now ? { now: seams.now } : {}),
			fetch: (url, init) => baseFetch(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, signal]) : signal }),
			sleep: async (ms) => {
				signal.throwIfAborted();
				if (baseSleep) return baseSleep(ms);
				await new Promise<void>((resolve, reject) => {
					const timer = setTimeout(() => {
						signal.removeEventListener("abort", onAbort);
						resolve();
					}, ms);
					const onAbort = () => {
						clearTimeout(timer);
						reject(new Error("aborted"));
					};
					signal.addEventListener("abort", onAbort, { once: true });
				});
			},
		};
	}

	// ── ④ plugins ──────────────────────────────────────────────────────────────────────────────

	private async pluginsStep(label: string): Promise<void> {
		const { copy } = this;
		const view = this.view();
		const on = (id: string) => Object.hasOwn(view.plugins, id) && view.plugins[id] !== false;
		const computerOn = on("computer");
		const browserOn = on("browser");
		const googleOn = on("google");
		const calendarOn = on("calendar");
		const webOn = view.plugins.web !== false;
		const checked = await this.checklist(`${label}\n${copy.pluginsMessage}`, [
			// Web search needs no consent (ADR 0058): shown locked with its real state.
			{ id: "web", label: copy.web, tag: webOn ? copy.webHint : copy.webOff, checked: webOn, disabled: true },
			{ id: "computer", label: copy.computer, description: copy.computerHint, checked: computerOn },
			// Already on: the tag shows which Chrome it uses; switching modes is turning it off and on again.
			{ id: "browser", label: copy.browser, description: copy.browserHint, ...(browserOn ? { tag: copy.browserMode(browserMode(view.plugins.browser)) } : {}), checked: browserOn },
			// Read-only defaults; the account is linked on first use through the plugin's own login link.
			{ id: "google", label: copy.google, description: copy.googleHint, checked: googleOn },
			// Local store, no account (ADR 0106): turning it on is the empty block.
			{ id: "calendar", label: copy.calendar, description: copy.calendarHint, checked: calendarOn },
		]);
		const wantComputer = checked.includes("computer");
		if (wantComputer && !computerOn) {
			if (await this.install("computer")) this.stage({ section: "plugins", key: "computer", value: {} });
		} else if (!wantComputer && computerOn) {
			this.stage({ section: "plugins", key: "computer", value: undefined });
		}
		const wantBrowser = checked.includes("browser");
		if (wantBrowser && !browserOn) await this.browser(label);
		else if (!wantBrowser && browserOn) this.stage({ section: "plugins", key: "browser", value: undefined });
		const wantGoogle = checked.includes("google");
		if (wantGoogle && !googleOn) this.stage({ section: "plugins", key: "google", value: {} });
		else if (!wantGoogle && googleOn) this.stage({ section: "plugins", key: "google", value: undefined });
		const wantCalendar = checked.includes("calendar");
		if (wantCalendar && !calendarOn) this.stage({ section: "plugins", key: "calendar", value: {} });
		else if (!wantCalendar && calendarOn) this.stage({ section: "plugins", key: "calendar", value: undefined });
	}

	/**
	 * Newly turned-on browser: one choice. The bot's own Chrome needs nothing else. The user's own Chrome needs computer use
	 * too, since its first use turns on Chrome's remote debugging and accepts the permission dialog with computer_use; when
	 * computer use cannot be installed the browser stays off rather than staging an attach mode that cannot connect.
	 */
	private async browser(label: string): Promise<void> {
		const { copy, io } = this;
		const mode = await this.select(`${label}\n${copy.browserChoice}`, [
			{ id: "dedicated", label: copy.browserDedicated, tag: copy.browserRecommended, description: copy.browserDedicatedHint },
			{ id: "attach", label: copy.browserAttach, description: copy.browserAttachHint },
		]);
		if (mode !== "attach") {
			this.stage({ section: "plugins", key: "browser", value: {} });
			return;
		}
		const computer = this.view().plugins.computer;
		if (computer === undefined || computer === false) {
			io.print(copy.browserNeedsComputer);
			if (!(await this.install("computer"))) {
				io.print(copy.browserAttachOff, "error");
				return;
			}
			this.stage({ section: "plugins", key: "computer", value: {} });
		}
		this.stage({ section: "plugins", key: "browser", value: { mode: "attach" } });
	}

	/** Installs the plugin's pinned external programs (the same installer as `dinobot init`). */
	private async install(pluginId: string): Promise<boolean> {
		const { copy, io } = this;
		if (this.deps.install) return this.deps.install(pluginId, io, copy);
		const platform = platformKey();
		const root = dependenciesRoot();
		for (const dependency of this.deps.pluginCatalog[pluginId]?.dependencies ?? []) {
			const artifact = dependency.artifacts[platform];
			if (artifact === undefined) {
				io.print(copy.computerUnavailable, "error");
				return false;
			}
			const what = `${dependency.id} ${dependency.version}`;
			io.print(copy.installing(what));
			const outcome = await installDependency(dependency, { root, platform, signal: io.signal, log: (line) => io.print(`  ${line}`) });
			if (outcome.status === "failed" || outcome.status === "unsupported") {
				io.signal.throwIfAborted();
				io.print(copy.installFailed(what, outcome.status === "failed" ? outcome.error : copy.computerUnavailable), "error");
				return false;
			}
			io.print(copy.installed(what), "success");
			const grant = artifact.macosApp?.permissionArgs;
			if (grant && outcome.status === "installed") io.print(copy.grantPermissions([outcome.path, ...grant].join(" ")));
		}
		return true;
	}

	// ── ⑤ problem reports ──────────────────────────────────────────────────────────────────────

	private async reportStep(label: string): Promise<void> {
		const { copy } = this;
		const report = this.core.report;
		if (!report) return;
		const consent = await report.consent("owner");
		const choice = await this.select(
			`${label}\n${copy.reportMessage}`,
			consent.receipt
				? [
						{ id: "keep", label: copy.reportKeep, tag: copy.reportOn(consent.auto) },
						{ id: "review", label: copy.reportChange },
					]
				: [
						// Personal-data consent is never the default (ADR 0073).
						{ id: "later", label: copy.reportLater },
						{ id: "review", label: copy.reportTurnOn },
					],
		);
		if (choice === "review") await setupTui(report, this.invocation);
	}

	// ── ⑥ apply / ⑦ summary ────────────────────────────────────────────────────────────────────

	/**
	 * Nothing staged: print the summary. Otherwise derive the candidate from the base text (one entry at a time, comments
	 * kept), confirm, and hand it to the front end; setup itself never writes the manifest.
	 */
	private async finish(label: string): Promise<void> {
		const { copy, io } = this;
		if (this.edits.size === 0) {
			io.print((await this.summary(this.base.text)).join("\n"), "success");
			return;
		}
		let candidate = this.base.text;
		try {
			for (const edit of this.edits.values()) candidate = editManifestEntry(candidate, edit.section, edit.key, edit.value);
		} catch (error) {
			if (!(error instanceof ManifestEditError)) throw error;
			io.print(`${message(error)}\n${copy.nothingChanged}`, "error");
			return;
		}
		const changes = [...this.edits.values()].map((edit) => (edit.value === undefined ? copy.removed(`${edit.section}.${edit.key}`) : copy.added(`${edit.section}.${edit.key}`)));
		const choice = await this.select(`${label}\n${copy.applyMessage(this.deps.manifestPath)}\n${changes.join("\n")}\n${copy.applyRestart}`, [
			{ id: "apply", label: copy.applyConfirm },
			{ id: "cancel", label: copy.applyCancel },
		]);
		if (choice !== "apply") {
			io.print(copy.nothingChanged);
			if (this.onboarding) io.print(copy.contextTip, "success");
			return;
		}
		if (io.apply === undefined) throw new Error("this front end cannot apply setup changes");
		io.apply({
			manifestPath: this.deps.manifestPath,
			baseSha256: this.base.sha256,
			candidate,
			changes,
			summary: await this.summary(candidate),
			locale: this.invocation.locale ?? "",
		});
		this.handedOff = true;
	}

	private async summary(text: string): Promise<string[]> {
		const { copy } = this;
		const view = parseView(text);
		const names: Record<string, string> = { telegram: copy.telegram, slack: copy.slack, discord: copy.discord, http: "HTTP", computer: copy.computer, browser: copy.browser, google: copy.google, calendar: copy.calendar, web: copy.web };
		const channels = [copy.terminal, ...Object.keys(view.channels).map((key) => names[key] ?? key)];
		const features = [
			...(view.plugins.web === false ? [] : [copy.web]),
			...Object.entries(view.plugins).filter(([key, value]) => key !== "web" && key !== "skills" && value !== false).map(([key]) => names[key] ?? key),
		];
		const lines = [
			`✓ ${copy.summaryModel}: ${(await this.currentModel()) ?? "-"}`,
			`✓ ${copy.summaryChannels}: ${channels.join(" · ")}`,
			`✓ ${copy.summaryFeatures}: ${features.join(" · ") || "-"}`,
		];
		if (this.core.report) {
			const consent = await this.core.report.consent("owner");
			lines.push(`${consent.receipt ? "✓" : "–"} ${copy.summaryReport}: ${consent.receipt ? copy.reportOn(consent.auto) : copy.reportOff}`);
		}
		lines.push(copy.summaryAgain, copy.summaryAdvanced(this.deps.manifestPath));
		// Last, after a blank line, so it is what a finished onboarding ends on (also after an applied restart).
		if (this.onboarding) lines.push("", copy.contextTip);
		return lines;
	}

	// ── helpers ────────────────────────────────────────────────────────────────────────────────

	private stage(edit: Edit): void {
		this.edits.set(`${edit.section}.${edit.key}`, edit);
	}

	/** The manifest as setup will leave it: the base plus staged edits (no YAML round trip needed for reading). */
	private view(): ManifestView {
		const view = parseView(this.base.text);
		for (const edit of this.edits.values()) {
			const target = view[edit.section];
			if (edit.value === undefined) delete target[edit.key];
			else target[edit.key] = edit.value;
		}
		return view;
	}

	private select(text: string, options: readonly { id: string; label: string; description?: string; tag?: string }[]): Promise<string> {
		return this.io.prompt({ type: "select", message: text, options });
	}

	private async checklist(text: string, options: readonly { id: string; label: string; description?: string; tag?: string; checked: boolean; disabled?: boolean }[]): Promise<string[]> {
		const answer = await this.io.prompt({ type: "checklist", message: text, options });
		const parsed: unknown = JSON.parse(answer);
		if (!Array.isArray(parsed) || !parsed.every((id): id is string => typeof id === "string")) throw new Error("malformed checklist answer");
		return parsed;
	}

	private now(): string {
		return (this.deps.now?.() ?? new Date()).toISOString();
	}
}

/** The configured browser mode; anything but `attach` is the plugin's default, the bot's own Chrome. */
function browserMode(config: unknown): "dedicated" | "attach" {
	return typeof config === "object" && config !== null && (config as { mode?: unknown }).mode === "attach" ? "attach" : "dedicated";
}

function parseView(text: string): ManifestView {
	const raw = Bun.YAML.parse(text) as { channels?: unknown; plugins?: unknown } | null;
	const mapping = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {});
	return { channels: mapping(raw?.channels), plugins: mapping(raw?.plugins) };
}

/** Atomically replace the credential with a protected file, including on setup retries. */
async function writePrivateFile(path: string, text: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${crypto.randomUUID()}.tmp`;
	try {
		createPrivateFile(temporary, text);
		renameSync(temporary, path);
		syncPrivateDirectory(dirname(path));
	} catch {
		throw new Error("Unable to save Telegram credential securely");
	} finally {
		try { unlinkSync(temporary); } catch {}
	}
}

/** Esc in the TUI cancels the pending prompt and aborts the run; either way the whole setup stops. */
function cancelled(error: unknown, io: CommandIO): boolean {
	return io.signal.aborted || (error instanceof Error && (error.message === "cancelled" || error.message === "aborted"));
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
