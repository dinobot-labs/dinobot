import { afterEach, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking } from "@earendil-works/pi-ai/providers/faux";
import type { Message } from "@earendil-works/pi-ai";
import { createRegistry, Harness, MemoryStorage, type CompactionPolicy } from "@earendil-works/pi-durable";

// Upstream fixes backported into patches/@earendil-works%2Fpi-durable@1.0.2.patch:
// 92216fa1 (leading system message), 15e7bdc1 (no thinking in summaries), 89e5c2c0 (failed blocking compaction).

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

type Request = { messages: Message[] };
const textOf = (message: Message | undefined): string => {
	if (message === undefined) return "";
	if (typeof message.content === "string") return message.content;
	return (message.content as { type: string; text?: string }[]).map((part) => (part.type === "text" ? part.text ?? "" : "")).join("");
};
const isSummaryRequest = (messages: readonly Message[]) =>
	messages.some((message) => message.role === "user" && textOf(message).includes("<conversation>"));

async function open(options: { contextWindow?: number; compaction?: Partial<CompactionPolicy> } = {}) {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: options.contextWindow ?? 200_000, maxTokens: 1000 }] });
	const models = createModels();
	models.setProvider(faux.provider);
	const settings = { compaction: options.compaction ?? { enabled: false }, retry: { enabled: false } };
	const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry(), settings }, context);
	cleanup.push(() => harness.close(context));
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" }, instructions: "BASE PROMPT" } });
	const agentRequests: Request[] = [];
	const summaryRequests: Request[] = [];
	return { faux, harness, root, settings, agentRequests, summaryRequests };
}

test("the model context leads with the baseline system message although the input entry precedes it", async () => {
	const chat = await open();
	chat.faux.setResponses([(ctx) => { chat.agentRequests.push({ messages: [...ctx.messages] as Message[] }); return fauxAssistantMessage("a1"); }]);
	const settled = await (await chat.root.submit({ type: "input", content: "hello" }, context)).wait(context);
	expect(settled.status).toBe("done");

	// Stored order is unchanged: the input is committed before generation renders the system prompt.
	const kinds = (await chat.root.entries({}, 100, undefined, context)).items.map((entry) => entry.kind).reverse();
	expect(kinds.indexOf("pi.user")).toBeLessThan(kinds.indexOf("pi.system"));

	const sent = chat.agentRequests[0]!.messages;
	expect(sent[0]!.role).toBe("system");
	expect(sent[1]!.role).toBe("user");
	expect(textOf(sent[1])).toBe("hello");
	const derived = (await chat.root.context(context)).messages;
	expect(derived.map((message) => message.role)).toEqual(["system", "user", "assistant"]);
});

test("compaction summaries omit assistant thinking but keep visible text", async () => {
	const chat = await open({ compaction: { enabled: false, keepRecentTokens: 1 } });
	chat.faux.setResponses([
		fauxAssistantMessage([fauxThinking("SECRET-THOUGHT"), fauxText("VISIBLE-ANSWER")]),
		fauxAssistantMessage("a2"),
		(ctx) => { chat.summaryRequests.push({ messages: [...ctx.messages] as Message[] }); return fauxAssistantMessage("SUMMARY"); },
	]);
	expect((await (await chat.root.submit({ type: "input", content: "first question" }, context)).wait(context)).status).toBe("done");
	expect((await (await chat.root.submit({ type: "input", content: "second question" }, context)).wait(context)).status).toBe("done");
	const id = await chat.root.compact(undefined, context);
	const outcome = await chat.harness.waitForTask(id, context);
	expect(outcome.state).toMatchObject({ status: "terminal", outcome: { status: "completed" } });
	expect(chat.summaryRequests).toHaveLength(1);
	const prompt = chat.summaryRequests[0]!.messages.map(textOf).join("\n");
	expect(prompt).toContain("VISIBLE-ANSWER");
	expect(prompt).not.toContain("SECRET-THOUGHT");
	expect(prompt).not.toContain("[Assistant thinking]");
});

test("a run whose blocking threshold compaction failed fails instead of sending the oversized request", async () => {
	const chat = await open({ contextWindow: 2000, compaction: { enabled: false } });
	const big = (label: string) => `${label} ${"lorem ipsum dolor sit amet ".repeat(110)}`;
	chat.faux.setResponses([fauxAssistantMessage(big("a1")), fauxAssistantMessage(big("a2"))]);
	expect((await (await chat.root.submit({ type: "input", content: big("u1") }, context)).wait(context)).status).toBe("done");
	expect((await (await chat.root.submit({ type: "input", content: big("u2") }, context)).wait(context)).status).toBe("done");

	// Now above contextWindow - reserveTokens: preparation must block on a compaction, whose summary fails.
	chat.settings.compaction = { enabled: true, reserveTokens: 500, keepRecentTokens: 100, backgroundTokens: 0 };
	chat.faux.setResponses([
		(ctx) => {
			if (isSummaryRequest(ctx.messages as Message[])) {
				chat.summaryRequests.push({ messages: [...ctx.messages] as Message[] });
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: "summarizer unavailable" });
			}
			chat.agentRequests.push({ messages: [...ctx.messages] as Message[] });
			return fauxAssistantMessage("a3");
		},
		(ctx) => { chat.agentRequests.push({ messages: [...ctx.messages] as Message[] }); return fauxAssistantMessage("a3"); },
	]);
	const settled = await (await chat.root.submit({ type: "input", content: "u3" }, context)).wait(context);
	expect(chat.summaryRequests).toHaveLength(1);
	expect(chat.agentRequests).toHaveLength(0);
	expect(settled).toMatchObject({ status: "unanswered", reason: "model_error" });
	expect(String((settled as { detail?: unknown }).detail)).toContain("Compaction failed: ");
	expect(String((settled as { detail?: unknown }).detail)).toContain("summarizer unavailable");
});

test("a blocking threshold compaction that succeeds still answers", async () => {
	const chat = await open({ contextWindow: 2000, compaction: { enabled: false } });
	const big = (label: string) => `${label} ${"lorem ipsum dolor sit amet ".repeat(110)}`;
	chat.faux.setResponses([fauxAssistantMessage(big("a1")), fauxAssistantMessage(big("a2"))]);
	expect((await (await chat.root.submit({ type: "input", content: big("u1") }, context)).wait(context)).status).toBe("done");
	expect((await (await chat.root.submit({ type: "input", content: big("u2") }, context)).wait(context)).status).toBe("done");
	chat.settings.compaction = { enabled: true, reserveTokens: 500, keepRecentTokens: 100, backgroundTokens: 0 };
	const respond = (ctx: { messages: unknown[] }) => {
		if (isSummaryRequest(ctx.messages as Message[])) { chat.summaryRequests.push({ messages: [...ctx.messages] as Message[] }); return fauxAssistantMessage("SUMMARY"); }
		chat.agentRequests.push({ messages: [...ctx.messages] as Message[] });
		return fauxAssistantMessage("a3");
	};
	chat.faux.setResponses([respond, respond]);
	const settled = await (await chat.root.submit({ type: "input", content: "u3" }, context)).wait(context);
	expect(settled.status).toBe("done");
	expect(chat.summaryRequests).toHaveLength(1);
	expect(chat.agentRequests).toHaveLength(1);
	// Only one baseline system message reaches the request after the compaction.
	expect(chat.agentRequests[0]!.messages.filter((message) => message.role === "system")).toHaveLength(1);
	expect(chat.agentRequests[0]!.messages.map(textOf).join("\n")).toContain("SUMMARY");
});
