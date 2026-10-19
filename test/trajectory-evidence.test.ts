import { describe, expect, test } from "bun:test";
import { ARGUMENT_LIMITS, canonicalArguments, evidenceGraph, EVIDENCE_LIMITS } from "../src/core/trajectory/evidence.ts";
import { gradeTrace, TRAJECTORY_STEP_LIMIT } from "../src/core/trajectory/engine.ts";
import type { Step, StepProvenance } from "../src/core/trajectory/types.ts";

const call = (n: number, tool: string, args: unknown, order?: Step["order"], ok = true): Step => ({ n, entryId: n, kind: "call", tool, args, argsText: JSON.stringify(args)?.slice(0, 16000), ok, ...(order ? { order } : {}) });
const grade = (steps: Step[]) => gradeTrace({ steps, ownedBy: 1, parentClaimed: true });
const write = (n: number, invoked: number, result: number) => call(n, "write", { path: "a.ts" }, { invoked, result });
const check = (n: number, invoked: number, result: number, ok = true) => call(n, "bash", { command: "bun test" }, { invoked, result }, ok);
const answer = (n: number, invoked: number): Step => ({ n, entryId: n, kind: "assistant", order: { invoked }, text: "Tests passed" });
const provenance: StepProvenance = { id: "one", source: { conversationId: 1, entryId: 2, byTaskId: 3, entryKind: "pi.assistant", messageIndex: 0 }, origin: "model" };

describe("full bounded argument identity", () => {
 test("recursively sorts only keys and preserves inputs", () => {
  const a = { b: { z: 1, a: [1, { b: 2, a: 3 }] }, a: "C:\\X  Y" };
  const original = JSON.stringify(a);
  expect(canonicalArguments(a)).toBe(canonicalArguments({ a: "C:\\X  Y", b: { a: [1, { a: 3, b: 2 }], z: 1 } }));
  expect(JSON.stringify(a)).toBe(original);
 });
 test.each([
  [{ path: "A/../b" }, { path: "b" }], [{ text: "a  b" }, { text: "a b" }],
  [{ xs: [1, 2] }, { xs: [2, 1] }], [{ value: "1" }, { value: 1 }],
  [{ path: "A" }, { path: "a" }], [{ value: -0 }, { value: 0 }],
 ])("does not invent equivalence: %j / %j", (a, b) => expect(canonicalArguments(a)).not.toBe(canonicalArguments(b)));
 test("truncated display prefixes cannot create equality", () => {
  const a = call(1, "read", { path: "x".repeat(17000) + "a" }, undefined, false);
  const b = call(2, "read", { path: "x".repeat(17000) + "b" });
  expect(a.argsText).toBe(b.argsText);
  expect(grade([a, b]).violations.some(v => v.rule === "blind-retry")).toBe(false);
 });
 test.each([undefined, null, [], "{}", { value: undefined }, { value: NaN }, { value: Infinity }, { value: 1n }, { value: new Date(0) }].map(args => [args]))("invalid/missing arguments have no identity: %s", args => {
  expect(canonicalArguments(args)).toBeUndefined();
  const a: Step = { n: 1, entryId: 1, kind: "call", tool: "read", args, ok: false };
  expect(grade([a, { ...a, n: 2 }]).violations.some(v => v.rule === "blind-retry")).toBe(false);
 });
 test("cycles, getters, sparse arrays and explicit limits are rejected safely", () => {
  const cyclic: any = {}; cyclic.self = cyclic;
  let accessed = false;
  const accessor = { get value() { accessed = true; return 1; } };
  let deep: unknown = {}; for (let i = 0; i < 40; i++) deep = { deep };
  for (const args of [cyclic, accessor, { value: Array(1) }, deep, { text: "x".repeat(ARGUMENT_LIMITS.characters) }, { values: Array(5000).fill(1) }]) expect(canonicalArguments(args)).toBeUndefined();
  expect(accessed).toBe(false);
 });
});

