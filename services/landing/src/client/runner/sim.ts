/**
 * Runner simulation (BRIEF 7): pure, deterministic, DOM-free and allocation-free after `createSim`.
 *
 * Units: one unit = one dot of the sprite grid (the dino is 30x18 units). Heights are measured up from the ground line.
 * Time: seconds; the world advances in fixed steps of `STEP` (1/240 s) through `advance`, so the game feels the same at
 * 60, 120 or 240 Hz (the Chrome original ramps per rendered frame; we do not).
 *
 * Physics (Chrome T-Rex homage, docs/references/b.md B10): a full jump lasts `AIRTIME` 545 ms like the original's
 * measured 540-550 ms. The apex is scaled to our sprites: the original clears its tallest cactus (50 px) with an 84 px
 * apex, 1.68x; ours clears the 14-row cactus with 18 units (1.29x, lower so the dino can be drawn larger in the 64 px bar, BRIEF 12b.4). Horizontal speed never changes in mid-air (no ground
 * to push off), so every jump is a symmetric parabola at one speed, which is what makes the planner provable.
 *
 * Fairness: every obstacle carries `vfair`, the highest speed its gap was spawned for. The gap between obstacle
 * centers is at least `FAIR_MARGIN * vfair * AIRTIME` (a centered jump spans `speed * AIRTIME`), and the ground speed is
 * clamped to the lowest `vfair` still ahead, so a scroll sprint can never outrun the course it is running on.
 */
import { OBSTACLE_NAMES, OBSTACLES, RUNNER_DINO_HITBOXES, RUNNER_DINO_SIZE } from "../../brand/runner-sprites.ts";

// ---------------------------------------------------------------- constants

export const STEP = 1 / 240;
export const AIRTIME = 0.545;
export const APEX = 18;
/** Exact kinematics: apex = v0^2 / 2g, airtime = 2 v0 / g. */
export const JUMP_VELOCITY = (4 * APEX) / AIRTIME;
export const GRAVITY = (8 * APEX) / (AIRTIME * AIRTIME);
/** The second impulse of `celebrate()` (a double jump), as a fraction of the jump velocity. */
export const DOUBLE_JUMP = 0.8;
export const DOUBLE_JUMP_DELAY = 0.24;

export const DINO_W = RUNNER_DINO_SIZE.cols;
export const DINO_H = RUNNER_DINO_SIZE.rows;

/** Cruising speed, units/s (about 8 dino heights per second, as Chrome's 360 px/s start for a 47 px dino). */
export const CRUISE = 150;
/** Auto mode: scrolling multiplies the cruise speed up to this factor. */
export const BOOST_MAX = 2.4;
export const MAX_SPEED = CRUISE * BOOST_MAX;
/** Play mode: speed ramps from CRUISE to PLAY_MAX in (PLAY_MAX - CRUISE) / PLAY_RAMP = 100 s (time-based). */
export const PLAY_MAX = CRUISE * 1.8;
export const PLAY_RAMP = 1.2;
/** Ground speed easing toward its target (time constants in seconds): sprint fast, settle slowly. */
export const SPEED_RISE_TAU = 0.15;
export const SPEED_FALL_TAU = 0.8;

export const FAIR_MARGIN = 1.25;
/** Gaps are random in [1, 1 + GAP_SPREAD] x the fair minimum. */
export const GAP_SPREAD = 0.7;
/** No obstacles closer than this to the dino after a (re)start (Chrome's 3 s clear time, in distance). */
export const CLEAR_DISTANCE = 240;
export const MAX_SAME_KIND = 2;

/** Play mode or the failed screen return to auto after this many seconds without input. */
export const IDLE_RETURN = 8;
/** Input is ignored this long after a crash, so a mashed key does not skip the failed face. */
export const RETRY_LOCK = 0.4;
/** celebrate(): the done face lasts this long; collisions are off meanwhile. */
export const DONE_TIME = 1.6;
/** Points per unit (Chrome: 0.025 per px with a 47 px dino; about 9 points per second at cruise). */
export const SCORE_PER_UNIT = 0.06;

// ---------------------------------------------------------------- bar geometry (css px)

