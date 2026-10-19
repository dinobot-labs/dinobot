import { afterEach, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStorage, type Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { AskRecord } from "../src/core/ask.ts";
import { type Bot, openBot } from "../src/core/bot.ts";
import { createRun, DagSeenDoc, RunDoc, type RunState } from "../src/core/dag.ts";
import { type AgentRef, scanWake, WAKE_PREFIX, WakeDoc, type WakeRead } from "../src/extensions/subagents.ts";

/**
 * Session 135925 (2026-10-14): the orchestrator started an implement → review DAG, answered "I will report back"
 * and yielded. The review failed, the run became `blocked`, and nothing re-entered the orchestrator for 7.6 hours
 * until the user asked "did you finish?" (ADR 0096). An ordinary DAG run that stops (blocked, verified, or cancelled
 * by anyone but the model) in a state the model has not seen must wake the idle orchestrator exactly once.
 */
const context = BACKGROUND_CONTEXT;
const bots: Bot[] = [];
afterEach(async () => { for (const bot of bots.splice(0)) await bot.close(context).catch(() => undefined); });
const text = (content: unknown) => typeof content === "string" ? content : JSON.stringify(content);

const plan = {
	nodes: [
		{ id: "implement", kind: "delegate", description: "implement the feature", writes: ["out"] },
		{ id: "review", kind: "verify", description: "review the feature", reads: ["out"], covers: ["R"] },
	],
	edges: [["implement", "review"]],
	goal: { requirements: ["R"] },
};
const decisionPlan = {
	nodes: [{ id: "q", kind: "ask", description: "Which fixture?" }, { id: "v", kind: "verify", description: "check", covers: ["R"] }],
	edges: [["q", "v"]],
	goal: { requirements: ["R"] },
};
const verdict = (v: "pass" | "fail") => JSON.stringify({ version: 1, requirements: [{ id: "R", verdict: v, evidence: v === "fail" ? "XLSX creator corrupts _x0041_ literals" : "checked" }], summary: v, repairable: v === "fail" });

type Options = { review?: "pass" | "fail"; implement?: Promise<void>; hold?: Promise<void>; storage?: Storage; onWriting?: () => void };

async function setup(options: Options = {}) {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	const wakes: string[] = [];
	let bot: Bot | undefined;
	let parentId: number | undefined;
	const runStatus = async () => (await bot!.harness.snapshot(RunDoc, parentId! as never, context))?.runs[0]?.status;
	const router: FauxResponseFactory = async (t) => {
		const user = text(t.messages.findLast((m) => m.role === "user")?.content);
		const results = t.messages.slice(t.messages.findLastIndex((m) => m.role === "user") + 1).filter((m) => m.role === "toolResult");
		const lastResult = text(results.at(-1)?.content);
		const node = /plan node "([^"]+)"/.exec(user)?.[1];
		if (node === "implement") { await options.implement; return fauxAssistantMessage("implemented and committed"); }
		if (node === "review") return fauxAssistantMessage(verdict(options.review ?? "fail"));
		if (user.startsWith(WAKE_PREFIX)) {
			if (!results.length) { wakes.push(user); return fauxAssistantMessage(fauxToolCall("dag_status", {}), { stopReason: "toolUse" }); }
			return fauxAssistantMessage("reported what changed");
		}
		switch (user) {
			case "start":
				return results.length ? fauxAssistantMessage("started; I will report back after the review") : fauxAssistantMessage(fauxToolCall("dag_run", { plan }), { stopReason: "toolUse" });
			case "start and watch": {
				if (!results.length) return fauxAssistantMessage(fauxToolCall("dag_run", { plan }), { stopReason: "toolUse" });
				if (/\[(blocked|verified)\]/.test(lastResult)) return fauxAssistantMessage("the review finished; reporting it now");
				if (results.length > 1) await Bun.sleep(40);
				return fauxAssistantMessage(fauxToolCall("dag_step", {}), { stopReason: "toolUse" });
			}
			case "start and cancel":
				if (!results.length) return fauxAssistantMessage(fauxToolCall("dag_run", { plan }), { stopReason: "toolUse" });
				if (results.length === 1) return fauxAssistantMessage(fauxToolCall("dag_step", { cancel: true, reason: "user changed their mind" }), { stopReason: "toolUse" });
				return fauxAssistantMessage("cancelled the run");
			case "how is it going": {
				// Looks at the run (still running), then keeps writing its final answer while the background driver stops
				// the run: the model's last DAG observation is "running", so the stop is unseen although it happened
				// before this answer ended.
				if (!results.length) return fauxAssistantMessage(fauxToolCall("dag_status", {}), { stopReason: "toolUse" });
				options.onWriting?.();
				for (let i = 0; i < 400 && (await runStatus()) === "running"; i++) await Bun.sleep(10);
				return fauxAssistantMessage("still running; I will report back");
			}
			case "chat":
				await options.hold;
				return fauxAssistantMessage("just chatting");
			case "start two":
				// Two runs in one turn: only the second is active, yet both must be driven and announced.
				if (results.length < 2) return fauxAssistantMessage(fauxToolCall("dag_run", { plan }), { stopReason: "toolUse" });
				return fauxAssistantMessage("started two runs; I will report back");
			case "start gate and step":
				if (!results.length) return fauxAssistantMessage(fauxToolCall("dag_run", { plan: decisionPlan }), { stopReason: "toolUse" });
				if (results.length === 1) return fauxAssistantMessage(fauxToolCall("dag_step", {}), { stopReason: "toolUse" });
				return fauxAssistantMessage("node q needs my decision; I will decide after checking with the team");
			case "chat and look":
				if (!results.length) { await options.hold; return fauxAssistantMessage(fauxToolCall("dag_status", {}), { stopReason: "toolUse" }); }
				return fauxAssistantMessage("the run is blocked; here is why");
		}
		throw new Error(`unexpected ${user}`);
	};
	faux.setResponses(Array.from({ length: 300 }, () => router));
	const models = createModels();
	models.setProvider(faux.provider);
	bot = await openBot({ storage: options.storage ?? new MemoryStorage(), models, defaultModel: { provider: "faux", modelId: "faux-1" }, toolMode: "direct", plugins: [], settings: { retry: { enabled: false } } }, context);
	bots.push(bot);
	const parent = await bot.conversation("test", "dag-wake", context);
	parentId = parent.id;
	const say = async (content: string) => (await parent.submit({ type: "input", content }, context)).wait(context);
	const run = async () => (await bot!.harness.snapshot(RunDoc, parent.id, context))!.runs[0]!;
	const until = async (what: string, ok: () => Promise<boolean> | boolean, ms = 10_000) => {
		const end = Date.now() + ms;
		while (!(await ok())) {
			if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
			await Bun.sleep(20);
		}
	};
	const messages = async () => (await parent.entries({}, 400, undefined, context)).items.flatMap((e) => e.model ?? []) as Message[];
	return { bot, parent, say, run, until, wakes, messages };
}

