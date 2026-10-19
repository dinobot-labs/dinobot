/**
 * Minimal GitHub REST client.
 *
 * Invariants (see openwiki/architecture/github.md):
 * - Every request URL is `apiUrl` + `/` + encoded segments. Caller values enter only as
 *   percent-encoded path segments (dot segments rejected) or URLSearchParams values, so URL
 *   normalization cannot move the request to another path or origin.
 * - Redirects are never followed. The token is sent to exactly one origin, and a renamed or
 *   transferred repository cannot slip past the repository allowlist through a redirect.
 */

const API_VERSION = "2022-11-28";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export type Query = Readonly<Record<string, string | number | boolean | undefined>>;

export type RequestOptions = {
	readonly method?: "GET" | "POST";
	readonly query?: Query;
	readonly body?: unknown;
	readonly accept?: string;
	readonly signal?: AbortSignal | undefined;
};

export class GitHubError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = "GitHubError";
	}
}

/** https anywhere; plain http only for loopback (local GitHub fakes), so a token never travels in clear text. */
export function parseApiUrl(value: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`apiUrl is not a URL: ${JSON.stringify(value)}`);
	}
	if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
		throw new Error("apiUrl must use https (http is allowed only for loopback hosts)");
	}
	if (url.username || url.password || url.search || url.hash) throw new Error("apiUrl must not contain credentials, query or fragment");
	return url;
}

export function segment(value: string | number): string {
	const text = String(value);
	if (text === "" || text === "." || text === "..") throw new Error(`invalid path segment ${JSON.stringify(text)}`);
	return encodeURIComponent(text);
}

export class GitHubClient {
	readonly #origin: string;
	/** apiUrl path without trailing slashes: "" for https://api.github.com, "/api/v3" for GHES. */
	readonly #path: string;
	readonly #token: string;

	constructor(apiUrl: URL, token: string) {
		this.#origin = apiUrl.origin;
		this.#path = apiUrl.pathname.replace(/\/+$/, "");
		this.#token = token;
	}

	url(segments: readonly (string | number)[], query: Query = {}): URL {
		const url = new URL(this.#origin);
		url.pathname = `${this.#path}/${segments.map(segment).join("/")}`;
		for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));
		return url;
	}

	async request(segments: readonly (string | number)[], options: RequestOptions = {}): Promise<Response> {
		const method = options.method ?? "GET";
		const url = this.url(segments, options.query);
		const headers: Record<string, string> = {
			Accept: options.accept ?? "application/vnd.github+json",
			Authorization: `Bearer ${this.#token}`,
			"User-Agent": "dinobot",
			"X-GitHub-Api-Version": API_VERSION,
		};
		if (options.body !== undefined) headers["Content-Type"] = "application/json";
		const response = await fetch(url, {
			method,
			headers,
			redirect: "manual",
			...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
			...(options.signal !== undefined ? { signal: options.signal } : {}),
		});
		if (response.ok) return response;
		throw await errorFor(method, url, response);
	}

	async json<T>(segments: readonly (string | number)[], options: RequestOptions = {}): Promise<T> {
		return (await (await this.request(segments, options)).json()) as T;
	}

	async text(segments: readonly (string | number)[], options: RequestOptions = {}): Promise<string> {
		return await (await this.request(segments, options)).text();
	}
}

async function errorFor(method: string, url: URL, response: Response): Promise<GitHubError> {
	const where = `${method} ${url.pathname}`;
	if (response.status >= 300 && response.status < 400) {
		const location = response.headers.get("location") ?? "unknown location";
		return new GitHubError(
			`GitHub ${response.status} ${where}: moved to ${location}. Redirects are not followed; look up the repository's current owner/name and call again.`,
			response.status,
		);
	}
	let detail = response.statusText;
	try {
		const body = (await response.json()) as { message?: unknown; errors?: unknown };
		if (typeof body.message === "string") detail = body.message;
		if (body.errors !== undefined) detail += ` ${JSON.stringify(body.errors)}`;
	} catch {
		// Non-JSON error body; the status text is all we report.
	}
	const reset = response.headers.get("x-ratelimit-reset");
	if ((response.status === 403 || response.status === 429) && response.headers.get("x-ratelimit-remaining") === "0" && reset !== null) {
		detail += ` (rate limit exhausted; resets at ${new Date(Number(reset) * 1000).toISOString()})`;
	}
	const retryAfter = response.headers.get("retry-after");
	if (retryAfter !== null) detail += ` (retry after ${retryAfter}s)`;
	return new GitHubError(`GitHub ${response.status} ${where}: ${detail}`, response.status);
}
