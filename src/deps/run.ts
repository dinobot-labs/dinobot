export type RunResult = { code: number; stdout: string; stderr: string };

export function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? "aborted"));
}

/** Run a program to completion with piped output; killed on abort or after `timeoutMs`. */
export async function run(argv: string[], options: { signal?: AbortSignal; timeoutMs: number; env?: Record<string, string> }): Promise<RunResult> {
	const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore", ...(options.env ? { env: options.env } : {}) });
	const kill = () => child.kill();
	options.signal?.addEventListener("abort", kill, { once: true });
	const timer = setTimeout(kill, options.timeoutMs);
	try {
		const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		if (options.signal?.aborted) throw abortReason(options.signal);
		return { code, stdout, stderr };
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", kill);
	}
}
