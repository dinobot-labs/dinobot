import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { startClientApi } from "./api/server.ts";
import { createUsageService } from "./api/usage.ts";
import { createBotModels, openAuth } from "./auth/index.ts";
import { channelCatalog } from "./channels/index.ts";
import { createCommands } from "./commands/index.ts";
import { channelHandler } from "./core/channel-handler.ts";
import { createNativeModelHandler } from "./core/native-model-commands.ts";
import { openBot } from "./core/bot.ts";
import { DaemonLifecycle } from "./core/daemon-lifecycle.ts";
import type { DaemonControl, DaemonOwner } from "./core/daemon-info.ts";
import { acquireDaemonLock, type DaemonLock, DaemonLockError } from "./core/daemon-lock.ts";
import { detectSupervisor, HANDOFF_ENV, startSuccessor, successorArgv, takeOverDaemonLock } from "./core/daemon-restart.ts";
import { parseManifest, type Manifest } from "./manifest.ts";
import { readSetupState } from "./setup/state.ts";
import { ensureDefaultManifest } from "./cli/default-manifest.ts";
import { pluginCatalog } from "./plugins/index.ts";
import { createReportService } from "./report/daemon.ts";
import { runTui } from "./tui/app.ts";
import packageJson from "../package.json" with { type: "json" };

const USAGE = `dinobot ${packageJson.version}

Usage: dinobot [tui|serve] [--config <path>] [--thread <name> | --resume]
       dinobot setup [model|channels|plugins|report] [--config <path>]
       dinobot quarantine-recovery --database <existing.sqlite> --request <request.json> [--apply]
       dinobot update [--no-restart] [--config <path>]
       dinobot init [--check] [--config <path>] [<dependency>...]
       dinobot telegram connect --token-file <path> --pairing-file <path>
       dinobot telegram run --token-file <path> --pairing-file <path> --database <path> --core-url http://127.0.0.1:8787

  tui     chat in the terminal; starts the daemon in the background when it is not running
  serve   run the daemon in the foreground: channels and the local client API
  setup   open the setup wizard in the TUI: model, chat channels, features, problem reports
  update  check for and install the latest release using the current global package manager, then restart the
          running daemon of the manifest once on the new version (--no-restart skips it; running work is interrupted)
  init    bootstrap this machine: install the pinned external programs plugins run (e.g. cua-driver
          for the computer plugin) and create the default manifest when none exists
  (none)  tui in a terminal, serve otherwise

  The TUI opens a new session each time. --thread <name> opens that session;
  --resume opens the shared "main" session (the previous default).

The customer manifest is the first of:
  --config <path>
  $DINOBOT_CONFIG
  ./dinobot.yaml
  ~/.config/dinobot/dinobot.yaml (created with defaults on first run)
`;

// Offline recovery runs before loading configuration, credentials or any execution plugins.
if (process.argv[2] === "quarantine-recovery") {
 const { runQuarantineRecovery } = await import("./cli/quarantine-recovery.ts");
 process.exit(await runQuarantineRecovery(process.argv.slice(3)));
}

// Bootstrap runs before loading a manifest: it may create the default one and installs plugin dependencies.
if (process.argv[2] === "init") {
	const { runInit } = await import("./cli/init.ts");
	const { pluginCatalog } = await import("./plugins/index.ts");
	// Ctrl-C aborts a download or extraction; the installer then removes its staging directory.
	const abort = new AbortController();
	process.once("SIGINT", () => abort.abort(new Error("interrupted")));
	process.exit(await runInit(process.argv.slice(3), { catalog: pluginCatalog, signal: abort.signal }));
}

