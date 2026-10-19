import { imageMime } from "../extensions/images.ts";
import { chooseImageMime, MESSAGE_IMAGE_LIMITS, type MessageImageMime } from "../core/message-images.ts";

/**
 * Reading the system clipboard from inside the TUI, for terminals without kitty's OSC 5522 (ghostty
 * today). Wayland goes through wl-clipboard's type listing so we pick the best format instead of
 * guessing; X11 goes through xclip's TARGETS listing the same way; macOS goes through AppKit's
 * NSPasteboard (via `osascript -l JavaScript`) for images and pbpaste for text. Every spawn is asynchronous with a
 * hard timeout, so a hung clipboard daemon can never freeze the render loop (oh-my-pi #4235).
 *
 * The strategy is total: every path returns an image, or null meaning "no image here" — the caller
 * falls back to text or reports an empty clipboard. Platform probing is read from the environment at
 * call time so tests can pin it.
 */

/** `preview` is an optional small PNG thumbnail for terminals whose image protocol only draws PNG (kitty). */
export type ClipboardImage = { readonly data: Uint8Array; readonly mimeType: MessageImageMime; readonly preview?: Uint8Array };

/** One bounded subprocess capture; throws on non-zero exit, timeout or missing binary. */
export type ClipboardSpawn = (command: readonly string[], options?: { bytes?: boolean; timeoutMs?: number }) => Promise<string | Uint8Array>;

export const CLIPBOARD_SPAWN_TIMEOUT_MS = 2000;
/** Re-encoding a Retina screenshot or HEIC photo takes longer than a plain clipboard read. */
export const MACOS_IMAGE_TIMEOUT_MS = 8000;
/** Longest edge of the composer thumbnail; the preview box is at most 24x6 cells. */
export const PREVIEW_MAX_PX = 480;

