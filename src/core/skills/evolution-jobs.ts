import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { defineDoc, defineDocFamily, type Session, type Tx } from "@earendil-works/pi-durable";

/** Integer units only. Provider retries must fit calls/tokens/costMicros as well. */
export type EvolutionBudget = {
	calls: number; tokens: number; costMicros: number; timeMs: number; candidates: number;
};
const dimensions = ["calls", "tokens", "costMicros", "timeMs", "candidates"] as const;
function zero(): EvolutionBudget {
	return { calls: 0, tokens: 0, costMicros: 0, timeMs: 0, candidates: 0 };
}
export type EvolutionJobPolicy = {
	readonly revision: string;
	readonly maxPending: number;
	readonly maxAttempts: number;
	readonly leaseMs: number;
	readonly cooldownMs: number;
	readonly totalBudget: EvolutionBudget;
	readonly maxJobBudget: EvolutionBudget;
	/**
	 * Optional fixed, grid-aligned budget window. Absent: totalBudget is a lifetime deployment ceiling.
	 * Present: `spent` resets at each window boundary while `reserved` carries over, so
	 * spent + reserved <= totalBudget holds within every window.
	 */
	readonly windowMs?: number;
};
export type EvolutionJobInput = {
	readonly evidenceWindow: string;
	readonly evidenceCutoff: number;
	readonly problem: string;
	readonly policyRevision: string;
	/** Immutable, read-only research snapshot identifier; never a live main conversation. */
	readonly snapshot: string;
	readonly budget: EvolutionBudget;
	readonly attemptReservation: EvolutionBudget;
};
export type EvolutionLease = {
	readonly jobId: string; readonly worker: string; readonly fence: number; readonly epoch: number;
};
export type EvolutionStage = "authoring" | "evaluating" | "ready";
export type EvolutionJobState = {
	id: string;
	input: EvolutionJobInput | null;
	status: "pending" | "running" | "retry" | "completed" | "failed" | "cancelled";
	stage: EvolutionStage;
	fence: number;
	epoch: number;
	worker: string | null;
	leaseUntil: number;
	attempts: number;
	notBefore: number;
	reserved: EvolutionBudget;
	spent: EvolutionBudget;
	coalesced: number;
	resultRef: string | null;
};
type QueueState = {
	policy: EvolutionJobPolicy | null;
	mode: "paused" | "running" | "killed";
	epoch: number;
	lastNow: number;
	pending: string[];
	reserved: EvolutionBudget;
	/** Spend of the current budget window (lifetime spend when the policy has no window). */
	spent: EvolutionBudget;
	coverage: { accepted: number; coalesced: number; deferred: number; dropped: number };
	/** Start of the current budget window; absent for lifetime policies and older documents. */
	windowStart?: number;
};
export type EvolutionReceipt = {
	readonly commandId: string;
	readonly fingerprint: string;
	readonly at: number;
	readonly outcome: "initialized" | "accepted" | "coalesced" | "deferred" | "dropped" | "claimed" | "changed" | "acknowledged";
	readonly reason: string | null;
	readonly jobId: string | null;
	readonly lease: EvolutionLease | null;
};
type CommandState = { receipt: EvolutionReceipt | null; delivered: boolean };
export const EvolutionQueueDoc = defineDoc<QueueState>({
	kind: "dinobot.skill-evolution.queue", scope: "session", version: 1,
	initial: () => ({
		policy: null, mode: "paused", epoch: 0, lastNow: 0, pending: [], reserved: zero(), spent: zero(),
		coverage: { accepted: 0, coalesced: 0, deferred: 0, dropped: 0 },
	}),
});
export const EvolutionJobDoc = defineDocFamily<EvolutionJobState, string>({
	kind: "dinobot.skill-evolution.job", scope: "session", version: 1, family: true,
	initial: (id) => ({
		id, input: null, status: "pending", stage: "authoring", fence: 0, epoch: 0, worker: null,
		leaseUntil: 0, attempts: 0, notBefore: 0, reserved: zero(), spent: zero(), coalesced: 0, resultRef: null,
	}),
});
/** Receipt is also the outbox payload. Delivery is at-least-once, never exactly-once. */
export const EvolutionCommandDoc = defineDocFamily<CommandState, string>({
	kind: "dinobot.skill-evolution.command", scope: "session", version: 1, family: true,
	initial: () => ({ receipt: null, delivered: false }),
});
const EvolutionProblemDoc = defineDocFamily<{ admittedAt: number | null }, null>({
	kind: "dinobot.skill-evolution.problem", scope: "session", version: 1, family: true,
	initial: () => ({ admittedAt: null }),
});
export type EvolutionCommand = { readonly commandId: string } & (
	| { readonly op: "initialize"; readonly policy: EvolutionJobPolicy }
	| { readonly op: "enqueue"; readonly input: EvolutionJobInput; readonly overflow: "defer" | "drop" }
	| { readonly op: "claim"; readonly jobId: string; readonly worker: string }
	| { readonly op: "stage"; readonly lease: EvolutionLease; readonly stage: EvolutionStage }
	| { readonly op: "begin"; readonly lease: EvolutionLease }
	| { readonly op: "settle"; readonly lease: EvolutionLease; readonly spent: EvolutionBudget; readonly outcome: "completed" | "retry" | "failed"; readonly resultRef: string | null }
	| { readonly op: "reap"; readonly jobId: string }
	| { readonly op: "interrupt"; readonly lease: EvolutionLease }
	| { readonly op: "cancel"; readonly jobId: string }
	| { readonly op: "pause" | "kill" | "resume" }
	| { readonly op: "ack"; readonly receiptId: string }
);
export class EvolutionJobError extends Error {
	constructor(readonly code: "invalid" | "conflict" | "disabled" | "stale" | "budget" | "state", message: string) {
		super(message); this.name = "EvolutionJobError";
	}
}
function fail(code: EvolutionJobError["code"], message: string): never { throw new EvolutionJobError(code, message); }
function integer(value: number, name: string, positive = false): void {
	if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) fail("invalid", `${name} must be a safe ${positive ? "positive" : "nonnegative"} integer`);
}
function text(value: string, name: string): void {
	if (typeof value !== "string" || value.length === 0 || value.length > 512) fail("invalid", `${name} must contain 1..512 characters`);
}
function budget(value: EvolutionBudget, name: string, positive = false): void {
	for (const key of dimensions) integer(value[key], `${name}.${key}`, positive);
}
function fits(value: EvolutionBudget, limit: EvolutionBudget): boolean {
	return dimensions.every((key) => value[key] <= limit[key]);
}
function add(a: EvolutionBudget, b: EvolutionBudget): EvolutionBudget {
	const result = zero();
	for (const key of dimensions) { result[key] = a[key] + b[key]; integer(result[key], key); }
	return result;
}
function subtract(a: EvolutionBudget, b: EvolutionBudget): EvolutionBudget {
	const result = zero();
	for (const key of dimensions) { result[key] = a[key] - b[key]; integer(result[key], key); }
	return result;
}
function increment(value: number): number { integer(value + 1, "counter"); return value + 1; }
function copyReceipt(value: EvolutionReceipt): EvolutionReceipt {
	// Chord documents are tracked proxies, not structured-cloneable objects.
	return { ...value, lease: value.lease ? { ...value.lease } : null };
}
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object") {
		return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
	}
	const encoded = JSON.stringify(value);
	if (encoded === undefined) fail("invalid", "Command must be JSON");
	return encoded;
}
function digest(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
export function evolutionJobId(input: Pick<EvolutionJobInput, "evidenceWindow" | "problem" | "policyRevision">): string {
	return digest([input.evidenceWindow, input.problem, input.policyRevision]);
}
function policyValid(policy: EvolutionJobPolicy): void {
	text(policy.revision, "revision");
	integer(policy.maxPending, "maxPending", true); integer(policy.maxAttempts, "maxAttempts", true);
	if (policy.maxPending > 32 || policy.maxAttempts > 4) fail("invalid", "ADR0031 limits pending to 32 and attempts to 4");
	integer(policy.leaseMs, "leaseMs", true); integer(policy.cooldownMs, "cooldownMs");
	budget(policy.totalBudget, "totalBudget", true); budget(policy.maxJobBudget, "maxJobBudget", true);
	if (policy.maxJobBudget.calls > 8 || policy.maxJobBudget.tokens > 32_768 || policy.maxJobBudget.timeMs > 300_000) {
		fail("invalid", "Job limits exceed 8 calls, 32768 tokens, or 300000ms");
	}
	if (!fits(policy.maxJobBudget, policy.totalBudget)) fail("budget", "Job limit exceeds total budget");
	if (policy.windowMs !== undefined) integer(policy.windowMs, "windowMs", true);
}
/**
 * Window rollover at admission (enqueue/claim). Spent resets for the new window; outstanding
 * reservations carry over and keep counting against it, so spent + reserved <= totalBudget per window.
 */
function roll(queue: QueueState, policy: EvolutionJobPolicy, now: number): void {
	if (policy.windowMs === undefined) return;
	if (queue.windowStart === undefined) { queue.windowStart = now; return; }
	if (now < queue.windowStart + policy.windowMs) return;
	queue.windowStart = now - ((now - queue.windowStart) % policy.windowMs);
	queue.spent = zero();
}
function terminal(job: EvolutionJobState): boolean {
	return job.status === "completed" || job.status === "failed" || job.status === "cancelled";
}
function release(queue: QueueState, job: EvolutionJobState): void {
	if (!job.input) fail("state", "Job is uninitialized");
	queue.reserved = subtract(queue.reserved, subtract(job.input.budget, job.spent));
	queue.pending = queue.pending.filter((id) => id !== job.id);
	job.worker = null; job.leaseUntil = 0; job.reserved = zero();
}
function charge(queue: QueueState, job: EvolutionJobState, spent: EvolutionBudget): void {
	job.spent = add(job.spent, spent);
	queue.spent = add(queue.spent, spent);
	queue.reserved = subtract(queue.reserved, spent);
	job.reserved = zero(); job.worker = null; job.leaseUntil = 0;
}
function invalidate(queue: QueueState, job: EvolutionJobState, now: number, policy: EvolutionJobPolicy): void {
	// Unknown in-flight consumption is charged at the full frozen reservation, never refunded on crash/kill.
	charge(queue, job, job.reserved);
	job.fence = increment(job.fence);
	job.status = job.attempts >= policy.maxAttempts ? "failed" : "retry";
	if (job.input && !fits(job.input.attemptReservation, subtract(job.input.budget, job.spent))) job.status = "failed";
	job.notBefore = now + policy.cooldownMs; integer(job.notBefore, "notBefore");
	if (terminal(job)) release(queue, job);
}
function assertLease(queue: QueueState, job: EvolutionJobState, lease: EvolutionLease, now: number): void {
	if (queue.mode !== "running" || job.status !== "running" || job.worker !== lease.worker
		|| job.fence !== lease.fence || queue.epoch !== lease.epoch || job.epoch !== lease.epoch || now >= job.leaseUntil) {
		fail("stale", "Stale worker fence, epoch, or lease");
	}
}

/**
 * All writes, receipts and outbox payloads share the caller's single-writer Tx.
 * No arbitrary before/after-commit callbacks, model decisions or parent task updates.
 * `apply` is the narrow integration boundary for a host durable task or publication transaction.
 */
export class EvolutionJobs {
	constructor(private readonly session: Pick<Session, "commit" | "snapshot">, private readonly now: () => number) {}

	async execute(command: EvolutionCommand, context: Context): Promise<EvolutionReceipt> {
		// Copy before admission; caller mutation must not alter a queued commit/fingerprint.
		const copy: EvolutionCommand = structuredClone(command);
		return this.session.commit((tx) => this.apply(tx, copy, this.now()), context);
	}
	async job(id: string, context: Context): Promise<Readonly<EvolutionJobState> | undefined> {
		return this.session.snapshot(EvolutionJobDoc, id, context);
	}
	async status(context: Context) { return this.session.snapshot(EvolutionQueueDoc, context); }
	async outbox(commandId: string, context: Context) {
		const state = await this.session.snapshot(EvolutionCommandDoc, commandId, context);
		return state && !state.delivered ? state.receipt : null;
	}
	async apply(tx: Tx, command: EvolutionCommand, now: number): Promise<EvolutionReceipt> {
		text(command.commandId, "commandId");
		const fingerprint = digest(command);
		const receiptDoc = await tx.doc(EvolutionCommandDoc, command.commandId, command.commandId);
		if (receiptDoc.receipt) {
			if (receiptDoc.receipt.fingerprint !== fingerprint) fail("conflict", "Command ID reused with different input");
			return copyReceipt(receiptDoc.receipt);
		}
		integer(now, "clock");
		const queue = await tx.doc(EvolutionQueueDoc);
		if (now < queue.lastNow) fail("invalid", "Logical clock cannot move backwards");
		queue.lastNow = now;
		let outcome: EvolutionReceipt["outcome"] = "changed";
		let reason: string | null = null;
		let jobId: string | null = null;
		let lease: EvolutionLease | null = null;
		if (command.op === "initialize") {
			policyValid(command.policy);
			if (queue.policy && canonical(queue.policy) !== canonical(command.policy)) fail("conflict", "Queue policy is frozen");
			queue.policy = structuredClone(command.policy); outcome = "initialized";
			if (command.policy.windowMs !== undefined && queue.windowStart === undefined) queue.windowStart = now;
		} else {
			const policy = queue.policy;
			if (!policy) fail("disabled", "Required policy and budgets are not initialized");
			switch (command.op) {
				case "enqueue": {
					const input = command.input;
					text(input.evidenceWindow, "evidenceWindow"); text(input.problem, "problem");
					text(input.snapshot, "snapshot"); text(input.policyRevision, "policyRevision");
					integer(input.evidenceCutoff, "evidenceCutoff");
					if (input.evidenceCutoff > now) fail("invalid", "Evidence cutoff is in the future");
					budget(input.budget, "budget", true); budget(input.attemptReservation, "attemptReservation", true);
					if (input.policyRevision !== policy.revision) fail("conflict", "Policy revision mismatch");
					if (!fits(input.budget, policy.maxJobBudget) || !fits(input.attemptReservation, input.budget)) fail("budget", "Budget exceeds frozen limit");
					if (command.overflow !== "drop" && command.overflow !== "defer") fail("invalid", "Invalid overflow policy");
					roll(queue, policy, now);
					jobId = evolutionJobId(input);
					const job = await tx.doc(EvolutionJobDoc, jobId, jobId);
					if (job.input) {
						// Coalesce trigger coverage, never rewrite snapshot, cutoff or frozen budgets.
						job.coalesced = increment(job.coalesced);
						queue.coverage.coalesced = increment(queue.coverage.coalesced);
						outcome = "coalesced";
					} else {
						const problem = await tx.doc(EvolutionProblemDoc, digest(input.problem), null);
						if (queue.mode !== "running") reason = queue.mode;
						else if (problem.admittedAt !== null && now - problem.admittedAt < policy.cooldownMs) reason = "problem cooldown";
						else if (queue.pending.length >= policy.maxPending) reason = "capacity";
						else if (!fits(input.budget, subtract(subtract(policy.totalBudget, queue.spent), queue.reserved))) reason = "budget";
						if (reason) {
							outcome = command.overflow === "drop" ? "dropped" : "deferred";
							queue.coverage[outcome] = increment(queue.coverage[outcome]);
							// No unbounded deferred index. A projector retries under a NEW command ID.
							await tx.retireDoc(EvolutionJobDoc, jobId);
						} else {
							job.input = structuredClone(input); job.epoch = queue.epoch;
							queue.pending.push(jobId); queue.reserved = add(queue.reserved, input.budget);
							queue.coverage.accepted = increment(queue.coverage.accepted); outcome = "accepted";
							problem.admittedAt = now;
						}
					}
					break;
				}
				case "resume":
					queue.mode = "running"; break;
				case "pause":
				case "kill": {
					queue.mode = command.op === "kill" ? "killed" : "paused"; queue.epoch = increment(queue.epoch);
					for (const id of [...queue.pending]) {
						const job = await tx.doc(EvolutionJobDoc, id, id);
						if (job.status === "running") invalidate(queue, job, now, policy);
					}
					break;
				}
				case "ack": {
					text(command.receiptId, "receiptId");
					const target = await tx.doc(EvolutionCommandDoc, command.receiptId, command.receiptId);
					if (!target.receipt) fail("state", "Unknown receipt");
					target.delivered = true; outcome = "acknowledged"; break;
				}
				case "claim":
				case "stage":
				case "begin":
				case "settle":
				case "reap":
				case "interrupt":
				case "cancel": {
					jobId = "lease" in command ? command.lease.jobId : command.jobId;
					text(jobId, "jobId");
					const job = await tx.doc(EvolutionJobDoc, jobId, jobId);
					const input = job.input;
					if (!input) fail("state", "Unknown job");
					if (command.op === "claim") {
						text(command.worker, "worker");
						roll(queue, policy, now);
						if (queue.mode !== "running") fail("disabled", "Queue admission is paused or killed");
						if (job.status !== "pending" && job.status !== "retry") fail("state", "Job must be pending or reaped before claim");
						if (now < job.notBefore) fail("state", "Retry cooldown has not elapsed");
						if (job.attempts >= policy.maxAttempts) fail("budget", "Attempt cap reached");
						if (!fits(input.attemptReservation, subtract(input.budget, job.spent))) fail("budget", "Remaining job budget cannot fund attempt");
						for (const id of queue.pending) {
							if (id === jobId) continue;
							const other = await tx.doc(EvolutionJobDoc, id, id);
							if (other.status === "running") fail("state", "Research concurrency limit is one; reap expired work first");
						}
						job.fence = increment(job.fence); job.epoch = queue.epoch; job.attempts = increment(job.attempts);
						job.worker = command.worker; job.status = "running"; job.stage = "authoring";
						job.leaseUntil = now + policy.leaseMs; integer(job.leaseUntil, "leaseUntil");
						job.reserved = { ...input.attemptReservation };
						lease = { jobId, worker: command.worker, fence: job.fence, epoch: job.epoch }; outcome = "claimed";
					} else if (command.op === "reap") {
						if (job.status !== "running" || now < job.leaseUntil) fail("state", "Lease has not expired");
						invalidate(queue, job, now, policy);
					} else if (command.op === "cancel") {
						if (!terminal(job)) {
							charge(queue, job, job.reserved); job.fence = increment(job.fence);
							job.status = "cancelled"; release(queue, job);
						}
					} else if (command.op === "interrupt") {
						// Recovery can abandon its own expired lease, but can never abandon a newer worker.
						if (job.status !== "running" || job.fence !== command.lease.fence || job.epoch !== command.lease.epoch
							|| job.worker !== command.lease.worker) fail("stale", "Stale interruption");
						invalidate(queue, job, now, policy);
					} else {
						assertLease(queue, job, command.lease, now);
						if (command.op === "begin") {
							// Durable external-work intent, guarded just like a completion.
						} else if (command.op === "stage") {
							const next: Record<EvolutionStage, EvolutionStage | null> = { authoring: "evaluating", evaluating: "ready", ready: null };
							if (next[job.stage] !== command.stage) fail("state", "Invalid stage transition");
							job.stage = command.stage;
						} else {
							budget(command.spent, "spent");
							if (!fits(command.spent, job.reserved)) fail("budget", "Spent exceeds frozen attempt reservation");
							if (!["completed", "retry", "failed"].includes(command.outcome)) fail("invalid", "Invalid settlement");
							if (command.resultRef !== null) text(command.resultRef, "resultRef");
							if (command.outcome === "completed" && (job.stage !== "ready" || command.resultRef === null)) fail("state", "Completion requires ready stage and candidate/evidence reference");
							charge(queue, job, command.spent);
							job.resultRef = command.resultRef;
							job.status = command.outcome === "retry" && job.attempts >= policy.maxAttempts ? "failed" : command.outcome;
							if (job.status === "retry" && !fits(input.attemptReservation, subtract(input.budget, job.spent))) job.status = "failed";
							job.notBefore = now + policy.cooldownMs; integer(job.notBefore, "notBefore");
							if (terminal(job)) release(queue, job);
						}
					}
					break;
				}
				default: {
					const exhaustive: never = command;
					return exhaustive;
				}
			}
		}
		const receipt: EvolutionReceipt = { commandId: command.commandId, fingerprint, at: now, outcome, reason, jobId, lease };
		receiptDoc.receipt = receipt;
		return copyReceipt(receipt);
	}
}
