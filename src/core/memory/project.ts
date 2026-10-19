import { realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { Context } from "@earendil-works/chord";
import { AgentDoc, type ConversationId, type DocumentReader } from "@earendil-works/pi-durable";

/**
 * A project is the repository a conversation works in: the main worktree root of the git repository that contains the
 * conversation's effective working directory (agent cwd resolved against the workspace root), or that directory itself
 * outside git. All worktrees of one repository therefore share one project, and so do every channel and the TUI when
 * they work in the same repository. The key is that absolute path, so it is readable in tool output.
 *
 * The key is a function of the directory only, recomputed on demand and memoized per process; an unreadable directory
 * has no project.
 */
const keys = new Map<string, Promise<string | undefined>>();

export function projectKeyFor(directory: string): Promise<string | undefined> {
	const absolute = resolve(directory);
	let key = keys.get(absolute);
	if (!key) {
		key = compute(absolute);
		keys.set(absolute, key);
		// A missing directory may appear later; do not memoize the failure.
		void key.then((value) => { if (value === undefined) keys.delete(absolute); });
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
export async function projectOf(read: DocumentReader, conversationId: ConversationId, workspaceRoot: string, context: Context): Promise<string | undefined> {
	const cwd = (await read.snapshot(AgentDoc, conversationId, context))?.cwd;
	return projectKeyFor(resolve(workspaceRoot, cwd ?? "."));
}
