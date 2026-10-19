import { afterEach, describe, expect, test } from "bun:test";
import type { ManifestApplyRequest } from "../src/commands/types.ts";
import type { DaemonInfo, ShutdownResult } from "../src/core/daemon-info.ts";
import { type ApplyJournal, type ApplyLimits, type ApplyPorts, applyManifestChange, backupPath, recoverInterruptedApply } from "../src/setup/apply.ts";
import { ManifestConflictError, sha256Hex } from "../src/setup/manifest-file.ts";

/**
 * A simulated machine: one manifest file, daemon processes with a virtual clock, and the client view of the API port.
 * Every spawn asserts invariant I1 (no other daemon process alive), so any test that reaches a double start fails.
 */
const PATH = "/home/u/.config/dinobot/dinobot.yaml";
const BASE = ["bot:", "  enabled: true", "  dataDir: /home/u/.local/share/dinobot", "  model:", "    provider: faux", "    modelId: m", "  toolMode: direct", "api:", "  port: 8786", "channels: {}", "plugins: {}         # keep me", ""].join("\n");
const CANDIDATE = BASE.replace("plugins: {}         # keep me", "plugins:         # keep me\n  computer: {}");

type Boot = "ok" | "exit" | "hang" | "lock";
type Proc = { pid: number; sha: string; alive: boolean; answering: boolean; exitAt?: number; answerAt?: number; ignoreTerm: boolean; ignoreKill: boolean };

class World {
	readonly files = new Map<string, string>([[PATH, BASE]]);
	readonly journals = new Map<string, ApplyJournal>();
	readonly procs = new Map<number, Proc>();
	readonly log: string[] = [];
	time = 0;
	nextPid = 200;
	owner: "tui" | "external" = "tui";
	busy: string[] = [];
	refuse: ShutdownResult | undefined;
	shutdownThrows = false;
	/** How the old daemon reacts to the shutdown request. */
	stops = true;
	/** How each new daemon boots, by the sha of the manifest it reads at spawn. */
	boot: (sha: string) => Boot = () => "ok";
	ignoreTerm = false;
	ignoreKill = false;
	older = false;
	/** A process outside our control that takes the port (another TUI's daemon) right after the old one exits. */
	foreign: string | undefined;
	maxAlive = 0;
	/** Spawn attempts while another daemon process was alive (invariant I1); must stay 0. */
	violations = 0;

	constructor() {
		worlds.push(this);
		this.procs.set(100, { pid: 100, sha: sha256Hex(BASE), alive: true, answering: true, ignoreTerm: false, ignoreKill: false });
	}

	private tick(): void {
		for (const proc of this.procs.values()) {
			if (proc.alive && proc.exitAt !== undefined && this.time >= proc.exitAt) {
				proc.alive = false;
				proc.answering = false;
				this.log.push(`exit ${proc.pid}`);
				if (this.foreign !== undefined && proc.pid === 100) {
					const pid = 900;
					this.procs.set(pid, { pid, sha: this.foreign, alive: true, answering: true, ignoreTerm: true, ignoreKill: true });
					this.log.push(`foreign ${pid}`);
					this.foreign = undefined;
				}
			}
			if (proc.alive && proc.answerAt !== undefined && this.time >= proc.answerAt) proc.answering = true;
		}
		this.maxAlive = Math.max(this.maxAlive, [...this.procs.values()].filter((proc) => proc.alive).length);
	}

	private answering(): Proc | undefined {
		this.tick();
		return [...this.procs.values()].find((proc) => proc.alive && proc.answering);
	}

	alive(): number[] {
		this.tick();
		return [...this.procs.values()].filter((proc) => proc.alive).map((proc) => proc.pid);
	}

