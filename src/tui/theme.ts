import {
	backgroundAnsi,
	type Color,
	foregroundAnsi,
	getTerminalColorMode,
	parseColor,
	styleTextWithAnsi,
	type TerminalColorMode,
	type TextAttributes,
	visibleWidth,
} from "@earendil-works/pi-tui";

export type Style = (text: string) => string;

/** Dinobot Signal: high-contrast cool surfaces, the Dinobot icon brand gradient, readable status colors,
 * and small activity animations. Semantic roles and motion rules are documented in ADR 0015. */
const signal = {
	bgNight: "#111111",
	bgStorm: "#191919",
	bgStormDark: "#1E1E1E",
	bgHighlight: "#232726",
	bgVisual: "#2B3433",
	bgHover: "#262C2B",
	fg: "#ECF0EE",
	fgDark: "#B7C0BD",
	fgGutter: "#5A6461",
	/** Nudged from the spec's #8E9B97 (4.44:1 on bgVisual) to #909D99 (4.55:1). */
	comment: "#909D99",
	dark5: "#A8B3AF",
	/** Brand gradient stops from the Dinobot icon, left to right. */
	brandMint: "#19CA9D",
	brandTeal: "#2DB4B2",
	brandCyan: "#3DA5C2",
	brandBlue: "#538EDA",
	brandIndigo: "#5D7CDE",
	blue: "#8DB4F0",
	cyan: "#7CCBDB",
	green: "#AFE195",
	green1: "#7FD8BE",
	magenta: "#B9A3EC",
	orange: "#FFBF80",
	purple: "#B9A3EC",
	red: "#FF8F87",
	teal: "#6FD3C6",
	yellow: "#FABD2F",
	selectionBorder: "#5E6B68",
	promptBorder: "#5E6B68",
	promptBorderActive: "#2DB4B2",
	diffDeleteBg: "#3A2422",
	diffInsertBg: "#1F3A30",
} as const;

export type PaletteName = keyof typeof signal;
/** The live palette: Dinobot Signal with the active dinosaur theme's brand stops and accents (`setTheme`). */
export const palette: Record<PaletteName, string> = { ...signal };

/**
 * Dinosaur themes (ADR 0100): each one is a mascot species with its own five-stop body gradient. A theme only
 * recolors the brand roles (the gradient stops, user/system accents and the focused prompt border); surfaces, text and
 * status colors stay Dinobot Signal, so running/done/failed read the same in every theme. Stops mirror
 * services/landing/src/brand/species.ts.
 */
export type DinosaurThemeName = "rex" | "ptero" | "brachio" | "tricera";
export const DINOSAUR_THEME_NAMES: readonly DinosaurThemeName[] = ["rex", "ptero", "brachio", "tricera"];
export type ThemeName = DinosaurThemeName | "dos-blue" | "dos-black";
export const THEME_NAMES: readonly ThemeName[] = [...DINOSAUR_THEME_NAMES, "dos-blue", "dos-black"];
export type DinoTheme = {
	readonly label: string;
	readonly species: string;
	readonly description: string;
	/** Tail to head; the first is the user accent, the second the system accent. */
	readonly stops: readonly [string, string, string, string, string];
	readonly border: string;
};
export const themes: Readonly<Record<ThemeName, DinoTheme>> = {
 "dos-blue": { label: "DOS Blue", species: "T-rex", description: "blue cell-grid workspace", stops: ["#ffff55", "#55ffff", "#e0e0e0", "#aaaaaa", "#e0e0e0"], border: "#ffff55" },
 "dos-black": { label: "DOS Black", species: "T-rex", description: "black cell-grid workspace", stops: ["#e0d590", "#b8c8c8", "#d0d0d0", "#aaaaaa", "#e0e0e0"], border: "#e0d590" },
	rex: { label: "Signal", species: "T-rex", description: "mint to indigo, the original", stops: ["#19CA9D", "#2DB4B2", "#3DA5C2", "#538EDA", "#5D7CDE"], border: "#2DB4B2" },
	ptero: { label: "Dusk", species: "Pterodactyl", description: "sun to violet, a sunset sky", stops: ["#F5B83D", "#F2894B", "#E8677F", "#C45AB3", "#8C5BE0"], border: "#F2894B" },
	brachio: { label: "Fern", species: "Brachiosaurus", description: "lime to pine, a fern forest", stops: ["#C3D43A", "#8CC24C", "#55AD5E", "#2F9670", "#1F7F78"], border: "#8CC24C" },
	tricera: { label: "Canyon", species: "Triceratops", description: "sand to garnet, a desert canyon", stops: ["#F0B43C", "#EA9238", "#DE6F3A", "#C95343", "#A84452"], border: "#EA9238" },
};
export const isThemeName = (value: unknown): value is ThemeName => typeof value === "string" && (THEME_NAMES as readonly string[]).includes(value);