export const defaultClipboardSpawn: ClipboardSpawn = async (command, options = {}) => {
	const proc = Bun.spawn([...command], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
	let timedOut = false;
	const timeoutMs = options.timeoutMs ?? CLIPBOARD_SPAWN_TIMEOUT_MS;
	const timer = setTimeout(() => {
		timedOut = true;
		proc.kill();
	}, timeoutMs);
	timer.unref?.();
	try {
		const stdout = options.bytes
			? new Uint8Array(await new Response(proc.stdout).arrayBuffer())
			: await new Response(proc.stdout).text();
		await proc.exited;
		if (timedOut) throw new Error(`${command[0]} timed out after ${timeoutMs}ms`);
		if (proc.exitCode !== 0) throw new Error(`${command[0]} exited with code ${proc.exitCode}`);
		return stdout;
	} finally {
		clearTimeout(timer);
	}
};

const offeredMimes = async (spawn: ClipboardSpawn, list: readonly string[]): Promise<string[]> => {
	try {
		const stdout = await spawn(list);
		return typeof stdout === "string" ? stdout.split(/\r?\n/) : [];
	} catch {
		return [];
	}
};

const readBytes = async (spawn: ClipboardSpawn, command: readonly string[]): Promise<Uint8Array | undefined> => {
	try {
		const stdout = await spawn(command, { bytes: true });
		return stdout instanceof Uint8Array && stdout.byteLength > 0 ? stdout : undefined;
	} catch {
		return undefined;
	}
};

/**
 * The image on the system clipboard, or null when neither display server offers one. Selection is the
 * shared priority order (png > jpeg > webp > gif), so every entry point prefers the same bytes.
 */
export async function readClipboardImage(spawn: ClipboardSpawn = defaultClipboardSpawn, platform: NodeJS.Platform = process.platform): Promise<ClipboardImage | null> {
	if (platform === "darwin") return readMacImage(spawn, "");
	if (process.env.WAYLAND_DISPLAY) {
		const offered = await offeredMimes(spawn, ["wl-paste", "--list-types"]);
		const mimeType = chooseImageMime(offered);
		if (mimeType) {
			const data = await readBytes(spawn, ["wl-paste", "--type", mimeType]);
			if (data) return { data, mimeType };
		}
	}
	if (process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
		const offered = await offeredMimes(spawn, ["xclip", "-selection", "clipboard", "-t", "TARGETS", "-o"]);
		const mimeType = chooseImageMime(offered);
		if (mimeType) {
			const data = await readBytes(spawn, ["xclip", "-selection", "clipboard", "-t", mimeType, "-o"]);
			if (data) return { data, mimeType };
		}
	}
	return null;
}

/** The clipboard's plain text, or null when no display server can serve it. */
export async function readClipboardText(spawn: ClipboardSpawn = defaultClipboardSpawn, platform: NodeJS.Platform = process.platform): Promise<string | null> {
	if (platform === "darwin") {
		try {
			return await spawn(["pbpaste"]) as string;
		} catch {
			return null;
		}
	}
	if (process.env.WAYLAND_DISPLAY) {
		try {
			return await spawn(["wl-paste", "--no-newline"]) as string;
		} catch {
			return null;
		}
	}
	if (process.env.DISPLAY) {
		try {
			return await spawn(["xclip", "-selection", "clipboard", "-o"]) as string;
		} catch {
			return null;
		}
	}
	return null;
}

/** The image bytes of an existing file whose path was pasted, or undefined when its magic bytes are not a supported image format. */
export async function clipboardImageFromFile(path: string, read: (path: string) => Promise<Uint8Array> = fileBytes): Promise<{ data: Uint8Array; mimeType: MessageImageMime } | undefined> {
	let bytes: Uint8Array;
	try {
		bytes = await read(path);
	} catch {
		return undefined; // missing or unreadable: not a paste this feature owns
	}
	const mimeType = imageMime(bytes) as MessageImageMime | undefined;
	return mimeType !== undefined ? { data: bytes, mimeType } : undefined;
}

/**
 * The pasted-path entry point: on macOS the file goes through AppKit first, so HEIC/TIFF photos and
 * images over the per-image limit are re-encoded instead of rejected; elsewhere (or when AppKit cannot
 * decode it) the file's own bytes are used as-is.
 */
export async function pastedImageFile(path: string, spawn: ClipboardSpawn = defaultClipboardSpawn, platform: NodeJS.Platform = process.platform): Promise<ClipboardImage | undefined> {
	if (platform === "darwin") {
		const image = await readMacImage(spawn, `file:${path}`);
		if (image !== null) return image;
	}
	return clipboardImageFromFile(path);
}

/**
 * AppKit pasteboard/file reader run by `osascript -l JavaScript`. argv: max bytes, thumbnail edge,
 * source ("" = general pasteboard, "pb:<name>" = named pasteboard, "file:<path>" = image file).
 * Prints "<base64 image>\n<base64 PNG thumbnail>" or nothing when there is no decodable image.
 * Order on the pasteboard: a copied image file (Finder) beats its icon, then public.png, then any
 * NSImage-readable data (TIFF from Preview, screenshots). A supported original that fits is kept
 * byte-for-byte; otherwise PNG, then JPEG, then progressively downscaled JPEG until it fits.
 */
export const MACOS_IMAGE_SCRIPT = `ObjC.import("AppKit");
function run(argv) {
	var maxBytes = Number(argv[0]), thumbPx = Number(argv[1]), source = argv[2] || "";
	var none = function (d) { return d === null || d === undefined || d.isNil() || d.length === 0; };
	var raw = null;
	if (source.indexOf("file:") === 0) raw = $.NSData.dataWithContentsOfFile(source.slice(5));
	else {
		var pb = source.indexOf("pb:") === 0 ? $.NSPasteboard.pasteboardWithName(source.slice(3)) : $.NSPasteboard.generalPasteboard;
		var urls = pb.readObjectsForClassesOptions($([$.NSURL]), $({ NSPasteboardURLReadingFileURLsOnlyKey: true }));
		if (!urls.isNil() && urls.count > 0) {
			var fromFile = $.NSData.dataWithContentsOfURL(urls.objectAtIndex(0));
			if (!none(fromFile) && !$.NSBitmapImageRep.imageRepWithData(fromFile).isNil()) raw = fromFile;
		}
		if (none(raw)) raw = pb.dataForType("public.png");
		if (none(raw) && pb.canReadObjectForClassesOptions($([$.NSImage]), $({}))) {
			var image = $.NSImage.alloc.initWithPasteboard(pb);
			if (!image.isNil()) raw = image.TIFFRepresentation;
		}
	}
	if (none(raw)) return "";
	var rep = $.NSBitmapImageRep.imageRepWithData(raw);
	if (rep.isNil()) return "";
	var width = Number(rep.pixelsWide), height = Number(rep.pixelsHigh);
	var encode = function (r, type, props) { return r.representationUsingTypeProperties(type, $(props)); };
	var scaled = function (w, h) {
		var out = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(null, w, h, 8, 4, true, false, "NSDeviceRGBColorSpace", 0, 0);
		var context = $.NSGraphicsContext.graphicsContextWithBitmapImageRep(out);
		$.NSGraphicsContext.saveGraphicsState;
		$.NSGraphicsContext.setCurrentContext(context);
		context.imageInterpolation = $.NSImageInterpolationHigh;
		rep.drawInRectFromRectOperationFractionRespectFlippedHints($.NSMakeRect(0, 0, w, h), $.NSZeroRect, $.NSCompositingOperationCopy, 1, false, $());
		$.NSGraphicsContext.restoreGraphicsState;
		return out;
	};
	var head = raw.length >= 12 ? ObjC.unwrap($.NSString.alloc.initWithDataEncoding(raw.subdataWithRange($.NSMakeRange(0, 12)), $.NSISOLatin1StringEncoding)) : "";
	var supported = head.indexOf("\\u0089PNG") === 0 || head.indexOf("\\u00ff\\u00d8\\u00ff") === 0 || head.indexOf("GIF8") === 0 || (head.indexOf("RIFF") === 0 && head.slice(8, 12) === "WEBP");
	var full = supported && raw.length <= maxBytes ? raw : null;
	if (full === null) {
		var png = encode(rep, $.NSBitmapImageFileTypePNG, {});
		if (!none(png) && png.length <= maxBytes) full = png;
	}
	for (var attempt = 0, scale = 1; full === null && attempt < 8; attempt++, scale *= 0.75) {
		var jpeg = encode(scale === 1 ? rep : scaled(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))), $.NSBitmapImageFileTypeJPEG, { NSImageCompressionFactor: 0.85 });
		if (!none(jpeg) && jpeg.length <= maxBytes) full = jpeg;
	}
	if (full === null) return "";
	var t = Math.min(1, thumbPx / Math.max(width, height, 1));
	var thumb = encode(t < 1 ? scaled(Math.max(1, Math.round(width * t)), Math.max(1, Math.round(height * t))) : rep, $.NSBitmapImageFileTypePNG, {});
	return ObjC.unwrap(full.base64EncodedStringWithOptions(0)) + "\\n" + (none(thumb) ? "" : ObjC.unwrap(thumb.base64EncodedStringWithOptions(0)));
}`;

/** One AppKit read; null for no image, a failing osascript, or bytes that are not a supported format. */
async function readMacImage(spawn: ClipboardSpawn, source: string): Promise<ClipboardImage | null> {
	let stdout: string | Uint8Array;
	try {
		stdout = await spawn(["osascript", "-l", "JavaScript", "-e", MACOS_IMAGE_SCRIPT, String(MESSAGE_IMAGE_LIMITS.maxBytesPerImage), String(PREVIEW_MAX_PX), source], { timeoutMs: MACOS_IMAGE_TIMEOUT_MS });
	} catch {
		return null;
	}
	if (typeof stdout !== "string") return null;
	const [full = "", thumb = ""] = stdout.trim().split("\n");
	if (full === "") return null;
	const data = new Uint8Array(Buffer.from(full, "base64"));
	const mimeType = imageMime(data) as MessageImageMime | undefined;
	if (mimeType === undefined) return null;
	const preview = thumb === "" ? undefined : new Uint8Array(Buffer.from(thumb, "base64"));
	return preview !== undefined && imageMime(preview) === "image/png" ? { data, mimeType, preview } : { data, mimeType };
}

async function fileBytes(path: string): Promise<Uint8Array> {
	const file = Bun.file(path);
	if (!(await file.exists())) throw new Error(`${path} does not exist`);
	return new Uint8Array(await file.arrayBuffer());
}
