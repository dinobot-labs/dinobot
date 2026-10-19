import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineDocFamily, Harness, type ConversationId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { SkillStore, SkillsDoc, type SkillPackage } from "../src/core/skills/store.ts";
import {
	bootstrapSkillManifest, classifyLegacySkillConversations, skillConversationCreated, skillManifestHash,
	SkillDefaultDoc, SkillManifestDoc,
} from "../src/core/skills/manifests.ts";
import {
	SkillLifecycleDoc, SkillLifecycleError, SkillRetentionService, type NoninferiorityAuthorization,
} from "../src/core/skills/retention.ts";
import {
	CURATION_DEFAULTS, recordSkillExposure, SkillCurationDoc, SkillCurationService, type CurationReport,
} from "../src/core/skills/curation.ts";

/*
 * Service-level curation fixture with a real SQLite harness and the trusted-witness pattern of
 * test/skill-retention.test.ts, so statistical lifecycle transitions can run beside curation.
 */
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const pkg: SkillPackage = {
	name: "fixture", description: "Fixture", body: "origin body", files: {},
	source: "fixture:origin", originalSkillMd: "---\nname: fixture\n---\noriginal bytes\n",
};
const TrustedEvidenceDoc = defineDocFamily<{ witness: NoninferiorityAuthorization | null }, null>({
	kind: "test.curation-lifecycle.trusted-evidence", version: 1, scope: "session", family: true,
	initial: () => ({ witness: null }),
});

async function setup() {
	const directory = await mkdtemp(join(tmpdir(), "skill-curation-lifecycle-"));
	cleanup.push(() => rm(directory, { recursive: true, force: true }));
	const clock = { value: 1_000_000 };
	const retention = new SkillRetentionService({
		now: () => clock.value,
		authorize: async (tx, request) => {
			const witness = (await tx.doc(TrustedEvidenceDoc, request.evidenceId, null)).witness;
			if (!witness) throw new SkillLifecycleError("evidence", "No trusted sealed noninferiority evidence");
			return { ...witness };
		},
	});
	const harness = await Harness.open(await openNodeSqliteStorage(join(directory, "curation.sqlite")), {
		registry: createRegistry(), models: createModels(),
		conversationCreated: async (tx, record) => {
			await skillConversationCreated(tx, record);
			await retention.pinAcquired(tx, record);
			await recordSkillExposure(tx, record, clock.value);
		},
	}, context);
	cleanup.push(() => harness.close(context));
	const store = new SkillStore(harness, { managedManifests: true, retention, now: () => clock.value });
	await harness.commit(classifyLegacySkillConversations, context);
	await harness.commit(tx => bootstrapSkillManifest(tx, "skills-v1"), context);
	await store.initialize([pkg], context);
	await harness.commit(tx => retention.acknowledgeRootInventory(tx, { revision: "fixture-v1", families: [] }), context);
	// alpha 0.25, pMax 0.5 => L* = 2; no idle/settle bound, so exposures alone decide.
	const curation = new SkillCurationService({
		harness: () => harness, retention, now: () => clock.value,
		config: { ...CURATION_DEFAULTS, alpha: 0.25, pMax: 0.5, minIdleMs: 0, settleMs: 0 },
	});
	const staged = await store.propose({ name: "agent-flow", description: "Agent flow", body: "Follow it.", files: {}, expectedGeneration: 0, requestId: "propose" }, "agent:1", context);
	await store.publish({ proposalId: staged.proposalId, requestId: "publish" }, "agent:1", context);
	return { harness, retention, store, curation, clock };
}
type Fixture = Awaited<ReturnType<typeof setup>>;

async function roots(f: Fixture, count: number): Promise<ConversationId[]> {
	return f.harness.commit(async (tx) => {
		const ids: ConversationId[] = [];
		for (let i = 0; i < count; i++) ids.push((await tx.createConversation({ ownership: { kind: "ownerless" } })).id);
		return ids;
	}, context);
}
/** Host test publisher persists exact bindings/numeric bounds before the statistical transition. */
async function transition(f: Fixture, operation: "deactivate" | "reactivate", evidenceId: string, name = "agent-flow") {
	const input = await f.harness.commit(async tx => {
		const publication = (await tx.doc(SkillDefaultDoc)).publication;
		if (!publication) throw new Error("Fixture default missing");
		const manifest = (await tx.doc(SkillManifestDoc, publication.manifestHash, null)).manifest;
		if (!manifest) throw new Error("Fixture manifest missing");
		const lifecycle = await tx.doc(SkillLifecycleDoc, name, null);
		const catalog = manifest.catalog.filter(item => item.name !== name).map(item => ({ ...item }));
		const versions = { ...manifest.versions };
		const dependencies = { ...manifest.dependencies };
		delete versions[name]; delete dependencies[name];
		if (operation === "reactivate") {
			const head = (await tx.doc(SkillsDoc)).skills.find(item => item.name === name);
			const content = head?.versions.find(item => item.version === head.head)?.package;
			if (!head || !content) throw new Error("Fixture reactivation package missing");
			catalog.splice(Math.min(lifecycle.catalogIndex, catalog.length), 0, {
				name, description: content.description, version: head.head, generation: head.generation,
				source: content.source, modified: head.head !== head.origin,
			});
			versions[name] = head.head; dependencies[name] = [...lifecycle.dependencies];
		}
		const witness: NoninferiorityAuthorization = {
			evidenceId, name, operation, baselineManifestHash: publication.manifestHash,
			candidateManifestHash: skillManifestHash({ catalog, versions, dependencies, routingRevision: manifest.routingRevision }),
			defaultGeneration: publication.generation, contractHash: "a".repeat(64), evidenceHash: "b".repeat(64),
			qualityLowerBound: -0.01, qualityLoss: 0.05, anchorLowerBound: -0.01, anchorLoss: 0.05,
			hypothesis: "efficiency", utilityLowerBound: 0.5, utilityImprovement: 0.01, horizonUses: 100, researchCostUpperBound: 1,
		};
		(await tx.doc(TrustedEvidenceDoc, evidenceId, null)).witness = witness;
		return { name, operation, expectedRevision: lifecycle.revision, expectedDefaultGeneration: publication.generation, evidenceId, requestId: evidenceId };
	}, context);
	return f.harness.commit(tx => f.retention.transition(tx, input), context);
}
function reported(report: CurationReport, name = "agent-flow") {
	const item = report.skills.find(entry => entry.name === name);
	if (!item) throw new Error(`No report for ${name}`);
	return item;
}
const status = async (f: Fixture, name = "agent-flow") => (await f.harness.snapshot(SkillLifecycleDoc, name, context))?.status ?? "active";

