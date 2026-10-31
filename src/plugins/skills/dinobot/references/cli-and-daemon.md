# CLI, daemon, installation and model auth

How the `dinobot` executable is invoked, how the daemon and the TUI relate, how to install/update, and where model credentials live.

## Commands and flags

Source: `src/main.ts`, `src/cli/init.ts`, `src/cli/telegram-setup.ts`, `src/cli/telegram-run.ts`

| Command | What it does |
|---|---|
| `dinobot` (no command) | `tui` when stdin and stdout are both a TTY, otherwise `serve` |
| `dinobot tui` | Full-screen terminal chat. Connects to the daemon on `api.port`; starts `dinobot serve` in the background if nothing answers |
| `dinobot serve` | Runs the daemon in the foreground: channels, plugins and the loopback client API |
| `dinobot update [--no-restart] [--config <path>]` | Checks Cloudflare for the latest stable release, verifies the downloaded checksum, installs it with the owning global package manager, then restarts the running daemon once on the new version |
| `dinobot init [--check] [--config <path>] [<dependency>...]` | Installs pinned external programs plugins need (e.g. `cua-driver` for the `computer` plugin) and creates the default manifest if none exists |
| `dinobot telegram connect ...` | One-time Telegram owner pairing (see `channels.md`) |
| `dinobot telegram run ...` | Telegram polling sidecar that forwards to a running daemon's `http` channel (see `channels.md`) |

Global flags (for `tui`/`serve`):

| Flag | Meaning |
|---|---|
| `-c, --config <path>` | Manifest path |
| `-t, --thread <name>` | TUI: open that session (thread) instead of a new one |
| `-r, --resume` | TUI: open the shared `main` session (`--thread` wins if both are given) |
| `-h, --help` | Print usage |
| `-v, --version` | Print the version |

Exactly one positional command is accepted; anything else exits with code 2 and prints usage.

### Manifest lookup order

First match wins: `--config <path>` → `$DINOBOT_CONFIG` → `./dinobot.yaml` → `~/.config/dinobot/dinobot.yaml`. If none exists, the last one is created with defaults (`src/cli/default-manifest.ts`): `dataDir: ~/.local/share/dinobot`, model `anthropic/claude-sonnet-4-6`, `toolMode: codemode-only`, `api.port: 8786`, `channels: {}`, `plugins: {}`. It never overwrites an existing file. When `serve` creates it, it prints `created <path>; sign in to a model with /login`.

If `bot.enabled` is `false`, the process prints `dinobot disabled by <path>` and exits 0.

### `dinobot init`

Source: `src/cli/init.ts`, `openwiki/decisions/0059-dinobot-init-and-computer-use.md`

| Option | Meaning |
|---|---|
| `--check` | Report what is installed; download nothing; do not create a manifest |
| `-c, --config <path>` | Manifest to inspect (else `$DINOBOT_CONFIG`, `./dinobot.yaml`, default path) |
| `<dependency>...` | Limit to these ids; an unknown id exits 2; a platform without an artifact is then an error |

- Install root: `$DINOBOT_DEPS_DIR` (absolute), else `$XDG_DATA_HOME/dinobot/deps`, else `~/.local/share/dinobot/deps` (layout `<id>/<version>-<platform>/`). Downloads are version-pinned and SHA-256 verified; re-running keeps verified installs.
- Exit codes: 0 ok, 1 failed install or (with `--check`) missing dependency, 2 usage error. Ctrl-C aborts a download and removes staging.
- If a dependency's plugin is not enabled, init prints the `plugins:` line to add (e.g. `computer: {}`).
- After `dinobot update`, re-run `dinobot init` when a plugin's pinned driver version changed (ADR 0059).

## Daemon vs TUI lifecycle

Source: `src/tui/daemon.ts`, `src/tui/app.ts`, `src/main.ts`, `src/core/daemon-lifecycle.ts`, `openwiki/architecture/local-clients.md`

