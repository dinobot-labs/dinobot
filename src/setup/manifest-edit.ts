/**
 * Comment-preserving single-entry edits of the user's YAML manifest (first-run setup).
 *
 * The editor works on lines, not on a YAML AST: it locates the top-level `channels:`/`plugins:` mapping, finds the one
 * child entry it was asked to add, replace or remove, and splices rendered YAML in its place. Every byte outside the
 * touched entry stays as it was. Anything the line model does not understand is rejected with ManifestEditError rather
 * than guessed at, and every result is checked against a mandatory postcondition before it is returned:
 *
 * - `Bun.YAML.parse(result)` deep-equals the original document with exactly the requested change applied;
 * - every comment line of the original (trimmed form starts with `#`) appears in the result, in the same order.
 *   Comment lines inside a replaced or removed entry block (indented deeper than the entry key) are dropped with it,
 *   as are trailing comments on the entry's own lines.
 */
import { isDeepStrictEqual } from "node:util";

export type ManifestSection = "channels" | "plugins";

export class ManifestEditError extends Error {
	override readonly name = "ManifestEditError";
}

type Line = { readonly text: string; readonly indent: number; readonly blank: boolean; readonly comment: boolean };

const PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/;
// Plain words some YAML schemas read as booleans/null; quoting them keeps the key a string everywhere.
const RESERVED_KEY = /^(?:true|false|null|yes|no|on|off|y|n)$/i;
// A mapping key at the start of a (dedented) line: double-quoted, single-quoted or plain, followed by `:` and space/EOL.
const KEY_TOKEN = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#'"{}[\],&*!|>%@`?-][^#]*?|-[^\s#][^#]*?)[ ]*:(?=\s|$)/;

/**
 * Returns `text` with top-level `section` mapping's entry `key` set to `value` (JSON-serializable: object, array,
 * string, number, boolean, null) or removed when `value === undefined`. Everything outside the touched entry is
 * byte-identical. Throws ManifestEditError for unsupported input or when the postcondition fails.
 */
