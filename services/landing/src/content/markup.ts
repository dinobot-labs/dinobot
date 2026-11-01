/**
 * Small HTML builders shared by the locale dictionaries (src/content/en.ts, ko.ts). Everything they return is
 * trusted, static markup rendered raw with {{{key}}} by vite/pages.ts. Only dictionary strings go in, never user
 * input.
 */

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (value: string) => value.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);

/**
 * The hero H1 pill (BRIEF 12a, Notion R04): one signal-tinted pill that cycles a few words with a transform/opacity
 * swap. Every word sits in the same grid cell, so the pill is as wide as the widest word and swapping never moves
 * layout. Only the first word is exposed to assistive tech; the others are decoration.
 */
export function pillWords(words: readonly string[]): string {
	const items = words
		.map((w, i) => `<span class="swap__word"${i === 0 ? ' data-on=""' : ' aria-hidden="true"'}>${esc(w)}</span>`)
		.join("");
	return `<span class="pill-word hero__pill" data-signal="theme"><span class="swap" data-swap>${items}</span></span>`;
}

/** A link inside a sentence (consent line, privacy notice). */
export const link = (href: string, text: string) => `<a href="${esc(href)}">${esc(text)}</a>`;

/** JSON-LD for <script type="application/ld+json">: `<` is escaped so the data can never close the script element. */
export function jsonLd(data: unknown): string {
	return JSON.stringify(data).replace(/</g, "\\u003c");
}

export const SITE = "https://www.dinobot.workers.dev";
