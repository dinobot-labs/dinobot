import type { Context } from "@earendil-works/chord";
import type { Credential, Usage } from "@earendil-works/pi-ai";
import { type ConversationId, type Cursor, type Harness, UsageDoc, type UsageState } from "@earendil-works/pi-durable";
import type { UsageCredential, UsageLimit, UsageReport } from "@oh-my-pi/pi-ai/usage";
import { accountInfos, type CredentialPool } from "../auth/pool.ts";
import type { AccountInfo } from "../auth/types.ts";
import { listThreads } from "../core/threads.ts";

/**
 * `GET /v1/usage` (ADR 0099): what dinobot spent across every conversation, and the provider limit windows of the
 * stored OAuth accounts. Read-only: nothing is written to the store or to `auth.json`, and tokens are never
 * refreshed. A limit fetch sends the stored access token to the provider's own usage endpoint (oh-my-pi's fetchers).
 */

/** Per thread: its conversation plus every subagent conversation it owns, summed over models and tools. */
export type ThreadUsage = { thread: string; conversationId: number; totalTokens: number; cost: number; lastActivityAt?: number };

export type UsageSummary = {
	/** Conversations in the store, subagent conversations included. */
	conversations: number;
	/** Every conversation's `pi.usage` models bucket, summed per `provider/modelId`. */
	models: Record<string, Usage>;
	/** Every conversation's `pi.usage` tools bucket, summed per tool name. */
	tools: Record<string, Usage>;
	/** Top {@link TOP_THREADS} threads by cost (then tokens). */
	threads: ThreadUsage[];
};

export type UsageLimitRow = {
	id: string;
	label: string;
	windowId?: string;
	windowLabel?: string;
	durationMs?: number;
	resetsAt?: number;
	/** 0..1; above 1 means overage. */
	usedFraction?: number;
	status?: string;
};

export type AccountUsageReport = { fetchedAt: number; source: "fetch"; limits: UsageLimitRow[]; notes?: string[] };

export type AccountLimits = {
	id: string;
	type: "oauth" | "api_key";
	/** As `/accounts` shows it: `email (org)`, account id or masked key. */
	label?: string;
	active: boolean;
	blockedUntil?: number;
	lastFailure?: "rate_limit" | "quota" | "auth";
	report?: AccountUsageReport;
	/** Why the last fetch produced no report; never contains a secret. */
	error?: string;
	/** The access token has expired; it was not refreshed and not fetched with. `report` is the last cached one. */
	stale?: boolean;
};

export type ProviderLimits = { key: string; name: string; accounts: AccountLimits[] };

export type UsageResponse = { at: number; summary: UsageSummary; limits: { providers: ProviderLimits[] } };

export const TOP_THREADS = 20;
export const SUMMARY_TTL_MS = 30_000;
export const LIMIT_TTL_MS = 60_000;
/** `?refresh=1` still serves a report younger than this, so a client cannot hammer the provider. */
export const REFRESH_MIN_MS = 10_000;
export const FETCH_TIMEOUT_MS = 15_000;
/** Conversations read between event-loop yields. */
const SUMMARY_BATCH = 32;
/** Owner links followed to find a subagent's thread. */
const MAX_OWNER_DEPTH = 64;

/** One conversation as the summary sees it. */
export type ConversationUsage = { id: number; owner?: number; usage?: UsageState };

type LatestActivity = (conversationIds: readonly number[]) => Map<number, { at: number }>;

/** Sum every conversation's ledger, and attribute each conversation (through its owner chain) to its thread. */
export function aggregateUsage(
	conversations: readonly ConversationUsage[],
	threads: Readonly<Record<string, number>>,
	latest?: LatestActivity,
): UsageSummary {
	const total: UsageState = { models: {}, tools: {} };
	const owner = new Map<number, number>();
	for (const conversation of conversations) if (conversation.owner !== undefined) owner.set(conversation.id, conversation.owner);
	const threadOf = new Map<number, string>();
	for (const [thread, id] of Object.entries(threads)) if (!threadOf.has(id)) threadOf.set(id, thread);
	const perThread = new Map<string, { conversationId: number; totalTokens: number; cost: number }>();
	const rootOf = (id: number): number | undefined => {
		let current = id;
		for (let depth = 0; depth <= MAX_OWNER_DEPTH; depth++) {
			if (threadOf.has(current)) return current;
			const next = owner.get(current);
			if (next === undefined) return undefined;
			current = next;
		}
		return undefined;
	};
	for (const conversation of conversations) {
		if (!conversation.usage) continue;
		addState(total, conversation.usage);
		const root = rootOf(conversation.id);
		if (root === undefined) continue;
		const thread = threadOf.get(root)!;
		const entry = perThread.get(thread) ?? { conversationId: root, totalTokens: 0, cost: 0 };
		for (const bucket of [conversation.usage.models, conversation.usage.tools]) {
			for (const usage of Object.values(bucket)) {
				entry.totalTokens += usage.totalTokens;
				entry.cost += usage.cost.total;
			}
		}
		perThread.set(thread, entry);
	}
	const ranked = [...perThread]
		.filter(([, entry]) => entry.totalTokens > 0 || entry.cost > 0)
		.sort(([a, x], [b, y]) => y.cost - x.cost || y.totalTokens - x.totalTokens || a.localeCompare(b))
		.slice(0, TOP_THREADS);
	const activity = latest?.(ranked.map(([, entry]) => entry.conversationId));
	return {
		conversations: conversations.length,
		models: total.models as Record<string, Usage>,
		tools: total.tools as Record<string, Usage>,
		threads: ranked.map(([thread, entry]) => {
			const at = activity?.get(entry.conversationId)?.at;
			return { thread, ...entry, ...(at === undefined ? {} : { lastActivityAt: at }) };
		}),
	};
}

