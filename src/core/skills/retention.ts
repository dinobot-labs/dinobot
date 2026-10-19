import { createHash } from "node:crypto";
import { statfs } from "node:fs/promises";
import { defineDoc, defineDocFamily, ROOT_CONVERSATION_ID, type ConversationRecord, type Cursor, type Tx } from "@earendil-works/pi-durable";
import { skillEvaluationHash } from "./evaluation-contract.ts";
import {
	closeSkillRetention, publishSkillManifest, readSkillPin, skillManifestHash, skillPackageHash,
	SkillDefaultDoc, SkillManifestDoc, SkillPinDoc, SkillRetentionDoc,
	type DeploymentManifest, type ManifestPublication,
} from "./manifests.ts";
import { RetainedSkillContentDoc, retainedPackageCopy, SkillContentMigrationDoc } from "./retention-content.ts";
import type { SkillPackage } from "./store.ts";
import { readSkillsState, writeSkillsState, SkillsStorageIndexDoc } from "./storage.ts";

export class SkillLifecycleError extends Error {
	constructor(readonly code: "guard" | "evidence" | "integrity" | "conflict" | "references" | "grace" | "disabled" | "capacity" | "expired", message: string) {
		super(message); this.name = "SkillLifecycleError";
	}
}
function fail(code: SkillLifecycleError["code"], message: string): never { throw new SkillLifecycleError(code, message); }
function identifier(value: string): void {
	if (typeof value !== "string" || !value.trim() || value.length > 200) fail("integrity", "Invalid lifecycle identifier");
}
function digest(value: string): void {
	if (!/^[a-f0-9]{64}$/.test(value)) fail("integrity", "Invalid version hash");
}
function natural(value: number): void {
	if (!Number.isSafeInteger(value) || value < 0) fail("integrity", "Invalid lifecycle number");
}
export type SkillReferenceKind = "execution" | "proposal" | "evaluation" | "rollback" | "upstream" | "legal-hold";
type Reference = { id: string; kind: SkillReferenceKind; versions: string[]; expiresAt: number | null; fence: number };
export const SkillLifecycleDoc = defineDocFamily<{
	status: "active" | "inactive"; revision: number; evidenceId: string | null;
	dependencies: string[]; catalogIndex: number;
}, null>({
	kind: "dinobot.skill-retention.lifecycle", version: 1, scope: "session", family: true,
	initial: () => ({ status: "active", revision: 0, evidenceId: null, dependencies: [], catalogIndex: 0 }),
});
export const SkillVersionRetentionDoc = defineDocFamily<{
	phase: "retained" | "tombstone" | "collected"; revision: number;
	name: string | null; markedAt: number | null; collectAfter: number | null;
}, null>({
	kind: "dinobot.skill-retention.version", version: 1, scope: "session", family: true,
	initial: () => ({ phase: "retained", revision: 0, name: null, markedAt: null, collectAfter: null }),
});
export const SkillReferenceStateDoc = defineDoc<{
	epoch: number; lastNow: number; references: Reference[];
	inventoryRevision: string | null; registeredFamilies: string[];
}>({
	kind: "dinobot.skill-retention.references", version: 1, scope: "session",
	initial: () => ({ epoch: 0, lastNow: 0, references: [], inventoryRevision: null, registeredFamilies: [] }),
});
export const SkillCapacityDoc = defineDoc<{
	freeBytes: number | null; essentialReserveBytes: number; documentLimitBytes: number; measuredAt: number;
}>({
	kind: "dinobot.skill-retention.capacity", version: 1, scope: "session",
	initial: () => ({ freeBytes: null, essentialReserveBytes: 0, documentLimitBytes: 16 * 1024 * 1024, measuredAt: 0 }),
});
export const SkillLifecycleReceiptDoc = defineDocFamily<{
	fingerprint: string | null; publication: ManifestPublication | null;
}, null>({
	kind: "dinobot.skill-retention.receipt", version: 1, scope: "session", family: true,
	initial: () => ({ fingerprint: null, publication: null }),
});
export type LifecycleAuthorizationRequest = {
	readonly evidenceId: string; readonly name: string; readonly operation: "deactivate" | "reactivate";
	readonly baselineManifestHash: string; readonly candidateManifestHash: string; readonly defaultGeneration: number;
};
/** Only the trusted host publisher supplies this witness from its sealed ledger,
 * rechecking authentication, freshness, environment/policy/anchor epochs and job fence.
 * There is deliberately NO passed boolean in model/caller transition input.
 */
