import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { JsonObject } from "@earendil-works/pi-durable";
import { openBot, type Bot } from "../src/core/bot.ts";
import type { ToolMode } from "../src/core/toolmode.ts";
import { SKILL_TOOL_NAMES } from "../src/extensions/skills.ts";
import { CellDoc } from "../src/core/codemode/calls.ts";

const bots: Bot[] = [];
/** Human-directed publication: the human message names the skill and the agent quotes it. */
const directed = (skill: string) => ({ evidence: { kind: "instruction", quote: `please publish ${skill}` }, text: `please publish ${skill} now` });
const dirs: string[] = [];
afterEach(async () => {
	for (const bot of bots.splice(0)) await bot.close(context);
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function setup(toolMode: ToolMode, directory?: string) {
	const dir = directory ?? await mkdtemp(join(tmpdir(), "dinobot-skill-tools-"));
	if (!directory) dirs.push(dir);
	const models = createModels();
	const faux = fauxProvider({ provider: "faux", models: [{ id: "one" }] });
	models.setProvider(faux.provider);
	const bot = await openBot({ storage: await openNodeSqliteStorage(join(dir, "bot.sqlite")), models, defaultModel: { provider: "faux", modelId: "one" }, toolMode, plugins: [], workspaceRoot: dir }, context);
	bots.push(bot);
	const conversation = await bot.conversation("test", "skills", context);
	let counter = 0;
	const offered = new Set<string>();
	async function run(name: string, args: JsonObject, direct = toolMode === "direct", humanText = "use skill tool") {
		let result: Extract<Message, { role: "toolResult" }> | undefined;
		let system = "";
		faux.setResponses([
			(request) => {
				for (const message of request.messages) {
					if (message.role !== "system") continue;
					system += JSON.stringify(message);
					for (const tool of message.toolsAdded ?? []) offered.add(tool.name);
				}
				return fauxAssistantMessage(fauxToolCall(direct ? name : "codemode", direct ? args : { code: `const r = await tools.${name}(${JSON.stringify(args)}); for (const c of r.content ?? []) if(c.type === 'text') text(c.text);` }), { stopReason: "toolUse" });
			},
			(request) => { result = request.messages.filter((message) => message.role === "toolResult").at(-1); return fauxAssistantMessage("done"); },
		]);
		await bot.handle({ channel: "test", threadKey: "skills", messageId: `run-${++counter}`, userId: "not-an-approver", text: humanText }, context);
		if (!result) throw new Error("No tool result");
		const text = result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
		return { result, text, system, json: () => JSON.parse(text) };
	}
	return { bot, dir, conversation, run, offered };
}

for (const mode of ["direct", "hybrid", "codemode-only"] as const) {
	test(`${mode}: every skill tool uses staged, approved, versioned state`, async () => {
		const { bot, run, offered, conversation } = await setup(mode);
		const initial = await run("skills_load", { name: "debugging" });
		expect(initial.result.isError).not.toBe(true);
		const before = initial.json();
		expect(initial.system).not.toContain("## Workflow");
		// ADR 0037: user-requested skills are published right away, without an extra confirmation.
		expect(initial.system).toContain("call skills_publish on the resulting proposal right away, with no extra confirmation");
		const listed = await run("skills_list", {});
		expect(listed.json().skills.map((skill: { name: string }) => skill.name)).toContain("debugging");
		const proposed = await run("skills_propose", {
			name: "debugging", description: "Reviewed debugging instructions", body: "# Changed instructions\nRead references/guide.txt.",
			files: { "references/guide.txt": "preserved reference" }, expected_generation: before.generation, request_id: "proposal-edit",
		});
		expect(proposed.result.isError).not.toBe(true);
		const { proposalId } = proposed.json();
		expect((await bot.skills.load("debugging", undefined, context)).version).toBe(before.version);
		const diff = await run("skills_diff", { proposal_id: proposalId });
		expect(diff.text).toContain("Changed instructions");
		expect(diff.json().status).toBe("approved");
		expect(diff.json().approval.actor).toBe("system:auto");
		const unproven = await run("skills_publish", { proposal_id: proposalId, request_id: "publish-unproven", evidence: { kind: "instruction", quote: "nobody said this" } });
		expect(unproven.result.isError).toBe(true);
		expect(unproven.text).toContain("Insufficient evidence");
		const unrelated = await run("skills_publish", { proposal_id: proposalId, request_id: "publish-unrelated", evidence: { kind: "instruction", quote: "use skill tool" } });
		expect(unrelated.result.isError).toBe(true);
		expect(unrelated.text).toContain('does not mention skill "debugging"');
		const fake = await run("skills_publish", { proposal_id: proposalId, request_id: "publish-fake", evidence: { kind: "receipts", ids: ["attempt-that-does-not-exist"] } });
		expect(fake.result.isError).toBe(true);
		expect(fake.text).toContain("unknown receipt");
		expect((await bot.skills.load("debugging", undefined, context)).version).toBe(before.version);
		const published = await run("skills_publish", { proposal_id: proposalId, request_id: "publish-edit", evidence: directed("debugging").evidence }, undefined, directed("debugging").text);
		expect(published.result.isError).not.toBe(true);
		const active = published.json();
		expect(active.generation).toBe(before.generation + 1);
		const read = await run("skills_read_file", { name: "debugging", version: active.version, path: "references/guide.txt" });
		expect(read.result.isError).toBe(true);
		expect((await run("skills_load", { name: "debugging" })).json().version).toBe(before.version);
		expect((await run("skills_inspect", { name: "debugging", version: active.version })).json().files["references/guide.txt"]).toBe("preserved reference");
		expect((await run("skills_history", { name: "debugging" })).text).toContain(active.version);
		const restored = await run("skills_restore", { name: "debugging", version: before.version, expected_generation: active.generation, request_id: "restore-edit" });
		expect(restored.result.isError).not.toBe(true);
		await run("skills_publish", { proposal_id: restored.json().proposalId, request_id: "publish-restore", evidence: directed("debugging").evidence }, undefined, directed("debugging").text);
		const history = (await bot.skills.history("debugging", context)).at(-1)!;
		expect(history.evidence).toMatchObject({ kind: "instruction", userId: "not-an-approver" });
		expect(history.evidence!.kind === "instruction" && typeof history.evidence!.entryId).toBe("number");
		expect((await bot.skills.load("debugging", undefined, context)).body).toBe(before.body);
		expect((await bot.skills.load("debugging", undefined, context)).generation).toBe(active.generation + 1);
		expect(await bot.skills.readFile("debugging", active.version, "references/guide.txt", context)).toBe("preserved reference");
		const replay = await run("skills_publish", { proposal_id: proposalId, request_id: "publish-edit", evidence: directed("debugging").evidence });
		expect(replay.json()).toEqual(active);
		expect((await bot.skills.load("debugging", undefined, context)).body).toBe(before.body);
		if (mode === "codemode-only") {
			for (const name of SKILL_TOOL_NAMES) expect(offered.has(name)).toBe(false);
			expect((await run("skills_list", {}, true)).result.isError).toBe(true);
		} else for (const name of SKILL_TOOL_NAMES) expect(offered.has(name)).toBe(true);
		expect(offered.has("skills_approve")).toBe(false);
		if (mode !== "direct") {
			const taskId = (published.result.details as { codemodeTaskId: number }).codemodeTaskId;
			const receipt = await bot.harness.snapshot(CellDoc, conversation.id, String(taskId), context);
			expect(receipt?.calls.some((call) => call.name === "skills_publish" && call.status === "done")).toBe(true);
		}
		const created = await run("skills_propose", {
			name: "new-skill", description: "Agent-created skill", body: "New reusable instructions",
			files: {}, expected_generation: 0, request_id: "create-new",
		});
		expect(created.result.isError).not.toBe(true);
		// A human request that does not name the skill still installs it: evidence is optional (ADR 0037).
		const creation = await run("skills_publish", { proposal_id: created.json().proposalId, request_id: "publish-new" }, undefined, "설치해주세요");
		expect(creation.result.isError).not.toBe(true);
		expect((await bot.skills.history("new-skill", context)).at(-1)!.evidence).toBeUndefined();
		expect((await run("skills_load", { name: "new-skill" })).result.isError).toBe(true);
		expect((await run("skills_inspect", { name: "new-skill" })).json()).toMatchObject({
			body: "New reusable instructions", source: "agent", generation: 1,
		});
	});
}

test("active skills, pending proposals and pinned references survive SQLite restart", async () => {
	const first = await setup("direct");
	const before = await first.bot.skills.load("optimization", undefined, context);
	const proposal = await first.bot.skills.propose({ name: before.name, description: "Changed summary", body: "Persistent custom optimizer", files: { "guide.txt": "persistent file" }, expectedGeneration: before.generation, requestId: "persist-proposal" }, "owner", context);
	const active = await first.bot.skills.publish({ proposalId: proposal.proposalId, requestId: "persist-publish" }, "owner", context);
	const pending = await first.bot.skills.restore({ name: before.name, version: before.version, expectedGeneration: active.generation, requestId: "persist-restore" }, "owner", context);
	await first.bot.close(context); bots.splice(bots.indexOf(first.bot), 1);
	const second = await setup("direct", first.dir);
	expect((await second.bot.skills.load(before.name, undefined, context)).body).toBe("Persistent custom optimizer");
	expect(await second.bot.skills.readFile(before.name, active.version, "guide.txt", context)).toBe("persistent file");
	expect(JSON.stringify(await second.bot.skills.pending(context))).toContain(pending.proposalId);
	const loaded = await second.run("skills_load", { name: before.name });
	expect(loaded.json().version).toBe(before.version);
	const next = await second.bot.conversation("test", "new-pinned-session", context);
	expect((await second.bot.skills.executionLoad({ conversationId: next.id, name: before.name }, context)).version).toBe(active.version);
});

test.each(["prepared", "committed"] as const)("SIGKILL at %s preserves atomic skill state and retry receipts", async (phase) => {
	const first = await setup("direct");
	const before = await first.bot.skills.load("debugging", undefined, context);
	const proposal = await first.bot.skills.propose({
		name: before.name, description: "Crash-safe version", body: "Complete new package",
		files: { "proof.txt": "complete companion" }, expectedGeneration: before.generation, requestId: "crash-propose",
	}, "crash-test", context);
	await first.bot.close(context); bots.splice(bots.indexOf(first.bot), 1);
	let command = [process.execPath, new URL("./fixtures/skill-crash.ts", import.meta.url).pathname];
	if (phase === "committed") {
		const binary = join(first.dir, "compiled-skill-crash");
		const build = Bun.spawn([process.execPath, "build", "--compile", command[1]!, "--outfile", binary], { stdout: "pipe", stderr: "pipe" });
		const error = await new Response(build.stderr).text();
		expect(await build.exited, error).toBe(0);
		command = [binary];
	}
	const child = Bun.spawn([...command, join(first.dir, "bot.sqlite"), proposal.proposalId, phase], { cwd: first.dir, stdout: "pipe", stderr: "pipe" });
	const reader = child.stdout.getReader();
	const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
	try {
		let output = "";
		while (!output.includes(phase)) {
			const next = await reader.read();
			if (next.done) throw new Error(`Child exited before ${phase}: ${await new Response(child.stderr).text()}`);
			output += new TextDecoder().decode(next.value);
		}
		child.kill("SIGKILL");
		await child.exited;
	} finally {
		clearTimeout(timer);
		child.kill("SIGKILL");
		reader.releaseLock();
	}
	const second = await setup("direct", first.dir);
	const recovered = await second.bot.skills.load(before.name, undefined, context);
	expect(recovered.generation).toBe(before.generation + (phase === "committed" ? 1 : 0));
	expect(recovered.body).toBe(phase === "committed" ? "Complete new package" : before.body);
	const retried = await second.bot.skills.publish({ proposalId: proposal.proposalId, requestId: "crash-publish" }, "crash-test", context);
	expect(retried.generation).toBe(before.generation + 1);
	expect(await second.bot.skills.readFile(before.name, retried.version, "proof.txt", context)).toBe("complete companion");
	expect((await second.bot.skills.load(before.name, before.version, context)).body).toBe(before.body);
}, 15000);
