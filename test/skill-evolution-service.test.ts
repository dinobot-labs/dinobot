import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { skillEvolutionConfig } from "../src/core/skills/evolution-config.ts";
import { EvolutionJobDoc, EvolutionQueueDoc, EvolutionJobError } from "../src/core/skills/evolution-jobs.ts";
import type { EvolutionResearchExecutor, EvolutionWorkResult } from "../src/core/skills/evolution-jobs-task.ts";
import {
	createSkillEvolutionService, EvolutionCandidateDoc, EvolutionControlDoc, EvolutionServiceDoc, EvolutionWorkerDoc,
	type EvolutionServiceOptions, type EvolutionSloRegistration,
} from "../src/core/skills/evolution-service.ts";
import { skillEvolutionExtension, SKILL_EVOLUTION_TOOL_NAMES } from "../src/extensions/skill-evolution.ts";
import { toolExtensions, type ToolMode } from "../src/core/toolmode.ts";

const harnesses = new Set<Harness>();
const directories: string[] = [];
afterEach(async () => {
	for (const harness of harnesses) await harness.close(context);
	harnesses.clear();
	for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
const config = () => skillEvolutionConfig({
	sessionPinning: true, observe: true, author: true,
	budgets: { maxPending: 2, maxCalls: 4, maxOutputTokens: 4000, timeoutMs: 4000, dailyMicroUsd: 10_000, jobMicroUsd: 4000 },
	confirmation: { contractId: "contract-fixture", anchorManifest: "a".repeat(64), environmentRevision: "isolated-fixture", sloEvidenceId: "verified-fixture-slo" },
});
// This attestation is a TEST FIXTURE, not a measured production SLO or quota certificate.
const slo: EvolutionSloRegistration = {
	evidenceId: "verified-fixture-slo", environmentRevision: "isolated-fixture", executorRevision: "fixture-v1",
	pairedBlockP95UpperMs: 10, errorIncreaseUpper: 0, cpuCores: 1, rssBytes: 100_000,
};
const completed: EvolutionWorkResult = {
	outcome: "completed", spent: { calls: 1, tokens: 10, costMicros: 10, timeMs: 1, candidates: 1 }, resultRef: "isolated-fixture-draft",
};
async function fixture(options: Partial<Omit<EvolutionServiceOptions, "getHarness">> = {}, mode: ToolMode = "direct", existing?: string) {
	const path = existing ?? join(await mkdtemp(join(tmpdir(), "evolution-service-")), "state.sqlite");
	if (!existing) directories.push(join(path, ".."));
	const registry = createRegistry();
	const models = createModels();
	const faux = fauxProvider({ provider: "faux", models: [{ id: "main" }, { id: "author" }] });
	models.setProvider(faux.provider);
	let bound: Harness | undefined;
	const getHarness = () => {
		if (!bound) throw new Error("Harness not yet bound");
		return bound;
	};
	const clock = { value: 1_000 };
	const service = createSkillEvolutionService({
		getHarness, config: config(), executorRevision: "fixture-v1", now: () => clock.value, ...options,
	});
	// Register durable task and ALL tools before Harness.open/resume.
	const extension = skillEvolutionExtension(service);
	registry.install(extension);
	for (const extension of toolExtensions(mode, [], getHarness)) registry.install(extension);
	const harness = await Harness.open(await openNodeSqliteStorage(path), { models, registry }, context);
	bound = harness; harnesses.add(harness);
	const main = await harness.root(context, { agent: { model: { provider: "faux", modelId: "main" } } });
	return { path, service, harness, registry, models, faux, main, clock, extension };
}
async function register(f: Awaited<ReturnType<typeof fixture>>, withAuthor = false, problem = "parser") {
	await f.service.registerSlo(slo, context);
	const content = JSON.stringify({ repeatedCorrections: ["Check parser bounds"] });
	const id = await f.service.registerSnapshot({
		manifestHash: "a".repeat(64), evidenceDigest: "b".repeat(64), evidenceWindow: "window-fixture",
		evidenceCutoff: 900, problem,
		...(withAuthor ? { authorSnapshot: { content, hash: createHash("sha256").update(content).digest("hex") } } : {}),
	}, context);
	await f.service.registerProviderReservation({
		snapshotId: id, executorRevision: "fixture-v1", inputTokenUpperBound: 1000, maximumProviderAttempts: 1, reservedMicroUsd: 1000,
	}, context);
	return id;
}
async function call(f: Awaited<ReturnType<typeof fixture>>, name: string, args: Record<string, string>) {
	f.faux.setResponses([fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" }), fauxAssistantMessage("main done")]);
	const result = await (await f.main.submit({ type: "input", content: "Explicit runtime operation" }, context)).wait(context);
	expect(result.status).toBe("done");
	const messages = (await f.main.context(context)).messages;
	const message = messages.findLast((item) => item.role === "toolResult");
	if (!message || message.role !== "toolResult") throw new Error("Missing actual registered tool result");
	return { text: message.content.filter((part) => part.type === "text").map((part) => part.text).join(""), isError: message.isError };
}
async function close(harness: Harness) { await harness.close(context); harnesses.delete(harness); }

test.each(["direct", "hybrid", "codemode-only"] as const)("registered %s status tool is available and does not create runtime state", async (mode) => {
	const f = await fixture({}, mode);
	const names = (await f.main.agent(context)).tools.map((tool) => tool.name);
	for (const name of SKILL_EVOLUTION_TOOL_NAMES) expect(names).toContain(name);
	const response = mode === "direct"
		? await call(f, "skill_evolution_status", {})
		: await call(f, "codemode", { code: "text(await tools.skill_evolution_status({}));" });
	expect(response.text).toContain("trusted research executor is not installed");
	expect(await f.harness.snapshot(EvolutionQueueDoc, context)).toBeUndefined();
	expect(await f.harness.snapshot(EvolutionServiceDoc, context)).toBeUndefined();
});

test("startup pauses by default and missing executor budgets SLO provider or unsupported flags stay disabled", async () => {
	const f = await fixture();
	await f.service.startup(context);
	expect((await f.service.status(context)).mode).toBe("paused");
	expect((await call(f, "skill_evolution_resume", { request_id: "cannot-resume" })).isError).toBe(true);
	expect((await f.service.status(context)).disabledReasons).toContain("verified SLO registration is missing");
	const noBudgets = await fixture({ config: skillEvolutionConfig({ observe: true, author: true }), executor: { run: async () => completed } });
	await noBudgets.service.startup(context);
	expect((await noBudgets.service.status(context)).disabledReasons).toContain("finite research budgets are missing");
	const unsupported = await fixture({ config: { ...config(), config: { ...config().config, evaluate: true, autoPublish: true } }, executor: { run: async () => completed } });
	await unsupported.service.startup(context);
	await register(unsupported);
	const status = await unsupported.service.status(context);
	expect(status.admissionEnabled).toBe(false);
	expect(status.automaticEvaluationImplemented).toBe(false);
	expect(status.publicationImplemented).toBe(false);
	await expect(unsupported.service.resume("unsupported", context)).rejects.toMatchObject({ code: "disabled" });
});

test("capacity failure blocks new admission but cannot invalidate a historical receipt", async () => {
	// Given a host-owned disk capacity gate.
	let freeBytes = 0;
	let probeFails = false;
	const f = await fixture({
		executor: { run: async () => completed },
		capacity: {
			sample: async () => { if (probeFails) throw new Error("disk unavailable"); return freeBytes; },
			admit: async (_tx, free, bytes) => {
				if (free < bytes) throw new EvolutionJobError("budget", "capacity exhausted");
			},
		},
	});
	await f.service.startup(context);
	const snapshot = await register(f);
	await f.service.resume("resume-capacity", context);
	// When capacity is exhausted, then no pending job is created.
	await expect(f.service.enqueue("admit-capacity", snapshot, "defer", context)).rejects.toMatchObject({ code: "budget" });
	expect((await f.service.status(context)).pending).toEqual([]);
	// A later valid admission remains replayable even after the probe fails.
	freeBytes = 32 * 1024 * 1024;
	const admitted = await f.service.enqueue("admit-capacity", snapshot, "defer", context);
	probeFails = true;
	expect(await f.service.enqueue("admit-capacity", snapshot, "defer", context)).toEqual(admitted);
});

test("default-off operator pause and kill persist honest idempotent stops without creating budget policy", async () => {
	// Research fully off: background review is on by default, so it is opted out explicitly.
	const disabled = skillEvolutionConfig({ review: false });
	const f = await fixture({ config: disabled });
	const paused = await f.service.pause("pause-without-policy", context);
	expect(paused.receipt?.reason).toContain("no initialized research queue");
	expect((await f.service.status(context)).mode).toBe("paused");
	await f.service.startup(context);
	const response = await call(f, "skill_evolution_kill", { request_id: "kill-without-policy" });
	expect(response.isError).toBe(false);
	expect(response.text).toContain("Operator stop persisted");
	expect((await f.service.status(context)).mode).toBe("killed");
	expect((await f.harness.snapshot(EvolutionQueueDoc, context))?.policy).toBeNull();
	const epoch = (await f.harness.snapshot(EvolutionControlDoc, context))?.epoch;
	const retry = await f.service.kill("kill-without-policy", context, `agent:${f.main.id}`);
	expect(retry.abortTaskIds).toEqual([]);
	expect((await f.harness.snapshot(EvolutionControlDoc, context))?.epoch).toBe(epoch);
	await expect(f.service.resume("invalid-resume", context)).rejects.toThrow("finite research budgets");
	await close(f.harness);
	const reopened = await fixture({ config: disabled }, "direct", f.path);
	await reopened.service.startup(context);
	expect((await reopened.service.status(context)).mode).toBe("killed");
	expect((await reopened.harness.snapshot(EvolutionQueueDoc, context))?.policy).toBeNull();
	const replay = await reopened.service.kill("kill-without-policy", context, `agent:${f.main.id}`);
	expect(replay).toEqual(retry);
	const pause = await reopened.service.pause("new-pause", context);
	expect(pause.receipt?.reason).toContain("no initialized research queue");
	expect((await reopened.service.status(context)).mode).toBe("paused");
});

test("host-only snapshot and provider registration prevent arbitrary filesystem and budget authority", async () => {
	const f = await fixture({ executor: { run: async () => completed } });
	await f.service.startup(context);
	await f.service.registerSlo(slo, context);
	await expect(f.service.resume("missing-provider", context)).rejects.toThrow("provider reservation");
	const id = await register(f);
	await f.service.resume("resume", context);
	await expect(f.service.enqueue("unknown", "e".repeat(64), "defer", context)).rejects.toThrow("not immutably registered");
	const illegal = await call(f, "skill_evolution_enqueue", { request_id: "illegal", snapshot_id: "/etc/passwd", overflow: "defer", budget: "unlimited" });
	expect(illegal.isError).toBe(true);
	expect((await f.service.status(context)).pending).toEqual([]);
	expect((await call(f, "skill_evolution_enqueue", { request_id: "registered", snapshot_id: id, overflow: "defer" })).isError).toBe(false);
	expect((await f.service.status(context)).pending).toHaveLength(1);
});

test("registered schedule returns before isolated research and worker has no admin tools", async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<EvolutionWorkResult>();
	const f = await fixture({ executor: { run: async (_order, signal) => {
		signal.addEventListener("abort", () => release.resolve(completed), { once: true });
		entered.resolve(); return release.promise;
	} } });
	await f.service.startup(context); const id = await register(f);
	await f.service.resume("resume", context);
	await call(f, "skill_evolution_enqueue", { request_id: "enqueue", snapshot_id: id, overflow: "defer" });
	const jobId = (await f.service.status(context)).pending[0];
	if (!jobId) throw new Error("No job admitted");
	const response = await call(f, "skill_evolution_schedule", { request_id: "schedule", job_id: jobId });
	expect(response.isError).toBe(false);
	await entered.promise;
	const handle = (await f.service.status(context)).scheduled[0];
	if (!handle) throw new Error("Missing durable handle");
	const record = await f.harness.getTask(handle.taskId, context);
	expect(record?.background).toBe(true); expect(record?.owner).toBeUndefined();
	if (!record) throw new Error("Missing task record");
	expect(record.conversationId).not.toBe(f.main.id);
	const worker = await f.harness.conversation(record.conversationId, context);
	if (!worker) throw new Error("Missing research owner");
	expect((await worker.agent(context)).tools).toEqual([]);
	expect((await worker.agent(context)).extensions).toEqual([]);
	expect((await f.harness.snapshot(EvolutionWorkerDoc, worker.id, context))?.research).toBe(true);
	const transcript = JSON.stringify((await f.main.context(context)).messages);
	expect(transcript).toContain("main done");
	expect(transcript).not.toContain("isolated-fixture-draft");
	const duplicate = await f.service.schedule("schedule", jobId, context, `agent:${f.main.id}`);
	expect(duplicate.taskId).toBe(handle.taskId);
	await expect(f.service.schedule("schedule", jobId, context, "different-actor")).rejects.toThrow("reused");
	await expect(f.service.kill("schedule", context, `agent:${f.main.id}`)).rejects.toThrow("reused");
	release.resolve(completed);
	expect((await f.harness.waitForTask(handle.taskId, context)).state.outcome.status).toBe("completed");
	// Even accidental host reconfiguration cannot grant a registered research owner admin capability.
	const admin = f.extension.tools?.find((tool) => tool.name === "skill_evolution_resume");
	if (!admin) throw new Error("Missing registered admin tool");
	await worker.configure({ model: { provider: "faux", modelId: "main" }, extensions: [f.extension], tools: [admin] }, context);
	f.faux.setResponses([fauxAssistantMessage(fauxToolCall("skill_evolution_resume", { request_id: "worker-attack" }), { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
	await (await worker.submit({ type: "input", content: "Attempt admin operation" }, context)).wait(context);
	expect(JSON.stringify((await worker.context(context)).messages)).toContain("no evolution administration capability");
});

test("kill fences before physical abort and idempotent retry cannot abort a later scheduled task", async () => {
	const entered = Promise.withResolvers<void>(); const physicallyAborted = Promise.withResolvers<void>();
	const f = await fixture({ executor: { run: async (_order, signal) => {
		entered.resolve();
		return new Promise<EvolutionWorkResult>((resolve) => {
			signal.addEventListener("abort", () => { physicallyAborted.resolve(); resolve(completed); }, { once: true });
		});
	} } });
	await f.service.startup(context); const snapshot = await register(f); await f.service.resume("resume", context);
	const admitted = await f.service.enqueue("enqueue", snapshot, "defer", context);
	if (!admitted.jobId) throw new Error("Missing admitted job");
	const scheduled = await f.service.schedule("schedule", admitted.jobId, context);
	if (!scheduled.taskId) throw new Error("Missing task ID");
	await entered.promise;
	const kill = await call(f, "skill_evolution_kill", { request_id: "kill" });
	await physicallyAborted.promise;
	expect(kill.isError).toBe(false);
	expect((await f.service.status(context)).mode).toBe("killed");
	expect((await f.harness.getTask(scheduled.taskId, context))?.abortRequested).toBe(true);
	expect((await f.harness.snapshot(EvolutionJobDoc, admitted.jobId, context))?.resultRef).toBeNull();
	await f.service.resume("resume-after-kill", context); f.clock.value += 60_000;
	const next = await f.service.schedule("next-schedule", admitted.jobId, context);
	await f.service.kill("kill", context, `agent:${f.main.id}`);
	expect((await f.service.status(context)).mode).toBe("running");
	if (!next.taskId) throw new Error("Missing next task");
	expect((await f.harness.getTask(next.taskId, context))?.abortRequested).toBe(false);
	await f.service.kill("new-kill", context);
});

test("durable scheduling mapping and receipts survive SQLite restart; startup remains paused", async () => {
	const entered = Promise.withResolvers<void>();
	const executor: EvolutionResearchExecutor = { run: async (_order, signal) => {
		entered.resolve();
		return new Promise<EvolutionWorkResult>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
	} };
	const first = await fixture({ executor });
	await first.service.startup(context); const snapshot = await register(first); await first.service.resume("resume", context);
	const admitted = await first.service.enqueue("enqueue", snapshot, "defer", context);
	if (!admitted.jobId) throw new Error("Missing job");
	const scheduled = await first.service.schedule("schedule", admitted.jobId, context);
	await entered.promise;
	await close(first.harness);
	const second = await fixture({ executor: { run: async () => { throw new Error("Interrupted research must not replay"); } } }, "direct", first.path);
	await second.service.startup(context);
	expect((await second.service.status(context)).mode).toBe("paused");
	const replay = await second.service.schedule("schedule", admitted.jobId, context);
	expect(replay.taskId).toBe(scheduled.taskId);
	if (!scheduled.taskId) throw new Error("Missing persisted task ID");
	expect((await second.harness.waitForTask(scheduled.taskId, context)).state.status).toBe("terminal");
	expect((await second.harness.snapshot(EvolutionJobDoc, admitted.jobId, context))?.spent.costMicros).toBe(1000);
});

test("SLO bounds and changed deployment budget policy fail closed without resetting spend", async () => {
	const f = await fixture({ executor: { run: async () => completed } });
	await f.service.startup(context);
	await expect(f.service.registerSlo({ ...slo, cpuCores: 2 }, context)).rejects.toThrow("acceptance bounds");
	await expect(f.service.registerSlo({ ...slo, pairedBlockP95UpperMs: NaN }, context)).rejects.toThrow("acceptance bounds");
	const snapshot = await register(f); await f.service.resume("resume", context);
	const admitted = await f.service.enqueue("enqueue", snapshot, "defer", context);
	if (!admitted.jobId) throw new Error("Missing job");
	const scheduled = await f.service.schedule("schedule", admitted.jobId, context);
	if (!scheduled.taskId) throw new Error("Missing task");
	await f.harness.waitForTask(scheduled.taskId, context);
	const spent = (await f.service.status(context)).spent;
	await close(f.harness);
	const changed = config();
	if (!changed.config.budgets) throw new Error("Missing fixture budgets");
	changed.config.budgets.dailyMicroUsd = 20_000;
	const reopened = await fixture({ executor: { run: async () => completed }, config: changed }, "direct", f.path);
	await reopened.service.startup(context);
	const status = await reopened.service.status(context);
	expect(status.budgetScope).toBe("per-deployment-no-automatic-rollover");
	expect(status.spent).toEqual(spent);
	expect(status.deploymentMicroUsdLimit).toBe(10_000);
	expect(status.disabledReasons).toContain("persisted deployment budget policy does not match this configuration");
});

test("builtin author performs a real separate tool-less model call and saves only fenced draft plus reported usage", async () => {
	const models = createModels();
	const provider = fauxProvider({ provider: "author-only", models: [{ id: "author" }] });
	models.setProvider(provider.provider);
	const model = models.getModel("author-only", "author");
	if (!model) throw new Error("Missing author model");
	let authorCalls = 0;
	provider.setResponses([(request) => {
		authorCalls++;
		expect(request.messages.some((message) => message.role === "system" && (message.toolsAdded?.length ?? 0) > 0)).toBe(false);
		return fauxAssistantMessage(JSON.stringify({ operation: "edit", name: "parser", hypothesis: "Check input", description: "Parser", body: "Validate bounds", files: {} }));
	}]);
	const f = await fixture({ builtinAuthor: { models, model } });
	await f.service.startup(context); const snapshot = await register(f, true); await f.service.resume("resume", context);
	const admitted = await f.service.enqueue("enqueue", snapshot, "defer", context);
	if (!admitted.jobId) throw new Error("Missing job");
	const scheduled = await f.service.schedule("schedule", admitted.jobId, context);
	if (!scheduled.taskId) throw new Error("Missing task");
	expect((await f.harness.waitForTask(scheduled.taskId, context)).state.outcome.status).toBe("completed");
	expect(authorCalls).toBe(1);
	const job = await f.harness.snapshot(EvolutionJobDoc, admitted.jobId, context);
	if (!job?.resultRef) throw new Error("Missing draft reference");
	const draft = await f.harness.snapshot(EvolutionCandidateDoc, job.resultRef, context);
	expect(draft?.candidate?.body).toBe("Validate bounds");
	expect(draft?.baselineManifest).toBe("a".repeat(64));
	expect(draft?.inputTokenUpperBound).toBe(1000);
	expect(draft?.providerReportedUsage).not.toBeNull();
	expect(draft?.conservativelyCharged?.costMicros).toBe(1000);
	expect(JSON.stringify((await f.main.context(context)).messages)).not.toContain("Validate bounds");
	expect((await f.service.status(context)).automaticAuthorModelImplemented).toBe(true);
	expect(Object.hasOwn(draft ?? {}, "approved")).toBe(false);
});

test("builtin author late response cannot save candidate after kill epoch even if provider ignores signal", async () => {
	const entered = Promise.withResolvers<void>(); const answer = Promise.withResolvers<ReturnType<typeof fauxAssistantMessage>>();
	const models = createModels();
	const provider = fauxProvider({ provider: "author-only", models: [{ id: "author" }] });
	models.setProvider(provider.provider);
	const model = models.getModel("author-only", "author");
	if (!model) throw new Error("Missing author model");
	// Narrow trusted transport fixture deliberately returns a late response.
	const f = await fixture({ builtinAuthor: { model, models: {
		completeSimple: async () => { entered.resolve(); return answer.promise; },
	} } });
	await f.service.startup(context); const snapshot = await register(f, true); await f.service.resume("resume", context);
	const admitted = await f.service.enqueue("enqueue", snapshot, "defer", context);
	if (!admitted.jobId) throw new Error("Missing job");
	const scheduled = await f.service.schedule("schedule", admitted.jobId, context);
	if (!scheduled.taskId) throw new Error("Missing task");
	await entered.promise;
	// Subscribe to the durable fence state BEFORE observing/triggering late completion.
	const watch = await f.harness.watchDoc(EvolutionQueueDoc, context);
	if (!watch) throw new Error("Missing queue watch");
	const fenced = Promise.withResolvers<void>();
	watch.start(async (value) => { if (value?.mode === "killed") fenced.resolve(); });
	if (watch.value?.mode === "killed") fenced.resolve();
	const killing = f.service.kill("kill", context);
	await fenced.promise;
	answer.resolve(fauxAssistantMessage(JSON.stringify({ operation: "edit", name: "parser", hypothesis: "Late", description: "Parser", body: "Late body", files: {} })));
	await killing;
	await watch.stop();
	const job = await f.harness.snapshot(EvolutionJobDoc, admitted.jobId, context);
	expect(job?.resultRef).toBeNull();
	expect(await f.harness.snapshot(EvolutionCandidateDoc, `candidate-${admitted.jobId}-1`, context)).toBeUndefined();
});
