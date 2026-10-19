import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, Credential, OAuthCredential } from "@earendil-works/pi-ai";
import { createModels, type Provider } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { openAuth, openCredentialFile } from "../src/auth/index.ts";
import { classifyAccountFailure, parseRetryAfterMs } from "../src/auth/pool.ts";
import { recordServedAccount, withAccountRotation } from "../src/auth/rotation.ts";
import { accountsCommand, logoutCommand } from "../src/commands/builtin.ts";
import type { CommandIO } from "../src/commands/types.ts";

let dir: string | undefined;
afterEach(async () => {
	if (dir) await rm(dir, { recursive: true, force: true });
	dir = undefined;
});

async function dataDir() {
	dir = await mkdtemp(join(tmpdir(), "dinobot-accounts-"));
	return join(dir, "data");
}

const oauth = (email: string, access: string, extra: Record<string, unknown> = {}): OAuthCredential => ({
	type: "oauth",
	access,
	refresh: `r-${access}`,
	expires: Date.now() + 3_600_000,
	email,
	...extra,
});

function clock(start = 1_000_000) {
	let now = start;
	return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe("failure classification", () => {
	test("rotates on account-level failures only", () => {
		expect(classifyAccountFailure("You have hit your ChatGPT usage limit (pro plan). Try again in ~42 min.")).toEqual({ kind: "quota", retryAfterMs: 42 * 60_000 });
		expect(classifyAccountFailure('429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}')).toEqual({ kind: "rate_limit" });
		expect(classifyAccountFailure("OAuth refresh failed for anthropic")).toEqual({ kind: "auth" });
		expect(classifyAccountFailure('401 {"error":{"type":"authentication_error","message":"invalid x-api-key"}}')).toEqual({ kind: "auth" });
		expect(classifyAccountFailure("You exceeded your current quota, please check your plan and billing details.")?.kind).toBe("quota");
		// Provider health, request shape and policy errors keep the account.
		expect(classifyAccountFailure('529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}')).toBeUndefined();
		expect(classifyAccountFailure("prompt is too long: 210000 tokens > 200000 maximum")).toBeUndefined();
		expect(classifyAccountFailure("500 Internal server error")).toBeUndefined();
		expect(classifyAccountFailure("403 Forbidden: request not allowed")).toBeUndefined();
		expect(classifyAccountFailure(undefined)).toBeUndefined();
	});

	test("parses provider reset hints", () => {
		expect(parseRetryAfterMs('{"resets_in_seconds": 90}')).toBe(90_000);
		expect(parseRetryAfterMs('"resets_at": 1000000100', 1_000_000_000_000)).toBe(100_000);
		expect(parseRetryAfterMs("retry after 30s")).toBe(30_000);
		expect(parseRetryAfterMs("Please try again in 2 hours")).toBe(7_200_000);
		expect(parseRetryAfterMs("resets in 3 days")).toBe(3 * 86_400_000);
		expect(parseRetryAfterMs("no hint here")).toBeUndefined();
	});
});

describe("account pool store", () => {
	test("legacy auth.json loads unchanged and a single account keeps the plain format", async () => {
		const data = await dataDir();
		await mkdir(data, { recursive: true });
		const legacy = { anthropic: oauth("a@x.com", "A"), openai: { type: "api_key", key: "sk-1" } };
		await writeFile(join(data, "auth.json"), JSON.stringify(legacy));
		const store = openCredentialFile(data);
		expect(await store.read("anthropic")).toEqual(legacy.anthropic);
		expect(await store.list()).toEqual([
			{ providerId: "anthropic", type: "oauth" },
			{ providerId: "openai", type: "api_key" },
		]);
		// A refresh of the only account writes the plain credential back.
		await store.modify("anthropic", async (current) => ({ ...(current as OAuthCredential), access: "A2" }));
		expect(JSON.parse(await readFile(join(data, "auth.json"), "utf8")).anthropic).toEqual({ ...legacy.anthropic, access: "A2" });
	});

	test("a second identity appends an active account; the same identity updates in place", async () => {
		const data = await dataDir();
		const store = openCredentialFile(data);
		expect(await store.addAccount("anthropic", oauth("a@x.com", "A"))).toMatchObject({ added: true, total: 1, account: { id: "1" } });
		expect(await store.addAccount("anthropic", oauth("b@x.com", "B"))).toMatchObject({ added: true, total: 2, account: { id: "2" } });
		expect(((await store.read("anthropic")) as OAuthCredential).access).toBe("B");
		// Re-login of a@x.com: same row, fresh tokens, and it becomes active again.
		expect(await store.addAccount("anthropic", oauth("A@X.com", "A-new"))).toMatchObject({ added: false, total: 2, account: { id: "1" } });
		expect(((await store.read("anthropic")) as OAuthCredential).access).toBe("A-new");
		// One email in two orgs is two accounts.
		expect(await store.addAccount("anthropic", oauth("a@x.com", "A-team", { orgId: "team" }))).toMatchObject({ added: true, total: 3, account: { id: "3" } });

		const file = JSON.parse(await readFile(join(data, "auth.json"), "utf8"));
		expect(file.anthropic).toMatchObject({ type: "pool", active: "3", lastId: 3 });
		expect(file.anthropic.accounts.map((account: { id: string }) => account.id)).toEqual(["1", "2", "3"]);
		expect((await stat(join(data, "auth.json"))).mode & 0o777).toBe(0o600);
		// Survives reopening.
		expect(((await openCredentialFile(data).read("anthropic")) as OAuthCredential).access).toBe("A-team");
	});

	test("refresh through modify updates only the selected account", async () => {
		const store = openCredentialFile(await dataDir());
		await store.addAccount("p", oauth("a@x.com", "A"));
		await store.addAccount("p", oauth("b@x.com", "B"));
		await store.modify("p", async (current) => ({ ...(current as OAuthCredential), access: "B2" }));
		const pool = (await store.pools()).get("p")!;
		expect(pool.accounts.map((account) => (account.credential as OAuthCredential).access)).toEqual(["A", "B2"]);
	});

	test("failures block the serving account and rotate; selection is sticky after the block ends", async () => {
		const time = clock();
		const store = openCredentialFile(await dataDir(), { now: time.now });
		await store.addAccount("p", oauth("a@x.com", "A"));
		await store.addAccount("p", oauth("b@x.com", "B"));
		await store.addAccount("p", oauth("c@x.com", "C"));
		await store.activate("p", "1");

		const first = await store.markFailed("p", { kind: "rate_limit", retryAfterMs: 60_000 }, { apiKey: "A" });
		expect(first).toMatchObject({ rotated: true, failed: { id: "1" }, next: { id: "2" } });
		// A concurrent request that was also served by A does not block anything else and may retry on B.
		const concurrent = await store.markFailed("p", { kind: "rate_limit" }, { apiKey: "A" });
		expect(concurrent).toMatchObject({ rotated: true, next: { id: "2" } });
		expect((await store.pools()).get("p")!.accounts.find((account) => account.id === "2")!.blockedUntil).toBeUndefined();

		await store.markFailed("p", { kind: "quota" }, { apiKey: "B" });
		expect((await store.selected("p"))?.id).toBe("3");
		// All blocked: no rotation, and selection falls back to the account that unblocks first (A).
		const last = await store.markFailed("p", { kind: "quota" }, { apiKey: "C" });
		expect(last.rotated).toBe(false);
		expect((await store.selected("p"))?.id).toBe("1");

		time.advance(61_000);
		expect((await store.selected("p"))?.id).toBe("1");
		expect(((await store.read("p")) as OAuthCredential).access).toBe("A");
	});

	test("attribution falls back to the dispatch-time account and ignores unknown keys", async () => {
		const store = openCredentialFile(await dataDir());
		await store.addAccount("p", oauth("a@x.com", "A"));
		await store.addAccount("p", oauth("b@x.com", "B"));
		expect(await store.markFailed("p", { kind: "auth" }, { apiKey: "stale" })).toMatchObject({ rotated: false });
		expect(await store.markFailed("p", { kind: "auth" }, { accountId: "2" })).toMatchObject({ rotated: true, next: { id: "1" } });
	});

	test("a single account is never blocked or rewritten as a pool", async () => {
		const data = await dataDir();
		const store = openCredentialFile(data);
		await store.addAccount("p", oauth("a@x.com", "A"));
		expect(await store.markFailed("p", { kind: "quota" }, { apiKey: "A" })).toMatchObject({ rotated: false, failed: { id: "1" } });
		expect(JSON.parse(await readFile(join(data, "auth.json"), "utf8")).p.type).toBe("oauth");
	});

	test("remove and activate by id or email; removing the last account deletes the provider", async () => {
		const store = openCredentialFile(await dataDir());
		await store.addAccount("p", oauth("a@x.com", "A"));
		await store.addAccount("p", oauth("b@x.com", "B"));
		expect((await store.activate("p", "a@x.com"))?.id).toBe("1");
		expect(await store.activate("p", "nobody")).toBeUndefined();
		expect((await store.remove("p", "1"))?.id).toBe("1");
		expect((await store.selected("p"))?.id).toBe("2");
		// Ids are not reused: a new login gets #3, so an old selector never retargets.
		expect((await store.addAccount("p", oauth("c@x.com", "C"))).account.id).toBe("3");
		await store.remove("p", "2");
		await store.remove("p", "3");
		expect(await store.read("p")).toBeUndefined();
		expect(await store.list()).toEqual([]);
	});
});

/** A faux provider whose stored api_key/oauth credential becomes the request key, answering per key. */
function keyedProvider(answer: (apiKey: string | undefined) => AssistantMessage) {
	const faux = fauxProvider({ provider: "keyed", models: [{ id: "m" }] });
	const seen: (string | undefined)[] = [];
	faux.setResponses(Array.from({ length: 20 }, () => (_context: unknown, options: { apiKey?: string } | undefined) => {
		seen.push(options?.apiKey);
		return answer(options?.apiKey);
	}));
	const provider: Provider = {
		...faux.provider,
		auth: {
			apiKey: {
				name: "keyed",
				resolve: async ({ credential }) => (credential?.key ? { auth: { apiKey: credential.key } } : undefined),
			},
			oauth: {
				name: "keyed",
				login: async () => {
					throw new Error("no login");
				},
				refresh: async (credential) => credential,
				toAuth: async (credential) => ({ apiKey: credential.access }),
			},
		},
	};
	return { provider, model: faux.getModel(), seen };
}

async function rotatingModels(answer: (apiKey: string | undefined) => AssistantMessage, accounts: Credential[]) {
	const store = openCredentialFile(await dataDir());
	for (const credential of accounts) await store.addAccount("keyed", credential);
	await store.activate("keyed", "1");
	const { provider, model, seen } = keyedProvider(answer);
	const models = createModels({ credentials: store });
	models.setProvider(recordServedAccount(provider));
	const logs: string[] = [];
	withAccountRotation(models, store, (message) => logs.push(message));
	return { store, models, model, seen, logs };
}

const limited = (apiKey: string | undefined) =>
	apiKey === "B" ? fauxAssistantMessage(`hello from ${apiKey}`) : fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate_limit_error: Too Many Requests" });

describe("request rotation", () => {
	test("a rate-limited account is retried on the next one without surfacing the error", async () => {
		const { store, models, model, seen, logs } = await rotatingModels(limited, [
			{ type: "api_key", key: "A" },
			{ type: "api_key", key: "B" },
		]);
		const message = await models.completeSimple(model, { messages: [{ role: "user", content: "hi", timestamp: 0 }] });
		expect(message.stopReason).toBe("stop");
		expect(message.content).toEqual([{ type: "text", text: "hello from B" }]);
		expect(seen).toEqual(["A", "B"]);
		expect(logs).toEqual(["dinobot: keyed account #1 (****) hit rate_limit; switched to #2 (****)"]);
		// Sticky: the next request goes straight to B.
		await models.completeSimple(model, { messages: [{ role: "user", content: "again", timestamp: 0 }] });
		expect(seen).toEqual(["A", "B", "B"]);
		expect((await store.selected("keyed"))?.id).toBe("2");
	});

	test("oauth accounts rotate through pi-ai's oauth resolution too", async () => {
		const { models, model, seen } = await rotatingModels(limited, [oauth("a@x.com", "A"), oauth("b@x.com", "B")]);
		const events: string[] = [];
		const stream = models.streamSimple(model, { messages: [{ role: "user", content: "hi", timestamp: 0 }] });
		for await (const event of stream) events.push(event.type);
		expect((await stream.result()).stopReason).toBe("stop");
		expect(seen).toEqual(["A", "B"]);
		// The failed attempt's events are dropped; the consumer sees one clean stream.
		expect(events.filter((type) => type === "start")).toHaveLength(1);
		expect(events).not.toContain("error");
	});

	test("when every account is limited the last error surfaces once", async () => {
		const { models, model, seen } = await rotatingModels(() => fauxAssistantMessage("", { stopReason: "error", errorMessage: "You have hit your ChatGPT usage limit." }), [
			{ type: "api_key", key: "A" },
			{ type: "api_key", key: "B" },
		]);
		const message = await models.completeSimple(model, { messages: [{ role: "user", content: "hi", timestamp: 0 }] });
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("usage limit");
		expect(seen).toEqual(["A", "B"]);
	});

	test("non-account errors, explicit api keys and single accounts pass through", async () => {
		const overloaded = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "529 overloaded_error" });
		const a = await rotatingModels(overloaded, [{ type: "api_key", key: "A" }, { type: "api_key", key: "B" }]);
		expect((await a.models.completeSimple(a.model, { messages: [{ role: "user", content: "hi", timestamp: 0 }] })).stopReason).toBe("error");
		expect(a.seen).toEqual(["A"]);

		const b = await rotatingModels(limited, [{ type: "api_key", key: "A" }, { type: "api_key", key: "B" }]);
		await b.models.completeSimple(b.model, { messages: [{ role: "user", content: "hi", timestamp: 0 }] }, { apiKey: "A" });
		expect(b.seen).toEqual(["A"]);

		const c = await rotatingModels(limited, [{ type: "api_key", key: "A" }]);
		expect((await c.models.completeSimple(c.model, { messages: [{ role: "user", content: "hi", timestamp: 0 }] })).stopReason).toBe("error");
		expect(c.seen).toEqual(["A"]);
	});

	test("an aborted request does not rotate", async () => {
		const { models, model, seen, store } = await rotatingModels(limited, [{ type: "api_key", key: "A" }, { type: "api_key", key: "B" }]);
		const abort = new AbortController();
		abort.abort();
		await models.completeSimple(model, { messages: [{ role: "user", content: "hi", timestamp: 0 }] }, { signal: abort.signal });
		expect(seen.length).toBeLessThanOrEqual(1);
		expect((await store.selected("keyed"))?.id).toBe("1");
	});
});

