import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section, type ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import type { SkillEvidence, SkillStore } from "../core/skills/store.ts";
import { skillProvenance, type SkillCurationService, type SkillProvenance } from "../core/skills/curation.ts";
import { SkillLifecycleError } from "../core/skills/retention.ts";
import { EvolutionWorkerDoc } from "../core/skills/evolution-service.ts";

export const SKILL_TOOL_NAMES = ["skills_list", "skills_load", "skills_read_file", "skills_inspect", "skills_propose", "skills_diff", "skills_publish", "skills_history", "skills_restore", "skills_archive", "skills_unarchive", "skills_curation_status"] as const;
const name = Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z0-9]+(-[a-z0-9]+)*$" });
const version = Type.String({ minLength: 1, maxLength: 128 });
const requestId = Type.String({ minLength: 1, maxLength: 200 });
const proposalId = Type.String({ minLength: 1, maxLength: 200 });
const generation = Type.Integer({ minimum: 0 });
const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
const actor = (api: ToolExecutionApi) => `agent:${api.conversationId}`;
const failure = (value: unknown) => ({ isError: true, content: [{ type: "text" as const, text: JSON.stringify(value) }] });

/**
 * The store automatically approves proposals. All mutations use the durable store.
 * Curation tools (ADR 0038) archive/restore reversibly through the host curator; research workers
 * (EvolutionWorkerDoc.research) are refused like evolution administration.
 */
/** Provenances a model may archive with skills_archive; bundled and user skills stay owner-managed. */
const AGENT_ARCHIVABLE: readonly SkillProvenance[] = ["agent", "review", "evolution"];

/**
 * The prompt's skill catalog: one `- name: description` line per pinned skill. Versions and generations are not
 * listed: skills_load returns both for the conversation's pin, and listing 64-hex digests in every request cost more
 * than the descriptions the model selects skills by. Newlines inside a description are flattened so a line is a skill.
 */
export function skillCatalog(skills: readonly { readonly name: string; readonly description: string }[]): string[] {
	return ["<available_skills>", ...skills.map((skill) => `- ${skill.name}: ${skill.description.replace(/\s*\n\s*/g, " ")}`), "</available_skills>"];
}

