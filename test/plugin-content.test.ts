import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { deflateSync } from "node:zlib";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { IMAGE_LIMITS } from "../src/extensions/images.ts";
import { LinkDoc } from "../src/core/ask.ts";
import { pluginResultContent } from "../src/core/plugin-content.ts";
import { conversationChannel } from "../src/core/threads.ts";
import { PluginContent } from "../src/plugins/types.ts";

const CRC = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});
function crc32(bytes: Uint8Array): number {
	let c = 0xffffffff;
	for (const byte of bytes) c = CRC[(c ^ byte) & 0xff]! ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Buffer {
	const head = Buffer.alloc(8);
	head.writeUInt32BE(data.byteLength, 0);
	head.write(type, 4, "ascii");
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
	return Buffer.concat([head, data, crc]);
}
/** An RGB PNG of random pixels (incompressible) or a flat colour, stored with filter 0 rows. */
function png(width: number, height: number, noise: boolean): string {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 2;
	const row = width * 3 + 1;
	const raw = noise ? randomBytes(row * height) : Buffer.alloc(row * height, 0x40);
	for (let y = 0; y < height; y++) raw[y * row] = 0;
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw, { level: 1 })), chunk("IEND", new Uint8Array()),
	]).toString("base64");
}
async function dimensions(base64: string) {
	const metadata = await new Bun.Image(Buffer.from(base64, "base64")).metadata();
	return [metadata.width, metadata.height];
}

describe("pluginResultContent", () => {
	test("strings and JSON values stay one text block", async () => {
		expect(await pluginResultContent("hi")).toEqual([{ type: "text", text: "hi" }]);
		expect(await pluginResultContent({ a: 1 })).toEqual([{ type: "text", text: '{"a":1}' }]);
		expect(await pluginResultContent(new PluginContent([]))).toEqual([{ type: "text", text: "" }]);
	});

	test("keeps block order and re-encodes a valid image at the same size", async () => {
		const content = await pluginResultContent(new PluginContent([
			{ type: "text", text: "before" }, { type: "image", mimeType: "image/png", data: png(30, 20, false) }, { type: "text", text: "after" },
		]));
		expect(content.map((block) => block.type)).toEqual(["text", "image", "text"]);
		expect(content[1]).toMatchObject({ mimeType: "image/png" });
		expect(await dimensions((content[1] as { data: string }).data)).toEqual([30, 20]);
	});

	test("an image over the byte limit becomes a JPEG with the same pixel dimensions", async () => {
		const data = png(1000, 800, true);
		expect(Buffer.byteLength(data, "base64")).toBeGreaterThan(IMAGE_LIMITS.maxBytes);
		const [image] = await pluginResultContent(new PluginContent([{ type: "image", mimeType: "image/png", data }]));
		expect(image).toMatchObject({ type: "image", mimeType: "image/jpeg" });
		expect(Buffer.byteLength((image as { data: string }).data, "base64")).toBeLessThanOrEqual(IMAGE_LIMITS.maxBytes);
		expect(await dimensions((image as { data: string }).data)).toEqual([1000, 800]);
	});

	test("an image too large even as JPEG is omitted with a reason, never resized", async () => {
		const [note] = await pluginResultContent(new PluginContent([{ type: "image", mimeType: "image/png", data: png(2400, 2000, true) }]));
		expect(note).toEqual({ type: "text", text: expect.stringMatching(/^\[image omitted: 2400x2000 image exceeds \d+ bytes even as JPEG/) });
	});

	test("invalid, empty, unsupported and too many images become notes", async () => {
		const valid = { type: "image", mimeType: "image/png", data: png(2, 2, false) } as const;
		const content = await pluginResultContent(new PluginContent([
			{ type: "image", mimeType: "image/png", data: Buffer.from("not an image").toString("base64") },
			{ type: "image", mimeType: "image/png", data: "" },
			{ type: "image", mimeType: "image/svg+xml", data: "PHN2Zy8+" },
			valid, valid, valid, valid, valid,
		]));
		expect(content.slice(0, 3)).toEqual([
			{ type: "text", text: "[image omitted: invalid image data]" },
			{ type: "text", text: "[image omitted: empty image data]" },
			{ type: "text", text: "[image omitted: unsupported image type image/svg+xml]" },
		]);
		expect(content.slice(3, 7).every((block) => block.type === "image")).toBe(true);
		expect(content[7]).toEqual({ type: "text", text: "[image omitted: one result carries at most 4 images]" });
	});
});

describe("conversationChannel", () => {
	const context = BACKGROUND_CONTEXT;
	/** A reader over a thread index and LinkDoc parents. */
	function reader(threads: Record<string, number>, parents: Record<number, number>) {
		return {
			snapshot: (async (token: unknown, ...rest: unknown[]) => {
				if (token === LinkDoc) {
					const parent = parents[rest[0] as number];
					return parent === undefined ? {} : { parent };
				}
				return { threads };
			}) as never,
		};
	}
	const id = (n: number) => n as ConversationId;

	test("top-level conversations map to the channel prefix of their thread key", async () => {
		const r = reader({ "tui:20261007-a": 1, "telegram:1:2:3:4": 2, "slack:C1-17.0001#1": 3 }, {});
		expect(await conversationChannel(r, id(1), context)).toBe("tui");
		expect(await conversationChannel(r, id(2), context)).toBe("telegram");
		expect(await conversationChannel(r, id(3), context)).toBe("slack");
		expect(await conversationChannel(r, id(9), context)).toBeUndefined();
	});

	test("subagents inherit the root's channel; cycles and unbound roots are undefined", async () => {
		expect(await conversationChannel(reader({ "tui:x": 1 }, { 5: 4, 4: 1 }), id(5), context)).toBe("tui");
		expect(await conversationChannel(reader({ "tui:x": 1 }, { 5: 6, 6: 5 }), id(5), context)).toBeUndefined();
		expect(await conversationChannel(reader({ "tui:x": 1 }, { 5: 7 }), id(5), context)).toBeUndefined();
		// At most 64 parent links: 100 -> ... -> 164 resolves, one more link does not.
		const chain = (links: number) => Object.fromEntries(Array.from({ length: links }, (_, n) => [100 + n, 101 + n]));
		expect(await conversationChannel(reader({ "tui:x": 164 }, chain(64)), id(100), context)).toBe("tui");
		expect(await conversationChannel(reader({ "tui:x": 165 }, chain(65)), id(100), context)).toBeUndefined();
	});
});
