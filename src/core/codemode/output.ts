import type { ToolRegistration } from "@earendil-works/pi-durable";
import { CODEMODE_LIMITS } from "./protocol.ts";

/** Bound streamed tool output without failing the command producing it. */
export class ToolOutput {
	private text = "";
	private decoder = new TextDecoder();
	private truncated = false;
	constructor(private limits: ToolRegistration["outputLimits"]) {}
	push(chunk: string | Uint8Array) {
		const incoming = typeof chunk === "string" ? this.decoder.decode() + chunk : this.decoder.decode(chunk, { stream: true });
		const maxBytes = Math.min(this.limits?.maxBytes ?? 50 * 1024, CODEMODE_LIMITS.maxOutputBytes);
		const maxLines = this.limits?.maxLines ?? 2000;
		const tail = this.limits?.retain === "tail";
		if (this.truncated && !tail) return;
		const lines = (this.text + incoming).split("\n");
		// Do not count the empty sentinel following a terminating newline as a line.
		const trailing = lines.at(-1) === "";
		if (trailing) lines.pop();
		if (lines.length > maxLines) this.truncated = true;
		this.text = (tail ? lines.slice(-maxLines) : lines.slice(0, maxLines)).join("\n") + (trailing ? "\n" : "");
		const bytes = Buffer.from(this.text);
		if (bytes.length > maxBytes) {
			this.truncated = true;
			let start = tail ? bytes.length - maxBytes : 0;
			let end = tail ? bytes.length : maxBytes;
			while (start < end && (bytes[start]! & 0xc0) === 0x80) start++;
			while (end < bytes.length && end > start && (bytes[end]! & 0xc0) === 0x80) end--;
			this.text = bytes.subarray(start, end).toString("utf8");
		}
	}
	finish() {
		this.push(this.decoder.decode());
		return { text: this.text, truncated: this.truncated };
	}
}
