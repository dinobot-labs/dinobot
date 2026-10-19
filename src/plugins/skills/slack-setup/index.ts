// Guided Slack connection (ADR 0092 wildcard channels), modelled on hermes-agent's paste-in app manifest flow.
// Scripts and the manifest ship as .txt so TypeScript does not resolve them as modules; they are exposed under
// their real names as companion files.
import body from "./body.md" with { type: "text" };
import troubleshooting from "./references/troubleshooting.md" with { type: "text" };
import appManifest from "./slack-app-manifest.json.txt" with { type: "text" };
import slackCheck from "./scripts/slack-check.mjs.txt" with { type: "text" };
import restartWhenIdle from "./scripts/restart-when-idle.mjs.txt" with { type: "text" };
import detachWindows from "./scripts/detach-windows.ps1.txt" with { type: "text" };

export const slackSetupSkill = {
	name: "slack-setup",
	description: "Connect dinobot to Slack end to end or fix a Slack connection: hand the user a paste-in Slack app manifest, collect the two tokens and their member ID, verify tokens and derive appId/teamId/botUserId, write channels.slack (allowedChannelIds [\"*\"]), prove the boot with a disposable daemon, restart the live daemon yourself when idle, and diagnose missing replies. Use for 슬랙 연동, Slack setup, Slack bot not answering.",
	body: body.trim(),
	files: {
		"references/troubleshooting.md": troubleshooting,
		"scripts/detach-windows.ps1": detachWindows,
		"scripts/restart-when-idle.mjs": restartWhenIdle,
		"scripts/slack-check.mjs": slackCheck,
		"slack-app-manifest.json": appManifest,
	},
};
