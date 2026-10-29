import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import type { SkillPackage } from "../core/skills/store.ts";

export type JsonSchema = { [key: string]: unknown } | boolean;

/** One block of a rich tool result. Images are base64; the host validates, re-encodes or omits them before the model sees them. */
export type PluginContentBlock =
	| { readonly type: "text"; readonly text: string }
	| { readonly type: "image"; readonly mimeType: string; readonly data: string };

/**
 * A tool result made of text and image blocks. Return it from `execute` when the result carries images;
 * any other value is serialized to one text block (strings as-is, everything else as JSON).
 */
export class PluginContent {
	readonly blocks: readonly PluginContentBlock[];
	constructor(blocks: readonly PluginContentBlock[]) {
		this.blocks = Object.freeze([...blocks]);
	}
}

/**
 * A model-provider login the host resolved for a plugin: the bearer of the deployment's stored credential (an OAuth
 * access token refreshed before return, or an API key) and the provider's base URL. Never persisted by the plugin.
 */
export type ProviderLogin = { readonly apiKey: string; readonly baseUrl?: string };

/** One subagent a conversation started, as the host's committed records show it. */
export type PluginSubagent = {
	/** Handle the model uses for `task_output` / `kill_task`. */
	readonly taskId: string;
	readonly status: "running" | "completed" | "failed" | "cancelled";
	readonly description: string;
	readonly background: boolean;
};

/**
 * What the host tells a plugin's {@link PluginInstance.onTurnEnd} hook when a top-level conversation is about to end its
 * turn with a final answer. Every field comes from committed host records, never from the model.
 */
export type PluginTurnEnd = {
	readonly conversationId: string;
	readonly cwd?: string;
	/** Every subagent the conversation started, finished ones included. */
	readonly subagents: readonly PluginSubagent[];
	/** Questions to the human that are still open; their answer re-enters the conversation by itself. */
	readonly openHumanAsks: number;
	/** DAG runs still running; their settlement re-enters the conversation by itself. */
	readonly runningDagRuns: number;
};

/**
 * ADR 0106: one host-started turn a plugin asks for (a calendar reminder that came due). The host submits `text` as a
 * host input framed `<from host="plugin:<id>"/>` to the conversation and hands the turn's answer to that conversation's
 * channel thread (Slack, Telegram, Discord) like any woken answer (ADR 0096).
 */
export type PluginWake = {
	/**
	 * A {@link PluginToolCall.conversationId} the plugin recorded. A subagent conversation resolves to its top-level
	 * conversation; a thread that `/new` moved to a newer conversation resolves to that newer one.
	 */
	readonly conversationId: string;
	/** Idempotency key, unique within the plugin (`[A-Za-z0-9:._-]{1,200}`): one key starts at most one turn, ever. */
	readonly key: string;
	/** Instruction for the woken turn (at most 16 KiB). */
	readonly text: string;
};

/**
 * `admitted`: the turn is queued (it runs after any turn in progress) and its answer will be handed to the thread;
 * `duplicate`: this key was admitted before (nothing new happens); `gone`: the conversation no longer exists;
 * `unavailable`: the host cannot take it now (shutting down); ask again later.
 */
export type PluginWakeResult = "admitted" | "duplicate" | "gone" | "unavailable";

/** Host services that exist only once the bot is open; handed to {@link PluginInstance.start}. */
export type PluginRuntime = {
	wake(request: PluginWake): Promise<PluginWakeResult>;
};

/** What the host tells a tool about the call. */
export type PluginToolCall = {
	/** The calling conversation's durable id. Undefined when the host cannot attribute the call (tests, embedding). */
	readonly conversationId?: string;
	/** The subagents the calling conversation started, read from committed host records on demand. */
	readonly subagents?: () => Promise<readonly PluginSubagent[]>;
	/** Host-generated one-use intent identity; never a model argument. */
	readonly effectId?: string;
	readonly signal?: AbortSignal;
	/**
	 * The channel (`tui`, `telegram`, ...) of the top-level conversation this call runs under, following subagent
	 * links to their root. Undefined when the host cannot attribute the call to a channel thread.
	 */
	readonly channel?: () => Promise<string | undefined>;
	/** The calling conversation's working directory, when the host runs the call in one. */
	readonly cwd?: string;
	/**
	 * The deployment's stored login for a model provider the plugin declared in `providerLogins` (for example
	 * `openai-codex` after `/login`), or undefined when none is stored. Rejects for an undeclared provider id and when
	 * a stored OAuth token cannot be refreshed. Undefined when the host offers no provider logins (tests, embedding).
	 */
	readonly providerLogin?: (providerId: string) => Promise<ProviderLogin | undefined>;
};

/**
 * One pinned release archive of an external program. `dinobot init` downloads it, checks the exact byte count and
 * SHA-256, extracts it and records the result; nothing runs from an archive that failed either check.
 */
