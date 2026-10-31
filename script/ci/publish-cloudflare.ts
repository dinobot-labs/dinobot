#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { auditReleaseArtifact } from "../release-audit.ts";
import { commitSha, stableReleaseVersion, type ReleaseEnvironment } from "./release.ts";

const ORIGIN = "https://releases.dinobot.workers.dev";
const DEADLINE_MS = 60_000;
const MAX_ARCHIVE = 32 * 1024 * 1024;
export type CoreReleaseManifest = {
	name: "dinobot"; version: string; dist: { tarball: string; integrity: string };
	sourceSha: string; size: number; publishedAt: string;
};
export type PublishDependencies = {
	fetch: (url: string, init: RequestInit) => Promise<Response>;
	readTarball: (path: string) => Promise<Uint8Array>;
	audit: (path: string, version: string) => void | Promise<void>;
	timeoutMs: number;
};
function integrity(bytes: Uint8Array): string {
	return "sha512-" + createHash("sha512").update(bytes).digest("base64");
}
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid release manifest");
	return value as Record<string, unknown>;
}
function manifest(value: unknown, expected: Omit<CoreReleaseManifest, "publishedAt">): CoreReleaseManifest {
	const m = object(value);
	const dist = object(m.dist);
	if (m.name !== expected.name || m.version !== expected.version || m.sourceSha !== expected.sourceSha
		|| m.size !== expected.size || dist.tarball !== expected.dist.tarball || dist.integrity !== expected.dist.integrity
		|| typeof m.publishedAt !== "string" || !Number.isFinite(Date.parse(m.publishedAt))) {
		throw new Error("Published manifest does not match audited artifact");
	}
	return { ...expected, publishedAt: m.publishedAt };
}
async function boundedBody(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array> {
	if (!response.body) throw new Error("Missing release response body");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			signal.throwIfAborted();
			const { done, value } = await reader.read();
			if (done) break;
			size += value.length;
			if (size > limit) throw new Error("Oversized release response");
			chunks.push(value);
		}
		return Buffer.concat(chunks, size);
	} finally {
		await reader.cancel();
		reader.releaseLock();
	}
}

/** One mutation, after auditing an immutable snapshot; never retry ambiguous POST outcomes.
 * The Worker owns immutable version conflicts and atomic monotonic latest advancement.
 * A historical tag retry verifies its version, not a potentially newer latest pointer. */
