/**
 * The `web` plugin: credential-free web search, on by default like the
 * oh-my-pi original (openwiki/decisions/0058; `plugins.web: false` turns it
 * off). Exposes one read-only `search` tool — `web_search` after prefixing —
 * that runs a query through the ordered engine chain (Startpage → DuckDuckGo
 * by default, matching the oh-my-pi `web` priority list) with sequential
 * fallback, Google-style directive parsing and lenient constraint
 * post-filtering.
 *
 * Design contract, invariants and their proofs: openwiki/architecture/web-search.md.
 */

import { Type } from "@earendil-works/pi-ai";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import { definePlugin, type PluginTool } from "../types.ts";
import { DuckDuckGoProvider } from "./duckduckgo.ts";
import { StartpageProvider } from "./startpage.ts";
import { executeSearch } from "./search.ts";
import {
	DEFAULT_TIMEOUT_SECONDS,
	ENGINE_IDS,
	MAX_TIMEOUT_SECONDS,
	type EngineId,
	type SearchProvider,
} from "./types.ts";

const config = Type.Object(
	{
		/**
		 * Engines in fallback order. Default: the oh-my-pi `web` chain order
		 * restricted to keyless engines (startpage before duckduckgo).
		 */
		engines: Type.Optional(
			Type.Array(Type.Union([Type.Literal("startpage"), Type.Literal("duckduckgo")]), { minItems: 1, uniqueItems: true }),
		),
		/** Hard ceiling per engine attempt. Default 60s, capped at 300s. */
		timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TIMEOUT_SECONDS })),
		/**
		 * Endpoint overrides (base URLs), primarily for mirrors and tests.
		 * Secrets are never needed: both engines are credential-free.
		 */
		endpoints: Type.Optional(
			Type.Object(
				{
					startpage: Type.Optional(Type.String({ minLength: 1 })),
					duckduckgo: Type.Optional(Type.String({ minLength: 1 })),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);

function check<T extends TSchema>(schema: T, args: unknown): Static<T> {
	if (Value.Check(schema, args)) return args;
	const problems = [...Value.Errors(schema, args)].map((error) => `${error.instancePath || "/"}: ${error.message}`);
	throw new Error(`invalid arguments: ${problems.join("; ")}`);
}

function tool<T extends TSchema>(
	name: string,
	description: string,
	schema: T,
	run: (args: Static<T>, signal: AbortSignal | undefined) => Promise<unknown>,
): PluginTool {
	return {
		name,
		description,
		inputSchema: schema as unknown as PluginTool["inputSchema"],
		execute: async (args, { signal }) => await run(check(schema, args), signal),
	};
}

const searchInput = Type.Object(
	{
		query: Type.String({ minLength: 1, description: "Raw query; Google-style directives (site:, -site:, after:, before:, inurl:, intitle:, filetype:, \"phrases\", -exclusions, OR) are parsed and mapped" }),
		recency: Type.Optional(
			Type.Union([Type.Literal("day"), Type.Literal("week"), Type.Literal("month"), Type.Literal("year")], {
				description: "Relative time filter",
			}),
		),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Max results (default 10, max 20)" })),
	},
	{ additionalProperties: false },
);

/** Build the engine chain from config. Load never touches the network. */
function providersOf(cfg: Static<typeof config>): SearchProvider[] {
	const engines: EngineId[] = cfg.engines ?? ["startpage", "duckduckgo"];
	return engines.map((id) => {
		if (id === "duckduckgo") return new DuckDuckGoProvider(cfg.endpoints?.duckduckgo);
		return new StartpageProvider(cfg.endpoints?.startpage);
	});
}

function prompt(cfg: Static<typeof config>): string {
	const engines = cfg.engines ?? ["startpage", "duckduckgo"];
	return [
		`web_search runs one query through the first healthy keyless engine (${engines.join(" → ")}; a bot challenge advances to the next) and returns numbered sources with URLs and snippets.`,
		"Google-style directives are passed to engines that support them; a constraint that cannot be applied is relaxed instead of returning nothing, and the relaxation is reported as a Note line.",
		"A result starting with `Error:` means every engine failed — report the reason instead of retrying the identical query. Results may be bot-defended, partial or stale; verify load-bearing claims against the cited URL before acting on them.",
	].join("\n");
}

export const webPlugin = definePlugin({
	id: "web",
	// No credentials, nothing opened at load, `{}` is valid and the tool is read-only (ADR 0058).
	enabledByDefault: true,
	config,
	load: (cfg) => {
		// Config validation only; no network at boot (ADR 0018).
		const providers = providersOf(cfg);
		const timeoutMs = Math.min(cfg.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS) * 1000;
		const search = tool(
			"search",
			"Search the public web (internet, Google-indexed pages) for up-to-date information: news, documentation, releases, error messages. Google-style query operators (site:, after:, intitle:, filetype:, quoted phrases, OR) are supported. Keyless engines with automatic fallback (Startpage, DuckDuckGo).",
			searchInput,
			async (args, signal) =>
				await executeSearch(
					args.query,
					{ limit: args.limit, recency: args.recency },
					{ providers, timeoutMs, signal },
				),
		);
		return {
			// A small schema the agent should plan with up front, not discover after the fact.
			tools: [{ ...search, readOnly: true, inlineSchema: true }],
			prompt: prompt(cfg),
		};
	},
});

export { ENGINE_IDS };
