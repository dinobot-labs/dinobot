/**
 * Scroll-linked page motion (BRIEF 8): compositor-only, no scroll listeners.
 *
 * - Philosophy statement (`[data-words]`): split into word spans; with CSS scroll timelines every word lights up
 *   on its own slice of a shared `view()` timeline (sections.css); without them an IntersectionObserver adds
 *   `is-lit` and the words fade in with a stagger. Reduced motion: all words lit, no animation.
 * - `.reveal` fallback: when `animation-timeline: view()` is unsupported, IntersectionObserver toggles `is-in`.
 * - `[data-assemble]`: dot glyphs assemble once when they enter (class `is-in`).
 * - Marquee: clone the list for the seamless loop, pause toggle, pause offscreen.
 */
import { $all, onceVisible, reducedMotion, whileActive } from "./env.ts";

export const supportsScrollTimeline = () => typeof CSS !== "undefined" && CSS.supports("animation-timeline: view()");

export function mountWords(): void {
	for (const el of $all("[data-words]")) {
		const text = el.textContent?.trim() ?? "";
		const words = text.split(/\s+/);
		el.textContent = "";
		// Screen readers get the sentence once; the spans are presentation.
		const sr = document.createElement("span");
		sr.className = "sr-only";
		sr.textContent = text;
		const visual = document.createElement("span");
		visual.setAttribute("aria-hidden", "true");
		words.forEach((w, i) => {
			const span = document.createElement("span");
			span.className = "word";
			span.textContent = w;
			span.style.setProperty("--i", String(i));
			visual.append(span, i < words.length - 1 ? " " : "");
		});
		el.style.setProperty("--n", String(words.length));
		el.append(sr, visual);
		el.dataset.words = supportsScrollTimeline() ? "timeline" : "io";
		if (reducedMotion() || !supportsScrollTimeline()) onceVisible(el, () => el.classList.add("is-lit"), "0px 0px -25% 0px");
	}
}

export function mountRevealFallback(): void {
	if (supportsScrollTimeline()) return;
	for (const el of $all(".reveal")) onceVisible(el, () => el.classList.add("is-in"), "0px 0px -8% 0px");
}

export function mountAssemble(): void {
	for (const el of $all("[data-assemble]")) onceVisible(el, () => el.classList.add("is-in"), "0px 0px -15% 0px");
}

export function mountMarquee(): void {
	for (const marquee of $all("[data-marquee]")) {
		const list = marquee.querySelector<HTMLElement>("[data-marquee-list]");
		const track = marquee.querySelector<HTMLElement>(".marquee__track");
		if (!list || !track) continue;
		const clone = list.cloneNode(true) as HTMLElement;
		clone.setAttribute("aria-hidden", "true");
		clone.removeAttribute("data-marquee-list");
		track.append(clone);
		const toggle = marquee.querySelector<HTMLButtonElement>("[data-marquee-toggle]");
		toggle?.addEventListener("click", () => {
			const paused = marquee.hasAttribute("data-paused");
			marquee.toggleAttribute("data-paused", !paused);
			toggle.setAttribute("aria-pressed", String(!paused));
			toggle.setAttribute("aria-label", (paused ? toggle.dataset.labelPause : toggle.dataset.labelPlay) ?? "");
			toggle.querySelector("path")?.setAttribute("d", paused ? "M6 4v8M10 4v8" : "M5 3.5v9l7-4.5z");
		});
		// No work while it cannot be seen (BRIEF 8).
		whileActive(marquee, (active) => track.style.setProperty("animation-play-state", active ? "" : "paused"));
	}
}
