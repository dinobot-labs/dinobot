import { defineExtension, section, wrapSection } from "@earendil-works/pi-durable";
import type { ToolMode } from "../core/toolmode.ts";

/**
 * Prompt profiles. "full" is the messaging teammate (default). "task" is for headless single-task runs (HTTP/CLI
 * automation, benchmarks) where no human answers, no thread is shared and nothing is remembered across tasks.
 *
 * Terminal-Bench trajectories (23 sessions, 373 model calls) showed the full prompt (~33 KB) being ignored where it
 * does not fit: goal_set, dag_run and codemode were never used, while two "done" reports were wrong because the
 * result was not checked against the task's exact names (pip vs pip3, exact_match vs acc). The task profile drops
 * the messaging/collaboration guidance and ends the prompt with a short completion checklist instead.
 */
export const PROMPT_PROFILES = ["full", "task"] as const;
export type PromptProfile = (typeof PROMPT_PROFILES)[number];

/** Sections that only serve messaging, collaboration, durable memory or certification workflows. */
export const TASK_PROFILE_DROPPED_SECTIONS = [
	"memory_guidance",
	"lsp_guidance",
	"skills",
	"soul",
	"todo_guidance",
	"goal_guidance",
	"goal",
	"ask_protocol",
	"dag_protocol",
	"session_awareness",
	"verification",
] as const;

export function taskPreamble(mode: ToolMode): string {
	return [
		"You are Dinobot, running one autonomous task. No human is in the loop: never ask questions or wait for confirmation; make reasonable assumptions and keep going until the task is done.",
		"Explore the environment first (files, tools, versions, how the result will be checked), then implement the smallest correct solution.",
		mode === "direct"
			? "Use the bash, read, write and edit tools directly."
			: "Call the bash, read, write and edit tools directly for ordinary work; plugin tools are only callable inside codemode.",
		"Finish with a concise summary of what you did and how you verified it.",
	].join("\n");
}

export const TASK_DISCIPLINE = [
	"Before you finish:",
	"1. Re-read the task statement and list every concrete requirement: paths, names, commands, formats, metrics, counts. Check each one against the final state itself, not against what you intended to do.",
	"2. Exercise the result the way a grader would: run the exact commands, programs and checks the task names (the literal name, e.g. `pip`, not only a variant such as `pip3`), and compare outputs with what was asked.",
	"3. If you deleted, replaced or reinstalled anything, confirm that previously working entry points and files still exist and work.",
	"4. Give commands that may run long or block an explicit timeout, and never leave a command waiting on interactive input.",
	"5. Report success only for what you verified; say plainly what remains unverified.",
].join("\n");

/** Installed only for the task profile; the full profile is left untouched. */
export function taskProfileExtension(mode: ToolMode) {
	return defineExtension({
		name: "task-profile",
		sections: [section("task_discipline", () => TASK_DISCIPLINE)],
		wraps: [
			wrapSection("preamble", (preamble) => ({ ...preamble, render: () => taskPreamble(mode) })),
			...TASK_PROFILE_DROPPED_SECTIONS.map((key) => wrapSection(key, (dropped) => ({ ...dropped, render: () => undefined }))),
		],
	});
}
