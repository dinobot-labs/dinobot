#!/usr/bin/env bun
/** Audit the actual npm artifact without extracting anything to the filesystem. Requires GNU tar. */
import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { gunzipSync } from "node:zlib";

// browser-host.js is the browser plugin's child entry; main.js finds it next to itself (src/plugins/browser/index.ts).
const FILES = ["main.js", "codemode-worker.js", "browser-host.js", "package.json", "README.md", "THIRD_PARTY_NOTICES.txt"] as const;
const MEMBERS = new Set<string>(FILES.map((file) => "package/" + file));
const MAX_COMPRESSED = 32 * 1024 * 1024;
const MAX_EXPANDED = 64 * 1024 * 1024;
const MAX_MEMBER = 32 * 1024 * 1024;
const MAX_MANIFEST = 64 * 1024;
// No prerelease targets; SemVer build metadata does not change stability.
const STABLE_VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
// Local archives opt in explicitly; external dependency pins remain stable-only.
const EXACT_VERSION = /^(?:0|[1-9][0-9]*)[.](?:0|[1-9][0-9]*)[.](?:0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:[.](?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:[+][0-9A-Za-z-]+(?:[.][0-9A-Za-z-]+)*)?$/;
export type ReleaseAuditOptions = { readonly local?: boolean };

export class ReleaseAuditError extends Error {}

function reject(reason: string): never {
	// All reasons are fixed categories or allowlisted member names, never untrusted payloads/tool stderr.
	throw new ReleaseAuditError("release audit: " + reason);
}

function stableVersion(value: unknown): value is string {
	return typeof value === "string" && value.length <= 128 && STABLE_VERSION.exec(value)?.[0] === value;
}

/**
 * Single source of truth for the intentionally tiny public manifest (including npm OIDC identity). Exactly two
 * external dependencies, both pinned: the native addon loader and `patchright` (the browser host's driver, kept
 * out of the bundle because it loads its own driver files from its package directory).
 */
export function createReleaseManifest(name: string, version: string, nativeVersion: string, patchrightVersion: string) {
	return {
		name, version,
		description: "dinobot — channel-agnostic team agent bot",
		license: "PolyForm-Noncommercial-1.0.0",
		type: "module",
		bin: { dinobot: "main.js" },
		files: FILES.filter((file) => file !== "package.json"),
		engines: { bun: ">=1.4.0" },
		os: ["linux", "darwin", "win32"],
		dependencies: { "@oh-my-pi/pi-natives": nativeVersion, patchright: patchrightVersion },
		repository: { type: "git", url: "git+https://github.com/dinobot-labs/dinobot.git" },
	};
}

function readArchive(path: string): Buffer {
	let fd: number | undefined;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size === 0 || stat.size > MAX_COMPRESSED) reject("invalid or oversized archive file");
		const bytes = Buffer.alloc(stat.size);
		let offset = 0;
		while (offset < bytes.length) {
			const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
			if (!count) reject("archive changed while reading");
			offset += count;
		}
		if (readSync(fd, Buffer.alloc(1), 0, 1, offset)) reject("archive changed while reading");
		return bytes;
	} catch (error) {
		if (error instanceof ReleaseAuditError) throw error;
		return reject("cannot read archive");
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function tar(bytes: Buffer, args: string[], maxBuffer: number): Buffer {
	const result = spawnSync("tar", ["--file=-", ...args], {
		input: bytes, maxBuffer, timeout: 10_000,
		// Do not inherit TAR_OPTIONS (can execute commands), locale, or compression helpers.
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" },
	});
	if (result.error || result.status !== 0 || result.signal || result.stderr.length) {
		reject("invalid archive or GNU tar unavailable");
	}
	return result.stdout;
}

function listMembers(bytes: Buffer): { name: string; size: number }[] {
	const listing = tar(bytes, ["--list", "--verbose", "--block-number", "--numeric-owner", "--full-time",
		"--quoting-style=escape", "--ignore-zeros"], 1024 * 1024).toString("utf8").trimEnd().split("\n");
	const entries: { name: string; size: number }[] = [];
	const seen = new Set<string>();
	let nextBlock = 0;
	let zeros = 0;
	let ended = false;
	for (const [index, line] of listing.entries()) {
		const block = /^block ([0-9]+): (.+)$/.exec(line);
		if (!block || Number(block[1]) !== nextBlock) reject("invalid tar layout");
		if (block[2] === "** End of File **") {
			if (index !== listing.length - 1 || zeros < 2 || nextBlock * 512 !== bytes.length) reject("truncated tar archive");
			ended = true;
			break;
		}
		if (block[2] === "** Block of NULs **") {
			zeros++;
			nextBlock++;
			continue;
		}
		const entry = /^-[rwxstST-]{9} [0-9]+\/[0-9]+ +([0-9]+) \S+ \S+ (.+)$/.exec(block[2]!);
		if (!entry || zeros) reject("nonregular member or invalid tar layout");
		const name = entry[2]!;
		const size = Number(entry[1]);
		if (!MEMBERS.has(name)) reject("unexpected archive member");
		if (seen.has(name)) reject("duplicate archive member");
		if (!Number.isSafeInteger(size) || size < 0 || size > MAX_MEMBER
			|| (name === "package/package.json" && size > MAX_MANIFEST)) reject("invalid or oversized member");
		// GNU tar parses names, checksums and sizes. Block continuity plus the raw type byte rules out
		// hidden PAX/GNU extension headers and sparse encodings; this is not a second tar parser.
		const type = bytes[nextBlock * 512 + 156];
		if (type !== 0 && type !== 48) reject("nonregular or extended tar member");
		const payloadEnd = nextBlock * 512 + 512 + size;
		nextBlock += 1 + Math.ceil(size / 512);
		if (bytes.subarray(payloadEnd, nextBlock * 512).some((byte) => byte !== 0)) reject("invalid tar padding");
		seen.add(name);
		entries.push({ name, size });
	}
	if (!ended || entries.length !== MEMBERS.size) reject("missing archive member or incomplete archive");
	return entries;
}

// High-confidence credential shapes only: words such as token/apiKey, env names, provider URLs,
// placeholders and public repository identifiers are expected in application code and documentation.
const CREDENTIALS = [
	/\bgh[pousr]_[A-Za-z0-9]{36}\b/,
	/\bgithub_pat_[A-Za-z0-9_]{50,}\b/,
	/\bnpm_[A-Za-z0-9]{36,}\b/,
	/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
	/\bxox[baprs]-[0-9]{10,}-[A-Za-z0-9-]{20,}\b/,
	/\bsk-(?:(?:proj|svcacct)-|ant-api[0-9]{2}-)?[A-Za-z0-9_-]{32,}\b/,
	/\bAIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])/,
	/\b[0-9]{6,12}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/,
	/-----BEGIN ((?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY)-----[ \t]*(?:\r?\n|\\[rn])+[A-Za-z0-9+/=\\\r\n]{64,}-----END \1-----/,
];

