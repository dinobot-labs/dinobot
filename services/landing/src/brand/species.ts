/**
 * Dinosaur themes (ADR 0100): every theme is one species with its own 30x18 bitmap, five-stop body gradient and
 * accent. Pure data, no DOM. The T-rex (`rex`) is the original Dinobot Signal mascot and stays the default.
 *
 * Shared contract, so every renderer (TUI braille, web dots, desktop layers, runner) treats species alike:
 *   - the sprite grid is always 30x18, facing right; the mark is 11x9; the favicon is 7x7;
 *   - tokens are the TUI's: G body, D dark, S ridge/crest, L belly/membrane, P cheek, a..i the 3x3 eye cell,
 *     m the 5-cell mouth run, '.' empty;
 *   - poses only swap three regions: the 3x3 eye cell, the mouth run plus the jaw row under it, and the limb
 *     rectangle (legs for walkers, the wing for the pterosaur). The three regions never overlap.
 * The `bitmap` is the idle pose with the `stand` limbs already in place; src/tui/mascot.ts carries the same bitmaps
 * verbatim (test/brand/mascot.test.ts).
 */

export const SPECIES_IDS = ["rex", "ptero", "brachio", "tricera"] as const;
export type SpeciesId = (typeof SPECIES_IDS)[number];
export const DEFAULT_SPECIES: SpeciesId = "rex";

export const isSpeciesId = (value: unknown): value is SpeciesId => typeof value === "string" && (SPECIES_IDS as readonly string[]).includes(value);

export type LimbFrame = "stand" | "run-a" | "run-b" | "jump";
export type MouthShape = "line" | "smile" | "open" | "grimace";

/** One accent family: solid (graphics, never text), deep (AA text), tint (fill behind text), soft (selection). */
export interface Accent {
	solid: string;
	deep: string;
	tint: string;
	soft: string;
}

export interface Species {
	id: SpeciesId;
	/** Display names. */
	name: { en: string; ko: string };
	/** The theme's name, after the Signal family. */
	theme: string;
	/** 30x18, the idle pose with standing limbs. */
	bitmap: readonly string[];
	/** Top-left of the 3x3 eye cell (the a..i tokens). */
	eye: { x: number; y: number };
	/** The 5-cell mouth run (the m tokens); the jaw is the same 5 columns one row below. */
	mouth: { x: number; y: number };
	/** Run and jaw per mouth shape; the jaw replaces row mouth.y + 1, columns mouth.x .. mouth.x + 4. */
	mouths: Readonly<Record<MouthShape, { run: string; jaw: string }>>;
	/** The limb rectangle and its frames (h rows of w cells each). */
	limbs: { x: number; y: number; w: number; h: number; frames: Readonly<Record<LimbFrame, readonly string[]>> };
	/** 11x9 head mark; the 2x2 socket's pupil center in grid units. */
	mark: { rows: readonly string[]; pupil: { cx: number; cy: number } };
	/** 7x7 favicon head; W socket and K pupil are explicit. */
	favicon: readonly string[];
	/** Forgiving runner collision boxes, grid units from the sprite's top-left. */
	hitboxes: readonly { x: number; y: number; w: number; h: number }[];
	/** Five body stops, tail to head, with their names. */
	stops: readonly [string, string, string, string, string];
	stopNames: readonly [string, string, string, string, string];
	/** AA text variants of the stops on paper (#f9fbfa). */
	stopsDeep: readonly [string, string, string, string, string];
	/** The TUI's accents on Signal Night: user text, system text and the focused prompt border. */
	tui: { user: string; system: string; border: string };
	/** The theme accent on paper and on night (desktop and landing `--accent`). */
	accent: { light: Accent; dark: Accent };
}

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
] as const;

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
] as const;

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
] as const;

/** Four-legged, frill and three horns (S), a beaked snout. */
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
] as const;

