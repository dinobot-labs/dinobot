import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { type FauxResponseFactory, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { type Conversation, type EntryRecord, type JsonObject, MemoryStorage, type Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openBot, type Bot } from "../src/core/bot.ts";
import { AgreementsDoc, addAgreement } from "../src/core/memory/agreements.ts";
import { DISABLED_MEMORY, type MemoryConfig } from "../src/core/memory/config.ts";
import { RETRO_MARKER, RetroDoc } from "../src/core/memory/retro.ts";
import { createChatData, ingestEntry } from "../src/tui/state.ts";

const bots: Bot[] = [];
const dirs: string[] = [];
afterEach(async () => {
	for (const bot of bots.splice(0)) await bot.close(context);
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function directory() {
	const dir = await realpath(await mkdtemp(join(tmpdir(), "dinobot-retro-")));
	dirs.push(dir);
	return dir;
}

const RETRO: MemoryConfig = {
	auto: { ...DISABLED_MEMORY.auto },
	recall: { ...DISABLED_MEMORY.recall },
	retro: { ...DISABLED_MEMORY.retro, enabled: true, everyTurns: 2, maxRetries: 1, leaseMs: 60_000, timeoutMs: 5_000, idleMs: 60 * 60_000 },
};
const add = (text: string, kind = "preference", scope = "project") => JSON.stringify({ agreements: [{ op: "add", kind, scope, text }] });

type Setup = { memory?: MemoryConfig; retro?: (prompt: string) => string | Promise<string>; main?: FauxResponseFactory; storage?: Storage; workspace?: string };

async function start(setup: Setup = {}) {
	const workspace = setup.workspace ?? await directory();
	const faux = fauxProvider({ provider: "faux", models: [{ id: "one" }] });
	const models = createModels();
	models.setProvider(faux.provider);
	const retroPrompts: string[] = [];
	const mainRequests: string[] = [];
	const respond: FauxResponseFactory = (transcript, options, state, model) => {
		const text = JSON.stringify(transcript);
		if (text.includes(RETRO_MARKER)) {
			const prompt = String((transcript as { messages: { content: unknown }[] }).messages.at(-1)?.content ?? "");
			retroPrompts.push(prompt);
			return Promise.resolve(setup.retro ? setup.retro(prompt) : "{\"agreements\":[]}").then((reply) => fauxAssistantMessage(reply));
		}
		mainRequests.push(text);
		return setup.main ? setup.main(transcript, options, state, model) : fauxAssistantMessage("ok");
	};
	faux.setResponses(Array.from({ length: 200 }, () => respond));
	const bot = await openBot({
		storage: setup.storage ?? new MemoryStorage(), models, defaultModel: { provider: "faux", modelId: "one" },
		toolMode: "direct", plugins: [], workspaceRoot: workspace, memory: setup.memory ?? RETRO,
	}, context);
	bots.push(bot);
	let messageId = 0;
	const instance = crypto.randomUUID();
	const say = (text: string, thread = "T1") => bot.handle({ channel: "test", threadKey: thread, messageId: `${instance}-${++messageId}`, userId: "roach", text }, context);
	return { bot, workspace, retroPrompts, mainRequests, say };
}

async function until<T>(read: () => Promise<T> | T, done: (value: T) => boolean, label: string): Promise<T> {
	const deadline = Date.now() + 5_000;
	for (;;) {
		const value = await read();
		if (done(value)) return value;
		if (Date.now() > deadline) throw new Error(`timed out: ${label}: ${JSON.stringify(value)}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}
async function entries(conversation: Conversation): Promise<EntryRecord[]> {
	return [...(await conversation.entries({}, 500, undefined, context)).items].sort((a, b) => a.id - b.id);
}
const ledger = (bot: Bot) => bot.harness.snapshot(AgreementsDoc, context);

test("turns trigger: every K turns a retrospective adds agreements that every later request carries", async () => {
	const { bot, workspace, retroPrompts, mainRequests, say } = await start({
		retro: (prompt) => prompt.includes("show me the diff") ? add("Show the diff and wait for approval before committing.") : "{\"agreements\":[]}",
	});
	await say("Commit the fix.");
	expect(retroPrompts).toHaveLength(0);
	await say("No, show me the diff first and wait for my OK.");
	const state = await until(() => ledger(bot), (value) => (value?.items.length ?? 0) === 1, "first retro");
	expect(state!.items[0]).toMatchObject({ scope: "project", project: workspace, kind: "preference", origin: "retro", status: "active", evidence: [{ turn: 2 }] });
	expect(retroPrompts[0]).toContain("Current agreements:\n(none)");
	expect(retroPrompts[0]).toContain("Harness record:\n(no work activity)");
	expect(retroPrompts[0]).toContain("Commit the fix.");
	// Layered evidence (evidence.ts) reaches the real retro call: overview, findings, labelled raw messages.
	expect(retroPrompts[0]).toMatch(/Evidence overview:\nuser turns 2; /);
	expect(retroPrompts[0]).toContain("Findings (refs point to labelled lines below):\n(none)");
	expect(retroPrompts[0]).toMatch(/\[e\d+\] user: <from[^\n]*\nCommit the fix\./);
	expect(mainRequests.some((request) => request.includes("Show the diff and wait"))).toBe(false);
	await say("Now the next change.");
	// The section reaches the next request as a system patch; earlier requests stay unchanged.
	expect(mainRequests.at(-1)).toContain("Show the diff and wait for approval before committing.");
	expect(mainRequests.at(-1)).toContain("working_agreements");
	// Another thread in the same repository gets it in its first request; the TUI says when it took effect.
	await say("Hello", "T2");
	expect(mainRequests.at(-1)).toContain("Show the diff and wait for approval before committing.");
	const data = createChatData();
	for (const entry of await entries(await bot.conversation("test", "T1", context))) ingestEntry(data, entry, Date.now());
	expect(JSON.stringify(data.blocks)).toContain("Working agreements: 1 in effect");
	// The next window sees the agreement and the overlap turn, and reports a violation instead of a duplicate.
	await say("You committed without the diff again!");
	await until(() => retroPrompts.length, (count) => count === 2, "second retro");
	expect(retroPrompts[1]).toContain(`[${state!.items[0]!.id}] preference, project: Show the diff`);
	expect(retroPrompts[1]).toContain("Now the next change.");
	expect(retroPrompts[1]).not.toContain("Commit the fix.");
	const conversation = await bot.conversation("test", "T1", context);
	const retro = await bot.harness.snapshot(RetroDoc, conversation.id, context);
	expect(retro?.receipts.map((receipt) => [receipt.outcome, receipt.from, receipt.to])).toEqual([["committed", 0, 2], ["committed", 2, 4]]);
});

test("outcome trigger: work_finish through the bot is reviewed with its Harness record when the input ends", async () => {
	const workspace = await directory();
	await writeFile(join(workspace, "package.json"), "{\"name\":\"fixture\",\"scripts\":{\"typecheck\":\"true\"}}\n");
	const main: FauxResponseFactory = (transcript) => {
		const last = (transcript as { messages: { role: string; toolName?: string; content: unknown }[] }).messages.at(-1)!;
		if (last.role !== "toolResult") return fauxAssistantMessage(fauxToolCall("work_plan", { op: "describe" }), { stopReason: "toolUse" });
		const body = JSON.parse((last.content as { text: string }[])[0]!.text) as Record<string, unknown>;
		if (body.example) return fauxAssistantMessage(fauxToolCall("work_plan", { ...(body.example as JsonObject), op: "register" }), { stopReason: "toolUse" });
		if (typeof body.workId === "string" && body.status !== "blocked") {
			return fauxAssistantMessage(fauxToolCall("work_finish", { workId: body.workId, outcome: "blocked", reason: "typecheck needs bun install first" }), { stopReason: "toolUse" });
		}
		return fauxAssistantMessage("blocked");
	};
	const { bot, retroPrompts } = await start({
		workspace, main, memory: { ...RETRO, retro: { ...RETRO.retro, everyTurns: 100 } },
		retro: () => add("Run bun install before typechecking a fresh checkout.", "lesson"),
	});
	const reply = await bot.handle({ channel: "test", threadKey: "T1", messageId: "m1", userId: "roach", text: "Typecheck the project." }, context);
	expect(reply).toMatchObject({ status: "answered", text: "blocked" });
	const state = await until(() => ledger(bot), (value) => (value?.items.length ?? 0) === 1, "outcome retro");
	expect(state!.items[0]).toMatchObject({ kind: "lesson", text: "Run bun install before typechecking a fresh checkout." });
	expect(retroPrompts).toHaveLength(1);
	expect(retroPrompts[0]).toContain("\"state\":\"blocked\"");
	expect(retroPrompts[0]).toContain("typecheck needs bun install first");
	// The blocked work becomes a finding that cites its labelled Harness line.
	expect(retroPrompts[0]).toMatch(/- harness: work \S+ ended blocked [^\n]*\[h\d+\]/);
	expect(retroPrompts[0]).toMatch(/Harness record:\n\[h1\] /);
	const conversation = await bot.conversation("test", "T1", context);
	expect(await bot.harness.snapshot(RetroDoc, conversation.id, context)).toMatchObject({ outcomes: 0, claimedOutcomes: 0 });
});

test("idle trigger: a thread with two unreviewed turns is reviewed after idleMs; one plain turn is not", async () => {
	const { bot, retroPrompts, say } = await start({
		memory: { ...RETRO, retro: { ...RETRO.retro, everyTurns: 100, idleMs: 40 } },
		retro: () => add("Keep answers short.", "preference", "team"),
	});
	await say("hi");
	await new Promise((resolve) => setTimeout(resolve, 200));
	await bot.memoryRetro.settled();
	expect(retroPrompts).toHaveLength(0);
	await say("explain less, please");
	const state = await until(() => ledger(bot), (value) => (value?.items.length ?? 0) === 1, "idle retro");
	expect(state!.items[0]).toMatchObject({ scope: "team", text: "Keep answers short." });
	expect(state!.items[0]!.project).toBeUndefined();
	expect(retroPrompts).toHaveLength(1);
});

test("failure: an unparsable review retries at the next input, then skips; nothing is stored", async () => {
	const { bot, retroPrompts, say } = await start({ retro: () => "not json" });
	await say("one");
	await say("two");
	await until(() => retroPrompts.length, (count) => count === 1, "first attempt");
	await bot.memoryRetro.settled();
	const conversation = await bot.conversation("test", "T1", context);
	await until(() => bot.harness.snapshot(RetroDoc, conversation.id, context), (value) => value?.window.attempt === 1 && value.window.state === "idle", "retry pending");
	await say("three");
	const retro = await until(() => bot.harness.snapshot(RetroDoc, conversation.id, context), (value) => value?.window.state === "skipped", "skipped");
	expect(retroPrompts).toHaveLength(2);
	expect(retro?.receipts.map((receipt) => [receipt.outcome, receipt.from, receipt.to])).toEqual([["skipped", 0, 2]]);
	expect((await ledger(bot))?.items ?? []).toEqual([]);
});

test("full scope: the retrospective merges overlapping retro items first, then the new lesson fits; a person's item stays", async () => {
	const workspace = await directory();
	const memory: MemoryConfig = { ...RETRO, retro: { ...RETRO.retro, maxActivePerProject: 3 } };
	const ids: Record<string, string> = {};
	const { bot, retroPrompts, say } = await start({
		workspace, memory,
		retro: (prompt) => {
			for (const line of prompt.split("\n")) {
				const match = line.match(/^- \[([0-9a-f]{16})\] [^:]+: (.*)$/);
				if (match) ids[match[2]!] = match[1]!;
			}
			return JSON.stringify({ agreements: [
				{ op: "add", kind: "lesson", scope: "project", text: "Read the ADR before changing memory code." },
				{ op: "merge", ids: [ids["Run bun test before pushing."], ids["Run typecheck before pushing."]], text: "Run bun run typecheck and bun test before pushing." },
				{ op: "merge", ids: [ids["Reply in Korean."], ids["Run bun test before pushing."]], text: "Must not apply." },
			] });
		},
	});
	await bot.harness.commit(async (tx) => {
		const draft = await tx.doc(AgreementsDoc);
		const base = { kind: "lesson" as const, scope: "project" as const, project: workspace, now: 1 };
		addAgreement(draft, { ...base, text: "Run bun test before pushing.", origin: "retro" }, memory.retro);
		addAgreement(draft, { ...base, text: "Run typecheck before pushing.", origin: "retro" }, memory.retro);
		addAgreement(draft, { ...base, kind: "preference", text: "Reply in Korean.", origin: "human" }, memory.retro);
	}, context);
	await say("I changed the curator without reading the ADR.");
	await say("Next time read it first.");
	const state = await until(() => ledger(bot), (value) => value?.items.some((item) => item.text.startsWith("Read the ADR")) ?? false, "merged then added");
	expect(retroPrompts[0]).toContain("Capacity: project 3 of 3 (full), team 0 of 10.");
	expect(state!.items.map((item) => [item.text, item.origin])).toEqual([
		["Reply in Korean.", "human"],
		["Run bun run typecheck and bun test before pushing.", "retro"],
		["Read the ADR before changing memory code.", "retro"],
	]);
});

test("tools: a person's agreement applies without retrospectives and stays owned by a person", async () => {
	const calls: { name: string; args: JsonObject }[] = [];
	const results: unknown[] = [];
	const { bot, mainRequests } = await start({
		memory: DISABLED_MEMORY,
		main: (transcript) => {
			// A changed section arrives as a system patch after the tool result.
			const last = (transcript as { messages: { role: string; content: unknown }[] }).messages.filter((message) => message.role !== "system").at(-1)!;
			if (last.role === "toolResult") {
				results.push(JSON.parse((last.content as { text: string }[])[0]!.text));
				return fauxAssistantMessage("done");
			}
			const call = calls.shift();
			return call ? fauxAssistantMessage(fauxToolCall(call.name, call.args), { stopReason: "toolUse" }) : fauxAssistantMessage("done");
		},
	});
	const run = async (name: string, args: JsonObject) => {
		calls.push({ name, args });
		await bot.handle({ channel: "test", threadKey: "T1", messageId: crypto.randomUUID(), userId: "roach", text: "go" }, context);
		return results.at(-1) as Record<string, unknown>;
	};
	const written = await run("agreements_write", { text: "Reply in Korean." });
	expect(written).toMatchObject({ status: "added" });
	expect((await run("agreements_list", {})).agreements).toMatchObject([{ id: written.id, kind: "preference", scope: "project", origin: "human", text: "Reply in Korean." }]);
	expect(mainRequests.at(-1)).toContain(`[${written.id}] Reply in Korean. (project)`);
	expect(await run("agreements_write", { id: written.id as string, text: "Reply in Korean, code in English." })).toMatchObject({ status: "updated" });
	expect(await run("agreements_delete", { id: written.id as string })).toEqual({ id: written.id, deleted: true });
	expect(await ledger(bot)).toMatchObject({ items: [], forgotten: [written.id] });
	const conversation = await bot.conversation("test", "T1", context);
	expect(await bot.harness.snapshot(RetroDoc, conversation.id, context)).toBeUndefined();
});

test("restart: a review interrupted by a restart resumes under its token and settles exactly once", async () => {
	const workspace = await directory();
	const path = join(workspace, ".state.sqlite");
	let calls = 0;
	const started = Promise.withResolvers<void>();
	const first = await start({ workspace, storage: await openNodeSqliteStorage(path), retro: () => { calls++; started.resolve(); return new Promise<string>(() => {}); } });
	await first.say("Use the staging database for tests.");
	await first.say("Never the production one.");
	await started.promise;
	await first.bot.close(context);
	bots.splice(bots.indexOf(first.bot), 1);
	const second = await start({ workspace, storage: await openNodeSqliteStorage(path), retro: () => add("Point tests at the staging database, never production.", "lesson") });
	const state = await until(() => ledger(second.bot), (value) => (value?.items.length ?? 0) === 1, "resumed review");
	expect(state!.items[0]).toMatchObject({ text: "Point tests at the staging database, never production.", project: workspace });
	const conversation = await second.bot.conversation("test", "T1", context);
	const retro = await second.bot.harness.snapshot(RetroDoc, conversation.id, context);
	expect(retro?.receipts.map((receipt) => [receipt.window, receipt.outcome])).toEqual([[1, "committed"]]);
	expect(retro?.window).toMatchObject({ window: 1, token: 1, cursorTurn: 2, state: "committed" });
	expect(calls).toBe(1);
	expect(second.retroPrompts).toHaveLength(1);
});

test("adoption: enabling retrospectives on an existing thread does not review its history", async () => {
	const workspace = await directory();
	const path = join(workspace, ".state.sqlite");
	const before = await start({ workspace, storage: await openNodeSqliteStorage(path), memory: DISABLED_MEMORY });
	for (const text of ["old one", "old two", "old three"]) await before.say(text);
	await before.bot.close(context);
	bots.splice(bots.indexOf(before.bot), 1);
	const after = await start({ workspace, storage: await openNodeSqliteStorage(path), retro: () => "{\"agreements\":[]}" });
	// The startup pass adopts the three old turns; the first window is the next K = 2 turns.
	for (const text of ["new one", "new two"]) await after.say(text);
	await until(() => after.retroPrompts.length, (count) => count === 1, "first review after enable");
	expect(after.retroPrompts[0]).toContain("new one");
	expect(after.retroPrompts[0]).toContain("new two");
	expect(after.retroPrompts[0]).not.toContain("old one");
});