export type NoninferiorityAuthorization = LifecycleAuthorizationRequest & {
	readonly contractHash: string; readonly evidenceHash: string;
	readonly qualityLowerBound: number; readonly qualityLoss: number;
	readonly anchorLowerBound: number; readonly anchorLoss: number;
} & ({ readonly hypothesis: "quality" } | {
	readonly hypothesis: "efficiency";
	readonly utilityLowerBound: number; readonly utilityImprovement: number;
	/** Finite, preregistered uses and total research cost in the same utility units. */
	readonly horizonUses: number; readonly researchCostUpperBound: number;
});
export type LifecyclePreview = {
	readonly name: string; readonly operation: "deactivate" | "reactivate";
	readonly expectedRevision: number; readonly expectedDefaultGeneration: number;
};
/** Host-only reversible curation (ADR 0038): no statistical witness, no improvement claim. */
export type SkillCurationRequest = LifecyclePreview & {
	readonly requestId: string;
	/** Passed through to the publication ledger, e.g. host:curator, agent:<id>, host:skill-review. */
	readonly actor: string;
	readonly reason: string;
};
export type SkillRetentionOptions = {
	readonly now: () => number;
	readonly authorize: (tx: Tx, request: LifecycleAuthorizationRequest) => Promise<NoninferiorityAuthorization>;
	readonly protectedNames?: readonly string[];
	readonly rareRecoveryNames?: readonly string[];
	/** Explicit host opt-in for resolver-copy pruning; not SQLite page erasure. */
	readonly physicalGc?: boolean;
};
export type VersionInventory = {
	readonly version: string; readonly name: string; readonly availability: "available" | "expired";
	readonly roots: readonly { readonly kind: string; readonly id: string }[];
	readonly payloadCopies: {
		readonly resolver: number; readonly proposals: number; readonly canonicalReceipts: number;
		readonly historyMetadata: number; readonly stagedContent: number;
		readonly unmeasured: readonly string[];
	};
	readonly resolverBytes: number;
};
export type CollectionTicket = {
	readonly name: string; readonly version: string; readonly epoch: number;
	readonly revision: number; readonly collectAfter: number;
};
function keys<T>(record: Readonly<Record<string, T>>, names: readonly string[]): Record<string, T> {
	return Object.fromEntries(names.map(name => {
		const item = record[name];
		if (item === undefined) fail("integrity", "Incomplete lifecycle manifest");
		return [name, item];
	}));
}
/** Host-only service: do not expose it to author/model tools. All mutating methods
 * take the SAME Tx used by publisher/reference owner. Inventory scans run before
 * any table writes (conversation/task creation), or durable ReadAfterWrite aborts.
 */
