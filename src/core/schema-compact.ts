/**
 * Equivalent, shorter JSON Schemas for the tool declarations a model request carries.
 *
 * TypeBox renders a union of string literals as `anyOf: [{type:"string",const:"a"}, ...]` and a tagged union as one
 * full object per tag. Both are repeated verbatim in every request. The rewrites here accept exactly the same
 * instances, so validation (which keeps using the original schema) and the model's view agree:
 *
 * 1. `anyOf` whose every branch is `{type:"string",const:c}` (only those keys) becomes `{type:"string",enum:[c...]}`.
 * 2. Object branches of an `anyOf` that are identical except for the `const` of the same property merge into one
 *    branch whose property is `{type:"string",enum:[...]}`. Instances of the merged branch are exactly the union of
 *    the instances of the merged branches because nothing else distinguishes them.
 * 3. An `anyOf` left with a single branch is replaced by that branch (keeping sibling keys such as description).
 *
 * The function is pure and never adds or removes constraints other than these rewrites.
 */
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Obj = { [key: string]: Json };

const isObj = (value: Json | undefined): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);
const keys = (value: Obj) => Object.keys(value).sort();

function isStringConst(value: Json): value is Obj {
	if (!isObj(value) || typeof value.const !== "string") return false;
	const k = keys(value);
	return k.length === 2 && k[0] === "const" && k[1] === "type" && value.type === "string";
}

function canonical(value: Json): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (isObj(value)) return `{${keys(value).map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(",")}}`;
	return JSON.stringify(value);
}

/** The property whose `const` is the only difference to compare branches, or undefined. */
function tagOf(branch: Json): { property: string; value: string; rest: string } | undefined {
	if (!isObj(branch) || branch.type !== "object" || !isObj(branch.properties)) return undefined;
	const properties = branch.properties;
	for (const property of Object.keys(properties)) {
		const schema = properties[property]!;
		if (!isStringConst(schema)) continue;
		const without: Obj = { ...branch, properties: { ...properties, [property]: { type: "string" } } };
		return { property, value: schema.const as string, rest: `${property}|${canonical(without)}` };
	}
	return undefined;
}

function compactAnyOf(branches: Json[]): Json[] {
	if (branches.length > 1 && branches.every(isStringConst)) {
		return [{ type: "string", enum: branches.map((branch) => (branch as Obj).const as string) }];
	}
	const groups = new Map<string, { index: number; property: string; values: string[] }>();
	const out: (Json | undefined)[] = [];
	for (const branch of branches) {
		const tag = tagOf(branch);
		const group = tag && groups.get(tag.rest);
		if (tag && group) {
			group.values.push(tag.value);
			continue;
		}
		if (tag) groups.set(tag.rest, { index: out.length, property: tag.property, values: [tag.value] });
		out.push(branch);
	}
	for (const group of groups.values()) {
		if (group.values.length < 2) continue;
		const branch = out[group.index] as Obj;
		const properties = branch.properties as Obj;
		out[group.index] = { ...branch, properties: { ...properties, [group.property]: { type: "string", enum: group.values } } };
	}
	return out as Json[];
}

export function compactSchema(schema: Json): Json {
	if (Array.isArray(schema)) return schema.map(compactSchema);
	if (!isObj(schema)) return schema;
	const out: Obj = {};
	for (const [key, value] of Object.entries(schema)) {
		// `properties` maps names to schemas; every other container holds schemas directly.
		if (key === "properties" && isObj(value)) out[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, compactSchema(child)]));
		else if (key === "const" || key === "enum" || key === "default" || key === "examples" || key === "required") out[key] = value;
		else out[key] = compactSchema(value);
	}
	if (Array.isArray(out.anyOf)) {
		const branches = compactAnyOf(out.anyOf);
		const only = branches.length === 1 ? branches[0] : undefined;
		if (isObj(only)) {
			const { anyOf: _anyOf, ...siblings } = out;
			// A sibling never overrides a key the branch defines with a different value.
			if (Object.keys(siblings).every((key) => !(key in only) || canonical(only[key]!) === canonical(siblings[key]!))) return { ...only, ...siblings };
		}
		out.anyOf = branches;
	}
	return out;
}
