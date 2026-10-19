/**
 * The friendly layer of `computer_use` (v2): stable error codes and window targeting by app/title instead of the
 * driver's pid + window_id. Pure functions over the driver's `list_windows` structured output.
 */

/** Stable error codes the model can branch on; every error of the v2 layer starts with `<code>: `. */
export type ErrorCode =
	| "WindowNotFound"
	| "AmbiguousWindow"
	| "NoSnapshot"
	| "StaleRef"
	| "BackgroundUnavailable"
	| "InvalidArguments"
	| "InvalidCoordinateFrame";

export class ComputerError extends Error {
	constructor(readonly code: ErrorCode, detail: string) {
		super(`${code}: ${detail}`);
		this.name = "ComputerError";
	}
}

/** One record of `list_windows` structured output (cua-driver: window_id, pid, app_name, title, is_on_screen, minimized). */
export type WindowRecord = {
	readonly window_id: number;
	readonly pid: number;
	readonly app_name: string;
	readonly title: string;
	readonly is_on_screen?: boolean;
	readonly minimized?: boolean;
};

/** `window` argument: a case-insensitive substring of app name or title, or explicit fields that must all match. */
export type WindowQuery = string | { readonly app?: string; readonly title?: string; readonly id?: number };

const MAX_APPS = 12;
const MAX_PER_APP = 3;
const MAX_CANDIDATES = 15;
const MAX_TITLE = 80;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Windows from `list_windows` structured output; malformed records are skipped. */
export function parseWindows(structured: unknown): WindowRecord[] {
	if (!isRecord(structured) || !Array.isArray(structured.windows)) return [];
	const windows: WindowRecord[] = [];
	for (const item of structured.windows) {
		if (!isRecord(item) || typeof item.window_id !== "number" || typeof item.pid !== "number") continue;
		windows.push({
			window_id: item.window_id,
			pid: item.pid,
			app_name: typeof item.app_name === "string" ? item.app_name : "",
			title: typeof item.title === "string" ? item.title : "",
			...(typeof item.is_on_screen === "boolean" ? { is_on_screen: item.is_on_screen } : {}),
			...(typeof item.minimized === "boolean" ? { minimized: item.minimized } : {}),
		});
	}
	return windows;
}

/** Validates the model's `window` argument. */
export function parseWindowQuery(value: unknown): WindowQuery {
	if (typeof value === "string") {
		if (value.trim() === "") throw new ComputerError("InvalidArguments", "window must be a non-empty app/title substring or {app?, title?, id?}");
		return value.trim();
	}
	if (isRecord(value)) {
		const unknown = Object.keys(value).filter((key) => key !== "app" && key !== "title" && key !== "id");
		if (unknown.length > 0) throw new ComputerError("InvalidArguments", `window accepts only app, title and id; got ${unknown.join(", ")}`);
		const query: { app?: string; title?: string; id?: number } = {};
		for (const key of ["app", "title"] as const) {
			const field = value[key];
			if (field === undefined) continue;
			if (typeof field !== "string" || field.trim() === "") throw new ComputerError("InvalidArguments", `window.${key} must be a non-empty string`);
			query[key] = field.trim();
		}
		if (value.id !== undefined) {
			const id = typeof value.id === "string" && /^\d+$/.test(value.id.trim()) ? Number(value.id) : value.id;
			if (typeof id !== "number" || !Number.isInteger(id)) throw new ComputerError("InvalidArguments", "window.id must be an integer window_id");
			query.id = id;
		}
		if (Object.keys(query).length === 0) throw new ComputerError("InvalidArguments", "window needs at least one of app, title, id");
		return query;
	}
	throw new ComputerError("InvalidArguments", "window must be a non-empty app/title substring or {app?, title?, id?}");
}

const has = (text: string, part: string) => text.toLowerCase().includes(part.toLowerCase());

function matches(window: WindowRecord, query: WindowQuery): boolean {
	if (typeof query === "string") {
		return has(window.app_name, query) || has(window.title, query) || (/^\d+$/.test(query) && window.window_id === Number(query));
	}
	if (query.id !== undefined && window.window_id !== query.id) return false;
	if (query.app !== undefined && !has(window.app_name, query.app)) return false;
	if (query.title !== undefined && !has(window.title, query.title)) return false;
	return true;
}

/** cua-driver's own agent-cursor overlay windows: never a target, left out of listings. */
const isOverlay = (window: WindowRecord) => /^cua-driver/i.test(window.app_name) || window.title.startsWith("Cua.AgentCursorOverlay");

/** Keep the subset when it is a non-empty proper narrowing; otherwise keep everything. */
function prefer(candidates: WindowRecord[], keep: (window: WindowRecord) => boolean): WindowRecord[] {
	const kept = candidates.filter(keep);
	return kept.length > 0 ? kept : candidates;
}

