#!/usr/bin/env bun
/**
 * Build the package-format tarball that users install from Cloudflare with `bun add -g <url>`.
 *
 *   bun run release                       # -> dist/npm/package/ and dist/npm/<name>-<version>.tgz
 *   bun run release --local               # explicit local-only prerelease artifact; never publishes
 *   DINOBOT_PACKAGE_NAME=@acme/dinobot bun run release
 *
 * The package carries only minified bundles: no TypeScript sources, no source maps, no comments and no
 * repository paths. Every JavaScript dependency (including our patched ones) is bundled, so consumers never
 * see the patches or the dependency tree. Two packages stay external, pinned dependencies: the native addon
 * loader `@oh-my-pi/pi-natives`, because it selects a per-platform `.node` package at install time, and
 * `patchright`, which the browser plugin's child (`browser-host.js`) imports at run time and which loads its own
 * driver files from its package directory.
 *
 * After npm pack, audit the actual archive: exactly six regular files, a minimal manifest, no source
 * maps, build paths, original manifest or credential signatures. Publishing is a separate step:
 *
 *   bun script/ci/publish-cloudflare.ts dist/npm/dinobot-<version>.tgz <version> <source-sha>
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { auditReleaseArtifact, createReleaseManifest, ReleaseAuditError } from "./release-audit.ts";

const local = process.argv.slice(2).length === 1 && process.argv[2] === "--local";
if (process.argv.length > 2 && !local) throw new Error("usage: bun script/release.ts [--local]");

const root = resolve(import.meta.dir, "..");
const outRoot = join(root, "dist/npm");
const pkgDir = join(outRoot, "package");
const repoPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string; dependencies: Record<string, string> };
const name = process.env.DINOBOT_PACKAGE_NAME ?? "dinobot";
const NATIVE = "@oh-my-pi/pi-natives";
const nativeVersion = (JSON.parse(readFileSync(join(root, "node_modules", NATIVE, "package.json"), "utf8")) as { version: string }).version;
const PATCHRIGHT = "patchright";
// The exact pin from package.json (no range); the installed copy the tests ran against must match it.
const patchrightVersion = repoPkg.dependencies[PATCHRIGHT] ?? "";
const installedPatchright = (JSON.parse(readFileSync(join(root, "node_modules", PATCHRIGHT, "package.json"), "utf8")) as { version: string }).version;

function fail(message: string): never {
	console.error(`release: ${message}`);
	process.exit(1);
}

if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(patchrightVersion)) fail(`package.json must pin ${PATCHRIGHT} to an exact version`);
if (installedPatchright !== patchrightVersion) fail(`installed ${PATCHRIGHT} ${installedPatchright} does not match package.json ${patchrightVersion}; run bun install`);

rmSync(outRoot, { recursive: true, force: true });
mkdirSync(pkgDir, { recursive: true });

// The worker URL points at the .ts source in dev and in `bun build --compile`; the plain bundle emits .js.
const releasePlugin: Bun.BunPlugin = {
	name: "dinobot-release",
	setup(build) {
		build.onLoad({ filter: /[\\/]src[\\/]codemode-assets\.ts$/ }, () => ({
			loader: "ts",
			contents: 'export const codemodeAssets = { workerUrl: new URL("./codemode-worker.js", import.meta.url) };',
		}));
		// main.ts imports package.json for its version; do not ship scripts, patches and the dependency list.
		const repoManifest = join(root, "package.json");
		build.onLoad({ filter: /[\\/]package\.json$/ }, (args) => args.path === repoManifest
			? { loader: "json", contents: JSON.stringify({ version: repoPkg.version }) }
			: undefined);
	},
};

// The browser plugin's host child is a third entry, emitted as host.js and renamed to browser-host.js: the name
// src/plugins/browser/index.ts resolves next to main.js (in the bundle its import.meta.url is main.js's URL).
const result = await Bun.build({
	entrypoints: [join(root, "src/main.ts"), join(root, "src/codemode-worker.ts"), join(root, "src/plugins/browser/host.ts")],
	root: join(root, "src"),
	outdir: pkgDir,
	naming: "[name].[ext]",
	target: "bun",
	format: "esm",
	minify: true,
	sourcemap: "none",
	splitting: false,
	external: [NATIVE, `${NATIVE}/*`, PATCHRIGHT, `${PATCHRIGHT}/*`, "patchright-core", "patchright-core/*"],
	drop: ["debugger"],
	define: { "process.env.DINOBOT_BUILD": JSON.stringify("npm") },
	plugins: [releasePlugin],
	metafile: true,
});
if (!result.success) {
	for (const log of result.logs) console.error(log);
	fail("bundle failed");
}
for (const log of result.logs) console.warn(log);

const hostPath = join(pkgDir, "browser-host.js");
renameSync(join(pkgDir, "host.js"), hostPath);
// Bun keeps a leading `// @bun` pragma; the bin entry also needs a shebang ahead of it.
const mainPath = join(pkgDir, "main.js");
writeFileSync(mainPath, "#!/usr/bin/env bun\n" + readFileSync(mainPath, "utf8"), { mode: 0o755 });

// Third-party notices for every bundled package (minification strips their license comments).
const rawMeta: unknown = result.metafile;
const meta = (typeof rawMeta === "string" ? JSON.parse(rawMeta) : rawMeta) as { inputs: Record<string, unknown> };
const bundled = new Map<string, string>();
// patchright must stay an import of the installed dependency, never inlined (it is not in the notices either).
if (Object.keys(meta.inputs).some((input) => /node_modules[\\/]patchright(?:-core)?[\\/]/.test(input))) fail("patchright was bundled; it must stay external");
if (!/["']patchright["']/.test(readFileSync(hostPath, "utf8"))) fail("browser-host.js does not import patchright");
for (const input of Object.keys(meta.inputs)) {
	const path = input.replaceAll("\\", "/");
	const at = path.lastIndexOf("node_modules/");
	if (at < 0) continue;
	const match = /^((?:@[^/]+\/)?[^/]+)/.exec(path.slice(at + "node_modules/".length));
	if (match?.[1]) bundled.set(match[1], resolve(root, path.slice(0, at + "node_modules/".length + match[1].length)));
}
const notices: string[] = [readFileSync(join(root, "LICENSE"), "utf8"), readFileSync(join(root, "THIRD_PARTY_NOTICES.md"), "utf8")];
for (const [dep, dir] of [...bundled].sort(([a], [b]) => a.localeCompare(b))) {
	if (!existsSync(join(dir, "package.json"))) continue;
	const info = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: string; license?: string };
	const licenseFile = readdirSync(dir).find((file) => /^(licen[cs]e|copying|notice)/i.test(file));
	notices.push([
		`${dep}@${info.version ?? "?"} (${info.license ?? "license not declared"})`,
		licenseFile ? readFileSync(join(dir, licenseFile), "utf8").trim() : "(no license file shipped by the package)",
	].join("\n\n"));
}
writeFileSync(join(pkgDir, "THIRD_PARTY_NOTICES.txt"), notices.join("\n\n" + "-".repeat(72) + "\n\n") + "\n");

writeFileSync(join(pkgDir, "README.md"), [
	`# ${name}`,
	"",
	"dinobot — source-available agent daemon and TUI.",
	"PolyForm Noncommercial 1.0.0; not OSI-approved open source. Commercial permission: dev0jsh@gmail.com.",
	"",
	"## Install",
	"",
	"Requires [Bun](https://bun.sh) 1.4 or newer.",
	"",
	"```sh",
	`bun add -g https://releases.dinobot.workers.dev/core/releases/${repoPkg.version}/dinobot-${repoPkg.version}.tgz`,
	"dinobot",
	"```",
	"",
	"Update with `dinobot update` (preserves the current Bun/npm global installation). The TUI shows a notice when a newer release is available.",
	"Set `DINOBOT_NO_UPDATE_CHECK=1` to disable automatic checks. Updates restart the daemon by default and can interrupt active work; use `dinobot update --no-restart` to leave it running, then reopen the TUI.",
	"Older npm releases need this URL install once to switch update channels. Third-party dependencies still download from npm; publishing Dinobot does not require an npm account.",
	"",
	"The first run creates `~/.config/dinobot/dinobot.yaml` with local defaults; sign in to a model with `/login`.",
	"Configuration is read from `--config <path>`, `$DINOBOT_CONFIG`, `./dinobot.yaml` or that file.",
	"",
].join("\n"));

writeFileSync(join(pkgDir, "package.json"), JSON.stringify(
	createReleaseManifest(name, repoPkg.version, nativeVersion, patchrightVersion), null, 2,
) + "\n");

const pack = Bun.spawnSync(["npm", "pack", "--ignore-scripts", "--pack-destination", outRoot], {
	cwd: pkgDir, stdout: "pipe", stderr: "pipe", timeout: 60_000,
	env: { ...process.env, npm_config_cache: join(outRoot, ".npm-cache") },
});
if (pack.exitCode !== 0) fail("npm pack failed");
const tarball = pack.stdout.toString().trim().split("\n").at(-1)!;
if (!tarball || tarball.includes("/") || tarball.includes("\\") || !tarball.endsWith(".tgz")) fail("unexpected npm pack output");
try {
	auditReleaseArtifact(join(outRoot, tarball), repoPkg.version, name, { local });
} catch (error) {
	fail(error instanceof ReleaseAuditError ? error.message : "artifact audit failed");
}
const size = (file: string) => `${(statSync(file).size / 1024 / 1024).toFixed(1)} MB`;
console.log(`release: ${name}@${repoPkg.version}`);
console.log(`  main.js            ${size(mainPath)}`);
console.log(`  codemode-worker.js ${size(join(pkgDir, "codemode-worker.js"))}`);
console.log(`  browser-host.js    ${size(hostPath)} (imports ${PATCHRIGHT}@${patchrightVersion})`);
console.log(`  notices            ${notices.length} bundled packages`);
console.log(`  tarball            ${join(outRoot, tarball)} (${size(join(outRoot, tarball))})`);
if (local) console.log("release: local artifact only; not published");
else console.log("release: audited tarball ready for Cloudflare publication; no npm login or publish required");
