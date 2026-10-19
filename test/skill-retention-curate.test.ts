import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineDocFamily, Harness, type Tx } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { SkillStore, SkillsDoc, type SkillPackage } from "../src/core/skills/store.ts";
import {
	bootstrapSkillManifest, classifyLegacySkillConversations, currentSkillManifest, publishSkillManifest,
	readSkillPin, skillConversationCreated, skillManifestHash,
	SkillDefaultDoc, SkillManifestDoc, SkillPinDoc,
} from "../src/core/skills/manifests.ts";
import {
	SkillLifecycleDoc, SkillLifecycleError, SkillLifecycleReceiptDoc, SkillRetentionService, SkillVersionRetentionDoc,
	type NoninferiorityAuthorization, type SkillCurationRequest, type SkillRetentionOptions,
} from "../src/core/skills/retention.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const pkg: SkillPackage = {
	name: "fixture", description: "Fixture", body: "origin body", files: { "ref.txt": "origin reference" },
	source: "fixture:origin", originalSkillMd: "---\nname: fixture\n---\noriginal bytes\n",
};
const TrustedEvidenceDoc = defineDocFamily<{ witness: NoninferiorityAuthorization | null }, null>({
	kind: "test.curate.trusted-evidence", version: 1, scope: "session", family: true,
	initial: () => ({ witness: null }),
});
type Options = Partial<Omit<SkillRetentionOptions, "now" | "authorize">>;
async function open(path: string, clock = { value: 1_000 }, options: Options = {}) {
	const calls = { authorize: 0 };
	const service = new SkillRetentionService({
		now: () => clock.value, ...options,
		authorize: async (tx, request) => {
			calls.authorize++;
			const witness = (await tx.doc(TrustedEvidenceDoc, request.evidenceId, null)).witness;
			if (!witness) throw new SkillLifecycleError("evidence", "No trusted sealed noninferiority evidence");
			return { ...witness };
		},
	});
	const harness = await Harness.open(await openNodeSqliteStorage(path), {
		registry: createRegistry(), models: createModels(),
		conversationCreated: async (tx, record) => {
			await skillConversationCreated(tx, record);
			await service.pinAcquired(tx, record);
		},
	}, context);
	let closed = false;
	const close = async () => { if (!closed) { closed = true; await harness.close(context); } };
	cleanup.push(close);
	return { harness, service, clock, path, close, calls, store: new SkillStore(harness, { managedManifests: true }) };
}
type Fixture = Awaited<ReturnType<typeof open>>;
async function setup(options: Options = {}) {
	const directory = await mkdtemp(join(tmpdir(), "skill-curate-"));
	cleanup.push(() => rm(directory, { recursive: true, force: true }));
	const state = await open(join(directory, "curate.sqlite"), { value: 1_000 }, options);
	await state.harness.commit(classifyLegacySkillConversations, context);
	await state.harness.commit(tx => bootstrapSkillManifest(tx, "skills-v1"), context);
	await state.store.initialize([pkg], context);
	await state.harness.commit(tx => state.service.acknowledgeRootInventory(tx, { revision: "fixture-v1", families: [] }), context);
	return state;
}
async function request(state: Fixture, operation: "deactivate" | "reactivate", requestId: string, extra: Partial<SkillCurationRequest> = {}): Promise<SkillCurationRequest> {
	return state.harness.commit(async (tx: Tx) => ({
		name: pkg.name, operation,
		expectedRevision: (await tx.doc(SkillLifecycleDoc, pkg.name, null)).revision,
		expectedDefaultGeneration: (await tx.doc(SkillDefaultDoc)).publication?.generation ?? 0,
		requestId, actor: "host:curator", reason: `unused for ${operation}`, ...extra,
	}), context);
}
async function curate(state: Fixture, operation: "deactivate" | "reactivate", requestId: string, extra: Partial<SkillCurationRequest> = {}) {
	const input = await request(state, operation, requestId, extra);
	return state.harness.commit(tx => state.service.curate(tx, input), context);
}
/** Mirrors test/skill-retention.test.ts: trusted witness for the statistical transition path. */
async function registerEvidence(state: Fixture, operation: "deactivate" | "reactivate", evidenceId: string) {
	return state.harness.commit(async tx => {
		const publication = (await tx.doc(SkillDefaultDoc)).publication;
		if (!publication) throw new Error("Fixture default missing");
		const manifest = (await tx.doc(SkillManifestDoc, publication.manifestHash, null)).manifest;
		if (!manifest) throw new Error("Fixture manifest missing");
		const lifecycle = await tx.doc(SkillLifecycleDoc, pkg.name, null);
		const candidate = await state.service.preview(tx, { name: pkg.name, operation, expectedRevision: lifecycle.revision, expectedDefaultGeneration: publication.generation });
		(await tx.doc(TrustedEvidenceDoc, evidenceId, null)).witness = {
			evidenceId, name: pkg.name, operation, baselineManifestHash: publication.manifestHash,
			candidateManifestHash: skillManifestHash(candidate),
			defaultGeneration: publication.generation, contractHash: "a".repeat(64), evidenceHash: "b".repeat(64),
			qualityLowerBound: -0.01, qualityLoss: 0.05, anchorLowerBound: -0.01, anchorLoss: 0.05,
			hypothesis: "efficiency", utilityLowerBound: 0.5, utilityImprovement: 0.01, horizonUses: 100, researchCostUpperBound: 1,
		};
		return { name: pkg.name, operation, expectedRevision: lifecycle.revision, expectedDefaultGeneration: publication.generation, evidenceId, requestId: evidenceId };
	}, context);
}
function conversation(state: Fixture) {
	return state.harness.commit(tx => tx.createConversation({ ownership: { kind: "ownerless" } }), context);
}
async function pinnedNames(state: Fixture, id: Awaited<ReturnType<typeof conversation>>["id"]) {
	const pin = await state.harness.commit(tx => readSkillPin(tx, id), context);
	const manifest = (await state.harness.snapshot(SkillManifestDoc, pin.manifestHash, context))?.manifest;
	return Object.keys(manifest?.versions ?? {});
}

