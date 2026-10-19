import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { type IconSetName, isIconSetName, isThemeName, type ThemeName } from "./theme.ts";

/** `icons` is absent until the user picks a set; absent means `auto` (see `chooseIconSet`). `theme` is absent until
 * the user picks a dinosaur theme with /theme; absent means the T-rex (see `chooseTheme`). */
export type TuiPreferences = { readonly toolsExpanded: boolean; readonly icons?: IconSetName; readonly theme?: ThemeName };
export type TuiPreferencesStore = { load(): TuiPreferences; save(preferences: TuiPreferences): void };

/** Per-user display preferences, independent of conversation, manifest and daemon. */
export function tuiPreferencesPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
	const config = env.XDG_CONFIG_HOME;
	return join(config && isAbsolute(config) ? config : join(home, ".config"), "dinobot", "tui.json");
}

export class FileTuiPreferences implements TuiPreferencesStore {
	constructor(readonly path = tuiPreferencesPath()) {}

	load(): TuiPreferences {
		try {
			const value: unknown = JSON.parse(readFileSync(this.path, "utf8"));
			if (value !== null && typeof value === "object") {
				const toolsExpanded = "toolsExpanded" in value && typeof value.toolsExpanded === "boolean" ? value.toolsExpanded : false;
				const icons = "icons" in value && isIconSetName(value.icons) ? value.icons : undefined;
				const theme = "theme" in value && isThemeName(value.theme) ? value.theme : undefined;
				return { toolsExpanded, ...(icons === undefined ? {} : { icons }), ...(theme === undefined ? {} : { theme }) };
			}
		} catch {
			// Missing, unreadable or malformed preferences must never prevent opening the TUI.
		}
		return { toolsExpanded: false };
	}

	/** A tiny synchronous atomic write makes a toggle durable even immediately before quit. */
	save(preferences: TuiPreferences): void {
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
		const temporary = `${this.path}.${process.pid}.${crypto.randomUUID()}.tmp`;
		try {
			writeFileSync(temporary, `${JSON.stringify({ version: 1, toolsExpanded: preferences.toolsExpanded, ...(preferences.icons === undefined ? {} : { icons: preferences.icons }), ...(preferences.theme === undefined ? {} : { theme: preferences.theme }) }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
			renameSync(temporary, this.path);
		} finally {
			try {
				unlinkSync(temporary);
			} catch {
				// Rename consumed the temporary file, or creation failed.
			}
		}
	}
}

/** Terminals that ship Nerd Font symbols as a built-in fallback, so `nerd` renders with no font install. */
const BUNDLED_NERD = new Set(["ghostty", "wezterm", "kitty"]);
/** Terminals that cannot draw private-use glyphs with their stock font: the Linux console, dumb terminals, macOS Terminal.app. */
const NO_NERD_TERM = new Set(["linux", "dumb"]);
const NO_NERD_PROGRAM = new Set(["apple_terminal"]);

export type IconSetSource = "env" | "preference" | "auto";
export type IconSetChoice = { readonly set: IconSetName; readonly source: IconSetSource; readonly bundled: boolean };

/** Nerd Font presence cannot be detected from inside a terminal, so `auto` defaults to `nerd` and only
 * falls back to `unicode` where the terminal is known not to render it. `DINOBOT_ICONS` overrides for one run. */
export function chooseIconSet(preferences: TuiPreferences, env: NodeJS.ProcessEnv = process.env): IconSetChoice {
	const program = (env.TERM_PROGRAM ?? "").toLowerCase();
	const term = (env.TERM ?? "").toLowerCase();
	const bundled = BUNDLED_NERD.has(program) || term === "xterm-kitty" || term === "xterm-ghostty" || env.KITTY_WINDOW_ID !== undefined || env.WEZTERM_PANE !== undefined;
	const override = env.DINOBOT_ICONS?.trim().toLowerCase();
	if (isIconSetName(override)) return { set: override, source: "env", bundled };
	if (preferences.icons !== undefined) return { set: preferences.icons, source: "preference", bundled };
	const unsafe = !bundled && (NO_NERD_TERM.has(term) || NO_NERD_PROGRAM.has(program));
	return { set: unsafe ? "unicode" : "nerd", source: "auto", bundled };
}

export const resolveIconSet = (preferences: TuiPreferences, env: NodeJS.ProcessEnv = process.env): IconSetName => chooseIconSet(preferences, env).set;

export type ThemeSource = "env" | "preference" | "default";
export type ThemeChoice = { readonly theme: ThemeName; readonly source: ThemeSource };

/** `DINOBOT_THEME` overrides for one run, then the saved /theme choice, then the T-rex. Unknown names are ignored. */
export function chooseTheme(preferences: TuiPreferences, env: NodeJS.ProcessEnv = process.env): ThemeChoice {
	const override = env.DINOBOT_THEME?.trim().toLowerCase();
	if (isThemeName(override)) return { theme: override, source: "env" };
	if (preferences.theme !== undefined) return { theme: preferences.theme, source: "preference" };
	return { theme: "rex", source: "default" };
}
