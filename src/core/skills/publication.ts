import type { Context } from "@earendil-works/chord";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { decideSkillEvaluation, skillEvaluationHash } from "./evaluation.ts";
import { readEvaluationCampaign } from "./evaluation-contract.ts";
import { immutable } from "./evaluation-schema.ts";
import { publishSkillManifest, skillPackageHash } from "./manifests.ts";
import type { SkillsState } from "./store.ts";
import { readSkillsState, writeSkillsState } from "./storage.ts";
import { createPublicationControl } from "./publication-control.ts";
import { createPublicationEvaluator } from "./publication-ledger.ts";
import { assertPublicationEligibility } from "./publication-policy.ts";
import { assertLifecycleCandidate, assertLifecycleNetUtility, createPublicationLifecycle } from "./publication-lifecycle.ts";
import { SkillLifecycleError, type LifecyclePreview } from "./retention.ts";
import {
	PublicationCampaignDoc, PublicationEvidenceDoc, PublicationReceiptDoc, SkillPublicationError,
	checkPublication, publicationId, readPublicationBlob, writePublicationBlob,
	type PublicationReceipt, type SealedPublication, type SkillPublicationHost, type TrustedExperiment,
} from "./publication-state.ts";
export { SkillPublicationError } from "./publication-state.ts";
export type {
	PackageActivation, PublicationAccess, PublicationChangeKind, PublicationPolicy, PublicationRawRun, PublicationReceipt,
	ReservePublication, ReservedPublication, SealedPublication, SkillPublicationHost, TrustedExperiment,
} from "./publication-state.ts";

const id = Type.String({ minLength: 1, maxLength: 200, pattern: "\\S" });
const requestSchema = Type.Object({
	requestId: id,
	evidence: Type.Object({ kind: Type.Literal("evaluation"), id }, { additionalProperties: false }),
}, { additionalProperties: false });

function unrelatedState(state: SkillsState, name: string, proposalId: string): unknown {
	return {
		...state,
		skills: state.skills.filter((entry) => entry.name !== name),
		proposals: state.proposals.filter((proposal) => proposal.proposalId !== proposalId),
	};
}

/**
 * Host-only constructor. Keep control/evaluator capabilities away from authors; publisher accepts
 * only a sealed evaluation reference, never passed, work receipts, instructions, raw scores or actors.
 * Auto-publication starts disabled. This factory neither registers tools nor activates packages.
 */
