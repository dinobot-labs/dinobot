import { type Color, foregroundAnsi, getTerminalColorMode, mixColors, parseColor } from "@earendil-works/pi-tui";
import { palette, type ThemeName, themeName, themes } from "./theme.ts";

export type MascotState = "idle" | "done" | "failed";
export type MascotScale = 1 | 2;

export const MASCOT_SIZE = {
	1: { cols: 15, rows: 5 },
	2: { cols: 30, rows: 9 },
} as const satisfies Record<MascotScale, { cols: number; rows: number }>;

/**
 * Facing right, one 30x18 bitmap per dinosaur theme (ADR 0100). G body, D dark, S ridge, L belly, P cheek,
 * a..i the 3x3 eye cell, m the mouth run, '.' empty. services/landing/src/brand/species.ts carries them verbatim.
 */
const REX_BITMAP = [
	".................GGGGGGGGG....",
	"................GGGGGGGGGGGG..",
	"................GGGabcGGGGGGG.",
	"................GGGdefGGGGGGGG",
	"........S.S.S...GGGghiGGGGGGGG",
	".......SGSGSGSG.GGPPGGGGGGGGGG",
	".....GGGGGGGGGGGGGGGGGGGGmmmmm",
	"...GGGGGGGGGGGGGGGGGGGGGGGGGG.",
	".GGGGGGGGGGGGGGGGGGGGGGGGGG...",
	"GGGG..GGGGLLLLLLLLGGG.........",
	"GG.....GGGLLLLLLLLLGGGG.......",
	".......GGGLLLLLLLLGG.GG.......",
	"........GGGLLLLLLGGG..G.......",
	"........GGGGGGGGGGG...........",
	"........GGGG...GGGG...........",
	"........GGG.....GGG...........",
	".......GGGG....GGGG...........",
	"......GGGGG...GGGGG...........",
];

const PTERO_BITMAP = [
	"GG............................",
	"GGGG..........................",
	".GGGGG........................",
	"..GLLGGG........SS............",
	"...LLLLGGG.......SSSS.........",
	"....LLLLLGGG......GGGGGG......",
	".....LLLLLLGGG...GGGabcGG.....",
	"......LLLLLLLGG..GGGdefGGG....",
	".......LLLLLLLGG.GGGghiGGGGGG.",
	"........LLLLLLGG.GGPPGGGGmmmmm",
	".........LLLLLGG..GGGGGGGGGGG.",
	".........GGGGGGGGGGG..........",
	"........GGGLLLLLLGGG..........",
	".......GGGLLLLLLGGG...........",
	".....GGGGGGGGGGGG.............",
	"...GGG..GG...GG...............",
	"..............................",
	"..............................",
];

const BRACHIO_BITMAP = [
	"......................GGGGG...",
	".....................GabcGGGG.",
	".....................GdefGGGGG",
	".....................GghiGPGGG",
	"....................GGGGGmmmmm",
	"...................GGGGGGGGG..",
	"..................GGGGG.......",
	".................GGGGG........",
	"................GGGGG.........",
	"........GGGGGGGGGGGG..........",
	"......GGGGSGGGSGGGG...........",
	"....GGGGGGGGGGGGGGG...........",
	"..GGGGGLLLLLLLLLGGG...........",
	"GGG..GGLLLLLLLLGGGG...........",
	"......GGG..GG...GGG...........",
	"......GGG..GG...GGG...........",
	"......GGG..GG...GGG...........",
	".....GGGG.GGG..GGGG...........",
];

const TRICERA_BITMAP = [
	"..............SS..............",
	".............SSSS.............",
	"............SSGGGSS...........",
	"...........SSGGGGGSS...SS.....",
	"..........SSGGGGGGGGG.SS......",
	".........SSGGGGGGGabcSSS....S.",
	"........GGGGGGGGGGdefGGGG..SS.",
	"......GGGGGGGGGGGGghiGGGGSSSS.",
	"....GGGGGGGGGGGGGGPPGGGGGGGGGG",
	"..GGGGGGGGGGGGGGGGGGGGGGGmmmmm",
	".GGGGGGGGLLLLLLLLLLGGGGGGGGG..",
	"GGGG..GGGLLLLLLLLLLLGGGG......",
	"GG.....GGLLLLLLLLLLGGG........",
	".......GGGGGGGGGGGGGGG........",
	".......GGGG..GGG..GGGG........",
	".......GGG...GGG...GGG........",
	".......GGG...GGG...GGG........",
	"......GGGG..GGGG..GGGG........",
];

