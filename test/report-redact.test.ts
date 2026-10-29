import { describe, expect, test } from "bun:test";
import { redactString, redactValue, type RedactionCounts } from "../src/report/redact.ts";

const run = (input: string) => {
	const counts: RedactionCounts = {};
	return { out: redactString(input, counts), counts };
};

describe("redactString: detects and removes", () => {
	const cases: Array<[string, string, string]> = [
		["resident id", "제 주민번호는 900101-1234567 입니다", "900101-1234567"],
		["resident id without hyphen", "rrn 9001012234567 end", "9001012234567"],
		["foreigner registration", "외국인 850315-5123456", "850315-5123456"],
		["card (luhn)", "card 4111 1111 1111 1111 exp", "4111 1111 1111 1111"],
		["card hyphen", "4242-4242-4242-4242", "4242-4242-4242-4242"],
		["mobile", "연락처 010-1234-5678", "010-1234-5678"],
		["mobile +82", "call +82 10-1234-5678 now", "10-1234-5678"],
		["landline seoul", "02-123-4567", "02-123-4567"],
		["email", "mail me: a.b+c@example.co.kr", "a.b+c@example.co.kr"],
		["ipv4", "connect 203.0.113.7:22", "203.0.113.7"],
		["aws key", "AKIA" + "IOSFODNN7EXAMPLE", "AKIA" + "IOSFODNN7EXAMPLE"],
		["github token", "ghp_" + "abcdefghijklmnopqrstuvwxyz0123456789", "ghp_" + "abcdefghijklmnopqrstuvwxyz0123456789"],
		["slack token", "xoxb-1234567890-abcdefghij", "xoxb-1234567890-abcdefghij"],
		["telegram token in an API URL (daemon log)", "GET https://api.telegram.org/bot123456789:AAHfakeTelegramTokenValue0123456789abcdef/getUpdates", "AAHfakeTelegramTokenValue"],
		["anthropic key", "sk-" + "ant-api03-AbCdEfGhIjKlMnOpQrStUv", "sk-" + "ant-api03-AbCdEfGhIjKlMnOpQrStUv"],
		["google key", "AIzaSyA-1234567890abcdefghijklmnopqrstu", "AIzaSyA-1234567890abcdefghijklmnopqrstu"],
		["jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", "eyJhbGciOiJIUzI1NiJ9"],
		["bearer header", "Authorization: Bearer abcdefghijklmnop1234567890", "abcdefghijklmnop1234567890"],
		["url credential", "postgres://admin:hunter2pass@db.internal:5432/app", "hunter2pass"],
		["env assignment", "OPENAI_API_KEY=abc123def456ghi", "abc123def456ghi"],
		["json secret", '{"password": "correct horse battery"}', "correct horse battery"],
		["yaml secret", "client_secret: s3cr3tvalue99", "s3cr3tvalue99"],
		["pem", "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----", "MIIEow"],
		["driver licence", "면허 11-22-333333-44", "11-22-333333-44"],
		["passport with label", "여권번호: M123A4567", "M123A4567"],
		["home path", "/home/roach/dinobot/src", "roach"],
		["mac home", "/Users/jane/work", "jane"],
	];
	for (const [name, input, secret] of cases) {
		test(name, () => {
			const { out } = run(input);
			expect(out).not.toContain(secret);
			expect(out).toContain(name.includes("home") ? "<user>" : "omitted]");
		});
	}
});

describe("redactString: keeps ordinary content (false-positive guard)", () => {
	const keep = [
		"version 1.2.3 released",
		"commit 9001012 and line 1234567",
		"order id 1234-5678-9012-3456", // fails Luhn
		"timestamp 2026-10-09T13:37:35Z",
		"function login(password: string) {}",
		"const token = undefined;",
		"localhost 127.0.0.1:8786",
		"/home/<user>/project",
		"price is 12,345원 and 67,890원",
		"uuid 1f45-78e2-99c1",
	];
	for (const input of keep) {
		test(input, () => {
			expect(run(input).out).toBe(input);
		});
	}
});

test("counts redactions by kind", () => {
	const { counts } = run("010-1111-2222 and 010-3333-4444, me@x.io");
	expect(counts).toEqual({ phone: 2, email: 1 });
});

test("redactValue blanks secret-named fields and scans nested strings and keys", () => {
	const counts: RedactionCounts = {};
	const out = redactValue(
		{ headers: { authorization: "anything at all", Cookie: "sid=1" }, apiKey: "zzzz", note: ["mail a@b.co"], ok: true, n: 5, empty: "" },
		counts,
	) as Record<string, unknown>;
	expect(JSON.stringify(out)).not.toContain("anything at all");
	expect(JSON.stringify(out)).not.toContain("sid=1");
	expect(JSON.stringify(out)).not.toContain("zzzz");
	expect(JSON.stringify(out)).not.toContain("a@b.co");
	expect(out.ok).toBe(true);
	expect(out.n).toBe(5);
	expect(out.empty).toBe("");
	expect(counts.credential).toBe(3);
});

test("version strings with a pre-release suffix are not addresses", () => {
	expect(run("v8 13.2.152.17-electron.0").out).toBe("v8 13.2.152.17-electron.0");
	expect(run("host 10.20.30.40 up").out).toBe("host [ip omitted] up");
});

test("redaction is idempotent", () => {
	for (const input of ["key=abcdefgh 010-1234-5678 /home/roach/x", "token: file mode 0644", "token = abcdefghijk; password: hunter22"]) {
		const once = run(input).out;
		expect(run(once).out).toBe(once);
	}
});
