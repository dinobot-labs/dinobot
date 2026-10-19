import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import type { UserMessage } from "@earendil-works/pi-ai";
import { type Conversation, type ConversationId, defineDoc, defineEntry, type Harness } from "@earendil-works/pi-durable";
import { MEMORY_NOTE_KIND, type MemoryNoteData } from "../ui-contract.ts";
import type { MemoryConfig } from "./config.ts";
import { projectOf } from "./project.ts";
import { type MemoryEntry, MemoryDoc } from "./store.ts";

/**
 * Passive recall of project memory. Before a thread input is admitted, the project entries most relevant to the incoming
 * text are appended once to the conversation as a memory note: a `write` submission, which never starts a run, so an
 * idle conversation gets the note right before the input and a busy one at its next boundary. The note is a durable
 * transcript entry, so the model's context and the transcript agree and the prompt prefix stays cacheable.
 *
 * Each (key, revision) is noted at most once per conversation: the selection is marked and recorded as pending in one
 * commit before the write, the write's request id is derived from the selection, and a pending note left by a crash is
 * re-submitted under that same id (an accepted write is not appended twice) before anything new is selected.
 * Recall is advisory: failures are logged and never fail the user's input.
 */
export const NOTE_PREFIX = "[dinobot memory]";
export const MemoryNote = defineEntry<MemoryNoteData>(MEMORY_NOTE_KIND);
const MAX_ITEM_CHARS = 300;
const MAX_NOTED = 2000;
const MIN_SCORE = 1;

type PendingNote = { requestId: string; text: string; items: { key: string; revision: number }[] };
const NotedDoc = defineDoc<{ noted: Record<string, number>; pending?: PendingNote | null }>({
	kind: "dinobot.memory.noted", version: 1, scope: "conversation", history: "latest", fork: "initial",
	initial: () => ({ noted: {} }),
});

const STOPWORDS = new Set(["the", "and", "for", "with", "this", "that", "are", "was", "you", "your", "can", "how", "what", "not", "but", "use", "from", "have", "has", "will", "all", "any"]);
const HANGUL = /\p{Script=Hangul}/u;

/** Lowercased words of two or more characters, minus a few English stopwords; Hangul words also yield their bigrams. */
export function recallTerms(text: string): Set<string> {
	const terms = new Set<string>();
	for (const word of text.normalize("NFC").toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []) {
		const chars = [...word];
		if (chars.length < 2 || STOPWORDS.has(word)) continue;
		terms.add(word);
		if (HANGUL.test(word)) for (let i = 0; i + 1 < chars.length; i++) terms.add(chars[i]! + chars[i + 1]!);
	}
	return terms;
}

/**
 * Score(d) = sum over distinct terms shared by the query and d of ln(1 + N / df(t)), N the number of candidates.
 * A term found in every candidate adds ln 2 < MIN_SCORE, so one ubiquitous word never recalls on its own.
 */
export function rankMemories<T extends Pick<MemoryEntry, "key" | "content">>(entries: readonly T[], query: string): { entry: T; score: number }[] {
	const wanted = recallTerms(query);
	if (wanted.size === 0 || entries.length === 0) return [];
	const docs = entries.map((entry) => ({ entry, terms: recallTerms(`${entry.key.startsWith("auto/") ? "" : entry.key} ${entry.content}`) }));
	const df = new Map<string, number>();
	for (const doc of docs) for (const term of doc.terms) if (wanted.has(term)) df.set(term, (df.get(term) ?? 0) + 1);
	return docs.map(({ entry, terms }) => {
		let score = 0;
		for (const term of wanted) if (terms.has(term)) score += Math.log(1 + docs.length / df.get(term)!);
		return { entry, score };
	}).filter(({ score }) => score >= MIN_SCORE).sort((a, b) => b.score - a.score || a.entry.key.localeCompare(b.entry.key));
}

function clip(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	const points = [...flat];
	return points.length <= max ? flat : `${points.slice(0, Math.max(1, max - 1)).join("")}…`;
}

