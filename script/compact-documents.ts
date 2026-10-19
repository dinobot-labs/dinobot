/**
 * One-off: rebase long-lived documents in a stopped daemon's database.
 *
 * Documents are stored as one base plus deltas; a load replays every delta after the newest base. Before the default
 * checkpoint (256 deltas) existed nothing ever wrote a second base, so a long-lived document (workspace coordination,
 * memory retros) replays tens of thousands of deltas at every daemon start. For each live document whose tail is
 * longer than the threshold this turns the newest delta row into a base holding the same current value. Session- and
 * task-scoped documents and "latest" conversation documents keep no history (the storage layer deletes older rows when it
 * writes a base), so their older rows are deleted too; rewindable conversation documents keep every row, so reads of
 * earlier sequence numbers are unchanged. Free pages are reused by SQLite; run VACUUM afterwards to shrink the file.
 *
 *   bun script/compact-documents.ts <dinobot.sqlite> [--apply] [--min 256]
 *
 * Stop the daemon first. Without --apply it only reports. Take a copy of the file before --apply.
 */
import { apply } from "@earendil-works/chord/delta";
import { DatabaseSync } from "node:sqlite";

const args = process.argv.slice(2);
const minIndex = args.indexOf("--min");
const path = args.find((a, i) => !a.startsWith("--") && (minIndex < 0 || i !== minIndex + 1));
const write = args.includes("--apply");
const min = minIndex >= 0 ? Number(args[minIndex + 1]) : 256;
if (!path || !Number.isInteger(min) || min < 2) {
	console.error("usage: bun script/compact-documents.ts <dinobot.sqlite> [--apply] [--min 256]");
	process.exit(2);
}
/** The one document whose history carries a hand-pinned compatibility repair in the storage layer; leave its rows alone. */
const PINNED_COMPAT_DOCUMENT = 3525;

const db = new DatabaseSync(path);
db.exec("PRAGMA busy_timeout = 10000");
const ids = db.prepare("SELECT id, record FROM documents WHERE retired_at IS NULL ORDER BY id").all() as { id: number; record: string }[];
const newestBase = db.prepare("SELECT seq, version, content FROM document_revisions WHERE document_id = ? AND kind = 'base' ORDER BY seq DESC LIMIT 1");
const tail = db.prepare("SELECT seq, kind, version, content FROM document_revisions WHERE document_id = ? AND seq > ? ORDER BY seq");
const rebase = db.prepare("UPDATE document_revisions SET kind = 'base', content = ? WHERE document_id = ? AND seq = ? AND kind = 'delta'");
const dropOlder = db.prepare("DELETE FROM document_revisions WHERE document_id = ? AND seq < ?");
/** Mirrors the storage layer: only rewindable conversation documents retain history. */
const isCurrentOnly = (record: string): boolean => {
	const parsed = JSON.parse(record) as { scope: { kind: string }; history?: string };
	return parsed.scope.kind !== "conversation" || parsed.history === "latest";
};

let compacted = 0;
let skipped = 0;
let replayed = 0;
const started = performance.now();
if (write) db.exec("BEGIN IMMEDIATE");
try {
	for (const { id, record } of ids) {
		if (id === PINNED_COMPAT_DOCUMENT) continue;
		const base = newestBase.get(id) as { seq: number; version: number; content: string } | undefined;
		if (!base) continue;
		const deltas = tail.all(id, base.seq) as { seq: number; kind: string; version: number; content: string }[];
		if (deltas.length < min) continue;
		if (deltas.some((d) => d.kind !== "delta" || d.version !== base.version)) {
			skipped++;
			console.error(`skip ${id}: tail crosses a version boundary`);
			continue;
		}
		let value = JSON.parse(base.content);
		for (const d of deltas) value = apply(value, JSON.parse(d.content));
		replayed += deltas.length;
		const last = deltas[deltas.length - 1]!.seq;
		if (write) {
			rebase.run(JSON.stringify(value), id, last);
			if (isCurrentOnly(record)) dropOlder.run(id, last);
		}
		compacted++;
	}
	if (write) db.exec("COMMIT");
} catch (error) {
	if (write) db.exec("ROLLBACK");
	throw error;
}
console.log(JSON.stringify({ mode: write ? "applied" : "dry-run", documents: ids.length, compacted, skipped, deltasReplayed: replayed, min, ms: Math.round(performance.now() - started) }));
