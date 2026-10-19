import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openBot } from "../src/core/bot.ts";
import { createSkillConfirmation, type SkillConfirmationProvider } from "../src/core/skills/confirmation.ts";
import { createEvaluationContract, skillEvaluationHash } from "../src/core/skills/evaluation.ts";
import { registeredSkillExperimentDigest, skillFixtureDigest, type RegisteredSkillExperiment } from "../src/core/skills/evaluation-runner.ts";
import { EvolutionJobs } from "../src/core/skills/evolution-jobs.ts";
import { SkillDefaultDoc, SkillManifestDoc, skillManifestHash } from "../src/core/skills/manifests.ts";
import { activateEvaluatedSkill } from "../src/core/skills/store.ts";
import { createSkillPublicationService } from "../src/core/skills/publication.ts";

test.each([["edit", false], ["deactivate", false], ["edit", true]] as const)("host %s confirmation preserves explicit finalization with pause=%s", async (operation, pause) => {
	// Given a synthetic deterministic task family, not production-quality evidence.
	const directory = await mkdtemp(join(tmpdir(), "skill-confirmation-"));
	const models = createModels();
	models.setProvider(fauxProvider({ provider: "faux", models: [{ id: "one" }] }).provider);
	const bot = await openBot({
		storage: new MemoryStorage(), models, defaultModel: { provider: "faux", modelId: "one" },
		toolMode: "direct", plugins: [],
		// This fixture drives the research queue by hand; background review (on by default) would freeze its policy first.
		skillEvolution: { review: false },
	}, context);
	try {
		const original = { name: "evolving-fixture", description: "Fixture", body: "Original fixture", files: {}, source: "fixture:evolving" };
		await bot.skills.initialize([original], context);
		const parent = await bot.conversation("test", "pinned", context);
		const before = await bot.skills.executionLoad({ conversationId: parent.id, name: original.name }, context);
		const baseline = (await bot.harness.snapshot(SkillDefaultDoc, context))?.publication;
		if (!baseline) throw new Error("No baseline publication");
		const directories = {
			baseline: { path: join(directory, "baseline"), digest: "" },
			candidate: { path: join(directory, "candidate"), digest: "" },
			anchor: { path: join(directory, "anchor"), digest: "" },
		};
		for (const [arm, fixture] of Object.entries(directories)) {
			await mkdir(fixture.path);
			await writeFile(join(fixture.path, "result.txt"), arm === "candidate" ? "correct" : "incorrect");
			fixture.digest = await skillFixtureDigest(fixture.path);
		}
		const jobs = new EvolutionJobs(bot.harness, Date.now);
		const budget = { calls: 4, tokens: 4000, costMicros: 4000, timeMs: 300000, candidates: 4 };
		const reservation = { calls: 1, tokens: 1000, costMicros: 1000, timeMs: 100000, candidates: 1 };
		await jobs.execute({ commandId: "init", op: "initialize", policy: {
			revision: "fixture", maxPending: 2, maxAttempts: 2, leaseMs: 300000, cooldownMs: 0,
			totalBudget: budget, maxJobBudget: budget,
		} }, context);
		await jobs.execute({ commandId: "resume", op: "resume" }, context);
		const admitted = await jobs.execute({ commandId: "admit", op: "enqueue", overflow: "defer", input: {
			evidenceWindow: "fixture-window", evidenceCutoff: 1, problem: "fixture", policyRevision: "fixture",
			snapshot: "fixture", budget, attemptReservation: reservation,
		} }, context);
		if (!admitted.jobId) throw new Error("No job");
		const claimed = await jobs.execute({ commandId: "claim", op: "claim", jobId: admitted.jobId, worker: "fixture" }, context);
		if (!claimed.lease) throw new Error("No lease");
		const order = {
			input: { evidenceWindow: "fixture-window", evidenceCutoff: 1, problem: "fixture", policyRevision: "fixture", snapshot: "fixture", budget, attemptReservation: reservation },
			lease: claimed.lease, reservation,
		};
		const hash = skillEvaluationHash("synthetic-registration");
		const provider: SkillConfirmationProvider = {
			id: "fixture", environmentRevision: "fixture",
			async prepare(input) {
				const policy = { policyHash: hash, environmentHash: hash, anchorManifestHash: baseline.manifestHash, anchorEpoch: 1, maxEvidenceAgeMs: 300000, requiredCriticalStrata: [] };
				const envelope = {
					baselinePublicationId: input.baseline.requestId, baselineGeneration: input.baseline.generation,
					baselineManifestHash: input.baseline.manifestHash, candidateManifestHash: skillManifestHash(input.candidate),
					anchorManifestHash: baseline.manifestHash, anchorEpoch: 1, distributionHash: hash, datasetHash: hash,
					evaluatorHash: hash, harnessHash: hash, modelConfigHash: hash, toolSchemaHash: hash, routingHash: hash,
					environmentHash: hash, policyHash: hash,
				};
				const experiment: RegisteredSkillExperiment = {
					envelope, maxOutputBytes: 1024,
					units: Array.from({ length: 64 }, (_, i) => ({
						id: `unit-${i}`, directories, command: ["/usr/bin/cat", "/fixture/result.txt"],
					})),
					score: ({ result }) => ({ quality: result.stdout === "correct" ? 1 : 0, guardsPassed: result.exitCode === 0 }),
				};
				envelope.datasetHash = await registeredSkillExperimentDigest(experiment);
				const contract = createEvaluationContract({
					revision: "skill-evaluation-v1", campaignId: "fixture-campaign", attemptId: "fixture-attempt",
					envelope, alphaPerBound: { units: 10, scale: 1000 }, outcomeDeadlineMs: 5000,
					units: experiment.units.map((unit) => ({ id: unit.id, mass: 1 })),
					qualityRadius: 0.5, anchorLoss: 0.02, hypothesis: { kind: "quality", improvement: 0.02 },
				});
				return { contract, policy, experiment, expiresAt: Date.now() + 300000,
					campaign: { id: "fixture-campaign", alpha: { units: 50, scale: 1000 }, maxAttempts: 2, reservations: [] } };
			},
		};
		const confirmation = createSkillConfirmation({
			harness: () => bot.harness, skills: () => bot.skills,
			publication: createSkillPublicationService({ session: bot.harness, now: Date.now, activatePackage: activateEvaluatedSkill, lifecycle: {} }),
			provider, autoPublish: true, anchorManifest: baseline.manifestHash, lifecycleEnabled: true,
		});
		// When frozen artifact evidence is produced, budget-settled, and finalized.
		const result = await confirmation.evaluate({
			order, baselineManifest: baseline.manifestHash,
			candidate: { operation, name: original.name, hypothesis: "Synthetic fixture", description: "Fixture candidate", body: "New fixture instructions", files: {} },
		}, new AbortController().signal, context);
		expect((await bot.skills.load(original.name, undefined, context)).version).toBe(before.version);
		await jobs.execute({ commandId: "evaluating", op: "stage", lease: claimed.lease, stage: "evaluating" }, context);
		await jobs.execute({ commandId: "ready", op: "stage", lease: claimed.lease, stage: "ready" }, context);
		await jobs.execute({ commandId: "settle", op: "settle", lease: claimed.lease, ...result }, context);
		if (pause) await jobs.execute({ commandId: "pause-before-finalization", op: "pause" }, context);
		await confirmation.finalize(order, result, context);
		expect((await bot.skillEvolution.status(context)).finalization?.status).toBe(pause ? "not-published" : "published");
		if (!pause) {
			await jobs.execute({ commandId: "pause-after-publication", op: "pause" }, context);
			await confirmation.finalize(order, result, context);
			expect((await bot.skillEvolution.status(context)).finalization?.status).toBe("published");
		}
		// Then publication or refusal is explicit while the existing conversation stays pinned.
		if (operation === "edit") expect((await bot.skills.load(original.name, undefined, context)).body).toBe(pause ? original.body : "New fixture instructions");
		else {
			await bot.skills.initialize([original], context);
			const other = await bot.skills.propose({
				name: "unrelated-fixture", description: "Other", body: "Other", files: {},
				expectedGeneration: 0, requestId: "unrelated-proposal",
			}, "owner", context);
			await bot.skills.publish({ proposalId: other.proposalId, requestId: "unrelated-publish" }, "owner", context);
			const current = (await bot.harness.snapshot(SkillDefaultDoc, context))?.publication;
			if (!current) throw new Error("Default disappeared");
			const manifest = await bot.harness.snapshot(SkillManifestDoc, current.manifestHash, context);
			expect(manifest?.manifest?.versions[original.name]).toBeUndefined();
		}
		expect((await bot.skills.executionLoad({ conversationId: parent.id, name: original.name }, context)).version).toBe(before.version);
	} finally {
		await bot.close(context);
		await rm(directory, { recursive: true, force: true });
	}
}, 30000);