test("curate archive and restore keep bytes and old pins without noninferiority authorization", async () => {
	// Given
	const first = await setup();
	const old = await conversation(first);
	const before = await first.harness.snapshot(SkillsDoc, context);
	const oldPin = await first.harness.snapshot(SkillPinDoc, old.id, context);
	const originalDefault = (await first.harness.snapshot(SkillDefaultDoc, context))?.publication;
	const originalManifest = originalDefault ? (await first.harness.snapshot(SkillManifestDoc, originalDefault.manifestHash, context))?.manifest : null;
	// When
	const archived = await curate(first, "deactivate", "archive-1", { actor: "agent:42", reason: "idle for 149 exposures" });
	// Then
	expect(first.calls.authorize).toBe(0);
	expect(archived.actor).toBe("agent:42");
	expect(archived.decision).toBe(`curation:deactivate:${createHash("sha256").update("idle for 149 exposures").digest("hex").slice(0, 16)}`);
	expect(archived.requestId).toBe("curation:archive-1");
	expect(archived.generation).toBe((originalDefault?.generation ?? 0) + 1);
	const lifecycle = await first.harness.snapshot(SkillLifecycleDoc, pkg.name, context);
	expect(lifecycle).toMatchObject({ status: "inactive", revision: 1, evidenceId: "curation:archive-1", catalogIndex: 0, dependencies: [] });
	const fresh = await conversation(first);
	expect(await pinnedNames(first, fresh.id)).not.toContain(pkg.name);
	expect(await pinnedNames(first, old.id)).toContain(pkg.name);
	expect(await first.harness.snapshot(SkillPinDoc, old.id, context)).toEqual(oldPin);
	expect(await first.harness.snapshot(SkillsDoc, context)).toEqual(before);
	expect(await first.harness.commit(tx => first.service.filterSourcePackages(tx, [pkg]), context)).toEqual([]);
	await first.close();
	// When (restart, restore)
	const second = await open(first.path, first.clock);
	const restored = await curate(second, "reactivate", "restore-1", { actor: "host:skill-review", reason: "requested" });
	// Then
	expect(second.calls.authorize).toBe(0);
	expect(restored.actor).toBe("host:skill-review");
	expect(restored.decision.startsWith("curation:reactivate:")).toBe(true);
	expect((await second.harness.snapshot(SkillManifestDoc, restored.manifestHash, context))?.manifest).toEqual(originalManifest);
	expect(await second.harness.snapshot(SkillLifecycleDoc, pkg.name, context)).toMatchObject({ status: "active", revision: 2, evidenceId: "curation:restore-1" });
	const head = (await second.harness.snapshot(SkillsDoc, context))?.skills[0]?.head ?? "";
	expect((await second.harness.snapshot(SkillVersionRetentionDoc, head, context))?.phase).toBe("retained");
	expect(await second.harness.snapshot(SkillsDoc, context)).toEqual(before);
	expect(await pinnedNames(second, (await conversation(second)).id)).toContain(pkg.name);
	expect(await pinnedNames(second, fresh.id)).not.toContain(pkg.name);
});

for (const guard of ["protected", "rare-recovery", "dependency"] as const) {
	test(`curate respects ${guard} guard without changing publication`, async () => {
		// Given
		const state = await setup(guard === "protected" ? { protectedNames: [pkg.name] } : guard === "rare-recovery" ? { rareRecoveryNames: [pkg.name] } : {});
		if (guard === "dependency") {
			await state.store.initialize([{ ...pkg, name: "dependent", source: "fixture:dependent" }], context);
			await state.harness.commit(async tx => {
				const manifest = await currentSkillManifest(tx, "skills-v1", { fixture: [], dependent: [pkg.name] });
				await publishSkillManifest(tx, { manifest, expectedGeneration: (await tx.doc(SkillDefaultDoc)).publication?.generation ?? 0, actor: "host", decision: "fixture", requestId: "dependent-manifest" });
			}, context);
		}
		const before = await state.harness.snapshot(SkillDefaultDoc, context);
		// When / Then
		await expect(curate(state, "deactivate", `guard-${guard}`)).rejects.toMatchObject({ code: "guard" });
		expect(await state.harness.snapshot(SkillDefaultDoc, context)).toEqual(before);
		expect((await state.harness.snapshot(SkillLifecycleDoc, pkg.name, context))?.status).toBe("active");
		expect((await state.harness.snapshot(SkillLifecycleReceiptDoc, `guard-${guard}`, context))?.publication ?? null).toBeNull();
	});
}

