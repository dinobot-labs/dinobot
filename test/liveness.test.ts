import { afterEach, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { type Bot, openBot } from "../src/core/bot.ts";
import { GoalDoc } from "../src/core/goal.ts";
import { TodoDoc } from "../src/extensions/todo.ts";
import { GOAL_CONTINUATION_LIMIT, GOAL_CONTINUATION_PREFIX } from "../src/extensions/liveness.ts";
import { WAKE_PREFIX } from "../src/extensions/subagents.ts";

/**
 * ADR 0096 liveness: a turn may end with an active goal only if something will re-enter the conversation by itself
 * (a running subagent or DAG run, an unannounced wake event, an open question to the human). Otherwise the host continues
 * the run, at most GOAL_CONTINUATION_LIMIT times and never after a continued turn without a tool call. A subagent's
 * answer is held until its own DAG runs settle.
 */
const context = BACKGROUND_CONTEXT;
const bots: Bot[] = [];
afterEach(async () => { for (const bot of bots.splice(0)) await bot.close(context).catch(() => undefined); });
const text = (content: unknown) => typeof content === "string" ? content : JSON.stringify(content);

const goal = { objective: "Ship the fixture feature", criteria: [{ id: "shipped", statement: "The fixture feature is shipped", check: { kind: "binary", observable: "fixture shipped", method: "inspect" } }] };
type Mode = "finish" | "spin" | "talk" | "block";

type Route = (user: string, results: number, t: Parameters<FauxResponseFactory>[0]) => Awaited<ReturnType<FauxResponseFactory>> | undefined | Promise<Awaited<ReturnType<FauxResponseFactory>> | undefined>;
async function setup(route: Route, toolMode: "direct" | "codemode-only" = "direct") {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	const continuations: string[] = [];
	const router: FauxResponseFactory = async (t) => {
		const user = text(t.messages.findLast((m) => m.role === "user")?.content);
		const results = t.messages.slice(t.messages.findLastIndex((m) => m.role === "user") + 1).filter((m) => m.role === "toolResult").length;
		if (user.startsWith(GOAL_CONTINUATION_PREFIX) && !results) continuations.push(user);
		const response = await route(user, results, t);
		if (!response) throw new Error(`unexpected ${user} (${results})`);
		return response;
	};
	faux.setResponses(Array.from({ length: 120 }, () => router));
	const models = createModels();
	models.setProvider(faux.provider);
	const bot = await openBot({ storage: new MemoryStorage(), models, defaultModel: { provider: "faux", modelId: "faux-1" }, toolMode, plugins: [], scheduler: { timers: false }, settings: { retry: { enabled: false } } }, context);
	bots.push(bot);
	const parent = await bot.conversation("test", "liveness", context);
	const say = async (content: string) => (await parent.submit({ type: "input", content }, context)).wait(context);
	const messages = async () => (await parent.entries({}, 400, undefined, context)).items.flatMap((e) => e.model ?? []) as Message[];
	return { bot, parent, say, continuations, messages };
}
const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage(fauxToolCall(name, args as never), { stopReason: "toolUse" });

/** Sets the goal, then stops early ("I will do it later"); on each host continuation it behaves per `mode`. */
function premature(mode: Mode) {
	return (user: string, results: number) => {
		if (user === "do it") return results ? fauxAssistantMessage("I will do it later") : call("goal_set", goal);
		if (user.startsWith(GOAL_CONTINUATION_PREFIX)) {
			switch (mode) {
				case "finish": return results ? fauxAssistantMessage("shipped") : call("goal_update", { expected_revision: 1, criteria: [{ id: "shipped", status: "met", evidence: "fixture shipped" }], status: "achieved" });
				case "spin": return results ? fauxAssistantMessage("still later") : call("goal_read", {});
				case "talk": return fauxAssistantMessage("still later");
				case "block": return results || user.includes("[unmet]") ? fauxAssistantMessage("blocked: the fixture server is down; please start it") : call("goal_update", { expected_revision: 1, criteria: [{ id: "shipped", status: "unmet", evidence: "fixture server down" }] });
			}
		}
		return undefined;
	};
}

test.each(["direct", "codemode-only"] as const)("%s: an explicitly authorized scheduled continuation waits instead of falsely reporting no resumption", async (mode) => {
	const invoke = (name: string, args: Record<string, unknown>) => mode === "direct" ? call(name, args) : call("codemode", { code: `text(await tools.${name}(${JSON.stringify(args)}));` });
	const at = new Date(Date.now() + 3600000).toISOString();
	const request = "Resume this goal in one hour; do not do the work now";
	const { bot, parent, say, continuations } = await setup((user, results) => {
		if (user.startsWith(GOAL_CONTINUATION_PREFIX)) return fauxAssistantMessage("unexpected immediate continuation");
		if (user === request) return results === 0 ? invoke("goal_set", goal) : results === 1
			? invoke("schedule_create", { key: "resume", text: "Ship the fixture feature", at, continue_goal: true }) : fauxAssistantMessage("Registered; waiting for the scheduled wake");
		return undefined;
	}, mode);
	expect((await say(request)).status).toBe("done");
	expect(await bot.scheduler.list(parent.id)).toHaveLength(1);
	expect(continuations).toEqual([]);
	expect((await bot.harness.snapshot(GoalDoc, parent.id, context))?.goal?.status).toBe("active");
}, 20000);

test("an unrelated reminder never suppresses active-goal continuation", async () => {
	const { bot, parent, say, continuations } = await setup((user, results) => {
		if (user.startsWith(GOAL_CONTINUATION_PREFIX)) return fauxAssistantMessage("work still pending");
		return results === 0 ? call("goal_set", goal) : results === 1
			? call("schedule_create", { key: "reminder", text: "Drink water", at: new Date(Date.now() + 3600000).toISOString() }) : fauxAssistantMessage("will work later");
	});
	expect((await say("Work on the feature and separately remind me to drink water in an hour")).status).toBe("done");
	expect(await bot.scheduler.list(parent.id)).toHaveLength(1);
	expect(continuations).toHaveLength(1);
});

test("an active goal left with nothing running is continued, and the continued turn finishes it", async () => {
	const { bot, parent, say, continuations } = await setup(premature("finish"));
	const settled = await say("do it");
	expect(settled.status).toBe("done");
	expect(continuations).toHaveLength(1);
	expect(continuations[0]).toContain("shipped: The fixture feature is shipped");
	expect((await bot.harness.snapshot(GoalDoc, parent.id, context))!.goal!.status).toBe("achieved");
}, 20_000);

test("continuations are capped per input, even when each continued turn calls a tool", async () => {
	const { say, continuations } = await setup(premature("spin"));
	expect((await say("do it")).status).toBe("done");
	expect(continuations).toHaveLength(GOAL_CONTINUATION_LIMIT);
	expect(continuations.at(-1)).toContain(`${GOAL_CONTINUATION_LIMIT}/${GOAL_CONTINUATION_LIMIT}`);
}, 20_000);

test("a continued turn without any tool call (no progress) is not continued again", async () => {
	const { say, continuations } = await setup(premature("talk"));
	expect((await say("do it")).status).toBe("done");
	expect(continuations).toHaveLength(1);
}, 20_000);

test("an unmet criterion gets a bounded recheck, then a blocker report without tools stops", async () => {
	const { say, continuations } = await setup(premature("block"));
	expect((await say("do it")).status).toBe("done");
	expect(continuations).toHaveLength(2);
	expect(continuations[1]).toContain("[unmet]");
}, 20_000);

test("a new input gets its own continuation budget", async () => {
	const { say, continuations } = await setup((user, results) => {
		if (user === "again") return fauxAssistantMessage("still later");
		return premature("talk")(user, results);
	});
	await say("do it");
	expect(continuations).toHaveLength(1);
	await say("again");
	expect(continuations).toHaveLength(2);
}, 20_000);

test("no continuation while a background subagent runs: its completion wakes the conversation instead", async () => {
	const child = Promise.withResolvers<void>();
	const wakes: string[] = [];
	const { say, continuations } = await setup(async (user, results) => {
		if (user === "slow child") { await child.promise; return fauxAssistantMessage("child done"); }
		if (user === "do it") return results === 0 ? call("goal_set", goal) : results === 1 ? call("task", { description: "slow", prompt: "slow child", run_in_background: true }) : fauxAssistantMessage("started; I will report back");
		if (user.startsWith(WAKE_PREFIX)) { if (!results) wakes.push(user); return results ? fauxAssistantMessage("child finished") : call("goal_update", { expected_revision: 1, criteria: [{ id: "shipped", status: "met", evidence: "child done" }], status: "achieved" }); }
		return undefined;
	});
	await say("do it");
	expect(continuations).toEqual([]);
	child.resolve();
	const end = Date.now() + 10_000;
	while (!wakes.length && Date.now() < end) await Bun.sleep(20);
	expect(wakes).toHaveLength(1);
	await Bun.sleep(150);
	expect(continuations).toEqual([]);
}, 20_000);

test("no continuation while a question to the human is open", async () => {
	const { say, continuations } = await setup((user, results) => {
		if (user === "do it") return results === 0 ? call("goal_set", goal) : results === 1 ? call("ask", { to: "human", kind: "decision", question: "Which fixture?", options: ["a", "b"], default: "a" }) : fauxAssistantMessage("asked which fixture");
		return undefined;
	});
	expect((await say("do it")).status).toBe("done");
	expect(continuations).toEqual([]);
}, 20_000);

test("a turn the user aborts is never continued", async () => {
	const writing = Promise.withResolvers<void>();
	const started = Promise.withResolvers<void>();
	const { parent, continuations } = await setup(async (user, results) => {
		if (user === "do it") {
			if (!results) return call("goal_set", goal);
			started.resolve();
			await writing.promise;
			return fauxAssistantMessage("I will do it later");
		}
		return undefined;
	});
	const submission = await parent.submit({ type: "input", content: "do it" }, context);
	await started.promise;
	const aborting = parent.abort(context);
	await Bun.sleep(50);
	writing.resolve();
	await aborting;
	const settled = await submission.wait(context);
	expect(settled.status).toBe("unanswered");
	await Bun.sleep(150);
	expect(continuations).toEqual([]);
}, 20_000);

test("continuations share the budget of the human input across the runs that wakes start", async () => {
	const child = Promise.withResolvers<void>();
	let round = 0;
	const { say, continuations } = await setup(async (user, results) => {
		if (user === "slow child") { await child.promise; return fauxAssistantMessage("child done"); }
		if (user === "do it") return results ? fauxAssistantMessage("I will do it later") : call("goal_set", goal);
		if (user.startsWith(GOAL_CONTINUATION_PREFIX)) {
			if (results) return fauxAssistantMessage("still later");
			round++;
			// The second continuation starts background work, so the human run ends with something pending.
			return round === 2 ? call("task", { description: "slow", prompt: "slow child", run_in_background: true }) : call("goal_read", {});
		}
		if (user.startsWith(WAKE_PREFIX)) return results ? fauxAssistantMessage("child finished; still later") : call("task_output", { block: false });
		return undefined;
	});
	await say("do it");
	expect(continuations).toHaveLength(2);
	child.resolve();
	const end = Date.now() + 10_000;
	while (continuations.length < 3 && Date.now() < end) await Bun.sleep(20);
	await Bun.sleep(250);
	// 2 in the human run + 1 in the woken run = the limit; the woken run does not get a fresh budget of 3.
	expect(continuations).toHaveLength(GOAL_CONTINUATION_LIMIT);
}, 20_000);

test("a subagent whose own DAG waits on an ask node it cannot answer still answers promptly", async () => {
	const plan = { nodes: [{ id: "q", kind: "ask", description: "Which fixture?" }, { id: "v", kind: "verify", description: "check", covers: ["R"] }], edges: [["q", "v"]], goal: { requirements: ["R"] } };
	const { messages, say } = await setup((user, results) => {
		if (user === "gated child") return results ? fauxAssistantMessage("CHILD: started a gated DAG") : call("dag_run", { plan });
		if (user === "delegate") return results ? fauxAssistantMessage("parent done") : call("task", { description: "gated", prompt: "gated child" });
		return undefined;
	});
	const started = Date.now();
	await say("delegate");
	expect(Date.now() - started).toBeLessThan(10_000); // not the ask node's 24 h deadline
	const result = (await messages()).find((m) => m.role === "toolResult" && m.toolName === "task");
	expect(text(result?.content)).toContain("CHILD: started a gated DAG");
}, 20_000);

test("a subagent that answers while its own DAG runs gets the run's outcome and its answer reflects it", async () => {
	const plan = {
		nodes: [
			{ id: "implement", kind: "delegate", description: "implement", writes: ["out"] },
			{ id: "review", kind: "verify", description: "review", reads: ["out"], covers: ["R"] },
		],
		edges: [["implement", "review"]],
		goal: { requirements: ["R"] },
	};
	const childWakes: string[] = [];
	const { messages, say } = await setup((user, results) => {
		const node = /plan node "([^"]+)"/.exec(user)?.[1];
		if (node === "implement") return fauxAssistantMessage("implemented");
		if (node === "review") return fauxAssistantMessage(JSON.stringify({ version: 1, requirements: [{ id: "R", verdict: "fail", evidence: "XLSX corrupts literals" }], summary: "fail", repairable: true }));
		if (user === "dag child") return results ? fauxAssistantMessage("CHILD: started a DAG, it will finish later") : call("dag_run", { plan });
		if (user.startsWith(WAKE_PREFIX)) {
			if (!results) { childWakes.push(user); return call("dag_status", {}); }
			return fauxAssistantMessage("CHILD FINAL: the review failed: XLSX corrupts literals");
		}
		if (user === "delegate") return results ? fauxAssistantMessage("parent done") : call("task", { description: "dag", prompt: "dag child" });
		return undefined;
	});
	await say("delegate");
	const result = (await messages()).find((m) => m.role === "toolResult" && m.toolName === "task");
	expect(text(result?.content)).toContain("CHILD FINAL: the review failed");
	expect(childWakes).toHaveLength(1);
	expect(childWakes[0]).toContain("You are a subagent");
	expect(childWakes[0]).toContain("stopped: blocked");
}, 30_000);

