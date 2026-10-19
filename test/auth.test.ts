import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthEvent, AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import { createBotModels, openAuth, openCredentialFile } from "../src/auth/index.ts";
import { loginCommand } from "../src/commands/builtin.ts";

let dir: string;
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function dataDir() {
	dir = await mkdtemp(join(tmpdir(), "dinobot-auth-"));
	return join(dir, "data");
}

function fakeInteraction(answer: string) {
	const events: AuthEvent[] = [];
	const prompts: AuthPrompt[] = [];
	const interaction: AuthInteraction = {
		notify: event => events.push(event),
		prompt: async prompt => {
			prompts.push(prompt);
			return answer;
		},
	};
	return { interaction, events, prompts };
}

/** Records the requests a login makes so a test can assert on them without leaving the machine. */
function fakeFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
	const calls: { url: string; init: RequestInit }[] = [];
	const original = globalThis.fetch;
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const request = init ?? {};
		calls.push({ url, init: request });
		return respond(url, request);
	}) as typeof fetch;
	return {
		calls,
		restore: () => {
			globalThis.fetch = original;
		},
	};
}

test("perplexity login offers browser SSO and email, as in oh-my-pi's own TUI", async () => {
	process.env.PI_AUTH_NO_BORROW = "1";
	const prompts: AuthPrompt[] = [];
	const interaction: AuthInteraction = {
		notify: () => {},
		prompt: async prompt => {
			prompts.push(prompt);
			throw new Error("stop before the network");
		},
	};
	try {
		await expect(openAuth(await dataDir()).login("perplexity", interaction)).rejects.toThrow("stop before the network");
	} finally {
		delete process.env.PI_AUTH_NO_BORROW;
	}
	expect(prompts[0]?.message).toMatch(/sso/i);
	expect(prompts[0]?.message).toMatch(/email/i);
});

describe("credential file", () => {
	test("persists to auth.json with mode 0600 and survives reopening", async () => {
		const data = await dataDir();
		const store = openCredentialFile(data);
		await store.modify("openai", async () => ({ type: "api_key", key: "sk-1" }));
		await store.modify("xai", async () => ({ type: "oauth", access: "a", refresh: "r", expires: 1 }));
		expect((await stat(join(data, "auth.json"))).mode & 0o777).toBe(0o600);
		expect(JSON.parse(await readFile(join(data, "auth.json"), "utf8")).openai).toEqual({ type: "api_key", key: "sk-1" });

		const reopened = openCredentialFile(data);
		expect(await reopened.read("openai")).toEqual({ type: "api_key", key: "sk-1" });
		expect(await reopened.list()).toEqual([
			{ providerId: "openai", type: "api_key" },
			{ providerId: "xai", type: "oauth" },
		]);
	});

	test("delete removes only that key; modify returning undefined keeps the entry", async () => {
		const data = await dataDir();
		const store = openCredentialFile(data);
		await store.modify("a", async () => ({ type: "api_key", key: "1" }));
		await store.modify("b", async () => ({ type: "api_key", key: "2" }));
		expect(await store.modify("a", async () => undefined)).toEqual({ type: "api_key", key: "1" });
		await store.delete("a");
		expect(await openCredentialFile(data).read("a")).toBeUndefined();
		expect(await openCredentialFile(data).read("b")).toEqual({ type: "api_key", key: "2" });
	});

	test("serializes concurrent modifies of one key", async () => {
		const store = openCredentialFile(await dataDir());
		await Promise.all(
			Array.from({ length: 10 }, () =>
				store.modify("n", async current => ({ type: "api_key", key: String(Number(current?.type === "api_key" ? current.key : 0) + 1) })),
			),
		);
		expect(await store.read("n")).toEqual({ type: "api_key", key: "10" });
	});
});

