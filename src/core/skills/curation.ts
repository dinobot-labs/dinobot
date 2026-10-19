import type { Context } from "@earendil-works/chord";
import {
	type ConversationId, type ConversationRecord, type Cursor, defineDoc, defineDocFamily, type Harness,
	ROOT_CONVERSATION_ID, type Tx,
} from "@earendil-works/pi-durable";
import { SkillDefaultDoc, SkillManifestDoc, SkillPinDoc, type ManifestPublication } from "./manifests.ts";
import { SkillLifecycleDoc, SkillLifecycleError, type SkillRetentionService } from "./retention.ts";
import { readSkillsState } from "./storage.ts";
import { EvolutionWorkerDoc } from "./evolution-service.ts";
import type { SkillsState } from "./store.ts";

/*
 * Skill curation (ADR 0038, design sections 2-3): usage metrics and an exposure-normalized run test
 * that archives (reversibly deactivates) agent-created skills nobody uses. Archive only flips the
 * lifecycle through SkillRetentionService.curate; packages and history are never deleted, and pinned
 * conversations keep their execution manifest.
 */

// ─── Durable records ────────────────────────────────────────────────────────

export type SkillUse = { count: number; firstAt: number; lastAt: number; version: string };
/** Per-conversation skills_load record. Written fail-open after a successful execution load. */
export const SkillUseDoc = defineDoc<{ uses: Record<string, SkillUse> }>({
	kind: "dinobot.skill-curation.use", version: 1, scope: "conversation", history: "latest", fork: "initial",
	initial: () => ({ uses: {} }),
});
/** Written by the conversationCreated hook. Conversations created before curation keep the initial
 * value (root false) and never count as exposures: conservative, no false archive from old data. */
export const SkillExposureDoc = defineDoc<{ createdAt: number | null; root: boolean }>({
	kind: "dinobot.skill-curation.exposure", version: 1, scope: "conversation", history: "latest", fork: "initial",
	initial: () => ({ createdAt: null, root: false }),
});
export type SkillCurationState = "active" | "stale" | "archived";
export type SkillCurationRecord = {
	pinned: boolean; activationGeneration: number; activatedAt: number; state: SkillCurationState;
	archivedAt: number | null; reason: string | null;
	lastRun: { at: number; run: number; uses: number; exposures: number; idleMs: number } | null;
	/** Head version the activation mark belongs to; a different current head (a publication path that
	 * did not mark) is treated as a fresh activation, which only delays archive. */
	head: string | null;
	/** Lifecycle revision the activation mark belongs to. Any lifecycle status change made without a
	 * mark (e.g. a statistical transition) leaves a different current revision, which the scan treats as
	 * a fresh activation. Absent in records written before this field: one fresh activation, which
	 * only delays archive. */
	lifecycleRevision?: number;
};
export const SkillCurationDoc = defineDocFamily<SkillCurationRecord, null>({
	kind: "dinobot.skill-curation.record", version: 1, scope: "session", family: true,
	initial: () => ({ pinned: false, activationGeneration: 0, activatedAt: 0, state: "active", archivedAt: null, reason: null, lastRun: null, head: null, lifecycleRevision: 0 }),
});
export type CurationAction = "archive" | "archived" | "none" | "exempt" | "refused" | "skipped" | "error";
export type CurationReportSkill = {
	name: string; provenance: SkillProvenance; state: SkillCurationState;
	/** R(s): root exposures after the last root that used the skill. */
	run: number; uses: number; exposures: number; idleMs: number;
	action: CurationAction; reason: string | null;
};
export type CurationReport = {
	at: number; run: number; dryRun: boolean; threshold: number; minIdleMs: number; alpha: number; pMax: number;
	skills: CurationReportSkill[];
};
export const SkillCurationStateDoc = defineDoc<{ lastRunAt: number | null; runs: number; lastReport: CurationReport | null }>({
	kind: "dinobot.skill-curation.state", version: 1, scope: "session",
	initial: () => ({ lastRunAt: null, runs: 0, lastReport: null }),
});

// ─── Configuration ──────────────────────────────────────────────────────────