for (const goalStatus of ["absent", "active", "achieved", "abandoned"] as const) {
	for (const todoStatus of ["pending", "in_progress"] as const) {
		test(`${goalStatus} goal: ${todoStatus} TODO gets reconciled without automatic completion`, async () => {
			const { bot, parent, say, continuations } = await setup((user, results) => {
				if (user.startsWith(GOAL_CONTINUATION_PREFIX)) return fauxAssistantMessage("Checks are still unverified");
				if (results === 0) return call("todo_write", { todos: [{ id: "verify", content: "Verify fixture", status: todoStatus }] });
				if (goalStatus !== "absent" && results === 1) return call("goal_set", goal);
				if (goalStatus !== "absent" && goalStatus !== "active" && results === 2) return call("goal_update", { expected_revision: 1, criteria: goalStatus === "achieved" ? [{ id: "shipped", status: "met", evidence: "fixture shipped" }] : [], status: goalStatus });
				return fauxAssistantMessage("report only");
			});
			expect((await say("do it")).status).toBe("done");
			expect(continuations).toHaveLength(1);
			expect(continuations[0]).toContain(`[${todoStatus}] verify: Verify fixture`);
			expect((await bot.harness.snapshot(TodoDoc, parent.id, context))?.todos[0]?.status).toBe(todoStatus);
		});
	}
}

