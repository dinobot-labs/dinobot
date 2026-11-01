import type { Clock, Env } from "./env.ts";
import { fail, HttpError, json, mediaType, readCapped } from "./http.ts";
import type { Locale } from "./locale.ts";
import { addEntry } from "./store.ts";

/** Version of the consent text the page shows; stored with every entry. Bump it whenever the consent wording changes. */
export const CONSENT_VERSION = "waitlist-consent-v1";

export const LIMITS = {
	bodyBytes: 4096,
	emailChars: 254,
	localPartChars: 64,
	/** Submissions faster than this (form render to submit) are treated as bots. */
	minElapsedMs: 1200,
} as const;

/** The JSON body of `POST /api/waitlist` (Content-Type: application/json, at most 4 KiB). */
export type WaitlistRequest = {
	email: string;
	consent: true;
	locale: Locale;
	/** Optional campaign tag, kept only if it is 1-64 chars of [a-z0-9_-]. */
	source?: string;
	/** Honeypot field; people leave it empty. */
	website?: string;
	/** Milliseconds from form render to submit. */
	elapsedMs?: number;
};

export type WaitlistErrorCode =
	| "invalid_body"
	| "invalid_email"
	| "consent_required"
	| "unsupported_media_type"
	| "payload_too_large"
	| "method_not_allowed"
	| "rate_limited"
	| "not_found"
	| "internal";

/** 201 joined (with the position; bot submissions get none), 200 already, or an error status with a code. */
export type WaitlistResponse = { status: "joined"; position?: number } | { status: "already" } | { error: WaitlistErrorCode };

export type Signup = { email: string; locale: Locale; source: string | null };
export type ParsedSignup =
	| { kind: "signup"; signup: Signup }
	| { kind: "bot" }
	| { kind: "invalid"; error: "invalid_body" | "invalid_email" | "consent_required" };

const LOCAL_PART = /^[A-Za-z0-9!#$%&'*+\/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+\/=?^_`{|}~-]+)*$/;
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/i;
const SOURCE = /^[a-z0-9_-]{1,64}$/;

/**
 * Pragmatic address check: after trimming, at most 254 chars; an RFC 5322 dot-atom local part of at most 64 chars;
 * an ASCII host name with at least two labels and an alphabetic or punycode TLD. Returns the address with the domain
 * lowercased and the local part as typed, or undefined.
 */
export function normalizeEmail(input: string): string | undefined {
	const email = input.trim();
	if (email.length > LIMITS.emailChars) return undefined;
	const at = email.lastIndexOf("@");
	if (at < 1) return undefined;
	const local = email.slice(0, at);
	const domain = email.slice(at + 1);
	if (local.length > LIMITS.localPartChars || !LOCAL_PART.test(local) || !DOMAIN.test(domain)) return undefined;
	return `${local}@${domain.toLowerCase()}`;
}

/** An optional campaign tag survives only as 1-64 chars of [a-z0-9_-]; anything else is dropped. */
export const normalizeSource = (input: unknown): string | null => (typeof input === "string" && SOURCE.test(input) ? input : null);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const invalid = (error: "invalid_body" | "invalid_email" | "consent_required"): ParsedSignup => ({ kind: "invalid", error });

/**
 * Validate a decoded body. Order: wrong types (invalid_body), then bot signals (a non-empty honeypot or a submission
 * faster than 1.2 s), then the address (invalid_email), then consent (consent_required). Unknown keys are ignored.
 */
export function parseSignup(body: unknown): ParsedSignup {
	if (!isRecord(body)) return invalid("invalid_body");
	const { email, consent, source, website, elapsedMs } = body;
	const locale = body.locale ?? "en";
	if (typeof email !== "string" || (locale !== "en" && locale !== "ko")) return invalid("invalid_body");
	if (website !== undefined && typeof website !== "string") return invalid("invalid_body");
	if (elapsedMs !== undefined && typeof elapsedMs !== "number") return invalid("invalid_body");
	if ((website !== undefined && website !== "") || (elapsedMs !== undefined && elapsedMs < LIMITS.minElapsedMs)) return { kind: "bot" };
	const address = normalizeEmail(email);
	if (address === undefined) return invalid("invalid_email");
	if (consent !== true) return invalid("consent_required");
	return { kind: "signup", signup: { email: address, locale, source: normalizeSource(source) } };
}

/** `POST /api/waitlist`. The router has already checked the method and the per-IP rate limit. */
export async function handleWaitlist(request: Request, env: Env, now: Clock): Promise<Response> {
	if (mediaType(request.headers.get("content-type")) !== "application/json") return fail(415, "unsupported_media_type");
	if (Number(request.headers.get("content-length") ?? 0) > LIMITS.bodyBytes) return fail(413, "payload_too_large");
	let body: unknown;
	try {
		const bytes = await readCapped(request.body, LIMITS.bodyBytes);
		body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch (error) {
		if (error instanceof HttpError) return fail(error.status, error.code);
		return fail(400, "invalid_body");
	}
	const parsed = parseSignup(body);
	if (parsed.kind === "invalid") return fail(400, parsed.error);
	// Bots get the normal success shape so they learn nothing, and nothing is stored.
	if (parsed.kind === "bot") return json(201, { status: "joined" });
	const position = await addEntry(env.DB, { ...parsed.signup, consentVersion: CONSENT_VERSION, createdAt: new Date(now()).toISOString() });
	return position === null ? json(200, { status: "already" }) : json(201, { status: "joined", position });
}
