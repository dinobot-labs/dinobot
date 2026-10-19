/**
 * Shared HTTP and text utilities for the credential-free search engines.
 *
 * The navigation-header fingerprint, hard-timeout composition and quota/auth
 * error classification are ported from oh-my-pi's web search providers
 * (MIT License, Copyright (c) 2025 Mario Zechner, Copyright (c) 2025-2026
 * Can Bölük). The headless-browser escalation of the original is dropped:
 * this plugin is a single-process bot tool, so a challenged engine is a
 * provider failure that advances the chain instead.
 */

import { MAX_BODY_BYTES, SearchProviderError, type EngineId } from "./types.ts";

/**
 * A stable desktop Chrome navigation fingerprint. The original randomizes
 * across coherent Chrome/Firefox/Safari profiles via a header generator; a
 * fixed internally-consistent Chrome identity keeps requests deterministic
 * and testable.
 */
const NAVIGATION_HEADERS: Record<string, string> = {
	Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
	"Accept-Language": "en-US,en;q=0.9",
	"Cache-Control": "max-age=0",
	"Sec-Ch-Ua": '"Google Chrome";v="149", "Chromium";v="149", ";Not A Brand";v="99"',
	"Sec-Ch-Ua-Mobile": "?0",
	"Sec-Ch-Ua-Platform": '"macOS"',
	"Sec-Fetch-Dest": "document",
	"Sec-Fetch-Mode": "navigate",
	"Upgrade-Insecure-Requests": "1",
	"User-Agent":
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
};

/** One fetched HTML page: final URL after redirects, HTTP status, body text. */
export interface LoadedPage {
	url: string;
	status: number;
	html: string;
}

export interface BrowserFetchOptions {
	/** Injection point for tests; defaults to the global fetch. */
	fetch?: typeof fetch | undefined;
	signal?: AbortSignal | undefined;
	/** Hard ceiling for the whole request in milliseconds. */
	timeoutMs?: number | undefined;
	referer?: string | undefined;
	method?: "GET" | "POST" | undefined;
	/** URL-encoded form body; implies POST. */
	body?: string | undefined;
	headers?: Record<string, string> | undefined;
}

/**
 * Compose a caller-supplied AbortSignal with a hard timeout so an outbound
 * fetch is guaranteed to settle within `ms` even when the runtime fails to
 * propagate cancellation to the underlying transport.
 */
export function withHardTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
	const timeout = AbortSignal.timeout(ms);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * Load one HTML page with a browser navigation fingerprint. Redirects are
 * followed so the final URL is available for challenge detection (Startpage
 * 302s blocked requests to its captcha shell). The body is read up to a
 * 2 MiB cap; a larger reply is a provider failure, keeping output finite.
 */
export async function browserFetch(url: string, options: BrowserFetchOptions): Promise<LoadedPage> {
	const fetchImpl = options.fetch ?? fetch;
	const method = options.body !== undefined ? (options.method ?? "POST") : (options.method ?? "GET");
	const headers: Record<string, string> = {
		...NAVIGATION_HEADERS,
		...(options.referer
			? { Referer: options.referer, "Sec-Fetch-Site": "same-origin", "Sec-Fetch-User": "?1" }
			: { "Sec-Fetch-Site": "none" }),
		...(options.body !== undefined ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
		...options.headers,
	};
	const signal = withHardTimeout(options.signal, options.timeoutMs ?? 60_000);
	const response = await fetchImpl(url, {
		method,
		headers,
		body: options.body,
		redirect: "follow",
		signal,
	});
	const html = await readBody(url, response);
	return { url: response.url || url, status: response.status, html };
}

/** Read the response body up to the shared byte cap; larger bodies are an error. */
async function readBody(url: string, response: Response): Promise<string> {
	const buffer = new Uint8Array(Math.min(MAX_BODY_BYTES, 64 * 1024));
	let bytes = 0;
	const reader = response.body?.getReader();
	if (!reader) return "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			const accepted = Math.min(value.byteLength, MAX_BODY_BYTES - bytes);
			const nextBytes = bytes + accepted;
			if (nextBytes > buffer.byteLength) {
				const grown = new Uint8Array(Math.min(MAX_BODY_BYTES, Math.max(nextBytes, buffer.byteLength * 2)));
				grown.set(buffer.subarray(0, bytes));
				buffer.set(value.subarray(0, Math.min(accepted, grown.byteLength - bytes)), bytes);
				bytes = Math.min(nextBytes, grown.byteLength);
				if (accepted < value.byteLength) {
					await reader.cancel().catch(() => undefined);
					throw new SearchProviderError("web", `response from ${url} exceeded ${MAX_BODY_BYTES} bytes`, 500);
				}
				continue;
			}
			buffer.set(value.subarray(0, accepted), bytes);
			bytes = nextBytes;
			if (accepted < value.byteLength) {
				await reader.cancel().catch(() => undefined);
				throw new SearchProviderError("web", `response from ${url} exceeded ${MAX_BODY_BYTES} bytes`, 500);
			}
		}
	} finally {
		reader.releaseLock();
	}
	return new TextDecoder().decode(buffer.subarray(0, bytes));
}

