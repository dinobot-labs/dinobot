/**
 * The dinobot T-rex: canonical data and a pure renderer (no DOM). Used by the mounted mascot
 * (src/client/mascot), the runner sprites (src/brand/runner-sprites.ts), the build-time assets
 * (scripts/build-assets.mjs) and, after integration, the /design/ style guide.
 *
 * Grid: the 30x18 MASCOT_BITMAP of src/tui/mascot.ts (ADR 0027), verbatim, same tokens. On the web every cell is a
 * round dot (never a square pixel, except the tiny favicon). Body dots take the solid of their column's stop,
 * quantized tail (mint) to head (indigo); ridge, belly and mouth use the TUI's derived tints; the cheek is red.
 *
 * Poses only swap three regions of the same grid: the 3x3 eye cell (columns 19-21, rows 2-4), the mouth run
 * (columns 25-29, row 6, plus the jaw row below it for the open mouth) and the legs (rows 13-17).
 * The open eye is not a 3x3 block: the cell becomes a paper socket holding one large ink pupil with a white glint,
 * which reads as an eye at every size and can look around by moving the pupil.
 */

import { CHEEK, INK, STOPS, STOP_NAMES, UNLIT, WHITE, stopIndex, tintsOf } from "./palette.ts";
import { DEFAULT_SPECIES, type LimbFrame, type MouthShape, SPECIES, type SpeciesId, speciesOf } from "./species.ts";

export const MASCOT_COLS = 30;
export const MASCOT_ROWS = 18;

/** Facing right. G body, D dark, S ridge, L belly, P cheek, a..i the 3x3 eye cell, m the mouth run, '.' empty. The T-rex (src/brand/species.ts). */
export const MASCOT_BITMAP: readonly string[] = SPECIES.rex.bitmap;

/** The TUI's three states (src/tui/mascot.ts MASCOT_EYES), kept for reference and parity tests. */
export const TUI_EYES = {
	idle: { cell: "..W......", mouth: "D" },
	done: { cell: "G.G.G.GGG", mouth: "P" },
	failed: { cell: ".G.G.G.G.", mouth: "D" },
} as const;

/** The T-rex regions; other species carry their own (`eyeCellOf`, `mouthRunOf`, `limbRectOf`). */
export const EYE_CELL = { x: 19, y: 2, size: 3 } as const;
export const MOUTH_RUN = { x: 25, y: 6, length: 5 } as const;
/** The first leg row; LEGS replace rows 13-17. */
export const LEG_ROW = 13;

export const eyeCellOf = (species: SpeciesId = DEFAULT_SPECIES) => ({ ...SPECIES[species].eye, size: 3 }) as const;
export const mouthRunOf = (species: SpeciesId = DEFAULT_SPECIES) => ({ ...SPECIES[species].mouth, length: 5 }) as const;
export const limbRectOf = (species: SpeciesId = DEFAULT_SPECIES) => {
	const { x, y, w, h } = SPECIES[species].limbs;
	return { x, y, w, h } as const;
};

/**
 * Resolved tokens: G body, S ridge, L belly, P cheek (red), D mouth (dark tint), K ink, W white, '.' empty (paper).
 */
export type Token = "G" | "S" | "L" | "P" | "D" | "K" | "W" | ".";

/** The T-rex leg rows 13-17 per limb frame (src/brand/species.ts). */
export const LEGS: Readonly<Record<LimbFrame, readonly string[]>> = SPECIES.rex.limbs.frames;
export type LegsName = LimbFrame;

/** Pupil position inside the socket, in grid units from the cell center (|d| <= PUPIL_TRAVEL). */
export interface PupilOffset {
	dx: number;
	dy: number;
}

export const PUPIL_RADIUS = 1.02;
export const PUPIL_TRAVEL = 0.42;
export const GLINT_RADIUS = 0.32;
/** Radius of ink stroke dots (closed eyes, open mouth); bridged dots at half steps make them read as strokes. */
export const STROKE_RADIUS = 0.42;

/**
 * Eye cell per eye shape (row-major 3x3): G body, K ink, W white, '.' paper. `pupil` draws the large ink pupil with
 * a glint inside the paper socket.
 */
export const EYES = {
	open: { cell: ".........", pupil: { dx: 0, dy: 0 } },
	forward: { cell: ".........", pupil: { dx: PUPIL_TRAVEL, dy: 0 } },
	up: { cell: ".........", pupil: { dx: 0.12, dy: -PUPIL_TRAVEL } },
	down: { cell: ".........", pupil: { dx: 0.12, dy: PUPIL_TRAVEL } },
	/** Lid closed: one ink row across the middle of the cell. */
	blink: { cell: "GGGKKKGGG", pupil: null },
	/** Happy closed arc (^). */
	arc: { cell: "GKGKGKGGG", pupil: null },
	/** Knocked out (X). */
	cross: { cell: "KGKGKGKGK", pupil: null },
} as const satisfies Record<string, { cell: string; pupil: PupilOffset | null }>;
export type EyeName = keyof typeof EYES;

