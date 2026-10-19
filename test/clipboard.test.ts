import { afterEach, describe, expect, test } from "bun:test";
import { MACOS_IMAGE_SCRIPT, pastedImageFile, readClipboardImage, readClipboardText, type ClipboardSpawn } from "../src/tui/clipboard.ts";
import { imagePathFromPaste, MACOS_IMAGE_EXTENSIONS } from "../src/tui/attachments.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** A spawn that answers scripted commands (keyed by the full command line) and records what was asked. */
function fake(script: Record<string, string | Uint8Array | Error>): { spawn: ClipboardSpawn; calls: string[][] } {
	const calls: string[][] = [];
	const fake: ClipboardSpawn = async (command) => {
		calls.push([...command]);
		const answer = script[command.join(" ")];
		if (answer instanceof Error) throw answer;
		return answer ?? "";
	};
	return { spawn: fake, calls };
}

let wayland: string | undefined;
let display: string | undefined;

describe("clipboard strategies", () => {
	afterEach(() => {
		if (wayland === undefined) delete process.env.WAYLAND_DISPLAY;
		else process.env.WAYLAND_DISPLAY = wayland;
		if (display === undefined) delete process.env.DISPLAY;
		else process.env.DISPLAY = display;
		wayland = undefined;
		display = undefined;
	});

	const pin = (env: { wayland?: string; display?: string }): void => {
		wayland = process.env.WAYLAND_DISPLAY;
		display = process.env.DISPLAY;
		if (env.wayland === undefined) delete process.env.WAYLAND_DISPLAY;
		else process.env.WAYLAND_DISPLAY = env.wayland;
		if (env.display === undefined) delete process.env.DISPLAY;
		else process.env.DISPLAY = env.display;
	};

	test("selects the highest-priority offered image mime from the clipboard", async () => {
		pin({ wayland: "wayland-0" });
		const bytes = new Uint8Array([1, 2, 3]);
		const { spawn, calls } = fake({
			"wl-paste --list-types": "text/plain;charset=utf-8\nimage/webp\nimage/jpeg\ntext/plain\n",
			"wl-paste --type image/jpeg": bytes,
		});
		const image = await readClipboardImage(spawn, "linux");
		expect(image).toEqual({ data: bytes, mimeType: "image/jpeg" });
		expect(calls).toEqual([["wl-paste", "--list-types"], ["wl-paste", "--type", "image/jpeg"]]);
	});

	test("returns null when no image is offered so text fallback applies", async () => {
		pin({ wayland: "wayland-0" });
		// No image offer: image read is null and text still flows.
		const none = fake({ "wl-paste --list-types": "text/plain\n" });
		expect(await readClipboardImage(none.spawn, "linux")).toBeNull();
		const text = fake({ "wl-paste --no-newline": "just words" });
		expect(await readClipboardText(text.spawn, "linux")).toBe("just words");
		// A failing clipboard tool is "no image", never a throw.
		const failing = fake({ "wl-paste --list-types": new Error("no daemon") });
		expect(await readClipboardImage(failing.spawn, "linux")).toBeNull();
		// X11: the TARGETS listing drives the same choice.
		pin({ display: ":0" });
		const bytes = new Uint8Array([9]);
		const x11 = fake({
			"xclip -selection clipboard -t TARGETS -o": "TEXT\nSTRING\nTARGETS\nimage/png\n",
			"xclip -selection clipboard -t image/png -o": bytes,
		});
		expect(await readClipboardImage(x11.spawn, "linux")).toEqual({ data: bytes, mimeType: "image/png" });
		// Neither display server: nothing to read.
		pin({});
		expect(await readClipboardImage(fake({}).spawn, "linux")).toBeNull();
		expect(await readClipboardText(fake({}).spawn, "linux")).toBeNull();
	});

	test("macOS reads images through AppKit and text through pbpaste, whatever DISPLAY says", async () => {
		pin({ display: ":0" });
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]);
		const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1]);
		const calls: (readonly string[])[] = [];
		const answers: (string | Error)[] = [`${jpeg.toString("base64")}\n${png.toString("base64")}\n`, "", new Error("osascript failed"), `${Buffer.from("not an image").toString("base64")}\n`];
		const spawn: ClipboardSpawn = async (command, options) => {
			calls.push(command);
			if (command[0] === "pbpaste") return "copied words";
			expect(options?.timeoutMs).toBeGreaterThan(2000);
			const answer = answers.shift()!;
			if (answer instanceof Error) throw answer;
			return answer;
		};
		// Image plus its PNG thumbnail; the original keeps its own format.
		expect(await readClipboardImage(spawn, "darwin")).toEqual({ data: new Uint8Array(jpeg), mimeType: "image/jpeg", preview: new Uint8Array(png) });
		expect(calls[0]!.slice(0, 5)).toEqual(["osascript", "-l", "JavaScript", "-e", MACOS_IMAGE_SCRIPT]);
		expect(calls[0]!.slice(5)).toEqual(["2097152", "480", ""]);
		// Empty output, a failing osascript and undecodable bytes are all "no image", never a throw.
		expect(await readClipboardImage(spawn, "darwin")).toBeNull();
		expect(await readClipboardImage(spawn, "darwin")).toBeNull();
		expect(await readClipboardImage(spawn, "darwin")).toBeNull();
		expect(await readClipboardText(spawn, "darwin")).toBe("copied words");
		expect(calls.some((command) => command[0] === "xclip")).toBe(false);
	});

	test("a pasted file goes through AppKit on macOS and falls back to its own bytes", async () => {
		const file = join(tmpdir(), `dinobot-clip-${Date.now()}.png`);
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 3]);
		await Bun.write(file, png);
		const sources: string[] = [];
		const failing: ClipboardSpawn = async (command) => {
			sources.push(command.at(-1)!);
			throw new Error("no osascript");
		};
		expect(await pastedImageFile(file, failing, "darwin")).toEqual({ data: new Uint8Array(png), mimeType: "image/png" });
		expect(sources).toEqual([`file:${file}`]);
		expect(await pastedImageFile(file, failing, "linux")).toEqual({ data: new Uint8Array(png), mimeType: "image/png" });
		expect(sources.length).toBe(1);
	});

	test.skipIf(process.platform !== "darwin")("real AppKit: re-encodes HEIC and TIFF, shrinks oversized images, ignores non-images", async () => {
		const dir = join(tmpdir(), `dinobot-appkit-${Date.now()}`);
		const big = join(dir, "big shot.png");
		await Bun.$`mkdir -p ${dir}`.quiet();
		// A random-noise 24-bit BMP (incompressible), converted by sips so the PNG is far above the 2 MiB limit.
		const width = 1400, height = 1000, rowBytes = width * 3;
		const bmp = Buffer.alloc(54 + rowBytes * height);
		bmp.write("BM", 0, "latin1");
		bmp.writeUInt32LE(bmp.length, 2);
		bmp.writeUInt32LE(54, 10);
		bmp.writeUInt32LE(40, 14);
		bmp.writeInt32LE(width, 18);
		bmp.writeInt32LE(height, 22);
		bmp.writeUInt16LE(1, 26);
		bmp.writeUInt16LE(24, 28);
		crypto.getRandomValues(bmp.subarray(54, 54 + 65536));
		for (let offset = 54 + 65536; offset < bmp.length; offset += 65536) crypto.getRandomValues(bmp.subarray(offset, Math.min(bmp.length, offset + 65536)));
		await Bun.write(join(dir, "noise.bmp"), bmp);
		await Bun.$`sips -s format png ${join(dir, "noise.bmp")} --out ${big}`.quiet();
		expect((await Bun.file(big).arrayBuffer()).byteLength).toBeGreaterThan(2 * 1024 * 1024);
		await Bun.$`sips -s format heic ${big} --out ${join(dir, "a.heic")}`.quiet();
		await Bun.$`sips -s format tiff ${big} --out ${join(dir, "a.tiff")}`.quiet();
		await Bun.write(join(dir, "note.png"), "not an image");
		try {
			for (const name of ["big shot.png", "a.heic", "a.tiff", "noise.bmp"]) {
				const image = await pastedImageFile(join(dir, name));
				expect(image).toBeDefined();
				expect(["image/png", "image/jpeg"]).toContain(image!.mimeType);
				expect(image!.data.byteLength).toBeLessThanOrEqual(2 * 1024 * 1024);
				expect(Buffer.from(image!.preview!.subarray(0, 4)).toString("latin1")).toBe("\x89PNG");
			}
			expect(await pastedImageFile(join(dir, "note.png"))).toBeUndefined();
		} finally {
			await Bun.$`rm -rf ${dir}`.quiet();
		}
	}, 30000);
});

