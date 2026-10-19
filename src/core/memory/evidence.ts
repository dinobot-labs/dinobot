import type { EntryRecord } from "@earendil-works/pi-durable";
import { analyzeShell } from "../trajectory/shell.ts";
import { MEMORY_NOTE_KIND } from "../ui-contract.ts";
import { messageText } from "./curator.ts";

/**
 * Layered, drill-down evidence for a review window (AHE "experience observability", arXiv 2604.25850 §3.2; issue
 * taxonomy and false-positive filters after Agent Debugger's QC design), built deterministically from the raw
 * entries and the Harness record, with no model call:
 *
 *   L0 overview   counts: turns, tool calls by tool, tool errors by tool, failed checks, Harness lines
 *   L1 findings   taxonomy below; each cites raw refs and quotes a short piece of evidence
 *   L2 raw        the excerpt, every message labelled [e<entryId>], and the Harness lines labelled [h<n>]
 *
 * Taxonomy (L1 kinds):
 *   tool_error         a tool call failed (not a check, see filter F1)
 *   check_failed       a verifier command (test, typecheck, lint, build) failed: normal debugging, not a tool error
 *   repeated_failure   the same failing call (tool + arguments) failed more than once
 *   loop               the same call ran LOOP_RUN or more times in a row (behavioral loop, failing or not)
 *   truncated          an assistant message ended by the output limit or a provider error (early truncation)
 *   skill_unavailable  skills_load failed
 *   skill_unapplied    a loaded skill's actionable tokens (code spans, commands, paths) never appear in a later call
 *   harness            a blocked/repaired work or failed check from the Harness record
 * Filters: F1 failing verifier commands are check_failed, never tool_error, and never repeated_failure (rerunning a
 * failing test while fixing is expected); F2 a user abort is not truncation; F3 a skill with no actionable tokens
 * (pure guidance) or whose body is unknown is never skill_unapplied.
 *
 * Invariants (checked by test/memory-evidence.test.ts):
 *   E1 every finding has at least one ref, and every ref of a finding resolves to a label in L2,
 *      unless the finding is marked `raw: "omitted"` (its entry fell outside the bounded excerpt);
 *   E2 L2 keeps the newest messages within MAX_EXCERPT_CHARS and never splits a labelled message;
 *   E3 the layers are pure functions of (entries, harness lines): same input, same bytes.
 * The findings are heuristics, not conclusions; the raw layer stays available to check them.
 */
export const MAX_FINDINGS = 20;
export const LOOP_RUN = 3;
const MAX_MESSAGE_CHARS = 2_000;
const MAX_EXCERPT_CHARS = 60_000;
const MAX_OUTPUT_CHARS = 300;
const MAX_EVIDENCE_CHARS = 160;
const MAX_SKILL_TOKENS = 40;

export type FindingKind =
	| "tool_error" | "check_failed" | "repeated_failure" | "loop" | "truncated" | "skill_unavailable" | "skill_unapplied" | "harness";
export type Finding = {
	kind: FindingKind;
	summary: string;
	refs: string[];
	/** A short quote of the raw evidence. */
	evidence?: string;
	/** Set when a cited entry is not in the bounded excerpt. */
	raw?: "omitted";
};
export type WindowEvidence = { overview: string; findings: Finding[]; excerpt: string; harness: string[]; labels: Set<string> };

