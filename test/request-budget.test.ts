import { describe, expect, test } from "bun:test";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai/models";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { type RequestBudget, withRequestBudget } from "../src/auth/request-budget.ts";

const model = { api: "openai-completions", provider: "zai", id: "glm" } as never;
const context = { messages: [] } as never;
const budget: RequestBudget = { timeoutMs: 20, maxRetries: 0, idleMs: 60, maxRetryDelayMs: 1, graceMs: 20 };

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

type Step = { afterMs: number; event: AssistantMessageEvent } | { afterMs: number; end: AssistantMessage };

function scripted(steps: Step[]) {
	const seen: Record<string | symbol, unknown>[] = [];
	const start = (_model: unknown, _context: unknown, options?: Record<string | symbol, unknown>) => {
		seen.push(options ?? {});
		const stream = new AssistantMessageEventStream();
		const signal = options?.signal as AbortSignal | undefined;
		void (async () => {
			for (const step of steps) {
				await Bun.sleep(step.afterMs);
				if (signal?.aborted) {
					const aborted = { ...message("aborted"), errorMessage: "Request was aborted" };
					stream.push({ type: "error", reason: "aborted", error: aborted });
					stream.end(aborted);
					return;
				}
				if ("end" in step) {
					stream.push({ type: "done", reason: "stop", message: step.end } as AssistantMessageEvent);
					stream.end(step.end);
					return;
				}
				stream.push(step.event);
			}
		})();
		return stream;
	};
	const provider = { id: "zai", name: "zai", streamSimple: start, stream: start } as unknown as Provider;
	return { provider, seen };
}

const NEVER = 60_000;
const text = (value: string): AssistantMessageEvent => ({ type: "text_delta", contentIndex: 0, delta: value, partial: message("stop", value) });

async function collect(stream: AssistantMessageEventStream) {
	const types: string[] = [];
	for await (const event of stream) types.push(event.type);
	return { types, result: await stream.result() };
}

describe("per-request budget", () => {
	test("a request that never produces an event ends as a retryable timeout and aborts the provider call", async () => {
		const { provider, seen } = scripted([{ afterMs: NEVER, end: message("stop", "late") }]);
		const started = performance.now();
		const { types, result } = await collect(withRequestBudget(provider, budget).streamSimple(model, context));
		const elapsed = performance.now() - started;
		expect(types).toEqual(["error"]);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("zai/glm request timed out");
		expect(isRetryableAssistantError(result)).toBe(true);
		expect((seen[0]!.signal as AbortSignal).aborted).toBe(true);
		// First-event window = (maxRetries + 1) * timeoutMs + graceMs = 40ms.
		expect(elapsed).toBeGreaterThanOrEqual(35);
		expect(elapsed).toBeLessThan(1_000);
	});

	test("a stream that stalls after output ends after the idle gap with the earlier events delivered", async () => {
		const { provider, seen } = scripted([
			{ afterMs: 0, event: { type: "start", partial: message("stop") } },
			{ afterMs: 0, event: text("hel") },
			{ afterMs: NEVER, end: message("stop", "hello") },
		]);
		const { types, result } = await collect(withRequestBudget(provider, budget).streamSimple(model, context));
		expect(types).toEqual(["start", "text_delta", "error"]);
		expect(result.errorMessage).toContain("no response data for 0s");
		expect(isRetryableAssistantError(result)).toBe(true);
		expect((seen[0]!.signal as AbortSignal).aborted).toBe(true);
	});

	test("a stream whose events keep arriving within the idle gap completes even when it outlasts it in total", async () => {
		const steps: Step[] = [{ afterMs: 0, event: { type: "start", partial: message("stop") } }];
		for (let i = 0; i < 6; i++) steps.push({ afterMs: 25, event: text(String(i)) });
		steps.push({ afterMs: 25, end: message("stop", "012345") });
		const { provider, seen } = scripted(steps);
		const { types, result } = await collect(withRequestBudget(provider, budget).streamSimple(model, context));
		expect(result.stopReason).toBe("stop");
		expect(types.filter((type) => type === "text_delta")).toHaveLength(6);
		expect((seen[0]!.signal as AbortSignal).aborted).toBe(false);
	});

	test("defaults fill only what the caller left unset, other options pass through", async () => {
		const marker = Symbol("marker");
		const { provider, seen } = scripted([{ afterMs: 0, end: message("stop", "ok") }]);
		const wrapped = withRequestBudget(provider, budget);
		await wrapped.streamSimple(model, context, { [marker]: 1, sessionId: "s" } as never).result();
		await wrapped.stream(model, context, { timeoutMs: 5_000, maxRetries: 3 } as never).result();
		expect(seen[0]).toMatchObject({ timeoutMs: 20, maxRetries: 0, sessionId: "s" });
		expect(seen[0]![marker]).toBe(1);
		expect(seen[1]).toMatchObject({ timeoutMs: 5_000, maxRetries: 3 });
	});

	test("a caller abort reaches the provider and stays an abort", async () => {
		const { provider, seen } = scripted([
			{ afterMs: 0, event: { type: "start", partial: message("stop") } },
			{ afterMs: 30, end: message("stop", "late") },
		]);
		const abort = new AbortController();
		const stream = withRequestBudget(provider, { ...budget, idleMs: NEVER }).streamSimple(model, context, { signal: abort.signal });
		abort.abort();
		const { result } = await collect(stream);
		expect(result.stopReason).toBe("aborted");
		expect((seen[0]!.signal as AbortSignal).aborted).toBe(true);
	});
});
