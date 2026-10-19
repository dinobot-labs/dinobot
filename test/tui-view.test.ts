import { expect, test } from "bun:test";
import { MemoryTerminal } from "../script/bench/tui-render.ts";
import type { Manifest } from "../src/manifest.ts";
import { ChatApp } from "../src/tui/app.ts";
import type { ApiClient } from "../src/tui/client.ts";
import { defaultRenderers, Transcript } from "../src/tui/screen.ts";
import { type Block, ChatState } from "../src/tui/state.ts";
import { entryOpen, initialView, setView, toggleView, type ViewState, type ViewToggle } from "../src/tui/view.ts";

const KEYS: readonly ViewToggle[] = ["tools", "thinking", "shortcuts"];
const STATES: ViewState[] = [false, true].flatMap((tools) => [false, true].flatMap((thinking) => [false, true].map((shortcuts) => ({ tools, thinking, shortcuts }))));

test("each key is an involution that flips exactly its own coordinate, and keys commute", () => {
	expect(STATES).toHaveLength(8);
	for (const state of STATES) {
		for (const key of KEYS) {
			const next = toggleView(state, key);
			for (const other of KEYS) expect(next[other]).toBe(other === key ? !state[other] : state[other]);
			expect(toggleView(next, key)).toEqual(state);
			expect(setView(state, key, state[key])).toBe(state);
			for (const other of KEYS) expect(toggleView(toggleView(state, key), other)).toEqual(toggleView(toggleView(state, other), key));
		}
	}
	// The toggles generate Z₂³: every state is reachable from the initial view by pressing each key at most once.
	const reached = new Set(STATES.map((goal) => JSON.stringify(KEYS.reduce((state, key) => (goal[key] ? toggleView(state, key) : state), initialView))));
	expect(reached.size).toBe(8);
});

test("an entry is open exactly when its class mode and its override disagree", () => {
	expect([entryOpen(false, false), entryOpen(false, true), entryOpen(true, false), entryOpen(true, true)]).toEqual([false, true, true, false]);
});

let ids = 0;
const user = (): Block => ({ kind: "user", id: `u${++ids}`, version: 1, text: "next", at: 0 });
const thought = (): Block => ({ kind: "thinking", id: `t${++ids}`, version: 1, text: "plan", startedAt: 0, endedAt: 1, streaming: false });
const tool = (): Block => ({ kind: "tool", id: `c${++ids}`, version: 1, callId: `c${ids}`, name: "bash", args: {}, status: "done", output: "" });
const probe = (state: ChatState) =>
	new Transcript(state, {
		...defaultRenderers,
		tool: (block, _width, ctx) => [`@${block.id}=${ctx.expanded ? 1 : 0}`],
		thinking: (block, _width, ctx) => [`@${block.id}=${ctx.expanded ? 1 : 0}`],
	});
/** Each probed entry's rendered fold, read back from the transcript. */
function observed(transcript: Transcript): Map<string, boolean> {
	const seen = new Map<string, boolean>();
	for (const line of transcript.render(80)) for (const match of line.matchAll(/@(\w+)=([01])/g)) seen.set(match[1] as string, match[2] === "1");
	return seen;
}

