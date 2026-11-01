import { describe, expect, spyOn, test } from "bun:test";
import { handleFetch } from "../../src/worker/app.ts";
import { DDL, ensureSchema } from "../../src/worker/store.ts";
import { CONSENT_VERSION, LIMITS, normalizeEmail, normalizeSource, parseSignup } from "../../src/worker/waitlist.ts";
import { clock, fakeEnv, type FakeEnv, NOW, req, rows, signupRequest, validBody } from "./fakes.ts";

const send = (env: FakeEnv, body: unknown, headers: Record<string, string> = {}) => handleFetch(signupRequest(body, headers), env, clock);
const sendRaw = (env: FakeEnv, body: BodyInit, headers: Record<string, string> = {}) => handleFetch(signupRequest(body, headers, true), env, clock);

async function expectAnswer(response: Response, status: number, body: unknown) {
	expect({ status: response.status, body: await response.json() }).toEqual({ status, body });
}

// 64-char local part + "@" + 189-char domain = 254 chars, the longest address accepted.
const LOCAL_64 = "a".repeat(64);
const DOMAIN_189 = `${"B".repeat(63)}.${"c".repeat(63)}.${"d".repeat(57)}.COM`;
const MAX_ADDRESS = `${LOCAL_64}@${DOMAIN_189}`;

const VALID_EMAILS: [string, string][] = [
	["ada@example.com", "ada@example.com"],
	["  Ada.Lovelace+waitlist@Example.CO.KR\n", "Ada.Lovelace+waitlist@example.co.kr"],
	["o'brien@example.ie", "o'brien@example.ie"],
	["a_b-c{x}|~!#$%&*/=?^`@sub-domain.example.org", "a_b-c{x}|~!#$%&*/=?^`@sub-domain.example.org"],
	["user@xn--3e0b707e.xn--3e0b707e", "user@xn--3e0b707e.xn--3e0b707e"],
	["x@a.io", "x@a.io"],
	[MAX_ADDRESS, `${LOCAL_64}@${DOMAIN_189.toLowerCase()}`],
];

const INVALID_EMAILS = [
	"",
	"   ",
	"plainaddress",
	"@example.com",
	"ada@",
	"ada@example",
	"ada@example.c",
	"ada@@example.com",
	"ada@exa@mple.com",
	"ada lovelace@example.com",
	"ada@exam ple.com",
	".ada@example.com",
	"ada.@example.com",
	"ada..lovelace@example.com",
	"ada@-example.com",
	"ada@example-.com",
	"ada@example..com",
	"ada@.example.com",
	"ada@example.com.",
	"ada@example.123",
	"ada@ex_ample.com",
	'"ada"@example.com',
	"아다@example.com",
	"ada@예시.com",
	"ada@\u212Aakao.com", // Kelvin sign: lowercases to an ASCII "k" but is not ASCII as typed
	"ada@example.com\nbcc@evil.example",
	`${"a".repeat(65)}@example.com`,
	`ada@${"a".repeat(64)}.com`,
	`${LOCAL_64}@${"B".repeat(63)}.${"c".repeat(63)}.${"d".repeat(58)}.COM`, // 255 chars
];

describe("normalizeEmail", () => {
	test("accepts plausible addresses, trims, lowercases only the domain", () => {
		expect(MAX_ADDRESS.length).toBe(LIMITS.emailChars);
		for (const [input, expected] of VALID_EMAILS) expect([input, normalizeEmail(input)]).toEqual([input, expected]);
	});

	test("rejects implausible addresses", () => {
		for (const input of INVALID_EMAILS) expect([input, normalizeEmail(input)]).toEqual([input, undefined]);
	});
});

describe("parseSignup", () => {
	test("type errors come first, then bot signals, then the address, then consent", () => {
		expect(parseSignup({ email: 1, website: "spam" })).toEqual({ kind: "invalid", error: "invalid_body" });
		expect(parseSignup({ email: "nope", website: "spam" })).toEqual({ kind: "bot" });
		expect(parseSignup({ email: "nope", elapsedMs: 10 })).toEqual({ kind: "bot" });
		expect(parseSignup({ email: "nope" })).toEqual({ kind: "invalid", error: "invalid_email" });
		expect(parseSignup({ email: "ada@example.com" })).toEqual({ kind: "invalid", error: "consent_required" });
		expect(parseSignup({ email: "ada@example.com", consent: true })).toEqual({
			kind: "signup",
			signup: { email: "ada@example.com", locale: "en", source: null },
		});
	});
});

