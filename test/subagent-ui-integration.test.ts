import { afterEach, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { startClientApi } from "../src/api/server.ts";
import type { AuthService } from "../src/auth/types.ts";
import { createCommands } from "../src/commands/index.ts";
import { openBot } from "../src/core/bot.ts";
import { formatInput } from "../src/core/input.ts";
import type { ClientEvent } from "../src/core/ui-contract.ts";
import { WAKE_PREFIX } from "../src/extensions/subagents.ts";
import { ApiClient } from "../src/tui/client.ts";
import { ChatState, runningSubagents, type ChatData } from "../src/tui/state.ts";

const context = BACKGROUND_CONTEXT;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function signal<T>() {
	const deferred = Promise.withResolvers<T>();
	const timer = setTimeout(() => deferred.reject(new Error("integration signal timed out")), 3_000);
	return {
		promise: deferred.promise.finally(() => clearTimeout(timer)),
		resolve: deferred.resolve,
		reject: deferred.reject,
	};
}

function observe(state: ChatState, predicate: (data: ChatData) => boolean) {
	const ready = signal<void>();
	const unsubscribe = state.subscribe((data) => {
		if (predicate(data)) { unsubscribe(); ready.resolve(); }
	});
	void ready.promise.catch(() => unsubscribe());
	if (predicate(state.data)) { unsubscribe(); ready.resolve(); }
	return ready.promise;
}

async function setup(router: FauxResponseFactory) {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	faux.setResponses(Array.from({ length: 20 }, () => router));
	const models = createModels();
	models.setProvider(faux.provider);
	const bot = await openBot({
		storage: new MemoryStorage(), models, defaultModel: { provider: "faux", modelId: "faux-1" },
		toolMode: "direct", plugins: [], settings: { retry: { enabled: false } },
	}, context);
	cleanups.push(() => bot.close(context));
	const api = startClientApi(bot, 0, context, createCommands({ bot, models, auth: {} as AuthService, plugins: [], disabled: [] }));
	cleanups.push(() => api.stop());
	const client = new ApiClient(api.url);
	async function attach(thread: string, onEvent?: (event: ClientEvent, state: ChatState) => void) {
		const state = new ChatState();
		const snapshot = signal<void>();
		const controller = new AbortController();
		const stream = client.events("tui", thread, (event) => {
			state.apply(event);
			onEvent?.(event, state);
			if (event.type === "snapshot") snapshot.resolve();
		}, controller.signal).catch((error) => {
			if (!controller.signal.aborted) { snapshot.reject(error); throw error; }
		});
		cleanups.push(async () => { controller.abort(); await stream; });
		await snapshot.promise;
		return state;
	}
	return { bot, client, attach };
}

for (const waitForDetails of [true, false]) {
	test(`foreground ${waitForDetails ? "published" : "admission"} abort never keeps an error result running and reconnects cancelled`, async () => {
		// Given an admitted foreground child held until its provider receives cancellation.
		const started = signal<void>();
		const router: FauxResponseFactory = async (transcript, options) => {
			const user = transcript.messages.findLast((message) => message.role === "user");
			if (user?.content === "FOREGROUND") {
				started.resolve();
				await new Promise<void>((resolve) => {
					if (options?.signal?.aborted) resolve();
					else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				return fauxAssistantMessage("", { stopReason: "aborted" });
			}
			return fauxAssistantMessage(fauxToolCall("task", { description: "foreground", prompt: "FOREGROUND" }), { stopReason: "toolUse" });
		};
		const { client, attach } = await setup(router);
		const errors: string[] = [];
		const published = waitForDetails ? signal<void>() : undefined;
		const state = await attach("foreground", (event, current) => {
			if (event.type === "tool_execution_update" && event.toolName === "task" && event.details) published?.resolve();
			if ((event.type === "entry_appended" || event.type === "message_end") && event.entry.kind === "pi.tool-result") {
				const result = event.entry.model?.[0];
				if (result?.role === "toolResult" && result.isError) {
					for (const block of current.data.blocks) {
						if (block.kind === "subagent") errors.push(block.progress.status);
					}
				}
			}
		});
		const admitted = observe(state, (data) => data.subagents.size > 0);
		await client.send("tui", "foreground", "START", "test");
		await started.promise;
		await admitted;
		if (published) await published.promise;
		const done = observe(state, (data) => data.lastTurnMs !== undefined);
		// When Escape's API aborts the active parent turn.
		await client.abort("tui", "foreground");
		await done;
		// Then the actual harness error frame cannot leave any running row, including on reconnect.
		expect(errors.length).toBeGreaterThan(0);
		expect(errors).not.toContain("running");
		await observe(state, (data) => [...data.subagents.values()].some((child) => child.status === "cancelled"));
		expect(runningSubagents(state.data)).toHaveLength(0);
		expect(state.data.blocks.filter((block) => block.kind === "notice" && block.level === "error")).toHaveLength(0);
		const reconnect = await attach("foreground");
		await observe(reconnect, (data) => [...data.subagents.values()].some((child) => child.status === "cancelled"));
		expect(runningSubagents(reconnect.data)).toHaveLength(0);
	}, 10_000);
}

for (const status of ["completed", "failed", "cancelled"] as const) {
	test(`background ${status} reaches live parent and reconnect without task_output`, async () => {
		// Given a live parent and an independently gated background child.
		const started = signal<void>();
		const release = Promise.withResolvers<void>();
		const woken = signal<void>();
		let spawns = 0;
		const router: FauxResponseFactory = async (transcript, options) => {
			const user = transcript.messages.findLast((message) => message.role === "user");
			if (user?.content === "CHILD") {
				started.resolve();
				if (status === "cancelled") {
					await new Promise<void>((resolve) => {
						if (options?.signal?.aborted) resolve();
						else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
					});
					return fauxAssistantMessage("", { stopReason: "aborted" });
				}
				await release.promise;
				return status === "failed"
					? fauxAssistantMessage("", { stopReason: "error", errorMessage: "child failed" })
					: fauxAssistantMessage("CHILD FINISHED");
			}
			if (transcript.messages.at(-1)?.role === "toolResult") return fauxAssistantMessage("Parent finished");
			// ADR 0091 resumes an idle parent with a host input, not another START.
			if (typeof user?.content === "string" && user.content.startsWith(WAKE_PREFIX)) {
				woken.resolve();
				return fauxAssistantMessage("Background result noted");
			}
			expect(user?.content).toBe(formatInput({ userId: "test", channel: "tui", text: "START" }));
			spawns++;
			return fauxAssistantMessage(fauxToolCall("task", {
				description: "background", prompt: "CHILD", run_in_background: true,
			}), { stopReason: "toolUse" });
		};
		const { bot, client, attach } = await setup(router);
		cleanups.push(async () => { release.resolve(); });
		const state = await attach(status);
		const parentDone = observe(state, (data) => data.lastTurnMs !== undefined);
		await client.send("tui", status, "START", "test");
		await started.promise;
		await parentDone;
		const runner = (await bot.harness.inspect(context)).tasks.find((task) => task.record.kind === "dinobot.subagent");
		if (!runner) throw new Error("runner missing");
		const terminal = observe(state, (data) => [...data.subagents.values()].some((child) => child.status === status));
		// When the runner settles after the parent has finished, without any parent tool call.
		if (status === "cancelled") await bot.harness.abortTask(runner.record.id, context);
		else release.resolve();
		await bot.harness.waitForTask(runner.record.id, context);
		await terminal;
		// Include the real idle wake before inspecting the roster (not a timing-dependent snapshot).
		await woken.promise;
		expect(spawns).toBe(1);
		// Then live and newly attached clients both have the terminal row and stopped roster.
		expect(runningSubagents(state.data)).toHaveLength(0);
		const row = state.data.blocks.find((block) => block.kind === "subagent");
		expect(row?.kind === "subagent" && row.progress.status).toBe(status);
		expect(row?.kind === "subagent" && row.progress.endedAt).toBeNumber();
		const reconnect = await attach(status);
		await observe(reconnect, (data) => [...data.subagents.values()].some((child) => child.status === status));
		expect(reconnect.data.blocks.find((block) => block.kind === "subagent")?.kind).toBe("subagent");
		expect(runningSubagents(reconnect.data)).toHaveLength(0);
	}, 10_000);
}

for (const [name, args] of [
	["task", { description: "invalid-type", prompt: "CHILD", subagent_type: "nonexistent" }],
	["todo_write", { todos: [] }],
	["task_output", { task_ids: ["sa-missing"], block: false }],
	["kill_task", { task_id: "sa-missing" }],
] as const) {
	test(`rejected ${name} surfaces its real error without a phantom running row`, async () => {
		// Given the real harness rejecting a built-in hidden tool call.
		const router: FauxResponseFactory = async (transcript) => transcript.messages.at(-1)?.role === "toolResult"
			? fauxAssistantMessage("Recovered")
			: fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
		const { bot, client, attach } = await setup(router);
		const errors: string[] = [];
		const state = await attach(name, (event) => {
			if ((event.type === "entry_appended" || event.type === "message_end") && event.entry.kind === "pi.tool-result") {
				const result = event.entry.model?.[0];
				if (result?.role === "toolResult" && result.isError) errors.push(
					result.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n"),
				);
			}
		});
		const done = observe(state, (data) => data.lastTurnMs !== undefined);
		// When the failed call is delivered through SSE and reduced into the transcript.
		await client.send("tui", name, "START", "test");
		await done;
		// Then the user sees the actual tool error, and no worker remains running.
		expect(errors.length).toBeGreaterThan(0);
		const error = errors[0];
		expect(state.data.blocks.filter((block) => block.kind === "subagent" && block.progress.status === "running")).toHaveLength(0);
		expect(state.data.blocks.some((block) => block.kind === "notice" && block.level === "error" && block.text === error)).toBe(true);
		expect((await bot.harness.inspect(context)).tasks.some((task) => task.record.kind === "dinobot.subagent")).toBe(false);
		const reconnect = await attach(name);
		expect(reconnect.data.blocks.some((block) => block.kind === "notice" && block.level === "error" && block.text === error)).toBe(true);
		expect(reconnect.data.blocks.filter((block) => block.kind === "subagent" && block.progress.status === "running")).toHaveLength(0);
	}, 10_000);
}
