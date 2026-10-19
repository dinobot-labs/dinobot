import type { Context } from "@earendil-works/chord";
import { defineDoc, defineDocFamily, type Harness, type Tx } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { skillEvaluationHash } from "./evaluation-contract.ts";
import { skillPackageHash } from "./manifests.ts";
import type { SkillPackage, SkillProposal, SkillsState, SkillSummary, SkillUsage } from "./store.ts";

export class SkillStorageError extends Error {
	constructor(readonly code: "integrity" | "capacity" | "conflict" | "stale-snapshot", message: string) {
		super(message); this.name = "SkillStorageError";
	}
}
const DOCUMENT_LIMIT = 16 * 1024 * 1024;
const INDEX_LIMIT = 256 * 1024;
const ARCHIVE_LIMIT = DOCUMENT_LIMIT + 1024;
const strict = { additionalProperties: false } as const;
const string = Type.String();
const natural = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const usage = Type.Object({ loads: natural, verified: natural, blocked: natural }, strict);
const evidence = Type.Union([
	Type.Object({ kind: Type.Literal("receipts"), conversationId: string, ids: Type.Array(string) }, strict),
	Type.Object({ kind: Type.Literal("instruction"), conversationId: string, quote: string, entryId: Type.Optional(natural), userId: Type.Optional(string) }, strict),
	Type.Object({ kind: Type.Literal("regression"), version: string, usage: Type.Object({ from: usage, to: usage }, strict) }, strict),
]);
const packageSchema = Type.Object({
	name: string, description: string, body: string, files: Type.Record(string, string),
	source: string, originalSkillMd: Type.Optional(string),
}, strict);
const publication = { name: string, generation: natural, version: hash };
const history = Type.Object({
	...publication, actor: string,
	operation: Type.Union([Type.Literal("initialize"), Type.Literal("upstream"), Type.Literal("edit"), Type.Literal("restore"), Type.Literal("regression")]),
	proposalId: Type.Union([string, Type.Null()]), evidence: Type.Optional(evidence),
}, strict);
const metadataSchema = Type.Object({
	name: string, head: hash, generation: natural, origin: Type.Union([hash, Type.Null()]),
	versions: Type.Array(hash), history: Type.Array(history),
}, strict);
const proposalSchema = Type.Object({
	proposalId: string, name: string, actor: string,
	operation: Type.Union([Type.Literal("edit"), Type.Literal("restore"), Type.Literal("upstream")]),
	expectedGeneration: natural, beforeVersion: Type.Union([hash, Type.Null()]), version: hash,
	candidate: packageSchema,
	status: Type.Union([Type.Literal("pending"), Type.Literal("approved"), Type.Literal("rejected"), Type.Literal("published")]),
	evidence: Type.Optional(evidence),
	approval: Type.Union([Type.Object({ actor: string, proposalId: string, version: hash, expectedGeneration: natural }, strict), Type.Null()]),
	rejectedBy: Type.Union([string, Type.Null()]),
}, strict);
const proposalMetadataSchema = Type.Omit(proposalSchema, ["candidate"]);
const receiptSchema = Type.Object({
	requestId: string, canonical: string,
	result: Type.Union([Type.Object({ proposalId: string }, strict), Type.Object(publication, strict)]),
}, strict);
const stateSchema = Type.Object({
	skills: Type.Array(Type.Object({
		name: string, head: hash, generation: natural, origin: Type.Union([hash, Type.Null()]),
		versions: Type.Array(Type.Object({ version: hash, package: packageSchema }, strict)), history: Type.Array(history),
	}, strict)),
	proposals: Type.Array(proposalSchema), receipts: Type.Array(receiptSchema),
	usage: Type.Optional(Type.Record(string, usage)),
	loaded: Type.Optional(Type.Record(string, Type.Array(string))),
}, strict);
type SkillMetadata = Omit<SkillsState["skills"][number], "versions"> & { versions: string[] };
type ProposalMetadata = Omit<SkillProposal, "candidate">;
type Receipt = SkillsState["receipts"][number];
function fail(code: SkillStorageError["code"], message: string): never { throw new SkillStorageError(code, message); }
function digest(value: unknown): string { return skillEvaluationHash(value); }
function capacity(value: unknown, limit = DOCUMENT_LIMIT): void {
	if (Buffer.byteLength(JSON.stringify(value)) > limit) fail("capacity", `Skill storage document exceeds ${limit} bytes`);
}
function emptyState(): SkillsState { return { skills: [], proposals: [], receipts: [], usage: {}, loaded: {} }; }
function distinct(values: readonly string[], label: string): void {
	if (new Set(values).size !== values.length || values.some(value => !value.trim())) fail("integrity", `Duplicate or empty ${label}`);
}
function packageCopy(pkg: SkillPackage): SkillPackage {
	return { name: pkg.name, description: pkg.description, body: pkg.body, files: { ...pkg.files }, source: pkg.source,
		...(pkg.originalSkillMd === undefined ? {} : { originalSkillMd: pkg.originalSkillMd }) };
}
/** Boundary parsing also detaches tracked proxies and caller-owned nested objects. */
function parseState(input: unknown): SkillsState {
	const value: unknown = JSON.parse(JSON.stringify(input));
	if (!Value.Check(stateSchema, value)) fail("integrity", "Invalid SkillsState shape");
	distinct(value.skills.map(item => item.name), "skill names");
	distinct(value.proposals.map(item => item.proposalId), "proposal IDs");
	distinct(value.receipts.map(item => item.requestId), "receipt IDs");
	for (const entry of value.skills) {
		distinct(entry.versions.map(item => item.version), "skill version refs");
		if (!entry.versions.some(item => item.version === entry.head)) fail("integrity", "Skill head has no retained package");
		for (const item of entry.versions) {
			if (item.package.name !== entry.name || skillPackageHash(item.package) !== item.version) fail("integrity", "Skill version hash/bytes mismatch");
		}
	}
	for (const proposal of value.proposals) {
		if (proposal.name !== proposal.candidate.name || skillPackageHash(proposal.candidate) !== proposal.version) fail("integrity", "Proposal version hash/bytes mismatch");
	}
	return value;
}
// Separate v1 token avoids a runtime import cycle when SkillStore uses the facade.
// Its storage address and initial state exactly match the existing SkillsDoc.
const LegacySkillsStateDoc = defineDoc<SkillsState>({
	kind: "dinobot.skills", version: 1, scope: "session", initial: emptyState,
});
type Archive = { format: "split-archive-v2"; archive: SkillsState; archiveHash: string };
function archiveOf(input: unknown): Archive {
	const archive = parseState(input);
	const value: Archive = { format: "split-archive-v2", archive, archiveHash: digest(archive) };
	capacity(value, ARCHIVE_LIMIT);
	return value;
}
/** Same kind, version 2: old binaries' v1 access is rejected by pi-durable.
 * This is a STATIC archive, not privacy erasure or physical space reclamation.
 */
