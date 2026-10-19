import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { type ClientApi, startClientApi } from "../src/api/server.ts";
import type { AuthService } from "../src/auth/types.ts";
import type { InboundMessage } from "../src/channels/types.ts";
import { createCommands } from "../src/commands/index.ts";
import type { ConversationId } from "@earendil-works/pi-durable";
import { type Bot, openBot } from "../src/core/bot.ts";
import { acquire, ClaimsDoc, type Claim, type ClaimsState, type ClaimToolResult, claimOnce, liveClaims, overlaps, release, releaseOnce } from "../src/core/claims.ts";
import { contentText, entryScore, HALF_LIFE_MS, threadScore } from "../src/core/search.ts";
import { conversationStatus, deleteSession, sessionsSnapshot } from "../src/core/sessions.ts";
import { listThreads, pruneEmptyThreads, pruneEmptyThreadsOnce, rotateThread } from "../src/core/threads.ts";
import { newThreadName } from "../src/tui/app.ts";
import { sessionsExtension } from "../src/extensions/sessions.ts";
import { readTrajectory } from "../src/core/trajectory/read.ts";
import * as trajectoryModule from "../src/core/trajectory/read.ts";
import { definePlugin, type LoadedPlugin, loadPlugin } from "../src/plugins/types.ts";

const context = BACKGROUND_CONTEXT;

let gate: { started: () => void; release: Promise<void> } | undefined;
const gatePlugin = (await loadPlugin(definePlugin({
	id: "gate",
	config: Type.Object({}),
	load: () => ({
		tools: [{
			name: "wait",
			description: "Wait until the test opens the gate",
			inputSchema: { type: "object", properties: {} },
			execute: async () => {
				gate?.started();
				await gate?.release;
				return "opened";
			},
		}],
	}),
}), {})) as LoadedPlugin;

let dir: string | undefined;
const open: Bot[] = [];
let api: ClientApi | undefined;
afterEach(async () => {
	await api?.stop();
	api = undefined;
	for (const bot of open.splice(0)) await bot.close(context);
	if (dir !== undefined) await rm(dir, { recursive: true, force: true });
	dir = undefined;
	gate = undefined;
});

async function startBot(options: { indexPath?: string; storagePath?: string; toolMode?: "direct" | "hybrid" | "codemode-only" } = {}) {
	dir ??= await mkdtemp(join(tmpdir(), "dinobot-sessions-"));
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	const models = createModels();
	models.setProvider(faux.provider);
	const bot = await openBot(
		{
			storage: await openNodeSqliteStorage(options.storagePath ?? join(dir, "bot.sqlite")),
			models,
			defaultModel: { provider: "faux", modelId: "faux-1" },
			toolMode: options.toolMode ?? "direct",
			plugins: [gatePlugin],
			...(options.indexPath ? { searchIndexPath: options.indexPath } : {}),
		},
		context,
	);
	open.push(bot);
	return { bot, faux, models };
}

function message(threadKey: string, messageId: string, text: string): InboundMessage {
	return { channel: "test", threadKey, messageId, userId: "U1", text };
}

async function seed(bot: Bot, faux: ReturnType<typeof fauxProvider>) {
	faux.setResponses([
		fauxAssistantMessage("결제 서비스 배포 일정을 정리했습니다. zebracorn 릴리스는 금요일입니다."),
		fauxAssistantMessage("로그인 버그는 토큰 만료 때문입니다."),
	]);
	await bot.handle(message("payments", "m1", "결제 서비스 배포 일정 알려줘"), context);
	await bot.handle(message("auth", "m2", "로그인이 자꾸 풀려요"), context);
}