	ports(): ApplyPorts {
		return {
			read: async (path) => {
				const text = this.files.get(path);
				if (text === undefined) throw Object.assign(new Error(`ENOENT ${path}`), { code: "ENOENT" });
				return { text, sha256: sha256Hex(text) };
			},
			replace: async (path, text, expected, backup) => {
				const current = this.files.get(path);
				if (current === undefined || sha256Hex(current) !== expected) throw new ManifestConflictError("changed");
				if (backup) this.files.set(backupPath(path), current);
				this.files.set(path, text);
				this.log.push(`write ${text === BASE ? "base" : text === CANDIDATE ? "candidate" : "other"}`);
				return { text, sha256: sha256Hex(text) };
			},
			validate: async (text) => (text.includes("INVALID") ? { ok: false, problems: ["plugins.INVALID: unknown plugin"] } : { ok: true }),
			realpath: async (path) => path,
			info: async () => {
				const proc = this.answering();
				if (proc === undefined) throw new Error("ECONNREFUSED");
				if (this.older) return undefined;
				return { pid: proc.pid, version: "t", manifestPath: PATH, manifestSha256: proc.sha, owner: proc.pid === 100 ? this.owner : "tui", startedAt: "", busy: proc.pid === 100 ? this.busy : [], setup: {} } satisfies DaemonInfo;
			},
			shutdown: async (pid) => {
				this.log.push(`shutdown ${pid}`);
				if (this.refuse) return this.refuse;
				const proc = this.procs.get(pid);
				if (proc && this.stops) proc.exitAt = this.time + 1_500;
				if (this.shutdownThrows) throw new Error("socket closed");
				return { status: "stopping" };
			},
			alive: (pid) => this.alive().includes(pid),
			spawn: async () => {
				const others = this.alive();
				if (others.length > 0 && !others.includes(900)) {
					this.violations++;
					throw new Error(`I1 violated: spawn while ${others.join(",")} alive`);
				}
				const sha = sha256Hex(this.files.get(PATH) ?? "");
				const pid = this.nextPid++;
				const mode = this.boot(sha);
				const proc: Proc = { pid, sha, alive: true, answering: false, ignoreTerm: this.ignoreTerm, ignoreKill: this.ignoreKill };
				if (mode === "ok") proc.answerAt = this.time + 800;
				if (mode === "exit") proc.exitAt = this.time + 400;
				if (mode === "lock") proc.exitAt = this.time + 200;
				this.procs.set(pid, proc);
				this.log.push(`spawn ${pid} ${sha === sha256Hex(BASE) ? "base" : "candidate"} ${mode}`);
				this.tick();
				return { pid, exited: () => !this.alive().includes(pid) };
			},
			kill: (pid, signal) => {
				this.log.push(`kill ${pid} ${signal}`);
				const proc = this.procs.get(pid);
				if (!proc?.alive) return;
				if (signal === "SIGTERM" && !proc.ignoreTerm) proc.exitAt = this.time + 300;
				if (signal === "SIGKILL" && !proc.ignoreKill) proc.exitAt = this.time;
			},
			logTail: async () => "boot failed: port in use",
			journal: {
				write: async (path, entry) => void this.journals.set(path, entry),
				read: async (path) => this.journals.get(path),
				clear: async (path) => void this.journals.delete(path),
			},
			sleep: async (ms) => {
				this.time += ms;
				this.tick();
			},
			now: () => this.time,
		};
	}
}

const worlds: World[] = [];
afterEach(() => {
	for (const world of worlds.splice(0)) expect(world.violations).toBe(0);
});

const LIMITS: ApplyLimits = { stopMs: 5_000, startMs: 5_000, pollMs: 100 };
const request = (candidate = CANDIDATE, base = BASE): ManifestApplyRequest => ({ manifestPath: PATH, baseSha256: sha256Hex(base), candidate, changes: ["+ plugins.computer"], summary: [], locale: "en" });

function expectUntouched(world: World): void {
	expect(world.files.get(PATH)).toBe(BASE);
	expect(world.files.has(backupPath(PATH))).toBe(false);
	expect(world.journals.size).toBe(0);
	expect(world.log.filter((line) => line.startsWith("shutdown") || line.startsWith("spawn"))).toEqual([]);
	expect(world.alive()).toEqual([100]);
}

