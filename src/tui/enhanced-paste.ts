import { IMAGE_MIME_PRIORITY, MESSAGE_IMAGE_LIMITS, base64Bytes, chooseImageMime, type MessageImageMime } from "../core/message-images.ts";
import type { InboundImage } from "../channels/types.ts";

/**
 * kitty's enhanced clipboard paste (private mode 5522). oh-my-pi pioneered this client; dinobot
 * carries the same wire contract with two additions: an inactivity timeout that returns the machine to
 * idle when a DONE never arrives, and an incremental byte bound that aborts an oversize read instead of
 * buffering it whole. Ghostty does not implement 5522 today, so its pastes keep arriving as bracketed
 * text; the controller is harmless there (enable is ignored, no packets ever arrive).
 *
 * State machine (one controller instance; `feed` is called before any focused component sees the bytes):
 *
 *   idle -- OK(read) --> listing -- DONE --> choose -- write read request --> reading -- DONE --> idle (+ effect)
 *     ^                   | no usable type --> idle (+ status)                  |
 *     +-------- error status | timeout | encoded length over the bound <--------+
 *
 * Invariants:
 *  I1 (termination) every handlePacket path either advances within a phase or assigns #state = idle
 *     before its effect, so no packet sequence leaves a non-idle machine without a pending response;
 *     the timeout returns a wedged exchange to idle within timeoutMs.
 *  I2 (containment) chunks accumulate only while phase = reading, the packet's decoded mime equals the
 *     requested one, and the payload is non-empty; the summed encoded length never exceeds the bound
 *     ceil(maxBytes/3)*4, so buffered memory is bounded by ~4/3 of the per-image limit.
 *  I3 (pairing) the controller writes exactly one read request per completed listing, echoing the pw
 *     and name metadata the terminal asked for, and only after an OK acknowledged the previous cycle.
 */

const OSC5522_PREFIX = "\x1b]5522;";
const OSC_TERMINATOR_ST = "\x1b\\";
const OSC_TERMINATOR_BEL = "\x07";
const PASTE_EVENT_NAME_BASE64 = Buffer.from("Paste event", "utf8").toString("base64");
const TEXT_MIME_TYPE = "text/plain";
/** Kitty's "list the available MIME types" sentinel; see TARGETS_MIME in kitty/clipboard.py. */
const MIME_LISTING_TARGET = ".";

/** Encoded-character bound whose decoded size can never exceed the per-image byte limit. */
const MAX_ENCODED_CHARS = Math.ceil(MESSAGE_IMAGE_LIMITS.maxBytesPerImage / 3) * 4;
/** How long a half-finished exchange may sit before the machine gives up and returns to idle. */
export const DEFAULT_PASTE_TIMEOUT_MS = 5000;

export interface Osc5522Packet {
	metadata: Map<string, string>;
	payload: string;
}

type PasteReadKind = "image" | "text";

interface PasteListingState {
	phase: "listing";
	mimes: string[];
	kittyDotPayload?: true;
	pw?: string;
	loc?: string;
}

interface PasteReadState {
	phase: "reading";
	kind: PasteReadKind;
	mimeType: string;
	encodedChars: number;
	chunks: string[];
}

type PasteState = PasteListingState | PasteReadState;

export interface EnhancedPasteHandlers {
	write(data: string): void;
	pasteText(text: string): void;
	pasteImage(image: InboundImage): void | Promise<void>;
	showStatus(message: string): void;
}

function decodeBase64Utf8(value: string): string | undefined {
	try {
		return Buffer.from(value, "base64").toString("utf8");
	} catch {
		return undefined;
	}
}

function parseMetadata(raw: string): Map<string, string> {
	const metadata = new Map<string, string>();
	for (const part of raw.split(":")) {
		const eq = part.indexOf("=");
		if (eq <= 0) continue;
		metadata.set(part.slice(0, eq), part.slice(eq + 1));
	}
	return metadata;
}

