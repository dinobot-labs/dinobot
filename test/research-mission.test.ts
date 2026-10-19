import { describe, expect, test } from "bun:test";
import {
	acceptEvaluation,
	addMission,
	type Attempt,
	bindAttempt,
	blockMission,
	budgetView,
	cancelMission,
	type Contract,
	createMission,
	type Evaluation,
	type Mission,
	nextAction,
	reconcileUnknown,
	researchHash,
	reserveAttempt,
	type ReserveAttemptInput,
	resolveLimits,
	settleAttempt,
	stopMission,
} from "../src/core/research.ts";

function contract(numeric = true): Contract {
	return {
		question: "Does the candidate satisfy K1?",
		hypotheses: ["A candidate improves baseline"],
		requirements: [{ id: "K1", mandatory: true }],
		scope: "fixture",
		exclusions: [],
		mode: "evidence",
		baseline: { definition: "baseline", artifactHash: "baseline-hash" },
		evaluator: {
			profile: numeric ? "numeric-fixture" : "evidence-review-v1",
			revision: "v1",
			environmentFingerprint: "env",
			inputFingerprint: "inputs",
		},
		policy: numeric
			? {
				kind: "numeric",
				numeric: {
					metric: "latency",
					unit: "ms",
					direction: "min",
					repetitions: 2,
					aggregation: "mean",
					minimumEffect: 5,
					goalThreshold: 80,
				},
				maxNoProgressRounds: 2,
				maxDebugChildren: 1,
				confirmation: "required-once",
			}
			: { kind: "qualitative", maxNoProgressRounds: 2, maxDebugChildren: 1, confirmation: "required-once" },
		reportAuthorityRef: "user-message:1",
	};
}
for (const stage of ["preflight", "canary"] as const) {
 test.each(["././candidate.ts", "sub/../candidate.ts"])(
  `readiness ${stage} alias %s is rejected without contract mutation`, (arg) => {
   const c = contract();
   c.mode = "trusted-local-code";
   c.codeAuthorityRef = "host:fixture";
   c.command = {executable:process.execPath,argv:["evaluator.ts"],cwdPolicy:"candidate",environmentAllowlist:[],timeoutMs:1000,resultSchema:"research-numeric-v2",baseCommit:"a".repeat(40),permittedPaths:["candidate.ts"],readiness:{preflight:{argv:["evaluator.ts"],checkIds:["ready"]},canary:{argv:["evaluator.ts"],checkIds:["ready"]}}};
   c.command.readiness![stage].argv = [arg];
   const before = structuredClone(c);
   expect(() => createMission({id:"m",ownerConversationId:"c",controllerTaskId:"t",projectRoot:"/project",baselineId:"B",contract:c,now:0})).toThrow("author-editable");
   expect(c).toEqual(before);
  });
}
function mission(numeric = true, limits = {}): Mission {
	return createMission({
		id: "m",
		ownerConversationId: "conversation",
		controllerTaskId: "controller",
		projectRoot: "/project",
		baselineId: "B",
		contract: contract(numeric),
		limits,
		now: 0,
	});
}
function reserve(m: Mission): Attempt {
	const action = nextAction(m, 1);
	if (action.kind === "wait" || action.kind === "stop") throw new Error(`No action: ${action.reason}`);
	const n = m.attempts.length + 1;
	const input: ReserveAttemptInput = { id: `a${n}`, reservationKey: `key${n}`, epoch: m.cancellationEpoch, now: 1, action };
	if (action.kind === "propose") {
		input.candidateId = `C${m.candidates.length}`;
		input.roundId = `r${m.ledger.roundsAdmitted + 1}`;
		input.summary = "change based on actual feedback";
	}
	const a = reserveAttempt(m, input);
	bindAttempt(m, a.id, { runId: "run", nodeId: a.id, key: `node-${a.id}`, runnerId: `runner-${a.id}` }, m.cancellationEpoch, 2);
	return a;
}
function receipt(m: Mission, a: Attempt, score = 100, verdict: "pass" | "fail" | "unknown" = "unknown"): Evaluation {
	const c = m.candidates.find((c) => c.id === a.candidateId)!;
	const e: Evaluation = {
		id: `e${a.ordinal}`,
		missionId: m.id,
		candidateId: c.id,
		attemptId: a.id,
		binding: a.binding!,
		artifactHash: c.artifactHash!,
		contractHash: m.contractHash,
		evaluatorRevision: "v1",
		environmentFingerprint: "env",
		inputFingerprint: "inputs",
		execution: "completed",
		validity: "valid",
		verdict: verdict === "unknown" ? "inconclusive" : verdict,
		requirements: [{ id: "K1", verdict, evidenceIds: ["source"] }],
		evidence: [{
			id: "source",
			claimIds: ["K1"],
			sourceLocator: "fixture://observed",
			location: "line 1",
			version: "1",
			sourceFamily: "fixture",
			observation: "Actual fixture observation",
			inference: "Review inference",
			assumptions: [],
			counterevidence: [],
			access: "observed",
			limitations: ["Not independent evidence"],
		}],
		guardrails: true,
		feedback: "Observed remaining weakness",
		receiptHash: `host-${a.id}`,
	};
	if (m.contract.policy.kind === "numeric") {
		e.samples = [score, score];
		e.metric = "latency";
		e.unit = "ms";
	} else e.comparison = verdict === "pass" ? "better" : "same";
	return e;
}
function evaluate(m: Mission, score = 100, verdict: "pass" | "fail" | "unknown" = "unknown"): Evaluation {
	const a = reserve(m);
	return acceptEvaluation(m, receipt(m, a, score, verdict), m.cancellationEpoch, 3);
}
function propose(m: Mission): Attempt {
	const a = reserve(m);
	expect(a.role).toBe("propose");
	settleAttempt(m, a.id, { state: "succeeded", artifactHash: `hash-${a.candidateId}` }, m.cancellationEpoch, 3);
	return a;
}

