import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { httpChannel } from "../src/channels/http.ts";
import { telegramChannel } from "../src/channels/telegram.ts";
import { createTelegramForwarder } from "../src/cli/telegram-run.ts";
import { channelHandler } from "../src/core/channel-handler.ts";
import { context, forbiddenCommands, openLocalBot } from "./fixtures/channel-e2e-child.ts";
import { TelegramLongPoll } from "./fixtures/telegram-long-poll.ts";

// ADR 0048 UNIT1 + UNIT2 end to end on real local boundaries: Telegram long polling against a local REST double, the
// durable SQLite inbox, the topic scheduler, the shared API gate with the PRODUCTION policy, the loopback forwarder
// speaking NDJSON to the real HTTP core channel, channelHandler, a SQLite-backed bot and the faux model. Only the remote
// Telegram service and the model provider are fakes. Ordering is decided by barriers keyed to message content.
async function until(predicate: () => boolean, label: string, ms = 10000, diagnostics?: () => unknown) {
	const end = Date.now() + ms;
	while (!predicate()) {
		if (Date.now() >= end) {
			if (diagnostics) console.error("telegram fixture timeout", JSON.stringify(diagnostics()));
			throw new Error("Timed out: " + label);
		}
		await Bun.sleep(10);
	}
}
type Call = { method: string; body: any; at: number };
function event(id: number, text: string, topic: number) {
	return { update_id: id, message: { message_id: id, from: { id: 1, is_bot: false }, chat: { id: -100, type: "supergroup", is_forum: true }, message_thread_id: topic, is_topic_message: true, text } };
}

