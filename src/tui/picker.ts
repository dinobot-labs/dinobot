import { type Component, matchesKey, truncateToWidth, type TuiMouseEvent, type TuiMouseEventResult, visibleWidth } from "@earendil-works/pi-tui";
import type { CommandChecklistOption, CommandSelectOption } from "../commands/types.ts";
import {
	closeButtonHit,
	MODAL_CHROME_ROWS,
	MODAL_MARGIN,
	modalBottom,
	modalContent,
	modalContentWidth,
	modalDivider,
	modalFrameHeight,
	modalFrameWidth,
	modalRow,
	modalTop,
	type OverlaySize,
	renderHints,
	renderScrollbar,
	scrollbarJump,
	splitKeys,
	withMargin,
} from "./modal.ts";
import { highlight, rank } from "./slash.ts";
import { color, glyph, inverse, isDosTheme, modalSizing, pad, separator } from "./theme.ts";

export type PickerRow = { readonly kind: "header"; readonly label: string } | { readonly kind: "option"; readonly option: CommandSelectOption; readonly indices: readonly number[] };
/** `focusFirst`: with an empty filter, initially select the first row (e.g. newest-first lists) instead of the current one. */
/**
 * `checklist`: a multi-select. Rows carry `[x]`/`[ ]` marks seeded from `CommandChecklistOption.checked`; space and a click toggle the
 * selected row (disabled rows are locked: the keys may rest on them, nothing toggles them), enter chooses `JSON.stringify` of every checked id in the options' order, locked ones included.
 */
/**
 * `header`: styled rows drawn inside the frame above the filter row, given the content width (e.g. question tabs and text).
 * `hints`: footer hints replacing the defaults. `alwaysShow`: option ids that survive every filter (e.g. a free-text answer row).
 */
export type PickerInteraction = { readonly hoverSelect?: boolean; readonly wheelSelect?: boolean; readonly descriptionBelow?: boolean; readonly focusDisabled?: boolean; readonly focusFirst?: boolean; readonly checklist?: boolean; readonly header?: (width: number) => readonly string[]; readonly hints?: readonly string[]; readonly alwaysShow?: ReadonlySet<string> };
/** `onKey` sees each key first; returning true consumes it (e.g. switching tabs on ←/→). */
export type PickerHandlers = { readonly onChoose: (id: string) => void; readonly onCancel: () => void; readonly onKey?: (key: string) => boolean };
/** Geometry of the last render in the overlay's own coordinates, the blank margin included. */
export type PickerLayout = { readonly width: number; readonly height: number; readonly listTop: number; readonly listHeight: number; readonly scrollbarX: number | undefined };

export const PICKER_HINTS: readonly string[] = ["↑↓ navigate", "enter select", "esc close", "type to filter"];
export const CHECKLIST_HINTS: readonly string[] = ["↑↓ navigate", "space toggle", "enter apply", "esc cancel", "type to filter"];
const CHECKED_MARK = "[x] ";
const UNCHECKED_MARK = "[ ] ";
const HINT_SEP = separator.meta;
const MARK_WIDTH = 2;
const LABEL_GAP = 2;
const TAG_GAP = 2;
/** A description squeezed under this many columns is dropped rather than shown as a stub; the label column leaves it at least this much. */
const MIN_DESCRIPTION = 8;
const FILTER_ROWS = 2;
const FILTER_LABEL = " filter: ";
const FILTER_PLACEHOLDER = "type to filter";
const NO_MATCH = "No matches";
const EMPTY_LAYOUT: PickerLayout = { width: 0, height: 0, listTop: 0, listHeight: 0, scrollbarX: undefined };

/** pi-tui wraps its ellipsis in `\x1b[0m`, which would end a row's background band. */
const clip = (text: string, width: number): string => truncateToWidth(text, Math.max(0, width), glyph.ellipsis).replaceAll("\x1b[0m", "");
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const CURRENT_TAG = "current";

const tagWidthOf = (option: CommandSelectOption): number => {
	const badge = option.badge === undefined ? 0 : visibleWidth(option.badge);
	const parts = [option.current ? CURRENT_TAG.length : 0, option.tag === undefined ? 0 : visibleWidth(option.tag), badge].filter((width) => width > 0);
	return parts.reduce((sum, width) => sum + width, 0) + Math.max(0, parts.length - 1);
};

