import { describe, expect, test } from "bun:test";
import { GROUND_TILE, OBSTACLES, RUNNER_DINO_HITBOXES, runnerDinoSprite, runnerHitboxes } from "../../src/brand/runner-sprites.ts";
import { SPECIES_IDS } from "../../src/brand/species.ts";
import {
	AIRTIME,
	APEX,
	BOOST_MAX,
	CLEAR_DISTANCE,
	CRUISE,
	DINO_BOX_LEFT,
	DINO_CENTER,
	DINO_H,
	DONE_TIME,
	FACE_DONE,
	FACE_FAILED,
	FACE_JUMP,
	FACE_RUN,
	IDLE_RETURN,
	KIND_COUNT,
	KIND_W,
	KINDS,
	MAX_SAME_KIND,
	MAX_SPEED,
	MODE_AUTO,
	MODE_FAILED,
	MODE_PLAY,
	OBSTACLE_HITBOXES,
	RETRY_LOCK,
	STEP,
	type Sim,
	advance,
	celebrate,
	createSim,
	dinoBoxes,
	face,
	fairGap,
	overlaps,
	press,
	REX_BOXES,
	setDino,
	step,
	BAR_PEEK,
	barGeometry,
	GROUND_ROWS,
} from "../../src/client/runner/sim.ts";

const stepsFor = (seconds: number) => Math.round(seconds / STEP);
function run(s: Sim, seconds: number): void {
	for (let i = 0, n = stepsFor(seconds); i < n; i++) step(s);
}

/** Every obstacle currently in the ring, in order. */
function course(s: Sim): { kind: number; wx: number; vfair: number }[] {
	const out: { kind: number; wx: number; vfair: number }[] = [];
	for (let i = 0; i < s.count; i++) {
		const slot = (s.head + i) & 63;
		out.push({ kind: s.kind[slot] as number, wx: s.wx[slot] as number, vfair: s.vfair[slot] as number });
	}
	return out;
}

describe("jump physics", () => {
	test("a full jump lasts about 545 ms and peaks at APEX (18) units", () => {
		const s = createSim(7, 600, 60);
		s.mode = MODE_PLAY; // no planner
		s.lastInput = 0;
		// Clear the course so nothing interferes.
		s.count = 0;
		s.nextWx = 1e9;
		press(s);
		expect(s.air).toBe(true);
		let apex = 0;
		let steps = 0;
		while (s.air && steps < 10000) {
			step(s);
			steps++;
			if (s.y > apex) apex = s.y;
		}
		const airtime = steps * STEP;
		expect(Math.abs(airtime - AIRTIME)).toBeLessThanOrEqual(STEP);
		expect(Math.abs(apex - APEX)).toBeLessThan(0.05);
		expect(s.y).toBe(0);
		expect(s.jumps).toBe(1);
	});

	test("airtime and apex do not depend on the frame rate (time-based)", () => {
		for (const hz of [60, 120, 144, 200, 240, 1000]) {
			const s = createSim(3, 600, 60);
			s.mode = MODE_PLAY;
			s.count = 0;
			s.nextWx = 1e9;
			press(s);
			let t = 0;
			let apex = 0;
			while (s.air && t < 2) {
				advance(s, 1 / hz);
				t += 1 / hz;
				if (s.y > apex) apex = s.y;
			}
			expect(Math.abs(t - AIRTIME)).toBeLessThanOrEqual(1 / hz + STEP);
			expect(Math.abs(apex - APEX)).toBeLessThan(0.05);
		}
	});
});