/** The wing upstroke, shared by run-a and jump. */
const PTERO_WING_UP = [
	"......GG........",
	".....GGGG.......",
	".....GLGGG......",
	"......LLGGG.....",
	"......LLLGGG....",
	".......LLLGGG...",
	".......LLLLGGG..",
	"........LLLLGG..",
	"........LLLLLGG.",
	".........LLLLGG.",
	"..........LLLGG.",
	".........GGGGGGG",
	"........GGGLLLLL",
	".......GGGLLLLLL",
	".....GGGGGGGGGGG",
	"...GGG..GG...GG.",
	"................",
	"................",
] as const;

const slice = (rows: readonly string[], x: number, y: number, w: number, h: number): string[] =>
	rows.slice(y, y + h).map((row) => row.slice(x, x + w));

export const SPECIES: Readonly<Record<SpeciesId, Species>> = {
	rex: {
		id: "rex",
		name: { en: "T-rex", ko: "티라노" },
		theme: "Signal",
		bitmap: REX_BITMAP,
		eye: { x: 19, y: 2 },
		mouth: { x: 25, y: 6 },
		mouths: {
			line: { run: "DDDDD", jaw: "GGGG." },
			smile: { run: "PPPPP", jaw: "GGGG." },
			open: { run: "KPPPP", jaw: "GGGGG" },
			grimace: { run: "DD.DD", jaw: "GGDG." },
		},
		limbs: {
			x: 0,
			y: 13,
			w: 30,
			h: 5,
			frames: {
				stand: slice(REX_BITMAP, 0, 13, 30, 5),
				/** Back leg planted, front foot lifted one stride. */
				"run-a": [
					"........GGGGGGGGGGG...........",
					"........GGGG...GGGG...........",
					"........GGG...GGGGG...........",
					".......GGGG...................",
					"......GGGGG...................",
				],
				/** Front leg planted, back foot lifted. */
				"run-b": [
					"........GGGGGGGGGGG...........",
					"........GGGG...GGGG...........",
					"......GGGGG.....GGG...........",
					"...............GGGG...........",
					"..............GGGGG...........",
				],
				/** Both feet tucked up under the hips. */
				jump: [
					"........GGGGGGGGGGG...........",
					".......GGGGG...GGGGG..........",
					"......GGGGG...GGGGG...........",
					"..............................",
					"..............................",
				],
			},
		},
		mark: {
			rows: ["..GGGGGGG..", ".GGGGGGGGGG", ".GG..GGGGGG", ".GG..GGGGGG", ".GPPGGGGGGG", ".GGGGGGGD..", ".GGGGGGGGG.", "GGGGGG.....", "GGGG......."],
			pupil: { cx: 4, cy: 3 },
		},
		favicon: ["..GGGG.", ".GGGGGG", ".WWGGGG", ".WKGGGG", ".PGGGGG", "GGGG...", "GGGGGG."],
		hitboxes: [
			{ x: 17, y: 1, w: 11, h: 6 },
			{ x: 6, y: 7, w: 17, h: 6 },
			{ x: 8, y: 13, w: 11, h: 5 },
		],
		stops: ["#19ca9d", "#2db4b2", "#3da5c2", "#538eda", "#5d7cde"],
		stopNames: ["mint", "teal", "cyan", "blue", "indigo"],
		stopsDeep: ["#007650", "#007372", "#00718c", "#2f68b0", "#4661bd"],
		tui: { user: "#19CA9D", system: "#2DB4B2", border: "#2DB4B2" },
		accent: {
			light: { solid: "#19ca9d", deep: "#007650", tint: "#e7f8f1", soft: "#bcecd9" },
			dark: { solid: "#19ca9d", deep: "#6fdcbc", tint: "#15302a", soft: "#1f4a3f" },
		},
	},
	ptero: {
		id: "ptero",
		name: { en: "Pterodactyl", ko: "익룡" },
		theme: "Dusk",
		bitmap: PTERO_BITMAP,
		eye: { x: 20, y: 6 },
		mouth: { x: 25, y: 9 },
		mouths: {
			line: { run: "DDDDD", jaw: "GGGG." },
			smile: { run: "PPPPP", jaw: "GGGG." },
			open: { run: "KPPPP", jaw: "GGGGG" },
			grimace: { run: "DD.DD", jaw: "GGDG." },
		},
		limbs: {
			x: 0,
			y: 0,
			w: 16,
			h: 18,
			frames: {
				/** Gliding: the wing swept back in a shallow V. */
				stand: slice(PTERO_BITMAP, 0, 0, 16, 18),
				/** Upstroke. */
				"run-a": PTERO_WING_UP,
				/** Downstroke: the wing sweeps under the body. */
				"run-b": [
					"................",
					"................",
					"................",
					"................",
					"................",
					"................",
					"................",
					"................",
					"................",
					"................",
					"................",
					".........GGGGGGG",
					"........GGGLLLLL",
					".......GGGLLLLLL",
					".....GGGGGGGGGGG",
					"...GGGLLLLLLGG..",
					"...GLLLLLLGG....",
					"..GGGGGG........",
				],
				jump: PTERO_WING_UP,
			},
		},
		mark: {
			rows: ["SSS........", ".SSGGGG....", "..GGGGGGG..", "..GG..GGGG.", "..GG..GGGGG", "..GPGGGGDDD", "..GGGGGGGG.", "..GGGG.....", ".GGGG......"],
			pupil: { cx: 5, cy: 4 },
		},
		favicon: ["SS.....", ".SGGGG.", ".WWGGGG", ".WKGGGG", ".PGGGGG", "GGGG...", "GG....."],
		hitboxes: [
			{ x: 17, y: 4, w: 10, h: 7 },
			{ x: 6, y: 11, w: 13, h: 4 },
			{ x: 3, y: 2, w: 10, h: 8 },
		],
		stops: ["#f5b83d", "#f2894b", "#e8677f", "#c45ab3", "#8c5be0"],
		stopNames: ["sun", "peach", "rose", "orchid", "violet"],
		stopsDeep: ["#8a5d00", "#b04a0a", "#c2203f", "#a63894", "#7442cc"],
		tui: { user: "#F5B83D", system: "#F2894B", border: "#F2894B" },
		accent: {
			light: { solid: "#c45ab3", deep: "#a63894", tint: "#f9eff7", soft: "#edcee8" },
			dark: { solid: "#c45ab3", deep: "#e3a3d8", tint: "#342231", soft: "#492a44" },
		},
	},
	brachio: {
		id: "brachio",
		name: { en: "Brachiosaurus", ko: "브라키오사우루스" },
		theme: "Fern",
		bitmap: BRACHIO_BITMAP,
		eye: { x: 22, y: 1 },
		mouth: { x: 25, y: 4 },
		mouths: {
			line: { run: "DDDDD", jaw: "GGG.." },
			smile: { run: "PPPPP", jaw: "GGG.." },
			open: { run: "KPPPP", jaw: "GGGG." },
			grimace: { run: "DD.DD", jaw: "GDG.." },
		},
		limbs: {
			x: 0,
			y: 13,
			w: 30,
			h: 5,
			frames: {
				stand: slice(BRACHIO_BITMAP, 0, 13, 30, 5),
				"run-a": [
					"GGG..GGLLLLLLLLGGGG...........",
					".....GGG...GG...GGG...........",
					"....GGG....GG....GGG..........",
					"....GGG.....GG...GGG..........",
					"...GGGG.....GGG..GGGG.........",
				],
				"run-b": [
					"GGG..GGLLLLLLLLGGGG...........",
					"......GGG.GG...GGG............",
					".......GGGGG..GGG.............",
					".......GGGG...GGG.............",
					"......GGGGG..GGGG.............",
				],
				jump: [
					"GGG..GGLLLLLLLLGGGG...........",
					".....GGGG.GGG.GGGG............",
					"....GGGG..GGG.GGG.............",
					"..............................",
					"..............................",
				],
			},
		},
		mark: {
			rows: ["....GGGG...", "...GGGGGGG.", "...G..GGGGG", "...G..GGPGG", "...GGGGGDDD", "..GGGGGGGG.", ".GGGG......", ".GGG.......", "GGG........"],
			pupil: { cx: 5, cy: 3 },
		},
		favicon: ["..GGGG.", ".GGGGGG", ".WWGGGG", ".WKGPGG", ".GGGG..", "GGGG...", "GGG...."],
		hitboxes: [
			{ x: 21, y: 0, w: 8, h: 6 },
			{ x: 16, y: 5, w: 7, h: 5 },
			{ x: 4, y: 9, w: 15, h: 5 },
			{ x: 5, y: 14, w: 14, h: 4 },
		],
		stops: ["#c3d43a", "#8cc24c", "#55ad5e", "#2f9670", "#1f7f78"],
		stopNames: ["lime", "leaf", "fern", "moss", "pine"],
		stopsDeep: ["#5f6816", "#4d7026", "#367a3c", "#24755a", "#1f7470"],
		tui: { user: "#C3D43A", system: "#8CC24C", border: "#8CC24C" },
		accent: {
			light: { solid: "#8cc24c", deep: "#4d7026", tint: "#f4f9ed", soft: "#ddedc9" },
			dark: { solid: "#8cc24c", deep: "#b1d986", tint: "#2a351f", soft: "#384a26" },
		},
	},
	tricera: {
		id: "tricera",
		name: { en: "Triceratops", ko: "트리케라톱스" },
		theme: "Canyon",
		bitmap: TRICERA_BITMAP,
		eye: { x: 18, y: 5 },
		mouth: { x: 25, y: 9 },
		mouths: {
			line: { run: "DDDDD", jaw: "GGG.." },
			smile: { run: "PPPPP", jaw: "GGG.." },
			open: { run: "KPPPP", jaw: "GGGG." },
			grimace: { run: "DD.DD", jaw: "GDG.." },
		},
		limbs: {
			x: 0,
			y: 13,
			w: 30,
			h: 5,
			frames: {
				stand: slice(TRICERA_BITMAP, 0, 13, 30, 5),
				/** Outer feet reach forward and back. */
				"run-a": [
					".......GGGGGGGGGGGGGGG........",
					"......GGGG...GGG...GGGG.......",
					".....GGGG....GGG....GGGG......",
					".....GGGG...........GGGG......",
					"....GGGGG..........GGGGG......",
				],
				/** Feet gather under the body. */
				"run-b": [
					".......GGGGGGGGGGGGGGG........",
					".......GGGG..GGG..GGGG........",
					"........GGGG.GGG.GGGG.........",
					".........GGGG...GGGG..........",
					"........GGGGG..GGGGG..........",
				],
				/** All four feet tucked up. */
				jump: [
					".......GGGGGGGGGGGGGGG........",
					"......GGGGG..GGGG.GGGGG.......",
					".....GGGGG...GGGG..GGGGG......",
					"..............................",
					"..............................",
				],
			},
		},
		mark: {
			rows: ["..SS.......", ".SSGGG.....", "SSGGGGG..S.", "SGGGGGGGSS.", ".GGG..GGGGS", ".GGG..GGGG.", ".GGPPGGDDD.", "..GGGGGGGG.", "...GGGG...."],
			pupil: { cx: 5, cy: 5 },
		},
		favicon: [".SS....", "SGGGGS.", "GWWGGGS", "GWKGGGG", ".PGGGGG", "..GGGG.", "..G..G."],
		hitboxes: [
			{ x: 17, y: 3, w: 11, h: 6 },
			{ x: 6, y: 8, w: 17, h: 5 },
			{ x: 7, y: 13, w: 15, h: 5 },
		],
		stops: ["#f0b43c", "#ea9238", "#de6f3a", "#c95343", "#a84452"],
		stopNames: ["sand", "ochre", "clay", "terracotta", "garnet"],
		stopsDeep: ["#825c00", "#9c4e00", "#b03d07", "#a52b1c", "#8e2737"],
		tui: { user: "#F0B43C", system: "#EA9238", border: "#EA9238" },
		accent: {
			light: { solid: "#de6f3a", deep: "#a83800", tint: "#fcf1eb", soft: "#f5d5c4" },
			dark: { solid: "#de6f3a", deep: "#f7b392", tint: "#36231a", soft: "#4d2f21" },
		},
	},
};

export const speciesOf = (id: SpeciesId | undefined): Species => SPECIES[id ?? DEFAULT_SPECIES];
