import type { AuthInteraction } from "@earendil-works/pi-ai";

/**
 * Alibaba Token Plan login, the same flow as gajae-code's `loginAlibabaTokenPlan`
 * (packages/ai/src/utils/oauth/alibaba-token-plan.ts). It is not OAuth: open the Alibaba Cloud
 * Model Studio console, copy the plan's API key, paste it here, and prove the key actually reaches
 * the Token Plan endpoint before anything is stored.
 */

/** Alibaba Cloud Model Studio console, where the Token Plan API key is created and copied. */
const AUTH_URL = "https://modelstudio.console.alibabacloud.com/";
/** The Token Plan's OpenAI-compatible endpoint; the base URL of pi-ai's `qwen-token-plan` provider. */
export const ALIBABA_TOKEN_PLAN_BASE_URL = "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";
/** The model gajae-code probes with; a key that cannot reach it cannot chat here either. */
const VALIDATION_MODEL = "deepseek-v4-pro";
/** Bound on upstream error text echoed back into a validation failure. */
const DETAILS_LIMIT = 300;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Upstream errors can echo the credential; strip it before the message reaches the login card. */
export function redactApiKey(text: string, apiKey: string): string {
	const cleaned = text.replace(/(Bearer\s+)[^\s,}"']+/giu, "$1[REDACTED]").replace(/[\x00-\x1f\x7f-\x9f]/gu, " ");
	if (!apiKey) return cleaned;
	// A key echoed with control characters interleaved must still match.
	const flexible = [...apiKey].map(escapeRegExp).join("[\\s\\x00-\\x1f\\x7f-\\x9f]*");
	return cleaned.replace(new RegExp(flexible, "gu"), "[REDACTED]").replaceAll(apiKey, "[REDACTED]");
}

/**
 * gajae-code's one-token inference probe against `/chat/completions`: a models listing proves only
 * that the endpoint answers, while this proves the key is entitled to run a model on the plan.
 */
async function validateAlibabaTokenPlanKey(apiKey: string, signal: AbortSignal | undefined): Promise<void> {
	const { validateOpenAICompatibleApiKey } = await import("@oh-my-pi/pi-ai/registry/api-key-validation");
	try {
		await validateOpenAICompatibleApiKey({
			provider: "Alibaba Token Plan",
			apiKey,
			baseUrl: ALIBABA_TOKEN_PLAN_BASE_URL,
			model: VALIDATION_MODEL,
			...(signal ? { signal } : {}),
		});
	} catch (error) {
		if (signal?.aborted) throw new Error("Login cancelled");
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(redactApiKey(message, apiKey).slice(0, DETAILS_LIMIT));
	}
}

/** Runs the flow and resolves to the bare API key, which is what pi-ai's `qwen-token-plan` auth sends as the bearer token. */
export async function loginAlibabaTokenPlan(interaction: AuthInteraction): Promise<string> {
	const signal = interaction.signal;
	interaction.notify({
		type: "auth_url",
		url: AUTH_URL,
		instructions: "Copy your API key from the Alibaba Cloud Model Studio console",
	});
	const entered = await interaction.prompt({
		type: "secret",
		message: "Paste your Alibaba Token Plan API key",
		placeholder: "sk-...",
		...(signal ? { signal } : {}),
	});
	if (signal?.aborted) throw new Error("Login cancelled");
	const apiKey = entered.trim();
	if (!apiKey) throw new Error("API key is required");

	interaction.notify({ type: "progress", message: "Validating API key..." });
	await validateAlibabaTokenPlanKey(apiKey, signal);
	return apiKey;
}
