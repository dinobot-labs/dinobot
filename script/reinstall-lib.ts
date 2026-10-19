/** Pure decisions for script/reinstall.ts, kept separate so they can be tested without systemd. */

/** `systemctl show` key=value output. */
export function parseShow(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of text.split("\n")) {
		const at = line.indexOf("=");
		if (at > 0) out[line.slice(0, at)] = line.slice(at + 1).trim();
	}
	return out;
}

/** True when this process runs inside the unit's cgroup, i.e. stopping the unit would kill this script. */
export function insideUnit(cgroup: string, unit: string): boolean {
	return cgroup.split("\n").some((line) => line.split("/").includes(unit));
}

/** `--timestamp=unix` values look like "@1791125418"; empty or "n/a" when the unit never started. */
export function unixSeconds(value: string | undefined): number | undefined {
	const m = /^@(\d+)$/.exec(value ?? "");
	return m ? Number(m[1]) : undefined;
}

export type UnitState = { load: string; active: string; startedAt?: number | undefined; execStart: string };
export function unitState(show: Record<string, string>): UnitState {
	return {
		load: show.LoadState ?? "not-found",
		active: show.ActiveState ?? "inactive",
		startedAt: unixSeconds(show.ExecMainStartTimestamp),
		execStart: show.ExecStart ?? "",
	};
}

/** The unit may be (re)created once it is unloaded, or loaded but inactive/failed (then reset-failed first). */
export function stopped(state: UnitState): boolean {
	return state.load === "not-found" || state.active === "inactive" || state.active === "failed";
}

/**
 * After our own `systemd-run` failed: if the unit is running our binary and its main process started at or
 * after the install, another actor already started the new build and the goal is met. Otherwise it is a failure.
 */
export function startedByOther(state: UnitState, bin: string, installedAt: number): boolean {
	return state.active === "active" && state.execStart.includes(bin) && state.startedAt !== undefined && state.startedAt >= installedAt;
}

/** A lock holder is live when its pid exists; a stale lock (dead pid) may be taken over. */
export function lockIsStale(holderPid: number | undefined, alive: (pid: number) => boolean): boolean {
	return holderPid === undefined || !Number.isSafeInteger(holderPid) || !alive(holderPid);
}

/** Positive integer pids from `pgrep` stdout; blank lines and junk are ignored. */
export function parsePids(text: string): number[] {
	return text.split("\n").map((line) => Number(line.trim())).filter((pid) => Number.isSafeInteger(pid) && pid > 0);
}

/**
 * Walk the parent chain from our own parent upward (no /proc on macOS: `ps -o ppid=` supplies the links).
 * True when a daemon pid is an ancestor, i.e. killing the daemon's process tree could kill this run.
 * Stops on missing parents, pid 1, cycles and the depth cap.
 */
export function ancestorIsDaemon(ppid: number, daemons: ReadonlySet<number>, parentOf: (pid: number) => number | undefined, maxDepth = 64): boolean {
	const seen = new Set<number>();
	for (let pid = ppid, depth = 0; pid > 1 && depth < maxDepth && !seen.has(pid); depth++) {
		seen.add(pid);
		if (daemons.has(pid)) return true;
		const next = parentOf(pid);
		if (next === undefined || !Number.isSafeInteger(next)) return false;
		pid = next;
	}
	return false;
}

/**
 * Pids whose `ps -o pid=,args=` line contains the needle. Used instead of `pgrep -f` on macOS,
 * where pgrep misses some processes entirely (observed 2026-10-08: a launchd-spawned bun-global
 * daemon matched no pgrep -f pattern at all while ps showed its full argv).
 */
export function psPids(text: string, needle: string): number[] {
	const out: number[] = [];
	for (const line of text.split("\n")) {
		const m = /^\s*(\d+)\s+(.*)$/.exec(line);
		if (m && m[2]!.includes(needle)) out.push(Number(m[1]));
	}
	return out;
}
