import { Type, type Static } from "typebox";

export type ReadonlyData<T> = T extends object ? { readonly [K in keyof T]: ReadonlyData<T[K]> } : T;
export type EvaluationErrorCode = "schema" | "range" | "duplicate" | "hash" | "campaign" | "reservation" | "assignment" | "numeric";
export class SkillEvaluationError extends Error {
	readonly name = "SkillEvaluationError";
	constructor(readonly code: EvaluationErrorCode, readonly field: string) {
		super(`${code}: ${field}`);
	}
}
export function requireEvaluation(condition: boolean, code: EvaluationErrorCode, field: string): asserts condition {
	if (!condition) throw new SkillEvaluationError(code, field);
}
export function exhaustive(value: never): never {
	throw new SkillEvaluationError("schema", String(value));
}

const object = { additionalProperties: false } as const;
const finite = Type.Number({ minimum: -Number.MAX_VALUE, maximum: Number.MAX_VALUE });
const positive = Type.Number({ exclusiveMinimum: 0, maximum: Number.MAX_VALUE });
const natural = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const identifier = Type.String({ minLength: 1, maxLength: 200, pattern: "\\S" });
export const HashSchema = Type.String({ pattern: "^[a-f0-9]{64}$" });
export const IntervalSchema = Type.Object({ lower: finite, upper: finite }, object);
export type Interval = ReadonlyData<Static<typeof IntervalSchema>>;
/** Exact integer accounting; the probability is units / scale. */
export const AlphaSchema = Type.Object({ units: natural, scale: natural }, object);
export type AlphaAllocation = ReadonlyData<Static<typeof AlphaSchema>>;

export const EnvelopeSchema = Type.Object({
	baselinePublicationId: identifier,
	baselineGeneration: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	baselineManifestHash: HashSchema,
	candidateManifestHash: HashSchema,
	anchorManifestHash: HashSchema,
	anchorEpoch: natural,
	distributionHash: HashSchema,
	datasetHash: HashSchema,
	evaluatorHash: HashSchema,
	harnessHash: HashSchema,
	modelConfigHash: HashSchema,
	toolSchemaHash: HashSchema,
	routingHash: HashSchema,
	environmentHash: HashSchema,
	policyHash: HashSchema,
}, object);
export type EvaluationEnvelope = ReadonlyData<Static<typeof EnvelopeSchema>>;
const cost = Type.Object({ unit: Type.Union([Type.Literal("USD"), Type.Literal("tokens")]), bounds: IntervalSchema }, object);
const latency = Type.Object({ unit: Type.Literal("ms"), bounds: IntervalSchema }, object);
const quality = Type.Object({ kind: Type.Literal("quality"), improvement: Type.Number({ minimum: 0, maximum: 1 }) }, object);
const efficiency = Type.Object({
	kind: Type.Literal("efficiency"),
	qualityLoss: Type.Number({ minimum: 0, maximum: 1 }),
	utilityImprovement: Type.Number({ minimum: 0, maximum: Number.MAX_VALUE }),
	cost, latency,
	costWeight: Type.Number({ minimum: 0, maximum: Number.MAX_VALUE }),
	latencyWeight: Type.Number({ minimum: 0, maximum: Number.MAX_VALUE }),
	utilityRadius: positive,
}, object);
export const ContractSchema = Type.Object({
	revision: Type.Literal("skill-evaluation-v1"),
	campaignId: identifier,
	attemptId: identifier,
	envelope: EnvelopeSchema,
	alphaPerBound: AlphaSchema,
	/** Fixed per-cluster deadline from assignment; the runner seals all arms at this cutoff. */
	outcomeDeadlineMs: natural,
	/** Each row is one independent cluster, not one repeated model call. */
	units: Type.Array(Type.Object({ id: identifier, mass: natural, stratum: Type.Optional(identifier) }, object), { minItems: 1 }),
	criticalStrata: Type.Optional(Type.Array(Type.Object({
		id: identifier, qualityLoss: Type.Number({ minimum: 0, maximum: 1 }),
	}, object), { maxItems: 6 })),
	qualityRadius: positive,
	anchorLoss: Type.Number({ minimum: 0, maximum: 1 }),
	hypothesis: Type.Union([quality, efficiency]),
}, object);
export type EvaluationContract = ReadonlyData<Static<typeof ContractSchema>>;
export const SealedContractSchema = Type.Object({
	spec: ContractSchema, hash: HashSchema, envelopeHash: HashSchema, assignmentHash: HashSchema,
}, object);
export type SealedEvaluationContract = ReadonlyData<Static<typeof SealedContractSchema>>;

export const CampaignSchema = Type.Object({
	id: identifier, alpha: AlphaSchema, maxAttempts: natural,
	/** Reservations are spent permanently. There is intentionally no refund/status field. */
	reservations: Type.Array(Type.Object({
		attemptId: identifier, contractHash: HashSchema, alphaUnits: natural, boundCount: natural,
	}, object)),
}, object);
export type EvaluationCampaign = ReadonlyData<Static<typeof CampaignSchema>>;
export const OutcomeSchema = Type.Union([
	Type.Object({ kind: Type.Literal("observed"), value: finite }, object),
	Type.Object({ kind: Type.Literal("timeout") }, object),
	Type.Object({ kind: Type.Literal("missing"), reason: Type.Union([Type.Literal("pending"), Type.Literal("unobserved")]) }, object),
]);
export type EvaluationOutcome = ReadonlyData<Static<typeof OutcomeSchema>>;
const arm = Type.Object({
	quality: OutcomeSchema, cost: Type.Optional(OutcomeSchema), latency: Type.Optional(OutcomeSchema),
}, object);
export type EvaluationArm = ReadonlyData<Static<typeof arm>>;
export const EvidenceSchema = Type.Object({
	contractHash: HashSchema, envelopeHash: HashSchema, assignmentHash: HashSchema,
	/** Reference supplied by the trusted runner; this module cannot authenticate external bytes. */
	rawEvidenceHash: HashSchema,
	integrity: Type.Union([Type.Literal("intact"), Type.Literal("compromised")]),
	guardsPassed: Type.Boolean(),
	outcomes: Type.Array(Type.Object({
		id: identifier, baseline: arm, candidate: arm, anchor: OutcomeSchema,
	})),
}, object);
export type EvaluationEvidence = ReadonlyData<Static<typeof EvidenceSchema>>;

/** Freeze a detached, already parsed JSON tree; callers' mutable objects are never frozen. */
export function immutable<T>(input: T): T {
	const copy = structuredClone(input);
	function freeze(value: unknown): void {
		if (value !== null && typeof value === "object") {
			for (const child of Object.values(value)) freeze(child);
			Object.freeze(value);
		}
	}
	freeze(copy);
	return copy;
}