/** The T-rex mouth run (columns 25-29 of row 6) and the jaw row below it; each species has its own (species.ts). */
export const MOUTHS: Readonly<Record<MouthShape, { run: string; jaw: string }>> = SPECIES.rex.mouths;
export type MouthName = MouthShape;

export interface PoseSpec {
	eye: EyeName;
	mouth: MouthName;
	legs: LegsName;
}

/** Every pose on the 30x18 grid. idle / done / failed are the TUI states; the rest are new for the web. */
export const POSES = {
	idle: { eye: "open", mouth: "line", legs: "stand" },
	done: { eye: "arc", mouth: "smile", legs: "stand" },
	failed: { eye: "cross", mouth: "grimace", legs: "stand" },
	blink: { eye: "blink", mouth: "line", legs: "stand" },
	"look-up": { eye: "up", mouth: "line", legs: "stand" },
	"look-down": { eye: "down", mouth: "line", legs: "stand" },
	"look-forward": { eye: "forward", mouth: "line", legs: "stand" },
	happy: { eye: "arc", mouth: "open", legs: "stand" },
	"run-a": { eye: "forward", mouth: "line", legs: "run-a" },
	"run-b": { eye: "forward", mouth: "line", legs: "run-b" },
	jump: { eye: "up", mouth: "open", legs: "jump" },
} as const satisfies Record<string, PoseSpec>;
export type PoseName = keyof typeof POSES;
export const POSE_NAMES = Object.keys(POSES) as PoseName[];
export const STATE_NAMES = ["idle", "done", "failed"] as const;

/** A resolved sprite: rows of tokens plus an optional pupil (center and radius in grid units) and its species colors. */
export interface Sprite {
	cols: number;
	rows: readonly string[];
	pupil: { cx: number; cy: number; r: number } | null;
	/** Whose body stops color the dots; the T-rex when absent. */
	species?: SpeciesId;
}

/**
 * Resolve a pose (or an explicit spec) of a species to a sprite on the 30x18 grid. `look` overrides the pupil offset.
 * Only the eye cell, the mouth run plus jaw and the limb rectangle change between poses.
 */
export function poseSprite(pose: PoseName | PoseSpec, look?: PupilOffset, species: SpeciesId = DEFAULT_SPECIES): Sprite {
	const spec: PoseSpec = typeof pose === "string" ? POSES[pose] : pose;
	const kind = speciesOf(species);
	const eye = EYES[spec.eye];
	const mouth = kind.mouths[spec.mouth];
	const limbs = kind.limbs;
	const frame = limbs.frames[spec.legs];
	const rows: string[] = [];
	for (let y = 0; y < MASCOT_ROWS; y++) {
		const source = kind.bitmap[y] ?? "";
		let row = "";
		for (let x = 0; x < MASCOT_COLS; x++) {
			const inLimbs = x >= limbs.x && x < limbs.x + limbs.w && y >= limbs.y && y < limbs.y + limbs.h;
			let token = inLimbs ? (frame[y - limbs.y]?.[x - limbs.x] ?? ".") : (source[x] ?? ".");
			if (token >= "a" && token <= "i") token = eye.cell[token.charCodeAt(0) - 97] ?? ".";
			else if (token === "m") token = mouth.run[x - kind.mouth.x] ?? ".";
			else if (y === kind.mouth.y + 1 && x >= kind.mouth.x && x < kind.mouth.x + 5) token = mouth.jaw[x - kind.mouth.x] ?? ".";
			row += token;
		}
		rows.push(row);
	}
	const offset = eye.pupil === null ? null : (look ?? eye.pupil);
	const pupil =
		offset === null
			? null
			: {
					cx: kind.eye.x + 1.5 + clamp(offset.dx, -PUPIL_TRAVEL, PUPIL_TRAVEL),
					cy: kind.eye.y + 1.5 + clamp(offset.dy, -PUPIL_TRAVEL, PUPIL_TRAVEL),
					r: PUPIL_RADIUS,
				};
	return { cols: MASCOT_COLS, rows, pupil, species: kind.id };
}

/**
 * The compact mark (head and neck) for the favicon, the nav logo and lockups. 11x9 on its own grid, same tokens;
 * the eye is a 2x2 paper socket with the pupil. Stops are quantized across the mark's own columns.
 */
export const MARK_BITMAP: readonly string[] = SPECIES.rex.mark.rows;
export const MARK_COLS = 11;
export const MARK_ROWS = 9;

