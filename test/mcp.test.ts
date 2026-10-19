import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { type Bot, openBot } from "../src/core/bot.ts";
import type { ToolMode } from "../src/core/toolmode.ts";
import { mcpPlugin } from "../src/plugins/mcp/index.ts";
import { type LoadedPlugin, loadPlugin, PluginContent } from "../src/plugins/types.ts";
import { pluginResultContent } from "../src/core/plugin-content.ts";

const context = BACKGROUND_CONTEXT;
const fixture = join(import.meta.dir, "fixtures", "mcp-server.ts");
const stdioServer = { command: process.execPath, args: [fixture] };

const loaded: LoadedPlugin[] = [];
const bots: Bot[] = [];
let dir: string | undefined;
afterEach(async () => {
	for (const bot of bots.splice(0)) await bot.close(context);
	for (const plugin of loaded.splice(0)) await plugin.close?.();
	if (dir !== undefined) await rm(dir, { recursive: true, force: true });
	dir = undefined;
});

async function load(servers: Record<string, unknown>): Promise<LoadedPlugin | string[]> {
	const result = await loadPlugin(mcpPlugin, { servers });
	if (!Array.isArray(result)) loaded.push(result);
	return result;
}

async function loadFixture(): Promise<LoadedPlugin> {
	const result = await load({ fixture: stdioServer });
	if (Array.isArray(result)) throw new Error(result.join("\n"));
	return result;
}

async function startBot(plugin: LoadedPlugin, toolMode: ToolMode) {
	dir ??= await mkdtemp(join(tmpdir(), "dinobot-mcp-"));
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	const models = createModels();
	models.setProvider(faux.provider);
	const storage = await openNodeSqliteStorage(join(dir, "bot.sqlite"));
	const bot = await openBot(
		{ storage, models, defaultModel: { provider: "faux", modelId: "faux-1" }, toolMode, plugins: [plugin] },
		context,
	);
	bots.push(bot);
	return { bot, faux };
}

const message = { channel: "test", threadKey: "T1", messageId: "m1", userId: "U1", text: "add 40 and 2" };

let http: Bun.Subprocess | undefined;
let httpUrl = "";
beforeAll(async () => {
	const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
	const port = probe.port;
	await probe.stop(true);
	httpUrl = `http://127.0.0.1:${port}/mcp`;
	http = Bun.spawn([process.execPath, fixture, "--http", String(port)], { stdout: "ignore", stderr: "inherit" });
	const deadline = Date.now() + 10_000;
	for (;;) {
		const result = await loadPlugin(mcpPlugin, { servers: { ready: { type: "http", url: httpUrl } } });
		if (!Array.isArray(result)) {
			await result.close?.();
			return;
		}
		if (Date.now() > deadline) throw new Error(`MCP HTTP fixture not ready: ${result.join("\n")}`);
		await Bun.sleep(50);
	}
});
afterAll(() => {
	http?.kill();
});

describe("mcp plugin", () => {
	test("codemode scripts call stdio MCP tools", async () => {
		const plugin = await loadFixture();
		expect(plugin.tools.map((tool) => tool.name)).toEqual(["mcp_fixture_add"]);
		const { bot, faux } = await startBot(plugin, "codemode-only");
		let toolResult = "";
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("codemode", { code: "return await tools.mcp_fixture_add({ a: 40, b: 2 });" }), {
				stopReason: "toolUse",
			}),
			(transcript) => {
				toolResult = JSON.stringify(transcript.messages.at(-1));
				return fauxAssistantMessage("done");
			},
		]);

		expect(await bot.handle(message, context)).toMatchObject({ status: "answered", text: "done" });
		expect(toolResult).toContain("42");
	});

	test("direct mode offers and runs MCP tools", async () => {
		const { bot, faux } = await startBot(await loadFixture(), "direct");
		const offered: string[] = [];
		let toolResult = "";
		faux.setResponses([
			(transcript) => {
				for (const entry of transcript.messages as { role: string; toolsAdded?: { name: string }[] }[]) {
					if (entry.role === "system") offered.push(...(entry.toolsAdded ?? []).map((tool) => tool.name));
				}
				return fauxAssistantMessage(fauxToolCall("mcp_fixture_add", { a: 40, b: 2 }), { stopReason: "toolUse" });
			},
			(transcript) => {
				toolResult = JSON.stringify(transcript.messages.at(-1));
				return fauxAssistantMessage("done");
			},
		]);

		await bot.handle(message, context);
		expect(offered).toContain("mcp_fixture_add");
		expect(toolResult).toContain("42");
	});

	test("streamable HTTP servers expose callable tools", async () => {
		const plugin = await load({ remote: { type: "http", url: httpUrl } });
		if (Array.isArray(plugin)) throw new Error(plugin.join("\n"));
		const add = plugin.tools.find((tool) => tool.name === "mcp_remote_add");
		expect(await add?.execute({ a: 40, b: 2 }, {})).toBe("42");
	});

	test("image blocks pass through as images and binary blocks become notes", async () => {
		const plugin = await load({ fixture: { command: process.execPath, args: [fixture, "--images"] } });
		if (Array.isArray(plugin)) throw new Error(plugin.join("\n"));
		const snap = plugin.tools.find((tool) => tool.name === "mcp_fixture_snap")!;
		const value = await snap.execute({}, {});
		expect(value).toBeInstanceOf(PluginContent);
		expect((value as PluginContent).blocks).toEqual([
			{ type: "text", text: "caption" },
			{ type: "image", mimeType: "image/png", data: expect.any(String) },
			{ type: "text", text: "[audio omitted: audio/wav]" },
		]);
		const content = await pluginResultContent(value);
		expect(content.map((block) => block.type)).toEqual(["text", "image", "text"]);
		expect(JSON.stringify(content)).not.toContain("UklGR");
	});

	test("a server that fails to start is reported by name", async () => {
		const result = await load({ broken: { command: "/nonexistent/dinobot-mcp-server" } });
		expect(Array.isArray(result)).toBe(true);
		expect((result as string[])[0]).toContain('server "broken"');
	});

	test("expands ${VAR} from the environment", async () => {
		process.env.MCP_TEST_ARG = fixture;
		try {
			const plugin = await load({ fixture: { command: process.execPath, args: ["${MCP_TEST_ARG}"] } });
			if (Array.isArray(plugin)) throw new Error(plugin.join("\n"));
			expect(plugin.tools.map((tool) => tool.name)).toEqual(["mcp_fixture_add"]);
		} finally {
			delete process.env.MCP_TEST_ARG;
		}
	});
});
