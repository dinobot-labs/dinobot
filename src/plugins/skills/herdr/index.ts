// Project-authored public integration note, not the upstream --skill output.
import body from "./body.md" with { type: "text" };

export const herdrSkill = {
	name: "herdr",
	description:
		"Control Herdr, a terminal multiplexer for coding agents. Use only when the user explicitly mentions Herdr or asks to use Herdr to inspect or control panes, tabs, workspaces, commands, or another agent. Do not use merely because a task could benefit from a background terminal, delegation, or parallel work. Requires HERDR_ENV=1.",
	body: body.trim(),
};
