import { expect, test } from "bun:test";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { MemoryTerminal } from "../script/bench/tui-render.ts";
import type { CommandEvent, CommandInfo } from "../src/commands/types.ts";
import type { Manifest } from "../src/manifest.ts";
import { ChatApp } from "../src/tui/app.ts";
import type { ApiClient } from "../src/tui/client.ts";
import { Picker } from "../src/tui/picker.ts";
import { ChatState } from "../src/tui/state.ts";
import { color, separator } from "../src/tui/theme.ts";

class InputTerminal extends MemoryTerminal {
	onInput: ((data: string) => void) | undefined;
	override start(onInput: (data: string) => void, onResize: () => void): void {
		this.onInput = onInput;
		super.start(onInput, onResize);
	}
}
const levels: readonly ModelThinkingLevel[] = ["off", "low", "high"];
const modelState = (thinkingLevel: ModelThinkingLevel = "low", supportedThinkingLevels = levels) => ({ model: "fake/model", thinkingLevel, supportedThinkingLevels });
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const plain = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, "");
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}
type Run = { thread: string; name: string; args: string; emit: (event: CommandEvent) => void; finish: () => void };
function setup(options: { commands?: Promise<readonly CommandInfo[]>; hydrate?: () => Promise<ReturnType<typeof modelState>> } = {}) {
	const runs: Run[] = [];
	const terminal = new InputTerminal(140, 40);
	const client = {
		commands: () => options.commands ?? Promise.resolve([{ name: "reasoning", description: "Reasoning" }]),
		threadModel: options.hydrate ?? (async () => modelState()),
		events: async () => {},
		commandArguments: async () => [],
		answerPrompt: async () => {},
		runCommand: async (_channel: string, _thread: string, name: string, args: string, _user: string, emit: (event: CommandEvent) => void) => {
			await new Promise<void>((finish) => runs.push({ thread: _thread, name, args, emit, finish }));
		},
	} as unknown as ApiClient;
	const manifest = { model: { provider: "fake", modelId: "model" }, toolMode: "hybrid" } as Manifest;
	const app = new ChatApp(client, manifest, "a", undefined, undefined, 10000, terminal, { preferences: { load: () => ({ toolsExpanded: false }), save: () => {} } });
	app.start();
	const key = (data: string) => terminal.onInput?.(data);
	const submit = (text: string) => { app.screen.prompt.setText(text); key("\r"); };
	const stop = () => { for (const run of runs) { run.emit({ type: "done" }); run.finish(); } app.screen.stop(); };
	return { app, runs, key, submit, stop };
}

test("rapid reasoning cycles serialize without notices or draft loss", async () => {
	const h = setup();
	try {
		await flush();
		h.app.screen.prompt.setText("keep this draft");
		h.key("\x1b[Z"); h.key("\x1b[Z"); h.key("\x1b[Z");
		expect(h.runs).toHaveLength(1);
		for (let index = 0; index < 3; index++) {
			expect(h.runs).toHaveLength(index + 1);
			expect(h.runs[index]?.args).toBe("cycle");
			expect(h.runs[index]?.thread).toBe("a");
			h.runs[index]!.emit({ type: "done" }); h.runs[index]!.finish();
			await flush();
		}
		expect(h.runs).toHaveLength(3);
		expect(h.app.screen.prompt.getText()).toBe("keep this draft");
		expect(h.app.chat.data.blocks.some((block) => block.kind === "notice" && block.text.includes("still running"))).toBe(false);
	} finally { h.stop(); }
});

test("cancel and thread switching discard queued cycles without disturbing a fresh queue", async () => {
	for (const switchThread of [false, true]) {
		const h = setup();
		try {
			await flush();
			h.key("\x1b[Z"); h.key("\x1b[Z"); h.key("\x1b[Z");
			if (switchThread) h.submit("/thread b");
			else h.key("\x1b");
			await flush();
			h.key("\x1b[Z"); h.key("\x1b[Z");
			expect(h.runs).toHaveLength(2);
			h.runs[0]!.emit({ type: "state", ...modelState("off") });
			h.runs[0]!.finish(); await flush();
			expect(h.runs).toHaveLength(2);
			expect(h.app.screen.info.thinkingLevel).toBe("low");
			h.runs[1]!.emit({ type: "done" }); h.runs[1]!.finish(); await flush();
			expect(h.runs).toHaveLength(3);
			expect(h.runs[2]?.thread).toBe(switchThread ? "b" : "a");
			h.runs[2]!.emit({ type: "done" }); h.runs[2]!.finish(); await flush();
			expect(h.runs).toHaveLength(3);
		} finally { h.stop(); }
	}
});

