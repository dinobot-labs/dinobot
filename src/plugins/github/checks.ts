/**
 * CI verdict for a commit: commit statuses and check runs mapped to success < pending < failure,
 * joined with max. Soundness: `success` is reported only when every check was seen and is a
 * success; `failure` only when a failing check was seen. See openwiki/architecture/github.md.
 */

export type CheckClass = "success" | "pending" | "failure";
export type Verdict = "none" | CheckClass | "unknown";

const RANK: Record<CheckClass, number> = { success: 0, pending: 1, failure: 2 };
const SUCCESS_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

/** Commit status `state`: success | pending | failure | error. Unknown states are failures. */
export function classifyStatus(state: string): CheckClass {
	if (state === "success") return "success";
	if (state === "pending") return "pending";
	return "failure";
}

/** Check run: anything not completed is pending; completed runs fail unless the conclusion is a known success. */
export function classifyCheckRun(status: string, conclusion: string | null): CheckClass {
	if (status !== "completed") return "pending";
	return conclusion !== null && SUCCESS_CONCLUSIONS.has(conclusion) ? "success" : "failure";
}

/**
 * `complete` must be true only when every check of the commit is in `classes`.
 * Without completeness only a seen failure is decidable; everything else is `unknown`.
 */
export function verdict(classes: readonly CheckClass[], complete: boolean): Verdict {
	let worst: CheckClass | undefined;
	for (const value of classes) if (worst === undefined || RANK[value] > RANK[worst]) worst = value;
	if (worst === "failure") return "failure";
	if (!complete) return "unknown";
	return worst ?? "none";
}
