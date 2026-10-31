import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { type ConversationId, defineDoc, type EntryRecord, type Harness } from "@earendil-works/pi-durable";

/**
 * ask protocol state (ADR 0030). Records live on the orchestrator (main) conversation.
 * Resolution is single-assignment: exactly one CAS moves a record out of `open`.
 */

export type AskKind = "clarification" | "decision" | "acceptance" | "authority" | "conflict" | "external";
export type AskState = "open" | "answered" | "defaulted" | "withdrawn";
export type AskTarget = "main" | "human";

export type AskRecord = {
	id: string;
	/** Conversation that asked; `taskId` is the subagent id (sa-…) when a child asked. */
	from: { conversationId: ConversationId; taskId?: string };
	to: AskTarget;
	kind: AskKind;
	refs: string[];
	question: string;
	options?: string[];
	default: string;
	createdAt: number;
	deadlineAt: number;
	state: AskState;
	answer?: string;
	resolvedAt?: number;
	resolvedBy?: string;
	/** Human asks: the human message entry whose text answered. */
	sourceEntry?: number;
	/** Human ask that relays a child ask: resolving this resolves `relays` with the same answer. */
	relays?: string;
	/** An answer that arrived after the record was defaulted; a fact revision for later re-keying. */
	late?: { answer: string; at: number; by: string };
	/** DAG run this record belongs to (authority asks made with an active run, and ask-node records). */
	run?: string;
	/** Ask node that opened this record; absent for asks the orchestrator opened itself. */
	node?: string;
	/** Authority asks in a run: contract keys of `refs` (same order) the answer covers. */
	keys?: string[];
	/** Records an ask node opened: that node's key (contract, parents, facts) when it asked. */
	nodeKey?: string;
    /** Actual goal admission covered by a DAG authority question; absent legacy records are not upgraded by inference. */
    goalBinding?: { epoch:number; hash:string; conversationId?:string };
};

export const AsksDoc = defineDoc<{ asks: AskRecord[] }>({
	kind: "dinobot.asks", version: 1, scope: "conversation", history: "latest", fork: "initial",
	initial: () => ({ asks: [] }),
});

/** On a child conversation: who orchestrates it. Absent on top-level conversations. */
export const LinkDoc = defineDoc<{ parent?: ConversationId; runnerId?: string; taskId?: string }>({
	kind: "dinobot.subagent.link", version: 1, scope: "conversation", history: "latest", fork: "initial",
	initial: () => ({}),
});

export const HUMAN_KINDS: ReadonlySet<AskKind> = new Set<AskKind>(["clarification", "decision", "acceptance", "authority", "conflict", "external"]);
export const ASK_KINDS: readonly AskKind[] = ["clarification", "decision", "acceptance", "authority", "conflict", "external"];

export const HUMAN_MIN_OPTIONS = 2;
export const HUMAN_MAX_OPTIONS = 4;
/** Open decision/clarification asks to the human per conversation (ADR 0063). */
export const HUMAN_OPEN_CHOICE_LIMIT = 3;

/** Give an orchestrator at least one realistic model-turn window to answer. */
export const MAIN_DEADLINE_MIN_MS = 60_000;
export const MAIN_DEADLINE_MS = 15 * 60_000;
export const MAIN_DEADLINE_MAX_MS = 24 * 3_600_000;
export const HUMAN_DEADLINE_MS = 24 * 3_600_000;
export const HUMAN_DEADLINE_MAX_MS = 7 * 24 * 3_600_000;
export const AUTHORITY_DEFAULT = "deny";

export function canonicalQuestion(question: string): string {
	return question.trim().replace(/\s+/g, " ");
}

export function askId(main: ConversationId, from: ConversationId, kind: AskKind, refs: readonly string[], question: string): string {
	return createHash("sha256")
		.update(JSON.stringify([String(main), String(from), kind, [...refs].sort(), canonicalQuestion(question)]))
		.digest("hex")
		.slice(0, 32);
}

export function isTerminal(record: AskRecord): boolean {
	return record.state !== "open";
}

/**
 * Single-assignment resolution. Returns the record after the call; `changed` is true only for the
 * one caller that moved it out of `open`.
 */