export const MASCOT_BITMAPS: Readonly<Record<ThemeName, readonly string[]>> = { rex: REX_BITMAP, ptero: PTERO_BITMAP, brachio: BRACHIO_BITMAP, tricera: TRICERA_BITMAP };
/** The T-rex, the default theme's mascot. */
export const MASCOT_BITMAP: readonly string[] = REX_BITMAP;

/** Eye cell (a..i, row-major): '.' hole, G body dot, W glint dot; mouth token for the m run. */
export const MASCOT_EYES: Readonly<Record<MascotState, { readonly cell: string; readonly mouth: "D" | "P" }>> = {
	idle: { cell: "..W......", mouth: "D" },
	done: { cell: "G.G.G.GGG", mouth: "P" },
	failed: { cell: ".G.G.G.G.", mouth: "D" },
};

const BIT = [
	[0x01, 0x08],
	[0x02, 0x10],
	[0x04, 0x20],
	[0x40, 0x80],
] as const;

const BASE_W = 30;
const BASE_H = 18;
const PRIORITY = "PWSDGL";

const stopCache = new Map<ThemeName, readonly Color[]>();
const brandStops = (theme: ThemeName): readonly Color[] => {
	let stops = stopCache.get(theme);
	if (stops === undefined) {
		stops = themes[theme].stops.map((hex) => parseColor(hex));
		stopCache.set(theme, stops);
	}
	return stops;
};
const BLACK = parseColor("#000000");
const WHITE = parseColor("#FFFFFF");
const CHEEK = parseColor(palette.red);

/** The active theme's brand gradient (tail -> head stop) at `t` in 0..1; shared by the mascot body and the welcome wordmark. */
export const brandGradient = (t: number, theme: ThemeName = themeName()): Color => {
	const STOPS = brandStops(theme);
	const scaled = Math.min(Math.max(t, 0), 1) * (STOPS.length - 1);
	const index = Math.min(Math.floor(scaled), STOPS.length - 2);
	return mixColors(STOPS[index] as Color, STOPS[index + 1] as Color, scaled - index, "srgb");
};

const tokenColor = (token: string, body: Color): Color => {
	switch (token) {
		case "P":
			return CHEEK;
		case "W":
			return WHITE;
		case "S":
			return mixColors(body, WHITE, 0.45, "srgb");
		case "D":
			return mixColors(body, BLACK, 0.35, "srgb");
		case "L":
			return mixColors(body, WHITE, 0.75, "srgb");
		default:
			return body;
	}
};

function pixelToken(bitmap: readonly string[], state: MascotState, x: number, y: number): string {
	const token = bitmap[y]?.[x] ?? ".";
	const eyes = MASCOT_EYES[state];
	if (token === "m") return eyes.mouth;
	if (token >= "a" && token <= "i") {
		const eye = eyes.cell[token.charCodeAt(0) - 97];
		return eye ?? ".";
	}
	return token;
}

const mode = getTerminalColorMode();
const cache = new Map<string, string[]>();
/** The active theme's mascot unless `theme` names another one (pickers preview every theme). */
export function renderMascot(state: MascotState, scale: MascotScale, theme: ThemeName = themeName()): string[] {
	const key = `${theme}:${state}:${scale}`;
	const cached = cache.get(key);
	if (cached !== undefined) return cached;
	const { cols, rows } = MASCOT_SIZE[scale];
	const lines: string[] = [];
	for (let cy = 0; cy < rows; cy++) {
		let line = "";
		let open = "";
		for (let cx = 0; cx < cols; cx++) {
			let bits = 0;
			let best = -1;
			for (let dy = 0; dy < 4; dy++) {
				for (let dx = 0; dx < 2; dx++) {
					const px = Math.floor((cx * 2 + dx) / scale);
					const py = Math.floor((cy * 4 + dy) / scale);
					if (px >= BASE_W || py >= BASE_H) continue;
					const token = pixelToken(MASCOT_BITMAPS[theme], state, px, py);
					if (token === ".") continue;
					bits |= BIT[dy]?.[dx] ?? 0;
					const rank = PRIORITY.indexOf(token);
					if (best === -1 || (rank !== -1 && rank < best)) best = rank;
				}
			}
			if (bits === 0) {
				line += " ";
				continue;
			}
			const token = PRIORITY[best] ?? "G";
			const ansi = foregroundAnsi(tokenColor(token, brandGradient((cx + 0.5) / cols, theme)), mode);
			if (ansi !== open) {
				line += ansi;
				open = ansi;
			}
			line += String.fromCharCode(0x2800 + bits);
		}
		lines.push(open === "" ? line : `${line}\x1b[39m`);
	}
	cache.set(key, lines);
	return lines;
}
