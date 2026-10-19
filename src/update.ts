import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import packageJson from "../package.json" with { type: "json" };
import { daemonRestartDependencies, restartDaemonAfterUpdate } from "./cli/update-restart.ts";

export const CURRENT_VERSION = packageJson.version;
export type UpdateInfo = { current: string; latest: string };
export type CheckForUpdateOptions = {
	signal?: AbortSignal;
	cachePath?: string;
	fetch?: typeof fetch;
	now?: () => number;
	currentVersion?: string;
	force?: boolean;
};

const REGISTRY = "https://registry.npmjs.org/dinobot/latest";
const TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const numeric = "(?:0|[1-9][0-9]*)";
const prerelease = "(?:" + numeric + "|[0-9]*[A-Za-z-][0-9A-Za-z-]*)";
const semver = new RegExp("^(" + numeric + ")\\.(" + numeric + ")\\.(" + numeric + ")(?:-(" + prerelease + "(?:\\." + prerelease + ")*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$");

function parseVersion(value: unknown): RegExpExecArray | null {
	if (typeof value !== "string") return null;
	const match = semver.exec(value);
	// JS $ also matches before a final newline; SemVer does not.
	return match?.[0] === value ? match : null;
}

function stableVersion(value: unknown): value is string {
	const parsed = parseVersion(value);
	return parsed !== null && parsed[4] === undefined;
}

/** Only stable targets are eligible. Build metadata never changes precedence. */
export function isNewerStableVersion(current: string, latest: string): boolean {
	const a = parseVersion(current);
	const b = parseVersion(latest);
	if (!a || !b || b[4] !== undefined) return false;
	for (let i = 1; i <= 3; i++) {
		const left = a[i]!;
		const right = b[i]!;
		// Compare decimal strings, without rounding large SemVer components.
		if (left !== right) return left.length !== right.length ? right.length > left.length : right > left;
	}
	return a[4] !== undefined;
}

export function defaultUpdateCachePath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
	const base = env.XDG_CACHE_HOME;
	return join(base && isAbsolute(base) ? base : join(home, ".cache"), "dinobot", "update.json");
}

/** Throws internally so the explicit command can distinguish a failed check from "current". */
async function fetchLatest(fetcher: typeof fetch, signal?: AbortSignal): Promise<string> {
	const controller = new AbortController();
	const abort = () => controller.abort();
	let rejectAbort!: (error: Error) => void;
	const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
	const onAbort = () => rejectAbort(new Error("Update check cancelled or timed out"));
	controller.signal.addEventListener("abort", onAbort, { once: true });
	signal?.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(abort, TIMEOUT_MS);
	try {
		if (signal?.aborted) throw new Error("Update check cancelled");
		// Race the entire operation, including body consumption. Even a fetch implementation
		// that ignores AbortSignal must not keep the TUI waiting indefinitely.
		return await Promise.race([aborted, (async () => {
			const response = await fetcher(REGISTRY, { signal: controller.signal, redirect: "error", headers: { accept: "application/json" } });
			if (!response.ok || response.redirected) throw new Error("Registry request failed");
			const metadata: unknown = await response.json();
			if (!metadata || typeof metadata !== "object" || !("name" in metadata) || metadata.name !== "dinobot"
				|| !("version" in metadata) || !stableVersion(metadata.version)) throw new Error("Invalid registry metadata");
			return metadata.version;
		})()]);
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
		controller.signal.removeEventListener("abort", onAbort);
	}
}

async function cachedLatest(path: string, now: number): Promise<string | null> {
	try {
		const cache = JSON.parse(await readFile(path, "utf8"));
		if (cache?.schemaVersion === 1 && stableVersion(cache.latest)
			&& Number.isSafeInteger(cache.checkedAt) && cache.checkedAt >= 0 && cache.checkedAt <= now
			&& now - cache.checkedAt < CACHE_TTL_MS) return cache.latest;
	} catch { /* Cache reads are always optional. */ }
	return null;
}

async function cacheLatest(path: string, latest: string, checkedAt: number): Promise<void> {
	const temporary = path + "." + crypto.randomUUID() + ".tmp";
	try {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(temporary, JSON.stringify({ schemaVersion: 1, latest, checkedAt }), { flag: "wx", mode: 0o600 });
		await rename(temporary, path);
	} catch { /* Read-only homes, concurrent writers and full disks must not affect startup. */ }
	finally { await rm(temporary, { force: true }).catch(() => {}); }
}

