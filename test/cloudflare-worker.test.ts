import { expect, test } from "bun:test";
import worker, { MAX_BYTES, ORIGIN, type Bucket, type Env, type Release, type StoredObject } from "../script/cloudflare/worker.ts";

type PutOptions = Parameters<Bucket["put"]>[2];
type Entry = { bytes: Uint8Array<ArrayBuffer>; etag: string; customMetadata: Record<string, string>; options: PutOptions };
const latestKey = "core/latest.json";
const artifact = (v: string) => "core/releases/" + v + "/dinobot-" + v + ".tgz";
const manifest = (v: string) => "core/releases/" + v + "/manifest.json";
const bytes = new TextEncoder().encode("release archive fixture");
const sha = "a".repeat(40);
const checksum = (data: Uint8Array) => "sha512-" + new Bun.CryptoHasher("sha512").update(data).digest("base64");

/** Atomic preconditions are checked AFTER any scheduling barrier, like R2 at commit time.
 * get returns an isolated snapshot with a fresh readable body. ETags are content-derived. */
class MemoryBucket implements Bucket {
	objects = new Map<string, Entry>();
	reads: string[] = [];
	attempts: { key: string; options: PutOptions }[] = [];
	writes: string[] = [];
	beforePut?: (key: string, value: ArrayBuffer | string, options: PutOptions) => Promise<void>;
	afterPut?: (key: string, entry: Entry) => void;
	async get(key: string): Promise<StoredObject | null> {
		this.reads.push(key);
		const original = this.objects.get(key);
		if (!original) return null;
		const data = original.bytes.slice();
		return { etag: original.etag, size: data.length, customMetadata: { ...original.customMetadata },
			body: new ReadableStream({ start(controller) { controller.enqueue(data); controller.close(); } }),
			arrayBuffer: async () => data.slice().buffer,
			text: async () => new TextDecoder().decode(data),
		};
	}
	async put(key: string, value: ArrayBuffer | string, options: PutOptions): Promise<{ etag: string } | null> {
		this.attempts.push({ key, options });
		await this.beforePut?.(key, value, options);
		const old = this.objects.get(key);
		if ("etagMatches" in options.onlyIf && old?.etag !== options.onlyIf.etagMatches) return null;
		if ("etagDoesNotMatch" in options.onlyIf && old) return null;
		const data = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value.slice(0));
		const etag = new Bun.CryptoHasher("md5").update(data).digest("hex");
		const entry = { bytes: data, etag, customMetadata: { ...options.customMetadata }, options };
		this.objects.set(key, entry); this.writes.push(key);
		this.afterPut?.(key, entry);
		return { etag };
	}
	seed(key: string, data: string) {
		this.objects.set(key, { bytes: new TextEncoder().encode(data), etag: "seed-etag", customMetadata: {}, options: { onlyIf: { etagDoesNotMatch: "*" }, httpMetadata: { contentType: "application/json", cacheControl: "no-store" } } });
	}
	metadata(key = latestKey): Release { return JSON.parse(new TextDecoder().decode(this.objects.get(key)!.bytes)); }
}
function setup() {
	const bucket = new MemoryBucket();
	const env: Env = { BUCKET: bucket, CORE_PUBLISH_TOKEN: "test-secret-not-a-real-token" };
	return { bucket, env };
}
function upload(version = "1.0.0", body: Uint8Array<ArrayBuffer> = bytes, headers: Record<string, string> = {}): Request {
	return new Request(ORIGIN + "/core/publish", { method: "POST", headers: {
		authorization: "Bearer test-secret-not-a-real-token", "x-release-version": version,
		"x-release-sha": sha, "x-release-integrity": checksum(body), ...headers,
	}, body });
}
async function publish(env: Env, version = "1.0.0", body: Uint8Array<ArrayBuffer> = bytes, headers: Record<string, string> = {}) {
	return worker.fetch(upload(version, body, headers), env);
}
function get(env: Env, path: string, method = "GET") { return worker.fetch(new Request(ORIGIN + path, { method }), env); }
function barrier() {
	let release!: () => void;
	const wait = new Promise<void>(resolve => { release = resolve; });
	return { wait, release };
}
async function error(response: Response, status: number, code: string) {
	expect(response.status).toBe(status);
	expect(await response.json()).toEqual({ error: code });
	expect(response.headers.get("cache-control")).toBe("no-store");
}

