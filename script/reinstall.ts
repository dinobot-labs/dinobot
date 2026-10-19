#!/usr/bin/env bun
/**
 * Rebuild dinobot, stop the running daemon, install the new binary and restart it.
 *
 *   bun run reinstall              # build + stop + install + start
 *   bun run reinstall --no-build   # reuse the existing dist/ build
 *
 * On Linux the daemon runs as the transient systemd user unit "dinobot.service" (systemd-run).
 * On macOS there is no systemd: the daemon is a plain background process found by its
 * "<bin> serve --config <config>" command line, killed by pid, and re-launched detached.
 * Env overrides: DINOBOT_UNIT, DINOBOT_CONFIG, DINOBOT_API_PORT, DINOBOT_BIN, DINOBOT_DIST_DIR.
 * Note: restarting the daemon ends every thread that is currently running in it.
 *
 * Safety:
 *  - Runs started inside the daemon itself (e.g. from a bot thread) re-launch themselves as an
 *    independent process first (a separate transient unit on Linux, detached on macOS);
 *    otherwise stopping the daemon could kill this script half-way.
 *  - One run at a time: a lock directory serializes concurrent runs (a second run waits, then proceeds).
 *  - Install sources are captured before the daemon is stopped, and success requires a healthy API
 *    served by a process started after the install, so an old daemon never counts as success.
 */
import { mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { installLocalArtifacts, preflightLocalInstall } from "./local-install.ts";
import { ancestorIsDaemon, insideUnit, lockIsStale, parsePids, parseShow, psPids, startedByOther, stopped, unitState } from "./reinstall-lib.ts";

const home = homedir();
const linux = process.platform === "linux";
const unit = process.env.DINOBOT_UNIT ?? "dinobot.service";
const config = process.env.DINOBOT_CONFIG ?? join(home, ".config/dinobot/dinobot.yaml");
const bin = process.env.DINOBOT_BIN ?? join(home, ".local/bin/dinobot");
const dist = resolve(process.env.DINOBOT_DIST_DIR ?? "dist");
const port = process.env.DINOBOT_API_PORT ?? "8786";
const skipBuild = process.argv.includes("--no-build");
const runtimeDir = process.env.XDG_RUNTIME_DIR ?? "/tmp";
const lockDir = join(runtimeDir, `${unit}.reinstall.lock`);

const log = (message: string) => console.log(`[${new Date().toISOString()}] ${message}`);
function fail(message: string): never {
	console.error(`[${new Date().toISOString()}] ${message}`);
	process.exit(1);
}
function run(cmd: string[], opts: { allowFail?: boolean } = {}): number {
	log("$ " + cmd.join(" "));
	const proc = Bun.spawnSync(cmd, { stdout: "inherit", stderr: "inherit" });
	if (proc.exitCode !== 0 && !opts.allowFail) fail("failed (exit " + proc.exitCode + "): " + cmd.join(" "));
	return proc.exitCode ?? 1;
}
function quiet(cmd: string[]): string {
	return Bun.spawnSync(cmd, { stdout: "pipe", stderr: "ignore" }).stdout.toString().trim();
}
const show = () => unitState(parseShow(quiet(["systemctl", "--user", "show", "--timestamp=unix", unit, "-p", "LoadState", "-p", "ActiveState", "-p", "ExecMainStartTimestamp", "-p", "ExecStart"])));
async function healthy(): Promise<boolean> {
	return fetch("http://127.0.0.1:" + port + "/healthz").then((r) => r.ok, () => false);
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/**
 * Pids of the processes serving this daemon config (empty when none is running).
 * Linux matches the exact installed binary via pgrep (systemd owns the unit). macOS parses ps
 * output for any `serve --config <config>` command line instead: pgrep -f misses some processes,
 * and the running daemon may be an older bun-global install rather than the target binary.
 */
function daemonPids(): number[] {
	if (linux) return parsePids(quiet(["pgrep", "-f", `${bin} serve --config ${config}`]));
	return psPids(quiet(["ps", "ax", "-o", "pid=,args="]), `serve --config ${config}`);
}
/** True when stopping the daemon could kill this script: inside its cgroup (Linux) or below it in the process tree. */
function selfInsideDaemon(): boolean {
	if (linux) {
		let cgroup: string;
		try {
			cgroup = readFileSync("/proc/self/cgroup", "utf8");
		} catch {
			return false; // no /proc: not inside a systemd unit
		}
		return insideUnit(cgroup, unit);
	}
	const daemons = new Set(daemonPids());
	if (daemons.size === 0) return false;
	return ancestorIsDaemon(process.ppid, daemons, (pid) => {
		const next = Number(quiet(["ps", "-o", "ppid=", "-p", String(pid)]));
		return Number.isSafeInteger(next) && next > 0 ? next : undefined;
	});
}
/** Spawn an independent copy that survives this process and the daemon going away. */
function relaunchDetached(): Bun.Subprocess {
	const logPath = join(runtimeDir, `${basename(unit, ".service")}-reinstall-${Date.now()}.log`);
	const fd = openSync(logPath, "a");
	const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "reinstall.ts"), ...process.argv.slice(2)], {
		cwd: process.cwd(),
		env: process.env,
		stdin: "ignore",
		stdout: fd,
		stderr: fd,
	});
	child.unref();
	return child;
}

