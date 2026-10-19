/**
 * Startpage engine: a Google-proxied privacy frontend, no API key required.
 *
 * Ported from oh-my-pi `providers/startpage.ts` (MIT License, Copyright
 * (c) 2025 Mario Zechner, Copyright (c) 2025-2026 Can Bölük). The original
 * walks the page with a DOM parser; this port keeps the same markup contract
 * (`div.result` containers, `a.result-link` anchors, `p.description`
 * snippets) with token-based regex scanning so the plugin needs no DOM
 * dependency. The homepage-token form flow is preserved verbatim: Startpage
 * keys its bot defense on requests that skip the homepage handshake, so the
 * search form's hidden inputs (including the `sc` anti-bot token) are lifted
 * from the homepage and posted back with the query.
 */

import { formatScraperQuery } from "./query.ts";
import {
	DEFAULT_NUM_RESULTS,
	MAX_NUM_RESULTS,
	SearchProviderError,
	type EngineId,
	type SearchParams,
	type SearchProvider,
	type SearchResponse,
	type SearchSource,
} from "./types.ts";
import { browserFetch, classifyProviderHttpError, decodeHtmlText, normalizeSearchText, withHardTimeout } from "./http.ts";

const DEFAULT_HOME_URL = "https://www.startpage.com/";
const DEFAULT_SEARCH_URL = "https://www.startpage.com/sp/search";

/** One organic result lifted from the results page. */
interface ParsedResult {
	title: string;
	url: string;
	snippet?: string | undefined;
}

/**
 * Recency → Startpage `with_date` param. Accepts single letters; an absent
 * value returns the unfiltered default.
 */
const RECENCY_TO_STARTPAGE_WITH_DATE: Record<NonNullable<SearchParams["recency"]>, string> = {
	day: "d",
	week: "w",
	month: "m",
	year: "y",
};

/**
 * `true` when Startpage answered with its CAPTCHA/error shell instead of
 * results. Rejected requests 302 to `/en/errors/` (legacy: `/sp/captcha`), a
 * Gatsby SPA whose chunk map names the captcha page components; the body
 * marker matters because the final URL can also be the challenge itself. A
 * bare "captcha" substring is deliberately not used — result snippets for
 * captcha-related queries would false-positive.
 */
export function isChallengeResponse(page: { url: string; html: string }): boolean {
	if (/\/(?:errors|captcha)\//.test(page.url) || page.url.includes("/sp/captcha")) return true;
	return page.html.includes("component---src-pages-captcha") || page.html.includes("/sp/captcha");
}

/** Extract a double/single-quoted attribute value from an HTML tag string. */
function attr(tag: string, name: string): string | undefined {
	const re = new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i");
	return re.exec(tag)?.[2];
}

/** True when the class attribute contains `token` as a whole CSS class token. */
function hasClassToken(classAttr: string | undefined, token: string): boolean {
	if (!classAttr) return false;
	for (const part of classAttr.split(/\s+/)) if (part === token) return true;
	return false;
}

/**
 * Split an HTML document into the inner content of every
 * `<element … class="… token …">` block, where the class attribute must
 * contain `token` as a whole CSS class token (so `result` matches
 * `class="result"` but not `class="result-container"`). Each block ends
 * where the next qualifying open tag begins — the same non-nesting
 * assumption the DuckDuckGo parser makes for its result rows.
 */
export function splitClassBlocks(html: string, element: string, token: string): string[] {
	const re = new RegExp(`<${element}\\b[^>]*>`, "gi");
	const opens: Array<{ start: number; end: number }> = [];
	for (const match of html.matchAll(re)) {
		const tag = match[0];
		if (hasClassToken(attr(tag, "class"), token)) {
			const start = match.index ?? 0;
			opens.push({ start, end: start + tag.length });
		}
	}
	const blocks: string[] = [];
	for (let i = 0; i < opens.length; i++) {
		const from = opens[i]!.end;
		const to = i + 1 < opens.length ? opens[i + 1]!.start : html.length;
		if (to > from) blocks.push(html.slice(from, to));
	}
	return blocks;
}

/**
 * Lift the hidden inputs from the homepage's `/sp/search` form. Returns
 * `undefined` when the form or its `sc` anti-bot token cannot be found so
 * the caller can degrade to a tokenless GET instead of posting a doomed
 * form.
 */
export function parseSearchFormInputs(html: string): Record<string, string> | undefined {
	for (const formMatch of html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/gi)) {
		const whole = formMatch[0];
		const openEnd = whole.indexOf(">");
		const formOpen = whole.slice(0, openEnd + 1);
		const action = attr(formOpen, "action");
		if (action === undefined || !action.includes("/sp/search")) continue;
		const inner = whole.slice(openEnd + 1, whole.length - "</form>".length);
		const inputs: Record<string, string> = {};
		for (const inputMatch of inner.matchAll(/<input\b[^>]*>/gi)) {
			const input = inputMatch[0];
			const name = attr(input, "name");
			const value = attr(input, "value");
			if (name) inputs[decodeHtmlText(name)] = value !== undefined ? decodeHtmlText(value) : "";
		}
		if (inputs.sc !== undefined) return inputs;
	}
	return undefined;
}