test("cycles are not queued behind unrelated commands or modal interactions", async () => {
	const h = setup();
	try {
		await flush(); h.submit("/model");
		h.key("\x1b[Z"); h.key("\x1b[Z");
		h.runs[0]!.emit({ type: "done" }); h.runs[0]!.finish(); await flush();
		expect(h.runs).toHaveLength(1);
		h.key("\x1b[Z"); h.key("\x1b[Z");
		const picker = new Picker("Modal", [], { onChoose: () => {}, onCancel: () => {} }, () => ({ cols: 100, rows: 30 }));
		h.app.screen.openModal(picker, { anchor: "center", width: 60 });
		h.key("\x1b[Z");
		h.runs[1]!.emit({ type: "done" }); h.runs[1]!.finish(); await flush();
		h.app.screen.closeModal(picker); await flush();
		expect(h.runs).toHaveLength(2);
		expect(h.app.chat.data.blocks.some((block) => block.kind === "notice" && block.text.includes("still running"))).toBe(false);
	} finally { h.stop(); }
});

test("reasoning shortcuts use server commands, preserve drafts, and render authoritative state", async () => {
	const h = setup();
	try {
		expect(h.app.screen.prompt.caption).toContain("reasoning unknown");
		await flush();
		expect(h.app.screen.prompt.caption).toContain("reasoning low");
		expect(h.app.screen.prompt.caption.indexOf("reasoning low")).toBeLessThan(h.app.screen.prompt.caption.indexOf("hybrid"));
		h.app.screen.prompt.setText("unfinished draft");
		h.key("\x1b[Z");
		expect(h.runs[0]?.args).toBe("cycle");
		expect(h.runs[0]?.name).toBe("reasoning");
		expect(h.app.screen.prompt.getText()).toBe("unfinished draft");
		expect(h.app.screen.info.thinkingLevel).toBe("low");
		h.runs[0]!.emit({ type: "state", thinkingLevel: "high", supportedThinkingLevels: levels });
		h.runs[0]!.emit({ type: "output", level: "success", text: "Reasoning high applies to the next model request." });
		h.runs[0]!.emit({ type: "output", level: "info", text: "Server notice retained" });
		h.runs[0]!.emit({ type: "output", level: "error", text: "Server warning retained" });
		h.runs[0]!.emit({ type: "done" }); h.runs[0]!.finish(); await flush();
		expect(h.app.screen.prompt.caption).toContain("reasoning high");
		expect(h.app.screen.prompt.getText()).toBe("unfinished draft");
		expect(h.app.chat.data.blocks.some((block) => block.kind === "notice" && block.text.includes("next model request"))).toBe(false);
		expect(h.app.chat.data.blocks.some((block) => block.kind === "notice" && block.text.includes("Server notice retained"))).toBe(true);
		expect(h.app.chat.data.blocks.some((block) => block.kind === "notice" && block.text.includes("Server warning retained"))).toBe(true);
	} finally { h.stop(); }
});

test("unloaded, disabled, unknown, unsupported and locked reasoning never mutate", async () => {
	const commands = deferred<readonly CommandInfo[]>();
	const hydration = deferred<ReturnType<typeof modelState>>();
	const h = setup({ commands: commands.promise, hydrate: () => hydration.promise });
	try {
		h.key("\x1b[Z");
		hydration.resolve(modelState()); await flush();
		h.key("\x1b[Z");
		commands.resolve([]); await flush();
		h.key("\x1b[Z");
		expect(h.runs).toHaveLength(0);
		h.app.screen.setReasoningEnabled(true);
		h.app.screen.resetReasoning(); h.key("\x1b[Z");
		h.app.screen.setReasoning(modelState("off", ["off"]));
		expect(h.app.screen.prompt.caption).toContain("reasoning unsupported"); h.key("\x1b[Z");
		h.app.screen.setReasoning(modelState("high", ["high"]));
		expect(h.app.screen.prompt.caption).toContain("reasoning high (locked)"); h.key("\x1b[Z");
		h.app.screen.setReasoning(modelState("off", []));
		expect(h.app.screen.prompt.caption).toContain("reasoning unavailable"); h.key("\x1b[Z");
		expect(h.runs).toHaveLength(0);
	} finally { h.stop(); }
});

test("reasoning shortcuts respect modal, answer, dropdown, transcript, todo and takeover focus", async () => {
	const h = setup();
	try {
		await flush();
		const press = () => { h.key("\x1b[Z"); expect(h.runs).toHaveLength(0); };
		const picker = new Picker("Modal", [{ id: "one", label: "One" }], { onChoose: () => {}, onCancel: () => {} }, () => ({ cols: 100, rows: 30 }));
		h.app.screen.openModal(picker, { anchor: "center", width: 60 }); press(); h.app.screen.closeModal(picker);
		h.app.screen.prompt.beginAnswer({ type: "text", message: "Answer" }, { onAnswer: () => {}, onCancel: () => {} });
		press(); h.app.screen.prompt.endAnswer();
		h.app.screen.prompt.setText("/"); await flush(); expect(h.app.screen.prompt.menuOpen).toBe(true); press();
		h.app.screen.prompt.setText("");
		h.app.chat.notice("entry"); h.app.screen.focusTranscript(); press(); h.app.screen.focusPrompt();
		h.app.screen.toggleTodoPane(); press(); h.app.screen.focusPrompt();
		h.app.screen.openTakeover({ state: new ChatState(), progress: () => undefined, header: () => ({ cwd: "/tmp", used: 0, welcome: false }) });
		press(); h.app.screen.closeTakeover();
	} finally { h.stop(); }
});

