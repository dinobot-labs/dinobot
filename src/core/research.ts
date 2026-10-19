import { createHash } from "node:crypto";
import { isAbsolute, normalize } from "node:path";
import { defineDoc } from "@earendil-works/pi-durable";

/** Pure, single-writer domain transitions. Call within the host's document transaction.
 * Authority/provenance, realpath and execution receipts are verified by the host, not by a model.
 * Same-user trusted code is not a sandbox. There is deliberately no scheduler here.
 */
export type MissionStatus = "running" | "cancelling" | "concluded" | "inconclusive" | "blocked" | "cancelled";
export type Judgment = "supported" | "rejected" | "mixed" | "undetermined";
export type Limits = {
	maxRounds: number;
	maxAttempts: number;
	maxCandidates: number;
	maxConcurrent: number;
	deadlineMs: number;
	attemptTimeoutMs: number;
	maxArtifactBytes: number;
};
export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({
	maxRounds: 4,
	maxAttempts: 16,
	maxCandidates: 8,
	maxConcurrent: 2,
	deadlineMs: 1_800_000,
	attemptTimeoutMs: 120_000,
	maxArtifactBytes: 16_777_216,
});
export type SelectionPolicy =
	& { maxNoProgressRounds: number; maxDebugChildren: number; confirmation: "required-once" | "none" }
	& ({ kind: "qualitative"; numeric?: never } | {
		kind: "numeric";
		numeric: {
			metric: string;
			unit: string;
			direction: "min" | "max";
			repetitions: number;
			aggregation: "mean";
			minimumEffect: number;
			goalThreshold: number;
		};
	});
export type CommandSpec = {
	executable: string;
	argv: string[];
	cwdPolicy: "candidate";
	environmentAllowlist: string[];
	timeoutMs: number;
	resultSchema: "research-numeric-v1" | "research-numeric-v2";
	readiness?: { preflight: { argv: string[]; checkIds: string[] }; canary: { argv: string[]; checkIds: string[] } };
	baseCommit: string;
	permittedPaths: string[];
};
export type Contract = {
	question: string;
	hypotheses: string[];
	requirements: { id: string; mandatory: boolean }[];
	scope: string;
	exclusions: string[];
	mode: "evidence" | "trusted-local-code";
	baseline: { definition: string; artifactHash: string };
	evaluator: { profile: string; revision: string; environmentFingerprint: string; inputFingerprint: string };
	policy: SelectionPolicy;
	reportAuthorityRef: string;
	codeAuthorityRef?: string;
	command?: CommandSpec;
	repair?: { baseline: boolean; candidate: boolean; maxPerFailure: number };
	/** Optional explicit semantics for confirmed qualitative negatives; absent means inconclusive. */
	negativeConclusion?: "all-fail-rejected-any-fail-mixed";
};
export type Evidence = {
	id: string;
	claimIds: string[];
	sourceLocator: string;
	location: string;
	version: string;
	sourceFamily: string;
	observation: string;
	inference: string;
	assumptions: string[];
	counterevidence: string[];
	access: "observed" | "unavailable" | "unknown";
	limitations: string[];
	contentHash?: string;
	sourceDate?: string;
	observationDate?: string;
};
export type Candidate = {
	id: string;
	missionId: string;
	parentId?: string;
	operation: "baseline" | "draft" | "debug" | "improve";
	summary: string;
	feedbackReceiptIds: string[];
	artifactHash?: string;
	state: "proposed" | "ready" | "evaluated" | "invalid" | "unknown";
	evaluationIds: string[];
	dagRefs: { runId: string; nodeId: string }[];
};
export type AttemptBinding = { runId: string; nodeId: string; key: string; runnerId: string };
export type Attempt = {
	id: string;
	missionId: string;
	candidateId: string;
	role: "propose" | "evaluate" | "confirm";
	ordinal: number;
	roundId?: string;
	reservationKey: string;
	reservationHash: string;
	cancellationEpoch: number;
	contractHash: string;
	state: "reserved" | "running" | "succeeded" | "failed" | "cancelled" | "unknown";
	binding?: AttemptBinding;
	createdAt: number;
	deadlineAt: number;
	endedAt?: number;
	error?: string;
	resultHash?: string;
	evaluationId?: string;
	artifactBytes: number;
	failureKey?: string;
	context?: { prompt: string; instructions: string; hash: string };
};
export type Evaluation = {
	id: string;
	missionId: string;
	candidateId: string;
	attemptId: string;
	binding: AttemptBinding;
	artifactHash: string;
	contractHash: string;
	evaluatorRevision: string;
	environmentFingerprint: string;
	inputFingerprint: string;
	execution: "completed" | "failed" | "cancelled" | "unknown";
	validity: "valid" | "invalid" | "unknown";
	verdict: "pass" | "fail" | "inconclusive";
	requirements: { id: string; verdict: "pass" | "fail" | "unknown"; evidenceIds: string[] }[];
	evidence: Evidence[];
	samples?: number[];
	metric?: string;
	unit?: string;
	aggregate?: number;
	variance?: number;
	guardrails: boolean;
	comparison?: "better" | "same" | "worse" | "incomparable";
	feedback: string;
	receiptHash: string;
	failure?: { stage: "preflight" | "canary" | "evaluation"; checkIds: string[]; code: "failed" };
	acceptedAt?: number;
};
export type PolicyState = {
	phase: "baseline" | "propose" | "evaluate" | "confirm" | "terminal";
	roundIndex: number;
	noProgressRounds: number;
	incumbentId?: string;
	pendingCandidateId?: string;
	debugChildrenByParent: Record<string, number>;
	confirmationState: "reserved" | "unused" | "running" | "passed" | "failed" | "unknown";
};
export type Mission = {
	id: string;
	version: 1;
	ownerConversationId: string;
	revision: number;
	createdAt: number;
	updatedAt: number;
	deadlineAt: number;
	status: MissionStatus;
	judgment: Judgment;
	stopReason?: string;
	projectRoot: string;
	contract: Contract;
	contractHash: string;
	limits: Limits;
	frozenHash: string;
	ledger: {
		roundsAdmitted: number;
		attemptsAdmitted: number;
		candidatesAdmitted: number;
		activeAttemptIds: string[];
		confirmationReserveRemaining: 0 | 1;
		retainedArtifactBytes: number;
	};
	policy: PolicyState;
	cancellationEpoch: number;
	controllerTaskId: string;
	activeRunIds: string[];
	candidates: Candidate[];
	attempts: Attempt[];
	evaluations: Evaluation[];
	incumbentId?: string;
	selectedId?: string;
	/** First eligible basis; original baseline candidate remains immutable. */
	basisId?: string;
	supersedes?: string;
	report: { state: "pending" | "current" | "failed"; desiredRevision: number; writtenRevision: number; error?: string; path?: string };
};
export type ResearchState = { missions: Mission[]; activeId?: string };
export const MAX_MISSIONS = 32;
export const ResearchDoc = defineDoc<ResearchState>({
	kind: "dinobot.research",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ missions: [] }),
});

