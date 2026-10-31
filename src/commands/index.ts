import type { Context } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai";
import type { AuthService } from "../auth/types.ts";
import type { MessageHandler } from "../channels/types.ts";
import type { Bot } from "../core/bot.ts";
import type { LoadedPlugin } from "../plugins/types.ts";
import {
	accountsCommand,
	helpCommand,
	loginCommand,
	logoutCommand,
	modelCommand,
	pluginsCommand,
} from "./builtin.ts";
import { fastCommand } from "./fast.ts";
import { COMMAND_NAMES } from "./names.ts";
import { reasoningCommand } from "./reasoning.ts";
import { reportCommand } from "./report.ts";
import type { ReportService } from "../report/service.ts";
import { searchCommand, sessionsCommand } from "./sessions.ts";
import { type SetupDeps, setupCommand } from "./setup.ts";
import { skillsCommand } from "./skills.ts";
import { slackCommand } from "./slack.ts";
import type { CommandEvent, CommandInfo, CommandIO, CommandPromptSpec, ManifestApplyRequest, SlashCommand, Surface } from "./types.ts";

export { currentModel } from "./builtin.ts";
export { COMMAND_NAMES, type CommandName } from "./names.ts";

export type CommandDeps = {
	readonly bot: Bot;
	readonly models: Models;
	readonly auth: AuthService;
	readonly plugins: readonly LoadedPlugin[];
	/** Names from the manifest's `commands.disabled`, hidden on every surface. */
	readonly disabled?: readonly string[];
	/** Session reports (ADR 0073); absent in tests and embedders that do not report. */
	readonly report?: ReportService;
	/** The first-run wizard's manifest and data locations; without them there is no `/setup` (tests, embedders). */
	readonly setup?: SetupDeps;
};

export type CommandRequest = {
	readonly surface: Surface;
	readonly channel: string;
	readonly threadKey: string;
	readonly userId: string;
	/** The front end's locale, passed through to the command. */
	readonly locale?: string;
	readonly context: Context;
	/** Aborting it aborts the run: pending prompts reject and `io.signal` fires. */
	readonly signal?: AbortSignal;
};

/** `events` starts with `started` and ends with `done` or `error`. */
export type CommandRun = { readonly runId: string; readonly events: AsyncIterable<CommandEvent> };

export type PromptAnswer = { readonly value: string } | { readonly cancel: true };

export interface Commands {
	/** Enabled commands of a surface, sorted by name. */
	list(surface: Surface): CommandInfo[];
	find(name: string, surface: Surface): SlashCommand | undefined;
	run(command: SlashCommand, args: string, request: CommandRequest): CommandRun;
	/** False when the run or prompt is not pending. */
	answer(runId: string, promptId: string, answer: PromptAnswer): boolean;
}

type Pending = { resolve(value: string): void; reject(error: Error): void };

