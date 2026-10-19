import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { FauxResponseFactory, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { type ConversationId, LiveDoc } from "@earendil-works/pi-durable";
import { AsksDoc } from "../../src/core/ask.ts";
import type { Bot } from "../../src/core/bot.ts";
import { DagSeenDoc, RunDoc, runStateKey } from "../../src/core/dag.ts";
import { WAKE_PREFIX, WakeDoc } from "../../src/extensions/subagents.ts";

/**
 * ADR 0096 for fixtures that script a fixed queue of faux replies and fabricate DAG states: an idle orchestrator is now
 * woken by its DAG asks and stops. Such a wake is answered here with a plain "noted" that does not consume the scripted
 * queue, and `quiet` records fabricated states as already seen, so the fixture's own replies stay deterministic.
 */
export function wakeAware(faux: ReturnType<typeof fauxProvider>): { wakes: string[] } {
	const wakes: string[] = [];
	let scripted: Parameters<typeof faux.setResponses>[0] = [];
	const route: FauxResponseFactory = async (transcript, ...rest) => {
		const last = transcript.messages.findLast((message) => message.role === "user")?.content;
		const user = typeof last === "string" ? last : JSON.stringify(last);
		const results = transcript.messages.slice(transcript.messages.findLastIndex((message) => message.role === "user") + 1).some((message) => message.role === "toolResult");
		if (user.startsWith(WAKE_PREFIX) && !results) { wakes.push(user); return fauxAssistantMessage("noted"); }
		const next = scripted.shift();
		if (next === undefined) throw new Error("No more faux responses queued");
		return typeof next === "function" ? next(transcript, ...rest) : next;
	};
	const set = faux.setResponses.bind(faux);
	faux.setResponses = (responses) => { scripted = [...responses]; set(Array.from({ length: 500 }, () => route)); };
	return { wakes };
}

/** Waits until no wake is pending or running for the conversation. */
export async function settleWakes(bot: Bot, conversationId: ConversationId): Promise<void> {
	for (let i = 0; i < 300; i++) {
		const live = await bot.harness.snapshot(LiveDoc, conversationId, context);
		const wake = await bot.harness.snapshot(WakeDoc, conversationId, context);
		const task = wake?.task === undefined ? undefined : await bot.harness.getTask(wake.task, context);
		const asks = (await bot.harness.snapshot(AsksDoc, conversationId, context))?.asks.filter((ask) => ask.state === "open" && ask.node !== undefined) ?? [];
		const announced = asks.every((ask) => wake?.notified.includes(`ask:${ask.id}`));
		if (!live?.run && announced && (task === undefined || task.state.status === "terminal" || (task.state as { checkpoint?: { phase?: string } }).checkpoint?.phase === "wait")) return;
		await Bun.sleep(10);
	}
}

/** Records every run's current state as seen by the model and every open ask as announced. */
export async function quiet(bot: Bot, conversationId: ConversationId): Promise<void> {
	await bot.harness.commit(async (tx) => {
		const seen = await tx.doc(DagSeenDoc, conversationId);
		for (const run of (await tx.doc(RunDoc, conversationId)).runs) seen.seen[run.id] = runStateKey(run);
		const wake = await tx.doc(WakeDoc, conversationId);
		for (const ask of (await tx.doc(AsksDoc, conversationId)).asks) if (ask.state === "open" && !wake.notified.includes(`ask:${ask.id}`)) wake.notified.push(`ask:${ask.id}`);
		return undefined;
	}, context);
}
