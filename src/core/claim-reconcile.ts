import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { defineDoc, type ConversationId, type Cursor, type Harness, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { observeNativeProcessQuiescence } from "@earendil-works/pi-durable/env/node";
import { ClaimsDoc, NATIVE_QUARANTINE_REASONS, unfence, type Claim } from "./claims.ts";
import { cleanupOwnerClaimsTx, NativeProvenanceDoc, OwnerClaimsDoc, type NativeCall } from "./claim-cleanup.ts";
import { RunDoc } from "./dag.ts";
import { WorkDoc, WorkspaceCoordDoc } from "./verification.ts";

/**
 * Operator reconciliation of native-process quarantines (ADR 0075). It resolves UNKNOWN native process calls only
 * when the OS proves every admitted process tree exited: an earlier canonical settlement, an empty POSIX process
 * group, a drained retained Windows job, or a Windows reboot after the recorded boot identity. Exit codes, vanished
 * PIDs, elapsed TTL and the caller's word are not evidence. The request must name exactly the closure of quarantined
 * tokens those calls hold (compare-and-swap), and the commit re-verifies that nothing changed since.
 *
 * Tokens are then released by the authority that owns them. A token held by a DAG node is handed back to that node's
 * own cleanup (cleanupOwnerClaimsTx), which re-checks runner, task, effect and lease quiescence. Any other token is
 * unfenced only if its only recorded cause was native process provenance; any other cause refuses the request.
 * Unfencing ends the fence, not the lease (ADR 0079): a token whose lease ended (TTL or work_release) is released, one
 * still leased stays with its holder exactly as canonical settlement would have left it.
 *
 * The same gate runs automatically (autoReconcile) whenever a claim attempt meets a fenced blocker and when a holder
 * releases a fenced claim. Automation adds no authority: it only submits the exact closure the report already proves.
 */
export { NATIVE_QUARANTINE_REASONS };
export const AUTO_RECONCILE_ACTOR = "dinobot:auto-reconcile";
export const MAX_ACTOR_LENGTH = 200;
export const MAX_NOTE_LENGTH = 2000;

export type Evidence = { state: "quiescent" | "alive" | "unknown"; evidence: string };
export type ObserveQuiescence = (started: unknown) => Promise<Evidence>;
export type TokenRef = { key: string; holder: string; token: number };
export type QuarantinedProcess = { nonce: string; pid: number | null; startTime: string | null; boot?: string; evidence: Evidence };
export type QuarantinedCall = { conversationId: number; taskId: string; kind: string; task: "terminal" | "running" | "missing"; tokens: TokenRef[]; processes: QuarantinedProcess[]; blockers: string[] };
export type QuarantinedClaim = { claim: Claim; release: "direct" | "owner-cleanup"; reconcilable: boolean; blockers: string[]; next: string; required: TokenRef[]; calls: { conversationId: number; taskId: string }[] };
export type QuarantineReport = { quarantined: QuarantinedClaim[]; calls: QuarantinedCall[] };
export type ReconcileRequest = { tokens: TokenRef[]; actor: string; note: string };
export type ReconcileResult =
	/** released: gone; unfenced: fence cleared, still held under its own lease; retained: still fenced (owner decides). */
	| { status: "reconciled"; released: Claim[]; unfenced: Claim[]; retained: Claim[]; calls: QuarantinedCall[] }
	| { status: "refused"; error: string; blockers: string[]; required?: TokenRef[]; calls: QuarantinedCall[] };

/** Session audit trail of operator reconciliations, newest last. */
export const ClaimReconcileAuditDoc = defineDoc<{ entries: { at: number; actor: string; note: string; released: Claim[]; unfenced?: Claim[]; retained: Claim[]; calls: { conversationId: number; taskId: string; evidence: { nonce: string; evidence: string }[] }[] }[] }>({
	kind: "dinobot.claims.reconcile-audit", version: 1, scope: "session", initial: () => ({ entries: [] }),
});

const same = (a: TokenRef, b: TokenRef) => a.key === b.key && a.holder === b.holder && a.token === b.token;
const ref = (claim: TokenRef): TokenRef => ({ key: claim.key, holder: claim.holder, token: claim.token });
const sortRefs = (refs: TokenRef[]) => [...refs].sort((a, b) => a.token - b.token || a.key.localeCompare(b.key) || a.holder.localeCompare(b.holder));

type Owner = { conversationId: number; runId: string; nodeId: string; runnerId: string; attempt: number };
type Journal = {
	claims: Claim[];
	/** UNKNOWN calls: the ones reconcile can resolve. */
	calls: { conversationId: ConversationId; call: NativeCall; task: QuarantinedCall["task"] }[];
	/** Every recorded snapshot of a quarantined token in any call of any phase: its provenance. */
	snapshots: { token: TokenRef; quarantined: string | undefined }[];
	owners: { token: TokenRef; owner: Owner }[];
};

/** Every quarantined claim, its provenance and owners, and every UNKNOWN native call, read in one transaction. */
async function readJournalTx(tx: Tx): Promise<Journal> {
	const claims = (await tx.doc(ClaimsDoc)).claims.filter(claim => claim.quarantined !== undefined).map(claim => ({ ...claim }));
	const held = (token: TokenRef) => claims.some(claim => same(claim, token));
	const journal: Journal = { claims, calls: [], snapshots: [], owners: [] };
	let cursor: Cursor | undefined;
	do {
		const page = await tx.scanConversations({}, 128, cursor);
		for (const conversation of page.items) {
			for (const call of (await tx.doc(NativeProvenanceDoc, conversation.id)).calls) {
				for (const token of [...call.tokens, ...(call.acquiredTokens ?? [])]) if (held(token)) journal.snapshots.push({ token: ref(token), quarantined: token.quarantined });
				if (call.phase !== "unknown") continue;
				const task = Number.isSafeInteger(Number(call.taskId)) ? await tx.task(Number(call.taskId) as TaskId) : undefined;
				journal.calls.push({ conversationId: conversation.id, call: JSON.parse(JSON.stringify(call)) as NativeCall, task: task === undefined ? "missing" : task.state.status === "terminal" ? "terminal" : "running" });
			}
			for (const owned of (await tx.doc(OwnerClaimsDoc, conversation.id)).claims) if (held(owned.claim)) {
				journal.owners.push({ token: ref(owned.claim), owner: { conversationId: Number(conversation.id), runId: owned.runId, nodeId: owned.nodeId, runnerId: owned.runnerId, attempt: owned.attempt } });
			}
		}
		cursor = page.next;
	} while (cursor);
	return journal;
}

/** Per-call OS evidence. A nonce already settled canonically keeps that receipt; nothing else is inferred. */
async function assess(journal: Journal, observe: ObserveQuiescence): Promise<QuarantinedCall[]> {
	return Promise.all(journal.calls.map(async ({ conversationId, call, task }) => {
		const events = call.processes ?? [];
		const processes: QuarantinedProcess[] = await Promise.all(events.filter(e => e.phase === "admitted").map(async admitted => {
			const started = events.find(e => e.phase === "started" && e.nonce === admitted.nonce);
			const settled = events.find(e => e.phase === "settled" && e.nonce === admitted.nonce);
			const evidence: Evidence = settled?.canonical
				? { state: "quiescent", evidence: "canonical settlement receipt" }
				: started ? await observe(started).catch(error => ({ state: "unknown" as const, evidence: "observation failed: " + String(error) })) : { state: "unknown", evidence: "no recorded process identity" };
			return { nonce: admitted.nonce, pid: started?.pid ?? null, startTime: started?.startTime ?? null, ...(started?.boot ? { boot: started.boot } : {}), evidence };
		}));
		const blockers: string[] = [];
		if (call.kind !== "process") blockers.push(`${call.kind} has no OS evidence; only native process calls are reconcilable`);
		if (task === "running") blockers.push(`task ${call.taskId} is still running`);
		if (task === "missing") blockers.push(`task ${call.taskId} was not found`);
		if (call.kind === "process" && !processes.length) blockers.push("no admitted process was recorded");
		for (const process of processes) if (process.evidence.state !== "quiescent") blockers.push(`process ${process.pid ?? "?"} (${process.nonce}): ${process.evidence.state}, ${process.evidence.evidence}`);
		return { conversationId: Number(conversationId), taskId: call.taskId, kind: call.kind, task, tokens: call.tokens.map(ref), processes, blockers };
	}));
}

/** The exact quarantined tokens and UNKNOWN calls that must be resolved together, starting from `seed`. */
function closure(journal: Journal, seed: TokenRef[]): { tokens: TokenRef[]; calls: number[] } {
	const tokens = journal.claims.filter(claim => seed.some(token => same(claim, token))).map(ref);
	const calls = new Set<number>();
	for (let grew = true; grew;) {
		grew = false;
		journal.calls.forEach(({ call }, index) => {
			const refs = [...call.tokens, ...(call.acquiredTokens ?? [])];
			if (calls.has(index) || !refs.some(token => tokens.some(held => same(held, token)))) return;
			calls.add(index); grew = true;
			for (const token of refs) {
				const held = journal.claims.find(claim => same(claim, token));
				if (held && !tokens.some(t => same(t, held))) tokens.push(ref(held));
			}
		});
	}
	return { tokens: sortRefs(tokens), calls: [...calls].sort((a, b) => a - b) };
}

/** Why a token itself (apart from its calls' evidence) cannot be released by this request. */
function tokenBlockers(journal: Journal, token: TokenRef): string[] {
	const claim = journal.claims.find(c => same(c, token))!;
	if (journal.owners.some(o => same(o.token, token))) return []; // the owning DAG node's cleanup decides
	const blockers: string[] = [];
	if (!NATIVE_QUARANTINE_REASONS.includes(claim.quarantined!)) blockers.push(`token ${claim.token} is quarantined by "${claim.quarantined}", not native process provenance`);
	const snapshots = journal.snapshots.filter(s => same(s.token, token));
	if (!snapshots.length) blockers.push(`token ${claim.token} has no recorded native call`);
	for (const reason of new Set(snapshots.map(s => s.quarantined).filter(r => r !== undefined && !NATIVE_QUARANTINE_REASONS.includes(r)))) blockers.push(`token ${claim.token} was earlier quarantined by "${reason}"`);
	return blockers;
}

function nextStep(release: QuarantinedClaim["release"], blockers: string[], required: TokenRef[]): string {
	if (!blockers.length) return `Proven quiescent: the next contending claim or release reconciles it automatically, or POST /v1/claims/quarantine/reconcile naming tokens ${required.map(t => t.token).join(", ")}${release === "owner-cleanup" ? "; the owning DAG node's cleanup then decides the release" : ""}.`;
	if (blockers.some(b => b.includes(": alive,"))) return "A process from the recorded tree is still running. Let it finish or stop it, then reconcile again.";
	if (blockers.some(b => b.includes("still running"))) return "Wait for the task to finish, then reconcile again.";
	if (blockers.some(b => b.includes("external:") || b.includes("no retained job and no recorded boot identity") || b.includes("no recorded process identity"))) return "Historical uncertainty: the current runtime cannot reconstruct missing process/driver identity. Reboot, terminal status, PID absence and notes are not proof. Keep quarantined, or use the offline audited abandonment procedure with explicit operator risk acceptance (not canonical quiescence).";
	if (blockers.some(b => b.includes("not native process provenance") || b.includes("was earlier quarantined by") || b.includes("no recorded native call"))) return "Not a native-process quarantine. It is released by the cleanup of whatever recorded it once that is proven quiescent.";
	return "No OS evidence proves the recorded tree exited. It stays quarantined; a reboot after the recorded boot identity (Windows) or an empty process group (POSIX) is the remaining proof.";
}

function report(journal: Journal, calls: QuarantinedCall[]): QuarantineReport {
	return {
		calls,
		quarantined: journal.claims.map(claim => {
			const scope = closure(journal, [claim]);
			const blockers = [...new Set([
				...scope.tokens.flatMap(token => tokenBlockers(journal, token)),
				...scope.calls.flatMap(index => calls[index]!.blockers.map(b => `task ${calls[index]!.taskId}: ${b}`)),
			])];
			const release = journal.owners.some(o => same(o.token, claim)) ? "owner-cleanup" as const : "direct" as const;
			return { claim, release, reconcilable: blockers.length === 0, blockers, next: nextStep(release, blockers, scope.tokens), required: scope.tokens, calls: scope.calls.map(index => ({ conversationId: calls[index]!.conversationId, taskId: calls[index]!.taskId })) };
		}),
	};
}

/** Read-only diagnosis: why each claim is quarantined and the safe next action. */
export async function quarantineReport(harness: Harness, context: Context, observe: ObserveQuiescence = observeNativeProcessQuiescence): Promise<QuarantineReport> {
	const journal = await harness.commit(tx => readJournalTx(tx), context);
	return report(journal, await assess(journal, observe));
}

const fingerprint = (journal: Journal, scope: { tokens: TokenRef[]; calls: number[] }) => JSON.stringify([
	scope.tokens.map(token => [journal.claims.find(claim => same(claim, token)), journal.snapshots.filter(s => same(s.token, token)), journal.owners.filter(o => same(o.token, token))]),
	scope.calls.map(index => { const { conversationId, call, task } = journal.calls[index]!; return [conversationId, call, task]; }),
]);

/** Re-run the owning DAG node's own terminal cleanup, exactly as its run settlement would. */
async function replayOwnerCleanupTx(tx: Tx, owner: Owner, candidates: readonly TokenRef[]): Promise<void> {
	const id = owner.conversationId as ConversationId;
	const parent = (await tx.doc(WorkDoc, id)).dagParent;
	if (!parent || parent.runId !== owner.runId || parent.nodeId !== owner.nodeId || parent.runnerId !== owner.runnerId || parent.attempt !== owner.attempt) return;
	const run = (await tx.doc(RunDoc, Number(parent.conversationId) as ConversationId)).runs.find(r => r.id === owner.runId);
	const node = run?.nodes[owner.nodeId];
	// Scheduling attempts are mutable under replan; cleanup checks the retained execution binding.
	if (!node || node.runnerId !== owner.runnerId || node.status === "running" || node.status === "waiting") return;
	await cleanupOwnerClaimsTx(tx, id, owner.runId, owner.nodeId, node, candidates);
}

export async function reconcileQuarantine(harness: Harness, request: ReconcileRequest, context: Context, observe: ObserveQuiescence = observeNativeProcessQuiescence, now = Date.now): Promise<ReconcileResult> {
	const actor = request.actor.trim(); const note = request.note.trim();
	if (!actor || !note || actor.length > MAX_ACTOR_LENGTH || note.length > MAX_NOTE_LENGTH) return { status: "refused", error: "actor_and_note_required", blockers: [`actor (1-${MAX_ACTOR_LENGTH} chars) and note (1-${MAX_NOTE_LENGTH} chars) are required for the audit record`], calls: [] };
	if (!request.tokens.length) return { status: "refused", error: "tokens_required", blockers: ["name the exact quarantined tokens to release"], calls: [] };
	const journal = await harness.commit(tx => readJournalTx(tx), context);
	const requested = sortRefs(request.tokens.map(ref));
	const missing = requested.filter(token => !journal.claims.some(claim => same(claim, token)));
	if (missing.length) return { status: "refused", error: "token_mismatch", blockers: missing.map(t => `token ${t.token} (${t.key} held by ${t.holder}) is not a current quarantined claim`), calls: [] };
	const scope = closure(journal, requested);
	const calls = await assess(journal, observe);
	const scoped = scope.calls.map(index => calls[index]!);
	if (JSON.stringify(scope.tokens) !== JSON.stringify(requested)) return { status: "refused", error: "token_set_mismatch", blockers: ["the quarantine closure differs from the requested tokens; name exactly the required set"], required: scope.tokens, calls: scoped };
	const blockers = [...new Set(report(journal, calls).quarantined.filter(entry => requested.some(token => same(entry.claim, token))).flatMap(entry => entry.blockers))];
	if (blockers.length) return { status: "refused", error: "not_proven_quiescent", blockers, required: scope.tokens, calls: scoped };
	const expected = fingerprint(journal, scope);
	return harness.commit(async tx => {
		const current = await readJournalTx(tx);
		const again = closure(current, requested);
		if (JSON.stringify(again.tokens) !== JSON.stringify(requested) || fingerprint(current, again) !== expected) {
			return { status: "refused" as const, error: "changed_during_reconcile", blockers: ["claims or native journal changed after the evidence was gathered; inspect and retry"], required: again.tokens, calls: scoped };
		}
		const at = now();
		const reconciledCalls = again.calls.map(index => current.calls[index]!);
		for (const { conversationId, call } of reconciledCalls) {
			const doc = await tx.doc(NativeProvenanceDoc, conversationId);
			const target = doc.calls.find(c => c.taskId === call.taskId && c.kind === call.kind && c.phase === "unknown")!;
			target.phase = "reconciled";
			target.reconciled = { at, actor, note, evidence: scoped.find(c => c.conversationId === Number(conversationId) && c.taskId === call.taskId)!.processes.map(p => ({ nonce: p.nonce, evidence: p.evidence.evidence })) };
		}
		const coord = await tx.doc(WorkspaceCoordDoc);
		coord.leases = coord.leases.filter(lease => !reconciledCalls.some(({ call }) => lease.id === "native:" + call.taskId + ":" + call.kind));
		const claims = await tx.doc(ClaimsDoc);
		const before = claims.claims.filter(claim => requested.some(token => same(claim, token))).map(claim => ({ ...claim }));
		const direct = requested.filter(token => !current.owners.some(o => same(o.token, token)));
		for (const token of direct) unfence(claims, token, at);
		const owners = current.owners.filter(o => requested.some(token => same(o.token, token))).map(o => o.owner);
		for (const owner of owners.filter((o, i) => owners.findIndex(p => JSON.stringify(p) === JSON.stringify(o)) === i)) await replayOwnerCleanupTx(tx, owner, requested);
		const remaining = (await tx.doc(ClaimsDoc)).claims;
		const released = before.filter(claim => !remaining.some(c => same(c, claim)));
		const kept = remaining.filter(claim => requested.some(token => same(claim, token))).map(claim => ({ ...claim }));
		const retained = kept.filter(claim => claim.quarantined !== undefined);
		const unfenced = kept.filter(claim => claim.quarantined === undefined);
		(await tx.doc(ClaimReconcileAuditDoc)).entries.push({ at, actor, note, released, unfenced, retained, calls: scoped.map(c => ({ conversationId: c.conversationId, taskId: c.taskId, evidence: c.processes.map(p => ({ nonce: p.nonce, evidence: p.evidence.evidence })) })) });
		return { status: "reconciled" as const, released, unfenced, retained, calls: scoped };
	}, context);
}

/** Deliberately not a quiescence assertion. Only the offline maintenance command exposes this operation. */
export const ABANDONMENT_ACCEPTANCE = "I accept unproven historical process and computer-use effects; abandon this exact quarantine without claiming quiescence";
export type AbandonRequest = ReconcileRequest & { snapshot: string; acceptance: string };
export const ClaimAbandonAuditDoc = defineDoc<{ entries: { at: number; actor: string; note: string; snapshot: string; acceptance: string; waived: string[]; released: Claim[]; calls: { conversationId: number; call: NativeCall }[] }[] }>({ kind: "dinobot.claims.abandon-audit", version: 1, scope: "session", initial: () => ({ entries: [] }) });
const isExternalReason = (reason: string) => reason.startsWith("UNKNOWN native external:") && reason.endsWith(" provenance");
const legacyReason = (reason: string) => NATIVE_QUARANTINE_REASONS.includes(reason) || isExternalReason(reason);

/** Include every task in the affected conversations and their owned descendants, plus all affected leases. */
async function maintenanceStateTx(tx: Tx, journal: Journal, scope: ReturnType<typeof closure>) {
 const pending = scope.calls.map(i => journal.calls[i]!.conversationId);
 const seen = new Set<ConversationId>();
 const tasks: { id: number; status: string }[] = [];
 while (pending.length) {
  const id = pending.pop()!; if (seen.has(id)) continue; seen.add(id);
  let cursor: Cursor | undefined;
  do {
   const page = await tx.scanTasks({ conversationId: id }, 128, cursor);
   for (const task of page.items) {
    tasks.push({ id: Number(task.id), status: task.state.status });
    let children: Cursor | undefined;
    do { const owned = await tx.scanConversations({ ownerTaskId: task.id }, 128, children); pending.push(...owned.items.map(c => c.id)); children = owned.next; } while (children);
   }
   cursor = page.next;
  } while (cursor);
 }
 const leases = (await tx.doc(WorkspaceCoordDoc)).leases.filter(l => seen.has(Number(l.conversationId) as ConversationId)).map(l => ({ ...l }));
 return { tasks: tasks.sort((a, b) => a.id - b.id), leases };
}

async function abandonmentJournal(harness: Harness, tokens: TokenRef[], context: Context) {
 return harness.commit(async tx => {
  const journal = await readJournalTx(tx); const scope = closure(journal, tokens);
  return { journal, scope, maintenance: await maintenanceStateTx(tx, journal, scope) };
 }, context);
}
const abandonmentSnapshot = (state: Awaited<ReturnType<typeof abandonmentJournal>>) => createHash("sha256").update(JSON.stringify([fingerprint(state.journal, state.scope), state.maintenance])).digest("hex");

function abandonmentBlockers(state: Awaited<ReturnType<typeof abandonmentJournal>>, requested: TokenRef[], calls: QuarantinedCall[]) {
 const { journal, scope, maintenance } = state; const blockers: string[] = [];
 if (!requested.length || JSON.stringify(sortRefs(requested.map(ref))) !== JSON.stringify(scope.tokens)) blockers.push("token_set_mismatch: name the exact current quarantine closure");
 if (!scope.calls.length) blockers.push("no recorded UNKNOWN call");
 for (const token of scope.tokens) {
  const claim = journal.claims.find(c => same(c, token))!;
  // Every released token must have its own assessed UNKNOWN provenance; a valid sibling cannot authorize it.
  if (!scope.calls.some(i => { const call = journal.calls[i]!.call; return [...call.tokens, ...(call.acquiredTokens ?? [])].some(t => same(t, token)); })) blockers.push(`token ${token.token} has no recorded UNKNOWN call`);
  if (journal.owners.some(o => same(o.token, token))) blockers.push("DAG-owned tokens cannot be abandoned by maintenance");
  if (!legacyReason(claim.quarantined!)) blockers.push("unsupported quarantine cause");
  for (const snapshot of journal.snapshots.filter(s => same(s.token, token))) if (snapshot.quarantined && !legacyReason(snapshot.quarantined)) blockers.push("unsupported earlier quarantine cause");
 }
 for (const index of scope.calls) {
  const call = calls[index]!;
  if (call.task !== "terminal") blockers.push(`task ${call.taskId} is ${call.task}`);
  if (call.kind !== "process" && !call.kind.startsWith("external:")) blockers.push(`unsupported call kind ${call.kind}`);
  if (call.kind === "process" && !call.processes.length) blockers.push("no admitted process was recorded");
  for (const p of call.processes) {
   if (p.evidence.state === "alive") blockers.push(`process ${p.nonce} is still alive`);
   // Only the specific legacy evidence gap is waivable. Modern evidence errors cannot be bypassed.
   if (p.evidence.state === "unknown" && (p.boot || p.evidence.evidence !== "no retained job and no recorded boot identity")) blockers.push(`process ${p.nonce}: non-legacy or failed observation`);
  }
 }
 for (const task of maintenance.tasks) if (task.status !== "terminal") blockers.push(`related task ${task.id} is still ${task.status}`);
 const nativeLeases = scope.calls.map(i => { const c = journal.calls[i]!.call; return "native:" + c.taskId + ":" + c.kind; });
 for (const lease of maintenance.leases) if (lease.phase !== "quiescent" && !nativeLeases.includes(lease.id)) blockers.push(`unresolved unrelated lease ${lease.id}`);
 return [...new Set(blockers)];
}

export async function planQuarantineAbandonment(harness: Harness, tokens: TokenRef[], context: Context, observe: ObserveQuiescence = observeNativeProcessQuiescence) {
 const state = await abandonmentJournal(harness, tokens, context); const calls = await assess(state.journal, observe);
 return { snapshot: abandonmentSnapshot(state), required: state.scope.tokens, blockers: abandonmentBlockers(state, tokens, calls), calls: state.scope.calls.map(i => calls[i]!), acceptance: ABANDONMENT_ACCEPTANCE };
}

/** Caller must own an exclusive database lock with scheduling disabled; never register as a model/channel tool. */
export async function abandonQuarantine(harness: Harness, request: AbandonRequest, context: Context, observe: ObserveQuiescence = observeNativeProcessQuiescence, now = Date.now) {
 const actor = request.actor.trim(); const note = request.note.trim();
 if (!actor || !note || actor.length > MAX_ACTOR_LENGTH || note.length > MAX_NOTE_LENGTH) return { status: "refused" as const, error: "actor_and_note_required" };
 if (request.acceptance !== ABANDONMENT_ACCEPTANCE || !/^[a-f0-9]{64}$/.test(request.snapshot)) return { status: "refused" as const, error: "explicit_risk_acceptance_required" };
 const state = await abandonmentJournal(harness, request.tokens, context);
 if (abandonmentSnapshot(state) !== request.snapshot) return { status: "refused" as const, error: "snapshot_mismatch" };
 const calls = await assess(state.journal, observe);
 const blockers = abandonmentBlockers(state, request.tokens, calls);
 if (blockers.length) return { status: "refused" as const, error: "not_abandonable", blockers };
 const waived = [...new Set(state.scope.calls.flatMap(i => {
  const c = calls[i]!;
  return c.kind.startsWith("external:") ? [c.kind + " was interrupted before the host saw it return"] : c.processes.filter(p => p.evidence.state === "unknown").map(p => `${p.nonce}: ${p.evidence.evidence}`);
 }))];
 return harness.commit(async tx => {
  const journal = await readJournalTx(tx); const scope = closure(journal, request.tokens);
  const current = { journal, scope, maintenance: await maintenanceStateTx(tx, journal, scope) };
  if (abandonmentSnapshot(current) !== request.snapshot) return { status: "refused" as const, error: "changed_during_abandonment" };
  const at = now();
  const originals = scope.calls.map(i => ({ conversationId: Number(journal.calls[i]!.conversationId), call: journal.calls[i]!.call }));
  for (const index of scope.calls) {
   const { conversationId, call } = journal.calls[index]!;
   const target = (await tx.doc(NativeProvenanceDoc, conversationId)).calls.find(c => c.taskId === call.taskId && c.kind === call.kind && c.phase === "unknown")!;
   target.phase = "abandoned";
   target.abandoned = { at, actor, note, snapshot: request.snapshot, acceptance: request.acceptance, waived };
  }
  const claims = await tx.doc(ClaimsDoc);
  const released = claims.claims.filter(c => scope.tokens.some(t => same(c, t))).map(c => ({ ...c }));
  claims.claims = claims.claims.filter(c => !scope.tokens.some(t => same(c, t)));
  const coord = await tx.doc(WorkspaceCoordDoc);
  coord.leases = coord.leases.filter(l => !originals.some(({ call }) => l.id === "native:" + call.taskId + ":" + call.kind));
  (await tx.doc(ClaimAbandonAuditDoc)).entries.push({ at, actor, note, snapshot: request.snapshot, acceptance: request.acceptance, waived, released, calls: originals });
  return { status: "abandoned" as const, released, waived, canonicalQuiescence: false as const };
 }, context);
}

export type AutoReconcileResult = { released: Claim[]; unfenced: Claim[]; blockers: string[] };
/**
 * Evidence-gated reconcile of the fenced closures containing `seeds`, with no operator. Each closure goes through
 * reconcileQuarantine with exactly the token set the report requires, so every gate (OS quiescence of every recorded
 * process, terminal task, native-only causes, owner cleanup, compare-and-swap) applies unchanged. A closure that is not
 * proven, or that changed or vanished concurrently, is left as it is and reported in `blockers`. Never throws for a
 * refusal; a failure to observe is a blocker, not a release.
 */
export async function autoReconcile(harness: Harness, seeds: readonly TokenRef[], note: string, context: Context, observe: ObserveQuiescence = observeNativeProcessQuiescence): Promise<AutoReconcileResult> {
	const result: AutoReconcileResult = { released: [], unfenced: [], blockers: [] };
	if (!seeds.length) return result;
	const report = await quarantineReport(harness, context, observe);
	const done = new Set<string>();
	for (const entry of report.quarantined) {
		if (!seeds.some(seed => same(seed, entry.claim))) continue;
		const id = JSON.stringify(entry.required);
		if (done.has(id)) continue;
		done.add(id);
		if (!entry.reconcilable) { result.blockers.push(...entry.blockers.map(b => `token ${entry.claim.token}: ${b}`)); continue; }
		const outcome = await reconcileQuarantine(harness, { tokens: entry.required, actor: AUTO_RECONCILE_ACTOR, note }, context, observe);
		if (outcome.status === "reconciled") { result.released.push(...outcome.released); result.unfenced.push(...outcome.unfenced); }
		else result.blockers.push(...outcome.blockers.map(b => `token ${entry.claim.token}: ${b}`));
	}
	return result;
}
