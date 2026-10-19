import { expect, test } from "bun:test";
// allow: SIZE_OK - The requested scope permits exactly one test file for this independent P4 suite.
import {
	createEvaluationContract, decideSkillEvaluation, evaluationFeasibility, outcomeInterval, requiredPairedSampleSize,
	reserveEvaluationAttempt, skillEvaluationHash, SkillEvaluationError, weightedPairedBounds,
	type EvaluationContract, type EvaluationEvidence, type EvaluationOutcome, type SealedEvaluationContract,
} from "../src/core/skills/evaluation.ts";

const hash = "a".repeat(64);
const envelope = {
	baselinePublicationId: "publication-1", baselineGeneration: 1,
	baselineManifestHash: hash, candidateManifestHash: hash, anchorManifestHash: hash, anchorEpoch: 1,
	distributionHash: hash, datasetHash: hash, evaluatorHash: hash, harnessHash: hash,
	modelConfigHash: hash, toolSchemaHash: hash, routingHash: hash, environmentHash: hash, policyHash: hash,
};
const campaign = { id: "campaign-1", alpha: { units: 50, scale: 1000 }, maxAttempts: 4, reservations: [] };
const range = { lower: 0, upper: 1 };
const observed = (value: number): EvaluationOutcome => ({ kind: "observed", value });
function spec(size = 400, overrides: Partial<EvaluationContract> = {}): EvaluationContract {
	return {
		revision: "skill-evaluation-v1", campaignId: campaign.id, attemptId: "attempt-1", envelope,
		alphaPerBound: { units: 10, scale: 1000 }, outcomeDeadlineMs: 300000,
		units: Array.from({ length: size }, (_, i) => ({ id: `u${i}`, mass: 1 })),
		qualityRadius: 0.2, anchorLoss: 0.02, hypothesis: { kind: "quality", improvement: 0.02 }, ...overrides,
	};
}
function evidence(contract: SealedEvaluationContract): EvaluationEvidence {
	return {
		contractHash: contract.hash, envelopeHash: contract.envelopeHash, assignmentHash: contract.assignmentHash,
		rawEvidenceHash: hash, integrity: "intact", guardsPassed: true,
		outcomes: contract.spec.units.map(({ id }) => ({ id, candidate: { quality: observed(0.8) }, baseline: { quality: observed(0.2) }, anchor: observed(0.2) })),
	};
}
function fixture(input = spec()) {
	const contract = createEvaluationContract(input);
	return { contract, evidence: evidence(contract), campaign: reserveEvaluationAttempt(campaign, contract) };
}
function decision(f = fixture()) { return decideSkillEvaluation(f.contract, f.evidence, f.campaign); }

test("critical-stratum regression blocks promotion despite a positive overall effect", () => {
	// Given a fixed rare-recovery stratum whose loss is hidden by aggregate improvement.
	const f = fixture(spec(2000, {
		units: Array.from({ length: 2000 }, (_, i) => ({ id: `u${i}`, mass: 1, stratum: i < 500 ? "recovery" : "common" })),
		criticalStrata: [{ id: "recovery", qualityLoss: 0.01 }],
	}));
	const raw = {
		...f.evidence,
		outcomes: f.evidence.outcomes.map((row, index) => ({
			...row,
			candidate: { quality: observed(index < 500 ? 0 : 0.8) },
			baseline: { quality: observed(index < 500 ? 1 : 0.2) },
			anchor: observed(0),
		})),
	};
	// When every preregistered gate is evaluated with its charged alpha.
	const result = decideSkillEvaluation(f.contract, raw, f.campaign);
	// Then the global gain cannot hide a failed critical guard.
	expect(result.status).toBe("inconclusive");
	if (result.status === "invalid") throw new Error("Unexpected invalid fixture");
	expect(result.gates.find((gate) => gate.endpoint === "quality")?.passed).toBe(true);
	expect(result.gates.find((gate) => gate.stratum === "recovery")?.passed).toBe(false);
	expect(f.campaign.reservations[0]?.boundCount).toBe(3);
});

