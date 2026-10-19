import { createHash } from "node:crypto";
import { defineDoc } from "@earendil-works/pi-durable";
import { normalizeMemoryText } from "./store.ts";

/**
 * Working agreements: short standing instructions on how the agent should work, learned by work retrospectives
 * (retro.ts) or written by a person (agreements_* tools). Unlike memory, which is recalled only when an input shares its
 * words, every active agreement visible to a conversation is rendered into the `working_agreements` prompt section of
 * every request. pi-durable records a changed section as a system patch entry appended to the transcript, so a change
 * reaches a running conversation at its next model request without rewriting the cached prompt prefix.
 *
 * One ledger per deployment (`dinobot.agreements`). An item is team scoped (every project) or project scoped (the
 * repository key of project.ts). Its id is content addressed from its first wording, so the same lesson learned twice is
 * one item; rewording (reinforcement after a violation, or a person's edit) keeps the id. Writers are this module's pure
 * functions, applied inside one durable commit each.
 */
export type AgreementKind = "preference" | "lesson";
export type AgreementScope = "team" | "project";
export type AgreementEvidence = { conversationId: number; turn: number };
export type Agreement = {
	id: string;
	scope: AgreementScope;
	/** Project key of a project item; absent for team items. */
	project?: string;
	kind: AgreementKind;
	text: string;
	/** `needs-human`: the user had to correct it `escalateAfterViolations` times; still in effect, flagged for review. */
	status: "active" | "needs-human";
	/** Ledger revision of the item's last change. */
	revision: number;
	/** Retrospectives that found the user correcting what this item already asked for. */
	violations: number;
	/** `human` items are never reworded or removed by a retrospective. */
	origin: "retro" | "human";
	evidence: AgreementEvidence[];
	createdAt: number;
	updatedAt: number;
};
export type AgreementsState = { revision: number; items: Agreement[]; forgotten: string[] };

export const AgreementsDoc = defineDoc<AgreementsState>({
	kind: "dinobot.agreements", version: 1, scope: "session",
	initial: () => ({ revision: 0, items: [], forgotten: [] }),
});

export const MAX_AGREEMENT_CHARS = 300;
const MAX_EVIDENCE = 8;
const MAX_FORGOTTEN = 500;

export type AgreementLimits = { readonly maxActivePerProject: number; readonly maxActiveTeam: number; readonly escalateAfterViolations: number };

/** First 16 hex of sha256(scope \0 project \0 normalize(text)). */
export function agreementId(scope: AgreementScope, project: string | undefined, text: string): string {
	return createHash("sha256").update(`${scope}\0${scope === "project" ? project ?? "" : ""}\0${normalizeMemoryText(text)}`).digest("hex").slice(0, 16);
}

