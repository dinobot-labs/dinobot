import { describe, expect, test } from "bun:test";
import { handleFetch } from "../../src/worker/app.ts";
import worker from "../../src/worker/index.ts";
import type { Env } from "../../src/worker/env.ts";
import { API_CSP, PAGE_CSP, SECURITY_HEADERS } from "../../src/worker/http.ts";

function isolated() {
	const calls = { db: 0, limiter: 0, assets: 0 };
	const env: Env = {
		get DB(): never { calls.db++; throw new Error("DB forbidden"); },
		get RL_IP(): never { calls.limiter++; throw new Error("limiter forbidden"); },
		ASSETS: { async fetch(request) { calls.assets++; return new Response(request.method === "HEAD" ? null : "asset", { headers: { etag: '"asset-v1"', "cache-control": "public, max-age=60" } }); } },
	};
	return { env, calls };
}
const req = (path: string, init: RequestInit = {}) => new Request("https://landing.test" + path, init);
function security(response: Response, csp = API_CSP) {
	for (const [key, value] of Object.entries(SECURITY_HEADERS)) expect(response.headers.get(key)).toBe(value);
	expect(response.headers.get("content-security-policy")).toBe(csp);
}

describe("retired API", () => {
	test("all methods and trailing slashes return constant 410 without bindings", async () => {
		const { env, calls } = isolated();
		for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "PROPFIND"]) {
			for (const path of ["/api/waitlist", "/api/waitlist/", "/api/waitlist///?email=private%40example.com"]) {
				const response = await worker.fetch(req(path, { method }), env);
				expect(response.status).toBe(410);
				expect(await response.text()).toBe(method === "HEAD" ? "" : '{"error":"gone"}');
				security(response);
				expect(response.headers.get("cache-control")).toBe("no-store");
				expect(response.headers.get("access-control-allow-origin")).toBeNull();
			}
		}
		expect(calls).toEqual({ db: 0, limiter: 0, assets: 0 });
	});
	test("malformed, large, binary, origin and content type inputs do not change result or consume body", async () => {
		const { env, calls } = isolated();
		for (const body of ["{", "x".repeat(2 * 1024 * 1024), new Uint8Array([255, 0, 254])]) {
			for (const type of ["application/json", "text/plain", "multipart/form-data", "APPLICATION/JSON"]) {
				const request = req("/api/waitlist?secret=do-not-reflect", { method: "POST", body, headers: { origin: "https://evil.test", "content-type": type, "content-length": "999999999" } });
				const response = await handleFetch(request, env);
				expect(response.status).toBe(410);
				expect(await response.text()).toBe('{"error":"gone"}');
				expect(request.bodyUsed).toBe(false);
			}
		}
		expect(calls).toEqual({ db: 0, limiter: 0, assets: 0 });
	});
	test("throwing stream is never pulled for retired, unknown, or method responses", async () => {
		const { env, calls } = isolated();
		for (const [path, status] of [["/api/waitlist", 410], ["/api/unknown", 404], ["/api/health", 405], ["/unknown", 405]] as const) {
			let reads = 0;
			const body = new ReadableStream<Uint8Array>({ pull() { reads++; throw new Error("body read forbidden"); } }, { highWaterMark: 0 });
			const request = req(path, { method: "POST", body });
			const response = await handleFetch(request, env);
			expect(response.status).toBe(status);
			expect(reads).toBe(0);
			expect(request.bodyUsed).toBe(false);
		}
		expect(calls).toEqual({ db: 0, limiter: 0, assets: 0 });
	});
});

test("health and unknown API paths have bounded responses without bindings", async () => {
	const { env, calls } = isolated();
	for (const method of ["GET", "HEAD", "POST", "OPTIONS"]) {
		const response = await handleFetch(req("/api/health/?arbitrary=value", { method }), env);
		expect(response.status).toBe(["GET", "HEAD"].includes(method) ? 200 : 405);
		expect(await response.text()).toBe(method === "HEAD" ? "" : method === "GET" ? '{"ok":true}' : '{"error":"method_not_allowed"}');
		if (response.status === 405) expect(response.headers.get("allow")).toBe("GET, HEAD");
		security(response);
		for (const path of ["/api", "/api/", "/api/Waitlist", "/api/WAITLIST", "/api/waitlist/x", "/api/%77aitlist", "/api/unknown?private=yes"]) {
			const unknown = await handleFetch(req(path, { method }), env);
			expect(unknown.status).toBe(404);
			expect(await unknown.text()).toBe(method === "HEAD" ? "" : '{"error":"not_found"}');
			security(unknown);
		}
	}
	expect(calls).toEqual({ db: 0, limiter: 0, assets: 0 });
});

test("only page GET/HEAD pass through assets, preserving validators and no server locale redirect", async () => {
	const { env, calls } = isolated();
	for (const path of ["/", "/ko/", "/privacy/", "/assets/image.png", "/unknown?random=one"]) {
		for (const method of ["GET", "HEAD"]) {
			const response = await handleFetch(req(path, { method, headers: { "accept-language": "ko", cookie: "lang=ko" } }), env);
			expect(response.status).toBe(200);
			expect(response.headers.get("location")).toBeNull();
			expect(response.headers.get("vary")).toBeNull();
			expect(response.headers.get("etag")).toBe('"asset-v1"');
			expect(response.headers.get("cache-control")).toBe("public, max-age=60");
			expect(await response.text()).toBe(method === "HEAD" ? "" : "asset");
			security(response, PAGE_CSP);
		}
		for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) expect((await handleFetch(req(path, { method }), env)).status).toBe(405);
	}
	expect(calls).toEqual({ db: 0, limiter: 0, assets: 10 });
});

test("asset failure is constant, strict and bodyless for HEAD", async () => {
	const { env } = isolated();
	env.ASSETS.fetch = async () => { throw new Error("private query MUST NOT leak"); };
	for (const method of ["GET", "HEAD"]) {
		const response = await handleFetch(req("/?secret=private", { method }), env);
		expect(response.status).toBe(500);
		expect(await response.text()).toBe(method === "HEAD" ? "" : '{"error":"internal"}');
		security(response);
	}
});
