import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, StorageRejected, type StorageWrite } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { SkillStore, SkillsDoc, type SkillPackage, type SkillsState } from "../src/core/skills/store.ts";
import { skillPackageHash } from "../src/core/skills/manifests.ts";
import {
	commitSkillsStorageMigration, migrateSkillsStorage, readSkillsState, writeSkillsState,
	readSkillVersion, readSkillSummaries,
	SkillLoadedStorageDoc, SkillMetadataStorageDoc, SkillPackageStorageDoc, SkillProposalStorageDoc,
	SkillReceiptStorageDoc, SkillsStorageArchiveDoc, SkillsStorageIndexDoc, SkillStorageError,
} from "../src/core/skills/storage.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const original: SkillPackage = {
	name: "fixture", description: "Original description", body: "original body\n",
	files: { "guide.txt": "original reference\n" }, source: "fixture:origin",
	originalSkillMd: "---\nname: fixture\ncustom: untouched\n---\noriginal body\n",
};
type StorageHooks = { reject: boolean; onLegacyRead?: () => Promise<void>; writes: (readonly StorageWrite[])[] };
async function open(path: string) {
	const storage = await openNodeSqliteStorage(path);
	const hooks: StorageHooks = { reject: false, writes: [] };
	const commit = storage.commit.bind(storage);
	storage.commit = async (writes, ctx) => {
		if (hooks.reject) throw new StorageRejected("Injected SQLite storage rejection");
		const sequence = await commit(writes, ctx);
		hooks.writes.push(writes);
		return sequence;
	};
	const document = storage.document.bind(storage);
	storage.document = async (id, at, ctx) => {
		const stored = await document(id, at, ctx);
		if (stored?.record.kind === "dinobot.skills" && stored.version === 1 && hooks.onLegacyRead) {
			const gate = hooks.onLegacyRead;
			delete hooks.onLegacyRead;
			await gate();
		}
		return stored;
	};
	const harness = await Harness.open(storage, { registry: createRegistry(), models: createModels() }, context);
	let closed = false;
	const close = async () => { if (!closed) { closed = true; await harness.close(context); } };
	cleanup.push(close);
	return { harness, hooks, storage, path, close, store: new SkillStore(harness) };
}
async function setup() {
	const directory = await mkdtemp(join(tmpdir(), "skill-storage-"));
	cleanup.push(() => rm(directory, { recursive: true, force: true }));
	const state = await open(join(directory, "skills.sqlite"));
	await state.store.initialize([original], context);
	const before = await state.store.load(original.name, undefined, context);
	const staged = await state.store.propose({
		name: original.name, description: "Candidate description", body: "candidate body",
		files: { "candidate.txt": "candidate companion" }, expectedGeneration: before.generation, requestId: "candidate-input",
	}, "owner", context);
	await state.harness.commit(async tx => {
		const doc = await tx.doc(SkillsDoc);
		doc.usage = { [before.version]: { loads: 3, verified: 2, blocked: 1 } };
		doc.loaded = { "conversation-fixture": [before.version] };
	}, context);
	return { ...state, staged };
}
async function snapshot(harness: Harness): Promise<SkillsState> {
	return harness.commit(readSkillsState, context);
}
async function signaled<T>(promise: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => reject(new Error("Expected storage signal did not arrive")), 5_000);
		})]);
	} finally { if (timer) clearTimeout(timer); }
}

test("unmigrated facade preserves v1 storage and optional fields", async () => {
	// Given
	const { harness } = await setup();
	const state = await snapshot(harness);
	delete state.usage; delete state.loaded;
	// When
	await harness.commit(tx => writeSkillsState(tx, state), context);
	// Then
	expect(await harness.snapshot(SkillsDoc, context)).toEqual(state);
	expect(await snapshot(harness)).toEqual(state);
	expect((await harness.snapshot(SkillsStorageIndexDoc, context))?.active).toBe(false);
});

