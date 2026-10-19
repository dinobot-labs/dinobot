import { createHash } from "node:crypto";
import { defineDoc } from "@earendil-works/pi-durable";

/**
 * The one durable memory store of a bot deployment (`dinobot.memory`).
 *
 * Every entry has a scope: team entries (`project` absent) are visible to every conversation; project entries carry the
 * project key (see `project.ts`) and are visible only to conversations working in that project. An entry is addressed by
 * the pair (scope, key), so the same key may exist once per scope. Writers are this module's pure functions, applied by
 * the memory tools and the curator inside one durable commit each.
 *
 * Automatically extracted memories live in the same store under content-addressed keys `auto/<hash>`; deleting one
 * records the key in `forgotten`, so a later extraction of the same text does not bring it back. An explicit write of
 * that key clears the mark. A newer extraction may supersede automatic entries it contradicts or merges (`replaceAuto`);
 * the superseded keys are forgotten the same way. Entries a person wrote are never superseded.
 *
 * Provenance: entries written since provenance was added carry `createdAt`/`updatedAt` (epoch ms), and automatic entries
 * also carry `evidence`, the (conversation, user turn) windows they were extracted from. Older entries lack these fields.
 */
/** Where an automatic memory came from: the conversation and the last user turn of the extracted window. */
export type MemoryEvidence = { conversationId: number; turn: number };
export type MemoryEntry = {
	key: string;
	content: string;
	/** Store-wide revision of the last write; strictly increasing across all entries. */
	revision: number;
	/** Project key of a project entry; absent for team entries. */
	project?: string;
	/** `auto`: written by the curator. Absent for tool writes. */
	origin?: "auto";
	/** First write of this key (epoch ms); kept across rewrites. Absent on entries older than provenance. */
	createdAt?: number;
	/** Last content write (epoch ms). */
	updatedAt?: number;
	/** Automatic entries: extraction windows that produced (or re-confirmed) this text, oldest first, at most 8. */
	evidence?: MemoryEvidence[];
};
export type MemoryState = { entries: MemoryEntry[]; revision: number; forgotten?: Record<string, string[]> };

/** Shared within one bot storage, across threads and restarts. Not a process-memory cache. */
export const MemoryDoc = defineDoc<MemoryState>({
	kind: "dinobot.memory", version: 1, scope: "session",
	initial: () => ({ entries: [], revision: 0 }),
});

export const MAX_ENTRIES = 1000;
export const MAX_CONTENT_BYTES = 32 * 1024;
/** Automatic writes stop below the store limit, so extraction can never starve explicit memory writes. */
export const AUTO_HEADROOM = 100;
export const AUTO_PREFIX = "auto/";
const MAX_FORGOTTEN = 1000;
export const MAX_MEMORY_EVIDENCE = 8;

export class MemoryConflictError extends Error {}

/** Scope of an entry as tools report it. */
export function scopeOf(entry: Pick<MemoryEntry, "project">): "team" | "project" {
	return entry.project === undefined ? "team" : "project";
}

export function find(state: MemoryState | undefined, key: string, project: string | undefined): MemoryEntry | undefined {
	return state?.entries.find((entry) => entry.key === key && entry.project === project);
}

/** Entries a conversation in `project` can see: every team entry and the entries of its own project. */
export function visible(state: MemoryState | undefined, project: string | undefined, scope: "team" | "project" | "all"): MemoryEntry[] {
	return (state?.entries ?? []).filter((entry) =>
		entry.project === undefined ? scope !== "project" : scope !== "team" && project !== undefined && entry.project === project);
}

export type Mutation = { key: string; revision: number; deleted?: boolean };

/**
 * Write (`content` defined) or delete one entry of `draft` in place. `expectedRevision` is compare-and-set against the
 * entry's revision (0 = absent). Returns the mutation; throws `MemoryConflictError` or a limit error and then leaves
 * `draft` unchanged. `now` stamps `updatedAt` (and `createdAt` of a new key; a rewrite keeps the first time).
 */
