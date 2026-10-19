import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openCredentialFile } from "../src/auth/store.ts";
import { type Bot, openBot } from "../src/core/bot.ts";
import type { ToolMode } from "../src/core/toolmode.ts";
import { chatgptAccountId, imagesUrl, requestBody, sniffImage } from "../src/plugins/image_gen/codex.ts";
import { imageGenPlugin } from "../src/plugins/image_gen/index.ts";
import { pluginCatalog } from "../src/plugins/index.ts";
import { definePlugin, type LoadedPlugin, loadPlugin, PluginContent, type PluginToolCall } from "../src/plugins/types.ts";
import { Type } from "@earendil-works/pi-ai";

const context = BACKGROUND_CONTEXT;
/** A 1x1 PNG. */
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
const PNG = Buffer.from(PNG_B64, "base64");
const ACCOUNT = "acct-123";
const jwt = (claims: Record<string, unknown>) =>
	[{ alg: "none" }, claims].map((part) => Buffer.from(JSON.stringify(part)).toString("base64url")).join(".") + ".sig";
const TOKEN = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: ACCOUNT, chatgpt_plan_type: "pro" } });

type Seen = { method: string; path: string; headers: Record<string, string>; body: Record<string, unknown> };
type Reply = { status?: number; json?: unknown; text?: string; headers?: Record<string, string> };

class FakeCodex {
	readonly seen: Seen[] = [];
	next: Reply[] = [];
	private server = Bun.serve({
		port: 0,
		fetch: async (request) => {
			const url = new URL(request.url);
			this.seen.push({ method: request.method, path: url.pathname, headers: Object.fromEntries(request.headers), body: (await request.json()) as Record<string, unknown> });
			const reply = this.next.shift() ?? { json: { created: 1, background: "opaque", output_format: "png", quality: "low", size: "1024x1024", data: [{ b64_json: PNG_B64 }] } };
			return new Response(reply.text ?? JSON.stringify(reply.json), {
				status: reply.status ?? 200,
				headers: { "content-type": "application/json", "x-codex-imagegen-request-id": "req-img-1", ...reply.headers },
			});
		},
	});
	readonly baseUrl = `http://127.0.0.1:${this.server.port}/backend-api`;
	stop() {
		this.server.stop(true);
	}
}