describe("session_search", () => {
	test("ranks the thread that discussed the words first, matching Korean words by prefix", async () => {
		const { bot, faux } = await startBot();
		await seed(bot, faux);

		const unique = await bot.index.search("zebracorn", {}, context);
		expect(unique.match).toBe("all");
		expect(unique.results.map((hit) => hit.thread)).toEqual(["test:payments"]);
		expect(unique.results[0]?.snippet).toContain("[zebracorn]");

		const particle = await bot.index.search("일정 배포", {}, context);
		expect(particle.match).toBe("all");
		expect(particle.results[0]?.thread).toBe("test:payments");
		expect(particle.results[0]?.hits).toBe(2);

		expect((await bot.index.search("로그인", { excludeThread: "test:auth" }, context)).results).toEqual([]);
		expect((await bot.index.search("알려줘", {}, context)).results[0]?.snippet).toBe("U1: 결제 서비스 배포 일정 [알려줘]");
	});

	test("relaxes from every word to any word to substrings, and survives FTS syntax in the query", async () => {
		const { bot, faux } = await startBot();
		await seed(bot, faux);

		const any = await bot.index.search("zebracorn nosuchword", {}, context);
		expect(any.match).toBe("any");
		expect(any.results[0]?.thread).toBe("test:payments");

		const substring = await bot.index.search("racorn", {}, context);
		expect(substring.match).toBe("substring");
		expect(substring.results[0]?.thread).toBe("test:payments");

		expect((await bot.index.search('"zebra OR ( NEAR*', {}, context)).results[0]?.thread).toBe("test:payments");
		expect(await bot.index.search("!!! ???", {}, context)).toEqual({ query: "!!! ???", match: "none", results: [] });
	});

	test("an index file reopened over the same storage catches up without duplicating rows", async () => {
		dir = await mkdtemp(join(tmpdir(), "dinobot-sessions-"));
		const paths = { indexPath: join(dir, "index.sqlite"), storagePath: join(dir, "bot.sqlite") };
		const first = await startBot(paths);
		await seed(first.bot, first.faux);
		await first.bot.close(context);
		open.splice(0);

		const { bot } = await startBot(paths);
		const result = await bot.index.search("zebracorn", {}, context);
		expect(result.results.map((hit) => [hit.thread, hit.hits])).toEqual([["test:payments", 1]]);
	});

	test("decays relevance by age toward a floor and rewards breadth logarithmically", () => {
		expect(entryScore(-2, 0)).toBeCloseTo(2);
		expect(entryScore(-2, HALF_LIFE_MS)).toBeCloseTo(2 * (0.3 + 0.7 * 0.5));
		expect(entryScore(-2, 1000 * HALF_LIFE_MS)).toBeCloseTo(0.6);
		expect(threadScore(1, 1)).toBe(1);
		expect(threadScore(1, Math.E)).toBeCloseTo(1.1);
	});
});

