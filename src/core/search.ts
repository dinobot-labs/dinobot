import { Database } from "bun:sqlite";
import type { Context } from "@earendil-works/chord";
import type { Message } from "@earendil-works/pi-ai";
import type { EntryId, EntryRecord, Harness } from "@earendil-works/pi-durable";
import { listThreads } from "./threads.ts";
import { MEMORY_NOTE_KIND } from "./ui-contract.ts";

/**
 * Full-text index over every conversation's transcript, for `session_search`.
 *
 * The index is derived data: a SQLite FTS5 table beside the durable store, fed by the Session's commit stream and
 * caught up from durable history at open and before each search, so it can always be rebuilt and never disagrees for
 * long. Entry ids are the primary key, so the stream and the catch-up may deliver the same entry twice without effect.
 *
 * Ranking (see openwiki/architecture/session-awareness.md):
 *   relevance r = -bm25 (FTS5 returns lower-is-better)
 *   entry score  s = r * (FLOOR + (1 - FLOOR) * 2^(-age / HALF_LIFE))
 *   thread score S = max s * (1 + BREADTH * ln(hits))
 * Matching relaxes in stages until something matches: every term (AND) -> any term (OR) -> substring (LIKE).
 */
export const HALF_LIFE_MS = 7 * 24 * 60 * 60_000;
export const RECENCY_FLOOR = 0.3;
export const BREADTH_WEIGHT = 0.1;
const CANDIDATES = 300;
const MAX_TERMS = 16;
const MAX_QUERY_CHARS = 512;
const MAX_ENTRY_CHARS = 8_000;
const TOOL_RESULT_CHARS = 1_000;
const SNIPPET_TOKENS = 16;
const PAGE = 200;
/** The `<from user="U1" channel="slack"/>` line bot.ts puts before channel input; indexed as `U1: `. */
const SENDER_TAG = /^<from user="([^"]*)" channel="[^"]*"\/>\n?/;

export type SearchMatch = "all" | "any" | "substring";

export type SearchHit = {
	thread: string;
	conversationId: number;
	score: number;
	hits: number;
	role: string;
	at: number;
	entryId: number;
	snippet: string;
};

export type SearchResult = { query: string; match: SearchMatch | "none"; results: SearchHit[] };

export type SessionIndex = {
	/** Index whatever durable history the index has not seen yet. */
	catchUp(context: Context): Promise<void>;
	search(query: string, options: { limit?: number; excludeThread?: string; now?: number }, context: Context): Promise<SearchResult>;
	/** Newest indexed entry of each conversation: when it was written and its text. */
	latest(conversationIds: readonly number[]): Map<number, { at: number; role: string; text: string }>;
	close(): void;
};

/** FTS5 terms of a free-text query: letters and digits only, each a quoted prefix term. Undefined when none remain. */
export function queryTerms(raw: string): string[] | undefined {
	const tokens = raw.slice(0, MAX_QUERY_CHARS).normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
	const unique = [...new Set(tokens)].slice(0, MAX_TERMS);
	return unique.length > 0 ? unique : undefined;
}

export function entryScore(bm25: number, ageMs: number): number {
	const decay = 2 ** (-Math.max(0, ageMs) / HALF_LIFE_MS);
	return -bm25 * (RECENCY_FLOOR + (1 - RECENCY_FLOOR) * decay);
}

export function threadScore(best: number, hits: number): number {
	return best * (1 + BREADTH_WEIGHT * Math.log(Math.max(1, hits)));
}

type Block = { type: string; text?: string; name?: string; arguments?: unknown };

/** Text of one message: text blocks, plus `name {args}` for a tool call when `toolCalls` is set. */
export function contentText(content: string | readonly Block[], options: { toolCalls?: (block: Block) => string } = {}): string {
	if (typeof content === "string") return content;
	return content
		.flatMap((block) => {
			if (block.type === "text" && block.text) return [block.text];
			if (block.type === "toolCall" && options.toolCalls) return [options.toolCalls(block)];
			return [];
		})
		.join("\n");
}

function messageText(message: Message): string {
	if (message.role === "assistant") {
		return contentText(message.content, { toolCalls: (block) => `${block.name} ${JSON.stringify(block.arguments)}` });
	}
	const text = contentText(message.content);
	return message.role === "user" ? text.replace(SENDER_TAG, "$1: ") : text.slice(0, TOOL_RESULT_CHARS);
}

export function entryText(entry: EntryRecord): { role: string; text: string; at: number } | undefined {
	// Recalled memory notes repeat stored memory; indexing them would make every recall look like a person's message.
	if (entry.kind === MEMORY_NOTE_KIND) return undefined;
	const messages = entry.model ?? [];
	const text = messages.map(messageText).filter(Boolean).join("\n").trim().slice(0, MAX_ENTRY_CHARS);
	const first = messages[0];
	if (!first || text === "") return undefined;
	return { role: first.role, text, at: first.timestamp ?? Date.now() };
}

/** Optional database transfers ownership to the index (also permits real SQLite fault injection). */
export function openSessionIndex(harness: Harness, path: string, database?: Database): SessionIndex {
	const db = database ?? new Database(path, { create: true });
	db.run("PRAGMA journal_mode = WAL");
	db.run(
		"CREATE TABLE IF NOT EXISTS entries (entry_id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, role TEXT NOT NULL, at INTEGER NOT NULL)",
	);
	db.run("CREATE INDEX IF NOT EXISTS entries_by_conversation ON entries (conversation_id, entry_id)");
	db.run("CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(body, tokenize = 'unicode61 remove_diacritics 2')");
	const insertEntry = db.prepare("INSERT OR IGNORE INTO entries (entry_id, conversation_id, role, at) VALUES (?, ?, ?, ?)");
	const insertBody = db.prepare("INSERT INTO entries_fts (rowid, body) VALUES (?, ?)");
	// Stream delivery and newest-first partial scans cannot establish a contiguous watermark.
	// Old indexes start at zero once, repairing any historical gaps.
	db.run("CREATE TABLE IF NOT EXISTS search_checkpoint (conversation_id INTEGER PRIMARY KEY, entry_id INTEGER NOT NULL)");
	const newest = db.prepare<{ id: number }, [number]>("SELECT entry_id AS id FROM search_checkpoint WHERE conversation_id = ?");
	const checkpoint = db.prepare("INSERT INTO search_checkpoint VALUES (?, ?) ON CONFLICT(conversation_id) DO UPDATE SET entry_id = max(entry_id, excluded.entry_id)");
	type IndexedEntry = { id: number; conversationId: number; role: string; text: string; at: number };
	const project = (entries: readonly EntryRecord[]): IndexedEntry[] => entries.flatMap((entry) => {
		const text = entryText(entry);
		return text ? [{ id: entry.id, conversationId: entry.conversationId, ...text }] : [];
	});
	const insert = db.transaction((entries: readonly IndexedEntry[]) => {
		for (const entry of entries) {
			if (insertEntry.run(entry.id, entry.conversationId, entry.role, entry.at).changes > 0) insertBody.run(entry.id, entry.text);
		}
	});

	let pending: IndexedEntry[] = [];
	let timer: ReturnType<typeof setTimeout> | undefined;
	let closed = false;
	let failures = 0;
	const flush = () => {
		clearTimeout(timer);
		timer = undefined;
		if (closed || pending.length === 0) return;
		try {
			insert(pending);
			pending = [];
			failures = 0;
		} catch {
			// Derived data only. Keep a bounded batch for two delayed retries, then
			// open the circuit until an explicit durable catch-up succeeds.
			if (++failures < 3) timer = setTimeout(flush, failures * 100);
			else pending = [];
		}
	};
	const unsubscribe = harness.subscribeCommits((publication) => {
		if (closed || failures >= 3) return;
		for (const change of publication.changes) {
			if (change.type !== "entry" || pending.length >= PAGE) continue;
			// Retain only bounded index text, not arbitrary transcript/tool payloads.
			pending.push(...project([change.value]));
		}
		if (pending.length > 0 && timer === undefined) timer = setTimeout(flush, 0);
	});

	async function catchUp(context: Context) {
		if (closed) return;
		const threads = await listThreads(harness, context);
		for (const conversationId of new Set(Object.values(threads))) {
			const conversation = await harness.conversation(conversationId, context);
			if (closed) return;
			if (!conversation) continue;
			const after = newest.get(conversationId)?.id ?? 0;
			let high = after;
			let cursor: Parameters<typeof conversation.entries>[2];
			do {
				const page = await conversation.entries({ minEntryId: (after + 1) as EntryId }, PAGE, cursor, context);
				if (closed) return;
				insert(project(page.items));
				for (const entry of page.items) high = Math.max(high, entry.id);
				cursor = page.next;
			} while (cursor);
			checkpoint.run(conversationId, high);
		}
		failures = 0;
	}

	type Row = { conversation_id: number; entry_id: number; role: string; at: number; rank: number; snippet: string };
	const ftsRows = (expression: string) =>
		db
			.query<Row, [string, number]>(
				`SELECT e.conversation_id, e.entry_id, e.role, e.at, bm25(entries_fts) AS rank,
				        snippet(entries_fts, 0, '[', ']', '...', ${SNIPPET_TOKENS}) AS snippet
				 FROM entries_fts JOIN entries e ON e.entry_id = entries_fts.rowid
				 WHERE entries_fts MATCH ? ORDER BY rank LIMIT ?`,
			)
			.all(expression, CANDIDATES);
	const likeRows = (terms: readonly string[]) =>
		db
			.query<Row, string[]>(
				`SELECT e.conversation_id, e.entry_id, e.role, e.at, -1.0 AS rank, substr(f.body, 1, 160) AS snippet
				 FROM entries_fts f JOIN entries e ON e.entry_id = f.rowid
				 WHERE ${terms.map(() => "lower(f.body) LIKE ? ESCAPE '\\'").join(" OR ")}
				 ORDER BY e.entry_id DESC LIMIT ${CANDIDATES}`,
			)
			.all(...terms.map((term) => `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`));

	return {
		catchUp,
		async search(query, { limit = 5, excludeThread, now = Date.now() }, context) {
			await catchUp(context);
			flush();
			const terms = queryTerms(query);
			if (!terms) return { query, match: "none", results: [] };
			const threads = await listThreads(harness, context);
			const threadOf = new Map<number, string>();
			for (const [key, id] of Object.entries(threads)) threadOf.set(id, key);
			const quoted = terms.map((term) => `"${term}"*`);
			const stages: [SearchMatch, () => Row[]][] = [
				["all", () => ftsRows(quoted.join(" "))],
				["any", () => (terms.length > 1 ? ftsRows(quoted.join(" OR ")) : [])],
				["substring", () => likeRows(terms)],
			];
			for (const [match, rows] of stages) {
				const best = new Map<string, SearchHit>();
				for (const row of rows()) {
					const thread = threadOf.get(row.conversation_id);
					if (thread === undefined || thread === excludeThread) continue;
					const score = entryScore(row.rank, now - row.at);
					const current = best.get(thread);
					if (!current) {
						best.set(thread, {
							thread, conversationId: row.conversation_id, score, hits: 1, role: row.role, at: row.at,
							entryId: row.entry_id, snippet: row.snippet.replace(/\s+/g, " ").trim(),
						});
					} else {
						current.hits++;
						if (score > current.score) {
							Object.assign(current, { score, role: row.role, at: row.at, entryId: row.entry_id, snippet: row.snippet.replace(/\s+/g, " ").trim() });
						}
					}
				}
				if (best.size === 0) continue;
				const results = [...best.values()]
					.map((hit) => ({ ...hit, score: threadScore(hit.score, hit.hits) }))
					.sort((a, b) => b.score - a.score || b.at - a.at)
					.slice(0, limit);
				return { query, match, results };
			}
			return { query, match: "none", results: [] };
		},
		latest(conversationIds) {
			const found = new Map<number, { at: number; role: string; text: string }>();
			const statement = db.query<{ at: number; role: string; body: string }, [number]>(
				`SELECT e.at, e.role, f.body FROM entries e JOIN entries_fts f ON f.rowid = e.entry_id
				 WHERE e.conversation_id = ? ORDER BY e.entry_id DESC LIMIT 1`,
			);
			flush();
			for (const id of conversationIds) {
				const row = statement.get(id);
				if (row) found.set(id, { at: row.at, role: row.role, text: row.body });
			}
			return found;
		},
		close() {
			if (closed) return;
			flush();
			closed = true;
			clearTimeout(timer);
			pending = [];
			try { unsubscribe(); } finally {
				// Finalize retained prepared statements before closing a file-backed index.
				for (const statement of [insertEntry, insertBody, newest, checkpoint]) statement.finalize();
				db.close();
			}
		},
	};
}
