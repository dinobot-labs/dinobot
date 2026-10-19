import { afterEach, expect, test } from "bun:test";
import { mkdtemp, writeFile, rm, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context, withCancel } from "@earendil-works/chord/context";
import type { Message, ImageContent } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { LiveDoc, MemoryStorage, type JsonObject, type Storage, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createReadTool } from "@earendil-works/pi-durable/tools";
import { openBot, type Bot } from "../src/core/bot.ts";
import type { ToolMode } from "../src/core/toolmode.ts";
import { IMAGE_LIMITS, imageAttachmentsFit, imagePixelsFit, imagesExtension } from "../src/extensions/images.ts";
import { CellDoc } from "../src/core/codemode/calls.ts";
import type { LoadedPlugin } from "../src/plugins/types.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aW1sAAAAASUVORK5CYII=", "base64");
const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const bots: Bot[] = [];
const dirs: string[] = [];
afterEach(async () => {
	for (const bot of bots.splice(0)) await bot.close(context);
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function directory() {
	const cwd = await mkdtemp(join(tmpdir(), "dinobot-images-"));
	dirs.push(cwd);
	await writeFile(join(cwd, "image.png"), png);
	return cwd;
}
function images(messages: readonly Message[]): ImageContent[] {
	return messages.flatMap((message) => message.role === "toolResult" ? message.content.filter((block) => block.type === "image") : []);
}
async function setup(cwd: string, mode: ToolMode = "codemode-only", storage: Storage = new MemoryStorage(), plugins: LoadedPlugin[] = []) {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "one", input: ["text", "image"] }] });
	const models = createModels();
	models.setProvider(faux.provider);
	const bot = await openBot({ storage, models, defaultModel: { provider: "faux", modelId: "one" }, toolMode: mode, plugins, workspaceRoot: cwd }, context);
	bots.push(bot);
	const conversation = await bot.conversation("test", "images", context);
	return { bot, conversation, faux, async run(name: string, args: JsonObject) {
		let next: readonly Message[] = [];
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" }),
			(request) => { next = request.messages; return fauxAssistantMessage("done"); },
		]);
		await (await conversation.submit({ type: "input", content: "view" }, context)).wait(context);
		return { next, result: next.filter((message) => message.role === "toolResult").at(-1)! };
	} };
}

