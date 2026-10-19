import { createHash } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import { definePlugin, type PluginTool } from "../types.ts";
import { type CheckClass, classifyCheckRun, classifyStatus, verdict } from "./checks.ts";
import { GitHubClient, parseApiUrl } from "./http.ts";
import { collect, tailPages, truncate } from "./paging.ts";
import { allowed, parsePattern, parseRepo, type Repo, type RepoPattern } from "./repos.ts";

const PER_PAGE = 100;
const LIST_PAGES = 10;
const BODY_CHARS = 20_000;
const COMMENT_CHARS = 10_000;
/** Retries of an interrupted write come soon after it; one day bounds the duplicate scan with a wide margin over clock skew. */
const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

const config = Type.Object(
	{
		/** Environment variable holding the token. Secrets never live in the manifest. */
		tokenEnv: Type.Optional(Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]*$" })),
		/** REST root; GitHub Enterprise Server uses `https://<host>/api/v3`. */
		apiUrl: Type.Optional(Type.String({ minLength: 1 })),
		/** Allowlist of `owner/name` or `owner/*`. Omitted: every repository the token can reach. */
		repositories: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),
		/** Registers the comment and issue-creation tools. Off by default. */
		write: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

const repo = Type.String({ description: "Repository as owner/name" });
const number = Type.Integer({ minimum: 1, description: "Issue or pull request number" });

type User = { login: string } | null;
type Label = string | { name?: string };
type Issue = {
	id: number;
	number: number;
	title: string;
	state: string;
	state_reason?: string | null;
	user: User;
	labels: Label[];
	assignees?: { login: string }[] | null;
	comments: number;
	created_at: string;
	updated_at: string;
	closed_at: string | null;
	html_url: string;
	body?: string | null;
	pull_request?: unknown;
};
type Comment = { id: number; user: User; created_at: string; updated_at: string; html_url: string; body?: string | null };
type Pull = {
	number: number;
	title: string;
	state: string;
	draft?: boolean;
	merged: boolean;
	mergeable: boolean | null;
	mergeable_state?: string;
	user: User;
	base: { ref: string; sha: string };
	head: { ref: string; sha: string; repo: { full_name: string } | null };
	additions: number;
	deletions: number;
	changed_files: number;
	commits: number;
	html_url: string;
	body?: string | null;
};
type PullFile = { sha: string | null; filename: string; status: string; additions: number; deletions: number; previous_filename?: string };
type Status = { id: number; context: string; state: string; description: string | null; target_url: string | null };
type CheckRun = { id: number; name: string; status: string; conclusion: string | null; html_url: string | null };
type Content = {
	type: string;
	path: string;
	sha: string;
	size: number;
	name: string;
	encoding?: string;
	content?: string;
	target?: string;
	submodule_git_url?: string;
};

function check<T extends TSchema>(schema: T, args: unknown): Static<T> {
	if (Value.Check(schema, args)) return args;
	const problems = [...Value.Errors(schema, args)].map((error) => `${error.instancePath || "/"}: ${error.message}`);
	throw new Error(`invalid arguments: ${problems.join("; ")}`);
}

function login(user: User): string | null {
	return user?.login ?? null;
}

function issueSummary(issue: Issue) {
	return {
		number: issue.number,
		kind: issue.pull_request === undefined ? "issue" : "pull_request",
		title: issue.title,
		state: issue.state,
		author: login(issue.user),
		labels: issue.labels.map((label) => (typeof label === "string" ? label : (label.name ?? ""))),
		assignees: (issue.assignees ?? []).map((user) => user.login),
		comments: issue.comments,
		updated_at: issue.updated_at,
		url: issue.html_url,
	};
}

function body(text: string | null | undefined, max: number) {
	const cut = truncate(text ?? "", max);
	return { body: cut.text, ...(cut.truncated ? { bodyTruncated: true, bodyChars: (text ?? "").length } : {}) };
}

/** 128-bit content key of a write request; equal requests share a marker, distinct ones collide with negligible probability. */
export function idempotencyMarker(parts: readonly unknown[]): string {
	return `<!-- dinobot-idempotency:${createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32)} -->`;
}

function withMarker(text: string, marker: string): string {
	return text === "" ? marker : `${text}\n\n${marker}`;
}

function decodeText(bytes: Uint8Array): string | undefined {
	if (bytes.includes(0)) return undefined;
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return undefined;
	}
}