// Setup/sidecar commands run before loading a deployment manifest or its credentials.
if (process.argv[2] === "telegram") {
	try {
		const action = process.argv[3];
		if (action === "connect") {
			const { runTelegramSetup } = await import("./cli/telegram-setup.ts");
			await runTelegramSetup(process.argv.slice(3));
		} else if (action === "run") {
			const { runTelegramChannel } = await import("./cli/telegram-run.ts");
			await runTelegramChannel(process.argv.slice(4));
		} else {
			console.log(USAGE);
			process.exit(action === "--help" || action === "help" ? 0 : 2);
		}
		process.exit(0);
	} catch {
		// Do not print arbitrary fetch errors: Telegram API URLs contain a bearer token.
		console.error("dinobot: Telegram command failed; check private configuration and channel health.");
		process.exit(1);
	}
}

const { values: args, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		config: { type: "string", short: "c" },
		thread: { type: "string", short: "t" },
		resume: { type: "boolean", short: "r" },
		help: { type: "boolean", short: "h" },
		version: { type: "boolean", short: "v" },
		"no-restart": { type: "boolean" },
	},
});
// A restarted daemon reruns its own argv from here, so relative --config paths keep their meaning.
const bootCwd = process.cwd();
if (args.help) {
	console.log(USAGE);
	process.exit(0);
}
if (args.version) {
	console.log(packageJson.version);
	process.exit(0);
}

const command = positionals[0] ?? (process.stdin.isTTY && process.stdout.isTTY ? "tui" : "serve");
const setupSection = command === "setup" ? (positionals[1] ?? "") : undefined;
if ((command !== "tui" && command !== "serve" && command !== "update" && command !== "setup") || positionals.length > (command === "setup" ? 2 : 1)) {
	console.error(`dinobot: unknown command ${positionals.join(" ")}\n\n${USAGE}`);
	process.exit(2);
}

// Updating does not require a manifest, provider credentials, or a running daemon.
if (command === "update") {
	const { runUpdate } = await import("./update.ts");
	process.exit(await runUpdate({ restart: !args["no-restart"], ...(args.config !== undefined ? { config: args.config } : {}) }));
}

const manifestPath = await resolveManifestPath();
// Read once: the daemon reports the hash of exactly the text it booted from, so a restart can tell whether it is current.
const manifestText = await Bun.file(manifestPath).text();
const manifestSha256 = createHash("sha256").update(manifestText, "utf8").digest("hex");
const manifest = await parseManifest(Bun.YAML.parse(manifestText), { channels: channelCatalog, plugins: pluginCatalog });

if (!manifest.enabled) {
	console.log(`dinobot disabled by ${manifestPath}`);
	process.exit(0);
}

if (command === "setup" && !(process.stdin.isTTY && process.stdout.isTTY)) {
	// Setup asks questions; headless installs keep the default manifest and need nothing else.
	console.error("dinobot setup needs an interactive terminal; headless installs can edit the manifest directly.");
	process.exit(2);
}
if (command === "tui" || command === "setup") await runTui({ manifest, manifestPath, ...(args.thread ? { thread: args.thread } : args.resume ? { thread: "main" } : {}), ...(setupSection !== undefined ? { setup: setupSection } : {}) });
else await serve(manifest);

