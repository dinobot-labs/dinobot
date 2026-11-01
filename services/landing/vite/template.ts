/**
 * The page template language used by vite/pages.ts (docs/design-system.md, "Pages plugin").
 *
 *   {{path}}               value, HTML-escaped (& < > " ')
 *   {{{path}}}             value, raw (trusted HTML from the dictionary)
 *   {{> name}}             partial: src/pages/partials/<name>.html, expanded before anything else
 *   {{#each path}}…{{/each}}   repeat for every array item; inside, {{.}} is the item, {{.key}} a field of it,
 *                          {{@index}} is 0-based, {{@number}} 1-based, {{@first}} / {{@last}} are booleans
 *   {{#if path}}…{{else}}…{{/if}}, {{#unless path}}…{{/unless}}   truthy test (a missing path is false)
 *   {{! comment }}         removed
 *
 * Paths are dotted: `hero.title`, `$.lang`. A path that starts with `.` reads the innermost #each item.
 * A missing value, or an object/array where text is expected, throws TemplateError with the template name,
 * locale and line, so a broken key fails the build instead of shipping `{{` leftovers.
 */

export class TemplateError extends Error {
	override name = "TemplateError";
}

type Node =
	| { kind: "text"; value: string }
	| { kind: "var"; path: string; raw: boolean; line: number }
	| { kind: "each"; path: string; body: Node[]; line: number }
	| { kind: "if"; path: string; negate: boolean; then: Node[]; otherwise: Node[]; line: number };

interface Frame {
	item: unknown;
	index: number;
	length: number;
}

export interface RenderOptions {
	/** Template name for error messages, e.g. "home.html". */
	name: string;
	/** Locale for error messages. */
	locale: string;
	/** Returns the source of a partial, or undefined when it does not exist. */
	partial?: (name: string) => string | undefined;
}

const TAG = /\{\{\{\s*([^{}]*?)\s*\}\}\}|\{\{\s*([^{}]*?)\s*\}\}/g;
const PARTIAL = /\{\{>\s*([\w./-]+)\s*\}\}/g;
const MAX_PARTIAL_DEPTH = 8;

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

function lineAt(source: string, index: number): number {
	let line = 1;
	for (let i = 0; i < index; i++) if (source.charCodeAt(i) === 10) line++;
	return line;
}

/** Expands {{> name}} recursively. Returns the expanded source and the partial names it used. */
export function expandPartials(source: string, options: RenderOptions, depth = 0, used: string[] = []): { source: string; used: string[] } {
	const out = source.replace(PARTIAL, (_match, name: string, offset: number) => {
		if (depth >= MAX_PARTIAL_DEPTH) throw new TemplateError(`${options.name}: partials nested deeper than ${MAX_PARTIAL_DEPTH} levels at {{> ${name}}}`);
		const body = options.partial?.(name);
		if (body === undefined) throw new TemplateError(`${options.name}:${lineAt(source, offset)}: partial "${name}" not found (src/pages/partials/${name}.html)`);
		used.push(name);
		return expandPartials(body, { ...options, name: `partials/${name}.html` }, depth + 1, used).source;
	});
	return { source: out, used };
}

