import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createHarness, seedTranscript } from "../script/bench/tui-render.ts";
import { ChatState } from "../src/tui/state.ts";

test("fullscreen fills the viewport, resizes, and restores the shell without replaying UI", () => {
	const h = createHarness();
	try {
		expect(h.terminal.buffer).toContain("\x1b[?1049h");
		// Painting cells must not mutate the user's terminal-wide background/cursor colors.
		expect(h.terminal.buffer).not.toContain("\x1b]11;");
		expect(h.terminal.buffer).not.toContain("\x1b]12;");
		for (const [cols, rows] of [[140, 45], [60, 24], [80, 30], [140, 45]]) {
			h.terminal.setSize(cols!, rows!);
			h.screen.tui.renderNow();
			const lines = h.screen.tui.getScreenLines();
			expect(lines).toHaveLength(rows!);
			expect(lines.every((line) => visibleWidth(line) <= cols!)).toBe(true);
		}
	} finally {
		h.terminal.buffer = "";
		h.dispose();
	}
	const output = h.terminal.buffer;
	expect(output).toContain("\x1b[?1049l");
	expect(output).toContain("\x1b[?1006l");
	expect(output).toContain("\x1b[?7h");
	expect(output).not.toContain("dinobot");
	expect(output).not.toContain("\x1b[2K");
});

test("unchanged fullscreen frames only update the cursor, without repainting history", () => {
	const state = new ChatState();
	seedTranscript(state);
	const h = createHarness(state);
	try {
		h.frame([]); // settle viewport layout
		for (let i = 0; i < 20; i++) {
			h.frame([]);
			expect(h.terminal.buffer.length).toBeLessThan(64);
			expect(h.terminal.buffer).not.toContain("\x1b[2K");
		}
	} finally {
		h.dispose();
	}
});

test("stopping twice cannot overwrite the restored shell", () => {
	const h = createHarness();
	h.dispose();
	h.terminal.buffer = "";
	h.dispose();
	expect(h.terminal.buffer).toBe("");
});
