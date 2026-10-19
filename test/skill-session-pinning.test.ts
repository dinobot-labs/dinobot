import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineTask, Harness, type Tx } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { SkillStore, SkillsDoc, type SkillPackage } from "../src/core/skills/store.ts";
import {
	assertSkillPublicationAllowed, bootstrapSkillManifest, canonicalSkillManifest, classifyLegacySkillConversations,
	closeSkillRetention, currentSkillManifest, pinnedSkillManifest, publishSkillManifest,
	readSkillPin, resolvePinnedSkill, skillConversationCreated, skillManifestHash,
	SkillDefaultDoc, SkillManifestDoc, SkillManifestError, SkillPinDoc, SkillPublicationDoc, SkillRetentionDoc,
	type DeploymentManifest, type PublishSkillManifest,
} from "../src/core/skills/manifests.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const pkg: SkillPackage = { name: "example", description: "Example", body: "old", source: "bundled:example", files: { "ref.txt": "old ref" } };
const ownerTask = defineTask<null, { phase: "run" }, null>({
	name: "test.pin-owner", version: 1, initial: () => ({ phase: "run" }),
	phases: { run: async (_task, runtime, ctx) => {
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
	} },
	abort: async (_task, runtime, ctx) => {
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
	},
});
async function open(path: string, pinning = true, trackDisabled = false) {
	const models = createModels();
	models.setProvider(fauxProvider({ provider: "faux", models: [{ id: "one" }] }).provider);
	const registry = createRegistry();
	registry.install({ name: "test-pins", tasks: [ownerTask] });
	const harness = await Harness.open(await openNodeSqliteStorage(path), {
		models, registry, ...(pinning || trackDisabled ? { conversationCreated: (tx: Tx, record: Parameters<typeof skillConversationCreated>[1]) => skillConversationCreated(tx, record, pinning) } : {}),
	}, context);
	let closed = false;
	const close = async () => { if (!closed) { closed = true; await harness.close(context); } };
	cleanup.push(close);
	return { harness, store: new SkillStore(harness), close };
}
async function setup(packages: SkillPackage[] = [pkg], pinning = true) {
	const dir = await mkdtemp(join(tmpdir(), "skill-pins-"));
	cleanup.push(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "pins.sqlite");
	const runtime = await open(path, pinning);
	await runtime.store.initialize(packages, context);
	await runtime.harness.commit(classifyLegacySkillConversations, context);
	const manifest = await runtime.harness.commit(tx => currentSkillManifest(tx, "routing-1"), context);
	const input: PublishSkillManifest = { manifest, requestId: "bootstrap", actor: "source", decision: "bootstrap", expectedGeneration: 0 };
	const publication = await runtime.harness.commit(tx => publishSkillManifest(tx, input), context);
	return { ...runtime, path, manifest, input, publication };
}
function create(harness: Harness) {
	return harness.commit(tx => tx.createConversation({ ownership: { kind: "ownerless" } }), context);
}
async function next(harness: Harness, store: SkillStore, generation = 1) {
	await store.initialize([{ ...pkg, body: "new", files: { "ref.txt": "new ref" } }], context);
	const manifest = await harness.commit(tx => currentSkillManifest(tx, "routing-2"), context);
	return { manifest, expectedGeneration: generation, actor: "source", decision: "upstream", requestId: "new-default" } satisfies PublishSkillManifest;
}

test("canonical hashes preserve catalog order but normalize maps and dependency edges", async () => {
	// Given
	const { manifest } = await setup([pkg, { ...pkg, name: "second", source: "bundled:second" }, { ...pkg, name: "third", source: "bundled:third" }]);
	const deps = { example: ["third", "second"], second: [], third: [] };
	const first = { ...manifest, dependencies: deps };
	const reordered = { ...manifest, versions: Object.fromEntries(Object.entries(manifest.versions).reverse()), dependencies: { third: [], second: [], example: ["second", "third"] } };
	// When
	const digest = skillManifestHash(first);
	// Then
	expect(skillManifestHash(reordered)).toBe(digest);
	expect(skillManifestHash({ ...first, catalog: [...first.catalog].reverse() })).not.toBe(digest);
	expect(skillManifestHash({ ...first, routingRevision: "routing-3" })).not.toBe(digest);
	expect(() => canonicalSkillManifest({ ...first, dependencies: { example: ["missing"], second: [], third: [] } })).toThrow(SkillManifestError);
	expect(() => canonicalSkillManifest({ ...first, dependencies: { example: ["second"], second: ["example"], third: [] } })).toThrow("cycle");
	expect(() => canonicalSkillManifest({ ...first, versions: { ...first.versions, example: "bad" } })).toThrow(SkillManifestError);
});

