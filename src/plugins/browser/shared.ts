/**
 * Pure pieces shared by the browser plugin (parent) and its Patchright host child: the action contract, argument
 * validation, ref normalization, DevToolsActivePort parsing and the RPC message shapes. No I/O here.
 */
import { join } from "node:path";
import type { BrowserReply } from "./ui.ts";

export type BrowserKind = "chrome" | "msedge" | "chromium";
export type BrowserMode = "dedicated" | "attach";

/** Everything the host child needs; the parent resolves defaults and passes it as JSON in DINOBOT_BROWSER_CONFIG. */
export type HostConfig = {
	readonly mode: BrowserMode;
	readonly browser: BrowserKind;
	/** Dedicated mode: the persistent user-data-dir Patchright launches Chrome with. */
	readonly profile: string;
	/** Attach mode: the user's Chrome user-data-dir, where Chrome writes DevToolsActivePort. */
	readonly userDataDir: string;
	readonly executablePath?: string;
	readonly humanize: boolean;
};

export type HostImage = { readonly mimeType: string; readonly data: string };
export type HostResult = { readonly text: string; readonly image?: HostImage; readonly ui?: BrowserReply };
export type HostRequest = { readonly id: number; readonly cmd: string; readonly args: Record<string, unknown> };
export type HostReply = { readonly id: number; readonly ok: true; readonly result: HostResult } | { readonly id: number; readonly ok: false; readonly error: string };

type ArgType = "string" | "number" | "boolean" | "strings";
type ActionSpec = { readonly args: Readonly<Record<string, ArgType>>; readonly required?: readonly string[]; readonly target?: "required" | "optional" };

const TARGET = { ref: "string", selector: "string" } as const;

/** The closed action set of `browser_use`, with each action's argument names and types. */
export const ACTION_SPECS = {
	status: { args: {} },
	open: { args: { url: "string", newTab: "boolean" }, required: ["url"] },
	snapshot: { args: { maxChars: "number" } },
	click: { args: { ...TARGET, button: "string", double: "boolean" }, target: "required" },
	fill: { args: { ...TARGET, text: "string" }, required: ["text"], target: "required" },
	type: { args: { ...TARGET, text: "string", submit: "boolean" }, required: ["text"], target: "optional" },
	press: { args: { key: "string" }, required: ["key"] },
	select: { args: { ...TARGET, values: "strings" }, required: ["values"], target: "required" },
	hover: { args: { ...TARGET }, target: "required" },
	scroll: { args: { ...TARGET, dy: "number", dx: "number" }, target: "optional" },
	upload: { args: { ...TARGET, paths: "strings" }, required: ["paths"], target: "required" },
	screenshot: { args: { fullPage: "boolean" } },
	tabs: { args: {} },
	tab: { args: { index: "number" }, required: ["index"] },
	close_tab: { args: { index: "number" } },
	back: { args: {} },
	forward: { args: {} },
	reload: { args: {} },
	wait: { args: { ms: "number", text: "string", url: "string" } },
	text: { args: { ...TARGET }, target: "optional" },
	eval: { args: { js: "string" }, required: ["js"] },
	dialog: { args: { accept: "boolean", promptText: "string" }, required: ["accept"] },
	window: { args: {} },
	close: { args: {} },
} as const satisfies Record<string, ActionSpec>;

export type Action = keyof typeof ACTION_SPECS;
export const ACTIONS = Object.keys(ACTION_SPECS) as Action[];

export function isAction(value: unknown): value is Action {
	return typeof value === "string" && Object.hasOwn(ACTION_SPECS, value);
}

const BUTTONS = ["left", "right", "middle"];

function invalid(action: string, problem: string): Error {
	const spec: ActionSpec = ACTION_SPECS[action as Action];
	const names = Object.keys(spec.args);
	return new Error(`InvalidArguments: ${action}: ${problem}; valid arguments: ${names.length > 0 ? names.join(", ") : "(none)"}`);
}

/** "e12" or "@e12" → "e12". Anything else is not a snapshot ref. */
export function normalizeRef(ref: string): string {
	const match = /^@?(e\d+)$/.exec(ref.trim());
	if (!match) throw new Error(`InvalidArguments: ref ${JSON.stringify(ref)} is not a snapshot ref like "e12" or "@e12"; take a snapshot first`);
	return match[1]!;
}

/**
 * Check `args` against the action's contract and return a normalized copy (refs without "@", `values`/`paths`
 * given as one string become a one-element list). Throws `InvalidArguments: ...` naming the valid arguments.
 */
