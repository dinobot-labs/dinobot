import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Value } from "typebox/value";
import { defaultManifest } from "../src/cli/default-manifest.ts";
import { parseManifest } from "../src/manifest.ts";
import { channelCatalog, TelegramConfigSchema } from "../src/channels/index.ts";
import { pluginCatalog } from "../src/plugins/index.ts";
import { editManifestEntry, ManifestEditError, type ManifestSection } from "../src/setup/manifest-edit.ts";

const HOME = "/home/someone";
const DEFAULT = defaultManifest(HOME);
const EXAMPLE = readFileSync(fileURLToPath(new URL("./fixtures/manifest-edit.example.yaml", import.meta.url)), "utf8");
const TELEGRAM = { mode: "polling", botTokenFile: "/x/t.token", pairingPath: "/x/p.json", databasePath: "/x/i.sqlite", port: 0 };
const catalogs = { channels: channelCatalog, plugins: pluginCatalog };

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

const commentLines = (text: string) => text.split("\n").filter((line) => line.trim().startsWith("#"));
/** `sub` is a subsequence of `full`. */
const keepsInOrder = (full: readonly string[], sub: readonly string[]) => {
	let cursor = 0;
	for (const line of full) if (cursor < sub.length && line === sub[cursor]) cursor++;
	return cursor === sub.length;
};
const parse = (text: string) => Bun.YAML.parse(text) as Record<string, any>;
const withEntry = (text: string, section: ManifestSection, key: string, value: unknown) => {
	const doc = structuredClone(parse(text));
	const entries = { ...(doc[section] ?? {}) };
	if (value === undefined) delete entries[key];
	else entries[key] = value;
	doc[section] = entries;
	return doc;
};

describe("default manifest", () => {
	test("(a) adding a channel to `channels: {}` converts it to block form", () => {
		const result = editManifestEntry(DEFAULT, "channels", "telegram", TELEGRAM);
		expect(result).toBe(DEFAULT.replace("channels: {}\n", [
			"channels:",
			"  telegram:",
			'    mode: "polling"',
			'    botTokenFile: "/x/t.token"',
			'    pairingPath: "/x/p.json"',
			'    databasePath: "/x/i.sqlite"',
			"    port: 0",
			"",
		].join("\n")));
		expect(parse(result)).toEqual(withEntry(DEFAULT, "channels", "telegram", TELEGRAM));
		expect(keepsInOrder(commentLines(result), commentLines(DEFAULT))).toBe(true);
		// The channel config itself is schema-valid (create() would read the token file, so only the schema is checked here).
		expect(Value.Check(TelegramConfigSchema, parse(result).channels.telegram)).toBe(true);
	});

	test("(a) adding a plugin keeps the comment on the section line, and the manifest still loads", async () => {
		const result = editManifestEntry(DEFAULT, "plugins", "computer", {});
		expect(result).toBe(DEFAULT.replace(
			"plugins: {}         # web search is on by default; `web: false` turns it off\n",
			"plugins:         # web search is on by default; `web: false` turns it off\n  computer: {}\n",
		));
		const manifest = await parseManifest(parse(result), catalogs);
		expect(manifest.plugins.map((plugin) => plugin.id)).toEqual(["computer", "image_gen", "web", "skills"]);
		for (const plugin of manifest.plugins) await plugin.close?.();
	});

	test("the edited default manifest with a real telegram channel loads", async () => {
		const dir = await mkdtemp(join(tmpdir(), "dinobot-manifest-edit-"));
		dirs.push(dir);
		const token = join(dir, "t.token");
		const pairing = join(dir, "p.json");
		await writeFile(token, "123456:abcDEF_-x\n", { mode: 0o600 });
		await writeFile(pairing, JSON.stringify({ botId: "123456", userId: "42", chatIds: ["42"] }), { mode: 0o600 });
		await chmod(token, 0o600);
		await chmod(pairing, 0o600);
		const config = { mode: "polling", botTokenFile: token, pairingPath: pairing, databasePath: join(dir, "i.sqlite") };
		const result = editManifestEntry(DEFAULT, "channels", "telegram", config);
		const manifest = await parseManifest(parse(result), catalogs);
		expect(manifest.channels.length).toBe(1);
		for (const plugin of manifest.plugins) await plugin.close?.();
	});

	test("(d) removing the only entry restores `{}` and the original bytes", () => {
		const added = editManifestEntry(DEFAULT, "plugins", "computer", {});
		expect(editManifestEntry(added, "plugins", "computer", undefined)).toBe(DEFAULT);
		const telegram = editManifestEntry(DEFAULT, "channels", "telegram", TELEGRAM);
		expect(editManifestEntry(telegram, "channels", "telegram", undefined)).toBe(DEFAULT);
	});

	test("(f) `web: false` is an ordinary entry: add, replace, remove", () => {
		const off = editManifestEntry(DEFAULT, "plugins", "web", false);
		expect(off).toContain("plugins:         # web search is on by default; `web: false` turns it off\n  web: false\n");
		const both = editManifestEntry(off, "plugins", "computer", { channels: ["tui", "telegram"] });
		expect(both).toContain("  web: false\n  computer:\n    channels: [\"tui\", \"telegram\"]\n");
		const tuned = editManifestEntry(both, "plugins", "web", { engines: ["duckduckgo"], timeoutSeconds: 30 });
		expect(tuned).toContain("  web:\n    engines: [\"duckduckgo\"]\n    timeoutSeconds: 30\n  computer:\n");
		expect(parse(tuned).plugins).toEqual({ web: { engines: ["duckduckgo"], timeoutSeconds: 30 }, computer: { channels: ["tui", "telegram"] } });
		const removed = editManifestEntry(tuned, "plugins", "web", undefined);
		expect(parse(removed).plugins).toEqual({ computer: { channels: ["tui", "telegram"] } });
		expect(editManifestEntry(removed, "plugins", "computer", undefined)).toBe(DEFAULT);
	});

	test("removing an absent entry is a no-op", () => {
		expect(editManifestEntry(DEFAULT, "channels", "telegram", undefined)).toBe(DEFAULT);
	});
});

