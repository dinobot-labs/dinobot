import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage, type Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openBot, type Bot } from "../src/core/bot.ts";
import type { ToolMode } from "../src/core/toolmode.ts";
import type { AgentDefinition } from "../src/extensions/subagents.ts";
import { TOOL_SEARCH_MAX_BYTES } from "../src/extensions/tool-search.ts";
import type { LoadedPlugin } from "../src/plugins/types.ts";

const bots: Bot[] = [];
const dirs: string[] = [];
afterEach(async () => {
	for (const bot of bots.splice(0)) await bot.close(context);
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const cell = (code: string) => fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" });
const searchCell = (query: string) => cell(`const r=await tools.tool_search({query:${JSON.stringify(query)}}); for (const b of r.content) if(b.type==="text") text(b.text);`);
const sumSchema = { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"], additionalProperties: false };
async function setup(mode: ToolMode = "codemode-only", options: { agents?: readonly AgentDefinition[]; storage?: Storage; plugins?: LoadedPlugin[] } = {}) {
	let effects = 0;
	const faux = fauxProvider({ provider: "faux", models: [{ id: "one" }] });
	const models = createModels(); models.setProvider(faux.provider);
	const bot = await openBot({ storage: options.storage ?? new MemoryStorage(), models, defaultModel: { provider: "faux", modelId: "one" }, toolMode: mode, plugins: options.plugins ?? [{ id: "probe", tools: [{ name: "probe_sum", description: "Add two numbers for an integration probe", inputSchema: sumSchema, execute: async args => { effects++; const { a, b } = args as { a: number; b: number }; return a + b; } }] }], ...(options.agents ? { agents: options.agents } : {}) }, context);
	bots.push(bot);
	return { bot, faux, effects: () => effects, send: (id = "1") => bot.handle({ channel: "test", threadKey: "discovery", messageId: id, userId: "U", text: "두 수를 더하는 도구를 찾아서 사용하세요" }, context) };
}
function resultText(messages: readonly { role: string; content?: unknown }[]): string {
	const result = messages.findLast(m => m.role === "toolResult");
	return (result?.content as { type: string; text?: string }[] ?? []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
}
function contracts(messages: readonly { role: string; content?: unknown }[]) {
	const line = resultText(messages).split("\n").find(line => line.startsWith('{"matches":'));
	expect(line).toBeDefined();
	return JSON.parse(line!) as { matches: { name: string; description: string; parameters: unknown }[]; omitted: string[]; limited: boolean; exactMatch: boolean };
}

test.each(["direct", "hybrid", "codemode-only"] as const)("%s: search returns real schemas without executing or activating tools", async mode => {
	const { faux, send, effects } = await setup(mode);
	const direct = mode === "direct";
	faux.setResponses([
		transcript => {
			const prompt = JSON.stringify(transcript.messages);
			expect(prompt).toContain("short English capability keywords");
			return direct ? fauxAssistantMessage(fauxToolCall("tool_search", { query: "probe_sum" }), { stopReason: "toolUse" }) : searchCell("probe_sum");
		},
		transcript => {
			expect(effects()).toBe(0);
			expect(contracts(transcript.messages)).toEqual({ matches: [{ name: "probe_sum", description: "Add two numbers for an integration probe", parameters: sumSchema }], omitted: [], limited: false, exactMatch: true });
			const declarations = transcript.messages.flatMap(m => m.role === "system" ? (m.toolsAdded ?? []).map(t => t.name) : []);
			expect(declarations.includes("probe_sum")).toBe(mode !== "codemode-only");
			return direct ? fauxAssistantMessage(fauxToolCall("probe_sum", { a: 2, b: 3 }), { stopReason: "toolUse" }) : cell("text(await tools.probe_sum({a:2,b:3}));");
		},
		transcript => { expect(resultText(transcript.messages)).toContain("5"); return fauxAssistantMessage("done"); },
	]);
	expect(await send()).toMatchObject({ status: "answered", text: "done" });
	expect(effects()).toBe(1);
});

test("missing exact name is distinguished from semantic suggestions without disabling capability search", async () => {
	const { faux, send } = await setup("codemode-only", { agents: [{ name: "restricted", description: "restricted", tools: ["codemode", "tool_search", "skill_evolution_schedule"], prompt: "Discover only" }], plugins: [{ id: "fixture", tools: [{ name: "skill_evolution_schedule", description: "Schedule a skill research job", inputSchema: { type: "object", properties: {} }, execute: async () => "unused" }] }] });
	const observed: ReturnType<typeof contracts>[] = [];
	faux.setResponses([
		cell('text(await tools.task({description:"search",prompt:"inspect",subagent_type:"restricted"}));'),
		searchCell("schedule_create"),
		transcript => { observed.push(contracts(transcript.messages)); return searchCell("schedule research"); },
		transcript => { observed.push(contracts(transcript.messages)); return fauxAssistantMessage("child done"); },
		fauxAssistantMessage("parent done"),
	]);
	await send();
	expect(observed).toHaveLength(2);
	expect(observed[0]!.exactMatch).toBe(false);
	expect(observed[0]!.matches.map(t => t.name)).toContain("skill_evolution_schedule");
	expect(observed[1]!.matches.map(t => t.name)).toContain("skill_evolution_schedule");
});

test("restricted subagent cannot discover forbidden tool metadata, even by exact name", async () => {
	const { faux, send, effects } = await setup("codemode-only", { agents: [{ name: "restricted", description: "restricted", tools: ["codemode", "tool_search", "session_list"], prompt: "Inspect allowed tool contracts only" }] });
	faux.setResponses([
		cell('text(await tools.task({description:"scoped",prompt:"inspect",subagent_type:"restricted"}));'),
		transcript => { expect(JSON.stringify(transcript.messages)).not.toContain("Add two numbers for an integration probe"); return searchCell("probe_sum"); },
		transcript => { expect(contracts(transcript.messages).matches).toEqual([]); return searchCell("session_list"); },
		transcript => { expect(contracts(transcript.messages).matches.map(t => t.name)).toEqual(["session_list"]); return fauxAssistantMessage("child done"); },
		fauxAssistantMessage("parent done"),
	]);
	await send();
	expect(effects()).toBe(0);
});

test("restricted subagent without discovery still receives its allowed hidden contracts", async () => {
	const { faux, send } = await setup("codemode-only", { agents: [{ name: "restricted", description: "restricted", tools: ["codemode", "probe_sum"], prompt: "Add two numbers" }] });
	faux.setResponses([
		cell('text(await tools.task({description:"scoped",prompt:"add",subagent_type:"restricted"}));'),
		transcript => { expect(JSON.stringify(transcript.messages)).toContain("Arguments JSON schema:"); expect(JSON.stringify(transcript.messages)).toContain("probe_sum:"); return cell("text(await tools.probe_sum({a:1,b:2}));"); },
		fauxAssistantMessage("child done"), fauxAssistantMessage("parent done"),
	]);
	await send();
});

test("parallel search is bounded by admission order within a cell", async () => {
	const { faux, send } = await setup();
	faux.setResponses([
		cell('text(await Promise.all(["read","write","edit"].map(query=>tools.tool_search({query}))));'),
		transcript => { const text = resultText(transcript.messages); expect(text).toContain("Search budget exceeded"); expect(text).toContain('\\"name\\":\\"read\\"'); expect(text).toContain('\\"name\\":\\"write\\"'); return searchCell("edit"); },
		transcript => { expect(contracts(transcript.messages).matches.map(t=>t.name)).toEqual(["edit"]); return fauxAssistantMessage("done"); },
	]);
	await send();
});

test("oversized schemas are explicitly omitted, never partially returned", async () => {
	const { faux, send } = await setup("codemode-only", { plugins: [{ id: "huge", tools: [{ name: "huge_tool", description: "huge", inputSchema: { type: "object", description: "x".repeat(TOOL_SEARCH_MAX_BYTES + 1) }, execute: async () => { throw new Error("must not execute"); } }] }] });
	faux.setResponses([searchCell("huge_tool"), transcript => {
		expect(contracts(transcript.messages)).toEqual({ matches: [], omitted: ["huge_tool"], limited: true, exactMatch: true });
		expect(Buffer.byteLength(resultText(transcript.messages))).toBeLessThan(TOOL_SEARCH_MAX_BYTES);
		return fauxAssistantMessage("done");
	}]);
	await send();
});

test("search receipts survive SQLite restart without retaining removed plugin capabilities", async () => {
	const dir = await mkdtemp(join(tmpdir(), "tool-search-restart-")); dirs.push(dir);
	const path = join(dir, "bot.sqlite");
	const first = await setup("codemode-only", { storage: await openNodeSqliteStorage(path) });
	first.faux.setResponses([searchCell("probe_sum"), fauxAssistantMessage("before")]);
	await first.send();
	await first.bot.close(context); bots.splice(bots.indexOf(first.bot), 1);
	const second = await setup("codemode-only", { storage: await openNodeSqliteStorage(path), plugins: [] });
	second.faux.setResponses([transcript => { expect(JSON.stringify(transcript.messages)).toContain("Add two numbers for an integration probe"); return searchCell("probe_sum"); }, transcript => { expect(contracts(transcript.messages).matches).toEqual([]); return fauxAssistantMessage("after"); }]);
	await second.send("2");
});
