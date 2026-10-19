/**
 * Secret and personal-data redaction shared by the report client and the ingest Worker.
 * Regex detection is best effort: it reduces, never proves absence of, sensitive data.
 * Replacement markers never contain any part of the original value.
 */

export type RedactionKind =
	| "private-key"
	| "credential"
	| "url-credential"
	| "resident-id"
	| "card"
	| "phone"
	| "email"
	| "ip"
	| "home-path"
	| "license";

export type RedactionCounts = Partial<Record<RedactionKind, number>>;

type Rule = {
	kind: RedactionKind;
	pattern: RegExp;
	/** Return the replacement for a match, or undefined to keep it (failed validation). */
	replace: (match: RegExpExecArray) => string | undefined;
};

const marker = (kind: RedactionKind): string => `[${kind} omitted]`;

/** RRN / foreigner registration number: YYMMDD-GXXXXXX with a plausible date and gender digit. */
function plausibleResidentId(digits: string): boolean {
	const month = Number(digits.slice(2, 4));
	const day = Number(digits.slice(4, 6));
	const gender = Number(digits[6]);
	return month >= 1 && month <= 12 && day >= 1 && day <= 31 && gender >= 1 && gender <= 8;
}

function luhn(digits: string): boolean {
	let sum = 0;
	for (let i = 0; i < digits.length; i++) {
		let d = Number(digits[digits.length - 1 - i]);
		if (i % 2 === 1) {
			d *= 2;
			if (d > 9) d -= 9;
		}
		sum += d;
	}
	return sum % 10 === 0;
}

function plausibleIpv4(text: string): boolean {
	const parts = text.split(".").map(Number);
	if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p > 255)) return false;
	return text !== "127.0.0.1" && text !== "0.0.0.0" && text !== "255.255.255.255";
}

const SECRET_KEY = "(?:api[_-]?key|apikey|secret(?:[_-]?key)?|client[_-]?secret|password|passwd|pwd|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|authorization|cookie|private[_-]?key)";

