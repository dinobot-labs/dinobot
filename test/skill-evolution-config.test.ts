import { expect, test } from "bun:test";
import { Value } from "typebox/value";
import { REVIEW_BUDGET_DEFAULTS, REVIEW_DEFAULTS, SkillEvolutionShape, skillEvolutionConfig } from "../src/core/skills/evolution-config.ts";

test("default configuration enables background review with finite budgets but no statistical path or deletion", () => {
	// Given no deployment configuration, when defaults are resolved.
	const { config, problems } = skillEvolutionConfig();
	// Then review is on with its defaults and finite default budgets; the statistical path stays off.
	expect(problems).toEqual([]);
	expect(config.sessionPinning).toBe(true);
	expect(config.author).toBe(true);
	expect([config.observe, config.evaluate, config.autoPublish, config.deactivate, config.physicalGc]).toEqual([false, false, false, false, false]);
	expect(config.review).toEqual({ ...REVIEW_DEFAULTS });
	expect(config.budgets).toEqual({ ...REVIEW_BUDGET_DEFAULTS });
	expect(config.budgets!.jobMicroUsd).toBeLessThanOrEqual(config.budgets!.dailyMicroUsd);
});

test("background review default is opted out explicitly or by configuring the statistical path", () => {
	// Given each opt-out form, when defaults are resolved.
	for (const raw of [{ review: false as const }, { author: false }, { sessionPinning: false }]) {
		const { config, problems } = skillEvolutionConfig(raw);
		// Then no research is enabled and no budget is invented.
		expect(problems).toEqual([]);
		expect(config.review).toBeNull();
		expect(config.author).toBe(false);
		expect(config.budgets).toBeUndefined();
	}
	// Given an operator configuring the statistical path, then review is not added implicitly.
	const budgets = { maxPending: 1, maxCalls: 1, maxOutputTokens: 100, timeoutMs: 100, dailyMicroUsd: 10, jobMicroUsd: 5 };
	const statistical = skillEvolutionConfig({ observe: true, author: true, budgets });
	expect(statistical.problems).toEqual([]);
	expect(statistical.config.review).toBeNull();
	expect(statistical.config.budgets).toEqual(budgets);
	// Given review named explicitly, then author and budgets default too, and configured values win.
	const named = skillEvolutionConfig({ review: { intervalMs: 60_000 } });
	expect(named.problems).toEqual([]);
	expect(named.config.review?.intervalMs).toBe(60_000);
	expect(named.config.author).toBe(true);
	expect(skillEvolutionConfig({ review: {}, author: false }).problems).toContain("review requires author");
	expect(Value.Check(SkillEvolutionShape, { review: false })).toBe(true);
	expect(Value.Check(SkillEvolutionShape, { review: true })).toBe(false);
});

test("activation without prerequisite evidence and budgets is rejected", () => {
	// Given an operator enables publication alone.
	const input = { sessionPinning: false, author: true, evaluate: true, autoPublish: true };
	// When prerequisites are checked.
	const result = skillEvolutionConfig(input);
	// Then it is not an admissible automatic configuration.
	expect(result.problems).toHaveLength(4);
});

test("configuration parser rejects unbounded and unknown budget settings", () => {
	// Given values crossing the external configuration boundary.
	const invalid = [
		{ authorConcurrency: 10 },
		{ budgets: {} },
		{ budgets: { maxPending: 33, maxCalls: 1, maxOutputTokens: 100, timeoutMs: 100, dailyMicroUsd: 1, jobMicroUsd: 1 } },
		{ confirmation: { contractId: "contract", anchorManifest: "latest", environmentRevision: "r1", sloEvidenceId: "slo" } },
	];
	// When the schema parses them, then none qualifies.
	for (const value of invalid) expect(Value.Check(SkillEvolutionShape, value)).toBe(false);
});
