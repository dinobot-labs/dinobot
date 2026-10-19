import type { AuthInteraction, OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import type { MutableModels, Provider } from "@earendil-works/pi-ai/models";
import { builtinModels, builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { withAnthropicToolErrorText } from "../core/anthropic-tool-errors.ts";
import { withModelImageResize } from "../core/model-images.ts";
import { FAST_ROUTER, type FastRouter } from "../core/fast.ts";
import { loginAlibabaTokenPlan } from "./alibaba-token-plan.ts";
import { type CustomProviderConfig, customLoginProvider, customProvider, loginCustomProvider } from "./custom-providers.ts";
import { captureBrowserSession } from "./browser-session.ts";
import { accountInfos } from "./pool.ts";
import { withRefusalRetry } from "./refusal.ts";
import { withRequestBudget } from "./request-budget.ts";
import { recordServedAccount, type RotationLog, withAccountRotation } from "./rotation.ts";
import { type AccountStore, openCredentialFile } from "./store.ts";
import type { AccountInfo, AuthService, LoginProvider, LoginResult, ProviderAccounts } from "./types.ts";

export { type AccountStore, openCredentialFile } from "./store.ts";

/** The daemon's auth service; its credential store pools several accounts per provider. */
export type BotAuth = AuthService & { readonly credentials: AccountStore };

/** oh-my-pi login ids whose credential a differently named pi-ai provider serves. */
export const LOGIN_MODEL_PROVIDERS: Readonly<Record<string, string>> = {
	"kimi-code": "kimi-coding",
	moonshot: "moonshotai",
	"xai-oauth": "xai",
	"opencode-zen": "opencode",
	"zhipu-coding-plan": "zai-coding-cn",
	"minimax-code": "minimax",
	"minimax-code-cn": "minimax-cn",
	"alibaba-token-plan": "qwen-token-plan",
};

/**
 * Login ids dinobot lists under its own name. oh-my-pi calls `alibaba-token-plan` "QwenCloud Token
 * Plan" after the console that issues its key; gajae-code and the key's `sk-` docs call the product
 * Alibaba Token Plan, so `/login` advertises that name and stays findable under either spelling.
 */
export const LOGIN_DISPLAY_NAMES: Readonly<Record<string, string>> = {
	"alibaba-token-plan": "Alibaba Token Plan",
};

/** Login flows dinobot runs instead of oh-my-pi's, keyed by the oh-my-pi login id; each returns a bare API key. */
const OWNED_LOGIN_FLOWS: Readonly<Record<string, (interaction: AuthInteraction) => Promise<string>>> = {
	"alibaba-token-plan": loginAlibabaTokenPlan,
};

// oh-my-pi loads its native addon at import time, so it is imported only when a login or refresh needs it.
const ohMyPi = async () => {
	const [oauth, registry] = await Promise.all([
		import("@oh-my-pi/pi-ai/registry/oauth/index"),
		import("@oh-my-pi/pi-ai/registry/registry"),
	]);
	return { ...oauth, ...registry };
};

let piAiProviderIds: ReadonlySet<string> | undefined;
const modelProviderIds = () => {
	piAiProviderIds ??= new Set(builtinProviders().map(provider => provider.id));
	return piAiProviderIds;
};

export function loginProvider(info: { id: string; name: string; storeCredentialsAs?: string }): LoginProvider {
	const storeAs = info.storeCredentialsAs ?? info.id;
	const modelProvider = LOGIN_MODEL_PROVIDERS[info.id] ?? (modelProviderIds().has(storeAs) ? storeAs : undefined);
	const name = LOGIN_DISPLAY_NAMES[info.id] ?? info.name;
	return modelProvider ? { id: info.id, name, storeAs, modelProvider } : { id: info.id, name, storeAs };
}

const credentialKey = (provider: LoginProvider) => provider.modelProvider ?? provider.storeAs;

/** oh-my-pi's paste-key prompts do not set `secret`; mask anything that asks for a key or token. */
const SECRET_PROMPT = /\b(api[ -]?key|key|token|secret|password)\b/i;

export type OpenAuthOptions = {
	readonly now?: () => number;
	/** User-defined OpenAI-compatible providers (manifest `providers:`); listed first in `/login`, shadowing a same-id oh-my-pi login. */
	readonly customProviders?: readonly CustomProviderConfig[];
};

export function openAuth(dataDir: string, options: OpenAuthOptions = {}): BotAuth {
	const now = options.now ?? Date.now;
	const custom = new Map((options.customProviders ?? []).map((config) => [config.id, config]));
	const credentials = openCredentialFile(dataDir, { now });
	let listed: Promise<readonly LoginProvider[]> | undefined;

	const providers = () => {
		listed ??= ohMyPi().then(
			omp => [
				...[...custom.values()].map(customLoginProvider),
				...omp.getOAuthProviders().map(loginProvider).filter((provider) => !custom.has(provider.id)),
			],
			error => {
				listed = undefined;
				throw error;
			},
		);
		return listed;
	};

	/** A stored credential key for a login id or key, or undefined when nothing is stored under either. */
	const storedKey = async (providerId: string) => {
		const pools = await credentials.pools();
		if (pools.has(providerId)) return providerId;
		const provider = (await providers()).find((entry) => entry.id === providerId);
		const key = provider ? credentialKey(provider) : undefined;
		return key !== undefined && pools.has(key) ? key : undefined;
	};

	return {
		credentials,
		providers,
		async login(providerId: string, interaction: AuthInteraction): Promise<LoginResult> {
			const provider = (await providers()).find(entry => entry.id === providerId);
			if (!provider) throw new Error(`unknown login provider: ${providerId}`);
			const key = credentialKey(provider);
			const storeApiKey = async (apiKey: string): Promise<LoginResult> => {
				if (!apiKey) throw new Error(`no API key entered for ${provider.name}; nothing stored`);
				const stored = await credentials.addAccount(key, { type: "api_key", key: apiKey });
				return { provider, type: "api_key", account: { id: stored.account.id, added: stored.added, total: stored.total } };
			};
			const own = custom.get(providerId);
			if (own) return storeApiKey(await loginCustomProvider(own, interaction));
			const owned = OWNED_LOGIN_FLOWS[providerId];
			if (owned) return storeApiKey(await owned(interaction));

			const omp = await ohMyPi();
			const definition = omp.getProviderDefinition(providerId) ?? omp.getOAuthProvider(providerId);
			if (!definition?.login) throw new Error(`unknown login provider: ${providerId}`);
			const signal = interaction.signal;
			const result = await definition.login({
				onAuth: ({ url, launchUrl, instructions }) =>
					interaction.notify({ type: "auth_url", url: launchUrl ?? url, ...(instructions ? { instructions } : {}) }),
				onProgress: message => interaction.notify({ type: "progress", message }),
				onPrompt: prompt =>
					interaction.prompt({
						type: prompt.secret || SECRET_PROMPT.test(prompt.message) ? "secret" : "text",
						message: prompt.message,
						...(prompt.placeholder ? { placeholder: prompt.placeholder } : {}),
						...(signal ? { signal } : {}),
					}),
				...("pasteCodeFlow" in definition && definition.pasteCodeFlow
					? {
							onManualCodeInput: (codeSignal?: AbortSignal) =>
								interaction.prompt({
									type: "manual_code",
									message: "Paste the authorization code (or full redirect URL):",
									...(codeSignal ? { signal: codeSignal } : {}),
								}),
						}
					: {}),
				onBrowserSession: (request, sessionSignal) => captureBrowserSession(request, sessionSignal ?? signal),
				...(signal ? { signal } : {}),
			});
			if (typeof result === "string") return storeApiKey(result);
			const credential: OAuthCredential = { ...result, type: "oauth", authorizedAt: Date.now(), loginProvider: providerId };
			const stored = await credentials.addAccount(key, credential);
			const account = { id: stored.account.id, added: stored.added, total: stored.total };
			const email = result.email ?? result.accountId;
			const org = result.orgName ?? result.orgId;
			const identity = email ? (org ? `${email} (${org})` : email) : org;
			return identity ? { provider, type: "oauth", identity, account } : { provider, type: "oauth", account };
		},
		async logout(providerId: string, account?: string): Promise<boolean> {
			const key = await storedKey(providerId);
			if (key === undefined) return false;
			if (account !== undefined) return (await credentials.remove(key, account)) !== undefined;
			await credentials.delete(key);
			return true;
		},
		async status() {
			return (await credentials.list()).map(info => ({ key: info.providerId, type: info.type }));
		},
		async accounts(): Promise<ProviderAccounts[]> {
			const at = now();
			return [...(await credentials.pools())].map(([key, pool]) => ({ key, accounts: accountInfos(pool, at) }));
		},
		async useAccount(providerId: string, account: string): Promise<AccountInfo> {
			const key = await storedKey(providerId);
			if (key === undefined) throw new Error(`nothing stored for ${providerId}`);
			const activated = await credentials.activate(key, account);
			if (!activated) throw new Error(`no account "${account}" for ${key}; see /accounts`);
			const info = accountInfos((await credentials.pools()).get(key)!, now()).find((entry) => entry.id === activated.id);
			return info!;
		},
	};
}

function withLoginRefresh(provider: Provider): Provider {
	const own = provider.auth.oauth;
	const oauth: OAuthAuth = {
		...own,
		name: own?.name ?? provider.name,
		login: own ? own.login.bind(own) : () => Promise.reject(new Error(`${provider.name} has no pi-ai login; use /login`)),
		async refresh(credential, signal) {
			const loginId = credential.loginProvider;
			if (typeof loginId !== "string") {
				if (!own) throw new Error(`${provider.name} cannot refresh this credential; log in again`);
				return own.refresh(credential, signal);
			}
			const { refreshOAuthToken } = await ohMyPi();
			const refreshed = await refreshOAuthToken(loginId as Parameters<typeof refreshOAuthToken>[0], credential, signal);
			return { ...credential, ...refreshed, type: "oauth", loginProvider: loginId };
		},
		toAuth: credential => (own ? own.toAuth(credential) : Promise.resolve({ apiKey: credential.access })),
	};
	return { ...provider, auth: { ...provider.auth, oauth } };
}

/**
 * pi-ai `Models` over every builtin provider plus the manifest's custom OpenAI-compatible ones, reading `auth.credentials`; oh-my-pi logins refresh through oh-my-pi.
 * Requests rotate to the provider's next pooled account on rate/usage-limit or credential failures (ADR 0045), and
 * each attempt is bounded by the per-request budget (ADR 0074). A provider policy refusal gets exactly one retry
 * per distinct context, with oversized tool outputs truncated; the refusal wrapper sits outside the budget so the
 * initial attempt and the retry are budgeted independently (ADR 0087). Every payload's images are resized to the
 * target model's catalog profile before the request leaves (ADR 0096), so a screenshot of any pixel size still fits
 * the model's many-image limit.
 * pi-ai reaches its OAuth flows through variable-specifier imports that the compiled binary cannot resolve
 * ("Cannot find module './openai-codex.js'"), so they are registered statically first.
 */
export function createBotModels(
	auth: { readonly credentials: AccountStore },
	fast: FastRouter = FAST_ROUTER,
	options: { readonly log?: RotationLog; readonly customProviders?: readonly CustomProviderConfig[] } = {},
): MutableModels {
	registerBunOAuthFlows();
	const models = builtinModels({ credentials: auth.credentials });
	for (const config of options.customProviders ?? []) {
		if (models.getProvider(config.id)) throw new Error(`custom provider "${config.id}" collides with a builtin provider`);
		models.setProvider(customProvider(config));
	}
	for (const provider of models.getProviders()) models.setProvider(withRefusalRetry(withRequestBudget(fast.wrapProvider(withModelImageResize(withAnthropicToolErrorText(recordServedAccount(withLoginRefresh(provider))))))));
	return withAccountRotation(models, auth.credentials, options.log);
}