test("public deployment example remains LF and supports lossless plugin edits", () => {
	const example = readFileSync(fileURLToPath(new URL("../dinobot.example.yaml", import.meta.url)), "utf8");
	expect(example).not.toContain("\r");
	const added = editManifestEntry(example, "plugins", "computer", {});
	expect(parse(added)).toEqual(withEntry(example, "plugins", "computer", {}));
	expect(editManifestEntry(added, "plugins", "computer", undefined)).toBe(example);
});

describe("example manifest", () => {
	const exampleComments = commentLines(EXAMPLE);

	test("(b) a new channel goes right after the last real entry, before the commented-out examples", () => {
		const result = editManifestEntry(EXAMPLE, "channels", "telegram", TELEGRAM);
		const block = [
			"  telegram:",
			'    mode: "polling"',
			'    botTokenFile: "/x/t.token"',
			'    pairingPath: "/x/p.json"',
			'    databasePath: "/x/i.sqlite"',
			"    port: 0",
		].join("\n");
		const anchor = "    port: 8787                 # loopback-only; never expose as a public unauthenticated gateway\n";
		expect(result).toBe(EXAMPLE.replace(anchor, anchor + block + "\n"));
		expect(result).toContain(block + "\n  # Telegram easy setup");
		expect(parse(result)).toEqual(withEntry(EXAMPLE, "channels", "telegram", TELEGRAM));
		expect(keepsInOrder(commentLines(result), exampleComments)).toBe(true);
	});

	test("(a) adding a plugin to the example's `plugins: {}` keeps the long comment", () => {
		const result = editManifestEntry(EXAMPLE, "plugins", "computer", {});
		expect(result).toContain("\nplugins:                     # extra plugin config; built-in skills are always included, web search and image generation are on unless `web: false` / `image_gen: false`\n  computer: {}\n\n# Skill research");
		expect(parse(result)).toEqual(withEntry(EXAMPLE, "plugins", "computer", {}));
		expect(keepsInOrder(commentLines(result), exampleComments)).toBe(true);
	});

	test("(c) replacing an entry swaps only its block", () => {
		const result = editManifestEntry(EXAMPLE, "channels", "http", { port: 9000 });
		expect(result).toBe(EXAMPLE.replace("  http:\n    port: 8787                 # loopback-only; never expose as a public unauthenticated gateway\n", "  http:\n    port: 9000\n"));
		expect(parse(result).channels).toEqual({ http: { port: 9000 } });
		expect(keepsInOrder(commentLines(result), exampleComments)).toBe(true);
	});

	test("(d) removing the last real channel leaves `channels: {}` with its comment and the commented examples", () => {
		const result = editManifestEntry(EXAMPLE, "channels", "http", undefined);
		expect(result).toContain("\nchannels: {}                       # one or more of the channels this build contains\n  # Telegram easy setup");
		expect(parse(result)).toEqual(withEntry(EXAMPLE, "channels", "http", undefined));
		expect(keepsInOrder(commentLines(result), exampleComments)).toBe(true);
		// ...and adding again converts back to block form.
		const again = editManifestEntry(result, "channels", "http", { port: 8787 });
		expect(parse(again)).toEqual(parse(EXAMPLE));
		expect(keepsInOrder(commentLines(again), exampleComments)).toBe(true);
	});

	test("(b) with two entries, the new one goes after the second; removing the first keeps the rest", () => {
		const two = editManifestEntry(EXAMPLE, "channels", "telegram", TELEGRAM);
		const three = editManifestEntry(two, "channels", "discord", { port: 1 });
		const lines = three.split("\n");
		expect(lines.indexOf("  discord:")).toBe(lines.indexOf("    port: 0") + 1);
		const removed = editManifestEntry(three, "channels", "http", undefined);
		expect(parse(removed).channels).toEqual({ telegram: TELEGRAM, discord: { port: 1 } });
		expect(removed.startsWith(EXAMPLE.slice(0, EXAMPLE.indexOf("  http:\n")) + "  telegram:\n")).toBe(true);
	});
});

