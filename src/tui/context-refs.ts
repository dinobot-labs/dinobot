/**
 * Hermes-style `@` context references for the TUI (hermes-agent agent/context_references.py).
 * `@file:path[:a-b]`, `@folder:path`, `@diff`, `@staged` and `@git:N` stay inline where the user typed them;
 * their content is appended under `--- Attached Context ---` before the message is sent. Only the local TUI
 * expands them: channels pass `@` text through untouched.
 */
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type ReferenceKind = "diff" | "staged" | "file" | "folder" | "git";

export type ContextReference = {
	readonly raw: string;
	readonly kind: ReferenceKind;
	readonly target: string;
	readonly start: number;
	readonly end: number;
	readonly lineStart?: number;
	readonly lineEnd?: number;
};

export type ExpansionResult = {
	readonly message: string;
	readonly references: readonly ContextReference[];
	readonly warnings: readonly string[];
	readonly injectedTokens: number;
	/** The injection passed the hard limit, so `message` is the original text unchanged. */
	readonly blocked: boolean;
};

export type ExpandOptions = {
	readonly cwd: string;
	readonly contextWindow: number;
	/** Extra directories that must never be attached (dinobot's data dir: auth.json, sqlite). */
	readonly blockedDirs?: readonly string[];
	readonly home?: string;
};