type Context = { client: GitHubClient; patterns: readonly RepoPattern[] | undefined };

function repoOf(context: Context, value: string): Repo {
	const parsed = parseRepo(value);
	if (!allowed(context.patterns, parsed)) throw new Error(`repository ${value} is not allowed by plugins.github.repositories`);
	return parsed;
}

function tool<T extends TSchema>(
	name: string,
	description: string,
	schema: T,
	run: (args: Static<T>, signal: AbortSignal | undefined) => Promise<unknown>,
): PluginTool {
	return {
		name,
		description,
		inputSchema: schema as unknown as PluginTool["inputSchema"],
		execute: async (args, { signal }) => await run(check(schema, args), signal),
	};
}

function readTools(context: Context): PluginTool[] {
	const { client } = context;
	return [
		tool(
			"list_issues",
			"List issues and/or pull requests of a repository, most recently updated first.",
			Type.Object(
				{
					repo,
					state: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("closed"), Type.Literal("all")])),
					kind: Type.Optional(Type.Union([Type.Literal("issue"), Type.Literal("pull_request"), Type.Literal("all")])),
					labels: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
					assignee: Type.Optional(Type.String({ minLength: 1 })),
					limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
				},
				{ additionalProperties: false },
			),
			async (args, signal) => {
				const { owner, name } = repoOf(context, args.repo);
				const kind = args.kind ?? "all";
				const result = await collect(
					(page) =>
						client.json<Issue[]>(["repos", owner, name, "issues"], {
							query: {
								state: args.state ?? "open",
								labels: args.labels?.join(","),
								assignee: args.assignee,
								sort: "updated",
								direction: "desc",
								per_page: PER_PAGE,
								page,
							},
							signal,
						}),
					{
						limit: args.limit ?? 30,
						perPage: PER_PAGE,
						maxPages: LIST_PAGES,
						keep: (issue) => kind === "all" || (kind === "pull_request") === (issue.pull_request !== undefined),
						key: (issue) => issue.id,
					},
				);
				return { items: result.items.map(issueSummary), truncated: result.truncated };
			},
		),
		tool(
			"get_issue",
			"Read one issue or pull request conversation header and body. Use get_pull_request for branch, merge and file details.",
			Type.Object({ repo, number }, { additionalProperties: false }),
			async (args, signal) => {
				const { owner, name } = repoOf(context, args.repo);
				const issue = await client.json<Issue>(["repos", owner, name, "issues", args.number], { signal });
				return {
					...issueSummary(issue),
					state_reason: issue.state_reason ?? null,
					created_at: issue.created_at,
					closed_at: issue.closed_at,
					...body(issue.body, BODY_CHARS),
				};
			},
		),
		tool(
			"list_comments",
			"Read the most recent comments of an issue or pull request conversation, oldest first.",
			Type.Object(
				{ repo, number, limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) },
				{ additionalProperties: false },
			),
			async (args, signal) => {
				const { owner, name } = repoOf(context, args.repo);
				const limit = args.limit ?? 30;
				const issue = await client.json<Issue>(["repos", owner, name, "issues", args.number], { signal });
				const pages = await Promise.all(
					tailPages(issue.comments, limit, PER_PAGE).map((page) =>
						client.json<Comment[]>(["repos", owner, name, "issues", args.number, "comments"], {
							query: { per_page: PER_PAGE, page },
							signal,
						}),
					),
				);
				const all = [...new Map(pages.flat().map((comment) => [comment.id, comment])).values()];
				const comments = all.slice(Math.max(0, all.length - limit));
				return {
					total: Math.max(issue.comments, all.length),
					truncated: comments.length < Math.max(issue.comments, all.length),
					comments: comments.map((comment) => ({
						id: comment.id,
						author: login(comment.user),
						created_at: comment.created_at,
						updated_at: comment.updated_at,
						url: comment.html_url,
						...body(comment.body, COMMENT_CHARS),
					})),
				};
			},
		),
		tool(
			"get_pull_request",
			"Read a pull request: branches, head SHA, merge state, size, body and changed files (without patches).",
			Type.Object(
				{ repo, number, fileLimit: Type.Optional(Type.Integer({ minimum: 0, maximum: 3000 })) },
				{ additionalProperties: false },
			),
			async (args, signal) => {
				const { owner, name } = repoOf(context, args.repo);
				const fileLimit = args.fileLimit ?? 300;
				const [pull, files] = await Promise.all([
					client.json<Pull>(["repos", owner, name, "pulls", args.number], { signal }),
					fileLimit === 0
						? Promise.resolve({ items: [] as PullFile[], truncated: true })
						: collect(
								(page) =>
									client.json<PullFile[]>(["repos", owner, name, "pulls", args.number, "files"], {
										query: { per_page: PER_PAGE, page },
										signal,
									}),
								{ limit: fileLimit, perPage: PER_PAGE, maxPages: Math.ceil(fileLimit / PER_PAGE), key: (file) => file.filename },
							),
				]);
				return {
					number: pull.number,
					title: pull.title,
					state: pull.state,
					draft: pull.draft ?? false,
					merged: pull.merged,
					mergeable: pull.mergeable,
					mergeable_state: pull.mergeable_state ?? null,
					author: login(pull.user),
					base: { ref: pull.base.ref, sha: pull.base.sha },
					head: { ref: pull.head.ref, sha: pull.head.sha, repo: pull.head.repo?.full_name ?? null },
					additions: pull.additions,
					deletions: pull.deletions,
					changed_files: pull.changed_files,
					commits: pull.commits,
					url: pull.html_url,
					...body(pull.body, BODY_CHARS),
					files: files.items.map((file) => ({
						filename: file.filename,
						status: file.status,
						additions: file.additions,
						deletions: file.deletions,
						...(file.previous_filename !== undefined ? { previous_filename: file.previous_filename } : {}),
					})),
					filesTruncated: files.items.length < pull.changed_files,
				};
			},
		),
		tool(
			"get_pull_request_diff",
			"Read the unified diff of a pull request, truncated to maxChars.",
			Type.Object(
				{ repo, number, maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })) },
				{ additionalProperties: false },
			),
			async (args, signal) => {
				const { owner, name } = repoOf(context, args.repo);
				const diff = await client.text(["repos", owner, name, "pulls", args.number], { accept: "application/vnd.github.diff", signal });
				const cut = truncate(diff, args.maxChars ?? 200_000);
				return { diff: cut.text, truncated: cut.truncated, totalChars: diff.length };
			},
		),
		tool(
			"get_checks",
			"CI verdict of a commit (ref) or a pull request's head: commit statuses and check runs. verdict is success only when every check was seen and passed; unknown means the list was too long to decide.",
			Type.Object(
				{ repo, ref: Type.Optional(Type.String({ minLength: 1 })), number: Type.Optional(number) },
				{ additionalProperties: false },
			),
			async (args, signal) => {
				const { owner, name } = repoOf(context, args.repo);
				if ((args.ref === undefined) === (args.number === undefined)) throw new Error("give exactly one of ref or number");
				const ref =
					args.ref ?? (await client.json<Pull>(["repos", owner, name, "pulls", args.number!], { signal })).head.sha;
				let sha = ref;
				let statusTotal = 0;
				let runTotal = 0;
				const [statuses, runs] = await Promise.all([
					collect(
						async (page) => {
							const combined = await client.json<{ sha: string; total_count: number; statuses: Status[] }>(
								["repos", owner, name, "commits", ref, "status"],
								{ query: { per_page: PER_PAGE, page }, signal },
							);
							sha = combined.sha;
							statusTotal = Math.max(statusTotal, combined.total_count);
							return combined.statuses;
						},
						{ limit: LIST_PAGES * PER_PAGE, perPage: PER_PAGE, maxPages: LIST_PAGES, key: (status) => status.id },
					),
					collect(
						async (page) => {
							const listed = await client.json<{ total_count: number; check_runs: CheckRun[] }>(
								["repos", owner, name, "commits", ref, "check-runs"],
								{ query: { per_page: PER_PAGE, page }, signal },
							);
							runTotal = Math.max(runTotal, listed.total_count);
							return listed.check_runs;
						},
						{ limit: LIST_PAGES * PER_PAGE, perPage: PER_PAGE, maxPages: LIST_PAGES, key: (run) => run.id },
					),
				]);
				const checks = [
					...statuses.items.map((status) => ({
						kind: "status" as const,
						name: status.context,
						class: classifyStatus(status.state),
						state: status.state,
						description: status.description,
						url: status.target_url,
					})),
					...runs.items.map((run) => ({
						kind: "check_run" as const,
						name: run.name,
						class: classifyCheckRun(run.status, run.conclusion),
						status: run.status,
						conclusion: run.conclusion,
						url: run.html_url,
					})),
				];
				const complete =
					!statuses.truncated && !runs.truncated && statuses.items.length >= statusTotal && runs.items.length >= runTotal;
				const classes = checks.map((entry) => entry.class);
				const order: Record<CheckClass, number> = { failure: 0, pending: 1, success: 2 };
				return {
					sha,
					verdict: verdict(classes, complete),
					complete,
					counts: {
						success: classes.filter((value) => value === "success").length,
						pending: classes.filter((value) => value === "pending").length,
						failure: classes.filter((value) => value === "failure").length,
					},
					checks: checks.toSorted((a, b) => order[a.class] - order[b.class]),
				};
			},
		),
		tool(
			"get_file",
			"Read a file (UTF-8 text, truncated to maxChars) or list a directory at a ref (default branch when omitted).",
			Type.Object(
				{
					repo,
					path: Type.String({ description: "Path inside the repository; empty for the root directory" }),
					ref: Type.Optional(Type.String({ minLength: 1 })),
					maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
				},
				{ additionalProperties: false },
			),
			async (args, signal) => {
				const { owner, name } = repoOf(context, args.repo);
				const segments = ["repos", owner, name, "contents", ...(args.path === "" ? [] : args.path.split("/"))];
				const query = { ref: args.ref };
				const content = await client.json<Content | Content[]>(segments, { query, signal });
				if (Array.isArray(content)) {
					return {
						path: args.path,
						type: "dir",
						entries: content.map((entry) => ({ name: entry.name, path: entry.path, type: entry.type, size: entry.size })),
					};
				}
				const head = { path: content.path, type: content.type, sha: content.sha, size: content.size };
				if (content.type === "symlink") return { ...head, target: content.target ?? null };
				if (content.type === "submodule") return { ...head, submodule_git_url: content.submodule_git_url ?? null };
				if (content.type !== "file") return head;
				const bytes =
					content.encoding === "base64" && content.content !== undefined
						? Buffer.from(content.content, "base64")
						: new Uint8Array(
								await (await client.request(segments, { query, accept: "application/vnd.github.raw", signal })).arrayBuffer(),
							);
				const text = decodeText(bytes);
				if (text === undefined) return { ...head, binary: true };
				const cut = truncate(text, args.maxChars ?? 100_000);
				return { ...head, content: cut.text, truncated: cut.truncated };
			},
		),
	];
}

