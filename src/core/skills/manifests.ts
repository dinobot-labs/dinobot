import { createHash } from "node:crypto";
import { defineDoc, defineDocFamily, ROOT_CONVERSATION_ID, type ConversationId, type ConversationRecord, type Cursor, type Tx } from "@earendil-works/pi-durable";
import type { SkillPackage, SkillSummary } from "./store.ts";
import { readSkillsState, readSkillVersion, readSkillSummaries, SkillStorageError } from "./storage.ts";

export type DeploymentManifest = {
	readonly catalog: readonly Readonly<SkillSummary>[];
	readonly versions: Readonly<Record<string, string>>;
	readonly dependencies: Readonly<Record<string, readonly string[]>>;
	readonly routingRevision: string;
};
// pi-durable's JSON contract is mutable; callers receive detached readonly values.
type StoredManifest = {
	catalog: SkillSummary[]; versions: Record<string, string>;
	dependencies: Record<string, string[]>; routingRevision: string;
};
export type ManifestPublication = {
	readonly requestId: string;
	readonly manifestHash: string;
	/** Session default generation, NOT a SkillStore package generation. */
	readonly generation: number;
	readonly previousRequestId: string | null;
	readonly actor: string;
	readonly decision: string;
};
export type SessionSkillPin = {
	readonly manifestHash: string;
	readonly publicationId: string;
	readonly generation: number;
};
export class SkillManifestError extends Error {
	constructor(readonly code: "integrity" | "mismatch" | "conflict" | "legacy" | "expired", message: string) {
		super(message);
		this.name = "SkillManifestError";
	}
}

// These documents are owned by this module's Tx functions. No independent DB/writer,
// telemetry arrays, pruning, or physical GC. Families bound each stored record's size.
export const SkillManifestDoc = defineDocFamily<{ manifest: StoredManifest | null }, null>({
	kind: "dinobot.skill-manifest", version: 1, scope: "session", family: true,
	initial: () => ({ manifest: null }),
});
export const SkillPublicationDoc = defineDocFamily<{ fingerprint: string | null; resultHash: string | null; publication: ManifestPublication | null }, null>({
	kind: "dinobot.skill-publication", version: 1, scope: "session", family: true,
	initial: () => ({ fingerprint: null, resultHash: null, publication: null }),
});
export const SkillDefaultDoc = defineDoc<{
	publication: ManifestPublication | null; legacyClassified: boolean; legacyCount: number;
}>({
	kind: "dinobot.skill-default", version: 1, scope: "session",
	initial: () => ({ publication: null, legacyClassified: false, legacyCount: 0 }),
});
export const SkillPinDoc = defineDoc<{ pin: SessionSkillPin | null }>({
	kind: "dinobot.skill-pin", version: 1, scope: "conversation", history: "latest", fork: "current",
	initial: () => ({ pin: null }),
});
export const SkillRetentionDoc = defineDoc<{ manifestHash: string | null; closed: boolean; legacyRegistered: boolean }>({
	kind: "dinobot.skill-retention", version: 1, scope: "conversation", history: "latest", fork: "initial",
	initial: () => ({ manifestHash: null, closed: false, legacyRegistered: false }),
});