function typedText(data: string): string | undefined {
	const text = data.startsWith(PASTE_START) ? data.slice(PASTE_START.length).replace(PASTE_END, "") : data;
	if (text === "" || text.includes("\x1b")) return undefined;
	for (const char of text) if (char < " " || char === "\x7f") return undefined;
	return text;
}

/**
 * The modal select picker Grok-style (modal_window.rs + picker.rs): a centered window with the prompt message as its title,
 * an always-active filter row with the match count, grouped rows under gray section headers, the current row marked `●`,
 * right-aligned tags, a bg_visual selection band, a hover band, a scrollbar past the window height and footer key hints.
 * The mouse chooses rows, scrolls, jumps on the scrollbar and cancels outside the window or on `[✗]`. Disabled rows are
 * drawn dim and skipped by the keys (except a checklist's locked rows) and the mouse. In checklist mode (`PickerInteraction.checklist`) the rows carry `[x]`/`[ ]`
 * marks, the filter row a live checked/total counter, and space or a click toggles while enter applies.
 */
export class Picker implements Component {
	readonly animating = false;
	private query = "";
	private rows: PickerRow[] = [];
	private hits = 0;
	private selectedRow = -1;
	/** Grok's carry_selection: a row the user moved to follows the filter; otherwise the best hit (or the current row) is selected. */
	private pinned = false;
	private hoveredRow: number | undefined;
	private closeHovered = false;
	private scroll = 0;
	private layout: PickerLayout = EMPTY_LAYOUT;
	private cache: { key: string; lines: string[] } | undefined;
	/** Checklist mode only: the checked ids; undefined for a single-choice picker. */
	private readonly checks: Set<string> | undefined;
	private checksVersion = 0;
	/** Header rows of the last render; the list shrinks by this much. */
	private headerRows = 0;

	constructor(
		readonly title: string,
		private options: readonly CommandSelectOption[],
		private readonly handlers: PickerHandlers,
		private readonly size: () => OverlaySize,
		private readonly interaction: PickerInteraction = {},
	) {
		this.checks = interaction.checklist ? new Set(options.filter((option) => (option as Partial<CommandChecklistOption>).checked === true).map((option) => option.id)) : undefined;
		this.rebuild(this.options.find((option) => option.current));
	}

	/** Refresh live choices without discarding the query or the selected task. */
	updateOptions(options: readonly CommandSelectOption[]): void {
		const selected = this.selected;
		const scroll = this.scroll;
		this.options = options;
		this.rebuild(options.find(option => option.id === selected?.id));
		this.scroll = scroll;
		this.clampScroll();
		this.ensureVisible();
		this.invalidate();
	}

	get filter(): string {
		return this.query;
	}

	get entries(): readonly PickerRow[] {
		return this.rows;
	}

	get selected(): CommandSelectOption | undefined {
		const row = this.rows[this.selectedRow];
		return row?.kind === "option" ? row.option : undefined;
	}

	/** Checklist mode: the checked ids in the options' order (locked ones included); empty for a single-choice picker. */
	get checked(): readonly string[] {
		const checks = this.checks;
		return checks === undefined ? [] : this.options.filter((option) => checks.has(option.id)).map((option) => option.id);
	}

	get hovered(): CommandSelectOption | undefined {
		const row = this.hoveredRow === undefined ? undefined : this.rows[this.hoveredRow];
		return row?.kind === "option" ? row.option : undefined;
	}

	get scrollTop(): number {
		return this.scroll;
	}

	get geometry(): PickerLayout {
		return this.layout;
	}

	cancel(): void {
		this.handlers.onCancel();
	}

	invalidate(): void {
		this.cache = undefined;
	}

	handleInput(data: string): void {
		for (const key of splitKeys(data)) this.handleKey(key);
	}

