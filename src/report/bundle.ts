import type { JsonValue } from "@earendil-works/chord";
import { parseInput } from "../core/input.ts";
import { redactValue, type RedactionCounts } from "./redact.ts";

/**
 * Projection of a thread's visible export (already stripped of system prompts, reasoning and binary
 * payloads by `visibleValue`) into report entries, by tier:
 *   T1 automatic: the root conversation only, the last AUTO_TURNS user turns, strings in tool calls and
 *      results capped at TOOL_CHARS.
 *   T2 manual: the whole thread including subagent conversations, strings capped at STRING_CHARS.
 * Both: injected nudges dropped, senders pseudonymised, other participants' text removed when the
 * report comes from a shared channel, then deep secret/PII redaction.
 */
export const AUTO_TURNS = 10;
export const TOOL_CHARS = 2_048;
export const STRING_CHARS = 64 * 1024;

export type Tier = "T1" | "T2";

export type ProjectOptions = {
	readonly tier: Tier;
	readonly root: number;
	/** The reporter's channel user id; their turns stay, everyone else's text is removed. */
	readonly reporter: string;
	/** Shared channel: other participants' messages and whole-thread summaries are excluded. */
	readonly excludeOthers: boolean;
};

export type Projection = {
	readonly entries: Record<string, unknown>[];
	readonly redactions: RedactionCounts;
	readonly omitted: { nudges: number; participants: number; summaries: number; truncated: number; outsideWindow: number };
	/** Id of the last user turn in the projection: the trigger for automatic reports. */
	readonly lastUserEntryId?: number;
};

type Entry = { id?: number; conversationId?: number; kind?: string; model?: JsonValue; data?: JsonValue };

const isRecord = (v: unknown): v is Record<string, JsonValue> => typeof v === "object" && v !== null && !Array.isArray(v);

function truncateStrings(value: JsonValue, max: number, counter: { n: number }): JsonValue {
	if (typeof value === "string") {
		if (value.length <= max) return value;
		counter.n++;
		return `${value.slice(0, max)}…[truncated ${value.length - max} chars]`;
	}
	if (Array.isArray(value)) return value.map((v) => truncateStrings(v, max, counter));
	if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, truncateStrings(v, max, counter)]));
	return value;
}

function capToolCalls(message: JsonValue, counter: { n: number }): JsonValue {
	if (!isRecord(message) || !Array.isArray(message.content)) return message;
	return {
		...message,
		content: message.content.map((part) => (isRecord(part) && part.type === "toolCall" && part.arguments !== undefined ? { ...part, arguments: truncateStrings(part.arguments, TOOL_CHARS, counter) } : part)),
	};
}

/** Rewrite `<from user=…>` headers: reporter → "reporter", others → "participant-N" (text removed if excluded). */
function rewriteUserText(text: string, alias: (userId: string) => string, reporter: string, excludeOthers: boolean, stats: { participants: number }): string {
	const parsed = parseInput(text);
	if (!parsed) return text;
	const isReporter = parsed.userId === reporter;
	const header = `<from user="${alias(parsed.userId)}" channel="${parsed.channel}"/>\n`;
	if (!isReporter && excludeOthers) {
		stats.participants++;
		return `${header}[participant omitted]`;
	}
	return header + parsed.text;
}

function rewriteUserEntry(entry: Entry, rewrite: (text: string) => string): Entry {
	const model = entry.model;
	if (!Array.isArray(model)) return entry;
	return {
		...entry,
		model: model.map((message) => {
			if (!isRecord(message) || message.role !== "user") return message;
			const content = message.content;
			if (typeof content === "string") return { ...message, content: rewrite(content) };
			if (Array.isArray(content)) {
				return {
					...message,
					content: content.map((part, index) => (index === 0 && isRecord(part) && part.type === "text" && typeof part.text === "string" ? { ...part, text: rewrite(part.text) } : part)),
				};
			}
			return message;
		}),
	};
}

export function projectEntries(raw: readonly JsonValue[], options: ProjectOptions): Projection {
	const omitted = { nudges: 0, participants: 0, summaries: 0, truncated: 0, outsideWindow: 0 };
	const aliases = new Map<string, string>([[options.reporter, "reporter"]]);
	const alias = (userId: string) => {
		let name = aliases.get(userId);
		if (name === undefined) {
			name = `participant-${aliases.size}`;
			aliases.set(userId, name);
		}
		return name;
	};

	// Storage scans may return newest first; ids are monotonic, so sort into chronological order.
	const ordered = [...(raw as readonly Entry[])].sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
	let entries = ordered.filter((entry) => {
		if (typeof entry.kind === "string" && (entry.kind === "pi.system" || entry.kind.endsWith(".nudge"))) {
			omitted.nudges++;
			return false;
		}
		if (options.excludeOthers && entry.kind === "pi.compaction") {
			omitted.summaries++;
			return false;
		}
		return true;
	});

	if (options.tier === "T1") {
		const rootOnly = entries.filter((entry) => entry.conversationId === options.root);
		const userIndexes = rootOnly.flatMap((entry, index) => (entry.kind === "pi.user" ? [index] : []));
		const start = userIndexes.length > AUTO_TURNS ? (userIndexes[userIndexes.length - AUTO_TURNS] as number) : 0;
		omitted.outsideWindow = entries.length - (rootOnly.length - start);
		entries = rootOnly.slice(start);
	}

	const counter = { n: 0 };
	const redactions: RedactionCounts = {};
	let lastUserEntryId: number | undefined;
	const projected = entries.map((entry) => {
		let next: Entry = entry.kind === "pi.user" || entry.kind === "pi.compaction" ? rewriteUserEntry(entry, (text) => rewriteUserText(text, alias, options.reporter, options.excludeOthers, omitted)) : entry;
		if (next.kind === "pi.user" && typeof next.id === "number" && next.conversationId === options.root) lastUserEntryId = next.id;
		if (options.tier === "T1" && next.kind === "pi.tool-result") {
			next = { ...next, ...(next.model !== undefined ? { model: truncateStrings(next.model, TOOL_CHARS, counter) } : {}), ...(next.data !== undefined ? { data: truncateStrings(next.data, TOOL_CHARS, counter) } : {}) };
		}
		if (options.tier === "T1" && next.kind === "pi.assistant" && Array.isArray(next.model)) {
			// Assistant prose stays whole; only tool-call arguments are capped.
			next = { ...next, model: next.model.map((message) => capToolCalls(message, counter)) };
		}
		const capped = truncateStrings(next as JsonValue, STRING_CHARS, counter);
		return redactValue(capped, redactions) as Record<string, unknown>;
	});
	omitted.truncated = counter.n;
	return { entries: projected, redactions, omitted, ...(lastUserEntryId !== undefined ? { lastUserEntryId } : {}) };
}
