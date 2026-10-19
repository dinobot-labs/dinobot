import { dinobotSkill } from "./dinobot/index.ts";
import { writingSkill } from "./writing/index.ts";
import { frontendCraftSkill } from "./frontend-craft/index.ts";
import { explanationSkill } from "./explanation/index.ts";
import { herdrSkill } from "./herdr/index.ts";
import { researchSkill } from "./research.ts";
import { slackSetupSkill } from "./slack-setup/index.ts";

// Public snapshot project instructions. Catalog identifiers remain stable.
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
		description: "Project-specific optimization checks for dinobot.",
		body: `# Optimization

## Workflow

For TUI changes, run script/bench/tui-render.ts and script/bench/tui-cadence.ts with the Bun version and operating system recorded. The acceptance budgets are in test/tui-perf.test.ts; keep them unchanged. For daemon work, record the affected request duration without session contents. Compare the same input on the original and patched checkout, including failed runs. Verify displayed text and keyboard behavior alongside render timings.`,
	},
	{
		name: "debugging",
		description: "Project-specific debugging checks for dinobot.",
		body: `# Debugging

## Workflow

Locate the failing dinobot boundary: CLI startup, daemon API, conversation turn, tool call or TUI update. Record its command, Bun version and platform. Create a test with synthetic conversations and temporary storage rather than a live database. Follow the request from caller to handler and include cancellation and a second request when state survives between calls. Run that test on both sides of the patch. Report whether the requested operation completes, not just whether a connection opened.`,
	},
	{
		name: "clarification",
		description: "Resolve missing dinobot task scope before changing state.",
		body: `# Clarification

Inspect the selected repository, manifest and requested client first. If the task could affect either a local daemon or a deployed service, establish which target is intended. Use ask for missing decisions and goal_set for the accepted outcome. Record the affected paths and the command or visible behavior that will demonstrate completion. Do not infer permission to publish from a request to prepare local files.`, 
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
