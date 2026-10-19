import type { Context } from "@earendil-works/chord";
import { EvolutionJobDoc } from "./evolution-jobs.ts";
import { readEvaluationCampaign } from "./evaluation-contract.ts";
import { skillEvaluationHash } from "./evaluation.ts";
import { immutable } from "./evaluation-schema.ts";
import type { SkillRetentionService } from "./retention.ts";
import { publicationClock, retainedPublicationManifest } from "./publication-policy.ts";
import {
	PublicationCampaignDoc, PublicationControlDoc, PublicationEvidenceDoc, PublicationRegistrationDoc, PublicationScopeDoc,
	checkPublication, publicationId, publicationTime, readPublicationBlob, writePublicationBlob,
	type PublicationPolicy, type Registration, type SkillPublicationHost, type TrustedExperiment,
} from "./publication-state.ts";

/** Host capabilities only. Never register these methods in an author/model tool registry. */
export function createPublicationControl(host: SkillPublicationHost, experiments: Map<string, TrustedExperiment>, retention: SkillRetentionService) {
	return {
		async configure(policy: PublicationPolicy, context: Context, enableOnFirstRegistration = false): Promise<void> {
			const copy = immutable(policy);
			for (const value of [copy.policyHash, copy.environmentHash, copy.anchorManifestHash]) {
				checkPublication(typeof value === "string" && /^[a-f0-9]{64}$/.test(value), "invalid", "policy hash");
			}
			checkPublication(Number.isSafeInteger(copy.anchorEpoch) && copy.anchorEpoch > 0
				&& Number.isSafeInteger(copy.maxEvidenceAgeMs) && copy.maxEvidenceAgeMs > 0, "invalid", "policy limits");
			checkPublication(Array.isArray(copy.requiredCriticalStrata), "invalid", "required critical strata");
			const strata = new Set<string>();
			for (const stratum of copy.requiredCriticalStrata) {
				publicationId(stratum.id);
				checkPublication(!strata.has(stratum.id) && Number.isFinite(stratum.qualityLoss)
					&& stratum.qualityLoss >= 0 && stratum.qualityLoss <= 1, "invalid", "required critical strata");
				strata.add(stratum.id);
			}
			await host.session.commit(async (tx) => {
				const state = await publicationClock(tx, host.now());
				const anchor = await retainedPublicationManifest(tx, copy.anchorManifestHash);
				if (anchor.catalog.length) await retention.acquireReference(tx, {
					id: `anchor:${copy.anchorManifestHash}`, kind: "evaluation",
					packages: anchor.catalog.map(({ name, version }) => ({ name, version })),
				});
				if (state.policy && skillEvaluationHash(state.policy) === skillEvaluationHash(copy)) return;
				const firstRegistration = state.policy === null;
				const nextPolicy = state.epochs.policy + 1;
				const nextEnvironment = state.epochs.environment + Number(state.policy?.environmentHash !== copy.environmentHash);
				publicationTime(nextPolicy); publicationTime(nextEnvironment);
				state.epochs.policy = nextPolicy; state.epochs.environment = nextEnvironment;
				state.policy = { ...copy, requiredCriticalStrata: copy.requiredCriticalStrata.map((stratum) => ({ ...stratum })) };
				state.enabled = firstRegistration && enableOnFirstRegistration;
			}, context);
		},
		async setEnabled(enabled: boolean, context: Context): Promise<void> {
			checkPublication(typeof enabled === "boolean", "invalid", "enabled");
			await host.session.commit(async (tx) => {
				const state = await publicationClock(tx, host.now());
				checkPublication(state.policy !== null, "disabled", "policy absent");
				if (!enabled) { publicationTime(state.epochs.kill + 1); state.epochs.kill++; }
				state.enabled = enabled;
			}, context);
		},
		async revoke(id: string, context: Context): Promise<void> {
			publicationId(id);
			await host.session.commit(async (tx) => {
				const state = await publicationClock(tx, host.now());
				const evidence = await tx.doc(PublicationEvidenceDoc, id, null);
				checkPublication(evidence.reservationJson !== null, "invalid", "unknown evidence");
				if (evidence.revoked) return;
				publicationTime(state.epochs.revoke + 1);
				evidence.revoked = true; state.epochs.revoke++;
			}, context);
		},
		async registerExperiment(experiment: TrustedExperiment, context: Context): Promise<void> {
			const metadata = immutable(experiment.registration); publicationId(metadata.id); publicationTime(metadata.expiresAt);
			for (const hash of [metadata.fixtureHash, metadata.contractHash, metadata.envelopeHash, metadata.assignmentHash]) {
				checkPublication(typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash), "invalid", "registration hash");
			}
			checkPublication(typeof experiment.verify === "function" && typeof experiment.score === "function", "authority", "host oracle");
			if (metadata.efficiency) {
				checkPublication(Number.isSafeInteger(metadata.efficiency.horizonUses) && metadata.efficiency.horizonUses > 0
					&& Number.isFinite(metadata.efficiency.researchCostUpperBound) && metadata.efficiency.researchCostUpperBound >= 0, "invalid", "finite efficiency horizon");
			}
			const previous = experiments.get(metadata.id);
			checkPublication(previous === undefined || (previous.score === experiment.score && previous.verify === experiment.verify), "conflict", "host oracle immutable");
			const trusted = Object.freeze({ registration: metadata, verify: experiment.verify, score: experiment.score });
			checkPublication(await trusted.verify() === metadata.fixtureHash, "integrity", "fixture digest");
			await host.session.commit(async (tx) => {
				const now = host.now(); const state = await publicationClock(tx, now);
				checkPublication(state.policy !== null && now < metadata.expiresAt, "stale", "registration expiry");
				const record: Registration = { ...metadata, epochs: { ...state.epochs } };
				const doc = await tx.doc(PublicationRegistrationDoc, metadata.id, null);
				if (doc.json !== null) {
					checkPublication(skillEvaluationHash(readPublicationBlob<Registration>(doc)) === skillEvaluationHash(record), "conflict", "registration immutable");
				} else writePublicationBlob(doc, record);
			}, context);
			experiments.set(metadata.id, trusted);
		},
		async registerCampaign(input: { readonly jobId: string; readonly campaign: unknown }, context: Context) {
			publicationId(input.jobId);
			const initial = readEvaluationCampaign(input.campaign);
			checkPublication(initial.reservations.length === 0, "invalid", "initial reservations");
			return host.session.commit(async (tx) => {
				await publicationClock(tx, host.now());
				const job = await tx.doc(EvolutionJobDoc, input.jobId, input.jobId);
				checkPublication(job.input !== null, "invalid", "campaign job");
				const scope = await tx.doc(PublicationScopeDoc, input.jobId, null);
				checkPublication(scope.campaignId === null || scope.campaignId === initial.id, "conflict", "campaign replenishment");
				const doc = await tx.doc(PublicationCampaignDoc, initial.id, null);
				const initialHash = skillEvaluationHash(initial);
				if (doc.json !== null) {
					checkPublication(doc.initialHash === initialHash && doc.scope === input.jobId, "conflict", "campaign immutable");
					return readEvaluationCampaign(readPublicationBlob(doc));
				}
				scope.campaignId = initial.id; doc.scope = input.jobId; doc.initialHash = initialHash;
				writePublicationBlob(doc, initial);
				return initial;
			}, context);
		},
		async status(context: Context) {
			return host.session.snapshot(PublicationControlDoc, context);
		},
	};
}