export function resolveAsk(
	doc: { asks: AskRecord[] }, id: string, resolution: { state: Exclude<AskState, "open">; answer?: string; by: string; now: number },
): { record: AskRecord | undefined; changed: boolean } {
	const record = doc.asks.find((ask) => ask.id === id);
	if (!record) return { record: undefined, changed: false };
	if (isTerminal(record)) return { record, changed: false };
	record.state = resolution.state;
	if (resolution.answer !== undefined) record.answer = resolution.answer;
	record.resolvedAt = resolution.now;
	record.resolvedBy = resolution.by;
	return { record, changed: true };
}

/** Default every expired open record. Idempotent; returns the ids it moved. */
export function expireAsks(doc: { asks: AskRecord[] }, now: number): string[] {
	const expired: string[] = [];
	for (const record of doc.asks) {
		if (record.state === "open" && record.deadlineAt <= now) {
			resolveAsk(doc, record.id, { state: "defaulted", answer: record.default, by: "system:deadline", now });
			expired.push(record.id);
		}
	}
	return expired;
}

/**
 * Open subagent asks that main can still answer. A record past its deadline is excluded even before a commit defaults
 * it: its answer is already fixed to the default, so showing it as waiting would be stale.
 */
export function openAsksFrom(doc: { asks: AskRecord[] } | null | undefined, conversationIds: ReadonlySet<ConversationId>, now = Date.now()): AskRecord[] {
	return (doc?.asks ?? []).filter((ask) => ask.state === "open" && ask.deadlineAt > now && ask.to === "main" && conversationIds.has(ask.from.conversationId));
}

/** Withdraw every open ask of a child that was cancelled: nobody waits for its answer any more. Returns the ids it moved. */
export function withdrawAsksFrom(doc: { asks: AskRecord[] }, conversationId: ConversationId, by: string, now: number): string[] {
	const moved: string[] = [];
	for (const record of doc.asks) {
		if (record.state === "open" && record.from.conversationId === conversationId && resolveAsk(doc, record.id, { state: "withdrawn", by, now }).changed) moved.push(record.id);
	}
	return moved;
}

export function describeAsk(ask: AskRecord): string {
	const who = ask.from.taskId ?? ask.from.conversationId;
	const lines = [
		`ask ${ask.id} from ${who} [${ask.kind}] → ${ask.to}: ${ask.question}`,
		...(ask.options?.length ? [`  options: ${ask.options.join(" | ")}`] : []),
		`  default: ${ask.default}; deadline: ${new Date(ask.deadlineAt).toISOString()}; state: ${ask.state}${ask.answer !== undefined ? `; answer: ${ask.answer}` : ""}`,
	];
	return lines.join("\n");
}

export type HumanMessage = { entryId: number; userId: string; text: string; at: number };

const FROM_TAG = /^<from user="([^"]*)" channel="[^"]*"\/>\n?/;

function humanText(entry: EntryRecord): { userId: string; text: string; at: number } | undefined {
	if (entry.kind !== "pi.user") return undefined;
	const message = entry.model?.find((m) => m.role === "user");
	if (!message) return undefined;
	const raw = typeof message.content === "string" ? message.content : message.content.map((b) => "text" in b && typeof b.text === "string" ? b.text : "").join("\n");
	const tag = FROM_TAG.exec(raw);
	return { userId: tag?.[1] ?? "local", text: raw.replace(FROM_TAG, ""), at: (message as { timestamp?: number }).timestamp ?? 0 };
}

/**
 * Find the newest human message of `conversationId` that contains `quote` and is not older than
 * `notBefore`. Mechanical provenance: the agent cannot cite a message that does not exist, is not
 * from a human, or predates the question.
 */
export async function findHumanMessage(
	harness: Pick<Harness, "conversation">, conversationId: ConversationId, quote: string, notBefore: number, context: Context, limit = 200,
): Promise<HumanMessage | undefined> {
	const needle = canonicalQuestion(quote);
	if (!needle) return undefined;
	const handle = await harness.conversation(conversationId, context);
	if (!handle) return undefined;
	let cursor: unknown;
	let scanned = 0;
	while (scanned < limit) {
		const page = await handle.entries({}, Math.min(50, limit - scanned), cursor as never, context);
		for (const entry of page.items) {
			scanned++;
			const human = humanText(entry);
			if (!human) continue;
			if (human.at && human.at < notBefore) return undefined; // newest first: older than the ask from here on
			if (canonicalQuestion(human.text).includes(needle)) return { entryId: Number(entry.id), ...human };
		}
		if (!page.next) break;
		cursor = page.next;
	}
	return undefined;
}
