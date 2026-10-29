// proof-skills by Opum AI (https://github.com/opum-ai/proof-skills, MIT, see ./LICENSE.txt), pinned at
// commit 578749fd8baa6456d89d7a0037c88bc09a89213d. Files are vendored verbatim; non-Markdown files ship with a .txt suffix so TypeScript does
// not resolve them and are exposed under their real names. Regenerate from a checkout instead of editing by hand.
import license from "./LICENSE.txt" with { type: "text" };
import { dinobotNote } from "./note.ts";

import f0 from "./formal-verify/SKILL.md" with { type: "text" };
import f1 from "./formal-verify/assets/CORRESPONDENCE.md" with { type: "text" };
import f2 from "./formal-verify/assets/findings.schema.json.txt" with { type: "text" };
import f3 from "./formal-verify/references/choosing-tools.md" with { type: "text" };
import f4 from "./formal-verify/references/ci-and-drift.md" with { type: "text" };
import f5 from "./formal-verify/references/correspondence.md" with { type: "text" };
import f6 from "./formal-verify/references/evidence.md" with { type: "text" };
import f7 from "./formal-verify/references/report-artifact.md" with { type: "text" };
import f8 from "./formal-verify/references/reproduce-and-fix.md" with { type: "text" };
import f9 from "./formal-verify/references/workflows.md" with { type: "text" };
import f10 from "./formal-verify/scripts/correspondence_check.py.txt" with { type: "text" };
import f11 from "./formal-verify/scripts/doctor.sh.txt" with { type: "text" };
import f12 from "./formal-verify/scripts/graph_svg.py.txt" with { type: "text" };
import f13 from "./tlaplus-model/SKILL.md" with { type: "text" };
import f14 from "./tlaplus-model/assets/patterns/.gitignore.txt" with { type: "text" };
import f15 from "./tlaplus-model/assets/patterns/BatchPipeline/BatchPipeline.tla.txt" with { type: "text" };
import f16 from "./tlaplus-model/assets/patterns/BatchPipeline/MC.cfg.txt" with { type: "text" };
import f17 from "./tlaplus-model/assets/patterns/BatchPipeline/MC_bug.cfg.txt" with { type: "text" };
import f18 from "./tlaplus-model/assets/patterns/BatchPipeline/MC_sanity.cfg.txt" with { type: "text" };
import f19 from "./tlaplus-model/assets/patterns/CacheAside/CacheAside.tla.txt" with { type: "text" };
import f20 from "./tlaplus-model/assets/patterns/CacheAside/MC.cfg.txt" with { type: "text" };
import f21 from "./tlaplus-model/assets/patterns/CacheAside/MC_bug.cfg.txt" with { type: "text" };
import f22 from "./tlaplus-model/assets/patterns/CacheAside/MC_sanity.cfg.txt" with { type: "text" };
import f23 from "./tlaplus-model/assets/patterns/CacheAside/Trace.cfg.txt" with { type: "text" };
import f24 from "./tlaplus-model/assets/patterns/CacheAside/TraceCacheAside.tla.txt" with { type: "text" };
import f25 from "./tlaplus-model/assets/patterns/CacheAside/trace-drift.ndjson.txt" with { type: "text" };
import f26 from "./tlaplus-model/assets/patterns/CacheAside/trace-ok.ndjson.txt" with { type: "text" };
import f27 from "./tlaplus-model/assets/patterns/DagScheduler/DagScheduler.tla.txt" with { type: "text" };
import f28 from "./tlaplus-model/assets/patterns/DagScheduler/MC.cfg.txt" with { type: "text" };
import f29 from "./tlaplus-model/assets/patterns/DagScheduler/MC_bug.cfg.txt" with { type: "text" };
import f30 from "./tlaplus-model/assets/patterns/DagScheduler/MC_sanity.cfg.txt" with { type: "text" };
import f31 from "./tlaplus-model/assets/patterns/IdempotentRetry/IdempotentRetry.tla.txt" with { type: "text" };
import f32 from "./tlaplus-model/assets/patterns/IdempotentRetry/MC.cfg.txt" with { type: "text" };
import f33 from "./tlaplus-model/assets/patterns/IdempotentRetry/MC_bug.cfg.txt" with { type: "text" };
import f34 from "./tlaplus-model/assets/patterns/IdempotentRetry/MC_sanity.cfg.txt" with { type: "text" };
import f35 from "./tlaplus-model/assets/patterns/JobLease/JobLease.tla.txt" with { type: "text" };
import f36 from "./tlaplus-model/assets/patterns/JobLease/MC.cfg.txt" with { type: "text" };
import f37 from "./tlaplus-model/assets/patterns/JobLease/MC_bug.cfg.txt" with { type: "text" };
import f38 from "./tlaplus-model/assets/patterns/JobLease/MC_sanity.cfg.txt" with { type: "text" };
import f39 from "./tlaplus-model/assets/patterns/LostUpdate/LostUpdate.tla.txt" with { type: "text" };
import f40 from "./tlaplus-model/assets/patterns/LostUpdate/MC.cfg.txt" with { type: "text" };
import f41 from "./tlaplus-model/assets/patterns/LostUpdate/MC_bug.cfg.txt" with { type: "text" };
import f42 from "./tlaplus-model/assets/patterns/LostUpdate/MC_sanity.cfg.txt" with { type: "text" };
import f43 from "./tlaplus-model/assets/patterns/OrderStateMachine/MC.cfg.txt" with { type: "text" };
import f44 from "./tlaplus-model/assets/patterns/OrderStateMachine/MC_bug.cfg.txt" with { type: "text" };
import f45 from "./tlaplus-model/assets/patterns/OrderStateMachine/MC_sanity.cfg.txt" with { type: "text" };
import f46 from "./tlaplus-model/assets/patterns/OrderStateMachine/OrderStateMachine.tla.txt" with { type: "text" };
import f47 from "./tlaplus-model/references/apalache-quint.md" with { type: "text" };
import f48 from "./tlaplus-model/references/patterns.md" with { type: "text" };
import f49 from "./tlaplus-model/references/pitfalls.md" with { type: "text" };
import f50 from "./tlaplus-model/references/tlc-cli.md" with { type: "text" };
import f51 from "./tlaplus-model/references/trace-validation.md" with { type: "text" };
import f52 from "./tlaplus-model/scripts/parse_tlc_trace.py.txt" with { type: "text" };
import f53 from "./tlaplus-model/scripts/setup_tla.sh.txt" with { type: "text" };
import f54 from "./tlaplus-model/scripts/tlc.sh.txt" with { type: "text" };
import f55 from "./lean-model/SKILL.md" with { type: "text" };
import f56 from "./lean-model/assets/lean-patterns/.gitignore.txt" with { type: "text" };
import f57 from "./lean-model/assets/lean-patterns/ProofPatterns.lean.txt" with { type: "text" };
import f58 from "./lean-model/assets/lean-patterns/Replay.lean.txt" with { type: "text" };
import f59 from "./lean-model/assets/lean-patterns/lake-manifest.json.txt" with { type: "text" };
import f60 from "./lean-model/assets/lean-patterns/lakefile.toml.txt" with { type: "text" };
import f61 from "./lean-model/assets/lean-patterns/lean-toolchain.txt" with { type: "text" };
import f62 from "./lean-model/assets/lean-patterns/ProofPatterns/Counter.lean.txt" with { type: "text" };
import f63 from "./lean-model/assets/lean-patterns/ProofPatterns/DagScheduler.lean.txt" with { type: "text" };
import f64 from "./lean-model/assets/lean-patterns/ProofPatterns/Explore.lean.txt" with { type: "text" };
import f65 from "./lean-model/assets/lean-patterns/ProofPatterns/Graph.lean.txt" with { type: "text" };
import f66 from "./lean-model/assets/lean-patterns/ProofPatterns/Idempotency.lean.txt" with { type: "text" };
import f67 from "./lean-model/assets/lean-patterns/ProofPatterns/Pipeline.lean.txt" with { type: "text" };
import f68 from "./lean-model/assets/lean-patterns/ProofPatterns/Queue.lean.txt" with { type: "text" };
import f69 from "./lean-model/assets/lean-patterns/ProofPatterns/RedundantGuard.lean.txt" with { type: "text" };
import f70 from "./lean-model/assets/lean-patterns/ProofPatterns/StateMachine.lean.txt" with { type: "text" };
import f71 from "./lean-model/assets/template/__PKG__.lean.txt" with { type: "text" };
import f72 from "./lean-model/assets/template/lakefile.toml.txt" with { type: "text" };
import f73 from "./lean-model/assets/template/lean-toolchain.txt" with { type: "text" };
import f74 from "./lean-model/assets/template/__PKG__/Explore.lean.txt" with { type: "text" };
import f75 from "./lean-model/assets/template/__PKG__/Properties.lean.txt" with { type: "text" };
import f76 from "./lean-model/assets/template/__PKG__/System.lean.txt" with { type: "text" };
import f77 from "./lean-model/references/differential-testing.md" with { type: "text" };
import f78 from "./lean-model/references/patterns.md" with { type: "text" };
import f79 from "./lean-model/references/pitfalls.md" with { type: "text" };
import f80 from "./lean-model/references/proving.md" with { type: "text" };
import f81 from "./lean-model/references/setup.md" with { type: "text" };
import f82 from "./lean-model/scripts/check_trust.sh.txt" with { type: "text" };
import f83 from "./lean-model/scripts/new_project.sh.txt" with { type: "text" };
import f84 from "./lean-model/scripts/setup_lean.sh.txt" with { type: "text" };
import f85 from "./proof-simplify/SKILL.md" with { type: "text" };
import f86 from "./proof-simplify/assets/tla/CancelOrder.tla.txt" with { type: "text" };
import f87 from "./proof-simplify/assets/tla/CancelOrderSimple.tla.txt" with { type: "text" };
import f88 from "./proof-simplify/assets/tla/MC_cas_only.cfg.txt" with { type: "text" };
import f89 from "./proof-simplify/assets/tla/MC_current.cfg.txt" with { type: "text" };
import f90 from "./proof-simplify/assets/tla/MC_lock_only.cfg.txt" with { type: "text" };
import f91 from "./proof-simplify/assets/tla/MC_refines.cfg.txt" with { type: "text" };
import f92 from "./proof-simplify/references/catalog.md" with { type: "text" };
import f93 from "./proof-simplify/references/equivalence.md" with { type: "text" };