test("plaintext publication rejects before body access or storage", async () => {
	const { bucket, env } = setup();
	const request = new Request(ORIGIN.replace("https:", "http:") + "/core/publish", { method: "POST", headers: upload().headers, body: bytes });
	let touched = false;
	Object.defineProperty(request, "body", { get() { touched = true; throw new Error("must not read body"); } });
	await error(await worker.fetch(request, env), 400, "https_required");
	expect(touched).toBe(false);
	expect(bucket.reads).toEqual([]);
	expect(bucket.writes).toEqual([]);
});

test("authentication fails before body access or R2; missing server token fails closed", async () => {
	for (const authorization of ["", "Bearer wrong", "Basic test-secret-not-a-real-token"]) {
		const { bucket, env } = setup(); const request = upload("1.0.0", bytes, { authorization });
		let touched = false;
		Object.defineProperty(request, "body", { get() { touched = true; throw new Error("must not read body"); } });
		await error(await worker.fetch(request, env), 401, "unauthorized");
		expect(touched).toBe(false); expect(bucket.reads).toEqual([]); expect(bucket.writes).toEqual([]);
	}
	const { env } = setup(); env.CORE_PUBLISH_TOKEN = "";
	await error(await publish(env), 401, "unauthorized");
});

test("bootstrap publishes verified bytes, immutable manifest and latest in order", async () => {
	const { bucket, env } = setup(); const response = await publish(env);
	expect(response.status).toBe(200);
	const result = await response.json() as { ok: boolean; release: Release; latestVersion: string; promoted: boolean };
	expect(result).toEqual({ ok: true, release: bucket.metadata(), latestVersion: "1.0.0", promoted: true });
	expect(result.release).toEqual({ name: "dinobot", version: "1.0.0", sourceSha: sha, size: bytes.length,
		dist: { tarball: ORIGIN + "/" + artifact("1.0.0"), integrity: checksum(bytes) }, publishedAt: expect.any(String) });
	expect(new Date(result.release.publishedAt).toISOString()).toBe(result.release.publishedAt);
	expect(bucket.writes).toEqual([artifact("1.0.0"), manifest("1.0.0"), latestKey]);
	expect(bucket.attempts.every(a => "etagDoesNotMatch" in a.options.onlyIf)).toBe(true);
	expect(bucket.objects.get(artifact("1.0.0"))!.bytes).toEqual(bytes);
	expect(bucket.metadata(manifest("1.0.0"))).toEqual(result.release);
	expect(bucket.reads).toContain(artifact("1.0.0"));
});

test("all invalid headers and missing headers reject before writes", async () => {
	for (const version of ["", "1", "1.2", "v1.2.3", "01.2.3", "1.02.3", "1.2.03", "1.2.3-rc.1", "1.2.3+build", "../desktop", "1.2.3/evil"]) {
		const { env, bucket } = setup(); await error(await publish(env, version), 400, "invalid_release_headers"); expect(bucket.writes).toEqual([]);
	}
	for (const headers of [{ "x-release-sha": "b".repeat(39) }, { "x-release-sha": "A".repeat(40) }, { "x-release-integrity": "sha512-bad" }, { "x-release-integrity": "sha256-" + "a".repeat(86) + "==" }]) {
		await error(await publish(setup().env, "1.0.0", bytes, headers), 400, "invalid_release_headers");
	}
	for (const header of ["x-release-version", "x-release-sha", "x-release-integrity"]) {
		const request = upload(); request.headers.delete(header);
		await error(await worker.fetch(request, setup().env), 400, "invalid_release_headers");
	}
});

test("checksum mismatch cannot mutate any object", async () => {
	const { env, bucket } = setup();
	await error(await publish(env, "1.0.0", bytes, { "x-release-integrity": checksum(new Uint8Array([1])) }), 422, "checksum_mismatch");
	expect(bucket.reads).toEqual([]); expect(bucket.writes).toEqual([]);
});

