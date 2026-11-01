/** The subset of Cloudflare bindings this Worker uses; real bindings satisfy these structurally. */

export interface D1Statement {
	bind(...values: unknown[]): D1Statement;
	first<T = Record<string, unknown>>(): Promise<T | null>;
	run(): Promise<unknown>;
}
export interface D1Like {
	prepare(sql: string): D1Statement;
}

export interface RateLimitLike {
	limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** The static assets binding (`env.ASSETS`), which applies html_handling, not_found_handling and public/_headers. */
export interface AssetsLike {
	fetch(request: Request): Promise<Response>;
}

export interface Env {
	ASSETS: AssetsLike;
	DB: D1Like;
	RL_IP: RateLimitLike;
}

/** Milliseconds since the epoch; injectable so tests control `created_at`. */
export type Clock = () => number;
