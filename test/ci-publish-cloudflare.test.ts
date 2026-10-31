import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { auditReleaseArtifact, createReleaseManifest } from "../script/release-audit.ts";
import { publishCloudflare, runPublishCli, type CoreReleaseManifest, type PublishDependencies } from "../script/ci/publish-cloudflare.ts";

const ORIGIN = "https://releases.dinobot.workers.dev";
const VERSION = "1.2.3";
const SHA = "a".repeat(40);
const TOKEN = "synthetic-core-publisher-token";
const env = { EXPECTED_VERSION: VERSION, EXPECTED_SHA: SHA, RELEASE_TAG: "v" + VERSION, CORE_PUBLISH_TOKEN: TOKEN };
let dir: string;
let path: string;
let bytes: Buffer<ArrayBuffer>;
let released: CoreReleaseManifest;
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "core-publisher-test-"));
	path = join(dir, "artifact.tgz");
	mkdirSync(join(dir, "package"));
	const files = {
		"main.js": "console.log(1);", "codemode-worker.js": "postMessage(1);", "browser-host.js": "console.log(2);",
		"package.json": JSON.stringify(createReleaseManifest("dinobot", VERSION, "1.0.0", "1.63.0")),
		"README.md": "Public release.", "THIRD_PARTY_NOTICES.txt": "Third party notices.",
	};
	for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, "package", name), content);
	const tar = spawnSync("tar", ["--create", "--gzip", "--format=ustar", "--blocking-factor=1", "--file=-", "--", ...Object.keys(files).map(name => "package/" + name)], {
		cwd: dir, env: { PATH: process.env.PATH, LC_ALL: "C", TZ: "UTC" }, timeout: 10_000,
	});
	if (tar.status !== 0) throw new Error("fixture archive failed");
	bytes = tar.stdout;
	writeFileSync(path, bytes);
	released = { name: "dinobot", version: VERSION, sourceSha: SHA, size: bytes.length, publishedAt: "2026-10-31T00:00:00.000Z", dist: {
		tarball: ORIGIN + "/core/releases/1.2.3/dinobot-1.2.3.tgz",
		integrity: "sha512-" + createHash("sha512").update(bytes).digest("base64"),
	} };
});
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

function accepted(release: unknown = released, status = 200): Response {
	return Response.json({ ok: true, release, latestVersion: VERSION, promoted: true }, { status });
}
function fixture(responses?: (Response | Error)[]) {
	const events: string[] = [];
	const calls: { url: string; init: RequestInit }[] = [];
	let snapshot = "";
	const deps: PublishDependencies = {
		timeoutMs: 1000,
		readTarball: async input => { expect(input).toBe(path); events.push("read"); return bytes; },
		audit: async (input, version) => {
			snapshot = input;
			expect(input).not.toBe(path);
			expect(readFileSync(input)).toEqual(bytes);
			auditReleaseArtifact(input, version);
			events.push("audit");
		},
		fetch: async (url, init) => {
			expect(events.slice(0, 2)).toEqual(["read", "audit"]);
			expect(existsSync(snapshot)).toBe(false);
			expect(init.redirect).toBe("error");
			expect(init.credentials).toBe("omit");
			expect(init.cache).toBe("no-store");
			expect(init.signal).toBeInstanceOf(AbortSignal);
			calls.push({ url, init }); events.push(init.method!);
			if (responses) {
				const response = responses.shift();
				if (response instanceof Error) throw response;
				if (!response) throw new Error("unexpected fetch");
				return response;
			}
			return calls.length === 3 ? new Response(bytes) : calls.length === 1 ? accepted(released, 201) : Response.json(released);
		},
	};
	return { deps, calls, events, snapshot: () => snapshot };
}

test("audit precedes the only POST; exact bytes/hash/source and unauthenticated public readback", async () => {
	const f = fixture();
	expect(await runPublishCli([path, VERSION, SHA], { CORE_PUBLISH_TOKEN: TOKEN }, f.deps)).toEqual(released);
	expect(f.events).toEqual(["read", "audit", "POST", "GET", "GET"]);
	expect(f.calls.map(c => c.url)).toEqual([ORIGIN + "/core/publish", ORIGIN + "/core/releases/1.2.3/manifest.json", released.dist.tarball]);
	expect(f.calls[0]!.init.body).toEqual(bytes);
	expect(f.calls[0]!.init.headers).toEqual({ authorization: "Bearer " + TOKEN, "content-type": "application/gzip", accept: "application/json", "x-release-version": VERSION, "x-release-sha": SHA, "x-release-integrity": released.dist.integrity });
	for (const call of f.calls.slice(1)) expect(new Headers(call.init.headers).has("authorization")).toBe(false);
	expect(f.calls.every(c => c.init.signal?.aborted)).toBe(true);
});

