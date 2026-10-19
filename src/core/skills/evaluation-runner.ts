import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { readEvaluationContract, requireEvaluationReservation, skillEvaluationHash } from "./evaluation-contract.ts";
import type { EvaluationArm, EvaluationCampaign, EvaluationEnvelope, EvaluationEvidence, SealedEvaluationContract } from "./evaluation-schema.ts";
import { runSkillSandbox, type SkillSandboxResult } from "./sandbox.ts";

type Arm = "baseline" | "candidate" | "anchor";
type RawRun = { readonly unitId: string; readonly arm: Arm; readonly result: SkillSandboxResult };
/** Registered by the host, never by an author or a model-facing tool. */
export type RegisteredSkillExperiment = {
	readonly envelope: EvaluationEnvelope;
	readonly maxOutputBytes: number;
	readonly units: readonly {
		readonly id: string;
		/** Each arm's complete fixture, including its exact immutable skill bundle. */
		readonly directories: Readonly<Record<Arm, { readonly path: string; readonly digest: string }>>;
		readonly command: readonly [string, ...string[]];
	}[];
	/** A trusted artifact oracle outside the sandbox, not an LLM-authored passed bit. */
	readonly score: (run: RawRun) => {
		readonly quality: number; readonly guardsPassed: boolean;
		/** Independent host instrumentation, never candidate-reported approval/cost. */
		readonly cost?: number; readonly latency?: number;
	};
};

/** Bounded file inventory; symlinks and special files are not experiment inputs. */
export async function skillFixtureDigest(directory: string): Promise<string> {
	const files: [string, string][] = [];
	let bytes = 0;
	async function visit(relative: string): Promise<void> {
		const path = join(directory, relative);
		const stat = await lstat(path);
		if (stat.isDirectory()) {
			for (const name of (await readdir(path)).sort()) await visit(relative ? `${relative}/${name}` : name);
		} else if (stat.isFile()) {
			bytes += stat.size;
			if (files.length >= 1024 || bytes > 16 * 1024 * 1024) throw new Error("Fixture inventory limit exceeded");
			files.push([relative, createHash("sha256").update(await readFile(path)).digest("hex")]);
		} else throw new Error("Fixture contains a symlink or special file");
	}
	await visit("");
	return skillEvaluationHash(files);
}

export async function registeredSkillExperimentDigest(experiment: RegisteredSkillExperiment): Promise<string> {
	for (const unit of experiment.units) {
		for (const fixture of Object.values(unit.directories)) {
			if (await skillFixtureDigest(fixture.path) !== fixture.digest) throw new Error("Fixture bytes changed after registration");
		}
	}
	return skillEvaluationHash(experiment.units.map((unit) => ({
		id: unit.id, command: [...unit.command],
		digests: Object.fromEntries(Object.entries(unit.directories).map(([arm, fixture]) => [arm, fixture.digest])),
	})));
}

/**
 * Actual isolated fixture execution, not simulated scores. Caller persists the
 * campaign reservation before this call and seals raw records with the returned
 * evidence in the trusted ledger. Fixture authenticity/freshness belongs to that
 * registration boundary. No main conversation or publication API is exposed.
 */
