import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

/** Explicitly authorized same-user code. This contract is NOT hostile-code isolation. */
export type CodeExperimentSpec = {
	baseCommit: string;
	allowedPaths: string[];
	command: { argv: string[]; timeoutMs: number };
	evaluatorRevision: string;
	authorityRef: string;
};
export type ResearchEdit = { path: string; content: string };
export type ProcessReceipt = {
	status: "completed" | "failed" | "timeout" | "cancelled" | "output_limit";
	exitCode: number | null;
	stdout: string;
	stderr: string;
	startedAt: number;
	endedAt: number;
	pid: number | null;
	argv: string[];
	cwd: string;
};
export const RESEARCH_OUTPUT_LIMIT = 256 * 1024;
export const hashResearchBytes = (value: string) => createHash("sha256").update(value).digest("hex");

export function researchRelativePath(path: string): string {
	if (
		!path || isAbsolute(path) || path.includes("\\") || path.includes(":") || path.includes("\0") ||
		path.split("/").some((part) => !part || part === "." || part === ".." || part === ".git" || part === ".dinobot")
	) {
		throw new Error(`Invalid research relative path: ${path}`);
	}
	return path;
}

/** Reject observed symlinks. Parent directories are trusted not to race replacements. */
export async function researchContainedPath(root: string, path: string, allowMissing = false): Promise<string> {
	const canonical = await realpath(root);
	const destination = resolve(canonical, path);
	const rel = relative(canonical, destination);
	if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) throw new Error("Research path escapes target");
	let current = canonical;
	for (const component of rel.split(sep)) {
		current = join(current, component);
		try {
			const info = await lstat(current);
			if (info.isSymbolicLink()) throw new Error("Research path contains a symlink");
		} catch (error) {
			if (!(allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
		}
	}
	return destination;
}

export async function runResearchProcess(input: {
	argv: readonly string[];
	cwd: string;
	timeoutMs: number;
	signal?: AbortSignal;
	maxOutputBytes?: number;
	onSpawn?: (pid: number) => Promise<void>;
	environment?: Record<string, string>;
}): Promise<ProcessReceipt> {
	if (
		!input.argv.length || input.argv.some((s) => typeof s !== "string" || s.includes("\0")) ||
		!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1
	) throw new Error("Invalid experiment command or timeout");
	input.signal?.throwIfAborted();
	const max = input.maxOutputBytes ?? RESEARCH_OUTPUT_LIMIT;
	if (!Number.isSafeInteger(max) || max < 1 || max > 16 * 1024 * 1024) throw new Error("Invalid process output budget");
	const startedAt = Date.now();
	const child = spawn(input.argv[0]!, input.argv.slice(1), {
		cwd: input.cwd,
		detached: process.platform !== "win32",
		stdio: ["ignore", "pipe", "pipe"],
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8", CI: "1", GIT_TERMINAL_PROMPT: "0", ...input.environment },
	});
	let status: ProcessReceipt["status"] | undefined;
	let bytes = 0;
	const stdout: Buffer[] = [], stderr: Buffer[] = [];
	const stop = (reason: ProcessReceipt["status"]) => {
		status ??= reason;
		if (!child.pid) return;
		try {
			process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill("SIGKILL");
		}
	};
	const collect = (chunks: Buffer[], value: Buffer) => {
		const remaining = Math.max(0, max - bytes);
		if (remaining) chunks.push(value.subarray(0, remaining));
		bytes += value.length;
		if (bytes > max) stop("output_limit");
	};
	child.stdout.on("data", (value: Buffer) => collect(stdout, value));
	child.stderr.on("data", (value: Buffer) => collect(stderr, value));
	const aborted = () => stop("cancelled");
	input.signal?.addEventListener("abort", aborted, { once: true });
	if (input.signal?.aborted) aborted();
	const timer = setTimeout(() => stop("timeout"), input.timeoutMs);
	const exited = new Promise<number | null>((res, rej) => {
		child.once("error", rej);
		child.once("close", res);
	});
	try {
		if (child.pid && input.onSpawn) {
			try {
				await input.onSpawn(child.pid);
			} catch (error) {
				stop("failed");
				await exited.catch(() => {});
				throw error;
			}
		}
		const exitCode = await exited;
		return {
			status: status ?? (exitCode === 0 ? "completed" : "failed"),
			exitCode,
			stdout: Buffer.concat(stdout).toString("utf8"),
			stderr: Buffer.concat(stderr).toString("utf8"),
			startedAt,
			endedAt: Date.now(),
			pid: child.pid ?? null,
			argv: [...input.argv],
			cwd: input.cwd,
		};
	} finally {
		clearTimeout(timer);
		input.signal?.removeEventListener("abort", aborted);
	}
}

async function git(root: string, args: string[]): Promise<string> {
	const receipt = await runResearchProcess({ argv: ["git", "-c", "core.hooksPath=/dev/null", ...args], cwd: root, timeoutMs: 30_000 });
	if (receipt.status !== "completed") throw new Error(`Research git command failed: ${receipt.stderr}`);
	return receipt.stdout;
}

export function validateCodeExperiment(spec: CodeExperimentSpec): void {
	if (
		!/^[0-9a-f]{40}$/.test(spec.baseCommit) || !spec.authorityRef || !spec.evaluatorRevision ||
		!Array.isArray(spec.allowedPaths) || !spec.allowedPaths.length || spec.allowedPaths.length > 32 ||
		new Set(spec.allowedPaths).size !== spec.allowedPaths.length || !spec.command.argv.length ||
		!Number.isSafeInteger(spec.command.timeoutMs) || spec.command.timeoutMs < 1 || spec.command.timeoutMs > 3_600_000
	) {
		throw new Error("Invalid trusted-local code experiment contract");
	}
	for (const path of spec.allowedPaths) researchRelativePath(path);
	for (const arg of spec.command.argv) if (typeof arg !== "string" || arg.includes("\0")) throw new Error("Invalid evaluator argv");
	// Compare lexical path aliases without rewriting argv or the authorized edit scope.
	// This checks explicitly named files, not shell/interpreter semantics or hostile code.
	if (spec.command.argv.some((arg) => spec.allowedPaths.includes(normalize(arg)))) {
		throw new Error("Evaluator command files cannot be author-editable");
	}
}

export async function createResearchWorktree(root: string, directory: string, spec: CodeExperimentSpec): Promise<string> {
	validateCodeExperiment(spec);
	const canonical = await realpath(root);
	if (await realpath((await git(canonical, ["rev-parse", "--show-toplevel"])).trim()) !== canonical) {
		throw new Error("Code mission requires an explicitly bound Git root");
	}
	const base = (await git(canonical, ["rev-parse", "--verify", `${spec.baseCommit}^{commit}`])).trim();
	if (base !== spec.baseCommit) throw new Error("Research base commit mismatch");
	await researchContainedPath(canonical, directory, true);
	await mkdir(dirname(directory), { recursive: true });
	try {
		await lstat(directory);
		throw new Error("Research worktree destination already exists; reconcile instead of overwriting");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await git(canonical, ["worktree", "add", "--detach", directory, base]);
	return realpath(directory);
}

export async function applyResearchEdits(worktree: string, spec: CodeExperimentSpec, edits: readonly ResearchEdit[]): Promise<string> {
	validateCodeExperiment(spec);
	if (edits.length > spec.allowedPaths.length || new Set(edits.map((edit) => edit.path)).size !== edits.length) {
		throw new Error("Duplicate or excessive candidate edits");
	}
	let bytes = 0;
	for (const edit of edits) {
		if (!spec.allowedPaths.includes(researchRelativePath(edit.path))) {
			throw new Error(`Candidate edit outside authorized scope: ${edit.path}`);
		}
		bytes += Buffer.byteLength(edit.content);
		if (bytes > 1024 * 1024) throw new Error("Candidate edits exceed 1 MiB");
		await researchContainedPath(worktree, edit.path, true);
	}
	for (const edit of edits) {
		const path = await researchContainedPath(worktree, edit.path, true);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, edit.content, { flag: "w" });
	}
	return researchArtifactHash(worktree, spec);
}

export async function researchArtifactHash(worktree: string, spec: CodeExperimentSpec): Promise<string> {
	const files: [string, string | null][] = [];
	for (const path of [...spec.allowedPaths].sort()) {
		try {
			files.push([path, await readFile(await researchContainedPath(worktree, path), "utf8")]);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			files.push([path, null]);
		}
	}
	return hashResearchBytes(JSON.stringify({ base: spec.baseCommit, files }));
}

/** Tracked evaluator/data files stay at the explicit base revision. Generated
 * untracked outputs are not claimed as independently versioned input datasets. */
export async function assertResearchEvaluatorUnchanged(worktree: string, spec: CodeExperimentSpec): Promise<void> {
	const changes = await git(worktree, [
		"diff",
		"--no-ext-diff",
		"--name-only",
		spec.baseCommit,
		"--",
		".",
		...spec.allowedPaths.map((path) => `:(exclude,literal)${path}`),
	]);
	if (changes.trim()) throw new Error("Tracked evaluator or input files changed outside the frozen candidate scope");
}

/** Export only; never commit, merge, reset, clean or remove a user's worktree. */
export async function researchPatch(worktree: string, spec: CodeExperimentSpec): Promise<string> {
	for (const path of spec.allowedPaths) {
		const listed = (await git(worktree, ["ls-files", "--", path])).trim();
		if (listed) continue;
		try {
			await researchContainedPath(worktree, path);
			await git(worktree, ["add", "--intent-to-add", "--", path]);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return git(worktree, ["diff", "--no-ext-diff", "--binary", spec.baseCommit, "--", ...spec.allowedPaths]);
}
