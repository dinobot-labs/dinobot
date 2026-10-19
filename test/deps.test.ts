import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../src/cli/init.ts";
import {
	catalogDependencies, dependenciesRoot, dependencyHost, dependencyProblems, installDependency, MARKER, platformKey, resolveInstalled,
} from "../src/deps/index.ts";
import { definePlugin, type ExternalDependency, type Plugin } from "../src/plugins/types.ts";
import { CUA_DRIVER } from "../src/plugins/computer/driver.ts";
import { Type } from "@earendil-works/pi-ai";

async function zipArchive(names: string[], link = false): Promise<Uint8Array> {
	const dir = await tempDir();
	const out = join(dir, "fixture.zip");
	const script = [
		"import sys, json, zipfile",
		"with zipfile.ZipFile(sys.argv[1], 'w') as z:",
		"    for name in json.loads(sys.argv[2]):",
		"        info = zipfile.ZipInfo(name); info.create_system = 3",
		"        info.external_attr = (0o120777 if sys.argv[3] == 'true' and name == 'link' else 0o100644) << 16",
		"        z.writestr(info, 'content:' + name)",
	].join("\n");
	const result = Bun.spawnSync([process.platform === "win32" ? "python" : "python3", "-c", script, out, JSON.stringify(names), String(link)]);
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	return new Uint8Array(await readFile(out));
}

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "dinobot-deps-"));
	dirs.push(dir);
	return dir;
}

const PLATFORM = "testos-x64";
const URL = "https://downloads.example.invalid/tool.tar.gz";
const V = `1.2.3-${PLATFORM}`;

/** A tar.gz holding `tool` (prints `tool <version>`) and `share/readme`, built with the system tar. */
async function archive(version = "1.2.3", extra?: (dir: string) => Promise<void>): Promise<Uint8Array> {
	const dir = await tempDir();
	const tree = join(dir, "tree");
	await mkdir(join(tree, "share"), { recursive: true });
	await writeFile(join(tree, "tool"), `#!/bin/sh\necho "tool ${version}"\n`);
	await chmod(join(tree, "tool"), 0o644); // the installer must make the entry executable
	await writeFile(join(tree, "share", "readme"), "hi\n");
	await extra?.(tree);
	const out = join(dir, "a.tar.gz");
	const tar = Bun.spawnSync(["tar", "-czf", out, "-C", tree, "."]);
	if (tar.exitCode !== 0) throw new Error(tar.stderr.toString());
	return new Uint8Array(await readFile(out));
}

/** A tar.gz whose member names are given verbatim (python's tarfile, so `../` and links survive). */
async function craftedArchive(members: { name: string; type: "file" | "symlink" | "hardlink"; target?: string }[]): Promise<Uint8Array> {
	const dir = await tempDir();
	const out = join(dir, "crafted.tar.gz");
	const script = [
		"import io, sys, tarfile, json",
		"members = json.loads(sys.argv[2])",
		"with tarfile.open(sys.argv[1], 'w:gz') as t:",
		"    for m in members:",
		"        info = tarfile.TarInfo(m['name'])",
		"        if m['type'] in ('symlink', 'hardlink'):",
		"            info.type = tarfile.SYMTYPE if m['type'] == 'symlink' else tarfile.LNKTYPE; info.linkname = m['target']; t.addfile(info)",
		"        else:",
		"            data = b'#!/bin/sh\\necho tool 1.2.3\\n'; info.size = len(data); info.mode = 0o755; t.addfile(info, io.BytesIO(data))",
	].join("\n");
	const result = Bun.spawnSync(["python3", "-c", script, out, JSON.stringify(members)]);
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	return new Uint8Array(await readFile(out));
}

function spec(bytes: Uint8Array, overrides: Partial<ExternalDependency> = {}, artifact: Record<string, unknown> = {}): ExternalDependency {
	return {
		id: "tool", version: "1.2.3", summary: "test tool", homepage: "https://example.invalid", license: "MIT",
		artifacts: {
			[PLATFORM]: {
				url: URL, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength, format: "tar.gz", entry: "tool",
				...artifact,
			},
		},
		check: { args: ["--version"], expect: "tool 1.2.3" },
		...overrides,
	};
}

function zipSpec(bytes: Uint8Array): ExternalDependency {
	const { check: _check, ...dependency } = spec(bytes, {}, { format: "zip", entry: "tool.exe" });
	return dependency;
}