const mode: TerminalColorMode = getTerminalColorMode();
const colors = new Map<PaletteName, Color>();
const colorOf = (name: PaletteName): Color => {
	let color = colors.get(name);
	if (color === undefined) {
		color = parseColor(palette[name]);
		colors.set(name, color);
	}
	return color;
};

const fgAnsi = new Map<PaletteName, string>();
const bgAnsi = new Map<PaletteName, string>();
const foreground = (name: PaletteName): string => {
	let ansi = fgAnsi.get(name);
	if (ansi === undefined) {
		ansi = foregroundAnsi(colorOf(name), mode);
		fgAnsi.set(name, ansi);
	}
	return ansi;
};
const background = (name: PaletteName): string => {
	let ansi = bgAnsi.get(name);
	if (ansi === undefined) {
		ansi = backgroundAnsi(colorOf(name), mode);
		bgAnsi.set(name, ansi);
	}
	return ansi;
};

/** Styles resolve their color per call (a cached map lookup), so a theme switch recolors every role. */
export const fg = (name: PaletteName, attributes: TextAttributes = {}): Style => (text) => styleTextWithAnsi(text, foreground(name), undefined, attributes);
const BASE_BG: PaletteName = "bgStorm";
const RESET = "\x1b[0m";
/** Inner backgrounds hand back to the screen background instead of the terminal default, so painted rows stay solid. */
export const bg = (name: PaletteName): Style => (text) => `${background(name)}${text}${background(BASE_BG)}`;

let activeTheme: ThemeName = "rex";
/** Swaps the brand roles to `name` and drops every cached color; renderers re-read on their next frame. */
export const setTheme = (name: ThemeName): void => {
	const theme = themes[name];
	activeTheme = name;
	const [brandMint, brandTeal, brandCyan, brandBlue, brandIndigo] = theme.stops;
	Object.assign(palette, signal, { brandMint, brandTeal, brandCyan, brandBlue, brandIndigo, promptBorderActive: theme.border });
 if (isDosTheme()) Object.assign(palette, dosPalette(name === "dos-blue"));
 Object.assign(rounded, isDosTheme() ? doubleBox : asciiBox);
 Object.assign(square, isDosTheme() ? doubleBox : asciiBox);
	colors.clear();
	fgAnsi.clear();
	bgAnsi.clear();
};
export const themeName = (): ThemeName => activeTheme;
export const isDosTheme = (): boolean => activeTheme === "dos-blue" || activeTheme === "dos-black";

function dosPalette(blue: boolean): Record<PaletteName, string> {
 const surface = blue ? "#0000aa" : "#000000";
 const inset = blue ? "#000080" : "#111111";
 const ink = blue ? "#e0e0e0" : "#d0d0d0";
 const focus = blue ? "#ffff55" : "#e0d590";
 const info = blue ? "#55ffff" : "#b8c8c8";
 const success = blue ? "#55ff55" : "#afc5af";
 const error = blue ? "#ffaaaa" : "#e0aaaa";
 return { bgNight: surface, bgStorm: surface, bgStormDark: inset, bgHighlight: inset, bgVisual: inset, bgHover: inset,
 fg: ink, fgDark: ink, fgGutter: "#aaaaaa", comment: "#aaaaaa", dark5: ink,
 brandMint: focus, brandTeal: info, brandCyan: ink, brandBlue: "#aaaaaa", brandIndigo: "#e0e0e0",
 blue: info, cyan: info, green: success, green1: success, magenta: ink, orange: info, purple: ink, red: error, teal: info, yellow: focus,
 selectionBorder: ink, promptBorder: ink, promptBorderActive: focus,
 diffDeleteBg: blue ? "#330066" : "#302020", diffInsertBg: blue ? "#003366" : "#203020" };
}
export const ansi = { fg: foreground, bg: background, fgReset: "\x1b[39m", bgReset: "\x1b[49m" } as const;

