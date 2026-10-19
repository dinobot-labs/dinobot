import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";

/**
 * Deterministic repair of two provider argument-encoding slips seen in recorded trajectories:
 *  1. the whole argument object arrives as a string (JSON text, or the bare value of the only required string field);
 *  2. an array/object field arrives as its JSON text (e.g. sourceIds: "[\"1\"]").
 *
 * Invariant (identity on valid input): a value is changed only at a position whose current JSON type is
 * rejected by every schema branch that defines that position. Such input already fails validation,
 * so repair(x) = x for every schema-valid x, and repair(repair(x)) = repair(x).
 * Validation still runs after repair; repair never widens what a tool accepts.
 */
type Schema = Record<string, unknown>;
type JsonKind = "string" | "array" | "object";

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const parseJson = (text: string): unknown => {
	const trimmed = text.trim();
	if (!/^[[{]/.test(trimmed)) return undefined;
	try {
		return JSON.parse(trimmed);
	} catch {
		return undefined;
	}
};
const branches = (schema: Schema): Schema[] => {
	const union = (schema.anyOf ?? schema.oneOf) as Schema[] | undefined;
	return Array.isArray(union) ? union.flatMap(branches) : [schema];
};
/** Conservative: a schema with no declared type (or `{}`) accepts every kind. */
function accepts(schema: Schema, kind: JsonKind): boolean {
	return branches(schema).some((branch) => {
		const type = branch.type;
		if (type === undefined) return branch.const === undefined || typeof branch.const === kind;
		return Array.isArray(type) ? type.includes(kind) : type === kind;
	});
}
function propertySchemas(root: Schema, key: string): Schema[] {
	return branches(root).flatMap((branch) => {
		const properties = branch.properties as Record<string, Schema> | undefined;
		return properties && isObject(properties[key]) ? [properties[key]] : [];
	});
}
/** The single required field of a non-union object schema, when it is string-typed. */
function soleRequiredString(root: Schema): string | undefined {
	if (root.anyOf || root.oneOf || root.type !== "object") return undefined;
	const required = root.required as string[] | undefined;
	if (!Array.isArray(required) || required.length !== 1) return undefined;
	const [key] = required;
	const [property] = propertySchemas(root, key!);
	return property && branches(property).every((branch) => branch.type === "string") ? key : undefined;
}

export function repairArguments(schema: Schema, args: unknown): unknown {
	let value = args;
	if (typeof value === "string") {
		if (accepts(schema, "string")) return args;
		const parsed = parseJson(value);
		if (isObject(parsed)) value = parsed;
		else {
			const key = soleRequiredString(schema);
			return key ? { [key]: value } : args;
		}
	}
	if (!isObject(value)) return value;
	let out = value;
	for (const [key, field] of Object.entries(value)) {
		if (typeof field !== "string") continue;
		const schemas = propertySchemas(schema, key);
		if (!schemas.length || schemas.some((property) => accepts(property, "string"))) continue;
		const parsed = parseJson(field);
		const kind: JsonKind | undefined = Array.isArray(parsed) ? "array" : isObject(parsed) ? "object" : undefined;
		if (!kind || !schemas.some((property) => accepts(property, kind))) continue;
		if (out === value) out = { ...value };
		out[key] = parsed;
	}
	return out;
}

export function withArgumentRepair<T extends ToolRegistration>(tool: T): T {
	const prior = tool.prepareArguments;
	const schema = tool.parameters as unknown as Schema;
	return {
		...tool,
		prepareArguments(args: unknown) {
			const repaired = repairArguments(schema, args);
			return prior ? prior.call(tool, repaired) : repaired;
		},
	} as T;
}

/** Every tool installed through the returned registry gets argument repair before its own preparation. */
export function repairingRegistry<R extends { install(extension: Extension): void }>(registry: R): R {
	const install = registry.install.bind(registry);
	registry.install = (extension: Extension) =>
		install(extension.tools?.length ? { ...extension, tools: extension.tools.map(withArgumentRepair) } : extension);
	return registry;
}
