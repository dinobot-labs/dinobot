import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import {
	configure, defineDoc, defineDocFamily, type Harness, type TaskId, type Tx,
} from "@earendil-works/pi-durable";
import { REVIEW_BUDGET_WINDOW_MS, type skillEvolutionConfig } from "./evolution-config.ts";
import {
	EvolutionJobDoc, EvolutionJobError, EvolutionJobs, EvolutionQueueDoc,
	type EvolutionBudget, type EvolutionJobPolicy, type EvolutionReceipt,
} from "./evolution-jobs.ts";
import {
	createEvolutionJobDriver, type EvolutionResearchExecutor, type EvolutionWorkOrder, type EvolutionWorkResult,
} from "./evolution-jobs-task.ts";
import { SkillFinalizationSummaryDoc, type createSkillConfirmation } from "./confirmation.ts";
import { authorSkillCandidate, type AuthoredSkillCandidate } from "./author.ts";

type ParsedConfig = ReturnType<typeof skillEvolutionConfig>;
/** Host attestation to already-verified immutable artifacts. No path or file authority. */
export type EvolutionSnapshotRegistration = {
	readonly manifestHash: string;
	readonly evidenceDigest: string;
	readonly evidenceWindow: string;
	readonly evidenceCutoff: number;
	readonly problem: string;
	/** Host-frozen author input, never supplied through a model-facing tool. */
	readonly authorSnapshot?: { readonly content: string; readonly hash: string };
};
/**
 * Host-only registration of verified SLO evidence, not a caller-controlled enable flag.
 * The host verifies the source measurements, OS isolation and executor revision before
 * calling registerSlo. Numeric guards here do not certify the underlying measurements.
 */