test("freezes detached contracts and canonicalizes object keys without losing bindings", () => {
	// Given
	const input = { ...spec(), envelope: { ...envelope } };
	// When
	const sealed = createEvaluationContract(input);
	input.envelope.modelConfigHash = "b".repeat(64);
	// Then
	expect(sealed.spec.envelope.modelConfigHash).toBe(hash);
	expect(Object.isFrozen(sealed.spec.units)).toBe(true);
	expect(Object.isFrozen(sealed.spec.envelope)).toBe(true);
	expect(skillEvaluationHash({ b: 2, a: 1 })).toBe(skillEvaluationHash({ a: 1, b: 2 }));
	expect(skillEvaluationHash({ a: 1 })).not.toBe(skillEvaluationHash({ a: 2 }));
});
test.each(Object.keys(envelope))("rejects evidence after envelope field %s changes", (key) => {
	// Given
	const f = fixture(); const value = Object.entries(envelope).find(([name]) => name === key)?.[1];
	const contract = createEvaluationContract(spec(400, { envelope: { ...envelope, [key]: typeof value === "number" ? value + 1 : "b".repeat(64) } }));
	// When
	const result = decision({ ...f, contract, campaign: reserveEvaluationAttempt(campaign, contract) });
	// Then
	expect(result).toMatchObject({ status: "invalid", code: "hash" });
});
test.each([NaN, Infinity, -Infinity, undefined, { missing: undefined }, [, 1]])("rejects non-JSON hash input %j", (input) => {
	// Given / When / Then
	expect(() => skillEvaluationHash(input)).toThrow(SkillEvaluationError);
});
test.each([
	{ qualityRadius: NaN }, { qualityRadius: 0 }, { anchorLoss: -0.1 }, { units: [] },
	{ units: [{ id: "a", mass: 0 }] }, { units: [{ id: "a", mass: 1 }, { id: "a", mass: 1 }] },
	{ units: [{ id: "a", mass: Number.MAX_SAFE_INTEGER }, { id: "b", mass: 1 }] },
	{ alphaPerBound: { units: 1, scale: 1 } }, { alphaPerBound: { units: 0, scale: 1000 } },
	{ hypothesis: { kind: "efficiency", qualityLoss: 0.01, utilityImprovement: 0.01 } },
])("rejects invalid contract boundary %j", (patch) => {
	// Given / When / Then
	expect(() => createEvaluationContract({ ...spec(), ...patch })).toThrow(SkillEvaluationError);
});

