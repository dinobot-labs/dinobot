import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { type FauxResponseFactory, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { configure, UsageDoc } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { type ClientApi, modelLimits, startClientApi } from "../src/api/server.ts";
import { createUsageService, type UsageResponse, type UsageService } from "../src/api/usage.ts";
import type { AuthService } from "../src/auth/types.ts";
import { createCommands } from "../src/commands/index.ts";
import type { CommandEvent } from "../src/commands/types.ts";
import { type Bot, openBot } from "../src/core/bot.ts";
import { ApiClient, HttpError } from "../src/tui/client.ts";
import type { ClientEvent } from "../src/core/ui-contract.ts";

const context = BACKGROUND_CONTEXT;
test("ApiClient researchReport encodes thread/mission scope and file, returning contained response content", async () => {
	const requests: Array<{ method: string; path: string }> = [];
	const server = Bun.serve({
		hostname: "127.0.0.1", port: 0,
		fetch(request) {
			const url = new URL(request.url);
			requests.push({ method: request.method, path: `${url.pathname}${url.search}` });
			return Response.json({ content: "# Research\nnegative finding" });
		},
	});
	try {
		const client = new ApiClient(new URL(`http://127.0.0.1:${server.port}`));
		expect(await client.researchReport("team/a", "thread one", "mission/2")).toBe("# Research\nnegative finding");
		expect(await client.researchReport("team/a", "thread one", "mission/2", "evidence.json")).toBe("# Research\nnegative finding");
		expect(requests).toEqual([
			{ method: "GET", path: "/v1/threads/team%2Fa/thread%20one/research/mission%2F2/report?file=report.md" },
			{ method: "GET", path: "/v1/threads/team%2Fa/thread%20one/research/mission%2F2/report?file=evidence.json" },
		]);
	} finally { await server.stop(true); }
});

test("ApiClient researchReport preserves HTTP status and failure body instead of returning report content", async () => {
	const server = Bun.serve({
		hostname: "127.0.0.1", port: 0,
		fetch: () => new Response("report not materialized", { status: 404 }),
	});
	try {
		const client = new ApiClient(new URL(`http://127.0.0.1:${server.port}`));
		const error = await client.researchReport("tui", "main", "mission-1").catch((failure: unknown) => failure);
		expect(error).toBeInstanceOf(HttpError);
		expect(error).toMatchObject({ status: 404, message: "GET /v1/threads/tui/main/research/mission-1/report?file=report.md: HTTP 404 report not materialized" });
	} finally { await server.stop(true); }
});

let dir: string | undefined;
let bot: Bot | undefined;
let api: ClientApi | undefined;

afterEach(async () => {
	await api?.stop();
	await bot?.close(context);
	if (dir !== undefined) await rm(dir, { recursive: true, force: true });
	dir = bot = api = undefined;
});

async function start(disabled: readonly string[] = ["skills"], usage?: (bot: Bot) => UsageService) {
	dir = await mkdtemp(join(tmpdir(), "dinobot-api-"));
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }, { id: "faux-2" }] });
	const models = createModels();
	models.setProvider(faux.provider);
	bot = await openBot(
		{
			storage: await openNodeSqliteStorage(join(dir, "bot.sqlite")),
			models,
			defaultModel: { provider: "faux", modelId: "faux-1" },
			toolMode: "direct",
			plugins: [],
		},
		context,
	);
	const commands = createCommands({ bot, models, auth: fakeAuth, plugins: [], disabled });
	api = startClientApi(bot, 0, context, commands, undefined, undefined, usage?.(bot));
	return { faux, models, client: new ApiClient(api.url) };
}

const fakeAuth: AuthService = {
	credentials: {} as AuthService["credentials"],
	providers: async () => [{ id: "anthropic", name: "Anthropic", storeAs: "anthropic", modelProvider: "anthropic" }],
	async login(id, interaction) {
		const key = await interaction.prompt({ type: "secret", message: "API key" });
		return { provider: { id, name: "Anthropic", storeAs: "anthropic-login", modelProvider: "anthropic" }, type: "api_key", identity: key };
	},
	logout: async () => false,
	status: async () => [],
	accounts: async () => [],
	useAccount: async () => {
		throw new Error("no accounts");
	},
};

function url(path: string): URL {
	return new URL(path, api!.url);
}

