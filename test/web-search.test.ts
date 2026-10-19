import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openBot, type Bot } from "../src/core/bot.ts";
import type { ToolMode } from "../src/core/toolmode.ts";
import { localeToKl, parseContinuationForm, parseHtmlResults as parseDdgHtml, searchDuckDuckGo } from "../src/plugins/web/duckduckgo.ts";
import {
	parseHtmlResults as parseStartpageHtml,
	parseSearchFormInputs,
	sanitizeResultUrl,
	searchStartpage,
	splitClassBlocks,
} from "../src/plugins/web/startpage.ts";
import { applyQueryConstraints, formatQuery, formatScraperQuery, parseDateValue, parseSearchQuery } from "../src/plugins/web/query.ts";
import { executeSearch, formatForLLM } from "../src/plugins/web/search.ts";
import { webPlugin } from "../src/plugins/web/index.ts";
import { parseManifest } from "../src/manifest.ts";
import { pluginCatalog } from "../src/plugins/index.ts";
import { loadPlugin, type LoadedPlugin } from "../src/plugins/types.ts";
import {
	SearchProviderError,
	type SearchParams,
	type SearchProvider,
	type SearchResponse,
	type SearchSource,
} from "../src/plugins/web/types.ts";

const context = BACKGROUND_CONTEXT;
const fixtures = join(import.meta.dir, "fixtures", "web-search");

/** A fetch stub serving canned responses in call order; `.seen` records every request. */
function fetchScript(
	responses: Array<Response | ((request: Request) => Response | Promise<Response>)>,
): typeof fetch & { seen: Request[] } {
	let call = 0;
	const seen: Request[] = [];
	const fetchMock = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		const request = new Request(String(input), init);
		seen.push(request);
		const responder = responses[Math.min(call, responses.length - 1)]!;
		call++;
		return typeof responder === "function" ? await responder(request) : responder;
	}) as typeof fetch & { seen: Request[] };
	fetchMock.seen = seen;
	return fetchMock;
}

const html = (body: string, status = 200): Response => new Response(body, { status, headers: { "content-type": "text/html" } });

// ---------------------------------------------------------------------------
// s1 — Query parsing
// ---------------------------------------------------------------------------

