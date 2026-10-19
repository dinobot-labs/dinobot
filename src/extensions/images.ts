import { constants } from "node:fs";
import { open, opendir } from "node:fs/promises";
import { extname } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import { defineExtension, wrapTool } from "@earendil-works/pi-durable";
import { ok } from "@earendil-works/pi-durable/env";
import { createReadTool } from "@earendil-works/pi-durable/tools";

export const IMAGE_LIMITS = Object.freeze({ maxBytes: 2 * 1024 * 1024, maxPixels: 4096 * 4096, maxCellImages: 4, maxCellBytes: 8 * 1024 * 1024 });

export function imagePixelsFit(width: number, height: number): boolean {
	return Number.isSafeInteger(width) && Number.isSafeInteger(height) &&
		width > 0 && height > 0 && width <= Math.floor(IMAGE_LIMITS.maxPixels / height);
}

/** Checked in the same transaction as receipt insertion. Never partially admit one call's attachments. */
export function imageAttachmentsFit(images: readonly ImageContent[]): boolean {
	return images.length <= IMAGE_LIMITS.maxCellImages &&
		images.every((image) => image.data.length <= 4 * Math.ceil(IMAGE_LIMITS.maxBytes / 3) &&
			Buffer.byteLength(image.data, "base64") <= IMAGE_LIMITS.maxBytes) &&
		images.reduce((bytes, image) => bytes + Buffer.byteLength(image.data, "base64"), 0) <= IMAGE_LIMITS.maxCellBytes;
}

/** The image MIME type the magic bytes identify, or undefined; PNG/JPEG/GIF/WebP only. Exported for the TUI's file-path paste, which stages the same formats. */
export function imageMime(bytes: Uint8Array): string | undefined {
	const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
	if (b[0] === 255 && b[1] === 216 && b[2] === 255) return "image/jpeg";
	if (["GIF87a", "GIF89a"].includes(b.toString("ascii", 0, 6))) return "image/gif";
	if (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "image/webp";
	return undefined;
}

/** A directory is not readable as a file; name its first entries so the next call can pick one. */
async function directoryHint(path: string): Promise<string> {
	const limit = 40;
	const entries: string[] = [];
	const dir = await opendir(path);
	try {
		for await (const entry of dir) {
			if (entries.length === limit) break;
			entries.push(entry.isDirectory() ? `${entry.name}/` : entry.name);
		}
	} finally {
		await dir.close().catch(() => {});
	}
	entries.sort();
	const more = entries.length === limit ? ", …" : "";
	return `read requires a regular file; ${path} is a directory. Read one of its entries or list it with bash: ${entries.join(", ") || "(empty)"}${more}`;
}

/** Keep durable's path resolution and text reader, replacing only the binary image branch. */
export function imagesExtension() {
	return defineExtension({
		name: "images",
		wraps: [wrapTool(createReadTool(), (tool) => ({
			...tool,
			description: `${tool.description} Also view validated PNG/JPEG/GIF/WebP images (at most ${IMAGE_LIMITS.maxBytes} bytes and ${IMAGE_LIMITS.maxPixels} pixels). Images are whole-file only; GIF/animated WebP are shown as a still frame.`,
			replay: "safe",
			execute: async (args, api, context) => {
				if (!api.env) return tool.execute(args, api, context);
				const env = api.env;
				let image: ImageContent | undefined;
				const wrappedEnv = Object.create(env) as typeof env;
				wrappedEnv.readBinaryFile = async (path, ctx) => {
					ctx.abortSignal?.throwIfAborted();
					// The bot installs a local NodeExecutionEnv. Nonblocking open rejects special files without hanging.
					const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
					try {
						const stat = await file.stat();
						if (stat.isDirectory()) throw new Error(await directoryHint(path));
						if (!stat.isFile()) throw new Error("read requires a regular file");
						const prefix = Buffer.alloc(12);
						const { bytesRead } = await file.read(prefix, 0, prefix.length, 0);
						const mime = imageMime(prefix.subarray(0, bytesRead));
						if (!mime) {
							if (/^\.(png|jpe?g|gif|webp)$/i.test(extname(path))) throw new Error("Invalid image signature");
							return env.readBinaryFile(path, ctx);
						}
						if (args.offset !== undefined || args.limit !== undefined) throw new Error("Images do not support offset/limit");
						if ((await file.stat()).size > IMAGE_LIMITS.maxBytes) throw new Error(`Image exceeds ${IMAGE_LIMITS.maxBytes} byte limit`);
						// Read at most B+1, including when a file grows after stat.
						const bytes = Buffer.alloc(IMAGE_LIMITS.maxBytes + 1);
						let size = 0;
						while (size < bytes.length) {
							ctx.abortSignal?.throwIfAborted();
							const chunk = await file.read(bytes, size, bytes.length - size, size);
							if (!chunk.bytesRead) break;
							size += chunk.bytesRead;
						}
						if (size > IMAGE_LIMITS.maxBytes) throw new Error(`Image exceeds ${IMAGE_LIMITS.maxBytes} byte limit`);
						const decoder = new Bun.Image(bytes.subarray(0, size), { maxPixels: IMAGE_LIMITS.maxPixels });
						const metadata = await decoder.metadata();
						if (!imagePixelsFit(metadata.width, metadata.height)) throw new Error(`Image exceeds ${IMAGE_LIMITS.maxPixels} pixel limit or has invalid dimensions`);
						// Decode and re-encode, rather than accepting headers as evidence of a valid image.
						const png = await decoder.png().bytes();
						ctx.abortSignal?.throwIfAborted();
						if (png.byteLength > IMAGE_LIMITS.maxBytes) throw new Error(`Decoded image exceeds ${IMAGE_LIMITS.maxBytes} byte output limit`);
						image = { type: "image", mimeType: "image/png", data: Buffer.from(png).toString("base64") };
						return ok(new Uint8Array());
					} finally {
						await file.close();
					}
				};
				try {
					const result = await tool.execute(args, { ...api, env: wrappedEnv }, context);
					context.abortSignal?.throwIfAborted();
					return image ? { content: [image] } : result;
				} catch (error) {
					context.abortSignal?.throwIfAborted();
					return { isError: true, content: [{ type: "text", text: `read failed: ${error instanceof Error ? error.message : String(error)}` }] };
				}
			},
		}))],
	});
}