test.each([false, true])("matches independent 60-digit Decimal oracle, missing=%s", (missing) => {
	// Given: 100 independent repetitions of masses 1:2:3:4; Decimal.ln/sqrt oracle, not production math.
	const rows = [[0.8, 0.3], [0.2, 0.7], [0.9, 0.4], [0.5, 0.5]];
	const pairs = Array.from({ length: 100 }, () => rows.map(([c = 0, b = 0], index) => ({
		mass: index + 1, candidate: missing && index === 2 ? range : { lower: c, upper: c }, baseline: { lower: b, upper: b },
	}))).flat();
	// When
	const result = weightedPairedBounds({ pairs, range, alpha: 0.01 });
	// Then
	expect(result.radius).toBeCloseTo(0.166225813626910992503909440749661340144017417317243198070276, 13);
	expect(result.lower).toBeCloseTo(missing ? -0.336225813626911 : -0.066225813626911, 13);
	expect(result.upper).toBeCloseTo(missing ? 0.296225813626911 : 0.266225813626911, 13);
	expect(result.effectiveUnits).toBeCloseTo(1000 / 3, 10);
});
test.each([
	[{ kind: "missing", reason: "pending" }, { lower: 0, upper: 1 }],
	[{ kind: "missing", reason: "unobserved" }, { lower: 0, upper: 1 }],
	[{ kind: "timeout" }, { lower: 0, upper: 0 }],
	[{ kind: "observed", value: 0.8 }, { lower: 0.8, upper: 0.8 }],
] satisfies readonly [EvaluationOutcome, { lower: number; upper: number }][])("handles bounded outcome %j", (input, expected) => {
	// Given / When / Then
	expect(outcomeInterval(input, range, 0)).toEqual(expected);
});
test.each([NaN, Infinity, -0.1, 1.1])("rejects out-of-range quality %s", (value) => {
	// Given / When / Then
	expect(() => outcomeInterval(observed(value), range, 0)).toThrow(SkillEvaluationError);
});
test.each([0, 1, NaN, Infinity, -0.1])("rejects invalid bound alpha %s", (alpha) => {
	// Given / When / Then
	expect(() => weightedPairedBounds({ pairs: [{ mass: 1, candidate: range, baseline: range }], range, alpha })).toThrow(SkillEvaluationError);
});
test("keeps all missing units in the denominator and returns the full difference range", () => {
	// Given / When
	const result = weightedPairedBounds({ pairs: Array.from({ length: 100 }, () => ({ mass: 1, candidate: range, baseline: range })), range, alpha: 0.01 });
	// Then
	expect(result).toMatchObject({ lower: -1, upper: 1, assignedUnits: 100, effectiveUnits: expect.closeTo(100, 10) });
});
test.each([[0.05, 5170], [0.02, 32308], [0.01, 129230]])("requires the independent oracle sample count for radius %s", (maxRadius, count) => {
	// Given / When / Then
	expect(requiredPairedSampleSize({ differenceWidth: 2, alpha: 1 / 640, maxRadius })).toBe(count);
});
test("uses the power requirement and reports unrepresentable sample counts", () => {
	// Given / When / Then
	expect(requiredPairedSampleSize({ differenceWidth: 2, alpha: 1 / 640, maxRadius: 0.05, power: { gap: 0.05, beta: 0.1 } })).toBe(13183);
	expect(requiredPairedSampleSize({ differenceWidth: 2, alpha: 0.01, maxRadius: Number.MIN_VALUE })).toBeNull();
});
test("detects infeasible weighted designs rather than counting rows as independent information", () => {
	// Given
	const f = fixture(spec(400, { units: spec().units.map((unit, i) => ({ ...unit, mass: i === 0 ? 1000000 : 1 })) }));
	// When / Then
	expect(evaluationFeasibility(f.contract).feasible).toBe(false);
	expect(decision(f)).toMatchObject({ status: "inconclusive", reason: "sample" });
});
test("spends exact alpha units permanently and retries an identical reservation idempotently", () => {
	// Given
	const f = fixture(); const next = createEvaluationContract(spec(400, { attemptId: "attempt-2" }));
	// When
	const ledger = reserveEvaluationAttempt(f.campaign, next);
	// Then
	expect(reserveEvaluationAttempt(ledger, next)).toEqual(ledger);
	expect(ledger.reservations).toHaveLength(2);
	expect(() => reserveEvaluationAttempt(ledger, createEvaluationContract(spec(400, { attemptId: "attempt-3" })))).toThrow(SkillEvaluationError);
	expect(() => reserveEvaluationAttempt(f.campaign, createEvaluationContract(spec(400, { anchorLoss: 0.03 })))).toThrow(SkillEvaluationError);
});
test.each([
	{ campaign: { ...campaign, maxAttempts: 0 } }, { campaign },
	{ campaign: { ...campaign, id: "other" } }, { campaign: { ...campaign, alpha: { units: 50, scale: 10000 } } },
])("fails closed without a valid matching campaign reservation %j", (patch) => {
	// Given / When / Then
	expect(decision({ ...fixture(), ...patch }).status).toBe("invalid");
});
test.each(["contractHash", "envelopeHash", "assignmentHash"])("rejects mismatched evidence %s", (key) => {
	// Given
	const f = fixture();
	// When / Then
	expect(decision({ ...f, evidence: { ...f.evidence, [key]: "b".repeat(64) } })).toMatchObject({ status: "invalid", code: "hash" });
});
test.each(["omit", "duplicate", "foreign", "nonfinite"] as const)("rejects malformed outcome ledger %s", (mode) => {
	// Given
	const f = fixture(); const rows = [...f.evidence.outcomes]; const first = rows[0];
	if (!first) throw new Error("fixture");
	switch (mode) {
		case "omit": rows.pop(); break;
		case "duplicate": rows[1] = first; break;
		case "foreign": rows[0] = { ...first, id: "foreign" }; break;
		case "nonfinite": rows[0] = { ...first, candidate: { quality: observed(NaN) } }; break;
	}
	// When / Then
	expect(decision({ ...f, evidence: { ...f.evidence, outcomes: rows } }).status).toBe("invalid");
});
test.each([-1, 0, 1])("uses strict threshold comparison at offset %s ULP-scale", (offset) => {
	// Given: dyadic weights sum exactly; the independently computed lower boundary is exact here.
	const radius = Math.sqrt(2 * Math.log(8) / 16);
	const contract = createEvaluationContract(spec(16, {
		alphaPerBound: { units: 1, scale: 8 }, qualityRadius: 1,
		hypothesis: { kind: "quality", improvement: 1 - radius + offset * Number.EPSILON },
	}));
	const rows = evidence(contract).outcomes.map((row) => ({ ...row, candidate: { quality: observed(1) }, baseline: { quality: observed(0) } }));
	// When
	const ledger = reserveEvaluationAttempt({ ...campaign, alpha: { units: 3, scale: 8 } }, contract);
	const result = decision({ contract, campaign: ledger, evidence: { ...evidence(contract), outcomes: rows } });
	// Then
	expect(result.status).toBe(offset < 0 ? "passed" : "inconclusive");
	if (result.status === "invalid") throw new Error("fixture");
	expect(result.gates.find((gate) => gate.endpoint === "quality")?.lower).toBe(1 - radius);
});
test.each([
	["passed", {}], ["rejected", { guardsPassed: false }], ["invalid", { integrity: "compromised" }],
] as const)("returns %s independently of package approval", (status, patch) => {
	// Given
	const f = fixture();
	// When / Then
	expect(decision({ ...f, evidence: { ...f.evidence, ...patch } }).status).toBe(status);
});
test("blocks an improving candidate when the fixed anchor establishes no noninferiority", () => {
	// Given
	const f = fixture(); const outcomes = f.evidence.outcomes.map((row) => ({ ...row, anchor: observed(1) }));
	// When
	const result = decision({ ...f, evidence: { ...f.evidence, outcomes } });
	// Then
	expect(result.status).toBe("inconclusive");
	if (result.status === "invalid") throw new Error("fixture");
	expect(result.gates.find((gate) => gate.endpoint === "quality")?.passed).toBe(true);
	expect(result.gates.find((gate) => gate.endpoint === "anchor")?.passed).toBe(false);
});
test.each([true, false])("requires explicit bounded efficiency outcomes, present=%s", (present) => {
	// Given
	const f = fixture(spec(400, { hypothesis: {
		kind: "efficiency", qualityLoss: 0.2, utilityImprovement: 0.01, utilityRadius: 0.5,
		cost: { unit: "USD", bounds: { lower: 0, upper: 10 } }, latency: { unit: "ms", bounds: { lower: 0, upper: 1000 } },
		costWeight: 1, latencyWeight: 0.2,
	} }));
	const outcomes = f.evidence.outcomes.map((row) => ({
		...row, baseline: { quality: observed(0.8), ...(present ? { cost: observed(10), latency: observed(1000) } : {}) },
		candidate: { quality: observed(0.8), ...(present ? { cost: observed(0), latency: observed(0) } : {}) },
	}));
	// When / Then
	expect(decision({ ...f, evidence: { ...f.evidence, outcomes } }).status).toBe(present ? "passed" : "invalid");
});

