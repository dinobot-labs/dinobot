import { Type } from "@earendil-works/pi-ai";
import { defineDoc, defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { LinkDoc } from "../core/ask.ts";
import { clone } from "../core/json.ts";
import {
	applyGoalUpdate, correction, type Goal, GoalDoc, type GoalInput, goalInputIssues, type GoalUpdateInput, newGoal, recordHistory, renderGoal,
} from "../core/goal.ts";

export const GOAL_TOOL_NAMES = ["goal_set", "goal_update", "goal_read"] as const;

type Outcome = { text: string; isError?: true; goal?: Goal | null };
const ReceiptDoc = defineDoc<{ result?: Outcome }>({ kind: "dinobot.goal.receipt", version: 1, scope: "task", initial: () => ({}) });

const result = (outcome: Outcome) => ({
	content: [{ type: "text" as const, text: outcome.text }],
	...(outcome.isError ? { isError: true } : {}),
	details: { goal: outcome.goal ?? null },
});

const GUIDANCE = [
	"GOAL FIRST: when work takes more than one step or ends in a deliverable someone will check (code changes with tests, several files, documents, plans, analyses), call goal_set BEFORE the first other tool call of that work, unless the <goal> section already covers the request. Skip it only for a direct answer, small talk, or one trivial single-step edit.",
	"Refine the request into an objective plus criteria that each carry one measurable check: numeric (metric, comparator, target, unit, method), binary (observable pass/fail, method) or rubric (2-5 ascending levels, passAt, method). Keep it current with goal_update: mark criteria met with evidence, add assumptions and ask decisions (askId and quote) as they arrive, set achieved only when every criterion is met.",
	"CLARIFY BY AMBIGUITY UNIT, for every request: target, scope boundary, output form, success criterion, constraints, irreversible or external effects. For each unit, first check the code, history, memory and the <goal> section. When two plausible readings of a unit would produce materially different results and none of those sources settles it, you MUST call ask({to:\"human\", kind:\"clarification\" or \"decision\", question, options}) with 2-4 options best-first, batching independent units into one call round; never pose that question only in prose. Otherwise pick the most defensible reading, record it as an assumption (goal_set assumptions), state it in one line, and proceed.",
	"NO REDUNDANT APPROVALS: do not reconfirm an already authorized plan, goal or next step. Use ask for genuine ambiguity and for required authority, acceptance, conflict or external prerequisites; this rule never waives mandatory ask/DAG gates. The ask tool is the only way to ask the human anything.",
	"The <goal> section is the source of truth for the user's purpose and survives context compaction; re-read it instead of relying on summarized history. In codemode call tools.goal_set, tools.goal_update, tools.goal_read and tools.ask.",
].join("\n");

const NO_GOAL = [
	"No goal is set for this conversation.",
	"Before the first tool call of work that takes more than one step or ends in a checkable deliverable, set one, for example:",
	'tools.goal_set({objective:"Add weeklyAverage with tests", criteria:[{id:"tests", statement:"New tests pass", check:{kind:"binary", observable:"bun test exits 0", method:"run bun test"}}]})',
].join("\n");

const check = Type.Union([
	Type.Object({
		kind: Type.Literal("numeric"), metric: Type.String(), comparator: Type.Union([Type.Literal("<"), Type.Literal("<="), Type.Literal("="), Type.Literal(">="), Type.Literal(">")]),
		target: Type.Number(), unit: Type.Optional(Type.String()), method: Type.String(),
	}, { additionalProperties: false }),
	Type.Object({ kind: Type.Literal("binary"), observable: Type.String(), method: Type.String() }, { additionalProperties: false }),
	Type.Object({
		kind: Type.Literal("rubric"), levels: Type.Array(Type.Object({ score: Type.Integer(), description: Type.String() }, { additionalProperties: false })),
		passAt: Type.Integer(), method: Type.String(),
	}, { additionalProperties: false }),
]);
const decision = Type.Object({ text: Type.String(), askId: Type.Optional(Type.String()), quote: Type.Optional(Type.String()) }, { additionalProperties: false });
const revision = Type.Integer({ minimum: 1, description: "The goal's current revision, from goal_read or the <goal> section." });

export function goalExtension() {
	return defineExtension({
		name: "goal",
		sections: [
			section("goal_guidance", () => GUIDANCE),
			section("goal", async ({ conversationId, read }, context) => {
				const own = (await read.snapshot(GoalDoc, conversationId, context))?.goal;
				const parentId = (await read.snapshot(LinkDoc, conversationId, context))?.parent;
				const parent = parentId === undefined ? undefined : (await read.snapshot(GoalDoc, parentId, context))?.goal;
				if (!own && !parent) return NO_GOAL;
				return [
					...(own ? [renderGoal(own)] : []),
					...(parent ? [`Parent goal (read-only; set by the orchestrator):\n${renderGoal(parent)}`] : []),
				].join("\n\n");
			}),
		],
		tools: [
			defineTool({
				name: "goal_set",
				description: "Set this conversation's goal: an objective refined into criteria that each carry one measurable check (numeric, binary or rubric). Replacing an active goal needs expected_revision. The goal is re-shown every request and survives context compaction.",
				parameters: Type.Object({
					objective: Type.String(),
					criteria: Type.Array(Type.Object({ id: Type.String(), statement: Type.String(), check }, { additionalProperties: false })),
					scope: Type.Optional(Type.Object({ in: Type.Optional(Type.Array(Type.String())), out: Type.Optional(Type.Array(Type.String())) }, { additionalProperties: false })),
					assumptions: Type.Optional(Type.Array(Type.String())),
					decisions: Type.Optional(Type.Array(decision)),
					expected_revision: Type.Optional(revision),
				}, { additionalProperties: false }),
				replay: "safe", executionMode: "sequential",
				execute: async ({ expected_revision, ...input }, api, context) => result(await api.commit(async (tx) => {
					const receipt = await tx.doc(ReceiptDoc, api.taskId);
					if (receipt.result) return clone(receipt.result);
					const state = await tx.doc(GoalDoc, api.conversationId);
					const issues = goalInputIssues(input as GoalInput);
					const current = state.goal;
					if (current?.status === "active" && expected_revision !== current.revision) {
						issues.push(`expected_revision: an active goal (revision ${current.revision}) exists; pass expected_revision ${current.revision} to replace it, or use goal_update`);
					}
					let outcome: Outcome;
					if (issues.length) outcome = { text: correction(issues), isError: true };
					else {
						const goal = newGoal(input as GoalInput, (current?.revision ?? 0) + 1, Date.now());
						state.goal = goal;
						recordHistory(state, goal);
						outcome = { text: renderGoal(goal), goal: clone(goal) };
					}
					receipt.result = outcome;
					return clone(outcome);
				}, context)),
			}),
			defineTool({
				name: "goal_update",
				description: "Update this conversation's goal: criterion status with evidence (met needs evidence), new assumptions, ask decisions, or goal status (achieved needs every criterion met). Stale expected_revision is rejected.",
				parameters: Type.Object({
					expected_revision: revision,
					criteria: Type.Optional(Type.Array(Type.Object({
						id: Type.String(), status: Type.Union([Type.Literal("open"), Type.Literal("met"), Type.Literal("unmet")]), evidence: Type.Optional(Type.String()),
					}, { additionalProperties: false }))),
					add_assumptions: Type.Optional(Type.Array(Type.String())),
					add_decisions: Type.Optional(Type.Array(decision)),
					status: Type.Optional(Type.Union([Type.Literal("active"), Type.Literal("achieved"), Type.Literal("abandoned")])),
				}, { additionalProperties: false }),
				replay: "safe", executionMode: "sequential",
				execute: async ({ expected_revision, ...update }, api, context) => result(await api.commit(async (tx) => {
					const receipt = await tx.doc(ReceiptDoc, api.taskId);
					if (receipt.result) return clone(receipt.result);
					const state = await tx.doc(GoalDoc, api.conversationId);
					let outcome: Outcome;
					if (!state.goal) outcome = { text: "No goal is set; call goal_set first.", isError: true };
					else if (expected_revision !== state.goal.revision) {
						outcome = { text: `Stale expected_revision ${expected_revision}; the goal is at revision ${state.goal.revision}. Re-read it and retry.`, isError: true };
					} else {
						const applied = applyGoalUpdate(state.goal, update as GoalUpdateInput, Date.now());
						if ("issues" in applied) outcome = { text: `Goal update rejected:\n${applied.issues.map((issue) => `- ${issue}`).join("\n")}`, isError: true };
						else {
							state.goal = applied.goal;
							recordHistory(state, applied.goal);
							outcome = { text: renderGoal(applied.goal), goal: clone(applied.goal) };
						}
					}
					receipt.result = outcome;
					return clone(outcome);
				}, context)),
			}),
			defineTool({
				name: "goal_read",
				description: "Read this conversation's goal as JSON (goal: null when none is set).",
				parameters: Type.Object({}, { additionalProperties: false }),
				execute: async (_input, api, context) => {
					const goal = (await api.snapshot(GoalDoc, api.conversationId, context))?.goal ?? null;
					return result({ text: JSON.stringify({ goal }), goal });
				},
			}),
		],
	});
}