/** Css px the canvas reaches above the bar (runner.css --runner-peek), so a jump's apex may clear the top hairline. */
export const BAR_PEEK = 10;
/** Bar height in dot pitches: 64 px -> 1.75 px pitch (31.5 px dino), 52 px -> 1.42 px (25.6 px dino), BRIEF 12b.4. */
export const BAR_UNITS = 36.5;
/** Rows of the ground strip below the ground line (runner-sprites GROUND_TILE). */
export const GROUND_ROWS = 4;

/**
 * Layout of the runner canvas for a canvas `canvasH` css px tall (the bar plus BAR_PEEK above it): the dot pitch and
 * the ground line's y from the canvas top. The dino at APEX (DINO_H + APEX units above the ground) stays inside it.
 */
export function barGeometry(canvasH: number): { barH: number; pitch: number; groundY: number } {
	const barH = Math.max(1, canvasH - BAR_PEEK);
	const pitch = Math.min(2, barH / BAR_UNITS);
	return { barH, pitch, groundY: BAR_PEEK + barH - GROUND_ROWS * pitch - 2 };
}
export const SCORE_MAX = 99999;
/** The legs swap frames every LEG_UNITS of distance (15 fps at cruise, faster in a sprint). */
export const LEG_UNITS = 10;

export const MAX_OBSTACLES = 64; // ring buffer size (power of two)
const RING_MASK = MAX_OBSTACLES - 1;

export const MODE_AUTO = 0;
export const MODE_PLAY = 1;
export const MODE_FAILED = 2;
export const FACE_RUN = 0;
export const FACE_JUMP = 1;
export const FACE_FAILED = 2;
export const FACE_DONE = 3;

const RISE = 1 - Math.exp(-STEP / SPEED_RISE_TAU);
const FALL = 1 - Math.exp(-STEP / SPEED_FALL_TAU);

// ---------------------------------------------------------------- collision boxes