describe("collision boxes", () => {
	const dinoRows = runnerDinoSprite("run-a").rows;
	const lit = (rows: readonly string[], x: number, y: number) => {
		const ch = rows[y]?.[x];
		return ch !== undefined && ch !== ".";
	};
	const tight = (rows: readonly string[], cols: number, b: { x: number; y: number; w: number; h: number }) => {
		expect(b.x).toBeGreaterThanOrEqual(0);
		expect(b.y).toBeGreaterThanOrEqual(0);
		expect(b.x + b.w).toBeLessThanOrEqual(cols);
		expect(b.y + b.h).toBeLessThanOrEqual(rows.length);
		// Tight: each of the four edges of the box touches a lit dot (no empty slack around the shape).
		const rowLit = (y: number) => {
			for (let x = b.x; x < b.x + b.w; x++) if (lit(rows, x, y)) return true;
			return false;
		};
		const colLit = (x: number) => {
			for (let y = b.y; y < b.y + b.h; y++) if (lit(rows, x, y)) return true;
			return false;
		};
		expect([rowLit(b.y), rowLit(b.y + b.h - 1), colLit(b.x), colLit(b.x + b.w - 1)]).toEqual([true, true, true, true]);
	};

	test("every box sits inside its sprite and hugs it (no empty edge rows or columns)", () => {
		for (const b of RUNNER_DINO_HITBOXES) tight(dinoRows, 30, b);
		for (const name of KINDS) {
			const sprite = OBSTACLES[name];
			for (const b of OBSTACLE_HITBOXES[name]) tight(sprite.rows, sprite.cols, b);
		}
	});

	test("boxes forgive corners: they cover less than the sprite's bounding box", () => {
		for (const name of KINDS) {
			const sprite = OBSTACLES[name];
			const covered = new Set<number>();
			for (const b of OBSTACLE_HITBOXES[name]) for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) covered.add(y * 100 + x);
			expect(covered.size).toBeLessThan(sprite.cols * sprite.rows.length);
			// ...yet they still hold most of the drawn dots (only corners, antennae, feet or the bloom are left out; the bug keeps 69%).
			let litDots = 0;
			let litCovered = 0;
			sprite.rows.forEach((row, y) => {
				for (let x = 0; x < sprite.cols; x++) {
					if (row[x] === ".") continue;
					litDots++;
					if (covered.has(y * 100 + x)) litCovered++;
				}
			});
			expect(litCovered / litDots).toBeGreaterThan(0.65);
		}
	});

	test("overlaps: touching, clear above, clear ahead, forgiven corner", () => {
		for (let k = 0; k < KIND_COUNT; k++) {
			// Obstacle right under the dino's body: hit on the ground.
			expect(overlaps(k, 10, 0)).toBe(true);
			// Same place, dino at the apex: clear.
			expect(overlaps(k, 10, APEX)).toBe(false);
			// Obstacle just beyond the dino's snout box (x 28): clear.
			expect(overlaps(k, 28, 0)).toBe(false);
			// Obstacle ending exactly where the leg/torso boxes start (x 6): clear (touching edges do not collide).
			expect(overlaps(k, 6 - (KIND_W[k] as number), 0)).toBe(false);
		}
		// The tail tip (x 0-5) has no box: a cactus overlapping only the tail is forgiven.
		expect(overlaps(0, -5, 0)).toBe(false);
		// Feet 1 unit above a bug's shell top (row 3 of 8 -> 5 units high): clear; 1 unit into it: hit.
		const bug = KINDS.indexOf("bug");
		expect(overlaps(bug, 10, 5.5)).toBe(false);
		expect(overlaps(bug, 10, 4.5)).toBe(true);
	});

	test("the dino sprite is 18 rows tall like the box model assumes", () => {
		expect(dinoRows.length).toBe(DINO_H);
	});
});