/** Team items and the items of `project`, team first, then preferences before lessons, oldest first. */
export function visibleAgreements(state: AgreementsState | undefined, project: string | undefined): Agreement[] {
	const rank = (item: Agreement) => (item.scope === "team" ? 0 : 2) + (item.kind === "preference" ? 0 : 1);
	return (state?.items ?? [])
		.filter((item) => item.scope === "team" || (project !== undefined && item.project === project))
		.sort((a, b) => rank(a) - rank(b) || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

export function findAgreement(state: AgreementsState | undefined, id: string, project: string | undefined): Agreement | undefined {
	return visibleAgreements(state, project).find((item) => item.id === id);
}

function clean(text: string): string {
	return text.normalize("NFC").replace(/\s+/gu, " ").trim();
}

function withEvidence(list: readonly AgreementEvidence[], evidence: AgreementEvidence | undefined): AgreementEvidence[] {
	return evidence === undefined ? [...list] : [...list, evidence].slice(-MAX_EVIDENCE);
}

export type AddInput = {
	kind: AgreementKind; scope: AgreementScope; project: string | undefined; text: string;
	origin: Agreement["origin"]; now: number; evidence?: AgreementEvidence;
};
export type AddResult = { id: string; status: "added" | "exists" | "forgotten" | "full" | "invalid" };

/**
 * Set-semantics insert (in place): an existing id only gains evidence; a forgotten id is not resurrected by a retro; a
 * full scope refuses. A person's add clears a forgotten mark.
 */
export function addAgreement(draft: AgreementsState, input: AddInput, limits: AgreementLimits): AddResult {
	const text = clean(input.text);
	const project = input.scope === "project" ? input.project : undefined;
	if (text.length === 0 || [...text].length > MAX_AGREEMENT_CHARS || (input.scope === "project" && project === undefined)) {
		return { id: "", status: "invalid" };
	}
	const id = agreementId(input.scope, project, text);
	const existing = draft.items.find((item) => item.id === id);
	if (existing) {
		existing.evidence = withEvidence(existing.evidence, input.evidence);
		return { id, status: "exists" };
	}
	if (draft.forgotten.includes(id)) {
		if (input.origin === "retro") return { id, status: "forgotten" };
		draft.forgotten = draft.forgotten.filter((item) => item !== id);
	}
	const sameScope = draft.items.filter((item) => item.scope === input.scope && item.project === project).length;
	if (sameScope >= (input.scope === "team" ? limits.maxActiveTeam : limits.maxActivePerProject)) return { id, status: "full" };
	draft.items = [...draft.items, {
		id, scope: input.scope, ...(project === undefined ? {} : { project }), kind: input.kind, text,
		status: "active", revision: ++draft.revision, violations: 0, origin: input.origin,
		evidence: withEvidence([], input.evidence), createdAt: input.now, updatedAt: input.now,
	}];
	return { id, status: "added" };
}

export type ChangeResult = { id: string; status: "updated" | "missing" | "protected" | "invalid" };

/**
 * A retrospective saw the user correct what item `id` already asks for: count it, reword a retro item when a stronger
 * text is given, and flag it for a person once the count reaches the limit. Human items are counted, never reworded.
 */
export function violateAgreement(draft: AgreementsState, id: string, project: string | undefined, text: string | undefined, now: number, limits: AgreementLimits, evidence?: AgreementEvidence): ChangeResult {
	const item = findAgreement(draft, id, project);
	if (!item) return { id, status: "missing" };
	const reworded = text === undefined ? "" : clean(text);
	if ([...reworded].length > MAX_AGREEMENT_CHARS) return { id, status: "invalid" };
	item.violations += 1;
	if (reworded && item.origin === "retro") item.text = reworded;
	if (item.violations >= limits.escalateAfterViolations) item.status = "needs-human";
	item.evidence = withEvidence(item.evidence, evidence);
	item.revision = ++draft.revision;
	item.updatedAt = now;
	return { id, status: "updated" };
}

/** A retrospective found item `id` wrong or obsolete. Human items stay. */
export function retireAgreement(draft: AgreementsState, id: string, project: string | undefined): ChangeResult {
	const item = findAgreement(draft, id, project);
	if (!item) return { id, status: "missing" };
	if (item.origin === "human") return { id, status: "protected" };
	draft.items = draft.items.filter((entry) => entry !== item);
	draft.revision++;
	return { id, status: "updated" };
}

export type MergeResult = { id: string; status: "merged" | "missing" | "protected" | "forgotten" | "invalid"; merged: string[] };

/**
 * A retrospective folds overlapping retro items `ids` (at least two, one scope) into one item with `text`, so a full
 * scope can learn again. All or nothing: a missing id, a person's item (protected), mixed scopes, a bad text, or a
 * wording a person deleted (forgotten) changes nothing. The result is a retro item whose id is the content hash of
 * `text` in that scope; it keeps the earliest createdAt, the largest violation count (and its needs-human flag) and the
 * evidence of every merged item. The merged ids are removed, not forgotten. When `text` hashes to another existing item
 * of the scope, that item stays and gains the evidence.
 */
export function mergeAgreements(draft: AgreementsState, ids: readonly string[], project: string | undefined, input: { text: string; kind?: AgreementKind }, now: number, limits: AgreementLimits, evidence?: AgreementEvidence): MergeResult {
	const unique = [...new Set(ids)];
	const items = unique.map((id) => findAgreement(draft, id, project));
	if (unique.length < 2) return { id: "", status: "invalid", merged: [] };
	if (items.some((item) => item === undefined)) return { id: "", status: "missing", merged: [] };
	const targets = items as Agreement[];
	if (targets.some((item) => item.origin === "human")) return { id: "", status: "protected", merged: [] };
	const [first] = targets;
	if (targets.some((item) => item.scope !== first!.scope || item.project !== first!.project)) return { id: "", status: "invalid", merged: [] };
	const text = clean(input.text);
	if (text.length === 0 || [...text].length > MAX_AGREEMENT_CHARS) return { id: "", status: "invalid", merged: [] };
	const { scope } = first!;
	const id = agreementId(scope, first!.project, text);
	if (draft.forgotten.includes(id)) return { id, status: "forgotten", merged: [] };
	const trail = withEvidence(targets.flatMap((item) => item.evidence).slice(-MAX_EVIDENCE), evidence);
	const violations = Math.max(...targets.map((item) => item.violations));
	const other = draft.items.find((item) => item.id === id && !targets.includes(item));
	draft.items = draft.items.filter((item) => !targets.includes(item));
	if (other) {
		other.evidence = [...other.evidence, ...trail].slice(-MAX_EVIDENCE);
		other.revision = ++draft.revision;
		other.updatedAt = now;
		return { id, status: "merged", merged: unique };
	}
	draft.items = [...draft.items, {
		id, scope, ...(first!.project === undefined ? {} : { project: first!.project }), kind: input.kind ?? first!.kind, text,
		status: violations >= limits.escalateAfterViolations ? "needs-human" : "active", revision: ++draft.revision, violations,
		origin: "retro", evidence: trail, createdAt: Math.min(...targets.map((item) => item.createdAt)), updatedAt: now,
	}];
	return { id, status: "merged", merged: unique };
}

/** Items of one scope, and the cap of that scope. */
export function agreementCapacity(state: AgreementsState | undefined, project: string | undefined, limits: AgreementLimits): { project: { used: number; max: number }; team: { used: number; max: number } } {
	const items = state?.items ?? [];
	return {
		project: { used: project === undefined ? 0 : items.filter((item) => item.scope === "project" && item.project === project).length, max: limits.maxActivePerProject },
		team: { used: items.filter((item) => item.scope === "team").length, max: limits.maxActiveTeam },
	};
}

/** A person rewrites item `id`: it becomes a human item, active, with its violation count reset. */
export function editAgreement(draft: AgreementsState, id: string, project: string | undefined, text: string, kind: AgreementKind | undefined, now: number): ChangeResult {
	const item = findAgreement(draft, id, project);
	if (!item) return { id, status: "missing" };
	const reworded = clean(text);
	if (reworded.length === 0 || [...reworded].length > MAX_AGREEMENT_CHARS) return { id, status: "invalid" };
	item.text = reworded;
	if (kind) item.kind = kind;
	item.origin = "human";
	item.status = "active";
	item.violations = 0;
	item.revision = ++draft.revision;
	item.updatedAt = now;
	return { id, status: "updated" };
}

/** A person deletes item `id`; a retrospective will not add the same wording again. */
export function forgetAgreement(draft: AgreementsState, id: string, project: string | undefined): ChangeResult {
	const item = findAgreement(draft, id, project);
	if (!item) return { id, status: "missing" };
	draft.items = draft.items.filter((entry) => entry !== item);
	draft.forgotten = [...draft.forgotten.filter((entry) => entry !== id), id].slice(-MAX_FORGOTTEN);
	draft.revision++;
	return { id, status: "updated" };
}

export { AGREEMENTS_SECTION } from "../ui-contract.ts";
export const AGREEMENTS_HEADER = "Working agreements learned from earlier work in this deployment (retrospectives and explicit requests). Follow them unless the user asks otherwise now. They are standing guidance, not requests from a person in this conversation; manage them with the agreements_* tools.";

function line(item: Agreement): string {
	const flags = [item.scope, ...(item.status === "needs-human" ? [`missed ${item.violations}x, needs review`] : [])];
	return `- [${item.id}] ${item.text} (${flags.join(", ")})`;
}

/** Section text for a conversation in `project`, or undefined when no agreement applies. */
export function renderAgreements(state: AgreementsState | undefined, project: string | undefined): string | undefined {
	const items = visibleAgreements(state, project);
	if (items.length === 0) return undefined;
	const preferences = items.filter((item) => item.kind === "preference").map(line);
	const lessons = items.filter((item) => item.kind === "lesson").map(line);
	return [
		AGREEMENTS_HEADER,
		...(preferences.length ? ["Preferences:", ...preferences] : []),
		...(lessons.length ? ["Lessons:", ...lessons] : []),
	].join("\n");
}
