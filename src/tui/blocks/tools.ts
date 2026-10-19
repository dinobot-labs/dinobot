import {
	sliceByColumn,
	stripTerminalSequences,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { RenderContext } from "../screen.ts";
import type { ToolBlock } from "../state.ts";
import { bold, brailleSpinner, color, fg, formatElapsed, glyph, type IconKind, icons, pad, spacing, spinnerFrame, type Style } from "../theme.ts";

export type ToolKind = "execute" | "read" | "search" | "list" | "edit" | "write" | "web_fetch" | "web_search" | "other";
export type ToolVerb = { past: string; present: string; noun: string; plural: string; groupable: boolean; rail: boolean };

/** Grok's `ToolCallBlock::from_name` table (tool/mod.rs) plus dinobot's `codemode`; plugin calls `<plugin>_<tool>` and unknown names fall through to `other`. */
const kinds: Record<string, ToolKind> = {
	bash: "execute",
	shell: "execute",
	execute: "execute",
	run_terminal_command: "execute",
	run_terminal_cmd: "execute",
	codemode: "execute",
	read: "read",
	read_file: "read",
	grep: "search",
	search: "search",
	glob: "search",
	ls: "list",
	list_dir: "list",
	edit: "edit",
	search_replace: "edit",
	apply_patch: "edit",
	strreplace: "edit",
	write: "write",
	web_fetch: "web_fetch",
	fetch: "web_fetch",
	web_search: "web_search",
};
export const toolKind = (name: string): ToolKind => kinds[name.toLowerCase()] ?? "other";

/** Grok's `VerbGroupKind` verbs and nouns (tool/mod.rs); `groupable` mirrors `verb_group_kind`. */
const verbs: Record<ToolKind, ToolVerb> = {
	execute: { past: "Ran", present: "Running", noun: "command", plural: "commands", groupable: false, rail: true },
	read: { past: "Read", present: "Reading", noun: "file", plural: "files", groupable: true, rail: false },
	search: { past: "Searched", present: "Searching", noun: "pattern", plural: "patterns", groupable: true, rail: false },
	list: { past: "Listed", present: "Listing", noun: "dir", plural: "dirs", groupable: true, rail: false },
	edit: { past: "Edited", present: "Editing", noun: "file", plural: "files", groupable: false, rail: false },
	write: { past: "Edited", present: "Editing", noun: "file", plural: "files", groupable: false, rail: false },
	web_fetch: { past: "Fetched", present: "Fetching", noun: "website", plural: "websites", groupable: true, rail: true },
	web_search: { past: "Searched", present: "Searching", noun: "website", plural: "websites", groupable: true, rail: true },
	other: { past: "Ran", present: "Running", noun: "tool", plural: "tools", groupable: false, rail: true },
};
export const verbFor = (name: string): ToolVerb => verbs[toolKind(name)];

/** Syntax and status colors share semantic theme tokens, including collapsed rows. */
export const toolColors = {
	punctuation: color.path,
	builtin: color.path,
	keyword: fg("magenta", { italic: true }),
	comment: fg("comment", { italic: true }),
	number: fg("orange"),
	// Retained exports for callers; status marks must never be blended into the background.
	successDim: color.accentSuccess,
	errorDim: color.accentError,
	runningDim: color.accentRunning,
	runningLow: color.accentRunning,
} as const;

const iconKinds: Record<string, IconKind> = {
	codemode: "codemode",
	todo_write: "todo", work_plan: "todo", work_status: "todo", work_finish: "todo",
	task: "subagent", subagents: "subagent",
	lsp: "lsp", lsp_guidance: "lsp",
};
const iconPrefixes: readonly (readonly [string, IconKind])[] = [["github_", "github"], ["memory_", "memory"], ["skills_", "skill"], ["session_", "session"], ["lsp_", "lsp"]];
const kindIcons: Record<ToolKind, IconKind> = {
	execute: "shell", read: "read", search: "search", list: "list", edit: "edit", write: "write", web_fetch: "web_fetch", web_search: "web_search", other: "other",
};
/** Identity only: what kind of work a call does, never how it went. Unknown plugin tools share `other`. */
export const iconKind = (name: string): IconKind => {
	const lower = name.toLowerCase();
	return iconKinds[lower] ?? iconPrefixes.find(([prefix]) => lower.startsWith(prefix))?.[1] ?? kindIcons[toolKind(lower)];
};
/** The active icon set's glyph; `unicode` needs no private-use font, `nerd` needs a Nerd Font. */
export const toolIcon = (name: string): string => icons().tools[iconKind(name)];

export type DisplayStatus = "pending" | "running" | "done" | "failed" | "cancelled" | "unknown";
const displayStatus = (status: string): DisplayStatus => {
	if (status === "error" || status === "failed") return "failed";
	if (status === "aborted" || status === "cancelled") return "cancelled";
	if (status === "pending" || status === "running" || status === "done") return status;
	return "unknown";
};
export const statusStyle = (status: DisplayStatus): Style => status === "failed" ? color.accentError
	: status === "done" ? color.accentSuccess : status === "cancelled" ? color.warning
	: status === "running" ? color.accentRunning : color.textSecondary;
export const statusText = (status: DisplayStatus, ctx: Pick<RenderContext, "tick">): string => {
	const mark = status === "running" ? spinnerFrame(brailleSpinner, ctx.tick)
		: icons().status[status];
	return statusStyle(status)(`${mark} ${status === "pending" ? "waiting" : status}`);
};
const elapsed = (block: ToolBlock, ctx: RenderContext): string => block.startedAt === undefined ? ""
	: ` ${formatElapsed((block.endedAt ?? ctx.now) - block.startedAt)}`;
const statusBadge = (block: ToolBlock, ctx: RenderContext): string => `${statusText(displayStatus(block.status), ctx)}${color.textSecondary(elapsed(block, ctx))}`;

/** Closes fg/bold/italic but not the background, so a wrapped line cannot leak style into the padding. */
const CLOSE = "\x1b[39m\x1b[22m\x1b[23m";
const styled = (style: Style, text: string): string => (text === "" ? "" : style(text));
const clipRow = (row: string, width: number): string => (visibleWidth(row) <= width ? row : `${sliceByColumn(row, 0, Math.max(0, width - visibleWidth(glyph.ellipsis)), true)}${CLOSE}${color.gray(glyph.ellipsis)}`);
const wrapStyled = (text: string, width: number): string[] => wrapTextWithAnsi(text, Math.max(1, width)).map((line) => (line === "" ? "" : `${line}${CLOSE}`));
const wrapPlain = (lines: readonly string[], width: number): string[] => lines.flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));
const hanging = (prefix: string, lines: readonly string[]): string[] => {
	const hang = " ".repeat(visibleWidth(prefix));
	return lines.length === 0 ? [prefix] : lines.map((line, index) => (index === 0 ? `${prefix}${line}` : `${hang}${line}`));
};
function excerpt<T>(rows: readonly T[], first: number, last: number, marker: (hidden: number) => T): T[] {
	if (rows.length <= first + last) return [...rows];
	return [...rows.slice(0, first), marker(rows.length - first - last), ...rows.slice(rows.length - last)];
}