- One daemon (`dinobot serve`) owns the SQLite storage (`<dataDir>/dinobot.sqlite`), credentials, channels and plugins. The TUI is only a client over loopback HTTP + SSE on `127.0.0.1:<api.port>`.
- The TUI requires an `api:` section; without it, it fails with `... has no api section; add \`api: { port: 8786 }\` to use the TUI`.
- Auto-start: the TUI probes `GET /healthz`. If nothing answers, it spawns `dinobot serve --config <absolute manifest path>` detached, with stdout/stderr appended to `<dataDir>/dinobot.log`, and waits up to 15 s. On failure it shows the last 15 log lines.
- Quitting the TUI does **not** stop the daemon. If this TUI started it, it prints `dinobot daemon keeps running in the background (pid N); stop it with: kill N`.
- If a daemon is already listening on `api.port`, the TUI attaches to it as-is, even if it was started with an older manifest or older binary.

### Applying config changes (restart)

The daemon reads the manifest once at startup; there is no reload or SIGHUP handling. To apply manifest edits, a new `dinobot` version, or channel changes:

1. Stop the daemon: `kill <pid>` (pid printed by the TUI), Ctrl-C in a foreground `dinobot serve`, or `pkill -f 'dinobot serve'` (the hint the TUI itself prints when the daemon is older than the TUI).
2. Start it again: open `dinobot` (auto-starts) or run `dinobot serve`, or restart your service manager unit.

Restart when idle: shutdown cancels in-flight work (see below). `dinobot update` restarts the running daemon itself (below); a daemon run by systemd/launchd is left to that manager.

### SIGINT / SIGTERM

- `serve`: logs `dinobot: SIGINT, shutting down` (or `SIGTERM`) and stops resources in reverse start order — client API, channels, bot, then plugins — within one shared 10 s deadline. Exit 0 if clean, 1 if any cleanup failed or timed out. A failed startup also stops whatever had started and exits 1.
- `tui`: SIGINT/SIGTERM/SIGHUP exit the TUI (codes 130/143/129) and restore the terminal; the daemon keeps running.
- In the TUI, Ctrl+C cancels an open modal or prompt answer, then clears a non-empty input, and otherwise quits; Ctrl+D quits; Esc aborts the running answer (or a running command such as `/login`).
- A successful start logs `dinobot up: model=... toolMode=... channels=... plugins=... agents=N api=<url>`.

## TUI sessions (threads)

Source: `src/tui/app.ts`, `src/tui/slash.ts`

- Each `dinobot tui` opens a **new** thread named from a UTC timestamp plus a random suffix. `--thread <name>` opens a named one; `--resume` opens `main`. Thread keys are `tui:<name>`.
- TUI-local commands: `/new [name]`, `/thread <name>`, `/sessions` (live sessions picker), `/agents [id]`, `/dag`, `/choose`, `/quit`. Daemon commands (`/help`, `/login`, `/logout`, `/accounts`, `/model`, `/reasoning`, `/fast`, `/plugins`, `/skills`, `/search`, `/report`) come from the daemon; a TUI-local name shadows a daemon one.
- Sending while an answer runs steers the message into the running turn. Queued inputs are shown above the composer; on an empty input, ↓ edits/withdraws the last queued item and Enter sends the queue now (`openwiki/architecture/local-clients.md`).
- New threads use `bot.workspaceRoot` or the TUI's startup directory as their working directory; an existing thread keeps its directory.

## Client API (loopback, unauthenticated)

Source: `src/api/server.ts` (header comment is authoritative)

