import { dinobotSkill } from "./dinobot/index.ts";
import { writingSkill } from "./writing/index.ts";
import { frontendCraftSkill } from "./frontend-craft/index.ts";
import { explanationSkill } from "./explanation/index.ts";
import { herdrSkill } from "./herdr/index.ts";
import { researchSkill } from "./research.ts";
import { slackSetupSkill } from "./slack-setup/index.ts";

export const bundledSkills = [
	{
		name: "programming",
		description: "Core discipline for programming work: implementing, changing, refactoring, or designing code, interfaces, and state. Reuse before writing, close the change set (with LSP when available), confine state mutation to single points, and abstract real strategy variants. Routes bugs to debugging and performance work to optimization.",
		body: `# Programming

Treat every change as a transformation of a system you can state precisely. Analyze and design mathematically: define the state space, the operations that transition it, the invariants that hold before and after each operation, and the exact set of code a change can affect. Side effects are part of a contract, not incidental details.

## Specialized situations (load on demand)

Load these only when the situation applies, with skills_load (tools.skills_load in codemode), and follow them in addition to this skill:

- debugging: bugs, failing tests, unexpected behavior, regressions, timeouts, races.
- optimization: slow code, latency, throughput, memory, cost, or requests to optimize.
- research: a bounded evidence-based comparison or hypothesis investigation whose deliverable is a verdict, not search results or implementation. Ordinary code lookup does not require research.

If programming work turns into one of these situations, load the matching skill at that point. Keep applying the rules below to every line you change.

## Closed change set

Before editing, define the closed region of the change: the definitions, callers, implementations, state, serialized forms, and external contracts the change can affect, such that nothing outside the region can observe a difference.

1. Check lsp status first (tools.lsp in codemode). When a server is available, enumerate the region with definition, references, hover (types and signatures), document_symbols, workspace_symbols, and diagnostics rather than text search alone. Input positions are 1-based UTF-16. LSP is read-only; make edits with the managed edit tools and query again afterward. Missing or stale diagnostics are not proof of correctness.
2. Without LSP, search exhaustively for the symbol, re-exports, dynamic or string references, configuration, persisted data, and tests. State that the closure is search-based.
3. For each element in the region, record the preconditions it relies on, the postconditions it provides, and its side effects: state mutation, I/O, ordering, errors, and timing.
4. The region is closed when every element whose contract changes is updated inside it and every boundary keeps its contract. If a boundary cannot be closed, shrink the change or make the contract change explicit.
5. After editing, enumerate again (references, diagnostics, type check, tests) and confirm the region is still closed.

## Reuse before writing

1. Before adding a function, type, interface, or module, search for an existing one with the same responsibility by name, signature, and behavior.
2. Reuse only when the semantics match: the same meaning, inputs, outputs, error behavior, and side effects. Similar shape or naming is not evidence.
3. If reuse requires changing a shared component, analyze every caller in its closed region. A behavior change for existing callers is a side effect that must be justified and verified per caller, or avoided through composition or a narrower extension.
4. Do not duplicate an existing responsibility. Do not force reuse that couples unrelated meanings.

## Strategy abstraction

When several code paths play the same role with varying behavior (the same input/output contract with a different algorithm or policy), try extracting the variation behind one interface and selecting the strategy at a single point.

- Abstract only over a real, stated contract: identical preconditions, postconditions, and error semantics across existing concrete variants. Do not abstract for hypothetical future variants.
- Select the strategy in one place. Variants must not branch on each other.
- Keep the duplication when the abstraction would add more indirection than it removes, or when the variants differ in contract.

## State changes

- Model state explicitly: the values that exist, the valid transitions, and the invariants that must always hold.
- Narrow each piece of state to a single mutation point (one owner, function, reducer, or transaction). Other code reads it or requests transitions.
- Keep one source of truth for each fact. Derive values instead of storing copies that can diverge.
- For complex state, reduce the number of mutation points and representable states: make invalid combinations unrepresentable, make transitions atomic, and check invariants at the boundary.
- Before changing state handling, list every current writer. A change must not increase the number of writers without a stated reason.

## Refactoring

Refactoring preserves observable behavior. Define the closed region, state the invariant that behavior at every boundary is unchanged, and proceed in small steps that each keep the region closed and verification passing. Do not mix behavior changes into a refactoring step.

## Completion evidence

Report the components reused or added and why, the closed region and how it was enumerated (LSP or search), the state mutation points before and after, any abstraction introduced and its contract, and the verification actually run.`,
	},
	{
		name: "optimization",
		description: "Measurement-driven performance optimization. Use for slow code, latency, throughput, memory, cost, bottlenecks, or requests to optimize; measure before adding complexity.",
		body: `# Optimization

Based on Rob Pike's five rules of programming: do not guess where time goes; measure before tuning; simple algorithms often win for small inputs; complicated algorithms invite bugs; good data structures simplify algorithms.

## Workflow

1. Define the workload and target metric: latency (including tails such as p95), throughput, memory, allocations, or cost. Record input sizes, concurrency, environment, and the desired outcome. Ask only for missing choices that materially affect the target; investigate answers available in the repository yourself.
2. Inspect existing benchmarks, tracing, metrics, logs, and profilers. Run existing measurements when safe. If evidence is missing, add the smallest focused benchmark or instrumentation needed before changing performance behavior. Do not broadly instrument the application or record secrets.
3. Capture a baseline on a representative workload. Repeat measurements enough to distinguish noise from an effect. Record commands, conditions, and observed values; never invent numbers or claim improvement from code inspection alone.
4. Identify the measured bottleneck or resource driver relevant to the target. It need not dominate total runtime: tail latency, memory pressure, and recurring cost can matter independently. State one falsifiable hypothesis and its expected effect.
5. Check actual input sizes and data layout before introducing an algorithm, cache, custom allocator, or concurrency. Big-O alone is not evidence; constants and workload matter. Prefer a better data structure or eliminating unnecessary work over added machinery. Check invalidation, memory bounds, and synchronization costs when relevant.
6. Apply the simplest change addressing the measured problem. Avoid unrelated cleanup and speculative optimization. Preserve semantics and error handling.
7. Run correctness and regression tests, then remeasure the same workload under comparable conditions. Report baseline, result, variability, and tradeoffs. Do not compare incompatible environments or cherry-pick a single run. If the effect is absent or harmful, reject the optimization rather than claiming success; never discard unrelated user work.

## Guardrails

- A loop that looks slow, an O(n²) label, or the possibility of caching is not proof of a problem.
- Do not assert fixed timings from input size alone.
- Do not parallelize without distinguishing CPU, I/O, contention, and scheduling costs.
- Complexity must earn its place through a meaningful measured benefit to the target metric.
- If measurement is blocked, state the missing evidence and blocker; do not label an unmeasured change an optimization success.

## Completion evidence

Keep the target/workload, reproducible measurement commands, baseline, hypothesis, change, correctness results, and comparable after-measurements. Summarize the meaningful outcome concisely.`,
	},
	{
		name: "debugging",
		description: "Evidence-first debugging for bugs, failing tests, unexpected behavior, timeouts, races, and regressions. Reproduce or observe, isolate one cause, lock a failing guard, then fix and verify.",
		body: `# Debugging

Fix the cause, not the symptom. Prevent guess-based patches and lock the failure before fixing it.

## Gates for a root-cause fix

- Obtain a reproducible or observable failure before changing behavior.
- State an evidence-backed, falsifiable root-cause hypothesis.
- Establish a failing test or equivalent reproduction guard before the fix.
- Test one hypothesis at a time; do not bundle speculative fixes.
- Do not mix unrelated refactoring, formatting, or renaming into a fix.

## Workflow

1. Define the problem: expected behavior, observed behavior, conditions, impact, and whether it is intermittent. Separate facts from speculation.
2. Reproduce or instrument. Prefer an existing failing test, a minimal integration/unit test, then a reproduction command or focused logs/assertions. For UI problems, use a lower-layer reproduction when it captures the same failure. Preserve a UI-level check when the defect depends on rendering or interaction. If reproduction fails, inspect inputs, environment differences, recent changes, and component boundaries rather than guessing a patch.
3. Gather evidence: complete errors and stack traces, failing inputs, configuration, recent changes, and call/data flow. At boundaries inspect what entered, what exited, and what changed. Use available semantic tools to trace definitions and references. Do not interpret unavailable or stale diagnostics as proof of correctness. Avoid logging secrets.
4. Isolate one root cause: “Hypothesis: <cause> because <observed evidence>.” Trace invalid data to its source, not just where the error surfaced. Design a small experiment capable of disproving the hypothesis.
5. Lock the failure. Add an automated regression test whenever feasible; otherwise keep a minimal script, command, or log/assertion check. Observe it failing before the fix and preserve the same check for after. Name the test for the broken behavior. Do not delegate this requirement to an unavailable skill.
6. Implement the smallest complete fix addressing the hypothesis, including directly affected callsites. Do not swallow exceptions or add defensive guards without evidence. If it fails, reassess both the hypothesis and the implementation; a failed patch does not by itself disprove the cause.
7. Verify the original reproduction, the regression guard, and related tests. For intermittent failures, repeat under relevant inputs, schedules, or concurrency conditions; one passing run is insufficient. Explain how the fix prevents the cause and report any remaining uncertainty.

## Emergency mitigation

During an active incident, authorized rollback, isolation, or disabling a harmful path can precede full reproduction to limit damage. Distinguish mitigation from a verified root-cause fix. Record evidence, impact, and the action taken; preserve the investigation and regression-test requirement. This skill does not grant deployment, deletion, or other destructive-action authority.

## Stop and reassess

- If the failure cannot be reproduced or observed, improve evidence or report the blocker; do not fabricate a guard or declare a root-cause fix complete.
- After three failed fix attempts, stop patching and reassess evidence, hypotheses, shared state, boundaries, and ownership. Escalate when an actual missing decision or access blocks investigation, not merely to perform ceremony.
- “It looks obvious,” “test later,” and “the error disappeared” are not verification.

## Completion evidence

Keep seven items: problem statement, reproduction path, observed evidence, root-cause hypothesis, failing guard, targeted fix, and post-fix verification. A code change alone is not completion. Report mitigation or blocked investigation honestly when a verified fix is not possible.`,
	},
	{
		name: "clarification",
		description: "Clarify ambiguous or underspecified requests before acting: explore code, history and memory first, ask only through the ask tool for ambiguity units that would change the result, never ask for approval, then record a measurable goal with goal_set.",
		body: `# Clarification

Turn a vague request into a measurable goal without wasting the human's attention. Resolve ambiguity per unit, for every kind of request: coding, writing, research, operations or a plain chat task.

## Ambiguity units

Check each unit separately: target (what object or system), scope boundary (what is in and out), output form, success criterion, constraints (time, compatibility, cost, audience), and irreversible or external effects. A request can be clear on some units and ambiguous on others; ask only about the ambiguous ones.

## Explore before asking

Read the relevant code or files, search sessions and memory, and read the <goal> section first. Never ask what those sources answer. Ground every question in what you found: "\`src/pay/retry.ts\` already retries 3 times; keep that policy or replace it?"

## When to ask

Ask only when two plausible readings would produce materially different results and nothing you can read settles it.

- Use ask({to:"human", kind:"clarification" or "decision", question, options}) with 2-4 short options, best first.
- Batch independent units into one round; at most 3 human decision/clarification asks may be open. Dependent units wait for the next round, because an earlier answer can change them.
- A human ask returns immediately: relay the question and options, then end the turn. When the human answers, resolve it with answer({ask_id, answer, quote}).

## Never ask for approval

Do not ask the human to approve or confirm a plan, a goal or a next step. Every unit not worth asking becomes an assumption: pick the most defensible reading, state it in one line, record it, and proceed.

## Output: a measurable goal

Finish with goal_set, not a prose brief. The objective is one sentence. Each criterion carries exactly one check:

- numeric: {"id":"p95","statement":"Checkout stays fast","check":{"kind":"numeric","metric":"p95_latency","comparator":"<=","target":250,"unit":"ms","method":"bench script, 3 runs"}}
- binary: {"id":"tests","statement":"Suite is green","check":{"kind":"binary","observable":"bun test exits 0","method":"run bun test"}}
- rubric: {"id":"tone","statement":"Reply reads naturally","check":{"kind":"rubric","levels":[{"score":1,"description":"robotic"},{"score":3,"description":"mostly natural"},{"score":5,"description":"native"}],"passAt":3,"method":"self-review against levels"}}

Prefer numeric when a real quantity decides success, binary when one observation decides it, and rubric for judgment-heavy quality (writing, design, tone). Put stated or assumed boundaries in scope.in and scope.out, and every assumption in assumptions.

## After answers

Record each answer with goal_update({expected_revision, add_decisions:[{text, askId, quote}]}). Mark a criterion met only with the observed evidence, and set status achieved only when every criterion is met. After context compaction, the <goal> section is the source of truth.

## Routing

- One step: act directly.
- Several dependent steps: dag_run with goal.requirements equal to the goal's criterion ids, so DAG verification proves the goal.

## Red flags

- The same topic asked three times: the human does not know. Stop asking, state the assumptions, proceed.
- "Just do it": state the remaining assumptions in one line and proceed.
- Existing code conflicts with the request: that is a decision; ask it.
- The request splits into independent goals: set the first goal, list the rest as out of scope.`,
	},
	researchSkill,
	// Project-authored optional Herdr integration note.
	herdrSkill,
	dinobotSkill,
	// Owner-authored voice guide for Korean tech writing (roach-newsletter WRITING.md lineage).
	writingSkill,
	// Landing/marketing page workflow distilled from services/landing (ADR 0086).
	frontendCraftSkill,
	// Explanation workflow: prose is written with the writing skill's rules (openwiki/architecture/skills.md).
	explanationSkill,
	// Guided Slack connection with a paste-in app manifest and verification/restart scripts (hermes-agent style).
	slackSetupSkill,
] as const;
