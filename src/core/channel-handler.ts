import type { Context } from "@earendil-works/chord";
import { withAbortSignal } from "@earendil-works/chord/context";
import type { ChannelAdapter, MessageHandler } from "../channels/types.ts";
import { withCommands, type Commands } from "../commands/index.ts";
import type { Bot } from "./bot.ts";

/** Native identities use only the optional narrow controls; privileged local middleware is never remote. */
export function channelHandler(
 channel: Pick<ChannelAdapter, "commandPolicy">, bot: Pick<Bot, "handle">, commands: Commands, context: Context, nativeHandler?: MessageHandler,
): MessageHandler {
 const handle: MessageHandler = (message, signal, progress, options) => bot.handle(message, signal ? withAbortSignal(signal, context) : context, progress, options);
 return channel.commandPolicy === "none" ? (nativeHandler ?? handle) : withCommands(commands, handle, context);
}
