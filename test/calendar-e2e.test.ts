import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonObject } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createSlackChannel } from "../src/channels/slack.ts";
import { type Bot, openBot } from "../src/core/bot.ts";
import { channelHandler } from "../src/core/channel-handler.ts";
import { PLUGIN_WAKE_REQUEST_PREFIX } from "../src/extensions/subagents.ts";
import { type CalendarEngine, createCalendarPlugin } from "../src/plugins/calendar/index.ts";
import { CalendarStore } from "../src/plugins/calendar/store.ts";
import { loadPlugin, type LoadedPlugin } from "../src/plugins/types.ts";
import { forbiddenCommands } from "./fixtures/channel-e2e-child.ts";

/**
 * ADR 0106 end to end: a Slack user asks for an event, the model registers it with calendar_create_event, and when the
 * planned reminder comes due the calendar engine wakes that conversation; the woken answer is posted to the same Slack
 * thread exactly once, also across a restart and across a crash between the wake and the reminder's `fired` update.
 * Only the calendar's clock is controlled; the bot, its durable storage, the Slack adapter and the wake hand-over are real.
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

const FRAME = "<from host=\"plugin:calendar\"/>\n";
const ZONE = "Asia/Seoul";
const at = (local: string) => Date.parse(`${local}+09:00`);
type Mode = "direct" | "codemode-only";

const REQUESTS: Record<string, JsonObject> = {
	"register standup": { title: "Team standup", start: "2026-05-07T14:00", category: "meeting" },
	"register review": { title: "Quarterly review", start: "2026-05-07T14:00:00+09:00", category: "meeting", preparation: "Q1 sales numbers and a 5-slide deck" },
};

type Model = { woken: string[]; registered: string[] };
function responder(model: Model, mode: Mode): FauxResponseFactory {
	const call = (name: string, args: JsonObject) => fauxAssistantMessage(
		mode === "direct" ? fauxToolCall(name, args) : fauxToolCall("codemode", { code: `text(await tools.${name}(${JSON.stringify(args)}));` }),
		{ stopReason: "toolUse" },
	);
	return async (t) => {
		const raw = text(t.messages.findLast((m) => m.role === "user")?.content);
		if (raw.startsWith(FRAME)) {
			const reminder = raw.slice(FRAME.length);
			model.woken.push(reminder);
			const head = /^Calendar reminder \((\w+)\) for event (evt_[0-9a-f]{16}): "([^"]*)"/.exec(reminder);
			return fauxAssistantMessage(head ? `WOKEN ${head[1]}: ${head[3]}` : `WOKEN unparsed: ${reminder.slice(0, 80)}`);
		}
		const user = userText(raw);
		const request = REQUESTS[user];
		if (!request) throw new Error(`unexpected ${raw}`);
		const results = t.messages.slice(t.messages.findLastIndex((m) => m.role === "user") + 1).filter((m) => m.role === "toolResult");
		if (!results.length) return call("calendar_create_event", request);
		model.registered.push(results.map((m) => text(m.content)).join("\n"));
		return fauxAssistantMessage(`REGISTERED: ${request.title}`);
	};
}

async function tempDir() {
	const dir = await mkdtemp(join(tmpdir(), "dinobot-calendar-e2e-"));
	cleanup.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

/** The bot with the calendar plugin loaded like main.ts does (loadPlugin with the data directory); main.ts closes plugins after the bot. */
async function openCalendarBot(dir: string, mode: Mode, clock: { now: number }) {
	let engine: CalendarEngine | undefined;
	const loaded = await loadPlugin(createCalendarPlugin({ now: () => clock.now, timers: false, onEngine: (e) => { engine = e; } }), { timeZone: ZONE }, { resolveDependency: async () => undefined, dataDir: dir });
	if (Array.isArray(loaded)) throw new Error(loaded.join("; "));
	const plugin = loaded as LoadedPlugin;
	cleanup.push(async () => plugin.close?.());
	const model: Model = { woken: [], registered: [] };
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	faux.setResponses(Array.from({ length: 200 }, () => responder(model, mode)));
	const models = createModels();
	models.setProvider(faux.provider);
	const bot = await openBot({ storage: await openNodeSqliteStorage(join(dir, "bot.sqlite")), models, defaultModel: { provider: "faux", modelId: "faux-1" }, toolMode: mode, plugins: [plugin], settings: { retry: { enabled: false } }, hostChannels: ["slack"] }, context);
	cleanup.push(() => bot.close(context));
	if (!engine) throw new Error("calendar engine was not created");
	const channel = await startSlack(bot, dir);
	return {
		bot, plugin, engine, model, channel,
		async close() {
			await channel.stop();
			await bot.close(context);
			await plugin.close?.();
		},
	};
}