export function markSprite(species: SpeciesId = DEFAULT_SPECIES): Sprite {
	const { rows, pupil } = SPECIES[species].mark;
	return { cols: MARK_COLS, rows, pupil: { ...pupil, r: 0.8 }, species };
}

/**
 * The favicon head: 7x7 cells drawn as rounded squares on an ink tile, 2 px per cell at 16 px (4 px at 32 px).
 * The eye is a white 2x2 with the ink pupil in its front lower cell (looking ahead); the mouth is a gap to the tile.
 */
export const FAVICON_BITMAP: readonly string[] = SPECIES.rex.favicon;
export const FAVICON_CELLS = 7;

export function faviconSprite(species: SpeciesId = DEFAULT_SPECIES): Sprite {
	return { cols: FAVICON_CELLS, rows: SPECIES[species].favicon, pupil: null, species };
}

/** Pure: the favicon SVG (viewBox 0 0 16 16): an ink rounded tile and the 7x7 head at 2 units per cell, offset 1. */
export function renderFaviconSvg(species: SpeciesId = DEFAULT_SPECIES): string {
	const dots = spriteDots(faviconSprite(species), { fill: 1 }).map((d) => ({ ...d, cx: 1 + d.cx * 2, cy: 1 + d.cy * 2, r: d.r * 2 }));
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3.5" fill="${INK}"/>${dotsToSvgBody(dots, "square")}</svg>`;
}

// ---------------------------------------------------------------- dots

export type Palette = "color" | "ink" | "mint" | "white";
export type DotPart = "body" | "ridge" | "belly" | "cheek" | "mouth" | "ink" | "white" | "pupil" | "glint" | "unlit";

export interface Dot {
	/** Grid cell (integers); the pupil and glint carry their continuous position. */
	x: number;
	y: number;
	cx: number;
	cy: number;
	r: number;
	fill: string;
	part: DotPart;
}

export interface DotOptions {
	palette?: Palette;
	/** Dot diameter as a fraction of the pitch (0.74 default: round dots with a visible gap). */
	fill?: number;
	/** Also emit the empty cells as faint dots (LED panel look). */
	unlit?: boolean;
}

const MONO: Record<Exclude<Palette, "color">, string> = { ink: INK, mint: "#007650", white: WHITE };

/** The solid fill and part of one resolved token at column x of a sprite `cols` wide, or null when empty. */
export function tokenFill(token: string, x: number, cols: number, palette: Palette = "color", species: SpeciesId = DEFAULT_SPECIES): { fill: string; part: DotPart } | null {
	if (token === ".") return null;
	if (palette !== "color") {
		const mono = MONO[palette];
		// One color: the ink details become holes so they still read (eye shapes, the mouth line).
		if (token === "K" || token === "D" || token === "W") return null;
		return { fill: mono, part: token === "P" ? "cheek" : "body" };
	}
	const tints = tintsOf(species);
	const tint = tints[stopIndex(x, cols)] ?? tints[0];
	if (tint === undefined) return null;
	switch (token) {
		case "S":
			return { fill: tint.ridge, part: "ridge" };
		case "L":
			return { fill: tint.belly, part: "belly" };
		case "D":
			return { fill: tint.mouth, part: "mouth" };
		case "P":
			return { fill: CHEEK, part: "cheek" };
		case "K":
			return { fill: INK, part: "ink" };
		case "W":
			return { fill: WHITE, part: "white" };
		default:
			return { fill: tint.body, part: "body" };
	}
}

/** Pure: the dots of a sprite, row-major, then the pupil and its glint (drawn last, on top). */
export function spriteDots(sprite: Sprite, options: DotOptions = {}): Dot[] {
	const { palette = "color", fill = 0.74, unlit = false } = options;
	const r = fill / 2;
	const dots: Dot[] = [];
	const strokes: Dot[] = [];
	sprite.rows.forEach((row, y) => {
		for (let x = 0; x < sprite.cols; x++) {
			const resolved = tokenFill(row[x] ?? ".", x, sprite.cols, palette, sprite.species);
			if (resolved?.part === "ink") {
				// Ink features (closed eyes, the open mouth) are strokes: fuller dots, bridged to their ink neighbours
				// (right, down, both diagonals) so an arc or an X reads as one mark instead of loose dice dots.
				const ink = { fill: resolved.fill, part: resolved.part, r: STROKE_RADIUS };
				strokes.push({ x, y, cx: x + 0.5, cy: y + 0.5, ...ink });
				for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [-1, 1]] as const) {
					if (sprite.rows[y + dy]?.[x + dx] === "K") strokes.push({ x, y, cx: x + 0.5 + dx / 2, cy: y + 0.5 + dy / 2, ...ink });
				}
			} else if (resolved) dots.push({ x, y, cx: x + 0.5, cy: y + 0.5, r, ...resolved });
			else if (unlit && !inSocket(sprite, x, y)) dots.push({ x, y, cx: x + 0.5, cy: y + 0.5, r: r * 0.62, fill: UNLIT, part: "unlit" });
		}
	});
	dots.push(...strokes, ...pupilDots(sprite, palette));
	return dots;
}