export type EvolutionSloRegistration = {
	readonly evidenceId: string;
	readonly environmentRevision: string;
	readonly executorRevision: string;
	readonly pairedBlockP95UpperMs: number;
	readonly errorIncreaseUpper: number;
	readonly cpuCores: number;
	readonly rssBytes: number;
};
type ScheduledHandle = { jobId: string; taskId: TaskId; requestId: string };
type ServiceState = { slo: EvolutionSloRegistration | null; handles: ScheduledHandle[]; providerReservations: number };
export const EvolutionServiceDoc = defineDoc<ServiceState>({
	kind: "dinobot.skill-evolution.service", scope: "session", version: 1,
	initial: () => ({ slo: null, handles: [], providerReservations: 0 }),
});
/** Operator intent exists even when a research queue has never been initialized. */
export const EvolutionControlDoc = defineDoc<{
	mode: "paused" | "killed" | "running"; epoch: number;
	/** Last explicit operator operation; startup pauses never set it. Absent in older documents. */
	lastOp?: "pause" | "kill" | "resume" | null;
}>({
	kind: "dinobot.skill-evolution.operator-control", scope: "session", version: 1,
	initial: () => ({ mode: "paused", epoch: 0, lastOp: null }),
});
/** Snapshot problem label of background review jobs (design section 6). */
export const BACKGROUND_REVIEW_PROBLEM = "background-review";
export type EvolutionProviderReservation = {
	readonly snapshotId: string;
	readonly executorRevision: string;
	readonly inputTokenUpperBound: number;
	readonly maximumProviderAttempts: number;
	readonly reservedMicroUsd: number;
};
const ProviderReservationDoc = defineDocFamily<{ reservation: EvolutionProviderReservation | null }, string>({
	kind: "dinobot.skill-evolution.provider-reservation", scope: "session", version: 1, family: true,
	initial: () => ({ reservation: null }),
});
type ReportedUsage = {
	input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number;
	cacheWrite1h: number | null; reasoning: number | null;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
};
export const EvolutionCandidateDoc = defineDocFamily<{
	candidate: AuthoredSkillCandidate | null; jobId: string; fence: number; epoch: number;
	baselineManifest: string; snapshotHash: string; providerReportedUsage: ReportedUsage | null;
	inputTokenUpperBound: number; conservativelyCharged: EvolutionBudget | null;
}, string>({
	kind: "dinobot.skill-evolution.candidate-draft", scope: "session", version: 1, family: true,
	initial: () => ({
		candidate: null, jobId: "", fence: 0, epoch: 0, baselineManifest: "", snapshotHash: "",
		providerReportedUsage: null, inputTokenUpperBound: 0, conservativelyCharged: null,
	}),
});
const SnapshotDoc = defineDocFamily<{ registration: EvolutionSnapshotRegistration | null }, string>({
	kind: "dinobot.skill-evolution.snapshot-registration", scope: "session", version: 1, family: true,
	initial: () => ({ registration: null }),
});
/** Stable capability marker checked by admin tools even if a host later changes agent selection. */
export const EvolutionWorkerDoc = defineDoc<{ research: boolean }>({
	kind: "dinobot.skill-evolution.worker", scope: "conversation", history: "latest", fork: "current", version: 1,
	initial: () => ({ research: true }),
});
export type EvolutionOperationResult = {
	readonly receipt: EvolutionReceipt | null;
	readonly jobId: string | null;
	readonly taskId: TaskId | null;
	readonly abortTaskIds: TaskId[];
};
const OperationDoc = defineDocFamily<{ fingerprint: string | null; result: EvolutionOperationResult | null }, string>({
	kind: "dinobot.skill-evolution.operation", scope: "session", version: 1, family: true,
	initial: () => ({ fingerprint: null, result: null }),
});
type Operation = { readonly requestId: string; readonly actor: string } & (
	| { readonly op: "pause" }
	| { readonly op: "kill" }
	| { readonly op: "resume" }
	| { readonly op: "enqueue"; readonly snapshotId: string; readonly overflow: "defer" | "drop" }
	| { readonly op: "schedule"; readonly jobId: string }
);
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function text(value: string, field: string): void {
	if (typeof value !== "string" || !value || value.length > 200) throw new EvolutionJobError("invalid", `${field} must contain 1..200 characters`);
}
function hashValid(value: string): void {
	if (!/^[a-f0-9]{64}$/.test(value)) throw new EvolutionJobError("invalid", "Expected immutable SHA256 identifier");
}
function int(value: number, field: string, minimum = 1): void {
	if (!Number.isSafeInteger(value) || value < minimum) throw new EvolutionJobError("invalid", `${field} must be a safe integer >= ${minimum}`);
}
function copyResult(value: EvolutionOperationResult): EvolutionOperationResult {
	return {
		receipt: value.receipt ? { ...value.receipt, lease: value.receipt.lease ? { ...value.receipt.lease } : null } : null,
		jobId: value.jobId, taskId: value.taskId, abortTaskIds: [...value.abortTaskIds],
	};
}
function snapshotValue(value: EvolutionSnapshotRegistration): EvolutionSnapshotRegistration {
	return {
		manifestHash: value.manifestHash, evidenceDigest: value.evidenceDigest, evidenceWindow: value.evidenceWindow,
		evidenceCutoff: value.evidenceCutoff, problem: value.problem,
		...(value.authorSnapshot ? { authorSnapshot: { ...value.authorSnapshot } } : {}),
	};
}
function makePolicy(parsed: ParsedConfig, executorRevision: string | undefined): EvolutionJobPolicy | null {
	const limits = parsed.config.budgets;
	if (!limits) return null;
	for (const [key, value] of Object.entries(limits)) int(value, key);
	if (limits.maxPending > 32 || limits.maxCalls > 8 || limits.maxOutputTokens > 32_768
		|| limits.timeoutMs > 300_000 || limits.jobMicroUsd > limits.dailyMicroUsd) {
		throw new EvolutionJobError("invalid", "Invalid finite research budget limits");
	}
	const windowMs = parsed.config.review ? REVIEW_BUDGET_WINDOW_MS : undefined;
	const maxJobBudget: EvolutionBudget = {
		calls: limits.maxCalls, tokens: limits.maxOutputTokens, costMicros: limits.jobMicroUsd,
		timeMs: limits.timeoutMs, candidates: 4,
	};
	// Without review, dailyMicroUsd is NEVER replenished: a conservative persisted deployment ceiling.
	// Review mode adds a fixed, grid-aligned 24 h window (spent resets, reservations carry over).
	const jobsAffordable = Math.floor(limits.dailyMicroUsd / limits.jobMicroUsd);
	const total = (n: number) => n * Math.min(jobsAffordable, Math.floor(Number.MAX_SAFE_INTEGER / n));
	return {
		// windowMs is hashed only when present, so lifetime-ceiling deployments keep their revision.
		revision: hash({
			limits, confirmation: parsed.config.confirmation ?? null, executorRevision: executorRevision ?? null,
			...(windowMs !== undefined ? { windowMs } : {}),
		}),
		...(windowMs !== undefined ? { windowMs } : {}),
		maxPending: limits.maxPending,
		maxAttempts: Math.min(4, limits.maxCalls, limits.maxOutputTokens, limits.jobMicroUsd, limits.timeoutMs),
		leaseMs: limits.timeoutMs + 1_000, cooldownMs: 60_000,
		maxJobBudget,
		totalBudget: {
			calls: total(maxJobBudget.calls), tokens: total(maxJobBudget.tokens), costMicros: limits.dailyMicroUsd,
			timeMs: total(maxJobBudget.timeMs), candidates: total(maxJobBudget.candidates),
		},
	};
}
export type EvolutionServiceOptions = {
	readonly getHarness: () => Harness;
	readonly config: ParsedConfig;
	readonly executor?: EvolutionResearchExecutor;
	readonly builtinAuthor?: { readonly models: Pick<Models, "completeSimple">; readonly model: Model<Api> };
	readonly confirmation?: ReturnType<typeof createSkillConfirmation>;
	readonly capacity?: {
		readonly sample: () => Promise<number>;
		readonly admit: (tx: Tx, freeBytes: number, additionalBytes: number) => Promise<void>;
	};
	readonly retainSnapshot?: (tx: Tx, registrationId: string, manifestHash: string) => Promise<void>;
	/** Host-owned immutable revision, changed when executor code or isolation changes. */
	readonly executorRevision?: string;
	readonly now?: () => number;
	/**
	 * Background review publication (design section 6). Called from the durable finalize phase of a
	 * completed job when no confirmation provider is registered and review.publish is enabled.
	 * Must be idempotent across restarts.
	 */
	readonly reviewFinalize?: (order: EvolutionWorkOrder, result: EvolutionWorkResult, context: Context) => Promise<void>;
};