export async function runSkillEvaluation(input: {
	readonly contract: SealedEvaluationContract;
	readonly campaign: EvaluationCampaign;
	readonly experiment: RegisteredSkillExperiment;
	readonly signal: AbortSignal;
}): Promise<{ readonly evidence: EvaluationEvidence; readonly raw: readonly RawRun[] }> {
	const contract = readEvaluationContract(input.contract);
	requireEvaluationReservation(input.campaign, contract);
	if (skillEvaluationHash(input.experiment.envelope) !== contract.envelopeHash) throw new Error("Registered experiment envelope mismatch");
	const hypothesis = contract.spec.hypothesis;
	const units = new Map(input.experiment.units.map((unit) => [unit.id, unit]));
	if (units.size !== input.experiment.units.length || units.size !== contract.spec.units.length ||
		contract.spec.units.some((unit) => !units.has(unit.id))) throw new Error("Registered fixture assignment mismatch");
	if (await registeredSkillExperimentDigest(input.experiment) !== contract.spec.envelope.datasetHash) throw new Error("Registered dataset digest mismatch");
	const raw: RawRun[] = [];
	let rawBytes = 0;
	const outcomes: EvaluationEvidence["outcomes"][number][] = [];
	let guardsPassed = true;
	for (const unit of contract.spec.units) {
		input.signal.throwIfAborted();
		const fixture = units.get(unit.id);
		if (!fixture) throw new Error("Registered fixture disappeared");
		// Freeze arm order from assignment identity, independent of outcomes.
		const order: Arm[] = ["baseline", "candidate", "anchor"];
		order.sort((a, b) => {
			const rank = (arm: Arm) => createHash("sha256").update(`${contract.assignmentHash}:${unit.id}:${arm}`).digest("hex");
			return rank(a).localeCompare(rank(b));
		});
		const missing = { kind: "missing", reason: "pending" } as const;
		const pending: EvaluationArm = hypothesis.kind === "efficiency"
			? { quality: missing, cost: missing, latency: missing } : { quality: missing };
		const values: Record<Arm, EvaluationArm> = { baseline: pending, candidate: pending, anchor: pending };
		const cutoff = AbortSignal.timeout(contract.spec.outcomeDeadlineMs);
		for (const arm of order) {
			if (cutoff.aborted) {
				continue;
			}
			const directory = fixture.directories[arm];
			if (await skillFixtureDigest(directory.path) !== directory.digest) throw new Error("Fixture bytes changed after registration");
			const result = await runSkillSandbox({
				fixtureDirectory: directory.path, command: fixture.command,
				timeoutMs: contract.spec.outcomeDeadlineMs,
				maxOutputBytes: input.experiment.maxOutputBytes,
				signal: AbortSignal.any([input.signal, cutoff]),
			});
			if (await skillFixtureDigest(fixture.directories[arm].path) !== fixture.directories[arm].digest) throw new Error("Fixture bytes changed during execution");
			const run = { unitId: unit.id, arm, result };
			rawBytes += Buffer.byteLength(JSON.stringify(run));
			if (rawBytes > 8 * 1024 * 1024) throw new Error("Confirmation raw evidence exceeds its bounded storage budget");
			raw.push(run);
			input.signal.throwIfAborted();
			switch (result.status) {
				case "timeout":
				case "cancelled": {
					const timeout = { kind: "timeout" } as const;
					values[arm] = hypothesis.kind === "efficiency"
						? { quality: timeout, cost: timeout, latency: timeout } : { quality: timeout };
					break;
				}
				case "completed":
				case "failed":
				case "output_limit": {
					const score = input.experiment.score(run);
					if (!Number.isFinite(score.quality) || score.quality < 0 || score.quality > 1 || typeof score.guardsPassed !== "boolean") throw new Error("Trusted scorer returned invalid quality");
					values[arm] = { quality: { kind: "observed", value: score.quality } };
					if (hypothesis.kind === "efficiency" && arm !== "anchor") {
						if (score.cost === undefined || !Number.isFinite(score.cost) || score.cost < hypothesis.cost.bounds.lower || score.cost > hypothesis.cost.bounds.upper ||
							score.latency === undefined || !Number.isFinite(score.latency) || score.latency < hypothesis.latency.bounds.lower || score.latency > hypothesis.latency.bounds.upper) {
							throw new Error("Missing or unbounded trusted efficiency instrumentation");
						}
						values[arm] = { ...values[arm], cost: { kind: "observed", value: score.cost }, latency: { kind: "observed", value: score.latency } };
					}
					guardsPassed &&= score.guardsPassed;
					break;
				}
			}
		}
		outcomes.push({ id: unit.id, baseline: values.baseline, candidate: values.candidate, anchor: values.anchor.quality });
	}
	return {
		raw,
		evidence: {
			contractHash: contract.hash, envelopeHash: contract.envelopeHash,
			assignmentHash: contract.assignmentHash, rawEvidenceHash: skillEvaluationHash(raw),
			integrity: "intact", guardsPassed, outcomes,
		},
	};
}
