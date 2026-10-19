import {
	type Component,
	CURSOR_MARKER,
	Editor,
	type EditorTheme,
	foregroundAnsi,
	getTerminalColorMode,
	matchesKey,
	type OverlayOptions,
	parseColor,
	ScrollView,
	type ScrollViewOptions,
	styleTextWithAnsi,
	getCapabilities,
	getImageDimensions,
	Image,
	type ImageTheme,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { UpdateInfo } from "../update.ts";
import type { CommandPromptSpec } from "../commands/types.ts";
import { verbFor } from "./blocks/tools.ts";
import { type OverlaySize, styleHint, wrapHints } from "./modal.ts";
import { type DropdownLayout, type DropdownRow, rank, renderDropdownPanel, type SlashMenu } from "./slash.ts";
import { imageMarker, type StagedImage } from "./attachments.ts";
import type { CallMetrics, RunState } from "./state.ts";
import { formatCacheRatio, formatTps } from "./state.ts";
import { bold, brailleSpinner, color, dim, dotSpinner, formatElapsed, formatTokens, glyph, inverse, pad, paint, palette, type PaletteName, rounded, separator, spacing, spinnerFrame, square, type Style } from "./theme.ts";

const margin = " ".repeat(spacing.margin);

/** Passive app-level notice; no transcript entry, focus target, or automatic installation. */
export function renderUpdateNotice(info: UpdateInfo | null, width: number): string[] {
	if (!info || width < 1) return [];
	const inset = Math.min(spacing.margin, Math.floor((width - 1) / 2));
	const inner = Math.max(1, width - inset * 2);
	const lines = [
		`${color.accentSystem("Update available")}  ${color.gray(`${info.current} -> ${info.latest}`)}`,
		`${color.gray("Run")} ${color.command("dinobot update")} ${color.gray("in your shell")}`,
	];
	return lines.flatMap(line => wrapTextWithAnsi(line, inner)).map(line => `${" ".repeat(inset)}${line}`);
}

/** `left … right` inside the page margins (`spacing.margin` on both sides); the left part is clipped first so the right part never moves. */
const splitRow = (left: string, right: string, width: number): string => {
	const inner = width - spacing.margin * 2;
	const rightWidth = visibleWidth(right);
	const leftClipped = truncateToWidth(left, Math.max(0, inner - rightWidth - (rightWidth > 0 ? 1 : 0)), glyph.ellipsis);
	return `${margin}${leftClipped}${" ".repeat(Math.max(0, inner - visibleWidth(leftClipped) - rightWidth))}${right}`;
};

/** Grok fades captions toward `bg_base` by opacity (prompt_widget/mod.rs:3507-3598) and lerps the context meter between breakpoints (context_bar.rs:53-103); theme.ts has no blending, so the mixed foregrounds live here. */
const colorMode = getTerminalColorMode();
const channels = (hex: string): number[] => [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
const mixes = new Map<string, Style>();
function mix(from: PaletteName, to: PaletteName, amount: number): Style {
	const key = `${from}>${to}@${amount}`;
	let style = mixes.get(key);
	if (style === undefined) {
		const start = channels(palette[from]);
		const end = channels(palette[to]);
		const hex = start.map((channel, index) => Math.round(channel + ((end[index] ?? channel) - channel) * amount).toString(16).padStart(2, "0")).join("");
		const ansi = foregroundAnsi(parseColor(`#${hex}`), colorMode);
		style = (text) => styleTextWithAnsi(text, ansi, undefined, {});
		mixes.set(key, style);
	}
	return style;
}
const faded = (name: PaletteName, opacity: number): Style => mix("bgStorm", name, opacity);
/** Grok's `faint()`: gray_dim at 0.66 toward the background, for the header's ` │ ` and receded prompt chrome (theme/tokyonight.rs:275-280). */
const faint = faded("fgGutter", 0.66);

/** Context meter colors: text_primary at 0%, accent_user 50-65%, warning 75-85%, accent_error from 95% (context_bar.rs:53-80). */
const usageBreakpoints: readonly (readonly [pct: number, name: PaletteName])[] = [
	[0, "fg"],
	[50, "blue"],
	[65, "blue"],
	[75, "yellow"],
	[85, "yellow"],
	[95, "red"],
];
function usageStyle(used: number, window: number | undefined): Style {
	if (window === undefined || window <= 0) return color.textPrimary;
	const pct = Math.max(0, Math.min(100, (used / window) * 100));
	for (let index = 1; index < usageBreakpoints.length; index++) {
		const [fromPct, fromName] = usageBreakpoints[index - 1] as (typeof usageBreakpoints)[number];
		const [toPct, toName] = usageBreakpoints[index] as (typeof usageBreakpoints)[number];
		if (pct <= toPct) return mix(fromName, toName, Math.round(((pct - fromPct) / (toPct - fromPct)) * 200) / 200);
	}
	return color.accentError;
}

export type HeaderInfo = { branch?: string; cwd: string; used: number; window?: number; thread?: string; welcome: boolean };

/** The header row: `branch cwd` left and `<used> / <window> │ [thread]` right (the badge alone inside a subagent frame); the welcome screen shows ` branch` + cwd only (welcome/top_bar.rs:47-63, agent_view/render.rs:1416-1455). */
export function renderHeader(info: HeaderInfo, width: number): string {
	const branch = info.branch ?? "";
	if (info.welcome) {
		const location = branch === "" ? "" : `${color.textSecondary(`${glyph.branch} ${branch}`)} `;
		return splitRow(`${location}${color.textSecondary(info.cwd)}`, "", width);
	}
	const location = `${branch === "" ? "" : `${color.textSecondary(branch)} `}${color.textSecondary(info.cwd)}`;
	const window = info.window === undefined ? "—" : formatTokens(info.window);
	const tokens = bold(usageStyle(info.used, info.window)(`${formatTokens(info.used)} / ${window}`));
	return splitRow(location, info.thread === undefined ? tokens : `${tokens}${faint(separator.header)}${color.gray(`[${info.thread}]`)}`, width);
}

export type TurnStatusInfo = { run: RunState | undefined; tick: number; now: number; contextTokens: number; runningSubagents: number; metrics?: CallMetrics };

export function turnLabel(run: RunState, runningSubagents: number): string {
	switch (run.phase) {
		case "waiting_response":
			return `Waiting for response${glyph.ellipsis}`;
		case "thinking":
			return `Thinking${glyph.ellipsis}`;
		case "responding":
			return `Responding${glyph.ellipsis}`;
		case "tool":
			return run.tool === undefined ? `Running tool${glyph.ellipsis}` : run.tool === "todo_write" ? "Updating todos" : `${verbFor(run.tool).present} ${run.tool}`;
		case "waiting_subagents":
			return runningSubagents > 0 ? `Waiting for ${runningSubagents} subagent${runningSubagents === 1 ? "" : "s"}${glyph.ellipsis}` : `Waiting for subagents${glyph.ellipsis}`;
		case "compacting":
			return `Compacting context${glyph.ellipsis}`;
		case "retry":
			return `Retrying${run.retry ? ` (${run.retry})` : ""}${glyph.ellipsis}`;
	}
}

/** Grok's turn-row token count: `1.23k` under 10k, `10.1k` under 100k, `100k`, then `1.23m` (turn_status.rs:634-655). */
export function formatTokensShort(count: number): string {
	if (count < 1_000) return `${count}`;
	if (count < 10_000) return `${(count / 1_000).toFixed(2)}k`;
	if (count < 100_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.floor(count / 1_000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(2)}m`;
	return `${(count / 1_000_000).toFixed(1)}m`;
}

/** Running amber, retry yellow; green is reserved for a completed operation. */
const activityStyle = (run: RunState): Style => (run.phase === "tool" ? color.accentRunning : run.phase === "retry" ? color.warning : color.textSecondary);

/** The turn-status row: `⠧ Responding… 0.9s` left, `11s =21.5k  48 tok/s  cache 92% [stop]` right, inset one column past the margin; metrics drop first when narrow, elapsed and [stop] never drop; an idle run yields no rows. */
export function renderTurnStatus(info: TurnStatusInfo, width: number): string[] {
	const run = info.run;
	if (!run) return [];
	const style = activityStyle(run);
	const spinner = `${spinnerFrame(run.phase === "tool" ? brailleSpinner : dotSpinner, info.tick)} `;
	const phase = width >= 60 ? ` ${formatElapsed(info.now - run.phaseStartedAt, true)}` : "";
	const tokens = info.contextTokens > 0 ? ` ${glyph.tokenArrow}${formatTokensShort(info.contextTokens)}` : "";
	const elapsed = formatElapsed(info.now - run.startedAt, true);
	let metricsStr = "";
	if (width >= 80 && info.metrics) {
		const parts: string[] = [];
		if (info.metrics.tps !== undefined) parts.push(formatTps(info.metrics.tps));
		if (info.metrics.cacheRatio !== undefined) parts.push(formatCacheRatio(info.metrics.cacheRatio));
		if (parts.length > 0) metricsStr = `  ${parts.join("  ")}`;
	}
	const right = `${elapsed}${tokens}${metricsStr} [stop]`;
	const available = Math.max(0, width - spacing.margin * 2 - spacing.status - visibleWidth(spinner) - phase.length - visibleWidth(right) - 3);
	const tool = run.phase === "tool" && run.tool !== undefined && run.tool !== "todo_write" ? run.tool : undefined;
	let label: string;
	if (tool === undefined) {
		const text = turnLabel(run, info.runningSubagents);
		label = `${style(truncateToWidth(text, available, glyph.ellipsis))}${color.gray(phase)}`;
	} else {
		const verb = `${verbFor(tool).present} `;
		label = `${color.gray(verb)}${color.command(truncateToWidth(tool, Math.max(5, available - verb.length), glyph.ellipsis))}${color.gray(phase)}`;
	}
	return [splitRow(`${" ".repeat(spacing.status)}${(run.phase === "retry" ? color.warning : color.accentRunning)(spinner)}${label}`, color.gray(right), width)];
}

export type FooterHint = readonly [key: string, label: string];

/** The shortcuts bar: `Key:label` pairs (key bold text_secondary, `:label` gray) joined by a dim `  │  ` (shortcuts_bar.rs:216-292). */
export function renderFooter(hints: readonly FooterHint[], width: number): string {
	const available = Math.max(0, width - spacing.margin * 2);
	const shown: string[] = [];
	let used = 0;
	for (const [key, label] of hints) {
		const hint = `${bold(color.textSecondary(key))}${color.gray(`:${label}`)}`;
		const next = used + (shown.length > 0 ? separator.footer.length : 0) + visibleWidth(hint);
		if (next > available) break;
		shown.push(hint);
		used = next;
	}
	return `${margin}${shown.join(dim(color.gray(separator.footer)))}`;
}

/** A primary scroll view that schedules one more frame whenever its viewport height changes, so content filled to the viewport never lags a frame. */
export class ReflowScrollView extends ScrollView {
	constructor(component: Component, options?: ScrollViewOptions) {
		super(component, { primary: true, scrollbar: "always", scrollbarTrackStyle: () => color.scrollbarTrackBg(" "), scrollbarThumbStyle: () => color.scrollbarThumbBg(" "), ...options });
	}

	override updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void {
		const changed = viewportHeight !== this.viewportHeight;
		super.updateLayout(contentHeight, viewportHeight, requestRender);
		if (changed) requestRender();
	}
}

/** Fallback tint for image placeholders when a terminal cannot draw graphics. */
const imageTheme: ImageTheme = { fallbackColor: color.gray };

const promptTheme: EditorTheme = {
	borderColor: (text) => text,
	selectList: { selectedPrefix: color.accentUser, selectedText: bold, description: color.gray, scrollInfo: color.gray, noMatch: color.gray },
};

/** Captions stay readable even when the prompt is unfocused. Focus is carried by the border. */
const captionStyles = {
	focused: { model: color.textSecondary, sep: color.grayDim, flag: color.gray, fast: color.accentSystem },
	blurred: { model: color.textSecondary, sep: color.grayDim, flag: color.gray, fast: color.accentSystem },
} as const;

const promptStyles = {
	focused: { arrow: color.accentUser, text: color.textPrimary, placeholder: color.gray },
	blurred: { arrow: color.gray, text: color.textPrimary, placeholder: color.gray },
} as const;

/** pi-tui's Editor paints an inverse-video fake cursor; Grok leaves the cell to the hardware cursor, so only the cursor marker stays. */
const withoutFakeCursor = (line: string): string => line.replaceAll("\x1b[7m", "").replaceAll("\x1b[0m", "");

/** The caption part for an active fast service tier (`/fast`); `PromptBox` paints it in the system accent. */
const FAST_FLAG = "fast";

/** Keep reasoning ahead of fast and tool mode when the caption is clipped. */
export const promptCaption = (model: string, mode: string, reasoning?: string, fast = false): string => [model, reasoning, fast ? FAST_FLAG : undefined, mode].filter((part) => part !== undefined).join(separator.meta);

export type AnswerHandlers = { readonly onAnswer: (value: string) => void; readonly onCancel: () => void };
/** The prompts the prompt box answers; a checklist always opens the picker modal instead. */
export type AnswerPromptSpec = Exclude<CommandPromptSpec, { readonly type: "checklist" }>;
type AnswerState = { readonly spec: AnswerPromptSpec; readonly handlers: AnswerHandlers; rows: DropdownRow[]; selected: number };
type PanelLayout = { readonly height: number; readonly headerRows: number; readonly scroll: number; readonly visible: number };

const NO_PANEL: PanelLayout = { height: 0, headerRows: 0, scroll: 0, visible: 0 };
const EMPTY_LAYOUT: DropdownLayout = { lines: [], scroll: 0, visible: 0 };
const MASK = "•";

function maskedLines(text: string, width: number, focused: boolean): string[] {
	const dots = MASK.repeat([...text].length);
	const lines: string[] = [];
	for (let at = 0; at === 0 || at < dots.length; at += width) lines.push(dots.slice(at, at + width));
	if (focused) lines[lines.length - 1] += CURSOR_MARKER;
	return lines;
}

/**
 * The rounded prompt box: `╭─╮` / `│ ❯ text │` / `╰─ … model · mode ─╯`, with the `Build anything` placeholder while unfocused and
 * empty. The slash dropdown and a command prompt's answer panel render above the box; a secret answer is drawn as `•` and never
 * reaches the submit path, the history, or the undo stack.
 */
export class PromptBox extends Editor {
	caption = "";
	placeholder = "Build anything";
	menu: SlashMenu | undefined;
	private attachments: readonly StagedImage[] = [];
	private imageMarkers: readonly string[] = [];
	private attachmentRows = 0;
	private attachmentPreview: { component: Image; key: string } | undefined;
	private answerState: AnswerState | undefined;
	private panel: PanelLayout = NO_PANEL;
	private cache: { key: string; lines: string[] } | undefined;

	/** Active images drive preview; retained registry markers also cover undo/kill-ring restores. */
	setAttachments(images: readonly StagedImage[], markers: readonly string[] = images.map((image) => imageMarker(image.id))): void {
		this.imageMarkers = markers;
		if (images.length === this.attachments.length && images.every((image, i) => image === this.attachments[i])) return;
		this.attachments = images;
		this.attachmentPreview = undefined;
		this.invalidate();
	}

	protected override getAtomicMarkers(): readonly string[] {
		return this.answerState === undefined ? this.imageMarkers : [];
	}

	constructor(tui: TUI) {
		super(tui, promptTheme, { paddingX: 0 });
	}

	get menuOpen(): boolean {
		return this.menu?.open === true;
	}

	get answer(): AnswerPromptSpec | undefined {
		return this.answerState?.spec;
	}

	beginAnswer(spec: AnswerPromptSpec, handlers: AnswerHandlers): void {
		this.answerState = undefined;
		this.resetField();
		this.answerState = { spec, handlers, rows: [], selected: 0 };
		this.filterOptions();
		this.cache = undefined;
	}

	endAnswer(): void {
		if (this.answerState === undefined) return;
		this.answerState = undefined;
		this.resetField();
		this.cache = undefined;
	}

	cancelAnswer(): void {
		this.answerState?.handlers.onCancel();
	}

	refreshMenu(): void {
		this.syncMenu();
	}

	override setText(text: string): void {
		super.setText(text);
		this.syncMenu();
	}

	protected override renderTopBorder(): string {
		return "";
	}

	protected override renderBottomBorder(): string {
		return "";
	}

	override invalidate(): void {
		super.invalidate();
		this.cache = undefined;
	}

	override handleInput(data: string): void {
		const answer = this.answerState;
		if (answer !== undefined) {
			this.handleAnswerInput(answer, data);
			return;
		}
		const menu = this.menu;
		if (menu?.open) {
			if (matchesKey(data, "up") || matchesKey(data, "down")) {
				menu.move(matchesKey(data, "up") ? -1 : 1);
				return;
			}
			if (matchesKey(data, "escape")) {
				menu.dismiss();
				return;
			}
			if (matchesKey(data, "tab") || matchesKey(data, "enter")) {
				this.acceptMenu(matchesKey(data, "enter"));
				return;
			}
		}
		super.handleInput(data);
		this.syncMenu();
	}

	override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const { height, headerRows, scroll, visible } = this.panel;
		if (event.y >= height + this.attachmentRows) {
			const inset = spacing.margin + 1 + visibleWidth(glyph.promptArrow) + 1;
			return super.handleMouse({ ...event, x: event.x - inset, y: event.y - height - this.attachmentRows,
				width: Math.max(1, event.width - spacing.margin * 2 - 2 - visibleWidth(glyph.promptArrow) - 1),
				height: event.height - height - this.attachmentRows });
		}
		if (event.y >= height) return { handled: true, focus: true };
		if (event.type === "wheel" && event.wheelDelta !== undefined) {
			this.moveSelection(event.wheelDelta < 0 ? -1 : 1);
			return { handled: true };
		}
		const row = event.y - 1 - headerRows;
		if (event.type === "click" && event.button === "left" && row >= 0 && row < visible) this.chooseRow(scroll + row);
		return { handled: true, focus: true };
	}

	override render(width: number): string[] {
		const cursor = this.getCursor();
		const answer = this.answerState;
		const busy = this.isShowingAutocomplete() || this.menuOpen || answer !== undefined;
		const attachmentKey = this.attachments.map((image) => `${image.id}:${image.mimeType}:${image.bytes}`).join("|");
		const key = busy ? undefined : `${width}:${this.focused ? 1 : 0}:${cursor.line}:${cursor.col}:${this.caption}:${this.placeholder}:${this.getText()}:${attachmentKey}`;
		if (key !== undefined && this.cache?.key === key) return this.cache.lines;
		const panel = this.renderPanel(width);
		const chips = this.renderAttachments(width);
		this.attachmentRows = chips.length;
		const boxWidth = Math.max(8, width - spacing.margin * 2);
		const inner = boxWidth - 2;
		const prefixWidth = visibleWidth(glyph.promptArrow) + 1;
		const editorWidth = Math.max(1, inner - prefixWidth);
		const border = this.focused ? color.promptBorderActive : color.promptBorder;
		const styles = this.focused ? promptStyles.focused : promptStyles.blurred;
		const raw = super.render(editorWidth);
		const content = answer?.spec.type === "secret" ? maskedLines(this.getExpandedText(), editorWidth, this.focused) : raw.slice(1, raw.length - 1);
		const placeholder = answer === undefined ? this.placeholder : answer.spec.type === "select" ? "" : (answer.spec.placeholder ?? "");
		const showPlaceholder = this.getText() === "" && (answer !== undefined || !this.focused);
		const lines = [`${margin}${border(`${rounded.tl}${rounded.h.repeat(inner)}${rounded.tr}`)}`];
		content.forEach((line, index) => {
			const prefix = index === 0 ? ` ${styles.arrow(glyph.promptArrow)}` : " ".repeat(prefixWidth);
			const body =
				showPlaceholder && index === 0
					? `${this.focused ? CURSOR_MARKER : ""}${styles.placeholder(pad(truncateToWidth(placeholder, editorWidth, ""), editorWidth))}`
					: styles.text(pad(withoutFakeCursor(line), editorWidth));
			lines.push(`${margin}${border(rounded.v)}${prefix}${body}${border(rounded.v)}`);
		});
		const caption = this.renderCaption(inner - 1);
		lines.push(`${margin}${border(`${rounded.bl}${rounded.h.repeat(Math.max(0, inner - 1 - visibleWidth(caption)))}`)}${caption}${border(`${rounded.h}${rounded.br}`)}`);
		const painted = [...panel, ...chips, ...lines.map((line) => paint(line, width))];
		if (key !== undefined) this.cache = { key, lines: painted };
		return painted;
	}

	/**
	 * The attachment band above the box: stable token labels, format and size, plus a live thumbnail
	 * of the last token when graphics are available. Labels that do not fit are hidden here only;
	 * the inline editor tokens remain the deletion controls.
	 */
	private renderAttachments(width: number): string[] {
		if (this.attachments.length === 0) return [];
		const margin = " ".repeat(spacing.margin);
		const boxWidth = Math.max(8, width - spacing.margin * 2);
		const inner = boxWidth - 2;
		const chipOf = (image: StagedImage): string => {
			const format = image.mimeType.slice("image/".length).toUpperCase();
			const size = image.bytes >= 1024 * 1024
				? `${(image.bytes / (1024 * 1024)).toFixed(1)}M`
				: `${Math.max(1, Math.round(image.bytes / 1024))}K`;
			return ` ${color.accentUser(imageMarker(image.id))} ${format} ${size} `;
		};
		let row = "";
		let shown = 0;
		for (const [index, image] of this.attachments.entries()) {
			const chip = chipOf(image);
			if (visibleWidth(row) + visibleWidth(chip) > inner) break;
			row += chip;
			shown = index + 1;
		}
		const hidden = this.attachments.length - shown;
		const caption = hidden > 0 ? color.gray(` +${hidden} more`) : "";
		const border = color.promptBorder;
		const lines = [`${margin}${border(`${rounded.tl}${rounded.h.repeat(inner)}${rounded.tr}`)}`];
		// Pad by visible width: the chips carry ANSI colour, so String#padEnd would under-pad and pull the right border in.
		const fill = " ".repeat(Math.max(0, inner - visibleWidth(row) - visibleWidth(caption)));
		lines.push(`${margin}${border(rounded.v)}${row}${caption}${fill}${border(rounded.v)}`);
		lines.push(`${margin}${border(`${rounded.bl}${rounded.h.repeat(inner)}${rounded.br}`)}`);
		// Live thumbnail of the newest staged image, only when the terminal can draw one. The preview
		// component is cached per attachment set so repaints reuse the kitty image id instead of stacking.
		const newest = this.attachments.at(-1)!;
		const previewKey = `${newest.id}:${newest.bytes}`;
		const protocol = getCapabilities().images;
		// Kitty transmits with f=100, which only decodes PNG: a JPEG/GIF/WebP original would reserve rows
		// and draw nothing. Prefer the staged PNG thumbnail (also far smaller to retransmit on repaints).
		const thumbnail = newest.preview !== undefined ? { data: newest.preview, mimeType: "image/png" }
			: protocol === "kitty" && newest.mimeType !== "image/png" ? undefined : newest;
		if (protocol && thumbnail !== undefined) {
			if (this.attachmentPreview?.key !== previewKey) {
				this.attachmentPreview = {
					key: previewKey,
					component: new Image(thumbnail.data, thumbnail.mimeType, imageTheme, { maxWidthCells: 24, maxHeightCells: 6 },
						getImageDimensions(thumbnail.data, thumbnail.mimeType) ?? undefined),
				};
			}
			lines.push(...this.attachmentPreview.component.render(boxWidth));
		}
		return lines;
	}

	private renderPanel(width: number): string[] {
		const answer = this.answerState;
		let layout = EMPTY_LAYOUT;
		if (answer !== undefined) {
			const select = answer.spec.type === "select";
			layout = renderDropdownPanel(select ? answer.rows : [], answer.selected, width, { header: [bold(color.textPrimary(answer.spec.message))], ...(select ? { count: answer.rows.length } : {}) });
		} else if (this.menu?.open) layout = this.menu.render(width);
		const height = layout.lines.length;
		this.panel = height === 0 ? NO_PANEL : { height, headerRows: height - layout.visible - 2, scroll: layout.scroll, visible: layout.visible };
		return layout.lines;
	}

	private handleAnswerInput(answer: AnswerState, data: string): void {
		if (matchesKey(data, "escape")) {
			answer.handlers.onCancel();
			return;
		}
		const select = answer.spec.type === "select";
		if (matchesKey(data, "up") || matchesKey(data, "down")) {
			if (select) this.moveSelection(matchesKey(data, "up") ? -1 : 1);
			return;
		}
		if (matchesKey(data, "tab")) return;
		if (matchesKey(data, "enter")) {
			const value = select ? answer.rows[answer.selected]?.insert : this.getExpandedText().trim();
			if (value !== undefined) answer.handlers.onAnswer(value);
			return;
		}
		super.handleInput(data);
		if (select) this.filterOptions();
	}

	private filterOptions(): void {
		const answer = this.answerState;
		if (answer === undefined || answer.spec.type !== "select") return;
		const previous = answer.rows[answer.selected]?.insert;
		answer.rows = rank(answer.spec.options, this.getText(), (option) => option.label, (option) => option.id).map(({ item, indices }) => ({ display: item.label, description: item.description ?? "", insert: item.id, indices }));
		const carried = previous === undefined ? -1 : answer.rows.findIndex((row) => row.insert === previous);
		answer.selected = carried >= 0 ? carried : 0;
	}

	private moveSelection(delta: 1 | -1): void {
		const answer = this.answerState;
		if (answer === undefined) this.menu?.move(delta);
		else if (answer.rows.length > 0) answer.selected = (answer.selected + delta + answer.rows.length) % answer.rows.length;
	}

	private chooseRow(index: number): void {
		const answer = this.answerState;
		if (answer === undefined) {
			this.menu?.select(index);
			this.acceptMenu(true);
			return;
		}
		const row = answer.rows[index];
		if (row === undefined) return;
		answer.selected = index;
		answer.handlers.onAnswer(row.insert);
	}

	private acceptMenu(enter: boolean): void {
		const accepted = this.menu?.accept(enter);
		if (accepted === undefined) return;
		if (accepted.replace !== undefined) {
			// Swap only the `@token` before the cursor, keeping the rest of a multi-line draft and its undo history.
			for (let i = 0; i < accepted.replace; i++) super.handleInput("\x7f");
			this.insertTextAtCursor(accepted.text);
			this.syncMenu();
			return;
		}
		this.setText(accepted.text);
		if (accepted.submit) super.handleInput("\r");
		this.syncMenu();
	}

	private syncMenu(): void {
		if (this.menu === undefined) return;
		const lines = this.getLines();
		const cursor = this.getCursor();
		const answering = this.answerState !== undefined;
		const onFirstLine = !answering && lines.length === 1 && cursor.line === 0;
		this.menu.refresh(onFirstLine ? (lines[0] ?? "") : "", onFirstLine ? cursor.col : -1, answering ? "" : (lines[cursor.line] ?? ""), answering ? -1 : cursor.col);
	}

	/** pi-tui keeps every keystroke in the editor's undo stack and every killed span in its kill ring, so a cleared secret has to leave both. */
	private resetField(): void {
		this.setText("");
		this.clearEditHistory();
	}

	private renderCaption(limit: number): string {
		if (this.caption === "" || limit < 4) return "";
		const [model = "", ...flags] = this.caption.split(separator.meta);
		const styles = this.focused ? captionStyles.focused : captionStyles.blurred;
		const text = [styles.model(model), ...flags.map((flag) => (flag === FAST_FLAG ? styles.fast : styles.flag)(flag))].join(styles.sep(separator.meta));
		return ` ${truncateToWidth(text, limit - 2, glyph.ellipsis)} `;
	}
}

export type ShortcutRow = readonly [action: string, keys: string];
export type ShortcutSection = { readonly title: string; readonly rows: readonly ShortcutRow[] };

/** The cheatsheet: Essentials open, the other sections folded, like Grok's registry-driven list (shortcuts_help.rs:61-72). */
export const SHORTCUT_SECTIONS: readonly ShortcutSection[] = [
	{
		title: "Essentials",
		rows: [
			["Send", "Enter"],
			["Steer the running turn", "Enter"],
			["Send queued input now (empty prompt)", "Enter"],
			["Edit last queued input (empty prompt)", "↓"],
			["Focus prompt", "Tab / Space"],
			["Cancel turn", "Esc"],
			["Clear draft", "Ctrl+c"],
			["Quit", "Ctrl+c / Ctrl+d"],
			["Keyboard shortcuts", "Ctrl+x"],
		],
	},
	{
		title: "Conversation Navigation",
		rows: [
			["Focus transcript", "Tab"],
			["Select entry", "↑ / ↓"],
			["Expand entry", "→"],
			["Collapse entry", "←"],
			["Expand / compact tools (saved)", "Ctrl+o"],
			["Expand / collapse all thinking", "Ctrl+e"],
			["Open subagent", "Enter"],
			["Back to prompt", "Space / Esc"],
		],
	},
	{
		title: "Panels",
		rows: [
			["Todo / plan pane", "Ctrl+t"],
			["Switch todo / plan", "← / →"],
			["Hide done items", "h"],
			["Close todo / plan pane", "Esc"],
			["Close subagent view", "q / Esc"],
		],
	},
	{
		title: "Commands",
		rows: [
			["New thread", "/new [name]"],
			["Switch thread", "/thread <name>"],
			["Browse sessions", "/sessions"],
			["Open subagent", "/agents [id]"],
			["Quit", "/quit"],
		],
	},
];

export type { OverlaySize } from "./modal.ts";
export type ShortcutsOverlayOptions = { size?: () => OverlaySize; sections?: readonly ShortcutSection[] };

/** Grok's cheatsheet popup: 70% of the screen capped at 80 columns (never wider than cols-4, never under 44) and rows-8 tall (modal_window.rs:576-586, shortcuts_help.rs:1077-1086). */
export function shortcutsOverlayLayout(size: OverlaySize): { width: number; height: number } {
	const width = Math.min(Math.max(Math.min(Math.floor(size.cols * 0.7), size.cols - 4, 80), 44), size.cols);
	return { width, height: Math.max(6, size.rows - 8) };
}

/** `showOverlay` options that center the cheatsheet at Grok's size; pair with `new ShortcutsOverlay(onClose, { size })`. */
export const shortcutsOverlayOptions = (size: OverlaySize): OverlayOptions => ({ anchor: "center", width: shortcutsOverlayLayout(size).width, maxHeight: shortcutsOverlayLayout(size).height });

type OverlayRow = { kind: "header"; section: number; text: string } | { kind: "hint"; action: string; keys: string };

const MODAL_PAD = 2;
const MODAL_FOOTER = ["↑/↓ nav", "e/Space/→ expand", "← collapse", "/ search", "Esc close"] as const;
const MODAL_FOOTER_SEP = "  |  ";

/** The Ctrl+X cheatsheet: Grok's modal window (gray_dim square border, bold title, `[✗]`, search bar, divider, picker rows, centered footer hints); Esc, Ctrl+X or q closes it through `onClose`. */
export class ShortcutsOverlay implements Component {
	private readonly sections: readonly ShortcutSection[];
	private readonly size: (() => OverlaySize) | undefined;
	private readonly expanded = new Set<number>([0]);
	private selected = 1;
	private scroll = 0;
	private query = "";
	private searching = false;
	private cache: { key: string; lines: string[] } | undefined;

	constructor(
		private readonly onClose: () => void,
		options: ShortcutsOverlayOptions = {},
	) {
		this.sections = options.sections ?? SHORTCUT_SECTIONS;
		this.size = options.size;
	}

	invalidate(): void {
		this.cache = undefined;
	}

	get selection(): number {
		return this.selected;
	}

	handleInput(data: string): void {
		if (this.searching) {
			this.handleSearchInput(data);
			return;
		}
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+x") || matchesKey(data, "q")) {
			this.onClose();
			return;
		}
		if (matchesKey(data, "up")) this.move(-1);
		else if (matchesKey(data, "down")) this.move(1);
		else if (matchesKey(data, "right") || matchesKey(data, "e") || matchesKey(data, "space") || matchesKey(data, "enter")) this.fold(true);
		else if (matchesKey(data, "left")) this.fold(false);
		else if (data === "/") {
			this.searching = true;
			this.cache = undefined;
		}
	}

	private handleSearchInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.searching = false;
			this.query = "";
			this.selected = 1;
		} else if (matchesKey(data, "enter")) this.searching = false;
		else if (matchesKey(data, "up") || matchesKey(data, "down")) {
			this.searching = false;
			this.move(matchesKey(data, "down") ? 1 : -1);
		} else if (matchesKey(data, "backspace")) {
			this.query = this.query.slice(0, -1);
			this.selected = 1;
		} else if (data.length > 0 && !data.startsWith("\x1b") && data >= " ") {
			this.query += data;
			this.selected = 1;
		}
		this.cache = undefined;
	}

	private move(delta: 1 | -1): void {
		const count = this.rows().length;
		if (count === 0) return;
		this.selected = Math.max(0, Math.min(count - 1, this.selected + delta));
		this.cache = undefined;
	}

	private fold(open: boolean): void {
		const rows = this.rows();
		const row = rows[this.selected];
		if (!row) return;
		if (row.kind === "header") {
			if (open) this.expanded.add(row.section);
			else this.expanded.delete(row.section);
		} else if (!open) {
			for (let index = this.selected; index >= 0; index--) {
				if (rows[index]?.kind === "header") {
					this.selected = index;
					break;
				}
			}
		}
		this.cache = undefined;
	}

	private rows(): OverlayRow[] {
		const rows: OverlayRow[] = [];
		const query = this.query.trim().toLowerCase();
		this.sections.forEach((section, index) => {
			const hints = query === "" ? section.rows : section.rows.filter(([action, keys]) => `${action} ${keys}`.toLowerCase().includes(query));
			if (query !== "" && hints.length === 0) return;
			const open = query !== "" || this.expanded.has(index);
			rows.push({ kind: "header", section: index, text: open ? section.title : `${section.title} (${section.rows.length})` });
			if (open) for (const [action, keys] of hints) rows.push({ kind: "hint", action, keys });
		});
		return rows;
	}

	render(width: number): string[] {
		const layout = this.size === undefined ? undefined : shortcutsOverlayLayout(this.size());
		const box = Math.max(20, layout === undefined ? width : Math.min(width, layout.width));
		const rows = this.rows();
		if (this.selected >= rows.length) this.selected = Math.max(0, rows.length - 1);
		const inner = box - 2;
		const contentWidth = inner - MODAL_PAD * 2;
		const footerRows = wrapHints(MODAL_FOOTER, contentWidth, MODAL_FOOTER_SEP);
		const footerLines = Math.max(2, footerRows.length);
		const listHeight = layout === undefined ? Math.max(1, rows.length) : Math.max(1, layout.height - 5 - footerLines);
		const overflow = rows.length > listHeight;
		if (this.selected < this.scroll) this.scroll = this.selected;
		if (this.selected >= this.scroll + listHeight) this.scroll = this.selected - listHeight + 1;
		this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, rows.length - listHeight)));
		const key = `${width}:${box}:${layout?.height ?? "fit"}:${this.selected}:${this.scroll}:${[...this.expanded].join(",")}:${this.searching ? 1 : 0}:${this.query}`;
		if (this.cache?.key === key) return this.cache.lines;

		const border = color.grayDim;
		const side = border(square.v);
		const row = (text: string): string => `${side}${pad(text, inner)}${side}`;
		const title = `${border(`${square.h} `)}${bold(color.textPrimary("Keyboard Shortcuts"))}${border(` ${square.h}`)}`;
		const close = border(` ${glyph.closeButton} `);
		const lines = [
			`${border(square.tl)}${title}${border(square.h.repeat(Math.max(0, box - 30)))}${close}${border(`${square.h}${square.tr}`)}`,
			row(""),
			row(`${" ".repeat(MODAL_PAD)}${this.renderSearchBar(contentWidth)}`),
			`${side}${border(square.h.repeat(inner))}${side}`,
		];
		const listWidth = overflow ? contentWidth - 1 : contentWidth;
		const thumbLength = overflow ? Math.max(1, Math.floor((listHeight * listHeight) / rows.length)) : 0;
		const thumbTop = overflow ? Math.round((this.scroll * (listHeight - thumbLength)) / Math.max(1, rows.length - listHeight)) : 0;
		for (let index = 0; index < listHeight; index++) {
			const entry = rows[this.scroll + index];
			const text = entry === undefined ? " ".repeat(listWidth) : this.renderRow(entry, listWidth, this.scroll + index === this.selected);
			const scrollbar = overflow ? `  ${index >= thumbTop && index < thumbTop + thumbLength ? color.grayDim("█") : " "}` : "";
			lines.push(row(`${" ".repeat(MODAL_PAD)}${text}${scrollbar}`));
		}
		for (let index = footerRows.length; index < footerLines; index++) lines.push(row(""));
		for (const hints of footerRows) {
			const total = hints.reduce((sum, hint) => sum + visibleWidth(hint), 0) + MODAL_FOOTER_SEP.length * (hints.length - 1);
			const text = hints.map(styleHint).join(color.grayDim(MODAL_FOOTER_SEP));
			lines.push(row(`${" ".repeat(MODAL_PAD + Math.max(0, Math.floor((contentWidth - total) / 2)))}${truncateToWidth(text, contentWidth, "")}`));
		}
		lines.push(border(`${square.bl}${square.h.repeat(inner)}${square.br}`));
		const painted = lines.map((line) => paint(line, box));
		this.cache = { key, lines: painted };
		return painted;
	}

	/** ` / to search` in gray_dim at rest; ` search: query` with a block cursor while typing (picker.rs:407-517). */
	private renderSearchBar(width: number): string {
		if (!this.searching && this.query === "") return color.grayDim(" / to search");
		const label = " search: ";
		const query = truncateToWidth(this.query, Math.max(0, width - label.length - 1), "");
		return `${color.gray(label)}${color.textPrimary(query)}${this.searching ? inverse(" ") : ""}`;
	}

	/** A picker row: `› Title (n)` / `◆ Title` for sections, `  ◆ action` + right-aligned gray keys for hints; the selection is a bold bg_visual band (picker.rs:878-1060). */
	private renderRow(entry: OverlayRow, width: number, selected: boolean): string {
		const label = selected ? (text: string) => bold(color.textPrimary(text)) : color.textPrimary;
		let text: string;
		if (entry.kind === "header") {
			const fold = this.expanded.has(entry.section) || this.query !== "" ? glyph.bullet : glyph.chevron;
			text = `${color.grayDim(`${fold} `)}${label(truncateToWidth(entry.text, Math.max(0, width - 3), glyph.ellipsis))}`;
		} else {
			const content = width - 4 - 1;
			const usable = entry.keys === "" ? content : content - 2;
			const keys = entry.keys === "" ? "" : truncateToWidth(entry.keys, Math.floor(usable / 2), glyph.ellipsis);
			const action = label(truncateToWidth(entry.action, Math.max(0, usable - visibleWidth(keys)), glyph.ellipsis));
			const gap = Math.max(1, width - 4 - visibleWidth(action) - visibleWidth(keys) - 1);
			text = `  ${color.grayDim(`${glyph.bullet} `)}${action}${" ".repeat(gap)}${color.gray(keys)}`;
		}
		const padded = pad(text, width);
		return selected ? color.bgVisual(padded) : padded;
	}
}
