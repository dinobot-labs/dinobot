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

type PendingNote = { requestId: string; text: string; items: { key: string; revision: number }[] };
const NotedDoc = defineDoc<{ noted: Record<string, number>; pending?: PendingNote | null }>({
	kind: "dinobot.memory.noted", version: 1, scope: "conversation", history: "latest", fork: "initial",
	initial: () => ({ noted: {} }),
});

const STOPWORDS = new Set([
	"the", "and", "for", "with", "this", "that", "are", "was", "you", "your", "can", "how", "what", "not", "but", "use", "from", "have", "has", "will", "all", "any",
	"같은", "같다", "있는", "없는", "있다", "없다", "있고", "없고", "이것", "그것", "저것", "지금", "현재", "다시", "그냥", "정말", "실제로", "실제",
	"해줘", "해주세요", "계속", "계속해", "위해", "대한", "에서", "으로", "처럼", "보다", "까지", "부터", "하는", "한다", "하기", "해서", "하고", "해요",
	"된다", "되는", "되다", "되어", "또한", "그리고", "하지만",
]);
// Longest first, one suffix only: bounded lexical normalization, not a morphological analyzer.
// Never emit internal pieces (e.g. 파일시스템 → 시스/스템 or 설치되어 → 치되).
// Bare 도/로/만 are too ambiguous: 해상도 and 매크로 must keep their lexical boundary.
const KOREAN_SUFFIX = /(?:으로부터|에서부터|으로는|으로도|에서는|에서도|에게는|에게도|에는|에도|에만|되었다|되어서|됩니다|습니다|입니다|하려면|하려고|한다면|하는데|한다고|이라고|이라면|으로|에서|에게|한테|까지|부터|처럼|보다|하고|하며|한다|하는|해서|해야|되어|된다|되는|이다|라고|이며|이면|된|은|는|을|를|이|가|와|과|의|에)$/u;

function lexicalTerm(word: string): string {
	const suffix = word.match(KOREAN_SUFFIX)?.[0];
	if (!suffix) return word;
	const stem = word.slice(0, -suffix.length);
	if ([...stem].length < 2) return word;
	// Do not strip vowel-only particles from a consonant-ending noun (e.g. 전문가).
	const last = stem.codePointAt(stem.length - 1)!;
	if (last >= 0xac00 && last <= 0xd7a3) {
		const coda = (last - 0xac00) % 28;
		if (["가", "는", "를", "와"].includes(suffix) && coda !== 0) return word;
		if (["은", "을", "과", "이"].includes(suffix) && coda === 0) return word;
	}
	return stem;
}

/** Distinct full lexical anchors, with bounded Korean suffix normalization; never substring n-grams. */
export function recallTerms(text: string): Set<string> {
	const terms = new Set<string>();
	for (const word of text.normalize("NFC").toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []) {
		if (STOPWORDS.has(word)) continue;
		const term = lexicalTerm(word);
		if ([...term].length >= 2 && !STOPWORDS.has(term)) terms.add(term);
	}
	return terms;
}

/**
 * A shared lexical anchor makes a candidate eligible; IDF orders candidates, it is not confidence.
 * Score(d) = sum over distinct shared anchors of ln(1 + N / df(t)), using the whole project corpus.
 * In particular a useful single-memory lookup remains eligible at ln(2), independent of corpus size.
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
	}).filter(({ score }) => score > 0).sort((a, b) => b.score - a.score || a.entry.key.localeCompare(b.entry.key));
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
	readonly projectAliases?: readonly import("./project-aliases.ts").ProjectAlias[];
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
		const project = await projectOf(harness, conversation.id, options.workspaceRoot, context, options.projectAliases);
		if (project === undefined) return;
		const [memory, noted] = await Promise.all([harness.snapshot(MemoryDoc, context), harness.snapshot(NotedDoc, conversation.id, context)]);
		// Delivery history must not alter document frequencies or another entry's rank.
		const candidates = (memory?.entries ?? []).filter((entry) => entry.project === project);
		const selected: { key: string; revision: number; content: string; savedAt?: number }[] = [];
		let remaining = options.config.budgetChars;
		for (const { entry } of rankMemories(candidates, text)) {
			if (noted?.noted[entry.key] === entry.revision) continue;
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
