import { Type } from "@earendil-works/pi-ai";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { Static } from "typebox";
import { definePlugin, PluginContent, type PluginContentBlock, type PluginHost, type PluginTool, type PluginToolCall } from "../types.ts";
import { ACTIONS, DESCRIBE, FRIENDLY_ACTIONS, INPUT_ACTIONS } from "./actions.ts";
import { CUA_DRIVER, CUA_DRIVER_ID, driverEnvironment } from "./driver.ts";
import { ComputerError, parseWindowQuery, parseWindows, resolveWindow, windowList } from "./windows.ts";

const CHANNEL = "^(\\*|[a-z][a-z0-9_-]*)$";
const config = Type.Object(
	{
		/** Channels whose conversations may use the tool; `*` allows every channel. Default: the local TUI only. */
		channels: Type.Optional(Type.Array(Type.String({ pattern: CHANNEL }), { minItems: 1, uniqueItems: true })),
		/** A cua-driver executable to run instead of the one `dinobot init` installs. */
		command: Type.Optional(Type.String({ minLength: 1 })),
		/** Arguments for `command`. Default: `["mcp"]`. */
		args: Type.Optional(Type.Array(Type.String())),
		/** Extra child environment; wins over the defaults. */
		env: Type.Optional(Type.Record(Type.String(), Type.String())),
		/**
		 * `auto` (default): an input action the app refuses in the background (`background_unavailable`, nothing
		 * delivered) is retried once in the foreground. `never`: report BackgroundUnavailable; only an explicit
		 * `takeover: true` brings a window forward.
		 */
		takeover: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("never")])),
	},
	{ additionalProperties: false },
);
type Config = Static<typeof config>;

export const DEFAULT_CHANNELS = ["tui"] as const;
const CALL_TIMEOUT_MS = 120_000;
const MAX_TEXT = 200_000;
const SMALL_FIELD = 400;
/** Structured keys that are prose for humans, capture diagnostics or a copy of the text (`tree_markdown`). */
const NOISE_FIELDS = new Set(["_note", "capture_coverage", "tree_markdown"]);
const OBSERVE_MAX_ELEMENTS = 400;
const FOREGROUND_NOTE = "(briefly brought the window to the foreground)";
/** Driver refusal codes meaning the element token no longer names an element of the window's current snapshot. */
const STALE_REFUSAL = /stale|element_token|element_index|element_not_found|unknown_element|snapshot/;
/** Arguments the v2 layer understands on top of each driver action's own. */
const PLUGIN_ARGS = ["window", "element", "takeover"];
const FRIENDLY_DESCRIPTIONS: Record<(typeof FRIENDLY_ACTIONS)[number], { description: string; arguments: unknown }> = {
	windows: {
		description: "List open windows compactly, one line per window: app (pid) \"title\" [window_id].",
		arguments: {
			type: "object",
			properties: {
				filter: { type: "string", description: "Case-insensitive substring of the app name or title." },
				on_screen_only: { type: "boolean", description: "Drop windows that are not on screen." },
			},
			additionalProperties: false,
		},
	},
	observe: {
		description: "Accessibility tree with [N] element indexes plus a screenshot of one window (get_window_state, max_elements 400). Act on it with element: N or pixel x,y of the screenshot.",
		arguments: {
			type: "object",
			properties: {
				window: { description: "App/title substring, or {app?, title?, id?}. Replaces pid + window_id." },
				screenshot: { type: "boolean", description: "Default true; false skips the image (cheap re-index)." },
				query: { type: "string", description: "Case-insensitive substring; keep only matching rows and their ancestors." },
				max_elements: { type: "integer", description: "Default 400." },
				max_depth: { type: "integer" },
			},
			additionalProperties: true,
		},
	},
};

type DriverTool = { name: string; description?: string | undefined; inputSchema: unknown };
type Connection = { client: Client; tools: Map<string, DriverTool>; stderr: () => string };
type Content = { type: string; text?: string; data?: string; mimeType?: string };

