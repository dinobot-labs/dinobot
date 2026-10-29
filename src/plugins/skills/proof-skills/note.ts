/**
 * The dinobot adaptation prepended to every vendored proof-skills body. Upstream targets Claude Code, where
 * ${CLAUDE_SKILL_DIR} is a directory on disk and an Artifact tool exists; dinobot has neither.
 */
export const PROOF_SKILLS = ["formal-verify", "tlaplus-model", "lean-model", "proof-simplify"] as const;

export function dinobotNote(name: string): string {
	return `## Running this skill in dinobot

Bundled from opum-ai/proof-skills (MIT, see the LICENSE companion file). dinobot does not set \${CLAUDE_SKILL_DIR} and keeps companion files in its skill store, not on disk. Before the first script or asset path below, materialize all four proof skills (they reference each other) in one codemode cell:

1. For each of ${PROOF_SKILLS.join(", ")}: call skills_load({name}), then skills_read_file({name, version, path}) for every path in its files list, and write the content to ~/.cache/proof-skills/skills/<name>/<path>.
2. Run chmod +x on every scripts/*.sh you wrote.

From then on read \${CLAUDE_SKILL_DIR} as ~/.cache/proof-skills/skills/${name} (an absolute path; expand ~). Tools that the setup scripts install go to ~/.cache/proof-skills, the default PROOF_SKILLS_TOOLS. There is no Artifact tool: publish reports with the HTML-file fallback the skill describes.`;
}
