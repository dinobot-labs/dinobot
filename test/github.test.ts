import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { channelCatalog } from "../src/channels/index.ts";
import { type Bot, openBot } from "../src/core/bot.ts";
import type { ToolMode } from "../src/core/toolmode.ts";
import { ManifestError, parseManifest } from "../src/manifest.ts";
import { type CheckClass, classifyCheckRun, classifyStatus, verdict } from "../src/plugins/github/checks.ts";
import { GitHubClient, parseApiUrl, segment } from "../src/plugins/github/http.ts";
import { githubPlugin, idempotencyMarker } from "../src/plugins/github/index.ts";
import { collect, tailPages, truncate } from "../src/plugins/github/paging.ts";
import { allowed, parsePattern, parseRepo } from "../src/plugins/github/repos.ts";
import { pluginCatalog } from "../src/plugins/index.ts";
import { type LoadedPlugin, loadPlugin } from "../src/plugins/types.ts";

const TOKEN = "ghp_test_secret_token_value";
const context = BACKGROUND_CONTEXT;

// ---------------------------------------------------------------------------
// Fake GitHub REST API: just enough of the real endpoints, with raw request capture.
// ---------------------------------------------------------------------------

type Recorded = { method: string; rawPath: string; segments: string[]; query: URLSearchParams; auth: string | null; accept: string | null };
type Json = Record<string, unknown>;

class FakeGitHub {
	server!: ReturnType<typeof Bun.serve>;
	requests: Recorded[] = [];
	override: ((request: Recorded) => Response | Promise<Response> | undefined) | undefined;
	issues: Json[] = [];
	comments = new Map<number, Json[]>();
	pullFiles: Json[] = [];
	statuses = new Map<string, Json[]>();
	checkRuns = new Map<string, Json[]>();
	nextId = 100_000;

	reset(): void {
		this.requests = [];
		this.override = undefined;
		this.issues = Array.from({ length: 250 }, (_, index) => {
			const number = 250 - index; // most recently updated first
			return {
				id: number,
				number,
				title: `item ${number}`,
				state: "open",
				user: { login: "alice" },
				labels: [{ name: "bug" }],
				assignees: [],
				comments: number === 1 ? 250 : 0,
				created_at: "2020-01-01T00:00:00Z",
				updated_at: "2020-01-01T00:00:00Z",
				closed_at: null,
				html_url: `https://github.example/acme/app/issues/${number}`,
				body: number === 1 ? "x".repeat(25_000) : `body ${number}`,
				...(number % 3 === 0 ? { pull_request: { url: "pr" } } : {}),
			};
		});
		this.comments = new Map([
			[1, Array.from({ length: 250 }, (_, index) => comment(1000 + index, `comment ${index}`, "2020-01-01T00:00:00Z"))],
		]);
		this.pullFiles = Array.from({ length: 250 }, (_, index) => ({
			sha: "f",
			filename: `src/file${index}.ts`,
			status: "modified",
			additions: 1,
			deletions: 0,
		}));
		this.statuses = new Map([
			["abc123", [{ id: 1, context: "ci/lint", state: "success", description: null, target_url: null }]],
			["feature/x", [{ id: 2, context: "ci/lint", state: "pending", description: null, target_url: null }]],
		]);
		this.checkRuns = new Map([
			["abc123", [{ id: 11, name: "test", status: "completed", conclusion: "success", html_url: null }]],
			["feature/x", [{ id: 12, name: "test", status: "completed", conclusion: "failure", html_url: null }]],
		]);
	}

