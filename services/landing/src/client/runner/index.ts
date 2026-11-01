/**
 * Bottom runner bar (BRIEF 7): the dot-matrix dinobot runs and jumps over dot-drawn obstacles, Chrome T-Rex style.
 *
 *   mountRunner(host, { locale, species? }) -> { celebrate(), setSpecies(id), destroy() }
 *
 * The dino is any species of src/brand/species.ts (ADR 0100; the T-rex by default): its frames and its collision
 * boxes (runnerHitboxes) follow setSpecies(), which rebuilds only the dino bitmaps and keeps the run going.
 *
 * The page provides an empty `[data-runner]` host; this module makes it the fixed bottom bar (runner.css):
 *   host.runner   fixed, full width, --runner-h tall, focusable (tabindex 0), role group + aria-label/-describedby
 *     .runner__stripes   the five-stripe signature on the top hairline
 *     canvas             the game (DPR capped at 2, sprites pre-rendered once per scale, drawImage only)
 *     .runner__hud       hint, score, HI score (aria-hidden; failures are announced in a polite live region)
 *     button             minimize; when minimized the host becomes a small tab with a restore button
 *
 * QA hooks (qa/README.md "Element hooks"), all on the host element:
 *   data-runner   kept as given by the page ("ready" once mounted when it was empty)
 *   data-mode     auto | play | failed | minimized | static (prefers-reduced-motion)
 *   data-dino     run | jump | failed | done
 *   data-jumps    jump counter (every jump start, including both jumps of celebrate())
 *   tabindex=0    Space / ArrowUp jump (with preventDefault) only while the host itself has focus; click/tap
 *                 anywhere on the bar except its buttons jumps too.
 *
 * Behavior: auto mode never dies (a planner jumps; scrolling makes it sprint), the first input switches to play
 * mode (a crash shows the failed face and "tap to retry"; the HI score persists in localStorage), and 8 s without
 * input returns to auto. Minimized state persists. The loop runs only while visible: it stops when the tab is
 * hidden, the bar is minimized or offscreen, or reduced motion is on (then a static dino that still jumps once per
 * tap, as an instant state change). `celebrate()`, also fired by the window event `dinobot:joined`, double-jumps
 * with the done face.
 *
 * Per frame (allocation-free): use the scroll offset cached by a passive scroll listener, step the fixed-timestep simulation (./sim.ts), draw ground strip +
 * visible obstacles + dino with integer device-pixel positions, and write DOM attributes/text only when they change.
 */
import { DEFAULT_SPECIES, type Dot, SPECIES_IDS, type SpeciesId, isSpeciesId, poseSprite, spriteDots } from "../../brand/mascot.ts";
import { GROUND_LINE_COLOR, GROUND_PEBBLE, GROUND_TILE, OBSTACLES, obstacleDots, runnerDinoDots, runnerHitboxes } from "../../brand/runner-sprites.ts";
import { RUNNER_LABELS, type RunnerLabels } from "./labels.ts";
import {
	APEX,
	AIRTIME,
	BOOST_MAX,
	DINO_H,
	DINO_W,
	DONE_TIME,
	FACE_DONE,
	FACE_FAILED,
	FACE_JUMP,
	KIND_COUNT,
	KINDS,
	MODE_FAILED,
	MODE_PLAY,
	type DinoBoxes,
	type Sim,
	advance,
	barGeometry,
	celebrate as simCelebrate,
	createSim,
	dinoBoxes,
	face,
	legFrame,
	press,
	setDino,
	setView,
} from "./sim.ts";
import "./runner.css";

export type Locale = "en" | "ko";

export interface RunnerHandle {
	/** Double jump + done face, used after a successful waitlist signup. */
	celebrate(): void;
	/** Swap the dinosaur: new frames and collision boxes, same run. Unknown ids are ignored. */
	setSpecies(id: SpeciesId): void;
	destroy(): void;
}

/** Collision boxes per species, flattened once at load (the sim never allocates on a switch). */
const BOXES = Object.fromEntries(SPECIES_IDS.map((id) => [id, dinoBoxes(runnerHitboxes(id))])) as Record<SpeciesId, DinoBoxes>;

