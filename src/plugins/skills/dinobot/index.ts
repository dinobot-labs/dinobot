// dinobot's own operating guide (hub + references), bundled like hermes-agent's self skill.
// Markdown is embedded as text so the compiled binary and npm bundle carry it.
import body from "./body.md" with { type: "text" };
import cliAndDaemon from "./references/cli-and-daemon.md" with { type: "text" };
import channels from "./references/channels.md" with { type: "text" };
import commandsAndFeatures from "./references/commands-and-features.md" with { type: "text" };
import configuration from "./references/configuration.md" with { type: "text" };
import models from "./references/models.md" with { type: "text" };
import plugins from "./references/plugins.md" with { type: "text" };
import troubleshooting from "./references/troubleshooting.md" with { type: "text" };

export const dinobotSkill = {
	name: "dinobot",
	description: "Use, configure and operate dinobot itself: dinobot.yaml settings and defaults, changing the default model (/model, bot.model), /login accounts, channels (Slack, Discord, Telegram, HTTP), plugins (web search, GitHub, MCP, computer, skills), slash commands, daemon restart, update and troubleshooting. Load before answering any question about how dinobot works or is configured.",
	body: body.trim(),
	files: {
		"references/channels.md": channels,
		"references/cli-and-daemon.md": cliAndDaemon,
		"references/commands-and-features.md": commandsAndFeatures,
		"references/configuration.md": configuration,
		"references/models.md": models,
		"references/plugins.md": plugins,
		"references/troubleshooting.md": troubleshooting,
	},
};
