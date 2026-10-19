import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyResearchEdits,
	assertResearchEvaluatorUnchanged,
	type CodeExperimentSpec,
	createResearchWorktree,
	researchArtifactHash,
	researchContainedPath,
	researchPatch,
	researchRelativePath,
	runResearchProcess,
	validateCodeExperiment,
} from "../src/core/research-experiments.ts";

// Trusted-local helper tests: a Git worktree is not a hostile-code sandbox.
const directories: string[] = [];
afterEach(async () => {
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function directory() {
	const root = await mkdtemp(join(tmpdir(), "research-experiments-"));
	directories.push(root);
	return root;
}
async function git(cwd: string, ...args: string[]) {
	const command = Bun.spawn(["git", "-c", "core.hooksPath=/dev/null", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exit] = await Promise.all([
		new Response(command.stdout).text(),
		new Response(command.stderr).text(),
		command.exited,
	]);
	if (exit !== 0) throw new Error(`Fixture git ${args.join(" ")} failed: ${stderr}`);
	return stdout.trim();
}
async function fixture() {
	const root = await directory();
	await git(root, "init");
	await git(root, "config", "user.name", "Research fixture");
	await git(root, "config", "user.email", "research@example.invalid");
	await mkdir(join(root, "src"));
	await writeFile(join(root, "src/value.txt"), "base value\n");
	await writeFile(join(root, "evaluate.ts"), 'console.log("fixture evaluator");\n');
	await git(root, "add", "src/value.txt", "evaluate.ts");
	await git(root, "commit", "-m", "explicit base");
	const baseCommit = await git(root, "rev-parse", "HEAD");
	await writeFile(join(root, "src/value.txt"), "later committed value\n");
	await git(root, "commit", "-am", "later head");
	const head = await git(root, "rev-parse", "HEAD");
	await writeFile(join(root, "src/value.txt"), "user staged bytes\n");
	await git(root, "add", "src/value.txt");
	await writeFile(join(root, "src/value.txt"), "user dirty bytes\n");
	await writeFile(join(root, "user-untracked.bin"), Buffer.from([0, 255, 1, 128, 10]));
	const spec: CodeExperimentSpec = {
		baseCommit,
		allowedPaths: ["src/value.txt", "src/new.txt"],
		command: { argv: [process.execPath, "evaluate.ts"], timeoutMs: 5_000 },
		evaluatorRevision: baseCommit,
		authorityRef: "explicit-user-fixture-approval",
	};
	// Ignore helper-owned storage so original Git status can be compared exactly.
	await writeFile(join(root, ".git/info/exclude"), ".dinobot/\n");
	const destination = join(root, ".dinobot", "research", "fixture", "worktree");
	return { root, head, spec, destination };
}

test.each(["././candidate.ts", "sub/../candidate.ts"])("rejects frozen evaluator alias %s without changing scope", (arg) => {
 const spec: CodeExperimentSpec = {baseCommit:"a".repeat(40), allowedPaths:["candidate.ts"], command:{argv:[process.execPath,arg],timeoutMs:1000},evaluatorRevision:"v1",authorityRef:"fixture"};
 const before = structuredClone(spec);
 expect(() => validateCodeExperiment(spec)).toThrow("author-editable");
 expect(spec).toEqual(before);
});

test("legitimate evaluator argv remain byte-for-byte unchanged", () => {
 const spec: CodeExperimentSpec = {baseCommit:"a".repeat(40), allowedPaths:["candidate.ts"], command:{argv:[process.execPath,"././evaluator.ts","sub/../data.json","--label=candidate.ts","text with spaces"],timeoutMs:1000},evaluatorRevision:"v1",authorityRef:"fixture"};
 const before = structuredClone(spec);
 validateCodeExperiment(spec);
 expect(spec).toEqual(before);
});

test("tracked evaluator drift is rejected while allowed candidate changes stay comparable", async () => {
	const { root, spec, destination } = await fixture();
	const worktree = await createResearchWorktree(root, destination, spec);
	await applyResearchEdits(worktree, spec, [{ path: "src/value.txt", content: "authorized candidate\n" }]);
	await assertResearchEvaluatorUnchanged(worktree, spec);
	await writeFile(join(worktree, "evaluate.ts"), 'console.log("forged perfect score");\n');
	await expect(assertResearchEvaluatorUnchanged(worktree, spec)).rejects.toThrow("Tracked evaluator");
});

test("explicit-base worktree exports tracked and new-file edits without changing original staged, dirty or untracked bytes", async () => {
	const { root, head, spec, destination } = await fixture();
	const dirty = await readFile(join(root, "src/value.txt"));
	const untracked = await readFile(join(root, "user-untracked.bin"));
	const status = await git(root, "status", "--porcelain");
	const index = await readFile(join(root, ".git/index"));
	const worktree = await createResearchWorktree(root, destination, spec);
	expect(await git(worktree, "rev-parse", "HEAD")).toBe(spec.baseCommit);
	expect(await readFile(join(worktree, "src/value.txt"), "utf8")).toBe("base value\n");
	const before = await researchArtifactHash(worktree, spec);
	const after = await applyResearchEdits(worktree, spec, [
		{ path: "src/value.txt", content: "candidate value\n" },
		{ path: "src/new.txt", content: "new candidate evidence\n" },
	]);
	expect(after).not.toBe(before);
	expect(after).toBe(await researchArtifactHash(worktree, spec));
	expect(await readFile(join(worktree, "src/new.txt"), "utf8")).toBe("new candidate evidence\n");
	const patch = await researchPatch(worktree, spec);
	expect(patch).toContain("diff --git a/src/value.txt b/src/value.txt");
	expect(patch).toContain("-base value");
	expect(patch).toContain("+candidate value");
	expect(patch).toContain("diff --git a/src/new.txt b/src/new.txt");
	expect(patch).toContain("new file mode");
	expect(patch).toContain("+new candidate evidence");
	expect(patch).not.toContain("user dirty bytes");
	// Prove the exported patch is usable, not merely a plausible text receipt.
	const replay = await createResearchWorktree(root, join(root, ".dinobot", "replay"), spec);
	const patchFile = join(root, ".dinobot", "candidate.patch");
	await writeFile(patchFile, patch);
	await git(replay, "apply", patchFile);
	expect(await readFile(join(replay, "src/value.txt"), "utf8")).toBe("candidate value\n");
	expect(await readFile(join(replay, "src/new.txt"), "utf8")).toBe("new candidate evidence\n");
	expect(await readFile(join(root, "src/value.txt"))).toEqual(dirty);
	expect(await readFile(join(root, "user-untracked.bin"))).toEqual(untracked);
	expect(await readFile(join(root, ".git/index"))).toEqual(index);
	expect(await git(root, "rev-parse", "HEAD")).toBe(head);
	expect(await git(root, "status", "--porcelain")).toBe(status);
}, 30_000);

test("rejects unauthorized edits and evaluator edits before writing any candidate bytes", async () => {
	const { root, destination, spec } = await fixture();
	const worktree = await createResearchWorktree(root, destination, spec);
	const evaluator = await readFile(join(worktree, "evaluate.ts"));
	await expect(applyResearchEdits(worktree, spec, [
		{ path: "src/value.txt", content: "must not be written" },
		{ path: "evaluate.ts", content: "compromised evaluator" },
	])).rejects.toThrow("outside authorized scope");
	expect(await readFile(join(worktree, "src/value.txt"), "utf8")).toBe("base value\n");
	expect(await readFile(join(worktree, "evaluate.ts"))).toEqual(evaluator);
	for (const evaluatorArg of ["evaluate.ts", "./evaluate.ts", "././evaluate.ts", "sub/../evaluate.ts"]) {
		expect(() =>
			validateCodeExperiment({
				...spec,
				allowedPaths: ["evaluate.ts"],
				command: { ...spec.command, argv: [process.execPath, evaluatorArg] },
			})
		).toThrow("Evaluator command files cannot be author-editable");
	}
}, 30_000);

test.each([
	"../escape",
	"/absolute",
	"src/../../escape",
	"src\\escape",
	"src//file",
	"src/./file",
	".git/config",
	".dinobot/state",
	"drive:file",
	"nul\0file",
])("rejects invalid research path %j", (path) => {
	expect(() => researchRelativePath(path)).toThrow("Invalid research relative path");
});

test("rejects escaping destinations, existing worktrees and symlinked edit paths without changing their targets", async () => {
	const { root, destination, spec } = await fixture();
	const outside = await directory();
	await expect(createResearchWorktree(root, join(outside, "escape"), spec)).rejects.toThrow("escapes target");
	const worktree = await createResearchWorktree(root, destination, spec);
	await expect(createResearchWorktree(root, destination, spec)).rejects.toThrow("already exists");
	await expect(researchContainedPath(worktree, "../escape", true)).rejects.toThrow("escapes target");
	const target = join(outside, "valuable.txt");
	await writeFile(target, "outside bytes\n");
	await symlink(target, join(worktree, "src/new.txt"));
	await expect(applyResearchEdits(worktree, spec, [{ path: "src/new.txt", content: "overwrite" }])).rejects.toThrow("symlink");
	await symlink(outside, join(worktree, "linked"));
	await expect(applyResearchEdits(worktree, { ...spec, allowedPaths: ["linked/valuable.txt"] }, [
		{ path: "linked/valuable.txt", content: "overwrite" },
	])).rejects.toThrow("symlink");
	await symlink(outside, join(root, "linked-destination"));
	await expect(createResearchWorktree(root, join(root, "linked-destination", "worktree"), spec)).rejects.toThrow("symlink");
	expect(await readFile(target, "utf8")).toBe("outside bytes\n");
}, 30_000);

test("process receipts preserve cwd, argv, stdout, stderr and failed exit", async () => {
	const cwd = await directory();
	const argv = [process.execPath, "-e", 'console.log(process.cwd()); console.error("failure evidence"); process.exitCode = 7;'];
	const receipt = await runResearchProcess({ cwd, argv, timeoutMs: 5_000 });
	expect(receipt.status).toBe("failed");
	expect(receipt.exitCode).toBe(7);
	expect(receipt.stdout.trim()).toBe(cwd);
	expect(receipt.stderr).toContain("failure evidence");
	expect(receipt.argv).toEqual(argv);
	expect(receipt.cwd).toBe(cwd);
	expect(receipt.pid).toBeGreaterThan(0);
	expect(receipt.endedAt).toBeGreaterThanOrEqual(receipt.startedAt);
	const completed = await runResearchProcess({
		cwd,
		argv: [process.execPath, "-e", 'console.log("completed evidence")'],
		timeoutMs: 5_000,
	});
	expect(completed.status).toBe("completed");
	expect(completed.exitCode).toBe(0);
	expect(completed.stdout).toBe("completed evidence\n");
});

test("timeout terminates a live evaluator and returns a timeout receipt", async () => {
	const receipt = await runResearchProcess({
		cwd: await directory(),
		argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
		timeoutMs: 100,
	});
	expect(receipt.status).toBe("timeout");
	expect(receipt.exitCode).toBeNull();
	expect(receipt.pid).toBeGreaterThan(0);
}, 5_000);

test("cancellation after spawn terminates the evaluator; pre-aborted signals never spawn", async () => {
	const cwd = await directory();
	const controller = new AbortController();
	let spawned: number | undefined;
	const receipt = await runResearchProcess({
		cwd,
		argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
		timeoutMs: 5_000,
		signal: controller.signal,
		onSpawn: async (pid) => {
			spawned = pid;
			controller.abort();
		},
	});
	expect(receipt.status).toBe("cancelled");
	expect(receipt.exitCode).toBeNull();
	expect(receipt.pid).toBe(spawned!);
	let preAbortedSpawn = false;
	await expect(runResearchProcess({
		cwd,
		argv: [process.execPath, "-e", 'console.log("must not run")'],
		timeoutMs: 5_000,
		signal: controller.signal,
		onSpawn: async () => {
			preAbortedSpawn = true;
		},
	})).rejects.toThrow();
	expect(preAbortedSpawn).toBe(false);
}, 5_000);

test.each(["stdout", "stderr"] as const)("%s output is capped by actual bytes and reports output_limit", async (stream) => {
	const receipt = await runResearchProcess({
		cwd: await directory(),
		timeoutMs: 5_000,
		maxOutputBytes: 1024,
		argv: [process.execPath, "-e", `process.${stream}.write("x".repeat(65536)); setInterval(() => {}, 1000);`],
	});
	expect(receipt.status).toBe("output_limit");
	expect(receipt[stream]).toBe("x".repeat(1024));
	expect(Buffer.byteLength(receipt.stdout) + Buffer.byteLength(receipt.stderr)).toBe(1024);
	expect(receipt.exitCode).toBeNull();
}, 10_000);