/** fetch double: serves `body` for URL (optionally in chunks with a delay) and counts requests. */
function server(body: Uint8Array, options: { stallAfter?: number; status?: number } = {}) {
	const calls: string[] = [];
	const fetchDouble = (async (input: string | URL | Request, init?: RequestInit) => {
		calls.push(String(input));
		if (options.status) return new Response("nope", { status: options.status });
		const signal = init?.signal ?? undefined;
		const stream = new ReadableStream<Uint8Array>({
			async start(controller) {
				const cut = options.stallAfter ?? body.byteLength;
				controller.enqueue(body.subarray(0, cut));
				if (cut < body.byteLength) {
					await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
					controller.error(signal?.reason ?? new Error("aborted"));
					return;
				}
				controller.close();
			},
		});
		return new Response(stream, { status: 200 });
	}) as typeof globalThis.fetch;
	return { fetch: fetchDouble, calls };
}

async function entries(path: string): Promise<string[]> {
	return (await readdir(path).catch(() => [] as string[])).sort();
}

describe("installDependency", () => {
	test("declares pinned Windows x64 and arm64 ZIPs with an exe entry", () => {
		for (const arch of ["x64", "arm64"]) {
			const artifact = CUA_DRIVER.artifacts[`win32-${arch}`];
			expect(artifact).toMatchObject({ format: "zip", entry: "cua-driver.exe" });
			expect(dependencyProblems(CUA_DRIVER)).toEqual([]);
		}
	});

	test.skipIf(process.platform !== "win32")("installs a Windows ZIP with companions and reuses it without network", async () => {
		const root = await tempDir();
		const bytes = await zipArchive(["tool.exe", "helper.exe", "sdk.dll", "nested/readme"]);
		const dependency = zipSpec(bytes);
		const { fetch, calls } = server(bytes);
		const path = join(root, "tool", V, "tool.exe");
		expect(await installDependency(dependency, { root, platform: PLATFORM, fetch })).toEqual({ status: "installed", path });
		for (const name of ["tool.exe", "helper.exe", "sdk.dll", "nested/readme"]) {
			expect(await readFile(join(root, "tool", V, name), "utf8")).toBe(`content:${name}`);
		}
		expect(await resolveInstalled(dependency, { root, platform: PLATFORM })).toBe(path);
		expect(await installDependency(dependency, { root, platform: PLATFORM, fetch })).toEqual({ status: "present", path });
		expect(calls).toHaveLength(1);
	});

	test.skipIf(process.platform !== "win32")("refuses ZIP integrity mismatches and a missing exe without publishing", async () => {
		const bytes = await zipArchive(["tool.exe", "sdk.dll"]);
		for (const [override, message] of [
			[{ sha256: "0".repeat(64) }, "sha256 mismatch"],
			[{ bytes: bytes.byteLength - 1 }, "exceeds the pinned size"],
			[{ bytes: bytes.byteLength + 1 }, "the pin requires"],
			[{ entry: "missing.exe" }, "no regular file missing.exe"],
		] as const) {
			const root = await tempDir();
			const dependency = zipSpec(bytes);
			const artifact = { ...dependency.artifacts[PLATFORM]!, ...override };
			const outcome = await installDependency({ ...dependency, artifacts: { [PLATFORM]: artifact } }, { root, platform: PLATFORM, fetch: server(bytes).fetch });
			expect(outcome.status).toBe("failed");
			expect((outcome as { error: string }).error).toContain(message);
			expect(await entries(join(root, "tool"))).toEqual([]);
		}
	});

	test.skipIf(process.platform !== "win32")("refuses ZIP traversal and links before publishing an install", async () => {
		for (const [name, link, message] of [
			["../escape", false, "escapes the install directory"],
			["C:/escape", false, "escapes the install directory"],
			["link", true, "non-regular entry"],
		] as const) {
			const root = await tempDir();
			const bytes = await zipArchive(["tool.exe", name], link);
			const outcome = await installDependency(zipSpec(bytes), { root, platform: PLATFORM, fetch: server(bytes).fetch });
			expect(outcome.status).toBe("failed");
			expect((outcome as { error: string }).error).toContain(message);
			expect(await entries(join(root, "tool"))).toEqual([]);
		}
	});
	test("downloads, verifies, extracts, marks and is idempotent without network", async () => {
		const root = await tempDir();
		const bytes = await archive();
		const dependency = spec(bytes);
		const { fetch, calls } = server(bytes);
		const first = await installDependency(dependency, { root, platform: PLATFORM, fetch });
		expect(first).toEqual({ status: "installed", path: join(root, "tool", V, "tool") });
		expect(await resolveInstalled(dependency, { root, platform: PLATFORM })).toBe(join(root, "tool", V, "tool"));
		const marker = JSON.parse(await readFile(join(root, "tool", V, MARKER), "utf8"));
		expect(marker).toMatchObject({ id: "tool", version: "1.2.3", platform: PLATFORM, sha256: dependency.artifacts[PLATFORM]!.sha256, entry: "tool" });
		expect(await entries(join(root, "tool"))).toEqual([V]); // no staging left behind
		const second = await installDependency(dependency, { root, platform: PLATFORM, fetch });
		expect(second).toEqual({ status: "present", path: join(root, "tool", V, "tool") });
		expect(calls).toHaveLength(1);
		const ran = Bun.spawnSync([first.status === "installed" ? first.path : ""]);
		expect(ran.stdout.toString()).toBe("tool 1.2.3\n");
	});

	test.each([
		["a digest mismatch", (bytes: Uint8Array) => spec(bytes, {}, { sha256: "0".repeat(64) }), "sha256 mismatch"],
		["more bytes than pinned", (bytes: Uint8Array) => spec(bytes, {}, { bytes: bytes.byteLength - 1 }), "exceeds the pinned size"],
		["fewer bytes than pinned", (bytes: Uint8Array) => spec(bytes, {}, { bytes: bytes.byteLength + 1 }), "the pin requires"],
		["a missing entry", (bytes: Uint8Array) => spec(bytes, {}, { entry: "bin/absent" }), "no regular file bin/absent"],
		["a failing smoke check", (bytes: Uint8Array) => spec(bytes, { check: { args: ["--version"], expect: "tool 9.9.9" } }), "did not report"],
	])("refuses %s and leaves no version directory", async (_name, make, message) => {
		const root = await tempDir();
		const bytes = await archive();
		const outcome = await installDependency(make(bytes), { root, platform: PLATFORM, fetch: server(bytes).fetch });
		expect(outcome.status).toBe("failed");
		expect((outcome as { error: string }).error).toContain(message);
		expect(await entries(join(root, "tool"))).toEqual([]);
	});

	test("refuses an HTTP error", async () => {
		const root = await tempDir();
		const bytes = await archive();
		const outcome = await installDependency(spec(bytes), { root, platform: PLATFORM, fetch: server(bytes, { status: 404 }).fetch });
		expect(outcome).toEqual({ status: "failed", error: "download failed: HTTP 404" });
	});

	test("aborts a stalled download after the idle timeout", async () => {
		const root = await tempDir();
		const bytes = await archive();
		const outcome = await installDependency(spec(bytes), { root, platform: PLATFORM, fetch: server(bytes, { stallAfter: 10 }).fetch, idleTimeoutMs: 50 });
		expect(outcome.status).toBe("failed");
		expect((outcome as { error: string }).error).toContain("stalled");
		expect(await entries(join(root, "tool"))).toEqual([]);
	});

	test("refuses archive members that escape the install directory or are links", async () => {
		for (const [members, message] of [
			[[{ name: "tool", type: "file" }, { name: "../escape", type: "file" }], "escapes the install directory"],
			[[{ name: "/abs", type: "file" }, { name: "tool", type: "file" }], "escapes the install directory"],
			[[{ name: "tool", type: "file" }, { name: "link", type: "symlink", target: "/etc/passwd" }], "non-regular entry"],
			[[{ name: "tool", type: "file" }, { name: "hard", type: "hardlink", target: "tool" }], "non-regular entry"],
		] as const) {
			const root = await tempDir();
			const bytes = await craftedArchive([...members]);
			const outcome = await installDependency(spec(bytes), { root, platform: PLATFORM, fetch: server(bytes).fetch });
			expect(outcome.status).toBe("failed");
			expect((outcome as { error: string }).error).toContain(message);
			expect(await entries(join(root, "tool"))).toEqual([]);
			expect(await entries(root)).toEqual(["tool"]);
		}
	});

	test("reports an unsupported platform without touching the network", async () => {
		const root = await tempDir();
		const bytes = await archive();
		const { fetch, calls } = server(bytes);
		expect(await installDependency(spec(bytes), { root, platform: "plan9-mips", fetch })).toEqual({ status: "unsupported", platform: "plan9-mips" });
		expect(calls).toEqual([]);
	});

	test("replaces an unverified directory at the target and a tampered marker", async () => {
		const root = await tempDir();
		const bytes = await archive();
		const dependency = spec(bytes);
		await mkdir(join(root, "tool", V), { recursive: true });
		await writeFile(join(root, "tool", V, "junk"), "x");
		expect((await installDependency(dependency, { root, platform: PLATFORM, fetch: server(bytes).fetch })).status).toBe("installed");
		expect(await entries(join(root, "tool", V))).not.toContain("junk");
		const markerPath = join(root, "tool", V, MARKER);
		await writeFile(markerPath, (await readFile(markerPath, "utf8")).replace(/"sha256": "[0-9a-f]+"/, `"sha256": "${"1".repeat(64)}"`));
		expect(await resolveInstalled(dependency, { root, platform: PLATFORM })).toBeUndefined();
		expect((await installDependency(dependency, { root, platform: PLATFORM, fetch: server(bytes).fetch })).status).toBe("installed");
	});

	test("a non-executable entry does not resolve", async () => {
		const root = await tempDir();
		const bytes = await archive();
		const dependency = spec(bytes);
		await installDependency(dependency, { root, platform: PLATFORM, fetch: server(bytes).fetch });
		await chmod(join(root, "tool", V, "tool"), 0o644);
		expect(await resolveInstalled(dependency, { root, platform: PLATFORM })).toBeUndefined();
	});

	test("a new pin replaces the previous verified version and keeps unmarked directories", async () => {
		const root = await tempDir();
		const old = await archive("1.0.0");
		await installDependency(spec(old, { version: "1.0.0", check: { args: [], expect: "tool 1.0.0" } }), { root, platform: PLATFORM, fetch: server(old).fetch });
		await mkdir(join(root, "tool", "mine"));
		const next = await archive("1.2.3");
		expect((await installDependency(spec(next), { root, platform: PLATFORM, fetch: server(next).fetch })).status).toBe("installed");
		expect(await entries(join(root, "tool"))).toEqual([V, "mine"]);
	});

	test("concurrent installs of one pin both succeed with one verified result", async () => {
		const root = await tempDir();
		const bytes = await archive();
		const dependency = spec(bytes);
		const outcomes = await Promise.all([1, 2, 3].map(() => installDependency(dependency, { root, platform: PLATFORM, fetch: server(bytes).fetch })));
		for (const outcome of outcomes) expect(["installed", "present"]).toContain(outcome.status);
		expect(await resolveInstalled(dependency, { root, platform: PLATFORM })).toBe(join(root, "tool", V, "tool"));
		expect(await entries(join(root, "tool"))).toEqual([V]);
	});
	test("installs for another platform under the same home are kept", async () => {
		const root = await tempDir();
		const bytes = await archive();
		const other = { ...spec(bytes), artifacts: { ...spec(bytes).artifacts, "otheros-arm64": spec(bytes).artifacts[PLATFORM] } };
		expect((await installDependency(other, { root, platform: "otheros-arm64", fetch: server(bytes).fetch })).status).toBe("installed");
		expect((await installDependency(other, { root, platform: PLATFORM, fetch: server(bytes).fetch })).status).toBe("installed");
		expect(await entries(join(root, "tool"))).toEqual(["1.2.3-otheros-arm64", V]);
		expect(await resolveInstalled(other, { root, platform: "otheros-arm64" })).toBe(join(root, "tool", "1.2.3-otheros-arm64", "tool"));
	});

	test("staging left by an interrupted install is removed after an hour, a fresh one is kept", async () => {
		const root = await tempDir();
		const bytes = await archive();
		await mkdir(join(root, "tool", ".staging-old"), { recursive: true });
		await mkdir(join(root, "tool", ".staging-new"), { recursive: true });
		const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
		await utimes(join(root, "tool", ".staging-old"), past, past);
		expect((await installDependency(spec(bytes), { root, platform: PLATFORM, fetch: server(bytes).fetch })).status).toBe("installed");
		expect(await entries(join(root, "tool"))).toEqual([".staging-new", V]);
	});

	test("an aborted install fails and leaves no staging", async () => {
		const root = await tempDir();
		const bytes = await archive();
		const abort = new AbortController();
		const pending = installDependency(spec(bytes), { root, platform: PLATFORM, fetch: server(bytes, { stallAfter: 10 }).fetch, signal: abort.signal });
		setTimeout(() => abort.abort(new Error("interrupted")), 20);
		expect(await pending).toEqual({ status: "failed", error: "interrupted" });
		expect(await entries(join(root, "tool"))).toEqual([]);
	});
});

