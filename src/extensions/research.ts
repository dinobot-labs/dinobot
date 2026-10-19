import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { ResearchService, ResearchStartArgs } from "../core/research-service.ts";
import type { Mission } from "../core/research.ts";
export const RESEARCH_TOOL_NAMES = new Set(["research_start", "research_status", "research_cancel"]);
const str = (maxLength = 4096) => Type.String({ minLength: 1, maxLength });
const list = (maxItems = 64) => Type.Array(str(), { maxItems });
const object = <T extends Parameters<typeof Type.Object>[0]>(properties: T) => Type.Object(properties, { additionalProperties: false });
const command = object({
	executable: str(),
	argv: list(),
	cwdPolicy: Type.Literal("candidate"),
	environmentAllowlist: list(),
	timeoutMs: Type.Integer({ minimum: 1, maximum: 86_400_000 }),
	resultSchema: Type.Union([Type.Literal("research-numeric-v1"), Type.Literal("research-numeric-v2")]),
	readiness: Type.Optional(object({
		preflight: object({ argv: list(), checkIds: list(32) }),
		canary: object({ argv: list(), checkIds: list(32) }),
	})),
	baseCommit: str(128),
	permittedPaths: list(32),
});
const commonPolicy = {
	maxNoProgressRounds: Type.Integer({ minimum: 1, maximum: 16 }),
	maxDebugChildren: Type.Integer({ minimum: 0, maximum: 2 }),
	confirmation: Type.Union([Type.Literal("required-once"), Type.Literal("none")]),
};
const policy = Type.Union([
	object({ ...commonPolicy, kind: Type.Literal("qualitative") }),
	object({
		...commonPolicy,
		kind: Type.Literal("numeric"),
		numeric: object({
			metric: str(128),
			unit: str(128),
			direction: Type.Union([Type.Literal("min"), Type.Literal("max")]),
			repetitions: Type.Integer({ minimum: 1, maximum: 10 }),
			aggregation: Type.Literal("mean"),
			minimumEffect: Type.Number({ minimum: 0 }),
			goalThreshold: Type.Number(),
		}),
	}),
]);
export const researchStartSchema = object({
	supersedes: Type.Optional(str(128)),
	contract: object({
		question: str(),
		hypotheses: list(),
		requirements: Type.Array(object({ id: str(128), mandatory: Type.Boolean() }), { minItems: 1, maxItems: 32 }),
		scope: str(),
		exclusions: list(),
		mode: Type.Union([Type.Literal("evidence"), Type.Literal("trusted-local-code")]),
		baseline: object({ definition: str(), artifactHash: Type.Optional(str(256)) }),
		evaluator: Type.Optional(
			object({ profile: str(256), revision: str(256), environmentFingerprint: str(256), inputFingerprint: str(256) }),
		),
		policy,
		reportAuthorityRef: str(),
		codeAuthorityRef: Type.Optional(str()),
		command: Type.Optional(command),
		repair: Type.Optional(object({ baseline: Type.Boolean(), candidate: Type.Boolean(), maxPerFailure: Type.Integer({ minimum: 1, maximum: 2 }) })),
		negativeConclusion: Type.Optional(Type.Literal("all-fail-rejected-any-fail-mixed")),
	}),
	budget: Type.Optional(object({
		maxRounds: Type.Optional(Type.Integer({ minimum: 1, maximum: 16 })),
		maxAttempts: Type.Optional(Type.Integer({ minimum: 3, maximum: 128 })),
		maxCandidates: Type.Optional(Type.Integer({ minimum: 2, maximum: 32 })),
		maxConcurrent: Type.Optional(Type.Integer({ minimum: 1, maximum: 4 })),
		deadlineMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 86_400_000 })),
		attemptTimeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 86_400_000 })),
		maxArtifactBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 16_777_216 })),
	})),
});
const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
/** Explicit bounded projection; full receipts remain durable and in authorized reports. */
export function researchToolView(result: { mission: Mission | undefined; budget?: unknown }, cursor = 0) {
	if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > 128) throw new Error("Invalid research status cursor");
	const m = result.mission;
	if (!m) return { mission: null };
	const end = cursor + 2;
	return {
		projection: "bounded-summary",
		rawEvidenceOmitted: true,
		cursor,
		nextCursor: end < Math.max(m.candidates.length, m.attempts.length, m.evaluations.length) ? end : null,
		totals: { candidates: m.candidates.length, attempts: m.attempts.length, evaluations: m.evaluations.length },
		mission: {
			id: m.id,
			question: m.contract.question,
			status: m.status,
			judgment: m.judgment,
			stopReason: m.stopReason,
			supersedes: m.supersedes,
			mode: m.contract.mode,
			contractHash: m.contractHash,
			limits: m.limits,
			deadlineAt: m.deadlineAt,
			incumbentId: m.incumbentId,
			selectedId: m.selectedId,
			originalBaselineId: m.candidates[0]?.id,
			basisId: m.basisId,
			numericSemantics: m.contract.command?.resultSchema ?? "qualitative",
			cancellationEpoch: m.cancellationEpoch,
			report: m.report,
			policy: m.contract.policy,
			evaluator: m.contract.evaluator,
			codeAuthorityRef: m.contract.codeAuthorityRef,
			reportAuthorityRef: m.contract.reportAuthorityRef,
			requirements: m.contract.requirements,
			budget: result.budget,
			candidates: m.candidates.slice(cursor, end).map((c) => ({ ...c, summary: c.summary.slice(0, 512) })),
			attempts: m.attempts.slice(cursor, end).map(({ context, ...a }) => ({ ...a, contextHash: context?.hash, error: a.error?.slice(0, 512) })),
			evaluations: m.evaluations.slice(cursor, end).map((e) => ({
				id: e.id,
				candidateId: e.candidateId,
				attemptId: e.attemptId,
				validity: e.validity,
				verdict: e.verdict,
				aggregate: e.aggregate,
				samples: e.samples,
				variance: e.variance,
				guardrails: e.guardrails,
				feedback: e.feedback.slice(0, 1000),
				receiptHash: e.receiptHash,
				artifactHash: e.artifactHash,
				requirements: e.requirements.map((r) => ({
					id: r.id,
					verdict: r.verdict,
					evidenceIds: r.evidenceIds.slice(0, 4).map((id) => id.slice(0, 128)),
				})),
				evidenceCount: e.evidence.length,
				evidence: e.evidence.slice(0, 4).map((s) => ({
					id: s.id.slice(0, 128),
					access: s.access,
					sourceLocator: s.sourceLocator.slice(0, 512),
					contentHash: s.contentHash,
					observation: s.observation.slice(0, 512),
					limitations: s.limitations.slice(0, 2).map((l) => l.slice(0, 256)),
				})),
			})),
		},
	};
}
export function researchExtension(service: ResearchService) {
	return defineExtension({
		name: "research",
		tasks: [service.task],
		tools: [
			defineTool({
				name: "research_start",
				description:
					"Start one durable finite research mission. Evidence mode uses independent qualitative review, not score certification. Host derives hashes and evaluator identity. Code mode requires codeAuthorityRef host:<configured-profile>; arbitrary model commands grant no authority. reportAuthorityRef none means chat/status only and no project writes. Other report modes explicitly authorize bound-project reports. Policy and budget freeze at start; supersedes links a settled same-conversation predecessor without extending it.",
				parameters: researchStartSchema,
				replay: "safe",
				executionMode: "sequential",
				execute: async (args, api, context) => text(researchToolView(await service.start(args as ResearchStartArgs, api, context))),
			}),
			defineTool({
				name: "research_status",
				description:
					"Read a bounded two-record page of mission lineage/attempts/evaluations. Pass nextCursor to continue. Raw observations and strings are explicitly summarized; full receipts remain durable and in authorized reports. Does not dispatch or repair reports.",
				parameters: object({ missionId: Type.Optional(str(128)), cursor: Type.Optional(Type.Integer({ minimum: 0, maximum: 128 })) }),
				replay: "safe",
				execute: async ({ missionId, cursor }, api, context) =>
					text(researchToolView(await service.status(api.conversationId, context, missionId), cursor)),
			}),
			defineTool({
				name: "research_cancel",
				description:
					"Fence the mission, request owned cancellation, and report unsettled/unknown effects honestly. Does not refund attempts.",
				parameters: object({ missionId: str(128), reason: Type.Optional(str()) }),
				replay: "safe",
				executionMode: "sequential",
				execute: async ({ missionId, reason }, api, context) =>
					text(researchToolView(await service.cancel(api.conversationId, missionId, reason ?? "user_cancelled", context))),
			}),
		],
	});
}
