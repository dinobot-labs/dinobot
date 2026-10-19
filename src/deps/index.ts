import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, mkdtemp, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { DependencyArtifact, ExternalDependency, Plugin, PluginHost } from "../plugins/types.ts";
import { APPLICATIONS, installMacosApp, macosAppPaths, macosAppProblems, resolveMacosApp, verifyMacosApp } from "./macos-app.ts";
import { abortReason, run } from "./run.ts";

/**
 * External programs that plugins run as child processes (ADR 0059).
 *
 * Layout: `<root>/<id>/<version>-<platform>/` holds one extracted, verified release archive plus {@link MARKER}. A version
 * directory appears only by an atomic rename of a fully verified staging tree, so a directory with a matching marker
 * is a complete install of exactly the pinned bytes. Resolution never re-downloads and never runs anything.
 * Artifacts with `macosApp` are the exception to the layout: the verified bundle goes to `/Applications` (ADR 0071).
 */
export const MARKER = ".dinobot-dependency.json";
const STAGING = ".staging-";
const STALE_STAGING_MS = 60 * 60 * 1000;
const ID = /^[a-z][a-z0-9-]*$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;
const SHA256 = /^[0-9a-f]{64}$/;

type Marker = { id: string; version: string; platform: string; sha256: string; entry: string; installedAt: string };

/**
 * `$DINOBOT_DEPS_DIR`, else `$XDG_DATA_HOME/dinobot/deps`, else `~/.local/share/dinobot/deps`. Relative values are
 * ignored: `dinobot init` and the daemon may run from different directories and must agree on one root.
 */
export function dependenciesRoot(env: Record<string, string | undefined> = process.env, home = homedir()): string {
	if (env.DINOBOT_DEPS_DIR && isAbsolute(env.DINOBOT_DEPS_DIR)) return env.DINOBOT_DEPS_DIR;
	const data = env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join(home, ".local", "share");
	return join(data, "dinobot", "deps");
}

export function platformKey(platform: string = process.platform, arch: string = process.arch): string {
	return `${platform}-${arch}`;
}

/** Structural checks on a declaration, so a malformed pin fails before any download. */
export function dependencyProblems(dependency: ExternalDependency): string[] {
	const problems: string[] = [];
	if (!ID.test(dependency.id)) problems.push(`dependency id "${dependency.id}" must match ${ID}`);
	if (!VERSION.test(dependency.version)) problems.push(`${dependency.id}: invalid version "${dependency.version}"`);
	for (const [platform, artifact] of Object.entries(dependency.artifacts)) {
		if (!artifact) continue;
		if (!/^https:\/\//.test(artifact.url)) problems.push(`${dependency.id} ${platform}: artifact url must be https`);
		if (!SHA256.test(artifact.sha256)) problems.push(`${dependency.id} ${platform}: sha256 must be 64 lowercase hex digits`);
		if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0) problems.push(`${dependency.id} ${platform}: bytes must be a positive integer`);
		if (!safeRelative(artifact.entry)) problems.push(`${dependency.id} ${platform}: entry must be a relative path inside the archive`);
		if (artifact.macosApp && !safeRelative(artifact.macosApp.bundle)) problems.push(`${dependency.id} ${platform}: macosApp.bundle must be a relative path inside the archive`);
		problems.push(...macosAppProblems(dependency.id, platform, artifact));
	}
	return problems;
}

/** Every dependency declared by catalog plugins, deduplicated by id. Two different pins for one id are an error. */
export function catalogDependencies(catalog: Readonly<Record<string, Plugin>>): { dependency: ExternalDependency; plugins: string[] }[] {
	const byId = new Map<string, { dependency: ExternalDependency; plugins: string[] }>();
	for (const plugin of Object.values(catalog)) {
		for (const dependency of plugin.dependencies ?? []) {
			const existing = byId.get(dependency.id);
			if (!existing) {
				byId.set(dependency.id, { dependency, plugins: [plugin.id] });
				continue;
			}
			if (JSON.stringify(existing.dependency) !== JSON.stringify(dependency)) {
				throw new Error(`dependency "${dependency.id}" is declared differently by plugins ${existing.plugins.join(", ")} and ${plugin.id}`);
			}
			existing.plugins.push(plugin.id);
		}
	}
	return [...byId.values()];
}

export type ResolveOptions = {
	readonly root: string;
	readonly platform: string;
	/** Where `macosApp` bundles live. Default `/Applications`. */
	readonly applications?: string;
};

