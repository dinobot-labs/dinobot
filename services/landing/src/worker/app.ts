import type { Clock, Env } from "./env.ts";
import { discardBody, fail, json, mergeVary, PAGE_CSP, plain, redirect, SECURITY_HEADERS, withHeaders } from "./http.ts";
import { negotiate } from "./locale.ts";
import { overLimit } from "./ratelimit.ts";
import { handleWaitlist, LIMITS } from "./waitlist.ts";

/**
 * www Worker. Routed here first (assets.runWorkerFirst): `/api/*` and `/`. Everything else reaches the Worker only
 * when no static asset matched, and goes back to ASSETS (which answers with the 404 page).
 */

const PAGE_DEFAULTS: Readonly<Record<string, string>> = { ...SECURITY_HEADERS, "content-security-policy": PAGE_CSP };
const VARY = ["Accept-Language", "Cookie"] as const;

const headless = (request: Request, response: Response) => request.method === "HEAD"
	? new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers })
	: response;

export async function handleFetch(request: Request, env: Env, now: Clock = Date.now): Promise<Response> {
	const url = new URL(request.url);
	if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
		let response: Response;
		try {
			response = await api(request, env, url, now);
		} catch {
			// Do not log exceptions containing request or database input.
			response = fail(500, "internal");
		}
		await discardBody(request, LIMITS.bodyBytes);
		return headless(request, response);
	}
	if (request.method !== "GET" && request.method !== "HEAD") return fail(405, "method_not_allowed", { allow: "GET, HEAD" });
	try {
		if (url.pathname === "/" && (request.method === "GET" || request.method === "HEAD")) return headless(request, await home(request, env, url));
		return headless(request, page(await env.ASSETS.fetch(request)));
	} catch {
		return headless(request, plain(500, "Internal error\n"));
	}
}

async function api(request: Request, env: Env, url: URL, now: Clock): Promise<Response> {
	if (await overLimit(env.RL_IP, request.headers.get("cf-connecting-ip"))) return fail(429, "rate_limited", { "retry-after": "60" });
	const path = url.pathname.replace(/\/+$/, "");
	if (path === "/api/waitlist") {
		return request.method === "POST" ? await handleWaitlist(request, env, now) : fail(405, "method_not_allowed", { allow: "POST" });
	}
	if (path === "/api/health") {
		return request.method === "GET" || request.method === "HEAD" ? json(200, { ok: true }) : fail(405, "method_not_allowed", { allow: "GET, HEAD" });
	}
	return fail(404, "not_found");
}

/** "/": Korean visitors are sent to /ko/, everyone else (and every crawler) gets the English page. */
async function home(request: Request, env: Env, url: URL): Promise<Response> {
	if (negotiate(request.headers) === "ko") return redirect(`/ko/${url.search}`, { vary: VARY.join(", ") });
	const response = await env.ASSETS.fetch(request);
	return page(response, { vary: mergeVary(response.headers.get("vary"), VARY) });
}

/** Pages keep the headers ASSETS gave them (public/_headers wins); missing security headers are filled in. */
const page = (response: Response, set: Record<string, string> = {}) => withHeaders(response, set, PAGE_DEFAULTS);
