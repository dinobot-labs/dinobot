import { OutputBuffer, type OutputSkip } from "@earendil-works/chord/output";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { CODEMODE_LIMITS } from "./protocol.ts";

/** Same streaming/UTF-8/skip semantics as durable, bounded additionally by the cell budget. */
export class ToolOutput {
	private readonly buffer: OutputBuffer;
	constructor(limits: ToolRegistration["outputLimits"]) {
		this.buffer = new OutputBuffer({ maxBytes: Math.min(limits?.maxBytes ?? 50 * 1024, CODEMODE_LIMITS.maxOutputBytes), maxLines: limits?.maxLines ?? 2000, retain: limits?.retain ?? "head" });
	}
	push(chunk: string | Uint8Array, skipped?: OutputSkip) { this.buffer.push(chunk, skipped); }
	snapshot() { const result = this.buffer.snapshot(); return { text: result.text, truncated: result.droppedBytes > 0 }; }
	finish() { this.buffer.end(); return this.snapshot(); }
}
