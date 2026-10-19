import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { DaemonInfo } from "../core/daemon-info.ts";
import type { RestartResult } from "../core/daemon-restart.ts";

/**
 * After `dinobot update`: restart the running daemon of the manifest once, on the installed version.
 * The daemon starts its successor itself and stops only when the successor is ready (src/core/daemon-restart.ts),
 * so a failed start leaves the old daemon running. Running work is interrupted (the user asked for the update).
 */
export type DaemonRestartDependencies = {
	config?: string;
	env: NodeJS.ProcessEnv;
	cwd: string;
	home: string;
	readFile: (path: string) => Promise<string>;
	fetch: typeof fetch;
	sleep: (ms: number) => Promise<void>;
	now: () => number;
	log: (message: string) => void;
	error: (message: string) => void;
	/** How long the new daemon may take to answer after the old one began stopping. */
	comebackMs?: number;
};

const REQUEST_MS = 5_000;
/** The daemon waits up to 60 s for its successor to be ready before it answers. */
const RESTART_REQUEST_MS = 75_000;
const COMEBACK_MS = 90_000;

export function daemonRestartDependencies(config?: string): DaemonRestartDependencies {
	return {
		...(config !== undefined ? { config } : {}),
		env: process.env, cwd: process.cwd(), home: homedir(),
		readFile: (path) => readFile(path, "utf8"),
		fetch: globalThis.fetch, sleep: (ms) => Bun.sleep(ms), now: Date.now,
		log: console.log, error: console.error,
	};
}

/** The manifest the daemon commands would use, without creating the default one. */
async function manifestCandidate(deps: DaemonRestartDependencies): Promise<string> {
	const explicit = deps.config ?? deps.env.DINOBOT_CONFIG;
	if (explicit !== undefined) return resolve(deps.cwd, explicit);
	const local = join(deps.cwd, "dinobot.yaml");
	if (await deps.readFile(local).then(() => true, () => false)) return local;
	return join(deps.home, ".config", "dinobot", "dinobot.yaml");
}

/** Exit status: 0 when the daemon runs `target` or there is nothing this command may restart; 1 when a restart failed. */
export async function restartDaemonAfterUpdate(target: string, deps: DaemonRestartDependencies): Promise<number> {
	const path = await manifestCandidate(deps);
	let text: string;
	try { text = await deps.readFile(path); } catch {
		deps.log("No manifest at " + path + "; no daemon to restart.");
		return 0;
	}
	let port: unknown;
	try { port = (Bun.YAML.parse(text) as { api?: { port?: unknown } } | null)?.api?.port; } catch { port = undefined; }
	if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
		deps.log("Restart any running daemon of " + path + " yourself: it has no api.port this command can reach.");
		return 0;
	}
	const base = "http://127.0.0.1:" + port;
	const request = (route: string, init: RequestInit = {}, ms = REQUEST_MS) =>
		deps.fetch(base + route, { ...init, redirect: "error", signal: AbortSignal.timeout(ms) });
	const info = async (): Promise<DaemonInfo | undefined | null> => {
		const response = await request("/v1/daemon");
		if (response.status === 404) { await response.body?.cancel(); return null; }
		if (!response.ok) throw new Error("HTTP " + response.status);
		return (await response.json()) as DaemonInfo;
	};

	let before: DaemonInfo | undefined | null;
	try { before = await info(); } catch {
		deps.log("No daemon is running on " + base + "; nothing to restart.");
		return 0;
	}
	const manual = "Restart it yourself to use dinobot " + target + " (stop it, then start `dinobot serve` again).";
	if (!before) {
		deps.log("The daemon on " + base + " predates automatic restart. " + manual);
		return 0;
	}
	if (before.version === target) {
		deps.log("The daemon (pid " + before.pid + ") already runs dinobot " + target + ".");
		return 0;
	}
	const busy = before.busy ?? [];
	deps.log("Restarting the daemon (pid " + before.pid + ", " + before.version + " → " + target + ")"
		+ (busy.length ? "; interrupting work in " + busy.join(", ") : "") + "...");

	let result: RestartResult;
	try {
		const response = await request("/v1/daemon/restart", {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pid: before.pid }),
		}, RESTART_REQUEST_MS);
		if (response.status === 404) {
			await response.body?.cancel();
			deps.log("The running daemon predates automatic restart. " + manual);
			return 0;
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
			deps.log("The daemon is managed by " + (result.supervisor?.kind ?? "a service manager") + "; restart it there: " + how + ".");
			return 0;
		}
		deps.error("The daemon refused to restart (" + result.error + "); it is still running " + before.version + ". " + manual);
		return 1;
	}
	if (result.status !== "restarting") {
		deps.error("The new daemon could not start: " + ("detail" in result ? result.detail : "unknown error") + ". The old daemon keeps running " + before.version + ".");
		return 1;
	}

	const deadline = deps.now() + (deps.comebackMs ?? COMEBACK_MS);
	while (deps.now() < deadline) {
		await deps.sleep(250);
		const after = await info().catch(() => undefined);
		if (!after || after.pid === before.pid) continue;
		if (after.version !== target) {
			deps.error("The daemon restarted (pid " + after.pid + ") but runs " + after.version + ", not " + target + ". Check which dinobot it starts.");
			return 1;
		}
		deps.log("Daemon restarted on dinobot " + target + " (pid " + after.pid + ").");
		return 0;
	}
	deps.error("The daemon stopped but the new one (pid " + result.successorPid + ") did not answer on " + base
		+ " in time. Check the daemon log (<dataDir>/dinobot.log or its output file) and start it with `dinobot serve` if needed.");
	return 1;
}