export async function publishCloudflare(tarball: string, env: ReleaseEnvironment = process.env, overrides: Partial<PublishDependencies> = {}): Promise<CoreReleaseManifest> {
	const version = stableReleaseVersion(env.EXPECTED_VERSION);
	const sourceSha = commitSha(env.EXPECTED_SHA).toLowerCase();
	if (env.RELEASE_TAG !== "v" + version) throw new Error("Release tag does not match expected version");
	const token = env.CORE_PUBLISH_TOKEN;
	if (!token || /[^\x21-\x7e]/.test(token)) throw new Error("CORE_PUBLISH_TOKEN is required and must be a single printable token");
	if (!tarball || /[\r\n\0]/.test(tarball)) throw new Error("Expected a tarball path");
	const deps: PublishDependencies = { fetch: globalThis.fetch, readTarball: readFile, audit: auditReleaseArtifact, timeoutMs: DEADLINE_MS, ...overrides };
	if (!Number.isSafeInteger(deps.timeoutMs) || deps.timeoutMs <= 0 || deps.timeoutMs > DEADLINE_MS) throw new Error("Invalid publication deadline");
	// Copy even injected reader buffers: the bytes sent cannot change during asynchronous auditing.
	const bytes = Buffer.from(await deps.readTarball(tarball));
	if (!bytes.length || bytes.length > MAX_ARCHIVE) throw new Error("Invalid archive size");
	const dir = await mkdtemp(join(tmpdir(), "dinobot-core-publish-"));
	try {
		const snapshot = join(dir, "artifact.tgz");
		await writeFile(snapshot, bytes, { mode: 0o600, flag: "wx" });
		await deps.audit(snapshot, version);
		// In addition to the shared credential audit, reject this deployment's opaque secret.
		if (gunzipSync(bytes, { maxOutputLength: 64 * 1024 * 1024 }).includes(Buffer.from(token))) throw new Error("Publish credential found in artifact");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
	const base = ORIGIN + "/core/releases/" + version;
	const expected = { name: "dinobot" as const, version, sourceSha, size: bytes.length, dist: { tarball: base + "/dinobot-" + version + ".tgz", integrity: integrity(bytes) } };
	const controller = new AbortController();
	let timedOut = false;
	let rejectTimeout!: (error: Error) => void;
	const deadline = new Promise<never>((_, reject) => { rejectTimeout = reject; });
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
		rejectTimeout(new Error("Cloudflare publication timed out; verify the version before retrying"));
	}, deps.timeoutMs);
	async function request(url: string, init: RequestInit, max: number): Promise<Uint8Array> {
		controller.signal.throwIfAborted();
		const response = await deps.fetch(url, { ...init, redirect: "error", credentials: "omit", cache: "no-store", signal: controller.signal });
		controller.signal.throwIfAborted();
		if (response.redirected || (response.status !== 200 && !(init.method === "POST" && response.status === 201))) {
			throw new Error("Cloudflare publication HTTP failure");
		}
		return boundedBody(response, max, controller.signal);
	}
	async function json(url: string, init: RequestInit): Promise<unknown> {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await request(url, init, 64 * 1024)));
	}
	try {
		return await Promise.race([deadline, (async () => {
			const receipt = object(await json(ORIGIN + "/core/publish", { method: "POST", body: bytes, headers: {
				authorization: "Bearer " + token, "content-type": "application/gzip", accept: "application/json",
				"x-release-version": version, "x-release-sha": sourceSha, "x-release-integrity": expected.dist.integrity,
			} }));
			if (receipt.ok !== true) throw new Error("Publication was not acknowledged");
			const published = manifest(receipt.release, expected);
			const visible = manifest(await json(base + "/manifest.json", { method: "GET", headers: { accept: "application/json" } }), expected);
			if (visible.publishedAt !== published.publishedAt) throw new Error("Public manifest differs from publication response");
			const downloaded = await request(expected.dist.tarball, { method: "GET", headers: { accept: "application/gzip" } }, bytes.length);
			if (downloaded.length !== bytes.length || integrity(downloaded) !== expected.dist.integrity) throw new Error("Downloaded release bytes differ from audited artifact");
			return visible;
		})()]);
	} catch {
		// Fetch errors and server bodies can echo credentials. No untrusted cause escapes.
		throw new Error(timedOut ? "Cloudflare publication timed out; verify the version before retrying" : "Cloudflare publication or public artifact verification failed; verify the version before retrying");
	} finally {
		clearTimeout(timer);
		controller.abort();
	}
}

export async function runPublishCli(argv: string[], env: ReleaseEnvironment = process.env, overrides: Partial<PublishDependencies> = {}): Promise<CoreReleaseManifest> {
	if (argv.length !== 3) throw new Error("Usage: publish-cloudflare.ts <audited.tgz> <version> <source-sha>");
	return publishCloudflare(argv[0]!, { ...env, EXPECTED_VERSION: argv[1], EXPECTED_SHA: argv[2], RELEASE_TAG: env.RELEASE_TAG ?? "v" + argv[1] }, overrides);
}
if (import.meta.main) {
	try {
		const published = await runPublishCli(Bun.argv.slice(2));
		console.log("Verified Cloudflare core release " + published.version);
	} catch {
		console.error("Cloudflare publication failed; verify the source, tag, audited artifact, credentials and public version before retrying.");
		process.exitCode = 1;
	}
}
