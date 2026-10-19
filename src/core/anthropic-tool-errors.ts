import type { Provider } from "@earendil-works/pi-ai/models";

type Json = Record<string, unknown>;
type PayloadHook = (payload: unknown, model: unknown) => unknown;

const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (block: unknown): boolean => isRecord(block) && block.type === "text";
const isToolResult = (block: unknown): boolean => isRecord(block) && block.type === "tool_result";

/**
 * Anthropic rejects a `tool_result` with `is_error: true` whose content holds anything but text blocks
 * (400 "all content must be type `text` if `is_error` is true"), and pi-ai sends image-bearing tool results as
 * block arrays. One failed tool call that returned an image (for example a codemode cell that read screenshots and
 * then threw) would otherwise poison the transcript: every later request, including resume, is rejected.
 *
 * Keep the error flag and the text inside the tool_result and move its other blocks to just after the message's
 * tool_result blocks, where Anthropic accepts images. Returns `undefined` when the payload needs no change.
 */
export function anthropicToolErrorPayload(payload: unknown): unknown {
	if (!isRecord(payload) || !Array.isArray(payload.messages)) return undefined;
	let changed = false;
	const messages = payload.messages.map((message: unknown) => {
		if (!isRecord(message) || message.role !== "user" || !Array.isArray(message.content)) return message;
		const moved: unknown[] = [];
		const content = message.content.map((block: unknown) => {
			if (!isRecord(block) || block.type !== "tool_result" || block.is_error !== true || !Array.isArray(block.content)) return block;
			const others = block.content.filter(item => !isText(item));
			if (others.length === 0) return block;
			moved.push(...others);
			const note = { type: "text", text: `[${others.length} non-text block(s) of this failed tool result are attached after the tool results]` };
			return { ...block, content: [...block.content.filter(isText), note] };
		});
		if (moved.length === 0) return message;
		changed = true;
		const after = content.findLastIndex(isToolResult) + 1;
		return { ...message, content: [...content.slice(0, after), ...moved, ...content.slice(after)] };
	});
	return changed ? { ...payload, messages } : undefined;
}

/** The provider with every `anthropic-messages` payload passed through `anthropicToolErrorPayload`, after any caller `onPayload`. */
export function withAnthropicToolErrorText<P extends Provider>(provider: P): P {
	const wrap = <O>(options: O | undefined): O => {
		const own = (options as { onPayload?: PayloadHook } | undefined)?.onPayload;
		return {
			...options,
			onPayload: async (payload: unknown, model: { api?: string }) => {
				const replaced = own ? await own(payload, model) : undefined;
				if (model?.api !== "anthropic-messages") return replaced;
				return anthropicToolErrorPayload(replaced ?? payload) ?? replaced;
			},
		} as O;
	};
	return {
		...provider,
		streamSimple: (model, context, options) => provider.streamSimple(model, context, wrap(options)),
		stream: (model, context, options) => provider.stream(model, context, wrap(options as never)),
	};
}