export function parseOsc5522Packet(data: string): Osc5522Packet | undefined {
	if (!data.startsWith(OSC5522_PREFIX)) return undefined;
	if (!data.endsWith(OSC_TERMINATOR_ST) && !data.endsWith(OSC_TERMINATOR_BEL)) return undefined;
	const bodyEnd = data.endsWith(OSC_TERMINATOR_BEL) ? data.length - 1 : data.length - OSC_TERMINATOR_ST.length;
	const body = data.slice(OSC5522_PREFIX.length, bodyEnd);
	const separator = body.indexOf(";");
	const metadataRaw = separator === -1 ? body : body.slice(0, separator);
	const payload = separator === -1 ? "" : body.slice(separator + 1);
	return { metadata: parseMetadata(metadataRaw), payload };
}

function choosePasteMime(mimes: readonly string[]): { kind: PasteReadKind; mimeType: string } | undefined {
	for (const mimeType of IMAGE_MIME_PRIORITY) {
		if (mimes.includes(mimeType)) return { kind: "image", mimeType };
	}
	return mimes.includes(TEXT_MIME_TYPE) ? { kind: "text", mimeType: TEXT_MIME_TYPE } : undefined;
}

export class EnhancedPasteController {
	#state: PasteState | undefined;
	#buffer: string | undefined;
	#timer: ReturnType<typeof setTimeout> | undefined;
	readonly #timeoutMs: number;
	readonly #handlers: EnhancedPasteHandlers;

	constructor(handlers: EnhancedPasteHandlers, options: { timeoutMs?: number } = {}) {
		this.#handlers = handlers;
		this.#timeoutMs = options.timeoutMs ?? DEFAULT_PASTE_TIMEOUT_MS;
	}

	enable(): void {
		this.#handlers.write("\x1b[?5522h");
	}

	disable(): void {
		this.#handlers.write("\x1b[?5522l");
		this.#reset();
	}

	/**
	 * Offer one stdin chunk to the controller. Returns null when the bytes were consumed (a complete
	 * or partial 5522 sequence); otherwise returns the bytes the caller must still dispatch itself.
	 * Fragmented packets are buffered until a terminator completes them, and bytes glued after a
	 * terminator are handed back, so a keystroke riding the end of a paste still reaches the editor.
	 */
	feed(data: string): string | null {
		if (this.#buffer === undefined && !data.startsWith(OSC5522_PREFIX)) return data;
		let current = (this.#buffer ?? "") + data;
		this.#buffer = undefined;
		for (;;) {
			if (!current.startsWith(OSC5522_PREFIX)) return current;
			const end = current.indexOf(OSC_TERMINATOR_BEL, OSC5522_PREFIX.length);
			const endSt = current.indexOf(OSC_TERMINATOR_ST, OSC5522_PREFIX.length);
			const cut = end === -1 ? endSt : endSt === -1 ? end : Math.min(end, endSt);
			if (cut === -1) {
				this.#buffer = current;
				return null;
			}
			const terminator = current[cut] === OSC_TERMINATOR_BEL ? OSC_TERMINATOR_BEL : OSC_TERMINATOR_ST;
			const packet = current.slice(0, cut + terminator.length);
			void this.#handlePacket(parseOsc5522Packet(packet));
			current = current.slice(packet.length);
			if (current === "") return null;
		}
	}

	#arm(): void {
		this.#clearTimer();
		if (this.#timeoutMs <= 0) return;
		this.#timer = setTimeout(() => {
			if (this.#state !== undefined || this.#buffer !== undefined) {
				this.#handlers.showStatus("Clipboard paste timed out");
			}
			this.#reset();
		}, this.#timeoutMs);
		this.#timer.unref?.();
	}

	#clearTimer(): void {
		if (this.#timer !== undefined) clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	#reset(): void {
		this.#state = undefined;
		this.#buffer = undefined;
		this.#clearTimer();
	}

	async #handlePacket(packet: Osc5522Packet | undefined): Promise<void> {
		if (packet === undefined) {
			this.#handlers.showStatus("Malformed clipboard paste packet");
			this.#reset();
			return;
		}
		this.#arm();
		if (packet.metadata.get("type") !== "read") return;

		const status = packet.metadata.get("status");
		if (status === "OK") {
			if (this.#state?.phase === "reading") return;
			const loc = packet.metadata.get("loc");
			const pw = packet.metadata.get("pw");
			this.#state = {
				phase: "listing",
				mimes: [],
				...(pw !== undefined ? { pw } : {}),
				...(loc === "primary" ? { loc } : {}),
			};
			return;
		}
		if (status === "DATA") {
			this.#handleData(packet);
			return;
		}
		if (status === "DONE") {
			await this.#handleDone();
			return;
		}
		if (status !== undefined) {
			this.#handlers.showStatus(`Clipboard paste failed: ${status}`);
			this.#reset();
		}
	}