test("forwarder/NDJSON: slow topic A is held in the model while fast topic B is answered; A's follow-up waits behind A; the gate spaces every chat write", async () => {
	const dir = await mkdtemp(join(tmpdir(), "telegram-topic-concurrency-"));
	const calls: Call[] = [];
	const pending = new TelegramLongPoll<ReturnType<typeof event>>();
	let messageId = 0;
	let releaseBAck!: () => void;
	const bAck = new Promise<void>(resolve => { releaseBAck = resolve; });
	const remote = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
		const method = new URL(request.url).pathname.split("/").at(-1)!;
		const body = await request.json() as any;
		calls.push({ method, body, at: Date.now() });
		// Observing the request is not an ACK: keep B in sending until the test releases its response.
		if (method === "sendMessage" && body.text === "FAST_B_REPLY") await bAck;
		if (method === "getWebhookInfo") return Response.json({ ok: true, result: { url: "" } });
		if (method === "getUpdates") return Response.json({ ok: true, result: await pending.poll(body.offset, body.timeout, request.signal) });
		return Response.json({ ok: true, result: method === "sendMessage" ? { message_id: ++messageId } : true });
	} });
	const tokenFile = join(dir, "bot.token");
	await writeFile(tokenFile, "101:local_concurrency_test", { mode: 0o600 });
	const databasePath = join(dir, "inbox.sqlite");
	const channel = telegramChannel({ mode: "polling", port: 0, botTokenFile: tokenFile, databasePath, allowedUserIds: ["1"], allowedChatIds: ["-100"], requestTimeoutMs: 2000, steering: "off" /* A's follow-up must wait behind A here; steering is ADR 0057's own suite */ }, { apiBase: remote.url.origin });
	const { bot, faux } = await openLocalBot(dir);
	const http = httpChannel(0);
	let releaseA!: () => void;
	const slowA = new Promise<void>(resolve => { releaseA = resolve; });
	const modelStarts: string[] = [], transcripts = new Map<string, string>();
	const respond = async (transcript: { messages: unknown[] }) => {
		const text = JSON.stringify(transcript.messages);
		const marker = ["SLOW_A_FOLLOWUP", "SLOW_A", "FAST_B"].find(m => text.includes(m + "_INPUT"))!;
		modelStarts.push(marker); transcripts.set(marker, text);
		if (marker === "SLOW_A") await slowA;
		return fauxAssistantMessage(marker + "_REPLY");
	};
	faux.setResponses([respond, respond, respond]);
	// Observe the forwarder <-> core content type: progress streaming must be the NDJSON path, not the JSON fallback.
	const realFetch = globalThis.fetch;
	const coreTypes: string[] = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const response = await realFetch(input as any, init);
		if (String(input instanceof Request ? input.url : input).endsWith("/v1/messages")) coreTypes.push(response.headers.get("content-type") ?? "");
		return response;
	}) as typeof fetch;
	let commandAccess = 0;
	try {
		await http.start(channelHandler(http, bot, forbiddenCommands(() => commandAccess++), context));
		await channel.start(createTelegramForwarder(http.url().origin));
		pending.push(event(1, "SLOW_A_INPUT", 10));
		await until(() => modelStarts.includes("SLOW_A"), "slow A reaches the model");
		pending.push(event(2, "FAST_B_INPUT", 20), event(3, "SLOW_A_FOLLOWUP_INPUT", 10));
		await until(() => calls.some(c => c.method === "sendMessage" && c.body.text === "FAST_B_REPLY"), "fast B send observed while A is held");
		// The remote has B's request, but its held ACK cannot have committed a done row yet.
		expect(modelStarts).toEqual(["SLOW_A", "FAST_B"]);
		expect(channel.health()).toMatchObject({ processing: 1, queued: 1, sending: 1, done: 0, dead: 0 });
		releaseBAck();
		await until(() => channel.health().done === 1, "B ACK committed while A is held");
		// UNIT1: B finished in its own lane; A is still inside the model and its follow-up has not started (lane FIFO).
		expect(modelStarts).toEqual(["SLOW_A", "FAST_B"]);
		expect(channel.health()).toMatchObject({ processing: 1, queued: 1, done: 1, dead: 0 });
		expect(calls.some(c => c.method === "sendMessage" && /SLOW_A/.test(c.body.text))).toBe(false);
		// Held past the reporter's first tick, so A's typing indicator must pass the gate while A is in the model.
		await until(() => calls.some(c => c.method === "sendChatAction" && c.body.message_thread_id === 10), "typing for held A", 10000, () => ({
			health: channel.health(), modelStarts, callCount: calls.length,
			calls: calls.slice(-32).map(c => ({ method: c.method, topic: c.body.message_thread_id, elapsedMs: c.at - calls[0]!.at })),
		}));
		expect(modelStarts).toEqual(["SLOW_A", "FAST_B"]);
		releaseA();
		await until(() => channel.health().done === 3, "A and its follow-up drain");
		expect(modelStarts).toEqual(["SLOW_A", "FAST_B", "SLOW_A_FOLLOWUP"]);
		const finals = calls.filter(c => c.method === "sendMessage" && /_REPLY$/.test(c.body.text));
		expect(finals.map(c => [c.body.message_thread_id, c.body.text])).toEqual([[20, "FAST_B_REPLY"], [10, "SLOW_A_REPLY"], [10, "SLOW_A_FOLLOWUP_REPLY"]]);
		for (const c of finals) expect(c.body.chat_id).toBe("-100");
		// Conversation keys stay per topic: B never sees A, and A's follow-up continues A's history only.
		expect(transcripts.get("FAST_B")).not.toContain("SLOW_A");
		expect(transcripts.get("SLOW_A_FOLLOWUP")).toContain("SLOW_A_REPLY");
		expect(transcripts.get("SLOW_A_FOLLOWUP")).not.toContain("FAST_B");
		expect(commandAccess).toBe(0);
		expect(coreTypes.length).toBe(3);
		expect(coreTypes.every(t => t.startsWith("application/x-ndjson"))).toBe(true);
	} finally {
		globalThis.fetch = realFetch;
		releaseBAck();
		releaseA();
		pending.close();
		await channel.stop(); await http.stop(); await bot.close(context); await remote.stop(true);
	}
	try {
		// UNIT2: one durable permit per Telegram request; production inequalities hold on the committed start times.
		const db = new Database(databasePath);
		const permits = db.query("SELECT at, rate_key AS key, kind FROM api_permits ORDER BY seq").all() as { at: number; key: string | null; kind: string }[];
		db.close();
		expect(permits.length).toBe(calls.length);
		for (let i = 1; i < permits.length; i++) expect(permits[i]!.at - permits[i - 1]!.at).toBeGreaterThanOrEqual(40);
		// Typing permits carry their chat key for per-chat typing coalescing but are not chat writes.
		const chat = permits.filter(p => p.key === "chat:-100" && p.kind !== "typing").map(p => p.at);
		expect(chat.length).toBe(calls.filter(c => c.method === "sendMessage" || c.method === "editMessageText").length);
		for (let i = 1; i < chat.length; i++) expect(chat[i]! - chat[i - 1]!).toBeGreaterThanOrEqual(1000);
		expect(permits.filter(p => p.kind === "typing").length).toBe(calls.filter(c => c.method === "sendChatAction").length);
		expect(permits.filter(p => p.key === null).length).toBe(calls.filter(c => c.method === "getWebhookInfo" || c.method === "getUpdates" || c.method === "setMyCommands").length);
	} finally { await rm(dir, { recursive: true, force: true }); }
}, 40000);