describe("structure", () => {
	test("(e) a missing section is appended at the end", () => {
		const base = "bot:\n  enabled: true\n# trailing comment";
		const result = editManifestEntry(base, "plugins", "computer", { channels: ["tui"] });
		expect(result).toBe(base + "\nplugins:\n  computer:\n    channels: [\"tui\"]\n");
		expect(editManifestEntry("bot:\n  enabled: true\n", "channels", "http", { port: 1 })).toBe("bot:\n  enabled: true\nchannels:\n  http:\n    port: 1\n");
		expect(editManifestEntry("", "channels", "http", { port: 1 })).toBe("channels:\n  http:\n    port: 1\n");
	});

	test("block section with only comments: insert right after the section line", () => {
		const base = "channels:   # c\n  # http:\n  #   port: 1\nplugins: {}\n";
		const result = editManifestEntry(base, "channels", "http", { port: 2 });
		expect(result).toBe("channels:   # c\n  http:\n    port: 2\n  # http:\n  #   port: 1\nplugins: {}\n");
	});

	test("child indentation is detected from the first child", () => {
		const base = "plugins:\n    web: false\n    # note\nbot: 1\n";
		expect(editManifestEntry(base, "plugins", "computer", { channels: ["*"] })).toBe("plugins:\n    web: false\n    computer:\n      channels: [\"*\"]\n    # note\nbot: 1\n");
	});

	test("entry blocks include deeper comments and blank lines but not trailing blanks", () => {
		const base = "channels:\n  http:\n    # inner\n\n    port: 1\n\n  # outer\n  slack:\n    x: 1\n";
		const result = editManifestEntry(base, "channels", "http", { port: 2 });
		expect(result).toBe("channels:\n  http:\n    port: 2\n\n  # outer\n  slack:\n    x: 1\n");
	});

	test("only top-level keys match; same-named nested keys are untouched", () => {
		const base = "bot:\n  channels: {}\n  plugins:\n    computer: {}\napi:\n  http:\n    port: 1\nchannels:\n  http:\n    port: 2\nplugins: {}\n";
		const replaced = editManifestEntry(base, "channels", "http", { port: 3 });
		expect(replaced).toBe(base.replace("channels:\n  http:\n    port: 2", "channels:\n  http:\n    port: 3"));
		const computer = editManifestEntry(base, "plugins", "computer", { channels: ["tui"] });
		expect(parse(computer).bot.plugins).toEqual({ computer: {} });
		expect(parse(computer).plugins).toEqual({ computer: { channels: ["tui"] } });
	});

	test("keys and strings are quoted when needed", () => {
		const value = { "weird key": "a # not comment: \"q\" 'x'\nline2", n: -1.5e-7, t: true, z: null, nested: { deep: [1, "two", { three: 3 }] }, empty: {}, list: [] };
		const result = editManifestEntry("channels: {}\n", "channels", "my key", value);
		expect(parse(result).channels).toEqual({ "my key": value });
		expect(result).toContain('  "my key":\n    "weird key": ');
		const reserved = editManifestEntry("plugins: {}\n", "plugins", "null", true);
		expect(parse(reserved).plugins).toEqual({ null: true });
		expect(reserved).toBe('plugins:\n  "null": true\n');
	});

	test("quoted existing keys are recognized", () => {
		const base = "channels:\n  \"http\":\n    port: 1\n  'x y': 2\n";
		expect(editManifestEntry(base, "channels", "x y", undefined)).toBe("channels:\n  \"http\":\n    port: 1\n");
		expect(editManifestEntry(base, "channels", "http", { port: 5 })).toBe("channels:\n  http:\n    port: 5\n  'x y': 2\n");
	});

	const rejects = (text: string, section: ManifestSection = "channels", key = "http", value: unknown = { port: 1 }) => {
		expect(() => editManifestEntry(text, section, key, value)).toThrow(ManifestEditError);
	};

	test("unsupported inputs throw ManifestEditError", () => {
		rejects("channels:\n\thttp:\n\t\tport: 1\n"); // tab indentation
		rejects("bot:\n\tenabled: true\nchannels: {}\n"); // tabs anywhere in indentation
		rejects("channels: {a: 1}\n"); // flow mapping with content
		rejects("channels: {}\n---\nplugins: {}\n"); // multiple documents
		rejects("---\nchannels: {}\n");
		rejects("channels: 5\n"); // scalar
		rejects("channels: telegram\n");
		rejects("channels:\n  - http\n"); // sequence
		rejects("channels: {}\r\nplugins: {}\r\n"); // CRLF
		rejects("base: &b\n  port: 1\nchannels:\n  http: *b\n"); // alias inside the section
		rejects("channels:\n  http: &h\n    port: 1\n"); // anchor inside the section
		rejects("channels:\n  http: !!map\n    port: 1\n"); // tag inside the section
		rejects("channels: &c {}\n");
		rejects("channels: {}\nchannels: {}\n"); // duplicate section
		rejects("channels:\n  http: 1\n  http: 2\n"); // duplicate entry
		rejects("{channels: {}}\n"); // flow root
		rejects("- a\n- b\n"); // non-mapping root
		rejects("channels: {}\n", "channels", "__proto__");
		rejects("channels: {}\n", "channels", "x", { n: Number.NaN });
		rejects("channels: {}\n", "channels", "x", { f: () => 1 });
		rejects("channels: {}\n", "channels", "x", { d: new Date(0) });
		rejects("channels: {}\n", "channels", "x", { u: undefined });
		rejects("channels: {}\n", "channels", "", {});
		rejects("channels: [\n", "channels"); // invalid YAML
	});
});