test("empty bootstrap precedes conversations and unchanged startup avoids generation churn", async () => {
	// Given
	const first = await setup([]);
	await first.close();
	const second = await open(first.path);
	const input = { ...first.input, requestId: "restart-bootstrap", expectedGeneration: 1 };
	// When
	const repeated = await second.harness.commit(tx => publishSkillManifest(tx, input), context);
	const conversation = await create(second.harness);
	// Then
	expect(repeated).toEqual(first.publication);
	expect(await second.harness.commit(tx => pinnedSkillManifest(tx, conversation.id), context)).toEqual(first.manifest);
	expect((await second.harness.snapshot(SkillDefaultDoc, context))?.publication?.generation).toBe(1);
	expect((await second.harness.snapshot(SkillPublicationDoc, input.requestId, context))?.publication).toEqual(first.publication);
});

test("creation and publication race selects complete old and new manifests on one writer", async () => {
	// Given
	const { harness, store, manifest, publication } = await setup();
	const update = await next(harness, store);
	// When: enqueue both sides of the linearization point without sleeps.
	const [old, published, fresh] = await Promise.all([
		create(harness),
		harness.commit(tx => publishSkillManifest(tx, update), context),
		create(harness),
	]);
	// Then
	expect(await harness.commit(tx => pinnedSkillManifest(tx, old.id), context)).toEqual(manifest);
	expect(await harness.commit(tx => pinnedSkillManifest(tx, fresh.id), context)).toEqual(update.manifest);
	expect((await harness.commit(tx => readSkillPin(tx, old.id), context)).generation).toBe(publication.generation);
	expect((await harness.commit(tx => readSkillPin(tx, fresh.id), context)).generation).toBe(published.generation);
	expect(await store.readFile("example", manifest.versions.example ?? "", "ref.txt", context)).toBe("old ref");
});

test("pins retain captured summary metadata and publication generation is separate", async () => {
	// Given
	const { harness, store } = await setup();
	const conversation = await create(harness);
	const before = await store.list(context);
	await store.initialize([{ ...pkg, body: "second" }], context);
	await store.initialize([{ ...pkg, body: "third" }], context);
	const manifest = await harness.commit(tx => currentSkillManifest(tx, "routing-1"), context);
	// When
	const published = await harness.commit(tx => publishSkillManifest(tx, { manifest, requestId: "third", actor: "source", decision: "upstream", expectedGeneration: 1 }), context);
	// Then
	expect(manifest.catalog[0]?.generation).toBe(3);
	expect(published.generation).toBe(2);
	expect((await harness.commit(tx => pinnedSkillManifest(tx, conversation.id), context)).catalog).toEqual(before);
});

test("pins, receipts, bytes and independent child roots survive SQLite restart", async () => {
	// Given
	const first = await setup();
	const parent = await create(first.harness);
	const child = await first.harness.commit(async tx => {
		const taskId = await tx.createTask(ownerTask, null, { conversationId: parent.id, ownership: { kind: "conversation" } });
		return tx.createConversation({ ownership: { kind: "task", taskId } });
	}, context);
	const update = await next(first.harness, first.store);
	await first.harness.commit(tx => publishSkillManifest(tx, update), context);
	await first.harness.commit(tx => closeSkillRetention(tx, parent.id), context);
	await first.close();
	// When
	const second = await open(first.path);
	const childPin = await second.harness.commit(tx => readSkillPin(tx, child.id), context);
	// Then
	expect(childPin.manifestHash).toBe(first.publication.manifestHash);
	expect(await second.store.readFile("example", first.manifest.versions.example ?? "", "ref.txt", context)).toBe("old ref");
	expect((await second.harness.snapshot(SkillRetentionDoc, child.id, context))?.closed).toBe(false);
	await expect(second.harness.commit(tx => readSkillPin(tx, parent.id), context)).rejects.toThrow("explicitly closed");
	expect(await second.harness.commit(tx => publishSkillManifest(tx, first.input), context)).toEqual(first.publication);
});

