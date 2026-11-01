/**
 * Dot grids for the bottom runner bar (BRIEF 7). Pure data; sizes are in grid units (one dot per unit), so the runner
 * picks a pitch (about 1-1.25 CSS px per unit in a 48-56 px bar puts the dino at 18-23 px tall) and pre-renders each
 * frame once to an offscreen canvas (round dots, `arc`), then `drawImage`s it.
 *
 * The dino frames are the mascot poses from ./mascot.ts (same 30x18 grid and colors). Obstacles are ink with at
 * most one signal color: '#' ink, 'o' the obstacle's signal (see `signal`), '.' empty. All obstacles stand on the
 * ground line (their last row touches it).
 */
import { type Dot, type PoseName, type Sprite, poseSprite, spriteDots } from "./mascot.ts";
import { CHEEK, INK, STOPS } from "./palette.ts";
import { DEFAULT_SPECIES, SPECIES, type SpeciesId } from "./species.ts";

export type RunnerDinoFrame = "run-a" | "run-b" | "jump" | "failed" | "done";

/** Runner frame -> mascot pose. "done" uses the laughing face (celebrate after a waitlist signup). */
export const RUNNER_DINO_POSES: Readonly<Record<RunnerDinoFrame, PoseName>> = {
	"run-a": "run-a",
	"run-b": "run-b",
	jump: "jump",
	failed: "failed",
	done: "happy",
};

export const RUNNER_DINO_SIZE = { cols: 30, rows: 18 } as const;

export function runnerDinoSprite(frame: RunnerDinoFrame, species: SpeciesId = DEFAULT_SPECIES): Sprite {
	return poseSprite(RUNNER_DINO_POSES[frame], undefined, species);
}

/** Colored dots of a dino frame (same output as the mascot renderer; `fill` is the dot diameter / pitch). */
export function runnerDinoDots(frame: RunnerDinoFrame, fill = 0.8, species: SpeciesId = DEFAULT_SPECIES): Dot[] {
	return spriteDots(runnerDinoSprite(frame, species), { fill });
}

/**
 * Forgiving collision boxes for the standing/running dino in grid units (x, y from the sprite's top-left), like
 * Chrome's per-sprite boxes: the head, the torso and the legs, not the tail tip or the snout corners.
 */
export const RUNNER_DINO_HITBOXES: readonly { x: number; y: number; w: number; h: number }[] = SPECIES.rex.hitboxes;

/** The collision boxes of any species (src/brand/species.ts). */
export const runnerHitboxes = (species: SpeciesId = DEFAULT_SPECIES): readonly { x: number; y: number; w: number; h: number }[] => SPECIES[species].hitboxes;

export type ObstacleName = "cactus" | "bug" | "error" | "timeout";

export interface ObstacleSprite {
	name: ObstacleName;
	cols: number;
	rows: readonly string[];
	/** The one signal color used by 'o' dots (a solid from tokens.css). */
	signal: { name: string; color: string };
	/** Accessible/debug label. */
	label: string;
}

function obstacle(name: ObstacleName, label: string, signal: { name: string; color: string }, rows: readonly string[]): ObstacleSprite {
	return { name, label, signal, rows, cols: rows[0]?.length ?? 0 };
}

export const OBSTACLES: Readonly<Record<ObstacleName, ObstacleSprite>> = {
	/** Homage to the Chrome cactus: a two-armed saguaro with one mint bloom. */
	cactus: obstacle("cactus", "cactus", { name: "mint", color: STOPS.mint }, [
		"....o....",
		"...###...",
		"...###...",
		"...###.##",
		"##.###.##",
		"##.###.##",
		"##.######",
		"##.#####.",
		"######...",
		".#####...",
		"...###...",
		"...###...",
		"...###...",
		"...###...",
	]),
	/** A software bug: round shell with a seam, antennae, six legs and red eyes. */
	bug: obstacle("bug", "bug", { name: "red", color: CHEEK }, [
		"..#.....#..",
		"...#...#...",
		"...o###o...",
		"#.#######.#",
		".####.####.",
		"#.###.###.#",
		".####.####.",
		"#..#####..#",
	]),
	/** An error block: an ink frame with a red "!" inside. */
	error: obstacle("error", "error block", { name: "red", color: CHEEK }, [
		"########",
		"#......#",
		"#..oo..#",
		"#..oo..#",
		"#..oo..#",
		"#......#",
		"#..oo..#",
		"########",
	]),
	/** A timeout: an hourglass running out, sand in blue. */
	timeout: obstacle("timeout", "timeout hourglass", { name: "blue", color: STOPS.blue }, [
		"#######",
		".#ooo#.",
		".#ooo#.",
		"..#o#..",
		"...#...",
		"..#.#..",
		".#.o.#.",
		".#ooo#.",
		"#######",
	]),
};

export const OBSTACLE_NAMES = Object.keys(OBSTACLES) as ObstacleName[];

/** Colored dots of an obstacle ('#' ink, 'o' its signal). */
export function obstacleDots(name: ObstacleName, fill = 0.8): Dot[] {
	const sprite = OBSTACLES[name];
	const r = fill / 2;
	const dots: Dot[] = [];
	sprite.rows.forEach((row, y) => {
		for (let x = 0; x < sprite.cols; x++) {
			const ch = row[x];
			if (ch === "#") dots.push({ x, y, cx: x + 0.5, cy: y + 0.5, r, fill: INK, part: "ink" });
			else if (ch === "o") dots.push({ x, y, cx: x + 0.5, cy: y + 0.5, r, fill: sprite.signal.color, part: "body" });
		}
	});
	return dots;
}

/**
 * Ground: a horizontally repeating tile, 32 units wide. Row 0 is the ground line the dino's feet and the obstacles
 * stand on (a continuous row of dots); rows 2-3 are sparse pebbles in a lighter ink (`GROUND_PEBBLE`).
 */
export const GROUND_TILE: readonly string[] = [
	"################################",
	"................................",
	"..#.........#...#.......##......",
	"......#..#...........#.........#",
];
export const GROUND_LINE_COLOR = INK;
/** --n-7: pebbles stay quiet so the obstacles carry the contrast. */
export const GROUND_PEBBLE = "#a9aeac";
