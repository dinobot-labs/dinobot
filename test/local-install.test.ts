import { afterEach, expect, test } from "bun:test";
import { chmodSync, closeSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { atomicInstallFile, discoverNativeArtifacts, installLocalArtifacts, localInstallPaths, nativeArtifactNames, preflightLocalInstall } from "../script/local-install.ts";

const roots: string[] = [];
const repo = resolve(import.meta.dir, "..");
function fixture(): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "dinobot local install ")));
	roots.push(root);
	return root;
}
function file(path: string, content = "artifact"): string {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
	return path;
}
function nativePackage(root: string, platform: string, arch: string, names: readonly string[]): string {
	const name = `@oh-my-pi/pi-natives-${platform}-${arch}`;
	const directory = join(root, "node_modules", name);
	file(join(directory, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
	for (const name of names) file(join(directory, name));
	return directory;
}
function built(root: string, platform = "darwin", arch = "arm64"): string {
	const dist = join(root, "build output");
	file(join(dist, "dinobot"), "new binary");
	for (const name of nativeArtifactNames(platform, arch)) file(join(dist, name), `new ${name}`);
	return dist;
}
const mode = (path: string) => statSync(path).mode & 0o777;
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("package scripts use portable Bun entrypoints, not Linux-only shell copies or GNU install", () => {
	const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
	expect(pkg.scripts.build).toBe("bun script/build.ts");
	expect(pkg.scripts["install:local"]).toBe("bun script/install-local.ts");
});

test.each([
	["darwin", "x64", ["pi_natives.darwin-x64-modern.node", "pi_natives.darwin-x64-baseline.node", "pi_natives.darwin-x64.node"]],
	["darwin", "arm64", ["pi_natives.darwin-arm64.node"]],
	["linux", "x64", ["pi_natives.linux-x64-modern.node", "pi_natives.linux-x64-baseline.node", "pi_natives.linux-x64.node"]],
	["linux", "arm64", ["pi_natives.linux-arm64.node"]],
] as const)("%s-%s discovers only exact host filenames from its installed package", (platform, arch, expected) => {
	const root = fixture();
	const unrelated = ["pi_natives.win32-x64.node", "pi_natives.linux-riscv64.node", "pi_natives.darwin-arm64-baseline.node", "unrelated.node", "README.md", `${expected[0]}.bak`];
	const foreign = nativeArtifactNames(platform === "linux" ? "darwin" : "linux", arch);
	const directory = nativePackage(root, platform, arch, [...expected, ...foreign, ...unrelated]);
	nativePackage(root, platform === "linux" ? "darwin" : "linux", arch, foreign);
	const selected = discoverNativeArtifacts(root, platform, arch);
	expect(selected).toEqual(expected.map((name) => join(directory, name)));
	expect(Object.isFrozen(selected)).toBe(true);
	const dist = built(root, platform, arch);
	for (const name of [...foreign, ...unrelated]) file(join(dist, name));
	const artifacts = preflightLocalInstall(dist, platform, arch);
	expect(artifacts.natives.map((path) => basename(path))).toEqual([...expected]);
	expect(Object.isFrozen(artifacts)).toBe(true);
	expect(Object.isFrozen(artifacts.natives)).toBe(true);
	const bin = join(root, "nested install", "bin with spaces", "custom dinobot");
	installLocalArtifacts(artifacts, bin);
	expect(readdirSync(dirname(bin)).sort()).toEqual(["custom dinobot", ...expected].sort());
	for (const name of expected) {
		expect(readFileSync(join(dirname(bin), name), "utf8")).toBe(`new ${name}`);
		expect(mode(join(dirname(bin), name))).toBe(0o644);
	}
	expect(mode(bin)).toBe(0o755);
});

test.each([
	{ variants: ["baseline"] }, { variants: ["default"] }, { variants: ["modern", "baseline"] }, { variants: ["modern", "default"] },
])("x64 accepts available loader fallback set %j without requiring two Linux files", ({ variants }) => {
	const root = fixture();
	const names = variants.map((v) => `pi_natives.linux-x64${v === "default" ? "" : `-${v}`}.node`);
	nativePackage(root, "linux", "x64", names);
	expect(discoverNativeArtifacts(root, "linux", "x64").map((path) => basename(path))).toEqual(names);
});

test("missing packages, foreign-only artifacts and modern-only x64 fail preflight", () => {
	// Resolution may cache negative lookups; each package state uses its own checkout.
	expect(() => discoverNativeArtifacts(fixture(), "linux", "x64")).toThrow("Missing installed native package @oh-my-pi/pi-natives-linux-x64");
	const root = fixture();
	const directory = nativePackage(root, "linux", "x64", ["pi_natives.darwin-x64-baseline.node"]);
	expect(() => discoverNativeArtifacts(root, "linux", "x64")).toThrow("Missing native artifacts for linux-x64");
	file(join(directory, "pi_natives.linux-x64-modern.node"));
	expect(() => discoverNativeArtifacts(root, "linux", "x64")).toThrow("baseline or default");
});

test.each([["win32", "x64"], ["linux", "riscv64"], ["darwin", "ia32"]])("unsupported %s-%s fails without destination mutation", (platform, arch) => {
	const root = fixture();
	const bin = file(join(root, "installed", "dinobot"), "old binary");
	const before = statSync(bin);
	expect(() => discoverNativeArtifacts(root, platform, arch)).toThrow("Unsupported native host");
	expect(() => installLocalArtifacts(preflightLocalInstall(join(root, "missing dist"), platform, arch), bin)).toThrow("Unsupported native host");
	expect(statSync(bin).ino).toBe(before.ino);
	expect(readFileSync(bin, "utf8")).toBe("old binary");
	expect(existsSync(join(root, "missing dist"))).toBe(false);
});

test.each(["missing binary", "empty binary", "directory binary", "missing native", "empty native", "directory native", "symlink native"])("%s preflight preserves old content, inode and directory", (fault) => {
	const root = fixture();
	const dist = built(root);
	const source = join(dist, fault.includes("binary") ? "dinobot" : "pi_natives.darwin-arm64.node");
	rmSync(source);
	if (fault.startsWith("empty")) file(source, "");
	if (fault.startsWith("directory")) mkdirSync(source);
	if (fault.startsWith("symlink")) symlinkSync(file(join(root, "foreign.node")), source);
	const bin = file(join(root, "installed", "dinobot"), "old binary");
	chmodSync(bin, 0o751);
	const before = statSync(bin);
	expect(() => installLocalArtifacts(preflightLocalInstall(dist, "darwin", "arm64"), bin)).toThrow();
	expect(readFileSync(bin, "utf8")).toBe("old binary");
	expect(statSync(bin).ino).toBe(before.ino);
	expect(mode(bin)).toBe(0o751);
	expect(readdirSync(dirname(bin))).toEqual(["dinobot"]);
	const fresh = join(root, "not yet created", "dinobot");
	expect(() => installLocalArtifacts(preflightLocalInstall(dist, "darwin", "arm64"), fresh)).toThrow();
	expect(existsSync(dirname(fresh))).toBe(false);
});

test("captured selection stays immutable and rechecks every source before any destination write", () => {
	const root = fixture();
	const dist = built(root, "linux", "x64");
	const artifacts = preflightLocalInstall(dist, "linux", "x64");
	file(join(dist, "other.node"));
	const bin = file(join(root, "installed", "dinobot"), "old binary");
	for (const source of artifacts.natives) file(join(dirname(bin), basename(source)), "old native");
	rmSync(artifacts.natives[1]!);
	expect(() => installLocalArtifacts(artifacts, bin)).toThrow();
	expect(readFileSync(bin, "utf8")).toBe("old binary");
	for (const source of artifacts.natives) expect(readFileSync(join(dirname(bin), basename(source)), "utf8")).toBe("old native");
	expect(existsSync(join(dirname(bin), "other.node"))).toBe(false);
});

test("replacement uses new inodes with exact modes while old open files remain usable", () => {
	const root = fixture();
	const dist = built(root);
	const artifacts = preflightLocalInstall(dist, "darwin", "arm64");
	const bin = file(join(root, "installed with spaces", "dinobot"), "old binary");
	const native = file(join(dirname(bin), "pi_natives.darwin-arm64.node"), "old native");
	file(join(dirname(bin), ".someone-elses.tmp"), "preserve");
	chmodSync(bin, 0o700);
	chmodSync(native, 0o600);
	const oldBin = openSync(bin, "r");
	const oldNative = openSync(native, "r");
	const umask = process.umask(0o077);
	try {
		installLocalArtifacts(artifacts, bin);
		expect(statSync(bin).ino).not.toBe(fstatSync(oldBin).ino);
		expect(statSync(native).ino).not.toBe(fstatSync(oldNative).ino);
		expect(readFileSync(oldBin, "utf8")).toBe("old binary");
		expect(readFileSync(oldNative, "utf8")).toBe("old native");
		expect(readFileSync(bin, "utf8")).toBe("new binary");
		expect(readFileSync(native, "utf8")).toBe("new pi_natives.darwin-arm64.node");
		expect(mode(bin)).toBe(0o755);
		expect(mode(native)).toBe(0o644);
		expect(readdirSync(dirname(bin)).sort()).toEqual([".someone-elses.tmp", "dinobot", "pi_natives.darwin-arm64.node"]);
	} finally {
		process.umask(umask);
		closeSync(oldBin);
		closeSync(oldNative);
	}
});

test("native rename failure leaves binary last, cleans its temp and preserves unrelated files", () => {
	const root = fixture();
	const artifacts = preflightLocalInstall(built(root, "linux", "x64"), "linux", "x64");
	const bin = file(join(root, "installed", "dinobot"), "old binary");
	const before = statSync(bin).ino;
	const blocked = join(dirname(bin), basename(artifacts.natives[1]!));
	file(join(blocked, "sentinel"), "keep"); // rename of a regular temp over a directory must fail.
	expect(() => installLocalArtifacts(artifacts, bin)).toThrow();
	expect(readFileSync(bin, "utf8")).toBe("old binary");
	expect(statSync(bin).ino).toBe(before);
	expect(readFileSync(join(dirname(bin), basename(artifacts.natives[0]!)), "utf8")).toBe(`new ${basename(artifacts.natives[0]!)}`);
	expect(readFileSync(join(blocked, "sentinel"), "utf8")).toBe("keep");
	expect(readdirSync(dirname(bin)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});

test("atomic install replaces a destination symlink, not the executable it pointed at", () => {
	const root = fixture();
	const source = file(join(root, "source"), "new binary");
	const original = file(join(root, "original"), "live binary");
	const bin = join(root, "dinobot");
	symlinkSync(original, bin);
	atomicInstallFile(source, bin, 0o755);
	expect(readFileSync(original, "utf8")).toBe("live binary");
	expect(readFileSync(bin, "utf8")).toBe("new binary");
	expect(mode(bin)).toBe(0o755);
});

test("directory binary target fails before replacing any sibling addons", () => {
	const root = fixture();
	const artifacts = preflightLocalInstall(built(root), "darwin", "arm64");
	const bin = join(root, "installed", "mistaken directory");
	mkdirSync(bin, { recursive: true });
	const sibling = file(join(dirname(bin), basename(artifacts.natives[0]!)), "keep existing addon");
	const before = statSync(sibling).ino;
	expect(() => installLocalArtifacts(artifacts, bin)).toThrow();
	expect(readFileSync(sibling, "utf8")).toBe("keep existing addon");
	expect(statSync(sibling).ino).toBe(before);
	expect(statSync(bin).isDirectory()).toBe(true);
	expect(readdirSync(dirname(bin)).sort()).toEqual([basename(bin), basename(sibling)].sort());
});

test("binary/native destination collisions fail before creating parents", () => {
	const root = fixture();
	const artifacts = preflightLocalInstall(built(root), "darwin", "arm64");
	const bin = join(root, "not created", basename(artifacts.natives[0]!));
	expect(() => installLocalArtifacts(artifacts, bin)).toThrow("collides");
	expect(existsSync(dirname(bin))).toBe(false);
});

test("local paths retain HOME defaults and isolated DINOBOT_BIN/DINOBOT_DIST_DIR overrides", () => {
	const root = fixture();
	expect(localInstallPaths({}, root)).toEqual({ bin: join(root, ".local/bin/dinobot"), dist: resolve("dist") });
	expect(localInstallPaths({ DINOBOT_BIN: join(root, "bin with spaces/dinobot"), DINOBOT_DIST_DIR: join(root, "dist with spaces") }, root)).toEqual({ bin: join(root, "bin with spaces/dinobot"), dist: join(root, "dist with spaces") });
});

test("install:local builds and installs the actual host artifacts into paths with spaces", () => {
	const root = fixture();
	const dist = join(root, "dist with spaces");
	const bin = join(root, "install with spaces", "custom dinobot");
	const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
	const proc = Bun.spawnSync([process.execPath, "run", "install:local"], { cwd: repo, env: { ...process.env, DINOBOT_BIN: bin, DINOBOT_DIST_DIR: dist }, stdout: "pipe", stderr: "pipe" });
	if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
	expect(proc.exitCode).toBe(0);
	const natives = discoverNativeArtifacts(repo);
	expect(readdirSync(dist).sort()).toEqual(["dinobot", ...natives.map((path) => basename(path))].sort());
	expect(readdirSync(dirname(bin)).sort()).toEqual(["custom dinobot", ...natives.map((path) => basename(path))].sort());
	expect(Bun.hash(readFileSync(bin))).toBe(Bun.hash(readFileSync(join(dist, "dinobot"))));
	expect(mode(bin)).toBe(0o755);
	for (const source of natives) {
		const installed = join(dirname(bin), basename(source));
		expect(mode(installed)).toBe(0o644);
		expect(Bun.hash(readFileSync(installed))).toBe(Bun.hash(readFileSync(source)));
	}
	for (const binary of [join(dist, "dinobot"), bin]) {
		const version = Bun.spawnSync([binary, "--version"], { stdout: "pipe", stderr: "pipe" });
		expect(version.exitCode).toBe(0);
		expect(version.stdout.toString().trim()).toBe(pkg.version);
	}
}, 30_000);
