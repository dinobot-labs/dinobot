import type { AuthInteraction, CredentialStore } from "@earendil-works/pi-ai";

/** One entry of oh-my-pi's `/login` list. */
export type LoginProvider = {
	readonly id: string;
	readonly name: string;
	/** Credential key the login stores under (oh-my-pi's `storeCredentialsAs`, else `id`). */
	readonly storeAs: string;
	/** pi-ai provider that serves models with this credential; absent when this build has no transport for it. */
	readonly modelProvider?: string;
};

export type LoginResult = {
	readonly provider: LoginProvider;
	readonly type: "oauth" | "api_key";
	/** Account label for display (email, org), when the provider reports one. */
	readonly identity?: string;
	/** Pool id of the logged-in account and the provider's account count after the login. */
	readonly account?: { readonly id: string; readonly added: boolean; readonly total: number };
};

/** One pooled account, no secrets. */
export type AccountInfo = {
	readonly id: string;
	readonly type: "oauth" | "api_key";
	/** `email (org)`, account id or masked key. */
	readonly label?: string;
	/** Serves the provider's requests now. */
	readonly active: boolean;
	/** Skipped by rotation until this instant (epoch ms) after a failure. */
	readonly blockedUntil?: number;
	readonly lastFailure?: "rate_limit" | "quota" | "auth";
};

export type ProviderAccounts = { readonly key: string; readonly accounts: readonly AccountInfo[] };

/**
 * Credentials of the daemon, persisted to `<dataDir>/auth.json` (mode 0600). Login and refresh run
 * oh-my-pi's provider implementations; `credentials` is what pi-ai `Models` reads at request time.
 */
export interface AuthService {
	readonly credentials: CredentialStore;
	providers(): Promise<readonly LoginProvider[]>;
	/** Rejects for an unknown provider id, a cancelled prompt, or a failed flow. */
	login(providerId: string, interaction: AuthInteraction): Promise<LoginResult>;
	/**
	 * Accepts a login id or a stored credential key; false when nothing was stored. Without `account` every account
	 * of the provider is removed; with it (pool id, email or label) only that one.
	 */
	logout(providerId: string, account?: string): Promise<boolean>;
	/** Stored credential keys with their type, no secrets. */
	status(): Promise<readonly { readonly key: string; readonly type: "oauth" | "api_key" }[]>;
	/** Pooled accounts per stored credential key. Login appends accounts; rate/usage-limited ones rotate automatically. */
	accounts(): Promise<readonly ProviderAccounts[]>;
	/** Make one account active (pool id, email or label); rejects for an unknown provider key or account. */
	useAccount(key: string, account: string): Promise<AccountInfo>;
}
