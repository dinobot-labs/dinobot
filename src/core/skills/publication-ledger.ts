import type { Context } from "@earendil-works/chord";
import { EvolutionJobDoc, type EvolutionBudget } from "./evolution-jobs.ts";
import { readEvaluationCampaign, readEvaluationContract } from "./evaluation-contract.ts";
import { decideSkillEvaluation, reserveEvaluationAttempt, skillEvaluationHash, type EvaluationCampaign } from "./evaluation.ts";
import { immutable } from "./evaluation-schema.ts";
import { SkillDefaultDoc, skillManifestHash, skillPackageHash } from "./manifests.ts";
import { readSkillsState } from "./storage.ts";
import { SkillLifecycleDoc, type SkillRetentionService } from "./retention.ts";
import { assertLifecycleCandidate } from "./publication-lifecycle.ts";
import { reconstructPublicationEvidence } from "./publication-evidence.ts";
import { assertPublicationJob, assertPublicationReservation, publicationBudget, publicationClock, retainedPublicationManifest } from "./publication-policy.ts";
import {
	PublicationAttemptDoc, PublicationCampaignDoc, PublicationDatasetDoc, PublicationEvidenceDoc, checkPublication, publicationId, readPublicationBlob, writePublicationBlob,
	type PublicationAccess, type ReservedPublication, type ReservePublication, type SealedPublication, type SkillPublicationHost, type TrustedExperiment,
} from "./publication-state.ts";

