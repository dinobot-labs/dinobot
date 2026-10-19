import { Type } from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";
import { Value } from "typebox/value";
import type { ChannelDefinition } from "./channels/index.ts";
import type { ChannelAdapter } from "./channels/types.ts";
import { COMMAND_NAMES } from "./commands/names.ts";
import { TOOL_MODES, type ToolMode } from "./core/toolmode.ts";
import { PROMPT_PROFILES, type PromptProfile } from "./extensions/task-profile.ts";
import type { LspOptions } from "./core/lsp.ts";
import { SkillEvolutionShape, skillEvolutionConfig, type SkillEvolutionConfig } from "./core/skills/evolution-config.ts";
import { skillCurationConfig, type SkillCurationOptions } from "./core/skills/curation.ts";
import { type MemoryConfig, memoryConfig, MemoryShape } from "./core/memory/config.ts";
import { type AgentDefinition, loadAgents } from "./extensions/subagents.ts";
import { type LoadedPlugin, loadPlugin, type Plugin, type PluginHost } from "./plugins/types.ts";
import { dependencyHost } from "./deps/index.ts";
import { resolve } from "node:path";
import { withDefaultSkills } from "./plugins/skills/index.ts";
import type { CommandSpec } from "./core/research.ts";
import { validateCodeExperiment } from "./core/research-experiments.ts";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { type CustomProviderConfig, customProviderProblems, CustomProvidersShape } from "./auth/custom-providers.ts";

const ResearchReadinessStage = Type.Object({
	argv: Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { minItems: 1, maxItems: 64 }),
	checkIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { minItems: 1, maxItems: 32, uniqueItems: true }),
}, { additionalProperties: false });
const ResearchCommandShape = Type.Object({
	executable: Type.String({ minLength: 1, maxLength: 4096 }),
	argv: Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 64 }),
	cwdPolicy: Type.Literal("candidate"),
	environmentAllowlist: Type.Array(Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]*$" }), { maxItems: 32, uniqueItems: true }),
	timeoutMs: Type.Integer({ minimum: 1, maximum: 3_600_000 }),
	resultSchema: Type.Union([Type.Literal("research-numeric-v1"), Type.Literal("research-numeric-v2")]),
	readiness: Type.Optional(Type.Object({ preflight: ResearchReadinessStage, canary: ResearchReadinessStage }, { additionalProperties: false })),
	baseCommit: Type.String({ pattern: "^[0-9a-f]{40}$" }),
	permittedPaths: Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { minItems: 1, maxItems: 32, uniqueItems: true }),
}, { additionalProperties: false });

export const ManifestShape = Type.Object({
	bot: Type.Object({
		enabled: Type.Boolean(),
		dataDir: Type.String({ minLength: 1 }),
		workspaceRoot: Type.Optional(Type.String({ minLength: 1 })),
		model: Type.Object({ provider: Type.String({ minLength: 1 }), modelId: Type.String({ minLength: 1 }) }),
		toolMode: Type.Union(TOOL_MODES.map((mode) => Type.Literal(mode))),
		/** "task": lean prompt for headless single-task runs (no human, no shared thread). Default "full". */
		promptProfile: Type.Optional(Type.Union(PROMPT_PROFILES.map((profile) => Type.Literal(profile)))),
	}),
	api: Type.Optional(Type.Object({ port: Type.Integer({ minimum: 1, maximum: 65535 }) })),
	/** User-defined OpenAI-compatible model providers (ADR 0098); keys come from /login or the environment. */
	providers: Type.Optional(CustomProvidersShape),
	skillEvolution: Type.Optional(SkillEvolutionShape),
	/** Metric-driven archive of unused agent-created skills (ADR 0038); on by default. */
	curation: Type.Optional(Type.Object({
		enabled: Type.Optional(Type.Boolean()),
		alpha: Type.Optional(Type.Number({ exclusiveMinimum: 0, exclusiveMaximum: 1 })),
		pMax: Type.Optional(Type.Number({ exclusiveMinimum: 0, exclusiveMaximum: 1 })),
		minIdleMs: Type.Optional(Type.Integer({ minimum: 0 })),
		settleMs: Type.Optional(Type.Integer({ minimum: 0 })),
		intervalMs: Type.Optional(Type.Integer({ minimum: 60_000, maximum: 2_147_483_647 })),
		includeUser: Type.Optional(Type.Boolean()),
		includeBundled: Type.Optional(Type.Boolean()),
	}, { additionalProperties: false })),
	/** Project memory: automatic extraction and recall; both on unless turned off. */
	memory: Type.Optional(MemoryShape),
	research: Type.Optional(Type.Object({
		codeProfiles: Type.Record(Type.String({ pattern: "^[a-z][a-z0-9-]{0,63}$" }), ResearchCommandShape),
	}, { additionalProperties: false })),
	agents: Type.Optional(Type.Object({ dirs: Type.Array(Type.String(), { minItems: 1 }) })),
	lsp: Type.Optional(Type.Object({
		timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 30000 })),
		servers: Type.Optional(Type.Array(Type.Object({
			name: Type.String({ minLength: 1 }),
			command: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
			extensions: Type.Array(Type.String({ pattern: "^\\.[a-zA-Z0-9]+$" }), { minItems: 1 }),
			languageId: Type.Optional(Type.String({ minLength: 1 })),
			rootMarkers: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
			initializationOptions: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
			settings: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		}))),
	})),
	commands: Type.Optional(Type.Object({ disabled: Type.Array(Type.String()) })),
	channels: Type.Record(Type.String(), Type.Unknown()),
	plugins: Type.Record(Type.String(), Type.Unknown()),
});

