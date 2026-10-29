import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DaemonInfo } from "../src/core/daemon-info.ts";
import { acquireRestartLease, restartLegacy, type LegacyPorts } from "../src/cli/legacy-restart.ts";
import { runRestart, type RestartDependencies } from "../src/cli/restart.ts";

async function fixture(body: (f: { deps: RestartDependencies; before: DaemonInfo; ports: LegacyPorts; errors: string[]; signals: number[]; spawned: () => number; setInfo: (v: DaemonInfo | undefined) => void; setAlive: (v: string | null) => void }) => Promise<void>) {
	const root = await mkdtemp(join(import.meta.dir, ".legacy-"));
	try {
		const manifestPath = join(await realpath(root), "dinobot.yaml");
		await writeFile(manifestPath, "manifest");
		const before = { pid: 12345, owner: "external", manifestPath, manifestSha256: createHash("sha256").update("manifest").digest("hex"), startedAt: new Date().toISOString(), busy: [], version: "old" } as unknown as DaemonInfo;
		let current: DaemonInfo | undefined = before;
		let alive: string | null = "birth-1";
		let count = 0, clock = 0;
		const signals: number[] = [], errors: string[] = [];
		const ports: LegacyPorts = { probe: () => ({ identity: "birth-1" }), identity: () => alive, terminate(pid) { signals.push(pid); alive = null; current = undefined; } };
		const deps: RestartDependencies = { port: 1234, dataDir: root, manifestPath, force: false, now: () => clock, sleep: async ms => { clock += ms; },
			fetch: (async (input) => {
				if (String(input).endsWith("/restart")) return new Response("", { status: 404 });
				if (!current) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
				return Response.json(current);
			}) as typeof fetch, log: () => {}, error: s => errors.push(s), logTail: async () => "log tail", startMs: 300, comebackMs: 300,
			spawn: async () => { count++; current = { ...before, pid: 23456, version: "new" }; return { pid: 23456 }; },
		};
		deps.legacyRestart = before => restartLegacy(deps, before, ports);
		await body({ deps, before, ports, errors, signals, spawned: () => count, setInfo: v => { current = v; }, setAlive: v => { alive = v; } });
	} finally { await rm(root, { recursive: true, force: true }); }
}

test("external legacy 404: verified graceful stop then exact replacement", async () => fixture(async f => {
	expect(await runRestart(f.deps)).toBe(0); expect(f.signals).toEqual([f.before.pid]); expect(f.spawned()).toBe(1); expect(f.errors).toEqual([]);
}));
for (const failure of ["503", "malformed JSON", "timeout", "404", "reset", "unknown"] as const) test("post-stop " + failure + " refuses replacement without spawning", async () => fixture(async f => {
	const originalFetch = f.deps.fetch;
	f.deps.fetch = (async (url, init) => {
		if (f.signals.length && !f.spawned()) {
			if (failure === "timeout") throw new DOMException("Timed out", "TimeoutError");
			if (failure === "reset") throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
			if (failure === "unknown") throw new Error("offline");
			return new Response("not JSON", { status: failure === "503" ? 503 : failure === "404" ? 404 : 200 });
		}
		return originalFetch(url, init);
	}) as typeof fetch;
	expect(await restartLegacy(f.deps, f.before, f.ports)).toBe(1);
	expect(f.signals).toEqual([f.before.pid]);
	expect(f.spawned()).toBe(0);
	expect(f.errors.join()).toContain("old daemon has stopped");
}));

for (const code of ["ECONNREFUSED", "ConnectionRefused"]) test("confirmed " + code + " after stop permits exactly one replacement", async () => fixture(async f => {
	const originalFetch = f.deps.fetch;
	f.deps.fetch = (async (url, init) => {
		if (f.signals.length && !f.spawned()) throw Object.assign(new Error("refused"), { code });
		return originalFetch(url, init);
	}) as typeof fetch;
	expect(await restartLegacy(f.deps, f.before, f.ports)).toBe(0);
	expect(f.signals).toEqual([f.before.pid]);
	expect(f.spawned()).toBe(1);
	expect(f.errors).toEqual([]);
}));

