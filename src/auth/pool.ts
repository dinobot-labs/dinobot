import type { Credential } from "@earendil-works/pi-ai";
import type { AccountInfo } from "./types.ts";

/**
 * Several credentials (OAuth accounts or API keys) stored under one pi-ai provider key, with one active account
 * serving requests. pi-ai reads one credential per provider; the pool decides which one that is.
 *
 * Rotation is sticky failover, not per-request round robin: every request uses the active account until it fails
 * with an account-level error (rate limit, usage limit, rejected credential). That account is then blocked for a
 * while and the next unblocked account becomes active. Staying on one account keeps provider prompt caches warm.
 */

/** Why an account stopped serving: provider rate limit, exhausted plan/quota, or a rejected/unrefreshable credential. */
export type AccountFailureKind = "rate_limit" | "quota" | "auth";

export type AccountFailure = { readonly kind: AccountFailureKind; readonly retryAfterMs?: number };

export type PoolAccount = {
	/** Stable within the pool ("1", "2", ...); never reused while the pool exists. */
	readonly id: string;
	readonly credential: Credential;
	readonly addedAt: number;
	/** The account is skipped by selection until this instant (epoch ms). */
	readonly blockedUntil?: number;
	readonly lastFailure?: AccountFailureKind;
};

export type CredentialPool = {
	readonly active: string;
	readonly accounts: readonly PoolAccount[];
	/** Last id handed out; ids are never reused so a selector cannot silently retarget another account. */
	readonly lastId: number;
};

/** Default block when the provider names no reset time. */
export const DEFAULT_BLOCK_MS: Readonly<Record<AccountFailureKind, number>> = {
	rate_limit: 60_000,
	quota: 60 * 60_000,
	auth: 30 * 60_000,
};

/** Upper bound on a provider-named reset (weekly windows exist), so a misparsed hint cannot park an account forever. */
const MAX_BLOCK_MS = 8 * 24 * 60 * 60_000;

/** Same account iff the provider-reported account and organisation match; one email may hold several orgs/plans. */
export function accountIdentity(credential: Credential): string | undefined {
	if (credential.type === "api_key") return credential.key ? `key:${credential.key}` : undefined;
	const account = stringField(credential, "accountId") ?? stringField(credential, "email")?.toLowerCase();
	if (!account) return undefined;
	const org = stringField(credential, "orgId");
	return org ? `${account}#${org}` : account;
}

/** Display label without secrets: `email (org)`, the account id, or a masked API key. */
export function accountLabel(credential: Credential): string | undefined {
	if (credential.type === "api_key") return credential.key ? maskKey(credential.key) : undefined;
	const account = stringField(credential, "email") ?? stringField(credential, "accountId");
	const org = stringField(credential, "orgName") ?? stringField(credential, "orgId");
	if (account && org && !org.includes(account)) return `${account} (${org})`;
	return org && !account ? org : account;
}

function maskKey(key: string): string {
	return key.length <= 8 ? "****" : `${key.slice(0, 4)}…${key.slice(-4)}`;
}