const SHELL_BUILTINS = new Set(["echo", "cd", "export", "source", "set", "unset", "alias", "exit", "return", "if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac", "in", "function", "local", "read", "test", "printf", "eval", "exec", "shift", "trap", "true", "false", "time", "sudo", "env"]);
const SHELL_TOKEN = /\s+|"(?:[^"\\]|\\.)*"?|'[^']*'?|\d?[|;&<>]+\d?|--?[A-Za-z][\w.-]*|\d+(?:\.\d+)?|[^\s"'|;&<>]+/g;

function highlightShellLine(line: string, state: { command: boolean }): string {
	let out = "";
	for (const token of line.match(SHELL_TOKEN) ?? []) {
		const quote = token[0];
		if (/^\s+$/.test(token)) out += token;
		else if (quote === '"' || quote === "'") {
			const closed = token.length > 1 && token.endsWith(quote);
			out += `${toolColors.punctuation(quote)}${styled(color.accentSuccess, token.slice(1, closed ? -1 : undefined))}${closed ? toolColors.punctuation(quote) : ""}`;
			state.command = false;
		} else if (/^\d?[|;&<>]+\d?$/.test(token)) {
			out += color.accentAssistant(token);
			state.command = true;
		} else if (/^--?[A-Za-z]/.test(token)) {
			const dashes = /^-+/.exec(token)?.[0] ?? "-";
			out += `${toolColors.punctuation(dashes)}${color.warning(token.slice(dashes.length))}`;
		} else if (/^\d+(?:\.\d+)?$/.test(token)) out += color.accentUser(token);
		else if (state.command) {
			out += (SHELL_BUILTINS.has(token) ? toolColors.builtin : color.accentUser)(token);
			state.command = false;
		} else out += color.textPrimary(token);
	}
	return out;
}