test("history fork inherits current immutable pin and acquires its own root", async () => {
	// Given
	const { harness, store, publication } = await setup();
	const parent = await create(harness);
	const entry = await harness.commit(tx => tx.appendEntry(parent.id, { kind: "test.history" }), context);
	const update = await next(harness, store);
	await harness.commit(tx => publishSkillManifest(tx, update), context);
	// When
	const child = await harness.commit(tx => tx.forkConversation(parent.id, entry.id, { ownership: { kind: "ownerless" } }), context);
	await harness.commit(tx => closeSkillRetention(tx, parent.id), context);
	// Then
	expect(SkillPinDoc.definition.history).toBe("latest");
	expect(SkillPinDoc.definition.fork).toBe("current");
	expect((await harness.commit(tx => readSkillPin(tx, child.id), context)).manifestHash).toBe(publication.manifestHash);
	expect((await harness.snapshot(SkillRetentionDoc, child.id, context))?.closed).toBe(false);
});

test("different owner and history parent pins reject fork creation atomically", async () => {
	// Given
	const { harness, store } = await setup();
	const old = await create(harness);
	const entry = await harness.commit(tx => tx.appendEntry(old.id, { kind: "test.history" }), context);
	await harness.commit(tx => nextPublication(tx), context);
	async function nextPublication(tx: Tx) {
		return publishSkillManifest(tx, { manifest: await currentSkillManifest(tx, "other-routing"), expectedGeneration: 1, requestId: "routing", actor: "owner", decision: "manual_unverified" });
	}
	const fresh = await create(harness);
	const taskId = await harness.commit(tx => tx.createTask(ownerTask, null, { conversationId: fresh.id, ownership: { kind: "conversation" } }), context);
	const before = await harness.commit(tx => tx.scanConversations({}, 128), context);
	// When / Then
	await expect(harness.commit(tx => tx.forkConversation(old.id, entry.id, { ownership: { kind: "task", taskId } }), context)).rejects.toThrow("pins differ");
	expect((await harness.commit(tx => tx.scanConversations({}, 128), context)).items).toEqual(before.items);
	expect(await store.list(context)).toHaveLength(1);
});

test("explicit version mismatch and unknown name never resolve latest", async () => {
	// Given
	const { harness, store, manifest } = await setup();
	const old = await create(harness);
	const update = await next(harness, store);
	await harness.commit(tx => publishSkillManifest(tx, update), context);
	// When / Then
	expect(await harness.commit(tx => resolvePinnedSkill(tx, old.id, "example"), context)).toBe(manifest.versions.example ?? "");
	await expect(harness.commit(tx => resolvePinnedSkill(tx, old.id, "example", update.manifest.versions.example), context)).rejects.toThrow("differs");
	await expect(harness.commit(tx => resolvePinnedSkill(tx, old.id, "absent"), context)).rejects.toThrow("absent");
});

for (const corruption of ["manifest", "package", "pin", "root", "receipt", "receipt-result"] as const) {
	test(`corrupt ${corruption} fails explicitly without latest fallback`, async () => {
		// Given
		const { harness, publication } = await setup();
		const conversation = await create(harness);
		await harness.commit(async tx => {
			switch (corruption) {
				case "manifest": {
					const doc = await tx.doc(SkillManifestDoc, publication.manifestHash, null);
					if (!doc.manifest) throw new SkillManifestError("integrity", "fixture manifest absent");
					doc.manifest.routingRevision = "tampered";
					break;
				}
				case "package": {
					const state = await tx.doc(SkillsDoc);
					const stored = state.skills[0]?.versions[0];
					if (!stored) throw new SkillManifestError("integrity", "fixture package absent");
					stored.package.body = "tampered";
					break;
				}
				case "pin": (await tx.doc(SkillPinDoc, conversation.id)).pin = null; break;
				case "root": (await tx.doc(SkillRetentionDoc, conversation.id)).manifestHash = null; break;
				case "receipt": (await tx.doc(SkillPublicationDoc, publication.requestId, null)).publication = null; break;
				case "receipt-result": {
					const receipt = await tx.doc(SkillPublicationDoc, publication.requestId, null);
					if (!receipt.publication) throw new SkillManifestError("integrity", "fixture receipt absent");
					receipt.publication.actor = "tampered";
					break;
				}
			}
		}, context);
		// When / Then
		await expect(harness.commit(tx => resolvePinnedSkill(tx, conversation.id, "example"), context)).rejects.toBeInstanceOf(SkillManifestError);
		if (corruption === "manifest" || corruption === "package" || corruption === "receipt" || corruption === "receipt-result") {
			await expect(create(harness)).rejects.toBeInstanceOf(SkillManifestError);
		}
	});
}

