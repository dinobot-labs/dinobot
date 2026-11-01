/**
 * The timeline player shared by the four strength scenes and the demo.
 *
 * A script (scripts.ts) is pure data: steps at fixed times that set an item's state (`data-s`, styled by CSS), swap
 * its text, rotate or move it, and optionally play one effect. Effects are Web Animations on transform and opacity
 * only (BRIEF 8). Scheduling uses one setTimeout for the next step: no rAF loop, nothing runs while paused.
 *
 * Invariants:
 * - `t` is the timeline time; while playing, t = now - base. A hold freezes t at its step until a tap or timeout.
 * - Every animation the engine starts is tracked, so pause() pauses all of them and seek()/reset() cancels them.
 * - seek(t) is deterministic: reset to the initial states, then apply every step with at <= t without effects
 *   (fills that are mid-way resume at their offset). seek(duration) is the final state used for reduced motion.
 */
import type { Labels, LabelKey } from "./labels.ts";
import { type Fx, type Script, type State, type Step, sortedSteps } from "./scripts.ts";

export interface Entry {
	/** carries data-s */
	el: HTMLElement | SVGElement;
	/** receives label swaps */
	textEl?: HTMLElement;
	/** receives literal text (counters) */
	valueEl?: HTMLElement;
	/** pulses on "tick" when present (counter values) */
	tickEl?: HTMLElement;
	/** dots that "draw" in sequence (edges) */
	dots?: readonly SVGElement[];
	init: { s: State; label?: LabelKey; text?: string; xy?: readonly [number, number]; rot?: number };
	/** live position (pointer) or angle (arm) */
	xy?: [number, number];
	rot?: number;
	center?: readonly [number, number];
	setPose?(pose: string): void;
}

export type Registry = Map<string, Entry>;

export interface TimelineOptions {
	script: Script;
	registry: Registry;
	labels: Labels;
	/** stage element: carries data-paused (pauses CSS loops) and fades between loops */
	stage: HTMLElement;
	loop: boolean;
	say?(text: string): void;
	onChapter?(t: number): void;
	onEnd?(): void;
	onHold?(id: string | null): void;
}

const EASE_OUT = "cubic-bezier(0.16, 1, 0.3, 1)";
const ENTRANCES: ReadonlySet<Fx> = new Set(["fade", "pop", "rise", "fly"]);
const EASE_IN_OUT = "cubic-bezier(0.65, 0, 0.35, 1)";
let springSnappy = "cubic-bezier(0.34, 1.4, 0.64, 1)";

/** Read the spring curve from tokens.css once (falls back to an overshooting bezier). */
export function readMotionTokens(): void {
	try {
		const v = getComputedStyle(document.documentElement).getPropertyValue("--spring-snappy").trim();
		if (v.startsWith("linear(") && CSS.supports("transition-timing-function", v)) springSnappy = v;
	} catch {}
}

/**
 * How visible an "off" item is: its ghost (a static `opacity` below 1 in showcase.css), or 0 when it is hidden or is a
 * nested ghost (opacity 1 inside a ghosted parent, which then fades in from nothing as before).
 */
function ghostOpacity(el: Element): number {
	const o = Number(getComputedStyle(el).opacity);
	return o > 0 && o < 1 ? o : 0;
}

const FLY_MS = 680;
/** The flight that owns an item's data-fly flag. */
const flights = new WeakMap<Element, Animation>();
const SEND_MS = 520;

/** How long a moving effect runs; seek() restores these mid-way so a frozen frame shows them in flight. */
function travelMs(step: Step): number {
	if (step.fx === "fly") return step.dur ?? FLY_MS;
	if (step.fx === "send") return step.dur ?? SEND_MS;
	return 0;
}

function placeTransform(xy: readonly [number, number]): string {
	return `translate(${xy[0]}px, ${xy[1]}px)`;
}