describe("problem-only session trajectory analysis", () => {
	test("session_analyze describes the recorded v6 evaluator", () => {
		const extension = sessionsExtension(() => { throw new Error("unused harness"); }, () => { throw new Error("unused index"); });
		expect(extension.tools?.find(tool => tool.name === "session_analyze")?.description).toContain("recorded v6 trajectory evaluator");
	});
	test.each(["direct", "hybrid", "codemode-only"] as const)("%s: session_analyze evaluates the specified problem session", async toolMode => {
		const { bot, faux } = await startBot({ toolMode });
		faux.setResponses([fauxAssistantMessage("기록된 답변")]);
		await bot.handle({ channel: "tui", threadKey: "20261004150044", messageId: "seed", userId: "U1", text: "기록" }, context);
		let observed = "";
		const invoke = toolMode === "direct"
			? fauxToolCall("session_analyze", { thread: "tui:20261004150044", problem: "실행 결과 누락 의심" })
			: fauxToolCall("codemode", { code: 'text(await tools.session_analyze({thread:"tui:20261004150044",problem:"실행 결과 누락 의심"}));' });
		faux.setResponses([fauxAssistantMessage(invoke, { stopReason: "toolUse" }), transcript => {
			observed = JSON.stringify(transcript.messages.at(-1));
			return fauxAssistantMessage("근거 확인 완료");
		}]);
		await bot.handle(message("review", "review", "분석해주세요 [tui:20261004150044]"), context);
		expect(observed).toContain("Automatic trajectory evaluation");
		expect(observed).toContain("digest");
		expect(observed).toContain("PASS");
		expect(observed).toContain("not a correctness certificate");
		expect(observed).toContain("tui:20261004150044");
		expect(observed).toContain("실행 결과 누락 의심");
	});
	for (const toolMode of ["direct", "hybrid", "codemode-only"] as const) for (const limit of [undefined, 1] as const) {
		test(`${toolMode}: session_read limit=${String(limit)} never invokes the evaluator`, async () => {
			const { bot, faux } = await startBot({ toolMode });
			await seed(bot, faux);
			const spy = spyOn(trajectoryModule, "readTrajectory");
			try {
				let observed = "";
				const args = { thread: "test:payments", ...(limit === undefined ? {} : { limit }) };
				const invoke = toolMode === "direct" ? fauxToolCall("session_read", args) : fauxToolCall("codemode", { code: `text(await tools.session_read(${JSON.stringify(args)}));` });
				faux.setResponses([fauxAssistantMessage(invoke, { stopReason: "toolUse" }), transcript => { observed = JSON.stringify(transcript.messages.at(-1)); return fauxAssistantMessage("확인"); }]);
				await bot.handle(message("lookup", "lookup", "그 세션 내용만 알려줘"), context);
				expect(observed).toContain("zebracorn");
				expect(observed).not.toContain("Automatic trajectory evaluation");
				expect(observed).not.toContain("digest");
				expect(spy).not.toHaveBeenCalled();
			} finally { spy.mockRestore(); }
		});
	}
	for (const toolMode of ["direct", "hybrid", "codemode-only"] as const) {
		for (const [label, args, expected] of [
			["missing thread", { problem: "실행 실패" }, "thread"],
			["missing problem", { thread: "test:payments" }, "problem"],
			["blank problem", { thread: "test:payments", problem: "   " }, "nonblank"],
			["unknown thread", { thread: "test:unknown", problem: "실행 실패" }, "Unknown thread"],
		] as const) {
			test(`${toolMode}: session_analyze ${label} never evaluates`, async () => {
				const { bot, faux } = await startBot({ toolMode });
				await seed(bot, faux);
				const spy = spyOn(trajectoryModule, "readTrajectory");
				try {
					let observed = "";
					const invoke = toolMode === "direct" ? fauxToolCall("session_analyze", args) : fauxToolCall("codemode", { code: `text(await tools.session_analyze(${JSON.stringify(args)}));` });
					faux.setResponses([fauxAssistantMessage(invoke, { stopReason: "toolUse" }), transcript => { observed = JSON.stringify(transcript.messages.at(-1)); return fauxAssistantMessage("확인"); }]);
					await bot.handle(message("invalid", "invalid", "문제 확인"), context);
					expect(observed).toContain(expected);
					expect(observed).not.toContain("digest");
					expect(spy).not.toHaveBeenCalled();
				} finally { spy.mockRestore(); }
			});
		}
	}
	test("session_analyze evaluator failure is UNAVAILABLE, never PASS", async () => {
		const { bot, faux } = await startBot({ toolMode: "direct" });
		await seed(bot, faux);
		const spy = spyOn(trajectoryModule, "readTrajectory").mockRejectedValueOnce(new Error("receipt unavailable"));
		try {
			let observed = "";
			faux.setResponses([fauxAssistantMessage(fauxToolCall("session_analyze", { thread: "test:payments", problem: "실행 실패" }), { stopReason: "toolUse" }), transcript => { observed = JSON.stringify(transcript.messages.at(-1)); return fauxAssistantMessage("근거 부족"); }]);
			await bot.handle(message("unavailable", "unavailable", "문제 분석"), context);
			expect(observed).toContain("UNAVAILABLE");
			expect(observed).toContain("isError");
			expect(observed).toContain("Do not infer PASS");
			expect(observed).not.toContain("digest");
			expect(spy).toHaveBeenCalledTimes(1);
		} finally { spy.mockRestore(); }
	});
	test("actual codemode receipts are evaluated through the public harness API", async () => {
		const { bot, faux } = await startBot({ toolMode: "codemode-only" });
		faux.setResponses([fauxAssistantMessage(fauxToolCall("codemode", { code: 'text(await tools.session_list({}));' }), { stopReason: "toolUse" }), fauxAssistantMessage("조회 완료")]);
		await bot.handle(message("codemode", "receipt", "조회"), context);
		const snapshot = await sessionsSnapshot(bot.harness, bot.index, context);
		const id = snapshot.sessions.find(s => s.thread === "test:codemode")!.conversationId;
		const handle = (await bot.harness.conversation(id as ConversationId, context))!;
		const before = await handle.entries({}, 100, undefined, context);
		const g = await readTrajectory(bot.harness, handle.id, context);
		expect(g.conversationId).toBe(id);
		expect(g.verdict).toBe("PASS");
		expect(g.calls).toBe(1);
		expect(g.coverage.complete).toBe(true);
		expect((await handle.entries({}, 100, undefined, context)).items.map(e => e.id)).toEqual(before.items.map(e => e.id));
	});
});