test("same receipt is idempotent after restart and conflicting actor input or CAS fails", async () => {
	// Given
	const first = await setup();
	await first.close();
	const { harness } = await open(first.path);
	// When
	const replay = await harness.commit(tx => publishSkillManifest(tx, first.input), context);
	// Then
	expect(replay).toEqual(first.publication);
	for (const changed of [{ actor: "other" }, { decision: "other" }, { expectedGeneration: 1 }, { manifest: { ...first.manifest, routingRevision: "other" } }]) {
		await expect(harness.commit(tx => publishSkillManifest(tx, { ...first.input, ...changed }), context)).rejects.toThrow("reused");
	}
	await expect(harness.commit(tx => publishSkillManifest(tx, { ...first.input, requestId: "stale" }), context)).rejects.toThrow("generation conflict");
	expect((await harness.snapshot(SkillDefaultDoc, context))?.publication).toEqual(first.publication);
});

test("competing default CAS commits exactly one publication and receipt", async () => {
	// Given
	const { harness, manifest } = await setup();
	const a = { manifest: { ...manifest, routingRevision: "a" }, expectedGeneration: 1, requestId: "a", actor: "owner", decision: "manual_unverified" };
	const b = { ...a, manifest: { ...manifest, routingRevision: "b" }, requestId: "b" };
	// When
	const outcomes = await Promise.allSettled([
		harness.commit(tx => publishSkillManifest(tx, a), context),
		harness.commit(tx => publishSkillManifest(tx, b), context),
	]);
	// Then
	expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
	expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
	expect((await harness.snapshot(SkillDefaultDoc, context))?.publication?.generation).toBe(2);
	const receipts = await Promise.all(["a", "b"].map(id => harness.snapshot(SkillPublicationDoc, id, context)));
	expect(receipts.filter(Boolean)).toHaveLength(1);
});

test("activation metadata publication and receipt commit on the same transaction", async () => {
	// Given
	const { harness, store, publication } = await setup();
	const old = await create(harness);
	const update = await next(harness, store);
	// When
	const committed = await harness.commit(async tx => {
		const skills = await tx.doc(SkillsDoc);
		const head = skills.skills[0];
		if (!head) throw new SkillManifestError("integrity", "fixture head absent");
		head.generation++;
		const manifest = await currentSkillManifest(tx, update.manifest.routingRevision);
		return publishSkillManifest(tx, { ...update, manifest });
	}, context);
	// Then
	expect((await harness.snapshot(SkillsDoc, context))?.skills[0]?.generation).toBe(3);
	expect((await harness.snapshot(SkillPublicationDoc, update.requestId, context))?.publication).toEqual(committed);
	expect((await harness.snapshot(SkillDefaultDoc, context))?.publication).toEqual(committed);
	expect((await harness.commit(tx => readSkillPin(tx, old.id), context)).manifestHash).toBe(publication.manifestHash);
});

test("publication and SkillsDoc activation roll back together on invalid manifest", async () => {
	// Given
	const { harness, store, manifest } = await setup();
	const before = await store.list(context);
	// When
	await expect(harness.commit(async tx => {
		const state = await tx.doc(SkillsDoc);
		const head = state.skills[0];
		if (!head) throw new SkillManifestError("integrity", "fixture head absent");
		head.generation++;
		await publishSkillManifest(tx, { manifest, requestId: "bad", actor: "owner", decision: "manual_unverified", expectedGeneration: 1 });
	}, context)).rejects.toThrow("current skill head");
	// Then
	expect(await store.list(context)).toEqual(before);
	expect(await harness.snapshot(SkillPublicationDoc, "bad", context)).toBeUndefined();
	expect((await harness.snapshot(SkillDefaultDoc, context))?.publication?.generation).toBe(1);
});