export function mutate(draft: MemoryState, key: string, project: string | undefined, content: string | undefined, expectedRevision?: number, now?: number): Mutation {
	const previous = find(draft, key, project);
	if (expectedRevision !== undefined && expectedRevision !== (previous?.revision ?? 0))
		throw new MemoryConflictError("Memory revision conflict; read the current entry before editing.");
	if (content !== undefined) {
		if (Buffer.byteLength(content) > MAX_CONTENT_BYTES) throw new Error("Memory content exceeds 32 KiB");
		if (!previous && draft.entries.length >= MAX_ENTRIES) throw new Error(`Memory limit reached (${MAX_ENTRIES} entries)`);
		// An explicit write takes ownership of the entry: a rewritten automatic entry loses its `auto` origin and evidence.
		const createdAt = previous?.createdAt ?? now;
		const entry: MemoryEntry = {
			key, content, revision: ++draft.revision, ...(project === undefined ? {} : { project }),
			...(createdAt === undefined ? {} : { createdAt }), ...(now === undefined ? {} : { updatedAt: now }),
		};
		draft.entries = previous ? draft.entries.map((item) => item === previous ? entry : item) : [...draft.entries, entry];
		if (project !== undefined) unforget(draft, project, key);
		return { key, revision: entry.revision };
	}
	if (previous) {
		draft.entries = draft.entries.filter((entry) => entry !== previous);
		draft.revision++;
		if (project !== undefined && key.startsWith(AUTO_PREFIX)) forget(draft, project, key);
	}
	return { key, revision: draft.revision, deleted: previous !== undefined };
}

function forget(draft: MemoryState, project: string, key: string): void {
	const forgotten = draft.forgotten ?? {};
	const keys = [...(forgotten[project] ?? []).filter((item) => item !== key), key].slice(-MAX_FORGOTTEN);
	draft.forgotten = { ...forgotten, [project]: keys };
}

function unforget(draft: MemoryState, project: string, key: string): void {
	const keys = draft.forgotten?.[project];
	if (!keys?.includes(key)) return;
	draft.forgotten = { ...draft.forgotten, [project]: keys.filter((item) => item !== key) };
}

