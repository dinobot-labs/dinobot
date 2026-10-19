import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { type Bot, openBot } from "../src/core/bot.ts";
import type { ToolMode } from "../src/core/toolmode.ts";
import { pluginResultContent } from "../src/core/plugin-content.ts";
import { pathToFileURL } from "node:url";
import { ACTIONS } from "../src/plugins/computer/actions.ts";
import { resolveWindow, type WindowRecord } from "../src/plugins/computer/windows.ts";
import { CUA_DRIVER, driverEnvironment } from "../src/plugins/computer/driver.ts";
import { computerPlugin } from "../src/plugins/computer/index.ts";
import { pluginCatalog } from "../src/plugins/index.ts";
import { type LoadedPlugin, loadPlugin, PluginContent, type PluginHost, type PluginToolCall } from "../src/plugins/types.ts";
import { dependencyProblems } from "../src/deps/index.ts";

const context = BACKGROUND_CONTEXT;
const fixture = join(import.meta.dir, "fixtures", "fake-cua-driver.ts");
const loaded: LoadedPlugin[] = [];
const bots: Bot[] = [];
const dirs: string[] = [];
afterEach(async () => {
	for (const bot of bots.splice(0)) await bot.close(context);
	for (const plugin of loaded.splice(0)) await plugin.close?.();
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "dinobot-computer-"));
	dirs.push(dir);
	return dir;
}

async function load(config: Record<string, unknown>, host?: PluginHost): Promise<LoadedPlugin> {
	const result = await loadPlugin(computerPlugin, config, host);
	if (Array.isArray(result)) throw new Error(result.join("\n"));
	loaded.push(result);
	return result;
}

async function fake(extra: Record<string, unknown> = {}): Promise<{ plugin: LoadedPlugin; log: string }> {
	const log = join(await tempDir(), "spawns.log");
	const plugin = await load({ command: process.execPath, args: [fixture], env: { FAKE_DRIVER_LOG: log }, ...extra });
	return { plugin, log };
}

const tui: PluginToolCall = { channel: async () => "tui" };
const spawns = async (log: string) => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean).length;
const run = (plugin: LoadedPlugin, input: unknown, call: PluginToolCall = tui) => plugin.tools[0]!.execute(input, call);

