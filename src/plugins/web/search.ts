/**
 * The sequential engine chain behind the `web_search` tool.
 *
 * Ported from oh-my-pi `web/search/index.ts` (MIT License, Copyright (c)
 * 2025 Mario Zechner, Copyright (c) 2025-2026 Can Bölük), reduced to the
 * credential-free engine set. The chain semantics are preserved exactly:
 *
 * - Engines are walked in the configured order (a finite total order).
 * - A provider failure — transport error, HTTP/quota classification, or a
 *   bot-challenge 429 — is recorded and the walk advances.
 * - A response with no renderable content is rejected as a failure (204) so
 *   the walk advances instead of returning a dead result.
 * - Caller cancellation is rethrown immediately; it is never recorded as a
 *   provider failure, so a user abort surfaces as a clean abort.
 * - When every engine failed, the tool returns a normal result whose text is
 *   `Error: …` with one normalized message per engine — the tool boundary
 *   never throws.
 *
 * After the first renderable response, the lenient constraint pass
 * (applyQueryConstraints) enforces `site:`/`inurl:`/`intitle:`/`filetype:`
 * and date-bound directives the engine could not honor natively, relaxing
 * any dimension that would wipe out every result and reporting it.
 */

import { applyQueryConstraints, parseSearchQuery } from "./query.ts";
import { formatAge } from "./http.ts";
import { SearchProviderError, type SearchParams, type SearchProvider, type SearchResponse, type SearchSource } from "./types.ts";

/** What the tool hands back: formatted text plus structured fields. */
export interface WebSearchResult {
	/** Deterministic LLM-formatted output (notes, numbered sources). */
	text: string;
	/** Engine that produced the response; "none" before any attempt. */
	provider: string;
	/** Engines that were tried, in order, with their failure messages. */
	failures: Array<{ provider: string; message: string }>;
	sources: SearchSource[];
	/** Relaxed-constraint notes; one entry per dropped dimension. */
	notes: string[];
	/** Present only when every engine failed. */
	error?: string;
}

/** Truncate text for tool output. */
function truncateText(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return `${text.slice(0, Math.max(0, maxLen - 1))}…`;
}

function formatCount(label: string, count: number): string {
	return `${count} ${label}${count === 1 ? "" : "s"}`;
}

/** Format a response for LLM consumption. Notes lead the output. */
export function formatForLLM(sources: readonly SearchSource[], notes: readonly string[] = []): string {
	const parts: string[] = [];
	for (const note of notes) parts.push(`Note: ${note}`);

	if (sources.length > 0) {
		parts.push("## Sources");
		parts.push(formatCount("source", sources.length));
	}
	for (const [i, src] of sources.entries()) {
		const age = formatAge(src.ageSeconds) || src.publishedDate;
		const agePart = age ? ` (${age})` : "";
		parts.push(`[${i + 1}] ${src.title}${agePart}\n    ${src.url}`);
		if (src.snippet) parts.push(`    ${truncateText(src.snippet, 240)}`);
	}
	return parts.join("\n");
}

export function hasRenderableSearchContent(response: SearchResponse): boolean {
	return response.sources.length > 0;
}

function formatFailure(provider: string, error: unknown): string {
	if (error instanceof SearchProviderError) return `${provider}: ${error.message}`;
	if (error instanceof Error) return `${provider}: ${error.message}`;
	return `${provider}: ${String(error)}`;
}

export interface ExecuteSearchOptions {
	/** Engines in fallback order; at least one. */
	providers: readonly SearchProvider[];
	/** Hard ceiling per engine attempt in milliseconds. */
	timeoutMs: number;
	signal?: AbortSignal | undefined;
	/** Test/injection seam forwarded to every provider. */
	fetch?: typeof fetch | undefined;
}

/** Run one query through the engine chain. Never throws at this boundary except for caller aborts. */
export async function executeSearch(
	query: string,
	params: Pick<SearchParams, "limit" | "recency">,
	options: ExecuteSearchOptions,
): Promise<WebSearchResult> {
	const parsedQuery = parseSearchQuery(query);
	const failures: WebSearchResult["failures"] = [];

	for (const provider of options.providers) {
		try {
			const response = await provider.search({
				query,
				parsedQuery,
				limit: params.limit,
				recency: params.recency,
				signal: options.signal,
				timeoutMs: options.timeoutMs,
				fetch: options.fetch,
			});

			// Lenient constraint pass over whatever the engine returned: enforce
			// site:/inurl:/intitle:/filetype:/date directives the engine could
			// not (or only partially) honor natively, relaxing any dimension
			// that would wipe out every result.
			let finalSources = response.sources;
			const notes: string[] = [];
			if (parsedQuery.hasConstraints && response.sources.length > 0) {
				const filtered = applyQueryConstraints(response.sources, parsedQuery);
				finalSources = filtered.sources;
				for (const label of filtered.dropped) {
					notes.push(`no results matched \`${label}\`; the constraint was relaxed`);
				}
			}

			if (!hasRenderableSearchContent({ ...response, sources: finalSources })) {
				throw new SearchProviderError(provider.id, `${provider.label} returned no renderable search content.`, 204);
			}

			return {
				text: formatForLLM(finalSources, notes),
				provider: provider.id,
				failures,
				sources: finalSources,
				notes,
			};
		} catch (error) {
			// Surface caller cancellation immediately so the session sees a clean
			// abort instead of a generic "all engines failed" message.
			if (options.signal?.aborted) throw error;
			failures.push({ provider: provider.id, message: formatFailure(provider.id, error) });
		}
	}

	const message =
		failures.length > 1
			? `All web search engines failed: ${failures.map((f) => f.message).join("; ")}`
			: (failures[0]?.message ?? "no web search engine is configured");
	return {
		text: `Error: ${message}`,
		provider: failures.at(-1)?.provider ?? "none",
		failures,
		sources: [],
		notes: [],
		error: message,
	};
}