let codex: FakeCodex;
const dirs: string[] = [];
const temp = async () => {
	const dir = await mkdtemp(join(tmpdir(), "dinobot-image-gen-"));
	dirs.push(dir);
	return dir;
};
beforeAll(() => {
	codex = new FakeCodex();
});
afterAll(() => codex.stop());
afterEach(async () => {
	codex.seen.length = 0;
	codex.next = [];
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function load(config: Record<string, unknown> = {}): Promise<LoadedPlugin> {
	const loaded = await loadPlugin(imageGenPlugin, { baseUrl: codex.baseUrl, ...config });
	if (Array.isArray(loaded)) throw new Error(loaded.join("; "));
	return loaded;
}

const loggedIn = (cwd: string, apiKey = TOKEN): PluginToolCall => ({
	cwd,
	providerLogin: async (providerId) => (providerId === "openai-codex" ? { apiKey } : undefined),
});

const textOf = (content: PluginContent) => content.blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
const savedPath = (content: PluginContent) => /Saved generated image to (.+)\n/.exec(textOf(content))![1]!;

describe("Codex images protocol helpers", () => {
	test("account id, URL, body and image sniffing", () => {
		expect(chatgptAccountId(TOKEN)).toBe(ACCOUNT);
		expect(chatgptAccountId("sk-plain-key")).toBeUndefined();
		expect(chatgptAccountId(jwt({ sub: "x" }))).toBeUndefined();
		expect(chatgptAccountId("a.%%%.b")).toBeUndefined();
		expect(imagesUrl("https://chatgpt.com/backend-api", "generations")).toBe("https://chatgpt.com/backend-api/codex/images/generations");
		expect(imagesUrl("https://chatgpt.com/backend-api/codex/", "edits")).toBe("https://chatgpt.com/backend-api/codex/images/edits");
		expect(requestBody({ prompt: "p", background: "opaque", model: "m", quality: "auto", size: "auto" })).toEqual({ prompt: "p", background: "opaque", model: "m", quality: "auto", size: "auto" });
		expect(requestBody({ prompt: "p", background: "transparent", model: "m", quality: "low", size: "1024x1024", images: ["data:x"] }).images).toEqual([{ image_url: "data:x" }]);
		expect(sniffImage(PNG)).toBe("image/png");
		expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
		expect(sniffImage(Buffer.from("RIFF0000WEBPVP8 "))).toBe("image/webp");
		expect(sniffImage(Buffer.from("GIF89a..."))).toBe("image/gif");
		expect(sniffImage(Buffer.from("not an image"))).toBeUndefined();
	});
});

describe("image_gen plugin", () => {
	test("is in the catalog, on by default, and borrows only the openai-codex login", () => {
		expect(pluginCatalog.image_gen).toBe(imageGenPlugin);
		expect(imageGenPlugin.enabledByDefault).toBe(true);
		expect(imageGenPlugin.providerLogins).toEqual(["openai-codex"]);
	});

	test("generate posts what Codex posts and saves the returned image under the working directory", async () => {
		const cwd = await temp();
		const plugin = await load();
		expect(plugin.tools.map((tool) => tool.name)).toEqual(["image_gen_generate"]);
		// A codemode cell waits as long as the request may take (5 minutes by default, or the configured timeout).
		expect(plugin.tools[0]!.maxDurationMs).toBe(300_000);
		expect((await load({ timeoutMs: 600_000 })).tools[0]!.maxDurationMs).toBe(600_000);
		expect(plugin.providerLogins).toEqual(["openai-codex"]);
		const result = (await plugin.tools[0]!.execute({ prompt: "a red fox in a field" }, loggedIn(cwd))) as PluginContent;

		expect(codex.seen).toHaveLength(1);
		const [request] = codex.seen;
		expect(request!.method).toBe("POST");
		expect(request!.path).toBe("/backend-api/codex/images/generations");
		expect(request!.headers.authorization).toBe(`Bearer ${TOKEN}`);
		expect(request!.headers["chatgpt-account-id"]).toBe(ACCOUNT);
		expect(request!.headers.originator).toBe("pi");
		expect(request!.body).toEqual({ prompt: "a red fox in a field", background: "opaque", model: "gpt-image-2", quality: "auto", size: "auto" });

		expect(result).toBeInstanceOf(PluginContent);
		expect(result.blocks[0]).toEqual({ type: "image", mimeType: "image/png", data: PNG_B64 });
		const path = savedPath(result);
		expect(relative(join(cwd, "generated_images"), path).includes(sep)).toBe(false);
		expect(path).toMatch(/image-\d{8}-\d{6}-[0-9a-f]{8}\.png$/);
		expect(Buffer.compare(await readFile(path), PNG)).toBe(0);
		expect(textOf(result)).toContain('"requestId":"req-img-1"');
		expect(textOf(result)).toContain('"mode":"generate"');
	});

	test("options, a configured model and output directory, and a second call never overwrites the first", async () => {
		const cwd = await temp();
		const plugin = await load({ model: "gpt-image-1.5", outputDir: "art" });
		const call = loggedIn(cwd);
		const first = (await plugin.tools[0]!.execute({ prompt: "logo", transparent_background: true, size: "1024x1536", quality: "high" }, call)) as PluginContent;
		const second = (await plugin.tools[0]!.execute({ prompt: "logo" }, call)) as PluginContent;
		expect(codex.seen[0]!.body).toEqual({ prompt: "logo", background: "transparent", model: "gpt-image-1.5", quality: "high", size: "1024x1536" });
		expect(savedPath(first)).not.toBe(savedPath(second));
		expect((await readdir(join(cwd, "art"))).length).toBe(2);
	});

	test("edit sends referenced images as data URLs to the edits endpoint", async () => {
		const cwd = await temp();
		await writeFile(join(cwd, "ref.png"), PNG);
		const absolute = join(cwd, "second.bin");
		await writeFile(absolute, PNG);
		const plugin = await load();
		const result = (await plugin.tools[0]!.execute({ prompt: "add a red hat", referenced_image_paths: ["ref.png", absolute] }, loggedIn(cwd))) as PluginContent;
		expect(codex.seen[0]!.path).toBe("/backend-api/codex/images/edits");
		expect(codex.seen[0]!.body).toEqual({
			images: [{ image_url: `data:image/png;base64,${PNG_B64}` }, { image_url: `data:image/png;base64,${PNG_B64}` }],
			prompt: "add a red hat",
			background: "opaque",
			model: "gpt-image-2",
			quality: "auto",
			size: "auto",
		});
		expect(textOf(result)).toContain('"mode":"edit"');
	});

	test("without a stored ChatGPT login the call fails with login guidance and sends nothing", async () => {
		const cwd = await temp();
		const plugin = await load();
		await expect(plugin.tools[0]!.execute({ prompt: "x" }, { cwd })).rejects.toThrow("/login");
		await expect(plugin.tools[0]!.execute({ prompt: "x" }, { cwd, providerLogin: async () => undefined })).rejects.toThrow("OpenAI Codex");
		await expect(plugin.tools[0]!.execute({ prompt: "x" }, loggedIn(cwd, "sk-not-a-chatgpt-token"))).rejects.toThrow("not a ChatGPT login token");
		expect(codex.seen).toHaveLength(0);
	});

	test("invalid arguments and unreadable references are rejected before any request", async () => {
		const cwd = await temp();
		await writeFile(join(cwd, "notes.txt"), "hello");
		const plugin = await load();
		const call = loggedIn(cwd);
		const run = (args: unknown) => plugin.tools[0]!.execute(args, call);
		await expect(run({})).rejects.toThrow("`prompt`");
		await expect(run({ prompt: "   " })).rejects.toThrow("`prompt`");
		await expect(run({ prompt: "x", colour: "red" })).rejects.toThrow("unknown argument(s): colour");
		await expect(run({ prompt: "x", size: "999x999" })).rejects.toThrow("`size`");
		await expect(run({ prompt: "x", quality: "ultra" })).rejects.toThrow("`quality`");
		await expect(run({ prompt: "x", transparent_background: "yes" })).rejects.toThrow("`transparent_background`");
		await expect(run({ prompt: "x", referenced_image_paths: ["a", "b", "c", "d", "e", "f"] })).rejects.toThrow("at most 5");
		await expect(run({ prompt: "x", referenced_image_paths: ["missing.png"] })).rejects.toThrow("unable to read referenced image");
		await expect(run({ prompt: "x", referenced_image_paths: ["notes.txt"] })).rejects.toThrow("is not a PNG, JPEG, WebP or GIF image");
		await expect(run({ prompt: "x", referenced_image_paths: ["."] })).rejects.toThrow("is not a file");
		expect(codex.seen).toHaveLength(0);
	});

	test("backend failures are reported with status, limit reset and request id, never the token", async () => {
		const cwd = await temp();
		const plugin = await load();
		const call = loggedIn(cwd);
		codex.next = [{ status: 429, json: { error: { message: `usage limit for ${TOKEN}`, code: "usage_limit_reached" } }, headers: { "x-codex-primary-reset-at": "1791809622" } }];
		const limited = await plugin.tools[0]!.execute({ prompt: "x" }, call).catch((error: Error) => error.message);
		expect(limited).toContain("HTTP 429");
		expect(limited).toContain("limit of this ChatGPT plan reached; resets at 2026-");
		expect(limited).toContain("request req-img-1");
		expect(limited).not.toContain(TOKEN);

		codex.next = [{ status: 401, text: "unauthorized" }];
		await expect(plugin.tools[0]!.execute({ prompt: "x" }, call)).rejects.toThrow("log in again with /login");
		codex.next = [{ json: { created: 1, data: [] } }];
		await expect(plugin.tools[0]!.execute({ prompt: "x" }, call)).rejects.toThrow("returned no image data");
		codex.next = [{ json: { created: 1, data: [{ b64_json: Buffer.from("<html>").toString("base64") }] } }];
		await expect(plugin.tools[0]!.execute({ prompt: "x" }, call)).rejects.toThrow("not a PNG, JPEG, WebP or GIF image");
		codex.next = [{ text: "not json" }];
		await expect(plugin.tools[0]!.execute({ prompt: "x" }, call)).rejects.toThrow("not JSON");
		expect(await readdir(cwd)).toEqual([]);
	});

	test("an aborted call stops the request", async () => {
		const cwd = await temp();
		const plugin = await load();
		const abort = new AbortController();
		abort.abort(new Error("stopped by user"));
		await expect(plugin.tools[0]!.execute({ prompt: "x" }, { ...loggedIn(cwd), signal: abort.signal })).rejects.toThrow("cancelled or timed out");
	});

	test("separability: the plugin imports only its directory and ../types.ts, and only the catalog imports it", async () => {
		const root = join(import.meta.dir, "..", "src");
		const files: string[] = [];
		async function walk(path: string): Promise<void> {
			for (const entry of await readdir(path, { withFileTypes: true })) {
				if (entry.isDirectory()) await walk(join(path, entry.name));
				else if (entry.name.endsWith(".ts")) files.push(join(path, entry.name));
			}
		}
		await walk(root);
		for (const path of files) {
			const name = relative(root, path).split(sep).join("/");
			const specs = [...(await readFile(path, "utf8")).matchAll(/from "([^"]+)"/g)].map((match) => match[1]!);
			if (name.startsWith("plugins/image_gen/")) {
				for (const spec of specs.filter((value) => value.startsWith("."))) expect(spec.startsWith("./") || spec === "../types.ts").toBe(true);
			} else if (name !== "plugins/index.ts") {
				expect(specs.filter((value) => value.includes("image_gen/"))).toEqual([]);
			}
		}
	});
});

describe("image_gen through the bot", () => {
	const bots: Bot[] = [];
	afterEach(async () => {
		await Promise.all(bots.splice(0).map((bot) => bot.close(context)));
	});

	/** Records what `providerLogin` gives a plugin that did not declare the provider, or declared nothing. */
	const probe = definePlugin({
		id: "probe",
		providerLogins: ["openai-codex"],
		config: Type.Object({}),
		load: () => ({
			tools: [
				{
					name: "peek",
					description: "probe",
					inputSchema: { type: "object" },
					readOnly: true,
					async execute(_args: unknown, call: PluginToolCall) {
						const own = await call.providerLogin?.("openai-codex");
						const other = await call.providerLogin?.("anthropic").then(
							() => "resolved",
							(error: Error) => error.message,
						);
						return { own: own?.apiKey === TOKEN, other, cwd: call.cwd };
					},
				},
			],
		}),
	});
	const silent = definePlugin({
		id: "silent",
		config: Type.Object({}),
		load: () => ({
			tools: [{ name: "peek", description: "probe", inputSchema: { type: "object" }, readOnly: true, execute: async (_args: unknown, call: PluginToolCall) => ({ offered: call.providerLogin !== undefined }) }],
		}),
	});

	test("the stored openai-codex login reaches image_gen in every tool mode, and only declared plugins get a login", async () => {
		const dataDir = await temp();
		const store = openCredentialFile(dataDir);
		await store.addAccount("openai-codex", { type: "oauth", access: TOKEN, refresh: "refresh-token", expires: Date.now() + 3_600_000 } as never);
		const plugins: LoadedPlugin[] = [await load()];
		for (const plugin of [probe, silent]) {
			const loaded = await loadPlugin(plugin, {});
			if (Array.isArray(loaded)) throw new Error(loaded.join("; "));
			plugins.push(loaded);
		}
		for (const toolMode of ["codemode-only", "hybrid", "direct"] as ToolMode[]) {
			const workspace = await temp();
			const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
			const models = createModels({ credentials: store });
			models.setProvider(openaiCodexProvider());
			models.setProvider(faux.provider);
			const storage = await openNodeSqliteStorage(join(dataDir, `${toolMode}.sqlite`));
			const bot = await openBot({ storage, models, defaultModel: { provider: "faux", modelId: "faux-1" }, toolMode, plugins, workspaceRoot: workspace }, context);
			bots.push(bot);
			const results: string[] = [];
			const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
				toolMode === "direct" ? fauxToolCall(name, args) : fauxToolCall("codemode", { code: `return await tools.${name}(${JSON.stringify(args)});` });
			faux.setResponses([
				fauxAssistantMessage(call("image_gen_generate", { prompt: "a dinosaur" }), { stopReason: "toolUse" }),
				(transcript) => {
					results.push(JSON.stringify(transcript.messages.at(-1)));
					return fauxAssistantMessage(call("probe_peek", {}), { stopReason: "toolUse" });
				},
				(transcript) => {
					results.push(JSON.stringify(transcript.messages.at(-1)));
					return fauxAssistantMessage(call("silent_peek", {}), { stopReason: "toolUse" });
				},
				(transcript) => {
					results.push(JSON.stringify(transcript.messages.at(-1)));
					return fauxAssistantMessage("done");
				},
			]);
			const before = codex.seen.length;
			const reply = await bot.handle({ channel: "test", threadKey: `IG-${toolMode}`, messageId: "m1", userId: "U1", text: "draw a dinosaur" }, context);
			expect(reply).toMatchObject({ status: "answered", text: "done" });
			expect(codex.seen.length).toBe(before + 1);
			expect(codex.seen.at(-1)!.headers.authorization).toBe(`Bearer ${TOKEN}`);
			expect(codex.seen.at(-1)!.headers["chatgpt-account-id"]).toBe(ACCOUNT);
			const saved = await readdir(join(workspace, "generated_images"));
			expect(saved).toHaveLength(1);
			// Results nest JSON a mode-dependent number of times; compare without quotes and escapes.
			const plain = (value: string | undefined) => (value ?? "").replace(/[\\"]/g, "");
			expect(results[0]).toContain("Saved generated image to");
			expect(plain(results[1])).toContain("own:true");
			expect(plain(results[1])).toContain("probe_peek did not declare provider login anthropic");
			expect(plain(results[1])).toContain(`cwd:${plain(workspace)}`);
			expect(plain(results[2])).toContain("offered:false");
		}
	}, 120_000);
});