test("archive and restore are idempotent for exact retries after success; other reuse conflicts", async () => {
	const f = await setup();
	const request = { actor: "owner", requestId: "archive-1", reason: "superseded" };
	const archived = await f.curation.archive("agent-flow", request, context);
	expect(await status(f)).toBe("inactive");
	const revision = (await f.harness.snapshot(SkillLifecycleDoc, "agent-flow", context))?.revision;
	// Exact retry: the original publication, no second transition.
	expect(await f.curation.archive("agent-flow", request, context)).toEqual(archived);
	expect((await f.harness.snapshot(SkillLifecycleDoc, "agent-flow", context))?.revision).toBe(revision);
	// Same request id with a different reason, actor or operation is a conflict, never a replay.
	for (const attempt of [
		() => f.curation.archive("agent-flow", { ...request, reason: "other" }, context),
		() => f.curation.archive("agent-flow", { ...request, actor: "agent:9" }, context),
		() => f.curation.restore("agent-flow", { actor: "owner", requestId: "archive-1", reason: "superseded" }, context),
	]) await expect(attempt()).rejects.toMatchObject({ code: "conflict", message: "Lifecycle request ID reused" });

	const restore = { actor: "owner", requestId: "restore-1" };
	const restored = await f.curation.restore("agent-flow", restore, context);
	expect(await status(f)).toBe("active");
	const mark = await f.harness.snapshot(SkillCurationDoc, "agent-flow", context);
	expect(mark).toMatchObject({ activationGeneration: restored.generation, state: "active" });
	f.clock.value += 1_000;
	expect(await f.curation.restore("agent-flow", restore, context)).toEqual(restored);
	// The replay neither transitions nor moves the activation mark.
	expect(await f.harness.snapshot(SkillCurationDoc, "agent-flow", context)).toEqual(mark);
	expect(await status(f)).toBe("active");
	// Retrying the archive after the skill moved on (restored) still returns the original publication.
	expect(await f.curation.archive("agent-flow", request, context)).toEqual(archived);
	expect(await status(f)).toBe("active");
	// A statistical transition receipt cannot be replayed through curation.
	await transition(f, "deactivate", "evidence-off");
	await expect(f.curation.restore("agent-flow", { actor: "owner", requestId: "evidence-off" }, context)).rejects.toMatchObject({ code: "conflict" });
	expect(await status(f)).toBe("inactive");
});

test("a statistical reactivate resets the curation activation: old exposures no longer archive", async () => {
	const f = await setup();
	expect(f.curation.threshold).toBe(2);
	await f.curation.run({}, context);
	await roots(f, 2);
	// Two use-free exposures: the curator would archive now.
	expect(reported(await f.curation.run({ dryRun: true }, context))).toMatchObject({ action: "archive", run: 2, exposures: 2 });
	// Deactivate + reactivate through the statistical transition path, with no curator run between.
	await transition(f, "deactivate", "evidence-off");
	await transition(f, "reactivate", "evidence-on");
	expect(await status(f)).toBe("active");
	f.clock.value += 1_000;
	const run = await f.curation.run({}, context);
	expect(reported(run)).toMatchObject({ action: "none", run: 0, exposures: 0 });
	expect(await status(f)).toBe("active");
	const lifecycle = await f.harness.snapshot(SkillLifecycleDoc, "agent-flow", context);
	const generation = (await f.harness.snapshot(SkillDefaultDoc, context))?.publication?.generation;
	expect(await f.harness.snapshot(SkillCurationDoc, "agent-flow", context)).toMatchObject({
		lifecycleRevision: lifecycle?.revision, activatedAt: f.clock.value, activationGeneration: generation,
	});
	// The persisted fresh activation is stable and counts only new exposures.
	expect(reported(await f.curation.run({ dryRun: true }, context))).toMatchObject({ action: "none", run: 0 });
	await roots(f, 2);
	expect(reported(await f.curation.run({}, context))).toMatchObject({ action: "archive", run: 2, state: "archived" });
	expect(await status(f)).toBe("inactive");
});