export const SkillsStorageArchiveDoc = defineDoc<Archive>({
	kind: "dinobot.skills", version: 2, scope: "session",
	initial: () => archiveOf(emptyState()),
	migrate: (value, fromVersion) => {
		if (fromVersion !== 1) fail("integrity", "Unsupported legacy skills version");
		return archiveOf(value);
	},
});
type Index = {
	active: boolean; archiveHash: string | null; checksum: string | null;
	skills: string[]; proposals: string[]; receipts: string[];
	usageKeys: string[]; loadedKeys: string[]; hasUsage: boolean; hasLoaded: boolean;
};
export const SkillsStorageIndexDoc = defineDoc<Index>({
	kind: "dinobot.skills.split-index", version: 1, scope: "session",
	initial: () => ({
		active: false, archiveHash: null, checksum: null, skills: [], proposals: [], receipts: [],
		usageKeys: [], loadedKeys: [], hasUsage: false, hasLoaded: false,
	}),
});
export const SkillPackageStorageDoc = defineDocFamily<{ package: SkillPackage | null }, null>({
	kind: "dinobot.skills.package", version: 1, scope: "session", family: true, initial: () => ({ package: null }),
});
export const SkillMetadataStorageDoc = defineDocFamily<{ metadata: SkillMetadata | null; checksum: string | null }, null>({
	kind: "dinobot.skills.metadata", version: 1, scope: "session", family: true, initial: () => ({ metadata: null, checksum: null }),
});
export const SkillProposalStorageDoc = defineDocFamily<{ proposal: ProposalMetadata | null; checksum: string | null }, null>({
	kind: "dinobot.skills.proposal", version: 1, scope: "session", family: true, initial: () => ({ proposal: null, checksum: null }),
});
export const SkillReceiptStorageDoc = defineDocFamily<{ receipt: Receipt | null; checksum: string | null }, null>({
	kind: "dinobot.skills.receipt", version: 1, scope: "session", family: true, initial: () => ({ receipt: null, checksum: null }),
});
export const SkillUsageStorageDoc = defineDocFamily<{ usage: SkillUsage | null; checksum: string | null }, null>({
	kind: "dinobot.skills.usage", version: 1, scope: "session", family: true, initial: () => ({ usage: null, checksum: null }),
});
export const SkillLoadedStorageDoc = defineDocFamily<{ versions: string[] | null; checksum: string | null }, null>({
	kind: "dinobot.skills.loaded", version: 1, scope: "session", family: true, initial: () => ({ versions: null, checksum: null }),
});
function indexHash(index: Omit<Index, "checksum">): string { return digest(index); }
function checkedIndex(index: Index): void {
	const { checksum, ...body } = index;
	if (!index.active || !index.archiveHash || !Value.Check(hash, index.archiveHash) || checksum !== indexHash(body)) fail("integrity", "Missing or corrupt active split index");
	for (const keys of [index.skills, index.proposals, index.receipts, index.usageKeys, index.loadedKeys]) distinct(keys, "split index keys");
	capacity(index, INDEX_LIMIT);
}
async function readPackage(tx: Tx, version: string): Promise<SkillPackage> {
	const { package: pkg } = await tx.doc(SkillPackageStorageDoc, version, null);
	if (!pkg || !Value.Check(packageSchema, pkg) || skillPackageHash(pkg) !== version) fail("integrity", "Missing or corrupt split package; archive fallback forbidden");
	return packageCopy(pkg);
}
async function putPackage(tx: Tx, version: string, pkg: SkillPackage): Promise<void> {
	if (skillPackageHash(pkg) !== version) fail("integrity", "Immutable split package hash mismatch");
	const content = await tx.doc(SkillPackageStorageDoc, version, null);
	if (content.package) {
		if (!Value.Check(packageSchema, content.package) || skillPackageHash(content.package) !== version || digest(content.package) !== digest(pkg)) fail("integrity", "Corrupt or conflicting immutable split package");
	} else content.package = packageCopy(pkg);
	capacity(content);
}
/** Hot execution path: authenticate only the requested retained package and index,
 * never hydrate proposal bodies, historical receipts, or unrelated skill versions.
 */