for (const mode of ["direct", "hybrid", "codemode-only"] as const) {
	test(`${mode}: next model request contains real image blocks, not base64 text`, async () => {
		const { run } = await setup(await directory(), mode);
		const { next, result } = await run(mode === "direct" ? "read" : "codemode", mode === "direct" ? { path: "image.png" } : { code: 'text(await tools.read({path:"image.png"}));' });
		expect(result.isError).not.toBe(true);
		expect(images(next)).toHaveLength(1);
		const image = images(next)[0]!;
		expect(image.mimeType).toBe("image/png");
		expect((await new Bun.Image(Buffer.from(image.data, "base64")).metadata()).width).toBe(1);
		expect(result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n")).not.toContain(image.data);
	});
}

test("JPEG, GIF, WebP and extensionless images decode; cwd changes apply; text offset remains unchanged", async () => {
	const cwd = await directory();
	await writeFile(join(cwd, "a.jpg"), await new Bun.Image(png).jpeg().bytes());
	await writeFile(join(cwd, "a.webp"), await new Bun.Image(png).webp().bytes());
	await writeFile(join(cwd, "a.gif"), gif);
	await writeFile(join(cwd, "no-extension"), png);
	await writeFile(join(cwd, "text.txt"), "one\ntwo\nthree");
	const { run, conversation } = await setup(await directory(), "direct");
	await conversation.configure({ cwd }, context);
	for (const path of ["a.jpg", "a.webp", "a.gif", "no-extension"]) {
		const { result } = await run("read", { path });
		expect(result.isError).not.toBe(true);
		expect(result.content.filter((block) => block.type === "image")).toHaveLength(1);
	}
	const { result } = await run("read", { path: "text.txt", offset: 2, limit: 1 });
	expect(result.content[0]).toEqual({ type: "text", text: "two" });
});

test("malformed, truncated, oversized and line-selected images fail without image content", async () => {
	const cwd = await directory();
	await writeFile(join(cwd, "bad.png"), "not an image");
	await writeFile(join(cwd, "truncated.png"), png.subarray(0, 30));
	await writeFile(join(cwd, "big.png"), png);
	await truncate(join(cwd, "big.png"), IMAGE_LIMITS.maxBytes + 1);
	const { run } = await setup(cwd, "direct");
	for (const args of [{ path: "bad.png" }, { path: "truncated.png" }, { path: "big.png" }, { path: "image.png", limit: 1 }]) {
		const { result } = await run("read", args);
		expect(result.isError).toBe(true);
		expect(result.content.some((block) => block.type === "image")).toBe(false);
		expect(JSON.stringify(result.content)).toContain("read failed:");
	}
});

test("codemode attaches once in ordinal order, persists host receipts, bounds aggregate and keeps images on cell failure", async () => {
	const cwd = await directory();
	for (let i = 1; i <= 5; i++) await writeFile(join(cwd, `${i}.png`), await new Bun.Image(png).resize(i, 1).png().bytes());
	const { run, bot, conversation } = await setup(cwd);
	const { result } = await run("codemode", { code: 'await Promise.all(Array.from({length:5},(_,i)=>tools.read({path:`${i+1}.png`}))); throw new Error("after images");' });
	expect(result.isError).toBe(true);
	expect(result.content.filter((block) => block.type === "image")).toHaveLength(IMAGE_LIMITS.maxCellImages);
	expect(JSON.stringify(result.content.filter((block) => block.type === "text"))).toContain("attachment limit");
	const taskId = (result.details as { codemodeTaskId: number }).codemodeTaskId;
	const doc = await bot.harness.snapshot(CellDoc, conversation.id, String(taskId), context);
	const retained = doc!.calls.slice().sort((a, b) => a.ordinal - b.ordinal).flatMap((call) => call.images ?? []);
	expect(result.content.filter((block) => block.type === "image")).toEqual(retained);
	expect(retained).toHaveLength(4);
	const widths = await Promise.all(retained.map(async (image) => (await new Bun.Image(Buffer.from(image.data, "base64")).metadata()).width));
	expect(new Set(widths).size).toBe(4);
	expect(widths).toEqual(widths.slice().sort((a, b) => a - b));
	for (const call of doc!.calls) {
		for (const image of call.images ?? []) expect(call.result).not.toContain(image.data);
	}
});

test("SQLite restart preserves image bytes and delivers them in the next model input without rereading files", async () => {
	const cwd = await directory();
	const db = join(cwd, "state.sqlite");
	const first = await setup(cwd, "codemode-only", await openNodeSqliteStorage(db));
	const before = images((await first.run("codemode", { code: 'await tools.read({path:"image.png"});' })).next);
	await first.bot.close(context); bots.splice(bots.indexOf(first.bot), 1);
	await rm(join(cwd, "image.png"));
	const second = await setup(cwd, "codemode-only", await openNodeSqliteStorage(db));
	let after: ImageContent[] = [];
	second.faux.setResponses([(request) => { after = images(request.messages); return fauxAssistantMessage("still visible"); }]);
	await (await second.conversation.submit({ type: "input", content: "describe again" }, context)).wait(context);
	expect(after).toEqual(before);
	expect(after).toHaveLength(1);
});

test("pre-cancelled image reads reject instead of returning successful content", async () => {
	const cwd = await directory();
	const wrapper = imagesExtension().wraps![0]!;
	if (!("tool" in wrapper)) throw new Error("Expected read wrapper");
	const read = wrapper.wrap(createReadTool());
	const cancelled = withCancel(context);
	cancelled.cancel(new Error("cancel image"));
	await expect(read.execute({ path: "image.png" }, { env: new NodeExecutionEnv({ cwd }) } as unknown as ToolExecutionApi, cancelled.context)).rejects.toThrow();
});

test("abort after image receipt commit survives SQLite reopen and explicit status recovery", async () => {
	const cwd = await directory();
	const db = join(cwd, "aborted.sqlite");
	const entered = Promise.withResolvers<void>();
	const first = await setup(cwd, "codemode-only", await openNodeSqliteStorage(db), [{
		id: "image_barrier",
		tools: [{
			name: "image_barrier_wait",
			description: "Hold the cell after its image read has settled",
			inputSchema: { type: "object", properties: {} },
			execute: async () => {
				entered.resolve();
				return new Promise(() => {});
			},
		}],
	}]);
	first.faux.setResponses([fauxAssistantMessage(fauxToolCall("codemode", {
		code: 'await tools.read({path:"image.png"}); await tools.image_barrier_wait({});',
	}), { stopReason: "toolUse" })]);
	const submission = await first.conversation.submit({ type: "input", content: "read and hold" }, context);
	await entered.promise;
	// The awaited read returned only after its receipt transaction committed.
	const live = await first.bot.harness.snapshot(LiveDoc, first.conversation.id, context);
	const taskId = live!.tools!.find((slot) => slot.name === "codemode")!.taskId;
	expect(taskId).toBeDefined();
	const committed = await first.bot.harness.snapshot(CellDoc, first.conversation.id, String(taskId), context);
	const before = committed!.calls.flatMap((call) => call.images ?? []);
	expect(before).toHaveLength(1);
	expect(committed!.calls.find((call) => call.name === "read")!.status).toBe("done");
	await first.conversation.abort(context);
	expect((await submission.wait(context)).status).toBe("unanswered");
	expect(images((await first.conversation.context(context)).messages)).toHaveLength(0);
	await first.bot.close(context); bots.splice(bots.indexOf(first.bot), 1);
	await rm(join(cwd, "image.png"));
	const second = await setup(cwd, "codemode-only", await openNodeSqliteStorage(db));
	const restored = await second.bot.harness.snapshot(CellDoc, second.conversation.id, String(taskId), context);
	expect(restored!.calls.flatMap((call) => call.images ?? [])).toEqual(before);
	const recovered = await second.run("codemode", { code: `await tools.codemode_status({task_id:${taskId}});` });
	const after = recovered.result.content.filter((block) => block.type === "image");
	expect(after).toEqual(before);
	expect(Buffer.from(after[0]!.data, "base64")).toEqual(Buffer.from(before[0]!.data, "base64"));
}, 15_000);

test("compact valid JPEG is rejected independently when normalized PNG exceeds output bytes", async () => {
	// Bun.Image accepts encoded containers, not raw pixels. This uncompressed 24-bit BMP
	// uses a fixed xorshift stream: reproducible pixels with no random/time-dependent fixture.
	const width = 2048;
	const height = 2048;
	const bmp = Buffer.alloc(54 + width * height * 3);
	bmp.write("BM");
	bmp.writeUInt32LE(bmp.length, 2);
	bmp.writeUInt32LE(54, 10);
	bmp.writeUInt32LE(40, 14);
	bmp.writeInt32LE(width, 18);
	bmp.writeInt32LE(height, 22);
	bmp.writeUInt16LE(1, 26);
	bmp.writeUInt16LE(24, 28);
	bmp.writeUInt32LE(width * height * 3, 34);
	let state = 0x12345678;
	for (let i = 54; i < bmp.length; i++) {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		bmp[i] = state & 255;
	}
	const jpeg = await new Bun.Image(bmp).jpeg({ quality: 25 }).bytes();
	const metadata = await new Bun.Image(jpeg).metadata();
	const normalized = await new Bun.Image(jpeg, { maxPixels: IMAGE_LIMITS.maxPixels }).png().bytes();
	// Explicit preconditions distinguish output-byte rejection from input/pixel/decoder failure.
	expect(metadata.format).toBe("jpeg");
	expect(imagePixelsFit(metadata.width, metadata.height)).toBe(true);
	expect(jpeg.byteLength).toBeLessThanOrEqual(IMAGE_LIMITS.maxBytes);
	expect(normalized.byteLength).toBeGreaterThan(IMAGE_LIMITS.maxBytes);
	const cwd = await directory();
	await writeFile(join(cwd, "compact.jpg"), jpeg);
	const { run } = await setup(cwd, "direct");
	const { result } = await run("read", { path: "compact.jpg" });
	expect(result.isError).toBe(true);
	expect(result.content.some((block) => block.type === "image")).toBe(false);
	expect(JSON.stringify(result.content)).toContain(`Decoded image exceeds ${IMAGE_LIMITS.maxBytes} byte output limit`);
}, 15_000);

test("codemode_status reattaches image blocks but never serializes them into worker/text JSON", async () => {
	const { run } = await setup(await directory());
	const first = await run("codemode", { code: 'await tools.read({path:"image.png"});' });
	const taskId = (first.result.details as { codemodeTaskId: number }).codemodeTaskId;
	const status = await run("codemode", { code: `text(await tools.codemode_status({task_id:${taskId}}));` });
	expect(status.result.isError).not.toBe(true);
	const attached = status.result.content.filter((block) => block.type === "image");
	expect(attached).toHaveLength(1);
	const text = JSON.stringify(status.result.content.filter((block) => block.type === "text"));
	expect(text).toContain("imageCount");
	expect(text).not.toContain(attached[0]!.data);
});

test("encoded input and decoded pixel limits accept equality and reject one-over", async () => {
	const cwd = await directory();
	const exact = Buffer.alloc(IMAGE_LIMITS.maxBytes);
	png.copy(exact);
	await writeFile(join(cwd, "exact.png"), exact);
	await writeFile(join(cwd, "over.png"), Buffer.concat([exact, Buffer.from([0])]));
	await writeFile(join(cwd, "pixels.png"), await new Bun.Image(png).resize(4096, 4096).png().bytes());
	await writeFile(join(cwd, "pixels-over.png"), await new Bun.Image(png).resize(4097, 4096).png().bytes());
	const { run } = await setup(cwd, "direct");
	for (const path of ["exact.png", "pixels.png"]) {
		const { result } = await run("read", { path });
		expect(result.isError).not.toBe(true);
		expect(result.content.some((block) => block.type === "image")).toBe(true);
	}
	for (const path of ["over.png", "pixels-over.png"]) {
		const { result } = await run("read", { path });
		expect(result.isError).toBe(true);
		expect(result.content.some((block) => block.type === "image")).toBe(false);
	}
});

test("attachment admission boundaries and every permutation of five completions preserve bounds", () => {
	expect(imagePixelsFit(1, IMAGE_LIMITS.maxPixels - 1)).toBe(true);
	expect(imagePixelsFit(1, IMAGE_LIMITS.maxPixels)).toBe(true);
	expect(imagePixelsFit(1, IMAGE_LIMITS.maxPixels + 1)).toBe(false);
	for (const value of [0, -1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
		expect(imagePixelsFit(value, 1)).toBe(false);
		expect(imagePixelsFit(1, value)).toBe(false);
	}
	const image = (bytes: number): ImageContent => ({ type: "image", mimeType: "image/png", data: Buffer.alloc(bytes).toString("base64") });
	const maximum = image(IMAGE_LIMITS.maxBytes);
	expect(imageAttachmentsFit([maximum])).toBe(true);
	expect(imageAttachmentsFit([image(IMAGE_LIMITS.maxBytes + 1)])).toBe(false);
	expect(imageAttachmentsFit(Array(4).fill(maximum))).toBe(true);
	expect(imageAttachmentsFit([...Array(4).fill(maximum), image(1)])).toBe(false);
	function permutations(values: number[]): number[][] {
		return values.length ? values.flatMap((value, index) => permutations(values.filter((_, i) => i !== index)).map((rest) => [value, ...rest])) : [[]];
	}
	const schedules = permutations([0, 1, 2, 3, 4]);
	expect(schedules).toHaveLength(120);
	for (const schedule of schedules) {
		const accepted: { ordinal: number; image: ImageContent }[] = [];
		for (const ordinal of schedule) {
			const candidate = image(ordinal + 1);
			if (imageAttachmentsFit([...accepted.map((item) => item.image), candidate])) accepted.push({ ordinal, image: candidate });
			expect(accepted.length).toBeLessThanOrEqual(IMAGE_LIMITS.maxCellImages);
			expect(accepted.reduce((bytes, item) => bytes + Buffer.byteLength(item.image.data, "base64"), 0)).toBeLessThanOrEqual(IMAGE_LIMITS.maxCellBytes);
		}
		expect(accepted).toHaveLength(4);
		const ordered = accepted.slice().sort((a, b) => a.ordinal - b.ordinal);
		expect(new Set(ordered.map((item) => item.ordinal)).size).toBe(ordered.length);
		expect(ordered.map((item) => Buffer.byteLength(item.image.data, "base64"))).toEqual(ordered.map((item) => item.ordinal + 1));
	}
});
