import { defineDoc } from "@earendil-works/pi-durable";
import { clone } from "./json.ts";

/**
 * A conversation's durable goal (ADR 0071). The goal lives in a document, not in the transcript, and the goal
 * extension re-renders it into the system prompt on every request, so context compaction cannot drop it.
 * Every criterion carries exactly one machine-checkable check: numeric, binary or rubric.
 */

export type GoalCheck =
	| { kind: "numeric"; metric: string; comparator: "<" | "<=" | "=" | ">=" | ">"; target: number; unit?: string; method: string }
	| { kind: "binary"; observable: string; method: string }
	| { kind: "rubric"; levels: { score: number; description: string }[]; passAt: number; method: string };
export type CriterionStatus = "open" | "met" | "unmet";
export type GoalCriterion = { id: string; statement: string; check: GoalCheck; status: CriterionStatus; evidence?: string };
export type GoalDecision = { text: string; askId?: string; quote?: string };
export type GoalStatus = "active" | "achieved" | "abandoned";
export type Goal = {
	objective: string;
	criteria: GoalCriterion[];
	scope: { in: string[]; out: string[] };
	assumptions: string[];
	decisions: GoalDecision[];
	status: GoalStatus;
	revision: number;
	createdAt: number;
	updatedAt: number;
};
export type GoalState = { goal?: Goal; history: { revision: number; at: number; objective: string; status: GoalStatus }[] };

export const GoalDoc = defineDoc<GoalState>({
	kind: "dinobot.goal", version: 1, scope: "conversation", history: "latest", fork: "initial",
	initial: () => ({ history: [] }),
});

export const GOAL_LIMITS = { objective: 2000, criteria: 12, text: 500, list: 20, decisions: 50, history: 20, render: 6000 } as const;
const CRITERION_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const COMPARATORS = ["<", "<=", "=", ">=", ">"] as const;

export const CHECK_EXAMPLES = [
	'{"id":"p95","statement":"Checkout API stays fast","check":{"kind":"numeric","metric":"p95_latency","comparator":"<=","target":250,"unit":"ms","method":"bench script, 3 runs"}}',
	'{"id":"tests","statement":"Suite is green","check":{"kind":"binary","observable":"bun test exits 0","method":"run bun test"}}',
	'{"id":"tone","statement":"Reply reads naturally","check":{"kind":"rubric","levels":[{"score":1,"description":"robotic"},{"score":3,"description":"mostly natural"},{"score":5,"description":"native"}],"passAt":3,"method":"self-review against levels"}}',
] as const;

export type GoalInput = {
	objective: string;
	criteria: { id: string; statement: string; check: GoalCheck }[];
	scope?: { in?: string[]; out?: string[] };
	assumptions?: string[];
	decisions?: GoalDecision[];
};
export type GoalUpdateInput = {
	criteria?: { id: string; status: CriterionStatus; evidence?: string }[];
	add_assumptions?: string[];
	add_decisions?: GoalDecision[];
	status?: GoalStatus;
};

const text = (value: unknown, max: number = GOAL_LIMITS.text): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max;

function textList(label: string, values: readonly unknown[] | undefined, issues: string[]): void {
	if (values === undefined) return;
	if (values.length > GOAL_LIMITS.list) issues.push(`${label}: at most ${GOAL_LIMITS.list} entries`);
	values.forEach((value, index) => { if (!text(value)) issues.push(`${label}[${index}]: 1-${GOAL_LIMITS.text} non-blank characters`); });
}

function decisionIssues(label: string, decisions: readonly GoalDecision[] | undefined, issues: string[]): void {
	if (decisions === undefined) return;
	if (decisions.length > GOAL_LIMITS.list) issues.push(`${label}: at most ${GOAL_LIMITS.list} entries`);
	decisions.forEach((decision, index) => {
		if (!text(decision.text)) issues.push(`${label}[${index}].text: 1-${GOAL_LIMITS.text} non-blank characters`);
		if (decision.quote !== undefined && !text(decision.quote, 2000)) issues.push(`${label}[${index}].quote: 1-2000 non-blank characters`);
	});
}