	private handleKey(data: string): void {
		if (this.handlers.onKey?.(data) === true) return;
		if (matchesKey(data, "escape")) return this.handlers.onCancel();
		if (matchesKey(data, "enter")) return this.choose();
		if (matchesKey(data, "up")) this.move(-1);
		else if (matchesKey(data, "down")) this.move(1);
		else if (matchesKey(data, "pageUp")) this.page(-1);
		else if (matchesKey(data, "pageDown")) this.page(1);
		else if (matchesKey(data, "home")) this.jump("first");
		else if (matchesKey(data, "end")) this.jump("last");
		else if (matchesKey(data, "backspace")) this.setQuery([...this.query].slice(0, -1).join(""));
		else if (matchesKey(data, "ctrl+u")) this.setQuery("");
		else if (this.checks !== undefined && matchesKey(data, "space")) this.toggle();
		else {
			const text = typedText(data);
			if (text !== undefined && this.checks !== undefined) this.typeChecklist(text, data.startsWith(PASTE_START));
			else if (text !== undefined) this.setQuery(this.query + text);
		}
		this.cache = undefined;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const { width, height, listTop, listHeight, scrollbarX } = this.layout;
		const frameWidth = modalFrameWidth(width);
		const frameX = event.x - MODAL_MARGIN;
		const frameY = event.y - MODAL_MARGIN;
		const inside = frameX >= 0 && frameY >= 0 && frameX < frameWidth && frameY < height - MODAL_MARGIN * 2;
		if (event.type === "wheel") {
			if (event.wheelDelta !== undefined && event.wheelDelta !== 0) {
				if (this.interaction.wheelSelect) {
					for (let step = 0; step < Math.abs(event.wheelDelta); step++) this.move(event.wheelDelta > 0 ? 1 : -1);
				} else {
					this.scroll += event.wheelDelta;
					this.clampScroll();
				}
				this.cache = undefined;
			}
			return { handled: true };
		}
		if (event.type === "move" || event.type === "drag") {
			const row = inside ? this.rowAt(event.y) : undefined;
			const close = inside && closeButtonHit(frameWidth, frameX, frameY);
			const changed = row !== this.hoveredRow || close !== this.closeHovered || (this.interaction.hoverSelect === true && row !== undefined && row !== this.selectedRow);
			if (this.interaction.hoverSelect && row !== undefined) this.select(row);
			this.hoveredRow = row;
			this.closeHovered = close;
			if (changed) this.cache = undefined;
			return { handled: true, render: changed };
		}
		if (event.type === "click" && event.button === "left") {
			if (!inside || closeButtonHit(frameWidth, frameX, frameY)) {
				this.handlers.onCancel();
				return { handled: true };
			}
			if (scrollbarX !== undefined && event.x === scrollbarX && event.y >= listTop && event.y < listTop + listHeight) {
				this.scroll = scrollbarJump(this.rows.length, listHeight / this.rowHeight, Math.floor((event.y - listTop) / this.rowHeight));
				this.cache = undefined;
				return { handled: true };
			}
			const row = this.rowAt(event.y);
			if (row !== undefined) {
				this.selectedRow = row;
				this.pinned = true;
				this.cache = undefined;
				if (this.checks !== undefined) this.toggle();
				else this.choose();
			}
			return { handled: true };
		}
		return { handled: true };
	}