test("hot execution readers do not hydrate unrelated proposal payloads", async () => {
	// Given a valid retained head and an unrelated proposal payload that is corrupt.
	const { harness, store, staged } = await setup();
	const candidate = await store.diff(staged.proposalId, context);
	await migrateSkillsStorage(harness, context);
	await harness.commit(async (tx) => {
		const doc = await tx.doc(SkillPackageStorageDoc, candidate.version, null);
		if (!doc.package) throw new Error("Missing proposal fixture");
		doc.package.body = "corrupt research-only payload";
	}, context);
	// When execution reads only its retained bytes and current head catalog.
	const pkg = await harness.commit((tx) => readSkillVersion(tx, original.name, skillPackageHash(original)), context);
	const catalog = await harness.commit(readSkillSummaries, context);
	// Then unrelated research cannot poison or force hydration of the main pin.
	expect(pkg).toEqual(original);
	expect(catalog[0]?.version).toBe(skillPackageHash(original));
	await expect(harness.commit(readSkillsState, context)).rejects.toThrow("split package");
});

test("atomic cutover roundtrips all heads generations packages proposals receipts and telemetry", async () => {
	// Given
	const first = await setup();
	const before = await first.harness.snapshot(SkillsDoc, context);
	if (!before) throw new Error("Fixture snapshot missing");
	// When
	const result = await migrateSkillsStorage(first.harness, context);
	await first.close();
	const second = await open(first.path);
	// Then
	expect(result).toMatchObject({ migrated: true, skillCount: 1, proposalCount: 1, receiptCount: 1 });
	expect(await snapshot(second.harness)).toEqual(before);
	expect((await second.harness.snapshot(SkillsStorageArchiveDoc, context))?.archive).toEqual(before);
	expect((await second.harness.snapshot(SkillsStorageIndexDoc, context))?.active).toBe(true);
	expect((await migrateSkillsStorage(second.harness, context)).migrated).toBe(false);
	expect((await second.harness.snapshot(SkillProposalStorageDoc, first.staged.proposalId, context))?.proposal).not.toHaveProperty("candidate");
	expect((await second.harness.snapshot(SkillReceiptStorageDoc, "candidate-input", context))?.receipt?.canonical).toBe(before?.receipts[0]?.canonical ?? "");
});

test("empty database cutover installs a v2 archive and active empty index", async () => {
	// Given
	const directory = await mkdtemp(join(tmpdir(), "skill-storage-empty-"));
	cleanup.push(() => rm(directory, { recursive: true, force: true }));
	const { harness } = await open(join(directory, "empty.sqlite"));
	// When
	await migrateSkillsStorage(harness, context);
	// Then
	expect(await snapshot(harness)).toEqual({ skills: [], proposals: [], receipts: [], usage: {}, loaded: {} });
	await expect(harness.snapshot(SkillsDoc, context)).rejects.toThrow("newer version 2");
});

test("stale typed snapshot cannot seal or overwrite concurrent legacy state", async () => {
	// Given
	const { harness } = await setup();
	const captured = await harness.snapshot(SkillsDoc, context);
	if (!captured) throw new Error("Fixture legacy snapshot missing");
	await harness.commit(async tx => {
		const doc = await tx.doc(SkillsDoc);
		doc.receipts.push({ requestId: "concurrent", canonical: "exact concurrent original", result: { proposalId: "unrelated" } });
	}, context);
	const current = await harness.snapshot(SkillsDoc, context);
	if (!current) throw new Error("Fixture concurrent snapshot missing");
	// When / Then
	await expect(harness.commit(tx => commitSkillsStorageMigration(tx, captured), context)).rejects.toMatchObject({ code: "stale-snapshot" });
	expect(await harness.snapshot(SkillsDoc, context)).toEqual(current);
	expect((await harness.snapshot(SkillsStorageIndexDoc, context))?.active ?? false).toBe(false);
	await migrateSkillsStorage(harness, context);
	expect(await snapshot(harness)).toEqual(current);
});

