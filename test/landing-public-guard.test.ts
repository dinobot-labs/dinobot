import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { scan } from "../script/public-artifact-guard.ts";
import { discoverTests } from "../script/ci/functional-shard.ts";

const roots: string[] = [];
function fixture(paths: Record<string, string>) {
 const root = mkdtempSync(join(tmpdir(), "landing-public-")); roots.push(root);
 for (const [path, text] of Object.entries(paths)) { const dest = join(root, path); mkdirSync(dirname(dest), {recursive:true}); writeFileSync(dest, text); }
 return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, {recursive:true, force:true}); });

test("approved public package coexists with core source", () => {
 const root = fixture({"src/main.ts":"export {};", "services/landing/package.json":"{}", "services/landing/src/worker/app.ts":"export {};", "services/landing/public/fonts/OFL-Geist.txt":"License", "services/landing/docs/migration.md":"Public provenance", "services/landing/test/worker/app.test.ts":"export {};"});
 expect(scan(root)).toEqual([]);
});

test("other and nested services and operational paths remain forbidden", () => {
 for (const path of ["services/private/app.ts", "services/landing-other/src/a.ts", "services/landing/src/services/private.ts", "services/landing/public/reports/a.txt", "services/landing/src/sessions/a.txt", "services/landing/public/exports/a.txt", "services/landing/src/.dinobot/a.txt", "services/landing/public/.git/config", "services/landing/qa/capture.png", "services/landing/.cloudflare/state.txt", "services/landing/.wrangler/state.txt", "services/landing/src/secrets/a.txt", "services/landing/public/.env.local", "services/landing/src/.dev.vars", "services/landing/public/data.sqlite-wal", "services/landing/public/data.db", "services/landing/src/key.pem", "services/landing/private.ts", "services/landing/public/data.db-wal", "services/landing/src/node_modules/package/a.ts", "services/landing/public/dist/a.js", "services/landing/src/.cache/a.txt", "reports/a.txt"]) {
  expect(scan(fixture({[path]:"private"})).length, path).toBeGreaterThan(0);
 }
});

test("landing source still undergoes credential scanning", () => {
 expect(scan(fixture({"services/landing/src/a.ts":"ghp_" + "a".repeat(36)}))).toEqual(["services/landing/src/a.ts: credential pattern"]);
 expect(scan(fixture({"services/landing/public/a.txt":"-----BEGIN PRIVATE KEY-----\n" + "A".repeat(80)}))).toEqual(["services/landing/public/a.txt: private key"]);
});

test("landing symlink cannot escape publication boundary", () => {
 const root = fixture({"services/landing/src/a.ts":"export {};"});
 symlinkSync(join(root, "services/landing/src"), join(root, "services/landing/public"), process.platform === "win32" ? "junction" : "dir");
 expect(scan(root)).toEqual(["services/landing/public: symbolic link"]);
});

test("core discovery leaves exactly the isolated landing package to its own job", async () => {
 const root = fixture({"test/core.test.ts":"", "services/landing/test/worker/app.test.ts":"", "services/landing/test/nested/new.spec.ts":"", "services/landing-other/test/a.test.ts":"", "other/nested/a.spec.ts":""});
 expect(await discoverTests(root)).toEqual(["other/nested/a.spec.ts", "services/landing-other/test/a.test.ts", "test/core.test.ts"]);
 expect(await discoverTests(join(root, "services/landing"))).toEqual(["test/nested/new.spec.ts", "test/worker/app.test.ts"]);
});
