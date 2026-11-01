/**
 * Nav behaviour: the earned hairline (`data-stuck` from a sentinel above the nav, R01), links that jump to a
 * waitlist form and focus its email field, and the locale toggle (BRIEF 9: sets the `lang` cookie, keeps the hash).
 */
import { $all, reducedMotion } from "./env.ts";

export function mountNavRule(): void {
	const nav = document.querySelector<HTMLElement>("[data-nav]");
	if (!nav) return;
	const sentinel = document.createElement("div");
	sentinel.setAttribute("aria-hidden", "true");
	sentinel.className = "nav-sentinel";
	nav.before(sentinel);
	new IntersectionObserver(([entry]) => nav.toggleAttribute("data-stuck", !entry?.isIntersecting)).observe(sentinel);
}

/** `a[href="#waitlist"]` and `[data-focus-form]`: scroll to the hero form and focus the email input. */
export function mountFormLinks(): void {
	for (const link of $all<HTMLAnchorElement>('a[href="#waitlist"], a[data-focus-form]')) {
		link.addEventListener("click", (event) => {
			const form = document.getElementById("waitlist");
			if (!form) return;
			event.preventDefault();
			const input = form.querySelector<HTMLInputElement>('input[type="email"]');
			form.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "center" });
			history.replaceState(null, "", "#waitlist");
			// Focus without a second jump; the smooth scroll above keeps going.
			input?.focus({ preventScroll: true });
		});
	}
}

export function setLangCookie(lang: "en" | "ko"): void {
	const secure = location.protocol === "https:" ? "; Secure" : "";
	document.cookie = `lang=${lang}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
}

/** `[data-locale-toggle]` links: remember the choice in the `lang` cookie, then navigate keeping the hash. */
export function mountLocaleToggle(): void {
	for (const link of $all<HTMLAnchorElement>("[data-locale-toggle]")) {
		link.addEventListener("click", (event) => {
			if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
			const lang = link.dataset.localeToggle === "ko" ? "ko" : "en";
			setLangCookie(lang);
			event.preventDefault();
			if (link.getAttribute("aria-current") === "true") return;
			const url = new URL(link.href, location.href);
			url.hash = location.hash;
			location.assign(url.href);
		});
	}
}

/** Marks the nav link of the section in the reading band (aria-current), from IntersectionObserver only. */
export function mountScrollSpy(): void {
	const links = $all<HTMLAnchorElement>("[data-spy]");
	if (!links.length) return;
	const sections = links.map((a) => document.getElementById(a.dataset.spy ?? "")).filter((s): s is HTMLElement => !!s);
	const io = new IntersectionObserver(
		(entries) => {
			for (const e of entries) {
				const link = links.find((a) => a.dataset.spy === e.target.id);
				if (!link) continue;
				if (e.isIntersecting) link.setAttribute("aria-current", "true");
				else link.removeAttribute("aria-current");
			}
		},
		{ rootMargin: "-45% 0px -50% 0px" },
	);
	for (const s of sections) io.observe(s);
}