export function createCommands(deps: CommandDeps): Commands {
	const disabled = new Set(deps.disabled ?? []);
	for (const name of disabled) {
		if (!(COMMAND_NAMES as readonly string[]).includes(name)) {
			throw new Error(`unknown command "${name}" (available: ${COMMAND_NAMES.join(", ")})`);
		}
	}
	const all: SlashCommand[] = [
		helpCommand((surface) => list(surface)),
		loginCommand(deps.auth),
		logoutCommand(deps.auth),
		accountsCommand(deps.auth),
		modelCommand(deps.bot, deps.models),
		reasoningCommand(deps.bot, deps.models),
		fastCommand(deps.bot, deps.models),
		skillsCommand(deps.bot),
		pluginsCommand(deps.plugins),
		slackCommand(deps.bot, deps.plugins, deps.setup),
		searchCommand(deps.bot),
		sessionsCommand(deps.bot),
		...(deps.report ? [reportCommand(deps.report)] : []),
		...(deps.setup ? [setupCommand({ bot: deps.bot, models: deps.models, auth: deps.auth, ...(deps.report ? { report: deps.report } : {}) }, deps.setup)] : []),
	];
	const enabled = all.filter((command) => !disabled.has(command.name)).sort((a, b) => a.name.localeCompare(b.name));
	const runs = new Map<string, Map<string, Pending>>();

	function list(surface: Surface): CommandInfo[] {
		return enabled
			.filter((command) => command.surfaces.includes(surface))
			.map((command) => ({
				name: command.name,
				description: command.description,
				...(command.usage !== undefined ? { usage: command.usage } : {}),
			}));
	}

	function find(name: string, surface: Surface): SlashCommand | undefined {
		return enabled.find((command) => command.name === name && command.surfaces.includes(surface));
	}

	function run(command: SlashCommand, args: string, request: CommandRequest): CommandRun {
		const runId = crypto.randomUUID();
		const events = eventQueue<CommandEvent>();
		const abort = new AbortController();
		const onAbort = () => abort.abort(request.signal?.reason);
		if (request.signal?.aborted) onAbort();
		else request.signal?.addEventListener("abort", onAbort, { once: true });
		const prompts = new Map<string, Pending>();
		runs.set(runId, prompts);
		const interactive = request.surface === "tui";

		const io: CommandIO = {
			signal: abort.signal,
			interactive,
			print: (text, level = "info") => events.push({ type: "output", text, level }),
			notify: (event) => events.push({ type: "auth", event }),
			state: (change) => events.push({ type: "state", ...change }),
			...(interactive ? { apply: (request: ManifestApplyRequest) => events.push({ type: "apply", request }) } : {}),
			prompt: ({ signal, ...spec }) => {
				if (!interactive) return Promise.reject(new Error(`/${command.name} needs input; run it from the TUI`));
				const cancelled = signal ? AbortSignal.any([abort.signal, signal]) : abort.signal;
				if (cancelled.aborted) return Promise.reject(new Error("aborted"));
				return new Promise<string>((resolve, reject) => {
					const id = crypto.randomUUID();
					const settle = () => {
						prompts.delete(id);
						cancelled.removeEventListener("abort", onCancel);
					};
					const onCancel = () => {
						settle();
						reject(new Error("aborted"));
					};
					cancelled.addEventListener("abort", onCancel, { once: true });
					prompts.set(id, {
						resolve: (value) => {
							settle();
							resolve(value);
						},
						reject: (error) => {
							settle();
							reject(error);
						},
					});
					events.push({ type: "prompt", id, prompt: spec as CommandPromptSpec });
				});
			},
		};

		events.push({ type: "started", runId });
		void (async () => {
			try {
				await command.run(args, {
					surface: request.surface,
					channel: request.channel,
					threadKey: request.threadKey,
					userId: request.userId,
					...(request.locale !== undefined ? { locale: request.locale } : {}),
					context: request.context,
					io,
				});
				events.push({ type: "done" });
			} catch (error) {
				events.push({ type: "error", message: abort.signal.aborted ? "aborted" : errorMessage(error) });
			} finally {
				for (const pending of prompts.values()) pending.reject(new Error("run ended"));
				runs.delete(runId);
				request.signal?.removeEventListener("abort", onAbort);
				events.close();
			}
		})();
		return { runId, events };
	}

	function answer(runId: string, promptId: string, answer: PromptAnswer): boolean {
		const pending = runs.get(runId)?.get(promptId);
		if (pending === undefined) return false;
		if ("cancel" in answer) pending.reject(new Error("cancelled"));
		else pending.resolve(answer.value);
		return true;
	}

	return { list, find, run, answer };
}

/**
 * Run slash commands from channel messages without a model call; everything else goes to `handler`.
 * Commands not enabled on "channel" (disabled, TUI-only, misspelled) answer as unknown.
 */
export function withCommands(commands: Commands, handler: MessageHandler, context: Context): MessageHandler {
	return async (message, signal, progress, options) => {
		const match = /^\/(\S*)\s*([\s\S]*)$/.exec(message.text.trim());
		if (match === null) return handler(message, signal, progress, options);
		const word = match[1] as string;
		const command = commands.find(word.toLowerCase(), "channel");
		if (command === undefined) return { status: "answered", text: `unknown command /${word}; try /help` };
		const lines: string[] = [];
		const run = commands.run(command, match[2] as string, {
			surface: "channel",
			channel: message.channel,
			threadKey: message.threadKey,
			userId: message.userId,
			context,
		});
		for await (const event of run.events) {
			if (event.type === "output") lines.push(event.text);
			else if (event.type === "error") lines.push(`error: ${event.message}`);
		}
		return { status: "answered", text: lines.join("\n") };
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function eventQueue<T>(): AsyncIterable<T> & { push(item: T): void; close(): void } {
	const items: T[] = [];
	let closed = false;
	let wake: (() => void) | undefined;
	const notify = () => {
		wake?.();
		wake = undefined;
	};
	return {
		push(item) {
			if (closed) return;
			items.push(item);
			notify();
		},
		close() {
			closed = true;
			notify();
		},
		async *[Symbol.asyncIterator]() {
			while (true) {
				const next = items.shift();
				if (next !== undefined) yield next;
				else if (closed) return;
				else await new Promise<void>((resolve) => (wake = resolve));
			}
		},
	};
}
