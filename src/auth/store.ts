import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import {
	type AccountFailure,
	activateAccount,
	blockAccount,
	type CredentialPool,
	isBlocked,
	type PoolAccount,
	removeAccount,
	replaceCredential,
	selectAccount,
	settle,
	singleAccountPool,
	upsertAccount,
} from "./pool.ts";

/** The account a request was served by: its resolved API key/access token, else the account selected at dispatch. */
export type ServedAccount = { readonly apiKey?: string; readonly accountId?: string };

export type FailureOutcome = {
	/** The account the failure was attributed to; undefined when none matched (logged out, replaced). */
	readonly failed?: PoolAccount;
	/** The account that serves next. */
	readonly next?: PoolAccount;
	/** True when `next` is a different, unblocked account, so retrying the request can succeed. */
	readonly rotated: boolean;
};

/**
 * pi-ai `CredentialStore` whose entries are account pools. `read`/`modify` act on the selected account, so pi-ai's
 * auth resolution and OAuth refresh stay unchanged; the extra methods manage the pool.
 */
export interface AccountStore extends CredentialStore {
	pools(): Promise<ReadonlyMap<string, CredentialPool>>;
	/** The account serving `key` now, without changing anything. */
	selected(key: string): Promise<PoolAccount | undefined>;
	/** Add a login, or update the account with the same identity; it becomes active. */
	addAccount(key: string, credential: Credential): Promise<{ readonly account: PoolAccount; readonly added: boolean; readonly total: number }>;
	/** Manually switch to an account and clear its block; undefined for an unknown key or selector. */
	activate(key: string, selector: string): Promise<PoolAccount | undefined>;
	/** Remove one account; undefined for an unknown key or selector. */
	remove(key: string, selector: string): Promise<PoolAccount | undefined>;
	/** Block the account that served a failed request and select the next one. */
	markFailed(key: string, failure: AccountFailure, served: ServedAccount): Promise<FailureOutcome>;
}

type StoredPool = { readonly type: "pool" } & CredentialPool;
type StoredEntry = Credential | StoredPool;

export type CredentialFileOptions = { readonly now?: () => number };

/**
 * `AccountStore` backed by `<dataDir>/auth.json` (mode 0600). A provider with one healthy account is stored as a
 * plain credential, exactly the pre-pool format; several accounts (or a blocked one) are stored as
 * `{ "type": "pool", "active", "lastId", "accounts": [...] }`. Mutations are serialized per key and every write
 * replaces the file atomically. Single-process: the daemon owns the file.
 */
