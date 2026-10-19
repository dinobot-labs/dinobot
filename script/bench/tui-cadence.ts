/** Real pi-tui scheduler under 250 events/s; measures output cadence, not emulator/GPU presentation. */
import type { Usage } from "@earendil-works/pi-ai";
import { createHarness, seedTranscript, summarize } from "./tui-render.ts";
import { ChatState } from "../../src/tui/state.ts";

const state = new ChatState();
seedTranscript(state, 500);
const h = createHarness(state);
const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
state.apply({ type: "run_start", inputs: [] }, Date.now());
state.apply({ type: "message_update", usage, changes: [{ type: "text_start", contentIndex: 0, block: { type: "text", text: "" } }] }, Date.now());
const frames: number[] = [];
let bytes = 0;
const write = h.terminal.write.bind(h.terminal);
h.terminal.write = (data) => {
	// Changed row output, excluding cursor-only writes and lifecycle sequences.
	if (data.includes("\x1b[?2026h") && data.includes("\x1b[2K")) frames.push(performance.now());
	bytes += Buffer.byteLength(data);
	write(data);
	h.terminal.buffer = "";
};
let events = 0;
const timer = setInterval(() => {
	state.apply({ type: "message_update", usage, changes: [{ type: "text_delta", contentIndex: 0, delta: ++events % 20 === 0 ? "\n" : "한글 stream " }] }, Date.now());
}, 4);
try {
	await Bun.sleep(2500);
	clearInterval(timer);
	await Bun.sleep(50);
	const intervals = frames.slice(1).map((at, i) => at - frames[i]!);
	const stats = summarize("scheduled streaming cadence", intervals);
	const fps = 1000 / stats.mean;
	console.log(JSON.stringify({ events, renderedFrames: frames.length, fps, intervals: stats, bytes, note: "Memory terminal; includes actual scheduler and event-loop delay, excludes PTY/emulator/GPU." }, null, 2));
	if (intervals.length < 60 || stats.p95 > 1000 / 30) process.exitCode = 1;
} finally {
	clearInterval(timer);
	h.dispose();
}