export function createSkillPublicationService(host: SkillPublicationHost) {
	const experiments = new Map<string, TrustedExperiment>();
	const lifecycle = createPublicationLifecycle(host);
	const control = createPublicationControl(host, experiments, lifecycle);
	const evaluator = createPublicationEvaluator(host, experiments, lifecycle);
	const publisher = {
		async previewLifecycle(input: LifecyclePreview, context: Context) {
			checkPublication(host.lifecycle !== undefined, "disabled", "lifecycle publication");
			return host.session.commit(tx => lifecycle.preview(tx, input), context);
		},
		async preflight(evidenceId: string, context: Context) {
			publicationId(evidenceId);
			return host.session.commit(async (tx) => {
				const doc = await tx.doc(PublicationEvidenceDoc, evidenceId, null);
				const record = readPublicationBlob<SealedPublication>(doc);
				try {
					await assertPublicationEligibility(tx, record, host.now());
					await assertLifecycleCandidate(tx, record.reservation, host.lifecycle ? lifecycle : undefined);
					if (record.reservation.kind !== "package") assertLifecycleNetUtility(record);
					return immutable({ decision: record.decision, eligible: true, reason: null, evidenceHash: doc.hash });
				} catch (error) {
					if (error instanceof SkillPublicationError) return immutable({ decision: record.decision, eligible: false, reason: { code: error.code, field: error.field }, evidenceHash: doc.hash });
					if (error instanceof SkillLifecycleError) return immutable({ decision: record.decision, eligible: false, reason: { code: error.code, field: error.message }, evidenceHash: doc.hash });
					throw error;
				}
			}, context);
		},
		async publish(input: unknown, context: Context): Promise<PublicationReceipt> {
			checkPublication(Value.Check(requestSchema, input), "authority", "sealed evaluation reference required");
			const request = immutable(input);
			const fingerprint = skillEvaluationHash(request);
			return host.session.commit(async (tx) => {
				const receiptDoc = await tx.doc(PublicationReceiptDoc, request.requestId, null);
				// Replay is historical, even after kill/revoke/new default; it has no activation effect.
				if (receiptDoc.json !== null) {
					checkPublication(receiptDoc.fingerprint === fingerprint, "conflict", "publication request reused");
					return immutable(readPublicationBlob<PublicationReceipt>(receiptDoc));
				}
				checkPublication(receiptDoc.fingerprint === null && receiptDoc.hash === null, "integrity", "incomplete receipt");
				const evidenceDoc = await tx.doc(PublicationEvidenceDoc, request.evidence.id, null);
				const record = readPublicationBlob<SealedPublication>(evidenceDoc);
				const now = host.now();
				await assertPublicationEligibility(tx, record, now);
				const r = record.reservation;
				await assertLifecycleCandidate(tx, r, host.lifecycle ? lifecycle : undefined);
				const campaign = readEvaluationCampaign(readPublicationBlob(await tx.doc(PublicationCampaignDoc, r.contract.spec.campaignId, null)));
				const decision = decideSkillEvaluation(r.contract, record.evidence, campaign);
				checkPublication(skillEvaluationHash(record.raw) === record.evidence.rawEvidenceHash
					&& skillEvaluationHash(decision) === skillEvaluationHash(record.decision) && decision.status === "passed", "integrity", "sealed decision");
				const skills = await readSkillsState(tx);
				const before: SkillsState = JSON.parse(JSON.stringify(skills));
				const proposal = before.proposals.find((item) => item.proposalId === r.activation.proposalId);
				checkPublication(proposal !== undefined && proposal.status === "approved"
					&& proposal.version === r.activation.version && proposal.expectedGeneration === r.activation.expectedGeneration
					&& skillPackageHash(proposal.candidate) === proposal.version, "integrity", "exact proposal");
				const prior = before.skills.find((entry) => entry.name === proposal.name);
				checkPublication((prior?.generation ?? 0) === r.activation.expectedGeneration, "stale", "package CAS");
				const publicationRequestId = `evaluation:${request.requestId}`;
				if (r.kind !== "package") {
					checkPublication(host.lifecycle !== undefined && prior !== undefined, "disabled", "lifecycle publication");
					const publication = await lifecycle.transition(tx, {
						name: r.lifecycle.name, operation: r.kind, expectedRevision: r.lifecycle.revision,
						expectedDefaultGeneration: r.contract.spec.envelope.baselineGeneration,
						evidenceId: r.id, requestId: publicationRequestId,
					});
					const staged = skills.proposals.find(item => item.proposalId === proposal.proposalId);
					checkPublication(staged !== undefined && evidenceDoc.hash !== null, "integrity", "lifecycle receipt");
					staged.status = "published";
					await writeSkillsState(tx, skills);
					const receipt: PublicationReceipt = {
						kind: r.kind, publication, activation: { name: prior.name, version: prior.head, generation: prior.generation },
						evidenceId: request.evidence.id, evidenceHash: evidenceDoc.hash, at: now,
					};
					writePublicationBlob(receiptDoc, receipt); receiptDoc.fingerprint = fingerprint;
					return immutable(receipt);
				}
				const activation = host.activatePackage(skills, { ...r.activation, publicationRequestId });
				const current = skills.skills.find((entry) => entry.name === proposal.name);
				const afterProposal = skills.proposals.find((item) => item.proposalId === proposal.proposalId);
				checkPublication(current !== undefined && afterProposal?.status === "published"
					&& current.head === proposal.version && current.generation === r.activation.expectedGeneration + 1
					&& activation.name === current.name && activation.version === current.head && activation.generation === current.generation,
				"integrity", "real package activation required");
				checkPublication(skillEvaluationHash(unrelatedState(before, proposal.name, proposal.proposalId))
					=== skillEvaluationHash(unrelatedState(skills, proposal.name, proposal.proposalId)), "integrity", "unrelated package effect");
				const { status: oldStatus, evidence: oldEvidence, ...oldProposal } = proposal;
				const { status: newStatus, evidence: newEvidence, ...newProposal } = afterProposal;
				checkPublication(skillEvaluationHash(oldProposal) === skillEvaluationHash(newProposal), "integrity", "proposal mutation");
				checkPublication(current.origin === (prior?.origin ?? null)
					&& current.history.length === (prior?.history.length ?? 0) + 1
					&& skillEvaluationHash(current.history.slice(0, -1)) === skillEvaluationHash(prior?.history ?? [])
					&& current.history.at(-1)?.proposalId === proposal.proposalId, "integrity", "activation history");
				for (const version of prior?.versions ?? []) {
					checkPublication(skillEvaluationHash(current.versions.find((item) => item.version === version.version)) === skillEvaluationHash(version), "integrity", "retained package changed");
				}
				await writeSkillsState(tx, skills);
				const publication = await publishSkillManifest(tx, {
					manifest: r.candidate, expectedGeneration: r.contract.spec.envelope.baselineGeneration,
					requestId: publicationRequestId, actor: "system:skill-evaluation", decision: `statistical:${request.evidence.id}`,
				});
				checkPublication(evidenceDoc.hash !== null, "integrity", "evidence hash");
				const receipt: PublicationReceipt = { kind: "package", publication, activation, evidenceId: request.evidence.id, evidenceHash: evidenceDoc.hash, at: now };
				writePublicationBlob(receiptDoc, receipt); receiptDoc.fingerprint = fingerprint;
				return immutable(receipt);
			}, context);
		},
	};
	// Host-only retention capability remains available while transitions are disabled,
	// so restart/source imports and new manifests still honor persisted suppression.
	return Object.freeze({ control: Object.freeze(control), evaluator: Object.freeze(evaluator), publisher: Object.freeze(publisher), lifecycle });
}