	start(): void {
		this.reset();
		this.server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => this.handle(request) });
	}

	get url(): string {
		return `http://127.0.0.1:${this.server.port}`;
	}

	writes(): Recorded[] {
		return this.requests.filter((request) => request.method !== "GET");
	}

	private async handle(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const rawPath = url.pathname;
		const recorded: Recorded = {
			method: request.method,
			rawPath,
			segments: rawPath.split("/").slice(1).map(decodeURIComponent),
			query: url.searchParams,
			auth: request.headers.get("authorization"),
			accept: request.headers.get("accept"),
		};
		this.requests.push(recorded);
		const overridden = await this.override?.(recorded);
		if (overridden !== undefined) return overridden;
		if (recorded.auth !== `Bearer ${TOKEN}`) return Response.json({ message: "Bad credentials" }, { status: 401 });
		const body = request.method === "POST" ? ((await request.json()) as Json) : undefined;
		return this.route(recorded, body);
	}

	private route({ method, segments, query, accept }: Recorded, body: Json | undefined): Response {
			const [root, owner, name, kind, id, sub] = segments;
		// Real GitHub resolves owner and repository names case-insensitively.
		if (root !== "repos" || owner?.toLowerCase() !== "acme" || name?.toLowerCase() !== "app") return Response.json({ message: "Not Found" }, { status: 404 });
		const page = <T>(items: T[]) => {
			const perPage = Number(query.get("per_page") ?? 30);
			const index = Number(query.get("page") ?? 1);
			return items.slice((index - 1) * perPage, index * perPage);
		};
		const since = query.get("since");
		const recent = (item: Json) => since === null || String(item.updated_at) >= since;
		if (kind === "issues" && id === undefined) {
			if (method === "POST") {
				const number = this.issues.length + 1;
				const created = { ...this.issueTemplate(number), title: body!.title, body: body!.body, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
				this.issues.unshift(created);
				return Response.json(created, { status: 201 });
			}
			const state = query.get("state") ?? "open";
			return Response.json(page(this.issues.filter((issue) => (state === "all" || issue.state === state) && recent(issue))));
		}
		if (kind === "issues" && sub === undefined) {
			const issue = this.issues.find((item) => item.number === Number(id));
			return issue ? Response.json(issue) : Response.json({ message: "Not Found" }, { status: 404 });
		}
		if (kind === "issues" && sub === "comments") {
			const list = this.comments.get(Number(id)) ?? [];
			if (method === "POST") {
				const created = comment(this.nextId++, String(body!.body), new Date().toISOString());
				list.push(created);
				this.comments.set(Number(id), list);
				return Response.json(created, { status: 201 });
			}
			return Response.json(page(list.filter(recent)));
		}
		if (kind === "pulls" && sub === undefined) {
			if (accept === "application/vnd.github.diff") return new Response(`diff --git a/x b/x\n+${"😀".repeat(10)}\n`);
			return Response.json({
				number: Number(id),
				title: "Add feature",
				state: "open",
				draft: false,
				merged: false,
				mergeable: true,
				mergeable_state: "clean",
				user: { login: "bob" },
				base: { ref: "main", sha: "base000" },
				head: { ref: "feature/x", sha: "abc123", repo: { full_name: "acme/app" } },
				additions: 250,
				deletions: 0,
				changed_files: this.pullFiles.length,
				commits: 1,
				html_url: "https://github.example/acme/app/pull/7",
				body: "PR body",
			});
		}
		if (kind === "pulls" && sub === "files") return Response.json(page(this.pullFiles));
		if (kind === "commits" && sub === "status") {
			const list = this.statuses.get(id!) ?? [];
			return Response.json({ sha: id === "feature/x" ? "def456" : id, total_count: list.length, statuses: page(list) });
		}
		if (kind === "commits" && sub === "check-runs") {
			const list = this.checkRuns.get(id!) ?? [];
			return Response.json({ total_count: list.length, check_runs: page(list) });
		}
		if (kind === "contents") {
			const path = segments.slice(4).join("/");
			if (path === "") return Response.json([{ name: "README.md", path: "README.md", type: "file", size: 5, sha: "r" }]);
			if (path === "README.md") return Response.json(file(path, "hello"));
			if (path === "docs/한글 파일.md") return Response.json(file(path, `ref=${query.get("ref")}`));
			if (path === "logo.png") return Response.json(file(path, "\u0089PNG\u0000\u0001"));
			if (path === "big.txt") {
				if (accept === "application/vnd.github.raw") return new Response("large file body");
				return Response.json({ type: "file", path, name: path, sha: "b", size: 2_000_000, encoding: "none", content: "" });
			}
		}
		return Response.json({ message: "Not Found" }, { status: 404 });
	}

	private issueTemplate(number: number): Json {
		return {
			id: number,
			number,
			state: "open",
			user: { login: "dinobot" },
			labels: [],
			assignees: [],
			comments: 0,
			closed_at: null,
			html_url: `https://github.example/acme/app/issues/${number}`,
		};
	}
}

function comment(id: number, body: string, at: string): Json {
	return { id, user: { login: "alice" }, created_at: at, updated_at: at, html_url: `https://github.example/c/${id}`, body };
}

function file(path: string, text: string): Json {
	const encoded = Buffer.from(text, "utf8").toString("base64").replace(/(.{60})/g, "$1\n");
	return { type: "file", path, name: path.split("/").at(-1), sha: "s", size: text.length, encoding: "base64", content: encoded };
}

const github = new FakeGitHub();
const other = new FakeGitHub();
beforeAll(() => {
	github.start();
	other.start();
	process.env.DINOBOT_TEST_GITHUB_TOKEN = TOKEN;
});
afterAll(async () => {
	await github.server.stop(true);
	await other.server.stop(true);
	delete process.env.DINOBOT_TEST_GITHUB_TOKEN;
});
afterEach(() => {
	github.reset();
	other.reset();
});

