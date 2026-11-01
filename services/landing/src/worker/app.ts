import type { Env } from "./env.ts";
import { fail, json, PAGE_CSP, SECURITY_HEADERS, withHeaders } from "./http.ts";

const PAGE_DEFAULTS = { ...SECURITY_HEADERS, "content-security-policy": PAGE_CSP };
const readMethod = (method: string) => method === "GET" || method === "HEAD";

/** Static assets run first. Only API overrides and asset misses reach this handler.
 * No request body, DB, limiter, external fetch, or request-derived logging is used. */
export async function handleFetch(request: Request, env: Env): Promise<Response> {
	let response: Response;
	try {
		const path = new URL(request.url).pathname;
		if (path === "/api" || path.startsWith("/api/")) {
			const route = path.replace(/\/+$/, "");
			if (route === "/api/waitlist") response = fail(410, "gone");
			else if (route === "/api/health") response = readMethod(request.method)
				? json(200, { ok: true }) : fail(405, "method_not_allowed", { allow: "GET, HEAD" });
			else response = fail(404, "not_found");
		} else if (!readMethod(request.method)) {
			response = fail(405, "method_not_allowed", { allow: "GET, HEAD" });
		} else {
			response = withHeaders(await env.ASSETS.fetch(request), {}, PAGE_DEFAULTS);
		}
	} catch {
		// Never log an exception that might contain attacker-controlled URL or input.
		response = fail(500, "internal");
	}
	return request.method === "HEAD"
		? new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers })
		: response;
}
