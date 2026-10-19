import type { ImageContent } from "@earendil-works/pi-ai";
import type { InboundImage } from "../channels/types.ts";

/**
 * The one authority on message image bounds, shared by every entry point: the TUI composer's
 * pre-check, the client API's `parseSend` and the channel-neutral http `parseMessage`. The
 * numbers deliberately mirror `IMAGE_LIMITS` of the codemode cell contract (extensions/images.ts)
 * so one mental model covers both surfaces, but the contracts stay separate: a cell and a
 * message are different admission points and may drift independently.
 */
export const MESSAGE_IMAGE_LIMITS = Object.freeze({
	maxImages: 4,
	maxBytesPerImage: 2 * 1024 * 1024,
	maxTotalBytes: 8 * 1024 * 1024,
});

export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type MessageImageMime = (typeof IMAGE_MIME_TYPES)[number];

/** Preferred order when a clipboard or selection offers several image formats: lossless first. */
export const IMAGE_MIME_PRIORITY: readonly MessageImageMime[] = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/** The first priority mime the offer list contains, or undefined when it names no supported image format. */
export function chooseImageMime<T extends string>(offered: readonly T[]): MessageImageMime | undefined {
	for (const mime of IMAGE_MIME_PRIORITY) if (offered.includes(mime as T)) return mime;
	return undefined;
}

/**
 * Decoded byte length of canonical base64, or undefined for any other shape. Padding must be
 * present-and-canonical: our own client always emits `Buffer.toString("base64")`, so accepting
 * non-canonical encodings here would only widen what an attacker may smuggle past the bounds.
 */
export function base64Bytes(data: string): number | undefined {
	if (data.length === 0 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return undefined;
	const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
	return (data.length / 4) * 3 - padding;
}

const humanSize = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;

/**
 * Validate an untrusted `images` field into `InboundImage`s, or name the first violation.
 * Total bytes are checked incrementally so rejection never depends on later entries.
 */
export function parseInboundImages(field: unknown): readonly InboundImage[] | string {
	if (field === undefined) return [];
	if (!Array.isArray(field)) return "images must be an array";
	if (field.length === 0) return [];
	if (field.length > MESSAGE_IMAGE_LIMITS.maxImages) {
		return `at most ${MESSAGE_IMAGE_LIMITS.maxImages} images per message`;
	}
	let total = 0;
	const images: InboundImage[] = [];
	for (const [index, item] of field.entries()) {
		if (typeof item !== "object" || item === null) return `images[${index}] must be an object`;
		const { mimeType, data } = item as Record<string, unknown>;
		if (typeof mimeType !== "string" || !IMAGE_MIME_TYPES.includes(mimeType as MessageImageMime)) {
			return `images[${index}].mimeType must be one of ${IMAGE_MIME_TYPES.join(", ")}`;
		}
		if (typeof data !== "string") return `images[${index}].data must be a base64 string`;
		const bytes = base64Bytes(data);
		if (bytes === undefined) return `images[${index}].data must be canonical base64`;
		if (bytes === 0) return `images[${index}].data is empty`;
		if (bytes > MESSAGE_IMAGE_LIMITS.maxBytesPerImage) {
			return `images[${index}] is ${humanSize(bytes)}; the per-image limit is ${humanSize(MESSAGE_IMAGE_LIMITS.maxBytesPerImage)}`;
		}
		total += bytes;
		if (total > MESSAGE_IMAGE_LIMITS.maxTotalBytes) {
			return `images total ${humanSize(total)}; the limit is ${humanSize(MESSAGE_IMAGE_LIMITS.maxTotalBytes)}`;
		}
		images.push({ mimeType, data });
	}
	return images;
}

/** Why `next` cannot join `staged`, or undefined when it can. The composer's UX mirror of `parseInboundImages`. */
export function attachmentRejection(staged: readonly InboundImage[], next: InboundImage): string | undefined {
	if (staged.length >= MESSAGE_IMAGE_LIMITS.maxImages) {
		return `at most ${MESSAGE_IMAGE_LIMITS.maxImages} images per message`;
	}
	const bytes = base64Bytes(next.data);
	if (bytes === undefined || bytes === 0) return "clipboard image is not valid base64";
	if (bytes > MESSAGE_IMAGE_LIMITS.maxBytesPerImage) {
		return `image is ${humanSize(bytes)}; the per-image limit is ${humanSize(MESSAGE_IMAGE_LIMITS.maxBytesPerImage)}`;
	}
	const total = staged.reduce((sum, image) => sum + (base64Bytes(image.data) ?? 0), bytes);
	if (total > MESSAGE_IMAGE_LIMITS.maxTotalBytes) {
		return `images total ${humanSize(total)}; the limit is ${humanSize(MESSAGE_IMAGE_LIMITS.maxTotalBytes)}`;
	}
	return undefined;
}

/** The channel image as model content; validation has already happened at admission. */
export function inboundToImageContent(image: InboundImage): ImageContent {
	return { type: "image", mimeType: image.mimeType, data: image.data };
}