test("session 135925: a review that fails after the orchestrator answered wakes it once", async () => {
	const { say, run, until, wakes, messages } = await setup();
	await say("start");
	expect(wakes).toEqual([]);
	await until("the wake", () => wakes.length > 0);
	const stopped = await run();
	expect(stopped.status).toBe("blocked");
	expect(wakes).toHaveLength(1);
	expect(wakes[0]).toContain(`DAG run ${stopped.id} stopped: blocked`);
	expect(wakes[0]).toContain("Unmet: R");
	await until("the woken turn to inspect the run", async () => (await messages()).some((m) => m.role === "toolResult" && m.toolName === "dag_status"));
	await Bun.sleep(150);
	expect(wakes).toHaveLength(1);
}, 20_000);

test("a run that verifies after the orchestrator answered wakes it once to carry out the next step", async () => {
	const { say, run, until, wakes } = await setup({ review: "pass" });
	await say("start");
	await until("the wake", () => wakes.length > 0);
	expect((await run()).status).toBe("verified");
	expect(wakes[0]).toContain("finished: verified");
	await Bun.sleep(150);
	expect(wakes).toHaveLength(1);
}, 20_000);

test("a stop the model already saw in a DAG tool result does not wake it", async () => {
	const { say, run, wakes } = await setup();
	await say("start and watch");
	expect((await run()).status).toBe("blocked");
	await Bun.sleep(250);
	expect(wakes).toEqual([]);
}, 20_000);