async function load(config: Record<string, unknown> = {}): Promise<LoadedPlugin> {
	const result = await loadPlugin(githubPlugin, { tokenEnv: "DINOBOT_TEST_GITHUB_TOKEN", apiUrl: github.url, ...config });
	if (Array.isArray(result)) throw new Error(result.join("\n"));
	return result;
}

async function call(plugin: LoadedPlugin, name: string, args: unknown, signal?: AbortSignal): Promise<any> {
	const found = plugin.tools.find((entry) => entry.name === `github_${name}`);
	if (found === undefined) throw new Error(`no tool github_${name}`);
	return await found.execute(args, signal === undefined ? {} : { signal });
}

// ---------------------------------------------------------------------------
// Pure parts: checked exhaustively over bounded domains against their specifications.
// ---------------------------------------------------------------------------

describe("repository names and allowlist", () => {
	test("parses owner/name and rejects anything that is not exactly two safe parts", () => {
		expect(parseRepo("Acme/app.js")).toEqual({ owner: "Acme", name: "app.js" });
		for (const bad of ["", "acme", "acme/", "/app", "acme/app/x", "acme/..", "acme/.", "-x/app", "acme/a b", "acme/a%2F"]) {
			expect(() => parseRepo(bad)).toThrow("owner/name");
		}
	});

	test("matching is case-insensitive and equals the set definition over every pattern and repo", () => {
		const owners = ["acme", "ACME", "other"];
		const names = ["app", "App", "web"];
		const patterns = [...owners.flatMap((owner) => names.map((name) => `${owner}/${name}`)), ...owners.map((owner) => `${owner}/*`)];
		// Every subset of up to two patterns against every repository.
		const subsets: string[][] = [[]];
		for (const a of patterns) for (const b of patterns) subsets.push([a], [a, b]);
		for (const subset of subsets) {
			const parsed = subset.map(parsePattern);
			for (const owner of owners) {
				for (const name of names) {
					const expected = subset.some((pattern) => {
						const [patternOwner, patternName] = pattern.toLowerCase().split("/");
						return patternOwner === owner.toLowerCase() && (patternName === "*" || patternName === name.toLowerCase());
					});
					expect(allowed(parsed, { owner, name })).toBe(expected);
				}
			}
		}
		expect(allowed(undefined, { owner: "any", name: "thing" })).toBe(true);
		expect(() => parsePattern("acme/**")).toThrow();
		expect(() => parsePattern("*/*")).toThrow();
	});
});

describe("request URLs", () => {
	test("apiUrl requires https except on loopback and carries no credentials, query or fragment", () => {
		const rooted = (apiUrl: string) => new GitHubClient(parseApiUrl(apiUrl), TOKEN).url(["repos", "o", "r"]).href;
		expect(rooted("https://api.github.com")).toBe("https://api.github.com/repos/o/r");
		expect(rooted("https://api.github.com/")).toBe("https://api.github.com/repos/o/r");
		expect(rooted("https://ghe.example/api/v3/")).toBe("https://ghe.example/api/v3/repos/o/r");
		expect(rooted("https://ghe.example/api/v3//")).toBe("https://ghe.example/api/v3/repos/o/r");
		expect(parseApiUrl("http://127.0.0.1:9/").origin).toBe("http://127.0.0.1:9");
		for (const bad of ["http://api.github.com", "ftp://x", "https://u:p@x", "https://x/?a=1", "https://x/#f", "nope"]) {
			expect(() => parseApiUrl(bad)).toThrow();
		}
	});

	test("every segment round-trips as exactly one path segment and dot segments are rejected", () => {
		const client = new GitHubClient(parseApiUrl("https://ghe.example/api/v3"), TOKEN);
		const alphabet = ["a", ".", "/", "%", "?", "#", "\\", " ", "한", "😀"];
		const values: string[] = [""];
		for (let length = 1; length <= 3; length++) {
			for (const prefix of values.filter((value) => [...value].length === length - 1)) for (const char of alphabet) values.push(prefix + char);
		}
		for (const value of values) {
			if (value === "" || value === "." || value === "..") {
				expect(() => segment(value)).toThrow("invalid path segment");
				continue;
			}
			const url = client.url(["repos", value, "x"]);
			expect(url.origin).toBe("https://ghe.example");
			const parts = url.pathname.split("/");
			expect(parts.length).toBe(6);
			expect(parts.slice(0, 4)).toEqual(["", "api", "v3", "repos"]);
			expect(decodeURIComponent(parts[4]!)).toBe(value);
			expect(url.search).toBe("");
			expect(url.hash).toBe("");
		}
	});
});

