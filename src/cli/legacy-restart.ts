import { createHash } from "node:crypto";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { DaemonInfo } from "../core/daemon-info.ts";
import { acquireDaemonLock, DaemonLockError, type DaemonLock } from "../core/daemon-lock.ts";
import type { RestartDependencies } from "./restart.ts";
import { isConnectionRefused } from "./connection-refused.ts";

/** No guessed PID or force-kill. Unknown evidence is a refusal, not an absent process. */
export type LegacyProcess = { identity: string };
export type LegacyPorts = {
	probe(pid: number, dataDir: string, port: number): LegacyProcess;
	identity(pid: number): string | null;
	terminate(pid: number): void;
};

function command(argv: string[]): string {
	const result = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe", timeout: 5_000, env: { ...process.env, LC_ALL: "C" } });
	if (result.exitCode !== 0 || result.stderr.toString().trim()) throw new Error("Cannot verify process using " + argv[0]);
	return result.stdout.toString();
}

/** macOS only: lsof proves both the SQLite write lock and listening socket belong to the API PID. */
export function legacyProcessPorts(): LegacyPorts {
	const identity = (pid: number): string | null => {
		if (process.platform !== "darwin") throw new Error("Legacy process verification is currently supported only on macOS; use the original service manager elsewhere");
		const result = Bun.spawnSync(["/bin/ps", "-p", String(pid), "-o", "uid=,lstart=,comm="], { stdout: "pipe", stderr: "pipe", timeout: 5_000, env: { ...process.env, LC_ALL: "C" } });
		if (result.exitCode === 1 && !result.stdout.toString().trim()) return null;
		if (result.exitCode !== 0) throw new Error("Cannot verify process identity");
		const value = result.stdout.toString().trim();
		if (!value || Number(value.split(/\s+/)[0]) !== process.getuid?.()) throw new Error("Daemon process is not owned by this user");
		return value;
	};
	return { identity, terminate: pid => process.kill(pid, "SIGTERM"), probe(pid, dataDir, port) {
		const first = identity(pid);
		if (!first || pid <= 1 || pid === process.pid) throw new Error("Invalid daemon process identity");
		// A service may supervise an ancestor wrapper, not just the daemon itself. Check the whole ancestry.
		const ancestors = new Set<number>();
		let current = pid;
		while (current > 1) {
			if (ancestors.has(current) || ancestors.size > 128) throw new Error("Cannot verify process ancestry");
			ancestors.add(current);
			const parent = Number(command(["/bin/ps", "-p", String(current), "-o", "ppid="]).trim());
			if (!Number.isSafeInteger(parent) || parent < 1) throw new Error("Cannot verify parent process");
			current = parent;
		}
		for (const domain of ["system", "user/" + process.getuid!(), "gui/" + process.getuid!()]) {
			const listing = command(["/bin/launchctl", "print", domain]);
			const services = listing.match(/\n\tservices = \{\n([\s\S]*?)\n\t\}/)?.[1];
			if (services === undefined) throw new Error("Cannot verify launchd ownership in " + domain);
			for (const line of services.split("\n")) {
				const match = line.trim().match(/^(\d+)\s+\S+\s+(.+)$/);
				if (!match) { if (line.trim()) throw new Error("Unknown launchd service listing"); continue; }
				if (ancestors.has(Number(match[1])) && !match[2]!.startsWith("application.")) throw new Error("Daemon is managed by launchd (" + match[2] + "); restart it through launchctl, not by PID");
			}
		}
		// macOS lsof does not report POSIX byte-range locks. Require a unique opener AND SQLite contention.
		const lock = command(["/usr/sbin/lsof", "-nP", "-Fp", "--", join(dataDir, "daemon.lock")]);
		if (lock.split("\n").filter(line => line.startsWith("p")).join("\n") !== "p" + pid) throw new Error("Cannot establish the unique dataDir lock owner");
		let held = false;
		try { const available = acquireDaemonLock(dataDir); available.release(); } catch (error) {
			if (!(error instanceof DaemonLockError)) throw error;
			held = true;
		}
		if (!held) throw new Error("Daemon does not hold the selected dataDir write lock");
		const listener = command(["/usr/sbin/lsof", "-nP", "-a", "-p", String(pid), "-iTCP:" + port, "-sTCP:LISTEN", "-Fp"]);
		if (listener.split("\n").filter(line => line.startsWith("p")).join("\n") !== "p" + pid) throw new Error("Daemon PID does not own the API listener");
		if (identity(pid) !== first) throw new Error("Daemon process changed during verification");
		return { identity: first };
	} };
}

/** Shared by all CLI restart paths, including no-server startup during a legacy shutdown. */
export async function acquireRestartLease(dataDir: string): Promise<DaemonLock> {
	const directory = join(dataDir, ".restart");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	return acquireDaemonLock(directory);
}

