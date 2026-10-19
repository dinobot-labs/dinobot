import { describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { daemonRestartDependencies, restartDaemonAfterUpdate } from "../src/cli/update-restart.ts";
import { acquireDaemonLock, DaemonLockError } from "../src/core/daemon-lock.ts";
import packageJson from "../package.json" with { type: "json" };

const entrypoint = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const lockModule = fileURLToPath(new URL("../src/core/daemon-lock.ts", import.meta.url));
const START_MS = 20_000;
const STOP_MS = 12_000; // main.ts has a shared 10s shutdown deadline.

async function bounded<T>(task: Promise<T>, ms: number, diagnostics: () => string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			task,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`Deadline exceeded (${ms}ms)\n${diagnostics()}`)), ms);
			}),
		]);
	} finally { clearTimeout(timer); }
}

/** A port that was free a moment ago; the release-to-bind race is inherent because the manifest requires nonzero ports. */
async function freePort(): Promise<number> {
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") });
	const port = server.port!;
	await server.stop(true);
	return port;
}

type Exit = { code: number | null; signal: NodeJS.Signals | null };
type Proc = {
	readonly pid: number;
	ready(): Promise<void>;
	waitFor(text: string): Promise<void>;
	exit(ms?: number): Promise<Exit>;
	signal(signal: NodeJS.Signals): void;
	output(): string;
};

type Fixture = {
	readonly root: string;
	readonly dataDir: string;
	/** A manifest with only the client API on a fresh port, sharing this fixture's dataDir. */
	config(name: string): Promise<{ path: string; text: string; port: number }>;
	serve(config: string, env?: Record<string, string>): Proc;
	run(args: readonly string[]): Proc;
};

// No wrapper/preload: execute the actual CLI. Every fixture has a fresh HOME,
// cwd, YAML and dataDir; do not inherit credentials, proxy settings, NODE_OPTIONS,
// BUN_OPTIONS or DINOBOT_CONFIG from the machine running the tests.
// openai/gpt-4o-mini is catalog metadata, not a model request: no message, command,
// provider login, external channel or model submission is sent. This is not an OS network sandbox.
async function withFixture(body: (fixture: Fixture) => Promise<void>) {
	const root = await mkdtemp(join(tmpdir(), "daemon-lock-process-"));
	const children: { child: ChildProcess; closed: Promise<Exit> }[] = [];
	try {
		const dataDir = join(root, "data");
		await mkdir(dataDir);
		await writeFile(join(dataDir, "auth.json"), "{}\n", { mode: 0o600 });
		const start = (args: readonly string[], extra: Record<string, string> = {}): Proc => {
			const child = spawn(process.execPath, [...args], {
				cwd: root,
				env: { HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, TMPDIR: root, NO_COLOR: "1", ...extra },
				stdio: ["ignore", "pipe", "pipe"],
			});
			let output = "";
			let settled = false;
			let spawnError: Error | undefined;
			child.stdout!.on("data", chunk => { output = (output + chunk.toString()).slice(-65_536); });
			child.stderr!.on("data", chunk => { output = (output + chunk.toString()).slice(-65_536); });
			child.on("error", error => { spawnError = error; });
			const closed = new Promise<Exit>(resolve => child.once("close", (code, signal) => { settled = true; resolve({ code, signal }); }));
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
				ready: () => waitFor("dinobot up:"),
				waitFor,
				exit: (ms = STOP_MS) => bounded(closed, ms, () => output),
				signal(signal) { expect(child.kill(signal)).toBe(true); },
				output: () => output,
			};
		};
		await body({
			root,
			dataDir,
			async config(name) {
				const port = await freePort();
				const path = join(root, `${name}.yaml`);
				const text = [
					"bot:", "  enabled: true", `  dataDir: ${JSON.stringify(dataDir)}`,
					`  workspaceRoot: ${JSON.stringify(root)}`, "  toolMode: direct",
					"  model:", "    provider: openai", "    modelId: gpt-4o-mini",
					"channels: {}",
					"api:", `  port: ${port}`, "plugins: {}", "curation:", "  enabled: false",
					"skillEvolution:", "  observe: false", "  author: false", "  evaluate: false", "  autoPublish: false", "",
				].join("\n");
				await writeFile(path, text);
				return { path, text, port };
			},
			serve: (config, env) => start([entrypoint, "serve", "--config", config], env),
			run: (args) => start(args),
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

async function get(port: number, path: string): Promise<Response> {
	return fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(5_000), proxy: "", redirect: "error" });
}

async function postShutdown(port: number, pid: number): Promise<Response> {
	return fetch(`http://127.0.0.1:${port}/v1/daemon/shutdown`, {
		method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pid }),
		signal: AbortSignal.timeout(5_000), proxy: "", redirect: "error",
	});
}

async function postRestart(port: number, pid: number): Promise<Response> {
	return fetch(`http://127.0.0.1:${port}/v1/daemon/restart`, {
		method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pid }),
		signal: AbortSignal.timeout(70_000), proxy: "", redirect: "error",
	});
}

