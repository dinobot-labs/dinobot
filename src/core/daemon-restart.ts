import { readFileSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { acquireDaemonLock, type DaemonLock, DaemonLockError } from "./daemon-lock.ts";

/**
 * Daemon restart by handoff (used after `dinobot update`).
 *
 * 1. The running daemon spawns its successor with its own argv, cwd and environment plus HANDOFF_ENV=<ready file>.
 * 2. The successor parses the manifest, writes its pid to the ready file, then waits for the daemon lock.
 * 3. Only after the ready file names the successor does the old daemon stop gracefully (same path as SIGTERM).
 *    If the successor exits or never becomes ready, it is killed and the old daemon keeps running untouched.
 * 4. The successor takes the lock once the old daemon released it, so two daemons never run on one dataDir.
 */
export const HANDOFF_ENV = "DINOBOT_RESTART_HANDOFF";
export const HANDOFF_READY_MS = 60_000;
export const HANDOFF_LOCK_MS = 60_000;

export type Supervisor = { readonly kind: "systemd" | "launchd" | "container"; readonly unit?: string };

export type RestartResult =
	| { readonly status: "restarting"; readonly successorPid: number; readonly busy: readonly string[] }
	| { readonly status: "refused"; readonly error: "pid" | "stopping" | "supervised"; readonly supervisor?: Supervisor }
	| { readonly status: "failed"; readonly error: "successor"; readonly detail: string };

/**
 * A service manager restarts (or kills) what it supervises, so a self-spawned successor would race it or die with
 * the service cgroup. Such daemons are refused and must be restarted through their manager.
 */
export type SupervisorProbe = {
	readonly env?: NodeJS.ProcessEnv;
	readonly pid?: number;
	readonly ppid?: number;
	readonly platform?: NodeJS.Platform;
	readonly readCgroup?: () => string;
	/** MainPID of a systemd unit; undefined when it cannot be determined. */
	readonly mainPid?: (unit: string, user: boolean) => number | undefined;
};

export function detectSupervisor(probe: SupervisorProbe = {}): Supervisor | undefined {
	const env = probe.env ?? process.env;
	const pid = probe.pid ?? process.pid;
	const ppid = probe.ppid ?? process.ppid;
	const platform = probe.platform ?? process.platform;
	if (pid === 1) return { kind: "container" };
	if (platform === "linux") {
		let cgroup = "";
		try { cgroup = (probe.readCgroup ?? (() => readFileSync("/proc/self/cgroup", "utf8")))(); } catch { /* no cgroup information */ }
		for (const line of cgroup.split("\n")) {
			const path = line.split(":").at(-1) ?? "";
			const unit = path.split("/").filter(Boolean).at(-1);
			// user@<uid>.service is the user manager itself; interactive shells live in *.scope units.
			if (!unit?.endsWith(".service") || /^user@\d+\.service$/.test(unit)) continue;
			// Anything started from inside a service (a CI job, a tool of another daemon) shares its cgroup; only the
			// unit's main process is what systemd restarts. Unknown is treated as supervised.
			const main = (probe.mainPid ?? systemdMainPid)(unit, /\/user@\d+\.service\//.test(path));
			if (main === undefined || main === pid) return { kind: "systemd", unit };
		}
	}
	const xpc = env.XPC_SERVICE_NAME;
	// launchd jobs carry their label and are children of launchd; terminals and GUI apps report "0" or "application.…".
	if (platform === "darwin" && ppid === 1 && xpc && xpc !== "0" && !xpc.startsWith("application.")) return { kind: "launchd", unit: xpc };
	return undefined;
}

function systemdMainPid(unit: string, user: boolean): number | undefined {
	try {
		const result = Bun.spawnSync(["systemctl", ...(user ? ["--user"] : []), "show", "--property=MainPID", "--value", unit], { stdout: "pipe", stderr: "ignore", timeout: 5_000 });
		const value = Number(result.stdout.toString().trim());
		return result.exitCode === 0 && Number.isSafeInteger(value) && value > 0 ? value : undefined;
	} catch { return undefined; }
}

/** What the daemon's restart preparation reports to the client API. */
export type SuccessorStart =
	| { readonly ok: true; readonly pid: number }
	| { readonly ok: false; readonly error: "supervised"; readonly supervisor: Supervisor }
	| { readonly ok: false; readonly error: "successor"; readonly detail: string };

export type SuccessorOptions = {
	readonly argv: readonly string[];
	readonly cwd: string;
	readonly env: Record<string, string | undefined>;
	readonly readyPath: string;
	readonly timeoutMs?: number;
	readonly sleep?: (ms: number) => Promise<void>;
};

/** Spawn the successor and wait until it reports ready. Never leaves a half-started successor behind. */
export async function startSuccessor(options: SuccessorOptions): Promise<{ ok: true; pid: number } | { ok: false; detail: string }> {
	const sleep = options.sleep ?? Bun.sleep;
	await rm(options.readyPath, { force: true });
	let child: Bun.Subprocess;
	try {
		child = Bun.spawn([...options.argv], {
			cwd: options.cwd,
			env: { ...options.env, [HANDOFF_ENV]: options.readyPath },
			// Same stdout/stderr as this daemon: a log file, a supervisor-less nohup file or a terminal.
			stdio: ["ignore", "inherit", "inherit"],
			detached: true,
		});
	} catch (error) {
		return { ok: false, detail: `could not start the new daemon: ${error instanceof Error ? error.message : String(error)}` };
	}
	child.unref();
	const deadline = Date.now() + (options.timeoutMs ?? HANDOFF_READY_MS);
	try {
		while (Date.now() < deadline) {
			const ready = await readFile(options.readyPath, "utf8").catch(() => undefined);
			if (ready?.trim() === String(child.pid)) return { ok: true, pid: child.pid };
			if (child.exitCode !== null || child.signalCode !== null) {
				return { ok: false, detail: `the new daemon exited (${child.signalCode ?? `code ${child.exitCode}`}) before it was ready; see the daemon log` };
			}
			await sleep(50);
		}
		try { child.kill("SIGKILL"); } catch { /* already gone */ }
		return { ok: false, detail: "the new daemon did not become ready in time" };
	} finally {
		await rm(options.readyPath, { force: true }).catch(() => {});
	}
}

/** Successor side: announce readiness (once the manifest parsed), then wait for the old daemon to release the lock. */
export async function takeOverDaemonLock(
	dataDir: string,
	readyPath: string,
	options: { timeoutMs?: number; sleep?: (ms: number) => Promise<void>; acquire?: (dataDir: string) => DaemonLock } = {},
): Promise<DaemonLock> {
	const acquire = options.acquire ?? acquireDaemonLock;
	const sleep = options.sleep ?? Bun.sleep;
	await writeFile(readyPath, String(process.pid), { mode: 0o600 });
	const deadline = Date.now() + (options.timeoutMs ?? HANDOFF_LOCK_MS);
	for (;;) {
		try { return acquire(dataDir); } catch (error) {
			if (!(error instanceof DaemonLockError) || Date.now() >= deadline) throw error;
		}
		await sleep(100);
	}
}

/** argv that restarts this daemon: the same program and arguments, with the default command made explicit. */
export function successorArgv(execPath: string, main: string, argv: readonly string[], command: string | undefined): string[] {
	const program = main.startsWith("/$bunfs/") ? [execPath] : [execPath, argv[1] ?? main];
	const args = argv.slice(2);
	return [...program, ...(command === undefined ? ["serve"] : []), ...args];
}
