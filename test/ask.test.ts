import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonObject, ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { type AskRecord, AsksDoc, askId, expireAsks, resolveAsk } from "../src/core/ask.ts";
import { type Bot, openBot } from "../src/core/bot.ts";
import { AgentsDoc, ProgressDoc } from "../src/extensions/subagents.ts";

const context = BACKGROUND_CONTEXT;
const bots: Bot[] = [];
afterEach(async () => {
	for (const bot of bots.splice(0)) await bot.close(context);
});

type Transcript = Parameters<FauxResponseFactory>[0];
const lastUser = (t: Transcript) => t.messages.findLast((m) => m.role === "user")?.content;
/** The last tool result of the current turn (after the latest user message). */
const lastResult = (t: Transcript) => {
	const turn = t.messages.slice(t.messages.findLastIndex((m) => m.role === "user") + 1);
	const result = turn.findLast((m) => m.role === "toolResult") as ToolResultMessage | undefined;
	return { name: result?.toolName, text: JSON.stringify(result?.content ?? ""), isError: result?.isError === true };
};
const askIdIn = (text: string) => /ask ([0-9a-f]{32})/.exec(text)?.[1];

async function setup(router: FauxResponseFactory) {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	faux.setResponses(Array.from({ length: 40 }, () => router));
	const models = createModels();
	models.setProvider(faux.provider);
	const bot = await openBot({ storage: new MemoryStorage(), models, defaultModel: { provider: "faux", modelId: "faux-1" }, toolMode: "direct", plugins: [], settings: { retry: { enabled: false } } }, context);
	bots.push(bot);
	const parent = await bot.conversation("test", "orchestrator", context);
	const results = async () => (await parent.entries({}, 200, undefined, context)).items.flatMap((e) => e.model ?? [])
		.filter((m): m is ToolResultMessage => m.role === "toolResult");
	const run = async (content: string) => (await parent.submit({ type: "input", content }, context)).wait(context);
	return { bot, parent, results, run };
}

/** Child: ask once, then report the answer it proceeded with. */
const childTurn = (t: Transcript, ask: JsonObject) => {
	const result = lastResult(t);
	if (result.name === "ask") return fauxAssistantMessage(`child proceeded with ${result.text}`);
	return fauxAssistantMessage(fauxToolCall("ask", ask), { stopReason: "toolUse" });
};

