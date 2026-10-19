import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { Context } from "@earendil-works/chord";
import { AgentDoc, defineDoc, defineTask, LiveDoc, type ConversationId, type Harness, type TaskId, type ToolExecutionApi, type Tx } from "@earendil-works/pi-durable";
import type { NativeProcessEvent } from "@earendil-works/pi-durable/env";
import { canonical, digest, executeCheck, fingerprint, inside, nativeSettled, type CheckMethod, type CheckObligation, type HostStoragePaths, type InputScope, type ProcessObservation } from "./verification-execution.ts";
export type { CheckMethod, CheckObligation, HostStoragePaths, InputScope } from "./verification-execution.ts";
import { clone } from "./json.ts";
import { admitUnknownNativeCall, nativeProcessApi } from "./claim-cleanup.ts";
import { RunDoc } from "./dag.ts";
import { VisibleExportsDoc, validateVisibleExport, type VisibleExport } from "./visible-export.ts";

export type AcceptanceContract = {
	requirements: { id: string; assertion: string; checkIds: string[]; scenarioIds: string[] }[];
	scenarios: { id: string; assertion: string }[];
	checks: CheckObligation[];
};
export type SourceDisposition = { kind: "unresolved" } | { kind: "informational"; rationale: string } | { kind: "linked"; workId: string; contractHash: string; version: number };
export type MethodRecord = { revision: number; method: CheckMethod; hash: string; rationale: string; priorAttemptIds: string[]; taskId: string; at: number };
export type Certificate = { id: string; workId: string; sourceIds: string[]; contractHash: string; version: number; methodEpoch: number; mutationEpoch: number; fingerprint: string; evidenceIds: string[]; at: number; limitations: string[] };
export type Work = {
	id: string; state: "planning" | "implementing" | "verifying" | "verified" | "blocked" | "cancelled";
	version: number; contract: AcceptanceContract; contractHash: string; scope: InputScope; hostHash: string;
	methodEpoch: number; mutationEpoch: number; methods: Record<string, MethodRecord[]>;
	sourceIds: string[]; costs: { attempts: number; repairs: number; seconds: number; coaching: number; slots: string[] };
	noProgress: Record<string, number>; operations: Record<string, string>; blockers: string[]; certificate?: Certificate;
	certificates?: Certificate[];
	children?: { conversationId: string; runnerTaskId: string }[];
};
export type Evidence = {
	id: string; taskId: string; checkId: string; workId: string; status: "admitted" | "running" | "passed" | "failed" | "unknown" | "cancelled";
	contractHash: string; version: number; methodEpoch: number; methodHash: string; mutationEpoch: number;
	before: string; after: string; signature: string; timeout: number; observation?: ProcessObservation; error?: string;
};
export type GoalSource = { sourceId: string; entryId: number; text: string; hash: string; assertion: string; at: number; predicate?: { kind: "full-visible-export"; root: number } };
export type HumanGoal = { epoch: number; hash: string; sources: GoalSource[]; amendments: { sourceId: string; assertion: string; hash: string; at: number }[]; exportAcceptance?: { epoch: number; hash: string; snapshotId: string; inputHash: string }; acceptance?: { epoch: number; hash: string; sourceId: string; inputHash: string; at: number } };
function exportPredicate(text:string):GoalSource["predicate"] {
 try{const spec=JSON.parse(text.replace(/^<from[^>]*>\n/,""));const p=spec.dinobotGoal;if(Object.keys(spec).length!==1||!p||Object.keys(p).sort().join(",")!=="kind,root"||p.kind!=="full-visible-export"||!Number.isSafeInteger(p.root))return undefined;return {kind:p.kind,root:p.root};}catch{return undefined;}
}
export function goalHash(goal: HumanGoal): string { return digest({sources:goal.sources,amendments:goal.amendments}); }
export function goalInputHash(state: WorkState, exclude?:string):string {return digest((state.humanInputs??[]).filter(i=>i.sourceId!==exclude));}
export function validGoalSources(state:WorkState):boolean {
 const goal=state.goal;if(!goal||goalHash(goal)!==goal.hash||!goal.sources.length)return false;
 for(const s of goal.sources){if(s.hash!==digest(s.text)||s.assertion!==s.text||!state.humanInputs?.some(i=>i.sourceId===s.sourceId&&i.entryId===s.entryId&&i.text===s.text&&i.hash===s.hash))return false;
  if(s.predicate){const p=exportPredicate(s.text);if(p?.kind!==s.predicate.kind||p.root!==s.predicate.root)return false;}
 }
 for(const amendment of goal.amendments){const source=state.humanInputs?.find(i=>i.sourceId===amendment.sourceId);if(!source||source.hash!==digest(source.text)||amendment.hash!==digest(amendment.assertion))return false;try{if(JSON.parse(source.text.replace(/^<from[^>]*>\n/,""))?.dinobotGoalAmendment?.assertion!==amendment.assertion)return false;}catch{return false;}}
 return true;
}
export function validHumanAcceptance(state: WorkState): boolean {
 const goal=state.goal;if(!goal || !validGoalSources(state))return false;
 const acceptance=goal.acceptance;if(!acceptance||acceptance.epoch!==goal.epoch||acceptance.hash!==goal.hash||acceptance.inputHash!==goalInputHash(state,acceptance.sourceId))return false;
 const source=state.humanInputs?.find(i=>i.sourceId===acceptance.sourceId);if(!source||source.hash!==digest(source.text))return false;
 try{const command=JSON.parse(source.text.replace(/^<from[^>]*>\n/,""))?.dinobotGoalAcceptance;return command?.epoch===goal.epoch && command.hash===goal.hash;}catch{return false;}
}
export type WorkState = { /** Display-only host live input groups; never goal or acceptance evidence. */ displayInputGroups?: string[][]; /** Host input timestamps for DAG display scope only, not goal authority. */ inputTimes?: Record<string, { entryId: number; at: number }>; admissionEvents?: string[]; lastGoalHead?: number; humanInputs?: GoalSource[]; goal?: HumanGoal; goalParent?: { conversationId: string; epoch: number; hash: string }; dagParent?: { conversationId:string; runId:string; nodeId:string; runnerId:string; attempt:number }; works: Work[]; sources: Record<string, SourceDisposition>; activeId?: string; parent?: { conversationId: string; workId: string } };
function joinDisplayInputs(state: WorkState, inputs: readonly string[]): void {
 if (inputs.length < 2) return;
 const joined = new Set(inputs), keep: string[][] = [];
 // Groups are disjoint. Only host-observed groups reach this display-only merge.
 for (const group of state.displayInputGroups ?? []) {
  if (group.some(id => joined.has(id))) for (const id of group) joined.add(id);
  else keep.push([...group]);
 }
 state.displayInputGroups = [...keep, [...joined]];
}
export async function syncGoalHeadTx(tx:Tx,conversationId:ConversationId,state:WorkState):Promise<void> {
 const head=await tx.latestHeadMarker(conversationId);if(state.goal && head?.kind==="pi.reset" && state.lastGoalHead!==head.id){state.lastGoalHead=head.id;state.goal.epoch++;delete state.goal.acceptance;delete state.goal.exportAcceptance;}
}
export async function assertGoalAdmissionTx(tx:Tx,conversationId:ConversationId, seen=new Set<ConversationId>()):Promise<void> {
 if(seen.has(conversationId)) throw new Error("stale_goal_admission_epoch");
 seen.add(conversationId);
 const state=await tx.doc(WorkDoc,conversationId);
 if(state.dagParent) {
  const binding=state.dagParent;const parentId=Number(binding.conversationId) as ConversationId;
  const run=(await tx.doc(RunDoc,parentId)).runs.find(r=>r.id===binding.runId);const node=run?.nodes[binding.nodeId];
  if(run?.status!=="running" || !node || !["running","waiting"].includes(node.status) || node.runnerId!==binding.runnerId || node.attempt!==binding.attempt) throw new Error("stale_goal_admission_epoch");
  await assertGoalAdmissionTx(tx,parentId,seen);
 }
 if(!state.goalParent)return;
 // Legacy DAG children need explicit executor admission, not an inferred upgrade of old permission.
 if(!state.dagParent) throw new Error("stale_goal_admission_epoch");
 const id=Number(state.goalParent.conversationId) as ConversationId;const parent=await tx.doc(WorkDoc,id);await syncGoalHeadTx(tx,id,parent);
 if(parent.goal?.epoch!==state.goalParent.epoch||parent.goal.hash!==state.goalParent.hash)throw new Error("stale_goal_admission_epoch");
}
export type Lease = { id: string; root: string; environment: string; conversationId: string; workId: string; taskId: string; reason: string; phase: "reserved-no-effect" | "effect-may-have-started" | "quiescent" | "blocked-unknown" };
export type EvidenceSummary = Omit<Evidence, "observation"> & { observation?: Omit<ProcessObservation, "output" | "report" | "command" | "cwd"> };
/**
 * Display state of one acceptance obligation, ordered by how much it needs attention.
 * `met` ⇔ the check is absent from `unmetCheckIds` (same `validEvidence` predicate); every other value is derived from the
 * latest current-epoch attempt. Only the host `status` certifies; a fully met plan without a certificate is not verified.
 */
