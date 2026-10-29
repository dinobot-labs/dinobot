import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { lstat, open, readdir, readFile, stat, statfs } from "node:fs/promises";
import os from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { Value } from "typebox/value";
import { readPrivateFile } from "../telegram-private-files/index.ts";
import { DEFAULT_REPORT_URL } from "./consent.ts";
import { redactValue, type RedactionCounts } from "./redact.ts";

/** The ingest endpoint: `DINOBOT_REPORT_URL` points tests at another one. */
export const reportUrl = () => process.env.DINOBOT_REPORT_URL || DEFAULT_REPORT_URL;

/**
 * Diagnostic sections of a problem report (ADR 0103). Used by the daemon (`/report`, POST /v1/report) and by the offline
 * `dinobot report send`, so a report reaches the developer even when the daemon cannot start.
 *
 * Invariants:
 *   D1  every section is collected independently under its own timeout; a failing or slow section yields
 *       `{section, error}` and never aborts the others;
 *   D2  nothing secret leaves: configuration values under secret-looking keys are masked, environment variable values are
 *       never read (names and presence only), file contents are never read except the dinobot log tails, and every string
 *       passes the home/user/host anonymiser and then {@link redactValue};
 *   D3  bounded: logs ≤ ~4 MiB, inventory ≤ 1000 entries at depth ≤ 3, context ≤ 1 MiB, every entry line ≤ LINE_CHARS.
 */

export const REPORT_TRIGGERS = ["button", "cli", "setup-failed", "daemon-down", "daemon-start-failed", "crash"] as const;
export type ReportTrigger = (typeof REPORT_TRIGGERS)[number];
export const REPORT_CLIENTS = ["cli", "tui", "desktop"] as const;
export type ReportClient = (typeof REPORT_CLIENTS)[number];
export type ReportMode = "daemon" | "offline";

export type DiagnosticResult = { readonly section: string; readonly data?: unknown; readonly error?: string; readonly ms: number };

export type DiagnosticsOptions = {
	/** The manifest the report is about (resolved path); missing or unreadable is reported, not fatal. */
	readonly manifestPath?: string;
	/** Data directory override (the daemon's parsed manifest); otherwise read from the manifest, then the default. */
	readonly dataDir?: string;
	readonly mode: ReportMode;
	readonly client: ReportClient;
	readonly trigger: string;
	readonly version: string;
	readonly reportUrl: string;
	/** Client-supplied context (desktop app state, TUI setup outcome). */
	readonly context?: unknown;
	/** Daemon mode: live process state. */
	readonly live?: () => Promise<unknown>;
	/** Daemon mode: live channel state by channel name. */
	readonly liveChannels?: () => Promise<unknown>;
	readonly fetch?: typeof fetch;
	readonly sectionTimeoutMs?: number;
	readonly networkTimeoutMs?: number;
	readonly now?: () => Date;
	/** Test seams for the anonymiser. */
	readonly identity?: Partial<Identity>;
};

export type Identity = { readonly home: string; readonly user: string; readonly host: string };

const MiB = 1024 * 1024;
export const LIMITS = {
	mainLogBytes: MiB,
	mainLogLines: 5000,
	otherLogBytes: 256 * 1024,
	totalLogBytes: 4 * MiB,
	inventoryEntries: 1000,
	inventoryDepth: 3,
	contextChars: MiB,
	/** Entry lines stay below the ingest limit of 512 KiB per line. */
	lineChars: 400_000,
} as const;

// ---- anonymiser ---------------------------------------------------------------------------------

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function identityOf(overrides: Partial<Identity> = {}): Identity {
	let user = "";
	try {
		user = os.userInfo().username;
	} catch {
		user = process.env.USER ?? process.env.USERNAME ?? "";
	}
	return { home: overrides.home ?? os.homedir(), user: overrides.user ?? user, host: overrides.host ?? os.hostname() };
}

/**
 * Replace the home directory with `~`, the OS user name with `<user>` and the host name with `<host>`. Home paths are
 * matched in native, forward-slash and JSON-escaped (doubled backslash) spellings, case-insensitively on Windows.
 */
