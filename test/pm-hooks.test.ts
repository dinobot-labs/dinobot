import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { type Bot, openBot } from "../src/core/bot.ts";
import { PLUGIN_CONTINUATION_LIMIT, pluginContinuationPrefix } from "../src/extensions/plugin-hooks.ts";
import { pmPlugin } from "../src/plugins/pm/index.ts";
import { loadPlugin } from "../src/plugins/types.ts";

/**
 * ADR 0105: a plugin's onTurnEnd hook sees committed host facts when a top-level turn ends and may continue the run.
 * With the pm plugin, a ledger that still has ready work and idle WIP capacity keeps the PM working instead of ending
 * on a status report; the continuation is bounded per human input and stops after a continued turn without a tool call.
 */
const context = BACKGROUND_CONTEXT;
const bots: Bot[] = [];
const dirs: string[] = [];
afterEach(async () => { for (const bot of bots.splice(0)) await bot.close(context).catch(() => undefined); });
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
const text = (content: unknown) => (typeof content === "string" ? content : JSON.stringify(content));
const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage(fauxToolCall(name, args as never), { stopReason: "toolUse" });
const PREFIX = pluginContinuationPrefix("pm");

type Reply = Awaited<ReturnType<FauxResponseFactory>>;
async function setup(onContinuation: (results: number, n: number) => Reply) {
	const root = mkdtempSync(join(tmpdir(), "pm-hooks-"));
	dirs.push(root);
	const plugin = await loadPlugin(pmPlugin, { root });
	if (Array.isArray(plugin)) throw new Error(plugin.join("; "));
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	const continuations: string[] = [];
	const router: FauxResponseFactory = async (t) => {
		const last = t.messages.findLastIndex((m) => m.role === "user");
		const user = text(t.messages[last]?.content);
		const results = t.messages.slice(last + 1).filter((m) => m.role === "toolResult").length;
		if (user === "plan it") {
			if (results === 0) return call("pm_create_ledger", { id: "work", title: "Work", wipLimit: 2 });
			if (results === 1) return call("pm_add_items", { ledger: "work", items: [{ id: "A", title: "first" }, { id: "B", title: "second", deps: ["A"] }] });
			return fauxAssistantMessage("Planned two items; I will report back.");
		}
		if (user.startsWith(PREFIX)) {
			if (results === 0) continuations.push(user);
			return onContinuation(results, continuations.length);
		}
		throw new Error(`unexpected ${user} (${results})`);
	};
	faux.setResponses(Array.from({ length: 60 }, () => router));
	const models = createModels();
	models.setProvider(faux.provider);
	const bot = await openBot({ storage: new MemoryStorage(), models, defaultModel: { provider: "faux", modelId: "faux-1" }, toolMode: "direct", plugins: [plugin], settings: { retry: { enabled: false } } }, context);
	bots.push(bot);
	const parent = await bot.conversation("test", "pm-hooks", context);
	const say = async (content: string) => (await parent.submit({ type: "input", content }, context)).wait(context);
	return { say, continuations };
}

test("a ledger with ready work and idle capacity continues the turn until the PM acts on it", async () => {
	const { say, continuations } = await setup((results) =>
		results === 0 ? call("pm_set_status", { ledger: "work", status: "paused", reason: "waiting for the user's go-ahead" }) : fauxAssistantMessage("Paused until you confirm."));
	expect((await say("plan it")).status).toBe("done");
	expect(continuations).toHaveLength(1);
	expect(continuations[0]).toContain("[idle_capacity] 0/2 workers running and 1 items are ready (A)");
	expect(continuations[0]).toContain(`1/${PLUGIN_CONTINUATION_LIMIT}`);
}, 30_000);

test("continuations are capped per human input even when every continued turn calls a tool", async () => {
	const { say, continuations } = await setup((results) => (results === 0 ? call("pm_status", { ledger: "work" }) : fauxAssistantMessage("Still planning.")));
	expect((await say("plan it")).status).toBe("done");
	expect(continuations).toHaveLength(PLUGIN_CONTINUATION_LIMIT);
}, 30_000);

test("a continued turn without a tool call is not continued again", async () => {
	const { say, continuations } = await setup(() => fauxAssistantMessage("I will dispatch later."));
	expect((await say("plan it")).status).toBe("done");
	expect(continuations).toHaveLength(1);
}, 30_000);