/** Where the pointer rests on a button: a little below and right of its centre, so the label stays readable. */
export function tapPoint(c: readonly [number, number]): [number, number] {
	return [c[0] + 12, c[1] + 9];
}

export function setPointer(entry: Entry, xy: readonly [number, number]): void {
	entry.xy = [xy[0], xy[1]];
	entry.el.style.transform = placeTransform(xy);
}

export function setArm(entry: Entry, deg: number): void {
	entry.rot = deg;
	entry.el.style.transform = `rotate(${deg}deg)`;
}

export class Timeline {
	readonly steps: Step[];
	private i = 0;
	private t = 0;
	private base = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private live = new Set<Animation>();
	private kept = new Set<Animation>();
	private hold: { step: Step; remaining: number; since: number; anim?: Animation } | null = null;
	private ending = false;
	private ghostFrom = 0;
	private ghostTo = 0;
	playing = false;
	ended = false;

	constructor(readonly o: TimelineOptions) {
		this.steps = sortedSteps(o.script.steps);
		o.stage.setAttribute("data-paused", "");
	}

	get duration(): number {
		return this.o.script.duration;
	}

	get time(): number {
		return this.playing && !this.hold ? performance.now() - this.base : this.t;
	}

	play(): void {
		if (this.playing) return;
		if (this.ended) this.seek(0);
		this.playing = true;
		this.o.stage.removeAttribute("data-paused");
		this.base = performance.now() - this.t;
		for (const a of this.live) if (a.playState === "paused") a.play();
		if (this.hold) {
			this.hold.since = performance.now();
			this.armHold();
		} else this.schedule();
	}

	pause(): void {
		if (!this.playing) return;
		this.t = this.time;
		this.playing = false;
		clearTimeout(this.timer);
		this.timer = undefined;
		if (this.hold) this.hold.remaining = Math.max(0, this.hold.remaining - (performance.now() - this.hold.since));
		this.o.stage.setAttribute("data-paused", "");
		for (const a of this.live) if (a.playState === "running") a.pause();
	}

	/** Jump to timeline time t (deterministic, no effects). Keeps the play/pause state. */
	seek(t: number): void {
		clearTimeout(this.timer);
		this.timer = undefined;
		this.cancelAll();
		this.hold = null;
		this.ending = false;
		this.ended = false;
		this.reset();
		// t < 0 resets to the initial states without applying the steps at 0.
		const target = Math.min(t, this.duration);
		let i = 0;
		for (; i < this.steps.length; i++) {
			const step = this.steps[i]!;
			if (step.at > target) break;
			this.apply(step, false);
			if (step.hold) this.settleHold(step);
		}
		// Fills (progress bars) and moving things (fly, send) that are mid-way continue from their offset.
		for (const step of this.steps) {
			const span = step.fx === "fill" ? (step.dur ?? 0) : travelMs(step);
			if (span && step.at <= target && target < step.at + span) {
				const entry = this.o.registry.get(step.id);
				if (entry) this.fx(entry, step, target - step.at);
			}
		}
		this.i = i;
		this.t = Math.max(0, target);
		if (target >= this.duration && !this.o.loop) this.ended = true;
		if (this.playing) {
			this.base = performance.now() - this.t;
			this.schedule();
		} else for (const a of this.live) a.pause();
		this.o.onChapter?.(this.t);
	}

	/** Release a hold early (a human tapped the gate button). */
	release(id: string): void {
		if (!this.hold || this.hold.step.id !== id) return;
		const step = this.hold.step;
		this.hold.anim?.cancel();
		if (step.tap) {
			const ptr = this.o.registry.get(step.tap);
			const gate = this.o.registry.get(step.id);
			if (ptr && gate?.center) setPointer(ptr, tapPoint(gate.center));
		}
		this.finishHold();
	}

	destroy(): void {
		clearTimeout(this.timer);
		this.cancelAll();
		this.playing = false;
	}