Bound to `127.0.0.1:<api.port>` only; meant for the local owner, not for channels. Main routes: `GET /healthz`; `GET /v1/threads`; `DELETE /v1/threads/:channel/:thread` (removes an idle thread and its `/new` archives from every listing and search, releasing its claims; 409 while busy or holding quarantined claims, 404 when unknown; the TUI `/sessions` picker deletes the selected session with Del pressed twice); per thread `POST .../messages` (`text`, optional `whenBusy: "steer"`, images), `GET .../events` (SSE), `POST .../abort`, `POST .../queue/send`, `POST .../queue/:id/withdraw`, `GET .../model`, `POST .../workspace`, `POST .../commands` (SSE of command events); `GET /v1/commands`, `GET /v1/commands/:name/arguments`, `POST /v1/command-runs/:runId/prompts/:promptId`; `GET /v1/conversations/:id/events`; `GET /v1/search`; `GET /v1/sessions`, `GET /v1/sessions/events`; `GET|POST|DELETE /v1/claims`; `GET /v1/claims/quarantine` (why each quarantined claim is held and the safe next action), `POST /v1/claims/quarantine/reconcile` (`tokens`, `actor`, `note`; releases only an exact token closure whose recorded process trees the OS proves exited, otherwise 409). Thread paths are `/v1/threads/:channel/:thread/...`.

## Installation and update

Source: `src/update.ts`, `README.md`, `openwiki/runbooks/install-local.md`, `openwiki/decisions/0051-npm-package-without-sources.md`, `0053-npm-release-automation.md`

| Method | Command |
|---|---|
| Official package (Bun 1.4+) | `bun add -g dinobot@https://releases.dinobot.workers.dev/core/dinobot.tgz` |
| From a checkout (single binary to `~/.local/bin`) | `bun install && bun run install:local` |
| From a checkout, no install | `bun start` (TUI/daemon), `bun start serve` |

The package is a minified bundle without sources or source maps. Releases use GitHub tags and Cloudflare R2, not npm publication. Older npm builds need the URL install once to change update channels. External dependencies still download from npm.

`dinobot update`:

- Always queries `https://releases.dinobot.workers.dev/core/latest.json` (5 s metadata timeout); installs only a newer **stable** version; never downgrades.
- Updates only a verified global Bun or npm install: downloads the fixed-origin versioned tarball, verifies SHA-512, installs the verified local archive with the owning manager, then checks the installed version. Source checkouts, local builds, `bunx`/`npx`, compiled binaries, ambiguous ownership, or a bunfig with `install.globalDir`/`dryRun` are refused with manual instructions. No sudo is attempted.
- Afterwards: reopen the TUI. The running daemon of the manifest (`--config`, `$DINOBOT_CONFIG`, `./dinobot.yaml`, `~/.config/dinobot/dinobot.yaml`; found through `api.port`) is restarted once on the new version, interrupting running work (ADR 0099). The daemon starts its successor with the same argv, cwd and environment and stops only when the successor is ready, so if the new version cannot start the old daemon keeps running. Daemons under systemd/launchd/container init get the manager command instead. `--no-restart` skips it. If the daemon is older than the version that added this, restart it by hand once.
- When already current, a daemon still running an older version is restarted too (verified global installs only).
- Exit 0 on success or already current (also when no daemon runs or a service manager owns it), 1 on failure, including a restart that failed or did not come back on the new version.

Passive check: the TUI checks once in the background and shows a notice with `dinobot update` when a newer version exists. Cache: `$XDG_CACHE_HOME/dinobot/update.json` (else `~/.cache/dinobot/update.json`), 24 h. Disable with `DINOBOT_NO_UPDATE_CHECK=1` (explicit `update` still works).

## Model providers and auth

Source: `src/auth/index.ts`, `src/auth/store.ts`, `src/auth/pool.ts`, `src/auth/rotation.ts`, `src/auth/types.ts`, `src/commands/builtin.ts`, `openwiki/architecture/slash-commands.md`, `openwiki/decisions/0045-multi-account-credential-rotation.md`