export function createAnonymizer(overrides: Partial<Identity> = {}): (text: string) => string {
	const { home, user, host } = identityOf(overrides);
	const rules: Array<[RegExp, string]> = [];
	const homes = new Set<string>();
	const trimmedHome = home.replace(/[\\/]+$/, "");
	if (trimmedHome.length > 1) {
		homes.add(trimmedHome);
		homes.add(trimmedHome.replace(/\\/g, "/"));
		homes.add(trimmedHome.replace(/\\/g, "\\\\"));
		homes.add(trimmedHome.replace(/\//g, "\\"));
	}
	const flags = process.platform === "win32" || process.platform === "darwin" ? "gi" : "g";
	// Longest first so the doubled spelling is not half-replaced by the single one.
	for (const spelling of [...homes].sort((a, b) => b.length - a.length)) rules.push([new RegExp(`${escapeRegExp(spelling)}(?![\\p{L}\\p{N}_.-])`, `${flags}u`), "~"]);
	const word = (name: string) => new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(name)}(?![\\p{L}\\p{N}_])`, "giu");
	if (user.length >= 2) rules.push([word(user), "<user>"]);
	const shortHost = host.split(".")[0] ?? "";
	if (host.length >= 3) rules.push([word(host), "<host>"]);
	if (shortHost.length >= 3 && shortHost !== host) rules.push([word(shortHost), "<host>"]);
	return (text) => {
		let out = text;
		for (const [pattern, replacement] of rules) out = out.replace(pattern, replacement);
		return out;
	};
}

/** Anonymise, then redact secrets and personal data, every key and string of a JSON-like value. */
export function scrub(value: unknown, anonymize: (text: string) => string, counts: RedactionCounts = {}): unknown {
	const walk = (item: unknown): unknown => {
		if (typeof item === "string") return anonymize(item);
		if (Array.isArray(item)) return item.map(walk);
		if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([k, v]) => [anonymize(k), walk(v)]));
		return item;
	};
	return redactValue(walk(value), counts);
}

// ---- helpers ------------------------------------------------------------------------------------

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 2000);
const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const octal = (mode: number) => `0${(mode & 0o777).toString(8).padStart(3, "0")}`;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

async function withTimeout<T>(ms: number, fn: () => Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([fn(), new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms)))]);
	} finally {
		clearTimeout(timer);
	}
}

/** Run a short command with a deadline; undefined when it is missing, fails or is slow. */
async function commandOutput(argv: string[], cwd?: string, ms = 2000): Promise<string | undefined> {
	try {
		const child = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore", stdin: "ignore", ...(cwd ? { cwd } : {}) });
		const timer = setTimeout(() => child.kill(), ms);
		const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
		clearTimeout(timer);
		return code === 0 ? text.trim() : undefined;
	} catch {
		return undefined;
	}
}

export function pidAlive(pid: number): boolean {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export type FileFacts = {
	exists: boolean;
	type?: "file" | "directory" | "symlink" | "other";
	size?: number;
	mtime?: string;
	/** POSIX permission bits, octal. */
	mode?: string;
	ownedByUser?: boolean;
	/** Passes the private-file rule the Telegram channel enforces (POSIX 0600 + owner, or a private Windows ACL). */
	private?: boolean;
	error?: string;
};

/** Metadata of a path; never its content (the private check reads at most 64 KiB and discards it). */
export async function fileFacts(path: string, options: { privateCheck?: boolean } = {}): Promise<FileFacts> {
	try {
		const link = await lstat(path);
		const target = link.isSymbolicLink() ? await stat(path).catch(() => undefined) : link;
		const facts: FileFacts = {
			exists: true,
			type: link.isSymbolicLink() ? "symlink" : link.isFile() ? "file" : link.isDirectory() ? "directory" : "other",
			size: (target ?? link).size,
			mtime: (target ?? link).mtime.toISOString(),
			...(process.platform === "win32" ? {} : { mode: octal((target ?? link).mode) }),
			...(process.getuid ? { ownedByUser: (target ?? link).uid === process.getuid() } : {}),
		};
		if (options.privateCheck && facts.type === "file") {
			try {
				readPrivateFile(path, 65536);
				facts.private = true;
			} catch {
				facts.private = false;
			}
		}
		return facts;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code === "ENOENT" || code === "ENOTDIR" ? { exists: false } : { exists: false, error: code ?? errorText(error) };
	}
}

/** The last `bytes` of a file (cut to whole lines) and at most `lines` lines. */
async function tail(path: string, bytes: number, lines: number): Promise<{ text: string; size: number; mtime: string; truncated: boolean }> {
	const handle = await open(path, "r");
	try {
		const info = await handle.stat();
		const start = Math.max(0, info.size - bytes);
		const buffer = Buffer.alloc(info.size - start);
		await handle.read(buffer, 0, buffer.length, start);
		let text = buffer.toString("utf8");
		let truncated = start > 0;
		if (start > 0) text = text.slice(text.indexOf("\n") + 1);
		const split = text.split("\n");
		if (split.length > lines + 1) {
			text = split.slice(-lines - 1).join("\n");
			truncated = true;
		}
		return { text, size: info.size, mtime: info.mtime.toISOString(), truncated };
	} finally {
		await handle.close();
	}
}

/** Where the daemon would keep its data without a readable manifest. */
export const defaultDataDir = () => join(os.homedir(), ".local", "share", "dinobot");

export type ManifestRead = { path?: string; text?: string; raw?: Record<string, unknown>; error?: string; dataDir: string; port?: number };

/** Read and YAML-parse a manifest without validating it, so a broken configuration can still be reported. */
export function readManifestLoose(path: string | undefined, dataDirOverride?: string): ManifestRead {
	const result: ManifestRead = { ...(path ? { path } : {}), dataDir: resolve(dataDirOverride ?? defaultDataDir()) };
	if (!path) return { ...result, error: "no manifest found" };
	try {
		result.text = readFileSync(path, "utf8");
	} catch (error) {
		return { ...result, error: `cannot read: ${(error as NodeJS.ErrnoException).code ?? errorText(error)}` };
	}
	try {
		const raw = Bun.YAML.parse(result.text) as unknown;
		if (!isRecord(raw)) return { ...result, error: "manifest is not a mapping" };
		result.raw = raw;
	} catch (error) {
		return { ...result, error: `YAML: ${errorText(error)}` };
	}
	const bot = isRecord(result.raw.bot) ? result.raw.bot : {};
	if (!dataDirOverride && typeof bot.dataDir === "string" && bot.dataDir) result.dataDir = resolve(bot.dataDir.replace(/^~(?=$|[\\/])/, os.homedir()));
	const api = isRecord(result.raw.api) ? result.raw.api : {};
	if (Number.isSafeInteger(api.port)) result.port = api.port as number;
	return result;
}

// ---- configuration tree -------------------------------------------------------------------------

const SECRET_KEY = /token|secret|key|password|passwd|credential|cookie|auth|apikey/i;
/** Secret-looking names whose value is a reference (a file path, an environment variable name), not the secret. */
const REFERENCE_KEY = /(?:File|Path|Dir|Env|EnvVar|Var|Name|Header)$/;
const looksLikePath = (value: string) => value.length < 1024 && (isAbsolute(value) || /^(?:~|\.{1,2})(?:[\\/]|$)/.test(value));
const expandPath = (value: string, base: string) => resolve(base, value.replace(/^~(?=$|[\\/])/, os.homedir()));

type Masked = { tree: unknown; paths: Array<{ at: string; path: string }>; envNames: Array<{ at: string; name: string }> };

/** The manifest tree with secret values masked; collects path-looking strings and referenced environment variable names. */
export function maskTree(value: unknown, at = ""): Masked {
	const paths: Masked["paths"] = [];
	const envNames: Masked["envNames"] = [];
	const walk = (item: unknown, pointer: string, key: string): unknown => {
		if (typeof item === "string") {
			if (key && SECRET_KEY.test(key) && !REFERENCE_KEY.test(key)) return `[masked ${item.length} chars]`;
			if (/Env(?:Var)?$/.test(key) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(item)) envNames.push({ at: pointer, name: item });
			if (looksLikePath(item)) paths.push({ at: pointer, path: item });
			return item;
		}
		// Numbers and booleans are settings (maxTokens, ports, ids), never credentials.
		if (typeof item === "number" || typeof item === "boolean" || item === null) return item;
		if (Array.isArray(item)) return item.map((v, i) => walk(v, `${pointer}/${i}`, key));
		if (isRecord(item)) return Object.fromEntries(Object.entries(item).map(([k, v]) => [k, walk(v, `${pointer}/${k}`, k)]));
		return String(item);
	};
	return { tree: walk(value, at, ""), paths, envNames };
}

/** Shape problems the daemon would report at boot, without constructing channels or loading plugins. */
async function validationProblems(raw: unknown): Promise<string[]> {
	const { ManifestShape } = await import("../manifest.ts");
	const { channelCatalog } = await import("../channels/index.ts");
	const { pluginCatalog } = await import("../plugins/index.ts");
	const problems: string[] = [];
	if (!Value.Check(ManifestShape, raw)) for (const error of Value.Errors(ManifestShape, raw)) problems.push(`${error.instancePath || "/"}: ${error.message}`);
	if (isRecord(raw) && isRecord(raw.channels)) {
		for (const [key, config] of Object.entries(raw.channels)) {
			const definition = channelCatalog[key];
			if (!definition) problems.push(`channels.${key}: unknown channel`);
			else if (!Value.Check(definition.config, config)) for (const error of Value.Errors(definition.config, config)) problems.push(`channels.${key}${error.instancePath}: ${error.message}`);
		}
	}
	if (isRecord(raw) && isRecord(raw.plugins)) for (const id of Object.keys(raw.plugins)) if (!Object.hasOwn(pluginCatalog, id)) problems.push(`plugins.${id}: unknown plugin`);
	return problems.slice(0, 100);
}

// ---- sections -----------------------------------------------------------------------------------

async function systemSection(dataDir: string): Promise<unknown> {
	const cpus = os.cpus();
	const intl = Intl.DateTimeFormat().resolvedOptions();
	let disk: unknown;
	try {
		const target = existsSync(dataDir) ? dataDir : os.homedir();
		const fsStat = await statfs(target);
		disk = { of: existsSync(dataDir) ? "dataDir" : "home", freeBytes: fsStat.bavail * fsStat.bsize, totalBytes: fsStat.blocks * fsStat.bsize };
	} catch (error) {
		disk = { error: errorText(error) };
	}
	const procVersion = process.platform === "linux" ? await readFile("/proc/version", "utf8").catch(() => "") : "";
	return {
		platform: process.platform,
		release: os.release(),
		version: os.version?.(),
		...(process.platform === "darwin" ? { macos: await commandOutput(["sw_vers", "-productVersion"]) } : {}),
		arch: process.arch,
		machine: os.machine?.(),
		cpu: { model: cpus[0]?.model.trim(), count: cpus.length },
		memory: { totalBytes: os.totalmem(), freeBytes: os.freemem() },
		loadavg: os.loadavg(),
		uptimeSeconds: Math.round(os.uptime()),
		locale: intl.locale,
		timeZone: intl.timeZone,
		lang: process.env.LANG ?? process.env.LC_ALL,
		wsl: /microsoft/i.test(procVersion) || process.env.WSL_DISTRO_NAME !== undefined,
		container: existsSync("/.dockerenv") || existsSync("/run/.containerenv"),
		disk,
	};
}

const PROXY_VARS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"];

const compiledBinary = () => Bun.main.startsWith("/$bunfs/") || /^[A-Z]:[\\/]~BUN[\\/]/i.test(Bun.main);

function runtimeSection(): unknown {
	const shell = process.env.SHELL ?? process.env.ComSpec;
	return {
		bun: { version: Bun.version, revision: Bun.revision },
		versions: process.versions,
		execPath: process.execPath,
		main: Bun.main,
		compiled: compiledBinary(),
		argv: process.argv.slice(2),
		pid: process.pid,
		uptimeSeconds: Math.round(process.uptime()),
		memory: process.memoryUsage(),
		cwd: process.cwd(),
		envNames: Object.keys(process.env).sort(),
		proxy: Object.fromEntries(PROXY_VARS.filter((name) => process.env[name] !== undefined).map((name) => [name, true])),
		path: (process.env.PATH ?? process.env.Path ?? "").split(delimiter).filter(Boolean),
		term: process.env.TERM,
		termProgram: process.env.TERM_PROGRAM,
		shell: shell ? shell.split(/[\\/]/).pop() : undefined,
		stdin: { tty: process.stdin.isTTY === true },
	};
}

async function installSection(version: string): Promise<unknown> {
	const packageRoot = resolve(import.meta.dir, "..", "..");
	const main = compiledBinary() ? process.execPath : Bun.main;
	const normalized = main.replace(/\\/g, "/").toLowerCase();
	let kind = "unknown";
	let git: unknown;
	if (compiledBinary()) kind = /dinobot-desktop|\/resources\/|\.app\/contents\//.test(normalized) ? "desktop-bundled" : "binary";
	else if (/\/\.bun\/install\/global\//.test(normalized)) kind = "bun-global";
	else if (/dinobot-desktop|\/resources\/|\.app\/contents\//.test(normalized)) kind = "desktop-bundled";
	else if (/\/node_modules\//.test(normalized)) kind = "npm";
	else if (existsSync(join(packageRoot, ".git"))) {
		kind = "dev-checkout";
		const sha = await commandOutput(["git", "rev-parse", "HEAD"], packageRoot);
		const dirty = await commandOutput(["git", "status", "--porcelain", "--untracked-files=no"], packageRoot);
		git = { sha, dirty: dirty === undefined ? undefined : dirty.length > 0 };
	}
	return { version, main, packageRoot, kind, ...(git ? { git } : {}) };
}

async function configSection(read: ManifestRead): Promise<unknown> {
	if (!read.path) return { found: false, error: read.error };
	const facts = await fileFacts(read.path);
	const base = dirname(read.path);
	const out: Record<string, unknown> = { path: read.path, file: facts };
	if (read.text !== undefined) {
		out.sha256 = sha256(read.text);
		out.bytes = Buffer.byteLength(read.text);
	}
	if (read.error) out.parseError = read.error;
	if (read.raw) {
		out.problems = await validationProblems(read.raw).catch((error) => [`validation failed: ${errorText(error)}`]);
		const masked = maskTree(read.raw);
		out.tree = masked.tree;
		const paths: Record<string, FileFacts> = {};
		for (const { at, path } of masked.paths.slice(0, 200)) paths[at] = await fileFacts(expandPath(path, base), { privateCheck: /File$/.test(at) });
		out.paths = paths;
		out.envReferences = Object.fromEntries(masked.envNames.map(({ at, name }) => [at, { name, set: process.env[name] !== undefined }]));
	}
	const bak = `${read.path}.bak`;
	const bakFacts = await fileFacts(bak);
	out.backup = bakFacts;
	if (bakFacts.exists && read.raw) {
		try {
			const bakRaw = Bun.YAML.parse(await readFile(bak, "utf8")) as unknown;
			if (isRecord(bakRaw)) {
				const keys = new Set([...Object.keys(bakRaw), ...Object.keys(read.raw)]);
				out.backupDiffers = [...keys].filter((key) => JSON.stringify(bakRaw[key]) !== JSON.stringify(read.raw![key]));
			}
		} catch (error) {
			out.backupDiffers = { error: errorText(error) };
		}
	}
	const journalPath = `${read.path}.setup-journal.json`;
	const journalFacts = await fileFacts(journalPath);
	out.setupJournal = journalFacts;
	if (journalFacts.exists) {
		try {
			const journal = JSON.parse(await readFile(journalPath, "utf8")) as Record<string, unknown>;
			const pick = (k: string) => (typeof journal[k] === "string" || typeof journal[k] === "number" ? journal[k] : undefined);
			out.setupJournal = { ...journalFacts, baseSha256: pick("baseSha256"), candidateSha256: pick("candidateSha256"), pid: pick("pid"), startedAt: pick("startedAt"), pidAlive: typeof journal.pid === "number" ? pidAlive(journal.pid) : undefined };
		} catch (error) {
			out.setupJournal = { ...journalFacts, error: errorText(error) };
		}
	}
	return out;
}

export type ProbeStatus = "ok" | "refused" | "timeout" | `http_${number}` | "error";
export type Probe = { status: ProbeStatus; ms: number; httpStatus?: number; error?: string };

/** One HTTP probe. A timeout is not "down": the daemon may be busy or hung. */
export async function probeHttp(url: string, timeoutMs: number, fetcher: typeof fetch = fetch, method = "GET"): Promise<Probe & { body?: string }> {
	const started = performance.now();
	try {
		const res = await fetcher(url, { method, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
		const ms = Math.round(performance.now() - started);
		const body = res.headers.get("content-type")?.includes("json") ? await res.text().catch(() => undefined) : (await res.body?.cancel().catch(() => undefined), undefined);
		return { status: res.ok ? "ok" : `http_${res.status}`, ms, httpStatus: res.status, ...(body !== undefined ? { body } : {}) };
	} catch (error) {
		const ms = Math.round(performance.now() - started);
		return { status: classifyFetchError(error), ms, error: errorText(error).slice(0, 300) };
	}
}

export function classifyFetchError(error: unknown): ProbeStatus {
	const e = error as { name?: string; code?: string; message?: string };
	if (e?.name === "TimeoutError" || e?.name === "AbortError" || e?.code === "ETIMEDOUT") return "timeout";
	if (e?.code === "ConnectionRefused" || e?.code === "ECONNREFUSED" || /ECONNREFUSED|Unable to connect|connection refused/i.test(e?.message ?? "")) return "refused";
	return "error";
}

async function daemonSection(read: ManifestRead, mode: ReportMode, fetcher: typeof fetch): Promise<unknown> {
	const out: Record<string, unknown> = { port: read.port ?? null };
	if (read.port !== undefined) {
		const base = `http://127.0.0.1:${read.port}`;
		const [health, info] = await Promise.all([probeHttp(`${base}/healthz`, 2000, fetcher), probeHttp(`${base}/v1/daemon`, 3000, fetcher)]);
		out.healthz = { status: health.status, ms: health.ms, ...(health.error ? { error: health.error } : {}) };
		let daemonInfo: unknown;
		if (info.body) {
			try {
				daemonInfo = JSON.parse(info.body);
			} catch {
				daemonInfo = undefined;
			}
		}
		out.daemonInfo = { status: info.status, ms: info.ms, ...(info.error ? { error: info.error } : {}), ...(daemonInfo !== undefined ? { info: daemonInfo } : {}) };
		const pid = isRecord(daemonInfo) && typeof daemonInfo.pid === "number" ? daemonInfo.pid : undefined;
		if (pid !== undefined) out.pidAlive = pidAlive(pid);
	}
	const lockPath = join(read.dataDir, "daemon.lock");
	const lock: Record<string, unknown> = { ...(await fileFacts(lockPath)) };
	if (mode === "daemon") lock.held = "this process";
	else if (lock.exists) lock.held = lockHeld(lockPath);
	out.lock = lock;
	try {
		out.restartMarkers = (await readdir(read.dataDir)).filter((name) => /^restart-.*\.ready$/.test(name)).length;
	} catch {
		out.restartMarkers = 0;
	}
	return out;
}

