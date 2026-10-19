import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage, type Conversation, type Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openBot, type Bot } from "../src/core/bot.ts";
import { SkillPinDoc } from "../src/core/skills/manifests.ts";
import { TOOL_MODES, type ToolMode } from "../src/core/toolmode.ts";

// These explicit faux scripts verify harness plumbing, not live-model research compliance.
const bots: Bot[] = [];
const directories: string[] = [];
afterEach(async () => {
	for (const bot of bots.splice(0)) await bot.close(context);
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function directory() {
	const path = await mkdtemp(join(tmpdir(), "dinobot-research-"));
	directories.push(path);
	return path;
}
async function close(bot: Bot) {
	await bot.close(context);
	bots.splice(bots.indexOf(bot), 1);
}
async function absent(path: string) {
	await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
}
type ToolOutput = Pick<ToolResultMessage, "content" | "isError">;
function textOf(result: ToolOutput) {
	return result.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
}
async function setup(workspaceRoot: string, toolMode: ToolMode, storage: Storage = new MemoryStorage()) {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "one" }] });
	const models = createModels();
	models.setProvider(faux.provider);
	const bot = await openBot({
		storage, models, defaultModel: { provider: "faux", modelId: "one" },
		workspaceRoot, toolMode, plugins: [],
		settings: { retry: { enabled: false }, compaction: { enabled: false } },
	}, context);
	bots.push(bot);
	return {
		bot, faux,
		async tool(conversation: Conversation, name: string, args: Parameters<typeof fauxToolCall>[1]) {
			let output: ToolOutput | undefined;
			faux.setResponses([
				fauxAssistantMessage(fauxToolCall(
					toolMode === "direct" ? name : "codemode",
					toolMode === "direct" ? args : { code: `text(await tools.${name}(${JSON.stringify(args)}));` },
				), { stopReason: "toolUse" }),
				(request) => {
					const result = request.messages.filter((message) => message.role === "toolResult").at(-1);
					if (!result) throw new Error(`Missing ${name} tool result`);
					expect(result.toolName).toBe(toolMode === "direct" ? name : "codemode");
					expect(result.isError).not.toBe(true);
					output = toolMode === "direct" ? result : JSON.parse(textOf(result)) as ToolOutput;
					expect(output.isError).not.toBe(true);
					return fauxAssistantMessage("Scripted tool call complete.");
				},
			]);
			const submitted = await conversation.submit({ type: "input", content: `Execute scripted ${name} call.` }, context);
			expect((await submitted.wait(context)).status).toBe("done");
			if (!output) throw new Error(`Provider did not observe ${name} output`);
			return output;
		},
	};
}

