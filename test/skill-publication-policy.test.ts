import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createEvaluationContract, skillEvaluationHash, type EvaluationEvidence, type EvaluationOutcome } from "../src/core/skills/evaluation.ts";
import { EvolutionJobs, EvolutionJobDoc, type EvolutionBudget } from "../src/core/skills/evolution-jobs.ts";
import { bootstrapSkillManifest, classifyLegacySkillConversations, currentSkillManifest, publishSkillManifest, SkillDefaultDoc, SkillManifestDoc, skillConversationCreated, SkillPinDoc, skillManifestHash } from "../src/core/skills/manifests.ts";
import { activateEvaluatedSkill, SkillStore, SkillsDoc, type SkillsState } from "../src/core/skills/store.ts";
import { createSkillPublicationService, SkillPublicationError, type PackageActivation, type PublicationRawRun } from "../src/core/skills/publication.ts";
import { PublicationEvidenceDoc, PublicationReceiptDoc } from "../src/core/skills/publication-state.ts";
import { SkillLifecycleDoc, SkillLifecycleReceiptDoc } from "../src/core/skills/retention.ts";

// allow: SIZE_OK - The requested scope permits one test file; these use real SQLite transactions.
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const hash = (text: string) => skillEvaluationHash(text);
const spent: EvolutionBudget = { calls: 1, tokens: 10, costMicros: 1, timeMs: 1, candidates: 1 };
const budget: EvolutionBudget = { calls: 4, tokens: 100, costMicros: 100, timeMs: 1000, candidates: 4 };
const campaign = { id: "campaign", alpha: { units: 50, scale: 1000 }, maxAttempts: 2, reservations: [] };
const observed = (value: number): EvaluationOutcome => ({ kind: "observed", value });
type Stratum = { readonly id: string; readonly qualityLoss: number };
async function setup(effectMode: "real" | "noop" | "throw" | "unrelated" = "real", strata: { readonly required?: readonly Stratum[]; readonly actual?: readonly Stratum[] } = {}) {
	const directory = await mkdtemp(join(tmpdir(), "skill-publication-"));
	cleanup.push(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, "state.sqlite");
	const harness = await Harness.open(await openNodeSqliteStorage(path), { models: createModels(), registry: createRegistry(), conversationCreated: skillConversationCreated }, context);
	let closed = false;
	const close = async () => { if (!closed) { closed = true; await harness.close(context); } };
	cleanup.push(close);
	const clock = { now: 1000 }; const fixtureDigest = { value: hash("synthetic-fixture") }; let effects = 0;
	const host = {
		session: harness, now: () => clock.now,
		activatePackage: (state: SkillsState, effect: PackageActivation) => {
			effects++;
			if (effectMode === "noop") return { name: "example", version: effect.version, generation: effect.expectedGeneration + 1 };
			const result = activateEvaluatedSkill(state, effect);
			if (effectMode === "throw") throw new Error("activation failed");
			if (effectMode === "unrelated") state.receipts.push({ requestId: "illegal", canonical: "extra", result });
			return result;
		},
	};
	const service = createSkillPublicationService(host);
	const store = new SkillStore(harness);
	await store.initialize([{ name: "example", description: "Example", body: "old", files: {}, source: "bundled:example" }], context);
	await harness.commit(classifyLegacySkillConversations, context);
	const baseline = await harness.commit((tx) => bootstrapSkillManifest(tx, "routing-1"), context);
	const baselineManifest = await harness.commit((tx) => currentSkillManifest(tx, "routing-1"), context);
	const proposal = await store.propose({ name: "example", description: "Example", body: "candidate", files: {}, expectedGeneration: 1, requestId: "propose" }, "author", context);
	const diff = await store.diff(proposal.proposalId, context);
	const candidate = {
		...baselineManifest, versions: { example: diff.version },
		catalog: baselineManifest.catalog.map((entry) => ({ ...entry, version: diff.version, generation: 2, modified: true })),
	};
	const policy = { policyHash: hash("policy"), environmentHash: hash("environment"), anchorManifestHash: baseline.manifestHash, anchorEpoch: 1, maxEvidenceAgeMs: 100, requiredCriticalStrata: strata.required ?? [] };
	await service.control.configure(policy, context);
	const jobs = new EvolutionJobs(harness, host.now);
	await jobs.execute({ op: "initialize", commandId: "jobs-init", policy: { revision: "jobs-v1", maxPending: 2, maxAttempts: 2, leaseMs: 1000, cooldownMs: 0, totalBudget: budget, maxJobBudget: budget } }, context);
	await jobs.execute({ op: "resume", commandId: "jobs-resume" }, context);
	const admission = await jobs.execute({ op: "enqueue", commandId: "enqueue", overflow: "defer", input: { evidenceWindow: "window", evidenceCutoff: 999, problem: "problem", policyRevision: "jobs-v1", snapshot: "snapshot", budget, attemptReservation: spent } }, context);
	if (!admission.jobId) throw new Error("job");
	const claim = await jobs.execute({ op: "claim", commandId: "claim", jobId: admission.jobId, worker: "evaluator" }, context);
	if (!claim.lease) throw new Error("lease");
	const lease = claim.lease;
	const contract = createEvaluationContract({
		revision: "skill-evaluation-v1", campaignId: campaign.id, attemptId: "attempt-1", outcomeDeadlineMs: 1000,
		alphaPerBound: { units: 10, scale: 1000 }, qualityRadius: 0.5, anchorLoss: 0.02,
		hypothesis: { kind: "quality", improvement: 0.02 },
		units: Array.from({ length: 64 }, (_, i) => ({ id: `u${i}`, mass: 1, ...(strata.actual ? { stratum: "critical" } : {}) })),
		...(strata.actual ? { criticalStrata: strata.actual } : {}),
		envelope: {
			baselinePublicationId: baseline.requestId, baselineGeneration: baseline.generation,
			baselineManifestHash: baseline.manifestHash, candidateManifestHash: skillManifestHash(candidate),
			anchorManifestHash: baseline.manifestHash, anchorEpoch: 1, policyHash: policy.policyHash, environmentHash: policy.environmentHash,
			distributionHash: hash("Q"), datasetHash: hash("fresh"), evaluatorHash: hash("scorer"),
			harnessHash: hash("harness"), modelConfigHash: hash("model"), toolSchemaHash: hash("tools"), routingHash: hash("routing"),
		},
	});
	const experiment = {
		registration: { id: "experiment", contractHash: contract.hash, envelopeHash: contract.envelopeHash, assignmentHash: contract.assignmentHash, fixtureHash: fixtureDigest.value, expiresAt: 2000 },
		verify: async () => fixtureDigest.value,
		score: (run: PublicationRawRun) => ({ quality: Number(run.result.stdout), guardsPassed: run.result.stderr === "" }),
	};
	await service.control.registerExperiment(experiment, context);
	await service.control.registerCampaign({ jobId: lease.jobId, campaign }, context);
	const reservationInput = { id: "evidence", registrationId: "experiment", contract, candidate, proposalId: proposal.proposalId, lease };
	await service.evaluator.reserve(reservationInput, context);
	// Synthetic raw records test the ledger; they do not attest actual model/sandbox executions.
	const raw: PublicationRawRun[] = contract.spec.units.flatMap((unit) => (["baseline", "candidate", "anchor"] as const).map((arm): PublicationRawRun => ({
		unitId: unit.id, arm, result: { status: "completed", exitCode: 0, stdout: arm === "candidate" ? "1" : "0", stderr: "" },
	})));
	const evidence: EvaluationEvidence = {
		contractHash: contract.hash, envelopeHash: contract.envelopeHash, assignmentHash: contract.assignmentHash,
		rawEvidenceHash: skillEvaluationHash(raw), integrity: "intact", guardsPassed: true,
		outcomes: contract.spec.units.map(({ id }) => ({ id, baseline: { quality: observed(0) }, candidate: { quality: observed(1) }, anchor: observed(0) })),
	};
	const request = { requestId: "publish", evidence: { kind: "evaluation", id: "evidence" } };
	return { harness, store, service, host, path, close, jobs, clock, fixtureDigest, baseline, contract, policy, lease, experiment, reservationInput, raw, evidence, request, effects: () => effects };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
async function seal(f: Pick<Fixture, "service" | "request" | "raw" | "evidence" | "jobs" | "lease">, enable = true) {
	await f.service.evaluator.open(f.request.evidence.id, context);
	const record = await f.service.evaluator.seal({ id: f.request.evidence.id, raw: f.raw, evidence: f.evidence, spent }, context);
	await f.jobs.execute({ op: "stage", commandId: "evaluating", lease: f.lease, stage: "evaluating" }, context);
	await f.jobs.execute({ op: "stage", commandId: "ready", lease: f.lease, stage: "ready" }, context);
	if (enable) await f.service.control.setEnabled(true, context);
	return record;
}

test.each(["prepared", "committed"] as const)("SIGKILL at automatic publication %s preserves evidence pointer and receipt atomicity", async (phase) => {
	// Given sealed, eligible evidence persisted in real SQLite.
	const f = await setup();
	await seal(f);
	await f.close();
	const child = Bun.spawn([
		process.execPath, new URL("./fixtures/skill-publication-crash.ts", import.meta.url).pathname,
		f.path, phase,
	], { stdout: "pipe", stderr: "pipe" });
	const reader = child.stdout.getReader();
	const deadline = setTimeout(() => child.kill("SIGKILL"), 8000);
	try {
		let output = "";
		for (;;) {
			const next = await reader.read();
			if (next.done) throw new Error(`Crash barrier not reached: ${await new Response(child.stderr).text()}`);
			output += new TextDecoder().decode(next.value);
			if (output.includes(phase)) break;
		}
		// When killed exactly at the selected commit barrier.
		child.kill("SIGKILL");
		await child.exited;
		expect(child.signalCode).toBe("SIGKILL");
	} finally {
		clearTimeout(deadline);
		child.kill("SIGKILL");
		reader.releaseLock();
	}
	const harness = await Harness.open(await openNodeSqliteStorage(f.path), { models: createModels(), registry: createRegistry() }, context);
	cleanup.push(() => harness.close(context));
	const store = new SkillStore(harness);
	const service = createSkillPublicationService({ session: harness, now: () => 1000, activatePackage: activateEvaluatedSkill });
	// Then recovery yields old or complete new; an exact retry has one total effect.
	expect((await store.load("example", undefined, context)).generation).toBe(phase === "committed" ? 2 : 1);
	const request = { requestId: "crash-publish", evidence: { kind: "evaluation", id: "evidence" } };
	const receipt = await service.publisher.publish(request, context);
	expect(receipt.activation.generation).toBe(2);
	expect(await service.publisher.publish(request, context)).toEqual(receipt);
	expect((await store.history("example", context)).map((entry) => entry.generation)).toEqual([1, 2]);
	expect((await harness.snapshot(SkillDefaultDoc, context))?.publication?.manifestHash).toBe(receipt.publication.manifestHash);
}, 15000);

async function lifecycleFixture(options: {
	readonly kind?: "deactivate" | "reactivate";
	readonly guard?: "protected" | "rare" | "dependency";
	readonly samples?: number; readonly equalQuality?: boolean; readonly anchor?: number;
	readonly researchCost?: number; readonly horizon?: number;
	readonly candidateRouting?: string; readonly registerEfficiency?: boolean;
	readonly hypothesis?: "quality" | "efficiency";
	readonly instrumentation?: "missing" | "nonfinite" | "out-of-bounds";
} = {}) {
	const f = await setup();
	const kind = options.kind ?? "deactivate";
	const service = createSkillPublicationService({
		...f.host, lifecycle: {
			...(options.guard === "protected" ? { protectedNames: ["example"] } : {}),
			...(options.guard === "rare" ? { rareRecoveryNames: ["example"] } : {}),
		},
	});
	if (options.guard === "dependency") {
		await f.store.initialize([{ name: "dependent", description: "Dependent", body: "requires example", files: {}, source: "fixture:dependent" }], context);
		await f.harness.commit(async tx => publishSkillManifest(tx, {
			manifest: await currentSkillManifest(tx, "routing-1", { example: [], dependent: ["example"] }),
			expectedGeneration: f.baseline.generation, requestId: "fixture-dependent", actor: "host:fixture", decision: "fixture",
		}), context);
	}
	if (kind === "reactivate") {
		// Given a persisted inactive target. The deactivation test below exercises the real removal.
		await f.harness.commit(async tx => {
			const lifecycle = await tx.doc(SkillLifecycleDoc, "example", null);
			lifecycle.status = "inactive"; lifecycle.revision = 1;
			await publishSkillManifest(tx, {
				manifest: { catalog: [], versions: {}, dependencies: {}, routingRevision: "routing-1" },
				expectedGeneration: f.baseline.generation, requestId: "fixture-inactive", actor: "host:fixture", decision: "fixture",
			});
		}, context);
	}
	const baseline = (await f.harness.snapshot(SkillDefaultDoc, context))?.publication;
	if (!baseline) throw new Error("Missing fixture publication");
	const head = await f.store.load("example", undefined, context);
	const proposal = await f.store.restore({ name: head.name, version: head.version, expectedGeneration: head.generation, requestId: "lifecycle-proposal" }, "author", context);
	const revision = (await f.harness.snapshot(SkillLifecycleDoc, head.name, context))?.revision ?? 0;
	const preview = await service.publisher.previewLifecycle({
		name: head.name, operation: kind, expectedRevision: revision, expectedDefaultGeneration: baseline.generation,
	}, context);
	const candidate = options.candidateRouting ? { ...preview, routingRevision: options.candidateRouting } : preview;
	const contract = createEvaluationContract({
		...f.contract.spec, attemptId: "lifecycle-attempt", qualityRadius: 0.5, anchorLoss: 0.5,
		units: Array.from({ length: options.samples ?? 64 }, (_, i) => ({ id: `l${i}`, mass: 1 })),
		hypothesis: options.hypothesis === "quality" ? { kind: "quality", improvement: 0.02 } : {
			kind: "efficiency", qualityLoss: 0.5, utilityImprovement: 0.02,
			cost: { unit: "tokens", bounds: { lower: 0, upper: 100 } },
			latency: { unit: "ms", bounds: { lower: 0, upper: 100 } },
			costWeight: 1, latencyWeight: 0, utilityRadius: 1,
		},
		envelope: {
			...f.contract.spec.envelope, baselinePublicationId: baseline.requestId, baselineGeneration: baseline.generation,
			baselineManifestHash: baseline.manifestHash, candidateManifestHash: skillManifestHash(candidate), datasetHash: hash("lifecycle-fresh"),
		},
	});
	const experiment = {
		registration: {
			...f.experiment.registration, id: "lifecycle-experiment", contractHash: contract.hash,
			envelopeHash: contract.envelopeHash, assignmentHash: contract.assignmentHash,
			...(options.registerEfficiency === false || options.hypothesis === "quality" ? {} : { efficiency: { horizonUses: options.horizon ?? 100, researchCostUpperBound: options.researchCost ?? 1 } }),
		},
		verify: f.experiment.verify,
		score: (run: PublicationRawRun) => ({
			quality: Number(run.result.stdout), guardsPassed: run.result.stderr === "",
			...(options.instrumentation === "missing" ? {} : {
				cost: options.instrumentation === "nonfinite" ? Infinity : options.instrumentation === "out-of-bounds" ? 101 : run.arm === "candidate" ? 0 : 100, latency: 1,
			}),
		}),
	};
	await service.control.registerExperiment(experiment, context);
	const reservationInput = { id: "lifecycle-evidence", registrationId: experiment.registration.id, contract, candidate, proposalId: proposal.proposalId, lease: f.lease, kind };
	const reservation = await service.evaluator.reserve(reservationInput, context);
	const quality = {
		baseline: options.equalQuality ? 0.5 : 0,
		candidate: options.equalQuality ? 0.5 : 1,
		anchor: options.anchor ?? (options.equalQuality ? 0.5 : 0),
	};
	const raw: PublicationRawRun[] = contract.spec.units.flatMap(unit => (["baseline", "candidate", "anchor"] as const).map(arm => ({
		unitId: unit.id, arm, result: { status: "completed" as const, exitCode: 0, stdout: String(quality[arm]), stderr: "" },
	})));
	const evidence: EvaluationEvidence = {
		contractHash: contract.hash, envelopeHash: contract.envelopeHash, assignmentHash: contract.assignmentHash,
		rawEvidenceHash: skillEvaluationHash(raw), integrity: "intact", guardsPassed: true,
		outcomes: contract.spec.units.map(({ id }) => ({
			id, baseline: { quality: observed(quality.baseline), ...(options.hypothesis === "quality" ? {} : { cost: observed(100), latency: observed(1) }) },
			candidate: { quality: observed(quality.candidate), ...(options.hypothesis === "quality" ? {} : { cost: observed(0), latency: observed(1) }) },
			anchor: observed(quality.anchor),
		})),
	};
	return {
		...f, service, baseline, contract, experiment, reservationInput, reservation, raw, evidence,
		request: { requestId: "lifecycle-publish", evidence: { kind: "evaluation", id: "lifecycle-evidence" } },
	};
}

test("defaults automatic publication off while retaining a historical passed decision", async () => {
	// Given
	const f = await setup(); await seal(f, false);
	// When
	const view = await f.service.publisher.preflight("evidence", context);
	// Then
	expect(view).toMatchObject({ decision: { status: "passed" }, eligible: false, reason: { code: "disabled" } });
	await expect(f.service.publisher.publish(f.request, context)).rejects.toBeInstanceOf(SkillPublicationError);
	expect((await f.store.load("example", undefined, context)).generation).toBe(1);
});

test("later experiment configuration cannot undo an explicit publication stop", async () => {
	// Given a host kill decision after the policy was registered.
	const f = await setup();
	await f.service.control.setEnabled(false, context);
	// When an automatic coordinator registers the same or a changed policy.
	await f.service.control.configure(f.policy, context, true);
	expect((await f.service.control.status(context))?.enabled).toBe(false);
	await f.service.control.configure({ ...f.policy, maxEvidenceAgeMs: 200 }, context, true);
	// Then bootstrap permission cannot re-enable an existing deployment.
	expect((await f.service.control.status(context))?.enabled).toBe(false);
});
test("commits real package activation manifest and receipt together", async () => {
	// Given
	const f = await setup(); await seal(f);
	// When
	const receipt = await f.service.publisher.publish(f.request, context);
	// Then
	expect(receipt.publication).toMatchObject({ manifestHash: f.contract.spec.envelope.candidateManifestHash, generation: 2 });
	expect((await f.store.load("example", undefined, context)).body).toBe("candidate");
	expect((await f.store.diff(f.reservationInput.proposalId, context)).status).toBe("published");
	expect((await f.harness.snapshot(SkillDefaultDoc, context))?.publication).toEqual(receipt.publication);
	expect(f.effects()).toBe(1);
});
test.each(["noop", "throw", "unrelated"] as const)("rolls back all effects from invalid activation adapter %s", async (mode) => {
	// Given
	const f = await setup(mode); await seal(f);
	// When / Then
	await expect(f.service.publisher.publish(f.request, context)).rejects.toThrow();
	expect((await f.store.load("example", undefined, context)).generation).toBe(1);
	expect((await f.harness.snapshot(SkillDefaultDoc, context))?.publication).toEqual(f.baseline);
	expect(await f.harness.snapshot(PublicationReceiptDoc, "publish", context)).toBeUndefined();
});
test.each([
	{ kind: "receipts", ids: ["passed-work"] }, { kind: "instruction", quote: "publish" },
	{ kind: "evaluation", id: "evidence", passed: true },
])("rejects model-controlled proof %j", async (evidence) => {
	// Given
	const f = await setup(); await seal(f);
	// When / Then
	await expect(f.service.publisher.publish({ ...f.request, evidence }, context)).rejects.toBeInstanceOf(SkillPublicationError);
	expect(f.effects()).toBe(0);
});
test("requires durable one-shot access and exact attempt identity before sealing", async () => {
	// Given
	const f = await setup();
	// When / Then
	await expect(f.service.evaluator.seal({ id: "evidence", raw: f.raw, evidence: f.evidence, spent }, context)).rejects.toThrow();
	await expect(f.service.evaluator.reserve({ ...f.reservationInput, id: "alias" }, context)).rejects.toThrow();
	await f.service.evaluator.open("evidence", context);
	await expect(f.service.evaluator.open("evidence", context)).rejects.toThrow();
});
test.each(["raw", "score", "assignment", "guards"] as const)("rejects forged runner %s instead of trusting passed", async (field) => {
	// Given
	const f = await setup(); await f.service.evaluator.open("evidence", context);
	const raw = structuredClone(f.raw); let evidence = f.evidence;
	const first = raw[0]; if (!first) throw new Error("fixture");
	switch (field) {
		case "raw": first.result.stdout = "0.5"; break;
		case "score": evidence = { ...evidence, outcomes: evidence.outcomes.map((row) => ({ ...row, candidate: { quality: observed(0.5) } })) }; break;
		case "assignment": first.unitId = "foreign"; break;
		case "guards": evidence = { ...evidence, guardsPassed: false }; break;
	}
	// When / Then
	await expect(f.service.evaluator.seal({ id: "evidence", raw, evidence, spent }, context)).rejects.toThrow();
	expect((await f.harness.snapshot(PublicationEvidenceDoc, "evidence", context))?.json).toBeNull();
});
test("rechecks registered fixture authenticity before data access and sealing", async () => {
	// Given
	const f = await setup(); f.fixtureDigest.value = hash("changed fixture");
	// When / Then
	await expect(f.service.evaluator.open("evidence", context)).rejects.toThrow();
	expect((await f.harness.snapshot(PublicationEvidenceDoc, "evidence", context))?.openedAt).toBeNull();
});
test.each(["revoke", "kill", "environment", "policy", "job-kill", "budget", "age", "baseline"] as const)("rejects %s after successful preflight at the final Tx boundary", async (change) => {
	// Given
	const f = await setup(); await seal(f);
	expect((await f.service.publisher.preflight("evidence", context)).eligible).toBe(true);
	const release = Promise.withResolvers<void>();
	const publication = release.promise.then(() => f.service.publisher.publish(f.request, context));
	// When: deterministic barrier, no sleep/polling.
	switch (change) {
		case "revoke": await f.service.control.revoke("evidence", context); break;
		case "kill": await f.service.control.setEnabled(false, context); await f.service.control.setEnabled(true, context); break;
		case "environment": await f.service.control.configure({ ...f.policy, environmentHash: hash("changed environment") }, context); await f.service.control.setEnabled(true, context); break;
		case "policy": await f.service.control.configure({ ...f.policy, policyHash: hash("changed policy") }, context); await f.service.control.setEnabled(true, context); break;
		case "job-kill": await f.jobs.execute({ op: "kill", commandId: "kill" }, context); break;
		case "budget": await f.harness.commit(async (tx) => { (await tx.doc(EvolutionJobDoc, f.lease.jobId, f.lease.jobId)).reserved.calls = 0; }, context); break;
		case "age": f.clock.now += 100; break;
		case "baseline": await f.harness.commit(async (tx) => { const state = await tx.doc(SkillDefaultDoc); if (state.publication) state.publication = { ...state.publication, generation: 2 }; }, context); break;
	}
	release.resolve();
	// Then
	await expect(publication).rejects.toThrow();
	expect(f.effects()).toBe(0);
	expect((await f.service.publisher.preflight("evidence", context)).decision.status).toBe("passed");
});
test("replays exact publication receipts after revoke without another activation", async () => {
	// Given
	const f = await setup(); await seal(f); const first = await f.service.publisher.publish(f.request, context);
	await f.service.control.revoke("evidence", context); await f.service.control.setEnabled(false, context);
	// When / Then
	expect(await f.service.publisher.publish(f.request, context)).toEqual(first);
	await expect(f.service.publisher.publish({ ...f.request, evidence: { kind: "evaluation", id: "different" } }, context)).rejects.toThrow();
	expect(f.effects()).toBe(1);
});
test("does not replenish campaign reservations on registration retry or renamed campaigns", async () => {
	// Given
	const f = await setup();
	// When
	const ledger = await f.service.control.registerCampaign({ jobId: f.lease.jobId, campaign }, context);
	// Then
	expect(ledger.reservations).toHaveLength(1);
	await expect(f.service.control.registerCampaign({ jobId: f.lease.jobId, campaign: { ...campaign, id: "renamed" } }, context)).rejects.toThrow();
	await expect(f.service.control.registerCampaign({ jobId: f.lease.jobId, campaign: { ...campaign, alpha: { units: 100, scale: 1000 } } }, context)).rejects.toThrow();
});
test("accepts a completed job only with the sealed reference and exact spent accounting", async () => {
	// Given
	const f = await setup(); await seal(f);
	await f.jobs.execute({ op: "settle", commandId: "settle", lease: f.lease, outcome: "completed", resultRef: "evidence", spent }, context);
	// When / Then
	expect((await f.service.publisher.publish(f.request, context)).publication.generation).toBe(2);
});
test("detects stored evidence mutation without replacing the historical decision", async () => {
	// Given
	const f = await setup(); await seal(f);
	await f.harness.commit(async (tx) => { const doc = await tx.doc(PublicationEvidenceDoc, "evidence", null); doc.json = `${doc.json} `; doc.hash = hash("forged"); }, context);
	// When / Then
	await expect(f.service.publisher.publish(f.request, context)).rejects.toThrow();
	expect(f.effects()).toBe(0);
});
test("recovers sealed evidence and receipts from real SQLite without author authority", async () => {
	// Given
	const f = await setup(); await seal(f); const receipt = await f.service.publisher.publish(f.request, context); await f.close();
	const reopened = await Harness.open(await openNodeSqliteStorage(f.path), { models: createModels(), registry: createRegistry() }, context);
	cleanup.push(() => reopened.close(context));
	const service = createSkillPublicationService({ ...f.host, session: reopened });
	// When / Then
	expect(await service.publisher.publish(f.request, context)).toEqual(receipt);
	expect((await service.publisher.preflight("evidence", context)).decision.status).toBe("passed");
});
test.each([undefined, [{ id: "critical", qualityLoss: 0.5 }]])("rejects omitted or relaxed host-required strata %j", async (actual) => {
	// Given / When / Then
	await expect(setup("real", { required: [{ id: "critical", qualityLoss: 0.01 }], ...(actual ? { actual } : {}) })).rejects.toThrow();
});
test("accepts a host-required stratum only under its registered full contract", async () => {
	// Given
	const f = await setup("real", { required: [{ id: "critical", qualityLoss: 0.01 }], actual: [{ id: "critical", qualityLoss: 0 }] });
	// When
	await seal(f); const receipt = await f.service.publisher.publish(f.request, context);
	// Then
	expect(receipt.publication.generation).toBe(2);
});
test("rejects a valid caller-chosen contract that differs from host registration", async () => {
	// Given
	const f = await setup();
	const contract = createEvaluationContract({ ...f.contract.spec, attemptId: "attempt-2", hypothesis: { kind: "quality", improvement: 0 } });
	// When / Then
	await expect(f.service.evaluator.reserve({ ...f.reservationInput, id: "new", contract }, context)).rejects.toThrow();
});
test("seals an all-missing run as inconclusive without inventing execution evidence", async () => {
	// Given
	const f = await setup(); await f.service.evaluator.open("evidence", context);
	const missing: EvaluationOutcome = { kind: "missing", reason: "pending" };
	const evidence = { ...f.evidence, rawEvidenceHash: skillEvaluationHash([]), outcomes: f.evidence.outcomes.map((row) => ({
		...row, baseline: { quality: missing }, candidate: { quality: missing }, anchor: missing,
	})) };
	// When
	const sealed = await f.service.evaluator.seal({ id: "evidence", raw: [], evidence, spent }, context);
	// Then
	expect(sealed.decision.status).toBe("inconclusive");
	expect((await f.service.control.status(context))?.enabled).toBe(false);
});
test("refuses changed seal retries while preserving identical historical evidence", async () => {
	// Given
	const f = await setup(); const first = await seal(f);
	// When / Then
	expect(await f.service.evaluator.seal({ id: "evidence", raw: f.raw, evidence: f.evidence, spent }, context)).toEqual(first);
	await expect(f.service.evaluator.seal({ id: "evidence", raw: f.raw, evidence: f.evidence, spent: { ...spent, calls: 0 } }, context)).rejects.toThrow();
});

test.each(["quality", "efficiency"] as const)("publishes evaluated %s deactivation atomically without changing retained heads or old pins", async hypothesis => {
	// Given
	const f = await lifecycleFixture({ hypothesis });
	const old = await f.harness.commit(tx => tx.createConversation({ ownership: { kind: "ownerless" } }), context);
	const pin = await f.harness.snapshot(SkillPinDoc, old.id, context);
	const skills = await f.harness.snapshot(SkillsDoc, context);
	await seal(f);
	expect((await f.service.publisher.preflight(f.request.evidence.id, context)).eligible).toBe(true);
	// When
	const receipt = await f.service.publisher.publish(f.request, context);
	// Then
	expect(f.reservation.kind).toBe("deactivate");
	expect(f.reservation.candidate.catalog).toEqual([]);
	expect(receipt).toMatchObject({ kind: "deactivate", activation: { name: "example", generation: 1 }, publication: { generation: 2, manifestHash: skillManifestHash(f.reservationInput.candidate) } });
	expect((await f.harness.snapshot(SkillManifestDoc, receipt.publication.manifestHash, context))?.manifest?.versions).toEqual({});
	expect((await f.harness.snapshot(SkillLifecycleDoc, "example", context))?.status).toBe("inactive");
	expect((await f.harness.snapshot(SkillsDoc, context))?.skills).toEqual(skills?.skills);
	expect(await f.harness.snapshot(SkillPinDoc, old.id, context)).toEqual(pin);
	expect((await f.store.executionLoad({ conversationId: old.id, name: "example" }, context)).body).toBe("old");
	expect((await f.store.diff(f.reservationInput.proposalId, context)).status).toBe("published");
	expect(receipt.evidenceHash).toBe((await f.harness.snapshot(PublicationEvidenceDoc, f.request.evidence.id, context))?.hash ?? "");
	expect((await f.harness.snapshot(SkillLifecycleReceiptDoc, "evaluation:lifecycle-publish", context))?.publication).toEqual(receipt.publication);
	expect(f.effects()).toBe(0);
	const fresh = await f.harness.commit(tx => tx.createConversation({ ownership: { kind: "ownerless" } }), context);
	await expect(f.store.executionLoad({ conversationId: fresh.id, name: "example" }, context)).rejects.toThrow();
});

test("reactivates only the evaluated retained target without a package generation increment", async () => {
	// Given
	const f = await lifecycleFixture({ kind: "reactivate", hypothesis: "quality" });
	await seal(f);
	// When
	const receipt = await f.service.publisher.publish(f.request, context);
	// Then
	expect(receipt).toMatchObject({ kind: "reactivate", activation: { name: "example", generation: 1 } });
	expect(receipt.publication.manifestHash).toBe(f.contract.spec.envelope.candidateManifestHash);
	expect((await f.harness.snapshot(SkillLifecycleDoc, "example", context))?.status).toBe("active");
	expect((await f.store.load("example", undefined, context)).body).toBe("old");
	expect(f.effects()).toBe(0);
});

test.each([
	{ samples: 1 },
	{ hypothesis: "quality" as const, equalQuality: true },
	{ equalQuality: true, anchor: 1 },
])("refuses deletion for insufficient sample non-significance or cumulative anchor loss %j", async options => {
	// Given
	const f = await lifecycleFixture(options);
	const record = await seal(f);
	const before = await f.harness.snapshot(SkillDefaultDoc, context);
	// When / Then
	expect(record.decision.status).toBe("inconclusive");
	await expect(f.service.publisher.publish(f.request, context)).rejects.toThrow();
	expect(await f.harness.snapshot(SkillDefaultDoc, context)).toEqual(before);
	expect((await f.harness.snapshot(SkillLifecycleDoc, "example", context))?.status).toBe("active");
	expect(await f.harness.snapshot(PublicationReceiptDoc, f.request.requestId, context)).toBeUndefined();
});

test.each(["protected", "rare", "dependency"] as const)("refuses %s lifecycle targets before confirmation access", async guard => {
	// Given / When / Then
	await expect(lifecycleFixture({ guard })).rejects.toMatchObject({ code: "guard" });
});

test("rejects a different candidate even with a correctly hashed registered envelope", async () => {
	// Given / When / Then
	await expect(lifecycleFixture({ candidateRouting: "unrelated-routing" })).rejects.toMatchObject({ code: "integrity", field: "exact lifecycle candidate" });
});

test.each([
	{ registerEfficiency: false }, { horizon: Infinity }, { horizon: 0 }, { researchCost: NaN },
])("requires finite preregistered efficiency amortization %j", async options => {
	// Given / When / Then
	await expect(lifecycleFixture(options)).rejects.toBeInstanceOf(SkillPublicationError);
});

test("rejects statistically positive efficiency whose finite net utility cannot recover research cost", async () => {
	// Given
	const f = await lifecycleFixture({ researchCost: 1000, horizon: 1 });
	const record = await seal(f);
	// When / Then
	expect(record.decision.status).toBe("passed");
	expect((await f.service.publisher.preflight(f.request.evidence.id, context)).eligible).toBe(false);
	await expect(f.service.publisher.publish(f.request, context)).rejects.toThrow("net utility");
	expect((await f.harness.snapshot(SkillDefaultDoc, context))?.publication).toEqual(f.baseline);
	expect(await f.harness.snapshot(PublicationReceiptDoc, f.request.requestId, context)).toBeUndefined();
});

test("rejects model-supplied utility outcomes rather than using their passed or manual actor claims", async () => {
	// Given
	const f = await lifecycleFixture();
	await f.service.evaluator.open(f.request.evidence.id, context);
	const evidence = { ...f.evidence, outcomes: f.evidence.outcomes.map(row => ({ ...row, candidate: { ...row.candidate, cost: observed(10) } })) };
	// When / Then
	await expect(f.service.evaluator.seal({ id: f.request.evidence.id, raw: f.raw, evidence, spent }, context)).rejects.toThrow("raw evidence mismatch");
	await expect(f.service.publisher.publish({ ...f.request, actor: "manual", passed: true }, context)).rejects.toMatchObject({ code: "authority" });
});

test.each(["revoke", "lifecycle-ABA", "package-CAS"] as const)("rechecks %s after lifecycle preflight in the final SQLite transaction", async change => {
	// Given
	const f = await lifecycleFixture(); await seal(f);
	expect((await f.service.publisher.preflight(f.request.evidence.id, context)).eligible).toBe(true);
	const release = Promise.withResolvers<void>();
	const publishing = release.promise.then(() => f.service.publisher.publish(f.request, context));
	// When
	switch (change) {
		case "revoke": await f.service.control.revoke(f.request.evidence.id, context); break;
		case "lifecycle-ABA": await f.harness.commit(async tx => { (await tx.doc(SkillLifecycleDoc, "example", null)).revision += 2; }, context); break;
		case "package-CAS": await f.harness.commit(async tx => {
			const entry = (await tx.doc(SkillsDoc)).skills[0];
			if (!entry) throw new Error("Missing target");
			entry.generation++;
		}, context); break;
	}
	release.resolve();
	// Then
	await expect(publishing).rejects.toThrow();
	expect((await f.harness.snapshot(SkillDefaultDoc, context))?.publication).toEqual(f.baseline);
	expect((await f.harness.snapshot(SkillLifecycleDoc, "example", context))?.status).toBe("active");
	expect(await f.harness.snapshot(PublicationReceiptDoc, f.request.requestId, context)).toBeUndefined();
});

test("serializes competing lifecycle publications into one complete effect and receipt", async () => {
	// Given
	const f = await lifecycleFixture(); await seal(f);
	// When
	const outcomes = await Promise.allSettled([
		f.service.publisher.publish(f.request, context),
		f.service.publisher.publish({ ...f.request, requestId: "competitor" }, context),
	]);
	// Then
	expect(outcomes.filter(item => item.status === "fulfilled")).toHaveLength(1);
	expect(outcomes.filter(item => item.status === "rejected")).toHaveLength(1);
	expect((await f.harness.snapshot(SkillDefaultDoc, context))?.publication?.generation).toBe(2);
	expect((await f.harness.snapshot(SkillLifecycleDoc, "example", context))?.revision).toBe(1);
});

test("replays the same lifecycle receipt after SQLite restart without another transition", async () => {
	// Given
	const f = await lifecycleFixture(); await seal(f);
	const receipt = await f.service.publisher.publish(f.request, context);
	await f.close();
	const reopened = await Harness.open(await openNodeSqliteStorage(f.path), { models: createModels(), registry: createRegistry() }, context);
	cleanup.push(() => reopened.close(context));
	const service = createSkillPublicationService({ ...f.host, session: reopened });
	// When / Then
	expect(await service.publisher.publish(f.request, context)).toEqual(receipt);
	expect((await reopened.snapshot(SkillLifecycleDoc, "example", context))?.revision).toBe(1);
});

test.each(["missing", "nonfinite", "out-of-bounds"] as const)("rejects %s host efficiency instrumentation instead of accepting supplied metrics", async instrumentation => {
	// Given
	const f = await lifecycleFixture({ instrumentation });
	await f.service.evaluator.open(f.request.evidence.id, context);
	// When / Then
	await expect(f.service.evaluator.seal({
		id: f.request.evidence.id, raw: f.raw, evidence: f.evidence, spent,
	}, context)).rejects.toThrow("bounded efficiency instrumentation");
	expect((await f.harness.snapshot(PublicationEvidenceDoc, f.request.evidence.id, context))?.json).toBeNull();
});

test("shared lifecycle filters preserve inactive suppression with transition authority disabled", async () => {
	// Given
	const f = await lifecycleFixture({ hypothesis: "quality" }); await seal(f);
	const receipt = await f.service.publisher.publish(f.request, context);
	const disabled = createSkillPublicationService(f.host);
	const head = await f.store.load("example", undefined, context);
	// When / Then
	expect(await f.harness.commit(tx => disabled.lifecycle.filterSourcePackages(tx, [head]), context)).toEqual([]);
	const filtered = await f.harness.commit(async tx => disabled.lifecycle.filterManifest(tx, await currentSkillManifest(tx, "routing-1")), context);
	expect(filtered.catalog).toEqual([]);
	await expect(f.harness.commit(tx => disabled.lifecycle.transition(tx, {
		name: "example", operation: "reactivate", expectedRevision: 1, expectedDefaultGeneration: receipt.publication.generation,
		evidenceId: f.request.evidence.id, requestId: "manual-bypass",
	}), context)).rejects.toMatchObject({ code: "disabled" });
	expect((await f.harness.snapshot(SkillLifecycleDoc, "example", context))?.status).toBe("inactive");
});