describe("research finite domain", () => {
	test("host block fences scientific success while preserving unresolved charged slots", () => {
		const m = mission(), a = reserve(m), e = receipt(m, a, 1);
		expect(blockMission(m, "essential evaluator unavailable", 3)).toEqual([a.id]);
		expect([m.status, m.judgment, m.cancellationEpoch]).toEqual(["blocked", "undetermined", 1]);
		expect(m.ledger.attemptsAdmitted).toBe(1);
		expect(() => acceptEvaluation(m, e, 0, 4)).toThrow("fenced");
		const revision = m.revision;
		blockMission(m, "replayed", 4);
		expect(m.revision).toBe(revision);
		settleAttempt(m, a.id, { state: "cancelled" }, 0, 5);
		expect(m.ledger.activeAttemptIds).toEqual([]);
		expect(m.status).toBe("blocked");
	});
	test("trace A: baseline/draft/review/confirm has exactly four invocations", () => {
		const m = mission(false, { maxAttempts: 6, maxRounds: 2, maxCandidates: 3, maxConcurrent: 1 });
		evaluate(m);
		expect(budgetView(m).nonConfirmationRemaining).toBe(4);
		expect(nextAction(m, 4)).toEqual({ kind: "propose", operation: "draft", feedbackReceiptIds: ["e1"] });
		propose(m);
		evaluate(m, 0, "pass");
		expect(m.incumbentId).toBe("C1");
		expect(nextAction(m, 4)).toEqual({ kind: "confirm", candidateId: "C1" });
		evaluate(m, 0, "pass");
		expect([m.status, m.judgment, m.stopReason]).toEqual(["concluded", "supported", "confirmed_criteria"]);
		expect(m.ledger).toMatchObject({ attemptsAdmitted: 4, roundsAdmitted: 1, candidatesAdmitted: 2, confirmationReserveRemaining: 0 });
		expect(nextAction(m, 4).kind).toBe("wait");
	});
	test("trace B: failure debug improvement and fixed confirmation", () => {
		const m = mission(true, { maxAttempts: 9, maxRounds: 3, maxCandidates: 4, maxConcurrent: 1 });
		evaluate(m, 100);
		propose(m);
		const a = reserve(m), e = receipt(m, a);
		delete e.samples;
		e.execution = "failed";
		e.validity = "invalid";
		acceptEvaluation(m, e, 0, 3);
		expect(m.policy.noProgressRounds).toBe(1);
		expect(nextAction(m, 4)).toEqual({ kind: "propose", operation: "debug", parentId: "C1", feedbackReceiptIds: ["e3"] });
		propose(m);
		evaluate(m, 90);
		expect(m.incumbentId).toBe("C2");
		expect(m.policy.noProgressRounds).toBe(0);
		expect(nextAction(m, 4)).toEqual({ kind: "propose", operation: "improve", parentId: "C2", feedbackReceiptIds: ["e5"] });
		propose(m);
		evaluate(m, 75);
		evaluate(m, 76);
		expect([m.status, m.judgment, m.selectedId, m.ledger.attemptsAdmitted, m.ledger.roundsAdmitted]).toEqual([
			"concluded",
			"supported",
			"C3",
			8,
			3,
		]);
		expect(budgetView(m).attemptsRemaining).toBe(1);
	});
	test.each([NaN, Infinity, -Infinity, 0, -1, 1.2, 129])("rejects invalid attempt limit %s", (value) => {
		expect(() => resolveLimits({ maxAttempts: value })).toThrow();
	});
	test("limit relationships and required-once admission capacity", () => {
		expect(() => resolveLimits({ maxAttempts: 3, maxConcurrent: 4 })).toThrow();
		expect(() => mission(true, { maxAttempts: 3 })).toThrow();
		expect(() => mission(true, { maxCandidates: 1 })).toThrow();
		expect(() => resolveLimits({ deadlineMs: 10, attemptTimeoutMs: 11 })).toThrow();
		expect(() => resolveLimits({ maxOperations: 1 } as never)).toThrow();
	});
	test("immutable frozen contract detects tampering and input aliases are detached", () => {
		const c = contract();
		const m = createMission({
			id: "m",
			baselineId: "B",
			ownerConversationId: "c",
			controllerTaskId: "t",
			projectRoot: "/project",
			contract: c,
			now: 0,
		});
		c.question = "mutated";
		expect(m.contract.question).not.toBe(c.question);
		m.contract.question = "changed";
		expect(() => nextAction(m, 1)).toThrow("frozen");
	});
	test("one active mission and bounded document insertion", () => {
		const state = { missions: [] as Mission[] };
		const m = mission();
		addMission(state, m);
		expect(addMission(state, structuredClone(m))).toBe(m);
		const other = createMission({
			id: "other",
			baselineId: "B",
			ownerConversationId: "c",
			controllerTaskId: "t",
			projectRoot: "/project",
			contract: contract(),
			now: 0,
		});
		expect(() => addMission(state, other)).toThrow("active");
	});
	test("reservation and runner replays do not spend or rebind", () => {
		const m = mission();
		const input: ReserveAttemptInput = {
			id: "a",
			reservationKey: "stable",
			epoch: 0,
			now: 1,
			action: { kind: "evaluate", candidateId: "B" },
		};
		const a = reserveAttempt(m, input);
		expect(reserveAttempt(m, input)).toBe(a);
		expect(m.ledger.attemptsAdmitted).toBe(1);
		const b = { runId: "r", nodeId: "n", key: "k", runnerId: "runner" };
		bindAttempt(m, a.id, b, 0, 2);
		bindAttempt(m, a.id, b, 0, 2);
		expect(() => bindAttempt(m, a.id, { ...b, runnerId: "other" }, 0, 2)).toThrow("replay");
		expect(() => reserveAttempt(m, { ...input, id: "different" })).toThrow("replay");
		expect(nextAction(m, 2)).toEqual({ kind: "wait", reason: "active_attempt" });
	});
	test.each([NaN, Infinity, -Infinity])("nonfinite sample %s cannot rank", (value) => {
		const m = mission(), a = reserve(m), e = receipt(m, a);
		e.samples = [100, value];
		const before = researchHash(m);
		expect(() => acceptEvaluation(m, e, 0, 3)).toThrow();
		expect(researchHash(m)).toBe(before);
	});
	test("missing samples, wrong unit, fabricated aggregate, protocol and artifact binding", () => {
		for (
			const patch of [{ samples: [100] }, { unit: "seconds" }, { aggregate: 1 }, { inputFingerprint: "other" }, { artifactHash: "other" }, {
				contractHash: "other",
			}, { evaluatorRevision: "other" }]
		) {
			const m = mission(), a = reserve(m), e = { ...receipt(m, a), ...patch };
			expect(() => acceptEvaluation(m, e, 0, 3)).toThrow();
			expect(m.evaluations).toHaveLength(0);
		}
	});
	test("accepted evaluation replay is stable after aggregation and terminal state", () => {
		const m = mission(), a = reserve(m), e = receipt(m, a);
		const accepted = acceptEvaluation(m, e, 0, 3), revision = m.revision;
		expect(accepted.aggregate).toBe(100);
		expect(acceptEvaluation(m, e, 0, 4)).toBe(accepted);
		expect(m.revision).toBe(revision);
		expect(() => acceptEvaluation(m, { ...e, feedback: "forged" }, 0, 4)).toThrow("replay");
	});
	test.each([[100, "B"], [96, "B"], [95, "C1"], [94, "C1"]])("minimum effect boundary %s", (value, incumbent) => {
		const m = mission();
		evaluate(m, 100);
		propose(m);
		evaluate(m, value as number);
		expect(m.incumbentId).toBe(incumbent);
	});
	test("max direction and zero minimum effect still require strict improvement", () => {
		const c = contract();
		if (c.policy.kind !== "numeric") throw new Error();
		c.policy.numeric.direction = "max";
		c.policy.numeric.minimumEffect = 0;
		c.policy.numeric.goalThreshold = 1000;
		const m = createMission({
			id: "m",
			baselineId: "B",
			ownerConversationId: "c",
			controllerTaskId: "t",
			projectRoot: "/project",
			contract: c,
			now: 0,
		});
		evaluate(m, 100);
		propose(m);
		evaluate(m, 100);
		expect(m.incumbentId).toBe("B");
		propose(m);
		evaluate(m, 101);
		expect(m.incumbentId).toBe("C2");
	});
	test("failed proposals count no progress and confirmation capacity is never spent on generation", () => {
		const m = mission(true, { maxAttempts: 4, maxRounds: 2, maxCandidates: 3 });
		evaluate(m, 100);
		const a = reserve(m);
		settleAttempt(m, a.id, { state: "failed", error: "provider failure" }, 0, 3);
		expect(m.policy.noProgressRounds).toBe(1);
		expect(nextAction(m, 4)).toEqual({ kind: "confirm", candidateId: "B" });
		evaluate(m, 100);
		expect(m.status).toBe("inconclusive");
		expect(m.judgment).toBe("undetermined");
		expect(m.ledger.attemptsAdmitted).toBe(3);
	});
	test("no progress threshold stops expansion even with available capacity", () => {
		const m = mission();
		evaluate(m);
		for (let i = 0; i < 2; i++) {
			propose(m);
			evaluate(m);
		}
		expect(m.policy.noProgressRounds).toBe(2);
		expect(nextAction(m, 5).kind).toBe("confirm");
	});
	test("confirmation unknown is terminal without retry", () => {
		const m = mission(false);
		evaluate(m);
		propose(m);
		evaluate(m, 0, "pass");
		const a = reserve(m), e = receipt(m, a);
		e.validity = "unknown";
		acceptEvaluation(m, e, 0, 3);
		expect(m.status).toBe("inconclusive");
		expect(m.stopReason).toBe("confirmation_unknown");
		expect(nextAction(m, 4).kind).toBe("wait");
	});
	test("unknown external effect holds slot until host reconciliation, without refunds or reopening", () => {
		const m = mission(), a = reserve(m);
		settleAttempt(m, a.id, { state: "unknown", error: "process lost" }, 0, 3);
		expect(m.status).toBe("blocked");
		expect(m.ledger.activeAttemptIds).toEqual([a.id]);
		reconcileUnknown(m, a.id, "cancelled", "host checked process exit", 4);
		expect(m.ledger.activeAttemptIds).toEqual([]);
		expect(m.status).toBe("blocked");
		expect(m.ledger.attemptsAdmitted).toBe(1);
	});
	test("cancellation fences before settlement and old scientific receipts cannot win", () => {
		const m = mission(), a = reserve(m), e = receipt(m, a, 1);
		expect(cancelMission(m, "user", 3)).toEqual([a.id]);
		expect(m.status).toBe("cancelling");
		expect(m.cancellationEpoch).toBe(1);
		expect(() => acceptEvaluation(m, e, 0, 4)).toThrow("fenced");
		settleAttempt(m, a.id, { state: "cancelled" }, 0, 4);
		expect(m.status).toBe("cancelled");
		expect(m.incumbentId).toBeUndefined();
		expect(m.ledger.attemptsAdmitted).toBe(1);
	});
	test("deadline equality denies admission and requests settling, not false cessation", () => {
		const m = mission();
		const action = nextAction(m, 1);
		expect(() =>
			reserveAttempt(m, { id: "a", reservationKey: "k", epoch: 0, now: m.deadlineAt, action: action as ReserveAttemptInput["action"] })
		).toThrow();
		const a = reserve(m);
		stopMission(m, m.deadlineAt);
		expect(m.status).toBe("cancelling");
		expect(m.ledger.activeAttemptIds).toEqual([a.id]);
	});
	test("qualitative better cannot regress a passed mandatory requirement", () => {
		const c = contract(false);
		c.requirements.push({ id: "K2", mandatory: true });
		const m = createMission({
			id: "m",
			baselineId: "B",
			ownerConversationId: "c",
			controllerTaskId: "t",
			projectRoot: "/project",
			contract: c,
			now: 0,
		});
		let a = reserve(m), e = receipt(m, a, 0, "pass");
		e.requirements.push({ id: "K2", verdict: "unknown", evidenceIds: [] });
		acceptEvaluation(m, e, 0, 3);
		propose(m);
		a = reserve(m);
		e = receipt(m, a, 0, "fail");
		e.comparison = "better";
		e.requirements.push({ id: "K2", verdict: "pass", evidenceIds: ["source"] });
		acceptEvaluation(m, e, 0, 3);
		expect(m.incumbentId).toBe("B");
	});
	test("qualitative authority requires actual observed evidence", () => {
		const m = mission(false), a = reserve(m), e = receipt(m, a, 0, "pass");
		e.evidence[0]!.access = "unavailable";
		expect(() => acceptEvaluation(m, e, 0, 3)).toThrow("observed");
	});
	test("explicit negative semantics can reject, but numeric misses cannot", () => {
		const c = contract(false);
		c.negativeConclusion = "all-fail-rejected-any-fail-mixed";
		const m = createMission({
			id: "m",
			baselineId: "B",
			ownerConversationId: "c",
			controllerTaskId: "t",
			projectRoot: "/project",
			contract: c,
			limits: { maxAttempts: 4 },
			now: 0,
		});
		evaluate(m, 0, "fail");
		propose(m);
		evaluate(m, 0, "fail");
		evaluate(m, 0, "fail");
		expect(m.judgment).toBe("rejected");
		expect(m.status).toBe("concluded");
	});
	test("confirmation none remains exploratory even at target", () => {
		const c = contract();
		c.policy.confirmation = "none";
		const m = createMission({
			id: "m",
			baselineId: "B",
			ownerConversationId: "c",
			controllerTaskId: "t",
			projectRoot: "/project",
			contract: c,
			limits: { maxAttempts: 3 },
			now: 0,
		});
		evaluate(m, 70);
		stopMission(m, 4);
		expect(m.status).toBe("inconclusive");
		expect(m.judgment).toBe("undetermined");
		expect(m.ledger.confirmationReserveRemaining).toBe(0);
	});
	test("deterministic randomized traces preserve monotone bounds, slots, lineage and terminal fencing", () => {
		let seed = 1327;
		const random = () => {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			return seed / 2 ** 32;
		};
		for (let run = 0; run < 100; run++) {
			const m = mission();
			let spent = 0, rounds = 0, count = 1;
			for (let step = 0; step < 40 && m.status === "running"; step++) {
				const action = nextAction(m, 1);
				if (action.kind === "stop") {
					stopMission(m, 1);
					break;
				}
				if (action.kind === "wait") throw new Error("unexpected dangling work");
				const a = reserve(m);
				if (random() < 0.03) {
					cancelMission(m, "random cancel", 2);
					settleAttempt(m, a.id, { state: "cancelled" }, a.cancellationEpoch, 3);
				} else if (a.role === "propose") {
					settleAttempt(
						m,
						a.id,
						random() < 0.25 ? { state: "failed", error: "proposal failed" } : { state: "succeeded", artifactHash: `hash-${a.id}` },
						0,
						3,
					);
				} else acceptEvaluation(m, receipt(m, a, 60 + Math.floor(random() * 60)), 0, 3);
				expect(m.ledger.attemptsAdmitted).toBeGreaterThanOrEqual(spent);
				spent = m.ledger.attemptsAdmitted;
				expect(m.ledger.roundsAdmitted).toBeGreaterThanOrEqual(rounds);
				rounds = m.ledger.roundsAdmitted;
				expect(m.ledger.candidatesAdmitted).toBeGreaterThanOrEqual(count);
				count = m.ledger.candidatesAdmitted;
				expect(spent).toBeLessThanOrEqual(m.limits.maxAttempts);
				expect(rounds).toBeLessThanOrEqual(m.limits.maxRounds);
				expect(count).toBeLessThanOrEqual(m.limits.maxCandidates);
				expect(m.ledger.activeAttemptIds.length).toBeLessThanOrEqual(m.limits.maxConcurrent);
				expect(budgetView(m).nonConfirmationRemaining).toBeGreaterThanOrEqual(0);
				for (const c of m.candidates) {
					if (c.parentId) expect(m.candidates.findIndex((x) => x.id === c.parentId)).toBeLessThan(m.candidates.indexOf(c));
					for (const id of c.feedbackReceiptIds) expect(m.evaluations.some((e) => e.id === id)).toBe(true);
				}
			}
			expect(m.status).not.toBe("running");
			expect(nextAction(m, 5).kind).toBe("wait");
		}
	});
});

