import { expect, test } from "bun:test";
import type { AssistantMessage, Usage, UserMessage } from "@earendil-works/pi-ai";
import type { ConversationId, EntryId, EntryRecord } from "@earendil-works/pi-durable";
import { createHarness } from "../script/bench/tui-render.ts";
import type { Screen } from "../src/tui/screen.ts";
import { ChatState } from "../src/tui/state.ts";

const usage: Usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
let ids = 0;
const entry = (kind: string, message: UserMessage | AssistantMessage): EntryRecord => ({ id: ++ids as EntryId, conversationId: 1 as ConversationId, kind, model: [message] });
const user = (text: string) => ({ type: "message_end" as const, entry: entry("pi.user", { role: "user", content: text, timestamp: 1_700_000_000_000 }) });
const reply = (lines: number) => ({
	type: "message_end" as const,
	entry: entry("pi.assistant", { role: "assistant", content: [{ type: "text", text: Array.from({ length: lines }, (_, k) => `answer line ${k}`).join("\n\n") }], api: "pi-messages", provider: "faux", model: "faux-1", usage, stopReason: "stop", timestamp: 1_700_000_000_000 }),
});

const LONG = Array.from({ length: 6 }, (_, k) => `long prompt paragraph ${k} that wraps and folds`).join("\n");
const pinnedId = (screen: Screen): string | undefined => screen["pinnedId"]();

/** Renders until two consecutive frames agree, returning how many frames that took (or Infinity). */
function settle(screen: Screen, limit = 8): number {
	let previous = pinnedId(screen);
	for (let frame = 1; frame <= limit; frame++) {
		screen.tui.renderNow();
		const next = pinnedId(screen);
		if (next === previous) return frame;
		previous = next;
	}
	return Number.POSITIVE_INFINITY;
}

test("the pinned prompt settles when a short prompt reaches a taller pinned one while following the end", () => {
	const harness = createHarness(new ChatState(), 100, 30);
	try {
		for (const event of [user(LONG), reply(30), user("short"), reply(12)]) harness.state.apply(event, harness.now());
		harness.screen.tui.renderNow();
		const unsettled: number[] = [];
		const pins = new Set<string | undefined>();
		// Sweep the terminal height so the short prompt crosses the transcript top one row at a time.
		for (let rows = 16; rows <= 60; rows++) {
			harness.terminal.setSize(100, rows);
			if (settle(harness.screen) === Number.POSITIVE_INFINITY) unsettled.push(rows);
			pins.add(pinnedId(harness.screen)?.split(":")[0]);
			expect(harness.screen.scroll.isFollowingEnd).toBe(true);
		}
		expect(unsettled).toEqual([]);
		// The sweep really crossed the boundary: both prompts (and no pin) were shown at some height.
		expect(pins.size).toBeGreaterThanOrEqual(2);
	} finally {
		harness.dispose();
	}
});

test("the pinned header keeps one height for every prompt so swapping pins never resizes the transcript", () => {
	const harness = createHarness(new ChatState(), 100, 30);
	try {
		for (const event of [user(LONG), reply(30), user("short"), reply(40)]) harness.state.apply(event, harness.now());
		const transcript = harness.screen.transcript;
		harness.screen.tui.renderNow();
		const heights = new Set<number>();
		for (let top = 1; top < transcript.lineCount; top++) {
			const pinned = transcript.pinnedHeader(top);
			if (pinned !== undefined) heights.add(pinned.lines.length);
		}
		expect(heights.size).toBe(1);
	} finally {
		harness.dispose();
	}
});