describe("pasted image paths", () => {
	test("accepts one escaped, quoted or file:// path and leaves prose alone", () => {
		const shot = "/Users/me/Desktop/Screenshot 2026-10-13 at 4.12.01\u202fPM.png";
		expect(imagePathFromPaste("/tmp/a.png")).toBe("/tmp/a.png");
		expect(imagePathFromPaste(shot.replaceAll(" ", "\\ "))).toBe(shot);
		expect(imagePathFromPaste(`'${shot}'`)).toBe(shot);
		expect(imagePathFromPaste(`"${shot}"`)).toBe(shot);
		expect(imagePathFromPaste(" /tmp/a\\ b.JPG \n")).toBe("/tmp/a b.JPG");
		expect(imagePathFromPaste("file:///tmp/My%20Shot.png")).toBe("/tmp/My Shot.png");
		expect(imagePathFromPaste("file://example.com/tmp/a.png")).toBeUndefined();
		expect(imagePathFromPaste("/tmp/a b.png")).toBeUndefined();
		expect(imagePathFromPaste("look at /tmp/a.png")).toBeUndefined();
		expect(imagePathFromPaste("/tmp/a.png\n/tmp/b.png")).toBeUndefined();
		expect(imagePathFromPaste("'/tmp/a.png' '/tmp/b.png'")).toBeUndefined();
		expect(imagePathFromPaste("relative.png")).toBeUndefined();
		expect(imagePathFromPaste("/tmp/a.png/dir")).toBeUndefined();
		expect(imagePathFromPaste("/tmp/photo.heic")).toBeUndefined();
		expect(imagePathFromPaste("/tmp/photo.heic", MACOS_IMAGE_EXTENSIONS)).toBe("/tmp/photo.heic");
	});
});