	#handleData(packet: Osc5522Packet): void {
		const state = this.#state;
		if (!state) return;
		const encodedMime = packet.metadata.get("mime");
		if (!encodedMime) return;
		const mimeType = decodeBase64Utf8(encodedMime);
		if (!mimeType) return;

		if (state.phase === "listing") {
			// Kitty packs the available types into one DATA packet with mime="." (fulfill_read_request in
			// kitty/clipboard.py); the ancillary spec sends one DATA packet per type with an empty payload.
			// Support both: the dot sentinel only counts when it carries a listing payload.
			if (mimeType === MIME_LISTING_TARGET) {
				if (!packet.payload) return;
				const listing = decodeBase64Utf8(packet.payload);
				if (!listing) return;
				state.kittyDotPayload = true;
				for (const candidate of listing.split(/\s+/)) {
					if (candidate && candidate !== MIME_LISTING_TARGET) state.mimes.push(candidate);
				}
				return;
			}
			state.mimes.push(mimeType);
			return;
		}

		if (state.mimeType !== mimeType || !packet.payload) return;
		state.encodedChars += packet.payload.length;
		if (state.encodedChars > MAX_ENCODED_CHARS) {
			this.#handlers.showStatus("Clipboard image is larger than the message limit");
			this.#reset();
			return;
		}
		state.chunks.push(packet.payload);
	}

	async #handleDone(): Promise<void> {
		const state = this.#state;
		if (!state) return;
		if (state.phase === "listing") {
			this.#finishListing(state);
			return;
		}
		this.#state = undefined;
		this.#clearTimer();
		const bytes = Buffer.from(state.chunks.join(""), "base64");
		if (bytes.byteLength === 0) {
			this.#handlers.showStatus("Clipboard paste was empty");
			return;
		}
		if (state.kind === "text") {
			this.#handlers.pasteText(bytes.toString("utf8"));
			return;
		}
		const data = bytes.toString("base64");
		if (base64Bytes(data) === undefined) {
			this.#handlers.showStatus("Clipboard image payload was not valid base64");
			return;
		}
		await this.#handlers.pasteImage({ mimeType: state.mimeType as MessageImageMime, data });
	}

	#finishListing(state: PasteListingState): void {
		const selected = choosePasteMime(state.mimes);
		if (!selected) {
			this.#state = undefined;
			this.#clearTimer();
			this.#handlers.showStatus("Clipboard paste has no supported text or image data");
			return;
		}
		this.#state = { phase: "reading", kind: selected.kind, mimeType: selected.mimeType, encodedChars: 0, chunks: [] };

		const encodedMime = Buffer.from(selected.mimeType, "utf8").toString("base64");
		const metadata = ["type=read"];
		if (state.loc) metadata.push(`loc=${state.loc}`);
		if (state.pw) metadata.push(`pw=${state.pw}`, `name=${PASTE_EVENT_NAME_BASE64}`);
		if (state.kittyDotPayload) {
			this.#handlers.write(`${OSC5522_PREFIX}${metadata.join(":")};${encodedMime}${OSC_TERMINATOR_BEL}`);
			return;
		}
		metadata.push(`mime=${encodedMime}`);
		this.#handlers.write(`${OSC5522_PREFIX}${metadata.join(":")}${OSC_TERMINATOR_BEL}`);
	}
}
