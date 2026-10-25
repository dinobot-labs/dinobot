import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const MAX_INVENTORY_BYTES = 4 * 1024 * 1024;

export type ProcessRow = { pid: number; pgid: number; command: string };

/**
 * Parse fixed-width-forgiving `ps -Aww -o pid=,pgid=,comm=` output (LC_ALL=C). The trailing newline is
 * load-bearing: a missing one means the snapshot was truncated mid-line, and every row must carry two
 * safe nonnegative integer IDs plus a non-empty command. Data is a refusal trigger, never a guess.
 */
export function parseProcessInventory(stdout: string): ProcessRow[] {
	if (!stdout.length) throw Error("empty_process_inventory");
	if (Buffer.byteLength(stdout, "utf8") >= MAX_INVENTORY_BYTES) throw Error("oversized_process_inventory");
	if (!stdout.endsWith("\n")) throw Error("truncated_process_inventory");
	if (/[\x00-\x08\x0b-\x1f\x7f\ufffd]/.test(stdout)) throw Error("malformed_process_inventory");
	const rows: ProcessRow[] = [];
	const seen = new Set<number>();
	for (const line of stdout.slice(0, -1).split("\n")) {
		const match = /^[ \t]*(0|[1-9][0-9]*)[ \t]+(0|[1-9][0-9]*)[ \t]+(\S(?:.*\S)?)[ \t]*$/.exec(line);
		if (match === null) throw Error("malformed_process_inventory");
		const pid = Number(match[1]);
		const pgid = Number(match[2]);
		const command = match[3] ?? "";
		if (!Number.isSafeInteger(pid) || pid < 0 || !Number.isSafeInteger(pgid) || pgid < 0 || !command || /[\x00-\x1f\x7f]/.test(command)) throw Error("malformed_process_inventory");
		if (seen.has(pid)) throw Error("duplicate_process_inventory");
		seen.add(pid);
		rows.push({ pid, pgid, command });
	}
	return rows;
}

const basename = (command: string) => command.split("/").pop() ?? command;

/**
 * Conservative negative control over a parsed inventory. Recorded PIDs block BOTH the exact PID and any
 * survivor sharing that recorded process's PGID (which includes this utility itself when already in the
 * group). Every live process whose basename starts with cua-driver is refused outright. Missing records,
 * PID 1 or our own PID invalidate the snapshot. An empty result is only the absence of positive blockers:
 * PID absence here is NOT proof of historical quiescence.
 */
export function liveProcessBlockers(rows: ProcessRow[], recordedPids: readonly number[], selfPid: number): string[] {
	if (!Number.isSafeInteger(selfPid) || selfPid <= 0) throw Error("invalid_observer_pid");
	const unknown = new Set<number>();
	for (const pid of recordedPids) if (!Number.isSafeInteger(pid) || pid <= 0) unknown.add(pid);
	if (unknown.size) throw Error("invalid_recorded_pid");
	if (!rows.some(row => row.pid === 1)) throw Error("process_inventory_incomplete");
	if (!rows.some(row => row.pid === selfPid)) throw Error("process_inventory_incomplete");
	const blockers: string[] = [];
	for (const row of rows) {
		const name = basename(row.command);
		if (/^cua-driver/i.test(name)) blockers.push(`forbidden live process ${row.pid} (${name}); maintenance refuses cua-driver naming conservatively`);
	}
	for (const recorded of new Set(recordedPids)) {
		for (const row of rows) {
			if (row.pid === recorded) blockers.push(`live process ${row.pid} (pgid ${row.pgid}); identity may be reused, but maintenance refuses conservatively`);
			else if (row.pgid === recorded) blockers.push(`same-group survivor ${row.pid} (pgid ${row.pgid}) of recorded process ${recorded}; maintenance refuses conservatively`);
		}
	}
	return [...new Set(blockers)];
}

/** Fixed C locale, minimal PATH so a hostile or odd environment cannot change what ps reports. */
export type InventoryCapture = () => Promise<{ stdout: string; stderr: string }>;
const captureProcessInventory: InventoryCapture = async () => promisify(execFile)("/bin/ps", ["-Aww", "-o", "pid=,pgid=,comm="], {
 timeout: 15_000,
 maxBuffer: MAX_INVENTORY_BYTES,
 encoding: "utf8",
 env: { LC_ALL: "C", LANG: "C", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
});
export async function scanProcessInventory(capture: InventoryCapture = captureProcessInventory): Promise<ProcessRow[]> {
 const result = await capture();
 if (typeof result.stdout !== "string" || typeof result.stderr !== "string" || result.stderr !== "") throw Error("process_inventory_stderr");
 return parseProcessInventory(result.stdout);
}

export async function recoveryProcessBlockersDarwin(recordedPids: readonly number[]): Promise<string[]> {
	for (const pid of recordedPids) if (!Number.isSafeInteger(pid) || pid <= 0) throw Error("invalid_recorded_pid");
	return liveProcessBlockers(await scanProcessInventory(), recordedPids, process.pid);
}
