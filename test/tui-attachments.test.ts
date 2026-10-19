import { afterEach, describe, expect, test } from "bun:test";
import { resetCapabilitiesCache, setCapabilities, type Terminal, visibleWidth } from "@earendil-works/pi-tui";
import type { CommandArgument, CommandEvent, CommandInfo, ThreadModelState } from "../src/commands/types.ts";
import type { Manifest } from "../src/manifest.ts";
import { clipboardImageFromFile, type ClipboardImage } from "../src/tui/clipboard.ts";
import { ChatApp, type ChatAppHooks } from "../src/tui/app.ts";
import type { ApiClient } from "../src/tui/client.ts";
import { renderUser } from "../src/tui/blocks/messages.ts";
import { ChatState, ingestEntry } from "../src/tui/state.ts";
import type { UserBlock } from "../src/tui/state.ts";
import type { EntryRecord } from "@earendil-works/pi-durable";
import type { UserMessage } from "@earendil-works/pi-ai";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PNG = PNG_BYTES.toString("base64");
/** Exactly 2 MiB decoded, built like the pipeline tests build it. */
const LIMIT = "A".repeat(2796203) + "=";
const OVER = "A".repeat(2796204);

class StubTerminal implements Terminal {
	onInput: ((data: string) => void) | undefined;
	readonly writes: string[] = [];
	constructor(readonly columns: number, readonly rows: number) {}
	start(onInput: (data: string) => void): void {
		this.onInput = onInput;
	}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.writes.push(data);
	}
	get kittyProtocolActive(): boolean {
		return false;
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
}

type Sent = { text: string; whenBusy: string | undefined; images: { mimeType: string; data: string }[] | undefined };

/** Enough of ApiClient for ChatApp: it records sends and answers the startup calls. */
class SendClient {
	readonly sent: Sent[] = [];
	sendResult: (() => Promise<void>) | undefined;
	async commands(): Promise<CommandInfo[]> {
		return [];
	}
	async commandArguments(): Promise<CommandArgument[]> {
		return [];
	}
	async threads() {
		return [];
	}
	async threadModel(): Promise<ThreadModelState> {
		return { model: "faux/faux-1", thinkingLevel: "off", supportedThinkingLevels: ["off"], fast: false, fastSupported: false };
	}
	events(_channel: string, _thread: string, _onEvent: unknown, signal: AbortSignal): Promise<void> {
		return new Promise((resolve) => signal.addEventListener("abort", () => resolve()));
	}
	async send(_channel: string, _thread: string, text: string, _userId: string, whenBusy?: "followUp" | "steer", images?: readonly { mimeType: string; data: string }[]): Promise<void> {
		this.sent.push({ text, whenBusy, images: images === undefined ? undefined : [...images] });
		await this.sendResult?.();
	}
	sessionsEvents(_onEvent: unknown, signal: AbortSignal): Promise<void> {
		return new Promise((resolve) => signal.addEventListener("abort", () => resolve()));
	}
	async abort(): Promise<void> {}
	async workspace(): Promise<string | undefined> {
		return undefined;
	}
}

const manifest = { model: { provider: "faux", modelId: "faux-1" }, toolMode: "direct" } as unknown as Manifest;

interface ClipboardScript {
	images: (ClipboardImage | null)[];
	texts: (string | null)[];
}

