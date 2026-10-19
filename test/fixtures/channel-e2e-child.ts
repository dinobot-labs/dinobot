import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openBot } from "../../src/core/bot.ts";
import { channelHandler } from "../../src/core/channel-handler.ts";
import { telegramChannel } from "../../src/channels/telegram.ts";
import type { Commands } from "../../src/commands/index.ts";

export const context = BACKGROUND_CONTEXT;
export const secret = "local-e2e-secret";
export const token = "123456:local_e2e_token";
export function telegramConfig(dir: string) {
 process.env.CHANNEL_E2E_TOKEN = token;
 process.env.CHANNEL_E2E_SECRET = secret;
 return { port: 0, databasePath: join(dir, "inbox.sqlite"), botTokenEnv: "CHANNEL_E2E_TOKEN", webhookSecretEnv: "CHANNEL_E2E_SECRET", allowedUserIds: ["1", "2"], allowedChatIds: ["-100"], requestTimeoutMs: 2000 };
}
export function forbiddenCommands(onAccess: () => void = () => {}): Commands {
 return new Proxy({} as Commands, { get() { onAccess(); throw new Error("native channel reached privileged command middleware"); } });
}
export async function openLocalBot(dir: string) {
 const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
 const models = createModels(); models.setProvider(faux.provider);
 const storage = await openNodeSqliteStorage(join(dir, "bot.sqlite"));
 const bot = await openBot({ storage, models, toolMode: "codemode-only", defaultModel: { provider: "faux", modelId: "faux-1" }, plugins: [] }, context);
 return { bot, faux };
}

// Only the test subprocess executes this branch. No live platform/provider access.
if (import.meta.main) {
 const [dir, apiBase, boundary] = process.argv.slice(2);
 if (!dir || !apiBase) throw new Error("missing child arguments");
 const { bot, faux } = await openLocalBot(dir);
 faux.setResponses([fauxAssistantMessage("durable child reply 🌍")]);
 const channel = telegramChannel(telegramConfig(dir), { apiBase });
 const handler = channelHandler(channel, bot, forbiddenCommands(), context);
 await channel.start(async (message, signal) => {
  const reply = await handler(message, signal);
  process.send?.({ kind: "handled", calls: faux.state.callCount });
  if (boundary === "before-completion") await new Promise<void>(() => {});
  return reply;
 });
 process.send?.({ kind: "ready", url: channel.url().href });
}
