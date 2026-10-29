import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os, { tmpdir } from "node:os";
import { join } from "node:path";
import { protocolHttp } from "./fixtures/protocol-http.ts";
import { reportProtocol, uploadedContent } from "./fixtures/report-protocol.ts";
import { CONSENT_VERSION } from "../src/report/consent.ts";
import { collectDiagnostics, createAnonymizer, diagnosticLines, LIMITS, maskTree, probeHttp } from "../src/report/diagnostics.ts";
import { ConsentRequiredError, ReportService } from "../src/report/service.ts";

/**
 * ADR 0103 diagnostic sections: a fake install (manifest with secrets and a Telegram token file of mode 0644, a log with a
 * token and home paths) must produce every section, report file facts, and leak no secret, home path, user or host name.
 */

const TELEGRAM_TOKEN = "123456789:AAHfakeTelegramTokenValue0123456789abcdef";
const ANTHROPIC_KEY = "sk-" + "ant-api03-SECRETSECRETSECRETSECRET";
const YAML_PASSWORD = "hunter2-very-secret-password";
const ORIGIN = "https://report.test";

let dir: string | undefined;
afterEach(async () => {
	if (dir) await rm(dir, { recursive: true, force: true });
	dir = undefined;
});

/** A refused loopback port: bind, read the port, close. */
async function closedPort(): Promise<number> {
	const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
	const port = server.port!;
	await server.stop(true);
	return port;
}

async function fakeInstall(port: number) {
	dir = await mkdtemp(join(tmpdir(), "dinobot-diag-"));
	const home = os.homedir();
	const user = os.userInfo().username;
	const configDir = join(dir, "config");
	const dataDir = join(dir, "data");
	await mkdir(configDir, { recursive: true });
	await mkdir(join(dataDir, "report"), { recursive: true });
	const tokenFile = join(configDir, "telegram.token");
	await writeFile(tokenFile, `${TELEGRAM_TOKEN}\n`);
	await chmod(tokenFile, 0o644);
	const manifestPath = join(configDir, "dinobot.yaml");
	await writeFile(
		manifestPath,
		[
			"bot:",
			"  enabled: true",
			`  dataDir: ${JSON.stringify(dataDir)}`,
			"  model: { provider: anthropic, modelId: claude-sonnet-4-6 }",
			"  toolMode: codemode-only",
			`api: { port: ${port} }`,
			"channels:",
			"  telegram:",
			"    mode: polling",
			`    botTokenFile: ${JSON.stringify(tokenFile)}`,
			"    allowedUserIds: [42]",
			"    allowedChatIds: [42]",
			"providers:",
			"  mine:",
			"    baseUrl: https://llm.example.invalid/v1",
			`    apiKey: ${ANTHROPIC_KEY}`,
			"plugins:",
			"  web:",
			`    password: ${YAML_PASSWORD}`,
			"",
		].join("\n"),
	);
	await writeFile(`${manifestPath}.bak`, "bot: { enabled: false }\nchannels: {}\n");
	await writeFile(
		join(dataDir, "dinobot.log"),
		[
			"dinobot up: model=anthropic/claude-sonnet-4-6",
			`telegram: polling https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates failed`,
			`reading ${join(home, ".config", "dinobot", "dinobot.yaml")} as ${user} on ${os.hostname()}`,
			"macOS path /Users/alice/Library/x and Windows C:\\Users\\alice\\AppData",
			`Private file must be a readable, small regular file owned by the current user with private permissions`,
			"",
		].join("\n"),
	);
	await writeFile(join(dataDir, "telegram.log"), "sidecar crashed\n");
	return { dataDir, manifestPath, tokenFile, home, user };
}

type Line = { kind: string; section: string; data?: Record<string, any>; error?: string; part?: number; parts?: number };
const parse = (lines: string[]) => lines.map((line) => JSON.parse(line) as Line);
const section = (lines: Line[], name: string) => lines.find((line) => line.section === name);

