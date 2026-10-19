import { createHash } from "node:crypto";
import { Value } from "typebox/value";
import {
	CampaignSchema, ContractSchema, SealedContractSchema, SkillEvaluationError, exhaustive, immutable, requireEvaluation,
	type EvaluationCampaign, type EvaluationContract, type SealedEvaluationContract,
} from "./evaluation-schema.ts";

/** Locale-independent canonical JSON. Undefined, nonfinite values and non-JSON objects fail closed. */
export function skillEvaluationHash(value: unknown): string {
	function canonical(item: unknown): string {
		if (item === null) return "null";
		switch (typeof item) {
			case "string": return JSON.stringify(item);
			case "boolean": return String(item);
			case "number":
				requireEvaluation(Number.isFinite(item), "numeric", "hash");
				return JSON.stringify(item);
			case "object": {
				if (Array.isArray(item)) return `[${Array.from(item, canonical).join(",")}]`;
				requireEvaluation(Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null, "schema", "json");
				requireEvaluation(Object.getOwnPropertySymbols(item).length === 0, "schema", "json.symbols");
				return `{${Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
					.map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
			}
			default: throw new SkillEvaluationError("schema", "json");
		}
	}
	return createHash("sha256").update(canonical(value)).digest("hex");
}

export function evaluationBoundCount(contract: EvaluationContract): number {
	switch (contract.hypothesis.kind) {
		case "quality": return 2 + (contract.criticalStrata?.length ?? 0);
		case "efficiency": return 3 + (contract.criticalStrata?.length ?? 0);
		default: return exhaustive(contract.hypothesis);
	}
}

export function createEvaluationContract(input: unknown): SealedEvaluationContract {
	requireEvaluation(Value.Check(ContractSchema, input), "schema", "contract");
	requireEvaluation(input.alphaPerBound.units < input.alphaPerBound.scale, "range", "alphaPerBound");
	const ids = new Set<string>();
	let mass = 0;
	for (const unit of input.units) {
		requireEvaluation(!ids.has(unit.id), "duplicate", "unit.id");
		ids.add(unit.id); mass += unit.mass;
		requireEvaluation(Number.isSafeInteger(mass), "range", "unit.mass");
	}
	requireEvaluation(input.qualityRadius <= 2, "range", "qualityRadius");
	const strata = new Set<string>();
	for (const stratum of input.criticalStrata ?? []) {
		requireEvaluation(!strata.has(stratum.id), "duplicate", "criticalStratum");
		requireEvaluation(input.units.some((unit) => unit.stratum === stratum.id), "assignment", "criticalStratum");
		strata.add(stratum.id);
	}
	requireEvaluation(evaluationBoundCount(input) <= 8, "campaign", "boundCount");
	switch (input.hypothesis.kind) {
		case "quality": break;
		case "efficiency": {
			const h = input.hypothesis;
			for (const metric of [h.cost, h.latency]) {
				requireEvaluation(metric.bounds.lower >= 0 && metric.bounds.upper > metric.bounds.lower, "range", "boundedUnits");
			}
			const width = 1 + h.costWeight + h.latencyWeight;
			requireEvaluation(Number.isFinite(2 * width) && h.costWeight + h.latencyWeight > 0, "range", "utilityWeights");
			requireEvaluation(h.utilityRadius <= 2 * width && h.utilityImprovement < width, "range", "utility");
			break;
		}
		default: return exhaustive(input.hypothesis);
	}
	return immutable({
		spec: input,
		hash: skillEvaluationHash(input),
		envelopeHash: skillEvaluationHash(input.envelope),
		assignmentHash: skillEvaluationHash(input.units),
	});
}

export function readEvaluationContract(input: unknown): SealedEvaluationContract {
	requireEvaluation(Value.Check(SealedContractSchema, input), "schema", "sealedContract");
	const sealed = createEvaluationContract(input.spec);
	requireEvaluation(input.hash === sealed.hash && input.envelopeHash === sealed.envelopeHash
		&& input.assignmentHash === sealed.assignmentHash, "hash", "contract");
	return sealed;
}

export function readEvaluationCampaign(input: unknown): EvaluationCampaign {
	requireEvaluation(Value.Check(CampaignSchema, input), "schema", "campaign");
	requireEvaluation(input.alpha.units < input.alpha.scale, "range", "campaign.alpha");
	requireEvaluation(input.reservations.length <= input.maxAttempts, "campaign", "maxAttempts");
	const ids = new Set<string>();
	let spent = 0;
	for (const reservation of input.reservations) {
		requireEvaluation(!ids.has(reservation.attemptId), "duplicate", "attemptId");
		ids.add(reservation.attemptId);
		const charge = reservation.alphaUnits * reservation.boundCount;
		requireEvaluation(Number.isSafeInteger(charge), "range", "alphaCharge");
		spent += charge;
		requireEvaluation(Number.isSafeInteger(spent) && spent <= input.alpha.units, "campaign", "alphaBudget");
	}
	return immutable(input);
}

/**
 * Pure ledger transition, not a durable reservation. The trusted writer must CAS/store this result
 * before exposing confirmation data, retain all attempts, and prevent campaign/anchor resets.
 */
export function reserveEvaluationAttempt(campaignInput: unknown, contractInput: unknown): EvaluationCampaign {
	const campaign = readEvaluationCampaign(campaignInput);
	const contract = readEvaluationContract(contractInput);
	requireEvaluation(campaign.id === contract.spec.campaignId
		&& campaign.alpha.scale === contract.spec.alphaPerBound.scale, "campaign", "identity");
	const reservation = {
		attemptId: contract.spec.attemptId, contractHash: contract.hash,
		alphaUnits: contract.spec.alphaPerBound.units, boundCount: evaluationBoundCount(contract.spec),
	};
	const prior = campaign.reservations.find((item) => item.attemptId === reservation.attemptId);
	if (prior) {
		requireEvaluation(prior.contractHash === reservation.contractHash && prior.alphaUnits === reservation.alphaUnits
			&& prior.boundCount === reservation.boundCount, "reservation", "attemptId");
		return campaign;
	}
	return readEvaluationCampaign({ ...campaign, reservations: [...campaign.reservations, reservation] });
}

export function requireEvaluationReservation(campaign: EvaluationCampaign, contract: SealedEvaluationContract): void {
	const reservation = campaign.reservations.find((item) => item.attemptId === contract.spec.attemptId);
	requireEvaluation(reservation !== undefined, "reservation", "missing");
	requireEvaluation(campaign.id === contract.spec.campaignId && campaign.alpha.scale === contract.spec.alphaPerBound.scale
		&& reservation.contractHash === contract.hash && reservation.alphaUnits === contract.spec.alphaPerBound.units
		&& reservation.boundCount === evaluationBoundCount(contract.spec), "reservation", "binding");
}