export async function readSkillVersion(tx: Tx, name: string, version: string): Promise<SkillPackage> {
	const index = await tx.doc(SkillsStorageIndexDoc);
	if (!index.active) {
		const state = parseState(await tx.doc(LegacySkillsStateDoc));
		const found = state.skills.find((entry) => entry.name === name)?.versions.find((item) => item.version === version);
		if (!found) fail("integrity", "Missing retained skill version");
		return packageCopy(found.package);
	}
	checkedIndex(index);
	if (!index.skills.includes(name)) fail("integrity", "Skill is absent from split index");
	const doc = await tx.doc(SkillMetadataStorageDoc, name, null);
	if (!doc.metadata || !Value.Check(metadataSchema, doc.metadata) || doc.metadata.name !== name ||
		doc.checksum !== digest(doc.metadata) || !doc.metadata.versions.includes(version)) fail("integrity", "Missing or corrupt retained skill metadata");
	const pkg = await readPackage(tx, version);
	if (pkg.name !== name) fail("integrity", "Retained package identity mismatch");
	return pkg;
}
export async function readSkillSummaries(tx: Tx): Promise<SkillSummary[]> {
	const index = await tx.doc(SkillsStorageIndexDoc);
	if (!index.active) {
		const state = parseState(await tx.doc(LegacySkillsStateDoc));
		return state.skills.map((entry) => {
			const pkg = entry.versions.find((item) => item.version === entry.head)?.package;
			if (!pkg) fail("integrity", "Missing skill head");
			return { name: entry.name, description: pkg.description, version: entry.head, generation: entry.generation, source: pkg.source, modified: entry.head !== entry.origin };
		});
	}
	checkedIndex(index);
	const summaries: SkillSummary[] = [];
	for (const name of index.skills) {
		const doc = await tx.doc(SkillMetadataStorageDoc, name, null);
		const entry = doc.metadata;
		if (!entry || !Value.Check(metadataSchema, entry) || entry.name !== name || doc.checksum !== digest(entry) || !entry.versions.includes(entry.head)) fail("integrity", "Invalid skill head metadata");
		const pkg = await readPackage(tx, entry.head);
		if (pkg.name !== name) fail("integrity", "Head package identity mismatch");
		summaries.push({ name, description: pkg.description, version: entry.head, generation: entry.generation, source: pkg.source, modified: entry.head !== entry.origin });
	}
	return summaries;
}
/** Detached state in both modes. A mutation MUST call writeSkillsState in the
 * SAME Tx before any subsequent facade-backed read (e.g. manifest construction).
 * Before migration, storage remains the original v1 SkillsDoc.
 */