export type SkillCurationConfig = {
	readonly enabled: boolean;
	/** Per-run false-archive probability bound for a skill used with probability >= pMax per root. */
	readonly alpha: number;
	readonly pMax: number;
	readonly minIdleMs: number;
	readonly settleMs: number;
	readonly intervalMs: number;
	readonly includeUser: boolean;
	readonly includeBundled: boolean;
};
export type SkillCurationOptions = Partial<SkillCurationConfig>;
export const CURATION_DEFAULTS: SkillCurationConfig = Object.freeze({
	enabled: true, alpha: 0.05, pMax: 0.02, minIdleMs: 14 * 86_400_000, settleMs: 3_600_000,
	intervalMs: 6 * 3_600_000, includeUser: false, includeBundled: false,
});
export function skillCurationConfig(input: SkillCurationOptions | undefined): { config: SkillCurationConfig; problems: string[] } {
	const config = { ...CURATION_DEFAULTS, ...Object.fromEntries(Object.entries(input ?? {}).filter(([, value]) => value !== undefined)) } as SkillCurationConfig;
	const problems: string[] = [];
	if (!(config.alpha > 0 && config.alpha < 1)) problems.push("curation.alpha must be in (0, 1)");
	if (!(config.pMax > 0 && config.pMax < 1)) problems.push("curation.pMax must be in (0, 1)");
	for (const key of ["minIdleMs", "settleMs"] as const) {
		if (!Number.isSafeInteger(config[key]) || config[key] < 0) problems.push(`curation.${key} must be a non-negative integer`);
	}
	if (!Number.isSafeInteger(config.intervalMs) || config.intervalMs < 60_000 || config.intervalMs > 2_147_483_647) problems.push("curation.intervalMs must be an integer in [60000, 2147483647]");
	for (const key of ["enabled", "includeUser", "includeBundled"] as const) {
		if (typeof config[key] !== "boolean") problems.push(`curation.${key} must be a boolean`);
	}
	return { config, problems };
}

// ─── Math ───────────────────────────────────────────────────────────────────

/** L* = ceil(ln(alpha) / ln(1 - pMax)): a fixed window of L* use-free exposures has probability
 * (1-p)^L* <= alpha for every per-root use probability p >= pMax. */
export function archiveThreshold(alpha: number, pMax: number): number {
	if (!(alpha > 0 && alpha < 1)) throw new RangeError("alpha must be in (0, 1)");
	if (!(pMax > 0 && pMax < 1)) throw new RangeError("pMax must be in (0, 1)");
	return Math.ceil(Math.log(alpha) / Math.log1p(-pMax));
}
/** Expected exposures until the first run of L use-free exposures under Bernoulli(p) uses:
 * E[T] = ((1-p)^(-L) - 1) / p. p = 0 means never used: exactly L. */
export function expectedFalseArchiveExposures(p: number, threshold: number): number {
	if (!(p >= 0 && p < 1)) throw new RangeError("p must be in [0, 1)");
	if (!Number.isSafeInteger(threshold) || threshold < 1) throw new RangeError("threshold must be a positive integer");
	if (p === 0) return threshold;
	return Math.expm1(-threshold * Math.log1p(-p)) / p;
}

// ─── Provenance ─────────────────────────────────────────────────────────────

export type SkillProvenance = "bundled" | "agent" | "review" | "evolution" | "user";
/** Derived from the FIRST history entry's actor, never stored. */
export function skillProvenance(firstActor: string | undefined): SkillProvenance {
	if (firstActor === "source") return "bundled";
	if (firstActor?.startsWith("agent:")) return "agent";
	if (firstActor === "host:skill-review") return "review";
	if (firstActor === "system:skill-evaluation") return "evolution";
	return "user";
}
export function curatableProvenance(provenance: SkillProvenance, config: Pick<SkillCurationConfig, "includeUser" | "includeBundled">): boolean {
	return provenance === "agent" || provenance === "review" || provenance === "evolution"
		|| (provenance === "user" && config.includeUser) || (provenance === "bundled" && config.includeBundled);
}

// ─── Pure decision ──────────────────────────────────────────────────────────

