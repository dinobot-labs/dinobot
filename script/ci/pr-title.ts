/** Squash merges use the PR title as the Conventional Commit. Never interpolate it into shell. */
export function validPrTitle(title: string): boolean {
	return /^(?:feat|fix|perf|refactor|docs|style|test|build|ci|chore|revert)(?:\([^()\r\n]+\))?!?: [^\s][^\r\n]*$/.test(title) && !/[\r\n]/.test(title);
}
if (import.meta.main && !validPrTitle(process.env.PR_TITLE ?? "")) {
	console.error("PR title must be a Conventional Commit, e.g. fix(update): verify installed version or feat!: change configuration.");
	process.exitCode = 1;
}
