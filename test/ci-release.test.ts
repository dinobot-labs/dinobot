import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	formatGithubOutput, preflight, runReleaseCli, runReleaseCommand, selectRelease, stableReleaseVersion, verifyTag,
	type PreflightDependencies, type ReleaseCommand, type ReleaseEnvironment,
} from "../script/ci/release.ts";

const SHA = "a".repeat(40);
const TAG_SHA = "b".repeat(40);
const VERSION = "1.2.3";
const TAG = "v" + VERSION;
const source = { name: "dinobot", private: true, version: VERSION };
const published = { tag_name: TAG, draft: false, prerelease: false, published_at: "2026-01-01T00:00:00Z" };
const push = { GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main", GITHUB_SHA: SHA };
const dispatch = { ...push, GITHUB_EVENT_NAME: "workflow_dispatch", INPUT_TAG: TAG };
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

test("push chooses event SHA and source version before build, ignoring working-tree version", async () => {
	const fixture = commands({ pkg: { ...source, version: "9007199254740993.0.0" } });
	expect(await selectRelease(push, fixture.command)).toEqual({ source_sha: SHA, version: "9007199254740993.0.0", tag: "" });
	expect(fixture.calls).toEqual([["git", "show", SHA + ":package.json"]]);
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

test("missing dispatch tag rejects, and push never adopts an input tag", async () => {
	await expect(selectRelease({ ...push, GITHUB_EVENT_NAME: "workflow_dispatch" }, commands().command)).rejects.toThrow();
	expect((await selectRelease({ ...push, INPUT_TAG: TAG }, commands().command)).tag).toBe("");
});

for (const fail of ["rev-parse", "merge-base", "api", "show"])
	test("dispatch fails closed on missing tag/not ancestor/API/source error: " + fail, async () => {
		await expect(selectRelease(dispatch, commands({ fail }).command)).rejects.toThrow();
	});

for (const release of [null, {}, { ...published, tag_name: "v1.2.4" }, { ...published, draft: true },
	{ ...published, prerelease: true }, { ...published, published_at: null }, { ...published, published_at: "garbage" },
	{ ...published, draft: "false" }, { ...published, prerelease: undefined }])
	test("dispatch rejects untrusted release " + JSON.stringify(release), async () => {
		await expect(selectRelease(dispatch, commands({ release }).command)).rejects.toThrow();
	});

for (const pkg of [null, {}, { ...source, name: "other" }, { ...source, private: false }, { ...source, private: "true" },
	{ ...source, version: "1.2.4" }, { ...source, version: "1.2.3+build" }, { ...source, version: "1.2.3-rc.1" }])
	test("dispatch rejects wrong package/version before build " + JSON.stringify(pkg), async () => {
		await expect(selectRelease(dispatch, commands({ pkg }).command)).rejects.toThrow();
	});

test("select rejects malformed JSON and multiline git SHA output", async () => {
	await expect(selectRelease(push, async () => ({ exitCode: 0, stdout: "invalid json" }))).rejects.toThrow();
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

const tarball = new TextEncoder().encode("test-only tarball bytes; audit belongs to a separate helper");
const integrity = "sha512-" + createHash("sha512").update(tarball).digest("base64");
const existing = { name: "dinobot", version: VERSION, dist: { integrity } };
function registry(responses: (Response | Error)[]) {
	const calls: string[] = [];
	const deps: PreflightDependencies = {
		readTarball: async (path) => { expect(path).toBe("artifact.tgz"); return tarball; },
		timeoutMs: 100,
		fetch: async (url, init) => {
			calls.push(url);
			expect(init.method).toBe("GET");
			expect(init.redirect).toBe("error");
			expect(init.credentials).toBe("omit");
			expect(init.headers).toEqual({ accept: "application/json" });
			expect(init.signal).toBeInstanceOf(AbortSignal);
			const response = responses.shift();
			if (!response) throw new Error("Unexpected fetch");
			if (response instanceof Error) throw response;
			return response;
		},
	};
	return { deps, calls };
}
const missing = () => new Response(null, { status: 404 });

test("preflight exact hash is an idempotent skip, without looking at latest", async () => {
	const fixture = registry([Response.json(existing)]);
	expect(await preflight("artifact.tgz", VERSION, fixture.deps)).toEqual({ publish: false });
	expect(fixture.calls).toEqual(["https://registry.npmjs.org/dinobot/1.2.3"]);
});

for (const body of [null, [], {}, { ...existing, name: "other" }, { ...existing, version: "1.2.4" },
	{ ...existing, dist: {} }, { ...existing, dist: { integrity: "sha512-wrong" } }, { name: "dinobot", version: VERSION }])
	test("preflight fails closed for wrong hash/incomplete identity " + JSON.stringify(body), async () => {
		const fixture = registry([Response.json(body)]);
		await expect(preflight("artifact.tgz", VERSION, fixture.deps)).rejects.toThrow();
		expect(fixture.calls).toHaveLength(1);
	});

for (const status of [401, 403, 429, 500, 302, 204]) test("preflight HTTP " + status + " is never absence", async () => {
	const fixture = registry([new Response(null, { status })]);
	await expect(preflight("artifact.tgz", VERSION, fixture.deps)).rejects.toThrow();
	expect(fixture.calls).toHaveLength(1);
});

test("preflight rejects network failure, malformed JSON and redirected 404", async () => {
	const redirected = missing();
	Object.defineProperty(redirected, "redirected", { value: true });
	for (const response of [new Error("network failed"), new Response("not JSON"), redirected]) {
		const fixture = registry([response]);
		await expect(preflight("artifact.tgz", VERSION, fixture.deps)).rejects.toThrow();
		expect(fixture.calls).toHaveLength(1);
	}
});

test("only missing version plus valid lower latest permits publication", async () => {
	const fixture = registry([missing(), Response.json({ name: "dinobot", version: "1.2.2" })]);
	expect(await preflight("artifact.tgz", VERSION, fixture.deps)).toEqual({ publish: true });
	expect(fixture.calls).toEqual(["https://registry.npmjs.org/dinobot/1.2.3", "https://registry.npmjs.org/dinobot/latest"]);
	const huge = registry([missing(), Response.json({ name: "dinobot", version: "9007199254740992.0.0" })]);
	expect(await preflight("artifact.tgz", "9007199254740993.0.0", huge.deps)).toEqual({ publish: true });
});

for (const latest of ["1.2.3", "1.2.4", "2.0.0", "1.2.2-rc.1", "1.2.2+build", "01.2.2", "1.2.2\n", undefined])
	test("missing release rejects downgrade/equal/invalid latest " + JSON.stringify(latest), async () => {
		await expect(preflight("artifact.tgz", VERSION, registry([missing(), Response.json({ name: "dinobot", version: latest })]).deps)).rejects.toThrow();
	});

test("latest HTTP errors, missing identity, malformed JSON and network also fail closed", async () => {
	for (const response of [missing(), new Response(null, { status: 403 }), Response.json({ name: "other", version: "1.2.2" }),
		new Response("bad JSON"), new Error("offline")]) {
		await expect(preflight("artifact.tgz", VERSION, registry([missing(), response]).deps)).rejects.toThrow();
	}
});

test("deadline aborts hanging headers and JSON body, even if fetch ignores signal", async () => {
	for (const body of [false, true]) {
		let signal: AbortSignal | null | undefined;
		const started = performance.now();
		await expect(preflight("artifact.tgz", VERSION, {
			readTarball: async () => tarball, timeoutMs: 15,
			fetch: async (_, init) => {
				signal = init.signal;
				if (!body) return new Promise<Response>(() => {});
				const response = Response.json({});
				Object.defineProperty(response, "json", { value: () => new Promise(() => {}) });
				return response;
			},
		})).rejects.toThrow("timed out");
		expect(signal?.aborted).toBe(true);
		expect(performance.now() - started).toBeLessThan(1000);
	}
});

test("HTTP failure also aborts an unread response body", async () => {
	let signal: AbortSignal | null | undefined;
	await expect(preflight("artifact.tgz", VERSION, {
		readTarball: async () => tarball,
		fetch: async (_, init) => { signal = init.signal; return new Response("denied", { status: 403 }); },
	})).rejects.toThrow();
	expect(signal?.aborted).toBe(true);
});

test("invalid requested versions/read failures never fetch or authorize", async () => {
	const fixture = registry([]);
	for (const version of ["v1.2.3", "1.2.3+build", "1.2.3-rc.1", "1.2.3\n", "../latest"])
		await expect(preflight("artifact.tgz", version, fixture.deps)).rejects.toThrow();
	await expect(preflight("artifact.tgz", VERSION, { ...fixture.deps, readTarball: async () => { throw new Error("missing file"); } })).rejects.toThrow();
	expect(fixture.calls).toHaveLength(0);
});

test("CLI writes only validated success outputs once and never writes on failures", async () => {
	const writes: [string, string][] = [];
	const appendOutput = async (path: string, content: string) => { writes.push([path, content]); };
	const env = { ...push, GITHUB_OUTPUT: "output" };
	await runReleaseCli(["select"], env, { command: commands().command, appendOutput });
	expect(writes).toEqual([["output", "source_sha=" + SHA + "\nversion=1.2.3\ntag=\n"]]);
	await runReleaseCli(["verify-tag"], verifyEnv, { command: commands().command, appendOutput });
	expect(writes).toHaveLength(1);
	await runReleaseCli(["preflight", "artifact.tgz", VERSION], env, { ...registry([Response.json(existing)]).deps, appendOutput });
	expect(writes.at(-1)).toEqual(["output", "publish=false\n"]);
	await runReleaseCli(["preflight", "artifact.tgz", VERSION], env, { ...registry([missing(), Response.json({ name: "dinobot", version: "1.2.2" })]).deps, appendOutput });
	expect(writes.at(-1)).toEqual(["output", "publish=true\n"]);
	for (const argv of [[], ["publish"], ["select", "extra"], ["preflight", "artifact.tgz"]])
		await expect(runReleaseCli(argv, env, { appendOutput })).rejects.toThrow();
	await expect(runReleaseCli(["select"], {}, { appendOutput })).rejects.toThrow();
	await expect(runReleaseCli(["select"], env, { command: commands({ fail: "show" }).command, appendOutput })).rejects.toThrow();
	await expect(runReleaseCli(["preflight", "artifact.tgz", VERSION], env, { ...registry([new Response(null, { status: 403 })]).deps, appendOutput })).rejects.toThrow();
	expect(writes).toHaveLength(3);
});

test("workflow output prevents key/value newline injection", () => {
	for (const value of ["1.2.3\nother=yes", "1.2.3\r", "\0", "\u2028", "\u2029"])
		expect(() => formatGithubOutput({ version: value })).toThrow();
	expect(() => formatGithubOutput({ "version\n": "1.2.3" })).toThrow();
});

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
test("actual Bun CLI selects current immutable commit and appends GITHUB_OUTPUT without auth", async () => {
	const dir = await mkdtemp(join(tmpdir(), "dinobot-ci-release-"));
	dirs.push(dir);
	const sha = (await runReleaseCommand(["git", "rev-parse", "HEAD"])).stdout.trim();
	const pkg = JSON.parse((await runReleaseCommand(["git", "show", sha + ":package.json"])).stdout);
	const output = join(dir, "output");
	const env: ReleaseEnvironment = { PATH: process.env.PATH, GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main", GITHUB_SHA: sha, GITHUB_OUTPUT: output };
	const child = Bun.spawn([process.execPath, resolve("script/ci/release.ts"), "select"], { env, stdout: "pipe", stderr: "pipe" });
	expect(await child.exited).toBe(0);
	expect(await new Response(child.stdout).text()).toBe("");
	expect(await new Response(child.stderr).text()).toBe("");
	expect(await readFile(output, "utf8")).toBe("source_sha=" + sha + "\nversion=" + pkg.version + "\ntag=\n");
	const failed = Bun.spawn([process.execPath, resolve("script/ci/release.ts"), "select"], { env: { ...env, GITHUB_SHA: "bad\nforged=1" }, stdout: "pipe", stderr: "pipe" });
	expect(await failed.exited).toBe(1);
	expect(await new Response(failed.stderr).text()).not.toContain("forged");
	expect(await readFile(output, "utf8")).toBe("source_sha=" + sha + "\nversion=" + pkg.version + "\ntag=\n");
});
