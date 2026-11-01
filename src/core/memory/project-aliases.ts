import { isAbsolute, parse, resolve, sep } from "node:path";

/** Trusted deployment configuration only; never read from repository metadata. */
export type ProjectAlias = { readonly path: string; readonly identity: string; readonly descendants?: boolean };

function comparable(path: string): string {
	const normalized = resolve(path);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
function overlaps(a: string, b: string): boolean {
	return a === b || a.startsWith(b + sep) || b.startsWith(a + sep);
}

/** Disjoint endpoints prohibit chains, cycles and ambiguous subtree ownership. */
export function projectAliasProblems(aliases: readonly ProjectAlias[]): string[] {
	const problems: string[] = [];
	const endpoints: string[] = [];
	if (aliases.length > 128) problems.push("memory.projectAliases: at most 128 mappings");
	for (const [index, alias] of aliases.entries()) {
		if (alias.descendants !== undefined && typeof alias.descendants !== "boolean") problems.push(`memory.projectAliases[${index}].descendants: expected a boolean`);
		for (const field of ["path", "identity"] as const) {
			const value = alias[field];
			if (!value || value.includes("\0") || !isAbsolute(value) || resolve(value) === parse(resolve(value)).root) {
				problems.push(`memory.projectAliases[${index}].${field}: expected an absolute non-root path`);
				continue;
			}
			const endpoint = comparable(value);
			if (endpoints.some((other) => overlaps(endpoint, other))) problems.push(`memory.projectAliases[${index}].${field}: endpoints must not overlap (including chains and cycles)`);
			endpoints.push(endpoint);
		}
	}
	return problems;
}

/** Apply only after Git common-root discovery. Subtree aliases preserve independent child identities. */
export function aliasProject(project: string, aliases: readonly ProjectAlias[]): string {
	const problems = projectAliasProblems(aliases);
	if (problems.length) throw new Error(problems.join("; "));
	const canonical = resolve(project);
	for (const alias of aliases) {
		const root = comparable(alias.path);
		if (root === comparable(project)) return alias.identity;
		if (alias.descendants === true && comparable(project).startsWith(root + sep)) {
			// Slice the original canonical spelling, not the case-folded comparison.
			return alias.identity.replace(/[\\/]+$/, "") + sep + canonical.slice(resolve(alias.path).length + 1);
		}
	}
	return project;
}