describe("pagination", () => {
	/** Every sequence over `alphabet` up to `max` length. */
	function sequences<T>(alphabet: readonly T[], max: number): T[][] {
		const out: T[][] = [[]];
		for (let index = 0; index < out.length; index++) {
			const current = out[index]!;
			if (current.length < max) for (const symbol of alphabet) out.push([...current, symbol]);
		}
		return out;
	}

	test("collect equals its specification on every small source, page size, limit and page budget", async () => {
		// Items are [id, kept]; ids repeat to model duplicates across pages.
		const alphabet: [number, boolean][] = [[0, true], [1, true], [2, false], [1, false]];
		let cases = 0;
		for (const source of sequences(alphabet, 5)) {
			for (const perPage of [1, 2, 3]) {
				for (const maxPages of [1, 2, 3]) {
					for (const limit of [1, 2, 3, 4]) {
						let requests = 0;
						const result = await collect(
							async (page) => {
								requests++;
								return source.slice((page - 1) * perPage, page * perPage);
							},
							{ limit, perPage, maxPages, keep: ([, kept]) => kept, key: ([id]) => id },
						);
						// Specification: R = distinct kept items of the source in order; V = same over the readable prefix.
						const distinct = (items: [number, boolean][]) => {
							const seen = new Set<number>();
							return items.filter(([id, kept]) => kept && !seen.has(id) && (seen.add(id), true));
						};
						const all = distinct(source);
						const visible = distinct(source.slice(0, perPage * maxPages));
						expect(result.items).toEqual(visible.slice(0, limit));
						expect(requests).toBeLessThanOrEqual(maxPages);
						if (!result.truncated) expect(result.items).toEqual(all); // soundness
						if (all.length < limit && source.length < perPage * maxPages) expect(result.truncated).toBe(false); // tightness
						cases++;
					}
				}
			}
		}
		expect(cases).toBe(36 * ((4 ** 6 - 1) / 3));
	});

	test("tailPages covers exactly the last min(limit, total) items with at most ceil(limit/perPage)+1 pages", () => {
		for (let perPage = 1; perPage <= 7; perPage++) {
			for (let total = 0; total <= 30; total++) {
				for (let limit = 1; limit <= 30; limit++) {
					const pages = tailPages(total, limit, perPage);
					const covered = pages.flatMap((page) =>
						Array.from({ length: perPage }, (_, offset) => (page - 1) * perPage + offset).filter((index) => index < total),
					);
					const want = Math.min(limit, total);
					expect(covered.slice(covered.length - want)).toEqual(
						Array.from({ length: want }, (_, offset) => total - want + offset),
					);
					expect(pages.length).toBeLessThanOrEqual(Math.ceil(limit / perPage) + 1);
					for (const [index, page] of pages.entries()) if (index > 0) expect(page).toBe(pages[index - 1]! + 1);
					if (pages.length > 0) expect(covered.length - want).toBeLessThan(perPage); // first page is needed
				}
			}
		}
	});

	test("truncate never exceeds the limit and never leaves a lone surrogate", () => {
		const text = "a😀b😀😀c";
		for (let max = 0; max <= text.length + 1; max++) {
			const cut = truncate(text, max);
			expect(cut.text.length).toBeLessThanOrEqual(max);
			expect(cut.text.length).toBeGreaterThanOrEqual(max - 1);
			expect(text.startsWith(cut.text)).toBe(true);
			expect(cut.text.isWellFormed()).toBe(true);
			expect(cut.truncated).toBe(max < text.length);
		}
	});
});

describe("CI verdict", () => {
	const classes: CheckClass[] = ["success", "pending", "failure"];

	function multisets(size: number): CheckClass[][] {
		if (size === 0) return [[]];
		return multisets(size - 1).flatMap((rest) => classes.map((value) => [value, ...rest]));
	}

	test("verdict equals the quantifier definition for every list up to length 4 and is order independent", () => {
		for (let size = 0; size <= 4; size++) {
			for (const list of multisets(size)) {
				for (const complete of [true, false]) {
					const expected = list.includes("failure")
						? "failure"
						: !complete
							? "unknown"
							: list.length === 0
								? "none"
								: list.every((value) => value === "success")
									? "success"
									: "pending";
					expect(verdict(list, complete)).toBe(expected);
					expect(verdict([...list].reverse(), complete)).toBe(expected);
					expect(verdict([...list, ...list], complete)).toBe(expected); // idempotent join
				}
			}
		}
	});

	test("classification is total and only known successes count as success", () => {
		expect(["success", "pending", "failure", "error", "weird"].map(classifyStatus)).toEqual([
			"success",
			"pending",
			"failure",
			"failure",
			"failure",
		]);
		for (const status of ["queued", "in_progress", "waiting", "requested", "pending"]) expect(classifyCheckRun(status, null)).toBe("pending");
		const conclusions = ["success", "neutral", "skipped", "failure", "cancelled", "timed_out", "action_required", "stale", "startup_failure", "new"];
		expect(conclusions.map((value) => classifyCheckRun("completed", value))).toEqual([
			"success", "success", "success", "failure", "failure", "failure", "failure", "failure", "failure", "failure",
		]);
		expect(classifyCheckRun("completed", null)).toBe("failure");
	});
});

