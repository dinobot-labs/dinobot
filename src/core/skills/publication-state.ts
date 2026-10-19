import type { Context } from "@earendil-works/chord";
import { defineDoc, defineDocFamily, type Session } from "@earendil-works/pi-durable";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { EvaluationCampaign, EvaluationEvidence, SealedEvaluationContract } from "./evaluation.ts";
import { skillEvaluationHash, type SkillEvaluationDecision } from "./evaluation.ts";
import type { EvolutionBudget, EvolutionLease } from "./evolution-jobs.ts";
import type { DeploymentManifest, ManifestPublication } from "./manifests.ts";
import type { SkillPublication, SkillsState } from "./store.ts";
import type { SkillRetentionOptions } from "./retention.ts";

export class SkillPublicationError extends Error {
	readonly name = "SkillPublicationError";
	constructor(readonly code: "invalid" | "conflict" | "integrity" | "disabled" | "stale" | "budget" | "authority", readonly field: string) {
		super(`${code}: ${field}`);
	}
}
export function checkPublication(ok: boolean, code: SkillPublicationError["code"], field: string): asserts ok {
	if (!ok) throw new SkillPublicationError(code, field);
}
export function publicationId(value: string): void {
	checkPublication(typeof value === "string" && value.trim().length > 0 && value.length <= 200, "invalid", "id");
}
export function publicationTime(value: number): void {
	checkPublication(Number.isSafeInteger(value) && value >= 0, "invalid", "clock");
}
export type PublicationPolicy = {
	readonly policyHash: string; readonly environmentHash: string;
	readonly anchorManifestHash: string; readonly anchorEpoch: number;
	readonly maxEvidenceAgeMs: number;
	readonly requiredCriticalStrata: readonly { readonly id: string; readonly qualityLoss: number }[];
};
export type PublicationEpochs = {
	readonly policy: number; readonly environment: number; readonly kill: number; readonly revoke: number;
};
// pi-durable's tracked JSON document arrays are mutable; public policy values remain readonly.
type StoredPublicationPolicy = Omit<PublicationPolicy, "requiredCriticalStrata"> & {
	requiredCriticalStrata: { id: string; qualityLoss: number }[];
};
export const PublicationControlDoc = defineDoc<{
	policy: StoredPublicationPolicy | null; enabled: boolean; lastNow: number;
	epochs: { policy: number; environment: number; kill: number; revoke: number };
}>({
	kind: "dinobot.skill-publication.control", version: 1, scope: "session",
	initial: () => ({ policy: null, enabled: false, lastNow: 0, epochs: { policy: 0, environment: 0, kill: 0, revoke: 0 } }),
});
type Blob = { json: string | null; hash: string | null };
export const PublicationCampaignDoc = defineDocFamily<Blob & { initialHash: string | null; scope: string | null }, null>({
	kind: "dinobot.skill-publication.campaign", version: 1, scope: "session", family: true,
	initial: () => ({ json: null, hash: null, initialHash: null, scope: null }),
});
export const PublicationScopeDoc = defineDocFamily<{ campaignId: string | null }, null>({
	kind: "dinobot.skill-publication.scope", version: 1, scope: "session", family: true, initial: () => ({ campaignId: null }),
});
export const PublicationRegistrationDoc = defineDocFamily<Blob, null>({
	kind: "dinobot.skill-publication.registration", version: 1, scope: "session", family: true, initial: () => ({ json: null, hash: null }),
});
export const PublicationEvidenceDoc = defineDocFamily<Blob & {
	reservationJson: string | null; reservationHash: string | null; openedAt: number | null; revoked: boolean;
}, null>({
	kind: "dinobot.skill-publication.evidence", version: 1, scope: "session", family: true,
	initial: () => ({ json: null, hash: null, reservationJson: null, reservationHash: null, openedAt: null, revoked: false }),
});
export const PublicationDatasetDoc = defineDocFamily<{ evidenceId: string | null }, null>({
	kind: "dinobot.skill-publication.dataset", version: 1, scope: "session", family: true, initial: () => ({ evidenceId: null }),
});
export const PublicationAttemptDoc = defineDocFamily<{ evidenceId: string | null }, null>({
	kind: "dinobot.skill-publication.attempt", version: 1, scope: "session", family: true, initial: () => ({ evidenceId: null }),
});
export const PublicationReceiptDoc = defineDocFamily<Blob & { fingerprint: string | null }, null>({
	kind: "dinobot.skill-publication.receipt", version: 1, scope: "session", family: true,
	initial: () => ({ json: null, hash: null, fingerprint: null }),
});
/** Stored records are host-owned JSON, detached from Chord tracked proxies before parsing. */
export function readPublicationBlob<T>(blob: Blob): T {
	checkPublication(blob.json !== null && blob.hash !== null, "integrity", "missing record");
	const value: T = JSON.parse(blob.json);
	checkPublication(skillEvaluationHash(value) === blob.hash, "integrity", "record hash");
	return value;
}
export function writePublicationBlob(blob: Blob, value: unknown): void {
	const json = JSON.stringify(value);
	checkPublication(json !== undefined && Buffer.byteLength(json) <= 16 * 1024 * 1024, "invalid", "record size");
	blob.hash = skillEvaluationHash(value); blob.json = json;
}
export type Registration = {
	readonly id: string; readonly contractHash: string; readonly envelopeHash: string; readonly assignmentHash: string;
	readonly fixtureHash: string; readonly expiresAt: number; readonly epochs: PublicationEpochs;
	/** Total creation, failed-candidate and evaluation cost in normalized utility units. */
	readonly efficiency?: { readonly horizonUses: number; readonly researchCostUpperBound: number };
};
const rawResult = Type.Object({
	status: Type.Union([
		Type.Literal("completed"), Type.Literal("failed"), Type.Literal("cancelled"), Type.Literal("timeout"), Type.Literal("output_limit"),
	]),
	exitCode: Type.Union([Type.Integer(), Type.Null()]), stdout: Type.String(), stderr: Type.String(),
}, { additionalProperties: false });
export const RawPublicationRunsSchema = Type.Array(Type.Object({
	unitId: Type.String({ minLength: 1 }), arm: Type.Union([Type.Literal("baseline"), Type.Literal("candidate"), Type.Literal("anchor")]),
	result: rawResult,
}, { additionalProperties: false }));
export type PublicationRawRun = Static<typeof RawPublicationRunsSchema>[number];
export type TrustedExperiment = {
	readonly registration: Omit<Registration, "epochs">;
	/** Must hash the registered immutable fixtures, not return a model-supplied digest. */
	readonly verify: () => Promise<string>;
	readonly score: (run: PublicationRawRun) => {
		readonly quality: number; readonly guardsPassed: boolean;
		readonly cost?: number; readonly latency?: number;
	};
};
export function parsePublicationRaw(input: unknown): readonly PublicationRawRun[] {
	checkPublication(Value.Check(RawPublicationRunsSchema, input), "invalid", "raw runs");
	return structuredClone(input);
}
export type PackageActivation = {
	readonly proposalId: string; readonly version: string; readonly expectedGeneration: number; readonly publicationRequestId: string;
};
export type SkillPublicationHost = {
	readonly session: Pick<Session, "commit" | "snapshot">;
	readonly now: () => number;
	/** Synchronous SkillsDoc package effect ONLY: no nested commit, manifest, receipt, or external IO. */
	readonly activatePackage: (skills: SkillsState, effect: PackageActivation) => SkillPublication;
	/** Explicit host opt-in. Never expose to authors; physical collection remains off. */
	readonly lifecycle?: Pick<SkillRetentionOptions, "protectedNames" | "rareRecoveryNames">;
};
export type PublicationChangeKind = "package" | "deactivate" | "reactivate";
export type ReservePublication = {
	readonly id: string; readonly registrationId: string; readonly contract: SealedEvaluationContract;
	readonly candidate: DeploymentManifest; readonly proposalId: string; readonly lease: EvolutionLease;
	readonly kind?: PublicationChangeKind;
};
export type ReservedPublication = Omit<ReservePublication, "kind"> & {
	readonly epochs: PublicationEpochs; readonly at: number; readonly jobInputHash: string; readonly requestHash: string;
	readonly spentBefore: EvolutionBudget; readonly activation: Omit<PackageActivation, "publicationRequestId">;
} & (
	| { readonly kind: "package" }
	| { readonly kind: "deactivate" | "reactivate"; readonly lifecycle: { readonly name: string; readonly revision: number } }
);
export type SealedPublication = {
	readonly reservation: ReservedPublication; readonly registration: Registration;
	readonly openedAt: number; readonly sealedAt: number; readonly spent: EvolutionBudget;
	readonly raw: readonly PublicationRawRun[]; readonly evidence: EvaluationEvidence; readonly decision: SkillEvaluationDecision;
};
export type PublicationReceipt = {
	readonly kind: PublicationChangeKind;
	/** Package head/generation; lifecycle publication deliberately does not increment it. */
	readonly publication: ManifestPublication; readonly activation: SkillPublication;
	readonly evidenceId: string; readonly evidenceHash: string; readonly at: number;
};
export type PublicationAccess = {
	readonly contract: SealedEvaluationContract; readonly campaign: EvaluationCampaign;
	readonly registration: Registration;
};
export type PublicationContext = Context;