// ---- Slack ----------------------------------------------------------------------------------------------------------

const slackSecret = "0123456789abcdef0123456789abcdef";
process.env.SLACK_CALENDAR_E2E_SECRET = slackSecret;
process.env.SLACK_CALENDAR_E2E_TOKEN = "xoxb-fake-test-only";
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
	const channel = createSlackChannel({ port: 0, databasePath: join(dir, "inbox.db"), signingSecretEnv: "SLACK_CALENDAR_E2E_SECRET", botTokenEnv: "SLACK_CALENDAR_E2E_TOKEN", appId: "A123", teamId: "T123", botUserId: "UBOT", allowedUserIds: ["U123"], allowedChannelIds: ["C123"] });
	await channel.start(channelHandler(channel, bot, forbiddenCommands(), context));
	cleanup.push(() => channel.stop());
	bot.attachChannel(channel);
	return channel;
}
const root = "1791164999.000001";
async function mention(channel: ReturnType<typeof createSlackChannel>, n: number, message: string) {
	const body = JSON.stringify({ type: "event_callback", api_app_id: "A123", team_id: "T123", event_id: "Ev" + n, event: { type: "app_mention", user: "U123", channel: "C123", ts: root, text: "<@UBOT> " + message } });
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
/** A second connection to the calendar database, as an operator would inspect it. */
function inspect(dir: string) {
	const store = new CalendarStore(join(dir, "calendar.sqlite"));
	cleanup.push(async () => store.close());
	return store;
}
const eventIdOf = (registered: string) => /evt_[0-9a-f]{16}/.exec(registered)?.[0];

// Plain string checks only: an asymmetric matcher inside toMatchObject would be written into the received post (bun).
const woken = (posts: { channel: string; thread_ts: string; text: string }[]) => posts.filter((p) => p.text.startsWith("WOKEN"));

test("Slack, direct: a mention registers an event, its reminder wakes the thread once, and a restart or a crash before `fired` does not post again", async () => {
	const posts = slackApi();
	const dir = await tempDir();
	const clock = { now: at("2026-05-07T09:00:00") };
	const first = await openCalendarBot(dir, "direct", clock);
	await mention(first.channel, 1, "register standup");
	await until("the registration answer", () => posts.some((p) => p.text === "REGISTERED: Team standup"));
	const conversation = await first.bot.conversation("slack", slackThread, context);
	const id = eventIdOf(first.model.registered[0] ?? "");
	expect(id).toBeDefined();
	expect(first.model.registered[0]).toContain("notify 10 min");

	// Registered in this Slack conversation, with the automatic meeting plan: notify 10 minutes before (13:50 Seoul).
	const store = inspect(dir);
	expect(store.get(id!)).toMatchObject({ title: "Team standup", origin: String(conversation.id), category: "meeting", timeZone: ZONE, startMs: at("2026-05-07T14:00:00") });
	expect(store.reminders(id!).map((r) => ({ fireAt: r.fireAt, minutes: r.minutes, action: r.action, state: r.state }))).toEqual([
		{ fireAt: at("2026-05-07T13:50:00"), minutes: 10, action: "notify", state: "pending" },
	]);
	const reminderKey = store.reminders(id!)[0]!.key;

	clock.now = at("2026-05-07T13:49:00");
	expect((await first.engine.tick()).fired).toEqual([]);
	clock.now = at("2026-05-07T13:51:00");
	expect((await first.engine.tick()).fired).toEqual([`${id}:${reminderKey}`]);
	await until("the woken answer in Slack", () => woken(posts).length > 0);
	expect(woken(posts).map(({ channel, thread_ts, text }) => ({ channel, thread_ts, text }))).toEqual([{ channel: "C123", thread_ts: root, text: "WOKEN notify: Team standup" }]);
	// The woken turn saw the framed reminder in the same conversation.
	const reminderText = first.model.woken[0]!;
	expect(reminderText).toStartWith(`Calendar reminder (notify) for event ${id}: "Team standup"`);
	expect(reminderText).toContain("Your task: post a short heads-up");
	expect(await userEntries(first.bot, conversation.id)).toContain(FRAME + reminderText);
	expect((await first.bot.harness.commit((tx) => tx.submissionByRequest(conversation.id, `${PLUGIN_WAKE_REQUEST_PREFIX}calendar:${id}:${reminderKey}`), context))?.status).toBe("done");
	expect(store.reminders(id!)[0]).toMatchObject({ state: "fired", firedAt: at("2026-05-07T13:51:00") });

	// Another tick of the same instant fires nothing.
	expect((await first.engine.tick()).fired).toEqual([]);
	await Bun.sleep(1_500); // past the wake watcher's next look
	expect(woken(posts)).toHaveLength(1);
	expect(first.model.woken).toHaveLength(1);
	await first.close();

	// Restart: bot and plugin reopened on the same data directory; the start tick and another tick post nothing.
	clock.now = at("2026-05-07T13:52:00");
	const second = await openCalendarBot(dir, "direct", clock);
	expect((await second.engine.tick()).fired).toEqual([]);
	await Bun.sleep(1_500);
	expect(woken(posts)).toHaveLength(1);
	expect(second.model.woken).toEqual([]);
	await second.close();

	// A crash between the wake and the `fired` update: the reminder is pending again on disk. The next tick asks the host
	// again with the same key, gets "duplicate", records `fired`, and nothing is posted twice.
	const db = new Database(join(dir, "calendar.sqlite"));
	db.query("UPDATE reminders SET state = 'pending', fired_at = NULL WHERE event_id = ?").run(id!);
	db.close();
	expect(store.reminders(id!)[0]!.state).toBe("pending");
	const third = await openCalendarBot(dir, "direct", clock);
	await third.engine.tick();
	await until("the reminder to be fired again", () => store.reminders(id!)[0]!.state === "fired");
	await Bun.sleep(1_500);
	expect(woken(posts)).toHaveLength(1);
	expect(third.model.woken).toEqual([]);
}, 60_000);

test("Slack, codemode-only: an event with preparation gets a prepare reminder whose wake carries the preparation task, then the heads-up, each posted once", async () => {
	const posts = slackApi();
	const dir = await tempDir();
	const clock = { now: at("2026-05-07T09:00:00") };
	const bot = await openCalendarBot(dir, "codemode-only", clock);
	await mention(bot.channel, 1, "register review");
	await until("the registration answer", () => posts.some((p) => p.text === "REGISTERED: Quarterly review"));
	const conversation = await bot.bot.conversation("slack", slackThread, context);
	const id = eventIdOf(bot.model.registered[0] ?? "");
	expect(id).toBeDefined();
	const store = inspect(dir);
	expect(store.get(id!)?.origin).toBe(String(conversation.id));
	// A meeting with preparation: prepare 60 minutes before, notify 10 minutes before.
	expect(store.reminders(id!).map((r) => [r.fireAt, r.minutes, r.action])).toEqual([
		[at("2026-05-07T13:00:00"), 60, "prepare"],
		[at("2026-05-07T13:50:00"), 10, "notify"],
	]);

	clock.now = at("2026-05-07T13:01:00");
	expect((await bot.engine.tick()).fired).toHaveLength(1);
	await until("the prepared answer in Slack", () => woken(posts).length === 1);
	const prepare = bot.model.woken[0]!;
	expect(prepare).toStartWith(`Calendar reminder (prepare) for event ${id}: "Quarterly review"`);
	expect(prepare).toContain("Preparation: Q1 sales numbers and a 5-slide deck");
	expect(prepare).toContain("Your task: do the preparation now, on your own");
	expect(prepare).toContain("Draft the material yourself");
	expect(prepare).toContain("Other upcoming reminders: notify at");
	expect(woken(posts).map(({ channel, thread_ts, text }) => ({ channel, thread_ts, text }))).toEqual([{ channel: "C123", thread_ts: root, text: "WOKEN prepare: Quarterly review" }]);

	clock.now = at("2026-05-07T13:51:00");
	expect((await bot.engine.tick()).fired).toHaveLength(1);
	await until("the heads-up in Slack", () => woken(posts).length === 2);
	expect(bot.model.woken[1]).toStartWith(`Calendar reminder (notify) for event ${id}: "Quarterly review"`);
	expect(woken(posts)[1]).toMatchObject({ channel: "C123", thread_ts: root, text: "WOKEN notify: Quarterly review" });
	expect((await bot.engine.tick()).fired).toEqual([]);
	await Bun.sleep(1_500);
	expect(woken(posts)).toHaveLength(2);
	expect(bot.model.woken).toHaveLength(2);
	expect(store.reminders(id!).map((r) => r.state)).toEqual(["fired", "fired"]);
}, 60_000);