function app(script: ClipboardScript, cols = 140, rows = 40): { chat: ChatApp; terminal: StubTerminal; client: SendClient } {
	const terminal = new StubTerminal(cols, rows);
	const client = new SendClient();
	const hooks: ChatAppHooks = {
		clipboard: {
			readImage: async () => script.images.shift() ?? null,
			readText: async () => script.texts.shift() ?? null,
			imageFromFile: (path) => clipboardImageFromFile(path),
		},
	};
	const chat = new ChatApp(client as unknown as ApiClient, manifest, "main", undefined, undefined, undefined, terminal, hooks);
	chat.start();
	return { chat, terminal, client };
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
/** Wait (bounded) for file-backed staging, which resolves over real I/O and can need more than one tick under suite load. */
const until = async (check: () => boolean, tries = 100): Promise<void> => {
	for (let index = 0; index < tries && !check(); index++) await new Promise((resolve) => setTimeout(resolve, 5));
};
const notices = (chat: ChatApp): string[] => chat.chat.data.blocks.map((block) => (block.kind === "notice" ? block.text : ""));

describe("composer attachments", () => {
	afterEach(() => {
		resetCapabilitiesCache();
	});

	test("bracketed paste of an image file path stages the file and other text stays in the editor", async () => {
		const file = join(tmpdir(), `dinobot-paste-${Date.now()}.png`);
		await Bun.write(file, PNG_BYTES);
		const { chat, terminal, client } = app({ images: [], texts: [] });
		try {
			// A whole-payload path paste inserts an image token rather than the path.
			terminal.onInput?.(`\x1b[200~${file}\x1b[201~`);
			await until(() => chat.stagedImages.length === 1);
			expect(chat.stagedImages.map(({ mimeType, data }) => ({ mimeType, data }))).toEqual([{ mimeType: "image/png", data: PNG }]);
			expect(chat.screen.prompt.getText()).toBe("[Image1]");

			// Any other bracketed paste flows to the editor untouched.
			terminal.onInput?.("\x1b[200~not a path, just words\x1b[201~");
			await flush();
			expect(chat.screen.prompt.getText()).toContain("not a path, just words");
			expect(chat.stagedImages.length).toBe(1);

			// A path paste glued to a trailing keystroke consumes only the paste; the unreadable
			// `.png.png` target explains itself and the trailing x still reaches the editor.
			terminal.onInput?.(`\x1b[200~${file}.png\x1b[201~x`);
			await until(() => notices(chat).some((line) => line.includes("is not a readable png/jpeg/gif/webp image")));
			expect(chat.screen.prompt.getText()).toBe("[Image1]not a path, just wordsx");
			expect(notices(chat).join("\n")).toContain("is not a readable png/jpeg/gif/webp image");

			// Submit carries the staged image with the message.
			chat.screen.prompt.setText("[Image1]");
			for (const char of "check this") terminal.onInput?.(char);
			terminal.onInput?.("\r");
			await flush();
			expect(client.sent.map(({ text, images }) => ({ text, images: images?.map(({ mimeType, data }) => ({ mimeType, data })) })))
				.toEqual([{ text: "check this", images: [{ mimeType: "image/png", data: PNG }] }]);
			expect(chat.stagedImages.length).toBe(0);
		} finally {
			await Bun.file(file).delete();
		}
	});

	test("staging enforces count, per-image and total size bounds with a notice", async () => {
		const { chat, terminal } = app({ images: [
			{ data: PNG_BYTES, mimeType: "image/png" },
			{ data: new Uint8Array(Buffer.from(OVER, "base64")), mimeType: "image/png" },
			{ data: new Uint8Array(Buffer.from(LIMIT, "base64")), mimeType: "image/png" },
			{ data: new Uint8Array(Buffer.from(LIMIT, "base64")), mimeType: "image/png" },
			{ data: new Uint8Array(Buffer.from(LIMIT, "base64")), mimeType: "image/png" },
			{ data: PNG_BYTES, mimeType: "image/png" },
		], texts: [] });
		// Six Ctrl+V strokes against the scripted clipboard.
		for (let index = 0; index < 6; index++) {
			terminal.onInput?.("\x16");
			await flush();
		}
		// Four staged: three at exactly 2 MiB plus the first small one; the oversize and fifth were refused.
		expect(chat.stagedImages.length).toBe(4);
		const text = notices(chat).join("\n");
		expect(text).toContain("Image not attached: image is 2.0 MiB; the per-image limit is 2.0 MiB");
		expect(text).toContain("at most 4 images per message");
		// Ctrl+Alt+V takes the newest staged image back out of the draft.
		terminal.onInput?.("\x1b\x16");
		expect(chat.stagedImages.length).toBe(3);
	});

	test("Ctrl+V falls back to clipboard text and an empty clipboard notices", async () => {
		const { chat, terminal } = app({ images: [null], texts: ["pasted words"] });
		terminal.onInput?.("\x16");
		await flush();
		expect(chat.screen.prompt.getText()).toBe("pasted words");
		expect(chat.stagedImages.length).toBe(0);

		const empty = app({ images: [null], texts: [null] });
		empty.terminal.onInput?.("\x16");
		await flush();
		expect(notices(empty.chat).join("\n")).toContain("Clipboard has no image or text");
		expect(empty.chat.screen.prompt.getText()).toBe("");
	});

	test("an OSC 5522 image paste stages through the input listener", async () => {
		const { chat, terminal } = app({ images: [], texts: [] });
		const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");
		// enable was written at startup, before any paste can arrive.
		expect(terminal.writes).toContain("\x1b[?5522h");
		// A fragmented packet is buffered across chunks until its terminator.
		terminal.onInput?.("\x1b]5522;type=read:sta");
		terminal.onInput?.("tus=OK\x07");
		terminal.onInput?.(`\x1b]5522;type=read:status=DATA:mime=${b64(".")};${b64("image/png")}\x07`);
		terminal.onInput?.("\x1b]5522;type=read:status=DONE\x07");
		await flush();
		expect(terminal.writes).toContain(`\x1b]5522;type=read;${b64("image/png")}\x07`);
		terminal.onInput?.("\x1b]5522;type=read:status=OK\x07");
		terminal.onInput?.(`\x1b]5522;type=read:status=DATA:mime=${b64("image/png")};${PNG}\x07`);
		terminal.onInput?.("\x1b]5522;type=read:status=DONE\x07");
		await flush();
		expect(chat.stagedImages.map(({ mimeType, data }) => ({ mimeType, data }))).toEqual([{ mimeType: "image/png", data: PNG }]);
		expect(chat.screen.prompt.getText()).toBe("[Image1]");
	});

	test("combining text beside an image token never splits or silently drops its bytes", async () => {
		const { chat, terminal, client } = app({ images: [{ data: PNG_BYTES, mimeType: "image/png" }], texts: [] });
		terminal.onInput?.("\x16"); await flush();
		terminal.onInput?.("\x1b[200~\u0301\x1b[201~");
		expect(chat.screen.prompt.getText()).toBe("[Image1]\u0301");
		terminal.onInput?.("\x7f");
		expect(chat.screen.prompt.getText()).toBe("[Image1]");
		expect(chat.stagedImages).toHaveLength(1);
		terminal.onInput?.("\x7f");
		expect(chat.screen.prompt.getText()).toBe("");
		expect(chat.stagedImages).toHaveLength(0);
		terminal.onInput?.("\x1f");
		expect(chat.screen.prompt.getText()).toBe("[Image1]");
		terminal.onInput?.("\r"); await flush();
		expect(client.sent[0]?.text).toBe("");
		expect(client.sent[0]?.images).toHaveLength(1);
	});

	test("inline paste at the middle cursor preserves unicode and newlines; arrows and backspace are atomic", async () => {
		const { chat, terminal } = app({ images: [{ data: PNG_BYTES, mimeType: "image/png" }], texts: [] });
		terminal.onInput?.("\x1b[200~前🙂\nabc後\x1b[201~");
		terminal.onInput?.("\x1b[D");
		terminal.onInput?.("\x16");
		await flush();
		expect(chat.screen.prompt.getText()).toBe("前🙂\nabc[Image1]後");
		terminal.onInput?.("\x1b[D");
		expect(chat.screen.prompt.getCursor()).toEqual({ line: 1, col: 3 });
		terminal.onInput?.("\x1b[C");
		expect(chat.screen.prompt.getCursor()).toEqual({ line: 1, col: 11 });
		terminal.onInput?.("\x7f");
		expect(chat.screen.prompt.getText()).toBe("前🙂\nabc後");
		expect(chat.stagedImages).toHaveLength(0);
		terminal.onInput?.("\x1f"); // ctrl+-: undo deletion
		expect(chat.screen.prompt.getText()).toBe("前🙂\nabc[Image1]後");
		expect(chat.stagedImages).toHaveLength(1);
		terminal.onInput?.("\x1f"); // undo insertion
		expect(chat.screen.prompt.getText()).toBe("前🙂\nabc後");
		expect(chat.stagedImages).toHaveLength(0);
	});

	for (const key of ["\x7f", "\x1b[3~"]) test("deleting a nonfinal image among prose with " + JSON.stringify(key) + " removes only that payload and preview", async () => {
		const { chat, terminal, client } = app({ images: [
			{ data: PNG_BYTES, mimeType: "image/png" }, { data: Buffer.from("second"), mimeType: "image/png" },
		], texts: [] });
		const type = (s: string) => terminal.onInput?.("\x1b[200~" + s + "\x1b[201~");
		type("left "); terminal.onInput?.("\x16"); await flush();
		type(" middle "); terminal.onInput?.("\x16"); await flush(); type(" right");
		terminal.onInput?.("\x01"); // line start
		for (let i = 0; i < 5; i++) terminal.onInput?.("\x1b[C");
		if (key === "\x7f") terminal.onInput?.("\x1b[C");
		terminal.onInput?.(key);
		expect(chat.screen.prompt.getText()).toBe("left  middle [Image2] right");
		expect(chat.stagedImages.map(i => i.id)).toEqual([2]);
		const rendered = chat.screen.prompt.render(100).join("\n");
		expect(rendered).not.toContain("Image1");
		expect(rendered).toContain("Image2");
		terminal.onInput?.("\r"); await flush();
		expect(client.sent[0]?.text).toBe("left  middle  right");
		expect(client.sent[0]?.images?.map(i => i.data)).toEqual([Buffer.from("second").toString("base64")]);
	});

	test("kitty previews draw the PNG thumbnail, never blank non-PNG originals, and the thumbnail is not sent", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9]);
		const thumb = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 5, 5]);
		const { chat, terminal, client } = app({ images: [
			{ data: jpeg, mimeType: "image/jpeg" }, { data: jpeg, mimeType: "image/jpeg", preview: thumb },
		], texts: [] });
		const graphics = (): string[] => chat.screen.prompt.render(100).filter((line) => line.includes("\x1b_G"));
		terminal.onInput?.("\x16"); await flush();
		// JPEG without thumbnail: kitty f=100 cannot decode it, so no reserved blank rows, just the chip.
		expect(graphics()).toEqual([]);
		const lines = chat.screen.prompt.render(100);
		const row = lines.findIndex((line) => line.includes("JPEG"));
		expect(lines.filter((line) => line.includes("JPEG")).length).toBe(1);
		// The chip row is padded by visible width, so its right border lines up with the box corners above and below.
		expect(visibleWidth(lines[row]!)).toBe(visibleWidth(lines[row - 1]!));
		expect(visibleWidth(lines[row]!)).toBe(visibleWidth(lines[row + 1]!));
		terminal.onInput?.("\x16"); await flush();
		const drawn = graphics();
		expect(drawn.length).toBe(1);
		expect(drawn[0]).toContain(thumb.toString("base64"));
		expect(drawn[0]).not.toContain(jpeg.toString("base64"));
		terminal.onInput?.("\r"); await flush();
		expect(client.sent[0]?.images).toEqual([{ mimeType: "image/jpeg", data: jpeg.toString("base64") }, { mimeType: "image/jpeg", data: jpeg.toString("base64") }]);
	});

	test("image-only send, token order, unknown literals, and clean history", async () => {
		const { chat, terminal, client } = app({ images: [
			{ data: PNG_BYTES, mimeType: "image/png" }, { data: Buffer.from("second"), mimeType: "image/png" },
		], texts: [] });
		terminal.onInput?.("\x16"); await flush();
		terminal.onInput?.("\x01"); terminal.onInput?.("\x16"); await flush();
		expect(chat.screen.prompt.getText()).toBe("[Image2][Image1]");
		terminal.onInput?.("\r"); await flush();
		expect(client.sent[0]?.text).toBe("");
		expect(client.sent[0]?.images?.map(i => i.data)).toEqual([Buffer.from("second").toString("base64"), PNG]);
		terminal.onInput?.("\x1f"); terminal.onInput?.("\x1b[A");
		expect(chat.screen.prompt.getText()).toBe("");
		terminal.onInput?.("\x1b[200~literal [Image999] and [Image1]\x1b[201~");
		terminal.onInput?.("\r"); await flush();
		expect(client.sent[1]?.text).toBe("literal [Image999] and [Image1]");
		expect(client.sent[1]?.images).toBeUndefined();
	});

	test("failed send restores text and images without overwriting the concurrent draft", async () => {
		const { chat, terminal, client } = app({ images: [
			{ data: PNG_BYTES, mimeType: "image/png" }, { data: Buffer.from("second"), mimeType: "image/png" },
		], texts: [] });
		let reject!: (error: Error) => void;
		client.sendResult = () => new Promise((_, fail) => { reject = fail; });
		terminal.onInput?.("  old "); terminal.onInput?.("\x16"); await flush();
		terminal.onInput?.("\x1b[200~ \n\x1b[201~");
		terminal.onInput?.("\r"); await flush();
		terminal.onInput?.("new "); terminal.onInput?.("\x16"); await flush();
		reject(new Error("offline")); await flush();
		expect(chat.screen.prompt.getText()).toBe("  old [Image1] \n\nnew [Image2]");
		expect(chat.stagedImages.map(i => i.id)).toEqual([1, 2]);
		client.sendResult = undefined;
		terminal.onInput?.("\r"); await flush();
		expect(client.sent[1]?.text).toBe("old  \n\nnew");
		expect(client.sent[1]?.images).toHaveLength(2);
		expect(chat.screen.prompt.getText()).toBe("");
	});

	test("failed image-only send preserves a concurrent collapsed multiline paste", async () => {
		const { chat, terminal, client } = app({ images: [{ data: PNG_BYTES, mimeType: "image/png" }], texts: [] });
		let reject!: (error: Error) => void;
		client.sendResult = () => new Promise((_, fail) => { reject = fail; });
		terminal.onInput?.("\x16"); await flush(); terminal.onInput?.("\r"); await flush();
		const prose = Array.from({ length: 30 }, (_, i) => "line " + i + " e\u0301🙂").join("\n");
		terminal.onInput?.("\x1b[200~" + prose + "\x1b[201~");
		expect(chat.screen.prompt.getText()).toContain("[paste #");
		reject(new Error("offline")); await flush();
		expect(chat.screen.prompt.getExpandedText()).toBe("[Image1]\n" + prose);
		expect(chat.stagedImages).toHaveLength(1);
		terminal.onInput?.("\x1f");
		expect(chat.screen.prompt.getExpandedText()).toBe(prose);
		expect(chat.stagedImages).toHaveLength(0);
	});

	test("word delete/yank, wrapped mouse clicks and vertical movement cannot split a token", async () => {
		const { chat, terminal } = app({ images: [{ data: PNG_BYTES, mimeType: "image/png" }], texts: [] }, 20);
		terminal.onInput?.("ab"); terminal.onInput?.("\x16"); await flush(); terminal.onInput?.("cd");
		terminal.onInput?.("\x1b[D"); terminal.onInput?.("\x1b[D");
		terminal.onInput?.("\x17"); // ctrl+w
		expect(chat.screen.prompt.getText()).toBe("abcd");
		expect(chat.stagedImages).toHaveLength(0);
		terminal.onInput?.("\x19"); // yank
		expect(chat.screen.prompt.getText()).toBe("ab[Image1]cd");
		expect(chat.stagedImages).toHaveLength(1);
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
		const lines = chat.screen.prompt.render(10);
		chat.screen.prompt.handleMouse({ type: "click", button: "left", x: 5, y: 6, width: 10, height: lines.length, screenX: 5, screenY: 6, shift: false, alt: false, ctrl: false });
		expect(chat.screen.prompt.getCursor().col).toBe(2);
		terminal.onInput?.("\x1b[B");
		expect([0, 1, 2, 10, 11, 12]).toContain(chat.screen.prompt.getCursor().col);
		terminal.onInput?.("\x01"); terminal.onInput?.("\x1b[C"); terminal.onInput?.("\x1b[C");
		terminal.onInput?.("\x1b[3~");
		expect(chat.screen.prompt.getText()).toBe("abcd");
	});

	test("deleting the inline token removes its live composer thumbnail", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const { chat, terminal } = app({ images: [{ data: PNG_BYTES, mimeType: "image/png" }], texts: [] });
		terminal.onInput?.("\x16"); await flush();
		expect(chat.screen.prompt.render(100).join("\n")).toContain("_G");
		terminal.onInput?.("\x7f");
		const rendered = chat.screen.prompt.render(100).join("\n");
		expect(rendered).not.toContain("_G");
		expect(rendered).not.toContain("Image1");
	});

	test("deleted slots can be reused, undo restores the bounded old draft, and all-removed images never send", async () => {
		const { chat, terminal, client } = app({ images: Array.from({ length: 5 }, () => ({ data: PNG_BYTES, mimeType: "image/png" as const })), texts: [] });
		for (let i = 0; i < 4; i++) { terminal.onInput?.("\x16"); await flush(); }
		terminal.onInput?.("\x7f");
		terminal.onInput?.("\x16"); await flush();
		expect(chat.stagedImages.map(i => i.id)).toEqual([1, 2, 3, 5]);
		terminal.onInput?.("\x1f"); terminal.onInput?.("\x1f");
		expect(chat.stagedImages.map(i => i.id)).toEqual([1, 2, 3, 4]);
		for (let i = 0; i < 4; i++) terminal.onInput?.("\x7f");
		terminal.onInput?.("plain"); terminal.onInput?.("\r"); await flush();
		expect(client.sent[0]?.images).toBeUndefined();
		expect(client.sent[0]?.text).toBe("plain");
		terminal.onInput?.("\x1f"); terminal.onInput?.("\x19"); terminal.onInput?.("\x1b[A");
		expect(chat.screen.prompt.getText()).toBe("plain");
	});

	test("pending sends reserve count/size capacity, keep a second submit, and restore on failure", async () => {
		const { chat, terminal, client } = app({ images: Array.from({ length: 5 }, () => ({ data: Buffer.from(LIMIT, "base64"), mimeType: "image/png" as const })), texts: [] });
		let reject!: (error: Error) => void;
		client.sendResult = () => new Promise((_, fail) => { reject = fail; });
		for (let i = 0; i < 3; i++) { terminal.onInput?.("\x16"); await flush(); }
		terminal.onInput?.("\r"); await flush();
		for (let i = 0; i < 2; i++) { terminal.onInput?.("\x16"); await flush(); }
		expect(chat.screen.prompt.getText()).toBe("[Image4]");
		expect(notices(chat).join("\n")).toContain("at most 4 images");
		terminal.onInput?.("\r"); await flush();
		expect(client.sent).toHaveLength(1);
		expect(chat.screen.prompt.getText()).toBe("[Image4]");
		reject(new Error("offline")); await flush();
		expect(chat.screen.prompt.getText()).toBe("[Image1][Image2][Image3]\n[Image4]");
		expect(chat.stagedImages.reduce((n, i) => n + i.bytes, 0)).toBe(8 * 1024 * 1024);
	});

	test("literal IDs stay literal across undo and do not collide with later image allocation", async () => {
		const { chat, terminal, client } = app({ images: [{ data: PNG_BYTES, mimeType: "image/png" }], texts: [] });
		terminal.onInput?.("\x1b[200~[Image1]\x1b[201~");
		terminal.onInput?.("\x15"); // kill literal to line start
		terminal.onInput?.("\x16"); await flush();
		expect(chat.screen.prompt.getText()).toBe("[Image2]");
		terminal.onInput?.("\x19");
		terminal.onInput?.("\r"); await flush();
		expect(client.sent[0]?.text).toBe("[Image1]");
		expect(client.sent[0]?.images).toHaveLength(1);
	});

	test("known-token yank combinations cannot bypass message bounds", async () => {
		const { chat, terminal, client } = app({ images: Array.from({ length: 5 }, () => ({ data: PNG_BYTES, mimeType: "image/png" as const })), texts: [] });
		terminal.onInput?.("\x16"); await flush(); terminal.onInput?.("\x15");
		for (let i = 0; i < 4; i++) { terminal.onInput?.("\x16"); await flush(); }
		terminal.onInput?.("\x19"); terminal.onInput?.("\r"); await flush();
		expect(client.sent).toHaveLength(0);
		expect(chat.screen.prompt.getText()).toContain("[Image1]");
		expect(notices(chat).join("\n")).toContain("Message not sent: at most 4 images");
	});

	test("opening the local sessions browser preserves an unrelated inline image draft", async () => {
		const { chat, terminal } = app({ images: [{ data: PNG_BYTES, mimeType: "image/png" }], texts: [] });
		terminal.onInput?.("draft "); terminal.onInput?.("\x16"); await flush();
		chat.screen.prompt.onSubmit?.("/sessions"); await flush();
		expect(chat.screen.prompt.getText()).toBe("draft [Image1]");
		expect(chat.stagedImages).toHaveLength(1);
		terminal.onInput?.("\x1b");
		expect(chat.screen.prompt.getText()).toBe("draft [Image1]");
	});

	test("image capture does not hijack answer, slash or overlay input", async () => {
		const { chat, terminal } = app({ images: [{ data: PNG_BYTES, mimeType: "image/png" }], texts: [] });
		const prompt = chat.screen.prompt;
		prompt.beginAnswer({ type: "text", message: "Path?" }, { onAnswer: () => {}, onCancel: () => {} });
		terminal.onInput?.("\x1b[200~/tmp/picture.png\x1b[201~");
		expect(prompt.getText()).toBe("/tmp/picture.png");
		terminal.onInput?.("\x16"); await flush();
		expect(chat.stagedImages).toHaveLength(0);
		prompt.endAnswer();
		terminal.onInput?.("/help");
		terminal.onInput?.("\x16"); await flush();
		expect(chat.stagedImages).toHaveLength(0);
		prompt.setText("");
		const overlay = chat.screen.tui.showOverlay({ render: () => ["overlay"], handleInput: () => {}, invalidate: () => {} });
		terminal.onInput?.("\x16"); terminal.onInput?.("\x1b[200~/tmp/picture.png\x1b[201~"); await flush();
		expect(prompt.getText()).toBe("");
		expect(chat.stagedImages).toHaveLength(0);
		overlay.hide();
		terminal.onInput?.("\x16"); await flush();
		expect(prompt.getText()).toBe("[Image1]");
	});

	test("user entries with image blocks render thumbnails with a protocol and labeled text without one", () => {
		const state = new ChatState();
		const entry = {
			id: "e1", conversationId: 1, kind: "pi.user",
			model: [{
				role: "user", timestamp: 1,
				content: [{ type: "text", text: '<from user="roach" channel="tui"/>\nsee this' }, { type: "image", mimeType: "image/png", data: PNG }],
			} as UserMessage],
		} as unknown as EntryRecord;
		ingestEntry(state.data, entry, 1);
		const block = state.data.blocks[0] as UserBlock;
		expect(block.kind).toBe("user");
		expect(block.text).toBe("see this");
		expect(block.images).toEqual([{ mimeType: "image/png", data: PNG }]);

		const ctx = { expanded: false, selected: false, tick: 0, now: 0, running: false };
		// Without an image protocol: a labeled text line, no graphics escapes.
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
		const fallback = renderUser(block, 100, ctx);
		expect(fallback.some((line) => line.includes("[▣ image PNG"))).toBe(true);
		expect(fallback.every((line) => !line.includes("_G"))).toBe(true);
		// With the kitty protocol: the block renders a graphics transmission.
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const live = renderUser({ ...block, id: "u2" }, 100, ctx);
		expect(live.some((line) => line.includes("_G"))).toBe(true);
	});
});
