import { sliceByColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { PlanState, WorkflowStatus, WorkPlan } from "../../core/ui-contract.ts";
import { bold, color, glyph, type IconStatus, icons, separator, type Style } from "../theme.ts";

/** One rendered plan row: a requirement, or one of its checks indented beneath it. */
export type PlanRow = { key: string; kind: "requirement" | "check"; id: string; text: string; state: PlanState };

/** Every state has a distinct bracket mark and word, so color is never the only carrier (ADR 0015). */
const marks: Record<PlanState, string> = {
	met: glyph.todoCompleted, pending: glyph.todoPending, stale: glyph.planStale, running: glyph.todoInProgress,
	cancelled: glyph.todoCancelled, unknown: glyph.planUnknown, failed: glyph.planFailed,
};
const words: Record<PlanState, string> = {
	met: "met", pending: "not run", stale: "rerun", running: "running", cancelled: "cancelled", unknown: "unknown", failed: "failed",
};
/** Running is amber and success green (ADR 0015); yellow covers the states that need a rerun or a decision. */
const styles: Record<PlanState, Style> = {
	met: color.accentSuccess, pending: color.textPrimary, stale: color.warning, running: color.accentRunning,
	cancelled: color.warning, unknown: color.warning, failed: color.accentError,
};
export const planMark = (state: PlanState): string => marks[state];
export const planWord = (state: PlanState): string => words[state];
export const planStyle = (state: PlanState): Style => styles[state];

/** A plan is shown only for a selected, non-informational work item with at least one obligation. */
export function shownPlan(workflow: WorkflowStatus | null | undefined): WorkPlan | undefined {
	if (!workflow || workflow.status === "informational" || !workflow.plan || workflow.plan.requirements.length === 0) return undefined;
	return workflow.plan;
}

/** Requirements in contract order, each followed by its checks; `hideDone` drops met rows. Keys are unique per (requirement, check). */
export function planRows(plan: WorkPlan, hideDone: boolean): PlanRow[] {
	const checks = new Map(plan.checks.map((check) => [check.id, check]));
	const rows: PlanRow[] = [];
	for (const requirement of plan.requirements) {
		if (hideDone && requirement.state === "met") continue;
		rows.push({ key: `r:${requirement.id}`, kind: "requirement", id: requirement.id, text: requirement.assertion, state: requirement.state });
		for (const id of requirement.checkIds) {
			const check = checks.get(id);
			const state = check?.state ?? "pending";
			if (hideDone && state === "met") continue;
			rows.push({ key: `c:${requirement.id}/${id}`, kind: "check", id, text: check?.expected ?? "", state });
		}
	}
	return rows;
}

/** Cursor default: the first running row, else the first row that is not met, else the top. */
export function planFocus(rows: readonly PlanRow[]): number {
	const running = rows.findIndex((row) => row.state === "running");
	if (running >= 0) return running;
	const open = rows.findIndex((row) => row.state !== "met");
	return open >= 0 ? open : 0;
}

/**
 * λ(status, met, total). Only the host status may say "verified"; all checks met without a certificate is
 * "awaiting work_finish", never success.
 */
export function planLabel(workflow: WorkflowStatus, plan: WorkPlan): string {
	const { met, total, allMet } = planProgress(plan);
	const status = workflow.status;
	const phase = status === "verified" || status === "blocked" || status === "cancelled" ? status : allMet ? "awaiting work_finish" : status;
	return `Plan ${met}/${total} checks · ${phase}`;
}

/** The counts behind every "N/M checks" label; a plan with no checks is never all met. */
function planProgress(plan: WorkPlan): { met: number; total: number; allMet: boolean } {
	const met = plan.checks.filter((check) => check.state === "met").length;
	const total = plan.checks.length;
	return { met, total, allMet: total > 0 && met === total };
}

const fit = (text: string, width: number): string => {
	if (width <= 0) return "";
	if (visibleWidth(text) <= width) return text;
	const reserve = Math.max(1, visibleWidth(glyph.ellipsis));
	if (width <= reserve) return sliceByColumn(text, 0, width, true);
	return `${sliceByColumn(text, 0, width - reserve, true)}${glyph.ellipsis}`;
};

const CHECK_INDENT = 4;

export function planLine(row: PlanRow, width: number): string {
	const style = planStyle(row.state);
	const mark = style(planMark(row.state));
	if (row.kind === "requirement") {
		const head = `${planMark(row.state)} ${row.id} `;
		if (visibleWidth(head) >= width) return style(fit(head.trimEnd(), width));
		const text = fit(row.text, Math.max(0, width - visibleWidth(head)));
		const body = row.state === "met" ? color.grayBright(text) : row.state === "running" ? bold(color.textPrimary(text)) : color.textPrimary(text);
		return `${mark} ${color.textSecondary(row.id)} ${body}`;
	}
	const word = planWord(row.state);
	const head = `${" ".repeat(CHECK_INDENT)}${planMark(row.state)} ${row.id} ${word}  `;
	const room = width - visibleWidth(head);
	if (room < 0) return style(fit(head.trimEnd(), width));
	return `${" ".repeat(CHECK_INDENT)}${mark} ${color.textSecondary(row.id)} ${style(word)}  ${color.gray(fit(row.text, room))}`;
}

export function planPlaceholder(plan: WorkPlan): string {
	return plan.checks.every((check) => check.state === "met") ? "All checks met." : "Nothing left to show.";
}

type WorkflowPhase = Exclude<WorkflowStatus["status"], "informational">;
/** A workflow with an outcome to draw; absent work and informational sources draw nothing. */
export type ShownWorkflow = WorkflowStatus & { readonly status: WorkflowPhase };
export const shownWorkflow = (workflow: WorkflowStatus | null | undefined): workflow is ShownWorkflow => workflow != null && workflow.status !== "informational";

/**
 * Workflow state grammar, shared by the status row, subagent badges, details and history: a static mark and the
 * lowercase host status in its role color, the same shape as `statusText` for tools. Phases in progress are amber on
 * the open pending mark and never spin (motion belongs to running tools); coral is blocked, yellow cancelled.
 */
const workflowRoles: Record<WorkflowPhase, { readonly mark: IconStatus; readonly style: Style }> = {
	planning: { mark: "pending", style: color.accentRunning },
	implementing: { mark: "pending", style: color.accentRunning },
	verifying: { mark: "pending", style: color.accentRunning },
	verified: { mark: "done", style: color.accentSuccess },
	blocked: { mark: "failed", style: color.accentError },
	cancelled: { mark: "cancelled", style: color.warning },
};
export const workflowStyle = (workflow: ShownWorkflow): Style => workflowRoles[workflow.status].style;
const stateText = (workflow: ShownWorkflow): string => `${icons().status[workflowRoles[workflow.status].mark]} ${workflow.status}`;
/** `✓ verified`, `○ implementing`: the state segment alone, for badges. */
export const workflowState = (workflow: ShownWorkflow): string => workflowStyle(workflow)(stateText(workflow));

const BLOCKER_COLUMNS = 160;

/**
 * Metadata after the state: check progress, then why the work is not a success. Only the host status says verified;
 * every check met without a certificate still awaits work_finish, and anything else in progress is not verified.
 */
function workflowMeta(workflow: ShownWorkflow): string[] {
	const progress = workflow.plan && workflow.plan.checks.length > 0 ? planProgress(workflow.plan) : undefined;
	const unmet = workflow.unmetCheckIds.length;
	const parts: string[] = [];
	if (progress) parts.push(`${progress.met}/${progress.total} checks met`);
	else if (unmet > 0) parts.push(`${unmet} ${unmet === 1 ? "check" : "checks"} unmet`);
	const status = workflow.status;
	if (status === "blocked" || status === "cancelled") {
		const reason = stripTerminalSequences(workflow.blockers[0] ?? "").replace(/\s+/g, " ").trim();
		if (reason !== "") parts.push(fit(reason, BLOCKER_COLUMNS));
	} else if (status !== "verified") parts.push(progress?.allMet ? "awaiting work_finish" : "not verified");
	return parts;
}

/**
 * `mark word - meta - meta`: the state in its role color, then gray metadata joined like the turn-status row. Given a
 * width, plain text is cut before it is styled (an ellipsis from `truncateToWidth` would reset the color): the state
 * survives longest, the first part that does not fit is cut, and later parts are dropped.
 */
export function workflowText(workflow: ShownWorkflow, width = Number.POSITIVE_INFINITY): string {
	const style = workflowStyle(workflow);
	const state = stateText(workflow);
	let room = width - visibleWidth(state);
	if (room < 0) return style(fit(state, width));
	let text = style(state);
	const ellipsis = visibleWidth(glyph.ellipsis);
	for (const part of workflowMeta(workflow)) {
		const piece = `${separator.meta}${part}`;
		if (visibleWidth(piece) <= room) {
			text += color.gray(piece);
			room -= visibleWidth(piece);
			continue;
		}
		if (room > visibleWidth(separator.meta) + ellipsis) text += color.gray(fit(piece, room));
		else if (room >= ellipsis) text += color.gray(glyph.ellipsis);
		break;
	}
	return text;
}
