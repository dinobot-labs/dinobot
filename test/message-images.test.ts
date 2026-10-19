import { describe, expect, test } from "bun:test";
import type { UserMessage } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import type { InboundImage } from "../src/channels/types.ts";
import { httpChannel } from "../src/channels/http.ts";
import { base64Bytes, parseInboundImages } from "../src/core/message-images.ts";
import { formatInput, formatInputContent, parseInput } from "../src/core/input.ts";
import { queuedInputs } from "../src/core/queue.ts";
import { entryText } from "../src/core/search.ts";
import { parseSend } from "../src/api/server.ts";
import { ApiClient } from "../src/tui/client.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]).toString("base64");
/** Exactly 2 MiB decoded: 699050 full groups (2097150 bytes) plus a padded "xx=" group (2 bytes). */
const LIMIT = "A".repeat(2796203) + "=";
/** One byte over the per-image limit: 699051 full groups with no padding. */
const OVER = "A".repeat(2796204);
const image = (data = PNG, mimeType = "image/png"): InboundImage => ({ mimeType, data });

describe("message images", () => {
	test("images submit as header text plus image content blocks and text-only input stays a string", async () => {
		const withImages = formatInputContent({ userId: "roach", channel: "tui", text: "look at this", images: [image()] });
		expect(Array.isArray(withImages)).toBe(true);
		const blocks = withImages as { type: string; text?: string; mimeType?: string; data?: string }[];
		expect(blocks[0]).toEqual({ type: "text", text: formatInput({ userId: "roach", channel: "tui", text: "look at this" }) });
		expect(blocks.slice(1)).toEqual([{ type: "image", mimeType: "image/png", data: PNG }]);

		const textOnly = formatInputContent({ userId: "roach", channel: "tui", text: "plain" });
		expect(textOnly).toBe(formatInput({ userId: "roach", channel: "tui", text: "plain" }));

		// The wire: client.send carries the images, and omits the field without them.
		const bodies: unknown[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1", port: 0,
			fetch: async (request) => {
				bodies.push(await request.json());
				return Response.json({ submissionId: 1 });
			},
		});
		try {
			const client = new ApiClient(new URL(`http://127.0.0.1:${server.port}`));
			await client.send("tui", "main", "with image", "roach", undefined, [image()]);
			await client.send("tui", "main", "text only", "roach");
			expect(bodies[0]).toEqual({ text: "with image", userId: "roach", images: [image()] });
			expect(bodies[1]).toEqual({ text: "text only", userId: "roach" });
		} finally {
			await server.stop();
		}
	});

	test("parseSend accepts valid images and rejects invalid ones with a reason", () => {
		const base = { text: "hi", userId: "roach" };
		expect(parseSend({ ...base, images: [image()] })).toMatchObject({ images: [image()] });
		expect(parseSend({ ...base })).toMatchObject({ images: [] });
		// An image-only message needs no text; a text-less message without images is still rejected.
		expect(parseSend({ text: "", images: [image()] })).toMatchObject({ images: [image()] });
		expect(parseSend({ text: "", userId: "roach" })).toBe("text must be a non-empty string");
		// Wrong mime, invalid base64.
		expect(parseSend({ ...base, images: [image(PNG, "image/bmp")] })).toBe("images[0].mimeType must be one of image/png, image/jpeg, image/gif, image/webp");
		expect(parseSend({ ...base, images: [image("not base64!")] })).toBe("images[0].data must be canonical base64");
		// Boundary math: exactly 2 MiB passes, one byte over does not; the 4-image cap binds first
		// (4 x 2 MiB = the 8 MiB total exactly), so the total bound is defense in depth.
		expect(base64Bytes(LIMIT)).toBe(2 * 1024 * 1024);
		expect(base64Bytes(OVER)).toBe(2 * 1024 * 1024 + 1);
		expect(parseSend({ ...base, images: [image(LIMIT)] })).toMatchObject({ images: [image(LIMIT)] });
		expect(parseSend({ ...base, images: [image(OVER)] })).toBe("images[0] is 2.0 MiB; the per-image limit is 2.0 MiB");
		expect(parseSend({ ...base, images: [image(), image(), image(), image(), image()] })).toBe("at most 4 images per message");
		expect(parseSend({ text: "", images: [image(LIMIT), image(LIMIT), image(LIMIT), image(LIMIT)] })).toMatchObject({ images: { length: 4 } });
	});

	test("the text-only pipeline is unchanged end to end", async () => {
		// formatInput/parseInput round-trip.
		const formatted = formatInput({ userId: "u1", channel: "slack", text: "hello\nworld" });
		expect(parseInput(formatted)).toEqual({ userId: "u1", channel: "slack", text: "hello\nworld" });
		// Rich input degrades to display text in the queue.
		const queued = queuedInputs({
			items: [
				{ id: 1, mode: "followUp" as const, content: formatInputContent({ userId: "u1", channel: "tui", text: "see", images: [image()] }) },
				{ id: 2, mode: "steer" as const, content: formatInput({ userId: "u2", channel: "tui", text: "words" }) },
			],
		} as Parameters<typeof queuedInputs>[0]);
		expect(queued[0]?.text).toBe("see\n[image]");
		expect(queued[0]?.userId).toBe("u1");
		expect(queued[1]?.text).toBe("words");
		// The search index keeps the sender tag on rich input.
		const entry = {
			id: "e1", conversationId: 1, kind: "pi.user",
			model: [{
				role: "user", timestamp: 1,
				content: [{ type: "text", text: formatInput({ userId: "U1", channel: "tui", text: "find this" }) }, { type: "image", mimeType: "image/png", data: PNG }],
			} as UserMessage],
		} as unknown as EntryRecord;
		expect(entryText(entry)).toEqual({ role: "user", text: "U1: find this", at: 1 });
		// The http channel keeps rejecting text-less messages without images and accepts image-only ones.
		const channel = httpChannel(0);
		const received: unknown[] = [];
		await channel.start(async (message) => {
			received.push(message);
			return { status: "answered" as const, text: "ok" };
		});
		try {
			const url = channel.url();
			const post = async (body: unknown): Promise<Response> => fetch(new URL("/v1/messages", url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
			expect((await post({ threadKey: "t", messageId: "m1", userId: "u", text: "" })).status).toBe(400);
			const ok = await post({ threadKey: "t", messageId: "m2", userId: "u", text: "", images: [image()] });
			expect(ok.status).toBe(200);
			expect(received[0]).toMatchObject({ images: [image()] });
			const bad = await post({ threadKey: "t", messageId: "m3", userId: "u", text: "x", images: [{ mimeType: "image/tiff", data: PNG }] });
			expect(bad.status).toBe(400);
			expect(await bad.json()).toEqual({ error: "images[0].mimeType must be one of image/png, image/jpeg, image/gif, image/webp" });
		} finally {
			await channel.stop();
		}
	});

	test("parseInboundImages and base64Bytes agree on the boundary math", () => {
		expect(base64Bytes(PNG)).toBe(12);
		expect(base64Bytes("AAAA")).toBe(3);
		expect(base64Bytes("")).toBeUndefined();
		expect(base64Bytes("A=")).toBeUndefined();
		expect(parseInboundImages(undefined)).toEqual([]);
		expect(parseInboundImages("nope")).toBe("images must be an array");
	});
});