/** A customer deployment, validated against the channels and plugins this build contains. */
export type Manifest = {
	readonly enabled: boolean;
	readonly dataDir: string;
	readonly workspaceRoot?: string;
	readonly lsp?: LspOptions;
	readonly skillEvolution?: SkillEvolutionConfig;
	readonly curation?: SkillCurationOptions;
	/** Defaults applied: automatic extraction and recall are on unless the manifest turns them off. */
	readonly memory: MemoryConfig;
	readonly research?: { readonly codeProfiles: Record<string, CommandSpec> };
	readonly model: ModelRef;
	/** User-defined OpenAI-compatible model providers, in manifest order; empty when none are configured. */
	readonly providers: readonly CustomProviderConfig[];
	readonly toolMode: ToolMode;
	readonly promptProfile: PromptProfile;
	/** Loopback client API for the TUI; absent: no local front end can attach. */
	readonly api?: { readonly port: number };
	readonly channels: readonly ChannelAdapter[];
	readonly plugins: readonly LoadedPlugin[];
	readonly agents: readonly AgentDefinition[];
	/** Slash commands hidden on every surface (TUI, /help, client API, channels). */
	readonly commands: { readonly disabled: readonly string[] };
};

export type Catalogs = {
	readonly channels: Readonly<Record<string, ChannelDefinition>>;
	readonly plugins: Readonly<Record<string, Plugin>>;
	/** Resolves plugin dependencies installed by `dinobot init` (ADR 0059); defaults to the user's install root. */
	readonly host?: PluginHost;
};

export class ManifestError extends Error {
	constructor(readonly problems: readonly string[]) {
		super(`invalid manifest:\n- ${problems.join("\n- ")}`);
	}
}

export async function loadManifest(path: string, catalogs: Catalogs): Promise<Manifest> {
	return parseManifest(Bun.YAML.parse(await Bun.file(path).text()), catalogs);
}