/** Whether another process holds the daemon's exclusive SQLite lock; reads only, never takes the lock for long. */
function lockHeld(path: string): boolean | string {
	let db: Database | undefined;
	try {
		db = new Database(path, { readonly: true });
		db.exec("PRAGMA busy_timeout=0");
		db.query("SELECT count(*) FROM sqlite_master").get();
		return false;
	} catch (error) {
		return /busy|locked/i.test(errorText(error)) ? true : `unknown: ${errorText(error).slice(0, 200)}`;
	} finally {
		db?.close();
	}
}

async function logsSection(dataDir: string): Promise<unknown> {
	const files: unknown[] = [];
	let total = 0;
	const main = join(dataDir, "dinobot.log");
	if (existsSync(main)) {
		const t = await tail(main, LIMITS.mainLogBytes, LIMITS.mainLogLines);
		total += t.text.length;
		files.push({ file: "dinobot.log", ...t });
	}
	let others: string[] = [];
	try {
		others = (await readdir(dataDir)).filter((name) => name.endsWith(".log") && name !== "dinobot.log").sort();
	} catch {
		others = [];
	}
	for (const name of others) {
		if (total >= LIMITS.totalLogBytes) {
			files.push({ file: name, skipped: "total log cap reached" });
			continue;
		}
		const t = await tail(join(dataDir, name), Math.min(LIMITS.otherLogBytes, LIMITS.totalLogBytes - total), LIMITS.mainLogLines);
		total += t.text.length;
		files.push({ file: name, ...t });
	}
	return { files };
}

