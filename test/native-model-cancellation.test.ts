import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import type { Bot } from "../src/core/bot.ts";
import { createNativeModelHandler } from "../src/core/native-model-commands.ts";
import { withConversationAdmission } from "../src/core/queue.ts";

for (const text of ["/model p/m", "/models"]) test("native catalog cancellation releases waiter/admission: " + text, async () => {
 const entered = Promise.withResolvers<void>();
 const release = Promise.withResolvers<never[]>();
 let optionsSignal: AbortSignal | undefined, settled = false, admitted = false;
 // Only the thread index is present: "slack:one" is bound to conversation 42 (admission re-checks the binding).
 const harness = { snapshot: async (token: { definition?: { kind?: string } }) => token.definition?.kind === "dinobot.threads" ? { threads: { "slack:one": 42 } } : undefined };
 const models = { getModel: () => ({}), getAvailable(_provider: unknown, options?: { signal?: AbortSignal }) {
  optionsSignal = options?.signal; entered.resolve();
  return new Promise<never[]>((resolve, reject) => {
   const abort = () => reject(optionsSignal?.reason);
   optionsSignal?.addEventListener("abort", abort, { once: true });
   release.promise.then(resolve).finally(() => optionsSignal?.removeEventListener("abort", abort));
  });
 } };
 const bot = { harness, conversation: async () => ({ id: 42 }) } as unknown as Bot;
 const handler = createNativeModelHandler(bot, models as unknown as Models, BACKGROUND_CONTEXT);
 const cancel = new AbortController();
 const task = handler({ channel: "slack", threadKey: "one", userId: "U1", messageId: "1", text }, cancel.signal).catch(() => {}).finally(() => { settled = true; });
 await entered.promise; cancel.abort();
 const next = withConversationAdmission(bot.harness, 42 as never, async () => { admitted = true; });
 try {
  await Bun.sleep(30); expect(optionsSignal).toBe(cancel.signal); expect(settled).toBe(true); expect(admitted).toBe(true);
 } finally { release.resolve([]); await task; await next; }
});