const DESCRIPTION = [
	"Observe and operate desktop apps on the machine running dinobot, through cua-driver. Pick an action and pass its arguments in `args`.",
	"Flow: `windows` {filter?} lists open windows -> `observe` {window: \"Chrome\"} returns the accessibility tree with [N] element indexes and a screenshot",
	"-> act on the same window: `click` {window: \"Chrome\", element: 12}, `type_text` {window, element, text}, `press_key`/`hotkey` {window, ...},",
	"or pixel x,y of that screenshot. `window` is a case-insensitive app/title substring or {app?, title?, id?} and replaces pid + window_id;",
	"`element` is the [N] index of the latest observe of that window. Input goes to the window in the background; if the app refuses background input",
	"it is retried once in the foreground automatically (`takeover: true` forces it). Errors start with a stable code: WindowNotFound, AmbiguousWindow,",
	"NoSnapshot, StaleRef (observe again), BackgroundUnavailable, InvalidArguments, InvalidCoordinateFrame.",
	"Raw driver arguments (pid, window_id, element_token, delivery_mode) still work.",
	`Use action "${DESCRIBE}" with args {action} for one action's exact argument schema, or with no args to list the actions this driver serves.`,
].join(" ");

const PROMPT = [
	"computer_use controls real desktop apps on the host. Observe before acting and act only on windows the task needs:",
	"`windows` -> `observe {window}` -> act with {window, element: N} or pixel x,y of that observe's screenshot; observe again after the screen changes.",
	"Screenshots and accessibility trees can expose private content from unrelated apps (chat, mail, browsers); do not read or act on them unless the user asked.",
	"Confirm each effect from the action result (`effect`, `verified`) or a fresh observe instead of assuming it landed.",
].join(" ");

/**
 * Structured output is only rendered back as text here, so validating it against the driver's output schemas adds
 * nothing; the SDK's default ajv also logs dozens of `unknown format "uint64"` warnings per start for this driver.
 */
const ACCEPT_ANY = { getValidator: () => (input: unknown) => ({ valid: true as const, data: input as never, errorMessage: undefined }) };

/** One lazily started `cua-driver mcp` child shared by all calls; a closed or crashed child is restarted on the next call. */
class Driver {
	#connection: Promise<Connection> | undefined;
	#closed = false;

	constructor(private readonly options: Config, private readonly host: PluginHost) {}

