import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { IMAGE_LIMITS, imagePixelsFit } from "../extensions/images.ts";
import { PluginContent, type PluginContentBlock } from "../plugins/types.ts";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** Bound the decode work for one block: base64 longer than this is refused before decoding. */
const MAX_SOURCE_BASE64 = 4 * Math.ceil((32 * 1024 * 1024) / 3);

export type ModelContent = TextContent | ImageContent;

/**
 * Turn a plugin tool's return value into model content. Strings and JSON values stay one text block, as before.
 * A {@link PluginContent} keeps its block order; each image is decoded, size-checked and re-encoded at the same
 * pixel dimensions (coordinates a driver reports for the image stay valid), or replaced by a text note saying
 * why it was omitted. Postcondition: every returned image satisfies the shared message image limits and at most
 * `IMAGE_LIMITS.maxCellImages` images are returned.
 */
export async function pluginResultContent(value: unknown): Promise<ModelContent[]> {
	if (!(value instanceof PluginContent)) return [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }];
	const content: ModelContent[] = [];
	let images = 0;
	for (const block of value.blocks) {
		if (block.type === "text") {
			content.push({ type: "text", text: block.text });
			continue;
		}
		if (images >= IMAGE_LIMITS.maxCellImages) {
			content.push({ type: "text", text: `[image omitted: one result carries at most ${IMAGE_LIMITS.maxCellImages} images]` });
			continue;
		}
		const image = await modelImage(block);
		if (typeof image === "string") content.push({ type: "text", text: `[image omitted: ${image}]` });
		else {
			content.push(image);
			images++;
		}
	}
	return content.length > 0 ? content : [{ type: "text", text: "" }];
}

/** A valid, limit-respecting image, or the reason it cannot be shown. Never resizes. */
async function modelImage(block: Extract<PluginContentBlock, { type: "image" }>): Promise<ImageContent | string> {
	if (!IMAGE_TYPES.has(block.mimeType)) return `unsupported image type ${block.mimeType}`;
	if (block.data.length > MAX_SOURCE_BASE64) return "image data is too large to decode";
	const bytes = Buffer.from(block.data, "base64");
	if (bytes.byteLength === 0) return "empty image data";
	try {
		const metadata = await new Bun.Image(bytes, { maxPixels: IMAGE_LIMITS.maxPixels }).metadata();
		if (!imagePixelsFit(metadata.width, metadata.height)) return `${metadata.width}x${metadata.height} exceeds the ${IMAGE_LIMITS.maxPixels} pixel limit`;
		const encode = (format: "png" | "jpeg") => {
			const image = new Bun.Image(bytes, { maxPixels: IMAGE_LIMITS.maxPixels });
			return (format === "png" ? image.png() : image.jpeg({ quality: 85 })).bytes();
		};
		let format: "png" | "jpeg" = block.mimeType === "image/jpeg" ? "jpeg" : "png";
		let encoded = await encode(format);
		if (encoded.byteLength > IMAGE_LIMITS.maxBytes && format === "png") {
			format = "jpeg";
			encoded = await encode(format);
		}
		if (encoded.byteLength > IMAGE_LIMITS.maxBytes) {
			return `${metadata.width}x${metadata.height} image exceeds ${IMAGE_LIMITS.maxBytes} bytes even as JPEG; request a smaller image`;
		}
		return { type: "image", mimeType: `image/${format}`, data: Buffer.from(encoded).toString("base64") };
	} catch {
		return "invalid image data";
	}
}