/**
 * The verified executable of an installed pin, or undefined. Reads only the marker (or, for a macOS app bundle, its
 * `Info.plist`) and the entry's metadata.
 */
export async function resolveInstalled(dependency: ExternalDependency, options: ResolveOptions): Promise<string | undefined> {
	const artifact = dependency.artifacts[options.platform];
	if (!artifact || dependencyProblems(dependency).length > 0) return undefined;
	if (artifact.macosApp) return resolveMacosApp(dependency, { ...artifact, macosApp: artifact.macosApp }, options.applications ?? APPLICATIONS);
	const dir = installDir(options.root, dependency, options.platform);
	let marker: Partial<Marker>;
	try {
		marker = JSON.parse(await readFile(join(dir, MARKER), "utf8")) as Partial<Marker>;
	} catch {
		return undefined;
	}
	if (marker.id !== dependency.id || marker.version !== dependency.version || marker.platform !== options.platform ||
		marker.sha256 !== artifact.sha256 || marker.entry !== artifact.entry) return undefined;
	const executable = join(dir, artifact.entry);
	try {
		if (!(await lstat(executable)).isFile()) return undefined;
		await access(executable, constants.X_OK);
	} catch {
		return undefined;
	}
	return executable;
}

/** Resolves only dependencies the catalog declares, under one root and platform. */
export function dependencyHost(
	catalog: Readonly<Record<string, Plugin>>,
	options: { root?: string; platform?: string; applications?: string } = {},
): PluginHost {
	return {
		resolveDependency: async (id) => {
			const entry = catalogDependencies(catalog).find(({ dependency }) => dependency.id === id);
			if (!entry) return undefined;
			return resolveInstalled(entry.dependency, {
				root: options.root ?? dependenciesRoot(), platform: options.platform ?? platformKey(),
				...(options.applications ? { applications: options.applications } : {}),
			});
		},
	};
}

export type InstallOutcome =
	| { readonly status: "installed" | "present"; readonly path: string }
	| { readonly status: "unsupported"; readonly platform: string }
	| { readonly status: "failed"; readonly error: string };

export type InstallOptions = ResolveOptions & {
	readonly fetch?: typeof fetch;
	readonly signal?: AbortSignal;
	/** Abort a download that receives no bytes for this long. Default 60 s. */
	readonly idleTimeoutMs?: number;
	readonly log?: (line: string) => void;
};

/**
 * Install one pinned dependency. Idempotent: a verified install is reported as `present` without network access.
 * Postcondition on `installed`/`present`: {@link resolveInstalled} returns the same path. On `failed`, no version
 * directory was created or changed, and an existing macOS app bundle was restored.
 */