describe("spawner", () => {
	function collect(seed: number, mode: number, speed: number, n: number, view = 1400) {
		const s = createSim(seed, view, 100);
		s.mode = mode;
		s.lastInput = 0;
		s.boost = speed / CRUISE;
		s.speed = speed;
		const seen = new Map<number, { kind: number; wx: number; vfair: number }>();
		let guard = 0;
		while (seen.size < n && guard++ < 5_000_000) {
			if (mode === MODE_PLAY && !s.air) {
				// A perfect player: press when the next obstacle's center is half a jump span away.
				for (const o of course(s)) {
					if (o.wx + (KIND_W[o.kind] as number) <= s.dist + s.dinoX + DINO_BOX_LEFT) continue;
					if (o.wx + (KIND_W[o.kind] as number) / 2 - (s.dist + s.dinoX + DINO_CENTER) <= (s.speed * AIRTIME) / 2) press(s);
					break;
				}
			}
			step(s);
			s.lastInput = s.t; // play mode: keep "input" alive so it does not return to auto
			for (const o of course(s)) seen.set(o.wx, o);
			if (s.mode === MODE_FAILED) throw new Error("unexpected crash");
		}
		return { s, obstacles: [...seen.values()].sort((a, b) => a.wx - b.wx) };
	}

	test("gaps between centers are fair for each obstacle's speed bound, scale with speed, and vary", () => {
		const { obstacles } = collect(11, MODE_AUTO, CRUISE, 600);
		let minRatio = Infinity;
		let maxRatio = 0;
		for (let i = 1; i < obstacles.length; i++) {
			const a = obstacles[i - 1]!;
			const b = obstacles[i]!;
			const gap = b.wx + (KIND_W[b.kind] as number) / 2 - (a.wx + (KIND_W[a.kind] as number) / 2);
			const ratio = gap / fairGap(b.vfair);
			minRatio = Math.min(minRatio, ratio);
			maxRatio = Math.max(maxRatio, ratio);
			// A centered jump spans speed * AIRTIME; the gap leaves room to land and jump again at vfair.
			expect(gap).toBeGreaterThanOrEqual(b.vfair * AIRTIME);
		}
		expect(minRatio).toBeGreaterThanOrEqual(1 - 1e-9);
		expect(maxRatio).toBeGreaterThan(1.5); // randomized, not a metronome
	});

	test("play-mode gaps are scaled by speed: faster runs get proportionally longer gaps", () => {
		const slow = collect(5, MODE_PLAY, CRUISE, 80).obstacles;
		const meanGap = (list: { kind: number; wx: number }[]) => {
			let sum = 0;
			for (let i = 1; i < list.length; i++) sum += list[i]!.wx - list[i - 1]!.wx;
			return sum / (list.length - 1);
		};
		for (const o of slow) expect(o.vfair).toBeLessThan(MAX_SPEED);
		const autoGap = meanGap(collect(5, MODE_AUTO, CRUISE, 80).obstacles);
		expect(autoGap).toBeGreaterThan(meanGap(slow) * 1.5); // auto gaps are fair for a full scroll sprint
	});

	test("no more than two of the same obstacle in a row; every kind appears", () => {
		const { obstacles } = collect(23, MODE_AUTO, CRUISE, 500);
		let run = 1;
		const kinds = new Set<number>();
		for (let i = 0; i < obstacles.length; i++) {
			kinds.add(obstacles[i]!.kind);
			if (i > 0) run = obstacles[i]!.kind === obstacles[i - 1]!.kind ? run + 1 : 1;
			expect(run).toBeLessThanOrEqual(MAX_SAME_KIND);
		}
		expect(kinds.size).toBe(KIND_COUNT);
	});

	test("a wide view starts with obstacles on screen, the nearest one CLEAR_DISTANCE ahead", () => {
		const s = createSim(12, 1400, 120);
		step(s);
		const list = course(s);
		expect(list.length).toBeGreaterThanOrEqual(3);
		expect(list[0]!.wx).toBeGreaterThanOrEqual(s.dist + 60 + CLEAR_DISTANCE - 1);
		expect(list[0]!.wx).toBeLessThan(s.dist + s.viewUnits);
	});

	test("the course is deterministic per seed", () => {
		const a = collect(99, MODE_AUTO, CRUISE, 50).obstacles.map((o) => [o.kind, Math.round(o.wx * 1000)]);
		const b = collect(99, MODE_AUTO, CRUISE, 50).obstacles.map((o) => [o.kind, Math.round(o.wx * 1000)]);
		expect(a).toEqual(b);
	});
});

describe("auto-jump planner", () => {
	function autoRun(seed: number, boost: (t: number) => number, obstacles = 500, view = 1400) {
		const s = createSim(seed, view, 120);
		s.boost = boost(0);
		s.speed = CRUISE * s.boost;
		let guard = 0;
		while (s.passed < obstacles && guard++ < 20_000_000) {
			s.boost = boost(s.t);
			step(s);
		}
		return s;
	}

	for (const k of [1, 1.4, 1.8, BOOST_MAX]) {
		test(`clears 500 obstacles without touching any at ${Math.round(k * CRUISE)} units/s`, () => {
			const s = autoRun(1000 + k * 10, () => k);
			expect(s.passed).toBeGreaterThanOrEqual(500);
			expect(s.hits).toBe(0);
			expect(s.mode).toBe(MODE_AUTO);
			expect(Math.abs(s.speed - k * CRUISE)).toBeLessThan(1);
		});
	}

	test("clears 500 obstacles while scroll boosts come and go", () => {
		const s = autoRun(4242, (t) => {
			const phase = Math.floor(t / 1.3) % 5;
			return [1, BOOST_MAX, 1.2, 2, 1][phase] ?? 1;
		});
		expect(s.passed).toBeGreaterThanOrEqual(500);
		expect(s.hits).toBe(0);
	});

	test("clears on a narrow (390 px) view as well", () => {
		const s = autoRun(77, (t) => (Math.sin(t) > 0.6 ? BOOST_MAX : 1), 500, 380);
		expect(s.passed).toBeGreaterThanOrEqual(500);
		expect(s.hits).toBe(0);
	});

	test("taking over from a play-mode course keeps the planner clean", () => {
		const s = createSim(8, 1400, 120);
		press(s); // play mode, one jump
		s.boost = BOOST_MAX; // the user scrolls hard while the game returns to auto
		let guard = 0;
		while (s.mode !== MODE_AUTO && guard++ < 1e6) {
			s.lastInput = Math.min(s.lastInput, s.t); // no more input
			if (s.mode === MODE_FAILED) break;
			// Survive play mode by pressing exactly when the planner would (we only want the hand-over).
			step(s);
		}
		// It either crashed (then returns via the failed screen) or idled back; both end in auto within 8 s + a bit.
		run(s, IDLE_RETURN + 1);
		expect(s.mode).toBe(MODE_AUTO);
		const hits = s.hits;
		const passed = s.passed;
		while (s.passed < passed + 200) step(s);
		expect(s.hits).toBe(hits);
	});
});

