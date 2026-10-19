import type { Context, Draft } from "@earendil-works/chord";
import { defineDoc, type Harness } from "@earendil-works/pi-durable";

/**
 * Work claims: durable leases that keep two threads from doing the same work at once.
 *
 * A claim key is a resource path such as `repo:dinobot/src/api`. Two keys overlap when one's segment list is a
 * prefix of the other's, so `repo:x` covers `repo:x/src` and both conflict with each other, while `repo:x/src` and
 * `repo:x/docs` do not. Every change runs inside one Session commit, and the Session serializes commits, so acquire is
 * an atomic compare-and-set over the whole claim set. The invariant it keeps: no two live claims of different holders
 * overlap. Leases expire at `expiresAt`; the holder renews by claiming the same key again. `token` is a fencing token:
 * it strictly increases across grants, so a holder whose lease lapsed and was re-granted elsewhere can be told apart.
 *
 * A claim is two independent parts (ADR 0079): the holder's lease (`expiresAt`, ended by TTL or `work_release`) and an
 * effect fence (`quarantined`, set while an effect that may touch the resource is not proven finished). A claim is
 * live while either part holds: live(c) = fenced(c) ∨ expiresAt(c) > now. Ending the lease never drops a fence, and
 * clearing a fence never ends a lease; `unfence` is the single place a fence is cleared.
 *
 * Holder identity stays exact (a subagent is `conversation:<id>`, never its parent's thread key), so cleanup and fences
 * only ever touch tokens their owner acquired. A request may name `ancestors`: the holders of the conversations that
 * delegated to the requester. An unfenced ancestor claim does not block it, because the delegating thread asked for the
 * work; a fenced one still does, since an effect behind it is not proven finished. Siblings and every other holder
 * still conflict, so the invariant becomes: no two live claims overlap unless one holder is an ancestor of the other.
 */
export type Claim = {
	/** Unknown tracked effects prevent expiry/release from silently admitting an overlapping writer. */
	quarantined?: string;
	key: string;
	/** `channel:threadKey`, or `conversation:<id>` for a conversation that is not a thread (a subagent). */
	holder: string;
	intent: string;
	token: number;
	acquiredAt: number;
	expiresAt: number;
};

export type ClaimsState = { nextToken: number; claims: Claim[] };

export const ClaimsDoc = defineDoc<ClaimsState>({
	kind: "dinobot.claims",
	version: 1,
	scope: "session",
	initial: () => ({ nextToken: 1, claims: [] }),
});

export const DEFAULT_CLAIM_TTL_MS = 30 * 60_000;
export const MIN_CLAIM_TTL_MS = 60_000;
export const MAX_CLAIM_TTL_MS = 24 * 60 * 60_000;
/** A fence ends on OS evidence, which has no change event when an orphaned process exits; waiters re-check this often. */
export const FENCE_RECHECK_MS = 5_000;
/** Fence causes that canonical settlement or OS process evidence may clear. Any other cause belongs to its own owner. */
export const NATIVE_QUARANTINE_REASONS: readonly string[] = ["UNKNOWN native process provenance", "UNKNOWN prior native provenance"];
const MAX_KEY_LENGTH = 200;

export type ClaimResult =
	| { status: "granted" | "renewed"; claim: Claim }
	| { status: "conflict"; conflicts: Claim[] };

/** Lowercased, trimmed, `/`-separated with empty segments dropped; an error message when unusable. */
export function normalizeKey(raw: string): string | { error: string } {
	const key = raw.trim().toLowerCase().split("/").map((segment) => segment.trim()).filter(Boolean).join("/");
	if (key === "") return { error: "key must name a resource, e.g. repo:dinobot/src/api" };
	if (key.length > MAX_KEY_LENGTH) return { error: `key must be at most ${MAX_KEY_LENGTH} characters` };
	return key;
}

