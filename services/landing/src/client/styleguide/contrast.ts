/**
 * WCAG 2.x contrast for the Signal Paper tokens. Shared by the /design/ style guide (live values from the
 * computed style) and the CLI `bun src/client/styleguide/contrast-report.ts` (values parsed from tokens.css).
 * No DOM or Node APIs here.
 */
import { SPECIES_IDS } from "../../brand/species.ts";

export type ContrastKind = "text" | "large" | "ui";

export interface ContrastPair {
	/** Foreground token name without the leading `--`. */
	fg: string;
	/** Background token name without the leading `--`. */
	bg: string;
	/** text: 4.5:1 (WCAG 1.4.3); large: 3:1 (text >= 24px, or >= 18.66px bold); ui: 3:1 (1.4.11 boundaries, focus). */
	kind: ContrastKind;
	use: string;
}

export const MIN_RATIO: Record<ContrastKind, number> = { text: 4.5, large: 3, ui: 3 };

export const SIGNALS = ["mint", "teal", "cyan", "blue", "indigo"] as const;
export type Signal = (typeof SIGNALS)[number];

const surfaces = ["bg", "surface", "bg-band"] as const;

/** Every text/background (and UI boundary) pair the system defines. Keep in sync with components.css. */
export const CONTRAST_PAIRS: ContrastPair[] = [
	...surfaces.flatMap((bg): ContrastPair[] => [
		{ fg: "text-1", bg, kind: "text", use: "Body text, headings" },
		{ fg: "text-2", bg, kind: "text", use: "Secondary text, ledes, nav links" },
		{ fg: "text-3", bg, kind: "text", use: "Captions, placeholders, trust line, inactive locale" },
		{ fg: "text-muted-large", bg, kind: "large", use: "Two-tone headline continuation (>= 24px only)" },
		{ fg: "line-ui", bg, kind: "ui", use: "Input and checkbox boundary" },
		{ fg: "focus", bg, kind: "ui", use: "Focus ring" },
		{ fg: "surface-inverse", bg, kind: "ui", use: "Primary (ink) button shape" },
		{ fg: "danger-deep", bg, kind: "text", use: "Error message, invalid boundary" },
	]),
	{ fg: "text-1", bg: "surface-hover", kind: "text", use: "Text on hover fill, neutral tag" },
	{ fg: "text-2", bg: "surface-hover", kind: "text", use: "Neutral tag label" },
	{ fg: "text-3", bg: "surface-hover", kind: "text", use: "Caption on hover fill" },
	{ fg: "text-1", bg: "surface-pressed", kind: "text", use: "Text on pressed fill" },
	{ fg: "text-inverse", bg: "surface-inverse", kind: "text", use: "Primary button label, tooltip, toast" },
	{ fg: "text-inverse-2", bg: "surface-inverse", kind: "text", use: "Secondary text on ink" },
	{ fg: "text-1", bg: "selection", kind: "text", use: "Selected text" },
	{ fg: "danger-deep", bg: "danger-tint", kind: "text", use: "Error text on the error tint" },
	{ fg: "text-1", bg: "danger-tint", kind: "text", use: "Ink on the error tint" },
	...SIGNALS.flatMap((s): ContrastPair[] => [
		{ fg: `${s}-deep`, bg: "bg", kind: "text", use: `${s} text and icons on paper` },
		{ fg: `${s}-deep`, bg: "surface", kind: "text", use: `${s} text on white` },
		{ fg: `${s}-deep`, bg: "bg-band", kind: "text", use: `${s} text on the band` },
		{ fg: `${s}-deep`, bg: `${s}-tint`, kind: "text", use: `Signal tag label (${s})` },
		{ fg: "text-1", bg: s, kind: "text", use: `Ink on a solid ${s} fill (solid tag)` },
		{ fg: "text-1", bg: `${s}-tint`, kind: "text", use: `Ink on the ${s} tint (headline pill)` },
		{ fg: "n-11", bg: `${s}-tint`, kind: "text", use: `Tinted pill label (${s})` },
		{ fg: "text-1", bg: `${s}-soft`, kind: "text", use: `Ink on the ${s} soft fill` },
	]),
	{ fg: "n-11", bg: "success-tint", kind: "text", use: "Waitlist success sub-line" },
	...dinoPairs(),
];

/**
 * Dinosaur themes (ADR 0100): each species' accent family (`--dino-<id>-*`, which `:root[data-dino]` maps onto
 * --accent and --selection) as text on paper and white, on its own tint, and behind ink as the selection.
 */
