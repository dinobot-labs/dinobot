import type { Context } from "@earendil-works/chord";
import { defineDoc, defineDocFamily, type Harness } from "@earendil-works/pi-durable";
import type { AuthoredSkillCandidate } from "./author.ts";
import type { EvolutionWorkOrder, EvolutionWorkResult } from "./evolution-jobs-task.ts";
import type { EvaluationCampaign, SealedEvaluationContract } from "./evaluation.ts";
import { registeredSkillExperimentDigest, runSkillEvaluation, type RegisteredSkillExperiment } from "./evaluation-runner.ts";
import { SkillDefaultDoc, SkillManifestDoc, SkillManifestError, skillManifestHash, type DeploymentManifest, type ManifestPublication } from "./manifests.ts";
import { createSkillPublicationService, SkillPublicationError, type PublicationPolicy, type PublicationChangeKind } from "./publication.ts";
import type { SkillStore } from "./store.ts";
import { readSkillsState, SkillStorageError } from "./storage.ts";
import { SkillLifecycleDoc, SkillLifecycleError } from "./retention.ts";

type Finalization = {
	jobId: string; evidenceId: string; status: "published" | "not-published";
	reason: string | null; publicationId: string | null;
};
export const SkillFinalizationDoc = defineDocFamily<{ result: Finalization | null }, null>({
	kind: "dinobot.skill-confirmation.finalization", version: 1, scope: "session", family: true,
	initial: () => ({ result: null }),
});
export const SkillFinalizationSummaryDoc = defineDoc<{ latest: Finalization | null }>({
	kind: "dinobot.skill-confirmation.latest", version: 1, scope: "session",
	initial: () => ({ latest: null }),
});

/** A trusted held-out task source and scorer, never an author capability. */
export interface SkillConfirmationProvider {
	readonly id: string;
	readonly environmentRevision: string;
	prepare(input: {
		readonly candidate: DeploymentManifest;
		readonly baseline: ManifestPublication;
		readonly proposalId: string;
		readonly kind: PublicationChangeKind;
		readonly hypothesis: string;
		readonly order: EvolutionWorkOrder;
	}, signal: AbortSignal, context: Context): Promise<{
		readonly contract: SealedEvaluationContract;
		readonly campaign: EvaluationCampaign;
		readonly policy: PublicationPolicy;
		readonly experiment: RegisteredSkillExperiment;
		readonly expiresAt: number;
		readonly efficiency?: { readonly horizonUses: number; readonly researchCostUpperBound: number };
	}>;
}