describe("diagnostic sections", () => {
	test("every section, file facts of the Telegram token file, and nothing secret, home, user or host", async () => {
		const install = await fakeInstall(await closedPort());
		const results = await collectDiagnostics({ manifestPath: install.manifestPath, mode: "offline", client: "cli", trigger: "daemon-start-failed", version: "9.9.9", reportUrl: ORIGIN, context: { desktop: { lastError: `token ${TELEGRAM_TOKEN} in ${install.home}` } } });
		const lines = diagnosticLines(results);
		const all = lines.join("\n");
		const parsed = parse(lines);
		for (const name of ["report", "system", "runtime", "install", "config", "daemon", "logs", "dataDir", "channels", "network", "context"]) {
			expect({ name, present: section(parsed, name) !== undefined }).toEqual({ name, present: true });
		}
		expect(parsed.filter((line) => line.error)).toEqual([]);
		expect(parsed.every((line) => line.kind === "diagnostic")).toBe(true);
		expect(section(parsed, "report")!.data).toMatchObject({ trigger: "daemon-start-failed", mode: "offline", client: "cli", dinobotVersion: "9.9.9" });

		// config: masked tree, file facts of the token file, validation and .bak diff
		const config = section(parsed, "config")!.data!;
		expect(config.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(config.tree.providers.mine.apiKey).toMatch(/^\[(?:masked \d+ chars|credential omitted)\]$/);
		expect(config.tree.plugins.web.password).toMatch(/^\[(?:masked \d+ chars|credential omitted)\]$/);
		expect(config.tree.channels.telegram.allowedUserIds).toEqual([42]);
		const tokenFacts = config.paths["/channels/telegram/botTokenFile"];
		expect(tokenFacts).toMatchObject({ exists: true, type: "file", size: TELEGRAM_TOKEN.length + 1 });
		expect(typeof tokenFacts.private).toBe("boolean");
		if (process.platform !== "win32") {
			expect(tokenFacts.mode).toBe("0644");
			expect(tokenFacts.private).toBe(false);
			expect(tokenFacts.ownedByUser).toBe(true);
		}
		expect(config.backup.exists).toBe(true);
		expect(config.backupDiffers).toEqual(expect.arrayContaining(["bot", "channels", "api"]));
		expect(Array.isArray(config.problems)).toBe(true);

		// daemon: nothing listens on the port → refused (not timeout)
		const daemon = section(parsed, "daemon")!.data!;
		expect(daemon.healthz.status).toBe("refused");
		expect(daemon.lock.exists).toBe(false);

		// logs: both files with their tails; dataDir inventory without contents
		const logs = parsed.filter((line) => line.section === "logs").flatMap((line) => line.data!.files ?? [line.data]);
		expect(logs.map((file: any) => file.file)).toEqual(["dinobot.log", "telegram.log"]);
		expect(logs[0].text).toContain("Private file must be");
		const inventory = section(parsed, "dataDir")!.data!;
		expect(inventory.entries.map((entry: any) => entry.path)).toEqual(expect.arrayContaining(["dinobot.log", "telegram.log", "report"]));
		expect(JSON.stringify(inventory)).not.toContain("sidecar crashed");

		// channels: type, mode, credential file facts
		const channels = section(parsed, "channels")!.data!;
		expect(channels.configured).toEqual(["telegram"]);
		expect(channels.channels.telegram.mode).toBe("polling");
		expect(channels.channels.telegram.files["/channels/telegram/botTokenFile"]).toMatchObject({ exists: true, size: TELEGRAM_TOKEN.length + 1 });

		// context passes through, scrubbed
		expect(section(parsed, "context")!.data!.client.desktop.lastError).toContain("[credential omitted]");

		// D2: no secret, home directory, OS user or host name anywhere
		for (const secret of [TELEGRAM_TOKEN, ANTHROPIC_KEY, YAML_PASSWORD, "AAHfakeTelegramTokenValue"]) expect(all).not.toContain(secret);
		expect(all.toLowerCase()).not.toContain(install.home.toLowerCase());
		expect(all.toLowerCase()).not.toContain(install.home.replace(/\\/g, "\\\\").toLowerCase());
		expect(all.toLowerCase()).not.toContain(install.home.replace(/\\/g, "/").toLowerCase());
		// Identity names are words, not substrings of public identifiers such as RUNNER_OS.
		if (install.user.length >= 2) {
			const escaped = install.user.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			expect(all).not.toMatch(new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "iu"));
		}
		if (os.hostname().length >= 3) expect(all.toLowerCase()).not.toContain(os.hostname().toLowerCase());
		expect(all).not.toContain("/Users/alice");
		expect(all).not.toContain("C:\\\\Users\\\\alice");
	});

	test("anonymiser: native, forward-slash and JSON-escaped home spellings, user and host names", () => {
		const anonymize = createAnonymizer({ home: "C:\\Users\\테스트사용자", user: "테스트사용자", host: "fixture-pc" });
		const foldedHome = process.platform === "win32" || process.platform === "darwin" ? "~" : "c:\\users\\<user>";
		expect(anonymize("C:\\Users\\테스트사용자\\.config\\x C:/Users/테스트사용자/y C:\\\\Users\\\\테스트사용자\\\\z c:\\users\\테스트사용자")).toBe(`~\\.config\\x ~/y ~\\\\z ${foldedHome}`);
		expect(anonymize("테스트사용자 on fixture-pc.local and fixture-pc")).toBe("<user> on <host>.local and <host>");
		const mac = createAnonymizer({ home: "/Users/alice", user: "alice", host: "Alices-MacBook-Pro.local" });
		expect(mac("/Users/alice/Library alice@Alices-MacBook-Pro.local /Users/alicex")).toBe("~/Library <user>@<host> /Users/alicex");
	});

	test("anonymiser removes runner identity words without erasing public environment identifiers", () => {
		const anonymize = createAnonymizer({ home: "/home/runner", user: "runner", host: "build-host" });
		expect(anonymize("runner RUNNER runner@build-host /home/runner/file RUNNER_OS runner_workspace roadrunner"))
			.toBe("<user> <user> <user>@<host> ~/file RUNNER_OS runner_workspace roadrunner");
	});

	test("masking keeps references (files, env names) and masks literal secrets", () => {
		const { tree, paths, envNames } = maskTree({ botTokenFile: "/x/token", botTokenEnv: "TG_TOKEN", apiKey: "abc123456", nested: { clientSecret: "zzzz", maxTokens: 4096, cookie: "a=b" } });
		expect(tree).toEqual({ botTokenFile: "/x/token", botTokenEnv: "TG_TOKEN", apiKey: "[masked 9 chars]", nested: { clientSecret: "[masked 4 chars]", maxTokens: 4096, cookie: "[masked 3 chars]" } });
		expect(paths).toEqual([{ at: "/botTokenFile", path: "/x/token" }]);
		expect(envNames).toEqual([{ at: "/botTokenEnv", name: "TG_TOKEN" }]);
	});

	test("a failing or hanging section is isolated; the others are still collected", async () => {
		const install = await fakeInstall(await closedPort());
		const failing = await collectDiagnostics({ manifestPath: install.manifestPath, mode: "daemon", client: "tui", trigger: "button", version: "1", reportUrl: ORIGIN, live: async () => { throw new Error(`boom at ${install.home}`); } });
		const live = failing.find((r) => r.section === "live")!;
		expect(live.error).toContain("boom");
		expect(failing.filter((r) => r.error).map((r) => r.section)).toEqual(["live"]);
		expect(diagnosticLines(failing).join("\n").toLowerCase()).not.toContain(install.home.toLowerCase());
		const hanging = await collectDiagnostics({ manifestPath: install.manifestPath, mode: "daemon", client: "tui", trigger: "button", version: "1", reportUrl: ORIGIN, sectionTimeoutMs: 300, live: () => new Promise(() => undefined) });
		expect(hanging.find((r) => r.section === "live")!.error).toContain("timed out");
		expect(hanging.find((r) => r.section === "system")!.error).toBeUndefined();
	});

	test("a failed /setup apply recorded by the TUI rides in the context section and marks the next /report setup-failed", async () => {
		const install = await fakeInstall(await closedPort());
		const { recordSetupFailure } = await import("../src/tui/app.ts");
		await recordSetupFailure(install.dataDir, { status: "rolled_back", reason: "daemon exited with code 1", log: `Unable to read Telegram bot credential ${TELEGRAM_TOKEN}` }, install.manifestPath);
		const lines = parse(diagnosticLines(await collectDiagnostics({ manifestPath: install.manifestPath, mode: "offline", client: "cli", trigger: "setup-failed", version: "1", reportUrl: ORIGIN })));
		const last = section(lines, "context")!.data!.lastSetupApply;
		expect(last).toMatchObject({ status: "rolled_back", reason: "daemon exited with code 1" });
		expect(JSON.stringify(last)).not.toContain(TELEGRAM_TOKEN);
		const service = new ReportService({ dataDir: install.dataDir, version: "1" });
		expect(await service.recentSetupFailure()).toMatchObject({ status: "rolled_back" });
		expect(await new ReportService({ dataDir: install.dataDir, version: "1", now: () => new Date(Date.now() + 2 * 3_600_000) }).recentSetupFailure()).toBeUndefined();
	});

	test("a missing manifest is reported, not fatal", async () => {
		dir = await mkdtemp(join(tmpdir(), "dinobot-diag-"));
		const results = await collectDiagnostics({ manifestPath: join(dir, "absent.yaml"), dataDir: join(dir, "data"), mode: "offline", client: "cli", trigger: "cli", version: "1", reportUrl: ORIGIN });
		expect(results.filter((r) => r.error)).toEqual([]);
		expect((results.find((r) => r.section === "config")!.data as { file: { exists: boolean } }).file.exists).toBe(false);
	});

	test("oversized log tails are split into lines below the ingest limit; the total stays capped", async () => {
		const install = await fakeInstall(await closedPort());
		await writeFile(join(install.dataDir, "dinobot.log"), `${"x".repeat(200)}\n`.repeat(4000));
		await writeFile(join(install.dataDir, "big.log"), `${"y".repeat(1000)}\n`.repeat(1000));
		const lines = diagnosticLines(await collectDiagnostics({ manifestPath: install.manifestPath, mode: "offline", client: "cli", trigger: "cli", version: "1", reportUrl: ORIGIN }));
		expect(Math.max(...lines.map((line) => line.length))).toBeLessThan(512 * 1024);
		const logs = parse(lines).filter((line) => line.section === "logs");
		const main = logs.filter((line) => line.data!.file === "dinobot.log");
		expect(main.length).toBe(3); // ~804 KB tail in 400 K-char parts
		expect(main.map((line) => [line.part, line.parts])).toEqual([[1, 3], [2, 3], [3, 3]]);
		expect(main.map((line) => line.data!.text).join("").split("\n").length).toBeLessThanOrEqual(LIMITS.mainLogLines + 1);
		const big = logs.find((line) => line.data!.file === "big.log")!;
		expect(big.data!.text.length).toBeLessThanOrEqual(LIMITS.otherLogBytes);
	});

	test("probe classification: refused, timeout and HTTP status are distinct", async () => {
		expect((await probeHttp(`http://127.0.0.1:${await closedPort()}/healthz`, 1000)).status).toBe("refused");
		const hung = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Promise<Response>(() => undefined) });
		const failing = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("no", { status: 503 }) });
		try {
			expect((await probeHttp(`http://127.0.0.1:${hung.port}/healthz`, 300)).status).toBe("timeout");
			expect((await probeHttp(`http://127.0.0.1:${failing.port}/healthz`, 1000)).status).toBe("http_503");
		} finally {
			await hung.stop(true);
			await failing.stop(true);
		}
	});
});