describe("declarations and roots", () => {
	test("dependencyProblems rejects malformed pins", async () => {
		const bytes = await archive();
		expect(dependencyProblems(spec(bytes))).toEqual([]);
		const bad = spec(bytes, { id: "Tool", version: "../1" }, { url: "http://x", sha256: "ABC", bytes: 0, entry: "../tool" });
		expect(dependencyProblems(bad)).toHaveLength(6);
		expect((await installDependency(bad, { root: await tempDir(), platform: PLATFORM })).status).toBe("failed");
	});

	test("catalogDependencies deduplicates identical pins and rejects conflicting ones", async () => {
		const bytes = await archive();
		const plugin = (id: string, dependency: ExternalDependency): Plugin => definePlugin({ id, config: Type.Object({}), dependencies: [dependency], load: () => ({ tools: [] }) });
		expect(catalogDependencies({ a: plugin("a", spec(bytes)), b: plugin("b", spec(bytes)) })).toEqual([{ dependency: spec(bytes), plugins: ["a", "b"] }]);
		expect(() => catalogDependencies({ a: plugin("a", spec(bytes)), b: plugin("b", spec(bytes, { version: "2.0.0" })) })).toThrow("declared differently");
	});

	test("dependenciesRoot precedence and platformKey", () => {
		expect(dependenciesRoot({ DINOBOT_DEPS_DIR: "/d", XDG_DATA_HOME: "/x" }, "/h")).toBe("/d");
		expect(dependenciesRoot({ DINOBOT_DEPS_DIR: "deps" }, "/h")).toBe("/h/.local/share/dinobot/deps");
		expect(dependenciesRoot({ XDG_DATA_HOME: "/x" }, "/h")).toBe("/x/dinobot/deps");
		expect(dependenciesRoot({ XDG_DATA_HOME: "relative" }, "/h")).toBe("/h/.local/share/dinobot/deps");
		expect(dependenciesRoot({}, "/h")).toBe("/h/.local/share/dinobot/deps");
		expect(platformKey("linux", "x64")).toBe("linux-x64");
	});

	test("dependencyHost resolves only catalog-declared, installed dependencies", async () => {
		const root = await tempDir();
		const bytes = await archive();
		const dependency = spec(bytes);
		const catalog = { p: definePlugin({ id: "p", config: Type.Object({}), dependencies: [dependency], load: () => ({ tools: [] }) }) };
		const host = dependencyHost(catalog, { root, platform: PLATFORM });
		expect(await host.resolveDependency("tool")).toBeUndefined();
		await installDependency(dependency, { root, platform: PLATFORM, fetch: server(bytes).fetch });
		expect(await host.resolveDependency("tool")).toBe(join(root, "tool", V, "tool"));
		expect(await host.resolveDependency("other")).toBeUndefined();
	});
});

