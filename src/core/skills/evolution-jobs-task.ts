import type { Context } from "@earendil-works/chord";
import { defineDocFamily, defineTask, type Session, type TaskId } from "@earendil-works/pi-durable";
import { EvolutionJobDoc, EvolutionJobError, EvolutionJobs, type EvolutionBudget, type EvolutionJobInput, type EvolutionLease } from "./evolution-jobs.ts";

export type EvolutionWorkResult = {
	readonly outcome: "completed" | "retry" | "failed";
	readonly spent: EvolutionBudget;
	/** Candidate/evaluation artifact reference, NOT publication authorization. */
	readonly resultRef: string | null;
};
export type EvolutionWorkOrder = {
	readonly input: EvolutionJobInput;
	readonly lease: EvolutionLease;
	readonly reservation: EvolutionBudget;
};
/**
 * Only sandbox/candidate IO belongs here. The implementation receives no Tx, runtime,
 * conversation, main ask/todo/progress API or publication capability. It must enforce
 * provider and OS limits before consuming resources; accounting alone is not a sandbox.
 */
export interface EvolutionResearchExecutor {
	run(order: EvolutionWorkOrder, signal: AbortSignal, context: Context): Promise<EvolutionWorkResult>;
	/** Idempotent post-settlement effects, resumed through a durable checkpoint. */
	finalize?(order: EvolutionWorkOrder, result: EvolutionWorkResult, context: Context): Promise<void>;
}
type TaskInput = { readonly jobId: string; readonly worker: string };
type Checkpoint =
	| { phase: "claim" }
	| { phase: "work"; lease: EvolutionLease; order: EvolutionWorkOrder }
	| { phase: "interrupted"; lease: EvolutionLease }
	| { phase: "finalize"; lease: EvolutionLease; order: EvolutionWorkOrder; result: EvolutionWorkResult };
type TaskResult = { readonly status: "settled" | "interrupted" | "refused" | "aborted" };
type Scheduled = { jobId: string; worker: string; taskId: TaskId<TaskResult> | null };
const ScheduledDoc = defineDocFamily<Scheduled, string>({
	kind: "dinobot.skill-evolution.scheduled", scope: "session", version: 1, family: true,
	initial: () => ({ jobId: "", worker: "", taskId: null }),
});

/**
 * Host wiring:
 * 1. Construct with the queue and an OS-isolated research executor.
 * 2. Register `driver.task` in a host extension's tasks, before Harness.resume().
 * 3. Call `driver.schedule(session, requestId, jobId, worker, context)`.
 * A private ownerless conversation owns the background task: no parent/main coupling.
 * Crash during research consumes the frozen reservation and ends this task. The host
 * may schedule a NEW attempt after cooldown; research is never blindly replayed.
 */