async function inventorySection(dataDir: string): Promise<unknown> {
	const entries: unknown[] = [];
	let truncated = false;
	const walk = async (dir: string, depth: number): Promise<void> => {
		let names: string[];
		try {
			names = (await readdir(dir)).sort();
		} catch (error) {
			entries.push({ path: relative(dataDir, dir) || ".", error: (error as NodeJS.ErrnoException).code ?? errorText(error) });
			return;
		}
		for (const name of names) {
			if (entries.length >= LIMITS.inventoryEntries) {
				truncated = true;
				return;
			}
			const full = join(dir, name);
			try {
				const info = await lstat(full);
				const type = info.isSymbolicLink() ? "symlink" : info.isDirectory() ? "dir" : info.isFile() ? "file" : "other";
				entries.push({ path: relative(dataDir, full).replace(/\\/g, "/"), type, size: info.size, mtime: info.mtime.toISOString(), ...(process.platform === "win32" ? {} : { mode: octal(info.mode) }) });
				if (type === "dir" && depth < LIMITS.inventoryDepth) await walk(full, depth + 1);
			} catch (error) {
				entries.push({ path: relative(dataDir, full).replace(/\\/g, "/"), error: (error as NodeJS.ErrnoException).code ?? errorText(error) });
			}
		}
	};
	const facts = await fileFacts(dataDir);
	if (facts.exists) await walk(dataDir, 1);
	return { root: dataDir, ...facts, entries, truncated };
}