test("a run the model cancelled itself does not wake it", async () => {
	const { say, run, wakes } = await setup();
	await say("start and cancel");
	expect((await run()).status).toBe("cancelled");
	await Bun.sleep(250);
	expect(wakes).toEqual([]);
}, 20_000);

test("a run that stops while the model is still writing its final answer wakes it after that answer", async () => {
	const implement = Promise.withResolvers<void>();
	const { say, run, until, wakes } = await setup({ implement: implement.promise, onWriting: () => implement.resolve() });
	await say("start");
	await say("how is it going");
	expect((await run()).status).toBe("blocked");
	await until("the wake", () => wakes.length > 0);
	expect(wakes[0]).toContain("stopped: blocked");
	await Bun.sleep(150);
	expect(wakes).toHaveLength(1);
}, 20_000);

test("a run that stops while a user turn runs wakes the orchestrator after that turn, once", async () => {
	const implement = Promise.withResolvers<void>();
	const hold = Promise.withResolvers<void>();
	const { say, run, until, wakes } = await setup({ implement: implement.promise, hold: hold.promise });
	await say("start");
	const chatting = say("chat");
	await Bun.sleep(100);
	implement.resolve();
	await until("the run to stop", async () => (await run()).status === "blocked");
	await Bun.sleep(200);
	expect(wakes).toEqual([]); // never while the conversation is busy
	hold.resolve();
	await chatting;
	await until("the wake", () => wakes.length > 0);
	await Bun.sleep(150);
	expect(wakes).toHaveLength(1);
}, 20_000);

test("a busy user turn that looks at the stopped run itself causes no wake", async () => {
	const implement = Promise.withResolvers<void>();
	const hold = Promise.withResolvers<void>();
	const { say, run, until, wakes } = await setup({ implement: implement.promise, hold: hold.promise });
	await say("start");
	const looking = say("chat and look");
	await Bun.sleep(100);
	implement.resolve();
	await until("the run to stop", async () => (await run()).status === "blocked");
	hold.resolve();
	await looking;
	await Bun.sleep(250);
	expect(wakes).toEqual([]);
}, 20_000);

test("two runs started in one turn are both driven, and both stops reach the model", async () => {
	const { bot, parent, say, until, wakes } = await setup();
	expect((await say("start two")).status).toBe("done");
	const runs = () => bot.harness.snapshot(RunDoc, parent.id, context).then((doc) => doc!.runs);
	expect(await runs()).toHaveLength(2);
	await until("both runs to stop", async () => (await runs()).every((run) => run.status === "blocked"));
	// Each stop reaches the model: in a wake text (which records it as seen) or in the woken turn's own dag_status.
	await until("both stops seen by the model", async () => {
		const seen = (await bot.harness.snapshot(DagSeenDoc, parent.id, context))?.seen ?? {};
		return (await runs()).every((run) => seen[run.id] === "blocked:0:0");
	});
	expect(wakes.length).toBeGreaterThanOrEqual(1);
}, 20_000);

test("an ask node the model saw in its dag_step result is not announced again", async () => {
	const { say, run, wakes } = await setup();
	await say("start gate and step");
	expect((await run()).nodes.q!.status).toBe("waiting");
	await Bun.sleep(250);
	expect(wakes).toEqual([]);
}, 20_000);

test("upgrade: a run started before DagSeenDoc existed is adopted while running and announced when it stops; old history is not", async () => {
	const implement = Promise.withResolvers<void>();
	const { bot, parent, say, run, until, wakes } = await setup({ implement: implement.promise });
	await say("start");
	const live = await run();
	// Simulate the pre-upgrade state: no seen entry, plus an old stopped run in the history.
	const history = { ...live, id: "dag-history", status: "blocked" as const, reason: "old" };
	await bot.harness.commit(async (tx) => {
		delete (await tx.doc(DagSeenDoc, parent.id)).seen[live.id];
		(await tx.doc(RunDoc, parent.id)).runs.push(history);
		return undefined;
	}, context);
	await say("chat"); // any later answer adopts the in-flight run (no DAG tool call here, so nothing marks it seen)
	expect((await bot.harness.snapshot(DagSeenDoc, parent.id, context))!.seen).toMatchObject({ [live.id]: "adopted", "dag-history": "blocked:0:0" });
	implement.resolve();
	await until("the wake", () => wakes.length > 0);
	expect(wakes[0]).toContain(`DAG run ${live.id} stopped: blocked`);
	expect(wakes[0]).not.toContain("dag-history");
	await Bun.sleep(150);
	expect(wakes).toHaveLength(1);
}, 20_000);