test.each([
	{ pairs: [] }, { pairs: [{ mass: 0, candidate: range, baseline: range }] },
	{ pairs: [{ mass: Infinity, candidate: range, baseline: range }] },
	{ pairs: [{ mass: 1, candidate: { lower: 1, upper: 0 }, baseline: range }] },
	{ range: { lower: 1, upper: 0 } }, { range: { lower: -Number.MAX_VALUE, upper: Number.MAX_VALUE } },
])("rejects invalid weighted interval domain %j", (patch) => {
	// Given / When / Then
	expect(() => weightedPairedBounds({ pairs: [{ mass: 1, candidate: range, baseline: range }], range, alpha: 0.01, ...patch })).toThrow(SkillEvaluationError);
});
test("detects reservation charge tampering, duplicate spending and attempt caps", () => {
	// Given
	const f = fixture(); const first = f.campaign.reservations[0];
	if (!first) throw new Error("fixture");
	// When / Then
	for (const ledger of [
		{ ...f.campaign, reservations: [first, first] },
		{ ...f.campaign, reservations: [{ ...first, alphaUnits: 1 }] },
		{ ...f.campaign, reservations: [{ ...first, boundCount: 1 }] },
		{ ...f.campaign, reservations: [{ ...first, alphaUnits: Number.MAX_SAFE_INTEGER }] },
	]) expect(decision({ ...f, campaign: ledger }).status).toBe("invalid");
	expect(() => reserveEvaluationAttempt({ ...f.campaign, maxAttempts: 1 }, createEvaluationContract(spec(400, { attemptId: "attempt-2" })))).toThrow(SkillEvaluationError);
});
test("returns a deterministic immutable decision bound to actual submitted outcome data", () => {
	// Given
	const f = fixture();
	// When
	const result = decision(f);
	// Then
	expect(result).toEqual(decision(f));
	expect(Object.isFrozen(result)).toBe(true);
	if (result.status === "invalid") throw new Error("fixture");
	expect(result.evidenceHash).toBe(skillEvaluationHash(f.evidence));
	expect(Object.isFrozen(result.gates)).toBe(true);
});

