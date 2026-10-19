# Troubleshooting and operations

Source: src/main.ts, src/tui/daemon.ts, src/tui/app.ts, src/manifest.ts, src/plugins/web/*.ts, src/update.ts.

## The daemon and the TUI

- `dinobot` / `dinobot tui` connects to the daemon at `http://127.0.0.1:<api.port>`. If no daemon answers, it starts `dinobot serve --config <manifest>` **detached in the background** and waits up to 15 s. It logs to `<dataDir>/dinobot.log`.
- **Closing the TUI does not stop the daemon.** On exit the TUI prints the pid it started (`stop it with: kill <pid>`). A daemon started by another TUI or by a service manager keeps running.
- The TUI requires an `api:` section. Without it the error is `<path> has no api section; add api: { port: 8786 } to use the TUI`.
- "disconnected from dinobot daemon; restart the TUI": the daemon died or restarted. Check `<dataDir>/dinobot.log`.
- "The running dinobot daemon is older than this TUI ...": the binary was updated but the old daemon still runs. Restart it.

## Applying configuration changes (restart)

The manifest is parsed once at process start. **Every `dinobot.yaml` change (plugins, channels, model, lsp, ...) needs a daemon restart.**

1. Let running conversations finish. A restart interrupts in-flight turns.
2. Stop the daemon. Find it with `pgrep -af 'dinobot.* serve'`, then `kill <pid>` (SIGTERM). It shuts down gracefully: channels stop, then the bot, then plugins (10 s deadline). If it runs under systemd or another supervisor, restart it through that supervisor instead.
3. Start it again: open `dinobot` (the TUI auto-starts it) or run `dinobot serve` in the foreground.
4. Confirm. The serve log prints one line: `dinobot up: model=<provider/id> toolMode=... channels=... plugins=web(1 tools),... agents=N api=...`. Use that line to check which plugins actually loaded.

Restarting only the TUI window is **not** enough.

## Manifest errors

- Validation reports every problem at once at boot (`invalid manifest:` followed by a list). Common causes:
  - Unknown channel or plugin id (the message lists the available ones).
  - Extra keys in a plugin config that sets `additionalProperties: false`, e.g. a typo under `plugins.web`.
  - `commands.disabled` contains an unknown command name.
  - An enabled bot has no channel and no `api`.
- `bot.enabled: false` makes the process print `dinobot disabled by <path>` and exit.
- Which manifest is in use? The first match of: `--config`, `$DINOBOT_CONFIG`, `./dinobot.yaml` **in the current directory**, `~/.config/dinobot/dinobot.yaml`. A stray `./dinobot.yaml` in the project directory silently takes precedence. A running daemon is bound to the manifest it was started with. Check `ps -o args= -p <pid>` for its `--config`.

## Web search

- On by default with no configuration (plugin `web`). Turn it off with `plugins: { web: false }`.
- A result that starts with `Error:` means every engine failed. HTTP 429 or a bot challenge is common on datacenter or shared IPs. Reorder `plugins.web.engines`, raise `timeoutSeconds`, or retry later.

## Models

- "No models available. Run /login to connect a provider.": no credentials are stored yet. Run `/login`.
- A model change in `dinobot.yaml` does not seem to apply: a saved `/model` preference overrides `bot.model`, and existing threads keep their model. See models.md.

## Updating

- `dinobot update` checks for and installs the latest release with the global package manager that installed it. `dinobot --version` prints the version.
- After an update, restart the daemon as described above. Otherwise the old daemon keeps serving.

## Quarantined work claims

- A claim shown as `quarantined: UNKNOWN native process provenance` is held because a bash call left a process tree the host could not prove finished (for example a background job that outlived the command, an abort, or a daemon crash). TTL expiry does not release it, and `work_release` only ends its lease. dinobot re-checks it automatically: every contending `work_claim` (every 5 s while waiting with `wait_ms`) and the holder's `work_release` run the evidence check below. The claim is released as soon as the OS proves the tree exited, with an audit entry by `dinobot:auto-reconcile`. If the holder's lease is still valid, it goes back to an ordinary claim instead.
- `GET /v1/claims/quarantine` on the daemon API lists each quarantined claim, the recorded processes, the OS evidence per process (`alive`, `quiescent`, `unknown`) and the safe next step.
- When every recorded tree is proven gone (empty POSIX process group, drained Windows job, or a Windows reboot after the recorded boot identity) and the tasks finished, `POST /v1/claims/quarantine/reconcile` with the exact `required` tokens, an `actor` and a `note` releases them and records an audit entry. Anything less is refused with 409 and the reason; there is no unconditional unlock.
- Ordinary bash calls whose whole tree exits are settled automatically on Linux, macOS and Windows; they do not need reconciliation. Settlement ends only the quarantine: the claim stays with its holder until `work_release` or TTL.
- Old Windows records missing retained Job/recorded boot identity and `external:computer_use` have no reconstructable objective proof. Do not call terminal status, PID absence, reboot without an old identity, TTL or notes proof. If a human operator separately accepts that uncertainty, `dinobot quarantine-recovery --help` describes offline, exclusive-DB, exact-token/snapshot audited **abandonment**. It never reports canonical quiescence, rejects known live tasks/processes and unsupported causes, and is not a model/channel tool. A generic request to repair is not permission to assume this risk acceptance. Back up and rehearse on a copy first; stopping/restarting production needs its own authorization.

## Where things live

- Manifest: see the lookup order above. Default: `~/.config/dinobot/dinobot.yaml`.
- State: `bot.dataDir`. It contains `dinobot.sqlite` (conversations, preferences, skills, memory), `session-index.sqlite`, `auth.json` (credentials, 0600), `dinobot.log` (TUI-started daemon), and `verification-evidence/`.
- Do not edit the SQLite files or `auth.json` by hand while the daemon runs. The daemon is their single writer.
