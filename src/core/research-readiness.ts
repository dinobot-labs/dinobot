import type { ProcessReceipt } from "./research-experiments.ts";

export type ReadinessResult = { outcome: "pass" | "fail" | "unknown"; failedIds: string[]; feedback: string };
/** Strict frozen evaluator protocol. Unknown/malformed output is never candidate-repair evidence. */
export function parseReadiness(receipt: ProcessReceipt, ids: readonly string[]): ReadinessResult {
	const unknown = { outcome: "unknown" as const, failedIds: [], feedback: "Readiness protocol or execution unknown" };
	if (receipt.status !== "completed" || receipt.exitCode !== 0) return unknown;
	try {
		const v = JSON.parse(receipt.stdout);
		if (
			!v || Object.keys(v).some(k => !["version", "checks", "feedback"].includes(k)) ||
			v.version !== "research-readiness-v1" || typeof v.feedback !== "string" || !v.feedback.trim() ||
			v.feedback.length > 4096 || !Array.isArray(v.checks) || v.checks.length !== ids.length
		) return unknown;
		const seen = new Set<string>(), failedIds: string[] = [];
		let uncertain = false;
		for (const c of v.checks) {
			if (
				!c || Object.keys(c).some(k => !["id", "verdict"].includes(k)) || !ids.includes(c.id) || seen.has(c.id) ||
				!["pass", "fail", "unknown"].includes(c.verdict)
			) return unknown;
			seen.add(c.id);
			if (c.verdict === "fail") failedIds.push(c.id);
			if (c.verdict === "unknown") uncertain = true;
		}
		return { outcome: uncertain ? "unknown" : failedIds.length ? "fail" : "pass", failedIds: failedIds.sort(), feedback: v.feedback };
	} catch {
		return unknown;
	}
}