	render(width: number): string[] {
		const frame = modalFrameWidth(width);
		const content = modalContentWidth(frame);
		const header = this.interaction.header?.(content) ?? [];
		if (header.length !== this.headerRows) {
			this.headerRows = header.length;
			this.ensureVisible();
		}
		const listHeight = this.listHeight();
		const overflow = this.rows.length > listHeight;
		const listWidth = overflow ? content - 2 : content;
		this.clampScroll();
		this.layout = {
			width,
			height: listHeight * this.rowHeight + this.headerRows + FILTER_ROWS + MODAL_CHROME_ROWS + MODAL_MARGIN * 2,
			listTop: MODAL_MARGIN + 1 + modalSizing.vPad + this.headerRows + FILTER_ROWS,
			listHeight: listHeight * this.rowHeight,
			scrollbarX: overflow ? MODAL_MARGIN + frame - 2 - modalSizing.hPad : undefined,
		};
		const key = `${width}:${listHeight}:${header.join("\n")}:${this.query}:${this.selectedRow}:${this.hoveredRow}:${this.closeHovered}:${this.scroll}:${this.rows.length}:${this.checksVersion}`;
		if (this.cache?.key === key) return this.cache.lines;
		const body: string[] = [];
		for (let index = 0; index < modalSizing.vPad; index++) body.push(modalRow("", frame));
		for (const line of header) body.push(modalContent(clip(line, content), frame));
		body.push(modalContent(this.renderFilter(content), frame));
		body.push(modalDivider(frame));
		const labelWidth = this.labelWidth(listWidth);
		const thumbs = overflow ? renderScrollbar(this.rows.length * this.rowHeight, listHeight * this.rowHeight, this.scroll * this.rowHeight) : undefined;
		for (let k = 0; k < listHeight; k++) {
			const index = this.scroll + k;
			const row = this.rows[index];
			let text: string;
			if (row === undefined) text = index === 0 ? color.gray(NO_MATCH) : "";
			else if (row.kind === "header") text = this.renderHeader(row.label, listWidth);
			else text = this.renderOption(row, listWidth, labelWidth, index === this.selectedRow, index === this.hoveredRow);
			body.push(modalContent(`${pad(text, listWidth)}${thumbs === undefined ? "" : ` ${thumbs[k * this.rowHeight] ?? " "}`}`, frame));
			if (this.interaction.descriptionBelow) {
				const preview = row?.kind === "option" ? row.option.description ?? "" : "";
				const band = pad(color.gray(clip(`${" ".repeat(this.markWidth)}${preview}`, listWidth)), listWidth);
				const styled = index === this.selectedRow ? color.bgVisual(band) : index === this.hoveredRow ? color.bgHover(band) : band;
				body.push(modalContent(`${styled}${thumbs === undefined ? "" : ` ${thumbs[k * this.rowHeight + 1] ?? " "}`}`, frame));
			}
		}
		for (const hint of renderHints(this.interaction.hints ?? (this.checks === undefined ? PICKER_HINTS : CHECKLIST_HINTS), content, HINT_SEP)) body.push(modalContent(hint, frame));
		const lines = withMargin([modalTop(this.title, frame, this.closeHovered), ...body, modalBottom(frame)], width);
		this.cache = { key, lines };
		return lines;
	}

	/** Disabled options normally cannot be focused; browsers may opt in, but choose() still blocks activation. */
	private readonly choosable = (row: PickerRow | undefined): row is PickerRow & { readonly kind: "option" } => row?.kind === "option" && (row.option.disabled !== true || this.interaction.focusDisabled === true);

	/**
	 * Rows the keys may land on: the choosable ones and, in a checklist, the locked ones too (toggle() leaves them alone),
	 * so ↑↓ still move when only one row is unlocked (/setup's channels and features) and a locked row's reason is readable.
	 */
	private readonly navigable = (row: PickerRow | undefined): row is PickerRow & { readonly kind: "option" } => row?.kind === "option" && (this.checks !== undefined || this.choosable(row));

	private get rowHeight(): number { return this.interaction.descriptionBelow ? 2 : 1; }

	private get markWidth(): number { return this.checks === undefined ? MARK_WIDTH : CHECKED_MARK.length; }

	private listHeight(): number {
		return Math.max(1, Math.min(Math.floor((modalFrameHeight(this.size()) - MODAL_CHROME_ROWS - FILTER_ROWS - this.headerRows) / this.rowHeight), Math.max(1, this.rows.length)));
	}

	private choose(): void {
		if (this.checks !== undefined) return this.handlers.onChoose(JSON.stringify(this.checked));
		const option = this.selected;
		if (option !== undefined && option.disabled !== true) this.handlers.onChoose(option.id);
	}

	/** Flips the selected row's mark; a locked (disabled) row keeps its state. The selection, filter and scroll stay put. */
	private toggle(): void {
		const option = this.selected;
		if (this.checks === undefined || option === undefined || option.disabled === true) return;
		if (!this.checks.delete(option.id)) this.checks.add(option.id);
		this.checksVersion++;
		this.cache = undefined;
	}

