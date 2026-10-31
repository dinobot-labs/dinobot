import {
	colorToHex,
	foregroundAnsi,
	getCapabilities,
	getImageDimensions,
	getTerminalColorMode,
	Image,
	type ImageTheme,
	Markdown,
	type MarkdownTheme,
	mixColors,
	parseColor,
	styleTextWithAnsi,
	type TextAttributes,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { RenderContext } from "../screen.ts";
import type { AgentBlock, Block, NoticeBlock, NoticeLevel, ThinkingBlock, UserBlock } from "../state.ts";
import { formatCacheRatio, formatTps } from "../state.ts";
import { ansi, bold, color, dim, formatClock, formatElapsed, glyph, icons, italic, pad, palette, themeName, separator, spacing, strike, type Style } from "../theme.ts";

/** Grok reserves 10 columns for the `  h:mm AM` stamp on message blocks (entry_renderer.rs:323). */
const TIMESTAMP_RESERVED = 10;
/** Collapsed prompts keep 3 visual lines, estimated at 60 columns per line (user.rs:15, user.rs:409). */
const COLLAPSED_PROMPT_LINES = 3;
const FOLD_ESTIMATE_WIDTH = 60;
/** Running thoughts show their last 3 lines; thought bodies blend 0.7 toward the background (config.rs:489-490). */
const TRUNCATED_LINES = 3;
const THINKING_BLEND = 0.7;
/** Running rails pulse with sin² over 32 rows at 0.15 rad per tick (tokyonight.rs:345, entry_renderer.rs:21). */
const WAVE_ROWS = 32;
const WAVE_SPEED = 0.15;

/** Zero-width sentinels the markdown post-pass consumes: heading level U+0001..6, heading span, fence line. */
const HEADING_OPEN = "\u0010";
const HEADING_CLOSE = "\u0011";
const FENCE_MARK = "\u0012";
const CODE_MARK = ansi.bg("bgHighlight");
const headingLevel = /[\u0001-\u0006]/;
const headingMarkers = /[\u0001-\u0006\u0010\u0011]/;

const mode = getTerminalColorMode();
const fgHex = (hex: string, attributes: TextAttributes = {}): Style => {
	const code = foregroundAnsi(parseColor(hex), mode);
	return (text) => styleTextWithAnsi(text, code, undefined, attributes);
};
const blend = (hex: string, amount: number): string => colorToHex(mixColors(parseColor(palette.bgStorm), parseColor(hex), amount, "srgb"));

const indent = " ".repeat(spacing.bullet);
const railGap = " ".repeat(spacing.bullet - 1);
const contentWidthOf = (width: number): number => Math.max(1, width - spacing.bullet - spacing.rightPad);
const timestamp = (at: number): string => color.gray(formatClock(at).padStart(TIMESTAMP_RESERVED));

/** Code tokens share the semantic palette with the rest of the fullscreen UI. */
const syntax = {
	plain: palette.fgDark,
	comment: palette.comment,
	string: palette.green,
	constant: palette.orange,
	keyword: palette.magenta,
	modifier: palette.purple,
	module: palette.cyan,
	name: palette.blue,
	parameter: palette.yellow,
	bracket: palette.blue,
	operator: palette.cyan,
	language: palette.red,
	type: palette.teal,
	variable: palette.fg,
} as const;
type TokenKind = keyof typeof syntax | "flow";
type SyntaxPaint = Readonly<Record<TokenKind, Style>>;
type Lexicon = {
	readonly keywords: ReadonlySet<string>;
	readonly flow: ReadonlySet<string>;
	readonly modules: ReadonlySet<string>;
	readonly modifiers: ReadonlySet<string>;
	readonly constants: ReadonlySet<string>;
	readonly types: ReadonlySet<string>;
	readonly definers: ReadonlySet<string>;
	readonly language: ReadonlySet<string>;
	readonly lineComment: string;
	readonly cStyle: boolean;
	readonly dollarVariables: boolean;
};
type LexiconSpec = { readonly [K in Exclude<keyof Lexicon, "lineComment" | "cStyle" | "dollarVariables">]?: string } & { readonly lineComment?: string; readonly cStyle?: boolean; readonly dollarVariables?: boolean };
const words = (list: string): ReadonlySet<string> => new Set(list.split(" ").filter((word) => word !== ""));
const lexicon = (spec: LexiconSpec): Lexicon => ({
	keywords: words(spec.keywords ?? ""),
	flow: words(spec.flow ?? ""),
	modules: words(spec.modules ?? ""),
	modifiers: words(spec.modifiers ?? ""),
	constants: words(spec.constants ?? ""),
	types: words(spec.types ?? ""),
	definers: words(spec.definers ?? ""),
	language: words(spec.language ?? ""),
	lineComment: spec.lineComment ?? "#",
	cStyle: spec.cStyle ?? false,
	dollarVariables: spec.dollarVariables ?? false,
});
const genericLexicon = lexicon({});
const lexicons: Readonly<Record<string, Lexicon>> = {
	python: lexicon({
		keywords: "def class lambda with as global nonlocal del pass and or not in is",
		flow: "return if elif else for while try except finally raise yield await async break continue assert match case",
		modules: "import from",
		constants: "True False None",
		types: "int str float bool list dict set tuple bytes object print len range enumerate zip map filter sorted sum min max open isinstance type super",
		definers: "def",
		language: "self cls",
	}),
	typescript: lexicon({
		keywords: "const let var function class new typeof instanceof in of void delete async await extends implements interface type enum namespace declare satisfies as keyof infer",
		flow: "return if else for while do switch case default break continue try catch finally throw yield",
		modules: "import export from",
		modifiers: "public private protected readonly static override abstract",
		constants: "true false null undefined NaN Infinity",
		types: "string number boolean any void never unknown object symbol bigint console Promise Map Set Array Object JSON Math Date Error",
		definers: "function",
		language: "this super",
		lineComment: "//",
		cStyle: true,
	}),
	bash: lexicon({
		keywords: "function select in local export declare readonly",
		flow: "if then else elif fi for while until do done case esac return exit break continue",
		constants: "true false",
		definers: "function",
		dollarVariables: true,
	}),
	rust: lexicon({
		keywords: "let fn struct enum impl trait type where use mod crate as dyn ref move unsafe extern static const",
		flow: "return if else match for while loop break continue in async await",
		modules: "use mod",
		modifiers: "pub mut",
		constants: "true false None Some Ok Err",
		types: "u8 u16 u32 u64 u128 usize i8 i16 i32 i64 i128 isize f32 f64 bool char str String Vec Option Result Box",
		definers: "fn",
		language: "self Self",
		lineComment: "//",
		cStyle: true,
	}),
	go: lexicon({
		keywords: "func var const type struct interface map chan package go defer range",
		flow: "return if else for switch case default break continue select fallthrough goto",
		modules: "import package",
		constants: "true false nil iota",
		types: "int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 float32 float64 string bool byte rune error any",
		definers: "func",
		lineComment: "//",
		cStyle: true,
	}),
};
const lexiconAliases: Readonly<Record<string, string>> = { py: "python", python: "python", js: "typescript", javascript: "typescript", jsx: "typescript", ts: "typescript", typescript: "typescript", tsx: "typescript", mjs: "typescript", cjs: "typescript", sh: "bash", bash: "bash", shell: "bash", zsh: "bash", console: "bash", rs: "rust", rust: "rust", go: "go", golang: "go" };
const lexiconFor = (lang: string | undefined): Lexicon => lexicons[lexiconAliases[(lang ?? "").trim().toLowerCase()] ?? ""] ?? genericLexicon;

type HighlightState = { blockComment: boolean; tripleQuote: string | undefined; params: number; pendingParams: boolean };
type Highlighting = { readonly lexicon: Lexicon; readonly state: HighlightState; readonly paint: SyntaxPaint };
type WordHint = { readonly afterDefiner: boolean; readonly call: boolean; readonly param: boolean; readonly decorated: boolean };
const identifierAt = /[A-Za-z_$][\w$]*/y;
const numberAt = /\d[\w.]*/y;
const spaceAt = /\s+/y;

function classify(word: string, lexicon: Lexicon, hint: WordHint): TokenKind {
	if (lexicon.language.has(word)) return "language";
	if (lexicon.constants.has(word)) return "constant";
	if (lexicon.modules.has(word)) return "module";
	if (lexicon.modifiers.has(word)) return "modifier";
	if (lexicon.flow.has(word)) return "flow";
	if (lexicon.keywords.has(word)) return "keyword";
	if (lexicon.types.has(word)) return "type";
	if (hint.afterDefiner || hint.call || hint.decorated) return "name";
	if (hint.param) return "parameter";
	return "plain";
}

function highlightLine(line: string, { lexicon, state, paint }: Highlighting): string {
	let out = "";
	let i = 0;
	let afterDefiner = false;
	const emit = (kind: TokenKind, text: string): void => {
		out += paint[kind](text);
		i += text.length;
		if (kind !== "name") state.pendingParams = false;
	};
	while (i < line.length) {
		if (state.blockComment) {
			const end = line.indexOf("*/", i);
			emit("comment", line.slice(i, end < 0 ? line.length : end + 2));
			if (end >= 0) state.blockComment = false;
			continue;
		}
		if (state.tripleQuote !== undefined) {
			const end = line.indexOf(state.tripleQuote, i);
			emit("string", line.slice(i, end < 0 ? line.length : end + 3));
			if (end >= 0) state.tripleQuote = undefined;
			continue;
		}
		spaceAt.lastIndex = i;
		const space = spaceAt.exec(line);
		if (space) {
			out += space[0];
			i += space[0].length;
			continue;
		}
		const char = line.charAt(i);
		if (line.startsWith(lexicon.lineComment, i) || (lexicon.cStyle && line.startsWith("//", i))) {
			emit("comment", line.slice(i));
			continue;
		}
		if (lexicon.cStyle && line.startsWith("/*", i)) {
			state.blockComment = true;
			continue;
		}
		if (char === '"' || char === "'" || char === "`") {
			const triple = char.repeat(3);
			if (line.startsWith(triple, i)) {
				const end = line.indexOf(triple, i + 3);
				if (end < 0) state.tripleQuote = triple;
				emit("string", line.slice(i, end < 0 ? line.length : end + 3));
				continue;
			}
			let j = i + 1;
			while (j < line.length && line.charAt(j) !== char) j += line.charAt(j) === "\\" ? 2 : 1;
			emit("string", line.slice(i, Math.min(line.length, j + 1)));
			continue;
		}
		if (char === "$" && lexicon.dollarVariables) {
			identifierAt.lastIndex = i + 1;
			const name = identifierAt.exec(line);
			emit("variable", name ? `$${name[0]}` : "$");
			continue;
		}
		numberAt.lastIndex = i;
		const number = numberAt.exec(line);
		if (number) {
			emit("constant", number[0]);
			afterDefiner = false;
			continue;
		}
		identifierAt.lastIndex = i;
		const identifier = identifierAt.exec(line);
		if (identifier) {
			const word = identifier[0];
			const kind = classify(word, lexicon, { afterDefiner, call: line.slice(i + word.length).trimStart().startsWith("("), param: state.params > 0, decorated: line.charAt(i - 1) === "@" });
			emit(kind, word);
			state.pendingParams = afterDefiner;
			afterDefiner = lexicon.definers.has(word);
			continue;
		}
		afterDefiner = false;
		if ("([{".includes(char)) {
			if (char === "(" && state.pendingParams) state.params = 1;
			else if (state.params > 0) state.params++;
			emit("bracket", char);
		} else if (")]}".includes(char)) {
			if (state.params > 0) state.params--;
			emit("bracket", char);
		} else emit("operator", char);
	}
	return out;
}

const HIGHLIGHT_MEMO_LIMIT = 512;

function highlighter(paint: SyntaxPaint): (source: string, lang: string | undefined) => string[] {
	const memo = new Map<string, string[]>();
	return (source, lang) => {
		const key = `${lang ?? ""}\u0000${source}`;
		const hit = memo.get(key);
		if (hit !== undefined) return hit;
		const highlighting: Highlighting = { lexicon: lexiconFor(lang), state: { blockComment: false, tripleQuote: undefined, params: 0, pendingParams: false }, paint };
		const lines = source.split("\n").map((line) => `${CODE_MARK}${highlightLine(line, highlighting)}`);
		if (memo.size >= HIGHLIGHT_MEMO_LIMIT) memo.clear();
		memo.set(key, lines);
		return lines;
	};
}

type MarkdownStyles = { readonly theme: MarkdownTheme; readonly text: Style; readonly headings: readonly Style[] };

function markdownStyles(tint: (hex: string) => string): MarkdownStyles {
	const tone = (kind: keyof typeof syntax, attributes: TextAttributes = {}): Style => fgHex(tint(syntax[kind]), attributes);
	const paint: SyntaxPaint = {
		plain: tone("plain"),
		comment: tone("comment", { italic: true }),
		string: tone("string"),
		constant: tone("constant"),
		keyword: tone("keyword"),
		flow: tone("keyword", { italic: true }),
		modifier: tone("modifier"),
		module: tone("module"),
		name: tone("name"),
		parameter: tone("parameter"),
		bracket: tone("bracket"),
		operator: tone("operator"),
		language: tone("language"),
		type: tone("type"),
		variable: tone("variable"),
	};
	const text = fgHex(tint(palette.fg));
	const muted = fgHex(tint(palette.comment));
	const headings = [palette.teal, palette.blue, palette.orange, palette.red, palette.green, palette.magenta].map((hex) => fgHex(tint(hex)));
	const theme: MarkdownTheme = {
		heading: (content) => `${HEADING_OPEN}${content}${HEADING_CLOSE}`,
		link: fgHex(tint(palette.blue), { underline: true }),
		linkUrl: muted,
		code: fgHex(tint(palette.green1), { bold: true }),
		codeBlock: paint.plain,
		codeBlockBorder: () => FENCE_MARK,
		codeBlockIndent: "",
		quote: (content) => content.replaceAll("\x1b[3m", "").replaceAll("\x1b[23m", ""),
		quoteBorder: (content) => dim(muted(content)),
		hr: muted,
		listBullet: (marker) => muted(marker.replace(/^[-*+]/, glyph.listBullet)),
		bold,
		italic,
		strikethrough: strike,
		underline: (content) => content,
		highlightCode: highlighter(paint),
	};
	return { theme, text, headings };
}
const agentStyles = markdownStyles((hex) => hex);
const thinkingStyles = markdownStyles((hex) => blend(hex, THINKING_BLEND));
export const markdownTheme: MarkdownTheme = agentStyles.theme;

function markHeadings(markdown: string): string {
	let fenced = false;
	return markdown
		.split("\n")
		.map((line) => {
			if (/^ {0,3}(`{3,}|~{3,})/.test(line)) {
				fenced = !fenced;
				return line;
			}
			return fenced ? line : line.replace(/^( {0,3}#{1,6})[ \t]+(?=\S)/, (_match, hashes: string) => `${hashes} ${String.fromCharCode(hashes.trim().length)}`);
		})
		.join("\n");
}

type HeadingState = { level: number; open: boolean };

function styleHeading(line: string, state: HeadingState, headings: readonly Style[]): string {
	const level = headingLevel.exec(line);
	if (level) state.level = level[0].charCodeAt(0);
	const style = headings[state.level - 1] ?? headings[0] ?? ((content: string) => content);
	const clean = line.replace(/[\u0001-\u0006]/g, "").replaceAll("\x1b[1m", "").replaceAll("\x1b[22m", "");
	let out = "";
	let segment = "";
	let open = state.open;
	const flush = (): void => {
		if (segment !== "") out += open ? (/^#{1,6} $/.test(segment) ? "" : style(segment)) : segment;
		segment = "";
	};
	for (const char of clean) {
		if (char === HEADING_OPEN) {
			if (!open) {
				flush();
				open = true;
			}
		} else if (char === HEADING_CLOSE) {
			if (open) {
				flush();
				open = false;
			}
		} else segment += char;
	}
	flush();
	state.open = open;
	return bold(out);
}

type MarkdownLayout = { readonly textWidth: number; readonly panelWidth: number; readonly stamp: string };

function layoutMarkdown(rendered: readonly string[], styles: MarkdownStyles, layout: MarkdownLayout): string[] {
	const state: HeadingState = { level: 1, open: false };
	const lines: string[] = [];
	for (const line of rendered) {
		if (line.startsWith(FENCE_MARK)) continue;
		const stamp = lines.length === 0 ? layout.stamp : "";
		if (line.startsWith(CODE_MARK)) {
			lines.push(color.codeBg(`${pad(line.slice(CODE_MARK.length), stamp === "" ? layout.panelWidth : layout.textWidth)}${stamp}`));
			continue;
		}
		const body = state.open || headingMarkers.test(line) ? styleHeading(line, state, styles.headings) : line;
		lines.push(`${pad(body, layout.textWidth)}${stamp}`);
	}
	return lines;
}

const markdowns = new WeakMap<Block, { readonly markdown: Markdown; text: string; theme: string }>();
function markdownFor(block: AgentBlock | ThinkingBlock, styles: MarkdownStyles): Markdown {
	const entry = markdowns.get(block);
	if (entry !== undefined && entry.theme === themeName()) {
		if (entry.text !== block.text) {
			entry.markdown.setText(block.text);
			entry.text = block.text;
		}
		return entry.markdown;
	}
	let source: string | undefined;
	let marked = "";
	const transform = (markdown: string): string => {
		if (markdown !== source) {
			source = markdown;
			marked = markHeadings(markdown);
		}
		return marked;
	};
	const markdown = new Markdown(block.text, 0, 0, styles.theme, { color: styles.text }, { transform, preserveOrderedListMarkers: true });
	markdowns.set(block, { markdown, text: block.text, theme: themeName() });
	return markdown;
}

type CacheKey = { readonly theme: string; readonly width: number; readonly expanded: boolean; readonly selected: boolean; readonly tick: number };
type Cached = CacheKey & { readonly version: number; readonly lines: string[] };
// Keep two layouts per immutable block so split/maximize round trips do not reparse history.
// Version changes discard both; the WeakMap releases entries with their conversation.
const cache = new WeakMap<Block, Cached[]>();
const keyOf = (width: number, ctx: RenderContext, animated: boolean): CacheKey => ({ theme: themeName(), width, expanded: ctx.expanded, selected: ctx.selected, tick: animated ? ctx.tick : -1 });

function cached(block: Block, key: CacheKey, render: () => string[]): string[] {
	const entries = (cache.get(block) ?? []).filter((entry) => entry.version === block.version);
	const index = entries.findIndex((entry) => entry.theme === key.theme && entry.width === key.width && entry.expanded === key.expanded && entry.selected === key.selected && entry.tick === key.tick);
	if (index >= 0) {
		const hit = entries.splice(index, 1)[0]!;
		entries.unshift(hit);
		cache.set(block, entries);
		return hit.lines;
	}
	const lines = render();
	cache.set(block, [{ ...key, version: block.version, lines }, ...entries].slice(0, 2));
	return lines;
}

const logicalLines = (text: string): string[] => text.replace(/\r?\n$/, "").split(/\r?\n/);

/** Grok's user.rs:400 estimate: more than 3 visual lines at 60 columns makes a prompt collapsible. */
export function isFoldablePrompt(text: string): boolean {
	let visual = 0;
	for (const line of logicalLines(text)) {
		const width = visibleWidth(line);
		visual += width === 0 ? 1 : Math.ceil(width / FOLD_ESTIMATE_WIDTH);
		if (visual > COLLAPSED_PROMPT_LINES) return true;
	}
	return false;
}

function promptLines(text: string, width: number, maxLines: number | undefined): string[] {
	const logical = logicalLines(text);
	const lines: string[] = [];
	for (let index = 0; index < logical.length; index++) {
		const pieces = wrapTextWithAnsi(logical[index] ?? "", width);
		for (let piece = 0; piece < pieces.length; piece++) {
			const row = pieces[piece] ?? "";
			const more = piece + 1 < pieces.length || index + 1 < logical.length;
			if (maxLines !== undefined && lines.length + 1 === maxLines && more) {
				lines.push(`${wrapTextWithAnsi(row, Math.max(1, width - visibleWidth(glyph.truncation)))[0] ?? ""}${glyph.truncation}`);
				return lines;
			}
			lines.push(row);
			if (maxLines !== undefined && lines.length >= maxLines) return lines;
		}
	}
	return lines;
}

/** Fallback tint for transcript thumbnails when a terminal cannot draw graphics. */
const userImageTheme: ImageTheme = { fallbackColor: color.gray };

/** Renders a user prompt as a `bg_light` band: `❯ text` with a right-aligned timestamp, one blank band row above and below. Images ride below the band as thumbnails (or labeled text lines without an image protocol), unpainted so a graphics placement keeps its cells. */
export function renderUser(block: UserBlock, width: number, ctx: RenderContext): string[] {
	return cached(block, keyOf(width, ctx, false), () => {
		const images = block.images ?? [];
		const textWidth = Math.max(1, contentWidthOf(width) - TIMESTAMP_RESERVED);
		const arrowWidth = visibleWidth(glyph.promptArrow);
		const promptWidth = Math.max(1, textWidth - arrowWidth);
		const maxLines = ctx.expanded || images.length > 0 || !isFoldablePrompt(block.text) ? undefined : COLLAPSED_PROMPT_LINES;
		const rows = promptLines(block.text, promptWidth, maxLines).map((line, index) => {
			const prefix = index === 0 ? color.accentUser(glyph.promptArrow) : " ".repeat(arrowWidth);
			return `${indent}${prefix}${pad(color.textPrimary(line), promptWidth)}${index === 0 ? timestamp(block.at) : ""}`;
		});
		const band = ["", ...rows, ""].map((row) => color.bgLight(pad(row, width)));
		return [...band, ...images.flatMap((image) => userImageRows(image, width))];
	});
}

/** The rows one attached image contributes: a live thumbnail with an image protocol, a labeled line without. */
function userImageRows(image: { mimeType: string; data: string }, width: number): string[] {
	if (getCapabilities().images) {
		const component = new Image(image.data, image.mimeType, userImageTheme, { maxWidthCells: 28, maxHeightCells: 9 },
			getImageDimensions(image.data, image.mimeType) ?? undefined);
		return component.render(contentWidthOf(width));
	}
	const format = image.mimeType.slice("image/".length).toUpperCase();
	const bytes = Buffer.byteLength(image.data, "base64");
	const size = bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB` : `${Math.max(1, Math.round(bytes / 1024))} KiB`;
	return [`${indent}${color.gray(`[▣ image ${format} ${size}]`)}`];
}

/** Renders assistant markdown at the bullet column with a timestamp on the first row and content-wide code panels. */
export function renderAgent(block: AgentBlock, width: number, ctx: RenderContext): string[] {
	return cached(block, keyOf(width, ctx, false), () => {
		const contentWidth = contentWidthOf(width);
		const textWidth = Math.max(1, contentWidth - TIMESTAMP_RESERVED);
		const stamp = timestamp(block.at);
		const lines = layoutMarkdown(markdownFor(block, agentStyles).render(textWidth), agentStyles, { textWidth, panelWidth: contentWidth, stamp });
		if (lines.length === 0) lines.push(`${pad("", textWidth)}${stamp}`);
		return lines.map((line) => `${indent}${line}`);
	});
}

const waveStyles = new Map<number, Style>();
function waveStyle(tick: number, row: number): Style {
	const step = Math.round(Math.sin(tick * WAVE_SPEED + (row / WAVE_ROWS) * 2 * Math.PI) ** 2 * 16);
	let style = waveStyles.get(step);
	if (style === undefined) {
		style = fgHex(blend(palette.fgGutter, step / 16));
		waveStyles.set(step, style);
	}
	return style;
}

/** thinking.rs:245: under a minute one decimal, otherwise `XmYs`. */
const thoughtDuration = (ms: number): string => {
	const seconds = Math.max(0, ms) / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m${Math.round(seconds - minutes * 60)}s`;
};

function thinkingHeader(block: ThinkingBlock, ctx: RenderContext): string {
	const mark = icons().thinking;
	if (block.streaming) return `${waveStyle(ctx.tick, 0)(mark)} ${bold(color.gray(`Thinking${glyph.ellipsis}`))}`;
	const bullet = ctx.selected && !ctx.expanded ? color.grayBright(glyph.chevron) : ctx.expanded ? color.grayBright(mark) : color.gray(mark);
	const label = bold((ctx.selected ? color.textPrimary : color.gray)("Thought"));
	const detail = block.endedAt === undefined ? "" : color.gray(` for ${thoughtDuration(block.endedAt - block.startedAt)}`);
	return `${bullet} ${label}${detail}`;
}

/** Renders `⁂ Thought for 2.5s` / `⁂ Thinking…` (the active set's `thinking` icon); open or running blocks add the `┃` rail, a blank row and the blended markdown body (last 3 rows while running). */
export function renderThinking(block: ThinkingBlock, width: number, ctx: RenderContext): string[] {
	return cached(block, keyOf(width, ctx, block.streaming), () => {
		const header = thinkingHeader(block, ctx);
		if (!ctx.expanded && !block.streaming) return [`${indent}${header}`];
		const contentWidth = contentWidthOf(width);
		const body = layoutMarkdown(markdownFor(block, thinkingStyles).render(contentWidth), thinkingStyles, { textWidth: contentWidth, panelWidth: contentWidth, stamp: "" });
		if (body.length === 0) return [`${indent}${header}`];
		const shown = block.streaming && !ctx.expanded && body.length > TRUNCATED_LINES ? [color.gray(glyph.ellipsis), ...body.slice(-TRUNCATED_LINES)] : body;
		const rail = block.streaming ? (row: number) => waveStyle(ctx.tick, row)(glyph.accentBar) : (): string => color.accentThinking(glyph.accentBar);
		return [header, "", ...shown].map((line, row) => `${rail(row)}${railGap}${line}`);
	});
}

const noticeStyle = (level: NoticeLevel): Style => {
	switch (level) {
		case "error":
			return color.warning;
		case "info":
		case "turn":
			return color.gray;
	}
};

/** Renders a muted marker line such as `Worked for 12s` or `Worked for 12s - 48 tok/s - cache 92%`, or a warning-colored error with its `┃` rail, at the content column. */
export function renderNotice(block: NoticeBlock, width: number, ctx: RenderContext): string[] {
	return cached(block, keyOf(width, ctx, false), () => {
		let text = block.level === "turn" ? `${block.text} ${formatElapsed(block.elapsedMs ?? 0, true)}` : block.text;
		if (block.level === "turn" && block.metrics) {
			const parts: string[] = [];
			if (block.metrics.tps !== undefined) parts.push(formatTps(block.metrics.tps));
			if (block.metrics.cacheRatio !== undefined) parts.push(formatCacheRatio(block.metrics.cacheRatio));
			if (parts.length > 0) {
				text = `${text}${separator.meta}${parts.join(separator.meta)}`;
			}
		}
		const style = noticeStyle(block.level);
		const lead = block.level === "error" ? `${color.warning(glyph.accentBar)}${railGap}` : indent;
		return logicalLines(text)
			.flatMap((line) => wrapTextWithAnsi(line, contentWidthOf(width)))
			.map((line) => `${lead}${style(line)}`);
	});
}
