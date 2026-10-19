import { Value } from "typebox/value";
import {
	readEvaluationCampaign, readEvaluationContract, requireEvaluationReservation, skillEvaluationHash,
} from "./evaluation-contract.ts";
import { evaluationFeasibility, outcomeInterval, weightedPairedBounds, type EvaluationFeasibility, type PairedBounds } from "./evaluation-math.ts";
import {
	EvidenceSchema, SkillEvaluationError, exhaustive, immutable, requireEvaluation,
	type EvaluationArm, type EvaluationContract, type EvaluationErrorCode, type Interval,
} from "./evaluation-schema.ts";

export { createEvaluationContract, reserveEvaluationAttempt, skillEvaluationHash } from "./evaluation-contract.ts";
export { evaluationFeasibility, outcomeInterval, requiredPairedSampleSize, weightedPairedBounds } from "./evaluation-math.ts";
export { SkillEvaluationError } from "./evaluation-schema.ts";
export type {
	EvaluationCampaign, EvaluationContract, EvaluationEnvelope, EvaluationEvidence, EvaluationOutcome,
	Interval, SealedEvaluationContract,
} from "./evaluation-schema.ts";

export type StatisticalGate = PairedBounds & {
	readonly endpoint: "quality" | "anchor" | "utility" | "stratum";
	readonly stratum?: string;
	readonly threshold: number;
	readonly passed: boolean;
};
export type SkillEvaluationDecision =
	| { readonly kind: "statistical-decision"; readonly status: "invalid"; readonly code: EvaluationErrorCode | "integrity"; readonly field: string }
	| {
		readonly kind: "statistical-decision";
		readonly status: "passed" | "inconclusive" | "rejected";
		readonly reason: "accepted" | "sample" | "bounds" | "guards";
		readonly contractHash: string; readonly envelopeHash: string;
		readonly evidenceHash: string; readonly rawEvidenceHash: string;
		readonly feasibility: EvaluationFeasibility;
		readonly gates: readonly StatisticalGate[];
	};
const qualityRange = Object.freeze({ lower: 0, upper: 1 });
type Efficiency = Extract<EvaluationContract["hypothesis"], { readonly kind: "efficiency" }>;

/** v1 utility uses normalized bounded costs/latency. Timeout penalties are their registered maxima. */
function utilityInterval(arm: EvaluationArm, hypothesis: Efficiency): Interval {
	requireEvaluation(arm.cost !== undefined && arm.latency !== undefined, "schema", "efficiencyOutcomes");
	const quality = outcomeInterval(arm.quality, qualityRange, 0);
	const cost = outcomeInterval(arm.cost, hypothesis.cost.bounds, hypothesis.cost.bounds.upper);
	const latency = outcomeInterval(arm.latency, hypothesis.latency.bounds, hypothesis.latency.bounds.upper);
	const costWidth = hypothesis.cost.bounds.upper - hypothesis.cost.bounds.lower;
	const latencyWidth = hypothesis.latency.bounds.upper - hypothesis.latency.bounds.lower;
	return {
		lower: quality.lower - hypothesis.costWeight * ((cost.upper - hypothesis.cost.bounds.lower) / costWidth)
			- hypothesis.latencyWeight * ((latency.upper - hypothesis.latency.bounds.lower) / latencyWidth),
		upper: quality.upper - hypothesis.costWeight * ((cost.lower - hypothesis.cost.bounds.lower) / costWidth)
			- hypothesis.latencyWeight * ((latency.lower - hypothesis.latency.bounds.lower) / latencyWidth),
	};
}

/**
 * Pure arithmetic decision, never a package approval, authenticated execution receipt, or permission
 * to publish. A trusted runner must supply complete fixed-cutoff outcomes and enforce isolation,
 * fresh sampling, scorer integrity and the durable pre-exposure campaign reservation.
 * A publisher must separately recheck current baseline/anchor/policy/environment, revocation and fence.
 */
