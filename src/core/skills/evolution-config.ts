import { Type } from "@earendil-works/pi-ai";
import type { Static } from "typebox";

export const SkillEvolutionShape = Type.Object({
	sessionPinning: Type.Optional(Type.Boolean()),
	observe: Type.Optional(Type.Boolean()),
	author: Type.Optional(Type.Boolean()),
	evaluate: Type.Optional(Type.Boolean()),
	autoPublish: Type.Optional(Type.Boolean()),
	deactivate: Type.Optional(Type.Boolean()),
	physicalGc: Type.Optional(Type.Boolean()),
	budgets: Type.Optional(Type.Object({
		maxPending: Type.Integer({ minimum: 1, maximum: 32 }),
		maxCalls: Type.Integer({ minimum: 1, maximum: 8 }),
		maxOutputTokens: Type.Integer({ minimum: 1, maximum: 32768 }),
		timeoutMs: Type.Integer({ minimum: 1, maximum: 300000 }),
		dailyMicroUsd: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
		jobMicroUsd: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
	}, { additionalProperties: false })),
	/** Background review (ADR 0038 section 6): reversible unverified publication of authored candidates. */
	/** On by default (false opts out); see skillEvolutionConfig for when the default applies. */
	review: Type.Optional(Type.Union([Type.Literal(false), Type.Object({
		publish: Type.Optional(Type.Boolean()),
		intervalMs: Type.Optional(Type.Integer({ minimum: 60_000, maximum: 2_147_483_647 })),
		minConversations: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
		maxConversations: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
		maxPublishesPerDay: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
	}, { additionalProperties: false })])),
	confirmation: Type.Optional(Type.Object({
		contractId: Type.String({ minLength: 1 }),
		anchorManifest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
		environmentRevision: Type.String({ minLength: 1 }),
		sloEvidenceId: Type.String({ minLength: 1 }),
	}, { additionalProperties: false })),
}, { additionalProperties: false });

export type SkillEvolutionConfig = Static<typeof SkillEvolutionShape>;
export type SkillReviewConfig = {
	readonly publish: boolean;
	readonly intervalMs: number;
	readonly minConversations: number;
	readonly maxConversations: number;
	readonly maxPublishesPerDay: number;
};
export const REVIEW_DEFAULTS: SkillReviewConfig = Object.freeze({
	publish: true, intervalMs: 21_600_000, minConversations: 5, maxConversations: 20, maxPublishesPerDay: 3,
});
/** Finite budgets used when background review is on and no budgets are configured ($2 per 24 h window). */
export const REVIEW_BUDGET_DEFAULTS = Object.freeze({
	maxPending: 2, maxCalls: 4, maxOutputTokens: 8000, timeoutMs: 120_000, dailyMicroUsd: 2_000_000, jobMicroUsd: 400_000,
});
/** Fixed (grid-aligned) budget window of review mode: dailyMicroUsd is replenished per window; any 24 h span may account up to 2x. */
export const REVIEW_BUDGET_WINDOW_MS = 86_400_000;

function reviewConfig(raw: Exclude<SkillEvolutionConfig["review"], false>, problems: string[]): SkillReviewConfig | null {
	if (!raw) return null;
	const config = { ...REVIEW_DEFAULTS, ...Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== undefined)) } as SkillReviewConfig;
	if (typeof config.publish !== "boolean") problems.push("review.publish must be a boolean");
	if (!Number.isSafeInteger(config.intervalMs) || config.intervalMs < 60_000 || config.intervalMs > 2_147_483_647) problems.push("review.intervalMs must be an integer in [60000, 2147483647]");
	if (!Number.isSafeInteger(config.minConversations) || config.minConversations < 1 || config.minConversations > 1000) problems.push("review.minConversations must be an integer in [1, 1000]");
	if (!Number.isSafeInteger(config.maxConversations) || config.maxConversations < 1 || config.maxConversations > 200) problems.push("review.maxConversations must be an integer in [1, 200]");
	if (!Number.isSafeInteger(config.maxPublishesPerDay) || config.maxPublishesPerDay < 0 || config.maxPublishesPerDay > 100) problems.push("review.maxPublishesPerDay must be an integer in [0, 100]");
	if (config.maxConversations < config.minConversations) problems.push("review.maxConversations must be >= review.minConversations");
	return config;
}

/** Parsed configuration only. Referenced evidence must also be verified at admission. */
export function skillEvolutionConfig(raw: SkillEvolutionConfig = {}) {
	// Background review is on by default (ADR 0038 amendment). The default does not apply when the
	// deployment opts out (review: false, author: false, sessionPinning: false) or configures the
	// statistical research path (observe/evaluate/autoPublish) without naming review.
	const reviewByDefault = raw.review === undefined && raw.author !== false && raw.sessionPinning !== false
		&& !raw.observe && !raw.evaluate && !raw.autoPublish;
	const reviewRaw = raw.review === false ? undefined : raw.review ?? (reviewByDefault ? {} : undefined);
	const config = {
		sessionPinning: raw.sessionPinning ?? true,
		observe: raw.observe ?? false,
		author: raw.author ?? reviewRaw !== undefined,
		evaluate: raw.evaluate ?? false,
		autoPublish: raw.autoPublish ?? false,
		deactivate: raw.deactivate ?? false,
		physicalGc: raw.physicalGc ?? false,
		budgets: raw.budgets ?? (reviewRaw !== undefined ? { ...REVIEW_BUDGET_DEFAULTS } : undefined),
		confirmation: raw.confirmation,
		review: null as SkillReviewConfig | null,
	};
	const problems: string[] = [];
	config.review = reviewConfig(reviewRaw, problems);
	// Background review authors from host-frozen conversation snapshots, not from the observation store.
	if (config.author && !config.observe && !config.review) problems.push("author requires observe");
	if (config.review && !config.author) problems.push("review requires author");
	if (config.review && !config.budgets) problems.push("review requires finite budgets");
	if (config.evaluate && !config.author) problems.push("evaluate requires author");
	if (config.autoPublish && !config.evaluate) problems.push("autoPublish requires evaluate");
	if (config.deactivate && !config.autoPublish) problems.push("deactivate requires autoPublish");
	if (config.physicalGc && !config.deactivate) problems.push("physicalGc requires deactivate");
	if ((config.author || config.evaluate) && !config.budgets) problems.push("research requires finite budgets");
	if ((config.author || config.evaluate || config.autoPublish) && !config.sessionPinning) problems.push("research requires sessionPinning");
	if ((config.evaluate || config.autoPublish) && !config.confirmation) problems.push("confirmation requires contract, anchor, environment and SLO evidence");
	if (config.budgets && config.budgets.jobMicroUsd > config.budgets.dailyMicroUsd) problems.push("job budget exceeds daily budget");
	return { config, problems };
}
