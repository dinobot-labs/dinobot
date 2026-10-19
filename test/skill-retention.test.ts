import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineDocFamily, defineTask, Harness, type Tx } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { SkillStore, SkillsDoc, type SkillPackage } from "../src/core/skills/store.ts";
import {
	bootstrapSkillManifest, classifyLegacySkillConversations, currentSkillManifest, publishSkillManifest,
	readSkillPin, skillConversationCreated, skillManifestHash,
	SkillDefaultDoc, SkillManifestDoc, SkillPinDoc, SkillRetentionDoc,
} from "../src/core/skills/manifests.ts";
import {
	sampleSkillRetentionDisk, SkillLifecycleDoc, SkillLifecycleError, SkillRetentionService, SkillVersionRetentionDoc,
	type NoninferiorityAuthorization, type SkillReferenceKind, type SkillRetentionOptions,
} from "../src/core/skills/retention.ts";
import {
	RetainedSkillContentDoc, SkillContentMigrationDoc, stageSkillContentMigration, verifySkillContentMigration,
} from "../src/core/skills/retention-content.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const pkg: SkillPackage = {
	name: "fixture", description: "Fixture", body: "origin body", files: { "ref.txt": "origin reference" },
	source: "fixture:origin", originalSkillMd: "---\nname: fixture\n---\noriginal bytes\n",
};
const TrustedEvidenceDoc = defineDocFamily<{ witness: NoninferiorityAuthorization | null }, null>({
	kind: "test.retention.trusted-evidence", version: 1, scope: "session", family: true,
	initial: () => ({ witness: null }),
});
const owner = defineTask<null, { phase: "run" }, null>({
	name: "test.retention-owner", version: 1, initial: () => ({ phase: "run" }),
	phases: { run: async (_task, runtime, ctx) => {
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
	} },
	abort: async (_task, runtime, ctx) => {
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
	},
});
async function open(path: string, clock = { value: 1_000 }, options: Partial<Omit<SkillRetentionOptions, "now" | "authorize">> = {}) {
	const service = new SkillRetentionService({
		now: () => clock.value, ...options,
		authorize: async (tx, request) => {
			const witness = (await tx.doc(TrustedEvidenceDoc, request.evidenceId, null)).witness;
			if (!witness) throw new SkillLifecycleError("evidence", "No trusted sealed noninferiority evidence");
			return { ...witness };
		},
	});
	const registry = createRegistry();
	registry.install({ name: "retention-fixtures", tasks: [owner] });
	const harness = await Harness.open(await openNodeSqliteStorage(path), {
		registry, models: createModels(),
		conversationCreated: async (tx, record) => {
			await skillConversationCreated(tx, record);
			await service.pinAcquired(tx, record);
		},
	}, context);
	let closed = false;
	const close = async () => { if (!closed) { closed = true; await harness.close(context); } };
	cleanup.push(close);
	return { harness, service, clock, path, close, store: new SkillStore(harness, { managedManifests: true }) };
}
type Fixture = Awaited<ReturnType<typeof open>>;
async function setup(options: Partial<Omit<SkillRetentionOptions, "now" | "authorize">> = {}) {
	const directory = await mkdtemp(join(tmpdir(), "skill-retention-"));
	cleanup.push(() => rm(directory, { recursive: true, force: true }));
	const state = await open(join(directory, "retention.sqlite"), { value: 1_000 }, options);
	await state.harness.commit(classifyLegacySkillConversations, context);
	await state.harness.commit(tx => bootstrapSkillManifest(tx, "skills-v1"), context);
	await state.store.initialize([pkg], context);
	// This standalone fixture has no external evolution snapshot/candidate/ledger owners.
	await state.harness.commit(tx => state.service.acknowledgeRootInventory(tx, { revision: "fixture-v1", families: [] }), context);
	return state;
}
async function edit(state: Fixture, requestId: string, body: string) {
	const head = await state.store.load(pkg.name, undefined, context);
	const proposal = await state.store.propose({
		name: pkg.name, description: pkg.description, body, files: { "ref.txt": `${body} reference` },
		expectedGeneration: head.generation, requestId,
	}, "owner", context);
	return state.store.publish({ proposalId: proposal.proposalId, requestId: `${requestId}-publish` }, "owner", context);
}
/** Host test publisher persists exact bindings/numeric bounds before transition. */
async function registerEvidence(state: Fixture, operation: "deactivate" | "reactivate", evidenceId: string, name = pkg.name) {
	return state.harness.commit(async tx => {
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
}
async function transition(state: Fixture, operation: "deactivate" | "reactivate", id: string, name = pkg.name) {
	const input = await registerEvidence(state, operation, id, name);
	return state.harness.commit(tx => state.service.transition(tx, input), context);
}
function conversation(state: Fixture) {
	return state.harness.commit(tx => tx.createConversation({ ownership: { kind: "ownerless" } }), context);
}
async function garbage(options: Partial<Omit<SkillRetentionOptions, "now" | "authorize">> = {}) {
	const state = await setup(options);
	const middle = await edit(state, "middle", "middle body");
	await edit(state, "latest", "latest body");
	await transition(state, "deactivate", "remove");
	const ticket = await state.harness.commit(tx => state.service.tombstone(tx, { name: pkg.name, version: middle.version, graceMs: 10, expectedRevision: 0 }), context);
	state.clock.value = ticket.collectAfter;
	return { ...state, version: middle.version, ticket };
}
async function signaled<T>(promise: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => reject(new Error("Expected transaction barrier did not arrive")), 3_000);
		})]);
	} finally { if (timer) clearTimeout(timer); }
}