	/** Checklist typing: a typed space toggles instead of entering the filter; a paste only filters, its spaces dropped. */
	private typeChecklist(text: string, pasted: boolean): void {
		let query = this.query;
		for (const char of text) {
			if (char !== " ") query += char;
			else if (!pasted) {
				this.setQuery(query);
				this.toggle();
			}
		}
		this.setQuery(query);
	}

	private rowAt(y: number): number | undefined {
		const { listTop, listHeight } = this.layout;
		if (y < listTop || y >= listTop + listHeight) return undefined;
		const index = this.scroll + Math.floor((y - listTop) / this.rowHeight);
		return this.choosable(this.rows[index]) ? index : undefined;
	}

	private move(delta: 1 | -1): void {
		let index = this.selectedRow + delta;
		while (index >= 0 && index < this.rows.length && !this.navigable(this.rows[index])) index += delta;
		if (index >= 0 && index < this.rows.length) this.select(index);
	}

	private page(direction: 1 | -1): void {
		let index = Math.max(0, Math.min(this.rows.length - 1, this.selectedRow + direction * this.listHeight()));
		while (index >= 0 && index < this.rows.length && !this.navigable(this.rows[index])) index += direction;
		if (index < 0 || index >= this.rows.length) this.jump(direction === 1 ? "last" : "first");
		else this.select(index);
	}

	private jump(edge: "first" | "last"): void {
		const index = edge === "first" ? this.rows.findIndex(this.navigable) : this.rows.findLastIndex(this.navigable);
		if (index >= 0) this.select(index);
	}

	private select(index: number): void {
		this.selectedRow = index;
		this.pinned = true;
		this.ensureVisible();
	}

	private ensureVisible(): void {
		if (this.selectedRow < 0) return;
		const height = this.listHeight();
		const top = this.rows[this.selectedRow - 1]?.kind === "header" ? this.selectedRow - 1 : this.selectedRow;
		if (top < this.scroll) this.scroll = top;
		else if (this.selectedRow >= this.scroll + height) this.scroll = this.selectedRow - height + 1;
		this.clampScroll();
	}

