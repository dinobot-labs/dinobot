import { describe, expect, test } from "bun:test";
import type { Credential, Usage } from "@earendil-works/pi-ai";
import type { UsageState } from "@earendil-works/pi-durable";
import type { UsageCredential, UsageReport } from "@oh-my-pi/pi-ai/usage";
import {
	aggregateUsage,
	type ConversationUsage,
	createLimitsReader,
	createUsageService,
	ohMyPiUsageFetcher,
	toAccountReport,
	type UsageFetcher,
	usageCredential,
} from "../src/api/usage.ts";
import type { CredentialPool } from "../src/auth/pool.ts";

function usage(totalTokens: number, cost: number, extra: Partial<Usage> = {}): Usage {
	return {
		input: totalTokens / 2, output: totalTokens / 2, cacheRead: 0, cacheWrite: 0, totalTokens,
		cost: { input: cost / 2, output: cost / 2, cacheRead: 0, cacheWrite: 0, total: cost },
		...extra,
	};
}

const doc = (models: Record<string, Usage>, tools: Record<string, Usage> = {}): UsageState => ({ models, tools }) as UsageState;

describe("aggregateUsage", () => {
	test("sums every ledger, attributes subagents to their thread and ranks threads by cost", () => {
		const conversations: ConversationUsage[] = [
			{ id: 1, usage: doc({ "anthropic/opus": usage(100, 1, { reasoning: 10 }) }) },
			// subagent of 1, and its own subagent: both count toward tui:main
			{ id: 2, owner: 1, usage: doc({ "openai-codex/gpt": usage(50, 0.5) }, { codemode: usage(10, 0.1) }) },
			{ id: 3, owner: 2, usage: doc({ "anthropic/opus": usage(20, 0.2, { reasoning: 5 }) }) },
			{ id: 4, usage: doc({ "anthropic/opus": usage(1000, 0.05) }) },
			// owned by nothing bound to a thread: in the totals, not in any thread
			{ id: 5, usage: doc({ "faux/x": usage(7, 0) }) },
			// no ledger yet
			{ id: 6 },
			// a tool literally named __proto__ stays data
			{ id: 7, usage: doc({}, { ["__proto__"]: usage(2, 0) } as Record<string, Usage>) },
		];
		const summary = aggregateUsage(conversations, { "tui:main": 1, "slack:C1-1": 4, "tui:empty": 6 }, (ids) => new Map(ids.map((id) => [id, { at: id * 1000 }])));
		expect(summary.conversations).toBe(7);
		expect(summary.models["anthropic/opus"]).toMatchObject({ totalTokens: 1120, reasoning: 15 });
		expect(summary.models["anthropic/opus"]!.cost.total).toBeCloseTo(1.25);
		expect(summary.models["openai-codex/gpt"]!.totalTokens).toBe(50);
		expect(summary.models["faux/x"]!.totalTokens).toBe(7);
		expect(summary.tools.codemode!.totalTokens).toBe(10);
		expect(Object.hasOwn(summary.tools, "__proto__")).toBe(true);
		expect(summary.threads.map((t) => t.thread)).toEqual(["tui:main", "slack:C1-1"]);
		expect(summary.threads[0]).toMatchObject({ conversationId: 1, totalTokens: 180, lastActivityAt: 1000 });
		expect(summary.threads[0]!.cost).toBeCloseTo(1.8);
		expect(summary.threads[1]).toMatchObject({ conversationId: 4, totalTokens: 1000, lastActivityAt: 4000 });
	});

	test("keeps only the top 20 threads and survives owner cycles", () => {
		const conversations: ConversationUsage[] = Array.from({ length: 25 }, (_, i) => ({ id: i + 1, usage: doc({ m: usage(10, i + 1) }) }));
		conversations.push({ id: 100, owner: 101, usage: doc({ m: usage(1, 1) }) }, { id: 101, owner: 100 });
		const threads = Object.fromEntries(conversations.slice(0, 25).map((c) => [`t:${c.id}`, c.id]));
		const summary = aggregateUsage(conversations, threads);
		expect(summary.threads).toHaveLength(20);
		expect(summary.threads[0]).toEqual({ thread: "t:25", conversationId: 25, totalTokens: 10, cost: 25 });
		expect(summary.threads.at(-1)!.thread).toBe("t:6");
		expect(summary.models.m!.totalTokens).toBe(251);
	});
});