test("host deactivation and reactivation retain bytes metadata and pins across SQLite restart", async () => {
	// Given
	const first = await setup();
	const old = await conversation(first);
	const before = await first.harness.snapshot(SkillsDoc, context);
	const oldPin = await first.harness.snapshot(SkillPinDoc, old.id, context);
	// When
	const publication = await transition(first, "deactivate", "deactivate");
	await first.close();
	const second = await open(first.path, first.clock);
	// Then
	expect((await second.harness.snapshot(SkillLifecycleDoc, pkg.name, context))?.status).toBe("inactive");
	expect((await second.harness.snapshot(SkillDefaultDoc, context))?.publication).toEqual(publication);
	expect(await second.harness.snapshot(SkillsDoc, context)).toEqual(before);
	expect(await second.harness.snapshot(SkillPinDoc, old.id, context)).toEqual(oldPin);
	expect((await second.harness.commit(tx => readSkillPin(tx, old.id), context)).manifestHash).toBe(oldPin?.pin?.manifestHash ?? "");
	expect(await second.harness.commit(tx => second.service.filterSourcePackages(tx, [pkg]), context)).toEqual([]);
	await transition(second, "reactivate", "reactivate");
	expect((await second.harness.snapshot(SkillLifecycleDoc, pkg.name, context))?.status).toBe("active");
	expect(await second.harness.snapshot(SkillsDoc, context)).toEqual(before);
});

for (const guard of ["protected", "rare-recovery", "dependency"] as const) {
	test(`${guard} guard rejects deactivation without changing publication`, async () => {
		// Given
		const state = await setup(guard === "protected" ? { protectedNames: [pkg.name] } : guard === "rare-recovery" ? { rareRecoveryNames: [pkg.name] } : {});
		if (guard === "dependency") {
			await state.store.initialize([{ ...pkg, name: "dependent", source: "fixture:dependent" }], context);
			await state.harness.commit(async tx => {
				const manifest = await currentSkillManifest(tx, "skills-v1", { fixture: [], dependent: [pkg.name] });
				const generation = (await tx.doc(SkillDefaultDoc)).publication?.generation ?? 0;
				await publishSkillManifest(tx, { manifest, expectedGeneration: generation, actor: "host", decision: "fixture", requestId: "dependent-manifest" });
			}, context);
		}
		const input = await state.harness.commit(async tx => ({
			name: pkg.name, operation: "deactivate" as const,
			expectedRevision: (await tx.doc(SkillLifecycleDoc, pkg.name, null)).revision,
			expectedDefaultGeneration: (await tx.doc(SkillDefaultDoc)).publication?.generation ?? 0,
			evidenceId: `remove-${guard}`, requestId: `remove-${guard}`,
		}), context);
		const before = await state.harness.snapshot(SkillDefaultDoc, context);
		// When / Then
		await expect(state.harness.commit(tx => state.service.transition(tx, input), context)).rejects.toMatchObject({ code: "guard" });
		expect(await state.harness.snapshot(SkillDefaultDoc, context)).toEqual(before);
		expect((await state.harness.snapshot(SkillLifecycleDoc, pkg.name, context))?.status).toBe("active");
	});
}

