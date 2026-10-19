import type { InboundImage } from "../channels/types.ts";
import { attachmentRejection } from "../core/message-images.ts";

/** `preview` (base64 PNG thumbnail) is display-only and never sent. */
export type StagedImage = InboundImage & { readonly id: number; readonly bytes: number; readonly preview?: string };
export const imageMarker = (id: number): string => `[Image${id}]`;

/** Draft-scoped registry. The editor text, not registry membership, determines what is sent.
 * Deleted images remain resolvable for the editor's undo/kill ring until the draft is submitted.
 * IDs never alias across drafts. Pending sends own their snapshot independently of this registry.
 */
export class ComposerAttachments {
	#items = new Map<number, StagedImage>();
	#nextId = 1;
	#literalIds = new Set<number>();

	get markers(): readonly string[] {
		return [...this.#items.keys()].map(imageMarker);
	}

	/** Reserve literal IDs even after deletion: undo must not turn old prose into an image. */
	observe(raw: string): void {
		for (const match of raw.matchAll(/\[Image([1-9]\d*)\]/g)) {
			const id = Number(match[1]);
			if (!this.#items.has(id)) this.#literalIds.add(id);
		}
	}

	resolve(raw: string): { text: string; images: StagedImage[] } {
		const images = new Map<number, StagedImage>();
		const text = raw.replace(/\[Image([1-9]\d*)\]/g, (token, id: string) => {
			const image = this.#items.get(Number(id));
			if (image === undefined) return token;
			images.set(image.id, image);
			return "";
		});
		return { text, images: [...images.values()] };
	}

	add(image: InboundImage, raw: string, reserved: readonly StagedImage[] = [], preview?: string): StagedImage | string {
		const rejection = attachmentRejection([...reserved, ...this.resolve(raw).images], image);
		if (rejection !== undefined) return rejection;
		// A pre-existing unknown literal must not suddenly become an attachment.
		this.observe(raw);
		while (this.#literalIds.has(this.#nextId)) this.#nextId++;
		const staged: StagedImage = { mimeType: image.mimeType, data: image.data, id: this.#nextId++, bytes: Buffer.byteLength(image.data, "base64"), ...(preview === undefined ? {} : { preview }) };
		this.#items.set(staged.id, staged);
		return staged;
	}

	/** Merge a failed send into, never replace, the concurrent draft registry. */
	restore(items: readonly StagedImage[]): void {
		for (const image of items) this.#items.set(image.id, image);
	}

	clear(): void {
		this.#items.clear();
	}
}

export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
/** macOS converts these through AppKit (see clipboard.ts), so a pasted HEIC photo or TIFF also attaches. */
export const MACOS_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([...IMAGE_EXTENSIONS, ".heic", ".heif", ".tif", ".tiff", ".bmp"]);

/**
 * One shell word as terminals paste a dropped or copied file: backslash escapes (Ghostty, iTerm2,
 * Terminal.app escape spaces), or a single- or double-quoted whole word. Returns undefined when the
 * text is not exactly one word, so prose with spaces never turns into a path.
 */
function unquoteShellWord(text: string): string | undefined {
	const quote = text[0];
	if ((quote === "'" || quote === '"') && text.length >= 2 && text.endsWith(quote)) {
		const inner = text.slice(1, -1);
		return inner.includes(quote) ? undefined : inner;
	}
	let word = "";
	for (let index = 0; index < text.length; index++) {
		const char = text[index]!;
		if (char === "\\" && index + 1 < text.length) word += text[++index];
		else if (char === " " || char === "\t" || char === "'" || char === '"') return undefined;
		else word += char;
	}
	return word;
}

/**
 * The single absolute path a bracketed paste carries, when it is nothing but that and the extension
 * names a supported image format. Accepts one shell-escaped or quoted path (macOS screenshot names
 * contain spaces) and a file:// URL; any other whitespace, multiple lines or non-image extension
 * returns undefined and the paste flows to the editor untouched. Existence, size and magic bytes are
 * checked later, so this predicate stays pure and total.
 */
export function imagePathFromPaste(text: string, extensions: ReadonlySet<string> = IMAGE_EXTENSIONS): string | undefined {
	const trimmed = text.trim();
	if (trimmed === "" || /[\r\n]/.test(trimmed)) return undefined;
	let path = unquoteShellWord(trimmed);
	if (path?.startsWith("file://")) {
		try {
			const url = new URL(path);
			path = url.host === "" || url.host === "localhost" ? decodeURIComponent(url.pathname) : undefined;
		} catch {
			return undefined;
		}
	}
	if (path === undefined || !path.startsWith("/")) return undefined;
	const dot = path.lastIndexOf(".");
	if (dot === -1 || path.lastIndexOf("/") > dot) return undefined;
	return extensions.has(path.slice(dot).toLowerCase()) ? path : undefined;
}