/** True when one key's segments are a prefix of the other's: the resources nest. */
export function overlaps(a: string, b: string): boolean {
	const left = a.split("/");
	const right = b.split("/");
	const shorter = Math.min(left.length, right.length);
	for (let index = 0; index < shorter; index++) if (left[index] !== right[index]) return false;
	return true;
}

export function clampTtl(ttlMs: number | undefined): number {
	if (ttlMs === undefined || !Number.isFinite(ttlMs)) return DEFAULT_CLAIM_TTL_MS;
	return Math.min(MAX_CLAIM_TTL_MS, Math.max(MIN_CLAIM_TTL_MS, Math.round(ttlMs)));
}

/** True when `claim` blocks `request`: another holder's overlapping claim that is not an unfenced ancestor's. */
export function blocks(claim: Claim, request: { key: string; holder: string; ancestors?: readonly string[] }): boolean {
	if (claim.holder === request.holder || !overlaps(claim.key, request.key)) return false;
	return claim.quarantined !== undefined || !(request.ancestors?.includes(claim.holder) ?? false);
}

function live(state: Draft<ClaimsState> | ClaimsState, now: number): Claim[] {
	return state.claims.filter((claim) => claim.quarantined !== undefined || claim.expiresAt > now);
}

/** Acquire or renew `key` for `holder`. Call inside one commit; prunes expired claims as it goes. */
export function acquire(
	state: Draft<ClaimsState>,
	request: ClaimRequest,
	now: number,
): ClaimResult {
	state.claims = live(state, now);
	const conflicts = state.claims.filter((claim) => blocks(claim, request));
	if (conflicts.length > 0) return { status: "conflict", conflicts: conflicts.map((claim) => ({ ...claim })) };
	const mine = state.claims.find((claim) => claim.holder === request.holder && claim.key === request.key);
	if (mine) {
		mine.expiresAt = now + request.ttlMs;
		mine.intent = request.intent;
		return { status: "renewed", claim: { ...mine } };
	}
	const claim: Claim = {
		key: request.key,
		holder: request.holder,
		intent: request.intent,
		token: state.nextToken,
		acquiredAt: now,
		expiresAt: now + request.ttlMs,
	};
	state.nextToken += 1;
	state.claims.push(claim);
	return { status: "granted", claim: { ...claim } };
}

/**
 * Release `holder`'s claim on `key`, or every claim it holds when `key` is undefined. Returns what was removed.
 * A fenced match only ends its lease (expiresAt := min(expiresAt, now)); the fence keeps it live until `unfence`,
 * which then drops it, so a release requested during an unfinished effect is never lost and never premature.
 */
export function release(state: Draft<ClaimsState>, holder: string, key: string | undefined, now: number): Claim[] {
	const released: Claim[] = [];
	state.claims = live(state, now).filter((claim) => {
		const match = claim.holder === holder && (key === undefined || claim.key === key);
		if (match && claim.quarantined !== undefined) claim.expiresAt = Math.min(claim.expiresAt, now);
		else if (match) released.push({ ...claim });
		return !match || claim.quarantined !== undefined;
	});
	return released;
}

/**
 * Clear the fence of exactly this token (key, holder, token). The lease is untouched: a claim whose lease already ended
 * (TTL or release) disappears, any other stays held by its holder. Callers must already hold the evidence that every
 * effect behind the fence finished. Returns what happened, or undefined when no such fenced claim exists.
 */
export function unfence(state: Draft<ClaimsState>, token: { key: string; holder: string; token: number }, now: number): { outcome: "released" | "unfenced"; claim: Claim } | undefined {
	const current = state.claims.find((claim) => claim.key === token.key && claim.holder === token.holder && claim.token === token.token);
	if (!current || current.quarantined === undefined) return undefined;
	delete current.quarantined;
	const claim = { ...current };
	if (current.expiresAt > now) return { outcome: "unfenced", claim };
	state.claims = state.claims.filter((c) => c !== current);
	return { outcome: "released", claim };
}