test("reactivation restores catalog order and outbound dependencies", async () => {
	// Given
	const state = await setup();
	await state.store.initialize([{ ...pkg, name: "base", source: "fixture:base" }], context);
	await state.harness.commit(async tx => {
		const manifest = await currentSkillManifest(tx, "skills-v1", { fixture: ["base"], base: [] });
		await publishSkillManifest(tx, { manifest, expectedGeneration: (await tx.doc(SkillDefaultDoc)).publication?.generation ?? 0, actor: "host", decision: "fixture", requestId: "deps" });
	}, context);
	const before = (await state.harness.snapshot(SkillDefaultDoc, context))?.publication;
	if (!before) throw new Error("Fixture default missing");
	const manifest = await state.harness.snapshot(SkillManifestDoc, before.manifestHash, context);
	await transition(state, "deactivate", "remove");
	// When
	const publication = await transition(state, "reactivate", "restore");
	// Then
	expect((await state.harness.snapshot(SkillManifestDoc, publication.manifestHash, context))?.manifest).toEqual(manifest?.manifest);
});

for (const attack of ["unknown-evidence", "passed-only", "binding", "noninferiority", "anchor"] as const) {
	test(`${attack} cannot replace trusted noninferiority eligibility`, async () => {
		// Given
		const state = await setup();
		const input = await registerEvidence(state, "deactivate", `attack-${attack}`);
		await state.harness.commit(async tx => {
			const evidence = await tx.doc(TrustedEvidenceDoc, input.evidenceId, null);
			if (!evidence.witness) throw new Error("Fixture witness missing");
			switch (attack) {
				case "unknown-evidence": evidence.witness = null; break;
				case "passed-only": evidence.witness.qualityLowerBound = -1; evidence.witness.anchorLowerBound = -1; break;
				case "binding": evidence.witness.candidateManifestHash = "f".repeat(64); break;
				case "noninferiority": evidence.witness.qualityLowerBound = -evidence.witness.qualityLoss; break;
				case "anchor": evidence.witness.anchorLowerBound = -evidence.witness.anchorLoss; break;
			}
		}, context);
		const before = await state.harness.snapshot(SkillDefaultDoc, context);
		// When / Then
		await expect(state.harness.commit(tx => state.service.transition(tx, input), context)).rejects.toThrow();
		expect(await state.harness.snapshot(SkillDefaultDoc, context)).toEqual(before);
	});
}

test("lifecycle receipts deduplicate exact retry and reject conflicting reuse", async () => {
	// Given
	const state = await setup();
	const input = await registerEvidence(state, "deactivate", "remove");
	const published = await state.harness.commit(tx => state.service.transition(tx, input), context);
	// When / Then
	expect(await state.harness.commit(tx => state.service.transition(tx, input), context)).toEqual(published);
	await expect(state.harness.commit(tx => state.service.transition(tx, { ...input, evidenceId: "different" }), context)).rejects.toThrow("reused");
});

