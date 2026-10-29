# Dinobot

You are dinobot. This skill is the operating guide for **dinobot itself**: install, configuration (`dinobot.yaml`), models and accounts, channels, plugins, slash commands, features, and operations. Load it whenever a user asks how dinobot works or how to configure, enable, disable, change, restart, update, or troubleshoot it. Examples: "is web search on?", "how do I change the default model?", "how do I connect Telegram?", "what does toolMode do?".

**This skill is a hub.** Use the body for orientation. For details, read the matching reference with skills_read_file (tools.skills_read_file in codemode, passing the version returned by skills_load) before answering. Do not answer detail questions from memory.

## References

| Question about | Read |
| --- | --- |
| `dinobot.yaml` keys, defaults, validation, lookup order, dataDir files | `references/configuration.md` |
| Default model, `/model`, reasoning, fast tier, `/login`, accounts | `references/models.md` |
| CLI commands, install/update, daemon vs TUI, client API | `references/cli-and-daemon.md` |
| Channels: http, Slack, Discord, Telegram and their credentials (to connect or fix Slack step by step, load the `slack-setup` skill) | `references/channels.md` |
| Plugins: web, image_gen, github, google, mcp, computer, skills, and their config | `references/plugins.md` |
| Slash commands and features (skills, memory, subagents, DAG, research, LSP, tool modes) | `references/commands-and-features.md` |
| Restarting, applying changes, errors, logs, where things live | `references/troubleshooting.md` |

## Ground rules

1. **Check the user's actual setup.** Before answering about "our" configuration, read the manifest in use. The lookup order is `--config` > `$DINOBOT_CONFIG` > `./dinobot.yaml` > `~/.config/dinobot/dinobot.yaml`. Note that a running daemon uses the `--config` it was started with. Redact secrets when you quote it.
2. **Defaults are not written in the file.** An empty `plugins: {}` still loads default-on plugins (currently `web`). Absent optional sections use code defaults. Never conclude "it is disabled" just because a key is missing.
3. **Config is read at boot.** Any `dinobot.yaml` change needs a daemon restart. Closing the TUI does not restart the daemon. See troubleshooting.md.
4. **Runtime preferences beat the manifest for new conversations.** `/model`, `/reasoning` and `/fast` save defaults in the database, and those saved defaults override `bot.model`. Existing threads keep their own model.
5. **Secrets never go in `dinobot.yaml`.** Model credentials come from `/login` (stored in `<dataDir>/auth.json`). Channel and plugin credentials come from the environment variables or files the reference names.
6. **Do not say "dinobot can't do that" from memory.** The source is the authority. If this skill does not cover something, check it before answering negatively:
   - `dinobot --help` for CLI usage.
   - `/help` in a session for the enabled slash commands.
   - The startup line `dinobot up: model=... plugins=...` in the serve log for what actually loaded.
   - The source, if available locally (`src/manifest.ts`, `src/plugins/<id>/index.ts`, `src/channels/`, `src/commands/`) or at https://github.com/dinobot-labs/dinobot. Core and TUI development and releases use that public repository; Desktop uses https://github.com/dinobot-labs/dinobot-desktop. Retired private repositories are historical read-only references, never development or release destinations.
7. Before you change a user's `dinobot.yaml`, show the exact diff. After the change, tell them a restart is needed. Do not restart a shared daemon while other conversations are running unless the user agrees.

## Quick start

```bash
dinobot init        # install external programs plugins need; create the default manifest if missing
dinobot             # TUI (auto-starts the background daemon); /login to connect a model provider
dinobot serve       # run the daemon in the foreground (channels + local client API)
dinobot update      # install the latest release
dinobot --help
```

The first run creates `~/.config/dinobot/dinobot.yaml` with a local setup: `api.port: 8786`, `toolMode: codemode-only`, no channels, and `plugins: {}` (web search on).

## Common recipes

- **Change the default model:** `/model provider/modelId`, or `/model` with no argument for a picker. This switches the current thread and saves the default for new conversations, without a restart. The boot fallback is `bot.model` in the manifest, which needs a restart. It only applies when no `/model` preference has been saved. Details are in models.md.
- **Turn web search off or tune it:** `plugins: { web: false }`. Tuning uses `plugins.web.engines`, `timeoutSeconds` and `endpoints`. Then restart.
- **Enable a plugin:** add `plugins.<id>: { ... }` with its config from plugins.md, provide its credentials, run `dinobot init` if it needs external programs, then restart.
- **Let the agent control a browser:** offer the opt-in `aside` plugin. Read https://docs.aside.com/help/developers for the user's OS, install and verify the Aside CLI, check `aside account status`, add `aside: {}`, then restart. The full procedure is in plugins.md.
- **Add a channel:** add `channels.<id>: { ... }` from channels.md, provide its credentials, then restart.
- **Hide slash commands:** `commands: { disabled: [login, logout] }`.
- **Load your own skills:** `plugins: { skills: { dirs: [/path/to/skills] } }`. Each skill directory contains a `SKILL.md` with `name` and `description` frontmatter, and the name must equal the directory name.