/** The syntect scopes Grok colors in a `$ command` line, sampled from d-bash-expanded-140x40.png. */
export function highlightCommandLines(lines: readonly string[]): string[] {
	const state = { command: true };
	return lines.map((line) => highlightShellLine(line, state));
}

const CONTROL = new Set(["return", "if", "else", "elif", "for", "while", "do", "switch", "case", "break", "continue", "throw", "try", "catch", "finally", "await", "async", "yield", "new", "delete", "typeof", "instanceof", "in", "of", "not", "and", "or", "is", "match", "loop", "with", "as", "pass", "raise", "except", "lambda", "default"]);
const DECLARE = new Set(["function", "class", "const", "let", "var", "def", "fn", "pub", "struct", "enum", "impl", "trait", "type", "interface", "extends", "implements", "static", "this", "self", "super", "true", "false", "null", "undefined", "None", "True", "False", "void", "mut", "where"]);
const IMPORTS = new Set(["import", "export", "from", "require", "use", "mod", "package", "module"]);
const CODE_TOKEN = /\/\/.*|#.*|\/\*.*?(?:\*\/|$)|"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?|\d+(?:\.\d+)?|[A-Za-z_$][\w$]*|[{}()[\];,.:]|\s+|./g;

/** Keyword-level stand-in for the syntect highlighting Grok applies to Read previews and scripts. */
export function highlightCode(line: string): string {
	const tokens = line.match(CODE_TOKEN) ?? [];
	const words = tokens.filter((token) => !/^\s+$/.test(token));
	let word = -1;
	let out = "";
	for (const token of tokens) {
		const first = token[0];
		if (/^\s+$/.test(token)) {
			out += token;
			continue;
		}
		word++;
		if (token.startsWith("//") || first === "#" || token.startsWith("/*")) out += toolColors.comment(token);
		else if (first === '"' || first === "'" || first === "`") out += color.accentSuccess(token);
		else if (/^\d/.test(token)) out += toolColors.number(token);
		else if (/^[A-Za-z_$]/.test(token)) {
			if (CONTROL.has(token)) out += toolColors.keyword(token);
			else if (DECLARE.has(token)) out += color.accentAssistant(token);
			else if (IMPORTS.has(token)) out += color.running(token);
			else if (words[word + 1] === "(") out += color.accentUser(token);
			else if (words[word + 1] === ":") out += color.warning(token);
			else if (words[word - 1] === ":") out += toolColors.builtin(token);
			else out += color.textPrimary(token);
		} else if (/^[{}()[\];,.:]$/.test(token)) out += toolColors.punctuation(token);
		else out += color.textPrimary(token);
	}
	return out;
}

