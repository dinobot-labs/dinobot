import { isConnectionRefused } from "./connection-refused.ts";
import { acquireRestartLease, restartLegacy } from "./legacy-restart.ts";
import type { DaemonInfo } from "../core/daemon-info.ts";
import type { RestartResult } from "../core/daemon-restart.ts";
import { daemonLogPath, daemonLogTail, reportHint, spawnDaemon } from "../tui/daemon.ts";

/**
 * `dinobot restart [--force]`: restart the daemon of the manifest safely (ADR 0099's handoff, as an explicit command).
 * The daemon starts its successor itself and stops only when the successor is ready (src/core/daemon-restart.ts),
 * so a failed start leaves the old daemon running. When the connection is refused, it starts one (idempotent).
 * Busy threads block the restart unless --force: they would be interrupted otherwise.
 */
export type RestartDependencies = {
	/** Port of the manifest's api section: the daemon's client API is the coordination channel. */
	readonly port: number;
	readonly dataDir: string;
	readonly manifestPath: string;
	readonly force: boolean;
	fetch: typeof fetch;
	sleep: (ms: number) => Promise<void>;
	now: () => number;
	log: (message: string) => void;
	error: (message: string) => void;
	/** Start `dinobot serve --config <manifest>` detached, appending to the daemon log (src/tui/daemon.ts). */
	spawn: () => Promise<{ pid: number }>;
	/** The last lines of the daemon log, for startup failures. */
	logTail: () => Promise<string>;
	/** How long a daemon that is not running may take to answer after being started. */
	startMs?: number;
	/** Guarded pre-handoff compatibility, injected for tests. */
	legacyRestart?: (before: DaemonInfo) => Promise<number>;
	acquireLease?: () => Promise<{ release(): void }>;
	/** How long the new daemon may take to answer after the old one began stopping. */
	comebackMs?: number;
};

const REQUEST_MS = 5_000;
/** The daemon waits up to 60 s for its successor to be ready before it answers. */
const RESTART_REQUEST_MS = 75_000;
const START_MS = 15_000;
const COMEBACK_MS = 90_000;

export function restartDependencies(port: number, dataDir: string, manifestPath: string, force: boolean): RestartDependencies {
	return {
		port, dataDir, manifestPath, force,
		fetch: globalThis.fetch, sleep: (ms) => Bun.sleep(ms), now: Date.now,
		log: console.log, error: console.error,
		spawn: async () => {
			const child = await spawnDaemon(manifestPath, dataDir);
			return { pid: child.pid };
		},
		logTail: () => daemonLogTail(dataDir),
		acquireLease: () => acquireRestartLease(dataDir),
	};
}

/** Exit status: 0 when the daemon of the manifest is running after this command, 1 when it is not. */
export async function runRestart(deps: RestartDependencies): Promise<number> {
	let lease: { release(): void } | undefined;
	try {
		lease = await deps.acquireLease?.();
		return await restartUnderLease(deps);
	} catch (error) {
		deps.error("Cannot restart safely: " + (error instanceof Error ? error.message : String(error)));
		return 1;
	} finally { lease?.release(); }
}