/** NFC, whitespace runs collapsed to one space, trimmed, ASCII letters lowercased. */
export function normalizeMemoryText(text: string): string {
	return text.normalize("NFC").replace(/\s+/gu, " ").trim().replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/** `auto/<first 16 hex of sha256(project \0 normalize(text))>`: equal texts of one project share one key. */
export function autoKey(project: string, text: string): string {
	return `${AUTO_PREFIX}${createHash("sha256").update(`${project}\0${normalizeMemoryText(text)}`).digest("hex").slice(0, 16)}`;
}

export type AutoWrite = { key: string; status: "added" | "exists" | "forgotten" | "full" };
/** When and from where an extraction writes. Optional so callers without a window (tests, tools) stay valid. */
export type AutoProvenance = { now: number; evidence?: MemoryEvidence };

/** `lists` concatenated oldest first, duplicates (same conversation and turn) dropped, the newest MAX kept. */
function mergeEvidence(...lists: readonly (readonly MemoryEvidence[] | undefined)[]): MemoryEvidence[] {
	const seen = new Set<string>();
	const merged: MemoryEvidence[] = [];
	for (const item of lists.flatMap((list) => list ?? [])) {
		const id = `${item.conversationId}:${item.turn}`;
		if (seen.has(id)) continue;
		seen.add(id);
		merged.push({ conversationId: item.conversationId, turn: item.turn });
	}
	return merged.slice(-MAX_MEMORY_EVIDENCE);
}

function autoCount(state: MemoryState, project: string): number {
	return state.entries.filter((entry) => entry.project === project && entry.origin === "auto").length;
}

/**
 * Set-semantics insert of one extracted memory into `draft` (in place): apply(apply(S, t), t) = apply(S, t) up to
 * evidence. An existing key (equal normalized text, or an entry a person already rewrote) keeps its content and revision;
 * an automatic one only gains the new evidence. A forgotten key is not resurrected; the per-project cap and the store
 * headroom bound automatic growth.
 */
export function addAuto(draft: MemoryState, project: string, text: string, maxPerProject: number, provenance?: AutoProvenance): AutoWrite {
	const content = text.normalize("NFC").trim();
	const key = autoKey(project, content);
	const existing = find(draft, key, project);
	if (existing) {
		if (existing.origin === "auto" && provenance?.evidence) existing.evidence = mergeEvidence(existing.evidence, [provenance.evidence]);
		return { key, status: "exists" };
	}
	if (draft.forgotten?.[project]?.includes(key)) return { key, status: "forgotten" };
	if (autoCount(draft, project) >= maxPerProject || draft.entries.length >= MAX_ENTRIES - AUTO_HEADROOM || Buffer.byteLength(content) > MAX_CONTENT_BYTES) {
		return { key, status: "full" };
	}
	draft.entries = [...draft.entries, autoEntry(draft, project, key, content, provenance, provenance?.evidence ? [provenance.evidence] : [])];
	return { key, status: "added" };
}

function autoEntry(draft: MemoryState, project: string, key: string, content: string, provenance: AutoProvenance | undefined, evidence: MemoryEvidence[]): MemoryEntry {
	return {
		key, content, revision: ++draft.revision, project, origin: "auto",
		...(provenance ? { createdAt: provenance.now, updatedAt: provenance.now } : {}),
		...(evidence.length ? { evidence } : {}),
	};
}

export type ReplaceWrite = { key: string; status: AutoWrite["status"] | "protected"; replaced: string[] };

/**
 * Supersede (in place): one extracted memory replaces the automatic entries `replaces` of `project` that it contradicts,
 * updates or merges. All or nothing:
 *   - a listed key that a person wrote (no `auto` origin) protects the set: `protected`, nothing changes;
 *   - a forgotten new text, or no room even after the removals: `forgotten` / `full`, nothing changes;
 *   - otherwise the listed entries are removed and forgotten (a later extraction does not bring them back), and the new
 *     text is added, or, when it already exists, kept and given the evidence. Evidence of the replaced entries carries over.
 * Keys that do not exist (or are the new text's own key) are ignored; with none left this is `addAuto`.
 */
export function replaceAuto(draft: MemoryState, project: string, text: string, replaces: readonly string[], maxPerProject: number, provenance?: AutoProvenance): ReplaceWrite {
	const content = text.normalize("NFC").trim();
	const key = autoKey(project, content);
	const targets = [...new Set(replaces)].filter((item) => item !== key)
		.map((item) => find(draft, item, project)).filter((entry): entry is MemoryEntry => entry !== undefined);
	if (targets.length === 0) return { ...addAuto(draft, project, content, maxPerProject, provenance), replaced: [] };
	if (targets.some((entry) => entry.origin !== "auto")) return { key, status: "protected", replaced: [] };
	if (draft.forgotten?.[project]?.includes(key)) return { key, status: "forgotten", replaced: [] };
	const existing = find(draft, key, project);
	if (!existing && (
		autoCount(draft, project) - targets.length >= maxPerProject
		|| draft.entries.length - targets.length >= MAX_ENTRIES - AUTO_HEADROOM
		|| Buffer.byteLength(content) > MAX_CONTENT_BYTES
	)) return { key, status: "full", replaced: [] };
	const evidence = mergeEvidence(...targets.map((entry) => entry.evidence), existing?.evidence, provenance?.evidence ? [provenance.evidence] : []);
	draft.entries = draft.entries.filter((entry) => !targets.includes(entry));
	for (const entry of targets) forget(draft, project, entry.key);
	if (existing) {
		draft.revision++;
		if (existing.origin === "auto" && evidence.length) existing.evidence = evidence;
		return { key, status: "exists", replaced: targets.map((entry) => entry.key) };
	}
	draft.entries = [...draft.entries, autoEntry(draft, project, key, content, provenance, evidence)];
	return { key, status: "added", replaced: targets.map((entry) => entry.key) };
}