/** Order matters: structured secrets first so generic rules do not split them. */
const RULES: readonly Rule[] = [
	{
		kind: "private-key",
		pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
		replace: () => marker("private-key"),
	},
	{
		kind: "url-credential",
		pattern: /\b([a-z][a-z0-9+.-]{1,20}:\/\/)[^\s:/@'"]+:[^\s@/'"]+@/gi,
		replace: (m) => `${m[1]}${marker("url-credential")}@`,
	},
	{
		kind: "credential",
		pattern: new RegExp(
			[
				"\\beyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}", // JWT
				"\\b(?:AKIA|ASIA)[0-9A-Z]{16}\\b", // AWS access key id
				"\\bxox[abposr]-[A-Za-z0-9-]{10,}", // Slack
				"\\bxapp-[A-Za-z0-9-]{10,}",
				"\\bgh[pousr]_[A-Za-z0-9]{20,}", // GitHub
				"\\bgithub_pat_[A-Za-z0-9_]{20,}",
				"\\bglpat-[A-Za-z0-9_-]{20,}", // GitLab
				"\\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}", // OpenAI / Anthropic style
				"\\bAIza[0-9A-Za-z_-]{35}", // Google API key
				"\\bnpm_[A-Za-z0-9]{36}", // npm
				"\\b\\d{8,10}:AA[A-Za-z0-9_-]{30,}", // Telegram bot token
				"\\b(?:Bearer|Basic)\\s+[A-Za-z0-9._~+/-]{16,}=*", // Authorization header values
			].join("|"),
			"g",
		),
		replace: () => marker("credential"),
	},
	{
		kind: "credential",
		// key = value / key: value / "key": "value" (value must look like a literal, not a type name)
		pattern: new RegExp(`(["']?(?<![A-Za-z0-9])(?:[A-Za-z0-9]+[_-])*${SECRET_KEY}(?![A-Za-z0-9])["']?\\s*[:=]\\s*)(?!\\s*(?:str|string|int|number|bool|boolean|null|None|undefined|true|false)\\b)("(?:[^"\\\\\\n]|\\\\.){4,}"|'(?:[^'\\\\\\n]|\\\\.){4,}'|[^\\s,;)\\]}'"]{4,})`, "gi"),
		replace: (m) => `${m[1]}${marker("credential")}`,
	},
	{
		kind: "resident-id",
		pattern: /(?<![\d-])(\d{6})[- ]?([1-8]\d{6})(?![\d-])/g,
		replace: (m) => (plausibleResidentId(`${m[1]}${m[2]}`) ? marker("resident-id") : undefined),
	},
	{
		kind: "license",
		// Korean driver licence 11-22-333333-44 and passport numbers next to an explicit label.
		pattern: /(?<!\d)\d{2}-\d{2}-\d{6}-\d{2}(?!\d)|((?:여권|passport)(?:\s*(?:번호|no\.?|number))?\s*[:：]?\s*)[A-Z]\d{3}[A-Z]?\d{4,5}\b/gi,
		replace: (m) => (m[1] ? `${m[1]}${marker("license")}` : marker("license")),
	},
	{
		kind: "card",
		pattern: /(?<![\d-])[3-6]\d{3}(?:[ -]?\d{2,4}){2,4}(?![\d-])/g,
		replace: (m) => {
			const digits = m[0].replace(/\D/g, "");
			return digits.length >= 13 && digits.length <= 19 && luhn(digits) ? marker("card") : undefined;
		},
	},
	{
		kind: "phone",
		pattern: /(?<![\d+])(?:\+82[- ]?1[016789]|01[016789])[- .]?\d{3,4}[- .]?\d{4}(?!\d)|(?<![\d+])(?:\+82[- ]?|0)(?:2|[3-6][1-5])[- .)]\d{3,4}[- .]\d{4}(?!\d)/g,
		replace: () => marker("phone"),
	},
	{
		kind: "email",
		pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
		replace: () => marker("email"),
	},
	{
		kind: "ip",
		pattern: /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g,
		replace: (m) => (plausibleIpv4(m[0]) ? marker("ip") : undefined),
	},
	{
		kind: "home-path",
		pattern: /(\/home\/|\/Users\/|[A-Za-z]:\\\\?Users\\\\?)([^\s/\\'"`:]+)/g,
		replace: (m) => (m[2] === "<user>" ? undefined : `${m[1]}<user>`),
	},
];

/** Keys whose values are always secret, regardless of content. */
const SECRET_FIELD = new RegExp(`^${SECRET_KEY}$|^(?:apiKey|accessToken|refreshToken|clientSecret|privateKey|oauthToken|sessionToken|setCookie|set-cookie|x-api-key)$`, "i");

export function redactString(input: string, counts: RedactionCounts = {}): string {
	let text = input;
	for (const rule of RULES) {
		rule.pattern.lastIndex = 0;
		let out = "";
		let last = 0;
		for (let m = rule.pattern.exec(text); m; m = rule.pattern.exec(text)) {
			if (m[0].length === 0) {
				rule.pattern.lastIndex++;
				continue;
			}
			const replacement = rule.replace(m);
			if (replacement === undefined) continue;
			out += text.slice(last, m.index) + replacement;
			last = m.index + m[0].length;
			counts[rule.kind] = (counts[rule.kind] ?? 0) + 1;
		}
		if (last > 0) text = out + text.slice(last);
	}
	return text;
}

/** Deep-redact a JSON value: secret-named fields are blanked, every string is scanned. */
export function redactValue(value: unknown, counts: RedactionCounts = {}): unknown {
	if (typeof value === "string") return redactString(value, counts);
	if (Array.isArray(value)) return value.map((item) => redactValue(item, counts));
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) {
			if (SECRET_FIELD.test(key) && item !== null && item !== "" && typeof item !== "boolean") {
				out[key] = marker("credential");
				counts.credential = (counts.credential ?? 0) + 1;
			} else out[redactString(key, counts)] = redactValue(item, counts);
		}
		return out;
	}
	return value;
}