// 0. Never stop the daemon from inside it: re-launch as an independent process/unit and return.
if (selfInsideDaemon()) {
	if (linux) {
		const helper = `${basename(unit, ".service")}-reinstall-${Date.now()}`;
		const env = ["PATH", "HOME", "XDG_RUNTIME_DIR", "DINOBOT_UNIT", "DINOBOT_CONFIG", "DINOBOT_API_PORT", "DINOBOT_BIN", "DINOBOT_DIST_DIR"]
			.filter((key) => process.env[key] !== undefined).map((key) => `--setenv=${key}=${process.env[key]}`);
		run(["systemd-run", "--user", "--collect", `--unit=${helper}`, `--working-directory=${process.cwd()}`, ...env,
			process.execPath, resolve(import.meta.dir, "reinstall.ts"), ...process.argv.slice(2)]);
		log(`running inside ${unit}; continued as ${helper}.service (journalctl --user -u ${helper} -f)`);
	} else {
		const child = relaunchDetached();
		log(`running inside the daemon; continued detached as pid ${child.pid}`);
	}
	process.exit(0);
}

// 1. One run at a time.
async function acquireLock(): Promise<void> {
	for (let waited = 0; ; waited += 500) {
		try {
			mkdirSync(lockDir);
			writeFileSync(join(lockDir, "pid"), String(process.pid));
			return;
		} catch {
			let holder: number | undefined;
			try { holder = Number(readFileSync(join(lockDir, "pid"), "utf8").trim()); } catch { /* holder is still writing its pid */ }
			if (holder !== undefined && lockIsStale(Number.isNaN(holder) ? undefined : holder, alive)) {
				rmSync(lockDir, { recursive: true, force: true });
				continue;
			}
			if (waited === 0) log(`another reinstall (pid ${holder}) is running; waiting`);
			if (waited >= 180_000) fail(`another reinstall (pid ${holder}) still holds ${lockDir} after 180s`);
			await Bun.sleep(500);
		}
	}
}
await acquireLock();
process.on("exit", () => rmSync(lockDir, { recursive: true, force: true }));
log(`reinstall pid ${process.pid} (parent ${process.ppid}: ${quiet(["ps", "-o", "args=", "-p", String(process.ppid)])})`);

// 2. Build first so a broken build never takes the running daemon down.
if (!skipBuild) run(["bun", "run", "build"]);
// Capture immutable install sources before the daemon is stopped.
const artifacts = preflightLocalInstall(dist);

// 3. Stop the daemon and wait until it is gone: systemd unit on Linux, plain processes elsewhere.
const oldPids = new Set(daemonPids());
if (linux) {
	run(["systemctl", "--user", "stop", unit], { allowFail: true });
	for (let i = 0; i < 100 && !stopped(show()); i++) await Bun.sleep(100);
	if (!stopped(show())) fail(`${unit} is still ${show().active} after stop`);
	if (show().active === "failed") run(["systemctl", "--user", "reset-failed", unit], { allowFail: true });
}
const stray = daemonPids();
if (stray.length) run(["kill", ...stray.map(String)], { allowFail: true });
for (let i = 0; i < 100 && daemonPids().length > 0; i++) await Bun.sleep(100);
if (daemonPids().length > 0) fail("daemon process(es) still alive after kill: " + daemonPids().join(", "));
for (let i = 0; i < 50 && (await healthy()); i++) await Bun.sleep(100);
if (await healthy()) fail("daemon still answers on port " + port + "; aborting before install");

// 4. Install the fresh binary and its native addons (atomic per file, addons first, binary last).
const installedAt = Math.floor(Date.now() / 1000);
installLocalArtifacts(artifacts, bin);
log(`installed ${basename(bin)} and ${artifacts.natives.length} native addon(s) to ${bin}`);

// 4b. Install the vendored answer-me-with-html CLI used by the explanation skill.
const vendorSrc = resolve(import.meta.dir, "../vendor/answer-me-with-html");
const vendorTarget = join(home, ".local/share/dinobot/vendor/answer-me-with-html");
mkdirSync(vendorTarget, { recursive: true });
for (const file of ["am.mjs", "SKILL.md", "LICENSE", "NOTICE.md"]) {
	run(["install", "-m644", join(vendorSrc, file), vendorTarget]);
}
log(`vendored answer-me-with-html CLI installed to ${vendorTarget}`);

// 5. Start it again: the same transient unit on Linux, a detached process elsewhere.
let daemonLog = "";
if (linux) {
	if (run(["systemd-run", "--user", "--unit=" + unit, "--working-directory=" + home, bin, "serve", "--config", config], { allowFail: true }) !== 0) {
		const state = show();
		if (!startedByOther(state, bin, installedAt)) fail(`could not start ${unit} (${state.load}/${state.active}); see: systemctl --user status ${unit}`);
		log(`${unit} was already started on the new binary by another actor; verifying it`);
	}
} else {
	daemonLog = join(runtimeDir, `${basename(unit, ".service")}.daemon.log`);
	const fd = openSync(daemonLog, "a");
	const child = Bun.spawn([bin, "serve", "--config", config], { cwd: home, env: process.env, stdin: "ignore", stdout: fd, stderr: fd });
	child.unref();
	log(`started ${bin} serve --config ${config} (pid ${child.pid}, log: ${daemonLog})`);
}

// 6. Healthy API served by a process that started after the install.
for (let i = 0; i < 100; i++) {
	const up = linux
		? ((s) => s.active === "active" && (s.startedAt ?? 0) >= installedAt)(show())
		: daemonPids().some((pid) => !oldPids.has(pid));
	if (up && (await healthy())) {
		log("dinobot daemon is up (" + (linux ? unit + ", " : "") + "port " + port + ")");
		process.exit(0);
	}
	await Bun.sleep(100);
}
fail(linux
	? "daemon did not become healthy on the new binary in 10s; see: journalctl --user -u " + unit + " -n 50"
	: "daemon did not become healthy on the new binary in 10s; see: " + daemonLog);