test.each([...TOOL_MODES])("%s research documents follow configured conversation cwd and survive SQLite reopen", async (mode) => {
	const host = await directory();
	const targetA = await directory();
	const targetB = await directory();
	const database = join(host, "bot.sqlite");
	const first = await setup(host, mode, await openNodeSqliteStorage(database));
	const a = await first.bot.conversation("test", "research-a", context);
	const b = await first.bot.conversation("test", "research-b", context);
	await a.configure({ cwd: targetA }, context);
	await b.configure({ cwd: targetB }, context);
	const loaded = JSON.parse(textOf(await first.tool(a, "skills_load", { name: "research" })));
	expect(loaded.body).toContain("# Research");
	expect(loaded.body).toContain("## Research contract");
	expect(typeof loaded.version).toBe("string");
	expect(loaded.version.length).toBeGreaterThan(0);
	const pin = await first.bot.harness.snapshot(SkillPinDoc, a.id, context);
	expect(pin?.pin).toBeTruthy();
	await absent(join(targetA, ".dinobot"));
	await absent(join(targetB, ".dinobot"));
	await absent(join(host, ".dinobot"));

	const run = `.dinobot/research/queue-latency-${randomUUID()}`;
	const report = `${run}/report.md`;
	const evidence = `${run}/evidence.md`;
	const reportA = "# Research report A\nObserved p95: 18 ms in fixture A; not a general performance claim.\n";
	const reportB = "# Research report B\nObserved p95: 41 ms in fixture B; not fixture A.\n";
	const evidenceA = "# Evidence A\nScripted sample: [12, 18]. No live benchmark was run.\n";
	const evidenceB = "# Evidence B\nScripted sample: [30, 41]. No live benchmark was run.\n";
	// YOLO permits these ordinary writes without registering a dummy work_plan.
	for (const [conversation, root, reportBytes, evidenceBytes] of [
		[a, targetA, reportA, evidenceA], [b, targetB, reportB, evidenceB],
	] as const) {
		for (const [path, content] of [[evidence, evidenceBytes], [report, reportBytes]] as const) {
			const written = await first.tool(conversation, "write", { path, content });
			expect(textOf(written)).toBe(`Successfully wrote to ${path}`);
			expect(await readFile(join(root, path), "utf8")).toBe(content);
			expect(textOf(await first.tool(conversation, "read", { path }))).toBe(content);
		}
		if (conversation === a) await absent(join(targetB, ".dinobot"));
	}
	expect(await readFile(join(targetA, report), "utf8")).toBe(reportA);
	expect(await readFile(join(targetB, report), "utf8")).toBe(reportB);
	await absent(join(host, ".dinobot"));
	await close(first.bot);

	const second = await setup(host, mode, await openNodeSqliteStorage(database));
	const resumedA = await second.bot.conversation("test", "research-a", context);
	const resumedB = await second.bot.conversation("test", "research-b", context);
	expect(resumedA.id).toBe(a.id);
	expect(resumedB.id).toBe(b.id);
	expect((await resumedA.agent(context)).cwd).toBe(targetA);
	expect((await resumedB.agent(context)).cwd).toBe(targetB);
	expect(await second.bot.harness.snapshot(SkillPinDoc, resumedA.id, context)).toEqual(pin);
	const reloaded = JSON.parse(textOf(await second.tool(resumedA, "skills_load", { name: "research" })));
	expect(reloaded).toMatchObject({ version: loaded.version, body: loaded.body, generation: loaded.generation });
	for (const [conversation, root, reportBytes, evidenceBytes] of [
		[resumedA, targetA, reportA, evidenceA], [resumedB, targetB, reportB, evidenceB],
	] as const) {
		for (const [path, content] of [[report, reportBytes], [evidence, evidenceBytes]] as const) {
			expect(textOf(await second.tool(conversation, "read", { path }))).toBe(content);
			expect(await readFile(join(root, path), "utf8")).toBe(content);
		}
	}
	await absent(join(host, ".dinobot"));
}, 30_000);

test.each([...TOOL_MODES])("%s explicit load-only, lookup and response-only scripts create no research folders", async (mode) => {
	const host = await directory();
	const target = await directory();
	await writeFile(join(target, "lookup.txt"), "lookup-only fixture: observed value 17\n");
	const { bot, faux, tool } = await setup(host, mode);
	const conversation = await bot.conversation("test", "research-no-write", context);
	await conversation.configure({ cwd: target }, context);
	const loaded = await tool(conversation, "skills_load", { name: "research" });
	expect(JSON.parse(textOf(loaded)).body).toContain("## Research contract");
	await absent(join(target, ".dinobot"));
	await absent(join(host, ".dinobot"));
	const lookup = await tool(conversation, "read", { path: "lookup.txt" });
	expect(textOf(lookup)).toContain("lookup-only fixture: observed value 17");
	await absent(join(target, ".dinobot"));
	await absent(join(host, ".dinobot"));

	const before = (await conversation.context(context)).messages.filter((message) => message.role === "toolResult").length;
	const reply = "Response-only research summary: evidence is limited to the supplied fixture; no files were written.";
	faux.setResponses([fauxAssistantMessage(reply)]);
	const submitted = await conversation.submit({ type: "input", content: "Summarize the supplied fixture in chat only. Do not write files." }, context);
	expect((await submitted.wait(context)).status).toBe("done");
	const messages = (await conversation.context(context)).messages;
	expect(messages.filter((message) => message.role === "toolResult")).toHaveLength(before);
	const response = messages.filter((message) => message.role === "assistant").at(-1);
	expect(response?.content).toContainEqual({ type: "text", text: reply });
	await absent(join(target, ".dinobot"));
	await absent(join(host, ".dinobot"));
});