test("migration automatically retries when a barrier-controlled v1 write wins", async () => {
	// Given
	const first = await setup();
	await first.close();
	const state = await open(first.path);
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	state.hooks.onLegacyRead = async () => { entered.resolve(); await release.promise; };
	const migration = migrateSkillsStorage(state.harness, context);
	try {
		await signaled(entered.promise);
		// When the writer is queued BEFORE the v1 snapshot is released to the migrator.
		const concurrent = state.harness.commit(async tx => {
			const doc = await tx.doc(SkillsDoc);
			doc.receipts.push({ requestId: "race-write", canonical: "concurrent canonical bytes", result: { proposalId: "unrelated" } });
		}, context);
		release.resolve();
		await concurrent;
		expect((await migration).migrated).toBe(true);
		// Then retry captures the new state instead of migrating the stale snapshot.
		expect((await snapshot(state.harness)).receipts.some(receipt => receipt.requestId === "race-write")).toBe(true);
		expect((await state.harness.snapshot(SkillsStorageArchiveDoc, context))?.archive.receipts.some(receipt => receipt.requestId === "race-write")).toBe(true);
	} finally { release.resolve(); await migration; }
}, 10_000);

test("thrown migration callback rolls back both marker version and split families", async () => {
	// Given
	const first = await setup();
	const before = await first.harness.snapshot(SkillsDoc, context);
	if (!before) throw new Error("Fixture snapshot missing");
	// When
	await expect(first.harness.commit(async tx => {
		await commitSkillsStorageMigration(tx, before);
		throw new SkillStorageError("conflict", "Injected interrupted migration callback");
	}, context)).rejects.toThrow("interrupted");
	await first.close();
	const second = await open(first.path);
	// Then
	expect(await second.harness.snapshot(SkillsDoc, context)).toEqual(before);
	expect((await second.harness.snapshot(SkillsStorageIndexDoc, context))?.active ?? false).toBe(false);
	expect(await second.harness.snapshot(SkillMetadataStorageDoc, original.name, context)).toBeUndefined();
	await migrateSkillsStorage(second.harness, context);
	expect(await snapshot(second.harness)).toEqual(before);
});

test("real SQLite storage rejection leaves migration fully retryable", async () => {
	// Given
	const state = await setup();
	const before = await state.harness.snapshot(SkillsDoc, context);
	if (!before) throw new Error("Fixture snapshot missing");
	state.hooks.reject = true;
	// When / Then
	await expect(migrateSkillsStorage(state.harness, context)).rejects.toThrow("SQLite storage rejection");
	state.hooks.reject = false;
	expect(await state.harness.snapshot(SkillsDoc, context)).toEqual(before);
	expect((await state.harness.snapshot(SkillsStorageIndexDoc, context))?.active ?? false).toBe(false);
	expect((await migrateSkillsStorage(state.harness, context)).migrated).toBe(true);
	expect(await snapshot(state.harness)).toEqual(before);
});

