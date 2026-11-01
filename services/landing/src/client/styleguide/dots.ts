/**
 * Dot renderers for the /design/ style guide. The T-rex comes from the canonical brand module
 * (src/brand/mascot.ts: poseSprite + spriteDots, docs/assets.md section 5), so the specimen is exactly the production
 * mascot. Glyphs are 5x5 dot grids. Dot colors are SVG fill attributes (presentation attributes, CSP-safe).
 */
import { EYE_CELL, type PoseName, type SpeciesId, type Sprite, poseSprite, spriteDots } from "../../brand/mascot.ts";

export type DinoState = "idle" | "done" | "failed";

const SVG = "http://www.w3.org/2000/svg";

function el<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
	const node = document.createElementNS(SVG, name);
	for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
	return node;
}

export interface DinoOptions {
	state?: DinoState;
	/** Draw the unlit cells of the 30x18 matrix as faint dots (LED panel look). */
	unlit?: boolean;
	/** Dot diameter as a fraction of the pitch. */
	fill?: number;
	label?: string;
	/** "head": crop the viewBox to the head (columns 16-29, rows 0-7, whole dots) and outline the 3x3 eye cell. */
	crop?: "head";
	/** Any pose of src/brand/mascot.ts (overrides `state`). */
	pose?: PoseName;
	/** Which dinosaur (ADR 0100); the T-rex when omitted. */
	species?: SpeciesId;
}

/**
 * The head crop on whole dots (docs/assets.md section 5): columns 16-29 and rows 0-7. Dot centers sit at cell + 0.5, so
 * the crop runs along the cell edges (x 16-30, y 0-8); with any fill below 1 no neighbor dot (column 15, row 8) shows.
 */
export const DINO_HEAD_VIEWBOX = "16 0 14 8";
export const DINO_EYE_CELL = EYE_CELL;

/** Renders the canonical T-rex as an SVG of round dots in a 30x18 viewBox (one unit per cell). */
export function renderDino(options: DinoOptions = {}): SVGSVGElement {
	const { state = "idle", unlit = false, fill = 0.74, label, crop, pose, species } = options;
	const svg = renderSprite(poseSprite(pose ?? state, undefined, species), { fill, unlit, label, viewBox: crop === "head" ? DINO_HEAD_VIEWBOX : undefined });
	svg.setAttribute("class", crop === "head" ? "dino dino--head" : "dino");
	if (crop === "head") {
		const { x, y, size } = DINO_EYE_CELL;
		svg.append(el("rect", { x: x - 0.06, y: y - 0.06, width: size + 0.12, height: size + 0.12, rx: 0.5, class: "dino__eye-frame" }));
	}
	return svg;
}

/** Any sprite (mascot pose, mark, favicon) as round dots, one viewBox unit per cell; "square" for the favicon. */
export function renderSprite(sprite: Sprite, options: { fill?: number; unlit?: boolean; label?: string; viewBox?: string; shape?: "dot" | "square" } = {}): SVGSVGElement {
	const { fill = 0.74, unlit = false, label, viewBox, shape = "dot" } = options;
	const svg = el("svg", { viewBox: viewBox ?? `0 0 ${sprite.cols} ${sprite.rows.length}`, class: "dino" });
	if (label) {
		svg.setAttribute("role", "img");
		svg.setAttribute("aria-label", label);
	} else svg.setAttribute("aria-hidden", "true");
	for (const d of spriteDots(sprite, { fill, unlit })) {
		if (shape === "square" && d.part !== "pupil" && d.part !== "glint") {
			svg.append(el("rect", { x: d.cx - d.r, y: d.cy - d.r, width: d.r * 2, height: d.r * 2, rx: d.r * 0.44, fill: d.fill }));
			continue;
		}
		const c = el("circle", { cx: d.cx, cy: d.cy, r: d.r, fill: d.fill });
		if (d.part !== "unlit" && d.part !== "pupil" && d.part !== "glint") {
			c.dataset.x = String(d.x);
			c.dataset.y = String(d.y);
		}
		svg.append(c);
	}
	return svg;
}

/** 5x5 dot glyphs on the mascot's grid ('#' lit). Names are used as data-glyph values. */
export const GLYPHS: Record<string, readonly string[]> = {
	chat: ["#####", "#...#", "#...#", "#####", ".#..."],
	terminal: ["#....", ".#...", "#....", ".....", "..###"],
	laptop: ["#####", "#...#", "#####", ".....", "#####"],
	window: ["##.##", "##.##", ".....", "##.##", "##.##"],
	api: [".#.#.", "#...#", "#...#", "#...#", ".#.#."],
	search: [".##..", "#..#.", "#..#.", ".##..", "....#"],
	branch: ["#...#", "#...#", "#..#.", "#.#..", "#...."],
	plug: [".#.#.", ".#.#.", "#####", ".###.", "..#.."],
	cursor: ["#....", "##...", "###..", "##...", "..#.."],
	check: [".....", "....#", "...#.", "#.#..", ".#..."],
	cross: ["#...#", ".#.#.", "..#..", ".#.#.", "#...#"],
	plan: ["#....", "#.#..", "#####", "..#.#", "....#"],
	memory: ["#####", ".....", "#####", ".....", "#####"],
	assign: ["#....", ".#...", "..###", ".#...", "#...."],
	learn: ["....#", "...##", "..###", ".####", "#####"],
	ask: [".###.", "#...#", "...#.", "..#..", "..#.."],
	// 7x7 bento glyphs (BRIEF 12b.6): one stroke weight, one meaning each.
	"b-check": [".......", "......#", ".....#.", "#...#..", ".#.#...", "..#....", "......."],
	"b-ask": ["..###..", ".#...#.", ".....#.", "....#..", "...#...", ".......", "...#..."],
	"b-target": ["..###..", ".#...#.", "#.....#", "#..#..#", "#.....#", ".#...#.", "..###.."],
	"b-tools": [".......", ".#.....", "..#....", "...#...", "..#....", ".#..###", "......."],
	"b-threads": ["#####..", "#...#..", "#####..", ".#.....", "..#####", "..#...#", "..#####"],
	"b-code": [".##.##.", ".#...#.", ".#...#.", "#.....#", ".#...#.", ".#...#.", ".##.##."],
	"b-data": [".#####.", "#.....#", "#######", "#.....#", "#######", "#.....#", ".#####."],
};

export function renderGlyph(name: string, label?: string): SVGSVGElement {
	const rows = GLYPHS[name] ?? GLYPHS.chat ?? [];
	const n = rows.length || 5;
	const svg = el("svg", { viewBox: `0 0 ${n} ${n}`, class: "glyph" });
	if (label) {
		svg.setAttribute("role", "img");
		svg.setAttribute("aria-label", label);
	} else svg.setAttribute("aria-hidden", "true");
	rows.forEach((row, y) => {
		[...row].forEach((ch, x) => {
			if (ch === "#") svg.append(el("circle", { cx: x + 0.5, cy: y + 0.5, r: n === 7 ? 0.41 : 0.36 }));
		});
	});
	return svg;
}