describe("work claims", () => {
	for (const toolMode of ["direct", "codemode-only"] as const) {
		test(toolMode + ": bounded wait observes a real committed release", async () => {
			const { bot, faux } = await startBot({ toolMode });
			await bot.harness.commit(async tx => acquire(await tx.doc(ClaimsDoc), { key: "repo:wait", holder: "test:owner", intent: "edit", ttlMs: 60_000 }, Date.now()), context);
			const watching = Promise.withResolvers<void>();
			const original = bot.harness.watchDoc.bind(bot.harness);
			const watchSpy = spyOn(bot.harness, "watchDoc").mockImplementation((async (...args: unknown[]) => {
				const watch = await (original as (...args: unknown[]) => Promise<unknown>)(...args);
				if (args[0] === ClaimsDoc) watching.resolve();
				return watch;
			}) as typeof bot.harness.watchDoc);
			try {
				let observed = "";
				const args = { key: "repo:wait/src", intent: "fix", wait_ms: 45000 };
				const call = toolMode === "direct" ? fauxToolCall("work_claim", args) : fauxToolCall("codemode", { code: "text(await tools.work_claim(" + JSON.stringify(args) + "));" });
				faux.setResponses([fauxAssistantMessage(call, { stopReason: "toolUse" }), transcript => { observed = JSON.stringify(transcript.messages.at(-1)); return fauxAssistantMessage("done"); }]);
				const submission = await bot.submit(message("waiter", "wait", "claim"), context);
				await watching.promise;
				await bot.harness.commit(async tx => release(await tx.doc(ClaimsDoc), "test:owner", undefined, Date.now()), context);
				await submission.wait(context);
				expect(observed).toContain("Claimed repo:wait/src held by test:waiter");
				expect((await liveClaims(bot.harness, context)).map(c => [c.holder, c.token])).toEqual([["test:waiter", 2]]);
			} finally { watchSpy.mockRestore(); }
		});
		for (const wait_ms of [0, -1, 45001, 1.5, "100"] as const) test(toolMode + ": validates wait_ms=" + wait_ms, async () => {
			const { bot, faux } = await startBot({ toolMode });
			let observed = "";
			const args = { key: "repo:validated", intent: "edit", wait_ms };
			const call = toolMode === "direct" ? fauxToolCall("work_claim", args) : fauxToolCall("codemode", { code: "text(await tools.work_claim(" + JSON.stringify(args) + "));" });
			faux.setResponses([fauxAssistantMessage(call, { stopReason: "toolUse" }), transcript => { observed = JSON.stringify(transcript.messages.at(-1)); return fauxAssistantMessage("done"); }]);
			await bot.handle(message("validation", "validate", "claim"), context);
			if (wait_ms === 0) {
				expect(observed).toContain("Claimed repo:validated");
				expect(await liveClaims(bot.harness, context)).toHaveLength(1);
			} else {
				expect(observed).toContain("wait_ms");
				expect(observed).not.toContain("Claimed repo:validated");
				expect(await liveClaims(bot.harness, context)).toEqual([]);
			}
		});
	}

	test("SQLite reopen resumes a pending claim with its original deadline, not a fresh wait", async () => {
		dir = await mkdtemp(join(tmpdir(), "dinobot-sessions-"));
		const storagePath = join(dir, "bot.sqlite");
		const { bot, faux, models } = await startBot({ storagePath });
		await bot.harness.commit(async tx => acquire(await tx.doc(ClaimsDoc), { key: "repo:restart", holder: "test:owner", intent: "edit", ttlMs: 60_000 }, Date.now()), context);
		const watching = Promise.withResolvers<void>();
		const original = bot.harness.watchDoc.bind(bot.harness);
		const watchSpy = spyOn(bot.harness, "watchDoc").mockImplementation((async (...args: unknown[]) => {
			const watch = await (original as (...args: unknown[]) => Promise<unknown>)(...args);
			if (args[0] === ClaimsDoc) watching.resolve();
			return watch;
		}) as typeof bot.harness.watchDoc);
		faux.setResponses([fauxAssistantMessage(fauxToolCall("work_claim", { key: "repo:restart", intent: "fix", wait_ms: 45000 }), { stopReason: "toolUse" })]);
		await bot.submit(message("restart-waiter", "pending", "claim"), context);
		await watching.promise;
		watchSpy.mockRestore();
		await bot.close(context);
		open.splice(open.indexOf(bot), 1);
		const future = Date.now() + 46000;
		const clock = spyOn(Date, "now").mockReturnValue(future);
		try {
			faux.setResponses([fauxAssistantMessage("recovered")]);
			const resumed = await openBot({ storage: await openNodeSqliteStorage(storagePath), models, defaultModel: { provider: "faux", modelId: "faux-1" }, toolMode: "direct", plugins: [gatePlugin] }, context);
			open.push(resumed);
			const conversation = await resumed.conversation("test", "restart-waiter", context);
			await conversation.waitForIdle(context);
			const page = await conversation.entries({}, 100, undefined, context);
			const results = page.items.flatMap(entry => entry.model ?? []).filter(message => message.role === "toolResult" && message.toolName === "work_claim");
			expect(results).toHaveLength(1);
			expect(JSON.stringify(results)).toContain("Claim wait timed out");
			expect((await liveClaims(resumed.harness, context)).map(claim => [claim.holder, claim.token])).toEqual([["test:owner", 1]]);
		} finally { clock.mockRestore(); }
	});

	test("nested keys overlap, siblings do not", () => {
		expect(overlaps("repo:x", "repo:x/src")).toBe(true);
		expect(overlaps("repo:x/src/api", "repo:x/src")).toBe(true);
		expect(overlaps("repo:x/src", "repo:x/docs")).toBe(false);
		expect(overlaps("repo:x", "repo:xy")).toBe(false);
	});

	test("grants, refuses an overlapping holder, renews in place, and re-grants with a larger token after expiry", () => {
		const state: ClaimsState = { nextToken: 1, claims: [] };
		const a = acquire(state, { key: "repo:x", holder: "t:a", intent: "refactor", ttlMs: 1000 }, 0);
		expect(a).toMatchObject({ status: "granted", claim: { token: 1, expiresAt: 1000 } });
		const b = acquire(state, { key: "repo:x/src", holder: "t:b", intent: "fix", ttlMs: 1000 }, 500);
		expect(b).toMatchObject({ status: "conflict", conflicts: [{ holder: "t:a", key: "repo:x", intent: "refactor" }] });
		expect(acquire(state, { key: "repo:x", holder: "t:a", intent: "refactor 2", ttlMs: 1000 }, 900))
			.toMatchObject({ status: "renewed", claim: { token: 1, expiresAt: 1900 } });
		expect(acquire(state, { key: "repo:x/src", holder: "t:b", intent: "fix", ttlMs: 1000 }, 1900))
			.toMatchObject({ status: "granted", claim: { token: 2 } });
		expect(state.claims.map((claim) => claim.holder)).toEqual(["t:b"]);
		expect(release(state, "t:a", undefined, 1901)).toEqual([]);
		expect(release(state, "t:b", "repo:x/src", 1901).map((claim) => claim.token)).toEqual([2]);
	});

	test("a replayed claim reports a lapse instead of success once its lease expired and another thread took the key", () => {
		const state: ClaimsState = { nextToken: 1, claims: [] };
		const receipt: { result?: ClaimToolResult } = {};
		const request = { key: "repo:x", holder: "t:a", intent: "refactor", ttlMs: 60_000 };
		expect(claimOnce(receipt, state, request, 1000)).toMatchObject({ isError: false, claims: [{ token: 1, expiresAt: 61_000 }] });
		expect(claimOnce(receipt, state, request, 30_000)).toMatchObject({ isError: false, claims: [{ token: 1 }] });
		acquire(state, { key: "repo:x", holder: "t:b", intent: "fix", ttlMs: 60_000 }, 62_000);

		const replay = claimOnce(receipt, state, request, 62_001);
		expect(replay).toMatchObject({ isError: true, claims: [{ holder: "t:b", token: 2 }] });
		expect(replay.text).toContain("token 1) from this call has lapsed");
		expect(state.claims.map((claim) => [claim.holder, claim.token])).toEqual([["t:b", 2]]);
	});

	test("a replayed release returns what it released and leaves a newer lease of the same holder alone", () => {
		const state: ClaimsState = { nextToken: 3, claims: [] };
		acquire(state, { key: "repo:x", holder: "t:a", intent: "edit", ttlMs: 60_000 }, 0);
		const receipt: { released?: Claim[] } = {};
		expect(releaseOnce(receipt, state, "t:a", undefined, 10).map((claim) => claim.token)).toEqual([3]);
		acquire(state, { key: "repo:x", holder: "t:a", intent: "edit again", ttlMs: 60_000 }, 20);

		expect(releaseOnce(receipt, state, "t:a", undefined, 30).map((claim) => claim.token)).toEqual([3]);
		expect(state.claims.map((claim) => claim.token)).toEqual([4]);
	});

	test("the work_claim tool tells the second thread who holds overlapping work", async () => {
		const { bot, faux } = await startBot();
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("work_claim", { key: "Repo:Dinobot/", intent: "refactor the API" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("claimed"),
			fauxAssistantMessage(fauxToolCall("work_claim", { key: "repo:dinobot/src/api", intent: "fix a route" }), { stopReason: "toolUse" }),
			(transcript) => fauxAssistantMessage(JSON.stringify(transcript.messages.at(-1))),
		]);
		await bot.handle(message("a", "m1", "refactor"), context);
		const second = await bot.handle(message("b", "m2", "fix"), context);

		expect(second.status).toBe("answered");
		const result = JSON.parse(second.status === "answered" ? second.text : "{}") as { isError: boolean; content: never[] };
		expect(result.isError).toBe(true);
		expect(contentText(result.content)).toContain("repo:dinobot held by test:a");
		expect((await liveClaims(bot.harness, context)).map((claim) => [claim.key, claim.holder])).toEqual([["repo:dinobot", "test:a"]]);
	});
});