/** Stop-then-start compatibility for pre-handoff daemons. Caller holds the CLI restart lease. No rollback on failed boot. */
export async function restartLegacy(deps: RestartDependencies, before: DaemonInfo, ports = legacyProcessPorts()): Promise<number> {
	let stopped = false;
	const request = (route: string, init: RequestInit = {}) => deps.fetch("http://127.0.0.1:" + deps.port + route, { ...init, redirect: "error", signal: AbortSignal.timeout(5_000) });
	const info = async (): Promise<DaemonInfo> => {
		const response = await request("/v1/daemon");
		if (!response.ok) throw new Error("Daemon identity API is unavailable");
		return await response.json() as DaemonInfo;
	};
	try {
		const manifest = await realpath(deps.manifestPath);
		const hash = createHash("sha256").update(await readFile(manifest)).digest("hex");
		const validate = (value: DaemonInfo) => {
			if (!Number.isSafeInteger(value.pid) || value.pid <= 1 || value.pid !== before.pid || value.startedAt !== before.startedAt
				|| !Number.isFinite(Date.parse(value.startedAt)) || value.manifestPath !== manifest || value.manifestSha256 !== hash
				|| !["tui", "external"].includes(value.owner) || value.owner !== before.owner || !Array.isArray(value.busy) || !value.busy.every(x => typeof x === "string")) {
				throw new Error("Daemon identity or manifest changed/unverifiable; nothing was stopped");
			}
			if (value.busy.length && !deps.force) throw new Error("Daemon became busy; wait or rerun with --force");
		};
		validate(before);
		deps.log("Legacy compatibility restart uses this CLI and its current environment; unlike handoff, a failed replacement cannot keep the old daemon running.");
		const observed = ports.probe(before.pid, deps.dataDir, deps.port);
		const latest = await info();
		validate(latest);
		// Repeat all OS evidence after the asynchronous API check. No await between final identity check and signal.
		if (ports.probe(before.pid, deps.dataDir, deps.port).identity !== observed.identity) throw new Error("Daemon PID identity changed; nothing was stopped");
		if (latest.owner === "tui" && !latest.busy.length) {
			const response = await request("/v1/daemon/shutdown", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pid: before.pid }) });
			const result = await response.json() as { status?: string; error?: string };
			if (response.status !== 202 || result.status !== "stopping") throw new Error("Legacy shutdown refused (" + (result.error ?? response.status) + "); nothing was signalled");
		} else {
			if (ports.identity(before.pid) !== observed.identity) throw new Error("Daemon PID identity changed; nothing was stopped");
			ports.terminate(before.pid);
		}
		const deadline = deps.now() + (deps.comebackMs ?? 30_000);
		while (ports.identity(before.pid) === observed.identity) {
			if (deps.now() >= deadline) throw new Error("Legacy daemon shutdown timed out; no SIGKILL or replacement was attempted");
			await deps.sleep(100);
		}
		stopped = true;
		// Process exit alone is insufficient: another writer may have acquired the dataDir.
		const free = acquireDaemonLock(deps.dataDir);
		free.release();
		// Any HTTP response proves occupancy, even 404/503 or invalid JSON. Only a
		// refused connection proves absence; timeout/reset/unknown errors do not.
		let absent = false;
		try {
			await request("/v1/daemon");
		} catch (error) {
			if (isConnectionRefused(error)) absent = true;
			else throw new Error("Cannot confirm the API port is absent; no replacement was started", { cause: error });
		}
		if (!absent) throw new Error("Another process now answers on the API port; no replacement was started");
		deps.log("Legacy daemon stopped; starting the selected manifest with this CLI (current environment).");
		const child = await deps.spawn();
		const readyBy = deps.now() + (deps.startMs ?? 15_000);
		while (deps.now() < readyBy) {
			await deps.sleep(100);
			const after = await info().catch(() => undefined);
			if (!after) continue;
			if (after.pid !== child.pid || after.manifestPath !== manifest || after.manifestSha256 !== hash) throw new Error("Replacement identity mismatch; restart is not verified");
			deps.log("Daemon restarted (pid " + after.pid + ", dinobot " + after.version + ").");
			return 0;
		}
		throw new Error("Replacement did not become ready in time. Log: " + join(deps.dataDir, "dinobot.log") + "\n" + await deps.logTail());
	} catch (error) {
		deps.error("Legacy restart failed: " + (error instanceof Error ? error.message : String(error))
			+ (stopped ? ". The old daemon has stopped; inspect the log and run dinobot serve --config " + JSON.stringify(deps.manifestPath) + " if needed." : ". No replacement was started."));
		return 1;
	}
}
