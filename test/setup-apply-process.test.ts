import { describe, expect, test } from "bun:test";
import { closeSync, openSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyManifestChange } from "../src/setup/apply.ts";
import { editManifestEntry } from "../src/setup/manifest-edit.ts";
import { sha256Hex } from "../src/setup/manifest-file.ts";
import { ApiClient } from "../src/tui/client.ts";
import { applyPorts } from "../src/tui/setup-apply.ts";

/**
 * End to end against real `dinobot serve` processes (no wrapper): the TUI-side apply transaction restarts a TUI-owned
 * daemon onto new settings, rolls back when the new settings cannot boot, and never stops a daemon it does not own.
 * Fresh HOME/cwd/dataDir per test; openai/gpt-4o-mini is catalog metadata only, no model request is made.
 */
const entrypoint = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const START_MS = 20_000;

async function freePort(): Promise<number> {
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") });
	const port = server.port!;
	await server.stop(true);
	return port;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function withDaemon(owner: "tui" | "external", body: (fixture: { path: string; base: string; dataDir: string; client: ApiClient; firstPid: number; spawn: (path: string) => Promise<{ pid: number; exited(): boolean }> }) => Promise<void>) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "setup-apply-process-")));
	const dataDir = join(root, "data");
	await mkdir(dataDir);
	await writeFile(join(dataDir, "auth.json"), "{}\n", { mode: 0o600 });
	const port = await freePort();
	const path = join(root, "dinobot.yaml");
	const base = [
		"# hand-written comment that must survive",
		"bot:", "  enabled: true", `  dataDir: ${JSON.stringify(dataDir)}`, `  workspaceRoot: ${JSON.stringify(root)}`, "  toolMode: direct",
		"  model:", "    provider: openai", "    modelId: gpt-4o-mini",
		"api:", `  port: ${port}`,
		"channels: {}",
		"plugins: {}         # web search is on by default",
		"curation:", "  enabled: false",
		"skillEvolution:", "  observe: false", "  author: false", "  evaluate: false", "  autoPublish: false", "",
	].join("\n");
	await writeFile(path, base);
	const env = { HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, TMPDIR: root, NO_COLOR: "1", PATH: process.env.PATH ?? "/usr/bin:/bin" };
	const spawned: Bun.Subprocess[] = [];
	// What src/tui/daemon.ts spawnDaemon does, with this test's entry point instead of the test runner's own argv.
	const spawn = async (manifestPath: string, marker = owner === "tui") => {
		const log = openSync(join(dataDir, "dinobot.log"), "a");
		try {
			const child = Bun.spawn([process.execPath, entrypoint, "serve", "--config", manifestPath], { cwd: root, stdio: ["ignore", log, log], env: { ...env, ...(marker ? { DINOBOT_DAEMON_OWNER: "tui" } : {}) } });
			spawned.push(child);
			return { pid: child.pid, exited: () => child.exitCode !== null || child.signalCode !== null };
		} finally {
			closeSync(log);
		}
	};
	const client = new ApiClient(new URL(`http://127.0.0.1:${port}`));
	try {
		const first = await spawn(path);
		const deadline = Date.now() + START_MS;
		while (!(await client.healthy())) {
			if (first.exited() || Date.now() > deadline) throw new Error(`daemon did not start:\n${await readFile(join(dataDir, "dinobot.log"), "utf8").catch(() => "")}`);
			await Bun.sleep(50);
		}
		await body({ path, base, dataDir, client, firstPid: first.pid, spawn: (manifestPath) => spawn(manifestPath, true) });
	} finally {
		for (const child of spawned) if (child.exitCode === null) child.kill("SIGTERM");
		await Promise.allSettled(spawned.map((child) => Promise.race([child.exited, Bun.sleep(15_000).then(() => child.kill("SIGKILL"))])));
		await rm(root, { recursive: true, force: true });
	}
}

async function pluginsOf(client: ApiClient): Promise<string> {
	let text = "";
	await client.runCommand("tui", "check", "plugins", "", "test", (event) => {
		if (event.type === "output") text += event.text;
	}, new AbortController().signal);
	return text;
}

describe("setup apply against real daemons", () => {
	test("restarts a TUI-owned daemon onto the candidate: old pid gone, new daemon booted the exact new text, comments and .bak kept", async () => {
		await withDaemon("tui", async ({ path, base, dataDir, client, firstPid, spawn }) => {
			const candidate = editManifestEntry(base, "plugins", "computer", {});
			expect((await client.daemonInfo())?.owner).toBe("tui");
			expect(await pluginsOf(client)).not.toContain("computer");
			const outcome = await applyManifestChange(
				{ manifestPath: path, baseSha256: sha256Hex(base), candidate, changes: [], summary: [], locale: "en" },
				{ ...applyPorts(client, dataDir), spawn },
			);
			expect(outcome).toEqual({ status: "applied" });
			expect(alive(firstPid)).toBe(false);
			const info = (await client.daemonInfo())!;
			expect(info.pid).not.toBe(firstPid);
			expect(info.manifestSha256).toBe(sha256Hex(candidate));
			expect(info.owner).toBe("tui");
			expect(await readFile(path, "utf8")).toBe(candidate);
			expect(candidate).toContain("# hand-written comment that must survive");
			expect(candidate).toContain("# web search is on by default");
			expect(await readFile(`${path}.bak`, "utf8")).toBe(base);
			expect(await pluginsOf(client)).toContain("computer");
		});
	}, 90_000);

	test("new settings that fail to boot (port already taken) roll back: base on disk, a daemon on the base again", async () => {
		const blocker = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("taken") });
		try {
			await withDaemon("tui", async ({ path, base, dataDir, client, firstPid, spawn }) => {
				const candidate = editManifestEntry(base, "channels", "http", { port: blocker.port! });
				const outcome = await applyManifestChange(
					{ manifestPath: path, baseSha256: sha256Hex(base), candidate, changes: [], summary: [], locale: "en" },
					{ ...applyPorts(client, dataDir), spawn },
				);
				expect(outcome.status).toBe("rolled_back");
				expect(outcome.status === "rolled_back" && outcome.reason).toBe("the daemon exited during startup");
				expect(alive(firstPid)).toBe(false);
				const info = (await client.daemonInfo())!;
				expect(info.pid).not.toBe(firstPid);
				expect(info.manifestSha256).toBe(sha256Hex(base));
				expect(await readFile(path, "utf8")).toBe(base);
				expect(await Bun.file(`${path}.setup-journal.json`).exists()).toBe(false);
			});
		} finally {
			await blocker.stop(true);
		}
	}, 90_000);

	test("a daemon not started by a TUI is never stopped: the settings are saved for its owner", async () => {
		await withDaemon("external", async ({ path, base, dataDir, client, firstPid, spawn }) => {
			const candidate = editManifestEntry(base, "plugins", "computer", {});
			const outcome = await applyManifestChange(
				{ manifestPath: path, baseSha256: sha256Hex(base), candidate, changes: [], summary: [], locale: "en" },
				{ ...applyPorts(client, dataDir), spawn },
			);
			expect(outcome).toEqual({ status: "saved_external" });
			expect(alive(firstPid)).toBe(true);
			const info = (await client.daemonInfo())!;
			expect(info.pid).toBe(firstPid);
			expect(info.owner).toBe("external");
			expect(info.manifestSha256).toBe(sha256Hex(base));
			expect(await readFile(path, "utf8")).toBe(candidate);
		});
	}, 60_000);
});
