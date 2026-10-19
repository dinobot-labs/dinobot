import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import type { AssistantMessage, AssistantMessageEvent, Context, Message } from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai/models";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { fingerprintMessages, isPolicyRefusal, truncateToolOutputs, withRefusalRetry } from "../src/auth/refusal.ts";
import { type RequestBudget, withRequestBudget } from "../src/auth/request-budget.ts";

const model = { api: "openai-completions", provider: "zai", id: "glm" } as never;

function message(stopReason: AssistantMessage["stopReason"], text = ""): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: "openai-completions",
		provider: "zai",
		model: "glm",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		timestamp: 0,
	} as AssistantMessage;
}

function refusal(errorMessage = "This request triggered restrictions on violative cyber content and was blocked under Anthropic's Usage Policy."): AssistantMessage {
	return { ...message("error"), rawStopReason: "refusal", errorMessage };
}

function userMessage(text: string): Message {
	return { role: "user", content: text, timestamp: 0 } as Message;
}

function toolResult(text: string, toolCallId = "call-1"): Message {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 0,
	} as Message;
}

const LONG_OUTPUT = "x".repeat(5000);
const contextWithToolOutput = (output = LONG_OUTPUT): Context => ({ messages: [userMessage("do the task"), toolResult(output)] }) as Context;

type Outcome = AssistantMessage | { events: AssistantMessageEvent[]; final: AssistantMessage };

/** A provider that answers each call with the next scripted outcome and records every context it received. */
function scripted(outcomes: Outcome[]) {
	const contexts: Context[] = [];
	let calls = 0;
	const start = (_model: unknown, context: Context) => {
		const call = calls++;
		contexts.push(context);
		const outcome = outcomes[Math.min(call, outcomes.length - 1)]!;
		const stream = new AssistantMessageEventStream();
		void (async () => {
			if ("final" in outcome) {
				for (const event of outcome.events) stream.push(event);
				stream.push({ type: "done", reason: "stop", message: outcome.final } as AssistantMessageEvent);
				stream.end(outcome.final);
				return;
			}
			const error = outcome.stopReason === "error" || outcome.stopReason === "aborted";
			stream.push({ type: error ? "error" : "done", reason: outcome.stopReason, error: outcome, message: outcome } as unknown as AssistantMessageEvent);
			stream.end(outcome);
		})();
		return stream;
	};
	const provider = { id: "zai", name: "zai", streamSimple: start, stream: start } as unknown as Provider;
	return {
		provider,
		contexts,
		calls: () => calls,
	};
}

async function collect(stream: AssistantMessageEventStream) {
	const types: string[] = [];
	for await (const event of stream) types.push(event.type);
	return { types, result: await stream.result() };
}

describe("isPolicyRefusal", () => {
	test("detects rawStopReason refusal, Usage Policy text and sensitive stops", () => {
		expect(isPolicyRefusal(refusal())).toBe(true);
		expect(isPolicyRefusal({ ...message("error"), errorMessage: "Provider stopped with: sensitive" })).toBe(true);
		expect(isPolicyRefusal({ ...message("error"), errorMessage: "The model refused to complete the request" })).toBe(true);
	});

	test("rejects ordinary errors and non-error stops", () => {
		expect(isPolicyRefusal({ ...message("error"), errorMessage: "429 rate limit" })).toBe(false);
		expect(isPolicyRefusal({ ...message("error"), rawStopReason: "refusal" })).toBe(true);
		expect(isPolicyRefusal(message("stop"))).toBe(false);
		expect(isPolicyRefusal({ ...message("length"), rawStopReason: "refusal" })).toBe(false);
	});
});

describe("truncateToolOutputs", () => {
	test("truncates only oversized toolResult text blocks and marks the cut", () => {
		const exact = "y".repeat(2000);
		const context = { messages: [userMessage("keep me"), toolResult(exact, "a"), toolResult(LONG_OUTPUT, "b")] } as Context;
		const { context: narrowed, truncatedBlocks } = truncateToolOutputs(context, 2000);
		expect(truncatedBlocks).toBe(1);
		const [user, small, big] = narrowed.messages;
		expect(user).toBe(context.messages[0]);
		expect(small).toBe(context.messages[1]);
		const text = (big as { content: { text: string }[] }).content[0]!.text;
		expect(text.startsWith("x".repeat(2000))).toBe(true);
		expect(text).toContain("[dinobot: truncated 3000 chars for policy-refusal retry]");
	});
});