describe("createUsageService summary cache", () => {
	test("caches the summary for 30 s and shares one computation between concurrent reads", async () => {
		let clock = 1_000_000;
		let calls = 0;
		const service = createUsageService({
			harness: undefined as never,
			context: undefined as never,
			now: () => clock,
			source: async () => {
				calls++;
				await Bun.sleep(5);
				return { conversations: [{ id: 1, usage: doc({ m: usage(calls, calls) }) }], threads: { "tui:main": 1 } };
			},
		});
		const [a, b] = await Promise.all([service.read({ refresh: false }), service.read({ refresh: false })]);
		expect(calls).toBe(1);
		expect(a.summary).toEqual(b.summary);
		expect(a.limits).toEqual({ providers: [] });
		clock += 29_999;
		expect((await service.read({ refresh: true })).summary.models.m!.totalTokens).toBe(1);
		clock += 1;
		expect((await service.read({ refresh: false })).summary.models.m!.totalTokens).toBe(2);
		expect(calls).toBe(2);
	});

	test("does not cache a failed computation", async () => {
		let fail = true;
		const service = createUsageService({
			harness: undefined as never,
			context: undefined as never,
			source: async () => {
				if (fail) throw new Error("store closed");
				return { conversations: [], threads: {} };
			},
		});
		await expect(service.read({ refresh: false })).rejects.toThrow("store closed");
		fail = false;
		expect((await service.read({ refresh: false })).summary.conversations).toBe(0);
	});
});

const NOW = 1_800_000_000_000;
const SECRETS = ["anthropic-access-SECRET-1", "anthropic-refresh-SECRET-1", "codex-access-SECRET-1", "codex-access-SECRET-2", "codex-refresh-SECRET", "sk-apikey-SECRET-xyz", "expired-access-SECRET", "xai-access-SECRET"];

const oauth = (access: string, refresh: string, expires: number, extra: Record<string, unknown> = {}): Credential =>
	({ type: "oauth", access, refresh, expires, ...extra }) as Credential;

function pools(): Map<string, CredentialPool> {
	return new Map<string, CredentialPool>([
		["anthropic", { active: "1", lastId: 1, accounts: [{ id: "1", addedAt: 0, credential: oauth("anthropic-access-SECRET-1", "anthropic-refresh-SECRET-1", NOW + 3_600_000, { loginProvider: "anthropic", email: "me@example.com", orgName: "Acme" }) }] }],
		["openai-codex", {
			active: "1", lastId: 2, accounts: [
				{ id: "1", addedAt: 0, credential: oauth("codex-access-SECRET-1", "codex-refresh-SECRET", NOW + 3_600_000, { loginProvider: "openai-codex", accountId: "acct-1" }), blockedUntil: NOW + 600_000, lastFailure: "quota" },
				{ id: "2", addedAt: 0, credential: oauth("codex-access-SECRET-2", "codex-refresh-SECRET", NOW + 3_600_000, { loginProvider: "openai-codex", email: "two@example.com" }) },
			],
		}],
		["deepseek", { active: "1", lastId: 1, accounts: [{ id: "1", addedAt: 0, credential: { type: "api_key", key: "sk-apikey-SECRET-xyz" } }] }],
		["xai", { active: "1", lastId: 1, accounts: [{ id: "1", addedAt: 0, credential: oauth("expired-access-SECRET", "x", NOW - 1, { loginProvider: "xai-oauth" }) }] }],
		["no-fetcher", { active: "1", lastId: 1, accounts: [{ id: "1", addedAt: 0, credential: oauth("xai-access-SECRET", "y", NOW + 1000, { loginProvider: "unknown-login" }) }] }],
	]);
}

function report(provider: string, used: number): UsageReport {
	return {
		provider: provider as never,
		fetchedAt: NOW,
		limits: [
			{ id: `${provider}:5h`, label: "5 Hour", scope: { provider: provider as never, accountId: "acct-1" }, window: { id: "5h", label: "5 Hour", durationMs: 18_000_000, resetsAt: NOW + 3_600_000 }, amount: { used, unit: "percent" }, status: "ok" },
			{ id: `${provider}:7d`, label: "7 Day", scope: { provider: provider as never }, window: { id: "7d", label: "7 Day" }, amount: { remainingFraction: 0.25, unit: "percent" }, status: "warning" },
		],
		notes: ["estimate"],
		metadata: { email: "me@example.com", accountId: "acct-1" },
		raw: { token: "should-not-leak" },
	};
}