const CHANNEL_HOSTS: Record<string, string> = { telegram: "https://api.telegram.org", slack: "https://slack.com/api/api.test", discord: "https://discord.com/api/v10/gateway" };

async function channelsSection(read: ManifestRead, liveChannels?: () => Promise<unknown>): Promise<unknown> {
	const raw = read.raw && isRecord(read.raw.channels) ? read.raw.channels : {};
	const base = read.path ? dirname(read.path) : process.cwd();
	const channels: Record<string, unknown> = {};
	for (const [type, config] of Object.entries(raw)) {
		const masked = maskTree(config, `/channels/${type}`);
		const files: Record<string, FileFacts> = {};
		for (const { at, path } of masked.paths) files[at] = await fileFacts(expandPath(path, base), { privateCheck: /(File|Path)$/.test(at) });
		channels[type] = {
			type,
			mode: isRecord(config) && typeof config.mode === "string" ? config.mode : undefined,
			settings: masked.tree,
			files,
			env: Object.fromEntries(masked.envNames.map(({ at, name }) => [at, { name, set: process.env[name] !== undefined }])),
		};
	}
	const out: Record<string, unknown> = { configured: Object.keys(raw), channels };
	if (liveChannels) out.live = await liveChannels();
	return out;
}

const PROVIDER_HOSTS: Record<string, string> = {
	anthropic: "https://api.anthropic.com",
	openai: "https://api.openai.com",
	"openai-codex": "https://chatgpt.com",
	google: "https://generativelanguage.googleapis.com",
	"google-gemini-cli": "https://cloudcode-pa.googleapis.com",
	"github-copilot": "https://api.githubcopilot.com",
	openrouter: "https://openrouter.ai",
	xai: "https://api.x.ai",
	groq: "https://api.groq.com",
	mistral: "https://api.mistral.ai",
};

