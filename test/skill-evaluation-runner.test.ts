import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEvaluationContract, decideSkillEvaluation, reserveEvaluationAttempt, skillEvaluationHash } from "../src/core/skills/evaluation.ts";
import { runSkillEvaluation, skillFixtureDigest } from "../src/core/skills/evaluation-runner.ts";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "skill-experiment-"));
	roots.push(root);
	const directories = {
		baseline: { path: join(root, "baseline"), digest: "" },
		candidate: { path: join(root, "candidate"), digest: "" },
		anchor: { path: join(root, "anchor"), digest: "" },
	};
	for (const [arm, directory] of Object.entries(directories)) {
		await mkdir(directory.path);
		await writeFile(join(directory.path, "input.txt"), arm === "candidate" ? "expected\n" : "wrong\n");
		directory.digest = await skillFixtureDigest(directory.path);
	}
	const command: [string, ...string[]] = ["/usr/bin/cat", "/fixture/input.txt"];
	const units = [{ id: "unit-1", directories, command }];
	const datasetHash = skillEvaluationHash([{
		id: "unit-1", command,
		digests: Object.fromEntries(Object.entries(directories).map(([arm, directory]) => [arm, directory.digest])),
	}]);
	const hash = "a".repeat(64);
	const envelope = {
		baselinePublicationId: "baseline", baselineGeneration: 1,
		baselineManifestHash: hash, candidateManifestHash: hash, anchorManifestHash: hash, anchorEpoch: 1,
		distributionHash: hash, datasetHash, evaluatorHash: hash, harnessHash: hash,
		modelConfigHash: hash, toolSchemaHash: hash, routingHash: hash, environmentHash: hash, policyHash: hash,
	};
	const contract = createEvaluationContract({
		revision: "skill-evaluation-v1", campaignId: "campaign", attemptId: "attempt",
		envelope, alphaPerBound: { units: 1, scale: 1000 }, outcomeDeadlineMs: 5000,
		units: [{ id: "unit-1", mass: 1 }], qualityRadius: 0.05, anchorLoss: 0.02,
		hypothesis: { kind: "quality", improvement: 0.02 },
	});
	const campaign = reserveEvaluationAttempt({ id: "campaign", alpha: { units: 50, scale: 1000 }, maxAttempts: 4, reservations: [] }, contract);
	return { units, envelope, contract, campaign, directories };
}

test("runner records actual isolated arm artifacts without claiming a one-fixture improvement", async () => {
	// Given a frozen assignment and trusted artifact oracle.
	const setup = await fixture();
	// When baseline, candidate and anchor run in separate namespaces.
	const result = await runSkillEvaluation({
		...setup,
		experiment: { envelope: setup.envelope, units: setup.units, maxOutputBytes: 1024,
			score: ({ result }) => ({ quality: result.stdout === "expected\n" ? 1 : 0, guardsPassed: result.exitCode === 0 }) },
		signal: new AbortController().signal,
	});
	// Then raw bytes, assignment and statistical insufficiency remain explicit.
	expect(result.raw).toHaveLength(3);
	expect(result.evidence.outcomes[0]).toMatchObject({
		id: "unit-1", candidate: { quality: { kind: "observed", value: 1 } },
		baseline: { quality: { kind: "observed", value: 0 } },
	});
	expect(result.evidence.rawEvidenceHash).toBe(skillEvaluationHash(result.raw));
	expect(decideSkillEvaluation(setup.contract, result.evidence, setup.campaign).status).toBe("inconclusive");
});

test("runner rejects fixture bytes changed after frozen registration", async () => {
	// Given a frozen digest followed by tampering.
	const setup = await fixture();
	await writeFile(join(setup.directories.candidate.path, "input.txt"), "tampered");
	// When the registered experiment is executed, then changed data cannot be scored.
	await expect(runSkillEvaluation({
		...setup,
		experiment: { envelope: setup.envelope, units: setup.units, maxOutputBytes: 1024,
			score: () => ({ quality: 1, guardsPassed: true }) },
		signal: new AbortController().signal,
	})).rejects.toThrow("Fixture bytes changed");
});

test("efficiency evaluation requires independently supplied bounded cost and latency", async () => {
	// Given a preregistered efficiency contract with an oracle lacking instrumentation.
	const setup = await fixture();
	const contract = createEvaluationContract({
		...setup.contract.spec,
		hypothesis: {
			kind: "efficiency", qualityLoss: 0.01, utilityImprovement: 0.01,
			cost: { unit: "USD", bounds: { lower: 0, upper: 1 } },
			latency: { unit: "ms", bounds: { lower: 0, upper: 1000 } },
			costWeight: 1, latencyWeight: 1, utilityRadius: 1,
		},
	});
	const campaign = reserveEvaluationAttempt({ ...setup.campaign, reservations: [] }, contract);
	// When the runner obtains a quality score without cost/latency evidence.
	const run = runSkillEvaluation({
		contract, campaign,
		experiment: { envelope: setup.envelope, units: setup.units, maxOutputBytes: 1024,
			score: () => ({ quality: 1, guardsPassed: true }) },
		signal: new AbortController().signal,
	});
	// Then it cannot fabricate efficiency improvement from quality alone.
	await expect(run).rejects.toThrow("efficiency instrumentation");
});