/** Passive startup check: silent, cached and best effort; never rejects. Force only bypasses the cache. */
export async function checkForUpdate(options: CheckForUpdateOptions = {}): Promise<UpdateInfo | null> {
	try {
		if (process.env.DINOBOT_NO_UPDATE_CHECK === "1" || options.signal?.aborted) return null;
		const current = options.currentVersion ?? CURRENT_VERSION;
		if (!parseVersion(current)) return null;
		const now = (options.now ?? Date.now)();
		if (!Number.isSafeInteger(now) || now < 0) return null;
		const path = options.cachePath ?? defaultUpdateCachePath();
		let latest = options.force ? null : await cachedLatest(path, now);
		if (options.signal?.aborted) return null;
		if (latest === null) {
			latest = await fetchLatest(options.fetch ?? globalThis.fetch, options.signal);
			if (options.signal?.aborted) return null;
			await cacheLatest(path, latest, now);
		}
		return !options.signal?.aborted && isNewerStableVersion(current, latest) ? { current, latest } : null;
	} catch { return null; }
}

export type UpdateCommand = (argv: string[], options: { stdio: "pipe" | "inherit"; cwd: string }) => Promise<{ exitCode: number; stdout: string }>;
export type InstallDependencies = {
	main: string;
	env: NodeJS.ProcessEnv;
	home: string;
	realpath: (path: string) => Promise<string>;
	readFile: (path: string) => Promise<string>;
	command: UpdateCommand;
};

/** Shell-free subprocess adapter; probes are bounded and installs inherit all stdio. */
export const runUpdateCommand: UpdateCommand = async (argv, options) => {
	const child = Bun.spawn(argv, {
		cwd: options.cwd,
		stdin: options.stdio === "inherit" ? "inherit" : "ignore",
		stdout: options.stdio,
		stderr: options.stdio === "inherit" ? "inherit" : "ignore",
		...(options.stdio === "pipe" ? { timeout: TIMEOUT_MS, killSignal: "SIGKILL" as const } : {}),
	});
	const stdout = child.stdout ? await new Response(child.stdout).text() : "";
	return { exitCode: await child.exited, stdout };
};

function installDependencies(): InstallDependencies {
	return { main: Bun.main, env: process.env, home: homedir(), realpath, readFile: (path) => readFile(path, "utf8"), command: runUpdateCommand };
}

function absoluteOutput(value: string): string | null {
	const path = value.trim();
	return isAbsolute(path) && !/[\r\n\0]/.test(path) ? path : null;
}

/** Do not infer a destination when Bun config can override it or make an install a no-op.
 * Bun has no machine-readable effective globalDir query; keep custom config workflows manual. */
async function safeBunConfig(deps: InstallDependencies, globalDir: string): Promise<boolean> {
	const configs = new Set([join(deps.home, ".bunfig.toml"), join(deps.home, "bunfig.toml"), join(globalDir, "bunfig.toml")]);
	if (deps.env.XDG_CONFIG_HOME) configs.add(resolve(deps.home, deps.env.XDG_CONFIG_HOME, ".bunfig.toml"));
	for (const path of configs) {
		let contents: string;
		try { contents = await deps.readFile(path); } catch (error) {
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue;
			return false;
		}
		try {
			const config = Bun.TOML.parse(contents);
			const install = "install" in config ? config.install : undefined;
			if (install && typeof install === "object" && ("globalDir" in install || "dryRun" in install && install.dryRun === true)) return false;
		} catch { return false; }
	}
	return true;
}

/** Conservative ownership proof, not a runtime/PATH heuristic. Linked source packages are refused. */
export async function detectUpdateManager(overrides: Partial<InstallDependencies> = {}): Promise<"bun" | "npm" | null> {
	const deps = { ...installDependencies(), ...overrides };
	try {
		const main = await deps.realpath(deps.main);
		if (!isAbsolute(main) || !main.endsWith("/main.js") && !main.endsWith("\\main.js")) return null;
		const matchesRoot = async (root: string): Promise<boolean> => {
			const canonicalRoot = await deps.realpath(root);
			const packageDir = join(canonicalRoot, "dinobot");
			if (main !== join(packageDir, "main.js")) return false;
			const pkg = JSON.parse(await deps.readFile(join(packageDir, "package.json")));
			const bin = typeof pkg?.bin === "string" ? pkg.bin : pkg?.bin?.dinobot;
			return pkg?.name === "dinobot" && typeof bin === "string" && resolve(packageDir, bin) === main;
		};
		const probe = async (manager: "bun" | "npm"): Promise<boolean> => {
			try {
				const result = await deps.command(manager === "bun" ? ["bun", "pm", "bin", "-g"] : ["npm", "root", "-g"], { stdio: "pipe", cwd: deps.home });
				const path = absoluteOutput(result.stdout);
				if (result.exitCode !== 0 || path === null) return false;
				if (manager === "npm") return await matchesRoot(path);
				// Bun's own order: $BUN_INSTALL, else $XDG_CACHE_HOME/.bun, else ~/.bun (a bunfig globalDir is refused below).
				const install = deps.env.BUN_INSTALL || join(deps.env.XDG_CACHE_HOME || deps.home, ".bun");
				const globalDir = deps.env.BUN_INSTALL_GLOBAL_DIR || join(install, "install", "global");
				return isAbsolute(globalDir) && await safeBunConfig(deps, globalDir) && await matchesRoot(join(globalDir, "node_modules"))
					&& await deps.realpath(join(path, "dinobot")) === main;
			} catch { return false; }
		};
		const [bun, npm] = await Promise.all([probe("bun"), probe("npm")]);
		return bun === npm ? null : bun ? "bun" : "npm";
	} catch { return null; }
}