test("TODO reconciliation can update the list and end without creating a goal", async () => {
	const { bot, parent, say, continuations } = await setup((user, results) => {
		if (user.startsWith(GOAL_CONTINUATION_PREFIX)) return results ? fauxAssistantMessage("verified") : call("todo_write", { todos: [{ id: "verify", status: "completed" }] });
		return results ? fauxAssistantMessage("verified, forgot the list") : call("todo_write", { todos: [{ id: "verify", content: "Verify fixture", status: "in_progress" }] });
	});
	expect((await say("do it")).status).toBe("done");
	expect(continuations).toHaveLength(1);
	expect((await bot.harness.snapshot(TodoDoc, parent.id, context))?.todos[0]?.status).toBe("completed");
	expect((await bot.harness.snapshot(GoalDoc, parent.id, context))?.goal).toBeUndefined();
});

test.each(["completed", "cancelled"])("terminal %s TODOs do not continue a turn", async (status) => {
	const { say, continuations } = await setup((_user, results) => results ? fauxAssistantMessage("done") : call("todo_write", { todos: [{ id: "verify", content: "Verify fixture", status }] }));
	expect((await say("do it")).status).toBe("done");
	expect(continuations).toEqual([]);
});

test("TODO-only waiting on a human does not continue", async () => {
	const { say, continuations } = await setup((_user, results) => results === 0
		? call("todo_write", { todos: [{ id: "verify", content: "Verify fixture" }] })
		: results === 1 ? call("ask", { to: "human", kind: "decision", question: "Which fixture?", options: ["a", "b"], default: "a" }) : fauxAssistantMessage("waiting for your answer"));
	expect((await say("do it")).status).toBe("done");
	expect(continuations).toEqual([]);
});