describe("withRefusalRetry", () => {
	test("a refusal is retried once with truncated tool outputs and the success carries a diagnostic", async () => {
		const success = message("stop", "done");
		const logs: string[] = [];
		const { provider, contexts, calls } = scripted([refusal(), success]);
		const wrapped = withRefusalRetry(provider, { log: (line) => logs.push(line) });
		const { result } = await collect(wrapped.streamSimple(model, contextWithToolOutput() as never, undefined));
		expect(calls()).toBe(2);
		const sent = contexts[1]!.messages[1] as { content: { text: string }[] };
		expect(sent.content[0]!.text.length).toBeLessThan(LONG_OUTPUT.length);
		expect(sent.content[0]!.text).toContain("for policy-refusal retry]");
		expect((contexts[0]!.messages[1] as typeof sent).content[0]!.text).toBe(LONG_OUTPUT);
		expect(result.stopReason).toBe("stop");
		expect(result.diagnostics?.some((diagnostic) => diagnostic.type === "policy-refusal-retry")).toBe(true);
		expect(logs).toHaveLength(1);
		expect(logs[0]).toContain("policy refusal");
	});

	test("a repeated refusal passes through and the circuit breaker blocks later retries of the same context", async () => {
		const { provider, calls } = scripted([refusal(), refusal(), refusal()]);
		const wrapped = withRefusalRetry(provider, { log: () => {} });
		const first = await collect(wrapped.streamSimple(model, contextWithToolOutput() as never, undefined));
		expect(calls()).toBe(2);
		expect(isPolicyRefusal(first.result)).toBe(true);
		expect(first.result.diagnostics).toBeUndefined();
		// A new request with the same context: the fingerprint already spent its retry, so exactly one attempt.
		const second = await collect(wrapped.streamSimple(model, contextWithToolOutput() as never, undefined));
		expect(calls()).toBe(3);
		expect(isPolicyRefusal(second.result)).toBe(true);
	});

	test("a different context after a circuit-broken one gets its own single retry", async () => {
		const success = message("stop", "ok");
		const { provider, calls } = scripted([refusal(), refusal(), refusal(), refusal(), success]);
		const wrapped = withRefusalRetry(provider, { log: () => {} });
		await collect(wrapped.streamSimple(model, contextWithToolOutput() as never, undefined));
		await collect(wrapped.streamSimple(model, contextWithToolOutput() as never, undefined));
		const other = await collect(wrapped.streamSimple(model, contextWithToolOutput("y".repeat(6000)) as never, undefined));
		expect(calls()).toBe(5);
		expect(other.result.stopReason).toBe("stop");
	});

	test("a refusal with nothing truncatable passes through without a retry and without spending the fingerprint", async () => {
		const small = { messages: [userMessage("do it"), toolResult("short output")] } as Context;
		const { provider, calls } = scripted([refusal(), refusal(), refusal()]);
		const logs: string[] = [];
		const wrapped = withRefusalRetry(provider, { log: (line) => logs.push(line) });
		const first = await collect(wrapped.streamSimple(model, small as never, undefined));
		expect(calls()).toBe(1);
		expect(isPolicyRefusal(first.result)).toBe(true);
		expect(logs).toHaveLength(0);
		// The fingerprint was not spent, but a retry would still be identical bytes: the next request also skips it.
		const second = await collect(wrapped.streamSimple(model, small as never, undefined));
		expect(calls()).toBe(2);
		expect(isPolicyRefusal(second.result)).toBe(true);
	});

	test("non-refusal errors pass through without a retry", async () => {
		const failure429 = { ...message("error"), errorMessage: "429 rate limit exceeded" };
		const { provider, contexts, calls } = scripted([failure429]);
		const wrapped = withRefusalRetry(provider, { log: () => {} });
		const { result } = await collect(wrapped.streamSimple(model, contextWithToolOutput() as never, undefined));
		expect(calls()).toBe(1);
		expect(result.errorMessage).toBe("429 rate limit exceeded");
		expect((contexts[0]!.messages[1] as { content: { text: string }[] }).content[0]!.text).toBe(LONG_OUTPUT);
	});

	test("a caller abort never triggers a retry", async () => {
		const { provider, calls } = scripted([refusal()]);
		const wrapped = withRefusalRetry(provider, { log: () => {} });
		const { result } = await collect(wrapped.streamSimple(model, contextWithToolOutput() as never, { signal: AbortSignal.abort() } as never));
		expect(calls()).toBe(1);
		expect(isPolicyRefusal(result)).toBe(true);
	});

	test("a refusal after visible output is not retried and the events pass through", async () => {
		const partial = message("stop", "partial answer");
		const outcome = { events: [{ type: "text_delta", contentIndex: 0, delta: "partial answer", partial } as AssistantMessageEvent], final: refusal() };
		const { provider, calls } = scripted([outcome]);
		const wrapped = withRefusalRetry(provider, { log: () => {} });
		const { types, result } = await collect(wrapped.streamSimple(model, contextWithToolOutput() as never, undefined));
		expect(calls()).toBe(1);
		expect(types).toEqual(["text_delta", "done"]);
		expect(isPolicyRefusal(result)).toBe(true);
	});

	test("a clean success passes through untouched", async () => {
		const success = message("stop", "hi");
		const { provider, calls } = scripted([success]);
		const wrapped = withRefusalRetry(provider, { log: () => {} });
		const { result } = await collect(wrapped.streamSimple(model, contextWithToolOutput() as never, undefined));
		expect(calls()).toBe(1);
		expect(result).toBe(success);
		expect(result.diagnostics).toBeUndefined();
	});

	test("fingerprints ignore text content but react to role, tool identity and length", () => {
		const a = fingerprintMessages(model, [userMessage("hello"), toolResult("short", "c1")]);
		const sameLengths = fingerprintMessages(model, [userMessage("HELLO"), toolResult("SHORT", "c1")]);
		const longer = fingerprintMessages(model, [userMessage("hello!"), toolResult("short", "c1")]);
		const otherTool = fingerprintMessages(model, [userMessage("hello"), toolResult("short", "c2")]);
		expect(a).toBe(sameLengths);
		expect(a).not.toBe(longer);
		expect(a).not.toBe(otherTool);
	});
});