/**
 * Quota/auth signal mapping so chain-advance decisions and the final error
 * summary stay legible. Returns null when the response matches no known
 * signal, leaving the caller to throw its provider-specific fallback.
 */
const CREDIT_BODY_PATTERN = /credits?\s*(?:exhausted|exceeded)|quota|insufficient/i;

export function classifyProviderHttpError(
	provider: EngineId,
	status: number,
	body: string,
): SearchProviderError | null {
	if (CREDIT_BODY_PATTERN.test(body)) {
		return new SearchProviderError(provider, `${provider}: credits exhausted`, status);
	}
	if (status === 402) return new SearchProviderError(provider, `${provider}: 402 credits exhausted`, status);
	if (status === 401) return new SearchProviderError(provider, `${provider}: 401 unauthorized`, status);
	if (status === 403) return new SearchProviderError(provider, `${provider}: 403 forbidden`, status);
	return null;
}

/**
 * Decode an HTML-encoded fragment: strip inline tags, unescape the common
 * named and numeric entities, collapse whitespace.
 */
export function decodeHtmlText(value: string): string {
	return value
		.replace(/<[^>]*>/g, " ")
		.replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
		.replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCharCode(Number.parseInt(code, 16)))
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&apos;/gi, "'")
		.replace(/\s+/g, " ")
		.trim();
}

/** Collapse whitespace, returning undefined for missing/blank values. */
export function normalizeSearchText(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.replace(/\s+/g, " ").trim();
	return text.length > 0 ? text : undefined;
}

/** Age in seconds from an ISO-ish date string; undefined on invalid input. */
export function dateToAgeSeconds(dateStr: string | null | undefined): number | undefined {
	if (!dateStr) return undefined;
	try {
		const date = new Date(dateStr);
		if (Number.isNaN(date.getTime())) return undefined;
		return Math.floor((Date.now() - date.getTime()) / 1000);
	} catch {
		return undefined;
	}
}

/** Clamp a result count to [1, max], returning the default when absent or NaN. */
export function clampNumResults(value: number | undefined, defaultVal: number, maxVal: number): number {
	if (!value || Number.isNaN(value)) return defaultVal;
	return Math.min(maxVal, Math.max(1, value));
}

/** Compact relative age ("3d ago") for LLM output; empty string for absent ages. */
export function formatAge(ageSeconds: number | null | undefined): string {
	if (!ageSeconds) return "";
	const mins = Math.floor(ageSeconds / 60);
	const hours = Math.floor(mins / 60);
	const days = Math.floor(hours / 24);
	const weeks = Math.floor(days / 7);
	const months = Math.floor(days / 30);
	if (months > 0) return `${months}mo ago`;
	if (weeks > 0) return `${weeks}w ago`;
	if (days > 0) return `${days}d ago`;
	if (hours > 0) return `${hours}h ago`;
	if (mins > 0) return `${mins}m ago`;
	return "just now";
}
