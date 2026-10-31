import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	formatGithubOutput, runReleaseCli, runReleaseCommand, selectRelease, stableReleaseVersion, verifyTag,
	type ReleaseCommand, type ReleaseEnvironment,
} from "../script/ci/release.ts";

const SHA = "a".repeat(40);
const TAG_SHA = "b".repeat(40);
const VERSION = "1.2.3";
const TAG = "v" + VERSION;
const source = { name: "dinobot", private: true, version: VERSION };
const published = { tag_name: TAG, draft: false, prerelease: false, published_at: "2026-01-01T00:00:00Z" };
const push = { GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main", GITHUB_SHA: SHA };
const dispatch = { ...push, GITHUB_EVENT_NAME: "workflow_dispatch", INPUT_TAG: TAG };
const releaseEvent = { ...dispatch, GITHUB_EVENT_NAME: "release", GITHUB_REF: "refs/tags/" + TAG, GITHUB_SHA: TAG_SHA };
const verifyEnv = { RELEASE_TAG: TAG, EXPECTED_SHA: TAG_SHA, EXPECTED_VERSION: VERSION };
function commands(options: { sha?: string; pkg?: unknown; release?: unknown; fail?: string } = {}) {
	const calls: string[][] = [];
	const command: ReleaseCommand = async (argv) => {
		calls.push(argv);
		if (argv[1] === options.fail) return { exitCode: 1, stdout: "untrusted error" };
		if (argv[0] === "git" && argv[1] === "rev-parse") return { exitCode: 0, stdout: (options.sha ?? TAG_SHA) + "\n" };
		if (argv[0] === "git" && argv[1] === "merge-base") return { exitCode: 0, stdout: "" };
		if (argv[0] === "git" && argv[1] === "show") return { exitCode: 0, stdout: JSON.stringify(options.pkg === undefined ? source : options.pkg) };
		if (argv[0] === "gh" && argv[1] === "api") return { exitCode: 0, stdout: JSON.stringify(options.release === undefined ? published : options.release) };
		throw new Error("Unexpected command: " + JSON.stringify(argv));
	};
	return { command, calls };
}

for (const bad of ["", "1.2", "v1.2.3", "01.2.3", "1.02.3", "1.2.03", "1.2.3-rc.1", "1.2.3+build", "1.2.3\n", "1.2.3\r", "1.2.3;echo", " 1.2.3"])
	test("stable release rejects " + JSON.stringify(bad), () => { expect(() => stableReleaseVersion(bad)).toThrow(); });

test("release event accepts a detached tag ref and binds the event SHA to the exact source", async () => {
	const fixture = commands();
	expect(await selectRelease(releaseEvent, fixture.command)).toEqual({ source_sha: TAG_SHA, version: VERSION, tag: TAG });
	expect(fixture.calls).toEqual([
		["git", "rev-parse", "--verify", "refs/tags/v1.2.3^{commit}"],
		["git", "merge-base", "--is-ancestor", TAG_SHA, "origin/main"],
		["gh", "api", "--method", "GET", "repos/dinobot-labs/dinobot/releases/tags/v1.2.3"],
		["git", "show", TAG_SHA + ":package.json"],
	]);
});

for (const bad of [{ GITHUB_REF: "refs/heads/main" }, { GITHUB_REF: "refs/tags/v1.2.4" }, { GITHUB_SHA: "bad" }, { INPUT_TAG: "v1.2.3-rc.1" }, { INPUT_TAG: "" }])
	test("release event rejects mismatched or invalid inputs " + JSON.stringify(bad), async () => {
		const fixture = commands();
		await expect(selectRelease({ ...releaseEvent, ...bad }, fixture.command)).rejects.toThrow();
		expect(fixture.calls).toHaveLength(0);
	});

test("release event rejects a moved tag before API lookup", async () => {
	const fixture = commands();
	await expect(selectRelease({ ...releaseEvent, GITHUB_SHA: SHA }, fixture.command)).rejects.toThrow();
	expect(fixture.calls).toHaveLength(1);
});

test("dispatch resolves exact annotated/lightweight tag commit and verifies ancestry/release/source", async () => {
	const fixture = commands();
	expect(await selectRelease(dispatch, fixture.command)).toEqual({ source_sha: TAG_SHA, version: VERSION, tag: TAG });
	expect(fixture.calls).toEqual([
		["git", "rev-parse", "--verify", "refs/tags/v1.2.3^{commit}"],
		["git", "merge-base", "--is-ancestor", TAG_SHA, "origin/main"],
		["gh", "api", "--method", "GET", "repos/dinobot-labs/dinobot/releases/tags/v1.2.3"],
		["git", "show", TAG_SHA + ":package.json"],
	]);
});

for (const bad of [
	{ GITHUB_EVENT_NAME: "pull_request" }, { GITHUB_REF: "refs/tags/v1.2.3" }, { GITHUB_REF: "refs/heads/evil" },
	{ GITHUB_REF: "refs/heads/main\n" }, { GITHUB_SHA: "abc" }, { GITHUB_SHA: "g".repeat(40) }, { GITHUB_SHA: SHA + "\n" },
	{ INPUT_TAG: "" }, { INPUT_TAG: "v1.2.3\n" }, { INPUT_TAG: "v1.2.3-rc.1" }, { INPUT_TAG: "v1.2.3+build" },
	{ INPUT_TAG: "refs/tags/v1.2.3" }, { INPUT_TAG: "v1.2.3;echo injected" }, { INPUT_TAG: "v1.2.3^{commit}" },
]) test("select rejects untrusted inputs before subprocess: " + JSON.stringify(bad), async () => {
	const fixture = commands();
	await expect(selectRelease({ ...dispatch, ...bad }, fixture.command)).rejects.toThrow();
	expect(fixture.calls).toHaveLength(0);
});

test("missing dispatch tag and push events reject", async () => {
	await expect(selectRelease({ ...push, GITHUB_EVENT_NAME: "workflow_dispatch" }, commands().command)).rejects.toThrow();
	await expect(selectRelease({ ...push, INPUT_TAG: TAG }, commands().command)).rejects.toThrow();
});

for (const event of [dispatch, releaseEvent])
for (const fail of ["rev-parse", "merge-base", "api", "show"])
	test(event.GITHUB_EVENT_NAME + " fails closed on missing tag/not ancestor/API/source error: " + fail, async () => {
		await expect(selectRelease(event, commands({ fail }).command)).rejects.toThrow();
	});

for (const event of [dispatch, releaseEvent])
for (const release of [null, {}, { ...published, tag_name: "v1.2.4" }, { ...published, draft: true },
	{ ...published, prerelease: true }, { ...published, published_at: null }, { ...published, published_at: "garbage" },
	{ ...published, draft: "false" }, { ...published, prerelease: undefined }])
	test(event.GITHUB_EVENT_NAME + " rejects untrusted release " + JSON.stringify(release), async () => {
		await expect(selectRelease(event, commands({ release }).command)).rejects.toThrow();
	});

for (const event of [dispatch, releaseEvent])
for (const pkg of [null, {}, { ...source, name: "other" }, { ...source, private: false }, { ...source, private: "true" },
	{ ...source, version: "1.2.4" }, { ...source, version: "1.2.3+build" }, { ...source, version: "1.2.3-rc.1" }])
	test(event.GITHUB_EVENT_NAME + " rejects wrong package/version before build " + JSON.stringify(pkg), async () => {
		await expect(selectRelease(event, commands({ pkg }).command)).rejects.toThrow();
	});

test("select rejects malformed JSON and multiline git SHA output", async () => {
	await expect(selectRelease(dispatch, async (argv) => ({ exitCode: 0, stdout: argv[1] === "rev-parse" ? TAG_SHA : "invalid json" }))).rejects.toThrow();
	await expect(selectRelease(dispatch, commands({ sha: TAG_SHA + "\nforged=value" }).command)).rejects.toThrow();
});

test("verify-tag checks SHA binding and tag-version string without publishing", async () => {
	const fixture = commands();
	await verifyTag(verifyEnv, fixture.command);
	expect(fixture.calls).toEqual([["git", "rev-parse", "--verify", "refs/tags/v1.2.3^{commit}"]]);
	for (const bad of [{ RELEASE_TAG: "v1.2.4" }, { EXPECTED_VERSION: "1.2.3+build" }, { EXPECTED_SHA: "short" }, { EXPECTED_SHA: SHA }]) {
		await expect(verifyTag({ ...verifyEnv, ...bad }, fixture.command)).rejects.toThrow();
	}
	await expect(verifyTag(verifyEnv, commands({ fail: "rev-parse" }).command)).rejects.toThrow();
});

test("CLI writes only validated success outputs once and never writes on failures", async () => {
	const writes: [string, string][] = [];
	const appendOutput = async (path: string, content: string) => { writes.push([path, content]); };
	const env = { ...releaseEvent, GITHUB_OUTPUT: "output" };
	await runReleaseCli(["select"], env, { command: commands().command, appendOutput });
	expect(writes).toEqual([["output", "source_sha=" + TAG_SHA + "\nversion=1.2.3\ntag=" + TAG + "\n"]]);
	await runReleaseCli(["verify-tag"], verifyEnv, { command: commands().command, appendOutput });
	expect(writes).toHaveLength(1);
	for (const argv of [[], ["publish"], ["select", "extra"], ["preflight", "artifact.tgz"]])
		await expect(runReleaseCli(argv, env, { appendOutput })).rejects.toThrow();
	await expect(runReleaseCli(["select"], {}, { appendOutput })).rejects.toThrow();
	await expect(runReleaseCli(["select"], env, { command: commands({ fail: "show" }).command, appendOutput })).rejects.toThrow();
	expect(writes).toHaveLength(1);
});

test("workflow output prevents key/value newline injection", () => {
	for (const value of ["1.2.3\nother=yes", "1.2.3\r", "\0", "\u2028", "\u2029"])
		expect(() => formatGithubOutput({ version: value })).toThrow();
	expect(() => formatGithubOutput({ "version\n": "1.2.3" })).toThrow();
});

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
for (const annotated of [false, true])
test("real detached Git checkout selects " + (annotated ? "annotated" : "lightweight") + " release tag", async () => {
	const dir = await mkdtemp(join(tmpdir(), "dinobot-release-git-"));
	dirs.push(dir);
	const git = async (...args: string[]) => {
		const result = await runReleaseCommand(["git", "-C", dir, ...args]);
		expect(result.exitCode).toBe(0);
		return result.stdout.trim();
	};
	await git("init", "--initial-branch=main");
	await writeFile(join(dir, "package.json"), JSON.stringify(source));
	await git("add", "package.json");
	await git("-c", "user.name=roach", "-c", "user.email=dev0jsh@gmail.com", "commit", "-m", "fixture", "--no-gpg-sign");
	const sha = await git("rev-parse", "HEAD");
	await git("update-ref", "refs/remotes/origin/main", sha);
	await git("-c", "user.name=roach", "-c", "user.email=dev0jsh@gmail.com", "-c", "tag.gpgSign=false", "tag", ...(annotated ? ["-a", TAG, "-m", "release"] : [TAG]));
	await git("checkout", "--detach", TAG);
	expect(await git("rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
	// The GitHub response is a fixture; every Git operation uses the real detached repository.
	const command: ReleaseCommand = async (argv) => {
		if (argv[0] === "gh") {
			expect(argv).toEqual(["gh", "api", "--method", "GET", "repos/dinobot-labs/dinobot/releases/tags/" + TAG]);
			return { exitCode: 0, stdout: JSON.stringify(published) };
		}
		return runReleaseCommand(["git", "-C", dir, ...argv.slice(1)]);
	};
	const output = join(dir, "output");
	await runReleaseCli(["select"], { ...releaseEvent, GITHUB_SHA: sha, GITHUB_OUTPUT: output }, { command });
	expect(await readFile(output, "utf8")).toBe("source_sha=" + sha + "\nversion=" + VERSION + "\ntag=" + TAG + "\n");
	await verifyTag({ ...verifyEnv, EXPECTED_SHA: sha }, command);
});

test("actual Bun CLI rejects untrusted event metadata without outputs or leaking input", async () => {
	const dir = await mkdtemp(join(tmpdir(), "dinobot-ci-release-"));
	dirs.push(dir);
	const output = join(dir, "output");
	const env: ReleaseEnvironment = { PATH: process.env.PATH, ...releaseEvent, GITHUB_SHA: "bad\nforged=1", GITHUB_OUTPUT: output };
	const child = Bun.spawn([process.execPath, resolve("script/ci/release.ts"), "select"], { env, stdout: "pipe", stderr: "pipe" });
	expect(await child.exited).toBe(1);
	expect(await new Response(child.stdout).text()).toBe("");
	expect(await new Response(child.stderr).text()).not.toContain("forged");
	await expect(readFile(output, "utf8")).rejects.toThrow();
});