// ---------------------------------------------------------------------------
// Plugin against the fake API.
// ---------------------------------------------------------------------------

describe("github plugin loading", () => {
	test("is in the build catalog and read-only unless write is enabled", async () => {
		expect(pluginCatalog.github).toBe(githubPlugin);
		const readOnly = await load();
		expect(readOnly.tools.map((entry) => entry.name).sort()).toEqual([
			"github_get_checks",
			"github_get_file",
			"github_get_issue",
			"github_get_pull_request",
			"github_get_pull_request_diff",
			"github_list_comments",
			"github_list_issues",
		]);
		expect(readOnly.prompt).toContain("read-only");
		const writable = await load({ write: true });
		expect(writable.tools.map((entry) => entry.name)).toContain("github_comment");
		expect(writable.tools.map((entry) => entry.name)).toContain("github_create_issue");
		expect(github.requests).toEqual([]); // loading never touches the network
	});

	test("configuration problems are reported at boot with the manifest path", async () => {
		const problems = async (config: unknown) => {
			try {
				await parseManifest(
					{
						bot: { enabled: true, dataDir: ".data", model: { provider: "anthropic", modelId: "m" }, toolMode: "codemode-only" },
						channels: { http: { port: 8787 } },
						plugins: { github: config },
					},
					{ channels: channelCatalog, plugins: pluginCatalog },
				);
				return [];
			} catch (error) {
				if (error instanceof ManifestError) return error.problems;
				throw error;
			}
		};
		delete process.env.DINOBOT_MISSING_TOKEN;
		expect(await problems({ tokenEnv: "DINOBOT_MISSING_TOKEN" })).toEqual([
			"plugins.github: environment variable DINOBOT_MISSING_TOKEN is not set",
		]);
		const base = { tokenEnv: "DINOBOT_TEST_GITHUB_TOKEN" };
		expect((await problems({ ...base, apiUrl: "http://api.github.com" }))[0]).toContain("https");
		expect((await problems({ ...base, repositories: ["acme"] }))[0]).toContain("owner/*");
		expect((await problems({ ...base, repositories: [] }))[0]).toContain("plugins.github/repositories");
		expect((await problems({ ...base, token: "inline" }))[0]).toContain("plugins.github");
		expect(await problems({ ...base, apiUrl: github.url, repositories: ["acme/*"], write: true })).toEqual([]);
	});
});

