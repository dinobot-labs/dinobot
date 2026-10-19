import type { Context } from "@earendil-works/chord";
import type { Models, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { AgentDoc, type ModelRef } from "@earendil-works/pi-durable";
import type { Bot } from "./bot.ts";
import { FastDoc, fastState, type FastState } from "./fast.ts";

export interface ReasoningState {
	readonly thinkingLevel: ModelThinkingLevel;
	readonly supportedThinkingLevels: readonly ModelThinkingLevel[];
}

/** Resolve the effective concrete level using the installed model catalog. */
export function reasoningState(models: Models, ref: ModelRef | undefined, requested: ModelThinkingLevel = "off"): ReasoningState {
	const model = ref && models.getModel(ref.provider, ref.modelId);
	if (!model) return { thinkingLevel: "off", supportedThinkingLevels: [] };
	return {
		thinkingLevel: clampThinkingLevel(model, requested),
		supportedThinkingLevels: getSupportedThinkingLevels(model),
	};
}

export async function currentReasoning(
	bot: Bot,
	models: Models,
	channel: string,
	threadKey: string,
	context: Context,
): Promise<ReasoningState> {
	const conversation = await bot.conversation(channel, threadKey, context);
	const agent = await bot.harness.snapshot(AgentDoc, conversation.id, context);
	return reasoningState(models, agent?.model, agent?.thinkingLevel);
}

/** Read model and reasoning together so clients never combine separate revisions. */
export async function currentThreadModel(
	bot: Bot,
	channel: string,
	threadKey: string,
	context: Context,
): Promise<ReasoningState & FastState & { readonly model: string }> {
	const conversation = await bot.conversation(channel, threadKey, context);
	const [agent, fast] = await Promise.all([
		bot.harness.snapshot(AgentDoc, conversation.id, context),
		bot.harness.snapshot(FastDoc, conversation.id, context),
	]);
	if (!agent?.model) throw new Error("The current thread has no configured model.");
	return {
		model: `${agent.model.provider}/${agent.model.modelId}`,
		...reasoningState(bot.models, agent.model, agent.thinkingLevel),
		...fastState(bot.models, agent.model, fast?.fast),
	};
}