export type PlanState = "met" | "pending" | "stale" | "running" | "cancelled" | "unknown" | "failed";
export const PLAN_STATE_ORDER: readonly PlanState[] = ["met", "pending", "stale", "running", "cancelled", "unknown", "failed"];
export type PlanCheck = { id: string; evidence: CheckObligation["evidence"]; expected: string; state: PlanState };
export type PlanRequirement = { id: string; assertion: string; checkIds: string[]; state: PlanState };
/** The registered acceptance contract as the user should see it; `checks` keeps contract order. */
export type WorkPlan = { requirements: PlanRequirement[]; checks: PlanCheck[] };
export type WorkflowStatus = {
	status: "informational" | "planning" | "implementing" | "verifying" | "verified" | "blocked" | "cancelled";
	workId: string | null; sourceIds: string[]; version: number; methodEpoch: number; mutationEpoch: number;
	blockers: string[]; unmetCheckIds: string[]; certificate: Certificate | null;
	costs: Work["costs"] | null; methods: Record<string, MethodRecord[]>; evidence: EvidenceSummary[]; limitations: string[];
	/** Present whenever a work item is selected; absent for informational or unregistered sources. */
	plan?: WorkPlan;
};
export const WorkDoc = defineDoc<WorkState>({ kind: "dinobot.work", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ works: [], sources: {} }) });
export const EvidenceDoc = defineDoc<{ attempts: Evidence[] }>({ kind: "dinobot.evidence", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ attempts: [] }) });
export const WorkspaceCoordDoc = defineDoc<{ leases: Lease[]; mutations: { root: string; environment: string; epoch: number }[] }>({ kind: "dinobot.workspace-coordination", version: 1, scope: "session", initial: () => ({ leases: [], mutations: [] }) });
const CheckReceiptDoc = defineDoc<{ taskId?: string }>({ kind: "dinobot.check-call", version: 1, scope: "task", initial: () => ({}) });
const MutationReceiptDoc = defineDoc<{ phase?: "running" | "settled"; leaseId?: string }>({ kind: "dinobot.mutation", version: 1, scope: "task", initial: () => ({}) });
export const LIMITATIONS = ["Structural managed verification, not universal semantic proof or a security sandbox.", "Unmanaged writers and detached descendants are outside managed quiescence guarantees.", "Ignored installed dependency bytes are not attested by lockfiles.", "Scenario adequacy and informational classification are model judgments."];
/** IDs are numeric storage keys; strings are used only in public receipts. */
function durableId<I extends number>(value: string): I {
	if (!/^[1-9][0-9]*$/.test(value)) throw new Error("invalid_durable_id");
	const number = Number(value);
	if (!Number.isSafeInteger(number)) throw new Error("invalid_durable_id");
	return number as I;
}
function fail(reason: string): never { throw new Error(reason); }
function nonempty(v: string): boolean { return typeof v === "string" && v.trim().length > 0; }
function ids(values: string[], label: string) { if (!values.length || values.some(v => !nonempty(v)) || new Set(values).size !== values.length) fail(`invalid_${label}`); }
function exactKeys(value: object, keys: string[]) { if (Object.keys(value).some(k => !keys.includes(k))) fail("unexpected_contract_or_method_field"); }
export function validateContract(contract: AcceptanceContract): void {
	exactKeys(contract, ["requirements", "scenarios", "checks"]);
	ids(contract.requirements.map(r => r.id), "requirements"); ids(contract.scenarios.map(s => s.id), "scenarios"); ids(contract.checks.map(c => c.id), "checks");
	for (const scenario of contract.scenarios) { exactKeys(scenario, ["id", "assertion"]); if (!nonempty(scenario.assertion)) fail("empty_assertion"); }
	for (const r of contract.requirements) {
		exactKeys(r, ["id", "assertion", "checkIds", "scenarioIds"]); if (!nonempty(r.assertion)) fail("empty_assertion"); ids(r.checkIds, "coverage"); ids(r.scenarioIds, "coverage");
		for (const id of r.checkIds) if (!contract.checks.some(c => c.id === id && c.requirementIds.includes(r.id))) fail("incomplete_check_coverage");
		for (const id of r.scenarioIds) if (!contract.scenarios.some(s => s.id === id) || !contract.checks.some(c => r.checkIds.includes(c.id) && c.scenarioIds.includes(id))) fail("incomplete_scenario_coverage");
	}
	for (const c of contract.checks) {
		exactKeys(c, ["id", "requirementIds", "scenarioIds", "evidence", "expected"]); ids(c.requirementIds, "coverage"); ids(c.scenarioIds, "coverage");
		if (!["behavioral", "build", "lint", "typecheck", "smoke", "human"].includes(c.evidence) || !nonempty(c.expected)) fail("invalid_predicate");
		for (const id of c.requirementIds) if (!contract.requirements.some(r => r.id === id && r.checkIds.includes(c.id))) fail("unknown_requirement");
		for (const id of c.scenarioIds) if (!contract.scenarios.some(s => s.id === id)) fail("unknown_scenario");
	}
	for (const s of contract.scenarios) if (!contract.requirements.some(r => r.scenarioIds.includes(s.id))) fail("uncovered_scenario");
}
export type PlanIssue = { path: string; code: string; hint: string };
export class PlanValidationError extends Error {
	constructor(readonly issues: PlanIssue[]) { super(issues.map(i => `${i.path}: ${i.code}. ${i.hint}`).join("\n")); }
}
/** Independent predicates are reported together, rather than discovering one per model round trip. */
export function methodIssues(method: CheckMethod, check: CheckObligation, scope: InputScope, path = "method"): PlanIssue[] {
	const issues: PlanIssue[] = [];
	const add = (field: string, code: string, hint: string) => issues.push({ path: `${path}.${field}`, code, hint });
	try { exactKeys(method, ["command", "cwd", "runner", "args", "locators", "timeout", "adapterVersion"]); } catch { add("", "unexpected_contract_or_method_field", "Use the exact method schema."); }
	if (!nonempty(method.command) || method.command.length > 16384 || method.args.length > 128 || method.args.some(a => typeof a !== "string" || a.length > 4096) || !inside(scope.root, method.cwd) || method.adapterVersion !== 1 || !Number.isInteger(method.timeout) || method.timeout < 1 || method.timeout > 120) add("", "invalid_method", "Use a cwd inside scope.root, adapterVersion=1, and timeout 1..120 seconds.");
	if (!["process", "bun"].includes(method.runner) || (check.evidence === "behavioral" && method.runner !== "bun")) add("runner", "unsupported_required_runner", "Behavioral evidence requires runner=bun with real testcase locators. Existing typecheck/build/lint/smoke commands can use runner=process without wrapper tests.");
	if (method.args.some(a => /--reporter|--preload|--eval/.test(a))) add("args", "unsupported_runner_argument", "The host owns reporter/preload/eval flags.");
	const scenarioIds = method.locators.map(l => l.scenarioId);
	if (!scenarioIds.length || scenarioIds.some(id => !nonempty(id)) || new Set(scenarioIds).size !== scenarioIds.length) add("locators", "invalid_method_coverage", "Provide exactly one locator per scenario, not one per test in the suite.");
	if (canonical([...scenarioIds].sort()) !== canonical([...check.scenarioIds].sort())) add("locators", "method_cannot_change_coverage", `Locator scenario IDs must equal ${JSON.stringify(check.scenarioIds)}.`);
	for (const [index, l] of method.locators.entries()) {
		try { exactKeys(l, ["scenarioId", "file", "name"]); } catch { add(`locators[${index}]`, "unexpected_contract_or_method_field", "Use scenarioId, file and name only."); }
		if (!nonempty(l.file) || !nonempty(l.name) || !inside(scope.root, resolve(method.cwd, l.file))) add(`locators[${index}]`, "invalid_locator", "Use a file inside scope.root and an exact testcase name for Bun, or a descriptive process-check name.");
	}
	return issues;
}
export function validateMethod(method: CheckMethod, check: CheckObligation, scope: InputScope): void {
	const issues = methodIssues(method, check, scope);
	if (issues.length) throw new PlanValidationError(issues);
}
export function validEvidence(e: Evidence, w: Work, hash: string): boolean {
	const method = w.methods[e.checkId]?.at(-1);
	return e.workId === w.id && e.status === "passed" && e.observation?.passed === true && e.observation.quiescent && e.contractHash === w.contractHash && e.version === w.version && e.methodEpoch === w.methodEpoch && e.mutationEpoch === w.mutationEpoch && e.methodHash === method?.hash && e.before === hash && e.after === hash;
}
export function repairMethod(work: Work, checkId: string, expectedRevision: number, method: CheckMethod, rationale: string, priorAttemptIds: string[], operationId: string): Work {
	const next = clone(work); if (next.operations[operationId]) return next;
	const check = next.contract.checks.find(c => c.id === checkId) ?? fail("unknown_check");
	const history = next.methods[checkId] ?? fail("missing_method"); const old = history.at(-1)!;
	validateMethod(method, check, next.scope); if (!nonempty(rationale)) fail("repair_requires_rationale");
	if (expectedRevision !== old.revision) fail("method_revision_conflict");
	if (old.hash === digest(method)) return next;
	if (next.costs.repairs >= 32) fail("lifetime_repair_budget");
	history.push({ revision: old.revision + 1, method: clone(method), hash: digest(method), rationale, priorAttemptIds: [...priorAttemptIds], taskId: operationId, at: Date.now() });
	next.costs.repairs++; next.methodEpoch++; next.state = "implementing"; next.blockers = []; delete next.certificate; next.operations[operationId] = "repair"; return next;
}
/** A certificate-shaped document is not evidence: retain exact current bindings and one selected receipt per required check. */
export function validCertificate(work: Work, evidence: readonly Evidence[]): boolean {
	const certificate = work.certificate;
	if (!certificate || work.state !== "verified" || certificate.workId !== work.id
		|| certificate.contractHash !== work.contractHash || digest(work.contract) !== work.contractHash
		|| certificate.version !== work.version || certificate.methodEpoch !== work.methodEpoch
		|| certificate.mutationEpoch !== work.mutationEpoch
		|| canonical(certificate.sourceIds) !== canonical(work.sourceIds)
		|| !work.contract.checks.length || certificate.evidenceIds.length !== work.contract.checks.length
		|| new Set(certificate.evidenceIds).size !== certificate.evidenceIds.length) return false;
	return work.contract.checks.every((check, index) => evidence.some(receipt =>
		receipt.id === certificate.evidenceIds[index] && receipt.checkId === check.id
		&& validEvidence(receipt, work, certificate.fingerprint)));
}
export function inspectWorkflow(state: WorkState | undefined, evidence: readonly Evidence[] = [], sourceId?: string): WorkflowStatus {
	const disposition = sourceId ? state?.sources[sourceId] : undefined;
	const work = disposition?.kind === "linked" ? state?.works.find(w => w.id === disposition.workId) : sourceId ? undefined : state?.works.find(w => w.id === state.activeId);
	const informational = disposition?.kind === "informational" || (!sourceId && !state?.activeId && !state?.works.length && Object.values(state?.sources ?? {}).every(s => s.kind === "informational"));
	const empty: WorkflowStatus = { status: informational ? "informational" : "planning", workId: null, sourceIds: sourceId ? [sourceId] : [], version: 0, methodEpoch: 0, mutationEpoch: 0, blockers: informational ? [] : ["source_disposition_required"], unmetCheckIds: [], certificate: null, costs: null, methods: {}, evidence: [], limitations: [...LIMITATIONS] };
	if (!work) return empty;
	const unresolved = !sourceId && Object.values(state?.sources ?? {}).some(s => s.kind === "unresolved");
	const bound = work.sourceIds.every(id => { const source = state?.sources[id]; return source?.kind === "linked" && source.workId === work.id && source.contractHash === work.contractHash && source.version === work.version; });
	const certificate = validCertificate(work, evidence) && bound && !unresolved && (!sourceId || work.certificate!.sourceIds.includes(sourceId)) ? work.certificate! : null;
	const receipts = evidence.filter(e => e.workId === work.id);
	const summaries: EvidenceSummary[] = receipts.map(({ observation, ...e }) => ({ ...e, ...(observation ? { observation: { exitCode: observation.exitCode, error: observation.error?.slice(0, 1024) ?? null, durationMs: observation.durationMs, truncated: observation.truncated, observed: observation.observed, passed: observation.passed, quiescent: observation.quiescent } } : {}) }));
	const unmetCheckIds = work.contract.checks.filter(c => !receipts.some(e => e.checkId === c.id && validEvidence(e, work, certificate?.fingerprint ?? e.after))).map(c => c.id);
	return clone({ status: certificate ? "verified" : work.state === "verified" ? "blocked" : work.state, workId: work.id, sourceIds: work.sourceIds, version: work.version, methodEpoch: work.methodEpoch, mutationEpoch: work.mutationEpoch, blockers: unresolved ? [...work.blockers, "unresolved_source_inputs"] : work.blockers, unmetCheckIds, certificate, costs: work.costs, methods: work.methods, evidence: summaries, limitations: LIMITATIONS, plan: planOf(work, receipts, unmetCheckIds) });
}
/** An attempt belongs to the current epoch iff every field `validEvidence` pins to the work (other than content hashes) matches. */
function currentEpoch(e: Evidence, w: Work): boolean {
	return e.contractHash === w.contractHash && e.version === w.version && e.methodEpoch === w.methodEpoch && e.mutationEpoch === w.mutationEpoch && e.methodHash === w.methods[e.checkId]?.at(-1)?.hash;
}
/**
 * σ(c): total over Evidence["status"]. `unmet` is the host's own projection, so σ(c) = met ⇔ c ∉ unmet by construction.
 * A passed attempt that is not valid evidence (workspace changed during the run, or stale content) needs a rerun: `stale`.
 */
