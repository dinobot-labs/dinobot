import type { Context } from "@earendil-works/chord";
import type { ConversationId } from "@earendil-works/pi-durable";
import { currentModel } from "../commands/builtin.ts";
import type { Bot } from "../core/bot.ts";
import { listThreads } from "../core/threads.ts";
import { captureVisibleExport } from "../core/visible-export.ts";
import { collectDiagnostics, diagnosticLines, reportUrl } from "./diagnostics.ts";
import type { RedactionCounts } from "./redact.ts";
import { ReportService, type ReportServiceOptions } from "./service.ts";

export type DaemonDiagnostics = {
	/** The manifest the daemon booted from. */
	readonly manifestPath?: string;
	/** Live process state for the `live` section. */
	readonly live?: () => Promise<unknown>;
	readonly liveChannels?: () => Promise<unknown>;
	/** Probes (daemon, network); the global fetch by default. Not the upload fetch: probes must not reach the ingest seam. */
	readonly fetch?: typeof fetch;
};

export { reportUrl };

/**
 * The daemon's report service: thread capture through the visible export (system prompts, reasoning
 * and binary payloads already removed) plus subagent conversations, and the diagnostic sections of
 * ADR 0103 in daemon mode (live state included).
 */
export function createReportService(bot: Bot, dataDir: string, version: string, context: Context, overrides: Partial<Omit<ReportServiceOptions, "capture">> = {}, diagnostics: DaemonDiagnostics = {}): ReportService {
	const url = overrides.url ?? reportUrl();
	return new ReportService({
		dataDir,
		version,
		url,
		log: (message) => console.error(`dinobot: ${message}`),
		capture: async (channel, threadKey, options) => {
			// A one-step report names a thread but must not create an empty session as a side effect.
			if (options?.mustExist && (await listThreads(bot.harness, context))[`${channel}:${threadKey}`] === undefined) throw new Error(`no thread ${channel}:${threadKey}`);
			const conversation = await bot.conversation(channel, threadKey, context);
			const exported = await bot.harness.commit((tx) => captureVisibleExport(tx, conversation.id as ConversationId), context);
			const model = await currentModel(bot, channel, threadKey, context).catch(() => undefined);
			return { root: conversation.id, entries: exported.entries, ...(model ? { model } : {}) };
		},
		diagnostics: async (request) => {
			const results = await collectDiagnostics({
				...(diagnostics.manifestPath ? { manifestPath: diagnostics.manifestPath } : {}),
				dataDir,
				mode: request.mode ?? "daemon",
				client: request.client,
				trigger: request.trigger,
				version,
				reportUrl: url,
				...(diagnostics.fetch ? { fetch: diagnostics.fetch } : {}),
				...(request.context !== undefined ? { context: request.context } : {}),
				...(diagnostics.live ? { live: diagnostics.live } : {}),
				...(diagnostics.liveChannels ? { liveChannels: diagnostics.liveChannels } : {}),
			});
			const redactions: RedactionCounts = {};
			return { lines: diagnosticLines(results, { counts: redactions }), redactions };
		},
		...overrides,
	});
}