for (const changed of ["manifest", "pid", "busy", "missing busy", "startedAt"] as const) test("refuses changed " + changed + " without signal", async () => fixture(async f => {
	const latest = { ...f.before };
	if (changed === "manifest") Object.assign(latest, { manifestPath: "/other" });
	if (changed === "pid") Object.assign(latest, { pid: 56789 });
	if (changed === "busy") Object.assign(latest, { busy: ["work"] });
	if (changed === "missing busy") Object.assign(latest, { busy: undefined });
	if (changed === "startedAt") Object.assign(latest, { startedAt: "other" });
	f.setInfo(latest);
	expect(await restartLegacy(f.deps, f.before, f.ports)).toBe(1); expect(f.signals).toEqual([]); expect(f.spawned()).toBe(0);
}));
test("force allows verified busy external legacy", async () => fixture(async f => {
	Object.assign(f.deps, { force: true }); const busy = { ...f.before, busy: ["work"] }; f.setInfo(busy);
	expect(await restartLegacy(f.deps, busy, f.ports)).toBe(0); expect(f.signals).toEqual([busy.pid]);
}));
test("supervisor or unavailable OS evidence refuses", async () => fixture(async f => {
	f.ports.probe = () => { throw new Error("managed by launchd"); };
	expect(await runRestart(f.deps)).toBe(1); expect(f.signals).toEqual([]); expect(f.spawned()).toBe(0);
}));
test("reused PID before signal refuses", async () => fixture(async f => {
	f.setAlive("birth-2");
	expect(await runRestart(f.deps)).toBe(1); expect(f.signals).toEqual([]); expect(f.spawned()).toBe(0);
}));
test("shutdown timeout never escalates or spawns", async () => fixture(async f => {
	f.ports.terminate = pid => { f.signals.push(pid); };
	expect(await runRestart(f.deps)).toBe(1); expect(f.signals).toEqual([f.before.pid]); expect(f.spawned()).toBe(0); expect(f.errors.join()).toContain("no SIGKILL");
}));
test("failed replacement readiness reports downtime", async () => fixture(async f => {
	f.deps.spawn = async () => ({ pid: 23456 });
	expect(await runRestart(f.deps)).toBe(1); expect(f.errors.join()).toContain("old daemon has stopped"); expect(f.errors.join()).toContain("log tail");
}));
test("unrelated API replacement is not success", async () => fixture(async f => {
	f.deps.spawn = async () => { f.setInfo({ ...f.before, pid: 55555 }); return { pid: 23456 }; };
	expect(await runRestart(f.deps)).toBe(1); expect(f.errors.join()).toContain("identity mismatch");
}));

test("idle TUI uses PID-bound shutdown, never a signal", async () => fixture(async f => {
	const before = { ...f.before, owner: "tui" as const }; f.setInfo(before);
	const fetchInfo = f.deps.fetch;
	f.deps.fetch = (async (url, init) => {
		if (String(url).endsWith("/shutdown")) {
			expect(JSON.parse(String(init?.body))).toEqual({ pid: before.pid });
			f.setAlive(null); f.setInfo(undefined);
			return Response.json({ status: "stopping" }, { status: 202 });
		}
		return fetchInfo(url, init);
	}) as typeof fetch;
	expect(await restartLegacy(f.deps, before, f.ports)).toBe(0); expect(f.signals).toEqual([]);
}));
test("TUI shutdown busy refusal never falls back to SIGTERM", async () => fixture(async f => {
	const before = { ...f.before, owner: "tui" as const }; f.setInfo(before);
	const fetchInfo = f.deps.fetch;
	f.deps.fetch = (async (url, init) => String(url).endsWith("/shutdown") ? Response.json({ status: "refused", error: "busy" }, { status: 409 }) : fetchInfo(url, init)) as typeof fetch;
	expect(await restartLegacy(f.deps, before, f.ports)).toBe(1); expect(f.signals).toEqual([]); expect(f.spawned()).toBe(0);
}));
test("a competing CLI lease prevents even the no-server spawn path", async () => fixture(async f => {
	const script = join(f.deps.dataDir, "lease.ts");
	await writeFile(script, "import { acquireRestartLease } from " + JSON.stringify(join(import.meta.dir, "../src/cli/legacy-restart.ts")) + "; await acquireRestartLease(process.argv[2]!); console.log(\"held\"); setInterval(() => {}, 1000);");
	const child = Bun.spawn([process.execPath, script, f.deps.dataDir], { stdout: "pipe", stderr: "pipe" });
	try {
		const reader = (child.stdout as ReadableStream<Uint8Array>).getReader(); await reader.read(); reader.releaseLock();
		f.deps.acquireLease = () => acquireRestartLease(f.deps.dataDir); f.setInfo(undefined);
		expect(await runRestart(f.deps)).toBe(1); expect(f.spawned()).toBe(0); expect(f.signals).toEqual([]);
	} finally { child.kill("SIGTERM"); await child.exited; }
	const lease = await acquireRestartLease(f.deps.dataDir); lease.release();
}));