/** The pupil (ink, or the mono color) and its white glint, up and toward the face. */
export function pupilDots(sprite: Sprite, palette: Palette = "color"): Dot[] {
	const p = sprite.pupil;
	if (!p) return [];
	const ink = palette === "color" ? INK : MONO[palette];
	const g = (GLINT_RADIUS * p.r) / PUPIL_RADIUS;
	const k = p.r * 0.36;
	return [
		{ x: Math.floor(p.cx), y: Math.floor(p.cy), cx: p.cx, cy: p.cy, r: p.r, fill: ink, part: "pupil" },
		{ x: Math.floor(p.cx), y: Math.floor(p.cy), cx: p.cx + k, cy: p.cy - k, r: g, fill: palette === "white" ? INK : WHITE, part: "glint" },
	];
}

function inSocket(sprite: Sprite, x: number, y: number): boolean {
	const p = sprite.pupil;
	return p !== null && Math.abs(x + 0.5 - p.cx) < 1.6 && Math.abs(y + 0.5 - p.cy) < 1.6;
}

// ---------------------------------------------------------------- SVG

export interface SvgOptions extends DotOptions {
	/** Accessible name; the SVG is decorative (aria-hidden) when omitted. */
	title?: string;
	/** Rendered width attribute (CSS px); height follows the grid. Omit for a fluid SVG. */
	width?: number;
	/** "square": rounded squares instead of dots, only for sprites drawn a few px per cell (favicon). */
	shape?: "dot" | "square";
	/** Extra padding around the grid, in grid units. */
	pad?: number;
	className?: string;
}

const round = (n: number) => Number(n.toFixed(3)).toString();

/** Pure: SVG markup for a set of dots, grouped by fill (one <g fill> per color keeps it small and CSP-safe). */
export function dotsToSvgBody(dots: readonly Dot[], shape: "dot" | "square" = "dot"): string {
	let out = "";
	let open = "";
	for (const d of dots) {
		if (d.fill !== open) {
			if (open) out += "</g>";
			out += `<g fill="${d.fill}">`;
			open = d.fill;
		}
		if (shape === "square" && d.part !== "pupil" && d.part !== "glint") {
			const s = d.r * 2;
			out += `<rect x="${round(d.cx - d.r)}" y="${round(d.cy - d.r)}" width="${round(s)}" height="${round(s)}" rx="${round(s * 0.22)}"/>`;
		} else out += `<circle cx="${round(d.cx)}" cy="${round(d.cy)}" r="${round(d.r)}"/>`;
	}
	if (open) out += "</g>";
	return out;
}

export function spriteToSvg(sprite: Sprite, options: SvgOptions = {}): string {
	const { title, width, shape = "dot", pad = 0, className } = options;
	const rowsCount = sprite.rows.length;
	const w = sprite.cols + pad * 2;
	const h = rowsCount + pad * 2;
	const attrs = [
		`xmlns="http://www.w3.org/2000/svg"`,
		`viewBox="${round(-pad)} ${round(-pad)} ${round(w)} ${round(h)}"`,
		width ? `width="${width}" height="${round((width * h) / w)}"` : "",
		className ? `class="${className}"` : "",
		title ? `role="img" aria-label="${escapeXml(title)}"` : `aria-hidden="true"`,
	].filter(Boolean);
	const body = dotsToSvgBody(spriteDots(sprite, options), shape);
	return `<svg ${attrs.join(" ")}>${title ? `<title>${escapeXml(title)}</title>` : ""}${body}</svg>`;
}

/** Pure: the mascot in a pose as an SVG string (viewBox 0 0 30 18, one unit per cell). */
export function renderMascotSvg(pose: PoseName = "idle", options: SvgOptions & { look?: PupilOffset; species?: SpeciesId } = {}): string {
	return spriteToSvg(poseSprite(pose, options.look, options.species), options);
}

/** Pure: the compact head mark as an SVG string (viewBox 0 0 9 9). */
export function renderMarkSvg(options: SvgOptions & { species?: SpeciesId } = {}): string {
	return spriteToSvg(markSprite(options.species), options);
}

export function escapeXml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function clamp(v: number, lo: number, hi: number): number {
	return v < lo ? lo : v > hi ? hi : v;
}

export { STOPS, STOP_NAMES };
export { DEFAULT_SPECIES, SPECIES, SPECIES_IDS, isSpeciesId, speciesOf, type SpeciesId, type Species } from "./species.ts";
