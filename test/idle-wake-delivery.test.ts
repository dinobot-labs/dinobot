import { afterEach, expect, spyOn, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createSlackChannel } from "../src/channels/slack.ts";
import { telegramChannel } from "../src/channels/telegram.ts";
import { discordChannel } from "../src/channels/discord.ts";
import type { ChannelAdapter } from "../src/channels/types.ts";
import { type Bot, openBot } from "../src/core/bot.ts";
import { channelHandler } from "../src/core/channel-handler.ts";
import { RunDoc } from "../src/core/dag.ts";
import { rotateThread, threadOfConversation } from "../src/core/threads.ts";
import { WAKE_PREFIX } from "../src/extensions/subagents.ts";
import { forbiddenCommands, secret as telegramSecret, telegramConfig } from "./fixtures/channel-e2e-child.ts";

/**
 * ADR 0096: a channel posts only the answers of the messages it received. Without a hand-over, the answer of a woken
 * turn (sessions 133215 and 137183: "PR #3521 올렸어", the screenshots) stayed in the conversation and the Slack user
 * asked again hours later. A woken answer must reach the thread the conversation belongs to, exactly once.
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

const plan = {
	nodes: [
		{ id: "implement", kind: "delegate", description: "implement the feature", writes: ["out"] },
		{ id: "review", kind: "verify", description: "review the feature", reads: ["out"], covers: ["R"] },
	],
	edges: [["implement", "review"]],
	goal: { requirements: ["R"] },
};
const gatedPlan = {
	nodes: [
		{ id: "gate", kind: "ask", description: "Publish the fixture release?" },
		{ id: "publish", kind: "act", writes: ["release"], irreversible: true },
		{ id: "check", kind: "verify", reads: ["release"], covers: ["P"] },
	],
	edges: [["gate", "publish"], ["publish", "check"]],
	goal: { requirements: ["P"] },
};
const failVerdict = JSON.stringify({ version: 1, requirements: [{ id: "R", verdict: "fail", evidence: "XLSX creator corrupts _x0041_" }], summary: "fail", repairable: true });

/** One orchestrator model for every scenario: it starts the work, answers, and reports when woken. */
function orchestrator(child: Promise<void>, wokenWriting?: Promise<void>, onWokenWriting?: () => void): FauxResponseFactory {
	return async (t) => {
		const user = userText(text(t.messages.findLast((m) => m.role === "user")?.content));
		const results = t.messages.slice(t.messages.findLastIndex((m) => m.role === "user") + 1).filter((m) => m.role === "toolResult");
		const node = /plan node "([^"]+)"/.exec(user)?.[1];
		if (node === "implement") return fauxAssistantMessage("implemented");
		if (node === "review") return fauxAssistantMessage(failVerdict);
		if (user === "slow child") { await child; return fauxAssistantMessage("child result 42"); }
		if (user.startsWith(WAKE_PREFIX)) {
			if (user.includes("needs the human's answer")) return fauxAssistantMessage("WOKEN: your approval is needed before publishing");
			const dag = /DAG run dag-/.test(user);
			if (!results.length) return fauxAssistantMessage(fauxToolCall(dag ? "dag_status" : "task_output", dag ? {} : { block: false }), { stopReason: "toolUse" });
			onWokenWriting?.();
			await wokenWriting;
			return fauxAssistantMessage(dag ? "WOKEN: the review failed; I am fixing it now" : "WOKEN: the child finished with child result 42");
		}
		if (user === "did you finish?") return fauxAssistantMessage("REPLY: yes, see above");
		if (user === "start gated and step") {
			if (!results.length) return fauxAssistantMessage(fauxToolCall("dag_run", { plan: gatedPlan }), { stopReason: "toolUse" });
			if (results.length === 1) return fauxAssistantMessage(fauxToolCall("dag_step", {}), { stopReason: "toolUse" });
			return fauxAssistantMessage("RELAYED: please approve or deny the release below");
		}
		if (results.length) return fauxAssistantMessage("STARTED: I will report back");
		if (user === "start dag") return fauxAssistantMessage(fauxToolCall("dag_run", { plan }), { stopReason: "toolUse" });
		if (user === "start gated") return fauxAssistantMessage(fauxToolCall("dag_run", { plan: gatedPlan }), { stopReason: "toolUse" });
		if (user === "start child") return fauxAssistantMessage(fauxToolCall("task", { description: "slow", prompt: "slow child", run_in_background: true }), { stopReason: "toolUse" });
		throw new Error(`unexpected ${user}`);
	};
}