// Actual legacy-style external child, real listener, SQLite lock and SIGTERM; all files confined to this fixture.
for (const mode of ["controller", "cli"]) test.skipIf(process.platform !== "darwin")("real isolated external legacy process restart: " + mode, async () => {
	const root = await mkdtemp(join(import.meta.dir, ".legacy-process-"));
	const children: Bun.Subprocess[] = [];
	let detachedPid: number | undefined;
	try {
		const dataDir = join(await realpath(root), "data"); await mkdir(dataDir);
		const reserve = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") });
		const reservedPort = reserve.port!; await reserve.stop(true);
		const manifestPath = join(await realpath(root), "dinobot.yaml");
		const manifest = JSON.stringify({ bot: { enabled: true, dataDir, workspaceRoot: root, toolMode: "direct", model: { provider: "openai", modelId: "gpt-4o-mini" } }, channels: {}, api: { port: reservedPort }, plugins: {}, curation: { enabled: false }, skillEvolution: { observe: false, author: false, evaluate: false, autoPublish: false } });
		await writeFile(manifestPath, manifest);
		await writeFile(join(dataDir, "auth.json"), "{}");
		const hash = createHash("sha256").update(manifest).digest("hex");
		const script = join(root, "daemon.ts");
		await writeFile(script, [
			"import { acquireDaemonLock } from " + JSON.stringify(join(import.meta.dir, "../src/core/daemon-lock.ts")) + ";",
			"const lock = acquireDaemonLock(process.env.DATA!);",
			"const info = { pid: process.pid, owner: \"external\", version: \"fixture\", manifestPath: process.env.CONFIG, manifestSha256: process.env.HASH, startedAt: new Date().toISOString(), busy: [] };".replaceAll("\\", ""),
			"const server = Bun.serve({hostname: \"127.0.0.1\", port: Number(process.env.PORT), fetch(req) { return new URL(req.url).pathname === \"/v1/daemon\" ? Response.json(info) : new Response(\"missing\", {status:404}); }});".replaceAll("\\", ""),
			"process.on(\"SIGTERM\", () => { server.stop(true); lock.release(); process.exit(0); });".replaceAll("\\", ""),
			"console.log(server.port);",
		].join("\n"));
		const start = (port: number) => { const child = Bun.spawn([process.execPath, script], { env: { HOME: root, DATA: dataDir, CONFIG: manifestPath, HASH: hash, PORT: String(port) }, stdout: "pipe", stderr: "pipe" }); children.push(child); return child; };
		const old = start(reservedPort);
		const reader = (old.stdout as ReadableStream<Uint8Array>).getReader();
		const first = await reader.read(); const port = Number(new TextDecoder().decode(first.value).trim()); reader.releaseLock();
		expect(port).toBeGreaterThan(0);
		const errors: string[] = [];
		const deps: RestartDependencies = { port, dataDir, manifestPath, force: false, fetch, sleep: Bun.sleep, now: Date.now, log: () => {}, error: s => errors.push(s), logTail: async () => "fixture", spawn: async () => ({ pid: start(port).pid }), startMs: 3000, comebackMs: 3000 };
		if (mode === "controller") {
			expect(await runRestart(deps), errors.join("\n")).toBe(0);
			expect(children.length).toBe(2);
		} else {
			const cli = Bun.spawn([process.execPath, join(import.meta.dir, "../src/main.ts"), "restart", "--config", manifestPath], { cwd: root, env: { HOME: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, TMPDIR: root, NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe" });
			children.push(cli);
			const [out, err, code] = await Promise.all([new Response(cli.stdout).text(), new Response(cli.stderr).text(), cli.exited]);
			const after = await fetch("http://127.0.0.1:" + port + "/v1/daemon").then(r => r.json()) as DaemonInfo;
			if (after.pid !== old.pid && after.manifestPath === manifestPath && after.manifestSha256 === hash) detachedPid = after.pid;
			expect(code, out + err).toBe(0);
			expect(detachedPid).toBeDefined();
			expect(out).toContain("Daemon restarted");
		}
		expect(await old.exited).toBe(0);
	} finally {
		if (detachedPid) {
			process.kill(detachedPid, "SIGTERM");
			const deadline = Date.now() + 12_000;
			while (Date.now() < deadline) { try { process.kill(detachedPid, 0); } catch { break; } await Bun.sleep(50); }
		}
		for (const child of children) { if (child.exitCode === null) child.kill("SIGTERM"); await child.exited; }
		await rm(root, { recursive: true, force: true });
	}
}, 30_000);