/** Accept only http(s) result targets that point away from Startpage itself. */
export function sanitizeResultUrl(href: string | undefined, base: string): string | undefined {
	if (!href) return undefined;
	let url: URL;
	try {
		url = new URL(href, base);
	} catch {
		return undefined;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
	if (url.hostname === "startpage.com" || url.hostname.endsWith(".startpage.com")) return undefined;
	return url.href;
}

/**
 * Walk the server-rendered results page in document order.
 *
 * Each organic hit lives in a `div.result` container (CSS class token
 * `result`) holding the title anchor `a.result-link` (with an `h2`/`h3`
 * heading) and an optional `p.description` snippet. Hrefs are direct target
 * URLs — Startpage does not wrap outbound clicks. The offscreen
 * adblock-honeypot div uses the class token `a-bg-result`, which token
 * matching correctly ignores, and sponsored placements render outside
 * `div.result` containers.
 */
export function parseHtmlResults(html: string, base: string = DEFAULT_HOME_URL): ParsedResult[] {
	const results: ParsedResult[] = [];
	for (const block of splitClassBlocks(html, "div", "result")) {
		const anchor = /<a\b[^>]*\bclass="[^"]*\bresult-link\b[^"]*"[^>]*>[\s\S]*?<\/a>/.exec(block);
		if (!anchor) continue;
		const href = attr(anchor[0], "href");
		const url = sanitizeResultUrl(href?.replace(/&amp;/gi, "&"), base);
		if (!url) continue;
		const heading = /<h[23]\b[^>]*>([\s\S]*?)<\/h[23]>/i.exec(anchor[0]);
		const titleText = normalizeSearchText(heading ? decodeHtmlText(heading[1]!) : decodeHtmlText(anchor[0]));
		if (!titleText) continue;
		const snippetMatch = /<p\b[^>]*\bclass="[^"]*\bdescription\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(block);
		const snippetText = snippetMatch ? normalizeSearchText(decodeHtmlText(snippetMatch[1]!)) : undefined;
		results.push({ title: titleText, url, snippet: snippetText || undefined });
	}
	return results;
}

interface StartpageEndpoints {
	home: string;
	search: string;
}

function endpointsOf(base: string | undefined): StartpageEndpoints {
	if (!base) return { home: DEFAULT_HOME_URL, search: DEFAULT_SEARCH_URL };
	const normalized = base.endsWith("/") ? base : `${base}/`;
	return { home: normalized, search: new URL("sp/search", normalized).href };
}

/**
 * Fetch the homepage and lift the search form's hidden inputs. Best effort:
 * any failure (network, non-OK status, challenge shell, markup drift) yields
 * `undefined` and the caller falls back to a direct GET.
 */
async function fetchFormInputs(
	endpoints: StartpageEndpoints,
	params: SearchParams,
	signal: AbortSignal,
): Promise<Record<string, string> | undefined> {
	let page;
	try {
		page = await browserFetch(endpoints.home, { fetch: params.fetch, signal, timeoutMs: params.timeoutMs });
	} catch (error) {
		if (params.signal?.aborted || signal.aborted) throw error;
		return undefined;
	}
	if (page.status < 200 || page.status >= 300 || isChallengeResponse(page)) return undefined;
	return parseSearchFormInputs(page.html);
}

async function callStartpageHtml(params: SearchParams, endpoints: StartpageEndpoints): Promise<string> {
	const signal = withHardTimeout(params.signal, params.timeoutMs);
	const withDate = params.recency ? RECENCY_TO_STARTPAGE_WITH_DATE[params.recency] : undefined;
	// Startpage proxies Google, so the operator set works inline; rebuild via
	// the shared scraper formatter to canonicalize aliases (domain: → site:,
	// since: → after:, …) and demote scraper-hostile operators. Directive-free
	// queries pass through byte-identical.
	const query = formatScraperQuery(params.query, params.parsedQuery);

	const formInputs = await fetchFormInputs(endpoints, params, signal);
	let page;
	if (formInputs) {
		const form = new URLSearchParams(formInputs);
		form.set("query", query);
		if (withDate) form.set("with_date", withDate);
		page = await browserFetch(endpoints.search, {
			fetch: params.fetch,
			signal,
			timeoutMs: params.timeoutMs,
			referer: endpoints.home,
			body: form.toString(),
		});
	} else {
		const url = new URL(endpoints.search);
		url.searchParams.set("query", query);
		if (withDate) url.searchParams.set("with_date", withDate);
		page = await browserFetch(url.href, {
			fetch: params.fetch,
			signal,
			timeoutMs: params.timeoutMs,
			referer: endpoints.home,
		});
	}

	if (isChallengeResponse(page)) {
		throw new SearchProviderError(
			"startpage",
			"Startpage blocked the request with a CAPTCHA challenge. Startpage rate-limits automated searches from datacenter/shared-egress IPs; the chain advances to the next engine (configure engines order in the web plugin to skip it).",
			429,
		);
	}
	if (page.status < 200 || page.status >= 300) {
		const classified = classifyProviderHttpError("startpage", page.status, page.html);
		if (classified) throw classified;
		throw new SearchProviderError("startpage", `Startpage HTML error (${page.status})`, page.status);
	}
	return page.html;
}

/** Execute a Startpage web search via the homepage-token form flow. */
export async function searchStartpage(params: SearchParams, baseUrl?: string): Promise<SearchResponse> {
	const endpoints = endpointsOf(baseUrl);
	const count = Math.min(MAX_NUM_RESULTS, Math.max(1, params.limit ?? DEFAULT_NUM_RESULTS));
	const html = await callStartpageHtml(params, endpoints);
	const parsed = parseHtmlResults(html, endpoints.home);

	const sources: SearchSource[] = [];
	const seen = new Set<string>();
	for (const result of parsed) {
		if (seen.has(result.url)) continue;
		seen.add(result.url);
		sources.push({ title: result.title, url: result.url, snippet: result.snippet });
		if (sources.length >= count) break;
	}

	return { provider: "startpage", sources };
}

/** Startpage provider (no API key required). */
export class StartpageProvider implements SearchProvider {
	readonly id: EngineId = "startpage";
	readonly label = "Startpage";

	constructor(private readonly baseUrl: string | undefined = undefined) {}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchStartpage(params, this.baseUrl);
	}
}
