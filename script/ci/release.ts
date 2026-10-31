import { appendFile } from "node:fs/promises";

export type ReleaseEnvironment = Record<string, string | undefined>;
export type ReleaseCommand = (argv: string[]) => Promise<{ exitCode: number; stdout: string }>;
export type ReleaseSelection = { source_sha: string; version: string; tag: string };
export type ReleaseCliDependencies = {
	command: ReleaseCommand;
	appendOutput: (path: string, contents: string) => Promise<void>;
};

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
export function commitSha(value: unknown): string {
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
	if (env.GITHUB_EVENT_NAME !== "release" && env.GITHUB_EVENT_NAME !== "workflow_dispatch") throw new Error("Unsupported release event");
	const tag = releaseTag(env.INPUT_TAG);
	const expectedRef = env.GITHUB_EVENT_NAME === "release" ? "refs/tags/" + tag : "refs/heads/main";
	if (env.GITHUB_REF !== expectedRef) throw new Error("Release event ref does not match the required source");
	const eventSha = commitSha(env.GITHUB_SHA);
	const sha = await resolveTag(tag, command);
	if (env.GITHUB_EVENT_NAME === "release" && sha.toLowerCase() !== eventSha.toLowerCase()) {
		throw new Error("Release event SHA does not match the tag commit");
	}
	await commandOutput(command, ["git", "merge-base", "--is-ancestor", sha, "origin/main"]);
	const release = object(parseJson(await commandOutput(command, ["gh", "api", "--method", "GET", "repos/dinobot-labs/dinobot/releases/tags/" + tag])));
	if (release.tag_name !== tag || release.draft !== false || release.prerelease !== false
		|| typeof release.published_at !== "string" || !Number.isFinite(Date.parse(release.published_at))) {
		throw new Error("Expected a published stable GitHub release for the exact tag");
	}
	const version = await sourceVersion(sha, command);
	if (tag !== "v" + version) throw new Error("Source package version does not match release tag");
	return { source_sha: sha, version, tag };
}

/** Recheck the fetched tag against the tested source; no remote mutation or output. */
export async function verifyTag(env: ReleaseEnvironment, command: ReleaseCommand = runReleaseCommand): Promise<void> {
	const tag = releaseTag(env.RELEASE_TAG);
	const sha = commitSha(env.EXPECTED_SHA);
	const version = stableReleaseVersion(env.EXPECTED_VERSION);
	if (tag !== "v" + version) throw new Error("Release tag does not match expected version");
	if ((await resolveTag(tag, command)).toLowerCase() !== sha.toLowerCase()) throw new Error("Release tag does not match expected commit");
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
		command: runReleaseCommand,
		appendOutput: (path, contents) => appendFile(path, contents, "utf8"), ...overrides,
	};
	const mode = argv[0];
	if (mode === "verify-tag" && argv.length === 1) return verifyTag(env, deps.command);
	if (mode !== "select" || argv.length !== 1) throw new Error("Usage: release.ts select | verify-tag");
	const output = env.GITHUB_OUTPUT;
	if (!output || /[\r\n\0]/.test(output)) throw new Error("GITHUB_OUTPUT is required");
	const values = await selectRelease(env, deps.command);
	await deps.appendOutput(output, formatGithubOutput(values));
}

if (import.meta.main) {
	try { await runReleaseCli(Bun.argv.slice(2)); }
	catch {
		// External responses and errors are untrusted data, not safe log messages/credentials.
		console.error("Release check failed; verify the event, source and tag.");
		process.exitCode = 1;
	}
}
