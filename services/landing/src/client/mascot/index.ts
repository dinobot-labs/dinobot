/**
 * The mounted dot-matrix dinosaur (BRIEF 10 contract): inline SVG dots from src/brand/mascot.ts, any species of
 * src/brand/species.ts (ADR 0100: rex the T-rex by default, ptero, brachio).
 *
 * Layers (each an absolutely stacked SVG or div, so character motion is compositor-friendly transforms):
 *   .mascot (sized box, aspect 30/18)
 *     .mascot__jump    jump(): WAAPI translate + squash, limbs tucked (or the wing raised) mid-air
 *       svg limbs      the species' limb rectangle (limbRectOf): the T-rex and brachiosaur legs in rows 13-17, the
 *                      pterosaur's wing in columns 0-15 of every row
 *       .mascot__torso idle breathing: a 0.5% rise, WAAPI, compositor
 *         svg body     every other cell (eye cell, mouth, cheek, ridge, belly)
 *         svg pupil    the ink pupil + glint, translated toward the pointer (one rAF per pointer move)
 * Both SVGs span the whole 30x18 viewBox, so no species is clipped by the split. State changes diff the dots by cell
 * (only the eye cell, mouth or limbs change), so they are a few attribute writes; setSpecies() diffs the same way.
 * A flying species also flaps its wing now and then while visible (like the blink, off under reduced motion).
 * Everything animated is off under prefers-reduced-motion and paused offscreen; colors are SVG fill attributes and
 * layout uses CSSOM properties (CSP-safe: no style attributes, no injected <style>).
 */
import {
	DEFAULT_SPECIES,
	MASCOT_COLS,
	MASCOT_ROWS,
	POSES,
	PUPIL_TRAVEL,
	type PoseName,
	type PoseSpec,
	type PupilOffset,
	type SpeciesId,
	eyeCellOf,
	isSpeciesId,
	limbRectOf,
	poseSprite,
	pupilDots,
	spriteDots,
} from "../../brand/mascot.ts";
import type { LimbFrame } from "../../brand/species.ts";

/** idle | done | failed (the TUI states) plus every pose of src/brand/mascot.ts (blink, look-*, happy, run-a/b, jump). */
export type MascotState = PoseName;

export interface MascotOptions {
	state?: MascotState;
	/** Eye follows the pointer (rAF-throttled, disabled under reduced motion). */
	trackPointer?: boolean;
	/** Accessible label; decorative when omitted. */
	label?: string;
	/** Rendered width in CSS px; height follows the 30x18 grid. Fluid (100% of the host) when omitted. */
	size?: number;
	/** Which dinosaur (src/brand/species.ts); the T-rex when omitted. */
	species?: SpeciesId;
}

export interface MascotHandle {
	setState(state: MascotState): void;
	/** Swap the dinosaur in place (same state, no re-assembly); unknown ids are ignored. */
	setSpecies(id: SpeciesId): void;
	jump(): void;
	destroy(): void;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const ASSEMBLY_MAX_MS = 900;
const ASSEMBLY_BANDS = 10;
const BLINK_MS = 140;
const JUMP_MS = 620;
/** One wing beat frame of a flying species, and the beat sequence (up, down, glide). */
const FLAP_MS = 120;
const FLAP: readonly LimbFrame[] = ["run-a", "run-b", "run-a", "stand"];

/** A species flies when its limb rectangle is a wing spanning every row (not legs at the bottom). */
const flies = (id: SpeciesId): boolean => {
	const r = limbRectOf(id);
	return r.y === 0 && r.h === MASCOT_ROWS;
};

function svgLayer(className: string): SVGSVGElement {
	const svg = document.createElementNS(SVG_NS, "svg");
	svg.setAttribute("viewBox", `0 0 ${MASCOT_COLS} ${MASCOT_ROWS}`);
	svg.setAttribute("class", className);
	svg.setAttribute("aria-hidden", "true");
	svg.setAttribute("focusable", "false");
	stack(svg);
	svg.style.overflow = "visible";
	return svg;
}

function stack(el: HTMLElement | SVGElement): void {
	el.style.position = "absolute";
	el.style.inset = "0";
	el.style.width = "100%";
	el.style.height = "100%";
}

function div(className: string): HTMLDivElement {
	const d = document.createElement("div");
	d.className = className;
	stack(d);
	return d;
}

/** A layer of dots keyed by cell, updated in place on pose changes. */
class DotLayer {
	readonly circles = new Map<string, SVGCircleElement>();
	constructor(readonly svg: SVGSVGElement) {}