	connect(): Promise<Connection> {
		if (this.#closed) return Promise.reject(new Error("computer plugin is closed"));
		if (!this.#connection) {
			// Runs after `attempt` is assigned: on a failed start, or when the child exits or the transport closes.
			const release = () => {
				if (this.#connection === attempt) this.#connection = undefined;
			};
			const attempt: Promise<Connection> = this.#open(release);
			this.#connection = attempt;
			attempt.catch(release);
		}
		return this.#connection;
	}

	async #open(release: () => void): Promise<Connection> {
		const command = this.options.command ?? (await this.host.resolveDependency(CUA_DRIVER_ID));
		if (!command) {
			throw new Error(`cua-driver ${CUA_DRIVER.version} is not installed. Run \`dinobot init\` on this machine, or set plugins.computer.command.`);
		}
		let stderr = "";
		const transport = new StdioClientTransport({
			command,
			args: this.options.args ?? ["mcp"],
			env: driverEnvironment(process.env, this.options.env),
			stderr: "pipe",
		});
		transport.stderr?.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString("utf8")).slice(-4000);
		});
		const client = new Client({ name: "dinobot", version: "1" }, { jsonSchemaValidator: ACCEPT_ANY });
		client.onclose = release;
		try {
			await client.connect(transport);
			const tools = new Map<string, DriverTool>();
			let cursor: string | undefined;
			do {
				const page = await client.listTools(cursor === undefined ? {} : { cursor });
				for (const tool of page.tools) tools.set(tool.name, tool);
				cursor = page.nextCursor;
			} while (cursor !== undefined);
			return { client, tools, stderr: () => stderr };
		} catch (error) {
			await client.close().catch(() => {});
			const detail = stderr.trim().split("\n").slice(-5).join("\n");
			throw new Error(`cannot start cua-driver (${command}): ${error instanceof Error ? error.message : String(error)}${detail ? `\n${detail}` : ""}`);
		}
	}

	async close(): Promise<void> {
		this.#closed = true;
		const connection = this.#connection;
		this.#connection = undefined;
		if (connection) await (await connection.catch(() => undefined))?.client.close();
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The gate runs before the driver starts: a disallowed channel never spawns or reaches it. */
async function admit(channels: readonly string[], call: PluginToolCall): Promise<void> {
	if (channels.includes("*")) return;
	const channel = await call.channel?.();
	if (channel !== undefined && channels.includes(channel)) return;
	const where = channel === undefined ? "calls outside a channel thread" : `the ${channel} channel`;
	throw new Error(`computer_use is not enabled for ${where}; plugins.computer.channels allows: ${channels.join(", ")}`);
}

/** Stop waiting when the call is aborted; the shared connection keeps starting for later calls. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason ?? new Error("aborted"));
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

function clip(text: string): string {
	return text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT)}\n[truncated: ${text.length - MAX_TEXT} more characters]`;
}

function describe(connection: Connection, args: Record<string, unknown>, available: readonly string[]): string {
	const friendly = FRIENDLY_ACTIONS.filter((name) => available.includes(name === "windows" ? "list_windows" : "get_window_state"));
	const name = args.action;
	if (name === undefined) {
		return [
			...friendly.map((action) => `${action}: ${FRIENDLY_DESCRIPTIONS[action].description}`),
			...available.map((action) => `${action}: ${(connection.tools.get(action)?.description ?? "").split("\n")[0]!.slice(0, 200)}`),
		].join("\n");
	}
	if (typeof name === "string" && (friendly as readonly string[]).includes(name)) {
		const { description, arguments: schema } = FRIENDLY_DESCRIPTIONS[name as (typeof FRIENDLY_ACTIONS)[number]];
		return JSON.stringify({ action: name, description, arguments: schema }, null, 2);
	}
	if (typeof name !== "string" || !available.includes(name)) {
		throw new ComputerError("InvalidArguments", `describe: unknown action ${JSON.stringify(name)}; available: ${[...friendly, ...available].join(", ")}`);
	}
	const tool = connection.tools.get(name)!;
	return clip(JSON.stringify({
		action: name,
		description: tool.description ?? "",
		arguments: tool.inputSchema,
		plugin_arguments: {
			window: "app/title substring or {app?, title?, id?}; replaces pid + window_id",
			element: "[N] index of the latest observe of that window; replaces element_token",
			takeover: "true: deliver input in the foreground (delivery_mode foreground)",
		},
	}, null, 2));
}

/**
 * The small top-level fields of structured output, as one JSON object; large values (element arrays, window lists)
 * and noise (`_note`, `capture_coverage`, the `tree_markdown` copy) stay out because the text already renders them. The driver's text omits
 * some fields actions need, notably `effect`/`verified` on actions.
 */
function smallFields(structured: unknown): string | undefined {
	if (!isRecord(structured)) return undefined;
	const kept: Record<string, unknown> = {};
	for (const [key, field] of Object.entries(structured)) {
		if (NOISE_FIELDS.has(key)) continue;
		const json = JSON.stringify(field);
		if (json !== undefined && json.length <= SMALL_FIELD) kept[key] = field;
	}
	return Object.keys(kept).length > 0 ? JSON.stringify(kept) : undefined;
}

type Raw = { content?: unknown; structuredContent?: unknown; isError?: unknown };

function raw(value: unknown): Raw {
	return (isRecord(value) ? value : {}) as Raw;
}

/** The driver's refusal code (`structuredContent.refusal.code`) of a failed call. */
function refusalCode(value: unknown): string | undefined {
	const { isError, structuredContent } = raw(value);
	if (!isError || !isRecord(structuredContent) || !isRecord(structuredContent.refusal)) return undefined;
	return typeof structuredContent.refusal.code === "string" ? structuredContent.refusal.code : undefined;
}

type Failure = (message: string, code: string | undefined) => Error;

/** Driver text and images in order; structured output stands in for missing text. Errors carry the driver's refusal. */
function result(value: unknown, failure: Failure = (message) => new Error(message)): string | PluginContent {
	const output = raw(value);
	const content = (Array.isArray(output.content) ? output.content : []) as Content[];
	const blocks: PluginContentBlock[] = [];
	for (const block of content) {
		if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") blocks.push({ type: "image", mimeType: block.mimeType, data: block.data });
		else if (block.type === "text") blocks.push({ type: "text", text: clip(block.text ?? "") });
		else blocks.push({ type: "text", text: `[${block.type} content omitted]` });
	}
	const hasText = blocks.some((block) => block.type === "text" && block.text.trim() !== "");
	if (!hasText && output.structuredContent !== undefined) blocks.unshift({ type: "text", text: clip(JSON.stringify(output.structuredContent)) });
	else if (hasText) {
		const fields = smallFields(output.structuredContent);
		if (fields) blocks.push({ type: "text", text: `structured: ${fields}` });
	}
	if (output.isError) {
		const text = blocks.filter((block) => block.type === "text").map((block) => (block as { text: string }).text).join("\n").trim();
		const refusal = isRecord(output.structuredContent) && output.structuredContent.refusal !== undefined ? `\n${JSON.stringify(output.structuredContent.refusal)}` : "";
		throw failure(`${text || "cua-driver reported an error"}${hasText ? refusal : ""}`, refusalCode(value));
	}
	if (blocks.some((block) => block.type === "image")) return new PluginContent(blocks);
	return blocks.map((block) => (block as { text: string }).text).join("\n");
}

function hasImage(value: unknown): boolean {
	const { content } = raw(value);
	return Array.isArray(content) && content.some((block) => isRecord(block) && block.type === "image");
}

function appendText(output: string | PluginContent, line: string): string | PluginContent {
	if (output instanceof PluginContent) return new PluginContent([...output.blocks, { type: "text", text: line }]);
	return output === "" ? line : `${output}\n${line}`;
}

/** Top-level argument names of a driver tool's input schema; undefined when the schema does not list them. */
function schemaProperties(schema: unknown): string[] | undefined {
	return isRecord(schema) && isRecord(schema.properties) ? Object.keys(schema.properties) : undefined;
}

/** `element` as the tree index: a non-negative integer, "12" or "[12]". */
function elementIndex(value: unknown): number {
	const text = typeof value === "string" ? value.trim().replace(/^\[(.*)\]$/, "$1") : undefined;
	const index = text !== undefined && /^\d+$/.test(text) ? Number(text) : value;
	if (typeof index !== "number" || !Number.isInteger(index) || index < 0) throw new ComputerError("InvalidArguments", "element must be the [N] index (a non-negative integer) from the latest observe");
	return index;
}

const windowKey = (pid: number, windowId: number) => `${pid}:${windowId}`;
const integer = (value: unknown): number | undefined => (typeof value === "number" && Number.isInteger(value) ? value : undefined);

type Takeover = "auto" | "never";

/**
 * The v2 layer over one driver: window targeting, element refs, observe/windows, automatic foreground takeover and
 * the pixel coordinate-frame guard. Remembers, per pid + window_id, the latest snapshot id (for element refs) and
 * whether this plugin instance has taken a screenshot of the window (pixel coordinates are in that frame).
 */
class Computer {
	readonly #snapshots = new Map<string, string>();
	readonly #screenshots = new Set<string>();

	constructor(private readonly takeover: Takeover) {}

	async run(connection: Connection, action: string, input: Record<string, unknown>, available: readonly string[], signal: AbortSignal | undefined): Promise<string | PluginContent> {
		const invoke = (name: string, args: Record<string, unknown>) =>
			connection.client.callTool({ name, arguments: args }, { timeout: CALL_TIMEOUT_MS, ...(signal ? { signal } : {}) });
		const target = action === "windows" ? "list_windows" : action === "observe" ? "get_window_state" : action;
		if (!available.includes(target)) throw new Error(`computer_use: this cua-driver build does not serve ${target}`);
		const props = schemaProperties(connection.tools.get(target)?.inputSchema);
		const failure = this.#failure(action, props);
		const args = { ...input };

		if (action === "windows") {
			const filter = args.filter;
			delete args.filter;
			if (filter !== undefined && (typeof filter !== "string" || filter.trim() === "")) throw new ComputerError("InvalidArguments", "windows: filter must be a non-empty string");
			const listed = await invoke("list_windows", args);
			result(listed, failure);
			return windowList(parseWindows(raw(listed).structuredContent), filter?.trim());
		}

		if (action === "observe") {
			const screenshot = args.screenshot;
			delete args.screenshot;
			if (screenshot !== undefined && typeof screenshot !== "boolean") throw new ComputerError("InvalidArguments", "observe: screenshot must be a boolean");
			if (screenshot === false) args.include_screenshot = false;
			args.include_screenshot ??= true;
			args.max_elements ??= OBSERVE_MAX_ELEMENTS;
			if (args.window === undefined && (integer(args.pid) === undefined || integer(args.window_id) === undefined)) {
				throw new ComputerError("InvalidArguments", "observe needs window (an app/title substring or {app?, title?, id?}) or pid + window_id");
			}
		}

		if (args.window !== undefined) {
			const query = parseWindowQuery(args.window);
			delete args.window;
			if (props !== undefined && !props.includes("pid") && !props.includes("window_id")) {
				throw new ComputerError("InvalidArguments", `${action} does not act on a window; drop window`);
			}
			const listed = await invoke("list_windows", {});
			result(listed, this.#failure("list_windows", schemaProperties(connection.tools.get("list_windows")?.inputSchema)));
			const window = resolveWindow(parseWindows(raw(listed).structuredContent), query);
			if (props === undefined || props.includes("pid")) args.pid = window.pid;
			if (props === undefined || props.includes("window_id")) args.window_id = window.window_id;
			else args.__window_id = window.window_id;
		}
		// The resolved window, also when the driver action takes only a pid.
		const pid = integer(args.pid);
		const windowId = integer(args.window_id) ?? integer(args.__window_id);
		delete args.__window_id;

		if (args.element !== undefined) {
			const index = elementIndex(args.element);
			delete args.element;
			if (args.element_token !== undefined) throw new ComputerError("InvalidArguments", "pass either element or element_token, not both");
			const snapshot = this.#snapshot(pid, windowId);
			args.element_token = `${snapshot}:${index}`;
		}

		if (args.takeover !== undefined) {
			const takeover = args.takeover;
			delete args.takeover;
			if (typeof takeover !== "boolean") throw new ComputerError("InvalidArguments", "takeover must be a boolean");
			if (takeover) {
				if (props !== undefined && !props.includes("delivery_mode")) throw new ComputerError("InvalidArguments", `${action} has no delivery mode; drop takeover`);
				args.delivery_mode = "foreground";
			}
		}

		const input_ = INPUT_ACTIONS.has(target);
		if (input_ && (args.x !== undefined || args.y !== undefined) && pid !== undefined && windowId !== undefined && !this.#screenshots.has(windowKey(pid, windowId))) {
			throw new ComputerError("InvalidCoordinateFrame", "observe (with screenshot) first: pixel x,y are coordinates in this window's latest observe screenshot");
		}

		let output = await invoke(target, args);
		let note = false;
		if (input_ && this.takeover === "auto" && refusalCode(output) === "background_unavailable" && args.delivery_mode !== "foreground") {
			// The driver refused before delivering anything, so one foreground retry cannot double the input.
			output = await invoke(target, { ...args, delivery_mode: "foreground" });
			note = true;
		}
		if (target === "get_window_state") this.#remember(output, pid, windowId);
		let rendered = result(output, failure);
		if (note) rendered = appendText(rendered, FOREGROUND_NOTE);
		if (action === "observe") rendered = appendText(rendered, "Act on this window with element: N (the [N] index above) or pixel x,y of this screenshot; observe again after the screen changes.");
		return rendered;
	}

	/** The cached snapshot of the target window; a pid alone is enough when this instance observed one window of it. */
	#snapshot(pid: number | undefined, windowId: number | undefined): string {
		if (pid === undefined) throw new ComputerError("InvalidArguments", "element needs window (or pid + window_id) to know which snapshot it indexes");
		if (windowId !== undefined) {
			const snapshot = this.#snapshots.get(windowKey(pid, windowId));
			if (snapshot !== undefined) return snapshot;
		} else {
			const entries = [...this.#snapshots].filter(([key]) => key.startsWith(`${pid}:`));
			if (entries.length === 1) return entries[0]![1];
		}
		throw new ComputerError("NoSnapshot", "observe the window first; element is the [N] index of the latest observe of that window");
	}

	#remember(output: unknown, pid: number | undefined, windowId: number | undefined): void {
		const { isError, structuredContent } = raw(output);
		if (isError || !isRecord(structuredContent)) return;
		const p = integer(structuredContent.pid) ?? pid;
		const w = integer(structuredContent.window_id) ?? windowId;
		if (p === undefined || w === undefined) return;
		const key = windowKey(p, w);
		if (typeof structuredContent.snapshot_id === "string") this.#snapshots.set(key, structuredContent.snapshot_id);
		if (hasImage(output)) this.#screenshots.add(key);
	}

	/** Maps driver refusals to stable error codes; `invalid_arguments` lists the action's valid argument names. */
	#failure(action: string, props: readonly string[] | undefined): Failure {
		return (message, code) => {
			if (code === "invalid_arguments") {
				const own = action === "observe" ? ["window", "screenshot"] : PLUGIN_ARGS;
				const valid = props === undefined ? `(see describe {action: "${action}"})` : [...props, ...own].join(", ");
				return new ComputerError("InvalidArguments", `${message}\nValid arguments for ${action}: ${valid}`);
			}
			if (code === "background_unavailable") {
				const hint = this.takeover === "never"
					? "Automatic takeover is off (plugins.computer.takeover: never); pass takeover: true to deliver it in the foreground."
					: "Pass takeover: true to deliver it in the foreground.";
				return new ComputerError("BackgroundUnavailable", `${message}\nNothing was delivered. ${hint}`);
			}
			if (code !== undefined && STALE_REFUSAL.test(code)) return new ComputerError("StaleRef", `${message}\nobserve again to get fresh element indexes.`);
			return new Error(message);
		};
	}
}