function fail(code: SkillManifestError["code"], message: string): never { throw new SkillManifestError(code, message); }
function hash(bytes: string): string { return createHash("sha256").update(bytes).digest("hex"); }
function nonempty(value: string): void {
	if (typeof value !== "string" || !value.trim() || value.length > 1024) fail("integrity", "Invalid manifest identifier");
}
function validHash(value: string): void {
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail("integrity", "Invalid SHA-256 hash");
}
function publicationHash(publication: ManifestPublication): string {
	return hash(JSON.stringify([publication.requestId, publication.manifestHash, publication.generation, publication.previousRequestId, publication.actor, publication.decision]));
}
/** Same canonical package bytes as SkillStore, including original imported bytes. */
export function skillPackageHash(pkg: SkillPackage): string {
	if (!pkg || typeof pkg.name !== "string" || typeof pkg.description !== "string" || typeof pkg.body !== "string" || typeof pkg.source !== "string" || !pkg.files || typeof pkg.files !== "object" || Array.isArray(pkg.files) || Object.values(pkg.files).some((value) => typeof value !== "string") || (pkg.originalSkillMd !== undefined && typeof pkg.originalSkillMd !== "string")) fail("integrity", "Invalid skill package bytes");
	return hash(JSON.stringify([pkg.name, pkg.description, pkg.body, pkg.source, pkg.originalSkillMd ?? null,
		Object.keys(pkg.files).sort().map((path) => [path, pkg.files[path]])]));
}
/** Catalog order is semantic; map key and dependency edge order are not. */
export function canonicalSkillManifest(manifest: DeploymentManifest): string {
	nonempty(manifest.routingRevision);
	if (!Array.isArray(manifest.catalog) || manifest.catalog.length > 2048) fail("integrity", "Invalid catalog");
	const names = new Set<string>();
	for (const entry of manifest.catalog) {
		if (!entry || typeof entry.name !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name) || entry.name.length > 64 || names.has(entry.name)) fail("integrity", "Invalid or duplicate catalog name");
		nonempty(entry.description);
		nonempty(entry.source);
		if (!Number.isSafeInteger(entry.generation) || entry.generation < 1 || typeof entry.modified !== "boolean") fail("integrity", "Invalid catalog metadata");
		validHash(entry.version);
		names.add(entry.name);
	}
	for (const map of [manifest.versions, manifest.dependencies]) {
		if (!map || typeof map !== "object" || Array.isArray(map) || Object.keys(map).length !== names.size || Object.keys(map).some((name) => !names.has(name))) fail("integrity", "Incomplete manifest mapping");
	}
	for (const name of names) {
		validHash(manifest.versions[name] ?? "");
		const deps = manifest.dependencies[name];
		if (!Array.isArray(deps) || new Set(deps).size !== deps.length || deps.some((dep) => !names.has(dep))) fail("integrity", "Invalid dependency closure");
	}
	for (const entry of manifest.catalog) {
		if (entry.version !== manifest.versions[entry.name]) fail("integrity", "Catalog version mapping mismatch");
	}
	const visited = new Set<string>();
	const visiting = new Set<string>();
	function visit(name: string): void {
		if (visiting.has(name)) fail("integrity", "Dependency cycle");
		if (visited.has(name)) return;
		visiting.add(name);
		for (const dependency of manifest.dependencies[name] ?? []) visit(dependency);
		visiting.delete(name);
		visited.add(name);
	}
	for (const name of names) visit(name);
	const canonical = JSON.stringify([1, manifest.catalog.map((entry) => [entry.name, entry.description, entry.version, entry.source, entry.generation, entry.modified]),
		[...names].sort().map((name) => [name, manifest.versions[name], [...(manifest.dependencies[name] ?? [])].sort()]), manifest.routingRevision]);
	if (Buffer.byteLength(canonical) > 1024 * 1024) fail("integrity", "Manifest exceeds 1 MiB");
	return canonical;
}
export function skillManifestHash(manifest: DeploymentManifest): string { return hash(canonicalSkillManifest(manifest)); }
function copyManifest(manifest: DeploymentManifest): StoredManifest {
	return {
		catalog: manifest.catalog.map((entry) => ({ ...entry })),
		versions: { ...manifest.versions },
		dependencies: Object.fromEntries(Object.entries(manifest.dependencies).map(([name, deps]) => [name, [...deps]])),
		routingRevision: manifest.routingRevision,
	};
}
async function checkedManifest(tx: Tx, manifestHash: string): Promise<DeploymentManifest> {
	validHash(manifestHash);
	const { manifest } = await tx.doc(SkillManifestDoc, manifestHash, null);
	if (!manifest || skillManifestHash(manifest) !== manifestHash) fail("integrity", "Missing or corrupt skill manifest");
	for (const entry of manifest.catalog) {
		const version = manifest.versions[entry.name];
		if (!version) fail("integrity", "Missing manifest version");
		try {
			const stored = await readSkillVersion(tx, entry.name, version);
			if (stored.description !== entry.description || stored.source !== entry.source) fail("integrity", "Manifest package metadata mismatch");
		} catch (error) {
			if (error instanceof SkillStorageError) fail("integrity", error.message);
			throw error;
		}
	}
	return copyManifest(manifest);
}
/** Capture current heads after activation, within the caller's same transaction.
 * Pass explicit catalog/deps to publish when selecting an inactive subset instead.
 */
