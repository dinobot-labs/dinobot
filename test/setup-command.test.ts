import { readPrivateFile } from "../src/telegram-private-files/index.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AuthInteraction, CredentialStore, Models } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { AuthService, LoginProvider } from "../src/auth/types.ts";
import { channelCatalog } from "../src/channels/index.ts";
import { defaultManifest } from "../src/cli/default-manifest.ts";
import { type Commands, createCommands } from "../src/commands/index.ts";
import type { SetupDeps } from "../src/commands/setup.ts";
import type { CommandEvent, CommandPromptSpec, ManifestApplyRequest } from "../src/commands/types.ts";
import { type Bot, openBot } from "../src/core/bot.ts";
import { parseManifest } from "../src/manifest.ts";
import { pluginCatalog } from "../src/plugins/index.ts";
import type { ReportService } from "../src/report/service.ts";
import { detectLocale, resolveLocale, setupCopy, systemLocale } from "../src/setup/locale.ts";
import { sha256Hex } from "../src/setup/manifest-file.ts";
import { readSetupState } from "../src/setup/state.ts";

const context = BACKGROUND_CONTEXT;
const TOKEN = "123456:FAKE_credential_for_offline_tests_only";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

type Answer = string | string[] | { cancel: true };
type Script = (prompt: CommandPromptSpec, seen: readonly CommandEvent[]) => Answer;

