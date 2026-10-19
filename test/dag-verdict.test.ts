import { expect, test } from "bun:test";
import { createRun, frontier, retryVerifier, start, succeed } from "../src/core/dag.ts";
import { readVerdict } from "../src/core/dag-verification.ts";
import type { Plan } from "../src/core/plan.ts";

const R1 = "R1 owner toggles skills";
const R2 = "R2 bundled locked";
const covers = [R1, R2];
const req = (id: string, verdict = "pass", extra: Record<string, unknown> = {}) => ({ id, verdict, evidence: `expected vs observed for ${id}`, ...extra });
const verdict = (requirements: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({ version: 1, requirements, summary: "reviewed", repairable: false, ...extra });

test("a strict single verdict reads as before", () => {
	const read = readVerdict(verdict([req(R1), req(R2)]), covers);
	expect(read.ok && read.verdict.requirements.map((r) => r.verdict)).toEqual(["pass", "pass"]);
});

// Regression fixtures modelled on reviewer outputs rejected in a real session although every verdict was pass.
test("extra keys inside requirement objects are ignored (observed: repairable per requirement)", () => {
	const read = readVerdict(verdict([req(R1, "pass", { repairable: false }), req(R2, "pass", { evidence_note_omitted: "n/a" })]), covers);
	expect(read.ok).toBe(true);
	if (read.ok) expect(Object.keys(read.verdict.requirements[0]!).sort()).toEqual(["evidence", "id", "verdict"]);
});
test("extra top-level keys are ignored and not carried over", () => {
	const read = readVerdict(verdict([req(R1), req(R2)], { notes: "x" }), covers);
	expect(read.ok && Object.keys(read.verdict).sort()).toEqual(["repairable", "requirements", "summary", "version"]);
});
test("an invalid first object followed by prose and a corrected object reads the valid one (observed)", () => {
	const raw = `${verdict([req(R1)], { summary: "placeholder" })}\n\nCorrection — the object above is invalid. The final strict JSON is:\n\n${verdict([req(R1), req(R2)])}`;
	const read = readVerdict(raw, covers);
	expect(read.ok && read.verdict.requirements.length).toBe(2);
});
test("code fences and surrounding prose are tolerated; braces inside strings do not confuse extraction", () => {
	const raw = "Here is my verdict:\n```json\n" + verdict([req(R1, "pass", { evidence: "map {a:1} and } stray" }), req(R2)]) + "\n```\nDone.";
	expect(readVerdict(raw, covers).ok).toBe(true);
});
test("an unclosed brace in earlier prose does not hide a verdict printed on its own line", () => {
	const raw = `Notes: the probe printed {unterminated output\n${verdict([req(R1), req(R2)])}`;
	expect(readVerdict(raw, covers).ok).toBe(true);
});
test("any non-pass verdict among several wins (conservative)", () => {
	const raw = `${verdict([req(R1, "fail"), req(R2)])}\n${verdict([req(R1), req(R2)])}`;
	const read = readVerdict(raw, covers);
	expect(read.ok && read.verdict.requirements[0]!.verdict).toBe("fail");
});
test("a negative marker beside an all-pass verdict is a conflicting report, never a pass", () => {
	const raw = `{"version":1,"requirements":[{"id":"${R1}","verdict":"fail"` + `\n${verdict([req(R1), req(R2)])}`;
	const read = readVerdict(raw, covers);
	expect(read.ok).toBe(false);
	expect(!read.ok && read.negative).toBe(true);
});
test("an escaped verdict marker quoted inside evidence is not a negative marker", () => {
	const read = readVerdict(verdict([req(R1, "pass", { evidence: "the old report said {\"verdict\":\"fail\"} before the fix" }), req(R2)]), covers);
	expect(read.ok).toBe(true);
});
test("broken escaping that swallows a requirement is malformed with a reason (observed)", () => {
	const raw = `{"version":1,"requirements":[{"id":"${R1}","verdict":"pass","evidence":"x \\"},{\\"id\\":\\"${R2}\\",\\"verdict\\":\\"pass\\",\\"evidence\\":\\"y"}],"summary":"s","repairable":false}`;
	const read = readVerdict(raw, covers);
	expect(read.ok).toBe(false);
	expect(!read.ok && read.reason).toContain("exactly once");
	expect(!read.ok && read.negative).toBe(false);
});
test.each([
	["missing evidence", verdict([{ id: R1, verdict: "pass" }, req(R2)])],
	["unknown id", verdict([req("other"), req(R2)])],
	["duplicate id", verdict([req(R1), req(R1)])],
	["bad enum", verdict([req(R1, "yes"), req(R2)])],
	["wrong version", JSON.stringify({ version: 2, requirements: [req(R1), req(R2)], summary: "s", repairable: false })],
	["prose only", "looks good to me"],
])("still rejects real protocol violations: %s", (_name, raw) => {
	expect(readVerdict(raw, covers).ok).toBe(false);
});
test("oversized output is rejected but keeps its negative marker", () => {
	const raw = `"verdict":"fail" ` + "x".repeat(30 * 1024);
	const read = readVerdict(raw, covers);
	expect(read.ok).toBe(false);
	expect(!read.ok && read.negative).toBe(true);
});

const plan = (): Plan => ({ nodes: [{ id: "a", kind: "act", writes: ["out"] }, { id: "v", kind: "verify", reads: ["out"], covers: ["R"] }], edges: [["a", "v"]], goal: { requirements: ["R"] } });
test("a verifier executor failure is retried without rejecting the artifact, bounded by attempts", () => {
	const r = createRun("exec", plan(), 0);
	start(r, "a", "actor", 1); succeed(r, "a", "artifact", 2);
	for (let t = 3; r.nodes.v!.status === "pending" || t === 3; t += 2) { start(r, "v", `sa-${t}`, t); retryVerifier(r, "v", "verifier executor failed before a verdict: timeout", t + 1); }
	expect(r.nodes.v!.attempt).toBe(3);
	expect(r.nodes.v!.status).toBe("failed");
	expect(r.rejectedArtifacts ?? []).toEqual([]);
	expect(r.nodes.a!.runs).toBe(1);
	expect(frontier(r)).toEqual([]);
	expect(r.status).toBe("blocked");
});
test("retryVerifier refuses non-verifier nodes", () => {
	const r = createRun("guard", plan(), 0);
	start(r, "a", "actor", 1);
	expect(() => retryVerifier(r, "a", "x", 2)).toThrow("not an ordinary verifier");
});