export async function currentSkillManifest(tx: Tx, routingRevision: string, dependencies: DeploymentManifest["dependencies"] = {}): Promise<DeploymentManifest> {
	const catalog = await readSkillSummaries(tx);
	const manifest: DeploymentManifest = {
		catalog, versions: Object.fromEntries(catalog.map((entry) => [entry.name, entry.version])),
		dependencies: Object.fromEntries(catalog.map((entry) => [entry.name, [...(dependencies[entry.name] ?? [])]])), routingRevision,
	};
	// Reject unknown dependency owners rather than silently ignoring their edges.
	if (Object.keys(dependencies).some((name) => !catalog.some((entry) => entry.name === name))) fail("integrity", "Unknown dependency owner");
	canonicalSkillManifest(manifest);
	return manifest;
}

/** Call on the single Harness writer before ANY catalog activation, including imports.
 * The parent must classify persisted legacy conversations before enabling the hook.
 * Resumable legacy conversations do not block publication (ADR 0037): they have no pin
 * and keep the pre-pinning live-catalog behavior, while pinned conversations stay fixed.
 */
export async function assertSkillPublicationAllowed(tx: Tx): Promise<void> {
	const state = await tx.doc(SkillDefaultDoc);
	if (!state.legacyClassified) fail("legacy", "Unclassified legacy conversations block publication");
}
/** Scan on a separate boot commit before table writes; never fabricate old pins.
 * Closed legacy records remain classified and stop counting as resumable.
 */
export async function classifyLegacySkillConversations(tx: Tx): Promise<number> {
	let cursor: Cursor | undefined;
	let count = 0;
	do {
		const page = await tx.scanConversations({}, 128, cursor);
		for (const record of page.items) {
			if (record.id === ROOT_CONVERSATION_ID) continue;
			const { pin } = await tx.doc(SkillPinDoc, record.id);
			const retention = await tx.doc(SkillRetentionDoc, record.id);
			if (!pin && !retention.closed) {
				count++;
				retention.legacyRegistered = true;
			}
			if (pin && !retention.closed) await readSkillPin(tx, record.id);
		}
		cursor = page.next;
	} while (cursor);
	const state = await tx.doc(SkillDefaultDoc);
	state.legacyClassified = true;
	state.legacyCount = count;
	return count;
}
export type PublishSkillManifest = {
	readonly manifest: DeploymentManifest; readonly expectedGeneration: number;
	readonly requestId: string; readonly actor: string; readonly decision: string;
};
/** Invoke in the SAME commit as SkillsDoc activation. Policy/evidence checks belong
 * to the parent's trusted publisher. An exception must escape to roll back the Tx.
 */
export async function publishSkillManifest(tx: Tx, input: PublishSkillManifest): Promise<ManifestPublication> {
	return publishManifest(tx, input, false);
}
/** First snapshot only, constructed internally from retained CURRENT heads. Never
 * activates a package or upgrades an existing default, even when routing changes.
 * Boot classification is mandatory; resumable legacy records may remain unpinned.
 */
