import type { D1Like } from "./env.ts";
import type { Locale } from "./locale.ts";

/** BRIEF §9. Addresses are unique case-insensitively (COLLATE NOCASE on the column and its unique index). No IP or user agent. */
export const DDL = [
	`CREATE TABLE IF NOT EXISTS waitlist (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		email TEXT NOT NULL UNIQUE COLLATE NOCASE,
		locale TEXT NOT NULL,
		source TEXT,
		consent_version TEXT NOT NULL,
		created_at TEXT NOT NULL
	)`,
] as const;

const ready = new WeakMap<D1Like, Promise<void>>();

/** Idempotent schema creation, once per isolate and database; a failed attempt is retried by the next call. */
export function ensureSchema(db: D1Like): Promise<void> {
	let pending = ready.get(db);
	if (!pending) {
		pending = (async () => {
			for (const sql of DDL) await db.prepare(sql).run();
		})().catch((error: unknown) => {
			ready.delete(db);
			throw error;
		});
		ready.set(db, pending);
	}
	return pending;
}

export type Entry = { email: string; locale: Locale; source: string | null; consentVersion: string; createdAt: string };

/**
 * Add an entry. Returns its position (the number of rows up to and including the new id), or null when the address
 * is already on the list (compared case-insensitively); a duplicate changes nothing.
 */
export async function addEntry(db: D1Like, entry: Entry): Promise<number | null> {
	await ensureSchema(db);
	const inserted = await db
		.prepare("INSERT INTO waitlist (email, locale, source, consent_version, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (email) DO NOTHING RETURNING id")
		.bind(entry.email, entry.locale, entry.source, entry.consentVersion, entry.createdAt)
		.first<{ id: number }>();
	if (!inserted) return null;
	const counted = await db.prepare("SELECT COUNT(*) AS n FROM waitlist WHERE id <= ?").bind(inserted.id).first<{ n: number }>();
	return counted?.n ?? 1;
}
