import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";

/** Host-owned fixture specification. Never accept this object from an author tool. */
export type SkillSandboxRun = {
	readonly fixtureDirectory: string;
	readonly command: readonly [string, ...string[]];
	readonly timeoutMs: number;
	readonly maxOutputBytes: number;
	readonly signal: AbortSignal;
};

export type SkillSandboxResult = {
	readonly status: "completed" | "failed" | "cancelled" | "timeout" | "output_limit";
	readonly exitCode: number | null;
	readonly stdout: string;
	readonly stderr: string;
};

/**
 * Linux fixture execution: no host network, home, credentials, writable host mount,
 * or inherited environment. The fixture is read-only; scratch disappears on exit.
 * A transient user cgroup enforces one CPU, 512 MiB and 64 processes.
 * Missing systemd/cgroup support fails closed; there is no unsandboxed fallback.
 */
export async function runSkillSandbox(input: SkillSandboxRun): Promise<SkillSandboxResult> {
	if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 ||
		!Number.isSafeInteger(input.maxOutputBytes) || input.maxOutputBytes < 1 || input.maxOutputBytes > 1024 * 1024) {
		throw new RangeError("Sandbox timeout and output limits must be positive safe integers");
	}
	input.signal.throwIfAborted();
	const fixture = await realpath(input.fixtureDirectory);
	input.signal.throwIfAborted();
	const args = [
		"--unshare-all", "--die-with-parent", "--new-session", "--clearenv",
		"--ro-bind", "/usr", "/usr",
		// Preserve the host loader layout: Ubuntu uses /usr/lib64, Arch uses /usr/lib.
		// Both mounts remain read-only; no host home/network or unsandboxed fallback is exposed.
		"--ro-bind", "/lib", "/lib", "--ro-bind-try", "/lib64", "/lib64",
		"--symlink", "usr/bin", "/bin", "--proc", "/proc", "--dev", "/dev",
		"--tmpfs", "/tmp", "--ro-bind", fixture, "/fixture",
		"--chdir", "/tmp", "--setenv", "PATH", "/usr/bin",
		"--", ...input.command,
	];
	const child = spawn("/usr/bin/systemd-run", [
		"--user", "--scope", "--quiet", "--collect",
		"--property=MemoryMax=536870912", "--property=MemorySwapMax=0",
		"--property=CPUQuota=100%", "--property=TasksMax=64",
		"/usr/bin/bwrap", ...args,
	], {
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...(process.env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR } : {}),
			...(process.env.DBUS_SESSION_BUS_ADDRESS ? { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS } : {}),
		},
	});
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	let bytes = 0;
	let interrupted: SkillSandboxResult["status"] | undefined;
	const interrupt = (status: SkillSandboxResult["status"]) => {
		if (interrupted !== undefined) return;
		interrupted = status;
		child.kill("SIGKILL");
	};
	const capture = (chunks: Buffer[], chunk: Buffer) => {
		const remaining = Math.max(0, input.maxOutputBytes - bytes);
		if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
		bytes += chunk.length;
		if (bytes > input.maxOutputBytes) interrupt("output_limit");
	};
	child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
	child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
	const abort = () => interrupt("cancelled");
	input.signal.addEventListener("abort", abort, { once: true });
	if (input.signal.aborted) abort();
	const timeout = setTimeout(() => interrupt("timeout"), input.timeoutMs);
	try {
		const exitCode = await new Promise<number | null>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", resolve);
		});
		return {
			status: interrupted ?? (exitCode === 0 ? "completed" : "failed"),
			exitCode,
			stdout: Buffer.concat(stdout).toString("utf8"),
			stderr: Buffer.concat(stderr).toString("utf8"),
		};
	} finally {
		clearTimeout(timeout);
		input.signal.removeEventListener("abort", abort);
	}
}
