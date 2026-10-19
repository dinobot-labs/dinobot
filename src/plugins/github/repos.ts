/**
 * Repository names and the optional allowlist. GitHub compares owner and repository names
 * case-insensitively, so matching lowercases both sides. Safety does not depend on this
 * grammar (every value is percent-encoded into the URL); it only gives early, precise errors.
 */

const OWNER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;

export type Repo = { readonly owner: string; readonly name: string };

/** `owner/name`; `.` and `..` are rejected as names so they can never act as path segments. */
export function parseRepo(value: string): Repo {
	const parts = value.split("/");
	const [owner, name] = parts;
	if (parts.length !== 2 || owner === undefined || name === undefined || !OWNER.test(owner) || !NAME.test(name) || name === "." || name === "..") {
		throw new Error(`repository must be "owner/name", got ${JSON.stringify(value)}`);
	}
	return { owner, name };
}

/** One allowlist entry: an exact repository, or `owner/*` for every repository of an owner. */
export type RepoPattern = { readonly owner: string; readonly name: string | undefined };

export function parsePattern(value: string): RepoPattern {
	if (value.endsWith("/*")) {
		const owner = value.slice(0, -2);
		if (!OWNER.test(owner)) throw new Error(`repository pattern must be "owner/name" or "owner/*", got ${JSON.stringify(value)}`);
		return { owner: owner.toLowerCase(), name: undefined };
	}
	try {
		const repo = parseRepo(value);
		return { owner: repo.owner.toLowerCase(), name: repo.name.toLowerCase() };
	} catch {
		throw new Error(`repository pattern must be "owner/name" or "owner/*", got ${JSON.stringify(value)}`);
	}
}

/** `patterns === undefined` means no allowlist: the token's own permissions are the only bound. */
export function allowed(patterns: readonly RepoPattern[] | undefined, repo: Repo): boolean {
	if (patterns === undefined) return true;
	const owner = repo.owner.toLowerCase();
	const name = repo.name.toLowerCase();
	return patterns.some((pattern) => pattern.owner === owner && (pattern.name === undefined || pattern.name === name));
}
