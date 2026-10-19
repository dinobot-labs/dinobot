import { afterEach, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { digest, fingerprint, nativeSettled, parseBunReport, type CheckMethod } from "../src/core/verification-execution.ts";
import { clone } from "../src/core/json.ts";
import { inspectWorkflow, repairMethod, validEvidence, validateContract, validateMethod, type AcceptanceContract, type Evidence, type Work } from "../src/core/verification.ts";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const contract: AcceptanceContract = { requirements: [{ id: "r", assertion: "addition is correct", checkIds: ["a", "b"], scenarioIds: ["s"] }], scenarios: [{ id: "s", assertion: "1+1=2" }], checks: ["a", "b"].map(id => ({ id, requirementIds: ["r"], scenarioIds: ["s"], evidence: "behavioral", expected: "1+1=2" })) };
function method(root = "/tmp"): CheckMethod { return { command: "bun", cwd: root, runner: "bun", args: ["addition.test.ts"], timeout: 60, adapterVersion: 1, locators: [{ scenarioId: "s", file: "addition.test.ts", name: "adds" }] }; }
function work(): Work { const m = method(); return { id: "w", state: "implementing", version: 1, contract: clone(contract), contractHash: digest(contract), scope: { root: "/tmp", inputs: [], disposable: [] }, hostHash: "host", methodEpoch: 1, mutationEpoch: 0, methods: Object.fromEntries(["a", "b"].map(id => [id, [{ revision: 1, method: m, hash: digest(m), rationale: "initial", priorAttemptIds: [], taskId: "t", at: 1 }]])), sourceIds: ["source"], costs: { attempts: 4, repairs: 0, seconds: 240, coaching: 0, slots: ["a", "b"] }, noProgress: { old: 2 }, operations: {}, blockers: [] }; }
function evidence(w: Work, id: string): Evidence { return { id, taskId: id, workId: w.id, checkId: id, status: "passed", contractHash: w.contractHash, version: 1, methodEpoch: 1, methodHash: w.methods[id]![0]!.hash, mutationEpoch: 0, before: "F", after: "F", signature: id, timeout: 60, observation: { command: "bun test", cwd: "/tmp", exitCode: 0, error: null, durationMs: 1, output: "large output", report: "large report", truncated: false, observed: ["s"], passed: true, quiescent: true } }; }

test("fast-exit receipt without native identity stays non-quiescent", () => {
	// Retained Linux CI counterexample: echo/exit finished before /proc identity read.
	const identity = { nonce: "fast-exit", pid: 1941, startTime: null, controlled: false };
	expect(nativeSettled([
		{ ...identity, phase: "admitted", pid: null },
		{ ...identity, phase: "started" },
		{ ...identity, phase: "settled", code: 1, signal: null, canonical: false },
	])).toBe(false);
});

test("required coverage rejects empty, optional and dangling contracts", () => {
	for (const malformed of [{ requirements: [], scenarios: [], checks: [] }, { ...contract, checks: [] }, { ...contract, checks: contract.checks.map(c => ({ ...c, optional: true })) }, { ...contract, scenarios: [{ id: "different", assertion: "different" }] }]) expect(() => validateContract(malformed as AcceptanceContract)).toThrow();
	validateContract(contract);
});
test("repair keeps immutable acceptance, invalidates every slot and preserves lifetime costs", () => {
	const w = work(); const receipts = [evidence(w, "a"), evidence(w, "b")]; expect(receipts.every(e => validEvidence(e, w, "F"))).toBe(true);
	const next = repairMethod(w, "a", 1, { ...method(), args: ["corrected.test.ts"] }, "Prior path was misspelled; assertions/scenarios unchanged", [], "repair");
	expect(next.contract).toEqual(w.contract); expect(next.methodEpoch).toBe(2); expect(next.costs.attempts).toBe(4); expect(next.costs.seconds).toBe(240); expect(next.noProgress).toEqual({ old: 2 }); expect(next.costs.repairs).toBe(1);
	expect(receipts.some(e => validEvidence(e, next, "F"))).toBe(false);
	expect(repairMethod(next, "a", 1, { ...method(), args: ["corrected.test.ts"] }, "same replay", [], "repair")).toEqual(next);
	expect(() => repairMethod(next, "a", 1, method(), "stale CAS", [], "new")).toThrow("method_revision_conflict");
});
test("identical method and rationale changes do not reset counters or epochs", () => { const w = work(); expect(repairMethod(w, "a", 1, method(), "a new rationale is not progress", [], "noop")).toEqual(w); });
test("repairs cannot lower behavioral class or locator coverage or extend scope", () => {
	const check = contract.checks[0]!; const scope = work().scope;
	for (const m of [{ ...method(), runner: "process" }, { ...method(), locators: [] }, { ...method(), expected: "always pass" }, { ...method(), cwd: "/elsewhere" }, { ...method(), timeout: 121 }]) expect(() => validateMethod(m as CheckMethod, check, scope)).toThrow();
});
test("32 effective repairs exhausted, but there is no three-failure cap", () => {
	let w = work(); w.costs.attempts = 10;
	for (let i = 0; i < 32; i++) w = repairMethod(w, "a", i + 1, { ...method(), args: [`path-${i}.test.ts`] }, "Repair actual locator", [], `repair-${i}`);
	expect(w.costs.attempts).toBe(10); expect(w.methods.a).toHaveLength(33);
	expect(() => repairMethod(w, "a", 33, method(), "another", [], "exhausted")).toThrow("lifetime_repair_budget");
});
test("content changes and unknown effects cannot satisfy receipts; status omits report bodies", () => {
	const w = work(); const e = evidence(w, "a"); expect(validEvidence(e, w, "different")).toBe(false); expect(validEvidence({ ...e, status: "unknown" }, w, "F")).toBe(false);
	const status = inspectWorkflow({ works: [w], activeId: w.id, sources: { source: { kind: "linked", workId: w.id, contractHash: w.contractHash, version: 1 } } }, [e]);
	expect(JSON.stringify(status)).not.toContain("large output"); expect(JSON.stringify(status)).not.toContain("large report");
	expect(inspectWorkflow({ works: [w], activeId: w.id, sources: {} }, [e], "late").status).toBe("planning");
});
function report(testcase: string, tests = 1, skipped = 0) { return `<?xml version="1.0"?><testsuites name="bun test" tests="${tests}" failures="0" skipped="${skipped}"><testsuite name="addition.test.ts" tests="${tests}" failures="0">${testcase}</testsuite></testsuites>`; }
test("Bun adapter accepts named executed cases even with node:assert and rejects skipped/forged aggregates", () => {
	const passed = '<testcase name="adds" file="addition.test.ts" assertions="0" />';
	expect(parseBunReport(report(passed), method(), contract.checks[0]!)).toEqual(["s"]);
	for (const text of [report('<testcase name="adds" file="addition.test.ts"><skipped /></testcase>', 1, 1), report('<testcase name="adds" file="addition.test.ts"><failure /></testcase>'), report(passed, 2), report(passed).slice(0, -10), '<!DOCTYPE x [<!ENTITY e "payload">]>' + report(passed)]) expect(() => parseBunReport(text, method(), contract.checks[0]!)).toThrow();
	expect(parseBunReport(report(passed.replace('name="adds"', 'name="unrelated"')), method(), contract.checks[0]!)).toEqual([]);
});
test("non-git shared content F excludes only host runtime paths and detects declared collisions", async () => {
	const root = await mkdtemp(resolve(tmpdir(), "work-fingerprint-")); roots.push(root); await mkdir(resolve(root, "data")); await writeFile(resolve(root, "input.ts"), "export const value = 1;");
	const host = { files: [resolve(root, "data", "runtime.sqlite"), resolve(root, "data", "runtime.sqlite-wal")], directories: [resolve(root, "reports")] }; const scope = { root, inputs: [], disposable: [] };
	const first = await fingerprint(scope, host, "node:local", BACKGROUND_CONTEXT); await writeFile(host.files[0]!, "runtime"); await writeFile(host.files[1]!, "wal");
	expect((await fingerprint(scope, host, "node:local", BACKGROUND_CONTEXT)).hash).toBe(first.hash);
	await writeFile(resolve(root, "input.ts"), "export const value = 2;"); expect((await fingerprint(scope, host, "node:local", BACKGROUND_CONTEXT)).hash).not.toBe(first.hash);
	await expect(fingerprint({ ...scope, inputs: ["data/runtime.sqlite"] }, host, "node:local", BACKGROUND_CONTEXT)).rejects.toThrow("runtime_input_collision");
});

test("real Git inventory includes tracked deletion, new input and tracked runtime collision", async () => {
	const root = await mkdtemp(resolve(tmpdir(), "work-git-fingerprint-")); roots.push(root);
	const git = async (...args: string[]) => {
		const child = Bun.spawn(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
		const [code, , error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
		if (code !== 0) throw new Error(`Git fixture failed: ${error}`);
	};
	await git("init", "--quiet");
	await writeFile(resolve(root, "tracked.ts"), "export const answer = 42;\n");
	await git("add", "tracked.ts");
	const scope = { root, inputs: [], disposable: [] };
	const host = { files: [] as string[], directories: [] as string[] };
	const initial = await fingerprint(scope, host, "node:local", BACKGROUND_CONTEXT);
	await rm(resolve(root, "tracked.ts"));
	const deleted = await fingerprint(scope, host, "node:local", BACKGROUND_CONTEXT);
	expect(deleted.hash).not.toBe(initial.hash);
	await writeFile(resolve(root, "new.ts"), "export const added = true;\n");
	expect((await fingerprint(scope, host, "node:local", BACKGROUND_CONTEXT)).hash).not.toBe(deleted.hash);
	await writeFile(resolve(root, "runtime.sqlite"), "actually a tracked project input");
	await git("add", "-f", "runtime.sqlite");
	await expect(fingerprint(scope, { files: [resolve(root, "runtime.sqlite")], directories: [] }, "node:local", BACKGROUND_CONTEXT)).rejects.toThrow("runtime_input_collision");
});

test("all 16 combinations of independent method faults are reported in a single inspection", async () => {
	const { methodIssues } = await import("../src/core/verification.ts");
	const codes = ["unsupported_required_runner", "unsupported_runner_argument", "invalid_method", "invalid_locator"];
	for (let mask = 0; mask < 16; mask++) {
		const candidate = method();
		if (mask & 1) candidate.runner = "process";
		if (mask & 2) candidate.args = ["--eval"];
		if (mask & 4) candidate.timeout = 121;
		if (mask & 8) candidate.locators[0]!.file = "/outside.ts";
		const issues = methodIssues(candidate, contract.checks[0]!, work().scope);
		for (let bit = 0; bit < 4; bit++) expect(issues.some(issue => issue.code === codes[bit])).toBe(Boolean(mask & (1 << bit)));
	}
});
