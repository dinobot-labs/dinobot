import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { EvolutionWorkerDoc, type SkillEvolutionService } from "../core/skills/evolution-service.ts";
import { EvolutionJobError } from "../core/skills/evolution-jobs.ts";

export const SKILL_EVOLUTION_TOOL_NAMES = [
	"skill_evolution_status", "skill_evolution_pause", "skill_evolution_kill",
	"skill_evolution_resume", "skill_evolution_enqueue", "skill_evolution_schedule",
] as const;
const requestId = Type.String({ minLength: 1, maxLength: 200 });
const identifier = Type.String({ pattern: "^[a-f0-9]{64}$" });
const result = (value: unknown, isError = false) => ({
	isError, content: [{ type: "text" as const, text: JSON.stringify(value) }],
});

/** Common registry tools; codemode discovers this same extension, not a private tool path. */
export function skillEvolutionExtension(service: SkillEvolutionService) {
	async function admin<T>(api: ToolExecutionApi, context: Context, action: (actor: string) => Promise<T>) {
		if ((await api.snapshot(EvolutionWorkerDoc, api.conversationId, context))?.research) {
			return result({ code: "disabled", error: "Research workers have no evolution administration capability" }, true);
		}
		try {
			return result(await action(`agent:${api.conversationId}`));
		} catch (error) {
			if (!(error instanceof EvolutionJobError)) throw error;
			return result({ code: error.code, error: error.message }, true);
		}
	}
	return defineExtension({
		name: "skill-evolution",
		tasks: [service.task],
		tools: [
			defineTool({
				name: "skill_evolution_status",
				description: "Read skill research runtime status, disabled reasons and conservative per-deployment budget accounting. Does not start research or modify state.",
				parameters: Type.Object({}, { additionalProperties: false }),
				execute: async (_args, _api, context) => result(await service.status(context)),
			}),
			defineTool({
				name: "skill_evolution_pause", description: "Pause research admission, fence active work and abort owned research tasks. Keeps queued work.",
				parameters: Type.Object({ request_id: requestId }, { additionalProperties: false }),
				replay: "safe", executionMode: "sequential",
				execute: ({ request_id }, api, context) => admin(api, context, (actor) => service.pause(request_id, context, actor)),
			}),
			defineTool({
				name: "skill_evolution_kill", description: "Durably kill research admission and fence late results before physically aborting its tasks. Does not affect main tasks.",
				parameters: Type.Object({ request_id: requestId }, { additionalProperties: false }),
				replay: "safe", executionMode: "sequential",
				execute: ({ request_id }, api, context) => admin(api, context, (actor) => service.kill(request_id, context, actor)),
			}),
			defineTool({
				name: "skill_evolution_resume", description: "Enable research admission after a startup pause. Requires an installed trusted executor and finite budgets; background review mode does not need an SLO registration, the statistical evaluate path requires a matching host-verified SLO registration. Refused when the operator explicitly paused or killed research. Does not enable unsupported automatic evaluation or publication.",
				parameters: Type.Object({ request_id: requestId }, { additionalProperties: false }),
				replay: "safe", executionMode: "sequential",
				execute: ({ request_id }, api, context) => admin(api, context, (actor) => service.resume(request_id, context, actor)),
			}),
			defineTool({
				name: "skill_evolution_enqueue", description: "Admit a host-registered immutable research snapshot. No file paths, budget overrides or new snapshot authority. Returns without waiting for research; deferred admission needs a new request ID.",
				parameters: Type.Object({
					request_id: requestId, snapshot_id: identifier,
					overflow: Type.Union([Type.Literal("defer"), Type.Literal("drop")]),
				}, { additionalProperties: false }),
				replay: "safe", executionMode: "sequential",
				execute: ({ request_id, snapshot_id, overflow }, api, context) => admin(api, context, (actor) => service.enqueue(request_id, snapshot_id, overflow, context, actor)),
			}),
			defineTool({
				name: "skill_evolution_schedule", description: "Schedule one durable, separately owned trusted research task for an admitted job. Returns the task ID without waiting for completion.",
				parameters: Type.Object({ request_id: requestId, job_id: identifier }, { additionalProperties: false }),
				replay: "safe", executionMode: "sequential",
				execute: ({ request_id, job_id }, api, context) => admin(api, context, (actor) => service.schedule(request_id, job_id, context, actor)),
			}),
		],
	});
}
