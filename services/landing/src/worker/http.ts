/** Response helpers, the capped body reader and the security headers on every response the Worker returns. */

/** Set on every Worker response. Pages passed through from ASSETS keep any value public/_headers already gave them. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
	"x-content-type-options": "nosniff",
	"referrer-policy": "strict-origin-when-cross-origin",
	"permissions-policy": "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
	"x-frame-options": "DENY",
	"cross-origin-opener-policy": "same-origin",
};

/** CSP for what the Worker generates itself (JSON, redirects): nothing loads from or frames these responses. */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/**
 * CSP for pages passed through from ASSETS when public/_headers did not set one (keep the two in sync).
 * Same origin only, with no inline scripts or styles; dynamic styles use CSSOM.
 */
export const PAGE_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

const API_HEADERS: Readonly<Record<string, string>> = {
	...SECURITY_HEADERS,
	"content-security-policy": API_CSP,
	"cross-origin-resource-policy": "same-origin",
	"cache-control": "no-store",
};

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...API_HEADERS, ...headers } });

export const fail = (status: number, error: string, headers?: Record<string, string>) => json(status, { error }, headers);

export const redirect = (location: string, headers: Record<string, string> = {}) =>
	new Response(null, { status: 302, headers: { location, ...API_HEADERS, ...headers } });

export const plain = (status: number, body: string) =>
	new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", ...API_HEADERS } });

/** Copy a response (fetched responses have immutable headers), `set` headers and `fill` in the ones it lacks. */
export function withHeaders(response: Response, set: Record<string, string>, fill: Readonly<Record<string, string>>): Response {
	const headers = new Headers(response.headers);
	for (const [name, value] of Object.entries(set)) headers.set(name, value);
	for (const [name, value] of Object.entries(fill)) if (!headers.has(name)) headers.set(name, value);
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** Add header names to a Vary value without duplicating any. */
export function mergeVary(current: string | null, names: readonly string[]): string {
	const values = (current ?? "")
		.split(",")
		.map((value) => value.trim())
		.filter((value) => value !== "");
	if (values.includes("*")) return "*";
	const seen = new Set(values.map((value) => value.toLowerCase()));
	for (const name of names) {
		if (seen.has(name.toLowerCase())) continue;
		values.push(name);
		seen.add(name.toLowerCase());
	}
	return values.join(", ");
}

/** The media type of a Content-Type header: lowercased, parameters dropped. */
export const mediaType = (header: string | null) => (header ?? "").split(";")[0]!.trim().toLowerCase();

export class HttpError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
	) {
		super(code);
	}
}

/** Read a request body up to `max` bytes; throws 413 without buffering the excess. A missing body reads as empty. */
export async function readCapped(body: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array<ArrayBuffer>> {
	if (!body) return new Uint8Array(0);
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > max) {
			await reader.cancel().catch(() => {});
			throw new HttpError(413, "payload_too_large");
		}
		chunks.push(value);
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

/**
 * Drain what is left of a request body, up to `max` bytes (a longer body is cancelled). An answer given before the
 * body was read (415, 429, 404, 405) would otherwise leave unread bytes on the connection: workerd then drops the
 * connection and the client's next request on it fails (seen with `vite preview`: "fetch failed", 500).
 */
export async function discardBody(request: Request, max: number): Promise<void> {
	if (request.body === null || request.bodyUsed) return;
	await readCapped(request.body, max).catch(() => {});
}
