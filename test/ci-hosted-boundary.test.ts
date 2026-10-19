import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const ci = Bun.YAML.parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8")) as any;

test("owned shell scripts are LF and valid bash; patch/vendor bytes stay opaque", () => {
  const listed = Bun.spawnSync(["git", "ls-files", "-z", "*.sh"], { cwd: root });
  expect(listed.exitCode).toBe(0);
  const paths = listed.stdout.toString().split("\0").filter(p => p && !p.startsWith("vendor/") && !p.startsWith("patches/"));
  expect(paths).toContain("script/ci/performance-counters.sh");
  for (const path of paths) {
    expect(readFileSync(join(root, path)).includes(13)).toBe(false);
    expect(Bun.spawnSync(["bash", "-n", path], { cwd: root }).exitCode).toBe(0);
  }
  const attrs = Bun.spawnSync(["git", "check-attr", "text", "eol", "--", "script/ci/performance-counters.sh", "patches/example.patch", "vendor/example.sh"], { cwd: root });
  expect(attrs.exitCode).toBe(0);
  expect(attrs.stdout.toString()).toContain("script/ci/performance-counters.sh: eol: lf");
  expect(attrs.stdout.toString()).toContain("patches/example.patch: text: unset");
  expect(attrs.stdout.toString()).toContain("vendor/example.sh: text: unset");
});

test("hosted sandbox fails closed without host security-policy bypass", () => {
  expect(ci.jobs.test["runs-on"]).toBe("ubuntu-22.04");
  expect(ci.jobs.test["continue-on-error"]).toBeUndefined();
  const probe = ci.jobs.test.steps.find((s: any) => s.name === "Probe the real namespace boundary");
  expect(probe).toBeDefined();
  expect(probe.if).toBeUndefined();
  expect(probe["continue-on-error"]).toBeUndefined();
  expect(probe.run).toContain("runSkillSandbox");
  expect(probe.run).toContain('if(result.status !== "completed") process.exit(1)');
  const commands = ci.jobs.test.steps.map((s: any) => s.run ?? "").join("\n");
  expect(commands).not.toMatch(/sysctl|apparmor_parser|aa-disable|--share-net|continue-on-error/);
  const sandbox = readFileSync(join(root, "src/core/skills/sandbox.ts"), "utf8");
  for (const boundary of ["--unshare-all", "--clearenv", "--ro-bind", "MemoryMax=536870912", "CPUQuota=100%", "TasksMax=64"]) expect(sandbox).toContain(boundary);
  expect(sandbox).not.toContain("--share-net");
  const gate = ci.jobs.gate.steps.find((s: any) => s.run);
  for (const result of ["PACKAGE_RESULT", "TEST_RESULT", "PERFORMANCE_RESULT"]) expect(gate.run).toContain('test "$' + result + '" = success');
});
