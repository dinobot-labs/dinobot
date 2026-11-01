/** Dedicated core release origin. No Desktop routes, SDK, Node APIs or credentials. */
export const ORIGIN = "https://releases.dinobot.workers.dev";
export const MAX_BYTES = 32 * 1024 * 1024;
const LATEST = "core/latest.json";
const IMMUTABLE = "public, max-age=31536000, immutable";

// Structural subset of Cloudflare R2; conditional put returns null on precondition failure.
export interface StoredObject {
	etag: string;
	size: number;
	customMetadata?: Record<string, string>;
	body: ReadableStream<Uint8Array>;
	arrayBuffer(): Promise<ArrayBuffer>;
	text(): Promise<string>;
}
export interface Bucket {
	get(key: string): Promise<StoredObject | null>;
	put(key: string, value: ArrayBuffer | string, options: {
		onlyIf: { etagMatches: string } | { etagDoesNotMatch: "*" };
		httpMetadata: { contentType: string; cacheControl: string };
		customMetadata?: Record<string, string>;
	}): Promise<{ etag: string } | null>;
}
export interface Env { BUCKET: Bucket; CORE_PUBLISH_TOKEN: string }
export interface Release {
	name: "dinobot";
	version: string;
	dist: { tarball: string; integrity: string };
	sourceSha: string;
	size: number;
	publishedAt: string;
}
class HttpError extends Error {
	constructor(readonly status: number, readonly code: string) { super(code); }
}
function fail(status: number, code: string): never { throw new HttpError(status, code); }
function stable(value: unknown): value is string {
	return typeof value === "string" && value.length <= 256
		&& /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(value)?.[0] === value;
}
function compare(a: string, b: string): number {
	const left = a.split("."); const right = b.split(".");
	for (let i = 0; i < 3; i++) {
		const x = left[i]!; const y = right[i]!;
		if (x.length !== y.length) return x.length > y.length ? 1 : -1;
		if (x !== y) return x > y ? 1 : -1;
	}
	return 0;
}
function sha(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{40}$/.exec(value)?.[0] === value;
}
function integrity(value: unknown): value is string {
	return typeof value === "string" && /^sha512-[A-Za-z0-9+/]{86}==$/.exec(value)?.[0] === value
		&& "sha512-" + btoa(atob(value.slice(7))) === value;
}
function artifactKey(version: string): string { return `core/releases/${version}/dinobot-${version}.tgz`; }
function manifestKey(version: string): string { return `core/releases/${version}/manifest.json`; }
function validRelease(value: unknown): value is Release {
	if (!value || typeof value !== "object") return false;
	const r = value as Partial<Release>;
	return r.name === "dinobot" && stable(r.version) && sha(r.sourceSha)
		&& Number.isSafeInteger(r.size) && r.size! > 0 && r.size! <= MAX_BYTES
		&& typeof r.publishedAt === "string" && Number.isFinite(Date.parse(r.publishedAt))
		&& new Date(r.publishedAt).toISOString() === r.publishedAt
		&& !!r.dist && r.dist.tarball === `${ORIGIN}/${artifactKey(r.version)}` && integrity(r.dist.integrity);
}
async function parseStored(object: StoredObject): Promise<Release> {
	if (object.size > 4096) fail(503, "invalid_stored_metadata");
	let parsed: unknown;
	try { parsed = JSON.parse(await object.text()); } catch { fail(503, "invalid_stored_metadata"); }
	if (!validRelease(parsed)) fail(503, "invalid_stored_metadata");
	return parsed;
}
async function hash(bytes: ArrayBuffer): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-512", bytes));
	return "sha512-" + btoa(String.fromCharCode(...digest));
}
async function readUpload(request: Request): Promise<ArrayBuffer> {
	const length = request.headers.get("content-length");
	if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > MAX_BYTES)) fail(413, "body_too_large");
	if (!request.body) fail(400, "empty_body");
	const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			size += chunk.value.byteLength;
			if (size > MAX_BYTES) {
				await reader.cancel().catch(() => {});
				fail(413, "body_too_large");
			}
			chunks.push(chunk.value);
		}
	} finally { reader.releaseLock(); }
	if (size === 0) fail(400, "empty_body");
	const bytes = new Uint8Array(size); let offset = 0;
	for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
	return bytes.buffer;
}
function identical(a: Release, b: Release): boolean {
	return a.version === b.version && a.sourceSha === b.sourceSha && a.size === b.size
		&& a.dist.integrity === b.dist.integrity;
}
async function readArtifact(bucket: Bucket, release: Release): Promise<void> {
	const object = await bucket.get(artifactKey(release.version));
	if (!object || object.size !== release.size || object.customMetadata?.sourceSha !== release.sourceSha
		|| object.customMetadata?.integrity !== release.dist.integrity) fail(409, "release_conflict");
	const bytes = await object.arrayBuffer();
	if (bytes.byteLength !== release.size || await hash(bytes) !== release.dist.integrity) fail(409, "release_conflict");
}
function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return Response.json(value, { status, headers: { "Cache-Control": "no-store", ...headers } });
}
async function publish(request: Request, env: Env): Promise<Response> {
	// Authenticate before touching body, headers containing release data, or R2.
	if (!env.CORE_PUBLISH_TOKEN || request.headers.get("authorization") !== `Bearer ${env.CORE_PUBLISH_TOKEN}`) fail(401, "unauthorized");
	const version = request.headers.get("x-release-version");
	const sourceSha = request.headers.get("x-release-sha");
	const checksum = request.headers.get("x-release-integrity");
	if (!stable(version) || !sha(sourceSha) || !integrity(checksum)) fail(400, "invalid_release_headers");
	const bytes = await readUpload(request);
	if (await hash(bytes) !== checksum) fail(422, "checksum_mismatch");
	const candidate: Release = { name: "dinobot", version, dist: { tarball: `${ORIGIN}/${artifactKey(version)}`, integrity: checksum }, sourceSha, size: bytes.byteLength, publishedAt: new Date().toISOString() };
	// Snapshot before mutations. An older writer cannot overwrite a concurrent newer winner.
	const oldObject = await env.BUCKET.get(LATEST);
	const old = oldObject ? await parseStored(oldObject) : null;
	const manifestObject = await env.BUCKET.get(manifestKey(version));
	let release = manifestObject ? await parseStored(manifestObject) : candidate;
	if (!identical(release, candidate)) fail(409, "release_conflict");
	if (old && compare(version, old.version) < 0) {
		if (!manifestObject) fail(409, "downgrade");
		await readArtifact(env.BUCKET, release);
		return json({ ok: true, release, latestVersion: old.version, promoted: false });
	}
	if (old && version === old.version && !identical(old, candidate)) fail(409, "release_conflict");
	await env.BUCKET.put(artifactKey(version), bytes, {
		onlyIf: { etagDoesNotMatch: "*" },
		httpMetadata: { contentType: "application/gzip", cacheControl: IMMUTABLE },
		customMetadata: { sourceSha, integrity: checksum },
	});
	// Always re-read, including successful puts. Source identity is bound atomically to bytes.
	await readArtifact(env.BUCKET, candidate);
	if (!manifestObject) {
		await env.BUCKET.put(manifestKey(version), JSON.stringify(candidate), {
			onlyIf: { etagDoesNotMatch: "*" },
			httpMetadata: { contentType: "application/json", cacheControl: IMMUTABLE },
		});
		const stored = await env.BUCKET.get(manifestKey(version));
		if (!stored) fail(503, "invalid_stored_metadata");
		release = await parseStored(stored);
		if (!identical(release, candidate)) fail(409, "release_conflict");
	}
	if (old && version === old.version) return json({ ok: true, release, latestVersion: version, promoted: false });
	const promoted = await env.BUCKET.put(LATEST, JSON.stringify(release), {
		onlyIf: oldObject ? { etagMatches: oldObject.etag } : { etagDoesNotMatch: "*" },
		httpMetadata: { contentType: "application/json", cacheControl: "no-store" },
	});
	if (!promoted) fail(409, "latest_conflict");
	return json({ ok: true, release, latestVersion: version, promoted: true });
}
export type BootstrapAssets = Record<"/install.sh" | "/install.ps1" | "/install.mjs", string>;
async function route(request: Request, env: Env, assets?: BootstrapAssets): Promise<Response> {
	const url = new URL(request.url);
	const path = url.pathname;
	if (path === "/install.sh" || path === "/install.ps1" || path === "/install.mjs") {
		if (url.protocol !== "https:") fail(400, "https_required");
		if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "method_not_allowed" }, 405, { Allow: "GET, HEAD" });
		if (!assets?.[path]) fail(503, "bootstrap_unavailable");
		return new Response(request.method === "HEAD" ? null : assets[path], { headers: {
			"Content-Type": path === "/install.mjs" ? "application/javascript; charset=utf-8" : "text/plain; charset=utf-8",
			"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
		} });
	}
	if (path === "/core/publish") {
		if (url.protocol !== "https:") fail(400, "https_required");
		if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, { Allow: "POST" });
		return publish(request, env);
	}
	const match = /^\/core\/releases\/([^/]+)\/(manifest\.json|dinobot-([^/]+)\.tgz)$/.exec(path);
	const latest = path === "/core/latest.json"; const redirect = path === "/core/dinobot.tgz";
	if (!latest && !redirect && (!match || !stable(match[1]) || (match[3] !== undefined && match[3] !== match[1]))) fail(404, "not_found");
	if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "method_not_allowed" }, 405, { Allow: "GET, HEAD" });
	const key = latest || redirect ? LATEST : path.slice(1);
	const object = await env.BUCKET.get(key);
	if (!object) fail(404, "not_found");
	const headers: Record<string, string> = { "Cache-Control": latest || redirect ? "no-store" : IMMUTABLE, ETag: `"${object.etag}"`, "X-Content-Type-Options": "nosniff" };
	if (latest || redirect || match?.[2] === "manifest.json") {
		const release = await parseStored(object);
		if (match && release.version !== match[1]) fail(503, "invalid_stored_metadata");
		if (redirect) return new Response(null, { status: 302, headers: { ...headers, Location: release.dist.tarball } });
		headers["Content-Type"] = "application/json";
		return new Response(JSON.stringify(release), { headers });
	}
	headers["Content-Type"] = "application/gzip";
	headers["Content-Length"] = String(object.size);
	return new Response(request.method === "HEAD" ? null : object.body, { headers });
}
export function createReleaseWorker(assets?: BootstrapAssets) { return {
	async fetch(request: Request, env: Env): Promise<Response> {
		let response: Response;
		try { response = await route(request, env, assets); }
		catch (error) { response = error instanceof HttpError ? json({ error: error.code }, error.status) : json({ error: "storage_unavailable" }, 503); }
		// HEAD has no body, including errors and redirects.
		return request.method === "HEAD" ? new Response(null, response) : response;
	},
}; }
export default createReleaseWorker();