/** A daemon-side world: real bot + commands over a temp HOME; models gated by which providers are "logged in". */
async function world(options: { loggedIn?: boolean; report?: ReportService; failVerify?: (ref: string) => string | undefined; loginFails?: number; manifest?: (home: string) => string; installFails?: boolean } = {}) {
	const home = await mkdtemp(join(tmpdir(), "dinobot-setup-"));
	const config = join(home, ".config", "dinobot");
	const dataDir = join(home, "data");
	await mkdir(config, { recursive: true });
	await mkdir(dataDir, { recursive: true });
	const manifestPath = join(config, "dinobot.yaml");
	const base = options.manifest?.(home) ?? defaultManifest(home);
	await writeFile(manifestPath, base);

	const logged = new Set<string>(options.loggedIn ? ["faux"] : []);
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", name: "Faux 1" }, { id: "faux-2", name: "Faux 2" }] });
	const real = createModels();
	real.setProvider(faux.provider);
	const models = new Proxy(real, {
		get(target, key) {
			if (key === "getAuth") return async (model: { provider: string }) => (logged.has(model.provider) ? {} : undefined);
			if (key === "getAvailable") return async (provider?: string) => (await target.getAvailable(provider)).filter((model) => logged.has(model.provider));
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as Models;
	const bot: Bot = await openBot({ storage: await openNodeSqliteStorage(join(dataDir, "bot.sqlite")), models: real, defaultModel: { provider: "faux", modelId: "faux-1" }, toolMode: "direct", plugins: [] }, context);
	cleanup.push(async () => {
		await bot.close(context);
		await rm(home, { recursive: true, force: true });
	});

	let loginFails = options.loginFails ?? 0;
	const providers: LoginProvider[] = [
		{ id: "faux", name: "Faux", storeAs: "faux", modelProvider: "faux" },
		{ id: "cursor", name: "Cursor", storeAs: "cursor" },
	];
	const auth: AuthService = {
		credentials: {} as CredentialStore,
		providers: async () => providers,
		async login(id: string, interaction: AuthInteraction) {
			const provider = providers.find((entry) => entry.id === id)!;
			await interaction.prompt({ type: "secret", message: `${provider.name} API key` });
			if (loginFails-- > 0) throw new Error("invalid api key");
			if (provider.modelProvider) logged.add(provider.modelProvider);
			return { provider, type: "api_key" as const };
		},
		logout: async () => false,
		status: async () => [...logged].map((key) => ({ key, type: "api_key" as const })),
		accounts: async () => [],
		useAccount: async () => {
			throw new Error("no accounts");
		},
	};

	// Telegram Bot API double: the pairing nonce is taken from the link setup prints.
	const telegram = { code: "", time: 0, calls: [] as string[] };
	const installs: string[] = [];
	const deps: SetupDeps = {
		manifestPath,
		dataDir,
		pluginCatalog,
		verifyModel: async (ref) => {
			const failure = options.failVerify?.(ref);
			if (failure) throw new Error(failure);
		},
		install: async (id, io) => {
			installs.push(id);
			if (options.installFails) return false;
			io.print(`installed ${id}`, "success");
			return true;
		},
		telegram: {
			now: () => telegram.time,
			sleep: async (ms) => {
				telegram.time += ms;
				await Bun.sleep(1);
			},
			fetch: async (url, init) => {
				const parsed = new URL(url);
				const method = parsed.pathname.split("/").pop()!;
				telegram.calls.push(method);
				if (init.signal?.aborted) throw new Error("aborted");
				const result =
					method === "getMe" ? { id: 123456, is_bot: true, username: "FauxSetupBot" }
					: method === "getWebhookInfo" ? { url: "" }
					: telegram.code ? [{ update_id: 7, message: { from: { id: 42, is_bot: false }, chat: { id: 42, type: "private" }, text: `/start ${telegram.code}` } }]
					: [];
				return Response.json({ ok: true, result });
			},
		},
		now: () => new Date("2026-10-10T00:00:00Z"),
	};
	const commands = createCommands({ bot, models, auth, plugins: [], ...(options.report ? { report: options.report } : {}), setup: deps });
	return { home, config, dataDir, manifestPath, base, commands, telegram, installs, logged };
}

/** Runs `/setup <args>` answering every prompt with `script`; returns every event. `abortWhen` aborts the run. */
async function drive(commands: Commands, args: string, script: Script, options: { locale?: string; abortWhen?: (event: CommandEvent) => boolean; onEvent?: (event: CommandEvent) => void } = {}) {
	const command = commands.find("setup", "tui");
	if (command === undefined) throw new Error("no /setup");
	const abort = new AbortController();
	const run = commands.run(command, args, { surface: "tui", channel: "tui", threadKey: "t1", userId: "roach", context, signal: abort.signal, ...(options.locale ? { locale: options.locale } : {}) });
	const events: CommandEvent[] = [];
	let runId = "";
	for await (const event of run.events) {
		events.push(event);
		options.onEvent?.(event);
		if (event.type === "started") runId = event.runId;
		if (options.abortWhen?.(event)) abort.abort();
		if (event.type === "prompt") {
			const answer = script(event.prompt, events);
			const value = typeof answer === "string" ? { value: answer } : Array.isArray(answer) ? { value: JSON.stringify(answer) } : answer;
			queueMicrotask(() => commands.answer(runId, event.id, value));
		}
	}
	return events;
}

const prompts = (events: readonly CommandEvent[]) => events.flatMap((event) => (event.type === "prompt" ? [event.prompt] : []));
const outputs = (events: readonly CommandEvent[]) => events.flatMap((event) => (event.type === "output" ? [event.text] : []));
const applied = (events: readonly CommandEvent[]): ManifestApplyRequest | undefined => events.flatMap((event) => (event.type === "apply" ? [event.request] : []))[0];
const title = (prompt: CommandPromptSpec) => prompt.message.split("\n")[0];

describe("/setup", () => {
	test("first run (en, Quick): login on the login card, a real answer check, then start now; nothing written, state recorded", async () => {
		const w = await world();
		const events = await drive(w.commands, "", (prompt) => {
			if (prompt.type === "select" && prompt.login) return "faux";
			if (prompt.type === "secret") return "sk-test";
			if (prompt.type === "select") return "quick";
			throw new Error(`unexpected ${prompt.type}`);
		}, { locale: "en_US.UTF-8" });
		const asked = prompts(events);
		expect(asked.map((prompt) => [prompt.type, title(prompt)])).toEqual([
			["select", "Setup 1/2 · Connect a model"],
			["secret", "Faux API key"],
			["select", "Setup 2/2 · Ready"],
		]);
		expect(asked[0]!.type === "select" && asked[0]!.login).toBe(true);
		expect(asked[2]!.message).toContain("faux/faux-1 connected");
		expect(asked[2]!.type === "select" && asked[2]!.options.map((option) => option.id)).toEqual(["quick", "full"]);
		const printed = outputs(events);
		expect(printed).toContain("logged in to Faux (api_key, stored as faux)");
		expect(printed).toContain("Checking that faux/faux-1 answers…");
		expect(printed.at(-1)).toContain("✓ Model: faux/faux-1\n✓ Chat: Terminal (TUI)\n✓ Features: Web search");
		// The onboarding ends on the invitation to hand the agent folders about you and your projects.
		expect(printed.at(-1)!.endsWith(`\n\n${setupCopy("en").contextTip}`)).toBe(true);
		expect(printed.at(-1)).toContain("@folder:path");
		expect(applied(events)).toBeUndefined();
		expect(events.at(-1)).toEqual({ type: "done" });
		expect(await readFile(w.manifestPath, "utf8")).toBe(w.base);
		expect(await readSetupState(w.dataDir)).toEqual({ startedAt: "2026-10-10T00:00:00.000Z", completedAt: "2026-10-10T00:00:00.000Z" });
	});

	test("Full setup (ko): Telegram pairing + computer use become one apply request; the manifest itself is untouched", async () => {
		const w = await world({ loggedIn: true });
		const events = await drive(w.commands, "", (prompt, seen) => {
			if (title(prompt) === "설정 2/2 · 준비 완료") return "full";
			if (title(prompt) === "설정 3/5 · 대화할 곳") return ["tui", "telegram"];
			if (prompt.type === "secret") return TOKEN;
			if (title(prompt) === "설정 4/5 · 기능") return ["web", "computer"];
			if (title(prompt) === "설정 5/5 · 적용") return "apply";
			throw new Error(`unexpected ${prompt.message} after ${JSON.stringify(seen.at(-2))}`);
		}, {
			locale: "ko_KR.UTF-8",
			onEvent: (event) => {
				const code = event.type === "output" ? /\?start=([A-Za-z0-9_-]+)/.exec(event.text)?.[1] : undefined;
				if (code) w.telegram.code = code;
			},
		});
		const asked = prompts(events);
		const channels = asked.find((prompt) => title(prompt) === "설정 3/5 · 대화할 곳")!;
		expect(channels.type === "checklist" && channels.options.map((option) => [option.id, option.checked, option.disabled ?? false])).toEqual([
			["tui", true, true], ["telegram", false, false], ["slack", false, true], ["discord", false, true],
		]);
		const features = asked.find((prompt) => title(prompt) === "설정 4/5 · 기능")!;
		expect(features.type === "checklist" && features.options.map((option) => [option.id, option.checked, option.disabled ?? false])).toEqual([["web", true, true], ["computer", false, false], ["browser", false, false], ["google", false, false]]);
		const printed = outputs(events);
		expect(printed).toContain("모델: faux/faux-1");
		expect(printed).toContain("https://t.me/FauxSetupBot?start=" + w.telegram.code);
		expect(printed).toContain("텔레그램 @FauxSetupBot 연결됨. 나만 대화할 수 있어요.");
		expect(printed.join("\n")).not.toContain(TOKEN);
		expect(w.installs).toEqual(["computer"]);

		const request = applied(events)!;
		expect(request.manifestPath).toBe(w.manifestPath);
		expect(request.baseSha256).toBe(sha256Hex(w.base));
		expect(request.changes).toEqual(["+ channels.telegram", "+ plugins.computer"]);
		expect(request.locale).toBe("ko_KR.UTF-8");
		const tokenFile = join(w.config, "telegram", "bot.token");
		const pairing = join(w.config, "telegram", "pairing.json");
		expect(Bun.YAML.parse(request.candidate)).toMatchObject({
			channels: { telegram: { mode: "polling", botTokenFile: tokenFile, pairingPath: pairing, databasePath: join(w.dataDir, "telegram-inbox.sqlite"), port: 0 } },
			plugins: { computer: {} },
		});
		for (const line of w.base.split("\n").filter((line) => line.includes("#"))) expect(request.candidate).toContain(line.slice(line.indexOf("#")));
		expect(readPrivateFile(tokenFile, 1024).trim()).toBe(TOKEN);
		expect(JSON.parse(readPrivateFile(pairing, 65536)).userId).toBe("42");
		if (process.platform !== "win32") expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
		expect(JSON.parse(await readFile(pairing, "utf8"))).toEqual({ botId: "123456", userId: "42", chatIds: ["42"] });
		// The candidate is a manifest the daemon would boot: Telegram reads its token and pairing for real here.
		const manifest = await parseManifest(Bun.YAML.parse(request.candidate), { channels: channelCatalog, plugins: pluginCatalog });
		expect(manifest.channels.map((channel) => channel.name)).toEqual(["telegram"]);
		expect(manifest.plugins.map((plugin) => plugin.id)).toContain("computer");
		expect(request.summary).toContain("✓ 대화: 터미널 (TUI) · Telegram");
		expect(request.summary).toContain("✓ 기능: 웹 검색 · 컴퓨터 사용");
		// Printed after the restart, so the Korean onboarding still ends on the context invitation.
		expect(request.summary.slice(-2)).toEqual(["", setupCopy("ko").contextTip]);
		expect(request.summary.at(-1)).toContain("폴더들을 마구마구 넣어 주세요");
		expect(await readFile(w.manifestPath, "utf8")).toBe(w.base);
		expect((await readSetupState(w.dataDir)).completedAt).toBeDefined();
	});

	for (const existing of [false, true]) test(`Telegram invalid-token retry replaces a protected credential (preexisting=${existing})`, async () => {
		const w = await world({ loggedIn: true });
		const tokenPath = join(w.config, "telegram", "bot.token");
		if (existing) {
			await mkdir(join(w.config, "telegram"));
			await writeFile(tokenPath, "stale invalid token");
		}
		let attempts = 0;
		const events = await drive(w.commands, "channels", (prompt) => {
			if (prompt.type === "checklist") return ["tui", "telegram"];
			if (prompt.type === "secret") return attempts++ === 0 ? "invalid-token" : TOKEN;
			if (prompt.type === "select") return prompt.options.some((option) => option.id === "retry") ? "retry" : "apply";
			throw new Error(`unexpected ${prompt.type}`);
		}, { locale: "en", onEvent: (event) => {
			const code = event.type === "output" ? /\?start=([A-Za-z0-9_-]+)/.exec(event.text)?.[1] : undefined;
			if (code) w.telegram.code = code;
		} });
		expect(attempts).toBe(2);
		expect(events.at(-1)).toEqual({ type: "done" });
		expect(applied(events)?.changes).toEqual(["+ channels.telegram"]);
		expect(readPrivateFile(tokenPath, 1024).trim()).toBe(TOKEN);
		expect(JSON.parse(readPrivateFile(join(w.config, "telegram", "pairing.json"), 65536)).userId).toBe("42");
		expect(outputs(events).join("\n")).not.toContain(TOKEN);
	});

	test("cancelling at the apply step changes nothing and removes the files the run created", async () => {
		const w = await world({ loggedIn: true });
		const events = await drive(w.commands, "channels", (prompt) => {
			if (prompt.type === "checklist") return ["tui", "telegram"];
			if (prompt.type === "secret") return TOKEN;
			if (prompt.type === "select") return "cancel";
			throw new Error(`unexpected ${prompt.type}`);
		}, { onEvent: (event) => { const code = event.type === "output" ? /\?start=([A-Za-z0-9_-]+)/.exec(event.text)?.[1] : undefined; if (code) w.telegram.code = code; } });
		expect(applied(events)).toBeUndefined();
		expect(outputs(events)).toContain("Nothing was changed.");
		// One section is not the onboarding: no closing invitation.
		expect(outputs(events)).not.toContain(setupCopy("en").contextTip);
		expect(existsSync(join(w.config, "telegram", "bot.token"))).toBe(false);
		expect(existsSync(join(w.config, "telegram", "pairing.json"))).toBe(false);
		expect(await readFile(w.manifestPath, "utf8")).toBe(w.base);
	});

	test("Esc while waiting for Telegram stops at once: no pairing, no token left behind, no apply", async () => {
		const w = await world({ loggedIn: true });
		const events = await drive(w.commands, "channels", (prompt) => {
			if (prompt.type === "checklist") return ["tui", "telegram"];
			if (prompt.type === "secret") return TOKEN;
			throw new Error(`unexpected ${prompt.type}`);
		}, { abortWhen: (event) => event.type === "output" && event.text.startsWith("Waiting for you in Telegram") });
		expect(events.at(-1)).toEqual({ type: "error", message: "aborted" });
		expect(applied(events)).toBeUndefined();
		expect(existsSync(join(w.config, "telegram", "bot.token"))).toBe(false);
		expect(existsSync(join(w.config, "telegram", "pairing.json"))).toBe(false);
	});

	test("a failed login is reported and asked again; a model that does not answer offers another model or continuing", async () => {
		const w = await world({ loginFails: 1, failVerify: (ref) => (ref === "faux/faux-1" ? "401 unauthorized" : undefined) });
		let logins = 0;
		const events = await drive(w.commands, "", (prompt) => {
			if (prompt.type === "select" && prompt.login) {
				logins++;
				return "faux";
			}
			if (prompt.type === "secret") return "sk";
			if (prompt.message.includes("did not answer")) return "other";
			if (title(prompt) === "Setup 1/2 · Connect a model") return "faux/faux-2";
			if (title(prompt) === "Setup 2/2 · Ready") return "quick";
			throw new Error(`unexpected ${prompt.message}`);
		});
		expect(logins).toBe(2);
		const printed = outputs(events);
		expect(printed).toContain("Login failed: invalid api key");
		expect(printed).toContain("model switched to faux/faux-2");
		expect(printed).toContain("faux/faux-2 is connected and answering.");
		expect(prompts(events).find((prompt) => title(prompt) === "Setup 2/2 · Ready")!.message).toContain("faux/faux-2 connected");
	});

	test("cancelling the apply step of the whole onboarding still ends on the context invitation", async () => {
		const w = await world({ loggedIn: true });
		const events = await drive(w.commands, "", (prompt) => {
			if (title(prompt) === "설정 2/2 · 준비 완료") return "full";
			if (title(prompt) === "설정 3/5 · 대화할 곳") return ["tui"];
			if (title(prompt) === "설정 4/5 · 기능") return ["web", "computer"];
			if (title(prompt) === "설정 5/5 · 적용") return "cancel";
			throw new Error(`unexpected ${prompt.message}`);
		}, { locale: "ko-KR" });
		const printed = outputs(events);
		expect(applied(events)).toBeUndefined();
		expect(printed.slice(-2)).toEqual(["아무것도 바꾸지 않았어요.", setupCopy("ko").contextTip]);
		expect(await readFile(w.manifestPath, "utf8")).toBe(w.base);
	});

	test("`/setup channels` on a configured Telegram shows it on and turning it off stages a removal", async () => {
		const w = await world({
			loggedIn: true,
			manifest: (home) => defaultManifest(home).replace("channels: {}", ["channels:", "  telegram:", "    mode: polling", "    botTokenFile: /x/bot.token", "    pairingPath: /x/pairing.json", "    databasePath: /x/inbox.sqlite", "    port: 0"].join("\n")),
		});
		const events = await drive(w.commands, "channels", (prompt) => {
			if (prompt.type === "checklist") {
				expect(prompt.options.find((option) => option.id === "telegram")?.checked).toBe(true);
				return ["tui"];
			}
			if (prompt.type === "select") return "apply";
			throw new Error(`unexpected ${prompt.type}`);
		});
		const request = applied(events)!;
		expect(request.changes).toEqual(["− channels.telegram"]);
		expect(request.summary.join("\n")).not.toContain(setupCopy("en").contextTip);
		expect((Bun.YAML.parse(request.candidate) as { channels: unknown }).channels).toEqual({});
	});

	test("`/setup plugins` turns Google on as a read-only `plugins.google: {}` the daemon would boot, with no install", async () => {
		const w = await world({ loggedIn: true });
		const events = await drive(w.commands, "plugins", (prompt) => {
			if (prompt.type === "checklist") {
				expect(prompt.options.find((option) => option.id === "google")).toMatchObject({ checked: false, label: "Google (Gmail · Calendar · Drive)" });
				return ["web", "google"];
			}
			if (prompt.type === "select") return "apply";
			throw new Error(`unexpected ${prompt.type}`);
		});
		expect(w.installs).toEqual([]);
		const request = applied(events)!;
		expect(request.changes).toEqual(["+ plugins.google"]);
		expect((Bun.YAML.parse(request.candidate) as { plugins: unknown }).plugins).toEqual({ google: {} });
		const manifest = await parseManifest(Bun.YAML.parse(request.candidate), { channels: channelCatalog, plugins: pluginCatalog });
		expect(manifest.plugins.map((plugin) => plugin.id)).toContain("google");
		expect(request.summary).toContain("✓ Features: Web search · Google (Gmail · Calendar · Drive)");
		expect(await readFile(w.manifestPath, "utf8")).toBe(w.base);
	});

	test("`/setup plugins` shows a configured Google on (ko) and turning it off stages a removal", async () => {
		const w = await world({
			loggedIn: true,
			manifest: (home) => defaultManifest(home).replace(/^plugins: \{\}.*$/m, ["plugins:", "  google:", "    write: true"].join("\n")),
		});
		const events = await drive(w.commands, "plugins", (prompt) => {
			if (prompt.type === "checklist") {
				expect(prompt.options.find((option) => option.id === "google")).toMatchObject({ checked: true, label: "Google (Gmail · 캘린더 · 드라이브)" });
				return ["web"];
			}
			if (prompt.type === "select") return "apply";
			throw new Error(`unexpected ${prompt.type}`);
		}, { locale: "ko_KR.UTF-8" });
		const request = applied(events)!;
		expect(request.changes).toEqual(["− plugins.google"]);
		expect((Bun.YAML.parse(request.candidate) as { plugins: unknown }).plugins).toEqual({});
		expect(request.summary).toContain("✓ 기능: 웹 검색");
	});

	test("`/setup plugins` (ko) browser: two choices; the bot's own Chrome stages `plugins.browser: {}` with no install", async () => {
		const w = await world({ loggedIn: true });
		const events = await drive(w.commands, "plugins", (prompt) => {
			if (prompt.type === "checklist") {
				expect(prompt.options.find((option) => option.id === "browser")).toMatchObject({ checked: false, label: "브라우저" });
				expect(prompt.options.find((option) => option.id === "browser")?.tag).toBeUndefined();
				return ["web", "browser"];
			}
			if (prompt.type === "select" && prompt.message.includes("어떤 Chrome")) {
				expect(prompt.options.map((option) => [option.id, option.label, option.tag])).toEqual([
					["dedicated", "봇 전용 Chrome으로 시작", "추천"],
					["attach", "내 Chrome 그대로 쓰기", undefined],
				]);
				// The attach hint says why computer use comes along.
				expect(prompt.options[1]!.description).toContain("컴퓨터 사용도 함께 켜요");
				expect(prompt.options[1]!.description).toContain("원격 디버깅");
				return "dedicated";
			}
			if (prompt.type === "select") return "apply";
			throw new Error(`unexpected ${prompt.type}`);
		}, { locale: "ko_KR.UTF-8" });
		expect(w.installs).toEqual([]);
		const request = applied(events)!;
		expect(request.changes).toEqual(["+ plugins.browser"]);
		expect((Bun.YAML.parse(request.candidate) as { plugins: unknown }).plugins).toEqual({ browser: {} });
		const manifest = await parseManifest(Bun.YAML.parse(request.candidate), { channels: channelCatalog, plugins: pluginCatalog });
		expect(manifest.plugins.map((plugin) => plugin.id)).toContain("browser");
		expect(request.summary).toContain("✓ 기능: 웹 검색 · 브라우저");
		expect(await readFile(w.manifestPath, "utf8")).toBe(w.base);
	});

	test("`/setup plugins` browser, my own Chrome: attach mode and computer use (installed) in one apply request", async () => {
		const w = await world({ loggedIn: true });
		const events = await drive(w.commands, "plugins", (prompt) => {
			if (prompt.type === "checklist") return ["web", "browser"];
			if (prompt.type === "select" && prompt.message.includes("Which Chrome")) {
				expect(prompt.options.map((option) => [option.id, option.label, option.tag])).toEqual([
					["dedicated", "Start with a Chrome just for the bot", "recommended"],
					["attach", "Use my own Chrome as it is", undefined],
				]);
				expect(prompt.options[1]!.description).toContain("also turns on computer use");
				return "attach";
			}
			if (prompt.type === "select") return "apply";
			throw new Error(`unexpected ${prompt.type}`);
		});
		expect(w.installs).toEqual(["computer"]);
		expect(outputs(events)).toContain(setupCopy("en").browserNeedsComputer);
		const request = applied(events)!;
		expect(request.changes).toEqual(["+ plugins.computer", "+ plugins.browser"]);
		expect((Bun.YAML.parse(request.candidate) as { plugins: unknown }).plugins).toEqual({ computer: {}, browser: { mode: "attach" } });
		const manifest = await parseManifest(Bun.YAML.parse(request.candidate), { channels: channelCatalog, plugins: pluginCatalog });
		expect(manifest.plugins.map((plugin) => plugin.id)).toEqual(expect.arrayContaining(["computer", "browser"]));
		expect(request.summary).toContain("✓ Features: Web search · Computer use · Browser");
	});

	test("browser attach with computer use already on (or checked in the same step) installs nothing more", async () => {
		const w = await world({ loggedIn: true });
		const events = await drive(w.commands, "plugins", (prompt) => {
			if (prompt.type === "checklist") return ["web", "computer", "browser"];
			if (prompt.type === "select" && prompt.message.includes("Which Chrome")) return "attach";
			if (prompt.type === "select") return "apply";
			throw new Error(`unexpected ${prompt.type}`);
		});
		expect(w.installs).toEqual(["computer"]);
		expect(outputs(events)).not.toContain(setupCopy("en").browserNeedsComputer);
		expect(applied(events)!.changes).toEqual(["+ plugins.computer", "+ plugins.browser"]);

		const on = await world({ loggedIn: true, manifest: (home) => defaultManifest(home).replace(/^plugins: \{\}.*$/m, ["plugins:", "  computer: {}"].join("\n")) });
		const again = await drive(on.commands, "plugins", (prompt) => {
			if (prompt.type === "checklist") return ["web", "computer", "browser"];
			if (prompt.type === "select" && prompt.message.includes("Which Chrome")) return "attach";
			if (prompt.type === "select") return "apply";
			throw new Error(`unexpected ${prompt.type}`);
		});
		expect(on.installs).toEqual([]);
		expect(applied(again)!.changes).toEqual(["+ plugins.browser"]);
		expect((Bun.YAML.parse(applied(again)!.candidate) as { plugins: unknown }).plugins).toEqual({ computer: {}, browser: { mode: "attach" } });
	});

	test("browser attach when computer use cannot be installed: the browser stays off and nothing is staged", async () => {
		const w = await world({ loggedIn: true, installFails: true });
		const events = await drive(w.commands, "plugins", (prompt) => {
			if (prompt.type === "checklist") return ["web", "browser"];
			if (prompt.type === "select" && prompt.message.includes("Which Chrome")) return "attach";
			throw new Error(`unexpected ${prompt.message}`);
		});
		expect(w.installs).toEqual(["computer"]);
		expect(outputs(events)).toContain(setupCopy("en").browserAttachOff);
		expect(applied(events)).toBeUndefined();
		expect(await readFile(w.manifestPath, "utf8")).toBe(w.base);
	});

	test("a configured browser shows its mode; unchecking it removes `plugins.browser` and leaves computer use alone", async () => {
		const w = await world({
			loggedIn: true,
			manifest: (home) => defaultManifest(home).replace(/^plugins: \{\}.*$/m, ["plugins:", "  computer: {}", "  browser:", "    mode: attach"].join("\n")),
		});
		const events = await drive(w.commands, "plugins", (prompt) => {
			if (prompt.type === "checklist") {
				expect(prompt.options.find((option) => option.id === "browser")).toMatchObject({ checked: true, label: "브라우저", tag: "내 Chrome" });
				return ["web", "computer"];
			}
			if (prompt.type === "select") return "apply";
			throw new Error(`unexpected ${prompt.message}`);
		}, { locale: "ko" });
		const request = applied(events)!;
		expect(request.changes).toEqual(["− plugins.browser"]);
		expect((Bun.YAML.parse(request.candidate) as { plugins: unknown }).plugins).toEqual({ computer: {} });

		const dedicated = await world({ loggedIn: true, manifest: (home) => defaultManifest(home).replace(/^plugins: \{\}.*$/m, ["plugins:", "  browser: {}"].join("\n")) });
		const kept = await drive(dedicated.commands, "plugins", (prompt) => {
			if (prompt.type === "checklist") {
				expect(prompt.options.find((option) => option.id === "browser")).toMatchObject({ checked: true, tag: "the bot's own Chrome" });
				return ["web", "browser"];
			}
			throw new Error(`unexpected ${prompt.message}`);
		});
		// Kept on: no second choice, nothing to apply.
		expect(applied(kept)).toBeUndefined();
		expect(outputs(kept).at(-1)).toContain("✓ Features: Web search · Browser");
	});

	test("a Telegram bot paired earlier (token + pairing next to the manifest) is reused without asking again", async () => {
		const w = await world({ loggedIn: true });
		await mkdir(join(w.config, "telegram"), { recursive: true });
		await writeFile(join(w.config, "telegram", "bot.token"), `${TOKEN}\n`, { mode: 0o600 });
		await writeFile(join(w.config, "telegram", "pairing.json"), JSON.stringify({ botId: "123456", userId: "42", chatIds: ["42"] }), { mode: 0o600 });
		const events = await drive(w.commands, "channels", (prompt) => (prompt.type === "checklist" ? ["tui", "telegram"] : "apply"));
		expect(prompts(events).some((prompt) => prompt.type === "secret")).toBe(false);
		expect(outputs(events)).toContain("Using the Telegram bot you paired earlier.");
		expect(applied(events)!.changes).toEqual(["+ channels.telegram"]);
		expect(w.telegram.calls).toEqual([]);
	});

	test("problem reports: never on by default; choosing to turn on runs the /report consent checklist", async () => {
		let receipt: object | undefined;
		const recorded: boolean[] = [];
		const report = {
			consent: async () => (receipt ? { receipt, auto: false } : { auto: false }),
			recordConsent: async (_owner: string, auto: boolean) => {
				recorded.push(auto);
				receipt = { version: "v", at: "now" };
				return { version: "report-consent-ko-v1", at: "2026-10-10T00:00:00Z" };
			},
		} as unknown as ReportService;
		const w = await world({ loggedIn: true, report });
		const first = await drive(w.commands, "report", (prompt) => {
			if (prompt.type === "select") {
				expect(prompt.options.map((option) => option.id)).toEqual(["later", "review"]);
				return "review";
			}
			if (prompt.type === "checklist") return ["collect", "transfer", "age14"];
			throw new Error(`unexpected ${prompt.type}`);
		});
		expect(recorded).toEqual([false]);
		expect(applied(first)).toBeUndefined();
		expect(outputs(first).at(-1)).toContain("✓ Reports: on");
		const again = await drive(w.commands, "report", (prompt) => {
			expect(prompt.type === "select" && prompt.options.map((option) => option.id)).toEqual(["keep", "review"]);
			return "keep";
		});
		expect(recorded).toEqual([false]);
		expect(events(again)).toBe("done");
	});

	test("unknown sections fail; /setup exists only on the TUI", async () => {
		const w = await world({ loggedIn: true });
		const events = await drive(w.commands, "gateway", () => "x");
		expect(events.at(-1)).toEqual({ type: "error", message: 'unknown setup section "gateway" (available: model, channels, plugins, report)' });
		expect(w.commands.find("setup", "channel")).toBeUndefined();
		expect(w.commands.list("tui").map((command) => command.name)).toContain("setup");
	});
});

function events(list: readonly CommandEvent[]): string {
	return list.at(-1)?.type ?? "";
}

describe("setup locale", () => {
	test("POSIX precedence and Korean detection", () => {
		expect(detectLocale({ LC_ALL: "ko_KR.UTF-8", LANG: "en_US.UTF-8" })).toBe("ko_KR.UTF-8");
		expect(detectLocale({ LC_MESSAGES: "", LANG: "en_US.UTF-8" })).toBe("en_US.UTF-8");
		expect(detectLocale({}, () => undefined)).toBeUndefined();
		for (const korean of ["ko", "ko_KR.UTF-8", "ko-KR", "KO_kr"]) expect(resolveLocale(korean)).toBe("ko");
		for (const other of [undefined, "", "en_US.UTF-8", "C", "kok_IN", "korean"]) expect(resolveLocale(other)).toBe("en");
	});

	test("no LANG/LC_* (Windows, macOS GUI terminals): the OS language decides Korean or English", () => {
		expect(resolveLocale(detectLocale({}, () => "ko-KR"))).toBe("ko");
		expect(resolveLocale(detectLocale({}, () => "en-US"))).toBe("en");
		expect(resolveLocale(detectLocale({}, () => "ja-JP"))).toBe("en");
		// An explicit POSIX locale still wins over the OS setting, in both directions.
		expect(resolveLocale(detectLocale({ LANG: "en_US.UTF-8" }, () => "ko-KR"))).toBe("en");
		expect(resolveLocale(detectLocale({ LC_ALL: "ko_KR.UTF-8" }, () => "en-US"))).toBe("ko");
		// The default reads the real OS setting through ICU.
		expect(systemLocale()).toBe(new Intl.DateTimeFormat().resolvedOptions().locale);
		expect(detectLocale({})).toBe(systemLocale());
	});
});
