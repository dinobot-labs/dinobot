/**
 * Locale negotiation for "/". Crawlers always get the default English page (never redirected); otherwise a `lang`
 * cookie (set by the page's EN/KO toggle) wins, and without one the highest-q Accept-Language range decides.
 */

export type Locale = "en" | "ko";
export const DEFAULT_LOCALE: Locale = "en";
export const LOCALE_COOKIE = "lang";

/** The first `lang` cookie that names a supported locale. */
export function cookieLocale(header: string | null): Locale | undefined {
	for (const pair of (header ?? "").split(";")) {
		const eq = pair.indexOf("=");
		if (eq < 0 || pair.slice(0, eq).trim() !== LOCALE_COOKIE) continue;
		const value = pair
			.slice(eq + 1)
			.trim()
			.replace(/^"(.*)"$/, "$1")
			.toLowerCase();
		if (value === "en" || value === "ko") return value;
	}
	return undefined;
}

/** The language range with the highest q-value (the earliest one on ties), lowercased; undefined when none is acceptable. */
export function preferredLanguage(header: string | null): string | undefined {
	let best: string | undefined;
	let bestQ = 0;
	for (const item of (header ?? "").split(",")) {
		const [range = "", ...params] = item.split(";").map((part) => part.trim());
		if (range === "") continue;
		let q = 1;
		for (const param of params) {
			const eq = param.indexOf("=");
			if (eq > 0 && param.slice(0, eq).trim().toLowerCase() === "q") q = qvalue(param.slice(eq + 1));
		}
		if (q > bestQ) {
			best = range.toLowerCase();
			bestQ = q;
		}
	}
	return best;
}

/** RFC 9110 qvalue; anything malformed counts as 0 (not acceptable). */
function qvalue(raw: string): number {
	const value = raw.trim();
	return /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(value) ? Number(value) : 0;
}

export const isKorean = (range: string) => range === "ko" || range.startsWith("ko-");

/**
 * Search engines, AI crawlers and link-preview fetchers (chat apps, social sites). Headless browsers, Lighthouse,
 * in-app browsers (KakaoTalk, NAVER, Daum apps) and plain HTTP clients are treated as people.
 */
const CRAWLER =
	/bot\b|crawl|spider|slurp|archiver|scrap|fetcher|preview|externalhit|externalagent|inspectiontool|mediapartners|embedly|whatsapp|perplexity|mastodon|cardyb|yeti\/|daum(?:oa)?\//i;

export const isCrawler = (userAgent: string | null) => userAgent !== null && CRAWLER.test(userAgent);

/** The locale that "/" answers with: "ko" means redirect to /ko/, "en" means serve the English page. */
export function negotiate(headers: Headers): Locale {
	if (isCrawler(headers.get("user-agent"))) return DEFAULT_LOCALE;
	const chosen = cookieLocale(headers.get("cookie"));
	if (chosen) return chosen;
	const top = preferredLanguage(headers.get("accept-language"));
	return top !== undefined && isKorean(top) ? "ko" : DEFAULT_LOCALE;
}