/** Why `check` is not a measurable check, or none. */
export function checkIssues(check: GoalCheck, label: string): string[] {
	const issues: string[] = [];
	if (!text(check?.method)) issues.push(`${label}.method: say how it is measured or observed`);
	switch (check?.kind) {
		case "numeric":
			if (!text(check.metric, 200)) issues.push(`${label}.metric: name the measured quantity`);
			if (!COMPARATORS.includes(check.comparator)) issues.push(`${label}.comparator: one of ${COMPARATORS.join(" ")}`);
			if (typeof check.target !== "number" || !Number.isFinite(check.target)) issues.push(`${label}.target: a finite number`);
			if (check.unit !== undefined && !text(check.unit, 40)) issues.push(`${label}.unit: 1-40 characters when given`);
			break;
		case "binary":
			if (!text(check.observable)) issues.push(`${label}.observable: the pass/fail observation`);
			break;
		case "rubric": {
			const levels = Array.isArray(check.levels) ? check.levels : [];
			if (levels.length < 2 || levels.length > 5) issues.push(`${label}.levels: 2-5 levels`);
			if (levels.some((level, index) => !Number.isInteger(level?.score) || (index > 0 && level.score <= levels[index - 1]!.score))) issues.push(`${label}.levels: integer scores in strictly ascending order`);
			levels.forEach((level, index) => { if (!text(level?.description)) issues.push(`${label}.levels[${index}].description: describe the level`); });
			if (!levels.some((level) => level?.score === check.passAt)) issues.push(`${label}.passAt: equal to one of the level scores`);
			break;
		}
		default:
			issues.push(`${label}.kind: numeric, binary or rubric`);
	}
	return issues;
}

export function goalInputIssues(input: GoalInput): string[] {
	const issues: string[] = [];
	if (!text(input.objective, GOAL_LIMITS.objective)) issues.push(`objective: 1-${GOAL_LIMITS.objective} non-blank characters`);
	if (!Array.isArray(input.criteria) || input.criteria.length < 1 || input.criteria.length > GOAL_LIMITS.criteria) {
		issues.push(`criteria: 1-${GOAL_LIMITS.criteria} criteria`);
	}
	const ids = new Set<string>();
	(input.criteria ?? []).forEach((criterion, index) => {
		const label = `criteria[${index}]`;
		if (typeof criterion.id !== "string" || !CRITERION_ID.test(criterion.id)) issues.push(`${label}.id: lowercase letters, digits and hyphens, at most 40`);
		else if (ids.has(criterion.id)) issues.push(`${label}.id: duplicate id "${criterion.id}"`);
		else ids.add(criterion.id);
		if (!text(criterion.statement)) issues.push(`${label}.statement: 1-${GOAL_LIMITS.text} non-blank characters`);
		issues.push(...checkIssues(criterion.check, `${label}.check`));
	});
	textList("scope.in", input.scope?.in, issues);
	textList("scope.out", input.scope?.out, issues);
	textList("assumptions", input.assumptions, issues);
	decisionIssues("decisions", input.decisions, issues);
	return issues;
}

export function correction(issues: readonly string[]): string {
	return [
		"Goal rejected:",
		...issues.map((issue) => `- ${issue}`),
		"Every criterion needs exactly one measurable check. Examples:",
		...CHECK_EXAMPLES.map((example) => `  ${example}`),
	].join("\n");
}

export function newGoal(input: GoalInput, revision: number, now: number): Goal {
	return {
		objective: input.objective.trim(),
		criteria: input.criteria.map((criterion) => ({ id: criterion.id, statement: criterion.statement.trim(), check: clone(criterion.check), status: "open" })),
		scope: { in: [...(input.scope?.in ?? [])], out: [...(input.scope?.out ?? [])] },
		assumptions: [...(input.assumptions ?? [])],
		decisions: (input.decisions ?? []).map((decision) => ({ ...decision })),
		status: "active",
		revision,
		createdAt: now,
		updatedAt: now,
	};
}