describe("ask protocol", () => {
	test("a foreground task returns with the child's ask instead of blocking; answer unblocks the child", async () => {
		const seen: string[] = [];
		const router: FauxResponseFactory = (t) => {
			const user = lastUser(t);
			if (user === "CHILD") return childTurn(t, { question: "Pick A or B?", kind: "decision", options: ["A", "B"], default: "B" });
			const result = lastResult(t);
			seen.push(result.name ?? "none");
			if (result.name === undefined) return fauxAssistantMessage(fauxToolCall("task", { description: "node", prompt: "CHILD" }), { stopReason: "toolUse" });
			if (result.name === "task") {
				expect(result.isError).toBe(false);
				expect(result.text).toContain("waiting for your answer");
				const id = askIdIn(result.text);
				if (!id) throw new Error(`no ask id in ${result.text}`);
				return fauxAssistantMessage(fauxToolCall("answer", { ask_id: id, answer: "A" }), { stopReason: "toolUse" });
			}
			if (result.name === "answer") {
				expect(result.isError).toBe(false);
				expect(result.text).toContain("state: answered; answer: A");
				return fauxAssistantMessage(fauxToolCall("task_output", {}), { stopReason: "toolUse" });
			}
			return fauxAssistantMessage(`orchestrator done: ${result.text}`);
		};
		const { bot, parent, run } = await setup(router);
		const settled = await run("START");
		expect(settled.status).toBe("done");
		expect(seen).toEqual(["none", "task", "answer", "task_output"]);
		const answer = await bot.harness.commit((tx) => tx.entry((settled as { answer: never }).answer), context);
		expect(JSON.stringify(answer?.model)).toContain("answered: A");
		// Promotion: the child became a background subagent so task_output could collect it without ids.
		const agents = await bot.harness.snapshot(AgentsDoc, parent.id, context);
		expect(agents?.agents[0]?.background).toBe(true);
		const progress = await bot.harness.snapshot(ProgressDoc, parent.id, String(agents!.agents[0]!.runnerId), context);
		expect(progress?.subagent?.background).toBe(true);
		expect(progress?.subagent?.status).toBe("completed");
		const asks = await bot.harness.snapshot(AsksDoc, parent.id, context);
		expect(asks?.asks).toHaveLength(1);
		expect(asks?.asks[0]).toMatchObject({ state: "answered", answer: "A", to: "main", kind: "decision", from: { taskId: agents!.agents[0]!.taskId } });
		expect((await bot.harness.inspect(context)).tasks).toEqual([]);
	}, 15_000);

	test.each([0, 1100])("an unanswered ask resolves to its default at the deadline; a late answer is retained, not applied (child startup delay: %i ms)", async (startupDelay) => {
		let askId = "";
		const router: FauxResponseFactory = async (t) => {
			const user = lastUser(t);
			if (user === "CHILD") {
				// Exercise startup consuming the old START-relative sleep before the ask exists.
				if (lastResult(t).name === undefined) await Bun.sleep(startupDelay);
				return childTurn(t, { question: "Retry?", kind: "clarification", default: "no", deadline_ms: 1000 });
			}
			const result = lastResult(t);
			if (result.name === undefined && user === "START") return fauxAssistantMessage(fauxToolCall("task", { description: "node", prompt: "CHILD" }), { stopReason: "toolUse" });
			if (result.name === "task") { askId = askIdIn(result.text) ?? ""; return fauxAssistantMessage("I will decide later"); }
			if (result.name === undefined && user === "LATE") return fauxAssistantMessage(fauxToolCall("answer", { ask_id: askId, answer: "yes" }), { stopReason: "toolUse" });
			if (result.name === undefined && user === "COLLECT") return fauxAssistantMessage(fauxToolCall("task_output", {}), { stopReason: "toolUse" });
			return fauxAssistantMessage(`done: ${result.text}`);
		};
		const { bot, parent, run, results } = await setup(router);
		expect((await run("START")).status).toBe("done");
		expect(askId).toHaveLength(32);
		const readAsk = async () => (await bot.harness.snapshot(AsksDoc, parent.id, context))!.asks.find((ask) => ask.id === askId)!;
		const opened = await readAsk();
		expect(opened.deadlineAt - opened.createdAt).toBe(60000);
		// Virtual wall time plus the real expiry transaction avoids a 60-second sleep.
		// ask-deadline.test.ts separately drives awaitResolution timers at exact boundaries.
		const clock = spyOn(Date, "now").mockReturnValue(opened.deadlineAt);
		try {
		await bot.harness.commit(async tx => { expireAsks(await tx.doc(AsksDoc, parent.id), Date.now()); }, context);
		const resolved = await readAsk();
		expect(resolved).toMatchObject({ state: "defaulted", answer: "no", resolvedBy: "system:deadline" });
		expect(resolved.resolvedAt).toBeGreaterThanOrEqual(opened.deadlineAt);
		expect((await run("COLLECT")).status).toBe("done");
		const output = (await results()).find((r) => r.toolName === "task_output");
		expect(JSON.stringify(output?.content)).toContain("defaulted: no");
		expect((await run("LATE")).status).toBe("done");
		const late = (await results()).find((r) => r.toolName === "answer");
		expect(late?.isError).toBe(true);
		expect(JSON.stringify(late?.content)).toContain("already defaulted (no)");
		const record = (await bot.harness.snapshot(AsksDoc, parent.id, context))!.asks[0]!;
		expect(record).toMatchObject({ state: "defaulted", answer: "no", resolvedBy: "system:deadline", late: { answer: "yes" } });
		} finally { clock.mockRestore(); }
	}, 15_000);

	test("identical questions share one record and the second ask returns the existing resolution", async () => {
		const router: FauxResponseFactory = (t) => {
			const user = lastUser(t);
			if (user === "CHILD") {
				const asks = t.messages.filter((m) => m.role === "toolResult" && (m as ToolResultMessage).toolName === "ask");
				if (asks.length >= 2) return fauxAssistantMessage(`child got ${asks.map((m) => JSON.stringify((m as ToolResultMessage).content)).join(" | ")}`);
				return fauxAssistantMessage(fauxToolCall("ask", { question: "  Which   port? ", kind: "decision", default: "8080" }), { stopReason: "toolUse" });
			}
			const result = lastResult(t);
			if (result.name === undefined) return fauxAssistantMessage(fauxToolCall("task", { description: "node", prompt: "CHILD" }), { stopReason: "toolUse" });
			if (result.name === "task") return fauxAssistantMessage(fauxToolCall("answer", { ask_id: askIdIn(result.text)!, answer: "9090" }), { stopReason: "toolUse" });
			if (result.name === "answer") return fauxAssistantMessage(fauxToolCall("task_output", {}), { stopReason: "toolUse" });
			return fauxAssistantMessage(`done: ${result.text}`);
		};
		const { bot, parent, run, results } = await setup(router);
		expect((await run("START")).status).toBe("done");
		const output = (await results()).find((r) => r.toolName === "task_output");
		expect(JSON.stringify(output?.content).match(/answered: 9090/g)).toHaveLength(2);
		expect((await bot.harness.snapshot(AsksDoc, parent.id, context))!.asks).toHaveLength(1);
	}, 15_000);

	test("routing is enforced: children cannot reach the human or answer; the orchestrator asks the human only for owned variables", async () => {
		const childErrors: string[] = [];
		const router: FauxResponseFactory = (t) => {
			const user = lastUser(t);
			if (user === "CHILD") {
				const results = t.messages.filter((m): m is ToolResultMessage => m.role === "toolResult");
				if (results.length === 2) for (const r of results) if (r.isError) childErrors.push(JSON.stringify(r.content));
				if (results.length === 0) return fauxAssistantMessage(fauxToolCall("ask", { question: "Deploy?", kind: "authority", default: "ignored", to: "human" }), { stopReason: "toolUse" });
				if (results.length === 1) return fauxAssistantMessage(fauxToolCall("ask", { question: "Deploy?", kind: "authority", default: "ignored", relays: "x" }), { stopReason: "toolUse" });
				return fauxAssistantMessage("child done");
			}
			const result = lastResult(t);
			if (user === "START") {
				if (result.name === undefined) return fauxAssistantMessage(fauxToolCall("task", { description: "node", prompt: "CHILD" }), { stopReason: "toolUse" });
				return fauxAssistantMessage("ok");
			}
			if (result.name === undefined) {
				const calls: Record<string, JsonObject> = {
					"TO MAIN": { question: "q", kind: "decision", default: "d", to: "main" },
					"CLARIFY HUMAN": { question: "q", kind: "clarification", default: "d", to: "human" },
					"ACCEPT NO WORK": { question: "q", kind: "acceptance", default: "d", to: "human", refs: ["R1"] },
					"AUTHORITY NO REFS": { question: "q", kind: "authority", default: "allow", to: "human" },
					"EXTERNAL OK": { question: "Is the vendor API key available?", kind: "external", default: "assume unavailable", to: "human", refs: ["vendor-api"] },
				};
				return fauxAssistantMessage(fauxToolCall("ask", calls[String(user)]!), { stopReason: "toolUse" });
			}
			return fauxAssistantMessage(`r: ${result.isError ? "error" : "ok"} ${result.text}`);
		};
		const { bot, parent, run, results } = await setup(router);
		expect((await run("START")).status).toBe("done");
		expect(childErrors).toHaveLength(2);
		expect(childErrors[0]).toContain("cannot address the human");
		expect(childErrors[1]).toContain("Only the orchestrator relays");
		for (const [input, fragment] of [
			["TO MAIN", "no orchestrator above"],
			["ACCEPT NO WORK", "needs an active work contract"],
			["AUTHORITY NO REFS", "requires refs"],
		] as const) {
			expect((await run(input)).status).toBe("done");
			const last = (await results())[0]!; // newest first
			expect(last.toolName, input).toBe("ask");
			expect(last.isError, input).toBe(true);
			expect(JSON.stringify(last.content), input).toContain(fragment);
		}
		expect((await run("CLARIFY HUMAN")).status).toBe("done");
		expect((await results())[0]!.isError).toBe(false);
		expect((await run("EXTERNAL OK")).status).toBe("done");
		const ok = (await results())[0]!;
		expect(ok.isError).toBe(false);
		expect(JSON.stringify(ok.content)).toContain("Relay this question to the human");
		const record = (await bot.harness.snapshot(AsksDoc, parent.id, context))!.asks.find((a) => a.to === "human" && a.kind === "external")!;
		expect(record).toMatchObject({ kind: "external", state: "open", default: "assume unavailable", refs: ["vendor-api"] });
		// authority defaults are pinned to deny regardless of the requested default.
		expect(askId(parent.id, parent.id, "external", ["vendor-api"], " Is the  vendor API key available? ")).toBe(record.id);
	}, 20_000);
});

