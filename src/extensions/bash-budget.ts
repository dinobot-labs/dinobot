import { defineExtension, wrapTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { createBashTool } from "@earendil-works/pi-durable/tools";
import { Type } from "typebox";

/**
 * Per-command budget for the bash tool. The durable tool has no default timeout, so a command that blocks (an
 * interactive subprocess waiting on input, a deadlocked solver) holds the whole turn until something outside kills
 * it. Terminal-Bench trajectories showed single commands blocking 561-573s, and models passing millisecond-looking
 * values (30000-120000) to a seconds field. This bounds one command only; it is not a turn or task lifetime limit
 * (long work keeps running through explicit timeouts or background tasks).
 *
 * Defaults come from the live deployment's direct bash calls without a timeout (n=1529): p99 112s, p99.9 245s, and
 * only one call (a 3411s hang) exceeded 300s. The largest explicit timeout seen was 14600s.
 */
export const BASH_BUDGET = { defaultSeconds: 300, maxSeconds: 21_600 } as const;

export type BashBudget = { readonly defaultSeconds: number; readonly maxSeconds: number };

const parameters = (budget: BashBudget) =>
	Type.Object({
		command: Type.String({ description: "Bash command to execute" }),
		timeout: Type.Optional(
			Type.Number({
				description: `Timeout in SECONDS (not milliseconds). Default ${budget.defaultSeconds} when omitted; maximum ${budget.maxSeconds}. Pass a larger value for long builds, downloads or test suites.`,
			}),
		),
	});

/** Rejects out-of-range timeouts with a corrective hint before anything runs. */
export function checkBashTimeout(timeout: unknown, budget: BashBudget = BASH_BUDGET): number {
	if (timeout === undefined) return budget.defaultSeconds;
	if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) {
		throw new Error("Invalid timeout: give a positive number of seconds, or omit it for the default.");
	}
	if (timeout > budget.maxSeconds) {
		const hours = (timeout / 3600).toFixed(1);
		throw new Error(
			`Invalid timeout ${timeout}: the bash timeout is in seconds, so this means ~${hours} hours (maximum ${budget.maxSeconds}). ` +
				`If you meant milliseconds, pass ${Math.max(1, Math.round(timeout / 1000))}. For longer work run it in the background instead.`,
		);
	}
	return timeout;
}

export function wrapBashWithBudget(tool: ToolRegistration, budget: BashBudget = BASH_BUDGET): ToolRegistration {
	return {
		...tool,
		description: `${tool.description} Without a timeout a command is stopped after ${budget.defaultSeconds} seconds.`,
		parameters: parameters(budget),
		execute: async (args, api, context) => {
			const given = (args as { timeout?: unknown }).timeout;
			const timeout = checkBashTimeout(given, budget);
			try {
				return await tool.execute({ ...(args as object), timeout } as typeof args, api, context);
			} catch (error) {
				if (given === undefined && error instanceof Error && /^Command timed out after /.test(error.message)) {
					throw new Error(
						`Command timed out after ${timeout} seconds (the default when no timeout is given). ` +
							`If it is legitimately long, rerun it with a larger timeout in seconds (up to ${budget.maxSeconds}); if it was waiting on input or deadlocked, change the approach.`,
					);
				}
				throw error;
			}
		},
	};
}

/** Wraps whichever bash tool is installed (plain or with a host prepare hook). */
export function bashBudgetExtension(budget: BashBudget = BASH_BUDGET) {
	return defineExtension({
		name: "bash-budget",
		wraps: [wrapTool(createBashTool() as ToolRegistration, (tool) => wrapBashWithBudget(tool, budget))],
	});
}
