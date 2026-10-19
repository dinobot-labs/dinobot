import type { ManifestApplyRequest } from "../commands/types.ts";
import type { DaemonInfo, ShutdownResult } from "../core/daemon-info.ts";
import { ManifestConflictError, type ManifestSnapshot, sha256Hex } from "./manifest-file.ts";

/**
 * Applying a setup change: the TUI-side transaction that writes the manifest and restarts a TUI-owned daemon.
 *
 * State: the manifest file M (base B or candidate C), the old daemon D (pid p, booted from B) and at most one new daemon.
 * Invariants:
 *   I1  at most one daemon process runs for the data directory: a new one is spawned only after the previous pid is gone
 *       (and the daemon's own `daemon.lock` refuses a second one regardless).
 *   I2  nothing is written unless C validates, the file still hashes to B, D is reachable, booted from this very file,
 *       is owned by a TUI and is idle; C never moves `bot.dataDir` or `api.port`.
 *   I3  every exit leaves M equal to what the running daemon booted from, or reports the exact exception:
 *       applied (M=C, daemon on C), rolled_back (M=B, daemon on B), stuck (M=B, D still stopping, nothing spawned),
 *       failed (M=B, no daemon running), saved_external (M=C, an external owner must restart its service).
 *   I4  a journal `<manifest>.setup-journal.json` exists exactly while M may disagree with the running daemon; a TUI that
 *       finds one at start reconciles it before connecting ({@link recoverInterruptedApply}).
 */
export type ApplyOutcome =
	| { readonly status: "applied" }
	| { readonly status: "saved_external" }
	| { readonly status: "conflict" }
	| { readonly status: "invalid"; readonly problems: readonly string[] }
	| { readonly status: "unreachable" }
	| { readonly status: "older_daemon" }
	| { readonly status: "other_manifest"; readonly path: string }
	| { readonly status: "unsafe_change" }
	| { readonly status: "busy"; readonly threads: readonly string[] }
	| { readonly status: "stuck"; readonly pid: number }
	| { readonly status: "rolled_back"; readonly reason: string; readonly log: string }
	| { readonly status: "failed"; readonly reason: string; readonly log: string };

export type ApplyJournal = { readonly baseSha256: string; readonly candidateSha256: string; readonly pid: number; readonly startedAt: string };

export type Validation = { readonly ok: true } | { readonly ok: false; readonly problems: readonly string[] };

