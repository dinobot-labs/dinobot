/** Root-only suggestion. Explicit paths always win; navigation never writes a cookie. */
export function localePreferenceTarget(pathname: string, cookie: string, languages: readonly string[]): "/ko/" | null {
	if (pathname !== "/") return null;
	let chosen: "en" | "ko" | undefined;
	for (const pair of cookie.split(";")) {
		const equals = pair.indexOf("=");
		if (equals < 0 || pair.slice(0, equals).trim() !== "lang") continue;
		const value = pair.slice(equals + 1).trim().replace(/^"(.*)"$/, "$1").toLowerCase();
		if (value === "en" || value === "ko") { chosen = value; break; }
	}
	const language = languages[0]?.toLowerCase() ?? "en";
	return (chosen ?? (language === "ko" || language.startsWith("ko-") ? "ko" : "en")) === "ko" ? "/ko/" : null;
}

/** Call once from the page entry. replace avoids a Back-button redirect loop. */
export function mountLocalePreference(): void {
	const target = localePreferenceTarget(location.pathname, document.cookie, navigator.languages.length ? navigator.languages : [navigator.language]);
	if (target) location.replace(target + location.search + location.hash);
}