export function editManifestEntry(text: string, section: ManifestSection, key: string, value: unknown): string {
	if (section !== "channels" && section !== "plugins") throw new ManifestEditError(`unsupported section ${JSON.stringify(section)}`);
	if (typeof key !== "string" || key.length === 0) throw new ManifestEditError("entry key must be a non-empty string");
	if (value !== undefined) validateValue(value, `${section}.${key}`);
	checkKey(key, `${section}.${key}`);
	if (text.includes("\r")) throw new ManifestEditError("CRLF line endings are not supported");

	const raw = text.split("\n");
	const lines: Line[] = raw.map((line, index) => {
		const indentText = /^[ \t]*/.exec(line)![0];
		const blank = line.trim() === "";
		if (!blank && indentText.includes("\t")) throw new ManifestEditError(`line ${index + 1}: tabs are not supported for indentation`);
		if (/^(?:---|\.\.\.)(?:\s|$)/.test(line)) throw new ManifestEditError(`line ${index + 1}: multiple YAML documents are not supported`);
		if (/^%/.test(line)) throw new ManifestEditError(`line ${index + 1}: YAML directives are not supported`);
		return { text: line, indent: indentText.length, blank, comment: !blank && line.trim().startsWith("#") };
	});

	const original = parseYaml(text, "the manifest");
	const root: Record<string, unknown> = original === null || original === undefined ? {} : asMapping(original, "the manifest root");
	const current = Object.hasOwn(root, section) ? root[section] : undefined;
	if (current !== undefined && current !== null && !isPlainObject(current)) throw new ManifestEditError(`${section}: not a mapping`);
	const entries = isPlainObject(current) ? current : {};

	// Header: the only column-0 line that starts with `section:`.
	const headerIndexes = lines.flatMap((line, index) => (line.text.startsWith(`${section}:`) ? [index] : []));
	if (headerIndexes.length > 1) throw new ManifestEditError(`${section}: defined more than once`);
	const headerIndex = headerIndexes[0];
	if ((headerIndex === undefined) !== !Object.hasOwn(root, section)) {
		throw new ManifestEditError(`${section}: could not locate the section line (only a plain \`${section}:\` at column 0 is supported)`);
	}

	const expected = structuredClone(root);
	if (value === undefined) {
		if (!Object.hasOwn(entries, key)) return text; // nothing to remove
		const nextEntries = structuredClone(entries);
		delete nextEntries[key];
		expected[section] = nextEntries;
	} else {
		expected[section] = { ...structuredClone(entries), [key]: structuredClone(value) };
	}

	let out: string[];
	let dropped = new Set<number>(); // original line indexes removed (inside the touched entry block)
	if (headerIndex === undefined) {
		// (e) Missing section: append it at the end of the file.
		const block = renderEntry(key, value, 2);
		const body = [`${section}:`, ...block].join("\n") + "\n";
		const result = text === "" ? body : (text.endsWith("\n") ? text : text + "\n") + body;
		return verified(text, result, expected, dropped);
	}

	const header = lines[headerIndex]!.text;
	const rest = header.slice(section.length + 1);
	const flowEmpty = /^([ ]*)\{[ ]*\}([ ]*(?:#.*)?)$/.exec(rest);
	const blockForm = /^[ ]*(?:#.*)?$/.test(rest);
	if (!flowEmpty && !blockForm) throw new ManifestEditError(`${section}: only block mappings or \`{}\` are supported (found \`${header}\`)`);

	// Section region: lines after the header up to the next column-0 content line (comments at column 0 do not end it).
	let regionEnd = headerIndex + 1;
	while (regionEnd < lines.length) {
		const line = lines[regionEnd]!;
		if (!line.blank && !line.comment && line.indent === 0) break;
		regionEnd++;
	}
	rejectNodeProperties(section, [rest, ...lines.slice(headerIndex + 1, regionEnd).map((line) => line.text)]);

	if (flowEmpty) {
		// (a) `section: {}  # comment` has no children; indented content after it would be invalid YAML anyway.
		if (lines.slice(headerIndex + 1, regionEnd).some((line) => !line.blank && !line.comment)) {
			throw new ManifestEditError(`${section}: unexpected indented content after \`{}\``);
		}
		if (value === undefined) return text; // unreachable: an empty mapping has no entry to remove
		const newHeader = (`${section}:` + flowEmpty[2]!).replace(/[ ]+$/, "");
		out = [...raw.slice(0, headerIndex), newHeader, ...renderEntry(key, value, 2), ...raw.slice(headerIndex + 1)];
		return verified(text, out.join("\n"), expected, dropped);
	}

	// (b) Block form: children at the indentation of the first content line (default 2).
	const firstChild = lines.slice(headerIndex + 1, regionEnd).find((line) => !line.blank && !line.comment);
	const childIndent = firstChild?.indent ?? 2;
	type Child = { readonly key: string; readonly start: number; readonly end: number }; // inclusive line range
	const children: Child[] = [];
	for (let index = headerIndex + 1; index < regionEnd; index++) {
		const line = lines[index]!;
		if (line.blank || line.comment) continue;
		if (line.indent < childIndent) throw new ManifestEditError(`line ${index + 1}: inconsistent indentation in ${section}`);
		if (line.indent > childIndent) continue;
		const childKey = parseKey(line.text.slice(childIndent), index);
		// Entry block: the key line plus following blank lines and lines indented deeper than the key.
		let end = index;
		let scan = index + 1;
		while (scan < regionEnd && (lines[scan]!.blank || lines[scan]!.indent > childIndent)) scan++;
		for (let back = scan - 1; back > index; back--) {
			if (!lines[back]!.blank) { end = back; break; }
		}
		children.push({ key: childKey, start: index, end });
	}
	const found = children.map((child) => child.key);
	const actual = Object.keys(entries);
	if (new Set(found).size !== found.length || found.length !== actual.length || !actual.every((name) => found.includes(name))) {
		throw new ManifestEditError(`${section}: could not map the entries in the file to the parsed mapping`);
	}

	const target = children.find((child) => child.key === key);
	if (value === undefined) {
		// (d) Remove; the last real entry leaves `section: {}` with the section line's comment.
		const removed = target!;
		dropped = range(removed.start, removed.end);
		const newHeader = children.length === 1 ? `${section}: {}${rest}`.replace(/[ ]+$/, "") : header;
		out = [...raw.slice(0, headerIndex), newHeader, ...raw.slice(headerIndex + 1, removed.start), ...raw.slice(removed.end + 1)];
	} else if (target) {
		// (c) Replace the entry block.
		dropped = range(target.start, target.end);
		out = [...raw.slice(0, target.start), ...renderEntry(key, value, childIndent), ...raw.slice(target.end + 1)];
	} else {
		// Add after the last real entry's block, or right after the section line when there is none.
		const after = children.at(-1)?.end ?? headerIndex;
		out = [...raw.slice(0, after + 1), ...renderEntry(key, value, childIndent), ...raw.slice(after + 1)];
	}
	return verified(text, out.join("\n"), expected, dropped);
}

/** Render `key: value` as block YAML lines at `indent` spaces. */
function renderEntry(key: string, value: unknown, indent: number): string[] {
	const pad = " ".repeat(indent);
	const name = renderKey(key);
	if (isPlainObject(value)) {
		const entries = Object.entries(value);
		if (entries.length === 0) return [`${pad}${name}: {}`];
		return [`${pad}${name}:`, ...entries.flatMap(([child, nested]) => renderEntry(child, nested, indent + 2))];
	}
	return [`${pad}${name}: ${renderFlow(value)}`];
}

function renderFlow(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(renderFlow).join(", ")}]`;
	if (isPlainObject(value)) return `{${Object.entries(value).map(([key, nested]) => `${JSON.stringify(key)}: ${renderFlow(nested)}`).join(", ")}}`;
	return renderScalar(value);
}

function renderScalar(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") return Object.is(value, -0) ? "-0" : JSON.stringify(value);
	if (typeof value === "string") return quote(value);
	throw new ManifestEditError(`cannot render ${typeof value}`);
}

function renderKey(key: string): string {
	return PLAIN_KEY.test(key) && !RESERVED_KEY.test(key) ? key : quote(key);
}

/** JSON string syntax is a valid YAML double-quoted scalar; additionally escape characters YAML treats specially. */
function quote(value: string): string {
	return JSON.stringify(value).replace(/[\u007f-\u009f\u2028\u2029\ufeff]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function validateValue(value: unknown, path: string): void {
	if (value === null || typeof value === "boolean") return;
	if (typeof value === "string") {
		if (!value.isWellFormed()) throw new ManifestEditError(`${path}: string contains a lone surrogate`);
		return;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new ManifestEditError(`${path}: number must be finite`);
		return;
	}
	if (Array.isArray(value)) {
		value.forEach((item, index) => {
			if (item === undefined) throw new ManifestEditError(`${path}[${index}]: undefined is not JSON-serializable`);
			validateValue(item, `${path}[${index}]`);
		});
		return;
	}
	if (isPlainObject(value)) {
		for (const [key, nested] of Object.entries(value)) {
			checkKey(key, `${path}.${key}`);
			if (nested === undefined) throw new ManifestEditError(`${path}.${key}: undefined is not JSON-serializable`);
			validateValue(nested, `${path}.${key}`);
		}
		return;
	}
	throw new ManifestEditError(`${path}: ${typeof value} values are not JSON-serializable`);
}

function checkKey(key: string, path: string): void {
	if (key === "__proto__") throw new ManifestEditError(`${path}: the key __proto__ is not supported`);
	if (!key.isWellFormed()) throw new ManifestEditError(`${path}: key contains a lone surrogate`);
}

/** Read one mapping key from a line that starts at the child indentation. */
function parseKey(line: string, index: number): string {
	const match = KEY_TOKEN.exec(line);
	if (!match) throw new ManifestEditError(`line ${index + 1}: unsupported entry syntax`);
	const parsed = parseYaml(`${match[1]!.trimEnd()}: null`, `line ${index + 1}`);
	const keys = isPlainObject(parsed) ? Object.keys(parsed) : [];
	if (keys.length !== 1) throw new ManifestEditError(`line ${index + 1}: unsupported entry key`);
	return keys[0]!;
}

/** Anchors, aliases and tags inside the section would make block replacement change other nodes; reject them. */
function rejectNodeProperties(section: string, texts: readonly string[]): void {
	for (const text of texts) {
		const stripped = text
			.replace(/"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'/g, '""')
			.replace(/(^|\s)#.*$/, "$1");
		if (/(?:^|[\s[{,])[&*!]/.test(stripped)) throw new ManifestEditError(`${section}: anchors, aliases and tags are not supported`);
		if (/(?:^|[\s[{,])<<[ ]*:/.test(stripped)) throw new ManifestEditError(`${section}: merge keys are not supported`);
	}
}

function verified(original: string, result: string, expected: unknown, dropped: ReadonlySet<number>): string {
	let parsed: unknown;
	try {
		parsed = Bun.YAML.parse(result);
	} catch (error) {
		throw new ManifestEditError(`edited manifest does not parse: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isDeepStrictEqual(parsed, expected)) throw new ManifestEditError("edited manifest does not match the requested change");
	const before = original.split("\n").filter((line, index) => !dropped.has(index) && line.trim().startsWith("#"));
	const after = result.split("\n").filter((line) => line.trim().startsWith("#"));
	let cursor = 0;
	for (const line of after) if (cursor < before.length && line === before[cursor]) cursor++;
	if (cursor !== before.length) throw new ManifestEditError("edited manifest lost a comment line");
	return result;
}

function parseYaml(text: string, what: string): unknown {
	try {
		return Bun.YAML.parse(text);
	} catch (error) {
		throw new ManifestEditError(`${what} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function asMapping(value: unknown, what: string): Record<string, unknown> {
	if (!isPlainObject(value)) throw new ManifestEditError(`${what} is not a mapping`);
	return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function range(start: number, end: number): Set<number> {
	const set = new Set<number>();
	for (let index = start; index <= end; index++) set.add(index);
	return set;
}