export interface Box {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** Index -> obstacle name (cactus, bug, error, timeout). */
export const KINDS = OBSTACLE_NAMES;
export const KIND_COUNT = KINDS.length;

/**
 * Forgiving per-sprite boxes (sprite grid units, x/y from the sprite's top-left), like Chrome's: the trunk and arms
 * of the cactus, the bug's shell without antennae and feet, the error block and hourglass without their corners.
 */
export const OBSTACLE_HITBOXES: Readonly<Record<(typeof KINDS)[number], readonly Box[]>> = {
	cactus: [
		{ x: 3, y: 1, w: 3, h: 13 },
		{ x: 0, y: 4, w: 2, h: 5 },
		{ x: 7, y: 3, w: 2, h: 5 },
	],
	bug: [{ x: 1, y: 3, w: 9, h: 5 }],
	error: [
		{ x: 1, y: 0, w: 6, h: 8 },
		{ x: 0, y: 1, w: 8, h: 6 },
	],
	timeout: [
		{ x: 0, y: 0, w: 7, h: 1 },
		{ x: 1, y: 0, w: 5, h: 9 },
		{ x: 0, y: 8, w: 7, h: 1 },
	],
};

/** Per kind: width and height in units. */
export const KIND_W = new Float64Array(KIND_COUNT);
export const KIND_H = new Float64Array(KIND_COUNT);
/** Flattened boxes, ground-up: [x0, x1, y0, y1] with y0 the bottom above the ground. */
const KIND_BOX_START = new Uint8Array(KIND_COUNT + 1);
const KIND_BOXES: number[] = [];
for (let k = 0; k < KIND_COUNT; k++) {
	const name = KINDS[k] as (typeof KINDS)[number];
	const sprite = OBSTACLES[name];
	KIND_W[k] = sprite.cols;
	KIND_H[k] = sprite.rows.length;
	KIND_BOX_START[k] = KIND_BOXES.length / 4;
	for (const b of OBSTACLE_HITBOXES[name]) KIND_BOXES.push(b.x, b.x + b.w, sprite.rows.length - (b.y + b.h), sprite.rows.length - b.y);
}
KIND_BOX_START[KIND_COUNT] = KIND_BOXES.length / 4;
const OBS_BOX = Float64Array.from(KIND_BOXES);

/**
 * The dino's collision boxes in the flattened ground-up form, plus their horizontal extent and center (the planner
 * aims this center at the obstacle's center). One per species (runnerHitboxes in src/brand/runner-sprites.ts), built
 * once by `dinoBoxes` and passed in, so switching species never allocates inside the loop.
 */
export interface DinoBoxes {
	/** [x0, x1, y0, y1] per box, y0 the bottom above the ground. */
	box: Float64Array;
	count: number;
	left: number;
	right: number;
	center: number;
}

export function dinoBoxes(hitboxes: readonly Box[]): DinoBoxes {
	const left = Math.min(...hitboxes.map((b) => b.x));
	const right = Math.max(...hitboxes.map((b) => b.x + b.w));
	return {
		box: Float64Array.from(hitboxes.flatMap((b) => [b.x, b.x + b.w, DINO_H - (b.y + b.h), DINO_H - b.y])),
		count: hitboxes.length,
		left,
		right,
		center: (left + right) / 2,
	};
}

/** The T-rex (the default species). */
export const REX_BOXES: DinoBoxes = dinoBoxes(RUNNER_DINO_HITBOXES);
export const DINO_BOX_LEFT = REX_BOXES.left;
export const DINO_BOX_RIGHT = REX_BOXES.right;
export const DINO_CENTER = REX_BOXES.center;

/**
 * Pure AABB test: the dino's sprite left edge at x = 0 with its feet `dinoY` above the ground, an obstacle of `kind`
 * whose left edge is at `dx` (units, relative to the dino's left edge) standing on the ground.
 */
export function overlaps(kind: number, dx: number, dinoY: number, dino: DinoBoxes = REX_BOXES): boolean {
	const DINO_BOX = dino.box;
	for (let i = 0; i < dino.count; i++) {
		const ax0 = DINO_BOX[i * 4] as number;
		const ax1 = DINO_BOX[i * 4 + 1] as number;
		const ay0 = (DINO_BOX[i * 4 + 2] as number) + dinoY;
		const ay1 = (DINO_BOX[i * 4 + 3] as number) + dinoY;
		for (let j = KIND_BOX_START[kind] as number, end = KIND_BOX_START[kind + 1] as number; j < end; j++) {
			const bx0 = (OBS_BOX[j * 4] as number) + dx;
			const bx1 = (OBS_BOX[j * 4 + 1] as number) + dx;
			const by0 = OBS_BOX[j * 4 + 2] as number;
			const by1 = OBS_BOX[j * 4 + 3] as number;
			if (ax0 < bx1 && bx0 < ax1 && ay0 < by1 && by0 < ay1) return true;
		}
	}
	return false;
}

// ---------------------------------------------------------------- state

export interface Sim {
	/** Simulated time (s) and the not-yet-simulated remainder of real time. */
	t: number;
	acc: number;
	mode: number;
	rng: number;
	/** World x of the view's left edge; the previous step's value, for render interpolation. */
	dist: number;
	prevDist: number;
	speed: number;
	/** Scroll boost requested by the view (1 = cruise, up to BOOST_MAX); auto mode only. */
	boost: number;
	/** Feet height above the ground and vertical velocity. */
	y: number;
	prevY: number;
	vy: number;
	air: boolean;
	jumps: number;
	secondJumpAt: number;
	doneUntil: number;
	lastInput: number;
	failedAt: number;
	/** A press arrived during the retry lock: retry once the lock ends (the failed face still shows for RETRY_LOCK). */
	retryQueued: boolean;
	playStart: number;
	playStartDist: number;
	score: number;
	hi: number;
	/** Auto mode: obstacles the dino touched (stays 0 when the planner works); obstacles passed. */
	hits: number;
	passed: number;
	viewUnits: number;
	/** The dino sprite's left edge, units from the view's left edge. */
	dinoX: number;
	/** The current species' collision boxes (`setDino`). */
	dino: DinoBoxes;
	head: number;
	count: number;
	kind: Uint8Array;
	wx: Float64Array;
	vfair: Float64Array;
	/** Per slot: 1 once passed, 2 once hit (auto) */
	flags: Uint8Array;
	nextWx: number;
	lastKind: number;
	sameKind: number;
}

export function createSim(seed = 1, viewUnits = 600, dinoX = 60, dino: DinoBoxes = REX_BOXES): Sim {
	const s: Sim = {
		t: 0,
		acc: 0,
		mode: MODE_AUTO,
		rng: seed >>> 0 || 1,
		dist: 0,
		prevDist: 0,
		speed: CRUISE,
		boost: 1,
		y: 0,
		prevY: 0,
		vy: 0,
		air: false,
		jumps: 0,
		secondJumpAt: 0,
		doneUntil: -1,
		lastInput: 0,
		failedAt: 0,
		retryQueued: false,
		playStart: 0,
		playStartDist: 0,
		score: 0,
		hi: 0,
		hits: 0,
		passed: 0,
		viewUnits,
		dinoX,
		dino,
		head: 0,
		count: 0,
		kind: new Uint8Array(MAX_OBSTACLES),
		wx: new Float64Array(MAX_OBSTACLES),
		vfair: new Float64Array(MAX_OBSTACLES),
		flags: new Uint8Array(MAX_OBSTACLES),
		nextWx: 0,
		lastKind: -1,
		sameKind: 0,
	};
	resetCourse(s);
	return s;
}

/** The view changed size (units visible, dino position). Obstacles keep their world positions. */
export function setView(s: Sim, viewUnits: number, dinoX: number): void {
	s.viewUnits = viewUnits;
	s.dinoX = dinoX;
}

/** Another species takes over (its boxes from `dinoBoxes`); the course and the run carry on unchanged. */
export function setDino(s: Sim, dino: DinoBoxes): void {
	s.dino = dino;
}

/** mulberry32, state in s.rng; returns [0, 1). */
export function random(s: Sim): number {
	let a = (s.rng = (s.rng + 0x6d2b79f5) >>> 0);
	a = Math.imul(a ^ (a >>> 15), a | 1);
	a ^= a + Math.imul(a ^ (a >>> 7), a | 61);
	return ((a ^ (a >>> 14)) >>> 0) / 4294967296;
}

/**
 * Clear the course near the dino: obstacles closer than CLEAR_DISTANCE are dropped, the ones further ahead stay where
 * they are (nothing pops in or out of view on a retry), and spawning resumes after them.
 */
function resetCourse(s: Sim): void {
	const clear = s.dist + s.dinoX + CLEAR_DISTANCE;
	while (s.count > 0 && (s.wx[s.head] as number) < clear) {
		s.head = (s.head + 1) & RING_MASK;
		s.count--;
	}
	if (s.count === 0) {
		s.head = 0;
		s.lastKind = -1;
		s.sameKind = 0;
		s.nextWx = Math.max(s.nextWx, clear);
	}
}

/** The highest speed a new obstacle's gap must be fair for. */
function spawnSpeed(s: Sim): number {
	if (s.mode === MODE_AUTO) return MAX_SPEED;
	// Play: the current or target speed plus 10 s of ramp, never below the speed we already run at.
	const v = Math.max(s.speed, playTarget(s)) + PLAY_RAMP * 10;
	return v > MAX_SPEED ? MAX_SPEED : v;
}

function playTarget(s: Sim): number {
	const v = CRUISE + PLAY_RAMP * (s.t - s.playStart);
	return v > PLAY_MAX ? PLAY_MAX : v;
}

/** The minimum center-to-center gap that is fair at `vfair`. */
export function fairGap(vfair: number): number {
	return FAIR_MARGIN * vfair * AIRTIME;
}

function spawn(s: Sim): void {
	let k = Math.floor(random(s) * KIND_COUNT);
	if (k === s.lastKind && s.sameKind >= MAX_SAME_KIND) k = (k + 1 + Math.floor(random(s) * (KIND_COUNT - 1))) % KIND_COUNT;
	if (k === s.lastKind) s.sameKind++;
	else s.sameKind = 1;
	s.lastKind = k;
	const vfair = spawnSpeed(s);
	let wx = s.nextWx;
	if (s.count > 0) {
		// Center spacing from the previous obstacle: fair for this obstacle's speed bound, then randomized.
		const prev = (s.head + s.count - 1) & RING_MASK;
		const prevCenter = (s.wx[prev] as number) + (KIND_W[s.kind[prev] as number] as number) / 2;
		const center = prevCenter + fairGap(vfair) * (1 + GAP_SPREAD * random(s));
		wx = Math.max(wx, center - (KIND_W[k] as number) / 2);
	}
	const slot = (s.head + s.count) & RING_MASK;
	s.kind[slot] = k;
	s.wx[slot] = wx;
	s.vfair[slot] = vfair;
	s.flags[slot] = 0;
	s.count++;
	s.nextWx = wx + (KIND_W[k] as number);
}

function startJump(s: Sim): void {
	s.air = true;
	s.vy = JUMP_VELOCITY;
	s.jumps++;
}

// ---------------------------------------------------------------- inputs

/** A jump request (click, tap, Space or ArrowUp). Starts play mode, jumps, or retries after a crash. */
export function press(s: Sim): void {
	if (s.mode === MODE_FAILED) {
		s.lastInput = s.t;
		if (s.t - s.failedAt < RETRY_LOCK) {
			s.retryQueued = true;
			return;
		}
		restartPlay(s);
		return;
	}
	s.lastInput = s.t;
	if (s.mode === MODE_AUTO) {
		s.mode = MODE_PLAY;
		s.playStart = s.t;
		s.playStartDist = s.dist;
		s.score = 0;
	}
	if (!s.air) startJump(s);
}

function restartPlay(s: Sim): void {
	s.mode = MODE_PLAY;
	s.retryQueued = false;
	s.y = s.prevY = 0;
	s.vy = 0;
	s.air = false;
	s.speed = CRUISE;
	s.playStart = s.t;
	s.playStartDist = s.dist;
	s.score = 0;
	resetCourse(s);
}

function toAuto(s: Sim): void {
	const crashed = s.mode === MODE_FAILED;
	s.mode = MODE_AUTO;
	if (crashed) {
		s.y = s.prevY = 0;
		s.vy = 0;
		s.air = false;
		s.speed = CRUISE;
		resetCourse(s);
	}
}

/** Double jump with the done face; collisions are off while it lasts. Works from any mode. */
export function celebrate(s: Sim): void {
	if (s.mode === MODE_FAILED) toAuto(s);
	s.doneUntil = s.t + DONE_TIME;
	if (s.air) {
		s.vy = Math.max(s.vy, JUMP_VELOCITY * DOUBLE_JUMP);
		s.jumps++;
	} else startJump(s);
	s.secondJumpAt = s.t + DOUBLE_JUMP_DELAY;
}

export function face(s: Sim): number {
	if (s.mode === MODE_FAILED) return FACE_FAILED;
	if (s.t < s.doneUntil) return FACE_DONE;
	return s.air ? FACE_JUMP : FACE_RUN;
}

/** 0 or 1: which run frame the legs show. */
export function legFrame(s: Sim, dist = s.dist): number {
	return Math.floor(dist / LEG_UNITS) & 1;
}

// ---------------------------------------------------------------- stepping

/** Advance real time `dt` (s) in fixed steps; returns the interpolation factor [0, 1) for rendering. */
export function advance(s: Sim, dt: number): number {
	s.acc += dt > 0.25 ? 0.25 : dt;
	while (s.acc >= STEP) {
		s.acc -= STEP;
		step(s);
	}
	return s.acc / STEP;
}

/** The lowest fair speed among the obstacles still ahead of the dino (MAX_SPEED with none). */
function speedCap(s: Sim): number {
	let cap = MAX_SPEED;
	const left = s.dist + s.dinoX + s.dino.left;
	for (let i = 0; i < s.count; i++) {
		const slot = (s.head + i) & RING_MASK;
		if ((s.wx[slot] as number) + (KIND_W[s.kind[slot] as number] as number) > left) {
			const v = s.vfair[slot] as number;
			if (v < cap) cap = v;
		}
	}
	return cap;
}

export function step(s: Sim): void {
	s.prevDist = s.dist;
	s.prevY = s.y;
	s.t += STEP;
	const t = s.t;

	if (s.mode === MODE_FAILED) {
		if (s.retryQueued && t - s.failedAt >= RETRY_LOCK) {
			restartPlay(s);
			return;
		}
		if (t - s.lastInput >= IDLE_RETURN && t - s.failedAt >= IDLE_RETURN) toAuto(s);
		return;
	}
	if (s.mode === MODE_PLAY && t - s.lastInput >= IDLE_RETURN) toAuto(s);

	// Ground speed changes only while running on the ground.
	if (!s.air) {
		const b = s.boost < 1 ? 1 : s.boost > BOOST_MAX ? BOOST_MAX : s.boost;
		const target = s.mode === MODE_AUTO ? CRUISE * b : playTarget(s);
		s.speed += (target - s.speed) * (target > s.speed ? RISE : FALL);
		const cap = speedCap(s);
		if (s.speed > cap) s.speed = cap;
	}
	s.dist += s.speed * STEP;

	// Vertical motion: exact constant-gravity integration, so apex and airtime do not depend on the step.
	if (s.secondJumpAt > 0 && t >= s.secondJumpAt) {
		s.secondJumpAt = 0;
		s.air = true;
		s.vy = JUMP_VELOCITY * DOUBLE_JUMP;
		s.jumps++;
	}
	if (s.air) {
		s.y += s.vy * STEP - 0.5 * GRAVITY * STEP * STEP;
		s.vy -= GRAVITY * STEP;
		if (s.y <= 0) {
			s.y = 0;
			s.vy = 0;
			s.air = false;
		}
	}

	// Course: drop obstacles that left the view, spawn ahead of its right edge.
	while (s.count > 0) {
		const slot = s.head;
		if ((s.wx[slot] as number) + (KIND_W[s.kind[slot] as number] as number) >= s.dist - 4) break;
		s.head = (s.head + 1) & RING_MASK;
		s.count--;
	}
	while (s.count < MAX_OBSTACLES && s.nextWx < s.dist + s.viewUnits + 64) spawn(s);

	const dinoWx = s.dist + s.dinoX;
	const invincible = t < s.doneUntil;
	let planned = false;
	for (let i = 0; i < s.count; i++) {
		const slot = (s.head + i) & RING_MASK;
		const k = s.kind[slot] as number;
		const wx = s.wx[slot] as number;
		const w = KIND_W[k] as number;
		if (wx > dinoWx + DINO_W) break; // sorted by wx: nothing further can touch the dino yet
		const flags = s.flags[slot] as number;
		if (wx + w <= dinoWx + s.dino.left) {
			if ((flags & 1) === 0) {
				s.flags[slot] = flags | 1;
				s.passed++;
			}
			continue;
		}
		// Auto planner: aim the jump's apex at the obstacle's center (a symmetric jump at constant speed).
		if (!planned && s.mode === MODE_AUTO) {
			planned = true;
			const d = wx + w / 2 - (dinoWx + s.dino.center);
			if (!s.air && d <= (s.speed * AIRTIME) / 2) startJump(s);
		}
		if (overlaps(k, wx - dinoWx, s.y, s.dino)) {
			if (s.mode === MODE_PLAY && !invincible) {
				fail(s);
				return;
			}
			if (s.mode === MODE_AUTO && !invincible && (flags & 2) === 0) {
				s.flags[slot] = flags | 2;
				s.hits++;
			}
		}
	}
	// The planner also looks at obstacles still beyond the dino's sprite (the loop above breaks before them).
	if (!planned && s.mode === MODE_AUTO && !s.air) planNext(s, dinoWx);

	if (s.mode === MODE_PLAY) {
		const score = Math.floor((s.dist - s.playStartDist) * SCORE_PER_UNIT);
		s.score = score > SCORE_MAX ? SCORE_MAX : score;
	}
}

function planNext(s: Sim, dinoWx: number): void {
	for (let i = 0; i < s.count; i++) {
		const slot = (s.head + i) & RING_MASK;
		const k = s.kind[slot] as number;
		const wx = s.wx[slot] as number;
		const w = KIND_W[k] as number;
		if (wx + w <= dinoWx + s.dino.left) continue;
		const d = wx + w / 2 - (dinoWx + s.dino.center);
		if (d <= (s.speed * AIRTIME) / 2) startJump(s);
		return;
	}
}

function fail(s: Sim): void {
	s.mode = MODE_FAILED;
	s.failedAt = s.t;
	s.retryQueued = false;
	s.secondJumpAt = 0;
	s.vy = 0;
	if (s.score > s.hi) s.hi = s.score;
}