test("bare reasoning command uses the existing picker", async () => {
	const h = setup();
	try {
		await flush(); h.submit("/reasoning");
		expect(h.runs[0]?.args).toBe("");
		h.runs[0]!.emit({ type: "prompt", id: "level", prompt: { type: "select", message: "Reasoning", options: levels.map((id) => ({ id, label: id })) } });
		expect(h.app.screen.modal).toBeInstanceOf(Picker);
	} finally { h.stop(); }
});

test("Ctrl+T opens todos and Ctrl+E does not change provider reasoning", async () => {
	const h = setup();
	try {
		await flush();
		h.key("\x14");
		expect(h.app.screen.mode).toBe("todo");
		expect(h.runs).toHaveLength(0);
		h.app.screen.focusPrompt();
		h.key("\x05");
		expect(h.runs).toHaveLength(0);
		expect(h.app.screen.info.thinkingLevel).toBe("low");
	} finally { h.stop(); }
});

test("attach generations and command states reject stale hydration and cancelled replies", async () => {
	const hydrations: ReturnType<typeof deferred<ReturnType<typeof modelState>>>[] = [];
	const h = setup({ hydrate: () => { const next = deferred<ReturnType<typeof modelState>>(); hydrations.push(next); return next.promise; } });
	try {
		await flush(); h.submit("/thread b"); h.submit("/thread a");
		hydrations[2]!.resolve(modelState("high")); await flush();
		hydrations[0]!.resolve(modelState("off")); hydrations[1]!.resolve(modelState("low")); await flush();
		expect(h.app.screen.info.thinkingLevel).toBe("high");
		h.key("\x1b[Z"); h.key("\x1b");
		h.runs[0]!.emit({ type: "state", ...modelState("off") });
		expect(h.app.screen.info.thinkingLevel).toBe("high");
		h.submit("/thread c");
		expect(h.app.screen.info.thinkingLevel).toBeUndefined();
		h.submit("/reasoning high"); h.runs[1]!.emit({ type: "state", ...modelState("high") });
		hydrations[3]!.resolve(modelState("low")); await flush();
		expect(h.app.screen.info.thinkingLevel).toBe("high");
		h.submit("/thread d"); h.runs[1]!.emit({ type: "state", ...modelState("off") });
		expect(h.app.screen.info.thinkingLevel).toBeUndefined();
	} finally { h.stop(); }
});

test("fast mode shows after reasoning in the system accent and clears when off, unsupported, or the model or thread changes", async () => {
	const fastOn = { ...modelState(), fast: true, fastSupported: true };
	const h = setup({ hydrate: async () => fastOn });
	try {
		const parts = () => h.app.screen.prompt.caption.split(separator.meta);
		const border = (width: number) => h.app.screen.prompt.render(width).at(-1) ?? "";
		await flush();
		expect(parts()).toEqual(["fake/model", "reasoning low", "fast", "hybrid"]);
		expect(border(140)).toContain(color.accentSystem("fast"));
		expect(plain(border(40))).toContain(" fake/model - reasoning low - fas... ");
		h.submit("/thread b");
		expect(h.app.screen.info.fast).toBeUndefined();
		expect(parts()).toEqual(["fake/model", "reasoning unknown", "hybrid"]);
		await flush();
		expect(parts()).toEqual(["fake/model", "reasoning low", "fast", "hybrid"]);
		h.submit("/fast");
		const emit = h.runs[0]!.emit;
		emit({ type: "state", fast: false, fastSupported: true });
		expect(parts()).toEqual(["fake/model", "reasoning low", "hybrid"]);
		emit({ type: "state", fast: true, fastSupported: false });
		expect(parts()).toEqual(["fake/model", "reasoning low", "hybrid"]);
		emit({ type: "state", ...modelState("high"), fast: true, fastSupported: true });
		expect(parts()).toEqual(["fake/model", "reasoning high", "fast", "hybrid"]);
		emit({ type: "state", model: "other/model" });
		expect(h.app.screen.info.fast).toBeUndefined();
		expect(h.app.screen.info.fastSupported).toBeUndefined();
		expect(parts()).toEqual(["other/model", "reasoning unknown", "hybrid"]);
	} finally { h.stop(); }
});