test("default protected names cannot be curated", async () => {
	const state = await setup();
	await state.store.initialize([{ ...pkg, name: "programming", source: "fixture:programming" }], context);
	const input = await request(state, "deactivate", "protected-default");
	await expect(state.harness.commit(tx => state.service.curate(tx, { ...input, name: "programming", expectedRevision: 0 }), context)).rejects.toMatchObject({ code: "guard" });
});

test("curate state conflicts: wrong operation, stale revision and stale generation", async () => {
	const state = await setup();
	await expect(curate(state, "reactivate", "not-inactive")).rejects.toMatchObject({ code: "conflict" });
	const stale = await request(state, "deactivate", "stale-generation");
	await curate(state, "deactivate", "archive");
	await expect(state.harness.commit(tx => state.service.curate(tx, stale), context)).rejects.toMatchObject({ code: "conflict" });
	await expect(curate(state, "reactivate", "stale-revision", { expectedRevision: 0 })).rejects.toMatchObject({ code: "conflict" });
	await expect(curate(state, "deactivate", "already-archived")).rejects.toMatchObject({ code: "conflict" });
});

test("curate validates actor, request id and reason", async () => {
	const state = await setup();
	for (const extra of [{ actor: "" }, { requestId: " " }, { reason: "" }, { reason: "   " }, { reason: "x".repeat(4001) }]) {
		await expect(curate(state, "deactivate", "invalid", extra)).rejects.toMatchObject({ code: "integrity" });
	}
	expect((await state.harness.snapshot(SkillLifecycleDoc, pkg.name, context))?.status ?? "active").toBe("active");
});

test("curate receipts deduplicate exact retry across restart and reject conflicting reuse", async () => {
	// Given
	const first = await setup();
	const input = await request(first, "deactivate", "archive");
	const published = await first.harness.commit(tx => first.service.curate(tx, input), context);
	await first.close();
	const second = await open(first.path, first.clock);
	// When / Then
	expect(await second.harness.commit(tx => second.service.curate(tx, input), context)).toEqual(published);
	expect((await second.harness.snapshot(SkillDefaultDoc, context))?.publication).toEqual(published);
	expect((await second.harness.snapshot(SkillLifecycleDoc, pkg.name, context))?.revision).toBe(1);
	for (const change of [{ reason: "other" }, { actor: "host:skill-review" }, { expectedRevision: 1 }]) {
		await expect(second.harness.commit(tx => second.service.curate(tx, { ...input, ...change }), context)).rejects.toThrow("reused");
	}
});

test("request ids cannot be replayed from transition into curate", async () => {
	// Given
	const state = await setup();
	const input = await registerEvidence(state, "deactivate", "shared-id");
	const published = await state.harness.commit(tx => state.service.transition(tx, input), context);
	expect(state.calls.authorize).toBe(1);
	// When / Then
	await expect(state.harness.commit(tx => state.service.curate(tx, {
		name: input.name, operation: input.operation, expectedRevision: input.expectedRevision,
		expectedDefaultGeneration: input.expectedDefaultGeneration, requestId: input.requestId, actor: "host:curator", reason: "replay",
	}), context)).rejects.toThrow("reused");
	expect((await state.harness.snapshot(SkillDefaultDoc, context))?.publication).toEqual(published);
});

test("request ids cannot be replayed from curate into transition", async () => {
	// Given
	const state = await setup();
	const evidence = await registerEvidence(state, "deactivate", "shared-id");
	const published = await curate(state, "deactivate", "shared-id");
	// When / Then
	await expect(state.harness.commit(tx => state.service.transition(tx, evidence), context)).rejects.toThrow("reused");
	expect(state.calls.authorize).toBe(0);
	expect((await state.harness.snapshot(SkillDefaultDoc, context))?.publication).toEqual(published);
	expect((await state.harness.snapshot(SkillLifecycleDoc, pkg.name, context))?.revision).toBe(1);
});

test("curate and transition interoperate on the same lifecycle state", async () => {
	const state = await setup();
	await curate(state, "deactivate", "archive");
	const evidence = await registerEvidence(state, "reactivate", "restore");
	const restored = await state.harness.commit(tx => state.service.transition(tx, evidence), context);
	expect(restored.actor).toBe("host:lifecycle");
	expect(await state.harness.snapshot(SkillLifecycleDoc, pkg.name, context)).toMatchObject({ status: "active", revision: 2, evidenceId: "restore" });
});
