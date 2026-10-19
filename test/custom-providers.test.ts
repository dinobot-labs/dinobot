import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthEvent, AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import { channelCatalog } from "../src/channels/index.ts";
import { createBotModels, openAuth } from "../src/auth/index.ts";
import { loginCommand } from "../src/commands/builtin.ts";
import type { CustomProviderConfig } from "../src/auth/custom-providers.ts";
import { ManifestError, parseManifest } from "../src/manifest.ts";

const ARGON = "opencodex/google-antigravity/gemini-4-argon";
const axwith: CustomProviderConfig = {
	id: "axwith",
	name: "AXwith Router",
	baseUrl: "https://router.example.test/api/v1/",
	headers: { "X-Team": "dino" },
	models: [{ id: ARGON, name: "Gemini 4 Argon", contextWindow: 1_000_000, maxTokens: 65_536, input: ["text", "image"] }, { id: "small" }],
};

let dir: string | undefined;
afterEach(async () => {
	if (dir) await rm(dir, { recursive: true, force: true });
	dir = undefined;
	delete process.env.AXWITH_API_KEY;
	delete process.env.ROUTER_KEY;
});
async function dataDir() {
	dir = await mkdtemp(join(tmpdir(), "dinobot-custom-"));
	return join(dir, "data");
}

function rawManifest(providers: unknown) {
	return {
		bot: { enabled: true, dataDir: ".data", model: { provider: "axwith", modelId: ARGON }, toolMode: "codemode-only" },
		api: { port: 8786 },
		channels: {},
		plugins: {},
		providers,
	};
}
async function problems(providers: unknown): Promise<readonly string[]> {
	try {
		await parseManifest(rawManifest(providers), { channels: channelCatalog, plugins: {} });
	} catch (error) {
		if (error instanceof ManifestError) return error.problems;
		throw error;
	}
	throw new Error("expected the manifest to be rejected");
}

function fakeInteraction(answer: string) {
	const events: AuthEvent[] = [];
	const prompts: AuthPrompt[] = [];
	const interaction: AuthInteraction = {
		notify: (event) => events.push(event),
		prompt: async (prompt) => {
			prompts.push(prompt);
			return answer;
		},
	};
	return { interaction, events, prompts };
}

function fakeFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
	const calls: { url: string; init: RequestInit; headers: Headers }[] = [];
	const original = globalThis.fetch;
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const request = input instanceof Request ? input : undefined;
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const headers = new Headers(init?.headers ?? request?.headers);
		const body = init?.body ?? (request ? await request.text() : undefined);
		const recorded = { ...(init ?? {}), ...(body === undefined ? {} : { body }) };
		calls.push({ url, init: recorded, headers });
		return respond(url, recorded);
	}) as typeof fetch;
	return { calls, restore: () => { globalThis.fetch = original; } };
}