function strictMission(): Mission {
 const c = contract();
 c.mode = 'trusted-local-code'; c.codeAuthorityRef = 'host:fixture';
 c.command = { executable: 'bun', argv: ['evaluate.ts'], cwdPolicy: 'candidate', environmentAllowlist: [], timeoutMs: 1000, resultSchema: 'research-numeric-v2', baseCommit: 'a'.repeat(40), permittedPaths: ['candidate.ts'] };
 c.repair = { baseline: true, candidate: true, maxPerFailure: 2 };
 return createMission({ id: 'm', ownerConversationId: 'conversation', controllerTaskId: 'controller', projectRoot: '/project', baselineId: 'B', contract: c, now: 0 });
}
test('numeric-v2 rejects great metric with failed mandatory correctness and repairs baseline before terminal', () => {
 const m = strictMission(); evaluate(m, 1, 'fail');
 expect(m.incumbentId).toBeUndefined();
 expect(nextAction(m, 4)).toMatchObject({kind:'propose', operation:'debug', parentId:'B'});
 propose(m); evaluate(m, 100, 'pass');
 expect(m.incumbentId).toBe('C1');
 expect(m.candidates[0]!.artifactHash).toBe('baseline-hash');
 expect(nextAction(m, 4).kind).toBe('propose');
});
test('same failure caps survive new candidate IDs and changed feedback', () => {
 const m = strictMission(); evaluate(m, 1, 'fail');
 for(let i=0;i<2;i++) { propose(m); const a=reserve(m); const e=receipt(m,a,1,'fail'); e.feedback='different wording '+i; acceptEvaluation(m,e,0,3); }
 expect(nextAction(m,4).kind).toBe('stop'); expect(m.ledger.roundsAdmitted).toBe(2);
});
test('strict receipt replay remains idempotent after host derives verdict',()=>{
 const m=strictMission(), a=reserve(m), e=receipt(m,a,1,'fail');
 acceptEvaluation(m,e,0,3); const before=structuredClone(m);
 acceptEvaluation(m,e,0,4); expect(m).toEqual(before);
});
test('numeric-v2 unknown correctness cannot promote or obtain an automatic repair',()=>{
 const m=strictMission(); evaluate(m,1,'unknown');
 expect(m.incumbentId).toBeUndefined(); expect(m.status).toBe('blocked');
});
test.each(['missing','duplicate','foreign'] as const)('numeric-v2 %s requirements reject without state mutation',shape=>{
 const m=strictMission(),a=reserve(m),e=receipt(m,a,1,'pass');
 e.requirements=shape==='missing'?[]:shape==='duplicate'?[...e.requirements,...e.requirements]:[{id:'foreign',verdict:'pass',evidenceIds:[]}];
 const before=structuredClone(m); expect(()=>acceptEvaluation(m,e,0,3)).toThrow(); expect(m).toEqual(before);
});
test('unavailable evidence may carry an empty observation',()=>{
 const m=mission(false),a=reserve(m),e=receipt(m,a);
 e.evidence=[{...e.evidence[0]!,id:'e6',access:'unavailable',observation:'',limitations:['URL not fetchable with provided tools']}];
 e.requirements=[{id:'K1',verdict:'unknown',evidenceIds:['e6']}];
 acceptEvaluation(m,e,0,3);
 expect(m.evaluations.at(-1)!.evidence[0]!.observation).toBe('');
 expect(m.evaluations.at(-1)!.evidence[0]!.access).toBe('unavailable');
});
test('observed evidence still requires a nonempty literal observation',()=>{
 const m=mission(false),a=reserve(m),e=receipt(m,a);
 e.evidence[0]!.observation='   ';
 const before=structuredClone(m);
 expect(()=>acceptEvaluation(m,e,0,3)).toThrow('invalid evidence source observation');
 expect(m).toEqual(before);
});
test('evidence field failures name the evidence id and field',()=>{
 const m=mission(false),a=reserve(m),e=receipt(m,a);
 e.evidence[0]!.location='';
 const before=structuredClone(m);
 expect(()=>acceptEvaluation(m,e,0,3)).toThrow('invalid evidence source location');
 expect(m).toEqual(before);
});
