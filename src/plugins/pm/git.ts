import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { type CheckRun, type CheckSpec, checkTimeoutSec, sameCommit } from "./model.ts";

type Result = { code: number | null; stdout: string; stderr: string; timedOut: boolean };
const TAIL = 4000;
const MAX_CAPTURE = 4 * 1024 * 1024;

function run(command: string, args: readonly string[], options: { cwd: string; timeoutMs: number; shell?: boolean; signal?: AbortSignal }): Promise<Result> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, [...args], {
			cwd: options.cwd,
			shell: options.shell ?? false,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
			// git must not prompt or run repository-configured programs on our read paths.
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const keep = (current: string, chunk: Buffer) => (current.length > MAX_CAPTURE ? current.slice(-MAX_CAPTURE / 2) : current) + chunk.toString("utf8");
		child.stdout.on("data", (chunk: Buffer) => { stdout = keep(stdout, chunk); });
		child.stderr.on("data", (chunk: Buffer) => { stderr = keep(stderr, chunk); });
		const kill = () => {
			if (process.platform === "win32" && child.pid !== undefined) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
			else child.kill("SIGKILL");
		};
		const timer = setTimeout(() => { timedOut = true; kill(); }, options.timeoutMs);
		const onAbort = () => kill();
		options.signal?.addEventListener("abort", onAbort, { once: true });
		child.once("error", (error) => { clearTimeout(timer); options.signal?.removeEventListener("abort", onAbort); reject(error); });
		child.once("close", (code) => {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			resolve({ code, stdout, stderr, timedOut });
		});
	});
}

const git = (cwd: string, args: readonly string[], signal?: AbortSignal) => run("git", ["-c", "core.fsmonitor=false", ...args], { cwd, timeoutMs: 30_000, ...(signal ? { signal } : {}) });

/** Whether `commit` names a commit object in `repo`, and when `ref` is given whether `ref` contains it. */
export async function commitFacts(repo: string, commit: string, ref: string | undefined, signal?: AbortSignal): Promise<{ exists: boolean; reachable?: boolean; full?: string }> {
	const resolved = await git(repo, ["rev-parse", "--verify", "--quiet", `${commit}^{commit}`], signal);
	if (resolved.code !== 0) return { exists: false };
	const full = resolved.stdout.trim();
	if (ref === undefined) return { exists: true, full };
	const ancestor = await git(repo, ["merge-base", "--is-ancestor", full, ref], signal);
	if (ancestor.code !== 0 && ancestor.code !== 1) throw new Error(`git merge-base --is-ancestor ${full} ${ref} failed: ${ancestor.stderr.trim() || `exit ${ancestor.code}`}`);
	return { exists: true, reachable: ancestor.code === 0, full };
}

async function tree(cwd: string, signal?: AbortSignal): Promise<{ head: string; dirty: string }> {
	const head = await git(cwd, ["rev-parse", "HEAD"], signal);
	if (head.code !== 0) throw new Error(`${cwd} is not a git work tree: ${head.stderr.trim()}`);
	const status = await git(cwd, ["status", "--porcelain", "--untracked-files=no"], signal);
	if (status.code !== 0) throw new Error(`git status failed in ${cwd}: ${status.stderr.trim()}`);
	return { head: head.stdout.trim(), dirty: status.stdout.trim() };
}

/**
 * Run one configured check in work tree `cwd`, which must sit exactly at `commit` with no tracked changes before and
 * after the run. The result passes only with exit code 0 and an unchanged, clean tree; output is kept as a hash and tail.
 */
export async function runCheck(check: string, spec: CheckSpec, cwd: string, commit: string, now: () => number, signal?: AbortSignal): Promise<CheckRun> {
	const before = await tree(cwd, signal);
	if (!sameCommit(commit, before.head)) throw new Error(`${cwd} is at ${before.head}, not ${commit}; check out the commit first`);
	if (before.dirty) throw new Error(`${cwd} has uncommitted tracked changes; a check must run on the committed tree:\n${before.dirty.slice(0, 1000)}`);
	const at = now();
	const timeoutSec = checkTimeoutSec(spec);
	const result = await run(spec.command, [], { cwd, timeoutMs: timeoutSec * 1000, shell: true, ...(signal ? { signal } : {}) });
	const durationMs = Math.max(0, now() - at);
	const after = await tree(cwd, signal);
	const output = `${result.stdout}${result.stderr ? `\n[stderr]\n${result.stderr}` : ""}`;
	let invalid: string | undefined;
	if (result.timedOut) invalid = `timed out after ${timeoutSec}s`;
	else if (after.head !== before.head) invalid = `HEAD moved to ${after.head} during the run`;
	else if (after.dirty) invalid = "tracked files changed during the run";
	return {
		check,
		commit: before.head,
		exitCode: result.code,
		passed: result.code === 0 && invalid === undefined,
		...(invalid !== undefined ? { invalid } : {}),
		at,
		durationMs,
		outputSha256: createHash("sha256").update(output).digest("hex"),
		outputTail: output.slice(-TAIL),
	};
}