test("empty body, oversized advertised body and oversized streaming body reject", async () => {
	const { env, bucket } = setup();
	await error(await publish(env, "1.0.0", new Uint8Array()), 400, "empty_body");
	const headers = upload().headers;
	await error(await worker.fetch(new Request(ORIGIN + "/core/publish", { method: "POST", headers }), env), 400, "empty_body");
	await error(await publish(env, "1.0.0", bytes, { "content-length": String(MAX_BYTES + 1) }), 413, "body_too_large");
	let cancelled = false;
	let index = 0;
	const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(index++ === 0 ? MAX_BYTES : 1)); }, cancel() { cancelled = true; } });
	await error(await worker.fetch(new Request(ORIGIN + "/core/publish", { method: "POST", headers, body: stream }), env), 413, "body_too_large");
	expect(cancelled).toBe(true); expect(bucket.writes).toEqual([]);
});

test("exact 32 MiB upload succeeds", async () => {
	const { env, bucket } = setup(); const body = new Uint8Array(MAX_BYTES);
	expect((await publish(env, "1.0.0", body)).status).toBe(200);
	expect(bucket.metadata().size).toBe(MAX_BYTES);
});

test("identical retry preserves all immutable metadata including publishedAt", async () => {
	const { env, bucket } = setup(); await publish(env);
	const snapshot = bucket.metadata(); const writes = [...bucket.writes];
	const response = await publish(env); expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ ok: true, release: snapshot, latestVersion: "1.0.0", promoted: false });
	expect(bucket.writes).toEqual(writes); expect(bucket.metadata(manifest("1.0.0"))).toEqual(snapshot);
});

test("same version with different bytes or source SHA rejects without overwrites", async () => {
	const { env, bucket } = setup(); await publish(env); const writes = [...bucket.writes];
	await error(await publish(env, "1.0.0", new Uint8Array([9])), 409, "release_conflict");
	await error(await publish(env, "1.0.0", bytes, { "x-release-sha": "b".repeat(40) }), 409, "release_conflict");
	expect(bucket.writes).toEqual(writes); expect(bucket.objects.get(artifact("1.0.0"))!.bytes).toEqual(bytes);
});

test("upgrade uses old ETag; new downgrade rejects; old identical retry never downgrades", async () => {
	const { env, bucket } = setup(); await publish(env); const oldEtag = bucket.objects.get(latestKey)!.etag;
	expect((await publish(env, "2.0.0")).status).toBe(200);
	expect(bucket.attempts.at(-1)!.options.onlyIf).toEqual({ etagMatches: oldEtag });
	const writes = [...bucket.writes];
	await error(await publish(env, "1.5.0"), 409, "downgrade");
	const retried = await publish(env); expect(retried.status).toBe(200);
	expect(await retried.json()).toMatchObject({ latestVersion: "2.0.0", promoted: false });
	expect(bucket.writes).toEqual(writes); expect(bucket.metadata().version).toBe("2.0.0");
});

for (const [first, second] of [["1.9.9", "1.10.0"], ["1.2.9", "1.2.10"], ["9007199254740992.0.0", "9007199254740993.0.0"], ["1.999999999999999999999999.0", "2.0.0"]]) {
	test("numeric version ordering without precision loss: " + first + " -> " + second, async () => {
		const { env, bucket } = setup(); expect((await publish(env, first!)).status).toBe(200);
		expect((await publish(env, second!)).status).toBe(200); expect(bucket.metadata().version).toBe(second!);
	});
}

test("malformed existing latest fails closed before any write and cannot redirect", async () => {
	for (const raw of ["not json", "{}", JSON.stringify({ name: "dinobot", version: "1.0.0" }), "x".repeat(4097)]) {
		const { env, bucket } = setup(); bucket.seed(latestKey, raw);
		await error(await publish(env), 503, "invalid_stored_metadata"); expect(bucket.writes).toEqual([]);
		await error(await get(env, "/core/latest.json"), 503, "invalid_stored_metadata");
		await error(await get(env, "/core/dinobot.tgz"), 503, "invalid_stored_metadata");
	}
});