type Call = { provider: string; credential: UsageCredential };

function fakeFetcher(calls: Call[], behavior: (call: Call) => Promise<{ report: UsageReport | null; warning?: string }>): UsageFetcher {
	return {
		async provider(candidates) { return candidates.find((id) => ["anthropic", "openai-codex", "xai-oauth"].includes(id)); },
		async fetch(provider, credential) {
			const call = { provider, credential };
			calls.push(call);
			return behavior(call);
		},
	};
}

describe("createLimitsReader", () => {
	test("maps pools, fetches OAuth accounts with a fetcher, skips expired tokens and never leaks secrets", async () => {
		const calls: Call[] = [];
		const read = createLimitsReader({
			credentials: { pools: async () => pools() },
			providerName: (key) => ({ anthropic: "Anthropic", "openai-codex": "OpenAI Codex" })[key],
			now: () => NOW,
			fetcher: fakeFetcher(calls, async ({ provider, credential }) => {
				if (credential.accessToken === "codex-access-SECRET-1") return { report: null, warning: `Codex usage request failed (HTTP 401) Bearer ${credential.accessToken}` };
				if (credential.accessToken === "codex-access-SECRET-2") throw new Error(`socket closed for ${credential.accessToken}`);
				return { report: report(provider, 42) };
			}),
		});
		const { providers } = await read(false);
		expect(calls.map((c) => c.provider).sort()).toEqual(["anthropic", "openai-codex", "openai-codex"]);
		for (const call of calls) {
			expect(call.credential.refreshToken).toBeUndefined();
			expect(call.credential.type).toBe("oauth");
		}
		const byKey = Object.fromEntries(providers.map((p) => [p.key, p]));
		expect(byKey.anthropic!.name).toBe("Anthropic");
		expect(byKey.anthropic!.accounts).toEqual([{
			id: "1", type: "oauth", label: "me@example.com (Acme)", active: true,
			report: {
				fetchedAt: NOW, source: "fetch", notes: ["estimate"],
				limits: [
					{ id: "anthropic:5h", label: "5 Hour", windowId: "5h", windowLabel: "5 Hour", durationMs: 18_000_000, resetsAt: NOW + 3_600_000, usedFraction: 0.42, status: "ok" },
					{ id: "anthropic:7d", label: "7 Day", windowId: "7d", windowLabel: "7 Day", usedFraction: 0.75, status: "warning" },
				],
			},
		}]);
		const codex = byKey["openai-codex"]!.accounts;
		expect(codex[0]).toMatchObject({ id: "1", label: "acct-1", active: false, blockedUntil: NOW + 600_000, lastFailure: "quota", error: "Codex usage request failed (HTTP 401) Bearer [redacted]" });
		expect(codex[1]).toMatchObject({ id: "2", label: "two@example.com", active: true, error: "Error: socket closed for [redacted]" });
		expect(byKey.deepseek).toEqual({ key: "deepseek", name: "deepseek", accounts: [{ id: "1", type: "api_key", label: "sk-a…-xyz", active: true }] });
		expect(byKey.xai!.accounts).toEqual([{ id: "1", type: "oauth", active: true, stale: true }]);
		expect(byKey["no-fetcher"]!.accounts).toEqual([{ id: "1", type: "oauth", active: true }]);
		const json = JSON.stringify(providers);
		for (const secret of SECRETS) expect(json).not.toContain(secret);
		expect(json).not.toContain("should-not-leak");
	});

	test("caches 60 s per account, refresh lowers that to 10 s, and concurrent reads share one fetch", async () => {
		let clock = NOW;
		const calls: Call[] = [];
		const single = new Map([["anthropic", pools().get("anthropic")!]]);
		const read = createLimitsReader({
			credentials: { pools: async () => single },
			now: () => clock,
			fetcher: fakeFetcher(calls, async ({ provider }) => {
				await Bun.sleep(5);
				return { report: report(provider, calls.length) };
			}),
		});
		await Promise.all([read(false), read(false), read(true)]);
		expect(calls).toHaveLength(1);
		clock += 9_999;
		await read(true);
		expect(calls).toHaveLength(1);
		clock += 1; // 10 s old: refresh fetches, a plain read would not
		await read(false);
		expect(calls).toHaveLength(1);
		const refreshed = await read(true);
		expect(calls).toHaveLength(2);
		expect(refreshed.providers[0]!.accounts[0]!.report!.limits[0]!.usedFraction).toBe(0.02);
		clock += 59_999;
		await read(false);
		expect(calls).toHaveLength(2);
		clock += 1;
		await read(false);
		expect(calls).toHaveLength(3);
	});

	test("an expired token keeps the last report, marked stale, without fetching", async () => {
		let clock = NOW;
		const calls: Call[] = [];
		const single = new Map([["anthropic", pools().get("anthropic")!]]);
		const read = createLimitsReader({ credentials: { pools: async () => single }, now: () => clock, fetcher: fakeFetcher(calls, async ({ provider }) => ({ report: report(provider, 10) })) });
		await read(false);
		clock = NOW + 3_600_000; // the token's expiry
		const { providers } = await read(true);
		expect(calls).toHaveLength(1);
		expect(providers[0]!.accounts[0]).toMatchObject({ stale: true, report: { fetchedAt: NOW } });
	});

	test("usageCredential hands over the access token and identity but never the refresh token", () => {
		const credential = usageCredential(oauth("a-SECRET", "r-SECRET", 5, { email: "e@x", accountId: "acc", orgId: "", projectId: 7 }) as Credential & { type: "oauth" });
		expect(credential).toEqual({ type: "oauth", accessToken: "a-SECRET", expiresAt: 5, email: "e@x", accountId: "acc" });
	});

	test("toAccountReport drops metadata and raw", () => {
		const mapped = toAccountReport(report("anthropic", 50));
		expect(Object.keys(mapped).sort()).toEqual(["fetchedAt", "limits", "notes", "source"]);
		expect(mapped.limits[0]!.usedFraction).toBe(0.5);
	});
});