/** Everything the transaction touches; the TUI binds the real file system, client and processes, tests bind fakes. */
export type ApplyPorts = {
	read(path: string): Promise<ManifestSnapshot>;
	/** Compare-and-swap replace; rejects with ManifestConflictError when the file no longer hashes to `expectedSha256`. */
	replace(path: string, text: string, expectedSha256: string, backup: boolean): Promise<ManifestSnapshot>;
	/** Full manifest validation, the same the daemon runs at boot. */
	validate(text: string): Promise<Validation>;
	realpath(path: string): Promise<string>;
	/** Undefined when the daemon predates `/v1/daemon`; rejects when nothing answers. */
	info(): Promise<DaemonInfo | undefined>;
	shutdown(pid: number): Promise<ShutdownResult>;
	alive(pid: number): boolean;
	spawn(manifestPath: string): Promise<{ readonly pid: number; exited(): boolean }>;
	kill(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
	logTail(): Promise<string>;
	journal: {
		write(path: string, entry: ApplyJournal): Promise<void>;
		read(path: string): Promise<ApplyJournal | undefined>;
		clear(path: string): Promise<void>;
	};
	sleep(ms: number): Promise<void>;
	now(): number;
};

export type ApplyLimits = {
	/** How long a stopping daemon may take to exit; main.ts has a 10 s shared shutdown deadline. */
	readonly stopMs: number;
	/** How long a new daemon may take to answer with its identity. */
	readonly startMs: number;
	readonly pollMs: number;
};

export const DEFAULT_APPLY_LIMITS: ApplyLimits = { stopMs: 20_000, startMs: 20_000, pollMs: 100 };

export const backupPath = (manifestPath: string) => `${manifestPath}.bak`;

export async function applyManifestChange(request: ManifestApplyRequest, ports: ApplyPorts, limits: ApplyLimits = DEFAULT_APPLY_LIMITS): Promise<ApplyOutcome> {
	const path = request.manifestPath;
	const base = await ports.read(path);
	if (base.sha256 !== request.baseSha256) return { status: "conflict" };
	const candidateSha256 = sha256Hex(request.candidate);
	if (candidateSha256 === base.sha256) return { status: "applied" };
	const validation = await ports.validate(request.candidate);
	if (!validation.ok) return { status: "invalid", problems: validation.problems };
	if (!sameLocation(base.text, request.candidate)) return { status: "unsafe_change" };

	let info: DaemonInfo | undefined;
	try {
		info = await ports.info();
	} catch {
		return { status: "unreachable" };
	}
	if (info === undefined) return { status: "older_daemon" };
	if ((await ports.realpath(path)) !== info.manifestPath) return { status: "other_manifest", path: info.manifestPath };
	if (info.owner !== "tui") {
		// Not ours to restart: save (with a backup) and let its owner restart it.
		try {
			await ports.replace(path, request.candidate, base.sha256, true);
		} catch (error) {
			if (error instanceof ManifestConflictError) return { status: "conflict" };
			throw error;
		}
		return { status: "saved_external" };
	}
	if (info.busy.length > 0) return { status: "busy", threads: info.busy };

	const pid = info.pid;
	await ports.journal.write(path, { baseSha256: base.sha256, candidateSha256, pid, startedAt: new Date(ports.now()).toISOString() });
	try {
		await ports.replace(path, request.candidate, base.sha256, true);
	} catch (error) {
		await ports.journal.clear(path);
		if (error instanceof ManifestConflictError) return { status: "conflict" };
		throw error;
	}
	const restore = () => ports.replace(path, base.text, candidateSha256, false);

	let refused: ShutdownResult | undefined;
	try {
		const result = await ports.shutdown(pid);
		if (result.status === "refused") refused = result;
	} catch {
		// The answer may be lost while the server stops; whether it stops is decided by watching the pid below.
	}
	if (refused !== undefined && refused.status === "refused") {
		await restore();
		await ports.journal.clear(path);
		if (refused.error === "busy") return { status: "busy", threads: refused.busy ?? [] };
		return { status: "unreachable" };
	}
	if (!(await waitGone(ports, pid, limits))) {
		await restore();
		await ports.journal.clear(path);
		return { status: "stuck", pid };
	}

	const started = await startDaemon(ports, path, candidateSha256, limits);
	if (started.ok) {
		await ports.journal.clear(path);
		return { status: "applied" };
	}
	const log = await ports.logTail().catch(() => "");
	if (started.child !== undefined && !(await stopProcess(ports, started.child, limits))) {
		await restore();
		await ports.journal.clear(path);
		return { status: "failed", reason: `${started.reason}; the new daemon (pid ${started.child}) did not stop`, log };
	}
	try {
		await restore();
	} catch (error) {
		await ports.journal.clear(path);
		return { status: "failed", reason: `${started.reason}; ${error instanceof Error ? error.message : String(error)}`, log };
	}
	await ports.journal.clear(path);
	if (started.foreign) return { status: "failed", reason: started.reason, log };
	const again = await startDaemon(ports, path, base.sha256, limits);
	if (again.ok) return { status: "rolled_back", reason: started.reason, log };
	if (again.child !== undefined) await stopProcess(ports, again.child, limits);
	return { status: "failed", reason: `${started.reason}; the previous settings did not start either (${again.reason})`, log: await ports.logTail().catch(() => log) };
}

/**
 * Reconciles a journal left by a TUI that died mid-apply, before the TUI connects. The running daemon decides: if it booted
 * from the candidate the apply finished; otherwise the base is restored on disk from `.bak` (when the file still holds the
 * candidate) so the next daemon boots from what was running before.
 */
export async function recoverInterruptedApply(manifestPath: string, ports: Pick<ApplyPorts, "read" | "replace" | "info" | "journal">): Promise<"none" | "completed" | "recovered"> {
	const journal = await ports.journal.read(manifestPath);
	if (journal === undefined) return "none";
	const info = await ports.info().catch(() => undefined);
	if (info !== undefined && info.manifestSha256 === journal.candidateSha256) {
		await ports.journal.clear(manifestPath);
		return "completed";
	}
	const current = await ports.read(manifestPath).catch(() => undefined);
	if (current?.sha256 === journal.candidateSha256) {
		const backup = await ports.read(backupPath(manifestPath));
		if (backup.sha256 !== journal.baseSha256) throw new Error(`${backupPath(manifestPath)} does not hold the settings from before the interrupted setup; fix ${manifestPath} by hand`);
		await ports.replace(manifestPath, backup.text, journal.candidateSha256, false);
		await ports.journal.clear(manifestPath);
		return "recovered";
	}
	await ports.journal.clear(manifestPath);
	return "none";
}

/** Setup never moves the data directory (and with it the daemon lock) or the API port the TUI talks to. */
function sameLocation(base: string, candidate: string): boolean {
	const where = (text: string) => {
		const raw = Bun.YAML.parse(text) as { bot?: { dataDir?: unknown }; api?: { port?: unknown } } | null;
		return JSON.stringify([raw?.bot?.dataDir ?? null, raw?.api?.port ?? null]);
	};
	try {
		return where(base) === where(candidate);
	} catch {
		return false;
	}
}

async function waitGone(ports: ApplyPorts, pid: number, limits: ApplyLimits): Promise<boolean> {
	const deadline = ports.now() + limits.stopMs;
	while (ports.alive(pid)) {
		if (ports.now() >= deadline) return false;
		await ports.sleep(limits.pollMs);
	}
	return true;
}

/** SIGTERM (graceful), then SIGKILL; true once the pid is gone. */
async function stopProcess(ports: ApplyPorts, pid: number, limits: ApplyLimits): Promise<boolean> {
	if (!ports.alive(pid)) return true;
	try {
		ports.kill(pid, "SIGTERM");
	} catch {
		// Already gone.
	}
	if (await waitGone(ports, pid, limits)) return true;
	try {
		ports.kill(pid, "SIGKILL");
	} catch {
		// Already gone.
	}
	return waitGone(ports, pid, { ...limits, stopMs: Math.min(limits.stopMs, 5_000) });
}

type Started =
	| { readonly ok: true }
	| { readonly ok: false; readonly reason: string; readonly child?: number; readonly foreign?: boolean };

/**
 * Spawns a daemon and waits until one answers with its identity. Ours booted from `sha256`: success. Another process
 * already serving this file's expected content (a second TUI won the race and our child lost the daemon lock): success
 * too. Anything else is a failure carrying the child's pid when it may still be alive.
 */
async function startDaemon(ports: ApplyPorts, path: string, sha256: string, limits: ApplyLimits): Promise<Started> {
	let child: { readonly pid: number; exited(): boolean };
	try {
		child = await ports.spawn(path);
	} catch (error) {
		return { ok: false, reason: `could not start dinobot: ${error instanceof Error ? error.message : String(error)}` };
	}
	const deadline = ports.now() + limits.startMs;
	while (ports.now() < deadline) {
		const info = await ports.info().catch(() => undefined);
		if (info !== undefined) {
			if (info.manifestSha256 === sha256 && (info.pid === child.pid || !ports.alive(child.pid))) return { ok: true };
			if (info.pid === child.pid) return { ok: false, reason: "the new daemon booted from different settings", child: child.pid };
			if (!ports.alive(child.pid)) return { ok: false, reason: `another process (pid ${info.pid}) answers on the API port`, foreign: true };
		}
		if (child.exited()) return { ok: false, reason: "the daemon exited during startup" };
		await ports.sleep(limits.pollMs);
	}
	return { ok: false, reason: `the daemon did not answer within ${Math.round(limits.startMs / 1000)}s`, child: child.pid };
}