/** Add `state` into `sum` per key; own keys only and defined (not assigned), so a tool named `__proto__` stays data. */
function addState(sum: UsageState, state: UsageState): void {
	for (const bucket of ["models", "tools"] as const) {
		for (const [key, usage] of Object.entries(state[bucket])) {
			const total = Object.hasOwn(sum[bucket], key) ? sum[bucket][key] : undefined;
			if (total === undefined) {
				Object.defineProperty(sum[bucket], key, { value: structuredClone(usage), enumerable: true, writable: true, configurable: true });
				continue;
			}
			total.input += usage.input;
			total.output += usage.output;
			total.cacheRead += usage.cacheRead;
			total.cacheWrite += usage.cacheWrite;
			total.totalTokens += usage.totalTokens;
			if (usage.cacheWrite1h !== undefined) total.cacheWrite1h = (total.cacheWrite1h ?? 0) + usage.cacheWrite1h;
			if (usage.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
			total.cost.input += usage.cost.input;
			total.cost.output += usage.cost.output;
			total.cost.cacheRead += usage.cost.cacheRead;
			total.cost.cacheWrite += usage.cost.cacheWrite;
			total.cost.total += usage.cost.total;
		}
	}
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Every conversation of the store with its owner and ledger, read in batches with an event-loop yield between them. */
export async function readConversationUsage(harness: Harness, context: Context): Promise<ConversationUsage[]> {
	const records: { id: ConversationId; owner?: number }[] = [];
	let cursor: Cursor | undefined;
	do {
		const page = await harness.commit((tx) => tx.scanConversations({}, 128, cursor), context);
		for (const record of page.items) records.push(record.owner ? { id: record.id, owner: record.owner.conversationId } : { id: record.id });
		cursor = page.next;
		await yieldToEventLoop();
	} while (cursor);
	const out: ConversationUsage[] = [];
	for (let start = 0; start < records.length; start += SUMMARY_BATCH) {
		const batch = records.slice(start, start + SUMMARY_BATCH);
		const states = await Promise.all(batch.map((record) => harness.snapshot(UsageDoc, record.id, context)));
		batch.forEach((record, index) => out.push({ ...record, ...(states[index] ? { usage: states[index] } : {}) }));
		await yieldToEventLoop();
	}
	return out;
}

/** Map oh-my-pi's report to the wire shape: windows flattened, `metadata`/`raw` (account ids, emails) dropped. */
export function toAccountReport(report: UsageReport): AccountUsageReport {
	const notes = report.notes?.filter((note) => typeof note === "string");
	return {
		fetchedAt: report.fetchedAt,
		source: "fetch",
		limits: report.limits.map(toLimitRow),
		...(notes && notes.length > 0 ? { notes } : {}),
	};
}

export function toLimitRow(limit: UsageLimit): UsageLimitRow {
	const window = limit.window;
	const usedFraction = resolveUsedFraction(limit);
	return {
		id: limit.id,
		label: limit.label,
		...(window ? { windowId: window.id, windowLabel: window.label } : {}),
		...(window?.durationMs !== undefined ? { durationMs: window.durationMs } : {}),
		...(window?.resetsAt !== undefined ? { resetsAt: window.resetsAt } : {}),
		...(usedFraction !== undefined && Number.isFinite(usedFraction) ? { usedFraction } : {}),
		...(limit.status ? { status: limit.status } : {}),
	};
}

/** Same precedence as oh-my-pi's `resolveUsedFraction`: explicit fraction, used/limit, percent, inverted remaining. */
function resolveUsedFraction(limit: UsageLimit): number | undefined {
	const amount = limit.amount;
	if (amount.usedFraction !== undefined) return amount.usedFraction;
	if (amount.used !== undefined && amount.limit !== undefined && amount.limit > 0) return amount.used / amount.limit;
	if (amount.unit === "percent" && amount.used !== undefined) return amount.used / 100;
	if (amount.remainingFraction !== undefined) return Math.max(0, 1 - amount.remainingFraction);
	return undefined;
}

/** Fetches one account's provider usage report. Injectable so tests run without network. */
export type UsageFetcher = {
	/** The first of `candidates` that has a usage fetcher, else undefined. */
	provider(candidates: readonly string[]): Promise<string | undefined>;
	/** Null report when the provider returned nothing usable; `warning` says why without secrets. */
	fetch(provider: string, credential: UsageCredential, signal: AbortSignal): Promise<{ report: UsageReport | null; warning?: string }>;
};

/** oh-my-pi's built-in usage providers, imported on first use (the registry pulls in every provider module). */
export function ohMyPiUsageFetcher(fetchImpl: typeof fetch = fetch): UsageFetcher {
	let loaded: Promise<typeof import("@oh-my-pi/pi-ai/usage/registry")> | undefined;
	const registry = () => {
		loaded ??= import("@oh-my-pi/pi-ai/usage/registry").catch((error: unknown) => {
			loaded = undefined;
			throw error;
		});
		return loaded;
	};
	return {
		async provider(candidates) {
			const { defaultUsageProvider } = await registry();
			return candidates.find((id) => defaultUsageProvider(id as never) !== undefined);
		},
		async fetch(provider, credential, signal) {
			const usageProvider = (await registry()).defaultUsageProvider(provider as never);
			if (!usageProvider) return { report: null, warning: `no usage fetcher for ${provider}` };
			const params = { provider: provider as never, credential, signal };
			if (usageProvider.supports && !usageProvider.supports(params)) return { report: null, warning: `${provider} usage is not available for this credential` };
			let warning: string | undefined;
			const logger = {
				debug() {},
				warn(message: string, meta?: Record<string, unknown>) {
					// Only the message and an HTTP status: meta may carry error text with URLs or headers.
					const status = typeof meta?.status === "number" ? ` (HTTP ${meta.status})` : "";
					warning ??= `${message}${status}`;
				},
			};
			const report = await usageProvider.fetchUsage(params, { fetch: fetchImpl as never, logger });
			return warning === undefined ? { report } : { report, warning };
		},
	};
}

/** Only the fields usage fetchers read; the refresh token is never handed over, so no fetcher can refresh. */
export function usageCredential(credential: Credential & { type: "oauth" }): UsageCredential {
	const out: UsageCredential = { type: "oauth", accessToken: credential.access };
	if (typeof credential.expires === "number") out.expiresAt = credential.expires;
	for (const field of ["accountId", "projectId", "email", "orgId", "orgName", "enterpriseUrl", "region", "activeOrganizationId", "apiEndpoint"] as const) {
		const value = (credential as Record<string, unknown>)[field];
		if (typeof value === "string" && value !== "") (out as unknown as Record<string, unknown>)[field] = value;
	}
	return out;
}

/** Bounded, single-line error text with any token occurrence masked. */
function safeError(text: string, secrets: readonly string[]): string {
	let out = text.replace(/\s+/g, " ").trim();
	for (const secret of secrets) if (secret.length >= 8) out = out.split(secret).join("[redacted]");
	out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]");
	return out.length > 200 ? `${out.slice(0, 197)}...` : out;
}

type LimitEntry = { at: number; report?: AccountUsageReport; error?: string };

export type LimitsOptions = {
	readonly credentials?: { pools(): Promise<ReadonlyMap<string, CredentialPool>> };
	readonly providerName?: (key: string) => string | undefined | Promise<string | undefined>;
	readonly fetcher?: UsageFetcher;
	readonly now?: () => number;
	readonly ttlMs?: number;
	readonly refreshMinMs?: number;
	readonly timeoutMs?: number;
};

/**
 * Accounts of every stored credential key with their pool state, plus a provider usage report per OAuth account
 * whose provider has a fetcher. Reports are cached per account for `ttlMs` (failures too); `refresh` lowers that to
 * `refreshMinMs`. Concurrent reads share one in-flight fetch per account. Expired tokens are not fetched with.
 */
export function createLimitsReader(options: LimitsOptions = {}): (refresh: boolean) => Promise<{ providers: ProviderLimits[] }> {
	const now = options.now ?? Date.now;
	const ttl = options.ttlMs ?? LIMIT_TTL_MS;
	const refreshMin = options.refreshMinMs ?? REFRESH_MIN_MS;
	const timeout = options.timeoutMs ?? FETCH_TIMEOUT_MS;
	const fetcher = options.fetcher ?? ohMyPiUsageFetcher();
	const cache = new Map<string, LimitEntry>();
	const inflight = new Map<string, Promise<LimitEntry>>();

	const fetchEntry = (cacheKey: string, provider: string, credential: Credential & { type: "oauth" }): Promise<LimitEntry> => {
		const running = inflight.get(cacheKey);
		if (running) return running;
		const run = (async (): Promise<LimitEntry> => {
			const at = now();
			try {
				const { report, warning } = await fetcher.fetch(provider, usageCredential(credential), AbortSignal.timeout(timeout));
				if (report) return { at, report: toAccountReport(report) };
				return { at, error: safeError(warning ?? `${provider} returned no usage data`, [credential.access, credential.refresh]) };
			} catch (error) {
				const text = error instanceof Error ? (error.name === "TimeoutError" ? `usage fetch timed out after ${timeout} ms` : `${error.name}: ${error.message}`) : String(error);
				return { at, error: safeError(text, [credential.access, credential.refresh]) };
			}
		})().then((entry) => {
			cache.set(cacheKey, entry);
			return entry;
		}).finally(() => inflight.delete(cacheKey));
		inflight.set(cacheKey, run);
		return run;
	};

	const account = async (key: string, info: AccountInfo, credential: Credential, refresh: boolean): Promise<AccountLimits> => {
		const out: AccountLimits = { ...info };
		if (credential.type !== "oauth" || typeof credential.access !== "string" || credential.access === "") return out;
		const login = typeof credential.loginProvider === "string" ? credential.loginProvider : undefined;
		const provider = await fetcher.provider(login && login !== key ? [login, key] : [key]).catch(() => undefined);
		if (provider === undefined) return out;
		const cacheKey = `${key}#${info.id}`;
		const cached = cache.get(cacheKey);
		const withEntry = (entry: LimitEntry | undefined): AccountLimits => ({
			...out,
			...(entry?.report ? { report: entry.report } : {}),
			...(entry?.error ? { error: entry.error } : {}),
		});
		if (typeof credential.expires === "number" && credential.expires <= now()) return { ...withEntry(cached), stale: true };
		const maxAge = refresh ? refreshMin : ttl;
		if (cached && now() - cached.at < maxAge) return withEntry(cached);
		return withEntry(await fetchEntry(cacheKey, provider, credential));
	};

	return async (refresh) => {
		if (!options.credentials) return { providers: [] };
		const pools = await options.credentials.pools();
		const at = now();
		const live = new Set<string>();
		const providers = await Promise.all([...pools].map(async ([key, pool]): Promise<ProviderLimits> => {
			const infos = accountInfos(pool, at);
			const accounts = await Promise.all(pool.accounts.map((entry, index) => {
				live.add(`${key}#${entry.id}`);
				return account(key, infos[index]!, entry.credential, refresh);
			}));
			const name = (await Promise.resolve(options.providerName?.(key)).catch(() => undefined)) ?? key;
			return { key, name, accounts };
		}));
		for (const cacheKey of cache.keys()) if (!live.has(cacheKey)) cache.delete(cacheKey);
		return { providers };
	};
}

export type UsageService = { read(options: { readonly refresh: boolean }): Promise<UsageResponse> };

export type UsageServiceOptions = LimitsOptions & {
	readonly harness: Harness;
	readonly context: Context;
	readonly index?: { latest: LatestActivity };
	/** Replaces the store scan; for tests. */
	readonly source?: () => Promise<{ conversations: readonly ConversationUsage[]; threads: Readonly<Record<string, number>> }>;
	readonly summaryTtlMs?: number;
};

/** The summary is cached for `summaryTtlMs`; concurrent requests share one computation. A failed one is not cached. */
export function createUsageService(options: UsageServiceOptions): UsageService {
	const now = options.now ?? Date.now;
	const summaryTtl = options.summaryTtlMs ?? SUMMARY_TTL_MS;
	const limits = createLimitsReader(options);
	const source = options.source ?? (async () => {
		const threads = await listThreads(options.harness, options.context);
		return { conversations: await readConversationUsage(options.harness, options.context), threads };
	});
	let cached: { at: number; summary: UsageSummary } | undefined;
	let computing: Promise<UsageSummary> | undefined;
	const summary = (): Promise<UsageSummary> => {
		if (cached && now() - cached.at < summaryTtl) return Promise.resolve(cached.summary);
		computing ??= (async () => {
			const at = now();
			const { conversations, threads } = await source();
			const value = aggregateUsage(conversations, threads, options.index ? (ids) => options.index!.latest(ids) : undefined);
			cached = { at, summary: value };
			return value;
		})().finally(() => { computing = undefined; });
		return computing;
	};
	return {
		async read({ refresh }) {
			const [s, l] = await Promise.all([summary(), limits(refresh)]);
			return { at: now(), summary: s, limits: l };
		},
	};
}
