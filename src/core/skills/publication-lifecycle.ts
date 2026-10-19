import type { Tx } from "@earendil-works/pi-durable";
import { decideSkillEvaluation, skillEvaluationHash } from "./evaluation.ts";
import { readEvaluationCampaign } from "./evaluation-contract.ts";
import { skillManifestHash } from "./manifests.ts";
import { SkillLifecycleDoc, SkillRetentionService, type NoninferiorityAuthorization } from "./retention.ts";
import { readSkillsState } from "./storage.ts";
import { assertPublicationEligibility } from "./publication-policy.ts";
import {
	PublicationCampaignDoc, PublicationEvidenceDoc, checkPublication, readPublicationBlob,
	type ReservedPublication, type SealedPublication, type SkillPublicationHost,
} from "./publication-state.ts";

export function assertLifecycleNetUtility(record: SealedPublication): void {
	const hypothesis = record.reservation.contract.spec.hypothesis;
	if (hypothesis.kind === "quality") return;
	const efficiency = record.registration.efficiency;
	checkPublication(efficiency !== undefined, "authority", "registered lifecycle efficiency");
	checkPublication(record.decision.status === "passed", "stale", "lifecycle statistical decision");
	const utility = record.decision.gates.find(gate => gate.endpoint === "utility");
	checkPublication(utility !== undefined && Number.isFinite(utility.lower)
		&& Number.isSafeInteger(efficiency.horizonUses) && efficiency.horizonUses > 0
		&& Number.isFinite(efficiency.researchCostUpperBound) && efficiency.researchCostUpperBound >= 0
		&& utility.lower - efficiency.researchCostUpperBound / efficiency.horizonUses > hypothesis.utilityImprovement, "stale", "finite-horizon net utility");
}

/** No caller-supplied passed flag or manual actor can create this authorization. */
export function createPublicationLifecycle(host: SkillPublicationHost): SkillRetentionService {
	const service: SkillRetentionService = new SkillRetentionService({
		...host.lifecycle, now: host.now, physicalGc: false,
		authorize: async (tx, request): Promise<NoninferiorityAuthorization> => {
			checkPublication(host.lifecycle !== undefined, "disabled", "lifecycle publication");
			const doc = await tx.doc(PublicationEvidenceDoc, request.evidenceId, null);
			const record = readPublicationBlob<SealedPublication>(doc);
			await assertPublicationEligibility(tx, record, host.now());
			const r = record.reservation;
			checkPublication(r.kind !== "package" && r.kind === request.operation
				&& r.lifecycle.name === request.name && r.id === request.evidenceId
				&& r.contract.spec.envelope.baselineManifestHash === request.baselineManifestHash
				&& r.contract.spec.envelope.candidateManifestHash === request.candidateManifestHash
				&& r.contract.spec.envelope.baselineGeneration === request.defaultGeneration, "integrity", "lifecycle evidence binding");
			await assertLifecycleCandidate(tx, r, service);
			const campaign = readEvaluationCampaign(readPublicationBlob(await tx.doc(PublicationCampaignDoc, r.contract.spec.campaignId, null)));
			const decision = decideSkillEvaluation(r.contract, record.evidence, campaign);
			checkPublication(decision.status === "passed"
				&& skillEvaluationHash(decision) === skillEvaluationHash(record.decision)
				&& skillEvaluationHash(record.raw) === record.evidence.rawEvidenceHash, "integrity", "lifecycle sealed decision");
			const hypothesis = r.contract.spec.hypothesis;
			const quality = decision.gates.find(gate => gate.endpoint === "quality");
			const anchor = decision.gates.find(gate => gate.endpoint === "anchor");
			checkPublication(quality !== undefined && anchor !== undefined && doc.hash !== null, "integrity", "lifecycle gates");
			const common = {
				...request, contractHash: r.contract.hash, evidenceHash: doc.hash,
				qualityLowerBound: quality.lower,
				anchorLowerBound: anchor.lower, anchorLoss: r.contract.spec.anchorLoss,
			};
			switch (hypothesis.kind) {
				case "quality": return { ...common, hypothesis: "quality", qualityLoss: 0 };
				case "efficiency": {
					const efficiency = record.registration.efficiency;
					const utility = decision.gates.find(gate => gate.endpoint === "utility");
					checkPublication(efficiency !== undefined && utility !== undefined, "authority", "registered lifecycle efficiency");
					assertLifecycleNetUtility(record);
					return { ...common, hypothesis: "efficiency", qualityLoss: hypothesis.qualityLoss,
						utilityLowerBound: utility.lower, utilityImprovement: hypothesis.utilityImprovement, ...efficiency };
				}
			}
		},
	});
	return service;
}

/** Re-run under the publication Tx, including lifecycle revision and exact minus/plus manifest. */
export async function assertLifecycleCandidate(
	tx: Tx, reservation: ReservedPublication, service: SkillRetentionService | undefined,
): Promise<void> {
	const proposal = (await readSkillsState(tx)).proposals.find(item => item.proposalId === reservation.proposalId);
	checkPublication(proposal !== undefined, "integrity", "lifecycle proposal");
	switch (reservation.kind) {
		case "package":
			checkPublication((await tx.doc(SkillLifecycleDoc, proposal.name, null)).status === "active", "authority", "inactive package requires evaluated reactivation");
			return;
		case "deactivate":
		case "reactivate": {
			checkPublication(service !== undefined, "disabled", "lifecycle publication");
			const entry = (await readSkillsState(tx)).skills.find(item => item.name === proposal.name);
			checkPublication(proposal.status === "approved" && proposal.name === reservation.lifecycle.name && entry !== undefined
				&& entry.head === proposal.version && entry.generation === reservation.activation.expectedGeneration, "stale", "lifecycle retained target");
			const candidate = await service.preview(tx, {
				name: reservation.lifecycle.name, operation: reservation.kind,
				expectedRevision: reservation.lifecycle.revision,
				expectedDefaultGeneration: reservation.contract.spec.envelope.baselineGeneration,
			});
			checkPublication(skillManifestHash(candidate) === skillManifestHash(reservation.candidate), "integrity", "exact lifecycle candidate");
			return;
		}
		default: {
			const unknown: never = reservation;
			checkPublication(false, "integrity", `unknown lifecycle reservation: ${String(unknown)}`);
		}
	}
}
