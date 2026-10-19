import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Mission } from "../src/core/research.ts";
import type { RunState } from "../src/core/dag.ts";
import type { AgentRef, MissionSpawnBinding } from "../src/extensions/subagents.ts";

const fixture = new URL("./fixtures/research-boundaries.ts", import.meta.url).pathname;
type Child = ReturnType<typeof Bun.spawn>;
type SpawnRecord = { ref?: AgentRef; binding?: MissionSpawnBinding };
type Cut = {
	cut: string;
	mission: Mission;
	runs?: { runs: RunState[] };
	agents?: { agents: AgentRef[] };
	spawn?: SpawnRecord;
	missionId: string;
	attemptId: string;
	runnerId?: string;
	evaluationId?: string;
};
type Summary = {
	mission: Mission;
	missionCount: number;
	controllerWaitCompleted: boolean;
	agents?: { agents: AgentRef[] };
	runs?: { runs: RunState[] };
	bindings: { attemptId: string; record?: SpawnRecord }[];
};
type Invocation = {
	kind: string;
	mode: string;
	missionId?: string;
	attemptId?: string;
	runnerId?: string;
	role?: string;
	operation?: string;
	phase?: string;
	observed?: string;
};
async function optional(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return undefined;
	}
}
async function poll<T>(read: () => Promise<T | undefined>, timeout = 25_000): Promise<T> {
	const until = Date.now() + timeout;
	while (Date.now() < until) {
		const value = await read();
		if (value !== undefined) return value;
		await Bun.sleep(40);
	}
	throw new Error("Research boundary deadline: inspect fixture output and last durable cut for a recovery seam");
}