test("persisted child pin remains a root after explicit parent close and restart", async () => {
	// Given
	const first = await setup({ physicalGc: true });
	const middle = await edit(first, "middle", "middle body");
	const parent = await conversation(first);
	const child = await first.harness.commit(async tx => {
		const taskId = await tx.createTask(owner, null, { conversationId: parent.id, ownership: { kind: "conversation" } });
		return tx.createConversation({ ownership: { kind: "task", taskId } });
	}, context);
	await edit(first, "latest", "latest body");
	await transition(first, "deactivate", "remove");
	await first.harness.commit(tx => first.service.tombstone(tx, { name: pkg.name, version: middle.version, graceMs: 0, expectedRevision: 0 }), context);
	await first.harness.commit(tx => first.service.closeConversation(tx, parent.id), context);
	await first.close();
	// When
	const second = await open(first.path, first.clock, { physicalGc: true });
	const inventory = await second.harness.commit(tx => second.service.inventory(tx, pkg.name, middle.version), context);
	// Then
	expect(inventory.roots).toContainEqual({ kind: "conversation", id: String(child.id) });
	expect(inventory.roots).not.toContainEqual({ kind: "conversation", id: String(parent.id) });
	await expect(second.harness.commit(tx => second.service.prepareCollection(tx, pkg.name, middle.version), context)).rejects.toThrow("reachable");
	expect((await second.harness.commit(tx => readSkillPin(tx, child.id), context)).manifestHash).toBe((await second.harness.snapshot(SkillPinDoc, parent.id, context))?.pin?.manifestHash ?? "");
	await expect(second.harness.commit(tx => readSkillPin(tx, parent.id), context)).rejects.toThrow("explicitly closed");
});

test("inventory covers default retained head upstream and live proposal roots", async () => {
	// Given
	const state = await setup();
	const origin = await state.store.load(pkg.name, undefined, context);
	const middle = await edit(state, "middle", "middle body");
	const latest = await edit(state, "latest", "latest body");
	await state.store.restore({ name: pkg.name, version: middle.version, expectedGeneration: latest.generation, requestId: "live-proposal" }, "owner", context);
	// When
	const originRoots = await state.harness.commit(tx => state.service.inventory(tx, pkg.name, origin.version), context);
	const currentRoots = await state.harness.commit(tx => state.service.inventory(tx, pkg.name, latest.version), context);
	const proposalRoots = await state.harness.commit(tx => state.service.inventory(tx, pkg.name, middle.version), context);
	// Then
	expect(originRoots.roots).toContainEqual({ kind: "upstream", id: pkg.name });
	expect(currentRoots.roots.some(root => root.kind === "default")).toBe(true);
	expect(currentRoots.roots).toContainEqual({ kind: "retained-head", id: pkg.name });
	expect(proposalRoots.roots.some(root => root.kind === "proposal")).toBe(true);
});

test("evaluation execution rollback upstream and legal-hold leases persist independently", async () => {
	// Given
	const first = await garbage({ physicalGc: true });
	const kinds: readonly SkillReferenceKind[] = ["execution", "proposal", "evaluation", "rollback", "upstream", "legal-hold"];
	for (const kind of kinds) {
		await first.harness.commit(tx => first.service.acquireReference(tx, {
			id: kind, kind, packages: [{ name: pkg.name, version: first.version }],
			...(kind === "legal-hold" ? {} : { expiresAt: 2_000 }),
		}), context);
	}
	await first.close();
	// When
	const second = await open(first.path, first.clock, { physicalGc: true });
	const inventory = await second.harness.commit(tx => second.service.inventory(tx, pkg.name, first.version), context);
	// Then
	for (const kind of kinds) expect(inventory.roots).toContainEqual({ kind, id: kind });
	second.clock.value = 2_000;
	const expired = await second.harness.commit(tx => second.service.inventory(tx, pkg.name, first.version), context);
	expect(expired.roots).toEqual([{ kind: "legal-hold", id: "legal-hold" }]);
	await expect(second.harness.commit(tx => second.service.prepareCollection(tx, pkg.name, first.version), context)).rejects.toThrow("reachable");
});

test("collection defaults off and grace cannot be bypassed", async () => {
	// Given
	const state = await garbage();
	state.clock.value = state.ticket.collectAfter - 1;
	// When / Then
	await expect(state.harness.commit(tx => state.service.prepareCollection(tx, pkg.name, state.version), context)).rejects.toThrow("grace");
	state.clock.value = state.ticket.collectAfter;
	const ticket = await state.harness.commit(tx => state.service.prepareCollection(tx, pkg.name, state.version), context);
	await expect(state.harness.commit(tx => state.service.collect(tx, ticket), context)).rejects.toThrow("off");
});