export const MAX_CLAIM_WAIT_MS = 45_000;
/** `ancestors`: holders of the conversations that delegated to `holder`, nearest first (see the module comment). */
export type ClaimRequest = { key: string; holder: string; intent: string; ttlMs: number; ancestors?: readonly string[] };
export type ClaimToolResult = {
	text: string; isError: boolean; claims: Claim[];
	/** Optional for receipts written before bounded waiting was introduced. */
	status?: "granted" | "renewed" | "conflict" | "timeout" | "lapsed";
	deadlineAt?: number;
	retryAt?: number;
};
export type ClaimReceipt = { result?: ClaimToolResult; deadlineAt?: number };
export type ClaimWaiting = { status: "waiting"; claims: Claim[]; deadlineAt: number; retryAt: number };

function conflictText(key: string, conflicts: readonly Claim[], now: number): string {
	const quarantined = conflicts.some((claim) => claim.quarantined !== undefined)
		? "\nA quarantined claim does not expire by TTL; dinobot re-checks it automatically on every claim attempt and wait, and releases it as soon as the OS proves its recorded process tree exited. A plugin call interrupted by a daemon crash has no OS evidence and needs the operator's audited abandonment (diagnosis: GET /v1/claims/quarantine)."
		: "";
	return `Conflict: ${key} overlaps work another thread holds.\n${conflicts.map((claim) => `- ${describeClaim(claim, now)}`).join("\n")}\nDo not duplicate it or blindly retry an unchanged conflict; coordinate with that thread or use bounded wait_ms. Claims are advisory leases, not filesystem locks; no FIFO fairness is promised.${quarantined}`;
}

/** Earliest instant a TTL expiry can change the conflict. Quarantined claims never expire, so they contribute none. */
function expiryRetry(conflicts: readonly Claim[]): number | undefined {
	const expiries = conflicts.filter((claim) => claim.quarantined === undefined).map((claim) => claim.expiresAt);
	return expiries.length ? Math.min(...expiries) : undefined;
}

/** A fenced blocker can end without any claim change (an orphan exits); re-check it at a bounded interval. */
function fenceRetry(conflicts: readonly Claim[], now: number): number {
	return conflicts.some((claim) => claim.quarantined !== undefined) ? now + FENCE_RECHECK_MS : Number.POSITIVE_INFINITY;
}

/**
 * `work_claim` inside one commit, safe to replay: the first run stores a deadline (opt-in wait) or terminal result.
 * A conflicting wait stores no terminal failure until its original deadline. Callers wake only on claim changes,
 * earliest blocker expiry, or deadline, and re-enter this same atomic transition.
 * A replay returns that result only while the very lease it granted (holder, key, token) is still live; once it lapsed,
 * the replay reports who holds the key now instead of claiming success for a lease another thread may have taken.
 */
