/**
 * Logo lockups (pure SVG strings): the dot head mark + the outlined Geist wordmark (src/brand/wordmark.ts),
 * horizontal and stacked, in three variants:
 *   color: five-signal mark, ink wordmark (default, on paper or white)
 *   ink:   one color, #141515 (print, single-color contexts)
 *   mint:  one color, mint-deep #007650 (AA on paper; the brand's one-color accent)
 * The stacked color lockup carries the five-stripe signature under the wordmark (BRIEF 12a).
 * Geometry is in wordmark units (1000 per em); see docs/assets.md for clear space and minimum sizes.
 */
import { type Palette, dotsToSvgBody, escapeXml, markSprite, spriteDots } from "./mascot.ts";
import { INK, STOPS, STOP_NAMES } from "./palette.ts";
import { WORDMARK_ASCENDER, WORDMARK_GLYPHS, WORDMARK_WIDTH } from "./wordmark.ts";

export type LockupLayout = "horizontal" | "stacked";
export type LockupVariant = "color" | "ink" | "mint";

const VARIANT: Record<LockupVariant, { palette: Palette; text: string }> = {
	color: { palette: "color", text: INK },
	ink: { palette: "ink", text: INK },
	mint: { palette: "mint", text: "#007650" },
};

/** Mark dot pitch in wordmark units: the 9-row mark is 1.27x the ascender height. */
export const MARK_PITCH = 100;
const MARK_W = 11 * MARK_PITCH;
const MARK_H = 9 * MARK_PITCH;

/** The mark's dots as an SVG fragment placed at (x, y) with `pitch` units per cell. */
export function markFragment(x: number, y: number, pitch: number, palette: Palette): string {
	const dots = spriteDots(markSprite(), { palette, fill: 0.8 }).map((d) => ({ ...d, cx: x + d.cx * pitch, cy: y + d.cy * pitch, r: d.r * pitch }));
	return dotsToSvgBody(dots);
}

function wordmarkFragment(x: number, baseline: number, fill: string): string {
	return `<g fill="${fill}" transform="translate(${x} ${baseline})">${WORDMARK_GLYPHS.map((g) => `<path d="${g.d}"/>`).join("")}</g>`;
}

function stripes(x: number, y: number, width: number, height: number): string {
	const gap = height * 0.5;
	const w = (width - gap * (STOP_NAMES.length - 1)) / STOP_NAMES.length;
	return STOP_NAMES.map((name, i) => `<rect x="${(x + i * (w + gap)).toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="${height}" fill="${STOPS[name]}"/>`).join("");
}

export interface LockupOptions {
	layout?: LockupLayout;
	variant?: LockupVariant;
	/** Rendered height in px (width follows); fluid when omitted. */
	height?: number;
	title?: string;
}

export interface Lockup {
	svg: string;
	width: number;
	height: number;
}

/** Pure: a logo lockup as an SVG string plus its intrinsic size (wordmark units). */
export function renderLockup(options: LockupOptions = {}): Lockup {
	const { layout = "horizontal", variant = "color", height, title = "dinobot" } = options;
	const v = VARIANT[variant];
	let body: string;
	let w: number;
	let h: number;
	if (layout === "horizontal") {
		// Mark vertically centered on the ascender band; gap = 0.42 em.
		const gap = 420;
		const markTop = 0;
		const baseline = MARK_H / 2 + WORDMARK_ASCENDER / 2;
		body = markFragment(0, markTop, MARK_PITCH, v.palette) + wordmarkFragment(MARK_W + gap, baseline, v.text);
		w = MARK_W + gap + WORDMARK_WIDTH;
		h = MARK_H;
	} else {
		const scale = 1.6;
		const markW = MARK_W * scale;
		const gap = 300;
		const baseline = MARK_H * scale + gap + WORDMARK_ASCENDER;
		w = Math.max(markW, WORDMARK_WIDTH);
		body = markFragment((w - markW) / 2, 0, MARK_PITCH * scale, v.palette) + wordmarkFragment((w - WORDMARK_WIDTH) / 2, baseline, v.text);
		h = baseline + 60;
		if (variant === "color") {
			body += stripes((w - WORDMARK_WIDTH) / 2 + 30, baseline + 220, WORDMARK_WIDTH - 60, 70);
			h = baseline + 290;
		}
	}
	const size = height ? ` width="${((height * w) / h).toFixed(1)}" height="${height}"` : "";
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"${size} role="img" aria-label="${escapeXml(title)}"><title>${escapeXml(title)}</title>${body}</svg>`;
	return { svg, width: w, height: h };
}

/** Pure: the mark alone (square-ish 11x9 grid) in a variant. */
export function renderMark(variant: LockupVariant = "color", title = "dinobot"): string {
	const p = MARK_PITCH;
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${11 * p} ${9 * p}" role="img" aria-label="${escapeXml(title)}"><title>${escapeXml(title)}</title>${markFragment(0, 0, p, VARIANT[variant].palette)}</svg>`;
}