describe("offline submit against a synthetic HTTP protocol double", () => {
	function world(dataDir: string, manifestPath: string, options: { fail?: boolean } = {}) {
		const env = reportProtocol();
		const transport = protocolHttp((request) => env.handle(request));
		const state = { fail: options.fail === true, posts: 0 };
		const serverFetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const request = typeof input === "string" || input instanceof URL ? new Request(input.toString(), init) : new Request(input, init);
			if (request.method === "POST") state.posts++;
			if (state.fail) throw new TypeError("fetch failed: network is unreachable");
			return transport(request);
		}) as typeof fetch;
		const service = new ReportService({
			dataDir,
			version: "0.9.0",
			url: ORIGIN,
			fetch: serverFetch,
			diagnostics: async (request) => {
				const counts = {};
				const results = await collectDiagnostics({ manifestPath, mode: request.mode ?? "offline", client: request.client, trigger: request.trigger, version: "0.9.0", reportUrl: ORIGIN, ...(request.context !== undefined ? { context: request.context } : {}) });
				return { lines: diagnosticLines(results, { counts }), redactions: counts };
			},
		});
		return { env, service, state };
	}

	async function content(env: ReturnType<typeof reportProtocol>, dataDir: string, id: string): Promise<string> {
		const record = (JSON.parse(await readFile(join(dataDir, "report", "state.json"), "utf8")) as { reports: Array<{ id: string; deleteToken: string }> }).reports.find((r) => r.id === id)!;
		return uploadedContent(env, id, record.deleteToken);
	}

	test("consent required, then sent with every section; secrets never reach the server", async () => {
		const install = await fakeInstall(await closedPort());
		const { env, service } = world(install.dataDir, install.manifestPath);
		await expect(service.submit({ owner: "owner", trigger: "daemon-down", client: "cli" })).rejects.toBeInstanceOf(ConsentRequiredError);
		expect(env.uploads.size).toBe(0);
		await service.recordConsent("owner", false);
		const result = await service.submit({ owner: "owner", trigger: "daemon-down", client: "cli", note: "텔레그램 연결하면 데몬이 죽어요", context: { app: "test" } });
		expect(result).toMatchObject({ status: "sent", shortId: result.id.slice(0, 8) });
		expect(result.diagnostics).toBeGreaterThanOrEqual(11);
		expect(result.entries).toBe(result.diagnostics);
		const text = await content(env, install.dataDir, result.id);
		const [manifestLine, ...rest] = text.trim().split("\n");
		expect(JSON.parse(manifestLine!)).toMatchObject({ kind: "manual", tier: "T2", trigger: { rule: "daemon-down" }, consent: { version: CONSENT_VERSION } });
		const sections = rest.map((line) => (JSON.parse(line) as Line).section);
		expect(sections).toEqual(expect.arrayContaining(["report", "system", "runtime", "install", "config", "daemon", "logs", "dataDir", "channels", "network", "context"]));
		for (const secret of [TELEGRAM_TOKEN, ANTHROPIC_KEY, YAML_PASSWORD]) expect(text).not.toContain(secret);
		expect(text.toLowerCase()).not.toContain(install.home.toLowerCase());
	});

	test("an unreachable server leaves the report pending; a later flush (next CLI run) sends it", async () => {
		const install = await fakeInstall(await closedPort());
		const w = world(install.dataDir, install.manifestPath, { fail: true });
		await w.service.recordConsent("owner", false);
		const result = await w.service.submit({ owner: "owner", trigger: "cli", client: "cli" });
		expect(result.status).toBe("pending");
		expect(result.error).toContain("network is unreachable");
		const later = world(install.dataDir, install.manifestPath);
		await later.service.flush(); // retry not due yet
		expect(later.state.posts).toBe(0);
		const state = JSON.parse(await readFile(join(install.dataDir, "report", "state.json"), "utf8")) as { reports: Array<{ nextAttemptAt?: string }> };
		state.reports[0]!.nextAttemptAt = new Date(Date.now() - 1000).toISOString();
		await writeFile(join(install.dataDir, "report", "state.json"), JSON.stringify(state));
		await later.service.flush();
		expect((await later.service.list("owner"))[0]!.status).toBe("sent");
	});

	test("a v1 receipt is not current: consent v2 is asked again", async () => {
		const install = await fakeInstall(await closedPort());
		const { service } = world(install.dataDir, install.manifestPath);
		await service.recordConsent("owner", false);
		const path = join(install.dataDir, "report", "state.json");
		const state = JSON.parse(await readFile(path, "utf8")) as { owner: { version: string } };
		state.owner.version = "report-consent-ko-v1";
		await writeFile(path, JSON.stringify(state));
		expect((await service.consentInfo("owner")).consented).toBe(false);
		await expect(service.submit({ owner: "owner", trigger: "cli", client: "cli" })).rejects.toBeInstanceOf(ConsentRequiredError);
	});
});