function post(path: string, body: unknown): Promise<Response> {
	return fetch(url(path), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

/** Reads `data:` frames until the stream ends, handing each event to `onEvent`. */
async function readEvents(response: Response, onEvent: (event: CommandEvent) => Promise<void> = async () => {}) {
	const events: CommandEvent[] = [];
	const decoder = new TextDecoder();
	let buffer = "";
	for await (const chunk of response.body!) {
		buffer += decoder.decode(chunk, { stream: true });
		let end = buffer.indexOf("\n\n");
		while (end !== -1) {
			const event = JSON.parse(buffer.slice("data: ".length, end)) as CommandEvent;
			buffer = buffer.slice(end + 2);
			events.push(event);
			await onEvent(event);
			end = buffer.indexOf("\n\n");
		}
	}
	return events;
}

test("streams a thread's events from a snapshot through the answered run", async () => {
	const { faux, client } = await start();
	faux.setResponses([fauxAssistantMessage("hello back")]);

	const events: ClientEvent[] = [];
	const stream = new AbortController();
	const runEnded = new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("no run_end within 5s")), 5_000);
		void client
			.events(
				"tui",
				"demo",
				(event) => {
					events.push(event);
					if (event.type === "snapshot") void client.send("tui", "demo", "hello", "roach");
					if (event.type === "run_end") {
						clearTimeout(timer);
						resolve();
					}
				},
				stream.signal,
			)
			.catch((error) => {
				if (!stream.signal.aborted) reject(error);
			});
	});
	await runEnded;
	stream.abort();

	expect(events[0]?.type).toBe("snapshot");
	const ended = events.flatMap((event) =>
		event.type === "message_end" && event.entry.kind !== "pi.system" ? [event.entry] : [],
	);
	expect(ended.map((entry) => entry.kind)).toEqual(["pi.user", "pi.assistant"]);
	expect(JSON.stringify(ended[0]?.model)).toContain('<from user=\\"roach\\" channel=\\"tui\\"/>\\nhello');
	expect(JSON.stringify(ended[1]?.model)).toContain("hello back");
	expect(await client.threads()).toEqual([{ key: "tui:demo", conversationId: expect.any(Number) }]);
});

test("streams a conversation's events by id through the answered run", async () => {
	const { faux, client } = await start();
	faux.setResponses([fauxAssistantMessage("child answer")]);
	const created = await bot!.harness.commit(async (tx) => {
		const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
		await configure(tx, conversation.id, { model: { provider: "faux", modelId: "faux-1" } });
		return conversation.id;
	}, context);
	const target = await bot!.harness.conversation(created, context);
	if (target === undefined) throw new Error("conversation missing");

	const events: ClientEvent[] = [];
	const stream = new AbortController();
	const runEnded = new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("no run_end within 5s")), 5_000);
		void client
			.conversationEvents(
				Number(created),
				(event) => {
					events.push(event);
					if (event.type === "snapshot") void target.submit({ type: "input", content: "hi child", requestId: "child:1" }, context);
					if (event.type === "run_end") {
						clearTimeout(timer);
						resolve();
					}
				},
				stream.signal,
			)
			.catch((error) => {
				if (!stream.signal.aborted) reject(error);
			});
	});
	await runEnded;
	stream.abort();

	expect(events[0]?.type).toBe("snapshot");
	const answers = events.flatMap((event) =>
		event.type === "message_end" && event.entry.kind === "pi.assistant" ? [JSON.stringify(event.entry.model)] : [],
	);
	expect(answers.join()).toContain("child answer");
});

test("rejects a conversation id that is not a positive integer or does not exist", async () => {
	await start();
	const bad = await fetch(new URL("/v1/conversations/abc/events", api!.url));
	expect(bad.status).toBe(400);
	expect(await bad.json()).toEqual({ error: expect.any(String) });
	const missing = await fetch(new URL("/v1/conversations/999999/events", api!.url));
	expect(missing.status).toBe(404);
	expect(await missing.json()).toEqual({ error: expect.any(String) });
});