export type CurationConversationFacts = {
	readonly id: number;
	/** Owner edge, else history parent edge: uses of descendants are attributed to the root. */
	readonly up: number | null;
	readonly root: boolean;
	readonly createdAt: number | null;
	/** Evolution research worker or another host conversation: never an exposure, never a use. */
	readonly excluded: boolean;
	readonly pin: { readonly generation: number; readonly skills: readonly string[] } | null;
	readonly uses: Readonly<Record<string, { readonly lastAt: number }>>;
};
export type CurationSkillFacts = {
	readonly name: string; readonly provenance: SkillProvenance;
	readonly active: boolean; readonly pinned: boolean;
	readonly activationGeneration: number; readonly activatedAt: number;
};
export type CurationSkillDecision = Omit<CurationReportSkill, "action" | "reason"> & {
	action: "archive" | "archived" | "none" | "exempt"; reason: string | null; lastUseAt: number | null;
};
/** Exposure-normalized run test (design section 3). Pure and deterministic. */
export function decideCuration(input: {
	readonly now: number; readonly config: SkillCurationConfig;
	readonly skills: readonly CurationSkillFacts[]; readonly conversations: readonly CurationConversationFacts[];
}): CurationSkillDecision[] {
	const { now, config } = input;
	const threshold = archiveThreshold(config.alpha, config.pMax);
	const byId = new Map(input.conversations.map(c => [c.id, c]));
	const rootCache = new Map<number, number | null>();
	function rootOf(id: number): number | null {
		const cached = rootCache.get(id);
		if (cached !== undefined) return cached;
		let current = byId.get(id);
		const seen = new Set<number>();
		while (current && current.up !== null && !seen.has(current.id)) { seen.add(current.id); current = byId.get(current.up); }
		const result = current && current.up === null && !current.excluded ? current.id : null;
		rootCache.set(id, result);
		return result;
	}
	const roots = input.conversations.filter(c => c.root && c.up === null && !c.excluded).sort((a, b) => a.id - b.id);
	return input.skills.map((skill): CurationSkillDecision => {
		const usedRoots = new Set<number>();
		let lastUseAt: number | null = null;
		for (const conversation of input.conversations) {
			const use = conversation.uses[skill.name];
			if (!use || conversation.excluded) continue;
			const root = rootOf(conversation.id);
			if (root === null) continue;
			usedRoots.add(root);
			lastUseAt = Math.max(lastUseAt ?? use.lastAt, use.lastAt);
		}
		const exposures = roots.filter(c => c.pin !== null && c.pin.skills.includes(skill.name)
			&& c.pin.generation >= skill.activationGeneration
			&& (c.createdAt === null || (c.createdAt >= skill.activatedAt && now - c.createdAt >= config.settleMs)));
		const lastUsedRoot = usedRoots.size ? Math.max(...usedRoots) : -Infinity;
		const run = exposures.filter(c => c.id > lastUsedRoot).length;
		const uses = exposures.filter(c => usedRoots.has(c.id)).length;
		const idleMs = Math.max(0, now - Math.max(lastUseAt ?? 0, skill.activatedAt));
		const stale = run >= Math.ceil(threshold / 2) || idleMs >= config.minIdleMs / 2;
		const base = { name: skill.name, provenance: skill.provenance, run, uses, exposures: exposures.length, idleMs, lastUseAt };
		if (!skill.active) return { ...base, state: "archived", action: "archived", reason: "lifecycle inactive" };
		const state: SkillCurationState = stale ? "stale" : "active";
		if (!curatableProvenance(skill.provenance, config)) return { ...base, state, action: "exempt", reason: `provenance ${skill.provenance}` };
		if (skill.pinned) return { ...base, state, action: "exempt", reason: "pinned" };
		if (run >= threshold && idleMs >= config.minIdleMs) return { ...base, state, action: "archive", reason: `R=${run}>=${threshold} and idle=${idleMs}ms>=${config.minIdleMs}ms` };
		return { ...base, state, action: "none", reason: null };
	});
}

// ─── Store hooks ────────────────────────────────────────────────────────────