test("fenced collection prunes resolver bytes but preserves receipt originals and history metadata", async () => {
	// Given
	const state = await garbage({ physicalGc: true });
	const before = await state.harness.snapshot(SkillsDoc, context);
	const ticket = await state.harness.commit(tx => state.service.prepareCollection(tx, pkg.name, state.version), context);
	// When
	const result = await state.harness.commit(tx => state.service.collect(tx, ticket), context);
	// Then
	expect(result).toMatchObject({ kind: "resolver-pruned", availability: "expired", privacyErasure: false, diskReclaimed: false });
	expect(result.inventory.payloadCopies.proposals).toBeGreaterThan(0);
	expect(result.inventory.payloadCopies.canonicalReceipts).toBeGreaterThan(0);
	const after = await state.harness.snapshot(SkillsDoc, context);
	expect(after?.skills[0]?.versions.some(item => item.version === state.version)).toBe(false);
	expect(after?.skills[0]?.head).toBe(before?.skills[0]?.head ?? "");
	expect(after?.skills[0]?.generation).toBe(before?.skills[0]?.generation ?? 0);
	expect(after?.skills[0]?.history).toEqual(before?.skills[0]?.history);
	expect(after?.receipts).toEqual(before?.receipts);
	expect(after?.proposals).toEqual(before?.proposals);
	await expect(state.harness.commit(tx => state.service.assertAvailable(tx, pkg.name, state.version), context)).rejects.toThrow("no latest fallback");
});

for (const winner of ["acquire", "collect"] as const) {
	test(`${winner} wins serialized acquisition/sweep race without stale content access`, async () => {
		// Given
		const state = await garbage({ physicalGc: true });
		const ticket = await state.harness.commit(tx => state.service.prepareCollection(tx, pkg.name, state.version), context);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const input = { id: "race-evaluation", kind: "evaluation", packages: [{ name: pkg.name, version: state.version }] } as const;
		const first = state.harness.commit(async tx => {
			if (winner === "acquire") await state.service.acquireReference(tx, input);
			else await state.service.collect(tx, ticket);
			entered.resolve();
			await release.promise;
		}, context);
		try {
			await signaled(entered.promise);
			// When the second operation is queued after the exact transactional barrier.
			// Attach rejection handling before release, but do not invoke Bun's
			// synchronous promise matchers while the first Tx is held at its barrier.
			const second = winner === "acquire"
				? state.harness.commit(tx => state.service.collect(tx, ticket), context)
				: state.harness.commit(tx => state.service.acquireReference(tx, input), context);
			const settled = second.then(
				() => ({ status: "fulfilled" as const }),
				(error: unknown) => ({ status: "rejected" as const, error }),
			);
			release.resolve();
			await first;
			const outcome = await settled;
			expect(outcome.status).toBe("rejected");
			if (outcome.status !== "rejected" || !(outcome.error instanceof SkillLifecycleError)) throw new Error("Expected fenced lifecycle rejection");
			expect(outcome.error.code).toBe(winner === "acquire" ? "conflict" : "expired");
			// Then only the winner's resolver/reference effect is committed.
			const inventory = await state.harness.commit(tx => state.service.inventory(tx, pkg.name, state.version), context);
			expect(inventory.availability).toBe(winner === "acquire" ? "available" : "expired");
		} finally { release.resolve(); await first; }
	}, 10_000);
}

test("reference acquire/release ABA invalidates an earlier sweep fence", async () => {
	// Given
	const state = await garbage({ physicalGc: true });
	const ticket = await state.harness.commit(tx => state.service.prepareCollection(tx, pkg.name, state.version), context);
	// When
	const token = await state.harness.commit(tx => state.service.acquireReference(tx, { id: "rollback", kind: "rollback", packages: [{ name: pkg.name, version: state.version }] }), context);
	await state.harness.commit(tx => state.service.releaseReference(tx, token), context);
	// Then
	await expect(state.harness.commit(tx => state.service.collect(tx, ticket), context)).rejects.toThrow("ABA");
	const fresh = await state.harness.commit(tx => state.service.prepareCollection(tx, pkg.name, state.version), context);
	expect((await state.harness.commit(tx => state.service.collect(tx, fresh), context)).availability).toBe("expired");
});