test("lists tui commands without disabled ones and 404s disabled or tui-less ones", async () => {
	await start();
	const listed = (await (await fetch(url("/v1/commands"))).json()) as { commands: { name: string }[] };
	expect(listed.commands.map((command) => command.name)).toEqual(["accounts", "fast", "help", "login", "logout", "model", "plugins", "reasoning", "search", "sessions"]);
	const args = (await (await fetch(url("/v1/commands/model/arguments"))).json()) as { arguments: { value: string }[] };
	expect(args.arguments.map((entry) => entry.value)).toEqual(["faux/faux-1", "faux/faux-2"]);
	expect((await fetch(url("/v1/commands/skills/arguments"))).status).toBe(404);
	const disabled = await post("/v1/threads/tui/demo/commands", { name: "skills" });
	expect(disabled.status).toBe(404);
	expect(await disabled.json()).toEqual({ error: expect.any(String) });
	expect((await post("/v1/threads/tui/demo/commands", {})).status).toBe(400);
});

test("command arguments read the thread from the channel and thread query params", async () => {
	const { client } = await start();
	expect(await (await fetch(url("/v1/threads/tui/qa/model"))).json()).toEqual({ model: "faux/faux-1", thinkingLevel: "off", supportedThinkingLevels: ["off"], fast: false, fastSupported: false, signedIn: true, contextWindow: 128000, maxTokens: 16384 });
	await readEvents(await post("/v1/threads/slack/qa/commands", { name: "model", args: "faux/faux-2" }));
	const current = async (query: string) => {
		const body = (await (await fetch(url(`/v1/commands/model/arguments${query}`))).json()) as {
			arguments: { value: string; current?: boolean }[];
		};
		return body.arguments.filter((entry) => entry.current).map((entry) => entry.value);
	};
	expect(await current("?channel=slack&thread=qa")).toEqual(["faux/faux-2"]);
	expect(await current("?channel=tui&thread=qa")).toEqual(["faux/faux-1"]);
	expect(await current("")).toEqual(["faux/faux-2"]);
	expect((await client.threads()).map((thread) => thread.key).sort()).toEqual(["slack:qa", "tui:main", "tui:qa"]);
});

test("streams a command run from started to done and reports the thread model", async () => {
	await start();
	expect(await (await fetch(url("/v1/threads/tui/demo/model"))).json()).toEqual({ model: "faux/faux-1", thinkingLevel: "off", supportedThinkingLevels: ["off"], fast: false, fastSupported: false, signedIn: true, contextWindow: 128000, maxTokens: 16384 });
	const response = await post("/v1/threads/tui/demo/commands", { name: "model", args: "faux/faux-1" });
	expect(response.headers.get("content-type")).toBe("text/event-stream");
	const events = await readEvents(response);
	expect(events.map((event) => event.type)).toEqual(["started", "state", "output", "done"]);
});

test("reasoning picker and SSE changes agree with thread hydration through ApiClient", async () => {
	const { client, models } = await start();
	models.setProvider(fauxProvider({ provider: "reasoner", models: [{ id: "r", reasoning: true, contextWindow: 200000, maxTokens: 64000 }] }).provider);
	await readEvents(await post("/v1/threads/tui/reasoning/commands", { name: "model", args: "reasoner/r" }));
	const rows = await client.commandArguments("reasoning", "tui", "reasoning");
	expect(rows.map((row) => row.value)).toEqual(["off", "minimal", "low", "medium", "high"]);
	expect(rows.filter((row) => row.current).map((row) => row.value)).toEqual(["off"]);
	let runId = "";
	const events: CommandEvent[] = [];
	await client.runCommand("tui", "reasoning", "reasoning", "", "tester", (event) => {
		events.push(event);
		if (event.type === "started") runId = event.runId;
		if (event.type === "prompt") void client.answerPrompt(runId, event.id, { value: "high" });
	}, new AbortController().signal);
	expect(events.at(-1)?.type).toBe("done");
	const state = await client.threadModel("tui", "reasoning");
	expect(state).toEqual({ model: "reasoner/r", thinkingLevel: "high", supportedThinkingLevels: ["off", "minimal", "low", "medium", "high"], fast: false, fastSupported: false, signedIn: true, contextWindow: 200000, maxTokens: 64000 });
	expect(events).toContainEqual(expect.objectContaining({ type: "state", thinkingLevel: state.thinkingLevel, supportedThinkingLevels: state.supportedThinkingLevels }));
	expect((await client.commandArguments("reasoning", "tui", "reasoning")).filter((row) => row.current).map((row) => row.value)).toEqual(["high"]);
});