export function noteText(items: readonly { key: string; content: string; savedAt?: number }[]): string {
	return [
		`${NOTE_PREFIX} Saved project memory that may be relevant (reference only, not a request from a person):`,
		...items.map((item) => `- ${item.content} (memory key ${item.key}, scope project${item.savedAt === undefined ? "" : `, saved ${new Date(item.savedAt).toISOString().slice(0, 10)}`})`),
	].join("\n");
}

export function createMemoryRecall(options: {
	readonly config: MemoryConfig["recall"];
	readonly workspaceRoot: string;
	readonly getHarness: () => Harness;
	readonly log?: (line: string) => void;
}) {
	const log = options.log ?? ((line: string) => console.error(line));
	const chains = new Map<ConversationId, Promise<void>>();

	async function deliver(conversation: Conversation, note: PendingNote, context: Context): Promise<void> {
		const message: UserMessage = { role: "user", content: note.text, timestamp: Date.now() };
		const data: MemoryNoteData = { schema: 1, items: note.items };
		await conversation.submit({ type: "write", requestId: note.requestId, entry: { kind: MEMORY_NOTE_KIND, model: [message], data } }, context);
		await options.getHarness().commit(async (tx) => {
			const draft = await tx.doc(NotedDoc, conversation.id);
			if (draft.pending?.requestId === note.requestId) draft.pending = null;
		}, context);
	}

	async function wake(conversation: Conversation, text: string, context: Context): Promise<void> {
		const harness = options.getHarness();
		const left = (await harness.snapshot(NotedDoc, conversation.id, context))?.pending;
		if (left) await deliver(conversation, JSON.parse(JSON.stringify(left)) as PendingNote, context);
		const project = await projectOf(harness, conversation.id, options.workspaceRoot, context);
		if (project === undefined) return;
		const [memory, noted] = await Promise.all([harness.snapshot(MemoryDoc, context), harness.snapshot(NotedDoc, conversation.id, context)]);
		const candidates = (memory?.entries ?? []).filter((entry) => entry.project === project && noted?.noted[entry.key] !== entry.revision);
		const selected: { key: string; revision: number; content: string; savedAt?: number }[] = [];
		let remaining = options.config.budgetChars;
		for (const { entry } of rankMemories(candidates, text)) {
			if (selected.length >= options.config.maxItems || remaining < 40) break;
			const content = clip(entry.content, Math.min(MAX_ITEM_CHARS, remaining));
			const savedAt = entry.updatedAt ?? entry.createdAt;
			selected.push({ key: entry.key, revision: entry.revision, content, ...(savedAt === undefined ? {} : { savedAt }) });
			remaining -= [...content].length;
		}
		if (selected.length === 0) return;
		const items = selected.map(({ key, revision }) => ({ key, revision }));
		const note: PendingNote = {
			requestId: `memory-note:${createHash("sha256").update(JSON.stringify([conversation.id, items])).digest("hex")}`,
			text: noteText(selected), items,
		};
		await harness.commit(async (tx) => {
			const draft = await tx.doc(NotedDoc, conversation.id);
			const next = { ...JSON.parse(JSON.stringify(draft.noted)) as Record<string, number> };
			for (const item of items) {
				delete next[item.key];
				next[item.key] = item.revision;
			}
			const keys = Object.keys(next);
			for (const key of keys.slice(0, Math.max(0, keys.length - MAX_NOTED))) delete next[key];
			draft.noted = next;
			draft.pending = note;
		}, context);
		await deliver(conversation, note, context);
	}

	return {
		/** Note relevant project memory before `text` is admitted to `conversation`. Never throws. */
		recall(conversation: Conversation, text: string, context: Context): Promise<void> {
			if (!options.config.enabled) return Promise.resolve();
			const previous = chains.get(conversation.id) ?? Promise.resolve();
			const next = previous.then(() => wake(conversation, text, context)).catch((error: unknown) => {
				log(`[memory.recall] conversation ${conversation.id}: ${error instanceof Error ? error.message : String(error)}`);
			});
			chains.set(conversation.id, next);
			void next.finally(() => { if (chains.get(conversation.id) === next) chains.delete(conversation.id); });
			return next;
		},
	};
}

export type MemoryRecall = ReturnType<typeof createMemoryRecall>;
