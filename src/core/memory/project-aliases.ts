import { isAbsolute, parse, resolve, sep } from "node:path";

/** Trusted deployment configuration only; never read from repository metadata. */
export type ProjectAlias = { readonly path: string; readonly identity: string };

function comparable(path: string): string {
	const normalized = resolve(path);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
function overlaps(a: string, b: string): boolean {
	return a === b || a.startsWith(b + sep) || b.startsWith(a + sep);
}

/** Disjoint endpoints prohibit chains, cycles, broad parent mappings and ambiguous ownership. */
export function projectAliasProblems(aliases: readonly ProjectAlias[]): string[] {
	const problems: string[] = [];
	const endpoints: string[] = [];
	if (aliases.length > 128) problems.push("memory.projectAliases: at most 128 mappings");
	for (const [index, alias] of aliases.entries()) {
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

/** Exact canonical project-root match, not a directory-prefix rewrite. Preserve the historical key verbatim. */
export function aliasProject(project: string, aliases: readonly ProjectAlias[]): string {
	const problems = projectAliasProblems(aliases);
	if (problems.length) throw new Error(problems.join("; "));
	return aliases.find((alias) => comparable(alias.path) === comparable(project))?.identity ?? project;
}
