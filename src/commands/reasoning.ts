import type { Models, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Bot } from "../core/bot.ts";
import { currentReasoning, type ReasoningState } from "../core/reasoning.ts";
import { selectReasoning } from "../core/threads.ts";
import type { CommandArgument, SlashCommand } from "./types.ts";

const DESCRIPTIONS: Record<ModelThinkingLevel, string> = {
	off: "No extended reasoning",
	minimal: "Minimal reasoning for quick answers",
	low: "Light reasoning",
	medium: "Balanced reasoning and speed",
	high: "Thorough reasoning for complex tasks",
	xhigh: "Extra reasoning effort",
	max: "Maximum reasoning effort",
};

function reasoningArguments(state: ReasoningState): CommandArgument[] {
	return state.supportedThinkingLevels.map((level) => ({
		value: level,
		label: level,
		description: DESCRIPTIONS[level],
		current: level === state.thinkingLevel,
	}));
}

export function reasoningCommand(bot: Bot, models: Models): SlashCommand {
	return {
		name: "reasoning",
		description: "Choose reasoning effort and save it as the default",
		usage: "[level|cycle]",
		surfaces: ["tui", "channel"],
		arguments: async (context, { channel, threadKey }) => reasoningArguments(await currentReasoning(bot, models, channel, threadKey, context)),
		run: async (args, { channel, threadKey, context, io }) => {
			let choice = args.trim();
			if (choice === "") {
				const state = await currentReasoning(bot, models, channel, threadKey, context);
				io.state(state);
				const rows = reasoningArguments(state);
				if (!rows.some((row) => row.value !== "off")) {
					io.print(rows.length === 0 ? "Reasoning controls are unavailable for the current model." : "The current model does not support reasoning (off).");
					return;
				}
				if (!io.interactive) {
					io.print([
						`current reasoning: ${state.thinkingLevel}`,
						...rows.map((row) => `${row.current ? "* " : "  "}${row.value}  ${row.description}`),
					].join("\n"));
					return;
				}
				choice = await io.prompt({
					type: "select",
					message: "Choose reasoning effort",
					options: rows.map(({ value, ...rest }) => ({ id: value, ...rest })),
				});
			}
			io.signal.throwIfAborted();
			const conversation = await bot.conversation(channel, threadKey, context);
			const state = await selectReasoning(bot.harness, models, conversation.id, choice, context, io.signal);
			io.state(state);
			io.print(`reasoning set to ${state.thinkingLevel} (next model request)`, "success");
		},
	};
}