function assert(value: unknown, message: string): asserts value {
	if (!value) throw new Error(`Research: ${message}`);
}
function text(value: unknown, name: string, max = 4096): asserts value is string {
	assert(typeof value === "string" && value.trim().length > 0 && value.length <= max, `invalid ${name}`);
}
function integer(value: number, min: number, max: number, name: string): void {
	assert(Number.isSafeInteger(value) && value >= min && value <= max, `invalid ${name}`);
}
function time(now: number): void {
	integer(now, 0, Number.MAX_SAFE_INTEGER, "time");
}
function strings(values: string[], name: string, max = 64): void {
	assert(Array.isArray(values) && values.length <= max, `invalid ${name}`);
	values.forEach((v) => text(v, name));
}
function keys(value: object, allowed: string[]): void {
	assert(
		value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((k) => allowed.includes(k)),
		"unknown schema field",
	);
}
function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") {
		assert(value !== undefined && (typeof value !== "number" || Number.isFinite(value)), "non-JSON value");
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	return `{${
		Object.keys(value).filter((k) => (value as Record<string, unknown>)[k] !== undefined).sort().map((k) =>
			`${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`
		).join(",")
	}}`;
}
export function researchHash(value: unknown): string {
	return createHash("sha256").update(canonical(value)).digest("hex");
}
export function resolveLimits(input: Partial<Limits> = {}): Limits {
	assert(Object.keys(input).every((k) => Object.hasOwn(DEFAULT_LIMITS, k)), "unknown limit");
	const l = { ...DEFAULT_LIMITS, ...input };
	for (
		const [k, max] of Object.entries({
			maxRounds: 16,
			maxAttempts: 128,
			maxCandidates: 32,
			maxConcurrent: 4,
			deadlineMs: 86_400_000,
			attemptTimeoutMs: 86_400_000,
			maxArtifactBytes: 16_777_216,
		})
	) integer(l[k as keyof Limits], 1, max, k);
	assert(l.maxConcurrent <= l.maxAttempts && l.attemptTimeoutMs <= l.deadlineMs, "inconsistent limits");
	return l;
}
export function validateContract(c: Contract, l: Limits): void {
	keys(c, [
		"question",
		"hypotheses",
		"requirements",
		"scope",
		"exclusions",
		"mode",
		"baseline",
		"evaluator",
		"policy",
		"reportAuthorityRef",
		"codeAuthorityRef",
		"command",
		"negativeConclusion",
		"repair",
	]);
	if (c.repair) {
		keys(c.repair, ["baseline", "candidate", "maxPerFailure"]);
		assert(c.mode === "trusted-local-code" && c.command?.resultSchema === "research-numeric-v2", "repair requires numeric-v2 code authority");
		assert(typeof c.repair.baseline === "boolean" && typeof c.repair.candidate === "boolean", "repair permissions");
		integer(c.repair.maxPerFailure, 1, 2, "per-failure repair limit");
	}
	keys(c.baseline, ["definition", "artifactHash"]);
	keys(c.evaluator, ["profile", "revision", "environmentFingerprint", "inputFingerprint"]);
	keys(c.policy, ["kind", "maxNoProgressRounds", "maxDebugChildren", "confirmation", "numeric"]);
	text(c.question, "question");
	strings(c.hypotheses, "hypotheses");
	text(c.scope, "scope");
	strings(c.exclusions, "exclusions");
	assert(Array.isArray(c.requirements) && c.requirements.length > 0 && c.requirements.length <= 32, "requirements required");
	c.requirements.forEach((r) => {
		keys(r, ["id", "mandatory"]);
		text(r.id, "requirement id", 128);
		assert(typeof r.mandatory === "boolean", "mandatory flag");
	});
	assert(
		new Set(c.requirements.map((r) => r.id)).size === c.requirements.length && c.requirements.some((r) => r.mandatory),
		"unique mandatory requirements required",
	);
	text(c.baseline.definition, "baseline");
	text(c.baseline.artifactHash, "baseline hash", 256);
	text(c.reportAuthorityRef, "report authority");
	for (const value of [c.evaluator.profile, c.evaluator.revision, c.evaluator.environmentFingerprint, c.evaluator.inputFingerprint]) {
		text(value, "evaluator binding", 256);
	}
	const p = c.policy;
	integer(p.maxNoProgressRounds, 1, l.maxRounds, "no-progress limit");
	integer(p.maxDebugChildren, 0, 2, "debug limit");
	assert(p.confirmation === "none" || p.confirmation === "required-once", "confirmation policy");
	assert(l.maxCandidates >= 2 && l.maxAttempts >= (p.confirmation === "required-once" ? 4 : 3), "baseline and one round must fit");
	if (p.kind === "numeric") {
		const n = p.numeric;
		keys(n, ["metric", "unit", "direction", "repetitions", "aggregation", "minimumEffect", "goalThreshold"]);
		text(n.metric, "metric", 128);
		text(n.unit, "unit", 128);
		integer(n.repetitions, 1, 10, "repetitions");
		assert(
			n.aggregation === "mean" && ["min", "max"].includes(n.direction) && Number.isFinite(n.minimumEffect) && n.minimumEffect >= 0 &&
				Number.isFinite(n.goalThreshold),
			"numeric policy",
		);
	} else assert(p.kind === "qualitative" && p.numeric === undefined, "qualitative policy");
	assert(c.negativeConclusion === undefined || c.negativeConclusion === "all-fail-rejected-any-fail-mixed", "negative semantics");
	if (c.mode === "trusted-local-code") {
		keys(c.command!, [
			"executable",
			"argv",
			"cwdPolicy",
			"environmentAllowlist",
			"timeoutMs",
			"resultSchema",
			"baseCommit",
			"permittedPaths",
			"readiness",
		]);
		text(c.codeAuthorityRef, "code authority");
		const s = c.command;
		assert(s, "command authority required");
		text(s.executable, "executable");
		strings(s.argv, "argv");
		strings(s.environmentAllowlist, "environment");
		strings(s.permittedPaths, "permitted paths");
		text(s.baseCommit, "base commit", 128);
		integer(s.timeoutMs, 1, l.attemptTimeoutMs, "command timeout");
		assert(s.cwdPolicy === "candidate" && ["research-numeric-v1", "research-numeric-v2"].includes(s.resultSchema) && p.kind === "numeric", "command protocol");
		if (s.readiness) {
			keys(s.readiness, ["preflight", "canary"]);
			for (const stage of [s.readiness.preflight, s.readiness.canary]) {
				keys(stage, ["argv", "checkIds"]); strings(stage.argv, "readiness argv"); strings(stage.checkIds, "readiness checks", 32);
				assert(stage.argv.length > 0 && stage.checkIds.length > 0 && new Set(stage.checkIds).size === stage.checkIds.length, "readiness declarations");
				assert(!stage.argv.some((arg) => s.permittedPaths.includes(normalize(arg))), "readiness evaluator cannot be author-editable");
			}
		}
	} else assert(c.mode === "evidence" && c.command === undefined && c.codeAuthorityRef === undefined, "evidence authority");
	assert(canonical(c).length <= 65_536, "contract too large");
}
export type CreateMissionInput = {
	id: string;
	ownerConversationId: string;
	controllerTaskId: string;
	projectRoot: string;
	baselineId: string;
	contract: Contract;
	limits?: Partial<Limits>;
	now: number;
	supersedes?: string;
};
export function createMission(input: CreateMissionInput): Mission {
	const l = resolveLimits(input.limits);
	validateContract(input.contract, l);
	time(input.now);
	for (const s of [input.id, input.ownerConversationId, input.controllerTaskId, input.baselineId]) text(s, "identity", 256);
	assert(isAbsolute(input.projectRoot) && normalize(input.projectRoot) === input.projectRoot, "canonical absolute project root required");
	const contract = JSON.parse(canonical(input.contract)) as Contract, contractHash = researchHash(contract);
	const m: Mission = {
		id: input.id,
		version: 1,
		ownerConversationId: input.ownerConversationId,
		controllerTaskId: input.controllerTaskId,
		projectRoot: input.projectRoot,
		revision: 0,
		createdAt: input.now,
		updatedAt: input.now,
		deadlineAt: input.now + l.deadlineMs,
		status: "running",
		judgment: "undetermined",
		contract,
		contractHash,
		limits: l,
		frozenHash: "",
		ledger: {
			roundsAdmitted: 0,
			attemptsAdmitted: 0,
			candidatesAdmitted: 1,
			activeAttemptIds: [],
			confirmationReserveRemaining: contract.policy.confirmation === "required-once" ? 1 : 0,
			retainedArtifactBytes: 0,
		},
		policy: {
			phase: "baseline",
			roundIndex: 0,
			noProgressRounds: 0,
			debugChildrenByParent: {},
			confirmationState: contract.policy.confirmation === "required-once" ? "reserved" : "unused",
		},
		cancellationEpoch: 0,
		activeRunIds: [],
		candidates: [{
			id: input.baselineId,
			missionId: input.id,
			operation: "baseline",
			summary: contract.baseline.definition,
			feedbackReceiptIds: [],
			artifactHash: contract.baseline.artifactHash,
			state: "ready",
			evaluationIds: [],
			dagRefs: [],
		}],
		attempts: [],
		evaluations: [],
		report: { state: "pending", desiredRevision: 0, writtenRevision: -1 },
	};
	if (input.supersedes !== undefined) {
		text(input.supersedes, "supersedes", 256);
		m.supersedes = input.supersedes;
	}
	time(m.deadlineAt);
	m.frozenHash = frozenHash(m);
	return m;
}
function frozenHash(m: Mission): string {
	return researchHash({
		contract: m.contract,
		limits: m.limits,
		projectRoot: m.projectRoot,
		deadlineAt: m.deadlineAt,
		id: m.id,
		ownerConversationId: m.ownerConversationId,
	});
}
function intact(m: Mission): void {
	assert(m.frozenHash === frozenHash(m) && m.contractHash === researchHash(m.contract), "frozen mission changed");
}
function touch(m: Mission, now: number): void {
	time(now);
	m.revision++;
	m.updatedAt = now;
	m.report.desiredRevision = m.revision;
	m.report.state = "pending";
}
export function addMission(state: ResearchState, m: Mission): Mission {
	const existing = state.missions.find((x) => x.id === m.id);
	if (existing) {
		assert(existing.frozenHash === m.frozenHash, "mission replay conflict");
		return existing;
	}
	assert(
		!state.missions.some((x) => x.status === "running" || x.status === "cancelling" || x.ledger.activeAttemptIds.length > 0),
		"active mission exists",
	);
	assert(state.missions.length < MAX_MISSIONS, "conversation mission capacity reached");
	state.missions.push(m);
	state.activeId = m.id;
	return m;
}
export function budgetView(m: Mission) {
	return {
		...m.ledger,
		activeAttemptIds: [...m.ledger.activeAttemptIds],
		attemptsRemaining: m.limits.maxAttempts - m.ledger.attemptsAdmitted,
		nonConfirmationRemaining: m.limits.maxAttempts - m.ledger.attemptsAdmitted - m.ledger.confirmationReserveRemaining,
		roundsRemaining: m.limits.maxRounds - m.ledger.roundsAdmitted,
		candidatesRemaining: m.limits.maxCandidates - m.ledger.candidatesAdmitted,
		slotsRemaining: m.limits.maxConcurrent - m.ledger.activeAttemptIds.length,
		deadlineAt: m.deadlineAt,
	};
}
function candidate(m: Mission, id: string): Candidate {
	const c = m.candidates.find((c) => c.id === id);
	assert(c, "unknown candidate");
	return c;
}
function attempt(m: Mission, id: string): Attempt {
	const a = m.attempts.find((a) => a.id === id);
	assert(a, "unknown attempt");
	return a;
}
function latest(m: Mission, id: string): Evaluation | undefined {
	return m.evaluations.filter((e) => e.candidateId === id && attempt(m, e.attemptId).role !== "confirm").at(-1);
}
export function eligible(m: Mission, e: Evaluation): boolean {
	return e.validity === "valid" && e.guardrails && (m.contract.command?.resultSchema !== "research-numeric-v2" ||
		m.contract.requirements.filter(r => r.mandatory).every(r => e.requirements.find(x => x.id === r.id)?.verdict === "pass"));
}
export function failureKey(m: Mission, e: Evaluation): string | undefined {
	const failure = e.failure ?? (e.execution === "completed" && e.validity === "valid" && !eligible(m, e) && !e.requirements.some(r => r.verdict === "unknown")
		? { stage: "evaluation", checkIds: [...e.requirements.filter(r => r.verdict === "fail").map(r => r.id), ...(!e.guardrails ? ["guardrails"] : [])], code: "failed" } : undefined);
	return failure ? researchHash({ contractHash: m.contractHash, stage: failure.stage, checkIds: [...failure.checkIds].sort(), code: failure.code }) : undefined;
}
function repairAction(m: Mission): NextAction | undefined {
	const policy = m.contract.repair, c = m.candidates.at(-1)!;
	if (!policy || !(c.operation === "baseline" ? policy.baseline : policy.candidate) || c.state !== "invalid") return;
	const e = latest(m, c.id), key = e && failureKey(m, e), b = budgetView(m);
	if (!key || m.attempts.filter(a => a.failureKey === key).length >= policy.maxPerFailure || b.nonConfirmationRemaining < 2 || b.roundsRemaining <= 0 || b.candidatesRemaining <= 0 || m.policy.noProgressRounds >= m.contract.policy.maxNoProgressRounds) return;
	return { kind: "propose", operation: "debug", parentId: c.id, feedbackReceiptIds: [e!.id] };
}
function target(m: Mission, e: Evaluation): boolean {
	if (!eligible(m, e)) return false;
	const p = m.contract.policy;
	return p.kind === "numeric"
		? e.aggregate !== undefined &&
			(p.numeric.direction === "min" ? e.aggregate <= p.numeric.goalThreshold : e.aggregate >= p.numeric.goalThreshold)
		: m.contract.requirements.filter((r) => r.mandatory).every((r) => e.requirements.find((x) => x.id === r.id)?.verdict === "pass");
}
export type NextAction = { kind: "wait"; reason: string } | { kind: "stop"; reason: string; status: "blocked" | "inconclusive" } | {
	kind: "evaluate" | "confirm";
	candidateId: string;
} | { kind: "propose"; operation: "draft" | "debug" | "improve"; parentId?: string; feedbackReceiptIds: string[] };
export function nextAction(m: Mission, now: number): NextAction {
	intact(m);
	time(now);
	if (m.status !== "running") return { kind: "wait", reason: m.status };
	if (m.attempts.some((a) => a.state === "unknown")) return { kind: "stop", reason: "unknown_external_effect", status: "blocked" };
	if (now >= m.deadlineAt) return { kind: "stop", reason: "deadline", status: "inconclusive" };
	if (m.ledger.activeAttemptIds.length) return { kind: "wait", reason: "active_attempt" };
	if (m.policy.phase === "baseline") return { kind: "evaluate", candidateId: m.candidates[0]!.id };
	if (m.policy.phase === "evaluate" && m.policy.pendingCandidateId) return { kind: "evaluate", candidateId: m.policy.pendingCandidateId };
	const incumbent = m.incumbentId && latest(m, m.incumbentId);
	const repair = repairAction(m);
	if (repair) return repair;
	if (m.contract.command?.resultSchema === "research-numeric-v2" && ["invalid", "unknown"].includes(m.candidates.at(-1)!.state)) return { kind: "stop", reason: "unrepairable_or_exhausted_failure", status: "blocked" };
	if (!incumbent) return { kind: "stop", reason: "invalid_baseline", status: "blocked" };
	const b = budgetView(m);
	const met = target(m, incumbent);
	const reason = met
		? "target_met"
		: m.policy.noProgressRounds >= m.contract.policy.maxNoProgressRounds
		? "no_progress"
		: b.roundsRemaining <= 0
		? "round_limit"
		: b.candidatesRemaining <= 0
		? "candidate_limit"
		: b.nonConfirmationRemaining < 2
		? "attempt_limit"
		: undefined;
	if (reason) {
		return m.ledger.confirmationReserveRemaining
			? { kind: "confirm", candidateId: m.incumbentId! }
			: { kind: "stop", reason: `exploratory_${reason}`, status: "inconclusive" };
	}
	const failed = m.candidates.at(-1)!;
	if (
		!m.contract.repair && failed.state === "invalid" && failed.operation !== "baseline" &&
		(m.policy.debugChildrenByParent[failed.id] ?? 0) < m.contract.policy.maxDebugChildren && failed.evaluationIds.length
	) return { kind: "propose", operation: "debug", parentId: failed.id, feedbackReceiptIds: [...failed.evaluationIds] };
	if (m.ledger.roundsAdmitted === 0) return { kind: "propose", operation: "draft", feedbackReceiptIds: [incumbent.id] };
	return { kind: "propose", operation: "improve", parentId: m.incumbentId!, feedbackReceiptIds: [incumbent.id] };
}
export type ReserveAttemptInput = {
	id: string;
	reservationKey: string;
	epoch: number;
	now: number;
	action: Exclude<NextAction, { kind: "wait" | "stop" }>;
	candidateId?: string;
	roundId?: string;
	summary?: string;
};
export function reserveAttempt(m: Mission, input: ReserveAttemptInput): Attempt {
	intact(m);
	time(input.now);
	text(input.id, "attempt id", 256);
	text(input.reservationKey, "reservation key", 256);
	const { now: _now, ...intent } = input;
	const reservationHash = researchHash(intent);
	const old = m.attempts.find((a) => a.reservationKey === input.reservationKey);
	if (old) {
		assert(old.reservationHash === reservationHash, "reservation replay conflict");
		return old;
	}
	assert(m.status === "running" && m.cancellationEpoch === input.epoch && input.now < m.deadlineAt, "admission fenced");
	assert(!m.attempts.some((a) => a.id === input.id), "duplicate attempt id");
	assert(canonical(nextAction(m, input.now)) === canonical(input.action), "action not selected");
	const b = budgetView(m);
	assert(b.slotsRemaining > 0 && b.attemptsRemaining > 0, "attempt capacity");
	const action = input.action;
	let c: Candidate;
	if (action.kind === "propose") {
		text(input.candidateId, "candidate id", 256);
		text(input.roundId, "round id", 256);
		text(input.summary, "summary");
		assert(b.nonConfirmationRemaining >= 2 && b.roundsRemaining > 0 && b.candidatesRemaining > 0, "round capacity");
		assert(
			!m.candidates.some((c) => c.id === input.candidateId) && !m.attempts.some((a) => a.roundId === input.roundId),
			"duplicate candidate or round",
		);
		action.feedbackReceiptIds.forEach((id) => assert(m.evaluations.some((e) => e.id === id), "unknown feedback"));
		if (action.parentId) candidate(m, action.parentId);
		c = {
			id: input.candidateId,
			missionId: m.id,
			operation: action.operation,
			summary: input.summary,
			feedbackReceiptIds: [...action.feedbackReceiptIds],
			state: "proposed",
			evaluationIds: [],
			dagRefs: [],
		};
		if (action.parentId) c.parentId = action.parentId;
		m.candidates.push(c);
		m.ledger.candidatesAdmitted++;
		m.ledger.roundsAdmitted++;
		m.policy.roundIndex++;
		m.policy.pendingCandidateId = c.id;
		if (action.operation === "debug") {
			m.policy.debugChildrenByParent[action.parentId!] = (m.policy.debugChildrenByParent[action.parentId!] ?? 0) + 1;
		}
	} else {
		c = candidate(m, action.candidateId);
		assert(c.artifactHash, "candidate not ready");
		assert(
			action.kind === "confirm" ? m.ledger.confirmationReserveRemaining === 1 : b.nonConfirmationRemaining >= 1,
			"reserved confirmation capacity",
		);
	}
	if (action.kind === "confirm") {
		m.ledger.confirmationReserveRemaining = 0;
		m.policy.confirmationState = "running";
		m.policy.phase = "confirm";
	}
	const a: Attempt = {
		id: input.id,
		missionId: m.id,
		candidateId: c.id,
		role: action.kind,
		ordinal: m.ledger.attemptsAdmitted + 1,
		reservationKey: input.reservationKey,
		reservationHash,
		cancellationEpoch: input.epoch,
		contractHash: m.contractHash,
		state: "reserved",
		createdAt: input.now,
		deadlineAt: Math.min(m.deadlineAt, input.now + m.limits.attemptTimeoutMs),
		artifactBytes: 0,
	};
	if (action.kind === "propose" && action.operation === "debug" && m.contract.repair) {
		a.failureKey = failureKey(m, latest(m, action.parentId!)!)!;
	}
	if (input.roundId !== undefined) a.roundId = input.roundId;
	else if (action.kind === "evaluate" && c.operation !== "baseline") {
		const roundId = m.attempts.find((prior) => prior.candidateId === c.id && prior.role === "propose")?.roundId;
		if (roundId !== undefined) a.roundId = roundId;
	}
	m.attempts.push(a);
	m.ledger.attemptsAdmitted++;
	m.ledger.activeAttemptIds.push(a.id);
	touch(m, input.now);
	return a;
}
export function bindAttempt(m: Mission, id: string, binding: AttemptBinding, epoch: number, now: number): Attempt {
	intact(m);
	time(now);
	const a = attempt(m, id);
	[binding.runId, binding.nodeId, binding.key, binding.runnerId].forEach((v) => text(v, "runner binding", 256));
	if (a.binding) {
		assert(canonical(a.binding) === canonical(binding), "runner replay conflict");
		return a;
	}
	assert(
		m.status === "running" && epoch === m.cancellationEpoch && a.cancellationEpoch === epoch && now < a.deadlineAt &&
			a.state === "reserved",
		"binding fenced",
	);
	a.binding = { ...binding };
	a.state = "running";
	if (!m.activeRunIds.includes(binding.runId)) m.activeRunIds.push(binding.runId);
	candidate(m, a.candidateId).dagRefs.push({ runId: binding.runId, nodeId: binding.nodeId });
	touch(m, now);
	return a;
}
export type AttemptResult = {
	state: "succeeded" | "failed" | "cancelled" | "unknown";
	artifactHash?: string;
	artifactBytes?: number;
	error?: string;
};
function release(m: Mission, a: Attempt): void {
	m.ledger.activeAttemptIds = m.ledger.activeAttemptIds.filter((id) => id !== a.id);
	m.activeRunIds = m.activeRunIds.filter((id) => m.ledger.activeAttemptIds.some((aid) => attempt(m, aid).binding?.runId === id));
}
function finish(m: Mission, status: MissionStatus, reason: string, judgment: Judgment = "undetermined"): void {
	m.status = status;
	m.stopReason = reason;
	m.judgment = judgment;
	m.policy.phase = "terminal";
}
export function settleAttempt(m: Mission, id: string, result: AttemptResult, epoch: number, now: number): void {
	intact(m);
	time(now);
	const a = attempt(m, id);
	assert(epoch === a.cancellationEpoch, "wrong attempt epoch");
	assert(["succeeded", "failed", "cancelled", "unknown"].includes(result.state), "settlement state");
	if (result.error !== undefined) text(result.error, "error");
	const hash = researchHash(result);
	if (a.resultHash) {
		assert(a.resultHash === hash, "settlement replay conflict");
		return;
	}
	assert(a.state === "reserved" || a.state === "running", "attempt already settled");
	const bytes = result.artifactBytes ?? 0;
	integer(bytes, 0, m.limits.maxArtifactBytes - m.ledger.retainedArtifactBytes, "artifact bytes");
	assert(result.state !== "succeeded" || a.binding, "success needs runner binding");
	const current = m.status === "running" && epoch === m.cancellationEpoch && now < a.deadlineAt;
	if (result.state === "succeeded" && a.role === "propose" && current) text(result.artifactHash, "proposal artifact hash", 256);
	a.state = result.state;
	a.resultHash = hash;
	a.endedAt = now;
	a.artifactBytes = bytes;
	if (result.error) a.error = result.error;
	m.ledger.retainedArtifactBytes += bytes;
	// Successful evaluation retains its slot until its actual receipt is accepted.
	if (result.state !== "unknown" && (a.role === "propose" || result.state !== "succeeded" || !current)) release(m, a);
	const c = candidate(m, a.candidateId);
	if (result.state === "unknown") {
		c.state = "unknown";
		finish(m, "blocked", "unknown_external_effect");
	} else if (current && a.role === "propose") {
		if (result.state === "succeeded") {
			c.artifactHash = result.artifactHash!;
			c.state = "ready";
			m.policy.phase = "evaluate";
		} else {
			c.state = "invalid";
			m.policy.noProgressRounds++;
			m.policy.phase = "propose";
			delete m.policy.pendingCandidateId;
		}
	} else if (current && result.state !== "succeeded") {
		c.state = "invalid";
		if (a.role === "confirm") {
			m.policy.confirmationState = "failed";
			finish(m, "inconclusive", "confirmation_failed");
		} else if (c.operation === "baseline") finish(m, "blocked", "invalid_baseline");
		else {
			m.policy.noProgressRounds++;
			m.policy.phase = "propose";
			delete m.policy.pendingCandidateId;
		}
	}
	if (m.status === "cancelling" && !m.ledger.activeAttemptIds.length) finish(m, "cancelled", m.stopReason ?? "cancelled");
	touch(m, now);
}
/** INTERNAL: host must authenticate real runner output before invoking this function.
 * A public/model tool must never expose this receipt-acceptance boundary.
 * Invalid protocol data is rejected without mutation; host settles malformed output as failed.
 */