describe("normalizeSource", () => {
	test("keeps 1-64 chars of [a-z0-9_-], drops everything else", () => {
		for (const kept of ["hn", "product_hunt-2026", "x".repeat(64)]) expect(normalizeSource(kept)).toBe(kept);
		for (const dropped of ["", "x".repeat(65), "HN", "with space", "<script>", "naver.com", "트위터", 42, null, undefined, ["hn"]]) {
			expect([dropped, normalizeSource(dropped)]).toEqual([dropped, null]);
		}
	});
});

describe("POST /api/waitlist", () => {
	test("a valid signup is stored and answered with its position", async () => {
		const env = fakeEnv();
		await expectAnswer(await send(env, validBody({ email: " Ada@Example.COM ", locale: "ko", source: "hn" })), 201, { status: "joined", position: 1 });
		await expectAnswer(await send(env, validBody({ email: "grace@example.org" })), 201, { status: "joined", position: 2 });
		expect(rows(env)).toEqual([
			{ id: 1, email: "Ada@example.com", locale: "ko", source: "hn", consent_version: CONSENT_VERSION, created_at: new Date(NOW).toISOString() },
			{ id: 2, email: "grace@example.org", locale: "en", source: null, consent_version: CONSENT_VERSION, created_at: new Date(NOW).toISOString() },
		]);
		expect(CONSENT_VERSION).toBe("waitlist-consent-v1");
	});

	test("optional fields may be omitted; locale defaults to en", async () => {
		const env = fakeEnv();
		await expectAnswer(await send(env, { email: "ada@example.com", consent: true }), 201, { status: "joined", position: 1 });
		expect(rows(env)[0]).toMatchObject({ locale: "en", source: null });
	});

	test("a duplicate in any case answers 200 already and changes nothing", async () => {
		const env = fakeEnv();
		await expectAnswer(await send(env, validBody({ email: "Ada@Example.com", locale: "en" })), 201, { status: "joined", position: 1 });
		for (const again of ["ada@example.com", "ADA@EXAMPLE.COM", "  aDa@eXaMpLe.CoM  "]) {
			await expectAnswer(await send(env, validBody({ email: again, locale: "ko", source: "again" })), 200, { status: "already" });
		}
		expect(rows(env)).toHaveLength(1);
		expect(rows(env)[0]).toMatchObject({ email: "Ada@example.com", locale: "en", source: null });
	});

	test("the position counts rows up to and including the new id, across id gaps and deletions", async () => {
		const env = fakeEnv();
		await expectAnswer(await send(env, validBody({ email: "a@example.com" })), 201, { status: "joined", position: 1 });
		// A duplicate burns an AUTOINCREMENT id in SQLite, so ids skip; positions must not.
		await expectAnswer(await send(env, validBody({ email: "A@example.com" })), 200, { status: "already" });
		await expectAnswer(await send(env, validBody({ email: "b@example.com" })), 201, { status: "joined", position: 2 });
		await expectAnswer(await send(env, validBody({ email: "c@example.com" })), 201, { status: "joined", position: 3 });
		expect(rows(env).map((row) => row.id)).toEqual([1, 3, 4]);
		env.DB.db.run("DELETE FROM waitlist WHERE email = 'a@example.com'");
		await expectAnswer(await send(env, validBody({ email: "d@example.com" })), 201, { status: "joined", position: 3 });
	});

	test("invalid emails are 400 invalid_email and store nothing", async () => {
		const env = fakeEnv();
		for (const email of INVALID_EMAILS) await expectAnswer(await send(env, validBody({ email })), 400, { error: "invalid_email" });
		expect(rows(env)).toEqual([]);
	});

	test("consent must be exactly true", async () => {
		const env = fakeEnv();
		for (const consent of [undefined, false, "true", 1, null, "yes", {}]) {
			await expectAnswer(await send(env, validBody({ consent })), 400, { error: "consent_required" });
		}
		expect(rows(env)).toEqual([]);
	});

	test("honeypot and too-fast submissions answer like a success but store nothing", async () => {
		const env = fakeEnv();
		await expectAnswer(await send(env, validBody({ email: "real@example.com" })), 201, { status: "joined", position: 1 });
		const bots = [
			validBody({ email: "bot1@example.com", website: "https://spam.example" }),
			validBody({ email: "bot2@example.com", website: " " }),
			validBody({ email: "bot3@example.com", elapsedMs: 0 }),
			validBody({ email: "bot4@example.com", elapsedMs: 1_199 }),
			validBody({ email: "bot5@example.com", elapsedMs: -5 }),
			// Bot signals win over validation, so a bot never learns which field gave it away.
			{ email: "not-an-address", consent: false, website: "x" },
			{ email: "real@example.com", consent: true, elapsedMs: 300 },
		];
		for (const body of bots) await expectAnswer(await send(env, body), 201, { status: "joined" });
		expect(rows(env).map((row) => row.email)).toEqual(["real@example.com"]);
		// The threshold is 1.2 s: exactly 1200 ms is a person.
		await expectAnswer(await send(env, validBody({ email: "quick@example.com", elapsedMs: LIMITS.minElapsedMs })), 201, { status: "joined", position: 2 });
	});

	test("malformed JSON and wrong types are 400 invalid_body", async () => {
		const env = fakeEnv();
		for (const raw of ["{", "not json", "", '{"email":', "{'email': 'a@b.co'}", new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x7d])]) {
			await expectAnswer(await sendRaw(env, raw), 400, { error: "invalid_body" });
		}
		const wrong: unknown[] = [
			[],
			null,
			"ada@example.com",
			42,
			true,
			[validBody()],
			{ consent: true },
			validBody({ email: 42 }),
			validBody({ email: null }),
			validBody({ email: ["ada@example.com"] }),
			validBody({ locale: "fr" }),
			validBody({ locale: "ko-KR" }),
			validBody({ locale: 1 }),
			validBody({ website: 1 }),
			validBody({ website: null }),
			validBody({ elapsedMs: "5000" }),
			validBody({ elapsedMs: null }),
		];
		for (const body of wrong) await expectAnswer(await send(env, body), 400, { error: "invalid_body" });
		expect(rows(env)).toEqual([]);
	});

	test("the content type must be application/json (415)", async () => {
		const env = fakeEnv();
		const body = JSON.stringify(validBody());
		for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "application/jsonp", "text/json"]) {
			await expectAnswer(await sendRaw(env, body, { "content-type": type }), 415, { error: "unsupported_media_type" });
		}
		const untyped = await handleFetch(req("/api/waitlist", { method: "POST", body: new TextEncoder().encode(body) }), env, clock);
		await expectAnswer(untyped, 415, { error: "unsupported_media_type" });
		expect(rows(env)).toEqual([]);
		await expectAnswer(await sendRaw(env, body, { "content-type": "Application/JSON; charset=UTF-8" }), 201, { status: "joined", position: 1 });
	});

	test("bodies over 4 KiB are 413 whether declared or streamed; exactly 4 KiB is accepted", async () => {
		const env = fakeEnv();
		const sized = (bytes: number, email: string) => {
			const base = JSON.stringify(validBody({ email, pad: "" }));
			return JSON.stringify(validBody({ email, pad: "x".repeat(bytes - base.length) }));
		};
		// A 1 MiB stream of whitespace: whoever reads it must stop and cancel shortly after the 4 KiB cap.
		const endless = () => {
			const seen = { pulled: 0, cancelled: false };
			const stream = new ReadableStream<Uint8Array>({
				pull(controller) {
					seen.pulled++;
					if (seen.pulled > 1_024) controller.close();
					else controller.enqueue(new TextEncoder().encode(" ".repeat(1_024)));
				},
				cancel() {
					seen.cancelled = true;
				},
			});
			return { stream, seen };
		};

		// Declared too large: refused before parsing; at most the cap is drained afterwards, then the stream is cancelled.
		const declared = endless();
		await expectAnswer(await sendRaw(env, declared.stream, { "content-length": String(1_024 * 1_024) }), 413, { error: "payload_too_large" });
		expect(declared.seen.cancelled).toBe(true);
		expect(declared.seen.pulled).toBeLessThanOrEqual(6);

		// No Content-Length (chunked): the capped reader stops and cancels the stream after the limit.
		const chunked = endless();
		await expectAnswer(await sendRaw(env, chunked.stream), 413, { error: "payload_too_large" });
		expect(chunked.seen.cancelled).toBe(true);
		expect(chunked.seen.pulled).toBeLessThanOrEqual(6);

		await expectAnswer(await sendRaw(env, sized(LIMITS.bodyBytes + 1, "over@example.com")), 413, { error: "payload_too_large" });
		const exact = sized(LIMITS.bodyBytes, "exact@example.com");
		expect(new TextEncoder().encode(exact).byteLength).toBe(LIMITS.bodyBytes);
		await expectAnswer(await sendRaw(env, exact), 201, { status: "joined", position: 1 });
	});

	test("other methods are 405 with Allow: POST", async () => {
		const env = fakeEnv();
		for (const method of ["GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
			const response = await handleFetch(req("/api/waitlist", { method }), env, clock);
			expect([method, response.status, response.headers.get("allow")]).toEqual([method, 405, "POST"]);
			if (method !== "HEAD") expect(await response.json()).toEqual({ error: "method_not_allowed" });
		}
	});

	test("source is stored only when it is 1-64 chars of [a-z0-9_-]", async () => {
		const env = fakeEnv();
		const cases: [unknown, string | null][] = [
			["newsletter_2026-10", "newsletter_2026-10"],
			["x".repeat(64), "x".repeat(64)],
			["x".repeat(65), null],
			["Twitter", null],
			["a b", null],
			["<script>", null],
			[7, null],
			[undefined, null],
		];
		for (const [index, [source]] of cases.entries()) await send(env, validBody({ email: `s${index}@example.com`, source }));
		expect(rows(env).map((row) => row.source)).toEqual(cases.map(([, stored]) => stored));
	});

	test("no IP address or user agent is stored", async () => {
		const env = fakeEnv();
		await send(env, validBody(), { "cf-connecting-ip": "203.0.113.99", "user-agent": "Mozilla/5.0 TraceAgent/9.9", "x-forwarded-for": "203.0.113.99" });
		const columns = (env.DB.db.query("PRAGMA table_info(waitlist)").all() as { name: string }[]).map((column) => column.name);
		expect(columns).toEqual(["id", "email", "locale", "source", "consent_version", "created_at"]);
		const stored = JSON.stringify(rows(env));
		expect(stored).not.toContain("203.0.113.99");
		expect(stored).not.toContain("TraceAgent");
	});

	test("schema creation is idempotent and the unique index ignores case", async () => {
		const env = fakeEnv();
		// A table made by an earlier isolate (or by hand with the same DDL) is reused as is.
		for (const sql of DDL) env.DB.db.run(sql);
		env.DB.db.run("INSERT INTO waitlist (email, locale, consent_version, created_at) VALUES ('Old@example.com', 'en', 'v0', 't')");
		await ensureSchema(env.DB);
		await ensureSchema(env.DB);
		await expectAnswer(await send(env, validBody({ email: "old@EXAMPLE.com" })), 200, { status: "already" });
		await expectAnswer(await send(env, validBody({ email: "new@example.com" })), 201, { status: "joined", position: 2 });
		const creates = env.DB.statements.filter((sql) => sql.startsWith("CREATE"));
		expect(creates).toHaveLength(DDL.length);
		expect(() => env.DB.db.run("INSERT INTO waitlist (email, locale, consent_version, created_at) VALUES ('NEW@EXAMPLE.COM', 'en', 'v', 't')")).toThrow(/UNIQUE/);
	});

	test("a database outage is a 500 that logs no address, and the schema is retried afterwards", async () => {
		const env = fakeEnv();
		const errors = spyOn(console, "error").mockImplementation(() => {});
		try {
			env.DB.failNext = 1;
			await expectAnswer(await send(env, validBody({ email: "secret.person@example.com" })), 500, { error: "internal" });
			expect(errors).not.toHaveBeenCalled();
			expect(JSON.stringify(errors.mock.calls)).not.toContain("secret.person");
		} finally {
			errors.mockRestore();
		}
		await expectAnswer(await send(env, validBody({ email: "secret.person@example.com" })), 201, { status: "joined", position: 1 });
	});
});