for (const crash of ["before-commit", "after-commit"] as const) {
	test(`SIGKILL ${crash} leaves real SQLite entirely legacy or entirely split`, async () => {
		// Given
		const first = await setup();
		const before = await first.harness.snapshot(SkillsDoc, context);
		if (!before) throw new Error("Fixture snapshot missing");
		await first.close();
		const module = fileURLToPath(new URL("../src/core/skills/storage.ts", import.meta.url));
		const legacy = fileURLToPath(new URL("../src/core/skills/store.ts", import.meta.url));
		const code = `
			import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
			import { Harness, createRegistry } from "@earendil-works/pi-durable";
			import { createModels } from "@earendil-works/pi-ai/models";
			import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
			import { commitSkillsStorageMigration, migrateSkillsStorage } from ${JSON.stringify(module)};
			import { SkillsDoc } from ${JSON.stringify(legacy)};
			process.stdin.resume();
			const h = await Harness.open(await openNodeSqliteStorage(${JSON.stringify(first.path)}), { registry: createRegistry(), models: createModels() }, context);
			if (${JSON.stringify(crash)} === "before-commit") {
				const captured = await h.snapshot(SkillsDoc, context);
				await h.commit(async tx => {
					await commitSkillsStorageMigration(tx, captured);
					console.log("MIGRATION_READY");
					await new Promise(() => {});
				}, context);
			} else {
				await migrateSkillsStorage(h, context);
				console.log("MIGRATION_READY");
				await new Promise(() => {});
			}
		`;
		const child = Bun.spawn([process.execPath, "--eval", code], { cwd: process.cwd(), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
		try {
			// Subscribe to the exact fixture event, never a timed kill.
			await signaled((async () => {
				const decoder = new TextDecoder();
				let output = "";
				for await (const chunk of child.stdout) {
					output += decoder.decode(chunk);
					if (output.includes("MIGRATION_READY\n")) return;
				}
				throw new Error(`Migration child exited before signal: ${await new Response(child.stderr).text()}`);
			})());
			// When
			child.kill("SIGKILL");
			await child.exited;
			expect(child.signalCode).toBe("SIGKILL");
			const reopened = await open(first.path);
			// Then
			if (crash === "before-commit") {
				expect(await reopened.harness.snapshot(SkillsDoc, context)).toEqual(before);
				expect((await reopened.harness.snapshot(SkillsStorageIndexDoc, context))?.active ?? false).toBe(false);
			} else {
				expect(await snapshot(reopened.harness)).toEqual(before);
				await expect(reopened.harness.snapshot(SkillsDoc, context)).rejects.toThrow("newer version 2");
			}
		} finally {
			child.kill("SIGKILL");
			await child.exited;
		}
	}, 10_000);
}

test("future split writes change only families and index while v2 archive stays static", async () => {
	// Given
	const first = await setup();
	await migrateSkillsStorage(first.harness, context);
	const archive = await first.harness.snapshot(SkillsStorageArchiveDoc, context);
	const archiveRecord = await first.storage.findDocument({ kind: "dinobot.skills", scope: { kind: "session" } }, "current", context);
	if (!archiveRecord) throw new Error("Fixture archive record missing");
	first.hooks.writes.length = 0;
	const next = await snapshot(first.harness);
	const entry = next.skills[0];
	if (!entry) throw new Error("Fixture skill missing");
	const pkg = { ...original, body: "future body", files: { "future.txt": "future reference" } };
	const version = skillPackageHash(pkg);
	entry.versions.push({ version, package: pkg });
	entry.head = version; entry.generation++;
	entry.history.push({ name: entry.name, version, generation: entry.generation, actor: "owner", operation: "edit", proposalId: null });
	next.receipts.push({ requestId: "future-receipt", canonical: " \t[\"owner\",{\"body\":\"future original\"}]\n", result: { name: entry.name, generation: entry.generation, version } });
	delete next.loaded;
	// When
	await first.harness.commit(tx => writeSkillsState(tx, next), context);
	// Then
	expect(await snapshot(first.harness)).toEqual(next);
	expect(await first.harness.snapshot(SkillsStorageArchiveDoc, context)).toEqual(archive);
	expect(first.hooks.writes.flat().some(write => write.type === "document.change" && write.id === archiveRecord.id)).toBe(false);
	await first.close();
	const second = await open(first.path);
	expect(await snapshot(second.harness)).toEqual(next);
	expect((await second.harness.snapshot(SkillPackageStorageDoc, version, context))?.package).toEqual(pkg);
	expect((await second.harness.snapshot(SkillReceiptStorageDoc, "future-receipt", context))?.receipt?.canonical).toBe(next.receipts.at(-1)?.canonical ?? "");
});

test("warm and restarted v1 token access is rejected after migration", async () => {
	// Given
	const first = await setup();
	await first.harness.snapshot(SkillsDoc, context);
	// When
	await migrateSkillsStorage(first.harness, context);
	// Then
	await expect(first.harness.snapshot(SkillsDoc, context)).rejects.toThrow("newer version 2");
	await expect(first.harness.commit(tx => tx.doc(SkillsDoc), context)).rejects.toThrow("newer version 2");
	await first.close();
	const second = await open(first.path);
	await expect(second.harness.commit(tx => tx.doc(SkillsDoc), context)).rejects.toThrow("newer version 2");
});

for (const damage of ["missing-package", "corrupt-package", "missing-metadata", "missing-proposal", "corrupt-receipt", "missing-loaded"] as const) {
	test(`active split ${damage} fails closed without archive fallback or write repair`, async () => {
		// Given
		const state = await setup();
		await migrateSkillsStorage(state.harness, context);
		const before = await snapshot(state.harness);
		const entry = before.skills[0];
		if (!entry) throw new Error("Fixture skill missing");
		await state.harness.commit(async tx => {
			switch (damage) {
				case "missing-package": (await tx.doc(SkillPackageStorageDoc, entry.head, null)).package = null; break;
				case "corrupt-package": {
					const content = await tx.doc(SkillPackageStorageDoc, entry.head, null);
					if (!content.package) throw new Error("Fixture package missing");
					content.package.body = "tampered";
					break;
				}
				case "missing-metadata": (await tx.doc(SkillMetadataStorageDoc, entry.name, null)).metadata = null; break;
				case "missing-proposal": (await tx.doc(SkillProposalStorageDoc, state.staged.proposalId, null)).proposal = null; break;
				case "corrupt-receipt": {
					const receipt = await tx.doc(SkillReceiptStorageDoc, "candidate-input", null);
					if (!receipt.receipt) throw new Error("Fixture receipt missing");
					receipt.receipt.canonical += "changed";
					break;
				}
				case "missing-loaded": (await tx.doc(SkillLoadedStorageDoc, "conversation-fixture", null)).versions = null; break;
			}
		}, context);
		// When / Then
		await expect(snapshot(state.harness)).rejects.toBeInstanceOf(SkillStorageError);
		await expect(state.harness.commit(tx => writeSkillsState(tx, before), context)).rejects.toBeInstanceOf(SkillStorageError);
		expect((await state.harness.snapshot(SkillsStorageArchiveDoc, context))?.archive).toEqual(before);
	});
}

test("split receipt originals remain immutable under conflicting reuse and omission", async () => {
	// Given
	const { harness } = await setup();
	await migrateSkillsStorage(harness, context);
	const before = await snapshot(harness);
	const changed = await snapshot(harness);
	const receipt = changed.receipts[0];
	if (!receipt) throw new Error("Fixture receipt missing");
	receipt.canonical = "different original";
	// When / Then
	await expect(harness.commit(tx => writeSkillsState(tx, changed), context)).rejects.toThrow("receipt ID reused");
	await expect(harness.commit(tx => writeSkillsState(tx, { ...before, receipts: [] }), context)).rejects.toThrow("cannot be dropped");
	expect(await snapshot(harness)).toEqual(before);
});

test("split aggregate grows beyond old 16 MiB while each family stays within its limit", async () => {
	// Given
	const { harness } = await setup();
	await migrateSkillsStorage(harness, context);
	const before = await harness.snapshot(SkillsStorageArchiveDoc, context);
	const next = await snapshot(harness);
	for (let index = 0; index < 18; index++) {
		next.receipts.push({ requestId: `large-${index}`, canonical: "x".repeat(1024 * 1024), result: { proposalId: "fixture" } });
	}
	// When
	await harness.commit(tx => writeSkillsState(tx, next), context);
	// Then
	expect(Buffer.byteLength(JSON.stringify(await snapshot(harness)))).toBeGreaterThan(16 * 1024 * 1024);
	expect(await harness.snapshot(SkillsStorageArchiveDoc, context)).toEqual(before);
	expect(Buffer.byteLength(JSON.stringify(await harness.snapshot(SkillsStorageIndexDoc, context)))).toBeLessThan(256 * 1024);
});

test("oversized individual split document rolls back without partial receipts", async () => {
	// Given
	const { harness } = await setup();
	await migrateSkillsStorage(harness, context);
	const before = await snapshot(harness);
	const next = await snapshot(harness);
	next.receipts.push({ requestId: "oversized", canonical: "x".repeat(16 * 1024 * 1024), result: { proposalId: "fixture" } });
	// When / Then
	await expect(harness.commit(tx => writeSkillsState(tx, next), context)).rejects.toMatchObject({ code: "capacity" });
	expect(await snapshot(harness)).toEqual(before);
	expect(await harness.snapshot(SkillReceiptStorageDoc, "oversized", context)).toBeUndefined();
});
