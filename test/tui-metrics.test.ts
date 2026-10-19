import { expect, test } from "bun:test";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { ConversationId, EntryId, EntryRecord } from "@earendil-works/pi-durable";
import { callMetrics, createChatData, formatCacheRatio, formatTps, reduceEvent, type ChatData } from "../src/tui/state.ts";

let entryIds = 0;

function usage(input: number, output: number, cacheRead: number, cacheWrite = 0): Usage {
	return { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function assistantEntry(text: string, callUsage: Usage): EntryRecord {
	const message: AssistantMessage = { role: "assistant", content: [{ type: "text", text }], api: "pi-messages", provider: "faux", model: "faux-1", usage: callUsage, stopReason: "stop", timestamp: 1 };
	return { id: ++entryIds as EntryId, conversationId: 1 as ConversationId, kind: "pi.assistant", model: [message] };
}

/** One streamed model call: message_start, first content update at `firstAt`, final message at `endAt`. */
function call(data: ChatData, callUsage: Usage, firstAt: number, endAt: number): void {
	const partial: AssistantMessage = { role: "assistant", content: [], api: "pi-messages", provider: "faux", model: "faux-1", usage: callUsage, stopReason: "stop", timestamp: 1 };
	reduceEvent(data, { type: "message_start", message: partial }, firstAt - 50);
	reduceEvent(data, { type: "message_update", usage: callUsage, changes: [{ type: "text_start", contentIndex: 0, block: { type: "text", text: "" } }] }, firstAt);
	reduceEvent(data, { type: "message_update", usage: callUsage, changes: [{ type: "text_delta", contentIndex: 0, delta: "answer" }] }, (firstAt + endAt) / 2);
	reduceEvent(data, { type: "message_end", entry: assistantEntry("answer", callUsage) }, endAt);
}

const turnNotice = (data: ChatData) => data.blocks.findLast((block) => block.kind === "notice" && block.level === "turn");

test("a live call measures tok/s from its first content update and cache ratio from its usage; the turn notice carries the aggregates", () => {
	const data = createChatData();
	reduceEvent(data, { type: "run_start", inputs: [] }, 1_000);
	call(data, usage(1_000, 100, 8_000, 1_000), 2_000, 4_000);
	expect(data.metrics.call).toEqual({ tps: 50, cacheRatio: 0.8 });

	call(data, usage(1_000, 300, 9_000), 5_000, 7_000);
	expect(data.metrics.call).toEqual({ tps: 150, cacheRatio: 0.9 });
	expect(data.metrics.turn).toEqual({ outputTokens: 400, generationMs: 4_000, cacheRead: 17_000, promptTokens: 20_000 });

	reduceEvent(data, { type: "run_end", inputs: [] }, 13_000);
	expect(turnNotice(data)).toMatchObject({ text: "Worked for", elapsedMs: 12_000, metrics: { tps: 100, cacheRatio: 0.85 } });
	expect(formatTps(100)).toBe("100 tok/s");
	expect(formatTps(7.46)).toBe("7.5 tok/s");
	expect(formatCacheRatio(0.85)).toBe("cache 85%");
});

test("zero output or a generation window under 250ms yields no tok/s", () => {
	const data = createChatData();
	reduceEvent(data, { type: "run_start", inputs: [] }, 1_000);
	call(data, usage(1_000, 0, 1_000), 2_000, 4_000);
	expect(data.metrics.call).toEqual({ cacheRatio: 0.5 });
	call(data, usage(1_000, 100, 1_000), 5_000, 5_249);
	expect(data.metrics.call).toEqual({ cacheRatio: 0.5 });
	expect(data.metrics.turn).toMatchObject({ outputTokens: 0, generationMs: 0 });
	expect(callMetrics(usage(1_000, 100, 1_000), 250).tps).toBe(400);
	reduceEvent(data, { type: "run_end", inputs: [] }, 6_000);
	const notice = turnNotice(data);
	expect(notice?.kind === "notice" ? notice.metrics : undefined).toEqual({ cacheRatio: 0.5 });
});

test("a call with no prompt tokens yields no cache ratio", () => {
	const data = createChatData();
	reduceEvent(data, { type: "run_start", inputs: [] }, 1_000);
	call(data, usage(0, 100, 0, 0), 2_000, 3_000);
	expect(data.metrics.call).toEqual({ tps: 100 });
	expect(callMetrics(usage(0, 100, 0, 0))).toEqual({});
});

test("snapshot hydrate never produces tok/s, even for a generation that finishes after attaching", () => {
	const data = createChatData();
	const history = assistantEntry("old answer", usage(1_000, 500, 9_000));
	const streaming: AssistantMessage = { role: "assistant", content: [{ type: "text", text: "partial" }], api: "pi-messages", provider: "faux", model: "faux-1", usage: usage(1_000, 200, 9_000), stopReason: "stop", timestamp: 1 };
	reduceEvent(data, {
		type: "snapshot",
		workflow: null,
		entries: [history],
		agent: {},
		usage: { models: {} },
		run: true,
		generation: { message: streaming },
		tools: [],
		inbox: [],
	} as never, 1_000);
	expect(data.metrics.call).toBeUndefined();
	expect(data.metrics.turn).toEqual({ outputTokens: 0, generationMs: 0, cacheRead: 0, promptTokens: 0 });

	reduceEvent(data, { type: "message_update", usage: usage(1_000, 200, 9_000), changes: [{ type: "text_delta", contentIndex: 0, delta: " more" }] }, 2_000);
	reduceEvent(data, { type: "message_end", entry: assistantEntry("partial more", usage(1_000, 200, 9_000)) }, 4_000);
	expect(data.metrics.call?.tps).toBeUndefined();
});

test("turn aggregates reset when the next run starts", () => {
	const data = createChatData();
	reduceEvent(data, { type: "run_start", inputs: [] }, 1_000);
	call(data, usage(1_000, 100, 9_000), 2_000, 3_000);
	reduceEvent(data, { type: "run_end", inputs: [] }, 4_000);
	expect(data.metrics.turn.outputTokens).toBe(100);

	reduceEvent(data, { type: "run_start", inputs: [] }, 5_000);
	expect(data.metrics.turn).toEqual({ outputTokens: 0, generationMs: 0, cacheRead: 0, promptTokens: 0 });
	expect(data.metrics.call).toBeUndefined();
	call(data, usage(3_000, 50, 1_000), 6_000, 7_000);
	reduceEvent(data, { type: "run_end", inputs: [] }, 8_000);
	expect(turnNotice(data)).toMatchObject({ metrics: { tps: 50, cacheRatio: 0.25 } });
});
