/** Host artifact selection and the single owner of portable local file installation. */
import { randomUUID } from "node:crypto";
import { accessSync, chmodSync, closeSync, constants, copyFileSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export type LocalArtifacts = Readonly<{ binary: string; natives: readonly string[] }>;

export function localInstallPaths(env: NodeJS.ProcessEnv = process.env, home = homedir()): Readonly<{ bin: string; dist: string }> {
	return Object.freeze({
		bin: resolve(env.DINOBOT_BIN ?? join(home, ".local/bin/dinobot")),
		dist: resolve(env.DINOBOT_DIST_DIR ?? "dist"),
	});
}

/** Exact loader-compatible filenames, never a wildcard over arbitrary .node files. */
export function nativeArtifactNames(platform: string = process.platform, arch: string = process.arch): readonly string[] {
	if ((platform !== "darwin" && platform !== "linux") || (arch !== "x64" && arch !== "arm64")) {
		throw new Error(`Unsupported native host: ${platform}-${arch}`);
	}
	const stem = `pi_natives.${platform}-${arch}`;
	return Object.freeze(arch === "x64" ? [`${stem}-modern.node`, `${stem}-baseline.node`, `${stem}.node`] : [`${stem}.node`]);
}

function readableFile(path: string): void {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.size === 0) throw new Error(`Missing or invalid artifact (expected a nonempty regular file): ${path}`);
	accessSync(path, constants.R_OK);
}

function selectNativeArtifacts(directory: string, platform: string, arch: string): readonly string[] {
	const candidates = nativeArtifactNames(platform, arch);
	const entries = new Set(readdirSync(directory));
	const names = candidates.filter((name) => entries.has(name));
	// A modern-only x64 set cannot serve the loader on baseline CPUs.
	if (names.length === 0 || (arch === "x64" && !names.some((name) => !name.endsWith("-modern.node")))) {
		throw new Error(`Missing native artifacts for ${platform}-${arch} in ${directory} (x64 needs baseline or default)`);
	}
	const files = names.map((name) => join(directory, name));
	for (const file of files) readableFile(file);
	return Object.freeze(files);
}

/** Resolve the installed host leaf package without loading its native code. No destination writes. */
export function discoverNativeArtifacts(root: string = resolve(import.meta.dir, ".."), platform: string = process.platform, arch: string = process.arch): readonly string[] {
	nativeArtifactNames(platform, arch);
	const name = `@oh-my-pi/pi-natives-${platform}-${arch}`;
	const require = createRequire(join(resolve(root), "package.json"));
	let manifest: string;
	try {
		manifest = require.resolve(`${name}/package.json`);
	} catch (cause) {
		throw new Error(`Missing installed native package ${name}; install the host optional dependency first`, { cause });
	}
	return selectNativeArtifacts(dirname(manifest), platform, arch);
}

/** Capture an immutable selection before a reinstall may stop its daemon. No destination writes. */
export function preflightLocalInstall(dist: string, platform: string = process.platform, arch: string = process.arch): LocalArtifacts {
	nativeArtifactNames(platform, arch);
	const directory = resolve(dist);
	const binary = join(directory, "dinobot");
	readableFile(binary);
	return Object.freeze({ binary, natives: selectNativeArtifacts(directory, platform, arch) });
}

/** Same-directory rename replaces the inode, never truncating a live executable or following a target symlink. */
export function atomicInstallFile(source: string, destination: string, mode: number): void {
	readableFile(source);
	mkdirSync(dirname(destination), { recursive: true });
	const temporary = join(dirname(destination), `.${basename(destination)}.${process.pid}.${randomUUID()}.tmp`);
	let owned = false;
	try {
		const fd = openSync(temporary, "wx", 0o600);
		owned = true;
		closeSync(fd);
		copyFileSync(source, temporary);
		chmodSync(temporary, mode);
		renameSync(temporary, destination);
	} finally {
		if (owned) rmSync(temporary, { force: true });
	}
}

/** Recheck the captured sources and binary target before any writes; addons first, binary last. Atomic per file, not per set. */
export function installLocalArtifacts(artifacts: LocalArtifacts, bin: string): void {
	const destination = resolve(bin);
	if (artifacts.natives.some((file) => basename(file) === basename(destination))) {
		throw new Error(`Binary destination collides with a native artifact: ${destination}`);
	}
	for (const file of [...artifacts.natives, artifacts.binary]) readableFile(file);
	const target = lstatSync(destination, { throwIfNoEntry: false });
	if (target && !target.isFile() && !target.isSymbolicLink()) {
		throw new Error(`Invalid binary destination (expected a file, symlink or missing path): ${destination}`);
	}
	for (const file of artifacts.natives) atomicInstallFile(file, join(dirname(destination), basename(file)), 0o644);
	atomicInstallFile(artifacts.binary, destination, 0o755);
}