export function createEvolutionJobDriver(jobs: EvolutionJobs, executor: EvolutionResearchExecutor, now: () => number) {
	const task = defineTask<TaskInput, Checkpoint, TaskResult>({
		name: "dinobot.skill-evolution.research", version: 1,
		initial: () => ({ phase: "claim" }),
		phases: {
			claim: async (record, runtime, context) => {
				await runtime.commit(async (tx) => {
					const receipt = await jobs.apply(tx, {
						commandId: `task-${record.id}-claim`, op: "claim", jobId: record.input.jobId, worker: record.input.worker,
					}, now());
					if (!receipt.lease) throw new EvolutionJobError("state", "Claim receipt lacks lease");
					const job = await tx.doc(EvolutionJobDoc, record.input.jobId, record.input.jobId);
					if (!job.input) throw new EvolutionJobError("state", "Missing research input");
					const order = {
						input: { ...job.input, budget: { ...job.input.budget }, attemptReservation: { ...job.input.attemptReservation } },
						lease: { ...receipt.lease }, reservation: { ...job.reserved },
					};
					return { status: "running", checkpoint: { phase: "work", lease: receipt.lease, order } };
				}, context);
			},
			work: async (record, runtime, context) => {
				const lease = record.state.checkpoint.lease;
				// Write intent BEFORE external work. Reopening this checkpoint never reruns run().
				await runtime.commit(async (tx) => {
					await jobs.apply(tx, { commandId: `task-${record.id}-begin`, op: "begin", lease }, now());
					return { status: "running", checkpoint: { phase: "interrupted", lease } };
				}, context);
				const order = record.state.checkpoint.order;
				let result: EvolutionWorkResult;
				try {
					result = await executor.run(structuredClone(order),
						AbortSignal.any([runtime.signal, AbortSignal.timeout(order.reservation.timeMs)]), context);
				} catch (error) {
					// Durable recovery, rather than refunding an unknown provider charge.
					try {
						await runtime.commit(async (tx) => {
							await jobs.apply(tx, { commandId: `task-${record.id}-interrupt`, op: "interrupt", lease }, now());
							return { status: "terminal", outcome: { status: "completed", result: { status: "interrupted" } } };
						}, context);
					} catch (commitError) {
						if (!(commitError instanceof EvolutionJobError) || commitError.code !== "stale") throw commitError;
						await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: { status: "refused" } } }), context);
					}
					runtime.report(error);
					return;
				}
				try {
					await runtime.commit(async (tx) => {
						if (result.outcome === "completed") {
							await jobs.apply(tx, { commandId: `task-${record.id}-evaluating`, op: "stage", lease, stage: "evaluating" }, now());
							await jobs.apply(tx, { commandId: `task-${record.id}-ready`, op: "stage", lease, stage: "ready" }, now());
						}
						await jobs.apply(tx, { commandId: `task-${record.id}-settle`, op: "settle", lease, ...result }, now());
						if (executor.finalize && result.outcome === "completed") {
							return { status: "running", checkpoint: { phase: "finalize", lease, order, result } };
						}
						return { status: "terminal", outcome: { status: "completed", result: { status: "settled" } } };
					}, context);
				} catch (error) {
					if (!(error instanceof EvolutionJobError)) throw error;
					await runtime.commit(() => ({
						status: "terminal", outcome: { status: "completed", result: { status: "refused" } },
					}), context);
				}
			},
			finalize: async (record, runtime, context) => {
				await executor.finalize?.(record.state.checkpoint.order, record.state.checkpoint.result, context);
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: { status: "settled" } } }), context);
			},
			interrupted: async (record, runtime, context) => {
				try {
					await runtime.commit(async (tx) => {
						await jobs.apply(tx, {
							commandId: `task-${record.id}-interrupt`, op: "interrupt", lease: record.state.checkpoint.lease,
						}, now());
						return { status: "terminal", outcome: { status: "completed", result: { status: "interrupted" } } };
					}, context);
				} catch (error) {
					if (!(error instanceof EvolutionJobError) || error.code !== "stale") throw error;
					await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: { status: "refused" } } }), context);
				}
			},
		},
		abort: async (record, runtime, context) => {
			// An old task abort must not cancel a newer claim of the same job.
			try {
				await runtime.commit(async (tx) => {
					if (record.state.checkpoint.phase !== "claim") {
						await jobs.apply(tx, { commandId: `task-${record.id}-abort`, op: "interrupt", lease: record.state.checkpoint.lease }, now());
					}
					return { status: "terminal", outcome: { status: "aborted" } };
				}, context);
			} catch (error) {
				if (!(error instanceof EvolutionJobError) || error.code !== "stale") throw error;
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
			}
		},
	});
	return {
		task,
		async schedule(session: Pick<Session, "commit">, requestId: string, jobId: string, worker: string, context: Context) {
			if (!requestId || requestId.length > 512 || !jobId || !worker || worker.length > 512) throw new EvolutionJobError("invalid", "Invalid scheduling input");
			return session.commit(async (tx) => {
				const receipt = await tx.doc(ScheduledDoc, requestId, requestId);
				if (receipt.taskId) {
					if (receipt.jobId !== jobId || receipt.worker !== worker) throw new EvolutionJobError("conflict", "Schedule ID reused");
					return receipt.taskId;
				}
				const owner = await tx.createConversation({ ownership: { kind: "ownerless" } });
				const id = await tx.createTask(task, { jobId, worker }, {
					ownership: { kind: "conversation" }, conversationId: owner.id, background: true,
				});
				receipt.jobId = jobId; receipt.worker = worker; receipt.taskId = id;
				return id;
			}, context);
		},
	};
}