/** Per-frame JS cost of the loop (ms), for the lab page and QA. Preallocated ring, no allocation per frame. */
export const runnerStats = {
	frames: 0,
	total: 0,
	max: 0,
	/** Frames whose JS took longer than 1 ms. */
	over1ms: 0,
	ring: new Float32Array(2048),
};

const STORE_HI = "dinobot.runner.hi";
const STORE_MIN = "dinobot.runner.minimized";
const DPR_MAX = 2;
/** Below this many device pixels per dot, dots become crisp cells (a round dot needs room to read as round). */
const ROUND_DOT_SCALE = 2.5;
const DOT_FILL = 0.84;
const GROUND_TILE_UNITS = GROUND_TILE[0]?.length ?? 32;
/** Scroll speed (px/s) that adds +1x to the cruise speed in auto mode. */
const SCROLL_PER_BOOST = 1000;
const SCROLL_TAU = 0.12;

const MODE_NAMES = ["auto", "play", "failed"] as const;
const FACE_NAMES = ["run", "jump", "failed", "done"] as const;
const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;
const SCORE_DIGITS = 5;

let uid = 0;

// ---------------------------------------------------------------- sprite bitmaps

function bitmap(dots: readonly Dot[], cols: number, rows: number, scale: number): HTMLCanvasElement {
	const c = document.createElement("canvas");
	c.width = Math.max(1, Math.ceil(cols * scale));
	c.height = Math.max(1, Math.ceil(rows * scale));
	const ctx = c.getContext("2d");
	if (!ctx) return c;
	const round = scale >= ROUND_DOT_SCALE;
	for (const d of dots) {
		const cell = d.cx - d.x === 0.5 && d.cy - d.y === 0.5;
		ctx.fillStyle = d.fill;
		if (!round && cell) {
			const x0 = Math.round(d.x * scale);
			const y0 = Math.round(d.y * scale);
			ctx.fillRect(x0, y0, Math.round((d.x + 1) * scale) - x0, Math.round((d.y + 1) * scale) - y0);
		} else if (!round && d.part === "ink") {
			// Stroke bridges between ink cells only make sense for round dots; cells already touch.
		} else {
			ctx.beginPath();
			ctx.arc(d.cx * scale, d.cy * scale, Math.max(d.r * scale, 0.5), 0, Math.PI * 2);
			ctx.fill();
		}
	}
	return c;
}

function groundDots(cols: number): Dot[] {
	const dots: Dot[] = [];
	const r = DOT_FILL / 2;
	GROUND_TILE.forEach((row, y) => {
		for (let x = 0; x < cols; x++) {
			if (row[x % GROUND_TILE_UNITS] !== "#") continue;
			dots.push({ x, y, cx: x + 0.5, cy: y + 0.5, r, fill: y === 0 ? GROUND_LINE_COLOR : GROUND_PEBBLE, part: "ink" });
		}
	});
	return dots;
}

interface Bitmaps {
	scale: number;
	/** run-a, run-b, jump, failed, done, idle */
	dino: HTMLCanvasElement[];
	obstacles: HTMLCanvasElement[];
	obstacleTop: Int32Array;
	ground: HTMLCanvasElement;
}

const DINO_FRAME_RUN_A = 0;
const DINO_FRAME_RUN_B = 1;
const DINO_FRAME_JUMP = 2;
const DINO_FRAME_FAILED = 3;
const DINO_FRAME_DONE = 4;
const DINO_FRAME_IDLE = 5;

const DINO_FRAMES = ["run-a", "run-b", "jump", "failed", "done"] as const;

/** Dots of dino frame `frame` (DINO_FRAME_*) of a species. */
function dinoFrameDots(frame: number, species: SpeciesId): Dot[] {
	return frame === DINO_FRAME_IDLE ? spriteDots(poseSprite("idle", undefined, species), { fill: DOT_FILL }) : runnerDinoDots(DINO_FRAMES[frame] ?? "run-a", DOT_FILL, species);
}

/** run-a, run-b, jump, failed, done, idle of one species at one scale. */
function buildDino(scale: number, species: SpeciesId): HTMLCanvasElement[] {
	return [0, 1, 2, 3, 4, DINO_FRAME_IDLE].map((f) => bitmap(dinoFrameDots(f, species), DINO_W, DINO_H, scale));
}