/** Activation mark: the skill's current head entered the default at `generation`. Same tx as the publication. */
export async function markSkillActivation(tx: Tx, name: string, head: string, generation: number, now: number): Promise<void> {
	const record = await tx.doc(SkillCurationDoc, name, null);
	record.lifecycleRevision = (await tx.doc(SkillLifecycleDoc, name, null)).revision;
	record.activationGeneration = generation; record.activatedAt = now; record.head = head;
	record.state = "active"; record.archivedAt = null; record.reason = null;
}
/** conversationCreated hook (same tx as creation). */
export async function recordSkillExposure(tx: Tx, record: ConversationRecord, now: number): Promise<void> {
	if (record.id === ROOT_CONVERSATION_ID) return;
	const exposure = await tx.doc(SkillExposureDoc, record.id);
	exposure.createdAt = now;
	exposure.root = !record.owner && !record.parent;
}
const USE_NAME_LIMIT = 256;
/** Separate commit after a successful load. Callers catch and ignore failures (fail-open). */
export async function recordSkillUse(harness: Harness, conversationId: ConversationId, name: string, version: string, now: number, context: Context): Promise<void> {
	await harness.commit(async (tx) => {
		const doc = await tx.doc(SkillUseDoc, conversationId);
		const existing = doc.uses[name];
		if (existing) {
			existing.count++; existing.lastAt = Math.max(existing.lastAt, now); existing.version = version;
			return;
		}
		if (Object.keys(doc.uses).length >= USE_NAME_LIMIT) return;
		doc.uses[name] = { count: 1, firstAt: now, lastAt: now, version };
	}, context);
}

// ─── Service ────────────────────────────────────────────────────────────────

export type SkillCurationStatus = {
	readonly config: SkillCurationConfig & { readonly threshold: number };
	readonly lastRunAt: number | null; readonly runs: number; readonly lastReport: CurationReport | null;
	readonly skills: readonly {
		readonly name: string; readonly provenance: SkillProvenance; readonly lifecycle: "active" | "inactive";
		readonly pinned: boolean; readonly state: SkillCurationState; readonly activationGeneration: number;
		readonly activatedAt: number; readonly archivedAt: number | null; readonly reason: string | null;
		readonly lastRun: SkillCurationRecord["lastRun"];
	}[];
	readonly archived: readonly string[];
};
export type SkillCurationServiceOptions = {
	readonly harness: () => Harness;
	readonly retention: SkillRetentionService;
	readonly config: SkillCurationConfig;
	readonly now: () => number;
	readonly log?: (message: string) => void;
};
type ScannedSkill = CurationSkillFacts & {
	head: string; lifecycleRevision: number; seeded: boolean;
	recordHead: string | null; recordActivatedAt: number; recordGeneration: number; recordLifecycleRevision: number | null;
};
const PAGE = 128;
const CURATOR = "host:curator";

function firstActor(entry: SkillsState["skills"][number]): string | undefined { return entry.history[0]?.actor; }

export class SkillCurationService {
	readonly threshold: number;
	private chain: Promise<unknown> = Promise.resolve();
	private timer: ReturnType<typeof setInterval> | undefined;
	private closed = false;
	constructor(private readonly options: SkillCurationServiceOptions) {
		this.threshold = archiveThreshold(options.config.alpha, options.config.pMax);
	}
	get config(): SkillCurationConfig { return this.options.config; }

	/** Serialized: runs never overlap; a call waits for the in-flight run. */
	run(input: { readonly dryRun?: boolean }, context: Context): Promise<CurationReport> {
		const next = this.chain.then(() => this.runOnce(input.dryRun === true, context));
		this.chain = next.catch(() => undefined);
		return next;
	}
	/** Startup run plus an unref'd interval timer; errors are logged, never thrown. */
	start(context: Context): void {
		if (!this.options.config.enabled || this.closed || this.timer) return;
		const tick = () => {
			if (this.closed) return;
			this.run({}, context).catch((error: unknown) => this.options.log?.(`skill curation failed: ${error instanceof Error ? error.message : String(error)}`));
		};
		tick();
		this.timer = setInterval(tick, this.options.config.intervalMs);
		this.timer.unref?.();
	}
	/** Clear the timer and wait for the in-flight run before the harness closes. */
	async stop(): Promise<void> {
		this.closed = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		await this.chain;
	}