describe("causal checks and unresolved evidence", () => {
 test.each([[1, 3, 2, 4], [1, 4, 2, 3], [1, 4, 1, 4], [2, 4, 1, 3]])("overlap cannot causally cover a mutation: %j", (mi, mr, vi, vr) => {
  const g = grade([write(1, mi, mr), check(2, vi, vr), answer(3, 5)]);
  expect(g.checks[0]?.passed).toBe(true);
  expect(g.checks[0]?.satisfiesModifications).toEqual([]);
  expect(g.checks[0]?.ordering).toBe("UNKNOWN");
  expect(g.coverage.reasons).toContain("verification_order_unknown");
  expect(g.unresolved.some(u => u.rule === "unverified-change")).toBe(true);
  expect(g.violations.some(v => v.rule === "unverified-change" || v.rule === "claim-mismatch")).toBe(false);
  expect(g.verdict).toBe("INCOMPLETE");
 });
 test("strictly later invocation covers modification", () => {
  const g = grade([write(1, 1, 2), check(2, 3, 4), answer(3, 5)]);
  expect(g.checks[0]?.satisfiesModifications).toEqual([1]);
  expect(g.verdict).toBe("PASS");
 });
 test("a check already completed before mutation is not an overlap excuse", () => {
  const g = grade([check(1, 1, 2), write(2, 3, 4), answer(3, 5)]);
  expect(g.violations.some(v => v.rule === "unverified-change")).toBe(true);
  expect(g.unresolved).toEqual([]);
 });
 test("late result is not success available to an earlier pass claim", () => {
  for (const ok of [true, false]) {
   const g = grade([write(1, 1, 2), check(2, 3, 6, ok), answer(3, 4)]);
   expect(g.coverage.reasons).toContain("claim_order_unknown");
   expect(g.violations.some(v => v.rule === "claim-mismatch")).toBe(false);
  }
 });
 test("overlap does not hide separate known failures or unverified mutations", () => {
  const g = grade([write(1, 1, 4), check(2, 2, 3), write(3, 5, 6), call(4, "bash", { command: "git push origin main" }, { invoked: 7, result: 8 })]);
  expect(g.unresolved.some(u => u.step === 1)).toBe(true);
  expect(g.violations.some(v => v.rule === "unverified-change" && v.step === 3)).toBe(true);
  expect(g.violations.some(v => v.rule === "risky-without-ask")).toBe(true);
  expect(g.ruleVerdict).toBe("FAIL");
 });
 test("failed overlapping check is still failed evidence, not a successful possible check", () => {
  const g = grade([write(1, 1, 4), check(2, 2, 3, false), answer(3, 5)]);
  expect(g.violations.some(v => v.rule === "unverified-change")).toBe(true);
  expect(g.violations.find(v => v.rule === "claim-mismatch")?.why).toContain("실패");
 });
 test("all mutation result bounds matter, not just last flattened mutation", () => {
  const g = grade([write(1, 1, 6), write(2, 2, 3), check(3, 4, 5)]);
  expect(g.checks[0]?.satisfiesModifications).toEqual([2]);
  expect(g.unresolved.some(u => u.step === 1)).toBe(true);
 });
 test("legacy synthetic sequential traces retain contract", () => {
  const g = grade([call(1, "write", { path: "a.ts" }), call(2, "bash", { command: "bun test" })]);
  expect(g.verdict).toBe("PASS");
  expect(g.checks[0]?.satisfiesModifications).toEqual([1]);
 });
 test.each([false, true])("read evidence must be available before edit, overlap=%s", overlap => {
  const g = grade([call(1, "read", { path: "a.ts" }, { invoked: 1, result: overlap ? 4 : 2 }), call(2, "edit", { path: "a.ts" }, { invoked: 3, result: 5 }), check(3, 6, 7)]);
  expect(g.coverage.reasons.includes("read_order_unknown")).toBe(overlap);
  expect(g.violations.some(v => v.rule === "edit-before-read")).toBe(false);
 });
 test("host-generated assistant summaries are not model pass claims", () => {
  const host = { ...answer(2, 3), provenance: { ...provenance, origin: "host" as const } };
  const g = grade([write(1, 1, 2), host]);
  expect(g.violations.some(v => v.rule === "claim-mismatch")).toBe(false);
  expect(g.violations.some(v => v.rule === "unverified-change")).toBe(true);
 });
 test("finite engine step limit is explicit", () => {
  const steps: Step[] = Array.from({ length: TRAJECTORY_STEP_LIMIT + 1 }, (_, i) => ({ n: i + 1, entryId: i, kind: "assistant", text: "done" }));
  expect(grade(steps).coverage.reasons).toContain("step_limit");
 });
});

test("graph bounds, closed references, and unknown provider knowledge", () => {
 const nodes = Array.from({ length: EVIDENCE_LIMITS.nodes + 1 }, (_, i) => ({ id: String(i), kind: "call" as const, provenance }));
 const graph = evidenceGraph(nodes, [{ kind: "root-child", from: "0", to: "1" }, { kind: "call-result", from: "0", to: "absent" }]);
 expect(graph.truncated).toBe(true);
 expect(graph.nodes).toHaveLength(EVIDENCE_LIMITS.nodes);
 expect(graph.links).toHaveLength(1);
 expect(graph.originalProviderContext).toBe("UNKNOWN");
 expect(graph.consumption).toBe("UNKNOWN");
});