export async function bootstrapSkillManifest(tx: Tx, routingRevision: string, dependencies: DeploymentManifest["dependencies"] = {}): Promise<ManifestPublication> {
	const state = await tx.doc(SkillDefaultDoc);
	if (!state.legacyClassified) fail("legacy", "Unclassified legacy conversations block bootstrap");
	if (state.publication) {
		await checkedManifest(tx, state.publication.manifestHash);
		const receipt = await tx.doc(SkillPublicationDoc, state.publication.requestId, null);
		if (!receipt.publication || receipt.resultHash !== publicationHash(state.publication) || publicationHash(receipt.publication) !== receipt.resultHash) fail("integrity", "Corrupt bootstrap publication");
		return { ...state.publication };
	}
	const manifest = await currentSkillManifest(tx, routingRevision, dependencies);
	return publishManifest(tx, {
		manifest, expectedGeneration: 0, requestId: `bootstrap:${skillManifestHash(manifest)}`,
		actor: "source", decision: "retained_heads_bootstrap",
	}, true);
}
async function publishManifest(tx: Tx, input: PublishSkillManifest, bootstrap: boolean): Promise<ManifestPublication> {
	nonempty(input.requestId); nonempty(input.actor); nonempty(input.decision);
	if (!Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 0 || input.expectedGeneration === Number.MAX_SAFE_INTEGER) fail("conflict", "Invalid publication generation");
	const canonical = canonicalSkillManifest(input.manifest);
	const manifestHash = hash(canonical);
	const fingerprint = hash(JSON.stringify([manifestHash, input.expectedGeneration, input.actor, input.decision]));
	const receipt = await tx.doc(SkillPublicationDoc, input.requestId, null);
	if (receipt.publication) {
		if (receipt.fingerprint !== fingerprint) fail("conflict", "Publication request ID reused with different input");
		if (receipt.publication.manifestHash !== manifestHash || receipt.resultHash !== publicationHash(receipt.publication)) fail("integrity", "Corrupt publication receipt");
		await checkedManifest(tx, receipt.publication.manifestHash);
		return { ...receipt.publication };
	}
	if (receipt.fingerprint !== null || receipt.resultHash !== null) fail("integrity", "Incomplete publication receipt");
	const state = await tx.doc(SkillDefaultDoc);
	if (bootstrap) {
		if (!state.legacyClassified || state.publication !== null || input.expectedGeneration !== 0) fail("legacy", "Bootstrap is restricted to the first classified snapshot");
	} else await assertSkillPublicationAllowed(tx);
	if ((state.publication?.generation ?? 0) !== input.expectedGeneration) fail("conflict", "Default publication generation conflict");
	const skills = await readSkillsState(tx);
	for (const item of input.manifest.catalog) {
		const head = skills.skills.find((entry) => entry.name === item.name);
		if (!head || head.head !== item.version || head.generation !== item.generation || (head.head !== head.origin) !== item.modified) fail("integrity", "Catalog metadata does not capture current skill head");
	}
	if (state.publication?.manifestHash === manifestHash) {
		await checkedManifest(tx, manifestHash);
		receipt.fingerprint = fingerprint;
		receipt.publication = { ...state.publication };
		receipt.resultHash = publicationHash(state.publication);
		return { ...state.publication };
	}
	const stored = await tx.doc(SkillManifestDoc, manifestHash, null);
	if (stored.manifest && canonicalSkillManifest(stored.manifest) !== canonical) fail("integrity", "Immutable manifest mismatch");
	if (!stored.manifest) stored.manifest = copyManifest(input.manifest);
	await checkedManifest(tx, manifestHash);
	const publication: ManifestPublication = {
		requestId: input.requestId, manifestHash, generation: input.expectedGeneration + 1,
		previousRequestId: state.publication?.requestId ?? null, actor: input.actor, decision: input.decision,
	};
	state.publication = publication;
	receipt.fingerprint = fingerprint;
	receipt.publication = publication;
	receipt.resultHash = publicationHash(publication);
	return { ...publication };
}
async function checkedPin(tx: Tx, id: ConversationId): Promise<{ pin: SessionSkillPin; manifest: DeploymentManifest }> {
	const { pin } = await tx.doc(SkillPinDoc, id);
	if (!pin) fail("integrity", "Conversation has no skill pin");
	const root = await tx.doc(SkillRetentionDoc, id);
	if (root.closed) fail("expired", "Conversation skill retention explicitly closed");
	if (root.manifestHash !== pin.manifestHash) fail("integrity", "Conversation retention root mismatch");
	const receipt = await tx.doc(SkillPublicationDoc, pin.publicationId, null);
	if (!Number.isSafeInteger(pin.generation) || pin.generation < 1 || !receipt.publication || !receipt.fingerprint || receipt.resultHash !== publicationHash(receipt.publication) || receipt.publication.requestId !== pin.publicationId || receipt.publication.manifestHash !== pin.manifestHash || receipt.publication.generation !== pin.generation) fail("integrity", "Conversation publication mismatch");
	return { pin: { ...pin }, manifest: await checkedManifest(tx, pin.manifestHash) };
}
export async function readSkillPin(tx: Tx, id: ConversationId): Promise<SessionSkillPin> {
	return (await checkedPin(tx, id)).pin;
}
/** Install as HarnessOptions.conversationCreated. No table reads after creation.
 * Fork copies are already present; both ancestry edges must agree when both exist.
 */