test("TODO reconciliation waits for a running child and then follows its wake", async () => {
	const child = Promise.withResolvers<void>();
	const reconciled = Promise.withResolvers<void>();
	const { bot, parent, say, continuations } = await setup(async (user, results) => {
		if (user === "slow child") { await child.promise; return fauxAssistantMessage("child done"); }
		if (user === "do it") return results === 0 ? call("todo_write", { todos: [{ id: "verify", content: "Verify child result", status: "in_progress" }] }) : results === 1 ? call("task", { description: "slow", prompt: "slow child", run_in_background: true }) : fauxAssistantMessage("waiting for child");
		if (user.startsWith(WAKE_PREFIX)) return fauxAssistantMessage("child finished; forgot TODO");
		if (user.startsWith(GOAL_CONTINUATION_PREFIX)) {
			if (!results) return call("todo_write", { todos: [{ id: "verify", status: "completed" }] });
			reconciled.resolve();
			return fauxAssistantMessage("verified child result");
		}
		return undefined;
	});
	try {
		expect((await say("do it")).status).toBe("done");
		expect(continuations).toEqual([]);
	} finally { child.resolve(); }
	await reconciled.promise;
	expect(continuations).toHaveLength(1);
	expect((await bot.harness.snapshot(TodoDoc, parent.id, context))?.todos[0]?.status).toBe("completed");
}, 20_000);

