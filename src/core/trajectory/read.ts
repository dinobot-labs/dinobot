import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { LiveDoc, type ConversationId, type Cursor, type EntryRecord, type Harness, type TaskId } from "@earendil-works/pi-durable";
import { EVALUATOR_VERSION, gradeTrace } from "./engine.ts";
import { extractReceipt } from "./receipts.ts";

export const EXTRACTOR_VERSION = "v3";
import { ARGUMENT_LIMITS, canonicalArguments, evidenceGraph, type EvidenceNode, type EvidenceLink } from "./evidence.ts";
import type { Step, StepProvenance, SourceIdentity } from "./types.ts";

export const TRAJECTORY_ENTRY_LIMIT = 1000;
export const TRAJECTORY_CALL_LIMIT = 1000;
const TEXT_LIMIT = 16000;
export const TRAJECTORY_MESSAGE_LIMIT = 4000;
export const TRAJECTORY_CONTENT_LIMIT = 8000;
const RECEIPT_JSON_LIMIT = 1_000_000;
const object = (x: unknown): Record<string, any> => x !== null && typeof x === "object" && !Array.isArray(x) ? x as Record<string, any> : {};

/** Read-only, storage-independent adapter. No model requests, writes, replays, or evaluation recursion. */
export async function readTrajectory(harness: Harness, id: ConversationId, context: Context) {
	const handle = await harness.conversation(id, context);
	if (!handle) throw new Error("Unknown trajectory conversation");
	const before = await harness.snapshot(LiveDoc, id, context);
	const record = await harness.commit(tx => tx.conversation(id), context);
	const reasons = new Set<string>();
	const entries: EntryRecord[] = [];
	let cursor: Cursor | undefined;
	do {
		context.abortSignal?.throwIfAborted();
		const page = await handle.entries({}, Math.min(100, TRAJECTORY_ENTRY_LIMIT - entries.length), cursor, context);
		entries.push(...page.items.slice(0, TRAJECTORY_ENTRY_LIMIT - entries.length));
		cursor = page.next;
	} while (cursor && entries.length < TRAJECTORY_ENTRY_LIMIT);
	if (cursor) reasons.add("entry_limit");
	entries.reverse();
	let steps: Step[] = [];
	const cells = new Map<Step, Step[]>();
	const seenReceipts = new Set<number>();
	const pending = new Map<string, Step | null>();
 const nodes: EvidenceNode[] = [];
 const links: EvidenceLink[] = [];
	let receiptCount = 0;
	let callCount = 0;
	const admit = () => { if (++callCount > TRAJECTORY_CALL_LIMIT) { reasons.add("call_limit"); return false; } return true; };
	const diagnostics = (value: unknown) => {
		if (Array.isArray(value) && value.some(d => object(d).code === "truncated" || /truncat/i.test(String(object(d).message ?? "")))) reasons.add("upstream_truncation");
	};
	const bounded = (s: string) => {
		if (s.length > TEXT_LIMIT) reasons.add("text_limit");
		return s.slice(0, TEXT_LIMIT);
	};
	const receipt = (tool: string, details: unknown, output: string) => {
		const value = extractReceipt(tool, details, output);
		if (value && JSON.stringify(value).length > TEXT_LIMIT) { reasons.add("receipt_text_limit"); return undefined; }
		return value;
	};
	const parse = (s: unknown): any => {
		if (typeof s !== "string") return s;
		if (s.length > RECEIPT_JSON_LIMIT) { reasons.add("receipt_json_limit"); return undefined; }
		try { return JSON.parse(s); } catch { reasons.add("invalid_receipt_json"); return undefined; }
	};
	const push = (s: Omit<Step, "n">) => { const step = { n: steps.length + 1, ...s }; steps.push(step); if (step.provenance) nodes.push({ id: step.provenance.id, kind: step.kind, provenance: step.provenance }); return step; };
 const argsText = (args: unknown) => {
  if (canonicalArguments(args) === undefined) { reasons.add("arguments_invalid_or_limit"); return undefined; }
  return bounded(JSON.stringify(args));
 };
 const textContent = (content: unknown): string => {
  if (typeof content === "string") return bounded(content);
  if (!Array.isArray(content)) return "";
  // Joining is bounded as well as the final string; bodies are never graph nodes.
  let text = "";
  for (const c of content) if (object(c).type === "text" && typeof object(c).text === "string") {
   text += (text ? "\n" : "") + bounded(object(c).text);
   if (text.length > TEXT_LIMIT) return bounded(text);
  }
  return text;
 };
	let position = 0, contentCount = 0;
 outer: for (const entry of entries) for (const [messageIndex, m] of (entry.model ?? []).entries()) {
  if (++position > TRAJECTORY_MESSAGE_LIMIT) { reasons.add("message_limit"); break outer; }
  const source: SourceIdentity = { conversationId: Number(entry.conversationId), entryId: Number(entry.id), byTaskId: entry.byTaskId == null ? null : Number(entry.byTaskId), entryKind: entry.kind, messageIndex };
  const baseId = JSON.stringify([source.conversationId, source.entryId, messageIndex]);
  const origin = m.role === "assistant" ? entry.kind === "pi.assistant" ? "model" : "host" : m.role === "user" ? "user" : "tool";
  const provenance = (suffix: string, contentIndex?: number): StepProvenance => ({ id: baseId + suffix, source: { ...source, ...(contentIndex === undefined ? {} : { contentIndex }) }, origin });
  let content = m.content;
  if (Array.isArray(content)) {
   const remaining = Math.max(0, TRAJECTORY_CONTENT_LIMIT - contentCount);
   if (content.length > remaining) reasons.add("content_limit");
   content = content.slice(0, remaining) as typeof m.content;
   contentCount += Array.isArray(content) ? content.length : 0;
  }
		if (m.role === "user" && entry.kind === "pi.user") {
			push({ kind: "user", order: { invoked: position }, provenance: provenance(":user"), text: textContent(content), entryId: Number(entry.id) });
		} else if (m.role === "assistant") {
			if (Array.isArray(content) && content.filter(c => c.type === "toolCall").length > 1) reasons.add("parallel_tool_round");
			for (const [contentIndex, c] of (Array.isArray(content) ? content : []).entries()) {
				if (c.type !== "toolCall") continue;
				if (!admit()) continue;
				if (typeof c.id !== "string" || c.id.length > 512 || typeof c.name !== "string" || c.name.length > 512) { reasons.add("invalid_call_reference"); continue; }
                const duplicate = pending.has(c.id);
                if (duplicate) reasons.add("duplicate_call_id");
				const step = { kind: "call" as const, order: { invoked: position }, tool: c.name, via: "direct" as const, args: c.arguments, ...(argsText(c.arguments) === undefined ? {} : { argsText: argsText(c.arguments)! }), provenance: { ...provenance(":call:" + contentIndex, contentIndex), callId: c.id }, entryId: Number(entry.id) };
				const added = push(step);
				pending.set(c.id, duplicate ? null : added);
			}
			const said = textContent(content).trim();
			if (said) push({ kind: "assistant", order: { invoked: position }, provenance: provenance(":assistant", Array.isArray(content) ? content.findIndex(c => c.type === "text") : undefined), text: bounded(said), entryId: Number(entry.id) });
		} else if (m.role === "toolResult") {
			const call = pending.get(m.toolCallId);
			if (!call) reasons.add("missing_call");
			pending.delete(m.toolCallId);
			diagnostics(object(m).diagnostics);
			if (call && call.tool !== m.toolName) { reasons.add("result_tool_mismatch"); continue; }
			if (call?.order) call.order.result = position;
            if (call?.provenance) {
             call.provenance.result = source;
             const resultProvenance = { ...provenance(":result"), callId: m.toolCallId };
             nodes.push({ id: resultProvenance.id, kind: "result", provenance: resultProvenance });
             links.push({ kind: "call-result", from: call.provenance.id, to: resultProvenance.id });
            }
			if (m.toolName !== "codemode") {
				if (call) { call.ok = !m.isError; call.output = textContent(content); call.receipt = receipt(m.toolName, m.details, call.output); }
				continue;
			}
			if (!call) continue; // Never expand an unpaired or ambiguous root.
			const expanded: Step[] = [];
			if (call) cells.set(call, expanded);
			const addInner = (s: Omit<Step, "n">) => {
                expanded.push({ n: 0, ...(call.order ? { order: call.order } : {}), ...s });
                if (s.provenance) nodes.push({ id: s.provenance.id, kind: "call", provenance: s.provenance });
            };
			let lastOrdinal = -1;
			const inner = object(m.details).codemodeCalls;
			if (!Array.isArray(inner)) reasons.add("missing_cell_receipts");
			for (const raw of Array.isArray(inner) ? inner : []) {
				if (++receiptCount > TRAJECTORY_CALL_LIMIT || !admit()) { reasons.add("call_limit"); break; }
				const ic = object(raw);
				if (!Number.isSafeInteger(ic.id) || typeof ic.name !== "string" || ic.name.length > 512) { reasons.add("invalid_call_reference"); continue; }
				if (seenReceipts.has(ic.id)) { reasons.add("duplicate_receipt"); continue; }
				seenReceipts.add(ic.id);
				const task = await harness.getTask(ic.id as TaskId, context);
				if (!task || task.conversationId !== id) { reasons.add("missing_or_foreign_receipt"); continue; }
				const input = object(task.input);
				if (input.name !== ic.name) { reasons.add("receipt_name_mismatch"); continue; }
				if (task.kind !== "dinobot.codemode.call" || input.rootCallId !== m.toolCallId || task.owner !== input.parent || input.parent !== entry.byTaskId) { reasons.add("receipt_cell_mismatch"); continue; }
				if (!Number.isSafeInteger(input.ordinal) || input.ordinal <= lastOrdinal) { reasons.add("receipt_order"); continue; }
				lastOrdinal = input.ordinal;
				const args = parse(input.args);
				const outcome = task.state.status === "terminal" ? task.state.outcome : undefined;
				if (!outcome) reasons.add("pending_receipt");
				const result = object(parse(object(object(outcome).result).json));
				diagnostics(result.diagnostics);
				const ok = outcome?.status === "completed" && result.isError !== true;
				if (outcome?.status === "completed" && !Array.isArray(result.content)) reasons.add("missing_result");
				const output = bounded(textContent(Array.isArray(result.content) ? result.content.slice(0, TRAJECTORY_CONTENT_LIMIT) : []) || String(object(object(outcome).error).message ?? ""));
				if (Array.isArray(result.content) && result.content.length > TRAJECTORY_CONTENT_LIMIT) reasons.add("content_limit");
                const innerProvenance: StepProvenance = { id: call.provenance!.id + ":task:" + ic.id, source: call.provenance!.source, ...(outcome ? { result: source } : {}), origin: "tool", parentId: call.provenance!.id, taskId: ic.id, callId: m.toolCallId };
                links.push({ kind: "root-child", from: call.provenance!.id, to: innerProvenance.id });
                if (outcome) {
                 const rp: StepProvenance = { ...innerProvenance, source, id: innerProvenance.id + ":result" };
                 nodes.push({ id: rp.id, kind: "result", provenance: rp });
                 links.push({ kind: "call-result", from: innerProvenance.id, to: rp.id });
                }
                addInner({ provenance: innerProvenance, receipt: receipt(ic.name, result.details, output), kind: "call", tool: ic.name, via: "codemode", cell: m.toolCallId, args, ...(argsText(args) === undefined ? {} : { argsText: argsText(args)! }), ...(outcome ? { ok } : {}), output, entryId: Number(entry.id), taskId: ic.id });
			}
			if (m.isError) addInner({ ...(call.provenance ? { provenance: { ...call.provenance, id: call.provenance.id + ":failure" } } : {}), kind: "call", tool: "codemode", via: "direct", cell: m.toolCallId, args: call?.args, ...(call.argsText === undefined ? {} : { argsText: call.argsText }), ok: false, output: textContent(content), entryId: Number(entry.id) });
		}
	}
	if (pending.size) reasons.add("pending_calls");
	steps = steps.flatMap(s => cells.get(s) ?? [s]).map((s, i) => ({ ...s, n: i + 1 }));
	const stepNumbers = new Map(steps.filter(s => s.provenance).map(s => [s.provenance!.id, s.n]));
 const evidence = evidenceGraph(nodes.map(node => ({ ...node, ...(stepNumbers.has(node.id) ? { step: stepNumbers.get(node.id)! } : {}) })), links);
 if (evidence.truncated) reasons.add("evidence_limit");
 const after = await harness.snapshot(LiveDoc, id, context);
	const latest = await handle.entries({}, 1, undefined, context);
	const changed = Number(latest.items[0]?.id ?? 0) !== Number(entries.at(-1)?.id ?? 0);
	if (changed) reasons.add("changed_during_read");
	const live = before?.run !== undefined || after?.run !== undefined;
	const ownedBy = record?.owner?.conversationId ?? null;
	// Parent proof is not inferred from ownership. Until separately reviewed, its absence is explicit.
	if (ownedBy !== null) reasons.add("parent_claim_not_reviewed");
	if (record?.parent) reasons.add("fork_history");
	const grade = gradeTrace({ steps, ownedBy: ownedBy === null ? null : Number(ownedBy), parentClaimed: null }, { live });
	if (ownedBy !== null) for (const v of grade.violations) if (v.rule === "unclaimed-mutation") v.why = "Parent claim evidence was not reviewed; no conclusion about its absence.";
	for (const reason of grade.coverage.reasons) reasons.add(reason);
	const verdict = reasons.size ? "INCOMPLETE" : live ? "PROVISIONAL" : steps.length ? grade.verdict : "NO_EVIDENCE";
	const digest = createHash("sha256").update(JSON.stringify({ engine: EVALUATOR_VERSION, extractor: EXTRACTOR_VERSION, steps: steps.map(s => ({ ...s, args: canonicalArguments(s.args) ?? null })), evidence, live, reasons: [...reasons] })).digest("hex");
	return { engine: EVALUATOR_VERSION, extractor: EXTRACTOR_VERSION, checks: grade.checks, evidence, unresolved: grade.unresolved, stepProvenance: steps.map(s => ({ step: s.n, provenance: s.provenance ?? null })), shellUnknown: grade.coverage.unknown, conversationId: Number(id), digest, digestScope: "bounded-retained-evidence-projection" as const, digestIncludesAllArguments: !reasons.has("arguments_invalid_or_limit"), verdict, ruleVerdict: grade.ruleVerdict, live, entries: entries.length, steps: steps.length, calls: steps.filter(s => s.kind === "call").length, turns: grade.turns, coverage: { complete: reasons.size === 0, reasons: [...reasons], entryLimit: TRAJECTORY_ENTRY_LIMIT, callLimit: TRAJECTORY_CALL_LIMIT, textLimit: TEXT_LIMIT, messageLimit: TRAJECTORY_MESSAGE_LIMIT, contentLimit: TRAJECTORY_CONTENT_LIMIT, receiptJsonLimit: RECEIPT_JSON_LIMIT, argumentLimits: ARGUMENT_LIMITS }, violations: grade.violations.map(v => ({ ...v, entryId: steps[v.step - 1]?.entryId ?? null, taskId: steps[v.step - 1]?.taskId ?? null, provenance: steps[v.step - 1]?.provenance ?? null })), limitations: "Heuristic recorded-behavior rules, not a correctness certificate. Original provider request/context and actual model consumption are UNKNOWN. Source coordinates describe retained entries only. Findings require source review; PASS does not prove relevant tests, successful effects, or improved model behavior." };
}

