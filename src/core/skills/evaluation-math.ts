import { readEvaluationContract } from "./evaluation-contract.ts";
import {
	exhaustive, immutable, requireEvaluation,
	type EvaluationOutcome, type Interval,
} from "./evaluation-schema.ts";

export type WeightedPair = {
	readonly mass: number;
	readonly candidate: Interval;
	readonly baseline: Interval;
};
export type PairedBounds = {
	readonly lowerMean: number; readonly upperMean: number;
	readonly lower: number; readonly upper: number; readonly radius: number;
	readonly assignedUnits: number; readonly effectiveUnits: number;
};
function validRange(range: Interval): void {
	requireEvaluation(Number.isFinite(range.lower) && Number.isFinite(range.upper)
		&& range.lower < range.upper && Number.isFinite(2 * (range.upper - range.lower)), "range", "outcomeBounds");
}
function probability(alpha: number): void {
	requireEvaluation(Number.isFinite(alpha) && alpha > 0 && alpha < 1, "range", "probability");
}

/** Missing is a full bounded interval, never an observed zero. Timeout is a registered penalty. */
export function outcomeInterval(outcome: EvaluationOutcome, range: Interval, timeoutScore: number): Interval {
	validRange(range);
	requireEvaluation(Number.isFinite(timeoutScore) && timeoutScore >= range.lower && timeoutScore <= range.upper, "range", "timeoutScore");
	switch (outcome.kind) {
		case "observed":
			requireEvaluation(Number.isFinite(outcome.value) && outcome.value >= range.lower && outcome.value <= range.upper, "range", "observedOutcome");
			return Object.freeze({ lower: outcome.value, upper: outcome.value });
		case "missing":
			return Object.freeze({ ...range });
		case "timeout":
			return Object.freeze({ lower: timeoutScore, upper: timeoutScore });
		default: return exhaustive(outcome);
	}
}

/**
 * Fixed, positive integer masses encode prespecified relative weights. Each returned tail has
 * error probability alpha; the two tails are NOT a simultaneous 1-alpha confidence interval.
 * Assumes independent latent paired cluster outcomes and a fixed (not optional) stopping rule.
 */
export function weightedPairedBounds(input: {
	readonly pairs: readonly WeightedPair[]; readonly range: Interval; readonly alpha: number;
}): PairedBounds {
	validRange(input.range); probability(input.alpha);
	requireEvaluation(input.pairs.length > 0, "range", "sampleSize");
	let totalMass = 0;
	for (const pair of input.pairs) {
		requireEvaluation(Number.isSafeInteger(pair.mass) && pair.mass > 0, "range", "mass");
		totalMass += pair.mass;
		requireEvaluation(Number.isSafeInteger(totalMass), "range", "totalMass");
		for (const interval of [pair.candidate, pair.baseline]) {
			requireEvaluation(Number.isFinite(interval.lower) && Number.isFinite(interval.upper)
				&& interval.lower >= input.range.lower && interval.upper <= input.range.upper
				&& interval.lower <= interval.upper, "range", "pairedInterval");
		}
	}
	let lowerMean = 0; let upperMean = 0; let squaredWeights = 0;
	for (const pair of input.pairs) {
		const weight = pair.mass / totalMass;
		lowerMean += weight * (pair.candidate.lower - pair.baseline.upper);
		upperMean += weight * (pair.candidate.upper - pair.baseline.lower);
		squaredWeights += weight * weight;
	}
	const width = input.range.upper - input.range.lower;
	// Ordinary IEEE-754 log/sqrt; no claim of formally certified interval arithmetic.
	const radius = width * Math.sqrt(-2 * Math.log(input.alpha) * squaredWeights);
	requireEvaluation([lowerMean, upperMean, radius].every(Number.isFinite), "numeric", "pairedBounds");
	return Object.freeze({
		lowerMean, upperMean, radius,
		lower: Math.max(-width, lowerMean - radius), upper: Math.min(width, upperMean + radius),
		assignedUnits: input.pairs.length, effectiveUnits: 1 / squaredWeights,
	});
}

export type SampleRequirement = {
	readonly differenceWidth: number; readonly alpha: number; readonly maxRadius: number;
	readonly power?: { readonly gap: number; readonly beta: number };
};
/**
 * Sufficient equal-weight independent sample count, not guaranteed power under missingness.
 * null means the requirement exceeds the safe-integer sample-count domain.
 */
export function requiredPairedSampleSize(input: SampleRequirement): number | null {
	probability(input.alpha);
	requireEvaluation(Number.isFinite(input.differenceWidth) && input.differenceWidth > 0
		&& Number.isFinite(input.maxRadius) && input.maxRadius > 0, "range", "sampleRequirement");
	const ratio = input.differenceWidth / input.maxRadius;
	let required = ratio * ratio * -Math.log(input.alpha) / 2;
	if (input.power !== undefined) {
		probability(input.power.beta);
		requireEvaluation(Number.isFinite(input.power.gap) && input.power.gap > 0, "range", "powerGap");
		const powerRatio = input.differenceWidth / input.power.gap;
		required = Math.max(required, powerRatio * powerRatio / 2
			* (Math.sqrt(-Math.log(input.alpha)) + Math.sqrt(-Math.log(input.power.beta))) ** 2);
	}
	const count = Math.max(1, Math.ceil(required));
	return Number.isSafeInteger(count) ? count : null;
}

export type EvaluationFeasibility = {
	readonly feasible: boolean; readonly independentUnits: number; readonly effectiveUnits: number;
	readonly requirements: readonly {
		readonly endpoint: "quality" | "utility"; readonly radius: number;
		readonly maxRadius: number; readonly requiredEqualWeightUnits: number | null;
	}[];
};
export function evaluationFeasibility(contractInput: unknown): EvaluationFeasibility {
	const { spec } = readEvaluationContract(contractInput);
	const alpha = spec.alphaPerBound.units / spec.alphaPerBound.scale;
	const total = spec.units.reduce((sum, unit) => sum + unit.mass, 0);
	const squaredWeights = spec.units.reduce((sum, unit) => sum + (unit.mass / total) ** 2, 0);
	const requirements: { endpoint: "quality" | "utility"; width: number; maxRadius: number }[] = [
		{ endpoint: "quality", width: 2, maxRadius: spec.qualityRadius },
	];
	switch (spec.hypothesis.kind) {
		case "quality": break;
		case "efficiency":
			requirements.push({
				endpoint: "utility", width: 2 * (1 + spec.hypothesis.costWeight + spec.hypothesis.latencyWeight),
				maxRadius: spec.hypothesis.utilityRadius,
			});
			break;
		default: return exhaustive(spec.hypothesis);
	}
	const measured = requirements.map(({ endpoint, width, maxRadius }) => ({
		endpoint, maxRadius, radius: width * Math.sqrt(-Math.log(alpha) * squaredWeights / 2),
		requiredEqualWeightUnits: requiredPairedSampleSize({ differenceWidth: width, alpha, maxRadius }),
	}));
	return immutable({
		feasible: measured.every((item) => item.requiredEqualWeightUnits !== null && item.radius <= item.maxRadius),
		independentUnits: spec.units.length, effectiveUnits: 1 / squaredWeights, requirements: measured,
	});
}