describe("github read tools", () => {
	test("list_issues filters kind across pages, honors the limit and reports truncation soundly", async () => {
		const plugin = await load();
		const issues = await call(plugin, "list_issues", { repo: "acme/app", kind: "issue", limit: 100 });
		expect(issues.items).toHaveLength(100);
		expect(issues.items.every((item: { kind: string }) => item.kind === "issue")).toBe(true);
		expect(issues.items[0].number).toBe(250);
		expect(issues.truncated).toBe(true);
		const pulls = await call(plugin, "list_issues", { repo: "acme/app", kind: "pull_request", limit: 100 });
		expect(pulls.items).toHaveLength(83); // multiples of 3 up to 250
		expect(pulls.truncated).toBe(false);
		const labels = github.requests.at(-1)!.query;
		expect(labels.get("state")).toBe("open");
		expect(labels.get("per_page")).toBe("100");
	});

	test("get_issue truncates long bodies and says so", async () => {
		const issue = await call(await load(), "get_issue", { repo: "acme/app", number: 1 });
		expect(issue.body).toHaveLength(20_000);
		expect(issue.bodyTruncated).toBe(true);
		expect(issue.bodyChars).toBe(25_000);
		expect(issue.labels).toEqual(["bug"]);
		expect(github.requests.map((request) => request.rawPath)).toEqual(["/repos/acme/app/issues/1"]);
	});

	test("list_comments returns the most recent comments in order with the minimal page reads", async () => {
		const result = await call(await load(), "list_comments", { repo: "acme/app", number: 1, limit: 100 });
		expect(result.comments.map((entry: { id: number }) => entry.id)).toEqual(Array.from({ length: 100 }, (_, index) => 1150 + index));
		expect(result.total).toBe(250);
		expect(result.truncated).toBe(true);
		const pages = github.requests.filter((request) => request.segments.at(-1) === "comments").map((request) => request.query.get("page"));
		expect(pages.sort()).toEqual(["2", "3"]);
	});

	test("get_pull_request pages changed files up to fileLimit", async () => {
		const plugin = await load();
		const pull = await call(plugin, "get_pull_request", { repo: "acme/app", number: 7, fileLimit: 150 });
		expect(pull.head).toEqual({ ref: "feature/x", sha: "abc123", repo: "acme/app" });
		expect(pull.files).toHaveLength(150);
		expect(pull.filesTruncated).toBe(true);
		const all = await call(plugin, "get_pull_request", { repo: "acme/app", number: 7, fileLimit: 3000 });
		expect(all.files).toHaveLength(250);
		expect(all.filesTruncated).toBe(false);
	});

	test("get_pull_request_diff requests the diff media type and truncates on code points", async () => {
		const result = await call(await load(), "get_pull_request_diff", { repo: "acme/app", number: 7, maxChars: 22 });
		expect(github.requests.at(-1)!.accept).toBe("application/vnd.github.diff");
		expect(result.truncated).toBe(true);
		expect(result.diff.isWellFormed()).toBe(true);
		expect(result.totalChars).toBe(`diff --git a/x b/x\n+${"😀".repeat(10)}\n`.length);
	});

	test("get_checks joins statuses and check runs; a PR number resolves to its head SHA", async () => {
		const plugin = await load();
		const green = await call(plugin, "get_checks", { repo: "acme/app", number: 7 });
		expect(green.sha).toBe("abc123");
		expect(green.verdict).toBe("success");
		expect(green.complete).toBe(true);
		const red = await call(plugin, "get_checks", { repo: "acme/app", ref: "feature/x" });
		expect(red.verdict).toBe("failure");
		expect(red.checks[0].class).toBe("failure");
		expect(red.sha).toBe("def456");
		const raw = github.requests.filter((request) => request.segments[5] === "status").at(-1)!.rawPath;
		expect(raw).toBe("/repos/acme/app/commits/feature%2Fx/status"); // a branch with "/" stays one segment
		expect(await call(plugin, "get_checks", { repo: "acme/app", ref: "nothing" })).toMatchObject({ verdict: "none", complete: true });
		await expect(call(plugin, "get_checks", { repo: "acme/app" })).rejects.toThrow("exactly one");
	});

	test("get_checks never claims success from a partial list", async () => {
		github.checkRuns.set("many", Array.from({ length: 1001 }, (_, index) => ({ id: index, name: `t${index}`, status: "completed", conclusion: "success", html_url: null })));
		const result = await call(await load(), "get_checks", { repo: "acme/app", ref: "many" });
		expect(result.complete).toBe(false);
		expect(result.verdict).toBe("unknown");
	});

	test("get_file decodes text, lists directories, detects binary and falls back to raw for large files", async () => {
		const plugin = await load();
		expect(await call(plugin, "get_file", { repo: "acme/app", path: "README.md" })).toMatchObject({ type: "file", content: "hello", truncated: false });
		expect((await call(plugin, "get_file", { repo: "acme/app", path: "" })).entries[0].name).toBe("README.md");
		expect(await call(plugin, "get_file", { repo: "acme/app", path: "logo.png" })).toMatchObject({ binary: true });
		expect(await call(plugin, "get_file", { repo: "acme/app", path: "big.txt" })).toMatchObject({ content: "large file body" });
		expect(github.requests.at(-1)!.accept).toBe("application/vnd.github.raw");
		const unicode = await call(plugin, "get_file", { repo: "acme/app", path: "docs/한글 파일.md", ref: "release/1.0" });
		expect(unicode.content).toBe("ref=release/1.0");
		expect(github.requests.at(-1)!.rawPath).toBe("/repos/acme/app/contents/docs/%ED%95%9C%EA%B8%80%20%ED%8C%8C%EC%9D%BC.md");
	});
});

