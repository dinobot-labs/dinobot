import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import type { PluginTool } from "../types.ts";
import { AuthorizationRequired, type GoogleAuth } from "./auth.ts";

/** Authorized calls to Google REST APIs: token on every request, one forced refresh on 401, a login link when that fails. */

export class GoogleApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(`Google ${status}: ${message}`);
		this.name = "GoogleApiError";
	}
}

type Query = Record<string, string | number | boolean | readonly string[] | undefined>;
export type RequestOptions = { query?: Query; body?: unknown; signal?: AbortSignal | undefined };
export type RawOptions = { query?: Query; method?: "GET" | "POST"; rawBody?: string; contentType?: string; signal?: AbortSignal | undefined };

export type Api = {
	json<T>(method: string, url: string, options?: RequestOptions): Promise<T>;
	/** Raw response (downloads, exports, multipart uploads); non-2xx statuses are thrown like json(). */
	raw(url: string, options?: RawOptions): Promise<Response>;
};

/** Path segment from a caller value: encoded, never a dot segment. */
export function segment(value: string): string {
	if (value === "" || value === "." || value === "..") throw new Error(`invalid id ${JSON.stringify(value)}`);
	return encodeURIComponent(value);
}

function withQuery(url: string, query: Query | undefined): string {
	if (!query) return url;
	const target = new URL(url);
	for (const [name, value] of Object.entries(query)) {
		if (value === undefined) continue;
		if (Array.isArray(value)) for (const item of value) target.searchParams.append(name, item);
		else target.searchParams.set(name, String(value));
	}
	return target.toString();
}

async function errorMessage(response: Response): Promise<{ message: string; insufficientScope: boolean }> {
	const text = await response.text().catch(() => "");
	try {
		const parsed = JSON.parse(text) as { error?: { message?: string; status?: string; details?: { reason?: string }[]; errors?: { reason?: string }[] } | string; error_description?: string };
		const error = parsed.error;
		if (typeof error === "string") return { message: parsed.error_description ?? error, insufficientScope: false };
		const reasons = [...(error?.details ?? []), ...(error?.errors ?? [])].map((entry) => entry.reason);
		const insufficientScope = reasons.includes("ACCESS_TOKEN_SCOPE_INSUFFICIENT") || reasons.includes("insufficientPermissions");
		return { message: error?.message ?? text.slice(0, 500), insufficientScope };
	} catch {
		return { message: text.slice(0, 500) || response.statusText, insufficientScope: false };
	}
}

export function createApi(auth: GoogleAuth, fetchImpl: typeof fetch = fetch): Api {
	const login = async () => new AuthorizationRequired((await auth.startLogin()).url);

	async function send(method: string, url: string, options: RequestOptions & { rawBody?: string; contentType?: string }): Promise<Response> {
		if ((await auth.missingScopes()).length > 0) throw await login();
		const target = withQuery(url, options.query);
		const attempt = (token: string) =>
			fetchImpl(target, {
				method,
				headers: {
					authorization: `Bearer ${token}`,
					accept: "application/json",
					...(options.body !== undefined ? { "content-type": "application/json" } : {}),
					...(options.contentType !== undefined ? { "content-type": options.contentType } : {}),
				},
				...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
				...(options.rawBody !== undefined ? { body: options.rawBody } : {}),
				...(options.signal ? { signal: options.signal } : {}),
				redirect: "error",
			});
		let token = await auth.token();
		if (token === undefined) throw await login();
		let response = await attempt(token);
		if (response.status === 401) {
			await response.body?.cancel();
			token = await auth.token({ forceRefresh: true });
			if (token === undefined) throw await login();
			response = await attempt(token);
			if (response.status === 401) {
				await response.body?.cancel();
				throw await login();
			}
		}
		if (!response.ok) {
			const { message, insufficientScope } = await errorMessage(response);
			if (response.status === 403 && insufficientScope) throw await login();
			throw new GoogleApiError(response.status, message);
		}
		return response;
	}

	return {
		async json<T>(method: string, url: string, options: RequestOptions = {}): Promise<T> {
			const response = await send(method, url, options);
			if (response.status === 204) return undefined as T;
			const text = await response.text();
			return (text === "" ? undefined : JSON.parse(text)) as T;
		},
		raw: (url, { method = "GET", ...options } = {}) => send(method, url, options),
	};
}

export function check<T extends TSchema>(schema: T, args: unknown): Static<T> {
	if (Value.Check(schema, args)) return args;
	const problems = [...Value.Errors(schema, args)].map((error) => `${error.instancePath || "/"}: ${error.message}`);
	throw new Error(`invalid arguments: ${problems.join("; ")}`);
}

export function tool<T extends TSchema>(
	name: string,
	description: string,
	schema: T,
	readOnly: boolean,
	run: (args: Static<T>, signal: AbortSignal | undefined) => Promise<unknown>,
): PluginTool {
	return {
		name,
		description,
		inputSchema: schema as unknown as PluginTool["inputSchema"],
		...(readOnly ? { readOnly: true } : {}),
		execute: async (args, { signal }) => await run(check(schema, args), signal),
	};
}

/** Text capped at `max` characters; the flag says the caller saw only part of it. */
export function clip(text: string, max: number): { text: string; truncated?: true; totalChars?: number } {
	return text.length <= max ? { text } : { text: text.slice(0, max), truncated: true, totalChars: text.length };
}