test("transcript folds equal mode ⊕ override under random key sequences, against a reference model", () => {
	let seed = 0x5eed;
	const random = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
	for (let trial = 0; trial < 40; trial++) {
		const state = new ChatState();
		const transcript = probe(state);
		const modes = { tools: false, thinking: false };
		const flipped = new Set<string>();
		const classOf = (block: Block) => (block.kind === "thinking" ? "thinking" : "tools");
		const expected = (block: Block) => entryOpen(modes[classOf(block)], flipped.has(block.id));
		const arrive = () => {
			// A user prompt between entries keeps each tool or thought on its own row, so none is hidden in a folded run.
			state.data.blocks.push(user(), random(2) === 0 ? thought() : tool());
		};
		for (let i = 0; i < 4; i++) arrive();
		for (let step = 0; step < 60; step++) {
			const op = random(7);
			if (op === 0 || op === 1) {
				const key = op === 0 ? "tools" : "thinking";
				modes[key] = !modes[key];
				for (const block of state.data.blocks) if (block.kind !== "user" && classOf(block) === key) flipped.delete(block.id);
				if (key === "tools") transcript.setToolsExpanded(modes.tools);
				else transcript.setThinkingExpanded(modes.thinking);
			} else if (op === 2) arrive();
			else if (op === 3) transcript.focus();
			else if (op === 4) transcript.move(random(2) === 0 ? 1 : -1);
			else {
				const block = transcript.selectedBlock();
				const expand = op === 5;
				transcript.setExpanded(expand);
				if (block !== undefined && block.kind !== "user") {
					if (expand === modes[classOf(block)]) flipped.delete(block.id);
					else flipped.add(block.id);
				}
			}
			const seen = observed(transcript);
			for (const block of state.data.blocks) if (block.kind !== "user") expect([block.id, seen.get(block.id)]).toEqual([block.id, expected(block)]);
			if (op === 0 || op === 1) {
				const key = op === 0 ? "tools" : "thinking";
				for (const block of state.data.blocks) if (block.kind !== "user" && classOf(block) === key) expect(seen.get(block.id)).toBe(modes[key]);
			}
		}
	}
});

test("Ctrl+E is a mode: it expands all even after one thought was opened, keeps tool folds, and covers later thoughts", () => {
	const state = new ChatState();
	const first = thought();
	const call = tool();
	state.data.blocks.push(first, user(), call);
	const transcript = probe(state);
	transcript.render(80);
	transcript.focus();
	transcript.setExpanded(true);
	expect(transcript.selectedBlock()?.id).toBe(call.id);
	transcript.move(-1);
	transcript.move(-1);
	expect(transcript.selectedBlock()?.id).toBe(first.id);
	transcript.setExpanded(true);
	expect(observed(transcript).get(first.id)).toBe(true);
	transcript.setThinkingExpanded(true);
	expect(transcript.thinkingExpanded()).toBe(true);
	const later = thought();
	state.data.blocks.push(user(), later);
	expect(Object.fromEntries(observed(transcript))).toEqual({ [first.id]: true, [call.id]: true, [later.id]: true });
	transcript.setThinkingExpanded(false);
	expect(Object.fromEntries(observed(transcript))).toEqual({ [first.id]: false, [call.id]: true, [later.id]: false });
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

/** The app's transition: the pure toggle, except that the open cheatsheet owns the keyboard and swallows Ctrl+O/Ctrl+E. */
const step = (state: ViewState, key: ViewToggle): ViewState => (key === "shortcuts" || !state.shortcuts ? toggleView(state, key) : state);

test("every 4-key sequence of Ctrl+O, Ctrl+E and Ctrl+X matches the guarded model, and the cheatsheet's own close syncs it", () => {
	const terminal = new InputTerminal(100, 30);
	const chat = new ChatApp(client, manifest, "main", undefined, undefined, 10000, terminal, { preferences: { load: () => ({ toolsExpanded: false }), save() {} } });
	chat.start();
	const { screen } = chat;
	const press = (key: string) => terminal.onInput?.(key);
	const keyOf: Record<ViewToggle, string> = { tools: "\x0f", thinking: "\x05", shortcuts: "\x18" };
	try {
		expect(screen.view).toEqual(initialView);
		const sequences = [0, 1, 2, 3].reduce<ViewToggle[][]>((all) => all.flatMap((sequence) => KEYS.map((key) => [...sequence, key])), [[]]);
		expect(sequences).toHaveLength(81);
		for (const sequence of sequences) {
			for (const key of KEYS) screen.setView(key, false);
			let model = initialView;
			for (const key of sequence) {
				press(keyOf[key]);
				model = step(model, key);
				expect([sequence, screen.view]).toEqual([sequence, model]);
				expect(screen.tui.hasOverlay()).toBe(model.shortcuts);
			}
		}
		for (const key of KEYS) screen.setView(key, false);
		press("\x0f");
		press("\x05");
		press("\x18");
		// The cheatsheet owns Esc; its close goes back through the view state instead of only hiding the overlay.
		press("\x1b");
		expect(screen.view).toEqual({ tools: true, thinking: true, shortcuts: false });
		expect(screen.tui.hasOverlay()).toBe(false);
	} finally { screen.stop(); }
});