export function claimOnce(receipt: Draft<ClaimReceipt>, state: Draft<ClaimsState>, request: ClaimRequest & { waitMs: number }, now: number): ClaimToolResult | ClaimWaiting;
export function claimOnce(receipt: Draft<ClaimReceipt>, state: Draft<ClaimsState>, request: ClaimRequest, now: number): ClaimToolResult;
export function claimOnce(
	receipt: Draft<ClaimReceipt>,
	state: Draft<ClaimsState>,
	request: ClaimRequest & { waitMs?: number },
	now: number,
): ClaimToolResult | ClaimWaiting {
	if (receipt.result) {
		const prior = JSON.parse(JSON.stringify(receipt.result)) as ClaimToolResult;
		const granted = prior.claims[0];
		if (prior.isError || granted === undefined) return prior;
		const current = live(state, now).filter((claim) => overlaps(claim.key, granted.key));
		const still = current.find((claim) => claim.holder === granted.holder && claim.key === granted.key && claim.token === granted.token);
		if (still) return { ...prior, isError: false, claims: [{ ...still }], text: `${prior.text.split(" ")[0]} ${describeClaim(still, now)}` };
		return {
			status: "lapsed",
			...(receipt.deadlineAt === undefined ? {} : { deadlineAt: receipt.deadlineAt }),
			isError: true,
			claims: current.map((claim) => ({ ...claim })),
			text: `The claim on ${granted.key} (token ${granted.token}) from this call has lapsed${current.length ? `; it is now held by:\n${current.map((claim) => `- ${describeClaim(claim, now)}`).join("\n")}` : "."}\nClaim it again before continuing.`,
		};
	}
	// Only the first attempt establishes the budget. A terminal receipt above always wins,
	// including legacy failures; replay cannot turn an old conflict into a fresh acquisition.
	const waitMs = Number.isFinite(request.waitMs) ? Math.min(MAX_CLAIM_WAIT_MS, Math.max(0, Math.round(request.waitMs!))) : 0;
	if (receipt.deadlineAt === undefined && waitMs > 0) receipt.deadlineAt = now + waitMs;
	const deadlineAt = receipt.deadlineAt;
	const conflicts = live(state, now).filter((claim) => blocks(claim, request)).map((claim) => ({ ...claim }));
	if (deadlineAt !== undefined) {
		// Deadline wins even if a release/expiry became visible while the process was down.
		if (now >= deadlineAt) {
			const result: ClaimToolResult = {
				status: "timeout", isError: true, claims: conflicts, deadlineAt,
				text: "Claim wait timed out for " + request.key + ". No claim was granted. " +
					(conflicts.length ? conflictText(request.key, conflicts, now) : "Reassess before making a new claim call."),
			};
			receipt.result = result;
			return JSON.parse(JSON.stringify(result)) as ClaimToolResult;
		}
		if (conflicts.length) return { status: "waiting", claims: conflicts, deadlineAt, retryAt: Math.min(deadlineAt, expiryRetry(conflicts) ?? deadlineAt, fenceRetry(conflicts, now)) };
	}
	const outcome = acquire(state, request, now);
	const retryAt = outcome.status === "conflict" ? expiryRetry(outcome.conflicts) : undefined;
	const result: ClaimToolResult = outcome.status === "conflict"
		? { status: "conflict", isError: true, claims: outcome.conflicts, ...(retryAt === undefined ? {} : { retryAt }), text: conflictText(request.key, outcome.conflicts, now) }
		: { status: outcome.status, ...(deadlineAt === undefined ? {} : { deadlineAt }), isError: false, claims: [outcome.claim], text: `${outcome.status === "granted" ? "Claimed" : "Renewed"} ${describeClaim(outcome.claim, now)}` };
	receipt.result = result;
	return JSON.parse(JSON.stringify(result)) as ClaimToolResult;
}

/** `work_release` inside one commit, safe to replay: a replay returns what the first run released and removes nothing else. */
export function releaseOnce(
	receipt: Draft<{ released?: Claim[] }>,
	state: Draft<ClaimsState>,
	holder: string,
	key: string | undefined,
	now: number,
): Claim[] {
	if (receipt.released) return JSON.parse(JSON.stringify(receipt.released)) as Claim[];
	const released = release(state, holder, key, now);
	receipt.released = released;
	return JSON.parse(JSON.stringify(released)) as Claim[];
}

/** Unexpired claims, oldest grant first. Read-only. */
export async function liveClaims(harness: Harness, context: Context, now = Date.now()): Promise<Claim[]> {
	const state = await harness.snapshot(ClaimsDoc, context);
	return state ? live(state, now).map((claim) => ({ ...claim })).sort((a, b) => a.token - b.token) : [];
}

/** A quarantined claim shows its cause instead of a TTL countdown: expiry does not release it. */
export function describeClaim(claim: Claim, now: number): string {
	if (claim.quarantined !== undefined) return `${claim.key} held by ${claim.holder} (token ${claim.token}, quarantined: ${claim.quarantined}; TTL does not release it): ${claim.intent}`;
	const minutes = Math.max(0, Math.round((claim.expiresAt - now) / 60_000));
	return `${claim.key} held by ${claim.holder} (token ${claim.token}, ${minutes}m left): ${claim.intent}`;
}