	private clampScroll(): void {
		this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, this.rows.length - this.listHeight())));
	}

	private setQuery(query: string): void {
		if (query === this.query) return;
		this.query = query;
		this.rebuild(this.pinned ? this.selected : undefined);
	}

	/** Matches via `rank` on label, then id + group, regrouped in the options' order; a query selects its best hit, an empty one keeps the carried row. */
	private rebuild(carry: CommandSelectOption | undefined): void {
		const ranked = rank(this.options, this.query, (option) => option.label, (option) => `${option.id} ${option.group ?? ""}`);
		const matched = new Map<CommandSelectOption, readonly number[]>();
		for (const { item, indices } of ranked) matched.set(item, indices);
		const always = this.interaction.alwaysShow;
		if (always !== undefined) for (const option of this.options) if (always.has(option.id) && !matched.has(option)) matched.set(option, []);
		const grouped = this.options.some((option) => option.group !== undefined);
		const rows: PickerRow[] = [];
		let group: string | undefined;
		for (const option of this.options) {
			const indices = matched.get(option);
			if (indices === undefined) continue;
			if (grouped && (rows.length === 0 || option.group !== group)) {
				rows.push({ kind: "header", label: option.group ?? "Other" });
				group = option.group;
			}
			rows.push({ kind: "option", option, indices });
		}
		this.rows = rows;
		this.hits = matched.size;
		const carried = carry === undefined ? -1 : rows.findIndex((row) => this.navigable(row) && row.option === carry);
		const target = this.query.trim() === "" ? (this.interaction.focusFirst ? undefined : this.options.find((option) => option.current && option.disabled !== true)) : ranked.find(({ item }) => item.disabled !== true)?.item;
		const index = carried >= 0 ? carried : target === undefined ? -1 : rows.findIndex((row) => row.kind === "option" && row.option === target);
		this.selectedRow = index >= 0 ? index : rows.findIndex(this.choosable);
		this.pinned = carried >= 0;
		this.scroll = 0;
		this.hoveredRow = undefined;
		this.ensureVisible();
		this.cache = undefined;
	}

	/**
	 * The description column starts after the widest described label, never past 3/5 of the row (the dropdown's split) nor so far
	 * that those rows' tags and a minimal description stop fitting, so a label is cut only when it cannot fit. A row without a
	 * description is not in the column: it spends the whole row on its label.
	 */
	private labelWidth(listWidth: number): number {
		let widest = 0;
		let tags = 0;
		for (const row of this.rows) {
			if (row.kind !== "option" || row.option.description === undefined) continue;
			widest = Math.max(widest, visibleWidth(row.option.label));
			tags = Math.max(tags, tagWidthOf(row.option));
		}
		const room = listWidth - this.markWidth - (tags > 0 ? tags + TAG_GAP : 0) - LABEL_GAP - MIN_DESCRIPTION;
		return Math.max(1, Math.min(widest, Math.floor((listWidth * 3) / 5), room));
	}

	private renderFilter(width: number): string {
		const matches = `${this.hits} of ${this.options.length}`;
		const count = color.gray(this.checks === undefined ? matches : `${this.checks.size}/${this.options.length} checked${HINT_SEP}${matches}`);
		const countWidth = visibleWidth(count);
		const queryWidth = Math.max(1, width - countWidth - FILTER_LABEL.length - 2);
		const chars = [...this.query];
		const shown = chars.slice(Math.max(0, chars.length - queryWidth)).join("");
		const field = this.query === "" ? `${inverse(" ")}${color.grayDim(truncateToWidth(FILTER_PLACEHOLDER, Math.max(0, queryWidth - 1), ""))}` : `${color.textPrimary(shown)}${inverse(" ")}`;
		const left = `${color.gray(FILTER_LABEL)}${field}`;
		return `${left}${" ".repeat(Math.max(1, width - visibleWidth(left) - countWidth))}${count}`;
	}

	/** Grok's section header: ` Label ` bold gray, then a gray_dim rule to the row's end (picker.rs:1208-1226). */
	private renderHeader(label: string, width: number): string {
		const title = ` ${truncateToWidth(label, Math.max(0, width - 2), glyph.ellipsis)} `;
		return `${color.sectionHeader(title)}${color.sectionRule("─".repeat(Math.max(0, width - visibleWidth(title))))}`;
	}

	private renderOption(row: PickerRow & { kind: "option" }, width: number, labelWidth: number, selected: boolean, hovered: boolean): string {
		const { option, indices } = row;
		const tags = [...(option.current ? [color.tag(CURRENT_TAG)] : []), ...(option.tag === undefined ? [] : [color.tag(option.tag)]), ...(option.badge === undefined ? [] : [color.badge(option.badge)])].join(" ");
		const tagWidth = visibleWidth(tags);
		const tagRoom = tagWidth > 0 ? tagWidth + TAG_GAP : 0;
		const disabled = option.disabled === true;
		const mark =
			this.checks !== undefined
				? (disabled ? color.gray : this.checks.has(option.id) ? color.currentMark : color.textSecondary)(this.checks.has(option.id) ? CHECKED_MARK : UNCHECKED_MARK)
				: option.current
					? (disabled ? color.gray : color.currentMark)(`${glyph.current} `)
					: " ".repeat(MARK_WIDTH);
		const label = clip(option.label, option.description === undefined || this.interaction.descriptionBelow ? width - this.markWidth - tagRoom : labelWidth);
		const descriptionWidth = width - this.markWidth - labelWidth - LABEL_GAP - tagRoom;
		const description =
			!this.interaction.descriptionBelow && option.description !== undefined && descriptionWidth >= MIN_DESCRIPTION
				? `${" ".repeat(Math.max(0, labelWidth - visibleWidth(label)) + LABEL_GAP)}${color.gray(clip(option.description, descriptionWidth))}`
				: "";
		const left = `${mark}${disabled ? color.gray(label) : highlight(label, indices, selected)}${description}`;
		const text = tagWidth > 0 ? `${left}${" ".repeat(Math.max(1, width - visibleWidth(left) - tagWidth))}${tags}` : left;
		const band = pad(clip(text, width), width);
		return selected ? (isDosTheme() ? inverse(band) : color.bgVisual(band)) : hovered ? color.bgHover(band) : band;
	}
}
