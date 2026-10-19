import { expect, spyOn, test } from "bun:test";
import { matchesKey, stripTerminalSequences } from "@earendil-works/pi-tui";
import { MemoryTerminal } from "../../script/bench/tui-render.ts";
import type { Manifest } from "../manifest.ts";
import { ChatApp } from "./app.ts";
import type { ApiClient } from "./client.ts";
import { gateKey } from "./key-gate.ts";
import { toggleView, type ViewState, type ViewToggle } from "./view.ts";

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

/** Kitty CSI-u encoding of Ctrl+<letter> with an explicit event type: 1 press, 2 repeat, 3 release. */
const kitty = (letter: string, event: 1 | 2 | 3): string => `\x1b[${letter.charCodeAt(0)};5${event === 1 ? "" : `:${event}`}u`;
const press = (letter: string) => kitty(letter, 1);
const repeat = (letter: string) => kitty(letter, 2);
const release = (letter: string) => kitty(letter, 3);
const LETTER: Record<ViewToggle, string> = { tools: "o", thinking: "e", shortcuts: "x" };
const KEYS: readonly ViewToggle[] = ["tools", "thinking", "shortcuts"];

function open() {
	const terminal = new InputTerminal(100, 30);
	const chat = new ChatApp(client, manifest, "main", undefined, undefined, 10000, terminal, { preferences: { load: () => ({ toolsExpanded: false }), save() {} } });
	chat.start();
	const send = (data: string) => terminal.onInput?.(data);
	return { chat, screen: chat.screen, send };
}

/** The app's transition on a press: the open cheatsheet owns the keyboard and swallows Ctrl+O/Ctrl+E (see tui-view.test.ts). */
const step = (state: ViewState, key: ViewToggle): ViewState => (key === "shortcuts" || !state.shortcuts ? toggleView(state, key) : state);

test("focused TODO receives End and Home through the real app input path", () => {
	const { chat, screen, send } = open();
	try {
		chat.chat.apply({ type: "tool_execution_update", toolCallId: "todos", toolName: "todo_write", details: {
			todos: Array.from({ length: 14 }, (_, index) => ({
				id: String(index + 1), content: `long item ${index + 1}`,
				status: index === 4 ? "in_progress" : "pending",
			})),
		} });
		send("\x14");
		screen.tui.renderNow();
		send("\x1b[F");
		screen.tui.renderNow();
		expect(screen.todoPane.render(100).map(stripTerminalSequences).join("\n")).toContain("long item 14");
		send("\x1b[H");
		screen.tui.renderNow();
		expect(screen.todoPane.render(100).map(stripTerminalSequences).join("\n")).toContain("long item 1 ");
	} finally {
		screen.stop();
	}
});

test("kitty press then release toggles each view exactly once", () => {
	// The bug's precondition: matchesKey does not distinguish event types, so a release matches the binding.
	for (const letter of ["o", "e", "x", "t"]) expect(matchesKey(release(letter), `ctrl+${letter}` as never)).toBe(true);
	const { screen, send } = open();
	try {
		for (const key of KEYS) {
			screen.setView("shortcuts", false);
			screen.setView(key, false);
			send(press(LETTER[key]));
			expect([key, screen.view[key]]).toEqual([key, true]);
			send(release(LETTER[key]));
			expect([key, screen.view[key]]).toEqual([key, true]);
			send(press(LETTER[key]));
			send(release(LETTER[key]));
			expect([key, screen.view[key]]).toEqual([key, false]);
		}
		expect(screen.todoPane.visible).toBe(false);
		send(press("t"));
		send(release("t"));
		expect(screen.todoPane.visible).toBe(true);
		send(press("t"));
		send(release("t"));
		expect(screen.todoPane.visible).toBe(false);
	} finally {
		screen.stop();
	}
});

