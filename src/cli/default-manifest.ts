import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Where a first run writes its manifest when none exists: the last entry of the lookup order. */
export function defaultManifestPath(home: string): string {
	return join(home, ".config", "dinobot", "dinobot.yaml");
}

/** A local single-user setup: the TUI's loopback API only, data under ~/.local/share/dinobot. Models are added with /login. */
export function defaultManifest(home: string): string {
	return [
		"# Created by the first dinobot run. Edit freely; see `dinobot --help` for the lookup order.",
		"bot:",
		"  enabled: true",
		`  dataDir: ${JSON.stringify(join(home, ".local", "share", "dinobot"))}`,
		"  model:",
		"    provider: anthropic",
		"    modelId: claude-sonnet-4-6",
		"  toolMode: codemode-only",
		"api:                # loopback client API for `dinobot tui`",
		"  port: 8786",
		"channels: {}",
		"plugins: {}         # web search is on by default; `web: false` turns it off",
		"",
	].join("\n");
}

/** Create the default manifest unless one already exists; never overwrites. Returns its path and whether it was created. */
export async function ensureDefaultManifest(home: string): Promise<{ path: string; created: boolean }> {
	const path = defaultManifestPath(home);
	if (existsSync(path)) return { path, created: false };
	await mkdir(dirname(path), { recursive: true });
	try {
		await writeFile(path, defaultManifest(home), { flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		return { path, created: false }; // a concurrent first run won
	}
	return { path, created: true };
}
