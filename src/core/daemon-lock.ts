import { chmodSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

export class DaemonLockError extends Error {
	override readonly name = "DaemonLockError";
}

export type DaemonLock = { readonly path: string; release(): void };

/**
 * Exclusive OS-level lock on `<dataDir>/daemon.lock` held for the life of the process; released automatically if the
 * process dies. Throws DaemonLockError("another dinobot daemon is already running for <dataDir>") when held by another
 * process. The lock is a SQLite connection in EXCLUSIVE locking mode (the technique of the native channels' inbox):
 * the OS drops it with the file descriptor, so a crashed daemon never leaves a stale lock behind.
 * POSIX advisory locks are per process: a second acquire inside the same process does not conflict.
 */
export function acquireDaemonLock(dataDir: string): DaemonLock {
	const path = join(dataDir, "daemon.lock");
	const database = new Database(path, { create: true });
	try {
		chmodSync(path, 0o600);
		// busy_timeout 0: contention fails at once instead of waiting for the holder.
		database.exec("PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;");
	} catch (error) {
		database.close();
		if (isBusy(error)) throw new DaemonLockError(`another dinobot daemon is already running for ${dataDir}`, { cause: error });
		throw error;
	}
	let released = false;
	return {
		path,
		release() {
			if (released) return;
			released = true;
			database.close();
		},
	};
}

function isBusy(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const code = (error as { code?: unknown }).code;
	return (typeof code === "string" && code.startsWith("SQLITE_BUSY")) || /database is locked/i.test(error.message);
}