/** Right-pads `text` with spaces to `width` visible columns; text already `width` or wider is returned unchanged. */
export function pad(text: string, width: number): string {
	const missing = width - visibleWidth(text);
	return missing > 0 ? `${text}${" ".repeat(missing)}` : text;
}

/** Pads one screen row to `width` on the `bg_base` background; a `\x1b[0m` inside the row re-opens that background. */
export function paint(line: string, width: number): string {
	const base = background(BASE_BG);
	const body = line.includes(RESET) ? line.replaceAll(RESET, `${RESET}${base}`) : line;
	const missing = width - visibleWidth(line);
	return `${base}${body}${missing > 0 ? " ".repeat(missing) : ""}${ansi.bgReset}`;
}

const sgr =
	(open: number, close: number): Style =>
	(text) =>
		`\x1b[${open}m${text}\x1b[${close}m`;
export const bold = sgr(1, 22);
export const dim = sgr(2, 22);
export const italic = sgr(3, 23);
export const underline = sgr(4, 24);
export const strike = sgr(9, 29);
export const inverse = sgr(7, 27);

/** An OSC 8 hyperlink in the link color; terminals without hyperlink support show the label. */
export const link = (url: string, label = url): string => color.link(`\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\`);

/** Semantic roles for the Dinobot Signal direction. */
export const color = {
	textPrimary: fg("fg"),
	textSecondary: fg("fgDark"),
	grayDim: fg("fgGutter"),
	gray: fg("comment"),
	grayBright: fg("dark5"),
	accentUser: fg("brandMint"),
	accentAssistant: fg("blue"),
	accentThinking: fg("comment"),
	accentTool: fg("dark5"),
	accentSystem: fg("brandTeal"),
	accentRunning: fg("orange"),
	accentSuccess: fg("green"),
	accentError: fg("red"),
	warning: fg("yellow"),
	command: fg("yellow"),
	path: fg("teal"),
	running: fg("orange"),
	accentModel: fg("green1"),
	promptBorder: fg("promptBorder"),
	promptBorderActive: fg("promptBorderActive"),
	selectionBorder: fg("selectionBorder"),
	scrollbarTrack: fg("bgStormDark"),
	scrollbarThumb: fg("dark5"),
	scrollbarTrackBg: bg("bgStormDark"),
	scrollbarThumbBg: bg("dark5"),
	mdHeading1: fg("cyan", { bold: true }), // brandCyan fails 4.5:1 on bgVisual, so the passing cyan tint stays
	mdHeading2: fg("orange", { bold: true }),
	mdHeading3: fg("yellow", { bold: true }),
	mdHeading4: fg("red", { bold: true }),
	mdCode: fg("green1", { bold: true }),
	mdMuted: fg("comment"),
	mdText: fg("fg"),
	link: fg("blue", { underline: true }),
	fuzzyAccent: fg("brandTeal"),
	panelBorder: fg("bgHighlight"),
	/** Modal windows: gray_dim square border, bold title, gray section headers over a gray_dim rule. */
	modalBorder: fg("fgGutter"),
	modalTitle: fg("fg", { bold: true }),
	sectionHeader: fg("comment", { bold: true }),
	sectionRule: fg("fgGutter"),
	/** Picker row tags: the green `logged in` badge, the gray `current` tag, the accent_success dot of the current row (modal_list.rs). */
	badge: fg("green"),
	tag: fg("comment"),
	currentMark: fg("green"),
	/** Card buttons: text_secondary on bg_highlight at rest, bold text_primary on bg_visual when focused or hovered. */
	button: fg("fgDark"),
	buttonBg: bg("bgHighlight"),
	buttonActive: fg("fg", { bold: true }),
	buttonActiveBg: bg("bgVisual"),
	/** A device code: the warning color like the auth notices, boxed on `codeBg`. */
	code: fg("yellow", { bold: true }),
	diffDelete: fg("red"),
	diffInsert: fg("green"),
	bgLight: bg("bgHighlight"),
	bgDark: bg("bgHighlight"),
	bgHighlight: bg("bgHighlight"),
	bgVisual: bg("bgVisual"),
	bgHover: bg("bgHover"),
	codeBg: bg("bgHighlight"),
	diffDeleteBg: bg("diffDeleteBg"),
	diffInsertBg: bg("diffInsertBg"),
} as const satisfies Record<string, Style>;

export type SpinnerSpec = { readonly frames: readonly string[]; readonly intervalMs: number };

export const glyph = {
	promptArrow: "> ",
	bullet: "-",
	bulletHollow: "-",
	groupBullet: "+",
	collapsedAccent: "|",
	accentBar: "|",
	chevron: ">",
	chevronLeft: "<",
	disclosureOpen: "v",
	disclosureClosed: ">",
	disclosureUp: "^",
	tokenArrow: "=",
	check: "x",
	ballotX: "!",
	closeButton: "[x]",
	enlarge: "+",
	enlargeButton: "[+]",
	listBullet: "-",
	recordDot: "*",
	recordDotHollow: "*",
	ellipsis: "...",
	truncation: "...",
	quoteOpen: '"',
	quoteClose: '"',
	cutBelow: "v",
	cutAbove: "^",
	/** U+E0A0, the Powerline branch glyph before the branch name on the welcome screen. */
	branch: "\uE0A0",
	todoPending: "[ ]",
	todoInProgress: "[>]",
	todoCompleted: "[x]",
	todoCancelled: "[-]",
	/** Plan obligations reuse the todo marks for met/pending/running/cancelled; these three have no todo analog. */
	planStale: "[~]",
	planUnknown: "[?]",
	planFailed: "[!]",
	/** The current row of a picker and the step list's done mark. */
	current: ">",
} as const;

/** Tool identity and terminal-state marks, separate from status color and motion (ADR 0019).
 * `nerd` (the default via `chooseIconSet`) uses Codicon line icons from a Nerd Font, the terminal analog of
 * Lucide-style tool icons. `unicode` is the font-independent fallback. Running always uses the braille spinner. */
export type IconKind =
	| "shell" | "codemode" | "read" | "search" | "list" | "edit" | "write" | "web_fetch" | "web_search"
	| "todo" | "subagent" | "skill" | "memory" | "lsp" | "session" | "github" | "other";
export type IconStatus = "pending" | "done" | "failed" | "cancelled" | "unknown";
/** `thinking` marks reasoning blocks (Thought/Thinking headers); it is block identity, not a tool kind. */
export type IconSet = { readonly tools: Readonly<Record<IconKind, string>>; readonly status: Readonly<Record<IconStatus, string>>; readonly thinking: string };
export type IconSetName = "unicode" | "nerd";
export const ICON_SET_NAMES: readonly IconSetName[] = ["unicode", "nerd"];

export const iconSets: Readonly<Record<IconSetName, IconSet>> = {
	unicode: {
		tools: {
			shell: "$", codemode: "{}", read: "≡", search: "?", list: "#", edit: "±", write: "+", web_fetch: "↗", web_search: "?",
			todo: "☐", subagent: "@", skill: "❖", memory: "⧉", lsp: "⌗", session: "⋯", github: "⎇", other: "◇",
		},
		status: { pending: "○", done: "✓", failed: "!", cancelled: "–", unknown: "○" },
		thinking: "⁂",
	},
	nerd: {
		tools: {
			shell: "\uEA85", // cod-terminal
			codemode: "\uEAC4", // cod-code
			read: "\uEA7B", // cod-file
			search: "\uEA6D", // cod-search
			list: "\uEAF7", // cod-folder_opened
			edit: "\uEA73", // cod-edit
			write: "\uEA7F", // cod-new_file
			web_fetch: "\uEB01", // cod-globe
			web_search: "\uEB68", // cod-telescope
			todo: "\uEAB3", // cod-checklist
			subagent: "\uEB08", // cod-hubot
			skill: "\uEB21", // cod-mortar_board
			memory: "\uEAA4", // cod-book
			lsp: "\uEB5B", // cod-symbol_class
			session: "\uEAC7", // cod-comment_discussion
			github: "\uEA84", // cod-github
			other: "\uEB6D", // cod-tools
		},
		status: {
			pending: "\uEABC", // cod-circle
			done: "\uEBA4", // cod-pass
			failed: "\uEA87", // cod-error
			cancelled: "\uEABD", // cod-circle_slash
			unknown: "\uEB32", // cod-question
		},
		thinking: "\uEA61", // cod-lightbulb (no BMP brain glyph; nf-md-brain lives in the supplementary plane, see ADR 0020)
	},
};

export const isIconSetName = (value: unknown): value is IconSetName => typeof value === "string" && (ICON_SET_NAMES as readonly string[]).includes(value);
let activeIcons: IconSetName = "unicode";
/** Chosen once at startup by `chooseIconSet`; render caches assume it is stable. Tests and fixtures start on `unicode`. */
export const setIconSet = (name: IconSetName): void => {
	activeIcons = name;
};
export const iconSetName = (): IconSetName => activeIcons;
export const icons = (): IconSet => iconSets[activeIcons];

export const TICK_MS = 33;
/** One frame per screen heartbeat; fixed-width marks never scramble readable labels. */
export const brailleSpinner: SpinnerSpec = { frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], intervalMs: 132 };
export const dotSpinner: SpinnerSpec = { frames: ["✦", "✧", "·", "✧"], intervalMs: 528 };
export const monitorPulse: SpinnerSpec = { frames: ["○", "◎", "◉", "◎"], intervalMs: 267 };
export const spinnerFrame = (spinner: SpinnerSpec, tick: number): string =>
	spinner.frames[Math.floor(tick / Math.max(1, Math.round(spinner.intervalMs / TICK_MS))) % spinner.frames.length] ?? "";

export type BoxGlyphs = {
	readonly tl: string;
	readonly tr: string;
	readonly bl: string;
	readonly br: string;
	readonly h: string;
	readonly v: string;
	readonly sepL: string;
	readonly sepR: string;
};
/** Dinobot Signal: ASCII frames everywhere. */
const asciiBox: BoxGlyphs = { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|", sepL: "+", sepR: "+" };
const doubleBox: BoxGlyphs = { tl: "╔", tr: "╗", bl: "╚", br: "╝", h: "═", v: "║", sepL: "╟", sepR: "╢" };
export const rounded: BoxGlyphs = { ...asciiBox };
export const square: BoxGlyphs = { ...asciiBox };
export const cutCorner = "|";

export const separator = {
	footer: "  |  ",
	header: " | ",
	meta: " - ",
	activity: " - ",
} as const;

/** Grok's `ModalSizing::medium()` (modal_window.rs:125-135), the picker-sized popup: 60% of the columns clamped to 44..120 and never past cols-4, rows-8 tall, 2 columns of inner padding, one row above the content, two footer rows. */
export const modalSizing = { widthPct: 0.6, maxWidth: 120, minWidth: 44, vMargin: 4, hPad: 2, vPad: 1, footerLines: 2 } as const;

/** Dinobot Signal columns: full-bleed (0-column page margin); every row spans the terminal edge to edge (header,
 * transcript, status rows, dock, prompt box, footer, panes); bullet/text/rightPad are offsets from the screen edge
 * (bullets at column 3, text at 5). `frameInset` is the subagent takeover frame's own inset. */
export const spacing = {
	margin: 0,
	bullet: 3,
	text: 5,
	rightPad: 2,
	timestamp: 11,
	status: 1,
	frameInset: 2,
} as const;

export function formatElapsed(ms: number, fractional = false): string {
	const seconds = Math.max(0, ms) / 1000;
	if (fractional && seconds < 10) return `${seconds.toFixed(1)}s`;
	const whole = Math.floor(seconds);
	if (whole < 60) return `${whole}s`;
	const minutes = Math.floor(whole / 60);
	const rest = whole % 60;
	if (minutes < 60) return `${minutes}m${rest}s`;
	return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

export function formatTokens(count: number): string {
	if (count < 1_000) return `${count}`;
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}K`;
	if (count < 1_000_000) return `${Math.floor(count / 1_000)}K`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

export function formatTurnTokens(count: number): string {
	if (count < 1_000) return `${count}`;
	return `${(count / 1_000).toFixed(1)}k`;
}

export function formatClock(epochMs: number): string {
	const date = new Date(epochMs);
	const hours = date.getHours();
	const minutes = date.getMinutes().toString().padStart(2, "0");
	return `${hours % 12 === 0 ? 12 : hours % 12}:${minutes} ${hours < 12 ? "AM" : "PM"}`;
}
