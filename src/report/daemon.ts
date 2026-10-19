import type { Context } from "@earendil-works/chord";
import type { ConversationId } from "@earendil-works/pi-durable";
import { currentModel } from "../commands/builtin.ts";
import type { Bot } from "../core/bot.ts";
import { captureVisibleExport } from "../core/visible-export.ts";
import { ReportService, type ReportServiceOptions } from "./service.ts";

/**
 * The daemon's report service: thread capture through the visible export (system prompts, reasoning
 * and binary payloads already removed) plus subagent conversations. `DINOBOT_REPORT_URL` points
 * tests at another ingest endpoint.
 */
export function createReportService(bot: Bot, dataDir: string, version: string, context: Context, overrides: Partial<Omit<ReportServiceOptions, "capture">> = {}): ReportService {
	return new ReportService({
		dataDir,
		version,
		...(process.env.DINOBOT_REPORT_URL ? { url: process.env.DINOBOT_REPORT_URL } : {}),
		log: (message) => console.error(`dinobot: ${message}`),
		capture: async (channel, threadKey) => {
			const conversation = await bot.conversation(channel, threadKey, context);
			const exported = await bot.harness.commit((tx) => captureVisibleExport(tx, conversation.id as ConversationId), context);
			const model = await currentModel(bot, channel, threadKey, context).catch(() => undefined);
			return { root: conversation.id, entries: exported.entries, ...(model ? { model } : {}) };
		},
		...overrides,
	});
}