describe("modes and the idle timer", () => {
	test("first press switches to play and jumps; 8 s without input returns to auto", () => {
		const s = createSim(1, 1400, 120);
		run(s, 1);
		expect(s.mode).toBe(MODE_AUTO);
		const jumps = s.jumps;
		s.count = 0;
		s.nextWx = 1e9; // empty course: nothing to crash into
		press(s);
		expect(s.mode).toBe(MODE_PLAY);
		expect(s.jumps).toBe(jumps + 1);
		run(s, IDLE_RETURN - 0.1);
		expect(s.mode).toBe(MODE_PLAY);
		press(s); // input resets the timer
		run(s, IDLE_RETURN - 0.1);
		expect(s.mode).toBe(MODE_PLAY);
		run(s, 0.2);
		expect(s.mode).toBe(MODE_AUTO);
	});

	test("a crash in play mode shows the failed face, keeps the high score, and returns to auto after 8 s", () => {
		const s = createSim(2, 1400, 120);
		press(s);
		let guard = 0;
		while (s.mode === MODE_PLAY && guard++ < 1e6) {
			s.lastInput = s.t; // keep playing but never jump: the first obstacle ends the run
			step(s);
		}
		expect(s.mode).toBe(MODE_FAILED);
		expect(face(s)).toBe(FACE_FAILED);
		expect(s.score).toBeGreaterThan(0);
		expect(s.hi).toBe(s.score);
		const dist = s.dist;
		run(s, 1);
		expect(s.dist).toBe(dist); // the world stops
		run(s, IDLE_RETURN - 1 + 0.1);
		expect(s.mode).toBe(MODE_AUTO);
		expect(face(s)).toBe(FACE_RUN);
		expect(s.count === 0 || (s.wx[s.head] as number) > s.dist + s.dinoX + 100).toBe(true); // fresh course
	});

	test("retry after a crash restarts play with a zero score; a press within the retry lock is queued until it ends", () => {
		const s = createSim(4, 1400, 120);
		press(s);
		while (s.mode === MODE_PLAY) {
			s.lastInput = s.t;
			step(s);
		}
		const hi = s.hi;
		press(s); // pressed at once: the failed face stays for the lock, then the queued retry runs
		expect(s.mode).toBe(MODE_FAILED);
		run(s, RETRY_LOCK * 0.5);
		expect(s.mode).toBe(MODE_FAILED);
		run(s, RETRY_LOCK * 0.5 + 0.05);
		expect(s.mode).toBe(MODE_PLAY);
		expect(s.score).toBe(0);
		expect(s.hi).toBe(hi);
		expect(s.air).toBe(false); // retry does not jump
	});

	test("celebrate(): a double jump with the done face, no crash while it lasts", () => {
		const s = createSim(5, 1400, 120);
		press(s); // play mode
		run(s, 0.6);
		const jumps = s.jumps;
		celebrate(s);
		expect(face(s)).toBe(FACE_DONE);
		run(s, 0.3);
		expect(s.jumps).toBe(jumps + 2);
		let maxY = 0;
		for (let i = 0; i < stepsFor(DONE_TIME - 0.35); i++) {
			s.lastInput = s.t;
			step(s);
			maxY = Math.max(maxY, s.y);
			expect(s.mode).toBe(MODE_PLAY);
		}
		expect(maxY).toBeGreaterThan(APEX); // the second impulse lifts it above a single jump
		run(s, 0.2);
		expect(face(s)).not.toBe(FACE_DONE);
	});

	test("the jump face shows in the air", () => {
		const s = createSim(6, 1400, 120);
		press(s);
		expect(face(s)).toBe(FACE_JUMP);
	});
});