describe("ohMyPiUsageFetcher (fake HTTP, no network)", () => {
	test("parses a Codex usage payload into windows", async () => {
		const urls: string[] = [];
		const fakeFetch = (async (input: string | URL | Request) => {
			const url = String(input instanceof Request ? input.url : input);
			urls.push(url);
			if (url.includes("wham/usage")) {
				return Response.json({
					plan_type: "pro",
					rate_limit: {
						allowed: true, limit_reached: false,
						primary_window: { used_percent: 55, limit_window_seconds: 18_000, reset_after_seconds: 3600, reset_at: Math.floor(NOW / 1000) + 3600 },
						secondary_window: { used_percent: 30, limit_window_seconds: 604_800, reset_after_seconds: 86_400, reset_at: Math.floor(NOW / 1000) + 86_400 },
					},
				});
			}
			return new Response("not found", { status: 404 });
		}) as typeof fetch;
		const fetcher = ohMyPiUsageFetcher(fakeFetch);
		expect(await fetcher.provider(["zai-coding-plan", "zai"])).toBe("zai");
		expect(await fetcher.provider(["openai-codex"])).toBe("openai-codex");
		expect(await fetcher.provider(["nope"])).toBeUndefined();
		const { report: result } = await fetcher.fetch("openai-codex", { type: "oauth", accessToken: "codex-token", expiresAt: Date.now() + 60_000 }, AbortSignal.timeout(5000));
		expect(urls.some((url) => url.includes("chatgpt.com") && url.includes("wham/usage"))).toBe(true);
		const mapped = toAccountReport(result!);
		expect(mapped.limits.slice(0, 2)).toEqual([
			expect.objectContaining({ id: "openai-codex:primary", windowId: "5h", durationMs: 18_000_000, resetsAt: (Math.floor(NOW / 1000) + 3600) * 1000, usedFraction: 0.55 }),
			expect.objectContaining({ id: "openai-codex:secondary", windowId: "7d", durationMs: 604_800_000, usedFraction: 0.3 }),
		]);
	});

	test("a refused Claude token becomes a status-only warning", async () => {
		const fakeFetch = (async () => new Response("{\"error\":\"invalid bearer claude-token\"}", { status: 401, statusText: "Unauthorized" })) as unknown as typeof fetch;
		const fetcher = ohMyPiUsageFetcher(fakeFetch);
		const outcome = await fetcher.fetch("anthropic", { type: "oauth", accessToken: "claude-token" }, AbortSignal.timeout(5000));
		expect(outcome).toEqual({ report: null, warning: "Claude usage fetch failed (HTTP 401)" });
	});
});
