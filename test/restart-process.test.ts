import { describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const entrypoint = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const START_MS = 20_000;
const STOP_MS = 12_000; // main.ts has a shared 10s shutdown deadline.

// No wrapper/preload: execute the actual CLI (`dinobot restart`). Every fixture has a fresh HOME,
// cwd, YAML and dataDir; nothing is inherited from the machine running the tests. The model in the
// manifest is catalog metadata, not a model request: no message or provider call is ever sent.
async function withFixture(body: (fixture: {
	root: string;
	dataDir: string;
	config(name: string, api?: boolean): Promise<{ path: string; port: number }>;
	serve(config: string): Proc;
	restart(config: string, force?: boolean): Proc;
}) => Promise<void>) {
	const root = await mkdtemp(join(tmpdir(), "restart-command-"));
	const children: { child: ChildProcess; closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> }[] = [];
	try {
		const dataDir = join(root, "data");
		await mkdir(dataDir);
		await writeFile(join(dataDir, "auth.json"), "{}\n", { mode: 0o600 });
		const start = (args: readonly string[]): Proc => {
			const child = spawn(process.execPath, [...args], {
				cwd: root,
				env: { HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, TMPDIR: root, NO_COLOR: "1" },
				stdio: ["ignore", "pipe", "pipe"],
			});
			let output = "";
			let settled = false;
			let spawnError: Error | undefined;
			child.stdout!.on("data", chunk => { output = (output + chunk.toString()).slice(-65_536); });
			child.stderr!.on("data", chunk => { output = (output + chunk.toString()).slice(-65_536); });
			child.on("error", error => { spawnError = error; });
			const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once("close", (code, signal) => { settled = true; resolve({ code, signal }); }));
			children.push({ child, closed });
			const waitFor = async (text: string) => {
				const deadline = Date.now() + START_MS;
				while (!output.includes(text)) {
					if (settled || spawnError || Date.now() >= deadline) throw new Error(`Process never printed ${JSON.stringify(text)}: ${spawnError ?? ""}\n${output}`);
					await Bun.sleep(20);
				}
			};
			return {
				pid: child.pid!,
				waitFor,
				exit: (ms = STOP_MS) => Promise.race([
					closed,
					new Promise<never>((_, reject) => { setTimeout(() => reject(new Error(`Deadline exceeded (${ms}ms)\n${output}`)), ms); }),
				]),
				output: () => output,
			};
		};
		const freePort = async () => {
			const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") });
			const port = server.port!;
			await server.stop(true);
			return port;
		};
		await body({
			root,
			dataDir,
			async config(name, api = true) {
				const port = await freePort();
				const path = join(root, `${name}.yaml`);
				const text = [
					"bot:", "  enabled: true", `  dataDir: ${JSON.stringify(dataDir)}`,
					`  workspaceRoot: ${JSON.stringify(root)}`, "  toolMode: direct",
					"  model:", "    provider: openai", "    modelId: gpt-4o-mini",
					"channels: {}",
					...(api ? ["api:", `  port: ${port}`] : []),
					"plugins: {}", "curation:", "  enabled: false",
					"skillEvolution:", "  observe: false", "  author: false", "  evaluate: false", "  autoPublish: false", "",
				].join("\n");
				await writeFile(path, text);
				return { path, port };
			},
			serve: (config) => start([entrypoint, "serve", "--config", config]),
			restart: (config, force = false) => start([entrypoint, "restart", ...(force ? ["--force"] : []), "--config", config]),
		});
	} finally {
		// Always reap, including assertion failures and readiness timeouts.
		try {
			for (const { child, closed } of children) {
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
				await closed;
			}
		} finally { await rm(root, { recursive: true, force: true }); }
	}
}

type Proc = {
	readonly pid: number;
	waitFor(text: string): Promise<void>;
	exit(ms?: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
	output(): string;
};

const daemonPid = async (port: number): Promise<number> => {
	for (;;) {
		const info = await fetch(`http://127.0.0.1:${port}/v1/daemon`, { signal: AbortSignal.timeout(5_000), proxy: "", redirect: "error" })
			.then(response => response.ok ? response.json() as Promise<{ pid: number }> : undefined, () => undefined);
		if (info) return info.pid;
		await Bun.sleep(100);
	}
};

const waitGone = async (pid: number): Promise<void> => {
	for (;;) {
		try { process.kill(pid, 0); } catch { return; }
		await Bun.sleep(50);
	}
};

/** Kill a daemon this process tree does not own (started detached by `dinobot restart`) and await its exit. */
async function reapDaemon(pid: number): Promise<void> {
	try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
	await waitGone(pid);
}

describe.skipIf(process.platform === "win32")("dinobot restart", () => {
	test("restarts a running daemon through the handoff and waits for the new pid", async () => {
		await withFixture(async ({ config, serve, restart }) => {
			const manifest = await config("running");
			const daemon = serve(manifest.path);
			await daemon.waitFor("dinobot up:");
			const oldPid = await daemonPid(manifest.port);

			const cli = restart(manifest.path);
			const exit = await cli.exit(START_MS + STOP_MS);
			expect(exit).toEqual({ code: 0, signal: null });
			expect(cli.output()).toContain(`Restarting the daemon (pid ${oldPid})...`);
			const newPid = (await daemonPid(manifest.port));
			expect(newPid).not.toBe(oldPid);
			expect(cli.output()).toContain(`Daemon restarted (pid ${newPid}, dinobot `);
			// The old daemon shut down gracefully; the successor answers on the same port.
			expect(daemon.output()).toContain("dinobot: restart requested by update, shutting down");
			expect(await fetch(`http://127.0.0.1:${manifest.port}/healthz`, { proxy: "", redirect: "error" })).toHaveProperty("status", 200);
			await reapDaemon(newPid);
		});
	}, 90_000);

	test("starts a daemon when none is running (idempotent restart)", async () => {
		await withFixture(async ({ config, restart }) => {
			const manifest = await config("down");
			const cli = restart(manifest.path);
			const exit = await cli.exit(START_MS);
			expect(exit).toEqual({ code: 0, signal: null });
			expect(cli.output()).toContain("No daemon is running on http://127.0.0.1:" + manifest.port);
			const pid = await daemonPid(manifest.port);
			expect(cli.output()).toContain(`Daemon started (pid ${pid}, dinobot `);
			expect(await fetch(`http://127.0.0.1:${manifest.port}/healthz`, { proxy: "", redirect: "error" })).toHaveProperty("status", 200);
			await reapDaemon(pid);
		});
	}, 60_000);

	test("a manifest without an api section or channel is refused before restarting", async () => {
		await withFixture(async ({ config, restart }) => {
			const manifest = await config("noapi", false);
			const cli = restart(manifest.path);
			expect(await cli.exit(START_MS)).toEqual({ code: 1, signal: null });
			expect(cli.output()).toContain("an enabled bot needs at least one channel or the api");
		});
	}, 60_000);
});