export async function readSkillsState(tx: Tx): Promise<SkillsState> {
	const index = await tx.doc(SkillsStorageIndexDoc);
	if (!index.active) return parseState(await tx.doc(LegacySkillsStateDoc));
	checkedIndex(index);
	const state: SkillsState = { skills: [], proposals: [], receipts: [] };
	for (const name of index.skills) {
		const doc = await tx.doc(SkillMetadataStorageDoc, name, null);
		if (!doc.metadata || !Value.Check(metadataSchema, doc.metadata) || doc.metadata.name !== name || doc.checksum !== digest(doc.metadata)) fail("integrity", "Missing or corrupt split skill metadata");
		const { versions, ...metadata } = doc.metadata;
		const packages: SkillsState["skills"][number]["versions"] = [];
		for (const version of versions) packages.push({ version, package: await readPackage(tx, version) });
		state.skills.push({ ...metadata, history: [...metadata.history], versions: packages });
	}
	for (const id of index.proposals) {
		const doc = await tx.doc(SkillProposalStorageDoc, id, null);
		if (!doc.proposal || !Value.Check(proposalMetadataSchema, doc.proposal) || doc.proposal.proposalId !== id || doc.checksum !== digest(doc.proposal)) fail("integrity", "Missing or corrupt split proposal");
		state.proposals.push({ ...doc.proposal, candidate: await readPackage(tx, doc.proposal.version) });
	}
	for (const id of index.receipts) {
		const doc = await tx.doc(SkillReceiptStorageDoc, id, null);
		if (!doc.receipt || !Value.Check(receiptSchema, doc.receipt) || doc.receipt.requestId !== id || doc.checksum !== digest(doc.receipt)) fail("integrity", "Missing or corrupt split receipt");
		state.receipts.push({ ...doc.receipt });
	}
	if (index.hasUsage) {
		const pairs: [string, SkillUsage][] = [];
		for (const key of index.usageKeys) {
			const doc = await tx.doc(SkillUsageStorageDoc, key, null);
			if (!doc.usage || !Value.Check(usage, doc.usage) || doc.checksum !== digest(doc.usage)) fail("integrity", "Missing or corrupt split usage");
			pairs.push([key, { ...doc.usage }]);
		}
		state.usage = Object.fromEntries(pairs);
	}
	if (index.hasLoaded) {
		const pairs: [string, string[]][] = [];
		for (const key of index.loadedKeys) {
			const doc = await tx.doc(SkillLoadedStorageDoc, key, null);
			if (!doc.versions || !Array.isArray(doc.versions) || doc.versions.some(version => typeof version !== "string") || doc.checksum !== digest(doc.versions)) fail("integrity", "Missing or corrupt split loaded references");
			pairs.push([key, [...doc.versions]]);
		}
		state.loaded = Object.fromEntries(pairs);
	}
	return parseState(state);
}
async function writeSplitState(tx: Tx, state: SkillsState, archiveHash: string): Promise<void> {
	const index = await tx.doc(SkillsStorageIndexDoc);
	if (index.active) {
		checkedIndex(index);
		// Never repair a broken active graph implicitly from the caller's state copy.
		// New writes first authenticate every currently indexed document.
		await readSkillsState(tx);
		for (const id of index.receipts) {
			if (!state.receipts.some(item => item.requestId === id)) fail("conflict", "Existing canonical receipts cannot be dropped");
		}
	}
	for (const entry of state.skills) {
		for (const item of entry.versions) await putPackage(tx, item.version, item.package);
		const metadata: SkillMetadata = { ...entry, versions: entry.versions.map(item => item.version) };
		const doc = await tx.doc(SkillMetadataStorageDoc, entry.name, null);
		if (doc.metadata && doc.checksum !== digest(doc.metadata)) fail("integrity", "Corrupt split metadata cannot be overwritten");
		doc.metadata = metadata; doc.checksum = digest(metadata); capacity(doc);
	}
	for (const proposal of state.proposals) {
		await putPackage(tx, proposal.version, proposal.candidate);
		const { candidate: _candidate, ...metadata } = proposal;
		const doc = await tx.doc(SkillProposalStorageDoc, proposal.proposalId, null);
		if (doc.proposal && doc.checksum !== digest(doc.proposal)) fail("integrity", "Corrupt split proposal cannot be overwritten");
		doc.proposal = metadata; doc.checksum = digest(metadata); capacity(doc);
	}
	for (const receipt of state.receipts) {
		const doc = await tx.doc(SkillReceiptStorageDoc, receipt.requestId, null);
		if (doc.receipt && (doc.checksum !== digest(doc.receipt) || digest(doc.receipt) !== digest(receipt))) fail("conflict", "Immutable canonical receipt ID reused");
		doc.receipt = receipt; doc.checksum = digest(receipt); capacity(doc);
	}
	for (const [key, value] of Object.entries(state.usage ?? {})) {
		const doc = await tx.doc(SkillUsageStorageDoc, key, null);
		if (doc.usage && doc.checksum !== digest(doc.usage)) fail("integrity", "Corrupt split usage cannot be overwritten");
		doc.usage = { ...value }; doc.checksum = digest(value); capacity(doc);
	}
	for (const [key, value] of Object.entries(state.loaded ?? {})) {
		const doc = await tx.doc(SkillLoadedStorageDoc, key, null);
		if (doc.versions && doc.checksum !== digest(doc.versions)) fail("integrity", "Corrupt split loaded refs cannot be overwritten");
		doc.versions = [...value]; doc.checksum = digest(value); capacity(doc);
	}
	const body: Omit<Index, "checksum"> = {
		active: true, archiveHash,
		skills: state.skills.map(item => item.name), proposals: state.proposals.map(item => item.proposalId),
		receipts: state.receipts.map(item => item.requestId),
		usageKeys: Object.keys(state.usage ?? {}), loadedKeys: Object.keys(state.loaded ?? {}),
		hasUsage: state.usage !== undefined, hasLoaded: state.loaded !== undefined,
	};
	const value: Index = { ...body, checksum: indexHash(body) };
	capacity(value, INDEX_LIMIT);
	Object.assign(index, value);
}
export async function writeSkillsState(tx: Tx, input: SkillsState): Promise<void> {
	const state = parseState(input);
	const index = await tx.doc(SkillsStorageIndexDoc);
	if (!index.active) {
		capacity(state);
		const legacy = await tx.doc(LegacySkillsStateDoc);
		Object.assign(legacy, state);
		if (state.usage === undefined) delete legacy.usage;
		if (state.loaded === undefined) delete legacy.loaded;
		return;
	}
	checkedIndex(index);
	// Never acquire/write the v2 archive after cutover. All mutations land in families.
	await writeSplitState(tx, state, index.archiveHash ?? fail("integrity", "Split archive hash missing"));
}
export type SkillsStorageMigrationResult = {
	readonly migrated: boolean; readonly archiveHash: string;
	readonly skillCount: number; readonly proposalCount: number; readonly receiptCount: number;
};
function migrationResult(state: SkillsState, archiveHash: string, migrated: boolean): SkillsStorageMigrationResult {
	return { migrated, archiveHash, skillCount: state.skills.length, proposalCount: state.proposals.length, receiptCount: state.receipts.length };
}
/** Snapshot MUST be captured with the typed v1 token OUTSIDE this transaction.
 * Never read different token versions at one address inside the same Tx.
 * Exported for host migration composition/failure injection; stale means rollback.
 */