test("lifecycle reactivation/deactivation ABA invalidates old collection ticket", async () => {
	// Given
	const state = await garbage({ physicalGc: true });
	const ticket = await state.harness.commit(tx => state.service.prepareCollection(tx, pkg.name, state.version), context);
	// When
	await transition(state, "reactivate", "restore");
	await transition(state, "deactivate", "remove-again");
	// Then
	await expect(state.harness.commit(tx => state.service.collect(tx, ticket), context)).rejects.toThrow("ABA");
});

test("tombstone suppression persists through restart and blocks source resurrection", async () => {
	// Given
	const first = await garbage({ physicalGc: true });
	const retained = await first.store.load(pkg.name, first.version, context);
	await first.close();
	// When
	const second = await open(first.path, first.clock, { physicalGc: true });
	const before = await second.harness.snapshot(SkillsDoc, context);
	const source = await second.harness.commit(tx => second.service.filterSourcePackages(tx, [retained]), context);
	await second.store.initialize(source, context);
	// Then
	expect(source).toEqual([]);
	expect(await second.harness.snapshot(SkillsDoc, context)).toEqual(before);
	expect((await second.harness.snapshot(SkillVersionRetentionDoc, first.version, context))?.phase).toBe("tombstone");
	expect((await second.harness.snapshot(SkillLifecycleDoc, pkg.name, context))?.status).toBe("inactive");
});

test("unacknowledged external snapshot and candidate inventory blocks every sweep", async () => {
	// Given a previously prepared ticket and a newly introduced non-enumerable root owner.
	const state = await garbage({ physicalGc: true });
	const old = await state.harness.commit(tx => state.service.prepareCollection(tx, pkg.name, state.version), context);
	await state.harness.commit(tx => state.service.invalidateRootInventory(tx), context);
	// When / Then
	const inventory = await state.harness.commit(tx => state.service.inventory(tx, pkg.name, state.version), context);
	expect(inventory.roots.some(root => root.kind === "incomplete-inventory")).toBe(true);
	await expect(state.harness.commit(tx => state.service.prepareCollection(tx, pkg.name, state.version), context)).rejects.toThrow("reachable");
	await expect(state.harness.commit(tx => state.service.collect(tx, old), context)).rejects.toThrow("fence");
	const root = await state.harness.commit(tx => state.service.acquireReference(tx, {
		id: "candidate:external", kind: "evaluation", packages: [{ name: pkg.name, version: state.version }],
	}), context);
	await state.harness.commit(tx => state.service.acknowledgeRootInventory(tx, {
		revision: "evolution-owner-v1", families: ["EvolutionSnapshotRegistration", "CandidateDoc", "PublicationLedger"],
	}), context);
	await expect(state.harness.commit(tx => state.service.prepareCollection(tx, pkg.name, state.version), context)).rejects.toThrow("reachable");
	await state.harness.commit(tx => state.service.releaseReference(tx, root), context);
	expect((await state.harness.commit(tx => state.service.prepareCollection(tx, pkg.name, state.version), context)).version).toBe(state.version);
});

test("expired pin after collection fails without substituting a latest package across restart", async () => {
	// Given a conversation pinned to a non-head version that was explicitly closed.
	const first = await setup({ physicalGc: true });
	const middle = await edit(first, "middle", "middle body");
	const expired = await conversation(first);
	await edit(first, "latest", "latest body");
	await transition(first, "deactivate", "remove");
	await first.harness.commit(tx => first.service.tombstone(tx, { name: pkg.name, version: middle.version, graceMs: 0, expectedRevision: 0 }), context);
	await first.harness.commit(tx => first.service.closeConversation(tx, expired.id), context);
	const ticket = await first.harness.commit(tx => first.service.prepareCollection(tx, pkg.name, middle.version), context);
	await first.harness.commit(tx => first.service.collect(tx, ticket), context);
	await first.close();
	// When
	const second = await open(first.path, first.clock, { physicalGc: true });
	// Then
	await expect(second.store.executionLoad({ conversationId: expired.id, name: pkg.name }, context)).rejects.toThrow("explicitly closed");
	await expect(second.harness.commit(tx => second.service.assertAvailable(tx, pkg.name, middle.version), context)).rejects.toThrow("no latest fallback");
	expect((await second.store.load(pkg.name, undefined, context)).body).toBe("latest body");
	expect((await second.harness.snapshot(SkillRetentionDoc, expired.id, context))?.closed).toBe(true);
});

