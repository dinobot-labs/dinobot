import { createHash } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { isNewerStableVersion } from "../../src/update.ts";

export type ReleaseEnvironment = Record<string, string | undefined>;
export type ReleaseCommand = (argv: string[]) => Promise<{ exitCode: number; stdout: string }>;
export type ReleaseSelection = { source_sha: string; version: string; tag: string };
export type PreflightDependencies = {
	fetch: (url: string, init: RequestInit) => Promise<Response>;
	readTarball: (path: string) => Promise<Uint8Array>;
	timeoutMs: number;
};
export type ReleaseCliDependencies = PreflightDependencies & {
	command: ReleaseCommand;
	appendOutput: (path: string, contents: string) => Promise<void>;
};

const REGISTRY = "https://registry.npmjs.org/dinobot/";
const TIMEOUT_MS = 5_000;
const versionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
function exactMatch(pattern: RegExp, value: unknown): value is string {
	return typeof value === "string" && pattern.exec(value)?.[0] === value;
}
export function stableReleaseVersion(value: unknown): string {
	if (!exactMatch(versionPattern, value)) throw new Error("Expected a stable numeric release version");
	return value;
}
function releaseTag(value: unknown): string {
	if (typeof value !== "string" || !value.startsWith("v")) throw new Error("Expected a stable vX.Y.Z tag");
	stableReleaseVersion(value.slice(1));
	return value;
}
function commitSha(value: unknown): string {
	if (!exactMatch(/^[0-9a-fA-F]{40}$/, value)) throw new Error("Expected a full commit SHA");
	return value;
}
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid metadata");
	return value as Record<string, unknown>;
}
function parseJson(value: string): unknown {
	try { return JSON.parse(value); } catch { throw new Error("Invalid JSON metadata"); }
}

/** Read-only argv adapter: no shell and no subprocess output copied into diagnostics. */
export const runReleaseCommand: ReleaseCommand = async (argv) => {
	const child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 30_000, killSignal: "SIGKILL" });
	const stdout = await new Response(child.stdout).text();
	return { exitCode: await child.exited, stdout };
};
async function commandOutput(command: ReleaseCommand, argv: string[]): Promise<string> {
	const result = await command(argv);
	if (result.exitCode !== 0) throw new Error("Release source verification command failed");
	return result.stdout;
}
async function resolveTag(tag: string, command: ReleaseCommand): Promise<string> {
	const stdout = await commandOutput(command, ["git", "rev-parse", "--verify", "refs/tags/" + tag + "^{commit}"]);
	return commitSha(stdout.replace(/\r?\n$/, ""));
}
async function sourceVersion(sha: string, command: ReleaseCommand): Promise<string> {
	const pkg = object(parseJson(await commandOutput(command, ["git", "show", sha + ":package.json"])));
	if (pkg.name !== "dinobot" || pkg.private !== true) throw new Error("Expected the private dinobot source package");
	return stableReleaseVersion(pkg.version);
}

/** Select the immutable source and version BEFORE build; never read a working-tree manifest. */
export async function selectRelease(env: ReleaseEnvironment, command: ReleaseCommand = runReleaseCommand): Promise<ReleaseSelection> {
	if (env.GITHUB_EVENT_NAME !== "push" && env.GITHUB_EVENT_NAME !== "workflow_dispatch") throw new Error("Unsupported release event");
	if (env.GITHUB_REF !== "refs/heads/main") throw new Error("Releases require main");
	const eventSha = commitSha(env.GITHUB_SHA);
	if (env.INPUT_TAG) releaseTag(env.INPUT_TAG);
	if (env.GITHUB_EVENT_NAME === "push") return { source_sha: eventSha, version: await sourceVersion(eventSha, command), tag: "" };
	const tag = releaseTag(env.INPUT_TAG);
	const sha = await resolveTag(tag, command);
	await commandOutput(command, ["git", "merge-base", "--is-ancestor", sha, "origin/main"]);
	const release = object(parseJson(await commandOutput(command, ["gh", "api", "--method", "GET", "repos/tmdgusya/dinobot/releases/tags/" + tag])));
	if (release.tag_name !== tag || release.draft !== false || release.prerelease !== false
		|| typeof release.published_at !== "string" || !Number.isFinite(Date.parse(release.published_at))) {
		throw new Error("Expected a published stable GitHub release for the exact tag");
	}
	const version = await sourceVersion(sha, command);
	if (tag !== "v" + version) throw new Error("Source package version does not match release tag");
	return { source_sha: sha, version, tag };
}

/** Recheck after a workflow creates/fetches the tag; no remote mutation or output. */
export async function verifyTag(env: ReleaseEnvironment, command: ReleaseCommand = runReleaseCommand): Promise<void> {
	const tag = releaseTag(env.RELEASE_TAG);
	const sha = commitSha(env.EXPECTED_SHA);
	const version = stableReleaseVersion(env.EXPECTED_VERSION);
	if (tag !== "v" + version) throw new Error("Release tag does not match expected version");
	if ((await resolveTag(tag, command)).toLowerCase() !== sha.toLowerCase()) throw new Error("Release tag does not match expected commit");
}