export function checkState(checkId: string, w: Work, receipts: readonly Evidence[], unmet: readonly string[]): PlanState {
	if (!unmet.includes(checkId)) return "met";
	const attempts = receipts.filter(e => e.checkId === checkId);
	const last = attempts.filter(e => currentEpoch(e, w)).at(-1);
	if (!last) return attempts.length ? "stale" : "pending";
	switch (last.status) {
		case "admitted": case "running": return "running";
		case "failed": return "failed";
		case "unknown": return "unknown";
		case "cancelled": return "cancelled";
		case "passed": return "stale";
	}
}
/** ρ(r) = max over PLAN_STATE_ORDER of its checks: a join, so ρ = met ⇔ every check is met, independent of order. No checks is never met. */
export function rollUp(states: readonly PlanState[]): PlanState {
	if (!states.length) return "pending";
	return states.reduce((a, b) => (PLAN_STATE_ORDER.indexOf(a) >= PLAN_STATE_ORDER.indexOf(b) ? a : b));
}
function planOf(w: Work, receipts: readonly Evidence[], unmet: readonly string[]): WorkPlan {
	const checks = w.contract.checks.map(c => ({ id: c.id, evidence: c.evidence, expected: c.expected, state: checkState(c.id, w, receipts, unmet) }));
	const byId = new Map(checks.map(c => [c.id, c.state]));
	return {
		requirements: w.contract.requirements.map(r => ({ id: r.id, assertion: r.assertion, checkIds: [...r.checkIds], state: rollUp(r.checkIds.map(id => byId.get(id) ?? "pending")) })),
		checks,
	};
}
export type RegisterPlan = { workId?: string; sourceIds: string[]; contract: AcceptanceContract; scope: InputScope; methods: Record<string, CheckMethod> };
export type WorkServiceOptions = { enforceVerification?: boolean; gateToolExecution?: boolean; getHarness: () => Harness; workspaceRoot: string; hostStorage: HostStoragePaths; evidenceDirectory: string; environmentId?: string };

