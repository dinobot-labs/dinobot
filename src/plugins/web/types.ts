/**
 * Shared types for the credential-free web search plugin.
 *
 * The provider model, sequential fallback chain, lenient query-constraint
 * post-filtering and the LLM output format are ported from oh-my-pi's
 * `web_search` tool (packages/coding-agent/src/web/search), MIT licensed,
 * Copyright (c) 2025 Mario Zechner, Copyright (c) 2025-2026 Can Bölük.
 * The port drops credentialled and browser-backed providers; only the two
 * keyless HTML engines remain, so availability is constant and no auth
 * storage exists.
 */

/** Search engine identifiers this build knows. Credential-free only. */
export const ENGINE_IDS = ["startpage", "duckduckgo"] as const;
export type EngineId = (typeof ENGINE_IDS)[number];

export type Recency = "day" | "week" | "month" | "year";

/** One organic search result shared by every engine. */
export interface SearchSource {
	title: string;
	url: string;
	snippet?: string | undefined;
	publishedDate?: string | undefined;
	ageSeconds?: number | undefined;
}

/** What one engine returns for a query. */
export interface SearchResponse {
	provider: EngineId;
	sources: SearchSource[];
}

/**
 * Provider-tagged failure. Thrown inside a provider attempt; the chain
 * records it and advances. Never crosses the tool boundary.
 */
export class SearchProviderError extends Error {
	readonly provider: string;
	readonly status?: number | undefined;

	constructor(provider: string, message: string, status?: number) {
		super(message);
		this.name = "SearchProviderError";
		this.provider = provider;
		this.status = status;
	}
}

/** Parameters every engine receives. `fetch` is a test/injection seam. */
export interface SearchParams {
	query: string;
	limit?: number | undefined;
	recency?: Recency | undefined;
	signal?: AbortSignal | undefined;
	/** Hard ceiling for the whole engine attempt in milliseconds. */
	timeoutMs: number;
	/** Pre-parsed structured query; engines may parse lazily when absent. */
	parsedQuery?: import("./query.ts").StructuredQuery | undefined;
	/** Injection point for tests; defaults to the global fetch. */
	fetch?: typeof fetch | undefined;
}

/** One credential-free engine. Availability is constant true by design. */
export interface SearchProvider {
	readonly id: EngineId;
	readonly label: string;
	search(params: SearchParams): Promise<SearchResponse>;
}

/** Result cap shared by both HTML engines, matching the upstream port. */
export const DEFAULT_NUM_RESULTS = 10;
export const MAX_NUM_RESULTS = 20;
/** Per-attempt hard timeout default/cap in seconds (oh-my-pi parity). */
export const DEFAULT_TIMEOUT_SECONDS = 60;
export const MAX_TIMEOUT_SECONDS = 300;
/** Response body read cap; a larger engine reply is a provider failure. */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
