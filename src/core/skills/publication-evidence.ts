import { Value } from "typebox/value";
import { EvidenceSchema, exhaustive, immutable, type EvaluationArm, type EvaluationEvidence, type EvaluationOutcome } from "./evaluation-schema.ts";
import { skillEvaluationHash, type SealedEvaluationContract } from "./evaluation.ts";
import { checkPublication, parsePublicationRaw, type PublicationRawRun, type TrustedExperiment } from "./publication-state.ts";

/**
 * Re-score raw artifacts with the registered host oracle; an alleged runner passed bit/outcome is
 * never authoritative. No runner import: the raw wire contract is independently validated here.
 */
export function reconstructPublicationEvidence(input: {
	readonly contract: SealedEvaluationContract; readonly raw: unknown;
	readonly evidence: unknown; readonly experiment: TrustedExperiment;
}): { readonly raw: readonly PublicationRawRun[]; readonly evidence: EvaluationEvidence } {
	const raw = parsePublicationRaw(input.raw);
	checkPublication(Value.Check(EvidenceSchema, input.evidence), "invalid", "runner evidence");
	const hypothesis = input.contract.spec.hypothesis;
	const missing: EvaluationOutcome = { kind: "missing", reason: "pending" };
	const pending: EvaluationArm = hypothesis.kind === "efficiency"
		? { quality: missing, cost: missing, latency: missing } : { quality: missing };
	const units = new Map(input.contract.spec.units.map((unit): [string, Record<"baseline" | "candidate" | "anchor", EvaluationArm>] => [unit.id, {
		baseline: pending, candidate: pending, anchor: pending,
	}]));
	const seen = new Set<string>(); let guardsPassed = true;
	for (const run of raw) {
		const unit = units.get(run.unitId);
		checkPublication(unit !== undefined, "integrity", "raw assignment");
		const key = JSON.stringify([run.unitId, run.arm]);
		checkPublication(!seen.has(key), "integrity", "duplicate raw arm"); seen.add(key);
		let outcome: EvaluationArm;
		switch (run.result.status) {
			case "timeout":
			// runSkillEvaluation throws on caller cancellation before returning evidence.
			// A returned cancelled sandbox arm therefore reflects its fixed cluster cutoff.
			case "cancelled": {
				const timeout = { kind: "timeout" } as const;
				outcome = hypothesis.kind === "efficiency"
					? { quality: timeout, cost: timeout, latency: timeout } : { quality: timeout };
				break;
			}
			case "completed":
			case "failed":
			case "output_limit": {
				const score = input.experiment.score(immutable(run));
				checkPublication(Number.isFinite(score.quality) && score.quality >= 0 && score.quality <= 1
					&& typeof score.guardsPassed === "boolean", "integrity", "host score");
				outcome = { quality: { kind: "observed", value: score.quality } };
				if (hypothesis.kind === "efficiency" && run.arm !== "anchor") {
					checkPublication(score.cost !== undefined && Number.isFinite(score.cost)
						&& score.cost >= hypothesis.cost.bounds.lower && score.cost <= hypothesis.cost.bounds.upper
						&& score.latency !== undefined && Number.isFinite(score.latency)
						&& score.latency >= hypothesis.latency.bounds.lower && score.latency <= hypothesis.latency.bounds.upper, "integrity", "bounded efficiency instrumentation");
					outcome = { ...outcome, cost: { kind: "observed", value: score.cost }, latency: { kind: "observed", value: score.latency } };
				}
				guardsPassed &&= score.guardsPassed;
				break;
			}
			default: return exhaustive(run.result.status);
		}
		unit[run.arm] = outcome;
	}
	const evidence: EvaluationEvidence = {
		contractHash: input.contract.hash, envelopeHash: input.contract.envelopeHash, assignmentHash: input.contract.assignmentHash,
		rawEvidenceHash: skillEvaluationHash(raw), integrity: "intact", guardsPassed,
		outcomes: [...units].map(([id, value]) => ({
			id, baseline: value.baseline, candidate: value.candidate, anchor: value.anchor.quality,
		})),
	};
	checkPublication(skillEvaluationHash(input.evidence) === skillEvaluationHash(evidence), "integrity", "raw evidence mismatch");
	return immutable({ raw, evidence });
}