	private async scan(context: Context): Promise<{ now: number; skills: ScannedSkill[]; conversations: CurationConversationFacts[]; defaultSkills: Set<string> }> {
		const harness = this.options.harness();
		const now = this.options.now();
		// One read-only commit for skill heads, lifecycles, curation records and the default manifest.
		const base = await harness.commit(async (tx) => {
			const state = await readSkillsState(tx);
			const defaults = (await tx.doc(SkillDefaultDoc)).publication;
			const manifest = defaults ? (await tx.doc(SkillManifestDoc, defaults.manifestHash, null)).manifest : null;
			return {
				generation: defaults?.generation ?? 0,
				defaultSkills: Object.keys(manifest?.versions ?? {}),
				skills: state.skills.map(entry => ({ name: entry.name, head: entry.head, actor: firstActor(entry) })),
			};
		}, context);
		const skills: ScannedSkill[] = [];
		for (const entry of base.skills) {
			const lifecycle = await harness.snapshot(SkillLifecycleDoc, entry.name, context);
			const record = await harness.snapshot(SkillCurationDoc, entry.name, context);
			const active = (lifecycle?.status ?? "active") === "active";
			const lifecycleRevision = lifecycle?.revision ?? 0;
			// Unmarked or foreign activation (unknown head, or a lifecycle change outside curation such as a
			// statistical reactivate): fresh activation now, so exposures before it never count.
			const seeded = active && (record?.head !== entry.head || record?.state === "archived"
				|| (record?.lifecycleRevision ?? null) !== lifecycleRevision);
			skills.push({
				name: entry.name, head: entry.head, provenance: skillProvenance(entry.actor), active,
				pinned: record?.pinned ?? false, lifecycleRevision,
				activationGeneration: seeded ? base.generation : record!.activationGeneration,
				activatedAt: seeded ? now : record!.activatedAt, seeded, recordHead: record?.head ?? null,
				recordActivatedAt: record?.activatedAt ?? 0, recordGeneration: record?.activationGeneration ?? 0,
				recordLifecycleRevision: record?.lifecycleRevision ?? null,
			});
		}
		const records: ConversationRecord[] = [];
		let cursor: Cursor | undefined;
		do {
			const page = await harness.commit(tx => tx.scanConversations({}, PAGE, cursor), context);
			records.push(...page.items);
			cursor = page.next;
		} while (cursor);
		const manifests = new Map<string, string[]>();
		const conversations: CurationConversationFacts[] = [];
		for (const record of records) {
			if (record.id === ROOT_CONVERSATION_ID) continue;
			const id = Number(record.id);
			const up = record.owner?.conversationId ?? record.parent?.conversationId;
			// Snapshots never materialize absent documents (tx.doc would create EvolutionWorkerDoc).
			const worker = await harness.snapshot(EvolutionWorkerDoc, record.id, context);
			const use = await harness.snapshot(SkillUseDoc, record.id, context);
			const exposure = up === undefined ? await harness.snapshot(SkillExposureDoc, record.id, context) : undefined;
			let pin: CurationConversationFacts["pin"] = null;
			if (exposure?.root) {
				const pinned = (await harness.snapshot(SkillPinDoc, record.id, context))?.pin;
				if (pinned) {
					let names = manifests.get(pinned.manifestHash);
					if (!names) {
						names = Object.keys((await harness.snapshot(SkillManifestDoc, pinned.manifestHash, context))?.manifest?.versions ?? {});
						manifests.set(pinned.manifestHash, names);
					}
					pin = { generation: pinned.generation, skills: names };
				}
			}
			conversations.push({
				id, up: up === undefined ? null : Number(up), root: exposure?.root === true, createdAt: exposure?.createdAt ?? null,
				excluded: worker !== undefined, pin,
				uses: Object.fromEntries(Object.entries(use?.uses ?? {}).map(([name, value]) => [name, { lastAt: value.lastAt }])),
			});
		}
		return { now, skills, conversations, defaultSkills: new Set(base.defaultSkills) };
	}