async function openChannelBot(dir: string, hostChannels: string[], child: Promise<void>, extra: { wakeDeliveryRetryMs?: number; wakeMergeConfirmMs?: number } = {}, woken?: { writing: Promise<void>; started: () => void }) {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	faux.setResponses(Array.from({ length: 200 }, () => orchestrator(child, woken?.writing, woken?.started)));
	const models = createModels();
	models.setProvider(faux.provider);
	const bot = await openBot({ storage: await openNodeSqliteStorage(join(dir, "bot.sqlite")), models, defaultModel: { provider: "faux", modelId: "faux-1" }, toolMode: "direct", plugins: [], settings: { retry: { enabled: false } }, hostChannels, ...extra }, context);
	cleanup.push(() => bot.close(context));
	return { bot, models };
}
async function startChannel(bot: Bot, channel: ChannelAdapter, attach = true) {
	await channel.start(channelHandler(channel, bot, forbiddenCommands(), context));
	cleanup.push(() => channel.stop());
	if (attach) bot.attachChannel(channel);
}
async function tempDir() {
	const dir = await mkdtemp(join(tmpdir(), "dinobot-wake-delivery-"));
	cleanup.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

// ---- Slack (the channel of the sessions) -----------------------------------------------------------------------------

const slackSecret = "0123456789abcdef0123456789abcdef";
process.env.SLACK_WAKE_SECRET = slackSecret;
process.env.SLACK_WAKE_TOKEN = "xoxb-fake-test-only";
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
function slackChannel(dir: string, maxResponseBytes?: number) {
	return createSlackChannel({ port: 0, databasePath: join(dir, "inbox.db"), signingSecretEnv: "SLACK_WAKE_SECRET", botTokenEnv: "SLACK_WAKE_TOKEN", appId: "A123", teamId: "T123", botUserId: "UBOT", allowedUserIds: ["U123"], allowedChannelIds: ["C123"], ...(maxResponseBytes ? { maxResponseBytes } : {}) });
}
async function slackMessage(channel: ReturnType<typeof createSlackChannel>, n: number, message: string, root = "1791164999.000001") {
	const body = JSON.stringify({ type: "event_callback", api_app_id: "A123", team_id: "T123", event_id: "Ev" + n, event: { type: "app_mention", user: "U123", channel: "C123", ts: n === 1 ? root : `17911650${String(n).padStart(2, "0")}.000001`, ...(n === 1 ? {} : { thread_ts: root }), text: "<@UBOT> " + message } });
	const time = String(Math.floor(Date.now() / 1000));
	const signature = "v0=" + createHmac("sha256", slackSecret).update("v0:" + time + ":" + body).digest("hex");
	const response = await nativeFetch(new URL("/webhook", channel.url()), { method: "POST", headers: { "content-type": "application/json", "x-slack-request-timestamp": time, "x-slack-signature": signature }, body });
	expect(response.status).toBe(200);
}
const slackThread = JSON.stringify(["A123", "T123", "C123", "1791164999.000001", "U123"]);

test("Slack, session 135925 end to end: the woken answer about the failed review is posted to the same thread", async () => {
	const posts = slackApi();
	const dir = await tempDir();
	const { bot } = await openChannelBot(dir, ["slack"], Promise.resolve());
	const channel = slackChannel(dir);
	await startChannel(bot, channel);
	await slackMessage(channel, 1, "start dag");
	await until("the first answer", () => posts.some((p) => p.text.includes("STARTED")));
	await until("the woken answer in Slack", () => posts.some((p) => p.text.includes("WOKEN: the review failed")));
	const woken = posts.filter((p) => p.text.includes("WOKEN"));
	expect(woken).toHaveLength(1);
	expect(woken[0]).toMatchObject({ channel: "C123", thread_ts: "1791164999.000001" });
	const conversation = await bot.conversation("slack", slackThread, context);
	expect((await bot.harness.snapshot(RunDoc, conversation.id, context))!.runs[0]!.status).toBe("blocked");
	await Bun.sleep(250);
	expect(posts.filter((p) => p.text.includes("WOKEN"))).toHaveLength(1);
}, 30_000);

test("Slack: a woken answer whose channel is not attached yet (daemon start) is posted once it is", async () => {
	const posts = slackApi();
	const dir = await tempDir();
	const child = Promise.withResolvers<void>();
	const { bot } = await openChannelBot(dir, ["slack"], child.promise, { wakeDeliveryRetryMs: 100 });
	const channel = slackChannel(dir);
	await startChannel(bot, channel, false);
	await slackMessage(channel, 1, "start child");
	await until("the first answer", () => posts.some((p) => p.text.includes("STARTED")));
	child.resolve();
	const conversation = await bot.conversation("slack", slackThread, context);
	await until("the woken turn", async () => (await conversation.entries({}, 200, undefined, context)).items.some((e) => text(e.model).includes("WOKEN")));
	await Bun.sleep(150);
	expect(posts.some((p) => p.text.includes("WOKEN"))).toBe(false);
	bot.attachChannel(channel);
	await until("the woken answer in Slack", () => posts.some((p) => p.text.includes("WOKEN: the child finished")));
	await Bun.sleep(150);
	expect(posts.filter((p) => p.text.includes("WOKEN"))).toHaveLength(1);
}, 30_000);

test("Slack: a DAG ask node's human authority question opened while idle reaches the thread with its buttons", async () => {
	const posts = slackApi();
	const dir = await tempDir();
	const { bot } = await openChannelBot(dir, ["slack"], Promise.resolve());
	const channel = slackChannel(dir);
	await startChannel(bot, channel);
	await slackMessage(channel, 1, "start gated");
	await until("the first answer", () => posts.some((p) => p.text.includes("STARTED")));
	await until("the woken answer and its question", () => posts.some((p) => p.text.includes("WOKEN: your approval")) && posts.some((p) => p.text.includes("Publish the fixture release?")));
	const question = posts.find((p) => p.text.includes("Publish the fixture release?")) as unknown as { blocks: { type: string; elements?: { value?: string }[] }[]; thread_ts: string };
	expect(question.thread_ts).toBe("1791164999.000001");
	expect(question.blocks.find((block) => block.type === "actions")!.elements).toHaveLength(2); // approve, deny
	await Bun.sleep(150);
	expect(posts.filter((p) => p.text.includes("Publish the fixture release?"))).toHaveLength(1);
}, 30_000);

test("Slack: a message sent while a woken turn runs gets one reply that carries the woken answer first", async () => {
	const posts = slackApi();
	const dir = await tempDir();
	const child = Promise.withResolvers<void>();
	const writing = Promise.withResolvers<void>();
	const started = Promise.withResolvers<void>();
	// A short confirmation window: past it, a woken answer whose reply was not seen in the thread would be posted again.
	const { bot } = await openChannelBot(dir, ["slack"], child.promise, { wakeMergeConfirmMs: 300 }, { writing: writing.promise, started: () => started.resolve() });
	const channel = slackChannel(dir);
	await startChannel(bot, channel);
	await slackMessage(channel, 1, "start child");
	await until("the first answer", () => posts.some((p) => p.text.includes("STARTED")));
	child.resolve();
	await started.promise; // the woken turn is writing its answer
	await slackMessage(channel, 2, "did you finish?");
	await Bun.sleep(200);
	writing.resolve();
	await until("the reply", () => posts.some((p) => p.text.includes("REPLY: yes")));
	await Bun.sleep(2_500); // past the window and the watcher's next look (1 s)
	const woken = posts.filter((p) => p.text.includes("WOKEN"));
	expect(woken).toHaveLength(1);
	expect(woken[0]!.text).toContain("REPLY: yes");
	expect(woken[0]!.text.indexOf("WOKEN")).toBeLessThan(woken[0]!.text.indexOf("REPLY"));
}, 30_000);

test("Slack: a woken answer a reply took along is posted by itself when that reply never reaches the thread", async () => {
	const posts = slackApi();
	const dir = await tempDir();
	const child = Promise.withResolvers<void>();
	const writing = Promise.withResolvers<void>();
	const started = Promise.withResolvers<void>();
	const { bot } = await openChannelBot(dir, ["slack"], child.promise, { wakeMergeConfirmMs: 300 }, { writing: writing.promise, started: () => started.resolve() });
	// 60 bytes: the woken answer (46) and the reply (21) fit alone, but not together, so the combined reply dies.
	const channel = slackChannel(dir, 60);
	await startChannel(bot, channel);
	await slackMessage(channel, 1, "start child");
	await until("the first answer", () => posts.some((p) => p.text.includes("STARTED")));
	child.resolve();
	await started.promise;
	await slackMessage(channel, 2, "did you finish?");
	await Bun.sleep(200);
	writing.resolve();
	await until("the woken answer, by itself", () => posts.some((p) => p.text.includes("WOKEN")));
	await Bun.sleep(400);
	const woken = posts.filter((p) => p.text.includes("WOKEN"));
	expect(woken).toHaveLength(1);
	expect(woken[0]!.text).not.toContain("REPLY");
}, 30_000);

test("Slack: a human question the model relayed in its own turn (dag_step) is posted once, with no wake", async () => {
	const posts = slackApi();
	const dir = await tempDir();
	const { bot } = await openChannelBot(dir, ["slack"], Promise.resolve());
	const channel = slackChannel(dir);
	await startChannel(bot, channel);
	await slackMessage(channel, 1, "start gated and step");
	await until("the relayed answer", () => posts.some((p) => p.text.includes("RELAYED")));
	await Bun.sleep(250);
	expect(posts.filter((p) => p.text.includes("Publish the fixture release?"))).toHaveLength(1);
	expect(posts.some((p) => p.text.includes("WOKEN"))).toBe(false);
}, 30_000);

test("Slack: a thread key outside the allowlists is never routed", async () => {
	slackApi();
	const dir = await tempDir();
	const channel = slackChannel(dir);
	await channel.start(async () => ({ status: "answered", text: "x" }));
	cleanup.push(() => channel.stop());
	const reply = { status: "answered" as const, text: "hello" };
	expect(channel.deliverHost!(JSON.stringify(["A123", "T123", "C999", "1791164999.000001", "U123"]), reply, "a")).toBe("unroutable");
	expect(channel.deliverHost!(JSON.stringify(["A123", "T123", "C123", "1791164999.000001", "U999"]), reply, "b")).toBe("unroutable");
	expect(channel.deliverHost!(JSON.stringify(["A999", "T123", "C123", "1791164999.000001", "U123"]), reply, "c")).toBe("unroutable");
	expect(channel.deliverHost!("not json", reply, "d")).toBe("unroutable");
});

// ---- Telegram ----------------------------------------------------------------------------------------------------------

function telegramApi() {
	const sent: { chat_id: string; message_thread_id?: number; text: string }[] = [];
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
		const path = new URL(request.url).pathname;
		const payload = await request.json().catch(() => ({}));
		if (path.endsWith("/sendMessage")) sent.push(payload as never);
		return Response.json({ ok: true, result: path.endsWith("/sendMessage") ? { message_id: sent.length } : true });
	} });
	cleanup.push(async () => { await server.stop(true); });
	return { sent, apiBase: server.url.origin };
}
async function telegramMessage(channel: ChannelAdapter & { url(): URL }, id: number, message: string) {
	const event = { update_id: id, message: { message_id: id, from: { id: 1, is_bot: false }, chat: { id: -100 }, message_thread_id: 10, text: message } };
	const response = await nativeFetch(new URL("/webhook", channel.url()), { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": telegramSecret }, body: JSON.stringify(event) });
	expect(response.status).toBe(200);
}
const telegramThread = "123456:-100:10:1";

test("Telegram: a finished background child's woken answer is posted to the same chat topic, once", async () => {
	const { sent, apiBase } = telegramApi();
	const dir = await tempDir();
	const child = Promise.withResolvers<void>();
	const { bot } = await openChannelBot(dir, ["telegram"], child.promise);
	const channel = telegramChannel(telegramConfig(dir), { apiBase });
	await startChannel(bot, channel);
	await telegramMessage(channel, 1, "start child");
	await until("the first answer", () => sent.some((m) => m.text.includes("STARTED")));
	child.resolve();
	await until("the woken answer in Telegram", () => sent.some((m) => m.text.includes("WOKEN: the child finished")));
	const woken = sent.filter((m) => m.text.includes("WOKEN"));
	expect(woken).toHaveLength(1);
	expect(woken[0]).toMatchObject({ chat_id: "-100", message_thread_id: 10 });
	await Bun.sleep(250);
	expect(sent.filter((m) => m.text.includes("WOKEN"))).toHaveLength(1);
}, 30_000);

test("Telegram: after /new the archived conversation is not woken and nothing is posted into the thread's new conversation", async () => {
	const { sent, apiBase } = telegramApi();
	const dir = await tempDir();
	const child = Promise.withResolvers<void>();
	const { bot, models } = await openChannelBot(dir, ["telegram"], child.promise);
	const channel = telegramChannel(telegramConfig(dir), { apiBase });
	await startChannel(bot, channel);
	await telegramMessage(channel, 1, "start child");
	await until("the first answer", () => sent.some((m) => m.text.includes("STARTED")));
	const old = await bot.conversation("telegram", telegramThread, context);
	expect((await rotateThread(bot.harness, models, `telegram:${telegramThread}`, old.id, "new-1", context)).status).toBe("rotated");
	// The archived conversation answers in no live thread; the thread now belongs to the new conversation.
	expect(await threadOfConversation(bot.harness, old.id, context)).toBeUndefined();
	const current = await bot.conversation("telegram", telegramThread, context);
	expect(current.id).not.toBe(old.id);
	expect(await threadOfConversation(bot.harness, current.id, context)).toEqual({ channel: "telegram", threadKey: telegramThread });
	child.resolve();
	// The child's completion is recorded as announced without starting a turn in archived history (ADR 0096).
	const { WakeDoc } = await import("../src/extensions/subagents.ts");
	await until("the event to be settled", async () => ((await bot.harness.snapshot(WakeDoc, old.id, context))?.notified ?? []).some((key) => key.startsWith("done:")));
	await Bun.sleep(250);
	expect((await old.entries({}, 200, undefined, context)).items.some((e) => text(e.model).includes("WOKEN"))).toBe(false);
	expect(sent.some((m) => m.text.includes("WOKEN"))).toBe(false);
}, 30_000);

test("Telegram: a host delivery is idempotent by id, and an answer the thread already holds is not posted twice", async () => {
	const { sent, apiBase } = telegramApi();
	const dir = await tempDir();
	const channel = telegramChannel(telegramConfig(dir), { apiBase });
	await channel.start(async () => ({ status: "answered", text: "x" }));
	cleanup.push(() => channel.stop());
	const reply = { status: "answered" as const, text: "the same answer", answer: 77 };
	expect(channel.deliverHost!(telegramThread, reply, "host:1:9")).toBe("admitted");
	expect(channel.deliverHost!(telegramThread, reply, "host:1:9")).toBe("admitted");
	expect(channel.deliverHost!(telegramThread, reply, "host:1:10")).toBe("duplicate");
	await until("the delivery", () => sent.some((m) => m.text.includes("the same answer")));
	await Bun.sleep(150);
	expect(sent.filter((m) => m.text.includes("the same answer"))).toHaveLength(1);
	expect(channel.holdsAnswer!(telegramThread, 77)).toBe(true);
	expect(channel.holdsAnswer!(telegramThread, 78)).toBe(false);
	expect(channel.deliverHost!("999:-100:10:1", reply, "host:1:11")).toBe("unroutable"); // another bot's key
	expect(channel.deliverHost!("123456:-200:10:1", reply, "host:1:12")).toBe("unroutable"); // chat not allowed
});

test("Telegram: a host delivery never exceeds maxResponseBytes, however small", async () => {
	const { sent, apiBase } = telegramApi();
	const dir = await tempDir();
	const channel = telegramChannel({ ...telegramConfig(dir), maxResponseBytes: 10 }, { apiBase });
	await channel.start(async () => ({ status: "answered", text: "x" }));
	cleanup.push(() => channel.stop());
	expect(channel.deliverHost!(telegramThread, { status: "answered", text: "abcdefghijklmnopqrstuvwxyz".repeat(4) }, "host:1:20")).toBe("admitted");
	await until("the delivery", () => sent.length > 0);
	expect(sent[0]!.text).toBe("abcdefghij");
});

test("Discord cannot address a thread after its interaction: woken answers stay in the conversation", async () => {
	const dir = await tempDir();
	const channel = discordChannel({ port: 0, databasePath: join(dir, "inbox.sqlite"), applicationId: "123", publicKey: "00".repeat(32), allowedUserIds: ["1"], allowedChannelIds: ["10"] });
	await channel.start(async () => ({ status: "answered", text: "x" }));
	cleanup.push(() => channel.stop());
	expect(channel.deliverHost!("anything", { status: "answered", text: "x" }, "host:1:1")).toBe("unroutable");
});