/** One service per Harness; all durable state is in latest/fork-initial documents. */
export class WorkService {
	readonly options: WorkServiceOptions;
	/** Verification enforcement: answer projection, coaching and linked todo/child completion. */
	get enforced(): boolean { return this.options.enforceVerification === true; }
	/** Legacy tool-execution gate (plan, lease and environment before effects). Off means YOLO tool execution. */
	get gated(): boolean { return this.options.gateToolExecution === true; }
	constructor(options: WorkServiceOptions) { this.options = { ...options, hostStorage: clone(options.hostStorage) }; }
	private get harness() { return this.options.getHarness(); }
	private get environment() { return this.options.environmentId ?? "node:local"; }
	private mutationEpoch(coord: { mutations: { root: string; environment: string; epoch: number }[] }, root: string): number { return Math.max(0, ...coord.mutations.filter(m => m.environment === this.environment && (inside(m.root, root) || inside(root, m.root))).map(m => m.epoch)); }
	private async root(conversationId: ConversationId, context: Context) { const agent = await this.harness.snapshot(AgentDoc, conversationId, context); return realpath(resolve(this.options.workspaceRoot, agent?.cwd ?? ".")); }
	private async update<T>(conversationId: ConversationId, context: Context, change: (state: WorkState, evidence: Evidence[], leases: Lease[], tx: Tx) => T | Promise<T>): Promise<T> {
		return this.harness.commit(async tx => {
			const wd = await tx.doc(WorkDoc, conversationId); const ed = await tx.doc(EvidenceDoc, conversationId); const cd = await tx.doc(WorkspaceCoordDoc);
			const state = clone(wd); await syncGoalHeadTx(tx,conversationId,state); const evidence = clone(ed.attempts); const leases = clone(cd.leases);
			const live = await tx.doc(LiveDoc, conversationId); for (const id of live.run?.inputs ?? []) state.sources[String(id)] ??= { kind: "unresolved" };
			const result = await change(state, evidence, leases, tx); Object.assign(wd, state); ed.attempts = evidence; cd.leases = leases; return result;
		}, context);
	}
	async snapshot(conversationId: ConversationId, context: Context): Promise<WorkState> { return clone(await this.harness.snapshot(WorkDoc, conversationId, context) ?? { works: [], sources: {} }); }
	async inspectAttempt(conversationId: ConversationId, attemptId: string, context: Context): Promise<Evidence | undefined> {
		const attempt = (await this.harness.snapshot(EvidenceDoc, conversationId, context))?.attempts.find(e => e.id === attemptId);
		return attempt ? clone(attempt) : undefined;
	}
	watch(conversationId: ConversationId, context: Context) { return this.harness.watchDoc(WorkDoc, conversationId, context); }
	async captureDisplayInputs(conversationId: ConversationId, context: Context): Promise<void> {
        if (((await this.harness.snapshot(LiveDoc, conversationId, context))?.run?.inputs.length ?? 0) < 2) return;
        await this.harness.commit(async tx => {
            const inputs = ((await tx.doc(LiveDoc, conversationId)).run?.inputs ?? []).map(String);
            if (inputs.length < 2) return;
            const state = await tx.doc(WorkDoc, conversationId);
            joinDisplayInputs(state, inputs);
        }, context);
    }
	async reconcileSources(conversationId: ConversationId, sourceIds: readonly string[], context: Context): Promise<void> {
        const live=await this.harness.snapshot(LiveDoc,conversationId,context);
        const records: (import("@earendil-works/pi-durable").SubmissionRecord & {type:"input"})[]=[];
        for(const id of live?.run?.inputs ?? []) { const handle=await this.harness.submission(id,context); const record=await handle?.status(context); if(record?.type==="input" && record.entry) records.push(record); }
        const scopeRecords = [...records];
        // Delivery replay may have no LiveDoc.run. Read exact persisted input IDs
        // for display metadata only; do not replay old inputs into goal admission.
        for (const id of sourceIds) {
            if (!/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(Number(id)) || scopeRecords.some(r => String(r.id) === id)) continue;
            const handle = await this.harness.submission(Number(id) as import("@earendil-works/pi-durable").SubmissionId, context);
            const record = await handle?.status(context);
            if (record?.type === "input" && record.entry && record.conversationId === conversationId) scopeRecords.push(record);
        }
        // Cached delivery can predate group capture. Exact immutable answer-entry
        // identity joins persisted host inputs; activeId and model IDs never do.
        const answers = new Set(scopeRecords.flatMap(r => r.status === "done" ? [r.answer] : []));
        if (answers.size) {
            const state = await this.harness.snapshot(WorkDoc, conversationId, context);
            const runs = await this.harness.snapshot(RunDoc, conversationId, context);
            const known = new Set([...(state?.humanInputs ?? []).map(i => i.sourceId), ...Object.keys(state?.inputTimes ?? {}), ...(runs?.runs ?? []).flatMap(r => [...(r.sourceIds ?? []), ...(r.displaySourceIds ?? [])])]);
            for (const id of known) {
                if (!/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(Number(id)) || scopeRecords.some(r => String(r.id) === id)) continue;
                const handle = await this.harness.submission(Number(id) as import("@earendil-works/pi-durable").SubmissionId, context);
                const record = await handle?.status(context);
                if (record?.type === "input" && record.entry && record.conversationId === conversationId && record.status === "done" && answers.has(record.answer)) scopeRecords.push(record);
            }
        }
        await this.update(conversationId, context, async (state,_e,_l,tx) => {
            for(const id of sourceIds) state.sources[id] ??= {kind:"unresolved"};
            // Owned subagent prompts are model instructions, never original actual-human sources.
            if((await tx.conversation(conversationId))?.owner) return;
            joinDisplayInputs(state, records.map(r => String(r.id)));
            const answerGroups = new Map<number, string[]>();
            for(const record of scopeRecords) {
                const entry=await tx.entry(record.entry!); if(!entry || entry.kind!=="pi.user") continue;
                if (record.status === "done") {
                    const group = answerGroups.get(Number(record.answer)) ?? [];
                    group.push(String(record.id)); answerGroups.set(Number(record.answer), group);
                }
                // Immutable host user-entry time, never reconciliation time: a legacy
                // originating input can first be journaled after its run terminates.
                const user = entry.model?.length === 1 && entry.model[0]?.role === "user" ? entry.model[0] : undefined;
                if (user && Number.isFinite(user.timestamp) && user.timestamp >= 0) {
                    state.inputTimes ??= {};
                    state.inputTimes[String(record.id)] = { entryId: record.entry!, at: user.timestamp };
                }
            }
            for (const group of answerGroups.values()) joinDisplayInputs(state, group);
            for(const record of records) {
                const entry=await tx.entry(record.entry!); if(!entry || entry.kind!=="pi.user") continue;
                const text=entry.model?.map(m=>typeof m.content==="string"?m.content:canonical(m.content)).join("\n") ?? "";
                if(!text) continue;
                state.humanInputs ??= [];if(!state.humanInputs.some(s=>s.sourceId===String(record.id))) state.humanInputs.push({sourceId:String(record.id),entryId:record.entry!,text,hash:digest(text),assertion:text,at:Date.now()});
                let command: { dinobotGoalAcceptance?: {epoch:number;hash:string}; dinobotGoalAmendment?: {epoch:number;hash:string;assertion:string} } | undefined;
                try { command=JSON.parse(text.replace(/^<from[^>]*>\n/,"")); } catch {}
                if(command?.dinobotGoalAcceptance || command?.dinobotGoalAmendment) {
                    const goal=state.goal ?? fail("no_human_goal");const action=command.dinobotGoalAcceptance ?? command.dinobotGoalAmendment!;
                    if(goal.acceptance?.sourceId===String(record.id)||goal.amendments.some(a=>a.sourceId===String(record.id))) continue;
                    if(action.epoch!==goal.epoch||action.hash!==goal.hash||goalHash(goal)!==goal.hash) fail("stale_goal_epoch");
                    if(command.dinobotGoalAmendment) {const assertion=command.dinobotGoalAmendment.assertion;if(!nonempty(assertion))fail("invalid_human_amendment");goal.amendments.push({sourceId:String(record.id),assertion,hash:digest(assertion),at:Date.now()});goal.epoch++;goal.hash=goalHash(goal);delete goal.acceptance;}
                    else goal.acceptance={epoch:goal.epoch,hash:goal.hash,sourceId:String(record.id),inputHash:goalInputHash(state,String(record.id)),at:Date.now()};
                    continue;
                }
                const goal=state.goal ??= {epoch:0,hash:"",sources:[],amendments:[]};
                if(goal.sources.some(s=>s.sourceId===String(record.id))) continue;
                // Later control/context inputs do not silently amend original purpose. Explicit actual-human schema only.
                let explicit=false;try{explicit=!!JSON.parse(text.replace(/^<from[^>]*>\n/,""))?.dinobotGoal;}catch{}
                if(goal.sources.length && !explicit) continue;
                // Only literal full input is asserted. No NLP interpretation or plan-ID equivalence.
                let predicate: GoalSource["predicate"];
                const parsed=exportPredicate(text);if(parsed?.root===conversationId)predicate=parsed;
                goal.sources.push({sourceId:String(record.id),entryId:record.entry!,text,hash:digest(text),assertion:text,at:Date.now(),...(predicate?{predicate}:{})});
                goal.epoch++;goal.hash=goalHash(goal);delete goal.acceptance;
            }
            await syncGoalHeadTx(tx,conversationId,state);
        });
    }
    /** Validate complete host bytes, never a caller-provided hash or ID inventory alone. */
    async verifyGoalExport(conversationId:ConversationId, receipt:VisibleExport, epoch:number, hash:string, context:Context):Promise<{exportVerified:true;goalCertified:boolean}> {
        return this.update(conversationId,context,async(state,_e,_l,tx)=>{
            const retained=(await tx.doc(VisibleExportsDoc,conversationId)).snapshots.find(s=>s.snapshotId===receipt.snapshotId);
            if(!retained||receipt.root!==conversationId||!validateVisibleExport(receipt,retained))fail("invalid_full_export_receipt");
            const goal=state.goal ?? fail("no_human_goal");if(goal.epoch!==epoch||goal.hash!==hash||goalHash(goal)!==hash||receipt.goalBinding?.epoch!==epoch||receipt.goalBinding.hash!==hash)fail("stale_goal_epoch");
            const goalCertified=validGoalSources(state) && (state.humanInputs??[]).every(i=>goal.sources.some(s=>s.sourceId===i.sourceId)) && goal.sources.every(s=>s.predicate?.kind==="full-visible-export" && s.predicate.root===conversationId) && !goal.amendments.length;
            if(goalCertified) goal.exportAcceptance={epoch,hash,snapshotId:retained.snapshotId,inputHash:goalInputHash(state)};
            return {exportVerified:true,goalCertified};
        });
    }
    async transitionGoalAdmission(conversationId:ConversationId, event:string, context:Context):Promise<void> {
        await this.update(conversationId,context,state=>{if(!state.goal)return;state.admissionEvents ??= [];if(state.admissionEvents.includes(event))return;state.admissionEvents.push(event);state.goal.epoch++;delete state.goal.acceptance;delete state.goal.exportAcceptance;});
    }
    /** Generic T12 foundation: old child admissions cannot mutate after a source/handoff epoch transition. */
    async assertGoalAdmission(conversationId:ConversationId, context:Context):Promise<void> {
        const state=await this.snapshot(conversationId,context);
        if(state.goalParent) await this.reconcileSources(durableId<ConversationId>(state.goalParent.conversationId),[],context);
        await this.harness.commit(tx=>assertGoalAdmissionTx(tx,conversationId),context);
    }
	async status(conversationId: ConversationId, context: Context, sourceId?: string): Promise<WorkflowStatus> {
		await this.update(conversationId, context, () => undefined);
		let state = await this.snapshot(conversationId, context);
		const work = sourceId && state.sources[sourceId]?.kind === "linked" ? state.works.find(w => w.sourceIds.includes(sourceId)) : state.works.find(w => w.id === state.activeId);
		if (work?.certificate) {
			try {
				const attempts = (await this.harness.snapshot(EvidenceDoc, conversationId, context))?.attempts ?? [];
				if (!validCertificate(work, attempts)) fail("certificate_lacks_current_receipts");
				for (const id of work.certificate.evidenceIds) {
					const receipt = attempts.find(e => e.id === id)!;
					const task = await this.harness.getTask(durableId<TaskId>(receipt.taskId), context);
					const input = task?.input as { workId?: string; checkId?: string } | undefined;
					if (!task || task.kind !== "dinobot.check" || task.conversationId !== conversationId
						|| input?.workId !== work.id || input.checkId !== receipt.checkId
						|| task.state.status !== "terminal" || task.state.outcome.status !== "completed"
						|| task.state.outcome.result !== receipt.id) fail("certificate_lacks_native_check_task");
				}
				await this.inspectChildren(work, context);
				const coord = await this.harness.snapshot(WorkspaceCoordDoc, context);
				const leases = coord?.leases ?? [];
				if (leases.some(l => l.environment === this.environment && (inside(l.root, work.scope.root) || inside(work.scope.root, l.root)))) fail("workspace_not_quiescent");
				if (coord && this.mutationEpoch(coord, work.scope.root) !== work.mutationEpoch) fail("stale_workspace_mutation_epoch");
				const f = await fingerprint(work.scope, this.options.hostStorage, this.environment, context);
				if (f.hash !== work.certificate.fingerprint || work.hostHash !== digest(this.options.hostStorage) || work.scope.root !== await this.root(conversationId, context)) await this.invalidate(conversationId, work.id, "stale_content_or_host_scope", context);
			}
			catch (e) { await this.invalidate(conversationId, work.id, String(e), context); }
			state = await this.snapshot(conversationId, context);
		}
		const receipts = (await this.harness.snapshot(EvidenceDoc, conversationId, context))?.attempts ?? [];
		const result = inspectWorkflow(state, receipts, sourceId);
		const relevant = state.works.find((item) => item.id === result.workId);
		if (relevant) {
			// A live status must compare every check with ONE current workspace, not
			// let each historical receipt validate itself against its own fingerprint.
			const passed = receipts.filter(e => e.workId === relevant.id && e.status === "passed");
			if (passed.length) {
				let hash: string | undefined;
				try { hash = (await fingerprint(relevant.scope, this.options.hostStorage, this.environment, context)).hash; }
				catch (error) {
					if (result.status !== "cancelled") result.status = "blocked";
					result.certificate = null;
					result.blockers = [...new Set([...result.blockers, `current_fingerprint_unavailable:${String(error)}`])];
				}
				result.unmetCheckIds = relevant.contract.checks.filter(c => hash === undefined || !passed.some(e => e.checkId === c.id && validEvidence(e, relevant, hash))).map(c => c.id);
				result.plan = planOf(relevant, receipts.filter(e => e.workId === relevant.id), result.unmetCheckIds);
				if (result.certificate && result.certificate.fingerprint !== hash) {
					result.certificate = null;
					if (result.status !== "cancelled") result.status = "blocked";
				}
			}
			const unknown = (await this.harness.snapshot(WorkspaceCoordDoc, context))?.leases.filter((lease) =>
				lease.phase === "blocked-unknown" && lease.environment === this.environment
				&& (inside(lease.root, relevant.scope.root) || inside(relevant.scope.root, lease.root)),
			) ?? [];
			if (unknown.length) {
				if (result.status !== "cancelled") result.status = "blocked";
				result.certificate = null;
				result.blockers = [...new Set([...result.blockers, ...unknown.map((lease) => `unknown_effect:${lease.taskId}:${lease.reason}`)])];
			}
		}
		return result;
	}
	async projectSubmission(conversationId: ConversationId, sourceId: string, provisionalText: string, context: Context): Promise<{ text: string; workflow: WorkflowStatus }> {
		await this.reconcileSources(conversationId, [sourceId], context);
		const state = await this.snapshot(conversationId, context);
		if (!state.activeId && state.sources[sourceId]?.kind === "unresolved") await this.classifyInformational(conversationId, [sourceId], "Model answered without coding registration or managed coding effects; informational judgment, not certification.", context);
		const workflow = await this.status(conversationId, context, sourceId);
		return { workflow, text: !this.enforced || workflow.status === "informational" ? provisionalText : workflow.status === "verified" ? `Verified work ${workflow.workId}; certificate ${workflow.certificate!.id}; evidence ${workflow.certificate!.evidenceIds.join(", ")}.\n${provisionalText}\nLimitations: ${LIMITATIONS.join(" ")}` : `Work ${workflow.status}: ${[...workflow.blockers, ...workflow.unmetCheckIds.map(id => `unmet ${id}`)].join("; ") || "No current completion certificate."}` };
	}
	async classifyInformational(conversationId: ConversationId, sourceIds: string[], rationale: string, context: Context): Promise<void> {
		if (!nonempty(rationale)) fail("informational_judgment_requires_rationale"); ids(sourceIds, "sources");
		await this.update(conversationId, context, state => { for (const id of sourceIds) { if (!state.sources[id]) fail("unknown_source"); if (state.sources[id]?.kind === "linked") fail("linked_source_cannot_be_waived"); state.sources[id] = { kind: "informational", rationale }; } });
	}
	async describe(conversationId: ConversationId, context: Context) {
		const root = await this.root(conversationId, context);
		const state = await this.snapshot(conversationId, context);
		const live = await this.harness.snapshot(LiveDoc, conversationId, context);
		const sourceIds = [...new Set([...Object.keys(state.sources).filter(id => state.sources[id]?.kind === "unresolved"), ...(live?.run?.inputs ?? []).map(String)])];
		return {
			root, sourceIds, enforced: this.enforced, gated: this.gated,
			guidance: "Use actual source IDs, check IDs as methods keys, and one locator per scenario. Process typecheck/build/lint/smoke needs no wrapper test. Behavioral checks require real Bun test locators. Examples are templates, not proof of acceptance or executable commands to run blindly. Preflight is read-only and never certifies.",
			example: {
				op: "preflight", sourceIds,
				contract: { requirements: [{ id: "r", assertion: "Project typechecks", checkIds: ["typecheck"], scenarioIds: ["s"] }], scenarios: [{ id: "s", assertion: "TypeScript reports no errors" }], checks: [{ id: "typecheck", requirementIds: ["r"], scenarioIds: ["s"], evidence: "typecheck", expected: "tsc exits 0" }] },
				scope: { root, inputs: [], disposable: [] },
				methods: { typecheck: { command: "bun", cwd: root, runner: "process", args: ["run", "typecheck"], timeout: 60, adapterVersion: 1, locators: [{ scenarioId: "s", file: "package.json", name: "typecheck" }] } },
			},
			behavioralMethodExample: { command: "bun", cwd: root, runner: "bun", args: ["./test/example.test.ts"], timeout: 60, adapterVersion: 1, locators: [{ scenarioId: "s", file: "test/example.test.ts", name: "exact existing testcase name" }] },
		};
	}
	/** No durable writes, effects, leases or check runs. Registration repeats this inspection. */
	async preflight(conversationId: ConversationId, plan: RegisterPlan, context: Context) {
		context.abortSignal?.throwIfAborted();
		const issues: PlanIssue[] = [];
		const add = (path: string, code: string, hint: string) => issues.push({ path, code, hint });
		const root = await this.root(conversationId, context);
		try { validateContract(plan.contract); } catch (e) { add("contract", (e as Error).message, "Inspect requirement/check/scenario coverage with work_plan describe."); }
		try { ids(plan.sourceIds, "sources"); } catch (e) { add("sourceIds", (e as Error).message, "Use source IDs returned by work_plan describe."); }
		if (plan.workId !== undefined && !nonempty(plan.workId)) add("workId", "invalid_work_id", "Omit workId for new work.");
		let canonicalRoot: string | undefined;
		try { canonicalRoot = await realpath(plan.scope.root); } catch { add("scope.root", "invalid_scope_root", `Use the existing workspace ${root}.`); }
		if (canonicalRoot && canonicalRoot !== root) add("scope.root", "scope_root_must_equal_host_workspace", `This conversation uses ${root}. Start a new project-bound session to change it; shell cd does not change conversation cwd.`);
		const scope = { ...clone(plan.scope), root: canonicalRoot ?? plan.scope.root };
		try { exactKeys(scope, ["root", "inputs", "disposable"]); } catch (e) { add("scope", (e as Error).message, "Use root, inputs and disposable only."); }
		for (const [index, path] of scope.disposable.entries()) if (resolve(scope.root, path) === scope.root || !inside(scope.root, resolve(scope.root, path))) add(`scope.disposable[${index}]`, "invalid_disposable_root", "Disposable paths must be strict descendants of scope.root, e.g. .data/verification.");
		for (const check of plan.contract.checks) {
			context.abortSignal?.throwIfAborted();
			const path = `methods[${JSON.stringify(check.id)}]`;
			const method = plan.methods[check.id];
			if (!method) { add(path, "missing_method", `Key methods by check ID ${check.id}.`); continue; }
			issues.push(...methodIssues(method, check, scope, path));
			try { if (!inside(scope.root, await realpath(method.cwd))) add(`${path}.cwd`, "method_cwd_outside_scope", "Use a canonical cwd inside scope.root."); }
			catch { add(`${path}.cwd`, "invalid_method_cwd", "Use an existing directory."); }
		}
		const state = await this.snapshot(conversationId, context);
		const live = await this.harness.snapshot(LiveDoc, conversationId, context);
		const known = new Set([...Object.keys(state.sources), ...(live?.run?.inputs ?? []).map(String)]);
		for (const id of plan.sourceIds) if (!known.has(id)) add("sourceIds", "unknown_source", `Unknown source ${id}; use work_plan describe, not a thread label.`);
		const bound = state.works.filter(w => plan.sourceIds.some(id => w.sourceIds.includes(id)));
		if (bound.length > 1) add("sourceIds", "sources_belong_to_different_work", "Keep each existing work's source binding.");
		if (bound[0] && plan.workId !== undefined && bound[0].id !== plan.workId) add("workId", "source_work_binding_is_immutable", "Use the work already bound to these sources.");
		const active = state.works.find(w => w.id === state.activeId);
		const prior = bound[0] ?? state.works.find(w => w.id === plan.workId) ?? (active && active.state !== "verified" && active.state !== "cancelled" ? active : undefined);
		if (prior && plan.workId !== undefined && prior.id !== plan.workId) add("workId", "unfinished_work_cannot_be_replaced", "Strengthen the existing work instead of replacing it.");
		if (prior?.contract.requirements.length) {
			if (canonical(scope) !== canonical(prior.scope)) add("scope", "scope_is_immutable", "Existing work retains its complete input scope.");
			for (const key of ["requirements", "scenarios", "checks"] as const) for (const old of prior.contract[key]) if (!plan.contract[key].some(value => canonical(value) === canonical(old))) add(`contract.${key}`, "acceptance_cannot_be_removed_or_lowered", `Preserve obligation ${old.id}.`);
			for (const check of prior.contract.checks) if (digest(plan.methods[check.id]) !== prior.methods[check.id]!.at(-1)!.hash) add(`methods[${JSON.stringify(check.id)}]`, "use_repair_method", "Use repair_method with the current revision and rationale.");
		}
		if (new Set([...(prior?.costs.slots ?? []), ...plan.contract.checks.map(c => c.id)]).size > 16) add("contract.checks", "lifetime_slot_budget", "At most 16 check slots per logical work; do not remove required coverage.");
		// Only inspect the authorized conversation root, never a rejected arbitrary root.
		if (canonicalRoot === root && !issues.some(i => i.code === "invalid_disposable_root")) {
			try { await fingerprint(scope, this.options.hostStorage, this.environment, context); }
			catch (e) { context.abortSignal?.throwIfAborted(); add("scope", (e as Error).message, "Declare real external inputs or correct the workspace; do not hide required inputs to pass validation."); }
		}
		context.abortSignal?.throwIfAborted();
		return { valid: issues.length === 0, root, issues: issues.slice(0, 64), omittedIssues: Math.max(0, issues.length - 64), certification: false as const };
	}
	async register(conversationId: ConversationId, plan: RegisterPlan, operationId: string, context: Context): Promise<WorkflowStatus> {
		const inspection = await this.preflight(conversationId, plan, context);
		if (!inspection.valid) throw new PlanValidationError(inspection.issues);
		const root = inspection.root;
		const scope = { ...clone(plan.scope), root };
		await this.update(conversationId, context, state => {
			for (const id of plan.sourceIds) if (!state.sources[id]) fail("unknown_source");
			const bound = state.works.filter((w) => plan.sourceIds.some((id) => w.sourceIds.includes(id)));
			if (bound.length > 1) fail("sources_belong_to_different_work");
			if (bound[0] && plan.workId !== undefined && bound[0].id !== plan.workId) fail("source_work_binding_is_immutable");
			const named = state.works.find((w) => w.id === plan.workId);
			const active = state.works.find((w) => w.id === state.activeId);
			const unfinished = active && active.state !== "verified" && active.state !== "cancelled" ? active : undefined;
			const prior = bound[0] ?? named ?? unfinished;
			if (prior && plan.workId !== undefined && prior.id !== plan.workId) fail("unfinished_work_cannot_be_replaced");
			if (prior?.operations[operationId]) return;
			if (prior && prior.contract.requirements.length) {
				if (canonical(scope) !== canonical(prior.scope)) fail("scope_is_immutable");
				for (const key of ["requirements", "scenarios", "checks"] as const) for (const old of prior.contract[key]) if (!plan.contract[key].some(value => canonical(value) === canonical(old))) fail("acceptance_cannot_be_removed_or_lowered");
				for (const check of prior.contract.checks) if (digest(plan.methods[check.id]) !== prior.methods[check.id]!.at(-1)!.hash) fail("use_repair_method");
			}
			const w: Work = prior ?? { id: plan.workId ?? randomUUID(), state: "planning", version: 0, contract: { requirements: [], scenarios: [], checks: [] }, contractHash: "", scope, hostHash: digest(this.options.hostStorage), methodEpoch: 0, mutationEpoch: 0, methods: {}, sourceIds: [], costs: { attempts: 0, repairs: 0, seconds: 0, coaching: 0, slots: [] }, noProgress: {}, operations: {}, blockers: [] };
			const slots = [...new Set([...w.costs.slots, ...plan.contract.checks.map(c => c.id)])]; if (slots.length > 16) fail("lifetime_slot_budget");
			const changed = digest(plan.contract) !== w.contractHash || plan.sourceIds.some(id => !w.sourceIds.includes(id));
			if (changed) { w.version++; w.methodEpoch++; delete w.certificate; }
			w.contract = clone(plan.contract); w.contractHash = digest(plan.contract); w.scope = scope; w.costs.slots = slots;
			w.hostHash = digest(this.options.hostStorage); w.sourceIds = [...new Set([...w.sourceIds, ...plan.sourceIds])];
			for (const c of plan.contract.checks) w.methods[c.id] ??= [{ revision: 1, method: clone(plan.methods[c.id]!), hash: digest(plan.methods[c.id]), rationale: "Initial declared method", priorAttemptIds: [], taskId: operationId, at: Date.now() }];
			for (const id of w.sourceIds) state.sources[id] = { kind: "linked", workId: w.id, contractHash: w.contractHash, version: w.version };
			w.state = "implementing"; w.blockers = []; w.operations[operationId] = "register"; state.activeId = w.id; if (!prior) state.works.push(w);
		});
		return this.status(conversationId, context);
	}
	async repair(conversationId: ConversationId, workId: string, checkId: string, expectedRevision: number, method: CheckMethod, rationale: string, priorAttemptIds: string[], operationId: string, context: Context): Promise<WorkflowStatus> {
		const cwd = await realpath(method.cwd); if (!inside(await this.root(conversationId, context), cwd)) fail("method_cwd_outside_scope");
		await this.update(conversationId, context, (state, evidence) => { const index = state.works.findIndex(w => w.id === workId); if (index < 0) fail("unknown_work"); for (const id of priorAttemptIds) if (!evidence.some(e => e.id === id && e.workId === workId)) fail("unknown_prior_attempt"); state.works[index] = repairMethod(state.works[index]!, checkId, expectedRevision, method, rationale, priorAttemptIds, operationId); });
		return this.status(conversationId, context);
	}
	private acquire(leases: Lease[], lease: Lease): void { const conflict = leases.find(l => l.environment === lease.environment && (inside(l.root, lease.root) || inside(lease.root, l.root))); if (conflict) fail(`workspace_busy:${conflict.taskId}:${conflict.phase}:${conflict.reason}`); leases.push(lease); }
	private async invalidate(conversationId: ConversationId, workId: string, reason: string, context: Context): Promise<void> { await this.update(conversationId, context, state => { const w = state.works.find(w => w.id === workId); if (w) { delete w.certificate; w.state = "blocked"; w.blockers = [reason]; } }); }
	async bindChildTx(tx: Tx, parentConversationId: ConversationId, workId: string, childConversationId: ConversationId, runnerTaskId: TaskId): Promise<void> {
		if (parentConversationId === childConversationId) fail("child_cannot_equal_parent");
		const parent = await tx.doc(WorkDoc, parentConversationId);
		let ancestor = parent.parent;
		const seen = new Set<string>();
		while (ancestor) {
			if (ancestor.conversationId === String(childConversationId) || seen.has(ancestor.conversationId)) fail("child_link_cycle");
			seen.add(ancestor.conversationId);
			ancestor = (await tx.doc(WorkDoc, durableId<ConversationId>(ancestor.conversationId))).parent;
		}
		const work = parent.works.find(w => w.id === workId) ?? fail("unknown_parent_work");
		const child = await tx.doc(WorkDoc, childConversationId);
		if (child.parent && (child.parent.conversationId !== String(parentConversationId) || child.parent.workId !== workId)) fail("child_already_bound");
		work.children ??= [];
		const existing = work.children.find(c => c.conversationId === String(childConversationId));
		if (existing) { if (existing.runnerTaskId !== String(runnerTaskId)) fail("child_runner_conflict"); return; }
		child.parent = { conversationId: String(parentConversationId), workId };
		work.children.push({ conversationId: String(childConversationId), runnerTaskId: String(runnerTaskId) });
		work.methodEpoch++; delete work.certificate; work.state = "implementing";
	}
	async bindChild(parentConversationId: ConversationId, workId: string, childConversationId: ConversationId, runnerTaskId: TaskId, context: Context): Promise<void> {
		await this.harness.commit(tx => this.bindChildTx(tx, parentConversationId, workId, childConversationId, runnerTaskId), context);
	}
	private async inspectChildren(work: Work, context: Context): Promise<Record<string, string>> {
		const fingerprints: Record<string, string> = {};
		for (const ref of work.children ?? []) {
			const runner = await this.harness.getTask(durableId<TaskId>(ref.runnerTaskId), context);
			if (!runner || runner.state.status !== "terminal" || runner.state.outcome.status !== "completed") fail(`linked_child_unsettled:${ref.runnerTaskId}`);
			const childId = durableId<ConversationId>(ref.conversationId);
			const child = await this.snapshot(childId, context);
			if (Object.values(child.sources).some(s => s.kind === "unresolved")) fail(`linked_child_unresolved:${ref.conversationId}`);
			if (child.activeId) {
				const status = await this.status(childId, context);
				if (status.status !== "verified") fail(`linked_child_uncertified:${ref.conversationId}`);
			}
			if ((await this.harness.snapshot(WorkspaceCoordDoc, context))?.leases.some(l => l.conversationId === ref.conversationId)) fail(`linked_child_effects:${ref.conversationId}`);
			fingerprints[ref.conversationId] = digest(await this.snapshot(childId, context));
		}
		return fingerprints;
	}
	private async assertChildrenTx(tx: Tx, work: Work, fingerprints: Record<string, string>): Promise<void> {
		for (const ref of work.children ?? []) {
			const child = await tx.doc(WorkDoc, durableId<ConversationId>(ref.conversationId));
			if (fingerprints[ref.conversationId] !== digest(child)) fail("linked_child_changed");
		}
		if ((await tx.doc(WorkspaceCoordDoc)).leases.some(l => work.children?.some(c => c.conversationId === l.conversationId))) fail("linked_child_effects");
	}
	async assertTodoCompletion(tx: Tx, conversationId: ConversationId, workId: string): Promise<void> {
		if (!this.enforced) return;
		const state = await tx.doc(WorkDoc, conversationId); const w = state.works.find(w => w.id === workId); const live = await tx.doc(LiveDoc, conversationId);
		if (!w || !validCertificate(w, (await tx.doc(EvidenceDoc, conversationId)).attempts) || (live.run?.inputs ?? []).some(id => state.sources[String(id)]?.kind !== "informational" && !w.certificate!.sourceIds.includes(String(id)))) fail("overall_todo_requires_current_certificate");
		const coord = await tx.doc(WorkspaceCoordDoc);
		if (this.mutationEpoch(coord, w.scope.root) !== w.mutationEpoch || coord.leases.some(l => l.environment === this.environment && (inside(w.scope.root, l.root) || inside(l.root, w.scope.root)))) fail("workspace_not_quiescent");
	}
	async cancel(conversationId: ConversationId, workId: string, context: Context): Promise<void> { await this.update(conversationId, context, state => { const w = state.works.find(w => w.id === workId) ?? fail("unknown_work"); w.state = "cancelled"; delete w.certificate; }); }
	async settle(conversationId: ConversationId, workId: string, outcome: "blocked" | "cancelled", reason: string, context: Context): Promise<WorkflowStatus> {
		if (!nonempty(reason)) fail("nonverified_outcome_requires_reason");
		await this.update(conversationId, context, state => { const w = state.works.find(w => w.id === workId) ?? fail("unknown_work"); w.state = outcome; w.blockers = [reason]; delete w.certificate; });
		return this.status(conversationId, context);
	}
	async coach(conversationId: ConversationId, operationId: string, context: Context): Promise<string | undefined> {
		if (!this.enforced) return undefined;
		return this.update(conversationId, context, async (state, _evidence, _leases, tx) => {
			const w = state.works.find(w => w.id === state.activeId);
			if (!w) {
				for (const id of (await tx.doc(LiveDoc, conversationId)).run?.inputs ?? []) if (state.sources[String(id)]?.kind === "unresolved") state.sources[String(id)] = { kind: "informational", rationale: "Model answered without coding registration or managed coding effects; informational judgment." };
				return undefined;
			}
			if (w.certificate || w.state === "cancelled" || w.costs.coaching >= 2 || w.operations[operationId]) return undefined;
			w.costs.coaching++; w.operations[operationId] = "coach";
			return `Work ${w.id} is not verified. Inspect work_status, repair methods with rationale without changing acceptance, run every required check, then work_finish. If blocked, report exact unmet obligations. This is corrective continuation ${w.costs.coaching}/2.`;
		});
	}
	private planningWork(root: string): Work {
		return { id: randomUUID(), state: "planning", version: 0, contract: { requirements: [], scenarios: [], checks: [] }, contractHash: "", scope: { root, inputs: [], disposable: [] }, hostHash: digest(this.options.hostStorage), methodEpoch: 0, mutationEpoch: 0, methods: {}, sourceIds: [], costs: { attempts: 0, repairs: 0, seconds: 0, coaching: 0, slots: [] }, noProgress: {}, operations: {}, blockers: ["work_plan_required"] };
	}
	async mutate<T>(api: ToolExecutionApi, context: Context, run: (guardedApi: ToolExecutionApi) => Promise<T>, kind: "filesystem" | "process" | "external" = "external"): Promise<T> {
        await this.assertGoalAdmission(api.conversationId,context);
		if (!this.gated) {
			const root = await this.root(api.conversationId, context);
			// Invalidate optional certificates across conversations, without requiring a plan
			// or taking a verification lease. Bump on both sides of the effect to
			// invalidate historical evidence even if the final file bytes are unchanged.
			// Under enforced verification a plan-less file edit opens unregistered coding work
			// (work_plan_required) so the answer is projected and coached, never filed as informational.
			const invalidate = (register: boolean, admit=false) => this.update(api.conversationId, context, async (state, _evidence, _leases, tx) => {
				if(admit) await assertGoalAdmissionTx(tx,api.conversationId);
                if (register && !state.works.some(w => w.id === state.activeId)) { const w = this.planningWork(root); state.works.push(w); state.activeId = w.id; }
				const coord = await tx.doc(WorkspaceCoordDoc);
				const epoch = Math.max(0, ...coord.mutations.map(m => m.epoch)) + 1;
				const prior = coord.mutations.find(m => m.root === root && m.environment === this.environment);
				if (prior) prior.epoch = epoch;
				else coord.mutations.push({ root, environment: this.environment, epoch });
			});
			await invalidate(this.enforced && kind === "filesystem",true);
			if (kind === "process") await admitUnknownNativeCall(api, context, "process");
			try { return await run(kind === "process" ? nativeProcessApi(api) : api); }
			finally { await invalidate(false); }
		}
		const root = await this.root(api.conversationId, context); const leaseId = String(api.taskId);
		if (!api.env || api.env.id !== this.environment || await realpath(api.env.cwd) !== root) fail("unsupported_or_changed_execution_environment");
		const admitted = await this.update(api.conversationId, context, async (state, _evidence, leases, tx) => {
			await assertGoalAdmissionTx(tx,api.conversationId);
            const receipt = await tx.doc(MutationReceiptDoc, api.taskId);
			if (receipt.phase) fail(receipt.phase === "running" ? "ambiguous_mutation_not_replayed" : "settled_mutation_not_replayed");
			let w = state.works.find(w => w.id === state.activeId);
			if (!w) { w = this.planningWork(root); state.works.push(w); state.activeId = w.id; }
			if (!w.contract.checks.length || w.state === "cancelled" || Object.values(state.sources).some(s => s.kind === "unresolved")) return false;
			if (w.scope.root !== root) fail("workspace_changed");
			if (w.hostHash !== digest(this.options.hostStorage)) fail("host_scope_changed");
			this.acquire(leases, { id: leaseId, root, environment: this.environment, conversationId: String(api.conversationId), workId: w.id, taskId: String(api.taskId), reason: "mutation", phase: "effect-may-have-started" });
			const coord = await tx.doc(WorkspaceCoordDoc);
			w.mutationEpoch = Math.max(0, ...coord.mutations.map(m => m.epoch)) + 1;
			const old = coord.mutations.find(m => m.root === root && m.environment === this.environment);
			if (old) old.epoch = w.mutationEpoch; else coord.mutations.push({ root, environment: this.environment, epoch: w.mutationEpoch });
			w.state = "implementing"; delete w.certificate; receipt.phase = "running"; receipt.leaseId = leaseId; return true;
		});
		if (!admitted) fail("work_plan_required_for_current_sources");
		if (kind === "process") await admitUnknownNativeCall(api, context, "process");
		let execObserved = false; let execQuiescent = true;
		const processApi = kind === "process" ? nativeProcessApi(api) : api;
		const guardedEnv = new Proxy(processApi.env!, { get(target, property) {
			if (property === "exec") return async (...args: Parameters<typeof target.exec>) => {
				execObserved = true; execQuiescent = false;
				const [command, options, execContext] = args; const events: NativeProcessEvent[] = [];
				const result = await target.exec(command, { ...options, onProcess: async event => { events.push(event); await options?.onProcess?.(event); } }, execContext);
				// Shell exit is not descendant settlement; only a canonical native settlement or a failed spawn is.
				execQuiescent = (!result.ok && ["spawn_error", "shell_unavailable"].includes(result.error.code)) || nativeSettled(events);
				return result;
			};
			const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
		} });
		const recordSettlement = async (quiescent: boolean) => this.update(api.conversationId, context, async (state, _evidence, leases, tx) => {
			const lease = leases.find((item) => item.id === leaseId);
			if (quiescent) {
				(await tx.doc(MutationReceiptDoc, api.taskId)).phase = "settled";
				if (lease) leases.splice(leases.indexOf(lease), 1);
			} else if (lease) {
				lease.phase = "blocked-unknown";
				const w = state.works.find((item) => item.id === lease.workId)!;
				w.state = "blocked";
				w.blockers = ["managed_error_effects_not_proven_quiescent"];
			}
		});
		try {
			const result = await run({ ...api, env: guardedEnv });
			const failed = !!(result && typeof result === "object" && "isError" in result && result.isError);
			// Known built-ins await their filesystem operations; bash must have an observed invocation outcome.
			// A generic external tool's failed response cannot establish remote-effect quiescence.
			const quiescent = kind === "filesystem" || (kind === "process" ? !execObserved || execQuiescent : !failed);
			await recordSettlement(quiescent);
			return result;
		} catch (error) {
			const quiescent = kind === "filesystem" || (kind === "process" && (!execObserved || execQuiescent));
			await recordSettlement(quiescent).catch(() => undefined);
			throw error;
		}
	}
	async run(api: ToolExecutionApi, workId: string, checkId: string, context: Context): Promise<WorkflowStatus> {
		const id = await api.commit(async tx => { const receipt = await tx.doc(CheckReceiptDoc, api.taskId); if (receipt.taskId) return durableId<TaskId<string>>(receipt.taskId); const taskId = await tx.createTask(this.checkTask, { workId, checkId }, { conversationId: api.conversationId, ownership: { kind: "task", taskId: api.taskId } }); receipt.taskId = String(taskId); return taskId; }, context);
		await api.waitForTask(id, context); return this.status(api.conversationId, context);
	}
	readonly checkTask = defineTask<{ workId: string; checkId: string }, { phase: "run" }, string>({
		name: "dinobot.check", version: 1, initial: () => ({ phase: "run" }),
		phases: { run: async (task, runtime, context) => {
			const conversationId = runtime.conversationId; const attemptId = String(task.id);
			try { await this.performCheck(conversationId, task.input.workId, task.input.checkId, attemptId, await runtime.env(context), context); }
			catch (error) { await this.failAttempt(conversationId, attemptId, String(error), context); await this.invalidate(conversationId, task.input.workId, String(error), context); }
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: attemptId } }), context);
		} },
		abort: async (task, runtime, context) => { await this.failAttempt(runtime.conversationId, String(task.id), "cancelled", context); await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: String(task.id) } }), context); },
	});
	private async failAttempt(conversationId: ConversationId, id: string, error: string, context: Context): Promise<void> {
		await this.update(conversationId, context, (state, evidence, leases) => {
			const e = evidence.find(e => e.id === id); const lease = leases.find(l => l.id === id); const w = state.works.find(w => w.id === (e?.workId ?? lease?.workId));
			if (e && ["admitted", "running"].includes(e.status)) { e.status = lease?.phase === "effect-may-have-started" || lease?.phase === "blocked-unknown" ? "unknown" : error === "cancelled" ? "cancelled" : "failed"; e.error = error; if (w) w.noProgress[e.signature] = (w.noProgress[e.signature] ?? 0) + 1; }
			if (lease) { if (["effect-may-have-started", "blocked-unknown"].includes(lease.phase)) lease.phase = "blocked-unknown"; else leases.splice(leases.indexOf(lease), 1); }
			if (w) { w.state = "blocked"; w.blockers = [e?.status === "unknown" ? "unknown_effect_requires_operator_quiescence" : error]; delete w.certificate; }
		});
	}
	private async performCheck(conversationId: ConversationId, workId: string, checkId: string, id: string, env: ToolExecutionApi["env"], context: Context): Promise<void> {
        await this.assertGoalAdmission(conversationId,context);
		if (!env) fail("execution_environment_required");
		const root = await this.root(conversationId, context); let prior: Evidence | undefined;
		if (env.id !== this.environment || await realpath(env.cwd) !== root) fail("unsupported_or_changed_execution_environment");
		const work = await this.update(conversationId, context, async (state, evidence, leases, tx) => {
			await assertGoalAdmissionTx(tx,conversationId);
            const w = state.works.find(w => w.id === workId) ?? fail("unknown_work"); prior = evidence.find(e => e.id === id);
			if (prior) return clone(w);
			if (w.state === "cancelled" || !w.contract.checks.some(c => c.id === checkId)) fail("inactive_or_unknown_check");
			if (w.hostHash !== digest(this.options.hostStorage)) fail("host_scope_changed");
			if (w.scope.root !== root) fail("workspace_changed");
			const reserved = leases.find(l => l.id === id && l.phase === "reserved-no-effect");
			if (reserved) leases.splice(leases.indexOf(reserved), 1);
			w.mutationEpoch = this.mutationEpoch(await tx.doc(WorkspaceCoordDoc), root);
			this.acquire(leases, { id, root, environment: this.environment, conversationId: String(conversationId), workId, taskId: id, reason: "verification", phase: "reserved-no-effect" }); return clone(w);
		});
		if (prior) { if (["admitted", "running"].includes(prior.status)) await this.failAttempt(conversationId, id, "interrupted_execution_not_replayed", context); return; }
		const method = work.methods[checkId]!.at(-1)!; const check = work.contract.checks.find(c => c.id === checkId)!;
		let before: string;
		try { before = (await fingerprint(work.scope, this.options.hostStorage, this.environment, context)).hash; }
		catch (error) {
			await this.update(conversationId, context, (state, evidence) => {
				if (evidence.some((attempt) => attempt.id === id)) return;
				const current = state.works.find((item) => item.id === workId)!;
				if (current.costs.attempts >= 64 || current.costs.seconds + method.method.timeout > 1920) fail("lifetime_attempt_or_time_budget");
				current.costs.attempts++;
				current.costs.seconds += method.method.timeout;
				const signature = digest([checkId, method.hash, "fingerprint_failed", this.environment]);
				evidence.push({
					id, taskId: id, workId, checkId, status: "admitted", contractHash: work.contractHash,
					version: work.version, methodEpoch: work.methodEpoch, methodHash: method.hash,
					mutationEpoch: work.mutationEpoch, before: "", after: "", signature, timeout: method.method.timeout,
				});
			});
			await this.failAttempt(conversationId, id, String(error), context);
			throw error;
		}
		const signature = digest([checkId, method.hash, before, this.environment]);
		const reuse = await this.update(conversationId, context, (state, evidence, leases) => {
			const w = state.works.find(w => w.id === workId)!;
			if (w.methodEpoch !== work.methodEpoch || w.version !== work.version || w.mutationEpoch !== work.mutationEpoch) fail("check_admission_conflict");
			if (evidence.some(e => e.checkId === checkId && validEvidence(e, w, before))) { leases.splice(leases.findIndex(l => l.id === id), 1); return true; }
			if ((w.noProgress[signature] ?? 0) >= 2) fail("no_progress");
			if (w.costs.attempts >= 64 || w.costs.seconds + method.method.timeout > 1920) fail("lifetime_attempt_or_time_budget");
			w.costs.attempts++; w.costs.seconds += method.method.timeout; w.state = "verifying"; delete w.certificate;
			evidence.push({ id, taskId: id, workId, checkId, status: "admitted", contractHash: w.contractHash, version: w.version, methodEpoch: w.methodEpoch, methodHash: method.hash, mutationEpoch: w.mutationEpoch, before, after: "", signature, timeout: method.method.timeout }); return false;
		});
		if (reuse) return;
		const reportDirectory = resolve(this.options.evidenceDirectory); if (!this.options.hostStorage.directories.some(p => inside(resolve(p), reportDirectory))) fail("report_directory_not_host_reserved");
		await mkdir(reportDirectory, { recursive: true }); const reportPath = resolve(reportDirectory, `${randomUUID()}.xml`);
		await this.update(conversationId, context, (_state, evidence, leases) => { evidence.find(e => e.id === id)!.status = "running"; leases.find(l => l.id === id)!.phase = "effect-may-have-started"; });
		// CheckTask is a process producer too: journal and quarantine before Env can spawn.
		const processApi = { taskId: durableId<TaskId>(id), conversationId, env, commit: this.harness.commit.bind(this.harness) };
		await admitUnknownNativeCall(processApi, context, "process");
		const observation = await executeCheck(nativeProcessApi(processApi).env, method.method, check, reportPath, context);
		let after = ""; let hashError = ""; try { after = (await fingerprint(work.scope, this.options.hostStorage, this.environment, context)).hash; } catch (error) { hashError = String(error); }
		await this.update(conversationId, context, (state, evidence, leases) => {
			const w = state.works.find(w => w.id === workId)!; const e = evidence.find(e => e.id === id)!; const lease = leases.find(l => l.id === id)!;
			if (!["running", "admitted"].includes(e.status)) return;
			e.observation = observation; e.after = after; e.status = !observation.quiescent ? "unknown" : observation.passed && before === after && !hashError ? "passed" : "failed";
			if (hashError) e.error = hashError;
			if (e.status !== "passed") w.noProgress[signature] = (w.noProgress[signature] ?? 0) + 1;
			if (observation.quiescent) leases.splice(leases.indexOf(lease), 1); else lease.phase = "blocked-unknown";
			w.state = e.status === "passed" ? "implementing" : "blocked"; w.blockers = e.status === "passed" ? [] : [e.status === "unknown" ? "unknown_effect_requires_operator_quiescence" : hashError || observation.error || "check_failed_or_content_changed"];
		});
	}
	async finish(conversationId: ConversationId, workId: string, operationId: string, context: Context): Promise<WorkflowStatus> {
        await this.assertGoalAdmission(conversationId,context);
		const current = await this.snapshot(conversationId, context);
		if (current.works.find(w => w.id === workId)?.operations[operationId] === "finish") return this.status(conversationId, context);
		const initial = current.works.find(w => w.id === workId) ?? fail("unknown_work");
		let children: Record<string, string>;
		try { children = await this.inspectChildren(initial, context); }
		catch (error) { await this.invalidate(conversationId, workId, String(error), context); return this.status(conversationId, context); }
		const root = await this.root(conversationId, context); const leaseId = `finish:${operationId}`;
		const captured = await this.update(conversationId, context, (state, _e, leases) => { const w = state.works.find(w => w.id === workId) ?? fail("unknown_work"); if (w.state === "cancelled") fail("work_cancelled"); this.acquire(leases, { id: leaseId, root, environment: this.environment, conversationId: String(conversationId), workId, taskId: operationId, reason: "finish", phase: "reserved-no-effect" }); return clone(w); });
		try {
			if (root !== captured.scope.root) fail("workspace_changed");
			if (canonical(initial.children ?? []) !== canonical(captured.children ?? [])) fail("linked_children_changed");
			const f = await fingerprint(captured.scope, this.options.hostStorage, this.environment, context);
			await this.update(conversationId, context, async (state, evidence, leases, tx) => {
				await assertGoalAdmissionTx(tx,conversationId);
                const w = state.works.find(w => w.id === workId)!; validateContract(w.contract);
				if (canonical(w.children ?? []) !== canonical(captured.children ?? [])) fail("linked_children_changed");
				await this.assertChildrenTx(tx, w, children);
				if (this.mutationEpoch(await tx.doc(WorkspaceCoordDoc), root) !== w.mutationEpoch) fail("stale_workspace_mutation_epoch");
				if (w.version !== captured.version || w.methodEpoch !== captured.methodEpoch || w.mutationEpoch !== captured.mutationEpoch || w.state === "cancelled") fail("finish_revision_conflict");
				if (w.hostHash !== digest(this.options.hostStorage)) fail("host_scope_changed");
				if (Object.values(state.sources).some(s => s.kind === "unresolved")) fail("unresolved_source_inputs");
				for (const id of w.sourceIds) { const s = state.sources[id]; if (s?.kind !== "linked" || s.workId !== workId || s.contractHash !== w.contractHash || s.version !== w.version) fail("stale_source_binding"); }
				const selected = w.contract.checks.map(c => evidence.findLast(e => e.checkId === c.id && validEvidence(e, w, f.hash)) ?? fail(`unmet_check:${c.id}`));
				if (!w.certificate || w.certificate.fingerprint !== f.hash || w.certificate.contractHash !== w.contractHash
					|| w.certificate.version !== w.version || w.certificate.methodEpoch !== w.methodEpoch
					|| w.certificate.mutationEpoch !== w.mutationEpoch || canonical(w.certificate.sourceIds) !== canonical(w.sourceIds)
					|| canonical(w.certificate.evidenceIds) !== canonical(selected.map((e) => e.id))) {
					w.certificate = { id: randomUUID(), workId, sourceIds: [...w.sourceIds], contractHash: w.contractHash, version: w.version, methodEpoch: w.methodEpoch, mutationEpoch: w.mutationEpoch, fingerprint: f.hash, evidenceIds: selected.map(e => e.id), at: Date.now(), limitations: [...LIMITATIONS] };
					(w.certificates ??= []).push(clone(w.certificate));
				}
				w.state = "verified"; w.blockers = []; w.operations[operationId] = "finish";
				leases.splice(leases.findIndex(l => l.id === leaseId), 1);
			});
		} catch (error) { await this.update(conversationId, context, (state, _e, leases) => { const index = leases.findIndex(l => l.id === leaseId); if (index >= 0) leases.splice(index, 1); const w = state.works.find(w => w.id === workId)!; w.state = "blocked"; w.blockers = [String(error)]; delete w.certificate; }); }
		return this.status(conversationId, context);
	}
	/** Call before Harness.resume: terminal tasks are not evidence of post-crash OS quiescence. */
	async recover(context: Context): Promise<void> {
		const leases = (await this.harness.snapshot(WorkspaceCoordDoc, context))?.leases ?? [];
		for (const lease of leases) {
			const conversationId = durableId<ConversationId>(lease.conversationId);
			if (["effect-may-have-started", "blocked-unknown"].includes(lease.phase)) await this.failAttempt(conversationId, lease.id, "crash_unknown", context);
			else if (lease.reason === "finish") await this.failAttempt(conversationId, lease.id, "interrupted_before_effect", context);
			else { const task = await this.harness.getTask(durableId<TaskId>(lease.taskId), context); if (!task || task.state.status === "terminal") await this.failAttempt(conversationId, lease.id, "interrupted_before_effect", context); }
		}
	}
}
export function createWorkService(options: WorkServiceOptions): WorkService { return new WorkService(options); }
