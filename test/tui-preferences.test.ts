import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryTerminal } from "../script/bench/tui-render.ts";
import type { Manifest } from "../src/manifest.ts";
import { ChatApp } from "../src/tui/app.ts";
import type { ApiClient } from "../src/tui/client.ts";
import { FileTuiPreferences, tuiPreferencesPath, type TuiPreferencesStore } from "../src/tui/preferences.ts";
import { defaultRenderers, Transcript } from "../src/tui/screen.ts";
import { ChatState } from "../src/tui/state.ts";

test("preferences default to compact, survive a fresh store, and recover from invalid data", () => {
	const dir = mkdtempSync(join(tmpdir(), "dinobot-preferences-"));
	try {
		const path = join(dir, "tui.json");
		const store = new FileTuiPreferences(path);
		expect(store.load()).toEqual({ toolsExpanded: false });
		store.save({ toolsExpanded: false });
		expect(new FileTuiPreferences(path).load()).toEqual({ toolsExpanded: false });
		store.save({ toolsExpanded: true });
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 1, toolsExpanded: true });
		expect(readdirSync(dir)).toEqual(["tui.json"]);
		for (const bad of ["{", "null", "[]", '{"toolsExpanded":"false"}']) {
			writeFileSync(path, bad);
			expect(store.load()).toEqual({ toolsExpanded: false });
		}
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("preferences use absolute XDG config paths and safely ignore relative paths", () => {
	expect(tuiPreferencesPath({ XDG_CONFIG_HOME: "/custom" }, "/users/me")).toBe("/custom/dinobot/tui.json");
	expect(tuiPreferencesPath({ XDG_CONFIG_HOME: "relative" }, "/users/me")).toBe("/users/me/.config/dinobot/tui.json");
});

const addTool = (state: ChatState, id: string) => state.apply({ type: "tool_execution_start", toolCallId: id, toolName: "bash", args: { command: "pwd" } });

test("tool detail mode includes future events, preserves thinking, and survives conversation binding", () => {
	const state = new ChatState();
	const transcript = new Transcript(state, { ...defaultRenderers, tool: (block, _width, ctx) => [`${block.callId}:${ctx.expanded ? "expanded" : "compact"}`] });
	transcript.setToolsExpanded(true);
	addTool(state, "first");
	expect(transcript.render(100).join("\n")).toContain("first:expanded");
	transcript.setToolsExpanded(false);
	addTool(state, "second");
	expect(transcript.render(100).join("\n")).toContain("second:compact");
	transcript.setToolsExpanded(true);
	expect(transcript.render(100).join("\n")).toContain("second:expanded");
	transcript.focus();
	transcript.setExpanded(false);
	expect(transcript.selectionInfo()?.expanded).toBe(false);
	transcript.setExpanded(true);
	expect(transcript.selectionInfo()?.expanded).toBe(true);
	const next = new ChatState();
	addTool(next, "new-session");
	transcript.bind(next);
	expect(transcript.render(100).join("\n")).toContain("new-session:expanded");
	expect(transcript.thinkingExpanded()).toBe(false);
});

class InputTerminal extends MemoryTerminal {
	onInput: ((data: string) => void) | undefined;
	override start(onInput: (data: string) => void, onResize: () => void): void {
		this.onInput = onInput;
		super.start(onInput, onResize);
	}
}
const manifest = { model: { provider: "fake", modelId: "fake" }, toolMode: "hybrid" } as Manifest;
const client = {
	commands: async () => [],
	threadModel: async () => ({ model: "fake/fake", thinkingLevel: "off", supportedThinkingLevels: ["off"] }),
	events: async () => {},
} as unknown as ApiClient;
function app(preferences: TuiPreferencesStore) {
	const terminal = new InputTerminal(100, 30);
	const chat = new ChatApp(client, manifest, "main", undefined, undefined, 10000, terminal, { preferences });
	chat.start();
	return { chat, terminal };
}

test("Ctrl+O saves immediately, /new retains mode, and a fresh app restores it", () => {
	const dir = mkdtempSync(join(tmpdir(), "dinobot-app-preferences-"));
	const path = join(dir, "tui.json");
	const first = app(new FileTuiPreferences(path));
	try {
		expect(first.chat.screen.toolsExpanded).toBe(false);
		first.terminal.onInput?.("\x0f");
		expect(first.chat.screen.toolsExpanded).toBe(true);
		expect(new FileTuiPreferences(path).load().toolsExpanded).toBe(true);
		first.chat.screen.prompt.setText("/new next");
		first.terminal.onInput?.("\r");
		expect(first.chat.screen.info.thread).toBe("tui:next");
		expect(first.chat.screen.toolsExpanded).toBe(true);
		const restarted = app(new FileTuiPreferences(path));
		try {
			expect(restarted.chat.screen.toolsExpanded).toBe(true);
			restarted.terminal.onInput?.("\x0f");
			expect(new FileTuiPreferences(path).load().toolsExpanded).toBe(false);
		} finally { restarted.chat.screen.stop(); }
	} finally {
		first.chat.screen.stop();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("failed preference writes retain the chosen mode and show an actionable notice", () => {
	const { chat, terminal } = app({ load: () => ({ toolsExpanded: true }), save: () => { throw new Error("read-only filesystem"); } });
	try {
		terminal.onInput?.("\x0f");
		expect(chat.screen.toolsExpanded).toBe(false);
		expect(chat.chat.data.blocks.some((block) => block.kind === "notice" && block.text.includes("could not save preferences: read-only filesystem"))).toBe(true);
	} finally { chat.screen.stop(); }
});

test("expanded transcript reflow restores identical rows and never reuses stale tool output", () => {
	const state = new ChatState();
	addTool(state, "reflow");
	const block = state.data.blocks[0];
	if (block?.kind !== "tool") throw new Error("expected tool");
	block.status = "done";
	block.output = "original output";
	block.version++;
	const transcript = new Transcript(state);
	transcript.setToolsExpanded(true);
	const wide = [...transcript.render(120)];
	transcript.render(60);
	expect(transcript.render(120)).toEqual(wide);
	transcript.focus();
	const selected = [...transcript.render(120)];
	expect(selected).not.toEqual(wide);
	transcript.render(60);
	expect(transcript.render(120)).toEqual(selected);
	transcript.blur();
	expect(transcript.render(120)).toEqual(wide);
	block.output = "updated output";
	block.version++;
	state.data.dirty.add(block.id);
	const updated = transcript.render(120).join("\n");
	expect(updated).toContain("updated output");
	expect(updated).not.toContain("original output");
	transcript.render(60);
	expect(transcript.render(120).join("\n")).toBe(updated);
});

test("the icon set is saved with the view choice and the environment overrides it for one run", async () => {
	const { resolveIconSet } = await import("../src/tui/preferences.ts");
	const dir = mkdtempSync(join(tmpdir(), "dinobot-preferences-"));
	try {
		const path = join(dir, "tui.json");
		const store = new FileTuiPreferences(path);
		store.save({ toolsExpanded: true, icons: "nerd" });
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 1, toolsExpanded: true, icons: "nerd" });
		expect(store.load()).toEqual({ toolsExpanded: true, icons: "nerd" });
		writeFileSync(path, '{"toolsExpanded":true,"icons":"emoji"}');
		expect(store.load()).toEqual({ toolsExpanded: true });
	} finally { rmSync(dir, { recursive: true, force: true }); }
	const none = { toolsExpanded: false } as const;
	expect(resolveIconSet(none, {})).toBe("nerd");
	expect(resolveIconSet(none, { TERM_PROGRAM: "ghostty" })).toBe("nerd");
	expect(resolveIconSet(none, { TERM: "linux" })).toBe("unicode");
	expect(resolveIconSet(none, { TERM: "dumb" })).toBe("unicode");
	expect(resolveIconSet(none, { TERM_PROGRAM: "Apple_Terminal" })).toBe("unicode");
	expect(resolveIconSet({ toolsExpanded: false, icons: "nerd" }, { TERM_PROGRAM: "Apple_Terminal" })).toBe("nerd");
	expect(resolveIconSet({ toolsExpanded: false, icons: "unicode" }, {})).toBe("unicode");
	expect(resolveIconSet({ toolsExpanded: false, icons: "nerd" }, { DINOBOT_ICONS: "Unicode" })).toBe("unicode");
	expect(resolveIconSet(none, { TERM: "linux", DINOBOT_ICONS: "nerd" })).toBe("nerd");
	expect(resolveIconSet(none, { DINOBOT_ICONS: "sparkles", TERM: "dumb" })).toBe("unicode");
});