function buildBitmaps(scale: number, groundCols: number, species: SpeciesId): Bitmaps {
	const dino = buildDino(scale, species);
	const obstacles: HTMLCanvasElement[] = [];
	const obstacleTop = new Int32Array(KIND_COUNT);
	for (let k = 0; k < KIND_COUNT; k++) {
		const sprite = OBSTACLES[KINDS[k] as (typeof KINDS)[number]];
		obstacles.push(bitmap(obstacleDots(sprite.name, DOT_FILL), sprite.cols, sprite.rows.length, scale));
		obstacleTop[k] = Math.round(sprite.rows.length * scale);
	}
	const ground = bitmap(groundDots(groundCols), groundCols, GROUND_TILE.length, scale);
	return { scale, dino, obstacles, obstacleTop, ground };
}

// ---------------------------------------------------------------- storage

function load(key: string): string | null {
	try {
		return window.localStorage.getItem(key);
	} catch {
		return null;
	}
}

function save(key: string, value: string | null): void {
	try {
		if (value === null) window.localStorage.removeItem(key);
		else window.localStorage.setItem(key, value);
	} catch {
		/* storage blocked: the setting lasts for this page view only */
	}
}

// ---------------------------------------------------------------- DOM helpers

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, parent?: HTMLElement): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	node.className = className;
	parent?.appendChild(node);
	return node;
}

/** Five digit spans, each holding one Text node, so a score update only swaps constant strings. */
function digits(parent: HTMLElement): Text[] {
	const wrap = el("span", "runner__digits", parent);
	const out: Text[] = [];
	for (let i = 0; i < SCORE_DIGITS; i++) {
		const t = document.createTextNode("0");
		el("span", "", wrap).appendChild(t);
		out.push(t);
	}
	return out;
}

function setDigits(nodes: Text[], value: number): void {
	let v = value;
	for (let i = nodes.length - 1; i >= 0; i--) {
		const d = DIGITS[v % 10] as string;
		const node = nodes[i] as Text;
		if (node.data !== d) node.data = d;
		v = Math.floor(v / 10);
	}
}

// ---------------------------------------------------------------- mount