export function validateArgs(action: Action, args: Record<string, unknown>): Record<string, unknown> {
	const spec: ActionSpec = ACTION_SPECS[action];
	const out: Record<string, unknown> = {};
	for (const [name, value] of Object.entries(args)) {
		if (value === undefined || value === null) continue;
		const type = spec.args[name];
		if (type === undefined) throw invalid(action, `unknown argument ${JSON.stringify(name)}`);
		if (type === "strings") {
			const list = typeof value === "string" ? [value] : value;
			if (!Array.isArray(list) || list.some((item) => typeof item !== "string")) throw invalid(action, `${name} must be a list of strings`);
			out[name] = list;
			continue;
		}
		if (type === "number" ? typeof value !== "number" || !Number.isFinite(value) : typeof value !== type) throw invalid(action, `${name} must be a ${type}`);
		out[name] = value;
	}
	for (const name of spec.required ?? []) if (out[name] === undefined) throw invalid(action, `${name} is required`);
	const targets = ["ref", "selector"].filter((name) => out[name] !== undefined);
	if (targets.length > 1) throw invalid(action, "pass either ref or selector, not both");
	if (spec.target === "required" && targets.length === 0) throw invalid(action, "ref (from snapshot) or selector is required");
	if (typeof out.ref === "string") out.ref = normalizeRef(out.ref);
	if (typeof out.selector === "string" && out.selector.trim() === "") throw invalid(action, "selector must not be empty");
	if (out.button !== undefined && !BUTTONS.includes(out.button as string)) throw invalid(action, `button must be one of ${BUTTONS.join(", ")}`);
	if (out.index !== undefined && (!Number.isInteger(out.index) || (out.index as number) < 0)) throw invalid(action, "index must be a non-negative integer");
	if (out.maxChars !== undefined && (out.maxChars as number) < 1) throw invalid(action, "maxChars must be positive");
	if (action === "wait") {
		const set = ["ms", "text", "url"].filter((name) => out[name] !== undefined);
		if (set.length !== 1) throw invalid(action, "pass exactly one of ms, text, url");
	}
	if (action === "open" && (out.url as string).trim() === "") throw invalid(action, "url must not be empty");
	return out;
}

/** Parse Chrome's `<UserData>/DevToolsActivePort`: line 1 the port, line 2 the browser target path. */
export function parseDevToolsActivePort(text: string): { port: number; path: string } | undefined {
	const [portLine, pathLine] = text.split(/\r?\n/).map((line) => line.trim());
	const port = Number(portLine);
	if (!portLine || !/^\d+$/.test(portLine) || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
	if (!pathLine || !pathLine.startsWith("/devtools/browser/")) return undefined;
	return { port, path: pathLine };
}

export function devToolsEndpoint(active: { port: number; path: string }): string {
	return `ws://127.0.0.1:${active.port}${active.path}`;
}

const USER_DATA: Record<BrowserKind, { win: string[]; mac: string[]; linux: string }> = {
	chrome: { win: ["Google", "Chrome", "User Data"], mac: ["Google", "Chrome"], linux: "google-chrome" },
	msedge: { win: ["Microsoft", "Edge", "User Data"], mac: ["Microsoft Edge"], linux: "microsoft-edge" },
	chromium: { win: ["Chromium", "User Data"], mac: ["Chromium"], linux: "chromium" },
};

/** The browser's default user-data-dir on this OS (where the user's own profile and DevToolsActivePort live). */
export function defaultUserDataDir(browser: BrowserKind, platform: string, env: Readonly<Record<string, string | undefined>>, home: string): string {
	const dirs = USER_DATA[browser];
	if (platform === "win32") return join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), ...dirs.win);
	if (platform === "darwin") return join(home, "Library", "Application Support", ...dirs.mac);
	return join(env.XDG_CONFIG_HOME ?? join(home, ".config"), dirs.linux);
}

export function brandName(browser: BrowserKind): string {
	return browser === "msedge" ? "Edge" : browser === "chromium" ? "Chromium" : "Chrome";
}

/** Patchright failures where the page is there but automation could not act; computer_use may still reach it. */
export function isFallbackError(message: string): boolean {
	return /Timeout \d+ms exceeded|timed out|not visible|intercepts pointer events|intercepted|detached|not attached|outside of the viewport|not stable|not enabled|not editable/i.test(message);
}

export function fallbackSuffix(title: string, browser: BrowserKind): string {
	return `Fallback: computer_use with window "${title}" (${brandName(browser)}) — observe it and act by element or pixels.`;
}

export function remoteDebuggingOff(userDataDir: string, browser: BrowserKind, platform: string, detail?: string): string {
	const brand = brandName(browser);
	const scheme = browser === "msedge" ? "edge" : "chrome";
	const newTab = platform === "darwin" ? "cmd+t" : "ctrl+t";
	return [
		`RemoteDebuggingOff: the user's ${brand} is not accepting a debugger connection${detail ? ` (${detail})` : ""} (looked for ${join(userDataDir, "DevToolsActivePort")}).`,
		`Turn it on once in the user's running ${brand}: open ${scheme}://inspect/#remote-debugging and tick "Allow remote debugging for this browser instance".`,
		`With computer_use: observe {window:"${brand}"}, hotkey ${newTab}, type_text "${scheme}://inspect/#remote-debugging", press_key return, observe again and click that checkbox.`,
		`Then call browser_use again. ${brand} must be running; if it is closed, ask the user to start it.`,
	].join("\n");
}

export function permissionPending(browser: BrowserKind): string {
	const brand = brandName(browser);
	return [
		`PermissionPending: ${brand} is asking the user to allow this connection. A ${brand} dialog "원격 디버깅을 허용하시겠습니까?" / "Allow remote debugging?" is open.`,
		`Click 허용 / Allow with computer_use (windows {filter:"원격 디버깅"} or {filter:"remote debugging"}, observe it, click the 허용/Allow button), then call browser_use again; the pending connection is kept and the next call picks it up.`,
	].join("\n");
}

/** Clip a long text with a note saying how much was cut. */
export function clip(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}\n[truncated: ${text.length - max} more characters]`;
}