describe("live sessions", () => {
	test("a thread is busy with its running tool while the tool runs and idle after", async () => {
		const { bot, faux } = await startBot();
		let started!: () => void;
		const running = new Promise<void>((resolve) => { started = resolve; });
		let open!: () => void;
		gate = { started, release: new Promise<void>((resolve) => { open = resolve; }) };
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("gate_wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const submission = await bot.submit(message("work", "m1", "wait for the gate"), context);
		await running;

		const busy = await sessionsSnapshot(bot.harness, bot.index, context);
		expect(busy.sessions[0]).toMatchObject({ thread: "test:work", busy: true, state: "running_tools", runningTools: ["gate_wait"] });

		open();
		await submission.wait(context);
		const idle = await sessionsSnapshot(bot.harness, bot.index, context);
		expect(idle.sessions.find((session) => session.thread === "test:work")).toMatchObject({ busy: false, state: "idle", runningTools: [] });
	});

	test("opened-but-unused threads are hidden from the list; the one-time prune unlinks only empty tui ones", async () => {
		dir = await mkdtemp(join(tmpdir(), "dinobot-sessions-"));
		const storagePath = join(dir, "bot.sqlite");
		const first = await startBot({ storagePath });
		first.faux.setResponses([fauxAssistantMessage("hi"), fauxAssistantMessage("hi")]);
		await first.bot.conversation("tui", "empty-a", context);
		await first.bot.conversation("tui", "empty-b", context);
		await first.bot.conversation("test", "empty-other", context);
		await first.bot.handle({ channel: "tui", threadKey: "used", messageId: "m1", userId: "U1", text: "hello" }, context);

		const listed = (await sessionsSnapshot(first.bot.harness, first.bot.index, context)).sessions.map((session) => session.thread);
		expect(listed).toEqual(["tui:used"]);
		expect(Object.keys(await listThreads(first.bot.harness, context)).sort()).toEqual(["test:empty-other", "tui:empty-a", "tui:empty-b", "tui:used"]);

		// The startup run already happened on this fresh store, so a restart keeps empty sessions (and their bindings).
		await first.bot.close(context);
		open.splice(open.indexOf(first.bot), 1);
		const second = await startBot({ storagePath });
		expect(Object.keys(await listThreads(second.bot.harness, context)).sort()).toEqual(["test:empty-other", "tui:empty-a", "tui:empty-b", "tui:used"]);

		expect(await pruneEmptyThreadsOnce(second.bot.harness, "tui", context)).toEqual([]);
		expect((await pruneEmptyThreads(second.bot.harness, "tui", context)).sort()).toEqual(["tui:empty-a", "tui:empty-b"]);
		expect(Object.keys(await listThreads(second.bot.harness, context)).sort()).toEqual(["test:empty-other", "tui:used"]);
		// A pruned key is reusable: it binds a fresh conversation on next use.
		await second.bot.conversation("tui", "empty-a", context);
		expect(Object.keys(await listThreads(second.bot.harness, context))).toContain("tui:empty-a");
	});
});

describe("tui thread names", () => {
	test("timestamp plus a random suffix, so same-second openings differ", () => {
		const at = new Date("2026-10-04T15:00:44.123Z");
		expect(newThreadName(at, () => 0)).toBe("20261004150044-0000");
		expect(newThreadName(at, () => 0.5)).toBe("20261004150044-8000");
		expect(newThreadName(at, () => 0.9999999)).toBe("20261004150044-ffff");
	});
});

describe("client API", () => {
	const fakeAuth: AuthService = {
		credentials: {} as AuthService["credentials"],
		providers: async () => [],
		login: async () => { throw new Error("unused"); },
		logout: async () => false,
		status: async () => [],
		accounts: async () => [],
		useAccount: async () => {
			throw new Error("no accounts");
		},
	};

	async function startApi() {
		const started = await startBot();
		api = startClientApi(started.bot, 0, context, createCommands({ bot: started.bot, models: started.models, auth: fakeAuth, plugins: [] }));
		return { ...started, url: (path: string) => new URL(path, api!.url) };
	}

	test("search validates its query and limit", async () => {
		const { bot, faux, url } = await startApi();
		await seed(bot, faux);
		expect((await fetch(url("/v1/search?q=%20"))).status).toBe(400);
		expect((await fetch(url("/v1/search?q=x&limit=0"))).status).toBe(400);
		const found = await fetch(url(`/v1/search?q=${encodeURIComponent("zebracorn")}`));
		expect(found.status).toBe(200);
		expect(((await found.json()) as { results: { thread: string }[] }).results[0]?.thread).toBe("test:payments");
	});

	test("thread status carries the working folder the thread was created with", async () => {
		const { bot } = await startApi();
		const cwd = await realpath(tmpdir());
		const conversation = await bot.conversation("test", "project", context, cwd);
		expect((await conversationStatus(bot.harness, conversation.id, context)).cwd).toBe(cwd);
	});

	test("claims answer 409 with the holder on overlap and stream into /v1/sessions/events", async () => {
		const { url } = await startApi();
		const claim = (holder: string, key: string) =>
			fetch(url("/v1/claims"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key, holder, intent: "edit" }) });
		expect((await claim("tui:a", "repo:x")).status).toBe(200);
		const conflict = await claim("tui:b", "repo:x/src");
		expect(conflict.status).toBe(409);
		expect(await conflict.json()).toMatchObject({ status: "conflict", conflicts: [{ holder: "tui:a", key: "repo:x" }] });
		expect((await fetch(url("/v1/claims"), { method: "POST", body: "{}" })).status).toBe(400);

		const stream = await fetch(url("/v1/sessions/events"));
		const reader = stream.body!.getReader();
		const first = new TextDecoder().decode((await reader.read()).value);
		expect(JSON.parse(first.slice("data: ".length))).toMatchObject({ type: "sessions", claims: [{ key: "repo:x", holder: "tui:a" }] });

		const released = await fetch(url("/v1/claims?holder=tui:a"), { method: "DELETE" });
		expect(((await released.json()) as { released: unknown[] }).released).toHaveLength(1);
		const next = new TextDecoder().decode((await reader.read()).value);
		expect(JSON.parse(next.slice("data: ".length))).toMatchObject({ type: "sessions", claims: [] });
		await reader.cancel();
	});
	test("DELETE /v1/threads/:channel/:thread unlinks the thread and answers 404 once it is gone", async () => {
		const { bot, faux, url } = await startApi();
		await seed(bot, faux);
		const first = await fetch(url("/v1/threads/test/payments"), { method: "DELETE" });
		expect(first.status).toBe(200);
		expect(await first.json()).toEqual({ status: "deleted", removed: ["test:payments"], releasedClaims: 0 });
		const again = await fetch(url("/v1/threads/test/payments"), { method: "DELETE" });
		expect(again.status).toBe(404);
		expect(await again.json()).toEqual({ status: "not_found" });
		const listed = (await (await fetch(url("/v1/threads"))).json()) as { threads: { key: string }[] };
		expect(listed.threads.map((thread) => thread.key)).toEqual(["test:auth"]);
	});
});

