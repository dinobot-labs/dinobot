import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Google OAuth for the Workspace REST APIs, through the dinobot OAuth broker (`services/oauth-broker`).
 *
 * The daemon runs authorization code + PKCE itself. The broker receives the browser redirect at a public HTTPS
 * callback (so the link works from any device, also when the daemon has no browser) and adds the client secret to
 * token requests. The PKCE verifier stays here. The authorization response's `iss` is checked against the issuer
 * the broker announced before the code is redeemed (RFC 9207; Google advertises `iss`).
 */

export type BrokerConfig = {
	readonly issuer: string;
	readonly authorizationEndpoint: string;
	readonly tokenEndpoint: string;
	readonly clientId: string;
	readonly redirectUri: string;
	readonly authorizationParams: Readonly<Record<string, string>>;
};

type Stored = {
	readonly issuer: string;
	readonly clientId: string;
	readonly accessToken: string;
	readonly refreshToken?: string;
	readonly expiresAt: number;
	readonly scope: string;
};

type TokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string };

export class AuthorizationRequired extends Error {
	constructor(readonly url: string) {
		super(
			`Google authorization required. Send the user this link exactly as it is, ask them to open it and allow access, then retry once they say it is done: ${url}`,
		);
		this.name = "AuthorizationRequired";
	}
}

export type GoogleAuthOptions = {
	readonly broker: string;
	/** Token file; written with mode 0600. */
	readonly file: string;
	readonly scopes: readonly string[];
	/** Whether a granted scope set covers a needed scope (broader scopes imply narrower ones). Default: exact match. */
	readonly scopeGranted?: (needed: string, granted: ReadonlySet<string>) => boolean;
	readonly fetch?: typeof fetch;
	readonly now?: () => number;
	readonly pollIntervalMs?: number;
	/** How long a login link stays valid; matches the broker's pending lifetime. */
	readonly loginTimeoutMs?: number;
};

type Login = { readonly url: string; readonly done: Promise<void>; readonly expiresAt: number };

const base64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
/** Refresh this long before the access token expires. */
const EXPIRY_MARGIN_MS = 60_000;

export class GoogleAuth {
	private readonly fetch: typeof fetch;
	private readonly now: () => number;
	private config: Promise<BrokerConfig> | undefined;
	private stored: Promise<Stored | undefined> | undefined;
	private refreshing: Promise<Stored | undefined> | undefined;
	private login: Login | undefined;
	private readonly closed = new AbortController();

	constructor(private readonly options: GoogleAuthOptions) {
		this.fetch = options.fetch ?? fetch;
		this.now = options.now ?? Date.now;
	}

	/** A valid access token, refreshing it if needed; undefined when the user has to authorize (again). */
	async token(options: { forceRefresh?: boolean } = {}): Promise<string | undefined> {
		const stored = await this.current();
		if (!stored) return undefined;
		if (!options.forceRefresh && stored.expiresAt - EXPIRY_MARGIN_MS > this.now()) return stored.accessToken;
		return (await this.refresh(stored))?.accessToken;
	}

	/** Scopes this plugin needs that the stored grant lacks; all of them when nothing is stored. */
	async missingScopes(): Promise<string[]> {
		const stored = await this.current();
		const granted = new Set(stored?.scope.split(" ") ?? []);
		const covered = this.options.scopeGranted ?? ((needed: string, set: ReadonlySet<string>) => set.has(needed));
		return this.options.scopes.filter((scope) => !covered(scope, granted));
	}

	async status(): Promise<{ connected: boolean; scope?: string; missingScopes: string[] }> {
		const stored = await this.current();
		const missingScopes = await this.missingScopes();
		return { connected: stored !== undefined && missingScopes.length === 0, ...(stored ? { scope: stored.scope } : {}), missingScopes };
	}

	/**
	 * Starts (or reuses) a login and returns its link. Completion is collected from the broker in the background;
	 * `done` settles when the tokens are stored or the link expired.
	 */
	async startLogin(): Promise<Login> {
		if (this.login && this.login.expiresAt > this.now()) return this.login;
		const config = await this.brokerConfig();
		const state = base64url(randomBytes(32));
		const verifier = base64url(randomBytes(32));
		const challenge = base64url(createHash("sha256").update(verifier).digest());
		const url = new URL(config.authorizationEndpoint);
		const params = url.searchParams;
		params.set("client_id", config.clientId);
		params.set("redirect_uri", config.redirectUri);
		params.set("response_type", "code");
		params.set("scope", this.options.scopes.join(" "));
		params.set("state", state);
		params.set("code_challenge", challenge);
		params.set("code_challenge_method", "S256");
		for (const [name, value] of Object.entries(config.authorizationParams)) params.set(name, value);
		const expiresAt = this.now() + (this.options.loginTimeoutMs ?? 10 * 60_000);
		const done = this.complete(config, state, verifier, expiresAt);
		const login: Login = { url: url.toString(), done, expiresAt };
		this.login = login;
		done.then(
			() => {
				if (this.login === login) this.login = undefined;
			},
			() => {
				if (this.login === login) this.login = undefined;
			},
		);
		return login;
	}