test("an initially unmet goal is not mistaken for completion", async () => {
	const { bot, parent, say, continuations } = await setup((user, results) => {
		if (user.startsWith(GOAL_CONTINUATION_PREFIX)) return results ? fauxAssistantMessage("fixed and verified") : call("goal_update", { expected_revision: 2, criteria: [{ id: "shipped", status: "met", evidence: "repaired and shipped" }], status: "achieved" });
		return results === 0 ? call("goal_set", goal) : results === 1 ? call("goal_update", { expected_revision: 1, criteria: [{ id: "shipped", status: "unmet", evidence: "test failed; repair still possible" }] }) : fauxAssistantMessage("test failed");
	});
	expect((await say("do it")).status).toBe("done");
	expect(continuations).toHaveLength(1);
	expect(continuations[0]).toContain("test failed; repair still possible");
	expect((await bot.harness.snapshot(GoalDoc, parent.id, context))?.goal?.status).toBe("achieved");
});

test("TODO-only tool use cannot evade the continuation budget", async () => {
	const { say, continuations } = await setup((user, results) => {
		if (user.startsWith(GOAL_CONTINUATION_PREFIX)) return results ? fauxAssistantMessage("later") : call("goal_read", {});
		return results ? fauxAssistantMessage("later") : call("todo_write", { todos: [{ id: "verify", content: "Verify fixture" }] });
	});
	expect((await say("do it")).status).toBe("done");
	expect(continuations).toHaveLength(GOAL_CONTINUATION_LIMIT);
});