async function restartUnderLease(deps: RestartDependencies): Promise<number> {
	const base = "http://127.0.0.1:" + deps.port;
	const request = (route: string, init: RequestInit = {}, ms = REQUEST_MS) =>
		deps.fetch(base + route, { ...init, redirect: "error", signal: AbortSignal.timeout(ms) });
	const info = async (): Promise<DaemonInfo | undefined | null> => {
		const response = await request("/v1/daemon");
		if (response.status === 404) { await response.body?.cancel(); return null; }
		if (!response.ok) throw new Error("HTTP " + response.status);
		return (await response.json()) as DaemonInfo;
	};

	let before: DaemonInfo | undefined | null;
	try { before = await info(); } catch (error) {
		if (!isConnectionRefused(error)) throw new Error("Cannot confirm the API port is absent; no daemon was started", { cause: error });
		return await startWhenDown(deps, base, info);
	}
	if (!before) {
		deps.error("The daemon on " + base + " predates the restart API; stop it and start `dinobot serve` again.");
		return 1;
	}
	const busy = before.busy ?? [];
	if (busy.length > 0 && !deps.force) {
		deps.error("The daemon (pid " + before.pid + ") is running work in " + busy.join(", ") + "; a restart would interrupt it.");
		deps.error("Rerun with --force to interrupt that work, or wait for it to finish.");
		return 1;
	}
	deps.log("Restarting the daemon (pid " + before.pid + ")"
		+ (busy.length ? "; interrupting work in " + busy.join(", ") : "") + "...");

	const manual = "Restart it yourself (stop it, then start `dinobot serve` again).";
	let result: RestartResult;
	try {
		const response = await request("/v1/daemon/restart", {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pid: before.pid }),
		}, RESTART_REQUEST_MS);
		if (response.status === 404) {
			await response.body?.cancel();
			return await (deps.legacyRestart ? deps.legacyRestart(before) : restartLegacy(deps, before));
		}
		result = (await response.json()) as RestartResult;
	} catch (error) {
		deps.error("Could not ask the daemon to restart (" + (error instanceof Error ? error.message : String(error)) + "). " + manual);
		return 1;
	}
	if (result.status === "refused") {
		if (result.error === "supervised") {
			const how = result.supervisor?.kind === "systemd" ? "systemctl --user restart " + (result.supervisor.unit ?? "<unit>") + " (or without --user for a system unit)"
				: result.supervisor?.kind === "launchd" ? "launchctl kickstart -k gui/$(id -u)/" + (result.supervisor.unit ?? "<label>")
					: "restarting its container";
			deps.error("The daemon is managed by " + (result.supervisor?.kind ?? "a service manager") + "; this command must not race it. Restart it there: " + how + ".");
			return 1;
		}
		deps.error("The daemon refused to restart (" + result.error + "); it is still running. " + manual);
		return 1;
	}
	if (result.status === "failed") {
		deps.error("The new daemon could not start: " + result.detail + ". The old daemon keeps running.");
		return 1;
	}

	const deadline = deps.now() + (deps.comebackMs ?? COMEBACK_MS);
	while (deps.now() < deadline) {
		await deps.sleep(250);
		const after = await info().catch(() => undefined);
		if (after && after.pid !== before.pid) {
			deps.log("Daemon restarted (pid " + after.pid + ", dinobot " + after.version + ").");
			return 0;
		}
	}
	deps.error("The daemon stopped but the new one (pid " + result.successorPid + ") did not answer on " + base
		+ " in time. Check the daemon log (" + daemonLogPath(deps.dataDir) + ") and start it with `dinobot serve` if needed.");
	return 1;
}

/** The connection was positively refused: a restart degrades to starting the daemon (idempotent). */
async function startWhenDown(
	deps: RestartDependencies,
	base: string,
	info: () => Promise<DaemonInfo | undefined | null>,
): Promise<number> {
	deps.log("No daemon is running on " + base + "; starting one for " + deps.manifestPath + "...");
	let spawned: { pid: number };
	try {
		spawned = await deps.spawn();
	} catch (error) {
		deps.error("Could not start the daemon: " + (error instanceof Error ? error.message : String(error)));
		return 1;
	}
	const deadline = deps.now() + (deps.startMs ?? START_MS);
	while (deps.now() < deadline) {
		await deps.sleep(100);
		const after = await info().catch(() => undefined);
		if (after?.pid === spawned.pid) {
			deps.log("Daemon started (pid " + after.pid + ", dinobot " + after.version + ").");
			return 0;
		}
		// Another daemon took the port between the check and the spawn; it serves the same request.
		if (after) {
			deps.log("A daemon (pid " + after.pid + ") is already answering on " + base + ".");
			return 0;
		}
	}
	deps.error("dinobot daemon did not come up on " + base + " (log: " + daemonLogPath(deps.dataDir) + ")\n"
		+ await deps.logTail() + "\n" + reportHint(deps.manifestPath));
	return 1;
}