test("valid-shaped metadata with foreign origin, bad size, date or version is rejected", async () => {
	const base = setup(); await publish(base.env); const valid = base.bucket.metadata();
	for (const value of [
		{ ...valid, dist: { ...valid.dist, tarball: "https://evil.invalid/archive.tgz" } },
		{ ...valid, size: 0 }, { ...valid, size: MAX_BYTES + 1 }, { ...valid, size: 1.5 },
		{ ...valid, publishedAt: "today" }, { ...valid, publishedAt: "2025-01-01" },
		{ ...valid, sourceSha: "bad" }, { ...valid, version: "01.0.0" },
	]) {
		const { env, bucket } = setup(); bucket.seed(latestKey, JSON.stringify(value));
		await error(await publish(env, "2.0.0"), 503, "invalid_stored_metadata"); expect(bucket.writes).toEqual([]);
	}
});

test("readback detects corrupt storage even after successful put", async () => {
	const { env, bucket } = setup();
	bucket.afterPut = (key, entry) => { if (key.endsWith(".tgz")) entry.bytes[0] = entry.bytes[0]! ^ 255; };
	await error(await publish(env), 409, "release_conflict");
	expect(bucket.writes).toEqual([artifact("1.0.0")]); expect(bucket.objects.has(latestKey)).toBe(false);
});

test("partial artifact-only write binds source SHA, supports identical retry and rejects changed source", async () => {
	const { env, bucket } = setup();
	bucket.beforePut = async key => { if (key.endsWith("manifest.json")) throw new Error("simulated outage"); };
	await error(await publish(env), 503, "storage_unavailable");
	delete bucket.beforePut;
	await error(await publish(env, "1.0.0", bytes, { "x-release-sha": "b".repeat(40) }), 409, "release_conflict");
	await error(await publish(env, "1.0.0", new Uint8Array([8])), 409, "release_conflict");
	expect((await publish(env)).status).toBe(200); expect(bucket.metadata().sourceSha).toBe(sha);
});

for (const bootstrap of [true, false]) test("CAS race protects newest latest, bootstrap=" + bootstrap, async () => {
	const { env, bucket } = setup(); if (!bootstrap) await publish(env, "0.0.1");
	const reached = barrier(); const resume = barrier();
	bucket.beforePut = async (key, value) => {
		if (key === latestKey && JSON.parse(value as string).version === "1.0.0") { reached.release(); await resume.wait; }
	};
	const older = publish(env, "1.0.0"); await reached.wait;
	expect((await publish(env, "2.0.0")).status).toBe(200);
	resume.release(); await error(await older, 409, "latest_conflict");
	expect(bucket.metadata().version).toBe("2.0.0");
	delete bucket.beforePut;
	const retry = await publish(env, "1.0.0"); expect(retry.status).toBe(200);
	expect(await retry.json()).toMatchObject({ latestVersion: "2.0.0", promoted: false });
	expect(bucket.metadata().version).toBe("2.0.0");
});

test("newer CAS loser can retry and advance latest", async () => {
	const { env, bucket } = setup(); await publish(env, "0.0.1");
	const reached = barrier(); const resume = barrier();
	bucket.beforePut = async (key, value) => {
		if (key === latestKey && JSON.parse(value as string).version === "2.0.0") { reached.release(); await resume.wait; }
	};
	const newer = publish(env, "2.0.0"); await reached.wait;
	expect((await publish(env, "1.0.0")).status).toBe(200); resume.release();
	await error(await newer, 409, "latest_conflict"); delete bucket.beforePut;
	expect((await publish(env, "2.0.0")).status).toBe(200); expect(bucket.metadata().version).toBe("2.0.0");
});

test("concurrent same version with different source has one immutable winner", async () => {
	const { env, bucket } = setup(); const reached = barrier(); const resume = barrier();
	bucket.beforePut = async (key, _value, options) => {
		if (key.endsWith(".tgz") && options.customMetadata?.sourceSha === sha) { reached.release(); await resume.wait; }
	};
	const first = publish(env); await reached.wait;
	expect((await publish(env, "1.0.0", bytes, { "x-release-sha": "b".repeat(40) })).status).toBe(200);
	resume.release(); await error(await first, 409, "release_conflict");
	expect(bucket.metadata().sourceSha).toBe("b".repeat(40));
	expect(bucket.objects.get(artifact("1.0.0"))!.customMetadata.sourceSha).toBe("b".repeat(40));
});

