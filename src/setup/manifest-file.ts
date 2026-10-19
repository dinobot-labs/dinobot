/**
 * Read and atomically replace the user's manifest with optimistic concurrency (first-run setup).
 *
 * A snapshot records the exact text and the SHA-256 of the bytes on disk. `replaceManifest` only replaces the file
 * when its content still hashes to the snapshot's value, so a concurrent edit (another editor, a second wizard) is
 * reported as ManifestConflictError instead of being overwritten. The final hash comparison happens immediately before
 * the rename; a writer racing inside that last window cannot be excluded without cooperative locking.
 */
import { createHash, randomUUID } from "node:crypto";
import { type FileHandle, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export type ManifestSnapshot = { readonly text: string; readonly sha256: string };

export class ManifestConflictError extends Error {
	override readonly name = "ManifestConflictError";
}

/** SHA-256 of the UTF-8 bytes of `text`, lowercase hex. */
export function sha256Hex(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function sha256Bytes(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Read the manifest. The text is decoded strictly (invalid UTF-8 throws) and a BOM is kept, so
 * `snapshot.sha256 === sha256Hex(snapshot.text)` always equals the hash of the bytes on disk.
 */
export async function readManifestSnapshot(path: string): Promise<ManifestSnapshot> {
	const bytes = await readFile(path);
	const text = UTF8.decode(bytes);
	return { text, sha256: sha256Bytes(bytes) };
}

/**
 * Atomically replace the file at `path` with `text` iff its current content hashes to `expectedSha256`.
 * - When `backup` is true (default), first atomically write the CURRENT bytes to `${path}.bak` (temp file + fsync +
 *   rename, same mode as the original).
 * - New content: a temp file in the target's directory (exclusive create, same mode as the original), fsync, re-check
 *   the current hash immediately before the rename (ManifestConflictError, temp file removed, when it changed), rename
 *   over the target, fsync the directory.
 * - When the initial hash check fails nothing is written (no .bak either). When only the final re-check fails, the
 *   manifest is unchanged but `.bak` may already hold the bytes that were current at the first check.
 * - A symlink at `path` is resolved with realpath and its target file is replaced; the link itself is kept. The backup
 *   is still written to `${path}.bak` (next to the link).
 * Temp files are removed on every failure path. Returns the new snapshot.
 */
export async function replaceManifest(path: string, text: string, expectedSha256: string, options?: { readonly backup?: boolean }): Promise<ManifestSnapshot> {
	const target = await realpath(path);
	const handle = await open(target, "r");
	let current: Uint8Array;
	let mode: number;
	try {
		const stat = await handle.stat();
		if (!stat.isFile()) throw new Error(`${path} is not a regular file`);
		mode = stat.mode & 0o7777 || 0o600;
		current = await handle.readFile();
	} finally {
		await handle.close();
	}
	if (sha256Bytes(current) !== expectedSha256) throw new ManifestConflictError(`${path} changed since it was read`);

	if (options?.backup ?? true) await writeAtomically(`${path}.bak`, current, mode);

	await writeAtomically(target, new TextEncoder().encode(text), mode, async () => {
		const now = await readFile(target);
		if (sha256Bytes(now) !== expectedSha256) throw new ManifestConflictError(`${path} changed while it was being replaced`);
	});
	return { text, sha256: sha256Hex(text) };
}

/** temp file (exclusive create, `mode`) + fsync + optional `beforeRename` check + rename + directory fsync. */
async function writeAtomically(destination: string, bytes: Uint8Array, mode: number, beforeRename?: () => Promise<void>): Promise<void> {
	const directory = dirname(destination);
	const temporary = join(directory, `.${basename(destination)}.${randomUUID()}.tmp`);
	let renamed = false;
	try {
		const file: FileHandle = await open(temporary, "wx", mode);
		try {
			await file.chmod(mode); // the umask may have narrowed the creation mode
			await file.writeFile(bytes);
			await file.sync();
		} finally {
			await file.close();
		}
		await beforeRename?.();
		await rename(temporary, destination);
		renamed = true;
	} finally {
		if (!renamed) await unlink(temporary).catch(() => {});
	}
	await syncDirectory(directory);
}

async function syncDirectory(directory: string): Promise<void> {
	let handle: FileHandle | undefined;
	try {
		handle = await open(directory, "r");
		await handle.sync();
	} catch (error) {
		// Some platforms/filesystems cannot fsync a directory; the rename itself already happened.
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR" && code !== "EPERM") throw error;
	} finally {
		await handle?.close();
	}
}