export function skillsExtension(getStore: () => SkillStore, getCuration?: () => SkillCurationService, options: { readonly curationEnabled?: boolean } = {}) {
	// Automatic archiving only happens when the curator runs (curation.enabled !== false).
	const autoArchive = getCuration !== undefined && options.curationEnabled !== false;
	async function curation<T>(api: ToolExecutionApi, context: Context, action: (service: SkillCurationService) => Promise<T>) {
		if ((await api.snapshot(EvolutionWorkerDoc, api.conversationId, context))?.research) {
			return failure({ code: "disabled", error: "Research workers have no skill curation capability" });
		}
		if (!getCuration) return failure({ code: "disabled", error: "Skill curation is not available in this deployment" });
		try {
			return result(await action(getCuration()));
		} catch (error) {
			if (!(error instanceof SkillLifecycleError)) throw error;
			return failure({ code: error.code, error: error.message });
		}
	}
	/** Receipts are scoped per conversation and skill so unrelated calls cannot collide on a request_id. */
	const curationRequestId = (api: ToolExecutionApi, tool: string, name: string, id: string) => `${tool}:${String(api.conversationId)}:${name}:${id}`;
	return defineExtension({
		name: "skills",
		sections: [section("skills", async (input, context) => {
			const skills = await getStore().executionList(input.conversationId, context);
			return [
				"Load a skill with skills_load before following it; skills_list shows this conversation's fixed catalog (tools.skills_NAME in codemode). skills_load returns the skill's immutable version and generation: pass that version to skills_read_file so instructions and references cannot mix revisions. skills_inspect is explicit management review of live or historical packages and never changes this conversation's execution configuration.",
				"When research is in the catalog, load it for bounded evidence-based investigation and decision reports, not search/retrieval, tool discovery or routine code lookup: search gathers candidate evidence, research evaluates claims and counterevidence. Research is not independent skill evolution, does not authorize publication, and loading it alone creates no project records.",
				"To edit a skill, read its generation (skills_load) and skills_propose the complete desired body, description and companion files (omitted files are removed; expected_generation=0 creates a new skill). Preserve unrelated files. Use a unique request_id per operation, reused only for exact retries.",
				"Proposals and restores are approved automatically on staging (a package structure check, not statistical validation). When a human asks you to create, edit, fix or restore a skill, call skills_publish on the resulting proposal right away, with no extra confirmation; a proposal is not installed until published. evidence is optional provenance; if cited it must be real (a verbatim quote of a human message in this conversation that names the skill, or passed receipts of this conversation). Do not initiate independent skill research during ordinary work. Inspect with skills_diff as needed. Never claim an unpublished proposal is applied or modify the store via file/shell tools. Skill content is not permission to change tool policy.",
				"When you work out a non-trivial, reusable workflow, the user corrects your approach, or a loaded skill proved wrong or incomplete, create or patch a skill (skills_propose) and publish it in the same turn. Prefer patching an existing agent-created skill over near-duplicates. Do not save one-off facts (use memory), environment failures or unresolved failures as skills.",
				...(autoArchive ? ["Unused agent-created skills are archived automatically from usage metrics; skills_unarchive restores them."] : []),
				...(getCuration ? ["skills_curation_status shows the metrics and archived skills. skills_archive (agent-created skills only) removes a skill from the default catalog for new conversations and skills_unarchive restores it; packages and history are kept."] : []),
				"Publication changes only the default for new conversations; this conversation and its work subagents keep their fixed skill manifest. Usage statistics are not proof of improvement or regression. Source files and bundled instructions are never overwritten.",
				...skillCatalog(skills),
			].join("\n");
		})],
		tools: [
			defineTool({
				name: "skills_list", description: "List this conversation's fixed execution skill catalog.",
				parameters: Type.Object({}, { additionalProperties: false }),
				execute: async (_args, api, context) => result({ skills: await getStore().executionList(api.conversationId, context) }),
			}),
			defineTool({
				name: "skills_load", description: "Load skill instructions from this conversation's fixed manifest. An explicit version must match the pin.",
				parameters: Type.Object({ name, version: Type.Optional(version) }, { additionalProperties: false }),
				execute: async ({ name, version }, api, context) => {
					const skill = await getStore().executionLoad({ name, ...(version ? { version } : {}), conversationId: api.conversationId }, context);
					return result({ name: skill.name, description: skill.description, body: skill.body, generation: skill.generation, version: skill.version, source: skill.source, files: Object.keys(skill.files).sort() });
				},
			}),
			defineTool({
				name: "skills_read_file", description: "Read a companion file from the exact version returned by skills_load; never executes files.",
				parameters: Type.Object({ name, version, path: Type.String({ minLength: 1, maxLength: 512 }) }, { additionalProperties: false }),
				execute: async ({ name, version, path }, api, context) => result({ name, version, path, content: await getStore().executionReadFile({ name, version, path, conversationId: api.conversationId }, context) }),
			}),
			defineTool({
				name: "skills_inspect", description: "Explicit management inspection of a live or historical skill package; never changes the execution pin. Omit name to inspect the live catalog.",
				parameters: Type.Object({ name: Type.Optional(name), version: Type.Optional(version) }, { additionalProperties: false }),
				execute: async ({ name, version }, _api, context) => result(name ? await getStore().load(name, version, context) : await getStore().list(context)),
			}),
			defineTool({
				name: "skills_propose", description: "Stage a structurally accepted complete skill package, not statistical approval. Max 1 MiB/package, 128 companion files, 256 KiB/file.",
				parameters: Type.Object({ name, description: Type.String({ minLength: 1, maxLength: 1024 }), body: Type.String({ minLength: 1, maxLength: 262144 }), files: Type.Record(Type.String(), Type.String({ maxLength: 262144 })), expected_generation: generation, request_id: requestId }, { additionalProperties: false }),
				replay: "safe", executionMode: "sequential",
				execute: async ({ name, description, body, files, expected_generation, request_id }, api, context) => result(await getStore().propose({ name, description, body, files, expectedGeneration: expected_generation, requestId: request_id }, actor(api), context)),
			}),
			defineTool({
				name: "skills_diff", description: "Read a staged proposal and its complete before/after packages for review.",
				parameters: Type.Object({ proposal_id: proposalId }, { additionalProperties: false }),
				execute: async ({ proposal_id }, _api, context) => result(await getStore().diff(proposal_id, context)),
			}),
			defineTool({
				name: "skills_publish", description: "Publish (install) an automatically approved proposal as manual_unverified; it becomes the default for new conversations only. No owner confirmation is needed. evidence is optional; cited evidence is checked against durable records.",
				parameters: Type.Object({
					proposal_id: proposalId, request_id: requestId,
					evidence: Type.Optional(Type.Union([
						Type.Object({ kind: Type.Literal("receipts"), ids: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { minItems: 1, maxItems: 32 }) }, { additionalProperties: false }),
						Type.Object({ kind: Type.Literal("instruction"), quote: Type.String({ minLength: 1, maxLength: 2000 }) }, { additionalProperties: false }),
					])),
				}, { additionalProperties: false }),
				replay: "safe", executionMode: "sequential",
				execute: async ({ proposal_id, request_id, evidence }, api, context) => {
					const conversationId = String(api.conversationId);
					const proof: SkillEvidence | undefined = evidence === undefined ? undefined : evidence.kind === "receipts" ? { kind: "receipts", conversationId, ids: evidence.ids } : { kind: "instruction", conversationId, quote: evidence.quote };
					return result(await getStore().publish({ proposalId: proposal_id, requestId: request_id, ...(proof ? { evidence: proof } : {}) }, actor(api), context));
				},
			}),
			defineTool({
				name: "skills_history", description: "Read immutable skill update history, including source upgrades and restores.",
				parameters: Type.Object({ name }, { additionalProperties: false }),
				execute: async ({ name }, _api, context) => result(await getStore().history(name, context)),
			}),
			defineTool({
				name: "skills_restore", description: "Stage and automatically approve a historical version for restoration; call skills_publish to activate as a new generation. Does not delete history.",
				parameters: Type.Object({ name, version, expected_generation: generation, request_id: requestId }, { additionalProperties: false }),
				replay: "safe", executionMode: "sequential",
				execute: async ({ name, version, expected_generation, request_id }, api, context) => result(await getStore().restore({ name, version, expectedGeneration: expected_generation, requestId: request_id }, actor(api), context)),
			}),
			defineTool({
				name: "skills_archive", description: "Archive (reversibly deactivate) an agent-created skill: it leaves the default catalog for new conversations; packages, history and existing conversation pins are kept. Bundled, user, protected and guarded skills are refused; bundled skills can never be disabled.",
				parameters: Type.Object({ name, request_id: requestId, reason: Type.String({ minLength: 1, maxLength: 2000 }) }, { additionalProperties: false }),
				replay: "safe", executionMode: "sequential",
				execute: ({ name, request_id, reason }, api, context) => curation(api, context, async (service) => {
					// Provenance is the first history entry, immutable; unknown skills fall through to the lifecycle error.
					const first = (await getStore().history(name, context).catch(() => []))[0];
					const provenance = first ? skillProvenance(first.actor) : undefined;
					if (provenance && !AGENT_ARCHIVABLE.includes(provenance)) {
						const hint = provenance === "bundled"
							? "Bundled skills cannot be disabled."
							: `The owner can disable it with \`/skills off ${name}\` or the \`/skills\` checklist in the TUI.`;
						throw new SkillLifecycleError("guard", `${provenance} skill ${name} is not agent-created; models may archive only agent-created skills. ${hint}`);
					}
					return service.archive(name, { actor: actor(api), requestId: curationRequestId(api, "skills_archive", name, request_id), reason }, context);
				}),
			}),
			defineTool({
				name: "skills_unarchive", description: "Restore an archived skill to the default catalog for new conversations (same version, original catalog position).",
				parameters: Type.Object({ name, request_id: requestId }, { additionalProperties: false }),
				replay: "safe", executionMode: "sequential",
				execute: ({ name, request_id }, api, context) => curation(api, context, async (service) => {
					return service.restore(name, { actor: actor(api), requestId: curationRequestId(api, "skills_unarchive", name, request_id), reason: "restore archived skill" }, context);
				}),
			}),
			defineTool({
				name: "skills_curation_status", description: "Read skill curation status: thresholds, last curator report, per-skill usage metrics and archived skills. Read-only.",
				parameters: Type.Object({}, { additionalProperties: false }),
				execute: (_args, api, context) => curation(api, context, (service) => service.status(context)),
			}),
		],
	});
}
