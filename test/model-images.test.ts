import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBotModels } from "../src/auth/index.ts";
import { openCredentialFile } from "../src/auth/store.ts";
import { DEFAULT_IMAGE_RESIZE, imageResizeProfile, normalizeRequestImages } from "../src/core/model-images.ts";

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PROFILE = { maxWidth: 2000, maxHeight: 2000, maxBytes: 4718592, jpegQuality: 80 };

/** A PNG of the given size, the shape a full-page browser screenshot has. */
async function png(width: number, height: number): Promise<string> {
	const bytes = await new Bun.Image(Buffer.from(TINY_PNG, "base64")).resize(width, height).png().bytes();
	return Buffer.from(bytes).toString("base64");
}

const size = async (data: string) => await new Bun.Image(Buffer.from(data, "base64")).metadata();
const anthropicBlock = (data: string) => ({ type: "image", source: { type: "base64", media_type: "image/png", data } });

test("a model that declares no resize profile still gets the default ceiling, and a text-only model none", () => {
	expect(imageResizeProfile({ input: ["text"] })).toBeUndefined();
	expect(imageResizeProfile(undefined)).toBeUndefined();
	expect(imageResizeProfile({ input: ["text", "image"] })).toEqual(DEFAULT_IMAGE_RESIZE);
	expect(imageResizeProfile({ input: ["text", "image"], inputLimits: { images: { resize: { maxWidth: 1568 } } } }))
		.toEqual({ ...DEFAULT_IMAGE_RESIZE, maxWidth: 1568 });
});

test("the catalog profile of the model that hit Anthropic's many-image cap is the one applied", async () => {
	const dir = await mkdtemp(join(tmpdir(), "dinobot-model-images-")); dirs.push(dir);
	const models = createBotModels({ credentials: openCredentialFile(dir) });
	expect(imageResizeProfile(models.getModel("anthropic", "claude-opus-5-5") as never))
		.toEqual({ maxWidth: 2000, maxHeight: 2000, maxBytes: 4718592, jpegQuality: 80 });
	expect(imageResizeProfile(models.getModel("zai", "glm-4.7") as never)).toBeUndefined();
});

test("an oversized image is resized inside the profile, an image inside it is left byte-for-byte alone", async () => {
	const tall = await png(2400, 900);
	const small = await png(100, 100);
	const original = { model: "m", messages: [{ role: "user", content: "hi" }, { role: "assistant", content: [{ type: "text", text: "look" }] }, { role: "user", content: [{ type: "tool_result", tool_call_id: "t", content: [anthropicBlock(tall), anthropicBlock(small)] }] }] };
	const before = structuredClone(original);
	const fixed = await normalizeRequestImages(original, PROFILE) as { messages: { content: unknown }[] };
	expect(fixed).not.toBe(original);
	const inner = ((fixed.messages[2]?.content as { content?: { source?: { media_type: string; data: string } }[] }[])[0]?.content) ?? [];
	expect(inner[0]?.source?.media_type).toBe("image/jpeg");
	const resized = await size(inner[0]!.source!.data);
	expect(Math.max(resized.width, resized.height)).toBe(2000);
	expect(resized.width / resized.height).toBeCloseTo(2400 / 900, 1);
	// The small image already fits: untouched bytes keep the prompt cache prefix stable.
	expect(inner[1]?.source?.media_type).toBe("image/png");
	expect(inner[1]?.source?.data).toBe(small);
	// The caller's payload is not mutated, and a payload that already fits reports no change.
	expect(original).toEqual(before);
	expect(await normalizeRequestImages(structuredClone(original), { ...PROFILE, maxWidth: 4096, maxHeight: 4096 })).toBeUndefined();
});

test("images over the byte budget, openai data URLs and undecodable data are handled without breaking the request", async () => {
	const wide = await png(300, 200);
	const overBytes = await normalizeRequestImages({ messages: [{ role: "user", content: [anthropicBlock(wide)] }] }, { ...PROFILE, maxBytes: 64 }) as { messages: { content: { source: { media_type: string } }[] }[] };
	expect(overBytes.messages[0]?.content[0]?.source.media_type).toBe("image/jpeg");

	const openai = await normalizeRequestImages({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${await png(2400, 1200)}` } }] }] }, PROFILE) as { messages: { content: { image_url: { url: string } }[] }[] };
	const url = openai.messages[0]?.content[0]?.image_url.url ?? "";
	expect(url.startsWith("data:image/jpeg;base64,")).toBe(true);
	expect((await size(url.split(",")[1] ?? "")).height).toBe(1000);

	// A block that cannot be decoded is left as the caller built it instead of failing the whole request.
	expect(await normalizeRequestImages({ messages: [{ role: "user", content: [anthropicBlock("iVBORw0KGgo=")] }] }, PROFILE)).toBeUndefined();
	expect(await normalizeRequestImages({ messages: [] }, PROFILE)).toBeUndefined();
	expect(await normalizeRequestImages({ input: [] }, PROFILE)).toBeUndefined();
});

/** Every request body the bot's real anthropic provider would send, captured instead of sent. */
async function sentBody(content: unknown[]): Promise<{ messages: { role: string; content: unknown }[] }> {
	const saved = process.env.ANTHROPIC_API_KEY;
	delete process.env.ANTHROPIC_API_KEY;
	try {
		const dir = await mkdtemp(join(tmpdir(), "dinobot-model-images-")); dirs.push(dir);
		const credentials = openCredentialFile(dir);
		await credentials.addAccount("anthropic", { type: "api_key", key: "sk-ant-test" });
		const models = createBotModels({ credentials });
		const model = models.getModel("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("missing anthropic/claude-opus-5-5");
		const bodies: string[] = [];
		const fetch = (async (_url: unknown, init?: RequestInit) => {
			bodies.push(String(init?.body));
			return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "captured" } }), { status: 400, headers: { "content-type": "application/json" } });
		}) as unknown as typeof globalThis.fetch;
		const stream = models.streamSimple(model, {
			messages: [
				{ role: "user", content: "look", timestamp: 1 },
				{
					role: "assistant", content: [{ type: "toolCall", id: "toolu_1", name: "codemode", arguments: {} }],
					api: "anthropic-messages", provider: "anthropic", model: model.id, stopReason: "toolUse", timestamp: 2,
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				},
				{ role: "toolResult", toolCallId: "toolu_1", toolName: "codemode", isError: false, timestamp: 3, content },
			],
		} as never, { fetch, maxRetries: 0 } as never);
		await stream.result();
		const body = bodies[0];
		if (body === undefined) throw new Error("no request was sent");
		return JSON.parse(body);
	} finally {
		if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
	}
}

test("a tall screenshot in a tool result leaves the bot as a 2000 px JPEG", async () => {
	const body = await sentBody([{ type: "text", text: "screenshot" }, { type: "image", mimeType: "image/png", data: await png(1200, 4200) }]);
	type SentBlock = { type: string; source?: { media_type: string; data: string }; content?: SentBlock[] };
	const blocks = body.messages.flatMap(message => Array.isArray(message.content) ? message.content as SentBlock[] : []);
	const image = blocks.find(block => block.type === "tool_result")?.content?.find(block => block.type === "image");
	if (!image?.source) throw new Error("no image in the request");
	expect(image.source.media_type).toBe("image/jpeg");
	const resized = await size(image.source.data);
	expect(Math.max(resized.width, resized.height)).toBe(2000);
	expect(resized.width / resized.height).toBeCloseTo(1200 / 4200, 1);
});
