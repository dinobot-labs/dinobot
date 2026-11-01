/** Small shared helpers for the page modules (src/client/app). */

export type Locale = "en" | "ko";

export const locale = (): Locale => (document.documentElement.lang === "ko" ? "ko" : "en");

let reducedQuery: MediaQueryList | undefined;
const query = () => (reducedQuery ??= window.matchMedia("(prefers-reduced-motion: reduce)"));
export const reducedMotion = () => query().matches;

export const $all = <T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T[] => [...root.querySelectorAll<T>(selector)];

/** Runs `fn` once, the first time `el` comes within `margin` of the viewport. */
export function onceVisible(el: Element, fn: () => void, margin = "0px 0px -10% 0px"): () => void {
	const io = new IntersectionObserver(
		(entries) => {
			if (entries.some((e) => e.isIntersecting)) {
				io.disconnect();
				fn();
			}
		},
		{ rootMargin: margin },
	);
	io.observe(el);
	return () => io.disconnect();
}

/** Tracks whether `el` is on screen and the tab is visible; calls `fn(active)` on every change. */
export function whileActive(el: Element, fn: (active: boolean) => void): () => void {
	let onScreen = false;
	let last: boolean | undefined;
	const sync = () => {
		const active = onScreen && document.visibilityState === "visible";
		if (active !== last) {
			last = active;
			fn(active);
		}
	};
	const io = new IntersectionObserver((entries) => {
		for (const e of entries) onScreen = e.isIntersecting;
		sync();
	});
	io.observe(el);
	document.addEventListener("visibilitychange", sync);
	return () => {
		io.disconnect();
		document.removeEventListener("visibilitychange", sync);
	};
}