/** One fixed-origin GET, with a deadline covering both headers and JSON body consumption. */
async function registryMetadata(selector: string, deps: PreflightDependencies): Promise<unknown | null> {
	const controller = new AbortController();
	let rejectAbort!: (error: Error) => void;
	const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
	const onAbort = () => rejectAbort(new Error("Registry request timed out"));
	controller.signal.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
	try {
		return await Promise.race([aborted, (async () => {
			const response = await deps.fetch(REGISTRY + selector, {
				method: "GET", redirect: "error", credentials: "omit", signal: controller.signal,
				headers: { accept: "application/json" },
			});
			if (response.redirected) throw new Error("Registry redirects are forbidden");
			if (response.status === 404) { await response.body?.cancel(); return null; }
			if (response.status !== 200) throw new Error("Registry request failed");
			try { return object(await response.json()); } catch { throw new Error("Invalid registry JSON metadata"); }
		})()]);
	} finally {
		clearTimeout(timer);
		controller.signal.removeEventListener("abort", onAbort);
		// Also stop unread error bodies; failure must not leave network work running.
		controller.abort();
	}
}

/** Audit is deliberately separate. This only authorizes or skips a later workflow publish. */
export async function preflight(tarball: string, requestedVersion: string, overrides: Partial<PreflightDependencies> = {}): Promise<{ publish: boolean }> {
	const version = stableReleaseVersion(requestedVersion);
	if (!tarball || /[\r\n\0]/.test(tarball)) throw new Error("Expected a tarball path");
	const deps: PreflightDependencies = { fetch: globalThis.fetch, readTarball: readFile, timeoutMs: TIMEOUT_MS, ...overrides };
	if (!Number.isSafeInteger(deps.timeoutMs) || deps.timeoutMs <= 0 || deps.timeoutMs > TIMEOUT_MS) throw new Error("Invalid registry deadline");
	const integrity = "sha512-" + createHash("sha512").update(await deps.readTarball(tarball)).digest("base64");
	const existing = await registryMetadata(version, deps);
	if (existing !== null) {
		const pkg = object(existing);
		if (pkg.name !== "dinobot" || pkg.version !== version || object(pkg.dist).integrity !== integrity) {
			throw new Error("Published version does not match the local artifact");
		}
		return { publish: false };
	}
	// Missing/invalid latest is not a bootstrap exemption: we cannot prove monotonicity.
	const latest = object(await registryMetadata("latest", deps));
	if (latest.name !== "dinobot") throw new Error("Invalid latest package identity");
	if (!isNewerStableVersion(stableReleaseVersion(latest.version), version)) throw new Error("Release must be newer than latest");
	return { publish: true };
}

export function formatGithubOutput(values: Record<string, string>): string {
	return Object.entries(values).map(([key, value]) => {
		if (!exactMatch(/^[a-z][a-z0-9_]*$/, key) || typeof value !== "string" || /[\r\n\0\u2028\u2029]/.test(value)) throw new Error("Unsafe workflow output");
		return key + "=" + value + "\n";
	}).join("");
}

/** CLI dependency seam; appendOutput is the sole write in this module. */
export async function runReleaseCli(argv: string[], env: ReleaseEnvironment = process.env, overrides: Partial<ReleaseCliDependencies> = {}): Promise<void> {
	const deps: ReleaseCliDependencies = {
		command: runReleaseCommand, fetch: globalThis.fetch, readTarball: readFile, timeoutMs: TIMEOUT_MS,
		appendOutput: (path, contents) => appendFile(path, contents, "utf8"), ...overrides,
	};
	const mode = argv[0];
	if (mode === "verify-tag" && argv.length === 1) return verifyTag(env, deps.command);
	if (!(mode === "select" && argv.length === 1 || mode === "preflight" && argv.length === 3)) throw new Error("Usage: release.ts select | verify-tag | preflight <tgz> <version>");
	const output = env.GITHUB_OUTPUT;
	if (!output || /[\r\n\0]/.test(output)) throw new Error("GITHUB_OUTPUT is required");
	const values = mode === "select"
		? await selectRelease(env, deps.command)
		: { publish: String((await preflight(argv[1]!, argv[2]!, deps)).publish) };
	await deps.appendOutput(output, formatGithubOutput(values));
}

if (import.meta.main) {
	try { await runReleaseCli(Bun.argv.slice(2)); }
	catch {
		// External responses and errors are untrusted data, not safe log messages/credentials.
		console.error("Release check failed; verify the event, source, tag and registry metadata.");
		process.exitCode = 1;
	}
}
