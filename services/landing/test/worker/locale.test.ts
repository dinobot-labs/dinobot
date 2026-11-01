import { describe, expect, test } from "bun:test";
import { handleFetch } from "../../src/worker/app.ts";
import { cookieLocale, isCrawler, negotiate, preferredLanguage } from "../../src/worker/locale.ts";
import { clock, fakeEnv, type FakeEnv, req } from "./fakes.ts";

const KO = "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7";
const EN = "en-US,en;q=0.9,ko;q=0.8";

const CRAWLERS = [
	"Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
	"Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/141.0.0.0 Safari/537.36",
	"Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
	"Mozilla/5.0 (compatible; Yeti/1.1; +https://naver.me/spd)",
	"Mozilla/5.0 (compatible; Daum/4.1; +https://cs.daum.net/faq/15/4118.html?faqId=28966)",
	"facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
	"meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)",
	"Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
	"Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)",
	"TelegramBot (like TwitterBot)",
	"Twitterbot/1.0",
	"LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)",
	"kakaotalk-scrap/1.0; +https://devtalk.kakao.com/public/link-preview",
	"WhatsApp/2.23.20.0",
	"Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)",
	"Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
	"Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)",
	"Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Bytespider; spider-feedback@bytedance.com)",
	"Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)",
	"DuckDuckBot/1.1; (+http://duckduckgo.com/duckduckbot.html)",
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.1.1 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)",
	"http.rb/5.1.1 (Mastodon/4.2.0; +https://mastodon.social/)",
	"Mozilla/5.0 (compatible; Bluesky Cardyb/1.1; +mailto:support@bsky.app)",
	"ia_archiver",
];

const BROWSERS = [
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
	"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
	"Mozilla/5.0 (Linux; Android 14; SM-S928N) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36",
	"Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 KAKAOTALK 10.8.5",
	"Mozilla/5.0 (Linux; Android 14; SM-S928N Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.122 Mobile Safari/537.36 NAVER(inapp; search; 2000; 12.6.3)",
	"Mozilla/5.0 (Linux; Android 13; SM-G991N Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/125.0.6422.165 Mobile Safari/537.36 DaumApps/8.10.4",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Whale/4.33.325.17 Safari/537.36",
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Chrome-Lighthouse",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0",
	"curl/8.9.1",
];

const home = (env: FakeEnv, headers: Record<string, string> = {}, path = "/", method = "GET") => handleFetch(req(path, { method, headers }), env, clock);

async function expectEnglish(env: FakeEnv, headers: Record<string, string>) {
	const response = await home(env, headers);
	expect([JSON.stringify(headers), response.status, response.headers.get("location")]).toEqual([JSON.stringify(headers), 200, null]);
	expect(await response.text()).toBe("<h1>en</h1>");
}

async function expectKorean(env: FakeEnv, headers: Record<string, string>) {
	const response = await home(env, headers);
	expect([JSON.stringify(headers), response.status, response.headers.get("location")]).toEqual([JSON.stringify(headers), 302, "/ko/"]);
}

describe("preferredLanguage", () => {
	test("picks the highest q-value, the earliest on ties", () => {
		const cases: [string | null, string | undefined][] = [
			[null, undefined],
			["", undefined],
			[KO, "ko-kr"],
			[EN, "en-us"],
			["en;q=0.5, ko;q=0.8", "ko"],
			["ko;q=0.5, en", "en"],
			["en, ko", "en"],
			["ko, en", "ko"],
			["ko;q=0", undefined],
			["ko;q=0, en;q=0.001", "en"],
			["*", "*"],
			["  KO-kr  ;  Q=0.9 , en;q=0.8", "ko-kr"],
			["ko;q=abc, en;q=0.1", "en"],
			["ko;q=1.5, en;q=0.2", "en"],
			["fr-FR, ko;q=0.9", "fr-fr"],
		];
		for (const [header, expected] of cases) expect([header, preferredLanguage(header)]).toEqual([header, expected]);
	});
});

describe("cookieLocale", () => {
	test("reads a supported lang cookie", () => {
		const cases: [string | null, string | undefined][] = [
			[null, undefined],
			["", undefined],
			["lang=ko", "ko"],
			["theme=dark; lang=en", "en"],
			["lang=KO", "ko"],
			['lang="ko"', "ko"],
			["lang=fr", undefined],
			["xlang=ko; langs=ko", undefined],
			["lang=fr; lang=ko", "ko"],
			["lang", undefined],
		];
		for (const [header, expected] of cases) expect([header, cookieLocale(header)]).toEqual([header, expected]);
	});
});

describe("isCrawler", () => {
	test("search engines, AI crawlers and link previewers are crawlers", () => {
		for (const ua of CRAWLERS) expect([ua, isCrawler(ua)]).toEqual([ua, true]);
	});

	test("browsers, headless browsers, in-app browsers, Lighthouse and curl are people", () => {
		for (const ua of [...BROWSERS, null]) expect([ua, isCrawler(ua)]).toEqual([ua, false]);
	});
});

