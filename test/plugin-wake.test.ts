import { afterEach, expect, spyOn, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createSlackChannel } from "../src/channels/slack.ts";
import { LinkDoc } from "../src/core/ask.ts";
import { type Bot, openBot } from "../src/core/bot.ts";
import { channelHandler } from "../src/core/channel-handler.ts";
import { rotateThread } from "../src/core/threads.ts";
import { isHostWakeRequest, PLUGIN_WAKE_REQUEST_PREFIX, WAKE_REQUEST_PREFIX, WakeDoc } from "../src/extensions/subagents.ts";
import { definePlugin, loadPlugin, type LoadedPlugin, type PluginRuntime } from "../src/plugins/types.ts";
import { forbiddenCommands } from "./fixtures/channel-e2e-child.ts";

/**
 * ADR 0106: a plugin (the calendar) asks the host for a turn in the conversation where something was registered; the
 * turn's answer reaches that conversation's channel thread like any woken answer (ADR 0096), and one key starts at most
 * one turn, ever.
 */
const context = BACKGROUND_CONTEXT;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step().catch(() => undefined); });
const text = (content: unknown) => typeof content === "string" ? content : JSON.stringify(content);
const userText = (content: string) => content.replace(/^<from user="[^"]*" channel="[^"]*"\/>\n/, "");
async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 10_000) {
	const end = Date.now() + ms;
	while (!(await ok())) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(20);
	}
}

const WAKE_FRAME = "<from host=\"plugin:testwake\"/>\n";

type Model = { woken: string[]; slowStarted: PromiseWithResolvers<void>; slowGate: PromiseWithResolvers<void>; childGate: PromiseWithResolvers<void> };
function responder(model: Model): FauxResponseFactory {
	return async (t) => {
		const raw = text(t.messages.findLast((m) => m.role === "user")?.content);
		if (raw.startsWith(WAKE_FRAME)) {
			const reminder = raw.slice(WAKE_FRAME.length);
			model.woken.push(reminder);
			return fauxAssistantMessage(`WOKEN: ${reminder}`);
		}
		const user = userText(raw);
		const results = t.messages.slice(t.messages.findLastIndex((m) => m.role === "user") + 1).filter((m) => m.role === "toolResult");
		if (user === "child work") { await model.childGate.promise; return fauxAssistantMessage("CHILD-DONE"); }
		if (user === "start child") {
			if (results.length) return fauxAssistantMessage("STARTED");
			return fauxAssistantMessage(fauxToolCall("task", { description: "slow", prompt: "child work", run_in_background: true }), { stopReason: "toolUse" });
		}
		if (raw.startsWith("<from host=\"subagents\"/>")) return fauxAssistantMessage("CHILD-WAKE");
		if (user === "slow") { model.slowStarted.resolve(); await model.slowGate.promise; return fauxAssistantMessage("SLOW-ANSWER"); }
		if (user === "hello") return fauxAssistantMessage("HELLO-ANSWER");
		throw new Error(`unexpected ${raw}`);
	};
}

/** A plugin whose start captures the host runtime, loaded through loadPlugin (the bound `start`). */
async function wakePlugin() {
	const captured: { runtime?: PluginRuntime; starts: number } = { starts: 0 };
	const loaded = await loadPlugin(definePlugin({
		id: "testwake", config: Type.Object({}, { additionalProperties: false }),
		load: () => ({ tools: [], start(runtime: PluginRuntime) { captured.runtime = runtime; captured.starts++; } }),
	}), {});
	if (Array.isArray(loaded)) throw new Error(loaded.join("; "));
	return { plugin: loaded as LoadedPlugin, captured };
}

