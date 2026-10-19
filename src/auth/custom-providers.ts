import { createProvider, envApiKeyAuth, Type, type AuthInteraction, type Model, type OpenAICompletionsCompat, type Provider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { redactApiKey } from "./alibaba-token-plan.ts";
import type { LoginProvider } from "./types.ts";

/**
 * User-defined OpenAI-compatible model providers (`providers:` in dinobot.yaml, ADR 0098): a base URL and a
 * model list served through pi-ai's `openai-completions` transport. The key never lives in the manifest; it comes
 * from `/login <id>` (auth.json) or, when nothing is stored, from the provider's environment variable.
 */

const CustomModelShape = Type.Object({
	id: Type.String({ minLength: 1 }),
	name: Type.Optional(Type.String({ minLength: 1 })),
	reasoning: Type.Optional(Type.Boolean()),
	input: Type.Optional(Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]), { minItems: 1, uniqueItems: true })),
	contextWindow: Type.Optional(Type.Integer({ minimum: 1 })),
	maxTokens: Type.Optional(Type.Integer({ minimum: 1 })),
	/** pi-ai `OpenAICompletionsCompat` overrides; unset fields are auto-detected from the base URL. */
	compat: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
}, { additionalProperties: false });

const CustomProviderShape = Type.Object({
	name: Type.Optional(Type.String({ minLength: 1 })),
	baseUrl: Type.String({ pattern: "^https?://" }),
	/** Environment variable read when no key is stored; default `<ID>_API_KEY`. */
	apiKeyEnv: Type.Optional(Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]*$" })),
	headers: Type.Optional(Type.Record(Type.String({ minLength: 1 }), Type.String())),
	models: Type.Array(CustomModelShape, { minItems: 1 }),
}, { additionalProperties: false });

/** Provider ids: the `provider` half of `provider/modelId`, so never a `/`. Checked in `customProviderProblems`, since record key patterns are not enforced by the shape check. */
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]*$/;

/** Keyed by provider id. */
export const CustomProvidersShape = Type.Record(Type.String({ minLength: 1 }), CustomProviderShape);

export type CustomModelConfig = {
	readonly id: string;
	readonly name?: string;
	readonly reasoning?: boolean;
	readonly input?: readonly ("text" | "image")[];
	readonly contextWindow?: number;
	readonly maxTokens?: number;
	readonly compat?: Readonly<Record<string, unknown>>;
};

export type CustomProviderConfig = {
	readonly id: string;
	readonly name?: string;
	readonly baseUrl: string;
	readonly apiKeyEnv?: string;
	readonly headers?: Readonly<Record<string, string>>;
	readonly models: readonly CustomModelConfig[];
};

export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 16_384;

export const customProviderName = (config: CustomProviderConfig) => config.name ?? config.id;
export const customProviderEnv = (config: CustomProviderConfig) =>
	config.apiKeyEnv ?? `${config.id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
const baseUrlOf = (config: CustomProviderConfig) => config.baseUrl.trim().replace(/\/+$/, "");

/** Manifest problems the shape cannot express: ids that would shadow a builtin provider, duplicate model ids. */
export function customProviderProblems(configs: readonly CustomProviderConfig[], builtinIds: ReadonlySet<string>): string[] {
	const problems: string[] = [];
	for (const config of configs) {
		if (!PROVIDER_ID.test(config.id)) problems.push(`providers.${config.id}: id must be lowercase letters, digits, ".", "_" or "-" (no "/")`);
		if (builtinIds.has(config.id)) problems.push(`providers.${config.id}: "${config.id}" is a builtin provider; choose another id`);
		const seen = new Set<string>();
		for (const model of config.models) {
			if (seen.has(model.id)) problems.push(`providers.${config.id}.models: duplicate id "${model.id}"`);
			seen.add(model.id);
		}
	}
	return problems;
}

export function customModel(config: CustomProviderConfig, model: CustomModelConfig): Model<"openai-completions"> {
	return {
		id: model.id,
		name: model.name ?? model.id,
		api: "openai-completions",
		provider: config.id,
		baseUrl: baseUrlOf(config),
		reasoning: model.reasoning ?? false,
		input: [...(model.input ?? ["text"])],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
		maxTokens: model.maxTokens ?? DEFAULT_MAX_TOKENS,
		type: "chat",
		...(config.headers ? { headers: { ...config.headers } } : {}),
		...(model.compat ? { compat: model.compat as OpenAICompletionsCompat } : {}),
	};
}

/** The pi-ai provider: a stored credential wins, else the environment variable. */
export function customProvider(config: CustomProviderConfig): Provider {
	return createProvider({
		id: config.id,
		name: customProviderName(config),
		baseUrl: baseUrlOf(config),
		...(config.headers ? { headers: { ...config.headers } } : {}),
		auth: { apiKey: envApiKeyAuth(`${customProviderName(config)} API key`, [customProviderEnv(config)]) },
		models: config.models.map((model) => customModel(config, model)),
		api: openAICompletionsApi(),
	}) as Provider;
}

/** The `/login` row: stored under the provider id, which is also the model provider. */
export function customLoginProvider(config: CustomProviderConfig): LoginProvider {
	return { id: config.id, name: customProviderName(config), storeAs: config.id, modelProvider: config.id };
}

/** Bound on upstream error text echoed back into a validation failure. */
const DETAILS_LIMIT = 300;

/**
 * Prompt for the key and prove it can run the provider's first model with a one-token request before it is stored,
 * the same probe the Alibaba Token Plan login uses. Upstream errors are redacted so the key never reaches the card.
 */
export async function loginCustomProvider(config: CustomProviderConfig, interaction: AuthInteraction): Promise<string> {
	const signal = interaction.signal;
	const name = customProviderName(config);
	const entered = await interaction.prompt({
		type: "secret",
		message: `Paste your ${name} API key`,
		...(signal ? { signal } : {}),
	});
	if (signal?.aborted) throw new Error("Login cancelled");
	const apiKey = entered.trim();
	if (!apiKey) throw new Error("API key is required");

	interaction.notify({ type: "progress", message: "Validating API key..." });
	const { validateOpenAICompatibleApiKey } = await import("@oh-my-pi/pi-ai/registry/api-key-validation");
	try {
		await validateOpenAICompatibleApiKey({
			provider: name,
			apiKey,
			baseUrl: baseUrlOf(config),
			model: config.models[0]!.id,
			...(signal ? { signal } : {}),
		});
	} catch (error) {
		if (signal?.aborted) throw new Error("Login cancelled");
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(redactApiKey(message, apiKey).slice(0, DETAILS_LIMIT));
	}
	return apiKey;
}