describe("applyManifestChange", () => {
	test("applies: CAS write with backup, graceful stop, spawn only after the old pid is gone, journal cleared", async () => {
		const world = new World();
		expect(await applyManifestChange(request(), world.ports(), LIMITS)).toEqual({ status: "applied" });
		expect(world.files.get(PATH)).toBe(CANDIDATE);
		expect(world.files.get(backupPath(PATH))).toBe(BASE);
		expect(world.journals.size).toBe(0);
		expect(world.log).toEqual(["write candidate", "shutdown 100", "exit 100", "spawn 200 candidate ok"]);
		expect(world.alive()).toEqual([200]);
		expect(world.maxAlive).toBe(1);
	});

	test("refuses without writing: file changed since setup read it, invalid candidate, moved dataDir/port", async () => {
		const changed = new World();
		changed.files.set(PATH, `${BASE}# edited by hand\n`);
		expect(await applyManifestChange(request(), changed.ports(), LIMITS)).toEqual({ status: "conflict" });
		expect(changed.files.get(PATH)).toBe(`${BASE}# edited by hand\n`);

		const invalid = new World();
		expect(await applyManifestChange(request(`${CANDIDATE}# INVALID\n`), invalid.ports(), LIMITS)).toEqual({ status: "invalid", problems: ["plugins.INVALID: unknown plugin"] });
		expectUntouched(invalid);

		for (const moved of [CANDIDATE.replace("/home/u/.local/share/dinobot", "/tmp/elsewhere"), CANDIDATE.replace("port: 8786", "port: 9999")]) {
			const world = new World();
			expect(await applyManifestChange(request(moved), world.ports(), LIMITS)).toEqual({ status: "unsafe_change" });
			expectUntouched(world);
		}
	});

	test("refuses without writing: unreachable, older daemon, another manifest, busy threads", async () => {
		const down = new World();
		down.procs.get(100)!.answering = false;
		expect(await applyManifestChange(request(), down.ports(), LIMITS)).toEqual({ status: "unreachable" });
		expect(down.files.get(PATH)).toBe(BASE);

		const older = new World();
		older.older = true;
		expect(await applyManifestChange(request(), older.ports(), LIMITS)).toEqual({ status: "older_daemon" });
		expectUntouched(older);

		const other = new World();
		const ports = other.ports();
		expect(await applyManifestChange(request(), { ...ports, realpath: async () => "/somewhere/else.yaml" }, LIMITS)).toEqual({ status: "other_manifest", path: PATH });
		expectUntouched(other);

		const busy = new World();
		busy.busy = ["tui:work"];
		expect(await applyManifestChange(request(), busy.ports(), LIMITS)).toEqual({ status: "busy", threads: ["tui:work"] });
		expectUntouched(busy);
	});

	test("an externally managed daemon is never stopped: the file is saved with a backup for its owner to restart", async () => {
		const world = new World();
		world.owner = "external";
		expect(await applyManifestChange(request(), world.ports(), LIMITS)).toEqual({ status: "saved_external" });
		expect(world.files.get(PATH)).toBe(CANDIDATE);
		expect(world.files.get(backupPath(PATH))).toBe(BASE);
		expect(world.log).toEqual(["write candidate"]);
		expect(world.alive()).toEqual([100]);
	});

	test("a daemon that turns busy between the check and the shutdown refuses; the base is restored and nothing restarts", async () => {
		const world = new World();
		world.refuse = { status: "refused", error: "busy", busy: ["slack:C1"] };
		expect(await applyManifestChange(request(), world.ports(), LIMITS)).toEqual({ status: "busy", threads: ["slack:C1"] });
		expect(world.files.get(PATH)).toBe(BASE);
		expect(world.journals.size).toBe(0);
		expect(world.alive()).toEqual([100]);
		expect(world.log).toEqual(["write candidate", "shutdown 100", "write base"]);
	});

	test("a lost shutdown answer is fine when the daemon does stop", async () => {
		const world = new World();
		world.shutdownThrows = true;
		expect(await applyManifestChange(request(), world.ports(), LIMITS)).toEqual({ status: "applied" });
		expect(world.alive()).toEqual([200]);
	});

	test("an old daemon that never exits: base restored, nothing spawned (I1)", async () => {
		const world = new World();
		world.stops = false;
		expect(await applyManifestChange(request(), world.ports(), LIMITS)).toEqual({ status: "stuck", pid: 100 });
		expect(world.files.get(PATH)).toBe(BASE);
		expect(world.journals.size).toBe(0);
		expect(world.log.some((line) => line.startsWith("spawn"))).toBe(false);
		expect(world.alive()).toEqual([100]);
	});

	test("the new daemon fails to boot: base restored and the previous daemon started again", async () => {
		const world = new World();
		world.boot = (sha) => (sha === sha256Hex(CANDIDATE) ? "exit" : "ok");
		const outcome = await applyManifestChange(request(), world.ports(), LIMITS);
		expect(outcome).toEqual({ status: "rolled_back", reason: "the daemon exited during startup", log: "boot failed: port in use" });
		expect(world.files.get(PATH)).toBe(BASE);
		expect(world.files.get(backupPath(PATH))).toBe(BASE);
		expect(world.journals.size).toBe(0);
		expect(world.log).toEqual(["write candidate", "shutdown 100", "exit 100", "spawn 200 candidate exit", "exit 200", "write base", "spawn 201 base ok"]);
		expect(world.maxAlive).toBe(1);
	});

	test("a new daemon that hangs is terminated (then killed) before the previous one starts again", async () => {
		for (const ignoreTerm of [false, true]) {
			const world = new World();
			world.boot = (sha) => (sha === sha256Hex(CANDIDATE) ? "hang" : "ok");
			world.ignoreTerm = ignoreTerm;
			const outcome = await applyManifestChange(request(), world.ports(), LIMITS);
			expect(outcome.status).toBe("rolled_back");
			expect(world.log).toContain("kill 200 SIGTERM");
			expect(world.log.includes("kill 200 SIGKILL")).toBe(ignoreTerm);
			expect(world.log.indexOf("exit 200")).toBeLessThan(world.log.indexOf("spawn 201 base ok"));
			expect(world.files.get(PATH)).toBe(BASE);
			expect(world.maxAlive).toBe(1);
			world.ignoreTerm = false;
		}
	});

	test("a new daemon that cannot be stopped at all: nothing else is started, base restored, reported as failed", async () => {
		const world = new World();
		world.boot = (sha) => (sha === sha256Hex(CANDIDATE) ? "hang" : "ok");
		world.ignoreTerm = true;
		world.ignoreKill = true;
		const outcome = await applyManifestChange(request(), world.ports(), LIMITS);
		expect(outcome.status).toBe("failed");
		expect(world.files.get(PATH)).toBe(BASE);
		expect(world.log.filter((line) => line.startsWith("spawn"))).toEqual(["spawn 200 candidate hang"]);
		expect(world.maxAlive).toBe(1);
	});

	test("when the previous settings do not start either the outcome is failed with the base on disk", async () => {
		const world = new World();
		world.boot = () => "exit";
		const outcome = await applyManifestChange(request(), world.ports(), LIMITS);
		expect(outcome.status).toBe("failed");
		expect(world.files.get(PATH)).toBe(BASE);
		expect(world.alive()).toEqual([]);
		expect(world.journals.size).toBe(0);
	});

	test("another starter that won the race with the candidate counts as applied; with other settings it is a failure we never kill", async () => {
		const won = new World();
		won.foreign = sha256Hex(CANDIDATE);
		won.boot = () => "lock";
		expect(await applyManifestChange(request(), won.ports(), LIMITS)).toEqual({ status: "applied" });
		expect(won.files.get(PATH)).toBe(CANDIDATE);

		const other = new World();
		other.foreign = sha256Hex("something else");
		other.boot = () => "lock";
		const outcome = await applyManifestChange(request(), other.ports(), LIMITS);
		expect(outcome.status).toBe("failed");
		expect(other.log.some((line) => line.startsWith("kill 900"))).toBe(false);
		expect(other.files.get(PATH)).toBe(BASE);
	});
});

