import type { UserInput } from "@earendil-works/pi-durable";
import type { InboundMessage } from "../channels/types.ts";
import { inboundToImageContent } from "./message-images.ts";

/**
 * The one place that frames a channel message as model input: a `<from>` header naming the sender, then the text.
 * `parseInput` is its inverse for clients that show queued input back to the person who wrote it.
 */
export function formatInput(message: Pick<InboundMessage, "userId" | "channel" | "text">): string {
	return `<from user="${message.userId}" channel="${message.channel}"/>\n${message.text}`;
}

/**
 * The submit content of a channel message: the plain string header exactly as before when no images
 * ride along, and otherwise that same header as one text block followed by the image blocks. Keeping
 * the string form for text-only messages preserves every existing reader of input content byte-for-byte:
 * `parseInput`, the queue's header split, the search index's sender tag and durable history.
 */
export function formatInputContent(message: Pick<InboundMessage, "userId" | "channel" | "text" | "images">): UserInput {
	const header = formatInput(message);
	const images = message.images ?? [];
	if (images.length === 0) return header;
	return [{ type: "text", text: header }, ...images.map(inboundToImageContent)];
}

const HEADER = /^<from user="(.*?)" channel="(.*?)"\/>\n/s;

/** The sender and original text of a `formatInput` value; `undefined` for input framed some other way. */
export function parseInput(content: string): { userId: string; channel: string; text: string } | undefined {
	const match = HEADER.exec(content);
	if (!match) return undefined;
	return { userId: match[1] ?? "", channel: match[2] ?? "", text: content.slice(match[0].length) };
}