describe("bar geometry (BRIEF 12b.4)", () => {
	// The canvas is the bar plus BAR_PEEK css px above it (runner.css --runner-peek).
	const cases = [
		{ bar: 64, min: 30, max: 34 },
		{ bar: 52, min: 24, max: 28 },
	];
	test("GROUND_ROWS matches the ground tile", () => {
		expect(GROUND_TILE.length).toBe(GROUND_ROWS);
	});
	for (const { bar, min, max } of cases) {
		test(`a ${bar} px bar draws the dino ${min}-${max} px tall and keeps the apex and the ground inside the canvas`, () => {
			const canvasH = bar + BAR_PEEK;
			const g = barGeometry(canvasH);
			expect(g.barH).toBe(bar);
			const dinoPx = DINO_H * g.pitch;
			expect(dinoPx).toBeGreaterThanOrEqual(min);
			expect(dinoPx).toBeLessThanOrEqual(max);
			// apex: the sprite top stays at or below the canvas top
			expect(g.groundY - (DINO_H + APEX) * g.pitch).toBeGreaterThanOrEqual(0);
			// the ground strip ends inside the canvas, and the ground line sits inside the bar (below the peek)
			expect(g.groundY + GROUND_ROWS * g.pitch).toBeLessThanOrEqual(canvasH);
			expect(g.groundY).toBeGreaterThan(BAR_PEEK + bar / 2);
		});
	}
});

describe("species (ADR 0100)", () => {
	test("the default boxes are the T-rex's", () => {
		expect(createSim(1).dino).toBe(REX_BOXES);
		expect(dinoBoxes(runnerHitboxes("rex"))).toEqual(REX_BOXES);
		expect(REX_BOXES.left).toBe(DINO_BOX_LEFT);
		expect(REX_BOXES.center).toBe(DINO_CENTER);
	});

	for (const id of SPECIES_IDS) {
		const boxes = dinoBoxes(runnerHitboxes(id));
		test(`${id}: every box sits inside the 30x18 sprite and covers lit dots of the running frames`, () => {
			const frames = (["run-a", "run-b", "jump"] as const).map((f) => runnerDinoSprite(f, id).rows);
			for (const b of runnerHitboxes(id)) {
				expect(b.x).toBeGreaterThanOrEqual(0);
				expect(b.y).toBeGreaterThanOrEqual(0);
				expect(b.x + b.w).toBeLessThanOrEqual(30);
				expect(b.y + b.h).toBeLessThanOrEqual(DINO_H);
				let lit = 0;
				for (const rows of frames) for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) if ((rows[y]?.[x] ?? ".") !== ".") lit++;
				expect(lit).toBeGreaterThan(0);
			}
		});

		for (const k of [1, BOOST_MAX]) {
			test(`${id}: the planner clears 300 obstacles without touching any at ${Math.round(k * CRUISE)} units/s`, () => {
				const s = createSim(500 + k * 10, 1400, 120, boxes);
				s.boost = k;
				s.speed = CRUISE * k;
				let guard = 0;
				while (s.passed < 300 && guard++ < 20_000_000) step(s);
				expect(s.passed).toBeGreaterThanOrEqual(300);
				expect(s.hits).toBe(0);
			});
		}

		test(`${id}: collisions use the species' boxes`, () => {
			for (let k = 0; k < KIND_COUNT; k++) {
				// An obstacle centered under the boxes' middle, on the ground, always touches; far above, never.
				const dx = boxes.center - (KIND_W[k] as number) / 2;
				expect(overlaps(k, dx, 0, boxes)).toBe(true);
				expect(overlaps(k, dx, APEX + DINO_H, boxes)).toBe(false);
			}
		});
	}

	test("switching species mid-run keeps the course and stays deterministic", () => {
		const runOnce = () => {
			const s = createSim(31, 1400, 120);
			const order = [...SPECIES_IDS, ...SPECIES_IDS];
			for (let i = 0; i < order.length; i++) {
				setDino(s, dinoBoxes(runnerHitboxes(order[i] ?? "rex")));
				run(s, 6);
			}
			return { dist: s.dist, passed: s.passed, hits: s.hits, jumps: s.jumps };
		};
		const a = runOnce();
		expect(runOnce()).toEqual(a);
		expect(a.passed).toBeGreaterThan(10);
		expect(a.hits).toBe(0);
	});
});