test("concurrent identical publishers preserve the winning manifest timestamp", async () => {
	const { env, bucket } = setup(); const reached = barrier(); const resume = barrier(); let held = false;
	bucket.beforePut = async key => { if (key.endsWith("manifest.json") && !held) { held = true; reached.release(); await resume.wait; } };
	const first = publish(env); await reached.wait;
	expect((await publish(env)).status).toBe(200); const winner = bucket.metadata();
	resume.release(); await error(await first, 409, "latest_conflict");
	expect(bucket.metadata(manifest("1.0.0"))).toEqual(winner);
	delete bucket.beforePut; expect((await publish(env)).status).toBe(200);
	expect(bucket.writes.filter(k => k === manifest("1.0.0"))).toHaveLength(1);
});

test("GET and HEAD serve metadata, redirect and immutable artifact with cache policies", async () => {
	const { env, bucket } = setup(); await publish(env);
	for (const path of ["/core/latest.json", "/" + manifest("1.0.0"), "/" + artifact("1.0.0"), "/core/dinobot.tgz"]) {
		const response = await get(env, path); const head = await get(env, path, "HEAD");
		expect(head.status).toBe(response.status); expect(await head.text()).toBe("");
		expect(head.headers.get("etag")).toBe(response.headers.get("etag"));
		expect(head.headers.get("cache-control")).toBe(response.headers.get("cache-control"));
		if (path === "/core/dinobot.tgz") {
			expect(response.status).toBe(302); expect(response.headers.get("location")).toBe(ORIGIN + "/" + artifact("1.0.0"));
		} else if (path.endsWith(".tgz")) {
			expect(response.status).toBe(200); expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
			expect(response.headers.get("content-type")).toBe("application/gzip"); expect(head.headers.get("content-length")).toBe(String(bytes.length));
		} else { expect(response.status).toBe(200); expect(await response.json()).toEqual(bucket.metadata()); }
		expect(response.headers.get("cache-control")).toBe(path.includes("/releases/") ? "public, max-age=31536000, immutable" : "no-store");
	}
	expect((await get(env, "/core/latest.json?cache-buster=1")).status).toBe(200);
});

test("unknown/mismatched paths and unsupported methods cannot write or escape core", async () => {
	const { env, bucket } = setup();
	for (const path of ["/", "/latest.json", "/desktop/latest.json", "/core/releases/1.0.0/dinobot-2.0.0.tgz", "/core/releases/v1.0.0/manifest.json", "/core/releases/1.0.0/extra", "/core/releases/1.0.0%2f..%2fdesktop/manifest.json", "/core/latest.json/"]) {
		await error(await get(env, path), 404, "not_found");
		expect((await get(env, path, "HEAD")).status).toBe(404);
	}
	for (const path of ["/core/latest.json", "/core/dinobot.tgz", "/" + artifact("1.0.0"), "/" + manifest("1.0.0")]) {
		await error(await get(env, path), 404, "not_found");
		for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
			const response = await get(env, path, method); expect(response.headers.get("allow")).toBe("GET, HEAD");
			await error(response, 405, "method_not_allowed");
		}
	}
	for (const method of ["GET", "PUT", "DELETE", "OPTIONS"]) {
		const response = await get(env, "/core/publish", method); expect(response.headers.get("allow")).toBe("POST");
		await error(response, 405, "method_not_allowed");
	}
	const head = await get(env, "/core/publish", "HEAD"); expect(head.status).toBe(405); expect(await head.text()).toBe("");
	expect(bucket.writes).toEqual([]); expect(bucket.reads.every(key => key.startsWith("core/"))).toBe(true);
});

test("storage errors do not expose token or backend exception", async () => {
	const { env, bucket } = setup(); bucket.beforePut = async () => { throw new Error(env.CORE_PUBLISH_TOKEN + " confidential backend details"); };
	await error(await publish(env), 503, "storage_unavailable");
});
