/**
 * Page routes and URLs of the pages plugin (vite/pages.ts). Kept free of `vite` imports so tests can use them
 * without the landing dependencies installed (the dinobot root CI runs these tests from the repository root).
 */

export const LOCALES = ["en", "ko"] as const;
export type Locale = (typeof LOCALES)[number];
export type Outputs = Partial<Record<Locale, string>>;

/** Output file (relative to the project root) per locale for every known page. */
export const ROUTES: Record<string, Outputs> = {
	home: { en: "index.html", ko: "ko/index.html" },
	privacy: { en: "privacy/index.html", ko: "ko/privacy/index.html" },
	"404": { en: "404.html" },
	design: { en: "design/index.html" },
};

/** Production origin (BRIEF 9: Worker `www` on workers.dev). */
export const DEFAULT_SITE = "https://www.dinobot.workers.dev";

/** "index.html" -> "/", "ko/privacy/index.html" -> "/ko/privacy/", "404.html" -> "/404". */
export function urlOf(file: string): string {
	if (file === "index.html") return "/";
	if (file.endsWith("/index.html")) return "/" + file.slice(0, -"index.html".length);
	return "/" + file.replace(/\.html$/, "");
}