	// ---------------------------------------------------------------- internals

	private reset(): void {
		for (const entry of this.o.registry.values()) {
			entry.el.setAttribute("data-s", entry.init.s);
			if (entry.init.label && entry.textEl) entry.textEl.textContent = this.o.labels[entry.init.label];
			if (entry.init.text !== undefined && entry.valueEl) entry.valueEl.textContent = entry.init.text;
			if (entry.init.xy) setPointer(entry, entry.init.xy);
			if (entry.init.rot !== undefined) setArm(entry, entry.init.rot);
			entry.setPose?.("idle");
		}
	}

	private schedule(): void {
		clearTimeout(this.timer);
		if (!this.playing || this.hold) return;
		const next = this.steps[this.i];
		const end = this.duration + this.o.script.rest;
		const at = next ? next.at : end;
		const wait = Math.max(0, at - (performance.now() - this.base));
		this.timer = setTimeout(() => this.tick(), wait);
	}

	private tick(): void {
		this.timer = undefined;
		if (!this.playing) return;
		const now = performance.now() - this.base;
		while (this.i < this.steps.length) {
			const step = this.steps[this.i]!;
			if (step.at > now + 1) break;
			this.apply(step, true, Math.max(0, now - step.at));
			if (step.hold) {
				this.t = step.at;
				this.hold = { step, remaining: step.hold, since: performance.now() };
				this.o.onHold?.(step.id);
				this.armHold(true);
				return;
			}
			this.i++;
		}
		this.o.onChapter?.(now);
		if (this.i >= this.steps.length) {
			if (now >= this.duration + this.o.script.rest) return this.finish();
		}
		this.schedule();
	}

	private armHold(first = false): void {
		const h = this.hold;
		if (!h) return;
		const { step } = h;
		if (first && step.tap) {
			const ptr = this.o.registry.get(step.tap);
			const gate = this.o.registry.get(step.id);
			if (ptr?.xy && gate?.center) {
				const from = ptr.xy;
				const to = tapPoint(gate.center);
				setPointer(ptr, to);
				const travel = Math.max(200, step.hold! - 380);
				h.anim = this.track(
					ptr.el.animate(
						[
							{ transform: placeTransform(from), offset: 0 },
							{ transform: placeTransform(to) + " scale(1)", offset: 0.82 },
							{ transform: placeTransform(to) + " scale(0.78)", offset: 0.92 },
							{ transform: placeTransform(to) + " scale(1)", offset: 1 },
						],
						{ duration: travel + 300, easing: EASE_IN_OUT, fill: "backwards" },
					),
				);
			}
		}
		clearTimeout(this.timer);
		this.timer = setTimeout(() => this.finishHold(), h.remaining);
	}

	private finishHold(): void {
		const h = this.hold;
		if (!h) return;
		clearTimeout(this.timer);
		this.hold = null;
		this.o.onHold?.(null);
		this.t = h.step.at;
		this.i++;
		if (this.playing) {
			this.base = performance.now() - this.t;
			this.schedule();
		}
	}

	private settleHold(step: Step): void {
		if (!step.tap) return;
		const ptr = this.o.registry.get(step.tap);
		const gate = this.o.registry.get(step.id);
		if (ptr && gate?.center) setPointer(ptr, tapPoint(gate.center));
	}