describe("github safety", () => {
	test("traversal, malformed arguments and disallowed repositories fail before any request", async () => {
		const plugin = await load({ repositories: ["acme/app"] });
		await expect(call(plugin, "get_file", { repo: "acme/app", path: "../../user" })).rejects.toThrow("invalid path segment");
		await expect(call(plugin, "get_file", { repo: "acme/app", path: "a//b" })).rejects.toThrow("invalid path segment");
		await expect(call(plugin, "get_issue", { repo: "acme/other", number: 1 })).rejects.toThrow("not allowed");
		await expect(call(plugin, "get_issue", { repo: "ACME/APP", number: 0 })).rejects.toThrow("invalid arguments");
		await expect(call(plugin, "get_issue", { repo: "acme/app", number: 1, extra: true })).rejects.toThrow("invalid arguments");
		expect(github.requests).toEqual([]);
		expect((await call(plugin, "get_issue", { repo: "ACME/APP", number: 2 })).number).toBe(2);
	});

	test("redirects are not followed, so the token reaches only apiUrl", async () => {
		github.override = () => new Response(null, { status: 301, headers: { location: `${other.url}/repositories/1/issues/1` } });
		await expect(call(await load(), "get_issue", { repo: "acme/app", number: 1 })).rejects.toThrow("moved to");
		expect(other.requests).toEqual([]);
		expect(github.requests.every((request) => request.auth === `Bearer ${TOKEN}`)).toBe(true);
	});

	test("API errors keep GitHub's message and rate-limit reset but never the token", async () => {
		const plugin = await load();
		await expect(call(plugin, "get_issue", { repo: "acme/app", number: 999 })).rejects.toThrow("GitHub 404 GET /repos/acme/app/issues/999: Not Found");
		github.override = () =>
			Response.json({ message: "API rate limit exceeded" }, { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1700000000" } });
		const error = await call(plugin, "get_issue", { repo: "acme/app", number: 1 }).catch((caught: Error) => caught);
		expect(error.message).toContain("rate limit exhausted; resets at 2023-11-14T22:13:20.000Z");
		expect(error.message).not.toContain(TOKEN);
	});

	test("cancellation aborts the in-flight request", async () => {
		github.override = async () => {
			await Bun.sleep(5_000);
			return Response.json({});
		};
		const controller = new AbortController();
		const pending = call(await load(), "get_issue", { repo: "acme/app", number: 1 }, controller.signal);
		await Bun.sleep(50);
		const started = Date.now();
		controller.abort();
		await expect(pending).rejects.toThrow();
		expect(Date.now() - started).toBeLessThan(1_000);
	});
});

describe("github write tools", () => {
	test("comment is idempotent for a retried call and distinct for a different body", async () => {
		const plugin = await load({ write: true });
		const args = { repo: "acme/app", number: 1, body: "Looks good" };
		const first = await call(plugin, "comment", args);
		expect(first.deduplicated).toBe(false);
		// A retry after an interrupted call whose POST had already succeeded.
		const replay = await call(plugin, "comment", { ...args, repo: "Acme/App" });
		expect(replay).toEqual({ ...first, deduplicated: true });
		expect(github.writes()).toHaveLength(1);
		const posted = github.comments.get(1)!.at(-1)!;
		expect(posted.body).toBe(`Looks good\n\n${idempotencyMarker(["comment", "acme", "app", 1, "Looks good"])}`);
		expect((await call(plugin, "comment", { ...args, body: "Second thought" })).deduplicated).toBe(false);
		expect((await call(plugin, "comment", { ...args, number: 2 })).deduplicated).toBe(false);
		expect(github.writes()).toHaveLength(3);
		// The dedupe scan is bounded to the recent window.
		expect(github.requests.find((request) => request.method === "GET" && request.segments.at(-1) === "comments")!.query.get("since")).not.toBeNull();
	});

	test("comment refuses to post when it cannot rule out a duplicate", async () => {
		github.comments.set(5, Array.from({ length: 1000 }, (_, index) => comment(index, "noise", new Date().toISOString())));
		const plugin = await load({ write: true });
		await expect(call(plugin, "comment", { repo: "acme/app", number: 5, body: "hi" })).rejects.toThrow("not posting");
		expect(github.writes()).toEqual([]);
	});

	test("create_issue is idempotent over title, body, labels and assignees", async () => {
		const plugin = await load({ write: true });
		const args = { repo: "acme/app", title: "Flaky test", body: "details", labels: ["ci"] };
		const first = await call(plugin, "create_issue", args);
		expect(first.deduplicated).toBe(false);
		expect(await call(plugin, "create_issue", args)).toEqual({ ...first, deduplicated: true });
		expect((await call(plugin, "create_issue", { ...args, labels: ["ci", "p1"] })).deduplicated).toBe(false);
		expect(github.writes()).toHaveLength(2);
	});

	test("write tools obey the allowlist", async () => {
		const plugin = await load({ write: true, repositories: ["acme/web"] });
		await expect(call(plugin, "comment", { repo: "acme/app", number: 1, body: "x" })).rejects.toThrow("not allowed");
		expect(github.requests).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// End to end through the bot in both execution paths.
// ---------------------------------------------------------------------------

describe("github through the bot", () => {
	const bots: Bot[] = [];
	let dir: string | undefined;
	afterEach(async () => {
		for (const bot of bots.splice(0)) await bot.close(context);
		if (dir !== undefined) await rm(dir, { recursive: true, force: true });
		dir = undefined;
	});

	async function startBot(toolMode: ToolMode, config: Record<string, unknown> = {}) {
		dir ??= await mkdtemp(join(tmpdir(), "dinobot-github-"));
		const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
		const models = createModels();
		models.setProvider(faux.provider);
		const storage = await openNodeSqliteStorage(join(dir, `${toolMode}.sqlite`));
		const bot = await openBot(
			{ storage, models, defaultModel: { provider: "faux", modelId: "faux-1" }, toolMode, plugins: [await load(config)] },
			context,
		);
		bots.push(bot);
		return { bot, faux };
	}

	const message = { channel: "test", threadKey: "G1", messageId: "m1", userId: "U1", text: "what is issue 2?" };

	for (const toolMode of ["codemode-only", "hybrid"] as const) {
		test(`${toolMode}: codemode lists every github tool, including writes, and scripts can call reads and writes`, async () => {
			const { bot, faux } = await startBot(toolMode, { write: true });
			const every = (await load({ write: true })).tools.map((entry) => entry.name);
			expect(every).toHaveLength(9);
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
							code: [
								'const issue = await tools.github_get_issue({ repo: "acme/app", number: 2 });',
								'const posted = await tools.github_comment({ repo: "acme/app", number: 2, body: "from codemode" });',
								"return { issue, posted };",
							].join("\n"),
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
			// codemode-only lists names for contract discovery; hybrid declares each
			// tool directly (toolsAdded) with name, description and argument schema instead.
			if (toolMode === "codemode-only") {
				for (const name of every) expect(system).toContain(name);
				expect(system).toContain("tool_search");
			} else {
				for (const name of every) expect(system).toContain(JSON.stringify(name));
			}
			expect(system).toContain("github_get_checks verdict");
			// codemode-only hides plugin tools from direct calls; hybrid offers both paths.
			for (const name of every) expect(offered.includes(name)).toBe(toolMode === "hybrid");
			expect(toolResult).toContain("item 2");
			expect(toolResult).toContain("deduplicated");
			expect(github.writes()).toHaveLength(1);
			expect(github.comments.get(2)!.at(-1)!.body).toStartWith("from codemode");
		});
	}

	test("direct mode offers and runs github tools", async () => {
		const { bot, faux } = await startBot("direct");
		const offered: string[] = [];
		let toolResult = "";
		faux.setResponses([
			(transcript) => {
				for (const entry of transcript.messages as { role: string; toolsAdded?: { name: string }[] }[]) {
					if (entry.role === "system") offered.push(...(entry.toolsAdded ?? []).map((added) => added.name));
				}
				return fauxAssistantMessage(fauxToolCall("github_get_issue", { repo: "acme/app", number: 2 }), { stopReason: "toolUse" });
			},
			(transcript) => {
				toolResult = JSON.stringify(transcript.messages.at(-1));
				return fauxAssistantMessage("done");
			},
		]);
		await bot.handle(message, context);
		expect(offered).toContain("github_get_issue");
		expect(offered).not.toContain("github_comment");
		expect(toolResult).toContain("item 2");
	});
});

// ---------------------------------------------------------------------------
// Detachability: the plugin is one directory plus one catalog line.
// ---------------------------------------------------------------------------

test("the github plugin is detachable: no other module depends on it and it depends only on the plugin contract", async () => {
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
		if (name.startsWith("plugins/github/")) {
			for (const spec of specs.filter((value) => value.startsWith("."))) expect(spec.startsWith("./") || spec === "../types.ts").toBe(true);
		} else if (name !== "plugins/index.ts") {
			expect(specs.filter((value) => value.includes("github/"))).toEqual([]);
		}
	}
});

// ---------------------------------------------------------------------------
// Optional live check against api.github.com (read-only, public repository).
// DINOBOT_GITHUB_LIVE=1 GITHUB_TOKEN=$(gh auth token) bun test test/github.test.ts
// ---------------------------------------------------------------------------

test.skipIf(process.env.DINOBOT_GITHUB_LIVE !== "1")("live: read tools against api.github.com", async () => {
	const result = await loadPlugin(githubPlugin, { repositories: ["oven-sh/bun"] });
	if (Array.isArray(result)) throw new Error(result.join("\n"));
	const issues = await call(result, "list_issues", { repo: "oven-sh/bun", kind: "pull_request", state: "closed", limit: 3 });
	expect(issues.items).toHaveLength(3);
	const number = issues.items[0].number;
	const pull = await call(result, "get_pull_request", { repo: "oven-sh/bun", number, fileLimit: 5 });
	expect(pull.number).toBe(number);
	const checks = await call(result, "get_checks", { repo: "oven-sh/bun", number });
	expect(["none", "success", "pending", "failure", "unknown"]).toContain(checks.verdict);
	const diff = await call(result, "get_pull_request_diff", { repo: "oven-sh/bun", number, maxChars: 2000 });
	expect(diff.diff.length).toBeGreaterThan(0);
	const readme = await call(result, "get_file", { repo: "oven-sh/bun", path: "README.md" });
	expect(readme.content).toContain("Bun");
	const comments = await call(result, "list_comments", { repo: "oven-sh/bun", number, limit: 2 });
	expect(comments.comments.length).toBeLessThanOrEqual(2);
	await expect(call(result, "get_issue", { repo: "torvalds/linux", number: 1 })).rejects.toThrow("not allowed");
}, 60_000);