function inspectPayload(name: string, body: string): void {
	// Not line-anchored: block or line directives may follow minified code on the same line.
	if (/\/[/*][#@]\s*sourceMappingURL\s*=/.test(body)) reject(name + ": source map directive");
	if (/patchedDependencies|patches\/@(?:earendil-works|oh-my-pi)|bun (?:--watch )?src\/main\.ts/.test(body)) {
		reject(name + ": repository manifest leakage");
	}
	const normalized = body.replaceAll("\\\\", "/").replaceAll("\\", "/");
	const buildPaths = [resolve(import.meta.dir, ".."), homedir()].map((path) => path.replaceAll("\\", "/"));
	if (buildPaths.some((path) => path.length > 1 && normalized.includes(path))
		|| /\/(?:home|Users)\/[A-Za-z0-9_.-]+\//.test(normalized)
		|| /[A-Za-z]:\/Users\/[A-Za-z0-9_.-]+\//.test(normalized)
		|| /\/(?:builds|__w)\/[^\s"\x27\x60]+\//.test(normalized)) reject(name + ": build or home path");
	if (CREDENTIALS.some((pattern) => pattern.test(body))) reject(name + ": credential signature");
}

/** Throws a redacted ReleaseAuditError on failure. No install/publish, archive execution, or disk extraction. */
export function auditReleaseArtifact(path: string, expectedVersion: string, expectedName = "dinobot", options: ReleaseAuditOptions = {}): void {
	const localVersion = options.local === true && typeof expectedVersion === "string"
		&& expectedVersion.length <= 128 && EXACT_VERSION.exec(expectedVersion)?.[0] === expectedVersion;
	if (!localVersion && !stableVersion(expectedVersion)) {
		reject(options.local ? "expected version must be exact SemVer" : "expected version must be stable SemVer");
	}
	const namePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
	if (expectedName.length > 214 || namePattern.exec(expectedName)?.[0] !== expectedName) reject("invalid expected package name");
	let bytes: Buffer;
	try {
		const compressed = readArchive(path);
		// zlib accepts zero-prefixed trailing garbage by default. Check consumed input as well as CRC.
		// Node typings do not model the documented info:true return shape.
		const decoded = gunzipSync(compressed, { maxOutputLength: MAX_EXPANDED, info: true }) as unknown as {
			buffer: Buffer; engine: { bytesWritten: number };
		};
		if (decoded.engine.bytesWritten !== compressed.length) reject("trailing gzip data");
		bytes = decoded.buffer;
	} catch (error) {
		if (error instanceof ReleaseAuditError) throw error;
		reject("invalid, corrupt, truncated or oversized gzip archive");
	}
	if (bytes.length < 1024 || bytes.length % 512) reject("truncated tar archive");
	const entries = listMembers(bytes);
	// Only after EVERY member passed the allowlist/type/size/duplicate checks. Same immutable bytes
	// in both passes avoid a pathname race. -O writes payloads only to stdout, never to disk.
	const contents = tar(bytes, ["--extract", "--to-stdout", "--no-wildcards", "--", ...entries.map(({ name }) => name)], MAX_EXPANDED);
	if (contents.length !== entries.reduce((sum, entry) => sum + entry.size, 0)) reject("incorrect extracted size");
	let offset = 0;
	for (const { name, size } of entries) {
		let body: string;
		try { body = new TextDecoder("utf-8", { fatal: true }).decode(contents.subarray(offset, offset + size)); }
		catch { reject(name + ": invalid UTF-8 payload"); }
		offset += size;
		inspectPayload(name, body);
		if (name !== "package/package.json") continue;
		let manifest: unknown;
		try { manifest = JSON.parse(body); } catch { reject("invalid package manifest JSON"); }
		if (!manifest || typeof manifest !== "object" || !("dependencies" in manifest)
			|| !manifest.dependencies || typeof manifest.dependencies !== "object") reject("invalid package manifest");
		const dependencies = manifest.dependencies as Record<string, unknown>;
		const nativeVersion = dependencies["@oh-my-pi/pi-natives"];
		const patchrightVersion = dependencies.patchright;
		if (!stableVersion(nativeVersion) || !stableVersion(patchrightVersion)
			|| !isDeepStrictEqual(manifest, createReleaseManifest(expectedName, expectedVersion, nativeVersion, patchrightVersion))) {
			reject("manifest fields, identity, or version mismatch");
		}
	}
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const local = args[0] === "--local";
	if (local) args.shift();
	const [path, version, name = "dinobot", ...extra] = args;
	if (!path || !version || extra.length) {
		console.error("usage: bun script/release-audit.ts [--local] <tgz> <expected-version> [expected-name]");
		process.exit(1);
	}
	try {
		auditReleaseArtifact(path, version, name, { local });
		console.log(`release audit: passed (${FILES.length} regular members)`);
	} catch (error) {
		console.error(error instanceof ReleaseAuditError ? error.message : "release audit: failed");
		process.exit(1);
	}
}