function captureIO(answers: string[] = [], interactive = true) {
	const printed: { text: string; level: string }[] = [];
	const prompts: unknown[] = [];
	const io: CommandIO = {
		signal: new AbortController().signal,
		interactive,
		print: (text, level = "info") => printed.push({ text, level }),
		notify: () => {},
		state: () => {},
		prompt: async (prompt) => {
			prompts.push(prompt);
			const answer = answers.shift();
			if (answer === undefined) throw new Error("unexpected prompt");
			return answer;
		},
	};
	return { io, printed, prompts };
}

const invocation = (io: CommandIO) => ({ surface: "tui" as const, channel: "tui", threadKey: "t", userId: "u", context: BACKGROUND_CONTEXT, io });

describe("/accounts and /logout", () => {
	test("lists pools, switches by argument row, and removes one account", async () => {
		const time = clock(Date.now());
		const auth = openAuth(await dataDir(), { now: time.now });
		await auth.credentials.addAccount("anthropic", oauth("a@x.com", "A", { orgName: "Personal" }));
		await auth.credentials.addAccount("anthropic", oauth("b@x.com", "B"));
		await auth.credentials.addAccount("openai", { type: "api_key", key: "sk-abcdef123456" });
		await auth.credentials.markFailed("anthropic", { kind: "quota", retryAfterMs: 90 * 60_000 }, { apiKey: "B" });

		const accounts = accountsCommand(auth);
		const list = captureIO();
		await accounts.run("", invocation(list.io));
		expect(list.printed[0]!.text).toBe(
			[
				"anthropic  2 accounts, rotates on rate/usage limits",
				"  * #1  a@x.com (Personal)  active",
				"    #2  b@x.com  usage limit for 1h30m",
				"openai",
				"  * #1  sk-a…3456  active",
			].join("\n"),
		);

		const rows = await accounts.arguments!(BACKGROUND_CONTEXT, { channel: "tui", threadKey: "t" });
		expect(rows.map((row) => row.value)).toEqual(["use anthropic 1", "use anthropic 2"]);
		expect(rows[0]).toMatchObject({ label: "a@x.com (Personal)", group: "anthropic", current: true });

		const use = captureIO();
		await accounts.run("use anthropic b@x.com", invocation(use.io));
		expect(use.printed).toEqual([{ text: "anthropic: now using b@x.com (#2)", level: "success" }]);
		expect(((await auth.credentials.read("anthropic")) as OAuthCredential).access).toBe("B");

		const picked = captureIO(["use anthropic 1"]);
		await accounts.run("use", invocation(picked.io));
		expect(picked.printed[0]!.text).toBe("anthropic: now using a@x.com (Personal) (#1)");

		await expect(accounts.run("use anthropic 9", invocation(captureIO().io))).rejects.toThrow('no account "9"');

		const logout = logoutCommand(auth);
		const removeOne = captureIO(["2"]);
		await logout.run("anthropic", invocation(removeOne.io));
		expect(removeOne.printed).toEqual([{ text: "removed anthropic account 2", level: "success" }]);
		expect((await auth.accounts()).find((pool) => pool.key === "anthropic")!.accounts.map((account) => account.id)).toEqual(["1"]);

		// Non-interactive logout without an account keeps the old meaning: everything for the provider.
		const all = captureIO([], false);
		await logout.run("openai", invocation(all.io));
		expect(all.printed).toEqual([{ text: "logged out of openai", level: "success" }]);
		expect((await auth.status()).map((entry) => entry.key)).toEqual(["anthropic"]);
	});

	test("login of a second account through the auth service adds to the pool", async () => {
		const auth = openAuth(await dataDir());
		const interaction = (key: string) => ({ notify: () => {}, prompt: async () => key });
		expect((await auth.login("opencode-zen", interaction("sk-zen-1"))).account).toEqual({ id: "1", added: true, total: 1 });
		expect((await auth.login("opencode-zen", interaction("sk-zen-2"))).account).toEqual({ id: "2", added: true, total: 2 });
		expect((await auth.login("opencode-zen", interaction("sk-zen-1"))).account).toEqual({ id: "1", added: false, total: 2 });
		expect(await auth.logout("opencode-zen", "2")).toBe(true);
		expect(await auth.credentials.read("opencode")).toEqual({ type: "api_key", key: "sk-zen-1" });
	});
});
