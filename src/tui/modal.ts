import { type OverlayOptions, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { bold, color, glyph, modalSizing, pad, paint, square } from "./theme.ts";

export type OverlaySize = { cols: number; rows: number };
export type ModalBox = { readonly width: number; readonly height: number };

/** Grok's compute_modal_dims (modal_window.rs:576-589) for the medium picker sizing; undefined when the terminal cannot hold a popup (< 20x6). */
export function modalWindowSize(size: OverlaySize): ModalBox | undefined {
	const maxWidth = Math.min(size.cols - 4, modalSizing.maxWidth);
	const width = Math.min(Math.max(Math.min(Math.floor(size.cols * modalSizing.widthPct), maxWidth), modalSizing.minWidth), size.cols);
	const height = size.rows - modalSizing.vMargin * 2;
	return width < 20 || height < 6 ? undefined : { width, height };
}

/** Blank cells kept around a modal's frame, painted on the base background, so the window reads as its own surface instead of touching the borders of whatever lies beneath it. */
export const MODAL_MARGIN = 1;

/** `showOverlay` options centering a modal at Grok's size plus its blank margin; the component fits its own height under `maxHeight`. */
export function modalOverlayOptions(size: OverlaySize): OverlayOptions {
	const box = modalWindowSize(size) ?? { width: Math.max(1, size.cols - MODAL_MARGIN * 2), height: Math.max(1, size.rows - MODAL_MARGIN * 2) };
	return { anchor: "center", width: box.width + MODAL_MARGIN * 2, maxHeight: box.height + MODAL_MARGIN * 2 };
}

export const modalFrameWidth = (overlayWidth: number): number => Math.max(1, overlayWidth - MODAL_MARGIN * 2);

export const modalFrameHeight = (size: OverlaySize): number => modalWindowSize(size)?.height ?? Math.max(6, size.rows - MODAL_MARGIN * 2);

/** The frame's rows inset by the blank margin on every side, each painted to exactly the overlay width (clipped when the overlay is too narrow for a frame). */
export function withMargin(frame: readonly string[], width: number): string[] {
	const blank = Array.from({ length: MODAL_MARGIN }, () => paint("", width));
	const inset = " ".repeat(MODAL_MARGIN);
	return [...blank, ...frame.map((line) => paint(truncateToWidth(`${inset}${line}`, width, ""), width)), ...blank];
}

/** Rows a modal spends outside its content: both borders, the row above the content and the footer rows. */
export const MODAL_CHROME_ROWS = 2 + modalSizing.vPad + modalSizing.footerLines;
/** The `[✗]` close button sits on the top border, its 5 cells ` [✗] ` ending two columns before the corner (render_close_button). */
const CLOSE_WIDTH = 5;
const CLOSE_INSET = 2;

/** The narrowest frame whose top border still holds the corners and the close button; narrower frames draw a plain border without one. */
const CLOSE_MIN_WIDTH = 1 + CLOSE_WIDTH + CLOSE_INSET;

export const closeButtonHit = (width: number, x: number, y: number): boolean => width >= CLOSE_MIN_WIDTH && y === 0 && x >= width - CLOSE_WIDTH - CLOSE_INSET && x < width - CLOSE_INSET;

/** `┌─ Title ───── [✗] ─┐`: gray_dim border, bold title, the close button bold while hovered (modal_window.rs:281-300, 406-440). */
export function modalTop(title: string, width: number, closeHovered = false): string {
	const border = color.modalBorder;
	if (width < CLOSE_MIN_WIDTH) return border(`${square.tl}${square.h.repeat(Math.max(0, width - 2))}${square.tr}`);
	const label = truncateToWidth(title, Math.max(0, width - 2 - 4 - CLOSE_WIDTH - CLOSE_INSET), glyph.ellipsis);
	const titled = label === "" ? "" : `${border(`${square.h} `)}${color.modalTitle(label)}${border(` ${square.h}`)}`;
	const close = closeHovered ? bold(color.textPrimary(` ${glyph.closeButton} `)) : border(` ${glyph.closeButton} `);
	const dashes = Math.max(0, width - 1 - visibleWidth(titled) - CLOSE_WIDTH - CLOSE_INSET);
	return `${border(square.tl)}${titled}${border(square.h.repeat(dashes))}${close}${border(`${square.h.repeat(CLOSE_INSET - 1)}${square.tr}`)}`;
}

export const modalBottom = (width: number): string => color.modalBorder(`${square.bl}${square.h.repeat(Math.max(0, width - 2))}${square.br}`);

/** A full-width `─` divider between the border sides (the tab divider of modal_window.rs:339-349). */
export const modalDivider = (width: number): string => {
	const side = color.modalBorder(square.v);
	return `${side}${color.modalBorder(square.h.repeat(Math.max(0, width - 2)))}${side}`;
};

export function modalRow(text: string, width: number): string {
	const side = color.modalBorder(square.v);
	return `${side}${pad(truncateToWidth(text, Math.max(0, width - 2), ""), width - 2)}${side}`;
}

export const modalContent = (text: string, width: number): string => modalRow(`${" ".repeat(modalSizing.hPad)}${text}`, width);

export const modalContentWidth = (width: number): number => Math.max(1, width - 2 - modalSizing.hPad * 2);

/** Greedy line breaking of footer hints at `sep` (render_modal_shortcuts, modal_window.rs:642-660). */
export function wrapHints(hints: readonly string[], width: number, sep: string): string[][] {
	const rows: string[][] = [[]];
	let used = 0;
	for (const hint of hints) {
		const hintWidth = visibleWidth(hint);
		const row = rows[rows.length - 1] as string[];
		const needed = row.length === 0 ? hintWidth : used + visibleWidth(sep) + hintWidth;
		if (needed > width && row.length > 0) {
			rows.push([hint]);
			used = hintWidth;
		} else {
			row.push(hint);
			used = needed;
		}
	}
	return rows;
}

export function styleHint(hint: string): string {
	const space = hint.indexOf(" ");
	return space < 0 ? bold(color.textSecondary(hint)) : `${bold(color.textSecondary(hint.slice(0, space)))}${color.gray(hint.slice(space))}`;
}

export function renderHints(hints: readonly string[], width: number, sep: string, lines = modalSizing.footerLines): string[] {
	const rows = wrapHints(hints, width, sep);
	const out: string[] = [];
	for (let index = rows.length; index < lines; index++) out.push("");
	for (const row of rows) {
		const total = row.reduce((sum, hint) => sum + visibleWidth(hint), 0) + visibleWidth(sep) * (row.length - 1);
		const text = row.map(styleHint).join(color.grayDim(sep));
		out.push(`${" ".repeat(Math.max(0, Math.floor((width - total) / 2)))}${truncateToWidth(text, width, "")}`);
	}
	return out;
}

export function renderScrollbar(total: number, visible: number, scroll: number): string[] {
	const length = Math.max(1, Math.floor((visible * visible) / Math.max(1, total)));
	const top = Math.round((scroll * (visible - length)) / Math.max(1, total - visible));
	return Array.from({ length: visible }, (_, index) => (index >= top && index < top + length ? color.grayDim("█") : " "));
}

/** The scroll offset that centers the thumb on track row `y` (a click on the scrollbar jumps there). */
export function scrollbarJump(total: number, visible: number, y: number): number {
	if (total <= visible) return 0;
	const length = Math.max(1, Math.floor((visible * visible) / total));
	const track = Math.max(1, visible - length);
	const top = Math.max(0, Math.min(track, y - Math.floor(length / 2)));
	return Math.round((top * (total - visible)) / track);
}

/** One terminal chunk may carry several keys (`\x7f\x7f\x7f`, `text\r`): control characters become their own keys, printable runs stay whole, escape sequences pass through. */
export function splitKeys(data: string): string[] {
	if (data.startsWith("\x1b") || data.length <= 1) return [data];
	const keys: string[] = [];
	let run = "";
	for (const char of data) {
		if (char >= " " && char !== "\x7f") {
			run += char;
			continue;
		}
		if (run !== "") keys.push(run);
		run = "";
		keys.push(char);
	}
	if (run !== "") keys.push(run);
	return keys;
}

export function renderModal(title: string, body: readonly string[], hints: readonly string[], sep: string, width: number, closeHovered = false): string[] {
	const lines = [modalTop(title, width, closeHovered), ...body.map((row) => modalRow(row, width)), ...renderHints(hints, modalContentWidth(width), sep).map((row) => modalContent(row, width)), modalBottom(width)];
	return lines.map((line) => paint(line, width));
}
