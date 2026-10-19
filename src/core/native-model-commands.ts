import type { Context } from "@earendil-works/chord";
import { withAbortSignal } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { InboxDoc, LiveDoc } from "@earendil-works/pi-durable";
import type { BotReply, InboundMessage, MessageHandler } from "../channels/types.ts";
import type { Bot } from "./bot.ts";
import { hasPendingQueueTransfer } from "./queue.ts";
import { currentThreadModel } from "./reasoning.ts";
import { conversationStatus } from "./sessions.ts";
import { rotateThread, selectModel, withThreadAdmission, type RotateResult } from "./threads.ts";

const USAGE = "Usage: /model [provider/modelId]; /models [provider] [page]";
const NEW_USAGE = "Usage: /new";
const NEW_REPLIES: Record<RotateResult["status"], string> = {
	rotated: "Started a new conversation. The previous conversation is kept as history.",
	unchanged: "This conversation is already empty; nothing to reset.",
	busy: "Cannot start a new conversation while this one is running, queued or has running subagents. Try again when it is idle.",
	moved: "New conversation unavailable. Try again later.",
	archived: "New conversation unavailable. Try again later.",
};
const PAGE_SIZE = 16;
// ASCII identifiers are portable across native renderers; model IDs may contain slashes.
const PROVIDER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;
const reply = (text: string): BotReply => ({ status: "answered", text });

/** Bound untrusted catalog/state labels without emitting native markup or control characters. */
function label(value: string, limit = 180): string {
	let result = "";
	let count = 0;
	for (const character of value) {
		if (count++ === limit) return result + "…";
		result += /[\p{C}<>`*_~&]/u.test(character) ? "?" : character;
	}
	return result;
}

/**
 * `/new` rebinds only the caller's own thread key to a fresh conversation (see {@link rotateThread});
 * the previous conversation stays readable as `<key>#<n>`. It never interrupts a running turn.
 */
async function newConversation(bot: Bot, models: Models, message: InboundMessage, context: Context): Promise<BotReply> {
	const key = `${message.channel}:${message.threadKey}`;
	const signal = context.abortSignal;
	const result = await withThreadAdmission(bot.harness, key, () => bot.conversation(message.channel, message.threadKey, context), context, async (conversation) => {
		signal?.throwIfAborted();
		const [status, entries] = await Promise.all([
			conversationStatus(bot.harness, conversation.id, context),
			conversation.entries({}, 1, undefined, context),
		]);
		signal?.throwIfAborted();
		return rotateThread(bot.harness, models, key, conversation.id, `${message.channel}:${message.messageId}`, context, {
			skipIfEmpty: entries.items.length === 0, busy: status.subagents.length > 0,
		});
	});
	return reply(NEW_REPLIES[result.status]);
}

/**
 * Only these native controls are intercepted: /model, /models and /new. Adapters own authorization, durable
 * input-message lifecycle and delivery retries. Selection is an idempotent set, not an
 * exactly-once claim. Never compose this with the privileged command registry remotely.
 */
export function createNativeModelHandler(
	bot: Bot, models: Models, context: Context, options: { enabled?: boolean; newConversation?: boolean } = {},
): MessageHandler {
	return async (message, signal, progress, handlingOptions) => {
		const command = /^(\/models|\/model|\/new)(?=\s|$)/.exec(message.text)?.[1];
		const ctx = signal ? withAbortSignal(signal, context) : context;
		if (!command) return bot.handle(message, ctx, progress, handlingOptions);
		signal = ctx.abortSignal;
		signal?.throwIfAborted();
		if (command === "/new") {
			if (options.newConversation === false) return reply("New conversation control is disabled.");
			if (message.text.trim() !== "/new" || (message.images?.length ?? 0) > 0 || (message.files?.length ?? 0) > 0) return reply(NEW_USAGE);
			try { return await newConversation(bot, models, message, ctx); }
			catch {
				signal?.throwIfAborted();
				return reply(NEW_REPLIES.moved);
			}
		}
		if (options.enabled === false) return reply("Native model controls are disabled.");
		if (message.text.length > 512 || (message.images?.length ?? 0) > 0 || (message.files?.length ?? 0) > 0) return reply(USAGE);
		const args = message.text.slice(command.length).trim().split(/\s+/).filter(Boolean);
		try {
			if (command === "/models") {
				if (args.length > 2) return reply(USAGE);
				const provider = args[0] && !/^\d+$/.test(args[0]) ? args[0] : undefined;
				const pageText = provider ? args[1] : args[0];
				if ((!provider && args.length > 1) || (provider && !PROVIDER.test(provider)) ||
					(pageText !== undefined && !/^[1-9]\d{0,8}$/.test(pageText))) return reply(USAGE);
				if (provider && !models.getProvider(provider)) return reply("Unknown provider.");
				const page = Number(pageText ?? "1");
				const refs = [...new Set((await models.getAvailable(provider, signal ? { signal } : undefined))
					.filter(model => (!provider || model.provider === provider) && models.getModel(model.provider, model.id))
					.map(model => `${model.provider}/${model.id}`))].sort();
				signal?.throwIfAborted();
				const pages = Math.max(1, Math.ceil(refs.length / PAGE_SIZE));
				if (page > pages) return reply("Page out of range.");
				const rows = refs.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map(ref => label(ref));
				return reply([`Available models — page ${page}/${pages}`, ...rows,
					...(refs.length ? [] : ["No models available."]), USAGE].join("\n"));
			}
			if (args.length === 0) {
				const state = await currentThreadModel(bot, message.channel, message.threadKey, ctx);
				signal?.throwIfAborted();
				return reply(`Current model: ${label(state.model)}\nReasoning: ${label(state.thinkingLevel)}\n${USAGE}`);
			}
			if (args.length !== 1) return reply(USAGE);
			const ref = args[0]!;
			const slash = ref.indexOf("/");
			const provider = ref.slice(0, slash);
			const modelId = ref.slice(slash + 1);
			if (slash < 1 || !PROVIDER.test(provider) || !MODEL.test(modelId)) return reply(USAGE);
			if (!models.getModel(provider, modelId)) return reply("Unknown model.");
			const key = `${message.channel}:${message.threadKey}`;
			return await withThreadAdmission(bot.harness, key, () => bot.conversation(message.channel, message.threadKey, ctx), ctx, async (conversation) => {
				signal?.throwIfAborted();
				const [live, inbox, transfer] = await Promise.all([
					bot.harness.snapshot(LiveDoc, conversation.id, ctx),
					bot.harness.snapshot(InboxDoc, conversation.id, ctx),
					hasPendingQueueTransfer(bot.harness, conversation.id, ctx),
				]);
				if (live?.run !== undefined || (inbox?.items.length ?? 0) > 0 || transfer) {
					return reply("Model selection is unavailable while this conversation is busy or queued.");
				}
				if (!(await models.getAvailable(provider, signal ? { signal } : undefined)).some(model => model.provider === provider && model.id === modelId)) {
					return reply("Model is unavailable.");
				}
				signal?.throwIfAborted();
				await selectModel(bot.harness, models, conversation.id, { provider, modelId }, ctx, signal, { persistDefault: false });
				return reply(`Model selected for this conversation: ${label(ref)}.`);
			});
		} catch {
			signal?.throwIfAborted();
			return reply("Model control unavailable. Try again later.");
		}
	};
}
