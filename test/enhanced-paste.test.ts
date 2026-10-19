import { describe, expect, test } from "bun:test";
import { DEFAULT_PASTE_TIMEOUT_MS, EnhancedPasteController, type EnhancedPasteHandlers } from "../src/tui/enhanced-paste.ts";

const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");
const packet = (metadata: string, payload = ""): string => `\x1b]5522;${metadata};${payload}\x07`;
const ok = (extra = ""): string => packet(`type=read:status=OK${extra}`);
const data = (mime: string, payload: string): string => packet(`type=read:status=DATA:mime=${b64(mime)}`, payload);
const done = (): string => `\x1b]5522;type=read:status=DONE\x07`;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]).toString("base64");

interface Recorded {
	readonly writes: string[];
	readonly texts: string[];
	readonly images: { mimeType: string; data: string }[];
	readonly statuses: string[];
}

function make(timeoutMs = 40): { controller: EnhancedPasteController; recorded: Recorded } {
	const recorded: Recorded = { writes: [], texts: [], images: [], statuses: [] };
	const handlers: EnhancedPasteHandlers = {
		write: (data) => recorded.writes.push(data),
		pasteText: (text) => recorded.texts.push(text),
		pasteImage: (image) => {
			recorded.images.push(image);
		},
		showStatus: (message) => recorded.statuses.push(message),
	};
	return { controller: new EnhancedPasteController(handlers, { timeoutMs }), recorded };
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("EnhancedPasteController", () => {
	test("reconstructs a chunked kitty dot-listing image paste", async () => {
		const { controller, recorded } = make();
		controller.enable();
		expect(recorded.writes).toEqual(["\x1b[?5522h"]);

		// Listing round: kitty's dot sentinel carries the packed type list.
		expect(controller.feed(ok(":pw=7"))).toBeNull();
		expect(controller.feed(data(".", b64("text/plain image/png image/webp")))).toBeNull();
		expect(controller.feed(done())).toBeNull();
		await flush();
		expect(recorded.writes[1]).toBe(`\x1b]5522;type=read:pw=7:name=${b64("Paste event")};${b64("image/png")}\x07`);

		// Read round: two chunks reassemble into one image.
		const [head, tail] = [PNG.slice(0, 8), PNG.slice(8)];
		expect(controller.feed(ok())).toBeNull();
		expect(controller.feed(data("image/png", head))).toBeNull();
		expect(controller.feed(data("image/png", tail))).toBeNull();
		expect(controller.feed(done())).toBeNull();
		await flush();
		expect(recorded.images).toEqual([{ mimeType: "image/png", data: PNG }]);
		expect(recorded.texts).toEqual([]);

		// The machine is idle again: a fresh listing works without a reset in between.
		controller.feed(ok());
		controller.feed(data(".", b64("image/png")));
		controller.feed(done());
		await flush();
		expect(recorded.writes[2]).toBe(`\x1b]5522;type=read;${b64("image/png")}\x07`);
		expect(recorded.statuses).toEqual([]);
	});

	test("reads a per-packet mime listing and falls back to clipboard text", async () => {
		const { controller, recorded } = make();
		controller.feed(ok());
		controller.feed(data("text/plain", ""));
		controller.feed(done());
		await flush();
		expect(recorded.writes).toEqual([`\x1b]5522;type=read:mime=${b64("text/plain")}\x07`]);

		controller.feed(ok());
		controller.feed(data("text/plain", b64("hello world")));
		controller.feed(done());
		await flush();
		expect(recorded.texts).toEqual(["hello world"]);
		expect(recorded.images).toEqual([]);
	});

	test("resets to idle on error status, lost DONE timeout and oversize payload", async () => {
		// Error status mid-listing.
		{
			const { controller, recorded } = make();
			controller.feed(ok());
			controller.feed(packet("type=read:status=EPERM"));
			await flush();
			expect(recorded.statuses).toEqual(["Clipboard paste failed: EPERM"]);
			expect(recorded.images).toEqual([]);
			// Idle again: a new listing proceeds instead of being ignored.
			controller.feed(ok());
			controller.feed(data(".", b64("image/png")));
			controller.feed(done());
			await flush();
			expect(recorded.writes).toEqual([`\x1b]5522;type=read;${b64("image/png")}\x07`]);
		}
		// Lost DONE: the timeout returns the machine to idle.
		{
			const { controller, recorded } = make(20);
			controller.feed(ok());
			await new Promise((resolve) => setTimeout(resolve, 60));
			expect(recorded.statuses).toEqual(["Clipboard paste timed out"]);
			controller.feed(done());
			await flush();
			expect(recorded.writes).toEqual([]);
		}
		// Oversize image: the incremental bound aborts before DONE can buffer it whole.
		{
			const { controller, recorded } = make(0);
			controller.feed(ok());
			controller.feed(data(".", b64("image/png")));
			controller.feed(done());
			await flush();
			controller.feed(ok());
			const chunk = "A".repeat(1024 * 1024);
			controller.feed(data("image/png", chunk));
			controller.feed(data("image/png", chunk));
			controller.feed(data("image/png", chunk));
			expect(recorded.statuses).toEqual(["Clipboard image is larger than the message limit"]);
			controller.feed(done());
			await flush();
			expect(recorded.images).toEqual([]);
		}
	});

	test("forwards glued keystrokes and leaves foreign input untouched", async () => {
		const { controller, recorded } = make(0);
		expect(controller.feed("abc")).toBe("abc");
		// A fragmented packet is buffered until its terminator, then consumed whole.
		expect(controller.feed(ok(":pw=3").slice(0, 9))).toBeNull();
		expect(controller.feed(ok(":pw=3").slice(9))).toBeNull();
		// A keystroke glued after a complete packet comes back for normal dispatch.
		expect(controller.feed(`${data("text/plain", b64("hi"))}${done()}\r`)).toBe("\r");
		// The default timeout stays a sane production value.
		expect(DEFAULT_PASTE_TIMEOUT_MS).toBeGreaterThanOrEqual(1000);
		await flush();
		expect(recorded.statuses).toEqual([]);
	});
});