test("press, repeats and release toggle each view once", () => {
	const { screen, send } = open();
	try {
		for (const key of KEYS) {
			for (const repeats of [1, 2, 3, 7]) {
				screen.setView("shortcuts", false);
				screen.setView(key, false);
				const before = screen.prompt.getText();
				send(press(LETTER[key]));
				for (let i = 0; i < repeats; i++) send(repeat(LETTER[key]));
				send(release(LETTER[key]));
				expect([key, repeats, screen.view[key]]).toEqual([key, repeats, true]);
				// Swallowed repeats never leak into the prompt as text.
				expect(screen.prompt.getText()).toBe(before);
			}
		}
		// The open cheatsheet owns the keyboard, so close it before exercising Ctrl+T.
		screen.setView("shortcuts", false);
		send(press("t"));
		for (let i = 0; i < 5; i++) send(repeat("t"));
		send(release("t"));
		expect(screen.todoPane.visible).toBe(true);
	} finally {
		screen.stop();
	}
});

test("legacy control bytes still toggle on every press", () => {
	const legacy: Record<ViewToggle, string> = { tools: "\x0f", thinking: "\x05", shortcuts: "\x18" };
	const { screen, send } = open();
	try {
		for (const key of KEYS) {
			screen.setView("shortcuts", false);
			screen.setView(key, false);
			expect(gateKey(legacy[key])).toBe("handle");
			send(legacy[key]);
			expect([key, screen.view[key]]).toEqual([key, true]);
			send(legacy[key]);
			expect([key, screen.view[key]]).toEqual([key, false]);
		}
	} finally {
		screen.stop();
	}
});

test("release events pass through and non-toggle repeats are handled", () => {
	expect(gateKey(release("c"))).toBe("pass");
	expect(gateKey(release("o"))).toBe("pass");
	expect(gateKey(repeat("o"))).toBe("swallow");
	expect(gateKey(press("o"))).toBe("handle");
	const backspaceRepeat = "\x1b[127;1:2u";
	expect(matchesKey(backspaceRepeat, "backspace")).toBe(true);
	expect(gateKey(backspaceRepeat)).toBe("handle");

	const exit = spyOn(process, "exit").mockImplementation((() => undefined) as never);
	const { screen, send } = open();
	try {
		// Ctrl+C clears a non-empty prompt; its release must not count as a second Ctrl+C that quits.
		screen.prompt.setText("abc");
		send(press("c"));
		expect(screen.prompt.getText()).toBe("");
		send(release("c"));
		expect(exit).not.toHaveBeenCalled();
		// Holding Backspace still auto-repeats in the editor.
		screen.prompt.setText("abcd");
		send("\x1b[127u");
		send(backspaceRepeat);
		send(backspaceRepeat);
		send("\x1b[127;1:3u");
		expect(screen.prompt.getText()).toBe("a");
	} finally {
		screen.stop();
		exit.mockRestore();
	}
});

test("toggle parity equals number of presses for random event streams", () => {
	let seed = 0x0c7e1;
	const random = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
	const { screen, send } = open();
	try {
		for (let trial = 0; trial < 60; trial++) {
			for (const key of KEYS) screen.setView(key, false);
			let model: ViewState = screen.view;
			const presses: Record<ViewToggle, number> = { tools: 0, thinking: 0, shortcuts: 0 };
			const held = new Set<ViewToggle>();
			const events = 10 + random(30);
			// Well-formed, possibly overlapping strokes: each key is press · repeat* · release.
			for (let i = 0; i < events || held.size > 0; i++) {
				const key = i < events ? (KEYS[random(KEYS.length)] as ViewToggle) : ([...held][0] as ViewToggle);
				if (!held.has(key)) {
					held.add(key);
					send(press(LETTER[key]));
					presses[key]++;
					model = step(model, key);
				} else if (i < events && random(3) !== 0) {
					send(repeat(LETTER[key]));
				} else {
					held.delete(key);
					send(release(LETTER[key]));
				}
				expect([trial, i, screen.view]).toEqual([trial, i, model]);
			}
			// The cheatsheet is never guarded, so its state is exactly the parity of its strokes.
			expect(screen.view.shortcuts).toBe(presses.shortcuts % 2 === 1);
		}
	} finally {
		screen.stop();
	}
});