	private async runOnce(dryRun: boolean, context: Context): Promise<CurationReport> {
		const harness = this.options.harness();
		const { config } = this.options;
		const scanned = await this.scan(context);
		const { now } = scanned;
		const decisions = decideCuration({ now, config, skills: scanned.skills, conversations: scanned.conversations });
		const previous = await harness.snapshot(SkillCurationStateDoc, context);
		const runNumber = (previous?.runs ?? 0) + (dryRun ? 0 : 1);
		const skills: CurationReportSkill[] = [];
		for (const decision of decisions) {
			const skill = scanned.skills.find(item => item.name === decision.name)!;
			const { lastUseAt: _lastUseAt, ...item } = decision;
			const entry: CurationReportSkill = { ...item };
			if (decision.action === "archive" && !dryRun) {
				const reason = `unused: ${this.threshold} root exposures without use and idle >= ${config.minIdleMs}ms`;
				try {
					const archived = await harness.commit(async (tx) => {
						const lifecycle = await tx.doc(SkillLifecycleDoc, skill.name, null);
						const record = await tx.doc(SkillCurationDoc, skill.name, null);
						const head = (await readSkillsState(tx)).skills.find(item => item.name === skill.name)?.head;
						// Re-validate the decision against current state; any intervening activation, pin
						// or lifecycle transition skips it.
						if (lifecycle.revision !== skill.lifecycleRevision || lifecycle.status !== "active" || record.pinned
							|| record.activationGeneration !== skill.activationGeneration || record.activatedAt !== skill.activatedAt
							|| head !== skill.head) return false;
						const generation = (await tx.doc(SkillDefaultDoc)).publication?.generation ?? 0;
						await this.options.retention.curate(tx, {
							name: skill.name, operation: "deactivate", expectedRevision: lifecycle.revision,
							expectedDefaultGeneration: generation, actor: CURATOR, reason,
							requestId: `curator:${skill.name}:${lifecycle.revision}:${skill.activationGeneration}:${skill.activatedAt}`,
						});
						record.state = "archived"; record.archivedAt = now; record.reason = decision.reason;
						record.lifecycleRevision = lifecycle.revision;
						return true;
					}, context);
					entry.action = archived ? "archive" : "skipped";
					if (archived) entry.state = "archived";
					else entry.reason = "state changed since scan";
				} catch (error) {
					const lifecycleError = error instanceof SkillLifecycleError ? error : undefined;
					entry.action = lifecycleError?.code === "guard" ? "refused" : lifecycleError?.code === "conflict" ? "skipped" : "error";
					entry.reason = error instanceof Error ? error.message : String(error);
				}
			}
			skills.push(entry);
		}
		const report: CurationReport = {
			at: now, run: runNumber, dryRun, threshold: this.threshold, minIdleMs: config.minIdleMs,
			alpha: config.alpha, pMax: config.pMax, skills,
		};
		if (dryRun) return report;
		await harness.commit(async (tx) => {
			for (const item of report.skills) {
				const skill = scanned.skills.find(value => value.name === item.name)!;
				const record = await tx.doc(SkillCurationDoc, item.name, null);
				// Persist a seed only if no activation mark landed since the scan.
				const unchanged = record.head === skill.recordHead && record.activatedAt === skill.recordActivatedAt && record.activationGeneration === skill.recordGeneration
					&& (record.lifecycleRevision ?? null) === skill.recordLifecycleRevision
					&& (await tx.doc(SkillLifecycleDoc, item.name, null)).revision === skill.lifecycleRevision;
				if (skill.seeded && unchanged) {
					record.activationGeneration = skill.activationGeneration; record.activatedAt = skill.activatedAt;
					record.lifecycleRevision = skill.lifecycleRevision;
					record.head = skill.head; record.archivedAt = null; record.reason = null;
				}
				if (item.state === "archived") record.state = "archived";
				else if (record.state !== "archived" || (skill.seeded && unchanged)) record.state = item.state;
				record.lastRun = { at: now, run: runNumber, uses: item.uses, exposures: item.exposures, idleMs: item.idleMs };
			}
			const state = await tx.doc(SkillCurationStateDoc);
			state.lastRunAt = now; state.runs = runNumber; state.lastReport = JSON.parse(JSON.stringify(report));
		}, context);
		return report;
	}

	async status(context: Context): Promise<SkillCurationStatus> {
		const harness = this.options.harness();
		const entries = await harness.commit(async tx => (await readSkillsState(tx)).skills.map(entry => ({ name: entry.name, actor: firstActor(entry) })), context);
		const state = await harness.snapshot(SkillCurationStateDoc, context);
		const skills = [];
		for (const entry of entries) {
			const lifecycle = (await harness.snapshot(SkillLifecycleDoc, entry.name, context))?.status ?? "active";
			const record = await harness.snapshot(SkillCurationDoc, entry.name, context);
			skills.push({
				name: entry.name, provenance: skillProvenance(entry.actor), lifecycle, pinned: record?.pinned ?? false,
				state: lifecycle === "inactive" ? "archived" as const : record?.state === "archived" ? "active" as const : record?.state ?? "active",
				activationGeneration: record?.activationGeneration ?? 0, activatedAt: record?.activatedAt ?? 0,
				archivedAt: record?.archivedAt ?? null, reason: record?.reason ?? null, lastRun: record?.lastRun ?? null,
			});
		}
		skills.sort((a, b) => a.name.localeCompare(b.name));
		return {
			config: { ...this.options.config, threshold: this.threshold },
			lastRunAt: state?.lastRunAt ?? null, runs: state?.runs ?? 0, lastReport: state?.lastReport ?? null,
			skills, archived: skills.filter(item => item.lifecycle === "inactive").map(item => item.name),
		};
	}

