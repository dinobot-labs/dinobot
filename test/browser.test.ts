import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { pluginResultContent } from "../src/core/plugin-content.ts";
import { Session } from "../src/plugins/browser/host.ts";
import { browserPlugin, defaultHostCommand, hostEnvironment, resolveHostConfig } from "../src/plugins/browser/index.ts";
import { ACTIONS, defaultUserDataDir, devToolsEndpoint, isFallbackError, normalizeRef, parseDevToolsActivePort, validateArgs } from "../src/plugins/browser/shared.ts";
import { pluginCatalog } from "../src/plugins/index.ts";
import { type LoadedPlugin, loadPlugin, PluginContent, type PluginToolCall } from "../src/plugins/types.ts";
import { fakeChromium } from "./fixtures/browser-fake-host.ts";

const fixture = join(import.meta.dir, "fixtures", "browser-fake-host.ts");
const loaded: LoadedPlugin[] = [];
const dirs: string[] = [];
afterEach(async () => {
	for (const plugin of loaded.splice(0)) await plugin.close?.();
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("host entry", () => {
	test("source runs use host.ts next to index.ts", () => {
		expect(defaultHostCommand()).toEqual([process.execPath, join(import.meta.dir, "..", "src", "plugins", "browser", "host.ts")]);
	});

	test("the npm bundle uses browser-host.js next to main.js; a build with neither file fails clearly", async () => {
		const dir = await tempDir();
		const main = pathToFileURL(join(dir, "main.js"));
		expect(() => defaultHostCommand(main)).toThrow("browser host script is not available in this build");
		await writeFile(join(dir, "browser-host.js"), "");
		expect(defaultHostCommand(main)).toEqual([process.execPath, join(dir, "browser-host.js")]);
		await writeFile(join(dir, "host.ts"), "");
		expect(defaultHostCommand(main)).toEqual([process.execPath, join(dir, "host.ts")]);
	});
});

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "dinobot-browser-"));
	dirs.push(dir);
	return dir;
}

type Fake = { plugin: LoadedPlugin; log: string; dir: string };

async function fake(extra: Record<string, unknown> = {}, connectDelayMs = 0): Promise<Fake> {
	const dir = await tempDir();
	const log = join(dir, "host.log");
	const result = await loadPlugin(browserPlugin, { humanize: false, hostCommand: [process.execPath, fixture, log, String(connectDelayMs)], ...extra }, { resolveDependency: async () => undefined, dataDir: dir });
	if (Array.isArray(result)) throw new Error(result.join("\n"));
	loaded.push(result);
	return { plugin: result, log, dir };
}

async function attach(connectDelayMs = 0): Promise<Fake & { userDataDir: string }> {
	const userDataDir = join(await tempDir(), "User Data");
	await mkdir(userDataDir, { recursive: true });
	await writeFile(join(userDataDir, "DevToolsActivePort"), "9222\n/devtools/browser/abc-123\n");
	return { ...(await fake({ mode: "attach", userDataDir }, connectDelayMs)), userDataDir };
}

const tui: PluginToolCall = { channel: async () => "tui" };
const run = (plugin: LoadedPlugin, action: string, args?: Record<string, unknown>, call: PluginToolCall = tui) =>
	plugin.tools[0]!.execute(args === undefined ? { action } : { action, args }, call);
const text = async (plugin: LoadedPlugin, action: string, args?: Record<string, unknown>) => String(await run(plugin, action, args));
const lines = async (log: string) => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean);
/**
 * The rejection message of a call answered by the host child. (`expect(pending).rejects` can stall here on Windows
 * while the reply is still in the child's pipe, so await the promise itself.)
 */
async function failure(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error("expected the call to fail");
}
const spawns = async (log: string) => (await lines(log)).filter((line) => line.startsWith("spawn ")).length;