/**
 * All windows matching the query, narrowed by tie-breaks that never empty the set: drop the driver's own overlay
 * windows, then prefer an exact app/title match, then title matches over app-only matches (for a string query; so
 * "Chrome" picks "Inbox - Chrome" over a Chrome-owned dialog), then visible windows.
 */
export function matchWindows(windows: readonly WindowRecord[], query: WindowQuery): WindowRecord[] {
	let candidates = windows.filter((window) => matches(window, query));
	if (candidates.length <= 1) return candidates;
	candidates = prefer(candidates, (window) => !isOverlay(window));
	if (typeof query === "string") {
		const lower = query.toLowerCase();
		candidates = prefer(candidates, (window) => window.title.toLowerCase() === lower || window.app_name.toLowerCase().replace(/\.exe$/, "") === lower);
		candidates = prefer(candidates, (window) => has(window.title, query));
	}
	return prefer(candidates, (window) => window.is_on_screen !== false && window.minimized !== true);
}

function clipTitle(title: string): string {
	return title.length <= MAX_TITLE ? title : `${title.slice(0, MAX_TITLE - 1)}…`;
}

/** `app (pid) "title" [window_id]` plus visibility flags. */
export function formatWindow(window: WindowRecord): string {
	const flags = `${window.minimized ? " [minimized]" : window.is_on_screen === false ? " [off-screen]" : ""}`;
	return `${window.app_name} (${window.pid}) "${clipTitle(window.title)}" [${window.window_id}]${flags}`;
}

function describeQuery(query: WindowQuery): string {
	return JSON.stringify(query);
}

/** Open windows grouped by app (≤12 apps, ≤3 windows each), apps whose name matches the query first. */
function groupedList(windows: readonly WindowRecord[], query: WindowQuery): string {
	const groups = new Map<string, WindowRecord[]>();
	for (const window of windows) {
		if (isOverlay(window)) continue;
		const group = groups.get(window.app_name);
		if (group) group.push(window);
		else groups.set(window.app_name, [window]);
	}
	const appPart = typeof query === "string" ? query : query.app;
	const apps = [...groups.keys()];
	const ordered = appPart === undefined ? apps : [...apps.filter((app) => has(app, appPart)), ...apps.filter((app) => !has(app, appPart))];
	const lines = ordered.slice(0, MAX_APPS).map((app) => {
		const group = groups.get(app)!;
		const shown = group.slice(0, MAX_PER_APP).map((window) => `(pid ${window.pid}) "${clipTitle(window.title)}" [${window.window_id}]`);
		const more = group.length > MAX_PER_APP ? `; +${group.length - MAX_PER_APP} more` : "";
		return `- ${app || "(unknown app)"}: ${shown.join("; ")}${more}`;
	});
	if (ordered.length > MAX_APPS) lines.push(`- +${ordered.length - MAX_APPS} more apps`);
	return lines.length > 0 ? lines.join("\n") : "(no windows are open)";
}

/** The one window the query names, or WindowNotFound / AmbiguousWindow listing what the model can pick instead. */
export function resolveWindow(windows: readonly WindowRecord[], query: WindowQuery): WindowRecord {
	const candidates = matchWindows(windows, query);
	if (candidates.length === 1) return candidates[0]!;
	if (candidates.length === 0) {
		throw new ComputerError("WindowNotFound", `no window matches ${describeQuery(query)}. Open windows by app:\n${groupedList(windows, query)}`);
	}
	const shown = candidates.slice(0, MAX_CANDIDATES).map((window) => `- ${formatWindow(window)}`);
	if (candidates.length > MAX_CANDIDATES) shown.push(`- +${candidates.length - MAX_CANDIDATES} more`);
	throw new ComputerError(
		"AmbiguousWindow",
		`${describeQuery(query)} matches ${candidates.length} windows; pass window {id: <window_id>} or a more specific title:\n${shown.join("\n")}`,
	);
}

/** The `windows` action: one compact line per window, optionally filtered by an app/title substring. */
export function windowList(all: readonly WindowRecord[], filter: string | undefined): string {
	const windows = all.filter((window) => !isOverlay(window));
	const shown = filter === undefined ? windows : windows.filter((window) => has(window.app_name, filter) || has(window.title, filter));
	if (shown.length === 0) return filter === undefined ? "No windows are open." : `No window matches ${JSON.stringify(filter)} (${windows.length} open; call windows without filter to see them).`;
	const header = filter === undefined ? `${shown.length} window(s):` : `${shown.length} of ${windows.length} window(s) match ${JSON.stringify(filter)}:`;
	return [header, ...shown.map(formatWindow)].join("\n");
}