describe("web search plugin", () => {
	test("query parsing: directives, phrases, OR groups and dates", () => {
		const q = parseSearchQuery(
			'site:arxiv.org transformer -site:twitter.com after:2024-03 filetype:pdf "exact phrase" (react OR vue) -excluded',
		);
		expect(q.sites).toEqual(["arxiv.org"]);
		expect(q.excludedSites).toEqual(["twitter.com"]);
		expect(q.after).toBe("2024-03-01");
		expect(q.filetypes).toEqual(["pdf"]);
		expect(q.hasDirectives).toBe(true);
		expect(q.hasConstraints).toBe(true);
		expect(q.terms.some((term) => term.phrase && term.text === "exact phrase")).toBe(true);
		const react = q.terms.find((term) => term.text === "react");
		const vue = q.terms.find((term) => term.text === "vue");
		expect(react?.group).toBeDefined();
		expect(react?.group).toBe(vue?.group);
		expect(q.terms.some((term) => term.negated && term.text === "excluded")).toBe(true);
		expect(q.text).toContain("transformer");

		// Lenient degradation: unknown name:value tokens stay verbatim free
		// text; unparseable directive values degrade to plain terms.
		const weird = parseSearchQuery("before:someday C:\\path TS2345: https://example.com/x");
		expect(weird.before).toBeUndefined();
		expect(weird.terms.some((term) => term.text === "before:someday")).toBe(true);
		expect(weird.terms.some((term) => term.text === "C:\\path")).toBe(true);
		expect(weird.terms.some((term) => term.text === "https://example.com/x")).toBe(true);

		// Date forms: bare year/month, slashes, day-first ambiguity, invalid.
		expect(parseDateValue("2024")).toBe("2024-01-01");
		expect(parseDateValue("2024/5/3")).toBe("2024-05-03");
		expect(parseDateValue("25/12/2024")).toBe("2024-12-25");
		expect(parseDateValue("2024-13-01")).toBeUndefined();

		// `site: example.com` adopts the next token; allintitle captures the tail.
		const spaced = parseSearchQuery("site: example.com");
		expect(spaced.sites).toEqual(["example.com"]);
		const allTitle = parseSearchQuery("allintitle: budget tips");
		expect(allTitle.inTitle).toEqual(["budget", "tips"]);

		// Locale mapping through DDG's region-language order and aliases.
		expect(localeToKl("ko-kr")).toBe("kr-kr");
		expect(localeToKl("en-gb")).toBe("uk-en");
		expect(localeToKl("xx-yy")).toBeUndefined();
		expect(localeToKl(undefined)).toBeUndefined();
	});

	// -------------------------------------------------------------------------
	// s2 — Scraper demotion and the non-empty law
	// -------------------------------------------------------------------------

	test("scraper demotion and the non-empty engine query law", () => {
		// Path-carrying site: demotes to a plain keyword; bare domains stay.
		expect(formatScraperQuery("site:github.com/anthropics claude")).toBe("claude github.com/anthropics");
		expect(formatScraperQuery("site:github.com claude")).toBe("claude site:github.com");
		// inurl: demotes everywhere in the scraper set.
		expect(formatScraperQuery("inurl:docs bun")).toBe("bun docs");
		// Negated forms pass through untouched — demotion would invert them.
		expect(formatScraperQuery("-site:twitter.com news")).toBe("news -site:twitter.com");
		expect(formatScraperQuery("-inurl:login docs")).toBe("docs -inurl:login");
		// Directive-free queries are byte-identical.
		expect(formatScraperQuery("hello world")).toBe("hello world");

		// Non-empty law: for any non-empty raw query the formatted engine
		// query stays non-empty even with an empty engine syntax.
		const inputs = ["site:arxiv.org", "filetype:pdf", "intitle:nothing", "after:2024-01-01 before:2024-12-31", "site:example.com filetype:html"];
		for (const raw of inputs) {
			const parsed = parseSearchQuery(raw);
			expect(formatQuery(parsed, {}).length).toBeGreaterThan(0);
			expect(formatScraperQuery(raw).length).toBeGreaterThan(0);
		}

		// OR groups render parenthesized with or syntax, flattened without.
		const orq = parseSearchQuery("react OR vue");
		expect(formatQuery(orq, { or: true })).toBe("(react OR vue)");
		expect(formatQuery(orq, {})).toBe("react vue");
	});

	// -------------------------------------------------------------------------
	// s3 — Lenient constraint post-filter
	// -------------------------------------------------------------------------

	test("lenient constraints never empty the result set", () => {
		const sources: SearchSource[] = [
			{ title: "Bun docs", url: "https://bun.sh/docs/install", publishedDate: "2026-08-01T00:00:00Z" },
			{ title: "Bun blog", url: "https://bun.sh/blog", publishedDate: "2026-09-01T00:00:00Z" },
			{ title: "Twitter thread", url: "https://x.com/bunjs/status/1" },
			{ title: "Undated paper", url: "https://arxiv.org/abs/2401.00001" },
		];

		// A dimension nothing matches is relaxed and reported, not enforced.
		const nothing = applyQueryConstraints(sources, parseSearchQuery("site:nonexistent.example"));
		expect(nothing.sources).toHaveLength(4);
		expect(nothing.dropped).toEqual(["site:nonexistent.example"]);

		// Matching dimensions compose in order and keep filtering.
		const mixed = applyQueryConstraints(sources, parseSearchQuery("site:bun.sh -site:x.com after:2026-01-01"));
		expect(mixed.sources.map((source) => source.url)).toEqual(["https://bun.sh/docs/install", "https://bun.sh/blog"]);
		expect(mixed.dropped).toEqual([]);

		// A dimension that would wipe out only the survivors is relaxed with a label.
		const relaxedDate = applyQueryConstraints(sources, parseSearchQuery("site:bun.sh before:2020-01-01"));
		expect(relaxedDate.sources).toHaveLength(2);
		expect(relaxedDate.dropped).toEqual(["before:2020-01-01"]);

		// Undated sources pass date bounds: a missing date is not proof of violation.
		const undated = applyQueryConstraints([sources[3]!], parseSearchQuery("after:2025-01-01"));
		expect(undated.sources).toHaveLength(1);
		expect(undated.dropped).toEqual([]);

		// The empty-input case is explicit: no sources, no dropped labels.
		expect(applyQueryConstraints([], parseSearchQuery("site:x.com"))).toEqual({ sources: [], dropped: [] });
	});

	// -------------------------------------------------------------------------
	// s4 — DuckDuckGo
	// -------------------------------------------------------------------------

	test("duckduckgo parses, paginates and surfaces bot challenges", async () => {
		const real = await readFile(join(fixtures, "duckduckgo.html"), "utf8");
		const parsed = parseDdgHtml(real);
		expect(parsed.length).toBeGreaterThanOrEqual(10);
		expect(parsed[0]!.url).toBe("https://github.com/Microsoft/TypeScript/releases");
		expect(parsed[0]!.title.length).toBeGreaterThan(0);
		expect(parsed.some((row) => (row.snippet ?? "").length > 0)).toBe(true);

		// The captured page carries the continuation form (s + vqd).
		const form = parseContinuationForm(real);
		expect(form?.has("s")).toBe(true);
		expect(form?.has("vqd")).toBe(true);

		// uddg redirect unwrapping.
		const wrapped = parseDdgHtml(
			'<div class="result results_links"><h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fq%3D1">Example</a></h2></div>',
		);
		expect(wrapped[0]!.url).toBe("https://example.com/a?q=1");

		const params = (overrides: Partial<SearchParams> = {}): SearchParams => ({
			query: "typescript release notes",
			timeoutMs: 5_000,
			...overrides,
		});

		// Bot-detection anomaly modal → provider-tagged 429 so the chain advances.
		await expect(
			searchDuckDuckGo(params({ fetch: fetchScript([html('<html><body><div class="anomaly-modal">are you a robot</div></body></html>')]) })),
		).rejects.toThrow("bot-detection");
		await expect(
			searchDuckDuckGo(params({ fetch: fetchScript([html('<div class="anomaly-modal">x</div>')]) })),
		).rejects.toMatchObject({ status: 429 });

		// Pagination: page 1 has two results plus a continuation form, page 2
		// adds one more (plus a duplicate URL); limit 3 stops after page 2.
		const page1 = `<div class="result"><a class="result__a" href="https://a.example/1">A1</a><a class="result__snippet">s1</a></div>
			<div class="result"><a class="result__a" href="https://a.example/2">A2</a></div>
			<form><input type="hidden" name="s" value="20"><input type="hidden" name="vqd" value="vqd-1"></form>`;
		const page2 = `<div class="result"><a class="result__a" href="https://a.example/2">A2</a></div>
			<div class="result"><a class="result__a" href="https://a.example/3">A3</a></div>`;
		const paging = fetchScript([html(page1), html(page2)]);
		const response = await searchDuckDuckGo(
			params({ limit: 3, fetch: paging, recency: "week", query: "site:a.example ko lang:ko-kr" }),
		);
		expect(response.sources.map((source) => source.url)).toEqual([
			"https://a.example/1",
			"https://a.example/2",
			"https://a.example/3",
		]);
		expect(paging.seen).toHaveLength(2);
		// The first request is a POST whose form carries query, region and recency.
		const first = paging.seen[0]!;
		expect(first.method).toBe("POST");
		const body = new URLSearchParams(await first.text());
		expect(body.get("q")).toContain("site:a.example");
		expect(body.get("kl")).toBe("kr-kr");
		expect(body.get("df")).toBe("w");
	});

	// -------------------------------------------------------------------------
	// s5 — Startpage
	// -------------------------------------------------------------------------

	test("startpage posts the lifted form token and detects challenges", async () => {
		const home = `<html><body>
			<form method="POST" action="/sp/search">
				<input type="hidden" name="sc" value="token-123">
				<input type="hidden" name="cat" value="web">
				<input type="text" name="query" value="">
			</form></body></html>`;
		const inputs = parseSearchFormInputs(home);
		expect(inputs).toMatchObject({ sc: "token-123", cat: "web" });
		expect(parseSearchFormInputs("<form action='/other'><input name='sc' value='x'></form>")).toBeUndefined();

		const results = `<div class="result">
				<a class="result-link" href="https://bun.sh/docs"><h2 class="wgl-title">Bun <b>Docs</b></h2></a>
				<p class="description">Bun documentation &amp; guides</p>
			</div>
			<div class="a-bg-result"><a class="result-link" href="https://ads.example/x"><h2>ad</h2></a></div>
			<div class="result-container"><a class="result-link" href="https://nested.example"><h2>nested</h2></a></div>`;
		const parsed = parseStartpageHtml(results);
		expect(parsed).toEqual([{ title: "Bun Docs", url: "https://bun.sh/docs", snippet: "Bun documentation & guides" }]);

		// Token-based block splitting: the exact `result` class token only.
		expect(splitClassBlocks(results, "div", "result")).toHaveLength(1);

		expect(sanitizeResultUrl("https://x.com/a", "https://www.startpage.com/")).toBe("https://x.com/a");
		// Relative hrefs on Startpage itself resolve inwards and are dropped; a
		// mirror base keeps external relative targets.
		expect(sanitizeResultUrl("/relative", "https://www.startpage.com/")).toBeUndefined();
		expect(sanitizeResultUrl("/docs", "https://mirror.example/")).toBe("https://mirror.example/docs");
		expect(sanitizeResultUrl("https://www.startpage.com/sp/captcha", "https://www.startpage.com/")).toBeUndefined();
		expect(sanitizeResultUrl("javascript:alert(1)", "https://www.startpage.com/")).toBeUndefined();

		const params = (fetchImpl: typeof fetch): SearchParams => ({ query: "bun docs", timeoutMs: 5_000, fetch: fetchImpl });

		// Happy path: lift the sc token from the homepage, POST it back with the query.
		const posted = fetchScript([html(home), html(results)]);
		const response = await searchStartpage(params(posted), "https://mirror.example");
		expect(response.provider).toBe("startpage");
		expect(response.sources[0]!.url).toBe("https://bun.sh/docs");
		expect(posted.seen).toHaveLength(2);
		const search = posted.seen[1]!;
		expect(search.method).toBe("POST");
		const body = new URLSearchParams(await search.text());
		expect(body.get("sc")).toBe("token-123");
		expect(body.get("query")).toBe("bun docs");

		// No token on the homepage: tokenless GET fallback with query params.
		const tokenless = fetchScript([html("<html><body>no form here</body></html>"), html(results)]);
		const got = await searchStartpage(params(tokenless), "https://mirror.example");
		expect(got.sources[0]!.url).toBe("https://bun.sh/docs");
		expect(tokenless.seen[1]!.method).toBe("GET");
		expect(new URL(tokenless.seen[1]!.url).searchParams.get("query")).toBe("bun docs");

		// Challenge shell (captcha component marker in the body) → provider-tagged 429.
		const challenged = fetchScript([
			html("<html></html>"),
			html('<html><script src="/app/component---src-pages-captcha-xyz.js"></script></html>'),
		]);
		await expect(searchStartpage(params(challenged), "https://mirror.example")).rejects.toMatchObject({ status: 429 });
	});

	// -------------------------------------------------------------------------
	// s6 — Chain semantics
	// -------------------------------------------------------------------------

	test("the chain advances on failure, rethrows aborts and aggregates errors", async () => {
		const sources: SearchSource[] = [
			{ title: "Bun docs", url: "https://bun.sh/docs/install" },
			{ title: "X thread", url: "https://x.com/bunjs/status/1" },
		];

		const stub = (id: string, behavior: () => Promise<SearchResponse>): SearchProvider => ({
			id: id as SearchProvider["id"],
			label: id,
			search: async (params) => {
				// Real transports reject immediately on an aborted signal; mirror that.
				if (params.signal?.aborted) throw new DOMException("aborted", "AbortError");
				return behavior();
			},
		});

		// Failure → advance; first renderable response wins; both earlier
		// failures (challenge, empty renderable) are recorded in order.
		const challenged = stub("startpage", async () => {
			throw new SearchProviderError("startpage", "CAPTCHA challenge", 429);
		});
		const empty = stub("startpage", async () => ({ provider: "startpage", sources: [] }));
		const healthy = stub("duckduckgo", async () => ({ provider: "duckduckgo", sources }));
		const advance = await executeSearch("bun docs", {}, { providers: [challenged, empty, healthy], timeoutMs: 1_000 });
		expect(advance.provider).toBe("duckduckgo");
		expect(advance.sources).toEqual(sources);
		expect(advance.failures.map((failure) => failure.provider)).toEqual(["startpage", "startpage"]);
		expect(advance.failures[1]!.message).toContain("no renderable search content");

		// Lenient post-filter runs on the winning response and reports relaxations.
		const filtered = await executeSearch("site:nonexistent.example bun", {}, { providers: [healthy], timeoutMs: 1_000 });
		expect(filtered.sources).toEqual(sources);
		expect(filtered.notes).toEqual(["no results matched `site:nonexistent.example`; the constraint was relaxed"]);
		expect(filtered.text).toContain("Note: no results matched");
		const enforced = await executeSearch("site:bun.sh", {}, { providers: [healthy], timeoutMs: 1_000 });
		expect(enforced.sources).toHaveLength(1);
		expect(enforced.notes).toEqual([]);

		// All engines failed: one aggregated Error text, no throw.
		const all = await executeSearch("q", {}, { providers: [challenged, empty, challenged], timeoutMs: 1_000 });
		expect(all.error).toContain("All web search engines failed");
		expect(all.text).toStartWith("Error:");
		expect(all.sources).toEqual([]);
		const single = await executeSearch("q", {}, { providers: [challenged], timeoutMs: 1_000 });
		expect(single.text).toBe("Error: startpage: CAPTCHA challenge");

		// Caller abort is rethrown, never recorded as a provider failure.
		const controller = new AbortController();
		controller.abort();
		await expect(executeSearch("q", {}, { providers: [healthy], timeoutMs: 1_000, signal: controller.signal })).rejects.toBeInstanceOf(
			Error,
		);

		// Deterministic output: notes first, numbered sources, 240-char snippet truncation.
		const formatted = formatForLLM([{ title: "t", url: "https://u.example", snippet: "x".repeat(300) }], ["note one"]);
		expect(formatted).toStartWith("Note: note one");
		expect(formatted).toContain("## Sources\n1 source");
		expect(formatted).toContain("[1] t\n    https://u.example");
		expect(formatted).toContain(`${"x".repeat(239)}…`);
	});

	// -------------------------------------------------------------------------
	// Plugin contract, bot integration, separability
	// -------------------------------------------------------------------------

	async function load(config: Record<string, unknown> = {}): Promise<LoadedPlugin> {
		const loaded = await loadPlugin(webPlugin, config);
		if (Array.isArray(loaded)) throw new Error(loaded.join("\n"));
		return loaded;
	}

	test("config and tool surface validate without network", async () => {
		const loaded = await load();
		expect(loaded.tools).toHaveLength(1);
		expect(loaded.tools[0]!).toMatchObject({ name: "web_search", readOnly: true });

		const invalid = await loadPlugin(webPlugin, { engines: ["brave"] });
		expect(Array.isArray(invalid)).toBe(true);
		const emptyEngines = await loadPlugin(webPlugin, { engines: [] });
		expect(Array.isArray(emptyEngines)).toBe(true);

		const tool = loaded.tools[0]!;
		await expect(tool.execute({ query: "" }, {})).rejects.toThrow("invalid arguments");
		await expect(tool.execute({ query: "q", limit: 99 }, {})).rejects.toThrow("invalid arguments");
		await expect(tool.execute({ query: "q", recency: "hour" }, {})).rejects.toThrow("invalid arguments");
	});

	let dir: string | undefined;
	const bots: Bot[] = [];
	afterEach(async () => {
		for (const bot of bots.splice(0)) await bot.close(context).catch(() => undefined);
	});
	afterAll(async () => {
		for (const bot of bots.splice(0)) await bot.close(context).catch(() => undefined);
		if (dir !== undefined) await rm(dir, { recursive: true, force: true });
		dir = undefined;
	});

	test("bot integration: web_search in codemode-only, hybrid and direct", async () => {
		const page = await readFile(join(fixtures, "duckduckgo.html"), "utf8");
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: (request) =>
				request.method === "POST" ? new Response(page, { headers: { "content-type": "text/html" } }) : new Response("not found", { status: 404 }),
		});
		try {
			const engineUrl = `http://127.0.0.1:${server.port}`;
			async function startBot(toolMode: ToolMode) {
				dir ??= await mkdtemp(join(tmpdir(), "dinobot-web-"));
				const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
				const models = createModels();
				models.setProvider(faux.provider);
				const storage = await openNodeSqliteStorage(join(dir, `${toolMode}.sqlite`));
				const bot = await openBot(
					{
						storage,
						models,
						defaultModel: { provider: "faux", modelId: "faux-1" },
						toolMode,
						plugins: [await load({ engines: ["duckduckgo"], endpoints: { duckduckgo: engineUrl } })],
					},
					context,
				);
				bots.push(bot);
				return { bot, faux };
			}

			const message = { channel: "test", threadKey: "G1", messageId: "m1", userId: "U1", text: "search the web" };

			for (const toolMode of ["codemode-only", "hybrid"] as const) {
				const { bot, faux } = await startBot(toolMode);
				let toolResult = "";
				let system = "";
				const offered: string[] = [];
				faux.setResponses([
					(transcript) => {
						const systems = transcript.messages.filter((entry) => entry.role === "system") as { toolsAdded?: { name: string }[] }[];
						system = JSON.stringify(systems);
						for (const entry of systems) offered.push(...(entry.toolsAdded ?? []).map((added) => added.name));
						return fauxAssistantMessage(
							fauxToolCall("codemode", {
								code: 'const r = await tools.web_search({ query: "typescript release notes", limit: 5 });\nreturn { r };',
							}),
							{ stopReason: "toolUse" },
						);
					},
					(transcript) => {
						toolResult = JSON.stringify(transcript.messages.at(-1));
						return fauxAssistantMessage("done");
					},
				]);
				expect(await bot.handle(message, context)).toMatchObject({ status: "answered", text: "done" });
				if (toolMode === "codemode-only") {
					expect(system).toContain("web_search");
					expect(system).toContain("tool_search");
				} else {
					expect(system).toContain(JSON.stringify("web_search"));
				}
				expect(offered.includes("web_search")).toBe(toolMode === "hybrid");
				expect(toolResult).toContain("https://github.com/Microsoft/TypeScript/releases");
				expect(toolResult).toContain("duckduckgo");
			}

			const { bot, faux } = await startBot("direct");
			const offered: string[] = [];
			let toolResult = "";
			faux.setResponses([
				(transcript) => {
					for (const entry of transcript.messages as { role: string; toolsAdded?: { name: string }[] }[]) {
						if (entry.role === "system") offered.push(...(entry.toolsAdded ?? []).map((added) => added.name));
					}
					return fauxAssistantMessage(fauxToolCall("web_search", { query: "typescript release notes", limit: 3 }), { stopReason: "toolUse" });
				},
				(transcript) => {
					toolResult = JSON.stringify(transcript.messages.at(-1));
					return fauxAssistantMessage("done");
				},
			]);
			await bot.handle(message, context);
			expect(offered).toContain("web_search");
			expect(toolResult).toContain("https://github.com/Microsoft/TypeScript/releases");
		} finally {
			server.stop(true);
		}
	}, 60_000);

	test("bot integration: the default manifest offers web_search; web: false removes it", async () => {
		const message = { channel: "test", threadKey: "G2", messageId: "m1", userId: "U1", text: "which tools can you use?" };
		async function offered(plugins: Record<string, unknown>, file: string) {
			// The real catalog and manifest loader, exactly as `dinobot serve` resolves `plugins:` (ADR 0058).
			const manifest = await parseManifest(
				{ bot: { enabled: false, dataDir: ".data", model: { provider: "faux", modelId: "faux-1" }, toolMode: "hybrid" }, channels: {}, plugins },
				{ channels: {}, plugins: pluginCatalog },
			);
			dir ??= await mkdtemp(join(tmpdir(), "dinobot-web-"));
			const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
			const models = createModels();
			models.setProvider(faux.provider);
			const storage = await openNodeSqliteStorage(join(dir, file));
			const bot = await openBot(
				{ storage, models, defaultModel: { provider: "faux", modelId: "faux-1" }, toolMode: "hybrid", plugins: manifest.plugins },
				context,
			);
			bots.push(bot);
			const sections: Record<string, string> = {};
			const names: string[] = [];
			faux.setResponses([
				(transcript) => {
					const systems = transcript.messages.filter((entry) => entry.role === "system") as {
						sections?: Record<string, string>;
						toolsAdded?: { name: string }[];
					}[];
					for (const entry of systems) {
						Object.assign(sections, entry.sections ?? {});
						names.push(...(entry.toolsAdded ?? []).map((added) => added.name));
					}
					return fauxAssistantMessage("done");
				},
			]);
			expect(await bot.handle(message, context)).toMatchObject({ status: "answered", text: "done" });
			return { sections, names };
		}

		const on = await offered({}, "default-on.sqlite");
		expect(on.names).toContain("web_search");
		expect(on.sections.plugin_web).toContain("web_search runs one query through the first healthy keyless engine");
		const off = await offered({ web: false }, "default-off.sqlite");
		expect(off.names.length).toBeGreaterThan(0);
		expect(off.names).not.toContain("web_search");
		expect(Object.keys(off.sections).length).toBeGreaterThan(0);
		expect(off.sections.plugin_web).toBeUndefined();
	}, 60_000);

	test("separability: the plugin imports only its directory and ../types.ts", async () => {
		const root = join(import.meta.dir, "..", "src");
		const files: string[] = [];
		async function walk(path: string): Promise<void> {
			for (const entry of await readdir(path, { withFileTypes: true })) {
				if (entry.isDirectory()) await walk(join(path, entry.name));
				else if (entry.name.endsWith(".ts")) files.push(join(path, entry.name));
			}
		}
		await walk(root);
		const imports = async (path: string) => [...(await readFile(path, "utf8")).matchAll(/from "([^"]+)"/g)].map((match) => match[1]!);
		for (const path of files) {
			const name = relative(root, path);
			const specs = await imports(path);
			if (name.startsWith("plugins/web/")) {
				for (const spec of specs.filter((value) => value.startsWith("."))) {
					expect(spec.startsWith("./") || spec === "../types.ts").toBe(true);
				}
			} else if (name !== "plugins/index.ts") {
				expect(specs.filter((value) => value.includes("web/"))).toEqual([]);
			}
		}
	});
});
