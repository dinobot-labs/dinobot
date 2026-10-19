import type { AssistantMessage, AssistantMessageEvent, Message, TranscriptContext } from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai/models";
import { appendAssistantMessageDiagnostic, createAssistantMessageDiagnostic } from "@earendil-works/pi-ai/utils/diagnostics";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

/**
 * Policy-refusal safe retry (ADR 0087). A provider policy refusal (Anthropic `refusal`/`sensitive` stop reasons,
 * Usage Policy blocks) is deterministic in the request content: resending the same bytes re-blocks. The only
 * meaningful retry changes the input, so this wrapper retries a refusal exactly once per distinct context, with
 * large tool outputs truncated, and then stops.
 *
 * - Detection: `stopReason: "error"` with `rawStopReason: "refusal"` or policy-flavoured error text (pi-ai maps the
 *   Anthropic `refusal`/`sensitive` stop reasons to this shape).
 * - Circuit breaker: a process-local ledger of context fingerprints. A fingerprint that already consumed its retry
 *   passes the refusal through unchanged, so callers (pi-durable generation retries) can never loop on it. When no
 *   tool output is long enough to truncate, a retry would resend identical bytes, so the refusal passes through
 *   without spending the fingerprint.
 * - Composition: the wrapper sits OUTSIDE withRequestBudget, so the initial attempt and the retry each get a fresh
 *   budget watchdog instead of sharing one first-event deadline.
 * - Transparency: the retry is logged, the truncation marker stays in the text sent to the provider, and a
 *   successful retry carries a `policy-refusal-retry` diagnostic.
 * - Only attempts that produced no visible output are retried; once output streamed to the caller the refusal
 *   passes through (mirrors the committed-output rule of withAccountRotation). Caller aborts never retry.
 */

const POLICY_ERROR_TEXT = /usage policy|violative|refused to complete|stopped with: sensitive/i;

/** Whether the finished message is a provider policy refusal (as opposed to a transient or account failure). */
export function isPolicyRefusal(message: AssistantMessage): boolean {
	if (message.stopReason !== "error") return false;
	return message.rawStopReason === "refusal" || POLICY_ERROR_TEXT.test(message.errorMessage ?? "");
}

function mix(hash: number, text: string): number {
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash;
}

/** Stable FNV-1a fingerprint of the request: model, roles, tool identity and text lengths — never the text itself. */
export function fingerprintMessages(model: { provider: string; id: string }, messages: readonly Message[]): string {
	let hash = mix(0x811c9dc5, `${model.provider}/${model.id}`);
	for (const message of messages) {
		hash = mix(hash, message.role);
		if (message.role === "toolResult") {
			hash = mix(hash, `${message.toolName}:${message.toolCallId}:${message.isError}`);
			for (const block of message.content) hash = mix(hash, block.type === "text" ? `t${block.text.length}` : block.type);
			continue;
		}
		const content = (message as { content?: unknown }).content;
		if (typeof content === "string") {
			hash = mix(hash, `t${content.length}`);
			continue;
		}
		if (Array.isArray(content)) {
			for (const block of content as { type: string; text?: string; thinking?: string; name?: string }[]) {
				hash = mix(hash, block.type);
				if (block.type === "text") hash = mix(hash, `${block.text?.length ?? 0}`);
				else if (block.type === "thinking") hash = mix(hash, `${block.thinking?.length ?? 0}`);
				else if (block.type === "toolCall") hash = mix(hash, block.name ?? "");
			}
		}
	}
	return hash.toString(16);
}

const LEDGER_CAP = 64;

/** Process-local record of fingerprints that already consumed their one retry; FIFO-bounded. */
class RetryLedger {
	readonly #spent = new Map<string, true>();

