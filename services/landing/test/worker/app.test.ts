import { describe, expect, spyOn, test } from "bun:test";
import { handleFetch } from "../../src/worker/app.ts";
import { API_CSP, PAGE_CSP, SECURITY_HEADERS } from "../../src/worker/http.ts";
import worker from "../../src/worker/index.ts";
import { rateKey } from "../../src/worker/ratelimit.ts";
import { ASSET_CSP, clock, fakeEnv, type FakeEnv, IP, req, rows, signupRequest, validBody } from "./fakes.ts";

const get = (env: FakeEnv, path: string, init: RequestInit = {}) => handleFetch(req(path, init), env, clock);
const join = (env: FakeEnv, email: string, headers: Record<string, string> = {}) => handleFetch(signupRequest(validBody({ email }), headers), env, clock);

function expectSecurityHeaders(response: Response, csp: string) {
	const actual = Object.fromEntries(Object.keys(SECURITY_HEADERS).map((name) => [name, response.headers.get(name)]));
	expect(actual).toEqual({ ...SECURITY_HEADERS });
	expect(response.headers.get("content-security-policy")).toBe(csp);
}

describe("routing", () => {
	test("GET /api/health answers {ok:true}; HEAD works; other methods are 405", async () => {
		const env = fakeEnv();
		const health = await get(env, "/api/health");
		expect(health.status).toBe(200);
		expect(health.headers.get("content-type")).toBe("application/json; charset=utf-8");
		expect(await health.json()).toEqual({ ok: true });
		expect((await get(env, "/api/health", { method: "HEAD" })).status).toBe(200);
		for (const method of ["POST", "PUT", "DELETE"]) {
			const response = await get(env, "/api/health", { method });
			expect([method, response.status, response.headers.get("allow"), await response.json()]).toEqual([method, 405, "GET, HEAD", { error: "method_not_allowed" }]);
		}
		// Health touches no binding but the rate limiter.
		expect(env.DB.statements).toEqual([]);
	});

	test("unknown /api routes are JSON 404s, never the HTML 404 page", async () => {
		const env = fakeEnv();
		for (const [method, path] of [
			["GET", "/api"],
			["GET", "/api/"],
			["GET", "/api/nope"],
			["POST", "/api/nope"],
			["POST", "/api/waitlist/extra"],
			["GET", "/api/health/x"],
			["POST", "/api/Waitlist"],
		] as const) {
			const response = await get(env, path, { method });
			expect([method, path, response.status, response.headers.get("content-type"), await response.json()]).toEqual([
				method,
				path,
				404,
				"application/json; charset=utf-8",
				{ error: "not_found" },
			]);
		}
		expect(env.ASSETS.requests).toHaveLength(0);
	});

	test("a trailing slash on an API route is tolerated", async () => {
		const env = fakeEnv();
		const response = await handleFetch(req("/api/waitlist/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(validBody()) }), env, clock);
		expect(response.status).toBe(201);
		expect((await get(env, "/api/health/")).status).toBe(200);
	});

	test("answers given before the body was read still drain it to the end, so the connection stays reusable", async () => {
		// Two 100-byte chunks, then the end; `drained` means the reader reached the end rather than cancelling.
		const small = () => {
			const seen = { drained: false, cancelled: false };
			let sent = 0;
			const body = new ReadableStream<Uint8Array>({
				pull(controller) {
					if (sent++ < 2) return controller.enqueue(new TextEncoder().encode(" ".repeat(100)));
					seen.drained = true;
					controller.close();
				},
				cancel() {
					seen.cancelled = true;
				},
			});
			return { body, seen };
		};
		const env = fakeEnv();
		const blocked = fakeEnv({ ipLimit: 0 });
		const cases: [number, FakeEnv, string, RequestInit][] = [
			[415, env, "/api/waitlist", { method: "POST", headers: { "content-type": "text/plain" } }],
			[429, blocked, "/api/waitlist", { method: "POST", headers: { "content-type": "application/json" } }],
			[404, env, "/api/nope", { method: "POST" }],
			[405, env, "/api/waitlist", { method: "PUT" }],
			[405, env, "/api/health", { method: "POST" }],
		];
		for (const [status, target, path, init] of cases) {
			const { body, seen } = small();
			const response = await handleFetch(req(path, { ...init, body }), target, clock);
			expect([path, response.status, seen]).toEqual([path, status, { drained: true, cancelled: false }]);
		}
	});

	test("the Worker entrypoint delegates to handleFetch", async () => {
		const env = fakeEnv();
		const response = await worker.fetch(req("/api/health"), env);
		expect(await response.json()).toEqual({ ok: true });
		expect((await worker.fetch(req("/ko/"), env)).status).toBe(200);
	});
});

describe("rate limiting", () => {
	test("10 requests per IP on /api/*, then 429 rate_limited; other IPs and pages are unaffected", async () => {
		const env = fakeEnv({ ipLimit: 10 });
		for (let i = 0; i < 10; i++) expect((await join(env, `p${i}@example.com`)).status).toBe(201);
		const limited = await join(env, "p10@example.com");
		expect(limited.status).toBe(429);
		expect(await limited.json()).toEqual({ error: "rate_limited" });
		expect(limited.headers.get("retry-after")).toBe("60");
		expect(rows(env)).toHaveLength(10);
		// Every /api route counts, including health and unknown routes.
		expect((await get(env, "/api/health", { headers: { "cf-connecting-ip": IP } })).status).toBe(429);
		expect((await get(env, "/api/nope", { headers: { "cf-connecting-ip": IP } })).status).toBe(429);
		expect((await join(env, "other@example.com", { "cf-connecting-ip": "198.51.100.8" })).status).toBe(201);
		expect((await get(env, "/", { headers: { "cf-connecting-ip": IP } })).status).toBe(200);
		expect(new Set(env.RL_IP.keys)).toEqual(new Set([IP, "198.51.100.8"]));
	});

	test("IPv6 clients share one budget per /64", async () => {
		const env = fakeEnv({ ipLimit: 2 });
		const health = (ip: string) => get(env, "/api/health", { headers: { "cf-connecting-ip": ip } });
		expect((await health("2001:db8:1:2::a")).status).toBe(200);
		expect((await health("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).status).toBe(200);
		expect((await health("2001:0DB8:0001:0002:ffff::")).status).toBe(429);
		expect((await health("2001:db8:1:3::1")).status).toBe(200);
	});

	test("rate-limit keys", () => {
		const cases: [string | null, string][] = [
			[null, "unknown"],
			["", "unknown"],
			["198.51.100.7", "198.51.100.7"],
			["2001:db8:1:2:3:4:5:6", "2001:db8:1:2::/64"],
			["2001:DB8:0001:0002::1", "2001:db8:1:2::/64"],
			["2001:db8::1", "2001:db8:0:0::/64"],
			["::1", "0:0:0:0::/64"],
			["::", "0:0:0:0::/64"],
			["::ffff:192.0.2.1", "192.0.2.1"],
			["fe80::1%eth0", "fe80::1%eth0"],
			["1:2:3::4::5", "1:2:3::4::5"],
			["not:an:address", "not:an:address"],
		];
		for (const [ip, key] of cases) expect([ip, rateKey(ip)]).toEqual([ip, key]);
	});

	test("an unavailable rate limiter fails open", async () => {
		const env = fakeEnv();
		env.RL_IP.limit = async () => {
			throw new Error("binding unavailable");
		};
		const errors = spyOn(console, "error").mockImplementation(() => {});
		try {
			expect((await join(env, "ada@example.com")).status).toBe(201);
			expect(errors).toHaveBeenCalled();
		} finally {
			errors.mockRestore();
		}
	});
});

describe("security headers", () => {
	test("every response the Worker generates carries them, with a deny-all CSP and no caching", async () => {
		const env = fakeEnv();
		const blocked = fakeEnv({ ipLimit: 0 });
		const responses: [string, Response][] = [
			["health", await get(env, "/api/health")],
			["joined", await join(env, "ada@example.com")],
			["already", await join(env, "ADA@example.com")],
			["bot", await handleFetch(signupRequest(validBody({ website: "x" })), env, clock)],
			["400", await handleFetch(signupRequest("{", {}, true), env, clock)],
			["404", await get(env, "/api/nope")],
			["405", await get(env, "/api/waitlist")],
			["413", await handleFetch(signupRequest("x", { "content-length": "4097" }, true), env, clock)],
			["415", await handleFetch(signupRequest("{}", { "content-type": "text/plain" }, true), env, clock)],
			["429", await get(blocked, "/api/health")],
			["302", await get(env, "/", { headers: { "accept-language": "ko" } })],
		];
		expect(responses.map(([name, response]) => `${name}:${response.status}`)).toEqual([
			"health:200",
			"joined:201",
			"already:200",
			"bot:201",
			"400:400",
			"404:404",
			"405:405",
			"413:413",
			"415:415",
			"429:429",
			"302:302",
		]);
		for (const [, response] of responses) {
			expectSecurityHeaders(response, API_CSP);
			expect(response.headers.get("cache-control")).toBe("no-store");
		}
	});

	test("pages passed through from ASSETS get missing security headers and keep their own", async () => {
		const env = fakeEnv();
		for (const path of ["/", "/ko/", "/nope"]) expectSecurityHeaders(await get(env, path), PAGE_CSP);
		expect((await get(env, "/nope")).status).toBe(404);

		const custom = await get(env, "/custom/");
		expect(custom.headers.get("content-security-policy")).toBe(ASSET_CSP);
		expect(custom.headers.get("x-frame-options")).toBe("SAMEORIGIN");
		expect(custom.headers.get("x-content-type-options")).toBe("nosniff");
		expect(custom.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");

		// Fetched responses have immutable headers in workerd, so the Worker must copy rather than mutate.
		for (const original of env.ASSETS.responses) {
			expect(original.headers.get("x-content-type-options")).toBeNull();
			expect(original.headers.get("permissions-policy")).toBeNull();
		}
	});

	test("the page CSP is same-origin, has no inline scripts and forbids framing", () => {
		const directives = Object.fromEntries(PAGE_CSP.split(";").map((d) => d.trim().split(/\s+/)).map(([name, ...values]) => [name, values]));
		expect(directives["default-src"]).toEqual(["'self'"]);
		expect(directives["script-src"]).toEqual(["'self'"]);
		expect(directives["style-src"]).toEqual(["'self'"]);
		expect(directives["frame-ancestors"]).toEqual(["'none'"]);
		expect(directives["object-src"]).toEqual(["'none'"]);
		expect(PAGE_CSP).not.toMatch(/https?:|unsafe-eval|\*/);
		expect(API_CSP).toContain("default-src 'none'");
		expect(API_CSP).toContain("frame-ancestors 'none'");
		expect(SECURITY_HEADERS["permissions-policy"]).toContain("camera=()");
	});

	test("an ASSETS failure is a plain 500 that still carries the headers", async () => {
		const env = fakeEnv();
		env.ASSETS.fetch = async () => {
			throw new Error("assets unavailable");
		};
		const errors = spyOn(console, "error").mockImplementation(() => {});
		try {
			for (const path of ["/", "/ko/"]) {
				const response = await get(env, path);
				expect([path, response.status, await response.text()]).toEqual([path, 500, "Internal error\n"]);
				expectSecurityHeaders(response, API_CSP);
			}
		} finally {
			errors.mockRestore();
		}
	});
});