async function openWakeBot(dir: string) {
	const model: Model = { woken: [], slowStarted: Promise.withResolvers<void>(), slowGate: Promise.withResolvers<void>(), childGate: Promise.withResolvers<void>() };
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	faux.setResponses(Array.from({ length: 200 }, () => responder(model)));
	const models = createModels();
	models.setProvider(faux.provider);
	const { plugin, captured } = await wakePlugin();
	const bot = await openBot({ storage: await openNodeSqliteStorage(join(dir, "bot.sqlite")), models, defaultModel: { provider: "faux", modelId: "faux-1" }, toolMode: "direct", plugins: [plugin], settings: { retry: { enabled: false } }, hostChannels: ["slack"] }, context);
	cleanup.push(() => bot.close(context));
	expect(captured.starts).toBe(1);
	return { bot, models, model, runtime: captured.runtime! };
}
async function tempDir() {
	const dir = await mkdtemp(join(tmpdir(), "dinobot-plugin-wake-"));
	cleanup.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

// ---- Slack ----------------------------------------------------------------------------------------------------------

const slackSecret = "0123456789abcdef0123456789abcdef";
process.env.SLACK_PLUGIN_WAKE_SECRET = slackSecret;
process.env.SLACK_PLUGIN_WAKE_TOKEN = "xoxb-fake-test-only";
const nativeFetch = globalThis.fetch;
function slackApi() {
	const posts: { channel: string; thread_ts: string; text: string }[] = [];
	let n = 0;
	const fake = spyOn(globalThis, "fetch").mockImplementation((async (url: string | URL | Request, init: RequestInit = {}) => {
		if (!String(url).startsWith("https://slack.com/api/")) return nativeFetch(url, init);
		if (String(url) === "https://slack.com/api/chat.postMessage") posts.push(JSON.parse(String(init.body)));
		return Response.json({ ok: true, ts: `1791165000.${String(++n).padStart(6, "0")}` });
	}) as typeof fetch);
	cleanup.push(async () => fake.mockRestore());
	return posts;
}
async function startSlack(bot: Bot, dir: string) {
	const channel = createSlackChannel({ port: 0, databasePath: join(dir, "inbox.db"), signingSecretEnv: "SLACK_PLUGIN_WAKE_SECRET", botTokenEnv: "SLACK_PLUGIN_WAKE_TOKEN", appId: "A123", teamId: "T123", botUserId: "UBOT", allowedUserIds: ["U123"], allowedChannelIds: ["C123"] });
	await channel.start(channelHandler(channel, bot, forbiddenCommands(), context));
	cleanup.push(() => channel.stop());
	bot.attachChannel(channel);
	return channel;
}
const root = "1791164999.000001";
async function slackMessage(channel: ReturnType<typeof createSlackChannel>, n: number, message: string) {
	const body = JSON.stringify({ type: "event_callback", api_app_id: "A123", team_id: "T123", event_id: "Ev" + n, event: { type: "app_mention", user: "U123", channel: "C123", ts: n === 1 ? root : `17911650${String(n).padStart(2, "0")}.000001`, ...(n === 1 ? {} : { thread_ts: root }), text: "<@UBOT> " + message } });
	const time = String(Math.floor(Date.now() / 1000));
	const signature = "v0=" + createHmac("sha256", slackSecret).update("v0:" + time + ":" + body).digest("hex");
	const response = await nativeFetch(new URL("/webhook", channel.url()), { method: "POST", headers: { "content-type": "application/json", "x-slack-request-timestamp": time, "x-slack-signature": signature }, body });
	expect(response.status).toBe(200);
}
const slackThread = JSON.stringify(["A123", "T123", "C123", root, "U123"]);
const userEntries = async (bot: Bot, id: ConversationId) => {
	const conversation = (await bot.harness.conversation(id, context))!;
	return (await conversation.entries({}, 200, undefined, context)).items
		.flatMap((entry) => entry.model ?? []).filter((message) => message.role === "user").map((message) => text(message.content));
};

test("Slack: a plugin wake runs one turn with the framed text and posts its answer to the same thread once; the same key is a duplicate", async () => {
	const posts = slackApi();
	const dir = await tempDir();
	const { bot, model, runtime } = await openWakeBot(dir);
	const channel = await startSlack(bot, dir);
	await slackMessage(channel, 1, "hello");
	await until("the first answer", () => posts.some((p) => p.text.includes("HELLO-ANSWER")));
	const conversation = await bot.conversation("slack", slackThread, context);

	expect(await runtime.wake({ conversationId: String(conversation.id), key: "evt_1:1000:60:prepare", text: "reminder A" })).toBe("admitted");
	await until("the woken answer in Slack", () => posts.some((p) => p.text.includes("WOKEN: reminder A")));
	const woken = posts.filter((p) => p.text.includes("WOKEN"));
	expect(woken).toHaveLength(1);
	expect(woken[0]).toMatchObject({ channel: "C123", thread_ts: root });
	expect(await userEntries(bot, conversation.id)).toContain(`${WAKE_FRAME}reminder A`);
	const record = await bot.harness.commit((tx) => tx.submissionByRequest(conversation.id, `${PLUGIN_WAKE_REQUEST_PREFIX}testwake:evt_1:1000:60:prepare`), context);
	expect(record?.status).toBe("done");

	expect(await runtime.wake({ conversationId: String(conversation.id), key: "evt_1:1000:60:prepare", text: "reminder A again" })).toBe("duplicate");
	await Bun.sleep(1_500); // past the wake watcher's next look
	expect(model.woken).toEqual(["reminder A"]);
	expect(posts.filter((p) => p.text.includes("WOKEN"))).toHaveLength(1);
}, 30_000);

test("Slack: a plugin wake while the conversation is busy queues behind the running turn and is delivered after it", async () => {
	const posts = slackApi();
	const dir = await tempDir();
	const { bot, model, runtime } = await openWakeBot(dir);
	const channel = await startSlack(bot, dir);
	await slackMessage(channel, 1, "slow");
	await model.slowStarted.promise;
	const conversation = await bot.conversation("slack", slackThread, context);
	const requestId = `${PLUGIN_WAKE_REQUEST_PREFIX}testwake:busy`;
	const delivery = async () => (await bot.harness.snapshot(WakeDoc, conversation.id, context))?.deliveries?.find((item) => item.requestId === requestId);
	const age = async (since: number) => bot.harness.commit(async (tx) => {
		const doc = await tx.doc(WakeDoc, conversation.id);
		const item = doc.deliveries?.find((entry) => entry.requestId === requestId);
		if (item) item.since = since;
		else doc.deliveries = [...(doc.deliveries ?? []), { requestId, since, asks: [] }];
		return undefined;
	}, context);
	// A registration a crash left long ago (past the admission grace): re-registering restarts its grace.
	await age(Date.now() - 600_000);
	const before = Date.now();
	expect(await runtime.wake({ conversationId: String(conversation.id), key: "busy", text: "reminder B" })).toBe("admitted");
	expect((await delivery())!.since).toBeGreaterThanOrEqual(before);
	// A duplicate of a still queued input restarts it too.
	await age(Date.now() - 600_000);
	const again = Date.now();
	expect(await runtime.wake({ conversationId: String(conversation.id), key: "busy", text: "reminder B again" })).toBe("duplicate");
	expect((await delivery())!.since).toBeGreaterThanOrEqual(again);
	await Bun.sleep(200);
	expect(model.woken).toEqual([]); // queued, not run inside the busy turn
	model.slowGate.resolve();
	await until("the woken answer in Slack", () => posts.some((p) => p.text.includes("WOKEN: reminder B")));
	await Bun.sleep(1_500);
	expect(posts.filter((p) => p.text.includes("SLOW-ANSWER"))).toHaveLength(1);
	const woken = posts.filter((p) => p.text.includes("WOKEN: reminder B"));
	expect(woken).toHaveLength(1);
	expect(woken[0]).toMatchObject({ channel: "C123", thread_ts: root });
	// The woken answer never arrives before the reply to the message that was running.
	const slow = posts.findIndex((p) => p.text.includes("SLOW-ANSWER"));
	const wake = posts.findIndex((p) => p.text.includes("WOKEN: reminder B"));
	expect(wake === slow ? posts[slow]!.text.indexOf("WOKEN") < posts[slow]!.text.indexOf("SLOW") : wake > slow).toBe(true);
	expect(model.woken).toEqual(["reminder B"]);
}, 30_000);

test("Slack: a subagent conversation wakes its top-level conversation, and after /new the thread's new conversation", async () => {
	const posts = slackApi();
	const dir = await tempDir();
	const { bot, models, model, runtime } = await openWakeBot(dir);
	const channel = await startSlack(bot, dir);
	await slackMessage(channel, 1, "hello");
	await until("the first answer", () => posts.some((p) => p.text.includes("HELLO-ANSWER")));
	const top = await bot.conversation("slack", slackThread, context);
	// A child conversation of the thread's conversation, and a grandchild of that child.
	const [child, grandchild] = await bot.harness.commit(async (tx) => {
		const a = await tx.createConversation({ ownership: { kind: "ownerless" } });
		(await tx.doc(LinkDoc, a.id)).parent = top.id;
		const b = await tx.createConversation({ ownership: { kind: "ownerless" } });
		(await tx.doc(LinkDoc, b.id)).parent = a.id;
		return [a.id, b.id] as const;
	}, context);

	expect(await runtime.wake({ conversationId: String(grandchild), key: "from-child", text: "reminder C" })).toBe("admitted");
	await until("the woken answer in Slack", () => posts.some((p) => p.text.includes("WOKEN: reminder C")));
	expect(await userEntries(bot, top.id)).toContain(`${WAKE_FRAME}reminder C`);
	expect(await userEntries(bot, child)).toEqual([]);
	expect(posts.find((p) => p.text.includes("WOKEN: reminder C"))).toMatchObject({ channel: "C123", thread_ts: root });

	expect((await rotateThread(bot.harness, models, `slack:${slackThread}`, top.id, "new-1", context)).status).toBe("rotated");
	const current = await bot.conversation("slack", slackThread, context);
	expect(current.id).not.toBe(top.id);
	// The archived conversation (and its subagents) resolve to the conversation now bound to the thread.
	expect(await runtime.wake({ conversationId: String(child), key: "after-new", text: "reminder D" })).toBe("admitted");
	await until("the woken answer in Slack", () => posts.some((p) => p.text.includes("WOKEN: reminder D")));
	expect(await userEntries(bot, current.id)).toContain(`${WAKE_FRAME}reminder D`);
	expect(await userEntries(bot, top.id)).not.toContain(`${WAKE_FRAME}reminder D`);
	expect(posts.find((p) => p.text.includes("WOKEN: reminder D"))).toMatchObject({ channel: "C123", thread_ts: root });
	// A key admitted before /new is still a duplicate in the new conversation.
	expect(await runtime.wake({ conversationId: String(top.id), key: "from-child", text: "reminder C again" })).toBe("duplicate");
	await Bun.sleep(1_500);
	expect(model.woken).toEqual(["reminder C", "reminder D"]);
	expect(posts.filter((p) => p.text.includes("WOKEN"))).toHaveLength(2);
}, 30_000);

test("Slack: a plugin wake is delivered while the wake watcher waits on a running background subagent", async () => {
	const posts = slackApi();
	const dir = await tempDir();
	const { bot, model, runtime } = await openWakeBot(dir);
	const channel = await startSlack(bot, dir);
	await slackMessage(channel, 1, "start child");
	await until("the first answer", () => posts.some((p) => p.text.includes("STARTED")));
	const conversation = await bot.conversation("slack", slackThread, context);
	// The watcher is live and waits for the child; the plugin's hand-over must not wait for the child too.
	await until("the wake watcher", async () => (await bot.harness.snapshot(WakeDoc, conversation.id, context))?.task !== undefined);
	await Bun.sleep(200);
	expect(await runtime.wake({ conversationId: String(conversation.id), key: "while-child", text: "reminder E" })).toBe("admitted");
	await until("the woken answer in Slack while the child still runs", () => posts.some((p) => p.text.includes("WOKEN: reminder E")));
	expect(posts.some((p) => p.text.includes("CHILD-WAKE"))).toBe(false);
	model.childGate.resolve();
	await until("the child's wake", () => posts.some((p) => p.text.includes("CHILD-WAKE")));
	expect(posts.filter((p) => p.text.includes("WOKEN: reminder E"))).toHaveLength(1);
}, 30_000);

test("Slack: a hand-over registered before a crash, without its input, waits for the plugin's retry and is posted once", async () => {
	const posts = slackApi();
	const dir = await tempDir();
	const first = await openWakeBot(dir);
	const conversation = await first.bot.conversation("slack", slackThread, context);
	const requestId = `${PLUGIN_WAKE_REQUEST_PREFIX}testwake:crash`;
	// What a process left when it stopped between the two steps: the registration, no input.
	await first.bot.harness.commit(async (tx) => {
		const doc = await tx.doc(WakeDoc, conversation.id);
		doc.deliveries = [...(doc.deliveries ?? []), { requestId, since: Date.now(), asks: [] }];
		return undefined;
	}, context);
	await first.bot.close(context);
	const { bot, model, runtime } = await openWakeBot(dir);
	await startSlack(bot, dir);
	const pending = async () => ((await bot.harness.snapshot(WakeDoc, conversation.id, context))?.deliveries ?? []).some((item) => item.requestId === requestId);
	// Startup recovery armed the watcher; within the admission grace it keeps the registration for the input to come.
	await until("the recovered watcher", async () => (await bot.harness.snapshot(WakeDoc, conversation.id, context))?.task !== undefined);
	await Bun.sleep(1_500);
	expect(await pending()).toBe(true);
	expect(await runtime.wake({ conversationId: String(conversation.id), key: "crash", text: "reminder F" })).toBe("admitted");
	await until("the woken answer in Slack", () => posts.some((p) => p.text.includes("WOKEN: reminder F")));
	await Bun.sleep(1_500);
	expect(posts.filter((p) => p.text.includes("WOKEN: reminder F"))).toHaveLength(1);
	expect(posts[0]).toMatchObject({ channel: "C123", thread_ts: root });
	expect(model.woken).toEqual(["reminder F"]);
	await until("the hand-over to settle", async () => !(await pending()));
}, 30_000);

test("plugin wake: a key admitted before a restart is a duplicate after it", async () => {
	const dir = await tempDir();
	const first = await openWakeBot(dir);
	const conversation = await first.bot.conversation("tui", "t1", context);
	expect(await first.runtime.wake({ conversationId: String(conversation.id), key: "once", text: "reminder G" })).toBe("admitted");
	await until("the woken turn", () => first.model.woken.length === 1);
	await first.bot.close(context);
	const second = await openWakeBot(dir);
	expect(await second.runtime.wake({ conversationId: String(conversation.id), key: "once", text: "reminder G" })).toBe("duplicate");
	await Bun.sleep(300);
	expect(second.model.woken).toEqual([]);
}, 30_000);

test("plugin wake: unknown conversations are gone, invalid requests throw, and a closed bot is unavailable", async () => {
	const dir = await tempDir();
	const { bot, model, runtime } = await openWakeBot(dir);
	expect(await runtime.wake({ conversationId: "999999", key: "k", text: "x" })).toBe("gone");
	expect(await runtime.wake({ conversationId: "not-a-number", key: "k", text: "x" })).toBe("gone");
	const conversation = await bot.conversation("tui", "t1", context);
	const id = String(conversation.id);
	await expect(runtime.wake({ conversationId: id, key: "bad key", text: "x" })).rejects.toThrow(/key/);
	await expect(runtime.wake({ conversationId: id, key: "", text: "x" })).rejects.toThrow(/key/);
	await expect(runtime.wake({ conversationId: id, key: "k".repeat(201), text: "x" })).rejects.toThrow(/key/);
	await expect(runtime.wake({ conversationId: id, key: "k", text: "  " })).rejects.toThrow(/empty/);
	await expect(runtime.wake({ conversationId: id, key: "k", text: "가".repeat(5462) })).rejects.toThrow(/bytes/); // 16386 bytes
	// A conversation not bound to a native channel keeps the answer in its own event stream.
	expect(await runtime.wake({ conversationId: id, key: "k", text: "가".repeat(10) })).toBe("admitted");
	await until("the woken turn", () => model.woken.length === 1);
	await bot.close(context);
	expect(await runtime.wake({ conversationId: id, key: "late", text: "x" })).toBe("unavailable");
	await expect(runtime.wake({ conversationId: id, key: "bad key", text: "x" })).rejects.toThrow(/key/);
}, 30_000);

test("isHostWakeRequest recognizes subagent and plugin wakes, not human inputs", () => {
	expect(isHostWakeRequest(`${WAKE_REQUEST_PREFIX}done:1`)).toBe(true);
	expect(isHostWakeRequest(`${PLUGIN_WAKE_REQUEST_PREFIX}calendar:evt_1:1:60:notify`)).toBe(true);
	expect(isHostWakeRequest("slack:Ev1")).toBe(false);
	expect(isHostWakeRequest("plugin:calendar")).toBe(false);
	expect(isHostWakeRequest(undefined)).toBe(false);
});