export const CHARS_PER_TOKEN = 4;
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const MAX_REFERENCES = 16;
export const FOLDER_LIMIT = 200;
const GIT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const LINE_COUNT_MAX_BYTES = 4 * 1024 * 1024;
const RANGE_READ_MAX_BYTES = 64 * 1024 * 1024;
const TRAILING_PUNCTUATION = ",.;!?";
const OPENERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
const QUOTED = "(?:`[^`\\n]+`|\"[^\"\\n]+\"|'[^'\\n]+')";
const REFERENCE_PATTERN = new RegExp(`(?<![\\w/])@(?:(?<simple>diff|staged)\\b|(?<kind>file|folder|git):(?<value>${QUOTED}(?::\\d+(?:-\\d+)?)?|\\S+))`, "g");
const FILE_VALUE = /^(?:(?<quote>[`"'])(?<qpath>.+?)\k<quote>|(?<path>.+?))(?::(?<start>\d+)(?:-(?<end>\d+))?)?$/;
const NEEDS_QUOTING = /[\s()[\]{}<>"'`]/;
const SENSITIVE_HOME_FILES = [
	".ssh/authorized_keys", ".ssh/id_rsa", ".ssh/id_ed25519", ".ssh/config", ".bashrc", ".zshrc",
	".profile", ".bash_profile", ".zprofile", ".netrc", ".pgpass", ".npmrc", ".pypirc",
];
const SENSITIVE_HOME_DIRS = [".ssh", ".aws", ".gnupg", ".kube", ".docker", ".azure", ".config/gcloud", ".config/gh"];
const TEXT_EXTENSIONS = new Set([".py", ".md", ".txt", ".json", ".yaml", ".yml", ".toml", ".js", ".ts", ".tsx", ".jsx", ".sh", ".css", ".html"]);
const BINARY_EXTENSIONS = new Set([
	".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".pdf", ".zip", ".gz", ".tgz", ".xz", ".bz2", ".7z",
	".tar", ".jar", ".so", ".dylib", ".dll", ".exe", ".bin", ".wasm", ".sqlite", ".db", ".mp3", ".mp4", ".mov", ".woff", ".woff2", ".ttf", ".otf",
]);
const FENCE_LANGUAGES: Record<string, string> = {
	".py": "python", ".js": "javascript", ".ts": "typescript", ".tsx": "tsx", ".jsx": "jsx",
	".json": "json", ".md": "markdown", ".sh": "bash", ".yml": "yaml", ".yaml": "yaml", ".toml": "toml",
};

export const estimateTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatReferenceValue(value: string): string {
	if (!NEEDS_QUOTING.test(value)) return value;
	for (const quote of ["`", "\"", "'"]) if (!value.includes(quote)) return `${quote}${value}${quote}`;
	return value;
}

function stripTrailingPunctuation(value: string): string {
	let stripped = value;
	while (stripped !== "" && TRAILING_PUNCTUATION.includes(stripped.at(-1)!)) stripped = stripped.slice(0, -1);
	// "(see @file:x.ts)" must not swallow the closer.
	for (let last = stripped.at(-1); last !== undefined && last in OPENERS; last = stripped.at(-1)) {
		const count = (char: string): number => stripped.split(char).length - 1;
		if (count(last) <= count(OPENERS[last]!)) break;
		stripped = stripped.slice(0, -1);
	}
	return stripped;
}

const unwrap = (value: string): string => (value.length >= 2 && value[0] === value.at(-1) && "`\"'".includes(value[0]!) ? value.slice(1, -1) : value);

export function parseContextReferences(message: string): ContextReference[] {
	const refs: ContextReference[] = [];
	for (const match of message.matchAll(REFERENCE_PATTERN)) {
		const groups = match.groups ?? {};
		const start = match.index;
		if (groups.simple !== undefined) {
			refs.push({ raw: match[0], kind: groups.simple as ReferenceKind, target: "", start, end: start + match[0].length });
			continue;
		}
		const kind = groups.kind as ReferenceKind;
		const value = stripTrailingPunctuation(groups.value ?? "");
		if (value === "") continue;
		const raw = `@${kind}:${value}`;
		const base = { raw, kind, start, end: start + raw.length };
		if (kind !== "file") {
			refs.push({ ...base, target: unwrap(value) });
			continue;
		}
		const parsed = FILE_VALUE.exec(value)?.groups;
		if (parsed?.start === undefined) refs.push({ ...base, target: unwrap(value) });
		else {
			const lineStart = Number(parsed.start);
			refs.push({ ...base, target: parsed.qpath ?? parsed.path ?? "", lineStart, lineEnd: Math.max(lineStart, Number(parsed.end ?? parsed.start)) });
		}
	}
	return refs;
}

type Expansion = { readonly warning?: string; readonly block?: string };

export async function expandContextReferences(message: string, options: ExpandOptions): Promise<ExpansionResult> {
	const references = parseContextReferences(message);
	if (references.length === 0) return { message, references, warnings: [], injectedTokens: 0, blocked: false };
	const cwd = await realpath(resolve(options.cwd));
	const hardLimit = Math.max(1, Math.floor(options.contextWindow * 0.5));
	const softLimit = Math.max(1, Math.floor(options.contextWindow * 0.25));
	const guard = await pathGuard(cwd, options);
	const expanded = await Promise.all(references.slice(0, MAX_REFERENCES).map((ref) => expandReference(ref, cwd, guard, hardLimit)));
	const warnings = expanded.flatMap((entry) => (entry.warning === undefined ? [] : [entry.warning]));
	for (const ref of references.slice(MAX_REFERENCES)) warnings.push(`${ref.raw}: not expanded (maximum ${MAX_REFERENCES} @-references per message)`);
	const blocks = expanded.flatMap((entry) => (entry.block === undefined ? [] : [entry.block]));
	const injectedTokens = blocks.reduce((sum, block) => sum + estimateTokens(block), 0);
	if (injectedTokens > hardLimit) {
		warnings.push(`@ context injection refused: ${injectedTokens} tokens exceeds the 50% hard limit (${hardLimit}).`);
		return { message, references, warnings, injectedTokens, blocked: true };
	}
	if (injectedTokens > softLimit) warnings.push(`@ context injection warning: ${injectedTokens} tokens exceeds the 25% soft limit (${softLimit}).`);
	let final = message;
	if (warnings.length > 0) final += `\n\n--- Context Warnings ---\n${warnings.map((warning) => `- ${warning}`).join("\n")}`;
	if (blocks.length > 0) final += `\n\n--- Attached Context ---\n\n${blocks.join("\n\n")}`;
	return { message: final.trim(), references, warnings, injectedTokens, blocked: false };
}

async function expandReference(ref: ContextReference, cwd: string, guard: PathGuard, maxTokens: number): Promise<Expansion> {
	try {
		if (ref.kind === "file" || ref.kind === "folder") return await expandPath(ref, cwd, guard, maxTokens);
		const args = ref.kind === "diff" ? ["diff"] : ref.kind === "staged" ? ["diff", "--staged"] : ["log", `-${Math.max(1, Math.min(Number.parseInt(ref.target, 10) || 1, 10))}`, "-p"];
		return await expandGit(ref, cwd, args);
	} catch (error) {
		return { warning: `${ref.raw}: ${error instanceof Error ? error.message : String(error)}` };
	}
}

type PathGuard = { readonly root: string; readonly blockedFiles: ReadonlySet<string>; readonly blockedDirs: readonly string[] };

async function canonical(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch {
		return resolve(path);
	}
}

async function pathGuard(root: string, options: ExpandOptions): Promise<PathGuard> {
	const home = await canonical(options.home ?? homedir());
	const blockedDirs = await Promise.all([...SENSITIVE_HOME_DIRS.map((dir) => join(home, dir)), ...(options.blockedDirs ?? [])].map(canonical));
	return { root, blockedFiles: new Set(SENSITIVE_HOME_FILES.map((file) => join(home, file))), blockedDirs };
}

const isUnder = (path: string, root: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

function isEnvFile(path: string): boolean {
	const name = basename(path);
	return (name === ".env" || name.startsWith(".env.")) && !/\.(example|sample|template)$/.test(name);
}

/** Lexical and symlink-resolved checks: the workspace root contains both, and neither is a credential path. */
async function resolveAllowed(target: string, cwd: string, guard: PathGuard): Promise<string> {
	const expanded = target === "~" || target.startsWith("~/") ? join(homedir(), target.slice(1)) : target;
	const lexical = resolve(cwd, expanded);
	const real = await canonical(lexical);
	for (const path of [lexical, real]) {
		if (!isUnder(path, guard.root)) throw new Error("path is outside the allowed workspace");
		if (guard.blockedFiles.has(path) || isEnvFile(path) || guard.blockedDirs.some((dir) => isUnder(path, dir))) {
			throw new Error("path is a sensitive credential file and cannot be attached");
		}
	}
	return real;
}

async function exists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch {
		return false;
	}
}

async function expandPath(ref: ContextReference, cwd: string, guard: PathGuard, maxTokens: number): Promise<Expansion> {
	const path = await resolveAllowed(ref.target, cwd, guard);
	if (!(await exists(path))) return { warning: `${ref.raw}: ${ref.kind} not found` };
	const info = await stat(path);
	if (ref.kind === "folder") {
		if (!info.isDirectory()) return { warning: `${ref.raw}: path is not a folder` };
		const listing = await folderListing(path, cwd);
		return { block: `📁 ${ref.raw} (${estimateTokens(listing)} tokens)\n${listing}` };
	}
	if (!info.isFile()) return { warning: `${ref.raw}: path is not a file` };
	if (await isBinaryFile(path)) return { block: onDiskBlock(ref, path, info.size, "binary file", "binary file, not inlined as text.", "Use your tools to work with it; do not tell the user the file type is unsupported.") };
	const charBudget = maxTokens * CHARS_PER_TOKEN;
	if (info.size > (ref.lineStart === undefined ? charBudget : RANGE_READ_MAX_BYTES)) return { block: oversizedBlock(ref, path, info.size, Math.ceil(info.size / CHARS_PER_TOKEN)) };
	let text = await Bun.file(path).text();
	if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
	if (ref.lineStart !== undefined) text = text.split(/(?<=\n)/).slice(ref.lineStart - 1, ref.lineEnd).join("").replace(/\n$/, "");
	const tokens = estimateTokens(text);
	if (tokens > maxTokens) return { block: oversizedBlock(ref, path, info.size, tokens) };
	return { block: `📄 ${ref.raw} (${tokens} tokens)\n\`\`\`${FENCE_LANGUAGES[extname(path).toLowerCase()] ?? ""}\n${text}\n\`\`\`` };
}

function onDiskBlock(ref: ContextReference, path: string, size: number, descriptor: string, reason: string, guidance: string): string {
	return `📎 ${ref.raw} (${descriptor}, ${formatBytes(size)}) — ${reason} It is available on disk at \`${path}\`. ${guidance}`;
}

const oversizedBlock = (ref: ContextReference, path: string, size: number, tokens: number): string =>
	onDiskBlock(ref, path, size, `text file, approximately ${tokens} tokens`, "too large to inline safely.", "Read only the relevant line ranges or search it with your tools; do not load the entire file into context.");

async function isBinaryFile(path: string): Promise<boolean> {
	const ext = extname(path).toLowerCase();
	if (BINARY_EXTENSIONS.has(ext) && !TEXT_EXTENSIONS.has(ext)) return true;
	const handle = await open(path, "r");
	try {
		const buffer = Buffer.alloc(4096);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		return buffer.subarray(0, bytesRead).includes(0);
	} finally {
		await handle.close();
	}
}

type CommandResult = { readonly code: number; readonly stdout: string; readonly stderr: string; readonly timedOut: boolean };

/** stdin closed, output capped at 4 MiB per stream (past it the child is killed), a hard timeout. */
async function runQuiet(argv: readonly string[], cwd: string, timeoutMs: number, env?: Record<string, string>): Promise<CommandResult> {
	const child = Bun.spawn([...argv], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", ...(env === undefined ? {} : { env: { ...process.env, ...env } }) });
	let truncated = false;
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill();
	}, timeoutMs);
	const drain = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
		const chunks: Uint8Array[] = [];
		let total = 0;
		for await (const chunk of stream) {
			total += chunk.byteLength;
			if (total > MAX_OUTPUT_BYTES) {
				truncated = true;
				child.kill();
				break;
			}
			chunks.push(chunk);
		}
		return Buffer.concat(chunks).toString("utf8");
	};
	try {
		const [stdout, stderr, code] = await Promise.all([drain(child.stdout), drain(child.stderr), child.exited]);
		return { code: truncated && code === 0 ? 137 : code, stdout, stderr: truncated ? `output exceeded ${formatBytes(MAX_OUTPUT_BYTES)}` : stderr, timedOut };
	} finally {
		clearTimeout(timer);
	}
}

