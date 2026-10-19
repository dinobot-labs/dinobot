import { createHash, randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { type ConversationId, type Cursor, defineDoc, type Harness, ROOT_CONVERSATION_ID, type Tx } from "@earendil-works/pi-durable";
import { classifyLegacySkillConversations, currentSkillManifest, pinnedSkillManifest, publishSkillManifest, SkillDefaultDoc, SkillPinDoc, SkillRetentionDoc } from "./manifests.ts";
import { findHumanMessage } from "../ask.ts";
import { RunDoc } from "../dag.ts";
import { EvidenceDoc } from "../verification.ts";
import type { PackageActivation } from "./publication.ts";
import { readSkillsState, writeSkillsState, readSkillVersion, readSkillSummaries, SkillsStorageIndexDoc } from "./storage.ts";
import { SkillRetentionService } from "./retention.ts";
import { markSkillActivation, recordSkillUse } from "./curation.ts";

export type SkillPackage = {
	name: string; description: string; body: string; files: Record<string, string>; source: string;
	/** Lossless imported bytes, never rewritten or agent-controlled. */
	originalSkillMd?: string;
};
export type SkillSummary = { name: string; description: string; generation: number; version: string; source: string; modified: boolean };
export type SkillEdit = { name: string; description: string; body: string; files: Record<string, string>; expectedGeneration: number; requestId: string };
export type SkillRestore = { name: string; version: string; expectedGeneration: number; requestId: string };
export type SkillPublication = { name: string; generation: number; version: string };
type Version = { version: string; package: SkillPackage };
export type SkillHistory = SkillPublication & { actor: string; operation: "initialize" | "upstream" | "edit" | "restore" | "regression"; proposalId: string | null; evidence?: SkillEvidence };
/**
 * Why an agent may publish (ADR 0030 decision 3). `receipts` cites passed verification attempts or
 * verified DAG runs of the publishing conversation; `instruction` cites the human message that asked
 * for the change. Both are checked against durable records, never trusted from the model's text.
 */
export type SkillEvidence =
	| { kind: "receipts"; conversationId: string; ids: string[] }
	| { kind: "instruction"; conversationId: string; quote: string; entryId?: number; userId?: string }
	| { kind: "regression"; version: string; usage: { from: SkillUsage; to: SkillUsage } };
export type SkillStoreOptions = {
	/** Actors whose cited publish evidence is checked against durable records; default none. Evidence stays optional (ADR 0037). */
	evidenceChecked?: (actor: string) => boolean;
	/** Bot runtime uses a default manifest and preserves every existing conversation pin. */
	managedManifests?: boolean;
	retention?: SkillRetentionService;
	/** Clock for curation activation marks and usage records; default Date.now. */
	now?: () => number;
};
type RecordEntry = { name: string; head: string; generation: number; origin: string | null; versions: Version[]; history: SkillHistory[] };
export type SkillProposal = {
	proposalId: string; name: string; actor: string; operation: "edit" | "restore" | "upstream";
	expectedGeneration: number; beforeVersion: string | null; version: string; candidate: SkillPackage;
	status: "pending" | "approved" | "rejected" | "published";
	evidence?: SkillEvidence;
	approval: { actor: string; proposalId: string; version: string; expectedGeneration: number } | null;
	rejectedBy: string | null;
};
export type SkillDiff = SkillProposal & { before: SkillPackage | null; after: SkillPackage };
type Receipt = { requestId: string; canonical: string; result: { proposalId: string } | SkillPublication };
/** Episode outcomes attributed to a skill version: loads, and the verified/blocked results of conversations that loaded it. */
export type SkillUsage = { loads: number; verified: number; blocked: number };
export type SkillsState = {
	skills: RecordEntry[]; proposals: SkillProposal[]; receipts: Receipt[];
	usage?: Record<string, SkillUsage>;
	/** conversationId → versions it loaded and has not yet been scored for. */
	loaded?: Record<string, string[]>;
};
export const SkillsDoc = defineDoc<SkillsState>({
	kind: "dinobot.skills", version: 1, scope: "session",
	initial: () => ({ skills: [], proposals: [], receipts: [], usage: {}, loaded: {} }),
});
export type SkillOutcome = "verified" | "blocked";
export type SkillRegression = { name: string; from: string; to: string; evidence: SkillEvidence; usage: { from: SkillUsage; to: SkillUsage } };

/** Minimum scored episodes before a version can be judged; two failures are the minimum signal. */
export const REGRESSION_MIN_EPISODES = 3;
export const REGRESSION_MIN_BLOCKED = 2;
/** Laplace-smoothed success rate: the posterior mean of a Beta(1,1) prior, so unseen versions sit at 1/2. */
export function successRate(u: SkillUsage): number { return (u.verified + 1) / (u.verified + u.blocked + 2); }
/**
 * Regression test between an agent-evolved version `v` and its predecessor `u` (Agentic Routing: promote only
 * on measured frontier movement). `v` regresses when it has enough episodes, enough failures, and a lower
 * smoothed rate than `u`. Monotone in blocked_v and verified_u; never fires below the minimums.
 */
export function regressed(v: SkillUsage, u: SkillUsage): boolean {
	const n = v.verified + v.blocked;
	return n >= REGRESSION_MIN_EPISODES && v.blocked >= REGRESSION_MIN_BLOCKED && successRate(v) < successRate(u);
}

const FILE_LIMIT = 256 * 1024;
const PACKAGE_LIMIT = 1024 * 1024;
const DOCUMENT_LIMIT = 16 * 1024 * 1024;
// Transaction documents are tracked proxies; JSON copying also detaches their nested values.
const clone = <T>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
function nonempty(value: string, label: string): void {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be non-empty`);
}
function nameValid(name: string): void {
	if (typeof name !== "string" || name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error("Invalid skill name");
}
function pathValid(path: string): void {
	if (typeof path === "string" && path.length > 512) throw new Error("Companion path exceeds 512 characters");
	if (typeof path === "string" && path.split("/").some((part) => ["__proto__", "constructor", "prototype"].includes(part))) throw new Error("Unsafe companion record key");
	if (typeof path !== "string" || !path || /[\\\x00-\x1f\x7f:<>"|?*]/.test(path) || path.split("/").some((part) => !part || part === "." || part === ".." || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) || path.split("/").some((part) => part.toLowerCase() === "skill.md")) throw new Error("Invalid companion path (SKILL.md is reserved)");
}
function canonical(pkg: SkillPackage): string {
	return JSON.stringify([pkg.name, pkg.description, pkg.body, pkg.source, pkg.originalSkillMd ?? null, Object.keys(pkg.files).sort().map((path) => [path, pkg.files[path]])]);
}
function validate(pkg: SkillPackage): void {
	nameValid(pkg.name);
	nonempty(pkg.description, "Description");
	if (pkg.description.length > 1024) throw new Error("Description exceeds 1024 characters");
	nonempty(pkg.body, "Body"); nonempty(pkg.source, "Source");
	if (Buffer.byteLength(pkg.body) > FILE_LIMIT) throw new Error("Body exceeds 256 KiB");
	if (!pkg.files || typeof pkg.files !== "object" || Array.isArray(pkg.files) || Object.keys(pkg.files).length > 128) throw new Error("Invalid files (maximum 128)");
	let bytes = Buffer.byteLength(pkg.name) + Buffer.byteLength(pkg.description) + Buffer.byteLength(pkg.body) + Buffer.byteLength(pkg.source);
	if (pkg.originalSkillMd !== undefined) {
		if (typeof pkg.originalSkillMd !== "string" || Buffer.byteLength(pkg.originalSkillMd) > FILE_LIMIT) throw new Error("Original SKILL.md exceeds 256 KiB");
		bytes += Buffer.byteLength(pkg.originalSkillMd);
	}
	const portable = new Set<string>();
	for (const [path, content] of Object.entries(pkg.files)) {
		pathValid(path);
		if (portable.has(path.toLowerCase())) throw new Error("Case-colliding companion paths");
		portable.add(path.toLowerCase());
		if (typeof content !== "string" || Buffer.byteLength(content) > FILE_LIMIT) throw new Error("Companion exceeds 256 KiB");
		bytes += Buffer.byteLength(path) + Buffer.byteLength(content);
	}
	for (const path of portable) {
		const parts = path.split("/");
		for (let i = 1; i < parts.length; i++) {
			if (portable.has(parts.slice(0, i).join("/"))) throw new Error("Companion file/directory prefix collision");
		}
	}
	if (bytes > PACKAGE_LIMIT) throw new Error("Package exceeds 1 MiB");
}
function digest(pkg: SkillPackage): string { validate(pkg); return createHash("sha256").update(canonical(pkg)).digest("hex"); }
function checked(version: string, pkg: SkillPackage): SkillPackage {
	if (digest(pkg) !== version) throw new Error("Skill version hash/bytes mismatch");
	return pkg;
}
function generation(value: number): void {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid expectedGeneration");
}
function record(doc: SkillsState, name: string): RecordEntry | undefined { return doc.skills.find((item) => item.name === name); }
function stored(entry: RecordEntry, version: string): Version {
	const found = entry.versions.find((item) => item.version === version);
	if (!found || found.package.name !== entry.name) throw new Error("Unknown skill version");
	checked(found.version, found.package);
	return found;
}
function cas(doc: SkillsState, name: string, expected: number): void {
	generation(expected);
	if ((record(doc, name)?.generation ?? 0) !== expected) throw new Error("Skill generation conflict; reload before editing");
}
function proposal(doc: SkillsState, id: string): SkillProposal {
	const found = doc.proposals.find((item) => item.proposalId === id);
	if (!found) throw new Error("Unknown skill proposal");
	checked(found.version, found.candidate);
	if (found.name !== found.candidate.name) throw new Error("Proposal name mismatch");
	return found;
}
function keepVersion(entry: RecordEntry, pkg: SkillPackage): string {
	const version = digest(pkg);
	const existing = entry.versions.find((item) => item.version === version);
	if (existing) {
		checked(version, existing.package);
		if (canonical(existing.package) !== canonical(pkg)) throw new Error("Skill version collision");
	} else entry.versions.push({ version, package: clone(pkg) });
	return version;
}
function activate(doc: SkillsState, pkg: SkillPackage, actor: string, operation: SkillHistory["operation"], proposalId: string | null, evidence?: SkillEvidence): SkillPublication {
	let entry = record(doc, pkg.name);
	if (!entry) {
		const imported = operation === "initialize" || (operation === "upstream" && doc.proposals.some((item) => item.proposalId === proposalId && item.actor === "source"));
		entry = { name: pkg.name, head: "", generation: 0, origin: imported ? digest(pkg) : null, versions: [], history: [] };
		doc.skills.push(entry);
		entry = record(doc, pkg.name)!;
	}
	if (!Number.isSafeInteger(entry.generation + 1)) throw new Error("Skill generation exhausted");
	entry.generation++;
	entry.head = keepVersion(entry, pkg);
	const result = { name: pkg.name, generation: entry.generation, version: entry.head };
	entry.history.push({ ...result, actor, operation, proposalId, ...(evidence ? { evidence: clone(evidence) } : {}) });
	return result;
}
function stage(doc: SkillsState, pkg: SkillPackage, expectedGeneration: number, actor: string, operation: SkillProposal["operation"]): { proposalId: string } {
	cas(doc, pkg.name, expectedGeneration);
	const entry = record(doc, pkg.name);
	const item: SkillProposal = {
		proposalId: randomUUID(), name: pkg.name, actor, operation, expectedGeneration,
		beforeVersion: entry?.head ?? null, version: digest(pkg), candidate: clone(pkg),
		status: "approved", approval: null, rejectedBy: null,
	};
	item.approval = { actor: "system:auto", proposalId: item.proposalId, version: item.version, expectedGeneration };
	doc.proposals.push(item);
	return { proposalId: item.proposalId };
}

/** Trusted publisher callback: the caller owns the atomic evidence/default commit. */
export function activateEvaluatedSkill(doc: SkillsState, effect: PackageActivation): SkillPublication {
	const item = proposal(doc, effect.proposalId);
	const approval = item.approval;
	if (item.status !== "approved" || item.version !== effect.version ||
		item.expectedGeneration !== effect.expectedGeneration || !approval ||
		approval.proposalId !== item.proposalId || approval.version !== item.version ||
		approval.expectedGeneration !== item.expectedGeneration) throw new Error("Exact evaluated proposal approval required");
	cas(doc, item.name, effect.expectedGeneration);
	const publication = activate(doc, item.candidate, "system:skill-evaluation", item.operation, item.proposalId);
	item.status = "published";
	return publication;
}

/** Package integrity and automatic approval receipts, not semantic prompt safety or OS isolation. */
export class SkillStore {
	private readonly retention: SkillRetentionService;
	constructor(private readonly harness: Harness, private readonly options: SkillStoreOptions = {}) {
		this.retention = options.retention ?? new SkillRetentionService({
			now: Date.now,
			authorize: async () => { throw new Error("Lifecycle changes require the trusted evaluation publisher"); },
		});
	}
	private async managed(context: Context): Promise<boolean> {
		return this.options.managedManifests === true || (await this.harness.snapshot(SkillsStorageIndexDoc, context))?.active === true;
	}

	/** Mechanical check of publish evidence against durable records. Returns the reason it is insufficient. */
	async checkEvidence(evidence: SkillEvidence, skillName: string, context: Context): Promise<string | undefined> {
		if (evidence.kind === "regression") return "regression evidence is produced by the store, not cited by an agent";
		const conversationId = Number(evidence.conversationId) as ConversationId;
		if (!Number.isSafeInteger(conversationId)) return "evidence.conversationId must be a conversation id";
		if (evidence.kind === "receipts") {
			if (!Array.isArray(evidence.ids) || evidence.ids.length === 0) return "receipts evidence needs at least one id";
			const attempts = (await this.harness.snapshot(EvidenceDoc, conversationId, context))?.attempts ?? [];
			const runs = (await this.harness.snapshot(RunDoc, conversationId, context))?.runs ?? [];
			for (const id of evidence.ids) {
				const attempt = attempts.find((a) => a.id === id);
				if (attempt) { if (attempt.status !== "passed") return `verification attempt ${id} is ${attempt.status}, not passed`; continue; }
				const run = runs.find((r) => r.id === id);
				if (run) { if (run.status !== "verified") return `DAG run ${id} is ${run.status}, not verified`; continue; }
				return `unknown receipt ${id}: not a verification attempt or DAG run of this conversation`;
			}
			return undefined;
		}
		const human = await findHumanMessage(this.harness, conversationId, evidence.quote, 0, context);
		if (!human) return "no human message in this conversation contains that quote";
		if (!human.text.includes(skillName)) return `the quoted human message does not mention skill "${skillName}"`;
		evidence.entryId = human.entryId; evidence.userId = human.userId;
		return undefined;
	}

	private async snapshot(context: Context): Promise<SkillsState> {
		return this.harness.commit(readSkillsState, context);
	}
	private async change<T>(fn: (doc: SkillsState, tx: Tx) => T | Promise<T>, context: Context, decision = "manual_unverified"): Promise<T> {
		return this.harness.commit(async (tx) => {
			const doc = await readSkillsState(tx);
			const managed = this.options.managedManifests === true || (await tx.doc(SkillsStorageIndexDoc)).active;
			const before = JSON.stringify(doc.skills.map((entry) => [entry.name, entry.head, entry.generation]));
			const result = await fn(doc, tx);
			if (!(await tx.doc(SkillsStorageIndexDoc)).active && Buffer.byteLength(JSON.stringify(doc)) > DOCUMENT_LIMIT) throw new Error("Skill store exceeds 16 MiB; history cannot be pruned");
			await writeSkillsState(tx, doc);
			if (managed) {
				const current = await currentSkillManifest(tx, "skills-v1");
				const manifest = await this.retention.filterManifest(tx, current);
				if (JSON.stringify(doc.skills.map((entry) => [entry.name, entry.head, entry.generation])) !== before) {
					const state = await tx.doc(SkillDefaultDoc);
					const publication = await publishSkillManifest(tx, {
						manifest, expectedGeneration: state.publication?.generation ?? 0,
						requestId: `catalog:${randomUUID()}`, actor: "host:skill-store", decision,
					});
					// Curation activation marks (ADR 0038): every head that changed or appeared and
					// entered this default. Archived (filtered) skills are marked on restore instead.
					const previous = new Map((JSON.parse(before) as [string, string, number][]).map(([name, head, generation]) => [name, `${head}:${generation}`]));
					const now = (this.options.now ?? Date.now)();
					for (const entry of doc.skills) {
						if (previous.get(entry.name) === `${entry.head}:${entry.generation}` || manifest.versions[entry.name] !== entry.head) continue;
						await markSkillActivation(tx, entry.name, entry.head, publication.generation, now);
					}
				}
			}
			return clone(result);
		}, context);
	}
	/** Execution catalog is fixed for the lifetime of a pinned conversation. */
	async executionList(conversationId: ConversationId, context: Context): Promise<SkillSummary[]> {
		const pin = await this.harness.snapshot(SkillPinDoc, conversationId, context);
		if (!pin?.pin) {
			const root = await this.harness.snapshot(SkillRetentionDoc, conversationId, context);
			if (await this.managed(context) && (!root || root.closed || root.manifestHash !== null)) throw new Error("Conversation skill pin is missing or closed");
			return this.list(context);
		}
		return this.harness.commit(async (tx) => (await pinnedSkillManifest(tx, conversationId)).catalog.map((item) => ({ ...item })), context);
	}
	/** skills_load: resolves the pinned package, then records the use fail-open in a separate commit. */
	async executionLoad(input: { conversationId: ConversationId; name: string; version?: string }, context: Context) {
		const loaded = await this.executionResolve(input, context);
		try {
			await recordSkillUse(this.harness, input.conversationId, loaded.name, loaded.version, (this.options.now ?? Date.now)(), context);
		} catch {
			// Usage metrics never fail a load.
		}
		return loaded;
	}
	private async executionResolve(input: { conversationId: ConversationId; name: string; version?: string }, context: Context) {
		const pin = await this.harness.snapshot(SkillPinDoc, input.conversationId, context);
		if (!pin?.pin) {
			await this.executionList(input.conversationId, context);
			return this.load(input.name, input.version, context);
		}
		return this.harness.commit(async (tx) => {
			const manifest = await pinnedSkillManifest(tx, input.conversationId);
			const entry = manifest.catalog.find((item) => item.name === input.name);
			if (!entry) throw new Error("Skill is absent from conversation manifest");
			if (input.version !== undefined && input.version !== entry.version) throw new Error("Explicit skill version differs from conversation pin");
			return { ...await readSkillVersion(tx, entry.name, entry.version), version: entry.version, generation: entry.generation };
		}, context);
	}
	async executionReadFile(input: { conversationId: ConversationId; name: string; version: string; path: string }, context: Context): Promise<string> {
		const pin = await this.harness.snapshot(SkillPinDoc, input.conversationId, context);
		if (!pin?.pin) {
			await this.executionList(input.conversationId, context);
			return this.readFile(input.name, input.version, input.path, context);
		}
		pathValid(input.path);
		const pkg = await this.executionResolve(input, context);
		const content = pkg.files[input.path];
		if (!Object.hasOwn(pkg.files, input.path) || content === undefined) throw new Error("Unknown companion file");
		return content;
	}
	async legacyConversations(context: Context): Promise<ConversationId[]> {
		return this.harness.commit(async (tx) => {
			const ids: ConversationId[] = [];
			let cursor: Cursor | undefined;
			do {
				const page = await tx.scanConversations({}, 128, cursor);
				for (const record of page.items) {
					if (record.id === ROOT_CONVERSATION_ID) continue;
					const pin = await tx.doc(SkillPinDoc, record.id);
					const retention = await tx.doc(SkillRetentionDoc, record.id);
					if (!pin.pin && !retention.closed) ids.push(record.id);
				}
				cursor = page.next;
			} while (cursor);
			return ids;
		}, context);
	}
	/** Explicit local lifecycle decision; a closed legacy conversation cannot resume. */
	async closeLegacy(id: string, context: Context): Promise<void> {
		const conversationId = (await this.legacyConversations(context)).find((value) => String(value) === id);
		if (conversationId === undefined) throw new Error("Unknown resumable legacy conversation");
		await this.harness.commit(async (tx) => {
			if ((await tx.doc(SkillPinDoc, conversationId)).pin) throw new Error("Cannot close a pinned conversation through legacy migration");
			await this.retention.closeConversation(tx, conversationId);
			await classifyLegacySkillConversations(tx);
		}, context);
	}
	private receipt<T extends Receipt["result"]>(doc: SkillsState, requestId: string, actor: string, input: unknown, perform: () => T): T {
		nonempty(requestId, "Request ID"); nonempty(actor, "Actor");
		const canonicalInput = JSON.stringify([actor, input]);
		const existing = doc.receipts.find((item) => item.requestId === requestId);
		if (existing) {
			if (existing.canonical !== canonicalInput) throw new Error("Request ID reused with different operation, actor or input");
			return clone(existing.result) as T;
		}
		const result = perform();
		doc.receipts.push({ requestId, canonical: canonicalInput, result: clone(result) });
		return result;
	}

	async initialize(packages: readonly SkillPackage[], context: Context): Promise<void> {
		const snapshots = packages.map((pkg) => { validate(pkg); return clone(pkg); });
		if (new Set(snapshots.map((pkg) => pkg.name)).size !== snapshots.length) throw new Error("Duplicate source skill name");
		await this.change(async (doc, tx) => {
			const managed = this.options.managedManifests === true || (await tx.doc(SkillsStorageIndexDoc)).active;
			const accepted = managed ? await this.retention.filterSourcePackages(tx, snapshots) : snapshots;
			const deployment = await tx.doc(SkillDefaultDoc);
			const protectedLegacy = managed && !deployment.legacyClassified;
			for (const pkg of accepted) {
				const upstream = digest(pkg);
				const entry = record(doc, pkg.name);
				if (!entry) {
					const imported = doc.proposals.find((item) => item.name === pkg.name && item.actor === "source" && item.version === upstream && item.beforeVersion === null);
					if (protectedLegacy) {
						if (!imported) stage(doc, pkg, 0, "source", "upstream");
						continue;
					}
					if (imported && (imported.status !== "approved" || imported.approval?.version !== upstream)) continue;
					activate(doc, pkg, "source", imported ? "upstream" : "initialize", imported?.proposalId ?? null);
					if (imported) imported.status = "published";
					record(doc, pkg.name)!.origin = upstream;
					continue;
				}
				if (!entry.origin) {
					if (pkg.source !== `bundled:${pkg.name}`) throw new Error(`Source name collides with agent-created skill: ${pkg.name}`);
					// A newly bundled skill may already exist locally. Observe the upstream
					// as a reviewable candidate, preserving the active package and all pins.
					stored(entry, entry.head);
					stage(doc, pkg, entry.generation, "source", "upstream");
					entry.origin = keepVersion(entry, pkg);
					continue;
				}
				const base = stored(entry, entry.origin).package;
				stored(entry, entry.head);
				if (base.source !== pkg.source) throw new Error(`Source identity collision: ${pkg.name}`);
				if (upstream === entry.origin) continue;
				if (entry.head === entry.origin && !managed) activate(doc, pkg, "source", "upstream", null);
				else if (entry.head !== upstream) stage(doc, pkg, entry.generation, "source", "upstream");
				// B becomes the latest observed U even on conflict. L stays unchanged until approval;
				// subsequent boots dedupe, and a later U is compared with its actual predecessor.
				// Every observed origin is retained, including rejected upstream candidates.
				keepVersion(entry, pkg);
				entry.origin = upstream;
			}
		}, context, "source_unverified");
	}
	async list(context: Context): Promise<SkillSummary[]> {
		return (await this.harness.commit(readSkillSummaries, context)).sort((a, b) => a.name.localeCompare(b.name));
	}
	async load(name: string, version: string | undefined, context: Context, by?: ConversationId): Promise<SkillPackage & { version: string; generation: number }> {
		nameValid(name);
		const entry = record(await this.snapshot(context), name);
		if (!entry) throw new Error("Unknown skill");
		const found = stored(entry, version ?? entry.head);
		// A retained upstream package may never have been active (generation 0).
		const activation = entry.history.findLast((item) => item.version === found.version);
		if (by !== undefined) {
			await this.change((doc) => {
				// Tracked documents: always read back through the proxy after assigning a new nested value.
				doc.usage ??= {}; doc.loaded ??= {};
				doc.usage[found.version] ??= { loads: 0, verified: 0, blocked: 0 };
				doc.usage[found.version]!.loads++;
				doc.loaded[String(by)] ??= [];
				if (!doc.loaded[String(by)]!.includes(found.version)) doc.loaded[String(by)]!.push(found.version);
			}, context);
		}
		return { ...clone(found.package), version: found.version, generation: activation?.generation ?? 0 };
	}
	async usage(name: string, context: Context): Promise<Record<string, SkillUsage>> {
		nameValid(name);
		const doc = await this.snapshot(context);
		const entry = record(doc, name);
		if (!entry) throw new Error("Unknown skill");
		return Object.fromEntries(entry.versions.map((v) => [v.version, doc.usage?.[v.version] ?? { loads: 0, verified: 0, blocked: 0 }]));
	}
	/**
	 * Score every version the conversation loaded since its last score, then apply the regression rule to each
	 * active agent-evolved head. Scoring happens only when an episode ends (ADR 0030 decision 3), and a
	 * regression restores the predecessor atomically in the same transaction with `regression` evidence.
	 */
	async recordOutcome(conversationId: ConversationId, outcome: SkillOutcome, context: Context): Promise<SkillRegression[]> {
		return this.change(async (doc, tx) => {
			const managed = this.options.managedManifests === true || (await tx.doc(SkillsStorageIndexDoc)).active;
			doc.usage ??= {}; doc.loaded ??= {};
			const usage = doc.usage;
			const versions = [...(doc.loaded[String(conversationId)] ?? [])];
			delete doc.loaded[String(conversationId)];
			const regressions: SkillRegression[] = [];
			for (const version of versions) {
				usage[version] ??= { loads: 0, verified: 0, blocked: 0 };
				const u = usage[version]!;
				u[outcome]++;
				const entry = doc.skills.find((item) => item.head === version);
				if (!entry) continue;
				const activation = entry.history.findLast((h) => h.version === version);
				// Only agent-evolved heads are judged: they have cited evidence or an agent actor. Source/owner/regression publications stand.
				if (!activation || activation.operation === "regression" || !(activation.evidence || activation.actor.startsWith("agent:"))) continue;
				const predecessor = entry.history.findLast((h) => h.generation < activation.generation && h.version !== version);
				if (!predecessor) continue;
				const prior = usage[predecessor.version] ?? { loads: 0, verified: 0, blocked: 0 };
				if (!regressed(u, prior)) continue;
				const evidence: SkillEvidence = { kind: "regression", version, usage: { from: clone(u), to: clone(prior) } };
				// A usage heuristic is an investigation signal, not causal evidence.
				// Managed evolution never changes the default from this observation path.
				if (!managed) activate(doc, stored(entry, predecessor.version).package, "system:regression", "regression", null, evidence);
				regressions.push({ name: entry.name, from: version, to: predecessor.version, evidence, usage: { from: clone(u), to: clone(prior) } });
			}
			return regressions;
		}, context);
	}
	async readFile(name: string, version: string, path: string, context: Context): Promise<string> {
		nonempty(version, "Version"); pathValid(path);
		const pkg = await this.load(name, version, context);
		if (!Object.hasOwn(pkg.files, path)) throw new Error("Unknown companion file");
		return pkg.files[path]!;
	}
	async propose(input: SkillEdit, actor: string, context: Context): Promise<{ proposalId: string }> {
		const frozen = clone(input);
		nameValid(frozen.name); generation(frozen.expectedGeneration);
		// Receipt identity excludes inherited provenance, which may change after the first call.
		const key = ["propose", frozen.name, frozen.description, frozen.body, Object.entries(frozen.files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0), frozen.expectedGeneration];
		return this.change((doc) => this.receipt(doc, frozen.requestId, actor, key, () => {
			const entry = record(doc, frozen.name);
			const previous = entry ? stored(entry, entry.head).package : undefined;
			const pkg: SkillPackage = { name: frozen.name, description: frozen.description, body: frozen.body, files: frozen.files, source: previous?.source ?? "agent", ...(previous?.originalSkillMd === undefined ? {} : { originalSkillMd: previous.originalSkillMd }) };
			return stage(doc, pkg, frozen.expectedGeneration, actor, "edit");
		}), context);
	}
	async restore(input: SkillRestore, actor: string, context: Context): Promise<{ proposalId: string }> {
		const frozen = clone(input);
		return this.change((doc) => this.receipt(doc, frozen.requestId, actor, ["restore", frozen.name, frozen.version, frozen.expectedGeneration], () => {
			const entry = record(doc, frozen.name);
			if (!entry) throw new Error("Unknown skill");
			return stage(doc, stored(entry, frozen.version).package, frozen.expectedGeneration, actor, "restore");
		}), context);
	}
	async diff(proposalId: string, context: Context): Promise<SkillDiff> {
		const doc = await this.snapshot(context);
		const item = proposal(doc, proposalId);
		const entry = record(doc, item.name);
		return { ...item, before: item.beforeVersion && entry ? clone(stored(entry, item.beforeVersion).package) : null, after: clone(item.candidate) };
	}
	async pending(context: Context): Promise<SkillProposal[]> {
		const doc = await this.snapshot(context);
		return doc.proposals.filter((item) => item.status === "pending" || item.status === "approved").map((item) => clone(proposal(doc, item.proposalId)));
	}
	async reject(proposalId: string, actor: string, context: Context): Promise<void> {
		nonempty(actor, "Actor");
		await this.change((doc) => {
			const item = proposal(doc, proposalId);
			if (item.status === "published") throw new Error("Published proposal is terminal");
			item.status = "rejected"; item.approval = null; item.rejectedBy = actor;
		}, context);
	}
	async publish(input: { proposalId: string; requestId: string; evidence?: SkillEvidence }, actor: string, context: Context): Promise<SkillPublication> {
		const frozen = clone(input);
		const managed = await this.managed(context);
		// Approved proposals publish without owner confirmation (ADR 0028/0032). Evidence is optional
		// provenance: when an agent cites it, it must match durable records, but none is required.
		const checked = (managed && actor.startsWith("agent:")) || (this.options.evidenceChecked?.(actor) ?? false);
		if (checked && frozen.evidence) {
			// Idempotent retries of an already-published request skip the check; the receipt answers them.
			const doc = await this.snapshot(context);
			const prior = doc.receipts.find((item) => item.requestId === frozen.requestId);
			if (!prior) {
				const item = proposal(doc, frozen.proposalId);
				const problem = await this.checkEvidence(frozen.evidence, item.name, context);
				if (problem) throw new Error(`Insufficient evidence: ${problem}`);
			}
		}
		// The receipt key holds what the agent cited, not what the check resolved (entryId/userId), so exact retries match.
		const cited = frozen.evidence ? (frozen.evidence.kind === "receipts" ? ["receipts", frozen.evidence.conversationId, frozen.evidence.ids] : frozen.evidence.kind === "instruction" ? ["instruction", frozen.evidence.conversationId, frozen.evidence.quote] : ["regression", frozen.evidence.version]) : null;
		return this.change((doc) => this.receipt(doc, frozen.requestId, actor, ["publish", frozen.proposalId, cited], () => {
			const item = proposal(doc, frozen.proposalId);
			const approval = item.approval;
			if (item.status !== "approved" || !approval || approval.proposalId !== item.proposalId || approval.version !== item.version || approval.expectedGeneration !== item.expectedGeneration) throw new Error("Exact proposal approval required");
			cas(doc, item.name, item.expectedGeneration);
			if (frozen.evidence) item.evidence = clone(frozen.evidence);
			const result = activate(doc, item.candidate, actor, item.operation, item.proposalId, frozen.evidence);
			item.status = "published";
			return result;
		}), context);
	}
	async history(name: string, context: Context): Promise<SkillHistory[]> {
		nameValid(name);
		const entry = record(await this.snapshot(context), name);
		if (!entry) throw new Error("Unknown skill");
		for (const item of entry.history) stored(entry, item.version);
		return clone(entry.history);
	}
}