test("idempotent 200 response supports existing historical tag retries without changing latest", async () => {
	const f = fixture([Response.json({ ok: true, release: released, latestVersion: "2.0.0", promoted: false }), Response.json(released), new Response(bytes)]);
	expect(await publishCloudflare(path, env, f.deps)).toEqual(released);
	expect(f.calls).toHaveLength(3);
});

test("audited snapshot cannot be replaced through the original reader buffer", async () => {
	const f = fixture();
	const mutable = Buffer.from(bytes);
	const audit = f.deps.audit;
	f.deps.readTarball = async () => { f.events.push("read"); return mutable; };
	f.deps.audit = async (input, version) => { await audit(input, version); mutable.fill(0); };
	await publishCloudflare(path, env, f.deps);
	expect(f.calls[0]!.init.body).toEqual(bytes);
});

test("invalid gzip/tar and mismatched package version never reach publication", async () => {
	for (const input of [Buffer.from("invalid gzip"), gzipSync("not a tar"), Buffer.alloc(0)]) {
		let calls = 0;
		await expect(publishCloudflare(path, env, { readTarball: async () => input, fetch: async () => { calls++; throw new Error("unexpected"); } })).rejects.toThrow();
		expect(calls).toBe(0);
	}
	const f = fixture();
	await expect(publishCloudflare(path, { ...env, EXPECTED_VERSION: "1.2.4", RELEASE_TAG: "v1.2.4" }, f.deps)).rejects.toThrow("mismatch");
	expect(f.calls).toHaveLength(0);
	expect(existsSync(f.snapshot())).toBe(false);
});

test("opaque publish token in otherwise valid payload fails before POST", async () => {
	const f = fixture();
	await expect(publishCloudflare(path, { ...env, CORE_PUBLISH_TOKEN: "Public" }, f.deps)).rejects.toThrow("credential found");
	expect(f.calls).toHaveLength(0);
	expect(existsSync(f.snapshot())).toBe(false);
});

for (const bad of [{ CORE_PUBLISH_TOKEN: "" }, { CORE_PUBLISH_TOKEN: "secret\nforged" }, { CORE_PUBLISH_TOKEN: "has space" }, { EXPECTED_VERSION: "1.2.3-rc.1" }, { EXPECTED_VERSION: "1.2.3+build" }, { EXPECTED_VERSION: "1.2.3\n" }, { EXPECTED_SHA: "short" }, { RELEASE_TAG: "v1.2.4" }, { RELEASE_TAG: "" }])
	test("invalid publish inputs rejected before read: " + JSON.stringify(bad), async () => {
		const f = fixture();
		await expect(publishCloudflare(path, { ...env, ...bad }, f.deps)).rejects.toThrow();
		expect(f.events).toEqual([]);
	});

for (const status of [401, 403, 404, 409, 429, 500, 302, 204])
	test("POST HTTP " + status + " fails without retries or leaking server body", async () => {
		const f = fixture([new Response(status === 204 ? null : TOKEN, { status })]);
		await expect(publishCloudflare(path, env, f.deps)).rejects.toThrow("verification failed");
		expect(f.calls).toHaveLength(1);
		expect(f.calls[0]!.init.signal?.aborted).toBe(true);
	});

for (const stage of [0, 1, 2]) test("network failure at stage " + stage + " is redacted and not retried", async () => {
	const responses: (Response | Error)[] = [accepted(), Response.json(released), new Response(bytes)];
	responses[stage] = new Error(TOKEN);
	const f = fixture(responses);
	try { await publishCloudflare(path, env, f.deps); throw new Error("unexpected success"); }
	catch (e) { expect(String(e)).toContain("verification failed"); expect(String(e)).not.toContain(TOKEN); }
	expect(f.calls).toHaveLength(stage + 1);
});

