import type { Models } from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai/models";
import { AgentDoc, defineDoc, defineExtension, GenerationTask, hook, ProviderDoc, type Extension, type ModelRef } from "@earendil-works/pi-durable";

/**
 * Codex-style fast service tier. OpenAI models get `service_tier: "priority"` (Codex's `{id: "priority", name: "Fast"}`);
 * Anthropic models get `speed: "fast"` plus the fast-mode beta (research preview).
 */
export type FastTier = { readonly kind: "openai" | "anthropic"; readonly default: boolean };

export const ANTHROPIC_FAST_BETA = "fast-mode-2026-02-01";

const OPENAI_FAST_MODELS = ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"];
/** Codex `default_service_tier`: fast unless the user turned it off. */
const CODEX_DEFAULT_FAST = new Set(["gpt-6-sol", "gpt-6-luna"]);
const ANTHROPIC_FAST_MODELS = ["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8"];

const CATALOG: ReadonlyMap<string, FastTier> = new Map([
	...OPENAI_FAST_MODELS.map((id): [string, FastTier] => [`openai/${id}`, { kind: "openai", default: false }]),
	...OPENAI_FAST_MODELS.map((id): [string, FastTier] => [`openai-codex/${id}`, { kind: "openai", default: CODEX_DEFAULT_FAST.has(id) }]),
	...ANTHROPIC_FAST_MODELS.map((id): [string, FastTier] => [`anthropic/${id}`, { kind: "anthropic", default: false }]),
]);

export function fastTier(provider: string, modelId: string): FastTier | undefined {
	return CATALOG.get(`${provider}/${modelId}`);
}

/** The thread's stored choice: explicit on, explicit off, or unset (`null`, follow the catalog default). */
export const FastDoc = defineDoc<{ fast: boolean | null }>({
	kind: "dinobot.fast",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ fast: null }),
});

/** The last explicit choice, seeded into new threads. */
export const FastPreference = defineDoc<{ fast: boolean | null }>({
	kind: "dinobot.fast-preference",
	version: 1,
	scope: "session",
	initial: () => ({ fast: null }),
});

export type FastState = { readonly fast: boolean; readonly fastSupported: boolean };

/** Effective fast = supported AND (explicit on OR (unset AND catalog default)); the choice survives model switches. */
export function fastState(models: Models, ref: ModelRef | undefined, choice: boolean | null | undefined): FastState {
	const tier = ref && models.getModel(ref.provider, ref.modelId) ? fastTier(ref.provider, ref.modelId) : undefined;
	if (!tier) return { fast: false, fastSupported: false };
	return { fast: choice ?? tier.default, fastSupported: true };
}

/** Rewrite one provider payload for the fast tier; `undefined` keeps it unchanged. */
export function fastPayload(payload: unknown, provider: string, modelId: string): unknown {
	const tier = fastTier(provider, modelId);
	if (!tier || typeof payload !== "object" || payload === null) return undefined;
	const body = payload as Record<string, unknown>;
	if (tier.kind === "openai") return { ...body, service_tier: "priority" };
	const betas = Array.isArray(body.betas) ? (body.betas as unknown[]) : [];
	return { ...body, speed: "fast", betas: [...new Set([...betas, ANTHROPIC_FAST_BETA])] };
}

/**
 * Process-local map from provider session IDs (pi-durable `ProviderDoc`) to the effective fast flag. The generation
 * hook refreshes it before every request; wrapped providers read it when building the payload.
 */
export class FastRouter {
	readonly #sessions = new Map<string, boolean>();

	set(sessionId: string, fast: boolean): void {
		if (fast) this.#sessions.set(sessionId, true);
		else this.#sessions.delete(sessionId);
	}

	isFast(sessionId: string | undefined): boolean {
		return sessionId !== undefined && this.#sessions.get(sessionId) === true;
	}

	/** The provider with `stream`/`streamSimple` applying the fast payload for fast sessions, after any caller `onPayload`. */
	wrapProvider<P extends Provider>(provider: P): P {
		const withFast = <O extends { sessionId?: string; onPayload?: (payload: unknown, model: never) => unknown }>(options: O | undefined): O | undefined => {
			if (!this.isFast(options?.sessionId)) return options;
			const own = options?.onPayload;
			return {
				...options,
				onPayload: async (payload: unknown, model: { provider: string; id: string }) => {
					const replaced = own ? await (own as (payload: unknown, model: unknown) => unknown)(payload, model) : undefined;
					const current = replaced ?? payload;
					return fastPayload(current, model.provider, model.id) ?? replaced;
				},
			} as unknown as O;
		};
		return {
			...provider,
			streamSimple: (model, context, options) => provider.streamSimple(model, context, withFast(options)),
			stream: (model, context, options) => provider.stream(model, context, withFast(options as never)),
		};
	}
}

/** Shared by `createBotModels` and `openBot` unless a caller supplies its own router. */
export const FAST_ROUTER = new FastRouter();

/** Refresh the router from the conversation's fast choice and model before each request; messages are unchanged. */
export function fastExtension(models: Models, router: FastRouter): Extension {
	return defineExtension({
		name: "fast",
		hooks: [
			hook(GenerationTask, {
				beforeRequest: async (_request, api, context) => {
					const provider = await api.snapshot(ProviderDoc, api.conversationId, context);
					if (!provider) return undefined;
					const [choice, agent] = await Promise.all([
						api.snapshot(FastDoc, api.conversationId, context),
						api.snapshot(AgentDoc, api.conversationId, context),
					]);
					router.set(provider.sessionId, fastState(models, agent?.model, choice?.fast).fast);
					return undefined;
				},
			}),
		],
	});
}