/** Apply `update` to a copy of `goal`; issues when the update is invalid for the current goal. */
export function applyGoalUpdate(goal: Goal, update: GoalUpdateInput, now: number): { goal: Goal } | { issues: string[] } {
	const issues: string[] = [];
	const next = clone(goal);
	for (const [index, change] of (update.criteria ?? []).entries()) {
		const criterion = next.criteria.find((item) => item.id === change.id);
		if (!criterion) { issues.push(`criteria[${index}].id: no criterion "${change.id}"`); continue; }
		if (!["open", "met", "unmet"].includes(change.status)) { issues.push(`criteria[${index}].status: open, met or unmet`); continue; }
		if (change.status === "met" && !text(change.evidence, 2000)) { issues.push(`criteria[${index}].evidence: "met" needs the observed evidence`); continue; }
		criterion.status = change.status;
		if (change.evidence !== undefined) criterion.evidence = change.evidence;
	}
	textList("add_assumptions", update.add_assumptions, issues);
	decisionIssues("add_decisions", update.add_decisions, issues);
	next.assumptions = [...next.assumptions, ...(update.add_assumptions ?? [])].slice(-GOAL_LIMITS.list);
	next.decisions = [...next.decisions, ...(update.add_decisions ?? []).map((decision) => ({ ...decision }))].slice(-GOAL_LIMITS.decisions);
	if (update.status !== undefined) {
		if (update.status === "achieved") {
			const open = next.criteria.filter((criterion) => criterion.status !== "met").map((criterion) => criterion.id);
			if (open.length) issues.push(`status: "achieved" needs every criterion met; not met: ${open.join(", ")}`);
		}
		next.status = update.status;
	}
	if (issues.length) return { issues };
	next.revision = goal.revision + 1;
	next.updatedAt = now;
	return { goal: next };
}

export function recordHistory(state: GoalState, goal: Goal): void {
	state.history = [...state.history, { revision: goal.revision, at: goal.updatedAt, objective: goal.objective, status: goal.status }].slice(-GOAL_LIMITS.history);
}

export function describeCheck(check: GoalCheck): string {
	switch (check.kind) {
		case "numeric": return `numeric: ${check.metric} ${check.comparator} ${check.target}${check.unit ? ` ${check.unit}` : ""} via ${check.method}`;
		case "binary": return `binary: ${check.observable} via ${check.method}`;
		case "rubric": return `rubric: pass at >=${check.passAt}/${check.levels.at(-1)?.score ?? check.passAt} (${check.levels.map((level) => `${level.score}=${level.description}`).join("; ")}) via ${check.method}`;
	}
}

function lines(goal: Goal, recent: number): string[] {
	return [
		`Objective: ${goal.objective}`,
		`Status: ${goal.status} (revision ${goal.revision})`,
		"Criteria:",
		...goal.criteria.map((criterion) => `- [${criterion.status}] ${criterion.id}: ${criterion.statement} — ${describeCheck(criterion.check)}${criterion.evidence ? ` | evidence: ${criterion.evidence}` : ""}`),
		...(goal.scope.in.length ? [`In scope: ${goal.scope.in.join("; ")}`] : []),
		...(goal.scope.out.length ? [`Out of scope: ${goal.scope.out.join("; ")}`] : []),
		...(recent && goal.assumptions.length ? ["Assumptions:", ...goal.assumptions.slice(-recent).map((item) => `- ${item}`)] : []),
		...(recent && goal.decisions.length ? ["Decisions:", ...goal.decisions.slice(-recent).map((item) => `- ${item.text}${item.askId ? ` (ask ${item.askId})` : ""}`)] : []),
	];
}

/** Deterministic text of `goal`, at most `GOAL_LIMITS.render` characters; recent assumptions and decisions shrink first. */
export function renderGoal(goal: Goal): string {
	for (const recent of [10, 5, 2, 0]) {
		const rendered = lines(goal, recent).join("\n");
		if (rendered.length <= GOAL_LIMITS.render) return rendered;
	}
	return lines(goal, 0).join("\n").slice(0, GOAL_LIMITS.render);
}