describe("recoverInterruptedApply", () => {
	const journal = (): ApplyJournal => ({ baseSha256: sha256Hex(BASE), candidateSha256: sha256Hex(CANDIDATE), pid: 100, startedAt: "" });

	test("no journal: nothing to do", async () => {
		const world = new World();
		expect(await recoverInterruptedApply(PATH, world.ports())).toBe("none");
	});

	test("the running daemon already booted the candidate: the apply completed", async () => {
		const world = new World();
		world.files.set(PATH, CANDIDATE);
		world.procs.get(100)!.sha = sha256Hex(CANDIDATE);
		world.journals.set(PATH, journal());
		expect(await recoverInterruptedApply(PATH, world.ports())).toBe("completed");
		expect(world.files.get(PATH)).toBe(CANDIDATE);
		expect(world.journals.size).toBe(0);
	});

	test("died mid-apply (no daemon, or the old one still running): the base comes back from .bak", async () => {
		for (const running of [false, true]) {
			const world = new World();
			world.files.set(PATH, CANDIDATE);
			world.files.set(backupPath(PATH), BASE);
			world.procs.get(100)!.answering = running;
			world.journals.set(PATH, journal());
			expect(await recoverInterruptedApply(PATH, world.ports())).toBe("recovered");
			expect(world.files.get(PATH)).toBe(BASE);
			expect(world.journals.size).toBe(0);
		}
	});

	test("a .bak that does not hold the recorded base is never restored", async () => {
		const world = new World();
		world.files.set(PATH, CANDIDATE);
		world.files.set(backupPath(PATH), "something else\n");
		world.procs.get(100)!.answering = false;
		world.journals.set(PATH, journal());
		await expect(recoverInterruptedApply(PATH, world.ports())).rejects.toThrow("does not hold the settings");
		expect(world.files.get(PATH)).toBe(CANDIDATE);
	});

	test("the file was never switched (or was edited since): the journal is dropped and the file left alone", async () => {
		const world = new World();
		world.journals.set(PATH, journal());
		world.procs.get(100)!.answering = false;
		expect(await recoverInterruptedApply(PATH, world.ports())).toBe("none");
		expect(world.files.get(PATH)).toBe(BASE);
		expect(world.journals.size).toBe(0);
	});
});