export type RunUpdateDependencies = InstallDependencies & {
	fetch: typeof fetch;
	currentVersion: string;
	log: (message: string) => void;
	error: (message: string) => void;
	/** Restart the running daemon onto `target` (src/cli/update-restart.ts); absent: only print guidance. */
	restartDaemon?: (target: string) => Promise<number>;
};

/** Runs after the update outcome is known; a throwing restarter is a failed restart, not a failed update. */
async function restartAfter(deps: RunUpdateDependencies, target: string): Promise<number> {
	try { return await deps.restartDaemon!(target); } catch (error) {
		deps.error("Daemon restart failed: " + (error instanceof Error ? error.message : String(error)));
		return 1;
	}
}

/** Dependency seam for behavioral tests; the CLI uses runUpdate() with no overrides. */
export async function runUpdateWithDependencies(overrides: Partial<RunUpdateDependencies> = {}): Promise<number> {
	const deps = { ...installDependencies(), fetch: globalThis.fetch, currentVersion: CURRENT_VERSION, log: console.log, error: console.error, ...overrides };
	try {
		deps.log("Checking for dinobot updates (current " + deps.currentVersion + ")...");
		if (!parseVersion(deps.currentVersion)) throw new Error("Invalid current version");
		// Never use passive cache or DINOBOT_NO_UPDATE_CHECK for an explicit update.
		const latest = await fetchLatest(deps.fetch);
		if (!isNewerStableVersion(deps.currentVersion, latest)) {
			deps.log("dinobot " + deps.currentVersion + " is current (latest stable: " + latest + "); no downgrade performed.");
			// A daemon left on an older version by an earlier update is restarted too, but only from a verified global install:
			// a source checkout's version says nothing about what the daemon would restart into.
			if (deps.restartDaemon && await detectUpdateManager(deps)) return await restartAfter(deps, deps.currentVersion);
			return 0;
		}
		const manager = await detectUpdateManager(deps);
		if (!manager) {
			deps.error("Cannot safely update: this is not a verified Bun or npm global installation (or ownership is ambiguous). Source, local, temporary bunx/npx and compiled installs must use their original install/build workflow.");
			deps.error("Bun configs with globalDir/dryRun overrides or unreadable settings require manual updating. For an existing global install, use its owning manager: bun add -g dinobot@" + latest + " OR npm install -g dinobot@" + latest + ". Do not create a second installation that shadows this one.");
			return 1;
		}
		const argv = manager === "bun" ? ["bun", "add", "-g", "dinobot@" + latest] : ["npm", "install", "-g", "dinobot@" + latest];
		deps.log("Updating dinobot " + deps.currentVersion + " → " + latest + " with " + manager + "...");
		const result = await deps.command(argv, { stdio: "inherit", cwd: deps.home });
		if (result.exitCode !== 0) {
			deps.error("dinobot update failed (" + manager + " exit " + result.exitCode + "). Check permissions and the manager output; no sudo was attempted.");
			return result.exitCode > 0 ? result.exitCode : 1;
		}
		// A manager can exit zero for a configured dry run; verify the installed artifact too.
		const installed = JSON.parse(await deps.readFile(join(dirname(await deps.realpath(deps.main)), "package.json")));
		if (installed?.name !== "dinobot" || installed.version !== latest) {
			deps.error("The package manager exited successfully, but this installation is not at " + latest + ". Check dry-run settings and the installation path.");
			return 1;
		}
		deps.log("Updated to dinobot " + latest + ". Reopen the TUI to use the new version.");
		if (deps.restartDaemon) return await restartAfter(deps, latest);
		deps.log("Separately restart any running daemon when it is idle. No daemon or service was stopped or restarted.");
		return 0;
	} catch {
		deps.error("dinobot update failed: could not check the registry or run the package manager. Check your network, installation and permissions, then retry.");
		return 1;
	}
}

export function runUpdate(options: { restart?: boolean; config?: string } = {}): Promise<number> {
	const restart = options.restart ?? true;
	return runUpdateWithDependencies(restart ? { restartDaemon: (target) => restartDaemonAfterUpdate(target, daemonRestartDependencies(options.config)) } : {});
}