/** Actual author -> staged package -> isolated confirmation -> sealed evidence bridge. */
export function createSkillConfirmation(options: {
	readonly harness: () => Harness;
	readonly skills: () => SkillStore;
	readonly publication: ReturnType<typeof createSkillPublicationService>;
	readonly provider: SkillConfirmationProvider;
	readonly autoPublish: boolean;
	readonly anchorManifest: string;
	readonly lifecycleEnabled?: boolean;
}) {
	return {
		supportsLifecycle: options.lifecycleEnabled ?? false,
		async evaluate(input: {
			readonly order: EvolutionWorkOrder;
			readonly candidate: AuthoredSkillCandidate;
			readonly baselineManifest: string;
		}, signal: AbortSignal, context: Context): Promise<EvolutionWorkResult> {
			const { order, candidate } = input;
			if (candidate.operation === "no_change") return { outcome: "completed", spent: { ...order.reservation }, resultRef: `no-change:${order.lease.jobId}` };
			const baseline = await options.harness().commit(async (tx) => {
				const publication = (await tx.doc(SkillDefaultDoc)).publication;
				if (!publication || publication.manifestHash !== input.baselineManifest) throw new Error("Research baseline is stale; no automatic rebase");
				const manifest = (await tx.doc(SkillManifestDoc, publication.manifestHash, null)).manifest;
				if (!manifest || skillManifestHash(manifest) !== publication.manifestHash) throw new Error("Research baseline is corrupt");
				return {
					publication: { ...publication },
					origin: (await readSkillsState(tx)).skills.find((entry) => entry.name === candidate.name)?.origin ?? null,
					manifest: {
						catalog: manifest.catalog.map((entry) => ({ ...entry })), versions: { ...manifest.versions },
						dependencies: Object.fromEntries(Object.entries(manifest.dependencies).map(([name, deps]) => [name, [...deps]])),
						routingRevision: manifest.routingRevision,
					},
				};
			}, context);
			const current = baseline.manifest.catalog.find((entry) => entry.name === candidate.name);
			let proposalId: string;
			let manifest: DeploymentManifest;
			let kind: PublicationChangeKind = "package";
			if (candidate.operation === "deactivate" || candidate.operation === "reactivate") {
				if (!options.lifecycleEnabled) throw new Error("Lifecycle confirmation is disabled");
				kind = candidate.operation;
				const retained = await options.skills().load(candidate.name, undefined, context);
				proposalId = (await options.skills().restore({
					name: retained.name, version: retained.version, expectedGeneration: retained.generation,
					requestId: `research:${order.lease.jobId}:${order.lease.fence}`,
				}, "system:skill-author", context)).proposalId;
				const revision = await options.harness().commit(async (tx) => (await tx.doc(SkillLifecycleDoc, candidate.name, null)).revision, context);
				manifest = await options.publication.publisher.previewLifecycle({
					name: candidate.name, operation: candidate.operation, expectedRevision: revision,
					expectedDefaultGeneration: baseline.publication.generation,
				}, context);
			} else {
				if ((candidate.operation === "create") === Boolean(current)) throw new Error("Candidate operation does not match baseline identity");
				proposalId = (await options.skills().propose({
					name: candidate.name, description: candidate.description, body: candidate.body, files: candidate.files,
					expectedGeneration: current?.generation ?? 0,
					requestId: `research:${order.lease.jobId}:${order.lease.fence}`,
				}, "system:skill-author", context)).proposalId;
				const diff = await options.skills().diff(proposalId, context);
				const entry = {
					name: candidate.name, description: candidate.description, version: diff.version,
					generation: (current?.generation ?? 0) + 1, source: diff.after.source, modified: diff.version !== baseline.origin,
				};
				manifest = {
					...baseline.manifest,
					catalog: current ? baseline.manifest.catalog.map((item) => item.name === candidate.name ? entry : item) : [...baseline.manifest.catalog, entry],
					versions: { ...baseline.manifest.versions, [candidate.name]: diff.version },
					dependencies: { ...baseline.manifest.dependencies, [candidate.name]: baseline.manifest.dependencies[candidate.name] ?? [] },
				};
			}
			const prepared = await options.provider.prepare({
				candidate: manifest, baseline: baseline.publication,
				proposalId, kind, hypothesis: candidate.hypothesis, order,
			}, signal, context);
			if (prepared.contract.spec.envelope.anchorManifestHash !== options.anchorManifest ||
				prepared.policy.anchorManifestHash !== options.anchorManifest) throw new Error("Confirmation anchor differs from configured fixed anchor");
			const evidenceId = `confirmation:${order.lease.jobId}:${order.lease.fence}`;
			await options.publication.control.configure(prepared.policy, context, options.autoPublish);
			await options.publication.control.registerCampaign({ jobId: order.lease.jobId, campaign: prepared.campaign }, context);
			await options.publication.control.registerExperiment({
				registration: {
					id: evidenceId, contractHash: prepared.contract.hash,
					envelopeHash: prepared.contract.envelopeHash, assignmentHash: prepared.contract.assignmentHash,
					fixtureHash: prepared.contract.spec.envelope.datasetHash, expiresAt: prepared.expiresAt,
					...(prepared.efficiency ? { efficiency: prepared.efficiency } : {}),
				},
				verify: () => registeredSkillExperimentDigest(prepared.experiment),
				score: prepared.experiment.score,
			}, context);
			await options.publication.evaluator.reserve({
				id: evidenceId, registrationId: evidenceId, contract: prepared.contract,
				candidate: manifest, proposalId, lease: order.lease, kind,
			}, context);
			const access = await options.publication.evaluator.open(evidenceId, context);
			const result = await runSkillEvaluation({
				contract: access.contract, campaign: access.campaign, experiment: prepared.experiment, signal,
			});
			await options.publication.evaluator.seal({
				id: evidenceId, raw: result.raw, evidence: result.evidence, spent: order.reservation,
			}, context);
			return { outcome: "completed", spent: { ...order.reservation }, resultRef: evidenceId };
		},
		async finalize(order: EvolutionWorkOrder, result: EvolutionWorkResult, context: Context): Promise<void> {
			if (!options.autoPublish || result.outcome !== "completed" || !result.resultRef?.startsWith("confirmation:")) return;
			const record: Finalization = {
				jobId: order.lease.jobId, evidenceId: result.resultRef,
				status: "not-published", reason: null, publicationId: null,
			};
			try {
				// Try the exact effect receipt first: a prior successful publication
				// remains published even if recovery now observes a paused queue.
				const receipt = await options.publication.publisher.publish({
					requestId: `automatic:${order.lease.jobId}:${order.lease.fence}`,
					evidence: { kind: "evaluation", id: result.resultRef },
				}, context);
				record.status = "published";
				record.publicationId = receipt.publication.requestId;
			} catch (error) {
				if (error instanceof SkillPublicationError) record.reason = `${error.code}: ${error.field}`;
				else if (error instanceof SkillLifecycleError) record.reason = `${error.code}: ${error.message}`;
				else if (error instanceof SkillManifestError || error instanceof SkillStorageError) record.reason = `${error.code}: ${error.message}`;
				else throw error;
			}
			await options.harness().commit(async (tx) => {
				(await tx.doc(SkillFinalizationDoc, record.evidenceId, null)).result = record;
				(await tx.doc(SkillFinalizationSummaryDoc)).latest = record;
			}, context);
		},
	};
}
