import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Commands } from "../src/commands/index.ts";
import { channelHandler } from "../src/core/channel-handler.ts";
import type { MessageHandler, ProgressEvent } from "../src/channels/types.ts";
import type { Models } from "@earendil-works/pi-ai";
import type { Bot } from "../src/core/bot.ts";
import { createNativeModelHandler } from "../src/core/native-model-commands.ts";

for (const whenBusy of [undefined, "steer"] as const) {
 test(`native channel ordinary ingress preserves progress, cancellation and ${whenBusy ?? "default"} admission`, async () => {
  const abort = new AbortController();
  const events: ProgressEvent[] = [];
  const progress = (event: ProgressEvent) => { events.push(event); };
  const options = whenBusy ? { whenBusy } : undefined;
  const message = { channel: "telegram", threadKey: "bot:chat:topic:user", messageId: "ordinary", userId: "user", text: "/fast toggle" };
  const reply = { status: "answered" as const, text: "ordinary answer", answer: 42 };
  const bot = { handle: (async (input, context, sink, handling) => {
   expect(input).toBe(message);
   expect(context.abortSignal).toBe(abort.signal);
   expect(sink).toBe(progress);
   expect(handling).toBe(options);
   sink?.({ type: "draft", text: "ordinary" });
   if (handling?.whenBusy === "steer") sink?.({ type: "steer" });
   return reply;
  }) satisfies Bot["handle"] };
  const models = {} as Models; // Ordinary ingress must not consult the model catalog.
  const native = createNativeModelHandler(bot as Bot, models, BACKGROUND_CONTEXT);
  const commands = { find() { throw new Error("privileged lookup must not run"); } } as unknown as Commands;
  const handler = channelHandler({ commandPolicy: "none" }, bot, commands, BACKGROUND_CONTEXT, native);
  expect(await handler(message, abort.signal, progress, options)).toBe(reply);
  expect(events).toEqual([{ type: "draft", text: "ordinary" }, ...(whenBusy ? [{ type: "steer" as const }] : [])]);
 });
}

test("native channel bypasses command lookup and propagates cancellation to durable waiter", async () => {
 let calls = 0; let seen: AbortSignal | undefined;
 const commands = { find() { throw new Error("privileged command lookup must not run"); } } as unknown as Commands;
 const bot = { async handle(message: { text: string }, context: typeof BACKGROUND_CONTEXT) { calls++; seen = context.abortSignal; expect(message.text).toBe("/fast toggle"); return { status: "answered" as const, text: "ok" }; } };
 const handler = channelHandler({ commandPolicy: "none" }, bot, commands, BACKGROUND_CONTEXT);
 const abort = new AbortController();
 await handler({ channel: "telegram", threadKey: "t", messageId: "1", userId: "u", text: "/fast toggle" }, abort.signal);
 expect(calls).toBe(1); expect(seen).toBe(abort.signal); abort.abort(); expect(seen?.aborted).toBe(true);
});

test("native safe controls are explicitly injected without privileged lookup or dropping signal", async () => {
 const commands = { find() { throw new Error("privileged lookup"); } } as unknown as Commands;
 const bot = { async handle() { throw new Error("wrong handler"); } };
 const abort = new AbortController();
 let calls = 0;
 const native: MessageHandler = async (message, signal) => {
  expect(message.text).toBe("/models"); expect(signal).toBe(abort.signal); calls++;
  return { status: "answered", text: "catalog" };
 };
 const handler = channelHandler({ commandPolicy: "none" }, bot, commands, BACKGROUND_CONTEXT, native);
 expect(await handler({ channel: "telegram", threadKey: "bot:chat:topic:user", messageId: "m", userId: "user", text: "/models" }, abort.signal)).toEqual({ status: "answered", text: "catalog" });
 expect(calls).toBe(1);
});