test("thread model endpoint reports the fast tier default and explicit choice", async () => {
	const { models } = await start();
	models.setProvider(fauxProvider({ provider: "openai-codex", models: [{ id: "gpt-6-sol" }] }).provider);
	await readEvents(await post("/v1/threads/tui/fast/commands", { name: "model", args: "openai-codex/gpt-6-sol" }));
	const model = async () => (await (await fetch(url("/v1/threads/tui/fast/model"))).json()) as { fast: boolean; fastSupported: boolean };
	expect(await model()).toMatchObject({ model: "openai-codex/gpt-6-sol", fast: true, fastSupported: true });
	await readEvents(await post("/v1/threads/tui/fast/commands", { name: "fast", args: "off" }));
	expect(await model()).toMatchObject({ fast: false, fastSupported: true });
});

test("disabled reasoning is absent from discovery and cannot execute through the API", async () => {
	const { client } = await start(["reasoning"]);
	expect((await client.commands()).some((command) => command.name === "reasoning")).toBe(false);
	await expect(client.commandArguments("reasoning")).rejects.toThrow("HTTP 404");
	expect((await post("/v1/threads/tui/demo/commands", { name: "reasoning", args: "cycle" })).status).toBe(404);
});

test("answers a command prompt by run and prompt id", async () => {
	await start();
	let runId = "";
	const statuses: number[] = [];
	const events = await readEvents(await post("/v1/threads/tui/demo/commands", { name: "login", args: "anthropic" }), async (event) => {
		if (event.type === "started") runId = event.runId;
		if (event.type !== "prompt") return;
		statuses.push((await post(`/v1/command-runs/${runId}/prompts/${event.id}`, { value: "stored-key" })).status);
		statuses.push((await post(`/v1/command-runs/${runId}/prompts/${event.id}`, { value: "again" })).status);
	});
	expect(statuses).toEqual([204, 404]);
	expect(events).toContainEqual({
		type: "output",
		level: "success",
		text: "logged in to Anthropic as stored-key (api_key, stored as anthropic)",
	});
	expect(events.at(-1)).toEqual({ type: "done" });
});

test("rejects a message without text", async () => {
	const { client } = await start();
	await expect(client.send("tui", "demo", " ", "roach")).rejects.toThrow("HTTP 400");
});

test("local clients bind different projects before model/events/send can create a thread; resume keeps its cwd", async () => {
	await start();
	const { mkdir, realpath } = await import("node:fs/promises");
	const { AgentDoc } = await import("@earendil-works/pi-durable");
	const a = join(dir!, "project-a"), b = join(dir!, "project-b"); await mkdir(a); await mkdir(b);
	const first = new ApiClient(api!.url, a), second = new ApiClient(api!.url, b);
	await Promise.all([first.threadModel("tui", "a"), first.workspace("tui", "a"), second.threadModel("tui", "b")]);
	for (const [thread, cwd] of [["a", a], ["b", b]]) {
		const conv = await bot!.conversation("tui", thread!, context);
		expect((await bot!.harness.snapshot(AgentDoc, conv.id, context))!.cwd).toBe(await realpath(cwd!));
	}
	expect(await second.workspace("tui", "a")).toBe(await realpath(a));
	await second.threadModel("tui", "a");
	expect(await second.workspace("tui", "a")).toBe(await realpath(a));
});
test("invalid workspace initialization does not create a thread and competing initializations bind once", async () => {
	const { client } = await start();
	for (const cwd of ["relative", "/no-such-dinobot-project", join(dir!, "bot.sqlite"), 5]) {
		expect((await post("/v1/threads/tui/invalid/workspace", { cwd })).status).toBe(400);
	}
	expect(await client.threads()).toEqual([]);
	const replies = await Promise.all([post("/v1/threads/tui/race/workspace", { cwd: dir }), post("/v1/threads/tui/race/workspace", { cwd: process.cwd() })]);
	const values = await Promise.all(replies.map(response => response.json() as Promise<{ cwd: string }>));
	expect(values[0]!.cwd).toBe(values[1]!.cwd);
	expect(await client.threads()).toHaveLength(1);
});

