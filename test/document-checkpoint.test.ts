import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineDoc, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const Counter = defineDoc<{ n: number; log: string[] }>({ kind: "test.counter", version: 1, scope: "session", initial: () => ({ n: 0, log: [] }) });
const Pinned = defineDoc<{ n: number }>({ kind: "test.pinned", version: 1, scope: "session", initial: () => ({ n: 0 }), checkpointWhen: () => false });

async function open(file: string) {
	return Harness.open(await openNodeSqliteStorage(file), { registry: createRegistry(), models: createModels() }, context);
}

function revisions(file: string, kind: string) {
	const db = new DatabaseSync(file, { readOnly: true });
	try {
		return db.prepare(
			"SELECT r.kind AS kind, count(*) AS n FROM document_revisions r JOIN documents d ON d.id = r.document_id WHERE d.kind = ? GROUP BY r.kind",
		).all(JSON.stringify(kind)) as { kind: string; n: number }[];
	} finally {
		db.close();
	}
}

test("a document without checkpointWhen is rebased, so a load never replays its whole history", async () => {
	const dir = await mkdtemp(join(tmpdir(), "dinobot-checkpoint-"));
	const file = join(dir, "db.sqlite");
	try {
		const h = await open(file);
		for (let i = 1; i <= 600; i++) await h.commit(async (tx) => { const doc = await tx.doc(Counter); doc.n = i; doc.log.push("e" + i); }, context);
		await h.close(context);
		const counts = Object.fromEntries(revisions(file, "test.counter").map((r) => [r.kind, r.n]));
		expect(counts.base).toBe(1); // a session document keeps no history: the new base replaces the older rows
		expect(counts.delta).toBeLessThan(256);
		const again = await open(file);
		const value = await again.commit(async (tx) => { const doc = await tx.doc(Counter); return { n: doc.n, length: doc.log.length, last: doc.log[doc.log.length - 1] }; }, context);
		expect(value).toEqual({ n: 600, length: 600, last: "e600" });
		await again.close(context);
	} finally {
		await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {}); // Windows keeps the file mapped for a moment
	}
});

test("compact-documents turns the newest delta of a long tail into a base and keeps the value", async () => {
	const dir = await mkdtemp(join(tmpdir(), "dinobot-compact-"));
	const file = join(dir, "db.sqlite");
	try {
		const h = await open(file);
		for (let i = 1; i <= 300; i++) await h.commit(async (tx) => { (await tx.doc(Pinned)).n = i; }, context);
		await h.close(context);
		expect(Object.fromEntries(revisions(file, "test.pinned").map((r) => [r.kind, r.n]))).toEqual({ base: 1, delta: 299 });
		const script = fileURLToPath(new URL("../script/compact-documents.ts", import.meta.url));
		const run = async (...args: string[]) => {
			const child = Bun.spawn([process.execPath, script, file, ...args], { stdout: "pipe", stderr: "pipe" });
			const out = await new Response(child.stdout).text();
			expect(await child.exited).toBe(0);
			return JSON.parse(out) as { mode: string; compacted: number };
		};
		expect(await run("--min", "100")).toMatchObject({ mode: "dry-run", compacted: 1 });
		expect(Object.fromEntries(revisions(file, "test.pinned").map((r) => [r.kind, r.n]))).toEqual({ base: 1, delta: 299 });
		expect(await run("--min", "100", "--apply")).toMatchObject({ mode: "applied", compacted: 1 });
		expect(Object.fromEntries(revisions(file, "test.pinned").map((r) => [r.kind, r.n]))).toEqual({ base: 1 });
		expect(await run("--min", "100")).toMatchObject({ compacted: 0 });
		const again = await open(file);
		expect(await again.commit(async (tx) => (await tx.doc(Pinned)).n, context)).toBe(300);
		await again.close(context);
	} finally {
		await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {}); // Windows keeps the file mapped for a moment
	}
});