describe("computer plugin", () => {
	test("exposes one effectful computer_use tool with a closed action enum and a top-level object schema", async () => {
		const { plugin } = await fake();
		expect(plugin.tools.map((tool) => tool.name)).toEqual(["computer_use"]);
		const tool = plugin.tools[0]!;
		expect(tool.readOnly).not.toBe(true);
		const schema = tool.inputSchema as { type: string; properties: { action: { enum: string[] } }; required: string[] };
		expect(schema.type).toBe("object");
		expect(schema.required).toEqual(["action"]);
		expect(schema.properties.action.enum).toEqual(["windows", "observe", ...ACTIONS, "describe"]);
		expect(plugin.prompt).toContain("computer_use");
	});

	test("load starts nothing; the driver starts on the first allowed call and is shared", async () => {
		const { plugin, log } = await fake();
		expect(await spawns(log)).toBe(0);
		expect(await run(plugin, { action: "list_windows" })).toContain("window_id=7");
		await run(plugin, { action: "list_windows" });
		expect(await spawns(log)).toBe(1);
	});

	test("the default channel gate admits only tui and rejects before spawning", async () => {
		const { plugin, log } = await fake();
		await expect(run(plugin, { action: "list_windows" }, { channel: async () => "telegram" })).rejects.toThrow("not enabled for the telegram channel");
		await expect(run(plugin, { action: "list_windows" }, { channel: async () => undefined })).rejects.toThrow("calls outside a channel thread");
		await expect(run(plugin, { action: "list_windows" }, {})).rejects.toThrow("calls outside a channel thread");
		expect(await spawns(log)).toBe(0);
	});

	test("configured channels and the * wildcard", async () => {
		const telegram = (await fake({ channels: ["telegram"] })).plugin;
		expect(await run(telegram, { action: "list_windows" }, { channel: async () => "telegram" })).toContain("Fixture");
		await expect(run(telegram, { action: "list_windows" })).rejects.toThrow("allows: telegram");
		const any = (await fake({ channels: ["*"] })).plugin;
		expect(await run(any, { action: "list_windows" }, {})).toContain("Fixture");
	});

	test("rejects unknown and non-forwarded actions before spawning, and malformed input", async () => {
		const { plugin, log } = await fake();
		await expect(run(plugin, { action: "install_extension" })).rejects.toThrow('unknown action "install_extension"');
		await expect(run(plugin, { action: 5 })).rejects.toThrow("action must be a string");
		await expect(run(plugin, { action: "click", args: [1] })).rejects.toThrow("args must be an object");
		expect(await spawns(log)).toBe(0);
		await expect(run(plugin, { action: "zoom", args: {} })).rejects.toThrow("does not serve zoom");
	});

	test("text results keep the driver text and append only small structured fields", async () => {
		const { plugin } = await fake();
		const text = String(await run(plugin, { action: "list_windows" }));
		expect(text).toContain('window_id=7 pid=42 "Fixture"');
		expect(text).toContain('structured: {"count":1}');
		expect(text).not.toContain("padding");
		const clicked = String(await run(plugin, { action: "click", args: { pid: 42, element_token: "s00000001:0" } }));
		expect(clicked).toContain("Clicked s00000001:0");
		expect(clicked).toContain('"effect":"confirmed"');
	});

	test("image results keep order, carry snapshot_id, and reach the model as validated images", async () => {
		const { plugin } = await fake();
		const value = await run(plugin, { action: "get_window_state", args: { pid: 42, window_id: 7 } });
		expect(value).toBeInstanceOf(PluginContent);
		const blocks = (value as PluginContent).blocks;
		expect(blocks.map((block) => block.type)).toEqual(["text", "image", "text"]);
		expect((blocks[2] as { text: string }).text).toContain('"snapshot_id":"s00000001"');
		expect((blocks[2] as { text: string }).text).not.toContain("elements");
		const content = await pluginResultContent(value);
		expect(content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
	});

	test("driver errors become tool errors with the refusal", async () => {
		const { plugin } = await fake();
		await expect(run(plugin, { action: "click", args: { element_token: "bad" } })).rejects.toThrow(/invalid format[\s\S]*invalid_element_token/);
	});

	test("describe lists served actions and returns one action's schema", async () => {
		const { plugin } = await fake();
		const list = String(await run(plugin, { action: "describe" }));
		expect(list.split("\n")).toEqual([expect.stringMatching(/^windows: List open windows/), expect.stringMatching(/^observe: Accessibility tree/), "list_windows: List top-level windows.", "get_window_state: Snapshot a window.", "health_report: Report health and the environment it sees.", "click: Click a target pid.", "end_session: Exits the process to simulate a crash."]);
		const one = JSON.parse(String(await run(plugin, { action: "describe", args: { action: "get_window_state" } }))) as { action: string; arguments: { properties: Record<string, unknown> } };
		expect(one.action).toBe("get_window_state");
		expect(Object.keys(one.arguments.properties)).toEqual(["pid", "window_id"]);
		await expect(run(plugin, { action: "describe", args: { action: "install_extension" } })).rejects.toThrow("unknown action");
	});

	test("the child gets desktop variables and dinobot's driver settings but not the parent's secrets", async () => {
		const saved = { WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY, FAKE_SECRET: process.env.FAKE_SECRET, CUA_EXTRA: process.env.CUA_EXTRA };
		process.env.WAYLAND_DISPLAY = "wayland-test";
		process.env.FAKE_SECRET = "provider-token";
		process.env.CUA_EXTRA = "kept";
		try {
			const { plugin } = await fake();
			const env = JSON.parse(String(await run(plugin, { action: "health_report" })));
			expect(env).toEqual({
				DO_NOT_TRACK: "1", CUA_DRIVER_RS_UPDATE_CHECK: "0", CUA_DRIVER_RS_ENABLE_WAYLAND: "1",
				WAYLAND_DISPLAY: "wayland-test", FAKE_SECRET: null, CUA_EXTRA: "kept",
			});
		} finally {
			for (const [name, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
	});

	test("driverEnvironment: Wayland opt-in only on Wayland, explicit settings win", () => {
		expect(driverEnvironment({ PATH: "/bin", SECRET: "x" })).toEqual({ PATH: "/bin", DO_NOT_TRACK: "1", CUA_DRIVER_RS_UPDATE_CHECK: "0" });
		expect(driverEnvironment({ WAYLAND_DISPLAY: "w", CUA_DRIVER_RS_ENABLE_WAYLAND: "0" }).CUA_DRIVER_RS_ENABLE_WAYLAND).toBe("0");
		expect(driverEnvironment({ WAYLAND_DISPLAY: "w" }, { DO_NOT_TRACK: "0", CUA_DRIVER_RS_ENABLE_WAYLAND: "0" })).toMatchObject({ DO_NOT_TRACK: "0", CUA_DRIVER_RS_ENABLE_WAYLAND: "0" });
	});

	test("a crashed driver is restarted on the next call", async () => {
		const { plugin, log } = await fake();
		await run(plugin, { action: "end_session" });
		// The exit is observed asynchronously: calls before it reach the old child, a call racing it may fail,
		// and once it is observed the next call starts a second child.
		let listed: unknown;
		for (let attempt = 0; attempt < 100 && (await spawns(log)) < 2; attempt++) {
			listed = await run(plugin, { action: "list_windows" }).catch(() => undefined);
			await Bun.sleep(50);
		}
		expect(await spawns(log)).toBe(2);
		expect(listed ?? (await run(plugin, { action: "list_windows" }))).toContain("Fixture");
	});

	test("without command it runs the installed dependency, and says how to install it when missing", async () => {
		const missing = await load({});
		await expect(run(missing, { action: "list_windows" })).rejects.toThrow("Run `dinobot init`");
		const asked: string[] = [];
		const log = join(await tempDir(), "spawns.log");
		// The host resolves to bun; args point it at the fixture, as an installed driver would be run with ["mcp"].
		const installed = await load({ args: [fixture], env: { FAKE_DRIVER_LOG: log } }, {
			resolveDependency: async (id) => {
				asked.push(id);
				return process.execPath;
			},
		});
		expect(await run(installed, { action: "list_windows" })).toContain("Fixture");
		expect(asked).toEqual(["cua-driver"]);
	});

	test("a plugin can resolve only the dependencies it declares", async () => {
		const asked: string[] = [];
		const host: PluginHost = { resolveDependency: async (id) => (asked.push(id), "/x") };
		const probe = { ...computerPlugin, load: async (_config: unknown, scoped: PluginHost) => ({ tools: [], prompt: `${await scoped.resolveDependency("cua-driver")}|${await scoped.resolveDependency("other")}` }) };
		const result = await loadPlugin(probe, {}, host);
		if (Array.isArray(result)) throw new Error(result.join("\n"));
		expect(result.prompt).toBe("/x|undefined");
		expect(asked).toEqual(["cua-driver"]);
	});

	test("an aborted call stops waiting for the driver to start", async () => {
		const { plugin } = await fake();
		const abort = new AbortController();
		abort.abort(new Error("stop"));
		await expect(run(plugin, { action: "list_windows" }, { ...tui, signal: abort.signal })).rejects.toThrow("stop");
		expect(await run(plugin, { action: "list_windows" })).toContain("Fixture");
	});

	test("close stops the driver and later calls fail", async () => {
		const { plugin } = await fake();
		await run(plugin, { action: "list_windows" });
		await plugin.close?.();
		loaded.splice(loaded.indexOf(plugin), 1);
		await expect(run(plugin, { action: "list_windows" })).rejects.toThrow("closed");
	});

	test("config validation", async () => {
		expect(await loadPlugin(computerPlugin, { channels: [] })).toEqual(expect.arrayContaining([expect.stringContaining("plugins.computer/channels")]));
		expect(await loadPlugin(computerPlugin, { channels: ["Bad Name"] })).toEqual(expect.arrayContaining([expect.stringContaining("plugins.computer/channels")]));
		expect(await loadPlugin(computerPlugin, { unknown: 1 })).toEqual(expect.arrayContaining([expect.stringContaining("plugins.computer")]));
	});

	test("the pinned cua-driver declaration is well formed for macOS, Linux and Windows targets", () => {
		expect(dependencyProblems(CUA_DRIVER)).toEqual([]);
		expect(Object.keys(CUA_DRIVER.artifacts).sort()).toEqual(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"]);
		expect(pluginCatalog.computer).toBe(computerPlugin);
		expect(computerPlugin.enabledByDefault).not.toBe(true);
	});

	test("the computer plugin is detachable: only the catalog imports it and it imports only the plugin contract", async () => {
		const root = join(import.meta.dir, "..", "src");
		const files: string[] = [];
		const walk = async (path: string): Promise<void> => {
			for (const entry of await readdir(path, { withFileTypes: true })) {
				if (entry.isDirectory()) await walk(join(path, entry.name));
				else if (entry.name.endsWith(".ts")) files.push(join(path, entry.name));
			}
		};
		await walk(root);
		const pluginDir = join(root, "plugins", "computer");
		for (const path of files) {
			const name = relative(root, path);
			const source = await readFile(path, "utf8");
			// Static `from "x"`, bare `import "x"` and dynamic `import("x")`.
			const specs = [...source.matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)].map((match) => match[1]!);
			const resolved = specs.filter((spec) => spec.startsWith(".")).map((spec) => resolve(dirname(path), spec));
			if (name.startsWith("plugins/computer/")) {
				for (const target of resolved) expect(target.startsWith(`${pluginDir}/`) || target === join(root, "plugins", "types.ts")).toBe(true);
			} else if (name !== "plugins/index.ts") {
				expect(resolved.filter((target) => target.startsWith(`${pluginDir}/`) || target === pluginDir)).toEqual([]);
			}
		}
	});
});

// ---------------------------------------------------------------------------
// v2 layer: a richer fake driver generated at test time (several windows, snapshot ids that go stale, background
// refusals, strict argument names). Imports resolve to this checkout's packages by absolute file URL.
// ---------------------------------------------------------------------------
const V2_DRIVER = (server: string, stdio: string, zod: string) => `
import { appendFileSync } from "node:fs";
import { McpServer } from "${server}";
import { StdioServerTransport } from "${stdio}";
import * as z from "${zod}";

const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
const windows = JSON.parse(process.env.FAKE_WINDOWS || "[]");
const background = (process.env.FAKE_BACKGROUND || "").split(",").filter(Boolean);
const always = process.env.FAKE_BACKGROUND_ALWAYS === "1";
const current = new Map();
let counter = 0;
const log = (name, args) => { if (process.env.FAKE_CALLS) appendFileSync(process.env.FAKE_CALLS, JSON.stringify({ name, args }) + "\\n"); };
const refuse = (code, message) => ({ isError: true, content: [{ type: "text", text: message }], structuredContent: { status: "refused", refusal: { code, message } } });
const server = new McpServer({ name: "fake-cua-driver-v2", version: "0.34.0" });

function strict(name, allowed, args) {
	const unknown = Object.keys(args).filter((key) => !allowed.includes(key));
	return unknown.length > 0 ? refuse("invalid_arguments", name + ": unknown argument " + unknown[0]) : undefined;
}

function input(name, shape, act) {
	server.registerTool(name, { description: "Fake " + name + ".", inputSchema: z.looseObject(shape) }, async (args) => {
		log(name, args);
		const invalid = strict(name, Object.keys(shape), args);
		if (invalid) return invalid;
		if (args.element_token !== undefined) {
			const snapshot = String(args.element_token).split(":")[0];
			if (![...current.values()].includes(snapshot)) return refuse("stale_element_token", "element_token is stale; call get_window_state again to refresh");
		}
		if (background.includes(name) && (always || args.delivery_mode !== "foreground")) return refuse("background_unavailable", name + ": background delivery is unavailable for this window; nothing was delivered");
		return act(args);
	});
}

server.registerTool("list_windows", { description: "List top-level windows.", inputSchema: z.looseObject({ pid: z.number().optional(), on_screen_only: z.boolean().optional() }) }, async (args) => {
	log("list_windows", args);
	const shown = windows.filter((w) => !args.on_screen_only || w.is_on_screen !== false);
	return {
		content: [{ type: "text", text: "Found " + shown.length + " window(s)" }],
		structuredContent: { windows: shown, current_space_id: null },
	};
});

server.registerTool(
	"get_window_state",
	{
		description: "Snapshot a window.",
		inputSchema: z.looseObject({
			pid: z.number(), window_id: z.number(), include_screenshot: z.boolean().optional(), include_accessibility_tree: z.boolean().optional(),
			query: z.string().optional(), max_elements: z.number().optional(), max_depth: z.number().optional(), max_image_dimension: z.number().optional(),
		}),
	},
	async (args) => {
		log("get_window_state", args);
		const snapshot = "s" + ++counter;
		current.set(args.pid + ":" + args.window_id, snapshot);
		const content = [{ type: "text", text: "window_id=" + args.window_id + " pid=" + args.pid + "\\n- [0] button \\"OK\\"\\n- [12] link \\"Post\\"" }];
		if (args.include_screenshot !== false) content.push({ type: "image", mimeType: "image/png", data: PIXEL });
		return {
			content,
			structuredContent: {
				snapshot_id: snapshot, pid: args.pid, window_id: args.window_id, elements: [{ element_index: 0, label: "x".repeat(600) }], tree_markdown: "- [0] button",
				_note: "Prefer elements", capture_coverage: { kind: "window", limit: "bubbles" },
			},
		};
	},
);

const target = { pid: z.number().optional(), window_id: z.number().optional(), element_token: z.string().optional(), x: z.number().optional(), y: z.number().optional(), delivery_mode: z.string().optional() };
const done = (verb) => (args) => ({ content: [{ type: "text", text: verb + " " + JSON.stringify(args) }], structuredContent: { effect: "confirmed", verified: true } });
input("click", target, done("Clicked"));
input("type_text", { ...target, text: z.string().optional() }, done("Typed"));
input("press_key", { pid: z.number().optional(), window_id: z.number().optional(), key: z.string().optional(), delivery_mode: z.string().optional() }, (args) =>
	args.key === "fail" ? refuse("input_rejected", "press_key: the window rejected the key") : done("Pressed")(args));
server.registerTool("launch_app", { description: "Launch an app.", inputSchema: z.looseObject({ name: z.string().optional() }) }, async (args) => {
	log("launch_app", args);
	return { content: [{ type: "text", text: "launched" }] };
});

await server.connect(new StdioServerTransport());
`;

const WINDOWS: WindowRecord[] = [
	{ window_id: 1, pid: 100, app_name: "chrome.exe", title: "Inbox - Chrome", is_on_screen: true },
	{ window_id: 2, pid: 100, app_name: "chrome.exe", title: "Docs - Chrome", is_on_screen: true },
	{ window_id: 3, pid: 100, app_name: "chrome.exe", title: "원격 디버깅을 허용하시겠습니까?", is_on_screen: true },
	{ window_id: 4, pid: 200, app_name: "notepad.exe", title: "notes.txt - Notepad", is_on_screen: true },
	{ window_id: 5, pid: 300, app_name: "slack.exe", title: "general - Slack", is_on_screen: false },
	{ window_id: 6, pid: 400, app_name: "cua-driver.exe", title: "Cua.AgentCursorOverlay.default", is_on_screen: true },
];

let v2Script: Promise<string> | undefined;
const v2Dirs: string[] = [];
afterAll(async () => {
	for (const dir of v2Dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function v2DriverScript(): Promise<string> {
	v2Script ??= (async () => {
		const dir = await mkdtemp(join(tmpdir(), "dinobot-computer-v2-"));
		v2Dirs.push(dir);
		const url = (spec: string) => pathToFileURL(Bun.resolveSync(spec, import.meta.dir)).href;
		const path = join(dir, "fake-cua-driver-v2.ts");
		await Bun.write(path, V2_DRIVER(url("@modelcontextprotocol/server"), url("@modelcontextprotocol/server/stdio"), url("zod")));
		return path;
	})();
	return v2Script;
}

type Call = { name: string; args: Record<string, unknown> };

async function v2(options: { config?: Record<string, unknown>; windows?: unknown[]; background?: string[]; always?: boolean } = {}) {
	const calls = join(await tempDir(), "calls.log");
	const env: Record<string, string> = { FAKE_CALLS: calls, FAKE_WINDOWS: JSON.stringify(options.windows ?? WINDOWS) };
	if (options.background) env.FAKE_BACKGROUND = options.background.join(",");
	if (options.always) env.FAKE_BACKGROUND_ALWAYS = "1";
	const plugin = await load({ command: process.execPath, args: [await v2DriverScript()], env, ...options.config });
	const log = async (): Promise<Call[]> => (await readFile(calls, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as Call);
	const use = (action: string, args?: Record<string, unknown>) => run(plugin, args === undefined ? { action } : { action, args });
	const text = async (action: string, args?: Record<string, unknown>) => {
		const value = await use(action, args);
		return value instanceof PluginContent ? value.blocks.map((block) => (block.type === "text" ? block.text : `[image ${block.mimeType}]`)).join("\n") : String(value);
	};
	const sent = async (name: string) => (await log()).filter((call) => call.name === name).map((call) => call.args);
	return { plugin, log, use, text, sent };
}

// bun 1.4's expect(promise).rejects can stall while the plugin waits on the driver child's stdio; await the rejection
// ourselves and match its message.
const failure = (promise: Promise<unknown>): Promise<string> =>
	promise.then(
		(value) => {
			throw new Error(`expected a rejection, got ${String(value)}`);
		},
		(caught: Error) => caught.message,
	);

describe("computer_use v2 layer", () => {
	test("windows lists one compact line per window and filters by app or title", async () => {
		const { text } = await v2();
		const all = (await text("windows")).split("\n");
		expect(all[0]).toBe("5 window(s):");
		expect(all.join("\n")).not.toContain("AgentCursorOverlay");
		expect(all).toContain('chrome.exe (100) "Inbox - Chrome" [1]');
		expect(all).toContain('slack.exe (300) "general - Slack" [5] [off-screen]');
		expect(await text("windows", { filter: "CHROME" })).toBe(
			['3 of 5 window(s) match "CHROME":', 'chrome.exe (100) "Inbox - Chrome" [1]', 'chrome.exe (100) "Docs - Chrome" [2]', 'chrome.exe (100) "원격 디버깅을 허용하시겠습니까?" [3]'].join("\n"),
		);
		expect(await text("windows", { filter: "notes.txt" })).toContain("notepad.exe (200)");
		expect(await text("windows", { filter: "photoshop" })).toContain('No window matches "photoshop"');
		expect(await text("windows", { on_screen_only: true })).not.toContain("slack.exe");
		expect(await failure(text("windows", { filter: 5 }))).toContain("InvalidArguments: windows: filter must be a non-empty string");
	});

	test("window resolves one match by app/title substring or {app, title, id} and injects pid + window_id", async () => {
		const { use, sent } = await v2();
		await use("observe", { window: "notepad" });
		await use("observe", { window: { app: "chrome", title: "inbox" } });
		await use("observe", { window: { id: 3 } });
		await use("observe", { window: "원격 디버깅" });
		await use("observe", { window: "2" });
		const targets = (await sent("get_window_state")).map((args) => [args.pid, args.window_id]);
		expect(targets).toEqual([[200, 4], [100, 1], [100, 3], [100, 3], [100, 2]]);
		for (const args of await sent("get_window_state")) expect(args).not.toHaveProperty("window");
	});

	test("several matches are AmbiguousWindow with candidate ids; tie-breaks prefer title matches and skip the driver overlay", async () => {
		const { use, sent } = await v2();
		const error = await failure(use("observe", { window: "Chrome" }));
		expect(error).toStartWith('AmbiguousWindow: "Chrome" matches 2 windows');
		expect(error).toContain('chrome.exe (100) "Inbox - Chrome" [1]');
		expect(error).toContain('chrome.exe (100) "Docs - Chrome" [2]');
		// The Chrome-owned dialog matches only by app name; the title matches win the tie-break.
		expect(error).not.toContain("[3]");
		const byApp = await failure(use("observe", { window: { app: "chrome" } }));
		expect(byApp).toStartWith('AmbiguousWindow: {"app":"chrome"} matches 3 windows');
		// "exe" matches every app; the overlay and the off-screen window are narrowed away.
		const exe = await failure(use("observe", { window: "exe" }));
		expect(exe).toContain("matches 4 windows");
		expect(exe).not.toContain("cua-driver");
		expect(await sent("get_window_state")).toEqual([]);
	});

	test("zero matches are WindowNotFound listing open windows by app, matching app first, at most 12 apps and 3 windows each", async () => {
		const { use, sent } = await v2();
		const error = await failure(use("click", { window: { app: "notepad", title: "zzz" }, element: 0 }));
		expect(error).toStartWith('WindowNotFound: no window matches {"app":"notepad","title":"zzz"}. Open windows by app:');
		expect(error).not.toContain("AgentCursorOverlay");
		const lines = error.split("\n").slice(1);
		expect(lines[0]).toBe('- notepad.exe: (pid 200) "notes.txt - Notepad" [4]');
		expect(lines[1]).toStartWith('- chrome.exe: (pid 100) "Inbox - Chrome" [1]; (pid 100) "Docs - Chrome" [2]; (pid 100)');
		expect(await sent("click")).toEqual([]);

		const many: WindowRecord[] = [];
		for (let app = 0; app < 14; app++) for (let n = 0; n < (app === 0 ? 5 : 1); n++) many.push({ window_id: app * 10 + n, pid: 1000 + app, app_name: `app${app}.exe`, title: `w${n}` });
		const listed = (() => {
			try {
				resolveWindow(many, "photoshop");
				return "";
			} catch (caught) {
				return (caught as Error).message;
			}
		})().split("\n").slice(1);
		expect(lines.length).toBeGreaterThan(0);
		expect(listed).toHaveLength(13);
		expect(listed[0]).toBe('- app0.exe: (pid 1000) "w0" [0]; (pid 1000) "w1" [1]; (pid 1000) "w2" [2]; +2 more');
		expect(listed[12]).toBe("- +2 more apps");
		// The app named by the query is listed first even when it would be cut by the 12-app limit.
		const first = (() => {
			try {
				resolveWindow(many, { app: "app13", title: "nope" });
				return "";
			} catch (caught) {
				return (caught as Error).message;
			}
		})();
		expect(first.split("\n")[1]).toBe('- app13.exe: (pid 1013) "w0" [130]');
	});

	test("malformed window arguments and window on an action without a window are InvalidArguments", async () => {
		const { use, sent } = await v2();
		expect(await failure(use("observe", { window: { name: "x" } }))).toContain("InvalidArguments: window accepts only app, title and id");
		expect(await failure(use("observe", { window: "  " }))).toContain("InvalidArguments");
		expect(await failure(use("observe", { window: {} }))).toContain("InvalidArguments: window needs at least one of app, title, id");
		expect(await failure(use("observe", {}))).toContain("InvalidArguments: observe needs window");
		expect(await failure(use("launch_app", { window: "notepad", name: "x" }))).toContain("InvalidArguments: launch_app does not act on a window");
		expect(await sent("launch_app")).toEqual([]);
	});

	test("element N becomes element_token <snapshot_id>:N of the window's latest observe", async () => {
		const { use, text, sent } = await v2();
		await use("observe", { window: "notepad" });
		await use("observe", { window: { title: "inbox" } });
		await use("observe", { window: "notepad", screenshot: false });
		expect(await text("click", { window: "notepad", element: 12 })).toContain("Clicked");
		await use("type_text", { window: { title: "inbox" }, element: "[0]", text: "hi" });
		// A raw pid without window_id works when this instance observed exactly one window of that pid.
		await use("click", { pid: 200, element: "12" });
		const clicks = await sent("click");
		expect(clicks[0]).toEqual({ pid: 200, window_id: 4, element_token: "s3:12" });
		expect(clicks[1]).toEqual({ pid: 200, element_token: "s3:12" });
		expect(await sent("type_text")).toEqual([{ pid: 100, window_id: 1, element_token: "s2:0", text: "hi" }]);
		expect(await failure(use("click", { window: "notepad", element: -1 }))).toContain("InvalidArguments: element must be");
		expect(await failure(use("click", { window: "notepad", element: 1, element_token: "s3:1" }))).toContain("InvalidArguments: pass either element or element_token");
		expect(await failure(use("click", { element: 1 }))).toContain("InvalidArguments: element needs window");
	});

	test("element without a cached snapshot is NoSnapshot and reaches no driver input", async () => {
		const { use, sent } = await v2();
		expect(await failure(use("click", { window: "notepad", element: 1 }))).toContain("NoSnapshot: observe the window first");
		await use("observe", { window: "notepad" });
		expect(await failure(use("click", { window: { title: "inbox" }, element: 1 }))).toContain("NoSnapshot");
		expect(await sent("click")).toEqual([]);
	});

	test("a stale or invalid element token is StaleRef telling the model to observe again", async () => {
		const { use } = await v2();
		await use("observe", { window: "notepad" });
		await use("observe", { window: "notepad" });
		const error = await failure(use("click", { window: "notepad", element_token: "s1:0" }));
		expect(error).toStartWith("StaleRef: element_token is stale");
		expect(error).toContain("observe again");
		const { plugin } = await fake();
		expect(await failure(run(plugin, { action: "click", args: { element_token: "bad" } }))).toMatch(/^StaleRef: element_token has invalid format[\s\S]*observe again/);
	});

	test("observe defaults to 400 elements with a screenshot; screenshot:false skips the image; query and explicit limits pass through", async () => {
		const { use, sent } = await v2();
		const full = await use("observe", { window: "notepad" });
		expect(full).toBeInstanceOf(PluginContent);
		const blocks = (full as PluginContent).blocks;
		expect(blocks.map((block) => block.type)).toEqual(["text", "image", "text", "text"]);
		expect((blocks[3] as { text: string }).text).toContain("element: N");
		const cheap = await use("observe", { window: "notepad", screenshot: false, query: "OK", max_elements: 50 });
		expect(typeof cheap).toBe("string");
		expect(cheap).toContain('[0] button "OK"');
		expect(await sent("get_window_state")).toEqual([
			{ pid: 200, window_id: 4, include_screenshot: true, max_elements: 400 },
			{ pid: 200, window_id: 4, include_screenshot: false, max_elements: 50, query: "OK" },
		]);
		expect(await failure(use("observe", { window: "notepad", screenshot: "no" }))).toContain("InvalidArguments: observe: screenshot must be a boolean");
	});

	test("the structured line drops _note, capture_coverage, tree_markdown and large fields", async () => {
		const { text } = await v2();
		const observed = await text("observe", { window: "notepad" });
		const structured = observed.split("\n").find((line) => line.startsWith("structured: "))!;
		expect(JSON.parse(structured.slice("structured: ".length))).toEqual({ snapshot_id: "s1", pid: 200, window_id: 4 });
		expect(observed).not.toContain("_note");
		expect(observed).not.toContain("capture_coverage");
		expect(observed).not.toContain("tree_markdown");
	});

	test("auto takeover retries a background_unavailable input once in the foreground and says so", async () => {
		const { use, text, sent } = await v2({ background: ["type_text", "press_key"] });
		const typed = await text("type_text", { window: "notepad", text: "hi" });
		expect(typed).toContain("Typed");
		expect(typed).toEndWith("(briefly brought the window to the foreground)");
		expect(await sent("type_text")).toEqual([
			{ pid: 200, window_id: 4, text: "hi" },
			{ pid: 200, window_id: 4, text: "hi", delivery_mode: "foreground" },
		]);
		// Other refusals may have delivered input: never retried.
		expect(await failure(use("click", { window: "notepad", element_token: "s9:0" }))).toContain("StaleRef");
		expect(await sent("click")).toHaveLength(1);
		// takeover: true goes to the foreground on the first attempt, so no retry and no note.
		const forced = await text("press_key", { window: "notepad", key: "a", takeover: true });
		expect(forced).not.toContain("briefly brought");
		expect(await sent("press_key")).toEqual([{ pid: 200, window_id: 4, key: "a", delivery_mode: "foreground" }]);
		expect(await failure(use("press_key", { window: "notepad", key: "a", takeover: "yes" }))).toContain("InvalidArguments: takeover must be a boolean");
	});

	test("auto takeover retries only once and never retries other failures", async () => {
		const stubborn = await v2({ background: ["type_text"], always: true });
		expect(await failure(stubborn.use("type_text", { window: "notepad", text: "hi" }))).toMatch(/^BackgroundUnavailable: type_text: background delivery is unavailable/);
		expect(await stubborn.sent("type_text")).toHaveLength(2);
		const failing = await v2();
		expect(await failure(failing.use("press_key", { window: "notepad", key: "fail" }))).toContain("press_key: the window rejected the key");
		expect(await failing.sent("press_key")).toEqual([{ pid: 200, window_id: 4, key: "fail" }]);
	});

	test("takeover never reports BackgroundUnavailable without retrying; takeover: true still works", async () => {
		const { use, sent } = await v2({ config: { takeover: "never" }, background: ["type_text"] });
		const error = await failure(use("type_text", { window: "notepad", text: "hi" }));
		expect(error).toStartWith("BackgroundUnavailable: ");
		expect(error).toContain("pass takeover: true");
		expect(await sent("type_text")).toHaveLength(1);
		expect(String(await use("type_text", { window: "notepad", text: "hi", takeover: true }))).not.toContain("briefly brought");
		expect((await sent("type_text"))[1]).toMatchObject({ delivery_mode: "foreground" });
	});

	test("pixel input on a window needs a screenshot of that window from this plugin first", async () => {
		const { use, sent } = await v2();
		expect(await failure(use("click", { window: "notepad", x: 5, y: 6 }))).toContain("InvalidCoordinateFrame: observe (with screenshot) first");
		expect(await failure(use("click", { pid: 200, window_id: 4, x: 5, y: 6 }))).toContain("InvalidCoordinateFrame");
		await use("observe", { window: "notepad", screenshot: false });
		expect(await failure(use("click", { window: "notepad", x: 5, y: 6 }))).toContain("InvalidCoordinateFrame");
		expect(await sent("click")).toEqual([]);
		await use("observe", { window: "notepad" });
		await use("click", { window: "notepad", x: 5, y: 6 });
		// A screenshot of another window does not count; the raw get_window_state does.
		expect(await failure(use("click", { window: { title: "inbox" }, x: 1, y: 1 }))).toContain("InvalidCoordinateFrame");
		await use("get_window_state", { pid: 100, window_id: 1 });
		await use("click", { window: { title: "inbox" }, x: 1, y: 1 });
		expect(await sent("click")).toEqual([{ pid: 200, window_id: 4, x: 5, y: 6 }, { pid: 100, window_id: 1, x: 1, y: 1 }]);
	});

	test("invalid_arguments refusals are InvalidArguments listing the action's valid argument names", async () => {
		const { use } = await v2();
		const error = await failure(use("click", { window: "notepad", bogus: 1 }));
		expect(error).toStartWith("InvalidArguments: click: unknown argument bogus");
		expect(error).toContain("Valid arguments for click: pid, window_id, element_token, x, y, delivery_mode, window, element, takeover");
	});

	test("describe covers windows and observe", async () => {
		const { text } = await v2();
		const list = (await text("describe")).split("\n");
		expect(list.slice(0, 2).map((line) => line.split(":")[0])).toEqual(["windows", "observe"]);
		const observe = JSON.parse(await text("describe", { action: "observe" })) as { arguments: { properties: Record<string, unknown> } };
		expect(Object.keys(observe.arguments.properties)).toEqual(expect.arrayContaining(["window", "screenshot", "query"]));
		const click = JSON.parse(await text("describe", { action: "click" })) as { plugin_arguments: Record<string, string> };
		expect(Object.keys(click.plugin_arguments)).toEqual(["window", "element", "takeover"]);
	});

	test("takeover config validation", async () => {
		expect(await loadPlugin(computerPlugin, { takeover: "sometimes" })).toEqual(expect.arrayContaining([expect.stringContaining("plugins.computer/takeover")]));
		expect(Array.isArray(await loadPlugin(computerPlugin, { takeover: "never" }))).toBe(false);
	});
});

describe("computer_use in the bot", () => {
	async function startBot(plugin: LoadedPlugin, toolMode: ToolMode = "codemode-only") {
		const dir = await tempDir();
		const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
		const models = createModels();
		models.setProvider(faux.provider);
		const storage = await openNodeSqliteStorage(join(dir, "bot.sqlite"));
		const bot = await openBot({ storage, models, defaultModel: { provider: "faux", modelId: "faux-1" }, toolMode, plugins: [plugin] }, context);
		bots.push(bot);
		return { bot, faux };
	}

	async function callFrom(channel: string, code: string, toolMode: ToolMode = "codemode-only"): Promise<string> {
		const { plugin } = await fake();
		const { bot, faux } = await startBot(plugin, toolMode);
		let toolResult = "";
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" }),
			(transcript) => {
				toolResult = JSON.stringify(transcript.messages.at(-1));
				return fauxAssistantMessage("done");
			},
		]);
		await bot.handle({ channel, threadKey: "T1", messageId: "m1", userId: "U1", text: "use the computer" }, context);
		return toolResult;
	}

	test.each(["codemode-only", "hybrid"] as const)("%s: a tui conversation runs it from codemode and the screenshot is attached as an image", async (mode) => {
		const result = await callFrom("tui", "const r = await tools.computer_use({ action: 'get_window_state', args: { pid: 42, window_id: 7 } }); text(resultText(r)); return r.content.map((c) => c.type);", mode);
		expect(result).toContain('button \\"OK\\"');
		expect(result).toContain("s00000001");
		expect(result).toContain('"image"');
	});

	test("direct: the model calls computer_use itself and receives the image block", async () => {
		const { plugin } = await fake();
		const { bot, faux } = await startBot(plugin, "direct");
		let toolResult = "";
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("computer_use", { action: "get_window_state", args: { pid: 42, window_id: 7 } }), { stopReason: "toolUse" }),
			(transcript) => {
				toolResult = JSON.stringify(transcript.messages.at(-1));
				return fauxAssistantMessage("done");
			},
		]);
		await bot.handle({ channel: "tui", threadKey: "T1", messageId: "m1", userId: "U1", text: "look" }, context);
		expect(toolResult).toContain('"type":"image"');
		expect(toolResult).toContain("s00000001");
	});

	test("a telegram conversation is refused by the default channel gate", async () => {
		const result = await callFrom("telegram", "const r = await tools.computer_use({ action: 'list_windows' }); return r;");
		expect(result).toContain("not enabled for the telegram channel");
		expect(result).not.toContain("Fixture");
	});
});

// ---------------------------------------------------------------------------
// Optional live check against the real driver on a logged-in desktop with zenity:
// DINOBOT_COMPUTER_LIVE=1 bun test test/computer.test.ts   (after `dinobot init`)
// ---------------------------------------------------------------------------
describe.skipIf(!process.env.DINOBOT_COMPUTER_LIVE)("live: computer_use against the installed cua-driver", () => {
	test("a tui conversation reads a zenity dialog, types into it in the background and presses OK", async () => {
		const { dependencyHost } = await import("../src/deps/index.ts");
		const plugin = await load({}, dependencyHost(pluginCatalog));
		const dir = await tempDir();
		const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
		const models = createModels();
		models.setProvider(faux.provider);
		const bot = await openBot({ storage: await openNodeSqliteStorage(join(dir, "bot.sqlite")), models, defaultModel: { provider: "faux", modelId: "faux-1" }, toolMode: "codemode-only", plugins: [plugin] }, context);
		bots.push(bot);
		const title = `dinobot-live-${process.pid}`;
		const typed = `typed-by-dinobot-${Date.now()}`;
		const zenity = Bun.spawn(["zenity", "--entry", `--title=${title}`, "--text=live check"], { stdout: "pipe", stderr: "ignore" });
		try {
			const code = [
				"let win;",
				"for (let i = 0; i < 40 && !win; i++) {",
				"  const listed = resultText(await tools.computer_use({ action: 'list_windows' }));",
				`  const line = listed.split('\\n').find((l) => l.includes(${JSON.stringify(title)}));`,
				"  if (line) win = { pid: Number(/pid=(\\d+)/.exec(line)[1]), window_id: Number(/window_id=(\\d+)/.exec(line)[1]) };",
				"  else await new Promise((r) => setTimeout(r, 250));",
				"}",
				"const state = await tools.computer_use({ action: 'get_window_state', args: win });",
				"const tree = resultText(state);",
				"const snap = /\"snapshot_id\":\"([^\"]+)\"/.exec(tree)[1];",
				"const index = (re) => /\\[(\\d+)\\]/.exec(tree.split('\\n').find((l) => re.test(l)))[1];",
				`const t = resultText(await tools.computer_use({ action: 'type_text', args: { ...win, element_token: snap + ':' + index(/text box/), text: ${JSON.stringify(typed)} } }));`,
				"const c = resultText(await tools.computer_use({ action: 'click', args: { ...win, element_token: snap + ':' + index(/button \"OK\"/) } }));",
				"return { t, c };",
			].join("\n");
			let toolResult = "";
			faux.setResponses([
				fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" }),
				(transcript) => {
					toolResult = JSON.stringify(transcript.messages.at(-1));
					return fauxAssistantMessage("done");
				},
			]);
			await bot.handle({ channel: "tui", threadKey: "live", messageId: "m1", userId: "U1", text: "fill the dialog" }, context);
			// The screenshot reaches the model as an attachment of the codemode result (the worker only sees a marker).
			expect(toolResult).toContain('"type":"image"');
			expect(toolResult).toContain("confirmed");
			const exited = await Promise.race([zenity.exited, Bun.sleep(5000).then(() => "timeout")]);
			expect(exited).toBe(0);
			expect(await new Response(zenity.stdout).text()).toBe(`${typed}\n`);
		} finally {
			zenity.kill();
		}
	}, 60_000);
});