test("project binding survives SQLite restart under a different daemon default", async () => {
	const { models } = await start();
	const { AgentDoc } = await import("@earendil-works/pi-durable");
	const client = new ApiClient(api!.url, dir!);
	await client.threadModel("tui", "persistent-project");
	const original = await bot!.conversation("tui", "persistent-project", context);
	api!.stop(); api = undefined; await bot!.close(context); bot = undefined;
	bot = await openBot({ storage: await openNodeSqliteStorage(join(dir!, "bot.sqlite")), models, defaultModel: { provider: "faux", modelId: "faux-1" }, toolMode: "direct", plugins: [], workspaceRoot: process.cwd() }, context);
	const restored = await bot.conversation("tui", "persistent-project", context, process.cwd());
	expect(restored.id).toBe(original.id);
	expect((await bot.harness.snapshot(AgentDoc, restored.id, context))!.cwd).toBe(dir!);
});

test("bound workspace drives actual shell execution and verification scope, not only display metadata", async () => {
	const { faux } = await start();
	const { fauxToolCall } = await import("@earendil-works/pi-ai/providers/faux");
	const client = new ApiClient(api!.url, dir!);
	await client.threadModel("tui", "execution-root");
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("bash", { command: "pwd" }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("work_plan", { op: "describe" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	await bot!.handle({ channel: "tui", threadKey: "execution-root", messageId: "cwd-probe", userId: "local", text: "Inspect current workspace" }, context);
	const conversation = await bot!.conversation("tui", "execution-root", context);
	const results = (await conversation.context(context)).messages.filter(message => message.role === "toolResult");
	expect(results).toHaveLength(2);
	for (const result of results) expect(result.isError).not.toBe(true);
	const text=(index:number)=>results[index]!.content.flatMap(block=>block.type==="text"?[block.text]:[]).join("");
	const native=(path:string)=>path.trim().replace(/^\/([a-z])\//i,(_match,drive:string)=>drive.toUpperCase()+":/").replaceAll("\\","/");
	expect(native(text(0))).toBe(native(dir!)); // Git Bash pwd uses /c/, host metadata uses C:\\ on Windows.
	expect(JSON.parse(text(1)).root).toBe(dir!);
});


describe("queued input", () => {
	const userTexts = (transcript: { messages: readonly { role: string; content: unknown }[] }): string[] =>
		transcript.messages.flatMap((message) => {
			if (message.role !== "user") return [];
			const content = message.content as string | { type: string; text?: string }[];
			return [typeof content === "string" ? content : content.map((block) => block.text ?? "").join("")];
		});
	async function waitFor(condition: () => boolean, what: string): Promise<void> {
		const deadline = Date.now() + 5_000;
		while (!condition()) {
			if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
			await Bun.sleep(10);
		}
	}
	function watch(client: ApiClient, thread: string) {
		const events: ClientEvent[] = [];
		const stream = new AbortController();
		void client.events("tui", thread, (event) => { events.push(event); }, stream.signal).catch(() => {});
		const queue = () => {
			for (let index = events.length - 1; index >= 0; index--) {
				const event = events[index]!;
				if (event.type === "queue_status") return event.items;
				if (event.type === "snapshot") return event.queue;
			}
			return undefined;
		};
		return { events, queue, stop: () => stream.abort() };
	}
	const send = async (thread: string, text: string, whenBusy?: "steer" | "followUp", userId = "roach") =>
		((await (await post(`/v1/threads/tui/${thread}/messages`, { text, userId, ...(whenBusy ? { whenBusy } : {}) })).json()) as { submissionId: number }).submissionId;
	const framed = (text: string, userId = "roach") => `<from user="${userId}" channel="tui"/>\n${text}`;

	test("queue_status shows queued text without the header; withdraw takes one back; send-now aborts the turn and delivers the rest once, in order", async () => {
		const { faux, client } = await start();
		const started = Promise.withResolvers<void>();
		const seen: string[][] = [];
		const hang: FauxResponseFactory = (transcript, options) => {
			seen.push(userTexts(transcript));
			started.resolve();
			return new Promise((resolve) => options?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("", { stopReason: "aborted" })), { once: true }));
		};
		const answer: FauxResponseFactory = (transcript) => {
			seen.push(userTexts(transcript));
			return fauxAssistantMessage("delivered");
		};
		faux.setResponses([hang, answer]);
		const stream = watch(client, "q");
		try {
			await waitFor(() => stream.events.length > 0, "snapshot");
			expect(stream.queue()).toEqual([]);
			const first = await send("q", "first");
			await started.promise;
			const second = await send("q", "second\nline", "steer");
			const third = await send("q", "third", "steer");
			const fourth = await send("q", "fourth");
			await waitFor(() => stream.queue()?.length === 3, "three queued");
			expect(stream.queue()).toEqual([
				{ id: second, mode: "steer", text: "second\nline", userId: "roach" },
				{ id: third, mode: "steer", text: "third", userId: "roach" },
				{ id: fourth, mode: "followUp", text: "fourth", userId: "roach" },
			]);
			// A client attaching now gets the queue in its snapshot.
			const late = watch(client, "q");
			await waitFor(() => late.events.length > 0, "late snapshot");
			expect(late.events[0]?.type).toBe("snapshot");
			expect(late.queue()?.map((item) => item.id)).toEqual([second, third, fourth]);
			late.stop();

			expect(await client.withdrawQueued("tui", "q", third)).toEqual({ status: "withdrawn", item: { id: third, mode: "steer", text: "third", userId: "roach" } });
			await waitFor(() => stream.queue()?.length === 2, "withdrawn item gone");
			expect(await client.withdrawQueued("tui", "q", third)).toEqual({ status: "settled" });
			expect(await client.withdrawQueued("tui", "q", first)).toEqual({ status: "already_placed" });
			expect(await client.withdrawQueued("tui", "q", 987_654)).toEqual({ status: "not_found" });
			expect(await client.withdrawQueued("tui", "elsewhere", second)).toEqual({ status: "not_found" });
			expect((await post("/v1/threads/tui/q/queue/abc/withdraw", {})).status).toBe(400);
			expect(stream.queue()?.map((item) => item.id)).toEqual([second, fourth]);

			const result = await client.sendQueued("tui", "q");
			expect(result).toEqual({ sent: 2, submissionId: expect.any(Number) });
			const settled = await (await bot!.harness.submission(result.submissionId as never, context))!.wait(context);
			expect(settled.status).toBe("done");
			// The model saw the aborted turn's input, then exactly one new user message: the remaining queue joined in order.
			expect(seen).toHaveLength(2);
			expect(seen[0]).toEqual([framed("first")]);
			expect(seen[1]).toEqual([framed("first"), framed("second\nline\n\nfourth")]);
			const status = async (id: number) => (await (await bot!.harness.submission(id as never, context))!.status(context));
			expect(await status(first)).toMatchObject({ status: "unanswered", reason: "aborted" });
			for (const id of [second, third, fourth]) expect(await status(id)).toMatchObject({ status: "unanswered", reason: "aborted" });
			await waitFor(() => stream.queue()?.length === 0, "empty queue");
			expect(await client.sendQueued("tui", "q")).toEqual({ sent: 0 });
			expect(seen).toHaveLength(2);
		} finally { stream.stop(); }
	});

	test("send-now keeps each sender's header when the queued input comes from different people", async () => {
		const { faux, client } = await start();
		const started = Promise.withResolvers<void>();
		const seen: string[][] = [];
		faux.setResponses([
			(transcript, options) => {
				started.resolve();
				return new Promise((resolve) => options?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("", { stopReason: "aborted" })), { once: true }));
			},
			(transcript) => { seen.push(userTexts(transcript)); return fauxAssistantMessage("ok"); },
		]);
		await send("team", "kick off");
		await started.promise;
		await send("team", "from roach", "steer");
		await send("team", "from alice", "steer", "alice");
		const result = await client.sendQueued("tui", "team");
		expect(result.sent).toBe(2);
		expect((await (await bot!.harness.submission(result.submissionId as never, context))!.wait(context)).status).toBe("done");
		expect(seen[0]?.at(-1)).toBe(`${framed("from roach")}\n\n${framed("from alice", "alice")}`);
	});

	test("send-now leaves a running turn alone when nothing is queued", async () => {
		const { faux, client } = await start();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		faux.setResponses([async () => { started.resolve(); await release.promise; return fauxAssistantMessage("finished normally"); }]);
		const id = await send("idle", "work");
		await started.promise;
		expect(await client.sendQueued("tui", "idle")).toEqual({ sent: 0 });
		release.resolve();
		const settled = await (await bot!.harness.submission(id as never, context))!.wait(context);
		expect(settled.status).toBe("done");
	});
});

