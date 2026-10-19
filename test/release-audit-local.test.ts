import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { auditReleaseArtifact, createReleaseManifest } from "../script/release-audit.ts";

const roots: string[] = [];
const version = "0.7.15-local.browser.1";
const local = { local: true };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(changes: Record<string, string> = {}, entries?: string[]) {
 const base = join(import.meta.dir, "../dist/npm"); mkdirSync(base, { recursive: true });
 const root = mkdtempSync(join(base, "local-audit-")); roots.push(root);
 mkdirSync(join(root, "package"));
 const contents = { "main.js": "console.log(1);", "browser-host.js": "import { chromium } from \"patchright\";", "codemode-worker.js": "self.onmessage=()=>{};", "package.json": JSON.stringify(createReleaseManifest("dinobot", version, "1.0.0", "1.63.0")), "README.md": "# dinobot", "THIRD_PARTY_NOTICES.txt": "Third-party notices.", ...changes };
 for (const [file, body] of Object.entries(contents)) writeFileSync(join(root, "package", file), body);
 // GNU tar is intentionally retained for exact block-layout validation. No drive-letter archive
 // argument: pipe bytes through stdout, matching the auditor's stdin interface on every platform.
 const result = spawnSync("tar", ["--create", "--gzip", "--format=ustar", "--blocking-factor=1", "--hard-dereference", "--file=-", "--", ...(entries ?? Object.keys(contents)).map(name => "package/" + name)], { cwd: root, env: { PATH: process.env.PATH!, LC_ALL: "C", TZ: "UTC" }, timeout: 10000 });
 expect(result.status).toBe(0);
 const path = join(root, "artifact.tgz"); writeFileSync(path, result.stdout);
 return path;
}

test("explicit local audit admits exact prerelease, public/default audit remains stable-only", () => {
 const path = fixture();
 expect(() => auditReleaseArtifact(path, version)).toThrow("stable SemVer");
 expect(() => auditReleaseArtifact(path, version, "dinobot", local)).not.toThrow();
 expect(() => auditReleaseArtifact(path, "0.7.15-local.browser.2", "dinobot", local)).toThrow("mismatch");
 const stable = "1.2.3+build.7";
 const stablePath = fixture({ "package.json": JSON.stringify(createReleaseManifest("dinobot", stable, "1.0.0", "1.63.0")) });
 expect(() => auditReleaseArtifact(stablePath, stable)).not.toThrow();
});

test("local option rejects malformed versions before reading archive", () => {
 for (const bad of ["01.2.3-local.1", "1.2.3-01", "1.2.3-x..y", "1.2.3-", "1.2.3+", "1.2.3-local.1\n", "latest", "^1.2.3"]) expect(() => auditReleaseArtifact("not-read", bad, "dinobot", local)).toThrow("SemVer");
});

test("local audit preserves every-member allowlist, notices, manifest and content checks", () => {
 const changesets: Record<string, string>[] = [{ "unexpected.txt": "bad" }, { "README.md": "/*# sourceMappingURL=secret.map */" }, { "THIRD_PARTY_NOTICES.txt": "npm_" + "a".repeat(36) }, { "main.js": "C:/Users/build/source/main.ts" }, { "package.json": JSON.stringify({ ...createReleaseManifest("dinobot", version, "1.0.0", "1.63.0"), scripts: {} }) }];
 for (const changes of changesets) expect(() => auditReleaseArtifact(fixture(changes), version, "dinobot", local)).toThrow();
 const names = ["main.js", "browser-host.js", "codemode-worker.js", "package.json", "README.md"];
 expect(() => auditReleaseArtifact(fixture({}, names), version, "dinobot", local)).toThrow("missing archive member");
 expect(() => auditReleaseArtifact(fixture({}, [...names, "THIRD_PARTY_NOTICES.txt", "main.js"]), version, "dinobot", local)).toThrow("duplicate archive member");
});

test("local audit rejects symlink header without requiring Windows symlink privileges", () => {
 const path = fixture(); const bytes = gunzipSync(readFileSync(path));
 bytes[156] = 50; bytes.fill(32, 148, 156);
 const sum = bytes.subarray(0, 512).reduce((a, b) => a + b, 0);
 bytes.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
 writeFileSync(path, gzipSync(bytes));
 expect(() => auditReleaseArtifact(path, version, "dinobot", local)).toThrow();
});

test("local audit CLI explicitly opts in and does not inherit TAR_OPTIONS", () => {
 const path = fixture();
 const run = (args: string[]) => spawnSync(process.execPath, [join(import.meta.dir, "../script/release-audit.ts"), ...args], { encoding: "utf8", timeout: 10000, env: { ...process.env, TAR_OPTIONS: "--definitely-not-a-real-option" } });
 expect(run([path, version]).status).toBe(1);
 const result = run(["--local", path, version]);
 expect(result.stderr).toBe(""); expect(result.status).toBe(0);
 expect(result.stdout).toContain("passed (6 regular members)");
});