test("D5 D6 I6 human option bounds, atomic open cap, duplicate reuse and expiry release", async () => {
 let payload: JsonObject = {};
 const { bot, parent, run, results } = await setup((t) => lastResult(t).name === undefined ? fauxAssistantMessage(fauxToolCall(payload.ask_id ? "answer" : "ask", payload), {stopReason:"toolUse"}) : fauxAssistantMessage("done"));
 const ask = async (question:string, kind:string, options?:string[]) => {
  payload = {to:"human",question,kind,default:"A",...(options ? {options} : {}),...(kind === "authority" ? {refs:["deploy"]} : {})};
  await run(question); return (await results())[0]!;
 };
 for (const options of [undefined,["A"],["A","B","C","D","E"],["A","A"],[" A ","A"],[" ","B"]]) expect((await ask("invalid", "decision", options)).isError).toBe(true);
 expect((await ask("authority", "authority", ["A","B","C","D","E"])).isError).toBe(true);
 for (const q of ["one","two","three"]) expect((await ask(q,"decision",["A","B"])).isError).toBe(false);
 expect((await ask("one","decision",["A","B"])).isError).toBe(false);
 expect((await ask("four","clarification")).isError).toBe(true);
 const records = (await bot.harness.snapshot(AsksDoc,parent.id,context))!.asks;
 const id = records[0]!.id;
 payload={ask_id:id,answer:"A",quote:"A"};
 // Resolve through a real human entry and the existing answer tool, not a shortcut.
 const answerTurn = await parent.submit({type:"input",content:'<from user="alice" channel="test"/>\nA'},context);
 await answerTurn.wait(context);
 expect((await results())[0]!.isError).toBe(false);
 expect((await ask("four","clarification")).isError).toBe(false);
 await bot.harness.commit(async tx=>{const d=await tx.doc(AsksDoc,parent.id); d.asks[1]!.deadlineAt=Date.now()-1;},context);
 expect((await ask("five","decision",["A","B"])).isError).toBe(false);
 expect((await bot.harness.snapshot(AsksDoc,parent.id,context))!.asks[1]!.state).toBe("defaulted");
},15000);

