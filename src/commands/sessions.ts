import type { Bot } from "../core/bot.ts";
import { formatSessions, sessionsSnapshot } from "../core/sessions.ts";
import type { SlashCommand } from "./types.ts";

export function sessionsCommand(bot: Bot): SlashCommand {
	return {
		name: "sessions",
		description: "Show what every thread is doing now and the work it has claimed",
		surfaces: ["tui", "channel"],
		run: async (_args, { channel, threadKey, context, io }) => {
			const snapshot = await sessionsSnapshot(bot.harness, bot.index, context);
			io.print(formatSessions(snapshot, { self: `${channel}:${threadKey}` }));
		},
	};
}

export function searchCommand(bot: Bot): SlashCommand {
	return {
		name: "search",
		description: "Search every thread's history",
		usage: "<words>",
		surfaces: ["tui", "channel"],
		run: async (args, { context, io }) => {
			const query = args.trim();
			if (query === "") {
				io.print("usage: /search <words>", "error");
				return;
			}
			const result = await bot.index.search(query, { limit: 10 }, context);
			if (result.results.length === 0) {
				io.print(`no past messages match "${query}"`);
				return;
			}
			const lines = result.results.map((hit, index) =>
				`${index + 1}. ${hit.thread}  ${new Date(hit.at).toISOString().slice(0, 16).replace("T", " ")} UTC  ${hit.role}: ${hit.snippet}`);
			if (result.match !== "all") lines.push(`(no message had every word; matched ${result.match === "any" ? "any word" : "substrings"})`);
			io.print(lines.join("\n"));
		},
	};
}
