import { Type } from "@earendil-works/pi-ai";
import type { Static, TSchema } from "typebox";
import { httpChannel } from "./http.ts";
import { SlackConfigSchema, createSlackChannel } from "./slack.ts";
export { SlackConfigSchema, createSlackChannel } from "./slack.ts";
export type { SlackConfig } from "./slack.ts";
import { DiscordConfigSchema, discordChannel } from "./discord.ts";
import { TelegramConfigSchema, telegramChannel } from "./telegram.ts";
export { DiscordConfigSchema, discordChannel } from "./discord.ts";
export { TelegramConfigSchema, telegramChannel } from "./telegram.ts";
export type { DiscordConfig } from "./discord.ts";
export type { TelegramConfig } from "./telegram.ts";
import type { ChannelAdapter } from "./types.ts";

export type ChannelDefinition<Config extends TSchema = TSchema> = {
	readonly config: Config;
	create(config: Static<Config>): ChannelAdapter;
};

function defineChannel<Config extends TSchema>(definition: ChannelDefinition<Config>): ChannelDefinition {
	return definition as unknown as ChannelDefinition;
}

/** Every channel this build can run. Teams is not implemented; Slack supports signed Events API and Socket Mode. */
export const channelCatalog: Readonly<Record<string, ChannelDefinition>> = {
	slack: defineChannel({ config: SlackConfigSchema, create: createSlackChannel }),
	discord: defineChannel({ config: DiscordConfigSchema, create: discordChannel }),
	telegram: defineChannel({ config: TelegramConfigSchema, create: telegramChannel }),
	http: defineChannel({
		config: Type.Object({ port: Type.Integer({ minimum: 1, maximum: 65535 }) }),
		create: (config) => httpChannel(config.port),
	}),
};
