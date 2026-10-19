import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const entrypoint = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const START_MS = 20_000;
const STOP_MS = 12_000; // main.ts has a shared 10s shutdown deadline.

function listener(port = 0) {
	return Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("reserved") });
}

async function bounded<T>(task: Promise<T>, ms: number, diagnostics: () => string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			task,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`Daemon deadline exceeded (${ms}ms)\n${diagnostics()}`)), ms);
			}),
		]);
	} finally { clearTimeout(timer); }
}

// No wrapper/preload: execute the actual CLI. Every fixture has a fresh HOME,
// cwd, YAML and dataDir; do not inherit credentials, proxy settings, NODE_OPTIONS,
// BUN_OPTIONS or DINOBOT_CONFIG from the machine running the tests.
// createBotModels reads bundled metadata synchronously; openAuth reads only this
// dataDir/auth.json. openai/gpt-4o-mini is catalog metadata, not a model request.
// Only GET /healthz is sent. No message/command endpoint, provider login, external
// channel, review/author job, or model submission is used. This is not an OS network sandbox.
async function withDaemon(conflict: boolean, run: (daemon: {
	ports: readonly [number, number];
	ready(): Promise<void>;
	health(): Promise<void>;
	signal(signal: "SIGTERM" | "SIGINT"): void;
	exit(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
	output(): string;
}) => Promise<void>) {
	const root = await mkdtemp(join(tmpdir(), "daemon-process-"));
	const reservations: ReturnType<typeof listener>[] = [];
	let child: ReturnType<typeof spawn> | undefined;
	let exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
	let output = "";
	try {
		reservations.push(listener());
		reservations.push(listener());
		const ports = [reservations[0]!.port!, reservations[1]!.port!] as const;
		const dataDir = join(root, "data");
		await mkdir(dataDir);
		await writeFile(join(dataDir, "auth.json"), "{}\n", { mode: 0o600 });
		const config = join(root, "daemon.yaml");
		await writeFile(config, [
			"bot:", "  enabled: true", `  dataDir: ${JSON.stringify(dataDir)}`,
			`  workspaceRoot: ${JSON.stringify(root)}`, "  toolMode: direct",
			"  model:", "    provider: openai", "    modelId: gpt-4o-mini",
			"channels:", "  http:", `    port: ${ports[0]}`,
			"api:", `  port: ${ports[1]}`, "plugins: {}", "curation:", "  enabled: false",
			"skillEvolution:", "  observe: false", "  author: false", "  evaluate: false", "  autoPublish: false", "",
		].join("\n"));
		await reservations[0]!.stop(true);
		if (!conflict) await reservations[1]!.stop(true);
		// Port selection necessarily has a small release-to-bind race because the
		// manifest requires nonzero ports. Hold the conflict port throughout the child run.
		child = spawn(process.execPath, [entrypoint, "serve", "--config", config], {
			cwd: root,
			env: { HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, TMPDIR: root, NO_COLOR: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		child.stdout!.on("data", chunk => { output = (output + chunk.toString()).slice(-65_536); });
		child.stderr!.on("data", chunk => { output = (output + chunk.toString()).slice(-65_536); });
		let settled = false;
		let spawnError: Error | undefined;
		child.on("error", error => { spawnError = error; });
		exited = new Promise(resolve => child!.once("close", (code, signal) => {
			settled = true;
			resolve({ code, signal });
		}));
		const processExit = exited;
		await run({
			ports,
			async ready() {
				const deadline = Date.now() + START_MS;
				while (!output.includes("dinobot up:")) {
					if (settled || spawnError || Date.now() >= deadline) {
						throw new Error(`Daemon failed to become ready: ${spawnError ?? ""}\n${output}`);
					}
					await Bun.sleep(20);
				}
			},
			async health() {
				for (const port of ports) {
					const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
						signal: AbortSignal.timeout(2_000), proxy: "", redirect: "error",
					});
					expect(response.status).toBe(200);
					expect(await response.text()).toBe("ok");
				}
			},
			signal(signal) { expect(child!.kill(signal)).toBe(true); },
			exit: () => bounded(processExit, STOP_MS, () => output),
			output: () => output,
		});
	} finally {
		// Always reap, including assertion failures, readiness timeouts and spawn errors.
		try {
			if (child) {
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
				await exited;
			}
		} finally {
			try { for (const server of reservations) await server.stop(true); }
			finally { await rm(root, { recursive: true, force: true }); }
		}
	}
}

async function expectReusable(ports: readonly number[]) {
	const servers: ReturnType<typeof listener>[] = [];
	try {
		for (const port of ports) servers.push(listener(port));
		expect(servers.map(server => server.port)).toEqual([...ports]);
	} finally { for (const server of servers) await server.stop(true); }
}

// Windows does not deliver POSIX SIGINT/SIGTERM with these semantics.
describe.skipIf(process.platform === "win32")("real serve process lifecycle", () => {
	for (const signal of ["SIGTERM", "SIGINT"] as const) {
		test(`healthy startup then ${signal} exits zero within deadline and releases both ports`, async () => {
			await withDaemon(false, async daemon => {
				await daemon.ready();
				await daemon.health();
				daemon.signal(signal);
				expect(await daemon.exit()).toEqual({ code: 0, signal: null });
				expect(daemon.output()).toContain(`dinobot: ${signal}, shutting down`);
				await expectReusable(daemon.ports);
			});
		}, 40_000);
	}

	test("second listener conflict exits nonzero and releases earlier HTTP listener", async () => {
		await withDaemon(true, async daemon => {
			const result = await daemon.exit();
			expect(result.signal).toBeNull();
			expect(result.code).not.toBeNull();
			expect(result.code).not.toBe(0);
			expect(daemon.output()).toContain("start client API failed");
			expect(daemon.output()).toMatch(/EADDRINUSE|address already in use/);
			// The error must be the second listener, not an unrelated boot failure.
			expect(daemon.output()).toContain("startClientApi");
			expect(daemon.output()).not.toContain("dinobot up:");
			await expectReusable([daemon.ports[0]]);
			const held = await fetch(`http://127.0.0.1:${daemon.ports[1]}/healthz`, {
				signal: AbortSignal.timeout(2_000), proxy: "", redirect: "error",
			});
			expect(await held.text()).toBe("reserved");
		});
	}, 40_000);
});