test("a worker that finishes is found from host records, and the turn does not end until the PM records it", async () => {
	const root = mkdtempSync(join(tmpdir(), "pm-hooks-"));
	dirs.push(root);
	const plugin = await loadPlugin(pmPlugin, { root });
	if (Array.isArray(plugin)) throw new Error(plugin.join("; "));
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	const release = Promise.withResolvers<void>();
	const continuations: string[] = [];
	let worker = "";
	let recorded = "";
	const router: FauxResponseFactory = async (t) => {
		const last = t.messages.findLastIndex((m) => m.role === "user");
		const user = text(t.messages[last]?.content);
		const after = t.messages.slice(last + 1).filter((m) => m.role === "toolResult");
		const results = after.length;
		if (user === "work on A") { await release.promise; return fauxAssistantMessage("A is finished at abc1234"); }
		if (user === "dispatch") {
			if (results === 0) return call("pm_create_ledger", { id: "w", title: "W", wipLimit: 1 });
			if (results === 1) return call("pm_add_items", { ledger: "w", items: [{ id: "A", title: "a" }, { id: "B", title: "b", deps: ["A"] }] });
			if (results === 2) return call("task", { description: "A", prompt: "work on A", run_in_background: true });
			if (results === 3) {
				worker = /"taskId":\s*"([^"]+)"/.exec(text(after[2]!.content))?.[1] ?? /\b(sa-\d+|\d+)\b/.exec(text(after[2]!.content))?.[1] ?? "";
				return call("pm_transition", { ledger: "w", item: "A", to: "doing", worker });
			}
			return fauxAssistantMessage("A is running; I will report back.");
		}
		if (user.startsWith(PREFIX)) {
			if (results === 0) { continuations.push(user); return call("pm_transition", { ledger: "w", item: "A", to: "blocked", reason: "worker reported no commit" }); }
			recorded = text(after[0]!.content);
			return fauxAssistantMessage("Recorded A as blocked.");
		}
		// The idle wake after the worker finished: the PM only reports, without recording it.
		return fauxAssistantMessage("The worker finished.");
	};
	faux.setResponses(Array.from({ length: 60 }, () => router));
	const models = createModels();
	models.setProvider(faux.provider);
	const bot = await openBot({ storage: new MemoryStorage(), models, defaultModel: { provider: "faux", modelId: "faux-1" }, toolMode: "direct", plugins: [plugin], settings: { retry: { enabled: false } } }, context);
	bots.push(bot);
	const parent = await bot.conversation("test", "pm-worker", context);
	expect((await (await parent.submit({ type: "input", content: "dispatch" }, context)).wait(context)).status).toBe("done");
	expect(worker).not.toBe("");
	// A is doing with a live worker and B waits on A: nothing to find, so the turn ended without a continuation.
	expect(continuations).toEqual([]);
	release.resolve();
	const end = Date.now() + 15_000;
	while (!recorded && Date.now() < end) await Bun.sleep(25);
	expect(continuations).toHaveLength(1);
	expect(continuations[0]).toContain(`[unrecorded_worker] A: worker ${worker} completed`);
	expect(recorded).toContain("worker reported no commit");
	expect(recorded).toMatch(/status\W+blocked/);
}, 30_000);

test("pm tools run from codemode with the calling conversation attributed, so ownership holds there too", async () => {
	const root = mkdtempSync(join(tmpdir(), "pm-hooks-"));
	dirs.push(root);
	const plugin = await loadPlugin(pmPlugin, { root });
	if (Array.isArray(plugin)) throw new Error(plugin.join("; "));
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	let result = "";
	faux.setResponses([
		() => call("codemode", { code: 'await tools.pm_create_ledger({ id: "cm", title: "CM" }); const s = await tools.pm_status({ ledger: "cm" }); text(s);' }),
		(t) => { result = text(t.messages.at(-1)); return fauxAssistantMessage("done"); },
	]);
	const models = createModels();
	models.setProvider(faux.provider);
	const bot = await openBot({ storage: new MemoryStorage(), models, defaultModel: { provider: "faux", modelId: "faux-1" }, toolMode: "codemode-only", plugins: [plugin], settings: { retry: { enabled: false } } }, context);
	bots.push(bot);
	const parent = await bot.conversation("test", "pm-codemode", context);
	expect((await (await parent.submit({ type: "input", content: "make a ledger" }, context)).wait(context)).status).toBe("done");
	expect(result).toMatch(new RegExp(`owner\\W+${String(parent.id)}\\W`));
}, 30_000);