describe("auth service", () => {
	test("lists oh-my-pi login providers mapped to pi-ai providers", async () => {
		const providers = await openAuth(await dataDir()).providers();
		const byId = new Map(providers.map(provider => [provider.id, provider]));
		expect(providers.length).toBeGreaterThan(50);
		expect(byId.get("zai-coding-plan")).toMatchObject({ storeAs: "zai", modelProvider: "zai" });
		expect(byId.get("openai-codex-device")).toMatchObject({ storeAs: "openai-codex", modelProvider: "openai-codex" });
		expect(byId.get("kimi-code")).toMatchObject({ storeAs: "kimi-code", modelProvider: "kimi-coding" });
		expect(byId.get("anthropic")).toMatchObject({ storeAs: "anthropic", modelProvider: "anthropic" });
		expect(byId.get("ollama")?.modelProvider).toBeUndefined();
	});

	test("api-key login prompts through the interaction and stores under the pi-ai provider", async () => {
		const auth = openAuth(await dataDir());
		const { interaction, prompts, events } = fakeInteraction("sk-zen");
		const result = await auth.login("opencode-zen", interaction);
		expect(result).toEqual({ provider: expect.objectContaining({ id: "opencode-zen", modelProvider: "opencode" }), type: "api_key", account: { id: "1", added: true, total: 1 } });
		expect(prompts.map(prompt => prompt.type)).toEqual(["secret"]);
		expect(events).toContainEqual(expect.objectContaining({ type: "auth_url", url: "https://opencode.ai/auth" }));
		expect(await auth.credentials.read("opencode")).toEqual({ type: "api_key", key: "sk-zen" });
		expect(await auth.status()).toEqual([{ key: "opencode", type: "api_key" }]);
		expect((await createBotModels(auth).getAuth("opencode"))?.auth.apiKey).toBe("sk-zen");

		expect(await auth.logout("opencode-zen")).toBe(true);
		expect(await auth.logout("opencode")).toBe(false);
		expect(await auth.status()).toEqual([]);
	});

	test("unknown provider id rejects", async () => {
		const { interaction } = fakeInteraction("x");
		await expect(openAuth(await dataDir()).login("no-such-provider", interaction)).rejects.toThrow("unknown login provider");
	});

	test("alibaba-token-plan is listed as Alibaba Token Plan and stored where the qwen-token-plan transport reads it", async () => {
		const auth = openAuth(await dataDir());
		const provider = (await auth.providers()).find(entry => entry.id === "alibaba-token-plan");
		expect(provider).toMatchObject({ name: "Alibaba Token Plan", storeAs: "alibaba-token-plan", modelProvider: "qwen-token-plan" });
		// The /login picker row is what the user searches, so the advertised name and its group are asserted there.
		const rows = await loginCommand(auth).arguments!({} as never, {} as never);
		expect(rows.find(row => row.value === "alibaba-token-plan")).toMatchObject({ label: "Alibaba Token Plan", group: "Chat providers" });
	});

	test("alibaba-token-plan login probes the Token Plan endpoint and stores the bare key", async () => {
		const auth = openAuth(await dataDir());
		const probe = fakeFetch(() => new Response("{}", { status: 200 }));
		const fake = fakeInteraction("  sk-sp-test  ");
		let result: unknown;
		try {
			result = await auth.login("alibaba-token-plan", fake.interaction);
		} finally {
			probe.restore();
		}

		expect(result).toMatchObject({ type: "api_key", provider: { name: "Alibaba Token Plan", modelProvider: "qwen-token-plan" } });
		expect(fake.prompts.map(prompt => prompt.type)).toEqual(["secret"]);
		expect(fake.prompts[0]).toMatchObject({ message: "Paste your Alibaba Token Plan API key", placeholder: "sk-..." });
		expect(fake.events).toContainEqual(expect.objectContaining({ type: "auth_url", url: "https://modelstudio.console.alibabacloud.com/" }));
		expect(fake.events).toContainEqual(expect.objectContaining({ type: "progress", message: "Validating API key..." }));

		expect(probe.calls).toHaveLength(1);
		expect(probe.calls[0]?.url).toBe("https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions");
		expect(JSON.parse(String(probe.calls[0]?.init.body))).toMatchObject({ model: "deepseek-v4-pro", max_tokens: 1, temperature: 0 });
		expect(probe.calls[0]?.init.headers).toMatchObject({ Authorization: "Bearer sk-sp-test" });

		// The key is stored trimmed, under the pi-ai provider that serves requests.
		expect(await auth.credentials.read("qwen-token-plan")).toEqual({ type: "api_key", key: "sk-sp-test" });
		expect(await auth.status()).toEqual([{ key: "qwen-token-plan", type: "api_key" }]);
		const models = createBotModels(auth);
		expect((await models.getAuth("qwen-token-plan"))?.auth.apiKey).toBe("sk-sp-test");
		const served = (await models.getAvailable()).filter(model => model.provider === "qwen-token-plan").map(model => model.id);
		expect(served).toContain("deepseek-v4-pro");
		expect(served).toContain("glm-5.2");
		expect(served).toContain("qwen3.8-max");

		expect(await auth.logout("alibaba-token-plan")).toBe(true);
		expect(await auth.status()).toEqual([]);
	});

	test("an API key the Token Plan rejects is not stored, and the failure never echoes the key", async () => {
		const auth = openAuth(await dataDir());
		const probe = fakeFetch(() => new Response(JSON.stringify({ error: { message: "Incorrect API key provided: sk-sp-secret" } }), { status: 401 }));
		const fake = fakeInteraction("sk-sp-secret");
		let message = "";
		try {
			await auth.login("alibaba-token-plan", fake.interaction);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		} finally {
			probe.restore();
		}
		expect(message).toContain("Alibaba Token Plan API key validation failed (401)");
		expect(message).not.toContain("sk-sp-secret");
		expect(message).toContain("[REDACTED]");
		expect(await auth.status()).toEqual([]);
	});

	test("alibaba-token-plan login stores nothing when no key is pasted", async () => {
		const auth = openAuth(await dataDir());
		const probe = fakeFetch(() => new Response("{}", { status: 200 }));
		try {
			const { interaction } = fakeInteraction("   ");
			await expect(auth.login("alibaba-token-plan", interaction)).rejects.toThrow("API key is required");
		} finally {
			probe.restore();
		}
		expect(probe.calls).toHaveLength(0);
		expect(await auth.status()).toEqual([]);
	});

	test("oauth credentials of oh-my-pi logins refresh through oh-my-pi and fall back to the access token", async () => {
		const auth = openAuth(await dataDir());
		await auth.credentials.modify("deepseek", async () => ({
			type: "oauth",
			access: "tok",
			refresh: "r",
			expires: 0,
			loginProvider: "deepseek",
		}));
		expect(await createBotModels(auth).getAuth("deepseek")).toEqual({ auth: { apiKey: "tok" }, source: "OAuth" });
	});
});