export function decideSkillEvaluation(contractInput: unknown, evidenceInput: unknown, campaignInput: unknown): SkillEvaluationDecision {
	try {
		const contract = readEvaluationContract(contractInput);
		const campaign = readEvaluationCampaign(campaignInput);
		requireEvaluationReservation(campaign, contract);
		requireEvaluation(Value.Check(EvidenceSchema, evidenceInput), "schema", "evidence");
		requireEvaluation(evidenceInput.contractHash === contract.hash && evidenceInput.envelopeHash === contract.envelopeHash
			&& evidenceInput.assignmentHash === contract.assignmentHash, "hash", "evidence");
		switch (evidenceInput.integrity) {
			case "compromised":
				return Object.freeze({ kind: "statistical-decision", status: "invalid", code: "integrity", field: "evidence" });
			case "intact": break;
			default: return exhaustive(evidenceInput.integrity);
		}
		const rows = new Map(evidenceInput.outcomes.map((row) => [row.id, row]));
		requireEvaluation(rows.size === evidenceInput.outcomes.length, "duplicate", "outcome.id");
		requireEvaluation(rows.size === contract.spec.units.length, "assignment", "outcome.count");
		const paired = contract.spec.units.map((unit) => {
			const row = rows.get(unit.id);
			requireEvaluation(row !== undefined, "assignment", "outcome.id");
			return { ...unit, row };
		});
		const spec = contract.spec;
		const alpha = spec.alphaPerBound.units / spec.alphaPerBound.scale;
		const baseline = weightedPairedBounds({
			alpha, range: qualityRange,
			pairs: paired.map(({ mass, row }) => ({
				mass, candidate: outcomeInterval(row.candidate.quality, qualityRange, 0),
				baseline: outcomeInterval(row.baseline.quality, qualityRange, 0),
			})),
		});
		const anchor = weightedPairedBounds({
			alpha, range: qualityRange,
			pairs: paired.map(({ mass, row }) => ({
				mass, candidate: outcomeInterval(row.candidate.quality, qualityRange, 0),
				baseline: outcomeInterval(row.anchor, qualityRange, 0),
			})),
		});
		const gates: StatisticalGate[] = [];
		switch (spec.hypothesis.kind) {
			case "quality":
				gates.push({ ...baseline, endpoint: "quality", threshold: spec.hypothesis.improvement, passed: baseline.lower > spec.hypothesis.improvement });
				break;
			case "efficiency": {
				const h = spec.hypothesis;
				gates.push({ ...baseline, endpoint: "quality", threshold: -h.qualityLoss, passed: baseline.lower > -h.qualityLoss });
				const utility = weightedPairedBounds({
					alpha, range: { lower: -(h.costWeight + h.latencyWeight), upper: 1 },
					pairs: paired.map(({ mass, row }) => ({
						mass, candidate: utilityInterval(row.candidate, h), baseline: utilityInterval(row.baseline, h),
					})),
				});
				gates.push({ ...utility, endpoint: "utility", threshold: h.utilityImprovement, passed: utility.lower > h.utilityImprovement });
				break;
			}
			default: return exhaustive(spec.hypothesis);
		}
		gates.push({ ...anchor, endpoint: "anchor", threshold: -spec.anchorLoss, passed: anchor.lower > -spec.anchorLoss });
		for (const stratum of spec.criticalStrata ?? []) {
			const bounds = weightedPairedBounds({
				alpha, range: qualityRange,
				pairs: paired.filter((unit) => unit.stratum === stratum.id).map(({ mass, row }) => ({
					mass, candidate: outcomeInterval(row.candidate.quality, qualityRange, 0),
					baseline: outcomeInterval(row.baseline.quality, qualityRange, 0),
				})),
			});
			gates.push({ ...bounds, endpoint: "stratum", stratum: stratum.id, threshold: -stratum.qualityLoss, passed: bounds.lower > -stratum.qualityLoss });
		}
		const feasibility = evaluationFeasibility(contract);
		const common = {
			kind: "statistical-decision", contractHash: contract.hash, envelopeHash: contract.envelopeHash,
			evidenceHash: skillEvaluationHash(evidenceInput), rawEvidenceHash: evidenceInput.rawEvidenceHash, gates, feasibility,
		} as const;
		if (!evidenceInput.guardsPassed) return immutable({ ...common, status: "rejected", reason: "guards" });
		if (!feasibility.feasible) return immutable({ ...common, status: "inconclusive", reason: "sample" });
		if (gates.some((gate) => !gate.passed)) return immutable({ ...common, status: "inconclusive", reason: "bounds" });
		return immutable({ ...common, status: "passed", reason: "accepted" });
	} catch (error) {
		if (error instanceof SkillEvaluationError) {
			return Object.freeze({ kind: "statistical-decision", status: "invalid", code: error.code, field: error.field });
		}
		throw error;
	}
}