test.each(["reserve", "spawn-bind", "receipt", "report"] as const)(
	"real mission SIGKILL after %s preserves admission, binding and receipts",
	async (cut) => {
		const root = await mkdtemp(join(tmpdir(), `research-boundary-${cut}-`));
		const children: Child[] = [];
		const outputs: Promise<string[]>[] = [];
		try {
			await writeFile(join(root, "source.txt"), "K is supported\n");
			const spawn = (mode: string) => {
				const child = Bun.spawn([process.execPath, fixture, mode, cut, root], { stdout: "pipe", stderr: "pipe" });
				children.push(child);
				const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
				outputs.push(output);
				return { child, output };
			};
			const first = spawn("start");
			const before = await poll(async () => {
				const value = await optional(join(root, "cut.json"));
				if (value) {
					try {
						return JSON.parse(value) as Cut;
					} catch (error) {
						if (!(error instanceof SyntaxError)) throw error;
					}
				}
				if (first.child.exitCode !== null || first.child.signalCode) {
					throw new Error(`Fixture exited before ${cut}: ${(await first.output).join("\n")}`);
				}
				return undefined;
			});
			expect(before.cut).toBe(cut);
			expect(before.missionId).toBe(before.mission.id);
			const original = before.mission.attempts.find((a) => a.id === before.attemptId)!;
			expect(original.role).toBe("evaluate");
			expect(original.reservationKey).toBeTruthy();
			expect(before.mission.ledger.attemptsAdmitted).toBe(cut === "report" ? 2 : 1);
			if (cut === "reserve") {
				expect(original.state).toBe("reserved");
				expect(original.binding).toBeUndefined();
				expect(before.spawn?.ref).toBeUndefined();
				expect(before.agents?.agents ?? []).toHaveLength(0);
			} else {
				expect(before.runnerId).toMatch(/^\d+$/);
				expect(original.binding?.runnerId).toBe(before.runnerId);
				expect(String(before.spawn?.ref?.runnerId)).toBe(before.runnerId!);
				expect(before.spawn?.binding).toMatchObject({ missionId: before.missionId, attemptId: before.attemptId });
				expect(before.agents?.agents.filter((a) => String(a.runnerId) === before.runnerId)).toHaveLength(1);
			}
			if (cut === "receipt" || cut === "report") {
				expect(before.mission.evaluations.find((e) => e.id === before.evaluationId)?.acceptedAt).toBeDefined();
				expect(original.state).toBe("succeeded");
			}
			first.child.kill("SIGKILL");
			await poll(async () => first.child.exitCode === null && !first.child.signalCode ? undefined : true);
			expect(await first.child.exited).not.toBe(0);
			expect(first.child.signalCode).toBe("SIGKILL");
			await first.output;
			const second = spawn("reopen");
			try {
				await poll(async () => second.child.exitCode === null && !second.child.signalCode ? undefined : true, 35_000);
			} catch (error) {
				second.child.kill("SIGKILL");
				await second.child.exited;
				throw new Error(
					`Recovery failed after ${cut}; mission=${before.missionId} attempt=${before.attemptId} runner=${
						before.runnerId ?? "not yet bound"
					}\n${String(error)}\n${(await second.output).join("\n")}\nActual invocation log:\n${
						await optional(join(root, "invocations.jsonl")) ?? "(none)"
					}`,
				);
			}
			const output = await second.output;
			expect(await second.child.exited, output.join("\n")).toBe(0);
			const after = JSON.parse(await readFile(join(root, "summary.json"), "utf8")) as Summary;
			expect(after.controllerWaitCompleted).toBe(true);
			expect(after.missionCount).toBe(1);
			expect(after.mission.id).toBe(before.missionId);
			expect(after.mission.status).toBe("concluded");
			expect(after.mission.judgment).toBe("supported");
			expect(after.mission.ledger.attemptsAdmitted).toBe(2);
			expect(after.mission.attempts).toHaveLength(2);
			expect(after.mission.attempts.map((a) => a.role).sort()).toEqual(["confirm", "evaluate"]);
			const recovered = after.mission.attempts.find((a) => a.id === original.id)!;
			expect(recovered.reservationKey).toBe(original.reservationKey);
			expect(recovered.reservationHash).toBe(original.reservationHash);
			expect(recovered.ordinal).toBe(original.ordinal);
			expect(recovered.createdAt).toBe(original.createdAt);
			if (original.binding) expect(recovered.binding).toEqual(original.binding);
			const baselineBinding = after.bindings.find((b) => b.attemptId === original.id)!.record!;
			expect(String(baselineBinding.ref!.runnerId)).toBe(recovered.binding!.runnerId);
			expect(after.agents!.agents.filter((ref) => String(ref.runnerId) === recovered.binding!.runnerId)).toHaveLength(1);
			expect(after.agents!.agents).toHaveLength(2); // One baseline and one required confirmation, never a replacement baseline.
			for (const accepted of before.mission.evaluations) {
				expect(after.mission.evaluations.find((e) => e.id === accepted.id)).toEqual(accepted);
			}
			expect(after.mission.evaluations).toHaveLength(2);
			for (const attempt of after.mission.attempts) {
				const receipt = after.mission.evaluations.find((e) => e.attemptId === attempt.id)!;
				expect(receipt.acceptedAt).toBeDefined();
				expect(receipt.evidence[0]!.observation).toBe("K is supported");
				const node = after.runs!.runs.find((r) => r.id === attempt.binding!.runId)!.nodes[attempt.binding!.nodeId]!;
				expect(node.receipt).toBeDefined();
				expect(node.status).toBe("succeeded");
			}
			expect(after.mission.report.state).toBe("current");
			expect(after.mission.report.writtenRevision).toBe(after.mission.revision);
			expect(after.mission.report.path).toBeTruthy();
			const report = await readFile(join(root, after.mission.report.path!, "report.md"), "utf8");
			expect(report).toContain(after.mission.id);
			expect(report).toContain("supported");
			const logs = (await readFile(join(root, "invocations.jsonl"), "utf8")).trim().split("\n").map((line) =>
				JSON.parse(line) as Invocation
			);
			const model = logs.filter((entry) => entry.kind === "model");
			expect(model.length).toBeGreaterThanOrEqual(4); // A read request and interpretation for each reviewer; replay may add calls.
			expect(new Set(model.map((entry) => entry.attemptId)).size).toBe(2);
			for (const entry of model) {
				const attempt = after.mission.attempts.find((a) => a.id === entry.attemptId)!;
				expect(attempt).toBeDefined();
				expect(entry.runnerId).toBe(attempt.binding!.runnerId);
			}
			for (const attempt of after.mission.attempts) {
				expect(
					logs.some((entry) =>
						entry.kind === "source-result" && entry.attemptId === attempt.id && entry.observed?.includes("K is supported")
					),
				).toBe(true);
			}
			expect(logs.filter((entry) => entry.kind === "parent-model" && entry.phase === "start")).toHaveLength(1);
			if (cut === "report") expect(model.filter((entry) => entry.mode === "reopen")).toHaveLength(0);
			expect(await readFile(join(root, "source.txt"), "utf8")).toBe("K is supported\n");
		} finally {
			for (const child of children) {
				if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
				await child.exited;
			}
			await Promise.all(outputs);
			await rm(root, { recursive: true, force: true });
		}
	},
	75_000,
);
