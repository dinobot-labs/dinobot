import { expect, test } from "bun:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ConversationId, EntryId } from "@earendil-works/pi-durable";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { createHarness, type Harness } from "../script/bench/tui-render.ts";
import type { ClientEvent, ClientSnapshotEvent, SubagentProgress, WorkflowStatus } from "../src/core/ui-contract.ts";
import { ChatState } from "../src/tui/state.ts";
import { spacing } from "../src/tui/theme.ts";

const workflow = (status: WorkflowStatus["status"], extra: Partial<WorkflowStatus> = {}): WorkflowStatus => ({
	status, workId: "work-1", sourceIds: ["source-1"], version: 1, methodEpoch: 0, mutationEpoch: 0,
	blockers: [], unmetCheckIds: ["typecheck", "test"], certificate: null, costs: null, methods: {}, evidence: [], limitations: [], ...extra,
});
const snapshot = (current?: WorkflowStatus | null): ClientSnapshotEvent => ({
	type: "snapshot", entries: [], tools: [], compactions: [], inbox: [], agent: {}, usage: { models: {}, tools: {} },
	...(current === undefined ? {} : { workflow: current }),
});
const certified = (): WorkflowStatus => workflow("verified", {
	unmetCheckIds: [],
	certificate: { id: "cert-1", workId: "work-1", sourceIds: ["source-1"], contractHash: "hash", version: 1, methodEpoch: 0, mutationEpoch: 0, fingerprint: "tree", evidenceIds: ["receipt"], at: 1, limitations: [] },
});
function frame(harness: Harness, ...events: ClientEvent[]): string {
	for (const event of events) harness.state.apply(event);
	harness.terminal.buffer = "";
	harness.screen.tui.renderNow(true);
	return stripTerminalSequences(harness.terminal.buffer);
}
/** The workflow row: a state mark in the turn-status mark column, then the lowercase host status. */
/** The mark sits one column inside the page margin. */
const statusInset = " ".repeat(spacing.margin + spacing.status);
const STATE_ROW = new RegExp(`^${statusInset}\\S (planning|implementing|verifying|verified|blocked|cancelled)( |$)`);
const workflowRows = (harness: Harness, width: number): string[] =>
	harness.screen.tui.render(width).map(line => stripTerminalSequences(line).trimEnd()).filter(line => STATE_ROW.test(line));
const host = (current: WorkflowStatus | null): ClientEvent => ({ type: "workflow_status", workflow: current });
const prose = (text: string): ClientEvent => {
	const message: AssistantMessage = {
		role: "assistant", content: [{ type: "text", text }], api: "pi-messages", provider: "faux", model: "faux-1", stopReason: "stop", timestamp: 1,
		usage: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
	return { type: "message_end", entry: { id: 1 as EntryId, conversationId: 1 as ConversationId, kind: "pi.assistant", model: [message] } };
};

test("the screen draws no workflow status row for any host status, snapshot or conversation switch", () => {
	const statuses = ["planning", "implementing", "verifying", "blocked", "cancelled", "informational"] as const;
	const harness = createHarness(new ChatState(), 60, 30);
	try {
		harness.screen.prompt.setText("keep this draft");
		const height = harness.screen.prompt.render(60).length;
		frame(harness, prose("ordinary transcript"));
		harness.screen.focusTranscript();
		for (const current of [null, certified(), ...statuses.map(status => workflow(status, { blockers: ["failure\n".repeat(100)] }))]) {
			const output = frame(harness, { type: "run_start", inputs: [] }, host(current), { type: "run_end", inputs: [] });
			expect(workflowRows(harness, 60)).toEqual([]);
			expect(output).not.toContain("not verified");
			expect(output).not.toContain("failure failure");
			expect(harness.state.data.workflow).toEqual(current);
			expect(harness.screen.mode).toBe("transcript");
			expect(harness.screen.prompt.getText()).toBe("keep this draft");
			expect(harness.screen.prompt.render(60)).toHaveLength(height);
			for (const line of harness.screen.tui.render(60)) expect(visibleWidth(line)).toBeLessThanOrEqual(60);
		}
	} finally { harness.dispose(); }
	const a = new ChatState();
	const b = new ChatState();
	a.apply(snapshot(certified()));
	b.apply(snapshot(workflow("planning", { workId: null })));
	const switched = createHarness(a, 100, 30);
	try {
		expect(workflowRows(switched, 100)).toEqual([]);
		switched.screen.bind(b);
		expect(frame(switched)).not.toContain("not verified");
		expect(workflowRows(switched, 100)).toEqual([]);
		switched.screen.bind(a);
		frame(switched, snapshot());
		expect(a.data.workflow).toBeNull();
		expect(switched.screen.mode).toBe("prompt");
	} finally { switched.dispose(); }
});

test("completed child runner displays blocked workflow separately; read-only children stay ordinary", () => {
	const harness = createHarness(new ChatState(), 140, 40);
	const child: SubagentProgress = { taskId: "child-1", description: "Check implementation", subagentType: "executor", background: true, conversationId: 2, status: "completed", startedAt: 1, endedAt: 2, toolCount: 1, lastText: "done" };
	try {
		const output = frame(harness,
			{ type: "message_end", entry: { id: 1 as EntryId, conversationId: 1 as ConversationId, kind: "pi.user", model: [{ role: "user", content: "Run a check", timestamp: 1 }] } },
			{ type: "tool_execution_start", toolCallId: "task-call", toolName: "task", args: { description: child.description } },
			{ type: "subagent_progress", callId: "task-call", subagents: [{ ...child, workflow: workflow("blocked", { blockers: ["checks missing"] }) }] });
		expect(output).toContain("✓ done · ! blocked  Subagent Check implementation");
		expect(output).toContain("History: 1 done · 1 not verified");
		expect(output.replaceAll("not verified", "")).not.toContain("verified");
		const verified = frame(harness, { type: "subagent_progress", subagents: [{ ...child, workflow: certified() }] });
		expect(verified).toContain("✓ done · ✓ verified  Subagent Check implementation");
		expect(verified).toContain("History: 1 done · 1 verified");
		expect(verified).not.toContain("not verified");
		const stale = frame(harness, { type: "subagent_progress", subagents: [{ ...child, workflow: { ...certified(), status: "blocked", blockers: ["workspace changed"] } }] });
		expect(stale).toContain("✓ done · ! blocked  Subagent Check implementation");
		expect(stale.replaceAll("not verified", "")).not.toContain("verified");
		expect(frame(harness, snapshot(), { type: "subagent_progress", subagents: [child] })).not.toContain("verified");
	} finally { harness.dispose(); }
});
