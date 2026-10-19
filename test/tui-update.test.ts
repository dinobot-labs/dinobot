import { expect, test } from "bun:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { createHarness, MemoryTerminal } from "../script/bench/tui-render.ts";
import type { Manifest } from "../src/manifest.ts";
import { ChatApp, type ChatAppHooks } from "../src/tui/app.ts";
import type { ApiClient } from "../src/tui/client.ts";
import { renderUpdateNotice } from "../src/tui/chrome.ts";
import { ChatState } from "../src/tui/state.ts";
import { Picker } from "../src/tui/picker.ts";
import { modalOverlayOptions } from "../src/tui/modal.ts";
import { color } from "../src/tui/theme.ts";
import { CURRENT_VERSION, type UpdateInfo } from "../src/update.ts";
import packageJson from "../package.json";

const info: UpdateInfo = { current: "0.1.1", latest: "0.2.0" };
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const plain = (lines: readonly string[]) => lines.map(stripTerminalSequences).join("\n");

test("update notice reuses semantic tokens, wraps within tiny and normal widths, and stays actionable", () => {
	expect(renderUpdateNotice(null, 80)).toEqual([]);
	expect(renderUpdateNotice(info, 0)).toEqual([]);
	for (const width of [1, 6, 20, 40, 80, 120]) {
		const lines = renderUpdateNotice(info, width);
		expect(lines.every(line => visibleWidth(line) <= width)).toBe(true);
		const compact = plain(lines).replace(/\s/g, "");
		expect(compact).toContain("Updateavailable0.1.1->0.2.0");
		expect(compact).toContain("Rundinobotupdateinyourshell");
	}
	const lines = renderUpdateNotice(info, 80);
	expect(lines).toHaveLength(2);
	expect(lines[0]).toContain(color.accentSystem("Update available"));
	expect(lines[1]).toContain(color.command("dinobot update"));
});

test("screen composes the notice without removing welcome, changing focus/draft, or persisting transcript blocks", () => {
	const h = createHarness(new ChatState(), 120, 40);
	try {
		h.screen.prompt.setText("keep my draft");
		h.screen.setUpdateNotice(info);
		for (const [cols, rows] of [[120, 40], [80, 30], [40, 24], [120, 40]] as const) {
			h.terminal.setSize(cols, rows);
			h.screen.tui.renderNow();
			const lines = h.screen.tui.getScreenLines();
			expect(lines).toHaveLength(rows);
			expect(lines.every(line => visibleWidth(line) <= cols)).toBe(true);
			expect(plain(lines)).toContain("Update available");
			expect(plain(lines)).toContain("dinobot update");
			expect(plain(lines)).toContain("keep my draft");
			expect(h.screen.welcome).toBe(true);
			expect(h.screen.mode).toBe("prompt");
		}
		expect(h.state.data.blocks).toHaveLength(0);
		const picker = new Picker("Sign in", [{ id: "a", label: "Anthropic" }], { onChoose() {}, onCancel: () => h.screen.closeModal(picker) }, () => h.screen.size());
		h.screen.openModal(picker, modalOverlayOptions(h.screen.size()));
		picker.handleInput("Anth");
		const focus = h.screen.tui.getFocusedComponent();
		h.screen.setUpdateNotice(info);
		h.screen.tui.renderNow();
		expect(h.screen.modal).toBe(picker);
		expect(h.screen.tui.getFocusedComponent()).toBe(focus);
		expect(picker.filter).toBe("Anth");
		h.screen.closeModal(picker);
		expect(h.screen.prompt.getText()).toBe("keep my draft");
		const state = new ChatState();
		state.notice("Existing conversation");
		h.screen.bind(state);
		h.screen.tui.renderNow();
		expect(plain(h.screen.tui.getScreenLines())).toContain("dinobot update");
		expect(state.data.blocks).toHaveLength(1);
		h.screen.setUpdateNotice(null);
		h.screen.tui.renderNow();
		expect(plain(h.screen.tui.getScreenLines())).not.toContain("Update available");
	} finally { h.dispose(); }
});

function app(checkUpdate?: ChatAppHooks["checkUpdate"]) {
	const terminal = new MemoryTerminal(100, 35);
	const streams: AbortSignal[] = [];
	const client = {
		commands: async () => [],
		threadModel: async () => ({ model: "fake/model", thinkingLevel: "off", supportedThinkingLevels: ["off"], fast: false, fastSupported: false }),
		events: (_channel: string, _thread: string, _onEvent: unknown, signal: AbortSignal) => {
			streams.push(signal);
			return new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
		},
	};
	const manifest = { model: { provider: "fake", modelId: "model" }, toolMode: "codemode" } as unknown as Manifest;
	const chat = new ChatApp(client as unknown as ApiClient, manifest, "main", undefined, undefined, 200_000, terminal, {
		...(checkUpdate ? { checkUpdate } : {}),
		preferences: { load: () => ({ toolsExpanded: false, icons: "unicode" }), save() {} },
	});
	const rendered = () => { chat.screen.tui.renderNow(); return plain(chat.screen.tui.getScreenLines()); };
	return { chat, terminal, streams, rendered };
}

test("app checks once without blocking input, survives session changes and snapshot replay, and uses package version", async () => {
	let resolve!: (info: UpdateInfo) => void;
	let calls = 0;
	const a = app(() => { calls++; return new Promise(done => { resolve = done; }); });
	try {
		a.chat.start();
		a.chat.start();
		expect(calls).toBe(1);
		expect(a.streams).toHaveLength(1);
		expect(a.chat.screen.info.version).toBe(packageJson.version);
		expect(CURRENT_VERSION).toBe(packageJson.version);
		a.chat.screen.prompt.setText("typing while registry is slow");
		expect(a.rendered()).toContain("typing while registry is slow");
		expect(a.rendered()).not.toContain("Update available");
		a.chat.screen.prompt.setText("");
		a.chat.screen.prompt.onSubmit?.("/new");
		await flush();
		expect(a.streams).toHaveLength(2);
		resolve(info);
		await flush();
		expect(a.rendered()).toContain("dinobot update");
		a.chat.chat.apply({ type: "snapshot", entries: [], tools: [], compactions: [], inbox: [], agent: {}, usage: { models: {}, tools: {} } });
		expect(a.rendered()).toContain("Update available");
		expect(a.chat.chat.data.blocks).toHaveLength(0);
		expect(calls).toBe(1);
	} finally { a.chat.stop(); }
	expect(a.streams.every(signal => signal.aborted)).toBe(true);
});

test("current, failed, and absent checkers do not raise error notices or hide welcome", async () => {
	for (const check of [undefined, async () => null, async () => { throw new Error("offline"); }]) {
		const a = app(check);
		try {
			a.chat.start();
			await flush();
			expect(a.chat.screen.welcome).toBe(true);
			expect(a.chat.chat.data.blocks).toHaveLength(0);
			expect(a.rendered()).not.toContain("Update available");
		} finally { a.chat.stop(); }
	}
});

test("stopping cancels update I/O and ignores a late completion without repainting the restored shell", async () => {
	let resolve!: (info: UpdateInfo) => void;
	let signal!: AbortSignal;
	const a = app(s => { signal = s; return new Promise(done => { resolve = done; }); });
	a.chat.start();
	await flush();
	a.chat.stop();
	expect(signal.aborted).toBe(true);
	a.terminal.buffer = "";
	a.chat.stop(); // quit followed by the CLI exit hook is also harmless.
	resolve(info);
	await flush();
	a.chat.screen.setUpdateNotice(info);
	expect(a.terminal.buffer).toBe("");
});