type Args = Record<string, unknown>;
const argsOf = (block: ToolBlock): Args => block.args as Args;
const str = (args: Args, keys: readonly string[]): string | undefined => {
	for (const key of keys) {
		const value = args[key];
		if (typeof value === "string" && value.trim() !== "") return value;
	}
	return undefined;
};
const num = (args: Args, keys: readonly string[]): number | undefined => {
	for (const key of keys) {
		const value = args[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
	return undefined;
};
const commandOf = (block: ToolBlock): string => str(argsOf(block), ["command", "cmd", "code", "script"]) ?? "";
const highlightFor = (block: ToolBlock): ((lines: readonly string[]) => string[]) => (block.name === "codemode" ? (lines) => lines.map(highlightCode) : highlightCommandLines);
const pathOf = (block: ToolBlock): string => str(argsOf(block), ["path", "file_path", "filePath", "file", "filename", "directory", "dir"]) ?? "";
const isRunning = (block: ToolBlock): boolean => block.status === "running" || block.status === "pending";
const isDone = (block: ToolBlock): boolean => block.status === "done";

/** `Run ` already carries the verb, so a description that starts with "Run"/"Running" drops it (execute.rs `strip_leading_run_word`). */
function descriptionOf(block: ToolBlock): string | undefined {
	const raw = str(argsOf(block), ["description", "title"]);
	if (raw === undefined) return undefined;
	const text = raw.trim().replace(/\s*\n\s*/g, " ").replace(/^run(?:ning)?(?:\s+|$)/i, "");
	return text === "" ? undefined : text;
}

/** Control sequences stripped and tabs expanded so column math holds. */
function outputLines(block: ToolBlock): string[] {
	const text = stripTerminalSequences(block.result ?? block.output).replaceAll("\t", "    ").replace(/\s+$/, "");
	return text === "" ? [] : text.split("\n");
}

type Receipt = { name: string; status: string; id?: number; error?: string };
function codemodeCalls(block: ToolBlock): Receipt[] {
	if (block.name !== "codemode" || typeof block.details !== "object" || block.details === null || !("codemodeCalls" in block.details) || !Array.isArray(block.details.codemodeCalls)) return [];
	return block.details.codemodeCalls.filter((call): call is Receipt => typeof call === "object" && call !== null && typeof call.name === "string" && typeof call.status === "string");
}

/** These are receipt counts, never a guessed percentage of unknown future script work. */
function receiptSummary(block: ToolBlock): string {
	const calls = codemodeCalls(block);
	if (!calls.length) return "";
	const counts = new Map<DisplayStatus, number>();
	for (const call of calls) {
		const state = displayStatus(call.status);
		counts.set(state, (counts.get(state) ?? 0) + 1);
	}
	return `${calls.length} calls · ${[...counts].map(([state, count]) => `${count} ${state}`).join(", ")}`;
}

function receiptRows(block: ToolBlock, ctx: RenderContext, width: number): string[] {
	const calls = codemodeCalls(block);
	if (!calls.length) return [];
	const rows = [color.textSecondary(receiptSummary(block))];
	if (calls.length > 16) rows.push(color.textSecondary(`${calls.length - 16} earlier calls retained in receipt`));
	for (const call of calls.slice(-16)) {
		const name = stripTerminalSequences(call.name).replace(/[\r\n\t]/g, " ");
		const id = typeof call.id === "number" ? `#${call.id} ` : "";
		const lastSeen = !isRunning(block) && (call.status === "running" || call.status === "pending");
		const status = lastSeen ? color.textSecondary(`${icons().status.unknown} last seen ${call.status}`) : statusText(displayStatus(call.status), ctx);
		rows.push(`${status}  ${color.textPrimary(`${id}${toolIcon(name)} ${name}`)}`);
		if (call.error) rows.push(...wrapTextWithAnsi(statusStyle(displayStatus(call.status))(stripTerminalSequences(call.error)), Math.max(1, width - 2)).map(line => `  ${line}`));
	}
	return rows.map(row => clipRow(row, width));
}

/** Compact codemode is an activity list; source, receipt IDs and payloads belong to details. */
function renderCompactCodemode(block: ToolBlock, width: number, ctx: RenderContext): string[] {
	const calls = codemodeCalls(block);
	const rows = calls.map(call => {
		const name = stripTerminalSequences(call.name).replace(/[\r\n\t]/g, " ");
		const state = displayStatus(call.status);
		const lastSeen = !isRunning(block) && (state === "running" || state === "pending");
		const badge = lastSeen ? color.textSecondary(`${icons().status.unknown} last seen ${call.status}`)
			: state === "pending" ? color.textSecondary(`${icons().status.pending} waiting`) : statusText(state, ctx);
		const prefix = `${indent}${statusStyle(lastSeen ? "unknown" : state)(toolIcon(name))} `;
		const budget = Math.max(1, width - visibleWidth(prefix) - visibleWidth(badge) - 2);
		const active = !lastSeen && state === "running";
		const labelStyle = active ? (text: string) => bold(color.accentRunning(text)) : ctx.selected ? color.textPrimary : color.textSecondary;
		const label = clipSegs([seg(name, labelStyle)], budget, color.textSecondary);
		return `${indent}${badge}  ${statusStyle(lastSeen ? "unknown" : state)(toolIcon(name))} ${label}`;
	});
	if (!calls.length) {
		const label = isRunning(block) ? "Tools · no calls yet" : "Tools · no recorded calls";
		const badge = statusBadge(block, ctx);
		const prefix = `${indent}${bulletStyle(block, ctx)(icons().tools.other)} `;
		const budget = Math.max(1, width - visibleWidth(prefix) - visibleWidth(badge) - 2);
		rows.push(`${indent}${badge}  ${bulletStyle(block, ctx)(icons().tools.other)} ${clipSegs([seg(label, color.textSecondary)], budget, color.textSecondary)}`);
	} else if (block.status === "error" || block.status === "cancelled") {
		// A script may fail after successful children. Keep that terminal outcome visible.
		const label = block.status === "error" ? `${icons().status.failed} Script failed` : `${icons().status.cancelled} Script cancelled`;
		rows.push(clipRow(`${indent}${bulletStyle(block, ctx)(label)}  ${color.textSecondary("Ctrl+O details")}`, width));
	}
	return rows;
}

function argsSummary(args: Args): string {
	const parts: string[] = [];
	for (const [key, value] of Object.entries(args)) {
		if (value === undefined || value === null) continue;
		const text = typeof value === "string" ? value : JSON.stringify(value);
		parts.push(`${key}=${text.replace(/\s+/g, " ")}`);
	}
	return parts.join(" ");
}

function readRange(block: ToolBlock): { start: number; end?: number } {
	const args = argsOf(block);
	const start = num(args, ["offset", "start_line", "start"]);
	const limit = num(args, ["limit"]);
	const end = num(args, ["end_line", "end"]) ?? (start !== undefined && limit !== undefined ? start + limit - 1 : undefined);
	return { start: start === undefined || start < 1 ? 1 : start, ...(end === undefined ? {} : { end }) };
}

type FileMatch = { path: string; matches: { line: number; content: string }[] };
type SearchResult = { files: FileMatch[]; paths: string[]; count: number };
const MATCH_LINE = /^(.+?):(\d+)(?::\d+)?:(.*)$/;

/** Groups `path:line[:col]:content` rows by file (ripgrep layout); rows without a line number count as bare paths. */
function parseSearch(lines: readonly string[]): SearchResult {
	const files = new Map<string, FileMatch>();
	const paths: string[] = [];
	let count = 0;
	for (const line of lines) {
		const match = MATCH_LINE.exec(line);
		if (match) {
			const [, path = "", lineNumber = "0", content = ""] = match;
			let file = files.get(path);
			if (!file) {
				file = { path, matches: [] };
				files.set(path, file);
			}
			file.matches.push({ line: Number(lineNumber), content: content.trimEnd() });
			count++;
		} else if (/^\S+$/.test(line)) paths.push(line);
	}
	return { files: [...files.values()], paths, count };
}

function searchSummary(block: ToolBlock, result: SearchResult): string {
	if (!isDone(block)) return "";
	if (result.files.length > 1) return ` (${result.count} matches in ${result.files.length} files)`;
	if (result.count === 1) return " (1 match)";
	if (result.count > 1) return ` (${result.count} matches)`;
	if (result.paths.length === 1) return " (1 file)";
	if (result.paths.length > 1) return ` (${result.paths.length} files)`;
	return " (no matches)";
}

type Seg = { text: string; style: Style };
type HeaderStyles = { text: Style; label: Style; path: Style; term: Style; url: Style; detail: Style };
const mutedHeader: HeaderStyles = { text: color.gray, label: (text) => bold(color.gray(text)), path: color.gray, term: color.gray, url: color.gray, detail: color.grayDim };
const brightHeader: HeaderStyles = { text: color.textPrimary, label: (text) => bold(color.textPrimary(text)), path: color.path, term: color.accentSuccess, url: color.command, detail: color.grayDim };
const raw: Style = (text) => text;
const seg = (text: string, style: Style): Seg => ({ text, style });

function headerSegs(block: ToolBlock, styles: HeaderStyles, bright: boolean): Seg[] {
	const args = argsOf(block);
	switch (toolKind(block.name)) {
		case "execute": {
			const description = descriptionOf(block);
			const flat = commandOf(block).replace(/\s*\n\s*/g, " ");
			if (description !== undefined) return [seg("Run ", styles.label), seg(description, styles.text)];
			if (flat === "") return [seg("Run ", styles.label), seg(glyph.ellipsis, styles.text)];
			return [seg("Run ", styles.label), bright ? seg(highlightFor(block)([flat])[0] ?? "", raw) : seg(flat, styles.text)];
		}
		case "read": {
			const range = readRange(block);
			const detail = `${range.end === undefined ? "" : ` (${range.start}-${range.end})`}${isDone(block) && (block.result ?? "").trim() === "" ? " (empty)" : ""}`;
			return [seg("Read ", styles.label), seg(pathOf(block), styles.path), seg(detail, styles.detail)];
		}
		case "search": {
			const pattern = str(args, ["pattern", "regex", "query"]) ?? "";
			const glob = str(args, ["glob", "include"]);
			const path = str(args, ["path", "directory", "dir"]);
			const segs = [seg("Search ", styles.label), seg(pattern === "" && glob !== undefined ? glob : JSON.stringify(pattern), styles.term)];
			if (pattern !== "" && glob !== undefined) segs.push(seg(" in ", styles.text), seg(glob, styles.term));
			if (path !== undefined) segs.push(seg(" in ", styles.text), seg(path, styles.path));
			if (block.status !== "error") segs.push(seg(searchSummary(block, parseSearch(outputLines(block))), styles.detail));
			return segs;
		}
		case "list": {
			const entries = isDone(block) ? outputLines(block).filter((line) => line.trim() !== "").length : 0;
			return [seg("List ", styles.label), seg(pathOf(block), styles.path), seg(entries > 0 ? ` (${entries} ${entries === 1 ? "entry" : "entries"})` : "", color.gray)];
		}
		case "edit":
			return [seg("Edit ", styles.label), seg(pathOf(block), styles.path)];
		case "write":
			return [seg("Creating ", styles.label), seg(pathOf(block), styles.path)];
		case "web_fetch":
			return [seg("Fetch ", styles.label), seg(str(args, ["url", "href"]) ?? "", styles.url)];
		case "web_search":
			return [seg("Web Search ", styles.label), seg(str(args, ["query", "q", "search"]) ?? "", styles.url)];
		case "other": {
			const summary = argsSummary(args);
			return [seg(block.name, styles.label), seg(summary === "" ? "" : `  ${summary}`, color.gray)];
		}
	}
}

const joinSegs = (segs: readonly Seg[]): string => segs.map((item) => styled(item.style, item.text)).join("");

/** Slices plain segment text instead of `truncateToWidth`, whose `\x1b[0m` would cancel a selection band. */
function clipSegs(segs: readonly Seg[], width: number, ellipsisStyle: Style): string {
	let total = 0;
	for (const item of segs) total += visibleWidth(item.text);
	if (total <= width) return joinSegs(segs);
	let remaining = Math.max(0, width - visibleWidth(glyph.ellipsis));
	let out = "";
	for (const item of segs) {
		const itemWidth = visibleWidth(item.text);
		if (itemWidth <= remaining) {
			out += styled(item.style, item.text);
			remaining -= itemWidth;
			continue;
		}
		const head = sliceByColumn(item.text, 0, remaining, true);
		return `${out}${styled(item.style, head)}${item.style === raw ? CLOSE : ""}${ellipsisStyle(glyph.ellipsis)}`;
	}
	return out;
}

export function toolSummary(block: ToolBlock): string {
	return stripTerminalSequences(headerSegs(block, mutedHeader, false).slice(1).map((item) => item.text).join("")).trimStart();
}

/** State is always legible; motion is confined to the running status glyph. */
export function bulletStyle(block: ToolBlock, _ctx: RenderContext): Style {
	return statusStyle(displayStatus(block.status));
}
const accentStyle = bulletStyle;

const railOf = (block: ToolBlock, ctx: RenderContext): Style | undefined => (ctx.expanded && verbFor(block.name).rail ? accentStyle(block, ctx) : undefined);

const indent = " ".repeat(spacing.bullet);
const READ_FIRST = 5;
const READ_LAST = 3;
const EXECUTE_FIRST = 2;
const EXECUTE_LAST = 3;
const FETCH_INLINE = 10;

function renderCollapsed(block: ToolBlock, width: number, ctx: RenderContext): string {
	const styles = ctx.selected ? brightHeader : mutedHeader;
	const marker = ctx.selected ? glyph.chevron : toolIcon(block.name);
	const badge = statusBadge(block, ctx);
	const prefix = `${indent}${bulletStyle(block, ctx)(marker)} `;
	const budget = Math.max(1, width - visibleWidth(prefix) - visibleWidth(badge) - 2);
	const header = clipSegs(headerSegs(block, styles, ctx.selected), budget, styles.text);
	return `${indent}${badge}  ${bulletStyle(block, ctx)(marker)} ${header}`;
}

function renderExpanded(block: ToolBlock, width: number, ctx: RenderContext): string[] {
	const kind = toolKind(block.name);
	const headingPrefix = `${statusBadge(block, ctx)}  ${bulletStyle(block, ctx)(toolIcon(block.name))} `;
	const textWidth = Math.max(1, width - spacing.bullet - visibleWidth(headingPrefix) - spacing.rightPad);
	const panelWidth = Math.max(1, width - spacing.bullet - spacing.rightPad);
	const panel = (row: string): string => color.bgDark(pad(clipRow(row, panelWidth), panelWidth));
	const error = block.status === "error";
	const output = outputLines(block);
	const highlight = highlightFor(block);
	const rows: string[] = [];
	const segs = headerSegs(block, brightHeader, true);
	const labelText = segs[0]?.text ?? "";
	const label = brightHeader.label(labelText);
	if (kind === "execute" && descriptionOf(block) === undefined && commandOf(block) !== "") {
		rows.push(...hanging(label, highlight(wrapPlain(commandOf(block).split("\n"), textWidth - visibleWidth(labelText)))));
	} else {
		rows.push(...hanging(label, wrapStyled(joinSegs(segs.slice(1)), textWidth - visibleWidth(labelText))));
	}
	const lines = rows.map((row, index) => (index === 0 ? `${headingPrefix}${row}` : `${" ".repeat(visibleWidth(headingPrefix))}${row}`));
	const receipts = receiptRows(block, ctx, panelWidth);
	if (receipts.length) lines.push("", ...receipts);
	const errorRows = (prefix: string, wrap: number) => wrapPlain(output, wrap).map((row) => `${prefix}${color.accentError(row)}`);
	switch (kind) {
		case "execute": {
			if (descriptionOf(block) !== undefined && commandOf(block) !== "") {
				lines.push(...hanging(`${color.grayDim("$")} `, highlight(wrapPlain(commandOf(block).split("\n"), panelWidth - 2))));
			}
			if (error && output.length > 0) lines.push("", ...errorRows("", panelWidth));
			else if (output.length > 0) {
				const wrapped = wrapPlain(output, panelWidth).map((row) => color.textPrimary(row));
				const shown = isRunning(block) ? excerpt(wrapped, EXECUTE_FIRST, EXECUTE_LAST, (hidden) => color.gray(`${glyph.ellipsis} +${hidden} lines`)) : wrapped;
				lines.push("", ...shown.map(panel));
			}
			break;
		}
		case "read": {
			if (error) {
				if (output.length > 0) lines.push("", ...errorRows("", panelWidth));
				break;
			}
			if (output.length === 0) break;
			const base = readRange(block).start;
			const gutter = String(base + output.length - 1).length;
			const contentWidth = Math.max(1, panelWidth - gutter - 2);
			// Choose the displayed wrapped rows before syntax highlighting. Long previews
			// still count continuations for the 5+3 excerpt without styling hidden code.
			type PreviewRow = { lineNumber?: number; code: string };
			const numbered = output.flatMap((line, index): PreviewRow[] => {
				const wrapped = wrapTextWithAnsi(line, contentWidth);
				return (wrapped.length ? wrapped : [""]).map((code, continuation) => ({
					...(continuation === 0 ? { lineNumber: base + index } : {}), code,
				}));
			});
			const shown = excerpt<PreviewRow | null>(numbered, READ_FIRST, READ_LAST, () => null);
			lines.push("", ...shown.map(row => {
				if (row === null) return panel(color.gray(glyph.ellipsis));
				const prefix = row.lineNumber === undefined ? " ".repeat(gutter + 2) : `${color.grayDim(String(row.lineNumber).padStart(gutter))}  `;
				return panel(`${prefix}${highlightCode(row.code)}`);
			}));
			break;
		}
		case "search": {
			const args = argsOf(block);
			const modeName = args.output_mode === "files_with_matches" ? "files" : args.output_mode === "count" ? "count" : "pattern";
			const flags = args.case_insensitive === true || args["-i"] === true ? `${color.gray(", case-insensitive: ")}${color.textPrimary("true")}` : "";
			lines.push("", `  ${color.gray("mode: ")}${color.textPrimary(modeName)}${flags}`);
			if (error) {
				if (output.length > 0) lines.push("", ...errorRows("  ", textWidth));
				break;
			}
			const result = parseSearch(output);
			if (result.files.length > 0) {
				lines.push("");
				result.files.forEach((file, index) => {
					if (index > 0) lines.push("");
					lines.push(panel(`  ${color.path(file.path)}`));
					for (const match of file.matches) lines.push(panel(`    ${color.gray(String(match.line).padStart(4))}  ${color.textPrimary(match.content)}`));
				});
			} else if (result.paths.length > 0) lines.push("", ...result.paths.map((path) => panel(`  ${color.path(path)}`)));
			else if (!isRunning(block)) lines.push("", `  ${color.gray("(no results)")}`);
			break;
		}
		case "web_fetch": {
			if (error) {
				if (output.length > 0) lines.push("", ...errorRows("  ", textWidth));
				break;
			}
			if (output.length === 0) break;
			const shown = output.slice(0, FETCH_INLINE).map((row) => `  ${color.textPrimary(row)}`);
			if (output.length > FETCH_INLINE) shown.push(`  ${color.grayDim(`... (${output.length - FETCH_INLINE} more lines)`)}`);
			lines.push("", panel(""), ...shown.map(panel), panel(""));
			break;
		}
		case "list": {
			if (error) {
				if (output.length > 0) lines.push("", ...errorRows("", panelWidth));
				break;
			}
			if (output.length > 0) lines.push("", ...wrapPlain(output, panelWidth).map((row) => panel(color.textPrimary(row))));
			break;
		}
		default: {
			if (error) {
				if (output.length > 0) lines.push("", ...errorRows("  ", textWidth));
				break;
			}
			if (output.length > 0) lines.push("", ...wrapPlain(output, panelWidth).map((row) => color.gray(row)));
			break;
		}
	}
	const rail = railOf(block, ctx);
	const lead = rail ? `${rail(glyph.accentBar)}${" ".repeat(spacing.bullet - 1)}` : indent;
	return lines.map((line) => (line === "" && rail ? rail(glyph.accentBar) : `${lead}${line}`));
}

type Cached = { version: number; width: number; expanded: boolean; selected: boolean; phase: string; lines: string[] };
const cache = new WeakMap<ToolBlock, Cached[]>();

/** Two recent layouts per block; versions retire old output, motion/time keys update only active work. */
export function renderTool(block: ToolBlock, width: number, ctx: RenderContext): string[] {
	const running = isRunning(block);
	const phase = running ? `${spinnerFrame(brailleSpinner, ctx.tick)}:${elapsed(block, ctx)}` : "";
	let entries = cache.get(block);
	if (!entries || entries[0]?.version !== block.version) {
		entries = [];
		cache.set(block, entries);
	}
	const index = entries.findIndex(hit => hit.width === width && hit.expanded === ctx.expanded && hit.selected === ctx.selected && hit.phase === phase);
	if (index >= 0) {
		const hit = entries.splice(index, 1)[0]!;
		entries.unshift(hit);
		return hit.lines;
	}
	const rendered = ctx.expanded ? renderExpanded(block, width, ctx)
		: block.name === "codemode" ? renderCompactCodemode(block, width, ctx) : [renderCollapsed(block, width, ctx)];
	// Normal layouts already account for their columns. Only widths smaller than the
	// fixed status/padding need an emergency crop; rescanning every output row is costly.
	const lines = width >= 32 ? rendered : rendered.map(line => visibleWidth(line) > Math.max(0, width) ? sliceByColumn(line, 0, Math.max(0, width), true) : line);
	entries.unshift({ version: block.version, width, expanded: ctx.expanded, selected: ctx.selected, phase, lines });
	entries.length = Math.min(entries.length, 2);
	return lines;
}