describe("human answer provenance", () => {
	test("a human ask is answered only with a quote from a human message written after the question; the record cites the entry and user", async () => {
		let askId = "";
		const router: FauxResponseFactory = (t) => {
			const user = String(lastUser(t));
			const result = lastResult(t);
			if (result.name === "ask") { askId = askIdIn(result.text) ?? ""; return fauxAssistantMessage("Relayed to human"); }
			if (result.name === "answer") return fauxAssistantMessage(`answer → ${result.isError ? "error" : "ok"} ${result.text}`);
			if (user.includes("ASK")) return fauxAssistantMessage(fauxToolCall("ask", { question: "May I delete the staging database?", kind: "authority", default: "allow", to: "human", refs: ["drop-staging"] }), { stopReason: "toolUse" });
			if (user.includes("FORGE")) return fauxAssistantMessage(fauxToolCall("answer", { ask_id: askId, answer: "yes", quote: "go ahead and delete it" }), { stopReason: "toolUse" });
			if (user.includes("NOQUOTE")) return fauxAssistantMessage(fauxToolCall("answer", { ask_id: askId, answer: "yes" }), { stopReason: "toolUse" });
			if (user.includes("OLD")) return fauxAssistantMessage(fauxToolCall("answer", { ask_id: askId, answer: "yes", quote: "delete it later" }), { stopReason: "toolUse" });
			if (user.includes("go ahead")) return fauxAssistantMessage(fauxToolCall("answer", { ask_id: askId, answer: "allow", quote: "go ahead and delete it" }), { stopReason: "toolUse" });
			return fauxAssistantMessage("noted");
		};
		const { bot, parent, run, results } = await setup(router);
		expect((await run("<from user=\"alice\" channel=\"test\"/>\nplease delete it later ... actually ASK first")).status).toBe("done");
		expect(askId).toHaveLength(32);
		const record = () => bot.harness.snapshot(AsksDoc, parent.id, context).then((d) => d!.asks.find((a) => a.id === askId)!);
		expect((await record())).toMatchObject({ to: "human", kind: "authority", default: "deny", state: "open" });
		for (const [input, fragment] of [["FORGE", "No human message after the question contains that quote"], ["NOQUOTE", "needs quote"], ["OLD", "No human message after the question"]] as const) {
			expect((await run(input)).status).toBe("done");
			const last = (await results())[0]!;
			expect(last.isError, input).toBe(true);
			expect(JSON.stringify(last.content), input).toContain(fragment);
			expect((await record()).state).toBe("open");
		}
		expect((await run("<from user=\"alice\" channel=\"test\"/>\nok, go ahead and delete it")).status).toBe("done");
		const last = (await results())[0]!;
		expect(last.isError).toBe(false);
		const resolved = await record();
		expect(resolved).toMatchObject({ state: "answered", answer: "allow", resolvedBy: "human:alice" });
		expect(typeof resolved.sourceEntry).toBe("number");
	}, 20_000);

	test("with an active run, authority refs must be irreversible node ids", async () => {
		const router: FauxResponseFactory = (t) => {
			const user = String(lastUser(t));
			const result = lastResult(t);
			if (result.name !== undefined) return fauxAssistantMessage(`r ${result.isError ? "error" : "ok"}`);
			if (user === "PLAN") return fauxAssistantMessage(fauxToolCall("dag_run", { plan: { nodes: [{ id: "q", kind: "ask" }, { id: "drop", kind: "act", irreversible: true, writes: ["db"] }, { id: "v", kind: "verify", reads: ["db"], covers: ["R"] }], edges: [["q", "drop"], ["drop", "v"]], goal: { requirements: ["R"] } } }), { stopReason: "toolUse" });
			if (user === "BAD") return fauxAssistantMessage(fauxToolCall("ask", { question: "Drop?", kind: "authority", default: "x", to: "human", refs: ["v"] }), { stopReason: "toolUse" });
			return fauxAssistantMessage(fauxToolCall("ask", { question: "Drop?", kind: "authority", default: "x", to: "human", refs: ["drop"] }), { stopReason: "toolUse" });
		};
		const { run, results } = await setup(router);
		expect((await run("PLAN")).status).toBe("done");
		expect((await run("BAD")).status).toBe("done");
		const bad = (await results())[0]!;
		expect(bad.isError).toBe(true);
		expect(JSON.stringify(bad.content)).toContain("not irreversible: v");
		expect((await run("GOOD")).status).toBe("done");
		expect((await results())[0]!.isError).toBe(false);
	}, 20_000);
});