export type DependencyArtifact = {
	readonly url: string;
	readonly sha256: string;
	readonly bytes: number;
	readonly format: "tar.gz" | "zip";
	/** Relative path of the executable inside the extracted archive. */
	readonly entry: string;
	/**
	 * macOS only: the archive carries a signed app bundle that must live in `/Applications` (privacy grants and
	 * LaunchServices relaunch key on that identity and path). `dinobot init` verifies the bundle against the pinned
	 * signer, copies it there and runs `entry` from the installed bundle; `entry` must lie inside `bundle`.
	 */
	readonly macosApp?: {
		/** Relative path of the `.app` directory inside the extracted archive. */
		readonly bundle: string;
		readonly bundleId: string;
		/** Apple Developer team id that must sign the bundle (Developer ID, Apple-anchored). */
		readonly teamId: string;
		/** Arguments for `entry` that request the app's privacy permissions; `dinobot init` prints the command. */
		readonly permissionArgs?: readonly string[];
	};
};

/** An external program a plugin runs as a child process, installed and pinned by `dinobot init`. */
export type ExternalDependency = {
	/** Lowercase kebab-case; also the install directory name. */
	readonly id: string;
	readonly version: string;
	readonly summary: string;
	readonly homepage: string;
	readonly license: string;
	/** Keyed by `${process.platform}-${process.arch}`, e.g. `linux-x64`. A missing key means unsupported there. */
	readonly artifacts: Readonly<Partial<Record<string, DependencyArtifact>>>;
	/** Post-install smoke check: run the executable with `args` and require exit 0 and `expect` in stdout. */
	readonly check?: { readonly args: readonly string[]; readonly expect: string; readonly env?: Readonly<Record<string, string>> };
	/** Shown when the platform has no artifact: how to install the program by hand. */
	readonly manualInstall?: string;
};

/** Host services a plugin may use at run time. */
export type PluginHost = {
	/** Absolute path of an installed, verified dependency executable declared by this plugin; undefined when not installed. */
	resolveDependency(id: string): Promise<string | undefined>;
	/**
	 * The bot's data directory, for plugin state such as OAuth tokens. Undefined when the host has none (tests).
	 * Files a plugin keeps here must be listed in its instance's `storagePaths`.
	 */
	readonly dataDir?: string;
};

/**
 * One capability a plugin offers. It knows nothing about pi-durable or codemode; the bot's
 * tool mode decides whether the model calls it directly, from codemode scripts, or both.
 */
export type PluginTool = {
	/** Explicit irreversible adapter protocol. execute returns {receipt:string}; lookup never executes. No default gate on ordinary tools. */
	readonly oneUse?: { reconcile?: (effectId: string, options: PluginToolCall) => Promise<{receipt:string} | undefined> };
	/** Lowercase snake_case. Exposed to the model as `<pluginId>_<name>`. */
	readonly name: string;
	readonly description: string;
	readonly inputSchema: JsonSchema;
	readonly outputSchema?: JsonSchema;
	/** Host-audited read-only capability; omitted/false requires managed effect admission. */
	readonly readOnly?: boolean;
	/**
	 * A capability the agent should plan with up front (e.g. desktop control, web search): in codemode-only mode its full
	 * argument schema stays in the prompt instead of behind tool_search. Keep it to a few small schemas.
	 */
	readonly inlineSchema?: boolean;
	/**
	 * Longest one call may run, in ms, for a tool that legitimately takes longer than a codemode cell (image generation).
	 * A codemode cell that calls it extends its deadline to cover this run time; the tool must stop by itself within it.
	 */
	readonly maxDurationMs?: number;
	execute(args: unknown, options: PluginToolCall): Promise<unknown>;
};

/** What a plugin hands back once loaded; `close` releases anything `load` opened (connections, child processes). */
export type PluginInstance = {
	readonly tools: readonly PluginTool[];
	readonly prompt?: string;
	/** Named entries the plugin offers besides tools (the skills plugin's skills), for listings like `/skills`. */
	readonly catalog?: readonly PluginCatalogEntry[];
	/** Immutable source packages imported into the harness's versioned skill store. */
	readonly skillPackages?: readonly SkillPackage[];
	/** Host-owned files the plugin keeps (credentials); the agent's file and shell tools may not touch them. */
	readonly storagePaths?: readonly string[];
	/**
	 * Mechanical check run when a top-level conversation ends its turn with a final answer. Return text to continue the
	 * run with that text as a host message (bounded by the host per human input), or undefined to let the turn end.
	 * Throwing lets the turn end; the host reports the error.
	 */
	onTurnEnd?(turn: PluginTurnEnd): Promise<string | undefined>;
	/**
	 * Called once after the bot opened and recovered (ADR 0106), before channels start; background work (timers) starts
	 * here, not in `load`, and stops in `close`. Must return promptly. Throwing is reported and leaves the plugin's tools
	 * usable.
	 */
	start?(runtime: PluginRuntime): void | Promise<void>;
	close?(): Promise<void>;
};

