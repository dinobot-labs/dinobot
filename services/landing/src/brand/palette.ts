/**
 * Brand colors for generated assets (pure data, no DOM). Values mirror src/client/styles/tokens.css and the
 * desktop-icon stops of ADR 0027; test/brand/mascot.test.ts keeps them in sync with tokens.css.
 */

import { DEFAULT_SPECIES, SPECIES, SPECIES_IDS, type SpeciesId } from "./species.ts";

export const STOP_NAMES = ["mint", "teal", "cyan", "blue", "indigo"] as const;
export type StopName = (typeof STOP_NAMES)[number];

/** The five signal solids, tail (mint) to head (indigo). */
export const STOPS: Readonly<Record<StopName, string>> = {
	mint: "#19ca9d",
	teal: "#2db4b2",
	cyan: "#3da5c2",
	blue: "#538eda",
	indigo: "#5d7cde",
};

/** AA text variants on paper (tokens.css `--*-deep`). */
export const STOPS_DEEP: Readonly<Record<StopName, string>> = {
	mint: "#007650",
	teal: "#007372",
	cyan: "#00718c",
	blue: "#2f68b0",
	indigo: "#4661bd",
};

export const INK = "#141515"; // --n-12
export const PAPER = "#f9fbfa"; // --n-1
export const WHITE = "#ffffff";
export const CHEEK = "#ff8f87"; // --red, the TUI cheek
export const UNLIT = "#e3e7e5"; // --n-4, unlit LED cells

function parse(hex: string): [number, number, number] {
	const n = Number.parseInt(hex.slice(1), 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex([r, g, b]: [number, number, number]): string {
	return `#${[r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("")}`;
}

/** sRGB mix like the TUI's mixColors(a, b, t, "srgb"): t = 0 gives a, t = 1 gives b. */
export function mix(a: string, b: string, t: number): string {
	const pa = parse(a);
	const pb = parse(b);
	return toHex([pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t, pa[2] + (pb[2] - pa[2]) * t]);
}

/** The stop a column falls into when `cols` columns are quantized into five equal bands (tail to head). */
export function stopIndex(x: number, cols: number): number {
	return Math.min(STOP_NAMES.length - 1, Math.max(0, Math.floor((x * STOP_NAMES.length) / cols)));
}

/**
 * Per-stop tints derived exactly like the TUI tokens (src/tui/mascot.ts tokenColor): ridge S = 45% toward white,
 * belly L = 75% toward white, mouth D = 35% toward black. Precomputed so every dot is one of a small, fixed set.
 */
export interface StopTints {
	body: string;
	ridge: string;
	belly: string;
	mouth: string;
}

const tintsFor = (stops: readonly string[]): readonly StopTints[] =>
	stops.map((body) => ({ body, ridge: mix(body, WHITE, 0.45), belly: mix(body, WHITE, 0.75), mouth: mix(body, "#000000", 0.35) }));

/** The T-rex (Signal) tints. */
export const TINTS: readonly StopTints[] = tintsFor(STOP_NAMES.map((name) => STOPS[name]));

const SPECIES_TINTS = Object.fromEntries(SPECIES_IDS.map((id) => [id, tintsFor(SPECIES[id].stops)])) as Record<SpeciesId, readonly StopTints[]>;
/** Per-species tints: the same derivation over that species' five stops. */
export const tintsOf = (species: SpeciesId = DEFAULT_SPECIES): readonly StopTints[] => SPECIES_TINTS[species];
