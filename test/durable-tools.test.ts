import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage, type Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import * as durableTools from "@earendil-works/pi-durable/tools";
import { openBot, type Bot } from "../src/core/bot.ts";
import { memoryExtension } from "../src/extensions/memory.ts";

const bots: Bot[] = [];
const dirs: string[] = [];
afterEach(async () => {
	for (const bot of bots.splice(0)) await bot.close(context);
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function directory() {
	const dir = await mkdtemp(join(tmpdir(), "dinobot-tools-"));
	dirs.push(dir);
	return dir;
}
async function setup(cwd: string, storage: Storage = new MemoryStorage()) {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "one" }] });
	const models = createModels(); models.setProvider(faux.provider);
	const bot = await openBot({ storage, models, defaultModel: { provider: "faux", modelId: "one" }, toolMode: "codemode-only", plugins: [], workspaceRoot: cwd }, context);
	bots.push(bot);
	const conversation = await bot.conversation("test", "tools", context);
	return { bot, conversation, async run(code: string, thread = conversation) {
		const root = (await thread.agent(context)).cwd ?? cwd;
		const plan = {
			op: "register",
			contract: {
				requirements: [{ id: "files", assertion: "File operations preserve requested bytes", checkIds: ["files"], scenarioIds: ["roundtrip"] }],
				scenarios: [{ id: "roundtrip", assertion: "Written and edited bytes round trip" }],
				checks: [{ id: "files", requirementIds: ["files"], scenarioIds: ["roundtrip"], evidence: "behavioral", expected: "Requested bytes round trip" }],
			},
			scope: { root, inputs: [], disposable: [] },
			methods: { files: { command: process.execPath, runner: "bun", cwd: root, args: ["./files.test.ts"], timeout: 10, adapterVersion: 1, locators: [{ scenarioId: "roundtrip", file: "files.test.ts", name: "roundtrip" }] } },
		};
		const managed = /tools\.(write|edit|bash)\(/.test(code);
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("codemode", { code: managed ? `
				const status = JSON.parse((await tools.work_status({})).content[0].text);
				const sourceIds = Object.keys(status.work.sources);
				const registered = await tools.work_plan({...${JSON.stringify(plan)}, sourceIds});
				if (registered.isError) throw new Error(JSON.stringify(registered));
				${code}` : code }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
			fauxAssistantMessage("done"),
			fauxAssistantMessage("done"),
		]);
		await (await thread.submit({ type: "input", content: "run" }, context)).wait(context);
		const messages = (await thread.context(context)).messages;
		return messages.filter((message) => message.role === "toolResult").at(-1)!;
	} };
}
const textOf = (result: { content: unknown }) => JSON.stringify(result.content);

test("every public durable tool and every registered capability is available inside codemode", async () => {
	const { conversation, run } = await setup(await directory());
	const agent = await conversation.agent(context);
	const expected = agent.tools.map((tool) => tool.name).filter((name) => name !== "codemode").sort();
	// Detect a newly exported tool factory as well as additions to CodingTools on upgrades.
	for (const [name, factory] of Object.entries(durableTools)) {
		if (/^create.*Tool$/.test(name) && typeof factory === "function")
			expect(expected).toContain(factory().name);
	}
	for (const tool of memoryExtension({ workspaceRoot: process.cwd() }).tools!) expect(expected).toContain(tool.name);
	for (const name of ["work_plan", "work_status", "verify_run", "work_finish"]) expect(expected).toContain(name);
	const result = await run("text(Object.keys(tools).sort());");
	expect(result.isError).not.toBe(true);
	const block = result.content.find((block) => block.type === "text")!;
	expect(JSON.parse(block.type === "text" ? block.text : "[]")).toEqual(expected);
});

test("codemode creates, edits, reads and greps files in the conversation cwd", async () => {
	const cwd = await directory();
	const { bot, conversation, run } = await setup(cwd);
	expect((await conversation.agent(context)).cwd).toBe(cwd);
	const result = await run(`
		text(await tools.write({path:"nested/file.txt",content:"hello\\n"}));
		text(await tools.edit({path:"nested/file.txt",edits:[{oldText:"hello",newText:"world"}]}));
		text(await tools.read({path:"nested/file.txt"}));
		text(await tools.bash({command:"grep -n world nested/file.txt",timeout:5}));
	`);
	expect(result.isError).not.toBe(true);
	expect(textOf(result)).toContain("1:world");
	expect(await readFile(join(cwd, "nested/file.txt"), "utf8")).toBe("world\n");
	const other = await directory();
	const changed = await bot.conversation("test", "changed-cwd", context);
	await changed.configure({ cwd: other }, context);
	await run('text(await tools.write({path:"changed.txt",content:"new cwd"}));', changed);
	expect(await readFile(join(other, "changed.txt"), "utf8")).toBe("new cwd");
});

test("shell failures retain logs, large output is bounded and timeout is reported", async () => {
	const { run } = await setup(await directory());
	const failed = await run('text(await tools.bash({command:"echo failure-evidence; exit 7"}));');
	expect(textOf(failed)).toContain("failure-evidence");
	expect(textOf(failed)).toContain("code 7");
	const large = await run(`const r=await tools.bash({command:"seq 1 60000; echo output-finished",timeout:5}); text({isError:r.isError??false, diagnostics:r.diagnostics, tail:r.content});`);
	expect(large.isError).not.toBe(true);
	expect(textOf(large)).toContain("output-finished");
	expect(textOf(large)).toContain("full_output");
	expect(textOf(large)).toContain("truncated");
	const timeout = await run('text(await tools.bash({command:"echo timeout-evidence; sleep 30",timeout:0.1}));');
	expect(textOf(timeout)).toContain("timeout-evidence");
	expect(textOf(timeout)).toContain("timed out");
});

test("memory supports every operation, shares across threads, rejects stale writes and survives reopen", async () => {
	const cwd = await directory();
	const db = join(cwd, "state.sqlite");
	const first = await setup(cwd, await openNodeSqliteStorage(db));
	const saved = await first.run('text(await tools.memory_write({key:"project/runtime",content:"Use Bun",expected_revision:0}));');
	expect(saved.isError).not.toBe(true);
	const stale = await first.run('text(await tools.memory_write({key:"project/runtime",content:"wrong",expected_revision:0}));');
	expect(textOf(stale)).toContain("revision conflict");
	await first.bot.close(context); bots.splice(bots.indexOf(first.bot), 1);
	const second = await setup(cwd, await openNodeSqliteStorage(db));
	const thread = await second.bot.conversation("test", "another-thread", context);
	const restored = await second.run(`
		text(await tools.memory_read({key:"project/runtime"}));
		text(await tools.memory_list({prefix:"project/",limit:1}));
		text(await tools.memory_search({query:"bun"}));
	`, thread);
	expect(restored.isError).not.toBe(true);
	expect(textOf(restored)).toContain("Use Bun");
	expect(textOf(restored)).toContain("excerpt");
	const deleted = await second.run(`
		text(await tools.memory_delete({key:"project/runtime",expected_revision:1}));
		text(await tools.memory_read({key:"project/runtime"}));
		text(await tools.memory_list({}));
	`, thread);
	const values = deleted.content.filter((block) => block.type === "text")
		.map((block) => JSON.parse(JSON.parse(block.text).content[0].text));
	expect(values[0].deleted).toBe(true);
	expect(values[1].found).toBe(false);
	expect(values[2].total).toBe(0);
});
