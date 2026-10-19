import { eligible, type Mission, type ResearchState } from "./research.ts";
import type { ResearchView } from "./ui-contract.ts";
import { safeResearchText } from "./research-reports.ts";

export function researchView(mission: Mission): ResearchView {
	const displayable = (evaluation: Mission["evaluations"][number]) => mission.contract.command?.resultSchema === "research-numeric-v2" ? eligible(mission, evaluation) : evaluation.validity === "valid";
	const baseline = mission.candidates.find((candidate) => mission.basisId ? candidate.id === mission.basisId : candidate.operation === "baseline");
	const baselineEvaluation = baseline
		? mission.evaluations.find((evaluation) => evaluation.candidateId === baseline.id && displayable(evaluation))
		: undefined;
	const numeric = mission.contract.policy.kind === "numeric" ? mission.contract.policy.numeric : undefined;
	return {
		id: mission.id,
		revision: mission.revision,
		question: safeResearchText(mission.contract.question),
		status: mission.status,
		judgment: mission.judgment,
		...(mission.stopReason ? { stopReason: safeResearchText(mission.stopReason) } : {}),
		deadlineAt: mission.deadlineAt,
		attempts: { used: mission.ledger.attemptsAdmitted, limit: mission.limits.maxAttempts },
		rounds: { used: mission.ledger.roundsAdmitted, limit: mission.limits.maxRounds },
		candidateBudget: { used: mission.ledger.candidatesAdmitted, limit: mission.limits.maxCandidates },
		activeAttempts: mission.ledger.activeAttemptIds.length,
		maxConcurrent: mission.limits.maxConcurrent,
		confirmationReserved: mission.ledger.confirmationReserveRemaining,
		...(mission.incumbentId ? { incumbentId: mission.incumbentId } : {}),
		...(mission.selectedId ? { selectedId: mission.selectedId } : {}),
		candidates: mission.candidates.map((candidate) => {
			const evaluation = mission.evaluations.filter((item) => item.candidateId === candidate.id).at(-1);
			const comparable = baselineEvaluation !== undefined && evaluation !== undefined && displayable(evaluation) &&
				evaluation.environmentFingerprint === baselineEvaluation.environmentFingerprint &&
				evaluation.inputFingerprint === baselineEvaluation.inputFingerprint &&
				evaluation.evaluatorRevision === baselineEvaluation.evaluatorRevision &&
				evaluation.contractHash === baselineEvaluation.contractHash && evaluation.metric === baselineEvaluation.metric &&
				evaluation.unit === baselineEvaluation.unit;
			const value = evaluation && displayable(evaluation) ? evaluation.aggregate : undefined;
			const link = candidate.dagRefs.at(-1);
			return {
				id: candidate.id,
				...(candidate.parentId ? { parentId: candidate.parentId } : {}),
				operation: candidate.operation,
				state: candidate.state,
				hypothesis: safeResearchText(candidate.summary),
				...(value !== undefined && Number.isFinite(value) ? { value, ...(numeric ? { unit: safeResearchText(numeric.unit) } : {}) } : {}),
				...(comparable && value !== undefined && baselineEvaluation?.aggregate !== undefined
					? { delta: value - baselineEvaluation.aggregate }
					: {}),
				...(evaluation ? { validity: evaluation.validity, verdict: evaluation.verdict } : {}),
				feedback: safeResearchText(evaluation?.feedback ?? "No evaluation receipt"),
				...(link ? { runId: link.runId, nodeId: link.nodeId } : {}),
			};
		}),
		report: {
			directory: mission.report.path ?? `.dinobot/research/${mission.id}`,
			state: mission.report.state,
			writtenRevision: mission.report.writtenRevision,
			...(mission.report.error ? { error: safeResearchText(mission.report.error) } : {}),
		},
	};
}

export function activeResearchView(state: ResearchState | undefined): ResearchView | undefined {
	const mission = state?.missions.find((item) => item.id === state.activeId);
	return mission ? researchView(mission) : undefined;
}
