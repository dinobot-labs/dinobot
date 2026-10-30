import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validPrTitle } from "../script/ci/pr-title.ts";
import { violations } from "../script/public-artifact-guard.ts";

const root = join(import.meta.dir, "..");
const load = (name: string) => Bun.YAML.parse(readFileSync(join(root, ".github/workflows", name), "utf8")) as Record<string, any>;
const ci = load("ci.yml");
const release = load("release.yml");

describe("public CI contract", () => {
	test("all jobs hosted, read only by default and actions pinned", () => {
		expect(ci.on.pull_request_target).toBeUndefined();
		expect(ci.on.push.branches).toEqual(["main"]);
		expect(ci.on.pull_request.branches).toEqual(["main"]);
		for (const workflow of [ci, release]) {
			expect(workflow.permissions).toEqual({ contents: "read" });
			expect(workflow.on.pull_request_target).toBeUndefined();
			for (const job of Object.values(workflow.jobs) as any[]) {
				for (const step of job.steps ?? []) {
					if (step.uses) expect(step.uses).toMatch(/^[\w-]+\/[\w-]+@[a-f0-9]{40}$/);
					if (step.uses?.startsWith("actions/checkout@")) expect(step.with["persist-credentials"]).toBe(false);
					if (step.uses?.startsWith("oven-sh/setup-bun@")) expect(step.with["no-cache"]).toBe(true);
				}
			}
		}
		for (const job of Object.values(ci.jobs) as any[]) expect(job["runs-on"]).toBe(job === ci.jobs.test ? "ubuntu-22.04" : "ubuntu-24.04");
		for (const job of Object.values(release.jobs) as any[]) if (!job.uses) expect(job["runs-on"]).toBe("ubuntu-24.04");
		expect(JSON.stringify(ci)).not.toMatch(/secrets\.|npm publish|id-token|self-hosted/);
	});

	test("stable aggregate requires full tests, audited package and performance", () => {
		expect(ci.jobs.gate.name).toBe("CI");
		expect(ci.jobs.gate.if).toBe("always()");
		expect(ci.jobs.gate.needs).toEqual(["test", "package", "performance"]);
		const cmd = ci.jobs.test.steps.map((s: any) => s.run ?? "").join("\n");
		expect(cmd).toContain("bun run typecheck");
		expect(cmd).toContain("runSkillSandbox");
		expect(cmd).toContain("bubblewrap");
		expect(cmd).toContain("timeout 1200 bun test --path-ignore-patterns '**/tui-perf.test.ts'");
		expect(cmd).toContain('HOME="$sandbox"');
		expect(cmd).toContain("public-artifact-guard");
		expect(ci.jobs.performance.steps.some((s: any) => s.run === "bun test test/tui-perf.test.ts" && !s.if && !s["continue-on-error"])).toBe(true);
		expect(ci.jobs.package.steps.some((s: any) => s.run === "bun run release")).toBe(true);
		const upload = ci.jobs.package.steps.find((s: any) => s.id === "upload");
		expect(upload.with.path.trim().split("\n")).toEqual(["dist/npm/dinobot-*.tgz", "dist/npm/SHA512SUMS"]);
	});

	test("the release workflow reuses CI on the exact source; only a package-only retry skips tests", () => {
		expect(ci.on.workflow_call.inputs.source_sha.required).toBe(true);
		expect(ci.on.workflow_call.outputs.artifact_id.value).toBe("${{ jobs.package.outputs.artifact_id }}");
		for (const id of ["test", "performance", "package"]) {
			const checkout = ci.jobs[id].steps.find((s: any) => s.uses?.startsWith("actions/checkout@"));
			expect(checkout.with.ref).toBe("${{ inputs.source_sha || github.sha }}");
		}
		expect(ci.jobs.test.if).toBe("${{ !inputs.package_only }}");
		expect(ci.jobs.performance.if).toBe("${{ !inputs.package_only }}");
		expect(ci.jobs.package.if).toBeUndefined();
		const gate = ci.jobs.gate.steps.find((s: any) => s.run).run as string;
		expect(gate.indexOf('test "$PACKAGE_RESULT" = success')).toBeLessThan(gate.indexOf('if [ "$PACKAGE_ONLY" = true ]'));
	});

	test("OIDC is isolated to publishing the same tested artifact from main", () => {
		expect(release.on.push.branches).toEqual(["main"]);
		expect(release.on.release).toBeUndefined();
		expect(release.concurrency["cancel-in-progress"]).toBe(false);
		expect(release.jobs.checks.uses).toBe("./.github/workflows/ci.yml");
		expect(release.jobs.checks.with.source_sha).toBe("${{ needs.source.outputs.sha }}");
		expect(release.jobs.checks.with.package_only).toBe("${{ github.event_name == 'workflow_dispatch' && !inputs.full_verify }}");
		expect(release.jobs.checks.if).toBe("needs.source.outputs.verify == 'true'");
		expect(release.jobs.release.needs).toEqual(["source", "checks"]);
		expect(release.jobs.release.if).toContain("needs.checks.result == 'success'");
		expect(release.jobs.release.if).toContain("needs.source.outputs.verify == 'false'");
		expect(release.jobs.release.permissions).toEqual({ contents: "write", "pull-requests": "write", actions: "write" });
		const need = release.jobs.source.steps.find((s: any) => s.id === "need").run;
		expect(need.indexOf("verify=false")).toBeLessThan(need.indexOf("verify=true"));
		const current = release.jobs.release.steps.find((s: any) => s.id === "current").run;
		expect(current).toContain('gh api "repos/$GITHUB_REPOSITORY/git/ref/heads/main"');
		const tagGuard = release.jobs.release.steps.find((s: any) => s.name?.startsWith("Fail closed"));
		expect(tagGuard.run).toContain('test "$CHECKS_RESULT" = success');
		expect(tagGuard.run).toContain('gh workflow run release.yml --repo "$GITHUB_REPOSITORY" --ref main -f tag="$RELEASE_TAG" -f full_verify=true');
		for (const [id, job] of Object.entries(release.jobs) as [string, any][]) {
			if (id !== "publish") expect(JSON.stringify(job)).not.toContain("id-token");
		}
		expect(release.jobs.publish.permissions).toEqual({ contents: "read", "id-token": "write" });
		expect(release.jobs.publish.environment).toBe("npm");
		expect(release.jobs.publish.if).toContain("refs/heads/main");
		expect(release.jobs.publish.if).toContain("needs.checks.result == 'success'");
		expect(release.jobs.publish.env.NPM_CONFIG_PROVENANCE).toBe("false");
		const commands = release.jobs.publish.steps.map((s: any) => s.run ?? "").join("\n");
		expect(commands).toContain("sha512sum --check SHA512SUMS");
		expect(commands).toContain("script/release-audit.ts");
		expect(commands).toContain("script/ci/release.ts verify-tag");
		expect(commands).toContain('npm publish "./release-artifact/dinobot-$EXPECTED_VERSION.tgz"');
		expect(commands).toContain("--ignore-scripts --provenance=false");
		expect(commands).not.toContain("bun run release"); // Never rebuild in the privileged publish job.
		expect(JSON.stringify(release)).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|secrets\.|tmdgusya/);
	});

	test("release-please continues from the published 0.8.3 at an explicit no-tag bootstrap boundary", () => {
		const config = JSON.parse(readFileSync(join(root, "release-please-config.json"), "utf8"));
		expect(config["bootstrap-sha"]).toBe("e0083cae62108ec2ad4a6910fe93a9a3efefa197");
		expect(config.packages["."]["release-type"]).toBe("node");
		expect(config.packages["."]["include-component-in-tag"]).toBe(false);
		expect(config.packages["."]["bump-minor-pre-major"]).toBe(false);
		const manifest = JSON.parse(readFileSync(join(root, ".release-please-manifest.json"), "utf8"));
		const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
		expect(manifest["."]).toBe(pkg.version);
		const step = release.jobs.release.steps.find((s: any) => s.id === "release");
		expect(step.with["config-file"]).toBe("release-please-config.json");
		expect(step.with["release-type"]).toBeUndefined();
	});

	test("conventional titles and guard reject real-looking secrets even in fixtures", () => {
		for (const title of ["fix(tui): preserve selection", "feat!: incompatible API", "chore(main): release 0.1.3", "ci: checks"]) expect(validPrTitle(title)).toBe(true);
		for (const title of ["update things", "feat: ", "fix: bug\nfeat: other", "fix(): bug"]) expect(validPrTitle(title)).toBe(false);
		expect(violations("services/app.ts", "")).toContain("forbidden path");
		expect(violations("test/fixtures/key.ts", "ghp_" + "a".repeat(36))).toContain("credential pattern");
		expect(violations("test/fixtures/synthetic.ts", "const token = 'fake';")).toEqual([]);
	});
});