export class SkillRetentionService {
	constructor(private readonly options: SkillRetentionOptions) {}
	private async clock(tx: Tx): Promise<number> {
		const now = this.options.now(); natural(now);
		const state = await tx.doc(SkillReferenceStateDoc);
		if (now < state.lastNow) fail("conflict", "Retention clock moved backwards");
		state.lastNow = now;
		return now;
	}
	private async advance(tx: Tx): Promise<number> {
		const state = await tx.doc(SkillReferenceStateDoc);
		if (state.epoch === Number.MAX_SAFE_INTEGER) fail("conflict", "Retention epoch exhausted");
		return ++state.epoch;
	}
	async assertAvailable(tx: Tx, name: string, version: string): Promise<void> {
		identifier(name); digest(version);
		if ((await tx.doc(SkillVersionRetentionDoc, version, null)).phase === "collected") fail("expired", "Skill content availability expired; no latest fallback");
		const skills = await readSkillsState(tx);
		const entry = skills.skills.find(item => item.name === name);
		const item = entry?.versions.find(item => item.version === version);
		const pkg = item?.package ?? skills.proposals.find(item => item.name === name && item.version === version)?.candidate;
		if (!pkg || pkg.name !== name || skillPackageHash(pkg) !== version) fail("integrity", "Missing or corrupt retained package");
	}
	/** The evaluator and final publisher derive exactly the same minus/plus target. */
	async preview(tx: Tx, input: LifecyclePreview): Promise<DeploymentManifest> {
		identifier(input.name); natural(input.expectedRevision); natural(input.expectedDefaultGeneration);
		const lifecycle = await tx.doc(SkillLifecycleDoc, input.name, null);
		if (lifecycle.revision !== input.expectedRevision) fail("conflict", "Lifecycle revision conflict");
		const state = await tx.doc(SkillDefaultDoc);
		if (!state.publication || state.publication.generation !== input.expectedDefaultGeneration) fail("conflict", "Default generation conflict");
		const baseline = (await tx.doc(SkillManifestDoc, state.publication.manifestHash, null)).manifest;
		if (!baseline || skillManifestHash(baseline) !== state.publication.manifestHash) fail("integrity", "Invalid default manifest");
		const entry = (await readSkillsState(tx)).skills.find(item => item.name === input.name);
		if (!entry) fail("integrity", "Unknown retained skill");
		await this.assertAvailable(tx, input.name, entry.head);
		let candidate: DeploymentManifest;
		switch (input.operation) {
			case "deactivate": {
				if ((this.options.protectedNames ?? ["programming", "debugging", "optimization"]).includes(input.name)) fail("guard", "Protected skill cannot be deactivated");
				if ((this.options.rareRecoveryNames ?? []).includes(input.name)) fail("guard", "Rare recovery skill requires a separate registered recovery policy");
				if (lifecycle.status !== "active" || !baseline.versions[input.name]) fail("conflict", "Skill is not active in the default");
				for (const [owner, deps] of Object.entries(baseline.dependencies)) {
					if (owner !== input.name && deps.includes(input.name)) fail("guard", "Active skill depends on deactivation target");
				}
				const catalog = baseline.catalog.filter(item => item.name !== input.name).map(item => ({ ...item }));
				const names = catalog.map(item => item.name);
				candidate = { catalog, versions: keys(baseline.versions, names), dependencies: keys(baseline.dependencies, names), routingRevision: baseline.routingRevision };
				break;
			}
			case "reactivate": {
				if (lifecycle.status !== "inactive" || baseline.versions[input.name]) fail("conflict", "Skill is not inactive");
				for (const dependency of lifecycle.dependencies) {
					if (!baseline.versions[dependency]) fail("guard", "Reactivation dependency is inactive");
				}
				const pkg = entry.versions.find(item => item.version === entry.head)?.package;
				if (!pkg) fail("integrity", "Reactivation content unavailable");
				const catalog = baseline.catalog.map(item => ({ ...item }));
				catalog.splice(Math.min(lifecycle.catalogIndex, catalog.length), 0, {
					name: entry.name, description: pkg.description, version: entry.head, generation: entry.generation,
					source: pkg.source, modified: entry.head !== entry.origin,
				});
				candidate = { catalog, versions: { ...baseline.versions, [input.name]: entry.head }, dependencies: { ...baseline.dependencies, [input.name]: [...lifecycle.dependencies] }, routingRevision: baseline.routingRevision };
				break;
			}
			default: return fail("integrity", "Unknown lifecycle operation");
		}
		skillManifestHash(candidate);
		return JSON.parse(JSON.stringify(candidate));
	}
	async transition(tx: Tx, input: LifecyclePreview & {
		readonly evidenceId: string; readonly requestId: string;
	}): Promise<ManifestPublication> {
		identifier(input.evidenceId); identifier(input.requestId);
		const fingerprint = skillEvaluationHash(input);
		const receipt = await tx.doc(SkillLifecycleReceiptDoc, input.requestId, null);
		if (receipt.publication) {
			if (receipt.fingerprint !== fingerprint) fail("conflict", "Lifecycle request ID reused");
			return { ...receipt.publication };
		}
		const candidate = await this.preview(tx, input);
		const lifecycle = await tx.doc(SkillLifecycleDoc, input.name, null);
		const state = await tx.doc(SkillDefaultDoc);
		if (!state.publication) fail("integrity", "Default publication missing");
		const baseline = (await tx.doc(SkillManifestDoc, state.publication.manifestHash, null)).manifest;
		if (!baseline) fail("integrity", "Default manifest missing");
		const entry = (await readSkillsState(tx)).skills.find(item => item.name === input.name);
		if (!entry) fail("integrity", "Unknown retained skill");
		const query: LifecycleAuthorizationRequest = {
			evidenceId: input.evidenceId, name: input.name, operation: input.operation,
			baselineManifestHash: skillManifestHash(baseline), candidateManifestHash: skillManifestHash(candidate),
			defaultGeneration: input.expectedDefaultGeneration,
		};
		const authorization = await this.options.authorize(tx, query);
		for (const field of ["evidenceId", "name", "operation", "baselineManifestHash", "candidateManifestHash", "defaultGeneration"] as const) {
			if (authorization[field] !== query[field]) fail("evidence", "Noninferiority evidence binding mismatch");
		}
		digest(authorization.contractHash); digest(authorization.evidenceHash);
		for (const value of [authorization.qualityLowerBound, authorization.qualityLoss, authorization.anchorLowerBound, authorization.anchorLoss]) {
			if (!Number.isFinite(value)) fail("evidence", "Nonfinite noninferiority bounds");
		}
		if (authorization.qualityLoss < 0 || authorization.qualityLoss > 1 || authorization.anchorLoss < 0 || authorization.anchorLoss > 1 || authorization.qualityLowerBound > 1 || authorization.anchorLowerBound > 1 || authorization.qualityLowerBound <= -authorization.qualityLoss || authorization.anchorLowerBound <= -authorization.anchorLoss) fail("evidence", "Noninferiority and anchor bounds are insufficient");
		switch (authorization.hypothesis) {
			case "quality":
				if (authorization.qualityLoss !== 0 || authorization.qualityLowerBound <= 0) fail("evidence", "Quality-improving lifecycle requires positive quality evidence");
				break;
			case "efficiency":
				if (![authorization.utilityLowerBound, authorization.utilityImprovement, authorization.horizonUses, authorization.researchCostUpperBound].every(Number.isFinite)
					|| !Number.isSafeInteger(authorization.horizonUses) || authorization.horizonUses < 1
					|| authorization.researchCostUpperBound < 0 || authorization.utilityImprovement < 0
					|| authorization.utilityLowerBound - authorization.researchCostUpperBound / authorization.horizonUses <= authorization.utilityImprovement) fail("evidence", "Finite-horizon net utility is insufficient");
				break;
			default: fail("evidence", "Unknown lifecycle hypothesis");
		}
		return this.commitTransition(tx, input, {
			candidate, baseline, lifecycle, head: entry.head, receipt, fingerprint, evidenceId: input.evidenceId,
			publicationRequestId: `lifecycle:${input.requestId}`, actor: "host:lifecycle", decision: `noninferiority:${authorization.evidenceHash}`,
		});
	}
	/** Host-only curation archive/restore. Reuses preview for every guard and the candidate
	 * manifest, then performs exactly the transition state tail, WITHOUT noninferiority
	 * authorization. Receipts use a distinct fingerprint domain, so a requestId cannot be
	 * replayed across transition and curate. Never expose this to research workers.
	 */
	async curate(tx: Tx, input: SkillCurationRequest): Promise<ManifestPublication> {
		identifier(input.requestId); identifier(input.actor);
		if (typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 4000) fail("integrity", "Invalid curation reason");
		const fingerprint = skillEvaluationHash({
			domain: "curation", name: input.name, operation: input.operation,
			expectedRevision: input.expectedRevision, expectedDefaultGeneration: input.expectedDefaultGeneration,
			requestId: input.requestId, actor: input.actor, reason: input.reason,
		});
		const receipt = await tx.doc(SkillLifecycleReceiptDoc, input.requestId, null);
		if (receipt.publication) {
			if (receipt.fingerprint !== fingerprint) fail("conflict", "Lifecycle request ID reused");
			return { ...receipt.publication };
		}
		const candidate = await this.preview(tx, input);
		const lifecycle = await tx.doc(SkillLifecycleDoc, input.name, null);
		const state = await tx.doc(SkillDefaultDoc);
		if (!state.publication) fail("integrity", "Default publication missing");
		const baseline = (await tx.doc(SkillManifestDoc, state.publication.manifestHash, null)).manifest;
		if (!baseline) fail("integrity", "Default manifest missing");
		const entry = (await readSkillsState(tx)).skills.find(item => item.name === input.name);
		if (!entry) fail("integrity", "Unknown retained skill");
		const reasonDigest = createHash("sha256").update(input.reason).digest("hex").slice(0, 16);
		return this.commitTransition(tx, input, {
			candidate, baseline, lifecycle, head: entry.head, receipt, fingerprint, evidenceId: `curation:${input.requestId}`,
			publicationRequestId: `curation:${input.requestId}`, actor: input.actor, decision: `curation:${input.operation}:${reasonDigest}`,
		});
	}
	/**
	 * Receipt-first replay for curate callers that read the CURRENT lifecycle revision on every call
	 * (explicit archive/restore). Returns the stored publication when `requestId` already committed this
	 * exact curation (same name, operation, actor and reason; the expected revision/generation it was
	 * committed at are recovered from the receipt and verified through the fingerprint). Returns
	 * undefined when the request is new; any other reuse (different input or a transition receipt) is
	 * a conflict.
	 */
	async curationReplay(tx: Tx, input: Omit<SkillCurationRequest, "expectedRevision" | "expectedDefaultGeneration">): Promise<ManifestPublication | undefined> {
		identifier(input.requestId);
		const receipt = await tx.doc(SkillLifecycleReceiptDoc, input.requestId, null);
		if (!receipt.publication) return undefined;
		const publication = receipt.publication;
		const expectedDefaultGeneration = publication.generation - 1;
		const revision = (await tx.doc(SkillLifecycleDoc, input.name, null)).revision;
		// The committed transition incremented the lifecycle revision, so it ran at some revision below the current one.
		for (let expectedRevision = revision - 1; expectedRevision >= 0; expectedRevision--) {
			const fingerprint = skillEvaluationHash({
				domain: "curation", name: input.name, operation: input.operation, expectedRevision, expectedDefaultGeneration,
				requestId: input.requestId, actor: input.actor, reason: input.reason,
			});
			if (receipt.fingerprint === fingerprint) return { ...publication };
		}
		return fail("conflict", "Lifecycle request ID reused");
	}
	/** Shared state tail of transition/curate; both paths must stay identical here. */
	private async commitTransition(tx: Tx, input: LifecyclePreview, tail: {
		readonly candidate: DeploymentManifest; readonly baseline: DeploymentManifest;
		readonly lifecycle: { status: "active" | "inactive"; revision: number; evidenceId: string | null; dependencies: string[]; catalogIndex: number };
		readonly head: string;
		readonly receipt: { fingerprint: string | null; publication: ManifestPublication | null };
		readonly fingerprint: string; readonly evidenceId: string;
		readonly publicationRequestId: string; readonly actor: string; readonly decision: string;
	}): Promise<ManifestPublication> {
		const { candidate, baseline, lifecycle, receipt, fingerprint } = tail;
		const publication = await publishSkillManifest(tx, {
			manifest: candidate, expectedGeneration: input.expectedDefaultGeneration,
			requestId: tail.publicationRequestId, actor: tail.actor, decision: tail.decision,
		});
		lifecycle.status = input.operation === "deactivate" ? "inactive" : "active";
		if (input.operation === "deactivate") {
			lifecycle.dependencies = [...(baseline.dependencies[input.name] ?? [])];
			lifecycle.catalogIndex = baseline.catalog.findIndex(item => item.name === input.name);
		}
		lifecycle.revision++;
		lifecycle.evidenceId = tail.evidenceId;
		if (input.operation === "reactivate") {
			const version = await tx.doc(SkillVersionRetentionDoc, tail.head, null);
			version.phase = "retained"; version.revision++; version.markedAt = null; version.collectAfter = null;
		}
		await this.advance(tx);
		receipt.fingerprint = fingerprint; receipt.publication = publication;
		return { ...publication };
	}
	/** Parent MUST apply this after currentSkillManifest in every source/edit/publish path. */
	async filterManifest(tx: Tx, manifest: DeploymentManifest): Promise<DeploymentManifest> {
		const catalog = [];
		for (const item of manifest.catalog) {
			if ((await tx.doc(SkillLifecycleDoc, item.name, null)).status === "active") {
				await this.assertAvailable(tx, item.name, item.version);
				catalog.push({ ...item });
			}
		}
		const names = catalog.map(item => item.name);
		const filtered = { catalog, versions: keys(manifest.versions, names), dependencies: keys(manifest.dependencies, names), routingRevision: manifest.routingRevision };
		skillManifestHash(filtered);
		return filtered;
	}
	/** Source bootstrap/import suppression wins over bundle re-import after restart. */
	async filterSourcePackages(tx: Tx, packages: readonly SkillPackage[]): Promise<SkillPackage[]> {
		const accepted: SkillPackage[] = [];
		for (const pkg of packages) {
			const version = skillPackageHash(pkg);
			const lifecycle = await tx.doc(SkillLifecycleDoc, pkg.name, null);
			const retention = await tx.doc(SkillVersionRetentionDoc, version, null);
			if (lifecycle.status === "active" && retention.phase === "retained") accepted.push(retainedPackageCopy(pkg));
		}
		return accepted;
	}
	async acquireReference(tx: Tx, input: {
		readonly id: string; readonly kind: SkillReferenceKind;
		readonly packages: readonly { readonly name: string; readonly version: string }[];
		readonly expiresAt?: number;
	}): Promise<{ readonly id: string; readonly fence: number }> {
		identifier(input.id);
		const now = await this.clock(tx);
		if (input.packages.length === 0 || input.packages.length > 2048) fail("integrity", "Invalid reference package count");
		if (input.expiresAt !== undefined) {
			natural(input.expiresAt);
			if (input.expiresAt <= now || input.kind === "legal-hold") fail("integrity", "Invalid reference expiry");
		}
		for (const pkg of input.packages) await this.assertAvailable(tx, pkg.name, pkg.version);
		const versions = [...new Set(input.packages.map(pkg => pkg.version))].sort();
		const state = await tx.doc(SkillReferenceStateDoc);
		const existing = state.references.find(ref => ref.id === input.id);
		if (existing) {
			if (existing.kind !== input.kind || existing.expiresAt !== (input.expiresAt ?? null) || JSON.stringify(existing.versions) !== JSON.stringify(versions)) fail("conflict", "Reference ID reused with different binding");
			if (existing.expiresAt !== null && existing.expiresAt <= now) fail("expired", "Expired reference requires explicit fenced release");
			return { id: existing.id, fence: existing.fence };
		}
		if (state.references.length >= 256) fail("capacity", "Retention reference index full");
		const fence = await this.advance(tx);
		state.references.push({ id: input.id, kind: input.kind, versions, expiresAt: input.expiresAt ?? null, fence });
		return { id: input.id, fence };
	}
	async releaseReference(tx: Tx, token: { readonly id: string; readonly fence: number }): Promise<void> {
		const state = await tx.doc(SkillReferenceStateDoc);
		const index = state.references.findIndex(ref => ref.id === token.id);
		if (index < 0 || state.references[index]?.fence !== token.fence) fail("conflict", "Reference release fence mismatch");
		state.references.splice(index, 1);
		await this.advance(tx);
	}
	/** Explicit host attestation AFTER all live non-enumerable snapshot/candidate/
	 * evaluator/publication-ledger roots have acquireReference registrations.
	 * Families/revision describe the covered host schema, not an author assertion.
	 * Newly installed root owners must invalidate coverage BEFORE admitting work.
	 */
	async acknowledgeRootInventory(tx: Tx, input: { readonly revision: string; readonly families: readonly string[] }): Promise<void> {
		identifier(input.revision);
		if (input.families.length > 32 || new Set(input.families).size !== input.families.length) fail("integrity", "Invalid reference inventory families");
		for (const family of input.families) identifier(family);
		const state = await tx.doc(SkillReferenceStateDoc);
		state.inventoryRevision = input.revision;
		state.registeredFamilies = [...input.families].sort();
		await this.advance(tx);
	}
	async invalidateRootInventory(tx: Tx): Promise<void> {
		const state = await tx.doc(SkillReferenceStateDoc);
		state.inventoryRevision = null;
		await this.advance(tx);
	}
	/** Call with skillConversationCreated inside the same creation transaction. */
	async pinAcquired(tx: Tx, record: ConversationRecord): Promise<void> {
		if (record.id === ROOT_CONVERSATION_ID) return;
		const { pin } = await tx.doc(SkillPinDoc, record.id);
		if (pin) {
			const manifest = (await tx.doc(SkillManifestDoc, pin.manifestHash, null)).manifest;
			if (!manifest || skillManifestHash(manifest) !== pin.manifestHash) fail("integrity", "Invalid acquired pin manifest");
			for (const item of manifest.catalog) await this.assertAvailable(tx, item.name, item.version);
		}
		await this.advance(tx);
	}
	async closeConversation(tx: Tx, id: ConversationRecord["id"]): Promise<void> {
		await closeSkillRetention(tx, id);
		await this.advance(tx);
	}
	/** Dry-run inventory includes ALL persisted conversations, not just thread index
	 * or parent-owned children. Unknown/corrupt live pins block collection.
	 */
	async inventory(tx: Tx, name: string, version: string): Promise<VersionInventory> {
		identifier(name); digest(version);
		const now = await this.clock(tx);
		const skills = await readSkillsState(tx);
		const entry = skills.skills.find(item => item.name === name);
		if (!entry) fail("integrity", "Unknown inventory skill");
		const stored = entry.versions.find(item => item.version === version);
		if (stored && skillPackageHash(stored.package) !== version) fail("integrity", "Corrupt inventory package");
		const roots: { kind: string; id: string }[] = [];
		if (!(await tx.doc(SkillReferenceStateDoc)).inventoryRevision) roots.push({ kind: "incomplete-inventory", id: "unregistered-external-reference-families" });
		if (entry.head === version) roots.push({ kind: "retained-head", id: name });
		if (entry.origin === version) roots.push({ kind: "upstream", id: name });
		const defaults = await tx.doc(SkillDefaultDoc);
		if (!defaults.legacyClassified || defaults.legacyCount > 0) roots.push({ kind: "legacy", id: "unclassified-or-resumable" });
		async function manifestContains(hash: string): Promise<boolean> {
			const manifest = (await tx.doc(SkillManifestDoc, hash, null)).manifest;
			if (!manifest || skillManifestHash(manifest) !== hash) fail("integrity", "Corrupt reference manifest");
			return Object.values(manifest.versions).includes(version);
		}
		if (defaults.publication && await manifestContains(defaults.publication.manifestHash)) roots.push({ kind: "default", id: defaults.publication.requestId });
		let cursor: Cursor | undefined;
		do {
			const page = await tx.scanConversations({}, 128, cursor);
			for (const record of page.items) {
				if (record.id === ROOT_CONVERSATION_ID) continue;
				const retention = await tx.doc(SkillRetentionDoc, record.id);
				if (retention.closed) continue;
				const { pin } = await tx.doc(SkillPinDoc, record.id);
				if (!pin) { roots.push({ kind: "legacy-conversation", id: String(record.id) }); continue; }
				await readSkillPin(tx, record.id);
				if (await manifestContains(pin.manifestHash)) roots.push({ kind: "conversation", id: String(record.id) });
			}
			cursor = page.next;
		} while (cursor);
		for (const proposal of skills.proposals) {
			if ((proposal.status === "pending" || proposal.status === "approved") && (proposal.version === version || proposal.beforeVersion === version)) roots.push({ kind: "proposal", id: proposal.proposalId });
		}
		for (const reference of (await tx.doc(SkillReferenceStateDoc)).references) {
			if ((reference.expiresAt === null || reference.expiresAt > now) && reference.versions.includes(version)) roots.push({ kind: reference.kind, id: reference.id });
		}
		const content = await tx.doc(RetainedSkillContentDoc, version, null);
		const migration = await tx.doc(SkillContentMigrationDoc);
		if (content.package && migration.phase === "staged") roots.push({ kind: "migration-staging", id: migration.sourceDigest ?? "" });
		const retention = await tx.doc(SkillVersionRetentionDoc, version, null);
		return {
			version, name, availability: retention.phase === "collected" || (!stored && !skills.proposals.some(item => item.name === name && item.version === version)) ? "expired" : "available",
			roots,
			payloadCopies: {
				resolver: stored ? 1 : 0,
				proposals: skills.proposals.filter(item => item.version === version).length,
				// Canonical request originals can contain bytes without their version hash.
				// Conservatively count ALL receipts; do not infer absence from hash search.
				canonicalReceipts: skills.receipts.length,
				historyMetadata: entry.history.filter(item => item.version === version).length,
				stagedContent: content.package ? 1 : 0,
				unmeasured: ["durable document revisions", "evaluation/fixture payloads", "transcript/search/cache copies", "backups and external copies"],
			},
			resolverBytes: stored ? Buffer.byteLength(JSON.stringify(stored.package)) : 0,
		};
	}
	async tombstone(tx: Tx, input: { readonly name: string; readonly version: string; readonly graceMs: number; readonly expectedRevision: number }): Promise<CollectionTicket> {
		natural(input.graceMs); natural(input.expectedRevision);
		await this.assertAvailable(tx, input.name, input.version);
		if ((await tx.doc(SkillLifecycleDoc, input.name, null)).status !== "inactive") fail("guard", "Deactivate skill before tombstoning content");
		const retention = await tx.doc(SkillVersionRetentionDoc, input.version, null);
		if (retention.revision !== input.expectedRevision || retention.phase !== "retained") fail("conflict", "Tombstone revision conflict");
		const now = await this.clock(tx);
		const collectAfter = now + input.graceMs; natural(collectAfter);
		retention.phase = "tombstone"; retention.name = input.name;
		retention.revision++; retention.markedAt = now; retention.collectAfter = collectAfter;
		const epoch = await this.advance(tx);
		return { name: input.name, version: input.version, epoch, revision: retention.revision, collectAfter };
	}
	/** Acquire a fresh sweep fence after grace; a ticket from mark is not authority. */
	async prepareCollection(tx: Tx, name: string, version: string): Promise<CollectionTicket> {
		const inventory = await this.inventory(tx, name, version);
		const retention = await tx.doc(SkillVersionRetentionDoc, version, null);
		const now = await this.clock(tx);
		if (retention.phase !== "tombstone" || retention.name !== name || retention.collectAfter === null || now < retention.collectAfter) fail("grace", "Tombstone grace not complete");
		if (inventory.roots.length) fail("references", "Retained version remains reachable");
		return { name, version, epoch: (await tx.doc(SkillReferenceStateDoc)).epoch, revision: retention.revision, collectAfter: retention.collectAfter };
	}
	/** Current resolver-copy collection only. Retired docs/old SQLite revisions and
	 * canonical receipts still retain bytes. No physical/privacy deletion claim.
	 */
	async collect(tx: Tx, ticket: CollectionTicket): Promise<{
		readonly kind: "resolver-pruned"; readonly availability: "expired";
		readonly privacyErasure: false; readonly diskReclaimed: false; readonly inventory: VersionInventory;
	}> {
		if (!this.options.physicalGc) fail("disabled", "Physical GC/collection is off");
		const state = await tx.doc(SkillReferenceStateDoc);
		const retention = await tx.doc(SkillVersionRetentionDoc, ticket.version, null);
		if (state.epoch !== ticket.epoch || retention.revision !== ticket.revision || retention.phase !== "tombstone" || retention.name !== ticket.name || retention.collectAfter !== ticket.collectAfter) fail("conflict", "Stale collection fence (including ABA)");
		if ((await tx.doc(SkillLifecycleDoc, ticket.name, null)).status !== "inactive") fail("guard", "Collection target reactivated");
		const now = await this.clock(tx);
		if (now < ticket.collectAfter) fail("grace", "Tombstone grace not complete");
		const inventory = await this.inventory(tx, ticket.name, ticket.version);
		if (inventory.roots.length) fail("references", "Final fenced reference recheck found roots");
		const skills = await readSkillsState(tx);
		const entry = skills.skills.find(item => item.name === ticket.name);
		if (!entry) fail("integrity", "Collection target disappeared");
		entry.versions = entry.versions.filter(item => item.version !== ticket.version);
		await writeSkillsState(tx, skills);
		// Preserve proposal/receipt/history originals and head/generation exactly.
		retention.phase = "collected"; retention.revision++;
		await this.advance(tx);
		return { kind: "resolver-pruned", availability: "expired", privacyErasure: false, diskReclaimed: false, inventory };
	}
	/** Host samples only; capacity failures stop new research, not retained execution. */
	async recordCapacity(tx: Tx, sample: { readonly freeBytes: number; readonly essentialReserveBytes: number; readonly documentLimitBytes?: number }): Promise<void> {
		natural(sample.freeBytes); natural(sample.essentialReserveBytes);
		const limit = sample.documentLimitBytes ?? 16 * 1024 * 1024; natural(limit);
		if (limit === 0 || limit > 16 * 1024 * 1024) fail("capacity", "Invalid document capacity");
		const capacity = await tx.doc(SkillCapacityDoc);
		capacity.freeBytes = sample.freeBytes; capacity.essentialReserveBytes = sample.essentialReserveBytes;
		capacity.documentLimitBytes = limit; capacity.measuredAt = await this.clock(tx);
	}
	async assertResearchCapacity(tx: Tx, additionalBytes: number): Promise<void> {
		natural(additionalBytes);
		const now = await this.clock(tx);
		const capacity = await tx.doc(SkillCapacityDoc);
		const bytes = (await tx.doc(SkillsStorageIndexDoc)).active ? 0 : Buffer.byteLength(JSON.stringify(await readSkillsState(tx)));
		if (capacity.freeBytes === null || now - capacity.measuredAt > 60_000 || capacity.freeBytes - capacity.essentialReserveBytes < additionalBytes || bytes > capacity.documentLimitBytes - additionalBytes) fail("capacity", "Research admission denied: unknown/stale/disk-full/document capacity");
	}
}
/** Host probe outside the Tx; persist and reserve admission on its single writer.
 * Filesystem free space is advisory, never a guarantee against other disk writers.
 */
export async function sampleSkillRetentionDisk(path: string): Promise<number> {
	const stats = await statfs(path, { bigint: true });
	const free = stats.bavail * stats.bsize;
	if (free > BigInt(Number.MAX_SAFE_INTEGER)) fail("capacity", "Disk capacity exceeds safe integer range");
	return Number(free);
}