/** Validate everything up front and report every problem at once, so a bad customer config fails at boot. */
export async function parseManifest(raw: unknown, catalogs: Catalogs): Promise<Manifest> {
	if (!Value.Check(ManifestShape, raw)) {
		throw new ManifestError([...Value.Errors(ManifestShape, raw)].map((error) => `${error.instancePath || "/"}: ${error.message}`));
	}
	const problems: string[] = [];
	problems.push(...skillEvolutionConfig(raw.skillEvolution).problems.map((problem) => `skillEvolution: ${problem}`));
	problems.push(...skillCurationConfig(raw.curation).problems);
	const memory = memoryConfig(raw.memory);
	problems.push(...memory.problems);
	for (const [id, command] of Object.entries(raw.research?.codeProfiles ?? {})) {
		try {
			const stages = [[command.executable, ...command.argv], ...(command.readiness ? [[command.executable, ...command.readiness.preflight.argv], [command.executable, ...command.readiness.canary.argv]] : [])];
			for (const argv of stages) validateCodeExperiment({
				baseCommit: command.baseCommit, allowedPaths: command.permittedPaths,
				command: { argv, timeoutMs: command.timeoutMs },
				evaluatorRevision: id, authorityRef: `host:${id}`,
			});
		} catch (error) {
			problems.push(`research.codeProfiles.${id}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	const providers: CustomProviderConfig[] = Object.entries(raw.providers ?? {}).map(([id, config]) => ({ id, ...config }));
	if (providers.length) problems.push(...customProviderProblems(providers, new Set(builtinProviders().map((provider) => provider.id))));
	const serverNames = new Set<string>();
	for (const server of raw.lsp?.servers ?? []) {
		if (serverNames.has(server.name)) problems.push(`lsp.servers: duplicate name "${server.name}"`);
		serverNames.add(server.name);
	}

	const disabled = raw.commands?.disabled ?? [];
	for (const name of disabled) {
		if (!(COMMAND_NAMES as readonly string[]).includes(name)) {
			problems.push(`commands.disabled: unknown command "${name}" (available: ${COMMAND_NAMES.join(", ")})`);
		}
	}

	let agents: readonly AgentDefinition[] = [];
	if (raw.agents !== undefined) {
		try {
			agents = await loadAgents(raw.agents.dirs);
		} catch (error) {
			problems.push(`agents: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	const channels: ChannelAdapter[] = [];
	for (const [key, config] of Object.entries(raw.channels)) {
		const definition = catalogs.channels[key];
		if (definition === undefined) {
			problems.push(`channels.${key}: unknown channel (available: ${Object.keys(catalogs.channels).join(", ")})`);
		} else if (!Value.Check(definition.config, config)) {
			for (const error of Value.Errors(definition.config, config)) problems.push(`channels.${key}${error.instancePath}: ${error.message}`);
		} else {
			channels.push(definition.create(config));
		}
	}
	if (raw.bot.enabled && channels.length === 0 && raw.api === undefined && problems.length === 0) {
		problems.push("channels: an enabled bot needs at least one channel or the api");
	}

	// Manifest entries in order (problems too), then the catalog's default plugins the manifest does not
	// mention (ADR 0058). `false` turns a default plugin off; for any other plugin it stays a config error.
	const plugins: LoadedPlugin[] = [];
	const host = { ...(catalogs.host ?? dependencyHost(catalogs.plugins)), dataDir: resolve(raw.bot.dataDir) };
	const load = async (plugin: Plugin, config: unknown) => {
		const loaded = await loadPlugin(plugin, config, host);
		if (Array.isArray(loaded)) problems.push(...loaded);
		else plugins.push(loaded);
	};
	for (const [id, config] of Object.entries(raw.plugins)) {
		const plugin = Object.hasOwn(catalogs.plugins, id) ? catalogs.plugins[id] : undefined; // own keys only, not `toString`
		if (plugin === undefined) problems.push(`plugins.${id}: unknown plugin (available: ${Object.keys(catalogs.plugins).join(", ")})`);
		else if (!(config === false && plugin.enabledByDefault)) await load(plugin, config);
	}
	for (const [id, plugin] of Object.entries(catalogs.plugins)) {
		if (plugin.enabledByDefault && !Object.hasOwn(raw.plugins, id)) await load(plugin, {});
	}

	if (problems.length > 0) throw new ManifestError(problems);
	return {
		enabled: raw.bot.enabled,
		dataDir: raw.bot.dataDir,
		...(raw.bot.workspaceRoot ? { workspaceRoot: raw.bot.workspaceRoot } : {}),
		...(raw.lsp ? { lsp: raw.lsp } : {}),
		...(raw.skillEvolution ? { skillEvolution: raw.skillEvolution } : {}),
		...(raw.curation ? { curation: raw.curation } : {}),
		memory: memory.config,
		...(raw.research ? { research: raw.research } : {}),
		model: raw.bot.model,
		providers,
		toolMode: raw.bot.toolMode as ToolMode,
		promptProfile: (raw.bot.promptProfile ?? "full") as PromptProfile,
		...(raw.api ? { api: raw.api } : {}),
		channels,
		plugins: await withDefaultSkills(plugins),
		agents,
		commands: { disabled },
	};
}