async function serve(manifest: Manifest) {
	const startedAt = new Date().toISOString();
	// Set only by the TUI's ensureDaemon. Removed at once so tool subprocesses never inherit it.
	const owner: DaemonOwner = process.env.DINOBOT_DAEMON_OWNER === "tui" ? "tui" : "external";
	delete process.env.DINOBOT_DAEMON_OWNER;
	// Set only for a successor started by POST /v1/daemon/restart (src/core/daemon-restart.ts).
	const handoff = process.env[HANDOFF_ENV];
	delete process.env[HANDOFF_ENV];
	// One daemon per dataDir, taken before any plugin, bot or storage is opened.
	let lock: DaemonLock;
	try {
		await mkdir(manifest.dataDir, { recursive: true });
		// A successor reports ready (the manifest parsed), then waits for its predecessor to release the lock.
		lock = handoff ? await takeOverDaemonLock(manifest.dataDir, handoff) : acquireDaemonLock(manifest.dataDir);
	} catch (error) {
		if (!(error instanceof DaemonLockError)) throw error;
		console.error(`dinobot: ${error.message}`);
		process.exit(1);
	}
	const bootedManifestPath = await realpath(manifestPath);
	const context = BACKGROUND_CONTEXT;
	const lifecycle = new DaemonLifecycle(10_000);
	let bot: Awaited<ReturnType<typeof openBot>> | undefined;
	// Reverse cleanup: stop admission, quiesce the bot, close its plugin dependencies, and release the lock last.
	lifecycle.own("daemon lock", () => lock.release());
	for (const plugin of manifest.plugins) lifecycle.own(`plugin ${plugin.id}`, () => plugin.close?.());
	lifecycle.own("bot", () => bot?.close(context));
	let shutdownTask: Promise<void> | undefined;
	function shutdown(signal: string): void {
		shutdownTask ??= (async () => {
			console.log(`dinobot: ${signal}, shutting down`);
			const result = await lifecycle.stop();
			if (result.errors.length) console.error(new AggregateError(result.errors, "Daemon shutdown failed"));
			process.exit(result.errors.length ? 1 : 0);
		})().catch((error) => { console.error(error); process.exit(1); });
	}
	process.on("SIGINT", () => shutdown("SIGINT"));
	process.on("SIGTERM", () => shutdown("SIGTERM"));
	try {
		let auth!: ReturnType<typeof openAuth>;
		let models!: ReturnType<typeof createBotModels>;
		// Track initialization so signals wait for it within the shared deadline.
		// Bot cleanup runs before plugins; openBot must clean up
		// allocations it never returns to us if initialization fails.
		await lifecycle.start({ name: "runtime initialization", stop() {}, async start() {
			await mkdir(manifest.dataDir, { recursive: true });
			const dataDir = await realpath(manifest.dataDir);
			auth = openAuth(manifest.dataDir, { customProviders: manifest.providers });
			models = createBotModels(auth, undefined, { customProviders: manifest.providers });
			const storage = await openNodeSqliteStorage(join(manifest.dataDir, "dinobot.sqlite"));
			bot = await openBot(
				{
					storage,
					models,
					defaultModel: manifest.model,
					toolMode: manifest.toolMode,
					promptProfile: manifest.promptProfile,
					plugins: manifest.plugins,
					...(manifest.workspaceRoot ? { workspaceRoot: manifest.workspaceRoot } : {}),
					...(manifest.lsp ? { lsp: manifest.lsp } : {}),
					...(manifest.skillEvolution ? { skillEvolution: manifest.skillEvolution } : {}),
					...(manifest.curation ? { curation: manifest.curation } : {}),
					memory: manifest.memory,
					...(manifest.research ? { researchCodeProfiles: manifest.research.codeProfiles } : {}),
					...(manifest.skillEvolution?.observe ? { skillObservationStorage: await openNodeSqliteStorage(join(dataDir, "skill-observations.sqlite")) } : {}),
					agents: manifest.agents,
					hostChannels: manifest.channels.filter((channel) => channel.deliverHost !== undefined).map((channel) => channel.name),
					searchIndexPath: join(manifest.dataDir, "session-index.sqlite"),
					runtimeStoragePaths: {
						files: ["dinobot.sqlite", "session-index.sqlite", "skill-observations.sqlite"].flatMap((name) =>
							["", "-wal", "-shm"].map((suffix) => join(dataDir, `${name}${suffix}`)),
						).concat(
							join(dataDir, "auth.json"),
							...manifest.channels.flatMap(channel => channel.storagePaths ?? []),
							...manifest.plugins.flatMap(plugin => plugin.storagePaths ?? []),
						),
						directories: [],
					},
					verificationEvidenceDir: join(dataDir, "verification-evidence"),
				},
				context,
			);
		} });
		if (!bot) throw new Error("Daemon initialization returned no bot");
		const runningBot = bot;

		// Session reports (ADR 0073): nothing is sent without a consent receipt recorded through /report.
		const report = manifest.commands.disabled.includes("report") ? undefined : createReportService(runningBot, manifest.dataDir, packageJson.version, context);
		if (report) await lifecycle.start({ name: "session reports", start: () => report.start(), stop: () => report.stop() });
		const commands = createCommands({
			bot, models, auth, plugins: manifest.plugins, disabled: manifest.commands.disabled, ...(report ? { report } : {}),
			// The first-run wizard edits exactly the manifest this daemon booted from (ADR: first-run setup).
			setup: { manifestPath: bootedManifestPath, dataDir: resolve(manifest.dataDir), pluginCatalog },
		});
		const modelControls = commands.find("model", "channel") !== undefined;
		const nativeHandler = createNativeModelHandler(runningBot, models, context, { enabled: modelControls });
		for (const channel of manifest.channels) {
			const answer = channelHandler(channel, runningBot, commands, context, nativeHandler);
			await lifecycle.start({ name: `channel ${channel.name}`, start: () => channel.start(answer, nativeHandler, { modelControls }), stop: () => channel.stop() });
			// ADR 0096: answers of woken turns in this channel's threads are posted through it.
			runningBot.attachChannel(channel);
		}
		let api: ReturnType<typeof startClientApi> | undefined;
		if (manifest.api) {
			const port = manifest.api.port;
			const control: DaemonControl = {
				info: async () => ({
					pid: process.pid,
					version: packageJson.version,
					manifestPath: bootedManifestPath,
					manifestSha256,
					owner,
					startedAt,
					setup: await readSetupState(manifest.dataDir),
				}),
				shutdown,
				startSuccessor: async () => {
					const supervisor = detectSupervisor();
					if (supervisor) return { ok: false, error: "supervised", supervisor };
					const started = await startSuccessor({
						argv: successorArgv(process.execPath, Bun.main, process.argv, positionals[0]),
						cwd: bootCwd,
						env: { ...process.env, ...(owner === "tui" ? { DINOBOT_DAEMON_OWNER: "tui" } : {}) },
						readyPath: join(resolve(manifest.dataDir), `restart-${crypto.randomUUID()}.ready`),
					});
					return started.ok ? started : { ok: false, error: "successor", detail: started.detail };
				},
			};
			const usage = createUsageService({
				harness: runningBot.harness,
				index: runningBot.index,
				context,
				credentials: auth.credentials,
				providerName: (key) => models.getProvider(key)?.name,
			});
			await lifecycle.start({ name: "client API", start() { api = startClientApi(runningBot, port, context, commands, report, control, usage); }, stop: () => api?.stop() });
		}
		console.log(
			[
				"dinobot up:",
				`model=${manifest.model.provider}/${manifest.model.modelId}`,
				`toolMode=${manifest.toolMode}`,
				...(manifest.promptProfile === "full" ? [] : [`promptProfile=${manifest.promptProfile}`]),
				`channels=${manifest.channels.map((channel) => channel.name).join(",") || "-"}`,
				`plugins=${manifest.plugins.map((plugin) => `${plugin.id}(${plugin.tools.length} tools)`).join(",") || "-"}`,
				`agents=${manifest.agents.length}`,
				`api=${api?.url ?? "-"}`,
			].join(" "),
		);
	} catch (error) {
		const result = await lifecycle.stop();
		console.error(new AggregateError([error, ...result.errors], "Daemon startup failed"));
		process.exit(1);
	}
}

async function resolveManifestPath(): Promise<string> {
	const explicit = args.config ?? process.env.DINOBOT_CONFIG;
	if (explicit !== undefined) return explicit;
	if (existsSync("dinobot.yaml")) return "dinobot.yaml";
	// First run: create a local default instead of refusing to start.
	const { path, created } = await ensureDefaultManifest(homedir());
	// The TUI opens setup itself; only the headless daemon needs to say where its configuration came from.
	if (created && command === "serve") console.error(`dinobot: created ${path}; run \`dinobot setup\` in a terminal to connect a model`);
	return path;
}