for (const stage of [0, 1]) test("returned/public manifest identity and metadata mismatches fail at stage " + stage, async () => {
	for (const changed of [null, [], {}, { ...released, name: "other" }, { ...released, version: "1.2.4" },
		{ ...released, sourceSha: "b".repeat(40) }, { ...released, size: bytes.length + 1 }, { ...released, publishedAt: "invalid" },
		{ ...released, dist: { ...released.dist, integrity: "sha512-wrong" } },
		{ ...released, dist: { ...released.dist, tarball: "https://example.com/stolen" } }]) {
		const responses = [accepted(), Response.json(released)];
		responses[stage] = stage === 0 ? accepted(changed) : Response.json(changed);
		const f = fixture(responses);
		await expect(publishCloudflare(path, env, f.deps)).rejects.toThrow("verification failed");
		expect(f.calls).toHaveLength(stage + 1);
	}
});

test("public publication timestamp cannot differ from POST response", async () => {
	const f = fixture([accepted(), Response.json({ ...released, publishedAt: "2026-11-01T00:00:00Z" })]);
	await expect(publishCloudflare(path, env, f.deps)).rejects.toThrow();
	expect(f.calls).toHaveLength(2);
});

test("malformed/oversized JSON, redirects and absent public version fail closed", async () => {
	const redirected = Response.json(released);
	Object.defineProperty(redirected, "redirected", { value: true });
	for (const response of [new Response("not JSON " + TOKEN), new Response(" ".repeat(65 * 1024)), redirected,
		Response.json(released), Response.json({ ok: false, release: released }), Response.json({ ok: true })]) {
		const f = fixture([response]);
		await expect(publishCloudflare(path, env, f.deps)).rejects.toThrow();
		expect(f.calls).toHaveLength(1);
	}
	const f = fixture([accepted(), new Response(null, { status: 404 })]);
	await expect(publishCloudflare(path, env, f.deps)).rejects.toThrow();
	expect(f.calls).toHaveLength(2);
});

test("downloaded bytes must match both byte length and SHA512", async () => {
	const corrupt = Buffer.from(bytes); corrupt[0] = corrupt[0]! ^ 1;
	for (const body of [corrupt, bytes.subarray(1), Buffer.concat([bytes, Buffer.from([0])])]) {
		const f = fixture([accepted(), Response.json(released), new Response(body)]);
		await expect(publishCloudflare(path, env, f.deps)).rejects.toThrow();
		expect(f.calls).toHaveLength(3);
	}
});

for (const stage of [0, 1, 2]) for (const hangingBody of [false, true])
	test("single bounded deadline at stage " + stage + " body=" + hangingBody, async () => {
		const f = fixture();
		let signal: AbortSignal | null | undefined;
		let count = 0;
		const started = performance.now();
		await expect(publishCloudflare(path, env, { ...f.deps, audit: () => {}, timeoutMs: 20, fetch: async (_, init) => {
			signal = init.signal;
			if (count++ < stage) return count === 1 ? accepted() : Response.json(released);
			return hangingBody ? new Response(new ReadableStream({ start() {} })) : new Promise<Response>(() => {});
		} })).rejects.toThrow("timed out");
		expect(signal?.aborted).toBe(true);
		expect(count).toBe(stage + 1);
		expect(performance.now() - started).toBeLessThan(1000);
	});

test("CLI rejects extra args and real CLI failure prints neither token nor artifact path", async () => {
	const f = fixture();
	for (const argv of [[], [path], [path, VERSION], [path, VERSION, SHA, "extra"]]) await expect(runPublishCli(argv, env, f.deps)).rejects.toThrow("Usage");
	expect(f.events).toEqual([]);
	const child = Bun.spawn([process.execPath, resolve("script/ci/publish-cloudflare.ts"), "missing-private-path", VERSION, SHA], {
		env: { PATH: process.env.PATH, ...env }, stdout: "pipe", stderr: "pipe",
	});
	expect(await child.exited).toBe(1);
	const output = await new Response(child.stdout).text() + await new Response(child.stderr).text();
	expect(output).toContain("Cloudflare publication failed");
	expect(output).not.toContain(TOKEN);
	expect(output).not.toContain("missing-private-path");
});