async function networkSection(read: ManifestRead, reportUrl: string, fetcher: typeof fetch, timeoutMs: number): Promise<unknown> {
	const targets = new Map<string, string>();
	const bot = read.raw && isRecord(read.raw.bot) ? read.raw.bot : {};
	const model = isRecord(bot.model) ? bot.model : {};
	const provider = typeof model.provider === "string" ? model.provider : undefined;
	const providers = read.raw && isRecord(read.raw.providers) ? read.raw.providers : {};
	const custom = provider && isRecord(providers[provider]) ? (providers[provider] as Record<string, unknown>) : undefined;
	const providerUrl = typeof custom?.baseUrl === "string" ? custom.baseUrl : provider ? PROVIDER_HOSTS[provider] : undefined;
	if (providerUrl) targets.set(`model:${provider}`, providerUrl);
	const channels = read.raw && isRecord(read.raw.channels) ? Object.keys(read.raw.channels) : [];
	for (const type of channels) if (CHANNEL_HOSTS[type]) targets.set(`channel:${type}`, CHANNEL_HOSTS[type]!);
	targets.set("report", `${reportUrl.replace(/\/+$/, "")}/v1/health`);
	targets.set("npm", "https://registry.npmjs.org/");
	const results = await Promise.all(
		[...targets].map(async ([name, url]) => {
			let host: string;
			try {
				host = new URL(url).host;
			} catch {
				return { name, host: url, ok: false, error: "invalid URL" };
			}
			const probe = await probeHttp(url, timeoutMs, fetcher);
			return { name, host, ok: probe.status !== "refused" && probe.status !== "timeout" && probe.status !== "error", status: probe.httpStatus ?? probe.status, ms: probe.ms, ...(probe.error ? { error: probe.error } : {}) };
		}),
	);
	return { probes: results };
}

