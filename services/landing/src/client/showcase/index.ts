/**
 * Strength scenes + interactive demo (BRIEF 5.5, 5.6, 10). Contract: mountShowcase(root, { locale }) => { destroy() }.
 * Fills every [data-scene="dag|memory|assignment|evolve|demo"] inside root.
 *
 * Host sizing (the page owns the hosts; scenes fill 100% of them and scale with them):
 *   dag, memory, assignment, evolve: aspect-ratio 4 / 3 (stage 440 x 330)
 *   demo: aspect-ratio 3 / 2 at >= 640px, 1 / 2 below (stages 750 x 500 and 360 x 720)
 * Signals (scoped with [data-signal] on each host): DAG mint, Memory teal, Assignment cyan, Self-improving blue,
 * asks indigo, errors red.
 *
 * Motion: DOM/SVG with CSS + Web Animations on transform/opacity only; no rAF loop. A scene starts when >= 30% of
 * it is visible and pauses offscreen or in a hidden tab. Every looping scene has a pause/play control (WCAG 2.2.2).
 * prefers-reduced-motion: final states, with a Play control that animates once inside `.motion-ok`.
 */
import "./showcase.css";
import { mountDemo } from "./demo.ts";
import { readMotionTokens } from "./engine.ts";
import { type Locale, labelsFor } from "./labels.ts";
import { type Unit, mountScene } from "./scene.ts";
import { SCENES, type SceneName } from "./scripts.ts";

export type { Locale };

export interface ShowcaseHandle {
	destroy(): void;
	/** QA/lab helper: freeze one scene at timeline time t (ms). */
	freeze(scene: SceneName | "demo", t: number): void;
}

const VISIBLE_RATIO = 0.3;

export function mountShowcase(root: ParentNode, options: { locale: Locale }): ShowcaseHandle {
	const labels = labelsFor(options.locale === "ko" ? "ko" : "en");
	readMotionTokens();
	const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
	const units = new Map<HTMLElement, { name: string; unit: Unit }>();

	for (const host of root.querySelectorAll<HTMLElement>("[data-scene]")) {
		if (host.dataset.mounted === "showcase") continue;
		const name = host.dataset.scene ?? "";
		let unit: Unit | undefined;
		if (name === "demo") unit = mountDemo(host, labels, reduced.matches);
		else if (name in SCENES) unit = mountScene(host, SCENES[name as SceneName], labels, reduced.matches);
		if (unit) units.set(host, { name, unit });
	}

	const io = new IntersectionObserver(
		(entries) => {
			for (const e of entries) units.get(e.target as HTMLElement)?.unit.setVisible(e.isIntersecting && e.intersectionRatio >= VISIBLE_RATIO - 0.001);
		},
		{ threshold: [0, VISIBLE_RATIO] },
	);
	for (const host of units.keys()) io.observe(host);

	const onReduced = () => {
		for (const { unit } of units.values()) unit.setReduced(reduced.matches);
	};
	reduced.addEventListener("change", onReduced);

	return {
		destroy() {
			io.disconnect();
			reduced.removeEventListener("change", onReduced);
			for (const { unit } of units.values()) unit.destroy();
			units.clear();
		},
		freeze(scene, t) {
			for (const { name, unit } of units.values()) if (name === scene) unit.freeze(t);
		},
	};
}