describe("thread deletion", () => {
	test("deletes an idle thread with its /new archives and claims from sessions and search; refuses busy and quarantined ones", async () => {
		const { bot, faux, models } = await startBot();
		await seed(bot, faux);
		const payments = (await listThreads(bot.harness, context))["test:payments"]!;
		expect((await rotateThread(bot.harness, models, "test:payments", payments, "r1", context)).status).toBe("rotated");
		await bot.harness.commit(async (tx) => acquire(await tx.doc(ClaimsDoc), { key: "repo:x", holder: "test:payments", intent: "edit", ttlMs: 60_000 }, Date.now()), context);
		expect((await sessionsSnapshot(bot.harness, bot.index, context)).sessions.map((session) => session.thread)).toContain("test:payments#1");

		const outcome = await deleteSession(bot.harness, "test:payments", context);
		expect(outcome).toEqual({ status: "deleted", removed: ["test:payments", "test:payments#1"], releasedClaims: 1 });
		expect(Object.keys(await listThreads(bot.harness, context))).toEqual(["test:auth"]);
		expect((await sessionsSnapshot(bot.harness, bot.index, context)).sessions.map((session) => session.thread)).toEqual(["test:auth"]);
		expect((await bot.index.search("zebracorn", {}, context)).results).toEqual([]);
		expect(await liveClaims(bot.harness, context)).toEqual([]);
		expect(await deleteSession(bot.harness, "test:payments", context)).toEqual({ status: "not_found" });

		// Quarantined claims wait for reconcile evidence; the thread stays.
		await bot.harness.commit(async (tx) => {
			const claims = await tx.doc(ClaimsDoc);
			claims.claims = [...claims.claims, { key: "repo:q", holder: "test:auth", intent: "x", token: 99, acquiredAt: Date.now(), expiresAt: Date.now() + 60_000, quarantined: "UNKNOWN native process provenance" }];
		}, context);
		expect(await deleteSession(bot.harness, "test:auth", context)).toEqual({ status: "quarantined" });
		expect(Object.keys(await listThreads(bot.harness, context))).toEqual(["test:auth"]);

		// A running thread is refused until it settles.
		let started!: () => void;
		const running = new Promise<void>((resolve) => { started = resolve; });
		let openGate!: () => void;
		gate = { started, release: new Promise<void>((resolve) => { openGate = resolve; }) };
		faux.setResponses([fauxAssistantMessage(fauxToolCall("gate_wait", {}), { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
		const submission = await bot.submit(message("work", "m9", "wait"), context);
		await running;
		expect(await deleteSession(bot.harness, "test:work", context)).toEqual({ status: "busy" });
		openGate();
		await submission.wait(context);
		expect((await deleteSession(bot.harness, "test:work", context)).status).toBe("deleted");
		// A deleted key is reusable and binds a fresh conversation.
		const fresh = await bot.conversation("test", "payments", context);
		expect(fresh.id).not.toBe(payments);
	});
});