function clip(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/**
 * Actionable tokens of a skill body: inline code spans and fenced-code lines that look like commands, paths or
 * identifiers (contain `/ . _ - (` or a space, or are at least 8 characters). Empty for pure guidance (F3).
 */
export function skillActionTokens(body: string): string[] {
	const tokens = new Set<string>();
	const add = (raw: string) => {
		const token = raw.trim();
		if (token.length >= 4 && token.length <= 120 && (/[/._\-( ]/.test(token) || token.length >= 8)) tokens.add(token);
	};
	for (const match of body.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) for (const line of match[1]!.split("\n")) add(line.replace(/^\s*[$>#]\s*/, "").replace(/\s+#.*$/, ""));
	for (const match of body.replace(/```[\s\S]*?```/g, " ").matchAll(/`([^`\n]+)`/g)) add(match[1]!);
	return [...tokens].slice(0, MAX_SKILL_TOKENS);
}

/** Whether later calls visibly apply a loaded skill; undefined when the body has no actionable tokens (F3). */
export function skillApplied(name: string, body: string, laterArgs: readonly string[]): boolean | undefined {
	const tokens = skillActionTokens(body);
	if (laterArgs.some((args) => args.includes("skills_read_file") && args.includes(name))) return true;
	if (!tokens.length) return undefined;
	return laterArgs.some((args) => tokens.some((token) => args.includes(token)));
}

/** Skill name of a skills_load call: direct arguments, or a `skills_load({ name: "x" })` inside codemode code. */
export function loadedSkillNames(tool: string, args: unknown): string[] {
	if (tool === "skills_load") {
		const name = (args as { name?: unknown } | null)?.name;
		return typeof name === "string" ? [name] : [];
	}
	if (tool !== "codemode") return [];
	const code = String((args as { code?: unknown } | null)?.code ?? "");
	return [...code.matchAll(/skills_load\(\s*\{[^}]*?\bname\s*:\s*["'`]([^"'`]+)["'`]/g)].map((match) => match[1]!);
}

type ToolCall = { id: string; name: string; args: unknown; argsText: string; ref: string; seq: number };
type Load = { name: string; ref: string; seq: number; body?: string };

function resultText(content: unknown): string {
	return Array.isArray(content)
		? content.map((block: { type: string; text?: string }) => block.type === "text" ? block.text ?? "" : "").join("\n")
		: String(content ?? "");
}

export function windowEvidence(entries: readonly EntryRecord[], harnessLines: readonly string[]): WindowEvidence {
	const chunks: { ref: string; text: string }[] = [];
	const calls = new Map<string, ToolCall>();
	const sequence: ToolCall[] = [];
	const callsByTool = new Map<string, number>();
	const errorsByTool = new Map<string, number>();
	const failures = new Map<string, { tool: string; refs: string[]; evidence: string }>();
	const loads: Load[] = [];
	const findings: Finding[] = [];
	let userTurns = 0;
	let failedChecks = 0;
	for (const entry of entries) {
		if (entry.kind === MEMORY_NOTE_KIND) continue;
		const ref = `e${entry.id}`;
		for (const message of entry.model ?? []) {
			const role = message.role as string;
			if (role === "system") continue;
			if (role === "user") userTurns++;
			if (role === "assistant") {
				const assistant = message as { content: unknown; stopReason?: string; errorMessage?: string };
				if (Array.isArray(assistant.content)) for (const block of assistant.content) {
					if (block.type !== "toolCall") continue;
					const call = { id: block.id, name: block.name, args: block.arguments, argsText: JSON.stringify(block.arguments ?? {}), ref, seq: sequence.length };
					calls.set(block.id, call);
					sequence.push(call);
					callsByTool.set(block.name, (callsByTool.get(block.name) ?? 0) + 1);
					for (const name of loadedSkillNames(block.name, block.arguments)) loads.push({ name, ref, seq: call.seq });
				}
				// F2: "aborted" is a user/host stop, not the model failing to finish.
				if (assistant.stopReason === "length" || assistant.stopReason === "error") {
					findings.push({
						kind: "truncated", summary: `assistant message ended early (${assistant.stopReason})`, refs: [ref],
						evidence: clip(assistant.errorMessage ?? messageText(message as never).slice(-MAX_EVIDENCE_CHARS), MAX_EVIDENCE_CHARS),
					});
				}
			}
			if (role === "toolResult") {
				const result = message as { toolCallId: string; toolName: string; isError?: boolean; content: unknown };
				const output = resultText(result.content);
				const call = calls.get(result.toolCallId);
				const refs = call && call.ref !== ref ? [call.ref, ref] : [ref];
				if (result.toolName === "skills_load" && !result.isError && call) {
					try {
						const body = (JSON.parse(output) as { body?: unknown }).body;
						const load = loads.find((item) => item.seq === call.seq);
						if (load && typeof body === "string") load.body = body;
					} catch { /* not a JSON load result: body stays unknown (F3) */ }
				}
				if (result.isError) {
					const command = call?.name === "bash" ? String((call.args as { command?: unknown } | null)?.command ?? "") : "";
					const verifier = command ? analyzeShell(command).verifier : null;
					const evidence = clip(output, MAX_EVIDENCE_CHARS);
					if (verifier) {
						// F1: failing checks are part of debugging; they are reported, not counted as tool errors.
						failedChecks++;
						findings.push({ kind: "check_failed", summary: `${verifier} check failed: ${clip(command, 120)}`, refs, evidence });
					} else if (result.toolName === "skills_load") {
						errorsByTool.set(result.toolName, (errorsByTool.get(result.toolName) ?? 0) + 1);
						const names = call ? loadedSkillNames(call.name, call.args) : [];
						findings.push({ kind: "skill_unavailable", summary: `skills_load ${names[0] ?? "(unknown)"} failed`, refs, evidence });
					} else {
						errorsByTool.set(result.toolName, (errorsByTool.get(result.toolName) ?? 0) + 1);
						findings.push({ kind: "tool_error", summary: `${result.toolName} failed: ${clip(output, MAX_OUTPUT_CHARS)}`, refs, evidence });
						const key = `${result.toolName}\u0000${call?.argsText ?? ""}`;
						const seen = failures.get(key) ?? { tool: result.toolName, refs: [], evidence };
						seen.refs.push(ref);
						failures.set(key, seen);
					}
				}
				if (output.trim()) chunks.push({ ref, text: `[${ref}] tool ${result.toolName}${result.isError ? " (error)" : ""}: ${clip(output, MAX_OUTPUT_CHARS)}` });
				continue;
			}
			const text = messageText(message).trim();
			if (text) chunks.push({ ref, text: `[${ref}] ${role}: ${text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…` : text}` });
		}
	}
	for (const { tool, refs, evidence } of failures.values()) {
		if (refs.length > 1) findings.push({ kind: "repeated_failure", summary: `the same ${tool} call failed ${refs.length} times`, refs: [...new Set(refs)], evidence });
	}
	// Behavioral loops: maximal runs of identical consecutive calls.
	for (let start = 0; start < sequence.length;) {
		let end = start + 1;
		const key = `${sequence[start]!.name}\u0000${sequence[start]!.argsText}`;
		while (end < sequence.length && `${sequence[end]!.name}\u0000${sequence[end]!.argsText}` === key) end++;
		if (end - start >= LOOP_RUN) {
			const run = sequence.slice(start, end);
			findings.push({
				kind: "loop", summary: `${run[0]!.name} ran ${run.length} times in a row with the same arguments`,
				refs: [...new Set(run.map((call) => call.ref))], evidence: clip(run[0]!.argsText, MAX_EVIDENCE_CHARS),
			});
		}
		start = end;
	}
	for (const load of loads) {
		if (load.body === undefined) continue;
		const later = sequence.slice(load.seq + 1).map((call) => `${call.name} ${call.argsText}`);
		if (skillApplied(load.name, load.body, later) === false) {
			findings.push({
				kind: "skill_unapplied", summary: `skill ${load.name} was loaded but no later call uses its commands, paths or code`, refs: [load.ref],
				evidence: clip(skillActionTokens(load.body).slice(0, 3).join(" | "), MAX_EVIDENCE_CHARS),
			});
		}
	}
	const harness = harnessLines.map((line, index) => `[h${index + 1}] ${line}`);
	harnessLines.forEach((line, index) => {
		let value: Record<string, unknown> = {};
		try { value = JSON.parse(line) as Record<string, unknown>; } catch { /* non-JSON lines are cited as is */ }
		const evidence = clip(line, MAX_EVIDENCE_CHARS);
		if (typeof value.failedCheck === "string") findings.push({ kind: "harness", summary: `check ${value.failedCheck} of work ${String(value.work)} failed`, refs: [`h${index + 1}`], evidence });
		else if (value.state === "blocked" || (Array.isArray(value.blockers) && value.blockers.length) || (Array.isArray(value.repairs) && value.repairs.length)) {
			findings.push({ kind: "harness", summary: `work ${String(value.work)} ended ${String(value.state)} with ${Array.isArray(value.repairs) ? value.repairs.length : 0} method repairs and ${Array.isArray(value.blockers) ? value.blockers.length : 0} blockers`, refs: [`h${index + 1}`], evidence });
		}
	});
	// E2: newest messages first into the budget, whole chunks only, then restore order.
	const kept: string[] = [];
	let size = 0;
	for (let index = chunks.length - 1; index >= 0; index--) {
		const length = chunks[index]!.text.length + 2;
		if (size + length > MAX_EXCERPT_CHARS) break;
		kept.unshift(chunks[index]!.text);
		size += length;
	}
	const omitted = chunks.length - kept.length;
	const labels = new Set<string>([
		...chunks.slice(omitted).map((chunk) => chunk.ref),
		...harnessLines.map((_, index) => `h${index + 1}`),
	]);
	// Findings in raw order (by first ref), so the newest are kept by the cap.
	const order = (finding: Finding) => {
		const ref = finding.refs[0]!;
		return ref.startsWith("h") ? Number.MAX_SAFE_INTEGER - 1_000_000 + Number(ref.slice(1)) : Number(ref.slice(1));
	};
	const sorted = findings.map((finding, index) => ({ finding, index })).sort((a, b) => order(a.finding) - order(b.finding) || a.index - b.index).map(({ finding }) => finding);
	// E1: refs that fell out of the excerpt are flagged, never silently dangling.
	const shown = sorted.slice(-MAX_FINDINGS).map((finding) => finding.refs.every((ref) => labels.has(ref)) ? finding : { ...finding, raw: "omitted" as const });
	const tools = [...callsByTool.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => `${name} ${count}`).join(", ") || "none";
	const errors = [...errorsByTool.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => `${name} ${count}`).join(", ") || "none";
	const overview = [
		`user turns ${userTurns}; tool calls ${[...callsByTool.values()].reduce((a, b) => a + b, 0)} (${tools}); tool errors ${[...errorsByTool.values()].reduce((a, b) => a + b, 0)} (${errors}); failed checks ${failedChecks}`,
		`Harness lines ${harnessLines.length}; findings ${findings.length}${findings.length > shown.length ? ` (newest ${shown.length} shown)` : ""}${omitted ? `; ${omitted} older messages outside the excerpt` : ""}`,
	].join("\n");
	return { overview, findings: shown, excerpt: `${omitted ? "…\n\n" : ""}${kept.join("\n\n")}`, harness, labels };
}

export function renderFindings(findings: readonly Finding[]): string {
	if (!findings.length) return "(none)";
	return findings.map((finding) => `- ${finding.kind}: ${finding.summary} [${finding.refs.join(", ")}]${finding.evidence ? ` — "${finding.evidence}"` : ""}${finding.raw ? " (raw omitted)" : ""}`).join("\n");
}