describe("negotiate", () => {
	test("crawler, then cookie, then Accept-Language", () => {
		const negotiated = (headers: Record<string, string>) => negotiate(new Headers(headers));
		expect(negotiated({})).toBe("en");
		expect(negotiated({ "accept-language": KO })).toBe("ko");
		expect(negotiated({ "accept-language": KO, cookie: "lang=en" })).toBe("en");
		expect(negotiated({ "accept-language": EN, cookie: "lang=ko" })).toBe("ko");
		expect(negotiated({ "accept-language": KO, cookie: "lang=ko", "user-agent": CRAWLERS[0]! })).toBe("en");
	});
});

describe("GET /", () => {
	test("Korean browsers are redirected to /ko/ with Vary and no caching", async () => {
		const env = fakeEnv();
		const response = await home(env, { "accept-language": KO, "user-agent": BROWSERS[0]! });
		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe("/ko/");
		expect(response.headers.get("vary")).toBe("Accept-Language, Cookie");
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(env.ASSETS.requests).toHaveLength(0);
	});

	test("the query string survives the redirect", async () => {
		const response = await home(fakeEnv(), { "accept-language": "ko" }, "/?utm_source=hn&ref=x");
		expect(response.headers.get("location")).toBe("/ko/?utm_source=hn&ref=x");
	});

	test("everyone else gets the English page with Vary merged into the asset headers", async () => {
		const env = fakeEnv();
		const response = await home(env, { "accept-language": EN });
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("<h1>en</h1>");
		expect(response.headers.get("vary")).toBe("Accept-Encoding, Accept-Language, Cookie");
		expect(response.headers.get("etag")).toBe('"abc"');
		expect(response.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
		expect(env.ASSETS.requests.map((request) => new URL(request.url).pathname)).toEqual(["/"]);
		const others: Record<string, string>[] = [{}, { "accept-language": "fr-FR, ko;q=0.9" }, { "accept-language": "*" }, { "accept-language": "ko;q=0" }];
		for (const headers of others) {
			await expectEnglish(env, headers);
		}
	});

	test("q-values decide", async () => {
		const env = fakeEnv();
		await expectKorean(env, { "accept-language": "en;q=0.5, ko;q=0.8" });
		await expectKorean(env, { "accept-language": "ko, en" });
		await expectKorean(env, { "accept-language": "ko-KP;q=0.9, en;q=0.3" });
		await expectEnglish(env, { "accept-language": "ko;q=0.5, en" });
		await expectEnglish(env, { "accept-language": "en, ko" });
		await expectEnglish(env, { "accept-language": "ja;q=0.9, ko;q=0.8" });
	});

	test("the lang cookie wins both ways", async () => {
		const env = fakeEnv();
		await expectEnglish(env, { "accept-language": KO, cookie: "lang=en" });
		await expectKorean(env, { "accept-language": EN, cookie: "lang=ko" });
		await expectKorean(env, { cookie: "theme=dark; lang=ko" });
		// An unsupported value is ignored, so Accept-Language decides.
		await expectKorean(env, { "accept-language": KO, cookie: "lang=fr" });
		await expectEnglish(env, { "accept-language": EN, cookie: "lang=fr" });
	});

	test("crawlers are never redirected, not even with a lang=ko cookie", async () => {
		const env = fakeEnv();
		for (const ua of CRAWLERS) {
			await expectEnglish(env, { "user-agent": ua, "accept-language": KO });
			await expectEnglish(env, { "user-agent": ua, "accept-language": KO, cookie: "lang=ko" });
		}
	});

	test("browsers, headless browsers and in-app browsers are negotiated", async () => {
		const env = fakeEnv();
		for (const ua of BROWSERS) await expectKorean(env, { "user-agent": ua, "accept-language": KO });
	});

	test("HEAD is negotiated; non-read methods are rejected and explicit paths go to ASSETS", async () => {
		const env = fakeEnv();
		const head = await home(env, { "accept-language": KO }, "/", "HEAD");
		expect([head.status, head.headers.get("location")]).toEqual([302, "/ko/"]);

		const post = await home(env, { "accept-language": KO }, "/", "POST");
		expect(post.status).toBe(405);
		expect(post.headers.get("allow")).toBe("GET, HEAD");
		expect(post.headers.get("location")).toBeNull();

		const ko = await home(env, { "accept-language": EN, cookie: "lang=en" }, "/ko/");
		expect([ko.status, await ko.text(), ko.headers.get("vary")]).toEqual([200, "<h1>ko</h1>", null]);

		const missing = await home(env, { "accept-language": KO }, "/nope");
		expect([missing.status, await missing.text()]).toEqual([404, "<h1>404</h1>"]);
		expect(env.ASSETS.requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(["GET /ko/", "GET /nope"]);
	});
});
