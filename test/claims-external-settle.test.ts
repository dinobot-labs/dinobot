import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { type Bot, openBot } from "../src/core/bot.ts";
import { NativeProvenanceDoc } from "../src/core/claim-cleanup.ts";
import { liveClaims } from "../src/core/claims.ts";
import { listThreads } from "../src/core/threads.ts";
import { definePlugin, type LoadedPlugin, loadPlugin } from "../src/plugins/types.ts";

const context = BACKGROUND_CONTEXT;
let gate: { started: () => void; release: Promise<void> } | undefined;
const plugin = (await loadPlugin(definePlugin({
	id: "ext", config: Type.Object({}),
	load: () => ({
		tools: [
			{ name: "act", description: "write-capable plugin tool", inputSchema: { type: "object", properties: {} }, execute: async () => { gate?.started(); await gate?.release; return "done"; } },
			{ name: "fail", description: "write-capable plugin tool that throws", inputSchema: { type: "object", properties: {} }, execute: async () => { throw new Error("boom"); } },
		],
	}),
}), {})) as LoadedPlugin;

const bots: Bot[] = []; const dirs: string[] = [];
afterEach(async () => { gate = undefined; for (const b of bots.splice(0)) await b.close(context); for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

const code = (js: string) => fauxAssistantMessage(fauxToolCall("codemode", { code: js }), { stopReason: "toolUse" });
const msg = (threadKey: string, text: string) => ({ channel: "test", threadKey, messageId: threadKey + text, userId: "U1", text });
const lastResult = (t: { messages: { role: string }[] }) => fauxAssistantMessage(JSON.stringify(t.messages.at(-1)));

async function start() {
	const dir = await mkdtemp(join(tmpdir(), "claims-ext-")); dirs.push(dir);
	const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
	const models = createModels(); models.setProvider(faux.provider);
	const bot = await openBot({ storage: await openNodeSqliteStorage(join(dir, "b.sqlite")), models, defaultModel: { provider: "faux", modelId: "m" }, workspaceRoot: dir, toolMode: "codemode-only", plugins: [plugin], settings: { retry: { enabled: false } } }, context);
	bots.push(bot);
	return { bot, faux };
}

for (const tool of ["ext_act", "ext_fail"] as const) test(`a returned plugin call (${tool}) ends its fence; release then frees the key and later claims are not fenced`, async () => {
	const { bot, faux } = await start();
	faux.setResponses([
		code("text(await tools.work_claim({key:'repo:img', intent:'make an image'}));"),
		code(`try { text(await tools.${tool}({})); } catch (e) { text(String(e)); }`),
		code("text(await tools.work_claim({key:'repo:later', intent:'later work'}));"),
		fauxAssistantMessage("a holds"),
		code("text(await tools.work_release({}));"),
		fauxAssistantMessage("a released"),
		code("text(JSON.stringify(await tools.work_claim({key:'repo:img/x', intent:'other thread'})));"),
		lastResult,
	]);
	await bot.handle(msg("a", "go"), context);
	const held = await liveClaims(bot.harness, context);
	expect(held.map((c) => [c.key, c.quarantined ?? null])).toEqual([["repo:img", null], ["repo:later", null]]);
	const a = (await listThreads(bot.harness, context))["test:a"]!;
	expect((await bot.harness.snapshot(NativeProvenanceDoc, a, context))!.calls.find((c) => c.kind === "external:" + tool)?.phase).toBe("settled");
	await bot.handle(msg("a", "release"), context);
	expect(await liveClaims(bot.harness, context, Date.now() + 25 * 60 * 60_000)).toEqual([]);
	const b = await bot.handle(msg("b", "go"), context);
	expect(b.status === "answered" ? b.text : "").toContain("Claimed repo:img/x held by test:b");
}, 60_000);

test("while a plugin call runs the holder's claim stays fenced", async () => {
	const { bot, faux } = await start();
	let started!: () => void; const running = new Promise<void>((r) => { started = r; });
	let open!: () => void; gate = { started, release: new Promise<void>((r) => { open = r; }) };
	faux.setResponses([
		code("text(await tools.work_claim({key:'repo:img', intent:'make an image'}));"),
		code("text(await tools.ext_act({}));"),
		fauxAssistantMessage("done"),
	]);
	const pending = bot.handle(msg("a", "go"), context);
	await running;
	expect((await liveClaims(bot.harness, context))[0]?.quarantined).toBe("UNKNOWN native external:ext_act provenance");
	open();
	await pending;
	expect((await liveClaims(bot.harness, context))[0]?.quarantined).toBeUndefined();
}, 60_000);