/** Deterministic PRNG (mulberry32). */
function rng(seed: number) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

describe("randomized edit sequences", () => {
	const KEYS = ["telegram", "http", "discord", "slack", "computer", "web", "github", "mcp", "skills", "weird key", "x-1", "true", "a:b", "#hash"];
	const STRINGS = ["", "plain", "with # hash", "colon: space", "\"quoted\"", "'single'", "multi\nline", "tab\there", "유니코드 ✓", "- dash", "*star", "&amp", "!bang", "{}", "[]", "null", "true", "0x10", "  spaced  "];

	const generate = (next: () => number, depth: number): unknown => {
		const pick = <T>(items: readonly T[]) => items[Math.floor(next() * items.length)]!;
		const roll = next();
		if (depth > 0 && roll < 0.35) {
			const out: Record<string, unknown> = {};
			const count = Math.floor(next() * 4);
			for (let index = 0; index < count; index++) out[pick(KEYS)] = generate(next, depth - 1);
			return out;
		}
		if (depth > 0 && roll < 0.5) return Array.from({ length: Math.floor(next() * 3) }, () => generate(next, depth - 1));
		if (roll < 0.7) return pick(STRINGS);
		if (roll < 0.8) return pick([0, -1, 3.25, 1e21, 65535, -0]);
		if (roll < 0.9) return next() < 0.5;
		return null;
	};

	for (const [name, original] of [["default", DEFAULT], ["example", EXAMPLE]] as const) {
		test(`every intermediate result of random edits on the ${name} manifest is correct`, () => {
			const originalComments = commentLines(original);
			for (let seed = 1; seed <= 25; seed++) {
				const next = rng(seed * 7919);
				let text = original;
				let model = structuredClone(parse(original));
				for (let step = 0; step < 12; step++) {
					const section: ManifestSection = next() < 0.5 ? "channels" : "plugins";
					const key = KEYS[Math.floor(next() * KEYS.length)]!;
					const value = next() < 0.3 ? undefined : generate(next, 3);
					text = editManifestEntry(text, section, key, value);
					const entries = { ...(model[section] ?? {}) };
					if (value === undefined) delete entries[key];
					else entries[key] = value;
					model = { ...model, [section]: entries };
					const parsed = parse(text);
					// A section that was emptied may read back as {} where the model has {} too.
					expect(parsed).toEqual(model);
					expect(Bun.deepEquals(parsed, model, true)).toBe(true);
					// No original comment line lives inside an entry block of these manifests, so all of them survive.
					expect(keepsInOrder(commentLines(text), originalComments)).toBe(true);
				}
			}
		});
	}
});