/** Polls by pid: a successor holds the old daemon's stdout pipe, so the old child's "close" event never fires. */
async function waitGone(pid: number): Promise<void> {
	for (;;) {
		try { process.kill(pid, 0); } catch { return; }
		await Bun.sleep(50);
	}
}

async function waitForPid(port: number, pid: number): Promise<Record<string, unknown>> {
	for (;;) {
		const info = await get(port, "/v1/daemon").then(response => response.ok ? response.json() as Promise<Record<string, unknown>> : undefined, () => undefined);
		if (info?.pid === pid) return info;
		await Bun.sleep(100);
	}
}

async function expectHealthy(port: number) {
	const response = await get(port, "/healthz");
	expect(response.status).toBe(200);
	expect(await response.text()).toBe("ok");
}

describe.skipIf(process.platform === "win32")("daemon lock", () => {
	test("another process holding the lock refuses acquisition until it dies, even by SIGKILL", async () => {
		await withFixture(async ({ root, dataDir, run }) => {
			const script = join(root, "hold.ts");
			await writeFile(script, [
				`import { acquireDaemonLock } from ${JSON.stringify(lockModule)};`,
				`acquireDaemonLock(${JSON.stringify(dataDir)});`,
				"console.log(\"held\");",
				"setInterval(() => {}, 1_000);", "",
			].join("\n"));
			const holder = run([script]);
			await holder.waitFor("held");
			let failure: unknown;
			try { acquireDaemonLock(dataDir).release(); } catch (error) { failure = error; }
			expect(failure).toBeInstanceOf(DaemonLockError);
			expect((failure as Error).message).toBe(`another dinobot daemon is already running for ${dataDir}`);
			holder.signal("SIGKILL");
			expect((await holder.exit()).signal).toBe("SIGKILL");
			// The OS dropped the lock with the dead process: no stale lock file blocks the next daemon.
			const lock = acquireDaemonLock(dataDir);
			expect(lock.path).toBe(join(dataDir, "daemon.lock"));
			lock.release();
			lock.release(); // idempotent
		});
	}, 40_000);

	test("a second serve on the same dataDir exits 1 while the first stays healthy; after SIGTERM a new one starts", async () => {
		await withFixture(async ({ dataDir, config, serve }) => {
			const a = await config("a");
			const b = await config("b");
			const first = serve(a.path);
			await first.ready();
			const second = serve(b.path);
			expect(await second.exit(START_MS)).toEqual({ code: 1, signal: null });
			expect(second.output()).toContain("already running");
			expect(second.output()).toContain(`dinobot: another dinobot daemon is already running for ${dataDir}`);
			expect(second.output()).not.toContain("dinobot up:");
			// The refused process never bound its API port.
			await expect(get(b.port, "/healthz")).rejects.toThrow();
			await expectHealthy(a.port);
			expect((await (await get(a.port, "/v1/daemon")).json() as { pid: number }).pid).toBe(first.pid);

			first.signal("SIGTERM");
			expect(await first.exit()).toEqual({ code: 0, signal: null });
			const third = serve(b.path);
			await third.ready();
			await expectHealthy(b.port);
			third.signal("SIGTERM");
			expect(await third.exit()).toEqual({ code: 0, signal: null });
		});
	}, 60_000);

	test("a TUI-owned daemon reports its identity and stops gracefully on POST /v1/daemon/shutdown", async () => {
		await withFixture(async ({ config, serve }) => {
			const manifest = await config("tui");
			const daemon = serve(manifest.path, { DINOBOT_DAEMON_OWNER: "tui" });
			await daemon.ready();
			const response = await get(manifest.port, "/v1/daemon");
			expect(response.status).toBe(200);
			const info = await response.json() as Record<string, unknown>;
			expect(info).toMatchObject({
				pid: daemon.pid,
				version: packageJson.version,
				manifestPath: await realpath(manifest.path),
				manifestSha256: createHash("sha256").update(manifest.text).digest("hex"),
				owner: "tui",
				busy: [],
				setup: {},
			});
			expect(Number.isNaN(Date.parse(String(info.startedAt)))).toBe(false);

			const wrong = await postShutdown(manifest.port, daemon.pid + 1);
			expect(wrong.status).toBe(409);
			expect(await wrong.json()).toEqual({ status: "refused", error: "pid" });
			await expectHealthy(manifest.port);

			const accepted = await postShutdown(manifest.port, daemon.pid);
			expect(accepted.status).toBe(202);
			expect(await accepted.json()).toEqual({ status: "stopping" });
			expect(await daemon.exit()).toEqual({ code: 0, signal: null });
			expect(daemon.output()).toContain("dinobot: restart requested, shutting down");
		});
	}, 60_000);

	test("an externally started daemon refuses shutdown and keeps running", async () => {
		await withFixture(async ({ config, serve }) => {
			const manifest = await config("external");
			const daemon = serve(manifest.path);
			await daemon.ready();
			expect(await (await get(manifest.port, "/v1/daemon")).json()).toMatchObject({ pid: daemon.pid, owner: "external" });
			const refused = await postShutdown(manifest.port, daemon.pid);
			expect(refused.status).toBe(409);
			expect(await refused.json()).toEqual({ status: "refused", error: "external" });
			await Bun.sleep(500);
			await expectHealthy(manifest.port);
			expect(daemon.output()).not.toContain("shutting down");
			daemon.signal("SIGTERM");
			expect(await daemon.exit()).toEqual({ code: 0, signal: null });
		});
	}, 60_000);

	test("POST /v1/daemon/restart hands over to a successor with the same argv and owner, then the old daemon exits 0", async () => {
		await withFixture(async ({ dataDir, config, serve }) => {
			const manifest = await config("restart");
			const first = serve(manifest.path, { DINOBOT_DAEMON_OWNER: "tui" });
			await first.ready();
			let successor = 0;
			try {
				const wrong = await postRestart(manifest.port, first.pid + 1);
				expect(wrong.status).toBe(409);
				const response = await postRestart(manifest.port, first.pid);
				expect(response.status).toBe(202);
				const body = await response.json() as { status: string; successorPid: number; busy: string[] };
				successor = body.successorPid;
				expect(body).toEqual({ status: "restarting", successorPid: successor, busy: [] });
				expect(successor).not.toBe(first.pid);
				await bounded(waitGone(first.pid), STOP_MS, first.output);
				const info = await bounded(waitForPid(manifest.port, successor), START_MS, first.output);
				// The successor inherited the owner marker and the stdout of its predecessor.
				expect(info).toMatchObject({ pid: successor, version: packageJson.version, owner: "tui", manifestPath: await realpath(manifest.path) });
				expect(first.output()).toContain("dinobot: restart requested by update, shutting down");
				expect(first.output().split("dinobot up:").length - 1).toBe(2);
				expect((await readdir(dataDir)).filter(name => name.startsWith("restart-"))).toEqual([]);
			} finally {
				if (successor) {
					try { process.kill(successor, "SIGTERM"); } catch { /* already gone */ }
					await bounded(waitGone(successor), STOP_MS, first.output);
				}
			}
		});
	}, 90_000);

	test("a successor that cannot boot is reported and the running daemon is left untouched", async () => {
		await withFixture(async ({ dataDir, config, serve }) => {
			const manifest = await config("broken");
			const daemon = serve(manifest.path);
			await daemon.ready();
			// The installed update would reject the manifest: the successor exits before it is ready.
			await writeFile(manifest.path, "bot: [\n");
			const response = await postRestart(manifest.port, daemon.pid);
			expect(response.status).toBe(500);
			expect(await response.json()).toMatchObject({ status: "failed", error: "successor" });
			await Bun.sleep(500);
			await expectHealthy(manifest.port);
			expect((await (await get(manifest.port, "/v1/daemon")).json() as { pid: number }).pid).toBe(daemon.pid);
			expect(daemon.output()).not.toContain("shutting down");
			expect((await readdir(dataDir)).filter(name => name.startsWith("restart-"))).toEqual([]);
			daemon.signal("SIGTERM");
			expect(await daemon.exit()).toEqual({ code: 0, signal: null });
		});
	}, 60_000);

	test("restartDaemonAfterUpdate drives a real daemon through the handoff and verifies the version that came back", async () => {
		await withFixture(async ({ root, config, serve }) => {
			const manifest = await config("updater");
			const first = serve(manifest.path);
			await first.ready();
			let successor = 0;
			try {
				const logs: string[] = [];
				const errors: string[] = [];
				// The fixture runs the current source, so the version that comes back is packageJson.version, not this target.
				const status = await restartDaemonAfterUpdate("999.0.0", {
					...daemonRestartDependencies(manifest.path), env: {}, cwd: root, home: root,
					log: (message) => logs.push(message), error: (message) => errors.push(message),
				});
				expect(logs.join("\n")).toContain(packageJson.version + " → 999.0.0");
				expect(status).toBe(1);
				expect(errors.join("\n")).toContain("runs " + packageJson.version + ", not 999.0.0");
				await bounded(waitGone(first.pid), STOP_MS, first.output);
				successor = Number((await (await get(manifest.port, "/v1/daemon")).json() as { pid: number }).pid);
				expect(successor).not.toBe(first.pid);
				// Same version on both sides: nothing to restart.
				logs.length = 0;
				expect(await restartDaemonAfterUpdate(packageJson.version, { ...daemonRestartDependencies(manifest.path), env: {}, cwd: root, home: root, log: (m) => logs.push(m), error: (m) => errors.push(m) })).toBe(0);
				expect(logs.at(-1)).toContain("already runs dinobot " + packageJson.version);
			} finally {
				if (successor) {
					try { process.kill(successor, "SIGTERM"); } catch { /* already gone */ }
					await bounded(waitGone(successor), STOP_MS, first.output);
				}
			}
		});
	}, 120_000);
});
