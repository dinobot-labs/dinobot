import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import baseline from "../../SOUL.md" with { type: "text" };

export type SoulSnapshot = { text: string; digest: string; diagnostics: string[]; valid: boolean };

const MAX_WORKSPACE_BYTES = 64 * 1024;
const baselineBytes = Buffer.from(baseline, "utf8");

/** Markdown blocks (blank-line separated) with BOM, CRLF and trailing spaces normalized. */
function soulBlocks(text: string): string[] {
	return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split(/\n[ \t]*\n/)
		.map((block) => block.split("\n").map((line) => line.trimEnd()).join("\n").trim())
		.filter(Boolean);
}
const baselineBlocks = new Set(soulBlocks(baseline));
const headingLevel = (block: string) => /^(#{1,6})\s/.exec(block)?.[1]?.length;

/**
 * The workspace policy minus blocks the baseline already states, so a copy of the baseline (for
 * example a CRLF checkout of SOUL.md, or an older copy of it) is not injected twice. Headings are
 * kept only above a remaining block. Empty when nothing new remains.
 */
export function workspaceAdditions(workspaceText: string): string {
	const out: string[] = [];
	let pending: { level: number; block: string }[] = [];
	for (const block of soulBlocks(workspaceText)) {
		const level = headingLevel(block);
		if (level !== undefined && !block.includes("\n")) {
			pending = pending.filter((heading) => heading.level < level);
			pending.push({ level, block });
			continue;
		}
		if (baselineBlocks.has(block)) continue;
		out.push(...pending.map((heading) => heading.block), block);
		pending = [];
	}
	return out.join("\n\n");
}

/** Load only the canonical working directory's additive policy, never ancestor policies. */
export async function loadSoul(cwd: string): Promise<SoulSnapshot> {
	const diagnostics: string[] = [];
	let canonicalCwd = resolve(cwd);
	let workspaceBytes = Buffer.alloc(0);
	let workspaceText = "";
	let state = "missing";
	let size: number | undefined;
	try {
		canonicalCwd = await realpath(canonicalCwd);
	} catch (error) {
		diagnostics.push(`SOUL cwd resolution failed for ${canonicalCwd}: ${String(error)}`);
	}
	if (diagnostics.length === 0) {
		const path = join(canonicalCwd, "SOUL.md");
		try {
			// Nonblocking open plus a regular-file check prevents FIFOs/devices from hanging a turn.
			const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
			state = "present";
			try {
				const stat = await file.stat();
				size = stat.size;
				if (!stat.isFile()) throw new Error("expected a regular file");
				const buffer = Buffer.alloc(MAX_WORKSPACE_BYTES + 1);
				let length = 0;
				while (length < buffer.length) {
					const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
					if (bytesRead === 0) break;
					length += bytesRead;
				}
				workspaceBytes = buffer.subarray(0, length);
				if (length > MAX_WORKSPACE_BYTES || stat.size > MAX_WORKSPACE_BYTES) {
					state = "oversize";
					diagnostics.push(`SOUL read failed for ${path}: exceeds ${MAX_WORKSPACE_BYTES} bytes`);
				} else {
					try {
						workspaceText = new TextDecoder("utf-8", { fatal: true }).decode(workspaceBytes);
					} catch {
						state = "invalid-utf8";
						diagnostics.push(`SOUL read failed for ${path}: invalid UTF-8`);
					}
				}
			} finally {
				await file.close();
			}
		} catch (error) {
			if (state !== "missing" || (error as NodeJS.ErrnoException).code !== "ENOENT") {
				state = "unreadable";
				diagnostics.push(`SOUL read failed for ${path}: ${String(error)}`);
			}
		}
	}
	const valid = diagnostics.length === 0;
	// Hash bytes, not decoded text: e.g. a UTF-8 BOM changes identity even if rendering is unchanged.
	const digest = createHash("sha256")
		.update(JSON.stringify({ version: 1, cwd: canonicalCwd, state, size, valid, baselineLength: baselineBytes.length, workspaceLength: workspaceBytes.length }))
		.update(baselineBytes)
		.update(workspaceBytes)
		.digest("hex");
	const additive = valid ? workspaceAdditions(workspaceText) : "";
	return {
		text: additive ? `${baseline.trimEnd()}\n\n## Workspace SOUL (additive)\n\n${additive}\n` : baseline,
		digest,
		diagnostics,
		valid,
	};
}
