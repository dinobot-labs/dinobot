import type { Models } from "@earendil-works/pi-ai/models";
import type { ProviderLoginResolver } from "./toolmode.ts";

/**
 * Plugin access to the deployment's stored model logins (ADR 0088). `Models.getAuth` selects the provider's active
 * pooled account and refreshes an expiring OAuth token through the same store the model requests use, so a plugin
 * never reads or writes `auth.json` itself. A provider with no stored login (or no bearer) resolves undefined; a failed
 * refresh rejects with pi-ai's error, which names the provider but not the token.
 */
export function providerLoginResolver(models: Models): ProviderLoginResolver {
	return async (providerId, signal) => {
		if (!models.getProvider(providerId)) return undefined;
		const resolved = await models.getAuth(providerId, signal ? { signal } : undefined);
		const apiKey = resolved?.auth.apiKey;
		if (!apiKey) return undefined;
		const baseUrl = resolved.auth.baseUrl ?? models.getProvider(providerId)?.baseUrl;
		return { apiKey, ...(baseUrl ? { baseUrl } : {}) };
	};
}