test("upgrade restart: a run left in flight by a version without the DAG wake is adopted at startup", async () => {
	const dir = await mkdtemp(join(tmpdir(), "dinobot-dag-wake-"));
	const never = Promise.withResolvers<void>();
	const first = await setup({ storage: await openNodeSqliteStorage(join(dir, "bot.sqlite")), implement: never.promise });
	await first.say("start");
	await first.until("the implement node to run", async () => (await first.run()).nodes.implement!.status === "running");
	// The old version recorded nothing: no seen entry and no wake watcher.
	const watcher = (await first.bot.harness.snapshot(WakeDoc, first.parent.id, context))?.task;
	if (watcher !== undefined) { await first.bot.harness.abortTask(watcher, context); await first.bot.harness.waitForTask(watcher, context); }
	await first.bot.harness.commit(async (tx) => { (await tx.doc(DagSeenDoc, first.parent.id)).seen = {}; delete (await tx.doc(WakeDoc, first.parent.id)).task; return undefined; }, context);
	bots.splice(bots.indexOf(first.bot), 1);
	await first.bot.close(context);
	never.resolve();
	const second = await setup({ storage: await openNodeSqliteStorage(join(dir, "bot.sqlite")) });
	await second.until("the wake after restart", () => second.wakes.length > 0, 15_000);
	expect(second.wakes[0]).toContain("stopped: blocked");
	await Bun.sleep(150);
	expect(second.wakes).toHaveLength(1);
	bots.splice(bots.indexOf(second.bot), 1);
	await second.bot.close(context);
	await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}, 30_000);

test("a restart while the DAG runs still wakes the orchestrator when the review fails", async () => {
	const dir = await mkdtemp(join(tmpdir(), "dinobot-dag-wake-"));
	const never = Promise.withResolvers<void>();
	const first = await setup({ storage: await openNodeSqliteStorage(join(dir, "bot.sqlite")), implement: never.promise });
	await first.say("start");
	await first.until("the implement node to run", async () => (await first.run()).nodes.implement!.status === "running");
	bots.splice(bots.indexOf(first.bot), 1);
	await first.bot.close(context);
	never.resolve();
	const second = await setup({ storage: await openNodeSqliteStorage(join(dir, "bot.sqlite")) });
	await second.until("the wake after restart", () => second.wakes.length > 0, 15_000);
	expect((await second.run()).status).toBe("blocked");
	expect(second.wakes[0]).toContain("stopped: blocked");
	await Bun.sleep(150);
	expect(second.wakes).toHaveLength(1);
	bots.splice(bots.indexOf(second.bot), 1);
	await second.bot.close(context);
	await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}, 30_000);

// ---- the scan itself: every exclusion of ADR 0096 -----------------------------------------------------------------

const blocked = (id: string, extra: Partial<RunState> = {}): RunState => ({ ...createRun(id, plan as never, 0), status: "blocked", reason: "verifier rejected", ...extra });
function reader(state: { runs?: RunState[]; seen?: Record<string, string>; seenAsks?: string[]; notified?: string[]; asks?: AskRecord[]; agents?: AgentRef[]; top?: boolean }): WakeRead {
	return {
		self: 1 as never,
		agents: async () => ({ agents: state.agents ?? [] }),
		progress: async () => ({ subagent: { status: "running" } as never }),
		asks: async () => ({ asks: state.asks ?? [] }),
		notified: async () => state.notified ?? [],
		runs: async () => ({ runs: state.runs ?? [] }),
		seen: async () => state.seen ?? {},
		seenAsks: async () => state.seenAsks ?? [],
		topLevel: async () => state.top ?? true,
	};
}
const ask = (id: string, extra: Partial<AskRecord>): AskRecord => ({ id, from: { conversationId: 1 as never }, to: "main", kind: "decision", refs: [], question: "which?", default: "a", createdAt: 0, deadlineAt: 1, state: "open", ...extra });