	apply(dots: readonly { cx: number; cy: number; r: number; fill: string }[]): void {
		const seen = new Set<string>();
		for (const d of dots) {
			const key = `${d.cx},${d.cy}`;
			seen.add(key);
			let c = this.circles.get(key);
			if (!c) {
				c = document.createElementNS(SVG_NS, "circle");
				c.setAttribute("cx", String(d.cx));
				c.setAttribute("cy", String(d.cy));
				this.circles.set(key, c);
				this.svg.append(c);
			}
			const r = String(d.r);
			if (c.getAttribute("r") !== r) c.setAttribute("r", r);
			if (c.getAttribute("fill") !== d.fill) c.setAttribute("fill", d.fill);
		}
		for (const [key, c] of this.circles) {
			if (!seen.has(key)) {
				c.remove();
				this.circles.delete(key);
			}
		}
	}
}

export function mountMascot(host: HTMLElement, options: MascotOptions = {}): MascotHandle {
	const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
	const motion = () => !reduced.matches;

	const root = document.createElement("div");
	root.className = "mascot";
	root.style.position = "relative";
	root.style.width = options.size ? `${options.size}px` : "100%";
	root.style.aspectRatio = `${MASCOT_COLS} / ${MASCOT_ROWS}`;
	root.style.pointerEvents = "none";
	if (options.label) {
		root.setAttribute("role", "img");
		root.setAttribute("aria-label", options.label);
	} else root.setAttribute("aria-hidden", "true");

	const jumpBox = div("mascot__jump");
	jumpBox.style.transformOrigin = "50% 100%";
	const legsSvg = svgLayer("mascot__legs");
	const torso = div("mascot__torso");
	torso.style.transformOrigin = "50% 100%";
	const bodySvg = svgLayer("mascot__body");
	const pupilSvg = svgLayer("mascot__pupil");
	const pupilTransition = "transform 140ms cubic-bezier(0.16, 1, 0.3, 1), opacity 80ms linear";
	if (motion()) pupilSvg.style.transition = pupilTransition;
	torso.append(bodySvg, pupilSvg);
	jumpBox.append(legsSvg, torso);
	root.append(jumpBox);
	host.append(root);

	const legs = new DotLayer(legsSvg);
	const body = new DotLayer(bodySvg);
	const pupilCircle = document.createElementNS(SVG_NS, "circle");
	const glintCircle = document.createElementNS(SVG_NS, "circle");
	pupilSvg.append(pupilCircle, glintCircle);

	let state: MascotState = options.state ?? "idle";
	let species: SpeciesId = options.species && isSpeciesId(options.species) ? options.species : DEFAULT_SPECIES;
	/** A wing beat frame overriding the pose's limbs (flying species only), or null. */
	let flap: LimbFrame | null = null;
	let blinking = false;
	let airborne = false;
	let visible = false;
	let destroyed = false;

	/** The pose actually drawn: the state's spec with the blink and jump overrides. */
	function spec(): PoseSpec {
		const base: PoseSpec = POSES[state];
		const eyeOpen = base.eye !== "blink" && base.eye !== "arc" && base.eye !== "cross";
		return { eye: blinking && eyeOpen ? "blink" : base.eye, mouth: base.mouth, legs: airborne ? "jump" : (flap ?? base.legs) };
	}

	function render(): void {
		const sprite = poseSprite(spec(), undefined, species);
		const dots = spriteDots({ ...sprite, pupil: null });
		// The limb rectangle and the eye/mouth regions never overlap (species.ts contract), so ink strokes stay in the body.
		const r = limbRectOf(species);
		const inLimbs = (d: { x: number; y: number }) => d.x >= r.x && d.x < r.x + r.w && d.y >= r.y && d.y < r.y + r.h;
		legs.apply(dots.filter(inLimbs));
		body.apply(dots.filter((d) => !inLimbs(d)));
		const [pupil, glint] = pupilDots(sprite);
		if (pupil && glint) {
			for (const [c, d] of [
				[pupilCircle, pupil],
				[glintCircle, glint],
			] as const) {
				c.setAttribute("cx", String(d.cx));
				c.setAttribute("cy", String(d.cy));
				c.setAttribute("r", String(d.r));
				c.setAttribute("fill", d.fill);
			}
			pupilSvg.style.opacity = "1";
		} else pupilSvg.style.opacity = "0";
		root.dataset.mascot = state;
		root.dataset.species = species;
	}

	// ------------------------------------------------------------ breathing (compositor WAAPI, paused offscreen)
	let breath: Animation | null = null;
	function startBreath(): void {
		if (!motion() || breath) return;
		breath = torso.animate([{ transform: "translateY(0)" }, { transform: "translateY(-0.55%)" }], {
			duration: 1700,
			iterations: Number.POSITIVE_INFINITY,
			direction: "alternate",
			easing: "cubic-bezier(0.65, 0, 0.35, 1)",
		});
	}

	// ------------------------------------------------------------ blink (random 2.5-6 s)
	let blinkTimer = 0;
	function scheduleBlink(): void {
		window.clearTimeout(blinkTimer);
		if (!motion() || !visible || destroyed) return;
		blinkTimer = window.setTimeout(blink, 2500 + Math.random() * 3500);
	}
	function blink(): void {
		if (!visible || destroyed) return;
		blinking = true;
		render();
		blinkTimer = window.setTimeout(() => {
			blinking = false;
			render();
			// Now and then a double blink, like a real one.
			if (Math.random() < 0.18) {
				blinkTimer = window.setTimeout(() => {
					blinking = true;
					render();
					blinkTimer = window.setTimeout(() => {
						blinking = false;
						render();
						scheduleBlink();
					}, BLINK_MS);
				}, 180);
			} else scheduleBlink();
		}, BLINK_MS);
	}

	// ------------------------------------------------------------ wing beat (flying species, random 3.5-7 s)
	let flapTimer = 0;
	function scheduleFlap(): void {
		window.clearTimeout(flapTimer);
		if (flap !== null) {
			flap = null;
			render();
		}
		if (!motion() || !visible || destroyed || !flies(species)) return;
		flapTimer = window.setTimeout(() => beat(0), 3500 + Math.random() * 3500);
	}
	function beat(i: number): void {
		if (!visible || destroyed || !motion() || !flies(species)) {
			scheduleFlap();
			return;
		}
		const frame = FLAP[i];
		if (frame === undefined) {
			scheduleFlap();
			return;
		}
		flap = frame === "stand" ? null : frame;
		if (!airborne) render();
		flapTimer = window.setTimeout(() => beat(i + 1), FLAP_MS);
	}

	// ------------------------------------------------------------ eye tracking (one rAF per pointer move)
	let pointerX = 0;
	let pointerY = 0;
	let lookFrame = 0;
	let lastTransform = "";
	function onPointer(event: PointerEvent): void {
		pointerX = event.clientX;
		pointerY = event.clientY;
		if (!lookFrame && visible && motion()) lookFrame = window.requestAnimationFrame(look);
	}
	function look(): void {
		lookFrame = 0;
		const rect = root.getBoundingClientRect();
		if (rect.width === 0) return;
		const pitch = rect.width / MASCOT_COLS;
		const sprite = poseSprite(spec(), undefined, species);
		if (!sprite.pupil) return;
		const eye = eyeCellOf(species);
		const centerX = eye.x + eye.size / 2;
		const centerY = eye.y + eye.size / 2;
		const ex = rect.left + centerX * pitch;
		const ey = rect.top + centerY * pitch;
		const dx = pointerX - ex;
		const dy = pointerY - ey;
		const dist = Math.hypot(dx, dy) || 1;
		// Full travel once the pointer is a few dots away; the pupil eases back toward center as it gets close.
		const reach = Math.min(1, dist / (pitch * 8)) * PUPIL_TRAVEL * pitch;
		// The pupil circle already sits at the pose's offset; translate it to the tracked offset instead.
		const base: PupilOffset = { dx: sprite.pupil.cx - centerX, dy: sprite.pupil.cy - centerY };
		const tx = (dx / dist) * reach - base.dx * pitch;
		const ty = (dy / dist) * reach - base.dy * pitch;
		const t = `translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px)`;
		if (t !== lastTransform) {
			pupilSvg.style.transform = t;
			lastTransform = t;
		}
	}
	const tracking = options.trackPointer === true;
	if (tracking) window.addEventListener("pointermove", onPointer, { passive: true });

	// ------------------------------------------------------------ assembly from scattered dots (first view)
	// Compositor-only (BRIEF 8, measured: per-dot SVG animations repainted ~350 circles per frame and dropped frames
	// under 120 fps while scrolling). The dots are cloned into ASSEMBLY_BANDS column bands, each an HTML layer that
	// drifts in from the tail side with transform/opacity; the real layers are revealed when the bands have landed.
	let assembled = !motion();
	function assemble(): void {
		assembled = true;
		let seed = 0x2f6b;
		const rand = () => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed / 0x7fffffff;
		};
		const travel = 520;
		const spread = ASSEMBLY_MAX_MS - travel - 60;
		const overlay = div("mascot__assembly");
		const bands: SVGSVGElement[] = [];
		for (let b = 0; b < ASSEMBLY_BANDS; b++) {
			const layer = div("mascot__band");
			const svg = svgLayer("mascot__band-dots");
			layer.append(svg);
			overlay.append(layer);
			bands.push(svg);
		}
		for (const c of [...legs.circles.values(), ...body.circles.values()]) {
			const x = Number(c.getAttribute("cx"));
			const band = Math.min(ASSEMBLY_BANDS - 1, Math.floor((x / MASCOT_COLS) * ASSEMBLY_BANDS));
			bands[band]?.append(c.cloneNode(false));
		}
		const running: Animation[] = [];
		overlay.childNodes.forEach((layer, b) => {
			const sx = -(5 + rand() * 7);
			const sy = (rand() - 0.5) * 18;
			running.push(
				(layer as HTMLElement).animate(
					[
						{ transform: `translate(${sx.toFixed(1)}%, ${sy.toFixed(1)}%) scale(0.92)`, opacity: 0 },
						{ transform: "translate(0, 0) scale(1)", opacity: 1 },
					],
					{ duration: travel, delay: (b / ASSEMBLY_BANDS) * spread, easing: "cubic-bezier(0.16, 1, 0.3, 1)", fill: "backwards" },
				),
			);
		});
		jumpBox.style.opacity = "0";
		root.append(overlay);
		root.style.opacity = "1";
		window.setTimeout(() => {
			jumpBox.style.opacity = "";
			overlay.remove();
			for (const a of running) a.cancel();
			if (!destroyed) pupilSvg.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160 });
		}, ASSEMBLY_MAX_MS + 20);
	}

	// ------------------------------------------------------------ visibility
	function setVisible(next: boolean): void {
		visible = next;
		if (next) {
			if (!assembled) assemble();
			startBreath();
			breath?.play();
			scheduleBlink();
			scheduleFlap();
		} else {
			breath?.pause();
			window.clearTimeout(blinkTimer);
			window.clearTimeout(flapTimer);
			flap = null;
			if (blinking) {
				blinking = false;
				render();
			}
		}
	}
	const io = new IntersectionObserver((entries) => {
		const entry = entries[entries.length - 1];
		if (entry) setVisible(entry.isIntersecting);
	});
	io.observe(root);
	const onVisibility = () => setVisible(document.visibilityState === "visible" && isOnScreen());
	const isOnScreen = () => {
		const r = root.getBoundingClientRect();
		return r.bottom > 0 && r.top < window.innerHeight;
	};
	document.addEventListener("visibilitychange", onVisibility);

	const onMotionChange = () => {
		pupilSvg.style.transition = motion() ? pupilTransition : "";
		if (!motion()) {
			breath?.cancel();
			breath = null;
			window.clearTimeout(blinkTimer);
			window.clearTimeout(flapTimer);
			if (flap !== null) {
				flap = null;
				render();
			}
			pupilSvg.style.transform = "";
			lastTransform = "";
		} else if (visible) setVisible(true);
	};
	reduced.addEventListener("change", onMotionChange);

	// ------------------------------------------------------------ jump
	let jumpAnim: Animation | null = null;
	let jumpTimers: number[] = [];
	function jump(): void {
		if (!motion() || destroyed) return;
		jumpAnim?.cancel();
		for (const t of jumpTimers) window.clearTimeout(t);
		jumpAnim = jumpBox.animate(
			[
				{ transform: "translateY(0) scale(1, 1)", easing: "cubic-bezier(0.3, 0, 0.6, 1)" },
				{ transform: "translateY(0) scale(1.04, 0.94)", offset: 0.12, easing: "cubic-bezier(0.2, 0.7, 0.4, 1)" },
				{ transform: "translateY(-30%) scale(0.98, 1.03)", offset: 0.5, easing: "cubic-bezier(0.6, 0, 0.8, 0.4)" },
				{ transform: "translateY(0) scale(1.04, 0.95)", offset: 0.86, easing: "cubic-bezier(0.2, 0.7, 0.4, 1)" },
				{ transform: "translateY(0) scale(1, 1)" },
			],
			{ duration: JUMP_MS },
		);
		jumpTimers = [
			window.setTimeout(() => {
				airborne = true;
				render();
			}, JUMP_MS * 0.14),
			window.setTimeout(() => {
				airborne = false;
				render();
			}, JUMP_MS * 0.84),
		];
	}

	const onJoined = () => {
		state = "done";
		render();
		jump();
		window.setTimeout(jump, JUMP_MS + 60);
	};
	window.addEventListener("dinobot:joined", onJoined);

	render();
	if (!assembled) root.style.opacity = "0";

	return {
		setState(next) {
			if (!(next in POSES)) return;
			state = next;
			render();
			if (tracking && visible && !lookFrame) lookFrame = window.requestAnimationFrame(look);
		},
		setSpecies(id) {
			if (!isSpeciesId(id) || id === species || destroyed) return;
			species = id;
			flap = null;
			render();
			// The eye moved with the species: re-aim the pupil (or drop a stale translate when not tracking).
			pupilSvg.style.transform = "";
			lastTransform = "";
			if (tracking && visible && motion() && !lookFrame) lookFrame = window.requestAnimationFrame(look);
			if (visible) scheduleFlap();
		},
		jump,
		destroy() {
			destroyed = true;
			io.disconnect();
			breath?.cancel();
			jumpAnim?.cancel();
			window.clearTimeout(blinkTimer);
			window.clearTimeout(flapTimer);
			for (const t of jumpTimers) window.clearTimeout(t);
			if (lookFrame) window.cancelAnimationFrame(lookFrame);
			window.removeEventListener("pointermove", onPointer);
			window.removeEventListener("dinobot:joined", onJoined);
			document.removeEventListener("visibilitychange", onVisibility);
			reduced.removeEventListener("change", onMotionChange);
			root.remove();
		},
	};
}