export function parse(source: string, name: string): Node[] {
	const root: Node[] = [];
	const stack: { node: Extract<Node, { kind: "each" | "if" }>; inElse: boolean; open: string }[] = [];
	const target = (): Node[] => {
		const top = stack[stack.length - 1];
		if (!top) return root;
		if (top.node.kind === "each") return top.node.body;
		return top.inElse ? top.node.otherwise : top.node.then;
	};
	let last = 0;
	for (const match of source.matchAll(TAG)) {
		const index = match.index ?? 0;
		if (index > last) target().push({ kind: "text", value: source.slice(last, index) });
		last = index + match[0].length;
		const line = lineAt(source, index);
		const where = `${name}:${line}`;
		if (match[1] !== undefined) {
			if (!match[1]) throw new TemplateError(`${where}: empty {{{ }}} tag`);
			target().push({ kind: "var", path: match[1], raw: true, line });
			continue;
		}
		const body = (match[2] ?? "").trim();
		if (!body) throw new TemplateError(`${where}: empty {{ }} tag`);
		if (body.startsWith("!")) continue;
		if (body.startsWith(">")) throw new TemplateError(`${where}: partial ${match[0]} was not expanded`);
		const block = /^#(each|if|unless)\s+(\S+)$/.exec(body);
		if (block) {
			const [, kind, path] = block as unknown as [string, string, string];
			const node: Extract<Node, { kind: "each" | "if" }> =
				kind === "each" ? { kind: "each", path, body: [], line } : { kind: "if", path, negate: kind === "unless", then: [], otherwise: [], line };
			target().push(node);
			stack.push({ node, inElse: false, open: kind });
			continue;
		}
		if (body === "else") {
			const top = stack[stack.length - 1];
			if (!top || top.node.kind !== "if" || top.inElse) throw new TemplateError(`${where}: {{else}} outside an {{#if}} or {{#unless}} block`);
			top.inElse = true;
			continue;
		}
		const close = /^\/(each|if|unless)$/.exec(body);
		if (close) {
			const top = stack.pop();
			if (!top || top.open !== close[1]) throw new TemplateError(`${where}: {{/${close[1]}}} does not close ${top ? `{{#${top.open}}} from line ${top.node.line}` : "any block"}`);
			continue;
		}
		if (/^[#/]/.test(body)) throw new TemplateError(`${where}: unknown block tag {{${body}}}`);
		target().push({ kind: "var", path: body, raw: false, line });
	}
	if (last < source.length) target().push({ kind: "text", value: source.slice(last) });
	const open = stack.pop();
	if (open) throw new TemplateError(`${name}:${open.node.line}: {{#${open.open} ${open.node.path}}} is never closed`);
	return root;
}

const MISSING = Symbol("missing");

function lookup(path: string, data: Record<string, unknown>, frames: Frame[]): unknown {
	const frame = frames[frames.length - 1];
	if (path.startsWith("@")) {
		if (!frame) return MISSING;
		if (path === "@index") return frame.index;
		if (path === "@number") return frame.index + 1;
		if (path === "@first") return frame.index === 0;
		if (path === "@last") return frame.index === frame.length - 1;
		return MISSING;
	}
	let value: unknown;
	let rest: string[];
	if (path === "." || path === "this") return frame ? frame.item : MISSING;
	if (path.startsWith(".")) {
		if (!frame) return MISSING;
		value = frame.item;
		rest = path.slice(1).split(".");
	} else {
		value = data;
		rest = path.split(".");
	}
	for (const key of rest) {
		if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) return MISSING;
		value = (value as Record<string, unknown>)[key];
	}
	return value === undefined ? MISSING : value;
}

function truthy(value: unknown): boolean {
	if (value === MISSING || value === null || value === false || value === 0 || value === "") return false;
	if (Array.isArray(value)) return value.length > 0;
	return true;
}

function renderNodes(nodes: Node[], data: Record<string, unknown>, frames: Frame[], options: RenderOptions): string {
	let out = "";
	for (const node of nodes) {
		if (node.kind === "text") {
			out += node.value;
			continue;
		}
		const where = `${options.name}:${node.line} (${options.locale})`;
		const value = lookup(node.path, data, frames);
		if (node.kind === "var") {
			if (value === MISSING || value === null) throw new TemplateError(`${where}: missing value for {{${node.path}}}`);
			if (typeof value === "object") throw new TemplateError(`${where}: {{${node.path}}} is ${Array.isArray(value) ? "an array" : "an object"}, not text`);
			const text = String(value);
			out += node.raw ? text : escapeHtml(text);
			continue;
		}
		if (node.kind === "each") {
			if (value === MISSING) throw new TemplateError(`${where}: missing array for {{#each ${node.path}}}`);
			if (!Array.isArray(value)) throw new TemplateError(`${where}: {{#each ${node.path}}} needs an array`);
			value.forEach((item, index) => {
				out += renderNodes(node.body, data, [...frames, { item, index, length: value.length }], options);
			});
			continue;
		}
		const pass = truthy(value) !== node.negate;
		out += renderNodes(pass ? node.then : node.otherwise, data, frames, options);
	}
	return out;
}

/** Renders a template source with `data`. Throws TemplateError on syntax errors and missing values. */
export function renderTemplate(source: string, data: Record<string, unknown>, options: RenderOptions): { html: string; partials: string[] } {
	const { source: expanded, used } = expandPartials(source, options);
	const nodes = parse(expanded, options.name);
	return { html: renderNodes(nodes, data, [], options), partials: used };
}
