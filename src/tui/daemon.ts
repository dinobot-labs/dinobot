import { closeSync, openSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Manifest } from "../manifest.ts";
import { detectLocale } from "../setup/locale.ts";
import { ApiClient } from "./client.ts";

const START_TIMEOUT_MS = 15_000;

export type Daemon = { readonly client: ApiClient; readonly startedPid?: number; readonly logPath: string };

/**
 * Connect to the daemon of this manifest, starting `dinobot serve` in the background when nothing answers.
 * The daemon owns the SQLite file (single writer), so the TUI never opens storage itself.
 */
export async function ensureDaemon(manifest: Manifest, manifestPath: string): Promise<Daemon> {
	if (manifest.api === undefined) {
		throw new Error(`${manifestPath} has no api section; add \`api: { port: 8786 }\` to use the TUI`);
	}
	const client = new ApiClient(new URL(`http://127.0.0.1:${manifest.api.port}`), resolve(manifest.workspaceRoot ?? process.cwd()), detectLocale());
	const logPath = daemonLogPath(manifest.dataDir);
	if (await client.healthy()) return { client, logPath };

	const child = await spawnDaemon(manifestPath, manifest.dataDir);
	const deadline = Date.now() + START_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) break;
		if (await client.healthy()) return { client, startedPid: child.pid, logPath };
		await Bun.sleep(100);
	}
	throw new Error(`dinobot daemon did not come up on ${client.base} (log: ${logPath})\n${await daemonLogTail(manifest.dataDir)}\n${reportHint(manifestPath)}`);
}

/** Names the offline report command; it works while the daemon cannot start (ADR 0103). */
export const reportHint = (manifestPath: string) => `To send this failure to the dinobot developer: dinobot report send --trigger daemon-start-failed --config ${JSON.stringify(resolve(manifestPath))}`;

export const daemonLogPath = (dataDir: string) => join(dataDir, "dinobot.log");

/**
 * Start `dinobot serve --config <manifest>` detached, appending to the daemon log. The environment marks it TUI-owned, so a
 * TUI may later restart it (POST /v1/daemon/shutdown); the daemon removes the marker from its own environment.
 */
export async function spawnDaemon(manifestPath: string, dataDir: string): Promise<Bun.Subprocess> {
	await mkdir(dataDir, { recursive: true });
	const log = openSync(daemonLogPath(dataDir), "a");
	try {
		const child = Bun.spawn([...selfCommand(), "serve", "--config", resolve(manifestPath)], {
			stdio: ["ignore", log, log],
			detached: true,
			env: { ...process.env, DINOBOT_DAEMON_OWNER: "tui" },
		});
		child.unref();
		return child;
	} finally {
		closeSync(log); // the child holds its own copy
	}
}

/** The last lines of the daemon log, for startup failures. */
export async function daemonLogTail(dataDir: string, lines = 15): Promise<string> {
	return (await readFile(daemonLogPath(dataDir), "utf8").catch(() => "")).split("\n").slice(-lines).join("\n").trim();
}

/** The command that runs this program: the compiled binary itself, or bun plus the entry script. */
function selfCommand(): string[] {
	return Bun.main.startsWith("/$bunfs/") ? [process.execPath] : [process.execPath, Bun.main];
}