export type PluginCatalogEntry = { readonly name: string; readonly description: string };

export type Plugin<Config extends TSchema = TSchema> = {
	/** Lowercase snake_case; the key under `plugins:` in the customer manifest. */
	readonly id: string;
	/**
	 * On without a manifest entry: the manifest loads it with `{}` unless `plugins.<id>: false` turns it off
	 * (ADR 0058). Only for plugins that need no credentials, open nothing in `load`, accept `{}` and expose
	 * read-only tools.
	 */
	readonly enabledByDefault?: boolean;
	/** Schema of the plugin's block in the customer manifest. */
	readonly config: Config;
	/** External programs this plugin runs; `dinobot init` installs them. */
	readonly dependencies?: readonly ExternalDependency[];
	/**
	 * Model-provider ids whose stored login (`/login`) this plugin's tools may use through `PluginToolCall.providerLogin`
	 * (ADR 0088). A plugin sees no other provider's credential.
	 */
	readonly providerLogins?: readonly string[];
	load(config: Static<Config>, host: PluginHost): PluginInstance | Promise<PluginInstance>;
};

export type LoadedPlugin = {
	readonly id: string;
	readonly prompt?: string;
	/** Tools with their exposed, plugin-prefixed names. */
	readonly tools: readonly PluginTool[];
	readonly catalog?: readonly PluginCatalogEntry[];
	readonly skillPackages?: readonly SkillPackage[];
	readonly storagePaths?: readonly string[];
	/** The plugin's declared `providerLogins`; the host resolves only these for its tools. */
	readonly providerLogins?: readonly string[];
	onTurnEnd?(turn: PluginTurnEnd): Promise<string | undefined>;
	start?(runtime: PluginRuntime): void | Promise<void>;
	close?(): Promise<void>;
};

const NAME = /^[a-z][a-z0-9_]*$/;

export function definePlugin<Config extends TSchema>(plugin: Plugin<Config>): Plugin<Config> {
	return plugin;
}

/** A host without installed dependencies, for tests and plugins that declare none. */
export const NO_DEPENDENCIES: PluginHost = Object.freeze({ resolveDependency: async () => undefined });

/** Validate a plugin's manifest block and instantiate its tools. Returns errors instead of throwing. */
export async function loadPlugin(plugin: Plugin, rawConfig: unknown, host: PluginHost = NO_DEPENDENCIES): Promise<LoadedPlugin | string[]> {
	const config = rawConfig ?? {};
	if (!NAME.test(plugin.id)) return [`plugin id "${plugin.id}" must match ${NAME}`];
	if (!Value.Check(plugin.config, config)) {
		return [...Value.Errors(plugin.config, config)].map((error) => `plugins.${plugin.id}${error.instancePath}: ${error.message}`);
	}
	let instance: PluginInstance;
	try {
		const declared = new Set((plugin.dependencies ?? []).map((dependency) => dependency.id));
		instance = await plugin.load(config, {
			// A plugin sees only the dependencies it declared.
			resolveDependency: async (id) => (declared.has(id) ? host.resolveDependency(id) : undefined),
			...(host.dataDir !== undefined ? { dataDir: host.dataDir } : {}),
		});
	} catch (error) {
		return [`plugins.${plugin.id}: ${error instanceof Error ? error.message : String(error)}`];
	}
	const errors: string[] = [];
	const tools = instance.tools.map((tool) => {
		if (!NAME.test(tool.name)) errors.push(`plugins.${plugin.id}: tool name "${tool.name}" must match ${NAME}`);
		return { ...tool, name: `${plugin.id}_${tool.name}` };
	});
	if (errors.length > 0) return errors;
	return {
		id: plugin.id,
		tools,
		...(instance.prompt !== undefined ? { prompt: instance.prompt } : {}),
		...(instance.catalog !== undefined ? { catalog: instance.catalog } : {}),
		...(instance.skillPackages !== undefined ? { skillPackages: instance.skillPackages } : {}),
		...(instance.storagePaths !== undefined ? { storagePaths: instance.storagePaths } : {}),
		...(plugin.providerLogins?.length ? { providerLogins: Object.freeze([...plugin.providerLogins]) } : {}),
		...(instance.onTurnEnd !== undefined ? { onTurnEnd: instance.onTurnEnd.bind(instance) } : {}),
		...(instance.start !== undefined ? { start: instance.start.bind(instance) } : {}),
		...(instance.close !== undefined ? { close: instance.close.bind(instance) } : {}),
	};
}
