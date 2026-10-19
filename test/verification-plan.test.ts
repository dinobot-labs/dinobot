import { expect, test } from "bun:test";
import { type Evidence, inspectWorkflow, PLAN_STATE_ORDER, type PlanState, rollUp, type Work, type WorkState } from "../src/core/verification.ts";

/** One work item with two requirements sharing check `b`; method hashes pin the current epoch. */
function work(extra: Partial<Work> = {}): Work {
	return {
		id: "w", state: "implementing", version: 2, contractHash: "H", scope: { root: "/r", inputs: [], disposable: [] }, hostHash: "host",
		methodEpoch: 1, mutationEpoch: 3, sourceIds: ["1"], noProgress: {}, operations: {}, blockers: [],
		costs: { attempts: 0, repairs: 0, seconds: 0, coaching: 0, slots: [] },
		contract: {
			requirements: [
				{ id: "R1", assertion: "adds numbers", checkIds: ["a", "b"], scenarioIds: [] },
				{ id: "R2", assertion: "types check", checkIds: ["b"], scenarioIds: [] },
			],
			scenarios: [],
			checks: [
				{ id: "a", requirementIds: ["R1"], scenarioIds: [], evidence: "behavioral", expected: "bun test passes" },
				{ id: "b", requirementIds: ["R1", "R2"], scenarioIds: [], evidence: "typecheck", expected: "tsc exits 0" },
			],
		},
		methods: {
			a: [{ revision: 0, method: {} as never, hash: "ma", rationale: "", priorAttemptIds: [], taskId: "t", at: 0 }],
			b: [{ revision: 0, method: {} as never, hash: "mb", rationale: "", priorAttemptIds: [], taskId: "t", at: 0 }],
		},
		...extra,
	};
}

type Kind = Evidence["status"] | "passed-dirty";
/** `epoch` false makes the attempt predate the current mutation epoch; `passed-dirty` passed but the tree moved during the run. */
function attempt(checkId: string, kind: Kind, epoch: boolean, n: number): Evidence {
	const passed = kind === "passed" || kind === "passed-dirty";
	return {
		id: `e${n}`, taskId: `t${n}`, checkId, workId: "w", status: passed ? "passed" : kind,
		contractHash: "H", version: 2, methodEpoch: 1, methodHash: `m${checkId}`, mutationEpoch: epoch ? 3 : 2,
		before: "tree", after: kind === "passed-dirty" ? "moved" : "tree", signature: "s", timeout: 10,
		...(passed ? { observation: { command: "", cwd: "", exitCode: 0, error: null, durationMs: 1, output: "", report: "", truncated: false, observed: [], passed: true, quiescent: true } } : {}),
	};
}
const state = (w: Work): WorkState => ({ works: [w], sources: { "1": { kind: "linked", workId: "w", contractHash: "H", version: 2 } }, activeId: "w" });

const kinds: Kind[] = ["admitted", "running", "passed", "passed-dirty", "failed", "unknown", "cancelled"];
const steps = kinds.flatMap((kind) => [true, false].map((epoch) => ({ kind, epoch })));
/** σ by its specification, independent of the implementation's control flow. */
function specified(history: { kind: Kind; epoch: boolean }[]): PlanState {
	if (history.some((h) => h.epoch && h.kind === "passed")) return "met";
	const current = history.filter((h) => h.epoch);
	const last = current.at(-1);
	if (!last) return history.length ? "stale" : "pending";
	return ({ admitted: "running", running: "running", "passed-dirty": "stale", failed: "failed", unknown: "unknown", cancelled: "cancelled" } as const)[last.kind as Exclude<Kind, "passed">];
}

test("σ matches its specification and met ⇔ not unmet, for every attempt history of length ≤ 3", () => {
	let histories = [[]] as { kind: Kind; epoch: boolean }[][];
	let checked = 0;
	for (let length = 0; length <= 3; length++) {
		for (const history of histories) {
			const evidence = history.map((h, n) => attempt("a", h.kind, h.epoch, n));
			const status = inspectWorkflow(state(work()), evidence);
			const a = status.plan!.checks.find((c) => c.id === "a")!;
			expect(a.state).toBe(specified(history));
			expect(a.state === "met").toBe(!status.unmetCheckIds.includes("a"));
			expect(status.plan!.checks.filter((c) => c.state === "met").length).toBe(status.plan!.checks.length - status.unmetCheckIds.length);
			checked++;
		}
		histories = histories.flatMap((history) => steps.map((step) => [...history, step]));
	}
	// 1 + 14 + 14² + 14³ histories.
	expect(checked).toBe(1 + 14 + 196 + 2744);
});

test("a method repair or contract revision makes every earlier attempt stale, never met", () => {
	const passed = [attempt("a", "passed", true, 0), attempt("b", "passed", true, 1)];
	expect(inspectWorkflow(state(work()), passed).plan!.checks.map((c) => c.state)).toEqual(["met", "met"]);
	const repaired = work({ methodEpoch: 2 });
	const after = inspectWorkflow(state(repaired), passed);
	expect(after.plan!.checks.map((c) => c.state)).toEqual(["stale", "stale"]);
	expect(after.unmetCheckIds).toEqual(["a", "b"]);
});

test("requirements roll up their own checks: shared check b drives both R1 and R2", () => {
	const plan = inspectWorkflow(state(work()), [attempt("a", "passed", true, 0), attempt("b", "failed", true, 1)]).plan!;
	expect(plan.requirements.map((r) => [r.id, r.state])).toEqual([["R1", "failed"], ["R2", "failed"]]);
	const fixed = inspectWorkflow(state(work()), [attempt("a", "running", true, 0), attempt("b", "passed", true, 1)]).plan!;
	expect(fixed.requirements.map((r) => [r.id, r.state])).toEqual([["R1", "running"], ["R2", "met"]]);
});

test("rollUp is a join: commutative, associative, idempotent; met iff all met; never met when empty", () => {
	const rank = (s: PlanState) => PLAN_STATE_ORDER.indexOf(s);
	expect(rollUp([])).toBe("pending");
	for (const x of PLAN_STATE_ORDER) {
		expect(rollUp([x])).toBe(x);
		expect(rollUp([x, x])).toBe(x);
		for (const y of PLAN_STATE_ORDER) {
			expect(rollUp([x, y])).toBe(rollUp([y, x]));
			// Monotone: worsening one input never improves the result.
			for (const y2 of PLAN_STATE_ORDER) if (rank(y2) >= rank(y)) expect(rank(rollUp([x, y2]))).toBeGreaterThanOrEqual(rank(rollUp([x, y])));
			for (const z of PLAN_STATE_ORDER) {
				const all = rollUp([x, y, z]);
				expect(rollUp([rollUp([x, y]), z])).toBe(all);
				expect(rollUp([x, rollUp([y, z])])).toBe(all);
				expect(all === "met").toBe(x === "met" && y === "met" && z === "met");
			}
		}
	}
});

test("no plan for informational or unregistered sources; the plan never claims verified on its own", () => {
	expect(inspectWorkflow({ works: [], sources: { "1": { kind: "informational", rationale: "q" } } }, [], "1").plan).toBeUndefined();
	expect(inspectWorkflow(undefined).plan).toBeUndefined();
	const allMet = inspectWorkflow(state(work()), [attempt("a", "passed", true, 0), attempt("b", "passed", true, 1)]);
	expect(allMet.plan!.checks.every((c) => c.state === "met")).toBe(true);
	expect(allMet.status).toBe("implementing");
	expect(allMet.certificate).toBeNull();
});