	/** Explicit archive (commands/tools). Bundled skills can never be disabled here; retention guards
	 * (protected, rare-recovery, dependency) also apply. The automatic curator path is separate. */
	async archive(name: string, input: { readonly actor: string; readonly requestId: string; readonly reason: string }, context: Context): Promise<ManifestPublication> {
		const now = this.options.now();
		return this.options.harness().commit(async (tx) => {
			// Exact retry of a committed request returns its publication (before reading the current revision).
			const replay = await this.options.retention.curationReplay(tx, {
				name, operation: "deactivate", requestId: input.requestId, actor: input.actor, reason: input.reason,
			});
			if (replay) return replay;
			const entry = (await readSkillsState(tx)).skills.find(item => item.name === name);
			if (entry && skillProvenance(firstActor(entry)) === "bundled") throw new SkillLifecycleError("guard", "Bundled skill cannot be disabled");
			const lifecycle = await tx.doc(SkillLifecycleDoc, name, null);
			const revision = lifecycle.revision;
			const generation = (await tx.doc(SkillDefaultDoc)).publication?.generation ?? 0;
			const publication = await this.options.retention.curate(tx, {
				name, operation: "deactivate", expectedRevision: lifecycle.revision, expectedDefaultGeneration: generation,
				requestId: input.requestId, actor: input.actor, reason: input.reason,
			});
			const record = await tx.doc(SkillCurationDoc, name, null);
			if (lifecycle.revision !== revision) {
				record.state = "archived"; record.archivedAt = now; record.reason = input.reason; record.lifecycleRevision = lifecycle.revision;
			}
			return publication;
		}, context);
	}
	/** Restore = curate reactivate, re-adding the same head at its catalog index, plus an activation mark. */
	async restore(name: string, input: { readonly actor: string; readonly requestId: string; readonly reason?: string }, context: Context): Promise<ManifestPublication> {
		return restoreArchivedSkill(this.options.harness(), this.options.retention, name, { ...input, now: this.options.now() }, context);
	}
	/** Pinned skills are exempt from automatic archive. Pin and unpin reset the run (activatedAt = now). */
	async pin(name: string, pinned: boolean, context: Context): Promise<void> {
		const now = this.options.now();
		await this.options.harness().commit(async (tx) => {
			if (!(await readSkillsState(tx)).skills.some(entry => entry.name === name)) throw new Error("Unknown skill");
			const record = await tx.doc(SkillCurationDoc, name, null);
			if (record.pinned === pinned) return;
			record.pinned = pinned;
			record.activatedAt = Math.max(record.activatedAt, now);
		}, context);
	}
}

/** Restore helper (usable without a service): lifecycle reactivation plus the activation mark, one tx. */
export async function restoreArchivedSkill(harness: Harness, retention: SkillRetentionService, name: string, input: {
	readonly actor: string; readonly requestId: string; readonly reason?: string; readonly now: number;
}, context: Context): Promise<ManifestPublication> {
	const reason = input.reason ?? "restore archived skill";
	return harness.commit(async (tx) => {
		// Exact retry of a committed request returns its publication (before reading the current revision).
		const replay = await retention.curationReplay(tx, { name, operation: "reactivate", requestId: input.requestId, actor: input.actor, reason });
		if (replay) return replay;
		const lifecycle = await tx.doc(SkillLifecycleDoc, name, null);
		const revision = lifecycle.revision;
		const generation = (await tx.doc(SkillDefaultDoc)).publication?.generation ?? 0;
		const publication = await retention.curate(tx, {
			name, operation: "reactivate", expectedRevision: lifecycle.revision, expectedDefaultGeneration: generation,
			requestId: input.requestId, actor: input.actor, reason,
		});
		const head = (await readSkillsState(tx)).skills.find(entry => entry.name === name)?.head;
		if (!head) throw new Error("Unknown skill");
		// An idempotent receipt replay performs no transition and must not move the activation mark.
		if (lifecycle.revision !== revision) await markSkillActivation(tx, name, head, publication.generation, input.now);
		return publication;
	}, context);
}
