import { Type } from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/chord";
import { type ConversationId, defineDoc, defineExtension, defineTool, GenerationTask, ToolTask, hook, section, type ToolRegistration, type Wrap } from "@earendil-works/pi-durable";
import { PlanValidationError, type AcceptanceContract, type CheckMethod, type RegisterPlan, type WorkService } from "../core/verification.ts";
import { digest } from "../core/verification-execution.ts";

// Advisory only: never suppress authorized effects or weaken certification.
const PlanRecoveryDoc = defineDoc<{ sources: string; failures: number }>({ kind: "dinobot.plan-recovery", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ sources: "", failures: 0 }) });
const PlanRecoveryReceipt = defineDoc<{ failures?: number }>({ kind: "dinobot.plan-recovery-receipt", version: 1, scope: "task", initial: () => ({}) });
const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
const strings = Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true });
const methodSchema = Type.Object({
	command: Type.String({ minLength: 1 }), cwd: Type.String({ minLength: 1 }), runner: Type.Union([Type.Literal("process"), Type.Literal("bun")]),
	args: Type.Array(Type.String()), timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: 120, default: 60 })), adapterVersion: Type.Literal(1),
	locators: Type.Array(Type.Object({ scenarioId: Type.String({ minLength: 1 }), file: Type.String({ minLength: 1 }), name: Type.String({ minLength: 1 }) }, { additionalProperties: false }), { minItems: 1 }),
}, { additionalProperties: false });
const contractSchema = Type.Object({
	requirements: Type.Array(Type.Object({ id: Type.String(), assertion: Type.String({ minLength: 1 }), checkIds: strings, scenarioIds: strings }, { additionalProperties: false }), { minItems: 1 }),
	scenarios: Type.Array(Type.Object({ id: Type.String(), assertion: Type.String({ minLength: 1 }) }, { additionalProperties: false }), { minItems: 1 }),
	checks: Type.Array(Type.Object({ id: Type.String(), requirementIds: strings, scenarioIds: strings, evidence: Type.Union(["behavioral", "build", "lint", "typecheck", "smoke", "human"].map(v => Type.Literal(v))), expected: Type.String({ minLength: 1 }) }, { additionalProperties: false }), { minItems: 1 }),
}, { additionalProperties: false });
const exempt = new Set(["codemode", "task", "task_output", "kill_task", "todo_write", "work_plan", "work_status", "verify_run", "work_finish", "search_tools"]);
/** Wrap only effectful capabilities, never orchestration: nested calls resolve these same bodies. */
export function verificationExtension(service: WorkService, managedToolNames: readonly string[] = ["write", "edit", "bash"], onOutcome?: (conversationId: ConversationId, outcome: "verified" | "blocked", context: Context) => Promise<unknown>) {
	return defineExtension({
		name: "verification", tasks: [service.checkTask],
		sections: [section("verification", () => service.enforced ? `${service.gated ? "Tool execution is gated: register work_plan with immutable required acceptance, scenarios and complete check coverage before managed edits, shell or plugin effects." : "YOLO tool execution: no tool is blocked by a missing work_plan, lease or certificate."} Verification is enforced: register coding work with work_plan (immutable required acceptance, scenarios and complete check coverage) and certify it with work_finish. Registered work without a current certificate is reported honestly: the host replaces the final answer with its unmet/blocked summary, and todo or subagent completion linked to that work needs a certificate. Source IDs and state are in work_status. Classify purely informational input with work_plan informational and rationale; do not create dummy checks. verify_run executes real checks. Bun methods use command=bun, args=test paths/selectors (without the test subcommand); host supplies a JUnit reporter. Locators identify exact file and testcase names for immutable scenarios. Only work_finish certifies current sources. Repair mistakes with repair_method and rationale without lowering acceptance; every repair invalidates all prior checks. Unknown process effects block until operator resolution. Raw answers and todo completion are provisional, not certificates.` : `${service.gated ? "Tool execution is gated: register work_plan with required acceptance and check coverage before managed edits, shell or plugin effects. Verification is not enforced: certificates and verification blockers do not gate answers, todos or subagent completion." : "YOLO mode: execute authorized tools immediately; work_plan, verify_run and work_finish are optional. Missing plans, verification blockers and certificates do not gate tools, answers, todos or subagent completion."} Use real checks appropriate to the task and report their results honestly. If you opt into certification, work_finish still requires actual current evidence; a normal completed answer is not a verification certificate.`)],
		wraps: [...new Set(["write", "edit", "bash", ...managedToolNames])].filter(name => !exempt.has(name)).map((name): Wrap => ({ tool: name, wrap: (tool: ToolRegistration): ToolRegistration => ({ ...tool, execute: (args, api, context) => service.mutate(api, context, guardedApi => tool.execute(args, guardedApi, context), name === "bash" ? "process" : name === "write" || name === "edit" ? "filesystem" : "external") }) })),
		hooks: [hook(GenerationTask, {
			beforeRequest: async (_request, api, context) => { await service.reconcileSources(api.conversationId, [], context); },
			onYield: async (answer, api, context) => { await service.captureDisplayInputs(api.conversationId, context); const continuation = await service.coach(api.conversationId, `${api.taskId}:${digest(answer)}`, context); return continuation ? { continue: continuation } : undefined; },
		}), hook(ToolTask,{afterTool:async(_call,result,api,context)=>{if(result.control?.handoff!==undefined || result.control?.terminate===true) await service.transitionGoalAdmission(api.conversationId,String(api.taskId)+":control",context);return undefined;}})],
		tools: [
			defineTool({
				name: "work_status",
				description: "Inspect current source dispositions, methods, budgets, evidence and blockers. Historical success is not current certification. Supply attemptId to inspect retained actual output or report in 16 KiB pages; offset/nextOffset are byte offsets.",
				parameters: Type.Object({
					attemptId: Type.Optional(Type.String({ minLength: 1 })),
					part: Type.Optional(Type.Union([Type.Literal("output"), Type.Literal("report")])),
					offset: Type.Optional(Type.Integer({ minimum: 0 })),
				}, { additionalProperties: false }),
				replay: "safe",
				execute: async (args, api, context) => {
					if (!args.attemptId) return text({ workflow: await service.status(api.conversationId, context), work: await service.snapshot(api.conversationId, context) });
					const attempt = await service.inspectAttempt(api.conversationId, args.attemptId, context);
					if (!attempt) return { ...text({ error: "Unknown attempt in this conversation" }), isError: true };
					const part = args.part ?? "output";
					const body = attempt.observation?.[part] ?? "";
					const bytes = Buffer.from(body);
					let start = Math.min(args.offset ?? 0, bytes.length);
					while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
					let end = Math.min(start + 16 * 1024, bytes.length);
					while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
					return text({
						receipt: { ...attempt, observation: attempt.observation ? { ...attempt.observation, output: undefined, report: undefined } : undefined },
						part, offset: start, nextOffset: end < bytes.length ? end : null,
						totalBytes: bytes.length, contentHash: digest(body), text: bytes.subarray(start, end).toString("utf8"),
					});
				},
			}),
			defineTool({ name: "work_plan", description: "Inspect work_plan({op: \"describe\"}) for workspace, source IDs and minimal examples. Use op=preflight with a full plan to report independent errors without registering or certifying. Register/strengthen immutable required coding obligations, classify informational sources, repair an execution method with rationale and CAS, or cancel without certifying. No optional coverage or acceptance waiver.", replay: "safe", executionMode: "sequential", parameters: Type.Union([
				Type.Object({ op: Type.Literal("describe") }, { additionalProperties: false }),
				Type.Object({ op: Type.Union([Type.Literal("register"), Type.Literal("preflight")]), workId: Type.Optional(Type.String()), sourceIds: strings, contract: contractSchema, scope: Type.Object({ root: Type.String(), inputs: Type.Array(Type.String()), disposable: Type.Array(Type.String()) }, { additionalProperties: false }), methods: Type.Record(Type.String(), methodSchema) }, { additionalProperties: false }),
				Type.Object({ op: Type.Literal("informational"), sourceIds: strings, rationale: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
				Type.Object({ op: Type.Literal("repair_method"), workId: Type.String(), checkId: Type.String(), expectedRevision: Type.Integer({ minimum: 1 }), method: methodSchema, rationale: Type.String({ minLength: 1 }), priorAttemptIds: Type.Optional(Type.Array(Type.String())) }, { additionalProperties: false }),
				Type.Object({ op: Type.Literal("cancel"), workId: Type.String() }, { additionalProperties: false }),
			]), execute: async (args, api, context) => {
				if (args.op === "describe") return text(await service.describe(api.conversationId, context));
				if (args.op === "informational") await service.classifyInformational(api.conversationId, args.sourceIds, args.rationale, context);
				else if (args.op === "cancel") await service.cancel(api.conversationId, args.workId, context);
				else if (args.op === "repair_method") await service.repair(api.conversationId, args.workId, args.checkId, args.expectedRevision, { ...args.method, timeout: args.method.timeout ?? 60 } as CheckMethod, args.rationale, args.priorAttemptIds ?? [], String(api.taskId), context);
				else {
					const methods = Object.fromEntries(Object.entries(args.methods).map(([key, method]) => [key, { ...method, timeout: method.timeout ?? 60 }]));
					const plan = { ...args, contract: args.contract as AcceptanceContract, methods } as RegisterPlan;
					if (args.op === "preflight") {
						const result = await service.preflight(api.conversationId, plan, context);
						return { ...text(result), isError: !result.valid };
					}
					try {
						await service.register(api.conversationId, plan, String(api.taskId), context);
						await api.commit(async tx => { (await tx.doc(PlanRecoveryDoc, api.conversationId)).failures = 0; }, context);
					}
					catch (error) {
						if (!(error instanceof PlanValidationError)) throw error;
						const failures = await api.commit(async tx => {
							const receipt = await tx.doc(PlanRecoveryReceipt, api.taskId);
							if (receipt.failures !== undefined) return receipt.failures;
							const recovery = await tx.doc(PlanRecoveryDoc, api.conversationId);
							const sources = digest([...plan.sourceIds].sort());
							if (recovery.sources !== sources) { recovery.sources = sources; recovery.failures = 0; }
							recovery.failures = Math.min(2, recovery.failures + 1);
							receipt.failures = recovery.failures;
							return receipt.failures;
						}, context);
						return { ...text({ valid: false, issues: error.issues, repeatedFailure: failures >= 2, next: failures >= 2
							? "Repeated registration failure: stop guessing or creating wrapper tests. Call work_plan describe, inspect tool_search for work_plan, then preflight the corrected plan. If certification is optional, ordinary real checks remain available; report their evidence without claiming certification."
							: "Inspect work_plan describe and fix all reported issues before retrying. No acceptance/evidence state was changed." }), isError: true };
					}
				}
				return text(await service.status(api.conversationId, context));
			} }),
			defineTool({ name: "verify_run", description: "Execute one current required check as a durable managed CheckTask. Takes only IDs; cannot supply result labels, commands, exclusions or observations.", replay: "safe", executionMode: "sequential", parameters: Type.Object({ workId: Type.String(), checkId: Type.String() }, { additionalProperties: false }), execute: async (args, api, context) => text(await service.run(api, args.workId, args.checkId, context)) }),
			defineTool({ name: "work_finish", description: "Request verified completion with a fresh fingerprint and atomic certificate check, or report an honest blocked/cancelled outcome with reason. Missing, stale, ambiguous or unsupported evidence cannot certify.", replay: "safe", executionMode: "sequential", parameters: Type.Object({ workId: Type.String(), outcome: Type.Optional(Type.Union([Type.Literal("verified"), Type.Literal("blocked"), Type.Literal("cancelled")])), reason: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false }), execute: async (args, api, context) => {
				const status = args.outcome && args.outcome !== "verified" ? await service.settle(api.conversationId, args.workId, args.outcome, args.reason ?? "", context) : await service.finish(api.conversationId, args.workId, String(api.taskId), context);
				if (onOutcome && (status.status === "verified" || status.status === "blocked")) await onOutcome(api.conversationId, status.status, context);
				return text(status);
			} }),
		],
	});
}