test("research capacity denies unknown stale disk-full and oversized admission", async () => {
	// Given
	const state = await setup();
	// When / Then
	await expect(state.harness.commit(tx => state.service.assertResearchCapacity(tx, 1), context)).rejects.toThrow("capacity");
	await state.harness.commit(tx => state.service.recordCapacity(tx, { freeBytes: 100, essentialReserveBytes: 90 }), context);
	await expect(state.harness.commit(tx => state.service.assertResearchCapacity(tx, 11), context)).rejects.toThrow("capacity");
	await state.harness.commit(tx => state.service.assertResearchCapacity(tx, 10), context);
	await state.harness.commit(tx => state.service.recordCapacity(tx, { freeBytes: 1_000_000, essentialReserveBytes: 0, documentLimitBytes: 1 }), context);
	await expect(state.harness.commit(tx => state.service.assertResearchCapacity(tx, 1), context)).rejects.toThrow("capacity");
	await state.harness.commit(tx => state.service.recordCapacity(tx, { freeBytes: 1_000_000, essentialReserveBytes: 0 }), context);
	state.clock.value += 60_001;
	await expect(state.harness.commit(tx => state.service.assertResearchCapacity(tx, 1), context)).rejects.toThrow("stale");
	expect(await sampleSkillRetentionDisk(join(state.path, ".."))).toBeGreaterThanOrEqual(0);
});

test("immutable migration staging roundtrips content heads generations and receipts after restart", async () => {
	// Given
	const first = await setup();
	await edit(first, "migration-middle", "migration body");
	const before = await first.harness.snapshot(SkillsDoc, context);
	await first.harness.commit(tx => first.service.recordCapacity(tx, { freeBytes: 10_000_000, essentialReserveBytes: 1_000 }), context);
	// When
	const staged = await first.harness.commit(tx => stageSkillContentMigration(tx, (tx, bytes) => first.service.assertResearchCapacity(tx, bytes)), context);
	await first.close();
	const second = await open(first.path, first.clock);
	await second.harness.commit(verifySkillContentMigration, context);
	// Then
	expect(staged.phase).toBe("staged");
	expect(await second.harness.snapshot(SkillsDoc, context)).toEqual(before);
	expect((await second.harness.snapshot(SkillContentMigrationDoc, context))?.phase).toBe("staged");
	for (const entry of before?.skills ?? []) {
		for (const item of entry.versions) {
			expect((await second.harness.snapshot(RetainedSkillContentDoc, item.version, context))?.package).toEqual(item.package);
		}
	}
});

test("migration rejects corruption and source receipt mutation instead of claiming cutover", async () => {
	// Given
	const state = await setup();
	await edit(state, "migration-middle", "migration body");
	await state.harness.commit(tx => state.service.recordCapacity(tx, { freeBytes: 10_000_000, essentialReserveBytes: 1_000 }), context);
	await state.harness.commit(tx => stageSkillContentMigration(tx, (tx, bytes) => state.service.assertResearchCapacity(tx, bytes)), context);
	const head = await state.store.load(pkg.name, undefined, context);
	// When / Then
	await state.harness.commit(async tx => {
		const content = await tx.doc(RetainedSkillContentDoc, head.version, null);
		if (!content.package) throw new Error("Fixture staged content missing");
		content.package.body = "corrupt";
	}, context);
	await expect(state.harness.commit(verifySkillContentMigration, context)).rejects.toThrow("roundtrip");
	await state.harness.commit(async tx => {
		const content = await tx.doc(RetainedSkillContentDoc, head.version, null);
		content.package = { name: head.name, description: head.description, body: head.body, files: { ...head.files }, source: head.source, ...(head.originalSkillMd === undefined ? {} : { originalSkillMd: head.originalSkillMd }) };
		const receipt = (await tx.doc(SkillsDoc)).receipts[0];
		if (!receipt) throw new Error("Fixture receipt missing");
		receipt.canonical += " ";
	}, context);
	await expect(state.harness.commit(verifySkillContentMigration, context)).rejects.toThrow("receipt graph");
});