	private finish(): void {
		if (!this.o.loop) {
			this.playing = false;
			this.ended = true;
			this.t = this.duration;
			this.o.onEnd?.();
			return;
		}
		if (this.ending) return;
		this.ending = true;
		const out = this.track(this.o.stage.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 260, easing: "ease-in", fill: "forwards" }));
		out.onfinish = () => {
			if (!this.ending) return;
			this.ending = false;
			this.seek(0);
			const back = this.track(this.o.stage.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 320, easing: EASE_OUT }));
			if (!this.playing) back.pause();
		};
	}

	private apply(step: Step, animate: boolean, late = 0): void {
		const entry = this.o.registry.get(step.id);
		if (!entry) return;
		// Ghost-first (BRIEF 12b.1): an "off" item shows as a faint ghost, so entrances start from its ghost opacity and
		// exits end on it (read from CSS once per step; steps are timer-driven, never per frame).
		this.ghostFrom = 0;
		this.ghostTo = 0;
		if (animate && step.fx && ENTRANCES.has(step.fx) && entry.el.getAttribute("data-s") === "off") this.ghostFrom = ghostOpacity(entry.el);
		if (step.s) entry.el.setAttribute("data-s", step.s);
		if (animate && step.fx === "out" && step.s === "off") this.ghostTo = ghostOpacity(entry.el);
		if (step.label && entry.textEl) entry.textEl.textContent = this.o.labels[step.label];
		if (step.text !== undefined && entry.valueEl) entry.valueEl.textContent = step.text;
		if (step.pose) entry.setPose?.(step.pose);
		if (step.xy) {
			const from = entry.xy;
			setPointer(entry, step.xy);
			if (animate && from) this.track(entry.el.animate([{ transform: placeTransform(from) }, { transform: placeTransform(step.xy) }], { duration: step.dur ?? 600, easing: EASE_IN_OUT }));
		}
		if (step.rot !== undefined) {
			const from = entry.rot ?? 0;
			setArm(entry, step.rot);
			if (animate) this.track(entry.el.animate([{ transform: `rotate(${from}deg)` }, { transform: `rotate(${step.rot}deg)` }], { duration: step.dur ?? 800, easing: EASE_IN_OUT }));
		}
		if (animate && step.say) this.o.say?.(this.o.labels[step.say]);
		if (animate && step.fx) this.fx(entry, step, late);
	}

	private fx(entry: Entry, step: Step, late: number): void {
		const el = entry.el;
		const kind: Fx = step.fx!;
		const g0 = this.ghostFrom;
		let anim: Animation | undefined;
		const opts = (duration: number, easing: string, extra: KeyframeAnimationOptions = {}): KeyframeAnimationOptions => ({ duration: step.dur ?? duration, easing, fill: "backwards", ...extra });
		switch (kind) {
			case "fade":
				anim = el.animate([{ opacity: g0 }, { opacity: 1 }], opts(320, EASE_OUT));
				break;
			case "out":
				anim = el.animate([{ opacity: 1 }, { opacity: this.ghostTo }], opts(280, "ease-in"));
				break;
			case "pop":
				anim = el.animate([{ opacity: g0, transform: g0 ? "scale(0.94)" : "scale(0.82)" }, { opacity: 1, transform: "scale(1)" }], opts(420, springSnappy));
				break;
			case "rise":
				anim = el.animate([{ opacity: g0, transform: g0 ? "translateY(0)" : "translateY(10px)" }, { opacity: 1, transform: "translateY(0)" }], opts(480, EASE_OUT));
				break;
			case "fly": {
				// A solid item on top of everything for the whole trip (BRIEF 12b.3); scripts only fly over empty space.
				const [dx, dy] = step.from ?? [0, 0];
				anim = el.animate(
					[
						{ opacity: 1, transform: `translate(${dx}px, ${dy}px) scale(0.96)` },
						{ opacity: 1, transform: `translate(${dx * 0.12}px, ${dy * 0.12}px) scale(1.02)`, offset: 0.8 },
						{ opacity: 1, transform: "translate(0, 0) scale(1)" },
					],
					opts(FLY_MS, EASE_IN_OUT),
				);
				// cancel/finish events arrive async: only the item's latest flight may clear its flag.
				const flight = anim;
				flights.set(el, flight);
				el.setAttribute("data-fly", "");
				const land = () => {
					if (flights.get(el) !== flight) return;
					flights.delete(el);
					el.removeAttribute("data-fly");
				};
				anim.addEventListener("finish", land);
				anim.addEventListener("cancel", land);
				break;
			}
			case "send": {
				this.send(step, late);
				return;
			}
			case "tick":
				anim = (entry.tickEl ?? el).animate([{ transform: "scale(1)" }, { transform: "scale(1.12)" }, { transform: "scale(1)" }], opts(340, EASE_OUT, { fill: "none" }));
				break;
			case "press":
				anim = el.animate([{ transform: "scale(0.9)" }, { transform: "scale(1)" }], opts(260, springSnappy));
				break;
			case "bounce":
				anim = el.animate(
					[{ transform: "translateX(0)" }, { transform: "translateX(-14px)" }, { transform: "translateX(7px)" }, { transform: "translateX(-3px)" }, { transform: "translateX(0)" }],
					opts(520, EASE_OUT, { fill: "none" }),
				);
				break;
			case "fill":
				anim = el.animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], { duration: step.dur ?? 1000, easing: "linear", fill: "forwards" });
				this.kept.add(anim);
				break;
			case "draw": {
				const dots = entry.dots ?? [];
				const each = 150;
				const gap = dots.length > 1 ? Math.min(22, 420 / dots.length) : 0;
				dots.forEach((dot, n) => {
					const a = dot.animate([{ opacity: 0, transform: "scale(0.2)" }, { opacity: 1, transform: "scale(1)" }], { duration: each, delay: n * gap, easing: EASE_OUT, fill: "backwards" });
					if (late) a.currentTime = late;
					this.track(a);
				});
				return;
			}
		}
		if (anim) {
			if (late) anim.currentTime = late;
			this.track(anim);
		}
	}

	/**
	 * A token travels the step's path (absolute stage points) at a steady pace along its segments, on top of the stage.
	 * It exists only while it travels; pause/seek/cancel reach it through track().
	 */
	private send(step: Step, late: number): void {
		const pts = step.path ?? [];
		if (pts.length < 2) return;
		const lens = pts.slice(1).map((p, n) => Math.hypot(p[0] - pts[n]![0], p[1] - pts[n]![1]));
		const total = lens.reduce((a, b) => a + b, 0) || 1;
		let acc = 0;
		const frames: Keyframe[] = pts.map((p, n) => {
			if (n > 0) acc += lens[n - 1]!;
			return { transform: `translate(${p[0]}px, ${p[1]}px)`, offset: Math.min(1, acc / total) };
		});
		const tok = document.createElement("span");
		tok.className = "sc-token";
		tok.setAttribute("aria-hidden", "true");
		const dot = document.createElement("span");
		dot.className = "sc-token__dot";
		tok.append(dot);
		this.o.stage.append(tok);
		const ms = travelMs(step);
		const move = tok.animate(frames, { duration: ms, easing: EASE_IN_OUT, fill: "both" });
		const look = dot.animate(
			[
				{ opacity: 0, transform: "scale(0.4)" },
				{ opacity: 1, transform: "scale(1)", offset: 0.14 },
				{ opacity: 1, transform: "scale(1)", offset: 0.84 },
				{ opacity: 0, transform: "scale(0.6)" },
			],
			{ duration: ms, easing: "linear", fill: "both" },
		);
		const gone = () => tok.remove();
		move.addEventListener("finish", gone);
		move.addEventListener("cancel", gone);
		if (late) {
			move.currentTime = late;
			look.currentTime = late;
		}
		this.track(move);
		this.track(look);
	}

	private track(anim: Animation): Animation {
		this.live.add(anim);
		const done = () => {
			this.live.delete(anim);
		};
		anim.addEventListener("finish", done);
		anim.addEventListener("cancel", done);
		if (!this.playing) anim.pause();
		return anim;
	}

	private cancelAll(): void {
		for (const a of [...this.live]) a.cancel();
		for (const a of [...this.kept]) a.cancel();
		this.live.clear();
		this.kept.clear();
	}
}
