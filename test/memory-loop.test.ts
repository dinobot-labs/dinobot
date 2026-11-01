import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { type FauxResponseFactory, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { type Conversation, type EntryRecord, type JsonObject, MemoryStorage, type Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openBot, type Bot } from "../src/core/bot.ts";
import { DISABLED_MEMORY, type MemoryConfig } from "../src/core/memory/config.ts";
import { CURATOR_MARKER } from "../src/core/memory/curator.ts";
import { createMemoryRecall, NOTE_PREFIX } from "../src/core/memory/recall.ts";
import { addAuto, MemoryDoc, mutate } from "../src/core/memory/store.ts";
import { CuratorDoc } from "../src/core/memory/window.ts";
import { entryText } from "../src/core/search.ts";
import { MEMORY_NOTE_KIND } from "../src/core/ui-contract.ts";
import { createChatData, ingestEntry } from "../src/tui/state.ts";

const bots: Bot[] = [];
const dirs: string[] = [];
afterEach(async () => {
	for (const bot of bots.splice(0)) await bot.close(context);
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function directory() {
	const dir = await realpath(await mkdtemp(join(tmpdir(), "dinobot-memory-")));
	dirs.push(dir);
	return dir;
}

const ENABLED: MemoryConfig = {
	auto: { enabled: true, everyTurns: 2, maxRetries: 1, leaseMs: 60_000, timeoutMs: 5_000, maxPerProject: 50 },
	recall: { enabled: true, maxItems: 3, budgetChars: 1200 },
	retro: { ...DISABLED_MEMORY.retro },
};

type Setup = { memory?: MemoryConfig | "omit"; curator?: (prompt: string) => string | Promise<string>; main?: FauxResponseFactory; storage?: Storage; workspace?: string; toolMode?: "direct" | "codemode-only" };

async function start(setup: Setup = {}) {
	const workspace = setup.workspace ?? await directory();
	const faux = fauxProvider({ provider: "faux", models: [{ id: "one" }] });
	const models = createModels();
	models.setProvider(faux.provider);
	const curatorPrompts: string[] = [];
	const mainRequests: string[] = [];
	const respond: FauxResponseFactory = (transcript, options, state, model) => {
		const text = JSON.stringify(transcript);
		if (text.includes(CURATOR_MARKER)) {
			const prompt = String((transcript as { messages: { content: unknown }[] }).messages.at(-1)?.content ?? "");
			curatorPrompts.push(prompt);
			return Promise.resolve(setup.curator ? setup.curator(prompt) : "{\"memories\":[]}").then((reply) => fauxAssistantMessage(reply));
		}
		mainRequests.push(text);
		return setup.main ? setup.main(transcript, options, state, model) : fauxAssistantMessage("ok");
	};
	faux.setResponses(Array.from({ length: 200 }, () => respond));
	const bot = await openBot({
		storage: setup.storage ?? new MemoryStorage(), models, defaultModel: { provider: "faux", modelId: "one" },
		toolMode: setup.toolMode ?? "direct", plugins: [], workspaceRoot: workspace,
		...(setup.memory === "omit" ? {} : { memory: setup.memory ?? ENABLED }),
	}, context);
	bots.push(bot);
	let messageId = 0;
	const instance = crypto.randomUUID();
	const say = (text: string, thread = "T1") => bot.handle({ channel: "test", threadKey: thread, messageId: `${instance}-${++messageId}`, userId: "roach", text }, context);
	return { bot, workspace, curatorPrompts, mainRequests, say };
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, label: string): Promise<T> {
	const deadline = Date.now() + 3_000;
	for (;;) {
		const value = await read();
		if (done(value)) return value;
		if (Date.now() > deadline) throw new Error(`timed out: ${label}: ${JSON.stringify(value)}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

async function entries(conversation: Conversation): Promise<EntryRecord[]> {
	const page = await conversation.entries({}, 200, undefined, context);
	return [...page.items].sort((a, b) => a.id - b.id);
}

const memory = (bot: Bot) => bot.harness.snapshot(MemoryDoc, context);

test("tools: project scope is per repository, team scope is shared, list and search cover both and label them", async () => {
	const workspace = await directory();
	const other = await directory();
	const calls: Record<string, unknown>[] = [];
	const { bot } = await start({
		workspace, memory: DISABLED_MEMORY,
		main: (transcript) => {
			const last = (transcript as { messages: { role: string }[] }).messages.at(-1)!;
			if (last.role === "toolResult") return fauxAssistantMessage("done");
			const call = calls.shift();
			return call ? fauxAssistantMessage(fauxToolCall(String(call.name), call.args as JsonObject), { stopReason: "toolUse" }) : fauxAssistantMessage("done");
		},
	});
	const run = async (thread: string, cwd: string, name: string, args: Record<string, unknown>) => {
		const conversation = await bot.conversation("test", thread, context, cwd);
		calls.push({ name, args });
		await (await conversation.submit({ type: "input", content: "go" }, context)).wait(context);
		const result = (await conversation.context(context)).messages.filter((message) => message.role === "toolResult").at(-1)!;
		return JSON.parse((result.content[0] as { text: string }).text);
	};
	expect(await run("a", workspace, "memory_write", { key: "runtime", content: "Bun 1.4 in repo A", scope: "project" })).toMatchObject({ key: "runtime", scope: "project" });
	expect(await run("a", workspace, "memory_write", { key: "runtime", content: "team default: Bun" })).toMatchObject({ scope: "team" });
	expect(await run("a", workspace, "memory_read", { key: "runtime", scope: "project" })).toMatchObject({ found: true, content: "Bun 1.4 in repo A", scope: "project" });
	expect(await run("b", other, "memory_read", { key: "runtime", scope: "project" })).toMatchObject({ found: false, scope: "project" });
	expect(await run("b", other, "memory_read", { key: "runtime" })).toMatchObject({ found: true, content: "team default: Bun", scope: "team" });
	const listA = await run("a", workspace, "memory_list", {});
	expect(listA.entries).toEqual([{ key: "runtime", revision: 2, scope: "team" }, { key: "runtime", revision: 1, scope: "project" }]);
	expect((await run("b", other, "memory_list", {})).entries).toEqual([{ key: "runtime", revision: 2, scope: "team" }]);
	expect((await run("a", workspace, "memory_search", { query: "repo a", scope: "project" })).entries).toMatchObject([{ key: "runtime", scope: "project" }]);
	expect(await run("a", workspace, "memory_delete", { key: "runtime", scope: "project", expected_revision: 1 })).toMatchObject({ deleted: true, scope: "project" });
	expect((await memory(bot))?.entries.map((entry) => [entry.key, entry.project ?? "team"])).toEqual([["runtime", "team"]]);
	// auto/ keys exist only in project scope, so reads and deletes without scope address the project entry.
	const { key } = await bot.harness.commit(async (tx) => addAuto(await tx.doc(MemoryDoc), workspace, "Extracted fact.", 50), context);
	expect(await run("a", workspace, "memory_read", { key })).toMatchObject({ found: true, scope: "project", origin: "auto" });
	const written = await run("a", workspace, "memory_write", { key: "stamped", content: "x", scope: "project" });
	const stamped = await run("a", workspace, "memory_read", { key: "stamped", scope: "project" });
	expect(stamped).toMatchObject({ found: true, revision: written.revision });
	expect(Date.parse(stamped.createdAt)).toBeGreaterThan(Date.UTC(2026, 0, 1));
	expect(stamped.updatedAt).toBe(stamped.createdAt);
	expect(await run("a", workspace, "memory_delete", { key: "stamped", scope: "project" })).toMatchObject({ deleted: true });
	expect(await run("a", workspace, "memory_delete", { key })).toMatchObject({ deleted: true, scope: "project" });
	expect((await memory(bot))?.forgotten?.[workspace]).toEqual([key]);
});

test("migration aliases reach real memory tools and agreement sections in resumed and new conversations", async () => {
	const base = await directory();
	const old = join(base, "old"), moved = join(base, "moved"), sibling = join(base, "moved-sibling");
	await mkdir(old);
	await mkdir(sibling);
	const databasePath = join(base, "migration.sqlite");
	const storage = await openNodeSqliteStorage(databasePath);
	const calls: { name: string; args: JsonObject }[] = [];
	const main: FauxResponseFactory = (transcript) => {
		const last = (transcript as { messages: { role: string }[] }).messages.at(-1)!;
		if (last.role === "toolResult") return fauxAssistantMessage("done");
		const call = calls.shift();
		return call ? fauxAssistantMessage(fauxToolCall(call.name, call.args), { stopReason: "toolUse" }) : fauxAssistantMessage("done");
	};
	const run = async (bot: Bot, thread: string, cwd: string, name: string, args: JsonObject) => {
		const conversation = await bot.conversation("test", thread, context, cwd);
		calls.push({ name, args });
		await (await conversation.submit({ type: "input", content: "go" }, context)).wait(context);
		const result = (await conversation.context(context)).messages.filter((message) => message.role === "toolResult").at(-1)!;
		return JSON.parse((result.content[0] as { text: string }).text);
	};
	const first = await start({ workspace: base, storage, main, memory: DISABLED_MEMORY });
	expect(await run(first.bot, "existing", old, "memory_write", { key: "migration", content: "original", scope: "project" })).toMatchObject({ scope: "project" });
	await run(first.bot, "existing", old, "agreements_write", { text: "Keep historical project identity.", scope: "project" });
	await first.bot.close(context);
	bots.splice(bots.indexOf(first.bot), 1);
	await rename(old, moved);
	await symlink(moved, old, process.platform === "win32" ? "junction" : "dir");
	const next = await start({ workspace: base, storage: await openNodeSqliteStorage(databasePath), main, memory: { ...DISABLED_MEMORY, projectAliases: [{ path: moved, identity: old }] } });
	for (const [thread, cwd] of [["existing", old], ["new", moved]] as const) {
		expect(await run(next.bot, thread, cwd, "memory_read", { key: "migration", scope: "project" })).toMatchObject({ found: true, content: "original" });
		expect(JSON.stringify(await run(next.bot, thread, cwd, "agreements_list", {}))).toContain("Keep historical project identity.");
	}
	expect(next.mainRequests.some((request) => request.includes("Keep historical project identity."))).toBe(true);
	expect(await run(next.bot, "other", sibling, "memory_read", { key: "migration", scope: "project" })).toMatchObject({ found: false });
	expect(JSON.stringify(await run(next.bot, "other", sibling, "agreements_list", {}))).not.toContain("Keep historical project identity.");
});

test("curator: every N user turns the window is extracted into project memory with content keys", async () => {
	const { bot, workspace, curatorPrompts, say } = await start({
		curator: (prompt) => prompt.includes("We deploy with")
			? JSON.stringify({ memories: [{ text: "The team deploys with GitHub Actions." }, { text: "Tests run with bun test." }] })
			: JSON.stringify({ memories: [{ text: "Tests run with   BUN TEST." }, { text: "Releases are tagged vX.Y.Z." }] }),
	});
	await say("We deploy with GitHub Actions.");
	expect(curatorPrompts).toHaveLength(0);
	await say("And tests run with bun test.");
	const first = await until(() => memory(bot), (state) => (state?.entries.length ?? 0) === 2, "first window");
	expect(first!.entries.every((entry) => entry.project === workspace && entry.origin === "auto" && entry.key.startsWith("auto/"))).toBe(true);
	expect(curatorPrompts[0]).toContain("We deploy with GitHub Actions.");
	expect(curatorPrompts[0]).not.toContain("Known memories");
	await say("Releases get tags.");
	await say("Tags look like v1.2.3.");
	const second = await until(() => memory(bot), (state) => (state?.entries.length ?? 0) === 3, "second window");
	// "Tests run with   BUN TEST." normalizes to the existing memory: no duplicate.
	expect(second!.entries.map((entry) => entry.content).sort()).toEqual(["Releases are tagged vX.Y.Z.", "Tests run with bun test.", "The team deploys with GitHub Actions."]);
	expect(curatorPrompts[1]).toContain("Known memories:\n- ");
	expect(curatorPrompts[1]).toContain("Tags look like v1.2.3.");
	const conversation = await bot.conversation("test", "T1", context);
	const state = await bot.harness.snapshot(CuratorDoc, conversation.id, context);
	expect(state?.window).toMatchObject({ window: 2, cursorTurn: 4, state: "committed" });
	expect(state?.receipts.map((receipt) => [receipt.outcome, receipt.from, receipt.to, receipt.keys.length])).toEqual([["committed", 0, 2, 2], ["committed", 2, 4, 2]]);
});

test("curator: a contradicting extraction supersedes the old automatic memory with provenance; a person's memory is protected", async () => {
	const { bot, workspace, curatorPrompts, say } = await start({
		curator: (prompt) => {
			const keyOf = (text: string) => prompt.split("\n").find((line) => line.endsWith(text))?.match(/\[([^\]]+)\]/)?.[1] ?? "missing";
			return JSON.stringify({ memories: [
				{ text: "Deploys run on GitHub Actions now.", replaces: [keyOf("Deploys run on Jenkins.")] },
				{ text: "The database is MySQL.", replaces: [keyOf("The database is Postgres (owner).")] },
			] });
		},
	});
	const old = await bot.harness.commit(async (tx) => {
		const draft = await tx.doc(MemoryDoc);
		mutate(draft, "db", workspace, "The database is Postgres (owner).", 0, Date.UTC(2026, 8, 1));
		return addAuto(draft, workspace, "Deploys run on Jenkins.", 50, { now: Date.UTC(2026, 8, 2), evidence: { conversationId: 99, turn: 3 } }).key;
	}, context);
	await say("We moved deploys to GitHub Actions.");
	await say("Also we use MySQL now.");
	const state = await until(() => memory(bot), (value) => !value?.entries.some((entry) => entry.key === old), "superseded");
	expect(curatorPrompts[0]).toContain(`- [${old}] (2026-09-02) Deploys run on Jenkins.`);
	expect(curatorPrompts[0]).toContain("- [db] (2026-09-01) (written by a person) The database is Postgres (owner).");
	expect(curatorPrompts[0]).toContain("Capacity: 1 of at most 50 automatic memories.");
	const conversation = await bot.conversation("test", "T1", context);
	const fresh = state!.entries.find((entry) => entry.content === "Deploys run on GitHub Actions now.")!;
	expect(fresh).toMatchObject({ origin: "auto", project: workspace, evidence: [{ conversationId: 99, turn: 3 }, { conversationId: conversation.id, turn: 2 }] });
	expect(typeof fresh.createdAt).toBe("number");
	expect(state!.forgotten?.[workspace]).toEqual([old]);
	// The person's entry stays and the contradicting extraction is not stored.
	expect(state!.entries.map((entry) => entry.content).sort()).toEqual(["Deploys run on GitHub Actions now.", "The database is Postgres (owner)."]);
});

test("curator: a failed window waits for the next input to retry, then is skipped and the cursor still advances", async () => {
	const { bot, curatorPrompts, say } = await start({ curator: () => "not json" });
	await say("one");
	await say("two");
	const conversation = await bot.conversation("test", "T1", context);
	const retry = await until(() => bot.harness.snapshot(CuratorDoc, conversation.id, context), (value) => value?.window.state === "idle" && value.window.attempt === 1, "retry pending");
	await bot.memoryCurator.settled();
	await new Promise((resolve) => setTimeout(resolve, 100));
	// No tight retry loop: one attempt until the next input arrives.
	expect(curatorPrompts).toHaveLength(1);
	expect(retry?.window.cursorTurn).toBe(0);
	await say("three");
	const state = await until(() => bot.harness.snapshot(CuratorDoc, conversation.id, context), (value) => value?.window.state === "skipped", "skip");
	expect(state?.window).toMatchObject({ cursorTurn: 2, skipReason: "schema_mismatch", attempt: 1 });
	expect(curatorPrompts).toHaveLength(2);
	expect((await memory(bot))?.entries ?? []).toEqual([]);
});

test("curator: a retried window succeeds on the next input", async () => {
	let replies = 0;
	const { bot, say } = await start({ curator: () => replies++ === 0 ? "not json" : JSON.stringify({ memories: [{ text: "CI runs on every push." }] }) });
	await say("one");
	await say("two");
	const conversation = await bot.conversation("test", "T1", context);
	await until(() => bot.harness.snapshot(CuratorDoc, conversation.id, context), (value) => value?.window.attempt === 1, "first failure");
	await say("three");
	await until(() => memory(bot), (state) => (state?.entries.length ?? 0) === 1, "retried window");
	expect((await bot.harness.snapshot(CuratorDoc, conversation.id, context))?.receipts.map((receipt) => [receipt.window, receipt.outcome, receipt.from, receipt.to])).toEqual([[1, "committed", 0, 2]]);
});

test("curator: a store enabled later adopts existing threads without extracting their earlier turns", async () => {
	const workspace = await directory();
	const before = await start({ workspace, storage: await openNodeSqliteStorage(join(workspace, ".state.sqlite")), memory: DISABLED_MEMORY });
	for (const text of ["old one", "old two", "old three"]) await before.say(text);
	await before.bot.close(context);
	bots.splice(bots.indexOf(before.bot), 1);
	const after = await start({ workspace, storage: await openNodeSqliteStorage(join(workspace, ".state.sqlite")), curator: () => JSON.stringify({ memories: [{ text: "New fact." }] }) });
	await after.bot.memoryCurator.settled();
	const conversation = await after.bot.conversation("test", "T1", context);
	const adopted = await after.bot.harness.snapshot(CuratorDoc, conversation.id, context);
	expect(adopted?.window).toMatchObject({ cursorTurn: 3, window: 1, state: "skipped", skipReason: "adopted", floorTurn: 3 });
	expect(adopted?.receipts.map((receipt) => [receipt.outcome, receipt.from, receipt.to])).toEqual([["skipped", 0, 3]]);
	await after.say("new one");
	expect(after.curatorPrompts).toHaveLength(0);
	await after.say("new two");
	await until(() => memory(after.bot), (state) => (state?.entries.length ?? 0) === 1, "post-adoption window");
	expect(after.curatorPrompts[0]).toContain("new one");
	expect(after.curatorPrompts[0]).toContain("new two");
	// The one-turn overlap never reaches below the adoption floor.
	expect(after.curatorPrompts[0]).not.toContain("old three");
	// A thread that began after activation is not adopted: its first turns are extracted.
	await after.say("fresh a", "T2");
	await after.say("fresh b", "T2");
	await until(async () => after.curatorPrompts.length, (count) => count === 2, "new thread window");
	expect(after.curatorPrompts[1]).toContain("fresh a");
	const fresh = await after.bot.conversation("test", "T2", context);
	expect((await after.bot.harness.snapshot(CuratorDoc, fresh.id, context))?.receipts.map((receipt) => [receipt.from, receipt.to])).toEqual([[0, 2]]);
});

test("curator: turns gained while extraction was disabled are adopted when it is enabled again", async () => {
	const workspace = await directory();
	const path = join(workspace, ".state.sqlite");
	const reply = () => JSON.stringify({ memories: [{ text: "Fact from an enabled run." }] });
	const first = await start({ workspace, storage: await openNodeSqliteStorage(path), curator: reply });
	await first.say("enabled one");
	await first.say("enabled two");
	await until(() => memory(first.bot), (state) => (state?.entries.length ?? 0) === 1, "first enabled window");
	await first.bot.close(context);
	bots.splice(bots.indexOf(first.bot), 1);
	const off = await start({ workspace, storage: await openNodeSqliteStorage(path), memory: DISABLED_MEMORY, curator: reply });
	for (const text of ["disabled one", "disabled two", "disabled three", "disabled four"]) await off.say(text);
	expect(off.curatorPrompts).toHaveLength(0);
	await off.bot.close(context);
	bots.splice(bots.indexOf(off.bot), 1);
	const again = await start({ workspace, storage: await openNodeSqliteStorage(path), curator: reply });
	await again.bot.memoryCurator.settled();
	await new Promise((resolve) => setTimeout(resolve, 100));
	expect(again.curatorPrompts).toHaveLength(0);
	await again.say("back one");
	await again.say("back two");
	await until(async () => again.curatorPrompts.length, (count) => count === 1, "window after re-enable");
	expect(again.curatorPrompts[0]).toContain("back one");
	expect(again.curatorPrompts[0]).not.toContain("disabled");
	const conversation = await again.bot.conversation("test", "T1", context);
	const receipts = (await again.bot.harness.snapshot(CuratorDoc, conversation.id, context))?.receipts.map((receipt) => [receipt.outcome, receipt.from, receipt.to]);
	expect(receipts).toEqual([["committed", 0, 2], ["skipped", 2, 6], ["committed", 6, 8]]);
});

test("curator: a task interrupted by a restart resumes under its token and settles the window exactly once", async () => {
	const workspace = await directory();
	const path = join(workspace, ".state.sqlite");
	let calls = 0;
	const started = Promise.withResolvers<void>();
	// The first curator call never answers: the process "dies" while the model is busy.
	const first = await start({
		workspace, storage: await openNodeSqliteStorage(path),
		curator: () => { calls++; started.resolve(); return new Promise<string>(() => {}); },
	});
	await first.say("We release on Fridays.");
	await first.say("Only after the QA sign-off.");
	await started.promise;
	await first.bot.close(context);
	bots.splice(bots.indexOf(first.bot), 1);
	const second = await start({ workspace, storage: await openNodeSqliteStorage(path), curator: () => JSON.stringify({ memories: [{ text: "Releases happen on Fridays after QA sign-off." }] }) });
	const state = await until(() => memory(second.bot), (value) => (value?.entries.length ?? 0) === 1, "resumed window");
	expect(state!.entries[0]).toMatchObject({ content: "Releases happen on Fridays after QA sign-off.", origin: "auto", project: workspace });
	const conversation = await second.bot.conversation("test", "T1", context);
	const curator = await second.bot.harness.snapshot(CuratorDoc, conversation.id, context);
	expect(curator?.receipts.map((receipt) => [receipt.window, receipt.outcome])).toEqual([[1, "committed"]]);
	expect(curator?.window).toMatchObject({ window: 1, token: 1, cursorTurn: 2, state: "committed" });
	expect(calls).toBe(1);
	expect(second.curatorPrompts).toHaveLength(1);
});

test("recall: relevant project memory is noted once before the input; team and other projects are never noted", async () => {
	const { bot, workspace, mainRequests, say } = await start({ memory: { ...ENABLED, auto: { ...ENABLED.auto, enabled: false } } });
	const other = await directory();
	await bot.harness.commit(async (tx) => {
		const draft = await tx.doc(MemoryDoc);
		mutate(draft, "deploy", workspace, "Deploys run through GitHub Actions on the main branch.");
		mutate(draft, "release", workspace, "Release tags look like v1.2.3.");
		mutate(draft, "deploy-team", undefined, "Team-wide: deploys happen on Tuesdays.");
		mutate(draft, "deploy-other", other, "Other repository deploys with Jenkins.");
	}, context);
	await say("How do deploys work here? Which GitHub workflow runs them?");
	const conversation = await bot.conversation("test", "T1", context);
	const list = await entries(conversation);
	const notes = list.filter((entry) => entry.kind === MEMORY_NOTE_KIND);
	expect(notes).toHaveLength(1);
	const input = list.find((entry) => entry.kind === "pi.user")!;
	expect(notes[0]!.id).toBeLessThan(input.id);
	expect(notes[0]!.data).toEqual({ schema: 1, items: [{ key: "deploy", revision: 1 }] });
	const noteText = JSON.stringify(notes[0]!.model);
	expect(noteText).toContain(NOTE_PREFIX);
	expect(noteText).toContain("GitHub Actions");
	expect(mainRequests.at(-1)).toContain("Deploys run through GitHub Actions");
	// Asked again: the same memory revision is not noted twice; a different topic notes its own memory.
	await say("Again: how do deploys work with GitHub?");
	await say("What do release tags look like?");
	const after = (await entries(conversation)).filter((entry) => entry.kind === MEMORY_NOTE_KIND);
	expect(after.map((entry) => entry.data)).toEqual([{ schema: 1, items: [{ key: "deploy", revision: 1 }] }, { schema: 1, items: [{ key: "release", revision: 2 }] }]);
	// Notes stay out of the session index and show as a notice in the TUI.
	expect(entryText(after[0]!)).toBeUndefined();
	const data = createChatData();
	ingestEntry(data, after[0]!, Date.now());
	expect(JSON.stringify(data.blocks)).toContain("Recalled 1 project memory: deploy");
});

test("recall: irrelevant Korean turns do not write notes or pollute model context", async () => {
	const { bot, workspace, mainRequests, say } = await start({ memory: { ...ENABLED, auto: { ...ENABLED.auto, enabled: false } } });
	await bot.harness.commit(async (tx) => {
		const draft = await tx.doc(MemoryDoc);
		for (const content of ["Vanguard가 설치되어 있다.", "CI는 GitHub Actions으로 실행한다.", "Slack에서 메시지를 웹훅으로 전달한다.", "파일시스템 경로는 NTFS이다."]) addAuto(draft, workspace, content, 50);
	}, context);
	for (const text of ["지금 전혀 관련 없는 기억에 서치되는거 같은데?", "수학적으로 분석해서 원인 찾고 개선방안 리서치", "디자인 시스템 Geist 폰트 어드민 UI", "개선하고 테스팅도 다 해줘 실제로"]) await say(text);
	const conversation = await bot.conversation("test", "T1", context);
	expect((await entries(conversation)).filter((entry) => entry.kind === MEMORY_NOTE_KIND)).toEqual([]);
	for (const request of mainRequests) {
		const messages = (JSON.parse(request) as { messages: { role: string; content: unknown }[] }).messages.filter((message) => message.role !== "system");
		expect(JSON.stringify(messages)).not.toContain(NOTE_PREFIX);
		expect(JSON.stringify(messages)).not.toContain("Vanguard가 설치되어");
	}
	await say("Vanguard");
	const list = await entries(conversation);
	const notes = list.filter((entry) => entry.kind === MEMORY_NOTE_KIND);
	expect(notes).toHaveLength(1);
	expect(JSON.stringify(notes[0]!.model)).toContain("Vanguard가 설치되어");
	expect(notes[0]!.id).toBeLessThan(list.filter((entry) => entry.kind === "pi.user").at(-1)!.id);
	expect(mainRequests.at(-1)).toContain("Vanguard가 설치되어");
});

test("recall: delivery history does not change corpus ranking, and maxItems defers unnoted matches", async () => {
	const { bot, workspace, say } = await start({ memory: { ...ENABLED, auto: { ...ENABLED.auto, enabled: false }, recall: { ...ENABLED.recall, maxItems: 1 } } });
	await bot.harness.commit(async (tx) => {
		const draft = await tx.doc(MemoryDoc);
		for (const [key, content] of [["a", "alpha distinctive"], ["b", "alpha"], ["c", "alpha"], ["d", "beta"], ["e", "beta"]] as const) mutate(draft, key, workspace, content);
	}, context);
	const query = "alpha distinctive beta";
	await say(query);
	await say(query);
	await say(query);
	const conversation = await bot.conversation("test", "T1", context);
	const notes = (await entries(conversation)).filter((entry) => entry.kind === MEMORY_NOTE_KIND);
	expect(notes.map((entry) => entry.data)).toEqual([
		{ schema: 1, items: [{ key: "a", revision: 1 }] },
		{ schema: 1, items: [{ key: "d", revision: 4 }] },
		{ schema: 1, items: [{ key: "e", revision: 5 }] },
	]);
});

test("recall: SQLite restart preserves deduplication and a changed revision is recalled once", async () => {
	const workspace = await directory();
	const path = join(workspace, "recall.sqlite");
	const config: MemoryConfig = { ...ENABLED, auto: { ...ENABLED.auto, enabled: false } };
	const first = await start({ workspace, storage: await openNodeSqliteStorage(path), memory: config });
	await first.bot.harness.commit(async (tx) => { mutate(await tx.doc(MemoryDoc), "runtime", workspace, "Vanguard가 설치되어 있다."); }, context);
	await first.say("Vanguard");
	const conversation = await first.bot.conversation("test", "T1", context);
	expect((await entries(conversation)).filter((entry) => entry.kind === MEMORY_NOTE_KIND)).toHaveLength(1);
	await first.bot.close(context);
	bots.splice(bots.indexOf(first.bot), 1);
	const second = await start({ workspace, storage: await openNodeSqliteStorage(path), memory: config });
	await second.say("Vanguard");
	const reopened = await second.bot.conversation("test", "T1", context);
	expect((await entries(reopened)).filter((entry) => entry.kind === MEMORY_NOTE_KIND)).toHaveLength(1);
	await second.bot.harness.commit(async (tx) => { mutate(await tx.doc(MemoryDoc), "runtime", workspace, "Vanguard가 업데이트되었다."); }, context);
	await second.say("Vanguard");
	await second.say("Vanguard");
	expect((await entries(reopened)).filter((entry) => entry.kind === MEMORY_NOTE_KIND).map((entry) => entry.data)).toEqual([
		{ schema: 1, items: [{ key: "runtime", revision: 1 }] },
		{ schema: 1, items: [{ key: "runtime", revision: 2 }] },
	]);
});

for (const accepted of [false, true]) {
	test("recall: pending note recovers once after " + (accepted ? "accepted write" : "write failure"), async () => {
		const { bot, workspace } = await start({ memory: DISABLED_MEMORY });
		await bot.harness.commit(async (tx) => { mutate(await tx.doc(MemoryDoc), "runtime", workspace, "Vanguard is installed."); }, context);
		const conversation = await bot.conversation("test", "T1", context);
		const logs: string[] = [];
		const options = { config: ENABLED.recall, workspaceRoot: workspace, getHarness: () => bot.harness, log: (line: string) => { logs.push(line); } };
		const failed = new Proxy(conversation, { get(target, property, receiver) {
			if (property === "submit") return (async (submission, ctx) => {
				if (accepted) await target.submit(submission, ctx);
				throw new Error("injected delivery interruption");
			}) satisfies Conversation["submit"];
			return Reflect.get(target, property, receiver);
		} });
		await createMemoryRecall(options).recall(failed, "Vanguard", context);
		expect(logs).toHaveLength(1);
		expect(logs[0]).toContain("injected delivery interruption");
		expect((await entries(conversation)).filter((entry) => entry.kind === MEMORY_NOTE_KIND)).toHaveLength(accepted ? 1 : 0);
		const resumed = createMemoryRecall(options);
		await resumed.recall(conversation, "unrelated", context);
		await resumed.recall(conversation, "Vanguard", context);
		expect((await entries(conversation)).filter((entry) => entry.kind === MEMORY_NOTE_KIND)).toHaveLength(1);
		// Concurrent calls on a fresh conversation share the same serial delivery boundary.
		const other = await bot.conversation("test", "T2", context);
		await Promise.all(Array.from({ length: 8 }, () => resumed.recall(other, "Vanguard", context)));
		expect((await entries(other)).filter((entry) => entry.kind === MEMORY_NOTE_KIND)).toHaveLength(1);
	});
}

test("recall: character budget clips Unicode safely and defers the next matching entry", async () => {
	const { bot, workspace, say } = await start({ memory: { ...ENABLED, auto: { ...ENABLED.auto, enabled: false }, recall: { ...ENABLED.recall, budgetChars: 40 } } });
	await bot.harness.commit(async (tx) => {
		const draft = await tx.doc(MemoryDoc);
		for (const key of ["a", "b"]) mutate(draft, key, workspace, "Vanguard " + "🦖 ".repeat(50));
	}, context);
	await say("Vanguard");
	const conversation = await bot.conversation("test", "T1", context);
	const note = (await entries(conversation)).find((entry) => entry.kind === MEMORY_NOTE_KIND)!;
	expect(note.data).toEqual({ schema: 1, items: [{ key: "a", revision: 1 }] });
	const message = note.model![0]! as { content: string };
	const clipped = message.content.split("- ")[1]!.split(" (memory key ")[0]!;
	expect([...clipped]).toHaveLength(40);
	expect(clipped.endsWith("…")).toBe(true);
	expect(clipped).not.toContain("�");
	await say("Vanguard");
	const notes = (await entries(conversation)).filter((entry) => entry.kind === MEMORY_NOTE_KIND);
	expect(notes.map((entry) => entry.data)).toEqual([
		{ schema: 1, items: [{ key: "a", revision: 1 }] },
		{ schema: 1, items: [{ key: "b", revision: 2 }] },
	]);
});

test("both loops are off by default: no curator task and no note", async () => {
	const { bot, workspace, curatorPrompts, say } = await start({ memory: "omit" });
	await bot.harness.commit(async (tx) => { mutate(await tx.doc(MemoryDoc), "deploy", workspace, "deploy notes"); }, context);
	for (const text of ["deploy one", "deploy two", "deploy three"]) await say(text);
	const conversation = await bot.conversation("test", "T1", context);
	expect((await entries(conversation)).some((entry) => entry.kind === MEMORY_NOTE_KIND)).toBe(false);
	expect(curatorPrompts).toHaveLength(0);
});