/**
 * Parent wiring: create service and install skillEvolutionExtension(service) BEFORE
 * opening/resuming the Harness; bind getHarness, await startup(), register verified
 * snapshots/SLO evidence, then explicitly resume. The model never registers authority.
 */
export function createSkillEvolutionService(options: EvolutionServiceOptions) {
	const parsed = structuredClone(options.config);
	const now = options.now ?? Date.now;
	const policy = makePolicy(parsed, options.executorRevision);
	// Statistical confirmation, when registered, stays the only publication path.
	const reviewPublication = Boolean(parsed.config.review?.publish && options.reviewFinalize && !options.confirmation && !options.executor);
	if (options.executor && options.builtinAuthor) throw new EvolutionJobError("invalid", "Choose trusted executor or builtin author, not both");
	const jobs = new EvolutionJobs({
		get commit() { return options.getHarness().commit.bind(options.getHarness()); },
		get snapshot() { return options.getHarness().snapshot.bind(options.getHarness()); },
	}, now);
	let started = false;
	function disabledReasons(slo: EvolutionSloRegistration | null, persistedRevision: string | null, providerReservations = 0): string[] {
		const config = parsed.config;
		const reasons = [...parsed.problems];
		if (!started) reasons.push("runtime startup has not completed");
		if (!config.author) reasons.push("author admission is disabled by configuration");
		// Review mode authors from host-frozen snapshots: observation, SLO and confirmation remain
		// prerequisites only of the sandbox evaluation path.
		if (!config.observe && !config.review) reasons.push("observation prerequisite is disabled");
		if (!config.sessionPinning) reasons.push("session pinning prerequisite is disabled");
		if (!policy) reasons.push("finite research budgets are missing");
		if (!options.executor && !options.builtinAuthor) reasons.push("trusted research executor is not installed");
		if (!providerReservations) reasons.push("host-verified provider reservation is missing");
		if (!options.executorRevision) reasons.push("trusted executor revision is not registered");
		if (config.evaluate && !options.confirmation) reasons.push("trusted confirmation provider is not registered");
		if (config.autoPublish && !options.confirmation) reasons.push("trusted automatic publisher is not registered");
		if (config.deactivate && !options.confirmation?.supportsLifecycle) reasons.push("trusted lifecycle confirmation is not registered");
		if (config.physicalGc) reasons.push("physical GC is not implemented by this service");
		const confirmation = config.confirmation;
		const sloRequired = !config.review || config.evaluate || config.autoPublish || config.deactivate;
		// Review mode without the statistical path: SLO evidence is not an admission prerequisite,
		// but a registered SLO must still match.
		if (!confirmation || !slo) { if (sloRequired) reasons.push("verified SLO registration is missing"); }
		else if (slo.evidenceId !== confirmation.sloEvidenceId || slo.environmentRevision !== confirmation.environmentRevision
			|| slo.executorRevision !== options.executorRevision) reasons.push("SLO registration does not match the configured environment/executor");
		if (policy && persistedRevision !== policy.revision) reasons.push("persisted deployment budget policy does not match this configuration");
		return [...new Set(reasons)];
	}
	function requireAdmission(slo: EvolutionSloRegistration | null, persistedRevision: string | null, providerReservations: number): void {
		const reasons = disabledReasons(slo, persistedRevision, providerReservations);
		if (reasons.length) throw new EvolutionJobError("disabled", reasons.join("; "));
	}
	const driver = createEvolutionJobDriver(jobs, {
		run: async (order, signal, context) => {
			const harness = options.getHarness();
			const state = await harness.snapshot(EvolutionServiceDoc, context);
			const queue = await jobs.status(context);
			requireAdmission(state?.slo ?? null, queue?.policy?.revision ?? null, state?.providerReservations ?? 0);
			const reservation = (await harness.snapshot(ProviderReservationDoc, order.input.snapshot, context))?.reservation;
			if (!reservation || reservation.executorRevision !== options.executorRevision) throw new EvolutionJobError("disabled", "Matching provider reservation is unavailable");
			if (options.executor) return options.executor.run(order, signal, context);
			const author = options.builtinAuthor;
			const registration = (await harness.snapshot(SnapshotDoc, order.input.snapshot, context))?.registration;
			if (!author || !registration?.authorSnapshot) throw new EvolutionJobError("disabled", "Builtin author requires host-frozen author snapshot");
			const frozen = registration.authorSnapshot;
			const outputPerCall = Math.floor(order.reservation.tokens / reservation.maximumProviderAttempts);
			const review = Boolean(parsed.config.review) && registration.problem === BACKGROUND_REVIEW_PROBLEM;
			const result = await authorSkillCandidate({
				completeSimple: (model, context, opts) => author.models.completeSimple(model, context, {
					...opts, maxRetries: reservation.maximumProviderAttempts - 1,
				}),
			}, author.model, {
				snapshot: frozen.content, snapshotHash: frozen.hash, baselineManifest: registration.manifestHash,
				maxOutputTokens: outputPerCall, timeoutMs: order.reservation.timeMs, signal,
				...(review ? { mode: "review" as const } : {}),
			});
			const usage = result.usage;
			for (const [field, value] of Object.entries({ input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, totalTokens: usage.totalTokens })) int(value, field, 0);
			if (!Number.isFinite(usage.cost.total) || usage.cost.total < 0 || Math.ceil(usage.cost.total * 1_000_000) > reservation.reservedMicroUsd
				|| usage.output > outputPerCall || usage.input + usage.cacheRead + usage.cacheWrite > reservation.inputTokenUpperBound) {
				throw new EvolutionJobError("budget", "Reported provider usage exceeds its trusted reservation");
			}
			const resultRef = `candidate-${order.lease.jobId}-${order.lease.fence}`;
			await harness.commit(async (tx) => {
				// Assertion and draft write MUST share the single-writer commit boundary.
				// Recheck even on receipt replay: a previous begin receipt is not a fresh save capability.
				const queue = await tx.doc(EvolutionQueueDoc);
				const job = await tx.doc(EvolutionJobDoc, order.lease.jobId, order.lease.jobId);
				const at = now();
				if (queue.mode !== "running" || job.status !== "running" || queue.epoch !== order.lease.epoch
					|| job.epoch !== order.lease.epoch || job.fence !== order.lease.fence || job.worker !== order.lease.worker || at >= job.leaseUntil) {
					throw new EvolutionJobError("stale", "Candidate save refused by current lease or epoch");
				}
				await jobs.apply(tx, { commandId: `save-${resultRef}`, op: "begin", lease: order.lease }, at);
				const doc = await tx.doc(EvolutionCandidateDoc, resultRef, resultRef);
				doc.candidate = structuredClone(result.candidate);
				doc.jobId = order.lease.jobId; doc.fence = order.lease.fence; doc.epoch = order.lease.epoch;
				doc.baselineManifest = result.baselineManifest; doc.snapshotHash = result.snapshotHash;
				doc.providerReportedUsage = {
					input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite,
					totalTokens: usage.totalTokens, cost: { ...usage.cost }, cacheWrite1h: usage.cacheWrite1h ?? null, reasoning: usage.reasoning ?? null,
				};
				doc.inputTokenUpperBound = reservation.inputTokenUpperBound;
				// Retries may have billed failed requests absent from the successful response usage.
				doc.conservativelyCharged = { ...order.reservation };
			}, context);
			if (parsed.config.evaluate && result.candidate.operation !== "no_change") {
				if (!options.confirmation) throw new EvolutionJobError("disabled", "Trusted confirmation provider is unavailable");
				return options.confirmation.evaluate({
					order, candidate: result.candidate, baselineManifest: result.baselineManifest,
				}, signal, context);
			}
			return { outcome: "completed", spent: { ...order.reservation }, resultRef };
		},
		finalize: async (order, result, context) => {
			if (options.executor?.finalize) await options.executor.finalize(order, result, context);
			else if (parsed.config.autoPublish) await options.confirmation?.finalize(order, result, context);
			else if (reviewPublication) await options.reviewFinalize!(order, result, context);
		},
	}, now);
	async function abortHandles(ids: readonly TaskId[], context: Context): Promise<void> {
		for (const id of ids) await options.getHarness().abortTask(id, context);
	}
	async function operate(command: Operation, context: Context): Promise<EvolutionOperationResult> {
		text(command.requestId, "requestId"); text(command.actor, "actor");
		if (command.op === "enqueue") hashValid(command.snapshotId);
		if (command.op === "schedule") hashValid(command.jobId);
		const fingerprint = hash(command);
		let capacity: { ok: true; freeBytes: number } | { ok: false; error: Error } | undefined;
		if (options.capacity && (command.op === "enqueue" || command.op === "schedule")) {
			try { capacity = { ok: true, freeBytes: await options.capacity.sample() }; }
			catch (error) { capacity = { ok: false, error: error instanceof Error ? error : new Error(String(error)) }; }
		}
		const result = await options.getHarness().commit(async (tx) => {
			const operation = await tx.doc(OperationDoc, command.requestId, command.requestId);
			if (operation.result) {
				if (operation.fingerprint !== fingerprint) throw new EvolutionJobError("conflict", "Operation ID reused with different input or actor");
				return copyResult(operation.result);
			}
			if (capacity && options.capacity) {
				if (!capacity.ok) throw capacity.error;
				await options.capacity.admit(tx, capacity.freeBytes, 16 * 1024 * 1024);
			}
			const queue = await tx.doc(EvolutionQueueDoc);
			const service = await tx.doc(EvolutionServiceDoc);
			// Only the bounded live mapping is indexed; terminal receipt history lives in families.
			const live: ScheduledHandle[] = [];
			for (const handle of service.handles) {
				const record = await tx.task(handle.taskId);
				if (record && record.state.status !== "terminal") live.push({ ...handle });
			}
			const result: EvolutionOperationResult = { receipt: null, jobId: null, taskId: null, abortTaskIds: [] };
			const queueCommandId = `service-${hash(command.requestId)}`;
			if (command.op === "pause" || command.op === "kill" || command.op === "resume") {
				const control = await tx.doc(EvolutionControlDoc);
				// A model (agent:*) may resume only a startup pause, never an explicit pause/kill. Legacy control
				// documents without lastOp cannot tell them apart and count as an operator stop for models.
				if (command.op === "resume" && command.actor.startsWith("agent:")
					&& (control.mode === "killed" || control.lastOp === "pause" || control.lastOp === "kill" || control.lastOp === undefined)) {
					throw new EvolutionJobError("disabled", "Research was explicitly paused or killed; only the operator can resume it");
				}
				if (command.op === "resume") requireAdmission(service.slo, queue.policy?.revision ?? null, service.providerReservations);
				let receipt: EvolutionReceipt;
				if (queue.policy) {
					receipt = await jobs.apply(tx, { commandId: queueCommandId, op: command.op }, now());
				} else {
					if (command.op === "resume" || queue.pending.length || live.length) {
						throw new EvolutionJobError("state", "Cannot operate uninitialized queue with indexed research tasks");
					}
					// A real durable operator receipt, explicitly NOT a fabricated job-queue receipt.
					receipt = {
						commandId: queueCommandId, fingerprint, at: now(), outcome: "changed",
						reason: "Operator stop persisted; no initialized research queue or tasks",
						jobId: null, lease: null,
					};
				}
				int(control.epoch + 1, "operator epoch");
				control.epoch++;
				control.mode = command.op === "resume" ? "running" : command.op === "kill" ? "killed" : "paused";
				control.lastOp = command.op;
				operation.result = {
					...result, receipt, abortTaskIds: command.op === "resume" ? [] : live.map((handle) => handle.taskId),
				};
			} else {
				requireAdmission(service.slo, queue.policy?.revision ?? null, service.providerReservations);
				if (!policy) throw new EvolutionJobError("disabled", "Research policy is missing");
				if (queue.mode !== "running") throw new EvolutionJobError("disabled", `Research queue is ${queue.mode}`);
				if (command.op === "enqueue") {
					const registration = (await tx.doc(SnapshotDoc, command.snapshotId, command.snapshotId)).registration;
					if (!registration || hash(snapshotValue(registration)) !== command.snapshotId) throw new EvolutionJobError("invalid", "Snapshot is not immutably registered");
					const provider = (await tx.doc(ProviderReservationDoc, command.snapshotId, command.snapshotId)).reservation;
					if (!provider || provider.executorRevision !== options.executorRevision) throw new EvolutionJobError("disabled", "Snapshot provider reservation is missing");
					if (options.builtinAuthor && !registration.authorSnapshot) throw new EvolutionJobError("disabled", "Builtin author snapshot content is missing");
					const reserve = (value: number) => Math.floor(value / policy.maxAttempts);
					const budget = { ...policy.maxJobBudget };
					const receipt = await jobs.apply(tx, {
						commandId: queueCommandId, op: "enqueue", overflow: command.overflow,
						input: {
							evidenceWindow: registration.evidenceWindow, evidenceCutoff: registration.evidenceCutoff,
							problem: registration.problem, policyRevision: policy.revision, snapshot: command.snapshotId, budget,
							attemptReservation: {
								calls: reserve(budget.calls), tokens: reserve(budget.tokens), costMicros: reserve(budget.costMicros),
								timeMs: reserve(budget.timeMs), candidates: reserve(budget.candidates),
							},
						},
					}, now());
					operation.result = { ...result, receipt, jobId: receipt.jobId };
				} else {
					const job = await tx.doc(EvolutionJobDoc, command.jobId, command.jobId);
					if (!job.input || (job.status !== "pending" && job.status !== "retry")) throw new EvolutionJobError("state", "Job is not schedulable");
					const registration = (await tx.doc(SnapshotDoc, job.input.snapshot, job.input.snapshot)).registration;
					if (!registration || hash(snapshotValue(registration)) !== job.input.snapshot) throw new EvolutionJobError("invalid", "Job snapshot registration is unavailable");
					if (live.length || queue.pending.some((id) => id === command.jobId) === false) throw new EvolutionJobError("state", "Research concurrency is one or job is not indexed");
					if (now() < job.notBefore) throw new EvolutionJobError("state", "Retry cooldown has not elapsed");
					const owner = await tx.createConversation({ ownership: { kind: "ownerless" } });
					await configure(tx, owner.id, { tools: [], extensions: [] });
					await tx.doc(EvolutionWorkerDoc, owner.id);
					const taskId = await tx.createTask(driver.task, { jobId: command.jobId, worker: `service-${hash(command.requestId)}` }, {
						ownership: { kind: "conversation" }, conversationId: owner.id, background: true,
					});
					live.push({ jobId: command.jobId, taskId, requestId: command.requestId });
					operation.result = { ...result, jobId: command.jobId, taskId };
				}
			}
			service.handles = live;
			operation.fingerprint = fingerprint;
			if (!operation.result) throw new EvolutionJobError("state", "Missing operation result");
			return copyResult(operation.result);
		}, context);
		// The fence/epoch and abort intent are durable BEFORE physical cancellation.
		await abortHandles(result.abortTaskIds, context);
		if (command.op === "schedule" && result.taskId) options.getHarness().resume();
		return result;
	}
	const service = {
		task: driver.task,
		/** Frozen job policy of this configuration (null without budgets). */
		policy,
		async startup(context: Context): Promise<void> {
			if (started) return;
			const ids = await options.getHarness().commit(async (tx) => {
				const state = await tx.doc(EvolutionServiceDoc);
				const queue = await tx.doc(EvolutionQueueDoc);
				const control = await tx.doc(EvolutionControlDoc);
				if (policy && !queue.policy) await jobs.apply(tx, { commandId: "service-initialize", op: "initialize", policy }, now());
				const stopped = control.mode === "killed" ? "kill" : "pause";
				if (queue.policy) await jobs.apply(tx, { commandId: `service-startup-${stopped}-${queue.epoch + 1}`, op: stopped }, now());
				control.mode = stopped === "kill" ? "killed" : "paused";
				return state.handles.map((handle) => handle.taskId);
			}, context);
			await abortHandles(ids, context);
			started = true;
		},
		async registerSnapshot(value: EvolutionSnapshotRegistration, context: Context): Promise<string> {
			hashValid(value.manifestHash); hashValid(value.evidenceDigest);
			text(value.evidenceWindow, "evidenceWindow"); text(value.problem, "problem");
			int(value.evidenceCutoff, "evidenceCutoff", 0);
			if (value.evidenceCutoff > now()) throw new EvolutionJobError("invalid", "Snapshot cutoff is in the future");
			const registration = snapshotValue(value);
			if (registration.authorSnapshot && (Buffer.byteLength(registration.authorSnapshot.content) > 64 * 1024
				|| createHash("sha256").update(registration.authorSnapshot.content).digest("hex") !== registration.authorSnapshot.hash)) {
				throw new EvolutionJobError("invalid", "Author snapshot hash or size is invalid");
			}
			const id = hash(registration);
			await options.getHarness().commit(async (tx) => {
				const doc = await tx.doc(SnapshotDoc, id, id);
				if (doc.registration && hash(snapshotValue(doc.registration)) !== id) throw new EvolutionJobError("conflict", "Immutable snapshot registration was corrupted");
				doc.registration = registration;
				await options.retainSnapshot?.(tx, id, registration.manifestHash);
			}, context);
			return id;
		},
		async registerProviderReservation(value: EvolutionProviderReservation, context: Context): Promise<void> {
			hashValid(value.snapshotId); text(value.executorRevision, "executorRevision");
			int(value.inputTokenUpperBound, "inputTokenUpperBound"); int(value.maximumProviderAttempts, "maximumProviderAttempts");
			int(value.reservedMicroUsd, "reservedMicroUsd");
			if (!policy || value.executorRevision !== options.executorRevision
				|| value.maximumProviderAttempts > Math.floor(policy.maxJobBudget.calls / policy.maxAttempts)
				|| value.maximumProviderAttempts > Math.floor(policy.maxJobBudget.tokens / policy.maxAttempts)
				|| value.reservedMicroUsd > Math.floor(policy.maxJobBudget.costMicros / policy.maxAttempts)) {
				throw new EvolutionJobError("budget", "Provider reservation exceeds frozen attempt limits or executor revision");
			}
			const reservation: EvolutionProviderReservation = {
				snapshotId: value.snapshotId, executorRevision: value.executorRevision, inputTokenUpperBound: value.inputTokenUpperBound,
				maximumProviderAttempts: value.maximumProviderAttempts, reservedMicroUsd: value.reservedMicroUsd,
			};
			await options.getHarness().commit(async (tx) => {
				const snapshot = await tx.doc(SnapshotDoc, value.snapshotId, value.snapshotId);
				if (!snapshot.registration) throw new EvolutionJobError("invalid", "Provider reservation requires registered immutable snapshot");
				const doc = await tx.doc(ProviderReservationDoc, value.snapshotId, value.snapshotId);
				if (doc.reservation && hash({ ...doc.reservation }) !== hash(reservation)) throw new EvolutionJobError("conflict", "Provider reservation is immutable");
				const state = await tx.doc(EvolutionServiceDoc);
				if (!doc.reservation) { int(state.providerReservations + 1, "providerReservations"); state.providerReservations++; }
				doc.reservation = reservation;
			}, context);
		},
		async registerSlo(value: EvolutionSloRegistration, context: Context): Promise<void> {
			text(value.evidenceId, "evidenceId"); text(value.environmentRevision, "environmentRevision"); text(value.executorRevision, "executorRevision");
			if (!Number.isFinite(value.pairedBlockP95UpperMs) || value.pairedBlockP95UpperMs > 250
				|| !Number.isFinite(value.errorIncreaseUpper) || value.errorIncreaseUpper > 0.001
				|| !Number.isFinite(value.cpuCores) || value.cpuCores <= 0 || value.cpuCores > 1
				|| !Number.isSafeInteger(value.rssBytes) || value.rssBytes <= 0 || value.rssBytes > 512 * 1024 * 1024) {
				throw new EvolutionJobError("invalid", "SLO registration exceeds ADR0031 acceptance bounds");
			}
			const registration: EvolutionSloRegistration = {
				evidenceId: value.evidenceId, environmentRevision: value.environmentRevision, executorRevision: value.executorRevision,
				pairedBlockP95UpperMs: value.pairedBlockP95UpperMs, errorIncreaseUpper: value.errorIncreaseUpper, cpuCores: value.cpuCores, rssBytes: value.rssBytes,
			};
			await options.getHarness().commit(async (tx) => {
				const doc = await tx.doc(EvolutionServiceDoc);
				if (doc.slo && hash({ ...doc.slo }) !== hash(registration)) throw new EvolutionJobError("conflict", "SLO registration is immutable for this deployment");
				doc.slo = registration;
			}, context);
		},
		async status(context: Context) {
			// Non-creating committed reads. Admission always rechecks inside its own Tx.
			const harness = options.getHarness();
			const [state, queue, control] = await Promise.all([
				harness.snapshot(EvolutionServiceDoc, context), jobs.status(context), harness.snapshot(EvolutionControlDoc, context),
			]);
			const reasons = disabledReasons(state?.slo ?? null, queue?.policy?.revision ?? null, state?.providerReservations ?? 0);
			const mode = queue?.policy ? queue.mode : control?.mode ?? "paused";
			const finalization = (await harness.snapshot(SkillFinalizationSummaryDoc, context))?.latest ?? null;
			const tasks = [];
			for (const handle of state?.handles ?? []) {
				const record = await harness.getTask(handle.taskId, context);
				tasks.push({ ...handle, status: record?.state.status ?? "missing" });
			}
			return {
					mode, admissionEnabled: mode === "running" && reasons.length === 0, canResume: reasons.length === 0, finalization,
					disabledReasons: [...reasons, ...(mode !== "running" ? [`queue is ${mode}`] : [])],
					executor: options.builtinAuthor ? "builtin-tool-less-author" : options.executor ? "trusted-host-executor" : "unavailable", executorRevision: options.executorRevision ?? null,
					automaticAuthorModelImplemented: Boolean(options.builtinAuthor), automaticEvaluationImplemented: Boolean(options.confirmation), publicationImplemented: Boolean(options.confirmation),
					reviewConfigured: Boolean(parsed.config.review),
					reviewPublicationEnabled: reviewPublication && Boolean(options.builtinAuthor),
					/** An explicit operator pause/kill is in force (not merely the startup pause). */
					operatorStopped: mode === "killed" || control?.lastOp === "pause" || control?.lastOp === "kill",
					budgetScope: queue?.policy?.windowMs !== undefined ? "fixed-window" as const : "per-deployment-no-automatic-rollover" as const,
					budgetWindowMs: queue?.policy?.windowMs ?? null, budgetWindowStart: queue?.windowStart ?? null,
					tokenAccounting: "provider-reported-output-with-conservative-retry-reservations",
					deploymentMicroUsdLimit: queue?.policy?.totalBudget.costMicros ?? null,
					spent: queue ? { ...queue.spent } : null, reserved: queue ? { ...queue.reserved } : null, pending: [...queue?.pending ?? []],
					coverage: queue ? { ...queue.coverage } : null, epoch: queue?.epoch ?? 0, scheduled: tasks,
					operatorEpoch: control?.epoch ?? 0,
				};
		},
		pause: (requestId: string, context: Context, actor = "host") => operate({ requestId, actor, op: "pause" }, context),
		kill: (requestId: string, context: Context, actor = "host") => operate({ requestId, actor, op: "kill" }, context),
		resume: (requestId: string, context: Context, actor = "host") => operate({ requestId, actor, op: "resume" }, context),
		enqueue: (requestId: string, snapshotId: string, overflow: "defer" | "drop", context: Context, actor = "host") => operate({ requestId, actor, op: "enqueue", snapshotId, overflow }, context),
		schedule: (requestId: string, jobId: string, context: Context, actor = "host") => operate({ requestId, actor, op: "schedule", jobId }, context),
	};
	return service;
}
export type SkillEvolutionService = ReturnType<typeof createSkillEvolutionService>;
