import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
