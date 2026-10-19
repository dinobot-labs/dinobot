import { expect, test } from "bun:test";
import { MemoryTerminal } from "../script/bench/tui-render.ts";
import type { SubagentProgress } from "../src/core/ui-contract.ts";
import type { Manifest } from "../src/manifest.ts";
import { ChatApp } from "../src/tui/app.ts";
import type { ApiClient } from "../src/tui/client.ts";
import { Picker } from "../src/tui/picker.ts";
import { Transcript } from "../src/tui/screen.ts";
import { ChatState } from "../src/tui/state.ts";

const progress = (taskId: string): SubagentProgress => ({ taskId, description: `Inspect ${taskId}`, subagentType: "explore", background: true, conversationId: taskId === "a" ? 11 : 12, status: "running", startedAt: 1000, toolCount: 2 });
class InputTerminal extends MemoryTerminal {
	onInput: ((data: string) => void) | undefined;
	override start(onInput: (data: string) => void, onResize: () => void) { this.onInput = onInput; super.start(onInput, onResize); }
}

test("/agents refreshes states, preserves selection, opens the chosen stream, and Esc returns", () => {
	const terminal = new InputTerminal(100, 34);
	const opened: { id: number; signal: AbortSignal }[] = [];
	const client = {
		commands: async () => [], threadModel: async () => ({ model: "fake/fake", thinkingLevel: "off", supportedThinkingLevels: ["off"] }), events: async () => {},
		conversationEvents: async (id: number, _receive: unknown, signal: AbortSignal) => { opened.push({ id, signal }); },
	} as unknown as ApiClient;
	const app = new ChatApp(client, { model: { provider: "fake", modelId: "fake" }, toolMode: "hybrid" } as Manifest, "main", undefined, undefined, 10000, terminal, { preferences: { load: () => ({ toolsExpanded: false }), save() {} } });
	app.start();
	try {
		app.chat.apply({ type: "subagent_progress", subagents: [progress("a"), progress("b")] });
		app.screen.prompt.onSubmit?.("/agents");
		const picker = app.screen.tui.modal?.component as Picker;
		expect(picker).toBeInstanceOf(Picker);
		picker.handleInput("\x1b[B");
		const id = picker.selected!.id;
		app.chat.apply({ type: "subagent_progress", subagents: [{ ...progress(id), status: "failed", endedAt: 3000, error: "fixture failure" }] });
		expect(picker.selected?.id).toBe(id);
		expect(picker.selected?.label).toStartWith("failed ·");
		expect(picker.selected?.description).toContain("fixture failure");
		picker.handleInput("\r");
		expect(app.screen.tui.modal).toBeUndefined();
		expect(app.screen.inTakeover).toBe(true);
		expect(opened[0]?.id).toBe(progress(id).conversationId);
		terminal.onInput?.("\x1b");
		expect(app.screen.inTakeover).toBe(false);
		expect(opened[0]?.signal.aborted).toBe(true);
		app.screen.prompt.onSubmit?.("/agents a");
		expect(opened.at(-1)?.id).toBe(11);
		terminal.onInput?.("\x1b");
		app.screen.prompt.onSubmit?.("/agents");
		(app.screen.tui.modal?.component as Picker).handleInput("\x1b");
		expect(app.screen.tui.modal).toBeUndefined();
	} finally { app.screen.tui.modal?.component.cancel(); app.screen.stop(); }
});

test("an individual subagent expands with Right and Enter opens that task even in compact mode", () => {
	const state = new ChatState();
	state.apply({ type: "tool_execution_start", toolCallId: "call-a", toolName: "task", args: { description: "Inspect a" } });
	state.apply({ type: "subagent_progress", callId: "call-a", subagents: [progress("a")] });
	const transcript = new Transcript(state);
	transcript.setToolsExpanded(false);
	let opened: string | undefined;
	transcript.onOpen = progress => { opened = progress.taskId; };
	transcript.render(80);
	transcript.focus();
	transcript.handleInput("\x1b[C");
	expect(transcript.render(80).join("\n")).toContain("2 tools");
	transcript.handleInput("\r");
	expect(opened).toBe("a");
	transcript.handleInput("\x1b[D");
	expect(transcript.render(80).join("\n")).not.toContain("2 tools");
});

test("live picker retains its filter and chosen identity across reordered updates", () => {
	const picker = new Picker("Tasks", [{ id: "a", label: "running · alpha" }, { id: "b", label: "running · beta" }], { onChoose() {}, onCancel() {} }, () => ({ cols: 80, rows: 30 }));
	picker.handleInput("beta");
	picker.updateOptions([{ id: "b", label: "done · beta" }, { id: "a", label: "running · alpha" }]);
	expect(picker.filter).toBe("beta");
	expect(picker.selected?.id).toBe("b");
	expect(picker.selected?.label).toBe("done · beta");
});
