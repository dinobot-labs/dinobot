import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Mission } from "../src/core/research.ts";
import { hashResearchBytes } from "../src/core/research-experiments.ts";

const fixture = new URL("./fixtures/research-report-failure.ts", import.meta.url).pathname;
type Summary = { mission: Mission; failures: number; acceptedAtFault: number; providerCalls: number };
async function run(mode: string, root: string, fault: string): Promise<Summary> {
	const child = Bun.spawn([process.execPath, fixture, mode, root, fault], { stdout: "pipe", stderr: "pipe" });
	const timer = setTimeout(() => child.kill("SIGKILL"), 25_000);
	try {
		const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		expect(exit, `${mode}: ${out}\n${err}`).toBe(0);
		return JSON.parse(await readFile(join(root, `${mode}.json`), "utf8")) as Summary;
	} finally {
		clearTimeout(timer);
		if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
		await child.exited;
	}
}

test.each(["evidence", "manifest"])(
	"accepted service receipts survive simulated ENOSPC at %s publication and clean reopen repairs reports",
	async (fault) => {
		const root = await mkdtemp(join(tmpdir(), "research-report-failure-"));
		try {
			await writeFile(join(root, "fixture.txt"), "K is supported\n");
			const failed = await run("fail", root, fault);
			expect(failed.failures).toBeGreaterThan(0);
			expect(failed.acceptedAtFault).toBeGreaterThan(0);
			expect(failed.mission.evaluations.length).toBeGreaterThan(0);
			expect(failed.mission.report.state).toBe("failed");
			expect(failed.mission.report.error).toContain("ENOSPC");
			expect(failed.mission.status).toBe("concluded");
			expect(failed.mission.judgment).toBe("supported");
			const directory = join(root, ".dinobot", "research", failed.mission.id);
			const interrupted = JSON.parse(await readFile(join(directory, "ownership.json"), "utf8"));
			expect(interrupted.pending).toBeDefined();
			const partialReport = await readFile(join(directory, "report.md"), "utf8");
			expect(hashResearchBytes(partialReport)).toBe(interrupted.pending.hashes["report.md"]);
			const repaired = await run("repair", root, fault);
			expect(repaired.providerCalls).toBe(0);
			expect(repaired.mission.id).toBe(failed.mission.id);
			expect(repaired.mission.ledger).toEqual(failed.mission.ledger);
			expect(repaired.mission.attempts).toEqual(failed.mission.attempts);
			expect(repaired.mission.evaluations).toEqual(failed.mission.evaluations);
			expect(repaired.mission.judgment).toBe(failed.mission.judgment);
			expect(repaired.mission.status).toBe(failed.mission.status);
			expect(repaired.mission.report.state).toBe("current");
			expect(repaired.mission.report.error).toBeUndefined();
			const owner = JSON.parse(await readFile(join(directory, "ownership.json"), "utf8"));
			expect(owner.pending).toBeUndefined();
			expect(owner.revision).toBe(repaired.mission.report.writtenRevision);
			for (const filename of ["report.md", "evidence.md"]) {
				expect(hashResearchBytes(await readFile(join(directory, filename), "utf8"))).toBe(owner.hashes[filename]);
			}
			const evidence = await readFile(join(directory, "evidence.md"), "utf8");
			for (const receipt of repaired.mission.evaluations) expect(evidence).toContain(receipt.receiptHash);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
	60_000,
);

test("superseding pending generation checkpoints older partial bytes before another interrupted publication", async () => {
	const root = await mkdtemp(join(tmpdir(), "research-report-checkpoint-"));
	try {
		await run("checkpoint", root, "manifest");
		const result = JSON.parse(await readFile(join(root, "checkpoint.json"), "utf8"));
		expect(result.checkpoint.hashes["report.md"]).toBe(hashResearchBytes("partial second"));
		expect(result.checkpoint.pending).toEqual({
			revision: 3,
			hashes: {
				"report.md": hashResearchBytes("third"),
				"evidence.md": hashResearchBytes("old evidence"),
			},
		});
		expect(result.repaired).toBe("fourth");
		expect(result.owner.revision).toBe(4);
		expect(result.owner.pending).toBeUndefined();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 30_000);