test("scan: blocked and verified runs are events, a cancellation (only the model cancels) is not; running runs keep the watcher alive", async () => {
	const runs = [blocked("b"), blocked("v", { status: "verified" }), blocked("c", { status: "cancelled", reason: "goal epoch changed" }), blocked("r", { status: "running" })];
	const scan = await scanWake(reader({ runs, seen: { b: "running:0:0", v: "running:0:0", c: "adopted", r: "running:0:0" } }));
	expect(scan.events.map((e) => e.key)).toEqual(["dag:b:blocked:0:0", "dag:v:verified:0:0"]);
	expect(scan.events[0]!.line).toContain("verifier rejected");
	expect(scan.runningRuns).toEqual(["r"]);
});

test("scan: a stop already seen or already announced is not announced again; a replan makes it new", async () => {
	expect((await scanWake(reader({ runs: [blocked("b")], seen: { b: "blocked:0:0" } }))).events).toEqual([]);
	expect((await scanWake(reader({ runs: [blocked("b")], seen: { b: "running:0:0" }, notified: ["dag:b:blocked:0:0"] }))).events).toEqual([]);
	expect((await scanWake(reader({ runs: [blocked("b", { revision: 1 })], seen: { b: "blocked:0:0" }, notified: ["dag:b:blocked:0:0"] }))).events.map((e) => e.key)).toEqual(["dag:b:blocked:1:0"]);
	// A run with no entry predates DagSeenDoc and was never adopted while running: history, never announced.
	expect((await scanWake(reader({ runs: [blocked("old")] }))).events).toEqual([]);
	// A quarantine because the goal changed (new goal_set, user abort) is not news.
	expect((await scanWake(reader({ runs: [blocked("q", { reason: "stale_goal_admission_epoch; candidate and historical outcomes preserved" })], seen: { q: "running:0:0" } }))).events).toEqual([]);
	// An ask the model saw in a dag_step result is not announced.
	expect((await scanWake(reader({ asks: [ask("decide", { run: "b", node: "q" })], seenAsks: ["decide"] }))).events).toEqual([]);
});

test("scan: research-owned runs and child conversations are never woken for DAG runs or ask nodes", async () => {
	expect((await scanWake(reader({ runs: [blocked("m", { owner: { missionId: "x" } }), blocked("n", { owner: { missionId: "y" }, status: "running" })] }))).events).toEqual([]);
	expect((await scanWake(reader({ runs: [blocked("m", { owner: { missionId: "x" }, status: "running" })] }))).runningRuns).toEqual([]);
	const child = await scanWake(reader({ top: false, runs: [blocked("b"), blocked("r", { status: "running" })], seen: { b: "running:0:0" }, asks: [ask("q", { run: "b", node: "q" })] }));
	expect(child.events).toEqual([]);
	expect(child.runningRuns).toEqual([]);
});

test("scan: open asks of ask nodes and of DAG node children are events; a human one is marked for the human", async () => {
	const agents: AgentRef[] = [{ taskId: "sa-7", runnerId: 7 as never, conversationId: 7 as never, background: true, owner: "dag" }];
	const scan = await scanWake(reader({
		agents,
		asks: [
			ask("decide", { run: "b", node: "q" }),
			ask("approve", { run: "b", node: "gate", to: "human", kind: "authority", options: ["approve", "deny"] }),
			ask("child", { from: { conversationId: 7 as never, taskId: "sa-7" } }),
			ask("own-human", { to: "human" }), // opened by the orchestrator itself in its turn: not an event
			ask("closed", { run: "b", node: "q", state: "answered" }),
		],
	}));
	expect(scan.events.map((e) => e.key).sort()).toEqual(["ask:approve", "ask:child", "ask:decide"]);
	expect(scan.events.find((e) => e.key === "ask:approve")!.humanAsk).toBe("approve");
	expect(scan.events.find((e) => e.key === "ask:decide")!.humanAsk).toBeUndefined();
});
