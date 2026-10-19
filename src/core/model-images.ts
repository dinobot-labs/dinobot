import type { Provider } from "@earendil-works/pi-ai/models";
import { IMAGE_LIMITS } from "../extensions/images.ts";

/** A model's catalog image policy (`inputLimits.images.resize`) with every field resolved. */
export type ImageResizeProfile = {
	readonly maxWidth: number;
	readonly maxHeight: number;
	/** Maximum base64 payload length, exactly as the catalog states it. */
	readonly maxBytes: number;
	readonly jpegQuality: number;
};

/**
 * Profile for a model that accepts images but declares none. Anthropic caps every image of a many-image request
 * (more than 20 images) at 3000 px on the long side, and its documented vision budget is 2000 px, so an
 * undeclared model gets that ceiling instead of sending whatever size a screenshot happened to be.
 */
export const DEFAULT_IMAGE_RESIZE: ImageResizeProfile = Object.freeze({ maxWidth: 2000, maxHeight: 2000, maxBytes: 4718592, jpegQuality: 80 });

/** Bound the decode work: base64 longer than this is left alone rather than decoded. */
const MAX_SOURCE_BASE64 = 4 * Math.ceil((32 * 1024 * 1024) / 3);

type Json = Record<string, unknown>;
type PayloadHook = (payload: unknown, model: unknown) => unknown;
type ModelShape = {
	readonly input?: readonly string[];
	readonly inputLimits?: { readonly images?: { readonly resize?: Partial<ImageResizeProfile> } };
};

const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const limit = (value: unknown, fallback: number): number => typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;

/** The resize profile to apply before a request to `model`, or undefined when the model does not take images. */
export function imageResizeProfile(model: ModelShape | undefined): ImageResizeProfile | undefined {
	if (!model?.input?.includes("image")) return undefined;
	const resize = model.inputLimits?.images?.resize;
	return {
		maxWidth: limit(resize?.maxWidth, DEFAULT_IMAGE_RESIZE.maxWidth),
		maxHeight: limit(resize?.maxHeight, DEFAULT_IMAGE_RESIZE.maxHeight),
		maxBytes: limit(resize?.maxBytes, DEFAULT_IMAGE_RESIZE.maxBytes),
		jpegQuality: Math.min(100, limit(resize?.jpegQuality, DEFAULT_IMAGE_RESIZE.jpegQuality)),
	};
}

/** The re-encoded image when it exceeds the profile, or undefined when it already fits (or cannot be decoded). */
async function shrinkImage(data: string, profile: ImageResizeProfile): Promise<{ data: string; mimeType: string } | undefined> {
	if (data.length > MAX_SOURCE_BASE64) return undefined;
	const bytes = Buffer.from(data, "base64");
	if (bytes.byteLength === 0) return undefined;
	if (data.length <= profile.maxBytes) {
		try {
			const size = await new Bun.Image(bytes, { maxPixels: IMAGE_LIMITS.maxPixels }).metadata();
			if (size.width <= profile.maxWidth && size.height <= profile.maxHeight) return undefined;
		}
		catch {
			return undefined;
		}
	}
	try {
		const encoded = await new Bun.Image(bytes, { maxPixels: IMAGE_LIMITS.maxPixels })
			.resize(profile.maxWidth, profile.maxHeight, { fit: "inside", withoutEnlargement: true })
			.jpeg({ quality: profile.jpegQuality })
			.bytes();
		return encoded.byteLength === 0 ? undefined : { data: Buffer.from(encoded).toString("base64"), mimeType: "image/jpeg" };
	}
	catch {
		return undefined;
	}
}

/** A resized copy of one image block, or undefined when the block is not a base64 image or already fits. */
async function resizedBlock(block: Json, profile: ImageResizeProfile): Promise<Json | undefined> {
	if (block.type === "image") {
		const source = block.source;
		if (!isRecord(source) || source.type !== "base64" || typeof source.data !== "string") return undefined;
		const resized = await shrinkImage(source.data, profile);
		return resized === undefined ? undefined : { ...block, source: { ...source, media_type: resized.mimeType, data: resized.data } };
	}
	// openai-completions carries images as a data URL, which is still request bytes that can exceed the model's limits.
	if (block.type === "image_url" && isRecord(block.image_url) && typeof block.image_url.url === "string") {
		const dataUrl = /^data:([^;,]+);base64,([\s\S]+)$/.exec(block.image_url.url);
		const resized = dataUrl?.[2] === undefined ? undefined : await shrinkImage(dataUrl[2], profile);
		return resized === undefined ? undefined : { ...block, image_url: { ...block.image_url, url: `data:${resized.mimeType};base64,${resized.data}` } };
	}
	return undefined;
}

/** One content array, rebuilt only when a block changed, so an untouched payload keeps its exact objects. */
async function mapContent(blocks: unknown[], profile: ImageResizeProfile): Promise<unknown[]> {
	let changed = false;
	const mapped = await Promise.all(blocks.map(async (block): Promise<unknown> => {
		if (!isRecord(block)) return block;
		if (Array.isArray(block.content)) {
			const inner = await mapContent(block.content, profile);
			if (inner !== block.content) {
				changed = true;
				return { ...block, content: inner };
			}
		}
		const resized = await resizedBlock(block, profile);
		if (resized === undefined) return block;
		changed = true;
		return resized;
	}));
	return changed ? mapped : blocks;
}

/**
 * The payload with every base64 image resized to `profile`, or undefined when nothing had to change. Runs on the
 * payload just before it is sent: the same stored screenshot can be normalized for one model and left untouched
 * for another, and a re-sent image encodes to the same bytes every time (so prompt-cache prefixes stay stable).
 */
export async function normalizeRequestImages(payload: unknown, profile: ImageResizeProfile): Promise<unknown | undefined> {
	if (!isRecord(payload) || !Array.isArray(payload.messages)) return undefined;
	let changed = false;
	const messages = await Promise.all(payload.messages.map(async (message): Promise<unknown> => {
		if (!isRecord(message) || !Array.isArray(message.content)) return message;
		const content = await mapContent(message.content, profile);
		if (content === message.content) return message;
		changed = true;
		return { ...message, content };
	}));
	return changed ? { ...payload, messages } : undefined;
}

/** The provider with every request payload's images normalized to the target model's catalog resize profile, after any caller `onPayload`. */
export function withModelImageResize<P extends Provider>(provider: P): P {
	const wrap = <O>(options: O | undefined): O => {
		const own = (options as { onPayload?: PayloadHook } | undefined)?.onPayload;
		return {
			...options,
			onPayload: async (payload: unknown, model: unknown) => {
				const replaced = own ? await own(payload, model) : undefined;
				const profile = imageResizeProfile(model as ModelShape | undefined);
				if (profile === undefined) return replaced;
				return await normalizeRequestImages(replaced ?? payload, profile) ?? replaced;
			},
		} as O;
	};
	return {
		...provider,
		streamSimple: (model, context, options) => provider.streamSimple(model, context, wrap(options)),
		stream: (model, context, options) => provider.stream(model, context, wrap(options as never)),
	};
}