function dinoPairs(): ContrastPair[] {
	return SPECIES_IDS.flatMap((id): ContrastPair[] => [
		{ fg: `dino-${id}-deep`, bg: "bg", kind: "text", use: `${id} theme accent text on paper` },
		{ fg: `dino-${id}-deep`, bg: "surface", kind: "text", use: `${id} theme accent text on white` },
		{ fg: `dino-${id}-deep`, bg: `dino-${id}-tint`, kind: "text", use: `${id} theme accent text on its tint` },
		{ fg: "n-11", bg: `dino-${id}-tint`, kind: "text", use: `${id} theme: checked theme switch, tinted pill label` },
		{ fg: "text-1", bg: `dino-${id}-soft`, kind: "text", use: `${id} theme selection` },
	]);
}

/** Parses #rgb, #rrggbb (case-insensitive). Returns null for anything else. */
export function parseHex(value: string): [number, number, number] | null {
	const v = value.trim();
	const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);
	if (!m) return null;
	const hex = (m[1] as string).length === 3 ? [...(m[1] as string)].map((c) => c + c).join("") : (m[1] as string);
	return [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

export function relativeLuminance([r, g, b]: [number, number, number]): number {
	const lin = (c: number) => {
		const s = c / 255;
		return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio of two hex colors (1..21), or null when either is not a hex color. */
export function contrastRatio(a: string, b: string): number | null {
	const x = parseHex(a);
	const y = parseHex(b);
	if (!x || !y) return null;
	const [hi, lo] = [relativeLuminance(x), relativeLuminance(y)].sort((p, q) => q - p) as [number, number];
	return (hi + 0.05) / (lo + 0.05);
}

/** Floors to 2 decimals, so a printed ratio never rounds a failing value up to a passing one. */
export function formatRatio(ratio: number): string {
	return (Math.floor(ratio * 100) / 100).toFixed(2);
}

/** The WCAG grade for a text ratio: AAA (>= 7), AA (>= 4.5), AA large (>= 3), or fail. */
export function grade(ratio: number): "AAA" | "AA" | "AA large" | "fail" {
	if (ratio >= 7) return "AAA";
	if (ratio >= 4.5) return "AA";
	if (ratio >= 3) return "AA large";
	return "fail";
}

export interface PairResult extends ContrastPair {
	fgValue: string;
	bgValue: string;
	ratio: number | null;
	min: number;
	pass: boolean;
}

/** Evaluates every pair with a token resolver (name -> hex). Unresolvable tokens fail. */
export function evaluatePairs(resolve: (name: string) => string | undefined, pairs: ContrastPair[] = CONTRAST_PAIRS): PairResult[] {
	return pairs.map((p) => {
		const fgValue = resolve(p.fg) ?? "";
		const bgValue = resolve(p.bg) ?? "";
		const ratio = contrastRatio(fgValue, bgValue);
		const min = MIN_RATIO[p.kind];
		return { ...p, fgValue, bgValue, ratio, min, pass: ratio !== null && Math.floor(ratio * 100) / 100 >= min };
	});
}

/**
 * Collects `--name: value` declarations from the first `:root { ... }` block of tokens.css (the defaults; media,
 * supports, lang and data-signal overrides are ignored) and resolves var() chains.
 */
export function resolveTokensCss(css: string): Map<string, string> {
	const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
	const start = stripped.search(/:root\s*\{/);
	if (start < 0) return new Map();
	let depth = 0;
	let end = start;
	for (let i = stripped.indexOf("{", start); i < stripped.length; i++) {
		if (stripped[i] === "{") depth++;
		else if (stripped[i] === "}" && --depth === 0) {
			end = i;
			break;
		}
	}
	const body = stripped.slice(stripped.indexOf("{", start) + 1, end);
	const raw = new Map<string, string>();
	for (const m of body.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) raw.set(m[1] as string, (m[2] as string).trim());
	const resolved = new Map<string, string>();
	const resolveOne = (name: string, seen: Set<string>): string | undefined => {
		if (resolved.has(name)) return resolved.get(name);
		const value = raw.get(name);
		if (value === undefined || seen.has(name)) return undefined;
		seen.add(name);
		const ref = /^var\(--([\w-]+)\)$/.exec(value);
		const out = ref ? resolveOne(ref[1] as string, seen) : value;
		if (out !== undefined) resolved.set(name, out);
		return out;
	};
	for (const name of raw.keys()) resolveOne(name, new Set());
	return resolved;
}