export function openCredentialFile(dataDir: string, options: CredentialFileOptions = {}): AccountStore {
	const now = options.now ?? Date.now;
	const path = join(dataDir, "auth.json");
	let loaded: Promise<Map<string, CredentialPool>> | undefined;
	const locks = new Map<string, Promise<unknown>>();
	let writing: Promise<unknown> = Promise.resolve();
	let writes = 0;

	const entries = () => {
		loaded ??= readFile(path, "utf8").then(
			(text) => {
				const raw = JSON.parse(text) as Record<string, StoredEntry>;
				const map = new Map<string, CredentialPool>();
				for (const [key, entry] of Object.entries(raw)) {
					if (entry.type === "pool") {
						const { type: _type, ...pool } = entry;
						if (pool.accounts.length > 0) map.set(key, pool);
					} else map.set(key, singleAccountPool(entry, 0));
				}
				return map;
			},
			(error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return new Map<string, CredentialPool>();
				loaded = undefined;
				throw error;
			},
		);
		return loaded;
	};

	const encode = (pool: CredentialPool): StoredEntry => {
		const only = pool.accounts.length === 1 ? pool.accounts[0]! : undefined;
		if (only && only.id === "1" && pool.lastId === 1 && !isBlocked(only, now())) return only.credential;
		return { type: "pool", active: pool.active, lastId: pool.lastId, accounts: pool.accounts };
	};

	const persist = (map: Map<string, CredentialPool>) => {
		const object = Object.fromEntries([...map].map(([key, pool]) => [key, encode(pool)]));
		const text = `${JSON.stringify(object, null, "\t")}\n`;
		const run = writing.then(async () => {
			await mkdir(dataDir, { recursive: true, mode: 0o700 });
			const temp = `${path}.${process.pid}.${++writes}.tmp`;
			await writeFile(temp, text, { mode: 0o600 });
			await chmod(temp, 0o600);
			await rename(temp, path);
		});
		writing = run.catch(() => undefined);
		return run;
	};

	const serialized = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
		const run = (locks.get(key) ?? Promise.resolve()).then(fn);
		const settled = run.catch(() => undefined);
		locks.set(key, settled);
		void settled.then(() => {
			if (locks.get(key) === settled) locks.delete(key);
		});
		return run;
	};

	/** Serialized read-modify-write of one pool; `fn` returns the next pool (undefined deletes) and a result. */
	const update = <T>(key: string, fn: (pool: CredentialPool | undefined) => Promise<{ pool: CredentialPool | undefined; result: T }> | { pool: CredentialPool | undefined; result: T }) =>
		serialized(key, async () => {
			const map = await entries();
			const before = map.get(key);
			const { pool, result } = await fn(before);
			if (pool !== before) {
				if (pool) map.set(key, pool);
				else map.delete(key);
				await persist(map);
			}
			return result;
		});

	const selectedOf = (pool: CredentialPool | undefined) => (pool ? selectAccount(pool, now()) : undefined);

	const matchServed = (pool: CredentialPool, served: ServedAccount) => {
		if (served.apiKey !== undefined) {
			const byKey = pool.accounts.find((account) => {
				const credential = account.credential;
				return credential.type === "oauth" ? credential.access === served.apiKey : credential.key === served.apiKey;
			});
			if (byKey) return byKey;
		}
		return served.accountId === undefined ? undefined : pool.accounts.find((account) => account.id === served.accountId);
	};

	return {
		async read(providerId) {
			return selectedOf((await entries()).get(providerId))?.credential;
		},
		async list() {
			return [...(await entries())].map(([providerId, pool]): CredentialInfo => ({ providerId, type: selectAccount(pool, now()).credential.type }));
		},
		modify(providerId, fn) {
			return update(providerId, async (pool) => {
				const current = pool ? settle(pool, now()) : undefined;
				const target = selectedOf(current);
				const next = await fn(target?.credential);
				if (next === undefined) return { pool, result: target?.credential };
				if (!current || !target) return { pool: singleAccountPool(next, now()), result: next };
				return { pool: replaceCredential(current, target.id, next), result: next };
			});
		},
		delete(providerId) {
			return update(providerId, () => ({ pool: undefined, result: undefined }));
		},
		async pools() {
			return new Map(await entries());
		},
		async selected(key) {
			return selectedOf((await entries()).get(key));
		},
		addAccount(key, credential) {
			return update(key, (pool) => {
				const { pool: next, account, added } = upsertAccount(pool, credential, now());
				return { pool: next, result: { account, added, total: next.accounts.length } };
			});
		},
		activate(key, selector) {
			return update(key, (pool) => {
				const next = pool ? activateAccount(pool, selector) : undefined;
				if (!next) return { pool, result: undefined };
				return { pool: next, result: next.accounts.find((account) => account.id === next.active) };
			});
		},
		remove(key, selector) {
			return update(key, (pool) => {
				if (!pool) return { pool, result: undefined };
				const { pool: next, removed } = removeAccount(pool, selector, now());
				return { pool: next, result: removed };
			});
		},
		markFailed(key, failure, served) {
			return update(key, (pool): { pool: CredentialPool | undefined; result: FailureOutcome } => {
				if (!pool) return { pool, result: { rotated: false } };
				const failed = matchServed(pool, served);
				if (!failed) return { pool, result: { rotated: false, next: selectAccount(pool, now()) } };
				// One account cannot rotate anywhere; keep the plain single-credential file untouched.
				if (pool.accounts.length < 2) return { pool, result: { failed, next: failed, rotated: false } };
				// A concurrent request already blocked it: just report where selection moved.
				const next = isBlocked(failed, now()) ? settle(pool, now()) : blockAccount(pool, failed.id, failure, now());
				const nextAccount = selectAccount(next, now());
				return {
					pool: next,
					result: { failed, next: nextAccount, rotated: nextAccount.id !== failed.id && !isBlocked(nextAccount, now()) },
				};
			});
		},
	};
}