export async function installDependency(dependency: ExternalDependency, options: InstallOptions): Promise<InstallOutcome> {
	const problems = dependencyProblems(dependency);
	if (problems.length > 0) return { status: "failed", error: problems.join("; ") };
	const artifact = dependency.artifacts[options.platform];
	if (!artifact) return { status: "unsupported", platform: options.platform };
	const present = await resolveInstalled(dependency, options);
	const applications = options.applications ?? APPLICATIONS;
	// A bundle with the pinned version but a foreign or broken signature is replaced, not trusted.
	const verified = present && artifact.macosApp
		? await verifyMacosApp(macosAppPaths({ ...artifact, macosApp: artifact.macosApp }, applications).app, artifact.macosApp, options.signal).then(() => true, () => false)
		: Boolean(present);
	if (present && verified) return { status: "present", path: present };

	const parent = join(options.root, dependency.id);
	const target = installDir(options.root, dependency, options.platform);
	let staging: string | undefined;
	try {
		await mkdir(parent, { recursive: true });
		await removeStaleStaging(parent);
		staging = await mkdtemp(join(parent, STAGING));
		const archive = join(staging, `archive.${artifact.format}`);
		const tree = join(staging, "tree");
		options.log?.(`downloading ${dependency.id} ${dependency.version} (${(artifact.bytes / 1048576).toFixed(1)} MiB)`);
		await download(artifact, archive, options);
		await extract(archive, tree, artifact.format, options.signal);
		const executable = join(tree, artifact.entry);
		const entry = await lstat(executable).catch(() => undefined);
		if (!entry?.isFile()) throw new Error(`archive has no regular file ${artifact.entry}`);
		await chmod(executable, 0o755);
		if (dependency.check) await runCheck(executable, dependency.check, options.signal);
		if (artifact.macosApp) {
			const path = await installMacosApp(join(tree, artifact.macosApp.bundle), { ...artifact, macosApp: artifact.macosApp }, {
				applications, ...(options.signal ? { signal: options.signal } : {}), ...(options.log ? { log: options.log } : {}),
			});
			return { status: "installed", path };
		}
		const marker: Marker = {
			id: dependency.id, version: dependency.version, platform: options.platform,
			sha256: artifact.sha256, entry: artifact.entry, installedAt: new Date().toISOString(),
		};
		await writeFile(join(tree, MARKER), `${JSON.stringify(marker, null, 2)}\n`, { flag: "wx" });
		// Rename first. Only when the target is taken: a verified one won a race, an unverified leftover is removed
		// and the rename retried once. Every interleaving ends with a verified tree at the target.
		try {
			await rename(tree, target);
		} catch {
			const raced = await resolveInstalled(dependency, options);
			if (raced) return { status: "present", path: raced };
			await rm(target, { recursive: true, force: true });
			try {
				await rename(tree, target);
			} catch (error) {
				const late = await resolveInstalled(dependency, options);
				if (late) return { status: "present", path: late };
				throw error;
			}
		}
		await pruneOtherVersions(parent, target, options.platform);
		const installed = await resolveInstalled(dependency, options);
		if (!installed) throw new Error("installed files did not verify");
		return { status: "installed", path: installed };
	} catch (error) {
		return { status: "failed", error: error instanceof Error ? error.message : String(error) };
	} finally {
		if (staging) await rm(staging, { recursive: true, force: true }).catch(() => {});
	}
}

function installDir(root: string, dependency: ExternalDependency, platform: string): string {
	return join(root, dependency.id, `${dependency.version}-${platform}`);
}

function safeRelative(path: string): boolean {
	if (!path || isAbsolute(path) || /^[A-Za-z]:/.test(path) || path.startsWith("/") || path.includes("\\")) return false;
	return path.split("/").every((segment) => segment !== ".." && segment !== "");
}

/** Stream to disk while hashing; reject on the first byte past the pinned size, a short body or a digest mismatch. */
async function download(artifact: DependencyArtifact, file: string, options: InstallOptions): Promise<void> {
	const controller = new AbortController();
	const idleMs = options.idleTimeoutMs ?? 60_000;
	const forward = () => controller.abort(options.signal?.reason ?? new Error("aborted"));
	if (options.signal?.aborted) forward();
	options.signal?.addEventListener("abort", forward, { once: true });
	let timer: ReturnType<typeof setTimeout> | undefined;
	const arm = () => {
		clearTimeout(timer);
		timer = setTimeout(() => controller.abort(new Error(`download stalled for ${idleMs} ms`)), idleMs);
	};
	try {
		arm();
		let response: Response;
		try {
			response = await (options.fetch ?? fetch)(artifact.url, { signal: controller.signal, redirect: "follow" });
		} catch (error) {
			throw controller.signal.aborted ? abortReason(controller.signal) : error;
		}
		if (!response.ok || !response.body) throw new Error(`download failed: HTTP ${response.status}`);
		const hash = createHash("sha256");
		let bytes = 0;
		const handle = await open(file, "wx");
		try {
			const reader = response.body.getReader();
			for (;;) {
				let chunk: Awaited<ReturnType<typeof reader.read>>;
				try {
					chunk = await reader.read();
				} catch (error) {
					throw controller.signal.aborted ? abortReason(controller.signal) : error;
				}
				if (chunk.done) break;
				arm();
				bytes += chunk.value.byteLength;
				if (bytes > artifact.bytes) {
					await reader.cancel().catch(() => {});
					throw new Error(`download exceeds the pinned size of ${artifact.bytes} bytes`);
				}
				hash.update(chunk.value);
				await handle.write(chunk.value);
			}
		} finally {
			await handle.close();
		}
		if (bytes !== artifact.bytes) throw new Error(`download has ${bytes} bytes; the pin requires ${artifact.bytes}`);
		const digest = hash.digest("hex");
		if (digest !== artifact.sha256) throw new Error(`sha256 mismatch: got ${digest}, pinned ${artifact.sha256}`);
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", forward);
	}
}

