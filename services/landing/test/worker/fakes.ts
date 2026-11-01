import { Database } from "bun:sqlite";
import type { AssetsLike, D1Like, D1Statement, Env, RateLimitLike } from "../../src/worker/env.ts";

/** D1 subset backed by bun:sqlite, so UNIQUE COLLATE NOCASE, AUTOINCREMENT and RETURNING behave like D1's SQLite. */
export class FakeD1 implements D1Like {
	readonly db = new Database(":memory:");
	/** Number of upcoming statements that fail, to simulate an outage. */
	failNext = 0;
	readonly statements: string[] = [];
	prepare(sql: string): D1Statement {
		const fake = this;
		let params: unknown[] = [];
		const execute = () => {
			fake.statements.push(sql);
			if (fake.failNext > 0) {
				fake.failNext--;
				throw new Error("D1_ERROR: simulated outage");
			}
			return fake.db.query(sql);
		};
		const stmt: D1Statement = {
			bind(...values: unknown[]) {
				params = values;
				return stmt;
			},
			async first<T>() {
				return (execute().get(...(params as never[])) as T | null) ?? null;
			},
			async run() {
				return execute().run(...(params as never[]));
			},
		};
		return stmt;
	}
}

/** Fixed-window counter per key, like the Rate Limiting binding within one window. */
export class FakeRateLimit implements RateLimitLike {
	readonly keys: string[] = [];
	readonly counts = new Map<string, number>();
	constructor(readonly limitPerKey: number) {}
	async limit({ key }: { key: string }) {
		this.keys.push(key);
		const n = (this.counts.get(key) ?? 0) + 1;
		this.counts.set(key, n);
		return { success: n <= this.limitPerKey };
	}
}

export const ASSET_CSP = "default-src 'self'; frame-ancestors 'none'";

/**
 * The assets binding: "/" and "/ko/" pages with the headers the asset worker adds, "/custom/" whose public/_headers
 * rule sets its own CSP and frame options, and the 404 page for everything else.
 */
export class FakeAssets implements AssetsLike {
	readonly requests: Request[] = [];
	readonly responses: Response[] = [];
	async fetch(request: Request): Promise<Response> {
		this.requests.push(request);
		const { pathname } = new URL(request.url);
		const response =
			pathname === "/"
				? html(200, "<h1>en</h1>", { vary: "Accept-Encoding" })
				: pathname === "/ko/"
					? html(200, "<h1>ko</h1>")
					: pathname === "/custom/"
						? html(200, "<h1>custom</h1>", { "content-security-policy": ASSET_CSP, "x-frame-options": "SAMEORIGIN" })
						: html(404, "<h1>404</h1>");
		this.responses.push(response);
		return response;
	}
}

const html = (status: number, body: string, headers: Record<string, string> = {}) =>
	new Response(body, {
		status,
		headers: { "content-type": "text/html", etag: '"abc"', "cache-control": "public, max-age=0, must-revalidate", ...headers },
	});

/** `ipLimit` defaults high so tests can send many requests; the rate-limit tests pass the production value (10). */
export function fakeEnv(options: { ipLimit?: number } = {}) {
	const env = { ASSETS: new FakeAssets(), DB: new FakeD1(), RL_IP: new FakeRateLimit(options.ipLimit ?? 1_000) };
	return env satisfies Env;
}
export type FakeEnv = ReturnType<typeof fakeEnv>;

export const ORIGIN = "https://www.dinobot.test";
export const NOW = Date.parse("2026-10-11T03:04:05.678Z");
export const clock = () => NOW;
export const IP = "198.51.100.7";

/** A body the page would send: consent given, honeypot empty, filled in over five seconds. */
export const validBody = (overrides: Record<string, unknown> = {}) => ({
	email: "ada@example.com",
	consent: true,
	locale: "en",
	website: "",
	elapsedMs: 5_000,
	...overrides,
});

export const req = (path: string, init: RequestInit = {}) => new Request(`${ORIGIN}${path}`, init);

/** POST /api/waitlist with a JSON value or a raw body. */
export function signupRequest(body: unknown, headers: Record<string, string> = {}, raw = false) {
	return req("/api/waitlist", {
		method: "POST",
		headers: { "content-type": "application/json", "cf-connecting-ip": IP, ...headers },
		body: raw ? (body as BodyInit) : JSON.stringify(body),
	});
}

export type WaitlistRow = { id: number; email: string; locale: string; source: string | null; consent_version: string; created_at: string };

/** Every stored row; none when the table was never created. */
export function rows(env: FakeEnv): WaitlistRow[] {
	const table = env.DB.db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'waitlist'").get();
	return table ? (env.DB.db.query("SELECT * FROM waitlist ORDER BY id").all() as WaitlistRow[]) : [];
}