/** The TUI records its last failed setup apply here so a later report (daemon or offline) carries it. */
export const lastSetupPath = (dataDir: string) => join(dataDir, "report", "last-setup.json");
const LAST_SETUP_MAX_AGE_MS = 24 * 3_600_000;

function contextSection(context: unknown, dataDir: string, now: Date): unknown {
	const out: Record<string, unknown> = {};
	if (context !== undefined) {
		const text = JSON.stringify(context) ?? "null";
		out.client = text.length <= LIMITS.contextChars ? context : { truncated: true, chars: text.length, head: text.slice(0, LIMITS.contextChars) };
	}
	try {
		const file = lastSetupPath(dataDir);
		if (statSync(file).mtimeMs >= now.getTime() - LAST_SETUP_MAX_AGE_MS) out.lastSetupApply = JSON.parse(readFileSync(file, "utf8").slice(0, 256 * 1024));
	} catch {
		// absent or unreadable: nothing to add
	}
	return out;
}

// ---- collection ---------------------------------------------------------------------------------

export async function collectDiagnostics(options: DiagnosticsOptions): Promise<DiagnosticResult[]> {
	const now = options.now ?? (() => new Date());
	const startedAt = now();
	const fetcher = options.fetch ?? fetch;
	const timeout = options.sectionTimeoutMs ?? 10_000;
	const read = readManifestLoose(options.manifestPath, options.dataDir);
	const sections: Array<[string, () => Promise<unknown> | unknown]> = [
		["system", () => systemSection(read.dataDir)],
		["runtime", () => runtimeSection()],
		["install", () => installSection(options.version)],
		["config", () => configSection(read)],
		["daemon", () => daemonSection(read, options.mode, fetcher)],
		["logs", () => logsSection(read.dataDir)],
		["dataDir", () => inventorySection(read.dataDir)],
		["channels", () => channelsSection(read, options.liveChannels)],
		["network", () => (process.env.DINOBOT_REPORT_NETWORK === "off" ? { skipped: "DINOBOT_REPORT_NETWORK=off" } : networkSection(read, options.reportUrl, fetcher, options.networkTimeoutMs ?? 3000))],
		...(options.live ? ([["live", options.live]] as Array<[string, () => Promise<unknown>]>) : []),
		["context", () => contextSection(options.context, read.dataDir, startedAt)],
	];
	const results = await Promise.all(
		sections.map(async ([section, collect]): Promise<DiagnosticResult> => {
			const started = performance.now();
			try {
				const data = await withTimeout(timeout, async () => collect());
				return { section, data, ms: Math.round(performance.now() - started) };
			} catch (error) {
				return { section, error: errorText(error), ms: Math.round(performance.now() - started) };
			}
		}),
	);
	const report: DiagnosticResult = {
		section: "report",
		data: {
			trigger: options.trigger,
			mode: options.mode,
			client: options.client,
			dinobotVersion: options.version,
			collectedAt: startedAt.toISOString(),
			durationMs: now().getTime() - startedAt.getTime(),
			timings: Object.fromEntries(results.map((r) => [r.section, r.ms])),
			errors: results.filter((r) => r.error).map((r) => r.section),
		},
		ms: 0,
	};
	return [report, ...results];
}