function useTool(options: Config, driver: Driver): PluginTool {
	const channels = options.channels ?? [...DEFAULT_CHANNELS];
	const computer = new Computer(options.takeover ?? "auto");
	const known: readonly string[] = [...FRIENDLY_ACTIONS, ...ACTIONS, DESCRIBE];
	return {
		name: "use",
		description: DESCRIPTION,
		// Desktop control rarely follows from the request's wording; keep the (small) contract visible for planning.
		inlineSchema: true,
		inputSchema: {
			type: "object",
			properties: {
				action: { type: "string", enum: [...known], description: "Action to run: windows/observe or a cua-driver action" },
				args: { type: "object", description: "Arguments of the action (see describe); window, element and takeover work on every window action", additionalProperties: true },
			},
			required: ["action"],
			additionalProperties: false,
		},
		execute: async (input, call) => {
			if (!isRecord(input) || typeof input.action !== "string") throw new Error("computer_use: action must be a string");
			const action = input.action;
			if (!known.includes(action)) {
				throw new Error(`computer_use: unknown action ${JSON.stringify(action)}; use "${DESCRIBE}" to list actions`);
			}
			if (input.args !== undefined && !isRecord(input.args)) throw new Error("computer_use: args must be an object");
			const args = (input.args ?? {}) as Record<string, unknown>;
			await admit(channels, call);
			const connection = await abortable(driver.connect(), call.signal);
			const available = ACTIONS.filter((name) => connection.tools.has(name));
			if (action === DESCRIBE) return describe(connection, args, available);
			return computer.run(connection, action, args, available, call.signal);
		},
	};
}

/**
 * Desktop computer use through a pinned cua-driver child process (ADR 0059). Opt-in; `load` starts nothing, the
 * driver starts on the first allowed call. One tool, `computer_use`, forwards an allowlisted set of driver actions.
 */
export const computerPlugin = definePlugin({
	id: "computer",
	config,
	dependencies: [CUA_DRIVER],
	load: (options, host) => {
		const driver = new Driver(options, host);
		return { tools: [useTool(options, driver)], prompt: PROMPT, close: () => driver.close() };
	},
});
