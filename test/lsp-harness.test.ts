import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openBot, type Bot } from "../src/core/bot.ts";
import type { ToolMode } from "../src/core/toolmode.ts";

const bots: Bot[] = [];
const dirs: string[] = [];
afterEach(async () => {
	for (const bot of bots.splice(0)) await bot.close(context);
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const fixture = fileURLToPath(new URL("./fixtures/lsp-server.ts", import.meta.url));
async function setup(mode: ToolMode, missing = false, fixtureMode = "normal") {
	const cwd = await mkdtemp(join(tmpdir(), "dinobot-lsp-harness-"));
	dirs.push(cwd);
	const log = join(cwd, "lsp-wire.jsonl");
	await writeFile(join(cwd, "main.ts"), "const LSP_SENTINEL = 1;\n");
	const faux = fauxProvider({ provider: "faux", models: [{ id: "one" }] });
	const models = createModels();
	models.setProvider(faux.provider);
	const bot = await openBot({
		storage: new MemoryStorage(), models, defaultModel: { provider: "faux", modelId: "one" },
		toolMode: mode, plugins: [], workspaceRoot: cwd,
		lsp: { servers: [{ name: "fixture", command: missing ? ["dinobot-nonexistent-lsp-binary"] : [process.execPath, fixture, fixtureMode, log], extensions: [".ts"], languageId: "typescript" }] },
		agents: [{ name: "restricted", description: "no semantic access", tools: ["codemode", "session_list"], prompt: "Only inspect sessions" }],
	}, context);
	bots.push(bot);
	const conversation = await bot.conversation("test", "lsp", context);
	async function run(name: string, args: Parameters<typeof fauxToolCall>[1]) {
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await (await conversation.submit({ type: "input", content: "inspect code" }, context)).wait(context);
		return (await conversation.context(context)).messages.filter((message) => message.role === "toolResult").at(-1)!;
	}
	return { cwd, log, bot, conversation, faux, run };
}

for (const mode of ["direct", "hybrid", "codemode-only"] as const) {
	test(`LSP roundtrip is registered and usable in ${mode}`, async () => {
		const { run, conversation } = await setup(mode);
		const names = (await conversation.agent(context)).tools.map((tool) => tool.name);
		expect(names).toContain("lsp");
		expect(names.includes("codemode")).toBe(mode !== "direct");
		const args = { operation: "hover", path: "main.ts", line: 1, character: 7 };
		const result = mode === "direct" ? await run("lsp", args) :
			await run("codemode", { code: `text(await tools.lsp(${JSON.stringify(args)}));` });
		expect(result.isError).not.toBe(true);
		expect(JSON.stringify(result.content)).toContain("LSP_SENTINEL");
		if (mode !== "direct") expect(result.details).toMatchObject({ codemodeCalls: [{ name: "lsp", status: "done" }] });
	});
}

test("LSP missing-server failures survive codemode and its durable status receipt", async () => {
	const { run } = await setup("codemode-only", true);
	const status = await run("codemode", { code: 'text(await tools.lsp({operation:"status"}));' });
	expect(status.isError).not.toBe(true);
	expect(JSON.stringify(status.content)).toContain("dinobot-nonexistent-lsp-binary");
	const failed = await run("codemode", { code: 'text(await tools.lsp({operation:"hover",path:"main.ts",line:1,character:1}));' });
	expect(failed.isError).toBe(true);
	expect(JSON.stringify(failed.content)).toContain("fixture");
	const id = (failed.details as { codemodeTaskId: number }).codemodeTaskId;
	const receipt = await run("codemode_status", { task_id: id });
	expect(JSON.stringify(receipt.content)).toContain("lsp");
	expect(JSON.stringify(receipt.content)).toContain("isError");
});

test("LSP follows execution cwd after conversation reconfiguration", async () => {
	const { run, conversation } = await setup("codemode-only");
	const cwd = await mkdtemp(join(tmpdir(), "dinobot-lsp-new-cwd-"));
	dirs.push(cwd);
	await writeFile(join(cwd, "main.ts"), "const CHANGED_WORKSPACE = 2;\n");
	await conversation.configure({ cwd }, context);
	const result = await run("codemode", { code: 'text(await tools.lsp({operation:"hover",path:"main.ts",line:1,character:7}));' });
	expect(result.isError).not.toBe(true);
	expect(JSON.stringify(result.content)).toContain("CHANGED_WORKSPACE");
	expect(JSON.stringify(result.content)).not.toContain("LSP_SENTINEL");
});

test("LSP remains subject to explicit subagent allowlists", async () => {
	const { conversation, faux } = await setup("codemode-only");
	let checked = false;
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("codemode", { code: 'text(await tools.task({description:"scoped",prompt:"inspect",subagent_type:"restricted"}));' }), { stopReason: "toolUse" }),
		() => {
			checked = true;
			return fauxAssistantMessage(fauxToolCall("codemode", { code: 'if (typeof tools.lsp !== "undefined") throw new Error("LSP leaked"); text("allowlist respected");' }), { stopReason: "toolUse" });
		},
		fauxAssistantMessage("child done"),
		fauxAssistantMessage("parent done"),
	]);
	await (await conversation.submit({ type: "input", content: "check restriction" }, context)).wait(context);
	expect(checked).toBe(true);
	const results = (await conversation.context(context)).messages.filter((message) => message.role === "toolResult");
	expect(JSON.stringify(results)).not.toContain("LSP leaked");
	expect(JSON.stringify(results)).toContain("child done");
});

test("aborting codemode cancels the actual LSP request and retires its process", async () => {
	const { log, bot, conversation, faux } = await setup("codemode-only", false, "hang");
	faux.setResponses([fauxAssistantMessage(fauxToolCall("codemode", {
		code: 'text(await tools.lsp({operation:"hover",path:"main.ts",line:1,character:1}));',
	}), { stopReason: "toolUse" })]);
	const submission = await conversation.submit({ type: "input", content: "inspect" }, context);
	const deadline = Date.now() + 3000;
	let pid: number | undefined;
	while (Date.now() < deadline) {
		const records = (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean)
			.map((line) => JSON.parse(line) as { event: string; pid: number });
		pid = records.find((entry) => entry.event === "hover")?.pid;
		if (pid !== undefined) break;
		await Bun.sleep(10);
	}
	expect(pid).toBeDefined();
	await conversation.abort(context);
	await submission.wait(context);
	expect((await bot.harness.inspect(context)).tasks).toEqual([]);
	let exited = false;
	while (Date.now() < deadline + 1000) {
		try { process.kill(pid!, 0); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
			exited = true;
			break;
		}
		await Bun.sleep(10);
	}
	expect(exited).toBe(true);
}, 6000);