test("classified resumable legacy conversations do not block the shared activation boundary", async () => {
	// Given
	const first = await setup([pkg], false);
	const legacy = await create(first.harness);
	await first.close();
	const { harness } = await open(first.path);
	// When
	expect(await harness.commit(classifyLegacySkillConversations, context)).toBe(1);
	// Then: publication proceeds (ADR 0037) and the legacy record still gets no fabricated pin.
	await harness.commit(assertSkillPublicationAllowed, context);
	expect((await harness.commit(tx => publishSkillManifest(tx, { ...first.input, expectedGeneration: 1, requestId: "startup" }), context)).generation).toBe(1);
	await expect(harness.commit(tx => readSkillPin(tx, legacy.id), context)).rejects.toThrow("no skill pin");
	await harness.commit(tx => closeSkillRetention(tx, legacy.id), context);
	expect(await harness.commit(classifyLegacySkillConversations, context)).toBe(0);
	await harness.commit(assertSkillPublicationAllowed, context);
});

test("missing default rejects creation and unclassified bootstrap rejects publication", async () => {
	// Given
	const dir = await mkdtemp(join(tmpdir(), "skill-pins-empty-"));
	cleanup.push(() => rm(dir, { recursive: true, force: true }));
	const { harness } = await open(join(dir, "pins.sqlite"));
	const empty: DeploymentManifest = { catalog: [], versions: {}, dependencies: {}, routingRevision: "routing-1" };
	// When / Then
	await expect(create(harness)).rejects.toThrow("No default");
	await expect(harness.commit(tx => publishSkillManifest(tx, { manifest: empty, expectedGeneration: 0, requestId: "empty", actor: "source", decision: "bootstrap" }), context)).rejects.toThrow("Unclassified");
	await expect(harness.commit(tx => bootstrapSkillManifest(tx, "routing-1"), context)).rejects.toThrow("Unclassified");
	expect((await harness.commit(tx => tx.scanConversations({}, 128), context)).items).toHaveLength(0);
});

test("first retained-head snapshot permits new pins despite legacy without activating packages", async () => {
	// Given: a pre-pinning SQLite database with retained heads, no default, and a resumable legacy conversation.
	const dir = await mkdtemp(join(tmpdir(), "skill-pins-legacy-bootstrap-"));
	cleanup.push(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "pins.sqlite");
	const first = await open(path, false);
	await first.store.initialize([pkg], context);
	const legacy = await create(first.harness);
	await first.close();
	const { harness } = await open(path);
	expect(await harness.commit(classifyLegacySkillConversations, context)).toBe(1);
	const before = await harness.snapshot(SkillsDoc, context);
	// When
	const publication = await harness.commit(tx => bootstrapSkillManifest(tx, "routing-1"), context);
	const fresh = await create(harness);
	// Then
	expect(publication.generation).toBe(1);
	expect(await harness.snapshot(SkillsDoc, context)).toEqual(before);
	expect((await harness.commit(tx => readSkillPin(tx, fresh.id), context)).manifestHash).toBe(publication.manifestHash);
	await expect(harness.commit(tx => readSkillPin(tx, legacy.id), context)).rejects.toThrow("no skill pin");
	expect((await harness.snapshot(SkillDefaultDoc, context))?.legacyCount).toBe(1);
	await harness.commit(assertSkillPublicationAllowed, context);
});