describe("macOS app bundles", () => {
	const BUNDLE = "pkg/Tool.app";
	const ENTRY = `${BUNDLE}/Contents/MacOS/tool`;
	const APP = { bundle: BUNDLE, bundleId: "com.example.tool", teamId: "ABCDE12345" };

	function plist(id: string, version: string): string {
		return `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n\t<key>CFBundleIdentifier</key>\n\t<string>${id}</string>\n\t<key>CFBundleShortVersionString</key>\n\t<string>${version}</string>\n</dict>\n</plist>\n`;
	}

	/** An unsigned `<dir>/Tool.app` whose executable prints `tool <version>`. */
	async function fakeApp(dir: string, options: { id?: string; version?: string; mode?: number } = {}): Promise<string> {
		const app = join(dir, "Tool.app");
		await mkdir(join(app, "Contents", "MacOS"), { recursive: true });
		await writeFile(join(app, "Contents", "Info.plist"), plist(options.id ?? APP.bundleId, options.version ?? "1.2.3"));
		await writeFile(join(app, "Contents", "MacOS", "tool"), `#!/bin/sh\necho "tool ${options.version ?? "1.2.3"}"\n`);
		await chmod(join(app, "Contents", "MacOS", "tool"), options.mode ?? 0o755);
		return app;
	}

	test("cua-driver pins the notarized universal app for both macOS architectures", () => {
		for (const arch of ["arm64", "x64"]) {
			const artifact = CUA_DRIVER.artifacts[`darwin-${arch}`];
			expect(artifact?.url).toEndWith("/cua-driver-rs-0.34.0-darwin-universal.tar.gz");
			expect(artifact?.macosApp).toMatchObject({ bundle: "cua-driver-rs-0.34.0-darwin-universal/CuaDriver.app", bundleId: "com.trycua.driver", teamId: "YCK386LBJ7" });
			expect(artifact?.entry).toBe("cua-driver-rs-0.34.0-darwin-universal/CuaDriver.app/Contents/MacOS/cua-driver");
		}
		expect(dependencyProblems(CUA_DRIVER)).toEqual([]);
	});

	test("rejects an entry outside the bundle, a non-.app bundle and malformed signer fields", async () => {
		const bytes = await archive();
		const problems = (macosApp: Record<string, unknown>, entry = ENTRY) => dependencyProblems(spec(bytes, {}, { entry, macosApp: { ...APP, ...macosApp } }));
		expect(problems({})).toEqual([]);
		expect(problems({}, "pkg/tool").join()).toContain("entry must lie inside macosApp.bundle");
		expect(problems({ bundle: "pkg/Tool" }, "pkg/Tool/x").join()).toContain("must name a .app directory");
		expect(problems({ bundle: "../Tool.app" }, "../Tool.app/x").join()).toContain("macosApp.bundle must be a relative path");
		expect(problems({ bundleId: "tool" }).join()).toContain("bundleId");
		expect(problems({ teamId: "abc" }).join()).toContain("teamId");
	});

	test("resolves the bundle in the applications directory only with the pinned id, version and an executable entry", async () => {
		const bytes = await archive();
		const dependency = spec(bytes, {}, { entry: ENTRY, macosApp: APP });
		const resolve = (applications: string) => resolveInstalled(dependency, { root: join(applications, "deps"), platform: PLATFORM, applications });
		const missing = await tempDir();
		expect(await resolve(missing)).toBeUndefined();
		const good = await tempDir();
		await fakeApp(good);
		expect(await resolve(good)).toBe(join(good, "Tool.app", "Contents", "MacOS", "tool"));
		for (const options of [{ version: "1.2.4" }, { id: "com.example.other" }, { mode: 0o644 }]) {
			const dir = await tempDir();
			await fakeApp(dir, options);
			expect(await resolve(dir)).toBeUndefined();
		}
	});

	test("an unsigned bundle is neither trusted as present nor installed, and the existing app is kept", async () => {
		const source = await tempDir();
		await fakeApp(join(source, "pkg"));
		const out = join(source, "app.tar.gz");
		const tar = Bun.spawnSync(["tar", "-czf", out, "-C", source, "pkg"]);
		if (tar.exitCode !== 0) throw new Error(tar.stderr.toString());
		const bytes = new Uint8Array(await readFile(out));
		const dependency = spec(bytes, {}, { entry: ENTRY, macosApp: APP });
		const applications = await tempDir();
		const existing = await fakeApp(applications);
		const before = await readFile(join(existing, "Contents", "MacOS", "tool"), "utf8");
		const root = join(applications, "deps");
		const { fetch, calls } = server(bytes);
		const outcome = await installDependency(dependency, { root, platform: PLATFORM, applications, fetch });
		expect(outcome.status).toBe("failed");
		expect(outcome.status === "failed" ? outcome.error : "").toContain("is not a valid com.example.tool bundle signed by team ABCDE12345");
		expect(calls).toHaveLength(1);
		expect(await entries(applications)).toEqual(["Tool.app", "deps"]);
		expect(await readFile(join(existing, "Contents", "MacOS", "tool"), "utf8")).toBe(before);
		expect(await entries(join(root, "tool"))).toEqual([]);
	});
});

