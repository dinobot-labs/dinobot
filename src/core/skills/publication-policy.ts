import type { Tx } from "@earendil-works/pi-durable";
import { EvolutionJobDoc, EvolutionQueueDoc, type EvolutionBudget } from "./evolution-jobs.ts";
import { SkillDefaultDoc, SkillManifestDoc, assertSkillPublicationAllowed, skillManifestHash, skillPackageHash, type DeploymentManifest } from "./manifests.ts";
import { readSkillsState } from "./storage.ts";
import { skillEvaluationHash } from "./evaluation.ts";
import {
	PublicationControlDoc, PublicationDatasetDoc, PublicationEvidenceDoc, PublicationRegistrationDoc, checkPublication, publicationTime, readPublicationBlob,
	type Registration, type ReservedPublication, type SealedPublication,
} from "./publication-state.ts";

const dimensions = ["calls", "tokens", "costMicros", "timeMs", "candidates"] as const;
export function publicationBudget(value: EvolutionBudget): void {
	for (const key of dimensions) checkPublication(Number.isSafeInteger(value[key]) && value[key] >= 0, "budget", key);
}
export async function publicationClock(tx: Tx, now: number) {
	publicationTime(now);
	const control = await tx.doc(PublicationControlDoc);
	checkPublication(now >= control.lastNow, "stale", "clock regression");
	control.lastNow = now;
	return control;
}
export async function retainedPublicationManifest(tx: Tx, hash: string): Promise<DeploymentManifest> {
	const { manifest } = await tx.doc(SkillManifestDoc, hash, null);
	checkPublication(manifest !== null && skillManifestHash(manifest) === hash, "integrity", "retained manifest");
	const skills = await readSkillsState(tx);
	for (const entry of manifest.catalog) {
		const version = skills.skills.find((item) => item.name === entry.name)?.versions.find((item) => item.version === entry.version);
		checkPublication(version !== undefined && skillPackageHash(version.package) === entry.version
			&& version.package.description === entry.description && version.package.source === entry.source, "integrity", "retained package");
	}
	// Tracked document proxies cannot be structured-cloned.
	return JSON.parse(JSON.stringify(manifest));
}

export async function assertPublicationJob(tx: Tx, input: {
	readonly reservation: ReservedPublication; readonly spent: EvolutionBudget; readonly final: boolean;
}, now: number): Promise<void> {
	const r = input.reservation;
	const queue = await tx.doc(EvolutionQueueDoc);
	const job = await tx.doc(EvolutionJobDoc, r.lease.jobId, r.lease.jobId);
	checkPublication(queue.policy !== null && job.input !== null, "stale", "job absent");
	checkPublication(queue.mode === "running" && queue.epoch === r.lease.epoch && job.epoch === r.lease.epoch
		&& job.fence === r.lease.fence && queue.policy.revision === job.input.policyRevision
		&& skillEvaluationHash(job.input) === r.jobInputHash, "stale", "job fence");
	publicationBudget(input.spent); publicationBudget(job.spent); publicationBudget(job.reserved);
	publicationBudget(queue.spent); publicationBudget(queue.reserved);
	publicationBudget(job.input.budget); publicationBudget(queue.policy.totalBudget);
	for (const key of dimensions) {
		const expected = r.spentBefore[key] + input.spent[key];
		checkPublication(Number.isSafeInteger(expected) && expected <= job.input.budget[key]
			&& job.spent[key] <= job.input.budget[key]
			&& Number.isSafeInteger(queue.spent[key] + queue.reserved[key])
			&& queue.spent[key] + queue.reserved[key] <= queue.policy.totalBudget[key], "budget", key);
		if (job.status === "completed") {
			checkPublication(job.spent[key] === expected, "budget", "settlement");
		} else {
			checkPublication(job.spent[key] === r.spentBefore[key] && input.spent[key] <= job.reserved[key], "budget", "reservation");
		}
	}
	if (job.status === "completed") {
		checkPublication(input.final && job.stage === "ready" && job.resultRef === r.id, "stale", "completed job evidence");
	} else {
		checkPublication(job.status === "running" && job.worker === r.lease.worker && now < job.leaseUntil
			&& (!input.final || job.stage === "ready"), "stale", "job lease");
	}
}

