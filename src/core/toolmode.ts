import { Type } from "@earendil-works/pi-ai";
import {
	defineExtension,
	defineTool,
	GenerationTask,
	ToolTask,
	hook,
	type Harness,
	type Extension,
} from "@earendil-works/pi-durable";
import { InternalCallDoc } from "./codemode/calls.ts";
import { codemodeExtension } from "../extensions/codemode.ts";
import { SKILL_TOOL_NAMES } from "../extensions/skills.ts";
import { SKILL_EVOLUTION_TOOL_NAMES } from "../extensions/skill-evolution.ts";
import { RESEARCH_TOOL_NAMES } from "../extensions/research.ts";
import { toolSearchExtension } from "../extensions/tool-search.ts";
import type { LoadedPlugin, PluginTool } from "../plugins/types.ts";
import { pluginResultContent } from "./plugin-content.ts";
import { conversationChannel } from "./threads.ts";
import { subagentStates } from "../extensions/plugin-hooks.ts";
import { executeManagedEffect } from "./managed-effects.ts";
import { compactSchema } from "./schema-compact.ts";
import { admitUnknownNativeCall, settleExternalCall } from "./claim-cleanup.ts";
import type { PluginToolCall, ProviderLogin } from "../plugins/types.ts";

/** Resolves the deployment's stored login for a model provider (ADR 0088); undefined when none is stored. */
export type ProviderLoginResolver = (providerId: string, signal?: AbortSignal) => Promise<ProviderLogin | undefined>;

export const TOOL_MODES = ["direct", "hybrid", "codemode-only"] as const;
export type ToolMode = (typeof TOOL_MODES)[number];

/** Keep one capability registry; model exposure and execution policy are separate from availability. */
export function toolExtensions(
	mode: ToolMode,
	plugins: readonly LoadedPlugin[],
	getHarness: () => Harness,
	providerLogin?: ProviderLoginResolver,
): Extension[] {
	const tools = plugins.flatMap((plugin) => plugin.tools);
	// Each tool may resolve only the provider logins its own plugin declared.
	const declared = new Map(plugins.flatMap((plugin) => plugin.tools.map((tool): [string, ReadonlySet<string>] => [tool.name, new Set(plugin.providerLogins ?? [])])));
	const names = new Set([...tools.map((tool) => tool.name), ...SKILL_TOOL_NAMES, ...SKILL_EVOLUTION_TOOL_NAMES, ...RESEARCH_TOOL_NAMES]);
	const extensions: Extension[] = [
		defineExtension({ name: "direct-tools", tools: tools.map((tool) => directTool(tool, declared.get(tool.name) ?? new Set(), providerLogin)) }),
		toolSearchExtension(),
		schemaCompactionExtension(),
	];
	const inline = new Set(tools.filter((tool) => tool.inlineSchema === true).map((tool) => tool.name));
	const longRunning = new Map(tools.flatMap((tool): [string, number][] => (tool.maxDurationMs !== undefined && Number.isFinite(tool.maxDurationMs) && tool.maxDurationMs > 0 ? [[tool.name, tool.maxDurationMs]] : [])));
	if (mode !== "direct") extensions.push(codemodeExtension(getHarness, mode === "codemode-only" ? names : new Set(), inline, longRunning));
	if (mode === "codemode-only")
		extensions.push(
			defineExtension({
				name: "codemode-routing",
				hooks: [
					hook(GenerationTask, {
						beforeRequest: ({ messages }) => ({
							messages: messages.map((message) =>
								message.role !== "system"
									? message
									: {
											...message,
											...(message.toolsAdded
												? { toolsAdded: message.toolsAdded.filter((tool) => !names.has(tool.name)) }
												: {}),
										},
							),
						}),
					}),
					hook(ToolTask, {
						beforeTool: async (call, api, context) => {
							if (names.has(call.name) && !(await api.snapshot(InternalCallDoc, api.taskId, context))?.parent)
								return { block: "Plugin and skill tools must be called through codemode" };
							return undefined;
						},
					}),
				],
			}),
		);
	return extensions;
}

/**
 * Every request carries every offered tool's JSON Schema. Rewrite them into the equivalent shorter form of
 * {@link compactSchema} on the way out only: stored declarations, replay and argument validation keep the originals.
 */
export function schemaCompactionExtension(): Extension {
	const cache = new WeakMap<object, unknown>();
	const compact = (parameters: unknown) => {
		if (typeof parameters !== "object" || parameters === null) return parameters;
		let out = cache.get(parameters);
		if (out === undefined) cache.set(parameters, (out = compactSchema(parameters as Parameters<typeof compactSchema>[0])));
		return out;
	};
	return defineExtension({
		name: "schema-compaction",
		hooks: [
			hook(GenerationTask, {
				beforeRequest: ({ messages }) => ({
					messages: messages.map((message) =>
						message.role === "system" && message.toolsAdded
							? { ...message, toolsAdded: message.toolsAdded.map((tool) => ({ ...tool, parameters: compact(tool.parameters) as typeof tool.parameters })) }
							: message,
					),
				}),
			}),
		],
	});
}

function directTool(tool: PluginTool, logins: ReadonlySet<string>, providerLogin: ProviderLoginResolver | undefined) {
	return defineTool({
		name: tool.name,
		description: tool.description,
		parameters: Type.Unsafe(tool.inputSchema),
		execute: async (args, api, context) => {
			let channel: Promise<string | undefined> | undefined;
			const call: PluginToolCall = {
				...(context.abortSignal ? { signal: context.abortSignal } : {}),
				conversationId: String(api.conversationId),
				subagents: () => subagentStates(api, api.conversationId, context),
				// Resolved on demand and at most once per call; most tools never ask.
				channel: () => (channel ??= conversationChannel(api, api.conversationId, context)),
				...(api.env?.cwd !== undefined ? { cwd: api.env.cwd } : {}),
				...(providerLogin && logins.size > 0
					? {
							providerLogin: async (providerId: string) => {
								if (!logins.has(providerId)) throw new Error(`${tool.name} did not declare provider login "${providerId}"`);
								return providerLogin(providerId, context.abortSignal);
							},
						}
					: {}),
			};
			const tracked = !tool.oneUse && tool.readOnly !== true;
			if (tracked) await admitUnknownNativeCall(api, context, "external:" + tool.name);
			let value: Awaited<ReturnType<typeof tool.execute>>;
			try {
				value = tool.oneUse ? await executeManagedEffect(tool, args, call, api, context) : await tool.execute(args, call);
			} finally {
				// The awaited call is over (returned or threw); a crash before this line keeps it UNKNOWN.
				if (tracked) await settleExternalCall(api, "external:" + tool.name);
			}
			return { content: await pluginResultContent(value) };
		},
	});
}