describe("dinobot init", () => {
	async function setup(manifest?: string) {
		const home = await tempDir();
		const root = join(home, "deps");
		const bytes = await archive();
		const dependency = spec(bytes);
		const catalog = { p: definePlugin({ id: "p", config: Type.Object({}), dependencies: [dependency], load: () => ({ tools: [] }) }) };
		const config = manifest === undefined ? undefined : join(home, "dinobot.yaml");
		if (config) await writeFile(config, manifest!);
		const lines: string[] = [];
		const errors: string[] = [];
		const { fetch, calls } = server(bytes);
		const init = (argv: string[]) => runInit(config ? [...argv, "--config", config] : argv, {
			catalog, root, platform: PLATFORM, fetch, home, env: {}, out: (line) => lines.push(line), err: (line) => errors.push(line),
		});
		return { home, root, init, lines, errors, calls, config };
	}

	test("--check reports missing without downloading, install succeeds, a rerun is a no-op", async () => {
		const { init, lines, calls, root } = await setup("plugins: {}\n");
		expect(await init(["--check"])).toBe(1);
		expect(lines.join("\n")).toContain("tool 1.2.3: missing; run `dinobot init`");
		expect(calls).toEqual([]);
		lines.length = 0;
		expect(await init([])).toBe(0);
		expect(lines.join("\n")).toContain(`tool 1.2.3: installed ${join(root, "tool", V, "tool")}`);
		expect(lines.join("\n")).toContain("used by plugin p: add `p: {}` under `plugins:`");
		lines.length = 0;
		expect(await init([])).toBe(0);
		expect(lines.join("\n")).toContain("already installed");
		expect(await init(["--check"])).toBe(0);
		expect(calls).toHaveLength(1);
	});

	test("no enabling hint once the manifest turns the plugin on", async () => {
		const { init, lines } = await setup("plugins:\n  p: {}\n");
		expect(await init([])).toBe(0);
		expect(lines.join("\n")).not.toContain("used by plugin");
	});

	test("creates the default manifest on bootstrap but not on --check", async () => {
		const { init, home, lines } = await setup();
		const path = join(home, ".config", "dinobot", "dinobot.yaml");
		expect(await init(["--check"])).toBe(1);
		expect(await Bun.file(path).exists()).toBe(false);
		expect(await init([])).toBe(0);
		expect(await Bun.file(path).exists()).toBe(true);
		expect(lines.join("\n")).toContain(`manifest: created ${path}`);
	});

	test("usage errors and unknown dependencies exit 2; a failed install exits 1", async () => {
		const { init, errors } = await setup("plugins: {}\n");
		expect(await init(["--bogus"])).toBe(2);
		expect(await init(["nope"])).toBe(2);
		expect(errors.join("\n")).toContain("unknown dependency nope (available: tool)");
		const home = await tempDir();
		const bytes = await archive();
		const broken = spec(bytes, {}, { sha256: "0".repeat(64) });
		const catalog = { p: definePlugin({ id: "p", config: Type.Object({}), dependencies: [broken], load: () => ({ tools: [] }) }) };
		const failures: string[] = [];
		expect(await runInit(["--config", join(home, "none.yaml")], { catalog, root: join(home, "deps"), platform: PLATFORM, fetch: server(bytes).fetch, home, env: {}, out: () => {}, err: (line) => failures.push(line) })).toBe(1);
		expect(failures.join("\n")).toContain("sha256 mismatch");
	});

	test("an unsupported platform is a note by default and an error when requested by name", async () => {
		const home = await tempDir();
		const bytes = await archive();
		const catalog = { p: definePlugin({ id: "p", config: Type.Object({}), dependencies: [spec(bytes, { manualInstall: "do it by hand" })], load: () => ({ tools: [] }) }) };
		const lines: string[] = [];
		const options = { catalog, root: join(home, "deps"), platform: "plan9-mips", home, env: {}, out: (line: string) => lines.push(line), err: () => {} };
		expect(await runInit(["--config", join(home, "x.yaml")], options)).toBe(0);
		expect(lines.join("\n")).toContain("tool 1.2.3: not available for plan9-mips; do it by hand");
		expect(await runInit(["--config", join(home, "x.yaml"), "tool"], options)).toBe(1);
	});
});
