import { expect, test } from "bun:test";
import { parseReadiness } from "../src/core/research-readiness.ts";
import type { ProcessReceipt } from "../src/core/research-experiments.ts";
const receipt = (value: unknown): ProcessReceipt => ({ status: "completed", exitCode: 0, stdout: JSON.stringify(value), stderr: "", startedAt: 0, endedAt: 1, pid: 1, argv: ["fixture"], cwd: "/fixture" });
const valid = { version: "research-readiness-v1", checks: [{ id: "a", verdict: "pass" }, { id: "b", verdict: "pass" }], feedback: "observed" };
test("readiness exact checks accept positive evidence and preserve settled negative findings", () => {
	expect(parseReadiness(receipt(valid), ["a", "b"]).outcome).toBe("pass");
	expect(parseReadiness(receipt({ ...valid, checks: [{ id: "a", verdict: "fail" }, { id: "b", verdict: "pass" }] }), ["a", "b"])).toEqual({ outcome: "fail", failedIds: ["a"], feedback: "observed" });
});
test.each([
	null, {}, { ...valid, checks: [] }, { ...valid, extra: true }, { ...valid, feedback: "" },
	{ ...valid, checks: [{ id: "a", verdict: "pass" }, { id: "a", verdict: "pass" }] },
	{ ...valid, checks: [{ id: "a", verdict: "pass" }, { id: "foreign", verdict: "pass" }] },
	{ ...valid, checks: [{ id: "a", verdict: "fail" }, { id: "b", verdict: "unknown" }] },
	{ ...valid, checks: [{ id: "a", verdict: false }, { id: "b", verdict: "pass" }] },
])("readiness malformed/missing/unknown evidence fails closed %#", value => {
	expect(parseReadiness(receipt(value), ["a", "b"]).outcome).toBe("unknown");
});
test.each(["failed", "timeout", "cancelled", "output_limit"] as const)("readiness %s cannot pass despite positive stdout", status => {
	expect(parseReadiness({ ...receipt(valid), status }, ["a", "b"]).outcome).toBe("unknown");
});