const emptySpend: EvolutionBudget = { calls: 0, tokens: 0, costMicros: 0, timeMs: 0, candidates: 0 };
/** The caller must hold this evaluator capability; authors receive only publisher methods. */
export function createPublicationEvaluator(host: SkillPublicationHost, experiments: Map<string, TrustedExperiment>, lifecycle: SkillRetentionService) {
	async function trusted(id: string): Promise<TrustedExperiment> {
		const experiment = experiments.get(id);
		checkPublication(experiment !== undefined, "authority", "registered host evaluator absent");
		checkPublication(await experiment.verify() === experiment.registration.fixtureHash, "integrity", "fixture changed");
		return experiment;
	}
	return {
		async reserve(input: ReservePublication, context: Context): Promise<ReservedPublication> {
			const copy = immutable({ ...input, kind: input.kind ?? "package" }); publicationId(copy.id); publicationId(copy.registrationId); publicationId(copy.proposalId);
			checkPublication(copy.kind === "package" || copy.kind === "deactivate" || copy.kind === "reactivate", "invalid", "publication change kind");
			const contract = readEvaluationContract(copy.contract);
			checkPublication(skillManifestHash(copy.candidate) === contract.spec.envelope.candidateManifestHash, "integrity", "candidate hash");
			return host.session.commit(async (tx) => {
				const doc = await tx.doc(PublicationEvidenceDoc, copy.id, null);
				const requestHash = skillEvaluationHash(copy);
				if (doc.reservationJson !== null) {
					const old = readPublicationBlob<ReservedPublication>({ json: doc.reservationJson, hash: doc.reservationHash });
					checkPublication(old.requestHash === requestHash, "conflict", "reservation ID");
					return immutable(old);
				}
				checkPublication(copy.kind === "package" || host.lifecycle !== undefined, "disabled", "lifecycle publication");
				const now = host.now(); const state = await publicationClock(tx, now);
				const job = await tx.doc(EvolutionJobDoc, copy.lease.jobId, copy.lease.jobId);
				checkPublication(job.input !== null, "stale", "job absent");
				const proposal = (await readSkillsState(tx)).proposals.find((item) => item.proposalId === copy.proposalId);
				checkPublication(proposal !== undefined && proposal.status === "approved"
					&& skillPackageHash(proposal.candidate) === proposal.version
					&& (copy.kind === "deactivate" ? copy.candidate.versions[proposal.name] === undefined
						: copy.candidate.versions[proposal.name] === proposal.version), "integrity", "candidate proposal");
				const reservation: ReservedPublication = {
					...copy, contract, epochs: { ...state.epochs }, at: now, requestHash,
					jobInputHash: skillEvaluationHash(job.input), spentBefore: { ...job.spent },
					activation: { proposalId: proposal.proposalId, version: proposal.version, expectedGeneration: proposal.expectedGeneration },
					...(copy.kind === "package" ? { kind: "package" as const } : {
						kind: copy.kind, lifecycle: { name: proposal.name, revision: (await tx.doc(SkillLifecycleDoc, proposal.name, null)).revision },
					}),
				};
				const registration = await assertPublicationReservation(tx, reservation, now);
				await assertLifecycleCandidate(tx, reservation, lifecycle);
				if (reservation.kind !== "package" && contract.spec.hypothesis.kind === "efficiency") checkPublication(registration.efficiency !== undefined, "authority", "finite lifecycle efficiency registration");
				await assertPublicationJob(tx, { reservation, spent: emptySpend, final: false }, now);
				const env = contract.spec.envelope; const current = (await tx.doc(SkillDefaultDoc)).publication;
				checkPublication(current !== null && current.manifestHash === env.baselineManifestHash
					&& current.requestId === env.baselinePublicationId && current.generation === env.baselineGeneration, "stale", "baseline");
				const baseline = await retainedPublicationManifest(tx, env.baselineManifestHash);
				const anchor = await retainedPublicationManifest(tx, env.anchorManifestHash);
				const packages = new Map([...baseline.catalog, ...anchor.catalog, ...copy.candidate.catalog]
					.map(({ name, version }) => [version, { name, version }]));
				await lifecycle.acquireReference(tx, {
					id: `evaluation:${skillEvaluationHash(copy.id)}`, kind: "evaluation", packages: [...packages.values()],
				});
				const campaignDoc = await tx.doc(PublicationCampaignDoc, contract.spec.campaignId, null);
				checkPublication(campaignDoc.scope === copy.lease.jobId, "authority", "campaign scope");
				const attempt = await tx.doc(PublicationAttemptDoc, skillEvaluationHash([contract.spec.campaignId, contract.spec.attemptId]), null);
				checkPublication(attempt.evidenceId === null || attempt.evidenceId === copy.id, "conflict", "attempt evidence identity");
				const ledger = reserveEvaluationAttempt(readPublicationBlob(campaignDoc), contract);
				writePublicationBlob(campaignDoc, ledger);
				attempt.evidenceId = copy.id;
				const blob = { json: null, hash: null } satisfies { json: string | null; hash: string | null };
				writePublicationBlob(blob, reservation);
				doc.reservationJson = blob.json; doc.reservationHash = blob.hash;
				return immutable(reservation);
			}, context);
		},
		async open(id: string, context: Context): Promise<PublicationAccess> {
			publicationId(id);
			const snapshot = await host.session.snapshot(PublicationEvidenceDoc, id, context);
			checkPublication(snapshot !== undefined, "invalid", "reservation absent");
			const reserved = readPublicationBlob<ReservedPublication>({ json: snapshot.reservationJson, hash: snapshot.reservationHash });
			await trusted(reserved.registrationId);
			return host.session.commit(async (tx) => {
				const now = host.now(); const doc = await tx.doc(PublicationEvidenceDoc, id, null);
				const reservation = readPublicationBlob<ReservedPublication>({ json: doc.reservationJson, hash: doc.reservationHash });
				checkPublication(doc.openedAt === null && !doc.revoked, "conflict", "confirmation access consumed");
				const registration = await assertPublicationReservation(tx, reservation, now);
				await assertPublicationJob(tx, { reservation, spent: emptySpend, final: false }, now);
				const dataset = await tx.doc(PublicationDatasetDoc, reservation.contract.spec.envelope.datasetHash, null);
				checkPublication(dataset.evidenceId === null, "conflict", "confirmation dataset consumed");
				const campaign = readEvaluationCampaign(readPublicationBlob(await tx.doc(PublicationCampaignDoc, reservation.contract.spec.campaignId, null)));
				// Reservation was already committed; no data ticket is returned before its durable burn.
				dataset.evidenceId = id; doc.openedAt = now;
				return immutable({ contract: reservation.contract, campaign, registration });
			}, context);
		},
		async seal(input: { readonly id: string; readonly raw: unknown; readonly evidence: unknown; readonly spent: EvolutionBudget }, context: Context): Promise<SealedPublication> {
			const copy = immutable(input); publicationId(copy.id); publicationBudget(copy.spent);
			const snapshot = await host.session.snapshot(PublicationEvidenceDoc, copy.id, context);
			checkPublication(snapshot !== undefined, "invalid", "reservation absent");
			const reservation = readPublicationBlob<ReservedPublication>({ json: snapshot.reservationJson, hash: snapshot.reservationHash });
			const experiment = await trusted(reservation.registrationId);
			const reconstructed = reconstructPublicationEvidence({ contract: reservation.contract, raw: copy.raw, evidence: copy.evidence, experiment });
			return host.session.commit(async (tx) => {
				const now = host.now(); const doc = await tx.doc(PublicationEvidenceDoc, copy.id, null);
				if (doc.json !== null) {
					const old = readPublicationBlob<SealedPublication>(doc);
					checkPublication(skillEvaluationHash([old.raw, old.evidence, old.spent]) === skillEvaluationHash([reconstructed.raw, reconstructed.evidence, copy.spent]), "conflict", "sealed evidence immutable");
					return immutable(old);
				}
				checkPublication(doc.openedAt !== null && !doc.revoked, "authority", "confirmation not opened");
				checkPublication(doc.reservationHash === skillEvaluationHash(reservation), "integrity", "reservation changed");
				const registration = await assertPublicationReservation(tx, reservation, now);
				await assertPublicationJob(tx, { reservation, spent: copy.spent, final: false }, now);
				const campaign: EvaluationCampaign = readEvaluationCampaign(readPublicationBlob(await tx.doc(PublicationCampaignDoc, reservation.contract.spec.campaignId, null)));
				const decision = decideSkillEvaluation(reservation.contract, reconstructed.evidence, campaign);
				checkPublication(decision.status !== "invalid", "integrity", "raw decision invalid");
				const record: SealedPublication = {
					reservation, registration, openedAt: doc.openedAt, sealedAt: now, spent: copy.spent, ...reconstructed, decision,
				};
				writePublicationBlob(doc, record);
				return immutable(record);
			}, context);
		},
	};
}
