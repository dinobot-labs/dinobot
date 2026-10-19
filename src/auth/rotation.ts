import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { MutableModels, Provider } from "@earendil-works/pi-ai/models";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { accountLabel, classifyAccountFailure, type PoolAccount } from "./pool.ts";
import type { AccountStore } from "./store.ts";

/**
 * Carries the API key pi-ai resolved for one attempt from the provider call back to the rotation loop, so a failure
 * is attributed to the account that actually served it even when a concurrent request rotated the pool meanwhile.
 * pi-ai copies request options with object spread, which keeps symbol keys; providers ignore them.
 */
const SERVED = Symbol("dinobot.servedAccount");
type ServedHolder = { apiKey?: string };
type WithServed = { [SERVED]?: ServedHolder; apiKey?: string };

/** Bound on retries of one request; each retry needs a different, unblocked account anyway. */
const MAX_ATTEMPTS = 8;

export type RotationLog = (message: string) => void;

/** The provider recording the API key of each request into the attempt's holder; behaviour is otherwise unchanged. */
export function recordServedAccount<P extends Provider>(provider: P): P {
	const record = (options: unknown) => {
		const holder = (options as WithServed | undefined)?.[SERVED];
		const apiKey = (options as WithServed).apiKey;
		if (holder && apiKey !== undefined) holder.apiKey = apiKey;
	};
	return {
		...provider,
		stream: (model, context, options) => {
			record(options);
			return provider.stream(model, context, options);
		},
		streamSimple: (model, context, options) => {
			record(options);
			return provider.streamSimple(model, context, options);
		},
	};
}

/** Whether a partial message carries anything the consumer may already show: text, thinking or a tool call. */
function hasOutput(partial: AssistantMessage): boolean {
	return partial.content.some((block) => (block.type === "text" ? block.text !== "" : block.type === "thinking" ? block.thinking !== "" : true));
}

function setupError(model: { api: string; provider: string; id: string }, error: unknown): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	} as AssistantMessage;
}

/**
 * `models.stream`/`streamSimple` (and so `complete*`) retried on the next pooled account when the active one fails
 * with an account-level error before producing any output. The failed account is blocked until its reset (or a
 * default backoff) and stays out of selection meanwhile. Requests with an explicit `apiKey`, single-account
 * providers, aborted requests and failures after output started pass through unchanged.
 */
export function withAccountRotation(models: MutableModels, store: AccountStore, log: RotationLog = (message) => console.error(message)): MutableModels {
	for (const kind of ["stream", "streamSimple"] as const) {
		const original = models[kind].bind(models) as (model: never, context: never, options?: WithServed & { signal?: AbortSignal }) => AssistantMessageEventStream;
		const rotating = (model: { api: string; provider: string; id: string }, context: unknown, options?: WithServed & { signal?: AbortSignal }) => {
			if (options?.apiKey !== undefined) return original(model as never, context as never, options);
			const outer = new AssistantMessageEventStream();
			const run = async () => {
				const tried = new Set<string>();
				for (let attempt = 1; ; attempt++) {
					const selected = await store.selected(model.provider);
					const holder: ServedHolder = {};
					const inner = original(model as never, context as never, { ...options, [SERVED]: holder });
					const held: AssistantMessageEvent[] = [];
					let committed = false;
					let failure: AssistantMessage | undefined;
					for await (const event of inner) {
						if (committed) outer.push(event);
						else if (event.type !== "error" && event.type !== "done" && !hasOutput(event.partial)) held.push(event);
						else if (event.type === "error") {
							held.push(event);
							failure = event.error;
						} else {
							committed = true;
							for (const early of held.splice(0)) outer.push(early);
							outer.push(event);
						}
					}
					if (!failure) {
						for (const early of held) outer.push(early);
						outer.end(await inner.result());
						return;
					}
					const classified = failure.stopReason === "error" && !options?.signal?.aborted ? classifyAccountFailure(failure.errorMessage) : undefined;
					if (classified && selected && attempt < MAX_ATTEMPTS) {
						const outcome = await store.markFailed(model.provider, classified, {
							...(holder.apiKey !== undefined ? { apiKey: holder.apiKey } : {}),
							accountId: selected.id,
						});
						if (outcome.failed) tried.add(outcome.failed.id);
						if (outcome.rotated && outcome.next && !tried.has(outcome.next.id)) {
							const name = (account: PoolAccount) => {
								const label = accountLabel(account.credential);
								return label ? `#${account.id} (${label})` : `#${account.id}`;
							};
							const from = outcome.failed ? name(outcome.failed) : "?";
							const to = name(outcome.next);
							log(`dinobot: ${model.provider} account ${from} hit ${classified.kind}; switched to ${to}`);
							continue;
						}
					}
					for (const event of held) outer.push(event);
					outer.end(failure);
					return;
				}
			};
			run().catch((error: unknown) => {
				const message = setupError(model, error);
				outer.push({ type: "error", reason: "error", error: message });
				outer.end(message);
			});
			return outer;
		};
		(models as unknown as Record<string, unknown>)[kind] = rotating;
	}
	return models;
}
