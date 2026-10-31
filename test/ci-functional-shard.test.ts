import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { discoverTests, partitionTests, exactTestArguments } from "../script/ci/functional-shard.ts";
import { parseTimings } from "../script/ci/import-functional-timings.ts";
import { XMLParser } from "fast-xml-parser";

const roots: string[] = [];
const runner = resolve(import.meta.dir, "../script/ci/functional-shard.ts");
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "dinobot-shard-"));
  roots.push(root);
  for (const [file, body] of Object.entries(files)) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), body);
  }
  return root;
}
function passing(name: string) {
  return 'import { test } from "bun:test"; test("fixture", () => console.log(' + JSON.stringify("RAN " + name) + '));';
}
async function run(root: string, args: string[]) {
  const child = Bun.spawn([process.execPath, ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, stderr, ran: stdout.split(/\r?\n/).filter(line => line.startsWith("RAN ")).map(line => line.slice(4)).sort() };
}

test("discovery agrees with real Bun for every default suffix/extension and exclusions", async () => {
  const files: Record<string, string> = {};
  for (const suffix of [".test", "_test", ".spec", "_spec"]) {
    for (const ext of ["js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts"]) {
      const name = "nested/a" + suffix + "." + ext;
      files[name] = passing(name);
    }
  }
  for (const name of [".hidden/a.test.ts", "node_modules/a.test.ts", "helper.ts", "tui-perf.test.ts", "nested/tui-perf.test.ts", ".hidden.test.ts"]) files[name] = passing(name);
  const root = await fixture(files);
  const baseline = await run(root, ["test", "--path-ignore-patterns", "**/tui-perf.test.ts"]);
  expect(baseline.code).toBe(0);
  expect(await discoverTests(root)).toEqual(baseline.ran);
});

test("LPT is balanced and deterministic, includes new files, ignores obsolete profile keys", () => {
  const files = ["a.test.ts", "b.test.ts", "c.test.ts", "d.test.ts", "new.test.ts"];
  const profile = { "a.test.ts": 80, "b.test.ts": 70, "c.test.ts": 30, "d.test.ts": 20, "deleted.test.ts": 10 };
  const buckets = partitionTests(files, profile, 2);
  expect(buckets).toEqual(partitionTests([...files].reverse(), profile, 2));
  expect(buckets.map(bucket => bucket.estimatedMs)).toEqual([110, 120]);
  expect(buckets.flatMap(bucket => bucket.files).sort()).toEqual(files.sort());
  expect(partitionTests(files, {}, 2).flatMap(bucket => bucket.files).sort()).toEqual(files.sort());
  expect(partitionTests(files, profile, 1)[0]!.files).toEqual(files.sort());
  expect(partitionTests(["a", "b"], { a: 0, b: 0 }, 2).map(bucket => bucket.files)).toEqual([["a"], ["b"]]);
});

test("two real shard executions cover baseline exactly once; exact paths do not substring match", async () => {
  const names = ["a.test.ts", "prefix-a.test.ts", "nested/a.test.ts", "nested/new_spec.mts", "space dir/a.test.ts"];
  const root = await fixture(Object.fromEntries(names.map(name => [name, passing(name)])));
  const exact = await run(root, ["test", ...exactTestArguments(["a.test.ts"])]);
  expect(exact.code).toBe(0);
  expect(exact.ran).toEqual(["a.test.ts"]);
  const baseline = await run(root, [runner, "1/1"]);
  const first = await run(root, [runner, "1/2"]);
  const second = await run(root, [runner, "2/2"]);
  expect([baseline.code, first.code, second.code]).toEqual([0, 0, 0]);
  expect([...first.ran, ...second.ran].sort()).toEqual(baseline.ran);
  expect(baseline.ran).toEqual(names.sort());
  for (const part of ["1-of-1", "1-of-2", "2-of-2"]) {
    const report = JSON.parse(await readFile(join(root, "reports", "functional-" + part, "selection.json"), "utf8"));
    const xml = await readFile(join(root, "reports", "functional-" + part, "junit.xml"), "utf8");
    expect(report.discovered).toBe(names.length);
    const parsed = new XMLParser({ ignoreAttributes: false }).parse(xml);
    const rawSuites = parsed.testsuites.testsuite;
    const suites = Array.isArray(rawSuites) ? rawSuites : [rawSuites];
    expect(suites.map(suite => String(suite["@_file"]).replaceAll("\\", "/")).sort()).toEqual(report.files);
    for (const suite of suites) expect(Number(suite["@_time"])).toBeGreaterThanOrEqual(0);
  }
});

test("test failures and explicit child exit codes propagate", async () => {
  const root = await fixture({ "fail.test.ts": 'import {test,expect} from "bun:test"; test("fails", () => expect(1).toBe(2));' });
  expect((await run(root, [runner, "1/1"])).code).toBe(1);
  await writeFile(join(root, "fail.test.ts"), 'process.exit(7);');
  expect((await run(root, [runner, "1/1"])).code).toBe(7);
});

test("unknown, empty, duplicate and malformed selections fail closed", async () => {
  const root = await fixture({});
  expect((await run(root, [runner, "1/1"])).code).not.toBe(0);
  for (const selection of ["0/2", "3/2", "2/1", "1/3"]) expect((await run(root, [runner, selection])).code).not.toBe(0);
  await writeFile(join(root, "a.test.ts"), passing("a.test.ts"));
  expect((await run(root, [runner, "2/2"])).code).not.toBe(0);
  expect((await run(root, [runner, "1/1", "--unknown"])).code).not.toBe(0);
  expect(() => partitionTests(["a", "a"], {}, 2)).toThrow();
  expect(() => partitionTests(["a", "b"], { a: NaN }, 2)).toThrow();
  for (const files of [[], ["../a.test.ts"], ["/a.test.ts"], ["a\\b.test.ts"]]) expect(() => exactTestArguments(files)).toThrow();
});

test.skipIf(process.platform === "win32")("child signal cannot become wrapper success", async () => {
  const root = await fixture({ "signal.test.ts": 'process.kill(process.pid, "SIGTERM");' });
  const result = await run(root, [runner, "1/1"]);
  expect(result.code).not.toBe(0);
});

test("timing import sums actual durations by file, retaining zero-duration files", () => {
  expect(parseTimings("prefix ##[group]test/a.test.ts:\n(pass) first [12.50ms]\n(pass) second [2.25ms]\n##[group]test/b.spec.ts:\n(skip) third\n")).toEqual({ "test/a.test.ts": 14.75, "test/b.spec.ts": 0 });
  expect(() => parseTimings("no headers")).toThrow();
  expect(() => parseTimings("a.test.ts:\na.test.ts:")).toThrow();
});