export async function commitSkillsStorageMigration(tx: Tx, capturedSnapshot: SkillsState): Promise<SkillsStorageMigrationResult> {
	const snapshot = parseState(capturedSnapshot);
	const index = await tx.doc(SkillsStorageIndexDoc);
	if (index.active) {
		const state = await readSkillsState(tx);
		return migrationResult(state, index.archiveHash ?? fail("integrity", "Missing archive digest"), false);
	}
	const marker = await tx.doc(SkillsStorageArchiveDoc);
	const archive = parseState(marker.archive);
	if (marker.format !== "split-archive-v2" || marker.archiveHash !== digest(archive)) fail("integrity", "Corrupt version-two skills archive");
	if (marker.archiveHash !== digest(snapshot)) fail("stale-snapshot", "Legacy skills changed after migration snapshot");
	await writeSplitState(tx, archive, marker.archiveHash);
	const roundtrip = await readSkillsState(tx);
	if (digest(roundtrip) !== marker.archiveHash) fail("integrity", "Split migration roundtrip differs from archived canonical state");
	return migrationResult(roundtrip, marker.archiveHash, true);
}
/** Actual atomic cutover, not duplicate staging. Concurrent v1 writes cause a fresh
 * typed snapshot and retry. Cancellation/storage failure propagates; no busy polling.
 */
export async function migrateSkillsStorage(harness: Harness, context: Context): Promise<SkillsStorageMigrationResult> {
	while (true) {
		context.abortSignal?.throwIfAborted();
		const index = await harness.snapshot(SkillsStorageIndexDoc, context);
		if (index?.active) {
			return harness.commit(async tx => {
				const state = await readSkillsState(tx);
				return migrationResult(state, index.archiveHash ?? fail("integrity", "Missing archive digest"), false);
			}, context);
		}
		let snapshot: SkillsState;
		try {
			snapshot = parseState(await harness.snapshot(LegacySkillsStateDoc, context) ?? emptyState());
		} catch (error) {
			// Another migrator may atomically seal v1 between these two snapshots.
			if ((await harness.snapshot(SkillsStorageIndexDoc, context))?.active) continue;
			throw error;
		}
		try {
			return await harness.commit(tx => commitSkillsStorageMigration(tx, snapshot), context);
		} catch (error) {
			if (error instanceof SkillStorageError && error.code === "stale-snapshot") continue;
			throw error;
		}
	}
}
