import { Type } from "@earendil-works/pi-ai";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { connectMcpServer, safeToolName } from "../mcp/index.ts";
import { definePlugin, type PluginTool } from "../types.ts";

/** Official install and MCP guide: per-OS CLI installers, `aside mcp`, account commands. */
export const ASIDE_DOCS = "https://docs.aside.com/help/developers";

const config = Type.Object(
	{
		/** The Aside CLI to run as `<command> mcp`. Default: `aside` on PATH, then the installers' default locations. */
		command: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);

/** Where to look for the CLI; injectable for tests. */
export type AsideLookup = {
	readonly platform: NodeJS.Platform;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly home: string;
	readonly which: (command: string) => string | null;
	readonly exists: (path: string) => boolean;
};

const hostLookup = (): AsideLookup => ({ platform: process.platform, env: process.env, home: homedir(), which: (command) => Bun.which(command), exists: existsSync });

/**
 * Where the official installers put the CLI. Windows (`install.ps1`): `%LOCALAPPDATA%\Aside\CLI\current\aside.exe`.
 * macOS and Linux (`install.sh`): a `~/.local/bin/aside` link to `~/.aside/cli/Aside CLI.app/Contents/MacOS/aside`
 * (macOS) or `~/.aside/cli/aside` (Linux). A daemon started before the install does not see the new PATH entry.
 */
export function asideInstallLocations(lookup: Pick<AsideLookup, "platform" | "env" | "home">): string[] {
	if (lookup.platform === "win32") {
		const local = lookup.env.LOCALAPPDATA ?? win32.join(lookup.home, "AppData", "Local");
		return [win32.join(local, "Aside", "CLI", "current", "aside.exe")];
	}
	const app = lookup.platform === "darwin" ? posix.join(lookup.home, ".aside", "cli", "Aside CLI.app", "Contents", "MacOS", "aside") : posix.join(lookup.home, ".aside", "cli", "aside");
	return [posix.join(lookup.home, ".local", "bin", "aside"), app];
}

/** The configured command, else `aside` on PATH, else the first installer location that exists. */
export function resolveAsideCommand(command: string | undefined, lookup: AsideLookup = hostLookup()): string {
	if (command !== undefined) return command;
	const onPath = lookup.which("aside");
	if (onPath) return onPath;
	const locations = asideInstallLocations(lookup);
	const found = locations.find((path) => lookup.exists(path));
	if (found !== undefined) return found;
	throw new Error(
		`Aside CLI not found (looked on PATH and at ${locations.join(", ")}). Install it from ${ASIDE_DOCS}, sign in (\`aside account status\`), or set plugins.aside.command.`,
	);
}

const PROMPT = [
	"Aside tools (aside_*) drive the user's own Aside browser, signed in to their real accounts.",
	"- aside_repl runs Playwright-style JavaScript in the browser for exact steps (read with snapshot, click, fill, screenshot). For the page or tab the user means, call listBrowserTabs() and attach to it before opening a new tab.",
	"- aside_exec hands a whole task to Aside's own browser agent and spends the user's Aside credits; prefer aside_repl when you can do the steps yourself.",
	"- These are the user's real logins: confirm before purchases, sending messages, posting or deleting unless the user asked for exactly that.",
].join("\n");

export type AsideTestHooks = {
	readonly lookup?: AsideLookup;
	/** Arguments instead of `["mcp"]` (tests run a fixture server). */
	readonly args?: readonly string[];
};

export function createAsidePlugin(hooks: AsideTestHooks = {}) {
	return definePlugin({
		id: "aside",
		config,
		load: async ({ command }) => {
			const resolved = resolveAsideCommand(command, hooks.lookup);
			let connected: { client: Client; tools: PluginTool[] };
			try {
				connected = await connectMcpServer("aside", { command: resolved, args: [...(hooks.args ?? ["mcp"])] }, safeToolName);
			} catch (error) {
				throw new Error(`could not start \`${resolved} mcp\` (${error instanceof Error ? error.message : String(error)}). See ${ASIDE_DOCS}.`);
			}
			return { tools: connected.tools, prompt: PROMPT, close: async () => connected.client.close() };
		},
	});
}

export const asidePlugin = createAsidePlugin();