describe("ask resolution algebra", () => {
	const open = (id: string, deadlineAt = Number.MAX_SAFE_INTEGER): AskRecord => ({
		id, from: { conversationId: 1 as never }, to: "main", kind: "decision", refs: [], question: "q", default: "d",
		createdAt: 0, deadlineAt, state: "open",
	});

	test("exactly one of N concurrent resolutions changes the record", () => {
		for (let n = 1; n <= 12; n++) {
			const doc = { asks: [open("a")] };
			const outcomes = Array.from({ length: n }, (_, i) => resolveAsk(doc, "a", { state: i % 2 ? "answered" : "defaulted", answer: `v${i}`, by: `w${i}`, now: i }));
			expect(outcomes.filter((o) => o.changed)).toHaveLength(1);
			expect(outcomes[0]!.changed).toBe(true);
			expect(doc.asks[0]).toMatchObject({ state: "defaulted", answer: "v0", resolvedBy: "w0" });
			expect(resolveAsk(doc, "missing", { state: "answered", by: "x", now: 0 })).toEqual({ record: undefined, changed: false });
		}
	});

	test("expiry is idempotent, moves only due records, and never reopens", () => {
		const doc = { asks: [open("due", 10), open("later", 100), { ...open("done", 1), state: "answered" as const, answer: "x" }] };
		expect(expireAsks(doc, 10)).toEqual(["due"]);
		expect(expireAsks(doc, 10)).toEqual([]);
		expect(doc.asks.map((a) => a.state)).toEqual(["defaulted", "open", "answered"]);
		expect(doc.asks[0]!.answer).toBe("d");
		expect(expireAsks(doc, 1000)).toEqual(["later"]);
		expect(doc.asks[2]!.answer).toBe("x");
	});
});