const body = (skillMd: string) => skillMd.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();

export const proofSkills = [
	{
		name: "formal-verify",
		description: "End-to-end formal-methods bug hunting for real codebases in any language — scope a risky concern, model it in TLA+ and/or Lean 4, check it, turn every counterexample into a failing test, fix the code, re-verify, and publish the results as an Artifact report. Use this skill whenever the user wants to find race conditions, lost updates, deadlocks, stale caches, double-applied retries, broken idempotency, message reordering or loss bugs, state-machine violations, dataflow/pipeline loss or duplication, or graph/DAG/scheduler bugs; whenever they say \"formally verify\", \"model check\", \"prove\", \"TLA+\", \"Lean\", \"invariant\", \"spec this out\", \"is this thread-safe\", \"can this race\", or ask for a concurrency/async/distributed review of a module or PR — even if they never name a formal-methods tool. Also the entry point for keeping specs in CI and detecting spec/code drift. Routes to tlaplus-model, lean-model, and proof-simplify for the tool-specific work.",
		body: `${dinobotNote("formal-verify")}\n\n${body(f0)}`,
		files: {
			"LICENSE": license,
			"assets/CORRESPONDENCE.md": f1,
			"assets/findings.schema.json": f2,
			"references/choosing-tools.md": f3,
			"references/ci-and-drift.md": f4,
			"references/correspondence.md": f5,
			"references/evidence.md": f6,
			"references/report-artifact.md": f7,
			"references/reproduce-and-fix.md": f8,
			"references/workflows.md": f9,
			"scripts/correspondence_check.py": f10,
			"scripts/doctor.sh": f11,
			"scripts/graph_svg.py": f12,
		},
	},
	{
		name: "tlaplus-model",
		description: "TLA+/TLC model-checking skill. Use it whenever TLA+, PlusCal, Quint, Apalache, TLC, a .tla/.cfg file, or model-checker output appears. That includes a pasted TLC error, \"Invariant X is violated\", or a State 1/State 2… counterexample trace the user wants explained or triaged (real bug, model artifact, or too-strong property), even if it looks answerable by reading alone. Also use it to write, run, scale, or fix specs; debug slow or exploding TLC runs; check invariants, liveness, and fairness; replay production logs against a spec; or \"model\"/\"exhaustively check\" concurrent code, protocols, queues, caches, schedulers, leases, retries, and state machines for races, lost updates, double-spends, deadlocks, and ordering bugs, even for a design with no code yet. Not for runtime race detectors, Jepsen, Alloy, Lean/Coq proofs, or UI state-machine libraries. Pair with formal-verify for the full bug-hunt loop.",
		body: `${dinobotNote("tlaplus-model")}\n\n${body(f13)}`,
		files: {
			"LICENSE": license,
			"assets/patterns/.gitignore": f14,
			"assets/patterns/BatchPipeline/BatchPipeline.tla": f15,
			"assets/patterns/BatchPipeline/MC.cfg": f16,
			"assets/patterns/BatchPipeline/MC_bug.cfg": f17,
			"assets/patterns/BatchPipeline/MC_sanity.cfg": f18,
			"assets/patterns/CacheAside/CacheAside.tla": f19,
			"assets/patterns/CacheAside/MC.cfg": f20,
			"assets/patterns/CacheAside/MC_bug.cfg": f21,
			"assets/patterns/CacheAside/MC_sanity.cfg": f22,
			"assets/patterns/CacheAside/Trace.cfg": f23,
			"assets/patterns/CacheAside/TraceCacheAside.tla": f24,
			"assets/patterns/CacheAside/trace-drift.ndjson": f25,
			"assets/patterns/CacheAside/trace-ok.ndjson": f26,
			"assets/patterns/DagScheduler/DagScheduler.tla": f27,
			"assets/patterns/DagScheduler/MC.cfg": f28,
			"assets/patterns/DagScheduler/MC_bug.cfg": f29,
			"assets/patterns/DagScheduler/MC_sanity.cfg": f30,
			"assets/patterns/IdempotentRetry/IdempotentRetry.tla": f31,
			"assets/patterns/IdempotentRetry/MC.cfg": f32,
			"assets/patterns/IdempotentRetry/MC_bug.cfg": f33,
			"assets/patterns/IdempotentRetry/MC_sanity.cfg": f34,
			"assets/patterns/JobLease/JobLease.tla": f35,
			"assets/patterns/JobLease/MC.cfg": f36,
			"assets/patterns/JobLease/MC_bug.cfg": f37,
			"assets/patterns/JobLease/MC_sanity.cfg": f38,
			"assets/patterns/LostUpdate/LostUpdate.tla": f39,
			"assets/patterns/LostUpdate/MC.cfg": f40,
			"assets/patterns/LostUpdate/MC_bug.cfg": f41,
			"assets/patterns/LostUpdate/MC_sanity.cfg": f42,
			"assets/patterns/OrderStateMachine/MC.cfg": f43,
			"assets/patterns/OrderStateMachine/MC_bug.cfg": f44,
			"assets/patterns/OrderStateMachine/MC_sanity.cfg": f45,
			"assets/patterns/OrderStateMachine/OrderStateMachine.tla": f46,
			"references/apalache-quint.md": f47,
			"references/patterns.md": f48,
			"references/pitfalls.md": f49,
			"references/tlc-cli.md": f50,
			"references/trace-validation.md": f51,
			"scripts/parse_tlc_trace.py": f52,
			"scripts/setup_tla.sh": f53,
			"scripts/tlc.sh": f54,
		},
	},
	{
		name: "lean-model",
		description: "Use this skill to prove or refute properties of real software in Lean 4. The target is the user's own code, not textbook math. It covers state machines, concurrency and interleavings, async handlers, retries and idempotency, queues, batching pipelines, and graph algorithms such as topological order, acyclicity and DAG scheduling. Trigger it when the user wants a guarantee for every input or size (\"holds for all N\"), beyond what TLC, tests or a model checker showed. Also trigger it for invariant proofs by induction, a concrete counterexample trace, an executable reference model for differential testing, or setting up a Lean/lake project to model code. Also use it to audit a Lean development's trust base: sorry, axioms, native_decide. Do NOT use it for pure mathematics such as analysis, algebra or Mathlib coursework and homework. Do NOT use it to translate code into Lean syntax, or for other provers like Dafny, Coq or Isabelle. Pairs with formal-verify for bug hunts and tlaplus-model for protocol exploration.",
		body: `${dinobotNote("lean-model")}\n\n${body(f55)}`,
		files: {
			"LICENSE": license,
			"assets/lean-patterns/.gitignore": f56,
			"assets/lean-patterns/ProofPatterns.lean": f57,
			"assets/lean-patterns/Replay.lean": f58,
			"assets/lean-patterns/lake-manifest.json": f59,
			"assets/lean-patterns/lakefile.toml": f60,
			"assets/lean-patterns/lean-toolchain": f61,
			"assets/lean-patterns/ProofPatterns/Counter.lean": f62,
			"assets/lean-patterns/ProofPatterns/DagScheduler.lean": f63,
			"assets/lean-patterns/ProofPatterns/Explore.lean": f64,
			"assets/lean-patterns/ProofPatterns/Graph.lean": f65,
			"assets/lean-patterns/ProofPatterns/Idempotency.lean": f66,
			"assets/lean-patterns/ProofPatterns/Pipeline.lean": f67,
			"assets/lean-patterns/ProofPatterns/Queue.lean": f68,
			"assets/lean-patterns/ProofPatterns/RedundantGuard.lean": f69,
			"assets/lean-patterns/ProofPatterns/StateMachine.lean": f70,
			"assets/template/__PKG__.lean": f71,
			"assets/template/lakefile.toml": f72,
			"assets/template/lean-toolchain": f73,
			"assets/template/__PKG__/Explore.lean": f74,
			"assets/template/__PKG__/Properties.lean": f75,
			"assets/template/__PKG__/System.lean": f76,
			"references/differential-testing.md": f77,
			"references/patterns.md": f78,
			"references/pitfalls.md": f79,
			"references/proving.md": f80,
			"references/setup.md": f81,
			"scripts/check_trust.sh": f82,
			"scripts/new_project.sh": f83,
			"scripts/setup_lean.sh": f84,
		},
	},
	{
		name: "proof-simplify",
		description: "Use verified TLA+ specs and Lean proofs to simplify real code safely — delete defensive checks the invariants make dead, remove locks/transactions/retries that do no work, collapse redundant states and flags, replace complex implementations with simpler ones proven equivalent, and encode invariants in types — re-verifying every change (re-check, refinement, reachable-state equivalence) before touching code. Use this skill whenever the user asks to simplify, clean up, de-risk a refactor, or reduce complexity in code that has (or could get) a formal model; asks \"do we still need this lock / check / retry / state\"; wants to turn proofs into code improvements; or finishes a formal-verify bug hunt and wants the payoff. If no verified model exists yet, it starts one via formal-verify first.",
		body: `${dinobotNote("proof-simplify")}\n\n${body(f85)}`,
		files: {
			"LICENSE": license,
			"assets/tla/CancelOrder.tla": f86,
			"assets/tla/CancelOrderSimple.tla": f87,
			"assets/tla/MC_cas_only.cfg": f88,
			"assets/tla/MC_current.cfg": f89,
			"assets/tla/MC_lock_only.cfg": f90,
			"assets/tla/MC_refines.cfg": f91,
			"references/catalog.md": f92,
			"references/equivalence.md": f93,
		},
	},
];