	/** True when this fingerprint may still use its single retry; marks it spent. */
	spend(key: string): boolean {
		if (this.#spent.has(key)) return false;
		if (this.#spent.size >= LEDGER_CAP) {
			const oldest = this.#spent.keys().next().value;
			if (oldest !== undefined) this.#spent.delete(oldest);
		}
		this.#spent.set(key, true);
		return true;
	}
}

export const DEFAULT_MAX_TOOL_RESULT_CHARS = 2000;

/** The context with oversized toolResult text blocks truncated in place; everything else is returned unchanged. */
export function truncateToolOutputs<C extends { messages: Message[] }>(context: C, maxChars: number): { context: C; truncatedBlocks: number } {
	let truncatedBlocks = 0;
	const messages = context.messages.map((message) => {
		if (message.role !== "toolResult") return message;
		let touched = false;
		const content = message.content.map((block) => {
			if (block.type !== "text" || block.text.length <= maxChars) return block;
			touched = true;
			truncatedBlocks++;
			return { ...block, text: `${block.text.slice(0, maxChars)}\n…[dinobot: truncated ${block.text.length - maxChars} chars for policy-refusal retry]` };
		});
		return touched ? { ...message, content } : message;
	});
	return { context: { ...context, messages } as C, truncatedBlocks };
}

export type RefusalRetryOptions = {
	readonly log?: (message: string) => void;
	readonly maxToolResultChars?: number;
};

type CallOptions = { signal?: AbortSignal };
type ModelRef = { api: string; provider: string; id: string };

/** Whether a partial message carries anything the consumer may already show (mirrors withAccountRotation). */
function hasOutput(partial: AssistantMessage): boolean {
	return partial.content.some((block) => (block.type === "text" ? block.text !== "" : block.type === "thinking" ? block.thinking !== "" : true));
}

function failure(model: ModelRef, error: unknown): AssistantMessage {
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

function guarded(
	model: ModelRef,
	context: TranscriptContext,
	options: CallOptions | undefined,
	ledger: RetryLedger,
	log: (message: string) => void,
	maxChars: number,
	open: (context: TranscriptContext) => AssistantMessageEventStream,
): AssistantMessageEventStream {
	const outer = new AssistantMessageEventStream();
	const run = async () => {
		/** Streams one attempt into outer, buffering until output commits; held events of an uncommitted attempt go back to the caller. */
		const attempt = async (attemptContext: TranscriptContext): Promise<{ final: AssistantMessage; committed: boolean; held: AssistantMessageEvent[] }> => {
			const inner = open(attemptContext);
			const held: AssistantMessageEvent[] = [];
			let committed = false;
			for await (const event of inner) {
				if (committed) {
					outer.push(event);
					continue;
				}
				if (event.type === "error" || event.type === "done") {
					const terminal = event.type === "error" ? event.error : event.message;
					if (isPolicyRefusal(terminal)) {
						held.push(event);
						continue;
					}
				} else if (!hasOutput(event.partial)) {
					held.push(event);
					continue;
				}
				committed = true;
				for (const early of held.splice(0)) outer.push(early);
				outer.push(event);
			}
			return { final: await inner.result(), committed, held };
		};

		const first = await attempt(context);
		const retryable = isPolicyRefusal(first.final) && !first.committed && !options?.signal?.aborted;
		const key = retryable ? fingerprintMessages(model, context.messages) : undefined;
		if (key === undefined) {
			for (const event of first.held) outer.push(event);
			outer.end(first.final);
			return;
		}
		const { context: narrowed, truncatedBlocks } = truncateToolOutputs(context, maxChars);
		// Identical bytes deterministically re-block; without a truncation there is no new input to try, and the
		// fingerprint stays unspent so a later edit of the context still gets its one retry.
		if (truncatedBlocks === 0 || !ledger.spend(key)) {
			for (const event of first.held) outer.push(event);
			outer.end(first.final);
			return;
		}
		log(`dinobot: ${model.provider}/${model.id} hit a policy refusal; retrying once with truncated tool outputs`);
		const second = await attempt(narrowed);
		for (const event of second.held) outer.push(event);
		const final = second.final;
		if (!isPolicyRefusal(final) && final.stopReason !== "error" && final.stopReason !== "aborted") {
			appendAssistantMessageDiagnostic(
				final,
				createAssistantMessageDiagnostic("policy-refusal-retry", new Error("initial request refused by provider policy"), { fingerprint: key, truncatedBlocks }),
			);
		}
		outer.end(final);
	};
	run().catch((error: unknown) => {
		const message = failure(model, error);
		outer.push({ type: "error", reason: "error", error: message });
		outer.end(message);
	});
	return outer;
}

/** The provider whose policy refusals get one truncated-output retry per distinct context; everything else passes through unchanged. */
export function withRefusalRetry<P extends Provider>(provider: P, options: RefusalRetryOptions = {}): P {
	const ledger = new RetryLedger();
	const log = options.log ?? ((message: string) => console.error(message));
	const maxChars = options.maxToolResultChars ?? DEFAULT_MAX_TOOL_RESULT_CHARS;
	return {
		...provider,
		streamSimple: (model, context, callOptions) =>
			guarded(model, context, callOptions as CallOptions | undefined, ledger, log, maxChars, (ctx) => provider.streamSimple(model, ctx, callOptions)),
		stream: (model, context, callOptions) =>
			guarded(model, context, callOptions as CallOptions | undefined, ledger, log, maxChars, (ctx) => provider.stream(model, ctx, callOptions)),
	};
}
