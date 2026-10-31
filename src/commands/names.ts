/** Every slash command the daemon implements; the manifest's `commands.disabled` may name only these. */
export const COMMAND_NAMES = ["accounts", "fast", "help", "login", "logout", "model", "plugins", "reasoning", "report", "search", "sessions", "setup", "skills", "slack"] as const;

export type CommandName = (typeof COMMAND_NAMES)[number];