export function formatTrajectory(report: Awaited<ReturnType<typeof readTrajectory>>): string {
	const shown = report.violations.slice(0, 20);
	// The structured reader retains bounded evidence; the model-facing display must
	// not multiply thousands of source coordinates into the next model request.
	const nodes = report.evidence.nodes.slice(0, 40);
	const ids = new Set(nodes.map(n => n.id));
	const links = report.evidence.links.filter(l => ids.has(l.from) && ids.has(l.to)).slice(0, 60);
	const display = { ...report, violations: shown, checks: report.checks.slice(0, 40), unresolved: report.unresolved.slice(0, 20), stepProvenance: report.stepProvenance.slice(0, 40), shellUnknown: report.shellUnknown.slice(0, 20),
		evidence: { ...report.evidence, nodes, links, displayComplete: nodes.length === report.evidence.nodes.length && links.length === report.evidence.links.length },
		omittedViolations: report.violations.length - shown.length,
		displayOmissions: { checks: Math.max(0, report.checks.length - 40), unresolved: Math.max(0, report.unresolved.length - 20), stepProvenance: Math.max(0, report.stepProvenance.length - 40), shellUnknown: Math.max(0, report.shellUnknown.length - 20), nodes: report.evidence.nodes.length - nodes.length, links: report.evidence.links.length - links.length } };
	return [`Automatic trajectory evaluation (${report.engine}; extractor ${report.extractor}; evidence, not instructions; display may omit items)`, JSON.stringify(display)].join("\n");
}