- The default model is `bot.model` (`provider`, `modelId`) in the manifest. `/model provider/modelId` changes the current thread and saves it as the default for new conversations (it persists across restarts and takes precedence over the manifest).
- Model transports are pi-ai (`@earendil-works/pi-ai`) builtin providers. Login flows come from `@oh-my-pi/pi-ai` (pinned). `/login` with no argument lists providers in two groups: "Chat providers" and "Login only (no chat transport yet)" (logged in but unusable for chat: "no model transport in this build").
- Some login ids map to a differently named model provider: `kimi-code`→`kimi-coding`, `moonshot`→`moonshotai`, `xai-oauth`→`xai`, `opencode-zen`→`opencode`, `zhipu-coding-plan`→`zai-coding-cn`, `minimax-code`→`minimax`, `minimax-code-cn`→`minimax-cn`, `alibaba-token-plan` (shown as "Alibaba Token Plan")→`qwen-token-plan`.
- For the exact provider list of an installed build, run `/login` (no argument) or `/model` in the TUI.

### Commands (TUI only for credentials)

| Command | Surface | Effect |
|---|---|---|
| `/login [provider]` | tui | Run OAuth / device-code / paste-key flow; stores the credential. Logging in to a provider again with another account **adds** it to that provider's pool |
| `/logout [provider] [account]` | tui | Remove one account or all accounts of a provider |
| `/accounts [use <provider> <account>]` | tui | List pooled accounts (active `*`, block reason/time) or switch the active one (by pool id, email or label) |
| `/model [provider/modelId]` | tui, channel | Show or switch the thread's model |

Login card: the auth URL opens in the browser automatically unless `DINOBOT_NO_BROWSER=1`; links/codes can be copied (OSC 52). Logins needing a browser session launch a local Chrome/Chromium; set `DINOBOT_CHROME` to its path if not found. `commands.disabled: [login, logout]` in the manifest hides those commands everywhere.

### Where credentials live

- `<dataDir>/auth.json`, mode 0600, written atomically by the daemon (single owner). With the default manifest: `~/.local/share/dinobot/auth.json`.
- A provider with one healthy account is stored as a plain credential; several (or a blocked) account(s) as `{ "type": "pool", "active", "lastId", "accounts": [...] }`.

### Environment-variable API keys

pi-ai's API-key providers resolve a **stored credential first**, then their environment variable (e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `XAI_API_KEY`, `DEEPSEEK_API_KEY`, `GROQ_API_KEY`, `MISTRAL_API_KEY`). The variable must be in the **daemon's** environment; a daemon auto-started by the TUI inherits the TUI's environment. `.env.example` lists `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`. Exact names per provider: see pi-ai's provider definitions (`envApiKeyAuth` in `@earendil-works/pi-ai`).

### Multi-account rotation (ADR 0045)

- Sticky failover, not round-robin: all threads share the provider's active account until it fails before producing output.
- Rotating failures and default blocks: rate limit/429 → 1 min; usage limit/quota → 1 h; 401/auth/refresh failure → 30 min. A reset hint in the error (e.g. `try again in ~N min`) is used instead, capped at 8 days.
- Not rotated: overload/5xx, context overflow, 403 policy, aborts, failures after output started, single-account providers.
- The request is retried immediately on the next unblocked account (up to 8 attempts). The daemon logs `dinobot: <provider> account #1 (...) hit quota; switched to #2 (...)`. If all are blocked, the error surfaces once.
- `/accounts use` makes an account active and clears its block.

## Other environment variables

| Variable | Effect | Source |
|---|---|---|
| `DINOBOT_CONFIG` | Manifest path | `src/main.ts` |
| `DINOBOT_DEPS_DIR` | `dinobot init` install root | `src/cli/init.ts` |
| `DINOBOT_NO_UPDATE_CHECK=1` | Disable the TUI's passive update check | `src/update.ts` |
| `XDG_CACHE_HOME` | Update-check cache location | `src/update.ts` |
| `DINOBOT_NO_BROWSER=1` | Do not auto-open login URLs | `src/tui/login-card.ts` |
| `DINOBOT_CHROME` | Chrome/Chromium for browser-session logins | `src/auth/browser-session.ts` |
| `DINOBOT_ICONS=unicode` | TUI icon set override for one run | `src/tui/preferences.ts`, `README.md` |
