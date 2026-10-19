import { expect, test } from "bun:test";
import { runSkillSandbox } from "../src/core/skills/sandbox.ts";

test("fixture execution cannot access host home, network interfaces or writable fixture", async () => {
	// Given a host-owned fixture exposed read-only in a fresh namespace.
	const signal = new AbortController().signal;
	// When the actual OS boundary is probed, not a mocked subprocess.
	const result = await runSkillSandbox({
		fixtureDirectory: import.meta.dir,
		command: ["/usr/bin/sh", "-c", [
			"test ! -e /home/roach",
			"test -z \"$HOME\"",
			"test -r /fixture/skill-sandbox.test.ts",
			"! touch /fixture/should-not-exist",
			"test \"$(wc -l < /proc/net/route)\" = 1",
			"printf isolated",
		].join(" && ")],
		timeoutMs: 5000, maxOutputBytes: 4096, signal,
	});
	// Then host files are inaccessible and immutable while the fixture is readable.
	expect(result.status, result.stderr).toBe("completed");
	expect(result.exitCode).toBe(0);
	expect(result.stdout).toBe("isolated");
});

test("sandbox output is bounded even when an untrusted program floods stdout", async () => {
	// Given a finite output budget.
	const signal = new AbortController().signal;
	// When the fixture exceeds it without terminating.
	const result = await runSkillSandbox({
		fixtureDirectory: import.meta.dir,
		command: ["/usr/bin/yes"],
		timeoutMs: 5000, maxOutputBytes: 1024, signal,
	});
	// Then the namespace is terminated and retained output stays bounded.
	expect(result.status, result.stderr).toBe("output_limit");
	expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(1024);
});

test("pre-cancelled fixture execution never starts", async () => {
	// Given cancellation before admission.
	const controller = new AbortController();
	controller.abort(new Error("cancelled fixture"));
	// When a run is requested.
	const result = runSkillSandbox({
		fixtureDirectory: import.meta.dir, command: ["/usr/bin/true"],
		timeoutMs: 5000, maxOutputBytes: 1024, signal: controller.signal,
	});
	// Then cancellation propagates before spawn.
	await expect(result).rejects.toThrow("cancelled fixture");
});