function writeTools(context: Context): PluginTool[] {
	const { client } = context;
	const since = () => new Date(Date.now() - DEDUPE_WINDOW_MS).toISOString();
	return [
		tool(
			"comment",
			"Post a Markdown comment on an issue or pull request conversation. Idempotent: an identical comment posted on the same conversation in the last 24 hours is returned instead of posting again.",
			Type.Object({ repo, number, body: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
			async (args, signal) => {
				const { owner, name } = repoOf(context, args.repo);
				const marker = idempotencyMarker(["comment", owner.toLowerCase(), name.toLowerCase(), args.number, args.body]);
				const path = ["repos", owner, name, "issues", args.number, "comments"];
				const after = since();
				const existing = await collect(
					(page) => client.json<Comment[]>(path, { query: { since: after, per_page: PER_PAGE, page }, signal }),
					{ limit: 1, perPage: PER_PAGE, maxPages: LIST_PAGES, keep: (comment) => (comment.body ?? "").includes(marker), key: (comment) => comment.id },
				);
				const found = existing.items[0];
				if (found !== undefined) return { id: found.id, url: found.html_url, deduplicated: true };
				if (existing.truncated) throw new Error("too many recent comments to rule out a duplicate; not posting");
				const created = await client.json<Comment>(path, { method: "POST", body: { body: withMarker(args.body, marker) }, signal });
				return { id: created.id, url: created.html_url, deduplicated: false };
			},
		),
		tool(
			"create_issue",
			"Open an issue. Idempotent: an identical issue (same title, body, labels, assignees) created in the last 24 hours is returned instead of opening another.",
			Type.Object(
				{
					repo,
					title: Type.String({ minLength: 1 }),
					body: Type.Optional(Type.String()),
					labels: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
					assignees: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
				},
				{ additionalProperties: false },
			),
			async (args, signal) => {
				const { owner, name } = repoOf(context, args.repo);
				const labels = args.labels ?? [];
				const assignees = args.assignees ?? [];
				const marker = idempotencyMarker([
					"create_issue",
					owner.toLowerCase(),
					name.toLowerCase(),
					args.title,
					args.body ?? "",
					labels,
					assignees,
				]);
				const path = ["repos", owner, name, "issues"];
				const after = since();
				const existing = await collect(
					(page) =>
						client.json<Issue[]>(path, {
							query: { state: "all", sort: "created", direction: "desc", since: after, per_page: PER_PAGE, page },
							signal,
						}),
					{ limit: 1, perPage: PER_PAGE, maxPages: LIST_PAGES, keep: (issue) => (issue.body ?? "").includes(marker), key: (issue) => issue.id },
				);
				const found = existing.items[0];
				if (found !== undefined) return { number: found.number, url: found.html_url, deduplicated: true };
				if (existing.truncated) throw new Error("too many recent issues to rule out a duplicate; not creating");
				const created = await client.json<Issue>(path, {
					method: "POST",
					body: {
						title: args.title,
						body: withMarker(args.body ?? "", marker),
						...(labels.length > 0 ? { labels } : {}),
						...(assignees.length > 0 ? { assignees } : {}),
					},
					signal,
				});
				return { number: created.number, url: created.html_url, deduplicated: false };
			},
		),
	];
}

function prompt(patterns: readonly string[] | undefined, write: boolean): string {
	return [
		"GitHub tools (github_*) read issues, pull requests, diffs, files and CI checks through the GitHub REST API with the deployment's token.",
		patterns === undefined
			? "Any repository the token can access is allowed."
			: `Only these repositories are allowed: ${patterns.join(", ")}.`,
		"Results may be truncated; every list or text result reports truncated/bodyTruncated. Do not treat a truncated result as complete.",
		"github_get_checks verdict: success only when every check was seen and passed; unknown means not decidable from what was fetched.",
		write
			? "Write tools github_comment and github_create_issue are idempotent per identical request within 24 hours. Post only what the user asked for."
			: "This deployment is read-only: no GitHub write tools are available.",
	].join("\n");
}

export const githubPlugin = definePlugin({
	id: "github",
	config,
	load: ({ tokenEnv = "GITHUB_TOKEN", apiUrl = "https://api.github.com", repositories, write = false }) => {
		const token = process.env[tokenEnv];
		if (token === undefined || token.trim() === "") throw new Error(`environment variable ${tokenEnv} is not set`);
		const patterns = repositories?.map(parsePattern);
		const context: Context = { client: new GitHubClient(parseApiUrl(apiUrl), token.trim()), patterns };
		return {
			tools: [...readTools(context).map((tool) => ({ ...tool, readOnly: true })), ...(write ? writeTools(context) : [])],
			prompt: prompt(repositories, write),
		};
	},
});
