import type { Context } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai";
import { AgentDoc } from "@earendil-works/pi-durable";
import type { Bot } from "../core/bot.ts";
import { FastDoc, fastState } from "../core/fast.ts";
import { selectFast } from "../core/threads.ts";
import type { CommandArgument, SlashCommand } from "./types.ts";

async function currentFast(bot: Bot, models: Models, channel: string, threadKey: string, context: Context) {
	const conversation = await bot.conversation(channel, threadKey, context);
	const [agent, stored] = await Promise.all([
		bot.harness.snapshot(AgentDoc, conversation.id, context),
		bot.harness.snapshot(FastDoc, conversation.id, context),
	]);
	const name = agent?.model ? `${agent.model.provider}/${agent.model.modelId}` : "the current model";
	return { ...fastState(models, agent?.model, stored?.fast), unavailable: `Fast mode is unavailable for ${name}.` };
}

export function fastCommand(bot: Bot, models: Models): SlashCommand {
	const rows = (state: { fast: boolean; fastSupported: boolean; unavailable: string }): CommandArgument[] => [
		{ value: "on", label: "on", description: "Priority service tier: faster responses at higher cost", current: state.fastSupported && state.fast },
		{ value: "off", label: "off", description: "Standard service tier", current: state.fastSupported && !state.fast },
	].map((row) => (state.fastSupported ? row : { ...row, disabled: true, description: state.unavailable }));
	return {
		name: "fast",
		description: "Toggle the fast service tier and save it as the default",
		usage: "[on|off|toggle]",
		surfaces: ["tui", "channel"],
		arguments: async (context, { channel, threadKey }) => rows(await currentFast(bot, models, channel, threadKey, context)),
		run: async (args, { channel, threadKey, context, io }) => {
			let choice = args.trim().toLowerCase();
			if (choice === "") {
				const { unavailable, ...state } = await currentFast(bot, models, channel, threadKey, context);
				io.state(state);
				if (!state.fastSupported) {
					io.print(unavailable);
					return;
				}
				if (!io.interactive) {
					io.print(`fast: ${state.fast ? "on" : "off"}`);
					return;
				}
				choice = await io.prompt({
					type: "select",
					message: "Fast mode",
					options: rows({ ...state, unavailable }).map(({ value, ...rest }) => ({ id: value, ...rest })),
				});
			}
			if (choice !== "on" && choice !== "off" && choice !== "toggle") throw new Error(`expected on, off or toggle, got "${choice}"`);
			io.signal.throwIfAborted();
			const conversation = await bot.conversation(channel, threadKey, context);
			const state = await selectFast(bot.harness, models, conversation.id, choice, context, io.signal);
			io.state(state);
			io.print(`fast mode ${state.fast ? "on" : "off"} (next model request)`, "success");
		},
	};
}
