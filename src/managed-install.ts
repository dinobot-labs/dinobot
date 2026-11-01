#!/usr/bin/env bun
import { cp, link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { downloadRelease, RELEASE_METADATA_URL, validateReleaseMetadata } from "./release-source.ts";
import { newerManagedVersion, stableManagedVersion } from "./managed-version.ts";

export type ManagedPaths = { root: string; bin: string; shim: string; launcher: string };
export function managedPaths(env = process.env, home = homedir(), platform = process.platform): ManagedPaths {
	const override = env.DINOBOT_INSTALL_DIR;
	if (override !== undefined && !isAbsolute(override)) throw new Error("DINOBOT_INSTALL_DIR must be absolute");
	const root = resolve(override ?? (platform === "win32" ? join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "dinobot") : join(home, ".local", "share", "dinobot")));
	const bin = override || platform === "win32" ? join(root, "bin") : join(home, ".local", "bin");
	return { root, bin, shim: join(bin, platform === "win32" ? "dinobot.cmd" : "dinobot"), launcher: join(root, "install.mjs") };
}
export type ManagedCommand = (argv: string[], options: { cwd: string; env: NodeJS.ProcessEnv; mode: "install" | "smoke" | "launch" }) => Promise<{ code: number; stdout: string }>;
export const managedCommand: ManagedCommand = async (argv, options) => {
	const launch = options.mode === "launch";
	const child = Bun.spawn(argv, { cwd: options.cwd, env: options.env, stdin: launch ? "inherit" : "ignore", stdout: launch ? "inherit" : "pipe", stderr: launch ? "inherit" : "pipe", ...(launch ? {} : { timeout: options.mode === "install" ? 120_000 : 10_000 }) });
	const [stdout, stderr, code] = await Promise.all([launch ? "" : new Response(child.stdout).text(), launch ? "" : new Response(child.stderr).text(), child.exited]);
	if (code !== 0 && !launch) throw new Error("Managed " + options.mode + " failed: " + stderr.slice(-2000));
	return { code, stdout };
};
export type ManagedOptions = {
	paths?: ManagedPaths; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; bun?: string; launcherSource?: string;
	fetch?: typeof fetch; command?: ManagedCommand; checkTimeoutMs?: number; lockTimeoutMs?: number; log?: (message: string) => void;
};
type Active = { version: string; slot: string };
async function active(root: string): Promise<Active | null> {
	try {
		const value = JSON.parse(await readFile(join(root, "active.json"), "utf8"));
		if (!stableManagedVersion(value.version) || typeof value.slot !== "string" || !/^[a-f0-9-]{36}$/.test(value.slot)) throw new Error("Invalid managed active pointer");
		return value;
	} catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
function mainPath(root: string, value: Active): string { return join(root, "versions", value.slot, "node_modules", "dinobot", "main.js"); }
async function exists(path: string): Promise<boolean> {
	try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
function shimText(bun: string, paths: ManagedPaths, platform: NodeJS.Platform): string {
	const { launcher } = paths;
	const allPaths = [bun, launcher, paths.root, paths.bin];
	if (!allPaths.every(isAbsolute) || allPaths.some(path => /[\r\n\0]/.test(path))) throw new Error("Unsafe launcher path");
	if (platform === "win32") {
		if (allPaths.some(path => /["%]/.test(path))) throw new Error("Unsupported Windows launcher path");
		return [
			"@echo off", "setlocal DisableDelayedExpansion",
			'for /f "tokens=2 delims=:" %%C in (\'chcp\') do set "_DINOBOT_CP=%%C"',
			"chcp 65001 >nul",
			'"' + bun + '" "' + launcher + '" --managed-root "' + paths.root + '" --managed-bin "' + paths.bin + '" %*',
			'set "_DINOBOT_EXIT=%errorlevel%"', "chcp %_DINOBOT_CP% >nul", "exit /b %_DINOBOT_EXIT%", "",
		].join("\r\n");
	}
	const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
	return "#!/bin/sh\nexec " + quote(bun) + " " + quote(launcher) + " --managed-root " + quote(paths.root) + " --managed-bin " + quote(paths.bin) + ' "$@"\n';
}
// A complete file becomes visible atomically; hard-link publication refuses existing targets.
async function publishNewFile(path: string, contents: string | Buffer): Promise<void> {
	const temporary = path + "." + crypto.randomUUID() + ".tmp";
	try {
		await writeFile(temporary, contents, { flag: "wx", mode: 0o755 });
		await link(temporary, path);
	} finally { await rm(temporary, { force: true }).catch(() => {}); }
}
async function checkShim(paths: ManagedPaths, expected: string, platform: NodeJS.Platform): Promise<boolean> {
	if (platform === "win32") for (const name of ["dinobot.exe", "dinobot.bunx", "dinobot.bat", "dinobot"]) {
		if (await exists(join(paths.bin, name))) throw new Error("Conflicting launcher: " + join(paths.bin, name));
	}
	if (!await exists(paths.shim)) return false;
	if (!(await lstat(paths.shim)).isFile() || await readFile(paths.shim, "utf8") !== expected) throw new Error("Refusing to overwrite unknown launcher: " + paths.shim);
	return true;
}
async function latest(fetcher: typeof fetch, timeout: number) {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try { return await Promise.race([ (async () => {
		const response = await fetcher(RELEASE_METADATA_URL, { redirect: "error", signal: controller.signal });
		if (!response.ok || response.redirected) throw new Error("Release check failed");
		return validateReleaseMetadata(await response.json(), stableManagedVersion);
	})(), new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("Release check timed out")); }, timeout); }) ]);
	} finally { clearTimeout(timer); }
}
async function lock(root: string, timeout: number): Promise<() => Promise<void>> {
	await mkdir(root, { recursive: true });
	const path = join(root, ".install-lock"); const start = Date.now();
	for (;;) {
		try { await mkdir(path); return () => rm(path, { recursive: true }); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
		if (Date.now() - start >= timeout) throw new Error("Managed install busy (lock retained; never automatically removed)");
		await Bun.sleep(25);
	}
}

/** Only this transaction writes the active pointer. Slots are never rewritten or collected.
 * No daemon API, PID lookup, restart or signal is available at this boundary. */
export async function runManaged(args: string[], options: ManagedOptions = {}): Promise<number> {
	const env = options.env ?? process.env; const platform = options.platform ?? process.platform;
	let paths = options.paths ?? managedPaths(env, homedir(), platform);
	if (args[0] === "--managed-root") {
		const root = args[1]; const bin = args[3];
		if (!root || !bin || args[2] !== "--managed-bin" || !isAbsolute(root) || !isAbsolute(bin)) throw new Error("Invalid managed paths");
		paths = { root, bin, launcher: join(root, "install.mjs"), shim: join(bin, platform === "win32" ? "dinobot.cmd" : "dinobot") };
		args = args.slice(4);
	}
	const bun = options.bun ?? await realpath(process.execPath);
	const command = options.command ?? managedCommand; const fetcher = options.fetch ?? globalThis.fetch;
	const log = options.log ?? console.error;
	const install = args[0] === "--install"; const update = args[0] === "update";
	if (!update && args.includes("update")) throw new Error("Use dinobot update without preceding flags");
	// Never forward update to legacy main.js: it may restart a live daemon.
	if ((install && args.length !== 1) || (update && args.slice(1).some(a => a !== "--no-restart"))) throw new Error("Usage: dinobot update [--no-restart] (managed updates never restart)");
	let selected = await active(paths.root);
	try {
		const release = await latest(fetcher, options.checkTimeoutMs ?? 3000);
		if (install || !selected || newerManagedVersion(selected.version, release.version)) {
			const unlock = await lock(paths.root, options.lockTimeoutMs ?? 1000);
			let temp: string | undefined; let staging: string | undefined; let pointerTemp: string | undefined;
			const created: string[] = [];
			try {
				selected = await active(paths.root);
				const expectedShim = shimText(bun, paths, platform);
				const hasShim = await checkShim(paths, expectedShim, platform);
				const hasLauncher = await exists(paths.launcher);
				if (hasLauncher && (!selected || !(await lstat(paths.launcher)).isFile())) throw new Error("Unknown managed launcher: " + paths.launcher);
				let next = selected;
				if (!selected || newerManagedVersion(selected.version, release.version)) {
					const bytes = await downloadRelease(release, fetcher);
					temp = await mkdtemp(join(tmpdir(), "dinobot-managed-"));
					const archive = join(temp, "release.tgz");
					await writeFile(archive, bytes);
					await writeFile(join(temp, "package.json"), JSON.stringify({ name: "dinobot-managed-slot", private: true, dependencies: { dinobot: "file:./release.tgz" } }));
					const isolatedEnv = { ...env, HOME: temp, USERPROFILE: temp, XDG_CONFIG_HOME: temp, BUN_INSTALL: join(temp, ".bun"), BUN_INSTALL_CACHE_DIR: join(temp, ".cache"), BUN_INSTALL_GLOBAL_DIR: join(temp, ".global"), BUN_INSTALL_BIN: join(temp, ".bin"), DINOBOT_NO_UPDATE_CHECK: "1" };
					const result = await command([bun, "install", "--ignore-scripts", "--no-progress"], { cwd: temp, env: isolatedEnv, mode: "install" });
					if (result.code !== 0) throw new Error("Managed package installation failed");
					const packageDir = join(temp, "node_modules", "dinobot");
					const pkg = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
					const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.dinobot;
					const main = join(packageDir, "main.js");
					if (pkg.name !== "dinobot" || pkg.version !== release.version || typeof bin !== "string" || resolve(packageDir, bin) !== main || !(await lstat(main)).isFile()) throw new Error("Installed package identity mismatch");
					for (const flag of ["--version", "--help"]) {
						const probe = await command([bun, main, flag], { cwd: temp, env: isolatedEnv, mode: "smoke" });
						if (probe.code !== 0 || (flag === "--version" ? probe.stdout.trim() !== release.version : !probe.stdout.trim())) throw new Error("Installed package smoke failed: " + flag);
					}
					const slot = crypto.randomUUID();
					await mkdir(join(paths.root, "versions"), { recursive: true });
					staging = join(paths.root, ".staging-" + slot);
					// Same-volume final rename; OS temp may live on a different disk.
					await mkdir(staging);
					try {
						// Move the complete dependency tree on the same volume instead of opening
						// every installed file again (also preserves relative package links).
						await rename(join(temp, "node_modules"), join(staging, "node_modules"));
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
						await cp(join(temp, "node_modules"), join(staging, "node_modules"), { recursive: true, dereference: true });
					}
					await cp(join(temp, "package.json"), join(staging, "package.json"));
					await rename(staging, join(paths.root, "versions", slot)); staging = undefined;
					next = { version: release.version, slot };
				}
				if (!hasLauncher) {
					await publishNewFile(paths.launcher, await readFile(options.launcherSource ?? Bun.main)); created.push(paths.launcher);
				}
				if (!hasShim) {
					await mkdir(paths.bin, { recursive: true });
					await publishNewFile(paths.shim, expectedShim); created.push(paths.shim);
				}
				if (next !== selected) {
					pointerTemp = join(paths.root, ".active-" + crypto.randomUUID());
					await writeFile(pointerTemp, JSON.stringify(next), { flag: "wx" });
					await rename(pointerTemp, join(paths.root, "active.json")); pointerTemp = undefined;
				}
				selected = next; created.length = 0;
			} finally {
				for (const path of [...created, temp, staging, pointerTemp]) if (path) await rm(path, { recursive: true, force: true }).catch(() => {});
				await unlock();
			}
		}
	} catch (error) {
		if (install || update || !selected) throw error;
		// A known installed version remains usable offline, after contention or failed upgrades.
	}
	if (!selected) throw new Error("No managed version installed");
	if (install || update) { log("dinobot " + selected.version + " ready; running daemons unchanged. Bin: " + paths.bin); return 0; }
	return (await command([bun, mainPath(paths.root, selected), ...args], { cwd: process.cwd(), env, mode: "launch" })).code;
}
if (import.meta.main) {
	try { process.exitCode = await runManaged(process.argv.slice(2)); }
	catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