describe("browser plugin", () => {
	test("is registered in the catalog with a validated config schema", async () => {
		expect(pluginCatalog.browser).toBe(browserPlugin);
		expect(await loadPlugin(browserPlugin, { mode: "remote" })).toEqual(expect.arrayContaining([expect.stringContaining("plugins.browser/mode")]));
		expect(Array.isArray(await loadPlugin(browserPlugin, { headless: true }))).toBe(true);
		expect(Array.isArray(await loadPlugin(browserPlugin, { browser: "firefox" }))).toBe(true);
		const ok = await loadPlugin(browserPlugin, { mode: "attach", browser: "msedge", channels: ["tui", "slack"], humanize: false, profile: "/p", userDataDir: "/u", executablePath: "/c" });
		expect(Array.isArray(ok)).toBe(false);
		if (!Array.isArray(ok)) await ok.close?.();
	});

	test("exposes one effectful browser_use tool with a closed action enum", async () => {
		const { plugin } = await fake();
		expect(plugin.tools.map((tool) => tool.name)).toEqual(["browser_use"]);
		const tool = plugin.tools[0]!;
		expect(tool.readOnly).not.toBe(true);
		const schema = tool.inputSchema as { properties: { action: { enum: string[] } }; required: string[] };
		expect(schema.required).toEqual(["action"]);
		expect(schema.properties.action.enum).toEqual(ACTIONS);
		for (const action of ["status", "open", "snapshot", "click", "fill", "type", "press", "select", "hover", "scroll", "upload", "screenshot", "tabs", "tab", "close_tab", "back", "forward", "reload", "wait", "text", "eval", "dialog", "window", "close"]) {
			expect(ACTIONS).toContain(action as never);
		}
		expect(plugin.prompt).toContain("untrusted");
		expect(plugin.prompt).toContain("irreversible");
		expect(plugin.prompt).toContain("attach mode");
	});

	test("load starts nothing; the host spawns on the first real action and is reused", async () => {
		const { plugin, log, dir } = await fake();
		expect(await spawns(log)).toBe(0);
		expect(await text(plugin, "status")).toContain("not started");
		expect(await spawns(log)).toBe(0);
		expect(await text(plugin, "open", { url: "example.com" })).toContain("https://example.com");
		expect(await text(plugin, "snapshot")).toContain('button "OK" [ref=e1]');
		expect(await spawns(log)).toBe(1);
		const launch = (await lines(log)).find((line) => line.startsWith("launch "))!;
		expect(launch).toContain(join(dir, "browser", "profile"));
		const options = JSON.parse(launch.slice(launch.indexOf("{"))) as Record<string, unknown>;
		expect(options).toEqual({ channel: "chrome", headless: false, viewport: null, chromiumSandbox: true, args: ["--hide-crash-restore-bubble"] });
		// Dedicated mode reuses its first tab rather than opening another.
		expect((await lines(log)).filter((line) => line.startsWith("newPage"))).toHaveLength(1);
		expect(await text(plugin, "status")).toContain("state: connected");
	});

	test("the channel gate rejects before spawning", async () => {
		const { plugin, log } = await fake();
		await expect(run(plugin, "open", { url: "x.com" }, { channel: async () => "telegram" })).rejects.toThrow("not enabled for the telegram channel");
		await expect(run(plugin, "open", { url: "x.com" }, {})).rejects.toThrow("calls outside a channel thread");
		expect(await spawns(log)).toBe(0);
		const any = (await fake({ channels: ["*"] })).plugin;
		expect(await text(any, "status")).toContain("mode: dedicated");
	});

	test("unknown actions and invalid arguments are refused before spawning", async () => {
		const { plugin, log } = await fake();
		await expect(run(plugin, "install_extension")).rejects.toThrow('unknown action "install_extension"');
		await expect(plugin.tools[0]!.execute({ action: 5 }, tui)).rejects.toThrow("action must be a string");
		await expect(plugin.tools[0]!.execute({ action: "click", args: [1] }, tui)).rejects.toThrow("args must be an object");
		await expect(run(plugin, "open", {})).rejects.toThrow("InvalidArguments: open: url is required");
		await expect(run(plugin, "click", { ref: "e1", selector: "#a" })).rejects.toThrow("either ref or selector");
		await expect(run(plugin, "click", {})).rejects.toThrow("ref (from snapshot) or selector is required");
		await expect(run(plugin, "click", { ref: "button" })).rejects.toThrow('ref "button" is not a snapshot ref');
		await expect(run(plugin, "click", { ref: "e1", force: true })).rejects.toThrow('unknown argument "force"; valid arguments: ref, selector, button, double');
		await expect(run(plugin, "click", { ref: "e1", button: "back" })).rejects.toThrow("button must be one of");
		await expect(run(plugin, "wait", {})).rejects.toThrow("exactly one of ms, text, url");
		await expect(run(plugin, "wait", { ms: 1, text: "a" })).rejects.toThrow("exactly one of ms, text, url");
		await expect(run(plugin, "tab", { index: -1 })).rejects.toThrow("non-negative integer");
		await expect(run(plugin, "fill", { ref: "e1", text: 5 })).rejects.toThrow("text must be a string");
		expect(await spawns(log)).toBe(0);
	});

	test("refs accept e12 and @e12 and act through aria-ref locators", async () => {
		expect(normalizeRef("e12")).toBe("e12");
		expect(normalizeRef("@e12")).toBe("e12");
		expect(() => normalizeRef("12")).toThrow("InvalidArguments");
		expect(validateArgs("select", { ref: "@e3", values: "a" })).toEqual({ ref: "e3", values: ["a"] });
		const { plugin, log } = await fake();
		await text(plugin, "open", { url: "https://example.com" });
		expect(await text(plugin, "click", { ref: "@e2" })).toContain("Clicked ref e2");
		await text(plugin, "click", { ref: "e1", button: "right" });
		await text(plugin, "click", { selector: "#go", double: true });
		await text(plugin, "fill", { ref: "e2", text: "kim" });
		await text(plugin, "type", { text: "hi", ref: "e2", submit: true });
		await text(plugin, "select", { ref: "e3", values: ["b", "c"] });
		await text(plugin, "hover", { ref: "e1" });
		await text(plugin, "scroll", { dy: 300 });
		await text(plugin, "scroll", { ref: "e3" });
		await text(plugin, "upload", { selector: "#file", paths: ["/tmp/a.txt"] });
		await text(plugin, "press", { key: "Escape" });
		const log1 = await lines(log);
		for (const expected of [
			"click aria-ref=e2",
			"click aria-ref=e1 right",
			"dblclick #go",
			'fill aria-ref=e2 "kim"',
			'type "hi"',
			"press Enter",
			"select aria-ref=e3 b,c",
			"hover aria-ref=e1",
			"wheel 0 300",
			"scrollIntoView aria-ref=e3",
			"setInputFiles #file /tmp/a.txt",
			"press Escape",
		]) {
			expect(log1.some((line) => line.endsWith(expected))).toBe(true);
		}
	});

	test("action failures end with the computer_use fallback; stale refs fail fast without it", async () => {
		const { plugin } = await fake();
		await text(plugin, "open", { url: "https://example.com" });
		const error = await run(plugin, "click", { selector: "#missing" }).catch((caught: Error) => caught);
		expect(error).toBeInstanceOf(Error);
		const message = (error as Error).message;
		expect(message).toContain("Timeout 15000ms exceeded");
		expect(message).not.toContain("Call log");
		expect(message.endsWith('Fallback: computer_use with window "Fake Page" (Chrome) — observe it and act by element or pixels.')).toBe(true);
		const stale = (await run(plugin, "click", { ref: "e99" }).catch((caught: Error) => caught)) as Error;
		expect(stale.message).toStartWith("StaleRef: ref e99");
		expect(stale.message).not.toContain("Fallback");
		expect(isFallbackError("element is not visible")).toBe(true);
		expect(isFallbackError("Element is outside of the viewport")).toBe(true);
		expect(isFallbackError("net::ERR_NAME_NOT_RESOLVED")).toBe(false);
	});

	test("a crashed host fails the call and the next call respawns", async () => {
		const { plugin, log } = await fake();
		await text(plugin, "open", { url: "https://example.com" });
		expect(await failure(run(plugin, "eval", { js: "crash" }))).toContain("browser host exited (code 3)");
		expect(await text(plugin, "status")).toContain("not started");
		expect(await text(plugin, "open", { url: "https://example.org" })).toContain("example.org");
		expect(await spawns(log)).toBe(2);
	});

	test("close shuts the host down: dedicated closes the browser", async () => {
		const { plugin, log } = await fake();
		await text(plugin, "open", { url: "https://example.com" });
		await plugin.close?.();
		loaded.splice(loaded.indexOf(plugin), 1);
		expect(await lines(log)).toContain("context.close");
		await expect(run(plugin, "status")).resolves.toContain("not started");
		await expect(run(plugin, "open", { url: "https://example.com" })).rejects.toThrow("browser plugin is closed");
	});

	test("the close action ends the session but keeps the host for later calls", async () => {
		const { plugin, log } = await fake();
		expect(await text(plugin, "close")).toContain("not running");
		await text(plugin, "open", { url: "https://example.com" });
		expect(await text(plugin, "close")).toContain("Closed the dedicated browser");
		await text(plugin, "open", { url: "https://example.org" });
		expect((await lines(log)).filter((line) => line.startsWith("launch "))).toHaveLength(2);
		expect(await spawns(log)).toBe(1);
	});

	test("screenshot returns an image the host turns into model content", async () => {
		const { plugin, log } = await fake();
		await text(plugin, "open", { url: "https://example.com" });
		const value = await run(plugin, "screenshot", { fullPage: true });
		expect(value).toBeInstanceOf(PluginContent);
		const blocks = (value as PluginContent).blocks;
		expect(blocks.map((block) => block.type)).toEqual(["text", "image"]);
		expect((blocks[0] as { text: string }).text).toContain("Screenshot of Fake Page");
		const content = await pluginResultContent(value);
		expect(content[1]).toMatchObject({ type: "image" });
		expect(await lines(log)).toContain("page0: screenshot fullPage=true");
	});

	test("snapshot truncates to maxChars with a note; text, eval, wait, tabs and window report", async () => {
		const { plugin } = await fake();
		await text(plugin, "open", { url: "https://example.com/long" });
		const snapshot = await text(plugin, "snapshot", { maxChars: 100 });
		expect(snapshot).toStartWith("# Fake Page\nURL: https://example.com/long");
		expect(snapshot).toMatch(/\[truncated: \d+ more characters\]/);
		expect(await text(plugin, "text")).toBe("Fake body text");
		expect(await text(plugin, "eval", { js: "1+1" })).toBe('{"evaluated":"1+1"}');
		expect(await text(plugin, "wait", { ms: 120_000 })).toBe("Waited 30000 ms.");
		expect(await text(plugin, "tabs")).toBe('[0] "Fake Page" https://example.com/long (current)');
		const window = JSON.parse(await text(plugin, "window")) as Record<string, unknown>;
		expect(window).toMatchObject({ mode: "dedicated", browser: "Chrome", pageTitle: "Fake Page", expectedWindowTitle: "Fake Page - Google Chrome" });
	});

	test("JS dialogs are reported, answered with dialog, and dismissed when left unanswered", async () => {
		const { plugin } = await fake();
		await text(plugin, "open", { url: "https://example.com" });
		const opened = await text(plugin, "eval", { js: "alert" });
		expect(opened).toContain('Dialog open: alert "hello"');
		expect(await text(plugin, "dialog", { accept: true })).toBe('Accepted the alert dialog "hello".');
		expect(await text(plugin, "dialog", { accept: false })).toBe("No dialog is open.");
		await text(plugin, "eval", { js: "alert" });
		expect(await text(plugin, "snapshot")).toStartWith('Dismissed the unanswered alert dialog "hello".');
	});

	test("attach: RemoteDebuggingOff explains how to turn remote debugging on", async () => {
		const userDataDir = join(await tempDir(), "Empty");
		const { plugin, log } = await fake({ mode: "attach", userDataDir });
		const error = (await run(plugin, "open", { url: "https://example.com" }).catch((caught: Error) => caught)) as Error;
		expect(error.message).toStartWith("RemoteDebuggingOff:");
		expect(error.message).toContain("chrome://inspect/#remote-debugging");
		expect(error.message).toContain('"Allow remote debugging for this browser instance"');
		expect(error.message).toContain(join(userDataDir, "DevToolsActivePort"));
		expect(error.message).toContain("computer_use");
		expect((await lines(log)).some((line) => line.startsWith("connect"))).toBe(false);
	});

	test("attach: PermissionPending while Chrome asks the user; the next call awaits the kept connection", async () => {
		const { plugin, log } = await attach(700);
		const first = await text(plugin, "open", { url: "https://example.com" });
		expect(first).toStartWith("PermissionPending:");
		expect(first).toContain("원격 디버깅을 허용하시겠습니까?");
		expect(first).toContain("Allow remote debugging?");
		expect(await text(plugin, "status")).toContain("waiting for the user to allow remote debugging");
		const second = await text(plugin, "open", { url: "https://example.com" });
		expect(second).toContain("Opened Fake Page");
		const log1 = await lines(log);
		expect(log1.filter((line) => line.startsWith("connect "))).toHaveLength(1);
		expect(log1.find((line) => line.startsWith("connect "))).toContain("ws://127.0.0.1:9222/devtools/browser/abc-123");
		expect(log1.find((line) => line.startsWith("connect "))).toContain('"timeout":60000');
	});

	test("attach: works in its own new tab, never closes the user's tabs, and close only disconnects", async () => {
		const { plugin, log } = await attach();
		expect(await failure(run(plugin, "snapshot"))).toContain("NoPage: attach mode works in its own tab");
		await text(plugin, "open", { url: "https://example.com" });
		expect(await lines(log)).toContain("newPage page2");
		expect(await text(plugin, "tabs")).toContain('[2] "Fake Page" https://example.com (current, opened by agent)');
		await text(plugin, "open", { url: "https://example.org" });
		expect((await lines(log)).filter((line) => line.startsWith("newPage"))).toHaveLength(1);
		expect(await failure(run(plugin, "close_tab", { index: 0 }))).toContain("NotOwnTab");
		expect(await text(plugin, "tab", { index: 0 })).toContain("Switched to tab 0");
		expect(await failure(run(plugin, "close_tab"))).toContain("NotOwnTab");
		expect(await text(plugin, "close_tab", { index: 2 })).toContain("Closed tab");
		await plugin.close?.();
		loaded.splice(loaded.indexOf(plugin), 1);
		const final = await lines(log);
		expect(final).toContain("browser.close");
		expect(final).not.toContain("context.close");
		expect(final.filter((line) => line.endsWith(": close"))).toEqual(["page2: close"]);
	});

	test("attach: popups opened by the agent's tab count as its own", async () => {
		const { plugin } = await attach();
		await text(plugin, "open", { url: "https://example.com" });
		const opened = `${await text(plugin, "eval", { js: "popup" })}\n${await text(plugin, "snapshot")}`;
		expect(opened).toContain("New tab opened by the page: [3]");
		expect(await text(plugin, "tabs")).toContain("[3]");
		expect(await text(plugin, "close_tab", { index: 3 })).toContain("Closed tab");
	});

	test("DevToolsActivePort parsing and default user-data-dirs per OS", () => {
		expect(parseDevToolsActivePort("9222\n/devtools/browser/abc\n")).toEqual({ port: 9222, path: "/devtools/browser/abc" });
		expect(parseDevToolsActivePort("9222\r\n/devtools/browser/abc")).toEqual({ port: 9222, path: "/devtools/browser/abc" });
		expect(parseDevToolsActivePort("")).toBeUndefined();
		expect(parseDevToolsActivePort("abc\n/devtools/browser/x")).toBeUndefined();
		expect(parseDevToolsActivePort("70000\n/devtools/browser/x")).toBeUndefined();
		expect(parseDevToolsActivePort("9222\n/json")).toBeUndefined();
		expect(devToolsEndpoint({ port: 9222, path: "/devtools/browser/abc" })).toBe("ws://127.0.0.1:9222/devtools/browser/abc");
		expect(defaultUserDataDir("chrome", "win32", { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }, "C:\\Users\\a")).toBe(join("C:\\Users\\a\\AppData\\Local", "Google", "Chrome", "User Data"));
		expect(defaultUserDataDir("chrome", "darwin", {}, "/Users/a")).toBe(join("/Users/a", "Library", "Application Support", "Google", "Chrome"));
		expect(defaultUserDataDir("chrome", "linux", {}, "/home/a")).toBe(join("/home/a", ".config", "google-chrome"));
		expect(defaultUserDataDir("msedge", "win32", { LOCALAPPDATA: "L" }, "H")).toBe(join("L", "Microsoft", "Edge", "User Data"));
	});

	test("config defaults: dedicated profile under dataDir, attach user-data-dir per OS", () => {
		const host = { resolveDependency: async () => undefined, dataDir: "/data" };
		expect(resolveHostConfig({}, host, "linux", {}, "/home/a")).toEqual({ mode: "dedicated", browser: "chrome", profile: join("/data", "browser", "profile"), userDataDir: join("/home/a", ".config", "google-chrome"), humanize: true });
		expect(resolveHostConfig({}, { resolveDependency: async () => undefined }, "linux", {}, "/home/a").profile).toBe(join("/home/a", ".local", "share", "dinobot", "browser", "profile"));
		expect(resolveHostConfig({ mode: "attach", userDataDir: "/u", executablePath: "/c", humanize: false }, host, "win32", {}, "H")).toMatchObject({ mode: "attach", userDataDir: "/u", executablePath: "/c", humanize: false });
	});

	test("the host child gets desktop variables and its config but not the parent's secrets", () => {
		const config = resolveHostConfig({}, { resolveDependency: async () => undefined, dataDir: "/d" }, "linux", {}, "/h");
		const env = hostEnvironment({ PATH: "/bin", SystemRoot: "C:\\Windows", LOCALAPPDATA: "L", ANTHROPIC_API_KEY: "secret", GITHUB_TOKEN: "t" }, config);
		expect(env).toEqual({ PATH: "/bin", SystemRoot: "C:\\Windows", LOCALAPPDATA: "L", DINOBOT_BROWSER_CONFIG: JSON.stringify(config) });
	});

	test("humanize paces typing per character and pauses before clicks and fills", async () => {
		const delays: number[] = [];
		const log: string[] = [];
		const session = new Session(
			{ mode: "dedicated", browser: "chrome", profile: "/p", userDataDir: "/u", humanize: true },
			{ chromium: fakeChromium((line) => log.push(line)), sleep: async (ms) => void delays.push(ms), random: () => 1 },
		);
		await session.run("open", { url: "https://example.com" });
		await session.run("type", { text: "abc" });
		expect(delays).toEqual([70, 70, 70]);
		expect(log.filter((line) => line.includes("type "))).toEqual(['page0: type "a"', 'page0: type "b"', 'page0: type "c"']);
		delays.length = 0;
		await session.run("click", { ref: "e1" });
		await session.run("fill", { ref: "e2", text: "x" });
		expect(delays).toEqual([600, 600]);
		const quick = new Session({ mode: "dedicated", browser: "chrome", profile: "/p", userDataDir: "/u", humanize: false }, { chromium: fakeChromium(() => {}), sleep: async (ms) => void delays.push(ms) });
		delays.length = 0;
		await quick.run("open", { url: "https://example.com" });
		await quick.run("type", { text: "abc" });
		await quick.run("click", { ref: "e1" });
		expect(delays).toEqual([]);
		await session.close();
		await quick.close();
	});
});
