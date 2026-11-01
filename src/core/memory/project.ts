import { realpath } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { aliasProject, type ProjectAlias } from "./project-aliases.ts";
import type { Context } from "@earendil-works/chord";
import { AgentDoc, type ConversationId, type DocumentReader } from "@earendil-works/pi-durable";

/**
 * A project is the repository a conversation works in: the main worktree root of the git repository that contains the
 * conversation's effective working directory (agent cwd resolved against the workspace root), or that directory itself
 * outside git. All worktrees of one repository therefore share one project, and so do every channel and the TUI when
 * they work in the same repository. The key is that absolute path, so it is readable in tool output.
 *
 * Owner-configured aliases preserve historical keys after a move. Canonicalize the directory before memoizing Git
 * discovery; key the cache by alias settings too. An unreadable directory has no project.
 */
const keys = new Map<string, Promise<string | undefined>>();

export function projectKeyFor(directory: string, aliases: readonly ProjectAlias[] = []): Promise<string | undefined> {
	let real: string;
	try { real = realpathSync.native(resolve(directory)); } catch { return Promise.resolve(undefined); }
	// Snapshot configuration before asynchronous discovery; no cross-bot global alias state.
	const snapshot = aliases.map((alias) => ({ ...alias }));
	const cacheKey = JSON.stringify([real, snapshot]);
	let key = keys.get(cacheKey);
	if (!key) {
		key = compute(real).then((project) => project === undefined ? undefined : aliasProject(project, snapshot));
		keys.set(cacheKey, key);
		void key.then((value) => { if (value === undefined) keys.delete(cacheKey); }, () => { keys.delete(cacheKey); });
	}
	return key;
}

async function compute(directory: string): Promise<string | undefined> {
	let real: string;
	try {
		real = await realpath(directory);
	} catch {
		return undefined;
	}
	try {
		const git = Bun.spawn(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: real, stdout: "pipe", stderr: "ignore", stdin: "ignore" });
		const [out, code] = await Promise.all([new Response(git.stdout).text(), git.exited]);
		const common = out.trim();
		if (code !== 0 || common === "") return real;
		const commonReal = await realpath(common);
		// A regular repository keeps its common dir at <root>/.git; a bare repository is its own root.
		return basename(commonReal) === ".git" ? dirname(commonReal) : commonReal;
	} catch {
		return real;
	}
}

/** The project of a conversation, from its agent cwd (default: the workspace root). */
export async function projectOf(read: DocumentReader, conversationId: ConversationId, workspaceRoot: string, context: Context, aliases: readonly ProjectAlias[] = []): Promise<string | undefined> {
	const cwd = (await read.snapshot(AgentDoc, conversationId, context))?.cwd;
	return projectKeyFor(resolve(workspaceRoot, cwd ?? "."), aliases);
}
