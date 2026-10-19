import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { validPrTitle } from "../script/ci/pr-title.ts";
import { violations } from "../script/public-artifact-guard.ts";
const root=join(import.meta.dir,"..");
const ci=Bun.YAML.parse(readFileSync(join(root,".github/workflows/ci.yml"),"utf8")) as any;
describe("public CI contract",()=>{
 test("all jobs hosted, read only and actions pinned",()=>{
 expect(ci.permissions).toEqual({contents:"read"});expect(ci.on.pull_request_target).toBeUndefined();
 expect(ci.on.push.branches).toEqual(["main"]);expect(ci.on.pull_request.branches).toEqual(["main"]);
 for(const job of Object.values(ci.jobs) as any[]){expect(job["runs-on"]).toBe("ubuntu-24.04");for(const step of job.steps??[]){if(step.uses)expect(step.uses).toMatch(/^[\w-]+\/[\w-]+@[a-f0-9]{40}$/);if(step.uses?.startsWith("actions/checkout@"))expect(step.with["persist-credentials"]).toBe(false);}}
 expect(JSON.stringify(ci)).not.toMatch(/secrets\.|npm publish|id-token|self-hosted/);expect(existsSync(join(root,".github/workflows/release.yml"))).toBe(false);
 });
 test("stable aggregate requires full tests, audited package and performance",()=>{
 expect(ci.jobs.gate.name).toBe("CI");expect(ci.jobs.gate.if).toBe("always()");expect(ci.jobs.gate.needs).toEqual(["test","package","performance"]);
 const cmd=ci.jobs.test.steps.map((s:any)=>s.run??"").join("\n");expect(cmd).toContain("bun run typecheck");expect(cmd).toContain("runSkillSandbox");expect(cmd).toContain("bubblewrap");expect(cmd).toContain("timeout 1200 bun test --path-ignore-patterns '**/tui-perf.test.ts'");expect(cmd).toContain('HOME="$sandbox"');expect(cmd).toContain("public-artifact-guard");
 expect(ci.jobs.performance.steps.some((s:any)=>s.run==="bun test test/tui-perf.test.ts"&&!s.if&&!s["continue-on-error"])).toBe(true);
 expect(ci.jobs.package.steps.some((s:any)=>s.run==="bun run release")).toBe(true);
 });
 test("conventional titles and guard reject real-looking secrets even in fixtures",()=>{
 expect(validPrTitle("fix(tui): preserve selection")).toBe(true);expect(validPrTitle("update things")).toBe(false);
 expect(violations("services/app.ts","")).toContain("forbidden path");expect(violations("test/fixtures/key.ts","ghp_"+"a".repeat(36))).toContain("credential pattern");expect(violations("test/fixtures/synthetic.ts","const token = 'fake';")).toEqual([]);
 });
});