	/** Revokes the grant at Google (best effort) and forgets it locally. */
	async disconnect(): Promise<boolean> {
		const stored = await this.current();
		if (!stored) return false;
		await this.fetch("https://oauth2.googleapis.com/revoke", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ token: stored.refreshToken ?? stored.accessToken }),
			signal: AbortSignal.any([this.closed.signal, AbortSignal.timeout(10_000)]),
		}).catch(() => undefined);
		await this.save(undefined);
		return true;
	}

	close(): void {
		this.closed.abort();
	}

	private async complete(config: BrokerConfig, state: string, verifier: string, expiresAt: number): Promise<void> {
		const interval = this.options.pollIntervalMs ?? 1_500;
		for (;;) {
			if (this.closed.signal.aborted) throw new Error("google auth closed");
			if (this.now() > expiresAt) throw new Error("google login link expired");
			const response = await this.fetch(`${this.options.broker}/v1/pending/${state}`, { signal: this.closed.signal }).catch(() => undefined);
			if (response?.status === 200) {
				const payload = (await response.json()) as { code?: string; iss?: string; error?: string; error_description?: string };
				// RFC 9207: Google advertises authorization_response_iss_parameter_supported, so `iss` must be present and exact.
				if (payload.iss !== config.issuer) throw new Error(`google login rejected: unexpected issuer ${JSON.stringify(payload.iss ?? null)}`);
				if (payload.error !== undefined || payload.code === undefined) {
					throw new Error(`google login failed: ${payload.error ?? "no code"}${payload.error_description ? ` (${payload.error_description})` : ""}`);
				}
				const body = new URLSearchParams({ grant_type: "authorization_code", code: payload.code, code_verifier: verifier });
				const tokens = await this.tokenRequest(config, body);
				if (!tokens.access_token) throw new Error(`google token exchange failed: ${tokens.error ?? "no access token"}`);
				await this.save(this.toStored(config, tokens));
				return;
			}
			await Bun.sleep(interval);
		}
	}

	private refresh(stored: Stored): Promise<Stored | undefined> {
		this.refreshing ??= (async () => {
			try {
				if (!stored.refreshToken) {
					await this.save(undefined);
					return undefined;
				}
				const config = await this.brokerConfig();
				const tokens = await this.tokenRequest(config, new URLSearchParams({ grant_type: "refresh_token", refresh_token: stored.refreshToken }));
				if (!tokens.access_token) {
					// invalid_grant: revoked, expired (testing-mode apps expire refresh tokens after 7 days) or another client.
					if (tokens.error === "invalid_grant" || tokens.error === "unauthorized_client" || tokens.error === "invalid_client") await this.save(undefined);
					else throw new Error(`google token refresh failed: ${tokens.error ?? "no access token"}`);
					return undefined;
				}
				const next = this.toStored(config, { ...tokens, refresh_token: tokens.refresh_token ?? stored.refreshToken, scope: tokens.scope ?? stored.scope });
				await this.save(next);
				return next;
			} finally {
				this.refreshing = undefined;
			}
		})();
		return this.refreshing;
	}

	private async tokenRequest(config: BrokerConfig, body: URLSearchParams): Promise<TokenResponse> {
		const response = await this.fetch(config.tokenEndpoint, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
			body,
			signal: AbortSignal.any([this.closed.signal, AbortSignal.timeout(30_000)]),
		});
		const text = await response.text();
		try {
			return JSON.parse(text) as TokenResponse;
		} catch {
			throw new Error(`google token endpoint answered ${response.status} without JSON`);
		}
	}

	private toStored(config: BrokerConfig, tokens: TokenResponse): Stored {
		return {
			issuer: config.issuer,
			clientId: config.clientId,
			accessToken: tokens.access_token!,
			...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
			expiresAt: this.now() + (tokens.expires_in ?? 3600) * 1000,
			scope: tokens.scope ?? this.options.scopes.join(" "),
		};
	}

	private brokerConfig(): Promise<BrokerConfig> {
		this.config ??= (async () => {
			const response = await this.fetch(`${this.options.broker}/v1/google`, { signal: AbortSignal.any([this.closed.signal, AbortSignal.timeout(15_000)]) });
			if (!response.ok) throw new Error(`google oauth broker ${this.options.broker} answered ${response.status}`);
			return (await response.json()) as BrokerConfig;
		})().catch((error) => {
			this.config = undefined;
			throw error;
		});
		return this.config;
	}

	/** The stored grant, if it belongs to the broker's current client and issuer. */
	private async current(): Promise<Stored | undefined> {
		this.stored ??= readFile(this.options.file, "utf8").then(
			(text) => JSON.parse(text) as Stored,
			(error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return undefined;
				throw error;
			},
		);
		const stored = await this.stored;
		if (!stored) return undefined;
		const config = await this.brokerConfig().catch(() => undefined);
		// A grant from another client or issuer cannot be refreshed here (and must not be reused).
		if (config && (config.clientId !== stored.clientId || config.issuer !== stored.issuer)) {
			await this.save(undefined);
			return undefined;
		}
		return stored;
	}

	private async save(stored: Stored | undefined): Promise<void> {
		if (!stored) {
			await rm(this.options.file, { force: true });
		} else {
			await mkdir(dirname(this.options.file), { recursive: true });
			const temporary = `${this.options.file}.${process.pid}.tmp`;
			await writeFile(temporary, JSON.stringify(stored), { mode: 0o600 });
			await chmod(temporary, 0o600);
			await rename(temporary, this.options.file);
		}
		// Only a grant that is on disk is served: a restart sees exactly what the running daemon used.
		this.stored = Promise.resolve(stored);
	}
}