export function mountRunner(host: HTMLElement, options: { locale: Locale; species?: SpeciesId }): RunnerHandle {
	const labels: RunnerLabels = RUNNER_LABELS[options.locale] ?? RUNNER_LABELS.en;
	const id = `runner-${++uid}`;
	const saved = {
		runner: host.getAttribute("data-runner"),
		tabindex: host.getAttribute("tabindex"),
		role: host.getAttribute("role"),
		label: host.getAttribute("aria-label"),
		describedby: host.getAttribute("aria-describedby"),
	};
	if (!saved.runner) host.setAttribute("data-runner", "ready");
	host.classList.add("runner");
	host.setAttribute("role", "group");
	host.setAttribute("aria-label", labels.region);
	host.setAttribute("aria-describedby", `${id}-desc`);

	const stripes = el("div", "runner__stripes stripes", host);
	stripes.setAttribute("aria-hidden", "true");
	const canvas = el("canvas", "runner__canvas", host);
	canvas.setAttribute("aria-hidden", "true");
	const hud = el("div", "runner__hud", host);
	hud.setAttribute("aria-hidden", "true");
	const hint = el("span", "runner__hint", hud);
	const scoreBox = el("span", "runner__score", hud);
	const scoreDigits = digits(scoreBox);
	const hiBox = el("span", "runner__hi", hud);
	el("span", "runner__hi-label", hiBox).textContent = labels.hi;
	const hiDigits = digits(hiBox);
	const minimizeButton = el("button", "runner__button", host);
	minimizeButton.type = "button";
	minimizeButton.setAttribute("aria-label", labels.minimize);
	minimizeButton.title = labels.minimize;
	const restoreButton = el("button", "runner__restore", host);
	restoreButton.type = "button";
	const tab = el("canvas", "runner__tab", restoreButton);
	tab.setAttribute("aria-hidden", "true");
	el("span", "", restoreButton).textContent = labels.restore;
	const desc = el("span", "runner__sr", host);
	desc.id = `${id}-desc`;
	desc.textContent = labels.description;
	const live = el("span", "runner__sr", host);
	live.setAttribute("aria-live", "polite");
	const created = [stripes, canvas, hud, minimizeButton, restoreButton, desc, live];

	const ctx = canvas.getContext("2d", { alpha: true });
	const reducedQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
	const touch = window.matchMedia("(pointer: coarse)").matches;

	// ---- state
	const storedHi = Number.parseInt(load(STORE_HI) ?? "0", 10);
	let species: SpeciesId = options.species && isSpeciesId(options.species) ? options.species : DEFAULT_SPECIES;
	const sim: Sim = createSim((Date.now() ^ (Math.random() * 0x7fffffff)) >>> 0, 600, 60, BOXES[species]);
	sim.hi = Number.isFinite(storedHi) && storedHi > 0 ? storedHi : 0;
	let minimized = load(STORE_MIN) === "1";
	let reduced = reducedQuery.matches;
	let hidden = document.visibilityState === "hidden";
	let onscreen = true;
	let running = false;
	let raf = 0;
	let last = -1;
	let lastScrollY = 0;
	/** Latest scroll offset, written by a passive scroll listener. Reading window.scrollY inside the frame would
	 * force a synchronous style/layout update whenever another rAF callback or animation dirtied styles. */
	let scrollTop = window.scrollY;
	let scrollVel = 0;

	// layout (device pixels unless noted)
	let cw = 0;
	let ch = 0;
	let scale = 1;
	let groundPx = 0;
	let tilePx = 1;
	let bitmaps: Bitmaps | null = null;

	// what the DOM currently shows
	let shownMode = "";
	let shownDino = "";
	let shownJumps = -1;
	let shownScore = -1;
	let shownHi = -1;
	let savedHi = sim.hi;

	// reduced-motion and minimized views
	let staticFrame = DINO_FRAME_IDLE;
	let staticJumps = 0;
	let staticY = 0;
	let timer = 0;

	function setAttr(name: string, value: string): void {
		if (host.getAttribute(name) !== value) host.setAttribute(name, value);
	}

	// ---- layout
	function layout(cssW: number, cssH: number): void {
		if (cssW < 1 || cssH < 1) return;
		const dpr = Math.min(DPR_MAX, window.devicePixelRatio || 1);
		cw = Math.round(cssW * dpr);
		ch = Math.round(cssH * dpr);
		if (canvas.width !== cw) canvas.width = cw;
		if (canvas.height !== ch) canvas.height = ch;
		// The canvas reaches PEEK css px above the bar (runner.css), so a jump's apex may peek over the top hairline like
		// the Chrome original; the dino stays 30-34 px tall in a 64 px bar (24-28 px in 52 px, BRIEF 12b.4).
		const { pitch, groundY } = barGeometry(cssH);
		const nextScale = pitch * dpr;
		groundPx = Math.round(groundY * dpr);
		tilePx = GROUND_TILE_UNITS * nextScale;
		const viewUnits = cw / nextScale;
		// Size the ground strip for the whole bar, not just the canvas: the canvas widens when the HUD hint hides on the
		// first jump, and rebuilding every bitmap then cost a 60-75 ms long task mid-game (qa-fix).
		const maxW = Math.max(cw, Math.round(host.clientWidth * dpr));
		const groundCols = (Math.ceil(maxW / nextScale / GROUND_TILE_UNITS) + 2) * GROUND_TILE_UNITS;
		if (!bitmaps || bitmaps.scale !== nextScale || bitmaps.ground.width < cw + tilePx) {
			bitmaps = buildBitmaps(nextScale, groundCols, species);
			// Warm-up: draw every bitmap once now, so texture uploads happen here and not in the first frame using them.
			if (ctx) {
				for (const bmp of bitmaps.dino) ctx.drawImage(bmp, 0, 0);
				for (const bmp of bitmaps.obstacles) ctx.drawImage(bmp, 0, 0);
				ctx.drawImage(bitmaps.ground, 0, 0);
				ctx.clearRect(0, 0, cw, ch);
			}
		}
		scale = nextScale;
		setView(sim, viewUnits, Math.round(Math.min(120, Math.max(14, viewUnits * 0.08))));
		if (!running) drawIdle();
	}

	// ---- drawing
	function draw(alpha: number): void {
		if (!ctx || !bitmaps) return;
		const d = sim.prevDist + (sim.dist - sim.prevDist) * alpha;
		const y = sim.prevY + (sim.y - sim.prevY) * alpha;
		ctx.clearRect(0, 0, cw, ch);
		ctx.drawImage(bitmaps.ground, -Math.round((d * scale) % tilePx), groundPx);
		for (let i = 0; i < sim.count; i++) {
			const slot = (sim.head + i) & 63;
			const x = Math.round(((sim.wx[slot] as number) - d) * scale);
			if (x >= cw) break;
			const k = sim.kind[slot] as number;
			const bmp = bitmaps.obstacles[k] as HTMLCanvasElement;
			if (x + bmp.width <= 0) continue;
			ctx.drawImage(bmp, x, groundPx - (bitmaps.obstacleTop[k] as number));
		}
		const f = face(sim);
		const frame =
			f === FACE_FAILED ? DINO_FRAME_FAILED : f === FACE_DONE ? DINO_FRAME_DONE : f === FACE_JUMP ? DINO_FRAME_JUMP : legFrame(sim, d) === 0 ? DINO_FRAME_RUN_A : DINO_FRAME_RUN_B;
		// celebrate()'s double jump rises above APEX; hold the dino at the canvas top instead of cropping its head.
		ctx.drawImage(bitmaps.dino[frame] as HTMLCanvasElement, Math.round(sim.dinoX * scale), Math.max(0, groundPx - Math.round((DINO_H + y) * scale)));
	}

	/** Reduced motion: ground, one cactus ahead, the standing (or jumping / done) dino. No loop. */
	function drawStatic(): void {
		if (!ctx || !bitmaps) return;
		ctx.clearRect(0, 0, cw, ch);
		ctx.drawImage(bitmaps.ground, 0, groundPx);
		const k = 0; // cactus
		const cactus = bitmaps.obstacles[k] as HTMLCanvasElement;
		const cx = Math.round((sim.dinoX + Math.min(140, sim.viewUnits * 0.4)) * scale);
		if (cx + cactus.width < cw) ctx.drawImage(cactus, cx, groundPx - (bitmaps.obstacleTop[k] as number));
		ctx.drawImage(bitmaps.dino[staticFrame] as HTMLCanvasElement, Math.round(sim.dinoX * scale), groundPx - Math.round((DINO_H + staticY) * scale));
	}

	function drawIdle(): void {
		if (minimized) return;
		if (reduced) drawStatic();
		else draw(1);
	}

	function drawTab(frame: number): void {
		const dpr = Math.min(DPR_MAX, window.devicePixelRatio || 1);
		const tabScale = dpr; // 1 css px per dot: 30x18
		if (tab.width !== DINO_W * dpr) tab.width = DINO_W * dpr;
		if (tab.height !== DINO_H * dpr) tab.height = DINO_H * dpr;
		const tctx = tab.getContext("2d");
		if (!tctx) return;
		tctx.clearRect(0, 0, tab.width, tab.height);
		tctx.drawImage(bitmap(dinoFrameDots(frame, species), DINO_W, DINO_H, tabScale), 0, 0);
	}

	// ---- DOM state
	function syncHud(mode: string): void {
		const showHint = mode === "auto" || mode === "failed" || mode === "static";
		hint.hidden = !showHint;
		if (showHint) {
			hint.textContent =
				mode === "failed"
					? touch
						? labels.hintRetryTouch
						: labels.hintRetry
					: mode === "static"
						? touch
							? labels.hintStaticTouch
							: labels.hintStatic
						: touch
							? labels.hintPlayTouch
							: labels.hintPlay;
		}
		scoreBox.hidden = !(mode === "play" || mode === "failed");
	}

	function sync(): void {
		const mode = minimized ? "minimized" : reduced ? "static" : (MODE_NAMES[sim.mode] as string);
		if (mode !== shownMode) {
			if (mode === "failed" && shownMode === "play") live.textContent = `${labels.gameOver} ${sim.score}`;
			shownMode = mode;
			setAttr("data-mode", mode);
			syncHud(mode);
		}
		const dino = minimized || reduced ? (staticFrame === DINO_FRAME_JUMP ? "jump" : staticFrame === DINO_FRAME_DONE ? "done" : "run") : (FACE_NAMES[face(sim)] as string);
		if (dino !== shownDino) {
			shownDino = dino;
			setAttr("data-dino", dino);
		}
		const jumps = sim.jumps + staticJumps;
		if (jumps !== shownJumps) {
			shownJumps = jumps;
			host.setAttribute("data-jumps", String(jumps));
		}
		if (sim.score !== shownScore) {
			shownScore = sim.score;
			setDigits(scoreDigits, sim.score);
		}
		if (sim.hi !== shownHi) {
			shownHi = sim.hi;
			setDigits(hiDigits, sim.hi);
			hiBox.hidden = sim.hi === 0;
			if (sim.hi > savedHi) {
				savedHi = sim.hi;
				save(STORE_HI, String(sim.hi));
			}
		}
	}

	// ---- loop
	const frame = (now: number): void => {
		if (!running) return;
		const t0 = performance.now();
		const dt = last < 0 ? 0 : (now - last) / 1000;
		last = now;
		if (dt > 0) {
			// Scroll sprint (auto mode): the offset comes from the scroll event, so the frame never forces layout.
			const sy = scrollTop;
			const v = Math.abs(sy - lastScrollY) / dt;
			lastScrollY = sy;
			scrollVel += (v - scrollVel) * Math.min(1, dt / SCROLL_TAU);
			const boost = 1 + scrollVel / SCROLL_PER_BOOST;
			sim.boost = boost > BOOST_MAX ? BOOST_MAX : boost;
		}
		const alpha = advance(sim, dt);
		draw(alpha);
		sync();
		const cost = performance.now() - t0;
		runnerStats.ring[runnerStats.frames & 2047] = cost;
		runnerStats.frames++;
		runnerStats.total += cost;
		if (cost > runnerStats.max) runnerStats.max = cost;
		if (cost > 1) runnerStats.over1ms++;
		raf = requestAnimationFrame(frame);
	};

	function refresh(): void {
		const shouldRun = !minimized && !reduced && !hidden && onscreen;
		if (shouldRun && !running) {
			running = true;
			last = -1;
			lastScrollY = scrollTop;
			scrollVel = 0;
			raf = requestAnimationFrame(frame);
		} else if (!shouldRun && running) {
			running = false;
			cancelAnimationFrame(raf);
		}
		if (!running) drawIdle();
		sync();
	}

	// ---- views
	function applyMinimized(): void {
		for (const node of [stripes, canvas, hud, minimizeButton]) node.hidden = minimized;
		restoreButton.hidden = !minimized;
		host.tabIndex = minimized ? -1 : 0;
		if (minimized) drawTab(DINO_FRAME_IDLE);
	}

	function setMinimized(value: boolean): void {
		if (minimized === value) return;
		const hadFocus = host.contains(document.activeElement);
		minimized = value;
		save(STORE_MIN, value ? "1" : null);
		applyMinimized();
		refresh();
		if (hadFocus) (value ? restoreButton : host).focus({ preventScroll: true });
	}

	function clearTimer(): void {
		if (timer) window.clearTimeout(timer);
		timer = 0;
	}

	/** Reduced motion: one tap = one jump as two instant states (up, then down after the airtime). */
	function staticJump(): void {
		if (staticFrame === DINO_FRAME_JUMP) return;
		clearTimer();
		staticFrame = DINO_FRAME_JUMP;
		staticY = APEX;
		staticJumps++;
		drawStatic();
		sync();
		timer = window.setTimeout(() => {
			timer = 0;
			staticFrame = DINO_FRAME_IDLE;
			staticY = 0;
			drawIdle();
			sync();
		}, AIRTIME * 1000);
	}

	function input(): void {
		if (minimized) return;
		if (reduced) {
			staticJump();
			return;
		}
		press(sim);
		if (!running) refresh();
		else sync();
	}

	function celebrate(): void {
		if (minimized || reduced) {
			// No motion here: the done face for a moment, then back.
			clearTimer();
			staticFrame = DINO_FRAME_DONE;
			staticY = 0;
			if (minimized) drawTab(DINO_FRAME_DONE);
			else drawStatic();
			sync();
			timer = window.setTimeout(() => {
				timer = 0;
				staticFrame = DINO_FRAME_IDLE;
				if (minimized) drawTab(DINO_FRAME_IDLE);
				else drawIdle();
				sync();
			}, DONE_TIME * 1000);
			return;
		}
		simCelebrate(sim);
		if (!running) drawIdle();
		sync();
	}

	// ---- events
	const onKey = (e: KeyboardEvent): void => {
		if (e.target !== host) return; // never capture Space for the page or for the buttons
		if (e.code === "Space" || e.key === " " || e.key === "ArrowUp") {
			e.preventDefault();
			if (!e.repeat) input();
		}
	};
	const onPointer = (e: PointerEvent): void => {
		if (e.button !== 0 || minimized) return;
		if (e.target instanceof Element && e.target.closest("button")) return;
		input();
	};
	const onMinimize = (): void => setMinimized(true);
	const onRestore = (): void => setMinimized(false);
	const onVisibility = (): void => {
		hidden = document.visibilityState === "hidden";
		refresh();
	};
	const onReduced = (): void => {
		reduced = reducedQuery.matches;
		staticFrame = DINO_FRAME_IDLE;
		staticY = 0;
		refresh();
	};
	const onJoined = (): void => celebrate();

	const onScroll = (): void => {
		scrollTop = window.scrollY;
	};
	window.addEventListener("scroll", onScroll, { passive: true });
	host.addEventListener("keydown", onKey);
	host.addEventListener("pointerdown", onPointer);
	minimizeButton.addEventListener("click", onMinimize);
	restoreButton.addEventListener("click", onRestore);
	document.addEventListener("visibilitychange", onVisibility);
	reducedQuery.addEventListener("change", onReduced);
	window.addEventListener("dinobot:joined", onJoined);

	const resize = new ResizeObserver((entries) => {
		for (const entry of entries) layout(entry.contentRect.width, entry.contentRect.height);
	});
	resize.observe(canvas);
	const visible = new IntersectionObserver((entries) => {
		for (const entry of entries) onscreen = entry.isIntersecting;
		refresh();
	});
	visible.observe(host);

	applyMinimized();
	refresh();

	function setSpecies(id: SpeciesId): void {
		if (!isSpeciesId(id) || id === species) return;
		species = id;
		setDino(sim, BOXES[id]);
		if (bitmaps) {
			bitmaps.dino = buildDino(bitmaps.scale, id);
			if (ctx) {
				for (const bmp of bitmaps.dino) ctx.drawImage(bmp, 0, 0);
				ctx.clearRect(0, 0, cw, ch);
			}
		}
		host.setAttribute("data-species", id);
		if (minimized) drawTab(staticFrame);
		else if (!running) drawIdle();
	}
	host.setAttribute("data-species", species);

	return {
		celebrate,
		setSpecies,
		destroy() {
			running = false;
			cancelAnimationFrame(raf);
			clearTimer();
			resize.disconnect();
			visible.disconnect();
			window.removeEventListener("scroll", onScroll);
			host.removeEventListener("keydown", onKey);
			host.removeEventListener("pointerdown", onPointer);
			minimizeButton.removeEventListener("click", onMinimize);
			restoreButton.removeEventListener("click", onRestore);
			document.removeEventListener("visibilitychange", onVisibility);
			reducedQuery.removeEventListener("change", onReduced);
			window.removeEventListener("dinobot:joined", onJoined);
			for (const node of created) node.remove();
			host.classList.remove("runner");
			for (const name of ["data-mode", "data-dino", "data-jumps", "data-species"]) host.removeAttribute(name);
			const restore = (name: string, value: string | null) => (value === null ? host.removeAttribute(name) : host.setAttribute(name, value));
			restore("data-runner", saved.runner);
			restore("tabindex", saved.tabindex);
			restore("role", saved.role);
			restore("aria-label", saved.label);
			restore("aria-describedby", saved.describedby);
		},
	};
}