/**
 * Entry lines `{"kind":"diagnostic","section",…}` for the report bundle, scrubbed (D2) before they are split (D3):
 * each log file is its own line (`data.file`), a long log tail or any oversized section is cut into `part`/`parts` lines.
 * Log parts carry `data.text`; other split sections carry `chunk`, consecutive slices of the section's JSON text.
 */
export function diagnosticLines(results: readonly DiagnosticResult[], options: { identity?: Partial<Identity>; counts?: RedactionCounts } = {}): string[] {
	const anonymize = createAnonymizer(options.identity);
	const counts = options.counts ?? {};
	const lines: string[] = [];
	const push = (section: string, body: Record<string, unknown>) => lines.push(JSON.stringify({ kind: "diagnostic", section, ...body }));
	for (const result of results) {
		if (result.error !== undefined) {
			push(result.section, { error: scrub(result.error, anonymize, counts) });
			continue;
		}
		const data = scrub(result.data, anonymize, counts);
		if (result.section === "logs" && isRecord(data) && Array.isArray(data.files)) {
			if (data.files.length === 0) push("logs", { data: { files: [] } });
			for (const file of data.files) {
				const text = isRecord(file) && typeof file.text === "string" ? file.text : undefined;
				if (text === undefined || text.length <= LIMITS.lineChars) {
					push("logs", { data: file });
					continue;
				}
				const parts = Math.ceil(text.length / LIMITS.lineChars);
				for (let i = 0; i < parts; i++) push("logs", { data: { ...(file as Record<string, unknown>), text: text.slice(i * LIMITS.lineChars, (i + 1) * LIMITS.lineChars) }, part: i + 1, parts });
			}
			continue;
		}
		const line = JSON.stringify({ kind: "diagnostic", section: result.section, data });
		if (line.length <= LIMITS.lineChars + 1000) {
			lines.push(line);
			continue;
		}
		const json = JSON.stringify(data);
		const parts = Math.ceil(json.length / LIMITS.lineChars);
		for (let i = 0; i < parts; i++) push(result.section, { part: i + 1, parts, chunk: json.slice(i * LIMITS.lineChars, (i + 1) * LIMITS.lineChars) });
	}
	return lines;
}