export function acceptEvaluation(m: Mission, receipt: Evaluation, epoch: number, now: number): Evaluation {
	intact(m);
	time(now);
	const a = attempt(m, receipt.attemptId), c = candidate(m, a.candidateId);
	const old = m.evaluations.find((e) => e.id === receipt.id);
	if (old) {
		const { acceptedAt: _at, aggregate: _mean, variance: _variance, verdict: oldVerdict, ...stored } = old;
		const { acceptedAt: _incoming, aggregate: mean, variance, verdict, ...incoming } = receipt;
		assert(m.contract.command?.resultSchema === "research-numeric-v2" || verdict === oldVerdict, "evaluation replay verdict conflict");
		assert(
			canonical(stored) === canonical(incoming) && (mean === undefined || mean === old.aggregate) &&
				(variance === undefined || variance === old.variance),
			"evaluation replay conflict",
		);
		return old;
	}
	assert(
		m.status === "running" && epoch === m.cancellationEpoch && epoch === a.cancellationEpoch && now < a.deadlineAt,
		"evaluation fenced",
	);
	assert(
		(a.state === "running" || a.state === "succeeded") && !a.evaluationId && a.role !== "propose" && a.binding,
		"not an evaluation attempt",
	);
	assert(
		receipt.missionId === m.id && receipt.candidateId === c.id && receipt.artifactHash === c.artifactHash &&
			receipt.contractHash === m.contractHash && canonical(receipt.binding) === canonical(a.binding),
		"receipt binding mismatch",
	);
	const ev = m.contract.evaluator;
	assert(
		receipt.evaluatorRevision === ev.revision && receipt.environmentFingerprint === ev.environmentFingerprint &&
			receipt.inputFingerprint === ev.inputFingerprint,
		"incomparable protocol",
	);
	text(receipt.id, "evaluation id", 256);
	text(receipt.receiptHash, "host receipt hash", 256);
	text(receipt.feedback, "feedback");
	assert(
		["completed", "failed", "cancelled", "unknown"].includes(receipt.execution) &&
			["valid", "invalid", "unknown"].includes(receipt.validity) && ["pass", "fail", "inconclusive"].includes(receipt.verdict) &&
			typeof receipt.guardrails === "boolean",
		"evaluation schema",
	);
	assert(receipt.validity !== "valid" || receipt.execution === "completed", "validity requires completed execution");
	assert(
		Array.isArray(receipt.evidence) && receipt.evidence.length <= 64 &&
			new Set(receipt.evidence.map((e) => e.id)).size === receipt.evidence.length,
		"evidence bounds",
	);
	for (const e of receipt.evidence) {
		text(e.id, `evidence ${e.id} id`);
		for (const [name, value] of [
			["sourceLocator", e.sourceLocator],
			["location", e.location],
			["version", e.version],
			["sourceFamily", e.sourceFamily],
			["inference", e.inference],
		] as const) {
			text(value, `evidence ${e.id} ${name}`);
		}
		// Observation is the literal excerpt of a successful source read: mandatory when the
		// source was observed, honestly empty when access is "unavailable" or "unknown".
		assert(typeof e.observation === "string" && e.observation.length <= 4096, `invalid evidence ${e.id} observation`);
		assert(e.access !== "observed" || e.observation.trim().length > 0, `invalid evidence ${e.id} observation`);
		for (const values of [e.claimIds, e.assumptions, e.counterevidence, e.limitations]) strings(values, "evidence list");
		assert(["observed", "unavailable", "unknown"].includes(e.access), "evidence access");
	}
	assert(
		receipt.requirements.length === m.contract.requirements.length &&
			new Set(receipt.requirements.map((r) => r.id)).size === receipt.requirements.length,
		"complete requirements required",
	);
	for (const r of receipt.requirements) {
		assert(m.contract.requirements.some((x) => x.id === r.id) && ["pass", "fail", "unknown"].includes(r.verdict), "requirement verdict");
		strings(r.evidenceIds, "evidence references");
		assert(r.evidenceIds.every((id) => receipt.evidence.some((e) => e.id === id)), "missing evidence");
		if (m.contract.policy.kind === "qualitative" && r.verdict !== "unknown") {
			assert(
				r.evidenceIds.some((id) => receipt.evidence.some((e) => e.id === id && e.access === "observed")),
				"verdict needs observed evidence",
			);
		}
	}
	const receiptJson = canonical(receipt);
	assert(receiptJson.length <= 131_072, "receipt too large");
	const e = JSON.parse(receiptJson) as Evaluation, p = m.contract.policy;
	if (p.kind === "numeric" && e.validity === "valid") {
		assert(
			e.metric === p.numeric.metric && e.unit === p.numeric.unit && e.samples?.length === p.numeric.repetitions &&
				e.samples.every(Number.isFinite),
			"invalid metric samples",
		);
		const mean = e.samples.reduce((sum, x) => sum + x / e.samples!.length, 0);
		assert(Number.isFinite(mean), "nonfinite mean");
		const variance = e.samples.reduce((sum, x) => sum + ((x - mean) ** 2) / e.samples!.length, 0);
		assert(Number.isFinite(variance), "nonfinite variance");
		assert(e.aggregate === undefined || e.aggregate === mean, "aggregate mismatch");
		e.aggregate = mean;
		e.variance = variance;
	} else assert(e.samples === undefined && e.aggregate === undefined && e.variance === undefined, "unexpected numeric score");
	if (p.kind === "qualitative") {
		assert(e.comparison !== undefined && ["better", "same", "worse", "incomparable"].includes(e.comparison), "comparison required");
	}
	let improved = false;
	const incumbent = m.incumbentId ? latest(m, m.incumbentId) : undefined;
	if (a.role !== "confirm" && eligible(m, e)) {
		if (!incumbent) improved = true;
		else if (p.kind === "numeric") {
			const gain = (e.aggregate! - incumbent.aggregate!) * (p.numeric.direction === "max" ? 1 : -1);
			improved = gain > 0 && gain >= p.numeric.minimumEffect;
		} else {improved = e.comparison === "better" && m.contract.requirements.filter((r) =>
				r.mandatory
			).every((r) =>
				incumbent.requirements.find((x) => x.id === r.id)?.verdict !== "pass" ||
				e.requirements.find((x) => x.id === r.id)?.verdict === "pass"
			) &&
				m.contract.requirements.some((r) =>
					incumbent.requirements.find((x) => x.id === r.id)?.verdict !== "pass" &&
					e.requirements.find((x) => x.id === r.id)?.verdict === "pass"
				);}
	}
	if (m.contract.command?.resultSchema === "research-numeric-v2") e.verdict = target(m, e) ? "pass" : eligible(m, e) ? "fail" : "inconclusive";
	e.acceptedAt = now;
	m.evaluations.push(e);
	c.evaluationIds.push(e.id);
	c.state = e.validity === "unknown" ? "unknown" : (m.contract.command?.resultSchema === "research-numeric-v2" ? eligible(m, e) : e.validity === "valid") ? "evaluated" : "invalid";
	a.evaluationId = e.id;
	a.state = e.execution === "completed"
		? "succeeded"
		: e.execution === "unknown"
		? "unknown"
		: e.execution === "cancelled"
		? "cancelled"
		: "failed";
	a.endedAt = now;
	if (a.state !== "unknown") release(m, a);
	if (e.execution === "unknown") finish(m, "blocked", "unknown_external_effect");
	else if (a.role === "confirm") {
		m.selectedId = c.id;
		m.policy.confirmationState = e.validity !== "valid" ? "unknown" : target(m, e) ? "passed" : "failed";
		if (target(m, e)) finish(m, "concluded", p.kind === "numeric" ? "confirmed_target" : "confirmed_criteria", "supported");
		else if (e.validity === "valid" && e.guardrails && p.kind === "qualitative" && m.contract.negativeConclusion) {
			const required = e.requirements.filter((r) => m.contract.requirements.some((x) => x.id === r.id && x.mandatory));
			const negative = required.every((r) => r.verdict === "fail")
				? "rejected"
				: required.some((r) => r.verdict === "fail") && required.some((r) => r.verdict === "pass") &&
						required.every((r) => r.verdict !== "unknown")
				? "mixed"
				: "undetermined";
			finish(m, negative === "undetermined" ? "inconclusive" : "concluded", "confirmed_negative", negative);
		} else finish(m, "inconclusive", e.validity !== "valid" ? "confirmation_unknown" : "no_supported_improvement");
	} else if (c.operation === "baseline" && (!improved || e.validity !== "valid") && !repairAction(m)) finish(m, "blocked", "invalid_baseline");
	else {
		if (improved) {
			m.basisId ??= c.id;
			m.incumbentId = c.id;
			m.policy.incumbentId = c.id;
			m.policy.noProgressRounds = 0;
		} else if (c.operation !== "baseline") m.policy.noProgressRounds++;
		m.policy.phase = "propose";
		delete m.policy.pendingCandidateId;
	}
	touch(m, now);
	return e;
}
export function cancelMission(m: Mission, reason: string, now: number): string[] {
	intact(m);
	time(now);
	text(reason, "cancel reason");
	if (m.status !== "running") return [...m.ledger.activeAttemptIds];
	m.cancellationEpoch++;
	for (const id of [...m.ledger.activeAttemptIds]) {
		const a = attempt(m, id);
		if (a.state === "succeeded") release(m, a);
	}
	m.stopReason = reason;
	m.status = m.ledger.activeAttemptIds.length ? "cancelling" : "cancelled";
	m.policy.phase = "terminal";
	touch(m, now);
	return [...m.ledger.activeAttemptIds];
}
export function stopMission(m: Mission, now: number): void {
	const action = nextAction(m, now);
	assert(action.kind === "stop", "policy has not stopped");
	if (m.ledger.activeAttemptIds.length && action.reason === "deadline") {
		cancelMission(m, "deadline", now);
		return;
	}
	finish(m, action.status, action.reason);
	touch(m, now);
}

/** Host-only essential authority/environment failure. Does not assert effect cessation. */
export function blockMission(m: Mission, reason: string, now: number): string[] {
	intact(m);
	time(now);
	text(reason, "block reason");
	if (m.status !== "running" && m.status !== "cancelling") return [...m.ledger.activeAttemptIds];
	m.cancellationEpoch++;
	finish(m, "blocked", reason);
	touch(m, now);
	return [...m.ledger.activeAttemptIds];
}

/** Host-only reconciliation of a previously ambiguous process; never reopens research. */
export function reconcileUnknown(m: Mission, id: string, outcome: "failed" | "cancelled", evidenceRef: string, now: number): void {
	intact(m);
	time(now);
	text(evidenceRef, "reconciliation evidence");
	const a = attempt(m, id);
	assert(a.state === "unknown" && (outcome === "failed" || outcome === "cancelled"), "not an unknown process");
	a.state = outcome;
	a.error = evidenceRef;
	a.endedAt = now;
	release(m, a);
	touch(m, now);
}
