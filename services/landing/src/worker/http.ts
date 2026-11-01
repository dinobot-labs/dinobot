/** Security policy shared by generated responses and asset fallback. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
	"x-content-type-options": "nosniff",
	"referrer-policy": "strict-origin-when-cross-origin",
	"permissions-policy": "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
	"x-frame-options": "DENY",
	"cross-origin-opener-policy": "same-origin",
};
export const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
/** Same strict policy as public/_headers, including fallback responses. */
export const PAGE_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";
const API_HEADERS = { ...SECURITY_HEADERS, "content-security-policy": API_CSP, "cross-origin-resource-policy": "same-origin", "cache-control": "no-store" };
export const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...API_HEADERS, ...headers } });
export const fail = (status: number, error: string, headers?: Record<string, string>) => json(status, { error }, headers);

/** Copy immutable fetched headers; retain asset cache validators and policy. */
export function withHeaders(response: Response, set: Record<string, string>, fill: Readonly<Record<string, string>>): Response {
	const headers = new Headers(response.headers);
	for (const [name, value] of Object.entries(set)) headers.set(name, value);
	for (const [name, value] of Object.entries(fill)) if (!headers.has(name)) headers.set(name, value);
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
