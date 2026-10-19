import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { channelCatalog } from "../src/channels/index.ts";
import { defaultManifest } from "../src/cli/default-manifest.ts";
import { parseManifest } from "../src/manifest.ts";
import { ASIDE_DOCS, asideInstallLocations, createAsidePlugin, resolveAsideCommand, type AsideLookup } from "../src/plugins/aside/index.ts";
import { pluginCatalog } from "../src/plugins/index.ts";
import { type LoadedPlugin, loadPlugin } from "../src/plugins/types.ts";

const fixture = join(import.meta.dir, "fixtures", "mcp-server.ts");

function lookup(overrides: Partial<AsideLookup> = {}): AsideLookup {
	return { platform: "win32", env: { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, home: "C:\\Users\\u", which: () => null, exists: () => false, ...overrides };
}

const loaded: LoadedPlugin[] = [];
afterEach(async () => {
	for (const plugin of loaded.splice(0)) await plugin.close?.();
});

describe("aside CLI lookup", () => {
	test("installer locations per OS", () => {
		expect(asideInstallLocations(lookup())).toEqual(["C:\\Users\\u\\AppData\\Local\\Aside\\CLI\\current\\aside.exe"]);
		expect(asideInstallLocations(lookup({ env: {} }))).toEqual(["C:\\Users\\u\\AppData\\Local\\Aside\\CLI\\current\\aside.exe"]);
		expect(asideInstallLocations({ platform: "darwin", env: {}, home: "/Users/u" })).toEqual(["/Users/u/.local/bin/aside", "/Users/u/.aside/cli/Aside CLI.app/Contents/MacOS/aside"]);
		expect(asideInstallLocations({ platform: "linux", env: {}, home: "/home/u" })).toEqual(["/home/u/.local/bin/aside", "/home/u/.aside/cli/aside"]);
	});

	test("precedence: configured command, then PATH, then the first installer location that exists", () => {
		const everywhere = lookup({ which: () => "C:\\bin\\aside.exe", exists: () => true });
		expect(resolveAsideCommand("D:\\aside.exe", everywhere)).toBe("D:\\aside.exe");
		expect(resolveAsideCommand(undefined, everywhere)).toBe("C:\\bin\\aside.exe");
		// A daemon started before the install has no PATH entry for it: the installer location still finds it.
		expect(resolveAsideCommand(undefined, lookup({ exists: (path) => path.endsWith("aside.exe") }))).toBe("C:\\Users\\u\\AppData\\Local\\Aside\\CLI\\current\\aside.exe");
		expect(resolveAsideCommand(undefined, { platform: "darwin", env: {}, home: "/Users/u", which: () => null, exists: (path) => path.includes(".app") })).toBe(
			"/Users/u/.aside/cli/Aside CLI.app/Contents/MacOS/aside",
		);
	});

	test("not installed: loading fails with the install guide, not a spawn error", async () => {
		expect(() => resolveAsideCommand(undefined, lookup())).toThrow(ASIDE_DOCS);
		const result = await loadPlugin(createAsidePlugin({ lookup: lookup() }), {});
		expect(Array.isArray(result) && result.length === 1 && result[0]!.startsWith("plugins.aside: Aside CLI not found") && result[0]!.includes(ASIDE_DOCS)).toBe(true);
	});
});

describe("aside plugin", () => {
	test("built in but off by default (the first-run manifest does not load it); unknown keys are rejected", async () => {
		expect(pluginCatalog.aside).toBeDefined();
		expect(pluginCatalog.aside!.enabledByDefault).toBeUndefined();
		const off = await parseManifest(Bun.YAML.parse(defaultManifest("/h")), { channels: channelCatalog, plugins: { ...pluginCatalog, aside: createAsidePlugin({ lookup: lookup() }) } });
		expect(off.plugins.map((plugin) => plugin.id)).not.toContain("aside");
		const bad = await loadPlugin(createAsidePlugin({ lookup: lookup() }), { args: ["mcp"] });
		expect(Array.isArray(bad) && bad[0]!.startsWith("plugins.aside")).toBe(true);
	});

	test("connects `<cli> mcp` over stdio and exposes its tools as aside_<tool> with the browser prompt", async () => {
		const plugin = createAsidePlugin({ lookup: lookup({ which: () => process.execPath }), args: [fixture] });
		const result = await loadPlugin(plugin, {});
		if (Array.isArray(result)) throw new Error(result.join("\n"));
		loaded.push(result);
		expect(result.tools.map((tool) => tool.name)).toEqual(["aside_add"]);
		expect(await result.tools[0]!.execute({ a: 40, b: 2 }, {})).toBe("42");
		expect(result.prompt).toContain("aside_repl");
		expect(result.prompt).toContain("listBrowserTabs()");
	});

	test("a CLI that cannot start reports the command and the guide", async () => {
		const result = await loadPlugin(createAsidePlugin({ lookup: lookup() }), { command: join(import.meta.dir, "fixtures", "no-such-aside") });
		expect(Array.isArray(result) && result[0]!.includes("could not start") && result[0]!.includes(ASIDE_DOCS)).toBe(true);
	});
});