function stringField(credential: Credential, field: string): string | undefined {
	const value = (credential as Record<string, unknown>)[field];
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** The pool's accounts without secrets, as `/accounts` shows them; block state only while it lasts. */
export function accountInfos(pool: CredentialPool, now: number): AccountInfo[] {
	const active = selectAccount(pool, now).id;
	return pool.accounts.map((account) => {
		const label = accountLabel(account.credential);
		const blocked = isBlocked(account, now);
		return {
			id: account.id,
			type: account.credential.type,
			...(label ? { label } : {}),
			active: account.id === active,
			...(blocked ? { blockedUntil: account.blockedUntil! } : {}),
			...(blocked && account.lastFailure ? { lastFailure: account.lastFailure } : {}),
		};
	});
}

export function isBlocked(account: PoolAccount, now: number): boolean {
	return account.blockedUntil !== undefined && account.blockedUntil > now;
}

export function singleAccountPool(credential: Credential, now: number): CredentialPool {
	return { active: "1", lastId: 1, accounts: [{ id: "1", credential, addedAt: now }] };
}

/**
 * The account that serves the next request: the active one while it is not blocked, else the next unblocked one in
 * pool order after it, else (all blocked) the one whose block ends first.
 */
export function selectAccount(pool: CredentialPool, now: number): PoolAccount {
	const start = Math.max(0, pool.accounts.findIndex((account) => account.id === pool.active));
	const ordered = [...pool.accounts.slice(start), ...pool.accounts.slice(0, start)];
	const free = ordered.find((account) => !isBlocked(account, now));
	if (free) return free;
	return ordered.reduce((best, account) => ((account.blockedUntil ?? 0) < (best.blockedUntil ?? 0) ? account : best));
}

/** The pool with `active` moved to `selectAccount`; the same object when nothing changes. */
export function settle(pool: CredentialPool, now: number): CredentialPool {
	const selected = selectAccount(pool, now);
	return selected.id === pool.active ? pool : { ...pool, active: selected.id };
}

/**
 * Add a login: an account with the same identity is updated in place (and unblocked), otherwise a new account is
 * appended. The logged-in account becomes active either way.
 */
export function upsertAccount(pool: CredentialPool | undefined, credential: Credential, now: number): { pool: CredentialPool; account: PoolAccount; added: boolean } {
	if (!pool) {
		const created = singleAccountPool(credential, now);
		return { pool: created, account: created.accounts[0]!, added: true };
	}
	const identity = accountIdentity(credential);
	const existing = identity === undefined ? undefined : pool.accounts.find((account) => accountIdentity(account.credential) === identity);
	if (existing) {
		const account: PoolAccount = { id: existing.id, credential, addedAt: existing.addedAt };
		return { pool: { ...pool, active: account.id, accounts: pool.accounts.map((entry) => (entry.id === account.id ? account : entry)) }, account, added: false };
	}
	const id = String(pool.lastId + 1);
	const account: PoolAccount = { id, credential, addedAt: now };
	return { pool: { active: id, lastId: pool.lastId + 1, accounts: [...pool.accounts, account] }, account, added: true };
}

/** Replace one account's credential (an OAuth refresh) keeping its id, block state and position. */
export function replaceCredential(pool: CredentialPool, id: string, credential: Credential): CredentialPool {
	return { ...pool, accounts: pool.accounts.map((account) => (account.id === id ? { ...account, credential } : account)) };
}

/** Block one account after a failure and move `active` on; the caller compares `active` to see whether it rotated. */
export function blockAccount(pool: CredentialPool, id: string, failure: AccountFailure, now: number): CredentialPool {
	const duration = Math.min(MAX_BLOCK_MS, Math.max(1_000, failure.retryAfterMs ?? DEFAULT_BLOCK_MS[failure.kind]));
	const accounts = pool.accounts.map((account) =>
		account.id === id ? { ...account, blockedUntil: Math.max(account.blockedUntil ?? 0, now + duration), lastFailure: failure.kind } : account,
	);
	return settle({ ...pool, accounts }, now);
}

/** Make one account active and clear its block (manual switch); undefined for an unknown selector. */
export function activateAccount(pool: CredentialPool, selector: string): CredentialPool | undefined {
	const target = findAccount(pool, selector);
	if (!target) return undefined;
	const { blockedUntil: _blocked, lastFailure: _failure, ...cleared } = target;
	return { ...pool, active: target.id, accounts: pool.accounts.map((account) => (account.id === target.id ? cleared : account)) };
}

/** Remove one account; undefined when the pool becomes empty. Unknown selectors leave the pool unchanged. */
export function removeAccount(pool: CredentialPool, selector: string, now: number): { pool: CredentialPool | undefined; removed?: PoolAccount } {
	const target = findAccount(pool, selector);
	if (!target) return { pool };
	const accounts = pool.accounts.filter((account) => account.id !== target.id);
	if (accounts.length === 0) return { pool: undefined, removed: target };
	const next = { ...pool, accounts, active: pool.active === target.id ? accounts[0]!.id : pool.active };
	return { pool: settle(next, now), removed: target };
}

/** Selector: the account id ("2"), its email or account id (case-insensitive), or its display label. */
export function findAccount(pool: CredentialPool, selector: string): PoolAccount | undefined {
	const wanted = selector.trim().replace(/^#/, "");
	if (wanted === "") return undefined;
	const byId = pool.accounts.find((account) => account.id === wanted);
	if (byId) return byId;
	const lower = wanted.toLowerCase();
	const matches = pool.accounts.filter((account) => {
		const credential = account.credential;
		const names = [stringField(credential, "email"), stringField(credential, "accountId"), accountLabel(credential)];
		return names.some((name) => name?.toLowerCase() === lower);
	});
	return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Classify a failed request's error text. Only failures tied to the account (not the request or the provider's
 * health) rotate: HTTP 429/rate limits, exhausted usage/quota, and rejected or unrefreshable credentials.
 * Overloaded/5xx errors, context overflow and 403 policy refusals do not.
 */
export function classifyAccountFailure(errorMessage: string | undefined): AccountFailure | undefined {
	if (!errorMessage) return undefined;
	const text = errorMessage;
	if (/context[_ ](length|window)|prompt is too long|maximum context|too many tokens|overloaded/i.test(text)) return undefined;
	const retryAfterMs = parseRetryAfterMs(text);
	const withRetry = (kind: AccountFailureKind): AccountFailure => (retryAfterMs === undefined ? { kind } : { kind, retryAfterMs });
	if (/usage[_ ]limit|usage_not_included|insufficient[_ ]quota|exceeded your (current )?quota|quota (exceeded|exhausted)|credit balance is too low|out of credits|billing/i.test(text)) {
		return withRetry("quota");
	}
	if (/\b429\b|rate[_ ]?limit|too many requests/i.test(text)) return withRetry("rate_limit");
	if (/oauth refresh failed|invalid_grant|refresh token|\b401\b|unauthori[sz]ed|invalid[_ ](x-)?api[_ ]key|invalid bearer|authentication[_ ]error|token (has )?(expired|been revoked)|revoked/i.test(text)) {
		return { kind: "auth" };
	}
	return undefined;
}

const UNIT_MS: Readonly<Record<string, number>> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Reset hints providers put in error text: `resets_in_seconds`, `resets_at` (epoch s), `try again in ~5 min`, `retry after 30s`. */
export function parseRetryAfterMs(text: string, now = Date.now()): number | undefined {
	const seconds = /"?resets?_in_seconds"?\s*[:=]\s*(\d+(?:\.\d+)?)/i.exec(text);
	if (seconds) return Number(seconds[1]) * 1000;
	const at = /"?resets?_at"?\s*[:=]\s*(\d{9,13})/i.exec(text);
	if (at) {
		const value = Number(at[1]);
		const ms = value < 1e12 ? value * 1000 : value;
		return ms > now ? ms - now : undefined;
	}
	const phrase = /(?:try again|retry|resets?)\s+(?:in|after)\s+~?\s*(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)\b/i.exec(text);
	if (phrase) {
		const factor = UNIT_MS[phrase[2]!.toLowerCase().slice(0, 1)];
		if (factor) return Number(phrase[1]) * factor;
	}
	return undefined;
}