function sse(chunks: readonly unknown[]): Response {
	const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("manifest providers", () => {
	test("parses custom providers in order with their id", async () => {
		const manifest = await parseManifest(rawManifest({ axwith: { baseUrl: "https://router.example.test/api/v1", models: [{ id: ARGON }] } }), { channels: channelCatalog, plugins: {} });
		expect(manifest.providers).toEqual([{ id: "axwith", baseUrl: "https://router.example.test/api/v1", models: [{ id: ARGON }] }]);
		const none = await parseManifest({ ...rawManifest(undefined), providers: undefined }, { channels: channelCatalog, plugins: {} });
		expect(none.providers).toEqual([]);
	});

	test("rejects builtin ids, duplicate models, slashes, empty model lists and inline keys", async () => {
		expect(await problems({ openai: { baseUrl: "https://x.test/v1", models: [{ id: "m" }] } })).toContain('providers.openai: "openai" is a builtin provider; choose another id');
		expect(await problems({ axwith: { baseUrl: "https://x.test/v1", models: [{ id: "m" }, { id: "m" }] } })).toContain('providers.axwith.models: duplicate id "m"');
		expect(await problems({ "ax/with": { baseUrl: "https://x.test/v1", models: [{ id: "m" }] } })).toContain('providers.ax/with: id must be lowercase letters, digits, ".", "_" or "-" (no "/")');
		expect(await problems({ axwith: { baseUrl: "https://x.test/v1", models: [] } })).toContain("/providers/axwith/models: must not have fewer than 1 items");
		expect(await problems({ axwith: { baseUrl: "ftp://x.test", models: [{ id: "m" }] } })).toContain('/providers/axwith/baseUrl: must match pattern "^https?://"');
		// Secrets never go in dinobot.yaml: an inline key is a validation error, not silently ignored.
		expect(await problems({ axwith: { baseUrl: "https://x.test/v1", apiKey: "sk-secret", models: [{ id: "m" }] } })).toContain("/providers/axwith: must not have additional properties");
	});
});

describe("custom provider models", () => {
	test("registers every configured model with the trimmed base URL and defaults", async () => {
		const models = createBotModels(openAuth(await dataDir()), undefined, { customProviders: [axwith] });
		expect(models.getModel("axwith", ARGON)).toMatchObject({
			id: ARGON, name: "Gemini 4 Argon", api: "openai-completions", provider: "axwith",
			baseUrl: "https://router.example.test/api/v1", contextWindow: 1_000_000, maxTokens: 65_536, input: ["text", "image"], reasoning: false,
		});
		expect(models.getModel("axwith", "small")).toMatchObject({ name: "small", contextWindow: 128_000, maxTokens: 16_384, input: ["text"] });
		expect(models.getProvider("anthropic")).toBeDefined();
	});

	test("the key comes from the default environment variable, a custom one, or a stored login, which wins", async () => {
		const auth = openAuth(await dataDir(), { customProviders: [axwith] });
		const models = createBotModels(auth, undefined, { customProviders: [axwith] });
		expect(await models.getAuth("axwith")).toBeUndefined();
		expect((await models.getAvailable("axwith")).length).toBe(0);

		process.env.AXWITH_API_KEY = "sk-env";
		expect((await models.getAuth("axwith"))?.auth.apiKey).toBe("sk-env");
		expect((await models.getAvailable("axwith")).map((model) => model.id)).toEqual([ARGON, "small"]);

		await auth.credentials.addAccount("axwith", { type: "api_key", key: "sk-stored" });
		expect((await models.getAuth("axwith"))?.auth.apiKey).toBe("sk-stored");

		const renamed = { ...axwith, id: "router", apiKeyEnv: "ROUTER_KEY" };
		process.env.ROUTER_KEY = "sk-router";
		const other = createBotModels(openAuth(await dataDir()), undefined, { customProviders: [renamed] });
		expect((await other.getAuth("router"))?.auth.apiKey).toBe("sk-router");
	});

	test("chat requests go to <baseUrl>/chat/completions with the key, configured headers and tool calls parsed", async () => {
		process.env.AXWITH_API_KEY = "sk-env";
		const models = createBotModels(openAuth(await dataDir()), undefined, { customProviders: [axwith] });
		const http = fakeFetch(() => sse([
			{ id: "c1", object: "chat.completion.chunk", created: 1, model: ARGON, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_time", arguments: "{\"tz\":\"Asia/Seoul\"}" } }] }, finish_reason: null }] },
			{ id: "c1", object: "chat.completion.chunk", created: 1, model: ARGON, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } },
		]));
		let message;
		try {
			message = await models.completeSimple(models.getModel("axwith", ARGON)!, {
				messages: [{ role: "user", content: "what time is it?", timestamp: 1 }],
				tools: [{ name: "get_time", description: "current time", parameters: { type: "object", properties: { tz: { type: "string" } } } as never }],
			});
		} finally {
			http.restore();
		}
		expect(http.calls).toHaveLength(1);
		expect(http.calls[0]!.url).toBe("https://router.example.test/api/v1/chat/completions");
		expect(http.calls[0]!.headers.get("authorization")).toBe("Bearer sk-env");
		expect(http.calls[0]!.headers.get("x-team")).toBe("dino");
		expect(JSON.parse(String(http.calls[0]!.init.body))).toMatchObject({ model: ARGON, stream: true });
		expect(message.stopReason).toBe("toolUse");
		expect(message.content).toContainEqual(expect.objectContaining({ type: "toolCall", name: "get_time", arguments: { tz: "Asia/Seoul" } }));
	});
});

describe("custom provider login", () => {
	test("is listed as a chat provider and validates the key against the first model before storing it", async () => {
		const auth = openAuth(await dataDir(), { customProviders: [axwith] });
		expect((await auth.providers())[0]).toEqual({ id: "axwith", name: "AXwith Router", storeAs: "axwith", modelProvider: "axwith" });
		const rows = await loginCommand(auth).arguments!({} as never, {} as never);
		expect(rows.find((row) => row.value === "axwith")).toMatchObject({ label: "AXwith Router", group: "Chat providers" });

		const probe = fakeFetch(() => new Response("{}", { status: 200 }));
		const fake = fakeInteraction("  sk-ir-test  ");
		try {
			expect(await auth.login("axwith", fake.interaction)).toMatchObject({ type: "api_key", provider: { id: "axwith", modelProvider: "axwith" } });
		} finally {
			probe.restore();
		}
		expect(fake.prompts.map((prompt) => prompt.type)).toEqual(["secret"]);
		expect(probe.calls).toHaveLength(1);
		expect(probe.calls[0]!.url).toBe("https://router.example.test/api/v1/chat/completions");
		expect(JSON.parse(String(probe.calls[0]!.init.body))).toMatchObject({ model: ARGON, max_tokens: 1 });
		expect(await auth.credentials.read("axwith")).toEqual({ type: "api_key", key: "sk-ir-test" });
		const models = createBotModels(auth, undefined, { customProviders: [axwith] });
		expect((await models.getAuth("axwith"))?.auth.apiKey).toBe("sk-ir-test");
		expect(await auth.logout("axwith")).toBe(true);
		expect(await auth.status()).toEqual([]);
	});

	test("a rejected key is not stored and never echoed", async () => {
		const auth = openAuth(await dataDir(), { customProviders: [axwith] });
		const probe = fakeFetch(() => new Response(JSON.stringify({ error: { message: "bad key sk-ir-secret" } }), { status: 401 }));
		let message = "";
		try {
			await auth.login("axwith", fakeInteraction("sk-ir-secret").interaction);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		} finally {
			probe.restore();
		}
		expect(message).toContain("AXwith Router API key validation failed (401)");
		expect(message).not.toContain("sk-ir-secret");
		expect(await auth.status()).toEqual([]);
	});
});
