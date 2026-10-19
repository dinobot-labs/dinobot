import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openBot } from "../src/core/bot.ts";
import { startClientApi } from "../src/api/server.ts";
import type { AuthService } from "../src/auth/types.ts";
import { createCommands } from "../src/commands/index.ts";
import { ApiClient } from "../src/tui/client.ts";
import type { ClientEvent, WorkflowStatus } from "../src/core/ui-contract.ts";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { createHarness } from "../script/bench/tui-render.ts";
import { ChatState } from "../src/tui/state.ts";

function status(event: ClientEvent): WorkflowStatus | null | undefined {
	return event.type === "snapshot" || event.type === "workflow_status" ? event.workflow : undefined;
}

for (const policy of ["default YOLO", "explicit enforcement"] as const) test(`${policy}: live API snapshots and document updates retain unmet obligations after prose and abort`, async () => {
	const root = await mkdtemp(join(tmpdir(), "verification-api-"));
	const faux = fauxProvider({ provider: "faux", models: [{ id: "one" }] });
	const models = createModels(); models.setProvider(faux.provider);
	const bot = await openBot({ ...(policy === "explicit enforcement" ? { enforceVerification: true } : {}), storage: new MemoryStorage(), models, defaultModel: { provider: "faux", modelId: "one" }, toolMode: "direct", plugins: [], workspaceRoot: root }, context);
	const api = startClientApi(bot, 0, context, createCommands({ bot, models, auth: {} as AuthService, plugins: [], disabled: [] }));
	const client = new ApiClient(api.url);
	const controllers: AbortController[] = [];
	const streams: Promise<void>[] = [];
	let streamError: unknown;
	const listeners = new Set<() => void>();
	const until = (predicate: () => boolean): Promise<void> => new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			listeners.delete(check);
			reject(new Error("Workflow SSE observation timed out"));
		}, 5000);
		const check = () => {
			if (!predicate()) return;
			clearTimeout(timer);
			listeners.delete(check);
			resolve();
		};
		listeners.add(check);
		check();
	});
	const observe = (thread: string) => {
		const events: ClientEvent[] = [];
		const controller = new AbortController(); controllers.push(controller);
		streams.push(client.events("tui", thread, (event) => {
			events.push(event);
			for (const listener of listeners) listener();
		}, controller.signal).catch((error) => {
			if (!controller.signal.aborted) streamError = error;
		}));
		return events;
	};
	try {
		const events = observe("work");
		await until(() => events.some((event) => event.type === "snapshot"));
		expect(status(events[0]!)?.status).toBe("informational");
		faux.setResponses([fauxAssistantMessage("The answer text says done, not a certificate.")]);
		const conversation = await bot.conversation("tui", "work", context);
		const input = await conversation.submit({ type: "input", content: "Inspect this request", requestId: "api-work" }, context);
		await input.wait(context);
		const planned = await bot.work.register(conversation.id, {
			sourceIds: [String(input.id)],
			contract: {
				requirements: [{ id: "r", assertion: "Required scenario actually passes", checkIds: ["check"], scenarioIds: ["scenario"] }],
				scenarios: [{ id: "scenario", assertion: "Observe the required behavior" }],
				checks: [{ id: "check", requirementIds: ["r"], scenarioIds: ["scenario"], evidence: "behavioral", expected: "Named scenario executes successfully" }],
			},
			scope: { root, inputs: [], disposable: [] },
			methods: { check: { command: process.execPath, cwd: root, runner: "bun", args: ["./required.test.ts"], timeout: 5, adapterVersion: 1, locators: [{ scenarioId: "scenario", file: "required.test.ts", name: "required scenario" }] } },
		}, "api-plan", context);
		await until(() => events.some((event) => status(event)?.workId === planned.workId));
		expect(events.flatMap((event) => status(event) ? [status(event)!.status] : [])).not.toContain("verified");
		await bot.work.settle(conversation.id, planned.workId!, "blocked", "Required report is missing", context);
		await until(() => events.some((event) => event.type === "workflow_status" && event.workflow?.status === "blocked"));
		const blocked = events.map(status).findLast((value) => value?.status === "blocked")!;
		expect(blocked.certificate).toBeNull();
		expect(blocked.unmetCheckIds).toEqual(["check"]);
		expect(blocked.blockers).toContain("Required report is missing");
		expect(blocked.plan).toEqual({
			requirements: [{ id: "r", assertion: "Required scenario actually passes", checkIds: ["check"], state: "pending" }],
			checks: [{ id: "check", evidence: "behavioral", expected: "Named scenario executes successfully", state: "pending" }],
		});

		const restored = observe("work");
		await until(() => restored.some((event) => event.type === "snapshot"));
		expect(status(restored[0]!)?.status).toBe("blocked");
		expect(status(restored[0]!)?.workId).toBe(planned.workId);
		// The TUI draws the plan from the real event stream, not from a fixture.
		const state = new ChatState();
		for (const event of restored) state.apply(event);
		const harness = createHarness(state, 100, 30);
		try {
			expect(harness.screen.mode).toBe("prompt");
			expect(harness.screen.todoPane.render(100)).toHaveLength(1);
			harness.screen.toggleTodoPane();
			harness.screen.tui.renderNow();
			const screen = stripTerminalSequences(harness.terminal.buffer);
			expect(screen).toContain("Plan 0/1 checks · blocked");
			expect(screen).toContain("[ ] r Required scenario actually passes");
			expect(screen).toContain("[ ] check not run  Named scenario executes successfully");
		} finally {
			harness.dispose();
		}
		await client.abort("tui", "work");
		await until(() => events.some((event) => status(event)?.status === "cancelled"));
		expect((await bot.work.status(conversation.id, context)).certificate).toBeNull();

		const other = observe("other");
		await until(() => other.some((event) => event.type === "snapshot"));
		expect(status(other[0]!)?.status).toBe("informational");
		expect(status(other[0]!)?.workId).toBeNull();
		expect(streamError).toBeUndefined();
	} finally {
		for (const controller of controllers) controller.abort();
		await Promise.all(streams);
		await api.stop();
		await bot.close(context);
		await rm(root, { recursive: true, force: true });
	}
});