test("bootstrap cannot mutate an existing default while legacy conversations exist", async () => {
	// Given
	const first = await setup([pkg], false);
	await create(first.harness);
	await first.harness.commit(classifyLegacySkillConversations, context);
	const before = await first.harness.snapshot(SkillsDoc, context);
	await first.close();
	const { harness } = await open(first.path);
	// When
	const result = await harness.commit(tx => bootstrapSkillManifest(tx, "different-routing"), context);
	// Then
	expect(result).toEqual(first.publication);
	expect((await harness.snapshot(SkillDefaultDoc, context))?.publication).toEqual(first.publication);
	expect(await harness.snapshot(SkillsDoc, context)).toEqual(before);
	const manifest = { ...first.manifest, routingRevision: "different-routing" };
	// Only an explicit publication, not bootstrap, advances the default.
	expect((await harness.commit(tx => publishSkillManifest(tx, { ...first.input, manifest, expectedGeneration: 1, requestId: "later-mutation" }), context)).generation).toBe(2);
});

test("disabled pinning registers new legacy but preserves child and fork pin roots", async () => {
	// Given
	const first = await setup();
	const parent = await create(first.harness);
	const entry = await first.harness.commit(tx => tx.appendEntry(parent.id, { kind: "test.history" }), context);
	await first.close();
	const { harness } = await open(first.path, false, true);
	// When
	const legacy = await create(harness);
	const child = await harness.commit(async tx => {
		const taskId = await tx.createTask(ownerTask, null, { conversationId: parent.id, ownership: { kind: "conversation" } });
		return tx.createConversation({ ownership: { kind: "task", taskId } });
	}, context);
	const fork = await harness.commit(tx => tx.forkConversation(parent.id, entry.id, { ownership: { kind: "ownerless" } }), context);
	await harness.commit(tx => closeSkillRetention(tx, parent.id), context);
	// Then
	expect((await harness.snapshot(SkillDefaultDoc, context))?.legacyCount).toBe(1);
	await expect(harness.commit(tx => readSkillPin(tx, legacy.id), context)).rejects.toThrow("no skill pin");
	for (const record of [child, fork]) {
		expect((await harness.commit(tx => readSkillPin(tx, record.id), context)).manifestHash).toBe(first.publication.manifestHash);
		expect((await harness.snapshot(SkillRetentionDoc, record.id, context))?.closed).toBe(false);
	}
	await harness.commit(assertSkillPublicationAllowed, context);
});

test("disabled creation legacy registration is idempotent and transactional", async () => {
	// Given
	const first = await setup();
	await first.close();
	const { harness } = await open(first.path, false, true);
	const legacy = await create(harness);
	// When
	await harness.commit(tx => skillConversationCreated(tx, legacy, false), context);
	await expect(harness.commit(async tx => {
		await tx.createConversation({ ownership: { kind: "ownerless" } });
		throw new SkillManifestError("conflict", "test rollback");
	}, context)).rejects.toThrow("test rollback");
	// Then
	expect((await harness.snapshot(SkillDefaultDoc, context))?.legacyCount).toBe(1);
	expect((await harness.commit(tx => tx.scanConversations({}, 128), context)).items).toEqual([legacy]);
	expect(await harness.commit(classifyLegacySkillConversations, context)).toBe(1);
});

test("new bundle colliding with an agent skill leaves the managed default and conversation pin unchanged", async () => {
	const { harness, store } = await setup([]);
	const managed = new SkillStore(harness, { managedManifests: true });
	const proposal = await managed.propose({ name: "example", description: "Local", body: "local", files: {}, expectedGeneration: 0, requestId: "local" }, "agent", context);
	await managed.publish({ proposalId: proposal.proposalId, requestId: "local-publish" }, "agent", context);
	const conversation = await create(harness);
	const before = await harness.snapshot(SkillDefaultDoc, context);
	const pinned = await managed.executionLoad({ conversationId: conversation.id, name: "example" }, context);
	await managed.initialize([pkg], context);
	await managed.initialize([pkg], context);
	expect(await harness.snapshot(SkillDefaultDoc, context)).toEqual(before);
	expect(await managed.executionLoad({ conversationId: conversation.id, name: "example" }, context)).toEqual(pinned);
	const pending = await store.pending(context);
	expect(pending).toHaveLength(1);
	await managed.publish({ proposalId: pending[0]!.proposalId, requestId: "accept-bundle" }, "user", context);
	expect(await managed.executionLoad({ conversationId: conversation.id, name: "example" }, context)).toEqual(pinned);
	const fresh = await create(harness);
	expect(await managed.executionLoad({ conversationId: fresh.id, name: "example" }, context)).toMatchObject(pkg);
});