/** All mutable policy checks use the writer's Tx, never a preflight snapshot. */
export async function assertPublicationEligibility(tx: Tx, record: SealedPublication, now: number): Promise<void> {
	const r = record.reservation;
	const control = await publicationClock(tx, now);
	checkPublication(control.enabled && control.policy !== null, "disabled", "autoPublish");
	checkPublication(skillEvaluationHash(control.epochs) === skillEvaluationHash(r.epochs), "stale", "epochs");
	const policy = control.policy; const envelope = r.contract.spec.envelope;
	checkPublication(policy.policyHash === envelope.policyHash && policy.environmentHash === envelope.environmentHash
		&& policy.anchorManifestHash === envelope.anchorManifestHash && policy.anchorEpoch === envelope.anchorEpoch, "stale", "policy envelope");
	checkPublication(record.openedAt <= record.sealedAt && record.sealedAt <= now
		&& now - record.openedAt < policy.maxEvidenceAgeMs, "stale", "evidence age");
	const doc = await tx.doc(PublicationEvidenceDoc, r.id, null);
	checkPublication(!doc.revoked, "stale", "revoked");
	checkPublication(doc.reservationHash === skillEvaluationHash(r), "integrity", "sealed reservation binding");
	checkPublication((await tx.doc(PublicationDatasetDoc, envelope.datasetHash, null)).evidenceId === r.id, "integrity", "dataset ownership");
	const registration = readPublicationBlob<Registration>(await tx.doc(PublicationRegistrationDoc, r.registrationId, null));
	checkPublication(skillEvaluationHash(registration) === skillEvaluationHash(record.registration)
		&& registration.contractHash === r.contract.hash && registration.envelopeHash === r.contract.envelopeHash
		&& registration.assignmentHash === r.contract.assignmentHash && now < registration.expiresAt, "stale", "registration");
	const current = (await tx.doc(SkillDefaultDoc)).publication;
	checkPublication(current !== null && current.requestId === envelope.baselinePublicationId
		&& current.generation === envelope.baselineGeneration && current.manifestHash === envelope.baselineManifestHash, "stale", "baseline CAS");
	await retainedPublicationManifest(tx, envelope.baselineManifestHash);
	await retainedPublicationManifest(tx, envelope.anchorManifestHash);
	await assertSkillPublicationAllowed(tx);
	checkPublication(skillManifestHash(r.candidate) === envelope.candidateManifestHash, "integrity", "candidate manifest");
	await assertPublicationJob(tx, { reservation: r, spent: record.spent, final: true }, now);
	checkPublication(record.decision.status === "passed", "stale", "statistical decision");
}

export async function assertPublicationReservation(tx: Tx, reservation: ReservedPublication, now: number): Promise<Registration> {
	const control = await publicationClock(tx, now);
	checkPublication(control.policy !== null, "disabled", "publication policy");
	const env = reservation.contract.spec.envelope;
	checkPublication(skillEvaluationHash(control.epochs) === skillEvaluationHash(reservation.epochs)
		&& control.policy.policyHash === env.policyHash && control.policy.environmentHash === env.environmentHash
		&& control.policy.anchorManifestHash === env.anchorManifestHash && control.policy.anchorEpoch === env.anchorEpoch, "stale", "reservation policy");
	for (const required of control.policy.requiredCriticalStrata) {
		const registered = reservation.contract.spec.criticalStrata?.find((stratum) => stratum.id === required.id);
		checkPublication(registered !== undefined && registered.qualityLoss <= required.qualityLoss, "authority", "required critical stratum");
	}
	const registration = readPublicationBlob<Registration>(await tx.doc(PublicationRegistrationDoc, reservation.registrationId, null));
	checkPublication(registration.contractHash === reservation.contract.hash && registration.envelopeHash === reservation.contract.envelopeHash
		&& registration.assignmentHash === reservation.contract.assignmentHash && now < registration.expiresAt
		&& skillEvaluationHash(registration.epochs) === skillEvaluationHash(reservation.epochs), "stale", "fixture registration");
	return registration;
}