/** List first and refuse absolute or `..` names, extract, then refuse anything but regular files and directories. */
async function extract(archive: string, tree: string, format: DependencyArtifact["format"], signal?: AbortSignal): Promise<void> {
	// Windows ships ZIP-capable libarchive tar. Git Bash GNU tar cannot read ZIPs
	// and treats drive-letter archive paths as remote hosts.
	const tar = process.platform === "win32" ? join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:/Windows", "System32", "tar.exe") : "tar";
	const compressed = format === "tar.gz" ? "z" : "";
	const listing = await run([tar, `-t${compressed}f`, archive], { timeoutMs: 120_000, ...(signal ? { signal } : {}) });
	if (listing.code !== 0) throw new Error(`cannot list archive: ${listing.stderr.trim().slice(0, 300)}`);
	for (const raw of listing.stdout.split(/\r?\n/)) {
		const name = raw.replace(/\/$/, "").replace(/^\.\//, "");
		if (name === "" || name === ".") continue;
		if (!safeRelative(name)) throw new Error(`archive entry escapes the install directory: ${raw}`);
	}
	// The verbose listing's first column is the member type: only regular files and directories (hard and
	// symbolic links extract as files or links and are refused here, before anything is written).
	const verbose = await run([tar, `-tv${compressed}f`, archive], { timeoutMs: 120_000, ...(signal ? { signal } : {}) });
	if (verbose.code !== 0) throw new Error(`cannot list archive: ${verbose.stderr.trim().slice(0, 300)}`);
	for (const line of verbose.stdout.split(/\r?\n/)) {
		if (line !== "" && line[0] !== "-" && line[0] !== "d") throw new Error(`archive contains a non-regular entry: ${line.slice(0, 200)}`);
	}
	await mkdir(tree);
	const extracted = await run([tar, `-x${compressed}f`, archive, "-C", tree, "--no-same-owner"], { timeoutMs: 300_000, ...(signal ? { signal } : {}) });
	if (extracted.code !== 0) throw new Error(`cannot extract archive: ${extracted.stderr.trim().slice(0, 300)}`);
	const walk = async (dir: string): Promise<void> => {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) await walk(path);
			else if (!entry.isFile()) throw new Error(`archive contains a non-regular entry: ${entry.name}`);
		}
	};
	await walk(tree);
}

async function runCheck(executable: string, check: NonNullable<ExternalDependency["check"]>, signal?: AbortSignal): Promise<void> {
	const env: Record<string, string> = {};
	for (const name of ["PATH", "HOME", "USER", "LANG", "TMPDIR"]) if (process.env[name]) env[name] = process.env[name]!;
	const result = await run([executable, ...check.args], { timeoutMs: 30_000, env: { ...env, ...check.env }, ...(signal ? { signal } : {}) });
	if (result.code !== 0) throw new Error(`smoke check \`${check.args.join(" ")}\` exited ${result.code}: ${result.stderr.trim().slice(0, 300)}`);
	if (!result.stdout.includes(check.expect)) throw new Error(`smoke check \`${check.args.join(" ")}\` did not report ${JSON.stringify(check.expect)}`);
}

/**
 * Remove other verified versions for the same platform; never touches unmarked directories, other platforms'
 * installs (a home shared by machines of different architectures) or staging.
 */
async function pruneOtherVersions(parent: string, keep: string, platform: string): Promise<void> {
	for (const entry of await readdir(parent, { withFileTypes: true })) {
		const dir = join(parent, entry.name);
		if (!entry.isDirectory() || dir === keep || entry.name.startsWith(STAGING)) continue;
		const marker = await readFile(join(dir, MARKER), "utf8").then((text) => JSON.parse(text) as Partial<Marker>, () => undefined);
		if (marker?.platform === platform) await rm(dir, { recursive: true, force: true }).catch(() => {});
	}
}

/** Staging left by an interrupted install (Ctrl-C, crash) older than an hour; younger ones may be a concurrent run. */
async function removeStaleStaging(parent: string, now = Date.now()): Promise<void> {
	for (const entry of await readdir(parent, { withFileTypes: true })) {
		if (!entry.isDirectory() || !entry.name.startsWith(STAGING)) continue;
		const dir = join(parent, entry.name);
		const age = await lstat(dir).then((stat) => now - stat.mtimeMs, () => 0);
		if (age > STALE_STAGING_MS) await rm(dir, { recursive: true, force: true }).catch(() => {});
	}
}
