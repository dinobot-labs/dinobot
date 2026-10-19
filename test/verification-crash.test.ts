import { expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Evidence, WorkState, WorkflowStatus, Lease } from "../src/core/verification.ts";

async function until(check: () => Promise<boolean>, label: string, ms = 12000) {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) { if (await check()) return; await Bun.sleep(10); }
	throw new Error(`Timed out: ${label}`);
}
function launch(dir: string, mode: string, cut: string) {
	const child = spawn(process.execPath, [resolve(import.meta.dir, "fixtures/verification-crash.ts"), dir, mode, cut], { detached: true, stdio: ["ignore", "ignore", "pipe"] });
	let stderr = ""; let spawnError: Error | undefined;
	child.stderr!.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-16000); });
	child.on("error", error => { spawnError = error; });
	return { child, error: () => spawnError?.message ?? stderr };
}
function killGroup(pid: number) {
	try { process.kill(-pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}
async function stop(child: ChildProcess) {
	if (child.pid) killGroup(child.pid);
	await until(async () => child.exitCode !== null || child.signalCode !== null, "fixture cleanup", 3000);
}
type Recovered = {
	status: WorkflowStatus; before: WorkState; after: WorkState; evidence: Evidence[];
	coord: { leases: Lease[] }; tasks: { state: { status: string } }[];
	finished: WorkflowStatus | string; overlap?: { status: WorkflowStatus; finishError: string }; disjoint?: WorkflowStatus;
};
for (const cut of ["admission", "effect-intent", "command-running", "effect-completed", "receipt", "repair", "certificate"] as const) {
	for (const edited of cut === "certificate" ? [false, true] : [false]) {
		test(`SQLite SIGKILL ${cut}${edited ? " with changed input before reopen" : ""}`, async () => {
			const dir = await mkdtemp(resolve(tmpdir(), "verification-crash-"));
			const processes: ChildProcess[] = [];
			try {
				const initial = launch(dir, "initial", cut); processes.push(initial.child);
				await until(async () => {
					if (initial.child.exitCode !== null || initial.child.signalCode !== null) throw new Error(`Fixture exited before ${cut}: ${initial.error()}`);
					return readFile(resolve(dir, "cut"), "utf8").then(value => value === cut, () => false);
				}, cut);
				await stop(initial.child);
				const effects = await readFile(resolve(dir, "effects"), "utf8").catch(() => "");
				expect(effects.split("\n").filter(Boolean)).toHaveLength(["command-running", "effect-completed", "receipt", "certificate"].includes(cut) ? 1 : 0);
				if (edited) await writeFile(resolve(dir, "workspace/addition.test.ts"), '// changed after certificate commit, before recovery\n');
				// The command-running process remains alive during recovery. PIDs are cleanup data ONLY.
				const recovery = launch(dir, "recover", cut); processes.push(recovery.child);
				await until(async () => recovery.child.exitCode !== null || recovery.child.signalCode !== null, "reopen", 15000);
				expect(recovery.child.exitCode, recovery.error()).toBe(0);
				const result = JSON.parse(await readFile(resolve(dir, "recovered.json"), "utf8")) as Recovered;
				expect(await readFile(resolve(dir, "effects"), "utf8").catch(() => "")).toBe(effects);
				expect(result.after.works[0]!.costs).toEqual(result.before.works[0]!.costs);
				expect(result.status.costs!.attempts).toBe(cut === "repair" ? 0 : 1);
				expect(result.status.costs!.seconds).toBe(cut === "repair" ? 0 : 10);
				expect(result.tasks.every(task => task.state.status === "terminal")).toBe(true);
				if (["effect-intent", "command-running", "effect-completed"].includes(cut)) {
					expect(result.evidence[0]!.status).toBe("unknown");
					// One verification lease; a killed command may also leave its native process-journal lease for the same task.
					expect(result.coord.leases.filter(lease => lease.reason === "verification")).toHaveLength(1);
					expect(result.coord.leases.every(lease => lease.phase === "blocked-unknown" && lease.taskId === result.evidence[0]!.taskId)).toBe(true);
					expect(result.status.status).toBe("blocked");
					expect(String(result.finished)).toContain("workspace_busy");
					expect(result.overlap!.status.costs!.attempts).toBe(0);
					expect(result.overlap!.finishError).toContain("workspace_busy");
					expect(result.disjoint!.status).toBe("verified");
				} else {
					expect(result.coord.leases).toHaveLength(0);
					if (cut === "admission") { expect(result.evidence[0]!.status).toBe("failed"); expect((result.finished as WorkflowStatus).status).toBe("blocked"); }
					if (cut === "receipt") { expect(result.evidence[0]!.status).toBe("passed"); expect((result.finished as WorkflowStatus).status).toBe("verified"); }
					if (cut === "repair") {
						expect(result.after.works[0]!.methods.a).toEqual(result.before.works[0]!.methods.a);
						expect(result.after.works[0]!.methods.a).toHaveLength(2);
						expect(result.status.costs!.repairs).toBe(1);
					}
					if (cut === "certificate") {
						expect(result.status.status).toBe(edited ? "blocked" : "verified");
						expect((result.finished as WorkflowStatus).certificate?.id).toBe(result.status.certificate?.id);
						if (edited) expect(result.status.certificate).toBeNull();
					}
				}
			} finally {
				try {
					const group = await readFile(resolve(dir, "command-group"), "utf8").catch(() => "");
					if (group) killGroup(Number(group));
					const groups = await readFile(resolve(dir, "command-groups"), "utf8").catch(() => "");
					for (const id of new Set(groups.split("\n").filter(Boolean))) killGroup(Number(id));
				} finally { try { await Promise.all(processes.map(stop)); } finally { await rm(dir, { recursive: true, force: true }); } }
			}
		}, 35000);
	}
}