/** Test-only independent binomial-CDF inversion: two-sided 95% Clopper-Pearson interval. */
function binomialInterval(successes: number, trials: number): { lower: number; upper: number } {
	function upper(k: number): number {
		if (k === trials) return 1;
		let low = 0; let high = 1;
		for (let step = 0; step < 60; step++) {
			const p = (low + high) / 2;
			let logTerm = trials * Math.log1p(-p); let cdf = Math.exp(logTerm);
			for (let j = 0; j < k; j++) {
				logTerm += Math.log(trials - j) - Math.log(j + 1) + Math.log(p) - Math.log1p(-p);
				cdf += Math.exp(logTerm);
			}
			if (cdf > 0.025) low = p; else high = p;
		}
		return high;
	}
	return { lower: successes === 0 ? 0 : 1 - upper(trials - successes), upper: upper(successes) };
}
test("matches the analytic zero-event confidence limit without claiming zero risk", () => {
	// Given / When
	const interval = binomialInterval(0, 500);
	// Then
	expect(interval.lower).toBe(0);
	expect(interval.upper).toBeCloseTo(1 - 0.025 ** (1 / 500), 13);
	expect(interval.upper).toBeGreaterThan(0);
});
test.each([
	{ name: "null", candidate: 0.5, baseline: 0.5, selectiveMissing: false },
	{ name: "positive", candidate: 0.8, baseline: 0.2, selectiveMissing: false },
	{ name: "negative", candidate: 0.2, baseline: 0.8, selectiveMissing: false },
	{ name: "null-selective-missing", candidate: 0.5, baseline: 0.5, selectiveMissing: true },
])("reports seeded decision simulation with binomial uncertainty: $name", (scenario) => {
	// Given: synthetic independent Bernoulli units; this is not execution evidence or a proof of calibration.
	const seed = 0x531a2026; let state = seed;
	const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
	const f = fixture(spec(64, { qualityRadius: 0.5 })); const trials = 500; let promotions = 0;
	// When
	for (let trial = 0; trial < trials; trial++) {
		const outcomes = f.evidence.outcomes.map((row) => {
			const c = Number(random() < scenario.candidate);
			const candidate: EvaluationOutcome = scenario.selectiveMissing && c === 0 ? { kind: "missing", reason: "unobserved" } : observed(c);
			return { ...row, candidate: { quality: candidate }, baseline: { quality: observed(Number(random() < scenario.baseline)) }, anchor: observed(Number(random() < scenario.baseline)) };
		});
		const result = decision({ ...f, evidence: { ...f.evidence, outcomes } });
		expect(result.status).not.toBe("invalid");
		if (result.status === "passed") promotions++;
	}
	const ci = binomialInterval(promotions, trials);
	// Then: report counts and interval, not a zero-error guarantee; fixed seeds prevent timing/random flakes.
	console.log(JSON.stringify({ kind: "skill-evaluation-simulation", scenario: scenario.name, seed, trials, promotions, confidence: 0.95, method: "Clopper-Pearson", ci }));
	if (scenario.candidate > scenario.baseline) expect(ci.lower).toBeGreaterThan(0.9);
	else expect(ci.upper).toBeLessThan(0.05);
}, 30000);
