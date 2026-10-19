import { mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { channelCatalog } from "../channels/index.ts";
import { ManifestError, parseManifest } from "../manifest.ts";
import { pluginCatalog } from "../plugins/index.ts";
import type { ApplyJournal, ApplyPorts, Validation } from "../setup/apply.ts";
import { readManifestSnapshot, replaceManifest } from "../setup/manifest-file.ts";
import type { ApiClient } from "./client.ts";
import { daemonLogTail, spawnDaemon } from "./daemon.ts";

const journalPath = (manifestPath: string) => `${manifestPath}.setup-journal.json`;

/** The real file system, daemon client and processes behind the setup apply transaction (src/setup/apply.ts). */
export function applyPorts(client: ApiClient, dataDir: string): ApplyPorts {
	return {
		read: readManifestSnapshot,
		replace: (path, text, expectedSha256, backup) => replaceManifest(path, text, expectedSha256, { backup }),
		validate,
		realpath: (path) => realpath(path),
		info: () => client.daemonInfo(),
		shutdown: (pid) => client.shutdownDaemon(pid),
		alive,
		spawn: async (manifestPath) => {
			const child = await spawnDaemon(manifestPath, dataDir);
			return { pid: child.pid, exited: () => child.exitCode !== null || child.signalCode !== null };
		},
		kill: (pid, signal) => process.kill(pid, signal),
		logTail: () => daemonLogTail(dataDir),
		journal: {
			write: async (path, entry) => writePrivateJson(journalPath(path), entry),
			read: async (path) => {
				try {
					const value = JSON.parse(await readFile(journalPath(path), "utf8")) as Partial<ApplyJournal>;
					if (typeof value.baseSha256 !== "string" || typeof value.candidateSha256 !== "string" || typeof value.pid !== "number" || typeof value.startedAt !== "string") return undefined;
					return value as ApplyJournal;
				} catch {
					return undefined;
				}
			},
			clear: (path) => rm(journalPath(path), { force: true }),
		},
		sleep: (ms) => Bun.sleep(ms),
		now: () => Date.now(),
	};
}

/** True while the process exists (EPERM: exists but owned by someone else). */
function alive(pid: number): boolean {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** The daemon's own boot validation; plugins it loads are closed again at once. */
async function validate(text: string): Promise<Validation> {
	let raw: unknown;
	try {
		raw = Bun.YAML.parse(text);
	} catch (error) {
		return { ok: false, problems: [error instanceof Error ? error.message : String(error)] };
	}
	try {
		const manifest = await parseManifest(raw, { channels: channelCatalog, plugins: pluginCatalog });
		await Promise.allSettled(manifest.plugins.map(async (plugin) => plugin.close?.()));
		return { ok: true };
	} catch (error) {
		if (error instanceof ManifestError) return { ok: false, problems: error.problems };
		return { ok: false, problems: [error instanceof Error ? error.message : String(error)] };
	}
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${crypto.randomUUID()}.tmp`;
	const handle = await open(temporary, "wx", 0o600);
	try {
		await handle.writeFile(`${JSON.stringify(value)}\n`);
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		await rename(temporary, path);
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
}
