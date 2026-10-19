import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai/models";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

/**
 * Per-request budget for one model call. This is not a task lifetime limit: a turn may run for hours, but a single
 * request that stops delivering data must end so the generation retry policy (and finally the channel) can recover.
 *
 * - `timeoutMs`/`maxRetries` go to pi-ai when the caller set none; adapters hand them to their SDK, where the timeout
 *   bounds each HTTP attempt up to the response headers and the retries repeat transient connection failures.
 * - The watchdog covers what the SDK timeout does not: a response whose body stops flowing. Before the first stream
 *   event it waits out every SDK attempt (`(maxRetries + 1) * timeoutMs` plus backoff); after it, `idleMs` between events.
 */
export type RequestBudget = {
	readonly timeoutMs: number;
	readonly maxRetries: number;
	readonly idleMs: number;
	readonly maxRetryDelayMs: number;
	readonly graceMs: number;
};

export const DEFAULT_REQUEST_BUDGET: RequestBudget = { timeoutMs: 120_000, maxRetries: 1, idleMs: 300_000, maxRetryDelayMs: 60_000, graceMs: 10_000 };

type BudgetOptions = { signal?: AbortSignal; timeoutMs?: number; maxRetries?: number; maxRetryDelayMs?: number };
type ModelRef = { api: string; provider: string; id: string };

function failure(model: ModelRef, stopReason: "error" | "aborted", errorMessage: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		errorMessage,
		timestamp: Date.now(),
	} as AssistantMessage;
}

function watched<O extends BudgetOptions>(model: ModelRef, options: O | undefined, budget: RequestBudget, open: (options: O) => AssistantMessageEventStream): AssistantMessageEventStream {
	const caller = options?.signal;
	const controller = new AbortController();
	const timeoutMs = options?.timeoutMs ?? budget.timeoutMs;
	const maxRetries = options?.maxRetries ?? budget.maxRetries;
	const retryDelayMs = options?.maxRetryDelayMs || budget.maxRetryDelayMs;
	const firstEventMs = (maxRetries + 1) * timeoutMs + maxRetries * retryDelayMs + budget.graceMs;
	const signal = caller ? AbortSignal.any([caller, controller.signal]) : controller.signal;
	const inner = open({ ...options, timeoutMs, maxRetries, signal } as O);
	const outer = new AssistantMessageEventStream();

	const pump = async () => {
		const iterator = inner[Symbol.asyncIterator]();
		let waitMs = firstEventMs;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			for (;;) {
				const stalled = new Promise<"stalled">((resolve) => {
					timer = setTimeout(resolve, waitMs, "stalled");
				});
				const next = await Promise.race([iterator.next(), stalled]);
				clearTimeout(timer);
				if (next === "stalled") {
					// "timed out" keeps the message retryable for pi-durable's generation retry policy.
					const message = caller?.aborted
						? failure(model, "aborted", "Request aborted")
						: failure(model, "error", `${model.provider}/${model.id} request timed out: no response data for ${Math.round(waitMs / 1000)}s`);
					controller.abort(new Error(message.errorMessage));
					outer.push({ type: "error", reason: message.stopReason as "error" | "aborted", error: message });
					outer.end(message);
					return;
				}
				if (next.done) break;
				outer.push(next.value);
				waitMs = budget.idleMs;
			}
			outer.end(await inner.result());
		} finally {
			clearTimeout(timer);
		}
	};
	pump().catch((error: unknown) => {
		const message = failure(model, "error", error instanceof Error ? error.message : String(error));
		outer.push({ type: "error", reason: "error", error: message });
		outer.end(message);
	});
	return outer;
}

/** The provider with every `stream`/`streamSimple` request bounded by `budget`; responses that keep flowing are unchanged. */
export function withRequestBudget<P extends Provider>(provider: P, budget: RequestBudget = DEFAULT_REQUEST_BUDGET): P {
	return {
		...provider,
		streamSimple: (model, context, options) => watched(model, options, budget, (bounded) => provider.streamSimple(model, context, bounded)),
		stream: (model, context, options) => watched(model, options as BudgetOptions | undefined, budget, (bounded) => provider.stream(model, context, bounded as never)),
	};
}
