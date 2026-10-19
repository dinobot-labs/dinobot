import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { auditReleaseArtifact, createReleaseManifest, ReleaseAuditError } from "../script/release-audit.ts";

const root = resolve(import.meta.dir, "../dist/npm");
const dirs: string[] = [];
const files = ["main.js", "codemode-worker.js", "browser-host.js", "package.json", "README.md", "THIRD_PARTY_NOTICES.txt"];
const manifest = {
	name: "dinobot", version: "1.2.3", description: "dinobot — channel-agnostic team agent bot",
	license: "PolyForm-Noncommercial-1.0.0", type: "module", bin: { dinobot: "main.js" },
	files: ["main.js", "codemode-worker.js", "browser-host.js", "README.md", "THIRD_PARTY_NOTICES.txt"],
	engines: { bun: ">=1.4.0" }, os: ["linux", "darwin", "win32"],
	dependencies: { "@oh-my-pi/pi-natives": "1.0.0", patchright: "1.63.0" },
	repository: { type: "git", url: "git+https://github.com/dinobot-labs/dinobot.git" },
};

function fixture(options: {
	contents?: Record<string, string | Buffer>;
	entries?: string[];
	args?: string[];
	prepare?: (dir: string) => void;
} = {}) {
	mkdirSync(root, { recursive: true });
	const dir = mkdtempSync(join(root, "audit-test-"));
	dirs.push(dir);
	const contents = {
		"main.js": '#!/usr/bin/env bun\nconsole.log("minified");\n',
		"codemode-worker.js": 'self.onmessage=()=>postMessage("ok");\n',
		"browser-host.js": 'if(import.meta.main){const{chromium:c}=await import("patchright");}\n',
		"package.json": JSON.stringify(manifest),
		"README.md": "# dinobot\nInstall with Bun.\n",
		"THIRD_PARTY_NOTICES.txt": "Third-party license notices.\n",
		...options.contents,
	};
	for (const [file, body] of Object.entries(contents)) {
		const path = join(dir, "package", file);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, body);
	}
	options.prepare?.(dir);
	const path = join(dir, "fixture.tgz");
	const result = spawnSync("tar", ["--create", "--gzip", "--format=ustar", "--blocking-factor=1", "--file", path,
		...options.args ?? [], "--", ...options.entries ?? files.map((file) => "package/" + file)], {
		cwd: dir, env: { PATH: process.env.PATH!, LC_ALL: "C", TZ: "UTC" }, timeout: 10_000,
	});
	if (result.status !== 0) throw new Error("fixture tar creation failed");
	return { path, dir };
}

function mutateTar(path: string, mutate: (bytes: Buffer) => Buffer | void) {
	const bytes = gunzipSync(readFileSync(path));
	writeFileSync(path, gzipSync(mutate(bytes) ?? bytes));
}

// Only used to craft adversarial headers; all ordinary fixtures are produced by real GNU tar.
function headerChecksum(bytes: Buffer) {
	bytes.fill(32, 148, 156);
	const sum = bytes.subarray(0, 512).reduce((a, b) => a + b, 0);
	bytes.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
}

function rejects(path: string, category?: string) {
	expect(() => auditReleaseArtifact(path, "1.2.3")).toThrow(ReleaseAuditError);
	if (category) expect(() => auditReleaseArtifact(path, "1.2.3")).toThrow(category);
}

afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("npm artifact audit", () => {
	test("the release manifest pins patchright to package.json's exact version", () => {
		const repoPkg = JSON.parse(readFileSync(resolve(import.meta.dir, "../package.json"), "utf8")) as { dependencies: Record<string, string> };
		const pinned = repoPkg.dependencies.patchright!;
		expect(pinned).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+$/);
		expect(createReleaseManifest("dinobot", "1.2.3", "1.0.0", pinned).dependencies).toEqual({ "@oh-my-pi/pi-natives": "1.0.0", patchright: pinned });
	});

	test("accepts the six regular files and public OIDC repository, without filesystem extraction", () => {
		expect(manifest).toEqual(createReleaseManifest("dinobot", "1.2.3", "1.0.0", "1.63.0"));
		const { path, dir } = fixture();
		const before = readdirSync(dir, { recursive: true });
		expect(() => auditReleaseArtifact(path, "1.2.3")).not.toThrow();
		expect(readdirSync(dir, { recursive: true })).toEqual(before);
	});

	test("accepts empty regular documentation members", () => {
		const { path } = fixture({ contents: { "README.md": "", "THIRD_PARTY_NOTICES.txt": "" } });
		expect(() => auditReleaseArtifact(path, "1.2.3")).not.toThrow();
	});

	test("accepts custom scoped package names, stable build metadata, and different archive order", () => {
		const { path } = fixture({ contents: { "package.json": JSON.stringify({ ...manifest, name: "@acme/dinobot", version: "1.2.3+build.7" }) }, entries: files.toReversed().map((file) => "package/" + file) });
		expect(() => auditReleaseArtifact(path, "1.2.3+build.7", "@acme/dinobot")).not.toThrow();
		expect(() => auditReleaseArtifact(path, "1.2.3+build.7")).toThrow("mismatch");
	});

	test("README is allowed, as are credential vocabulary, placeholders, and sourceURL codegen", () => {
		const { path } = fixture({ contents: { "README.md": [
			"https://github.com/tmdgusya/dinobot", "OPENAI_API_KEY NPM_TOKEN GITHUB_TOKEN Authorization: Bearer <token>",
			"apiKey=process.env.OPENAI_API_KEY; password=placeholder; token=YOUR_TOKEN; sk-your-key; xoxb-example; npm_example;",
			"-----BEGIN PRIVATE KEY-----", "sourceMappingURL is a term, not a directive.",
		].join("\n"), "main.js": 'const generated="//# sourceURL=generated"; console.log("sk-placeholder");' } });
		expect(() => auditReleaseArtifact(path, "1.2.3")).not.toThrow();
	});

	test.each(["src/main.ts", "main.js.map", "extra.js", ".npmrc", "README.extra.md", "patches/fix.patch", "test/a.test.ts"])("rejects extra member %s", (file) => {
		const { path } = fixture({ contents: { [file]: "unexpected" }, entries: [...files, file].map((name) => "package/" + name) });
		rejects(path, "unexpected archive member");
	});

	test.each(files)("rejects missing %s", (missing) => {
		rejects(fixture({ entries: files.filter((file) => file !== missing).map((file) => "package/" + file) }).path, "missing archive member");
	});

	test("rejects duplicate entries even when their payloads are identical", () => {
		rejects(fixture({ args: ["--hard-dereference"], entries: [...files, "main.js"].map((file) => "package/" + file) }).path, "duplicate archive member");
	});

	test.each(["package/../main.js", "../main.js", "/package/main.js", "package//main.js", "./package/main.js", "package/main.js\nforged", "package\\main.js"])("rejects unsafe or noncanonical path %s", (name) => {
		const { path } = fixture();
		mutateTar(path, (bytes) => { bytes.fill(0, 0, 100); bytes.write(name, 0, "utf8"); headerChecksum(bytes); });
		rejects(path);
	});

	test.each(["symlink", "hardlink"])("rejects %s under an approved name without following it", (kind) => {
		const { path, dir } = fixture({ prepare(dir) {
			rmSync(join(dir, "package/codemode-worker.js"));
			if (kind === "symlink") symlinkSync("../../outside", join(dir, "package/codemode-worker.js"));
			else linkSync(join(dir, "package/main.js"), join(dir, "package/codemode-worker.js"));
		} });
		rejects(path, "nonregular");
		expect(existsSync(join(dir, "outside"))).toBe(false);
	});

	test.each(["1", "2", "3", "4", "5", "6", "7", "S", "x", "g", "L", "K", "Z"])("rejects nonregular/extension tar type %s", (type) => {
		const { path } = fixture();
		mutateTar(path, (bytes) => { bytes[156] = type.charCodeAt(0); headerChecksum(bytes); });
		rejects(path);
	});

	test("rejects real PAX extension headers rather than silently ignoring hidden records", () => {
		rejects(fixture({ args: ["--format=pax"] }).path);
	});

	test.each([
		"console.log(1);//# sourceMappingURL=main.js.map",
		"console.log(1);/*# sourceMappingURL=main.js.map */",
		"console.log(1);/*#\nsourceMappingURL=main.js.map */",
		"console.log(1);/*@ sourceMappingURL=data:application/json;base64,e30= */",
		"//# sourceMappingURL=data:application/json;base64,e30=\nconsole.log(1);",
		"console.log(1);\n//@ sourceMappingURL=main.js.map\n",
	])( "rejects inline and trailing source map directives %#", (body) => {
		rejects(fixture({ contents: { "main.js": body } }).path, "source map directive");
	});

	test.each(files)("inspects actual payload of %s, including allowed README/notices", (file) => {
		rejects(fixture({ contents: { [file]: "/*# sourceMappingURL=secret.map */" } }).path, "source map directive");
	});

	test.each([
		'{"name":"dinobot","patchedDependencies":{"example":"patches/example.patch"}}',
		'var pkg={scripts:{start:"bun src/main.ts"}};',
		'var pkg={patchedDependencies:{}};',
	])( "rejects original repository manifest leakage %#", (body) => {
		rejects(fixture({ contents: { "main.js": body } }).path, "repository manifest leakage");
	});

	test.each([resolve(import.meta.dir, "..") + "/src/main.ts", homedir() + "/private/token", "/home/runner/work/dinobot/dinobot/src/main.ts", "/Users/builder/work/main.ts", "C:\\Users\\builder\\project\\main.ts", "/builds/team/dinobot/main.ts", "/__w/dinobot/dinobot/main.ts"])("rejects build/home paths %# without printing the path", (body) => {
		const { path } = fixture({ contents: { "main.js": body } });
		try { auditReleaseArtifact(path, "1.2.3"); throw new Error("unexpected pass"); }
		catch (error) { expect(error).toBeInstanceOf(ReleaseAuditError); expect(String(error)).toContain("build or home path"); expect(String(error)).not.toContain(body); }
	});

	const credentials = [
		"ghp_" + "a".repeat(36), "github_pat_" + "a".repeat(82), "npm_" + "a".repeat(36),
		"AKIA" + "A".repeat(16), "xoxb-123456789012-123456789012-" + "a".repeat(24),
		"sk-proj-" + "a".repeat(80), "sk-ant-api03-" + "a".repeat(80), "AIza" + "a".repeat(35),
		"1234567890:" + "a".repeat(35),
		"1234567890:" + "a".repeat(34) + "-", "AIza" + "a".repeat(34) + "-",
		"-----BEGIN PRIVATE KEY-----\n" + "A".repeat(64) + "\n-----END PRIVATE KEY-----",
		"-----BEGIN RSA PRIVATE KEY-----\\n" + "A".repeat(64) + "\\n-----END RSA PRIVATE KEY-----",
	];
	test.each(credentials.map((value, index) => ({ value, index })))("rejects credential signature $index without disclosing it", ({ value }) => {
		const { path } = fixture({ contents: { "README.md": value } });
		try { auditReleaseArtifact(path, "1.2.3"); throw new Error("unexpected pass"); }
		catch (error) { expect(error).toBeInstanceOf(ReleaseAuditError); expect(String(error)).toContain("credential signature"); expect(String(error)).not.toContain(value); }
	});

	test.each(["scripts", "devDependencies", "patchedDependencies", "private", "exports", "publishConfig", "unexpected"])("rejects forbidden manifest field %s", (field) => {
		rejects(fixture({ contents: { "package.json": JSON.stringify({ ...manifest, [field]: {} }) } }).path);
	});

	test.each([
		{ version: "1.2.4" }, { name: "other" }, { version: "1.2.3-beta.1" },
		{ repository: { type: "git", url: "https://github.com/other/project.git" } },
		{ repository: { ...manifest.repository, directory: "src" } },
		{ bin: { dinobot: "src/main.ts" } }, { engines: { bun: ">=1.4.0", node: "*" } },
		{ dependencies: { ...manifest.dependencies, surprise: "1.0.0" } },
		{ dependencies: { ...manifest.dependencies, "@oh-my-pi/pi-natives": "latest" } }, { files: ["**/*"] },
		{ dependencies: { "@oh-my-pi/pi-natives": "1.0.0" } }, { dependencies: { ...manifest.dependencies, patchright: "^1.63.0" } },
		{ dependencies: { ...manifest.dependencies, patchright: "latest" } }, { dependencies: { ...manifest.dependencies, "patchright-core": "1.63.0" } },
		{ files: ["main.js", "codemode-worker.js", "README.md", "THIRD_PARTY_NOTICES.txt"] },
	])( "rejects manifest identity, version, and nested-field mismatch %#", (change) => {
		rejects(fixture({ contents: { "package.json": JSON.stringify({ ...manifest, ...change }) } }).path, "mismatch");
	});

	test.each(Object.keys(manifest))("requires manifest field %s", (field) => {
		const value: Record<string, unknown> = { ...manifest }; delete value[field];
		rejects(fixture({ contents: { "package.json": JSON.stringify(value) } }).path);
	});

	test.each(["1.2", "v1.2.3", "01.2.3", "1.2.3-rc.1", "1.2.3\n", "1.2.3+", "1.2.3+a..b"])("rejects nonstable or invalid expected version %#", (version) => {
		expect(() => auditReleaseArtifact("not-read", version)).toThrow("stable SemVer");
	});

	test.each(["{", "null", "[]", '"not an object"'])("rejects malformed/nonobject manifest %#", (body) => {
		rejects(fixture({ contents: { "package.json": body } }).path);
	});

	test("rejects invalid UTF-8", () => { rejects(fixture({ contents: { "main.js": Buffer.from([0xff, 0xfe]) } }).path, "UTF-8"); });

	test("rejects invalid gzip and checksum corruption", () => {
		const { path } = fixture();
		const original = readFileSync(path);
		const corrupt = Buffer.from(original); corrupt[corrupt.length - 8] = corrupt[corrupt.length - 8]! ^ 0xff;
		writeFileSync(path, corrupt); rejects(path, "gzip");
		writeFileSync(path, "not an archive"); rejects(path, "gzip");
	});

	test.each([Buffer.alloc(10), Buffer.from([0, 1, 2])])("rejects trailing gzip bytes that zlib otherwise ignores %#", (suffix) => {
		const { path } = fixture(); writeFileSync(path, Buffer.concat([readFileSync(path), suffix])); rejects(path, "gzip");
	});

	test("rejects gzip truncation even when all tar members have already arrived", () => {
		const { path } = fixture(); writeFileSync(path, readFileSync(path).subarray(0, -8)); rejects(path, "gzip");
	});

	test.each([1, 512, 1024, 2048])("rejects truncated tar stream by %i bytes", (count) => {
		const { path } = fixture(); mutateTar(path, (bytes) => bytes.subarray(0, -count)); rejects(path);
	});

	test("rejects corrupted tar headers and nonzero payload padding", () => {
		const first = fixture(); mutateTar(first.path, (bytes) => { bytes[0] = 0x58; }); rejects(first.path);
		const second = fixture(); mutateTar(second.path, (bytes) => { bytes[1023] = 0x58; }); rejects(second.path, "padding");
	});

	test("rejects concatenated archives and junk after a valid tar terminator", () => {
		const first = fixture(); const second = fixture();
		writeFileSync(first.path, Buffer.concat([readFileSync(first.path), readFileSync(second.path)])); rejects(first.path);
		mutateTar(second.path, (bytes) => Buffer.concat([bytes, Buffer.alloc(512, 0x58)])); rejects(second.path);
	});

	test("rejects compressed, expanded, individual member and manifest size limits", () => {
		const compressed = fixture(); truncateSync(compressed.path, 32 * 1024 * 1024 + 1); rejects(compressed.path, "oversized");
		const expanded = fixture(); writeFileSync(expanded.path, gzipSync(Buffer.alloc(64 * 1024 * 1024 + 1))); rejects(expanded.path, "oversized");
		const member = fixture({ contents: { "main.js": Buffer.alloc(32 * 1024 * 1024 + 1, 0x61) } }); rejects(member.path, "oversized member");
		const json = fixture({ contents: { "package.json": " ".repeat(64 * 1024 + 1) } }); rejects(json.path, "oversized member");
	}, 15_000);

	test("does not inherit TAR_OPTIONS or trust an archive symlink", () => {
		const { path, dir } = fixture();
		const previous = process.env.TAR_OPTIONS;
		try { process.env.TAR_OPTIONS = "--definitely-not-a-real-tar-option"; expect(() => auditReleaseArtifact(path, "1.2.3")).not.toThrow(); }
		finally { if (previous === undefined) delete process.env.TAR_OPTIONS; else process.env.TAR_OPTIONS = previous; }
		const link = join(dir, "link.tgz"); symlinkSync(path, link); rejects(link, "cannot read");
	});

	test("CLI supports default/custom names and redacts payload errors", () => {
		const normal = fixture();
		const cli = (args: string[]) => spawnSync(process.execPath, [resolve(import.meta.dir, "../script/release-audit.ts"), ...args], { encoding: "utf8", timeout: 10_000 });
		expect(cli([normal.path, "1.2.3"]).status).toBe(0);
		const custom = fixture({ contents: { "package.json": JSON.stringify({ ...manifest, name: "@acme/dinobot" }) } });
		expect(cli([custom.path, "1.2.3", "@acme/dinobot"]).status).toBe(0);
		expect(cli([normal.path, "1.2.4"]).status).toBe(1);
		expect(cli([]).status).toBe(1);
		const secret = credentials[0]!; const bad = fixture({ contents: { "README.md": secret } });
		const result = cli([bad.path, "1.2.3"]);
		expect(result.status).toBe(1); expect(result.stderr).toContain("credential signature");
		expect(result.stdout + result.stderr).not.toContain(secret);
	});
});
