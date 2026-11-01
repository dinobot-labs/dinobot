import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { memoryConfig } from "../src/core/memory/config.ts";
import { projectAliasProblems } from "../src/core/memory/project-aliases.ts";
import { find, mutate, type MemoryState } from "../src/core/memory/store.ts";
import { addAgreement, visibleAgreements, type AgreementsState } from "../src/core/memory/agreements.ts";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { projectKeyFor } from "../src/core/memory/project.ts";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function directory() {
	const dir = await realpath(await mkdtemp(join(tmpdir(), "dinobot-project-")));
	dirs.push(dir);
	return dir;
}
async function git(cwd: string, ...args: string[]) {
	const child = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
	if (await child.exited !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(child.stderr).text()}`);
}

test("a repository, its subdirectories and its linked worktrees share one project: the main worktree root", async () => {
	const base = await directory();
	const repo = join(base, "repo");
	await mkdir(join(repo, "src", "deep"), { recursive: true });
	await git(repo, "init", "-q");
	await git(repo, "commit", "-q", "--allow-empty", "-m", "init");
	await git(repo, "worktree", "add", "-q", join(base, "wt"));
	expect(await projectKeyFor(repo)).toBe(repo);
	expect(await projectKeyFor(join(repo, "src", "deep"))).toBe(repo);
	expect(await projectKeyFor(join(base, "wt"))).toBe(repo);
});

test("outside git the directory itself is the project; a missing directory has none and is not memoized", async () => {
	const base = await directory();
	const plain = join(base, "plain");
	await mkdir(plain);
	expect(await projectKeyFor(plain)).toBe(plain);
	const later = join(base, "later");
	expect(await projectKeyFor(later)).toBeUndefined();
	await mkdir(later);
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(await projectKeyFor(later)).toBe(later);
});

test("a moved repository and old junction retain pre-move memory and agreements; worktrees and prefix siblings stay isolated", async () => {
	const base = await directory();
	const old = join(base, "old"), moved = join(base, "moved"), sibling = join(base, "moved-other");
	await mkdir(join(old, "src"), { recursive: true });
	await mkdir(sibling);
	await git(old, "init", "-q");
	await git(old, "commit", "-q", "--allow-empty", "-m", "init");
	const before = (await projectKeyFor(old))!;
	const memory: MemoryState = { entries: [], revision: 0 };
	const agreements: AgreementsState = { revision: 0, items: [], forgotten: [] };
	mutate(memory, "fact", before, "preserved");
	addAgreement(agreements, { kind: "preference", scope: "project", project: before, text: "Preserve identity.", origin: "human", now: 1 }, { maxActivePerProject: 20, maxActiveTeam: 10, escalateAfterViolations: 3 });
	await rename(old, moved);
	await symlink(moved, old, process.platform === "win32" ? "junction" : "dir");
	await git(moved, "worktree", "add", "-q", join(base, "wt"));
	const aliases = [{ path: moved, identity: before }];
	for (const cwd of [old, moved, join(old, "src"), join(moved, "src"), join(base, "wt")]) {
		const key = await projectKeyFor(cwd, aliases);
		expect(key).toBe(before);
		expect(find(memory, "fact", key)?.content).toBe("preserved");
		expect(visibleAgreements(agreements, key)).toHaveLength(1);
	}
	const other = await projectKeyFor(sibling, aliases);
	expect(other).toBe(sibling);
	expect(find(memory, "fact", other)).toBeUndefined();
	expect(visibleAgreements(agreements, other)).toHaveLength(0);
	// Neither an earlier cached lookup nor updated mappings may retain a stale key.
	expect(await projectKeyFor(old)).toBe(moved);
	expect(await projectKeyFor(old, aliases)).toBe(before);
	expect(await projectKeyFor(old, [{ path: moved, identity: join(base, "another-history") }])).toBe(join(base, "another-history"));
	// Repository metadata cannot choose a memory key.
	await mkdir(join(sibling, ".dinobot"));
	await writeFile(join(sibling, ".dinobot", "project.json"), JSON.stringify({ identity: before }));
	expect(await projectKeyFor(sibling)).toBe(sibling);
});

test("aliases reject relative/root paths, duplicates, overlaps, chains and cycles without partial application", async () => {
	const base = await directory();
	const a = join(base, "a"), b = join(base, "b"), c = join(base, "c");
	await mkdir(a);
	const invalid = [
		[{ path: parse(a).root, identity: b }],
		[{ path: a, identity: parse(a).root }],
		[{ path: "relative", identity: b }],
		[{ path: a, identity: "relative" }],
		[{ path: a, identity: a }],
		[{ path: a, identity: b }, { path: a, identity: c }],
		[{ path: a, identity: b }, { path: join(a, "nested"), identity: c }],
		[{ path: a, identity: b }, { path: b, identity: c }],
		[{ path: a, identity: b }, { path: b, identity: a }],
	];
	for (const aliases of invalid) {
		expect(projectAliasProblems(aliases).length).toBeGreaterThan(0);
		expect(memoryConfig({ projectAliases: aliases }).problems.length).toBeGreaterThan(0);
		await expect(projectKeyFor(a, aliases)).rejects.toThrow();
	}
	const aliases = [{ path: a, identity: b }];
	expect(memoryConfig({ projectAliases: aliases }).config.projectAliases).toEqual(aliases);
	expect(memoryConfig().config.projectAliases).toBeUndefined();
});