/** Repository config must never run code: no external diff/textconv drivers, fsmonitor, pager or prompts. */
const GIT_HARDENING = ["-c", "core.fsmonitor=false", "-c", "core.pager=cat", "-c", "diff.external=", "--no-pager"];
const GIT_ENV = { GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", GIT_EXTERNAL_DIFF: "", GIT_OPTIONAL_LOCKS: "0" };

async function expandGit(ref: ContextReference, cwd: string, args: readonly string[]): Promise<Expansion> {
	const result = await runQuiet(["git", ...GIT_HARDENING, ...args, "--no-ext-diff", "--no-textconv", "--no-color"], cwd, GIT_TIMEOUT_MS, GIT_ENV);
	if (result.timedOut) return { warning: `${ref.raw}: git command timed out (30s)` };
	if (result.code !== 0) return { warning: `${ref.raw}: ${result.stderr.trim() || "git command failed"}` };
	const content = result.stdout.trim() || "(no output)";
	return { block: `🧾 git ${args.join(" ")} (${estimateTokens(content)} tokens)\n\`\`\`diff\n${content}\n\`\`\`` };
}

async function fileMetadata(path: string, size: number): Promise<string> {
	try {
		if (size > LINE_COUNT_MAX_BYTES || (await isBinaryFile(path))) return `${size} bytes`;
		const bytes = await Bun.file(path).bytes();
		let lines = 1;
		for (const byte of bytes) if (byte === 10) lines++;
		return `${lines} lines`;
	} catch {
		return `${size} bytes`;
	}
}

type FolderEntry = { readonly path: string; readonly dir: boolean };

async function folderListing(path: string, cwd: string): Promise<string> {
	const entries = await visibleEntries(path, cwd, FOLDER_LIMIT);
	const lines = [`${relative(cwd, path) || "."}/`];
	for (const entry of entries) {
		const depth = relative(path, entry.path).split(sep).length - 1;
		const indent = "  ".repeat(Math.max(0, depth));
		if (entry.dir) lines.push(`${indent}- ${basename(entry.path)}/`);
		else lines.push(`${indent}- ${basename(entry.path)} (${await fileMetadata(entry.path, (await stat(entry.path)).size)})`);
	}
	if (entries.length >= FOLDER_LIMIT) lines.push("- ...");
	return lines.join("\n");
}

async function visibleEntries(path: string, cwd: string, limit: number): Promise<FolderEntry[]> {
	let files: string[] | undefined;
	try {
		const rg = await runQuiet(["rg", "--files", path], cwd, 10_000);
		if (rg.code === 0) files = rg.stdout.split("\n").filter((line) => line !== "").map((line) => resolve(cwd, line)).sort().slice(0, limit);
	} catch {
		files = undefined;
	}
	if (files === undefined) return walk(path, limit);
	const output = new Map<string, FolderEntry>();
	for (const file of files) {
		for (let parent = resolve(file, ".."); isUnder(parent, path) && parent !== path; parent = resolve(parent, "..")) output.set(parent, { path: parent, dir: true });
		output.set(file, { path: file, dir: false });
	}
	return [...output.values()].sort((a, b) => a.path.localeCompare(b.path));
}

async function walk(root: string, limit: number): Promise<FolderEntry[]> {
	const output: FolderEntry[] = [];
	const visit = async (dir: string): Promise<void> => {
		const children = (await readdir(dir, { withFileTypes: true })).filter((entry) => !entry.name.startsWith(".") && entry.name !== "node_modules").sort((a, b) => a.name.localeCompare(b.name));
		for (const child of children) {
			if (output.length >= limit) return;
			const path = join(dir, child.name);
			output.push({ path, dir: child.isDirectory() });
			if (child.isDirectory()) await visit(path);
		}
	};
	await visit(root);
	return output;
}

export type WorkspaceEntry = { readonly path: string; readonly dir: boolean; readonly size?: number };
const WORKSPACE_LIMIT = 20_000;

/**
 * Completion candidates under `cwd`, relative to it: tracked and untracked-but-not-ignored files from git, else a
 * bounded walk; folders are derived from the file paths. Files carry their size for the dropdown's metadata.
 */
export async function listWorkspaceEntries(cwd: string): Promise<WorkspaceEntry[]> {
	let files: string[];
	const git = await runQuiet(["git", ...GIT_HARDENING, "ls-files", "-co", "--exclude-standard", "-z"], cwd, 10_000, GIT_ENV).catch(() => undefined);
	if (git !== undefined && git.code === 0) files = git.stdout.split("\0").filter((line) => line !== "").slice(0, WORKSPACE_LIMIT);
	else files = (await walk(cwd, WORKSPACE_LIMIT).catch(() => [])).filter((entry) => !entry.dir).map((entry) => relative(cwd, entry.path));
	const dirs = new Set<string>();
	for (const file of files) for (let at = file.lastIndexOf("/"); at > 0; at = file.lastIndexOf("/", at - 1)) dirs.add(file.slice(0, at));
	const sized = await Promise.all(files.map(async (file): Promise<WorkspaceEntry> => {
		try {
			return { path: file, dir: false, size: (await stat(isAbsolute(file) ? file : join(cwd, file))).size };
		} catch {
			return { path: file, dir: false };
		}
	}));
	return [...[...dirs].sort().map((path) => ({ path, dir: true })), ...sized.filter((entry) => entry.size !== undefined)];
}
