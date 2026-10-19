import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultManifestPath, ensureDefaultManifest } from "../src/cli/default-manifest.ts";
import { loadManifest } from "../src/manifest.ts";
import { channelCatalog } from "../src/channels/index.ts";
import { pluginCatalog } from "../src/plugins/index.ts";

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
const home = async () => { const d = await mkdtemp(join(tmpdir(), "dinobot-first-run-")); dirs.push(d); return d; };

test("first run creates a valid manifest with absolute data dir and the TUI api", async () => {
	const h = await home();
	const { path, created } = await ensureDefaultManifest(h);
	expect(created).toBe(true);
	expect(path).toBe(join(h, ".config", "dinobot", "dinobot.yaml"));
	const manifest = await loadManifest(path, { channels: channelCatalog, plugins: pluginCatalog });
	expect(manifest.enabled).toBe(true);
	expect(manifest.dataDir).toBe(join(h, ".local", "share", "dinobot"));
	expect(manifest.api).toEqual({ port: 8786 });
	expect(manifest.channels).toEqual([]);
	// Web search needs no configuration (ADR 0058), and image generation borrows the ChatGPT login (ADR 0088):
	// the first-run manifest already offers both.
	expect(manifest.plugins.map((plugin) => plugin.id)).toEqual(["image_gen", "web", "skills"]);
	expect(manifest.plugins.flatMap((plugin) => plugin.tools.map((tool) => tool.name))).toEqual(["image_gen_generate", "web_search"]);
});

test("an existing manifest is never overwritten", async () => {
	const h = await home();
	await mkdir(join(h, ".config", "dinobot"), { recursive: true });
	await writeFile(defaultManifestPath(h), "mine\n");
	expect((await ensureDefaultManifest(h)).created).toBe(false);
	expect(await readFile(defaultManifestPath(h), "utf8")).toBe("mine\n");
});

test("concurrent first runs create the file once", async () => {
	const h = await home();
	const results = await Promise.all([1, 2, 3, 4].map(() => ensureDefaultManifest(h)));
	expect(results.filter((r) => r.created).length).toBe(1);
});

test("the CLI no longer refuses to start without configuration", async () => {
	const h = await home();
	// "serve" in a fresh HOME: read stderr only until the first-run notice, then stop the process
	// (it may be binding the default port or failing on it; neither matters here).
	const child = Bun.spawn([process.execPath, "--no-env-file", resolve("src/main.ts"), "serve"], { cwd: h, env: { HOME: h, PATH: process.env.PATH ?? "" }, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
	const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
	let err = "";
	const decoder = new TextDecoder();
	for await (const chunk of child.stderr) { err += decoder.decode(chunk); if (err.includes("created ") || err.includes("no manifest found")) break; }
	child.kill("SIGKILL"); await child.exited; clearTimeout(timer);
	expect(err).toContain("created " + defaultManifestPath(h));
	expect(err).not.toContain("no manifest found");
	expect(await readFile(defaultManifestPath(h), "utf8")).toContain("dataDir");
});