describe("refusal retry composed with the per-request budget", () => {
	// firstEventMs = (maxRetries + 1) * timeoutMs + maxRetries * maxRetryDelayMs + graceMs = 200ms per watchdog.
	const budget: RequestBudget = { timeoutMs: 150, maxRetries: 0, idleMs: 200, maxRetryDelayMs: 1, graceMs: 50 };
	const ATTEMPT_MS = 130; // one attempt fits a fresh watchdog (130 < 200); two do not share one (260 > 200).

	/** A provider whose every call stays silent for ATTEMPT_MS and then ends with the next outcome; aborts end it early. */
	function slow(outcomes: AssistantMessage[]) {
		let calls = 0;
		const start = (_model: unknown, _context: Context, options?: { signal?: AbortSignal }) => {
			const outcome = outcomes[Math.min(calls++, outcomes.length - 1)]!;
			const stream = new AssistantMessageEventStream();
			const timer = setTimeout(() => {
				const error = outcome.stopReason === "error";
				stream.push({ type: error ? "error" : "done", reason: outcome.stopReason, error: outcome, message: outcome } as unknown as AssistantMessageEvent);
				stream.end(outcome);
			}, ATTEMPT_MS);
			options?.signal?.addEventListener("abort", () => {
				clearTimeout(timer);
				const aborted = { ...message("aborted"), errorMessage: "aborted" };
				stream.push({ type: "error", reason: "aborted", error: aborted } as AssistantMessageEvent);
				stream.end(aborted);
			});
			return stream;
		};
		return { provider: { id: "zai", name: "zai", streamSimple: start, stream: start } as unknown as Provider, calls: () => calls };
	}

	test("each attempt gets its own watchdog when the refusal wrapper sits outside the budget (createBotModels order)", async () => {
		const { provider, calls } = slow([refusal(), message("stop", "ok")]);
		const wrapped = withRefusalRetry(withRequestBudget(provider, budget), { log: () => {} });
		const { result } = await collect(wrapped.streamSimple(model, contextWithToolOutput() as never, undefined));
		expect(calls()).toBe(2);
		expect(result.stopReason).toBe("stop");
		expect(result.diagnostics?.some((d) => d.type === "policy-refusal-retry")).toBe(true);
	});

	test("guard: the inverse order makes both attempts share one watchdog and the valid retry times out", async () => {
		const { provider, calls } = slow([refusal(), message("stop", "ok")]);
		const wrapped = withRequestBudget(withRefusalRetry(provider, { log: () => {} }), budget);
		const { result } = await collect(wrapped.streamSimple(model, contextWithToolOutput() as never, undefined));
		expect(calls()).toBe(2);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("timed out");
	});

	test("createBotModels wraps the budgeted provider with the refusal retry, not the other way round", () => {
		const source = readFileSync(new URL("../src/auth/index.ts", import.meta.url), "utf8");
		expect(source).toContain("withRefusalRetry(withRequestBudget(");
		expect(source).not.toContain("withRequestBudget(withRefusalRetry(");
	});
});