test("modelLimits reads the catalog context window and output limit, and nothing for unknown models", () => {
	const models = createModels();
	models.setProvider(fauxProvider({ provider: "cat", models: [{ id: "big", contextWindow: 1_000_000, maxTokens: 128_000 }] }).provider);
	expect(modelLimits(models, "cat/big")).toEqual({ contextWindow: 1_000_000, maxTokens: 128_000 });
	expect(modelLimits(models, "cat/missing")).toEqual({});
	expect(modelLimits(models, "nope")).toEqual({});
});

describe("GET /v1/usage", () => {
	const ledger = { input: 300, output: 200, cacheRead: 1000, cacheWrite: 0, totalTokens: 1500, reasoning: 50, cost: { input: 0.003, output: 0.01, cacheRead: 0.001, cacheWrite: 0, total: 0.014 } };

	async function seed(thread: string) {
		const conversation = await bot!.conversation("tui", thread, context);
		await bot!.harness.commit(async (tx) => {
			const state = await tx.doc(UsageDoc, conversation.id);
			state.models["faux/faux-1"] = structuredClone(ledger);
			state.tools.codemode = { ...structuredClone(ledger), totalTokens: 10, cost: { ...ledger.cost, total: 0.001 } };
		}, context);
		return conversation.id;
	}

	test("sums every conversation's ledger; without a credential store limits list no provider", async () => {
		await start();
		const id = await seed("usage");
		const response = await fetch(url("/v1/usage"));
		expect(response.status).toBe(200);
		const body = (await response.json()) as UsageResponse;
		expect(body.at).toBeGreaterThan(0);
		expect(body.summary.conversations).toBeGreaterThanOrEqual(1);
		expect(body.summary.models["faux/faux-1"]).toEqual(ledger);
		expect(body.summary.tools.codemode!.totalTokens).toBe(10);
		expect(body.summary.threads).toEqual([{ thread: "tui:usage", conversationId: id, totalTokens: 1510, cost: 0.015 }]);
		expect(body.limits).toEqual({ providers: [] });
	});

	test("lists stored accounts with fetched windows and serves refresh=1 from the 10 s floor", async () => {
		const fetched: string[] = [];
		await start(["skills"], (opened) => createUsageService({
			harness: opened.harness,
			index: opened.index,
			context,
			credentials: {
				pools: async () => new Map([["anthropic", { active: "1", lastId: 1, accounts: [{ id: "1", addedAt: 0, credential: { type: "oauth" as const, access: "ACCESS-SECRET-TOKEN", refresh: "REFRESH-SECRET-TOKEN", expires: Date.now() + 3_600_000, email: "me@example.com", loginProvider: "anthropic" } }] }]]),
			},
			providerName: () => "Anthropic",
			fetcher: {
				provider: async (candidates) => candidates.find((candidate) => candidate === "anthropic"),
				fetch: async (provider, credential) => {
					fetched.push(credential.accessToken ?? "");
					return { report: { provider: provider as never, fetchedAt: 1_700_000_000_000, limits: [{ id: "claude:5h", label: "Claude 5 Hour", scope: { provider: provider as never }, window: { id: "5h", label: "5 Hour", durationMs: 18_000_000, resetsAt: 1_700_000_360_000 }, amount: { usedFraction: 0.42, unit: "percent" }, status: "ok" }] } };
				},
			},
		}));
		const first = await (await fetch(url("/v1/usage"))).json() as UsageResponse;
		const again = await (await fetch(url("/v1/usage?refresh=1"))).json() as UsageResponse;
		expect(fetched).toEqual(["ACCESS-SECRET-TOKEN"]);
		expect(again.limits).toEqual(first.limits);
		expect(first.limits.providers).toEqual([{
			key: "anthropic", name: "Anthropic",
			accounts: [{ id: "1", type: "oauth", label: "me@example.com", active: true, report: { fetchedAt: 1_700_000_000_000, source: "fetch", limits: [{ id: "claude:5h", label: "Claude 5 Hour", windowId: "5h", windowLabel: "5 Hour", durationMs: 18_000_000, resetsAt: 1_700_000_360_000, usedFraction: 0.42, status: "ok" }] } }],
		}]);
		const raw = JSON.stringify(first);
		expect(raw).not.toContain("SECRET-TOKEN");
	});
});