export async function skillConversationCreated(tx: Tx, record: ConversationRecord, sessionPinning = true): Promise<void> {
	if (record.id === ROOT_CONVERSATION_ID) return;
	const pinDoc = await tx.doc(SkillPinDoc, record.id);
	let inherited: SessionSkillPin | undefined;
	let inheritedLegacy = false;
	for (const source of [record.parent?.conversationId, record.owner?.conversationId]) {
		if (source === undefined) continue;
		if (!(await tx.doc(SkillPinDoc, source)).pin) {
			const root = await tx.doc(SkillRetentionDoc, source);
			if (root.closed) fail("expired", "Closed legacy parent cannot create descendants");
			if (root.manifestHash !== null || !root.legacyRegistered) fail("integrity", "Parent skill pin is missing");
			inheritedLegacy = true;
			continue;
		}
		const pin = await readSkillPin(tx, source);
		if (inherited && JSON.stringify(inherited) !== JSON.stringify(pin)) fail("mismatch", "Owner and history parent skill pins differ");
		inherited = pin;
	}
	if (inheritedLegacy && (inherited || pinDoc.pin)) fail("mismatch", "Pinned and legacy ancestry cannot be mixed");
	// Disabling new default acquisition never disables inheritance or old resolvers.
	if ((inheritedLegacy || !sessionPinning) && !inherited && !pinDoc.pin) {
		const root = await tx.doc(SkillRetentionDoc, record.id);
		if (root.closed) fail("expired", "Closed conversation cannot be registered as legacy");
		if (root.manifestHash) fail("integrity", "Unpinned conversation has a retention root");
		if (!root.legacyRegistered) {
			const defaults = await tx.doc(SkillDefaultDoc);
			if (!Number.isSafeInteger(defaults.legacyCount + 1)) fail("integrity", "Legacy count exhausted");
			defaults.legacyCount++;
			root.legacyRegistered = true;
		}
		return;
	}
	const publication = inherited ?? (await tx.doc(SkillDefaultDoc)).publication;
	if (!publication) fail("integrity", "No default skill publication");
	const selected: SessionSkillPin = inherited ?? {
		manifestHash: publication.manifestHash, publicationId: "requestId" in publication ? publication.requestId : publication.publicationId, generation: publication.generation,
	};
	if (pinDoc.pin && JSON.stringify(pinDoc.pin) !== JSON.stringify(selected)) fail("mismatch", "Immutable conversation skill pin mismatch");
	const root = await tx.doc(SkillRetentionDoc, record.id);
	if (root.closed) fail("expired", "Closed conversation cannot acquire a pin");
	if (root.manifestHash && root.manifestHash !== selected.manifestHash) fail("integrity", "Retention root mismatch");
	if (!pinDoc.pin) pinDoc.pin = selected;
	root.manifestHash = selected.manifestHash;
	await readSkillPin(tx, record.id);
}
/** Explicit terminal retention decision only; never idle/parent/worker TTL expiry.
 * Reclassification is required to unblock closed legacy records.
 */
export async function closeSkillRetention(tx: Tx, id: ConversationId): Promise<void> {
	(await tx.doc(SkillRetentionDoc, id)).closed = true;
}
export async function pinnedSkillManifest(tx: Tx, id: ConversationId): Promise<DeploymentManifest> {
	return (await checkedPin(tx, id)).manifest;
}
/** Resolve version before SkillStore inspection/load; never consult live heads. */
export async function resolvePinnedSkill(tx: Tx, id: ConversationId, name: string, explicitVersion?: string): Promise<string> {
	const manifest = await pinnedSkillManifest(tx, id);
	const version = manifest.versions[name];
	if (!version) fail("mismatch", "Skill is absent from conversation manifest");
	if (explicitVersion !== undefined && explicitVersion !== version) fail("mismatch", "Explicit skill version differs from conversation pin");
	return version;
}
